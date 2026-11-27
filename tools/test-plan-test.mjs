// Guards the step plan behind `pnpm test` (tools/test.mjs) and the suite runner behind
// `sim:test`/`jass:test`/`relay:test`/`app:test` (tools/run-tests.mjs, tools/tests.mjs).
//
// The runners' only real decision is which steps to skip: the data-backed checks cannot run
// without `pnpm data:extract`, the install checks without `Warcraft III/`, and the desktop checks
// need `dist/`. Getting that wrong either fails a fresh clone for no reason or silently claims a
// check ran. It also fails if a `tools/*-test.*` file is run by nothing at all (issue #394 found
// one). Run this after touching either runner or the manifest:
//
//   node tools/test-plan-test.mjs   (also the `test-plan` step of `pnpm test`)

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPlan } from "./test.mjs";
import { planSuites, commandFor } from "./run-tests.mjs";
import { SUITES, entry } from "./tests.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const names = (plan) => plan.map((step) => step.name);
const skipped = (plan) => plan.filter((step) => step.skip).map((step) => step.name);

const everything = { hasDist: true, hasData: true, hasInstall: true, hasWeb: true };
const freshClone = { hasDist: false, hasData: false, hasInstall: false, hasWeb: false };

// ── pnpm test ─────────────────────────────────────────────────────────────────────────────

// Order: cheap checks first, then the suites, then the install-backed checks.
assert.deepEqual(names(buildPlan(everything)), [
  "typecheck",
  "cycles",
  "test-plan",
  "web:typecheck",
  "relay:test",
  "sim:test",
  "jass:test",
  "app:test",
  "data:verify",
  "versions:test",
  "casc:test",
  "jass:coverage",
  "map:compat:test",
  "campaign:test",
]);

// Everything available: nothing is skipped.
assert.deepEqual(skipped(buildPlan(everything)), []);

// A fresh clone (and CI): sim:test and jass:test still run — their runner drops only the tests
// that need the data.
assert.deepEqual(names(buildPlan(freshClone).filter((s) => !s.skip)), [
  "typecheck",
  "cycles",
  "test-plan",
  "relay:test",
  "sim:test",
  "jass:test",
]);

// Each dependency gates only its own steps.
assert.deepEqual(skipped(buildPlan({ ...everything, hasDist: false })), ["app:test"]);
assert.deepEqual(skipped(buildPlan({ ...everything, hasWeb: false })), ["web:typecheck"]);
assert.deepEqual(skipped(buildPlan({ ...everything, hasData: false })), [
  "data:verify",
  "versions:test",
  "jass:coverage",
  "map:compat:test",
]);
assert.deepEqual(skipped(buildPlan({ ...everything, hasInstall: false })), [
  "casc:test",
  "jass:coverage",
  "map:compat:test",
  "campaign:test",
]);

// A skipped step says why, and names the command that unskips it.
const byName = (plan, name) => plan.find((s) => s.name === name);
assert.match(byName(buildPlan({ ...everything, hasData: false }), "data:verify").reason, /pnpm data:extract/);
assert.match(byName(buildPlan({ ...everything, hasDist: false }), "app:test").reason, /pnpm build/);
assert.match(byName(buildPlan({ ...everything, hasWeb: false }), "web:typecheck").reason, /pnpm --dir web install/);
for (const step of buildPlan(freshClone)) {
  if (step.skip) assert.ok(step.reason && step.reason.length > 0, `${step.name} skipped without a reason`);
}

// ── the suites ────────────────────────────────────────────────────────────────────────────

const all = Object.keys(SUITES);
const run = (plan) => plan.flatMap((s) => s.tests.filter((t) => !t.skip).map((t) => t.file));
const dataTests = Object.values(SUITES).flatMap((s) => s.tests.map(entry).filter((t) => t.data).map((t) => t.file));

// With the data, every test of every suite runs.
const full = planSuites(all, { hasData: true, hasDist: true });
assert.equal(run(full).length, Object.values(SUITES).reduce((n, s) => n + s.tests.length, 0));

// Without it — or with --free — exactly the `data` tests are skipped, each with a reason.
for (const opts of [{ hasData: false, hasDist: true }, { hasData: true, hasDist: true, free: true }]) {
  const plan = planSuites(all, opts);
  const skippedTests = plan.flatMap((s) => s.tests.filter((t) => t.skip));
  assert.deepEqual(skippedTests.map((t) => t.file).sort(), [...dataTests].sort());
  for (const t of skippedTests) assert.ok(t.skip.length > 0);
}
assert.match(planSuites(["sim"], { hasData: false, hasDist: true }).flatMap((s) => s.tests).find((t) => t.skip).skip, /pnpm data:extract/);

// The app suite tests the built app, so it is skipped whole without dist/.
assert.match(planSuites(["app"], { hasData: true, hasDist: false })[0].skip, /pnpm build/);

// A filter narrows by file name.
assert.deepEqual(run(planSuites(["sim"], { hasData: true, hasDist: true, filters: ["sim-hex-test"] })), ["sim-hex-test.cjs"]);

// An unknown suite is an error, not an empty run.
assert.throws(() => planSuites(["nope"], { hasData: true, hasDist: true }), /unknown suite/);

// The heap flag reaches the command line.
assert.equal(commandFor({ file: "x-test.cjs", heap: true }), "node --max-old-space-size=8192 tools/x-test.cjs");
assert.equal(commandFor("x-test.cjs"), "node tools/x-test.cjs");

// Every entry names a file that exists, and no file is in two places.
const listed = Object.values(SUITES).flatMap((s) => s.tests.map((t) => entry(t).file));
assert.equal(new Set(listed).size, listed.length, "a test is listed twice");
for (const f of listed) assert.ok(existsSync(join(repoRoot, "tools", f)), `tools/${f} does not exist`);

// Every tools/*-test.* file is run by a suite or named by a package.json script.
const scripts = Object.values(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts).join("\n");
const orphans = readdirSync(join(repoRoot, "tools"))
  .filter((f) => /-test\.(c|m)?js$/.test(f))
  .filter((f) => !listed.includes(f) && !scripts.includes(`tools/${f}`) && f !== "test-plan-test.mjs");
assert.deepEqual(orphans, [], `tests run by nothing — add them to tools/tests.mjs: ${orphans.join(", ")}`);

console.log("test-plan: ok");
