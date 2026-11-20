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
  // An INVENTORY ability: "Item Capacity" is its DataA (AbilityMetaData inv1). The Pack Mule's.
  ["Apak", ability("Apak", "AInv", { isItem: false, levelData: [lvl({ data: D(4, 1, 1, 1, 1) })] })],
  // `[AIrb]` Rune of Rebirth — no data at all; its payload is which monster held the rune.
  ["AIrb", ability("AIrb", "AIrb")],
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
  ["AIms", ability("AIms", "AIms", { levelData: [lvl({ data: D(60) })] })], // Boots of Speed — DataA 60
  ["AIsr", ability("AIsr", "AIsr", { levelData: [lvl({ data: D(NaN, 0.33) })] })], // Runed Bracers
  ["AIdd", ability("AIdd", "AIdd", { levelData: [lvl({ data: D(0.7, 1) })] })], // Arcanite Shield
  ["AImx", ability("AImx", "Amim", { levelData: [lvl({ data: D(10) })] })], // Necklace of Spell Immunity
  ["Adt1", ability("Adt1", "Adet", { levelData: [lvl({ castRange: 1100, data: D(3) })] })], // Gem of True Seeing
  // Warsong Battle Drums — Command Aura, Area 900, DataA 0.1 ("Damage Bonus (%)")
  ["AIcd", ability("AIcd", "AOac", { targetFlags: ["air", "ground", "friend", "self", "vuln", "invu"], levelData: [lvl({ area: 900, data: D(0.1, 1, 1) })] })],
  // Amulet of Spell Shield — Cool 40, buff BNss
  ["ANss", ability("ANss", "ANss", {
    buffArt: "Abilities\\Spells\\Items\\SpellShieldAmulet\\SpellShieldCaster.mdl",
    buffFx: [{ path: "Abilities\\Spells\\Items\\SpellShieldAmulet\\SpellShieldCaster.mdl", attach: ["origin"] }],
    levelData: [lvl({ cooldown: 40, buffs: ["BNss"] })],
  })],
  // Ankh of Reincarnation — DataA 7 (delay), DataB 500 (life), DataC -1 (keep mana)
  // Reincarnation, the Tauren Chieftain's — Ore1 5 (delay), Cool1 240 — for the order the two take.
  ["AOre", ability("AOre", "AOre", { isItem: false, isHero: true, effectArt: "Abilities\\Spells\\Orc\\Reincarnation\\ReincarnationTarget.mdl", levelData: [lvl({ cooldown: 240, data: D(5) })] })],
  ["AIrc", ability("AIrc", "AIrc", { effectArt: "Abilities\\Spells\\Orc\\Reincarnation\\ReincarnationTarget.mdl", levelData: [lvl({ data: D(7, 500, -1) })] })],
  // Tome of Power — DataA 1 "Levels Gained"
  ["AIlm", ability("AIlm", "AIlm", { levelData: [lvl({ data: D(1) })] })],
  // Tome of Intelligence / Strength — DataA agi, DataB int, DataC str (the +2 tomes)
  ["AIim", ability("AIim", "AIim", { levelData: [lvl({ data: D(0, 2, 0) })] })],
  ["AIsm", ability("AIsm", "AIsm", { levelData: [lvl({ data: D(0, 0, 2) })] })],
  // Cloak of Flames — Dur 1, Area 160, DataA 10, and its buff row `[BIcf]` wears Immolation's
  // own `Targetart = Abilities\Spells\NightElf\Immolation\ImmolationTarget.mdl`.
  ["AIcf", ability("AIcf", "AIcf", { targetFlags: ["ground", "enemy", "neutral"],
    buffArt: "Abilities\\Spells\\NightElf\\Immolation\\ImmolationTarget.mdl",
    buffFx: [{ art: "Abilities\\Spells\\NightElf\\Immolation\\ImmolationTarget.mdl", attach: [] }],
    levelData: [lvl({ duration: 1, area: 160, data: D(10), buffs: ["BIcf"] })] })],
  // Dust of Appearance — Dur 20, Area 1000, buff Bdet; `targs1 = air,ground,ward,enemy,neutral,vuln,invu`
  ["AItb", ability("AItb", "AItb", { targetFlags: ["air", "ground", "ward", "enemy", "neutral", "vuln", "invu"],
    levelData: [lvl({ duration: 20, heroDuration: 20, area: 1000, data: D(3), buffs: ["Bdet"] })] })],
  // Goblin Land Mines — Rng1 100, Area1 200, UnitID1 nglm: "at a target point", planted at the feet
  ["AIpm", ability("AIpm", "AIpm", { target: "point", levelData: [lvl({ castRange: 100, area: 200, summon: "nglm" })] })],
  // Ivory Tower — `AIbt`, code AIbl: Rng1 100, Dur1 4 (the raise), UnitID1 hwtw for all four races
  ["AIbt", ability("AIbt", "AIbl", { target: "point", levelData: [lvl({ castRange: 100, duration: 4, summon: "hwtw,hwtw,hwtw,hwtw" })] })],
]);

