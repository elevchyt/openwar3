import type { PeerInfo, StartMatch } from "./protocol";

// The GAME LOBBY's seating — the model behind UI\FrameDef\Glue\GameChatroom.fdf (issue #77).
//
// In the real client, creating a LAN game does not leave you on the game list: the host drops
// straight into a lobby with one row per player slot, and everyone who joins afterwards lands
// in it too, auto-seated in the first OPEN slot. This module is that seating — who is in which
// slot, what race/team/handicap they picked — plus the three messages that carry it over the
// wire and the conversion into the `StartMatch` the whole room plays.
//
// THE HOST OWNS THE SEATING. It is the same rule as the match itself (docs/multiplayer.md
// "Why the host, and not a server"): exactly one machine decides, everyone else asks and then
// renders what they are told. A client never mutates its own copy — it sends a `lobbyreq` and
// waits for the `lobby` broadcast that comes back — so two players changing race in the same
// tick can never disagree about the result.
//
// Deliberately free of the DOM, the map reader and the renderer: `SetupMap` is the little of a
// `MapInfo` this needs, so a headless test can drive the whole seating rule (tools/lobby-test.cjs).

/** What the seating needs of a map. `MapInfo` (src/world/mapInfo.ts) satisfies it. */
export interface SetupMap {
  slots: ReadonlyArray<{
    id: number;
    defaultRace: string;
    startX: number;
    startY: number;
    /** w3i player type: a slot the MAP declared a computer is not the lobby's to re-seat. */
    controller: "user" | "computer";
    team: number;
  }>;
}

/**
 * What is in a slot.
 *
 * `open` and `closed` are the two EMPTY states the host chooses between, and they are not the
 * same thing: an open slot is what a joiner is dropped into, a closed one is a seat the host
 * has taken off the table. `computer` is an AI the host added; `player` is a person.
 */
export type SlotKind = "open" | "closed" | "computer" | "player";

export interface LobbySlot {
  /** The MAP's player index. The colour and the start location are its, not the row's. */
  id: number;
  kind: SlotKind;
  /** The relay peer sitting here — only on a `player` slot. */
  peer?: number;
  /** That peer's name, so every client can print the row without a peer list of its own. */
  name?: string;
  race: string;
  team: number;
  handicap: number;
  /** The MAP declared this slot a computer (w3i player type 2) — the row is greyed at
   *  Computer and no joiner is ever seated in it. See MapInfo's PlayerSlot. */
  locked: boolean;
  startX: number;
  startY: number;
}

/** The whole lobby, as the host broadcasts it. A client renders this and nothing else. */
export interface LobbySetup {
  k: "lobby";
  mapPath: string;
  mapName: string;
  /** The room's name — "Local Game (Alice)", GlobalStrings' own GAMENAME format. */
  gameName: string;
  slots: LobbySlot[];
}

/**
 * A client asking the host to change something.
 *
 * It names no player: the host resolves the requester from the relay's `from` stamp, which is
 * the same forgery-proof rule the command funnel uses (src/net/commandLink.ts). A client can
 * therefore only ever change its OWN row, whatever it puts in the payload.
 */
export interface LobbyRequest {
  k: "lobbyreq";
  race?: string;
  team?: number;
  handicap?: number;
}

/** One line of lobby chat, sent to the room. The sender is the relay's `from` stamp. */
export interface LobbyChat {
  k: "lobbychat";
  text: string;
}

/** A fresh lobby on `map`: every human slot Open, every slot the map owns its own computer. */
export function newSetup(mapPath: string, mapName: string, gameName: string, map: SetupMap): LobbySetup {
  return {
    k: "lobby",
    mapPath,
    mapName,
    gameName,
    slots: map.slots.map((s) => ({
      id: s.id,
      kind: s.controller === "computer" ? "computer" : "open",
      race: s.defaultRace,
      team: s.team,
      handicap: 100,
      locked: s.controller === "computer",
      startX: s.startX,
      startY: s.startY,
    })),
  };
}

/** What `seatPeers` changed, so the caller can say it in the chat area. */
export interface Seating {
  setup: LobbySetup;
  /** Peers that were not seated before and are now. */
  joined: PeerInfo[];
  /** Names of players whose peer has gone; their slots are open again. */
  left: string[];
}

/**
 * Reconcile the seating against the room's peer list — the host's job, run on every roster
 * change (issue #77).
 *
 * A peer with no slot takes the first OPEN one. Failing that it takes the first empty slot of
 * any kind that the map does not own: the relay caps the room at the map's slot count, so the
 * only way to run out of open seats is for the host to have closed one after the room was
 * announced, and a person who is already in the room outranks a seat the host merely parked.
 * A peer that is gone frees its slot back to Open (or to Computer, if the map owns it).
 *
 * Pure: it returns a NEW setup rather than editing the one it is given, so the host can diff
 * against what it last broadcast.
 */
