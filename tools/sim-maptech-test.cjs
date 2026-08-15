// Headless check of the MAP's own TECH TREE — the per-map overlay on TechRegistry
// (src/data/objectData.ts `applyMapTechData`, src/data/techtree.ts).
//
// The bug it pins: a custom map's buildings had EMPTY command cards. Everything a building
// offers — Trains, Sellunits, Sellitems, Makeitems, Researches, Builds, Upgrade — is a Profile
// field (UnitMetaData.slk says `slk = Profile` for every one of them), which is exactly what a
// map's war3map.w3u overrides. The registry was built once from the install's *UnitFunc.txt and
// never merged with the map's object data, so every type a map declares answered "trains
// nothing, sells nothing" and buildCommandCard had nothing to draw. Reported on "WTii's Unit
// Tester", which is ~105 pre-placed Human Farms (`hhou`) whose entire content is a `Sellunits`
// list — every one of them came up blank.
//
// The w3u/w3t/w3q blobs here are BUILT, not read off disk, so the check runs on any machine
// (the developer's install is gitignored). The shapes they encode are the real map's: a custom
// clone of a stock shop, a Farm turned into a unit shop, a stat-only override that must NOT
// reach the graph, and an upgrade whose per-LEVEL requirement is cleared.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { TechRegistry } = require(join(REPO, ".sim-build", "src", "data", "techtree.js"));
const { applyMapTechData } = require(join(REPO, ".sim-build", "src", "data", "objectData.js"));

const W3u = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "w3x", "w3u", "file")).default;
const W3d = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "w3x", "w3d", "file")).default;
const ModifiedObject = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "w3x", "w3u", "modifiedobject")).default;
const Modification = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "w3x", "w3u", "modification")).default;

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// --- building the object files ---------------------------------------------------
//
// `variableType` 3 = string, 0 = int (parsers/w3x/w3u/modification.js). A level-indexed file
// (.w3a/.w3q) carries `levelOrVariation` on every modification; a flat one (.w3u/.w3t) does not.
const NO_ID = "\0\0\0\0"; // what an ORIGINAL-table object carries where a custom one has its rawcode
function mod(id, value, level = 0) {
  const m = new Modification();
  m.id = id;
  m.variableType = typeof value === "number" ? 0 : 3;
  m.value = value;
  m.levelOrVariation = level;
  return m;
}
function obj(oldId, newId, mods) {
  const o = new ModifiedObject();
  o.oldId = oldId;
  o.newId = newId;
  o.modifications = mods;
  return o;
}
function build(File, customs, originals) {
  const f = new File();
  f.version = 2;
  f.customTable.objects = customs;
  f.originalTable.objects = originals;
  return f.save();
}

// --- the install graph (the shape loadTechRegistry produces) ----------------------
const node = (id, over = {}) => ({
  id, name: id, requiresTiers: [[]], requiresAmount: [], dependencyOr: [],
  trains: [], researches: [], builds: [], upgrade: [], makeitems: [], sellitems: [],
  sellunits: [], revive: false, ...over,
});
const baseDefs = () => new Map([
  // A stock Tavern: eight heroes, each gated on an altar and on the hall tier.
  ["ntav", node("ntav", { name: "Tavern", sellunits: ["Nalc", "Nfir", "Nbrn"] })],
  ["Nfir", node("Nfir", { name: "Firelord", requiresTiers: [["TALT"], ["TWN2", "TALT"], ["TWN3", "TALT"]] })],
  // A Human Farm — art and food only. It has NO tech node in the install at all, which is the
  // case that mattered: `loadTechRegistry` drops rows that say nothing about the tech tree.
  ["htow", node("htow", { name: "Town Hall", trains: ["hpea"], upgrade: ["hkee"] })],
  ["hkee", node("hkee", { name: "Keep" })],
  ["Rhme", node("Rhme", { name: "Forged Swords", requiresTiers: [[], ["hkee"], ["hcas"]] })],
]);