const item = (id, abils, over = {}) => ({
  id, name: id, description: "", icon: "", tip: "", hotkey: "", buttonX: -1, buttonY: -1,
  model: "", scale: 1, gold: 0, lumber: 0, level: 0, classType: "Purchasable", abilities: abils,
  charges: 1, cooldownGroup: id, usable: true, perishable: true, powerup: false, droppable: true,
  sellable: true, pawnable: true, droppable: true, pickRandom: false, maxHp: 75, stockMax: 1, stockRegen: 120,
  stockStart: 0, ...over,
});
const passive = (id, abils) => item(id, abils, { charges: 0, usable: false, perishable: false, classType: "Permanent" });
const ITEMS = new Map([
  ["sreg", item("sreg", ["AIsl"])], ["hslv", item("hslv", ["AIrl"])], ["pclr", item("pclr", ["AIpr"])],
  ["phea", item("phea", ["AIh1"])], ["shea", item("shea", ["AIha"])], ["sres", item("sres", ["AIra"])],
  ["tkno", item("tkno", ["AIlm"])], ["tint", item("tint", ["AIim"])], ["tstr", item("tstr", ["AIsm"])],
  ["evtl", passive("evtl", ["AIev"])], ["penr", passive("penr", ["AImb"])], ["bspd", passive("bspd", ["AIms"])],
  ["brac", passive("brac", ["AIsr"])], ["arsh", passive("arsh", ["AIdd"])],
  ["nspi", passive("nspi", ["AImx"])], ["gemt", passive("gemt", ["Adt1"])],
  ["ward", passive("ward", ["AIcd"])], ["spsh", passive("spsh", ["ANss"])],
  ["clfm", passive("clfm", ["AIcf"])],
  ["ankh", item("ankh", ["AIrc"], { usable: false })],
  // The one item in the whole of ItemData.slk with `droppable` 0 — `soul`, "Soul"; pawnable
  // and sellable are 0 on it too. Its twin here, `ledg`, is Gerard's Lost Ledger, which the
  // TABLE ships as perfectly droppable and Human01's own trigger makes undroppable per item.
  ["soul", item("soul", [], { charges: 0, usable: false, perishable: false, classType: "Miscellaneous", droppable: false, pawnable: false, sellable: false })],
  ["ledg", passive("ledg", [])],
  // One of the five stock items with ItemData `drop` = 1, "Dropped When Carrier Dies" — the
  // human capture-the-flag flag (`flag`, `nflg`, `oflg`, `uflg`, `btst` are the whole list).
  ["flag", item("flag", [], { charges: 0, usable: false, perishable: false, classType: "Miscellaneous", dropOnDeath: true })],
  ["dust", item("dust", ["AItb"], { charges: 2 })],
  ["gobm", item("gobm", ["AIpm"], { charges: 3 })],
  ["tsct", item("tsct", ["AIbt"])],
  ["rreb", item("rreb", ["AIrb"], { powerup: true, classType: "PowerUp" })],
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
    baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0, str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0,
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

console.log("\na STUNNED or SLEEPING unit can do nothing with its items  (SimWorld.itemsLocked)");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, hp: 100 }), "phea");
  give(hero, "hslv", 1);
  hero.stunned = true; // what a Storm Bolt (or the Dreadlord's Sleep) leaves on recomputeStats
  check("stunned, the potion is refused", world.useItem(hero.id, 0, 0, hero.x, hero.y), false);
  check("…and the button says so silently, as a spell's does", world.itemReadyError(hero.id, 0), SimWorld.SILENT_REFUSAL);
  check("…the salve cannot be dropped", world.dropItem(hero.id, 1, hero.x + 10, hero.y), false);
  check("…nor the pockets rearranged", world.swapItems(hero.id, 0, 1), false);
  check("…and the controller's row reads the same lock", world.itemsLockedFor(hero.id), true);
  check("…with nothing spent", hero.inventory[0].charges, 1);
  hero.stunned = false;
  hero.asleep = true; // a creep asleep for the night
  check("asleep, the potion is refused too", world.useItem(hero.id, 0, 0, hero.x, hero.y), false);
  hero.asleep = false;
  check("awake and free, it fires", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);
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

