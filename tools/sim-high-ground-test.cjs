// Headless check of the HIGH GROUND miss (issue #291) and the "miss" text every miss raises.
// See src/sim/world.ts (shootsUphill, rollMiss, noteMiss).
//
// The number is the install's: Units\MiscData.txt `ChanceToMiss=0.25`, "missile chance to miss
// if target is moving or on high ground". The condition is classic.battle.net's combat basics
// ("High Ground"): "Ranged units (Missile) will miss a lot (25% chance to miss) when trying to
// shoot up to higher ground … charge up the hill to the same level as the enemy."
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const G = require(join(REPO, ".sim-build", "src", "data", "gameplayConstants.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// A map split down the middle: x < 1000 is the low ground, x >= 1000 one cliff level (128) up,
// with a ramp between 900 and 1000 the sampler interpolates across — as heightmap.ts does.
const level = (x) => (x >= 1000 ? 128 : x <= 900 ? 0 : ((x - 900) / 100) * 128);
function world(roll) {
  const w = new SimWorld({ width: 16, height: 16, cell: 128, blocked: new Uint8Array(256) }, 1);
  w.abilities = { get: () => undefined, all: () => [] };
  w.setCliffLevelField((x) => level(x));
  let draws = 0;
  w.rng = () => (draws++, roll);
  w.draws = () => draws;
  return w;
}
let nextId = 1;
function unit(w, over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, x: 500, y: 500, hp: 1000, maxHp: 1000, mana: 0, maxMana: 0,
    buffs: [], abilities: [], inventory: [], weapons: [], garrison: [], orderQueue: [],
    arrowShot: null, blackArrow: null, incinerate: null, isHero: false, isSummon: false,
    building: null, mechanical: false, flying: false, invulnerable: false, neutralPassive: false,
    isIllusion: false, race: "human", typeId: "hrif", level: 1, baseMaxHp: 1000, baseMaxMana: 0,
    baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, hpRegen: 0, manaRegen: 0, lifesteal: 0,
    thorns: 0, swingCrit: false, swingBash: false, cloaked: false, devouring: 0, devouredBy: 0,
    garrisonHost: 0, constructing: 0, inMine: false, resId: 0, linkShare: 0, linkT: 0, linkGroup: [],
    radius: 16, ...over,
  };
  w.units.set(u.id, u);
  return u;
}
const LOW = { x: 500 }, HIGH = { x: 1200 };
const foe = (w, over) => unit(w, { owner: 1, team: 1, ...over });
// What the blow took off the target — read off its hit points, the thing a miss leaves alone.
const shoot = (w, a, t, ranged = true) => {
  const before = t.hp;
  w.applyDamage(t, 100, a.id, "normal", "", ranged);
  return before - t.hp;
};

check("the chance is the file's", G.MISC_DATA.ChanceToMiss, 0.25);
check("…and it has a reader now", G.miscKeyIsRead("ChanceToMiss"), true);

console.log("\nshooting UP a cliff level misses a quarter of the time");
{
  const w = world(0.2); // under 0.25
  const a = unit(w, LOW), t = foe(w, HIGH);
  check("a roll under 0.25 deals nothing", shoot(w, a, t), 0);
  check("…and floats one \"miss\" over the target, for everyone", w.drainCombatTexts().map((x) => [x.kind, x.unitId, x.text, x.forPlayer]), [["miss", t.id, "", -1]]);
}
{
  const w = world(0.3);
  const a = unit(w, LOW), t = foe(w, HIGH);
  check("a roll over it lands", shoot(w, a, t) > 0, true);
  check("…with no text", w.drainCombatTexts().length, 0);
}

console.log("\n…and nothing else does");
{
  const w = world(0);
  const hit = (a, t, ranged) => shoot(w, a, t, ranged) > 0;
  check("shooting DOWN", hit(unit(w, HIGH), foe(w, LOW)), true);
  check("level ground, low", hit(unit(w, LOW), foe(w, { x: 700 })), true);
  check("level ground, high", hit(unit(w, HIGH), foe(w, { x: 1400 })), true);
  check("two bodies on one ramp (under half a level apart)", hit(unit(w, { x: 910 }), foe(w, { x: 950 })), true);
  check("a melee blow", hit(unit(w, LOW), foe(w, HIGH), false), true);
  check("a flyer shooting up", hit(unit(w, { ...LOW, flying: true }), foe(w, HIGH)), true);
  check("a flyer being shot at", hit(unit(w, LOW), foe(w, { ...HIGH, flying: true })), true);
  check("none of them drew from the match's random stream", w.draws(), 0);
  check("a BUILDING on the high ground is missed like anything else", hit(unit(w, LOW), foe(w, { ...HIGH, building: {} })), false);
  check("…and so is one shot at from the foot of a ramp", hit(unit(w, LOW), foe(w, { x: 990 })), false);
  w.drainCombatTexts();
}
{
  const w = new SimWorld({ width: 16, height: 16, cell: 128, blocked: new Uint8Array(256) }, 1);
  w.abilities = { get: () => undefined, all: () => [] };
  w.rng = () => 0;
  check("a world with no terrain has no high ground", shoot(w, unit(w, LOW), foe(w, HIGH)) > 0, true);
}

console.log("\na SPLASH shot uphill still bursts, at 1 - MissDamageReduction");
{
  const w = world(0.2);
  const a = unit(w, LOW), t = foe(w, HIGH);
  check("the struck unit's share", w.splashHitShare(a, t), 1 - G.MISC_GAME.MissDamageReduction);
  check("Attack Ground up a cliff is measured at the GROUND aimed at", w.splashHitShare(a, undefined, { x: 1200, y: 500 }), 0.5);
  check("…and down one is not a miss", w.splashHitShare(unit(w, HIGH), undefined, { x: 500, y: 500 }), 1);
  check("the two misses left their text — the second on the ground", w.drainCombatTexts().map((x) => [x.kind, x.unitId, x.x]), [["miss", t.id, 1200], ["miss", 0, 1200]]);
}

console.log("\nevery OTHER miss raises the same text");
{
  const w = world(0.1);
  const a = unit(w, { ...LOW, buffs: [{ kind: "miss", value: 0.33 }] }), t = foe(w, { x: 700 });
  check("a Cursed swing on level ground misses", shoot(w, a, t, false), 0);
  check("…under the same word", w.drainCombatTexts().map((x) => x.kind), ["miss"]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall high-ground checks passed");
process.exit(failed ? 1 : 0);
