// A computer on its MAP'S OWN `.ai` script (src/ai/scriptAi.ts, docs/melee-ai.md "A map's own AI").
//
// (4)Monolith seats its four "Monolithic Creeps" players with `StartMeleeAI(p,
// "war3mapImported\Murloc_AI.ai")` and seven like it — World-Editor AI scripts imported into the
// map. Before this they were handed Blizzard's night-elf melee AI, built nothing a Murloc can
// build, and finished every match with their 1000 starting gold untouched. What is pinned here is
// the machinery that makes the REAL file run, against the install's own common.j and common.ai:
//
//   · the AI VM's two thread natives — `StartThread` returns to its caller (main() reaches
//     PlayGame past two never-ending loops) and `Sleep` parks on game time;
//   · `GetPlayers()` answers the map's player count — common.ai's StaggerSleep divides by it, and
//     the unimplemented native's 0 parked every AI thread for ever;
//   · common.ai's `OneBuildLoop` is answered by the ported build loop, fed the `build_*` rows the
//     script wrote in JASS — so the first row the Murloc AI asks for (`n00A`, its worker) is
//     trained at the Monolith;
//   · `CommandAI` lands on the command stack the script reads (`GetLastCommand() == 1` is the
//     editor condition "Attack Enemy").
//
// The world is a stub: one Monolith, one worker, a bank. What the build loop does with a real
// world is the melee AI's own business and is pinned by its own tests.
//
// Run: pnpm sim:test
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
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

const SCRIPTS = requireInstallScripts("common.j", "common.ai");
const MAP = join(REPO, "Warcraft III", "Maps", "FrozenThrone", "Scenario", "(4)Monolith.w3x");
if (!existsSync(MAP)) {
  console.log("skip: (4)Monolith.w3x is not in this install");
  process.exit(0);
}
const mpqMod = require("mdx-m3-viewer/dist/cjs/parsers/mpq");
const Archive = (mpqMod.default ?? mpqMod).Archive;
const buf = readFileSync(MAP);
const bytes = new Uint8Array(buf.byteLength);
bytes.set(buf);
const archive = new Archive();
archive.load(bytes, true);
const latin1 = (b) => new TextDecoder("windows-1252").decode(b);
const script = latin1(archive.get("war3mapImported\\Murloc_AI.ai").bytes());
const sources = {
  commonJ: readFileSync(join(SCRIPTS, "common.j"), "latin1"),
  commonAi: readFileSync(join(SCRIPTS, "common.ai"), "latin1"),
  script,
  players: 8, // (4)Monolith's own SetPlayers(8)
};

// --- a stub world: P4's Monolith (which trains the Murloc worker, `n00A`) and one worker -------
const PLAYER = 4;
const monolith = {
  id: 1, owner: PLAYER, team: 1, typeId: "o000", hp: 1500, maxHp: 1500, x: 0, y: 0, speed: 0,
  building: { constructionLeft: 0, queue: [] }, worker: null, isHero: false, abilities: [], orderQueue: [],
  depotGold: true, depotLumber: true,
};
const slave = {
  id: 2, owner: PLAYER, team: 1, typeId: "n00A", hp: 200, maxHp: 200, x: 100, y: 100, speed: 270,
  building: null, worker: { gold: true, lumber: false }, isHero: false, abilities: [], orderQueue: [],
  order: "idle", resKind: "", resId: 0,
};
const units = new Map([[1, monolith], [2, slave]]);
const stash = { gold: 1000, lumber: 4 };
const DEFS = {
  o000: { isBuilding: true, goldCost: 0, lumberCost: 0, foodUsed: 0, foodMade: 10 },
  n00A: { isBuilding: false, goldCost: 75, lumberCost: 0, foodUsed: 1, foodMade: 0 },
  O00C: { isBuilding: false, isHero: true, goldCost: 425, lumberCost: 100, foodUsed: 5, foodMade: 0 },
};
const executed = [];
const world = {
  units, mines: new Map(), elapsed: 0, timeOfDay: 12, tech: null,
  stashOf: () => stash,
  nearestMine: () => null,
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
    get: (id) => ({ trains: id === "o000" ? ["n00A", "nmrl", "nmrr", "nmrm", "nmmu", "O00C"] : [], builds: [], sellunits: [], researches: [] }),
    trains: (id) => (id === "o000" ? ["n00A", "nmrl", "nmrr", "nmrm", "nmmu", "O00C"] : []),
    builds: () => [],
    researches: () => [],
    produces: () => true,
    maxAllowed: () => -1,
  },
  upgrades: { cost: () => ({ gold: 0, lumber: 0 }) },
  execute: (player, cmd) => {
    executed.push({ player, ...cmd });
    if (cmd.c === "train") units.get(cmd.buildingId)?.building.queue.push({ kind: "train", unitId: cmd.unitId });
    return true;
  },
  footprintOf: () => null,
  coAllied: (a, b) => a === b,
  creepCamps: () => [],
  visible: () => true,
  foodCeiling: () => 100,
};

const ai = new ScriptAi(host);
ai.add(PLAYER, "war3mapImported\\Murloc_AI.ai", "nightelf", 1, 0, 0, 1, sources, null);
const seat = ai.seats[0];
check("the script's VM is up and main() ran", !!seat, true);
if (!seat) process.exit(1);
const vm = seat.interp;

console.log("\nthreads: StartThread returns to its caller, Sleep parks on game time");
// main(): InitAI … Sleep(0.1) … StartThread(WorkerAssignment), StartThread(AttackAssignment),
// PlayGame() → StartBuildLoop (a third StartThread) → SleepForever. All four must be parked.
for (let i = 0; i < 4; i++) ai.tick(0.05);
const labels = vm.threads.map((t) => t.label).sort();
check("main() reached PlayGame past two never-ending loops (four parked threads)", labels, [
  "StartThread:AttackAssignment", "StartThread:BuildLoop", "StartThread:WorkerAssignment", "main",
]);
check("…and every one of them is parked on a FINITE wake time (GetPlayers answered)", vm.threads.every((t) => Number.isFinite(t.wakeAt)), true);
check("GetPlayers() is the map's SetPlayers", vm.callFunction("GetPlayers", []).n, 8);

console.log("\nthe build loop: the script's rows, the ported loop");
for (let i = 0; i < 80; i++) ai.tick(0.05); // 4 s: WorkerAssignment has filled the array, BuildLoop has run
const trains = executed.filter((e) => e.c === "train").map((e) => `${e.buildingId}:${e.unitId}`);
check("the build_* arrays are the script's (row 0 is the Monolith, row 1 its worker)", [
  vm.rt.globalArrays.get("build_item").get(0).n, vm.rt.globalArrays.get("build_item").get(1).n,
], [0x6f303030, 0x6e303041]);
check("…and the first thing the Murloc AI trains is a worker, at its Monolith", trains[0], "1:n00A");

console.log("\nCommandAI lands on the stack the script reads");
const cond = () => vm.rt.globals.get("gCond_Attack_Enemy").b;
check("no command yet: the 'Attack Enemy' condition is false", cond(), false);
ai.command(PLAYER, 1, 0);
for (let i = 0; i < 60; i++) ai.tick(0.05);
check("CommandAI(p, 1, 0) → GetLastCommand() == 1 → the condition the editor wrote is true", cond(), true);
ai.command(5, 1, 0); // a seat with no script AI behind it: nothing to read it with, nothing breaks
check("a command for a player with no script AI is dropped quietly", seat.commands.length, 1);

console.log(failed ? `\nai-script: ${failed} FAILED` : "\nai-script: all checks passed");
process.exit(failed ? 1 : 0);
