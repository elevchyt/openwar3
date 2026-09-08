import { MELEE_NORMAL } from "../ai/ids";
import { MELEE } from "../data/gameplayConstants";
import { resolveRace, type Race } from "../data/races";
import { DEFAULT_ADVANCED, type AdvancedOptions } from "./advancedOptions";
import type { PeerInfo, StartMatch } from "./protocol";

// The GAME LOBBY's seating — the model behind UI\FrameDef\Glue\GameChatroom.fdf (issue #77).
//
// In the real client, creating a LAN game does not leave you on the game list: the host drops
// straight into a lobby with one row per player slot, and everyone who joins afterwards lands
// in it too, auto-seated in the first OPEN slot. This module is that seating — who is in which
// slot, what race/team/colour/handicap they picked, who is only WATCHING — plus the three
// messages that carry it over the wire and the conversion into the `StartMatch` the whole
// room plays.
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
  /** The MAP's player index. The start location is its, not the row's. */
  id: number;
  kind: SlotKind;
  /** The relay peer sitting here — only on a `player` slot. */
  peer?: number;
  /** That peer's name, so every client can print the row without a peer list of its own. */
  name?: string;
  race: string;
  team: number;
  handicap: number;
  /**
   * The colour the seat wears — an index into the twelve player colours (ui/hud.ts
   * PLAYER_COLORS), and the match's `SetPlayerColor` for this slot.
   *
   * It opens on the slot's own index, which is what WC3's defaults are (player 6 is green
   * because it is player 6), and it is UNIQUE across every row of the lobby at all times,
   * empty rows included: a change onto a colour an empty row holds SWAPS the two, and one a
   * seated row holds is refused (`setSlotColor`). So a joiner dropped into an open seat always
   * finds a colour nobody else wears, without a second pass to hand one out.
   */
  color: number;
  /** On a `computer` slot, WHICH computer — `MeleeDifficulty()`'s MELEE_NEWBIE / MELEE_NORMAL
   *  / MELEE_INSANE (src/ai/ids.ts), as the host's name menu named it. Absent everywhere else,
   *  and absent reads as NORMAL. */
  ai?: number;
  /** The MAP declared this slot a computer (w3i player type 2) — the row is greyed at
   *  Computer and no joiner is ever seated in it. See MapInfo's PlayerSlot. */
  locked: boolean;
  startX: number;
  startY: number;
}

/**
 * One seat on the OBSERVERS bench — the "Observers:" force the lobby grows under Full
 * Observers. A watcher, not a player: no race, no team, no colour, no start location, and no
 * seat in `StartMatch.slots`. `open`/`closed` are the host's two empty states, as on a player
 * slot; `player` is a person watching.
 */
export interface ObserverSlot {
  kind: Exclude<SlotKind, "computer">;
  peer?: number;
  name?: string;
}

/** The whole lobby, as the host broadcasts it. A client renders this and nothing else. */
export interface LobbySetup {
  k: "lobby";
  mapPath: string;
  mapName: string;
  /** The room's name — "Local Game (Alice)", GlobalStrings' own GAMENAME format. */
  gameName: string;
  slots: LobbySlot[];
  /** The Observers bench. Empty unless the host chose Full Observers (`observerSlots`). */
  observers: ObserverSlot[];
  /** What the host set on the create screen's Advanced Options pane. Fixed for the room's
   *  life, as in the real client — the lobby prints it, it does not edit it. */
  advanced: AdvancedOptions;
  /**
   * The start countdown is running (LobbyCount).
   *
   * The seating is locked while it is: every row's menus are dead on every machine and a
   * request that arrives anyway is refused (`applyRequest`), because the seating the countdown
   * is about to hand to `buildStart` must be the one the room is looking at. It rides the
   * SEATING rather than the countdown's own messages so a client locks and unlocks off the
   * broadcast it already renders — an abandoned countdown prints nothing (there is no string
   * for one) but must still give the rows back, and that is one broadcast rather than a
   * second kind of message that can go missing on its own.
   */
  counting?: boolean;
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
  /** A new team — or, from the Observers bench, the team to come BACK to a player slot on. */
  team?: number;
  handicap?: number;
  /** A new colour (a PLAYER_COLORS index). Refused if a seated row already wears it. */
  color?: number;
  /** Get up from a player slot onto the Observers bench. Only under Full Observers. */
  observe?: boolean;
}

