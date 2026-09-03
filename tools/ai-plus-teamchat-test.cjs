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
  readAllyCall, namedColour, namedRace, namedPlayer, playerNames, plural, switchLine, openerLine,
  attackLine,
  HELP_CALLS, COMING_LINES, PORTAL_LINES, BUSY_LINES, JOIN_LINES, COLOUR_NAMES, RACE_WORDS,
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
for (const said of [
  ...COMING_LINES, ...PORTAL_LINES, ...Object.values(BUSY_LINES).flat(), ...JOIN_LINES,
  ...COLOUR_NAMES.flatMap((c) => attackLine(c)),
]) {
  const got = readAllyCall(said);
  check(`its own answer is not a call: ${JSON.stringify(said)}`, got === "help", false);
}
// …and everything it ASKS with must read as one, or a computer could never call another computer.
for (const said of HELP_CALLS) check(`its own call is a call: ${JSON.stringify(said)}`, readAllyCall(said), "help");

// --- who it is hitting, and who is coming with it ----------------------------------------------
//
// The same loop guard, one step further out. An ATTACK announcement and the answer to it travel
// on the channel the calls for help do, so each has to read as itself and as nothing else — and
// the two ways this breaks are both here: "im coming with you" contains the word every "on my
// way" is recognised by, and "i'm under attack from multiple sides, need help" contains the word
// every attack announcement is recognised by. The colour is what tells the second pair apart.
for (const colour of COLOUR_NAMES) {
  for (const said of attackLine(colour)) {
    check(`an attack call is an attack call: ${JSON.stringify(said)}`, readAllyCall(said), "attack");
    check(`…and it names ${colour}`, namedColour(said), COLOUR_NAMES.indexOf(colour));
  }
}
for (const said of JOIN_LINES) {
  check(`joining is joining, not coming: ${JSON.stringify(said)}`, readAllyCall(said), "joining");
}
for (const said of [
  "im going to hit blue", "attacking yellow's base", "hitting RED now", "lets push green",
  "going in on light blue", "im rushing brown",
]) check(`hears an attack call: ${JSON.stringify(said)}`, readAllyCall(said), "attack");

// An attack call with no colour in it is not one — which is what keeps the file's OWN request
// for help ("i'm under attack from multiple sides") out of this reading.
for (const said of ["attack now", "im attacking", "lets push"]) {
  check(`no colour, no attack call: ${JSON.stringify(said)}`, readAllyCall(said) === "attack", false);
}

// Longest match first, or every call to hit light blue is heard as a call to hit blue — a
// different player, usually on the other side of the map.
check("light blue is not blue", namedColour("im going to hit light blue"), 9);
check("blue is blue", namedColour("im going to hit blue"), 1);
check("light gray is gray", namedColour("hitting light gray"), 8);
check("grey is the install's gray", namedColour("hitting grey"), 8);
check("teal is what everybody calls cyan", namedColour("attacking teal"), 2);
check("no colour named", namedColour("attacking now"), -1);
check("the names are the install's, in the install's order", COLOUR_NAMES.join(","),
  "red,blue,cyan,purple,yellow,orange,green,pink,light gray,light blue,aqua,brown");

// --- naming a player by RACE, and by where they sit --------------------------------------------
//
// The name a computer points its teammates at an opponent with. Three things are pinned, and the
// first two are the ones that would ruin a match rather than a line of chat: a phrase this file
// WRITES must resolve back to the seat it was written about (the army walks at whatever comes
// out), and a race TWO players are playing must never resolve to one of them by accident. The
// third is the readable half — a position nobody needs is not said at all.
//
// Both ends run `playerNames` over the same seats with the speaker left out, so these tests build
// the seat list the way `ComputerPlusAi.namesFor` does. `+y is north`, as everywhere else.
const seat = (player, race, x, y) => ({ player, race, x, y });

// One of each race: nobody needs a position.
{
  const names = playerNames([
    seat(1, "human", 0, 0), seat(2, "undead", 0, 5000), seat(3, "orc", 5000, 0),
  ]);
  check("one of a race is just the race", names.get(2).phrase, "the undead");
  check("…and no position is said", names.get(2).spot, null);
  check("the night elf is two words", RACE_WORDS.nightelf, "night elf");
  for (const said of attackLine(names.get(2).phrase)) {
    check(`a race attack call is an attack call: ${JSON.stringify(said)}`, readAllyCall(said), "attack");
    check("…and it names the undead seat", namedPlayer(said, names), 2);
  }
  check("a race nobody is playing names nobody", namedPlayer("im going to hit the orc", playerNames([seat(1, "human", 0, 0)])), -1);
}

