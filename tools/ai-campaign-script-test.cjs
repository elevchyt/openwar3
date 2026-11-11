// A CAMPAIGN computer on its chapter's own `.ai` (src/ai/scriptAi.ts, docs/melee-ai.md "A map's
// own AI").
//
// A chapter seats its computers with `StartCampaignAI(p, "h02_red.ai")` (or, in several Frozen
// Throne chapters, `StartMeleeAI(p, "h02x03.ai")`) — 207 scripts in the install's `Scripts\`, all
// written on common.ai's campaign library: `CampaignAI`, `CampaignDefenderEx`, `InitAssaultGroup`
// + `CampaignAttackerEx`, then `SuicideOnPlayer` once per wave. What is pinned here, on the REAL
// files against the install's own common.j and common.ai:
//
//   · a function called from an EXPRESSION may sleep (`if not PrepSuicideOnPlayer(seconds)`,
//     `exitwhen SuicidePlayer(p, …)`) — before the AI VM's evalG every wave "failed" at once;
//   · `total_gold` is written by the native OneBuildLoop, so `BuildAttackers` (another thread)
//     trains the wave;
//   · the DEFENSE captain holds the `CampaignDefender` rows and answers a raid on the town;
//   · `SuicidePlayer` sends the formed wave at the user's base and the next wave forms once it
//     is dead;
//   · GUARD POSTS: a preplaced unit holds one, `RemoveGuardPosition` ("ignore") takes it out of
//     the AI's hands and `IgnoredUnits` then counts it;
//   · `WaitForSignal()` holds a chapter's AI until the map's `CommandAI` (Orc03's o03_blue.ai).
//
// The world is a stub with instant production. What the build loop does with a real world is the
// melee AI's business and is pinned by its own tests.
//
// Run: pnpm sim:test
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { requireInstallScripts } = require("./jass-install-scripts.cjs");
const REPO = join(__dirname, "..");
writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { ScriptAi } = require(join(REPO, ".sim-build", "src", "ai", "scriptAi.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const SCRIPTS = requireInstallScripts("common.j", "common.ai", "h02_red.ai", "o03_blue.ai");
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
  let nextId = 1;
  const add = (owner, typeId, x, y) => {
    const def = DEFS[typeId];
    const u = {
      id: nextId++, owner, team: owner, typeId, hp: 400, maxHp: 400, mana: 0, maxMana: 0, x, y,
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
  const orders = [];
  const world = {
    units, mines: new Map(), elapsed: 0, timeOfDay: 12, tech: null,
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
  return { units, add, orders, ai, run, stash };
}

const alive = (units, owner, typeId) => [...units.values()].filter((u) => u.owner === owner && u.hp > 0 && u.typeId === typeId);

// =================================================================================================
console.log("Human02 — h02_red.ai: the Blackrock clan's defenders, guards and suicide waves");
{
  const AI = 3; // udg_P_Blackrock; the script's own `user` is Player(1)
  const USER = 1;
  const w = makeWorld(AI);
  w.add(AI, "ogre", 0, 0);
  w.add(AI, "obar", 400, 0);
  w.add(AI, "opeo", -200, -200);
  const guard = w.add(AI, "ogru", 600, 600); // a preplaced Grunt: it gets a guard post
  const ignoredGrunt = w.add(AI, "ogru", 700, 600);
  const userHall = w.add(USER, "htow", 9000, 9000);
  w.add(USER, "hbar", 9400, 9000);

  w.ai.add(AI, "h02_red.ai", "orc", 2, 0, 0, 1, { commonJ: COMMON_J, commonAi: COMMON_AI, script: read("h02_red.ai"), players: 12 }, null);
  const seat = w.ai.seats[0];
  check("the chapter's script is seated and main() ran", !!seat, true);
  const vm = seat.interp;
  check("CampaignAI read the game difficulty (NORMAL = 2)", vm.rt.globals.get("difficulty").n, 2);
  check("…and set SetGroupsFlee(false) on the attack captain", seat.captain.groupsFlee, false);

  console.log("\nguard posts");
  check("both preplaced Grunts hold a post where they stand", seat.guards.posts.map((p) => [p.typeId, p.x, p.y]), [["ogru", 600, 600], ["ogru", 700, 600]]);
  check("the peon does not (\"no effect on Heroes and peon-type units\")", seat.guards.posts.some((p) => p.typeId === "opeo"), false);
  w.ai.guardPosition(ignoredGrunt.id, "ignore"); // RemoveGuardPosition(gg_unit_ogru_…)
  check("RemoveGuardPosition: the post is gone, the unit is IGNORED", [seat.guards.posts.length, seat.heldBy(ignoredGrunt.id)], [1, "ignored"]);
  check("IgnoredUnits('ogru') counts it — common.ai trains past it", vm.callFunction("IgnoredUnits", [{ k: "int", n: 0x6f677275 }]).n, 1);
  const ohun = { k: "int", n: 0x6f68756e };

  console.log("\nthe defense captain (CampaignDefenderEx rows → BuildDefenders → AddDefenders)");
  w.run(12);
  // (main() is parked in CampaignAI's own Sleep(0.1) until the first tick.)
  check("SetReplacements(0,1,3) at NORMAL → one refill per post", seat.guards.replacements, 1);
  const defenders = [...seat.defense.members].map((id) => w.units.get(id).typeId).sort();
  // CampaignDefenderEx(1,1,1, GRUNT) is also a SetBuildUnit(1, GRUNT) row, which the preplaced
  // Grunts already satisfy (TownCount counts them) — and a guard stays at its post rather than
  // joining the defense. The Head Hunter row is trained and held.
  check("NORMAL: the Head Hunter is trained and held at home", defenders, ["ohun"]);
  check("the ignored Grunt is in no group", seat.heldBy(ignoredGrunt.id), "ignored");
  const raider = w.add(USER, "hfoo", 900, 300); // a Footman walks into the town
  w.run(3);
  const answered = w.orders.filter((o) => seat.defense.members.has(o.unitId) && o.kind === "attackmove" && Math.hypot(o.x - 900, o.y - 300) < 50);
  check("a raider in the town is attack-moved at by the defenders", answered.length >= 1, true);
  check("IgnoredUnits counts a DEFENDER too, so a wave that wants one trains its own", vm.callFunction("IgnoredUnits", [ohun]).n, 1);
  check("CaptainInCombat(false) asks after the DEFENSE captain", vm.callFunction("CaptainInCombat", [{ k: "bool", b: false }]).b === seat.defense.inCombat(), true);
  raider.hp = 0;

  console.log("\nwave 1: InitAssaultGroup, CampaignAttackerEx(2,2,2, GRUNT), (1,1,2, HEAD_HUNTER), SuicideOnPlayer(M2, user)");
  check("before its two minutes are up nothing has been sent at the user", w.orders.some((o) => o.kind === "attackmove" && Math.hypot(o.x - userHall.x, o.y - userHall.y) < 600), false);
  check("…but BuildAttackers (another thread) is training it: total_gold is written", vm.rt.globals.get("total_gold").n > 0, true);
  w.run(150);
  const wave = [...seat.captain.members].map((id) => w.units.get(id));
  check("the wave formed: two Grunts and a Head Hunter", wave.map((u) => u.typeId).sort(), ["ogru", "ogru", "ohun"]);
  check("…none of them a defender", wave.some((u) => seat.defense.members.has(u.id)), false);
  const sent = w.orders.filter((o) => seat.captain.members.has(o.unitId) && (o.kind === "attackmove" || o.kind === "attack"));
  // The nearest of the user's buildings to the wave is the Town Hall (the Barracks is further out).
  check("SuicidePlayer sent every member at the user's base (their nearest building)", new Set(sent.map((o) => o.unitId)).size === wave.length && sent.every((o) => Math.hypot(o.x - userHall.x, o.y - userHall.y) < 600), true);
  check("a suicide wave does not turn back", seat.captain.retreating, false);

  console.log("\nthe wave dies; wave 2 forms and goes");
  const firstWave = new Set(seat.captain.members);
  for (const id of firstWave) w.units.get(id).hp = 0;
  w.run(150);
  const second = [...seat.captain.members].filter((id) => !firstWave.has(id));
  check("a second wave of new units has formed", second.length >= 3, true);
  check("…and has been sent at the user too", w.orders.some((o) => second.includes(o.unitId) && o.kind === "attackmove" && Math.hypot(o.x - userHall.x, o.y - userHall.y) < 600), true);
  check("the preplaced Grunt's post is still held, or was refilled", seat.guards.posts.length, 1);
  void guard;
}

// =================================================================================================
console.log("\nOrc03 — o03_blue.ai: the Alliance base WAITS for the map's signal");
{
  const AI = 1;
  const USER = 0; // `player user = Player(0)`
  const w = makeWorld(AI);
  w.add(AI, "htow", 0, 0);
  w.add(AI, "hbar", 400, 0);
  for (let i = 0; i < 3; i++) w.add(AI, "hpea", -200 - 50 * i, -200);
  const userHall = w.add(USER, "ogre", -9000, 9000);
  w.ai.add(AI, "o03_blue.ai", "human", 2, 0, 0, 7, { commonJ: COMMON_J, commonAi: COMMON_AI, script: read("o03_blue.ai"), players: 12 }, null);
  const seat = w.ai.seats[0];
  w.run(120);
  check("defenders are built and held while it waits", seat.defense.members.size > 0, true);
  check("WaitForSignal(): no wave has been sent without the map's command", w.orders.some((o) => Math.hypot(o.x - userHall.x, o.y - userHall.y) < 600), false);
  w.ai.command(AI, 0, 0); // Orc03's trigger: CommandAI(Player(1), 0, 0)
  w.run(90);
  check("CommandAI(p, 0, 0) released it: wave 1 (SuicideOnPlayer(0, user)) is on its way", w.orders.some((o) => seat.captain.members.has(o.unitId) && o.kind === "attackmove" && Math.hypot(o.x - userHall.x, o.y - userHall.y) < 600), true);
  check("…and the stack was popped", seat.commands.length, 0);
}

console.log(failed ? `\nai-campaign-script: ${failed} FAILED` : "\nai-campaign-script: all checks passed");
process.exit(failed ? 1 : 0);