/** One line of lobby chat, sent to the room. The sender is the relay's `from` stamp. */
export interface LobbyChat {
  k: "lobbychat";
  text: string;
}

/**
 * One second of the host's start countdown, to be printed by everybody in the room.
 *
 * The clock is the HOST's alone: it sends one of these per line and a client prints what it is
 * told rather than running a countdown of its own, so nobody's numbers can drift out of step
 * with the `start` that follows the last one. An ABORTED countdown sends nothing at all — the
 * lines simply stop, which is all the real client shows (NetworkStrings.fdf carries no line for
 * a cancelled start, the way it does for a player joining or leaving).
 */
export interface LobbyCount {
  k: "lobbycount";
  /** Seconds left — GlobalStrings' TIMER_COUNTDOWN `%d`, counting 5 … 1. */
  n: number;
}

/**
 * How many seats the Observers bench has: the twelve player slots the game has, less the
 * ones the map takes — a two-player map seats ten observers, which is the count the real
 * client's lobby shows. Zero unless the host chose Full Observers (see AdvancedOptions).
 */
export function observerSlots(mapSlots: number, advanced: AdvancedOptions): number {
  return advanced.observers === "FULL_OBSERVERS" ? Math.max(0, MELEE.MAX_PLAYERS - mapSlots) : 0;
}

/** A fresh lobby on `map`: every human slot Open, every slot the map owns its own computer,
 *  and the Observers bench sized by the options (empty without Full Observers). */
export function newSetup(
  mapPath: string,
  mapName: string,
  gameName: string,
  map: SetupMap,
  advanced: AdvancedOptions = DEFAULT_ADVANCED,
): LobbySetup {
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
      color: s.id,
      locked: s.controller === "computer",
      startX: s.startX,
      startY: s.startY,
    })),
    observers: Array.from({ length: observerSlots(map.slots.length, advanced) }, () => ({ kind: "open" as const })),
    advanced,
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
 * A peer with no seat takes the first OPEN player slot. Failing that it takes an open seat on
 * the Observers bench — a joiner who finds every player slot taken is dropped in to watch,
 * which is what Full Observers is for. Failing THAT it takes the first empty player slot of
 * any kind that the map does not own: the relay caps the room at the lobby's seat count, so
 * the only way to run out is for the host to have closed a seat after the room was announced,
 * and a person who is already in the room outranks a seat the host merely parked. A peer that
 * is gone frees its seat back to Open (or to Computer, if the map owns it).
 *
 * Pure: it returns a NEW setup rather than editing the one it is given, so the host can diff
 * against what it last broadcast.
 */
