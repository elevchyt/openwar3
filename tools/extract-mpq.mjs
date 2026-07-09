// Extract the human-readable data files out of a local Warcraft III (TFT 1.27a)
// install into `Warcraft III/ExtractedData/`, for reference during development.
//
//   node tools/extract-mpq.mjs [--wc3-dir "<path to Warcraft III>"]
//
// Nothing here is committed: `Warcraft III/` is gitignored in full (OpenWar3 ships
// zero Blizzard assets — see CLAUDE.md "Legal boundary"). This tool only reads the
// developer's own local install.
//
// What it writes:
//   merged/      the effective, patch-wins view of every data file, + a .csv beside each .slk
//   by-archive/  byte-exact originals, kept per archive so you can see who owns/overrides what
//   _index/      filename listings for ALL files (models, textures, sounds included) + an
//                override report. Lets you grep for an asset path without extracting a gigabyte.
//
// Binary assets (.mdx/.blp/.wav/.mp3/maps) are deliberately NOT extracted — the engine reads
// them straight from the MPQs at runtime via src/vfs/. They appear in _index only.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const mpqMod = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
const MpqArchive = (mpqMod.default ?? mpqMod).Archive;
const slkMod = require('mdx-m3-viewer/dist/cjs/parsers/slk');
const SlkFile = (slkMod.default ?? slkMod).File;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argDir = process.argv.indexOf('--wc3-dir');
const WC3_DIR = argDir !== -1 ? process.argv[argDir + 1] : join(REPO, 'Warcraft III');
const OUT = join(WC3_DIR, 'ExtractedData');

// Lowest priority first — later archives override earlier ones (the "patch wins"
// layering the engine itself uses; mirrored in src/vfs/profiles.ts).
const ARCHIVES = ['War3.mpq', 'War3x.mpq', 'War3xLocal.mpq', 'War3Patch.mpq'];

// The text/data formats worth having on disk. Everything else is a binary asset.
// Deliberately excluded despite looking text-ish: `.flt` (Reverb3.flt is a PE DLL —
// a Miles sound filter) and `.mrf` (binary "Morf" vertex-animation data).
const DATA_EXT = new Set(['slk', 'txt', 'ai', 'j', 'fdf', 'toc', 'ini', 'wai', 'ifl', 'css', 'js', 'pld']);

const SEP = String.fromCharCode(92); // '\' — the MPQ path separator

function openArchive(name) {
  const buf = readFileSync(join(WC3_DIR, name));
  // Node pools Buffers, so buf.buffer is a shared, unaligned ArrayBuffer. The parser
  // does `new Uint32Array(bytes.buffer)` on the hash table, which needs 4-byte
  // alignment from offset 0 — hand it a standalone copy.
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  const archive = new MpqArchive();
  archive.load(bytes, true); // readonly
  return archive;
}

/** Write `bytes` to `<root>/<mpqPath>`, creating parent dirs. */
function writeOut(root, mpqPath, bytes) {
  const file = join(root, ...mpqPath.split(SEP));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = cell === undefined || cell === null ? '' : String(cell);
          return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(','),
    )
    .join('\r\n');
}

const report = [];
const log = (line) => {
  report.push(line);
  console.log(line);
};

// ---------------------------------------------------------------------------
// 1. Open the archives and work out what each one holds.
// ---------------------------------------------------------------------------
log(`Warcraft III dir: ${WC3_DIR}`);
const archives = new Map();
for (const name of ARCHIVES) archives.set(name, openArchive(name));

// War3Patch.mpq ships WITHOUT a (listfile) — every one of its ~576 blocks is
// anonymous. The hash table still resolves a name to a block, so we recover the
// patch's contents by probing it with every name the other archives know about.
const known = new Set();
for (const name of ARCHIVES) {
  const listed = archives.get(name).getFileNames().filter((n) => !n.startsWith('('));
  for (const n of listed) known.add(n);
  log(`${name}: ${listed.length} names in (listfile)`);
}

/** mpqPath -> archives that contain it, in mount order (last = effective). */
const owners = new Map();
for (const path of [...known].sort((a, b) => a.localeCompare(b))) {
  const holders = ARCHIVES.filter((name) => archives.get(name).has(path));
  if (holders.length) owners.set(path, holders);
}
const patchFiles = [...owners].filter(([, h]) => h.includes('War3Patch.mpq'));
log(`War3Patch.mpq: ${patchFiles.length} files recovered by probing (no listfile)`);
log(`total distinct files: ${owners.size}`);

