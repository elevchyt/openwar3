// Headless check that the map's creeps USE THEIR ABILITIES — with the real 1.30.4 rows.
//
// Reported as "a lot of creeps are not casting or are completely missing their abilities":
// the Ogre Magi never Bloodlusted, the Forest Troll Trapper never Ensnared, the Murloc
// Nightcrawler's blows carried no poison. None of the effects were missing — every creep
// ability is an alias of an implemented code (`ACbb`/`ACbl` are `Ablo`, `ACen` is `Aens`,
// `ACvs` is `Aven`) — and what was wrong was the WIRING, three times over:
//
//   1. `UnitAbilities.slk`'s `auto` column names the BASE CODE on a creep (`nomg auto=Ablo`
//      with `abilList=ACbb`) and the slot id on a player unit (`hmpr auto=Ahea`), so reading it
//      as a slot id armed nothing on any creep caster (data/units.ts `autoArmed`).
//   2. `[ACen] Requires=Roen` — the creep copies keep the racial upgrade requirement, and a
//      neutral player researches nothing, so the trapper's Ensnare was refused at the gate.
//      A neutral owner meets every requirement (SimWorld.techMeets).
//   3. Nothing ever pressed a creep's NON-autocast buttons at all: the melee AI casts for its
//      seats, and Neutral Hostile has none. `src/ai/creeps.ts` is that caster, gated on the camp
//      being in a fight (SimWorld.creepInFight) — a creep at rest presses nothing.
//
// Every unit here is built from the install's own rows (Units\*.slk + *AbilityFunc.txt via
// `pnpm data:extract`), so the numbers are the game's and not a transcription.
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
const { CreepCaster } = require(join(REPO, ".sim-build", "src", "ai", "creeps.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "AbilityData.slk"))) {
  console.log("skip  no extracted game data (run `pnpm data:extract`)");
  process.exit(0);
}
/** The unpacked install as a DataSource: exactly the files the loaders name, read off disk.
 *  Case-insensitively, as the store itself is — the extractor kept the archive's own casing
 *  (`Units\\unitUI.slk`), and the loaders ask by the game's. */
const vfs = {
  label: "ExtractedData",
  rawBytes(p) {
    const parts = p.split("\\");
    let dir = EXTRACT;
    for (const part of parts) {
      const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase());
      if (!hit) return null;
      dir = join(dir, hit);
    }
    return new Uint8Array(fs.readFileSync(dir));
  },
  exists: () => false, // model variants are the renderer's business
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
  const w = new SimWorld(grid, 1, ABILITIES, undefined, UNITS);
  return w;
}

/** A unit from its own row — the same mapping RtsController.addSimUnit makes, minus what a
 *  headless fight never reads. */
let nextId = 1;
function spawn(w, typeId, x, y, owner, team) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  const abilities = [];
  for (const id of def.abilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: autoArmed(def, id, a.code) });
  }
  const u = w.add(
    {
      id: nextId++, owner, team, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying: false, flyHeight: 0,
      sightDay: def.sightDay || 1400, sightNight: def.sightNight || 800,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: "ground", moveType: "foot",
      worker: null, depotGold: false, depotLumber: false,
    },
    null,
    { abilities, level: def.level, isPeon: def.classification.includes("peon") },
  );
  return u;
}
/** …and a creep, as `trySeed` finishes one: a post where it stands, its type's sleep flag. */
function creep(w, typeId, x, y) {
  const c = spawn(w, typeId, x, y, -1, -1);
  c.isCreep = true;
  c.guardX = c.x;
  c.guardY = c.y;
  c.guardFacing = c.facing;
  c.aggroRange = c.weapon?.acquire ?? 0;
  c.canSleep = false; // daylight throughout; the sleep test is sim-creep-sleep-test.cjs
  return c;
}
const footman = (w, x, y) => spawn(w, "hfoo", x, y, 0, 0);
const buffOn = (u, kind) => u.buffs.some((b) => b.kind === kind);
const buffIdOn = (u, id) => u.buffs.some((b) => b.buffId && b.buffId.toLowerCase() === id.toLowerCase());

/** Step the world and the creeps' caster together, the way the authority tick does. */
function run(w, caster, seconds) {
  for (let i = 0; i < seconds * 20; i++) {
    caster.tick(0.05);
    w.tick(0.05);
  }
}

console.log("the `auto` column arms a creep's autocast at birth");
{
  const w = world();
  const magi = creep(w, "nomg", 1000, 1000);
  const bl = magi.abilities.find((a) => a.code === "Ablo");
  check("the Ogre Magi carries Bloodlust (`ACbb`, code Ablo)", bl?.id, "ACbb");
  check("…and it is armed, because `auto=Ablo` names its code", bl?.autocastOn, true);
  const geo = creep(w, "nkog", 1200, 1000);
  check("the Kobold Geomancer's Slow (`ACsw`, `auto=Aslo`) likewise", geo.abilities.find((a) => a.code === "Aslo")?.autocastOn, true);
  const priest = creep(w, "ndtp", 1400, 1000);
  check("the Dark Troll Shadow Priest's Heal (`Anh1`, `auto=Anhe`) likewise", priest.abilities.find((a) => a.code === "Anhe")?.autocastOn, true);
  const trapper = creep(w, "nftt", 1600, 1000);
  check("the Forest Troll Trapper's Ensnare (`ACen`) is not — its `auto` is `_`", trapper.abilities.find((a) => a.code === "Aens")?.autocastOn, false);
  const raider = spawn(w, "orai", 1800, 1000, 0, 0);
  check("a player unit still reads the column as before (the Raider arms nothing)", raider.abilities.some((a) => a.autocastOn), false);
}