export function seatPeers(setup: LobbySetup, peers: ReadonlyArray<PeerInfo>): Seating {
  const slots = setup.slots.map((s) => ({ ...s }));
  const observers = setup.observers.map((o) => ({ ...o }));
  const live = new Set(peers.map((p) => p.id));
  const left: string[] = [];

  // Free the seats of peers that are no longer in the room — player slots and the bench alike.
  for (const slot of slots) {
    if (slot.kind !== "player" || (slot.peer !== undefined && live.has(slot.peer))) continue;
    if (slot.name) left.push(slot.name);
    slot.kind = slot.locked ? "computer" : "open";
    delete slot.peer;
    delete slot.name;
  }
  for (const seat of observers) {
    if (seat.kind !== "player" || (seat.peer !== undefined && live.has(seat.peer))) continue;
    if (seat.name) left.push(seat.name);
    seat.kind = "open";
    delete seat.peer;
    delete seat.name;
  }

  // Seat whoever has no seat. Host first, then in join order — the same order the room's own
  // peer ids run in, so the host is always the map's first human slot.
  const joined: PeerInfo[] = [];
  for (const peer of [...peers].sort((a, b) => (a.host ? -1 : b.host ? 1 : a.id - b.id))) {
    const already = slots.find((s) => s.peer === peer.id) ?? observers.find((o) => o.peer === peer.id);
    if (already) {
      already.name = peer.name; // a rejoin may carry a fresh name
      continue;
    }
    const free = slots.find((s) => s.kind === "open")
      ?? observers.find((o) => o.kind === "open")
      ?? slots.find((s) => !s.locked && s.kind !== "player");
    if (!free) continue; // nowhere to put them; Start refuses while anyone is standing (see canStart)
    free.kind = "player";
    free.peer = peer.id;
    free.name = peer.name;
    joined.push(peer);
  }

  return { setup: { ...setup, slots, observers }, joined, left };
}

/** Everyone seated, player slots and the bench alike: peer → name. */
function seatedNames(s: LobbySetup): Map<number, string> {
  const out = new Map<number, string>();
  for (const x of s.slots) if (x.kind === "player" && x.peer !== undefined) out.set(x.peer, x.name ?? "");
  for (const x of s.observers) if (x.kind === "player" && x.peer !== undefined) out.set(x.peer, x.name ?? "");
  return out;
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
  const before = seatedNames(prev);
  const after = seatedNames(next);
  return {
    joined: [...after].filter(([peer]) => !before.has(peer)).map(([, name]) => name),
    left: [...before].filter(([peer]) => !after.has(peer)).map(([, name]) => name),
  };
}

/** Every peer in the room has a seat — a player slot or the bench. What Start Game waits for. */
export function allSeated(setup: LobbySetup, peers: ReadonlyArray<PeerInfo>): boolean {
  const seated = seatedNames(setup);
  return peers.every((p) => seated.has(p.id));
}

/** Is somebody actually IN this row? The two empty states are lobby states, not occupants. */
export function isSeated(slot: LobbySlot): boolean {
  return slot.kind === "player" || slot.kind === "computer";
}

/**
 * Whether the room can start: everybody has a seat, and there are at least two PLAYERS — the
 * game's own rule, in its own words: `NEED_AT_LEAST_TWO` "There must be at least two
 * non-observer players to start the game." A lobby of one, or of one and a bench of watchers,
 * is not a match.
 */
export function canStart(setup: LobbySetup, peers: ReadonlyArray<PeerInfo>): boolean {
  return setup.slots.filter(isSeated).length >= 2 && allSeated(setup, peers);
}

/**
 * Give row `index` colour `color`, keeping every row's colour unique (see LobbySlot.color).
 *
 * A colour an EMPTY row holds is taken by swapping — the empty row gets ours, which is what the
 * real client does when you pick a colour off an open seat. A colour a SEATED row holds is
 * theirs, and the change is refused (null): the menu greys those out, and a request that names
 * one anyway (a stale menu, a forged payload) changes nothing.
 */
export function setSlotColor(setup: LobbySetup, index: number, color: number): LobbySetup | null {
  const slots = swapColors(setup.slots, index, color, isSeated);
  return slots ? { ...setup, slots } : null;
}

/** The colours row `index` may pick: the whole palette less what every OTHER seated row wears.
 *  (An empty row's colour is on offer — taking it swaps, see `setSlotColor`.) */
export function colorsFreeFor(setup: LobbySetup, index: number): number[] {
  return freeColorsFor(setup.slots, index, isSeated);
}

/**
 * The colour rule itself, over ANY rows that wear one — the two above are it on a `LobbySetup`,
 * and the Custom Game screen (ui/fdfSkirmish.ts) runs it over its own rows, which are not
 * `LobbySlot`s (nobody joins them) but pick a colour under exactly the same rule: unique across
 * the rows, an empty row's colour taken by swapping, a seated row's refused. `seated` is the
 * caller's own "is somebody in this row", since each screen spells that differently.
 *
 * Returns the rows with the change made (a fresh array, the touched rows copied), or null when
 * nothing changes — the same colour, one off the palette, or one a seated row already wears.
 */
