// GAME CACHES — the campaign's memory between chapters (see docs/campaigns.md).
//
// `Scripts\common.j` describes the whole family in one comment:
//
//     // Creates a new or reads in an existing game cache file stored
//     // in the current campaign profile dir
//     native  InitGameCache    takes string campaignFile returns gamecache
//
// and the campaign is built on it. A chapter ends by writing its hero down —
//
//     call InitGameCacheBJ( "Campaigns.w3v" )                                   // Human01
//     call StoreUnitBJ( udg_Arthas, "Arthas", "Human02", GetLastCreatedGameCacheBJ() )
//     call SaveGameCacheBJ( GetLastCreatedGameCacheBJ() )
//
// — and the next one opens by asking for it back, with a hand-written fallback if it is not
// there:
//
//     call RestoreUnitLocFacingAngleBJ( "Arthas", "Human02", GetLastCreatedGameCacheBJ(), …)
//     set udg_Arthas = GetLastRestoredUnitBJ()
//     if ( udg_Arthas != null ) then
//         return
//     endif
//     // If the hero data wasn't found, create a default hero
//     call CreateNUnitsAtLoc( 1, 'Hart', Player(1), GetRectCenter(gg_rct_ArthasStart), 90.00 )
//     call SetHeroLevel( udg_Arthas, 2, false )
//
// Three things in that shape decide how this file is written:
//
//  1. **The mission key is a namespace, not a chapter.** `StoreUnitBJ(…, "Arthas", "Human02", …)`
//     is Human01 filing its hero under the chapter that will WANT it. Nothing here interprets
//     it; it is a two-level string map and that is all it is.
//  2. **A miss is a supported answer.** `RestoreUnit` returning no unit is the branch every
//     chapter in the game already handles, so nothing in here throws or invents a unit — a
//     fresh profile simply plays chapter two with the default hero, exactly as the reference
//     does. (UI\TriggerStrings.txt: "If the label is not found, no unit will be created".)
//  3. **The five types are five namespaces.** `HaveStoredInteger` and `HaveStoredString` ask
//     about the same (missionKey, key) pair and get different answers, so a slot holds one of
//     each rather than one value.
//
// A cache is identified by its FILE and shared for the whole session: the chapters call
// `InitGameCacheBJ("Campaigns.w3v")` several times each (Human02 does it twice — once to
// restore Arthas at map init and once to store him at the end), and every one of those has to
// see the same data. The persistence is `data/gameCache.ts`, which puts it in the player's own
// PROFILE — two profiles are two campaigns, with their own heroes, levels and belts.
//
// `Sync*` is the one group that does nothing. It exists to push a cached value from the host
// to the other machines in a multiplayer game; blizzard.j has every call to it commented out,
// and a campaign has nobody to sync to.

