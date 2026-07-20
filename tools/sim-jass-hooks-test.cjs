// Headless check of the JASS hook table's PURE-WORLD half (docs/multiplayer.md Phase E item 1).
//
// Why this test exists at all, and why it is not ceremony: **every one of the 152 `EngineHooks`
// members is optional**. Drop a native while splitting the table between the renderer and
// `src/game/jassHooks.ts` and nothing complains — `pnpm typecheck` is clean, `pnpm sim:test` is
// green, and the map script silently loses a native at runtime, months later, on one map. A
// spread-composed table has no compiler check that the union is complete, so it needs this one.
//
// It also pins the property that makes the split worth doing: `simHooks` is built from a
// `SimWorld` ALONE. If someone reaches for a registry, the renderer or `RtsController` inside it,
// the require below stops resolving and this test goes red rather than the standalone-compile
// invariant quietly rotting.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { simHooks, authorityHooks, visionHooks, rosterHooks, MINE_ID_BASE } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));
const { Authority } = require(join(REPO, ".sim-build", "src", "game", "authority.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const FLAGS = new Uint8Array(32 * 32); // walkable everywhere
const grid = new PathingGrid(32, 32, 0, 0, 128, FLAGS);
const world = new SimWorld(grid);

// The exact roster that moved out of mapViewer.ts at the split. This list is the point of the
// file: it is what a dropped or renamed native is measured against.
const EXPECTED = [
  "addHeroXp", "addToStock", "createBlightedGoldMine", "createItem", "enumItems",
  "getHeroSkillPoints", "getHeroXp", "getResourceAmount", "killUnit", "removeUnit",
  "getTimeOfDay", "getUnitAbilityLevel", "getUnitFacing", "getUnitFlyHeight", "getUnitLevel",
  "getUnitMoveSpeed", "getUnitState", "getUnitX", "getUnitY",
  "isDawnDuskEnabled", "isUnitPaused", "itemInfo",
  "modifySkillPoints", "pauseUnit", "playerTechCount", "removeFromStock", "removeItem",
  "resetUnitCooldown", "selectHeroSkill", "setAllTypeSlots", "setDawnDusk", "setHeroLevel",
  "setResourceAmount",
  "setHeroXp", "setItemCharges", "setItemPosition", "setPlayerTechMaxAllowed",
  "setPlayerTechResearched", "setTimeOfDay", "setTypeSlots", "setUnitAbilityLevel",
  "setUnitFacing", "setUnitFlyHeight", "setUnitInvulnerable", "setUnitMoveSpeed", "setUnitOwner",
  "setUnitPathing", "setUnitPosition",
  "setUnitState", "setUnitTurnSpeed", "unitAddAbility", "unitAddItem", "unitDropItemPoint",
  "unitDropItemSlot", "unitDropItemTarget", "unitInventorySize", "unitItemInSlot",
  "unitRemoveAbility", "unitRemoveItem", "unitRemoveItemFromSlot", "unitUseItem",
  "waygateActivate", "waygateDestination", "waygateIsActive", "waygateSetDestination",
].sort();

// Minimal unit-type rows for the roster checks. A Keep ('hkee') is deliberately NOT named
// "townhall" — MAIN_HALL_CHAINS is what makes it answer to one, and that is the interesting case.
const TYPEDEFS = {
  hkee: { isHero: false, isBuilding: true, moveType: 0, race: "human", classification: [], typeName: "keep" },
  hhou: { isHero: false, isBuilding: true, moveType: 0, race: "human", classification: [], typeName: "farm" },
  hfoo: { isHero: false, isBuilding: false, moveType: 0, race: "human", classification: [], typeName: "footman" },
};

console.log("the pure-world half of the hook table is complete");
// teamOf is injected — the slot->team seating is the lobby's, not the world's. A stub that is
// deliberately NOT the identity function, so a hook that forgot to apply it is visible.
const TEAMS = { 0: 7, 1: 7, 2: 9 };
const teamOf = (p) => TEAMS[p] ?? p;
const hooks = simHooks(world, teamOf);
const got = Object.keys(hooks).sort();
check("every expected native is present, and no extra", got, EXPECTED);
check("all 65 of them are functions", got.filter((k) => typeof hooks[k] !== "function"), []);
check("setPlayerState is NOT here — it is the authority's", got.includes("setPlayerState"), false);

// Not just present — actually wired to THIS world. A hook bound to the wrong object, or to a
// stale copy, would pass the roster check above and still be useless.
console.log("\nthe hooks read and write the world they were built from");
world.timeOfDay = 8;
check("getTimeOfDay reads the sim's clock", hooks.getTimeOfDay(), 8);
hooks.setTimeOfDay(14);
check("setTimeOfDay writes it back", world.timeOfDay, 14);
check("…and the sim agrees", hooks.getTimeOfDay(), 14);

world.dawnDusk = true;
hooks.setDawnDusk(false);
check("setDawnDusk writes the sim", world.dawnDusk, false);
check("isDawnDuskEnabled reads it", hooks.isDawnDuskEnabled(), false);

// --- the dual-writers ------------------------------------------------------------------------
//
// SetUnitOwner and SetUnitFlyHeight each write the world AND the model. Only the world half is
// here; the renderer decorates. What is checked is the half that MOVED — and specifically that
// the injected teamOf is actually applied, because the sim decides allegiance and vision by TEAM
// rather than by slot. A setUnitOwner that set the owner and left the team behind would leave a
// gifted unit fighting for its old side and lifting fog for it, which is the exact bug this
// native exists to avoid.
console.log("\nthe dual-writers write their world half, teamOf applied");
world.units.set(4242, { id: 4242, owner: 0, team: 7, flyHeight: 0 });
hooks.setUnitOwner(4242, 2);
check("owner was reassigned", world.units.get(4242).owner, 2);
check("team came from the INJECTED teamOf, not the slot", world.units.get(4242).team, 9);
hooks.setUnitFlyHeight(4242, 350);
check("fly height reached the sim", world.units.get(4242).flyHeight, 350);

// --- gold mines are units, but only to a script ----------------------------------------------
//
// A mine lives in SimWorld.mines, not SimWorld.units, and is handed to JASS as
// MINE_ID_BASE + mine.id. That fiction is load-bearing: blizzard.j's MeleeFindNearestMine
// enumerates units, keeps the nearest 'ngol', and clumps the starting workers 320 units off it.
// Get the id space wrong in either direction and a melee start puts its workers somewhere else.
console.log("\ngold mines answer as units under the MINE_ID_BASE offset");
world.mines.set(3, { id: 3, x: 1500, y: 1700, radius: 64, gold: 12500, busy: false });
const mineHandle = MINE_ID_BASE + 3;

check("getUnitX reads the MINE, not a unit", hooks.getUnitX(mineHandle), 1500);
check("getUnitY too", hooks.getUnitY(mineHandle), 1700);
// A handle below the base is a real unit and must NOT be resolved against the mine table —
// mine 3 and unit 3 are different things that would otherwise collide.
world.units.set(3, { id: 3, owner: 0, team: 0, x: 42, y: 43 });
check("a real unit id still reads the unit", [hooks.getUnitX(3), hooks.getUnitY(3)], [42, 43]);

check("getResourceAmount reads the mine's gold", hooks.getResourceAmount(mineHandle), 12500);
hooks.setResourceAmount(mineHandle, 500);
check("setResourceAmount writes it", world.mines.get(3).gold, 500);
check("a non-mine handle has no resource", hooks.getResourceAmount(3), 0);

// CreateBlightedGoldMine is the Undead start's mine swap. We have no haunted mine, so it hands
// back the one still standing — and it must hand back a SCRIPT handle, not a raw mine id.
check("createBlightedGoldMine returns a script handle", hooks.createBlightedGoldMine(0, 1510, 1710, 0), mineHandle);
check("…which resolves back to that mine", hooks.getResourceAmount(hooks.createBlightedGoldMine(0, 1510, 1710, 0)), 500);
check("…and -1 when nothing is in range", hooks.createBlightedGoldMine(0, 90000, 90000, 0), -1);

// RemoveUnit must REFUSE a mine handle. A mine is not a sim unit, so sim.removeUnit could not
// take it off the map anyway — but the only caller that tries is the Undead start's mine swap,
// which puts one straight back, so leaving it standing IS the swap. Spying on the sim rather
// than driving it, because what is being checked is the routing, not SimWorld.removeUnit.
console.log("\nRemoveUnit refuses a gold mine, and reaches the sim for anything else");
const removed = [];
const killed = [];
const realRemove = world.removeUnit.bind(world);
const realKill = world.killUnit.bind(world);
world.removeUnit = (id) => removed.push(id);
world.killUnit = (id) => killed.push(id);
const spyHooks = simHooks(world, teamOf);

spyHooks.removeUnit(mineHandle);
check("a mine handle does not reach sim.removeUnit", removed, []);
check("…and the mine is still standing", !!world.mines.get(3), true);
spyHooks.removeUnit(3);
check("a real unit id does reach it", removed, [3]);
spyHooks.killUnit(3);
check("killUnit reaches the sim", killed, [3]);
world.removeUnit = realRemove;
world.killUnit = realKill;

// --- the authority half -------------------------------------------------------------------
//
// The player-resource pair. `setPlayerState` is the native that used to be the last live-stash
// WRITE in the renderer; it now goes through `Authority.setPlayerResource`, the one named
// method allowed to touch the live stash outside `execute()`. `getPlayerState` reads back
// through `stashFor`'s FROZEN copy. Both facts are checked, because a lazy refactor that made
// the setter go through the frozen copy too would look correct and silently stop working.
//
// Only `stashFor`/`foodFor`/`setPlayerResource` are exercised, so the registries can be stubs —
// which is itself the point: the authority half of the table needs no data tables to answer a
// resource question.
console.log("\nthe player-resource natives go through the authority");
const stubRegistry = { get: () => undefined };
const authority = new Authority(world, stubRegistry, stubRegistry, null, stubRegistry);
// createScriptUnit lives on the CONTROLLER, not on Authority — resolving placement reads the
// pathing grid and the footprint reader — so the structural dep is assembled here the same way
// RtsController.worldHooks assembles it. Spying on it also checks the native routes at all.
const created = [];
const ah = authorityHooks({
  stashFor: (o) => authority.stashFor(o),
  foodFor: (o) => authority.foodFor(o),
  setPlayerResource: (p, r, v) => authority.setPlayerResource(p, r, v),
  currentOrderId: (id) => authority.currentOrderId(id),
  issueUnitOrder: (...a) => authority.issueUnitOrder(...a),
  createScriptUnit: (...a) => { created.push(a); return 909; },
});
check("authorityHooks holds the resource, order and create natives", Object.keys(ah).sort(),
  ["createUnit", "getPlayerState", "getUnitCurrentOrder", "issueUnitOrder", "setPlayerState"]);

// CreateUnit is SYNCHRONOUS in JASS: the id must come back from the call itself, because the
// next statement may order or configure that unit. A queue-only implementation that returned
// nothing would typecheck and break every trigger that keeps the handle.
check("createUnit returns the sim id immediately", ah.createUnit(2, "hfoo", 100, 200, 270), 909);
check("…having passed the arguments straight through", created, [[2, "hfoo", 100, 200, 270]]);

ah.setPlayerState(0, 1, 750);
check("gold reached the LIVE stash", world.stashOf(0).gold, 750);
check("…and reads back through the frozen copy", ah.getPlayerState(0, 1), 750);
ah.setPlayerState(0, 2, 310);
check("lumber reached the live stash", world.stashOf(0).lumber, 310);
check("…and reads back", ah.getPlayerState(0, 2), 310);

// PLAYER_STATE 4/5 are FOOD_CAP/FOOD_USED — derived by walking units, never stored. A write
// must be ignored rather than invented, and must not corrupt a neighbouring field.
ah.setPlayerState(0, 4, 99);
check("a write to FOOD_CAP is ignored", world.stashOf(0).gold, 750);
check("…and lumber is untouched", world.stashOf(0).lumber, 310);
check("food reads as derived (no units seeded)", [ah.getPlayerState(0, 4), ah.getPlayerState(0, 5)], [0, 0]);

// The frozen copy is the whole reason `stashFor` exists — a reader must not be able to spend.
console.log("\nthe read path cannot be used to spend");
const copy = authority.stashFor(0);
check("stashFor is frozen", Object.isFrozen(copy), true);
try { copy.gold = 99999; } catch { /* strict mode throws; sloppy mode silently ignores */ }
check("writing the copy does not reach the world", world.stashOf(0).gold, 750);

// --- the vision + alliance half -------------------------------------------------------------
//
// The fog-modifier registry moved from RtsController onto VisionSet. The constraint that kept it
// on the controller — modifier ids are one global handle space shared with JASS — is satisfied by
// one counter on the set, and only ruled out one counter per viewpoint.
//
// The check that matters is fogEnable. It is a GLOBAL native and used to reach only the local
// viewpoint, which was invisible while one viewpoint existed and became wrong the moment every
// seat got its own. With N viewpoints seated, a script disabling fog for a cinematic has to
// reach all of them.
console.log("\nthe vision natives answer without a controller");
const { VisionSet } = require(join(REPO, ".sim-build", "src", "game", "viewpoint.js"));
const stubAlliances = { sharesVisionWith: () => false, coAllied: (a, b) => a === b, set: () => {}, get: () => false };
const visionWorld = { units: new Map(), isDay: true, activeAttackReveals: () => [], teamDetects: () => false };
const vset = new VisionSet(visionWorld, stubAlliances, () => [], 0, 0, 1024, 1024);
vset.seat([{ player: 0, team: 0 }, { player: 1, team: 1 }, { player: 2, team: 1 }]);
const vh = visionHooks(vset, stubAlliances);

check("visionHooks is exactly the 13 natives", Object.keys(vh).sort(), [
  "createFogModifier", "cripplePlayer", "destroyFogModifier", "fogEnable", "fogMaskEnable",
  "fogModifierStart", "fogModifierStop", "getPlayerAlliance", "isFogEnabled", "isFogMaskEnabled",
  "isPlayerAlly", "setFogState", "setPlayerAlliance",
].sort());

// One handle space: ids are unique across the whole match, not per viewpoint.
const rect = { kind: "rect", minX: 0, minY: 0, maxX: 100, maxY: 100 };
const m1 = vh.createFogModifier(0, 4, rect);
const m2 = vh.createFogModifier(1, 4, rect);
check("modifier ids are distinct across players", m1 !== m2, true);
check("…and are not per-viewpoint counters starting at the same number", [m1, m2], [1, 2]);

console.log("\nFogEnable is global, not local-only  (the bug seating exposed)");
check("fog starts enabled", vh.isFogEnabled(), true);
vh.fogEnable(false);
const allOff = [...vset.all()].every((vp) => vp.isFogEnabled() === false);
check("EVERY seated viewpoint had its fog switched, not just one", allOff, true);
vh.fogMaskEnable(false);
check("the mask likewise", [...vset.all()].every((vp) => vp.isFogMaskEnabled() === false), true);
vh.fogEnable(true);
check("and it switches back", [...vset.all()].every((vp) => vp.isFogEnabled() === true), true);

// CripplePlayer tells every recipient in the force, not just this machine's player.
console.log("\nCripplePlayer exposes to every recipient in the force");
vh.cripplePlayer(0, [1, 2], true);
const victim = { owner: 0, x: 0, y: 0 };
check("recipient 1 sees the crippled player's units", vset.viewpointFor(1).isExposed(victim), true);
check("recipient 2 as well", vset.viewpointFor(2).isExposed(victim), true);
check("a player not in the force does not", vset.viewpointFor(0).isExposed(victim), false);

// --- the roster half --------------------------------------------------------------------------
//
// These seven were filed under "presentation, by nature" alongside camera and sound, because the
// list they sat in ended "...text, selection, and the registries". A registry is a DATA TABLE, not
// presentation, and every one of these reads sim.units, sim.mines and the unit registry with no
// renderer field anywhere. Same classify-by-name mistake Phase B paid for four times.
console.log("\nthe roster natives enumerate and classify from the sim alone");
const roster = rosterHooks(world, { get: (id) => TYPEDEFS[id] }, teamOf);
check("rosterHooks is exactly the seven", Object.keys(roster).sort(), [
  "enumUnits", "findPlacedUnit", "isUnitAlly", "isUnitType",
  "playerStructureCount", "playerTypedUnitCount", "playerUnitCount",
].sort());

// enumUnits must include the MINES, or blizzard.j's MeleeFindNearestMine finds nothing: it
// enumerates UNITS and keeps the nearest 'ngol'.
const enumerated = roster.enumUnits();
check("gold mines are enumerated as units", enumerated.some((u) => u.typeId === "ngol"), true);
check("…under the script handle, not the raw mine id", enumerated.find((u) => u.typeId === "ngol").id, MINE_ID_BASE + 3);

// A mine must classify as a live STRUCTURE. MeleeClearExcessUnit wipes the non-structure
// neutrals around a start location, so a mine answering "not a structure" would be deleted.
check("a mine is a STRUCTURE", roster.isUnitType(MINE_ID_BASE + 3, 2), true);
check("…and GROUND", roster.isUnitType(MINE_ID_BASE + 3, 4), true);
check("…and not DEAD", roster.isUnitType(MINE_ID_BASE + 3, 1), false);

// isUnitAlly is a TEAM question and must use the injected seating, not the slot number.
// Players 0 and 1 are both on team 7 in TEAMS above; player 2 is on 9.
world.units.set(77, { id: 77, owner: 0, team: 7, hp: 100 });
check("a unit on my team is an ally", roster.isUnitAlly(77, 1), true);
check("…and one on another team is not", roster.isUnitAlly(77, 2), false);
world.units.set(78, { id: 78, owner: 12, team: -1, hp: 100 }); // neutral hostile
check("neutral hostile (team -1) is nobody's ally", roster.isUnitAlly(78, 0), false);

console.log("\nthe count natives are what MeleeInitVictoryDefeat reads");
world.units.set(80, { id: 80, owner: 5, team: 0, hp: 100, building: { constructionLeft: 0 }, typeId: "hkee" });
world.units.set(81, { id: 81, owner: 5, team: 0, hp: 100, building: { constructionLeft: 30 }, typeId: "hhou" });
world.units.set(82, { id: 82, owner: 5, team: 0, hp: 100, typeId: "hfoo" });
check("structures, complete only", roster.playerStructureCount(5, false), 1);
check("structures, including incomplete", roster.playerStructureCount(5, true), 2);
check("all units, complete only", roster.playerUnitCount(5, false), 2);
// A Keep answers to "townhall" only with includeUpgrades — that is how
// MeleeGetAllyKeyStructureCount finds a main hall whatever tier it has reached.
check("a Keep is not literally named townhall", roster.playerTypedUnitCount(5, "townhall", true, false), 0);
check("…but counts as one up the upgrade chain", roster.playerTypedUnitCount(5, "townhall", true, true), 1);

console.log(failed ? `\njass-hooks: ${failed} FAILED` : "\njass-hooks: all checks passed");
process.exit(failed ? 1 : 0);
