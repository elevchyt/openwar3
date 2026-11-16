// SAVED GAMES (issue #159, docs/save-games.md) — the JASS VM, round trip.
//
// A saved game writes the map's script down mid-match: its globals, its handles, its triggers and
// timers, and above all its SLEEPING THREADS — a trigger parked in `TriggerSleepAction` inside a
// function called from a loop inside another function. Those are JS generators, which cannot be
// written; what is written is each thread's TRACE (interpreter.ts `TraceRec`), and a load starts
// the same generators again on it.
//
// What this pins: a script is run, saved at several moments — through real JSON, the way the file
// carries it — and loaded into a FRESH VM built from the same sources. Then both VMs are run on,
// step for step, and must stay the SAME VM: the whole runtime (encoded by the same codec, so every
// global, array slot, handle and timer is compared) and everything the script SAID agree at every
// step after the load. Every kind of place a thread can be parked is visited: a wait deep in nested
// calls with locals and a local array, mid-loop, inside a function called from an EXPRESSION (`set
// x = Slow(3) + 1`, the left operand of a binary already taken), in an `if` body, in an `else`, in
// a timer handler, in a trigger's second action, `PolledWait` (blizzard.j's own loop over a timer),
// an `ExecuteFunc` adopted after its wait, and a thread that inherits its event responses across a
// wait (`GetTriggeringTrigger()` after the wait, the editor's queue idiom). The random stream is
// part of it: the loaded VM must roll the same numbers.
//
// And because a test like this passes on a VM where nothing happens, it asserts the script really
// was parked in each of those places when it was saved, and that a deliberately damaged save (one
// thread's wake time moved) is CAUGHT by the comparison.
//
// Run: pnpm sim:test
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { requireInstallScripts } = require("./jass-install-scripts.cjs");
const REPO = join(__dirname, "..");
writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const B = (...p) => require(join(REPO, ".sim-build", "src", ...p));
const { Interpreter } = B("jass", "interpreter.js");
const { Runtime } = B("jass", "runtime.js");
const { parseJass } = B("jass", "parser.js");
const { registerNatives } = B("jass", "natives", "index.js");
const { encodeGraph, decodeGraph, newEncodeStats } = B("game", "save", "graph.js");
const { registerSaveClasses } = B("game", "save", "classes.js");

registerSaveClasses();

let failed = 0;
function check(what, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
}

const SCRIPTS = requireInstallScripts("common.j", "Blizzard.j");
const COMMON_J = readFileSync(join(SCRIPTS, "common.j"), "latin1");
const BLIZZARD_J = readFileSync(join(SCRIPTS, "Blizzard.j"), "latin1");

