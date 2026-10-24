// Headless check of TARGET_RULES (src/sim/targetRules.ts) — the rules about who an ability may
// be aimed at that no Targets Allowed list can state, asked through ONE door (`targetError`) by
// a spell button, an item, an autocast, a computer and a script's order alike.
//
// The case that opened it: a Wand of Mana Stealing (`Aste`, `targs1 = notself` and nothing else)
// could be pressed at an Arcane Vault. The flags name no kind, so they admit a building; what
// refuses it is that the vault has no mana — `Targetmanauser` "Must target a unit with mana." —
// while a Moon Well, which has a pool, stays a legal target. And two rules that used to live
// only in `itemUseError` (Control Magic's summons, the Scepter's creep cap) now hold for the
// spell button as well as the item.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const D = (...v) => { const a = new Array(9).fill(NaN); v.forEach((x, i) => { a[i] = x; }); return a; };
const lvl = (over = {}) => ({
  cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0,
  data: D(), dataStr: [], buffs: [], summon: "", ...over,
});
const ability = (id, code, over = {}) => ({
  id, code, isHero: false, isItem: true, levels: 1, reqLevel: 0, levelSkip: 0,
  target: "none", targetFlags: [], autocast: false, name: id, icon: "", hotkey: "",
  researchHotkey: "", buttonX: 0, buttonY: 0, learnX: 0, learnY: 0, research: false,
  tips: [], uberTips: [], researchTip: "", researchUberTip: "",
  missileArt: "", targetArt: "", targetAttach: [], casterArt: "", specialArt: "", effectArt: "",
  areaArt: "", fxArt: "", effectSound: "", buffFx: [], buffArt: "", buffEffectArt: "",
  buffSpecialArt: "", lightning: [], animNames: [], order: "", orderOn: "", orderOff: "",
  levelData: [lvl()], ...over,
});

// Every row below is the install's own 1.30.4 `Units\AbilityData.slk` line, as far as it matters.
const ABILITIES = new Map([
  // `[Aste]` ManaSteal — targs1 `notself`, Cool1 10, Rng1 650, DataA1 50
  ["Aste", ability("Aste", "Aste", { target: "unit", targetFlags: ["notself"], levelData: [lvl({ cooldown: 10, castRange: 650, data: D(50) })] })],
  // `[AIcm]` Control Magic (item) — code Acmg, targs1 `air,ground,enemy,neutral,ward,organic`
  ["AIcm", ability("AIcm", "Acmg", { target: "unit", targetFlags: ["air", "ground", "enemy", "neutral", "ward", "organic"], levelData: [lvl({ castRange: 700, data: D(5, 0.35) })] })],
  // `[AIco]` ItemCommand — targs1 `air,ground,nonhero,enemy,neutral`, Rng1 750, DataA1 5
  ["AIco", ability("AIco", "AIco", { target: "unit", targetFlags: ["air", "ground", "nonhero", "enemy", "neutral"], levelData: [lvl({ castRange: 750, data: D(5) })] })],
  // `[ANch]` Charm — the hero ability, DataA1 5 "Maximum Creep Level"
  ["ANch", ability("ANch", "ANch", { isItem: false, isHero: true, target: "unit", targetFlags: ["air", "ground", "nonhero", "enemy", "neutral", "organic"], levelData: [lvl({ castRange: 700, data: D(5) })] })],
]);
const item = (id, abils, over = {}) => ({
  id, name: id, description: "", icon: "", tip: "", hotkey: "", buttonX: -1, buttonY: -1,
  model: "", scale: 1, gold: 0, lumber: 0, level: 0, classType: "Charged", abilities: abils,
  charges: 3, cooldownGroup: id, usable: true, perishable: true, powerup: false, droppable: true,
  sellable: true, pawnable: true, pickRandom: false, maxHp: 75, stockMax: 1, stockRegen: 120,
  stockStart: 0, ...over,
});
const ITEMS = new Map([
  ["woms", item("woms", ["Aste"])], // Wand of Mana Stealing — 3 charges
  ["gsou", item("gsou", ["AIcm"])], // Gloves of Spell Mastery
  ["ccmd", item("ccmd", ["AIco"])], // Scepter of Mastery
]);

const N = 256;
const newWorld = () =>
  new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] },
    { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) },
    { get: () => ({ priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2, classification: [] }), has: () => false });