// Issue #282. `Units\MiscGame.txt` MoveSpeedBonusesStack=0 on the melee tables, 1 on the
// two custom copies: whether a second pair of Boots of Speed (`bspd` → `AIms`, DataA 60) adds
// anything is the data set's answer.
console.log("\ntwo Boots of Speed are one pair's worth in melee  (MoveSpeedBonusesStack=0)");
{
  const { setMapDataSet } = require(join(REPO, ".sim-build", "src", "data", "edition.js"));
  world = newWorld();
  const one = give(unit({ isHero: true }), "bspd");
  check("one pair is +60", one.speed, 330);
  const two = give(give(unit({ isHero: true }), "bspd", 0), "bspd", 1);
  check("a second pair adds nothing", two.speed, 330);
  setMapDataSet("custom");
  world.recomputeStats(two);
  check("…but on a CUSTOM map they stack (the custom tables say 1)", two.speed, 390);
  setMapDataSet("melee");
  world.recomputeStats(two);
  check("…and back in melee it is +60 again", two.speed, 330);
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
  // Issue #177: the shield is WORN as its icon alone — SpellShieldCaster is the block's flash,
  // and worn as buff art it looped in front of the hero for as long as the shield was up.
  const shield = hero.buffs.find((b) => b.kind === "spellShield");
  check("…as its BNss icon, with no model worn", [shield.buffId, shield.art, shield.fx.length].join(), "BNss,,0");
  world.drainSpellEffects();
  check("an enemy's aimed spell is eaten", world.consumeSpellShield(enemy, hero.id), true);
  const flash = world.drainSpellEffects();
  check("…and the block flashes ONCE, on its own Stand, sound and all",
    flash.map((f) => [f.art.split("\\").pop(), f.anim, f.life, f.events].join()).join(";"), "SpellShieldCaster.mdl,stand,0,true");
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
  // A WAVE's sweep is a hit, not a cast at him: Shockwave, Carrion Swarm, an Impale clicked on
  // the ground run their handler once per body the front reaches (with that body as targetId)
  // and none of them may pop it. Spent through applySpellEffect, the door every spell takes.
  const swarm = ability("AUcs", "AUcs", { isItem: false });
  world.applySpellEffect("AUcs", 1, enemy, { targetId: hero.id, x: hero.x, y: hero.y, wave: { budget: 1e9 } }, swarm);
  check("a wave sweeping over him passes the shield by", hero.buffs.filter((b) => b.kind === "spellShield").length, 1);
  world.applySpellEffect("AUcs", 1, enemy, { targetId: hero.id, x: hero.x, y: hero.y }, swarm);
  check("…while the same spell aimed AT him is eaten", hero.buffs.filter((b) => b.kind === "spellShield").length, 0);
}

console.log("\nthe Cloak of Flames is WORN: its BIcf fire is on the carrier while it burns");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "clfm");
  const fire = () => hero.buffs.filter((b) => b.group === "cloakOfFlames");
  world.tickCarriedItems(hero, 0.1);
  check("the carrier wears the cloak's fire", fire().length, 1);
  check("…and it is the buff row's own model", fire()[0]?.fx?.[0]?.art, "Abilities\\Spells\\NightElf\\Immolation\\ImmolationTarget.mdl");
  world.tickCarriedItems(hero, 0.1);
  check("…once, however many ticks it burns", fire().length, 1);
  hero.immolation = "AEim";
  world.tickCarriedItems(hero, 0.1);
  check("lit Immolation takes over — the cloak's fire comes off", fire().length, 0);
  hero.immolation = "";
  world.tickCarriedItems(hero, 0.1);
  check("…and goes back on when Immolation is doused", fire().length, 1);
  hero.inventory = [];
  world.tickCarriedItems(hero, 0.1);
  check("dropping the cloak puts the fire out", fire().length, 0);
}

console.log("\nthe Ankh of Reincarnation is spent, and the hero gets up where he fell");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, hp: 0 }), "ankh");
  hero.mana = 123;
  check("the Ankh catches the death", world.tryReincarnate(hero), true);
  check("…and the item is gone", hero.inventory[0], null);
  // `AIrc` DataA "Delay After Death" = 7. He is DOWN for it: one hit point, untouchable and
  // unable to act, with ReincarnationTarget standing over him (see SimWorld.goDown).
  near("…he is down, not up", hero.hp, 1);
  check("…off the field while he is", hero.vanished, true);
  check("…and so untouchable", hero.invulnerable, true);
  check("…for DataA's 7 seconds", Math.round(hero.reviveT), 7);
  // Issue #179: he goes down the way a hero DIES — the body lies in its own Death pose
  // (REINCARNATION_BODY, drawn by rts.lieDown) — under ReincarnationTarget's grave, held for
  // the delay, which fires its own events so its Death (Reincarnation.wav) is heard at the rise.
  check("…his body lies where he fell", hero.buffs.map((b) => b.group).join(), "reincarnation");
  const grave = world.drainSpellEffects();
  check("…under the reincarnation's grave, held for the delay, sound and all",
    grave.map((f) => [f.art.split("\\").pop(), f.anim, Math.round(f.life), f.events, f.targetId === hero.id].join()).join(";"), "ReincarnationTarget.mdl,hold,7,true,true");
  world.tickRevive(hero, 6.9);
  near("…still down at 6.9s", hero.hp, 1);
  world.tickRevive(hero, 0.2);
  check("…the grave's own Death is the rise: no second effect", world.drainSpellEffects().length, 0);
  check("…the body marker gone with it", hero.buffs.length, 0);
  near("…and up at 7 with DataB hit points", hero.hp, 500);
  near("…and the mana he had (DataC = -1)", hero.mana, 123);
  check("…and back on the field", hero.vanished, false);
  hero.hp = 0;
  check("…so a second death is a death", world.tryReincarnate(hero), false);
}

