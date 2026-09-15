// Headless check of the hotkey editor's WRITE half (issue #156): the document that edits a
// player's CustomKeys.txt in place (src/data/customKeysDoc.ts), the tooltip re-gilding that
// follows a rebound key, and the catalog of command cards read out of the install
// (src/data/hotkeyCatalog.ts).
// Run: pnpm sim:test
//
// What is pinned, and why each one fails silently in the running game:
//
//  1. **The file survives a save.** A CustomKeys.txt is hand-tuned after a generator wrote it.
//     A save that regenerates it deletes the player's comments, their sections the editor has no
//     button for, and the file's own ending — and nothing in the game would ever notice.
//  2. **A quoted list is a list.** `Tip="a, b","c"` is two levels. mdx-m3-viewer's IniFile
//     strips a value's first and last characters when it starts with a quote, which turns that
//     into `a, b","c` — so the editor reads INI itself, and a round trip must not change it.
//  3. **Setting a value back to the game's is taking it OUT of the file.** Otherwise "Reset"
//     leaves a line behind that silently pins today's default against a future patch's.
//  4. **The tooltip follows the key** in both styles a real file carries — the game's own
//     gilded letter (`|cffffcc00M|rove`) and a generator's bracket (`(|cffffcc00Q|r) Move`).
//  5. **It is windows-1252**, the encoding the file is read in.
const { join } = require("node:path");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

const doc = require(join(REPO, ".sim-build", "src", "data", "customKeysDoc.js"));
const { CustomKeys } = require(join(REPO, ".sim-build", "src", "data", "customKeys.js"));
const { MappedData } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata.js"));

let failed = 0;
function ok(what, cond, detail = "") {
  console.log(`${cond ? "ok   " : "FAIL "} ${what}${detail ? `   ${detail}` : ""}`);
  if (!cond) failed++;
}
const section = (name) => console.log(`\n${name}`);

// Shaped like the developer's real file and like CustomKeysSample.txt: comments over sections,
// blank lines between them, lower-case names, a quoted autocast Untip, and a trailing blank line.
const FILE = [
  "//////////////////",
  "//move",
  "[cmdmove]",
  "Tip=|cffffcc00M|rove",
  "Hotkey=M",
  "",
  "//attack",
  "[CmdAttack]",
  "Tip=|cffffcc00A|rttack",
  "Hotkey=A",
  "",
  "[Arep]",
  "Tip=|cffffcc00R|repair",
  'Untip="|cffc3dbffRight-click to activate auto-casting.|r"',
  "Hotkey=R",
  "",
  "[Rhme]",
  'Tip="Iron, Forged","Steel, Forged","Mithril, Forged"',
  "Hotkey=S,S,S",
  "",
  "",
].join("\r\n");

section("reading: raw values, quotes kept, lists split on the commas that separate");
{
  const ini = doc.readIni(FILE);
  ok("sections are keyed lower-case", ini.has("cmdmove") && ini.has("rhme"));
  ok("…and remember the file's own spelling", ini.get("cmdattack").name === "CmdAttack");
  const tip = ini.get("rhme").fields.get("tip");
  ok("a quoted list stays raw", tip === '"Iron, Forged","Steel, Forged","Mithril, Forged"', tip);
  const levels = doc.splitList(tip);
  ok("…and splits into its three levels", levels.length === 3 && levels[1] === "Steel, Forged", JSON.stringify(levels));
  ok("joinList quotes only an entry with a comma of its own", doc.joinList(["a, b", "c"]) === '"a, b",c');
  ok("…so an unedited quoted list round-trips to the same levels",
    JSON.stringify(doc.splitList(doc.joinList(levels))) === JSON.stringify(levels));
}

section("writing: the file is edited in place, never regenerated");
{
  const d = new doc.CustomKeysDoc(FILE);
  ok("an untouched document writes the file back byte for byte", d.serialize() === FILE);
  ok("…and is not dirty", !d.dirty);

  d.set("CmdMove", "hotkey", "Q");
  d.set("cmdattack", "buttonpos", "0,1");
  d.set("Arep", "untip", null);
  d.set("hfoo", "hotkey", "F");
  const out = d.serialize();
  const lines = out.split("\r\n");
  ok("a changed field rewrites its own line", lines[4] === "Hotkey=Q", lines[4]);
  ok("…whatever case the file spelled the section in", lines[2] === "[cmdmove]");
  const atk = lines.indexOf("[CmdAttack]");
  ok("a new field goes at the end of its section, above the gap and the next comment",
    lines[atk + 3] === "Buttonpos=0,1" && lines[atk + 4] === "", JSON.stringify(lines.slice(atk, atk + 6)));
  ok("null takes the line out of the file", !out.includes("auto-casting"));
  ok("the comments are kept", out.startsWith("//////////////////\r\n//move\r\n") && out.includes("//attack\r\n[CmdAttack]"));
  ok("a section the file never had is appended", out.endsWith("\r\n\r\n[hfoo]\r\nHotkey=F\r\n"), JSON.stringify(out.slice(-40)));
  ok("every line is CRLF", !/[^\r]\n/.test(out));
  ok("get answers the edit", d.get("cmdmove", "hotkey") === "Q" && d.get("arep", "untip") === undefined);

  const back = new doc.CustomKeysDoc(FILE);
  back.set("cmdmove", "hotkey", "M");
  ok("setting a field to what the file already says is no edit at all", !back.dirty && back.serialize() === FILE);

  const repeat = new doc.CustomKeysDoc("[hfoo]\r\nHotkey=A\r\n[hfoo]\r\nHotkey=B\r\n");
  repeat.set("hfoo", "hotkey", "C");
  ok("a key repeated in the file is rewritten EVERY time — the later one is what the game reads",
    repeat.serialize() === "[hfoo]\r\nHotkey=C\r\n[hfoo]\r\nHotkey=C\r\n", JSON.stringify(repeat.serialize()));

  const empty = new doc.CustomKeysDoc(null);
  empty.set("CmdRally", "hotkey", "F");
  ok("a player with no file gets one holding only what they changed", empty.serialize() === "[CmdRally]\r\nHotkey=F\r\n");
}

