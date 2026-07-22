import { snapshotFor, type FxSnapshot, type SnapshotViewer, type SnapshotWorld, type UnitSnapshot, type WorldSnapshot } from "./snapshot";
import { divergence, describeDivergence, type Divergence } from "./divergence";
import { commandMessage, isCommandMessage, type CommandMessage } from "../net/commandLink";
import type { Command } from "./commands";

/**
 * The match's end of the wire (docs/multiplayer.md Phase E item 10b).
 *
 * Everything before this was a rule with no caller: `snapshotFor` (5), the AoI split (6),
 * `GhostMemory` (6b/6c), `CommandRouter` (9), `divergence` (10a). This is what makes them all
 * run — the host builds one snapshot per recipient on a cadence and sends it; a client keeps
 * the latest and diffs it against what it simulated for itself.
 *
 * **The channel is a two-method structural type, not `LanLobby`.** `LanLobby` lives in
 * `src/net/` and is constructed in `src/ui/fdfLan.ts`; if the game layer imported it, the
 * authority would depend on the lobby UI and the whole Phase B/C/D separation would be undone
 * from the other end. `LanLobby` satisfies `MatchChannel` structurally already — `send(data,
 * to?)` and `onPeerData` exist on it and are exactly these two members — so the hand-off costs
 * an assignment and no new API.
 *
 * ## Sequencing B, and what this deliberately does NOT do
 *
 * The developer chose **B**: the client renders snapshots AND keeps simulating, so the two can
 * be compared. So a received snapshot is stored and diffed, and **nothing here changes what is
 * drawn** — that is item 10c. Until then this is a pure diagnostic, and that is the point: it
 * tells us where the authority and a client disagree before anything depends on them agreeing.
 *
 * It also does not send commands (item 9b). `CommandRouter` is item 9's and is wired on the
 * host by whoever owns `Authority`; a host receiving commands nobody sends would be dead code.
 */

/** What the match needs from a transport, and nothing more. `LanLobby` satisfies it. */
export interface MatchChannel {
  /** Opaque game traffic. `to` omitted = everyone else in the room. */
  send(data: unknown, to?: number): void;
  /** Non-`start` game traffic, stamped by the relay with who really sent it. */
  onPeerData: (from: number, data: unknown) => void;
  /**
   * A dropped peer reclaimed its slot (`peer-rejoin`, protocol 3 — item 11a).
   *
   * This is the one piece of ROSTER news the match needs, and it is required rather than
   * optional on purpose: a channel that quietly lacked it would leave a reconnected player
   * staring at a world frozen at the moment their wifi blinked, and nothing would say so.
   * The relay reclaims the SAME peer id (that is why 11a minted it that way), so the seating
   * the match was handed at `StartMatch` still resolves — no re-seating, no new id to learn.
   */
  onPeerRejoin: (peer: number) => void;
  /**
   * The room is gone, so the match is over (item F6).
   *
   * Required, for the same reason `onPeerRejoin` is: v1 has no host migration, so a host
   * leaving ends the game for everyone — and the only evidence a client gets is this message.
   * A channel that quietly lacked it would leave that client simulating alone against a wire
   * that will never speak again, with nothing on screen to say why.
   */
  onRoomClosed: (reason: string) => void;
  /**
   * End the wire — the match is over.
   *
   * Optional because a channel that outlives nothing (a test fake, a loopback pair) has nothing
   * to close. It exists because the match, not the menu, owns the transport once the link is
   * assembled: the LAN screen is disposed the moment `startGame` runs, and a screen tearing
   * down its own socket used to take the game's wire with it (item F4). `LanLobby.close()`
   * matches this member already, so the hand-off still costs an assignment and no new API.
   */
  close?(): void;
}

