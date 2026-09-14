// Headless checks on CALL FOR HELP for a PLAYER's units (MiscGame `CallForHelp` = 600) — the
// counterpart of the creeps' own `CreepCallForHelp` shout, which docs/creeps.md covers.
//
// The case that reported it is (4)WarChasers: its monster camps are Player 12's, each a hut
// (`ngnh` Gnoll Hut, `ngt2`, `nmh0`, …) that the script spawns Murlocs beside —
//     call CreateNUnitsAtLoc( 1, udg_SpawnTypes[i], Player(11), GetUnitLoc(udg_MonsterSpawners[i]), … )
// — and a hero chopping the hut from outside the Murlocs' own acquisition range was left alone.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
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
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

const W = 200, H = 200;
function world() {
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  return new SimWorld(grid, 1, ABILITIES, undefined, UNITS);
}
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
    def.isBuilding ? { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: x, rallyY: y - 200, rallyKind: "none", rallyTargetId: 0, producesUnits: false } : null,
    { abilities: [], level: def.level, isPeon: def.classification.includes("peon") },
  );
}
function run(w, seconds, keep) {
  for (let i = 0; i < seconds * 20; i++) {
    w.tick(0.05);
    keep?.();
  }
}
const immortal = (...us) => () => { for (const u of us) u.hp = Math.max(u.hp, u.maxHp * 0.5); };

// The layout every block uses: a hut, a Murloc on its WEST side, and the attacker on its EAST
// side — beyond the Murloc's own acquisition range, well inside 600 of the hut's wall.
function camp(w, murlocOwner = 11, murlocTeam = 1) {
  const hut = spawn(w, "ngnh", 3000, 3000, 11, 1);
  const murloc = spawn(w, "nmrl", 3000 - 520, 3000, murlocOwner, murlocTeam); // 439 off the wall
  const hero = spawn(w, "hfoo", 3000 + 90, 3000, 0, 0); // 548 off the Murloc
  return { hut, murloc, hero };
}

console.log("an attacked building calls its owner's idle units in");
{
  const w = world();
  const { hut, murloc, hero } = camp(w);
  const gap = Math.hypot(hero.x - murloc.x, hero.y - murloc.y) - hero.radius - murloc.radius;
  check("the Footman stands outside the Murloc's own acquisition range", gap > murloc.weapon.acquire, true);
  w.issueAttack(hero.id, hut.id, false, true);
  run(w, 4, immortal(hut, murloc, hero));
  check("the Footman is hitting the hut", hero.targetId, hut.id);
  check("the Murloc answers the hut's call", murloc.order === "attack" && murloc.targetId === hero.id, true);
}

console.log("\n…and not somebody else's, a worker's, or a unit past 600");
{
  const w = world();
  const { hut, murloc, hero } = camp(w, 10, 1); // an ALLY of the hut's owner, not the owner
  const far = spawn(w, "nmrl", 3000, 3000 - 700, 11, 1); // the owner's, but 619 off the wall
  const peon = spawn(w, "hpea", 3000, 3000 + 200, 11, 1);
  w.issueAttack(hero.id, hut.id, false, true);
  run(w, 4, immortal(hut, murloc, hero, far, peon));
  check("an ally's unit is not called", murloc.order, "idle");
  check("the owner's unit 700 off is not called", far.order, "idle");
  check("the owner's worker is not called", peon.order, "idle");
}

console.log("\n…nor one that already has a fight, or holds its ground");
{
  const w = world();
  const { hut, murloc, hero } = camp(w);
  w.issueHold(murloc.id);
  w.issueAttack(hero.id, hut.id, false, true);
  run(w, 4, immortal(hut, murloc, hero));
  check("a Murloc on Hold stays on Hold", murloc.order, "hold");
}

console.log("\na unit calls too, and the helper leashes back afterwards");
{
  const w = world();
  const a = spawn(w, "nmrl", 3000, 3000, 11, 1);
  const b = spawn(w, "nmrl", 2400, 3000, 11, 1); // 538 off its camp-mate
  const hero = spawn(w, "hfoo", 3070, 3000, 0, 0); // 608 off b
  w.issueHold(a.id); // a takes the blows without starting anything itself
  w.issueAttack(hero.id, a.id, false, true);
  run(w, 3, immortal(a, b, hero));
  check("the Murloc 538 off comes to its camp-mate", b.order === "attack" && b.targetId === hero.id, true);
  check("…on a post of its own, so the chase is leashed", b.guarding, true);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall call-for-help checks passed");
