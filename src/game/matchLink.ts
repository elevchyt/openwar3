import { snapshotFor, type SnapshotViewer, type SnapshotWorld, type UnitSnapshot, type WorldSnapshot } from "./snapshot";
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
}

/** The `GameMessage` member carrying one recipient's view of the world. */
export interface SnapshotMessage {
  k: "snap";
  snap: WorldSnapshot;
}

export function isSnapshotMessage(data: unknown): data is SnapshotMessage {
  return typeof data === "object" && data !== null && (data as { k?: unknown }).k === "snap";
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
}

/** How often the host emits. 10 Hz, matching the fog rebuild — there is no point sending a
 *  view of the world more often than the fog that shapes it is recomputed. */
export const SNAPSHOT_INTERVAL = 0.1;

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
      const snap = snapshotFor(world, viewer, player, time, sources.ghostsFor(player));
      this.channel.send({ k: "snap", snap } satisfies SnapshotMessage, peer);
      sent++;
      this.emitted++;
    }
    // Cleared whether or not a seat was found for them: an unseated peer is a routing bug to
    // notice elsewhere, not a debt to keep re-paying every tick for the rest of the match.
    this.owed.clear();
    return sent;
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
   */
  compare(world: SnapshotWorld, viewer: SnapshotViewer, ghosts: UnitSnapshot[] = []): Divergence[] {
    const authority = this.newest;
    if (!authority) return [];
    const local = snapshotFor(world, viewer, this.localPlayer, authority.time, ghosts);
    this.lastFindings = divergence(authority, local);
    return this.lastFindings;
  }

  /** The last comparison's findings, already formatted. For a console line or an overlay. */
  describe(): string[] {
    return this.lastFindings.map(describeDivergence);
  }
}