section("what the editor writes is what the game then reads");
{
  const d = new doc.CustomKeysDoc(FILE);
  d.set("Rhme", "hotkey", "X,X,X");
  d.set("CmdMove", "hotkey", "Q");
  const keys = new CustomKeys(d.serialize());
  const t = new MappedData();
  t.map.Rhme = { map: { hotkey: "S,S,S" } };
  t.map.CmdMove = { map: { hotkey: "M" } };
  keys.applyTo(t);
  ok("the read half picks up a saved rebind", t.map.CmdMove.map.hotkey === "Q");
  ok("…and a per-level one", t.map.Rhme.map.hotkey === "X,X,X");
}

section("the tooltip's gilded letter follows the key");
{
  ok("the game's own style moves the gilding onto the new letter",
    doc.retip("|cffffcc00M|rove", "O") === "M|cffffcc00o|rve", doc.retip("|cffffcc00M|rove", "O"));
  ok("a key the name does not contain is appended, as CustomKeyInfo.txt writes it",
    doc.retip("|cffffcc00M|rove", "Q") === "Move (|cffffcc00Q|r)");
  ok("a generator's bracket keeps its place and changes its letter",
    doc.retip("(|cffffcc00Z|r) Holy Light - [|cffffcc00Level 1|r]", "T") === "(|cffffcc00T|r) Holy Light - [|cffffcc00Level 1|r]");
  const learn = "Learn Holy Ligh|cffffcc00t|r - [|cffffcc00Level %d|r]";
  ok("a longer gilded run (the level) is not taken for the key",
    doc.retip(learn, "L") === "|cffffcc00L|rearn Holy Light - [|cffffcc00Level %d|r]", doc.retip(learn, "L"));
  ok("…nor is a letter inside it", doc.retip(learn, "V") === "Learn Holy Light - [|cffffcc00Level %d|r] (|cffffcc00V|r)", doc.retip(learn, "V"));
}

section("encoding");
{
  const bytes = doc.encodeAnsi("é€一");
  ok("Latin-1 is itself, the 0x80 block is 1252's, anything else is ?", bytes[0] === 0xe9 && bytes[1] === 0x80 && bytes[2] === 0x3f, [...bytes].join(","));
}

section("the catalog, against the unpacked install");
{
  const root = join(REPO, "Warcraft III", "ExtractedData", "merged");
  if (!existsSync(join(root, "Units", "UnitData.slk"))) {
    console.log("  skip  no ExtractedData (pnpm data:extract)");
  } else {
    const index = new Map();
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}\\${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), r);
        else index.set(r.toLowerCase(), join(dir, e.name));
      }
    };
    walk(join(root, "Units"), "Units");
    walk(join(root, "UI"), "UI");
    const vfs = {
      label: "extracted", list: () => [], read: async () => new Uint8Array(),
      exists: (p) => index.has(p.toLowerCase()),
      rawBytes: (p) => (index.has(p.toLowerCase()) ? new Uint8Array(readFileSync(index.get(p.toLowerCase()))) : null),
    };
    const { HotkeyCatalog } = require(join(REPO, ".sim-build", "src", "data", "hotkeyCatalog.js"));
    const cat = new HotkeyCatalog(vfs);
    const unit = (id) => cat.units.find((u) => u.id === id);
    const sections = (u, card = "main") => u.cards.find((c) => c.id === card).buttons.map((b) => b.section);
    for (const race of ["human", "orc", "nightelf", "undead"]) {
      const n = (g) => cat.units.filter((u) => u.race === race && u.group === g).length;
      ok(`${race}: four heroes, and units and buildings`, n("hero") === 4 && n("unit") >= 11 && n("building") >= 12, `${n("hero")}/${n("unit")}/${n("building")}`);
    }
    ok("a building's card is what it trains and researches, and its rally", ["hfoo", "hrif", "hkni", "Rhde", "CmdRally"].every((s) => sections(unit("hbar")).includes(s)), sections(unit("hbar")).join(","));
    ok("a worker's builds are a card of their own, with a way back", sections(unit("hpea"), "build").includes("hbar") && sections(unit("hpea"), "build").includes("CmdCancel"));
    ok("…behind its RACE's build button", sections(unit("uaco")).includes("CmdBuildUndead"));
    const learn = unit("Hpal").cards.find((c) => c.id === "learn").buttons;
    ok("a hero's learn card speaks the Research* fields", learn.length === 5 && learn.slice(0, 4).every((b) => b.variant === "research"));
    ok("a tower attacks and stops but has no Move", sections(unit("hgtw")).includes("CmdAttack") && !sections(unit("hgtw")).includes("CmdMove"));
    ok("an ability that is never drawn is not a button (Inventory)", !sections(unit("Hpal")).includes("AInv"));
    ok("the tavern's heroes are listed under Neutral", unit("Npbm")?.race === "neutral");
    ok("an upgrade's key has one entry per level", cat.levels("Rhme", "") === 3);
    ok("…and a shared button knows who else wears it", cat.usedBy("CmdMove").length > 50);
  }
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