export function swapColors<T extends { color: number }>(
  rows: ReadonlyArray<T>,
  index: number,
  color: number,
  seated: (row: T) => boolean,
): T[] | null {
  const slot = rows[index];
  if (!slot || !Number.isInteger(color) || color < 0 || color >= MELEE.MAX_PLAYERS) return null;
  if (slot.color === color) return null;
  const holder = rows.findIndex((s) => s.color === color);
  if (holder >= 0 && seated(rows[holder])) return null;
  const next = rows.map((s) => ({ ...s }));
  if (holder >= 0) next[holder].color = slot.color;
  next[index].color = color;
  return next;
}

/** `colorsFreeFor` over any rows: the palette less what every OTHER row `seated` says is
 *  occupied wears. The row's own colour is always in the list. */
export function freeColorsFor<T extends { color: number }>(
  rows: ReadonlyArray<T>,
  index: number,
  seated: (row: T) => boolean,
): number[] {
  const taken = new Set(rows.filter((s, i) => i !== index && seated(s)).map((s) => s.color));
  return Array.from({ length: MELEE.MAX_PLAYERS }, (_, i) => i).filter((c) => !taken.has(c));
}

/**
 * Edit ONE player row's race / team / handicap / colour. The host's door to the rows it owns
 * (its own, and the computers it seated); `applyRequest` is a client's, and it lands here once
 * the requester's row has been found. Returns a new setup, or null if nothing changed.
 */
export function editSlot(setup: LobbySetup, index: number, req: Omit<LobbyRequest, "k">): LobbySetup | null {
  const slot = setup.slots[index];
  if (!slot) return null;
  let next: LobbySetup | null = null;
  const patch: Partial<LobbySlot> = {};
  if (req.race !== undefined) patch.race = req.race;
  if (req.team !== undefined) patch.team = req.team;
  if (req.handicap !== undefined) patch.handicap = req.handicap;
  if (Object.keys(patch).length) {
    const slots = setup.slots.slice();
    slots[index] = { ...slot, ...patch };
    next = { ...setup, slots };
  }
  if (req.color !== undefined) next = setSlotColor(next ?? setup, index, req.color) ?? next;
  return next;
}

/**
 * Get up from player slot `index` onto the Observers bench (Full Observers only). The slot is
 * left OPEN — it is a seat again, not a decision taken for anybody — and the person keeps their
 * name on the bench. Null if the bench is full or there is none.
 */
export function moveToObservers(setup: LobbySetup, index: number): LobbySetup | null {
  const slot = setup.slots[index];
  if (!slot || slot.kind !== "player") return null;
  const seat = setup.observers.findIndex((o) => o.kind === "open");
  if (seat < 0) return null;
  const slots = setup.slots.slice();
  const { peer, name, ...rest } = slot;
  slots[index] = { ...rest, kind: "open" };
  const observers = setup.observers.slice();
  observers[seat] = { kind: "player", peer, name };
  return { ...setup, slots, observers };
}

/**
 * Come back off the bench into the first OPEN player slot, on `team`. The row keeps whatever
 * race, handicap and colour it was left with — they are the seat's, and the seat was empty.
 * Null if no player slot is open.
 */
export function moveToPlayers(setup: LobbySetup, benchIndex: number, team?: number): LobbySetup | null {
  const seat = setup.observers[benchIndex];
  if (!seat || seat.kind !== "player") return null;
  const index = setup.slots.findIndex((s) => s.kind === "open");
  if (index < 0) return null;
  const slots = setup.slots.slice();
  slots[index] = { ...slots[index], kind: "player", peer: seat.peer, name: seat.name, ...(team === undefined ? {} : { team }) };
  const observers = setup.observers.slice();
  observers[benchIndex] = { kind: "open" };
  return { ...setup, slots, observers };
}

