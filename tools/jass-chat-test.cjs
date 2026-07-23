// TriggerRegisterPlayerChatEvent — how every map that takes typed commands takes them.
//
// The whole feature is one match rule, and it is easy to get subtly wrong in ways that only
// show up on somebody else's map:
//
//   • `exactMatchOnly` TRUE  → the message must EQUAL the registered string.
//   • `exactMatchOnly` FALSE → the registered string is a PREFIX. This is the form that
//     carries an argument, and `GetEventPlayerChatStringMatched` hands back the prefix so the
//     action can slice it off and keep the rest ("-kick 3" → "3").
//   • an EMPTY string with exactMatchOnly false is a prefix of everything, which is the
//     documented idiom for "give me all of this player's chat".
//   • the registration names ONE player, and must not fire for anybody else.
//   • the comparison is case-SENSITIVE, as WC3's is.
//
// Headless, because none of that needs a browser and all of it needs to stay true.
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
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const SRC = `
globals
    string  heard   = ""
    string  matched = ""
    integer hits    = 0
    integer who     = -1
endglobals

function Note takes nothing returns nothing
    set hits    = hits + 1
    set heard   = GetEventPlayerChatString()
    set matched = GetEventPlayerChatStringMatched()
    set who     = GetPlayerId(GetTriggerPlayer())
endfunction

// "-ap" and nothing else, from player 0.
function SetupExact takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterPlayerChatEvent(t, Player(0), "-ap", true)
    call TriggerAddAction(t, function Note)
endfunction

// "-kick " as a PREFIX, from player 0 — the form that carries an argument.
function SetupPrefix takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterPlayerChatEvent(t, Player(0), "-kick ", false)
    call TriggerAddAction(t, function Note)
endfunction

// Everything player 1 says.
function SetupAll takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterPlayerChatEvent(t, Player(1), "", false)
    call TriggerAddAction(t, function Note)
endfunction

function Reset takes nothing returns nothing
    set hits    = 0
    set heard   = ""
    set matched = ""
    set who     = -1
endfunction
`;

const interp = buildInterpreter([SRC]);
const g = (name) => interp.rt.globals.get(name);
const say = (player, message) => interp.firePlayerChat(player, message);
const reset = () => interp.callFunction("Reset", []);

console.log("exactMatchOnly = true — equality, nothing else");
{
  interp.callFunction("SetupExact", []);
  reset();
  say(0, "-ap");
  check("the exact string fires it", g("hits")?.n, 1);
  check("GetEventPlayerChatString is what was said", g("heard")?.s, "-ap");
  check("GetTriggerPlayer is the speaker", g("who")?.n, 0);

  reset();
  say(0, "-ap all");
  check("a longer message does NOT fire an exact registration", g("hits")?.n, 0);

  reset();
  say(0, "-AP");
  check("the match is case-sensitive", g("hits")?.n, 0);

  reset();
  say(1, "-ap");
  check("another player saying it does not fire it", g("hits")?.n, 0);
}

console.log("\nexactMatchOnly = false — a prefix, and the argument survives");
{
  interp.callFunction("SetupPrefix", []);
  reset();
  say(0, "-kick 3");
  check("the prefix fires it", g("hits")?.n, 1);
  check("the FULL line is readable", g("heard")?.s, "-kick 3");
  check("…and the MATCHED half is the registered prefix", g("matched")?.s, "-kick ");
  check("so the argument is what is left", g("heard")?.s.slice(g("matched")?.s.length), "3");

  reset();
  say(0, "-kic");
  check("a message shorter than the prefix does not fire", g("hits")?.n, 0);
}

console.log("\nan empty prefix catches everything that player says");
{
  interp.callFunction("SetupAll", []);
  reset();
  say(1, "hello there");
  check("any message fires it", g("hits")?.n, 1);
  check("and reads back whole", g("heard")?.s, "hello there");

  reset();
  say(0, "hello there");
  check("but still only for the registered player", g("hits")?.n, 0);
}

console.log("\nthe registrations coexist");
{
  reset();
  say(0, "-ap");
  check("player 0's exact registration still fires on its own string", g("hits")?.n, 1);
}

console.log(failed ? `\n${failed} FAILED` : "\nall chat-event checks passed");
process.exit(failed ? 1 : 0);
