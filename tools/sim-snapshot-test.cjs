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
const { GhostMemory } = require(join(REPO, ".sim-build", "src", "game", "ghosts.js"));
const { SnapshotIndex } = require(join(REPO, ".sim-build", "src", "game", "renderView.js"));
const { divergence, describeDivergence } = require(join(REPO, ".sim-build", "src", "game", "divergence.js"));
// The animation picker (`src/render/unitAnims.ts`) imports only a TYPE, so it compiles into the
// sim build and can be driven headlessly against both structs -- see the equivalence block below.
const { pickSequence, walkAnim, attackAnimRate } = require(join(REPO, ".sim-build", "src", "render", "unitAnims.js"));

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
  // A per-player ledger like the sim's: `snapshotFor` reads the RECIPIENT's own stash.
  const stashes = new Map();
  const stashOf = (owner) => {
    let s = stashes.get(owner);
    if (!s) { s = { gold: 500 + owner, lumber: 150 }; stashes.set(owner, s); }
    return s;
  };
  return { units: um, mines: mm, items: im, timeOfDay: 12, dawnDusk: true, stashOf };
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
  // The RECIPIENT's stash rides in the payload (Phase G item 6 — the client's local ledger
  // drifts, and the July playtest's "instantly canceled" trains were the drift judging).
  check("the recipient's own stash rides along", snap.stash, { gold: 500, lumber: 150 });
  check("…as a copy, not the live ledger", snap.stash === world.stashOf(0), false);
  check("…and it is the recipient's, nobody else's", snapshotFor(world, viewer(0, { 0: 0, 3: 0 }), 3, 0).stash.gold, 503);
  // A hand-built world with no tech ledger still snapshots — research is just empty.
  check("no tech ledger reads as no research, not a crash", snap.research, {});
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

console.log("the recipient's research rides along — its own, nobody else's");
{
  const world = worldOf([unit({ id: 1, owner: 0 })]);
  world.tech = {
    researchedBy: (p) => (p === 0 ? new Map([["Rome", 2], ["Roar", 1]]) : new Map([["Rhme", 3]])),
  };
  check("player 0 gets its own ledger", snapshotFor(world, viewer(0, { 0: 0 }), 0, 0).research, { Rome: 2, Roar: 1 });
  check("player 1 gets its own, never player 0's", snapshotFor(world, viewer(1, { 1: 1 }), 1, 0).research, { Rhme: 3 });
}

console.log("neutral-passive structures are map furniture: fog demotes them to remembered, never to absent");
{
  const fogged = { fogHides: () => true, fogBlocksClick: () => true };
  const shop = unit({ id: 1, owner: 15, neutralPassive: true, typeId: "ngme", building: { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0, producesUnits: false } });
  const critter = unit({ id: 2, owner: 15, neutralPassive: true, typeId: "npig" });
  const mine = unit({ id: 3, owner: 0, typeId: "htow", building: shop.building });
  const snap = snapshotFor(worldOf([shop, critter, mine]), viewer(1, { 0: 0, 1: 1 }, fogged), 1, 0);
  check("the fogged shop is SENT, as a remembered image", snap.units.map((u) => [u.id, u.remembered]), [[1, true]]);
  check("a fogged critter is still absent — furniture is buildings only", snap.units.some((u) => u.id === 2), false);
  check("and a fogged PLAYER building still hides entirely", snap.units.some((u) => u.id === 3), false);
}

console.log("in-flight missiles cross under your eyes, with the target's position as aim fallback");
{
  const world = worldOf([unit({ id: 4, owner: 0, x: 400, y: 200 })]);
  world.projectiles = new Map([
    [3, { id: 3, x: 100, y: 50, z: 33, sourceId: 9, targetId: 4, speed: 900, damage: 55, art: "m.mdx", startZ: 30, impactZ: 40, startDist: 500, spill: { dist: 1 }, spell: { code: "AHtb" } }],
    [8, { id: 8, x: -900, y: -900, z: 10, sourceId: 9, targetId: 77, speed: 700, damage: 10, art: "n.mdx", startZ: 10, impactZ: 10, startDist: 100 }],
  ]);
  const eyesOnFirst = viewer(0, { 0: 0 }, { fogBlocksAt: (p) => p.x < 0 });
  const snap = snapshotFor(world, eyesOnFirst, 0, 0);
  check("the watched missile crosses; the one in the dark is absent", snap.projectiles.map((p) => p.id), [3]);
  check("aim fallback is the TARGET's position now", [snap.projectiles[0].tx, snap.projectiles[0].ty], [400, 200]);
  check("damage, spill and the impact spell stay behind", ["damage", "spill", "spell", "sourceId"].filter((k) => k in snap.projectiles[0]), []);
  const gone = snapshotFor(worldOf([]), viewer(0, { 0: 0 }), 0, 0);
  check("a world with no projectile map reads as none, not a crash", gone.projectiles, []);
}

