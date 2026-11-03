import { installEntries, readZipIndex, ZipCursor, type InstallEntry } from "../../electron/zip.mjs";
import { readInstallDir, type DirHandle, type PickedInstall } from "./opfs";

// "Download game files" (src/ui/gate.ts): a Warcraft III install, fetched from somewhere public
// and unpacked where the game can read it.
//
// Two SOURCES ship with the game, tried in order (`gameFilesSources()`), so the button keeps
// working the day one of them goes away:
//
//   1. **The developer's own zipped 1.30.4 install on Google Drive** (GAME_FILES_LINK) — the
//      primary, because it is the fast one. Streamed with ranged reads through electron/zip.mjs.
//   2. **The Internet Archive's Warcraft III 1.31** (ARCHIVE_ORG below) — the mirror: slow
//      (about 1 MB/s, so half an hour), but it outlives anybody's Drive. It is a RAR, which
//      neither half can read, but archive.org opens a RAR ITSELF and hands out any one file
//      inside it by URL (`<item>/<file>.rar/<member>`), with `Access-Control-Allow-Origin: *` —
//      so a HOSTED page can fetch it, which a Drive file never could (`pageUrl`): there it is
//      the only source that works. We take only the CASC store out of it: `.build.info`, the
//      two configs, the LIVE `.idx` of each of the sixteen buckets and the two `data.NNN`. The
//      build is **1.31.1**, not the 1.30.4 we play; the mount turns it back into 1.30.4
//      (src/vfs/downgrade.ts, docs/casc.md).
//
// A source that fails for any reason but Cancel hands over to the next one; the player sees
// one bar and, at worst, a line saying the mirror was used.
//
// Two homes for the result. The DESKTOP app unpacks into a real folder the shell then remembers
// (electron/download.mjs) — a downloaded install is an install. A BROWSER has no folder to write
// to, so it unpacks into OPFS, the origin's private disk, and boots from there on every visit
// after; that is this file.

/** The primary: the developer's zipped 1.30.4 install. A developer's `.env.local` used to be
 *  the only home for it (`VITE_GAME_FILES_URL`, read behind `import.meta.env.DEV`); it is the
 *  player's door now, so it ships. */
const GAME_FILES_LINK =
  "https://drive.google.com/file/d/1hcH5hqQInvvqcGKxe9lj9N9qzCz2EekG/view?usp=sharing";
const LINK_KEY = "ow3.gameFilesLink";

/** What the Drive link is: the last one this player used, else the shipped one. */
export function rememberedLink(): string {
  try {
    return localStorage.getItem(LINK_KEY) ?? GAME_FILES_LINK;
  } catch {
    return GAME_FILES_LINK;
  }
}

/** One file of a `files` source, at its path in the install folder (`/`-separated). */
export interface SourceFile {
  path: string;
  size: number;
}

/**
 * Where "Download game files" gets an install from. Plain data, because the desktop half is
 * handed the same list over IPC (electron/download.mjs) and tries it the same way.
 *
 *   `files` — every file fetched whole from `base + encodeURIComponent(path)`;
 *   `zip`   — one archive at `url` (already the bytes, see `downloadUrl`), read with ranges.
 */
export type GameFilesSource =
  | { kind: "files"; name: string; base: string; files: SourceFile[] }
  | { kind: "zip"; name: string; url: string };

/** The sixteen live `.idx` buckets of the 1.31.1 store. Each bucket ships twice (`…02.idx` and
 *  `…03.idx`) and only the higher version is read (parseIndex in vfs/casc.ts), so the stale
 *  half is not fetched — every archive.org request costs it a pass over the RAR. */
const IDX_31 = Array.from({ length: 16 }, (_, b) => ({
  path: `Data/data/${b.toString(16).padStart(2, "0")}00000003.idx`,
  size: 65536,
}));

/** archive.org item `warcraft-iii-v-1.31` ("Warcraft III Reign of Chaos & The Frozen Throne
 *  v1.31 [PC]"), file `Warcraft III v1.31.rar`; the sizes are the item's own listing. */
