// Headless check of ITEM COOLDOWN GROUPS — `ItemData.slk`'s `cooldownID`, the field that
// decides WHICH items a press puts on cooldown, and `ignoreCD`, the one that says a press
// costs no cooldown at all.
//
// The rules under test, and where each comes from:
//
//   • Every item naming the same group shares one clock: "all items in Cooldown Group X will
//     go on cooldown when you use ANY item from that group" (hiveworkshop 323800).
//   • The DURATION is the pressed ability's own `Cool1`, never the group's — the group is only
//     a name, and four of the ones the stock items use (`AIhe`, `AIma`, `AIrg`, `Aami`) match
//     no ability row at all. ("the cooldown is getting from the spell's cooldown" —
//     hiveworkshop 201233.)
//   • The clock belongs to the HERO, so it outlives the bottle: a fresh potion picked up or
//     bought while it runs arrives on cooldown, and one handed to ANOTHER hero does not.
//   • `ignoreCD`: "Even though the ability has a cooldown, it will be set to 0 when this is
//     True" (hiveworkshop 98895, All About Items).
//
// The groups and cooldowns below are the install's own 1.30.4 values, quoted per row from
// `Units\ItemData.slk` + `Units\AbilityData.slk`.
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

const ABILITIES = new Map([
  // [AIh1] Potion of Healing        Cool1 20, DataA 250
  ["AIh1", ability("AIh1", "AIhe", { levelData: [lvl({ cooldown: 20, data: D(250) })] })],
  // [AIh2] Potion of Greater Healing Cool1 40, DataA 500 — a DIFFERENT cooldown, same group
  ["AIh2", ability("AIh2", "AIhe", { levelData: [lvl({ cooldown: 40, data: D(500) })] })],
  // [AIvu] Potion of Invulnerability Cool1 45, Dur1 15, BuffID1 Bvul
  ["AIvu", ability("AIvu", "AIvu", { levelData: [lvl({ cooldown: 45, duration: 15, heroDuration: 15, buffs: ["Bvul"] })] })],
  // [AIvl] Potion of LESSER Invulnerability — the same `code = AIvu`, Dur1 7, Cool1 45
  ["AIvl", ability("AIvl", "AIvu", { levelData: [lvl({ cooldown: 45, duration: 7, heroDuration: 7, buffs: ["Bvul"] })] })],
  // [AIdv] Potion of Divinity — `code = AHds` (Divine Shield), Cool1 60, Dur1 25, BuffID1 BHds
  ["AIdv", ability("AIdv", "AHds", { levelData: [lvl({ cooldown: 60, duration: 25, heroDuration: 25, buffs: ["BHds"] })] })],
  // [AIdi] Wand of Negation — Cool1 0 in the install, given one here so `ignoreCD` has
  // something to cancel (the stock wand is the only item that sets the flag, and its own
  // ability's cooldown is already 0, which is why nothing in melee turns on it).
  ["AIdi", ability("AIdi", "AIdi", { levelData: [lvl({ cooldown: 30 })] })],
]);

const item = (id, abils, group, over = {}) => ({
  id, name: id, description: "", icon: "", tip: "", hotkey: "", buttonX: -1, buttonY: -1,
  model: "", scale: 1, gold: 0, lumber: 0, level: 0, classType: "Purchasable", abilities: abils,
  charges: 1, cooldownGroup: group, ignoreCooldown: false, usable: true, perishable: true,
  powerup: false, droppable: true, sellable: true, pawnable: true, pickRandom: false,
  maxHp: 75, stockMax: 1, stockRegen: 120, stockStart: 0, ...over,
});
const ITEMS = new Map([
  // ItemData.slk `cooldownID`, verbatim:
  ["phea", item("phea", ["AIh1"], "AIhe")], // Potion of Healing
  // …and a two-charge stand-in for it, so the bottle survives its own press: the stock potion
  // perishes with its single charge and takes its row (and that row's cooldown) with it.
  ["phe2", item("phe2", ["AIh1"], "AIhe", { charges: 2, perishable: false })],
  ["pghe", item("pghe", ["AIh2"], "AIhe")], // Potion of Greater Healing — same group
  ["pnvu", item("pnvu", ["AIvu"], "AIvu")], // Potion of Invulnerability
  ["pnvl", item("pnvl", ["AIvl"], "AIvu")], // …and the Lesser one, in ITS group
  ["pdiv", item("pdiv", ["AIdv"], "AHds")], // Potion of Divinity — a group of its own
  ["wneg", item("wneg", ["AIdi"], "AIdi", { charges: 3, ignoreCooldown: true })],
]);

const N = 256;
const world = new SimWorld(
  new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
  { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] },
  { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) },
  { get: () => ({ priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 }), has: () => false });

