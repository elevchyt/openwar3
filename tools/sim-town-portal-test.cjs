// Headless check of the SCROLL OF TOWN PORTAL's five seconds.
//
// `AItp` is the only item ability in the whole install with a cast time — `Cast1 = 5` in
// AbilityData.slk, and every other `AI*` row is 0 — and Blizzard's own page says exactly what
// those five seconds are (classic.battle.net/war3/basics/townportalscrolls.shtml):
//
//   "When a Hero activates a Town Portal scroll they become invulnerable. During the
//    channeling, the Hero cannot do any action (such as move, attack, use any other item nor
//    his spell). Any nearby units are not invulnerable so they can still be destroyed. After a
//    short casting period (5 sec. cast time) the Hero will then transport with the surviving
//    units."
//
//   "You can also double click on the Town Portal Scroll which will automatically select the
//    highest (allied) Town Hall as a transport destination." … "Don't double click on your Town
//    Portal unless you want to go back to your Hall."
//
// Four clauses, each pinned below, and each of which an instant teleport gets wrong:
// the invulnerability (which is why a scroll is an escape rather than a gamble), the lock,
// "under no circumstances can the town portal be aborted once started", and **"the surviving
// units"** — the party is whoever is still standing when the clock runs out, not who was there
// when it was pressed.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const D = (...v) => { const a = new Array(9).fill(NaN); v.forEach((x, i) => { a[i] = x; }); return a; };
const lvl = (over = {}) => ({
  cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0,
  data: D(), dataStr: [], buffs: [], summon: "", ...over,
});
const ability = (id, over = {}) => ({
  id, code: id, isHero: false, isItem: true, levels: 1, reqLevel: 0, levelSkip: 0,
  target: "none", targetFlags: [], autocast: false, name: id, icon: "", hotkey: "",
  researchHotkey: "", buttonX: 0, buttonY: 0, learnX: 0, learnY: 0, research: false,
  tips: [], uberTips: [], researchTip: "", researchUberTip: "",
  missileArt: "", targetArt: "", targetAttach: [], casterArt: "", specialArt: "", effectArt: "",
  areaArt: "", fxArt: "", effectSound: "", buffFx: [], buffArt: "", buffEffectArt: "",
  buffSpecialArt: "", lightning: [], animNames: [], order: "", orderOn: "", orderOff: "",
  levelData: [lvl()], ...over,
});

// `[AItp] targs1=structure,vuln,invu  Cast1=5  Area1=1100  Rng1=99999  DataA1=90  DataB1=1`
// — the row, verbatim. `Area1` is the party radius and `DataA1` the party cap.
const TP_TARGS = ["air", "ground", "friend", "self", "organic", "vuln", "invu"];
const ABILITIES = new Map([
  ["AItp", ability("AItp", {
    target: "point", targetFlags: TP_TARGS,
    levelData: [lvl({ castTime: 5, area: 1100, castRange: 99999, data: D(90, 1) })],
  })],
  // A map that has edited the cast away — the instant path still has to work.
  ["AItq", ability("AItq", {
    code: "AItp", target: "point", targetFlags: TP_TARGS,
    levelData: [lvl({ castTime: 0, area: 1100, castRange: 99999, data: D(90, 1) })],
  })],
]);
const item = (id, abil) => ({
  id, name: id, description: "", icon: "", tip: "", hotkey: "", buttonX: -1, buttonY: -1,
  model: "", scale: 1, gold: 350, lumber: 0, level: 3, classType: "Charged", abilities: [abil],
  charges: 1, cooldownGroup: "AItp", usable: true, perishable: true, powerup: false,
  droppable: true, sellable: true, pawnable: true, pickRandom: false, maxHp: 75,
  stockMax: 1, stockRegen: 120, stockStart: 0,
});
const ITEMS = new Map([["stwp", item("stwp", "AItp")], ["stwq", item("stwq", "AItq")]]);
// `buffType = "townhall"` is what a Town Portal resolves to — UnitData's own category, so a
// Great Hall, a Necropolis and a Tree of Life all answer without a per-race list.
const DEF = { priority: 0, buffType: "", abilities: [], upgradesUsed: [], classification: [], moveHeight: 0, defUp: 2, foodUsed: 0 };
const BUILDINGS = {
  htow: { ...DEF, priority: 6, buffType: "townhall" },
  hbar: { ...DEF, priority: 9, buffType: "factory" },
};
const UNITS = { get: (id) => BUILDINGS[id] ?? DEF, has: (id) => id in BUILDINGS };

