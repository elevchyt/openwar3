// Where a FROZEN CLIENT draws a unit between two snapshots (docs/multiplayer.md "Snapshot cadence").
//
// The host builds a snapshot every `SNAPSHOT_INTERVAL` of HOST time, but they do not ARRIVE that
// evenly: the host sends from inside its frame loop, so two can leave in one of its frames and
// none in the next, and the internet adds a spread of its own. The glide this replaced started a
// fresh segment from wherever the unit was drawn the instant a payload landed, and ran it over
// the host gap — so every early payload cut a segment short and SPED the unit up, and every late
// one spent its segment and STOPPED the unit until the next. At 60 Hz those were one-frame
// wobbles. At 20 Hz a stop is up to three sim steps and reads as a stutter, and six held steps in
// a row flip the walk clip to a stand (rts.ts `MOVE_EMA_ALPHA`/`MOVE_ANIM_MIN_RATIO`).
//
// So the client keeps a few poses per unit, stamped with HOST time, and draws them on a clock of
// its own that runs a small DELAY behind the newest host time it has heard — the standard
// snapshot-interpolation buffer. Between two samples the pose is a straight lerp, so a unit walks
// at its true speed however the payloads bunched; the clock is NUDGED toward its target, never
// jumped (a step's correction is capped at `CLOCK_RATE` of the step, so the drawn world never
// visibly speeds up or slows down); and the delay is one interval plus a margin sized off the
// jitter actually measured, so a LAN pays almost nothing and a bad connection buys itself
// headroom instead of stutter. tools/pose-interp-test.cjs measures all of this against the old
// glide over a simulated wire.
//
// Only POSES are delayed. Everything else in a payload (health, orders, the swing counter) is
// applied the moment it arrives, as before, which is what keeps a client's own orders as quick to
// answer as they were. `PoseOut.gliding` is how the clip picker squares the two: a unit still
// sliding the last of its walk is still walking, and its swing waits until it has arrived.
//
// Pure and DOM-free, so the headless test can drive it.

/** One unit's pose in one payload, at the host time the payload was built. */
interface PoseSample {
  t: number;
  x: number;
  y: number;
  f: number;
  h: number;
}

/** What `sample` writes. Reused by the caller, so drawing 600 units allocates nothing. */
export interface PoseOut {
  x: number;
  y: number;
  f: number;
  h: number;
  /** The drawn pose has not yet caught up with the newest one the host sent. */
  gliding: boolean;
}

/** Samples kept per unit: two bracket the draw time, and the rest ride out a late payload. */
const HISTORY = 4;

/** How far one snapshot interval may carry a unit before it is a teleport rather than a walk (a
 *  Blink, a Town Portal): drawn as a jump at the moment it happened, not smeared across the gap.
 *  No ground unit covers it in 0.2 s — the fastest move speed in the game is 522. */
export const POSE_SNAP_DIST = 400;

/** The least headroom the delay keeps over one interval, jitter or none: a little more than one
 *  60 Hz sim step. A payload is only SEEN at the client's next step, so even a perfect wire can
 *  land up to a step late, and a margin shorter than that step lets a payload that merely missed
 *  a step boundary hold every unit for a frame. */
const MIN_MARGIN = 0.02;

/** How quickly the jitter estimate follows what arrivals actually do, per arrival. */
const JITTER_ALPHA = 0.1;

/** The largest share of a step the draw clock may be corrected by. 5 %: a walking unit drawn
 *  5 % fast or slow for a moment is invisible, where a clock that closed its error at once would
 *  hitch every unit on the screen. */
const CLOCK_RATE = 0.05;

/** Past this much error the clock is simply SET: a rejoin's catch-up, a tab brought back to the
 *  front, a pause lifted — gaps nobody should watch the world fast-forward through. */
const CLOCK_SNAP = 0.25;

/** Below this the drawn pose counts as arrived (world units): a lerp that is a hair short of its
 *  sample is not a unit still walking. */
const ARRIVED = 0.5;

export class PoseInterpolator {
  private readonly samples = new Map<number, PoseSample[]>();
  /** The host time the frame is drawn at. NaN until the first payload. */
  private drawTime = Number.NaN;
  /** The newest host time any payload has carried. */
  private newest = Number.NaN;
  /** This client's own clock, advanced by the steps it runs. */
  private localNow = 0;
  private lastLocal = Number.NaN;
  private lastHost = Number.NaN;
  private jitterEma = 0;

