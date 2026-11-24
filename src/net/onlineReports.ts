import type { LanLobby } from "./lobby";

// What goes wrong in ONLINE play, sent to the OpenWar3 server's event log (LanLobby.report →
// server/rooms.mjs `report` → server/eventLog.mjs, kept in the project's `logs` bucket). The
// developer's ask: log as much as can be about online mode, crashes included, because a player's
// console is on their machine and a bug report is "it stayed on 0%".
//
// Only while a LAN session or a networked match is up — `lobby()` answers null otherwise, and an
// offline game's errors go nowhere. Each distinct message is sent ONCE and then counted: an error
// thrown every frame would otherwise be sixty reports a second, and the relay's own quota
// (REPORTS_PER_MINUTE) would drop the ones that matter along with it. A repeat is reported again
// at 10, 100, 1000… so a loop is still visible as one.

/** How many distinct errors one session reports before it stops reporting new ones. Ours. */
const MAX_DISTINCT = 25;

export function watchOnlineErrors(lobby: () => LanLobby | null): void {
  const seen = new Map<string, number>();
  const send = (kind: string, message: string, stack: string | null, where: string | null): void => {
    const live = lobby();
    if (!live) return;
    const key = `${kind}:${message}`;
    const n = (seen.get(key) ?? 0) + 1;
    if (n === 1 && seen.size >= MAX_DISTINCT) return;
    seen.set(key, n);
    // 1, 10, 100, 1000: the first sighting with its stack, then the count as it grows.
    if (n !== 1 && !Number.isInteger(Math.log10(n))) return;
    live.report("error", { kind, message: message.slice(0, 500), stack: n === 1 ? stack : null, where, count: n }, "error");
  };
  window.addEventListener("error", (e) => {
    const err = e.error as Error | undefined;
    send("error", err?.message ?? e.message ?? "unknown", err?.stack ?? null, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as unknown;
    const err = r instanceof Error ? r : null;
    send("rejection", err?.message ?? String(r), err?.stack ?? null, null);
  });
}
