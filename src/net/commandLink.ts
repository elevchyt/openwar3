import type { Command } from "../game/commands";

/**
 * Commands crossing the wire (docs/multiplayer.md Phase E item 9).
 *
 * `Command` has been a wire type since Phase C and says deliberately nothing about WHO is
 * asking — "a command says what was asked for, never who is allowed to ask". That was the right
 * call and it leaves exactly one question for this file: on the host, which player does an
 * arriving command belong to?
 *
 * **The answer must not come from the payload, and this is the whole security content of the
 * item.** A client controls every byte it sends. If the envelope carried a `player` field the
 * host trusted, any client could spend another player's gold, cancel their buildings and walk
 * their army off a cliff — and `Authority.execute`'s ownership gate would wave it all through,
 * because that gate asks "does player P own unit U", not "is the sender really P". Phase C
 * built a gate against a FAKED UNIT; this is the gate against a faked PLAYER, and they are
 * different holes.
 *
 * What cannot be forged is the relay's own stamp. `server/rooms.mjs` builds
 * `{ t: "deliver", from: conn.peerId, data }` where `peerId` was assigned by the relay when the
 * connection joined, and a client never gets to write it. So the host resolves peer → player
 * through the seating it already agreed with everybody in `StartMatch`, and a command whose
 * sender holds no seat is refused rather than guessed at.
 *
 * This module deliberately does NOT import `Authority`, the sim, or a transport. It turns a
 * delivered envelope into a judged `(player, cmd)` pair and stops; who executes it and over
 * what wire it arrived are somebody else's business. That keeps the one rule worth testing —
 * identity comes from the stamp — free of everything it would otherwise have to be tested
 * through.
 */

/** The `GameMessage` member. One command, one message: they are small, and batching them would
 *  mean deciding what happens when half a batch is refused. */
export interface CommandMessage {
  k: "cmd";
  cmd: Command;
}

export function isCommandMessage(data: unknown): data is CommandMessage {
  return typeof data === "object" && data !== null && (data as { k?: unknown }).k === "cmd";
}

/** Wrap a command for sending. The client says what it wants; it does not get to say who it is. */
export function commandMessage(cmd: Command): CommandMessage {
  return { k: "cmd", cmd };
}

/** One seated slot, as `StartMatch.slots` already carries it: the player number and, for a
 *  human, the relay peer sitting in it. */
export interface Seat {
  id: number;
  peer?: number;
}

/** Why a command was refused. Returned rather than thrown — a hostile or buggy peer must not be
 *  able to interrupt the host's tick by sending rubbish. */
export type Refusal = "not-a-command" | "no-seat";

export interface Accepted {
  player: number;
  cmd: Command;
}

/**
 * The host's door for arriving commands.
 *
 * Built from the seating the host already broadcast in `StartMatch`, so there is no second
 * source of truth about who sits where. A computer slot has no `peer` and therefore can never
 * be spoken for from the wire, which is correct: the host simulates it.
 */
export class CommandRouter {
  private byPeer = new Map<number, number>();

  constructor(seats: Iterable<Seat>) {
    for (const s of seats) {
      // `peer === undefined` is a computer slot. Note the explicit check rather than a
      // truthiness test: peer id 0 would be a real peer, and `if (s.peer)` would silently
      // unseat it.
      if (s.peer !== undefined) this.byPeer.set(s.peer, s.id);
    }
  }

  /** The player sitting behind this relay peer, or null if nobody is. */
  playerFor(peer: number): number | null {
    const p = this.byPeer.get(peer);
    return p === undefined ? null : p;
  }

  /**
   * Judge one delivered envelope.
   *
   * `from` is the relay's stamp. Everything else is the sender's, and none of it is consulted
   * to decide identity — the returned `player` comes from `from` alone. Pass the payload
   * straight from `{ t: "deliver" }` without unwrapping it here; validating the shape is this
   * function's job, not the caller's.
   */
  receive(from: number, data: unknown): Accepted | Refusal {
    if (!isCommandMessage(data)) return "not-a-command";
    const player = this.playerFor(from);
    if (player === null) return "no-seat";
    return { player, cmd: data.cmd };
  }
}

/** Narrowing helper, so a caller can branch without repeating the union. */
export function accepted(r: Accepted | Refusal): r is Accepted {
  return typeof r !== "string";
}
