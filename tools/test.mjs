// `pnpm test` — one entry point for every check the repo has.
//
// Some checks cannot run without something local, and are skipped with a line saying so rather
// than failing a fresh clone for a reason that has nothing to do with the change:
//
//   - `data`    — `Warcraft III/ExtractedData`, which `pnpm data:extract` produces from the
//                 contributor's own 1.30.4 install;
//   - `install` — the install itself in `Warcraft III/` (its CASC store or MPQs, and its maps);
//   - `dist`    — the built app (`pnpm build`), which `app:test` drives;
//   - `web`     — `web/node_modules` (`pnpm --dir web install`), for the landing page's typecheck.
//
// `sim:test` and `jass:test` are NOT skipped without the data: their runner (tools/run-tests.mjs)
// skips only the tests the manifest marks `data` and runs the rest, which is what CI runs
// (issue #394). A failing step does not stop the plan — every step runs and the summary names
// the ones that failed.
//
//   pnpm test              run the plan
//   node tools/test.mjs --dry-run   print the plan without running it

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The order is cheap to expensive. Each suite compiles what it reads itself, so no step
// depends on another having run.
export const STEPS = [
  { name: "typecheck", cmd: "pnpm typecheck" },
  { name: "cycles", cmd: "pnpm cycles" },
  // The runner's own skip logic and the manifest's coverage, otherwise checked by nothing.
  { name: "test-plan", cmd: "node tools/test-plan-test.mjs" },
  { name: "web:typecheck", cmd: "pnpm web:typecheck", needs: ["web"] },
  { name: "relay:test", cmd: "pnpm relay:test" },
  { name: "sim:test", cmd: "pnpm sim:test" },
  { name: "jass:test", cmd: "pnpm jass:test" },
  { name: "app:test", cmd: "pnpm app:test", needs: ["dist"] },
  { name: "data:verify", cmd: "pnpm data:verify", needs: ["data"] },
  { name: "versions:test", cmd: "pnpm versions:test", needs: ["data"] },
  { name: "casc:test", cmd: "pnpm casc:test", needs: ["install"] },
  { name: "jass:coverage", cmd: "pnpm jass:coverage", needs: ["install", "data"] },
  { name: "map:compat:test", cmd: "pnpm map:compat:test", needs: ["install", "data"] },
  { name: "campaign:test", cmd: "pnpm campaign:test", needs: ["install"] },
];

const REASONS = {
  dist: "no dist/ yet (run `pnpm build` first)",
  data: "no Warcraft III/ExtractedData (run `pnpm data:extract` first)",
  install: "no Warcraft III install in Warcraft III/",
  web: "no web/node_modules (run `pnpm --dir web install` first)",
};

/** Which steps run, in order, and why the others do not. */
export function buildPlan({ hasDist, hasData, hasInstall, hasWeb }) {
  const available = { dist: hasDist, data: hasData, install: hasInstall, web: hasWeb };
  return STEPS.map((step) => {
    const missing = (step.needs ?? []).find((need) => !available[need]);
    return missing ? { ...step, skip: true, reason: REASONS[missing] } : { ...step, skip: false };
  });
}

/** A CASC (`.build.info`) or MPQ-era (`War3.mpq`) install — tools/install.cjs reads either. */
function installIn(dir) {
  if (existsSync(join(dir, ".build.info"))) return true;
  try {
    return readdirSync(dir).some((n) => n.toLowerCase() === "war3.mpq");
  } catch {
    return false;
  }
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const wc3 = join(repoRoot, "Warcraft III");
  const plan = buildPlan({
    hasDist: existsSync(join(repoRoot, "dist")),
    hasData: existsSync(join(wc3, "ExtractedData")),
    hasInstall: installIn(wc3),
    hasWeb: existsSync(join(repoRoot, "web", "node_modules")),
  });

  if (dryRun) {
    for (const step of plan) {
      console.log(step.skip ? `skip ${step.name} — ${step.reason}` : `run  ${step.name} — ${step.cmd}`);
    }
    return 0;
  }

  let passed = 0;
  const skipped = [];
  const failed = [];
  for (const step of plan) {
    if (step.skip) {
      console.log(`— ${step.name} skipped: ${step.reason}`);
      skipped.push(step.name);
      continue;
    }
    console.log(`\n▸ ${step.name}`);
    const result = spawnSync(step.cmd, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true, // the command strings above are shell commands, and pnpm is pnpm.CMD on Windows
    });
    if (result.status !== 0) {
      console.log(`\n✗ ${step.name} failed (exit ${result.status ?? "?"})`);
      failed.push(step);
      continue;
    }
    passed += 1;
  }

  const tail = skipped.length ? `, ${skipped.length} skipped (${skipped.join(", ")})` : "";
  if (failed.length) {
    console.log(`\n✗ ${failed.length} check(s) failed, ${passed} passed${tail}`);
    for (const step of failed) console.log(`  ✗ ${step.name} — ${step.cmd}`);
    return 1;
  }
  console.log(`\n✓ ${passed} check(s) passed${tail}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
