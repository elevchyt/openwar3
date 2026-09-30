// Wind Walk takes the unit's BODY away (issue #169): a wind-walking unit walks through other
// units, and they walk through it. Plain invisibility does not.
//
// The ability is Wind Walk `[AOwk]` (and the Pandaren's `ANwk`, which is `code = AOwk`), and the
// switch is its "windwalk" buff group (spells.ts SELF_INVIS_GROUP.AOwk) — derived every tick in
// recomputeStats onto `SimUnit.windWalk`, the third owner of `ghosting()`. What this pins:
//
//   1. the press takes the body away at once — with the speed, not after the 0.6 s fade — and
//      hands back the reservation the caster was standing on;
//   2. a wind walker goes THROUGH a corridor another unit is plugging, where it could not before;
//   3. and OTHER units go through a wind walker standing in one, where they could not before;
//   4. the Sorceress's Invisibility / a Potion (`invisible` under any other group) is NOT a ghost;
//   5. when the walk ends, a standing unit takes its ground back.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef, ghosting } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));

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

// A 120x120-cell map with a wall across it at WALL_CY, broken by one gap exactly GAP cells wide
// — as wide as every body in the test (a Blademaster and a Grunt both have collision 32, a
// three-cell footprint), so one body standing in it closes it.
const W = 120, H = 120, CELL = 32;
const WALL_CY = 60, WALL_ROWS = 4, GAP_CX = 58, GAP = 3;
function world() {
  const flags = new Uint8Array(W * H);
  for (let cy = WALL_CY; cy < WALL_CY + WALL_ROWS; cy++)
    for (let cx = 0; cx < W; cx++)
      if (cx < GAP_CX || cx >= GAP_CX + GAP) flags[cy * W + cx] = PathingFlag.Unwalkable | PathingFlag.Unbuildable;
  const grid = new PathingGrid({ width: W, height: H, flags }, [0, 0]);
  return new SimWorld(grid, 1, ABILITIES, undefined, UNITS);
}
const GAP_X = (GAP_CX + GAP / 2) * CELL; // the middle of the gap
const GAP_Y = (WALL_CY + WALL_ROWS / 2) * CELL;
const SOUTH = GAP_Y - 500, NORTH = GAP_Y + 500;

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
/** A Blademaster who knows Wind Walk, with the mana for it. */
function blademaster(w, x, y) {
  const bm = spawn(w, "Obla", x, y, 0, 0);
  bm.abilities = [{ id: "AOwk", code: "AOwk", level: 1, cooldownLeft: 0, autocastOn: false }];
  bm.maxMana = bm.mana = 500;
  return bm;
}
/** A plug: an idle Grunt of ANOTHER player standing in the gap. Another player's, because a
 *  unit makes way for its own owner's units (makeWay) and the point is that it does not move. */
function plug(w) {
  const f = spawn(w, "ogru", GAP_X, GAP_Y, 1, 0);
  run(w, 0.2); // settle onto its cells
  return f;
}
function run(w, seconds) {
  for (let i = 0; i < Math.round(seconds * 20); i++) w.tick(0.05);
}

console.log("the press takes the body away, at once");
{
  const w = world();
  const bm = blademaster(w, GAP_X, SOUTH);
  run(w, 0.2);
  check("a Blademaster standing still holds his ground", [ghosting(bm), bm.hasReservation], [false, true]);
  check("Wind Walk is cast", w.issueCast(bm.id, "AOwk"), true);
  run(w, 0.1); // well inside the 0.6 s Transition Time
  check("…and he is a ghost before the fade has landed", [bm.windWalk, ghosting(bm), bm.invisible], [true, true, false]);
  check("…holding no cells at all", [bm.hasReservation, bm.hasClaim], [false, false]);
}

console.log("\na wind walker goes through a unit that plugs the way");
{
  const w = world();
  const f = plug(w);
  check("the Grunt in the gap holds it", [f.hasReservation, ghosting(f)], [true, false]);
  const walker = blademaster(w, GAP_X, SOUTH);
  w.issueMove(walker.id, GAP_X, NORTH, false);
  run(w, 8);
  check("a Blademaster on foot does not get past it", walker.y < GAP_Y, true);

  const w2 = world();
  plug(w2);
  const ghost = blademaster(w2, GAP_X, SOUTH);
  w2.issueCast(ghost.id, "AOwk");
  run(w2, 0.1);
  w2.issueMove(ghost.id, GAP_X, NORTH, false);
  run(w2, 8);
  check("…a wind walking one walks straight through", Math.abs(ghost.y - NORTH) < 64, true);
}

console.log("\n…and other units go through a wind walker");
{
  const w = world();
  const bm = blademaster(w, GAP_X, GAP_Y);
  run(w, 0.2);
  const grunt = spawn(w, "ogru", GAP_X, SOUTH, 2, 1);
  w.issueMove(grunt.id, GAP_X, NORTH, false);
  run(w, 8);
  check("a Blademaster standing in the gap stops a Grunt", grunt.y < GAP_Y, true);

  const w2 = world();
  const bm2 = blademaster(w2, GAP_X, GAP_Y);
  run(w2, 0.2);
  const [sx, sy] = [bm2.x, bm2.y]; // where he settled
  w2.issueCast(bm2.id, "AOwk");
  run(w2, 0.1);
  const grunt2 = spawn(w2, "ogru", GAP_X, SOUTH, 2, 1);
  w2.issueMove(grunt2.id, GAP_X, NORTH, false);
  run(w2, 8);
  check("…a wind walking one does not", Math.abs(grunt2.y - NORTH) < 64, true);
  check("…and he never moved to let it by", Math.hypot(bm2.x - sx, bm2.y - sy) < 1, true);
  void bm;
}

console.log("\nplain invisibility keeps the body");
{
  const w = world();
  const f = plug(w);
  // The Sorceress's Invisibility and the Potion lay a bare `invisible` (Binv); Shadow Meld's is
  // grouped "shadowmeld". None of them is the "windwalk" group.
  for (const group of ["", "shadowmeld"]) {
    f.buffs = [{ kind: "invisible", group, timeLeft: 60, total: 60, sourceId: f.id, value: 0, value2: 0, art: "", fx: [], buffId: "", delay: 0 }];
    run(w, 0.1);
    check(`an invisible unit (${group || "Binv"}) is still in the way`, [f.invisible, ghosting(f), f.hasReservation], [true, false, true]);
  }
}

console.log("\nthe walk ends, and the body comes back");
{
  const w = world();
  const bm = blademaster(w, GAP_X, SOUTH);
  run(w, 0.2);
  w.issueCast(bm.id, "AOwk");
  run(w, 1);
  check("walking", bm.windWalk, true);
  for (const b of bm.buffs) if (b.group === "windwalk") b.timeLeft = 0.01; // let the clock run out
  run(w, 0.2);
  check("the clock ran out: no longer a ghost", [bm.windWalk, ghosting(bm)], [false, false]);
  check("…and standing still, he holds his ground again", bm.hasReservation, true);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
