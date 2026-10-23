// A MAP's own object tables over the install's (src/vfs/mapTables.ts, docs/map-compatibility.md
// "A map that ships its own tables").
//
// WC3 mounts the map archive above the game's, so a map that carries `Units\AbilityData.slk`
// REPLACES the game's copy — and an optimised map (Vexorian's Optimizer, W3x2Lni "slk" mode)
// defines its whole object set that way, with little or nothing left in its w3 files. Read
// past the map and every custom id is a type nothing knows: on DotA v6.77b AI the script's
// CreateUnit calls made nothing, and the w3a's 769 rows modified ids that did not exist.
//
//   1. the source itself: the map's copy wins, a ZERO-byte copy is an answer, a path it lacks
//      is the install's, `shadows` lists what it shadows out of what the readers asked for,
//      and taking the map off puts the install back;
//   2. the registries read through it see the map's types (against the developer's own copy of
//      DotA v6.77b AI when it is in the install).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const B = (...p) => require(join(REPO, ".sim-build", "src", ...p));
const { MapTableSource } = B("vfs", "mapTables.js");
const { loadUnitRegistry } = B("data", "units.js");
const { loadAbilityRegistry } = B("data", "abilities.js");
const { loadItemRegistry } = B("data", "items.js");

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A DataSource over a plain table of files, case- and slash-insensitive like an archive. */
function memory(label, files) {
  const key = (p) => p.replace(/\//g, "\\").replace(/^\\+/, "").toLowerCase();
  const map = new Map(Object.entries(files).map(([p, s]) => [key(p), new TextEncoder().encode(s)]));
  const src = {
    label,
    exists: (p) => map.has(key(p)),
    rawBytes: (p) => map.get(key(p)) ?? null,
    read: async (p) => { const b = src.rawBytes(p); if (!b) throw new Error(p); return b; },
    list: () => [...map.keys()],
  };
  return src;
}
const text = (b) => (b ? new TextDecoder().decode(b) : null);

console.log("the source");
{
  const install = memory("install", { "Units\\UnitData.slk": "install units", "Units\\CampaignUpgradeFunc.txt": "[Rhme]", "Units\\ItemFunc.txt": "install items" });
  const map = memory("map", { "units/unitdata.slk": "map units", "Units\\CampaignUpgradeFunc.txt": "" });
  const tables = new MapTableSource(install);
  check("with no map on it, it is the install", text(tables.rawBytes("Units\\UnitData.slk")), "install units");
  tables.rawBytes("Units\\CampaignUpgradeFunc.txt");
  tables.rawBytes("Units\\ItemFunc.txt");
  check("it shadows only the files a reader asked for and the map carries (any case, any slash)",
    tables.shadows(map).sort(), ["units\\campaignupgradefunc.txt", "units\\unitdata.slk"]);
  tables.setMap(map);
  check("the map's copy wins", text(tables.rawBytes("Units\\UnitData.slk")), "map units");
  check("a ZERO-byte copy is the map's answer, not a miss", text(tables.rawBytes("Units\\CampaignUpgradeFunc.txt")), "");
  check("a file the map lacks is the install's", text(tables.rawBytes("Units\\ItemFunc.txt")), "install items");
  tables.setMap(null);
  check("taking the map off puts the install back", text(tables.rawBytes("Units\\UnitData.slk")), "install units");
}

console.log("\nan optimised map (DotA v6.77b AI)");
const DOTA = join(REPO, "Warcraft III", "Maps", "Download", "DotA v6.77b AI 1.1.7 Fun 2.7c.w3x");
const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(DOTA) || !fs.existsSync(join(EXTRACT, "Units", "UnitData.slk"))) {
  console.log("  skip  no DotA v6.77b AI in Maps\\Download, or no extracted data (`pnpm data:extract`)");
} else {
  const onDisk = (p) => {
    let dir = EXTRACT;
    for (const part of p.replace(/\//g, "\\").split("\\")) {
      if (!part) continue;
      let hit;
      try { hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase()); } catch { return null; }
      if (!hit) return null;
      dir = join(dir, hit);
    }
    return fs.statSync(dir).isFile() ? dir : null;
  };
  const install = {
    label: "ExtractedData",
    exists: (p) => onDisk(p) !== null,
    rawBytes: (p) => { const f = onDisk(p); return f ? new Uint8Array(fs.readFileSync(f)) : null; },
    read: async (p) => install.rawBytes(p),
    list: () => [],
  };
  const mpqMod = require("mdx-m3-viewer/dist/cjs/parsers/mpq");
  const archive = new (mpqMod.default ?? mpqMod).Archive();
  archive.load(new Uint8Array(fs.readFileSync(DOTA)), true);
  const norm = (p) => p.replace(/\//g, "\\").replace(/^\\+/, "");
  const map = {
    label: "map",
    exists: (p) => archive.has(norm(p)),
    rawBytes: (p) => archive.get(norm(p))?.bytes() ?? null,
    read: async (p) => map.rawBytes(p),
    list: () => archive.getFileNames(),
  };

  const tables = new MapTableSource(install);
  const stockUnits = loadUnitRegistry(tables);
  const stockAbilities = loadAbilityRegistry(tables);
  loadItemRegistry(tables);
  const shadowed = tables.shadows(map);
  check("the map ships its own unit, ability and item tables", ["units\\unitdata.slk", "units\\abilitydata.slk", "units\\itemdata.slk"].every((p) => shadowed.includes(p)), true);
  // `ncop` the Circle of Power is stock; `u00B` and `A00Y` are ids only the map's tables define.
  check("the install alone knows none of the map's ids", [stockUnits.get("u00B") !== undefined, stockAbilities.get("A00Y") !== undefined], [false, false]);
  tables.setMap(map);
  const units = loadUnitRegistry(tables);
  const abilities = loadAbilityRegistry(tables);
  check("read through the map, its unit types exist", [units.get("u00B") !== undefined, units.get("ncop") !== undefined], [true, true]);
  check("…and so do its abilities", abilities.get("A00Y") !== undefined, true);
  check("…a few hundred heroes' worth of them", units.all().filter((d) => d.isHero).length > 100, true);
  // Channel (`ANcl`) aims, hides and answers to an order per ROW (data/abilities.ts shapeChannel):
  // Treant Protector's three are a no-target, a unit-target and a unit-or-point spell.
  const ch = (id) => { const d = abilities.get(id); return d ? [d.target, d.order, !!d.buttonHidden] : null; };
  check("a Channel's aim and order come off its own row (Overgrowth / Leech Seed / Living Armor)",
    [ch("A07Z"), ch("A26N"), ch("A2ML")], [["none", "channel", false], ["unit", "thunderbolt", false], ["point", "creepheal", false]]);
  // A skill with no Researchbuttonpos sits at 0,0 on the learn page, not at its Buttonpos.
  check("Forked Lightning (no Researchbuttonpos) learns from the top-left cell", [abilities.get("A010")?.learnX, abilities.get("A010")?.learnY], [0, 0]);
  // Every hero skill DotA defines is built on a base code the engine knows — Channel, Magic
  // Leash, the Spellbook, Phase Shift, Permanent Invisibility/Immolation and the item codes a
  // map hands a hero (Spell Shield's AIdd, Darkness' AIct…); an unknown code is dropped from the
  // hero (RtsController.buildInitialAbilities), which is how 200 skills were missing.
  const { KNOWN_ABILITIES } = B("data", "abilities.js");
  const unknown = new Set();
  for (const d of units.all()) if (d.isHero) for (const id of d.heroAbilities) { const ab = abilities.get(id); if (ab && !KNOWN_ABILITIES[ab.code]) unknown.add(ab.code); }
  check("every DotA hero skill's base code is one the engine casts or applies", [...unknown], []);
  check("a spellbook's contents come off its row (Job Change)", abilities.get("A5OZ")?.bookSpells?.slice(0, 3), ["A5PH", "A5PI", "A5QV"]);
  // …and a type's Point Value, which DotA routes every shop purchase on.
  check("a sold dummy unit carries its Point Value (UnitData.slk points)", units.get("h02G")?.points, 200);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall map-table checks passed");
