// Pull the DATA TABLES of another Warcraft III build, and diff them against ours (docs/patches.md).
//
// The patches in src/patches/data/ are transcribed by hand from the patch notes. Notes are prose,
// they leave things out (1.32.0 reverted the Necromancer without a word), and they disagree with
// each other, so this is the instrument that checks a transcription against the game itself:
//
//   node tools/patch-extract.mjs --cdn                      the LIVE build, from Blizzard's CDN
//   node tools/patch-extract.mjs --cdn --ptr                the PTR build
//   node tools/patch-extract.mjs --cdn <build> <cdn>        a build by its config hashes
//   node tools/patch-extract.mjs --install <folder>         a local CASC install (1.30+, any layout)
//   node tools/patch-extract.mjs --diff <out>               …then diff it against the 1.30.4 install
//   node tools/patch-extract.mjs --verify <out>             …and against OUR patch chain (the check)
//
// What comes out is `.cdn-cache/extract/<version>/`, laid out in 1.30.4's paths (`Units\…`,
// `Custom_V1\Units\…`, `Melee_V0\…`, `Scripts\…`) whatever the build's own layout was, so the two
// can be diffed file for file. It is the developer's own download to the developer's own disk and
// is gitignored, as `Warcraft III/` is: OpenWar3 ships zero Blizzard data (CLAUDE.md).
//
// Two facts about the CDN that decide what this can reach:
//   • Blizzard's CDN keeps only CURRENT builds. Every config from 1.30.0 to 2.0.4 is gone (404),
//     so the only builds it can serve are the live and the PTR one. The live build's MELEE tables
//     are the END of our chain — the balance every patch after 1.30.4 adds up to — which makes
//     `--verify` against it the check on the whole ledger at once.
//   • An OLDER build is reachable only from somebody's install of it: `--install` reads any
//     1.30+ CASC store off disk, in either layout (1.30's `War3.mpq:` archive names, or 1.32+'s
//     `War3.w3mod:` tree with its `_Balance\*.w3mod` and `_Locales\*.w3mod` sub-mods).
//
// The Forsaken Paladin (3.0.0) is filtered out of every diff (`DENIED_IDS`): he does not exist in
// this game, and the live build carries him.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(REPO, ".cdn-cache");

if (!fs.existsSync(path.join(REPO, ".casc-build", "src", "vfs", "casc.js"))) {
  execFileSync("npx", ["tsc", "-p", "tools/tsconfig.casc.json"], { cwd: REPO, stdio: "inherit" });
}
const { decodeBlte } = require(path.join(REPO, ".casc-build", "src", "vfs", "blte.js"));
const { parseEncoding, parseConfig, parseBuildInfo, parseIndex } = require(path.join(REPO, ".casc-build", "src", "vfs", "casc.js"));
const { MappedData } = require(path.join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata.js"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, n = 1) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.slice(i + 1, i + 1 + n) : null;
};

/** Which files are data. Tables, the melee AI, the scripts — never art or sound. */
const WANTED = /^((custom|melee)_v[01]\\)?(units\\[^\\]+\.(slk|txt)|scripts\\[^\\]+\.(ai|j|pld))$/i;
/** The Forsaken Paladin — mirrored from src/patches/index.ts DENIED_IDS. */
const DENIED_IDS = ["Npal"];
const LOCALE = "enUS";

// ---------------------------------------------------------------------------------------------
// Root names → 1.30.4 paths

/**
 * One root name (`<archive>:<path>`) as the 1.30.4 path it corresponds to, plus the layer it
 * sits in (a higher layer wins), or null for content we never want (HD/Reforged art, the
 * teen-rated set, another locale).
 */