let world = newWorld();
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 1000, y: 1000, prevX: 1000, prevY: 1000,
    hp: 100, maxHp: 1000, mana: 0, maxMana: 0, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "human", level: 1, xp: 0,
    skillPoints: 0, hpRegen: 0, manaRegen: 0, baseMaxHp: 1000, baseMaxMana: 0, baseHpRegen: 0,
    baseManaRegen: 0, baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, radius: 16, footprint: 0,
    order: "idle", targetId: null, path: [], waypoint: 0, moving: false, facing: 0,
    pendingCast: null, followLeaderId: null, inCombat: false, working: false, atNode: false,
    noCollision: false, stallT: 0, waitT: 0, gaveUp: false, acquireT: 0, arrowShot: null,
    constructing: 0, cooldownLeft: 0, linkT: 0, linkGroup: [], repathT: 0, stunned: false,
    baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0, str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0,
    intPerLevel: 0, primaryAttr: 0, magicImmune: false, detectRadius: 0, summonLeft: 0,
    immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const give = (u, itemId, slot = 0) => { u.inventory[slot] = { id: nextId++, itemId, charges: ITEMS.get(itemId).charges, cooldownLeft: 0 }; return u; };
const building = (over = {}) => unit({ typeId: "hvlt", building: { constructionLeft: 0 }, baseSpeed: 0, speed: 0, mechanical: true, owner: 1, team: 1, x: 1200, prevX: 1200, ...over });

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}, got ${got}`}`);
}

console.log("\nWand of Mana Stealing — a target WITHOUT a mana pool is refused, a building WITH one is not");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, mana: 0, maxMana: 300, baseMaxMana: 300 }), "woms");
  const vault = building(); // Arcane Vault: UnitBalance manaN "-"
  check("an Arcane Vault (no mana) is refused with the game's own line", world.itemUseError(hero.id, 0, vault.id, true), "Targetmanauser");
  check("…the press is refused at the door too", world.useItem(hero.id, 0, vault.id, 0, 0), false);
  check("…and keeps every charge", hero.inventory[0].charges, 3);
  const far = building({ x: 3000, prevX: 3000 });
  check("an Arcane Vault out of reach is refused rather than walked to", world.useItem(hero.id, 0, far.id, 0, 0), false);
  check("…and the hero does not set off", hero.order, "idle");
  const footman = unit({ owner: 1, team: 1, x: 1100, prevX: 1100 });
  check("a Footman (no mana bar) is refused the same way", world.itemUseError(hero.id, 0, footman.id, true), "Targetmanauser");
  // Moon Well: UnitBalance mana0 100 / manaN 300 — a building, and a legal target.
  const well = building({ typeId: "emow", race: "nightelf", mana: 200, maxMana: 300, baseMaxMana: 300 });
  check("a Moon Well (a building WITH mana) may be aimed at", world.itemUseError(hero.id, 0, well.id, true), null);
  check("…the wand fires", world.useItem(hero.id, 0, well.id, 0, 0), true);
  check("…the well loses DataA", well.mana, 150);
  check("…and the hero gains it", hero.mana, 50);
  check("…for one charge", hero.inventory[0].charges, 2);
}
{
  world = newWorld();
  const hero = give(unit({ isHero: true, mana: 0, maxMana: 300, baseMaxMana: 300 }), "woms");
  check("the hero is not a target of his own wand (`notself`)", world.itemUseError(hero.id, 0, hero.id, true), "Notself");
}

console.log("\nControl Magic takes SUMMONS only — on the item AND on the Spell Breaker's own button");
{
  world = newWorld();
  const breaker = give(unit({ mana: 300, maxMana: 300 }), "gsou");
  const grunt = unit({ owner: 1, team: 1, x: 1100, prevX: 1100, race: "orc" });
  const elemental = unit({ owner: 1, team: 1, x: 1100, prevX: 1100, isSummon: true, summonLeft: 40 });
  check("the Gloves refuse a Grunt", world.itemUseError(breaker.id, 0, grunt.id, true), "Needsummoned");
  check("…and accept a Water Elemental", world.itemUseError(breaker.id, 0, elemental.id, true), null);
  const flags = ABILITIES.get("AIcm").targetFlags;
  check("the spell's own door refuses the Grunt too", world.targetError(breaker, grunt, flags, "Acmg"), "Needsummoned");
}

console.log("\nCreep level caps — the Scepter of Mastery and Charm read the same rule off their own rows");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "ccmd");
  const small = unit({ owner: 12, team: -1, isCreep: true, level: 5, x: 1100, prevX: 1100 });
  const big = unit({ owner: 12, team: -1, isCreep: true, level: 6, x: 1100, prevX: 1100 });
  check("the Scepter takes a level 5 creep", world.itemUseError(hero.id, 0, small.id, true), null);
  check("…and refuses a level 6 one", world.itemUseError(hero.id, 0, big.id, true), "Creeptoopowerful");
  const ranger = unit({ isHero: true, abilities: [{ id: "ANch", code: "ANch", level: 1, cooldownLeft: 0 }] });
  const flags = ABILITIES.get("ANch").targetFlags;
  check("Charm takes a level 5 creep", world.targetError(ranger, small, flags, "ANch"), null);
  check("…and refuses a level 6 one at the order (it used to spend the mana in the handler)", world.targetError(ranger, big, flags, "ANch"), "Creeptoopowerful");
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall target-rule checks passed");
