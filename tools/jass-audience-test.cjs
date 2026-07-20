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

console.log(failed ? `\naudience: ${failed} FAILED` : "\naudience: all checks passed");
process.exit(failed ? 1 : 0);
