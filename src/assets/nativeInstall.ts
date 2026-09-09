import type { PickedInstall, InstallFiles } from "./opfs";
import {
  fetchCasc, fetchInstallFile, lazyMapFile,
  type FileUrl, type InstallManifest,
} from "./remoteInstall";

// The player's install as the DESKTOP app reads it (docs/multiplayer.md, step 2 of the export).
//
// On the web the folder is picked every session and lives behind the File System Access API,
// with OPFS quota and a permission dance around it. The desktop app has none of that: it asks
// the operating system once, remembers the answer, and reads the folder straight off disk —
// which is most of the reason the export is Electron at all (OpenWar3_PLAN.md §8).
//
// The bytes arrive over `ow3-install://`, this app's own scheme, which is not a server: it
// exists inside the app's session only, so nothing outside the process can address it. That
// matters here specifically, because the same app serves its PAGE on a LAN-facing port —
// see electron/install.mjs.
//
// Only two things come over the preload bridge, and neither is a byte: where the folder is, and
// a request to ask the player for a new one.

/** What `electron/preload.cjs` exposes. Absent in a browser, which is how the gate tells the
 *  two boots apart. */
interface NativeBridge {
  installPath(): Promise<InstalledFolder>;
  pickInstall(): Promise<string | null>;
  forgetInstall(): Promise<void>;
  servers(): Promise<Array<{ id: string; url: string }>>;
  onServers(fn: (peers: Array<{ id: string; url: string }>) => void): () => void;
  update: {
    state(): Promise<UpdateState>;
    download(): Promise<void>;
    install(): Promise<void>;
    onChange(fn: (state: UpdateState) => void): () => void;
  };
}

/** Where an update has got to (electron/updates.mjs). `idle`/`checking`/`none` need no words;
 *  `available` and `ready` are the two the player is asked about. */
export interface UpdateState {
  phase: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error";
  version: string | null;
  percent: number;
  error: string | null;
}

const bridge = (): NativeBridge | null =>
  (window as unknown as { ow3native?: NativeBridge }).ow3native ?? null;

/** Watch the updater. A no-op in a browser, which updates by being reloaded. Like the beacon's,
 *  this ASKS as well as subscribing: the check finishes seconds after launch and this is called
 *  when the menu appears, which is a minute later. */
export function onUpdateState(fn: (state: UpdateState) => void): () => void {
  const native = bridge();
  if (!native?.update) return () => {};
  let live = true;
  const stop = native.update.onChange((state) => { if (live) fn(state); });
  void native.update.state().then((state) => { if (live && state) fn(state); });
  return () => { live = false; stop(); };
}

export const downloadUpdate = (): void => void bridge()?.update?.download();
export const installUpdate = (): void => void bridge()?.update?.install();

/**
 * Subscribe to the OpenWar3s this machine can hear on the network (electron/beacon.mjs). A no-op
 * returning a no-op in a browser, which has no way to hear anything.
 *
 * It ASKS as well as subscribing. The push only fires when the set changes, and this is called
 * when the LAN screen opens — long after the beacon found whoever was already running — so a
 * subscription on its own would leave a machine that had been there the whole time unmentioned
 * until it quit and came back. Cost a two-app run to find.
 */
export function onServersFound(fn: (urls: string[]) => void): () => void {
  const native = bridge();
  if (!native) return () => {};
  let live = true;
  const stop = native.onServers((peers) => { if (live) fn(peers.map((p) => p.url)); });
  void native.servers().then((peers) => { if (live) fn(peers.map((p) => p.url)); });
  return () => { live = false; stop(); };
}

/** Running inside the desktop app. */
export const isDesktopApp = (): boolean => bridge() !== null;

/** The remembered folder, and why it is not usable when it is not. A folder that has been MOVED
 *  and one that has been PATCHED to another Warcraft III are both `valid: false` and are not the
 *  same news to the player. */
export interface InstalledFolder {
  path: string | null;
  valid: boolean;
  /** The folder is still on disk. False means it moved or went away. */
  present: boolean;
  /** What it says it is, when it is there and says anything. */
  version: string | null;
}

export async function rememberedInstall(): Promise<InstalledFolder> {
  return (await bridge()?.installPath()) ?? { path: null, valid: false, present: false, version: null };
}

/** Open the OS folder picker. Null if the player cancelled, or picked something that is not a
 *  Warcraft III folder — the shell checks that where the disk is, rather than letting a mount
 *  fail three steps later. */
export async function pickNativeInstall(): Promise<string | null> {
  return (await bridge()?.pickInstall()) ?? null;
}

export async function forgetNativeInstall(): Promise<void> {
  await bridge()?.forgetInstall();
}

/** `local` is the scheme's host and means nothing: a `standard` scheme needs an origin, and
 *  there is only ever one install. */
const fileUrl: FileUrl = (path) => `ow3-install://local/file?path=${encodeURIComponent(path)}`;

/**
 * Read the remembered folder into the same `PickedInstall` the browser's picker produces, so
 * everything downstream — `loadProfile`, the map list, the whole engine — cannot tell which door
 * it came through.
 *
 * The maps are LAZY (`lazyMapFile`). An install's `Maps\` folder is hundreds of files, and
 * reading them all so the Custom Game screen can print their names would spend a few hundred
 * megabytes on a list — where the browser's picker, whose `File`s are handles, spends none.
 */
export async function loadNativeInstall(): Promise<PickedInstall> {
  const res = await fetch("ow3-install://local/manifest.json");
  if (!res.ok) throw new Error(`The install could not be read (${res.status}).`);
  const manifest = (await res.json()) as InstallManifest;

  const files: InstallFiles = new Map();
  for (const path of manifest.maps) files.set(path, lazyMapFile(fileUrl, path));

  // Only an MPQ-era folder needs its archives: a CASC mount reads the content store instead,
  // and `loadProfile` never asks `files` for one (src/vfs/loader.ts).
  if (!manifest.casc) {
    for (const name of manifest.archives) {
      files.set(name.toLowerCase(), await fetchInstallFile(fileUrl, name));
    }
  }

  return { files, casc: manifest.casc ? await fetchCasc(fileUrl, manifest.casc) : null };
}
