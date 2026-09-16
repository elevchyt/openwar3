// Headless check that CANNIBALIZE is a channel (`Acan`; `Acn2` the Abomination's shares the code).
//
// `Units\UndeadAbilityFunc.txt` gives both rows `Animnames = stand,channel`, and Ghoul.mdx and
// Abomination.mdx both author a "Stand Channel" clip for it. The meal is a heal buff on the
// caster, and a buff does not know its caster walked away — so this pins the channel:
//
//   • the Ghoul stands locked for `Dur1` (20s) while it heals `DataA` (16) a second,
//   • moving or a stun breaks it, and the heal stops with it,
//   • it gets up the moment it is full rather than standing out the rest of `Dur1`,
//   • it WALKS to the nearest body within its acquisition range (600 on the Ghoul) and eats
//     there — `Rng1` = 50 is where it eats, not how far it looks,
//   • with no body in that range it is refused, not a 20-second mime,
//   • the body STAYS on the ground while it is eaten, reserved to the eater, and is spent when
//     the meal ends however it ends (Warcraft Wiki, Ghoul: "If the ghoul dies or is forcibly
//     moved while cannibalizing the corpse, then it automatically disappears").
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

/** [Acan] Units\AbilityData.slk: Dur1 20, Rng1 50, DataA 16 "Hit Points per Second", DataB 800. */
const ACAN = {
  id: "Acan", code: "Acan", target: "none",
  targetFlags: ["ground", "dead", "organic"], animNames: ["stand", "channel"],
  lightning: [], buffFx: [], buffArt: "", targetArt: "", casterArt: "", specialArt: "", effectArt: "", areaArt: "", missileArt: "",
  levelData: [{ cost: 0, cooldown: 0, castRange: 50, area: 0, duration: 20, heroDuration: 20, castTime: 0, data: [16, 800], dataStr: [], buffs: [], summon: "" }],
};

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

function world() {
  const W = 64, H = 64;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  w.abilities = { get: (id) => (id === "Acan" ? ACAN : undefined), all: () => [ACAN], buffFx: () => [] };
  return w;
}

/** Ghoul (UnitWeapons.slk `ugho`): melee, `acquire` 600. */
const WEAPON = {
  enabled: true, targets: ["ground", "structure", "debris", "tree", "wall"], acquire: 600, range: 100,
  dice: 1, sides: 2, base: 12, damage: 12, baseDamage: 12, cooldown: 1.3, rangeMotionBuffer: 250,
  damagePoint: 0.5, backswing: 0.5, attackType: "normal", ranged: false,
  projectile: "", projectileSpeed: 0, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0,
  spillDist: 0, spillRadius: 0, damageLoss: 0,
};

let nextId = 1;
function ghoul(w, hp) {
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "ugho", x: 0, y: 0, facing: 0,
    hp, maxHp: 340, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 100, radius: 16, scale: 1, armor: 0, armorType: "heavy", defUp: 0,
    weapon: WEAPON, weapons: [WEAPON], oldWeapons: [WEAPON],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "undead",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Ghoul",
    worker: null, depotGold: false, depotLumber: false,
  });
  u.x = 0;
  u.y = 0;
  u.abilities = [{ id: "Acan", code: "Acan", level: 1, cooldownLeft: 0, autocastOn: false }];
  return u;
}

/** A hurt Ghoul standing over a Footman's body. */
function scene(hp = 100, body = true, bodyX = 20) {
  const w = world();
  const g = ghoul(w, hp);
  if (body) w.spawnCorpseOf("hfoo", bodyX, 0, 1);
  return { w, g };
}

const body = (w) => [...w.corpses.values()][0];
const meal = (u) => u.buffs.filter((b) => b.group === "cannibalize").length;
const step = (w, seconds, dt = 0.05) => { for (let i = 0; i < Math.round(seconds / dt); i++) w.tick(dt); };

// --- the channel runs and heals ----------------------------------------------------------
{
  const { w, g } = scene();
  check("Cannibalize is cast over a body", w.issueCast(g.id, "Acan", 0, 0, 0), true);
  step(w, 0.2);
  check("…the Ghoul is eating", [g.order, meal(g)], ["cast", 1]);
  check("…and holds a channel a group order must not break", w.holdsChannel(g.id), true);
  step(w, 5);
  check("…still channelling five seconds in", [g.order, meal(g)], ["cast", 1]);
  check("…over a body that is still lying there, and is the Ghoul's", [w.corpses.size, body(w).raised, body(w).eatenBy], [1, false, g.id]);
  check("…at 16 hp a second", Math.abs(g.hp - (100 + 16 * 5.2)) <= 1.6, true); // within a tick
}