console.log("corpses cross under your eyes, whole; deaths default empty (MatchLink fills them)");
{
  const world = worldOf([unit({ id: 1, owner: 0 })]);
  world.corpses = new Map([
    [5, { id: 5, deadId: 40, unitId: "hfoo", x: 100, y: 100, facing: 0, owner: 0, isHero: false, mechanical: false, decayLeft: 80, raised: false }],
    [6, { id: 6, deadId: 41, unitId: "ogru", x: -900, y: -900, facing: 0, owner: 1, isHero: false, mechanical: false, decayLeft: 80, raised: false }],
  ]);
  const eyesNearOnly = viewer(0, { 0: 0 }, { fogBlocksAt: (p) => p.x < 0 });
  const snap = snapshotFor(world, eyesNearOnly, 0, 0);
  check("the watched corpse crosses; the one in the dark is absent", snap.corpses.map((c) => c.id), [5]);
  check("…carried whole (decay clock and raise latch included)", [snap.corpses[0].decayLeft, snap.corpses[0].raised], [80, false]);
  check("deaths are MatchLink's to fill — the builder emits none", snap.deaths, []);
}

console.log("creep-camp markers ride per recipient, and default to none");
{
  const world = worldOf([unit({ id: 1, owner: 0 })]);
  const camps = [{ x: 100, y: 200, level: 12 }];
  check("the markers the host computed are carried", snapshotFor(world, viewer(0, { 0: 0 }), 0, 0, [], 0, camps).creepCamps, camps);
  check("a hand-built world defaults to no camps", snapshotFor(world, viewer(0, { 0: 0 }), 0, 0).creepCamps, []);
}

console.log("a shop's shelf crosses only to those who may shop at it");
{
  const stock = new Map([
    ["pinv", { count: 2, max: 3, regen: 120, timer: 14.5, period: 30, kind: "item" }],
    ["stel", { count: 0, max: 1, regen: 0, timer: Infinity, period: Infinity, kind: "item" }],
  ]);
  const shopOf = (owner, neutral) => unit({ id: 9, owner, neutralPassive: neutral, typeId: neutral ? "ngme" : "hvlt", building: { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0, producesUnits: false, stock } });
  const seating = { 0: 0, 1: 1, 2: 0 }; // 0 and 2 allied, 1 the enemy
  const sent = (owner, neutral, asPlayer) => snapshotFor(worldOf([shopOf(owner, neutral)]), viewer(seating[asPlayer], seating), asPlayer, 0).units[0].building.stock;

  const own = sent(0, false, 0);
  check("the owner sees the shelf, times encoded for JSON", own.map((s) => [s.id, s.count, s.timer, s.period]), [["pinv", 2, 14.5, 30], ["stel", 0, -1, -1]]);
  check("…and JSON round-trips it intact (Infinity would be null)", JSON.parse(JSON.stringify(own)), own);
  check("an ally sees it too — Aall shop sharing", sent(0, false, 2)?.length, 2);
  check("an ENEMY's shelf is withheld", sent(0, false, 1), null);
  check("a neutral shop's shelf crosses to anyone", sent(5, true, 1)?.length, 2);
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
    stock: new Map([["ratf", { count: 1, max: 3, regen: 30, timer: 5, period: 30, kind: "item" }]]), builderIds: [9], goldCost: 160, lumberCost: 50,
  } })]);
  const snap = snapshotFor(world, viewer(0, { 0: 0 }), 0, 0);
  const round = JSON.parse(JSON.stringify(snap));
  check("survives a JSON round trip unchanged", round, snap);
  // The shop shelf CROSSES now (protocol 5) — but re-encoded as a plain array, never as the
  // sim's Map, which is the concrete thing that would have gone through as `{}`.
  check("the shelf crosses as plain data, not the sim's Map", Array.isArray(snap.units[0].building.stock), true);
  check("…carrying the card's fields", snap.units[0].building.stock[0], { id: "ratf", count: 1, max: 3, timer: 5, period: 30, kind: "item" });
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

  // The mine RECORD rides every payload; issue #71 moved the minimap gate onto the recipient's
  // own explored layer (`minimapIcons`), so an unexplored mine is on the wire and off the
  // minimap. Its contents are the opposite: the best scouting fact on the map, and redacted.
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

