// Headless check of the SNAPSHOT payload (docs/multiplayer.md Phase E item 5).
//
// Two properties are under test, and only one of them is about shape.
//
// 1. The payload is a SUBSET, not a serialisation. `SimUnit` carries ~150 fields; a client
//    reads about 60. If somebody later "simplifies" `snapshotFor` into a spread of the sim
//    unit, every pathing scratch value and every stuck timer goes on the wire and nothing
//    else in the suite notices — it would render identically. The absent-field checks below
//    are what goes red.
//
// 2. The illusion mask is applied AT THE SOURCE. `docs/illusions.md`: to an enemy, an
//    illusion reports as an ordinary unit. The client half already gets that right by
//    reading the bit and discarding it, which is the correct behaviour and the wrong place —
//    a filter applied after the bit crossed the wire is a filter a modified client deletes.
//    These checks fail if the mask moves back to the reader.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { snapshotFor } = require(join(REPO, ".sim-build", "src", "game", "snapshot.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A unit carrying every field `snapshotFor` reads, PLUS a handful of sim-internal ones that
 *  must not survive the trip. The internals are the point of the fixture. */
const unit = (o) => ({
  id: 1, owner: 0, team: 0, typeId: "hfoo", race: "human", neutralPassive: false,
  isHero: false, properName: "", isCreep: false,
  x: 10, y: 20, facing: 0, flyHeight: 0, speed: 270, radius: 16, flying: false,
  order: "idle", moving: false, inCombat: false, working: false,
  swingSeq: 0, chopSeq: 0, swingBroken: false, swingSlam: false,
  altModel: false, spawning: 0, constructing: 0, repair: null,
  inMine: false, insideBuild: false, inBurrow: false, devouredBy: 0, vanished: false,
  invisible: false, ethereal: false,
  hp: 420, maxHp: 420, mana: 0, maxMana: 0, armor: 2, bonusArmor: 0, bonusDamage: 0,
  invulnerable: false, weapon: null, swingWeapon: null,
  level: 0, xp: 0, skillPoints: 0, str: 0, agi: 0, int: 0, bonusStr: 0, bonusAgi: 0, bonusInt: 0,
  worker: null, building: null, abilities: [], buffs: [], inventory: [],
  garrison: [], garrisonCap: 0,
  isSummon: false, summonLeft: 0, summonMax: 0, isIllusion: false, illusionOf: 0,
  guardX: 0, guardY: 0,
  buildPending: null, orderQueue: [], pendingCast: null,

  // --- sim-internal: none of these may appear in the payload ------------------
  repathT: 0.4, path: [[1, 2]], velX: 3, velY: 4, stuckT: 1.5, acquireT: 0.2,
  baseMaxHp: 420, baseDamage: 12, turnRate: 0.6, targetId: 7, cooldownLeft: 0.9,
  illusionDamageDealt: 0, illusionDamageTaken: 2, sightDay: 1400, sightNight: 800,
  ...o,
});

function worldOf(units, mines = [], items = []) {
  const um = new Map(); for (const u of units) um.set(u.id, u);
  const mm = new Map(); for (const m of mines) mm.set(m.id, m);
  const im = new Map(); for (const i of items) im.set(i.id, i);
  return { units: um, mines: mm, items: im, timeOfDay: 12, dawnDusk: true };
}

/** `Viewpoint.seesFor` in two lines: yourself and your team-mates. */
const viewer = (team, seating) => ({ seesFor: (p) => seating[p] === team });

console.log("the snapshot is a subset of the sim unit, not a serialisation of it");
{
  const world = worldOf([unit({ id: 1, owner: 0 })]);
  const snap = snapshotFor(world, viewer(0, { 0: 0 }), 0, 5.5);
  const u = snap.units[0];

  check("one unit, echoed recipient and time", [snap.units.length, snap.recipient, snap.time], [1, 0, 5.5]);
  check("world clock rides along", [snap.timeOfDay, snap.dawnDusk], [12, true]);
  check("the fields a client draws with are present", [u.x, u.y, u.hp, u.maxHp, u.typeId, u.owner], [10, 20, 420, 420, "hfoo", 0]);

  // THE check. A spread-based `snapshotFor` passes everything above and fails only here.
  const internals = ["repathT", "path", "velX", "velY", "stuckT", "acquireT", "baseMaxHp",
    "baseDamage", "turnRate", "targetId", "cooldownLeft", "illusionDamageDealt",
    "illusionDamageTaken", "sightDay", "sightNight"];
  check("no sim-internal field survives the trip", internals.filter((k) => k in u), []);

  // Vision ranges specifically: a client that knows enemy sight radii can compute where it is
  // safe to walk. `viewpoint.ts` reads these on the AUTHORITY and must keep doing so.
  check("enemy sight radii are not derivable client-side", ["sightDay" in u, "sightNight" in u], [false, false]);
}