  constructor(
    /** The host's cadence — the spacing the arrivals SHOULD have. */
    private readonly interval: number,
  ) {}

  /** How far behind the newest host time the world is drawn: one interval, so there are two
   *  samples to draw between, plus room for the jitter measured so far — at most one more
   *  interval, and never less than `MIN_MARGIN`. */
  get delay(): number {
    return this.interval + Math.min(this.interval, Math.max(MIN_MARGIN, 2.5 * this.jitterEma));
  }

  /** The measured arrival jitter, in seconds — for the dev heartbeat and the test. */
  get jitter(): number {
    return this.jitterEma;
  }

  /**
   * A payload built at `hostTime` was applied this step. Measures how far its arrival strayed
   * from the host's own spacing. Only gaps up to four intervals count: a longer one is a stall or
   * a rejoin, not jitter, and letting it in would inflate the delay for a long time afterwards.
   */
  arrive(hostTime: number): void {
    if (!Number.isNaN(this.lastHost)) {
      const gap = hostTime - this.lastHost;
      if (gap > 0 && gap <= 4 * this.interval) {
        const err = Math.abs(this.localNow - this.lastLocal - gap);
        this.jitterEma += (err - this.jitterEma) * JITTER_ALPHA;
      }
    }
    this.lastLocal = this.localNow;
    this.lastHost = hostTime;
    if (!(hostTime <= this.newest)) this.newest = hostTime;
  }

  /** One unit's pose in the payload `arrive` was just told about. */
  push(id: number, t: number, x: number, y: number, f: number, h: number): void {
    let list = this.samples.get(id);
    if (!list) {
      list = [];
      this.samples.set(id, list);
    }
    const last = list[list.length - 1];
    if (last && t <= last.t) return; // an older payload's pose never rewrites a newer one
    list.push({ t, x, y, f, h });
    if (list.length > HISTORY) list.shift();
  }

  /** Drop every unit `keep` says no — the ones the payload no longer carries (fog, death). */
  retain(keep: (id: number) => boolean): void {
    for (const id of this.samples.keys()) if (!keep(id)) this.samples.delete(id);
  }

  /** Advance the draw clock by one step of `dt` seconds. */
  advance(dt: number): void {
    this.localNow += dt;
    if (Number.isNaN(this.newest)) return;
    const target = this.newest - this.delay;
    if (Number.isNaN(this.drawTime) || Math.abs(target - this.drawTime) > CLOCK_SNAP) {
      this.drawTime = target;
      return;
    }
    const cap = CLOCK_RATE * dt;
    this.drawTime += dt + Math.max(-cap, Math.min(cap, target - this.drawTime));
    // Never draw past what the host has said: a payload that is later than even the delay HOLDS
    // units where the host last put them. Never extrapolate — a guess the next payload
    // contradicts is a unit that visibly backs up.
    if (this.drawTime > this.newest) this.drawTime = this.newest;
  }

  /** Where to draw unit `id` now. False when it has no poses at all (nothing is written). */
  sample(id: number, out: PoseOut): boolean {
    const list = this.samples.get(id);
    if (!list || list.length === 0) return false;
    const t = this.drawTime;
    const last = list[list.length - 1];
    let a = last;
    let b = last;
    if (!Number.isNaN(t) && t < last.t) {
      a = b = list[0];
      for (let i = 1; i < list.length; i++) {
        if (list[i].t > t) {
          if (list[i - 1].t <= t) { a = list[i - 1]; b = list[i]; }
          break;
        }
      }
    }
    let k = a === b ? 0 : (t - a.t) / (b.t - a.t);
    // A teleport happens AT its sample, whole — never as a streak across the map.
    const jump = a !== b && Math.hypot(b.x - a.x, b.y - a.y) > POSE_SNAP_DIST;
    if (jump) k = 0;
    out.x = a.x + (b.x - a.x) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.h = a.h + (b.h - a.h) * k;
    // Shortest arc, so a unit crossing the ±π seam turns a few degrees rather than a lap.
    let df = (b.f - a.f) % (2 * Math.PI);
    if (df > Math.PI) df -= 2 * Math.PI;
    else if (df < -Math.PI) df += 2 * Math.PI;
    out.f = a.f + df * k;
    // …and a unit waiting out a teleport is not walking anywhere.
    out.gliding = !jump && (Math.abs(last.x - out.x) > ARRIVED || Math.abs(last.y - out.y) > ARRIVED);
    return true;
  }
}