const ARCHIVE_ORG: GameFilesSource = {
  kind: "files",
  name: "the Internet Archive",
  base: "https://archive.org/download/warcraft-iii-v-1.31/Warcraft%20III%20v1.31.rar/Warcraft%20III%2F",
  files: [
    { path: ".build.info", size: 683 },
    { path: "Data/config/2e/04/2e049b3d87b9b73eb2e2fb1638eb0e64", size: 8985 },
    { path: "Data/config/9d/23/9d237ac1c45b0d44bd40e8b09781235d", size: 7435 },
    ...IDX_31,
    { path: "Data/data/data.000", size: 1073741822 },
    { path: "Data/data/data.001", size: 733908764 },
  ],
};

/** The sources, in the order they are tried: the Drive install, then the Internet Archive. */
export function gameFilesSources(): GameFilesSource[] {
  const out: GameFilesSource[] = [];
  const url = downloadUrl(rememberedLink());
  if (url) out.push({ kind: "zip", name: "Google Drive", url });
  out.push(ARCHIVE_ORG);
  return out;
}

/**
 * The URL that hands over the BYTES behind what the player pasted.
 *
 * A Drive share link (`drive.google.com/file/d/<id>/view`) is a web page about the file, not the
 * file. `drive.usercontent.google.com/download?…&confirm=t` is the file itself: `confirm=t`
 * steps past the "too large to scan for viruses" page Drive puts in front of anything over
 * ~100 MB, and that host answers cross-origin (`Access-Control-Allow-Origin: *`) and honours
 * `Range` — the two things the browser half needs. Any other http(s) link is taken as already
 * pointing at a .zip.
 */
export function downloadUrl(link: string): string | null {
  const s = link.trim();
  const drive =
    /drive\.google\.com\/file\/d\/([\w-]{10,})/.exec(s) ??
    /drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]{10,})/.exec(s) ??
    /drive\.usercontent\.google\.com\/(?:download|uc)\?(?:.*&)?id=([\w-]{10,})/.exec(s);
  if (drive) return `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download&confirm=t`;
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

/**
 * Whether this page is served by a host that has the Drive relay (tools/vite-plugin-drive-proxy.ts
 * — the dev server and `vite preview`). Asked once: the route answers 400 to a malformed id
 * WITHOUT touching Drive, so a probe costs no upstream request, and a static host answers 404
 * (or its SPA fallback's 200).
 */
let relay: boolean | null = null;
async function driveRelay(): Promise<boolean> {
  if (relay === null) {
    try {
      relay = (await fetch("/dev-drive?id=x", { method: "HEAD" })).status === 400;
    } catch {
      relay = false;
    }
  }
  return relay;
}

/**
 * Where the PAGE fetches `url` from. Drive answers a page's own request 403 whatever its CORS
 * headers say (it refuses `Sec-Fetch-Site: cross-site`, which no script can remove), so a Drive
 * file has to go through the relay above and is out of reach of a hosted build altogether —
 * where the desktop app, whose shell fetches it, is the answer. Any other host is fetched
 * directly and has to allow it.
 */
async function pageUrl(url: string): Promise<string> {
  const id = /^https:\/\/drive\.usercontent\.google\.com\/download\?id=([\w-]+)/.exec(url)?.[1];
  if (!id) return url;
  if (await driveRelay()) return `/dev-drive?id=${id}`;
  throw new Error("Google Drive does not let a web page download its files. Use the desktop app, or a direct link to the .zip.");
}

export interface DownloadProgress {
  /** 0..1 of the archive's bytes, or null before its size is known. */
  fraction: number | null;
  received: number;
  total: number;
  /** Desktop only: the index into the sources of the one these bytes come from. */
  source?: number;
}

/** The OPFS folder the install is unpacked into, and the file written LAST that says it is whole.
 *  A download that died halfway leaves no marker and is wiped by the next attempt. */
const STORE_DIR = "Warcraft III";
const COMPLETE = ".ow3-download.json";

/** Which entries the browser keeps. It never runs the game's executables, so of the archive's
 *  ~470 entries it wants the content store, the maps, the version file and the player's hotkeys
 *  — what `readInstallDir` reads, and nothing it would only have to skip. */
const wanted = (path: string): boolean => {
  const p = path.toLowerCase();
  return p === ".build.info" || p === "customkeys.txt" || p === "customkeybindings/customkeys.txt" ||
    p.startsWith("data/") || /^[^/]+\.mpq$/.test(p) || (p.startsWith("maps/") && /\.(w3m|w3x)$/.test(p));
};

