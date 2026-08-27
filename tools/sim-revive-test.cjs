// Headless checks on the two things death is supposed to leave behind.
//
// **A revived hero is the SAME hero.** WC3 does not sell you a replacement Archmage — it
// stands YOURS back up, with the level it had, the experience under that level, the ranks it
// had spent points on, the points it had not, the name it was born with and every item in its
// six slots. So a hero's death has to FILE all of that (`SimWorld.fallen`) rather than let it
// go with the unit, and the price of getting it back has to be the level's rather than the
// unit type's. Both ladders come out of `Units\MiscGame.txt`, which writes the arithmetic out
// in its own comment; what is checked here is that our reading of it lands on the numbers the
// classic manual quotes back — 340 gold for a level 5 at an altar, 110 seconds (the cap), and
// 680 gold / 160 lumber instantly at a Tavern.
//
// The vitals are the other half of that pairing, and they are what makes the Tavern a real
// choice rather than a strictly better altar: an altar hands the hero back whole (full life,
// its opening 100 mana), a Tavern hands it back at half life with an empty tank.
//
// **And an enemy building's status is not yours to read.** `DisplayBuildingStatus=0` sits in
// the same file next to `DisplayEnemyInventory=1` — the same question asked about a hero's
// items and answered the other way — so the queue and the construction timer are the owner's.
// That one is checked against `heroReviveCost`'s neighbours in gameplayConstants rather than
// through the panel, which needs a renderer; the panel's own gate reads this same constant.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const {
  MISC_GAME, heroReviveCost, heroReviveVitals,
} = require(join(REPO, ".sim-build", "src", "data", "gameplayConstants.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// A hero, as `Units\UnitBalance.slk` prices every one of the twelve: 425 gold, 100 lumber,
// 55 seconds to train, and 100 mana to open with (`mana0`).
const HERO = { gold: 425, lumber: 100, time: 55, mana0: 100 };

console.log("\nthe altar's ladder is the file's own arithmetic");
{
  const lv1 = heroReviveCost("altar", HERO.gold, HERO.lumber, HERO.time, 1);
  // 425 × (0.40 + 0.10×0) = 170, and 55 × (1 × 0.65) = 35.75.
  check("a level 1 revives for 170 gold", lv1.gold, 170);
  check("…no lumber, ever, at an altar", lv1.lumber, 0);
  check("…in 0.65 of its build time", Math.round(lv1.time * 100) / 100, 35.75);

  // 425 × (0.40 + 0.10×4) = 340 — the number the live game charged in the playtest.
  check("a level 5 revives for 340 gold", heroReviveCost("altar", HERO.gold, HERO.lumber, HERO.time, 5).gold, 340);

  const lv10 = heroReviveCost("altar", HERO.gold, HERO.lumber, HERO.time, 10);
  // "The maximum cost to revive a Hero will be 550 Gold and 0 Lumber at an Altar" —
  // 425 × 1.3 = 552.5, floored. The flat HeroMaxReviveCostGold (700) is never reached.
  check("a level 10 revives for 552 gold — the manual's ~550 maximum", lv10.gold, 552);
  check("…and never more than the flat cap", lv10.gold <= MISC_GAME.HeroMaxReviveCostGold, true);
  // "Hero revive time is capped at 110 seconds" — 55 × ReviveMaxTimeFactor (2.0).
  check("the wait tops out at 110 seconds", lv10.time, 110);
  check("…which it has already reached by level 4", heroReviveCost("altar", HERO.gold, HERO.lumber, HERO.time, 4).time, 110);
}

console.log("\nthe tavern's is the same arithmetic at twice the rate, and instant");
{
  const lv5 = heroReviveCost("tavern", HERO.gold, HERO.lumber, HERO.time, 5);
  check("a level 5 wakes for 680 gold", lv5.gold, 680);
  check("…and 160 lumber, which the altar never charges", lv5.lumber, 160);
  check("…with no wait at all", lv5.time, 0);

  const lv10 = heroReviveCost("tavern", HERO.gold, HERO.lumber, HERO.time, 10);
  // "1105 Gold 260 Lumber at a Tavern" — 425 × 2.6 and 100 × 2.6, to the coin.
  check("a level 10 wakes for the manual's 1105 gold", lv10.gold, 1105);
  check("…and its 260 lumber", lv10.lumber, 260);
}

console.log("\nwhat a hero stands up with");
{
  // "restored to full hit points and 100 Mana"
  const altar = heroReviveVitals("altar", 625, 465, HERO.mana0);
  check("an altar gives back every hit point", altar.hp, 625);
  check("…and the hero's opening 100 mana", altar.mana, 100);
  // "brought back to life with 0 mana and 50% health"
  const tavern = heroReviveVitals("tavern", 625, 465, HERO.mana0);
  check("a tavern gives back half the hit points", tavern.hp, 313);
  check("…and no mana whatever", tavern.mana, 0);
}

console.log("\ndeath files the hero, it does not lose it");
{
  const grid = new PathingGrid({ width: 64, height: 64, flags: new Uint8Array(64 * 64) }, [0, 0]);
  const world = new SimWorld(grid, 1, { get: () => undefined });
  const hero = {
    id: 7, owner: 0, team: 0, typeId: "Hamg", isHero: true, properName: "Antonidas",
    level: 5, xp: 1400, skillPoints: 3,
    abilities: [{ id: "AHbz", code: "AHbz", level: 2, cooldownLeft: 0, autocastOn: false }],
    inventory: [{ id: 11, itemId: "ratf", charges: 0, cooldownLeft: 0 }, null],
    baseStr: 14, baseAgi: 12, baseInt: 20, baseMaxHp: 625,
    hp: 0, maxHp: 625, mana: 0, maxMana: 465, x: 500, y: 600,
    isCreep: false, neutralPassive: false, isIllusion: false,
    buffs: [], weapons: [], orderQueue: [], path: [], footprint: 0, hasReservation: false,
    building: null, worker: null, order: "idle", targetId: null,
    garrison: [], garrisonCap: 0, inMine: false, inBurrow: false, insideBuild: false,
    isSummon: false, summonLeft: 0, constructing: 0, mineId: 0, entangledBy: 0,
    heldCorpses: [], moving: false, noCollision: false, radius: 16, facing: 0,
  };
  world.units.set(hero.id, hero);
  world.killUnit(hero.id);

  check("the unit is gone from the world", world.units.has(7), false);
  const f = world.fallen.get(7);
  check("…and filed on its owner's altar roster under its own id", !!f, true);
  check("with its name", f.properName, "Antonidas");
  check("its level and the experience under it", [f.level, f.xp], [5, 1400]);
  check("the points it had not spent", f.skillPoints, 3);
  check("the ranks it had", f.abilities.map((a) => `${a.id}:${a.level}`), ["AHbz:2"]);
  check("its inventory — a hero keeps its items through death", f.inventory.filter(Boolean).map((i) => i.itemId), ["ratf"]);
  check("and the tomes it drank, which live in the base attributes", [f.baseStr, f.baseInt, f.baseMaxHp], [14, 20, 625]);
  check("nobody is reviving it yet", f.revivingAt, 0);
  check("it is the only one on the roster", world.fallenHeroesOf(0).length, 1);
  check("…and it is nobody else's", world.fallenHeroesOf(1).length, 0);

  // A creep hero has no altar behind it and nobody to press the button; filing one would be
  // a leak that grows for the whole match.
  const creep = { ...hero, id: 8, owner: -1, isCreep: true, inventory: [], abilities: [] };
  world.units.set(creep.id, creep);
  world.killUnit(creep.id);
  check("a CREEP hero is not filed — there is no altar behind it", world.fallen.has(8), false);
}

console.log("\nan enemy building's status is the owner's");
{
  // The rule, and the pair that makes it not a guess: the same file answers the same question
  // about a hero's ITEMS the other way, which is why neither reading is ours.
  check("DisplayBuildingStatus is off", MISC_GAME.DisplayBuildingStatus, 0);
  check("…while DisplayEnemyInventory is on", MISC_GAME.DisplayEnemyInventory, 1);
}

console.log(failed ? `\nrevive: ${failed} CHECK(S) FAILED` : "\nrevive: all checks passed");
process.exit(failed ? 1 : 0);
