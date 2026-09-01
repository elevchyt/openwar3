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
// The third part is WHOSE shop it is: a shop serves its owner, its owner's allies and — when
// nobody owns it — the whole map, and never an enemy (`canUseShop`). Every door is checked,
// because "you may not buy here" and "you may not be SHOWN what is here" are the same rule:
// the command card is built only for a shop you may trade at, so an enemy's shelf, its stock
// counts and its restock clocks stay off your screen.
//
// The second half is the copy's EXPERIENCE BAR, which is the original's. The OWNER sees the
// summon timer in its place; it is the ENEMY who gets the hero bar (the summon triple is
// masked on the wire), so a copy left at the spawn default reads 0 into its level on their
// panel while the real Blademaster reads three quarters full — the real one, named.
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
  // `[Aall]` "Shop Sharing, Allied Bldg." — DataA 600 radius, and the same three flags. This
  // is the ability the four RACE shops carry, and the reason an ally may use one.
  ["Aall", {
    id: "Aall", code: "Aall", isHero: false, isItem: false, levels: 1, reqLevel: 0, levelSkip: 0,
    target: "unit", targetFlags: [], autocast: false, name: "Shop Sharing", icon: "", hotkey: "",
    researchHotkey: "", buttonX: 0, buttonY: 0, learnX: 0, learnY: 0, research: false,
    tips: [], uberTips: [], researchTip: "", researchUberTip: "",
    missileArt: "", targetArt: "", targetAttach: [], casterArt: "", specialArt: "", effectArt: "",
    areaArt: "", fxArt: "", effectSound: "", buffFx: [], buffArt: "", buffEffectArt: "",
    buffSpecialArt: "", lightning: [], animNames: [], order: "", orderOn: "", orderOff: "",
    levelData: [lvl({ data: D(600, 1, 1, 1) })],
  }],
  // "Purchase Item" — what makes a building one you can PAWN to (canPawnAt).
  ["Apit", {
    id: "Apit", code: "Apit", isHero: false, isItem: false, levels: 0, reqLevel: 0, levelSkip: 0,
    target: "none", targetFlags: [], autocast: false, name: "Purchase Item", icon: "", hotkey: "",
    researchHotkey: "", buttonX: 0, buttonY: 0, learnX: 0, learnY: 0, research: false,
    tips: [], uberTips: [], researchTip: "", researchUberTip: "",
    missileArt: "", targetArt: "", targetAttach: [], casterArt: "", specialArt: "", effectArt: "",
    areaArt: "", fxArt: "", effectSound: "", buffFx: [], buffArt: "", buffEffectArt: "",
    buffSpecialArt: "", lightning: [], animNames: [], order: "", orderOn: "", orderOff: "",
    levelData: [],
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

const SHOP = "ngme"; // Goblin Merchant — Neutral Passive, serves everybody
const VAULT = "hvlt"; // Arcane Vault — a PLAYER's shop, and it carries Aall (shop sharing)
const UNIT_DEF = { priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 };
const N = 256;
// No upgradeReg on purpose: `this.tech` stays null, so `missingForShop` answers "nothing
// missing" and the neutral shelf is ungated — which is what a Goblin Merchant's is anyway.
const newWorld = () =>
  new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] },
    { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) },
    { get: (id) => (id === SHOP ? { ...UNIT_DEF, abilities: ["Aneu", "Apit"] }
      : id === VAULT ? { ...UNIT_DEF, abilities: ["Aall", "Apit"] } : UNIT_DEF), has: () => false },
    { get: (id) => (id === SHOP || id === VAULT ? { makeitems: [], sellitems: ["phea"], sellunits: [] } : undefined),
      has: (id) => id === SHOP || id === VAULT });

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
// An Arcane Vault belonging to player 1 — finished, so it is open for business.
const vault = (owner = 1) => unit({
  typeId: VAULT, owner, team: owner, x: 2000, y: 2000, prevX: 2000, prevY: 2000, radius: 72,
  building: { constructionLeft: 0, queue: [] },
});

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

