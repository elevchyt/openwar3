// Headless check of Computer+ on WarChasers (src/ai/plus/warchasers/, docs/warchasers-ai.md).
// Run: pnpm sim:test
//
// Pinned here, because each breaks silently in a running match:
//
//  1. **The party's orders are understood** — "wait", "lets wait", "back", "lets go", "follow me",
//     "attack", "hit them" — however they are typed ("wiat", "folow", "atack", "lets goo").
//  2. **Ordinary chat is not an order.** "im back", "what", "shop", "nice hit", "be right back" and
//     "im waiting" must never stop or send a computer, and a negation turns an order round.
//  3. **A computer is named** by any word of its hero's name ("optimus wait").
//  4. **Items are valued for the hero carrying them**: an intelligence hero rates Intelligence over
//     Strength and gives the Strength up first; nobody ever gives up an Ankh; a key is never ours.
//  5. **The hero picker's geometry**: eight pedestals, none of them on the aisle the wisp walks up.
//
// Nothing here is Warcraft III's except what map.ts cites from the map itself.
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const chat = require(join(REPO, ".sim-build", "src", "ai", "plus", "warchasers", "chat.js"));
const items = require(join(REPO, ".sim-build", "src", "ai", "plus", "warchasers", "items.js"));
const map = require(join(REPO, ".sim-build", "src", "ai", "plus", "warchasers", "map.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}
const cmd = (s) => chat.readCommand(s)?.command ?? null;

// --- 1. orders -----------------------------------------------------------------------------------
const ORDERS = {
  wait: ["wait", "lets wait", "let's wait", "WAIT!!", "wiat", "waitt", "wai", "hold on", "hang on", "stop", "stay here", "one sec", "wait up", "hold"],
  back: ["back", "back!", "bakc", "bak", "go back", "fall back", "get back", "retreat", "retreet", "run", "get out"],
  go: ["lets go", "let's go", "lets goo", "letsgo", "go", "go go go", "gogo", "come on", "move", "push", "dont wait", "stop waiting", "no need to wait"],
  follow: ["follow me", "follow", "folow", "fallow me", "follwo", "come", "come back", "on me", "with me", "i lead", "im the leader"],
  attack: ["attack", "atack", "attak", "hit", "hit them", "hti them", "kill them", "get them", "charge", "fight"],
};
for (const [want, lines] of Object.entries(ORDERS)) for (const said of lines) check(`${JSON.stringify(said)} is ${want}`, cmd(said), want);
check("the last order in a line wins", cmd("wait... ok lets go"), "go");
check("dont go is a wait", cmd("dont go"), "wait");
check("stop attacking is a wait", cmd("stop attacking"), "wait");
check("follow me takes the lead", chat.readCommand("follow me"), { command: "follow", claimsLead: true });
check("follow does not", chat.readCommand("follow"), { command: "follow", claimsLead: false });

// --- 2. not orders -------------------------------------------------------------------------------
for (const said of [
  "im back", "be right back", "what", "shop", "yellow", "hollow", "no", "ok", "gg", "lol", "thanks", "good job", "the hut",
  "hot", "nice hit", "im waiting", "attacking now", "where are you going", "i need gold", "buy an ankh", "",
]) check(`${JSON.stringify(said)} is not an order`, cmd(said), null);
check("a typo is not a different word", chat.sounds("what", "wait"), false);
check("…but a slip of the finger is the word", chat.sounds("waot", "wait"), true);
check("a short word must be exact or swapped", chat.sounds("hot", "hit"), false);
check("…swapped", chat.sounds("hti", "hit"), true);

// --- 3. naming a computer ------------------------------------------------------------------------
check("named by the first word", chat.namesHero("optimus wait", "Optimus Primo"), true);
check("named by the second word", chat.namesHero("beast knight attack", "Beast Knight"), true);
check("named with a typo", chat.namesHero("megatron go", "Megotron X"), true);
check("named through the hyphen", chat.namesHero("mumm rah back", "Mumm-Rah"), true);
check("a line naming nobody names nobody", chat.namesHero("wait", "Optimus Primo"), false);
check("an order word is not a name", chat.namesHero("attack", "Assassin"), false);

// --- 4. items ------------------------------------------------------------------------------------
const lvl = (data) => ({ data });
const ABILITIES = new Map([
  ["AIs3", { code: "AIab", levelData: [lvl([0, 0, 3])] }], // +3 Strength
  ["AIi6", { code: "AIab", levelData: [lvl([0, 6, 0])] }], // +6 Intelligence
  ["AIa6", { code: "AIab", levelData: [lvl([6, 0, 0])] }], // +6 Agility
  ["AIat", { code: "AIat", levelData: [lvl([3])] }],
  ["AIrc", { code: "AIrc", levelData: [lvl([7, 500])] }],
  ["AIh2", { code: "AIhe", levelData: [lvl([500])] }],
]);
const def = (id, abilities, gold, extra = {}) => ({ id, abilities, gold, usable: false, powerup: false, droppable: true, ...extra });
const ITEMS = new Map([
  ["rst1", def("rst1", ["AIs3"], 100)],
  ["ciri", def("ciri", ["AIi6"], 400)],
  ["rag1", def("rag1", ["AIa6"], 400)],
  ["rat3", def("rat3", ["AIat"], 50)],
  ["ankh", def("ankh", ["AIrc"], 450)],
  ["IC17", def("IC17", [], 5000)],
  ["pghe", def("pghe", ["AIh2"], 400, { usable: true })],
  ["kymn", def("kymn", [], 200)],
  ["stwp", def("stwp", [], 350, { usable: true })],
]);
const eye = (primary, melee = false) => ({ ability: (id) => ABILITIES.get(id), primary, melee });
const INT = eye("INT");
const STR = eye("STR", true);
const item = (id) => ITEMS.get(id);
const v = (id, e) => items.itemValue(ITEMS.get(id), e);
check("an intelligence hero rates Intelligence over Strength", v("ciri", INT) > v("rst1", INT) + 10, true);
check("…and over Agility", v("ciri", INT) > v("rag1", INT), true);
check("a strength hero rates the other way", v("rst1", STR) > v("rst1", INT), true);
check("an Ankh is worth more than anything", v("ankh", INT), items.ANKH_VALUE);
check("…by what it does, whatever its id", items.isAnkh(def("xxxx", ["AIrc"], 0), (id) => ABILITIES.get(id)), true);
check("the map's Ankh of Reincarnation Deluxe is one", v("IC17", STR), items.ANKH_VALUE);
check("a key is never ours", v("kymn", STR), items.NOT_OURS);
const full = ["ankh", "rst1", "rag1", "rag1", "pghe", "pghe"].map((itemId) => ({ itemId }));
check("full belt: a Robe of the Magi replaces a Strength item for an intelligence hero",
  full[items.wantsItem(ITEMS.get("ciri"), full, item, INT)?.replace]?.itemId, "rst1");
check("…and the Ankh is never the slot given up", items.worstSlot(full, item, INT).itemId !== "ankh", true);
check("a strength hero does not swap its gauntlets for a robe", items.wantsItem(ITEMS.get("ciri"), ["ankh", "rst1", "rst1", "rst1", "rst1", "rst1"].map((itemId) => ({ itemId })), item, STR), null);
check("a key is not picked up", items.wantsItem(ITEMS.get("kymn"), [null, null], item, STR), null);
check("a free slot takes a gold trinket", items.wantsItem(ITEMS.get("stwp"), [{ itemId: "ankh" }, null], item, STR)?.replace, -1);
check("…a full belt does not throw an item away for one", items.wantsItem(ITEMS.get("stwp"), full, item, STR), null);
const ankhOnly = [{ itemId: "ankh" }, { itemId: "ankh" }, { itemId: "ankh" }, { itemId: "ankh" }, { itemId: "ankh" }, { itemId: "ankh" }];
check("nothing replaces a belt of Ankhs", items.wantsItem(ITEMS.get("ciri"), ankhOnly, item, INT), null);

// --- 5. the picker ---------------------------------------------------------------------------------
check("eight heroes", map.PICKS.length, 8);
check("eight different heroes", new Set(map.PICKS.map((p) => p.hero)).size, 8);
check("a skill order for every hero", map.PICKS.every((p) => (map.SKILLS[p.hero] ?? []).length === 4), true);
check("the aisle crosses no pedestal", map.PICKS.every((p) => map.PICK_AISLE_X < p.rect.minX || map.PICK_AISLE_X > p.rect.maxX), true);
check("the four hero seats", [...map.HERO_SEATS], [0, 1, 5, 6]);
check("recognised by its triggers", map.isWarChasersScript(new Set(map.WARCHASERS_SCRIPT_MARKERS)), true);
check("…all four of them", map.isWarChasersScript(new Set(map.WARCHASERS_SCRIPT_MARKERS.slice(1))), false);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall WarChasers AI checks passed");
