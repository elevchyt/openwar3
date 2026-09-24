// Headless check of a map's `war3mapSkin.txt` (src/data/mapSkin.ts — docs/map-compatibility.md,
// Test of Balance): its [CustomSkin] is a layer over UI\war3skins.txt for every race, its
// [FrameDef] a layer over the FrameDef string tables with TRIGSTR_ resolved, and both come down
// with the map. Against the developer's own copy of Test of Balance when it is in the install.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const B = (...p) => require(join(REPO, ".sim-build", "src", ...p));
const { parseMapSkin, setMapSkinOverlay, mapSkinOverlay, OverlaidStrings } = B("data", "mapSkin.js");
const { parseWar3Skins, skinValue } = B("data", "war3skins.js");
const { makeTrigStr } = B("data", "objectData.js");

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// A slice of the install's own war3skins.txt shape: [Default] + a race section.
const skins = parseWar3Skins([
  "[Default]", "IdlePeon=ReplaceableTextures\\CommandButtons\\BTNPeasant.blp", "SupplyIcon=UI\\Feedback\\Resources\\ResourceSupply.blp", "GoldIcon=UI\\Feedback\\Resources\\ResourceGold.blp",
  "[Orc]", "IdlePeon=ReplaceableTextures\\CommandButtons\\BTNPeon.blp",
].join("\n"));
const strings = new OverlaidStrings();
strings.set("UPKEEP_NONE", "|Cff00ff00No Upkeep");
strings.set("IDLE_PEON", "Idle Workers (|Cfffed312F8|R)");

console.log("the file");
const mine = parseMapSkin([
  "[CustomSkin]", "IdlePeon=ReplaceableTextures\\CommandButtons\\BTNStatUp.blp", "",
  "[FrameDef]", "UPKEEP_NONE=TRIGSTR_3837", "IDLE_PEON=Traits", "", "[SomethingElse]", "Ignored=1",
].join("\r\n"), (v) => (v === "TRIGSTR_3837" ? "|Cff00ff00Balanced" : v));
check("[CustomSkin] keys are read as written", [...mine.skins], [["IdlePeon", "ReplaceableTextures\\CommandButtons\\BTNStatUp.blp"]]);
check("[FrameDef] values have their TRIGSTR_ resolved; a literal passes through", [...mine.strings], [["UPKEEP_NONE", "|Cff00ff00Balanced"], ["IDLE_PEON", "Traits"]]);

console.log("\nno map (the menus)");
setMapSkinOverlay(null);
check("an Orc reads the Orc idle-worker art", skinValue(skins, "Orc", "IdlePeon"), "ReplaceableTextures\\CommandButtons\\BTNPeon.blp");
check("the string table reads the file", strings.get("UPKEEP_NONE"), "|Cff00ff00No Upkeep");

console.log("\nthe map's layer up");
setMapSkinOverlay(mine);
check("[CustomSkin] wins over the RACE section", skinValue(skins, "Orc", "IdlePeon"), "ReplaceableTextures\\CommandButtons\\BTNStatUp.blp");
check("…and over [Default], for every race", skinValue(skins, "Human", "IdlePeon"), "ReplaceableTextures\\CommandButtons\\BTNStatUp.blp");
check("a key it does not name is the install's", skinValue(skins, "Human", "GoldIcon"), "UI\\Feedback\\Resources\\ResourceGold.blp");
check("[FrameDef] wins in the string table", [strings.get("UPKEEP_NONE"), strings.get("IDLE_PEON")], ["|Cff00ff00Balanced", "Traits"]);
check("…and `has` agrees for a key only the map has", new OverlaidStrings().has("UPKEEP_NONE"), true);

console.log("\nthe map's layer down");
setMapSkinOverlay(null);
check("the install's art is back", skinValue(skins, "Human", "IdlePeon"), "ReplaceableTextures\\CommandButtons\\BTNPeasant.blp");
check("…and the file's words", strings.get("IDLE_PEON"), "Idle Workers (|Cfffed312F8|R)");
check("an empty file puts up no layer", (setMapSkinOverlay(parseMapSkin("[CustomSkin]\n")), mapSkinOverlay()), null);

const MAP = join(REPO, "Warcraft III", "Maps", "Download", "Test of Balance v1.24-4p.w3x");
console.log("\nTest of Balance's own war3mapSkin.txt");
if (!existsSync(MAP)) console.log("  skip  (map not in the install)");
else {
  const MpqArchive = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "mpq", "archive")).default;
  const a = new MpqArchive();
  a.load(new Uint8Array(readFileSync(MAP)), true);
  const text = new TextDecoder("utf-8").decode(a.get("war3mapSkin.txt").bytes());
  const skin = parseMapSkin(text, makeTrigStr(a.get("war3map.wts").bytes()));
  check("its three skin keys", [...skin.skins.keys()], ["IdlePeon", "InfoPanelIconArmorDivine", "SupplyIcon"]);
  check("the idle-worker button becomes Traits", skin.strings.get("IDLE_PEON"), "Traits (|Cfffed312F8|R)");
  check("the upkeep label becomes Balanced", skin.strings.get("UPKEEP_NONE"), "|Cff00ff00Balanced");
  check("the food counter becomes Difficulty Level", skin.strings.get("COLON_FOOD"), "Difficulty Level:");
  check("every one of its 13 strings resolved (no TRIGSTR_ left)", [skin.strings.size, [...skin.strings.values()].filter((v) => v.startsWith("TRIGSTR_")).length], [13, 0]);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall map-skin checks passed");
