// Asset import + persistence (plan §1.2). Import once → read the user's own WC3
// install client-side → cache in OPFS later. Copyrighted bytes never touch a
// server (plan §0). Phase 1 delivers the picker + the MPQ files it yields; the
// OPFS copy that avoids re-picking each session lands alongside it next.

/** MPQ archive files from a picked install, keyed by lowercased base name. */
export type InstallFiles = Map<string, File>;

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
}
interface DirHandle {
  name: string;
  values(): AsyncIterableIterator<DirEntry>;
}

const isMpq = (name: string): boolean => name.toLowerCase().endsWith(".mpq");

/**
 * Pick a WC3 folder and return its top-level MPQ files. Uses showDirectoryPicker
 * on Chromium, falling back to <input webkitdirectory> on Firefox/Safari.
 * Returns null if the user cancels or nothing is selected.
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
      }
    }
    return files;
  }

  return pickViaInput();
}

/** Firefox/Safari fallback: a directory <input>, filtered to MPQ files. */
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
        if (isMpq(file.name)) files.set(file.name.toLowerCase(), file);
      }
      resolve(files.size ? files : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
