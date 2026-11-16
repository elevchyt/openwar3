// SAVED GAMES (issue #159, docs/save-games.md) — a CAMPAIGN COMPUTER, round trip.
//
// A chapter's computer runs its own `.ai` (Human02's h02_red.ai) in a JASS VM of its own on the
// install's common.j + common.ai (src/ai/scriptAi.ts): a main loop that never returns, a thread
// per captain, and suicide waves that SLEEP for minutes inside functions called from expressions
// (`if not PrepSuicideOnPlayer(seconds)`). That is the hardest thread state a match holds, and it
// is held by an AI, not by the map.
//
// The test runs the computer against a stub world (the campaign AI test's), saves the computer
// and the world through the codec and real JSON at several moments, seats a FRESH computer on the
// same script (what a load does — the seat log), writes the save into it, and runs both on: the
// orders they give and their whole state must stay identical, wave after wave.
//
// Run: pnpm sim:test
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { requireInstallScripts } = require("./jass-install-scripts.cjs");
const REPO = join(__dirname, "..");
writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { ScriptAi } = require(join(REPO, ".sim-build", "src", "ai", "scriptAi.js"));
const { encodeGraph, decodeGraph, newEncodeStats } = require(join(REPO, ".sim-build", "src", "game", "save", "graph.js"));
const { registerSaveClasses } = require(join(REPO, ".sim-build", "src", "game", "save", "classes.js"));
registerSaveClasses();

let failed = 0;
function check(what, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
}

const SCRIPTS = requireInstallScripts("common.j", "common.ai", "h02_red.ai");
const read = (f) => readFileSync(join(SCRIPTS, f), "latin1");
const COMMON_J = read("common.j");
const COMMON_AI = read("common.ai");

// UnitBalance-shaped prices; only what the scripts and the loop read.
const DEFS = {
  ogre: { isBuilding: true, goldCost: 385, lumberCost: 185, foodUsed: 0, foodMade: 10, buildTime: 150 },
  obar: { isBuilding: true, goldCost: 180, lumberCost: 50, foodUsed: 0, foodMade: 0, buildTime: 60 },
  npgf: { isBuilding: true, goldCost: 80, lumberCost: 20, foodUsed: 0, foodMade: 8, buildTime: 35 },
  opeo: { isBuilding: false, goldCost: 75, lumberCost: 0, foodUsed: 1, foodMade: 0, buildTime: 15 },
  ogru: { isBuilding: false, goldCost: 200, lumberCost: 0, foodUsed: 3, foodMade: 0, buildTime: 30 },
  ohun: { isBuilding: false, goldCost: 135, lumberCost: 20, foodUsed: 2, foodMade: 0, buildTime: 20 },
  orai: { isBuilding: false, goldCost: 180, lumberCost: 40, foodUsed: 3, foodMade: 0, buildTime: 28 },
  htow: { isBuilding: true, goldCost: 385, lumberCost: 205, foodUsed: 0, foodMade: 12, buildTime: 180 },
  hbar: { isBuilding: true, goldCost: 160, lumberCost: 60, foodUsed: 0, foodMade: 0, buildTime: 60 },
  hhou: { isBuilding: true, goldCost: 80, lumberCost: 20, foodUsed: 0, foodMade: 6, buildTime: 35 },
  hpea: { isBuilding: false, goldCost: 75, lumberCost: 0, foodUsed: 1, foodMade: 0, buildTime: 15 },
  hfoo: { isBuilding: false, goldCost: 135, lumberCost: 0, foodUsed: 2, foodMade: 0, buildTime: 20 },
  hrif: { isBuilding: false, goldCost: 205, lumberCost: 30, foodUsed: 3, foodMade: 0, buildTime: 26 },
  hmtm: { isBuilding: false, goldCost: 180, lumberCost: 70, foodUsed: 3, foodMade: 0, buildTime: 35 },
  hmpr: { isBuilding: false, goldCost: 135, lumberCost: 10, foodUsed: 2, foodMade: 0, buildTime: 28 },
  Hamg: { isBuilding: false, isHero: true, goldCost: 425, lumberCost: 100, foodUsed: 5, foodMade: 0, buildTime: 55 },
};
const TRAINS = {
  ogre: ["opeo"], obar: ["ogru", "ohun", "orai"],
  htow: ["hpea"], hbar: ["hfoo", "hrif", "hmtm", "hmpr", "Hamg"],
};

