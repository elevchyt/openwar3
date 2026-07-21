// GetLocalPlayer must answer for the RECIPIENT, not for the host (Phase D item 6).
//
// Today every client boots the map and runs config()/main() itself, so each machine's runtime
// genuinely has its own local player and GetLocalPlayer is already correct. Phase E is what
// breaks that: one host runs the script and ships snapshots to N clients, and "local" on the
// authority means the host. So the resolution point is `Runtime.audience` — null for "this
// machine's own seat", set per recipient by `forAudience`.
//
// What makes evaluating the same script once per viewer safe at all is a contract Blizzard
// states in their own source. All 72 GetLocalPlayer sites in Scripts\Blizzard.j guard a block
// carrying the comment "Use only local code (no net traffic) within this block to avoid
// desyncs" — camera, text, sound, timer dialogs, cinematic. A GetLocalPlayer gate is
// presentation-only BY CONTRACT.
//
// Run: pnpm jass:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".jass-build", "src", "jass");
require("node:fs").writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, "headless.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

// A script that records who GetLocalPlayer says it is.
const SRC = `
globals
    integer seen = -1
endglobals

function WhoAmI takes nothing returns nothing
    set seen = GetPlayerId(GetLocalPlayer())
endfunction

// The shape MeleeVictoryDialogBJ uses: the player is the SUBJECT of the message, and the
// message itself goes to the whole game.
function Broadcast takes nothing returns nothing
    call DisplayTimedTextFromPlayer(Player(0), 0, 0, 5, "%s wins")
endfunction

// ---- item 7b: a MAP script's own GetLocalPlayer gate --------------------------------------

// The canonical shape, straight out of countless maps: a presentation call behind the gate.
function GatedCamera takes nothing returns nothing
    if GetLocalPlayer() == Player(5) then
        call SetCameraPosition(1000, 2000)
    endif
endfunction

// The gate that is TRUE for more than one recipient, with a WORLD write inside it. This is the
// shape the developer's decision is about: run it N times and the write lands N times.
function GatedWorldWrite takes nothing returns nothing
    if GetLocalPlayer() != Player(99) then
        call SetPlayerState(Player(0), PLAYER_STATE_RESOURCE_GOLD, 500)
    endif
endfunction

// No GetLocalPlayer anywhere in the condition: must not fan out at all.
function Ungated takes nothing returns nothing
    if 1 == 1 then
        call SetCameraPosition(7, 7)
    endif
endfunction

// ---- Phase G item 1: blizzard.j's own end-of-game signal ------------------------------------
// CustomVictoryBJ and CustomDefeatBJ both call RemovePlayer(p, PLAYER_GAME_RESULT_*) before they
// show anything. common.j numbers them VICTORY 0, DEFEAT 1, TIE 2, NEUTRAL 3 -- verified in the
// real War3.mpq and War3x.mpq, which agree.
function EndVictory takes nothing returns nothing
    call RemovePlayer(Player(0), ConvertPlayerGameResult(0))
endfunction

function EndDefeat takes nothing returns nothing
    call RemovePlayer(Player(3), ConvertPlayerGameResult(1))
endfunction
`;

const interp = buildInterpreter([SRC]);
const rt = interp.rt;
const whoAmI = () => {
  interp.callFunction("WhoAmI", []);
  return interp.rt.globals.get("seen")?.n; // JassValue int is { k: "int", n }
};

console.log("with no audience set, GetLocalPlayer is this machine's own seat");
{
  rt.localPlayer = 3;
  check("answers localPlayer", whoAmI(), 3);
  check("localViewer agrees", rt.localViewer, 3);
}

console.log("\nforAudience makes it answer for the recipient");
{
  rt.localPlayer = 3;
  let inside = -1;
  rt.forAudience(7, () => { inside = whoAmI(); });
  check("inside the block it is the recipient", inside, 7);
  check("…and afterwards it is the host again", whoAmI(), 3);
}