console.log("\n[map tech] a map's own Trains/Sell*/Researches/Builds/Requires reach the tech graph");
{
  const tech = new TechRegistry(baseDefs());

  // The real map's four shapes, in one w3u.
  const w3u = build(
    W3u,
    [
      // A Farm turned into a unit shop — the tester map's whole content. No base tech node.
      obj("hhou", "h00C", [mod("unam", "Orc Units"), mod("useu", "opeo,ogru,orai"), mod("uabi", "Avul")]),
      // A clone of a STOCK shop that overrides nothing tech-shaped: it must still inherit the
      // Tavern's wares, or a map that merely renames a Tavern loses its heroes.
      obj("ntav", "n001", [mod("unam", "Hero Tavern")]),
      // A clone that REPLACES the inherited list rather than adding to it.
      obj("ntav", "n002", [mod("useu", "Nalc")]),
      // An altar: Trains + Revive, and a `Requires` ladder grown past what the base declares.
      obj("hhou", "h006", [mod("utra", "Hapm,Hant"), mod("urev", 1), mod("urqc", 3), mod("urq2", "hkee")]),
      // A builder whose Builds list is the map's own.
      obj("hpea", "h01W", [mod("ubui", "nfoh,ntav,ngol")]),
      // A tier chain the map declares itself.
      obj("htow", "h02X", [mod("uupt", "h02Y")]),
    ],
    [
      // Clearing a field in the object editor is how a map says "no requirements at all" —
      // an EMPTY string is a value, not an absence. This is what lets the tester's Tavern
      // sell heroes with no altar standing.
      obj("Nfir", NO_ID, [mod("ureq", ""), mod("urq1", ""), mod("urq2", "")]),
      // A pure stat/art override must NOT put a node in the graph.
      obj("htow", NO_ID, [mod("uhpm", 2000), mod("umdl", "Buildings\\Other.mdx")]),
    ],
  );
  const nodes = applyMapTechData(tech, { w3u });

  check("a Farm-based shop gets the map's Sellunits (the reported bug: this was empty)", tech.get("h00C").sellunits, ["opeo", "ogru", "orai"]);
  check("...and its display name, for the red \"Requires:\" line", tech.get("h00C").name, "Orc Units");
  check("a clone of a stock shop INHERITS its base's wares when it overrides none", tech.get("n001").sellunits, ["Nalc", "Nfir", "Nbrn"]);
  check("...and a clone that names its own list REPLACES the inherited one", tech.get("n002").sellunits, ["Nalc"]);
  check("Trains lands", tech.get("h006").trains, ["Hapm", "Hant"]);
  check("Revive lands (an altar is a bool, not a list)", tech.get("h006").revive, true);
  check("Builds lands — a custom worker's own build menu", tech.get("h01W").builds, ["nfoh", "ntav", "ngol"]);
  check("Upgrade lands — the map's own tier chain", tech.get("h02X").upgrade, ["h02Y"]);
  check("`Requirescount` GROWS the tier ladder, and Requires2 fills the tier it opened", tech.get("h006").requiresTiers, [[], [], ["hkee"]]);
  check("an ORIGINAL-table override reaches the base id it names", tech.requirements("Nfir", 0), []);
  check("...at every tier it clears (the 2nd/3rd hero gate goes too)", tech.requirements("Nfir", 2), []);
  check("a pure stat/art override installs NO node — the base graph is untouched", tech.get("htow").trains, ["hpea"]);
  check("every node is counted once", nodes, 7);

  // The `satisfies` index is derived from `upgrade`/`dependencyOr`, so the overlay must
  // rebuild it — otherwise a map's own tier chain answers for nothing.
  check("the upgrade-chain index sees the map's chain (h02Y answers for h02X)", tech.satisfies("h02Y").includes("h02X"), true);
  check("...and the install's own chain still does (a Keep answers for a Town Hall)", tech.satisfies("hkee").includes("htow"), true);

  // One map's tech tree must never leak into the next (MapViewerScene.loadMapObjectData
  // clears every overlay before loading a map's object data).
  tech.clearCustom();
  check("clearCustom drops the overlay", tech.has("h00C"), false);
  check("...and restores the stock gating the map had cleared", tech.requirements("Nfir", 0), [{ tech: "TALT", level: 1 }]);
  check("...and re-indexes: the map's chain is gone", tech.satisfies("h02Y").includes("h02X"), false);
}

console.log("\n[map tech] an UPGRADE's requirement is tiered by LEVEL, and rides levelOrVariation");
{
  // war3map.w3q is level-indexed: `greq` carries the 1-based LEVEL it gates, and tier index is
  // level - 1 (`Requires` gates level 1, `Requires1` gates level 2). Verified against the
  // tester map's own .w3q, which clears greq at lvl 2 and lvl 3 on exactly the three-level
  // Blacksmith upgrades (Rhme/Rhar/Rhla) and at lvl 1 on the single-level ones.
  const tech = new TechRegistry(baseDefs());
  const w3q = build(W3d, [], [obj("Rhme", NO_ID, [mod("greq", "", 2), mod("greq", "hkee", 3)])]);
  applyMapTechData(tech, { w3q });
  check("level 2's gate (tier 1) is cleared", tech.requirements("Rhme", 1), []);
  check("level 3's gate (tier 2) is rewritten, not appended", tech.requirements("Rhme", 2), [{ tech: "hkee", level: 1 }]);
  check("a level the map never mentions keeps the install's value", tech.requirements("Rhme", 0), []);
}

console.log("\n[map tech] a map that ships no object data runs on the install's graph");
{
  const tech = new TechRegistry(baseDefs());
  check("no files → nothing installed", applyMapTechData(tech, {}), 0);
  check("...and the stock graph answers as before", tech.get("ntav").sellunits, ["Nalc", "Nfir", "Nbrn"]);
  // Never hard-crash the map (CLAUDE.md): a truncated or foreign blob is skipped, not thrown.
  check("a corrupt blob is non-fatal", applyMapTechData(tech, { w3u: new Uint8Array([1, 2, 3, 4, 5]) }), 0);
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
