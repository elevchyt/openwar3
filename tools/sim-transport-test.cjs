// Headless check of CARGO HOLDS — a unit getting into a transport, riding it, and getting out,
// plus the `EVENT_UNIT_LOADED` the campaign sails its ship on.
//
// Terror of the Tides, chapter one, is what this is for. Its harbour cinematic ends with
//
//     call IssueTargetOrderBJ( udg_Illidan, "board", gg_unit_e000_0034 )
//
// and the ship leaves on a trigger registered as
//
//     call TriggerRegisterUnitEvent( gg_trg_Ships_Sails, gg_unit_Eevi_0030, EVENT_UNIT_LOADED )
//
// — i.e. on the PASSENGER, not on the boat. We had the burrow's half of this mechanism only
// (`Abun`, workers, four of them), so "board" fell through the target-order funnel to *follow*,
// Illidan trailed the boat forever, the LOADED event never fired and the scene never ended.
//
// The hold a transport carries is the same ability family told apart by its `code` column
// (AbilityData.slk): `Abun` is the burrow's, `Acar` the transport's — `Sch5` "Cargo Hold (Ship)"
// Dataa1 = 10 on every transport ship (hbot/obot/nbot/etrs/ubot), `Sch3` = 8 on the zeppelin.
// The other "Cargo Hold" rows are different mechanisms and deliberately not this: `Advc` Devour,
// `Sch2` the Meat Wagon's corpse bin, `Aenc` a Gold Mine's crew.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { Authority } = require(join(REPO, ".sim-build", "src", "game", "authority.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// The two data rows this rests on, as the SLKs have them.
const ABILITIES = {
  Sch5: { id: "Sch5", code: "Acar", order: "", levelData: [{ data: [10], area: 250, duration: 0.5 }] }, // Cargo Hold (Ship)
  Sch3: { id: "Sch3", code: "Acar", order: "", levelData: [{ data: [8], area: 250, duration: 0.5 }] }, // Cargo Hold (Transport) — the Zeppelin
  Slo3: { id: "Slo3", code: "Aloa", order: "load", levelData: [{ data: [] }] }, // the ship's Load button
  Aloa: { id: "Aloa", code: "Aloa", order: "load", levelData: [{ data: [] }] }, // …and the Zeppelin's
  Sdro: { id: "Sdro", code: "Adro", order: "unload", levelData: [{ data: [] }] },
  Adro: { id: "Adro", code: "Adro", order: "unload", levelData: [{ data: [] }] },
  Abun: { id: "Abun", code: "Abun", order: "", levelData: [{ data: [4], area: 250 }] }, // Cargo Hold (Burrow)
};
const UNITS = {
  etrs: { id: "etrs", abilities: ["Sch5", "Slo3", "Sdro"], moveType: "float" }, // night elf transport ship
  nzep: { id: "nzep", abilities: ["Sch3", "Achd", "Aloa", "Adro"], moveType: "fly" }, // Goblin Zeppelin
  otrb: { id: "otrb", abilities: ["Abun", "Abtl"], moveType: "foot" }, // Orc Burrow
  Eevi: { id: "Eevi", abilities: [], moveType: "foot" }, // Illidan
  hfoo: { id: "hfoo", abilities: [], moveType: "foot" },
  hmtm: { id: "hmtm", abilities: [], moveType: "foot", cargoSize: 2 }, // Mortar Team — two seats
};
const abilities = { get: (id) => ABILITIES[id] };
const unitReg = { get: (id) => UNITS[id] };

// Land on the left, sea on the right, as the map's own wpm spells them: 0x40 is open land
// (NoWater set — no boat), 0x0a is deep water (Unwalkable set — no Footman).
const LAND = 0x40, SEA = 0x0a;
const FLAGS = new Uint8Array(64 * 64).fill(LAND);
for (let cy = 0; cy < 64; cy++) for (let cx = 32; cx < 64; cx++) FLAGS[cy * 64 + cx] = SEA;
const grid = new PathingGrid({ width: 64, height: 64, flags: FLAGS }, [0, 0]);
const world = new SimWorld(grid, 1, abilities, undefined, unitReg);