console.log("\nnesting restores the outer audience, not the default");
{
  rt.localPlayer = 3;
  let middle = -1;
  rt.forAudience(5, () => {
    rt.forAudience(9, () => {});
    middle = whoAmI(); // back to 5, not 3 and not 9
  });
  check("the inner block restores its caller", middle, 5);
  check("…and the outer one restores the host", whoAmI(), 3);
}

console.log("\na throwing trigger does not leave the runtime wearing somebody else's eyes");
{
  rt.localPlayer = 3;
  try {
    rt.forAudience(11, () => {
      throw new Error("a trigger blew up mid-evaluation");
    });
  } catch {
    /* expected */
  }
  // Without the finally, every later GetLocalPlayer in the match answers 11.
  check("the audience was restored despite the throw", whoAmI(), 3);
  check("…and the field itself is clear", rt.audience, null);
}

// ---------------------------------------------------------------------------------------
// Phase E item 7: `forAudience` gets its caller. A script BROADCAST reaches every screen,
// and each delivery is evaluated as that recipient.
// ---------------------------------------------------------------------------------------

const MAP_CONTROL_USER = 0, MAP_CONTROL_COMPUTER = 1;
const seat = (index, controller = MAP_CONTROL_USER) =>
  ({ index, raceIndex: 1, controller, team: 0, startLocation: index });

console.log("\nthe audience is who has a screen, which is not who has a viewpoint");
{
  rt.applyLobby([seat(0), seat(2, MAP_CONTROL_COMPUTER), seat(5)], 0);
  // A computer slot is simulated exactly like a human and DOES get a Viewpoint (it needs fog
  // for its acquisition gate). It does not get messages. The two lists disagree on purpose.
  check("only the human seats", JSON.stringify(rt.viewers()), "[0,5]");
}

console.log("\na broadcast reaches every seat, not just the host's");
{
  rt.applyLobby([seat(0), seat(5), seat(9)], 0);
  const got = [];
  rt.hooks = { displayText: (to, msg) => got.push(`${to}:${msg}`) };
  interp.callFunction("Broadcast", []);
  // Before item 7 this resolved `localViewer` once and pushed exactly one entry — the host's.
  // Players 5 and 9 were never told who won.
  // `%s` is the SUBJECT player's name, substituted once before the fan-out — every recipient
  // reads the same sentence, which is what makes it a broadcast rather than N messages.
  check("all three were told", JSON.stringify(got), '["0:Player 1 wins","5:Player 1 wins","9:Player 1 wins"]');
}

console.log("\neach delivery is evaluated AS its recipient");
{
  rt.applyLobby([seat(0), seat(5), seat(9)], 0);
  const seen = [];
  // THE check. The hook asks the runtime who the local player is at the moment it is called —
  // exactly what a host-side hook routing to a per-client transport would do. Dropping the
  // `forAudience` wrapper leaves the loop delivering to 0/5/9 while the runtime privately
  // answers "0" for all three, which is the desync class `audience` exists to prevent.
  rt.hooks = { displayText: (to) => seen.push(`${to}/${rt.localViewer}`) };
  interp.callFunction("Broadcast", []);
  check("recipient and localViewer agree throughout", JSON.stringify(seen), '["0/0","5/5","9/9"]');
  check("and the audience is clear afterwards", rt.audience, null);
}

console.log("\nwith nobody seated the message still lands on the host");
{
  rt.applyLobby([], 4); // a headless corpus run: no lobby, no seats
  const got = [];
  rt.hooks = { displayText: (to) => got.push(to) };
  interp.callFunction("Broadcast", []);
  // `viewers()` is legitimately empty here, and a broadcast that reached nobody would make
  // every single-player boot silently lose its victory message.
  check("falls back to this machine's own seat", JSON.stringify(got), "[4]");
}


