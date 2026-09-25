// Headless check of the per-UNIT ability natives' SIM half (docs/map-compatibility.md pass 9):
// `BlzUnitDisableAbility` / `BlzUnitHideAbility` as COUNTERS, and the cooldown and rank readers.
//
// The counters are the part worth a test, because they are the part that surprises: "increase/
// decrease counters on each usage. The Ability switches … state only when moving over the 0 even
// line" (hiveworkshop 312477) — so a map that disables twice has to enable twice (312184), and
// "the counters reset when the ability is lost". Each of those is a check below.
//
// (The fixture below is the pass-8 test's, whose header follows — the same world WITH a tech state.)
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


const SILENT = SimWorld.SILENT_REFUSAL;
const u = caster(0);
const ab = () => u.abilities.find((a) => a.id === "A000");

console.log("a plain disable greys the ability; it stays on the card");
check("usable to begin with", world.castUseError(u.id, "AHds"), null);
world.unitDisableAbility(u.id, "A000", true, false);
check("disabled: refused, silently", world.castUseError(u.id, "AHds"), SILENT);
check("…at the order door too", world.issueCast(u.id, "AHds"), false);
check("…but NOT hidden — the button stays, greyed", world.scriptHidden(ab()), false);

console.log("\nit is a COUNTER: twice off needs twice on");
world.unitDisableAbility(u.id, "A000", true, false);
world.unitDisableAbility(u.id, "A000", false, false);
check("disabled twice, enabled once: still disabled", world.castUseError(u.id, "AHds"), SILENT);
world.unitDisableAbility(u.id, "A000", false, false);
check("…enabled a second time: usable", world.castUseError(u.id, "AHds"), null);

console.log("\n…and an enable BEFORE a disable absorbs it");
world.unitDisableAbility(u.id, "A000", false, false);
world.unitDisableAbility(u.id, "A000", true, false);
check("one spare enable swallows one disable", world.castUseError(u.id, "AHds"), null);
world.unitDisableAbility(u.id, "A000", true, false);
check("…but not two", world.castUseError(u.id, "AHds"), SILENT);
world.unitDisableAbility(u.id, "A000", false, false);

console.log("\nhideUI moves the HIDE counter the same way, and hidden also disables");
world.unitDisableAbility(u.id, "A000", true, true);
check("disabled with hideUI: the button is off the card", world.scriptHidden(ab()), true);
check("…and it cannot be used", world.castUseError(u.id, "AHds"), SILENT);
world.unitDisableAbility(u.id, "A000", false, true);
check("the matching enable with hideUI brings it back", world.scriptHidden(ab()), false);
check("…usable", world.castUseError(u.id, "AHds"), null);
world.unitHideAbility(u.id, "A000", true);
check("BlzUnitHideAbility alone hides it", world.scriptHidden(ab()), true);
check("…and \"hide also disables\"", world.castUseError(u.id, "AHds"), SILENT);
world.unitHideAbility(u.id, "A000", false);
check("…and shows it again", world.castUseError(u.id, "AHds"), null);

console.log("\nit is per UNIT");
const other = caster(0);
world.unitDisableAbility(u.id, "A000", true, false);
check("a second unit of the same player is untouched", world.castUseError(other.id, "AHds"), null);

console.log("\nthe counters reset when the ability is lost");
u.abilities = u.abilities.filter((a) => a.id !== "A000");
u.abilities.unshift({ id: "A000", code: "AHds", level: 1, cooldownLeft: 0, autocastOn: false });
check("re-added, it starts usable", world.castUseError(u.id, "AHds"), null);
check("a unit without the ability has no counter to move", world.unitDisableAbility(u.id, "Zzzz", true, false), false);

console.log("\nthe clock and the type's numbers");
ab().cooldownLeft = 6.5;
check("BlzGetUnitAbilityCooldownRemaining reads the entry's clock", world.unitAbilityCooldownLeft(u.id, "A000"), 6.5);
world.endUnitAbilityCooldown(u.id, "A000");
check("BlzEndUnitAbilityCooldown ends it", world.unitAbilityCooldownLeft(u.id, "A000"), 0);
check("rank 0 of the type's data", JSON.stringify(world.abilityRankData("A000", 0)), JSON.stringify({ cost: 25, cooldown: 10 }));
check("a rank the row does not have is undefined", world.abilityRankData("A000", 5), undefined);

console.log(failed ? `\n${failed} FAILED` : "\nall per-unit ability checks passed");
process.exit(failed ? 1 : 0);