console.log("\ntwo Ankhs are two deaths, one each");
{
  world = newWorld();
  const hero = give(give(unit({ isHero: true, hp: 0 }), "ankh", 0), "ankh", 3);
  check("the first death is caught", world.tryReincarnate(hero), true);
  check("…by ONE Ankh — the first in the pack", hero.inventory.map((h) => (h ? h.itemId : "-")).join(), "-,,,ankh");
  world.tickRevive(hero, 8);
  hero.hp = 0;
  check("the second death is caught by the other", world.tryReincarnate(hero), true);
  check("…which is spent in its turn", hero.inventory.filter(Boolean).length, 0);
  world.tickRevive(hero, 8);
  hero.hp = 0;
  check("…and the third is a death", world.tryReincarnate(hero), false);
}

console.log("\nthe ABILITY goes before the Ankh  (Liquipedia, Tauren Chieftain)");
{
  world = newWorld();
  const chief = give(unit({ isHero: true, hp: 0, abilities: [{ id: "AOre", code: "AOre", level: 1, cooldownLeft: 0, autocastOn: false }] }), "ankh");
  check("a Tauren Chieftain wearing an Ankh is caught", world.tryReincarnate(chief), true);
  check("…by his ultimate, which goes on its 240 cooldown", Math.round(chief.abilities[0].cooldownLeft), 240);
  check("…keeping the Ankh", chief.inventory[0]?.itemId, "ankh");
  check("…and down for the ultimate's own Ore1, 5 seconds", Math.round(chief.reviveT), 5);
  world.tickRevive(chief, 6);
  chief.hp = 0;
  check("killed again while it cools, the Ankh catches him", world.tryReincarnate(chief), true);
  check("…and is spent", chief.inventory[0], null);
  check("…for its own DataA, 7 seconds", Math.round(chief.reviveT), 7);
}

console.log("\nthe Tome of Power is a level");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, isHeroUnit: true }), "tkno");
  check("the tome fires", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);
  check("…the hero is level 2", hero.level, 2);
  check("…with the skill point that comes with it", hero.skillPoints, 1);
}

console.log("\na tome's attribute points confer what attribute points confer  (recomputeStats' startInt)");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, baseInt: 17, startInt: 17, int: 17, mana: 250 }), "tint");
  check("the Tome of Intelligence fires", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);
  check("…the hero has two more Intelligence", hero.int, 19);
  check("…and 15 mana ceiling for each of them", hero.maxMana, 530);
  const brute = give(unit({ isHero: true, baseStr: 22, startStr: 22, str: 22 }), "tstr");
  check("a Tome of Strength fires", world.useItem(brute.id, 0, 0, brute.x, brute.y), true);
  check("…and 25 hit points ceiling for each point", brute.maxHp, 1050);
}

console.log("\na HEXED hero uses nothing and picks up nothing — a critter has no hands");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "phea");
  hero.hp = 100; // hurt, so a Potion of Healing has something to do
  check("un-hexed, the potion is drunk", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);

  world = newWorld();
  const hexed = give(unit({ isHero: true }), "phea");
  hexed.hp = 100;
  world.spellApi.applyBuff(hexed, { kind: "hex", group: "hex", timeLeft: 15, sourceId: hexed.id });
  world.recomputeStats(hexed);
  check("…hexed, it is a critter", hexed.hexed, true);
  check("…and the same potion does nothing", world.useItem(hexed.id, 0, 0, hexed.x, hexed.y), false);
  check("…with the charge still on it", hexed.inventory[0] && hexed.inventory[0].charges, 1);
  // The PICK-UP is a door of its own, and the one an order never reaches: a hero hexed
  // mid-walk is already standing on the rune, and a tome taken this way would be gone for good.
  const ground = { id: nextId++, itemId: "tkno", x: hexed.x, y: hexed.y, charges: 1 };
  world.items.set(ground.id, ground);
  check("…and nothing is picked up off the ground", world.pickUpItem(hexed, ground), false);
  check("…the item is still lying there", world.items.has(ground.id), true);
}

