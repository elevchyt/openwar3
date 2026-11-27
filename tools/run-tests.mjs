// Runs one or more suites out of the test manifest (tools/tests.mjs; issue #394).
//
//   node tools/run-tests.mjs sim                 every sim test (what `pnpm sim:test` runs)
//   node tools/run-tests.mjs sim jass --free     only the tests that need no game data (CI)
//   node tools/run-tests.mjs sim --jobs 6        six at a time; each test's output is printed whole
//   node tools/run-tests.mjs sim pathing harvest only the tests whose file name contains a word
//   node tools/run-tests.mjs sim --list          print the plan without running it
//
// Unlike the `&&` chains this replaces, a failing test does not stop the run: every test runs,
// and the summary at the end names each one that failed. The exit code is 1 if any did.
//
// Without `Warcraft III/ExtractedData` the tests marked `data` are skipped with one line saying
// so, and the rest still run, so a fresh clone is tested as far as it can be rather than not at
// all. A suite that `needs: "dist"` is skipped whole when there is no `dist/`. A build step that
// fails stops its suite: nothing after it would be testing the change.

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SUITES, entry } from "./tests.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The command line for one test entry. */
export function commandFor(test) {
  const t = entry(test);
  return `node ${t.heap ? "--max-old-space-size=8192 " : ""}tools/${t.file}`;
}

/**
 * What runs, in order. `hasData`/`hasDist` say what this checkout has; `free` skips the data
 * tests even when it has the data (CI's mode, also useful to check a test really is free).
 */
export function planSuites(names, { hasData, hasDist, free = false, filters = [] }) {
  return names.map((name) => {
    const suite = SUITES[name];
    if (!suite) throw new Error(`unknown suite "${name}" (have: ${Object.keys(SUITES).join(", ")})`);
    if (suite.needs === "dist" && !hasDist) {
      return { name, build: [], tests: [], skip: "no dist/ yet (run `pnpm build` first)" };
    }
    const tests = suite.tests
      .map(entry)
      .filter((t) => filters.length === 0 || filters.some((f) => t.file.includes(f)))
      .map((t) => {
        const cmd = commandFor(t);
        if (t.data && free) return { file: t.file, cmd, skip: "needs the game data (--free)" };
        if (t.data && !hasData) return { file: t.file, cmd, skip: "no Warcraft III/ExtractedData (run `pnpm data:extract`)" };
        return { file: t.file, cmd, skip: null };
      });
    return { name, build: suite.build ?? [], tests, skip: null };
  });
}

function parseArgs(argv) {
  const names = [];
  const filters = [];
  let jobs = 1;
  let free = false;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--free") free = true;
    else if (a === "--list") list = true;
    else if (a === "--jobs" || a === "-j") jobs = Math.max(1, Number(argv[++i]) || 1);
    else if (a in SUITES) names.push(a);
    else filters.push(a);
  }
  return { names, filters, jobs, free, list };
}

/** Run one test; resolve to { code, output } (output only when buffered). */
function runOne(cmd, buffered) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd: repoRoot,
      shell: true, // pnpm is pnpm.CMD on Windows, and the commands are shell lines
      stdio: buffered ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (buffered) {
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
    }
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output }));
  });
}

async function main(argv) {
  const { names, filters, jobs, free, list } = parseArgs(argv);
  if (names.length === 0) {
    console.error(`usage: node tools/run-tests.mjs <${Object.keys(SUITES).join("|")}>... [--free] [--jobs N] [--list] [word...]`);
    return 2;
  }
  const plan = planSuites(names, {
    hasData: existsSync(join(repoRoot, "Warcraft III", "ExtractedData")),
    hasDist: existsSync(join(repoRoot, "dist")),
    free,
    filters,
  });

  if (list) {
    for (const suite of plan) {
      if (suite.skip) { console.log(`skip ${suite.name} — ${suite.skip}`); continue; }
      for (const b of suite.build) console.log(`build ${b}`);
      for (const t of suite.tests) console.log(t.skip ? `skip  ${t.cmd} — ${t.skip}` : `run   ${t.cmd}`);
    }
    return 0;
  }

  const failed = [];
  const skipped = [];
  let passed = 0;
  const started = Date.now();

  for (const suite of plan) {
    if (suite.skip) {
      console.log(`— ${suite.name} skipped: ${suite.skip}`);
      continue;
    }
    let built = true;
    for (const b of suite.build) {
      console.log(`▸ ${b}`);
      if (spawnSync(b, { cwd: repoRoot, stdio: "inherit", shell: true }).status !== 0) {
        console.log(`\n✗ ${suite.name}: build failed — ${b}`);
        failed.push(`${suite.name}: ${b}`);
        built = false;
        break;
      }
    }
    if (!built) continue;

    const todo = suite.tests.filter((t) => {
      if (t.skip) skipped.push(t);
      return !t.skip;
    });
    // Sequential runs stream; parallel ones print each test's output whole as it finishes, so
    // two tests never interleave.
    const buffered = jobs > 1;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const t = todo[next++];
        if (!buffered) console.log(`\n▸ ${t.cmd}`);
        const { code, output } = await runOne(t.cmd, buffered);
        if (buffered) process.stdout.write(`\n▸ ${t.cmd}\n${output}`);
        if (code === 0) passed += 1;
        else {
          console.log(`✗ ${t.file} failed (exit ${code})`);
          failed.push(t.cmd);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, worker));
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n── ${names.join(" + ")}: ${passed} passed, ${failed.length} failed, ${skipped.length} skipped (${secs}s)`);
  if (skipped.length) {
    const reasons = [...new Set(skipped.map((t) => t.skip))];
    for (const r of reasons) console.log(`   ${skipped.filter((t) => t.skip === r).length} skipped: ${r}`);
  }
  for (const f of failed) console.log(`   ✗ ${f}`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
