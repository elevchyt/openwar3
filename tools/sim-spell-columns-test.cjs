// Spell handlers against their OWN ROWS: each case here is a handler that used to read the
// wrong column of `Units\\AbilityData.slk` (or a literal where the row has a column), found by
// reading the row beside `AbilityMetaData.slk`'s field names and the ability's Ubertip.
//
// Every unit and ability is built from the install's own rows (`pnpm data:extract`), so each
// number asserted below is the game's column, not a transcription.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry, KNOWN_ABILITIES } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry, autoArmed } = require(join(REPO, ".sim-build", "src", "data", "units.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "AbilityData.slk"))) {
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
    return fs.statSync(dir).isFile() ? new Uint8Array(fs.readFileSync(dir)) : null;
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
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const W = 200, H = 200;
const DT = 1 / 32;
function world() {
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  return new SimWorld(grid, 1, ABILITIES, undefined, UNITS);
}
let nextId = 1;
/** A unit from its own row, as RtsController.buildInitialAbilities lists it — `heroLevel` puts
 *  every hero skill at that rank. */
function spawn(w, typeId, x, y, owner, team, heroLevel = 0) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  const abilities = [];
  for (const id of def.abilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: autoArmed(def, id, a.code) });
  }
  for (const id of def.heroAbilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: heroLevel, cooldownLeft: 0, autocastOn: false });
  }
  const flying = def.moveType === "fly";
  return w.add(
    {
      id: nextId++, owner, team, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying, flyHeight: flying ? def.moveHeight : 0,
      sightDay: def.sightDay || 1400, sightNight: def.sightNight || 800,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: flying ? "air" : "ground", moveType: flying ? "fly" : "foot",
      worker: null, depotGold: false, depotLumber: false, isHero: def.isHero,
    },
    null,
    { abilities, level: def.level, isPeon: def.classification.includes("peon"), building: def.isBuilding ? {} : undefined },
  );
}
const run = (w, secs) => { for (let t = 0; t < secs; t += DT) w.tick(DT); };
const has = (u, code) => u.abilities.some((a) => a.code === code);
const C = 3200; // the middle of the 200×200-cell world (32-unit cells)

/** A hero with mana to spend and nothing in its hands but the spell under test. */
function caster(w, typeId, x, y, level = 1) {
  const u = spawn(w, typeId, x, y, 0, 0, level);
  u.baseMaxMana = u.maxMana = u.mana = 2000;
  u.weapons = [];
  return u;
}
/** A body that stands still and does nothing: only the spell may move its numbers. */
function dummy(w, typeId, x, y, hp = 100000) {
  const u = spawn(w, typeId, x, y, 1, 1);
  u.baseMaxHp = u.maxHp = u.hp = hp;
  u.hpRegen = 0;
  u.speed = 0;
  u.weapons = [];
  for (const a of u.abilities) a.autocastOn = false;
  return u;
}
/** A finished building's state, for a dummy that has to BE one. */
const BUILT = () => ({ constructionLeft: 0, buildTimeTotal: 60, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0, producesUnits: false });
const lvl = (id, rank = 1) => ABILITIES.get(id).levelData[rank - 1];

console.log("Volcano (ANvc): DataB waves of DataE, DataC apart, ×DataD on a building, stunning for Dur (#283)");
{
  const w = world();
  const fire = caster(w, "Nfir", C, C, 1);
  const foot = dummy(w, "hfoo", C + 500, C);
  const hall = dummy(w, "htow", C + 500, C + 250);
  hall.building = BUILT();
  const row = lvl("ANvc");
  check("the row: 8 waves of 100, 5 s apart, ×2 on buildings, 2 s stun", [row.data[1], row.data[4], row.data[2], row.data[3], row.duration, row.heroDuration], [8, 100, 5, 2, 2, 1]);
  check("the press is accepted", w.issueCast(fire.id, "ANvc", 0, foot.x, foot.y + 100), true);
  run(w, 2);
  // Whole waves of 100: the Footman's own trickle of regeneration is rounded away.
  const wavesOn = (u) => Math.round((100000 - u.hp) / 100);
  check("the first wave has landed: DataE = 100", wavesOn(foot), 1);
  check("…a building takes DataD = 2 times that", wavesOn(hall), 2);
  check("…and the unit is stunned", foot.buffs.some((b) => b.kind === "stun"), true);
  run(w, 2);
  check("the stun is Dur1 = 2 s, so it is over before the next wave", foot.buffs.some((b) => b.kind === "stun"), false);
  check("nothing more has landed inside one Wave Interval", wavesOn(foot), 1);
  run(w, 50);
  check("eight waves in all: 800, not 96", wavesOn(foot), 8);
}

console.log("\nFlame Strike (AHfs): the fire runs on Dur1 = 9, whoever cast it (#285)");
{
  const w = world();
  const mage = caster(w, "Hblm", C, C, 1);
  const foot = dummy(w, "hfoo", C + 500, C);
  const row = lvl("AHfs");
  check("the row: Dur 9 / HeroDur 2.67, 15 every 0.33 then 4 every 1", [row.duration, row.heroDuration, row.data[0], row.data[1], row.data[2], row.data[3]], [9, 2.67, 15, 0.33, 4, 1]);
  check("the press is accepted", w.issueCast(mage.id, "AHfs", 0, foot.x, foot.y), true);
  // Find the ignition, then measure from it: the wind-up is the cast's, not the fire's.
  let waited = 0;
  while (foot.hp === 100000 && waited < 5) { w.tick(DT); waited += DT; }
  const lost = () => 100000 - foot.hp;
  run(w, 3.2);
  // Nine full waves (3 s / 0.33) of 15, give or take the Footman's regeneration and the first
  // half-damage tick: the old 2.67-second reading stopped at three waves, 45.
  check("the pillar: about 135 in its 3 seconds, not 45", lost() > 125 && lost() < 145, true);
  const afterPillar = lost();
  run(w, 3);
  check("…and still burning in the second third (Half Damage Dealt, 4 a second)", lost() > afterPillar + 8, true);
  run(w, 6);
  check("about 159 in all (9 × 15 + 6 × 4), not 53", lost() > 145 && lost() < 165, true);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall spell-column checks passed");
