// PATCHES — every release in src/patches/data/ applies cleanly to the install it is written
// against (docs/patches.md, issue #160).
//
// A patch names a file, a row id and a column in the game's own terms. A typo there is not an
// error anywhere at runtime — PatchDataSource logs it and the game plays on without that edit —
// so this is the gate that turns each one into a failure:
//
//   • every file in data/ is listed in manifest.ts (an unlisted patch is never applied);
//   • every patch applies over the chain before it with ZERO problems: the file exists, the row
//     exists (or is created with a `$base` that does), the column exists;
//   • every `art` path is one src/patches/art.ts serves, and art.ts is fresh (tools/patch-art.mjs);
//   • nothing mentions the Forsaken Paladin (3.0.0) — he does not exist in this game;
//   • the chain is IDEMPOTENT where it must be: an edit that sets a value the table already has
//     is reported (a hint the row was misread, or the patch restates an earlier one).
//
// Also a tool for writing patches:
//   node tools/patch-check.cjs --show hfoo            that row, in every file, before and after
//   node tools/patch-check.cjs --level 1.32.10 …      at an earlier patch level
//   node tools/patch-check.cjs --dump <dir>           write every patched table to <dir>
//
// Run: pnpm patches:check   (after `pnpm data:extract`; skips without the extracted tables)
const { join } = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".sim-build");

fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(join(BUILD, "package.json"), '{"type":"commonjs"}');
if (!fs.existsSync(join(BUILD, "src", "vfs", "patch.js")) || process.argv.includes("--build")) {
  execFileSync("npx", ["tsc", "-p", "tools/tsconfig.sim.json"], { cwd: REPO, stdio: "inherit" });
}
const patches = require(join(BUILD, "src", "patches", "index.js"));
const { patchTable } = require(join(BUILD, "src", "patches", "tables.js"));
const { PATCH_ART } = require(join(BUILD, "src", "patches", "art.js"));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "UnitBalance.slk"))) {
  console.log("skip  no extracted install (run `pnpm data:extract` on a 1.30.4 install)");
  process.exit(0);
}

