// Ability implementation audit (docs/abilities-audit.md).
//
// Cross-references the REAL 1.27a ability tables from the MPQs against what the
// sim actually dispatches, so we can see at a glance which of the 799 rows in
// Units\AbilityData.slk we handle, which ride an implemented base `code`, and
// which are still unimplemented.
//
// Sources (all read from the user's own install via ExtractedData):
//   Units\AbilityData.csv        — alias, code, hero/item, race, targs1, levels
//   Units\*AbilityFunc.txt       — art (icon), Missileart/TargetArt/Casterart/…, Order
//   Units\*AbilityStrings.txt    — Name
// Implementation side:
//   src/data/abilities.ts        — KNOWN_ABILITIES (target type + autocast)
//   src/sim/spells.ts            — SPELLS handlers + AURA_BUFFS
//
// Usage: node tools/audit-abilities.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const units = path.join(root, "Warcraft III", "ExtractedData", "merged", "Units");
const out = path.join(root, "docs", "abilities-audit.md");

// --- CSV (the extractor's own dump of the SLK) -------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// --- the [ABCD] key=value sections of the *Func/*Strings .txt files ----------
function parseIni(text) {
  const out = {};
  let sec = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const m = /^\[(.+?)\]$/.exec(line);
    if (m) { sec = m[1]; out[sec] ??= {}; continue; }
    const eq = line.indexOf("=");
    if (eq < 0 || !sec) continue;
    out[sec][line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return out;
}

const FUNC = ["Human", "Orc", "Undead", "NightElf", "Neutral", "Common", "Item", "Campaign"];
const func = {}, strs = {};
for (const race of FUNC) {
  for (const [suffix, bag] of [["Func", func], ["Strings", strs]]) {
    const p = path.join(units, `${race}Ability${suffix}.txt`);
    if (!fs.existsSync(p)) continue;
    const parsed = parseIni(fs.readFileSync(p, "latin1"));
    for (const [k, v] of Object.entries(parsed)) bag[k] = { ...(bag[k] ?? {}), ...v };
  }
}

const abilities = parseCsv(fs.readFileSync(path.join(units, "AbilityData.csv"), "latin1"));

// --- what the sim implements -------------------------------------------------
const abilitiesTs = fs.readFileSync(path.join(root, "src", "data", "abilities.ts"), "utf8");
const spellsTs = fs.readFileSync(path.join(root, "src", "sim", "spells.ts"), "utf8");

const knownBlock = abilitiesTs.slice(abilitiesTs.indexOf("KNOWN_ABILITIES"), abilitiesTs.indexOf("interface Row"));
const KNOWN = new Map();
for (const m of knownBlock.matchAll(/^\s*([A-Za-z0-9]{4}):\s*\{\s*target:\s*"(\w+)"(,\s*autocast:\s*true)?/gm)) {
  KNOWN.set(m[1], { target: m[2], autocast: !!m[3] });
}

// SPELLS handlers and AURA_BUFFS entries are both `Code: (…)` at one indent level.
const HANDLED = new Set();
const spellsBody = spellsTs.slice(spellsTs.indexOf("const SPELL_HANDLERS"));
for (const m of spellsBody.matchAll(/^  ([A-Za-z0-9]{4}):\s*\(/gm)) HANDLED.add(m[1]);
for (const m of spellsTs.slice(spellsTs.indexOf("const AURA_BUFFS")).matchAll(/^  ([A-Za-z0-9]{4}):\s*\(/gm)) {
  HANDLED.add(m[1]);
}
// Not every ability casts through SPELL_HANDLERS. The on-attack "orb" abilities
// (Searing/Cold/Black Arrows, Incinerate) and the Defend stance are resolved in the
// attack/order path in world.ts instead, where they read as `ab.code === "AHfa"`.
// Count any 4-char id the sim compares an ability code against as implemented.
for (const file of ["sim/world.ts", "game/rts.ts", "render/mapViewer.ts"]) {
  const p = path.join(root, "src", file);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, "utf8");
  for (const m of src.matchAll(/\bcode\s*[!=]==\s*"([A-Za-z0-9]{4})"/g)) HANDLED.add(m[1]);
}

function status(a) {
  const code = a.code || a.alias;
  const self = HANDLED.has(a.alias) || KNOWN.has(a.alias);
  const viaCode = HANDLED.has(code) || KNOWN.has(code);
  if (HANDLED.has(a.alias)) return "done";
  if (KNOWN.has(a.alias)) return KNOWN.get(a.alias).target === "passive" ? "passive" : "partial";
  if (code !== a.alias && viaCode) return "alias";
  return self ? "partial" : "todo";
}

const MARK = { done: "x", passive: "x", alias: "~", partial: "/", todo: " " };

const rows = abilities
  .filter((a) => a.alias && a.alias.length === 4)
  .map((a) => {
    const f = func[a.alias] ?? {};
    const s = strs[a.alias] ?? {};
    return {
      alias: a.alias,
      code: a.code || a.alias,
      name: s.name || "",
      race: a.race || "",
      hero: a.hero === "1",
      item: a.item === "1",
      targs: (a.targs1 || "").replace(/_/g, "").trim(),
      icon: f.art || "",
      order: f.order || f.orderon || "",
      art: ["missileart", "targetart", "casterart", "specialart", "effectart", "areaeffectart"]
        .filter((k) => f[k] && f[k] !== "-").length,
      comment: a.comments || "",
      status: status(a),
    };
  })
  .sort((a, b) => (a.name || a.alias).localeCompare(b.name || b.alias) || a.alias.localeCompare(b.alias));

const tally = {};
for (const r of rows) tally[r.status] = (tally[r.status] ?? 0) + 1;

const esc = (v) => String(v).replace(/\|/g, "\\|");
const lines = [];
lines.push("# Ability implementation audit");
lines.push("");
lines.push("Generated by `node tools/audit-abilities.mjs` — do not hand-edit the table; edit the");
lines.push("sources (`src/data/abilities.ts` KNOWN_ABILITIES, `src/sim/spells.ts` SPELLS/AURA_BUFFS)");
lines.push("and re-run. Ground truth is the user's own 1.27a MPQs via `ExtractedData`.");
lines.push("");
lines.push("Status:");
lines.push("");
lines.push("- `x` **done** — a handler in `spells.ts` (or a passive resolved elsewhere) dispatches this id.");
lines.push("- `~` **alias** — no handler of its own, but its base `code` is implemented, so it inherits the behaviour.");
lines.push("- `/` **partial** — listed in `KNOWN_ABILITIES` (the UI can aim it) but nothing casts it yet.");
lines.push("- ` ` **todo** — not implemented.");
lines.push("");
lines.push(
  `Totals: ${rows.length} rows — ` +
    Object.entries(tally).sort().map(([k, v]) => `**${k}** ${v}`).join(", ") + ".",
);
lines.push("");
lines.push("| | ID | Code | Name | Race | H | I | targs1 | Art | Order | Comment |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  lines.push(
    `| ${MARK[r.status]} | \`${r.alias}\` | \`${r.code}\` | ${esc(r.name)} | ${r.race} | ${r.hero ? "H" : ""} | ${
      r.item ? "I" : ""
    } | ${esc(r.targs)} | ${r.art || ""} | ${esc(r.order)} | ${esc(r.comment)} |`,
  );
}
lines.push("");

fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`wrote ${out} — ${rows.length} abilities:`, tally);
