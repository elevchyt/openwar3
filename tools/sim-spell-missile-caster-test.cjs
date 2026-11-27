// A SPELL MISSILE lands as its caster's, whether or not he is still standing (issue #350).
//
// A Storm Bolt's hammer or a Death Coil that has left the hand is in the air on its own; the
// caster dying under it changes nothing about who threw it. The sim used to resolve the
// impact with `units.get(sourceId) ?? target` — a dead caster is gone from `units`, so the
// VICTIM became the caster: a Death Coil asked `hostile(t, t)` and dealt nothing, a Storm
// Bolt's kill paid its owner nothing, and a dead Tauren's Shockwave hit nobody at all.
// `SimWorld.missileCasters` keeps the caster for as long as one of his missiles flies.
//
// Rows (Units\AbilityData.slk): AUdc DataA1 200 (half of it dealt to the living, issue #351),
// Missilespeed 750; AOsh DataA1 75, DataB1 900, DataC1 800, Area1 125, Missilespeed 1050.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const ART = { buffFx: [], buffArt: "", targetArt: "", casterArt: "", specialArt: "", effectArt: "", areaArt: "", lightning: [] };
const COIL = {
  ...ART, id: "AUdc", code: "AUdc", target: "unit", missileArt: "Abilities\\Spells\\Undead\\DeathCoil\\DeathCoilMissile.mdl", missileSpeed: 750,
  targetFlags: ["air", "ground", "notself"],
  levelData: [{ cost: 75, cooldown: 6, castRange: 800, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: [200], buffs: [], summon: "" }],
};
const SHOCK = {
  ...ART, id: "AOsh", code: "AOsh", target: "point", missileArt: "Abilities\\Spells\\Orc\\Shockwave\\ShockwaveMissile.mdl", missileSpeed: 1050,
  targetFlags: ["ground", "structure"],
  levelData: [{ cost: 100, cooldown: 8, castRange: 700, area: 125, duration: 0, heroDuration: 0, castTime: 0, data: [75, 900, 800], buffs: [], summon: "" }],
};
const ROWS = { AUdc: COIL, AOsh: SHOCK };

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

function world() {
  const W = 128, H = 128;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  w.abilities = { get: (id) => ROWS[id], all: () => Object.values(ROWS), buffFx: () => [] };
  return w;
}

let nextId = 1;
function add(w, over) {
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 100, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapons: [], oldWeapons: [],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: false, targetedAs: "ground", deathTime: 2, name: "Unit",
    worker: null, depotGold: false, depotLumber: false,
    ...over,
  });
  u.x = over.x ?? 0;
  u.y = over.y ?? 0;
  return u;
}
const step = (w, seconds, dt = 0.05) => { for (let i = 0; i < Math.round(seconds / dt); i++) w.tick(dt); };

// --- a Death Coil whose Death Knight falls while it flies still lands ------------------
{
  const w = world();
  const dk = add(w, { x: 0, y: 0, race: "undead", isHero: true, name: "Death Knight" });
  const victim = add(w, { x: 750, y: 0, team: 1, owner: 1, name: "Footman" });
  w.spawnSpellProjectile(dk, victim.id, COIL, 1);
  step(w, 0.2);
  w.killUnit(dk.id);
  check("the Death Knight is gone from the world", w.units.has(dk.id), false);
  step(w, 1.5);
  check("…and his coil still lands", victim.hp < 500, true);
  check("…and lets its caster go once nothing of his is in the air", w.missileCasters.size, 0);
}

// --- …and its KILL is still his ----------------------------------------------------------
{
  const w = world();
  const dk = add(w, { x: 0, y: 0, race: "undead", isHero: true, name: "Death Knight" });
  const victim = add(w, { x: 750, y: 0, team: 1, owner: 1, hp: 50, name: "Footman" });
  let killer = -1;
  w.deathObserver = (u, k) => { if (u === victim) killer = k ? k.id : null; };
  w.spawnSpellProjectile(dk, victim.id, COIL, 1);
  step(w, 0.2);
  w.killUnit(dk.id);
  step(w, 1.5);
  check("the coil kills its victim", victim.hp <= 0, true);
  check("…and the kill is the dead Death Knight's, not the victim's own", killer, dk.id);
}

// --- a Shockwave sweeps on after its Tauren has died -------------------------------------
{
  const w = world();
  const tc = add(w, { x: 0, y: 0, race: "orc", isHero: true, name: "Tauren Chieftain" });
  const a = add(w, { x: 300, y: 0, team: 1, owner: 1 });
  const b = add(w, { x: 600, y: 0, team: 1, owner: 1 });
  w.spawnWaveProjectile(tc, SHOCK, 1, { tx: 800, ty: 0, dist: 800, halfWidth: 125, budget: 900 });
  w.killUnit(tc.id);
  step(w, 1.2);
  check("a dead Tauren's Shockwave still hits what it reaches", [a.hp, b.hp], [425, 425]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
