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
  Sch5: { id: "Sch5", code: "Acar", order: "", levelData: [{ data: [10] }] }, // Cargo Hold (Ship)
  Slo3: { id: "Slo3", code: "Aloa", order: "load", levelData: [{ data: [] }] }, // the ship's Load button
  Sdro: { id: "Sdro", code: "Adro", order: "unload", levelData: [{ data: [] }] },
  Abun: { id: "Abun", code: "Abun", order: "", levelData: [{ data: [4] }] }, // Cargo Hold (Burrow)
};
const UNITS = {
  etrs: { id: "etrs", abilities: ["Sch5", "Slo3", "Sdro"], moveType: "float" }, // night elf transport ship
  otrb: { id: "otrb", abilities: ["Abun", "Abtl"], moveType: "foot" }, // Orc Burrow
  Eevi: { id: "Eevi", abilities: [], moveType: "foot" }, // Illidan
  hfoo: { id: "hfoo", abilities: [], moveType: "foot" },
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

console.log(failed === 0 ? "\ntransport: all checks passed" : `\ntransport: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