// Two of a race: the axis they are spread along names them.
{
  const names = playerNames([seat(2, "undead", 0, 5000), seat(3, "undead", 0, -5000)]);
  check("two of a race: the top one", names.get(2).phrase, "the undead at the top");
  check("two of a race: the bottom one", names.get(3).phrase, "the undead at the bottom");
  check("…and the top phrase names the top seat", namedPlayer(attackLine(names.get(2).phrase)[0], names), 2);
  check("…and the bottom phrase names the bottom seat", namedPlayer(attackLine(names.get(3).phrase)[0], names), 3);
  // The whole reason a position is said at all: without one the line names nobody rather than
  // marching an army at whichever seat was scanned first.
  check("no position, no seat", namedPlayer("im going to hit the undead", names), -1);
}
{
  const names = playerNames([seat(2, "orc", -5000, 0), seat(3, "orc", 5000, 0)]);
  check("spread left-to-right is left and right", names.get(2).phrase, "the orc on the left");
  check("…and the other one", names.get(3).phrase, "the orc on the right");
}

// Three: the one in between is the middle, which is the developer's own example.
{
  const names = playerNames([
    seat(1, "human", -5000, 0), seat(2, "human", 0, 0), seat(3, "human", 5000, 0),
  ]);
  check("three across: left", names.get(1).phrase, "the human on the left");
  check("three across: middle", names.get(2).phrase, "the human in the middle");
  check("three across: right", names.get(3).phrase, "the human on the right");
  check("…and the middle resolves", namedPlayer("im going to hit the human in the middle", names), 2);
}

// Four: both axes at once — and "in the top left" contains "top", which is why the scan is
// longest-first (`namedColour` needs the same rule for light blue).
{
  const names = playerNames([
    seat(1, "undead", -5000, 5000), seat(2, "undead", 5000, 5000),
    seat(3, "undead", -5000, -5000), seat(4, "undead", 5000, -5000),
  ]);
  check("four: top left", names.get(1).phrase, "the undead in the top left");
  check("four: bottom right", names.get(4).phrase, "the undead in the bottom right");
  check("…and top left is not the top", namedPlayer("im going to hit the undead in the top left", names), 1);
  check("…and a bare 'top' with four of them names nobody", namedPlayer("im hitting the undead at the top now", names), -1);
}

// Two starts the map cannot separate name NEITHER of them — the caller falls back to the colour,
// because a name that fits two players is worse than a swatch.
{
  const names = playerNames([
    seat(1, "orc", -5000, 5000), seat(2, "orc", -4900, 4900),
    seat(3, "orc", -5000, -5000), seat(4, "orc", 5000, -5000),
  ]);
  check("a crowded quarter names neither", names.has(1) || names.has(2), false);
  check("…and the seats it can name are still named", names.get(4).phrase, "the orc in the bottom right");
}

// Reading the race out of a line, in the spellings people type.
check("race: undead", namedRace("im going to hit the undead"), "undead");
check("race: ud", namedRace("hitting ud now"), "undead");
check("race: night elf", namedRace("going in on the night elf"), "nightelf");
check("race: elves", namedRace("attacking the elves"), "nightelf");
check("race: orcs", namedRace("lets push the orcs"), "orc");
check("no race named", namedRace("attacking now"), null);
// …and the file's own calls for help name nobody, which is what keeps them out of this reading.
for (const said of HELP_CALLS) check(`a call for help names no race: ${JSON.stringify(said)}`, namedRace(said), null);

// --- saying what it is building ----------------------------------------------------------------
// The name is always the game's (`UnitDef.name`); only the shape is ours.
check("plural: regular", plural("Knight"), "knights");
check("plural: -man", plural("Rifleman"), "riflemen");
check("plural: -man again", plural("Footman"), "footmen");
// …and the word that merely ENDS in "man" — Orc08's own war3map.j writes "priests and shamans".
check("plural: -man that is not one", plural("Shaman"), "shamans");
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