/** Case-insensitive lookup into the extracted tree, like the archives it came out of. */
function onDisk(p) {
  let dir = EXTRACT;
  for (const part of p.replace(/\//g, "\\").split("\\")) {
    if (!part) continue;
    let hit;
    try { hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase()); } catch { return null; }
    if (!hit) return null;
    dir = join(dir, hit);
  }
  return fs.statSync(dir).isFile() ? dir : null;
}
const install = (p) => {
  const f = onDisk(p);
  return f ? new Uint8Array(fs.readFileSync(f)) : null;
};

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL  ${msg}`); };
const ok = (msg) => console.log(`ok    ${msg}`);

// --- 0. the rewrite is LOSSLESS: every table, rewritten with no edits, reads back the same ---
{
  const { MappedData } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata.js"));
  const dir = join(EXTRACT, "Units");
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((f) => /\.(slk|txt)$/i.test(f))) {
    const bytes = new Uint8Array(fs.readFileSync(join(dir, f)));
    const out = patchTable(`Units\\${f}`, bytes, {}, []);
    const a = new MappedData(new TextDecoder("windows-1252").decode(bytes));
    const b = new MappedData(new TextDecoder("windows-1252").decode(out));
    if (JSON.stringify(a.map) !== JSON.stringify(b.map)) fail(`Units\\${f}: rewriting it with no edits changed what it reads as`);
    if (/\.txt$/i.test(f) && Buffer.compare(Buffer.from(bytes), Buffer.from(out)) !== 0) fail(`Units\\${f}: a TXT rewritten with no edits is not byte-identical`);
    n++;
  }
  ok(`the rewrite is lossless on all ${n} Units tables`);
}

// --- 1. the manifest lists exactly the files on disk -----------------------------------------
const DATA = join(REPO, "src", "patches", "data");
const onDiskPatches = fs.readdirSync(DATA).filter((f) => f.endsWith(".json")).sort();
const listed = new Set(patches.PATCHES.map((p) => `${p.patch}.json`));
for (const f of onDiskPatches) if (!listed.has(f)) fail(`${f} is in data/ but not imported by manifest.ts (or its "patch" field disagrees with its name)`);
for (const f of listed) if (!onDiskPatches.includes(f)) fail(`manifest.ts lists ${f}, which is not in data/`);
ok(`${patches.PATCHES.length} patches, ${patches.BASE_PATCH} → ${patches.LATEST_PATCH}`);

// --- 2. art.ts is fresh ------------------------------------------------------------------------
try {
  execFileSync("node", [join(REPO, "tools", "patch-art.mjs"), "--check"], { cwd: REPO, stdio: "pipe" });
  ok("src/patches/art.ts is fresh");
} catch (e) {
  fail(String(e.stderr || e.message).trim());
}

// --- 3. every patch, applied over the chain before it -------------------------------------------
const state = new Map(); // lower path → current bytes
const seen = new Set();
const read = (path) => {
  const key = path.toLowerCase();
  if (!state.has(key)) state.set(key, install(path));
  return state.get(key);
};
const target = opt("--level") ?? patches.LATEST_PATCH;
if (opt("--level")) patches.setPatchLevel(target);
const ids = (edits) => Object.keys(edits);

// Read off DISK, not through the manifest, so a release being written can be checked before it
// is imported (the manifest check above says whether it is).
const onDiskChain = onDiskPatches
  .map((f) => JSON.parse(fs.readFileSync(join(DATA, f), "utf8")))
  .sort((a, b) => patches.compareVersions(a.patch, b.patch));
for (const patch of onDiskChain) {
  if (patches.compareVersions(patch.patch, target) > 0) break;
  const where = patch.patch;
  const text = JSON.stringify(patch);
  for (const word of patches.DENIED_WORDS) if (word.test(text)) fail(`${where}: mentions the Forsaken Paladin (${word}) — he does not exist in this game`);
  if (!patch.build || !patch.released || !Array.isArray(patch.notes) || !Array.isArray(patch.changes)) fail(`${where}: needs build, released, notes[] and changes[]`);
  let rows = 0;
  for (const change of patch.changes) {
    if (!change.note) fail(`${where}: a change with no note`);
    for (const art of change.art ?? []) if (!(art in PATCH_ART)) fail(`${where}: art ${art} is not in src/patches/art.ts`);
    for (const [path, edits] of Object.entries(change.files ?? {})) {
      const bytes = read(path);
      if (!bytes) { fail(`${where}: ${path} is not a file of the install`); continue; }
      const problems = [];
      const before = new TextDecoder("windows-1252").decode(bytes);
      const after = patchTable(path, bytes, edits, problems);
      for (const p of problems) fail(`${where}: ${p.file} [${p.row}] ${p.message}  — "${change.note}"`);
      // An edit that changes nothing is a misread row or a restated one.
      const { MappedData } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata.js"));
      const was = new MappedData(before);
      for (const [id, edit] of Object.entries(edits)) {
        rows++;
        if (!edit || !was.getRow(id)) continue;
        for (const [k, v] of Object.entries(edit)) {
          if (k === "$base" || v === null || typeof v === "object") continue;
          const old = was.getRow(id).string(k);
          if (old !== undefined && old.replace(/^"|"$/g, "") === String(v).replace(/^"|"$/g, "")) {
            console.warn(`note  ${where}: ${path} [${id}] ${k} is already ${v} — "${change.note}"`);
          }
        }
      }
      state.set(path.toLowerCase(), after);
      seen.add(path);
      for (const id of ids(edits)) if (patches.DENIED_IDS.includes(id)) fail(`${where}: ${path} names ${id}`);
    }
  }
  ok(`${where} (${patch.changes.length} changes, ${rows} row edits)`);
}

// --- 4. the chain the GAME folds matches the one applied step by step here ---------------------
for (const path of seen) {
  const direct = patchTable(path, install(path), patches.patchedEdits(path) ?? {}, [], true);
  const stepped = state.get(path.toLowerCase());
  const a = new TextDecoder("latin1").decode(direct);
  const b = new TextDecoder("latin1").decode(stepped);
  // Composition may reorder rows a patch ADDED, so compare as parsed tables, not as text.
  const { MappedData } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata.js"));
  const ma = new MappedData(a), mb = new MappedData(b);
  const keys = new Set([...Object.keys(ma.map), ...Object.keys(mb.map)]);
  let diff = 0;
  // …and as ROWS, not as key order: a key removed by one release and set again by a later one
  // lands at the end of its section when applied step by step, and in place when folded.
  const canon = (row) => JSON.stringify(Object.entries(row?.map ?? {}).sort(([x], [y]) => (x < y ? -1 : 1)));
  for (const k of keys) if (canon(ma.map[k]) !== canon(mb.map[k])) diff++;
  if (diff) fail(`${path}: the folded chain and the step-by-step chain disagree on ${diff} rows`);
}
ok(`the folded chain matches step-by-step application on ${seen.size} files`);

// --- tools -----------------------------------------------------------------------------------
const show = opt("--show");
if (show) {
  const { MappedData } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata.js"));
  for (const path of seen) {
    const was = new MappedData(new TextDecoder("windows-1252").decode(install(path))).getRow(show);
    const now = new MappedData(new TextDecoder("windows-1252").decode(state.get(path.toLowerCase()))).getRow(show);
    if (!was && !now) continue;
    console.log(`\n${path} [${show}]`);
    for (const k of new Set([...Object.keys(was?.map ?? {}), ...Object.keys(now?.map ?? {})])) {
      const a = was?.map[k], b = now?.map[k];
      if (a !== b) console.log(`  ${k}: ${a ?? "∅"} → ${b ?? "∅"}`);
    }
  }
}
const dump = opt("--dump");
if (dump) {
  for (const path of seen) {
    const out = join(dump, ...path.split("\\"));
    fs.mkdirSync(join(out, ".."), { recursive: true });
    fs.writeFileSync(out, state.get(path.toLowerCase()));
  }
  ok(`wrote ${seen.size} patched tables to ${dump}`);
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
