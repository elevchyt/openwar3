// WHICH AI a computer seat gets (src/game/aiSeating.ts, docs/computer-plus.md, docs/melee-ai.md).
//
// The rule this pins above all: a CAMPAIGN chapter's computers are always Blizzard's — the
// chapter's own `.ai` script, or a race port if a chapter ever names one — and NEVER Computer+,
// whatever a slot, a preference, a LAN lobby or a dev boot put on the seat, and whatever the
// chapter's w3i melee flag says. It is enforced twice: `armAiSeats` clears the flag when the match
// is armed, and `pickAi` refuses it again at the seat. Both are checked here on their own, so
// neither can quietly become the only guard.
//
// Around it, the rest of the decision `RtsController.startMeleeAIFor` acts on: a map's or a
// chapter's own script is RUN (never replaced by a race AI), the race files are matched by
// basename, Computer+ is refused on a custom map, and granted on a melee skirmish seat that asked.
//
// Run: pnpm sim:test
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const REPO = join(__dirname, "..");
writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { armAiSeats, pickAi } = require(join(REPO, ".sim-build", "src", "game", "aiSeating.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const seat = (player, race, plus) => ({ player, race, startX: 0, startY: 0, difficulty: 2, ...(plus === undefined ? {} : { plus }) });
const CAMPAIGN = { melee: false, campaign: true };
const CAMPAIGN_MELEE_FLAG = { melee: true, campaign: true }; // a chapter whose w3i sets the melee flag
const SKIRMISH = { melee: true, campaign: false };
const CUSTOM = { melee: false, campaign: false };

console.log("a campaign chapter: armAiSeats clears every seat's Computer+ flag");
const slots = [seat(1, "human", true), seat(2, "orc", false), seat(3, "undead")];
const armed = armAiSeats(slots, true);
check("every armed seat reads plus=false or unset", armed.map((s) => s.plus === true), [false, false, false]);
check("…and nothing else about a seat changes", armed.map((s) => [s.player, s.race, s.difficulty]), [[1, "human", 2], [2, "orc", 2], [3, "undead", 2]]);
check("the lobby's own slot objects are not written to", slots[0].plus, true);
check("outside a campaign the flags are the lobby's, untouched", armAiSeats(slots, false).map((s) => s.plus === true), [true, false, false]);

console.log("\na campaign chapter: pickAi refuses Computer+ at the seat as well");
// The seat still carrying the flag is the case armAiSeats exists to prevent — pickAi must hold
// on its own, or the rule lives in one caller.
for (const file of ["human.ai", "orc.ai", "undead.ai", "elf.ai", "Scripts\\human.ai"]) {
  const pick = pickAi(file, seat(1, "human", true), CAMPAIGN);
  check(`${file} on a Computer+ seat → Blizzard's melee AI, refused for "campaign"`, [pick.ai, pick.plusRefused], ["melee", "campaign"]);
}
check("…even on a chapter whose w3i sets the melee flag", pickAi("orc.ai", seat(1, "orc", true), CAMPAIGN_MELEE_FLAG), { ai: "melee", race: "orc", plusRefused: "campaign" });
check("a chapter's own file (StartCampaignAI) is RUN", pickAi("o03_blue.ai", seat(1, "human", true), CAMPAIGN), { ai: "script" });
check("…and so is one a TFT chapter names through StartMeleeAI", pickAi("h02x03.ai", seat(2, "undead", true), CAMPAIGN_MELEE_FLAG), { ai: "script" });
check("…its name in any case (HumanX01's \"H01X05.ai\")", pickAi("H01X05.ai", seat(5, "undead", true), CAMPAIGN), { ai: "script" });
check("the whole path, armed then picked, never yields Computer+", armAiSeats(slots, true).every((s) =>
  ["human.ai", "orc.ai", "undead.ai", "elf.ai"].every((f) => pickAi(f, s, CAMPAIGN_MELEE_FLAG).ai !== "plus")), true);

console.log("\noutside a campaign");
check("a melee skirmish seat that asked for Computer+ gets it", pickAi("human.ai", seat(1, "human", true), SKIRMISH), { ai: "plus", race: "human" });
check("…and the race comes from the FILE, as in the original", pickAi("elf.ai", seat(1, "human", true), SKIRMISH), { ai: "plus", race: "nightelf" });
check("a seat that did not ask gets Blizzard's AI", pickAi("orc.ai", seat(1, "orc"), SKIRMISH), { ai: "melee", race: "orc", plusRefused: null });
check("a custom map refuses Computer+ (said once, in the log)", pickAi("undead.ai", seat(1, "undead", true), CUSTOM), { ai: "melee", race: "undead", plusRefused: "custom" });
check("a map's own script is run, never a race AI ((4)Monolith)", pickAi("war3mapImported\\Murloc_AI.ai", seat(4, "nightelf", true), SKIRMISH), { ai: "script" });

console.log(failed ? `\nai-seating: ${failed} FAILED` : "\nai-seating: all checks passed");
process.exit(failed ? 1 : 0);
