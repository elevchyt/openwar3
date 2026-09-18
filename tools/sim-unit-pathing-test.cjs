// `SetUnitPathing(u, false)` — the SCRIPT's collision switch, and what it has to ignore.
//
// This is the native a campaign walks its cinematics with, and the case that reported it is
// Human01 (The Defense of Strahnbrad). Its `RemoveSlaves` trigger deletes each body of the orc
// caravan as it crosses `RemoveCaravan` — `Rect( -96, 5184, 800, 5408 )` — and every war3map.wpm
// cell under that rect reads `0xce`: the map's black border, Unwalkable and Unflyable both. The
// map gets its caravan there by turning pathing off as it passes `Slave_Collisions`:
//
//     call SetUnitPathing( GetEnteringUnit(), false )          // DisableGruntCollision
//     call IssuePointOrderLocBJ( udg_Escort01, "move", GetRectCenter(gg_rct_RemoveCaravan) )
//
// Read as ordinary ground that order can never complete: the caravan stops at the last walkable
// row, the enter-region trigger never fires, and the two Grunts the cinematic has just shown
// marching off the map are still standing in it when the player gets control back.
//
// So three things are under test, and the third is the one that is easy to miss:
//   1. a ghost walks over unwalkable terrain, the boundary included;
//   2. it stays a ghost across the ordinary orders that clear the sim's own harvester ghost;
//   3. turning it on RE-PLANS the walk in flight — the map flips the switch from an
//      enter-region trigger, seconds after the order was given and already truncated.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef, pathDomain, ghosting } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { simHooks } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "UnitData.slk"))) {
  console.log("skip  no extracted game data (run `pnpm data:extract`)");
  process.exit(0);
}
const vfs = {
  label: "ExtractedData",
  rawBytes(p) {
    let dir = EXTRACT;
    for (const part of p.split("\\")) {
      const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase());
      if (!hit) return null;
      dir = join(dir, hit);
    }
    return new Uint8Array(fs.readFileSync(dir));
  },
  exists: () => false,
  list: () => [],
};
const ABILITIES = loadAbilityRegistry(vfs);
const UNITS = loadUnitRegistry(vfs);

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// A 200x200-cell map (32 world units a cell, origin 0,0) with Strahnbrad's own shape: open
// ground to the south, and from `BORDER_CELL` north the map's unplayable margin — the same
// `Unwalkable | Unflyable | Unbuildable` combination war3map.wpm writes there.
const W = 200, H = 200, CELL = 32;
const BORDER_CELL = 100;
const BORDER = PathingFlag.Unwalkable | PathingFlag.Unflyable | PathingFlag.Unbuildable;
function world() {
  const flags = new Uint8Array(W * H);
  for (let cy = BORDER_CELL; cy < H; cy++) for (let cx = 0; cx < W; cx++) flags[cy * W + cx] = BORDER;
  const grid = new PathingGrid({ width: W, height: H, flags }, [0, 0]);
  return new SimWorld(grid, 1, ABILITIES, undefined, UNITS);
}
const BORDER_Y = BORDER_CELL * CELL; // the first world row inside the margin
let nextId = 1;
function spawn(w, typeId, x, y, owner, team) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  return w.add(
    {
      id: nextId++, owner, team, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying: false, flyHeight: 0,
      sightDay: def.sightDay || 1400, sightNight: def.sightNight || 800,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: "ground", moveType: def.moveType,
      worker: null, depotGold: false, depotLumber: false,
    },
    null,
    { abilities: [], level: def.level, isPeon: def.classification.includes("peon") },
  );
}
function run(w, seconds) {
  for (let i = 0; i < seconds * 20; i++) w.tick(0.05);
}

