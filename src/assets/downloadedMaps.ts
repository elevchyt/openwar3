// Maps a LAN game handed us (ui/mapDownload.ts, net/mapTransfer.ts) — where they are kept, and
// how a room's map is found among them.
//
// Warcraft III kept every map another player sent it in `Maps\Download\` under the install, and so
// do we: the folder is made the first time something lands in it, the file keeps the name it had
// on the host's machine, and from then on it is an ordinary map of the install — listed on the
// Custom Game screen, and found again the next time a game on it is joined, without a second
// download.
//
// How it is WRITTEN depends on the door the install came through (assets/opfs.ts `PickedInstall`):
// the browser's picked folder asks the File System Access API, the desktop app asks its shell, the
// `?dev` boot asks the dev server, and a folder read through `<input webkitdirectory>` cannot be
// written at all. That last one still plays the map — it is kept in memory for the session — and
// only the keeping is lost.

/** The folder under `Maps\`, as Warcraft III spelled it. */
export const DOWNLOAD_FOLDER = "Download";

/** `MAPS_PREFIX` of assets/opfs.ts, restated rather than imported: opfs.ts imports this module
 *  for its writer, and the build refuses a cycle. */
const MAPS_PREFIX = "Maps\\";

/** Write one downloaded map into the install's `Maps\Download\`, under `name` (a bare file name,
 *  already made safe by `safeMapName`). Absent where the install door cannot write. */
export type MapWriter = (name: string, bytes: Uint8Array) => Promise<void>;

let writer: MapWriter | null = null;
/** Asks for write access while a CLICK is still in hand (`requestMapWriteAccess`). */
let permission: (() => Promise<boolean>) | null = null;

/** The install door's writer, set once at mount (vfs/loader.ts `loadProfile`). */
export function setMapWriter(w: MapWriter | null, ask: (() => Promise<boolean>) | null = null): void {
  writer = w;
  permission = ask;
}

/**
 * Ask for the right to write into the install NOW, from inside the click that will need it.
 *
 * A browser grants the File System Access API's `readwrite` only out of a user gesture, and a map
 * download ends seconds after the Join click that started it — long after the gesture is spent.
 * So Join asks up front (a prompt the player answers once per session), and the save at the end
 * finds the permission already granted. Elsewhere it resolves true at once.
 */
export function requestMapWriteAccess(): Promise<boolean> {
  return permission ? permission().catch(() => false) : Promise.resolve(true);
}

/** The key a downloaded map is known by in the install's map list: `Maps\Download\<name>`. */
export function downloadedMapKey(name: string): string {
  return `${MAPS_PREFIX}${DOWNLOAD_FOLDER}\\${name}`;
}

/**
 * The file name to keep a host's map under: the last segment of its path, with anything a file
 * system would refuse — or read as a folder — taken out. The path is the HOST's to state and it
 * arrives off the wire, so it is never joined onto ours as it stands.
 */
export function safeMapName(remotePath: string): string | null {
  const last = remotePath.split(/[\\/]/).pop() ?? "";
  const name = last.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  return /\.(w3m|w3x)$/i.test(name) && name.length <= 200 ? name : null;
}

/**
 * Where a room's map is in THIS install, or null.
 *
 * The host's own path first — a stock map, or a custom one both players keep in the same place —
 * and then the copy a previous download left in `Maps\Download\` under the same file name.
 * Case-insensitive on the folder, because the install's own `Maps\` may be spelled `maps\` on a
 * case-sensitive disk and the key keeps whatever the folder is called.
 */
export function localMapPath(maps: ReadonlyMap<string, File>, remotePath: string): string | null {
  if (maps.has(remotePath)) return remotePath;
  const name = safeMapName(remotePath)?.toLowerCase();
  if (!name) return null;
  const want = `${MAPS_PREFIX}${DOWNLOAD_FOLDER}\\${name}`.toLowerCase();
  for (const key of maps.keys()) if (key.toLowerCase() === want) return key;
  return null;
}

/**
 * Keep a map that has finished downloading: write it into the install, and hand back the key and
 * the `File` the map list should hold for it. A write that fails (permission refused, a read-only
 * disk) still hands the map back — the game in front of the player is played either way — with
 * the reason, so the dialog can say the map was not kept.
 */
export async function keepDownloadedMap(
  remotePath: string,
  bytes: Uint8Array,
): Promise<{ key: string; file: File; saveError: string | null }> {
  const name = safeMapName(remotePath);
  if (!name) throw new Error("The host's map has no usable file name.");
  let saveError: string | null = null;
  if (writer) {
    try {
      await writer(name, bytes);
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    }
  } else {
    saveError = "This copy of the game cannot write to the Warcraft III folder.";
  }
  return { key: downloadedMapKey(name), file: new File([bytes.slice()], name), saveError };
}