// ---------------------------------------------------------------------------------------
// Item 6b: a building destroyed while you were not looking keeps its image until you go back
// and see the empty ground. MEASURED in the real 1.27a client: no timeout, no decay, cleared
// by sight of the cell.
// ---------------------------------------------------------------------------------------

console.log("a building destroyed out of sight leaves a ghost; one destroyed in front of you does not");
{
  const seating = { 0: 0, 1: 1 };
  const barracks = unit({
    id: 1, owner: 1, team: 1, typeId: "hbar", x: 3000, y: 3000,
    hp: 900, maxHp: 1500,
    building: { constructionLeft: 0, buildTimeTotal: 60, queue: [], producesUnits: true, rallyX: 5, rallyY: 6, rallyKind: "point", rallyTargetId: 0 },
  });

  // Player 0 scouted it and left; player 1 owns it and is standing right there.
  const away = viewer(0, seating, { fogHides: () => false, fogBlocksClick: () => true, fogBlocksAt: () => true });
  const watching = viewer(1, seating);

  const mem = new GhostMemory();
  mem.noteDestroyed(barracks, [{ player: 0, viewer: away }, { player: 1, viewer: watching }]);

  check("the player who was away keeps an image", mem.ghostsFor(0).length, 1);
  // If you watch it burn down you KNOW it is gone. Minting a ghost here would be a lie the
  // real client does not tell — and `!== "omit"` instead of `=== "remembered"` is exactly the
  // edit that would do it.
  check("the player watching it die keeps nothing", mem.ghostsFor(1).length, 0);

  const g = mem.ghostsFor(0)[0];
  check("the ghost is flagged as a memory", g.remembered, true);
  check("it stands where it stood", [g.id, g.typeId, g.x, g.y], [1, "hbar", 3000, 3000]);
  // A dead building must not be MORE informative than a live one you cannot see.
  check("and is redacted exactly like a live memory", [g.hp, g.maxHp, g.building.queue.length, g.building.rallyX], [0, 0, 0, 0]);
}

console.log("only structures leave a ghost");
{
  const seating = { 0: 0, 1: 1 };
  const footman = unit({ id: 2, owner: 1, team: 1, x: 3000, y: 3000, building: null });
  const away = viewer(0, seating, { fogHides: () => false, fogBlocksClick: () => true, fogBlocksAt: () => true });
  const mem = new GhostMemory();
  mem.noteDestroyed(footman, [{ player: 0, viewer: away }]);
  // WC3 leaves no image of a dead footman. A mobile unit has no last-seen position worth
  // trusting — concealing enemy movement is the fog's whole job.
  check("a dead footman leaves nothing", mem.ghostsFor(0).length, 0);
}

console.log("a ghost is forgotten by SIGHT, not by a clock");
{
  const seating = { 0: 0, 1: 1 };
  const barracks = unit({
    id: 1, owner: 1, team: 1, typeId: "hbar", x: 3000, y: 3000,
    building: { constructionLeft: 0, buildTimeTotal: 60, queue: [], producesUnits: true, rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0 },
  });
  const blind = viewer(0, seating, { fogHides: () => false, fogBlocksClick: () => true, fogBlocksAt: () => true });
  const mem = new GhostMemory();
  mem.noteDestroyed(barracks, [{ player: 0, viewer: blind }]);

  // Still in the dark: no amount of refreshing forgets it. There is no timeout to model.
  mem.forgetSeen(0, blind);
  mem.forgetSeen(0, blind);
  check("staying away keeps the image indefinitely", mem.ghostsFor(0).length, 1);

  // Walk back and look at the spot.
  const returned = viewer(0, seating, { fogBlocksAt: () => false });
  mem.forgetSeen(0, returned);
  check("re-scouting the spot clears it", mem.ghostsFor(0).length, 0);
}

