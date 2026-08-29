// Headless check of ITEM EFFECTS (issue #130) — the half of the item system that is not the
// inventory but what the item DOES: who a pressed item's effect lands on, and the passives a
// carried item is supposed to be feeding into the sim.
//
// Everything is driven through the real entry points (`useItem`, `recomputeStats`,
// `applyAuras`, `applyDamage`, `tryReincarnate`) with stub registries carrying the install's
// own 1.30.4 numbers, quoted per case below from `Units\AbilityData.slk`.
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

// `targs1 = air,ground,friend,self,organic,vuln,invu` — the regeneration/restore family's,
// verbatim. `organic` is what keeps a scroll off the Siege Engines and `friend` off the enemy.
const FRIENDLY_ORGANIC = ["air", "ground", "friend", "self", "organic", "vuln", "invu"];

const ABILITIES = new Map([
  // --- the AIrg family: one code, three aims (see SimWorld.applyItemAbility) --------------
  // AIsl  Scroll of Regeneration  Dur 45, Area 600, DataA 225
  ["AIsl", ability("AIsl", "AIrg", { targetFlags: FRIENDLY_ORGANIC, levelData: [lvl({ duration: 45, heroDuration: 45, area: 600, data: D(225) })] })],
  // AIrl  Healing Salve           Dur 45, Rng 500, DataA 400 — "a target unit's hit points"
  ["AIrl", ability("AIrl", "AIrg", { target: "unit", targetFlags: FRIENDLY_ORGANIC, levelData: [lvl({ duration: 45, heroDuration: 45, castRange: 500, data: D(400) })] })],
  // AIpr  Clarity Potion          Dur 45, DataB 200 — "the Hero's mana", nothing else
  ["AIpr", ability("AIpr", "AIrg", { levelData: [lvl({ duration: 45, heroDuration: 45, data: D(NaN, 200) })] })],
  // --- the instant restores ---------------------------------------------------------------
  // AIh1  Potion of Healing       Cool 20, DataA 250 — no area, no targs: the drinker's alone
  ["AIh1", ability("AIh1", "AIhe", { levelData: [lvl({ cooldown: 20, castRange: 100, data: D(250) })] })],
  // AIha  Scroll of Healing       Cool 25, Area 600, DataA 150 — "all friendly … around the Hero"
  ["AIha", ability("AIha", "AIha", { targetFlags: FRIENDLY_ORGANIC, levelData: [lvl({ cooldown: 25, area: 600, castRange: 250, data: D(150) })] })],
  // AIra  Scroll of Restoration   Cool 40, Area 600, DataA 300 hp, DataB 150 mana
  ["AIra", ability("AIra", "AIra", { targetFlags: FRIENDLY_ORGANIC, levelData: [lvl({ cooldown: 40, area: 600, castRange: 250, data: D(300, 150) })] })],
  // --- carried passives -------------------------------------------------------------------
  ["AIev", ability("AIev", "AEev", { levelData: [lvl({ data: D(0.15) })] })], // Talisman of Evasion
  ["AImb", ability("AImb", "AImm", { levelData: [lvl({ data: D(150) })] })], // Pendant of Energy
  ["AIsr", ability("AIsr", "AIsr", { levelData: [lvl({ data: D(NaN, 0.33) })] })], // Runed Bracers
  ["AIdd", ability("AIdd", "AIdd", { levelData: [lvl({ data: D(0.7, 1) })] })], // Arcanite Shield
  ["AImx", ability("AImx", "Amim", { levelData: [lvl({ data: D(10) })] })], // Necklace of Spell Immunity
  ["Adt1", ability("Adt1", "Adet", { levelData: [lvl({ castRange: 1100, data: D(3) })] })], // Gem of True Seeing
  // Warsong Battle Drums — Command Aura, Area 900, DataA 0.1 ("Damage Bonus (%)")
  ["AIcd", ability("AIcd", "AOac", { targetFlags: ["air", "ground", "friend", "self", "vuln", "invu"], levelData: [lvl({ area: 900, data: D(0.1, 1, 1) })] })],
  // Amulet of Spell Shield — Cool 40, buff BNss
  ["ANss", ability("ANss", "ANss", { levelData: [lvl({ cooldown: 40, buffs: ["BNss"] })] })],
  // Ankh of Reincarnation — DataA 7 (delay), DataB 500 (life), DataC -1 (keep mana)
  ["AIrc", ability("AIrc", "AIrc", { levelData: [lvl({ data: D(7, 500, -1) })] })],
  // Tome of Power — DataA 1 "Levels Gained"
  ["AIlm", ability("AIlm", "AIlm", { levelData: [lvl({ data: D(1) })] })],
]);

