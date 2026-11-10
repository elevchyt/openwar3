// `pnpm test` — one entry point for every check the repo has.
//
// The checks used to be spread over `typecheck`, `cycles`, `relay:test`,
// `app:test`, `sim:test` and `jass:test`, so a newcomer had to know which of them
// applied to them. Two of those suites cannot run without something local:
//
//   - `sim:test` and `jass:test` read `Warcraft III/ExtractedData`, which
//     `pnpm data:extract` produces from the contributor's own 1.30.4 install;
//   - `app:test` drives the desktop shell and needs `dist/` from `pnpm build`.
//
// Those are skipped with a line saying so, rather than failing a fresh clone for
// a reason that has nothing to do with the change. Everything else runs.
//
//   pnpm test              run the plan
//   node tools/test.mjs --dry-run   print the plan without running it

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The order is the cheap-to-expensive order, and it is not arbitrary: `sim:test`
// and `jass:test` both compile into `.sim-build/`, and sim has to go first for
// jass to build on it.
export const STEPS = [
  { name: "typecheck", cmd: "pnpm typecheck" },
  { name: "cycles", cmd: "pnpm cycles" },
  // sim first: it compiles `.sim-build/`, and jass:test builds on that output
  // while relay:test imports `.sim-build/src/net/commandLink.js` for its loopback
  // half. Both of those are consequences of the sim build, not of the relay.
  { name: "sim:test", cmd: "pnpm sim:test", needs: "data" },
  { name: "jass:test", cmd: "pnpm jass:test", needs: "data" },
  { name: "relay:test", cmd: "pnpm relay:test", needs: "simbuild" },
  { name: "app:test", cmd: "pnpm app:test", needs: "dist" },
];

const REASONS = {
  dist: "no dist/ yet (run `pnpm build` first)",
  data: "no Warcraft III/ExtractedData (run `pnpm data:extract` first)",
  simbuild: "no .sim-build/ yet — it is compiled by `pnpm sim:test`, which needs the extracted data",
};

/** Which steps run, in order, and why the others do not. */
export function buildPlan({ hasDist, hasData, hasSimBuild }) {
  // sim:test compiles `.sim-build/` as it runs, so when the extracted data is
  // there the directory will exist by the time relay runs — what is on disk now
  // is not the question. With no data, nothing builds it at all.
  const available = { dist: hasDist, data: hasData, simbuild: hasSimBuild || hasData };
  return STEPS.map((step) =>
    step.needs && !available[step.needs]
      ? { ...step, skip: true, reason: REASONS[step.needs] }
      : { ...step, skip: false },
  );
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const plan = buildPlan({
    hasDist: existsSync(join(repoRoot, "dist")),
    hasData: existsSync(join(repoRoot, "Warcraft III", "ExtractedData")),
    hasSimBuild: existsSync(join(repoRoot, ".sim-build")),
  });

  if (dryRun) {
    for (const step of plan) {
      console.log(step.skip ? `skip ${step.name} — ${step.reason}` : `run  ${step.name} — ${step.cmd}`);
    }
    return 0;
  }

  let passed = 0;
  const skipped = [];
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
      console.log(`  ${step.cmd}`);
      return result.status || 1;
    }
    passed += 1;
  }

  const tail = skipped.length ? `, ${skipped.length} skipped (${skipped.join(", ")})` : "";
  console.log(`\n✓ ${passed} check(s) passed${tail}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
