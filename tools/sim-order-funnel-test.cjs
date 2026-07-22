// Headless check of the ORDER FUNNEL (docs/multiplayer.md Phase C) — the sim half.
//
// Phase C is about every player order reaching the sim through the ONE choke point
// (`RtsController.order()` -> `SimWorld.issueOrder`), so that commands can go on the wire without
// some of them silently staying host-only. Hold and Stop were the two orders already expressible
// as a `QueuedOrder` that nevertheless reached the sim by hand, so they went first.
//
// The two are NOT symmetric, and that is most of what is checked here:
//   * Hold is refused by a locked-in cast wind-up, and refused WITHOUT dropping the unit's
//     shift-queue ("don't even drop the queue for an ignored order", world.ts). The old
//     hand-rolled `clearQueue` + `issueHold` pair dropped it before the refusal — a real bug.
//   * Stop is EXEMPT from that lock, because stop() is the one command that aborts a wind-up.
//     Route it naively and Stop becomes the single order that cannot do its own job.
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

console.log("stop is exempt from the cast lock — it is what aborts a wind-up");
{
  const u = unit();
  u.order = "cast";
  u.pendingCast = { started: true, fired: false };
  // The trap in routing stopSelected through order(): issueOrder refuses every order during a
  // locked-in wind-up, but stop() is documented as "the one command that aborts" one. Refuse it
  // here and Stop becomes the single order that cannot do its own job.
  check("issueOrder(stop) took anyway", world.issueOrder(u.id, { kind: "stop" }), true);
  check("unit is idle", u.order, "idle");
  check("the wind-up was cleared", u.pendingCast, null);
}

console.log("stop clears the shift-queue");
{
  const u = unit();
  world.queueOrder(u.id, { kind: "move", x: 700, y: 700 });
  world.queueOrder(u.id, { kind: "move", x: 900, y: 900 });
  check("queue primed", u.orderQueue.length, 2);
  check("issueOrder(stop) took", world.issueOrder(u.id, { kind: "stop" }), true);
  check("stop wiped the queue", u.orderQueue.length, 0);
  check("unit is idle", u.order, "idle");
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

console.log("a finished training names its OWNER (playtest bug 4)");
{
  // The renderer's drain used to spawn every completed training as the MACHINE's localPlayer
  // — right in single-player, wrong on a LAN host completing a remote player's training
  // (docs/multiplayer.md Phase G item 5). The event must carry the trainer's owner.
  const hall = unit({
    owner: 3, team: 1,
    building: {
      queue: [], constructionLeft: 0, buildTimeTotal: 60, builderIds: [],
      rallyX: 300, rallyY: 300, rallyKind: "point", rallyTargetId: 0,
      goldCost: 0, lumberCost: 0,
    },
  });
  check("training queued", world.enqueueTrain(hall.id, "opeo", 1), true);
  world.tickBuildings(1.5); // private in TS, a plain method at runtime — drives only the queues
  const done = world.drainTrained();
  check("one completion", done.length, 1);
  check("the completion carries the TRAINER's owner, not a machine default", done[0]?.owner, 3);
}

// ---------------------------------------------------------------------------------------
// The gold mine's one-worker `busy` latch (the "stuck outside the gold mine" playtest).
// A LAN client's deselect is one payload-interval stale, so its selection could still name
// a peon that had just ducked INSIDE a mine — and an order landing mid-mine corrupted the
// latch two ways: re-targeting `resId` made the emerge branch free the WRONG mine, and a
// move order took the unit off `harvest` so nothing ever emerged at all. Either way the
// mine stayed `busy` forever and every later worker parked at its entrance for good.
// ---------------------------------------------------------------------------------------

const miner = (over = {}) =>
  unit({
    radius: 16, atNode: false, working: false, moving: false,
    worker: { gold: true, lumber: false, carryGold: 0, carryLumber: 0, lumberCapacity: 0 },
    ...over,
  });

console.log("\nthe emerge frees the mine the worker is IN, not the one its order names");
{
  const A = world.addMine(600, 600, 5000);
  const B = world.addMine(1200, 1200, 5000);
  A.busy = true;
  // Mid-mine in A with the order re-targeted to B — the re-clicked-expansion shape.
  const u = miner({ order: "harvest", resKind: "gold", resId: B.id, inMine: true, inMineId: A.id, workT: 0.01 });
  world.tickHarvest(u, 0.05); // private in TS, a plain method at runtime — drives only this worker
  check("the worker emerged", u.inMine, false);
  check("mine A's latch is FREE — the wedge that stranded every later peon", A.busy, false);
  check("mine B's latch was never touched", B.busy, false);
  check("and the load came out of the mine it was IN", [u.worker.carryGold, 5000 - A.gold, B.gold], [10, 10, 5000]);
}

console.log("an order reaching a mid-mine worker pops it back onto the field first");
{
  const A = world.addMine(2000, 600, 5000);
  A.busy = true;
  const u = miner({ order: "harvest", resKind: "gold", resId: A.id, inMine: true, inMineId: A.id, workT: 99 });
  check("the order took", world.issueOrder(u.id, { kind: "move", x: 500, y: 500 }), true);
  check("the worker is back on the field", u.inMine, false);
  check("the latch it held is free", A.busy, false);
  check("and it is walking its new order", u.order, "move");
}

console.log("the AUTHORITY refuses an order naming an off-field unit (a client's stale selection)");
{
  const { Authority } = require(join(REPO, ".sim-build", "src", "game", "authority.js"));
  const stub = { get: () => undefined };
  const auth = new Authority(world, stub, stub, stub, stub);
  const u = miner({ order: "harvest", inMine: true, inMineId: 0 });
  const move = { c: "order", unitId: u.id, order: { kind: "move", x: 500, y: 500 }, queued: false };
  // No WC3 UI can address an off-field unit — the game deselects it synchronously. Only a
  // LAN client's beat-late selection can, so the gate is the wire's, same door as a forged
  // unitId (docs/multiplayer.md Phase C).
  check("a command for a mid-mine worker is refused", auth.execute(0, move), false);
  check("…and left the worker inside, untouched", [u.inMine, u.order], [true, "harvest"]);
  u.inMine = false;
  check("back on the field the same command is accepted", auth.execute(0, move), true);
}

console.log(failed === 0 ? "\norder funnel: all checks passed" : `\norder funnel: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
