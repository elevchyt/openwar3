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
const { simHooks, authorityHooks, MINE_ID_BASE } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));
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
  "getHeroSkillPoints", "getHeroXp", "getResourceAmount",
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

console.log("the pure-world half of the hook table is complete");
// teamOf is injected — the slot->team seating is the lobby's, not the world's. A stub that is
// deliberately NOT the identity function, so a hook that forgot to apply it is visible.
const TEAMS = { 0: 7, 1: 7, 2: 9 };
const teamOf = (p) => TEAMS[p] ?? p;
const hooks = simHooks(world, teamOf);
const got = Object.keys(hooks).sort();
check("every expected native is present, and no extra", got, EXPECTED);
check("all 63 of them are functions", got.filter((k) => typeof hooks[k] !== "function"), []);
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
const ah = authorityHooks(authority);
check("authorityHooks is exactly the resource pair", Object.keys(ah).sort(), ["getPlayerState", "setPlayerState"]);

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

console.log(failed ? `\njass-hooks: ${failed} FAILED` : "\njass-hooks: all checks passed");
process.exit(failed ? 1 : 0);