// --- UNDROPPABLE -----------------------------------------------------------------------
//
// `UI\TriggerStrings.txt`, beside the GUI action that sets it:
//   SetItemDroppableBJHint="An undroppable item cannot be removed from a Hero's inventory
//                           once it has been picked up."
// So it is not only the drop button — a hand-over and a sale are removals too. Two sources
// for the flag and both are tested: the TYPE's own `droppable` column (`soul` is the one
// stock item with it clear) and the per-ITEM override a script sets (`SetItemDroppable`,
// which is how Human01's Ledger becomes undroppable the moment Arthas picks it up).
console.log("\nan undroppable item cannot leave the inventory");
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "ledg");
  const id = hero.inventory[0].id;
  check("an ordinary item drops", world.dropItem(hero.id, 0, hero.x + 10, hero.y), true);
  check("…and is on the ground", world.items.has(id), true);

  world = newWorld();
  const keeper = give(unit({ isHero: true }), "ledg");
  const ledger = keeper.inventory[0].id;
  check("SetItemDroppable finds a HELD item", world.setItemDroppable(ledger, false), true);
  check("…and the drop is refused", world.dropItem(keeper.id, 0, keeper.x + 10, keeper.y), false);
  check("…with the item still in the slot", keeper.inventory[0] !== null, true);
  check("…and nothing on the ground", world.items.has(ledger), false);
  // A far-away drop point takes the walk-and-drop road instead; it must refuse at the ORDER,
  // so the hero does not walk across the map to fail on arrival.
  check("…a drop out of reach is refused too", world.dropItem(keeper.id, 0, keeper.x + 2000, keeper.y), false);
  check("…and no walk was started", keeper.order, "idle");
  // The other two doors out of an inventory.
  const mate = unit({ isHero: true, x: keeper.x + 40 });
  world.transferItem(keeper, 0, mate);
  check("…it cannot be handed to another hero", mate.inventory.some((h) => h && h.id === ledger), false);
  check("…and the giver still has it", keeper.inventory[0] && keeper.inventory[0].id, ledger);
  // …and the HUD has a line to say for all three (issue #299): [Errors] Cantdrop.
  check("…and the refusal is the game's `Cantdrop`", world.itemLeaveError(keeper.id, 0), "Cantdrop");
  check("SetItemDroppable(true) gives it back", world.setItemDroppable(ledger, true), true);
  check("…and the line goes with it", world.itemLeaveError(keeper.id, 0), null);
  check("…and now it drops", world.dropItem(keeper.id, 0, keeper.x + 10, keeper.y), true);
}
{
  // No script involved: the TYPE's own column is the default.
  world = newWorld();
  const hero = give(unit({ isHero: true }), "soul");
  check("a type with `droppable` 0 refuses with no script at all", world.dropItem(hero.id, 0, hero.x + 10, hero.y), false);
  check("…and a script can still free it", world.setItemDroppable(hero.inventory[0].id, true)
    && world.dropItem(hero.id, 0, hero.x + 10, hero.y), true);
}
{
  // A non-hero inventory holder scatters what it carries when it dies — but not this.
  world = newWorld();
  const cart = give(unit({ isHero: false, hp: 1 }), "ledg");
  const ledger = cart.inventory[0].id;
  world.setItemDroppable(ledger, false);
  world.dropInventory(cart);
  check("a dead carrier does not scatter it either", world.items.has(ledger), false);
  check("…it goes down with the body", cart.inventory[0] && cart.inventory[0].id, ledger);
}

console.log("\na dying hero drops only what is marked Dropped When Carrier Dies (issue #231)");
{
  world = newWorld();
  const hero = give(give(unit({ isHero: true }), "ledg"), "flag", 1);
  const ledger = hero.inventory[0].id, flag = hero.inventory[1].id;
  world.dropInventory(hero);
  check("the flag falls out of the dead hero", world.items.has(flag), true);
  check("…its slot is empty", hero.inventory[1], null);
  check("an ordinary item rides with him", hero.inventory[0] && hero.inventory[0].id, ledger);
  check("…and is not on the ground", world.items.has(ledger), false);
}
{
  // SetItemDropOnDeath is per ITEM and beats the type's column both ways.
  world = newWorld();
  const hero = give(give(unit({ isHero: true }), "ledg"), "flag", 1);
  const ledger = hero.inventory[0].id, flag = hero.inventory[1].id;
  check("SetItemDropOnDeath finds a HELD item", world.setItemDropOnDeath(ledger, true), true);
  world.setItemDropOnDeath(flag, false);
  world.dropInventory(hero);
  check("…a ledger made to drop falls", world.items.has(ledger), true);
  check("…a flag told not to stays", hero.inventory[1] && hero.inventory[1].id, flag);
}
{
  // An undroppable item still goes down with the body (SetItemDroppableBJHint).
  world = newWorld();
  const hero = give(unit({ isHero: true }), "flag");
  const flag = hero.inventory[0].id;
  world.setItemDroppable(flag, false);
  world.dropInventory(hero);
  check("an undroppable flag stays in the dead hero's inventory", hero.inventory[0] && hero.inventory[0].id, flag);
}
{
  // An illusion's inventory is a picture of the original's — a dying copy drops nothing.
  world = newWorld();
  const copy = give(unit({ isHero: true, isIllusion: true }), "flag");
  const flag = copy.inventory[0].id;
  world.dropInventory(copy);
  check("a dying illusion drops no flag", world.items.has(flag), false);
}
{
  // A non-hero carrier still scatters everything, marked or not.
  world = newWorld();
  const cart = give(give(unit({ isHero: false }), "ledg"), "flag", 1);
  const ids = cart.inventory.filter(Boolean).map((h) => h.id);
  world.dropInventory(cart);
  check("a non-hero drops both", ids.every((id) => world.items.has(id)), true);
}

