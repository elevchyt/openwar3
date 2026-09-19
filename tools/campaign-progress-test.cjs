// Headless check of WHAT THE CAMPAIGN SCREEN MAY SHOW (src/data/campaignProgress.ts).
//
// A campaign or a chapter this profile has not opened is not a greyed row — it is not on the
// screen at all, which is what the reference does and what the screen is now built from
// (`openCampaigns` / `openRows` are the two lists ui/fdfCampaign.ts lays out). That is a rule
// about a PROFILE's stored progress, so it is pinned here rather than in a screenshot: what a
// screenshot shows is the rows that were built, not the ones that were withheld.
//
// The fixtures are the real campaign indexes' own shape (UI\CampaignStrings.txt and
// UI\CampaignStrings_exp.txt): TFT opens the Sentinels and the Bonus campaign and holds the
// other two back, RoC opens the Prologue and the Human one, and both unlock in list order.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const C = require(join(REPO, ".sim-build", "src", "data", "campaignProgress.js"));

const entry = (header, name, file, mission) => ({
  header, name, file, mission, playable: /\.w3[mx]$/i.test(file),
});
const chapters = (n) => Array.from({ length: n }, (_, i) => entry(`Chapter ${i + 1}`, `Map ${i + 1}`, `M${i + 1}.w3x`, true));
const campaign = (key, defaultOpen, missions, extra = {}) => ({
  key, header: key, name: key, defaultOpen, missions,
  intro: null, open: null, end: null, ...extra,
});

// TFT's CampaignList order, and its two DefaultOpen=1 sections.
const tft = [
  campaign("NightElf", true, chapters(8), { open: entry("Cinematic", "The Awakening", "IntroX", false) }),
  campaign("Human", false, chapters(8)),
  campaign("Undead", false, chapters(14), { end: entry("Cinematic", "The Ascension", "OutroX", false) }),
  campaign("Orc", true, chapters(6)),
];
const names = (list) => list.map((x) => x.campaign.key);
const rows = (c) => C.openRows(c).map((r) => `${r.entry.name}#${r.mission}`);

console.log("a fresh profile sees only the campaigns the index opens");
{
  store.clear();
  check("TFT: the Sentinels and the Bonus campaign", names(C.openCampaigns(tft)), ["NightElf", "Orc"]);
  // RoC opens two as well, and its fifth unlocks four campaigns deep.
  const roc = [
    campaign("RoC.Tutorial", true, chapters(4)),
    campaign("RoC.Human", true, chapters(9)),
    campaign("RoC.Undead", false, chapters(8)),
    campaign("RoC.Orc", false, chapters(8)),
    campaign("RoC.NightElf", false, chapters(7)),
  ];
  check("RoC: the Prologue and the Human campaign", names(C.openCampaigns(roc)), ["RoC.Tutorial", "RoC.Human"]);
  C.markMissionComplete("RoC.Human", 8);
  check("finishing one opens the NEXT one only", names(C.openCampaigns(roc)),
    ["RoC.Tutorial", "RoC.Human", "RoC.Undead"]);
}

console.log("\na campaign appears when the one before it in the list is finished");
{
  store.clear();
  C.markMissionComplete("NightElf", 6); // seven of eight — not finished
  check("a part-finished campaign opens nothing", names(C.openCampaigns(tft)), ["NightElf", "Orc"]);
  C.markMissionComplete("NightElf", 7);
  check("its last chapter does", names(C.openCampaigns(tft)), ["NightElf", "Human", "Orc"]);
  check("…and no further", names(C.openCampaigns(tft)).includes("Undead"), false);
  // The list order is the file's, not the unlock order: the Bonus campaign stays at the bottom.
  C.markMissionComplete("Human", 7);
  check("the rows stay in CampaignList order", names(C.openCampaigns(tft)),
    ["NightElf", "Human", "Undead", "Orc"]);
}

console.log("\na chapter list grows one chapter at a time");
{
  store.clear();
  const sentinels = tft[0];
  check("a fresh campaign lists its opening cinematic and chapter one",
    rows(sentinels), ["The Awakening#-1", "Map 1#0"]);
  C.markMissionComplete("NightElf", 0);
  check("finishing chapter one lists chapter two", rows(sentinels),
    ["The Awakening#-1", "Map 1#0", "Map 2#1"]);
  check("and nothing further", rows(sentinels).length, 3);
  // Progress from a chapter reached by `ChangeLevel` credits everything up to it.
  C.markMissionComplete("NightElf", 4);
  check("a jump credits every chapter up to it", rows(sentinels).length, 1 + 6);
}

console.log("\nthe closing cinematic is the campaign's last word, not its first");
{
  store.clear();
  const scourge = tft[2];
  check("not listed with the campaign unfinished", rows(scourge).includes("The Ascension#-1"), false);
  C.markMissionComplete("Undead", 12); // thirteen of fourteen
  check("…nor with one chapter left", rows(scourge).includes("The Ascension#-1"), false);
  C.markMissionComplete("Undead", 13);
  check("listed once the last chapter is done", rows(scourge).slice(-1), ["The Ascension#-1"]);
  check("with every chapter above it", rows(scourge).length, 15);
}

console.log(failed === 0 ? "\nall good" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