console.log("the sea is ground to a boat and a wall to a Footman, and the shore is the reverse");
{
  const shore = [31, 10], sea = [40, 10];
  check("a Footman may stand ashore", grid.walkable(shore[0], shore[1]), true);
  check("…and not at sea", grid.walkable(sea[0], sea[1]), false);
  check("a boat may float at sea", grid.walkable(sea[0], sea[1], "water"), true);
  check("…and not ashore", grid.walkable(shore[0], shore[1], "water"), false);
}

let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, typeId: "hfoo", owner: 0, team: 0, hp: 500, maxHp: 500, x: 512, y: 512,
    prevX: 512, prevY: 512, radius: 16, facing: 0, desiredFacing: 0,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0,
    inventory: [], buffs: [], footprint: 1, hasReservation: false, abilities: [],
    orderQueue: [], order: "idle", targetId: null, followLeaderId: null, path: [], waypoint: 0,
    moving: false, inCombat: false, noCollision: false, stuckT: 0, stuckRetries: 0, acquireT: 0,
    pendingCast: null, weapons: [], weapon: null, flying: false, building: null, worker: null,
    inBurrow: false, garrisonHost: 0, garrison: [], garrisonCap: 0,
    unloadX: 0, unloadY: 0, unloadT: 0, cargoSize: 1, repathT: 0, chaseX: 0, chaseY: 0, waitT: 0,
    baseArmor: 0, baseMaxHp: 500, baseMaxMana: 0, baseSpeed: 270, baseSight: 1400,
    maxMana: 0, mana: 0, speed: 270, turnRate: 0.6, paused: false,
    ...over,
  };
  // `garrisonCap` is computed at spawn time in the real path (addUnit -> computeGarrisonCap);
  // these units are hand-built like every other sim test's, so ask for it explicitly. That
  // also puts the capacity derivation itself under test rather than a copied constant.
  if (u.garrisonCap === 0) u.garrisonCap = world.computeGarrisonCap(u.typeId);
  world.units.set(u.id, u);
  return u;
}

console.log("a transport's capacity comes off its own Cargo Hold row");
{
  check("a transport ship holds Sch5's ten", world.computeGarrisonCap("etrs"), 10);
  check("an Orc Burrow still holds Abun's four", world.computeGarrisonCap("otrb"), 4);
  check("a Footman has no hold at all", world.computeGarrisonCap("hfoo"), 0);
}

console.log("Illidan boards the ship, and the LOADED event fires on HIM");
{
  world.captureLoads = true;
  const ship = unit({ typeId: "etrs", x: 1100, y: 512, radius: 48, owner: 2 });
  const illidan = unit({ typeId: "Eevi", x: 1000, y: 512, owner: 8 });
  check("the ship has room", ship.garrisonCap, 10);
  check("board took", world.issueGarrison(illidan.id, ship.id), true);
  check("he is aboard", illidan.inBurrow, true);
  check("…on the ship's roster", ship.garrison, [illidan.id]);
  check("…and knows his host", illidan.garrisonHost, ship.id);
  const loads = world.drainLoadEvents();
  check("one LOADED event", loads.length, 1);
  check("GetLoadedUnit is the passenger", loads[0] && loads[0].unit.id, illidan.id);
  check("GetTransportUnit is the ship", loads[0] && loads[0].transport.id, ship.id);
  check("drained — it does not fire twice", world.drainLoadEvents().length, 0);

  // The ship sails: its cargo goes with it, or the passenger would be put ashore wherever
  // he happened to step aboard.
  ship.x = 1400;
  ship.y = 900;
  world.tick(1 / 60);
  check("the passenger rode along", [illidan.x, illidan.y], [1400, 900]);

  check("unload took", world.unloadBurrow(ship.id), true);
  check("he is ashore", illidan.inBurrow, false);
  check("the hold is empty", ship.garrison, []);
  // Put ashore on the nearest LAND to where the ship is NOW — not dropped in the sea, and
  // not left behind at the dock he boarded from (the whole point of carrying him along).
  const ashore = grid.worldToCell(illidan.x, illidan.y);
  check("…he is standing on land", grid.walkable(ashore[0], ashore[1]), true);
  check("…nearer the ship's new berth than the dock he boarded from", Math.hypot(illidan.x - ship.x, illidan.y - ship.y) < Math.hypot(1000 - ship.x, 512 - ship.y), true);
}

