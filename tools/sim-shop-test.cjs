// Headless check of the SHOP's "valid patron" rule — who may stand at the counter and take
// delivery of a purchase — and of the one unit that must never be offered the job: an
// ILLUSION (docs/illusions.md).
//
// A copy's six slots are a picture: inert items with `id: 0` it can neither use, drop, give
// nor fill. `pickUpItem` has always known that, but a PURCHASE does not go through it —
// `purchaseItem` writes straight into the buyer's inventory — so an image was a perfectly
// good shopper: the gold left the stash and the potion went into a body that cannot drink it
// and pops sixty seconds later. All five doors are checked here, because a shop that offers a
// buyer it will then refuse is the same bug twice.
//
// The second half is the copy's EXPERIENCE BAR, which is the original's: it is shown his bar
// (the panel's hero branch, not the summon timer), so a kill that moved the hero's bar and
// not his copies' would let an enemy read the real one off the four panels.
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
// `[Aneu]` "Select Hero": DataA 450 radius, DataB 1 interact, DataC 1 button, DataD 1 arrow
// (AbilityData.slk, column names from AbilityMetaData `Neu1..Neu4` — see shopInteract).
const ABILITIES = new Map([
  ["Aneu", {
    id: "Aneu", code: "Aneu", isHero: false, isItem: false, levels: 1, reqLevel: 0, levelSkip: 0,
    target: "unit", targetFlags: [], autocast: false, name: "Select Hero", icon: "", hotkey: "",
    researchHotkey: "", buttonX: 0, buttonY: 0, learnX: 0, learnY: 0, research: false,
    tips: [], uberTips: [], researchTip: "", researchUberTip: "",
    missileArt: "", targetArt: "", targetAttach: [], casterArt: "", specialArt: "", effectArt: "",
    areaArt: "", fxArt: "", effectSound: "", buffFx: [], buffArt: "", buffEffectArt: "",
    buffSpecialArt: "", lightning: [], animNames: [], order: "", orderOn: "", orderOff: "",
    levelData: [lvl({ data: D(450, 1, 1, 1) })],
  }],
]);

// A Potion of Healing on a Goblin Merchant's shelf: 150 gold, one charge.
const ITEMS = new Map([
  ["phea", {
    id: "phea", name: "Potion of Healing", description: "", icon: "", tip: "", hotkey: "",
    buttonX: -1, buttonY: -1, model: "", scale: 1, gold: 150, lumber: 0, level: 1,
    classType: "Purchasable", abilities: ["AIh1"], charges: 1, cooldownGroup: "phea",
    usable: true, perishable: true, powerup: false, droppable: true, sellable: true,
    pawnable: true, pickRandom: false, maxHp: 75, stockMax: 1, stockRegen: 120, stockStart: 0,
  }],
]);

const SHOP = "ngme"; // Goblin Merchant
const UNIT_DEF = { priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 };
const N = 256;
// No upgradeReg on purpose: `this.tech` stays null, so `missingForShop` answers "nothing
// missing" and the neutral shelf is ungated — which is what a Goblin Merchant's is anyway.
const newWorld = () =>
  new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] },
    { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) },
    { get: (id) => (id === SHOP ? { ...UNIT_DEF, abilities: ["Aneu"] } : UNIT_DEF), has: () => false },
    { get: (id) => (id === SHOP ? { makeitems: [], sellitems: ["phea"], sellunits: [] } : undefined), has: (id) => id === SHOP });

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
const hero = (over = {}) => unit({ isHero: true, inventory: [null, null, null, null, null, null], ...over });
const shop = () => unit({ typeId: SHOP, owner: -1, team: -1, neutralPassive: true, x: 2000, y: 2000, prevX: 2000, prevY: 2000, radius: 72 });

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}, got ${got}`}`);
}

console.log("\nAn ILLUSION is not a valid patron, at any of the five doors");
{
  world = newWorld();
  const s = shop();
  world.stashOf(0).gold = 500;
  // Both standing at the counter — 200 units out, well inside Aneu's DataA 450.
  const real = hero({ x: 2200, y: 2000, prevX: 2200, prevY: 2000 });
  const copy = hero({ x: 2150, y: 2000, prevX: 2150, prevY: 2000, isIllusion: true, isSummon: true, summonLeft: 60 });

  const patrons = world.shopPatrons(s.id, 0);
  check("the patron list offers the hero", patrons.some((u) => u.id === real.id), true);
  check("…and not his image standing beside him", patrons.some((u) => u.id === copy.id), false);
  check("Select User refuses the image", world.setShopBuyer(s.id, 0, copy.id), false);
  check("…and accepts the hero", world.setShopBuyer(s.id, 0, real.id), true);
  check("the purchase itself refuses the image", world.purchaseItem(s.id, copy.id, "phea", 0), "nopatron");
  check("…with nothing taken out of the stash", world.stashOf(0).gold, 500);
  check("…and nothing put into its six slots", copy.inventory.filter(Boolean).length, 0);
  check("…while the hero buys the potion", world.purchaseItem(s.id, real.id, "phea", 0), "ok");
  check("…and pays the 150 gold for it", world.stashOf(0).gold, 350);
}

console.log("\n…and the adoption pass never hands a shop one either");
{
  world = newWorld();
  const s = shop();
  const copy = hero({ x: 2150, y: 2000, prevX: 2150, prevY: 2000, isIllusion: true, isSummon: true, summonLeft: 60 });
  world.adoptShopBuyers();
  check("an image alone at the counter is adopted by nobody", world.shopBuyer(s.id, 0), null);
  check("…so no arrow is drawn over it", world.shopArrowUnits(0).has(copy.id), false);
  const real = hero({ x: 2200, y: 2000, prevX: 2200, prevY: 2000 });
  world.adoptShopBuyers();
  check("the hero who walks up behind it is", world.shopBuyer(s.id, 0)?.id, real.id);
}

console.log("\nA hero's image shares HIS experience bar (docs/illusions.md)");
{
  world = newWorld();
  const h = hero({ level: 4, xp: 1000 });
  const im = hero({ x: 1100, y: 1000, prevX: 1100, prevY: 1000 });
  world.initIllusion(im, h.id, {
    dealt: 0, taken: 2, properName: "Samuro", mana: 0, level: h.level, xp: h.xp,
    baseStr: 0, baseAgi: 0, baseInt: 0, baseMaxHp: 1000, inventory: [null, null, null, null, null, null],
  });
  check("the copy arrives on the hero's level", im.level, 4);
  check("…and at the same place in the bar under it", im.xp, 1000);
  // A kill that moves his bar moves theirs: an image earns nothing of its own, it is SHOWN his.
  world.gainXp(h, 60);
  check("a kill of his moves the copy's bar with his", im.xp, h.xp);
  // …across a threshold too, where the level and the bar have to land together.
  world.setHeroXp(h.id, 2600);
  check("…and so does a level crossed", im.xp, h.xp);
  check("…with the copy on the new level", im.level, h.level);
  // A DEAD image is not written to (it is already gone; only the pop is left to play).
  im.hp = 0;
  world.gainXp(h, 100);
  check("a popped image is left alone", im.xp, 2600);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
