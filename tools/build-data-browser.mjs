// Build `Warcraft III/ExtractedData/index.html` — a dark, self-contained browser for
// the unpacked WC3 data tables.
//
//   node tools/extract-mpq.mjs                 # first: unpack the archives
//   node tools/build-data-browser.mjs [--open] # then: build the page and open it
//
// The page is fully self-contained: it embeds a manifest (file tree, sizes, archive
// provenance, SLK column names, and a curated description of what each file IS) AND
// the file contents themselves, as one gzipped blob the browser inflates on demand.
//
// Why embed rather than fetch(): the natural thing to do with an .html file is to
// double-click it, and browsers block fetch() on file:// — so a fetching page is
// dead on arrival exactly when you most want it. The corpus is ~9.8 MB of text,
// which gzips to ~1.4 MB (~1.8 MB base64), so embedding is cheap.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO, 'Warcraft III', 'ExtractedData');
const MERGED = join(ROOT, 'merged');

if (!existsSync(MERGED)) {
  console.error(`No ${MERGED}. Run: node tools/extract-mpq.mjs`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Curated documentation. First matching rule wins. `re` is tested against the
// forward-slashed path relative to merged/.
// ---------------------------------------------------------------------------
const DOCS = [
  // --- Units -------------------------------------------------------------
  [/^Units\/UnitData\.slk$/i, 'Units', 'Race, movement type, turn rate, pathing texture. Note: in the RoC base archive this table also carries `collision`, which TFT moved to UnitBalance — read both.'],
  [/^Units\/UnitBalance\.slk$/i, 'Units', 'HP, mana, gold/lumber cost, food, build time, attributes, armor, collision, sight (`sight`/`nsight`), level. Heroes’ displayed level-1 stats come from the precomputed `realhp`/`realm`/`realdef` columns, not the raw `hp`/`manaN`/`def`.'],
  [/^Units\/UnitWeapons\.slk$/i, 'Units', 'Attack: damage dice, cooldown, range, attack type, damage point and backswing. Gotcha: `dmgpt1`/`backSw1` are `-` (“use the default”) for 572 of 837 rows — reading a dash as 0 gives you units that attack instantly.'],
  [/^Units\/unitUI\.slk$/i, 'Units', 'Model path (`file`), scale, sound-set label (`unitSound`), weapon impact sounds, and `uberSplat` (the ground decal under a building). Note the lowercase `u` in the filename; SLK row keys and MPQ paths are both case-insensitive.'],
  [/^Units\/UnitAbilities\.slk$/i, 'Units', '`abilList` (innate abilities), `heroAbilList` (learnable, in slot order), `auto` (abilities autocasting by default).'],
  [/^Units\/\w+UnitStrings\.txt$/i, 'Units', 'Per-race unit strings: `Name`, `Ubertip` (tooltip), `Hotkey`.'],
  [/^Units\/\w+UnitFunc\.txt$/i, 'Units', 'Per-race unit art: `art` (BLP icon), `buttonpos` (command-card column,row), `missileart`, `missilespeed`.'],
  [/^Units\/UnitGlobalStrings\.txt$/i, 'Units', 'The unit classification names — GiantClass, UndeadClass, MechanicalClass, TaurenClass, …'],

  // --- Abilities ---------------------------------------------------------
  [/^Units\/AbilityData\.slk$/i, 'Abilities', 'Every ability number, per level: `cost1..`, `cool1..` (cooldown), `dur1..`/`herodur1..`, `rng1..` (cast range), `area1..`, `cast1..` (cast point), the payload columns `dataa1..datai1`, `buffid1..`, `unitid1..`, `targs1` (Targets Allowed), `hero`, `levels`. The `code` column names the BASE ability an object derives from — the sim dispatches behaviour off `code`, so a custom-map alias (A000 with code=AHtb) is still Storm Bolt.'],
  [/^Units\/AbilityMetaData\.slk$/i, 'Abilities', 'The decoder ring. Names the otherwise-unlabelled `DataA..DataI` columns per ability and gives each field’s type. The display name is a `WESTRING_*` key you resolve through UI/WorldEditStrings.txt. The `useSpecific` column lists every ability sharing that engine implementation — the cheapest way to find abilities implemented by the same code.'],
  [/^Units\/AbilityBuffData\.slk$/i, 'Abilities', 'The buff/debuff objects that abilities apply. `buffid1..` in AbilityData points here.'],
  [/^Units\/\w+AbilityStrings\.txt$/i, 'Abilities', 'Per-race ability strings: `Name`, per-rank `Tip`/`Ubertip`, `Hotkey`.'],
  [/^Units\/\w+AbilityFunc\.txt$/i, 'Abilities', 'Per-race ability art: `Art` (icon), effect models (`Missileart`, `Targetart`, `Casterart`, `Specialart`, `Areaart`), caster animation tags (`animnames`), `buttonpos`.'],

  // --- Items / upgrades / destructables ----------------------------------
  [/^Units\/ItemData\.slk$/i, 'Items & Upgrades', 'Items: cost, charges, classification, drop rules, which abilities they grant.'],
  [/^Units\/Item(Func|Strings)\.txt$/i, 'Items & Upgrades', 'Item art and strings: icon, name, tooltip.'],
  [/^Units\/ItemAbility(Func|Strings)\.txt$/i, 'Items & Upgrades', 'Art and strings for item-granted abilities.'],
  [/^Units\/UpgradeData\.slk$/i, 'Items & Upgrades', 'Researches: cost per level, what the level modifies, requirements. Not yet consumed by OpenWar3.'],
  [/^Units\/UpgradeEffectMetaData\.slk$/i, 'Items & Upgrades', 'What an upgrade level actually modifies (the effect schema).'],
  [/^Units\/\w+Upgrade(Func|Strings)\.txt$/i, 'Items & Upgrades', 'Per-race upgrade art and strings: icon, name, tooltip, hotkey.'],
  [/^Units\/DestructableData\.slk$/i, 'Items & Upgrades', 'Trees, gates, breakable rocks: HP, pathing footprint, model, what can harvest or destroy them.'],

  // --- Meta --------------------------------------------------------------
  [/MetaData\.slk$/i, 'Schema (MetaData)', 'World Editor schema. For each field: the SLK column name, a `WESTRING_*` display-name key, the type, and the valid range. When you hit a column you don’t recognise, look it up here and resolve the WESTRING through UI/WorldEditStrings.txt.'],

  // --- Constants ---------------------------------------------------------
  [/^Units\/MiscData\.txt$/i, 'Game constants', 'Gameplay constants that live nowhere else: `CloseEnoughRange`, `BuildingUnblightRadius`, creep notification radii, acquisition ranges. Read by src/sim/world.ts.'],
  [/^Units\/MiscGame\.txt$/i, 'Game constants', 'Rule switches and creep/AI constants: `MagicImmunesResistDamage`, guard leash and return-home behaviour, spell target clustering. This is why OpenWar3’s creep AI uses real WC3 numbers instead of invented ones.'],
  [/^UI\/MiscData\.txt$/i, 'Game constants', 'Presentation constants: floating gold/lumber text colour, velocity and lifetime; buff fade alphas.'],
  [/^UI\/MiscUI\.txt$/i, 'Game constants', 'UI chrome constants.'],
  [/^Units\/CommandFunc\.txt$/i, 'Game constants', 'The command card: icon + grid position for Move / Attack / Stop / Hold / Patrol / Build.'],
  [/^Units\/commandstrings\.txt$/i, 'Game constants', 'The command card’s tooltips and hotkeys (the `|cffffcc00M|rove` colour-coded hotkey markup).'],

  // --- Sound -------------------------------------------------------------
  [/^UI\/SoundInfo\/UnitAckSounds\.slk$/i, 'Sound', 'Unit voice responses (What / Yes / Attack / Pissed), keyed by the unit’s `unitSound` label from unitUI.slk.'],
  [/^UI\/SoundInfo\/UnitCombatSounds\.slk$/i, 'Sound', 'Weapon impacts and wood chopping, keyed by the material struck.'],
  [/^UI\/SoundInfo\/AnimSounds\.slk$/i, 'Sound', 'The sound files behind model-embedded animation events. An .mdx fires a 4-char event; AnimLookups maps it to a label; this table gives the files.'],
  [/^UI\/SoundInfo\/AnimLookups\.slk$/i, 'Sound', 'Maps a model’s 4-char SND event (e.g. `FBCL`) to a sound label. This is why a unit’s attack sound is NOT in its own folder — chasing the model directory gets you the wrong gunshot.'],
  [/^UI\/SoundInfo\/AbilitySounds\.slk$/i, 'Sound', 'Spell sounds, keyed by label.'],
  [/^UI\/SoundInfo\/UISounds\.slk$/i, 'Sound', 'Interface clicks, warnings, and alerts.'],
  [/^UI\/SoundInfo\/EAXDefs\.slk$/i, 'Sound', 'Reverb / EAX presets referenced by every sound table’s `EAXFlags` column.'],
  [/^UI\/SoundInfo\/PortraitAnims\.slk$/i, 'Sound', 'Which portrait animation plays with which sound.'],
  [/^UI\/SoundInfo\//i, 'Sound', 'Sound definitions. The `Flags` column carries `WANT3D` (positional audio), `RANDOMPITCH`, and channel behaviour.'],

  // --- Terrain -----------------------------------------------------------
  [/^TerrainArt\/Terrain\.slk$/i, 'Terrain & Doodads', 'Ground tiles: texture, `buildable`, `walkable`, `flyable`, blight priority, and which tiles each converts to.'],
  [/^TerrainArt\/CliffTypes\.slk$/i, 'Terrain & Doodads', 'Cliff and ramp models + textures per cliff type.'],
  [/^TerrainArt\/Water\.slk$/i, 'Terrain & Doodads', 'Water colour and animation per tileset.'],
  [/^TerrainArt\/Weather\.slk$/i, 'Terrain & Doodads', 'Weather particle effects: emission rate, lifespan, velocity, colour ramp.'],
  [/^Doodads\/Doodads\.slk$/i, 'Terrain & Doodads', 'Every doodad: model, category, tileset, scale range, pathing, selection size.'],
  [/^Splats\/UberSplatData\.slk$/i, 'Terrain & Doodads', 'The ground decal painted under a building. `scale` is the HALF-WIDTH (the quad spans center ± scale). The texture ships both as the plain `dir\\file.blp` and as detail-tier LOD variants `A_`/`B_`/`C_<file>.blp` — the plain path is canonical.'],
  [/^Splats\/LightningData\.slk$/i, 'Terrain & Doodads', 'Lightning effect definitions (chain lightning, etc.): texture, width, colour, noise.'],
  [/^Splats\//i, 'Terrain & Doodads', 'Temporary ground splats (blood, scorch marks) and spawn effects.'],

  // --- Scripts -----------------------------------------------------------
  [/^Scripts\/common\.j$/i, 'Scripts (JASS)', 'Declares every JASS native the engine exposes — the exact API surface a JASS VM has to implement. Nothing here is behaviour; it is the interface.'],
  [/^Scripts\/Blizzard\.j$/i, 'Scripts (JASS)', 'Blizzard’s own melee game code, in JASS. Starting units and resources, MeleeClearExcessUnits (creep clearing at 1500 range), victory/defeat conditions, the day/night cycle. GROUND TRUTH for melee rules — read it before coding any melee behaviour rather than guessing a constant.'],
  [/^Scripts\/common\.ai$/i, 'Scripts (JASS)', 'Declares the AI natives available to .ai scripts.'],
  [/^Scripts\/(human|orc|undead|elf)\.ai$/i, 'Scripts (JASS)', 'The melee computer-player script for one race — build order, expansion timing, attack waves.'],
  [/^Scripts\/(Cheats|InitCheats)\.j$/i, 'Scripts (JASS)', 'Cheat-code handling.'],
  [/^Scripts\/.*\.ai$/i, 'Scripts (JASS)', 'A per-mission campaign AI script (named for its map and player colour).'],
  [/^Scripts\/.*\.pld$/i, 'Scripts (JASS)', 'Credits roll text. Not gameplay data.'],
  [/^AI Scripts\//i, 'Scripts (JASS)', 'Compiled AI Editor output (.wai). The readable form is the .ai scripts under Scripts/.'],

  // --- UI ----------------------------------------------------------------
  [/^UI\/FrameDef\/Glue\//i, 'UI (FDF)', 'An out-of-game “glue” screen — main menu, Battle.net panels, options. FDF is the engine’s UI layout language, read by CGameUI.'],
  [/^UI\/FrameDef\/.*InfoPanelStrings\.fdf$/i, 'UI (FDF)', 'The info-panel strings, including the armor-type and attack-type tooltip text the game shows for each combination.'],
  [/^UI\/FrameDef\/GlobalStrings\.fdf$/i, 'UI (FDF)', 'Globally available UI strings.'],
  [/^UI\/FrameDef\//i, 'UI (FDF)', 'An in-game HUD layout: frames, textures, fonts and strings. OpenWar3 does not read FDF (the HUD is hand-built DOM in src/ui/hud.ts) — these are the layout, proportion and naming reference.'],
  [/^UI\/war3skins\.txt$/i, 'UI (FDF)', 'Skin definitions — which textures dress the UI frames.'],
  [/^UI\/WorldEditStrings\.txt$/i, 'World Editor', 'Resolves every `WESTRING_*` key. This is how you turn AbilityMetaData’s field ids into human names — the DataA..DataI decoder. Earns its keep even though the rest of the World Editor data does not.'],
  [/^UI\/TriggerData\.txt$/i, 'World Editor', 'The complete GUI-trigger vocabulary: every event, condition and action, its parameter types, and the JASS function it compiles to. If you ever implement triggers, this is the spec.'],
  [/^UI\/(WorldEdit|UnitEditor|AIEditor)/i, 'World Editor', 'World Editor UI data. Not needed to run the game.'],
  [/^UI\/(Help|Tip|Campaign|Startup|Mac)/i, 'Strings', 'Player-facing strings: help text, loading tips, campaign text.'],

  // --- Odds and ends -----------------------------------------------------
  [/^UI\/TriggerStrings\.txt$/i, 'World Editor', 'The display text for every TriggerData.txt entry, keyed identically. Together they define what a GUI trigger looks like in the editor.'],
  [/^UI\/Captions\//i, 'Strings', 'Cinematic subtitles: tab-separated `start-timecode  end-timecode  line`.'],
  [/^Maps\/.*\.j$/i, 'Scripts (JASS)', 'The compiled JASS script of a bundled test map — a worked example of what the World Editor emits as `war3map.j`.'],
  [/\.ifl$/i, 'Terrain & Doodads', 'Image File List — the ordered frames of an animated texture (water). Still carries the absolute UNC paths of Blizzard’s original build machine (`\\\\guldan\\drive1\\projects\\War3\\…`).'],
  [/\.wai$/i, 'Scripts (JASS)', 'Compiled AI Editor output. Binary; the readable equivalents are the .ai scripts under Scripts/.'],
  [/^Units\/Telemetry\.txt$/i, 'Other', 'The list of gameplay events the client reports home.'],
  [/^config\.txt$/i, 'Other', 'Config template documenting the `LANGID` constants the game accepts.'],
  [/^UI\/Widgets\/BattleNet\/chaticons\//i, 'Other', 'Battle.net chat icon index: a flag bitmask mapped to the BLP shown beside a name.'],
  [/^(BattleNet\/|Detector\.js|TheScript\.js|Styles\.css)/i, 'Other', 'Battle.net client web assets — the in-client browser pages and their server list. Not gameplay data.'],
  [/^License\.txt$/i, 'Other', 'Blizzard’s EULA.'],

  // --- Game data sets ----------------------------------------------------
  [/^(Melee_V0|Custom_V0|Custom_V1)\//i, 'Game Data Set snapshots', 'A frozen copy of the object tables from an earlier patch. A map’s .w3i carries a Game Data Set field (World Editor: Scenario → Map Options → Game Data Set) and the engine loads the matching snapshot so an old map keeps its original balance. Custom_V0 = “Custom (1.01)”, Custom_V1 = “Custom (TFT 1.07, RoC 1.01)”, Melee_V0 = “Melee (Latest Patch)”. Ignore unless implementing map compatibility — useful as a historical diff of what TFT changed.'],
];

const CATEGORY_ORDER = [
  'Units', 'Abilities', 'Items & Upgrades', 'Schema (MetaData)', 'Game constants',
  'Sound', 'Terrain & Doodads', 'Scripts (JASS)', 'UI (FDF)', 'World Editor',
  'Strings', 'Game Data Set snapshots', 'Other',
];

function describe(relPath) {
  for (const [re, category, text] of DOCS) if (re.test(relPath)) return { category, text };
  return { category: 'Other', text: '' };
}

// ---------------------------------------------------------------------------
// Archive provenance, from _index/all-files.tsv (MPQ paths use backslashes).
// ---------------------------------------------------------------------------
const provenance = new Map();
const tsvPath = join(ROOT, '_index', 'all-files.tsv');
if (existsSync(tsvPath)) {
  const lines = readFileSync(tsvPath, 'utf8').split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line) continue;
    const [p, , , all] = line.split('\t');
    provenance.set(p.replace(/\\/g, '/').toLowerCase(), all.split(',').map((a) => a.replace(/\.mpq$/i, '')));
  }
}

// ---------------------------------------------------------------------------
// Walk merged/ and build the manifest.
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Parse just the header row of a CSV (handles quoted cells). */
function csvHeader(text) {
  const cells = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else if (c === '\r' || c === '\n') break;
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

// The payload: every file's bytes, concatenated. Each manifest entry records its
// [offset, length] so the page can slice one file out without splitting the blob.
// Kept as raw bytes rather than a JSON string of text so the browser can decode
// windows-1252 itself — the WC3 data files are cp1252, not UTF-8.
const chunks = [];
let offset = 0;
function stash(bytes) {
  chunks.push(bytes);
  const at = offset;
  offset += bytes.length;
  return [at, bytes.length];
}

const files = [];
for (const full of walk(MERGED).sort((a, b) => a.localeCompare(b))) {
  const rel = relative(MERGED, full).replace(/\\/g, '/');
  const ext = (rel.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (ext === 'csv') continue; // the .csv twin is surfaced through its .slk

  const { category, text } = describe(rel);
  const entry = { path: rel, ext, size: statSync(full).size, category, doc: text };

  const arch = provenance.get(rel.toLowerCase());
  if (arch) entry.archives = arch;

  // A .slk is shown through its generated .csv; everything else through its own bytes.
  if (ext !== 'slk') entry.at = stash(readFileSync(full));

  if (ext === 'slk') {
    const csv = full.replace(/\.slk$/i, '.csv');
    if (existsSync(csv)) {
      const bytes = readFileSync(csv);
      const raw = bytes.toString('utf8');
      entry.csv = rel.replace(/\.slk$/i, '.csv');
      entry.at = stash(bytes);
      entry.columns = csvHeader(raw);
      entry.rows = Math.max(0, raw.split('\n').filter((l) => l.trim()).length - 1);
    }
  }
  files.push(entry);
}

const stats = {
  files: files.length,
  tables: files.filter((f) => f.ext === 'slk').length,
  bytes: files.reduce((s, f) => s + f.size, 0),
  categories: CATEGORY_ORDER.filter((c) => files.some((f) => f.category === c)),
};

console.log(`manifest: ${stats.files} files, ${stats.tables} tables, ${(stats.bytes / 1e6).toFixed(1)} MB`);
const undocumented = files.filter((f) => !f.doc).length;
console.log(`${files.length - undocumented} documented, ${undocumented} fall back to their category`);

const blob = Buffer.concat(chunks);
const gz = gzipSync(blob, { level: 9 });
const PAYLOAD = gz.toString('base64');
console.log(
  `payload: ${(blob.length / 1e6).toFixed(1)} MB -> ${(gz.length / 1e6).toFixed(1)} MB gzip ` +
    `-> ${(PAYLOAD.length / 1e6).toFixed(1)} MB base64`,
);

// Escape `<` so a doc string can never close the <script> block it's embedded in.
const MANIFEST = JSON.stringify({ files, stats }).replace(/</g, '\\u003c');
writeFileSync(join(ROOT, 'index.html'), page(MANIFEST, PAYLOAD));
console.log(`wrote ${join(ROOT, 'index.html')}`);

// ExtractedData/ is gitignored and gets wiped by re-extraction, so the README's source
// of truth lives in the repo. Install it alongside the data it describes.
const README_SRC = join(REPO, 'tools', 'data-readme.md');
writeFileSync(join(ROOT, 'README.md'), readFileSync(README_SRC));
console.log(`wrote ${join(ROOT, 'README.md')} (from tools/data-readme.md)`);

if (process.argv.includes('--open')) {
  const target = join(ROOT, 'index.html');
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['open', [target]]
    : ['xdg-open', [target]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

// ---------------------------------------------------------------------------
// The page. Self-contained: no CDN, no external fonts, no build step.
// Aesthetic: WC3's own codex — dark stone, gold rules, a serif display face
// (Friz Quadrata is Blizzard's; Palatino/Book Antiqua is the closest stock stand-in)
// paired with a monospace face for the data itself.
// ---------------------------------------------------------------------------
function page(manifest, payload) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenWar3 · WC3 Data Codex</title>
<style>
:root{
  --stone-900:#0b0a09; --stone-850:#100e0c; --stone-800:#15120f; --stone-750:#1b1713;
  --stone-700:#241e18; --stone-600:#332a21; --stone-500:#4a3d30;
  --gold:#d8b26a; --gold-dim:#8d764a; --gold-bright:#f0d9a0;
  --parchment:#e7dcc6; --muted:#9a8f7d; --faint:#6b6255;
  --arcane:#6fb4c9; --blight:#8fbf5a; --blood:#c05a4a;
  --mono:"Cascadia Code","JetBrains Mono","SF Mono",Consolas,"Liberation Mono",monospace;
  --serif:"Palatino Linotype","Book Antiqua",Palatino,"Iowan Old Style","Hoefler Text",Georgia,serif;
  --rail:300px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:var(--stone-900); color:var(--parchment);
  font-family:var(--serif); font-size:15px; line-height:1.6;
  display:grid; grid-template-columns:var(--rail) 1fr; overflow:hidden;
}
/* Grain + vignette: depth without imagery. */
body::after{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:100; opacity:.5;
  background:
    radial-gradient(ellipse at 50% 0%, transparent 55%, rgba(0,0,0,.55) 100%),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.045'/%3E%3C/svg%3E");
}
::selection{background:var(--gold-dim);color:var(--stone-900)}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-track{background:var(--stone-850)}
::-webkit-scrollbar-thumb{background:var(--stone-600);border:2px solid var(--stone-850);border-radius:6px}
::-webkit-scrollbar-thumb:hover{background:var(--stone-500)}

/* ---------------- rail ---------------- */
#rail{
  background:linear-gradient(180deg,var(--stone-850),var(--stone-900));
  border-right:1px solid var(--stone-700);
  display:flex;flex-direction:column;min-height:0;position:relative;z-index:2;
}
#rail::before{content:"";position:absolute;top:0;right:0;bottom:0;width:1px;
  background:linear-gradient(180deg,transparent,var(--gold-dim) 25%,var(--gold-dim) 75%,transparent);opacity:.35}
.brand{padding:20px 20px 14px;border-bottom:1px solid var(--stone-700)}
.brand h1{
  font-size:19px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
  color:var(--gold);text-shadow:0 0 22px rgba(216,178,106,.28)
}
.brand .sub{font-family:var(--mono);font-size:10.5px;color:var(--faint);letter-spacing:.06em;margin-top:5px}
.search{padding:12px 14px;border-bottom:1px solid var(--stone-700)}
.search input{
  width:100%;background:var(--stone-900);border:1px solid var(--stone-600);
  color:var(--parchment);font-family:var(--mono);font-size:12px;
  padding:8px 10px;border-radius:3px;outline:none;transition:border-color .15s,box-shadow .15s
}
.search input:focus{border-color:var(--gold-dim);box-shadow:0 0 0 3px rgba(216,178,106,.09)}
.search input::placeholder{color:var(--faint)}
#tree{flex:1;overflow-y:auto;padding:8px 0 40px}
.cat{margin-top:6px}
.cat>summary{
  cursor:pointer;list-style:none;padding:7px 16px;
  font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold-dim);
  font-family:var(--mono);display:flex;justify-content:space-between;align-items:center;
  transition:color .15s,background .15s
}
.cat>summary::-webkit-details-marker{display:none}
.cat>summary:hover{color:var(--gold);background:var(--stone-800)}
.cat>summary .n{color:var(--faint);font-size:10px}
.cat[open]>summary{color:var(--gold)}
.f{
  display:block;width:100%;text-align:left;background:none;border:0;cursor:pointer;
  padding:5px 16px 5px 24px;color:var(--muted);
  font-family:var(--mono);font-size:11.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  border-left:2px solid transparent;transition:color .12s,background .12s,border-color .12s
}
.f:hover{color:var(--parchment);background:var(--stone-800)}
.f.on{color:var(--gold-bright);background:var(--stone-750);border-left-color:var(--gold)}
.f .dir{color:var(--faint)}
.f.on .dir{color:var(--gold-dim)}

/* ---------------- main ---------------- */
#main{overflow-y:auto;min-width:0;position:relative}
#pad{padding:40px 48px 100px;max-width:1500px}
.hero{padding:80px 0 60px;border-bottom:1px solid var(--stone-700);margin-bottom:44px}
.hero h2{
  font-size:clamp(32px,4.6vw,58px);font-weight:400;line-height:1.05;letter-spacing:-.015em;
  color:var(--gold);text-shadow:0 0 60px rgba(216,178,106,.16)
}
.hero h2 em{font-style:italic;color:var(--parchment)}
.hero p{margin-top:22px;max-width:66ch;color:var(--muted);font-size:16px}
.hero p+p{margin-top:12px}
.hero code,.doc code,.warn code{
  font-family:var(--mono);font-size:.86em;background:var(--stone-800);
  border:1px solid var(--stone-700);border-radius:3px;padding:1px 5px;color:var(--gold-bright)
}
.stats{display:flex;gap:44px;margin-top:44px;flex-wrap:wrap}
.stat .v{font-family:var(--mono);font-size:29px;color:var(--parchment);letter-spacing:-.02em}
.stat .k{font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin-top:5px}

.warn{
  background:linear-gradient(90deg,rgba(192,90,74,.12),transparent);
  border:1px solid rgba(192,90,74,.4);border-left:3px solid var(--blood);
  padding:16px 20px;border-radius:3px;margin-bottom:32px;font-size:14px
}
.warn b{color:var(--blood);letter-spacing:.05em}
.warn pre{
  font-family:var(--mono);font-size:12px;background:var(--stone-900);
  border:1px solid var(--stone-700);padding:10px 12px;border-radius:3px;margin-top:10px;color:var(--gold-bright)
}

/* file header */
.fh{margin-bottom:26px}
.crumb{font-family:var(--mono);font-size:11px;color:var(--faint);letter-spacing:.05em}
.fh h2{font-size:32px;font-weight:400;color:var(--gold);margin-top:5px;letter-spacing:-.01em;word-break:break-word}
.tags{display:flex;gap:7px;margin-top:14px;flex-wrap:wrap}
.tag{
  font-family:var(--mono);font-size:10px;letter-spacing:.09em;text-transform:uppercase;
  padding:3px 9px;border-radius:2px;border:1px solid var(--stone-600);color:var(--muted);background:var(--stone-850)
}
.tag.ext{border-color:var(--gold-dim);color:var(--gold)}
.tag.arc{border-color:rgba(111,180,201,.35);color:var(--arcane)}
.tag.arc[data-patch]{border-color:rgba(143,191,90,.45);color:var(--blight)}
.doc{
  margin-top:22px;padding:18px 22px;background:var(--stone-850);
  border:1px solid var(--stone-700);border-left:3px solid var(--gold-dim);border-radius:3px;
  color:var(--parchment);max-width:88ch;font-size:14.5px
}
.doc.none{color:var(--faint);font-style:italic;border-left-color:var(--stone-600)}

/* toolbar */
.bar{display:flex;gap:10px;align-items:center;margin:26px 0 12px;flex-wrap:wrap}
.bar input{
  background:var(--stone-900);border:1px solid var(--stone-600);color:var(--parchment);
  font-family:var(--mono);font-size:12px;padding:7px 10px;border-radius:3px;outline:none;min-width:230px
}
.bar input:focus{border-color:var(--gold-dim);box-shadow:0 0 0 3px rgba(216,178,106,.09)}
.bar .count{font-family:var(--mono);font-size:11px;color:var(--faint);margin-left:auto}
.btn{
  background:var(--stone-800);border:1px solid var(--stone-600);color:var(--muted);
  font-family:var(--mono);font-size:11px;padding:7px 12px;border-radius:3px;cursor:pointer;transition:all .14s
}
.btn:hover{border-color:var(--gold-dim);color:var(--gold)}

/* table */
.tw{border:1px solid var(--stone-700);border-radius:3px;overflow:auto;max-height:70vh;background:var(--stone-850)}
table{border-collapse:separate;border-spacing:0;font-family:var(--mono);font-size:11.5px;width:max-content;min-width:100%}
thead th{
  position:sticky;top:0;z-index:3;background:var(--stone-750);color:var(--gold);
  text-align:left;padding:9px 12px;white-space:nowrap;font-weight:600;
  border-bottom:1px solid var(--gold-dim);letter-spacing:.04em;cursor:default
}
thead th:first-child{position:sticky;left:0;z-index:4}
tbody td{
  padding:6px 12px;border-bottom:1px solid var(--stone-800);color:var(--muted);
  white-space:nowrap;max-width:440px;overflow:hidden;text-overflow:ellipsis
}
tbody td:first-child{
  position:sticky;left:0;background:var(--stone-800);color:var(--gold-bright);
  border-right:1px solid var(--stone-700);font-weight:600;z-index:1
}
tbody tr:hover td{background:var(--stone-800);color:var(--parchment)}
tbody tr:hover td:first-child{background:var(--stone-750)}
td.dash{color:var(--blood);opacity:.75}
td.num{color:var(--arcane)}

/* text view */
pre.src{
  border:1px solid var(--stone-700);border-radius:3px;background:var(--stone-850);
  padding:18px 20px;overflow:auto;max-height:72vh;
  font-family:var(--mono);font-size:12px;line-height:1.72;color:var(--muted);white-space:pre;tab-size:4
}
pre.src .sec{color:var(--gold);font-weight:600}
pre.src .cmt{color:var(--faint);font-style:italic}
pre.src .key{color:var(--arcane)}
pre.src .str{color:var(--blight)}
pre.src mark{background:var(--gold-dim);color:var(--stone-900);border-radius:2px}
.loading{font-family:var(--mono);font-size:12px;color:var(--faint);padding:30px 0}
.err{border-left:3px solid var(--blood);background:var(--stone-850);padding:14px 18px;font-family:var(--mono);font-size:12px;color:var(--blood);border-radius:3px}
@media(max-width:900px){body{grid-template-columns:1fr}#rail{display:none}#pad{padding:24px}}
</style>
</head>
<body>
<nav id="rail">
  <div class="brand">
    <h1>Data Codex</h1>
    <div class="sub">WARCRAFT III · TFT 1.27a</div>
  </div>
  <div class="search"><input id="q" type="search" placeholder="filter files…" autocomplete="off" spellcheck="false"></div>
  <div id="tree"></div>
</nav>
<main id="main"><div id="pad"></div></main>

<script id="payload" type="application/gzip-base64">${payload}</script>
<script>
const DATA = ${manifest};
const pad = document.getElementById('pad');
const tree = document.getElementById('tree');
const byPath = new Map(DATA.files.map(f => [f.path, f]));
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const kb = n => n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1) + ' KB' : (n/1048576).toFixed(1) + ' MB';

/* ---------- rail ---------- */
function renderTree(filter='') {
  const q = filter.trim().toLowerCase();
  tree.innerHTML = '';
  for (const cat of DATA.stats.categories) {
    const items = DATA.files.filter(f => f.category === cat && (!q || f.path.toLowerCase().includes(q)));
    if (!items.length) continue;
    const d = document.createElement('details');
    d.className = 'cat';
    // Open on search, or the two categories you'll actually live in.
    d.open = !!q || cat === 'Units' || cat === 'Abilities';
    d.innerHTML = '<summary>' + esc(cat) + '<span class="n">' + items.length + '</span></summary>';
    for (const f of items) {
      const b = document.createElement('button');
      b.className = 'f';
      b.dataset.path = f.path;
      const cut = f.path.lastIndexOf('/');
      b.innerHTML = cut === -1 ? esc(f.path)
        : '<span class="dir">' + esc(f.path.slice(0, cut + 1)) + '</span>' + esc(f.path.slice(cut + 1));
      b.onclick = () => select(f.path);
      d.appendChild(b);
    }
    tree.appendChild(d);
  }
}
document.getElementById('q').addEventListener('input', e => renderTree(e.target.value));

/* ---------- CSV ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\\n') { row.push(cur); cur = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else if (c !== '\\r') cur += c;
  }
  row.push(cur);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

/* ---------- state ---------- */
let cur = null;
function select(path) {
  cur = path;
  for (const b of tree.querySelectorAll('.f')) b.classList.toggle('on', b.dataset.path === path);
  history.replaceState(null, '', '#' + encodeURIComponent(path));
  render(byPath.get(path));
}

function header(f) {
  const cut = f.path.lastIndexOf('/');
  const tags = ['<span class="tag ext">' + esc(f.ext) + '</span>', '<span class="tag">' + kb(f.size) + '</span>'];
  if (f.rows != null) tags.push('<span class="tag">' + f.rows + ' rows × ' + f.columns.length + ' cols</span>');
  for (const a of (f.archives || [])) {
    const patch = /patch/i.test(a) ? ' data-patch' : '';
    tags.push('<span class="tag arc"' + patch + '>' + esc(a) + '</span>');
  }
  return '<div class="fh">'
    + '<div class="crumb">' + (cut === -1 ? 'merged/' : 'merged/' + esc(f.path.slice(0, cut))) + '</div>'
    + '<h2>' + esc(cut === -1 ? f.path : f.path.slice(cut + 1)) + '</h2>'
    + '<div class="tags">' + tags.join('') + '</div>'
    + '<div class="doc' + (f.doc ? '' : ' none') + '">' + (f.doc ? md(f.doc) : 'No curated description. Category: ' + esc(f.category) + '.') + '</div>'
    + '</div>';
}
// Only backticks -> <code>. The doc strings are ours, but escape first regardless.
const md = s => esc(s).replace(/\`([^\`]+)\`/g, '<code>$1</code>');

/* ---------- payload: one gzipped blob of every file, inflated once ---------- */
let BLOB = null;
async function blob() {
  if (BLOB) return BLOB;
  const b64 = document.getElementById('payload').textContent.trim();
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    BLOB = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new Error('this browser has no DecompressionStream (needs Chrome 80+ / Firefox 113+ / Safari 16.4+)');
  }
  return BLOB;
}

// The .csv twins are written UTF-8 by the extractor; the original WC3 files are cp1252.
const readFile = async f => {
  const all = await blob();
  const [at, len] = f.at;
  return new TextDecoder(f.csv ? 'utf-8' : 'windows-1252').decode(all.subarray(at, at + len));
};

async function render(f) {
  pad.innerHTML = header(f) + '<div class="loading">' + (BLOB ? 'reading…' : 'inflating data…') + '</div>';
  pad.parentElement.scrollTop = 0;
  let text;
  try {
    text = await readFile(f);
  } catch (err) {
    pad.innerHTML = header(f) + '<div class="err">could not read file — ' + esc(err.message) + '</div>';
    return;
  }
  pad.innerHTML = header(f) + (f.csv ? tableView(text, f) : textView(text, f));
  wire(f, text);
}

// Open the file itself in a new tab. Works from file:// too — it's a navigation, not a fetch.
const openRaw = rel => open('merged/' + rel.split('/').map(encodeURIComponent).join('/'), '_blank');

/* ---------- table ---------- */
const PAGE = 400;
function tableView(text, f) {
  const rows = parseCsv(text);
  f._rows = rows;
  return '<div class="bar">'
    + '<input id="rq" type="search" placeholder="filter rows (e.g. hfoo, Footman)" autocomplete="off">'
    + '<input id="cq" type="search" placeholder="filter columns (e.g. cool, dmg)" autocomplete="off">'
    + '<button class="btn" id="csv">open raw .csv</button>'
    + '<span class="count" id="cnt"></span></div>'
    + '<div class="tw" id="tw"></div>';
}

function drawTable(f, rowQ, colQ) {
  const [head, ...body] = f._rows;
  let cols = head.map((h, i) => i);
  if (colQ) {
    const q = colQ.toLowerCase();
    cols = cols.filter(i => i === 0 || head[i].toLowerCase().includes(q));
  }
  let rows = body;
  if (rowQ) {
    const q = rowQ.toLowerCase();
    rows = rows.filter(r => r.some(c => c.toLowerCase().includes(q)));
  }
  const shown = rows.slice(0, PAGE);
  const th = cols.map(i => '<th>' + esc(head[i]) + '</th>').join('');
  const tb = shown.map(r => '<tr>' + cols.map(i => {
    const v = r[i] ?? '';
    const cls = v === '-' ? ' class="dash"' : (v !== '' && !isNaN(v) ? ' class="num"' : '');
    return '<td' + cls + ' title="' + esc(v) + '">' + esc(v) + '</td>';
  }).join('') + '</tr>').join('');

  document.getElementById('tw').innerHTML = '<table><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table>';
  document.getElementById('cnt').textContent =
    rows.length + ' / ' + body.length + ' rows · ' + cols.length + ' / ' + head.length + ' cols'
    + (rows.length > PAGE ? ' · showing first ' + PAGE : '');
}

/* ---------- text ---------- */
function textView(text, f) {
  return '<div class="bar">'
    + '<input id="tq" type="search" placeholder="search in file" autocomplete="off">'
    + '<button class="btn" id="raw">open raw file</button>'
    + '<span class="count" id="cnt">' + text.split('\\n').length.toLocaleString() + ' lines</span></div>'
    + '<pre class="src" id="src"></pre>';
}

// Light, format-aware highlighting: INI sections/keys, JASS/AI comments, strings.
function highlight(text, ext) {
  let h = esc(text);
  if (ext === 'txt' || ext === 'fdf' || ext === 'ini') {
    h = h.replace(/^(\\[.*?\\])$/gm, '<span class="sec">$1</span>')
         .replace(/^([\\w]+)=/gm, '<span class="key">$1</span>=');
  }
  if (ext === 'j' || ext === 'ai' || ext === 'fdf' || ext === 'js') {
    h = h.replace(/(\\/\\/.*)$/gm, '<span class="cmt">$1</span>');
  }
  h = h.replace(/(&quot;[^&]*?&quot;)/g, '<span class="str">$1</span>');
  return h;
}

function wire(f, text) {
  if (f.csv) {
    const rq = document.getElementById('rq'), cq = document.getElementById('cq');
    const draw = () => drawTable(f, rq.value.trim(), cq.value.trim());
    rq.addEventListener('input', draw);
    cq.addEventListener('input', draw);
    document.getElementById('csv').onclick = () => openRaw(f.csv);
    draw();
  } else {
    const src = document.getElementById('src');
    src.innerHTML = highlight(text, f.ext);
    document.getElementById('raw').onclick = () => openRaw(f.path);
    document.getElementById('tq').addEventListener('input', e => {
      const q = e.target.value;
      if (!q) { src.innerHTML = highlight(text, f.ext); return; }
      const re = new RegExp('(' + q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi');
      let hits = 0;
      src.innerHTML = highlight(text, f.ext).replace(re, m => { hits++; return '<mark>' + m + '</mark>'; });
      document.getElementById('cnt').textContent = hits + ' matches';
      const first = src.querySelector('mark');
      if (first) first.scrollIntoView({ block: 'center' });
    });
  }
}

/* ---------- home ---------- */
function home() {
  pad.innerHTML =
    '<div class="hero">'
    + '<h2>The <em>data</em> behind<br>Warcraft III.</h2>'
    + '<p>Every text table unpacked from the four MPQ archives of a real TFT 1.27a install, merged in mount order so what you read is what the engine runs. <strong>The patch always wins.</strong></p>'
    + '<p>These files hand you the <em>numbers and the naming</em>. They hand you almost no behaviour — pathing, combat resolution, the damage table, ability effects and the order system are all yours to build. See <code>README.md</code> for that split.</p>'
    + '<div class="stats">'
    + '<div class="stat"><div class="v">' + DATA.stats.files.toLocaleString() + '</div><div class="k">Data files</div></div>'
    + '<div class="stat"><div class="v">' + DATA.stats.tables + '</div><div class="k">SLK tables</div></div>'
    + '<div class="stat"><div class="v">' + (DATA.stats.bytes/1048576).toFixed(1) + '<span style="font-size:16px"> MB</span></div><div class="k">Unpacked</div></div>'
    + '<div class="stat"><div class="v">4</div><div class="k">Archives</div></div>'
    + '</div></div>'
    + '<div class="doc">Pick a file from the codex on the left. Tables get a filterable grid — filter rows by rawcode (<code>hfoo</code>) and columns by name (<code>cool</code>). Scripts and strings get a searchable source view. Every file is embedded in this page, so it works offline, straight off the filesystem.</div>';
}

renderTree();
const initial = decodeURIComponent(location.hash.slice(1));
if (initial && byPath.has(initial)) select(initial); else home();
</script>
</body>
</html>
`;
}