/** A world: `units` is filled by the caller; `execute` produces instantly. */
function makeWorld(aiPlayer) {
  const units = new Map();
  const add = (owner, typeId, x, y) => {
    const def = DEFS[typeId];
    const u = {
      id: world.nextId++, owner, team: owner, typeId, hp: 400, maxHp: 400, mana: 0, maxMana: 0, x, y,
      speed: def.isBuilding ? 0 : 270, building: def.isBuilding ? { constructionLeft: 0, queue: [] } : null,
      worker: typeId === "opeo" || typeId === "hpea" ? { gold: true, lumber: true } : null,
      isHero: !!def.isHero, abilities: [], orderQueue: [], order: "idle", targetId: null, inCombat: false,
      amDestX: 0, amDestY: 0, weapons: [], inventory: [], isIllusion: false, summonLeft: 0,
      depotGold: typeId === "ogre" || typeId === "htow", depotLumber: typeId === "ogre" || typeId === "htow",
      resKind: "", resId: 0,
    };
    units.set(u.id, u);
    return u;
  };
  const stash = { gold: 20000, lumber: 20000 };
  const stashRef = stash;
  const orders = [];
  const world = {
    units, nextId: 1, stash: null, mines: new Map(), elapsed: 0, timeOfDay: 12, tech: null,
    stashOf: () => stash,
    nearestMine: () => null,
    nearestTrees: () => [],
    trees: new Map(),
    normalFormOf: (u) => u.typeId,
    hauntsMines: () => false,
    pendingTrained: () => [],
    fallenHeroesOf: () => [],
    techMeets: () => true,
    mergedIntoAncient: () => false,
    footprintBlighted: () => true,
  };
  const host = {
    world,
    registry: { get: (id) => DEFS[id] },
    abilities: { get: () => undefined },
    items: { get: () => undefined },
    tech: {
      get: (id) => ({ trains: TRAINS[id] ?? [], builds: [], sellunits: [], researches: [] }),
      trains: (id) => TRAINS[id] ?? [],
      builds: () => [],
      researches: () => [],
      produces: () => true,
      maxAllowed: () => -1,
    },
    upgrades: { cost: () => ({ gold: 0, lumber: 0 }) },
    execute: (player, cmd) => {
      if (cmd.c === "train") {
        const b = units.get(cmd.buildingId);
        const def = DEFS[cmd.unitId];
        if (!b || !def || stash.gold < def.goldCost) return false;
        stash.gold -= def.goldCost;
        add(player, cmd.unitId, b.x + 150, b.y - 150); // instant: the stub has no clock for it
        return true;
      }
      if (cmd.c === "order") {
        const u = units.get(cmd.unitId);
        orders.push({ player, unitId: cmd.unitId, ...cmd.order });
        if (u) {
          u.order = cmd.order.kind;
          if (cmd.order.kind === "attackmove") { u.amDestX = cmd.order.x; u.amDestY = cmd.order.y; }
          if (cmd.order.kind === "attack") u.targetId = cmd.order.targetId;
        }
        return true;
      }
      return false;
    },
    footprintOf: () => null,
    coAllied: (a, b) => a === b,
    creepCamps: () => [],
    visible: () => true,
    foodCeiling: () => 100,
  };
  const ai = new ScriptAi(host);
  const run = (seconds) => {
    for (let t = 0; t < seconds * 2; t++) {
      world.elapsed += 0.5;
      ai.tick(0.5);
    }
  };
  return { units, add, orders, ai, run, stash, world };
}


const AI = 3;
const USER = 1;
/** A world and its computer, as the chapter starts them. */
function chapter() {
  const w = makeWorld(AI);
  w.add(AI, "ogre", 0, 0);
  w.add(AI, "obar", 400, 0);
  w.add(AI, "opeo", -200, -200);
  w.add(AI, "ogru", 600, 600);
  w.add(AI, "ogru", 700, 600);
  w.add(USER, "htow", 9000, 9000);
  w.add(USER, "hbar", 9400, 9000);
  w.ai.add(AI, "h02_red.ai", "orc", 2, 0, 0, 1, { commonJ: COMMON_J, commonAi: COMMON_AI, script: read("h02_red.ai"), players: 12 }, null);
  return w;
}

/** What a save holds of it: the computer and the world it reads. */
const roots = (w) => ({ ai: w.ai, units: w.units, world: w.ai.host?.world ?? null, stash: w.stash, orders: w.orders });
const state = (w) => JSON.stringify(encodeGraph(roots(w))).replace(/\{"f":1\}/g, "null");

/** Kill every attacker that reaches the user's base, so the waves keep coming. */
function step(w, seconds) {
  for (let i = 0; i < seconds; i++) {
    w.run(1);
    for (const u of w.units.values()) if (u.owner === AI && !u.building && Math.hypot(u.x - 9000, u.y - 9000) < 3000) u.hp = 0;
    for (const o of w.orders) {
      const u = w.units.get(o.unitId);
      if (u && (o.kind === "attackmove" || o.kind === "move") && u.hp > 0) { u.x = o.x; u.y = o.y; }
    }
  }
}

const SAVES = [20, 95, 240, 400];
const END = 600;
for (const at of SAVES) {
  const a = chapter();
  step(a, at);
  const threads = a.ai.seats[0].interp.sleepingThreads;
  const stats = newEncodeStats();
  const json = JSON.stringify(encodeGraph(roots(a), {}, stats));
  check(`${at} s: the computer is mid-script (${threads} threads asleep)`, threads >= 2, String(threads));
  check(`${at} s: no unknown class`, stats.unregistered.size === 0, [...stats.unregistered].join(", "));
  const b = chapter(); // seated again on the same script — the seat log a load replays
  const report = { lost: [], missingExternals: [] };
  decodeGraph(JSON.parse(json), roots(b), {}, report);
  check(`${at} s: the load lost nothing`, report.lost.length === 0, report.lost.slice(0, 5).join("; "));
  check(`${at} s: the loaded computer equals the saved one`, state(a) === state(b));
  let parted = -1;
  for (let t = at + 1; t <= END && parted < 0; t++) {
    step(a, 1);
    step(b, 1);
    if (state(a) !== state(b)) parted = t;
  }
  check(`${at} s: both play on identically to ${END} s`, parted < 0, `parted at ${parted} s`);
  check(`${at} s: …giving ${a.orders.length} orders the same`, JSON.stringify(a.orders) === JSON.stringify(b.orders) && a.orders.length > 0);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
