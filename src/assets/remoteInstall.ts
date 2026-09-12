import type { ByteReader, CascFiles } from "../vfs/casc";

// An install read over URLs rather than off a picked folder.
//
// Two callers want exactly this and must not answer it differently: the `?dev` boot, which
// fetches the developer's install from the dev server (src/dev/devBoot.ts), and the DESKTOP app,
// which fetches the player's own through its `ow3-install://` scheme (src/assets/nativeInstall.ts).
// Same manifest, same two routes, same ranged reads — so the fetching lives here once and each
// caller brings only its own URL shape.
//
// The one thing that is NOT here is which files to fetch: the dev boot wants a named map or
// twenty of them, and the desktop app wants the player's whole folder. That is the caller's.

/** What a served install says it holds. Built by `enumerateInstall` (electron/install.mjs);
 *  paths speak WC3's `\` separator so they can key `InstallFiles` verbatim. */
export interface InstallManifest {
  archives: string[];
  maps: string[];
  /** Present when the install is 1.30+ (issue #102); null for an MPQ-era one. */
  casc: CascManifest | null;
  /** The folder's own `CustomKeys.txt`, as an install-relative path — or null when it has
   *  none (issue #142). A loose file the PLAYER writes, so it is named rather than assumed:
   *  a folder with no such file is the normal case. */
  customKeys: string | null;
}

export interface CascManifest {
  buildInfo: string;
  config: string[];
  idx: string[];
  /** `data.NNN` → its path, so the browser can range-read it. */
  data: Record<number, string>;
}

/** Builds the URL that serves one install-relative path. */
export type FileUrl = (path: string) => string;

const baseName = (path: string): string => path.split("\\").pop() ?? path;

export async function fetchInstallFile(url: FileUrl, path: string): Promise<File> {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return new File([await res.blob()], baseName(path));
}

export const fetchInstallBytes = async (url: FileUrl, path: string): Promise<Uint8Array> =>
  new Uint8Array(await (await fetchInstallFile(url, path)).arrayBuffer());

export const fetchInstallText = async (url: FileUrl, path: string): Promise<string> =>
  (await fetchInstallFile(url, path)).text();

/** …and one read as a Warcraft III DATA file: **windows-1252**, the encoding every `*Strings.txt`
 *  in the game is written in. `fetchInstallText` decodes UTF-8, which is right for `.build.info`
 *  and wrong for anything carrying a localized tooltip (assets/opfs.ts `readAnsi` is the picker's
 *  half of the same rule). */
export const fetchInstallAnsi = async (url: FileUrl, path: string): Promise<string> =>
  new TextDecoder("windows-1252").decode(await fetchInstallBytes(url, path));

/**
 * A `data.NNN` read in ranges instead of whole. Both servers honour `Range`, so the mount slices
 * a gigabyte file the same way it slices a picked `File` — the alternative, reading 1.7 GB per
 * boot, is not one.
 */
export async function rangedReader(url: FileUrl, path: string): Promise<ByteReader> {
  const head = await fetch(url(path), { method: "HEAD" });
  if (!head.ok) throw new Error(`${path}: ${head.status} ${head.statusText}`);
  const size = Number(head.headers.get("content-length") ?? 0);
  return {
    size,
    slice: async (start, end) => {
      const res = await fetch(url(path), { headers: { Range: `bytes=${start}-${end - 1}` } });
      if (!res.ok) throw new Error(`${path} [${start},${end}): ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** The CASC pieces the mount needs. The `data.NNN` files stay remote and ranged. */
export async function fetchCasc(url: FileUrl, manifest: CascManifest): Promise<CascFiles> {
  const casc: CascFiles = {
    buildInfo: await fetchInstallText(url, manifest.buildInfo),
    config: new Map(),
    idx: new Map(),
    data: new Map(),
  };
  const key = (p: string): string => baseName(p).toLowerCase();
  for (const p of manifest.config) casc.config.set(key(p), await fetchInstallText(url, p));
  for (const p of manifest.idx) casc.idx.set(key(p), await fetchInstallBytes(url, p));
  for (const [n, p] of Object.entries(manifest.data)) casc.data.set(Number(n), await rangedReader(url, p));
  return casc;
}

/**
 * A map file that has not been read yet.
 *
 * The browser's own folder picker hands back `File`s that are HANDLES — nothing is in memory
 * until somebody asks — and an install's `Maps\` folder is hundreds of files (209 on the
 * developer's), so fetching them all to put names in a list would read a few hundred megabytes
 * at boot to show a list of names. The screens ask a map for `name` and, once it is highlighted
 * or played, `arrayBuffer()`; this answers the first from the manifest and defers the second.
 *
 * It is a `File` to its callers and not one underneath, which is the honest way round: making a
 * real `File` requires the bytes, and having the bytes is the thing being avoided.
 */
export function lazyMapFile(url: FileUrl, path: string): File {
  const name = baseName(path);
  let bytes: Promise<ArrayBuffer> | null = null;
  const load = (): Promise<ArrayBuffer> => (bytes ??= fetch(url(path)).then(async (res) => {
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return res.arrayBuffer();
  }));
  const stub = {
    name,
    // Real until read, and unknown before that. Nothing on the map path reads `size` — the
    // parsers take the whole buffer — so a number that would cost a HEAD per map is not fetched.
    size: 0,
    type: "",
    lastModified: 0,
    webkitRelativePath: path,
    arrayBuffer: load,
    bytes: async () => new Uint8Array(await load()),
    text: async () => new TextDecoder().decode(await load()),
    slice: (start?: number, end?: number) => new Blob([]).slice(start, end),
    stream: () => new Blob([]).stream(),
  };
  return stub as unknown as File;
}
