// Which game the client is: Reign of Chaos or The Frozen Throne (docs/editions.md).
//
// 1.30.4 is ONE client that plays both. The main menu carries the switch —
// UI\FrameDef\Glue\MainMenu.fdf's `EditionButton`, the square beside Single Player, wearing
// `GlueScreen-ROC-EditionButton-*.blp` or its `-TFT-` twin — and everything the switch changes
// is data the install already keys by version:
//
//   • the object tables — `Melee_V0\Units\*`, `Melee_V0\Scripts\*.ai` and
//     `Melee_V0\UI\FrameDef\InfoPanelStrings.fdf` are Reign of Chaos's copies of the live files
//     (a 469-row UnitBalance against 837, RoC's damage table in MiscGame.txt, no fourth heroes,
//     no shops), laid over the live paths by src/vfs/edition.ts;
//   • every versioned war3skins key — `_V0` against `_V1`: the glue music, the menu's 3D scene
//     and panel chrome, the logo, the campaign file and its backdrops, the race playlists;
//   • common.j's `VersionGet()` — which is how Blizzard.j picks 750/200 starting resources and a
//     three-hero random roll over 500/150 and four.
//
// The choice is the PLAYER's and is remembered, the way the reference client reopens on the
// edition it was closed on.

export type Edition = "roc" | "tft";

const STORAGE_KEY = "openwar3.edition";

function stored(): Edition {
  try {
    return localStorage.getItem(STORAGE_KEY) === "roc" ? "roc" : "tft";
  } catch {
    return "tft"; // no storage (a headless test, a locked-down browser): the expansion, as shipped
  }
}

let current: Edition = typeof localStorage === "undefined" ? "tft" : stored();
const listeners = new Set<(e: Edition) => void>();

/** The edition the client is on right now. */
export function edition(): Edition {
  return current;
}

export function isRoc(): boolean {
  return current === "roc";
}

/** Switch editions, remember it, and tell everything that caches something versioned. */
export function setEdition(next: Edition): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch { /* not remembered — still switched for this session */ }
  for (const fn of listeners) fn(next);
}

/** Subscribe to anything that moves the object tables underfoot — an edition switch, or a
 *  match whose map reads the other data set (`setMapDataSet`). Every listener is a cache that
 *  parsed a table and must drop it; both events mean the same thing to one.
 *  Returns the unsubscribe. */
export function onEditionChange(fn: (e: Edition) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The `_V<n>` suffix the engine appends to a versioned war3skins key: `_V0` is Reign of Chaos,
 *  `_V1` The Frozen Throne. (A `_V1Beta` set also ships; the engine ignores it.) */
export function skinVersionSuffix(): "_V0" | "_V1" {
  return current === "roc" ? "_V0" : "_V1";
}

/** common.j: `VERSION_REIGN_OF_CHAOS = ConvertVersion(0)`, `VERSION_FROZEN_THRONE = ConvertVersion(1)`. */
export function versionIndex(): 0 | 1 {
  return current === "roc" ? 0 : 1;
}

/**
 * Which of the install's four OBJECT-TABLE sets is underfoot — a **melee** map's or a
 * **custom** one's (docs/editions.md).
 *
 * 1.30 splits the balance two ways, not one. Beside the live `Units\*` tables the store keeps
 * three more complete copies of them, at `Melee_V0\`, `Custom_V1\` and `Custom_V0\`: the
 * VERSION is the edition (`_V0` Reign of Chaos, `_V1` The Frozen Throne — the same suffix
 * war3skins keys wear) and the WORD is whether the map is a melee map or anything else. The
 * live paths are the fourth corner, Melee/TFT, which is why there is no `Melee_V1\` folder.
 *
 * The two halves of a version are NOT the same numbers. Melee carries the balance patches
 * 1.29+ made — a Knight at 835, a Headhunter at 375, an Archer down to 260 — and Custom is
 * frozen where the expansion shipped, so a CAMPAIGN chapter (a custom map, every one of them)
 * plays on the numbers it was written for. In Reign of Chaos that is exactly how a Grunt comes
 * to have **680** hit points in Scourge of Lordaeron and 700 in a melee game: `Custom_V0`'s
 * `UnitBalance.slk` says 680 and every other set says 700.
 */
export type MapDataSet = "melee" | "custom";

let dataSet: MapDataSet = "melee";

/** Which set the next table read will come from. Set from the map's own w3i melee flag
 *  (world/mapKind.ts) as a match starts, before anything parses a table. */
export function setMapDataSet(next: MapDataSet): void {
  if (next === dataSet) return;
  dataSet = next;
  for (const fn of listeners) fn(current);
}

export function mapDataSet(): MapDataSet {
  return dataSet;
}

/** The folder the object tables are read out of right now, or `null` for the live paths —
 *  which ARE the fourth corner, The Frozen Throne's melee tables (src/vfs/edition.ts). */
export function dataSetFolder(): string | null {
  if (dataSet === "custom") return current === "roc" ? "Custom_V0" : "Custom_V1";
  return current === "roc" ? ROC_DATA_SET : null;
}

/** The data-set folder Reign of Chaos reads its MELEE object tables out of. */
export const ROC_DATA_SET = "Melee_V0";
