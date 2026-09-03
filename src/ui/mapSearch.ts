import { wc3StripMarkup } from "./wc3Text";

// Type-ahead map search (issue #137) — the ranking behind "start typing a map's name at the
// map list and it goes there", on the Custom Game and LAN create screens (ui/mapBrowser.ts).
//
// The list has no search box and the reference has none either: you type at the list, the way
// you type at any list of files. What we do differently from a plain list type-ahead is search
// EVERY folder rather than only the open one — the install keeps its melee maps in
// FrozenThrone, its scenarios in Scenario and whatever the player downloaded in Download, so
// "turtle rock" is a fair thing to type at a list that happens to be showing the wrong folder.
// The folder the player IS in still wins a tie, because that is where they were looking.
//
// Pure ranking, no DOM: tools/map-search-test.cjs drives it headlessly.

/** What the search needs of a map: where it lives, and the two names it answers to. */
export interface SearchEntry {
  /** "Maps\\FrozenThrone\\(2)EchoIsles.w3x" — the file, and the file's name. */
  path: string;
  /** The folder it lives in, "" for the top level. */
  folder: string;
  /** The map's OWN name once its folder has been read ("Echo Isles"), the file's stem
   *  ("(2)EchoIsles") until then. Both are matched, so a search works either way. */
  label: string;
}

/**
 * A name reduced to what a player is actually typing at it: lower case, with everything that
 * is not a letter or a digit gone.
 *
 * That last part is what lets ONE query answer both of a map's names — "echo isles" reaches
 * the map's own "Echo Isles" and its file's "(2)EchoIsles" alike, spaces, brackets and
 * apostrophes and all ("Funny Bunny's Egg Hunt").
 */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * How well `query` (already normalised) fits a map — 0 for not at all.
 *
 * Three tiers, and the gaps between them are the ranking: an exact name beats a name that
 * STARTS with what was typed, which beats one that merely contains it. Two smaller terms
 * settle the rest.
 *
 * ONE letter only ever matches the START of a name, as a list's type-ahead always has. A
 * single letter taken as a substring matches nearly every map there is ("o" is in "Echo
 * Isles"), which would make the first keystroke of every search land somewhere arbitrary and
 * then walk away from it as the second letter narrowed things down. Coverage (always under 1) prefers the SHORTEST name a query fits, so "echo"
 * lands on "Echo Isles" rather than on "Echo Isles Extreme". The open folder is worth a whole
 * point: enough to break a tie in favour of where the player is already looking, never enough
 * to let a loose match there beat a tighter one somewhere else.
 *
 * A map is matched by BOTH its own name and its file's — a folder nobody has opened has no map
 * names to offer yet, and the file name is all a search across the whole install has to go on
 * until the background read catches up.
 */
export function matchScore(e: SearchEntry, query: string, inCwd: boolean): number {
  const names = [norm(wc3StripMarkup(e.label)), norm(fileStem(e.path))];
  let best = 0;
  for (const name of names) {
    if (!name) continue;
    const tier = name === query ? 6
      : name.startsWith(query) ? 4
      : query.length > 1 && name.includes(query) ? 2
      : 0;
    if (!tier) continue;
    best = Math.max(best, tier + query.length / name.length);
  }
  return best && best + (inCwd ? 1 : 0);
}

/** The best fit for `query` among `entries`, or null when nothing matches at all. */
export function bestMatch<T extends SearchEntry>(entries: T[], query: string, cwd: string): T | null {
  const q = norm(query);
  if (!q) return null;
  let best: T | null = null;
  let score = 0;
  for (const e of entries) {
    const s = matchScore(e, q, e.folder === cwd);
    if (s > score) { best = e; score = s; }
  }
  return best;
}

/** A map file's name without its extension and without the "(4)" the maps are shipped with —
 *  that prefix is the player-count badge the list draws, not part of a name anybody types. */
function fileStem(path: string): string {
  const file = path.split("\\").pop() ?? path;
  return file.replace(/\.(w3m|w3x)$/i, "").replace(/^\(\d+\)/, "");
}
