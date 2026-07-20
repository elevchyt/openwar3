import { snapshotFor, type SnapshotViewer, type SnapshotWorld, type UnitSnapshot, type WorldSnapshot } from "./snapshot";
import { divergence, describeDivergence, type Divergence } from "./divergence";

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

export class MatchLink {
  private accum = 0;
  /** The most recent snapshot this client was sent, or null on the host / before the first. */
  private newest: WorldSnapshot | null = null;
  /** Findings from the last comparison, for whoever wants to show them. */
  private lastFindings: Divergence[] = [];
  /** Snapshots dropped for arriving out of order. A rising count is itself a diagnostic. */
  stale = 0;

  constructor(
    private readonly channel: MatchChannel,
    /** This machine's own slot. A snapshot addressed to anybody else is a routing bug. */
    private readonly localPlayer: number,
    /** Seating, for peer→player. Empty on a client that only receives. */
    private readonly seats: readonly LinkSeat[] = [],
  ) {
    // The channel hands us everything that is not `start`; we take the snapshots and leave the
    // rest alone, so commands (item 9b) can share the same channel without a second seam.
    const previous = channel.onPeerData;
    channel.onPeerData = (from, data) => {
      if (isSnapshotMessage(data)) this.receive(data.snap);
      else previous(from, data);
    };
  }

  /** The peer sitting behind a player slot — the reverse of `CommandRouter`'s lookup, because
   *  the host ADDRESSES snapshots rather than judging them. */
  private peerFor(player: number): number | undefined {
    return this.seats.find((s) => s.id === player)?.peer;
  }

  /**
   * Host side: emit one snapshot per remote recipient, at most every `SNAPSHOT_INTERVAL`.
   *
   * The host's OWN seat is skipped: it is already looking at the authoritative world, and
   * sending it to itself through the relay would be a round trip to learn what it already
   * knows. A computer slot is skipped too — it has no peer and nothing to render.
   */
  tickHost(dt: number, world: SnapshotWorld, sources: HostSources, time: number): number {
    this.accum += dt;
    if (this.accum < SNAPSHOT_INTERVAL) return 0;
    this.accum = 0;
    let sent = 0;
    for (const { player, viewer } of sources.viewers()) {
      if (player === this.localPlayer) continue;
      const peer = this.peerFor(player);
      if (peer === undefined) continue; // a computer slot: nobody is watching
      const snap = snapshotFor(world, viewer, player, time, sources.ghostsFor(player));
      this.channel.send({ k: "snap", snap } satisfies SnapshotMessage, peer);
      sent++;
    }
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
  }

  /** The newest snapshot the authority sent this client, or null. */
  latest(): WorldSnapshot | null {
    return this.newest;
  }

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
