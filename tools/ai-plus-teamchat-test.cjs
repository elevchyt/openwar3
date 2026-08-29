// Headless check of what Computer+ says to its ALLIES, and what it hears them say
// (src/ai/plus/teamchat.ts). Run: pnpm sim:test
//
// Two things are pinned here, and both are the kind that break silently in a running game where
// nobody would notice for a session:
//
//  1. **The parser does not eat its own vocabulary.** Every line this file says goes out on the
//     same channel every other computer is listening on, so a decline that reads as a request
//     ("i can't come there right now") makes two computers answer each other's answers until the
//     match ends. That is a loop, not a bug you see once — so every line in the file's own
//     tables is run through `readAllyCall` below and required NOT to be a call for help. The
//     asking lines are required to be one, since AI-to-AI help travels by exactly that route.
//  2. **A call is recognised however it is typed.** Caps, punctuation, and the shorthand people
//     actually use under pressure. The false direction matters more than the true one: a wrong
//     positive marches an army across the map.
//
// None of the numbers or words here are Warcraft III's — nothing in the install describes a
// computer that talks (docs/computer-plus.md) — so this pins OUR ruling.
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const {
  readAllyCall, plural, switchLine, openerLine,
  HELP_CALLS, COMING_LINES, PORTAL_LINES, BUSY_LINES,
} = require(join(REPO, ".sim-build", "src", "ai", "plus", "teamchat.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// --- hearing a call ---------------------------------------------------------------------------
// Caps-agnostic and punctuation-agnostic is the request in as many words, so it is the first
// thing tested and it is tested in the forms a person actually types.
for (const said of [
  "help", "HELP", "Help!", "help me", "HELP ME!!", "help me please", "plz help", "pls help me",
  "i need help", "need help", "halp", "hlp", "sos", "help-me", "  help   me  ",
  "need backup", "come here", "come here quick", "im dying", "i'm dying", "i am losing",
]) check(`hears a call: ${JSON.stringify(said)}`, readAllyCall(said), "help");

// …and the other direction, which matters more. A word that merely CONTAINS "help" is not one.
for (const said of ["", "gg", "glhf", "nice one", "that helped", "helping you", "helpful", "attack now"]) {
  check(`not a call: ${JSON.stringify(said)}`, readAllyCall(said), null);
}
// A DECLINE contains the word and is not a request — with or without the apostrophe, which the
// fold turns into a space (so "can't" arrives as "can t" and needs its own alternative).
for (const said of ["no help needed", "i cant help right now", "i can't help right now", "i'm busy"]) {
  check(`a decline, not a call: ${JSON.stringify(said)}`, readAllyCall(said), "busy");
}

// --- it does not eat its own vocabulary --------------------------------------------------------
// The loop guard. Everything the file ANSWERS with must read as anything except a request.
for (const said of [...COMING_LINES, ...PORTAL_LINES, ...Object.values(BUSY_LINES).flat()]) {
  const got = readAllyCall(said);
  check(`its own answer is not a call: ${JSON.stringify(said)}`, got === "help", false);
}
// …and everything it ASKS with must read as one, or a computer could never call another computer.
for (const said of HELP_CALLS) check(`its own call is a call: ${JSON.stringify(said)}`, readAllyCall(said), "help");

// --- saying what it is building ----------------------------------------------------------------
// The name is always the game's (`UnitDef.name`); only the shape is ours.
check("plural: regular", plural("Knight"), "knights");
check("plural: -man", plural("Rifleman"), "riflemen");
check("plural: -man again", plural("Footman"), "footmen");
check("plural: sibilant", plural("Huntress"), "huntresses");
check("plural: -ch", plural("Batrider"), "batriders");
check("plural: consonant + y", plural("Harpy"), "harpies");
check("plural: vowel + y", plural("Hippogryph"), "hippogryphs");
// The one that reads as a machine wrote it if the head is not pluralized.
check("plural: head of an 'of' name", plural("Druid of the Claw"), "druids of the claw");
check("plural: head of an 'of' name (talon)", plural("Druid of the Talon"), "druids of the talon");

check("opener: one unit", openerLine(["Footman"]), "i'm going footmen");
check("opener: two", openerLine(["Footman", "Rifleman"]), "i'm going footmen and riflemen");
check("opener: three", openerLine(["Dryad", "Druid of the Claw", "Huntress"]),
  "i'm going dryads, druids of the claw and huntresses");
check("opener: nothing to say", openerLine([]), "");

check("opener", switchLine("Footman", null, true), "going footmen");
check("switch", switchLine("Knight", null, false), "switching to knights");
check("switch, and why", switchLine("Hippogryph", "air", false), "switching to hippogryphs to counter their air units");
check("opener, and why", switchLine("Rifleman", "counter", true), "going riflemen to counter their army");

console.log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);