const MAP_J = `
globals
    integer array log_n
    integer logged = 0
    integer counter = 0
    integer exprResult = -1
    real rolled = 0.
    trigger queueTrig = null
    trigger twoActs = null
    timer tick = null
    integer ticks = 0
    string lastSeen = ""
    boolean elseRan = false
endglobals

function Say takes integer n returns nothing
    set log_n[logged] = n
    set logged = logged + 1
    call DisplayTextToPlayer(Player(0), 0, 0, I2S(n))
endfunction

// Parked three calls deep, with a local and a local array that must survive the load.
function Inner takes integer a returns integer
    local integer b = a * 2
    local integer array c
    set c[3] = b + 1
    call TriggerSleepAction(1.5)
    call Say(c[3])
    return c[3] + a
endfunction

function Middle takes integer a returns integer
    local integer r = Inner(a + 1)
    call Say(r)
    return r
endfunction

function Outer takes nothing returns nothing
    local integer i = 0
    loop
        exitwhen i >= 4
        call Say(100 + i)
        call TriggerSleepAction(0.7)
        set i = i + 1
    endloop
    call Say(Middle(5))
endfunction

// A function called from an EXPRESSION that sleeps: the left operand is already evaluated.
function Slow takes integer n returns integer
    call TriggerSleepAction(2.25)
    return n * 10
endfunction

function ExprThread takes nothing returns nothing
    local integer left = 7
    set exprResult = left + Slow(3) + GetRandomInt(1, 1000)
    call Say(exprResult)
endfunction

function IfThread takes nothing returns nothing
    if GetRandomInt(0, 1) >= 0 then
        call TriggerSleepAction(3.1)
        call Say(301)
    endif
    if counter > 999 then
        call Say(-1)
    else
        call TriggerSleepAction(1.2)
        set elseRan = true
        call Say(302)
    endif
endfunction

function OnTick takes nothing returns nothing
    set ticks = ticks + 1
    set rolled = rolled + GetRandomReal(0, 1)
    if ModuloInteger(ticks, 3) == 0 then
        call TriggerSleepAction(0.4)
        call Say(500 + ticks)
    endif
endfunction

function ActOne takes nothing returns nothing
    call Say(600)
endfunction

function ActTwo takes nothing returns nothing
    call TriggerSleepAction(2.0)
    // the editor's own post-wait idiom: the triggering trigger survives the wait
    if GetTriggeringTrigger() == twoActs then
        call Say(601)
    endif
endfunction

function Polled takes nothing returns nothing
    call PolledWait(4.0)
    call Say(700)
endfunction

function Adopted takes nothing returns nothing
    call TriggerSleepAction(1.0)
    call Say(800)
endfunction

function Counter takes nothing returns nothing
    loop
        set counter = counter + 1
        call TriggerSleepAction(0.25)
    endloop
endfunction

function main takes nothing returns nothing
    set tick = CreateTimer()
    call TimerStart(tick, 0.5, true, function OnTick)
    set twoActs = CreateTrigger()
    call TriggerAddAction(twoActs, function ActOne)
    call TriggerAddAction(twoActs, function ActTwo)
    call TriggerRegisterTimerEvent(twoActs, 1.0, false)
    call ExecuteFunc("Outer")
    call ExecuteFunc("ExprThread")
    call ExecuteFunc("IfThread")
    call ExecuteFunc("Polled")
    call ExecuteFunc("Adopted")
    call ExecuteFunc("Counter")
endfunction
`;

/** A fresh VM on the three sources, as the scene builds one — globals initialised, main() NOT run. */
function build(said) {
  const rt = new Runtime(12345);
  rt.gameType = 4;
  rt.hooks = { displayText: (_p, msg) => said.push(`${rt.gameTime.toFixed(4)} ${msg}`) };
  registerNatives(rt);
  const interp = new Interpreter(rt);
  for (const src of [COMMON_J, BLIZZARD_J, MAP_J]) interp.load(parseJass(src));
  interp.initGlobals();
  return { rt, interp };
}

const DT = 1 / 60;
const step = (vm) => vm.interp.advanceTime(DT);

/** The runtime as the codec writes it — the strictest comparison there is: every global, every
 *  array slot, every handle, every timer, in order. */
const state = (vm) => JSON.stringify(encodeGraph({ script: vm.interp }));

/** Where two `state` strings first disagree, for the failure line. */
function firstDiff(x, y) {
  const a = JSON.parse(x).nodes, b = JSON.parse(y).nodes;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const p = JSON.stringify(a[i]), q = JSON.stringify(b[i]);
    if (p !== q) {
      let k = 0;
      while (k < Math.min(p?.length ?? 0, q?.length ?? 0) && p[k] === q[k]) k++;
      return `node ${i}: …${p?.slice(Math.max(0, k - 120), k + 80)}  vs  …${q?.slice(Math.max(0, k - 120), k + 80)}`;
    }
  }
  return "";
}

function save(vm) {
  const stats = newEncodeStats();
  const doc = encodeGraph({ script: vm.interp }, {}, stats);
  return { json: JSON.stringify(doc), stats };
}

function load(json, said) {
  const vm = build(said);
  const report = { lost: [], missingExternals: [] };
  const out = decodeGraph(JSON.parse(json), { script: vm.interp }, {}, report);
  return { vm, report, root: out };
}

