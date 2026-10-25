// Where the MATCH LOG's lines go (src/game/matchLog.ts, docs/match-log.md) — kept apart from the
// recorder because it is the one browser-only piece (`import.meta.env`, `window`, `fetch`), and
// the recorder is also compiled for the headless tests (tools/match-log-test.cjs).

import type { MatchLogSink } from "./matchLog";

/** The sink this build has: the dev server's, the desktop shell's, or none. */
export function matchLogSink(): MatchLogSink | null {
  const native = (window as unknown as { ow3native?: { matchLog?: { begin(map: string): Promise<string | null>; append(id: string, text: string): void; end(id: string): Promise<unknown> } } }).ow3native?.matchLog;
  if (import.meta.env.DEV) {
    const post = (path: string, body: unknown): Promise<Record<string, unknown> | null> =>
      fetch(`/matchlog/${path}`, { method: "POST", body: JSON.stringify(body) })
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
        .catch(() => null);
    return {
      begin: (map) => post("begin", { map }).then((r) => (typeof r?.id === "string" ? r.id : null)),
      // `keepalive`, so the last flush on `pagehide` still reaches the server.
      append: (id, text) => {
        void fetch("/matchlog/append", { method: "POST", body: JSON.stringify({ id, text }), keepalive: text.length < 60_000 }).catch(() => {});
      },
      end: (id) => post("end", { id }),
    };
  }
  return native ?? null;
}
