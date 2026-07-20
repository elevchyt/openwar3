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
const { simHooks } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));

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
  "setHeroXp", "setItemCharges", "setItemPosition", "setPlayerState", "setPlayerTechMaxAllowed",
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
check("all 57 of them are functions", got.filter((k) => typeof hooks[k] !== "function"), []);

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

// setPlayerState is the native that used to be the last live-stash WRITE in the renderer. It
// must reach the real stash, not a frozen copy — if it ever starts going through
// `Authority.stashFor`, this check is what says so.
console.log("\nsetPlayerState reaches the LIVE stash, not a frozen copy");
hooks.setPlayerState(0, 1, 750);
check("gold was written", world.stashOf(0).gold, 750);
hooks.setPlayerState(0, 2, 310);
check("lumber was written", world.stashOf(0).lumber, 310);
hooks.setPlayerState(0, 4, 99); // FOOD_CAP — derived from units, must be ignored
check("food cap is not writable", world.stashOf(0).gold, 750);

console.log(failed ? `\njass-hooks: ${failed} FAILED` : "\njass-hooks: all checks passed");
process.exit(failed ? 1 : 0);
