// A map's own GAMEPLAY CONSTANTS — `war3mapMisc.txt`, the per-map overlay on
// `Units\MiscGame.txt` / `Units\MiscData.txt` (issue #127).
//
// It is the smallest file in a map: one `[Misc]` section and one line per constant the author
// changed, under the SAME key names the install's files use. `Units\MiscMetaData.slk` is what
// makes that true — every row there carries the constant's `field` name (`FoodCeiling`), its
// `slk` ("Profile") and its section ("Misc") — so the World Editor's Gameplay Constants dialog
// writes a map's edits out under exactly the key the base file would have used.
//
// Twenty-one of the stock TFT maps ship one, and between them they touch seven keys:
//
//     MaxHeroLevel=15  PawnItemRate=0.25  HeroFactorXP=80,70,60,50   (the whole Orc X campaign)
//     BoneDecayTime=43.0 (OrcX03b)     DayLength=1080.0 (UndeadX05)
//     MinUnitSpeed=100.0 (HumanX03Secret)      FoodCeiling=30 (HumanX04)
//
// **Only `FoodCeiling` is applied today.** It is the one this module was written for: it has no
// row in any shipped file (the base value is the engine's own 100 — see MISC_ENGINE) and it is
// the supply ceiling a player's food cap is clamped to, so a map lowering it to 30 is stating
// the whole shape of that mission's army. Custom maps use it the other way and say so twice
// over: WTii's Unit Tester (issue #127) ships `[Misc] FoodCeiling=300` — the same two lines as
// HumanX04, the other number — and then writes the ceiling AGAIN from its script before setting
// the cap, so the two halves of this fix agree on that map by both routes at once.
//
// The other six are parsed and reported all the same: each needs a use site that can take a
// per-match value rather than a module constant, and naming them here is what makes adding one
// a one-liner instead of a rediscovery.
//
// The values are kept as RAW STRINGS deliberately. `HeroFactorXP` is a comma list, `DayLength`
// a real and `MaxHeroLevel` an int, and the base tables in gameplayConstants.ts already know
// which is which — a reader asks for the shape it wants (see `miscNumber`), and nothing here
// has to keep a second copy of every constant's type.

/** The file's name inside the map archive. */
export const MAP_MISC_FILE = "war3mapMisc.txt";

/** A map's parsed `[Misc]` block. */
export interface MapMisc {
  /** Every key the file states, verbatim, in file order. Empty for a map that ships none. */
  values: Map<string, string>;
  /** `FoodCeiling` — the ceiling a player's supply cap is clamped to (`fcap`,
   *  Units\MiscMetaData.slk: section "Misc", int, 1..999). Null when the map states none, in
   *  which case the engine's own default stands (MISC_ENGINE.FoodCeiling). */
  foodCeiling: number | null;
}

/** A map that ships no war3mapMisc.txt — every constant the install's. */
export const NO_MAP_MISC: MapMisc = { values: new Map(), foodCeiling: null };

/**
 * Parse a `war3mapMisc.txt`. Anything outside `[Misc]` is ignored (nothing stock writes another
 * section, but the format is the game's ordinary INI-ish `.txt` and the editor is free to), as
 * are blank lines and `//` comments.
 */
export function parseMapMisc(src: string): MapMisc {
  const values = new Map<string, string>();
  let inMisc = false;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { inMisc = head[1].trim().toLowerCase() === "misc"; continue; }
    if (!inMisc) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return { values, foodCeiling: miscNumber(values, "FoodCeiling") };
}

/** One key as a number — the first field if it is a comma list, null if absent or unreadable. */
export function miscNumber(values: Map<string, string>, key: string): number | null {
  const raw = values.get(key);
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw.split(",")[0]);
  return Number.isFinite(n) ? n : null;
}
