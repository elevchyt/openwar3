// The JASS tests read the DEVELOPER'S OWN install - `common.j` and `Blizzard.j` are the game's
// ground truth here (see CLAUDE.md), so they are never committed. A contributor without an
// unpacked 1.30.4 install therefore used to get a raw ENOENT stack trace out of `pnpm jass:test`,
// which says nothing about what to do next.
//
// This helper is the one place that knows where the extracted scripts live and what to say when
// they are not there. The tests that already had the guard print the same message and exit with
// the same code, so the output stays consistent whichever test a contributor runs first.
const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

const REPO = resolve(__dirname, "..");
const SCRIPTS = join(REPO, "Warcraft III", "ExtractedData", "merged", "Scripts");

// Exits the process with the standard hint unless every named script is there.
// Returns the directory holding them, so a test can read straight from it.
function requireInstallScripts(...names) {
  const missing = names.filter((name) => !existsSync(join(SCRIPTS, name)));
  if (missing.length > 0) {
    console.error(
      `Run \`pnpm data:extract\` first - this test reads the install's own ${missing.join(", ")}.`,
    );
    process.exit(2);
  }
  return SCRIPTS;
}

module.exports = { SCRIPTS, requireInstallScripts };
