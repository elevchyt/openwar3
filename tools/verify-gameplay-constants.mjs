// Check src/data/gameplayConstants.ts against the real game data.
//
//   pnpm data:verify
//
// Every key in MISC_GAME / MISC_DATA / MELEE is looked up in the file it claims to
// come from — Units\MiscGame.txt, Units\MiscData.txt, Scripts\Blizzard.j — and the
// values compared numerically. A transcription that drifts from the MPQ (or a value
// a patch changed under us) fails here instead of quietly mis-simulating the game.
//
// Needs the archives unpacked: `pnpm data:extract` first. ExtractedData/ is
// gitignored — this is a developer check, not a CI gate.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const merged = path.join(root, "Warcraft III", "ExtractedData", "merged");
const SOURCE = path.join(root, "src", "data", "gameplayConstants.ts");

function read(file) {
  if (!fs.existsSync(file)) {
    console.error(`missing ${path.relative(root, file)}\nRun \`pnpm data:extract\` to unpack the MPQs first.`);
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

/** `constant integer bj_FOO = 12` (and the one `local real unitSpacing = 64.00`). */
function parseJassConstants(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\s*constant\s+\w+\s+(\w+)\s*=\s*([-\d.]+)\s*$/gm)) out.set(m[1], m[2]);
  const spacing = /^\s*local\s+real\s+unitSpacing\s*=\s*([-\d.]+)/m.exec(text);
  if (spacing) out.set("unitSpacing", spacing[1]);
  return out;
}

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
  MISC_DATA: { label: "Units\\MiscData.txt", data: parseMiscIni(read(path.join(merged, "Units", "MiscData.txt"))) },
  MELEE: { label: "Scripts\\Blizzard.j", data: parseJassConstants(read(path.join(merged, "Scripts", "Blizzard.j"))) },
};

// MELEE keys drop the `bj_` prefix; MELEE_UNIT_SPACING is a local, not a constant.
const meleeKey = (key) => (key === "MELEE_UNIT_SPACING" ? "unitSpacing" : `bj_${key}`);

let checked = 0;
const problems = [];
for (const [block, { label, data }] of Object.entries(files)) {
  for (const [key, ours] of parseTsBlock(source, block)) {
    const lookup = block === "MELEE" ? meleeKey(key) : key;
    const theirs = data.get(lookup);
    checked++;
    if (theirs === undefined) problems.push(`${block}.${key} — no \`${lookup}\` in ${label}`);
    else if (!matches(ours, theirs)) problems.push(`${block}.${key} — we say ${JSON.stringify(ours)}, ${label} says ${theirs}`);
  }
}

if (problems.length) {
  console.error(`${problems.length} of ${checked} gameplay constants disagree with the game data:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nThe MPQ wins (CLAUDE.md). Fix src/data/gameplayConstants.ts.");
  process.exit(1);
}
console.log(`gameplayConstants.ts: all ${checked} constants match the 1.27a game data.`);
