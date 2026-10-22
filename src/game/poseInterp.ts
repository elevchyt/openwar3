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
// One exception to the shared clock: a unit of OUR OWN starting to move from rest (`push`'s
// `eager`). Everything in the buffer between where such a unit is drawn and the payload that
// moved it is the same standing pose, so waiting the full delay for it buys nothing but latency —
// and it is the latency the player FEELS, the one between a click and the unit setting off. That
// unit is drawn on a clock of its own, started at its last standing sample (so it sets off on the
// next frame, from exactly where it stood) and run JUST IN TIME: fast enough to reach the newest
// pose when the next payload is due to land — the host's cadence says when (`lastDue`), the
// jitter margin says how late — and never faster than `1 - CLOCK_RATE` of real time, which is how
// it falls back onto the shared clock and leaves it. The payload that carries an order is
// EXPEDITED, off the cadence (matchLink.ts), so the next one is often only a few milliseconds of
// motion away and the unit sets off slowly; it is at full stride by the payload after. It is never
// drawn behind where the shared clock would have put it, so it is never later than before.
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

/** Below this two facings are the same (radians): a standing unit's facing is copied, not
 *  recomputed, so anything past float noise is a unit turning to set off. */
const SAME_FACING = 0.01;

/** One client sim step (seconds). */
const STEP = 1 / 60;

/** Within this of the shared clock an eager unit has rejoined it (seconds). */
const REJOINED = 0.002;

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
  /** Units drawn AHEAD of the shared clock, and the host time each is drawn at — see the file
   *  header's last paragraph. Always at or after `drawTime`, never after the unit's newest pose. */
  private readonly ahead = new Map<number, number>();
  /** The host time of the newest payload that came ON the cadence — an expedited one is off it —
   *  so the next is due one interval after this. */
  private lastDue = Number.NaN;
  /** `localNow` when the newest payload arrived. */
  private newestAt = 0;

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
    if (!(hostTime <= this.newest)) {
      this.newest = hostTime;
      this.newestAt = this.localNow;
    }
    // A payload a whole interval after the last one on the cadence is on it; anything sooner was
    // sent off it (an order's expedited answer, a rejoin's catch-up). The millisecond of slack is
    // the host's own epsilon (three 1/60 steps fall a whisker short of 1/20).
    if (!(hostTime - this.lastDue < this.interval - 1e-3)) this.lastDue = hostTime;
  }

  /**
   * One unit's pose in the payload `arrive` was just told about. `eager` says the unit is one
   * whose setting off the player is waiting to see — the caller passes it for the local
   * player's own units — and lets a start from rest skip the buffer (see the file header).
   */
  push(id: number, t: number, x: number, y: number, f: number, h: number, eager = false): void {
    let list = this.samples.get(id);
    if (!list) {
      list = [];
      this.samples.set(id, list);
    }
    const last = list[list.length - 1];
    if (last && t <= last.t) return; // an older payload's pose never rewrites a newer one
    if (eager && last && this.setsOff(id, list, x, y, f)) this.ahead.set(id, last.t);
    list.push({ t, x, y, f, h });
    if (list.length > HISTORY) list.shift();
  }

  /**
   * Is a pose at (x, y, f) this unit SETTING OFF: drawn standing now, standing in every sample
   * from here to its newest, and moved or turned in the new one? Only then is everything
   * between the shared clock and the new pose dead time. A unit already walking is drawn
   * somewhere along its path, and putting it ahead would jump it forward; a teleport is drawn
   * whole at its own sample either way.
   */
  private setsOff(id: number, list: readonly PoseSample[], x: number, y: number, f: number): boolean {
    if (this.ahead.has(id) || Number.isNaN(this.drawTime)) return false;
    const last = list[list.length - 1];
    if (last.t <= this.drawTime) return false; // already drawn at its newest pose: nothing to skip
    const dx = Math.abs(x - last.x);
    const dy = Math.abs(y - last.y);
    if (Math.hypot(dx, dy) > POSE_SNAP_DIST) return false;
    if (dx <= ARRIVED && dy <= ARRIVED && Math.abs(f - last.f) <= SAME_FACING) return false; // still standing
    let i = list.length - 1;
    while (i > 0 && standsWith(list[i - 1], last)) i--;
    return list[i].t <= this.drawTime;
  }

  /** Drop every unit `keep` says no — the ones the payload no longer carries (fog, death). */
  retain(keep: (id: number) => boolean): void {
    for (const id of this.samples.keys()) {
      if (keep(id)) continue;
      this.samples.delete(id);
      this.ahead.delete(id);
    }
  }

  /** Is this unit drawn ahead of the shared clock right now? For the test. */
  isAhead(id: number): boolean {
    return this.ahead.has(id);
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
    this.advanceAhead(dt);
  }

  /** Run every eager unit's own clock just in time for the next payload, capped a little short
   *  of real time, until the shared clock has caught up with it. */
  private advanceAhead(dt: number): void {
    if (this.ahead.size === 0) return;
    // Local seconds until the next payload should be here and the newest pose stops being the
    // last thing we know: the rest of the gap to the next payload on the cadence, plus the same
    // jitter margin the shared clock keeps, plus one client step — a payload is only SEEN at the
    // step after it lands, the reason `MIN_MARGIN` exists. Measured (tools/pose-interp-test.cjs):
    // without that step the unit stopped again for a frame after one order in four on the EU
    // wire; with it, as often as on the shared clock.
    const margin = this.delay - this.interval + STEP;
    const untilNext = Math.max(dt, this.lastDue + this.interval - this.newest + margin - (this.localNow - this.newestAt));
    for (const [id, at] of this.ahead) {
      const list = this.samples.get(id);
      const newest = list?.[list.length - 1]?.t;
      if (newest === undefined || Number.isNaN(this.drawTime)) {
        this.ahead.delete(id);
        continue;
      }
      const rate = Math.max(0, Math.min(1 - CLOCK_RATE, (newest - at) / untilNext));
      const next = Math.min(newest, at + dt * rate);
      if (next <= this.drawTime + REJOINED) this.ahead.delete(id);
      else this.ahead.set(id, next);
    }
  }

  /** Where to draw unit `id` now. False when it has no poses at all (nothing is written). */
  sample(id: number, out: PoseOut): boolean {
    const list = this.samples.get(id);
    if (!list || list.length === 0) return false;
    const t = this.ahead.get(id) ?? this.drawTime;
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

/** Two samples of a unit standing in one place, facing one way. */
function standsWith(a: PoseSample, b: PoseSample): boolean {
  return Math.abs(a.x - b.x) <= ARRIVED && Math.abs(a.y - b.y) <= ARRIVED && Math.abs(a.f - b.f) <= SAME_FACING;
}
