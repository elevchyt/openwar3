// Check src/data/gameplayConstants.ts against the real game data.
//
//   pnpm data:verify
//
// Every key in MISC_GAME / MISC_DATA / MELEE / MINIMAP / FOG_OF_WAR / GLUE / INFO_PANEL / TEXT_TAG / MISC_UI is looked
// up in the file it claims to come from — Units\MiscGame.txt, Units\MiscData.txt,
// Scripts\Blizzard.j, UI\MiscData.txt, UI\MiscUI.txt — and the values compared numerically. A transcription that drifts from the
// install (or a value a patch changed under us) fails here instead of quietly mis-simulating
// the game.
//
// Needs the install unpacked: `pnpm data:extract` first (it reads whichever storage the local
// install uses). ExtractedData/ is gitignored — this is a developer check, not a CI gate.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const merged = path.join(root, "Warcraft III", "ExtractedData", "merged");
const SOURCE = path.join(root, "src", "data", "gameplayConstants.ts");

function read(file) {
  if (!fs.existsSync(file)) {
    console.error(`missing ${path.relative(root, file)}\nRun \`pnpm data:extract\` to unpack the install first.`);
    process.exit(1);
  }
  return fs.readFileSync(file, "latin1");
}

/** `key=value` under [Misc] in an INI-ish WC3 .txt, minus `//` and tab comments. */
function parseMiscIni(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const eq = line.indexOf("=");
    if (eq <= 0 || line.startsWith("[")) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Constants declared as literals in a JASS file.
 *
 * Some are NOT literals any more: 1.29 raised the player cap (1.30.4's common.j declares 24
 * player colours) and turned the six constants that describe the player table into native
 * calls — `bj_MAX_PLAYERS = GetBJMaxPlayers()` — so the same scripts run on either table.
 * A native has no value to compare against here; the value is the ENGINE's answer, and ours
 * is in src/jass/natives/config.ts, keyed to src/data/enums.ts's PlayerSlot. `ENGINE_ANSWERS`
 * records that so this check reports "the engine decides" rather than a spurious mismatch.
 */
function parseJassConstants(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\s*constant\s+\w+\s+(\w+)\s*=\s*([-\d.]+)\s*$/gm)) out.set(m[1], m[2]);
  for (const m of text.matchAll(/^\s*constant\s+\w+\s+(\w+)\s*=\s*(\w+)\s*\(\s*\)\s*$/gm)) {
    if (ENGINE_ANSWERS.has(m[1])) out.set(m[1], ENGINE_ANSWERS.get(m[1]));
  }
  const spacing = /^\s*local\s+real\s+unitSpacing\s*=\s*([-\d.]+)/m.exec(text);
  if (spacing) out.set("unitSpacing", spacing[1]);
  return out;
}

/** The pre-1.29 literals these natives replaced — and still what OpenWar3's engine answers. */
const ENGINE_ANSWERS = new Map([
  ["bj_MAX_PLAYERS", "12"],
  ["bj_MAX_PLAYER_SLOTS", "16"],
  ["bj_PLAYER_NEUTRAL_VICTIM", "13"],
  ["bj_PLAYER_NEUTRAL_EXTRA", "14"],
  ["PLAYER_NEUTRAL_AGGRESSIVE", "12"],
  ["PLAYER_NEUTRAL_PASSIVE", "15"],
]);

/** Pull `Name: <number | [number, …]>` pairs out of one `export const X = { … } as const` block. */
function parseTsBlock(source, name) {
  const start = source.indexOf(`export const ${name} = {`);
  if (start < 0) throw new Error(`no ${name} block in gameplayConstants.ts`);
  const end = source.indexOf("\n} as const;", start);
  const body = source.slice(start, end);
  const out = new Map();
  for (const m of body.matchAll(/^ {2}(\w+): (\[[^\]]*\]|-?[\d.]+),/gm)) {
    out.set(m[1], m[2].startsWith("[") ? JSON.parse(m[2]) : Number(m[2]));
  }
  return out;
}

/** WC3 lists are comma-separated; scalars are plain reals. Compare as numbers. */
function matches(ours, theirs) {
  const parsed = theirs.split(",").map(Number);
  if (parsed.some(Number.isNaN)) return false;
  const mine = Array.isArray(ours) ? ours : [ours];
  return mine.length === parsed.length && mine.every((v, i) => Math.abs(v - parsed[i]) < 1e-9);
}