const item = (id, abils, over = {}) => ({
  id, name: id, description: "", icon: "", tip: "", hotkey: "", buttonX: -1, buttonY: -1,
  model: "", scale: 1, gold: 0, lumber: 0, level: 0, classType: "Purchasable", abilities: abils,
  charges: 1, cooldownGroup: id, usable: true, perishable: true, powerup: false, droppable: true,
  sellable: true, pawnable: true, pickRandom: false, maxHp: 75, stockMax: 1, stockRegen: 120,
  stockStart: 0, ...over,
});
const passive = (id, abils) => item(id, abils, { charges: 0, usable: false, perishable: false, classType: "Permanent" });
const ITEMS = new Map([
  ["sreg", item("sreg", ["AIsl"])], ["hslv", item("hslv", ["AIrl"])], ["pclr", item("pclr", ["AIpr"])],
  ["phea", item("phea", ["AIh1"])], ["shea", item("shea", ["AIha"])], ["sres", item("sres", ["AIra"])],
  ["tkno", item("tkno", ["AIlm"])],
  ["evtl", passive("evtl", ["AIev"])], ["penr", passive("penr", ["AImb"])],
  ["brac", passive("brac", ["AIsr"])], ["arsh", passive("arsh", ["AIdd"])],
  ["nspi", passive("nspi", ["AImx"])], ["gemt", passive("gemt", ["Adt1"])],
  ["ward", passive("ward", ["AIcd"])], ["spsh", passive("spsh", ["ANss"])],
  ["ankh", item("ankh", ["AIrc"], { usable: false })],
]);

const N = 256;
const newWorld = () =>
  new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] },
    { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) },
    { get: () => ({ priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 }), has: () => false });

let world = newWorld();
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 1000, y: 1000, prevX: 1000, prevY: 1000,
    hp: 100, maxHp: 1000, mana: 0, maxMana: 500, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "human", level: 1, xp: 0,
    skillPoints: 0, hpRegen: 0, manaRegen: 0, baseMaxHp: 1000, baseMaxMana: 500, baseHpRegen: 0,
    baseManaRegen: 0, baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, radius: 16, footprint: 0,
    order: "idle", targetId: null, path: [], waypoint: 0, moving: false, facing: 0,
    pendingCast: null, followLeaderId: null, inCombat: false, working: false, atNode: false,
    noCollision: false, stallT: 0, waitT: 0, gaveUp: false, acquireT: 0, arrowShot: null,
    constructing: 0, cooldownLeft: 0, linkT: 0, linkGroup: [], repathT: 0, stunned: false,
    baseStr: 0, baseAgi: 0, baseInt: 0, str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0,
    intPerLevel: 0, primaryAttr: 0, magicImmune: false, detectRadius: 0, summonLeft: 0,
    immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const give = (u, itemId, slot = 0) => { u.inventory[slot] = { id: nextId++, itemId, charges: ITEMS.get(itemId).charges, cooldownLeft: 0 }; world.recomputeStats(u); return u; };

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}, got ${got}`}`);
}
const near = (what, got, want, tol = 0.5) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}±${tol}, got ${Math.round(got * 100) / 100}`}`);
};
const regenOf = (u) => u.buffs.filter((b) => b.group?.startsWith("item:regen")).length;

console.log("\nScroll of Regeneration is an AREA effect, not a potion  (the bug this issue opens with)");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "sreg");
  const nearAlly = unit({ x: 1400, y: 1000, prevX: 1400, prevY: 1000 }); // 400 away — inside Area 600
  const farAlly = unit({ x: 2000, y: 1000, prevX: 2000, prevY: 1000 }); // 1000 away — outside it
  const enemy = unit({ x: 1100, y: 1000, prevX: 1100, prevY: 1000, owner: 1, team: 1 });
  const golem = unit({ x: 1100, y: 1100, prevX: 1100, prevY: 1100, mechanical: true }); // `organic`
  check("the scroll fires", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);
  check("…on the hero", regenOf(hero), 1);
  check("…and on the ally standing beside him", regenOf(nearAlly), 1);
  check("…but not one 1000 units away", regenOf(farAlly), 0);
  check("…nor the enemy inside the circle", regenOf(enemy), 0);
  check("…nor the mechanical unit inside it (`organic`)", regenOf(golem), 0);
  // DataA 225 over Dur 45 = 5 hp/sec, on everyone it reached.
  near("the rate is DataA/Dur1", hero.buffs[0].value, 225 / 45);
}