console.log("an enemy cannot tell an illusion from the unit it copies");
{
  // Player 0 owns a Blademaster and one Mirror Image of it. Player 1 is the enemy; player 2 is
  // player 0's ALLY, seated on the same team — an ally must still be able to tell them apart,
  // or Mirror Image would fool your own side.
  const real = unit({ id: 1, owner: 0, team: 0, typeId: "Obla", isHero: true });
  const image = unit({
    id: 2, owner: 0, team: 0, typeId: "Obla", isHero: true,
    isIllusion: true, illusionOf: 1, isSummon: true, summonLeft: 42, summonMax: 60,
  });
  const world = worldOf([real, image]);
  const seating = { 0: 0, 1: 1, 2: 0 };

  const mine = snapshotFor(world, viewer(0, seating), 0, 0).units.find((u) => u.id === 2);
  const ally = snapshotFor(world, viewer(0, seating), 2, 0).units.find((u) => u.id === 2);
  const foe = snapshotFor(world, viewer(1, seating), 1, 0).units.find((u) => u.id === 2);

  check("the owner is told it is an illusion", [mine.isIllusion, mine.illusionOf], [true, 1]);
  check("an ally is told too", [ally.isIllusion, ally.illusionOf], [true, 1]);
  check("the enemy is not", [foe.isIllusion, foe.illusionOf], [false, 0]);

  // The summon timer is itself a tell: a bar counting down over one of two identical
  // Blademasters gives the game away as loudly as the flag would.
  check("the owner still sees the expiry timer", [mine.isSummon, mine.summonLeft, mine.summonMax], [true, 42, 60]);
  check("the enemy sees no expiry at all", [foe.isSummon, foe.summonLeft, foe.summonMax], [false, 0, 0]);

  // And the copy must otherwise be indistinguishable — same type, same stats on the sheet.
  const foeReal = snapshotFor(world, viewer(1, seating), 1, 0).units.find((u) => u.id === 1);
  check("to the enemy the two are identical bar position", [foe.typeId, foe.hp, foe.maxHp], [foeReal.typeId, foeReal.hp, foeReal.maxHp]);
}

console.log("a real summon is not masked — only illusions are");
{
  const water = unit({ id: 3, owner: 0, team: 0, isSummon: true, summonLeft: 30, summonMax: 60 });
  const world = worldOf([water]);
  const foe = snapshotFor(world, viewer(1, { 0: 0, 1: 1 }), 1, 0).units[0];
  // WC3 shows everyone a Water Elemental's timer. Masking every summon would be the lazy
  // over-correction and this is what catches it.
  check("an enemy sees a Water Elemental's timer", [foe.isSummon, foe.summonLeft, foe.summonMax], [true, 30, 60]);
}

console.log("what a player is about to do is not sent to anyone else");
{
  const worker = unit({
    id: 4, owner: 0, team: 0,
    buildPending: { defId: "hbar", x: 500, y: 600, gold: 160, lumber: 50 },
    orderQueue: [{ kind: "move", x: 1, y: 2 }],
    pendingCast: { code: "AHhb", abilityId: "AHhb" },
  });
  const world = worldOf([worker]);
  const seating = { 0: 0, 1: 1, 2: 0 };

  const mine = snapshotFor(world, viewer(0, seating), 0, 0).units[0];
  const ally = snapshotFor(world, viewer(0, seating), 2, 0).units[0];
  const foe = snapshotFor(world, viewer(1, seating), 1, 0).units[0];

  check("the owner keeps its own build ghost", [mine.buildPending.defId, mine.buildPending.x], ["hbar", 500]);
  check("the owner keeps its queue and its cast", [mine.orderQueue.length, mine.pendingCastCode], [1, "AHhb"]);
  // Private intent is OWNERSHIP, not team — an ally does not get to see where you are about
  // to drop a tower either. This is the one gate that is deliberately narrower than seesFor.
  check("an ally is told nothing of it", [ally.buildPending, ally.orderQueue, ally.pendingCastCode], [null, null, null]);
  check("an enemy is told nothing of it", [foe.buildPending, foe.orderQueue, foe.pendingCastCode], [null, null, null]);
  // The cost fields are the authority's accounting for a refund, not the client's business.
  check("the build ghost carries no cost", ["gold" in mine.buildPending, "lumber" in mine.buildPending], [false, false]);
}

console.log("mines and ground items travel as their own narrow records");
{
  const world = worldOf([], [{ id: 90, x: 1, y: 2, radius: 96, gold: 12500, busy: true }],
    [{ id: 70, itemId: "ratf", x: 3, y: 4, charges: 3 }]);
  const snap = snapshotFor(world, viewer(0, { 0: 0 }), 0, 0);
  check("the mine's gold and geometry", [snap.mines[0].id, snap.mines[0].gold, snap.mines[0].radius], [90, 12500, 96]);
  // `busy` is the sim's one-worker-at-a-time latch and nothing draws it.
  check("the mine's internal latch stays behind", "busy" in snap.mines[0], false);
  check("the ground item's identity and place", [snap.items[0].id, snap.items[0].itemId, snap.items[0].x], [70, "ratf", 3]);
}

console.log("the payload is JSON, by decision");
{
  // "JSON first, binary when it hurts" (docs/multiplayer.md Open questions). A Map, a Set or a
  // class instance sneaking into the payload survives typecheck and dies on the wire.
  const world = worldOf([unit({ id: 1, owner: 0, building: {
    constructionLeft: 0, buildTimeTotal: 60, queue: [], producesUnits: true,
    rallyX: 1, rallyY: 2, rallyKind: "point", rallyTargetId: 0,
    stock: new Map([["ratf", { count: 1 }]]), builderIds: [9], goldCost: 160, lumberCost: 50,
  } })]);
  const snap = snapshotFor(world, viewer(0, { 0: 0 }), 0, 0);
  const round = JSON.parse(JSON.stringify(snap));
  check("survives a JSON round trip unchanged", round, snap);
  // The shop `stock` Map is the concrete thing that would have gone through as `{}`.
  check("the building's stock Map did not come along", "stock" in snap.units[0].building, false);
  check("nor the speed-build accounting", ["builderIds", "goldCost", "lumberCost"].filter((k) => k in snap.units[0].building), []);
}

console.log(failed === 0 ? "\nsnapshot: all checks passed" : `\nsnapshot: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
