// Native-coverage report for the Phase 7 JASS work (docs/triggers.md, issue #33).
//
//   node tools/native-coverage.mjs [--wc3-dir "<path to Warcraft III>"] [--all]
//                                  [--maps <folder>] [--calls]
//
// `--maps` scans ONE folder instead of the whole install — `--maps "Warcraft III/Maps/Download"`
// is the later-format corpus (docs/map-compatibility.md), and it answers a different question
// from the default: the install's own 200+ maps are Blizzard's, so their ranking says nothing
// about what a map downloaded from Hive today calls. `--calls` ranks by CALL SITES rather than
// by how many maps mention a native once, which is what says how load-bearing it is.
//
// Warcraft III compiles every map's triggers into one script the engine runs
// (war3map.j). That script is layered on `Scripts\common.j` (native declarations)
// and `Scripts\blizzard.j` (a JASS library on top of the natives). Only a fraction
// of common.j's 1000+ natives are actually used by real maps, so we implement them
// on demand, most-used first. This tool answers "which natives, ranked by how many
// maps call them, are still UNIMPLEMENTED in src/jass/natives/?" so each milestone
// can pick the next batch (Phase 7 plan, "Deliverable 0").
//
// It reads only the developer's own local install (Warcraft III/ is gitignored;
// OpenWar3 ships zero Blizzard assets — see CLAUDE.md "Legal boundary").

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const mpqMod = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
const MpqArchive = (mpqMod.default ?? mpqMod).Archive;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argDir = process.argv.indexOf('--wc3-dir');
const WC3_DIR = argDir !== -1 ? process.argv[argDir + 1] : join(REPO, 'Warcraft III');
const SHOW_ALL = process.argv.includes('--all');
const BY_CALLS = process.argv.includes('--calls');
const argMaps = process.argv.indexOf('--maps');
const MAPS_DIR = argMaps !== -1 ? resolve(process.argv[argMaps + 1]) : join(WC3_DIR, 'Maps');

const SEP = String.fromCharCode(92); // '\'
const decode = (bytes) => new TextDecoder('windows-1252').decode(bytes);

function openArchive(path) {
  const buf = readFileSync(path);
  const bytes = new Uint8Array(buf.byteLength); // standalone copy — Node Buffers are unaligned
  bytes.set(buf);
  const archive = new MpqArchive();
  archive.load(bytes, true);
  return archive;
}

/** Read a file from a map archive (war3map.j lives at the root or under scripts\). */
function readFromArchive(archive, name) {
  const f = archive.get(name) ?? archive.get(`scripts${SEP}${name}`);
  return f ? decode(f.bytes()) : null;
}

// --- the native surface, from common.j -------------------------------------
const commonJ = readFileSync(join(WC3_DIR, 'ExtractedData', 'merged', 'Scripts', 'common.j'), 'latin1');
const NATIVE_RE = /^\s*(?:constant\s+)?native\s+([A-Za-z_]\w*)\b/gm;
const allNatives = new Set();
for (const m of commonJ.matchAll(NATIVE_RE)) allNatives.add(m[1]);

// --- what we've implemented so far -----------------------------------------
// ASK THE REGISTRY, don't grep for it. A headless interpreter registers every native the real
// one does (`registerNatives`), so its `rt.natives` keys ARE the answer and cannot drift from
// the code. That matters because a whole family can be registered under names the source never
// spells: `natives/hashtable.ts` builds `Save${kind}Handle` / `Load${kind}Handle` in a loop over
// forty handle types, and a string scan therefore reported all eighty — ~450 call sites in DotA
// alone — as missing work that was already done.
//
// Needs `tsc -p tools/tsconfig.jass.json` to have run (that is what `pnpm jass:coverage` does).
// Falls back to the old string scan with a warning, so the tool still says something useful in
// a tree that has not been built.
const implemented = new Set();
const BUILD = join(REPO, '.jass-build', 'src', 'jass', 'headless.js');
if (existsSync(BUILD)) {
  const { buildInterpreter } = require(BUILD);
  // An empty program: we want the registry, not a run.
  for (const name of buildInterpreter(['']).rt.natives.keys()) implemented.add(name);
} else {
  console.warn('! .jass-build missing — falling back to a string scan (run `tsc -p tools/tsconfig.jass.json`).');
  const nativesDir = join(REPO, 'src', 'jass', 'natives');
  if (existsSync(nativesDir)) {
    for (const f of readdirSync(nativesDir)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join(nativesDir, f), 'utf8');
      for (const name of allNatives) {
        // `"Name"` / `'Name'`, or `Name:` as a bare key (the leading guard keeps it from
        // matching prose in a comment, which a bare word-boundary search would).
        if (src.includes(`"${name}"`) || src.includes(`'${name}'`) || new RegExp(`(^|[^\\w"'.])${name}\\s*:`, 'm').test(src)) {
          implemented.add(name);
        }
      }
    }
  }
}

// --- scan the bundled map corpus -------------------------------------------
function findMaps(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findMaps(p));
    else if (/\.w3[mx]$/i.test(e.name)) out.push(p);
  }
  return out;
}

const maps = findMaps(MAPS_DIR);
const usage = new Map(); // native -> #maps that call it
const calls = new Map(); // native -> #call sites across all of them
let scanned = 0;
for (const mapPath of maps) {
  let script;
  try {
    const archive = openArchive(mapPath);
    // A Reforged-era map's script may be LUA instead of JASS (docs/map-compatibility.md), and
    // it calls the same natives — Test of Faith Reborn's 268 `GetUnitDefaultMoveSpeed` calls are
    // invisible to a scan that only looks for war3map.j.
    script = readFromArchive(archive, 'war3map.j') ?? readFromArchive(archive, 'war3map.lua');
  } catch {
    continue; // unreadable archive — skip
  }
  if (!script) continue;
  scanned++;
  const seen = new Set();
  // A native "call" is any identifier that appears as `Name(` and is a known native.
  for (const m of script.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[1];
    if (!allNatives.has(name)) continue;
    seen.add(name);
    calls.set(name, (calls.get(name) ?? 0) + 1);
  }
  for (const name of seen) usage.set(name, (usage.get(name) ?? 0) + 1);
}

// --- report -----------------------------------------------------------------
const ranked = [...allNatives]
  .map((name) => ({ name, maps: usage.get(name) ?? 0, calls: calls.get(name) ?? 0, done: implemented.has(name) }))
  .filter((n) => SHOW_ALL || n.maps > 0)
  .sort((a, b) => (BY_CALLS ? b.calls - a.calls : b.maps - a.maps) || a.name.localeCompare(b.name));

const used = ranked.filter((n) => n.maps > 0);
const missing = used.filter((n) => !n.done);
const missingCalls = missing.reduce((sum, n) => sum + n.calls, 0);

console.log(`common.j natives: ${allNatives.size}`);
console.log(`maps scanned:     ${scanned}/${maps.length}   (${MAPS_DIR})`);
console.log(`natives used:     ${used.length}  (implemented: ${used.length - missing.length})`);
console.log(`still missing:    ${missing.length} native(s), ${missingCalls} call site(s)`);
console.log('');
console.log(`${'native'.padEnd(34)} ${'maps'.padStart(4)} ${'calls'.padStart(6)}  impl`);
console.log('-'.repeat(56));
for (const n of ranked) {
  console.log(`${n.name.padEnd(34)} ${String(n.maps).padStart(4)} ${String(n.calls).padStart(6)}  ${n.done ? '✓' : ''}`);
}
