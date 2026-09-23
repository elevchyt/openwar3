// Headless check of pass 6's SIM half (docs/map-compatibility.md): `UnitApplyTimedLife`'s clock,
// the summon EVENT (`noteSummon` → EVENT_(PLAYER_)UNIT_SUMMON), and which raises name a summoner.
//
// The clock is checked through a real `tick`, because what matters is that the unit DIES when it
// runs out — the same clock a Water Elemental wears — without being made a summon (Dispel and the
// summon XP factor read `isSummon`, and a dummy caster on a two-second life is neither).
//
// (The fixture below is the pass-8 test's, whose header follows — a world WITH a tech state, whose
// unit row is complete enough for `tick`.)
//
// Nothing in the install says what "unavailable" means, so the rule is read off two Hive
// tutorials that agree (hiveworkshop 225879 "Disable an ability for a specific hero/unit", and
// 120518): the button leaves the command card and the ability cannot be USED, but — "in contrast
// to `UnitRemoveAbility`" — the unit still HAS it: "the cooldown of the ability keeps running in
// the background", and a passive keeps working. It is also per PLAYER and never per unit: "the
// action covers all the units of a given player and there is no variant for a specific unit."
// Each of those is a check below.
//
// The world is built WITH a tech and an upgrade registry, because `SimWorld.tech` is null without
// them and every gate here is `tech && …` — a world without one would pass every check vacuously.
// The first check asserts it is not.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { TechRegistry } = require(join(REPO, ".sim-build", "src", "data", "techtree.js"));
const { UpgradeRegistry } = require(join(REPO, ".sim-build", "src", "data", "upgrades.js"));
const { UnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { simHooks } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// --- one active ability, one passive, and the smallest tech tree that makes a TechState -------
const D = (...v) => { const a = new Array(9).fill(NaN); v.forEach((x, i) => { a[i] = x; }); return a; };
const lvl = (over = {}) => ({
  cost: 25, cooldown: 10, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0,
  data: D(), dataStr: [], buffs: [], summon: "", ...over,
});
const ability = (id, code, target, over = {}) => ({
  id, code, isHero: false, isItem: false, levels: 1, reqLevel: 0, levelSkip: 0,
  target, targetFlags: [], autocast: false, name: id, icon: "", hotkey: "",
  researchHotkey: "", buttonX: 0, buttonY: 0, learnX: 0, learnY: 0, research: false,
  tips: [], uberTips: [], researchTip: "", researchUberTip: "",
  missileArt: "", targetArt: "", targetAttach: [], casterArt: "", specialArt: "", effectArt: "",
  areaArt: "", fxArt: "", effectSound: "", buffFx: [], buffArt: "", buffEffectArt: "",
  buffSpecialArt: "", lightning: [], animNames: [], order: "", orderOn: "", orderOff: "",
  levelData: [lvl()], ...over,
});
// A000 stands in for the kind of custom active a map disables; A001 for a passive it hides.
const ABILITIES = new Map([
  ["A000", ability("A000", "AHds", "none")],
  ["A001", ability("A001", "AEev", "passive")],
]);
const abilityReg = { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] };
const techNode = (id) => [id, {
  id, name: id, requiresTiers: [[]], requiresAmount: [], dependencyOr: [], trains: [], researches: [],
  builds: [], upgrade: [], makeitems: [], sellitems: [], sellunits: [], revive: false,
}];
const tech = new TechRegistry(new Map([techNode("hfoo"), techNode("A000"), techNode("A001")]));
const upgrades = new UpgradeRegistry(new Map());
const units = new UnitRegistry(new Map([["hfoo", {
  id: "hfoo", name: "hfoo", isHero: false, isBuilding: false, goldCost: 0, lumberCost: 0, buildTime: 1, foodUsed: 0, foodMade: 0,
  upgradesUsed: [], abilities: [], moveHeight: 0, defUp: 0, priority: 0,
}]]));

const grid = new PathingGrid({ width: 32, height: 32, flags: new Uint8Array(32 * 32).fill(0x40) }, [0, 0]);
const world = new SimWorld(grid, 1, abilityReg, undefined, units, tech, upgrades);