console.log("a ghost searches the `ghost` domain, and that domain refuses nothing");
{
  const w = world();
  const grunt = spawn(w, "ogru", 1600, BORDER_Y - 200, 12, 1);
  check("an ordinary Grunt is on the ground domain", pathDomain(grunt), "ground");
  check("…and its body is in the way", ghosting(grunt), false);
  w.setPathing(grunt.id, false);
  check("pathing off puts it on the ghost domain", pathDomain(grunt), "ghost");
  check("…and takes its body out of everybody's way", ghosting(grunt), true);
  check("the ghost domain walks the black border", w.grid.walkable(50, BORDER_CELL + 20, "ghost"), true);
  check("…which nothing else does", [
    w.grid.walkable(50, BORDER_CELL + 20, "ground"),
    w.grid.walkable(50, BORDER_CELL + 20, "air"),
  ], [false, false]);
}

console.log("\nthe caravan walks off the map");
{
  const w = world();
  const target = BORDER_Y + 700; // deep inside the margin, as RemoveCaravan's centre is
  const onFoot = spawn(w, "ogru", 1600, BORDER_Y - 400, 12, 1);
  w.issueMove(onFoot.id, 1600, target, false);
  run(w, 20);
  check("a Grunt with pathing ON is stopped by the border", onFoot.y < BORDER_Y, true);

  const ghost = spawn(w, "ogru", 2400, BORDER_Y - 400, 12, 1);
  w.setPathing(ghost.id, false);
  w.issueMove(ghost.id, 2400, target, false);
  run(w, 20);
  check("…and one with pathing OFF arrives", Math.abs(ghost.y - target) < 64 && Math.abs(ghost.x - 2400) < 64, true);
}

console.log("\nthe switch is thrown MID-WALK, as an enter-region trigger throws it");
{
  // Human01's order really does come FIRST — `Orc Cinematic Queue` sends the whole caravan at
  // RemoveCaravan's centre, and `DisableGruntCollision` only fires later, as each body crosses
  // `Slave_Collisions` on the way. So the route every one of them is walking was planned under
  // the old rules and stops where the ground does; the flip has to throw that route away.
  const w = world();
  const target = BORDER_Y + 700;
  const grunt = spawn(w, "ogru", 1600, BORDER_Y - 1600, 12, 1);
  w.issueMove(grunt.id, 1600, target, false);
  run(w, 2);
  check("it is still walking, and still short of the border", grunt.moving && grunt.y < BORDER_Y, true);
  check("…on a route that ends there", w.grid.walkable(...w.grid.worldToCell(grunt.chaseX, grunt.chaseY), "ground"), false);
  w.setPathing(grunt.id, false);
  run(w, 20);
  check("the re-plan carries it the rest of the way", Math.abs(grunt.y - target) < 64, true);
}

console.log("\npathing stays off until the script turns it back on");
{
  const w = world();
  const grunt = spawn(w, "ogru", 1600, 1600, 12, 1);
  w.setPathing(grunt.id, false);
  // Every one of these clears the sim's own `noCollision` ("manual control restores
  // collision"). None of them is the script saying the unit has a body again.
  w.issueMove(grunt.id, 2000, 1600, false);
  check("a move order leaves it a ghost", grunt.pathingOff, true);
  w.stop(grunt.id);
  check("…so does a stop", grunt.pathingOff, true);
  run(w, 2);
  check("…and so does simply walking", grunt.pathingOff, true);
  w.setPathing(grunt.id, true);
  check("SetUnitPathing(true) is what ends it", [grunt.pathingOff, pathDomain(grunt)], [false, "ground"]);
}

console.log("\nthe native reaches the world through the JASS hooks");
{
  const w = world();
  const hooks = simHooks(w, (p) => p);
  const grunt = spawn(w, "ogru", 1600, 1600, 12, 1);
  hooks.setUnitPathing(grunt.id, false);
  check("hooks.setUnitPathing(false) ghosts it", grunt.pathingOff, true);
  hooks.setUnitPathing(grunt.id, true);
  check("…and (true) puts it back", grunt.pathingOff, false);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