if (process.env.SAVE_DBG) {
  const fs = require("node:fs");
  const saidA = [];
  const a = build(saidA);
  a.interp.run("main");
  for (let s = 1; s <= Number(process.env.SAVE_DBG); s++) step(a);
  const { vm: b } = load(save(a).json, []);
  const dump = (vm) => JSON.stringify(encodeGraph({ script: vm.interp }).nodes).replace(/\},\{"t"/g, '},\n{"t"');
  fs.writeFileSync(process.env.SAVE_DBG_OUT + "/a.json", dump(a));
  fs.writeFileSync(process.env.SAVE_DBG_OUT + "/b.json", dump(b));
  process.exit(0);
}

// ---- run the original, saving at several moments ------------------------------------------------
const CHECKPOINTS = [30, 95, 140, 200, 250, 330];
const END = 600;
const saidA = [];
const a = build(saidA);
a.interp.run("main");
const saves = new Map();
for (let s = 1; s <= END; s++) {
  step(a);
  if (CHECKPOINTS.includes(s)) saves.set(s, { ...save(a), said: saidA.length, threads: a.interp.sleepingThreads });
}

// Every checkpoint caught threads parked — the test must not pass on an idle VM.
for (const [s, sv] of saves) check(`step ${s}: ${sv.threads} threads parked when saved`, sv.threads >= (s >= 330 ? 1 : 2), `${sv.threads}`);
const first = saves.get(CHECKPOINTS[0]);
check("the codec met no class it does not know", first.stats.unregistered.size === 0, [...first.stats.unregistered].join(", "));
check("…and no function it would have to drop", first.stats.functions.every((p) => /\.(onWatchedGlobal|random|inputTap)$/.test(p)), first.stats.functions.join(", "));
check("the script really reached every waiting place", ["101", "102", "103", "13", "19", "301", "302", "601", "700", "800"].every((n) => saidA.some((l) => l.endsWith(` ${n}`))), saidA.join(" | "));

// ---- load each save into a fresh VM and run both on --------------------------------------------
for (const s of CHECKPOINTS) {
  const sv = saves.get(s);
  const saidB = saidA.slice(0, sv.said);
  const { vm: b, report } = load(sv.json, saidB);
  check(`step ${s}: the load lost nothing`, report.lost.length === 0 && report.missingExternals.length === 0, [...report.lost, ...report.missingExternals].slice(0, 5).join("; "));
  // A second, independent original from scratch to the same step — so the comparison is against a
  // VM that was never saved at all.
  const saidC = [];
  const c = build(saidC);
  c.interp.run("main");
  for (let i = 1; i <= s; i++) step(c);
  check(`step ${s}: the loaded VM equals the original at the moment of the load`, state(b) === state(c), firstDiff(state(b), state(c)));
  let parted = -1;
  for (let i = s + 1; i <= END && parted < 0; i++) {
    step(b);
    step(c);
    if (state(b) !== state(c)) parted = i;
  }
  check(`step ${s}: loaded and original stay identical to step ${END}`, parted < 0, `parted at step ${parted}`);
  check(`step ${s}: and said the same things`, JSON.stringify(saidB) === JSON.stringify(saidC), `${saidB.slice(-3).join(" | ")}  vs  ${saidC.slice(-3).join(" | ")}`);
}

// ---- the comparison bites: a damaged save parts --------------------------------------------------
{
  const sv = saves.get(95);
  const doc = JSON.parse(sv.json);
  // Find a saved thread's wake time and move it a second later.
  let moved = false;
  for (const n of doc.nodes) {
    if (!moved && n && n.t === "o" && n.p && typeof n.p.wakeAt === "number" && "recs" in n.p) {
      n.p.wakeAt += 1;
      moved = true;
    }
  }
  const saidB = saidA.slice(0, sv.said);
  const { vm: b } = load(JSON.stringify(doc), saidB);
  const saidC = [];
  const c = build(saidC);
  c.interp.run("main");
  for (let i = 1; i <= 95; i++) step(c);
  let parted = false;
  for (let i = 96; i <= END && !parted; i++) {
    step(b);
    step(c);
    parted = state(b) !== state(c);
  }
  check("a save with one thread's wake time moved is caught", moved && parted);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
