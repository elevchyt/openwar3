// Audit the patch chain RELEASE BY RELEASE against every real build we can read (docs/patches.md).
//
// `patch-extract.mjs --verify` checks the chain at ONE level against ONE build. This walks the
// whole chain and, for every cell a release edits, asks every CHECKPOINT that can speak to it:
//
//   • a checkpoint AT OR AFTER the release, with no later release touching the cell before it,
//     must show the value the release wrote — or the release wrote the wrong value (or the wrong
//     cell), or a change between the two is missing from the ledger;
//   • the value BEFORE the release is printed beside the note, so a reviewer can hold it against
//     the note's own "from X": a "from" that does not match is the sign of a misread row.
//
// Checkpoints are directories in 1.30.4's layout (tools/patch-extract.mjs writes them), each
// standing for a patch LEVEL:
//
//   .cdn-cache/extract/<version>-community     community copies of 1.31.1, 1.32.1, 1.32.5, 1.32.7,
//                                               1.32.9, 1.32.10, 2.0.2, 2.0.3, 2.0.4 (docs/patches.md)
//   .cdn-cache/extract/1.32.8-w3x2lni          1.32.8 (sumneko/w3x2lni)
//   .cdn-cache/extract/3.0.0.24268-retail      the live build (3.0.0 changed no melee balance but the
//                                               hero we ignore, so it stands after 2.0.4)
//   more with  --checkpoint <dir>=<level>
//
// A checkpoint only speaks for the cells its copy HAS: several community copies carry a subset
// of the files, and a file a checkpoint lacks is simply not asked.
//
//   node tools/patch-audit.mjs                   every release → .cdn-cache/audit/<release>.txt + a summary
//   node tools/patch-audit.mjs --release 1.36.2  one release, to stdout
//   …--no-build                                  skip compiling the sim build (several audits at once)
//
// Text keys (Name, Tip, Ubertip, …) are never compared: a patch's words are ours by rule, and
// half the community copies are Chinese anyway.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(REPO, ".sim-build");
if (!process.argv.includes("--no-build")) execFileSync("npx", ["tsc", "-p", "tools/tsconfig.sim.json"], { cwd: REPO, stdio: "inherit" });
fs.writeFileSync(path.join(BUILD, "package.json"), '{"type":"commonjs"}');
const { patchTable } = require(path.join(BUILD, "src", "patches", "tables.js"));
const { compareVersions } = require(path.join(BUILD, "src", "patches", "index.js"));
const { MappedData } = require(path.join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata.js"));

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const INSTALL = path.join(REPO, "Warcraft III", "ExtractedData", "merged");
const DATA = path.join(REPO, "src", "patches", "data");

// Community copies of the raw tables (docs/patches.md lists each source and how its version was
// established), and the live build off the CDN. A directory that is not there is skipped.
const X = (name) => path.join(REPO, ".cdn-cache", "extract", name);
const checkpoints = [
  { dir: X("1.31.1-community"), level: "1.31.1" },
  { dir: X("1.32.1-community"), level: "1.32.1" },
  { dir: X("1.32.5-community"), level: "1.32.5" },
  { dir: X("1.32.7-community"), level: "1.32.7" },
  { dir: X("1.32.8-w3x2lni"), level: "1.32.8" },
  { dir: X("1.32.9-community"), level: "1.32.9" },
  { dir: X("1.32.10-community"), level: "1.32.10" },
  { dir: X("2.0.2-community"), level: "2.0.2" },
  { dir: X("2.0.3-community"), level: "2.0.3" },
  { dir: X("2.0.4-community"), level: "2.0.4" },
  // A retail 2.0.4.23745 install read off disk (`patch-extract.mjs --install`) — first-party, and
  // the build the chain is meant to END at, so it outranks every copy above where they differ.
  { dir: X("2.0.4.23745"), level: "2.0.4.99999" },
  { dir: X("3.0.0.24268-retail"), level: "3.0.0" },
];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--checkpoint") continue;
  const [dir, level] = args[i + 1].split("=");
  checkpoints.push({ dir: path.resolve(dir), level });
}
const live = checkpoints.filter((c) => fs.existsSync(c.dir)).sort((a, b) => compareVersions(a.level, b.level));

/** Case-insensitive file lookup under a tree in 1.30.4 layout. */
function find(root, p) {
  let dir = root;
  for (const part of p.replace(/\//g, "\\").split("\\")) {
    if (!part) continue;
    let hit;
    try { hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase()); } catch { return null; }
    if (!hit) return null;
    dir = path.join(dir, hit);
  }
  return fs.statSync(dir).isFile() ? dir : null;
}
/** A table as MappedData, with a TXT's LF endings made CRLF (mdx-m3-viewer's IniFile splits on
 *  \r\n alone — a snapshot saved with LF otherwise reads as one empty section). */
function table(bytes) {
  let text = new TextDecoder("windows-1252").decode(bytes);
  if (!text.startsWith("ID;")) text = text.replace(/\r*\n/g, "\r\n").replace(/\r*$/, "\r\n");
  return new MappedData(text);
}
const cpTables = new Map();
function cpTable(cp, file) {
  const key = `${cp.dir}|${file.toLowerCase()}`;
  if (!cpTables.has(key)) {
    const f = find(cp.dir, file);
    cpTables.set(key, f ? table(fs.readFileSync(f)) : null);
  }
  return cpTables.get(key);
}

