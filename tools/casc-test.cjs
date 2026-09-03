// Verify src/vfs/casc.ts against the REAL content store in the local install (issue #102).
//
//   pnpm casc:test          (or: node tools/casc-test.cjs --wc3-dir "<path>")
//
// A CASC mount is four chained lookups deep (.build.info → build config → encoding → .idx)
// and every one of them is content-addressed, so a mistake anywhere resolves to plausible
// bytes rather than to an error: a wrong index alignment yields "file not found" for
// everything, and a wrong BLTE offset yields garbage that only announces itself several
// subsystems later. This is where that gets caught, against the actual archives, headlessly.
//
// Skips (exit 0) when the local install is an MPQ one — the MPQ path is checked by the tools that
// were already checking it.

const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { isCascInstallDir, openCascInstall, REPO } = require('./install.cjs');

const argDir = process.argv.indexOf('--wc3-dir');
const WC3_DIR = argDir !== -1 ? process.argv[argDir + 1] : join(REPO, 'Warcraft III');

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** Files the engine cannot boot without, and what each one has to look like. */
const REQUIRED = [
  ['Units\\UnitData.slk', (b) => String.fromCharCode(b[0], b[1]) === 'ID', 'an SLK starts with "ID;"'],
  ['Units\\MiscGame.txt', (b) => latin1(b).includes('[Misc]'), 'has a [Misc] section'],
  ['Units\\MiscData.txt', (b) => latin1(b).includes('='), 'is key=value text'],
  ['Scripts\\common.j', (b) => latin1(b).includes('native CreateUnit'), 'declares CreateUnit'],
  ['Scripts\\Blizzard.j', (b) => latin1(b).includes('function InitBlizzard'), 'defines InitBlizzard'],
  ['UI\\war3skins.txt', (b) => latin1(b).includes('[Default]'), 'has a [Default] skin'],
  ['UI\\CampaignStrings_exp.txt', (b) => latin1(b).includes('CampaignList'), 'lists the campaigns'],
  ['UI\\MiscUI.txt', (b) => latin1(b).length > 0, 'is not empty'],
  ['UI\\FrameDef\\UI\\ConsoleUI.fdf', (b) => latin1(b).includes('Frame'), 'declares frames'],
  ['UI\\Cursor\\HumanCursor.blp', isBlp, 'is a BLP'],
  ['ReplaceableTextures\\CommandButtons\\BTNFootman.blp', isBlp, 'is a BLP'],
  ['Units\\Human\\Footman\\Footman.mdx', isMdx, 'is an MDX'],
];

const latin1 = (b) => Buffer.from(b).toString('latin1');
function isBlp(b) {
  const magic = latin1(b.subarray(0, 4));
  return magic === 'BLP1' || magic === 'BLP2';
}
function isMdx(b) {
  return latin1(b.subarray(0, 4)) === 'MDLX';
}

(async () => {
  if (!existsSync(WC3_DIR)) {
    console.log(`no install at ${WC3_DIR} — skipping`);
    return;
  }
  if (!isCascInstallDir(WC3_DIR)) {
    console.log(`${WC3_DIR} is an MPQ-era install (no .build.info) — skipping the CASC checks`);
    return;
  }

  console.log(`CASC install: ${WC3_DIR}`);
  const t0 = Date.now();
  const vfs = await openCascInstall(WC3_DIR);
  console.log(`mounted ${vfs.mounted.join(' < ')} — ${vfs.list().length.toLocaleString()} files in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  check(vfs.mounted.some((a) => a === 'War3.mpq'), 'War3.mpq is mounted');
  check(vfs.mounted.some((a) => /-War3Local\.mpq$/.test(a)), 'a locale archive is mounted', vfs.mounted.join(', '));

  console.log('\nfiles the engine boots on:');
  for (const [path, valid, what] of REQUIRED) {
    const bytes = vfs.rawBytes(path);
    check(!!bytes && valid(bytes), path, bytes ? `${what} (${bytes.length.toLocaleString()} bytes)` : 'MISSING');
  }

  // Audio is deliberately NOT preloaded (1.3 GB of a 1.6 GB install), so it must be absent
  // from the sync path and present on the async one — the exact split rawBytes() promises.
  console.log('\nstreamed audio (async only):');
  const wav = vfs.list().find((p) => /\.wav$/i.test(p));
  check(!!wav, 'the install has .wav entries');
  if (wav) {
    check(vfs.exists(wav), `${wav} exists`);
    check(vfs.rawBytes(wav) === null, 'is not held in memory', 'rawBytes() returns null');
    const bytes = await vfs.read(wav);
    check(latin1(bytes.subarray(0, 4)) === 'RIFF', 'reads as a RIFF WAVE over read()', `${bytes.length.toLocaleString()} bytes`);
  }

  // A campaign chapter is not a blob in CASC — it was flattened into the store. openArchive()
  // has to find its pieces, and readMapBytes() has to hand back a real .w3x, because that is
  // what every reader downstream of the campaign screen takes (vfs/mapArchive.ts).
  console.log('\ncampaign chapters (exploded maps, repacked):');
  const { readMapBytes } = require(join(REPO, '.casc-build', 'src', 'vfs', 'mapArchive.js'));
  const mpqMod = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
  const MpqArchive = (mpqMod.default ?? mpqMod).Archive;
  const chapters = ['Maps\\FrozenThrone\\Campaign\\NightElfX01.w3x', 'Maps\\Campaign\\Human01.w3m'];
  for (const path of chapters) {
    const archive = vfs.openArchive(path);
    if (!archive) {
      check(false, path, 'openArchive() found nothing');
      continue;
    }
    // Round-trip: repack, then re-open as the engine will — an archive that only WE can read
    // is not a map, and the difference does not show up until a chapter fails to start.
    const bytes = await readMapBytes(vfs, path);
    const reopened = new MpqArchive();
    reopened.load(bytes, true);
    const w3e = reopened.get('war3map.w3e')?.bytes();
    const w3i = reopened.get('war3map.w3i')?.bytes();
    const j = reopened.get('war3map.j')?.bytes();
    check(
      !!w3e && latin1(w3e.subarray(0, 4)) === 'W3E!' && !!w3i && !!j,
      path,
      `${archive.list().length} entries → ${bytes.length.toLocaleString()}-byte .w3x; ` +
        `w3e ${w3e ? 'ok' : 'MISSING'}, w3i ${w3i ? 'ok' : 'MISSING'}, war3map.j ${j ? 'ok' : 'MISSING'}`,
    );
    const listed = reopened.getFileNames().filter((n) => !n.startsWith('('));
    check(listed.length === archive.list().length, `${path} enumerates`, `${listed.length} names via (listfile)`);
  }

  // Every path the root offers must decode. This is the check that would catch an encrypted
  // ('E') BLTE chunk, a stale .idx bucket, or a truncated data file — none of which show up
  // on the handful of files above.
  console.log('\ndecoding every preloaded entry:');
  let decoded = 0;
  let streamed = 0;
  const errors = new Map();
  for (const path of vfs.list()) {
    try {
      if (vfs.rawBytes(path)) decoded++;
      else streamed++;
    } catch (err) {
      errors.set(err.message.replace(/^.*?: /, ''), (errors.get(err.message.replace(/^.*?: /, '')) ?? 0) + 1);
    }
  }
  check(errors.size === 0, `${decoded.toLocaleString()} entries decoded, ${streamed.toLocaleString()} streamed`,
    errors.size ? [...errors].map(([m, n]) => `${n}× ${m}`).join('; ') : '');

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
