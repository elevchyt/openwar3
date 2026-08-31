// Headless check of ALLY COLOR MODE's one rule table (src/game/allyColor.ts).
//
// The feature is three modes over two surfaces, and the whole of it is a reading of two
// strings the game ships (GlobalStrings' MINIMAPALLYCOLORTOOLTIP_UBER and TriggerStrings'
// SetAllyColorFilterStateHint). What is worth pinning is exactly the part that reading
// decides and a running client would never make obvious:
//
//   · mode 2 (state 1) is the MINIMAP ONLY — the world keeps player colours;
//   · the minimap is "As Mode 2" in BOTH filtered modes, so YOU are teal on it with your
//     allies, and only the game world in mode 3 separates you out in blue;
//   · the neutrals are never filtered (a creep and a shop share owner -1, so reddening one
//     reddens the other).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const {
  allyFilterColor,
  allyButtonSkin,
  nextAllyColorMode,
  toAllyColorMode,
  ALLY_FILTER_COLOR,
} = require(join(REPO, ".sim-build", "src", "game", "allyColor.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const RED = ALLY_FILTER_COLOR.enemy; // 0
const BLUE = ALLY_FILTER_COLOR.self; // 1
const TEAL = ALLY_FILTER_COLOR.ally; // 2

console.log("Mode 1 (state 0) — all units use Player Colors");
for (const surface of ["minimap", "world"]) {
  for (const side of ["self", "ally", "enemy", "neutral"]) {
    check(`${surface}/${side} unfiltered`, allyFilterColor(0, surface, side), null);
  }
}

console.log("Mode 2 (state 1) — the minimap only");
check("minimap: you go teal with your allies", allyFilterColor(1, "minimap", "self"), TEAL);
check("minimap: an ally is teal", allyFilterColor(1, "minimap", "ally"), TEAL);
check("minimap: an enemy is red", allyFilterColor(1, "minimap", "enemy"), RED);
check("minimap: a creep/shop is left alone", allyFilterColor(1, "minimap", "neutral"), null);
for (const side of ["self", "ally", "enemy", "neutral"]) {
  check(`world/${side} still player colours`, allyFilterColor(1, "world", side), null);
}

console.log("Mode 3 (state 2) — and the game world");
check("world: YOU are blue", allyFilterColor(2, "world", "self"), BLUE);
check("world: an ally is teal", allyFilterColor(2, "world", "ally"), TEAL);
check("world: an enemy is red", allyFilterColor(2, "world", "enemy"), RED);
check("world: a creep/shop is left alone", allyFilterColor(2, "world", "neutral"), null);
check("minimap is still 'As Mode 2': you are teal", allyFilterColor(2, "minimap", "self"), TEAL);
check("minimap: an enemy is red", allyFilterColor(2, "minimap", "enemy"), RED);

console.log("The button cycles three modes, and a script's state clamps to them");
check("0 → 1 → 2 → 0", [nextAllyColorMode(0), nextAllyColorMode(1), nextAllyColorMode(2)], [1, 2, 0]);
check("SetAllyColorFilterState(-3)", toAllyColorMode(-3), 0);
check("SetAllyColorFilterState(7)", toAllyColorMode(7), 2);
check("SetAllyColorFilterState(2)", toAllyColorMode(2), 2);

console.log("The face is the mode it is IN (war3skins MiniMapAllyButton* keys)");
check("mode 1 = filtering off", allyButtonSkin(0, "Enabled"), "MiniMapAllyButtonOffEnabled");
check("mode 2", allyButtonSkin(1, "Pushed"), "MiniMapAllyButtonInactivePushed");
check("mode 3 = fully on", allyButtonSkin(2, "Disabled"), "MiniMapAllyButtonActiveDisabled");

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