// A tech registry that has never heard of anything, which is not the same as passing none:
// handing SimWorld one is what gives it a live `world.tech`, and it is asked all three of
// these mid-tick. See tools/sim-undead-test.cjs, where this shape is argued.
const TECH = {
  requirements: () => [], satisfies: (id) => [id], producesUnits: () => false,
  get: () => ({ makeitems: [], sellitems: [], sellunits: [], trains: [], researches: [], builds: [], upgrade: [], revive: false }),
  has: () => false, all: () => [],
};
const UPGRADES = { get: () => undefined, has: () => false, all: () => [] };

const N = 256;
const newWorld = () =>
  new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] },
    { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) },
    UNITS, TECH, UPGRADES);

let world = newWorld();
let nextId = 1;

// Units go in through `world.add`, the real door — so every internal field (including the
// portal channel's own) is initialised the way the sim initialises it, rather than by a
// fixture that has to be kept in step with SimUnit by hand.
const spec = (over) => ({
  owner: 0, team: 0, facing: 0, mana: 0, maxMana: 0, hpRegen: 0, manaRegen: 0, turnRate: 0.6,
  scale: 1, armor: 0, armorType: "medium", defUp: 0, weapon: null, weapons: [], oldWeapons: [],
  sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800, flying: false,
  mechanical: false, invulnerable: false, race: "human", isBuilding: false, foodCost: 0,
  goldCost: 0, lumberCost: 0, abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
  canFlee: true, targetedAs: "ground", deathTime: 2, name: "", worker: null,
  depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
  typeId: "hfoo", hp: 1000, maxHp: 1000, speed: 270, radius: 16, ...over,
});
const BUILT = (x, y) => ({ constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0,
  lumberCost: 0, queue: [], rallyX: x, rallyY: y, rallyKind: "point", rallyTargetId: 0, producesUnits: false });

const soldier = (x, y, over = {}) => world.add(spec({ id: nextId++, x, y, ...over }));
const heroAt = (x, y) => world.add(spec({ id: nextId++, typeId: "Hamg", x, y, isHero: true, name: "Archmage" }));
const hall = (x, y, owner = 0) =>
  world.add(spec({ id: nextId++, typeId: "htow", x, y, owner, hp: 1500, maxHp: 1500, speed: 0,
    radius: 48, isBuilding: true, name: "Town Hall" }), BUILT(x, y));
const give = (u, itemId) => { u.inventory[0] = { id: nextId++, itemId, charges: 1, cooldownLeft: 0 }; return u; };
const step = (secs) => { for (let i = 0; i < Math.round(secs * 60); i++) world.tick(1 / 60); };

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}, got ${got}`}`);
}
/** "Is it standing at that spot" — with a tolerance, because a teleport lands a unit on the
 *  nearest free cell that fits its footprint rather than on the hall's own centre pixel. */
const at = (what, u, x, y) => {
  const d = Math.hypot(u.x - x, u.y - y);
  const ok = d <= 400;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want within 400 of (${x}, ${y}), got (${Math.round(u.x)}, ${Math.round(u.y)}) — ${Math.round(d)} away`}`);
};

console.log("\n-- the five seconds ---------------------------------------------------------");