/**
 * A dialog the AUTHORITY's script raised for one recipient (docs/multiplayer.md Phase F item 7).
 *
 * The melee victory/defeat screen is a plain JASS `dialog` (see ui/gameDialog.ts), and on a
 * client its own script will never raise one: blizzard.j's defeat check runs off UNIT DEATH
 * events in the world the script can see, and a client's world never receives the host's
 * commands — so the army that razed its hall never moved there, the hall never died locally,
 * and the loser was simply never told. Observed exactly that way: the client watched its base
 * turn to rubble (the snapshot got that right) and went on playing.
 *
 * So the outcome crosses the wire. It is not state — it is a decision the authority made, and
 * the one piece of presentation whose absence means the match never ends for somebody.
 *
 * ONE WAY, deliberately. The two behaviours a dialog button has are the engine's and both are
 * local (any click closes it; a quit button leaves the match), so a relayed dialog needs no
 * click sent back and the client's own UI answers its own buttons.
 */
export interface DialogMessage {
  k: "dlg";
  message: string;
  buttons: { text: string; quit: boolean }[];
  /**
   * This dialog is the END of that player's game, not just something their script wants shown.
   *
   * The recipient closes its own wire on it (Phase G item 1), so it has to be the AUTHORITY
   * that says so rather than the client guessing from the fact that a dialog arrived — a map
   * raising a quest popup for a remote player would otherwise drop that player off the wire
   * mid-match. The host knows because it saw `RemovePlayer` for that seat.
   */
  over?: boolean;
}

export function isDialogMessage(data: unknown): data is DialogMessage {
  return typeof data === "object" && data !== null && (data as { k?: unknown }).k === "dlg";
}

/** The `GameMessage` member carrying one recipient's view of the world. */
export interface SnapshotMessage {
  k: "snap";
  snap: WorldSnapshot;
}

export function isSnapshotMessage(data: unknown): data is SnapshotMessage {
  return typeof data === "object" && data !== null && (data as { k?: unknown }).k === "snap";
}

/**
 * The authority REFUSED one of this client's commands (docs/multiplayer.md item 9c).
 *
 * Without this a host-side refusal was silent theater on the client: its optimistic local
 * apply showed the action starting, the next payload erased it, and nothing ever said why —
 * "training instantly canceled" with no voice. `key` is a `commandstrings.txt [Errors]` key
 * (the host re-derives the coarse cause — gold, lumber, food); an empty key still elicits the
 * interface error beep, because the feedback that the click was seen and rejected must not
 * depend on the host knowing a sentence for it.
 */
export interface RefusalMessage {
  k: "ref";
  key: string;
}

export function isRefusalMessage(data: unknown): data is RefusalMessage {
  return typeof data === "object" && data !== null && (data as { k?: unknown }).k === "ref";
}

/** One seated slot: the player number and, for a human, the relay peer sitting in it. Same
 *  shape `CommandRouter` takes, and for the same reason — it comes straight off `StartMatch`. */
export interface LinkSeat {
  id: number;
  peer?: number;
}

/** What the host must be able to answer per recipient. Injected rather than reached for, so
 *  this module needs neither `VisionSet` nor `GhostMemory` in its import closure and a test can
 *  pass two closures. Same shape as `teamOf` in item 1c. */
export interface HostSources {
  /** Every player the host is answering for, and the eyes to answer with. */
  viewers(): Iterable<{ player: number; viewer: SnapshotViewer }>;
  /** Buildings this recipient still believes are standing (`GhostMemory.ghostsFor`). */
  ghostsFor(player: number): UnitSnapshot[];
  /** `Authority.applied` — how many commands this world has taken. Stamped into every
   *  snapshot so a client can tell whether diffing it against its own sim means anything
   *  (docs/multiplayer.md Phase F item 5). Injected like the rest, so this module still needs
   *  neither `Authority` nor a `SimWorld` in its import closure. */
  commandsApplied(): number;
  /** This recipient's creep-camp minimap markers (`RtsController.creepCamps(viewpoint)`).
   *  Optional so a test's two-closure stub keeps compiling; absent reads as no camps. */
  creepCampsFor?(player: number): Array<{ x: number; y: number; level: number }>;
  /** The spell/ability presentation events the host's sim queued since the last ask —
   *  drained EVERY tick (they are gone from the sim's queues once its own renderer runs)
   *  and buffered here until the next due broadcast flushes them per recipient. Optional
   *  for the same stub reason; absent reads as a match with no spells. */
  drainFx?(): FxSnapshot;
}

