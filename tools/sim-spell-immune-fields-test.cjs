// Headless check that a DAMAGE FIELD spares a spell-immune unit unless its damage type
// reaches one (FIELD_PIERCES_SPELL_IMMUNITY in src/sim/spells.ts, applied in landWave).
//
// Sources: Hive "Spell/Ability Damage Types and what they mean" (thread 316271) — Blizzard is
// Cold, Rain of Fire and Flame Strike Fire, Cluster Rockets Force: all "Cannot damage spell
// immune"; Volcano is Normal and Bladestorm Enhanced: "can affect Spell immune" but not
// Ethereal; Death and Decay, Starfall, Stampede and Earthquake are Universal: both. And
// Liquipedia's Spell Immunity page: an immune unit "still counts toward ability damage caps
// … will soak the damage", so it is skipped AFTER a capped wave splits its budget.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

/** One ability row per field code, with that ability's real 1.30.4 `targs1`. */
const row = (code, targetFlags) => ({
  id: code, code, target: "point", targetFlags,
  lightning: [], buffFx: [], buffArt: "", targetArt: "", casterArt: "", specialArt: "", effectArt: "", areaArt: "", missileArt: "",
  levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 200, duration: 0, heroDuration: 0, castTime: 0, data: [], buffs: [], summon: "" }],
});
const ABILITIES = {
  AHbz: row("AHbz", []), // Blizzard: `_`, no allegiance — it hits your own side too
  AHfs: row("AHfs", ["ground", "enemy", "neutral", "friend", "structure", "self", "tree", "debris"]),
  ANvc: row("ANvc", ["ground", "structure", "enemy", "neutral"]),
  AUdd: row("AUdd", ["air", "ground", "structure", "ward"]),
  AOww: row("AOww", ["ground", "structure", "debris", "enemy", "neutral"]),
};

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const WEAPON = {
  enabled: true, targets: ["ground", "air", "structure"], acquire: 0, range: 600,
  dice: 1, sides: 2, base: 9, damage: 9, baseDamage: 9, cooldown: 1.9, rangeMotionBuffer: 250,
  damagePoint: 0.3, backswing: 0.3, attackType: "normal", ranged: true,
  projectile: "", projectileSpeed: 900, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0,
  spillDist: 0, spillRadius: 0, damageLoss: 0,
};

function world() {
  const W = 64, H = 64;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  w.abilities = { get: (id) => ABILITIES[id], all: () => Object.values(ABILITIES), buffFx: () => [] };
  return w;
}

let nextId = 1;
function add(w, over) {
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 100, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: WEAPON, weapons: [WEAPON], oldWeapons: [WEAPON],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "undead",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Unit",
    worker: null, depotGold: false, depotLumber: false,
    ...over,
  });
  u.x = over.x ?? 0;
  u.y = over.y ?? 0;
  return u;
}

const step = (w, seconds, dt = 0.05) => { for (let i = 0; i < Math.round(seconds / dt); i++) w.tick(dt); };

/** A caster holding every field, and a helper to raise a unit on either side. */
function scene() {
  const w = world();
  const caster = add(w, { x: -1500, y: 0, name: "Caster", weapon: null, weapons: [], oldWeapons: [] });
  caster.abilities = Object.keys(ABILITIES).map((id) => ({ id, code: id, level: 1, cooldownLeft: 0, autocastOn: false }));
  const body = (over) => add(w, { team: 1, owner: 1, weapon: null, weapons: [], oldWeapons: [], hp: 1000, maxHp: 1000, ...over });
  const immune = (u) => w.applyBuffInternal(u, { kind: "magicImmune", group: "test", timeLeft: 60, sourceId: 0, value: 0 });
  const ethereal = (u) => w.applyBuffInternal(u, { kind: "ethereal", group: "banish", timeLeft: 60, sourceId: 0, value: 0 });
  /** One wave of `code`'s field at the origin, landed straight through landWave: Blizzard and
   *  Death and Decay are CHANNELS, and a field whose caster is not channelling it is torn
   *  down before its first wave, so the field's own clock is not what is under test here. */
  const wave = (code, damage, extra = {}) => {
    w.landWave({
      code, t: 0, x: 0, y: 0, area: 200, damage, casterId: caster.id, team: caster.team,
      flags: ABILITIES[code].targetFlags, maxDamage: extra.maxDamagePerWave ?? 0, buildingReduction: 0,
      dot: undefined, pctOfMax: extra.damagePctOfMax ?? false, buildingsOnly: false, fellsTrees: false,
      skipEthereal: extra.skipEthereal ?? false,
    });
  };
  step(w, 0.05);
  return { w, caster, body, immune, ethereal, wave };
}

{
  const s = scene();
  const breaker = s.body({ x: 50, name: "Spell Breaker" });
  const footman = s.body({ x: -50, name: "Footman" });
  s.immune(breaker);
  step(s.w, 0.05);
  check("(the Spell Breaker really is immune)", breaker.magicImmune, true);
  s.wave("AHbz", 50);
  check("Blizzard (Cold) spares a spell-immune unit", breaker.hp, 1000);
  check("…and still lands on the unit beside it", footman.hp, 950);
  s.wave("AHfs", 50);
  check("Flame Strike (Fire) spares it too", breaker.hp, 1000);
}

{
  // Liquipedia: an immune unit still counts toward the cap and soaks its share.
  const s = scene();
  const destroyer = s.body({ x: 50, name: "Destroyer" });
  const footman = s.body({ x: -50, name: "Footman" });
  s.immune(destroyer);
  step(s.w, 0.05);
  s.wave("AHbz", 100, { maxDamagePerWave: 100 });
  check("a capped wave still splits its budget over the immune unit", [destroyer.hp, footman.hp], [1000, 950]);
}

{
  const s = scene();
  const own = add(s.w, { x: 50, y: 0, team: 0, owner: 0, weapon: null, weapons: [], oldWeapons: [], hp: 1000, maxHp: 1000, name: "Own Breaker" });
  s.immune(own);
  step(s.w, 0.05);
  s.wave("AHbz", 50);
  check("the caster's own spell-immune unit is spared its Blizzard as well", own.hp, 1000);
}

{
  const s = scene();
  const a = s.body({ x: 50, name: "Immune" });
  s.immune(a);
  step(s.w, 0.05);
  s.wave("AUdd", 0.04, { damagePctOfMax: true });
  check("Death and Decay (Universal) reaches a spell-immune unit", a.hp, 960);
  s.wave("ANvc", 30);
  check("Volcano (Normal) reaches it", a.hp, 930);
  s.wave("AOww", 110);
  check("Bladestorm (Enhanced) reaches it", a.hp, 820);
}

{
  const s = scene();
  const ghost = s.body({ x: 50, name: "Banished" });
  s.ethereal(ghost);
  step(s.w, 0.05);
  s.wave("ANvc", 30, { skipEthereal: true });
  check("Volcano (Normal) does not reach an ethereal unit", ghost.hp, 1000);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