console.log("a burrow is still workers-only; a transport is not");
{
  const burrow = unit({ typeId: "otrb", x: 300, y: 300, radius: 48, building: { constructionLeft: 0, queue: [] } });
  const footman = unit({ typeId: "hfoo", x: 320, y: 300 });
  check("a Footman may not man a burrow", world.issueGarrison(footman.id, burrow.id), false);
  footman.x = 1000;
  const ship = unit({ typeId: "etrs", x: 1080, y: 300, radius: 48 });
  check("…but may board a ship", world.issueGarrison(footman.id, ship.id), true);
  world.unloadBurrow(ship.id);
}

console.log("a hold takes nobody hostile, nothing flying, and no buildings");
{
  const ship = unit({ typeId: "etrs", x: 1080, y: 700, radius: 48, owner: 0, team: 0 });
  const flier = unit({ typeId: "hfoo", x: 1000, y: 700, flying: true });
  check("a flier can't board", world.issueGarrison(flier.id, ship.id), false);
  const hall = unit({ typeId: "hfoo", x: 1000, y: 700, building: { constructionLeft: 0, queue: [] } });
  check("a building can't board", world.issueGarrison(hall.id, ship.id), false);
  const enemy = unit({ typeId: "hfoo", x: 1000, y: 700, owner: 3, team: 3 });
  check("an enemy can't board", world.issueGarrison(enemy.id, ship.id), false);
}

console.log("the order funnel routes board / load / unload");
{
  const authority = new Authority(world, unitReg, abilities, undefined, undefined);
  const ship = unit({ typeId: "etrs", x: 1080, y: 1500, radius: 48 });
  const rider = unit({ typeId: "hfoo", x: 1000, y: 1500 });
  // "board" is the passenger's own order — the spelling the campaign uses.
  check('IssueTargetOrder(u, "board", ship)', authority.issueUnitOrder(rider.id, 0, "board", "target", 0, 0, ship.id), true);
  check("…and he is aboard", ship.garrison, [rider.id]);
  // "unload" is the carrier's, and it is an immediate order.
  check('IssueImmediateOrder(ship, "unload")', authority.issueUnitOrder(ship.id, 0, "unload", "immediate", 0, 0, 0), true);
  check("…the hold emptied", ship.garrison, []);
  // "load" is the carrier's target order — the Load button on the ship, aimed at a passenger.
  // It must NOT be swallowed by castOrder as the ship's own `Slo3` ability (Order=load).
  check('IssueTargetOrder(ship, "load", u)', authority.issueUnitOrder(ship.id, 0, "load", "target", 0, 0, rider.id), true);
  check("…and he is aboard again", ship.garrison, [rider.id]);
}