console.log("ghosts ride in the snapshot alongside the living");
{
  const seating = { 0: 0, 1: 1 };
  const alive = unit({ id: 7, owner: 0, team: 0, x: 10, y: 20 });
  const world = worldOf([alive]);
  const v = viewer(0, seating);
  const ghost = { ...unit({ id: 99, owner: 1, team: 1, typeId: "hbar", x: 3000, y: 3000 }), remembered: true };

  const snap = snapshotFor(world, v, 0, 1.5, [ghost]);
  check("both are present", snap.units.length, 2);
  check("the ghost is one of them", snap.units.filter((u) => u.remembered).map((u) => u.id), [99]);
  check("the living unit is untouched", snap.units.find((u) => u.id === 7).x, 10);
  // Default is an empty list, so every existing caller keeps its old answer.
  check("omitting ghosts changes nothing", snapshotFor(world, v, 0, 1.5).units.length, 1);
}

// ---------------------------------------------------------------------------------------
// Item 6c: the wiring. The rules above were tested against stubs; these run against the REAL
// SimWorld and the REAL VisionSet, because the thing that was actually wrong was neither rule
// — it was that the sim deletes a unit before anybody can look at it.
// ---------------------------------------------------------------------------------------

console.log("the sim hands over a dead structure whole, because its id resolves to nothing");
{
  const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
  const w = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);

  // Seeded straight into `world.units`, the same way every other sim test does it.
  const put = (o) => {
    const u = unit({ ...o, weapons: [], abilities: [], buffs: [], inventory: [], garrison: [], orderQueue: [], linkGroup: [], path: [] });
    w.units.set(u.id, u);
    return u;
  };
  // A structure and a footman, so the structures-only rule is exercised on the SIM side rather
  // than only inside GhostMemory.
  const hall = put({ id: 501, typeId: "htow", owner: 0, x: 300, y: 300, building: { constructionLeft: 0, queue: [] } });
  const foot = put({ id: 502, typeId: "hfoo", owner: 0, x: 900, y: 900, building: null });

  w.killUnit(hall.id);
  w.killUnit(foot.id);

  // THE check, and the reason this item needed a sim change at all: `kill` does
  // `this.units.delete(u.id)` on the line BEFORE it queues the death, so a drain that yields
  // ids alone cannot answer "what was it and where did it stand".
  check("the dead building is gone from the world", w.units.has(hall.id), false);
  check("its id is in the plain death drain", w.drainDeaths().includes(501), true);
  const dead = w.drainDeadStructures();
  check("and the structure drain still has it, whole", dead.length, 1);
  check("with the fields a ghost needs", [dead[0].id, dead[0].typeId, dead[0].x, dead[0].y], [501, "htow", 300, 300]);
  check("the dead footman is not in it", dead.some((u) => u.id === 502), false);
  check("draining twice does not repeat it", w.drainDeadStructures().length, 0);
}

// ---------------------------------------------------------------------------------------
// Item 10a: the divergence detector. The developer chose sequencing B — the client renders
// snapshots AND keeps simulating — so the whole value of that choice is being able to say
// exactly WHERE the two disagree.
// ---------------------------------------------------------------------------------------

console.log("two identical worlds report nothing");
{
  const seating = { 0: 0, 1: 1 };
  const v = viewer(0, seating);
  const w = worldOf([unit({ id: 1, owner: 0, x: 10, y: 20, hp: 300 })]);
  // Both sides go through the SAME snapshotFor. That is the point: a comparator that read the
  // local SimUnit directly would report the AoI redaction and the illusion mask as drift on
  // every tick and drown the signal on its first run.
  check("no findings", divergence(snapshotFor(w, v, 0, 1), snapshotFor(w, v, 0, 1)), []);
}

