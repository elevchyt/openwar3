// Headless check of ELUNE'S GRACE, the Night Elf Archer's passive (`Aegr`, base code `AIdd`).
//
// Its whole rule is its own Ubertip (Units\NightElfAbilityStrings.txt): "Reduces the damage taken
// from Piercing attacks to <Aegr,DataA1,%>%, and spells and Magic attacks to <Aegr,DataE1,%>%."
// AbilityData.slk has DataA1 = 0.65 and DataE1 = 0.8 — Liquipedia's 35 % / 20 %. It was never
// read at all: `AIdd` was handled only as an ITEM (the Arcanite Shield), so an Archer took
// every arrow and every Chain Lightning in full.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

/** `[Aegr]` as AbilityData.slk has it: code AIdd, DataA 0.65, DataE 0.8 (the rest of the Def
 *  columns are Defend's, and 1 / 0 here as they are there). */
const GRACE = {
  id: "Aegr", code: "AIdd", target: "none", targetFlags: [],
  levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: [0.65, 1, 0, 0, 0.8], buffs: [], summon: "" }],
};

const PRIEST_WEAPON = {
  enabled: true, targets: ["ground", "air", "structure"], acquire: 600, range: 600, baseRange: 600, rangeBuffer: 250,
  dice: 1, baseDice: 1, sides: 2, base: 9, damage: 9, baseDamage: 9, cooldown: 1.9, baseCooldown: 1.9, rangeMotionBuffer: 250,
  damagePoint: 0.3, baseDamagePoint: 0.3, backswing: 0.3, baseBackswing: 0.3, baseSpillDist: 0, baseSpillRadius: 0,
  attackType: "magic", ranged: true,
  projectile: "", projectileSpeed: 900, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0,
  spillDist: 0, spillRadius: 0, damageLoss: 0,
};
const FOOTMAN_WEAPON = { ...PRIEST_WEAPON, acquire: 500, range: 90, baseRange: 90, ranged: false, attackType: "normal" };

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A fresh world over open ground. Each case gets its own so nothing leaks between them. */
function world() {
  const W = 64, H = 64;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  const rows = { Aegr: GRACE };
  w.abilities = { get: (id) => rows[id], all: () => Object.values(rows) };
  return w;
}

let nextId = 1;
function add(w, over) {
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 0.6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: FOOTMAN_WEAPON, weapons: [FOOTMAN_WEAPON], oldWeapons: [FOOTMAN_WEAPON],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    ...over,
  });
  // add() settles a spawn onto a free cell; put it back where the case asked for it.
  u.x = over.x ?? 0;
  u.y = over.y ?? 0;
  return u;
}


function archer(w, withGrace) {
  const u = add(w, { typeId: "earc", hp: 310, maxHp: 310, armorType: "medium", name: "Archer" });
  u.abilities = withGrace ? [{ id: "Aegr", code: "AIdd", level: 1, cooldownLeft: 0, autocastOn: false }] : [];
  w.recomputeStats(u);
  return u;
}
/** What one blow of `type` does to an Archer with and without the passive — the ratio is the
 *  passive, since everything else (the damage table, armour) is the same on both sides. */
function ratio(type, spell = false) {
  const w = world();
  const src = add(w, { owner: 1, team: 1, x: 300, y: 0 });
  const hit = (withGrace) => {
    const a = archer(w, withGrace);
    const before = a.hp;
    if (spell) w.spellApi.spellDamage(a, 100, src.id);
    else w.applyDamage(a, 100, src.id, type, "", true);
    return before - a.hp;
  };
  const plain = hit(false);
  return Math.round((hit(true) / plain) * 1000) / 1000;
}

check("a PIERCING attack reaches an Archer at 65 %", ratio("pierce"), 0.65);
check("a MAGIC attack at 80 %", ratio("magic"), 0.8);
check("a SPELL at 80 %", ratio("", true), 0.8);
check("a NORMAL attack is untouched", ratio("normal"), 1);
check("…and so is SIEGE", ratio("siege"), 1);
{
  const w = world();
  const a = archer(w, true);
  check("the passive is derived onto the unit", [a.pierceTaken, a.magicTaken], [0.65, 0.8]);
  a.abilities = [];
  w.recomputeStats(a);
  check("…and goes with the ability", [a.pierceTaken, a.magicTaken], [1, 1]);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
