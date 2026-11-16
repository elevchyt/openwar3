// Types for electron/saveStore.mjs, which the dev server imports too (tools/vite-plugin-saves.ts).

export const SAVE_EXT: string;

export function safeSaveName(name: unknown): string | null;

export interface SaveStore {
  readonly dir: string;
  /** Write a saved game under a name; answers the name it was written as, or null. */
  write(name: string, bytes: Uint8Array): string | null;
  /** Every saved game in the folder, newest first. */
  list(): Array<{ name: string; size: number; mtime: number }>;
  /** One saved game's bytes, or null. */
  read(name: string): Uint8Array | null;
  exists(name: string): boolean;
  /** Delete one saved game; true when it is gone. */
  remove(name: string): boolean;
}

export function createSaveStore(dir: string, opts?: { warn?: (msg: string) => void }): SaveStore;
