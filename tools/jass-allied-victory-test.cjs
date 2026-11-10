// A TEAM game is won when the other team is gone — blizzard.j decides that, and it can only do
// so if PLAYER_STATE_ALLIED_VICTORY answers.
//
// `MeleePlayerIsOpponent` (Scripts\Blizzard.j) lets two mutually-passive players stop being each
// other's opponents ONLY when both have PLAYER_STATE_ALLIED_VICTORY == 1. The native answered 0
// for every player, so in a 2v2 the two survivors were each other's last opponent and
// `MeleeCheckForVictors` never named a winner — a 1v1 ended, a team game ran on with nobody told
// (reported: observing a 2v2 on Lost Temple, both players of one team left, no "Game over.").
//
// A melee game's teams are the LOBBY's (Runtime.applyLobby grants it to everyone with a
// teammate); a custom map writes it itself through InitCustomTeams.
//
// Run: pnpm jass:test
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const { requireInstallScripts } = require("./jass-install-scripts.cjs");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".jass-build", "src", "jass");
require("node:fs").writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, "headless.js"));

const SCRIPTS = requireInstallScripts("common.j", "Blizzard.j");
const COMMON_J = readFileSync(join(SCRIPTS, "common.j"), "latin1");
const BLIZZARD_J = readFileSync(join(SCRIPTS, "Blizzard.j"), "latin1");

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const SRC = `
globals
    integer winners = 0
endglobals

function Opp takes integer a, integer b returns boolean
    return MeleePlayerIsOpponent(a, b)
endfunction

// Team 0 (players 0 and 1) is left standing once players 2 and 3 are out.
function TeamTwoOut takes nothing returns nothing
    local force f
    local integer i = 4
    // MeleeInitVictoryDefeat's own start: every slot nobody is playing begins defeated.
    loop
        exitwhen i >= bj_MAX_PLAYERS
        set bj_meleeDefeated[i] = true
        set i = i + 1
    endloop
    set bj_meleeDefeated[2] = true
    set bj_meleeDefeated[3] = true
    set f = MeleeCheckForVictors()
    if IsPlayerInForce(Player(0), f) then
        set winners = winners + 1
    endif
    if IsPlayerInForce(Player(1), f) then
        set winners = winners + 1
    endif
endfunction

function AllyVictoryOf takes integer p returns integer
    return GetPlayerState(Player(p), PLAYER_STATE_ALLIED_VICTORY)
endfunction

function ClearAllyVictory takes integer p returns nothing
    call SetPlayerState(Player(p), PLAYER_STATE_ALLIED_VICTORY, 0)
endfunction
`;

/** A 2v2 with a real directed alliance matrix: each team PASSIVE to itself, both ways. */
function match(gameType) {
  const team = [0, 0, 1, 1];
  const passive = (a, b) => a < 4 && b < 4 && a !== b && team[a] === team[b];
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], {
    gameType,
    hooks: { getPlayerAlliance: (a, b, setting) => setting === 0 && passive(a, b) },
  });
  interp.rt.applyLobby(team.map((t, index) => ({ index, raceIndex: 1, controller: 0, team: t, startLocation: index })), 0);
  return interp;
}
const int = (v) => v.n ?? v.v ?? v;
const bool = (v) => v.b ?? v.v ?? v;

console.log("a melee 2v2: the lobby's teams carry allied victory");
{
  const interp = match(1);
  check("player 0 has PLAYER_STATE_ALLIED_VICTORY", int(interp.run("AllyVictoryOf", [{ k: "int", n: 0 }])), 1);
  check("teammates are not each other's opponents", bool(interp.run("Opp", [{ k: "int", n: 0 }, { k: "int", n: 1 }])), false);
  check("the other team still is", bool(interp.run("Opp", [{ k: "int", n: 0 }, { k: "int", n: 2 }])), true);
  interp.run("TeamTwoOut", []);
  check("with the other team out, BOTH survivors are victorious", int(interp.rt.globals.get("winners")), 2);
  check("…and the game is over", bool(interp.rt.globals.get("bj_meleeGameOver")), true);
}

console.log("\na script may take it away again (SetPlayerState)");
{
  const interp = match(1);
  interp.run("ClearAllyVictory", [{ k: "int", n: 1 }]);
  check("player 1 no longer has it", int(interp.run("AllyVictoryOf", [{ k: "int", n: 1 }])), 0);
  check("…so 0 and 1 are opponents again", bool(interp.run("Opp", [{ k: "int", n: 0 }, { k: "int", n: 1 }])), true);
}

console.log("\na custom map's teams are its own forces' — the lobby grants nothing");
{
  const interp = match(4);
  check("player 0 has no allied victory the map did not write", int(interp.run("AllyVictoryOf", [{ k: "int", n: 0 }])), 0);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall allied victory checks passed");
