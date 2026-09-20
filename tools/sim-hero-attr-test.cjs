// Headless check of HERO ATTRIBUTES — `GetHeroStr`/`SetHeroStr` and their Agi/Int twins, plus
// `SuspendHeroXP` (docs/map-compatibility.md pass 1).
//
// This is the most-called family a downloaded custom map uses: ~450 call sites across the eleven
// maps in the install's own `Maps\Download`, 295 of them in Angel Arena Allstars alone. Every one
// of them read zero before this existed, so every stat-shop price and attribute-scaled spell in
// those maps was computing against nothing.
//
// Driven through the real sim entry points the JASS hooks call (`SimWorld.heroAttribute`,
// `setHeroAttribute`, `suspendHeroXp`, `gainXp`, `recomputeStats`) rather than through the
// interpreter, because what is worth pinning is the ARITHMETIC: which of the two numbers the
// `includeBonuses` flag picks, and that a setter writes the base rather than the derived value.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { MISC_GAME } = require(join(REPO, ".sim-build", "src", "data", "gameplayConstants.js"));

const N = 128;
const world = new SimWorld(
  new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
  { get: () => undefined, has: () => false, buffFx: () => [] },
  { get: () => undefined, has: () => false },
  { get: () => ({ priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 }), has: () => false },
);

let nextId = 1;
/** A hero shaped like an Archmage: 14/14/18 with 1.0/1.0/3.0 growth, Intelligence primary. */
function hero(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "Hamg", x: 500, y: 500, prevX: 500, prevY: 500,
    hp: 500, maxHp: 500, mana: 100, maxMana: 100, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: true, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "human", level: 1, xp: 0,
    xpSuspended: false, skillPoints: 0, hpRegen: 0, manaRegen: 0, baseMaxHp: 500, baseMaxMana: 100,
    baseHpRegen: 0, baseManaRegen: 0, baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270,
    radius: 16, footprint: 0, order: "idle", targetId: null, path: [], waypoint: 0, moving: false,
    facing: 0, pendingCast: null, followLeaderId: null, inCombat: false, working: false,
    atNode: false, noCollision: false, stallT: 0, waitT: 0, gaveUp: false, acquireT: 0,
    arrowShot: null, constructing: 0, cooldownLeft: 0, linkT: 0, linkGroup: [], repathT: 0,
    stunned: false, magicImmune: false, detectRadius: 0, summonLeft: 0, immolation: "",
    cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false,
    baseStr: 14, baseAgi: 14, baseInt: 18, startStr: 14, startAgi: 14, startInt: 18,
    str: 14, agi: 14, int: 18, strPerLevel: 1.0, agiPerLevel: 1.0, intPerLevel: 3.0,
    primaryAttr: 2, // Intelligence
    ...over,
  };
  world.units.set(u.id, u);
  world.recomputeStats(u);
  return u;
}

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}, got ${got}`}`);
}

// --- 1. the two numbers `includeBonuses` picks between ----------------------------------
// At level 1 there is no growth and no item, so they agree — which is exactly why a map that
// reads the wrong one still looks right until the hero levels or picks something up.
{
  const h = hero();
  check("level 1, no bonuses: str reads the type's own", world.heroAttribute(h.id, "str", false), 14);
  check("level 1, with bonuses: the same", world.heroAttribute(h.id, "str", true), 14);
  check("level 1 int", world.heroAttribute(h.id, "int", false), 18);
}

// --- 2. growth is in BOTH readings; an item is in only one -------------------------------
{
  const h = hero({ level: 5 });
  world.recomputeStats(h);
  // int 18 + 3.0/level × 4 levels = 30
  check("level 5 int, unbonused, includes growth", world.heroAttribute(h.id, "int", false), 30);
  check("level 5 int, bonused, same with no item", world.heroAttribute(h.id, "int", true), 30);
  // A buffed attribute counts exactly as an item's does (recomputeStats' `buffStr` pool) and is
  // the reading `includeBonuses` false must NOT see.
  h.buffs.push({ kind: "strength", value: 6, abilityId: "Nrg5", timeLeft: -1 });
  world.recomputeStats(h);
  check("a +6 strength buff shows with bonuses", world.heroAttribute(h.id, "str", true), 18 + 6);
  check("…and is invisible without them", world.heroAttribute(h.id, "str", false), 18);
}

