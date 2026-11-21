// Guards the step plan behind `pnpm test` (tools/test.mjs).
//
// The runner's only real decision is which steps to skip: the data-backed suites
// cannot run without `pnpm data:extract`, and the desktop checks need `dist/`.
// Getting that wrong either fails a fresh clone for no reason or silently claims
// a suite ran. Run this after touching the runner:
//
//   node tools/test-plan-test.mjs   (also the `test-plan` step of `pnpm test`)

import assert from "node:assert/strict";
import { buildPlan } from "./test.mjs";

const names = (plan) => plan.map((step) => step.name);
const skipped = (plan) => plan.filter((step) => step.skip).map((step) => step.name);

const everything = { hasDist: true, hasData: true };
const freshClone = { hasDist: false, hasData: false };

// Order: cheap checks first, then the suites. relay:test compiles what it imports
// itself, so it needs neither sim:test ahead of it nor the extracted data.
assert.deepEqual(names(buildPlan(everything)), [
  "typecheck",
  "cycles",
  "test-plan",
  "relay:test",
  "sim:test",
  "jass:test",
  "app:test",
]);

// Everything available: nothing is skipped.
assert.deepEqual(skipped(buildPlan(everything)), []);

// A fresh clone: everything that needs nothing local runs — the relay included.
assert.deepEqual(names(buildPlan(freshClone).filter((s) => !s.skip)), ["typecheck", "cycles", "test-plan", "relay:test"]);
assert.deepEqual(skipped(buildPlan(freshClone)), ["sim:test", "jass:test", "app:test"]);

// The dependencies are independent of each other.
assert.deepEqual(skipped(buildPlan({ ...everything, hasDist: false })), ["app:test"]);
assert.deepEqual(skipped(buildPlan({ ...everything, hasData: false })), ["sim:test", "jass:test"]);

// A skipped step says why, and names the command that unskips it.
const byName = (plan, name) => plan.find((s) => s.name === name);
assert.match(byName(buildPlan({ ...everything, hasData: false }), "sim:test").reason, /pnpm data:extract/);
assert.match(byName(buildPlan({ ...everything, hasDist: false }), "app:test").reason, /pnpm build/);

// No step is ever skipped without a reason.
for (const step of buildPlan(freshClone)) {
  if (step.skip) assert.ok(step.reason && step.reason.length > 0, `${step.name} skipped without a reason`);
}

console.log("test-plan: ok");
