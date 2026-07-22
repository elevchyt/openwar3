// Headless check of the snapshot APPLIER (docs/multiplayer.md option 2, item 2b) — the
// module that turns a client's SimWorld into a record store the payload writes.
//
// The one check that matters most is the MAPHACK INVARIANT: after an application, the
// client's world holds a record for exactly the ids it was SENT — a unit absent from the
// payload is not "hidden", it is GONE from process memory. That invariant is why option 2
// exists (Open questions: "what decided it was not CPU, it was a maphack"), and this file
// is its named regression stop.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { applyWorldSnapshot, writeUnitSnapshot } = require(join(REPO, ".sim-build", "src", "game", "snapshotApply.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A minimal record — the applier writes fields; it never asks the record to DO anything. */
function record(over = {}) {
  return {
    id: 0, owner: 0, team: 0, typeId: "hfoo", race: "human", neutralPassive: false,
    isHero: false, properName: "", isCreep: false,
    x: 100, y: 100, prevX: 100, prevY: 100, facing: 0, flyHeight: 0, speed: 270, radius: 16,
    flying: false, order: "idle", moving: false, inCombat: false, working: false,
    swingSeq: 0, chopSeq: 0, swingBroken: false, swingSlam: false, altModel: false,
    spawning: 0, constructing: 0, repair: null,
    inMine: false, insideBuild: false, inBurrow: false, devouredBy: 0, vanished: false,
    invisible: false, ethereal: false,
    hp: 420, maxHp: 420, mana: 0, maxMana: 0, armor: 2, bonusArmor: 0, bonusDamage: 0,
    invulnerable: false, weapon: null, swingWeapon: null,
    level: 0, xp: 0, skillPoints: 0, str: 0, agi: 0, int: 0, bonusStr: 0, bonusAgi: 0, bonusInt: 0,
    worker: null, building: null, abilities: [], buffs: [], inventory: [], garrison: [], garrisonCap: 0,
    isSummon: false, summonLeft: 0, summonMax: 0, isIllusion: false, illusionOf: 0,
    guardX: 0, guardY: 0, buildPending: null, orderQueue: [], pendingCast: null,
    ...over,
  };
}

/** One unit's payload, shaped like snapshot.ts's UnitSnapshot. */
function payloadUnit(over = {}) {
  const u = record();
  delete u.prevX;
  delete u.prevY;
  delete u.pendingCast;
  return {
    ...u, remembered: false,
    repair: null, weapon: null, swingWeapon: null, worker: null, building: null,
    orderQueue: null, pendingCastCode: null, buildPending: null,
    ...over,
  };
}

/** A stub ApplyWorld whose removeUnit mirrors the real one's observable half. */
function world(units) {
  const stashes = new Map();
  const w = {
    units: new Map(units.map((u) => [u.id, u])),
    mines: new Map(),
    items: new Map(),
    timeOfDay: 8,
    dawnDusk: true,
    removedVia: [],
    // The tech ledger the payload's `research` lands in — recorded flat for the checks.
    researchWrites: [],
    tech: { setResearchLevel: (p, id, lvl) => w.researchWrites.push([p, id, lvl]) },
    stashOf(owner) {
      let s = stashes.get(owner);
      if (!s) { s = { gold: 0, lumber: 0 }; stashes.set(owner, s); }
      return s;
    },
    removeUnit(id) {
      if (!w.units.has(id)) return false;
      w.units.delete(id);
      w.removedVia.push(id);
      return true;
    },
  };
  return w;
}