import type { GameCacheObj, NativeCtx, Runtime } from "../runtime";
import type { StoredUnitState } from "../../sim/world";
import { readGameCache, writeGameCache } from "../../data/gameCache";
import { mintUnitHandle } from "./world";
import { asInt, asNum, asStr, jBool, jHandle, jInt, jReal, jStr, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** One (missionKey, key) pair's slots — one per stored TYPE, because the five families are
 *  five namespaces (see the note above). Plain JSON: this is what gets persisted. */
interface CacheSlot {
  int?: number;
  real?: number;
  bool?: boolean;
  str?: string;
  unit?: StoredUnitState;
}

const cache = (c: NativeCtx, v: JassValue): GameCacheObj | undefined => c.rt.data<GameCacheObj>(v);

/** The slot at (missionKey, key), minting the rows on the way down when `create`. */
function slotOf(g: GameCacheObj, mission: string, key: string, create: boolean): CacheSlot | undefined {
  const rows = g.data[mission] ?? (create ? (g.data[mission] = {}) : undefined);
  if (!rows) return undefined;
  const existing = rows[key] as CacheSlot | undefined;
  if (existing || !create) return existing;
  const fresh: CacheSlot = {};
  rows[key] = fresh;
  return fresh;
}

/** Read one typed field, or undefined. */
function read<K extends keyof CacheSlot>(c: NativeCtx, a: JassValue[], field: K): CacheSlot[K] | undefined {
  const g = cache(c, a[0]);
  if (!g) return undefined;
  return slotOf(g, asStr(a[1]), asStr(a[2]), false)?.[field];
}

/** Write one typed field. */
function write<K extends keyof CacheSlot>(c: NativeCtx, a: JassValue[], field: K, value: CacheSlot[K]): boolean {
  const g = cache(c, a[0]);
  if (!g) return false;
  const slot = slotOf(g, asStr(a[1]), asStr(a[2]), true);
  if (!slot) return false;
  slot[field] = value;
  return true;
}

/** Drop one typed field, and the slot with it once nothing is left in it. */
function flush(c: NativeCtx, a: JassValue[], field: keyof CacheSlot): void {
  const g = cache(c, a[0]);
  const mission = asStr(a[1]);
  const slot = g ? slotOf(g, mission, asStr(a[2]), false) : undefined;
  if (!g || !slot) return;
  delete slot[field];
  if (!Object.keys(slot).length) delete g.data[mission][asStr(a[2])];
}

export function registerGameCacheNatives(rt: Runtime): void {
  // --- the cache itself ----------------------------------------------------------
  // One object per FILE, for the whole session: a chapter opens the cache several times and
  // every one of those must be the same cache. The contents are read from the profile the
  // FIRST time, which is what "reads in an existing game cache file" means.
  def(rt, "InitGameCache", (c, a) => {
    const file = asStr(a[0]);
    const key = file.toLowerCase();
    const existing = c.rt.gameCaches.get(key);
    if (existing) return jHandle(existing.handleId, "gamecache");
    const g: GameCacheObj = { handleId: 0, file, data: readGameCache(file) };
    g.handleId = c.rt.handles.alloc(g);
    c.rt.gameCaches.set(key, g);
    return jHandle(g.handleId, "gamecache");
  });
  def(rt, "SaveGameCache", (c, a) => {
    const g = cache(c, a[0]);
    return jBool(g ? writeGameCache(g.file, g.data) : false);
  });
  // "Reload all game cache data from disk" — every cache this session has open goes back to
  // what the profile holds, throwing away anything stored since the last save.
  def(rt, "ReloadGameCachesFromDisk", (c) => {
    for (const g of c.rt.gameCaches.values()) g.data = readGameCache(g.file);
    return jBool(true);
  });

  // --- storing -------------------------------------------------------------------
  // StoreInteger/Real/Boolean return nothing; StoreString/StoreUnit return a boolean.
  def(rt, "StoreInteger", (c, a) => { write(c, a, "int", asInt(a[3])); return JNULL; });
  def(rt, "StoreReal", (c, a) => { write(c, a, "real", asNum(a[3])); return JNULL; });
  def(rt, "StoreBoolean", (c, a) => { write(c, a, "bool", truthy(a[3])); return JNULL; });
  def(rt, "StoreString", (c, a) => jBool(write(c, a, "str", asStr(a[3]))));
  // StoreUnit — the sim writes the unit down (SimWorld.storeUnitState says what that is).
  // False for a unit that is already gone, which is what the native answers.
  def(rt, "StoreUnit", (c, a) => {
    const u = c.rt.data<{ simId: number }>(a[3]);
    const stored = u && u.simId >= 0 ? c.rt.hooks?.storeUnit?.(u.simId) ?? null : null;
    return jBool(stored ? write(c, a, "unit", stored) : false);
  });

  // --- reading -------------------------------------------------------------------
  // common.j: "Will return 0 if the specified value's data is not found in the cache".
  def(rt, "GetStoredInteger", (c, a) => jInt(read(c, a, "int") ?? 0));
  def(rt, "GetStoredReal", (c, a) => jReal(read(c, a, "real") ?? 0));
  def(rt, "GetStoredBoolean", (c, a) => jBool(read(c, a, "bool") ?? false));
  // The string is the odd one: the native answers `null` on a miss and `GetStoredStringBJ`
  // exists to turn that into "". Answering "" straight away is the same thing to every caller
  // — `"" == null` is false, so the wrapper's else branch hands the "" back unchanged — and it
  // keeps a raw `GetStoredString` out of trouble in a concatenation.
  def(rt, "GetStoredString", (c, a) => jStr(read(c, a, "str") ?? ""));

  def(rt, "HaveStoredInteger", (c, a) => jBool(read(c, a, "int") !== undefined));
  def(rt, "HaveStoredReal", (c, a) => jBool(read(c, a, "real") !== undefined));
  def(rt, "HaveStoredBoolean", (c, a) => jBool(read(c, a, "bool") !== undefined));
  def(rt, "HaveStoredString", (c, a) => jBool(read(c, a, "str") !== undefined));
  def(rt, "HaveStoredUnit", (c, a) => jBool(read(c, a, "unit") !== undefined));

  /**
   * `RestoreUnit(cache, missionKey, key, forWhichPlayer, x, y, facing)` — the hero (or the
   * stash) walks into the next chapter.
   *
   * The unit is created for real, through the same door `CreateUnit` goes through, and gets a
   * JASS handle bound to it so the very next line can configure it — which every chapter's
   * does (`set udg_Arthas = GetLastRestoredUnitBJ()`, then orders and camera work).
   *
   * A miss answers `null`, and that is a feature rather than a failure: it is what every
   * chapter's "create a default hero" branch tests for.
   */
  def(rt, "RestoreUnit", (c, a) => {
    const stored = read(c, a, "unit");
    if (!stored) return JNULL;
    const player = c.rt.data<{ index: number }>(a[3])?.index ?? asInt(a[3]);
    const x = asNum(a[4]);
    const y = asNum(a[5]);
    const facing = asNum(a[6]);
    const simId = c.rt.hooks?.restoreUnit?.(stored, player, x, y, facing) ?? -1;
    if (simId < 0) return JNULL;
    return mintUnitHandle(c.rt, player, stored.typeId, x, y, facing, simId);
  });

  // --- flushing ------------------------------------------------------------------
  // "Clears all labels of all categories in a game cache" (UI\TriggerStrings.txt).
  def(rt, "FlushGameCache", (c, a) => {
    const g = cache(c, a[0]);
    if (g) g.data = {};
    return JNULL;
  });
  def(rt, "FlushStoredMission", (c, a) => {
    const g = cache(c, a[0]);
    if (g) delete g.data[asStr(a[1])];
    return JNULL;
  });
  def(rt, "FlushStoredInteger", (c, a) => { flush(c, a, "int"); return JNULL; });
  def(rt, "FlushStoredReal", (c, a) => { flush(c, a, "real"); return JNULL; });
  def(rt, "FlushStoredBoolean", (c, a) => { flush(c, a, "bool"); return JNULL; });
  def(rt, "FlushStoredString", (c, a) => { flush(c, a, "str"); return JNULL; });
  def(rt, "FlushStoredUnit", (c, a) => { flush(c, a, "unit"); return JNULL; });

  // --- syncing -------------------------------------------------------------------
  // Host → clients, for a multiplayer game. blizzard.j has every call to these commented out
  // and a campaign has nobody to sync to, so they are honest no-ops rather than gaps.
  for (const name of ["SyncStoredInteger", "SyncStoredReal", "SyncStoredBoolean", "SyncStoredUnit", "SyncStoredString"]) {
    def(rt, name, () => JNULL);
  }
}