async function rangeReader(url: string, signal?: AbortSignal): Promise<{ size: number; read: (a: number, b: number) => Promise<Uint8Array> }> {
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    if (res.status !== 206) throw new Error(notAZip(res));
    return new Uint8Array(await res.arrayBuffer());
  };
  const probe = await fetch(url, { headers: { Range: "bytes=0-0" }, signal });
  const size = Number(/\/(\d+)$/.exec(probe.headers.get("content-range") ?? "")?.[1]);
  await probe.body?.cancel();
  if (probe.status !== 206 || !size) throw new Error(notAZip(probe));
  return { size, read };
}

/** Why a link did not hand over an archive, in the terms the player can act on. Drive answers a
 *  file that is not shared publicly with its sign-in PAGE, which is the usual case. */
function notAZip(res: Response): string {
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    return "That link opened a web page instead of the file. Make sure it is shared with \"Anyone with the link\".";
  }
  if (!res.ok) return `The download failed (${res.status}).`;
  return "That server does not allow resumable downloads, which this needs.";
}

/** A ReadableStream as the async iterable ZipCursor walks — written out, since a stream's own
 *  `Symbol.asyncIterator` is newer than some of the Chromiums this runs in. */
async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function fileAt(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  const parts = path.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir.getFileHandle(parts[parts.length - 1], { create: true });
}

/** One entry's bytes, from the cursor into OPFS. Deflate is the browser's own
 *  (`DecompressionStream("deflate-raw")`), so no zip library ships for a button most players
 *  never press. */
async function unpack(cursor: ZipCursor, entry: InstallEntry, file: FileSystemFileHandle): Promise<void> {
  const out = await file.createWritable();
  if (entry.method === 0) {
    for await (const piece of cursor.take(entry.compressedSize)) await out.write(piece as Uint8Array<ArrayBuffer>);
    await out.close();
  } else if (entry.method === 8) {
    const inflate = new DecompressionStream("deflate-raw");
    const piped = inflate.readable.pipeTo(out);
    const w = inflate.writable.getWriter();
    for await (const piece of cursor.take(entry.compressedSize)) await w.write(piece as Uint8Array<ArrayBuffer>);
    await w.close();
    await piped;
  } else {
    await out.abort();
    throw new Error(`${entry.path} is packed with a method this cannot unpack (${entry.method}).`);
  }
  if ((await file.getFile()).size !== entry.uncompressedSize) throw new Error(`${entry.path} did not unpack whole.`);
}

/**
 * Download an install from the first of `sources` that works and unpack it into OPFS. Replaces
 * any earlier copy, whole or partial. Resolves once the copy is whole; `storedInstall()` then
 * reads it. `onSource` is told each source as it is started, so the bar can say a mirror is in
 * use. `signal` is the load gate's Cancel (src/ui/gate.ts): an abort stops the stream and wipes
 * what has been unpacked so far — a cancelled download leaves nothing behind, and is never
 * handed on to the next source.
 */