export function seatPeers(setup: LobbySetup, peers: ReadonlyArray<PeerInfo>): Seating {
  const slots = setup.slots.map((s) => ({ ...s }));
  const live = new Set(peers.map((p) => p.id));
  const left: string[] = [];

  // Free the seats of peers that are no longer in the room.
  for (const slot of slots) {
    if (slot.kind !== "player" || (slot.peer !== undefined && live.has(slot.peer))) continue;
    if (slot.name) left.push(slot.name);
    slot.kind = slot.locked ? "computer" : "open";
    delete slot.peer;
    delete slot.name;
  }

  // Seat whoever has no seat. Host first, then in join order — the same order the room's own
  // peer ids run in, so the host is always the map's first human slot.
  const seated = new Set(slots.map((s) => s.peer).filter((p): p is number => p !== undefined));
  const joined: PeerInfo[] = [];
  for (const peer of [...peers].sort((a, b) => (a.host ? -1 : b.host ? 1 : a.id - b.id))) {
    const already = slots.find((s) => s.peer === peer.id);
    if (already) {
      already.name = peer.name; // a rejoin may carry a fresh name
      continue;
    }
    const free = slots.find((s) => s.kind === "open") ?? slots.find((s) => !s.locked && s.kind !== "player");
    if (!free) continue; // nowhere to put them; Start refuses while anyone is standing (see canStart)
    free.kind = "player";
    free.peer = peer.id;
    free.name = peer.name;
    seated.add(peer.id);
    joined.push(peer);
  }

  return { setup: { ...setup, slots }, joined, left };
}

/**
 * Who appeared and who vanished between two broadcasts.
 *
 * How a CLIENT prints the same "%s has joined the game." line the host prints off its own
 * seating: the roster is already in every payload, so nothing extra crosses the wire and both
 * ends can only ever say the same thing. `prev` of null is the FIRST payload — the room as we
 * found it, which is not news; WC3 announces the joins that happen while you are watching, not
 * the players who were already there when you arrived.
 */
export function rosterDiff(prev: LobbySetup | null, next: LobbySetup): { joined: string[]; left: string[] } {
  if (!prev) return { joined: [], left: [] };
  const names = (s: LobbySetup): Map<number, string> =>
    new Map(s.slots.filter((x) => x.kind === "player" && x.peer !== undefined).map((x) => [x.peer!, x.name ?? ""]));
  const before = names(prev);
  const after = names(next);
  return {
    joined: [...after].filter(([peer]) => !before.has(peer)).map(([, name]) => name),
    left: [...before].filter(([peer]) => !after.has(peer)).map(([, name]) => name),
  };
}

/** Every peer in the room has a seat — what Start Game waits for. */
export function allSeated(setup: LobbySetup, peers: ReadonlyArray<PeerInfo>): boolean {
  const seated = new Set(setup.slots.map((s) => s.peer).filter((p) => p !== undefined));
  return peers.every((p) => seated.has(p.id));
}

/** Apply one client's request to ITS OWN row. `peer` is the relay's `from` stamp — never
 *  anything the payload said. Returns a new setup, or null if nothing changed. */
export function applyRequest(setup: LobbySetup, peer: number, req: LobbyRequest): LobbySetup | null {
  const index = setup.slots.findIndex((s) => s.kind === "player" && s.peer === peer);
  if (index < 0) return null; // a peer with no seat has no row to change
  const slot = { ...setup.slots[index] };
  if (req.race !== undefined) slot.race = req.race;
  if (req.team !== undefined) slot.team = req.team;
  if (req.handicap !== undefined) slot.handicap = req.handicap;
  const slots = setup.slots.slice();
  slots[index] = slot;
  return { ...setup, slots };
}

/**
 * The match every machine in the room will run.
 *
 * Only the seats that are actually FILLED cross: an Open slot is an empty chair, not a free
 * AI. (This is the lobby earning its keep — the LAN screen used to fill a melee map's spare
 * seats with computers because nothing on screen let the host say otherwise. Now the host
 * picks Computer, or the map is played with fewer players, which is what the real client does.)
 *
 * `seed` is injectable so the dev-LAN boot can pin a reproducible match; production omits it
 * and one is rolled here, once, by the host — nobody else rolls anything, or it is a second
 * match (docs/multiplayer.md Phase A).
 */
export function buildStart(setup: LobbySetup, seed?: number): StartMatch {
  return {
    k: "start",
    mapPath: setup.mapPath,
    mapName: setup.mapName,
    seed: seed ?? 1 + Math.floor(Math.random() * 2147483645),
    slots: setup.slots
      .filter((s) => s.kind === "player" || s.kind === "computer")
      .map((s) => ({
        id: s.id,
        controller: s.kind === "player" ? ("user" as const) : ("computer" as const),
        race: s.race,
        team: s.team,
        startX: s.startX,
        startY: s.startY,
        ...(s.peer === undefined ? {} : { peer: s.peer }),
      })),
  };
}