{
  world = newWorld();
  const h = give(heroAt(6000, 6000), "stwp");
  hall(1000, 1000);
  // Aimed at the HERO'S OWN position — the double-click, which is how the AI uses it and what
  // "the nearest hall of the user" means: itemTownPortal resolves nearestHall(owner, x, y).
  check("the scroll is accepted", world.useItem(h.id, 0, 0, h.x, h.y), true);
  at("…and it does NOT teleport on the press", h, 6000, 6000);
  check("…it starts a five-second channel", h.portalLeft, 5);
  // The charge is spent up front: there is no state in which it is half-used and refundable,
  // because "under no circumstances can the town portal be aborted once started".
  check("…and the scroll is gone at once", h.inventory[0], null);

  step(1);
  at("a second in, it is still standing there", h, 6000, 6000);
  check("…invulnerable", h.invulnerable, true);
  check("…rooted (speed 0)", h.speed, 0);
  // The lock every order path already consults. A hero mid-portal takes no orders at all.
  check("…and it refuses a move order", world.issueMove(h.id, 2000, 2000), false);
  check("…and an attack-move", world.issueAttackMove(h.id, 2000, 2000), false);
  check("…and it is still ON the field, not vanished", world.units.has(h.id), true);

  step(4.2);
  at("after five seconds it is at the hall", h, 1000, 1000);
  check("…no longer channelling", h.portalLeft, 0);
  check("…and mortal again", h.invulnerable, false);
  check("…and able to move again", h.speed > 0, true);
}

console.log("\n-- it takes the SURVIVING units --------------------------------------------");

{
  world = newWorld();
  const h = give(heroAt(6000, 6000), "stwp");
  hall(1000, 1000);
  const lives = soldier(6200, 6000);
  const dies = soldier(6300, 6000);
  world.useItem(h.id, 0, 0, h.x, h.y);
  step(1);
  // "Any nearby units are not invulnerable so they can still be destroyed."
  check("a soldier standing beside the channelling hero is NOT invulnerable", dies.invulnerable, false);
  dies.hp = 0;
  step(4.2);
  at("the hero went", h, 1000, 1000);
  at("…and so did the survivor", lives, 1000, 1000);
  at("…while the one that died did not", dies, 6300, 6000);
}

console.log("\n-- where it goes ------------------------------------------------------------");

{
  // The double-click rule: the hall nearest THE USER. A hero fleeing beside its own expansion
  // must not run past it to reach the main base.
  world = newWorld();
  const h = give(heroAt(6000, 6000), "stwp");
  hall(1000, 1000); // main base, far away
  hall(5200, 6000); // the expansion it is standing next to
  world.useItem(h.id, 0, 0, h.x, h.y);
  step(5.2);
  at("double-clicked, it goes to the user's NEAREST hall", h, 5200, 6000);
}
{
  // …and the one-click form still aims: click near a hall, go to that one.
  world = newWorld();
  const h = give(heroAt(6000, 6000), "stwp");
  hall(1000, 1000);
  hall(5200, 6000);
  world.useItem(h.id, 0, 0, 1100, 1000); // a click on the main base
  step(5.2);
  at("clicked on a hall, it goes to THAT one", h, 1000, 1000);
}
{
  // A hall of somebody else's is not a destination.
  world = newWorld();
  const h = give(heroAt(6000, 6000), "stwp");
  hall(5200, 6000, 1); // the ENEMY's, and much nearer
  hall(1000, 1000, 0);
  world.useItem(h.id, 0, 0, h.x, h.y);
  step(5.2);
  at("it never ports to somebody else's hall", h, 1000, 1000);
}
{
  // No hall at all: the click is refused before the charge is spent — the game's own error.
  world = newWorld();
  const h = give(heroAt(6000, 6000), "stwp");
  check("with no hall standing, the sim refuses it", world.itemUseError(h.id, 0, 0), "Notownportalhalls");
}
{
  // The hall dies DURING the channel. Nothing can abort the portal, so the hero simply finishes
  // the five seconds where it stands — and is mortal again at the end of them.
  world = newWorld();
  const h = give(heroAt(6000, 6000), "stwp");
  const home = hall(1000, 1000);
  world.useItem(h.id, 0, 0, h.x, h.y);
  step(1);
  home.hp = 0;
  step(4.2);
  at("the hall died mid-channel: the hero stays put", h, 6000, 6000);
  check("…and is mortal again", h.invulnerable, false);
}

console.log("\n-- a map that edits the cast away -------------------------------------------");

{
  // `Cast1` is data like any other. With it at 0 the scroll is instant, as it was before the
  // channel existed — no channel to be invulnerable in, and no five seconds to wait.
  world = newWorld();
  const h = give(heroAt(6000, 6000), "stwq");
  hall(1000, 1000);
  world.useItem(h.id, 0, 0, h.x, h.y);
  at("with Cast1 = 0 it teleports on the press", h, 1000, 1000);
  check("…with no channel", h.portalLeft, 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
