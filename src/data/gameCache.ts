import { profileKey } from "./profiles";

// GAME CACHES — what a campaign carries from one chapter to the next.
//
// `Scripts\common.j` says where one lives, in the comment over the native that makes it:
//
//     // Creates a new or reads in an existing game cache file stored
//     // in the current campaign profile dir
//     native  InitGameCache    takes string campaignFile returns gamecache
//
// So a cache is (a) a FILE, named by the script, and (b) **per profile** — which is exactly
// what `PROFILE_MESSAGE` promises the player on the Single Player screen ("Each profile will
// hold information for your campaign progress…"). Both halves land here: the store is
// localStorage under `profileKey`, and `openwar3.gamecache` is in profiles.ts's `PROFILE_OWNED`
// so deleting a profile takes every cache with it.
//
// **All of a profile's cache files live in ONE storage key**, keyed by file name inside it,
// rather than one key per file. That is not tidiness: `deleteProfile` and `adoptOrphaned` sweep
// `PROFILE_OWNED` by exact key, and a scheme that hung `<base>.<profile>.<file>` off the base
// would need a prefix sweep in which `openwar3.gamecache.campaigns.w3v` (no profile) and
// `openwar3.gamecache.Bob.campaigns.w3v` are indistinguishable without knowing every profile
// name. One blob per profile keeps profiles.ts's rule exactly as it is.
//
// The file NAME is the whole of the separation between the two editions, and it is the game's
// own: Reign of Chaos's chapters all say `InitGameCacheBJ("Campaigns.w3v")` and The Frozen
// Throne's all say `InitGameCacheBJ("Campaigns.w3x")`. Nothing else has to know about editions.
//
// This module is deliberately dumb — it knows nothing about units or heroes, only about reading
// and writing a blob of JSON under a name. What is IN a cache is
// `src/jass/natives/gamecache.ts`'s business, and what a stored UNIT is made of is the sim's
// (`SimWorld.storeUnitState`).

/** The one key a profile's caches live under. Listed in profiles.ts `PROFILE_OWNED`. */
export const GAME_CACHE_KEY = "openwar3.gamecache";

/** One cache file, as it sits in storage: missionKey → key → the typed slots under it.
 *  Kept as plain JSON so a cache written by one build is readable by the next. */
export type CacheFileData = Record<string, Record<string, unknown>>;

/** Every cache file this profile has, by the name the script called it (lower-cased, because
 *  a script types the name by hand and the reference's store is a file system). */
type CacheStore = Record<string, CacheFileData>;

function readStore(): CacheStore {
  try {
    const raw = localStorage.getItem(profileKey(GAME_CACHE_KEY));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CacheStore;
  } catch {
    return {}; // private mode, corrupt JSON — see readGameCache
  }
}

/**
 * Read a cache file back, or an empty one if it has never been written.
 *
 * Best-effort, like every other read in `data/`: a disabled or corrupt store should cost the
 * player the hero they carried, not the chapter. A campaign map that finds nothing simply takes
 * its own "if the hero data wasn't found, create a default hero" branch, which every chapter in
 * the game has.
 */
export function readGameCache(file: string): CacheFileData {
  const data = readStore()[file.toLowerCase()];
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: CacheFileData = {};
  for (const [mission, keys] of Object.entries(data)) {
    if (keys && typeof keys === "object" && !Array.isArray(keys)) out[mission] = { ...keys };
  }
  return out;
}

/** `SaveGameCache` — "Saves the game cache, using the same filename from which it was created"
 *  (UI\TriggerStrings.txt). Answers whether it landed, which is what the native returns. */
export function writeGameCache(file: string, data: CacheFileData): boolean {
  try {
    const store = readStore();
    store[file.toLowerCase()] = data;
    localStorage.setItem(profileKey(GAME_CACHE_KEY), JSON.stringify(store));
    return true;
  } catch {
    return false; // private mode, or the quota is full — the chapter still plays
  }
}
