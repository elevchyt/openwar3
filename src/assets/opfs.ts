import { fileReader, type CascFiles } from "../vfs/casc";

// Asset import + persistence (plan §1.2). Import once → read the user's own WC3
// install client-side → cache in OPFS later. Copyrighted bytes never touch a
// server (plan §0). Phase 1 delivers the picker + the MPQ files it yields; the
// OPFS copy that avoids re-picking each session lands alongside it next.

/**
 * Files from a picked install:
 *   • the top-level MPQ archives, keyed by LOWERCASED base name — "war3.mpq", "war3x.mpq"
 *   • every map under `Maps\`, keyed by its relative path AS WRITTEN —
 *     "Maps\\FrozenThrone\\(2)EchoIsles.w3x"
 *
 * The maps are here because the Custom Game screen lists them (issue #61): WC3's melee maps
 * live on DISK under `Maps\`, not inside the archives (the MPQs carry only the campaign
 * ones), so a list built from the VFS alone would come up empty. Their keys keep their case
 * because those keys are shown to the player — an archive's name never is.
 */
export type InstallFiles = Map<string, File>;

/** Prefix of a map entry's key in InstallFiles (matched case-insensitively). */
export const MAPS_PREFIX = "Maps\\";

const isMap = (name: string): boolean => /\.(w3m|w3x)$/i.test(name);
const isUnderMaps = (key: string): boolean => key.toLowerCase().startsWith(MAPS_PREFIX.toLowerCase());

/** The maps in a picked install, as `path → File` (path with WC3's `\` separators). */
export function installMaps(files: InstallFiles): Map<string, File> {
  const maps = new Map<string, File>();
  for (const [key, file] of files) if (isUnderMaps(key)) maps.set(key, file);
  return maps;
}

/** Ask the browser to keep the OPFS cache from being evicted under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

/** Rough free-space check before importing a multi-GB install. */
export async function estimateQuota(): Promise<{ usage: number; quota: number }> {
  const est = (await navigator.storage?.estimate?.()) ?? {};
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
}

// The File System Access API has spotty lib typings, so declare the slice we use.
interface DirEntry {
  kind: "file" | "directory";
  name: string;
  getFile(): Promise<File>;
  values(): AsyncIterableIterator<DirEntry>;
}
interface DirHandle {
  name: string;
  values(): AsyncIterableIterator<DirEntry>;
}

const isMpq = (name: string): boolean => name.toLowerCase().endsWith(".mpq");

/**
 * A picked install, whichever storage it uses (issue #102).
 *
 * `files` is the same as it always was — the MPQ archives of an MPQ-era install, plus the maps
 * on disk, which BOTH eras keep in a plain `Maps\` folder. `casc` is filled in instead of the
 * archives when the folder is 1.30+: `.build.info` beside the exe and the `Data\` content
 * store. The two never coexist, and the loader mounts whichever it was handed.
 */
export interface PickedInstall {
  files: InstallFiles;
  casc: CascFiles | null;
}

/** `.build.info` is the marker of a CASC install; an MPQ-era folder has no such file. */
const BUILD_INFO = ".build.info";
const isIdx = (name: string): boolean => /^[0-9a-f]{10}\.idx$/i.test(name);
const dataFileNumber = (name: string): number | null => {
  const m = /^data\.(\d{3})$/i.exec(name);
  return m ? Number(m[1]) : null;
};

function emptyCasc(): CascFiles {
  return { buildInfo: "", config: new Map(), idx: new Map(), data: new Map() };
}

/**
 * Pick a WC3 folder and return what it holds: MPQ archives or a CASC store, plus every map
 * under `Maps\`. Uses showDirectoryPicker on Chromium, falling back to <input webkitdirectory>
 * on Firefox/Safari. Returns null if the user cancels or nothing is selected.
 */