function mapRootName(name) {
  const parts = name.split(":");
  const archive = parts[0].toLowerCase();
  // 1.30.x — `War3.mpq:Units\UnitData.slk`, `enUS-War3Local.mpq:Units\HumanUnitStrings.txt`,
  // with the four data sets as plain folders (`Custom_V1\Units\…`).
  if (archive.endsWith(".mpq")) {
    const layer = archive === "deprecated.mpq" ? 0 : archive === "war3.mpq" ? 1 : archive === `${LOCALE.toLowerCase()}-war3local.mpq` ? 2 : -1;
    if (layer < 0 || parts.length !== 2) return null;
    return { path: parts[1].replace(/\//g, "\\"), layer };
  }
  // 1.32+ — one `War3.w3mod` tree with sub-mods: `War3.w3mod:_Balance/Custom_V1.w3mod:Units/…`,
  // `War3.w3mod:_Locales/enUS.w3mod:Units/…`, `War3.w3mod:_HD.w3mod:…` (Reforged art).
  if (archive === "war3.w3mod") {
    if (parts.length === 2) return { path: parts[1].replace(/\//g, "\\"), layer: 1 };
    if (parts.length !== 3) return null;
    const sub = parts[1].replace(/\//g, "\\").toLowerCase();
    const rest = parts[2].replace(/\//g, "\\");
    const balance = /^_balance\\(custom_v0|custom_v1|melee_v0|melee_v1)\.w3mod$/.exec(sub);
    if (balance) {
      const set = { custom_v0: "Custom_V0", custom_v1: "Custom_V1", melee_v0: "Melee_V0", melee_v1: null }[balance[1]];
      return { path: set ? `${set}\\${rest}` : rest, layer: 3 };
    }
    if (sub === `_locales\\${LOCALE.toLowerCase()}.w3mod`) return { path: rest, layer: 2 };
    if (sub === "_deprecated.w3mod") return { path: rest, layer: 0 };
    return null;
  }
  return null;
}

/** Root text → 1.30.4 path → ckey, the highest layer winning. */
function rootTable(text) {
  const best = new Map();
  for (const line of text.split(/\r?\n/)) {
    const bar = line.indexOf("|");
    if (bar < 0) continue;
    const hit = mapRootName(line.slice(0, bar));
    if (!hit || !WANTED.test(hit.path)) continue;
    const ckey = line.slice(bar + 1, line.indexOf("|", bar + 1));
    const key = hit.path.toLowerCase();
    const prev = best.get(key);
    if (!prev || hit.layer >= prev.layer) best.set(key, { path: hit.path, ckey, layer: hit.layer });
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Storage backends: each answers `read(ekey)` and names its build.

async function cdnStorage(buildHash, cdnHash, product) {
  const cdns = await (await fetch(`http://us.patch.battle.net:1119/${product}/cdns`)).text();
  const row = cdns.split("\n").find((l) => l.startsWith("us|")).split("|");
  const hosts = row[2].split(" ");
  const base = row[1];
  if (!buildHash) {
    const versions = await (await fetch(`http://us.patch.battle.net:1119/${product}/versions`)).text();
    const us = versions.split("\n").find((l) => l.startsWith("us|")).split("|");
    [buildHash, cdnHash] = [us[1], us[2]];
  }
  const get = async (kind, hash, suffix = "", range = null) => {
    const file = path.join(CACHE, kind, hash + suffix + (range ? `@${range[0]}` : ""));
    if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file));
    let last = null;
    for (const host of hosts) {
      const url = `http://${host}/${base}/${kind}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${suffix}`;
      const res = await fetch(url, range ? { headers: { Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` } } : {});
      if (!res.ok) { last = `${url} ${res.status}`; continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return bytes;
    }
    throw new Error(`not on the CDN: ${last} — Blizzard keeps only current builds (see the header)`);
  };
  const build = parseConfig(new TextDecoder().decode(await get("config", buildHash)));
  const cdn = parseConfig(new TextDecoder().decode(await get("config", cdnHash)));

  // Archive indices: EKey → (archive, offset, size). A CDN index is 4 KB blocks of
  // key(16) size(4 BE) offset(4 BE), with a footer that says so.
  const where = new Map();
  await Promise.all((cdn.get("archives") ?? "").split(" ").filter(Boolean).map(async (archive) => {
    const b = await get("data", archive, ".index");
    const f = b.subarray(b.length - 20);
    const [blockKB, offB, sizeB, keyB] = [f[3], f[4], f[5], f[6]];
    const count = f[8] | (f[9] << 8) | (f[10] << 16) | (f[11] << 24);
    const block = blockKB * 1024, rec = keyB + sizeB + offB;
    let seen = 0;
    for (let at = 0; seen < count && at + block <= b.length; at += block) {
      for (let p = at; p + rec <= at + block && seen < count; p += rec) {
        if (b.subarray(p, p + keyB).every((x) => x === 0)) break;
        const key = Buffer.from(b.subarray(p, p + keyB)).toString("hex");
        let size = 0, off = 0;
        for (let i = 0; i < sizeB; i++) size = size * 256 + b[p + keyB + i];
        for (let i = 0; i < offB; i++) off = off * 256 + b[p + keyB + sizeB + i];
        where.set(key, { archive, off, size });
        seen++;
      }
    }
  }));
  const read = async (ekey) => {
    const at = where.get(ekey);
    return decodeBlte(at ? await get("data", at.archive, "", [at.off, at.size]) : await get("data", ekey));
  };
  return { build, read, version: build.get("build-name") ?? buildHash };
}

function installStorage(dir) {
  const info = parseBuildInfo(fs.readFileSync(path.join(dir, ".build.info"), "utf8"));
  const config = new Map(), idx = new Map(), data = new Map();
  const walk = (at, depth) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(full, depth + 1); }
      else if (/^[0-9a-f]{10}\.idx$/i.test(e.name)) idx.set(e.name.toLowerCase(), new Uint8Array(fs.readFileSync(full)));
      else if (/^data\.\d{3}$/i.test(e.name)) data.set(Number(e.name.slice(5)), full);
      else if (/^[0-9a-f]{32}$/i.test(e.name)) config.set(e.name.toLowerCase(), full);
    }
  };
  walk(path.join(dir, "Data"), 0);
  const build = parseConfig(fs.readFileSync(config.get(info.get("Build Key").toLowerCase()), "utf8"));
  const index = parseIndex(idx);
  const read = async (ekey) => {
    const loc = index.get(ekey.slice(0, 18));
    if (!loc) throw new Error(`not in this install: ${ekey}`);
    const fd = fs.openSync(data.get(loc.archive), "r");
    const buf = Buffer.alloc(loc.size - 30);
    fs.readSync(fd, buf, 0, buf.length, loc.offset + 30);
    fs.closeSync(fd);
    return decodeBlte(new Uint8Array(buf));
  };
  return { build, read, version: info.get("Version") ?? "unknown" };
}

async function extract(storage) {
  const { build, read, version } = storage;
  const encoding = parseEncoding(await read(build.get("encoding").split(" ")[1]));
  const root = new TextDecoder("latin1").decode(await read(encoding.get(build.get("root").split(" ")[0])));
  const table = rootTable(root);
  const out = path.join(CACHE, "extract", version);
  let n = 0;
  for (const { path: p, ckey } of table.values()) {
    const ekey = encoding.get(ckey);
    if (!ekey) continue;
    const file = path.join(out, ...p.split("\\"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await read(ekey));
    n++;
  }
  console.log(`wrote ${n} data files of ${version} to ${path.relative(REPO, out)}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Diff: two trees in 1.30.4 layout, compared as TABLES (row → column → value), which is what the
// game reads — a re-saved SLK that moved every cell is not a change.

function listTree(dir) {
  const out = new Map();
  const walk = (at, rel) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const r = rel ? `${rel}\\${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(at, e.name), r);
      else out.set(r.toLowerCase(), path.join(at, e.name));
    }
  };
  walk(dir, "");
  return out;
}

const table = (file) => new MappedData(new TextDecoder("windows-1252").decode(fs.readFileSync(file)));

/** Columns 1.32 moved out of the tables into `*Skin.txt` (art, sound) — present-in-one,
 *  absent-in-the-other there is a layout change, not a balance one. */
const ART_KEY = /^(art|buttonpos|unbuttonpos|researchbuttonpos|file|model|missileart|specialart|effectart|targetart|casterart|areaeffectart|lightningeffect|animnames|scale|soundset|.*sound.*|portrait|.*art\d*)$/i;

const empty = (v) => v === undefined || v === "" || v === "_" || v === "-" || v === " - ";

/** The columns of an SLK (its first row), lower-cased — empty for a TXT, whose keys vary per
 *  section. */
function slkColumns(file) {
  if (!/\.slk$/i.test(file)) return null;
  const text = new TextDecoder("windows-1252").decode(fs.readFileSync(file));
  const cols = new Set();
  for (const line of text.split("\n")) {
    const m = /^C;X\d+(;Y1)?;K"?([^";\r]*)/.exec(line);
    if (/^C;.*Y(?!1;)\d+/.test(line)) break;
    if (m) cols.add(m[2].toLowerCase());
  }
  return cols;
}

/**
 * Two trees in 1.30.4 layout, compared as TABLES. Three things are LAYOUT and are left out, or
 * 1.32's restructuring drowns every balance change in a hundred thousand lines:
 *   • a column only one side's SLK has (1.31 added `stockInitial`, 1.32 `DataK`–`DataT`);
 *   • a column the newer build emptied in EVERY row (art and sound moved to `*Skin.txt`);
 *   • a new row nothing we changed points at (Reforged's campaign items and abilities).
 * Strings files (names, tooltips) are left out unless `strings` — a reworded tooltip is not a
 * balance change, and every one of them was reworded for the in-game hotkey editor.
 */
function diffTrees(ours, theirs, only, strings = false) {
  const a = listTree(ours), b = listTree(theirs);
  const report = [];
  const newRows = [];
  for (const [key, fileB] of b) {
    if (!only.test(key) || !/\.(slk|txt)$/.test(key)) continue;
    if (!strings && /strings\.txt$/i.test(key)) continue;
    const fileA = a.get(key);
    if (!fileA) continue; // a file 1.30.4 never had (the *Skin.txt split) is layout
    const ta = table(fileA), tb = table(fileB);
    const ca = slkColumns(fileA), cb = slkColumns(fileB);
    const deadColumns = new Set();
    if (cb) for (const col of cb) if (Object.values(tb.map).every((r) => empty(r.map[col]))) deadColumns.add(col);
    for (const id of new Set([...Object.keys(ta.map), ...Object.keys(tb.map)])) {
      if (DENIED_IDS.includes(id)) continue;
      const ra = ta.map[id]?.map, rb = tb.map[id]?.map;
      if (!ra) { newRows.push({ file: key, row: id, note: "new row", values: rb }); continue; }
      if (!rb) { report.push({ file: key, row: id, note: "row removed" }); continue; }
      for (const col of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        if (ca && cb && !(ca.has(col) && cb.has(col))) continue;
        if (deadColumns.has(col)) continue;
        const va = ra[col] ?? "", vb = rb[col] ?? "";
        if (va === vb || (empty(va) && empty(vb))) continue;
        if (empty(vb) && ART_KEY.test(col)) continue; // moved to *Skin.txt in 1.32
        if (/^-?[\d.]+$/.test(va) && /^-?[\d.]+$/.test(vb) && parseFloat(va) === parseFloat(vb)) continue; // "1" vs "1.0"
        report.push({ file: key, row: id, col, from: va, to: vb });
      }
    }
  }
  // A new row is reported when a CHANGED cell names it — a Makeitems that now lists it, a unit's
  // ability list that now carries it — or when it is named by the flag `--all-new`.
  const named = new Set();
  for (const r of report) for (const tok of String(r.to ?? "").split(",")) named.add(tok.trim());
  for (const r of newRows) if (named.has(r.row) || flag("--all-new")) report.push(r);
  report.sort((x, y) => (x.file === y.file ? 0 : x.file < y.file ? -1 : 1));
  return report;
}

function printReport(report, title) {
  console.log(`\n== ${title}: ${report.length} differences`);
  let file = "";
  for (const r of report) {
    if (r.file !== file) console.log(`\n${(file = r.file)}`);
    if (r.col) console.log(`  [${r.row}] ${r.col}: ${r.from || "∅"} → ${r.to || "∅"}`);
    else console.log(`  [${r.row}] ${r.note}${r.values ? `  (${Object.entries(r.values).filter(([, v]) => v).length} fields)` : ""}`);
  }
}

// ---------------------------------------------------------------------------------------------

const INSTALL = path.join(REPO, "Warcraft III", "ExtractedData", "merged");
let out = null;
if (flag("--cdn")) {
  const hashes = opt("--cdn", 2).filter((h) => /^[0-9a-f]{32}$/.test(h));
  out = await extract(await cdnStorage(hashes[0], hashes[1], flag("--ptr") ? "w3t" : "w3"));
} else if (opt("--install")) {
  out = await extract(installStorage(opt("--install")[0]));
}
const diffDir = opt("--diff")?.[0] ?? (flag("--diff") ? out : null);
const verifyDir = opt("--verify")?.[0] ?? (flag("--verify") ? out : null);
if (diffDir) {
  const only = /^units\\[^\\]+\.(slk|txt)$/i; // the live melee tables — the corner the patches touch
  printReport(diffTrees(INSTALL, diffDir, only), `1.30.4 → ${path.basename(diffDir)} (live melee tables)`);
}
if (verifyDir) {
  // Our chain, applied to the install, against the build: what is left is either a line of the
  // notes we have not transcribed, a value we got wrong, or a change the notes never mention.
  const chain = path.join(CACHE, "chain");
  fs.rmSync(chain, { recursive: true, force: true });
  execFileSync("node", [path.join(REPO, "tools", "patch-check.cjs"), "--dump", chain], { cwd: REPO, stdio: "inherit" });
  const merged = path.join(CACHE, "chain-merged");
  fs.rmSync(merged, { recursive: true, force: true });
  fs.cpSync(INSTALL, merged, { recursive: true, filter: (src) => !/ExtractedData[\\/]merged[\\/](Maps|ReplaceableTextures|Doodads)/.test(src) });
  if (fs.existsSync(chain)) fs.cpSync(chain, merged, { recursive: true });
  const only = /^units\\[^\\]+\.(slk|txt)$/i;
  printReport(diffTrees(merged, verifyDir, only), `our chain → ${path.basename(verifyDir)} (live melee tables)`);
}
if (!out && !diffDir && !verifyDir) {
  console.log("usage: --cdn [--ptr] [<build> <cdn>] | --install <folder>, then --diff / --verify (see the header)");
}