// --- moving breaks it ---------------------------------------------------------------------
{
  const { w, g } = scene();
  w.issueCast(g.id, "Acan", 0, 0, 0);
  step(w, 2);
  w.issueMove(g.id, 400, 0);
  w.tick(0.05);
  check("walking off ends the meal", meal(g), 0);
  check("…and the half-eaten body disappears", body(w).raised, true);
  const hp = g.hp;
  step(w, 2);
  check("…and the healing with it", Math.round(g.hp), Math.round(hp));
}

// --- a stun breaks it --------------------------------------------------------------------
{
  const { w, g } = scene();
  w.issueCast(g.id, "Acan", 0, 0, 0);
  step(w, 2);
  g.buffs.push({ kind: "stun", group: "test", timeLeft: 3, sourceId: 0, value: 0, value2: 0, fx: [] });
  step(w, 0.2);
  check("a stunned Ghoul stops eating", meal(g), 0);
  check("…and its body is gone", body(w).raised, true);
  const hp = g.hp;
  step(w, 5);
  check("…and does not start again when the stun wears off", [meal(g), Math.round(g.hp)], [0, Math.round(hp)]);
}

// --- a full Ghoul gets up ----------------------------------------------------------------
{
  const { w, g } = scene(300);
  w.issueCast(g.id, "Acan", 0, 0, 0);
  step(w, 4); // 40 hp at 16/s is 2.5s
  check("the meal ends at full health", [g.hp, meal(g)], [340, 0]);
  check("…and so does the body", body(w).raised, true);
  check("…and the Ghoul is released rather than standing out the clock", [g.order !== "cast", w.holdsChannel(g.id)], [true, false]);
}

// --- running out ---------------------------------------------------------------------------
{
  const { w, g } = scene(10);
  w.issueCast(g.id, "Acan", 0, 0, 0);
  step(w, 21);
  check("a meal lasts Dur1 and no longer", [meal(g), g.order !== "cast", Math.round(g.hp)], [0, true, Math.round(10 + 16 * 20)]);
  check("…and the body is eaten up at the end", [body(w).raised, body(w).eatenBy], [true, 0]);
}

// --- a body with seconds left on it does not rot away mid-meal ----------------------------------
{
  const { w, g } = scene(10);
  body(w).decayLeft = 1;
  w.issueCast(g.id, "Acan", 0, 0, 0);
  step(w, 5);
  check("a nearly-rotted body lasts the meal", [w.corpses.size, body(w).raised, meal(g)], [1, false, 1]);
}

// --- a second Ghoul looks past a body that is already being eaten -------------------------------
{
  const { w, g } = scene(100, true, 20);
  const g2 = ghoul(w, 100);
  w.issueCast(g.id, "Acan", 0, 0, 0);
  step(w, 0.5);
  check("a body another Ghoul is eating is not a meal", w.issueCast(g2.id, "Acan", 0, 0, 0), false);
}

// --- a body across the field is walked to ----------------------------------------------------
{
  const { w, g } = scene(100, true, 300);
  check("a body 300 away is not a refusal", w.issueCast(g.id, "Acan", 0, 0, 0), true);
  step(w, 0.3);
  check("…the Ghoul sets off towards it", [g.order, g.x > 20, meal(g)], ["cast", true, 0]);
  step(w, 2);
  check("…and eats when it gets there", [g.order, meal(g), g.x > 200], ["cast", 1, true]);
}
{
  const { w, g } = scene(100, true, 800);
  check("a body beyond its acquisition range is refused", w.issueCast(g.id, "Acan", 0, 0, 0), false);
}

// --- nothing to eat ------------------------------------------------------------------------
{
  const { w, g } = scene(100, false);
  check("no body in reach, no cast", w.issueCast(g.id, "Acan", 0, 0, 0), false);
  step(w, 0.5);
  check("…so the Ghoul never stands there channelling", [g.order !== "cast", meal(g)], [true, 0]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