console.log("\nan inventory is an ABILITY, sized by its Item Capacity");
{
  const mule = unit();
  check("a unit with no inventory ability has no slots", mule.inventory.length, 0);
  world.addAbility(mule.id, "Apak");
  check("UnitAddAbility of an AInv-coded ability opens its DataA slots (the Pack Mule's four)", mule.inventory.length, 4);
}
{
  // …and a GATED one: every stock Footman lists `Aihn` ([Aihn] Requires=Rhpm), so it has no
  // inventory until the Backpack research is in — and gets its two slots the tick it is.
  world = newWorld();
  const researched = new Set();
  world.techMeets = (_player, id) => id !== "Apak" || researched.has("Ropm");
  const grunt = unit({ backpacks: [{ id: "Apak", slots: 2 }] });
  world.recomputeStats(grunt);
  check("a unit whose inventory ability's Requires is unmet has no slots", grunt.inventory.length, 0);
  researched.add("Ropm");
  world.recomputeStats(grunt);
  check("…the research opens them", grunt.inventory.length, 2);
}

console.log("\nDust of Appearance is NOT a provocation  (issue #184)");
{
  // A camp of Nightcrawlers HIDING at night (`Ashm`'s meld) beside a dusting hero: the powder
  // marks them for the duster's side, and that is all it does — no camp wakes, nobody charges.
  world = newWorld();
  const hero = give(unit({ isHero: true }), "dust");
  const meld = () => ({ kind: "invisible", group: "meld", meld: true, timeLeft: 999, delay: 0, value: 0, sourceId: 0 });
  const crawler = unit({ owner: -1, team: -1, x: 1300, y: 1000, prevX: 1300, prevY: 1000, isCreep: true,
    guardX: 1300, guardY: 1000, aggroRange: 200, buffs: [meld()], weapons: [], struckAt: -1, asleep: false });
  const sleeper = unit({ owner: -1, team: -1, x: 1350, y: 1050, prevX: 1350, prevY: 1050, isCreep: true,
    guardX: 1350, guardY: 1050, aggroRange: 200, weapons: [], struckAt: -1, asleep: true });
  world.recomputeStats(crawler);
  check("the hidden creep is invisible to begin with", crawler.invisible, true);
  check("the dust fires", world.useItem(hero.id, 0, 0, hero.x, hero.y), true);
  check("…it marks the hidden creep", crawler.buffs.some((b) => b.kind === "dusted"), true);
  check("…which keeps its meld (the powder SHOWS it; it does not pull it out)", crawler.cloaked, true);
  check("…and was not struck", crawler.struckAt, -1);
  check("…and its sleeping camp-mate sleeps on", sleeper.asleep, true);
}

console.log("\na POINT-aimed item walks into its own Rng1 first  (issue #185)");
{
  // Goblin Land Mines' `Rng1` is 100: the mine goes in at the hero's feet. Clicked 1500 units
  // away, he walks there and plants it on arrival — he does not fling it across the map.
  world = newWorld();
  // A unit the world itself built (`add`), since this one has to WALK through real ticks.
  const hero = world.add({
    id: nextId++, owner: 0, team: 0, race: "human", typeId: "Hpal", x: 1000, y: 1000, facing: 0,
    speed: 270, turnRate: 0.5, radius: 16, flying: false, flyHeight: 0, sightDay: 1400, sightNight: 800,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, armor: 0, armorType: "hero", weapons: [], oldWeapons: [],
    castPoint: 0, castBackswing: 0, targetedAs: "ground", moveType: "foot", worker: null, depotGold: false, depotLumber: false,
  }, null, {});
  give(hero, "gobm");
  check("a far click is accepted as an order", world.useItem(hero.id, 0, 0, 2500, 1000), true);
  check("…which is a walk, not a mine", hero.order, "getitem");
  check("…with no charge spent yet", hero.inventory[0].charges, 3);
  for (let i = 0; i < 20 * 10 && hero.pendingUse; i++) world.tick(0.05);
  check("he arrives and the walk is over", hero.pendingUse, null);
  check("…standing within Rng1 of the spot", Math.hypot(hero.x - 2500, hero.y - 1000) <= 100 + hero.radius, true);
  check("…and the mine went in there, a charge spent", hero.inventory[0].charges, 2);
}