console.log("\nA hero's image shares HIS experience bar — the one the ENEMY sees (docs/illusions.md)");
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


console.log("\nWHOSE shop it is: the owner's, an ally's, and nobody's — never an enemy's");
{
  world = newWorld();
  // Player 1's Arcane Vault. 0 and 1 are enemies until the matrix says otherwise; 2 is 1's ally.
  world.alliedPlayers = (a, b) => a === b || (a === 1 && b === 2) || (a === 2 && b === 1);
  const v = vault(1);
  world.stashOf(0).gold = 500;
  world.stashOf(2).gold = 500;
  // One hero of each player standing at the same counter, 200 units out (inside Aall's 600).
  const enemy = hero({ owner: 0, team: 0, x: 2200, y: 2000, prevX: 2200, prevY: 2000 });
  const ally = hero({ owner: 2, team: 2, x: 2150, y: 2000, prevX: 2150, prevY: 2000 });
  const mine = hero({ owner: 1, team: 1, x: 2100, y: 2000, prevX: 2100, prevY: 2000 });

  check("its owner may trade there", world.canUseShop(v.id, 1), true);
  check("…and so may their ally (Aall, shop sharing)", world.canUseShop(v.id, 2), true);
  check("…but the enemy may not", world.canUseShop(v.id, 0), false);
  // The command card is built ONLY for a shop you may use, so this is also the answer to
  // "does clicking it show me their shelf": it does not.
  check("the enemy is offered no patron for it", world.shopPatrons(v.id, 0).length, 0);
  check("…while the ally is", world.shopPatrons(v.id, 2).some((u) => u.id === ally.id), true);
  check("Select User refuses the enemy's hero", world.setShopBuyer(v.id, 0, enemy.id), false);
  check("…and takes the ally's", world.setShopBuyer(v.id, 2, ally.id), true);

  // The adoption pass is what plants the team-coloured arrow, and it was planting one over
  // the enemy hero standing at a counter that would never serve him.
  world.adoptShopBuyers();
  check("the enemy hero is adopted by nobody", world.shopBuyer(v.id, 0), null);
  check("…so wears no patron arrow", world.shopArrowUnits(0).has(enemy.id), false);
  check("the owner's hero is", world.shopBuyer(v.id, 1)?.id, mine.id);
  check("…and wears one", world.shopArrowUnits(1).has(mine.id), true);

  check("the purchase itself refuses the enemy", world.purchaseItem(v.id, enemy.id, "phea", 0), "no");
  check("…with nothing taken out of his stash", world.stashOf(0).gold, 500);
  check("…and the ally buys the potion", world.purchaseItem(v.id, ally.id, "phea", 2), "ok");
  check("…paying its 150 gold", world.stashOf(2).gold, 350);
  // Hiring and pawning go through the same rule.
  check("nobody hires out of an enemy's shop", world.purchaseUnit(v.id, "Hamg", 0), "no");
  enemy.inventory[0] = { id: 99, itemId: "phea", charges: 1, cooldownLeft: 0 };
  check("…nor sells into one", world.pawnItem(enemy.id, 0, v.id), false);
  check("…keeping the item he tried to sell", enemy.inventory[0]?.itemId, "phea");
}

console.log("\n…and an alliance REVOKED closes the shelf again on the same tick");
{
  world = newWorld();
  let allied = true;
  world.alliedPlayers = (a, b) => a === b || allied;
  const v = vault(1);
  const h = hero({ owner: 2, team: 2, x: 2200, y: 2000, prevX: 2200, prevY: 2000 });
  world.adoptShopBuyers();
  check("an ally's hero is the vault's buyer", world.shopBuyer(v.id, 2)?.id, h.id);
  allied = false; // SetPlayerAlliance(…, false)
  check("…and stops being one when the alliance ends", world.shopBuyer(v.id, 2), null);
  check("…arrow and all", world.shopArrowUnits(2).has(h.id), false);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
