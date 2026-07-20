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
const { snapshotFor, visibilityFor } = require(join(REPO, ".sim-build", "src", "game", "snapshot.js"));

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

/** A stand-in for `Viewpoint`: the five questions `SnapshotViewer` asks. Defaults are
 *  "everything in plain sight", so each test overrides only the rule it is about.
 *
 *  That the REAL `Viewpoint` still answers all five is not checked here — a stub satisfies the
 *  interface by construction, which is exactly how the two would drift apart unnoticed. It is
 *  checked by `tools/snapshot-viewer-conformance.ts`, at compile time, on every sim:test. */
const viewer = (team, seating, o = {}) => ({
  seesFor: (p) => seating[p] === team,
  fogHides: () => false,
  fogBlocksClick: () => false,
  invisHides: () => false,
  fogBlocksAt: () => false,
  ...o,
});

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

// ---------------------------------------------------------------------------------------
// Item 6: AoI. "May this be SENT" is strictly stronger than "should this be DRAWN", and the
// difference is the whole of the maphack question — a filter a client applies is a filter a
// modified client removes.
// ---------------------------------------------------------------------------------------

console.log("what the fog hides is not sent at all, not sent and ignored");
{
  const seating = { 0: 0, 1: 1 };
  const world = worldOf([unit({ id: 1, owner: 1, team: 1, x: 5000, y: 5000 })]);
  // An enemy footman standing in black fog: fogHides true, so it is not drawn — and the send
  // rule says it must not be in the payload for the client to have had the chance.
  const foe = viewer(0, seating, { fogHides: () => true, fogBlocksClick: () => true });
  const snap = snapshotFor(world, foe, 0, 0);
  check("a fogged enemy is absent from the payload", snap.units.length, 0);
  check("visibilityFor says so directly", visibilityFor(foe, world.units.get(1)), "omit");
}

console.log("an undetected invisible unit is absent, not merely undrawn");
{
  const seating = { 0: 0, 1: 1 };
  const hero = unit({ id: 1, owner: 1, team: 1, invisible: true, x: 100, y: 100 });
  const world = worldOf([hero]);
  // The sharp one: fog does NOT hide it — it is standing in plain sight — and only
  // `invisHides` is true. A rule written as "if fogHides, drop" passes every other check in
  // this file and puts a Wind Walking hero's coordinates in the enemy's payload.
  const foe = viewer(0, seating, { invisHides: () => true });
  check("an enemy gets nothing", snapshotFor(world, foe, 0, 0).units.length, 0);
  check("visibilityFor: omit", visibilityFor(foe, hero), "omit");
  // Its owner still sees it (faded) — invisHides is false for your own side.
  const own = viewer(1, seating);
  check("the owner still gets it", snapshotFor(world, own, 1, 0).units.length, 1);
  check("and it is flagged invisible for the fade", snapshotFor(world, own, 1, 0).units[0].invisible, true);
}

console.log("a building seen once is remembered, and the memory is redacted");
{
  const seating = { 0: 0, 1: 1 };
  // A damaged enemy Barracks mid-upgrade, currently unwatched. WC3 keeps the last-seen image
  // on screen — so fogHides is FALSE — but there are no eyes on it, so fogBlocksClick is TRUE.
  // That pair is the whole three-valued rule.
  const barracks = unit({
    id: 1, owner: 1, team: 1, typeId: "hbar", x: 3000, y: 3000, facing: 1.5, altModel: true,
    hp: 400, maxHp: 1500, level: 3, garrison: [8, 9], garrisonCap: 4,
    abilities: [{ id: "Adef", code: "Adef", level: 1 }],
    buffs: [{ kind: "armor", value: 3 }],
    building: {
      constructionLeft: 3, buildTimeTotal: 60, queue: [{ kind: "unit", unitId: "hfoo", timeLeft: 2, buildTime: 20 }],
      producesUnits: true, rallyX: 111, rallyY: 222, rallyKind: "point", rallyTargetId: 0,
    },
  });
  const world = worldOf([barracks]);
  const foe = viewer(0, seating, { fogHides: () => false, fogBlocksClick: () => true });
  const snap = snapshotFor(world, foe, 0, 0);
  const b = snap.units[0];

  check("visibilityFor: remembered", visibilityFor(foe, barracks), "remembered");
  check("the image is still sent", snap.units.length, 1);
  check("and flagged as a memory", b.remembered, true);
  // What a memory legitimately carries: where it is, what it is, whose it is, which model half.
  check("identity and pose survive", [b.id, b.typeId, b.owner, b.x, b.y, b.facing, b.altModel], [1, "hbar", 1, 3000, 3000, 1.5, true]);
  check("it is still shaped like a building", b.building !== null, true);

  // THE checks. Every one of these is a fact about the present that the player cannot know.
  check("its damage is not knowledge", [b.hp, b.maxHp], [0, 0]);
  check("nor is the construction timer", [b.building.constructionLeft, b.building.buildTimeTotal], [0, 0]);
  check("nor what it is training", b.building.queue.length, 0);
  check("nor where it rallies", [b.building.rallyX, b.building.rallyY], [0, 0]);
  check("nor its garrison", [b.garrison.length, b.garrisonCap], [0, 0]);
  check("nor its abilities or buffs", [b.abilities.length, b.buffs.length], [0, 0]);
  check("nor its level", b.level, 0);

  // The same building WATCHED is the full record — the redaction must be about sight, not
  // about being a building.
  const watching = viewer(0, seating, { fogHides: () => false, fogBlocksClick: () => false });
  const live = snapshotFor(world, watching, 0, 0).units[0];
  check("with eyes on it, everything comes back", [live.remembered, live.hp, live.building.queue.length], [false, 400, 1]);
}

