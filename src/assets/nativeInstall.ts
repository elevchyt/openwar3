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
  installPath(): Promise<{ path: string | null; valid: boolean }>;
  pickInstall(): Promise<string | null>;
  forgetInstall(): Promise<void>;
}

const bridge = (): NativeBridge | null =>
  (window as unknown as { ow3native?: NativeBridge }).ow3native ?? null;

/** Running inside the desktop app. */
export const isDesktopApp = (): boolean => bridge() !== null;

/** The remembered folder and whether it is still an install — `valid: false` with a path is a
 *  folder that has been moved or deleted, which is worth saying rather than silently re-asking. */
export async function rememberedInstall(): Promise<{ path: string | null; valid: boolean }> {
  return (await bridge()?.installPath()) ?? { path: null, valid: false };
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
