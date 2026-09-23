// Headless check of `SetPlayerAbilityAvailable` (docs/map-compatibility.md pass 8) — what a
// disabled ability loses, and what it keeps.
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
const ours = caster(0);
const theirs = caster(1);

console.log("the world under test really has a tech state");
check("SimWorld.tech exists (or every gate below is vacuous)", world.tech !== null, true);

console.log("\nan available ability is usable");
check("our caster may use A000", world.castUseError(ours.id, "AHds"), null);

console.log("\nSetPlayerAbilityAvailable(false) takes it out of the player's HANDS");
simHooks(world, (p) => p).setPlayerAbilityAvailable(0, "A000", false);
check("the card's question now refuses it, silently (the button is not drawn)", world.castUseError(ours.id, "AHds"), SILENT);
check("…and the order door refuses it too — a trigger's order and an autocast included", world.issueCast(ours.id, "AHds"), false);

console.log("\n…but NOT off the unit");
check("the unit still has the ability", ours.abilities.some((a) => a.id === "A000"), true);
check("…at the level it had", world.abilityLevelOf(ours.id, "A000"), 1);
ours.abilities[0].cooldownLeft = 5;
world.tick(1);
check("its cooldown keeps running in the background", Math.round(ours.abilities[0].cooldownLeft * 100) / 100, 4);

console.log("\nit is per PLAYER, never per unit");
check("another player's unit with the same ability is untouched", world.castUseError(theirs.id, "AHds"), null);
const second = caster(0);
check("…while a SECOND unit of the disabled player is refused too", world.castUseError(second.id, "AHds"), SILENT);

console.log("\na disabled PASSIVE is stored, and nothing in the passive's model asks");
world.tech.setAbilityAvailable(0, "A001", false);
check("the passive is marked unavailable for the card", world.tech.abilityAvailable(0, "A001"), false);
check("…and the unit still carries it — a passive keeps working", ours.abilities.some((a) => a.id === "A001"), true);

console.log("\nturned back on");
world.tech.setAbilityAvailable(0, "A000", true);
ours.abilities[0].cooldownLeft = 0;
check("the ability is usable again", world.castUseError(ours.id, "AHds"), null);
check("…and the passive's flag is its own", world.tech.abilityAvailable(0, "A001"), false);

console.log("\na new match forgets it");
world.tech.reset();
check("reset clears every player's disabled list", world.tech.abilityAvailable(0, "A001"), true);

console.log(failed ? `\n${failed} FAILED` : "\nall ability-availability checks passed");
process.exit(failed ? 1 : 0);