// ---------------------------------------------------------------------------
// 2. Extract the data files: byte-exact per archive, plus a merged patch-wins view.
// ---------------------------------------------------------------------------
rmSync(join(OUT, 'merged'), { recursive: true, force: true });
rmSync(join(OUT, 'by-archive'), { recursive: true, force: true });
rmSync(join(OUT, '_index'), { recursive: true, force: true });

const failures = [];
let dataCount = 0;
let csvCount = 0;
let bytesOut = 0;

const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

for (const [path, holders] of owners) {
  if (!DATA_EXT.has(extOf(path))) continue;

  let effective = null;
  for (const name of holders) {
    let bytes;
    try {
      bytes = archives.get(name).get(path)?.bytes();
    } catch (err) {
      // A couple of stub entries (e.g. War3.mpq's war3x.txt) have a malformed
      // sector table and cannot be decoded. Record and move on.
      failures.push(`${name}: ${path} — ${err.message}`);
      continue;
    }
    if (!bytes) continue;
    writeOut(join(OUT, 'by-archive', name.replace(/\.mpq$/i, '')), path, bytes);
    bytesOut += bytes.length;
    effective = bytes; // holders are in mount order, so the last write wins
  }
  if (!effective) continue;

  writeOut(join(OUT, 'merged'), path, effective);
  bytesOut += effective.length;
  dataCount++;

  if (extOf(path) === 'slk') {
    try {
      const slk = new SlkFile();
      slk.load(Buffer.from(effective).toString('latin1'));
      writeOut(join(OUT, 'merged'), path.replace(/\.slk$/i, '.csv'), Buffer.from(toCsv(slk.rows), 'utf8'));
      csvCount++;
    } catch (err) {
      failures.push(`csv: ${path} — ${err.message}`);
    }
  }
}
log(`extracted ${dataCount} data files (${csvCount} .slk also written as .csv), ${(bytesOut / 1e6).toFixed(1)} MB`);

// ---------------------------------------------------------------------------
// 3. Indexes — every filename, including the binary assets we did not extract.
// ---------------------------------------------------------------------------
const INDEX = join(OUT, '_index');
mkdirSync(INDEX, { recursive: true });

for (const name of ARCHIVES) {
  const archive = archives.get(name);
  const names =
    name === 'War3Patch.mpq'
      ? patchFiles.map(([p]) => p) // recovered by probing
      : archive.getFileNames().filter((n) => !n.startsWith('('));
  const header =
    name === 'War3Patch.mpq'
      ? `# ${name} — ${names.length} files. This archive has NO (listfile); these names were\n# recovered by probing its hash table with the names found in the other archives.\n# There may be additional files here whose names appear nowhere else.\n`
      : `# ${name} — ${names.length} files, from the archive's internal (listfile).\n`;
  writeFileSync(join(INDEX, `listfile-${name}.txt`), header + names.sort((a, b) => a.localeCompare(b)).join('\r\n') + '\r\n');
}

// all-files.tsv: path, ext, effective archive, every archive holding it.
const tsv = ['path\text\teffective_archive\tall_archives'];
for (const [path, holders] of owners) {
  tsv.push([path, extOf(path), holders[holders.length - 1], holders.join(',')].join('\t'));
}
writeFileSync(join(INDEX, 'all-files.tsv'), tsv.join('\r\n') + '\r\n');

// overrides.txt: the files that exist in more than one archive.
const overridden = [...owners].filter(([, h]) => h.length > 1);
const ov = [
  `# ${overridden.length} files exist in more than one archive.`,
  '# Mount order is War3 < War3x < War3xLocal < War3Patch; the LAST one wins.',
  '# This is the "patch wins" layering — always read the effective copy.',
  '',
  ...overridden.map(([p, h]) => `${h[h.length - 1].padEnd(16)} ${p}   [${h.join(' < ')}]`),
];
writeFileSync(join(INDEX, 'overrides.txt'), ov.join('\r\n') + '\r\n');
log(`indexed ${owners.size} files; ${overridden.length} are overridden across archives`);

if (failures.length) {
  log(`\n${failures.length} file(s) could not be decoded:`);
  for (const f of failures) log(`  ${f}`);
}
writeFileSync(join(INDEX, 'extract-report.txt'), report.join('\r\n') + '\r\n');
console.log(`\nDone -> ${OUT}`);
