// Headless check of the stock abilities the engine used to DROP as unknown codes — the melee
// units' own buttons (Taunt, War Club, Sentinel, Spell Steal, Mana Flare, Phoenix Fire, the
// research-gated attack passives, Mount/Dismount, Wander…) and the campaign Dreadlord's two, which
// "Bleach vs One Piece" and "Balanced Hero Survival" build on (docs/map-compatibility.md "Stock
// abilities a map hands out").
//
// Every unit is built from the install's own rows (Units\*.slk + *AbilityFunc.txt via
// `pnpm data:extract`), so each number asserted below is the game's column, not a transcription.
// No tech tree is wired into these worlds, so every `Requires` reads as met — which is what lets
// the research-gated passives be exercised without researching them.
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

console.log("the units carry them now (buildInitialAbilities keeps only KNOWN codes)");
{
  const w = world();
  const carries = (type, code) => has(spawn(w, type, C, C, 0, 0, 1), code);
  check("Mountain Giant: Taunt and War Club", [carries("emtg", "Atau"), carries("emtg", "Agra")], [true, true]);
  check("Huntress: Sentinel; Spell Breaker: Spell Steal; Faerie Dragon: Mana Flare", [carries("esen", "Aesn"), carries("hspt", "Asps"), carries("efdr", "Amfl")], [true, true, true]);
  check("Phoenix: Phoenix Fire; Flying Machine: Flak Cannons + Detect", [carries("hphx", "Apxf"), carries("hgyr", "Aflk"), carries("hgyr", "Agyv")], [true, true, true]);
  check("Frost Wyrm: Freezing Breath; Chimaera: Corrosive Breath + Lightning Attack", [carries("ufro", "Afrz"), carries("echm", "Acor"), carries("echm", "Alit")], [true, true, true]);
  check("Archer: Mount (Acoi); Hippogryph Rider: Dismount", [carries("earc", "Acoi"), carries("ehpr", "Adec")], [true, true]);
  check("critters Wander; the Brood Mother spawns spiders", [carries("nsha", "Awan"), carries("nsbm", "Aspd")], [true, true]);
  check("Mal'Ganis: Dark Conversion and Soul Preservation", [carries("Umal", "ANdc"), carries("Umal", "ANsl")], [true, true]);
  check("Akama's Shadow Meld (Ahid) is the Ashm stance", ABILITIES.get("Ahid")?.code, "Ashm");
}

console.log("\nDetect (Gyrocopter): True Sight at Rng1 900");
{
  const w = world();
  const g = spawn(w, "hgyr", C, C, 0, 0);
  w.tick(DT);
  check("a Flying Machine sees invisible units out to 900", g.detectRadius, 900);
}

console.log("\nSpawn Spiders (Aspd): DataA of DataB where it died");
{
  const w = world();
  const bm = spawn(w, "nsbm", C, C, 2, 2);
  w.drainSummonRequests();
  w.kill(bm);
  const reqs = w.drainSummonRequests();
  check("the Brood Mother leaves two Spiders (nspr), her owner's", reqs.map((r) => [r.unitId, r.owner, r.summonLeft]), [["nspr", 2, 0], ["nspr", 2, 0]]);
}

console.log("\nTaunt (Atau): the nearest enemies attack the Giant, again after DataE");
{
  const w = world();
  const giant = spawn(w, "emtg", C, C, 0, 0);
  const near = spawn(w, "hfoo", C + 200, C, 1, 1);
  const far = spawn(w, "hfoo", C + 2500, C, 1, 1); // beyond its own acquisition of the Giant too
  check("the press is accepted", w.issueCast(giant.id, "Atau", 0, giant.x, giant.y), true);
  run(w, 0.5);
  check("a Footman inside Area1 450 is put on the Giant", [near.order, near.targetId], ["attack", giant.id]);
  check("…one outside it is left alone", far.targetId === giant.id, false);
}

console.log("\nPhoenix Fire (Apxf): thrown every Cool1, DataA on landing and DataB a second after");
{
  const w = world();
  const phx = spawn(w, "hphx", C, C, 0, 0);
  const foot = spawn(w, "hfoo", C + 300, C, 1, 1);
  foot.speed = 0;
  const hp0 = foot.hp;
  run(w, 1.2);
  check("the Footman took fire without the Phoenix being told to", foot.hp < hp0, true);
  check("…and is burning (the phoenixfire DoT)", foot.buffs.some((b) => b.group === "phoenixfire" && b.kind === "dot" && b.value === 2), true);
  void phx;
}

