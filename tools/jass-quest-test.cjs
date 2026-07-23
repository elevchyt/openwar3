// The Quest API — proven through Blizzard's own BJ layer, not just our natives.
//
// The point of loading the real Blizzard.j here: a map author types CreateQuestBJ /
// CreateQuestItemBJ / QuestMessageBJ, and every one of those is JASS in Scripts\Blizzard.j
// riding on the natives. If the BJs run clean against the real file, the natives have the
// signatures and the semantics the shipped code expects — which is a stronger check than any
// test we could write against our own registration table.
//
// Run: pnpm jass:test
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".jass-build", "src", "jass");
require("node:fs").writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, "headless.js"));

const WC3 = join(REPO, "Warcraft III");
const COMMON_J = readFileSync(join(WC3, "ExtractedData", "merged", "Scripts", "common.j"), "latin1");
const BLIZZARD_J = readFileSync(join(WC3, "ExtractedData", "merged", "Scripts", "Blizzard.j"), "latin1");

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// The shapes a campaign map's init trigger actually takes.
const SRC = `
globals
    quest     mainQuest = null
    questitem mainItem  = null
endglobals

function SetupQuests takes nothing returns nothing
    // bj_QUESTTYPE_REQ_DISCOVERED = 0 — a discovered main quest.
    set mainQuest = CreateQuestBJ(bj_QUESTTYPE_REQ_DISCOVERED, "The Defense of Strahnbrad", "Protect the village.", "ReplaceableTextures\\\\CommandButtons\\\\BTNFootman.blp")
    set mainItem = CreateQuestItemBJ(mainQuest, "Slay the bandit lord")
    // bj_QUESTTYPE_OPT_UNDISCOVERED = 3 — an optional quest nobody has found yet.
    call CreateQuestBJ(bj_QUESTTYPE_OPT_UNDISCOVERED, "The Secret", "Hidden.", "")
endfunction

function FinishIt takes nothing returns nothing
    call QuestItemSetCompletedBJ(mainItem, true)
    call QuestSetCompletedBJ(mainQuest, true)
    call QuestMessageBJ(bj_FORCE_ALL_PLAYERS, bj_QUESTMESSAGE_COMPLETED, "|cffffcc00MAIN QUEST COMPLETED|r")
endfunction

function Probe takes nothing returns boolean
    return IsQuestCompleted(mainQuest) and IsQuestItemCompleted(mainItem) and IsQuestDiscovered(mainQuest)
endfunction
`;

const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC]);
// InitBlizzardGlobals builds the bj_FORCE_* forces and the quest sting sound handles —
// QuestMessageBJ dereferences both, so the bootstrap the game itself runs has to run here.
interp.callFunction("InitBlizzard", []);
const rt = interp.rt;

console.log("CreateQuestBJ through the real Blizzard.j");
{
  const rev = rt.questsRevision;
  interp.callFunction("SetupQuests", []);
  check("two quests exist", rt.quests.length, 2);
  check("revision moved", rt.questsRevision > rev, true);
  const q = rt.quests[0];
  check("title landed", q.title, "The Defense of Strahnbrad");
  check("icon path landed", q.iconPath, "ReplaceableTextures\\CommandButtons\\BTNFootman.blp");
  check("REQ_DISCOVERED → required", q.required, true);
  check("REQ_DISCOVERED → discovered", q.discovered, true);
  check("a fresh quest is not completed (the BJ sets it so)", q.completed, false);
  check("one requirement item, described", q.items[0]?.description, "Slay the bandit lord");
  check("the item starts incomplete (the BJ sets it so)", q.items[0]?.completed, false);
  const opt = rt.quests[1];
  check("OPT_UNDISCOVERED → not required", opt.required, false);
  check("OPT_UNDISCOVERED → not discovered", opt.discovered, false);
}

console.log("\ncompletion, and QuestMessageBJ's flash");
{
  const flashes = rt.questFlashes;
  interp.callFunction("FinishIt", []);
  check("quest + item completed, still discovered", interp.callFunction("Probe", [])?.b, true);
  // QuestMessageBJ(COMPLETED) ends in FlashQuestDialogButton — through the real BJ body,
  // including the sting StartSound it takes on the way there.
  check("the Quests button was told to flash", rt.questFlashes > flashes, true);
}

console.log("\ndestroy and the log empties");
{
  interp.callFunction("DestroyQuestBJ", [rt.quests[0] && { k: "handle", h: rt.quests[0].handleId, t: "quest" }].filter(Boolean));
  check("one quest remains", rt.quests.length, 1);
}

console.log(failed ? `\n${failed} FAILED` : "\nall quest checks passed");
process.exit(failed ? 1 : 0);
