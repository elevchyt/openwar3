// The Graveyard's hidden CREATE CORPSE (`Agyd`) — world.ts tickGraveyards.
//
// `Units\UnitAbilities.slk` gives `ugrv` `abilList = Abgs,Agyd,Arlm`, and the middle one is
// the ability the row's own strings file keeps commented out (no Tip, no Ubertip, no Hotkey):
// a button-less pulse that lays a Ghoul corpse beside the building every `Cool1` = 15 s until
// `DataA` = 5 of them lie within `DataC` = 250 units. The editor names the columns
// (UI\WorldEditStrings.txt): GYD1 "Maximum Number of Corpses", GYD2 "Radius of Gravestones",
// GYD3 "Radius of Corpses", GYDU "Corpse Unit Type" = `ugho`.
//
// Run: node tools/sim-graveyard-test.cjs   (after `tsc -p tools/tsconfig.sim.json`)
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

const lvl = (over) => ({ cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0, data: new Array(9).fill(NaN), dataStr: new Array(9).fill(""), buffs: [], summon: "", ...over });
// The real row: Cool1 15, DataA 5, DataB 200, DataC 250, UnitID ugho, SpecialArt the grave marker.
const ABILITIES = {
  Agyd: { id: "Agyd", code: "Agyd", target: "passive", targetFlags: [], specialArt: "Abilities\\Spells\\Undead\\Graveyard\\GraveMarker.mdl", levelData: [lvl({ cooldown: 15, data: [5, 200, 250], summon: "ugho" })] },
};
const abilities = { get: (id) => ABILITIES[id] };
const UNITS = {
  ugrv: { id: "ugrv", abilities: ["Agyd"], moveType: "foot", upgradesUsed: [], buildTime: 60, goldCost: 215, lumberCost: 0, manaRegen: 0, regenType: "none", hpRegen: 0, requirePlace: "blighted", classification: [] },
  ugho: { id: "ugho", abilities: [], moveType: "foot", upgradesUsed: [], buildTime: 0, goldCost: 120, lumberCost: 0, manaRegen: 0, regenType: "blight", hpRegen: 2, requirePlace: "", classification: [] },
};
const unitReg = { get: (id) => UNITS[id] };
const techReg = { requirements: () => [], satisfies: (unitId) => [unitId], producesUnits: () => false, get: () => undefined, has: () => false, all: () => [] };
const upgradeReg = { get: () => undefined, has: () => false, all: () => [] };
function newWorld(w = 256, h = 256) {
  const grid = new PathingGrid({ width: w, height: h, flags: new Uint8Array(w * h) }, [0, 0]);
  return new SimWorld(grid, 1, abilities, undefined, unitReg, techReg, upgradeReg);
}
const base = (over) => ({
  owner: 0, team: 0, facing: 0, mana: 0, maxMana: 0, hpRegen: 0, turnRate: 0.6, scale: 1,
  armor: 0, armorType: "medium", defUp: 0, weapon: null, weapons: [], oldWeapons: [],
  sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800, flying: false,
  mechanical: false, invulnerable: false, race: "undead", isBuilding: false, foodCost: 0,
  goldCost: 0, lumberCost: 0, abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
  canFlee: true, targetedAs: "ground", deathTime: 2, name: "", worker: null,
  depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
  ...over,
});
const BUILT = (x, y) => ({ constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: x, rallyY: y, rallyKind: "point", rallyTargetId: 0, producesUnits: false });
const RISING = (x, y, left) => ({ ...BUILT(x, y), constructionLeft: left, buildTimeTotal: left });
const AGYD = { abilities: [{ id: "Agyd", code: "Agyd", level: 1, cooldownLeft: 0, autocastOn: false }] };
const graveyard = (world, building) => world.add(base({ id: 1, typeId: "ugrv", x: 2000, y: 2000, hp: 800, maxHp: 800, speed: 0, radius: 96, isBuilding: true, name: "Graveyard" }), building, AGYD);
const run = (world, seconds) => { for (let t = 0; t < seconds / 0.05; t++) world.tickGraveyards(0.05); };
const bodies = (world) => [...world.corpses.values()].filter((c) => !c.raised && !c.heldBy);

console.log("A standing Graveyard lays a Ghoul corpse beside itself every 15 seconds");
{
  const world = newWorld();
  const gy = graveyard(world, BUILT(2000, 2000));
  run(world, 14.9);
  check("nothing before the first pulse comes round", bodies(world).length === 0);
  run(world, 0.2);
  const first = bodies(world);
  check("one body on the first pulse", first.length === 1, String(first.length));
  const c = first[0];
  check("…a Ghoul (UnitID `ugho`)", c?.unitId === "ugho", c?.unitId);
  check("…the owner's own", c?.owner === gy.owner);
  const d = c ? Math.hypot(c.x - gy.x, c.y - gy.y) : 0;
  check("…inside DataC = 250 of the building", d <= 250, d.toFixed(0));
  check("…and past its hull", d > gy.radius, d.toFixed(0));
  check("…on ground a unit could stand on", !!c && world.grid.walkable(...world.grid.worldToCell(c.x, c.y)));
  check("…with the grave marker set down", world.drainSpellEffects().some((e) => /GraveMarker/.test(e.art)));
  run(world, 15);
  check("two after the second", bodies(world).length === 2, String(bodies(world).length));
}

console.log("The supply is capped at DataA = 5 lying within the radius, and a spent body is not counted");
{
  const world = newWorld();
  const gy = graveyard(world, BUILT(2000, 2000));
  run(world, 15 * 8);
  check("eight pulses lay five, not eight", bodies(world).length === 5, String(bodies(world).length));
  // A Necromancer raising one (or a Meat Wagon carrying it off) opens a place in the quota.
  bodies(world)[0].raised = true;
  run(world, 15);
  check("a spent body is replaced on the next pulse", bodies(world).length === 5, String(bodies(world).length));
  // Somebody else's dead lying nearby are not the Graveyard's supply.
  world.spawnCorpseOf("ugho", gy.x + 100, gy.y, 3);
  bodies(world)[0].raised = true;
  run(world, 15);
  check("another player's corpse does not fill the quota", bodies(world).filter((c) => c.owner === gy.owner).length === 5);
}

console.log("A site still going up has no clock, and neither does a wreck");
{
  const world = newWorld();
  const gy = graveyard(world, RISING(2000, 2000, 60));
  run(world, 30);
  check("nothing while it is being raised", bodies(world).length === 0, String(bodies(world).length));
  gy.building.constructionLeft = 0;
  gy.hp = 0;
  run(world, 30);
  check("…nor from a dead one", bodies(world).length === 0, String(bodies(world).length));
}

console.log("The same seed lays the same corpse on the same tile on every machine");
{
  const a = newWorld();
  const b = newWorld();
  graveyard(a, BUILT(2000, 2000));
  graveyard(b, BUILT(2000, 2000));
  run(a, 46);
  run(b, 46);
  const pa = bodies(a).map((c) => `${c.x},${c.y}`).join(" ");
  const pb = bodies(b).map((c) => `${c.x},${c.y}`).join(" ");
  check("three pulses, identical positions", pa === pb && bodies(a).length === 3, pa);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\ngraveyard: all checks passed");
process.exit(failed ? 1 : 0);
