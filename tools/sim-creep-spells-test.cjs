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

/** No caster at all — for the blocks that drive an ability by hand. */
const caster0 = () => null;

/** Step the world and the creeps' caster together, the way the authority tick does. */
function run(w, caster, seconds) {
  for (let i = 0; i < seconds * 20; i++) {
    if (caster) caster.tick(0.05);
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

// ======================================================================================
//  The five abilities Wowpedia's "Warcraft III creep abilities" page lists that had no
//  implementation at all. Each block quotes that page and names the columns the numbers come
//  from (Units\AbilityMetaData.slk's field groups through UI\WorldEditStrings.txt).
// ======================================================================================

console.log("\nDevour: the creeps' own code, and the Max Creep Level nobody was reading");
{
  // "Consumes a target unit, slowly digesting it and dealing 5 damage per second to it. If
  // the creep is killed while the consumed unit is still digesting, the unit that was
  // devoured will pop out." `Dev1` "Max Creep Level" is DataA on BOTH `Adev` and `ACdv`; the
  // damage is `Advc` DataB (`Dev2` "Damage per Second"), which the creep's Ubertip cites.
  const w = world();
  const dragon = creep(w, "nadr", 1000, 1000); // Blue Dragon: ACdv + the Advc hold
  const f = footman(w, 1060, 1000);
  check("the cast is legal", w.castError(dragon.id, "ACdv", f.id), null);
  w.issueCast(dragon.id, "ACdv", f.id);
  run(w, caster0(w), 2);
  check("the Footman is inside the dragon", f.devouredBy, dragon.id);
  check("…and the dragon is holding it", dragon.devouring, f.id);
  const before = f.hp;
  run(w, null, 4);
  const dps = (before - f.hp) / 4;
  check("…digesting at Advc DataB's 5 a second", Math.round(dps), 5);
  w.kill(dragon);
  check("killing the devourer frees the prey", f.devouredBy, 0);
  check("…alive", f.hp > 0, true);
}
{
  // The Kodo's own row says level 5, so the Dragon (level 10) is refused with the game's own
  // line — `Units\CommandStrings.txt [Errors] Creeptoopowerful` "That creature is too powerful."
  const w = world();
  const kodo = spawn(w, "okod", 1000, 1000, 0, 0);
  const gnoll = creep(w, "ngno", 1060, 1000); // level 1
  const lord = creep(w, "nogl", 1000, 1060); // Ogre Lord, level 7 — and not magic-immune,
  // which the dragons are: `ACmi` refuses a Devour before the level is ever asked about.
  check("a Kodo may swallow a level 1 Gnoll", w.castError(kodo.id, "Adev", gnoll.id), null);
  check("…and not a level 7 Ogre Lord", w.castError(kodo.id, "Adev", lord.id), "Creeptoopowerful");
  const dragon = creep(w, "nadr", 940, 1000);
  check("…and a Dragon is refused for its spell immunity first", w.castError(kodo.id, "Adev", dragon.id), "Immunetomagic");
}

console.log("\nReincarnation: the creep row (`ACrn`), on creeps rather than heroes");
{
  // Wowpedia (Creep): "Centaur Khans, Ancient Wendigos and Ancient Sasquatches come with
  // Reincarnation, reviving themselves, but will permanently die if they are killed before
  // their Reincarnation is reset." `[ACrn] Cool1` is 240.
  const w = world();
  const wendigo = creep(w, "nwna", 1000, 1000);
  const ab = wendigo.abilities.find((a) => a.code === "ACrn");
  check("the Ancient Wendigo carries it", !!ab, true);
  w.landDamage(wendigo, 99999, 0, false);
  check("killed, it is not dead", w.units.has(wendigo.id), true);
  // `[ACrn] Ore1` "Reincarnation Delay" = 7. It is DOWN for that long — one hit point,
  // untouchable, doing nothing, with ReincarnationTarget standing over it.
  check("…it is down for the delay", Math.round(wendigo.reviveT), 7);
  check("…off the field, and so untouchable", wendigo.vanished && wendigo.invulnerable, true);
  check("…and a blow lands nothing on it", (w.landDamage(wendigo, 99999, 0, false), Math.round(wendigo.hp)), 1);
  check("…with the 240-second cooldown running", Math.round(ab.cooldownLeft), 240);
  run(w, null, 7.5);
  check("…and it is on its feet at full health", Math.round(wendigo.hp), Math.round(wendigo.maxHp));
  check("…back on the field", wendigo.vanished, false);
  w.landDamage(wendigo, 99999, 0, false);
  check("killed again before the 240 is up, it stays dead", w.units.has(wendigo.id), false);
}

console.log("\nFrenzy: a self-buff autocast, which no autocast shape reached before");
{
  // "Increases this unit's attack rate by 40% and movement speed by 25%." `Blo1..Blo3` are
  // declared for "Ablo,ACbl,Afzy" together, so Frenzy's columns ARE Bloodlust's.
  const w = world();
  const caster = new CreepCaster(w, ABILITIES);
  const quill = creep(w, "nqb2", 1000, 1000);
  check("its `auto` column arms Frenzy", quill.abilities.find((a) => a.code === "Afzy")?.autocastOn, true);
  run(w, caster, 4);
  check("at rest the quillbeast does not frenzy", buffIdOn(quill, "Bfzy"), false);
  const f = footman(w, 1200, 1000);
  run(w, caster, 6);
  check("in a fight it does", buffIdOn(quill, "Bfzy"), true);
}

console.log("\nHardened Skin: 12 off every attack, never below 3");
{
  // "Reduces all attacks on the unit by 12 damage. Attacks cannot be reduced below 3 damage."
  // `Ssk2` Minimum Damage 3, `Ssk3` Ignored Damage 12. A Footman's 12-13 against the Mountain
  // Giant's 6 medium armour would otherwise land ~9.
  const w = world();
  const giant = spawn(w, "emtg", 1000, 1000, 0, 0);
  const f = spawn(w, "hfoo", 1080, 1000, 1, 1);
  check("the Mountain Giant carries Hardened Skin", giant.abilities.some((a) => a.code === "Assk"), true);
  w.issueAttack(f.id, giant.id, true, true);
  const blows = [];
  let prev = giant.hp;
  for (let i = 0; i < 20 * 12; i++) {
    w.tick(0.05);
    if (giant.hp < prev - 0.01) blows.push(prev - giant.hp);
    prev = giant.hp;
  }
  check("the Footman landed some blows", blows.length > 2, true);
  const perHit = blows.reduce((a, b) => a + b, 0) / Math.max(1, blows.length);
  check("each lands the 3-damage floor, not the ~9 armour alone would leave", Math.round(perHit), 3);
}

console.log("\nPermanent Immolation: alight from birth, on a unit with no mana");
{
  // "Burns nearby enemy units for 10 points of damage per second." `[ANpi] Area1` 220,
  // `DataA` 10, `Cost1`/`DataB` 0 — no toggle, nothing to pay.
  const w = world();
  const inf = creep(w, "ninf", 1000, 1000);
  check("the Infernal has no mana pool", inf.maxMana, 0);
  check("…and is alight anyway", !!inf.immolation, true);
  // Disarmed for the measurement: an Infernal that is also SWINGING at these Footmen makes
  // the burn unreadable (it was 45 a second, most of it a fist).
  inf.weapons = [];
  inf.weapon = null;
  inf.aggroRange = 0;
  const near = footman(w, 1150, 1000); // inside 220
  const far = footman(w, 1600, 1000); // outside it
  // …and both HELD: the burn makes `near` retaliate, and an idle `far` rallies to the fight
  // its ally has started (assistTarget) and walks into the circle it is meant to be outside.
  w.issueHold(near.id);
  w.issueHold(far.id);
  const b0 = near.hp;
  run(w, null, 4);
  check("a Footman beside it burns", near.hp < b0, true);
  check("…at DataA's 10 a second", Math.round((b0 - near.hp) / 4), 10);
  check("…and one out of the circle does not", far.hp, far.maxHp);
  check("the fire is still lit after four seconds of no mana", !!inf.immolation, true);
}

console.log("\nInferno: the meteor is in the air for its Impact Delay, and the crash stuns");
{
  // "Summons an Infernal from the sky, causing area effect damage where it lands."
  // `Uin1..Uin4`: DataA 50 damage, DataB 360 s (the Dreadlord's own `AUin` says 180),
  // DataC **1 s Impact Delay**, UnitID1 `ninf`; `Dur1`/`HeroDur1` 4/2 are the STUN with
  // `BuffID1 = BNin`.
  const w = world();
  const def = ABILITIES.get("ANin");
  check("`ANin` is a point ability with a handler", def && def.target, "point");
  check("…its Impact Delay column reads 1", def.levelData[0].data[2], 1);
  check("…and it summons an Infernal", def.levelData[0].summon, "ninf");
  // The caster is parked far from the victims and the victims are HELD, or they simply walk
  // out from under the meteor — which is the whole point of an impact delay, and cost this
  // test a run to notice.
  const lord = creep(w, "nbal", 1000, 1000);
  lord.aggroRange = 0;
  lord.abilities.push({ id: "ANin", code: "ANin", level: 1, cooldownLeft: 0, autocastOn: false });
  lord.mana = lord.maxMana = 500;
  const f = footman(w, 1700, 1000);
  const f2 = footman(w, 1760, 1000);
  w.issueHold(f.id);
  w.issueHold(f2.id);
  w.issueCast(lord.id, "ANin", 0, 1730, 1000);
  run(w, null, 0.5);
  check("half a second in, the Footmen are untouched", f.hp === f.maxHp && f2.hp === f2.maxHp, true);
  check("…and nothing is owed yet", w.drainSummonRequests().length, 0);
  run(w, null, 1);
  check("a second later they are hurt", f.hp < f.maxHp && f2.hp < f2.maxHp, true);
  check("…by DataA's 50", Math.round(f.maxHp - f.hp), 50);
  check("…and stunned (`BNin`)", buffIdOn(f, "BNin") && buffIdOn(f2, "BNin"), true);
  // The summon is a REQUEST the renderer drains (a headless host never does), so what the
  // sim owes is the request — `ninf`, at the impact point, for DataB.
  const req = w.drainSummonRequests().find((r) => r.unitId === "ninf");
  check("…and an Infernal is owed", !!req, true);
  check("…at the impact point", req && Math.round(req.x), 1730);
  check("…for DataB's 360 seconds", req && Math.round(req.summonLeft), 360);
}

console.log("\nHide takes itself: standing about at night is the whole condition");
{
  // Liquipedia (Hide): "Hiding units lie in wait for enemies without attacking… Units will
  // hold position and hold their fire". `[Ashm] DataA` "Fade Duration" is 1.5, which is the
  // buff's own delay — so a unit is half-there for a second and a half before it is gone.
  const w = world();
  w.timeOfDay = 21; // night
  const crawler = creep(w, "nmrm", 1000, 1000); // Murloc Nightcrawler — `Ashm` on its card
  const archer = spawn(w, "earc", 2000, 2000, 0, 0); // …and every night elf ground unit
  check("the Nightcrawler carries Hide", crawler.abilities.some((a) => a.code === "Ashm"), true);
  run(w, null, 0.5);
  // The FADE: under it, the unit is already under the effect and not yet gone.
  check("half a second in, the Archer is fading rather than gone", archer.cloaked && !archer.invisible, true);
  run(w, null, 2.5); // …the cast's own wind-up, then the 1.5s fade
  check("…and past DataA's 1.5 seconds she is gone", archer.invisible, true);
  check("the Nightcrawler at its post melds too", crawler.invisible, true);
  // A COMMANDED unit does not hide: the meld is what an idle unit does.
  const walker = spawn(w, "earc", 2400, 2000, 0, 0);
  w.issueMove(walker.id, 3400, 2000);
  run(w, null, 2);
  check("one under a move order does not", walker.cloaked, false);
  // …and daybreak takes it off everybody (tickMeld).
  w.timeOfDay = 10;
  run(w, null, 0.5);
  check("dawn ends it", archer.cloaked || crawler.cloaked, false);
  run(w, null, 2);
  check("…and it does not come back by day", archer.cloaked, false);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall creep-spell checks passed");
process.exit(failed ? 1 : 0);
