import type { MatchChannel } from "./matchLink";

/**
 * The LOADING handshake (issue #78) — who has finished loading, and waiting until everyone has.
 *
 * `Loading.fdf` has a green band per seat and `GlobalStrings.fdf` has "WAITING FOR OTHER
 * PLAYERS", because the reference's loading screen is a room the players arrive in one at a
 * time: your bar fills, your seat lights, and the game does not begin until the last one is in.
 * Nothing in the match's own traffic says that — a snapshot only starts once the host is
 * already simulating — so it is one message of its own.
 *
 * **It listens before the match exists.** A peer on a fast disk finishes while we are still
 * inside `loadMap`, which is one long synchronous call, and its message lands on whatever
 * `onPeerData` is installed at that moment — which is nothing, because the link is attached
 * after the map is up. So this is constructed FIRST, at the top of `startGame`, and it survives
 * the link being attached over it: `MatchLink`'s constructor chains onto the handler it finds
 * (`else previous(from, data)`), so ours stays in the chain and keeps catching readiness while
 * everything else flows on to the match. Nothing to buffer, nothing to restore.
 *
 * What it deliberately does NOT do is hold the SIMULATION. The world starts ticking when the
 * map scene starts, which is before this gate is ever consulted; the gate holds the loading
 * SCREEN. That is no worse than the previous behaviour — every client already began simulating
 * whenever it happened to finish — but it is not lockstep, and it is not a fix for drift.
 */
export interface ReadyMessage {
  k: "ready";
}

export function isReadyMessage(data: unknown): data is ReadyMessage {
  return typeof data === "object" && data !== null && (data as { k?: unknown }).k === "ready";
}

/**
 * How long we will wait for a machine that never reports in, before starting without it.
 *
 * OURS, not the game's: the reference sits on the loading screen indefinitely and offers to
 * drop the missing player, and we have no such dialog. A minute is longer than any load we
 * have measured (a campaign chapter on a cold cache is about a minute of *asset* streaming and
 * far less to this point) and short enough that a player whose opponent closed the tab is not
 * stuck staring at a full bar.
 */
export const LOAD_GATE_TIMEOUT_MS = 60_000;

export class LoadGate {
  /** The peers we have not heard from yet. Empty means everybody is in. */
  private readonly waitingOn = new Set<number>();
  /** …and the ones who HAVE, so a screen built after the first message still lights its seats:
   *  this gate is installed before the loading screen exists, which is the whole point of it. */
  private readonly reported = new Set<number>();
  private resolveAll: (() => void) | null = null;

  /** A peer reported in — fired once per peer, for the screen to light its seat. */
  onReady: (peer: number) => void = () => {};

  constructor(private readonly channel: MatchChannel, expect: readonly number[]) {
    for (const peer of expect) this.waitingOn.add(peer);
    const previous = channel.onPeerData;
    channel.onPeerData = (from, data) => {
      if (isReadyMessage(data)) { this.arrived(from); return; }
      previous(from, data);
    };
  }

  /** How many machines we are still waiting for. */
  get pending(): number { return this.waitingOn.size; }

  /** Everyone who has reported in so far — replay this into a screen that mounted late. */
  get readyPeers(): ReadonlySet<number> { return this.reported; }

  /** Tell the room we are in. Broadcast — everybody waits for everybody, host included. */
  announce(): void {
    this.channel.send({ k: "ready" } satisfies ReadyMessage);
  }

  /** Resolve once everyone has reported in; `false` if we gave up waiting instead. */
  waitForAll(timeoutMs = LOAD_GATE_TIMEOUT_MS): Promise<boolean> {
    if (!this.waitingOn.size) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveAll = null;
        console.warn(`[OpenWar3] starting without ${this.waitingOn.size} player(s) who never finished loading`);
        resolve(false);
      }, timeoutMs);
      this.resolveAll = () => { clearTimeout(timer); this.resolveAll = null; resolve(true); };
    });
  }

  private arrived(peer: number): void {
    this.reported.add(peer);
    // A second `ready` from the same peer — or one that lands after we stopped waiting — is
    // not news, and must not fire the seat light or the resolve twice.
    if (!this.waitingOn.delete(peer)) return;
    this.onReady(peer);
    if (!this.waitingOn.size) this.resolveAll?.();
  }
}