let nextId = 1;
function caster(owner) {
  const u = {
    id: nextId++, owner, team: owner, typeId: "hfoo", x: 500, y: 500, prevX: 500, prevY: 500,
    hp: 500, maxHp: 500, mana: 500, maxMana: 500, buffs: [], inventory: [], weapons: [],
    abilities: [
      { id: "A000", code: "AHds", level: 1, cooldownLeft: 0, autocastOn: false },
      { id: "A001", code: "AEev", level: 1, cooldownLeft: 0, autocastOn: false },
    ],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "human", level: 1, xp: 0,
    stunned: false, silenced: false, morphT: 0, portalLeft: 0, hidden: false, radius: 16,
    order: "idle", orderQueue: [], path: [], garrison: [], itemCooldowns: new Map(),
  };
  world.units.set(u.id, u);
  return u;
}


console.log("UnitApplyTimedLife puts a unit on the summon clock");
{
  const u = caster(0);
  // The pass-8 fixture never ticked a unit's STATS, so it carries no bases; `recomputeStats`
  // would derive NaN life from them and the unit would read as dead before any clock ran.
  Object.assign(u, { weapons: [], weapon: null, baseMaxHp: 500, baseMaxMana: 0, baseArmor: 0, armor: 0,
    baseHpRegen: 0, baseManaRegen: 0, baseSpeed: 270, speed: 270, startStr: 0, startAgi: 0, startInt: 0,
    baseStr: 0, baseAgi: 0, baseInt: 0, str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0,
    intPerLevel: 0, primaryAttr: "", summonLeft: 0, summonMax: 0 });
  world.applyTimedLife(u.id, 2);
  check("the clock is set", u.summonLeft, 2);
  check("…and its bar's full length with it", u.summonMax, 2);
  check("…and it is NOT made a summon", !!u.isSummon, false);
  check("…yet it wears the timed-life buff that names its bar", u.timedLifeBuff, "BTLF");
  world.applyTimedLife(u.id, 1.5, "Bhwd");
  check("a script's own buff names the bar instead", u.timedLifeBuff, "Bhwd");
  check("a second call replaces the clock", u.summonLeft, 1.5);
  world.tick(1);
  check("a second in, it is still alive", u.hp > 0, true);
  world.tick(1);
  check("when the clock runs out, it dies", u.hp <= 0 || !world.units.has(u.id), true);
  world.applyTimedLife(9999, 5); // nothing there
  check("a unit that is not there is ignored", true, true);
}

console.log("\nthe summon event is captured only when a trigger listens");
{
  const summoner = caster(3);
  const summoned = caster(3);
  world.noteSummon(summoner.id, summoned.id);
  check("not listening: nothing recorded", world.drainSummonEvents().length, 0);
  world.captureSummons = true;
  world.noteSummon(summoner.id, summoned.id);
  const [e] = world.drainSummonEvents();
  check("listening: the SUMMONER is recorded", e && e.summoner.id, summoner.id);
  check("…and the summoned unit", e && e.summoned.id, summoned.id);
  check("…with the summoner's owner, which the player event is filed under", e && e.summoner.owner, 3);
  check("the drain empties it", world.drainSummonEvents().length, 0);
  world.noteSummon(summoner.id, 9999);
  check("a summon that does not exist is not an event", world.drainSummonEvents().length, 0);
}

console.log("\na TIMED raise names its caster; a Resurrection names nobody");
{
  const body = [{ unitId: "hfoo", x: 100, y: 100, facing: 0 }];
  world.raiseClaimedCorpses(body, 0, 0, { durationSec: 40, summoner: 77 });
  world.raiseClaimedCorpses(body, 0, 0, { durationSec: 0, summoner: 77 });
  const reqs = world.drainSummonRequests();
  check("Animate Dead's skeleton carries its raiser", reqs[0].sourceId, 77);
  check("a Resurrection's unit carries no summoner — it is not a summon", reqs[1].sourceId, 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall summon checks passed");
process.exit(failed ? 1 : 0);
