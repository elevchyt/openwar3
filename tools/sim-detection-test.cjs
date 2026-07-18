// Headless check of True Sight (`Atru` — the Shade, 900; `Adet` — the Sentry Ward, 1100)
// against invisibility.
//
// The rule being pinned is that detection is a TEAM property: the Shade stands at the back
// and the whole army sees what it uncovers. Radii are dataA of the real 1.27a rows.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
let nextId = 1;
function unit(over = {}) {
  const u = { id: nextId++, owner: 0, team: 0, hp: 100, x: 0, y: 0, detectRadius: 0, invisible: false, ...over };
  world.units.set(u.id, u);
  return u;
}

const hidden = unit({ team: 1, x: 0, y: 0, invisible: true });

check("nothing detects it to begin with", world.teamDetects(0, hidden.x, hidden.y), false);

// A Shade (Atru, dataA = 900) 500 away — well inside its radius.
const shade = unit({ team: 0, x: 500, y: 0, detectRadius: 900 });
check("a Shade 500 away uncovers it", world.teamDetects(0, hidden.x, hidden.y), true);
// …and only for the Shade's OWN team. Detection is shared sideways across an army, never
// handed to the other side.
check("…but not for the hidden unit's own team, which owns no detector", world.teamDetects(1, hidden.x, hidden.y), false);

// Out of range again.
shade.x = 2000;
check("a Shade 2000 away does not", world.teamDetects(0, hidden.x, hidden.y), false);

// The Sentry Ward's radius is wider (Adet dataA = 1100), so it still covers from 1000.
const ward = unit({ team: 0, x: 1000, y: 0, detectRadius: 1100 });
check("a Sentry Ward reaches further (1100)", world.teamDetects(0, hidden.x, hidden.y), true);

// A dead detector detects nothing.
ward.hp = 0;
check("a dead detector uncovers nothing", world.teamDetects(0, hidden.x, hidden.y), false);

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
