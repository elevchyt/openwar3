// Map-format probe (docs/map-compatibility.md).
//
//   node tools/map-compat.cjs [folder-or-file …]
//
// With no argument it reads the developer's own install: `Warcraft III/Maps` and every folder
// under it. For each map it prints the four format versions, the script language, whether each
// entry actually parses with the engine's own parsers, and the base object ids the map wants
// that this install has not got.
//
// This is BOTH the answer to "will this map work" and the regression guard for every fix in
// docs/map-compatibility.md: the install's 161 stock maps must read exactly as they did before,
// and a later-format map must stop being a wall of FAIL. `--check` turns it into a test — it
// fails the run if any STOCK map (w3i ≤ 25, w3e v11, object data ≤ v2) regresses.
//
// Reads only the developer's own local install (gitignored; zero shipped assets).

const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join, resolve, basename, extname } = require('node:path');

const REPO = resolve(__dirname, '..');
const WC3 = join(REPO, 'Warcraft III');
const EXTRACTED = join(WC3, 'ExtractedData', 'merged');

const mpqMod = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
const MpqArchive = (mpqMod.default ?? mpqMod).Archive;
const w3iMod = require('mdx-m3-viewer/dist/cjs/parsers/w3x/w3i');
const W3iFile = (w3iMod.default ?? w3iMod).File;
const w3eMod = require('mdx-m3-viewer/dist/cjs/parsers/w3x/w3e');
const W3eFile = (w3eMod.default ?? w3eMod).File;
const w3uMod = require('mdx-m3-viewer/dist/cjs/parsers/w3x/w3u/file');
const W3uFile = w3uMod.default ?? w3uMod;
const w3dMod = require('mdx-m3-viewer/dist/cjs/parsers/w3x/w3d/file');
const W3dFile = w3dMod.default ?? w3dMod;
const dooMod = require('mdx-m3-viewer/dist/cjs/parsers/w3x/doo');
const DooFile = (dooMod.default ?? dooMod).File;
const unitsDooMod = require('mdx-m3-viewer/dist/cjs/parsers/w3x/unitsdoo');
const UnitsDooFile = (unitsDooMod.default ?? unitsDooMod).File;

const SEP = String.fromCharCode(92);
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const targets = args.filter((a) => !a.startsWith('--'));

/** Every `.w3x`/`.w3m` under a folder (one level of subfolders, which is how `Maps\` is laid
 *  out), or the file itself. */
function collect(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  const out = [];
  for (const e of readdirSync(path)) {
    const p = join(path, e);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (/\.(w3x|w3m)$/i.test(e)) out.push(p);
  }
  return out;
}

/** The ids a stock table carries, straight out of the unpacked SLK (`;K"hfoo"` cells). */
function slkIds(file) {
  const path = join(EXTRACTED, file);
  if (!existsSync(path)) return null;
  const ids = new Set();
  for (const m of readFileSync(path, 'latin1').matchAll(/;K"([A-Za-z0-9]{4})"/g)) ids.add(m[1]);
  return ids;
}
const STOCK = new Set();
for (const table of ['Units/UnitData.slk', 'Units/ItemData.slk', 'Units/AbilityData.slk',
  'Units/UpgradeData.slk', 'Units/DestructableData.slk', 'Units/AbilityBuffData.slk',
  'Doodads/Doodads.slk', 'Units/UnitAbilities.slk']) {
  const ids = slkIds(table);
  if (ids) for (const id of ids) STOCK.add(id);
}

/** The seven object files and the parser each takes. A base id is checked against EVERY stock
 *  table rather than against the one its file implies, because the file does not imply it: a
 *  Reign of Chaos map keeps its ITEM edits in war3map.w3u (see applyMapItemData), so a w3t id
 *  graded against the unit table alone reads as missing when it is sitting in ItemData.slk.
 *  The question this answers is only "does this install have the row at all". */
const OBJECT_FILES = [
  ['war3map.w3u', W3uFile],
  ['war3map.w3t', W3uFile],
  ['war3map.w3b', W3uFile],
  ['war3map.w3h', W3uFile], // buffs live in AbilityBuffData, which is in the union below
  ['war3map.w3a', W3dFile],
  ['war3map.w3d', W3dFile], // doodads — DoodadData, likewise
  ['war3map.w3q', W3dFile],
];

