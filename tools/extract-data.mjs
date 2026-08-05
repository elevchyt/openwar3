// Extract the human-readable data files out of a local Warcraft III install into
// `Warcraft III/ExtractedData/`, for reference during development.
//
//   pnpm data:extract        (or: node tools/extract-data.mjs --wc3-dir "<path>")
//
// Reads EITHER storage (issue #102): a 1.30+ install's CASC content store, or the four MPQs of
// 1.27a and older. Which one a folder is, is decided by `.build.info` beside the exe, exactly
// as the engine decides it (src/vfs/loader.ts) — and the CASC side runs the ENGINE's own
// reader, compiled headlessly by tools/tsconfig.casc.json, so what comes out here is what the
// game sees rather than what a second parser thinks it should.
//
// Nothing here is committed: `Warcraft III/` is gitignored in full (OpenWar3 ships zero
// Blizzard assets — see CLAUDE.md "Legal boundary"). This tool only reads the developer's own
// local install.
//
// What it writes:
//   merged/      the effective, override-wins view of every data file, + a .csv beside each .slk
//   by-archive/  byte-exact originals per archive (MPQ installs only — see the note below)
//   _index/      filename listings for ALL files (models, textures, sounds included) + an
//                override report. Lets you grep for an asset path without extracting a gigabyte.
//
// Binary assets (.mdx/.blp/.wav/.mp3/maps) are deliberately NOT extracted — the engine reads
// them straight from the install at runtime via src/vfs/. They appear in _index only.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const slkMod = require('mdx-m3-viewer/dist/cjs/parsers/slk');
const SlkFile = (slkMod.default ?? slkMod).File;
const mpqMod = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
const MpqArchive = (mpqMod.default ?? mpqMod).Archive;
const { isCascInstallDir, openCascInstall } = require('./install.cjs');

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argDir = process.argv.indexOf('--wc3-dir');
const WC3_DIR = argDir !== -1 ? process.argv[argDir + 1] : join(REPO, 'Warcraft III');
const OUT = join(WC3_DIR, 'ExtractedData');

// Lowest priority first — later archives override earlier ones (the "patch wins"
// layering the engine itself uses; mirrored in src/vfs/profiles.ts).
const MPQ_ARCHIVES = ['War3.mpq', 'War3x.mpq', 'War3xLocal.mpq', 'War3Patch.mpq'];

// The text/data formats worth having on disk. Everything else is a binary asset.
// Deliberately excluded despite looking text-ish: `.flt` (Reverb3.flt is a PE DLL —
// a Miles sound filter) and `.mrf` (binary "Morf" vertex-animation data).
const DATA_EXT = new Set(['slk', 'txt', 'ai', 'j', 'fdf', 'toc', 'ini', 'wai', 'ifl', 'css', 'js', 'pld']);

const SEP = String.fromCharCode(92); // '\' — the archive path separator

/** Write `bytes` to `<root>/<path>`, creating parent dirs. A CASC campaign map's contents are
 *  named `…\OrcX01.w3x:war3map.j`; on disk that colon becomes a folder, which is both what it
 *  means and the only spelling Windows will accept. */