// ---------------------------------------------------------------------------------------
// Item 7b: a MAP script's own GetLocalPlayer gate is evaluated ONCE PER RECIPIENT.
//
// Everything above is about the natives we intercept at the wrapper (the …ForPlayer BJs).
// This is the exposure that remained: a map writing `if GetLocalPlayer() == Player(N)` itself.
// The interpreter probes whether an `if`'s CONDITIONS consulted GetLocalPlayer and, if they
// did, re-runs the statement for every other viewer.
//
// The developer's decision on world writes: the HOST's pass runs exactly as it always has,
// and only the extra passes are muzzled. So a write inside a gate happens exactly ONCE --
// never N times (which would corrupt the authority's world) and never zero times (which would
// change behaviour for maps that work today).
// ---------------------------------------------------------------------------------------

console.log("\na map's own GetLocalPlayer gate is evaluated once per recipient (item 7b)");
{
  rt.applyLobby([seat(0), seat(5), seat(9)], 0);
  const cam = [];
  rt.hooks = { setCameraPosition: (x, y) => cam.push(`${x},${y}/${rt.localViewer}`) };
  interp.callFunction("GatedCamera", []);
  // Only player 5 is inside the gate -- but the host is player 0, so under the old
  // evaluate-once behaviour NOBODY got the camera move. Now player 5 does, and only 5.
  check("the gated call fires for the recipient it names", JSON.stringify(cam), '["1000,2000/5"]');
  check("and the audience is clear afterwards", rt.audience, null);
  check("and the write guard is off again", rt.presentationOnly, false);
}

console.log("\na world write inside the gate happens exactly ONCE, not once per recipient");
{
  rt.applyLobby([seat(0), seat(5), seat(9)], 0);
  // The condition is true for all three seats. Unmuzzled, this would set gold three times.
  const writes = [];
  rt.hooks = { setPlayerState: (p, st, v) => writes.push(`${p}:${v}/${rt.localViewer}`) };
  rt.worldWritingHooks = new Set(["setPlayerState"]);
  interp.callFunction("GatedWorldWrite", []);
  // THE check the decision is about. One write, and it is the HOST's own pass -- identical to
  // the behaviour before this item existed.
  check("exactly one world write, from the host's own pass", JSON.stringify(writes), '["0:500/0"]');
  rt.worldWritingHooks = new Set();
}

console.log("\nwithout the guard the same block would write once per recipient");
{
  // The counter-check, and it is what makes the one above mean something: with nothing
  // classified as world-writing, the muzzle has nothing to refuse and the write lands 3 times.
  // That is the corruption the developer's decision prevents, demonstrated rather than argued.
  rt.applyLobby([seat(0), seat(5), seat(9)], 0);
  const writes = [];
  rt.hooks = { setPlayerState: (p, st, v) => writes.push(`${p}:${v}/${rt.localViewer}`) };
  rt.worldWritingHooks = new Set(); // nothing declared -> nothing muzzled
  interp.callFunction("GatedWorldWrite", []);
  check("unguarded, it lands once per viewer", JSON.stringify(writes), '["0:500/0","0:500/5","0:500/9"]');
}

console.log("\nan if that never asks who is watching does not fan out");
{
  rt.applyLobby([seat(0), seat(5), seat(9)], 0);
  const cam = [];
  rt.hooks = { setCameraPosition: (x, y) => cam.push(`${x},${y}`) };
  interp.callFunction("Ungated", []);
  // The probe is what keeps this from becoming "every if runs N times".
  check("it runs exactly once", JSON.stringify(cam), '["7,7"]');
}

console.log("\nalready inside a forAudience, the gate does not fan out again");
{
  rt.applyLobby([seat(0), seat(5), seat(9)], 0);
  const cam = [];
  rt.hooks = { setCameraPosition: (x, y) => cam.push(`${x},${y}/${rt.localViewer}`) };
  // A broadcast already resolves who is watching, so GetLocalPlayer inside it is answering
  // correctly. Fanning out again would be N passes of the same block for the same person.
  rt.forAudience(5, () => interp.callFunction("GatedCamera", []));
  check("one pass, for the audience already set", JSON.stringify(cam), '["1000,2000/5"]');
}

