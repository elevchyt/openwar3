// EDITIONS — a unit's stats, attack class and armour class are the ones the game IN PLAY states.
//
// Reign of Chaos and The Frozen Throne are not a reskin of each other: **232 of the 468 units
// they share disagree about their armour class alone**, and the damage table they are read
// against is a different table too. A Footman is Medium armour on Reign of Chaos and Heavy on
// the expansion; a Raider is Light/0 against Medium/1; a Knight hits for 19+2d5 against 28+2d5.
// Read the wrong set and nothing crashes — every fight is just quietly balanced for the other
// game, which is exactly the kind of bug that survives for months.
//
// Three things have to agree for that not to happen, and this file pins all three against the
// install itself rather than against numbers typed in here:
//
//   1. `EditionDataSource` — a path with a `Melee_V0\` twin reads the twin while on RoC
//      (docs/editions.md; common.j calls the folder pair "Melee (Latest Patch)" / "Custom (1.01)").
//   2. `loadUnitRegistry` therefore builds different rows per edition, and the switch is read at
//      every lookup rather than baked in — so a registry built after a switch is the new game's.
//   3. `damageTable()` reads the matching `DamageBonus*` block (MISC_GAME_V0), so the classes
//      those rows name mean what that edition says they mean.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { EditionDataSource } = require(join(REPO, ".sim-build", "src", "vfs", "edition.js"));
const { setEdition, isRoc, ROC_DATA_SET, setMapDataSet, mapDataSet, dataSetFolder } = require(join(REPO, ".sim-build", "src", "data", "edition.js"));
const { loadUnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { damageTable, damageMultiplier } = require(join(REPO, ".sim-build", "src", "data", "gameplayConstants.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, ROC_DATA_SET, "Units", "UnitBalance.slk"))) {
  console.log(`skip  no extracted ${ROC_DATA_SET} data set (run \`pnpm data:extract\` on a 1.30.4 install)`);
  process.exit(0);
}

/** The extracted tree as a DataSource. Case-insensitive, like the archives it came out of —
 *  which matters here: the RoC twin of `UI\FrameDef\…` is filed under `UI\Framedef\…`. */
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
const base = {
  label: "ExtractedData",
  exists: (p) => onDisk(p) !== null,
  rawBytes: (p) => { const f = onDisk(p); return f ? new Uint8Array(fs.readFileSync(f)) : null; },
  read: async (p) => { const b = base.rawBytes(p); if (!b) throw new Error(p); return b; },
  list: () => [],
};
const vfs = new EditionDataSource(base);

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
/** The row a registry built RIGHT NOW gives this unit — the registry has to be rebuilt per
 *  edition, which is what a match does. */
const statsOf = (reg, id) => {
  const d = reg.get(id);
  return d ? { armor: d.armorType, def: d.armor, atk: d.weapons[0]?.attackType, dmg: d.weapons[0]?.damage } : null;
};

console.log("the data set follows the edition");
{
  setEdition("tft");
  const tftBytes = vfs.rawBytes("Units\\UnitBalance.slk");
  const liveBytes = base.rawBytes("Units\\UnitBalance.slk");
  const rocBytes = base.rawBytes(`${ROC_DATA_SET}\\Units\\UnitBalance.slk`);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  check("…which is the live table", same(tftBytes, liveBytes), true);
  check("…and not the Reign of Chaos one", same(tftBytes, rocBytes), false);
  setEdition("roc");
  check("on Reign of Chaos the SAME path reads the Melee_V0 twin", same(vfs.rawBytes("Units\\UnitBalance.slk"), rocBytes), true);
  // The armour TIPS are the other overlaid file, and its twin is filed under a different
  // spelling of the folder (`UI\Framedef\`), so this is a case-folding check as much as a
  // routing one.
  check("…and so does the info panel's own string table",
    same(vfs.rawBytes("UI\\FrameDef\\InfoPanelStrings.fdf"), base.rawBytes(`${ROC_DATA_SET}\\UI\\Framedef\\InfoPanelStrings.fdf`)), true);
  check("a path with no twin falls through untouched",
    same(vfs.rawBytes("UI\\MiscData.txt"), base.rawBytes("UI\\MiscData.txt")), true);
}

console.log("\n…and so do the rows a match is built from");
setEdition("tft");
const TFT = loadUnitRegistry(vfs);
setEdition("roc");
const ROC = loadUnitRegistry(vfs);
{
  // Every one of these is read straight out of the two UnitBalance/UnitWeapons tables; they are
  // here because they are the units a player meets first in each game.
  check("Footman: Heavy on the expansion, Medium on Reign of Chaos",
    [statsOf(TFT, "hfoo").armor, statsOf(ROC, "hfoo").armor], ["large", "medium"]);
  check("Grunt likewise", [statsOf(TFT, "ogru").armor, statsOf(ROC, "ogru").armor], ["large", "medium"]);
  // The Raider is the one the report named — the Blackrock warlord of Strahnbrad (`oC16`) is a
  // clone of it, and the chapter places one plain `orai` besides.
  check("Raider: Medium/1 armour on the expansion, Light/0 on Reign of Chaos",
    [statsOf(TFT, "orai").armor, statsOf(TFT, "orai").def, statsOf(ROC, "orai").armor, statsOf(ROC, "orai").def],
    ["medium", 1, "small", 0]);
  check("…with the same SIEGE attack in both", [statsOf(TFT, "orai").atk, statsOf(ROC, "orai").atk], ["siege", "siege"]);
  check("Wind Rider goes the other way — Light on the expansion, Heavy on RoC",
    [statsOf(TFT, "owyv").armor, statsOf(ROC, "owyv").armor], ["small", "large"]);
  check("and a STAT moves too: the Knight's base damage",
    [statsOf(TFT, "hkni").dmg, statsOf(ROC, "hkni").dmg], [28, 19]);
  // The point of the whole exercise, in one number. Counted over the units BOTH UnitBalance
  // tables actually carry a class for — Reign of Chaos's has 469 rows against the expansion's
  // 837, and a unit its game never had is not a disagreement.
  const classed = (d) => d && d.armorType && d.armorType !== "unknown";
  const shared = [...TFT.defs.keys()].filter((id) => classed(TFT.defs.get(id)) && classed(ROC.defs.get(id)));
  const moved = shared.filter((id) => TFT.defs.get(id).armorType !== ROC.defs.get(id).armorType);
  check("…and they are not a handful of units", moved.length > 150, true);
  console.log(`        (${moved.length} of ${shared.length} units both games carry change armour class)`);
}

console.log("\nthe damage table is the edition's too");
{
  // `Units\MiscGame.txt` against `Melee_V0\Units\MiscGame.txt`, verbatim: the expansion's
  // Piercing hits Light for 200%, Reign of Chaos's hits HEAVY for 150% and Light for 75%.
  setEdition("tft");
  check("expansion: Piercing 200% vs Light, 100% vs Heavy",
    [damageMultiplier("pierce", "small"), damageMultiplier("pierce", "large")], [2, 1]);
  check("expansion: Magic 200% vs Heavy, 75% vs Medium",
    [damageMultiplier("magic", "large"), damageMultiplier("magic", "medium")], [2, 0.75]);
  setEdition("roc");
  check("Reign of Chaos: Piercing 75% vs Light, 150% vs Heavy",
    [damageMultiplier("pierce", "small"), damageMultiplier("pierce", "large")], [0.75, 1.5]);
  check("Reign of Chaos: Magic 200% vs MEDIUM, 100% vs Heavy",
    [damageMultiplier("magic", "large"), damageMultiplier("magic", "medium")], [1, 2]);
  check("Reign of Chaos: Normal 150% vs Light", damageMultiplier("normal", "small"), 1.5);
  // Chaos and Hero are the two rows the two files agree on, so `damageTable` falling back to
  // the expansion's for a key MISC_GAME_V0 does not restate is harmless — but only for those.
  check("Chaos is full damage to everything in both",
    ["small", "medium", "large", "fort", "hero"].map((a) => damageMultiplier("chaos", a)), [1, 1, 1, 1, 1]);
  const rows = Object.keys(damageTable());
  check("every attack class has a row", rows.length, 7);
}

// The switch must be read at the LOOKUP, not baked in when the source was made: the menu flips
// editions on a mounted install (docs/editions.md), so a source built on the expansion has to
// start answering with Reign of Chaos's tables the moment the button is pressed.
console.log("\nthe switch is read at every lookup");
{
  setEdition("tft");
  const live = base.rawBytes("Units\\UnitBalance.slk");
  const roc = base.rawBytes(`${ROC_DATA_SET}\\Units\\UnitBalance.slk`);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const source = new EditionDataSource(base); // made while on the expansion…
  check("…it reads the expansion's table", same(source.rawBytes("Units\\UnitBalance.slk"), live), true);
  setEdition("roc");
  check("…and after the switch, the same object reads RoC's", same(source.rawBytes("Units\\UnitBalance.slk"), roc), true);
  check("isRoc() agrees", isRoc(), true);
}

// THE SECOND AXIS. The edition is only half of which tables a match plays on: the install keeps
// FOUR complete sets, (Reign of Chaos | expansion) × (melee | custom), and the map's own w3i
// melee flag picks the second half. Melee carries the balance patches 1.29+ made; custom is
// frozen where the game shipped, so every campaign chapter, scenario and custom map plays on
// the numbers it was written for.
//
// The report this was written for: a Grunt in Scourge of Lordaeron with 700 hit points where
// the reference client gives it 680. Nothing in either MELEE table says 680 — only
// `Custom_V0\Units\UnitBalance.slk` does.
console.log("\nthe map KIND picks the other half of the set");
{
  const same = (a, b) => a !== null && b !== null && a.length === b.length && a.every((v, i) => v === b[i]);
  const has = (folder) => base.exists(`${folder}\\Units\\UnitBalance.slk`);
  if (!has("Custom_V0") || !has("Custom_V1")) {
    console.log("skip  no extracted Custom_V0/Custom_V1 data set");
  } else {
    setEdition("tft");
    check("a melee map on the expansion reads the LIVE tables (the fourth corner)", dataSetFolder(), null);
    setMapDataSet("custom");
    check("…and a custom one reads Custom_V1", dataSetFolder(), "Custom_V1");
    check("…which is what the path resolves to",
      same(vfs.rawBytes("Units\\UnitBalance.slk"), base.rawBytes("Custom_V1\\Units\\UnitBalance.slk")), true);
    setEdition("roc");
    check("Reign of Chaos + custom is Custom_V0", dataSetFolder(), "Custom_V0");
    setMapDataSet("melee");
    check("…and Reign of Chaos + melee is back to Melee_V0", dataSetFolder(), ROC_DATA_SET);

    // The number the report was about, read through the registry a match is actually built from.
    setEdition("roc");
    setMapDataSet("melee");
    const rocMelee = loadUnitRegistry(vfs);
    setMapDataSet("custom");
    const rocCustom = loadUnitRegistry(vfs);
    setEdition("tft");
    setMapDataSet("custom");
    const tftCustom = loadUnitRegistry(vfs);
    check("the Grunt: 680 in a Reign of Chaos CAMPAIGN, 700 in a Reign of Chaos melee game",
      [rocCustom.get("ogru").hitPoints, rocMelee.get("ogru").hitPoints], [680, 700]);
    check("…and 700 on the expansion, which is why only RoC showed it",
      tftCustom.get("ogru").hitPoints, 700);
    // The melee-only balance patches, from the other direction: these three are 1.29+ changes
    // that a custom map must never see.
    check("the Knight, the Headhunter and the Archer keep their shipped hit points on a custom map",
      [tftCustom.get("hkni").hitPoints, tftCustom.get("ohun").hitPoints, tftCustom.get("earc").hitPoints],
      [800, 350, 310]);
    setMapDataSet("melee");
    const tftMelee = loadUnitRegistry(vfs);
    check("…and the patched ones on a melee map",
      [tftMelee.get("hkni").hitPoints, tftMelee.get("ohun").hitPoints, tftMelee.get("earc").hitPoints],
      [835, 375, 260]);
    // The DAMAGE TABLE moves with the kind too, in exactly one cell. MiscGame.txt is compiled
    // in (MISC_GAME / MISC_GAME_V0 / MISC_GAME_CUSTOM — the VFS overlay cannot reach a literal),
    // so this is the check that the third block is wired to `damageTable()` and not just
    // written down. `pnpm data:verify` is the other half: it checks the block against BOTH
    // custom files AND that no other modelled row quietly differs.
    setEdition("tft"); setMapDataSet("melee");
    const meleeSpells = damageMultiplier("spells", "hero");
    setMapDataSet("custom");
    const customSpells = damageMultiplier("spells", "hero");
    check("Spells vs HERO armour: 0.70 on the expansion's melee tables, 0.75 on a custom map",
      [meleeSpells, customSpells], [0.7, 0.75]);
    setEdition("roc");
    const rocCustomSpells = damageMultiplier("spells", "hero");
    setMapDataSet("melee");
    const rocMeleeSpells = damageMultiplier("spells", "hero");
    check("…and Reign of Chaos says 0.75 whichever kind of map it is",
      [rocMeleeSpells, rocCustomSpells], [0.75, 0.75]);
    setEdition("tft"); setMapDataSet("custom");
    check("no other cell moves with the kind — Piercing vs Light is 2.0 on both",
      damageMultiplier("pierce", "small"), 2);
    setMapDataSet("melee");

    check("that is not a handful of units either",
      [...tftMelee.defs.keys()].filter((id) => tftCustom.defs.get(id) && tftCustom.defs.get(id).hitPoints !== tftMelee.defs.get(id).hitPoints).length > 50,
      true);
  }
}

setEdition("tft"); // leave the module as the suite found it
setMapDataSet("melee");
check("the module is left on the melee tables", [isRoc(), mapDataSet()], [false, "melee"]);
console.log(failed ? `\neditions: ${failed} check(s) FAILED` : "\neditions: all checks passed");
process.exit(failed ? 1 : 0);
