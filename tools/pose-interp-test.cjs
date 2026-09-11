// Does a unit WALK SMOOTHLY on a client when the host sends 20 snapshots a second?
// (docs/multiplayer.md "Snapshot cadence" — src/game/poseInterp.ts)
//
// A headless A/B over a SIMULATED WIRE. A host runs the sim at a fixed 60 Hz inside frames whose
// wall-clock spacing wobbles (as a real render loop's does) and sends a payload whenever the
// cadence says so; each payload reaches the client after a latency with jitter, sometimes out of
// order; the client applies the newest one it holds at each of its own 60 Hz steps, exactly as
// `MatchLink.receive`/`latest` and `RtsController.tick` do. One unit walks at a constant 300.
//
// Measured per client step, against the ideal 5 units a step:
//   • CV    — the spread of the drawn step lengths (0 is a unit gliding at constant speed)
//   • held  — steps the unit did not visibly move while the host had it walking
//   • run   — the longest run of held steps (six flips the walk clip to a stand)
//   • flips — times the walk-clip gate (rts.ts MOVE_EMA_ALPHA 0.25 / MOVE_ANIM_MIN_RATIO 0.2)
//             would have dropped the walk for a stand mid-walk
//   • lag   — how far behind the host's truth the unit is drawn, in ms
//
// Three contestants: the glide rts.ts used to run (re-stated below, since it is gone from the
// source) at 60 Hz and at 20 Hz, and PoseInterpolator at 20 Hz. The table is printed so the
// numbers can be quoted; the checks pin what the change is FOR.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { PoseInterpolator } = require(join(REPO, ".sim-build", "src", "game", "poseInterp.js"));

let failed = 0;
function check(what, ok) {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
}

/** mulberry32 — a seeded RNG, so a run is the same run every time. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIM_DT = 1 / 60;
const SPEED = 300;

/** The glide rts.ts ran before PoseInterpolator (applySnapshot + tickPoseLerp), for one unit. */
class LegacyGlide {
  constructor(interval) {
    this.interval = interval;
    this.x = null;
    this.seg = null;
    this.t = 0;
    this.dur = interval;
    this.prevTime = Number.NaN;
  }
  apply(time, x) {
    const from = this.x;
    this.x = x; // the applier writes the payload's pose into the record…
    this.seg = from === null || from === x ? null : { x0: from, x1: x }; // …from where the frame DREW it
    const prev = Number.isNaN(this.prevTime) ? time : this.prevTime;
    this.dur = Math.min(Math.max(time - prev, this.interval), 4 * this.interval);
    this.t = 0;
    this.prevTime = time;
  }
  step(dt) {
    if (!this.seg) return;
    this.t += dt;
    const f = Math.min(1, this.t / this.dur);
    this.x = this.seg.x0 + (this.seg.x1 - this.seg.x0) * f;
    if (f >= 1) this.seg = null; // spent: hold at the payload's pose
  }
}

/** The new buffer, driven the way rts.ts drives it, for one unit. */
class Buffered {
  constructor(interval) {
    this.p = new PoseInterpolator(interval);
    this.out = { x: 0, y: 0, f: 0, h: 0, gliding: false };
    this.x = null;
  }
  apply(time, x) {
    this.p.arrive(time);
    this.p.push(1, time, x, 0, 0, 0);
    if (this.x === null) this.x = x;
  }
  step(dt) {
    this.p.advance(dt);
    if (this.p.sample(1, this.out)) this.x = this.out.x;
  }
}

function simulate({ interval, make, net, seconds = 60, seed = 7 }) {
  const R = rng(seed);
  // HOST: fixed steps inside uneven frames; `due` with the epsilon matchLink.ts uses.
  const payloads = [];
  let wall = 0;
  let simT = 0;
  let acc = 0;
  let sendAcc = 0;
  while (simT < seconds) {
    const frame = SIM_DT * (0.6 + 0.8 * R()); // a 60 fps host whose frames take 10–27 ms
    wall += frame;
    acc += frame;
    while (acc >= SIM_DT) {
      acc -= SIM_DT;
      simT += SIM_DT;
      sendAcc += SIM_DT;
      if (sendAcc >= interval - 1e-6) {
        sendAcc = 0;
        const spike = R() < net.spikeRate ? net.spike : 0;
        payloads.push({ t: simT, x: SPEED * simT, arrives: wall + net.latency + net.jitter * R() + spike });
      }
    }
  }
  payloads.sort((a, b) => a.arrives - b.arrives);

  // CLIENT: one step per 60 Hz frame; the newest payload held is applied once, stale ones dropped.
  const algo = make(interval);
  let next = 0;
  let newest = null;
  let applied = null;
  let prevX = null;
  let ema = 1;
  const steps = [];
  let lagSum = 0;
  let lagN = 0;
  let flips = 0;
  let walking = true;
  for (let i = 0; i * SIM_DT < seconds; i++) {
    const now = i * SIM_DT;
    while (next < payloads.length && payloads[next].arrives <= now) {
      const p = payloads[next++];
      if (!newest || p.t > newest.t) newest = p;
    }
    if (newest && newest !== applied) {
      algo.apply(newest.t, newest.x);
      applied = newest;
    }
    algo.step(SIM_DT);
    if (algo.x === null) continue;
    if (prevX !== null && now > 3 && now < seconds - 2) {
      const d = algo.x - prevX;
      steps.push(d);
      ema += (Math.min(d / (SPEED * SIM_DT), 1) - ema) * 0.25;
      const walks = ema >= 0.2;
      if (walking && !walks) flips++;
      walking = walks;
      lagSum += SPEED * now - algo.x;
      lagN++;
    }
    prevX = algo.x;
  }
  const ideal = SPEED * SIM_DT;
  const mean = steps.reduce((s, d) => s + d, 0) / steps.length;
  const sd = Math.sqrt(steps.reduce((s, d) => s + (d - mean) ** 2, 0) / steps.length);
  let held = 0;
  let run = 0;
  let worst = 0;
  for (const d of steps) {
    if (d < 0.2 * ideal) { held++; run++; worst = Math.max(worst, run); } else run = 0;
  }
  return { cv: sd / mean, held: held / steps.length, run: worst, flips, lag: (lagSum / lagN / SPEED) * 1000 };
}