console.log("\na neutral owner meets every requirement");
{
  const w = world();
  const trapper = creep(w, "nftt", 1000, 1000);
  check("`[ACen] Requires=Roen` does not gate a creep's Ensnare", w.techMeets(trapper.owner, "ACen"), true);
  check("…and the cast is not refused for it", w.castUseError(trapper.id, "Aens"), null);
}

console.log("\nthe Ogre Magi Bloodlusts a camp-mate in a fight, and not at rest");
{
  const w = world();
  const caster = new CreepCaster(w, ABILITIES);
  const magi = creep(w, "nomg", 1000, 1000);
  const ogre = creep(w, "nogr", 1100, 1000);
  run(w, caster, 6);
  check("a camp at rest wears no Bloodlust", buffIdOn(ogre, "Bblo") || buffIdOn(magi, "Bblo"), false);
  const f = footman(w, 1400, 1000); // inside the Ogre's 500 acquisition
  run(w, caster, 8);
  check("the camp turned on the Footman", ogre.order === "attack" && ogre.targetId === f.id, true);
  check("…and the Magi Bloodlusted somebody in the fight", buffIdOn(ogre, "Bblo") || buffIdOn(magi, "Bblo"), true);
}

console.log("\nthe Forest Troll Trapper Ensnares what ENTERS its reach, not what was already there");
{
  // warcraft3.info 176: "Ensnare is cast on non-hero units that enter the creep's cast range…
  // If a unit is within the cast range while the camp is being started, it therefore won't be
  // ensnared." `[ACen] Rng1` is 500: the puller stands inside it, the reinforcement walks in.
  const w = world();
  const caster = new CreepCaster(w, ABILITIES);
  const trapper = creep(w, "nftt", 1000, 1000);
  creep(w, "nftr", 1080, 1000);
  const puller = footman(w, 1450, 1000);
  const late = footman(w, 1900, 1000); // outside 500 of the trapper when the fight starts
  w.issueHold(late.id); // …and held there, or it rallies to the puller's fight on its own
  const keep = () => { for (const u of [puller, late]) u.hp = Math.max(u.hp, 300); }; // nobody dies: a death ends the fight and resets the rule
  const runKeeping = (secs) => { for (let i = 0; i < secs * 20; i++) { caster.tick(0.05); w.tick(0.05); keep(); } };
  runKeeping(3);
  check("the camp is fighting the puller", trapper.order === "attack" || w.creepInFight(trapper), true);
  check("…who was inside Ensnare's reach when it began and is NOT ensnared", buffOn(puller, "root"), false);
  w.issueMove(late.id, 1300, 1000);
  runKeeping(8);
  check("the Footman who walked in afterwards is", buffOn(late, "root"), true);
  check("…and the puller still is not", buffOn(puller, "root"), false);
}

console.log("\nthe Murloc Nightcrawler's blows poison");
{
  const w = world();
  const caster = new CreepCaster(w, ABILITIES);
  const nc = creep(w, "nmrm", 1000, 1000);
  const f = footman(w, 1200, 1000);
  run(w, caster, 8);
  check("the Footman carries the Envenomed Weapons poison", buffOn(f, "dot"), true);
  check("…and the Nightcrawler is the source", f.buffs.some((b) => b.kind === "dot" && b.sourceId === nc.id), true);
}

console.log("\na deliberate cast: the Harpy Queen Cyclones, once the camp is roused");
{
  const w = world();
  const caster = new CreepCaster(w, ABILITIES);
  const queen = creep(w, "nhrq", 1000, 1000);
  // Cyclone `[ACcy] Rng1` reaches well past her 500 acquisition: a Footman standing at 650
  // is a legal target and NOT a fight.
  const f = footman(w, 1650, 1000);
  // (A Cyclone is worn as its own buff id `Bcyc` — the sim files it under the `invuln` kind,
  // since spinning in the air is what it does to the target.)
  run(w, caster, 6);
  check("a Footman outside her aggro range is not Cycloned", buffIdOn(f, "Bcyc"), false);
  check("…and she has not moved to fight him", queen.order, "idle");
  const f2 = footman(w, 1400, 1000);
  run(w, caster, 8);
  check("once the camp is in a fight somebody is Cycloned", buffIdOn(f, "Bcyc") || buffIdOn(f2, "Bcyc"), true);
}

console.log("\nthe Troll Priest heals a hurt camp-mate out of combat, and nothing else at rest");
{
  const w = world();
  const caster = new CreepCaster(w, ABILITIES);
  const priest = creep(w, "ndtp", 1000, 1000);
  const troll = creep(w, "ndtr", 1100, 1000);
  troll.hp = 100;
  run(w, caster, 4);
  check("the Dark Troll was healed at the post", troll.hp > 100, true);
  const geoW = world();
  const geoCaster = new CreepCaster(geoW, ABILITIES);
  const geo = creep(geoW, "nkog", 1000, 1000);
  geo.aggroRange = 300; // a "Camp" creep with the map's tighter acquisition
  const passer = footman(geoW, 1550, 1000); // inside Slow's reach + search, outside 300
  run(geoW, geoCaster, 6);
  check("the Geomancer does not Slow a passer-by the camp is not fighting", buffOn(passer, "slow"), false);
  check("…nor walk out after him", geo.order, "idle");
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall creep-spell checks passed");
process.exit(failed ? 1 : 0);