console.log("a field that actually drifted is named, with both values");
{
  const seating = { 0: 0, 1: 1 };
  const v = viewer(0, seating);
  const host = worldOf([unit({ id: 1, owner: 0, x: 10, y: 20, hp: 245 })]);
  const client = worldOf([unit({ id: 1, owner: 0, x: 10, y: 20, hp: 260 })]);
  const d = divergence(snapshotFor(host, v, 0, 1), snapshotFor(client, v, 0, 1));
  check("one finding", d.length, 1);
  check("it names the unit, the field and both sides", [d[0].kind, d[0].id, d[0].field, d[0].local, d[0].authority], ["field", 1, "hp", 260, 245]);
  check("and reads as a line a human can act on", describeDivergence(d[0]), "unit 1.hp: local 260 vs authority 245");
}

console.log("float noise is not drift, but a real gap is");
{
  const seating = { 0: 0, 1: 1 };
  const v = viewer(0, seating);
  const host = worldOf([unit({ id: 1, owner: 0, x: 100, y: 100 })]);
  // Two sims stepping the same movement over different numbers of frames land fractionally
  // apart every tick. Reporting that would make the detector useless on its first run.
  const near = worldOf([unit({ id: 1, owner: 0, x: 100.2, y: 99.8 })]);
  check("a fifth of a unit is not worth reporting", divergence(snapshotFor(host, v, 0, 1), snapshotFor(near, v, 0, 1)), []);
  const far = worldOf([unit({ id: 1, owner: 0, x: 140, y: 100 })]);
  check("forty units apart is", divergence(snapshotFor(host, v, 0, 1), snapshotFor(far, v, 0, 1)).map((x) => x.field), ["x"]);
}

console.log("a unit on one side only is reported, and the two cases are told apart");
{
  const seating = { 0: 0, 1: 1 };
  const v = viewer(0, seating);
  const host = worldOf([unit({ id: 1, owner: 0 }), unit({ id: 2, owner: 0, x: 500, y: 500 })]);
  const client = worldOf([unit({ id: 1, owner: 0 })]);
  check("the authority has one we do not", divergence(snapshotFor(host, v, 0, 1), snapshotFor(client, v, 0, 1)), [{ kind: "missing", id: 2 }]);
  // The reverse is deliberately NOT called drift in the message: the authority withholds what
  // this recipient cannot see, so a locally-simulated unit that was not sent may just be fogged.
  const back = divergence(snapshotFor(client, v, 0, 1), snapshotFor(host, v, 0, 1));
  check("we have one it did not send", back, [{ kind: "extra", id: 2 }]);
  check("and the wording admits it may be fog", describeDivergence(back[0]).includes("fogged"), true);
}

console.log("a remembered building is compared on what it claims to know, not on its redaction");
{
  const seating = { 0: 0, 1: 1 };
  const away = viewer(0, seating, { fogHides: () => false, fogBlocksClick: () => true });
  const bar = (hp) => unit({
    id: 1, owner: 1, team: 1, typeId: "hbar", x: 3000, y: 3000, hp,
    building: { constructionLeft: 0, buildTimeTotal: 60, queue: [], producesUnits: true, rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0 },
  });
  // THE case this rule exists for, and the first version of this check did NOT reach it: if
  // both sides go through the same viewer they are both redacted to zeros, so the comparison
  // is trivially equal and deleting the rule changes nothing. The rule only bites when the two
  // sides DISAGREE about visibility — the authority sends a memory while this client's own fog
  // still has eyes on the building, which is exactly what a client one rebuild out of step
  // looks like. Comparing every field then reports hp, the queue and the rally point as drift
  // for every fogged building on the map.
  const watching = viewer(0, seating);
  const d = divergence(snapshotFor(worldOf([bar(400)]), away, 0, 1), snapshotFor(worldOf([bar(400)]), watching, 0, 1));
  check("a memory is not diffed against a live record's fields", d, []);
  // But its POSE is knowledge on both sides, and a building in two places is a real
  // disagreement even when one side is remembering it.
  const moved = { ...bar(400), x: 5000 };
  const d2 = divergence(snapshotFor(worldOf([bar(400)]), away, 0, 1), snapshotFor(worldOf([moved]), watching, 0, 1));
  check("a position it does claim to know still is", d2.map((x) => x.field), ["x"]);
  // `remembered` is a fact about the OBSERVER's fog, not about the world. Both sides rebuild
  // their grid on their own 10 Hz clock, so they disagree by one rebuild constantly — skew,
  // not drift. Comparing it puts a finding on the log for every fogged structure on the map
  // several times a second and buries the one line that matters.
  check("whether each side currently has eyes on it is not a disagreement", d.concat(d2).some((x) => x.field === "remembered"), false);
}

