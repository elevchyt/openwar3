// Types for electron/logStore.mjs, which the dev server imports too (tools/vite-plugin-match-log.ts).

export const MAX_BYTES: number;
export const MAX_AGE_MS: number;

export interface LogStore {
  readonly dir: string;
  /** Open a match's file — `<stamp>_<map>.log` — and sweep out old ones. Null if the disk said no. */
  begin(name: string): { id: string; file: string } | null;
  /** Append whole lines, rolling over into `.partN.log` past `maxBytes`. */
  append(id: string, text: string): boolean;
  /** Forget the id; answers the file it was last writing. */
  end(id: string): string | null;
  /** Delete every file in the folder older than `maxAgeMs`; answers how many went. */
  sweep(now?: number): number;
}

export function createLogStore(
  dir: string,
  opts?: { maxBytes?: number; maxAgeMs?: number; warn?: (msg: string) => void },
): LogStore;