console.log("the maphack invariant: records mirror the payload's id set");
{
  const own = record({ id: 1, owner: 2 });
  const enemyBase = record({ id: 2, owner: 1, typeId: "htow" });
  const w = world([own, enemyBase]);
  const snap = {
    recipient: 2, time: 1, timeOfDay: 11, dawnDusk: true, commands: 0,
    stash: { gold: 731, lumber: 240 },
    research: { Rhme: 2, Rhar: 1 },
    units: [payloadUnit({ id: 1, owner: 2, hp: 77, x: 999, y: 888 }), payloadUnit({ id: 3, owner: 1, typeId: "hfoo" })],
    mines: [], items: [],
  };
  const res = applyWorldSnapshot(w, snap, (s) => {
    const u = record({ id: s.id });
    w.units.set(s.id, u);
    return u;
  });
  check("a record absent from the payload is GONE — not hidden, gone", [...w.units.keys()].sort(), [1, 3]);
  check("…removed through the sim's own removeUnit (footprints unstamp)", w.removedVia, [2]);
  check("an id never seen before gets a record", w.units.get(3)?.owner, 1);
  check("…and is reported for the renderer to grow a model over (2c)", res.created.map((s) => s.id), [3]);
  check("sent fields land on the surviving record", [w.units.get(1).hp, w.units.get(1).x, w.units.get(1).y], [77, 999, 888]);
  check("the record rolls its own prev position forward", [w.units.get(1).prevX, w.units.get(1).prevY], [100, 100]);
  check("the world clock is the payload's", w.timeOfDay, 11);
  // The recipient's stash is the AUTHORITY's figure, written wholesale — this is what undoes
  // a client's optimistic local charge when the host refuses (the "instantly canceled"
  // train of the July playtest: local gold leaked on every refusal, and income never came).
  check("the recipient's stash is overwritten with the payload's", w.stashOf(2), { gold: 731, lumber: 240 });
  // Research lands in the tech ledger, billed to the RECIPIENT — the client's card levels,
  // rtma unit swaps and requirement gates all read this and sat at zero forever without it.
  check("the recipient's research lands in the tech ledger", w.researchWrites, [[2, "Rhme", 2], [2, "Rhar", 1]]);
}

console.log("in-flight missiles follow the items' rule, with the flight fields the client advances");
{
  const w = world([]);
  w.projectiles = new Map([[3, { id: 3, x: 0, y: 0, z: 30, sourceId: 9, targetId: 4, speed: 900, damage: 55, art: "old.mdx", startZ: 30, impactZ: 40, startDist: 500 }]]);
  const snap = {
    recipient: 2, time: 1, timeOfDay: 8, dawnDusk: true, commands: 0, units: [],
    stash: { gold: 0, lumber: 0 }, research: {}, mines: [], items: [],
    projectiles: [
      { id: 3, x: 100, y: 50, z: 33, targetId: 4, tx: 400, ty: 200, speed: 900, art: "old.mdx", startZ: 30, impactZ: 40, startDist: 500 },
      { id: 7, x: 10, y: 20, z: 60, targetId: 5, tx: 300, ty: 300, speed: 1100, art: "FarseerMissile.mdx", startZ: 60, impactZ: 45, startDist: 350 },
    ],
  };
  const res = applyWorldSnapshot(w, snap, () => null);
  check("a known missile takes the payload's pose", [w.projectiles.get(3).x, w.projectiles.get(3).z], [100, 33]);
  check("…and keeps carrying no damage of its own", w.projectiles.get(3).damage, 55);
  check("a new missile gets a record and is reported for a model + launch sound", res.createdProjectiles.map((p) => p.id), [7]);
  check("…seated with the homing fields the client advances", [w.projectiles.get(7).speed, w.projectiles.get(7).startDist], [1100, 350]);
  const snap2 = { ...snap, projectiles: [snap.projectiles[1]] };
  const res2 = applyWorldSnapshot(w, snap2, () => null);
  check("a vanished missile is gone, reported with its last pose for the burst", res2.removedProjectiles, [{ id: 3, x: 100, y: 50, z: 33 }]);
  check("the record store dropped it", [...w.projectiles.keys()], [7]);
}