/** How often the host emits. 20 Hz — twice the 10 Hz fog rebuild, deliberately: what a
 *  client SEES changes at the fog's rate, but where things ARE changes every sim tick, and
 *  the cadence is half of a client's order-to-motion latency (the other half being the one
 *  payload gap the pose interpolation trails by). At 10 Hz an order answered in up to
 *  100 ms of cadence plus a 100 ms glide read as lag in the July playtest; 20 Hz halves
 *  both. Every other payload just carries fresher poses over the same visibility. */
export const SNAPSHOT_INTERVAL = 0.05;

/**
 * Everything the match needs to join the wire, assembled where the lobby still exists.
 *
 * The LAN screen is the only place that knows all four of these at once, and it stops existing
 * the moment the match starts (`glue.dispose()`), so they are handed over rather than looked up
 * later. `localPlayer` is the SLOT, not the relay peer: the two are different numbering and
 * conflating them is how a client ends up filtering snapshots addressed to it.
 */
export interface MatchLinkSetup {
  channel: MatchChannel;
  /** This machine's player slot — `slots.find(s => s.peer === myPeerId).id`. */
  localPlayer: number;
  seats: LinkSeat[];
  /** Only the host pumps. Everybody, host included, may receive. */
  isHost: boolean;
  /** The relay peer holding the authoritative sim — where a client SENDS its commands
   *  (item 9b). A client aims at the host specifically rather than broadcasting, because the
   *  model is authoritative-host, not lockstep: only the host applies a command, and every
   *  other client learns the result from its snapshot, not from the command itself. */
  hostPeer: number;
}

/**
 * Assemble a `MatchLinkSetup` from a room's seating (docs/multiplayer.md item 10b-note).
 *
 * The ONE piece of link wiring that must be identical in production and in any test harness —
 * so it lives here, once, and both `fdfLan` and the dev-LAN boot call it rather than each
 * writing the peer→slot resolution out. Getting that resolution wrong is how a client filters
 * out the very snapshots addressed to it, and a harness that assembled the link differently
 * from production would prove the wrong thing.
 *
 * `myPeer` is the RELAY peer id; the local slot is the seat that peer sits in. The fallback to
 * `myPeer ?? 0` only fires for a seating that names no peer for us, which a real `StartMatch`
 * never produces — it is there so a malformed room degrades to a single-player-shaped answer
 * instead of `undefined`.
 *
 * `hostPeer` is the relay peer of whoever holds the authoritative sim — the room creator. The
 * caller passes it because the seating (`StartMatch.slots`) records a peer per SLOT but does
 * not mark which is the host; the lobby's peer list does (`peers.find(p => p.host)`).
 */
export function matchLinkFrom(
  channel: MatchChannel,
  isHost: boolean,
  slots: ReadonlyArray<{ id: number; peer?: number }>,
  myPeer: number | undefined,
  hostPeer: number,
): MatchLinkSetup {
  return {
    channel,
    localPlayer: slots.find((s) => s.peer === myPeer)?.id ?? myPeer ?? 0,
    seats: slots.map((s) => ({ id: s.id, peer: s.peer })),
    isHost,
    hostPeer,
  };
}

export class MatchLink {
  private accum = 0;
  /** The most recent snapshot this client was sent, or null on the host / before the first. */
  private newest: WorldSnapshot | null = null;
  /** Findings from the last comparison, for whoever wants to show them. */
  private lastFindings: Divergence[] = [];
  /** Snapshots dropped for arriving out of order. A rising count is itself a diagnostic. */
  stale = 0;
  /** Snapshots accepted (newer than what we held). On a client this rising is proof the pipe
   *  is alive; staying at 0 while in a match is proof it is not. */
  received = 0;

  /**
   * A command arrived from a client (host side only). The controller wires this to
   * `CommandRouter` + `Authority.execute` — the identity check stays out here, in `MatchLink`,
   * so this module keeps neither `Authority` nor the command vocabulary in its import closure
   * beyond the wire envelope. Default no-op: a client sets nothing and receives nothing.
   */
  onCommand: (from: number, cmd: CommandMessage) => void = () => {};

