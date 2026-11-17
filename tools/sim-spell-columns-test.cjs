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
  // The eruption is centred 600 east of the Firelord. `near` stands inside the full-damage
  // half of Area1 (500), `edge` in the outer ring; the hall is inside the full half too.
  const X = C + 600;
  const near = dummy(w, "hfoo", X, C + 100);
  const edge = dummy(w, "hfoo", X, C - 400);
  const hall = dummy(w, "htow", X + 150, C);
  hall.building = BUILT();
  const row = lvl("ANvc");
  check("the row: 8 waves of 100, 5 s apart, ×2 on buildings, half factor 0.5, 2 s stun", [row.data[1], row.data[4], row.data[2], row.data[3], row.data[5], row.duration, row.heroDuration], [8, 100, 5, 2, 0.5, 2, 1]);
  check("the press is accepted", w.issueCast(fire.id, "ANvc", 0, X, C), true);
  run(w, 2);
  // Whole waves of 100: the Footmen's own trickle of regeneration is rounded away.
  const lost = (u) => Math.round((100000 - u.hp) / 50) * 50;
  check("the first wave has landed: DataE = 100", lost(near), 100);
  check("…a building takes DataD = 2 times that", lost(hall), 200);
  check("…and the outer ring DataF = 0.5 of it", lost(edge), 50);
  check("both units are stunned, ring or not", [near, edge].map((u) => u.buffs.some((b) => b.kind === "stun")), [true, true]);
  run(w, 2);
  check("the stun is Dur1 = 2 s, so it is over before the next wave", near.buffs.some((b) => b.kind === "stun"), false);
  check("nothing more has landed inside one Wave Interval", lost(near), 100);
  run(w, 50);
  check("eight waves in all: 800, not 96 — and 400 in the ring", [lost(near), lost(edge)], [800, 400]);
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

console.log("\nPurge (Aprg): slows for Dur / HeroDur, and deals DataC to a summon (#286)");
{
  const row = lvl("Aprg");
  check("the row: Dur 15 / HeroDur 5, DataC 400, DataD (Unit Pause Duration) a real 0", [row.duration, row.heroDuration, row.data[2], row.data[3]], [15, 5, 400, 0]);
  const purge = (target) => {
    const w = world();
    const shaman = spawn(w, "oshm", C, C, 0, 0);
    shaman.baseMaxMana = shaman.maxMana = shaman.mana = 500;
    shaman.weapons = [];
    for (const a of shaman.abilities) a.autocastOn = false;
    const t = target(w);
    const ok = w.issueCast(shaman.id, "Aprg", t.id);
    run(w, 1.5);
    return { w, t, ok };
  };
  const slowOf = (u) => u.buffs.find((b) => b.kind === "slow" && b.group === "purge");
  {
    const { w, t, ok } = purge((w) => dummy(w, "hfoo", C + 400, C));
    check("the press is accepted", ok, true);
    check("a Footman is slowed", !!slowOf(t), true);
    run(w, 10);
    check("…and still slowed ten seconds on (Dur1 = 15)", !!slowOf(t), true);
    run(w, 5);
    check("…and free after fifteen", !!slowOf(t), false);
  }
  {
    const { w, t } = purge((w) => { const h = dummy(w, "Hpal", C + 400, C); h.isHero = true; return h; });
    check("a hero is slowed", !!slowOf(t), true);
    run(w, 5);
    check("…for HeroDur1 = 5", !!slowOf(t), false);
  }
  {
    const { t } = purge((w) => { const s = dummy(w, "osw3", C + 400, C, 1500); s.isSummon = true; return s; });
    check("a 1500-life summon takes DataC = 400 and stands", [Math.round((1500 - t.hp) / 100) * 100, t.hp > 0], [400, true]);
    check("…and is slowed like anything else", !!slowOf(t), true);
  }
  {
    const { w, t } = purge((w) => { const s = dummy(w, "hwat", C + 400, C, 300); s.isSummon = true; return s; });
    check("a summon with less than that dies of it", t.hp <= 0 || !w.units.has(t.id), true);
  }
}