console.log("\nMana Flare (Amfl): an enemy cast inside 750 costs its caster mana × 3, up to 90");
{
  const w = world();
  const dragon = spawn(w, "efdr", C, C, 0, 0);
  const sorc = spawn(w, "hsor", C + 400, C, 1, 1);
  const victim = spawn(w, "hfoo", C + 600, C, 0, 0);
  for (const u of [dragon, sorc, victim]) u.weapons = []; // only the flare may hurt anybody here
  for (const a of sorc.abilities) a.autocastOn = false; // …and only the Slow we press is cast
  check("the flare lights", w.issueCast(dragon.id, "Amfl", 0, dragon.x, dragon.y), true);
  run(w, 1.5);
  check("…and she channels it", [dragon.order, dragon.pendingCast?.code], ["cast", "Amfl"]);
  const before = sorc.hp;
  check("the Sorceress casts Slow beside her", w.issueCast(sorc.id, "Aslo", victim.id), true);
  run(w, 2);
  const slowCost = ABILITIES.get("Aslo").levelData[0].cost; // 50
  check(`Slow (${slowCost} mana) cost the Sorceress min(${slowCost}×3, 90)`, Math.round(before - sorc.hp), Math.min(slowCost * 3, 90));
  w.issueCast(dragon.id, "Amfl", 0, dragon.x, dragon.y);
  check("pressing it again puts the flare out", dragon.order === "cast" && dragon.pendingCast?.code === "Amfl", false);
}

console.log("\nWar Club (Agra): a tree comes out, slot 1 (siege) in hand for DataE strikes");
{
  const w = world();
  const giant = spawn(w, "emtg", C, C, 0, 0);
  const tree = w.addTree(C + 60, C);
  check("the Giant starts on his normal slot", giant.weapons.map((x) => x.enabled), [true, false]);
  check("the press is accepted", w.issueCast(giant.id, "Agra", 0, tree.x, tree.y), true);
  run(w, 2);
  check("the tree is gone", w.trees.has(tree.id), false);
  check("…and the club is in hand: slot 0 down, slot 1 (siege) up", giant.weapons.map((x) => x.enabled), [false, true]);
  check("…for DataE strikes", giant.warClub?.strikes, 15);
}

console.log("\nSpell Steal (Asps): a buff the enemy's side hung goes to the Spell Breaker's side");
{
  const w = world();
  const breaker = spawn(w, "hspt", C, C, 0, 0);
  const grunt = spawn(w, "ogru", C + 300, C, 1, 1);
  const shaman = spawn(w, "oshm", C + 500, C, 1, 1);
  w.spellApi.applyBuff(grunt, { kind: "haste", group: "bloodlust", timeLeft: 40, sourceId: shaman.id, value: 0.25, value2: 0.4, buffId: "Bblo" });
  check("the press is accepted", w.issueCast(breaker.id, "Asps", grunt.id), true);
  run(w, 1.5);
  check("the Grunt has lost its Bloodlust", grunt.buffs.some((b) => b.group === "bloodlust"), false);
  check("…and the Spell Breaker (the only friend in Area1) wears it", breaker.buffs.some((b) => b.group === "bloodlust" && b.sourceId === breaker.id), true);
}

console.log("\nDark Conversion (ANdc): a commoner sleeps Dur1, then is the caster's zombie");
{
  const w = world();
  const mal = spawn(w, "Umal", C, C, 0, 0, 1);
  const vil = spawn(w, "nvil", C + 300, C, 2, 2);
  vil.speed = 0;
  mal.weapons = []; // Mal'Ganis would otherwise kill the sleeper he is converting
  check("the press is accepted", w.issueCast(mal.id, "ANdc", vil.id), true);
  run(w, 7);
  check("…asleep in the meantime", vil.buffs.some((b) => b.group === "darkconversion"), true);
  run(w, 6);
  check("the villager is a Zombie (UnitID1 nzom) and Mal'Ganis's", [vil.typeId, vil.owner], ["nzom", 0]);
}

console.log("\nDismount (Adec) and Mount (Acoi)");
{
  const w = world();
  const rider = spawn(w, "ehpr", C, C, 0, 0);
  rider.hp = rider.maxHp / 2;
  w.drainSummonRequests();
  check("the press is accepted", w.issueCast(rider.id, "Adec", 0, rider.x, rider.y), true);
  run(w, 1);
  const reqs = w.drainSummonRequests();
  check("the rider is the Archer (DataA) and the Hippogryph (DataB) stands up beside her, as hurt", [rider.typeId, rider.flying, reqs.map((r) => [r.unitId, r.hpFrac])], ["earc", false, [["ehip", 0.5]]]);
  const hippo = spawn(w, "ehip", C + 400, C, 0, 0);
  check("the Archer calls a Hippogryph inside Area1 900", w.issueCast(rider.id, "Acoi", 0, rider.x, rider.y), true);
  run(w, 4);
  check("…it flies to her and the two are a Hippogryph Rider again (her body)", [rider.typeId, rider.flying, w.units.has(hippo.id)], ["ehpr", true, false]);
}