  /**
   * The authority raised a dialog for us (client side only) — in v1 that is the melee
   * victory/defeat screen. Default no-op: the host raises its own and never receives one.
   */
  onDialog: (msg: DialogMessage) => void = () => {};

  /** The authority refused one of our commands (client side only). Default no-op. */
  onRefusal: (msg: RefusalMessage) => void = () => {};

  /** Host side: tell a peer its command was refused, and with which `[Errors]` voice. */
  sendRefusal(peer: number, key: string): void {
    this.channel.send({ k: "ref", key } satisfies RefusalMessage, peer);
  }

  /**
   * Host side: hand a recipient a dialog its own script will never raise.
   *
   * Addressed to that player's peer, never broadcast — a defeat belongs to one person, and a
   * room-wide "You failed to achieve victory." would be the funniest possible desync. A player
   * with no peer (a computer slot, or the host itself) is skipped: the host's own script
   * already showed it, and nobody is watching an AI's screen.
   */
  sendDialog(player: number, msg: DialogMessage): boolean {
    if (player === this.localPlayer) return false; // our own script raised it; we are looking at it
    const peer = this.peerFor(player);
    if (peer === undefined) return false;
    this.channel.send(msg, peer);
    return true;
  }

  constructor(
    private readonly channel: MatchChannel,
    /** This machine's own slot. A snapshot addressed to anybody else is a routing bug. */
    private readonly localPlayer: number,
    /** Seating, for peer→player. Empty on a client that only receives. */
    private readonly seats: readonly LinkSeat[] = [],
    /** The authoritative sim's relay peer — where `sendCommand` aims. */
    private readonly hostPeer: number = 0,
  ) {
    // The channel hands us everything that is not `start`; we demux the two kinds of game
    // traffic — snapshots the host emits, commands a client sends — and pass anything else
    // through, so a future message type does not have to touch this seam.
    const previous = channel.onPeerData;
    channel.onPeerData = (from, data) => {
      if (isSnapshotMessage(data)) this.receive(data.snap);
      else if (isCommandMessage(data)) this.onCommand(from, data);
      else if (isDialogMessage(data)) this.onDialog(data);
      else if (isRefusalMessage(data)) this.onRefusal(data);
      else previous(from, data);
    };
    // A returning peer is owed the world it missed, and owed it NOW rather than whenever the
    // cadence next comes round (item 11b). Subscribed here, the same way as `onPeerData`, so
    // the catch-up cannot be forgotten by whoever assembles the link.
    const previousRejoin = channel.onPeerRejoin;
    channel.onPeerRejoin = (peer) => {
      this.owed.add(peer);
      previousRejoin(peer);
    };
  }

  /**
   * Peers that came back and have not yet been caught up.
   *
   * A set rather than a flag: two players can reconnect in the same tick, and serving only the
   * last one to arrive is the kind of bug that shows up once in fifty matches. Only the host
   * ever drains it (`tickHost`); on a client it stays empty in practice — a client is told
   * about a rejoin too, but it is bounded by the room size and nothing reads it.
   */
  private readonly owed = new Set<number>();

  /**
   * Client side: send one of the local player's commands to the host's authoritative sim.
   *
   * Aimed at `hostPeer`, not broadcast: this is authoritative-host, so only the host applies
   * it, and every other client sees the effect through its snapshot rather than by replaying
   * the command. Broadcasting would instead make every client apply every command — lockstep,
   * a different design with a different desync surface.
   */
  sendCommand(cmd: Command): void {
    this.channel.send(commandMessage(cmd), this.hostPeer);
  }

  /** The peer sitting behind a player slot — the reverse of `CommandRouter`'s lookup, because
   *  the host ADDRESSES snapshots rather than judging them. */
  private peerFor(player: number): number | undefined {
    return this.seats.find((s) => s.id === player)?.peer;
  }

