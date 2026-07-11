// Native-coverage report for the Phase 7 JASS work (docs/triggers.md, issue #33).
//
//   node tools/native-coverage.mjs [--wc3-dir "<path to Warcraft III>"] [--all]
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

// --- what we've implemented so far (src/jass/natives/*.ts) ------------------
// Each native impl is registered as `defineNative("Name", ...)` or listed in an
// implemented-names array; we detect either by scanning the source for the string
// literal "Name". Good enough for a coverage estimate.
const implemented = new Set();
const nativesDir = join(REPO, 'src', 'jass', 'natives');
if (existsSync(nativesDir)) {
  for (const f of readdirSync(nativesDir)) {
    if (!f.endsWith('.ts')) continue;
    const src = readFileSync(join(nativesDir, f), 'utf8');
    for (const name of allNatives) {
      if (src.includes(`"${name}"`) || src.includes(`'${name}'`)) implemented.add(name);
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

const maps = findMaps(join(WC3_DIR, 'Maps'));
const usage = new Map(); // native -> #maps that call it
let scanned = 0;
for (const mapPath of maps) {
  let script;
  try {
    script = readFromArchive(openArchive(mapPath), 'war3map.j');
  } catch {
    continue; // unreadable archive — skip
  }
  if (!script) continue;
  scanned++;
  const seen = new Set();
  // A native "call" is any identifier that appears as `Name(` and is a known native.
  for (const m of script.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[1];
    if (allNatives.has(name)) seen.add(name);
  }
  for (const name of seen) usage.set(name, (usage.get(name) ?? 0) + 1);
}

// --- report -----------------------------------------------------------------
const ranked = [...allNatives]
  .map((name) => ({ name, maps: usage.get(name) ?? 0, done: implemented.has(name) }))
  .filter((n) => SHOW_ALL || n.maps > 0)
  .sort((a, b) => b.maps - a.maps || a.name.localeCompare(b.name));

const usedCount = ranked.filter((n) => n.maps > 0).length;
const doneUsed = ranked.filter((n) => n.maps > 0 && n.done).length;

console.log(`common.j natives: ${allNatives.size}`);
console.log(`maps scanned:     ${scanned}/${maps.length}`);
console.log(`natives used:     ${usedCount}  (implemented: ${doneUsed})`);
console.log('');
console.log(`${'native'.padEnd(34)} ${'maps'.padStart(4)}  impl`);
console.log('-'.repeat(48));
for (const n of ranked) {
  console.log(`${n.name.padEnd(34)} ${String(n.maps).padStart(4)}  ${n.done ? '✓' : ''}`);
}