// --- 3. a setter writes the BASE, so the tick does not undo it ---------------------------
// The bug this pins: `u.str` is derived from `baseStr` by recomputeStats EVERY tick, so a
// setter that wrote the derived number would read back correctly once and be gone by the next
// frame. Setting at a level with growth on it is what tells the two apart.
{
  const h = hero({ level: 5 });
  world.recomputeStats(h);
  world.setHeroAttribute(h.id, "str", 50, true);
  check("SetHeroStr(50) reads back at once", world.heroAttribute(h.id, "str", false), 50);
  for (let i = 0; i < 3; i++) world.recomputeStats(h); // the ticks that used to eat it
  check("…and survives recomputeStats", world.heroAttribute(h.id, "str", false), 50);
  check("…and is on the unit itself", h.str, 50);
}

// --- 4. it confers what an attribute confers ---------------------------------------------
// The whole point of the family: a stat shop that sells +10 strength must sell hit points with
// it. `StrHitPointBonus` is the game's own (Units\MiscGame.txt), read through gameplayConstants.
{
  const h = hero();
  const before = h.maxHp;
  world.setHeroAttribute(h.id, "str", 14 + 10, true);
  check("+10 strength is +10×StrHitPointBonus max hp", h.maxHp - before, 10 * MISC_GAME.StrHitPointBonus);
  const mana = h.maxMana;
  world.setHeroAttribute(h.id, "int", 18 + 4, true);
  check("+4 intelligence is +4×IntManaBonus max mana", h.maxMana - mana, 4 * MISC_GAME.IntManaBonus);
}

// --- 5. growth still lands on top of a set value ------------------------------------------
{
  const h = hero();
  world.setHeroAttribute(h.id, "int", 100, true);
  world.setHeroLevel(h.id, 3, false);
  // The base was solved at level 1, so two levels of 3.0 growth ride on top of the 100.
  check("a set attribute keeps growing per level", world.heroAttribute(h.id, "int", false), 100 + 6);
}

// --- 6. a floor of 1, and a non-hero is not a hero ----------------------------------------
{
  const h = hero();
  world.setHeroAttribute(h.id, "agi", -5, true);
  check("an attribute floors at 1", world.heroAttribute(h.id, "agi", false), 1);
  const grunt = hero({ isHero: false, baseStr: 0, str: 0, strPerLevel: 0 });
  check("a non-hero has no attributes", world.heroAttribute(grunt.id, "str", true), 0);
  world.setHeroAttribute(grunt.id, "str", 99, true);
  check("…and cannot be given any", grunt.str, 0);
}

// --- 7. SuspendHeroXP ---------------------------------------------------------------------
// Note the polarity — the flag says SUSPENDED, so `false` is the one that lets him earn.
{
  const h = hero();
  world.gainXp(h, 100, false, false);
  check("a hero banks experience", h.xp, 100);
  world.suspendHeroXp(h.id, true);
  world.gainXp(h, 500, false, false);
  check("SuspendHeroXP(true) stops the crediting", h.xp, 100);
  check("…and the bar keeps what it had", h.level, 1);
  // A suspended hero can still be LEVELLED — the suspension is on banking, not on levelling.
  world.setHeroLevel(h.id, 3, false);
  check("…while SetHeroLevel still works", h.level, 3);
  world.suspendHeroXp(h.id, false);
  const at3 = h.xp;
  world.gainXp(h, 50, false, false);
  check("SuspendHeroXP(false) lets him earn again", h.xp, at3 + 50);
}

console.log(failed ? `\n${failed} FAILED` : "\nall hero-attribute checks passed");
process.exit(failed ? 1 : 0);
