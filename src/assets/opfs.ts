// Asset import + persistence skeleton (plan §1.2).
//
// Import once → copy the user's own WC3 install into OPFS → later sessions read
// from OPFS with no re-upload. Copyrighted bytes never touch a server (plan §0).
// Full MPQ v1 reading (mdx-m3-viewer) arrives in Phase 1; this is the VFS shape
// the resolver depends on today.

/** Virtual filesystem over the imported install — the interface the resolver uses. */
export interface DataSource {
  exists(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
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

/**
 * Import a WC3 folder. Chromium exposes showDirectoryPicker; Firefox/Safari fall
 * back to <input webkitdirectory>. Phase 0 stops at picking + persistence — the
 * MPQ reader that turns picked files into a DataSource lands in Phase 1.
 */
export async function pickInstall(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) return null; // TODO Phase 1: <input type="file" webkitdirectory> fallback.
  try {
    return await picker();
  } catch {
    return null; // user cancelled
  }
}
