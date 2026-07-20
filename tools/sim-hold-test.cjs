// Headless check of Hold Position as a QUEUED ORDER (docs/multiplayer.md Phase C).
//
// Hold was the one player order already expressible as a `QueuedOrder` that still reached the
// sim by hand (`rts.holdSelected` called `clearQueue` + `issueHold` directly), so it would have
// gone silently host-only the moment commands went on the wire. It now goes through
// `RtsController.order()` like every other order, i.e. through `SimWorld.issueOrder`.
//
// What is checked here is the sim half of that — that `issueOrder({kind:"hold"})` is equivalent
// to the old hand-rolled pair, and that it is BETTER in the one case they differ: a unit locked
// into a cast wind-up refuses Hold, and the old path had already thrown its shift-queue away by
// the time the refusal happened ("don't even drop the queue for an ignored order", world.ts).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const FLAGS = new Uint8Array(32 * 32); // walkable everywhere
const grid = new PathingGrid({ width: 32, height: 32, flags: FLAGS }, [0, 0]);
const world = new SimWorld(grid, 1, { get: () => undefined });

/** A plain footman-ish unit, built the way the other sim tests build theirs. */
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, hp: 420, x: 256, y: 256, prevX: 256, prevY: 256,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0,
    inventory: [], buffs: [], footprint: 0, hasReservation: false, abilities: [],
    orderQueue: [], order: "idle", targetId: null, followLeaderId: null,
    inCombat: false, noCollision: false, stuckT: 0, stuckRetries: 0, acquireT: 0,
    pendingCast: null,
    weapons: [{
      enabled: true, baseDamage: 12, damage: 12, baseDice: 1, dice: 1, baseRange: 90, range: 90,
      baseDamagePoint: 0.3, damagePoint: 0.3, baseBackswing: 0.3, backswing: 0.3,
      baseCooldown: 1.35, cooldown: 1.35, baseSpillDist: 0, spillDist: 0,
      baseSpillRadius: 0, spillRadius: 0,
    }],
    baseArmor: 2, baseMaxHp: 420, baseMaxMana: 0, baseSpeed: 270, baseSight: 1400,
    maxHp: 420, maxMana: 0, mana: 0, speed: 270,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}

console.log("hold as a queued order");
{
  const u = unit();
  world.queueOrder(u.id, { kind: "move", x: 700, y: 700 });
  world.queueOrder(u.id, { kind: "move", x: 900, y: 900 });
  check("queue primed", u.orderQueue.length, 2);
  check("issueOrder(hold) took", world.issueOrder(u.id, { kind: "hold" }), true);
  check("unit is holding", u.order, "hold");
  // issueOrder clears the queue itself — the whole reason holdSelected's own clearQueue could go.
  check("hold cleared the queue", u.orderQueue.length, 0);
  check("hold drops any target", u.targetId, null);
}

console.log("a locked-in cast refuses hold and KEEPS its queue");
{
  const u = unit();
  world.queueOrder(u.id, { kind: "move", x: 700, y: 700 });
  // castLocked(u): order 'cast' with a wind-up that has started but not yet fired.
  u.order = "cast";
  u.pendingCast = { started: true, fired: false };
  check("issueOrder(hold) refused", world.issueOrder(u.id, { kind: "hold" }), false);
  check("still casting", u.order, "cast");
  // The bug the routing fixed: the old clearQueue ran BEFORE issueHold's refusal.
  check("queue survived the refused hold", u.orderQueue.length, 1);
}

console.log("hold still dispatches out of the shift-queue");
{
  const u = unit();
  // A hold sitting in the queue must come back out of `dispatch` as a real hold — this is what
  // makes hold expressible as a command rather than a special case at the call site.
  world.queueOrder(u.id, { kind: "hold" });
  check("queued", u.orderQueue.length, 1);
  check("issuing it drains the queue and holds", world.issueOrder(u.id, u.orderQueue.shift()), true);
  check("unit is holding", u.order, "hold");
}

console.log(failed === 0 ? "\nhold: all checks passed" : `\nhold: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