console.log("\nDeath Pact (AUdp): DataB of the sacrifice's hit points, by rank (#287)");
{
  check("the row: Life Converted to Life 1 / 2 / 3", [1, 2, 3].map((r) => lvl("AUdp", r).data[1]), [1, 2, 3]);
  for (const rank of [1, 2, 3]) {
    const w = world();
    const dk = caster(w, "Udea", C, C, rank);
    dk.baseMaxHp = dk.maxHp = 5000;
    dk.hp = 1000;
    const ghoul = spawn(w, "ugho", C + 200, C, 0, 0);
    const life = ghoul.maxHp;
    w.issueCast(dk.id, "AUdp", ghoul.id);
    run(w, 1.5);
    check(`rank ${rank}: a ${life}-life Ghoul is worth ${life * rank}`, [Math.round((dk.hp - 1000) / life), ghoul.hp <= 0 || !w.units.has(ghoul.id)], [rank, true]);
  }
}

console.log("\nEndurance Aura (AOae): DataA is the move half and DataB the attack half (#288)");
{
  check("the rows: move 0.1/0.2/0.3, attack 0.05/0.1/0.15", [1, 2, 3].map((r) => [lvl("AOae", r).data[0], lvl("AOae", r).data[1]]), [[0.1, 0.05], [0.2, 0.1], [0.3, 0.15]]);
  const w = world();
  const chief = caster(w, "Otch", C, C, 1);
  for (const a of chief.abilities) a.level = a.code === "AOae" ? 3 : 0;
  const grunt = spawn(w, "ogru", C + 200, C, 0, 0);
  run(w, 1);
  const aura = grunt.buffs.find((b) => b.kind === "haste");
  check("a Grunt beside a rank-3 Chieftain: +30% move, +15% attack", [aura?.value, aura?.value2], [0.3, 0.15]);
}

console.log("\nSilence (ANsi): Dur on a unit, HeroDur on a hero (#289)");
{
  const row = lvl("ANsi");
  check("the row: Dur 16 / HeroDur 8", [row.duration, row.heroDuration], [16, 8]);
  const w = world();
  const ranger = caster(w, "Nbrn", C, C, 1);
  const foot = dummy(w, "hfoo", C + 500, C);
  const pal = dummy(w, "Hpal", C + 500, C + 80);
  pal.isHero = true;
  check("the press is accepted", w.issueCast(ranger.id, "ANsi", 0, foot.x, foot.y), true);
  run(w, 1.5);
  const silenced = (u) => u.buffs.some((b) => b.kind === "silence");
  check("both are silenced", [silenced(foot), silenced(pal)], [true, true]);
  run(w, 8);
  check("eight seconds on the hero is free and the Footman is not", [silenced(foot), silenced(pal)], [true, false]);
  run(w, 8);
  check("…and the Footman after sixteen", silenced(foot), false);
}

console.log("\nEarthquake (AOeq): the field runs Dur1 = 25; HeroDur is the slow's, on heroes (#289)");
{
  const row = lvl("AOeq");
  check("the row: Dur 25 / HeroDur 20, 50 a second to buildings", [row.duration, row.heroDuration, row.data[1]], [25, 20, 50]);
  const w = world();
  const seer = caster(w, "Ofar", C, C, 1);
  const hall = dummy(w, "htow", C + 600, C);
  hall.building = BUILT();
  const foot = dummy(w, "hfoo", C + 600, C + 120);
  const pal = dummy(w, "Hpal", C + 600, C - 120);
  pal.isHero = true;
  check("the press is accepted", w.issueCast(seer.id, "AOeq", 0, hall.x, hall.y), true);
  run(w, 2);
  const slow = (u) => u.buffs.find((b) => b.kind === "slow" && b.group === "quake");
  check("the Footman's slow is Dur1 and the hero's HeroDur1", [Math.round(slow(foot).total), Math.round(slow(pal).total)], [25, 20]);
  run(w, 40);
  check("the building took twenty-five waves of 50 (1250), not twenty", Math.round((100000 - hall.hp) / 50), 25);
  check("…and nothing that walks was hurt", foot.hp > 99990, true);
}

