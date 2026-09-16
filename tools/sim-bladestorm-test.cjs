// Headless check of BLADESTORM (`AOww`, the Blademaster's ultimate).
//
// "Causes a bladestorm of destructive force around the Blademaster, rendering him immune to
// magic and dealing <AOww,DataA1> damage per second to nearby enemy land units. |nLasts
// <AOww,Dur1> seconds." — and the classic.battle.net Blademaster page's notes: he can still
// attack but Critical Strike is disabled, he is spell immune but not invulnerable, and
// Ethereal units take no damage. What this pins:
//
//   • 110 a second for Dur1 = 7 seconds (NOT HeroDur1's 5), to enemy GROUND units and
//     structures in Area1 = 200 — never an air unit, never his own side;
//   • the storm is AROUND him: it walks with the Blademaster and ends when he dies;
//   • he is magic immune for the run, and his Critical Strike does not roll;
//   • an ethereal unit standing in it is untouched.
//
// Real 1.30.4 row (Units\AbilityData.slk): AOww Cast1 0, Dur1 7, HeroDur1 5, Cool1 180,
// Cost1 200, Area1 200, DataA1 110, targs1 ground,structure,debris,enemy,neutral.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const BLADESTORM = {
  id: "AOww", code: "AOww", target: "none",
  targetFlags: ["ground", "structure", "debris", "enemy", "neutral"],
  lightning: [], buffFx: [], buffArt: "", targetArt: "", casterArt: "", specialArt: "", effectArt: "", areaArt: "", missileArt: "",
  levelData: [{ cost: 200, cooldown: 180, castRange: 0, area: 200, duration: 7, heroDuration: 5, castTime: 0, data: [110, 0], buffs: ["BOww"], summon: "" }],
};
// AOcr rank 1: 15% for x2 — the roll is forced to 0 below, so it would fire on every swing.
const CRIT = {
  id: "AOcr", code: "AOcr", target: "none", targetFlags: ["air", "ground", "enemy", "neutral"],
  lightning: [], buffFx: [], buffArt: "", targetArt: "", casterArt: "", specialArt: "", effectArt: "", areaArt: "", missileArt: "",
  levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: [15, 2, 0, 0], buffs: [], summon: "" }],
};
const ABILITIES = { AOww: BLADESTORM, AOcr: CRIT };

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

/** A Blademaster with Bladestorm and Critical Strike, and no weapon of his own, so every hit
 *  point anybody loses below is the storm's. Victims carry no weapon either. */
function scene() {
  const w = world();
  const bm = add(w, { x: 0, y: 0, mana: 300, maxMana: 300, name: "Blademaster", weapon: null, weapons: [], oldWeapons: [], race: "orc" });
  bm.isHero = true;
  bm.abilities = [
    { id: "AOww", code: "AOww", level: 1, cooldownLeft: 0, autocastOn: false },
    { id: "AOcr", code: "AOcr", level: 1, cooldownLeft: 0, autocastOn: false },
  ];
  const foe = (over) => add(w, { team: 1, owner: 1, weapon: null, weapons: [], oldWeapons: [], hp: 5000, maxHp: 5000, ...over });
  return { w, bm, foe };
}

{
  const { w, bm, foe } = scene();
  const near = foe({ x: 100, y: 0, name: "Grunt" });
  const far = foe({ x: 600, y: 0, name: "Far" });
  const flyer = foe({ x: 0, y: 100, name: "Gryphon", flying: true, targetedAs: "air", moveType: "fly" });
  const friend = add(w, { x: -100, y: 0, weapon: null, weapons: [], oldWeapons: [], hp: 5000, maxHp: 5000, name: "Friend" });
  check("Bladestorm is cast", w.issueCast(bm.id, "AOww"), true);
  step(w, 0.1);
  check("…and paid for (200 mana)", bm.mana <= 101, true);
  check("he is immune to magic while it runs", bm.magicImmune, true);
  w.rng = () => 0;
  check("…and his Critical Strike does not roll", w.rollCriticalStrike(bm), false);
  step(w, 8);
  check("a grunt beside him takes 110 x 7 = 770", 5000 - near.hp, 770);
  check("a unit out of the 200 area takes nothing", far.hp, 5000);
  check("an AIR unit takes nothing (\"land units\")", flyer.hp, 5000);
  check("his own side takes nothing", friend.hp, 5000);
  check("the immunity is gone once the storm is", bm.magicImmune, false);
  check("…and Critical Strike rolls again", w.rollCriticalStrike(bm), true);
}

{
  // The storm walks with him: a grunt 400 away is out of reach at the cast, and in it once
  // the Blademaster has gone to stand beside it.
  const { w, bm, foe } = scene();
  const grunt = foe({ x: 400, y: 0, name: "Grunt" });
  w.issueCast(bm.id, "AOww");
  step(w, 0.1);
  bm.x = 380; // he has walked over (moved directly: pathing is not what this is about)
  step(w, 3);
  check("the storm follows the Blademaster", grunt.hp < 5000, true);
}

{
  // …and ends with him.
  const { w, bm, foe } = scene();
  const grunt = foe({ x: 100, y: 0, name: "Grunt" });
  w.issueCast(bm.id, "AOww");
  step(w, 1.5);
  const hp = grunt.hp;
  bm.hp = 0;
  step(w, 3);
  check("a dead Blademaster's storm stops cutting", grunt.hp, hp);
}

{
  const { w, bm, foe } = scene();
  const ghost = foe({ x: 100, y: 0, name: "Banished" });
  w.applyBuffInternal(ghost, { kind: "ethereal", group: "banish", timeLeft: 20, sourceId: 0, value: 0 });
  step(w, 0.05);
  check("(the target really is ethereal)", ghost.ethereal, true);
  w.issueCast(bm.id, "AOww");
  step(w, 4);
  check("an ETHEREAL unit takes no damage", ghost.hp, 5000);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
