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
export type Refusal = "not-a-command" | "no-seat" | "bad-shape";

// --- shape --------------------------------------------------------------------------------------
//
// The TYPE of a command is a promise the compiler keeps for the host's own code and nobody
// else's: what arrives from the wire is whatever JSON a client chose to send. Before this, the
// host checked `k === "cmd"` and nothing more, so `{ c: "rally", unitId: <mine>, x: "a", y: {} }`
// stored a string and an object as a rally point, and a move to `NaN` went into the pathfinder —
// non-numbers in the authoritative sim, its snapshots and its replay. So each command's fields
// are checked for their KIND here, once, at the door; whether the values are ALLOWED (who owns
// the unit, what it costs) stays the authority's judgement, as it always was.

type Field = "id" | "int" | "num" | "str" | "bool" | "bool?" | "order" | "rally";

/** Every command, and the kind of each of its fields (`bool?` is optional). Keyed on `Command["c"]`,
 *  so a new member of `Command` that is not listed here fails to compile. */
const SHAPES: Record<Command["c"], Record<string, Field>> = {
  order: { unitId: "id", order: "order", queued: "bool", group: "bool?" },
  cast: { unitId: "id", code: "str", targetId: "id", x: "num", y: "num", queued: "bool" },
  garrison: { unitId: "id", buildingId: "id" },
  drink: { unitId: "id", wellId: "id" },
  getitem: { unitId: "id", itemId: "id" },
  useitem: { unitId: "id", slot: "int", targetId: "id", x: "num", y: "num" },
  dropitem: { unitId: "id", slot: "int", x: "num", y: "num" },
  sellitem: { unitId: "id", slot: "int", shopId: "id" },
  giveitem: { unitId: "id", slot: "int", targetId: "id" },
  shopbuyer: { shopId: "id", unitId: "id" },
  autocast: { unitId: "id", code: "str", arm: "bool?" },
  rally: { unitId: "id", x: "num", y: "num", kind: "rally", targetId: "id" },
  swapitem: { unitId: "id", from: "int", to: "int" },
  learnskill: { unitId: "id", abilityId: "str" },
  repair: { unitId: "id", buildingId: "id", queued: "bool" },
  build: { unitId: "id", defId: "str", x: "num", y: "num", queued: "bool" },
  train: { buildingId: "id", unitId: "str" },
  revive: { buildingId: "id", heroId: "id" },
  research: { buildingId: "id", upgradeId: "str" },
  upgradebuilding: { buildingId: "id", toTypeId: "str" },
  cancelbuild: { buildingId: "id" },
  canceltrain: { buildingId: "id", index: "int" },
  battlestations: { buildingId: "id" },
  standdown: { buildingId: "id" },
  load: { transportId: "id", unitId: "id" },
  unloadone: { buildingId: "id", unitId: "id" },
  unloadat: { unitId: "id", x: "num", y: "num" },
  buyitem: { shopId: "id", itemId: "str" },
  neutralcast: { shopId: "id", abilityId: "str", x: "num", y: "num" },
};

const RALLY_KINDS: ReadonlySet<string> = new Set(["none", "point", "mine", "tree", "unit"]);

/**
 * Order kinds a client may never send inside an `order` command, because they carry what the
 * engine DERIVES rather than what the player asked for (game/commands.ts). `buildnew` holds the
 * price it was paid and whether it was paid at all, `repair` its own rates: sent from the wire,
 * either would let a client set them — a free building, a repair at no cost. The intent-only
 * `build` and `repair` COMMANDS are how a client asks for both, and the authority builds these
 * orders itself.
 */
const DERIVED_ORDER_KINDS: ReadonlySet<string> = new Set(["buildnew", "repair"]);

/** An ability/unit/item id or code. Generous — a map's own ids are four characters. */
const MAX_STR = 64;

const isId = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;

/** A queued order: a plain record with a string `kind`, whose fields are finite numbers, short
 *  strings or booleans — every member of `QueuedOrder` is that shape. */
function isOrderShape(o: unknown): boolean {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  if (typeof r.kind !== "string" || DERIVED_ORDER_KINDS.has(r.kind)) return false;
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (typeof v === "number") { if (!Number.isFinite(v)) return false; }
    else if (typeof v === "string") { if (v.length > MAX_STR) return false; }
    else if (typeof v !== "boolean") return false;
  }
  return true;
}

/** Is `cmd` a `Command` whose every field has the kind the type promises? */
export function isCommandShape(cmd: unknown): cmd is Command {
  if (typeof cmd !== "object" || cmd === null || Array.isArray(cmd)) return false;
  const c = (cmd as { c?: unknown }).c;
  if (typeof c !== "string" || !Object.prototype.hasOwnProperty.call(SHAPES, c)) return false;
  const shape = SHAPES[c as Command["c"]];
  const r = cmd as Record<string, unknown>;
  for (const [k, f] of Object.entries(shape)) {
    const v = r[k];
    switch (f) {
      case "id": if (!isId(v)) return false; break;
      case "int": if (!Number.isSafeInteger(v)) return false; break;
      case "num": if (typeof v !== "number" || !Number.isFinite(v)) return false; break;
      case "str": if (typeof v !== "string" || v.length === 0 || v.length > MAX_STR) return false; break;
      case "bool": if (typeof v !== "boolean") return false; break;
      case "bool?": if (v !== undefined && typeof v !== "boolean") return false; break;
      case "order": if (!isOrderShape(v)) return false; break;
      case "rally": if (typeof v !== "string" || !RALLY_KINDS.has(v)) return false; break;
    }
  }
  return true;
}

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
    if (!isCommandShape(data.cmd)) return "bad-shape";
    return { player, cmd: data.cmd };
  }
}

/** Narrowing helper, so a caller can branch without repeating the union. */
export function accepted(r: Accepted | Refusal): r is Accepted {
  return typeof r !== "string";
}
