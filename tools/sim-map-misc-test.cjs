// Headless check of pass 11 (docs/map-compatibility.md): a map's own war3mapMisc.txt is the TOP
// layer of every gameplay-constant read (src/data/gameplayConstants.ts `setMapMiscOverlay`).
//
// What is pinned, and why each matters:
//   * a restated row reads back in the row's own SHAPE — a number, or a comma list — and a value
//     that does not parse is IGNORED rather than read as 0;
//   * every table DERIVED from those rows follows: the damage table (Balanced Hero Survival
//     rewrites all five DamageBonus rows), the XP curves (MaxHeroLevel, NeedHeroXP, GrantHeroXP),
//     the day's length (DotA's 450 s), the frost slow (DotA's 0.3);
//   * a HERO TYPE's stored vitals are re-folded when the attribute constants move — they carry
//     the fold already, so without it a map's StrHitPointBonus moved only the strength gained later;
//   * the MinUnitSpeed FLOOR, which the engine never applied at all until this pass;
//   * taking the overlay down restores the install's numbers exactly;
//   * MISC_UNREAD — the rows declared but read by nothing — still matches the source.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const B = (...p) => require(join(REPO, ".sim-build", "src", ...p));
const G = B("data", "gameplayConstants.js");
const { SimWorld } = B("sim", "world.js");
const { PathingGrid } = B("sim", "pathing.js");
const { UnitRegistry } = B("data", "units.js");
const { heroFoldConstants, refoldHeroConstants } = B("data", "objectData.js");
const { slowedMove } = B("sim", "orbs.js");

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}
const overlay = (o) => G.setMapMiscOverlay(o ? new Map(Object.entries(o)) : null);
const r3 = (n) => Math.round(n * 1000) / 1000;

console.log("a restated row reads back in its own shape");
{
  overlay({ MaxHeroLevel: "50", BoneDecayTime: "22.0", HeroFactorXP: "80,70,55,45,30", maxunitspeed: "522.0", MinUnitSpeed: "fast" });
  check("a number row", G.gameNum("MaxHeroLevel"), 50);
  check("a MiscData row, through miscData", G.dataNum("BoneDecayTime"), 22);
  check("a list row, whole", G.gameList("HeroFactorXP"), [80, 70, 55, 45, 30]);
  check("keys match case-insensitively, as the game's INI lookups do", G.gameNum("MaxUnitSpeed"), 522);
  check("a value that does not parse is ignored — the file's 150 stands", G.gameNum("MinUnitSpeed"), 150);
  check("a row the map does not state is the install's", G.gameNum("StrHitPointBonus"), 25);
  overlay(null);
  check("taking the overlay down restores the install's value", G.gameNum("MaxHeroLevel"), 10);
}

console.log("\nthe tables derived from those rows follow");
{
  const normalVsMedium = () => G.damageMultiplier("normal", "medium");
  check("the stock table: Normal vs Medium is 1.5", normalVsMedium(), 1.5);
  // Balanced Hero Survival's own row.
  overlay({ DamageBonusNormal: "1.00,1.00,1.00,1.00,1.00,0.65,1.00,1.00" });
  check("a map's DamageBonusNormal grades the blow", normalVsMedium(), 1);
  check("…and a row it left alone is still the install's (Pierce vs Small 2.0)", G.damageMultiplier("pierce", "small"), 2);
  overlay(null);
  check("…and the stock table is back", normalVsMedium(), 1.5);

  const stockLevel3 = G.xpToReachLevel(3);
  overlay({ NeedHeroXP: "240", NeedHeroXPFormulaB: "70.0" });
  check("the XP to reach level 2 is the map's first entry", G.xpToReachLevel(2), 240);
  check("…and the formula carries the map's B from there", G.xpToReachLevel(3), 240 + 70 * 3);
  overlay({ MaxHeroLevel: "50" });
  check("MaxHeroLevel 50 extends the curve past the stock 10", G.xpToReachLevel(40) > G.xpToReachLevel(10), true);
  overlay({ GrantHeroXP: "100,120,160,220,300" });
  check("GrantHeroXP is read for a hero kill", G.grantedXp(4, true), 220);
  overlay(null);
  check("…and the stock curve is back", G.xpToReachLevel(3), stockLevel3);

  check("the stock day: 24 hours in 480 s", r3(G.gameHoursPerSec()), r3(24 / 480));
  overlay({ DayLength: "450.0" }); // DotA
  check("DotA's 450-second day", r3(G.gameHoursPerSec()), r3(24 / 450));
  check("the frost slow is the file's 0.5 until a map says otherwise", (overlay(null), slowedMove()), 0.5);
  overlay({ FrostMoveSpeedDecrease: "0.3" }); // DotA
  check("…and DotA's 0.3", slowedMove(), 0.3);
  overlay(null);
}