  /**
   * Host side: emit one snapshot per remote recipient, at most every `SNAPSHOT_INTERVAL` —
   * plus, off that cadence, an immediate one to anybody who has just reconnected (item 11b).
   *
   * The host's OWN seat is skipped: it is already looking at the authoritative world, and
   * sending it to itself through the relay would be a round trip to learn what it already
   * knows. A computer slot is skipped too — it has no peer and nothing to render.
   *
   * **The cadence gate belongs to the BROADCAST, not to the catch-up**, which is the whole of
   * this method's shape. A reconnected player is holding a world that stopped when their
   * connection did; making them wait out a tick they have no stake in is the same delay the
   * relay just worked to avoid. So `due` gates the everyone-loop and `owed` cuts across it,
   * and a catch-up neither resets the cadence clock nor postpones the next broadcast.
   *
   * **"A FULL snapshot" costs nothing extra today, and the wording is a promise for later.**
   * `snapshotFor` builds the whole recipient-visible world every time — there are no deltas —
   * so the catch-up is the same call the broadcast makes. The day a delta encoding arrives
   * (Open questions: "JSON first, binary when it hurts"), this is the one send site that must
   * stay whole, because a delta against a world the recipient never received is noise.
   */
  tickHost(dt: number, world: SnapshotWorld, sources: HostSources, time: number): number {
    // Presentation events are drained EVERY tick — the sim's own queues empty when the
    // host's renderer runs — and buffered until a due broadcast flushes them. Capped so a
    // spell-storm during a long between-sends stall cannot grow the buffer without bound.
    const fx = sources.drainFx?.();
    if (fx) {
      this.fxBuf.effects.push(...fx.effects);
      this.fxBuf.splats.push(...fx.splats);
      this.fxBuf.castStarts.push(...fx.castStarts);
      this.fxBuf.castFires.push(...fx.castFires);
      if (this.fxBuf.effects.length > 512) this.fxBuf.effects.splice(0, this.fxBuf.effects.length - 512);
    }
    this.accum += dt;
    const due = this.accum >= SNAPSHOT_INTERVAL;
    if (due) this.accum = 0;
    if (!due && this.owed.size === 0) return 0;
    let sent = 0;
    for (const { player, viewer } of sources.viewers()) {
      if (player === this.localPlayer) continue;
      const peer = this.peerFor(player);
      if (peer === undefined) continue; // a computer slot: nobody is watching
      if (!due && !this.owed.has(peer)) continue; // off-cadence: only the returning peers
      const snap = snapshotFor(world, viewer, player, time, sources.ghostsFor(player), sources.commandsApplied(), sources.creepCampsFor?.(player) ?? []);
      // Fx ride DUE broadcasts only: an expedited or rejoin catch-up send would otherwise
      // replay the same burst again at the next cadence. Filtered per recipient by
      // eyes-on-the-spot — the same "in your eyes or absent" rule items and missiles use.
      if (due) {
        snap.fx = {
          effects: this.fxBuf.effects.filter((e) => !viewer.fogBlocksAt(e)),
          splats: this.fxBuf.splats.filter((e) => !viewer.fogBlocksAt(e)),
          castStarts: this.fxBuf.castStarts.filter((e) => !viewer.fogBlocksAt(e)),
          castFires: this.fxBuf.castFires.filter((e) => !viewer.fogBlocksAt(e)),
        };
      }
      this.channel.send({ k: "snap", snap } satisfies SnapshotMessage, peer);
      sent++;
      this.emitted++;
    }
    if (due) this.fxBuf = { effects: [], splats: [], castStarts: [], castFires: [] };
    // Cleared whether or not a seat was found for them: an unseated peer is a routing bug to
    // notice elsewhere, not a debt to keep re-paying every tick for the rest of the match.
    this.owed.clear();
    return sent;
  }

  private fxBuf: FxSnapshot = { effects: [], splats: [], castStarts: [], castFires: [] };

  /**
   * A command from this peer was just applied — owe it a snapshot NOW rather than at the
   * cadence (docs/multiplayer.md item 9d). The cadence is half of a client's order-to-motion
   * latency; expediting the one payload that carries the command's first consequences cuts
   * that half to a single sim tick. Reuses the rejoin catch-up mechanism (`owed`), and pays
   * the same way: once, off-cadence, without disturbing the broadcast clock.
   */
  expedite(peer: number): void {
    this.owed.add(peer);
  }

