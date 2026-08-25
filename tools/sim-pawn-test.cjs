// Headless check of what a shop PAYING you looks like (issue #120) — pawnItem()'s money and
// its three-part feedback, through the real sim with stub registries.
//
// WC3 pays `PawnItemRate` (0.50, Units\MiscGame.txt) of the item's own gold/lumber cost, and
// says so out loud on the hero that handed the item over: a "+N" text tag in the game's gold,
// the interface's own gold-credit coins (UI\Feedback\GoldCredit) and the `ReceiveGold` sound
// the shop's own Purchase Item ability names (`[Apit] Effectsound`, Units\CommonAbilityFunc.txt).
//
// The checks that matter are that all three ride the SAME event as the credit — the text is
// attached to the seller (he walks off; the number goes with him) and the sound travels as a
// LABEL rather than being resolved off the art's folder, which is UI\Feedback and holds no
// wav at all.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

// Only the ability's CODE is read here — canPawnAt() asks "does this building carry Apit?".
const ability = (id) => ({
  id, code: id, isHero: false, isItem: false, levels: 1, reqLevel: 0, levelSkip: 0,
  target: "none", targetFlags: [], autocast: false, name: id, icon: "", hotkey: "",
  researchHotkey: "", buttonX: 0, buttonY: 0, learnX: 0, learnY: 0, research: false, tips: [],
  uberTips: [], researchTip: "", researchUberTip: "", missileArt: "", targetArt: "",
  targetAttach: [], casterArt: "", specialArt: "", effectArt: "", areaArt: "", effectSound: "",
  buffFx: [], buffArt: "", buffEffectArt: "", buffSpecialArt: "", lightning: [], animNames: [],
  order: "", orderOn: "", orderOff: "", levelData: [],
});
const ABILITIES = new Map([["Apit", ability("Apit")], ["Asud", ability("Asud")]]);

const item = (id, over = {}) => ({
  id, name: id, description: "", icon: "", tip: "", hotkey: "", buttonX: -1, buttonY: -1,
  model: "", scale: 1, gold: 500, lumber: 0, level: 1, classType: "Permanent", abilities: [],
  charges: 0, cooldownGroup: "", usable: false, perishable: false, powerup: false,
  droppable: true, sellable: true, pawnable: true, pickRandom: false, maxHp: 75, stockMax: 1,
  stockRegen: 120, stockStart: 0, ...over,
});
const ITEMS = new Map([
  ["rat9", item("rat9")],                                  // Claws of Attack +9, 500g
  ["bspd", item("bspd", { gold: 0, lumber: 0 })],           // worth nothing — no payout, no fx
  ["glue", item("glue", { pawnable: false })],              // a quest item: the shop won't take it
]);

// `nmer` is the Mercenary Camp — it sells UNITS (Asud) and no items, so it may not be pawned to.
const UNITS = {
  get: (id) => ({
    abilities: id === "ngme" ? ["Apit"] : id === "nmer" ? ["Asud"] : [],
    goldCost: 0, lumberCost: 0,
  }),
};

const N = 256; // 256 × 32-unit cells of open ground (0x40 = walkable land)
const newWorld = () =>
  new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] },
    { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) },
    UNITS);

let world = newWorld();
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "Hamg", x: 1000, y: 1000, prevX: 1000, prevY: 1000,
    hp: 100, maxHp: 1000, mana: 0, maxMana: 0, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "human", level: 1,
    hpRegen: 0, manaRegen: 0, baseMaxHp: 1000, baseMaxMana: 0, baseHpRegen: 0, baseManaRegen: 0,
    baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, radius: 16, footprint: 0,
    order: "idle", targetId: null, path: [], waypoint: 0, moving: false, facing: 0,
    pendingCast: null, followLeaderId: null, inCombat: false, working: false, atNode: false,
    noCollision: false, stallT: 0, waitT: 0, gaveUp: false, acquireT: 0, arrowShot: null,
    constructing: 0, cooldownLeft: 0, linkT: 0, linkGroup: [], repathT: 0, stunned: false,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const shop = (typeId, x, y) =>
  unit({ typeId, x, y, prevX: x, prevY: y, owner: 12, hp: 500, maxHp: 500, radius: 50,
    footprint: 0, neutralPassive: true,
    building: { constructionLeft: 0, queue: [], builderIds: [], rally: null } });
