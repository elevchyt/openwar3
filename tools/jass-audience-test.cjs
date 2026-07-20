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

console.log(failed ? `\naudience: ${failed} FAILED` : "\naudience: all checks passed");
process.exit(failed ? 1 : 0);