  /**
   * Client side: take delivery.
   *
   * Two things are refused rather than rendered. A snapshot addressed to somebody else is a
   * routing bug, and `WorldSnapshot.recipient` is carried in the payload (item 5) precisely so
   * it can be NOTICED instead of quietly drawn as if it were ours. And one older than what we
   * already hold is dropped — over a relay, "arrived later" and "happened later" are different
   * claims, and rendering an older world would jerk every unit backwards.
   */
  private receive(snap: WorldSnapshot): void {
    if (snap.recipient !== this.localPlayer) return;
    if (this.newest && snap.time <= this.newest.time) {
      this.stale++;
      return;
    }
    this.newest = snap;
    this.received++;
  }

  /** The newest snapshot the authority sent this client, or null. */
  latest(): WorldSnapshot | null {
    return this.newest;
  }

  /** How many snapshots this host has emitted this match — the send-side counterpart to
   *  `received`, so a dev heartbeat can show both ends of the pipe. */
  get sent(): number {
    return this.emitted;
  }
  private emitted = 0;

  /**
   * Compare the newest snapshot against what this client simulated for itself, and report.
   *
   * The local world goes through the same `snapshotFor`, with the same viewer and recipient —
   * see `divergence`'s header for why anything else reports the redaction as drift. Returns an
   * empty array when there is nothing to compare yet, which is every tick on the host.
   *
   * **It only means anything while NEITHER world has taken a command** (docs/multiplayer.md
   * Phase F item 5). Sequencing B keeps a client simulating alongside the authority, but that
   * local sim is an uncorrected prediction fed only its OWN input: it applies this player's
   * commands the instant they are issued, the authority applies them a round trip later, and
   * it never hears about anybody else's at all. So the moment a command lands on either side
   * the two are running different matches, and every difference between them is explained by
   * that rather than by a bug. Reporting it anyway is a false positive per moving unit per
   * tick — measured live, an ordinary move order took the log from silent to 13 findings a
   * tick, none of which anyone could have acted on.
   *
   * The window that remains is the valuable one and is not a consolation prize: match start,
   * before any input, is exactly where a seeding, RNG, map-script or unit-placement desync
   * shows itself — and those are real bugs this catches, in the only window it ever could.
   * When the input streams part, it says so once and goes quiet.
   */
  compare(
    world: SnapshotWorld,
    viewer: SnapshotViewer,
    ghosts: UnitSnapshot[] = [],
    /** `Authority.applied` on THIS machine — our half of the input-parity question. */
    localCommands = 0,
  ): Divergence[] {
    const authority = this.newest;
    if (!authority) return [];
    if (authority.commands !== 0 || localCommands !== 0) {
      this.inputsParted = true;
      this.lastFindings = [];
      return this.lastFindings;
    }
    const local = snapshotFor(world, viewer, this.localPlayer, authority.time, ghosts, localCommands);
    this.lastFindings = divergence(authority, local);
    return this.lastFindings;
  }

  /**
   * Has a command been applied on either side, so that the comparison has stopped?
   *
   * Read by the caller to say so ONCE in the console. A detector that simply went silent would
   * be indistinguishable from a detector that was finding nothing, which is the more
   * comfortable of the two readings and the wrong one.
   */
  get comparisonStopped(): boolean {
    return this.inputsParted;
  }
  private inputsParted = false;

  /**
   * The match is over: end the wire (docs/multiplayer.md Phase G item 1).
   *
   * The developer's rule, and it matches WC3: once the victory/defeat screen is up the game is
   * officially decided, so every machine keeping its own private idea of the world from then on
   * costs nothing. What it BUYS is that a finished match stops paying — no snapshots for a game
   * nobody is playing, and the room frees up instead of lingering until somebody clicks away.
   */
  endMatch(): void {
    this.channel.close?.();
  }

  /** The last comparison's findings, already formatted. For a console line or an overlay. */
  describe(): string[] {
    return this.lastFindings.map(describeDivergence);
  }
}