// ---------------------------------------------------------------------------------------
// Phase F item 3: a hook that writes THE SCREEN IN FRONT OF THIS MACHINE is refused in an
// extra pass, exactly as a world write is — and for a sharper reason. The extra pass is being
// evaluated as somebody who is NOT sitting here, and there is only one camera.
//
// Found by driving a real two-window LAN game: blizzard.j calls SetCameraPositionForPlayer
// once per player at every melee start, the gate re-ran per recipient, and the LAST seat won.
// Both machines opened on seat 1's base — which the client got away with and the host did not.
// ---------------------------------------------------------------------------------------

console.log("\na camera move for somebody else's screen does not move MINE (item F3)");
{
  rt.applyLobby([seat(0), seat(5), seat(9)], 0);
  const cam = [];
  rt.hooks = { setCameraPosition: (x, y) => cam.push(`${x},${y}/${rt.localViewer}`) };
  rt.localViewHooks = new Set(["setCameraPosition"]);
  interp.callFunction("GatedCamera", []);
  // The gate names player 5; the human here is player 0. Before this, 5's pass reached the
  // hook and moved the camera on player 0's monitor.
  check("the gate is true for 5, so nothing happens here", JSON.stringify(cam), "[]");
  rt.localViewHooks = new Set();
}

console.log("\n…and the host's OWN pass still moves it");
{
  // The other half, and the half that stops the fix from being "never move the camera".
  // The gate has to be true for the person at the keyboard: seat the host AS player 5.
  rt.applyLobby([seat(0), seat(5), seat(9)], 5);
  const cam = [];
  rt.hooks = { setCameraPosition: (x, y) => cam.push(`${x},${y}/${rt.localViewer}`) };
  rt.localViewHooks = new Set(["setCameraPosition"]);
  interp.callFunction("GatedCamera", []);
  // Once, from the unmuzzled host pass — a melee start must still frame your own base.
  check("it fires once, for the human at this machine", JSON.stringify(cam), '["1000,2000/5"]');
  rt.localViewHooks = new Set();
}

console.log("\nthe refusal is scoped to the extra passes, not to the hook");
{
  // An UNGATED camera move never fans out, so it is never in a muzzled pass and must land
  // even while the hook is classified. Otherwise "classified" would quietly mean "disabled".
  rt.applyLobby([seat(0), seat(5), seat(9)], 0);
  const cam = [];
  rt.hooks = { setCameraPosition: (x, y) => cam.push(`${x},${y}`) };
  rt.localViewHooks = new Set(["setCameraPosition"]);
  interp.callFunction("Ungated", []);
  check("an ungated move still lands", JSON.stringify(cam), '["7,7"]');
  rt.localViewHooks = new Set();
}

// ---------------------------------------------------------------------------------------
// Phase G item 1: RemovePlayer is how the engine learns a game ended, and WHICH way.
//
// A defeat ends one player's game; anything else ends the MATCH, and only the second kind drops
// the wire -- a defeated player in a three-way is still watching somebody else's game. That
// decision reads the raw enum index, so the index has to survive the native intact. This is the
// check that stops a silent miscount of the kind that broke `mapcontrol`.
// ---------------------------------------------------------------------------------------

console.log("\nRemovePlayer reports who ended and how (item G1)");
{
  const got = [];
  rt.hooks = { playerGameOver: (p, result) => got.push(`${p}:${result}`) };
  interp.callFunction("EndVictory", []);
  // Both halves pinned: a hook that ignored its arguments and pushed a constant would pass an
  // equality against only one of them.
  check("a victory reports the player and result 0", JSON.stringify(got), '["0:0"]');
  interp.callFunction("EndDefeat", []);
  check("a defeat reports result 1, for the player it names", JSON.stringify(got), '["0:0","3:1"]');
}

console.log(failed ? `\naudience: ${failed} FAILED` : "\naudience: all checks passed");
process.exit(failed ? 1 : 0);