const NETS = {
  lan: { name: "LAN", latency: 0.001, jitter: 0.002, spikeRate: 0, spike: 0 },
  eu: { name: "internet (EU relay)", latency: 0.045, jitter: 0.025, spikeRate: 0.01, spike: 0.15 },
  bad: { name: "bad wifi", latency: 0.08, jitter: 0.06, spikeRate: 0.03, spike: 0.25 },
};
const CONTESTANTS = [
  { name: "glide @ 60 Hz (before)", interval: 1 / 60, make: (i) => new LegacyGlide(i) },
  { name: "glide @ 20 Hz", interval: 1 / 20, make: (i) => new LegacyGlide(i) },
  { name: "buffer @ 20 Hz (after)", interval: 1 / 20, make: (i) => new Buffered(i) },
];

const results = {};
for (const [key, net] of Object.entries(NETS)) {
  console.log(`\n${net.name}: ${Math.round(net.latency * 1000)} ms + up to ${Math.round(net.jitter * 1000)} ms jitter, ${net.spikeRate * 100}% spikes of ${Math.round(net.spike * 1000)} ms`);
  console.log("  contestant                  CV     held    run  flips   lag ms");
  for (const c of CONTESTANTS) {
    const r = simulate({ interval: c.interval, make: c.make, net });
    results[`${key}/${c.name}`] = r;
    console.log(`  ${c.name.padEnd(26)} ${r.cv.toFixed(3).padStart(5)}  ${(r.held * 100).toFixed(1).padStart(5)}%  ${String(r.run).padStart(4)}  ${String(r.flips).padStart(5)}  ${r.lag.toFixed(0).padStart(6)}`);
  }
}

console.log("\nwhat the change is for");
for (const key of Object.keys(NETS)) {
  const before = results[`${key}/glide @ 20 Hz`];
  const after = results[`${key}/buffer @ 20 Hz (after)`];
  const sixty = results[`${key}/glide @ 60 Hz (before)`];
  check(`${NETS[key].name}: at 20 Hz the buffer walks steadier than the old glide (CV ${after.cv.toFixed(3)} < ${before.cv.toFixed(3)})`, after.cv < before.cv);
  check(`${NETS[key].name}: …and at least as steady as the old glide did at 60 Hz (CV ${after.cv.toFixed(3)} ≤ ${sixty.cv.toFixed(3)})`, after.cv <= sixty.cv + 1e-9);
  if (key !== "bad") {
    check(`${NETS[key].name}: the walk clip never drops to a stand mid-walk (${after.flips} flips)`, after.flips === 0);
  }
}
{
  // The other half of the claim: a unit that ARRIVES is drawn where it arrived, teleports jump.
  const p = new PoseInterpolator(1 / 20);
  const out = { x: 0, y: 0, f: 0, h: 0, gliding: false };
  p.arrive(1); p.push(1, 1, 0, 0, 0, 0);
  p.arrive(1.05); p.push(1, 1.05, 1000, 0, 0, 0); // a Blink
  for (let i = 0; i < 30; i++) p.advance(1 / 60);
  p.sample(1, out);
  check("a teleport is drawn at its destination, not smeared across the map", out.x === 1000);
  const q = new PoseInterpolator(1 / 20);
  q.arrive(1); q.push(1, 1, 0, 0, 3.1, 0);
  q.arrive(1.05); q.push(1, 1.05, 10, 0, -3.1, 0);
  q.advance(1 / 60);
  q.advance(1 / 60);
  q.sample(1, out);
  // Between 3.1 and -3.1 the short way is through π, never back through 0.
  check("a turn across the ±π seam takes the short way", Math.abs(Math.cos(out.f) - -1) < 0.01);
}

console.log(failed === 0 ? "\npose-interp: all checks passed" : `\npose-interp: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