console.log("\n…while the Healing Salve beside it on the shelf is aimed at ONE unit");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "hslv");
  const ally = unit({ x: 1400, y: 1000, prevX: 1400, prevY: 1000 });
  const bystander = unit({ x: 1100, y: 1000, prevX: 1100, prevY: 1000 });
  check("the salve fires on the unit it was aimed at", world.useItem(hero.id, 0, ally.id, 0, 0), true);
  check("…the target regenerates", regenOf(ally), 1);
  check("…the hero holding it does not", regenOf(hero), 0);
  check("…and neither does the unit standing next to them", regenOf(bystander), 0);
}

console.log("\n…and the Clarity Potion, which names neither, is the drinker's alone");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, mana: 0 }), "pclr");
  const ally = unit({ x: 1100, y: 1000, prevX: 1100, prevY: 1000, mana: 0, maxMana: 500 });
  check("the potion fires", world.useItem(hero.id, 0, ally.id, 0, 0), true);
  check("…on the drinker", regenOf(hero), 1);
  check("…and nobody else, aimed or not", regenOf(ally), 0);
}

console.log("\nthe three SCROLLS that were only ever runes  (pressed, they did nothing at all)");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, hp: 100 }), "shea");
  const ally = unit({ x: 1400, y: 1000, prevX: 1400, prevY: 1000, hp: 100 });
  const far = unit({ x: 2000, y: 1000, prevX: 2000, prevY: 1000, hp: 100 });
  check("Scroll of Healing fires", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);
  near("…the hero is healed DataA", hero.hp, 250);
  near("…so is the ally in the circle", ally.hp, 250);
  near("…and nobody outside it", far.hp, 100);
}
{
  world = newWorld();
  const hero = give(unit({ isHero: true, hp: 100, mana: 0 }), "sres");
  check("Scroll of Restoration fires", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);
  near("…hp from DataA", hero.hp, 400);
  near("…and mana from DataB", hero.mana, 150);
}
{
  // Nothing to restore = nothing to spend. The charge stays on the scroll.
  world = newWorld();
  const hero = give(unit({ isHero: true, hp: 1000, mana: 500 }), "sres");
  check("a whole army needs no Scroll of Restoration", world.useItem(hero.id, 0, 0, hero.x, hero.y), false);
  check("…and the charge is not spent", hero.inventory[0].charges, 1);
}
{
  // …but ONE wounded ally in the circle is enough to justify it.
  world = newWorld();
  const hero = give(unit({ isHero: true, hp: 1000, mana: 500 }), "sres");
  const hurt = unit({ x: 1200, y: 1000, prevX: 1200, prevY: 1000, hp: 100 });
  check("one wounded ally is reason enough", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);
  near("…and he is the one who is healed", hurt.hp, 400);
}

console.log("\na CARRIED ability is an ability  (passiveLevelData reads the inventory too)");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "evtl");
  // AEev DataA 0.15 — the Demon Hunter's own Evasion row, worn as a Talisman.
  let dodged = 0;
  for (let i = 0; i < 2000; i++) if (world.tryEvade(hero)) dodged++;
  near("a Talisman of Evasion dodges ~15% of attacks", dodged / 2000, 0.15, 0.03);
  check("…and a hero with no talisman dodges nothing", world.tryEvade(unit({ isHero: true })), false);
}
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "nspi");
  check("a Necklace of Spell Immunity makes its wearer magic-immune", hero.magicImmune, true);
  const gem = give(unit({ isHero: true }), "gemt");
  check("…and a Gem of True Seeing gives its Rng1 of True Sight", gem.detectRadius, 1100);
}
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "penr");
  check("a Pendant of Energy raises the mana CEILING by DataA", hero.maxMana, 650);
  const bare = unit({ isHero: true });
  world.recomputeStats(bare);
  check("…and an empty inventory does not", bare.maxMana, 500);
}

