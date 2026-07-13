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
 * Pick a WC3 folder and return its top-level MPQ archives plus every map under `Maps\`.
 * Uses showDirectoryPicker on Chromium, falling back to <input webkitdirectory> on
 * Firefox/Safari. Returns null if the user cancels or nothing is selected.
 */
export async function pickInstall(): Promise<InstallFiles | null> {
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
    for await (const entry of handle.values()) {
      if (entry.kind === "file" && isMpq(entry.name)) {
        files.set(entry.name.toLowerCase(), await entry.getFile());
      } else if (entry.kind === "directory" && entry.name.toLowerCase() === "maps") {
        await collectMaps(entry, entry.name, files);
      }
    }
    return files;
  }

  return pickViaInput();
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
function pickViaInput(): Promise<InstallFiles | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.onchange = () => {
      const list = input.files;
      if (!list || list.length === 0) return resolve(null);
      const files: InstallFiles = new Map();
      for (const file of Array.from(list)) {
        if (isMpq(file.name)) { files.set(file.name.toLowerCase(), file); continue; }
        if (!isMap(file.name)) continue;
        // webkitRelativePath is "<pickedFolder>/Maps/FrozenThrone/(2)EchoIsles.w3x";
        // drop the folder the user picked, and speak WC3's separator.
        const rel = file.webkitRelativePath.split("/").slice(1).join("\\");
        if (isUnderMaps(rel)) files.set(rel, file);
      }
      resolve(files.size ? files : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
