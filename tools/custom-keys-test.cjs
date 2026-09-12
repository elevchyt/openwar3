// Headless check of `CustomKeys.txt` — the player's own hotkeys and tooltips, which is what the
// Custom rung of Options → Gameplay → "Hotkeys:" reads (src/data/customKeys.ts, issue #142).
// Run: pnpm sim:test
//
// Four things are pinned here, and every one of them fails SILENTLY in a running game — the
// symptom of each is "custom keys do nothing", which is also the symptom of the player having
// written the file wrong, so none of them would ever be reported as a bug against this code:
//
//  1. **Line endings.** mdx-m3-viewer's IniFile splits on "\r\n" and nothing else. This is the
//     one game file a PLAYER writes — on any OS, in any editor, or by one of the hotkey
//     generators — so an LF-only file is not a corner case, and unnormalised it parses as a
//     single line and yields no sections at all.
//  2. **Casing.** The game's rows are `Anei`, `CmdRally`, `Rhme`; a real CustomKeys.txt says
//     `[anei]`, `[cmdrally]`. `MappedData.getRow` is an exact lookup, so a straight `load()` of
//     the file mints a second row beside the real one and overrides nothing.
//  3. **The closed field list.** The file is hand-edited and merged onto the game's own data
//     tables. It may rebind and re-word; it may not change the game. Anything outside
//     CustomKeyInfo.txt's eleven fields has to be dropped on the floor.
//  4. **The option gate.** Nothing may be overridden while the row says Legacy or Grid.
//
// The fields and the examples are Blizzard's own: `CustomKeyInfo.txt` ships in every install and
// documents the format, and this test quotes its examples ("[ogru] Hotkey=T", "[Rhme]
// Hotkey=X,Y,Z", "[AHre] Researchhotkey=U") rather than inventing any.
const { join } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

const { CustomKeys, setCustomKeys, customKeys, layCustomKeys } = require(join(REPO, ".sim-build", "src", "data", "customKeys.js"));
const { applyHotkeyOptions } = require(join(REPO, ".sim-build", "src", "data", "hotkeys.js"));
const { loadCommandStrings } = require(join(REPO, ".sim-build", "src", "data", "commandStrings.js"));
const { MappedData } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata.js"));

let failed = 0;
function ok(what, cond, detail = "") {
  console.log(`${cond ? "ok   " : "FAIL "} ${what}${detail ? `   ${detail}` : ""}`);
  if (!cond) failed++;
}
const section = (name) => console.log(`\n${name}`);

/** A table shaped like one of the game's: rows named as the SLKs name them. */
function table(rows) {
  const d = new MappedData();
  for (const [name, fields] of Object.entries(rows)) {
    d.map[name] = { map: { ...fields }, string(k) { return this.map[k.toLowerCase()]; } };
  }
  return d;
}
const field = (d, row, key) => d.map[row]?.map[key];

// CustomKeyInfo.txt's own examples, written the way a real file writes them: lower-case section
// names against the game's mixed-case rows.
const SAMPLE = [
  "// a comment line, which this format allows",
  "[ogru]",
  "Hotkey=T",
  "Tip=Train Orc Grunt (|cffffcc00T|r)",
  "",
  "[rhme]",
  "Hotkey=X,Y,Z",
  "[AHRE]",
  "Researchhotkey=U",
  "[adef]",
  "Hotkey=A",
  "Unhotkey=B",
  "Buttonpos=3,1",
  "[cmdrally]",
  "Hotkey=F",
].join("\n");

section("the file parses however the player's editor wrote it");
{
  const lf = new CustomKeys(SAMPLE);
  const crlf = new CustomKeys(SAMPLE.replace(/\n/g, "\r\n"));
  const bom = new CustomKeys("﻿" + SAMPLE.replace(/\n/g, "\r\n"));
  ok("an LF-only file is read", lf.size === 5, `${lf.size} sections`);
  ok("…and a CRLF one reads the same", crlf.size === lf.size, `${crlf.size} sections`);
  ok("…and a byte-order mark does not eat the first section", bom.size === lf.size, `${bom.size} sections`);
}

section("a section overrides the game's row whatever either side's casing is");
{
  const keys = new CustomKeys(SAMPLE);
  const strs = table({
    ogru: { name: "Grunt", hotkey: "G", tip: "Train |cffffcc00G|rrunt", ubertip: "A brutish warrior." },
    Rhme: { hotkey: "S,T,M", tip: "Iron,Steel,Mithril" },
    AHre: { researchhotkey: "R", hotkey: "R" },
    Adef: { hotkey: "D", unhotkey: "D" },
    CmdRally: { hotkey: "Y", tip: "Set Rall|cffffcc00y|r Point" },
    hfoo: { hotkey: "F", tip: "Train |cffffcc00F|rootman" },
  });
  keys.applyTo(strs);
  ok("a lower-case section finds a lower-case row", field(strs, "ogru", "hotkey") === "T");
  ok("…and its Tip comes with it", field(strs, "ogru", "tip") === "Train Orc Grunt (|cffffcc00T|r)");
  ok("a lower-case section finds a MIXED-case row", field(strs, "Rhme", "hotkey") === "X,Y,Z");
  ok("…and an UPPER-case one does too", field(strs, "AHre", "researchhotkey") === "U");
  ok("the engine's own buttons are rows like any other", field(strs, "CmdRally", "hotkey") === "F");
  ok("an ability's Un-family is carried", field(strs, "Adef", "unhotkey") === "B");
  ok("a row the file says nothing about is untouched", field(strs, "hfoo", "hotkey") === "F");
  ok("…and so is a field it says nothing about", field(strs, "ogru", "ubertip") === "A brutish warrior.");
  ok("a row is never INVENTED — only overridden", strs.map["AHRE"] === undefined && strs.map["adef"] === undefined);
}