console.log("\nFreezing Breath, Flak Cannons, Fragmentation Shards, Burning Oil");
{
  const w = world();
  const wyrm = spawn(w, "ufro", C, C, 0, 0);
  const farm = spawn(w, "hhou", C + 200, C, 1, 1);
  farm.building = { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: 0, rallyY: 0, rallyKind: "none", rallyTargetId: 0, producesUnits: false };
  w.applyStrikePassives(wyrm, farm, "magic");
  check("a struck building is frozen for Dur1 (Bfrz)", farm.buffs.filter((b) => b.group === "freezingbreath").map((b) => [b.kind, b.timeLeft, b.buffId]), [["stun", 5, "Bfrz"]]);
  const gyro = spawn(w, "hgyr", C, C + 1000, 0, 0);
  const a = spawn(w, "owyv", C + 1000, C + 1000, 1, 1);
  const b = spawn(w, "owyv", C + 1060, C + 1000, 1, 1);
  const c = spawn(w, "owyv", C + 1300, C + 1000, 1, 1);
  const [hb, hc] = [b.hp, c.hp];
  w.applyStrikePassives(gyro, a, "piercing");
  check("Flak: the flyer beside the one struck takes damage, so does one in the small ring", [b.hp < hb, c.hp < hc], [true, true]);
  const mortar = spawn(w, "hmtm", C, C - 1000, 0, 0);
  const peon = spawn(w, "opeo", C + 1000, C - 1000, 1, 1); // Medium armour
  const php = peon.hp;
  w.applyShellPassives(mortar, peon.x, peon.y, "siege");
  check("Fragmentation Shards: a Medium-armoured unit under the burst takes the extra", peon.hp < php, true);
  const demo = spawn(w, "ocat", C, C - 2000, 0, 0);
  const fields = w.spellFields.length;
  w.applyShellPassives(demo, C + 800, C - 2000, "siege");
  check("Burning Oil: the shell lays Flame Strike's two burns on the ground", w.spellFields.length - fields, 2);
}

console.log("\nWander (Awan): a critter left alone strolls about its post");
{
  const w = world();
  const sheep = spawn(w, "nshe", C, C, 15, 15);
  run(w, 25);
  check("the sheep has moved off the spot it was put on", Math.hypot(sheep.x - C, sheep.y - C) > 10, true);
  check("…and stayed near it", Math.hypot(sheep.x - C, sheep.y - C) <= 400 + 64, true);
}

console.log("\nSubmerge (ANsu) is the morph toggle");
{
  const w = world();
  const myr = spawn(w, "nmyr", C, C, 0, 0);
  check("the press is accepted", w.issueCast(myr.id, "ANsu", 0, myr.x, myr.y), true);
  run(w, 2);
  check("the Myrmidon is submerged (UnitID1 nmys)", myr.typeId, "nmys");
}

console.log("\nSacrifice (Asac): the Acolyte walks into the Pit and is a Shade");
{
  const w = world();
  const pit = spawn(w, "usap", C, C, 0, 0);
  pit.speed = 0;
  const aco = spawn(w, "uaco", C + 400, C, 0, 0);
  check("the press is accepted", w.issueCast(pit.id, "Asac", aco.id), true);
  run(w, 6);
  check("the Acolyte is a Shade", aco.typeId, "ushd");
}

console.log("\nAcha (Berserker Upgrade / Tank Upgrade): the unit becomes UnitID1 once the row's Requires is met");
{
  const { loadTechRegistry } = require(join(REPO, ".sim-build", "src", "data", "techtree.js"));
  const { loadUpgradeRegistry } = require(join(REPO, ".sim-build", "src", "data", "upgrades.js"));
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const w = new SimWorld(grid, 1, ABILITIES, undefined, UNITS, loadTechRegistry(vfs), loadUpgradeRegistry(vfs));
  const hunter = spawn(w, "ohun", C, C, 0, 0);
  const tank = spawn(w, "hmtt", C + 400, C, 0, 0);
  run(w, 0.5);
  check("a Headhunter (Sbsk, Requires=Robk) is itself before the research", hunter.typeId, "ohun");
  check("a Siege Engine (Srtt, which states NO Requires) is never moved by its row", tank.typeId, "hmtt");
  w.tech.setResearchLevel(0, "Robk", 1);
  w.tech.invalidate();
  run(w, 0.5);
  check("…and a Troll Berserker (UnitID1 otbk) once Robk is in", hunter.typeId, "otbk");
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall stock-ability checks passed");