function probe(path) {
  const row = { path, name: basename(path), notes: [], fails: [], derives: [], modifies: [] };
  let archive;
  try {
    const buf = readFileSync(path);
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    archive = new MpqArchive();
    archive.load(bytes, true);
  } catch (e) {
    row.fails.push(`MPQ: ${e.message}`);
    return row;
  }
  const get = (n) => {
    const f = archive.get(n) ?? archive.get(`scripts${SEP}${n}`);
    if (!f) return null;
    try { return f.bytes(); } catch (e) { row.fails.push(`${n}: ${e.message}`); return null; }
  };
  const int32 = (b, off) => (b && b.length >= off + 4 ? new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(off, true) : null);

  // --- war3map.w3i: the keystone. Its version, and whether it reads whole.
  const w3iBytes = get('war3map.w3i');
  row.w3i = int32(w3iBytes, 0);
  if (w3iBytes) {
    const info = new W3iFile();
    try {
      info.load(w3iBytes);
      row.players = info.players.length;
      row.build = info.getBuildVersion();
    } catch (e) {
      // A w3i that stops early is a NOTE, not a failure — the engine reads it the same way
      // (src/compat/w3i.ts) and keeps what parsed, which is how five PROTECTED maps in a
      // stock install's own Maps\\Download play at all. The header fields it needs are read
      // before the truncation, so the build version below is real.
      //
      // "The engine reads it the same way" is the claim this line is really making, and it
      // was WRONG once: three readers were made tolerant and a fourth was missed, inside
      // `loadMap`, so Angel Arena Allstars listed and then opened on a black screen with no
      // world behind it. If this note ever appears for a map that will not start, the first
      // place to look is a `war3map.w3i` read that still throws.
      row.notes.push(`war3map.w3i stops early (protected?): ${e.message}`);
      row.players = info.players.length;
      row.build = info.buildVersion[0] * 100 + info.buildVersion[1];
      row.partialW3i = true;
    }
  } else {
    row.fails.push('war3map.w3i: absent');
  }

  // --- war3map.w3e: version, and whether the corner grid consumes the file exactly.
  const w3eBytes = get('war3map.w3e');
  row.w3e = int32(w3eBytes, 4);
  if (w3eBytes) {
    try {
      const terrain = new W3eFile();
      terrain.load(w3eBytes);
      const cells = terrain.mapSize[0] * terrain.mapSize[1];
      const read = terrain.corners.reduce((n, r) => n + r.length, 0);
      if (read !== cells) row.fails.push(`war3map.w3e: read ${read} of ${cells} corners`);
      else row.size = `${terrain.mapSize[0]}x${terrain.mapSize[1]}`;
      row.tilesets = terrain.groundTilesets.length;
    } catch (e) {
      row.fails.push(`war3map.w3e: ${e.message}`);
    }
  }

  // --- the object files: version, parse, and base ids this install has not got.
  row.obj = null;
  const parsedObjects = [];
  const mapDefines = new Set(); // ids the map itself mints — a custom object may derive from one
  for (const [name, Parser] of OBJECT_FILES) {
    const bytes = get(name);
    if (!bytes) continue;
    const version = int32(bytes, 0);
    row.obj = row.obj === null ? version : Math.max(row.obj, version);
    let parsed;
    try {
      parsed = new Parser();
      parsed.load(bytes);
    } catch (e) {
      row.fails.push(`${name}: ${e.message}`);
      continue;
    }
    parsedObjects.push(parsed);
    for (const table of [parsed.originalTable, parsed.customTable]) {
      for (const obj of table.objects) if (obj.newId !== '\0\0\0\0') mapDefines.add(obj.newId);
    }
  }
  // Two different questions, so two lists. A CUSTOM row DERIVES from its base: with the base
  // missing the object cannot be built at all. An ORIGINAL row MODIFIES an existing id: with
  // that id missing the row is simply inert, which is also what a protected map looks like
  // (DotA's w3a is 769 original rows with custom-shaped ids and an empty custom table — the
  // protector moved them so the World Editor cannot open it).
  if (STOCK.size) { // nothing to grade against until `pnpm data:extract` has run
    for (const parsed of parsedObjects) {
      for (const [table, into] of [[parsed.customTable, row.derives], [parsed.originalTable, row.modifies]]) {
        for (const obj of table.objects) {
          const id = obj.oldId;
          if (STOCK.has(id) || mapDefines.has(id) || into.includes(id)) continue;
          into.push(id);
        }
      }
    }
  }

  // --- the placement files, which are gated on the w3i's build version (see map.ts).
  for (const [name, Parser] of [['war3map.doo', DooFile], ['war3mapUnits.doo', UnitsDooFile]]) {
    const bytes = get(name);
    if (!bytes) continue;
    try {
      new Parser().load(bytes, row.build ?? 0);
    } catch (e) {
      row.fails.push(`${name}: ${e.message}`);
    }
  }

  // --- the script.
  row.script = archive.has('war3map.lua') || archive.has(`scripts${SEP}war3map.lua`) ? 'lua'
    : archive.has('war3map.j') || archive.has(`scripts${SEP}war3map.j`) ? 'jass'
    : 'none';
  return row;
}

const roots = targets.length ? targets : [join(WC3, 'Maps')];
const files = roots.flatMap(collect).sort();
if (!files.length) {
  console.error(`No maps found in ${roots.join(', ')}`);
  process.exit(2);
}

let stockBad = 0;
let laterFormat = 0;
console.log('w3i  w3e  obj  script  ok   map');
for (const path of files) {
  const r = probe(path);
  const ok = r.fails.length === 0;
  const isStock = (r.w3i ?? 0) <= 25 && (r.w3e ?? 0) <= 11 && (r.obj ?? 0) <= 2;
  if (!isStock) laterFormat++;
  if (isStock && !ok) stockBad++;
  const pad = (v, n) => String(v ?? '-').padEnd(n);
  console.log(`${pad(r.w3i, 5)}${pad(r.w3e, 5)}${pad(r.obj, 5)}${pad(r.script, 8)}${ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  for (const f of r.fails) console.log(`                            ! ${f}`);
  for (const n of r.notes) console.log(`                            ~ ${n}`);
  const list = (ids) => `${ids.slice(0, 12).join(' ')}${ids.length > 12 ? ' …' : ''}`;
  if (r.derives.length) console.log(`                            ~ ${r.derives.length} custom object(s) derive from a base this install has not got: ${list(r.derives)}`);
  if (r.modifies.length) console.log(`                            ~ ${r.modifies.length} row(s) modify an id this install has not got (inert): ${list(r.modifies)}`);
}
console.log(`\n${files.length} map(s); ${laterFormat} saved by a later editor.`);
if (CHECK) {
  if (stockBad) {
    console.error(`FAIL: ${stockBad} stock-format map(s) no longer read.`);
    process.exit(1);
  }
  console.log('PASS: every stock-format map still reads.');
}