section("it may rebind and re-word; it may not change the game");
{
  // Everything outside CustomKeyInfo.txt's eleven fields, including the two that would be most
  // tempting to allow (Ubertip is a tooltip too) and the one that would be a real exploit.
  const keys = new CustomKeys("[hfoo]\nHotkey=Q\nUbertip=mine now\nName=Mega Footman\nSightRadius=9999\ndefUp=99\n");
  const strs = table({ hfoo: { hotkey: "F", ubertip: "Versatile foot soldier.", name: "Footman", sightradius: "1400", defup: "2" } });
  keys.applyTo(strs);
  ok("the hotkey it is allowed to set is set", field(strs, "hfoo", "hotkey") === "Q");
  ok("Ubertip is NOT one of the eleven", field(strs, "hfoo", "ubertip") === "Versatile foot soldier.");
  ok("neither is Name", field(strs, "hfoo", "name") === "Footman");
  ok("a stat is refused", field(strs, "hfoo", "sightradius") === "1400" && field(strs, "hfoo", "defup") === "2");
}

section("nothing is overridden unless the player asked for it");
{
  setCustomKeys(SAMPLE);
  const under = (mode) => {
    applyHotkeyOptions({ hotkeys: mode });
    const strs = table({ ogru: { hotkey: "G" } });
    layCustomKeys(strs);
    return field(strs, "ogru", "hotkey");
  };
  ok("Legacy leaves the game's own letters alone", under("legacy") === "G");
  ok("…and so does Grid, which has its own answer", under("grid") === "G");
  ok("Custom is the one that reads the file", under("custom") === "T");
  applyHotkeyOptions({ hotkeys: "custom" });
  setCustomKeys(null);
  ok("…and a folder with no such file overrides nothing", customKeys() === null);
}

section("what a `Hotkey=` value means to the engine's own buttons");
{
  // `[CmdCancel] Hotkey=27` is in the shipped file, and 27 is VK_ESCAPE: the engine writes a
  // virtual-key code where the key has no letter. Read as a letter it would be "2".
  setCustomKeys(null);
  const text = [
    "[CmdMove]", "Tip=|cffffcc00M|rove", "Hotkey=M", "",
    "[CmdCancel]", "Tip=Cancel (|cffffcc00ESC|r)", "Hotkey=27", "",
    "[CmdPurchase]", "Tip=|cffffcc00S|rell Items", "Hotkey=s", "",
    "[Errors]", "Nogold=Not enough gold.",
  ].join("\r\n");
  const vfs = { rawBytes: () => new TextEncoder().encode(text) };
  const stock = loadCommandStrings(vfs);
  ok("a letter is a letter", stock.command("CmdMove").hotkey === "M");
  ok("…in upper case however the file wrote it", stock.command("CmdPurchase").hotkey === "S");
  ok("a numeric code is the key it names", stock.command("CmdCancel").hotkey === "Escape");
  ok("a stock install carries no button positions", stock.command("CmdMove").pos === null);
  ok("and the error table still reads", stock.get("Nogold") === "Not enough gold.");

  // …and the same table under a CustomKeys.txt that moves two of them.
  setCustomKeys("[cmdmove]\nHotkey=W\n[cmdcancelbuild]\nButtonpos=3,2\n");
  applyHotkeyOptions({ hotkeys: "custom" });
  const custom = loadCommandStrings(vfs);
  ok("the player's letter reaches the engine's own button", custom.command("CmdMove").hotkey === "W");
  ok("…and Cancel keeps the one the file left alone", custom.command("CmdCancel").hotkey === "Escape");
  setCustomKeys(null);
  applyHotkeyOptions({ hotkeys: "legacy" });
}

section("the developer's own file, as it sits in the install");
{
  const path = join(REPO, "Warcraft III", "CustomKeys.txt");
  if (!existsSync(path)) {
    console.log("  skip  no CustomKeys.txt in ./Warcraft III");
  } else {
    const keys = new CustomKeys(readFileSync(path, "latin1"));
    ok("it parses into a real number of sections", keys.size > 100, `${keys.size} sections`);
    // Its first two sections, verbatim: the engine's own rally button moved to F, and the rally
    // ABILITY row beside it moved to a slot.
    const strs = table({ CmdRally: { hotkey: "Y" }, ARal: { buttonpos: "3,2" }, phea: { hotkey: "P" } });
    keys.applyTo(strs);
    ok("…and it moves what it says it moves", field(strs, "CmdRally", "hotkey") === "F", field(strs, "CmdRally", "hotkey"));
    ok("…including a button position", field(strs, "ARal", "buttonpos") === "3,1", field(strs, "ARal", "buttonpos"));
    ok("…and an item's shop key", field(strs, "phea", "hotkey") === "A", field(strs, "phea", "hotkey"));
  }
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