console.log("your own units are never fogged out of your own snapshot");
{
  const seating = { 0: 0, 1: 0 };
  const world = worldOf([
    unit({ id: 1, owner: 0, team: 0 }),
    unit({ id: 2, owner: 1, team: 0 }), // an ally's
  ]);
  // A viewer whose fog would hide everything. `fogHides` on the real Viewpoint returns false
  // for your own team before it looks at the grid; a send rule that skipped that would empty
  // a player's own army out of their own payload.
  const blind = viewer(0, seating, { fogHides: (u) => u.team !== 0, fogBlocksClick: (u) => u.team !== 0 });
  check("own and allied units are all live", snapshotFor(world, blind, 0, 0).units.map((u) => u.remembered), [false, false]);
}

console.log("units off the field belong to their owner, and to nobody else");
{
  const seating = { 0: 0, 1: 1 };
  const world = worldOf([
    unit({ id: 1, owner: 0, team: 0, inMine: true }),
    unit({ id: 2, owner: 0, team: 0, inBurrow: true }),
    unit({ id: 3, owner: 0, team: 0, vanished: true }),
  ]);
  // The owner needs them: a Burrow cannot list a garrison it was not told about, and a mining
  // peasant that vanished from its owner's payload would blink out of its owner's own world.
  check("the owner keeps all three", snapshotFor(world, viewer(0, seating), 0, 0).units.length, 3);
  // An enemy must not learn that a peasant is in that mine, or that a Blademaster is mid-shuffle.
  check("an enemy gets none of them", snapshotFor(world, viewer(1, seating), 1, 0).units.length, 0);
  check("even standing in plain sight", visibilityFor(viewer(1, seating), world.units.get(1)), "omit");
}

console.log("a mine's position is public; how much gold is left in it is not");
{
  const seating = { 0: 0 };
  const world = worldOf([], [{ id: 90, x: 1, y: 2, radius: 96, gold: 12500, busy: false }]);

  const watching = snapshotFor(world, viewer(0, seating), 0, 0);
  check("with eyes on it, the gold is real", watching.mines[0].gold, 12500);

  // minimapIcons paints a mine glyph over UNEXPLORED ground deliberately — measured against
  // the real 1.27a client (item 4) — so omitting the mine would put a hole in the minimap the
  // real game does not have. Its contents are the opposite: the best scouting fact on the map.
  const dark = snapshotFor(world, viewer(0, seating, { fogBlocksAt: () => true }), 0, 0);
  check("unscouted, the mine is still on the map", [dark.mines.length, dark.mines[0].x], [1, 1]);
  check("but its gold reads unknown, not empty", dark.mines[0].gold, -1);
}

console.log("a ground item in the dark is absent, because nothing remembers an item");
{
  const seating = { 0: 0 };
  const world = worldOf([], [], [{ id: 70, itemId: "ratf", x: 3, y: 4, charges: 3 }]);
  check("in sight, it is sent", snapshotFor(world, viewer(0, seating), 0, 0).items.length, 1);
  // Unlike a building, an item is a live widget that vanishes with the eyes on it
  // (`fogBlocksAt`'s own comment). So there is no "remembered" third state for it.
  check("out of sight, it is gone entirely", snapshotFor(world, viewer(0, seating, { fogBlocksAt: () => true }), 0, 0).items.length, 0);
}

console.log(failed === 0 ? "\nsnapshot: all checks passed" : `\nsnapshot: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
