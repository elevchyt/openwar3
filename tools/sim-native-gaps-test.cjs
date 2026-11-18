// Headless check of what the WORLD does with the natives issue #313 added — the half
// tools/jass-native-gaps-test.cjs cannot see, since that one stops at the hook table.
//
// Each block is one native's rule, stated as the source states it:
//
//   * SetTerrainPathable rewrites the terrain's own flag (TRUE opens the cell);
//   * UnitShareVision lends ONE unit's sight to a player, whatever the alliance says;
//   * UnitSuspendDecay stops a body's clock and EVENT_PLAYER_UNIT_DECAY is raised once;
//   * rescue is an EVENT raised when a rescuer's unit comes within range (Blizzard.j 6714–6806),
//     once per unit and player, gated on the owner's ALLIANCE_RESCUABLE or SetUnitRescuable;
//   * UnitIgnoreAlarm, UnitAddSleepPerm, BlzUnitCancelTimedLife ("therefore killing it");
//   * Add…ToAllStock reaches every shop that sells that kind of ware;
//   * SetPlayerTaxRate pays a share of GATHERED income to another player.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { simHooks } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));
const { minimapIcons } = require(join(REPO, ".sim-build", "src", "game", "minimapView.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const LAND = 0x40; // open land, as a real wpm spells it (NoWater set — no boat)
const grid = new PathingGrid({ width: 64, height: 64, flags: new Uint8Array(64 * 64).fill(LAND) }, [0, 0]);
const UNITS = {
  hfoo: { id: "hfoo", abilities: [], moveType: "foot" },
  ngme: { id: "ngme", abilities: [], moveType: "", sellItems: ["stwp"] }, // Goblin Merchant
  nmrk: { id: "nmrk", abilities: [], moveType: "" }, // Marketplace — no Sellitems row at all
  hbar: { id: "hbar", abilities: [], moveType: "" }, // Barracks — sells nothing
};
const world = new SimWorld(grid, 1, { get: () => undefined }, undefined, { get: (id) => UNITS[id] });
const hooks = simHooks(world, (p) => p);

let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, typeId: "hfoo", owner: 0, team: 0, hp: 500, maxHp: 500, x: 512, y: 512,
    prevX: 512, prevY: 512, radius: 16, facing: 0, desiredFacing: 0,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0,
    inventory: [], buffs: [], footprint: 1, hasReservation: false, abilities: [],
    orderQueue: [], order: "idle", targetId: null, followLeaderId: null, path: [], waypoint: 0,
    moving: false, inCombat: false, noCollision: false, stuckT: 0, stuckRetries: 0, acquireT: 0,
    pendingCast: null, weapons: [], weapon: null, flying: false, building: null, worker: null,
    inBurrow: false, garrisonHost: 0, garrison: [], garrisonCap: 0, swingLeft: -1,
    summonLeft: 0, summonMax: 0, timedLifeBuff: "", canSleep: false, asleep: false,
    baseArmor: 0, baseMaxHp: 500, baseMaxMana: 0, baseSpeed: 270, baseSight: 1400,
    maxMana: 0, mana: 0, speed: 270, turnRate: 0.6, paused: false,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}

console.log("SetTerrainPathable rewrites the terrain's own flag");
{
  const [cx, cy] = grid.worldToCell(300, 300);
  check("open ground to begin with", [grid.walkable(cx, cy), grid.buildable(cx, cy)], [true, true]);
  hooks.setTerrainPathable(300, 300, 1, false); // PATHING_TYPE_WALKABILITY, not pathable
  check("WALKABILITY false shuts the cell to a walker", grid.walkable(cx, cy), false);
  check("…and a flyer is not asked", grid.walkable(cx, cy, "air"), true);
  hooks.setTerrainPathable(300, 300, 1, true);
  check("TRUE opens it again", grid.walkable(cx, cy), true);
  hooks.setTerrainPathable(300, 300, 3, false); // BUILDABILITY
  check("BUILDABILITY false leaves it walkable and unbuildable", [grid.walkable(cx, cy), grid.buildable(cx, cy)], [true, false]);
  hooks.setTerrainPathable(300, 300, 3, true);
  hooks.setTerrainPathable(300, 300, 5, false); // BLIGHTPATHING has no bit in the grid
  check("a pathing type with no bit of its own changes nothing", [grid.walkable(cx, cy), grid.buildable(cx, cy)], [true, true]);
}

console.log("\nUnitShareVision lends one unit's sight");
{
  const scout = unit({ owner: 3, team: 3 });
  hooks.shareUnitVision(scout.id, 0, true);
  hooks.shareUnitVision(scout.id, 1, true);
  check("to each player named", scout.visionSharedWith, [0, 1]);
  hooks.shareUnitVision(scout.id, 0, true);
  check("naming one twice does not double it", scout.visionSharedWith, [1, 0]);
  hooks.shareUnitVision(scout.id, 0, false);
  hooks.shareUnitVision(scout.id, 1, false);
  check("and taking the last one back leaves nothing", scout.visionSharedWith, undefined);
}

console.log("\na body's clock: decay is announced once, and UnitSuspendDecay stops it");
{
  world.captureDecays = true;
  world.corpses.set(900, { id: 900, deadId: 77, unitId: "hfoo", x: 100, y: 100, facing: 0, owner: 2, isHero: false, mechanical: false, decayLeft: 5, heldBy: 0, raised: false, eatenBy: 0, fallingLeft: 0.5 });
  world.tick(0.25);
  check("nothing while the death clip still plays", world.drainDecayEvents().length, 0);
  world.tick(0.5);
  const ev = world.drainDecayEvents();
  check("the event names the dead unit and its owner once it is down", ev.map((e) => [e.id, e.typeId, e.owner]), [[77, "hfoo", 2]]);
  world.tick(0.25);
  check("…and only once", world.drainDecayEvents().length, 0);
  hooks.suspendDecay(77, true);
  const left = world.corpses.get(900).decayLeft;
  for (let i = 0; i < 40; i++) world.tick(0.25);
  check("suspended, the body neither rots nor goes", [world.corpses.has(900), world.corpses.get(900)?.decayLeft], [true, left]);
  hooks.suspendDecay(77, false);
  for (let i = 0; i < 40; i++) world.tick(0.25);
  check("resumed, it runs out", world.corpses.has(900), false);
}

console.log("\nrescue is an event raised on approach");
{
  world.captureRescues = true;
  const prisoner = unit({ owner: 5, team: 5, x: 2000, y: 2000 });
  const hero = unit({ owner: 0, team: 0, x: 1000, y: 2000 });
  world.tick(0.1);
  check("nobody is rescuable until the owner grants it or a script says so", world.drainRescueEvents().length, 0);
  hooks.setUnitRescuable(prisoner.id, 0, true);
  world.tick(0.1);
  check("…and a rescuer far away raises nothing", world.drainRescueEvents().length, 0);
  hero.x = 2000 - 300; // inside the editor's default 384, body to body
  world.tick(0.1);
  const ev = world.drainRescueEvents();
  check("inside the range, the event names the rescued unit and the rescuer", ev.map((e) => [e.unit.id, e.rescuer.id]), [[prisoner.id, hero.id]]);
  world.tick(0.1);
  check("a rescuer who simply stands there does not raise it again", world.drainRescueEvents().length, 0);
  hooks.setUnitRescuable(prisoner.id, 0, true);
  hooks.setUnitRescueRange(prisoner.id, 100);
  world.tick(0.1);
  check("SetUnitRescueRange narrows it: 300 away is now too far", world.drainRescueEvents().length, 0);
  hero.x = 2000 - 80;
  world.tick(0.1);
  check("…and close enough raises it afresh for a unit made rescuable again", world.drainRescueEvents().length, 1);
  world.rescuablePlayers = (owner, player) => owner === 5 && player === 1;
  const other = unit({ owner: 1, team: 1, x: 2010, y: 2000 });
  world.tick(0.1);
  check("the owner's ALLIANCE_RESCUABLE grant does the same for a player no script named", world.drainRescueEvents().map((e) => e.rescuer.id), [other.id]);
  world.captureRescues = false;
}

console.log("\nper-unit flags");
{
  const u = unit();
  check("UnitIgnoreAlarm answers for a unit that is there, and reads back", [hooks.setUnitIgnoreAlarm(u.id, true), hooks.unitIgnoresAlarm(u.id), hooks.setUnitIgnoreAlarm(9999, true)], [true, true, false]);
  hooks.setUnitSleepPerm(u.id, true);
  check("UnitAddSleepPerm / UnitCanSleepPerm", [hooks.unitSleepPerm(u.id), u.sleepAlways], [true, true]);
  u.asleep = true;
  hooks.setUnitSleepPerm(u.id, false);
  check("taking it away wakes a unit that slept only on its strength", [hooks.unitSleepPerm(u.id), u.asleep], [false, false]);
  check("BlzGetUnitCollisionSize is the pathing radius", hooks.unitCollisionSize(u.id), 16);
  check("a script's propulsion window reads back; none is undefined (the type's answers)", [hooks.getUnitPropWindow(u.id), (hooks.setUnitPropWindow(u.id, 1.5), hooks.getUnitPropWindow(u.id))], [undefined, 1.5]);
  check("BlzIsUnitSelectable: a Locust unit is not", [hooks.isUnitSelectable(u.id), ((u.locust = true), hooks.isUnitSelectable(u.id))], [true, false]);
  const regular = unit();
  hooks.cancelTimedLife(regular.id);
  check("BlzUnitCancelTimedLife does nothing to a regular unit", regular.summonLeft, 0);
  const summon = unit({ summonLeft: 30, summonMax: 30 });
  hooks.cancelTimedLife(summon.id);
  check("…and runs a timed one's clock out", summon.summonLeft < 0.001 && summon.summonLeft > 0, true);
  hooks.setPlayerTaxRate(0, 1, 1, 25);
  check("unitsOwnedBy lists a player's units", hooks.unitsOwnedBy(5).length, 1);
}

console.log("\nthe special minimap icon");
{
  const vp = { hasExplored: () => true, fogHides: () => false, invisHides: () => false };
  const marked = unit({ x: 700, y: 800 });
  hooks.setUnitAltIcon(marked.id, true);
  check("nothing is drawn until a script names the art", minimapIcons(world, { get: () => undefined }, vp), []);
  hooks.setAltMinimapIcon("UI\\Minimap\\minimap-waypoint.blp");
  check("then the unit wears it where it stands", minimapIcons(world, { get: () => undefined }, vp), [{ x: 700, y: 800, icon: "UI\\Minimap\\minimap-waypoint.blp" }]);
  hooks.setUnitAltIcon(marked.id, false);
  check("and loses it when the flag goes", minimapIcons(world, { get: () => undefined }, vp), []);
}

console.log("\nevery shop at once");
{
  const shop = (typeId) => unit({ typeId, building: { constructionLeft: 0, queue: [] } });
  const merchant = shop("ngme"), market = shop("nmrk"), barracks = shop("hbar");
  const sells = world.isShop("ngme");
  hooks.addToAllStock("rat6", "item", 1, 1);
  check("an item goes on the Marketplace's shelf, which no data row stocks", market.building.stock?.has("rat6") ?? false, true);
  check("…on a shop that sells items by data", merchant.building.stock?.has("rat6") ?? false, sells);
  check("…and not into a Barracks", barracks.building.stock?.has("rat6") ?? false, false);
  hooks.removeFromAllStock("rat6");
  check("RemoveItemFromAllStock takes it off every shelf", [market.building.stock.has("rat6"), merchant.building.stock?.has("rat6") ?? false], [false, false]);
}

console.log("\nSetPlayerTaxRate pays a share of gathered income to another player");
{
  const w = new SimWorld(grid, 1, { get: () => undefined }, undefined, { get: (id) => UNITS[id] });
  const h = simHooks(w, (p) => p);
  check("untaxed, the gatherer keeps it all", w.afterTax(0, "gold", 100), 100);
  h.setPlayerTaxRate(0, 1, 1, 25); // PLAYER_STATE_RESOURCE_GOLD
  check("at 25% the gatherer keeps 75", w.afterTax(0, "gold", 100), 75);
  check("…and the other player is paid the 25", w.stashOf(1).gold, 25);
  check("lumber is a separate rate", w.afterTax(0, "lumber", 100), 100);
  check("nobody else's income is touched", w.afterTax(2, "gold", 100), 100);
  h.setPlayerTaxRate(0, 1, 1, 0);
  check("a rate of 0 lifts it", w.afterTax(0, "gold", 100), 100);
}

console.log(failed ? `\n${failed} FAILED` : "\nall issue-313 world checks passed");
process.exit(failed ? 1 : 0);
