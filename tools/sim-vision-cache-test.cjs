// The shared sight-footprint cache (sim/vision.ts SightStamps) — correctness first, then what
// it is worth. See docs/perf-logging.md for the session that prompted it: in an eight-player
// Feralas LV match `sim.fog` was 2.49 ms of a 14 ms frame, the largest sub-phase of the sim
// after the world step, and all of it is `revealLineOfSight` casting the same rays over again.
//
// The correctness bar is absolute and is why this test exists at all: a cached rebuild and an
// uncast one must be the SAME GRID, cell for cell, including after trees come down. Fog gates
// what the AI knows and what a client is allowed to see, so a footprint that is even slightly
// wrong is a desync and a cheat at once.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const { VisionMap, SightStamps, VISION_CELL } = require(join(REPO, ".sim-build", "src", "sim", "vision.js"));

// A Feralas-LV-shaped map: 192 terrain cells square, so 384 vision cells square.
const SPAN = 192 * 128;
const ORIGIN = -SPAN / 2;
// Terrain with real cliffs in it — line of sight that never shadows anything would make the
// cache look better than it is, because the ray walk would light every cell it touches.
const heightAt = (wx, wy) => {
  const a = Math.sin(wx / 1700) + Math.cos(wy / 2300);
  const b = Math.sin((wx + wy) / 3100);
  return Math.round((a + b) * 1.4) * 128; // whole cliff layers, 0..±384
};

/** Deterministic pseudo-random, so both arms see exactly the same world. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function newMap(stamps) {
  const m = new VisionMap(ORIGIN, ORIGIN, SPAN, SPAN);
  if (stamps) m.setSightStamps(stamps);
  m.setHeightField(heightAt);
  const r = rng(99);
  for (let i = 0; i < 4000; i++) {
    m.addTreeBlocker(ORIGIN + r() * SPAN, ORIGIN + r() * SPAN, VISION_CELL / 2);
  }
  return m;
}

// The field, shaped like the session that prompted this: 366 units, of which about a sixth are
// moving at any moment (the log's `moving` against `units`) — the rest are buildings and units
// standing still, and THEY are where a footprint cache earns its keep.
const UNITS = 366;
const MOVING = 63;
const VIEWPOINTS = 9; // eight seats and an observer
const ROUNDS = 40;

function makeUnits() {
  const r = rng(7);
  return Array.from({ length: UNITS }, (_, id) => ({
    id,
    x: ORIGIN + 0.1 * SPAN + r() * 0.8 * SPAN,
    y: ORIGIN + 0.1 * SPAN + r() * 0.8 * SPAN,
    // Sight radii off the real tables' range: a footman is 1400 by day, a town hall 1800.
    sight: [1400, 1600, 1800, 1000][id % 4],
    vx: (r() - 0.5) * 2,
    vy: (r() - 0.5) * 2,
  }));
}

/** One 10 Hz round: every viewpoint clears and re-stamps every unit. */
function round(maps, units, withIds) {
  for (const m of maps) {
    m.beginFrame();
    for (const u of units) m.reveal(u.x, u.y, u.sight, false, withIds ? u.id : undefined);
  }
}

/** Advance the sixth of the field that is moving, at about a footman's speed for 100 ms. */
function step(units) {
  for (let i = 0; i < MOVING; i++) {
    const u = units[i];
    u.x += u.vx * 27;
    u.y += u.vy * 27;
  }
}

/** The whole observable grid of one viewpoint, as the fog reports it. */
function grid(m) {
  const out = new Uint8Array(m.width * m.height);
  for (let cy = 0; cy < m.height; cy++) {
    for (let cx = 0; cx < m.width; cx++) out[cy * m.width + cx] = m.cellState(cx, cy);
  }
  return out;
}

function same(a, b) {
  if (a.length !== b.length) return -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

console.log("a cached rebuild is the same grid as an uncast one, round after round");
{
  const stamps = new SightStamps();
  const cached = [newMap(stamps), newMap(stamps), newMap(stamps)];
  const plain = [newMap(null), newMap(null), newMap(null)];
  const a = makeUnits();
  const b = makeUnits();
  let firstBad = -1;
  let rounds = 0;
  for (let i = 0; i < 12; i++) {
    round(cached, a, true);
    round(plain, b, false);
    for (let v = 0; v < cached.length && firstBad < 0; v++) {
      firstBad = same(grid(cached[v]), grid(plain[v]));
    }
    if (firstBad >= 0) break;
    step(a);
    step(b);
    rounds++;
  }
  check("twelve rounds, three viewpoints, no cell differs", firstBad, -1);
  check("…and it really did run them all", rounds, 12);
  check("the cache was used", stamps.hits > 0, true);
}

console.log("\na felled tree is cast again rather than replayed stale");
{
  const stamps = new SightStamps();
  const cached = newMap(stamps);
  const plain = newMap(null);
  const units = makeUnits().slice(0, 40);
  // Prime both, so every footprint in range of the tree is remembered.
  cached.beginFrame();
  for (const u of units) cached.reveal(u.x, u.y, u.sight, false, u.id);
  plain.beginFrame();
  for (const u of units) plain.reveal(u.x, u.y, u.sight, false);
  // …then fell a stand of trees right where the units are standing and rebuild.
  const r = rng(4);
  for (let i = 0; i < 200; i++) {
    const u = units[i % units.length];
    const x = u.x + (r() - 0.5) * 600;
    const y = u.y + (r() - 0.5) * 600;
    cached.removeTreeBlocker(x, y, VISION_CELL / 2);
    plain.removeTreeBlocker(x, y, VISION_CELL / 2);
  }
  cached.beginFrame();
  for (const u of units) cached.reveal(u.x, u.y, u.sight, false, u.id);
  plain.beginFrame();
  for (const u of units) plain.reveal(u.x, u.y, u.sight, false);
  check("the grid after the felling matches", same(grid(cached), grid(plain)), -1);
}

console.log("\nwhat it is worth");
{
  const bench = (withIds) => {
    const stamps = withIds ? new SightStamps() : null;
    const maps = Array.from({ length: VIEWPOINTS }, () => newMap(stamps));
    const units = makeUnits();
    round(maps, units, withIds); // warm the code paths (and, for the cached arm, the cache)
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ROUNDS; i++) {
      step(units);
      round(maps, units, withIds);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / ROUNDS;
    return { ms, stamps };
  };
  const off = bench(false);
  const on = bench(true);
  const pct = (100 * (1 - on.ms / off.ms)).toFixed(0);
  console.log(`      ${UNITS} units (${MOVING} moving) x ${VIEWPOINTS} viewpoints, per 10 Hz round:`);
  console.log(`        every sight cast:  ${off.ms.toFixed(2)} ms`);
  console.log(`        shared footprints: ${on.ms.toFixed(2)} ms   (${pct}% less)`);
  console.log(`        casts ${on.stamps.misses}, replays ${on.stamps.hits}`);
  // Not a threshold on the machine's speed — a threshold on the IDEA. If the cache is not
  // saving most of the casts, something has stopped keying or invalidating correctly.
  const saved = on.stamps.hits / (on.stamps.hits + on.stamps.misses);
  check("most sights are replayed rather than cast", saved > 0.8, true);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
