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
const { simHooks, authorityHooks } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));
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
  "addHeroXp", "addToStock", "createItem", "enumItems", "getHeroSkillPoints", "getHeroXp",
  "getTimeOfDay", "getUnitAbilityLevel", "getUnitFacing", "getUnitFlyHeight", "getUnitLevel",
  "getUnitMoveSpeed", "getUnitState", "isDawnDuskEnabled", "isUnitPaused", "itemInfo",
  "modifySkillPoints", "pauseUnit", "playerTechCount", "removeFromStock", "removeItem",
  "resetUnitCooldown", "selectHeroSkill", "setAllTypeSlots", "setDawnDusk", "setHeroLevel",
  "setHeroXp", "setItemCharges", "setItemPosition", "setPlayerTechMaxAllowed",
  "setPlayerTechResearched", "setTimeOfDay", "setTypeSlots", "setUnitAbilityLevel",
  "setUnitFacing", "setUnitInvulnerable", "setUnitMoveSpeed", "setUnitPathing", "setUnitPosition",
  "setUnitState", "setUnitTurnSpeed", "unitAddAbility", "unitAddItem", "unitDropItemPoint",
  "unitDropItemSlot", "unitDropItemTarget", "unitInventorySize", "unitItemInSlot",
  "unitRemoveAbility", "unitRemoveItem", "unitRemoveItemFromSlot", "unitUseItem",
  "waygateActivate", "waygateDestination", "waygateIsActive", "waygateSetDestination",
].sort();

console.log("the pure-world half of the hook table is complete");
const hooks = simHooks(world);
const got = Object.keys(hooks).sort();
check("every expected native is present, and no extra", got, EXPECTED);
check("all 56 of them are functions", got.filter((k) => typeof hooks[k] !== "function"), []);
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
