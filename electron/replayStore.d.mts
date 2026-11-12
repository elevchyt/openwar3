// Types for electron/replayStore.mjs, which the dev server imports too (tools/vite-plugin-replays.ts).

export const REPLAY_EXT: string;
export const LAST_REPLAY: string;
export const AUTOSAVED: string;

export function safeReplayName(name: unknown): string | null;

export interface ReplayStore {
  readonly dir: string;
  /** Write the match that just ended as `LastReplay.o3r` — and, given a name, keep it in
   *  `Autosaved/` under that name too; answers the name. */
  saveLast(bytes: Uint8Array, autosaveName?: string): string;
  /** Copy the last replay to a name; answers the name it was kept as, or null. */
  keepLast(name: string): string | null;
  /** Every replay in the folder and in `Autosaved/` (named `Autosaved/<file>`), newest first. */
  list(): Array<{ name: string; size: number; mtime: number }>;
  /** One replay's bytes, or null. */
  read(name: string): Uint8Array | null;
  /** Delete one replay; true when it is gone. */
  remove(name: string): boolean;
}

export function createReplayStore(dir: string, opts?: { warn?: (msg: string) => void }): ReplayStore;
