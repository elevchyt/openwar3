// Headless check of the map list's type-ahead search (issue #137) — ui/mapSearch.ts.
//
// The ranking is what decides whether typing "echo" at the Custom Game screen lands on Echo
// Isles or on Echo Isles Extreme, and whether typing at a list showing FrozenThrone can reach
// a map in Download. Both are pure functions of the entries, so they are pinned here rather
// than eyeballed in the browser.
//
// Run: pnpm sim:test  (it compiles src/ui/mapSearch.ts into .sim-build first)
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { bestMatch, norm } = require(join(REPO, ".sim-build", "src", "ui", "mapSearch.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A folder's worth of maps, as MapBrowser holds them: a path, its folder, and the label —
 *  the map's own name once its folder has been read, the file's stem until then. */
const entry = (folder, file, label) => ({
  path: `Maps\\${folder ? folder + "\\" : ""}${file}`,
  folder,
  label: label ?? file.replace(/\.w3x$/, ""),
});

const MAPS = [
  entry("FrozenThrone", "(2)EchoIsles.w3x", "Echo Isles"),
  entry("FrozenThrone", "(4)TurtleRock.w3x", "Turtle Rock"),
  entry("FrozenThrone", "(8)Deadlock.w3x", "Deadlock"),
  entry("FrozenThrone", "(4)TwistedMeadows.w3x", "Twisted Meadows"),
  entry("Scenario", "(2)Harvest.w3x", "Harvest"),
  entry("Download", "(4)EchoIslesExtreme.w3x"), // never opened: only the file name is known
  entry("Custom Maps", "FunnyBunny.w3x", "Funny Bunny's Egg Hunt"),
];
const found = (q, cwd) => bestMatch(MAPS, q, cwd)?.path ?? null;

console.log("map search — the map's own name, its file's name, and neither");
check("full name", found("turtle rock", "FrozenThrone"), "Maps\\FrozenThrone\\(4)TurtleRock.w3x");
check("a prefix of it", found("turt", "FrozenThrone"), "Maps\\FrozenThrone\\(4)TurtleRock.w3x");
// The file name is the ONLY name an unopened folder offers — and the "(4)" in front of it is
// the player-count badge, so it must not stand between the query and the name.
check("a file name, folder unread", found("echoislesextreme", "FrozenThrone"), "Maps\\Download\\(4)EchoIslesExtreme.w3x");
check("case is nothing", found("DeAdLoCk", "FrozenThrone"), "Maps\\FrozenThrone\\(8)Deadlock.w3x");
// Everything that is not a letter or a digit drops out of both sides, so the apostrophe and
// the spaces of "Funny Bunny's Egg Hunt" are not something anybody has to type exactly.
check("punctuation is nothing", found("funny bunnys egg", "FrozenThrone"), "Maps\\Custom Maps\\FunnyBunny.w3x");
check("no match at all", found("zzzz", "FrozenThrone"), null);
// One letter is a jump to a name that STARTS with it: "o" is inside half the maps in the
// install, and a first keystroke that lands on one of them at random is not a search.
check("one letter goes to a name that starts with it", found("t", "FrozenThrone"), "Maps\\FrozenThrone\\(4)TurtleRock.w3x");
check("one letter is never a substring", found("o", "FrozenThrone"), null);
// …and among two names that contain it, the shorter one is the closer fit ("Deadlock" over
// "Turtle Rock"), which is the coverage term rather than the tier.
check("two are", found("ock", "FrozenThrone"), "Maps\\FrozenThrone\\(8)Deadlock.w3x");
check("a bare space is not a search", found("   ", "FrozenThrone"), null);

console.log("map search — ranking");
// Two maps start with "echo"; the shorter name is the closer fit.
check("the shortest name a query fits", found("echo", "FrozenThrone"), "Maps\\FrozenThrone\\(2)EchoIsles.w3x");
// Every folder is searched, not only the open one.
check("another folder is reachable", found("harvest", "FrozenThrone"), "Maps\\Scenario\\(2)Harvest.w3x");
// The open folder breaks a TIE — both of these merely contain "rock"/"isles"…
check("the open folder wins a tie", found("isles", "Download"), "Maps\\Download\\(4)EchoIslesExtreme.w3x");
check("…and the same query from the other side", found("isles", "FrozenThrone"), "Maps\\FrozenThrone\\(2)EchoIsles.w3x");
// …but it does not let a loose match beat a tighter one: "harvest" IS a whole map's name in
// Scenario, while the open folder has nothing of the sort.
check("a tighter match elsewhere still wins", found("harvest", "Custom Maps"), "Maps\\Scenario\\(2)Harvest.w3x");

console.log("map search — normalisation");
check("norm strips and folds", norm(" (2)Echo Isles!"), "2echoisles");
check("norm of nothing", norm("  -- "), "");

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