console.log("the report is bounded, and a mis-addressed snapshot is not called drift");
{
  const seating = { 0: 0, 1: 1 };
  const v = viewer(0, seating);
  const many = [], none = [];
  for (let i = 1; i <= 40; i++) many.push(unit({ id: i, owner: 0 }));
  const d = divergence(snapshotFor(worldOf(many), v, 0, 1), snapshotFor(worldOf(none), v, 0, 1));
  // A fully desynced world produces one finding per unit per field. A log line per unit per
  // tick is not a diagnostic; the first few are the interesting ones anyway.
  check("capped at the default limit", d.length, 24);
  check("and the cap is configurable", divergence(snapshotFor(worldOf(many), v, 0, 1), snapshotFor(worldOf(none), v, 0, 1), { limit: 3 }).length, 3);

  // Comparing two DIFFERENT recipients' snapshots compares two redactions and would report
  // hundreds of phantom differences. It is one finding, so somebody reads "mis-addressed"
  // instead of hunting a desync that does not exist.
  const forOne = snapshotFor(worldOf(many), viewer(1, seating), 1, 1);
  const mis = divergence(forOne, snapshotFor(worldOf(many), v, 0, 1));
  check("a snapshot for the wrong player is one clear finding", [mis.length, mis[0].field], [1, "recipient"]);
}

console.log("the animation picker answers the same off the payload as off the sim unit");
{
  // The point of item 10c-2b. A host draws its `SimUnit`; a client draws the `UnitSnapshot` it
  // was sent, through the SAME `unitAnims` picker. If the payload drops a field the picker
  // reads -- or renames one, as `repair` was `repairing` until this item -- the client silently
  // falls through to a different clip and every other suite stays green: the snapshot is still
  // a valid snapshot, the picker still returns a number, nothing throws. A worker would just
  // stand there instead of hammering.
  //
  // So this is an EQUIVALENCE, the same shape as the minimap-dot check in item 10c-1: for every
  // state that reaches a different branch, the two structs must pick the same clip. Sentinel
  // sequence numbers make "which branch" readable in the failure output.
  const anims = {
    stand: 1, standVariants: [1], walk: 2, walkFast: 3, attack: 4, attackVariants: [4],
    attackGold: [], attackLumber: [], attackSlam: -1, death: 5,
    standGold: 6, walkGold: 7, standLumber: 8, walkLumber: 9, chopLumber: 10, build: 11,
    decayFlesh: -1, decayBone: -1, morph: -1, seqNames: [],
  };
  const entry = {
    unit: { instance: { timeScale: 1 } }, anims,
    timeScale: 1, curRate: 0, animWalkSpeed: 270, animRunSpeed: 0, baseScale: 1,
  };
  const wep = (dp, bs) => ({
    damage: 12, dice: 1, sides: 3, range: 90, cooldown: 1.5,
    damagePoint: dp, backswing: bs, baseDamagePoint: 0.5, baseBackswing: 0.5,
  });
  // One state per branch of `pickSequence`, plus the two rates.
  const states = {
    "idle, empty-handed": {},
    "walking": { moving: true },
    "carrying gold": { worker: { gold: true, lumber: false, carryGold: 10, carryLumber: 0 } },
    "walking with lumber": { moving: true, worker: { gold: false, lumber: true, carryGold: 0, carryLumber: 20 } },
    "constructing": { constructing: 3 },
    "repairing": { repair: { targetId: 3, hpPerSec: 5, goldPerHp: 0.1, lumberPerHp: 0, active: true } },
    "a building mid-production": { building: { constructionLeft: 0, buildTimeTotal: 60, queue: [{ defId: "hfoo" }], producesUnits: true, rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0 } },
    "chopping": { working: true, order: "harvest" },
    "holding lumber, not chopping": { working: false, order: "return", worker: { gold: false, lumber: true, carryGold: 0, carryLumber: 20 } },
    "hasted mid-swing": { speed: 380, weapon: wep(0.36, 0.36), swingWeapon: wep(0.36, 0.36) },
  };
  for (const [what, over] of Object.entries(states)) {
    const sim = unit({ id: 1, owner: 0, ...over });
    const snap = snapshotFor(worldOf([sim]), viewer(0, { 0: 0 }), 0, 1).units[0];
    const moving = !!sim.moving;
    check(`${what}: same clip`, pickSequence(anims, snap, moving), pickSequence(anims, sim, moving));
    check(`${what}: same attack rate`, attackAnimRate(snap), attackAnimRate(sim));
    check(`${what}: same walk clip and rate`, walkAnim(entry, snap, anims.walk), walkAnim(entry, sim, anims.walk));
  }
  // The matrix is only worth anything if the states really do land on different clips -- a
  // picker that returned 1 for everything would pass every line above.
  const clips = new Set(Object.values(states).map((o) => pickSequence(anims, unit({ id: 1, ...o }), !!o.moving)));
  check("the states reach distinct branches", clips.size >= 7, true);
}