console.log("…and then the ship SAILS — the other half of the scene");
{
  // `movetype=float` is what says so, and it is read off the type at spawn (SimUnit.waterborne).
  const ship = world.add(
    {
      id: 900, typeId: "etrs", owner: 0, team: 0, race: "nightelf", x: 1200, y: 1200,
      prevX: 1200, prevY: 1200, facing: 0, speed: 270, turnRate: 0.6, radius: 48, flying: false,
      flyHeight: 0, sightDay: 1400, sightNight: 1400, hp: 500, maxHp: 500, mana: 0, maxMana: 0,
      armor: 0, baseArmor: 0, baseMaxHp: 500, baseMaxMana: 0, baseSpeed: 270,
      weapons: [], attackType: "normal", armorType: "medium", food: 0, foodMade: 0,
      goldCost: 0, lumberCost: 0, buildTime: 0, worker: null, abilities: [], buffs: [],
      inventory: [], footprint: 4, hasReservation: false, detectRadius: 0, isSummon: false,
      depotGold: false, depotLumber: false,
    },
    null,
  );
  check("the ship knows it floats", ship.waterborne, true);
  // Out to sea: a course no ground unit could walk, over cells its own domain calls open.
  check("a move order over open water took", world.issueMove(ship.id, 1900, 1600), true);
  for (let i = 0; i < 240; i++) world.tick(1 / 60);
  check("…and it actually sailed", Math.hypot(ship.x - 1900, ship.y - 1600) < 200, true);
  // Its own domain is also its wall. Ordered ashore it does what WC3's does — sails as close
  // as the water goes and stops there. What it must never do is drive up the beach.
  world.issueMove(ship.id, 300, 300);
  for (let i = 0; i < 600; i++) world.tick(1 / 60);
  const berth = grid.worldToCell(ship.x, ship.y);
  check("…ordered ashore, it stops at the water's edge", grid.walkable(berth[0], berth[1], "water"), true);
  check("…and never beaches itself", grid.walkable(berth[0], berth[1]), false);
}

// --- issue #128: the Goblin Zeppelin, played rather than scripted -----------------------
// A transport goes to MEET what it was told to load, puts one unit off per click on its slot
// and only where there is ground under it, unloads everybody AT A POINT one body at a time,
// and a passenger keeps living (and dying) inside it. docs/transports.md.

/** The land half of the map is x < 1024. A Zeppelin is placed as a FLYER — flying: true is
 *  what pathTo reads (a straight line, no grid) — and a ship as WATERBORNE. */
const zeppelin = (over) => unit({ typeId: "nzep", radius: 48, flying: true, ...over });
const ticks = (n) => { for (let i = 0; i < n; i++) world.tick(1 / 60); };

console.log("Load: the Zeppelin and its passenger walk towards each other");
{
  const zep = zeppelin({ x: 900, y: 1800 });
  const foot = unit({ typeId: "hfoo", x: 200, y: 1800 });
  check("the Zeppelin is a transport", world.isTransport(zep), true);
  check("…with eight seats", world.holdRoom(zep), 8);
  check("Load took", world.issueLoad(zep.id, foot.id), true);
  check("the passenger is walking to it", [foot.order, foot.targetId], ["garrison", zep.id]);
  check("…and the Zeppelin is going to meet him", [zep.order, zep.targetId, zep.moving], ["load", foot.id, true]);
  let t = 0;
  while (!foot.inBurrow && t < 600) { world.tick(1 / 60); t++; }
  check("he boarded within ten seconds", foot.inBurrow, true);
  check("…somewhere in the MIDDLE: the Zeppelin came west", zep.x < 800, true);
  check("…and the Footman came east", foot.x > 300, true);
  // Both at the same speed, so they met about halfway — neither did the whole walk.
  check("…about halfway between them", Math.abs(zep.x - 550) < 150, true);
  world.tick(1 / 60); // the transport notices on its own next tick that nobody else is coming
  check("the Zeppelin is idle again, cargo aboard", [zep.order, zep.garrison], ["idle", [foot.id]]);
  world.unloadBurrow(zep.id);
}