console.log("\nthe two damage cuts, each on the pipe its own tooltip names");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "brac");
  check("Runed Bracers derive a 33% magic cut", hero.magicReduction, 0.33);
  hero.hp = 1000;
  world.spellApi.spellDamage(hero, 100, 0);
  near("…so 100 spell damage lands as 67", 1000 - hero.hp, 67, 1);
}
{
  world = newWorld();
  const hero = give(unit({ isHero: true, hp: 1000 }), "arsh");
  near("an Arcanite Shield lets 70% of a ranged attack through", hero.rangedReduction, 0.3, 1e-9);
  world.applyDamage(hero, 100, 0, 0, "", true);
  near("…a ranged 100 lands as 70", 1000 - hero.hp, 70, 1);
  hero.hp = 1000;
  world.applyDamage(hero, 100, 0, 0, "", false);
  near("…and a MELEE 100 lands in full", 1000 - hero.hp, 100, 1);
}

console.log("\nan item AURA reaches the army, not just its bearer");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "ward");
  const ally = unit({ x: 1500, y: 1000, prevX: 1500, prevY: 1000 });
  const far = unit({ x: 3000, y: 1000, prevX: 3000, prevY: 1000 });
  const enemy = unit({ x: 1100, y: 1000, prevX: 1100, prevY: 1000, owner: 1, team: 1 });
  world.applyAuras();
  const cmd = (u) => u.buffs.filter((b) => b.kind === "damagePct").length;
  check("Warsong Battle Drums buff the bearer (`self`)", cmd(hero), 1);
  check("…and an ally inside Area1 900", cmd(ally), 1);
  check("…but not one 2000 away", cmd(far), 0);
  check("…nor the enemy standing next to him", cmd(enemy), 0);
  near("…for DataA", ally.buffs[0].value, 0.1);
}

console.log("\nthe Amulet of Spell Shield eats one enemy spell, then grows back on Cool1");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "spsh");
  const enemy = unit({ owner: 1, team: 1, x: 1200, y: 1000, prevX: 1200, prevY: 1000 });
  world.tickCarriedItems(hero, 0.1);
  check("the amulet is wearing its shield", hero.buffs.filter((b) => b.kind === "spellShield").length, 1);
  check("an enemy's aimed spell is eaten", world.consumeSpellShield(enemy, hero.id), true);
  check("…and the shield is spent", hero.buffs.filter((b) => b.kind === "spellShield").length, 0);
  check("…the next one is not", world.consumeSpellShield(enemy, hero.id), false);
  world.tickCarriedItems(hero, 39);
  check("…still regrowing at 39s of its 40", hero.buffs.filter((b) => b.kind === "spellShield").length, 0);
  world.tickCarriedItems(hero, 1.1);
  world.tickCarriedItems(hero, 0.1);
  check("…and back at 40", hero.buffs.filter((b) => b.kind === "spellShield").length, 1);
  // A FRIEND's spell is not what the shield is for.
  const friend = unit({ x: 1200, y: 1000, prevX: 1200, prevY: 1000 });
  check("a friendly spell passes straight through it", world.consumeSpellShield(friend, hero.id), false);
  check("…leaving the shield up", hero.buffs.filter((b) => b.kind === "spellShield").length, 1);
}

console.log("\nthe Ankh of Reincarnation is spent, and the hero is standing where he fell");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, hp: 0 }), "ankh");
  hero.mana = 123;
  check("the Ankh brings him back", world.tryReincarnate(hero), true);
  near("…with DataB hit points", hero.hp, 500);
  near("…and the mana he had (DataC = -1)", hero.mana, 123);
  check("…and the item is gone", hero.inventory[0], null);
  hero.hp = 0;
  check("…so a second death is a death", world.tryReincarnate(hero), false);
}

console.log("\nthe Tome of Power is a level");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, isHeroUnit: true }), "tkno");
  check("the tome fires", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);
  check("…the hero is level 2", hero.level, 2);
  check("…with the skill point that comes with it", hero.skillPoints, 1);
}

console.log(failed ? `\nitems: ${failed} check(s) FAILED` : "\nitems: all checks passed");
process.exit(failed ? 1 : 0);
