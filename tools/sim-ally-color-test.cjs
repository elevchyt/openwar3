// Headless check of ALLY COLOR MODE's rule table (src/game/allyColor.ts).
//
// Three modes over two surfaces that answer in different currencies, and almost all of it is
// a reading of files the game ships (GlobalStrings' MINIMAPALLYCOLORTOOLTIP_UBER, TriggerStrings'
// SetAllyColorFilterStateHint, and `UI\MiscData.txt` [FogOfWar]'s own FogColorPlayer/Ally/Enemy).
// What is worth pinning is what that reading decides and a running client would never make
// obvious:
//
//   · YOUR OWN units are white on YOUR minimap in EVERY mode, filter or no filter — the
//     `self` tone comes back even at state 0, which is the whole of "for themselves only";
//   · mode 2 (state 1) is the MINIMAP ONLY — the world keeps player colours;
//   · the neutrals are never filtered (a creep and a shop share owner -1, so reddening one
//     reddens the other).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const {
  minimapDotTone,
  worldFilterColor,
  allyButtonSkin,
  nextAllyColorMode,
  toAllyColorMode,
  observerTeamColors,
  ALLY_FILTER_COLOR,
} = require(join(REPO, ".sim-build", "src", "game", "allyColor.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const RED = ALLY_FILTER_COLOR.enemy; // player-colour slot 0
const BLUE = ALLY_FILTER_COLOR.self; // slot 1
const TEAL = ALLY_FILTER_COLOR.ally; // slot 2

console.log("You are FogColorPlayer white on your own minimap in every mode");
check("mode 1 (state 0)", minimapDotTone(0, "self"), "self");
check("mode 2 (state 1)", minimapDotTone(1, "self"), "self");
check("mode 3 (state 2)", minimapDotTone(2, "self"), "self");

console.log("Mode 1 (state 0) — everyone else uses Player Colors, map and world");
for (const side of ["ally", "enemy", "neutral"]) {
  check(`minimap/${side} unfiltered`, minimapDotTone(0, side), null);
}
for (const side of ["self", "ally", "enemy", "neutral"]) {
  check(`world/${side} unfiltered`, worldFilterColor(0, side), null);
}

console.log("Mode 2 (state 1) — the minimap only");
check("minimap: an ally is teal", minimapDotTone(1, "ally"), "ally");
check("minimap: an enemy is red", minimapDotTone(1, "enemy"), "enemy");
check("minimap: a creep/shop is left alone", minimapDotTone(1, "neutral"), null);
for (const side of ["self", "ally", "enemy", "neutral"]) {
  check(`world/${side} still player colours`, worldFilterColor(1, side), null);
}

console.log("Mode 3 (state 2) — and the game world");
check("world: YOU are blue", worldFilterColor(2, "self"), BLUE);
check("world: an ally is teal", worldFilterColor(2, "ally"), TEAL);
check("world: an enemy is red", worldFilterColor(2, "enemy"), RED);
check("world: a creep/shop is left alone", worldFilterColor(2, "neutral"), null);
check("minimap: you are STILL white, not the world's blue", minimapDotTone(2, "self"), "self");
check("minimap: an ally is teal", minimapDotTone(2, "ally"), "ally");
check("minimap: an enemy is red", minimapDotTone(2, "enemy"), "enemy");

// An OBSERVER is on no side, so the three-tone vocabulary above has nothing to say about the
// game it is watching — asked of a watcher's own (empty) alliances every player is an enemy
// and the field goes red. The filter colours the TEAMS instead, and what is pinned is the
// order: blue then red — the two slots the filter already means by "you" and "the enemy", so a
// watched game reads like a played one — then the palette's own order for any team after them.
console.log("Watching: the filter gives each TEAM its own colour, blue and red first");
{
  const twoTeams = [
    { player: 0, team: 0 }, { player: 3, team: 0 },
    { player: 1, team: 1 }, { player: 5, team: 1 },
  ];
  check("team 1 is blue, both of them", [observerTeamColors(twoTeams).get(0), observerTeamColors(twoTeams).get(3)], [BLUE, BLUE]);
  check("team 2 is red, both of them", [observerTeamColors(twoTeams).get(1), observerTeamColors(twoTeams).get(5)], [RED, RED]);
  // A free-for-all is four teams, and the two after the first pair take the palette in ITS
  // order with blue and red skipped — teal (2) is next, then purple (3).
  const ffa = [{ player: 0, team: 0 }, { player: 1, team: 1 }, { player: 2, team: 2 }, { player: 3, team: 3 }];
  check("then the palette, blue and red skipped", [...observerTeamColors(ffa).values()], [BLUE, RED, TEAL, 3]);
  // Teams are ranked by their own index, not by who happens to be listed first: the two
  // surfaces (a minimap dot and the unit in the world) have to agree, and a rebuild must not
  // renumber anybody.
  const reversed = [{ player: 9, team: 3 }, { player: 2, team: 1 }];
  check("ranked by team index, not by seat order", [...observerTeamColors(reversed).values()], [RED, BLUE]);
  check("nobody playing, nobody coloured", [...observerTeamColors([]).values()], []);
}

console.log("The button cycles three modes, and a script's state clamps to them");
check("0 → 1 → 2 → 0", [nextAllyColorMode(0), nextAllyColorMode(1), nextAllyColorMode(2)], [1, 2, 0]);
check("SetAllyColorFilterState(-3)", toAllyColorMode(-3), 0);
check("SetAllyColorFilterState(7)", toAllyColorMode(7), 2);
check("SetAllyColorFilterState(2)", toAllyColorMode(2), 2);

// The face is the mode it is IN, and a press wears that face's own `-down` twin. The whole
// 3 x 3 is pinned because the mapping is the one thing here the install does NOT state (it
// was confirmed against the real client), and because a button that shows the wrong mode is
// a bug nothing else in this file could catch. The `//` lines are what war3skins.txt resolves
// each key to, so the pin reads against the art the developer named.
console.log("The face is the mode it is IN (war3skins MiniMapAllyButton* keys)");
check("mode 1 up", allyButtonSkin(0, "Enabled"), "MiniMapAllyButtonOffEnabled"); //      human-minimap-ally-off.blp
check("mode 1 held", allyButtonSkin(0, "Pushed"), "MiniMapAllyButtonOffPushed"); //      human-minimap-ally-off-down.blp
check("mode 1 taken away", allyButtonSkin(0, "Disabled"), "MiniMapAllyButtonOffDisabled");
check("mode 2 up", allyButtonSkin(1, "Enabled"), "MiniMapAllyButtonInactiveEnabled"); // human-minimap-ally-inactive.blp
check("mode 2 held", allyButtonSkin(1, "Pushed"), "MiniMapAllyButtonInactivePushed"); // human-minimap-ally-inactive-down.blp
check("mode 2 taken away", allyButtonSkin(1, "Disabled"), "MiniMapAllyButtonInactiveDisabled");
check("mode 3 up", allyButtonSkin(2, "Enabled"), "MiniMapAllyButtonActiveEnabled"); //   human-minimap-ally-active.blp
check("mode 3 held", allyButtonSkin(2, "Pushed"), "MiniMapAllyButtonActivePushed"); //   human-minimap-ally-active-down.blp
check("mode 3 taken away", allyButtonSkin(2, "Disabled"), "MiniMapAllyButtonActiveDisabled");

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