console.log("every number the selection panel prints survives the trip (item 10c-2c-3)");
{
  // The panel reads about two dozen fields off a unit, and on a client it now reads them off
  // the PAYLOAD. If item 5's producer ever stops carrying one, the panel silently prints a
  // zero -- a hero with 0 strength, an empty damage line, a missing armour bonus -- and no
  // other check in this suite notices, because the snapshot is still a valid snapshot and the
  // renderer still renders. This is the list, compared field by field against the sim record
  // it was built from. Adding a field to the panel means adding it here, which is the point.
  const sim = unit({
    id: 1, owner: 0, isHero: true, properName: "Jaina", level: 5,
    hp: 550, maxHp: 700, mana: 210, maxMana: 400,
    armor: 7, bonusArmor: 2, bonusDamage: 6, invulnerable: false,
    xp: 1340, skillPoints: 2,
    str: 21, agi: 17, int: 33, bonusStr: 3, bonusAgi: 0, bonusInt: 6,
    isSummon: false, summonLeft: 0, summonMax: 0,
    weapon: { damage: 29, dice: 1, sides: 3, range: 600, cooldown: 1.35,
              damagePoint: 0.4, backswing: 0.6, baseDamagePoint: 0.4, baseBackswing: 0.6 },
    worker: { gold: false, lumber: false, carryGold: 0, carryLumber: 0 },
    buffs: [{ kind: "slow", group: "Aasl", timeLeft: 4, sourceId: 9, value: 25, value2: 0, art: "", fx: [] }],
  });
  const snap = snapshotFor(worldOf([sim]), viewer(0, { 0: 0 }), 0, 1).units[0];

  const PANEL = ["hp", "maxHp", "mana", "maxMana", "armor", "bonusArmor", "bonusDamage",
    "invulnerable", "isHero", "properName", "level", "xp", "skillPoints",
    "str", "agi", "int", "bonusStr", "bonusAgi", "bonusInt", "owner",
    "isSummon", "summonLeft", "summonMax", "isIllusion"];
  const same = (f) => JSON.stringify(snap[f]) === JSON.stringify(sim[f]);
  check("every scalar the panel prints matches the sim's", PANEL.filter((f) => !same(f)), []);
  // The damage LINE is computed from three weapon numbers the animation half never reads, so
  // widening `RenderWeapon` for the panel is only safe if they actually cross.
  check("the damage line's three numbers cross", [snap.weapon.damage, snap.weapon.dice, snap.weapon.sides], [29, 1, 3]);
  // The status row keys off `kind` and the non-stacking `group`; a buff list that arrived
  // empty would silently drop every icon.
  check("the status row's buffs cross", snap.buffs.map((b) => [b.kind, b.group]), [["slow", "Aasl"]]);
  check("and the carry readout", [snap.worker.carryGold, snap.worker.carryLumber], [0, 0]);
}

