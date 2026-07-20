import type { RoomInfo } from "./protocol";

// The client half of reconnect (docs/multiplayer.md item 11a-client). Deliberately free of any
// transport or DOM import, so `LanLobby` can be driven headlessly through it and the one piece
// with actual branching — "is there still a game to rejoin?" — is tested rather than trusted.

/**
 * The one secret a client needs to reclaim its slot after a dropped connection.
 *
 * It is PERSISTED (see `localStorageStore`) rather than kept in memory, and that is the whole
 * point of storing it: a memory value dies with the tab, so it survives only a transient socket
 * blip. localStorage survives a reload or a crash, which is the case a player actually hits —
 * the browser fell over, they reopen it, and the game they were in is still running on the LAN.
 */
export interface RejoinSession {
  /** The room the relay is holding a slot in. */
  roomId: string;
  /** The rejoin token the relay minted for this seat (item 11a). Presenting it reclaims the
   *  exact peer id — a match, not a new join. Secret: never shown to another player. */
  token: string;
  /** The name to rejoin under, so the roster reads the same after the round trip. */
  playerName: string;
}

/** Where a session lives between a drop and a rejoin. localStorage in the browser, a plain
 *  object in a test or a non-browser build. */
export interface SessionStore {
  load(): RejoinSession | null;
  save(session: RejoinSession | null): void;
}

const KEY = "openwar3.rejoin";

/**
 * localStorage-backed, degrading to a no-op where there is no localStorage — a Node test that
 * did not inject its own, an SSR pass — rather than throwing at construction. A disabled or
 * full store is swallowed too: failing to remember a token loses the ability to reconnect,
 * which is a worse-experience, not a crash.
 */
export function localStorageStore(): SessionStore {
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  return {
    load() {
      if (!ls) return null;
      try {
        const raw = ls.getItem(KEY);
        return raw ? (JSON.parse(raw) as RejoinSession) : null;
      } catch {
        return null;
      }
    },
    save(session) {
      if (!ls) return;
      try {
        if (session) ls.setItem(KEY, JSON.stringify(session));
        else ls.removeItem(KEY);
      } catch {
        /* quota exceeded, or storage disabled — reconnect is best-effort */
      }
    },
  };
}

/** An in-memory store — for tests, and for a build with no localStorage. */
export function memoryStore(initial: RejoinSession | null = null): SessionStore {
  let s = initial;
  return {
    load: () => s,
    save: (session) => {
      s = session;
    },
  };
}

/**
 * Should this client try to reclaim a slot, and with what?
 *
 * A rejoin is offered ONLY when the remembered room is still in the game list — the host is
 * still up. A room that has vanished means the match ended (v1 has no host migration), so there
 * is nothing to rejoin: the stale session must be forgotten rather than retried against a room
 * that will never come back. Returns the session to rejoin with, or null to give up.
 *
 * This is the whole decision, kept pure so it is the thing under test — the transport flow
 * around it is plumbing.
 */
export function reconnectPlan(session: RejoinSession | null, rooms: readonly RoomInfo[]): RejoinSession | null {
  if (!session) return null;
  return rooms.some((r) => r.id === session.roomId) ? session : null;
}
