// Verify src/data/campaigns.ts against the REAL campaign index in the local install.
//
//   pnpm campaign:test          (or: node tools/campaign-index-test.cjs --wc3-dir "<path>")
//
// The campaign screen (issue #101) is a view of one text file — UI\CampaignStrings_exp.txt —
// and everything on screen comes out of it: the four campaigns and their order, each one's
// chapters, its 3D backdrop, its fog, its cursor, its ambience. So the parse is checked
// against the file itself rather than against a fixture, the same way
// verify-gameplay-constants.mjs checks the gameplay constants.
//
// It also checks the two things the FILE does not say and only the archives can settle:
//   • every playable mission's map is actually in the archives (so the screen never offers
//     a chapter that cannot start), and
//   • the one entry that is NOT a map — Legacy of the Damned's finale, which names
//     Doodads\Cinematic\ArthasIllidanFight\ArthasIllidanFight.mdl, a model played in-engine.
//     That single row is why `CampaignEntry.playable` exists.

const { readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const argDir = process.argv.indexOf('--wc3-dir');
const WC3_DIR = argDir !== -1 ? process.argv[argDir + 1] : join(REPO, 'Warcraft III');
const ARCHIVES = ['War3.mpq', 'War3x.mpq', 'War3xLocal.mpq', 'War3Patch.mpq'];

const mpqMod = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
const MpqArchive = (mpqMod.default ?? mpqMod).Archive;

// The parser under test, compiled to CommonJS by tools/tsconfig.campaign.json — the same way
// the sim tests run engine TypeScript headlessly (`pnpm campaign:test` does both steps).
writeFileSync(join(REPO, '.campaign-build', 'package.json'), '{"type":"commonjs"}');
const { parseCampaigns, campaignRows } = require(join(REPO, '.campaign-build', 'src', 'data', 'campaigns.js'));

const archives = ARCHIVES.map((name) => {
  const buf = readFileSync(join(WC3_DIR, name));
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  const archive = new MpqArchive();
  archive.load(bytes, true);
  return archive;
});

/** Read a path with the engine's own mount order — later archives win (src/vfs/profiles.ts). */
function read(path) {
  let out = null;
  for (const a of archives) if (a.has(path)) out = a.get(path).bytes();
  return out;
}
const text = (path) => Buffer.from(read(path)).toString('latin1');

// war3skins.txt resolves a campaign's `Background` KEY to its model, `_V1` for the expansion.
const skins = new Map();
{
  let section = new Map();
  for (const raw of text('UI\\war3skins.txt').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { section = new Map(); skins.set(head[1], section); continue; }
    const eq = line.indexOf('=');
    if (eq > 0) section.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
}
// Mirrors loadCampaigns' own resolution, including the .mdl → .mdx swap (the data spells the
// model the World Editor's way; the archives ship the compiled one).
const background = (key) => skins.get('Default')?.get(`${key}_V1`)?.replace(/\.mdl$/i, '.mdx') ?? null;

const campaigns = parseCampaigns(text('UI\\CampaignStrings_exp.txt'), background);

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`ok    ${name}`); return; }
  failures++;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const [nightElf, human, undead, orc] = campaigns;

check('four TFT campaigns, in CampaignList order',
  campaigns.map((c) => c.key).join(',') === 'NightElf,Human,Undead,Orc', campaigns.map((c) => c.key).join(','));

check('Sentinels: header + name', nightElf.header === 'Sentinels Campaign' && nightElf.name === 'Terror of the Tides');
check('Sentinels opens by default', nightElf.defaultOpen === true);
check('Bonus campaign opens by default', orc.defaultOpen === true);
check('Alliance + Scourge start locked', human.defaultOpen === false && undead.defaultOpen === false);
check('Sentinels backdrop resolves to the TFT model, and it is in the archives',
  nightElf.background === 'UI\\Glues\\SinglePlayer\\NightElf_Exp\\NightElf_Exp.mdx'
  && read(nightElf.background) !== null, String(nightElf.background));
check('every campaign backdrop is in the archives',
  campaigns.every((c) => c.background && read(c.background)),
  campaigns.filter((c) => !c.background || !read(c.background)).map((c) => c.key).join(', '));
check('Sentinels wears the night elf cursor', nightElf.cursor === 'NightElf', nightElf.cursor);
check('Sentinels ambience', nightElf.ambientSound === 'ExpansionNightElfGlueScreenLoop', String(nightElf.ambientSound));
check('Scourge fog is the pale Northrend haze',
  Math.round(undead.fog.r * 255) === 178 && Math.round(undead.fog.b * 255) === 204 && undead.fog.end === 8000,
  JSON.stringify(undead.fog));