console.log("\na Tiny building is BUILT, the worker's way  (issue #190)");
{
  // The Ivory Tower: the hero takes a worker's `buildPending`, walks to the site, pays with the
  // item's charge only when the foundation goes in, and the tower raises ITSELF over Dur1.
  world = new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] },
    { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) },
    { get: () => ({ priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 }), has: (id) => id === "hwtw" });
  const hero = world.add({
    id: nextId++, owner: 0, team: 0, race: "human", typeId: "Hpal", x: 1000, y: 1000, facing: 0,
    speed: 270, turnRate: 0.5, radius: 16, flying: false, flyHeight: 0, sightDay: 1400, sightNight: 800,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, armor: 0, armorType: "hero", weapons: [], oldWeapons: [],
    castPoint: 0, castBackswing: 0, targetedAs: "ground", moveType: "foot", worker: null, depotGold: false, depotLumber: false,
  }, null, {});
  give(hero, "tsct");
  check("the HUD is told which structure to put on the cursor", world.itemBuildTypeId(hero.id, 0), "hwtw");
  check("used at a spot, the item is accepted as an order", world.useItem(hero.id, 0, 0, 2000, 1000), true);
  check("…which is a build order, a worker's", hero.buildPending?.defId, "hwtw");
  check("…raised over the row's Dur1, not the unit's build time", hero.buildPending?.item?.buildTime, 4);
  check("…with the charge still in the pocket while he walks", hero.inventory[0]?.charges, 1);
  check("at the site the item pays for it", world.payPendingBuild(hero.id), true);
  check("…the charge is spent (and the item, being perishable, gone)", hero.inventory[0], null);
  const tower = unit({ owner: 0, team: 0, typeId: "hwtw", x: hero.x + 40, y: hero.y, prevX: hero.x + 40, prevY: hero.y,
    building: { constructionLeft: 4, buildTimeTotal: 4, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: 0, rallyY: 0, rallyKind: "point" } });
  world.assignBuilder(hero.id, tower.id);
  check("the foundation raises itself", tower.building.selfBuilds, true);
  check("…and the hero is let go at once", [hero.buildPending, hero.constructing, tower.building.builderIds.length].join(","), ",0,0");
}

console.log("\nRune of Rebirth (`rreb` → `AIrb`) — the monster that held it comes back as yours");
{
  // "Places the monster that held this rune under your control." The rune is a creep drop; it
  // remembers the body it fell off (here through the map script's path — CreateItem at the
  // dying unit's feet a moment after the death), and the picker gets that monster back.
  world = newWorld();
  // Both through add(), so every runtime field a death walks over is there.
  const spawn = (id, over) => world.add({
    id, owner: 0, team: 0, typeId: "hfoo", x: 1000, y: 1000, facing: 0,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0, speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0, sightDay: 1000, sightNight: 1000, flying: false, mechanical: false,
    invulnerable: false, race: "human", isBuilding: false, foodCost: 0, goldCost: 0, lumberCost: 0, upgrades: [],
    moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground", deathTime: 2, name: "x",
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0, weapons: [], oldWeapons: [],
    ...over,
  });
  const hero = spawn(901, { isHero: true });
  hero.inventory = [null, null, null, null, null, null];
  const creep = spawn(902, { owner: 12, team: 12, typeId: "nogr", x: 1300, facing: 1 });
  world.killUnit(creep.id);
  world.drainSummonRequests();
  for (let i = 0; i < 20; i++) world.tick(1 / 60); // the drop trigger runs a beat after the death
  const rune = world.createItem("rreb", 1300, 1000);
  const stray = world.createItem("rreb", 3000, 3000); // nobody died here
  hero.x = 1300; hero.y = 1040;
  world.unitAddItem(hero.id, rune);
  const reqs = world.drainSummonRequests();
  check("the rune brings ONE monster back", reqs.length, 1);
  check("…the one that held it", reqs[0] && reqs[0].unitId, "nogr");
  check("…as the picker's own", reqs[0] && reqs[0].owner, 0);
  check("…standing where it fell", !!reqs[0] && Math.hypot(reqs[0].x - 1300, reqs[0].y - 1000) < 32, true);
  check("…and a permanent unit, not a summon", reqs[0] && `${reqs[0].summonLeft},${!!reqs[0].summoned}`, "0,false");
  check("…and its corpse is what got up", [...world.corpses.values()].some((c) => c.deadId === creep.id && !c.raised), false);
  check("the rune is consumed", world.items.has(rune), false);
  hero.x = 3000; hero.y = 3000;
  world.unitAddItem(hero.id, stray);
  check("a rune no monster held brings nobody", world.drainSummonRequests().length, 0);
}

console.log("\na restore with nothing to restore says why, and keeps its charge (issue #299)");
{
  world = newWorld();
  const hero = give(unit({ isHero: true, hp: 1000, mana: 100 }), "phea");
  check("a Potion of Healing at full life: `HPmaxed`", world.itemUseError(hero.id, 0, 0), "HPmaxed");
  check("…and the press is not spent", world.useItem(hero.id, 0, 0, hero.x, hero.y) || hero.inventory[0].charges, ITEMS.get("phea").charges);
  hero.hp = 400;
  check("hurt, it is legal again", world.itemUseError(hero.id, 0, 0), null);
  const mule = give(unit({ isHero: false, hp: 1000 }), "phea");
  check("a non-hero carrier reads `UnitHPmaxed`", world.itemUseError(mule.id, 0, 0), "UnitHPmaxed");

  world = newWorld();
  const whole = give(unit({ isHero: true, hp: 1000, mana: 500 }), "sres");
  check("a Scroll of Restoration, everyone whole: `HPmanamaxed`", world.itemUseError(whole.id, 0, 0), "HPmanamaxed");
  const hurt = unit({ x: whole.x + 100, hp: 10 });
  check("…one hurt Footman in the circle makes it legal", world.itemUseError(whole.id, 0, 0), null);
  hurt.hp = hurt.maxHp;
  whole.mana = 10;
  check("…and so does the hero's own empty mana bar", world.itemUseError(whole.id, 0, 0), null);
}