/**
 * Apply one client's request to ITS OWN row. `peer` is the relay's `from` stamp — never
 * anything the payload said. Returns a new setup, or null if nothing changed.
 *
 * From a player slot: race, team, handicap and colour edit the row, and `observe` moves it to
 * the bench. From the bench: `team` is the way back into a player slot, and nothing else means
 * anything — a watcher has no race to pick.
 */
export function applyRequest(setup: LobbySetup, peer: number, req: LobbyRequest): LobbySetup | null {
  // Nothing moves once the countdown is running: the rows are dead on every machine, so a
  // request that gets here at all is a stale menu or a forged payload (see `counting`).
  if (setup.counting) return null;
  const index = setup.slots.findIndex((s) => s.kind === "player" && s.peer === peer);
  if (index >= 0) {
    if (req.observe) return moveToObservers(setup, index);
    return editSlot(setup, index, req);
  }
  const bench = setup.observers.findIndex((o) => o.kind === "player" && o.peer === peer);
  if (bench >= 0 && req.team !== undefined) return moveToPlayers(setup, bench, req.team);
  return null; // a peer with no seat has no row to change
}

/**
 * The match every machine in the room will run.
 *
 * Only the seats that are actually FILLED cross: an Open slot is an empty chair, not a free
 * AI. (This is the lobby earning its keep — the LAN screen used to fill a melee map's spare
 * seats with computers because nothing on screen let the host say otherwise. Now the host
 * picks Computer, or the map is played with fewer players, which is what the real client does.)
 *
 * RACES ARE ROLLED HERE, on the host, and cross resolved. A seat left on Random — or every
 * seat, under Random Races — used to reach each machine as the word "random" and be rolled by
 * each machine's own `Math.random`, so the host and a client could disagree about what race a
 * player even was (the console skin, the loading screen, the AI's own script). Rolling once,
 * where the seed is rolled, is what makes it one match; `rollRace` is injectable for the same
 * reason `seed` is.
 *
 * `seed` is injectable so the dev-LAN boot can pin a reproducible match; production omits it
 * and one is rolled here, once, by the host — nobody else rolls anything, or it is a second
 * match (docs/multiplayer.md Phase A).
 */
export function buildStart(
  setup: LobbySetup,
  seed?: number,
  rollRace: (race: string) => string = (r) => resolveRace(r as Race),
): StartMatch {
  const { advanced } = setup;
  return {
    k: "start",
    mapPath: setup.mapPath,
    mapName: setup.mapName,
    seed: seed ?? 1 + Math.floor(Math.random() * 2147483645),
    slots: setup.slots
      .filter(isSeated)
      .map((s) => ({
        id: s.id,
        controller: s.kind === "player" ? ("user" as const) : ("computer" as const),
        race: advanced.randomRaces ? rollRace("random") : rollRace(s.race),
        team: s.team,
        color: s.color,
        startX: s.startX,
        startY: s.startY,
        ...(s.peer === undefined ? {} : { peer: s.peer }),
        // Which computer the host picked, and which AI plays it. Only a computer row has
        // either, and every client is told: the AI runs on the AUTHORITY, but the config is the
        // match's identity.
        ...(s.kind === "computer" ? { aiDifficulty: s.ai ?? MELEE_NORMAL, aiPlus: advanced.computerPlus } : {}),
        // Who is sitting there, for the loading screen's roster. Only a PERSON has one —
        // a computer row's `name` is the lobby's label for an empty seat, not a player.
        ...(s.kind === "player" && s.name ? { name: s.name } : {}),
      })),
    // The bench: who is watching, by peer, so every machine can seat them outside the slots.
    observers: setup.observers
      .filter((o) => o.kind === "player" && o.peer !== undefined)
      .map((o) => ({ peer: o.peer as number, name: o.name ?? "" })),
    advanced,
  };
}