check('chapter counts (11 / 10 / 14 / 3)',
  [nightElf, human, undead, orc].map((c) => c.missions.length).join(',') === '11,10,14,3',
  [nightElf, human, undead, orc].map((c) => c.missions.length).join(','));
check('Sentinels chapter one', nightElf.missions[0].name === 'Rise of the Naga'
  && nightElf.missions[0].file === 'Maps\\FrozenThrone\\Campaign\\NightElfX01.w3x');
check('Alliance keeps its secret level', human.missions[3].header === 'Secret Level', human.missions[3].header);
// "Chapter Seven, Part One" carries a comma INSIDE its quotes; splitting on commas naively
// shifts every field after it and the map path lands in the name.
check('a comma inside a quoted field does not shift the row',
  undead.missions[8].header === 'Chapter Seven, Part One'
  && undead.missions[8].name === 'Into the Shadow Web Caverns', undead.missions[8].header);
// The Bonus campaign's chapter two carries a FOURTH field (`…OrcX02.w3x",1`).
check('a fourth field does not disturb the row',
  orc.missions[1].file === 'Maps\\FrozenThrone\\Campaign\\OrcX02.w3x', orc.missions[1].file);

check('Sentinels lists its opening cinematic',
  nightElf.open?.name === 'The Awakening' && nightElf.open?.file === 'IntroX', JSON.stringify(nightElf.open));
check('Scourge lists its closing cinematic', undead.end?.name === 'The Ascension', JSON.stringify(undead.end));
check('a cinematic is not a chapter and is not playable',
  nightElf.open.mission === false && nightElf.open.playable === false);
check('the rows a chapter screen shows = cinematics + chapters',
  campaignRows(nightElf).length === nightElf.missions.length + 1, String(campaignRows(nightElf).length));

const finale = undead.missions[13];
// The index spells it `.mdl` (the editor's spelling) and War3x ships the compiled `.mdx` —
// the same swap the backdrops need.
check('Scourge finale is a MODEL, not a map',
  finale.playable === false && /\.mdl$/i.test(finale.file)
  && read(finale.file.replace(/\.mdl$/i, '.mdx')) !== null, finale.file);

const missing = [];
for (const c of campaigns) for (const m of c.missions) if (m.playable && !read(m.file)) missing.push(m.file);
check('every playable chapter map is in the archives', missing.length === 0, missing.join(', '));

// …and every one of them PARSES. A campaign map's object data is read by mdx-m3-viewer the
// moment the map loads, and its doodad table (war3map.w3d) comes in two layouts — the stock
// parser assumed one of them and threw "unknown variable type" on the other, which is every
// campaign except the Bonus one. See patches/mdx-m3-viewer@5.12.0.patch (w3d/file.js): the
// layout is detected per file. This walks the real maps to keep that honest.
const War3MapW3d = require('mdx-m3-viewer/dist/cjs/parsers/w3x/w3d/file').default;
const w3dLayouts = { withInts: 0, without: 0 };
const broken = [];
for (const c of campaigns) {
  for (const m of c.missions) {
    if (!m.playable) continue;
    const mapArchive = new MpqArchive();
    const bytes = read(m.file);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    mapArchive.load(copy, true);
    for (const name of ['war3map.w3d', 'war3map.w3a', 'war3map.w3q']) {
      const entry = mapArchive.get(name);
      if (!entry) continue;
      try {
        const w3d = new War3MapW3d();
        w3d.load(entry.arrayBuffer());
        if (name === 'war3map.w3d') w3dLayouts[w3d.useOptionalInts ? 'withInts' : 'without']++;
      } catch (err) {
        broken.push(`${m.file} ${name}: ${err.message}`);
      }
    }
  }
}
check('every campaign map\'s object data parses', broken.length === 0, broken.slice(0, 3).join(' | '));
// Both layouts are actually exercised — if this ever reads 0 for either, the detection above
// is no longer being tested by anything.
check('both doodad-table layouts appear in the campaigns',
  w3dLayouts.withInts > 0 && w3dLayouts.without > 0, JSON.stringify(w3dLayouts));

console.log(failures ? `\n${failures} check(s) FAILED` : `\nall ${campaigns.length} campaigns verified against the archives`);
process.exit(failures ? 1 : 0);