const source = fs.readFileSync(SOURCE, "utf8");
const files = {
  MISC_GAME: { label: "Units\\MiscGame.txt", data: parseMiscIni(read(path.join(merged, "Units", "MiscGame.txt"))) },
  // Reign of Chaos's copy of the same file (docs/editions.md) — the rows MISC_GAME_V0 restates.
  MISC_GAME_V0: { label: "Melee_V0\\Units\\MiscGame.txt", data: parseMiscIni(read(path.join(merged, "Melee_V0", "Units", "MiscGame.txt"))) },
  // …and a CUSTOM map's copy — the second axis of the data set (docs/editions.md). Checked
  // against BOTH editions' custom files, because that is precisely the claim MISC_GAME_CUSTOM
  // makes by being ONE block: every row it restates is stated the same by Custom_V0 and
  // Custom_V1. Let the two diverge on a row we model and this fails rather than silently
  // picking one.
  MISC_GAME_CUSTOM: {
    label: "Custom_V1\\Units\\MiscGame.txt",
    data: parseMiscIni(read(path.join(merged, "Custom_V1", "Units", "MiscGame.txt"))),
    also: [{
      label: "Custom_V0\\Units\\MiscGame.txt",
      data: parseMiscIni(read(path.join(merged, "Custom_V0", "Units", "MiscGame.txt"))),
    }],
  },
  MISC_DATA: { label: "Units\\MiscData.txt", data: parseMiscIni(read(path.join(merged, "Units", "MiscData.txt"))) },
  MELEE: { label: "Scripts\\Blizzard.j", data: parseJassConstants(read(path.join(merged, "Scripts", "Blizzard.j"))) },
  // Note the different MiscData.txt: the minimap's palette lives in the *UI* one.
  MINIMAP: { label: "UI\\MiscData.txt", data: parseMiscIni(read(path.join(merged, "UI", "MiscData.txt"))) },
  // …and the fog-of-war / boundary veils, in the same UI file.
  FOG_OF_WAR: { label: "UI\\MiscData.txt", data: parseMiscIni(read(path.join(merged, "UI", "MiscData.txt"))) },
  // …as do the glue screens' own constants (the Custom Game map-size buckets).
  GLUE: { label: "UI\\MiscData.txt", data: parseMiscIni(read(path.join(merged, "UI", "MiscData.txt"))) },
  // …and the info panel's range/speed bands.
  INFO_PANEL: { label: "UI\\MiscData.txt", data: parseMiscIni(read(path.join(merged, "UI", "MiscData.txt"))) },
  // …and the floating text tags' colours/drift/lifetimes. Their HEIGHTS are the odd one out:
  // font sizes live in UI\MiscUI.txt, a third file again.
  TEXT_TAG: { label: "UI\\MiscData.txt", data: parseMiscIni(read(path.join(merged, "UI", "MiscData.txt"))) },
  MISC_UI: { label: "UI\\MiscUI.txt", data: parseMiscIni(read(path.join(merged, "UI", "MiscUI.txt"))) },
};

// MELEE keys drop the `bj_` prefix; MELEE_UNIT_SPACING is a local, not a constant.
const meleeKey = (key) => (key === "MELEE_UNIT_SPACING" ? "unitSpacing" : `bj_${key}`);

let checked = 0;
const problems = [];
for (const [block, entry] of Object.entries(files)) {
  const sources = [{ label: entry.label, data: entry.data }, ...(entry.also ?? [])];
  for (const [key, ours] of parseTsBlock(source, block)) {
    const lookup = block === "MELEE" ? meleeKey(key) : key;
    for (const { label, data } of sources) {
      const theirs = data.get(lookup);
      checked++;
      if (theirs === undefined) problems.push(`${block}.${key} — no \`${lookup}\` in ${label}`);
      else if (!matches(ours, theirs)) problems.push(`${block}.${key} — we say ${JSON.stringify(ours)}, ${label} says ${theirs}`);
    }
  }
}

// The other half of the data set's shape, which no per-key check can state: a row MISC_GAME
// models and MISC_GAME_CUSTOM does NOT must be one the custom copies agree with their own
// edition's melee copy about — otherwise a custom map is quietly graded by a melee number.
// This is what caught DamageBonusSpells (0.70 melee, 0.75 everywhere else).
{
  const pairs = [
    ["The Frozen Throne", files.MISC_GAME.data, files.MISC_GAME_CUSTOM.data],
    ["Reign of Chaos", files.MISC_GAME_V0.data, files.MISC_GAME_CUSTOM.also[0].data],
  ];
  const restated = new Set([...parseTsBlock(source, "MISC_GAME_CUSTOM")].map(([k]) => k));
  // A Reign of Chaos row the V0 file does not carry falls back to the live one (miscGame).
  const melee = (data, key) => data.get(key) ?? files.MISC_GAME.data.get(key);
  for (const [key] of parseTsBlock(source, "MISC_GAME")) {
    if (restated.has(key)) continue;
    for (const [edition, meleeData, customData] of pairs) {
      const m = melee(meleeData, key);
      const c = customData.get(key);
      if (c === undefined || m === undefined) continue; // a key one copy does not carry
      checked++;
      if (m !== c) problems.push(`MISC_GAME.${key} — ${edition}: melee says ${m} but a custom map's copy says ${c}, and MISC_GAME_CUSTOM does not restate it`);
    }
  }
}

if (problems.length) {
  console.error(`${problems.length} of ${checked} gameplay constants disagree with the game data:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nThe game data wins (CLAUDE.md). Fix src/data/gameplayConstants.ts.");
  process.exit(1);
}
console.log(`gameplayConstants.ts: all ${checked} constants match the game data`);
