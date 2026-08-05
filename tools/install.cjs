// Mount a local Warcraft III install from Node — either storage (issue #102).
//
// Shared by every headless tool that needs the real game files: casc-test, extract-data,
// campaign-index-test, native-coverage, sim-attack-anim-test. It deliberately reimplements
// nothing. `src/vfs/casc.ts` and `src/vfs/mapArchive.ts` are compiled to CommonJS by
// tools/tsconfig.casc.json and driven here over `fs`, so what these tools prove is proven
// about the code the browser actually runs; a second parser for the tools would only be a
// second parser to be wrong in its own way.
//
// The MPQ side is the same four-archive, patch-wins mount src/vfs/loader.ts does, wrapped in
// the same DataSource shape, so a caller never asks which era the install is from.

const { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.casc-build');

/** Lowest priority first — later archives win (src/vfs/profiles.ts). */
const MPQ_ARCHIVES = ['War3.mpq', 'War3x.mpq', 'War3xLocal.mpq', 'War3Patch.mpq'];

/** True if `dir` is a CASC-era install (1.30+) rather than an MPQ one. */
function isCascInstallDir(dir) {
  return existsSync(join(dir, '.build.info')) && existsSync(join(dir, 'Data'));
}

/** A `data.NNN` as a ByteReader (src/vfs/casc.ts), backed by a file descriptor. */
function fdReader(path) {
  const fd = openSync(path, 'r');
  const size = statSync(path).size;
  return {
    size,
    slice: async (start, end) => {
      const length = Math.max(0, Math.min(end, size) - start);
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, start);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}

/** Gather the CASC pieces out of `<dir>/Data`, the same set assets/opfs.ts picks up. */
function collectCascFiles(dir) {
  const files = {
    buildInfo: readFileSync(join(dir, '.build.info'), 'utf8'),
    config: new Map(),
    idx: new Map(),
    data: new Map(),
  };
  const walk = (at, depth) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (/^[0-9a-f]{10}\.idx$/i.test(entry.name)) {
        files.idx.set(entry.name.toLowerCase(), new Uint8Array(readFileSync(full)));
      } else if (/^data\.\d{3}$/i.test(entry.name)) {
        files.data.set(Number(entry.name.slice(5)), fdReader(full));
      } else if (/^[0-9a-f]{32}$/i.test(entry.name)) {
        files.config.set(entry.name.toLowerCase(), readFileSync(full, 'utf8'));
      }
    }
  };
  walk(join(dir, 'Data'), 0);
  return files;
}

/** The compiled engine modules. Written on demand so the caller only needs `tsc -p`. */
function engine() {
  writeFileSync(join(BUILD, 'package.json'), '{"type":"commonjs"}');
  return {
    ...require(join(BUILD, 'src', 'vfs', 'casc.js')),
    ...require(join(BUILD, 'src', 'vfs', 'mapArchive.js')),
  };
}

/** The four MPQs, layered, behind the same DataSource shape a CASC mount has. */
function openMpqInstall(dir) {
  const mpqMod = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
  const MpqArchive = (mpqMod.default ?? mpqMod).Archive;
  const archives = [];
  const mounted = [];
  for (const name of MPQ_ARCHIVES) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    // Node pools Buffers, so buf.buffer is shared and unaligned; the parser needs a hash table
    // aligned to 4 from offset 0. Hand it a standalone copy.
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    const archive = new MpqArchive();
    archive.load(bytes, true); // readonly
    archives.push({ name, archive });
    mounted.push(name);
  }
  if (!archives.length) throw new Error(`no Warcraft III archives in ${dir}`);
  // Highest priority first, so the first hit wins — LayeredDataSource's rule.
  const layers = archives.slice().reverse();
  const rawBytes = (path) => {
    for (const { archive } of layers) if (archive.has(path)) return archive.get(path)?.bytes() ?? null;
    return null;
  };
  return {
    label: `mpq[${mounted.join(' < ')}]`,
    mounted,
    exists: (path) => layers.some(({ archive }) => archive.has(path)),
    rawBytes,
    read: async (path) => {
      const bytes = rawBytes(path);
      if (!bytes) throw new Error(`file not found: ${path}`);
      return bytes;
    },
    list: () => {
      const all = new Set();
      for (const { archive } of archives) {
        for (const n of archive.getFileNames()) if (!n.startsWith('(')) all.add(n);
      }
      return [...all].sort();
    },
    openArchive: () => null, // MPQ keeps its maps whole; nothing to reassemble
    archiveContents: () =>
      archives.map(({ name, archive }) => ({
        archive: name,
        paths: archive.getFileNames().filter((n) => !n.startsWith('(')),
      })),
  };
}

/**
 * Mount `dir`, whichever storage it uses, and hand back a DataSource plus the map reader that
 * goes with it. `readMapBytes(vfs, path)` gives a real .w3x for a campaign chapter on both.
 */
async function openInstall(dir, onProgress) {
  const casc = isCascInstallDir(dir);
  const { CascDataSource, readMapBytes } = engine();
  const vfs = casc
    ? await CascDataSource.open(collectCascFiles(dir), onProgress)
    : openMpqInstall(dir);
  return { kind: casc ? 'casc' : 'mpq', vfs, readMapBytes: (path) => readMapBytes(vfs, path) };
}

/** Just the CASC mount, for the tool that only ever wants that one. */
async function openCascInstall(dir, onProgress) {
  return (await openInstall(dir, onProgress)).vfs;
}

module.exports = { isCascInstallDir, collectCascFiles, openInstall, openCascInstall, MPQ_ARCHIVES, REPO };