console.log("a right-click board also fetches an IDLE transport — and never a busy one");
{
  const zep = zeppelin({ x: 900, y: 1700 });
  const foot = unit({ typeId: "hfoo", x: 200, y: 1700 });
  check("board took", world.issueGarrison(foot.id, zep.id), true);
  check("the idle Zeppelin set off to meet him", zep.order, "load");
  world.stop(zep.id);
  world.stop(foot.id);
  check("a Zeppelin already going somewhere…", world.issueMove(zep.id, 900, 200), true);
  check("…takes the boarding…", world.issueGarrison(foot.id, zep.id), true);
  check("…and keeps its own order", zep.order, "move");
  world.stop(zep.id);
  world.stop(foot.id);
}

console.log("a slot click puts ONE passenger off — only where it can stand");
{
  const zep = zeppelin({ x: 600, y: 1500 });
  const a = unit({ typeId: "hfoo", x: 600, y: 1500 });
  const b = unit({ typeId: "hfoo", x: 600, y: 1500 });
  world.issueGarrison(a.id, zep.id);
  world.issueGarrison(b.id, zep.id);
  check("two aboard", zep.garrison, [a.id, b.id]);
  // Out over the lake: nothing to stand on within the hold's 250 units.
  zep.x = 1700;
  world.tick(1 / 60);
  check("over deep water, the click does nothing", world.unloadOne(zep.id, a.id), false);
  check("…and both are still aboard", zep.garrison, [a.id, b.id]);
  // Back over land: that one, and only that one, steps off beside the Zeppelin.
  zep.x = 600;
  world.tick(1 / 60);
  check("over land, the click puts him down", world.unloadOne(zep.id, a.id), true);
  check("…him alone", zep.garrison, [b.id]);
  check("…on the ground", a.inBurrow, false);
  const cell = grid.worldToCell(a.x, a.y);
  check("…standing on land", grid.walkable(cell[0], cell[1]), true);
  check("…within the hold's Area1 of the Zeppelin", Math.hypot(a.x - zep.x, a.y - zep.y) <= 250, true);
  check("a unit that is not aboard cannot be unloaded", world.unloadOne(zep.id, a.id), false);
  world.unloadBurrow(zep.id);
}

console.log("Unload All is a POINT order: fly there, then one body per half second");
{
  const zep = zeppelin({ x: 600, y: 1200 });
  const riders = [unit({ typeId: "hfoo", x: 600, y: 1200 }), unit({ typeId: "hfoo", x: 600, y: 1200 }), unit({ typeId: "hfoo", x: 600, y: 1200 })];
  for (const r of riders) world.issueGarrison(r.id, zep.id);
  check("three aboard", zep.garrison.length, 3);
  check("Unload All at a point took", world.issueUnloadAt(zep.id, 300, 900), true);
  check("…the Zeppelin is on its way", [zep.order, zep.moving], ["unload", true]);
  const dropTick = [];
  let last = 3;
  for (let t = 0; t < 900 && zep.garrison.length > 0; t++) {
    world.tick(1 / 60);
    if (zep.garrison.length < last) { dropTick.push(t); last = zep.garrison.length; }
  }
  check("everybody came out", zep.garrison, []);
  check("…at the point it was sent to", Math.hypot(zep.x - 300, zep.y - 900) < 60, true);
  check("…one at a time — three drops", dropTick.length, 3);
  check("…half a second apart (Sch3 Dur1)", dropTick.length === 3 && dropTick[1] - dropTick[0] >= 29 && dropTick[2] - dropTick[1] >= 29, true);
  check("…each within the hold's reach of the Zeppelin", riders.every((r) => Math.hypot(r.x - zep.x, r.y - zep.y) <= 250), true);
  world.tick(1 / 60); // an empty hold ends the order on the next tick
  check("…and the order is done", zep.order, "idle");
  check("with nobody aboard, Unload All is refused", world.issueUnloadAt(zep.id, 300, 900), false);
}