console.log("\na hero TYPE is re-folded when the attribute constants move");
{
  const hero = (id, over) => ({ id, isHero: true, strength: 20, intelligence: 10, agility: 15, primaryAttr: "STR",
    hitPoints: 100 + 20 * 25, mana: 50 + 10 * 15, armor: 1 + -2 + 15 * 0.3,
    weapons: [{ damage: 12 + 20, targets: [], splashTargets: [] }], abilities: [], heroAbilities: [], classification: [],
    properNames: [], animProps: [], attachAnimProps: [], attachLinkProps: [], upgradesUsed: [], tint: [255, 255, 255], ...over });
  const reg = new UnitRegistry(new Map([["H000", hero("H000")], ["hfoo", { ...hero("hfoo"), isHero: false, hitPoints: 420 }]]));
  const before = heroFoldConstants();
  // Angel Arena: 15 hp per strength, 0.25 armour per agility and a 0 base, 1.5 damage per primary point.
  overlay({ StrHitPointBonus: "15.0", AgiDefenseBonus: "0.25", AgiDefenseBase: "0.0", StrAttackBonus: "1.5" });
  const n = refoldHeroConstants(reg, before, heroFoldConstants());
  const h = reg.get("H000");
  check("one hero type moved, and the non-hero did not", [n, reg.get("hfoo").hitPoints], [1, 420]);
  check("hit points: base + strength × the MAP's 15", h.hitPoints, 100 + 20 * 15);
  check("mana: the bonus the map left alone is untouched", h.mana, 50 + 10 * 15);
  check("armour: base + the map's AgiDefenseBase + agility × its 0.25", r3(h.armor), r3(1 + 0 + 15 * 0.25));
  check("damage: base + primary × the map's 1.5", h.weapons[0].damage, 12 + 20 * 1.5);
  check("the install's def is untouched (the change is in the per-map overlay)", reg.base("H000").hitPoints, 100 + 20 * 25);
  overlay(null);
  check("no change in the constants re-folds nothing", refoldHeroConstants(reg, heroFoldConstants(), heroFoldConstants()), 0);
}

console.log("\nthe MinUnitSpeed floor");
{
  const N = 64;
  const world = new SimWorld(
    new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: () => undefined, has: () => false, buffFx: () => [] },
    { get: () => undefined, has: () => false },
    { get: () => ({ priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 }), has: () => false },
  );
  let id = 1;
  const unit = (over = {}) => {
    const u = {
      id: id++, owner: 0, team: 0, typeId: "hfoo", x: 500, y: 500, hp: 400, maxHp: 400, mana: 0, maxMana: 0,
      buffs: [], inventory: [], weapons: [], weapon: null, abilities: [], isHero: false, building: null,
      baseMaxHp: 400, baseMaxMana: 0, baseHpRegen: 0, baseManaRegen: 0, baseArmor: 0, armor: 0,
      baseSpeed: 270, speed: 270, radius: 16, order: "idle", path: [], level: 1, race: "human",
      baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0, str: 0, agi: 0, int: 0,
      strPerLevel: 0, agiPerLevel: 0, intPerLevel: 0, primaryAttr: "", ...over,
    };
    world.units.set(u.id, u);
    world.recomputeStats(u);
    return u;
  };
  const slow = (value) => ({ kind: "slow", group: "test", value, value2: 0, timeLeft: 10, sourceId: 0 });
  check("a walker slowed 60% stops at the floor: 150, not 108", unit({ buffs: [slow(0.6)] }).speed, 150);
  check("a critter's own 100 walks at 150", unit({ baseSpeed: 100, speed: 100 }).speed, 150);
  check("a pinned unit (a 100% root slow) stays at 0", unit({ buffs: [{ ...slow(1), kind: "root" }] }).speed, 0);
  check("a type with no speed stays at 0", unit({ baseSpeed: 0, speed: 0 }).speed, 0);
  overlay({ MinUnitSpeed: "50.0" }); // Angel Arena
  check("a map's MinUnitSpeed 50 lets the slow through (270 × 0.4 = 108)", unit({ buffs: [slow(0.6)] }).speed, 108);
  overlay({ MaxUnitSpeed: "522.0" });
  check("…and its MaxUnitSpeed lifts the ceiling a haste stops at", unit({ baseSpeed: 500, speed: 500 }).speed, 500);
  overlay(null);
  check("the stock ceiling is back: 400", unit({ baseSpeed: 500, speed: 500 }).speed, 400);
}

console.log("\nMISC_UNREAD matches the source");
{
  const src = readFileSync(join(REPO, "src", "data", "gameplayConstants.ts"), "utf8");
  const block = (name) => { const i = src.indexOf(`export const ${name} = {`); return src.slice(i, src.indexOf("} as const;", i)); };
  const keys = ["MISC_GAME", "MISC_DATA", "MISC_ENGINE"].flatMap((b) => [...block(b).matchAll(/^ {2}([A-Z][A-Za-z0-9_]*):/gm)].map((m) => m[1]));
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
  // Every source file, with the MISC_UNREAD list itself cut out of this one (it names them all).
  const unreadStart = src.indexOf("export const MISC_UNREAD");
  const texts = walk(join(REPO, "src")).map((p) => {
    const t = readFileSync(p, "utf8");
    return p.endsWith("gameplayConstants.ts") ? t.slice(0, unreadStart) + t.slice(t.indexOf("]);", unreadStart)) : t;
  });
  const read = (k) => texts.some((t) => new RegExp(`"${k}"|\\.${k}\\b`).test(t));
  // MissDamageReduction is a row of BOTH files (MiscGame.txt and MiscData.txt), so it is declared twice.
  const unread = [...new Set(keys.filter((k) => !read(k)))].sort();
  check("the rows nothing reads are exactly MISC_UNREAD", unread, [...G.MISC_UNREAD].sort());
  check("…and a map stating one is reported, not applied", G.miscKeyIsRead("FollowRange"), false);
  check("…while a read row is applied", G.miscKeyIsRead("maxherolevel"), true);
  check("…and a key we hold no row for at all is reported too", G.miscKeyIsRead("IllusionsGetAttackBonus"), false);
}

console.log(failed ? `\n${failed} FAILED` : "\nall map-misc checks passed");
process.exit(failed ? 1 : 0);
