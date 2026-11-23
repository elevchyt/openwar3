// `CreateDestructable` and its three twins MAKE a destructible. A record the World Editor left at
// exactly that spot is ADOPTED (a gate a script "creates" over its own placeholder); anywhere else
// the engine is asked for a NEW one (`EngineHooks.createDestructable`), with the native's own
// facing, scale and variation — and the …Z twins' height, which comes BEFORE the facing in
// common.j. It used to answer a handle on nothing, so a scenario that grows its forest at run time
// stood in an empty field, and every RemoveDestructable/KillDestructable on what it made did
// nothing either.
//
// Run: pnpm jass:test
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const { requireInstallScripts } = require("./jass-install-scripts.cjs");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".jass-build", "src", "jass");
require("node:fs").writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, "headless.js"));

const SCRIPTS = requireInstallScripts("common.j", "Blizzard.j");
const COMMON_J = readFileSync(join(SCRIPTS, "common.j"), "latin1");
const BLIZZARD_J = readFileSync(join(SCRIPTS, "Blizzard.j"), "latin1");

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// The stand-in engine: one placeholder gate the "editor" left at (100, 100); everything else
// is made on request and remembered, as MapViewerScene.spawnDestructible does.
const records = new Map([[7, { id: 7, typeId: "LTg1", name: "Gate", x: 100, y: 100, life: 500, maxLife: 500 }]]);
const made = [];
const log = [];
let next = 1 << 20;
const hooks = {
  findDestructable: (typeId, x, y) => (typeId === "LTg1" && x === 100 && y === 100 ? 7 : 0),
  createDestructable: (typeId, x, y, z, facing, scale, variation, dead) => {
    made.push([typeId, x, y, z, facing, scale, variation, dead]);
    const id = next++;
    records.set(id, { id, typeId, name: "Tree", x, y, life: dead ? 0 : 50, maxLife: 50 });
    return id;
  },
  destructableInfo: (id) => records.get(id) ?? null,
  killDestructable: (id) => { log.push(["kill", id]); records.get(id).life = 0; },
  removeDestructable: (id) => { log.push(["remove", id]); records.delete(id); },
};

const SRC = `
globals
    destructable made1 = null
    destructable madeZ = null
    destructable madeDead = null
    destructable gate = null
    real life1 = -1
    real x1 = -1
endglobals
function Setup takes nothing returns nothing
    set made1 = CreateDestructable( 'LTlt', 512.0, 256.0, 270.0, 1.2, 3 )
    set life1 = GetDestructableLife( made1 )
    set x1 = GetDestructableX( made1 )
    set madeZ = CreateDestructableZ( 'LTlt', 64.0, 32.0, 50.0, 90.0, 1.0, 0 )
    set madeDead = CreateDeadDestructable( 'LTlt', 640.0, 640.0, 0.0, 1.0, 1 )
    set gate = CreateDeadDestructable( 'LTg1', 100.0, 100.0, 0.0, 1.0, 0 )
    call RemoveDestructable( made1 )
endfunction
`;

const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
const g = (n) => interp.rt.globals.get(n)?.n;
interp.callFunction("Setup", []);

console.log("a destructible where the map placed none is MADE, with the native's arguments");
check("CreateDestructable: type, point, no height, facing, scale, variation, alive", made[0], ["LTlt", 512, 256, null, 270, 1.2, 3, false]);
check("…and its handle reads the new record's life", g("life1"), 50);
check("…and its position", g("x1"), 512);
check("CreateDestructableZ: the height comes before the facing", made[1], ["LTlt", 64, 32, 50, 90, 1, 0, false]);
check("CreateDeadDestructable: made dead", made[2], ["LTlt", 640, 640, null, 0, 1, 1, true]);

console.log("\na placeholder the editor left at the spot is adopted, not doubled");
check("the gate was not made a second time", made.length, 3);
check("…and CreateDeadDestructable kills the placeholder", log.some(([k, id]) => k === "kill" && id === 7), true);

console.log("\nwhat a script made is the script's to take away");
check("RemoveDestructable reaches the engine for a made one", log.some(([k, id]) => k === "remove" && id === 1 << 20), true);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall create-destructable checks passed");
process.exit(failed ? 1 : 0);