// --- handing an item to a FRIENDLY hero (SimWorld.issueGiveItem / transferItem) ------------
// An item dropped on an ALLY's hero goes into the ally's inventory, as it does for one of your
// own; with no room there it is set down at the ally's feet. An enemy is never handed one.
console.log("\nhanding an item to another hero");
{
  world = newWorld();
  const giver = give(unit({ isHero: true, inventory: [null, null] }), "phea");
  const ally = unit({ owner: 1, team: 0, isHero: true, x: giver.x + 60, inventory: [null, null] });
  check("an ally's hero is handed the item", world.issueGiveItem(giver.id, 0, ally.id), true);
  check("…it is in the ally's inventory", ally.inventory[0]?.itemId, "phea");
  check("…and out of the giver's", giver.inventory[0], null);

  give(giver, "phea");
  ally.inventory = [{ id: nextId++, itemId: "sreg", charges: 1, cooldownLeft: 0 }, { id: nextId++, itemId: "sreg", charges: 1, cooldownLeft: 0 }];
  check("a FULL ally is still handed it", world.issueGiveItem(giver.id, 0, ally.id), true);
  const onGround = [...world.items.values()].find((it) => it.itemId === "phea");
  check("…and it lands on the ground", !!onGround, true);
  check(`…at the ally's feet (${onGround && Math.round(Math.hypot(onGround.x - ally.x, onGround.y - ally.y))} away)`, onGround && Math.hypot(onGround.x - ally.x, onGround.y - ally.y) <= 32, true); // snapped to the item grid (snapItemPos)
  check("…not in the giver's pack", giver.inventory[0], null);

  give(giver, "phea");
  const enemy = unit({ owner: 2, team: 1, isHero: true, x: giver.x - 60, inventory: [null, null] });
  check("an enemy hero is refused", world.issueGiveItem(giver.id, 0, enemy.id), false);
  check("…and the giver keeps it", giver.inventory[0]?.itemId, "phea");
}

console.log("\nputting Immolation OUT is the free half of a toggle, not a cast  (castImmediate)");
{
  world = newWorld();
  const im = ability("AEim", "AEim", { isItem: false, isHero: true, levelData: [lvl({ cost: 25, data: D(10, 7, 10) })] });
  ABILITIES.set("AEim", im);
  const hero = unit({ isHero: true, mana: 200, abilities: [{ id: "AEim", code: "AEim", level: 1, cooldownLeft: 0 }] });
  const meld = () => hero.buffs.filter((b) => b.kind === "invisible").length;
  world.castImmediate(hero, hero.abilities[0], im, im.levelData[0]);
  check("lit", hero.immolation, "AEim");
  hero.buffs.push({ kind: "invisible", group: "meld", timeLeft: Infinity, sourceId: hero.id, delay: 0, meld: true });
  world.recomputeStats(hero);
  world.castImmediate(hero, hero.abilities[0], im, im.levelData[0]);
  check("…doused", hero.immolation, "");
  check("…and the Cloak of Shadows' meld is still on him", meld(), 1);
  world.castImmediate(hero, hero.abilities[0], im, im.levelData[0]);
  check("lighting it again IS a cast, and gives him away", meld(), 0);
  ABILITIES.delete("AEim");
}

console.log("\nthree items made on one spot (a creep's drop table) come to rest apart  (freeItemSpot)");
{
  const ids = [0, 1, 2].map(() => world.createItem("phea", 1000, 1000));
  const spots = ids.map((id) => world.items.get(id));
  check("all three are on the ground", spots.every(Boolean), true);
  let closest = Infinity;
  for (let i = 0; i < spots.length; i++)
    for (let j = i + 1; j < spots.length; j++) closest = Math.min(closest, Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y));
  check(`…no two closer than 48 (${Math.round(closest)})`, closest >= 48, true);
  check("…and none far from where they were made", spots.every((it) => Math.hypot(it.x - 1000, it.y - 1000) <= 4 * 32 * Math.SQRT2), true);
  world.setItemPosition(ids[1], spots[0].x, spots[0].y);
  check("SetItemPosition still places an item EXACTLY, on top of another or not", [world.items.get(ids[1]).x, world.items.get(ids[1]).y].join(), [spots[0].x, spots[0].y].join());
  for (const id of ids) world.removeItemById(id);
}

console.log(failed ? `\nitems: ${failed} check(s) FAILED` : "\nitems: all checks passed");
process.exit(failed ? 1 : 0);