console.log("…and Unload All over the lake flies there, finds no ground, and keeps its cargo");
{
  const zep = zeppelin({ x: 600, y: 600 });
  const r = unit({ typeId: "hfoo", x: 600, y: 600 });
  world.issueGarrison(r.id, zep.id);
  check("sent out over the water", world.issueUnloadAt(zep.id, 1750, 600), true);
  for (let t = 0; t < 900 && zep.order === "unload"; t++) world.tick(1 / 60);
  check("it got there", Math.hypot(zep.x - 1750, zep.y - 600) < 60, true);
  check("the order ended", zep.order, "idle");
  check("…with the passenger still aboard", [zep.garrison, r.inBurrow], [[r.id], true]);
  zep.x = 600;
  world.unloadBurrow(zep.id);
}

console.log("a ship lands its party on the beach — never in the surf, never inland");
{
  // Sea is x >= 1024; a ship out at x = 1500 with a passenger, told to unload at a point on
  // the sand. It sails to the water's edge (findPath snaps the goal) and unloads from there.
  const ship = unit({ typeId: "etrs", x: 1500, y: 400, radius: 48, waterborne: true, footprint: 2 });
  const foot = unit({ typeId: "hfoo", x: 1500, y: 400 });
  world.issueGarrison(foot.id, ship.id);
  check("aboard", ship.garrison, [foot.id]);
  check("…and at sea, no unload — nothing but water within 250", world.unloadOne(ship.id, foot.id), false);
  check("Unload All at the beach took", world.issueUnloadAt(ship.id, 900, 400), true);
  for (let t = 0; t < 1200 && ship.garrison.length > 0; t++) world.tick(1 / 60);
  check("the passenger is ashore", [ship.garrison, foot.inBurrow], [[], false]);
  const berth = grid.worldToCell(ship.x, ship.y);
  check("…the ship is still afloat", grid.walkable(berth[0], berth[1], "water"), true);
  const sand = grid.worldToCell(foot.x, foot.y);
  check("…and he is standing on land", grid.walkable(sand[0], sand[1]), true);
  check("…beside the ship", Math.hypot(foot.x - ship.x, foot.y - ship.y) <= 250 + 64, true);
}

console.log("a passenger goes on living inside — and dying");
{
  const zep = zeppelin({ x: 600, y: 300 });
  const a = unit({ typeId: "hfoo", x: 600, y: 300 });
  const b = unit({ typeId: "hfoo", x: 600, y: 300 });
  world.issueGarrison(a.id, zep.id);
  world.issueGarrison(b.id, zep.id);
  // The sim's clocks do not stop at the door: a poison ticking on him keeps ticking. The
  // plain fact under it is that a unit aboard can lose hit points and reach zero.
  a.hp = 0;
  world.killUnit(a.id);
  check("he died aboard — the hold let go of him", zep.garrison, [b.id]);
  check("…and the other is still riding", b.inBurrow, true);
  world.unloadBurrow(zep.id);
}

console.log("seats, not heads: a Mortar Team takes two of the eight");
{
  const zep = zeppelin({ x: 600, y: 200 });
  const mortars = [];
  for (let i = 0; i < 4; i++) {
    const m = unit({ typeId: "hmtm", x: 600, y: 200, cargoSize: 2 });
    check(`mortar ${i + 1} boards`, world.issueGarrison(m.id, zep.id), true);
    mortars.push(m);
  }
  check("four Mortar Teams fill it", world.holdRoom(zep), 0);
  const fifth = unit({ typeId: "hfoo", x: 600, y: 200 });
  check("…and a Footman is refused — Cargo capacity unavailable", world.issueGarrison(fifth.id, zep.id), false);
  world.unloadOne(zep.id, mortars[0].id);
  check("one Mortar Team off frees two seats", world.holdRoom(zep), 2);
  check("…which the Footman now takes", world.issueGarrison(fifth.id, zep.id), true);
  world.unloadBurrow(zep.id);
}

console.log(failed === 0 ? "\ntransport: all checks passed" : `\ntransport: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