export async function downloadInstall(
  sources: GameFilesSource[],
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  onSource?: (source: GameFilesSource, index: number) => void,
): Promise<void> {
  if (!navigator.storage?.getDirectory) throw new Error("This browser cannot store the game files. Try Chrome or Edge.");
  if (!sources.length) throw new Error("There is nowhere to download the game files from.");
  let last: unknown = null;
  for (const [i, source] of sources.entries()) {
    onSource?.(source, i);
    try {
      return await (source.kind === "zip" ? downloadZip(source.url, onProgress, signal) : downloadFiles(source, onProgress, signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[download] ${source.name} failed:`, err);
      last = err;
    }
  }
  throw last;
}

/** A fresh, empty install folder in OPFS. */
async function freshStore(): Promise<{ opfs: FileSystemDirectoryHandle; root: FileSystemDirectoryHandle }> {
  const opfs = await navigator.storage.getDirectory();
  await opfs.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
  return { opfs, root: await opfs.getDirectoryHandle(STORE_DIR, { create: true }) };
}

async function checkQuota(need: number): Promise<void> {
  const { usage, quota } = (await navigator.storage.estimate?.()) ?? {};
  if (quota && need > quota - (usage ?? 0)) {
    throw new Error(`Not enough browser storage: the game files need ${gb(need)} and ${gb(quota - (usage ?? 0))} is free.`);
  }
}

async function markComplete(root: FileSystemDirectoryHandle, from: string, files: number): Promise<void> {
  const marker = await (await root.getFileHandle(COMPLETE, { create: true })).createWritable();
  await marker.write(JSON.stringify({ from, at: new Date().toISOString(), files }));
  await marker.close();
}

/** A `files` source: each file fetched whole, one after another, straight into OPFS. Its sizes
 *  are known up front, so the bar is one fraction over all of them and a file that arrives
 *  short is caught before the next one starts. */
async function downloadFiles(source: Extract<GameFilesSource, { kind: "files" }>, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  const total = source.files.reduce((sum, f) => sum + f.size, 0);
  await checkQuota(total);
  const { opfs, root } = await freshStore();
  let received = 0;
  onProgress({ fraction: 0, received: 0, total });
  const timer = setInterval(() => onProgress({ fraction: received / total, received, total }), 250);
  try {
    for (const file of source.files) {
      const res = await fetch(source.base + encodeURIComponent(file.path), { signal });
      if (!res.ok || !res.body) throw new Error(`${source.name} answered ${res.status} for ${file.path}.`);
      const out = await (await fileAt(root, file.path)).createWritable();
      let got = 0;
      try {
        for await (const piece of chunksOf(res.body)) {
          await out.write(piece as Uint8Array<ArrayBuffer>);
          got += piece.length;
          received += piece.length;
        }
      } finally {
        await out.close();
      }
      if (got !== file.size) throw new Error(`${file.path} arrived ${got} bytes long, not ${file.size}.`);
    }
    await markComplete(root, source.base, source.files.length);
    onProgress({ fraction: 1, received: total, total });
  } catch (err) {
    // Unlike the zip, a partial here is never worth keeping: the next source starts over.
    await opfs.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
    throw err;
  } finally {
    clearInterval(timer);
  }
}

/** A `zip` source: the archive behind `direct`, its install unpacked out of it. */
async function downloadZip(direct: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  const url = await pageUrl(direct);
  const { size, read } = await rangeReader(url, signal);
  const entries = installEntries(await readZipIndex(read, size)).filter((e) => wanted(e.path));
  await checkQuota(entries.reduce((sum, e) => sum + e.uncompressedSize, 0));
  const { opfs, root } = await freshStore();

  try {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(notAZip(res));
    const cursor = new ZipCursor(chunksOf(res.body));
    onProgress({ fraction: 0, received: 0, total: size });
    // On a clock rather than per network chunk, which arrive by the thousand.
    const timer = setInterval(() => onProgress({ fraction: cursor.pos / size, received: cursor.pos, total: size }), 250);
    try {
      for (const entry of entries) {
        await cursor.enter(entry);
        await unpack(cursor, entry, await fileAt(root, entry.path));
      }
    } finally {
      clearInterval(timer);
      await cursor.close().catch(() => {});
      await res.body.cancel().catch(() => {});
    }
    await markComplete(root, direct, entries.length);
    onProgress({ fraction: 1, received: size, total: size });
  } catch (err) {
    // Cancelled: take the half-unpacked copy with you. A download that died any other way keeps
    // its partial for the next attempt to wipe (which `freshStore` does).
    if (signal?.aborted) await opfs.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
    throw err;
  }
}

/** The install a previous "Download game files" left in OPFS, or null if there is none (or only
 *  a partial one). */
export async function storedInstall(): Promise<PickedInstall | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(STORE_DIR);
    await root.getFileHandle(COMPLETE);
    return readInstallDir(root as unknown as DirHandle);
  } catch {
    return null;
  }
}

/** Throw away the stored copy — a downloaded install the game then refuses (the wrong build)
 *  would otherwise be mounted again at every visit. */
export async function forgetStoredInstall(): Promise<void> {
  await (await navigator.storage?.getDirectory?.())?.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
}

export const gb = (bytes: number): string =>
  bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} GB` : `${Math.round(bytes / (1 << 20))} MB`;