const hero = (itemId, over = {}) => {
  const h = unit({ isHero: true, ...over });
  if (itemId) h.inventory[0] = { id: nextId++, itemId, charges: 0, cooldownLeft: 0 };
  return h;
};

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}, got ${got}`}`);
}

// --- the sale: half the item's gold, and all three cues on the seller -------------------
{
  world = newWorld();
  const h = hero("rat9");
  const s = shop("ngme", 1200, 1000);
  check("the shop buys it", world.pawnItem(h.id, 0, s.id), true);
  check("…the slot empties", h.inventory[0], null);
  check("…and pays PawnItemRate of 500", world.stashOf(0).gold, 250);

  const texts = world.drainCombatTexts();
  check("one text tag floats", texts.length, 1);
  check("…in gold, reading the payout", `${texts[0].kind}:${texts[0].text}`, "gold:+250");
  check("…ATTACHED to the seller, not placed", texts[0].unitId, h.id);
  check("…and the same red-or-slot colour a crit uses is not asked for", texts[0].colorSlot, -1);
  // Your gold is yours: the tag names the player it paid, and the host declines to put it in
  // anyone else's payload (MatchLink.tickHost) while every renderer drops one addressed
  // elsewhere. A crit and a deny are public facts and carry -1.
  check("…ADDRESSED to the seller's player alone", texts[0].forPlayer, 0);

  const fx = world.drainSpellEffects();
  check("one effect plays", fx.length, 1);
  check("…the gold-credit coins", fx[0].art, "UI\\Feedback\\GoldCredit\\GoldCredit.mdx");
  check("…on the seller", `${fx[0].targetId}@${fx[0].x},${fx[0].y}`, `${h.id}@1000,1000`);
  // Its lone clip runs 1.334 s; the flat 2 s an effect that says nothing gets would leave the
  // coins parked on their last frame for another two thirds of a second.
  check("…for its whole clip", fx[0].life, 1.334);
  // The WAV lives under Abilities\Spells\Items\ResourceItems, not beside the art — so it must
  // travel as a LABEL. Asking for it off the art's own folder (`sound`) searches UI\Feedback,
  // which holds no wav at all, and the sale would go through in silence.
  check("…named by label, since its wav is not beside the art", fx[0].soundLabel, "ReceiveGold");
  check("…and not by folder", !!fx[0].sound, false);
}

// --- a second player's sale is addressed to HIM, not to player 0 -----------------------
{
  world = newWorld();
  const h = hero("rat9", { owner: 3 });
  const s = shop("ngme", 1200, 1000);
  check("player 3 sells", world.pawnItem(h.id, 0, s.id), true);
  check("…and it is player 3 who is paid", world.stashOf(3).gold, 250);
  check("…player 0 is not", world.stashOf(0).gold, 0);
  check("…and the tag is addressed to 3", world.drainCombatTexts()[0].forPlayer, 3);
}

// --- a refused sale is silent ----------------------------------------------------------
{
  world = newWorld();
  const h = hero("glue"); // not pawnable
  const s = shop("ngme", 1200, 1000);
  check("a quest item is refused", world.pawnItem(h.id, 0, s.id), false);
  check("…the hero keeps it", h.inventory[0].itemId, "glue");
  check("…no text", world.drainCombatTexts().length, 0);
  check("…and no coins", world.drainSpellEffects().length, 0);
}
{
  world = newWorld();
  const h = hero("rat9");
  const s = shop("nmer", 1200, 1000); // sells units, not items — no Apit
  check("a Mercenary Camp is refused", world.pawnItem(h.id, 0, s.id), false);
  check("…and says nothing", world.drainSpellEffects().length, 0);
}
{
  world = newWorld();
  // PawnItemRange is 300 and reaches from the shop's edge; 2000 away is far outside it.
  const h = hero("rat9");
  const s = shop("ngme", 3000, 1000);
  check("out of PawnItemRange is refused", world.pawnItem(h.id, 0, s.id), false);
  check("…and says nothing", world.drainSpellEffects().length, 0);
}

// --- a worthless item: no "+0" over the hero, but the shop still takes it ---------------
{
  world = newWorld();
  const h = hero("bspd");
  const s = shop("ngme", 1200, 1000);
  check("a free item still sells", world.pawnItem(h.id, 0, s.id), true);
  check("…for nothing", world.stashOf(0).gold, 0);
  check("…and raises no '+0'", world.drainCombatTexts().length, 0);
  check("…and no coins either", world.drainSpellEffects().length, 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