// The victims below are undead standing off blight: `regenType = blight`, so nothing but the
// blow moves their hit points and the splash can be read off them exactly.
console.log("\nCleaving Attack (ANca): Area1 = 250 around the struck unit, and only what targs1 admits (#290)");
{
  const def = ABILITIES.get("ANca");
  check("the row: only DataA is filled; the radius is Area1; no air, no structure", [def.levelData[0].data[0], Number.isNaN(def.levelData[0].data[3]) || def.levelData[0].data[3] === 0, def.levelData[0].area, def.targetFlags.includes("air"), def.targetFlags.includes("structure")], [0.4, true, 250, false, false]);
  const w = world();
  const pit = spawn(w, "Nplh", C, C, 0, 0, 1);
  const struck = dummy(w, "ugho", C + 110, C);
  // 270 from the struck Ghoul's centre: past the old 200 (+ its 31 of body), inside 250.
  const beside = dummy(w, "ugho", C + 110, C + 270);
  const far = dummy(w, "ugho", C + 110, C - 320);
  const flyer = dummy(w, "ugar", C + 110, C + 120);
  check("the attack is accepted", w.issueAttack(pit.id, struck.id, true, true), true);
  let waited = 0;
  while (struck.hp === 100000 && waited < 6) { w.tick(DT); waited += DT; }
  run(w, 0.2);
  check("the blow landed", struck.hp < 100000, true);
  check("a Ghoul 270 away is cleaved (it was out of reach at 200)", beside.hp < 100000, true);
  check("…one beyond Area1 is not", far.hp, 100000);
  check("…and a Gargoyle overhead is not: targs1 has no `air`", flyer.hp, 100000);
}

console.log("\nPulverize (Awar): DataB inside DataC = 250, half of it out to DataD = 350 (#290)");
{
  const row = lvl("Awar");
  check("the row: 25% for 60, full to 250, half to 350", [row.data[0], row.data[1], row.data[2], row.data[3]], [25, 60, 250, 350]);
  const { loadTechRegistry } = require(join(REPO, ".sim-build", "src", "data", "techtree.js"));
  const { loadUpgradeRegistry } = require(join(REPO, ".sim-build", "src", "data", "upgrades.js"));
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const w = new SimWorld(grid, 1, ABILITIES, undefined, UNITS, loadTechRegistry(vfs), loadUpgradeRegistry(vfs));
  w.tech.setResearchLevel(0, "Rows", 1);
  w.tech.invalidate();
  const tauren = spawn(w, "otau", C, C, 0, 0);
  const struck = dummy(w, "ugho", C + 120, C);
  const inner = dummy(w, "ugho", C + 120, C + 200);
  const ring = dummy(w, "ugho", C + 120, C - 340); // 340 − its 31 of body: past 250, inside 350
  const out = dummy(w, "ugho", C + 120, C + 420);
  const flyer = dummy(w, "ugar", C + 120, C + 120);
  w.issueAttack(tauren.id, struck.id, true, true);
  run(w, 90);
  const lost = (u) => 100000 - u.hp;
  check("it went off, in whole 60s, on a Ghoul inside 250", [lost(inner) > 0, lost(inner) % 60], [true, 0]);
  check("a Ghoul in the ring took exactly HALF of that (it used to take nothing)", lost(ring), lost(inner) / 2);
  check("…one past 350 took nothing", lost(out), 0);
  check("…and neither did a Gargoyle overhead", lost(flyer), 0);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall spell-column checks passed");