export async function pickInstall(): Promise<PickedInstall | null> {
  const picker = (
    window as unknown as { showDirectoryPicker?: () => Promise<DirHandle> }
  ).showDirectoryPicker;

  if (picker) {
    let handle: DirHandle;
    try {
      handle = await picker();
    } catch {
      return null; // user cancelled
    }
    const files: InstallFiles = new Map();
    const casc = emptyCasc();
    for await (const entry of handle.values()) {
      if (entry.kind === "file" && isMpq(entry.name)) {
        files.set(entry.name.toLowerCase(), await entry.getFile());
      } else if (entry.kind === "file" && entry.name.toLowerCase() === BUILD_INFO) {
        casc.buildInfo = await (await entry.getFile()).text();
      } else if (entry.kind === "directory" && entry.name.toLowerCase() === "maps") {
        await collectMaps(entry, entry.name, files);
      } else if (entry.kind === "directory" && entry.name.toLowerCase() === "data") {
        await collectCasc(entry, casc);
      }
    }
    return { files, casc: casc.buildInfo ? casc : null };
  }

  return pickViaInput();
}

/** Walk `Data\` for the pieces a CASC mount needs (vfs/casc.ts). Everything but the
 *  `data.NNN` files is small and read whole; those are kept as ranged readers. */
async function collectCasc(dir: DirEntry, into: CascFiles, depth = 0): Promise<void> {
  for await (const entry of dir.values()) {
    if (entry.kind === "directory") {
      // config/ is a two-level hash fan-out, data/ and indices/ are flat — three levels of
      // recursion covers both without walking anything deeper.
      if (depth < 3) await collectCasc(entry, into, depth + 1);
      continue;
    }
    const name = entry.name;
    if (isIdx(name)) {
      into.idx.set(name.toLowerCase(), new Uint8Array(await (await entry.getFile()).arrayBuffer()));
      continue;
    }
    const number = dataFileNumber(name);
    if (number !== null) {
      into.data.set(number, fileReader(await entry.getFile()));
      continue;
    }
    // A config file is named by its own MD5 — 32 hex characters and no extension.
    if (/^[0-9a-f]{32}$/i.test(name)) into.config.set(name.toLowerCase(), await (await entry.getFile()).text());
  }
}

/** Walk `Maps\` and add every .w3m/.w3x under it, keyed by its relative path. */
async function collectMaps(dir: DirEntry, prefix: string, into: InstallFiles): Promise<void> {
  for await (const entry of dir.values()) {
    const path = `${prefix}\\${entry.name}`;
    if (entry.kind === "file") {
      if (isMap(entry.name)) into.set(path, await entry.getFile());
    } else {
      await collectMaps(entry, path, into);
    }
  }
}

/** Firefox/Safari fallback: a directory <input>. webkitRelativePath gives the same keys. */
function pickViaInput(): Promise<PickedInstall | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.onchange = () => {
      void (async () => {
        const list = input.files;
        if (!list || list.length === 0) return resolve(null);
        const files: InstallFiles = new Map();
        const casc = emptyCasc();
        for (const file of Array.from(list)) {
          // webkitRelativePath is "<pickedFolder>/Maps/FrozenThrone/(2)EchoIsles.w3x";
          // drop the folder the user picked, and speak WC3's separator.
          const parts = file.webkitRelativePath.split("/").slice(1);
          const top = parts[0]?.toLowerCase();
          if (parts.length === 1 && isMpq(file.name)) { files.set(file.name.toLowerCase(), file); continue; }
          if (parts.length === 1 && file.name.toLowerCase() === BUILD_INFO) { casc.buildInfo = await file.text(); continue; }
          if (top === "data") {
            if (isIdx(file.name)) { casc.idx.set(file.name.toLowerCase(), new Uint8Array(await file.arrayBuffer())); continue; }
            const number = dataFileNumber(file.name);
            if (number !== null) { casc.data.set(number, fileReader(file)); continue; }
            if (/^[0-9a-f]{32}$/i.test(file.name)) casc.config.set(file.name.toLowerCase(), await file.text());
            continue;
          }
          if (!isMap(file.name)) continue;
          const rel = parts.join("\\");
          if (isUnderMaps(rel)) files.set(rel, file);
        }
        if (!files.size && !casc.buildInfo) return resolve(null);
        resolve({ files, casc: casc.buildInfo ? casc : null });
      })();
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