console.log("a production queue reaches the panel with what each slot needs");
{
  // Three slot shapes (unit / research / upgrade) flattened into one on the render side. The
  // panel asks each for its kind, what it names, its level (research has per-level art) and
  // its progress -- so those four have to survive, per slot, in order.
  const q = [
    { kind: "unit", unitId: "hfoo", timeLeft: 9, buildTime: 20 },
    { kind: "research", unitId: "Rhme", level: 2, timeLeft: 30, buildTime: 60 },
    { kind: "upgrade", unitId: "hkee", timeLeft: 4, buildTime: 140 },
  ];
  const barracks = unit({
    id: 1, owner: 0,
    building: { constructionLeft: 0, buildTimeTotal: 60, queue: q, producesUnits: true,
                rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0 },
  });
  const snap = snapshotFor(worldOf([barracks]), viewer(0, { 0: 0 }), 0, 1).units[0];
  check("the queue crosses in order, whole", snap.building.queue.map((j) => [j.kind, j.unitId, j.level ?? null, j.timeLeft, j.buildTime]),
    [["unit", "hfoo", null, 9, 20], ["research", "Rhme", 2, 30, 60], ["upgrade", "hkee", null, 4, 140]]);
  // The construction pair drives the build progress bar AND the Birth-clip scrub on the model,
  // so it is read by both halves of the render switch.
  check("and the construction pair with it", [snap.building.constructionLeft, snap.building.buildTimeTotal], [0, 60]);
}

console.log("the three signals a client reads before it collapses a building (item 6d)");
{
  // `onDeath` no longer acts on its own sim's death event alone. It asks the payload for
  // PERMISSION, and the payload answers with the sequence below. This pins the sequence --
  // the renderer half that consumes it lives in rts.ts and no headless test can reach it, so
  // what is under test here is that the host still says these three things in this order.
  const seating = { 0: 0, 1: 1 };
  const tower = unit({
    id: 7, owner: 1, team: 1, typeId: "htow", x: 3000, y: 3000,
    building: { constructionLeft: 0, buildTimeTotal: 60, queue: [], producesUnits: false, rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0 },
  });
  const blind = viewer(0, seating, { fogHides: () => false, fogBlocksClick: () => true, fogBlocksAt: () => true });
  const mem = new GhostMemory();
  mem.noteDestroyed(tower, [{ player: 0, viewer: blind }]);
  // The tower is GONE from the world -- this is the state right after it was razed.
  const gone = worldOf([]);

  const idx = new SnapshotIndex();
  idx.update(snapshotFor(gone, blind, 0, 1, mem.ghostsFor(0)));
  // 1. Still SENT, as a memory. This is the permission `onDeath` reads: the authority minted
  //    an image precisely because this seat had no way to know, so collapsing the model would
  //    be the client volunteering intelligence its own sim happens to hold.
  check("razed out of sight: still sent, flagged as a memory", [idx.unit(7)?.remembered, idx.hidden(7)], [true, false]);
  // 2. And drawn -- an image left standing is the whole point; a hidden ghost is just a leak.
  check("...so the model keeps standing", idx.hidden(7), false);

  // 3. Walk back and look. The host drops the image, and absence is what retires the entry.
  const returned = viewer(0, seating, { fogBlocksAt: () => false });
  mem.forgetSeen(0, returned);
  idx.update(snapshotFor(gone, returned, 0, 2, mem.ghostsFor(0)));
  check("re-scouted: dropped from the payload entirely", idx.unit(7), undefined);
  check("...and absent means hidden, which is what retires the model", idx.hidden(7), true);

  // The contrast case, which is the one that MUST still collapse: a viewer who was watching
  // gets no ghost, so the building is simply absent from the first frame after its death and
  // the client's own death event is free to play out.
  const watcher = viewer(1, seating, { fogHides: () => false, fogBlocksClick: () => false, fogBlocksAt: () => false });
  const seen = new GhostMemory();
  seen.noteDestroyed(tower, [{ player: 1, viewer: watcher }]);
  const idx2 = new SnapshotIndex();
  idx2.update(snapshotFor(gone, watcher, 1, 1, seen.ghostsFor(1)));
  check("razed in front of you: no image, so the collapse plays", idx2.unit(7), undefined);
}

console.log(failed === 0 ? "\nsnapshot: all checks passed" : `\nsnapshot: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
