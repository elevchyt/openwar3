// Where REPLAY files go (issue #158, game/replay.ts) — the one browser-only piece, kept apart
// from the format as matchLogSink.ts is from the match log. Two doors, one store
// (electron/replayStore.mjs): the desktop shell's `replays/` in the data folder, and under `pnpm dev`
// the repo's own `.replays/`. A plain web build has no disk and records nothing.

export interface ReplayFileInfo {
  name: string;
  size: number;
  /** Last written, ms since the epoch. */
  mtime: number;
}

export interface ReplaySink {
  /** Write the match that just ended as `LastReplay` — and, given a name, keep it in
   *  `Autosaved/` under that name as well (Options → "Automatically Save Replays"). */
  saveLast(bytes: Uint8Array, keep?: string): Promise<void>;
  /** Keep the last replay under a name; resolves to the name it was kept as, or null. */
  keepLast(name: string): Promise<string | null>;
  /** Every replay in the folder, newest first. */
  list(): Promise<ReplayFileInfo[]>;
  /** One replay's bytes, or null. */
  read(name: string): Promise<Uint8Array | null>;
  /** Delete one replay; true when it is gone. */
  remove(name: string): Promise<boolean>;
}

interface NativeReplays {
  saveLast(bytes: Uint8Array, keep?: string): Promise<unknown>;
  keepLast(name: string): Promise<string | null>;
  list(): Promise<ReplayFileInfo[]>;
  read(name: string): Promise<Uint8Array | null>;
  remove(name: string): Promise<boolean>;
}

/** The sink this build has: the desktop shell's, the dev server's, or none. */
export function replaySink(): ReplaySink | null {
  const native = (window as unknown as { ow3native?: { replays?: NativeReplays } }).ow3native?.replays;
  if (native) {
    return {
      saveLast: async (bytes, keep) => void (await native.saveLast(bytes, keep)),
      keepLast: (name) => native.keepLast(name),
      list: () => native.list(),
      read: async (name) => {
        const b = await native.read(name);
        return b ? new Uint8Array(b) : null;
      },
      remove: (name) => native.remove(name),
    };
  }
  if (import.meta.env.DEV) {
    return {
      saveLast: async (bytes, keep) => {
        const r = await fetch(`/replays/last${keep ? `?keep=${encodeURIComponent(keep)}` : ""}`, { method: "POST", body: bytes as BodyInit });
        if (!r.ok) throw new Error(`dev server refused the replay (${r.status})`);
      },
      keepLast: async (name) => {
        const r = await fetch(`/replays/keep?name=${encodeURIComponent(name)}`, { method: "POST" });
        return r.ok ? ((await r.json()) as { name: string | null }).name : null;
      },
      list: async () => {
        const r = await fetch("/replays/list");
        return r.ok ? ((await r.json()) as ReplayFileInfo[]) : [];
      },
      read: async (name) => {
        const r = await fetch(`/replays/file?name=${encodeURIComponent(name)}`);
        return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
      },
      remove: async (name) => {
        const r = await fetch(`/replays/delete?name=${encodeURIComponent(name)}`, { method: "POST" });
        return r.ok && ((await r.json()) as { ok: boolean }).ok;
      },
    };
  }
  return null;
}
