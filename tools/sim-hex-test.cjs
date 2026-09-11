// Headless check of HEX and POLYMORPH, and of the movement ceiling — with the real 1.30.4 rows.
//
//   [AOhx] Dur1 15 / HeroDur1 4, DataB "npig,nsea,ncrb,nhmc,nrat,nfro,nech,necr,nrac" (walkers),
//          DataC "nalb,nvul,nsno" (flyers)
//   [Aply] Dur1 60, DataB "nshe", DataC "nshf", DataD "nsha", DataE "nshw"
//
// A hexed unit is a CRITTER over its own type: `typeId` does not move, `hexForm` names the
// critter the renderer draws, and the `hex` buff is the rules — no attack, no spells, and a walk
// of exactly 100. Every speed stops at MiscGame's MaxUnitSpeed (400) except under Wind Walk or
// Chemical Rage, which stop at the engine's 522.
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
/** The unpacked install as a DataSource, case-insensitively (see sim-creep-spells-test.cjs). */
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
const world = () => new SimWorld(new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]), 1, ABILITIES, undefined, UNITS);

let nextId = 1;
function spawn(w, typeId, x, y, owner, team) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  const abilities = [];
  for (const id of def.abilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: autoArmed(def, id, a.code) });
  }
  return w.add(
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
}
/** A caster with `id` on its card at rank 1 and a pool deep enough to press it. */
function caster(w, typeId, id, x, y) {
  const u = spawn(w, typeId, x, y, 0, 0);
  if (!u.abilities.some((a) => a.id === id)) u.abilities.push({ id, code: ABILITIES.get(id).code, level: 1, cooldownLeft: 0, autocastOn: false });
  u.baseMaxMana = u.maxMana = u.mana = 1000;
  return u;
}
function run(w, seconds) {
  for (let i = 0; i < seconds * 20; i++) w.tick(0.05);
}
const hexBuff = (u) => u.buffs.find((b) => b.kind === "hex");

console.log("Ensnare is a target spell, not an autocast");
check("`Aens` carries no autocast flag ([Aens] has no Orderon)", !!KNOWN_ABILITIES.Aens.autocast, false);
check("Polymorph is a known unit-target spell", KNOWN_ABILITIES.Aply && KNOWN_ABILITIES.Aply.target, "unit");

console.log("\nHex turns a Footman into one of its own row's walkers");
{
  const w = world();
  const hunter = caster(w, "Oshd", "AOhx", 1000, 1000);
  const f = spawn(w, "hfoo", 1300, 1000, 1, 1);
  w.drainSpellEffects();
  w.drainMorphs();
  check("the cast is taken", w.issueCast(hunter.id, "AOhx", f.id, 0, 0), true);
  run(w, 2);
  const pool = ABILITIES.get("AOhx").levelData[0].dataStr[1].split(",");
  check("the Footman is hexed", f.hexed, true);
  check("…wearing a critter off DataB", pool.includes(f.hexForm), true);
  check("…and is still a Footman underneath", f.typeId, "hfoo");
  check("…for the row's 15 seconds (a non-hero's Dur1)", Math.round(hexBuff(f)?.timeLeft ?? 0), 13);
  check("…walking at exactly 100", f.speed, 100);
  check("…and silenced", f.silenced, true);
  check("the renderer is told to re-skin it", w.drainMorphs().some((m) => m.unitId === f.id), true);
  const poof = w.drainSpellEffects().find((e) => /PolyMorphTarget\.mdx$/i.test(e.art));
  check("the poof plays on the unit", poof && poof.targetId, f.id);
  check("…with the ground sound", poof && /PolymorphTarget1\.wav$/i.test(poof.soundFile), true);

  const hp = hunter.hp;
  w.issueAttack(f.id, hunter.id);
  run(w, 3);
  check("a critter cannot attack", hunter.hp, hp);

  hexBuff(f).timeLeft = 0.01;
  run(w, 0.2);
  check("when the clock runs out it is itself again", f.hexForm, "");
  check("…no longer hexed", f.hexed, false);
  check("…at its own speed", f.speed, UNITS.get("hfoo").speed);
  check("…and re-skinned back", w.drainMorphs().some((m) => m.unitId === f.id), true);
  const done = w.drainSpellEffects().find((e) => /PolyMorphDoneGround\.mdx$/i.test(e.art));
  check("…with PolyMorphDoneGround on the ground under it", done && done.targetId, 0);
  check("…and PolymorphDone.wav", done && /PolymorphDone\.wav$/i.test(done.soundFile), true);
}

console.log("\na flyer takes its spell's own DataC: Polymorph's Flying Sheep, Hex's three birds");
{
  const w = world();
  const sorc = caster(w, "hsor", "Aply", 1000, 1000);
  const g = spawn(w, "ugar", 1200, 1000, 1, 1);
  g.flying = true;
  w.drainSpellEffects();
  check("the cast is taken", w.issueCast(sorc.id, "Aply", g.id, 0, 0), true);
  run(w, 2);
  check("the Gargoyle is a Flying Sheep", g.hexForm, "nshf");
  check("…for Polymorph's minute", Math.round(hexBuff(g)?.timeLeft ?? 0), 58);
  const poof = w.drainSpellEffects().find((e) => /PolyMorphTarget\.mdx$/i.test(e.art));
  check("…with PolymorphTargetAir1.wav", poof && /PolymorphTargetAir1\.wav$/i.test(poof.soundFile), true);

  const hunter = caster(w, "Oshd", "AOhx", 1000, 1400);
  const g2 = spawn(w, "ugar", 1200, 1400, 1, 1);
  g2.flying = true;
  w.issueCast(hunter.id, "AOhx", g2.id, 0, 0);
  run(w, 2);
  check("Hex makes a flyer one of its three birds", ["nalb", "nvul", "nsno"].includes(g2.hexForm), true);
}

console.log("\nevery speed stops at MaxUnitSpeed, and only Wind Walk and Chemical Rage go past it");
{
  const w = world();
  const f = spawn(w, "hfoo", 1000, 1000, 0, 0);
  w.spellApi.applyBuff(f, { kind: "haste", group: "item:speed", timeLeft: 10, sourceId: f.id, value: 2, value2: 0 });
  w.recomputeStats(f);
  check("a Scroll of Speed's +200% walks a Footman at 400, not 810", f.speed, 400);
  const bm = spawn(w, "hfoo", 1200, 1000, 0, 0);
  w.spellApi.applyBuff(bm, { kind: "haste", group: "windwalk", timeLeft: 10, sourceId: bm.id, value: 2, value2: 0 });
  w.recomputeStats(bm);
  check("a Wind Walk haste stops at the engine's 522", bm.speed, 522);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall hex checks passed");