const EMPTY = new Set(["", "-", "_", " - "]);
const norm = (v) => {
  if (v === undefined || v === null) return "";
  let s = String(v).trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (EMPTY.has(s)) return "";
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(parseFloat(s));
  return s.toLowerCase();
};
const PRESENTATION = /art|attach|sound|missile|lightning|^file$|scale|^color[rgb]$|^armor$|^selsize$|buttonpos|^animnames/i;
const TEXT_KEY = /^(buffubertip|name|tip|ubertip|description|researchtip|researchubertip|revivetip|awakentip|editorsuffix|bufftip|bufubertip|untip|unubertip|hotkey|researchhotkey|unhotkey|comment|comments|comment\(s\))$/i;

// --- replay the chain, keeping the state after every release -----------------------------------
const releases = fs.readdirSync(DATA).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")))
  .sort((a, b) => compareVersions(a.patch, b.patch));
const bytes = new Map(); // lower path → current bytes
const cur = (p) => {
  const k = p.toLowerCase();
  if (!bytes.has(k)) { const f = find(INSTALL, p); bytes.set(k, f ? new Uint8Array(fs.readFileSync(f)) : null); }
  return bytes.get(k);
};
/** Every (release, file, row, column) edit with the value before and after. */
const edits = [];
for (const [ri, rel] of releases.entries()) {
  for (const change of rel.changes) {
    for (const [file, rows] of Object.entries(change.files ?? {})) {
      const before = cur(file);
      if (!before) continue;
      const after = patchTable(file, before, rows, []);
      const tb = table(before), ta = table(after);
      for (const [row, edit] of Object.entries(rows)) {
        const cols = edit === null ? Object.keys(tb.getRow(row)?.map ?? {}) : Object.keys(edit).filter((k) => k !== "$base");
        if (edit?.$base) for (const k of Object.keys(ta.getRow(row)?.map ?? {})) if (!cols.some((c) => c.toLowerCase() === k)) cols.push(k);
        for (const col of cols) {
          edits.push({
            seq: edits.length, ri, release: rel.patch, note: change.note, source: change.source ?? "", file, row, col,
            before: tb.getRow(row)?.map[col.toLowerCase()], after: ta.getRow(row)?.map[col.toLowerCase()],
            created: !!edit?.$base || !tb.getRow(row),
          });
        }
      }
      bytes.set(file.toLowerCase(), after);
    }
  }
}

// --- judge every edit against the checkpoints ----------------------------------------------------
const cellKey = (e) => `${e.file.toLowerCase()}|${e.row}|${e.col.toLowerCase()}`;
const byCell = new Map();
for (const e of edits) {
  const k = cellKey(e);
  if (!byCell.has(k)) byCell.set(k, []);
  byCell.get(k).push(e);
}
for (const e of edits) {
  e.flags = [];
  const later = byCell.get(cellKey(e)).filter((o) => o.seq > e.seq);
  for (const cp of live) {
    if (compareVersions(cp.level, e.release) < 0) continue;
    if (later.some((o) => compareVersions(o.release, cp.level) <= 0)) continue; // a later edit speaks for that checkpoint
    // Our words are ours by design (no Blizzard text in a patch), so a tooltip is never
    // expected to match a checkpoint's — only its numbers are, and those live in the tables.
    if (TEXT_KEY.test(e.col)) continue;
    const t = cpTable(cp, e.file);
    if (!t) continue;
    const have = t.getRow(e.row)?.map[e.col.toLowerCase()];
    // Art, sound and model columns moved to `*Skin.txt` in 1.32: an EMPTY cell there is the
    // move, not a disagreement.
    if (norm(have) === "" && PRESENTATION.test(e.col)) continue;
    if (norm(have) !== norm(e.after)) e.flags.push(`${cp.level} checkpoint has ${have === undefined ? "∅" : JSON.stringify(have)}`);
  }
}

// --- report ---------------------------------------------------------------------------------------
const show = (v) => (v === undefined ? "∅" : JSON.stringify(v));
function report(rel) {
  const mine = edits.filter((e) => e.release === rel.patch);
  const lines = [`# ${rel.patch} (build ${rel.build}, ${rel.released}) — ${mine.length} cell edits, ${mine.filter((e) => e.flags.length).length} flagged`, ""];
  let note = null;
  for (const e of mine) {
    if (e.note !== note) { lines.push(`## ${e.note}${e.source ? `  [${e.source}]` : ""}`); note = e.note; }
    lines.push(`${e.flags.length ? "FLAG" : "    "}  ${e.file} [${e.row}] ${e.col}: ${e.created ? "(new) " : ""}${show(e.before)} → ${show(e.after)}${e.flags.length ? `   ← ${e.flags.join("; ")}` : ""}`);
  }
  for (const eng of rel.engine ?? []) lines.push(`ENGINE  ${eng.key}: ${eng.note}`);
  return lines.join("\n");
}
const only = opt("--release");
if (only) {
  const rel = releases.find((r) => r.patch === only);
  if (!rel) throw new Error(`no release ${only}`);
  console.log(report(rel));
} else {
  const out = path.join(REPO, ".cdn-cache", "audit");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  console.log(`checkpoints: ${live.map((c) => `${c.level} (${path.basename(c.dir)})`).join(", ")}`);
  for (const rel of releases) {
    fs.writeFileSync(path.join(out, `${rel.patch}.txt`), report(rel) + "\n");
    const mine = edits.filter((e) => e.release === rel.patch);
    console.log(`${rel.patch.padEnd(14)} ${String(mine.length).padStart(4)} cells  ${String(mine.filter((e) => e.flags.length).length).padStart(3)} flagged`);
  }
  console.log(`\nwrote ${path.relative(REPO, out)}/<release>.txt`);
}