function writeOut(root, archivePath, bytes) {
  const file = join(root, ...archivePath.replace(/:/g, SEP).split(SEP));
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

const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

// ---------------------------------------------------------------------------
// 1. Open the install, whichever storage it is.
// ---------------------------------------------------------------------------
//
// Both paths produce the same three things: `owners` (path → the archives holding it, in mount
// order, last one effective), a `read(archive, path)` for the by-archive copies, and a
// `readEffective(path)` for the merged view.

function openMpqInstall() {
  const archives = new Map();
  for (const name of MPQ_ARCHIVES) {
    const buf = readFileSync(join(WC3_DIR, name));
    // Node pools Buffers, so buf.buffer is a shared, unaligned ArrayBuffer. The parser
    // does `new Uint32Array(bytes.buffer)` on the hash table, which needs 4-byte
    // alignment from offset 0 — hand it a standalone copy.
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    const archive = new MpqArchive();
    archive.load(bytes, true); // readonly
    archives.set(name, archive);
  }

  // War3Patch.mpq ships WITHOUT a (listfile) — every one of its ~576 blocks is
  // anonymous. The hash table still resolves a name to a block, so we recover the
  // patch's contents by probing it with every name the other archives know about.
  const known = new Set();
  for (const name of MPQ_ARCHIVES) {
    const listed = archives.get(name).getFileNames().filter((n) => !n.startsWith('('));
    for (const n of listed) known.add(n);
    log(`${name}: ${listed.length} names in (listfile)`);
  }
  const owners = new Map();
  for (const path of [...known].sort((a, b) => a.localeCompare(b))) {
    const holders = MPQ_ARCHIVES.filter((name) => archives.get(name).has(path));
    if (holders.length) owners.set(path, holders);
  }
  const patchFiles = [...owners].filter(([, h]) => h.includes('War3Patch.mpq'));
  log(`War3Patch.mpq: ${patchFiles.length} files recovered by probing (no listfile)`);

  return {
    kind: 'mpq',
    order: MPQ_ARCHIVES,
    owners,
    listOf: (name) =>
      name === 'War3Patch.mpq'
        ? patchFiles.map(([p]) => p) // recovered by probing
        : archives.get(name).getFileNames().filter((n) => !n.startsWith('(')),
    listNote: (name) =>
      name === 'War3Patch.mpq'
        ? `# ${name} — %d files. This archive has NO (listfile); these names were\n# recovered by probing its hash table with the names found in the other archives.\n# There may be additional files here whose names appear nowhere else.\n`
        : `# ${name} — %d files, from the archive's internal (listfile).\n`,
    read: (name, path) => archives.get(name).get(path)?.bytes() ?? null,
    readEffective: (path, holders) => archives.get(holders[holders.length - 1]).get(path)?.bytes() ?? null,
  };
}

async function openCasc() {
  const vfs = await openCascInstall(WC3_DIR, (msg) => process.stdout.write(`\r${msg}   `));
  process.stdout.write('\r');
  const contents = vfs.archiveContents();
  const order = contents.map((c) => c.archive);
  const owners = new Map();
  for (const { archive, paths } of contents) {
    for (const path of paths) {
      const holders = owners.get(path);
      if (holders) holders.push(archive);
      else owners.set(path, [archive]);
    }
  }
  for (const { archive, paths } of contents) log(`${archive}: ${paths.length} files in the root listing`);

  return {
    kind: 'casc',
    order,
    owners: new Map([...owners].sort((a, b) => a[0].localeCompare(b[0]))),
    listOf: (name) => contents.find((c) => c.archive === name)?.paths ?? [],
    listNote: (name) => `# ${name} — %d files, from the CASC root listing.\n`,
    // A CASC store is content-addressed: two archives naming the same bytes are ONE stored
    // file, and the layers of a Warcraft III install are disjoint but for a couple of entries.
    // So there is no per-archive copy to extract — the effective view is the only view.
    read: null,
    readEffective: (path) => vfs.rawBytes(path),
  };
}

log(`Warcraft III dir: ${WC3_DIR}`);
if (!existsSync(WC3_DIR)) {
  console.error(`No install at ${WC3_DIR}. Pass --wc3-dir "<path to Warcraft III>".`);
  process.exit(1);
}
const casc = isCascInstallDir(WC3_DIR);
log(casc ? 'storage: CASC (1.30+)' : 'storage: MPQ (1.27a and older)');
const install = casc ? await openCasc() : openMpqInstall();
log(`total distinct files: ${install.owners.size}`);

// ---------------------------------------------------------------------------
// 2. Extract the data files: the merged override-wins view (+ per archive on MPQ).
// ---------------------------------------------------------------------------
rmSync(join(OUT, 'merged'), { recursive: true, force: true });
rmSync(join(OUT, 'by-archive'), { recursive: true, force: true });
rmSync(join(OUT, '_index'), { recursive: true, force: true });

const failures = [];
let dataCount = 0;
let csvCount = 0;
let bytesOut = 0;

for (const [path, holders] of install.owners) {
  if (!DATA_EXT.has(extOf(path))) continue;

  if (install.read) {
    for (const name of holders) {
      let bytes;
      try {
        bytes = install.read(name, path);
      } catch (err) {
        // A couple of stub entries (e.g. War3.mpq's war3x.txt) have a malformed
        // sector table and cannot be decoded. Record and move on.
        failures.push(`${name}: ${path} — ${err.message}`);
        continue;
      }
      if (!bytes) continue;
      writeOut(join(OUT, 'by-archive', name.replace(/\.mpq$/i, '')), path, bytes);
      bytesOut += bytes.length;
    }
  }

  let effective;
  try {
    effective = install.readEffective(path, holders);
  } catch (err) {
    failures.push(`${holders[holders.length - 1]}: ${path} — ${err.message}`);
    continue;
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
if (!install.read) log('by-archive/ not written: a CASC store keeps one copy of shared bytes, so the merged view IS the per-archive view');

// ---------------------------------------------------------------------------
// 3. Indexes — every filename, including the binary assets we did not extract.
// ---------------------------------------------------------------------------
const INDEX = join(OUT, '_index');
mkdirSync(INDEX, { recursive: true });

for (const name of install.order) {
  const names = install.listOf(name).slice().sort((a, b) => a.localeCompare(b));
  const header = install.listNote(name).replace('%d', names.length);
  writeFileSync(join(INDEX, `listfile-${name}.txt`), header + names.join('\r\n') + '\r\n');
}

// all-files.tsv: path, ext, effective archive, every archive holding it.
const tsv = ['path\text\teffective_archive\tall_archives'];
for (const [path, holders] of install.owners) {
  tsv.push([path, extOf(path), holders[holders.length - 1], holders.join(',')].join('\t'));
}
writeFileSync(join(INDEX, 'all-files.tsv'), tsv.join('\r\n') + '\r\n');

// overrides.txt: the files that exist in more than one archive.
const overridden = [...install.owners].filter(([, h]) => h.length > 1);
const ov = [
  `# ${overridden.length} files exist in more than one archive.`,
  `# Mount order is ${install.order.join(' < ')}; the LAST one wins.`,
  '# This is the "patch wins" layering — always read the effective copy.',
  '',
  ...overridden.map(([p, h]) => `${h[h.length - 1].padEnd(20)} ${p}   [${h.join(' < ')}]`),
];
writeFileSync(join(INDEX, 'overrides.txt'), ov.join('\r\n') + '\r\n');
log(`indexed ${install.owners.size} files; ${overridden.length} are overridden across archives`);

if (failures.length) {
  log(`\n${failures.length} file(s) could not be decoded:`);
  for (const f of failures) log(`  ${f}`);
}
writeFileSync(join(INDEX, 'extract-report.txt'), report.join('\r\n') + '\r\n');
console.log(`\nDone -> ${OUT}`);
