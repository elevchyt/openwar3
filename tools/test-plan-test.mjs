// Guards the step plan behind `pnpm test` (tools/test.mjs).
//
// The runner's only real decision is which steps to skip: the data-backed suites
// cannot run without `pnpm data:extract`, and the desktop checks need `dist/`.
// Getting that wrong either fails a fresh clone for no reason or silently claims
// a suite ran. Run this after touching the runner:
//
//   node tools/test-plan-test.mjs

import assert from "node:assert/strict";
import { buildPlan } from "./test.mjs";

const names = (plan) => plan.map((step) => step.name);
const skipped = (plan) => plan.filter((step) => step.skip).map((step) => step.name);

const everything = { hasDist: true, hasData: true, hasSimBuild: true };
const freshClone = { hasDist: false, hasData: false, hasSimBuild: false };

// Order: cheap checks first, then sim before jass (jass builds on the sim
// output) and sim before relay (its loopback half imports the compiled link).
assert.deepEqual(names(buildPlan(everything)), [
  "typecheck",
  "cycles",
  "sim:test",
  "jass:test",
  "relay:test",
  "app:test",
]);

// Everything available: nothing is skipped.
assert.deepEqual(skipped(buildPlan(everything)), []);

// A fresh clone: only the two checks that need nothing local can run.
assert.deepEqual(names(buildPlan(freshClone).filter((s) => !s.skip)), ["typecheck", "cycles"]);
assert.deepEqual(skipped(buildPlan(freshClone)), ["sim:test", "jass:test", "relay:test", "app:test"]);

// The dependencies are independent of each other.
assert.deepEqual(skipped(buildPlan({ ...everything, hasDist: false })), ["app:test"]);
assert.deepEqual(skipped(buildPlan({ ...everything, hasData: false })), ["sim:test", "jass:test"]);
assert.deepEqual(skipped(buildPlan({ ...everything, hasSimBuild: false })), ["relay:test"]);

// A skipped step says why, and names the command that unskips it.
const byName = (plan, name) => plan.find((s) => s.name === name);
assert.match(byName(buildPlan({ ...everything, hasData: false }), "sim:test").reason, /pnpm data:extract/);
assert.match(byName(buildPlan({ ...everything, hasDist: false }), "app:test").reason, /pnpm build/);
assert.match(byName(buildPlan({ ...everything, hasSimBuild: false }), "relay:test").reason, /pnpm sim:test/);

// No step is ever skipped without a reason.
for (const step of buildPlan(freshClone)) {
  if (step.skip) assert.ok(step.reason && step.reason.length > 0, `${step.name} skipped without a reason`);
}

console.log("test-plan: ok");