let nextId = 1;
function hero(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "Hpal", x: 1000, y: 1000, prevX: 1000, prevY: 1000,
    hp: 500, maxHp: 1000, mana: 300, maxMana: 500, buffs: [], weapons: [], abilities: [],
    inventory: [null, null, null, null, null, null],
    isHero: true, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "human", level: 1, xp: 0,
    skillPoints: 0, hpRegen: 0, manaRegen: 0, baseMaxHp: 1000, baseMaxMana: 500, baseHpRegen: 0,
    baseManaRegen: 0, baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, radius: 16, footprint: 0,
    order: "idle", targetId: null, path: [], waypoint: 0, moving: false, facing: 0,
    pendingCast: null, followLeaderId: null, inCombat: false, working: false, atNode: false,
    noCollision: false, stallT: 0, waitT: 0, gaveUp: false, acquireT: 0, arrowShot: null,
    constructing: 0, cooldownLeft: 0, linkT: 0, linkGroup: [], repathT: 0, stunned: false,
    baseStr: 0, baseAgi: 0, baseInt: 0, str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0,
    intPerLevel: 0, primaryAttr: 0, magicImmune: false, detectRadius: 0, summonLeft: 0,
    immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false, garrison: [], orderQueue: [], buildPending: null,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const give = (u, itemId, slot = 0) => {
  u.inventory[slot] = { id: nextId++, itemId, charges: ITEMS.get(itemId).charges, cooldownLeft: 0 };
  return u.inventory[slot];
};
const cd = (u, slot) => Math.round((u.inventory[slot]?.cooldownLeft ?? 0) * 100) / 100;

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}, got ${got}`}`);
}

console.log("a press puts EVERY item of its group on cooldown  (cooldownID)");
{
  const u = hero();
  give(u, "phe2", 0);
  give(u, "pghe", 1);
  give(u, "pdiv", 2);
  u.hp = 100; // so the potion is not refused at full health
  check("the potion fires", world.useItem(u.id, 0, 0, u.x, u.y), true);
  check("…the drinker's own row is on ITS ability's 20 s", cd(u, 0), 20);
  check("…and the Greater one beside it takes the SAME 20", cd(u, 1), 20);
  check("…not the 40 of its own ability, which was never pressed", cd(u, 1) === 40, false);
  check("…while an item in another group is untouched", cd(u, 2), 0);
}

console.log("\nthe two invulnerability potions are one group; Divinity is not  (Liquipedia)");
{
  const u = hero();
  give(u, "pnvl", 0); // Potion of Lesser Invulnerability, cooldownID AIvu
  give(u, "pnvu", 1); // Potion of Invulnerability,        cooldownID AIvu
  give(u, "pdiv", 2); // Potion of Divinity,               cooldownID AHds
  check("the Lesser potion fires", world.useItem(u.id, 0, 0, u.x, u.y), true);
  check("…and it makes the drinker invulnerable", u.buffs.some((b) => b.kind === "invuln"), true);
  check("…for the LESSER duration (Dur1 7, not 15)", u.buffs.find((b) => b.kind === "invuln").timeLeft, 7);
  check("…wearing Bvul's own art", u.buffs.find((b) => b.kind === "invuln").buffId, "Bvul");
  check("…the greater potion goes with it", cd(u, 1), 45);
  check("…and the Potion of Divinity does NOT", cd(u, 2), 0);
}

console.log("\nthe clock is the HERO's, so it outlives the bottle");
{
  const u = hero();
  const held = give(u, "phea", 0);
  u.hp = 100;
  world.useItem(u.id, 0, 0, u.x, u.y);
  check("a one-charge potion is gone with the drink", u.inventory[0], null);
  world.tick(5);
  const fresh = world.createItem("phea", u.x + 20, u.y);
  check("a fresh one picked up 5 s later arrives on cooldown", world.unitAddItem(u.id, fresh), true);
  check("…with the 15 s that are left of the group's 20", cd(u, 0), 15);
  check("…and it cannot be drunk", world.useItem(u.id, 0, 0, u.x, u.y), false);
  // …and the same item handed to somebody else is ready at once: the clock never belonged
  // to the item, and the second hero has pressed nothing.
  const other = hero({ x: 1020, y: 1000 });
  check("handed to another hero it comes off cooldown", world.unitAddItem(other.id, u.inventory[0].id), true);
  check("…ready in his hand", cd(other, 0), 0);
  check("…and gone from the first hero's", u.inventory[0], null);
  void held;
}

console.log("\nan item that IGNORES cooldown neither waits nor makes its group wait  (ignoreCD)");
{
  const u = hero();
  give(u, "wneg", 0);
  check("the wand fires", world.useItem(u.id, 0, 0, u.x, u.y), true);
  check("…and is ready again at once, its ability's 30 s ignored", cd(u, 0), 0);
  check("…with a charge spent all the same", u.inventory[0].charges, 2);
}

console.log(failed ? `\n${failed} FAILED` : "\nitem cooldowns: all checks passed");
process.exit(failed ? 1 : 0);
