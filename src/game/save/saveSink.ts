// Where SAVED GAMES go (issue #159, docs/save-games.md) — the one browser-only piece, kept apart
// from the format as replaySink.ts is from the replay file. Two doors, one store
// (electron/saveStore.mjs): the desktop shell's `saves/` in the data folder, beside `replays/`,
// and under `pnpm dev` the repo's own `.saves/`. A plain web build has no disk, and keeps its
// saves in the page's own IndexedDB instead (`browserSaves`) — a save is something the player
// made and expects to find again, so a build with no folder still has to have somewhere.

export interface SaveFileInfo {
  name: string;
  size: number;
  /** Last written, ms since the epoch. */
  mtime: number;
}

export interface SaveSink {
  /** Write a saved game; resolves to the name it was written as, or null. */
  write(name: string, bytes: Uint8Array): Promise<string | null>;
  /** Every saved game, newest first. */
  list(): Promise<SaveFileInfo[]>;
  read(name: string): Promise<Uint8Array | null>;
  exists(name: string): Promise<boolean>;
  remove(name: string): Promise<boolean>;
}

/** The extension of a saved game. Ours: WC3's is `.w3z`, which is a different format. */
export const SAVE_EXT = ".o3s";

/** A name as the store will write it: no folders, no characters a file system minds, our
 *  extension. The shell and the dev server reduce it the same way (electron/saveStore.mjs). */
export function saveFileName(name: string): string {
  let base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim();
  if (!base.toLowerCase().endsWith(SAVE_EXT)) base += SAVE_EXT;
  return base.slice(0, 120);
}

interface NativeSaves {
  write(name: string, bytes: Uint8Array): Promise<string | null>;
  list(): Promise<SaveFileInfo[]>;
  read(name: string): Promise<Uint8Array | null>;
  exists(name: string): Promise<boolean>;
  remove(name: string): Promise<boolean>;
}

let cached: SaveSink | null | undefined;

/** The sink this build has: the desktop shell's, the dev server's, or the page's own. */
export function saveSink(): SaveSink {
  if (cached) return cached;
  const native = (window as unknown as { ow3native?: { saves?: NativeSaves } }).ow3native?.saves;
  if (native) {
    return (cached = {
      write: (name, bytes) => native.write(name, bytes),
      list: () => native.list(),
      read: async (name) => {
        const b = await native.read(name);
        return b ? new Uint8Array(b) : null;
      },
      exists: (name) => native.exists(name),
      remove: (name) => native.remove(name),
    });
  }
  if (import.meta.env.DEV) {
    const q = (name: string): string => `name=${encodeURIComponent(name)}`;
    return (cached = {
      write: async (name, bytes) => {
        const r = await fetch(`/saves/write?${q(name)}`, { method: "POST", body: bytes as BodyInit });
        return r.ok ? ((await r.json()) as { name: string | null }).name : null;
      },
      list: async () => {
        const r = await fetch("/saves/list");
        return r.ok ? ((await r.json()) as SaveFileInfo[]) : [];
      },
      read: async (name) => {
        const r = await fetch(`/saves/file?${q(name)}`);
        return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
      },
      exists: async (name) => {
        const r = await fetch(`/saves/exists?${q(name)}`);
        return r.ok && ((await r.json()) as { ok: boolean }).ok;
      },
      remove: async (name) => {
        const r = await fetch(`/saves/delete?${q(name)}`, { method: "POST" });
        return r.ok && ((await r.json()) as { ok: boolean }).ok;
      },
    });
  }
  return (cached = browserSaves());
}

/** A web build's saves: IndexedDB, one object store keyed by file name. */
function browserSaves(): SaveSink {
  const DB = "openwar3-saves";
  const STORE = "saves";
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async <T>(mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = body(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };
  type Row = { bytes: Uint8Array; mtime: number };
  return {
    write: async (name, bytes) => {
      const file = saveFileName(name);
      await run("readwrite", (s) => s.put({ bytes, mtime: Date.now() } satisfies Row, file));
      return file;
    },
    list: async () => {
      const keys = (await run("readonly", (s) => s.getAllKeys())) as string[];
      const rows = (await run("readonly", (s) => s.getAll())) as Row[];
      return keys.map((name, i) => ({ name, size: rows[i].bytes.length, mtime: rows[i].mtime })).sort((a, b) => b.mtime - a.mtime);
    },
    read: async (name) => ((await run("readonly", (s) => s.get(saveFileName(name)))) as Row | undefined)?.bytes ?? null,
    exists: async (name) => (await run("readonly", (s) => s.count(saveFileName(name)))) > 0,
    remove: async (name) => {
      await run("readwrite", (s) => s.delete(saveFileName(name)));
      return true;
    },
  };
}
