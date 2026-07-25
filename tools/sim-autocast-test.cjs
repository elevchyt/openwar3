// Headless check of autocast PRIORITY and autocast REACH (issue #94).
//
// Two rules, both taken from the game rather than invented:
//
//  * An order suppresses autocast, but attack-move / patrol / stop do not — Liquipedia
//    (Autocast): "If a unit is given a order, it usually prioritizes this order and does not
//    cast the autocast ability until the order is finished", with attack-move, patrol, stop
//    and hold position called out as leaving autocast active. So only an EXPLICIT single-
//    target Attack command (`attackOrdered`) beats a Priest's Heal; an attack the Priest
//    picked up by itself does not.
//  * The search reaches the caster's ACQUISITION range, not the spell's cast range —
//    "Any friendly unit within acquisition range of the Priest will be automatically healed"
//    (Warcraft Wiki, Priest), and autocast "can cause it to move in order to cast their
//    spell" (Liquipedia). Real 1.27a numbers: Priest `acquire` 600 (Units\UnitWeapons.slk)
//    against Heal `Rng1` 250 / `Cost1` 5 (Units\AbilityData.slk).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

// Heal (`Ahea`) as the 1.27a row has it.
const HEAL = {
  id: "Ahea", code: "Ahea", target: "unit",
  targetFlags: ["air", "ground", "friend", "vuln", "invu", "self", "organic", "nonancient", "neutral"],
  levelData: [{ cost: 5, cooldown: 1, castRange: 250, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: [25], buffs: [], summon: "" }],
};

/** The Priest's ranged slot — `acquire` 600 is the number this whole issue turns on. */
const PRIEST_WEAPON = {
  enabled: true, targets: ["ground", "air", "structure"], acquire: 600, range: 600,
  dice: 1, sides: 2, base: 9, damage: 9, baseDamage: 9, cooldown: 1.9, rangeMotionBuffer: 250,
  damagePoint: 0.3, backswing: 0.3, attackType: "magic", ranged: true,
  projectile: "", projectileSpeed: 900, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0,
  spillDist: 0, spillRadius: 0, damageLoss: 0,
};
const FOOTMAN_WEAPON = { ...PRIEST_WEAPON, acquire: 500, range: 90, ranged: false, attackType: "normal" };

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
  w.abilities = { get: (id) => (id === "Ahea" ? HEAL : undefined), all: () => [HEAL] };
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

/** A Priest with Heal on autocast. */
function priest(w, over = {}) {
  const u = add(w, {
    typeId: "hmpr", hp: 290, maxHp: 290, mana: 200, maxMana: 200,
    weapon: PRIEST_WEAPON, weapons: [PRIEST_WEAPON], oldWeapons: [PRIEST_WEAPON], name: "Priest",
    ...over,
  });
  u.abilities = [{ id: "Ahea", code: "Ahea", level: 1, cooldownLeft: 0, autocastOn: true }];
  u.mana = 200;
  return u;
}

// --- reach: the search runs to acquisition range and walks the rest ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const hurt = add(w, { x: 500, y: 0, hp: 100, maxHp: 220 }); // past Heal's 250, inside acquire 600
  check("a wounded ally past cast range but inside acquisition range is taken", w.tickAutocast(p), true);
  check("…as a cast order aimed at it", [p.order, p.pendingCast.targetId], ["cast", hurt.id]);
  check("…flagged as autocast, so the approach can give up", p.pendingCast.auto, true);
  check("…with Heal's own 250 as the range to close to", p.pendingCast.range, 250);
}

// --- reach: and stops at acquisition range ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  add(w, { x: 900, y: 0, hp: 100, maxHp: 220 }); // past acquire 600
  check("a wounded ally past acquisition range is not", w.tickAutocast(p), false);
  check("…and the Priest keeps its order", p.order, "idle");
}

// --- priority: an attack the unit picked up itself yields ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const foe = add(w, { owner: 1, team: 1, x: 300, y: 0 });
  const hurt = add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  w.issueAttack(p.id, foe.id); // no `ordered` flag: this is the unit's own auto-acquisition
  check("…which really is an attack order", [p.order, p.attackOrdered], ["attack", false]);
  w.tickAttack(p, 0.1);
  check("an AUTO-acquired attack gives way to Heal", [p.order, p.pendingCast && p.pendingCast.targetId], ["cast", hurt.id]);
}

// --- priority: an explicit Attack command does not ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const foe = add(w, { owner: 1, team: 1, x: 300, y: 0 });
  add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  w.issueAttack(p.id, foe.id, false, true); // the player clicked Attack on that one unit
  w.tickAttack(p, 0.1);
  check("an EXPLICIT attack order overrides the autocast", [p.order, p.targetId], ["attack", foe.id]);
}

// --- priority: attack-move heals before it shoots ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  add(w, { owner: 1, team: 1, x: 400, y: 0 }); // an enemy well inside acquisition range
  const hurt = add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  p.order = "attackmove";
  p.amDestX = 2000;
  p.amDestY = 0;
  w.tickAttackMove(p, 0.1);
  check("attack-move casts instead of acquiring the enemy", [p.order, p.pendingCast && p.pendingCast.targetId], ["cast", hurt.id]);
  check("…and remembers to resume the march afterwards", p.pendingCast.resume, { kind: "attackmove", x: 2000, y: 0 });
}

// --- the off switches: autocast toggled off, and no mana ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  p.abilities[0].autocastOn = false;
  check("autocast off: nothing is cast", w.tickAutocast(p), false);
  p.abilities[0].autocastOn = true;
  p.mana = 4; // Heal costs 5
  check("not enough mana: nothing is cast", w.tickAutocast(p), false);
}

// --- nobody is hurt ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  add(w, { x: 200, y: 0, hp: 220, maxHp: 220 });
  check("a full-health ally is not healed", w.tickAutocast(p), false);
}

// --- give up mid-walk when somebody else heals the target first ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const hurt = add(w, { x: 500, y: 0, hp: 100, maxHp: 220 });
  w.tickAutocast(p);
  check("the Priest sets off", p.order, "cast");
  w.tickCast(p, 0.1);
  check("…still walking while the ally is hurt", p.order, "cast");
  hurt.hp = hurt.maxHp; // somebody else got there first
  w.tickCast(p, 0.1);
  check("…and turns back once it is topped up", p.order, "idle");
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