console.log("a shop's shelf is seated as the Map the card reads");
{
  const u = record({ id: 5, typeId: "ngme", building: { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0, producesUnits: false, stock: new Map() } });
  writeUnitSnapshot(u, payloadUnit({
    id: 5, typeId: "ngme",
    building: {
      constructionLeft: 0, buildTimeTotal: 1, queue: [], producesUnits: false, rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0,
      // timer -1 is the wire's spelling of Infinity — JSON has no way to say "never".
      stock: [{ id: "pinv", count: 2, max: 3, timer: 14.5, period: 30, kind: "item" }, { id: "stel", count: 0, max: 1, timer: -1, period: -1, kind: "item" }],
    },
  }));
  check("counts and the restock sweep land", [u.building.stock.get("pinv").count, u.building.stock.get("pinv").timer, u.building.stock.get("pinv").period], [2, 14.5, 30]);
  check("-1 decodes back to 'never restocks'", [u.building.stock.get("stel").timer, u.building.stock.get("stel").period], [Infinity, Infinity]);
  // A null shelf is "not entitled" (an enemy's shop) — it must not delete what the record has.
  writeUnitSnapshot(u, payloadUnit({ id: 5, typeId: "ngme", building: { constructionLeft: 0, buildTimeTotal: 1, queue: [], producesUnits: false, rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0, stock: null } }));
  check("a withheld shelf leaves the record's shelf alone", u.building.stock.size, 2);
}

console.log("field semantics the readers depend on");
{
  const u = record({ id: 9, typeId: "htow", building: { constructionLeft: 0, buildTimeTotal: 1, builderIds: [7], goldCost: 385, lumberCost: 205, queue: [], rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0, producesUnits: true } });
  writeUnitSnapshot(u, payloadUnit({
    id: 9, typeId: "hkee", // a morph keeps the id and rewrites the type
    building: { constructionLeft: 5, buildTimeTotal: 140, queue: [{ kind: "unit", unitId: "hpea", timeLeft: 3, buildTime: 15 }], producesUnits: true, rallyX: 50, rallyY: 60, rallyKind: "point", rallyTargetId: 0 },
  }));
  check("typeId follows a morph", u.typeId, "hkee");
  check("the building patch keeps def-derived fields the wire omits", [u.building.goldCost, u.building.builderIds], [385, [7]]);
  check("…while landing the carried ones", [u.building.constructionLeft, u.building.queue.length, u.building.rallyX], [5, 1, 50]);
}

console.log("mines keep their last reading; items follow the units' rule");
{
  const w = world([]);
  w.mines.set(4, { gold: 12500 });
  w.items.set(6, { id: 6, itemId: "tdex", x: 1, y: 1, charges: 0 });
  const snap = {
    recipient: 2, time: 1, timeOfDay: 8, dawnDusk: true, commands: 0, units: [],
    stash: { gold: 0, lumber: 0 },
    research: {},
    mines: [{ id: 4, x: 0, y: 0, radius: 96, gold: -1 }],
    items: [{ id: 8, itemId: "ratc", x: 5, y: 5 }],
  };
  const res = applyWorldSnapshot(w, snap, () => null);
  check("no eyes on the mine (-1) keeps the last reading", w.mines.get(4).gold, 12500);
  check("an unsent item is gone; a sent one exists", [...w.items.keys()], [8]);
  check("the new item is reported for a model (2c)", res.createdItems.map((i) => i.id), [8]);
  check("…and the vanished one for removal", res.removedItems, [6]);
  const snap2 = { ...snap, mines: [{ id: 4, x: 0, y: 0, radius: 96, gold: 900 }] };
  const res2 = applyWorldSnapshot(w, snap2, () => null);
  check("eyes back on the mine writes the reading", w.mines.get(4).gold, 900);
  check("an item already modelled is not re-reported", res2.createdItems, []);
}

console.log(failed === 0 ? "\nsnapshot applier: all checks passed" : `\nsnapshot applier: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
