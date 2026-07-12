// Melee natives (7.3 — issue #33; see docs/triggers.md).
//
// The natives blizzard.j's `Melee*` library stands on. A melee map's own war3map.j
// carries a "Melee Initialization" trigger whose eight calls ARE the melee game:
//
//   MeleeStartingVisibility / MeleeStartingHeroLimit / MeleeGrantHeroItems /
//   MeleeStartingResources  / MeleeClearExcessUnits  / MeleeStartingUnits  /
//   MeleeStartingAI         / MeleeInitVictoryDefeat
//
// All eight are Blizzard's own JASS (Scripts\Blizzard.j in the MPQs) — we interpret
// them rather than reimplement them, so the town hall, the five workers clumped by the
// gold mine, the 500/150 purse, the cleared start-location creeps and the victory/defeat
// conditions all come straight from the game's own script. The load-bearing natives:
//
//   • GetPlayerSlotState  — is this slot playing? (the lobby's answer, not the map's;
//                           see Runtime.applyLobby)                    [natives/config.ts]
//   • GetPlayerRace       — as which race? (a lobby "random" already resolved) [config.ts]
//   • GetResourceAmount / CreateBlightedGoldmine — the gold-mine fiction (below)
//   • GetPlayerStructureCount / GetPlayerTypedUnitCount — the victory/defeat inputs
//
// Everything the engine owns itself (AI scripts, blight, preloading) is an EXPLICIT
// no-op here rather than an unimplemented native: same behaviour, no log noise, and it
// documents what we deliberately don't model.

import type { NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jBool, jInt, jReal, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const playerIndex = (ctx: NativeCtx, v: JassValue): number => ctx.rt.data<{ index: number }>(v)?.index ?? asInt(v);

/** common.j: `constant fgamestate GAME_STATE_TIME_OF_DAY = ConvertFGameState(2)`. */
const GAME_STATE_TIME_OF_DAY = 2;
/** common.j: `constant version VERSION_FROZEN_THRONE = ConvertVersion(1)`. We are TFT
 *  1.27a — which is what picks the V1 melee constants (500 gold / 150 lumber, a 4-hero
 *  random-hero roll, 1 twinked hero) over the Reign-of-Chaos V0 ones. */
const VERSION_FROZEN_THRONE = 1;
/** common.j: `PLAYER_NEUTRAL_PASSIVE = 15` — a gold mine's owner. */
const PLAYER_NEUTRAL_PASSIVE = 15;

export function registerMeleeNatives(rt: Runtime): void {
  // --- version + map flags ---
  def(rt, "VersionGet", (c) => c.rt.enumHandle("Version", VERSION_FROZEN_THRONE));
  def(rt, "VersionCompatible", () => jBool(true));
  def(rt, "VersionSupported", () => jBool(true));
  // IsMapFlagSet(MAP_RANDOM_HERO) — a lobby melee option. We expose none of them yet, so
  // every flag reads false: WC3's default melee game (no random hero → each player gets a
  // free-hero token instead; no random races; no fixed teams).
  def(rt, "IsMapFlagSet", () => jBool(false));

  // --- the game clock (MeleeStartingVisibility) ---
  // A melee game opens at 08:00 (bj_MELEE_STARTING_TOD), set through
  // SetFloatGameState(GAME_STATE_TIME_OF_DAY, …) — which blizzard.j's SetTimeOfDay /
  // GetTimeOfDay BJs also ride on, so a custom map that skews the clock works too.
  def(rt, "SetFloatGameState", (c, a) => {
    if (c.rt.enumIndex(a[0]) === GAME_STATE_TIME_OF_DAY) c.rt.hooks?.setTimeOfDay?.(asNum(a[1]));
    return JNULL;
  });
  def(rt, "GetFloatGameState", (c, a) =>
    jReal(c.rt.enumIndex(a[0]) === GAME_STATE_TIME_OF_DAY ? c.rt.hooks?.getTimeOfDay?.() ?? 0 : 0),
  );
  def(rt, "GetIntegerGameState", () => jInt(0)); // GAME_STATE_DISCONNECTED = 0: nobody has dropped
  def(rt, "SetTimeOfDayScale", (c, a) => ((c.rt.timeOfDayScale = asNum(a[0])), JNULL));
  def(rt, "GetTimeOfDayScale", (c) => jReal(c.rt.timeOfDayScale));

  // --- the camera (MeleeStartingUnits* frames the starting workers, not the hall) ---
  // The …ForPlayer BJs already gate on GetLocalPlayer, so a call reaching here is for the
  // human at this machine.
  def(rt, "SetCameraPosition", (c, a) => (c.rt.hooks?.setCameraPosition?.(asNum(a[0]), asNum(a[1])), JNULL));
  def(rt, "SetCameraQuickPosition", (c, a) => (c.rt.hooks?.setCameraPosition?.(asNum(a[0]), asNum(a[1])), JNULL));

  // --- hero + tech limits (MeleeStartingHeroLimit) ---
  // Recorded, not enforced: we have no tech-limit system yet, so the script's "3 heroes
  // per player, 1 per hero type" caps are remembered but nothing consults them. -1 is
  // WC3's "no limit", which is exactly what ReducePlayerTechMaxAllowed tests for.
  def(rt, "SetPlayerTechMaxAllowed", (c, a) => {
    c.rt.techMaxAllowed.set(`${playerIndex(c, a[0])}:${asInt(a[1])}`, asInt(a[2]));
    return JNULL;
  });
  def(rt, "GetPlayerTechMaxAllowed", (c, a) => jInt(c.rt.techMaxAllowed.get(`${playerIndex(c, a[0])}:${asInt(a[1])}`) ?? -1));
  def(rt, "GetPlayerTechCount", () => jInt(0));
  def(rt, "SetPlayerTechResearched", () => JNULL);
  def(rt, "GetPlayerTechResearched", () => jBool(false));

  // --- victory / defeat (MeleeInitVictoryDefeat → MeleeCheckForLosersAndVictors) ---
  // A melee player is defeated the moment their team owns no structures, and "crippled"
  // (revealed to everyone after 90s) while they own no main hall. Both counts are read
  // through these two natives, so they have to be real — stub them at 0 and every player,
  // ourselves included, is defeated 2 seconds into the game.
  def(rt, "GetPlayerStructureCount", (c, a) => jInt(c.rt.hooks?.playerStructureCount?.(playerIndex(c, a[0]), truthy(a[1])) ?? 0));
  def(rt, "GetPlayerUnitCount", (c, a) => jInt(c.rt.hooks?.playerUnitCount?.(playerIndex(c, a[0]), truthy(a[1])) ?? 0));
  // GetPlayerTypedUnitCount(p, "townhall", …): `unitName` is the unit's internal TYPE name
  // — UnitUI.slk's `name` column ("townhall", "greathall", "treeoflife", "necropolis") —
  // not its display name or rawcode. Verified in the 1.27 MPQ (Units\UnitUI.slk).
  def(rt, "GetPlayerTypedUnitCount", (c, a) =>
    jInt(c.rt.hooks?.playerTypedUnitCount?.(playerIndex(c, a[0]), asStr(a[1]), truthy(a[2]), truthy(a[3])) ?? 0),
  );
  // PlayersAreCoAllied (the BJ every ally count rides on) is GetPlayerAlliance both ways.
  // Our alliances are the lobby's teams — no in-game diplomacy — so the setting is ignored.
  def(rt, "GetPlayerAlliance", (c, a) => jBool(c.rt.hooks?.isPlayerAlly?.(playerIndex(c, a[0]), playerIndex(c, a[1])) ?? false));
  def(rt, "RemovePlayer", () => JNULL); // a defeated/victorious player is dropped — we keep them in the world

  // --- gold mines (MeleeFindNearestMine → MeleeStartingUnits*) ---
  // In WC3 a gold mine IS a unit ('ngol', Neutral Passive), and that's how the melee
  // library finds it: enumerate the units around the start location, keep the nearest
  // 'ngol', clump the workers 320 units off it. Our sim keeps mines in their own table
  // (SimWorld.mines), so the bridge presents them to the script as unit snapshots
  // (EngineHooks.enumUnits); these two natives are the rest of that fiction.
  def(rt, "GetResourceAmount", (c, a) => {
    const u = c.rt.data<{ simId: number }>(a[0]);
    return jInt(u && u.simId >= 0 ? c.rt.hooks?.getResourceAmount?.(u.simId) ?? 0 : 0);
  });
  // The Undead start haunts the nearest mine: BlightGoldMineForPlayerBJ saves the mine's
  // gold, RemoveUnit's the mine, and calls this to raise a Haunted Gold Mine in its place.
  // We don't model haunted mines (every race mines the plain one), so the bridge hands back
  // the mine still standing there — the swap becomes a no-op that keeps the mine, its gold
  // and its handle. Without it the acolytes would spawn around a null location (0,0).
  def(rt, "CreateBlightedGoldmine", (c, a) => {
    const x = asNum(a[1]), y = asNum(a[2]), facing = asNum(a[3]);
    const simId = c.rt.hooks?.createBlightedGoldMine?.(playerIndex(c, a[0]), x, y, facing) ?? -1;
    if (simId < 0) return JNULL;
    return c.rt.unitForSim({ id: simId, typeId: "ngol", owner: PLAYER_NEUTRAL_PASSIVE, x, y, facing });
  });

  // --- blight (Undead) — we don't model blight; the ground under a necropolis stays green ---
  for (const name of ["SetBlight", "SetBlightRect", "SetBlightPoint", "SetBlightLoc"]) def(rt, name, () => JNULL);
  def(rt, "IsPointBlighted", () => jBool(false));

  // --- melee AI (MeleeStartingAI) — no AI scripts yet, so a computer slot just sits there ---
  for (const name of [
    "StartMeleeAI", "StartCampaignAI", "CommandAI", "SetPlayerHandicap", "SetPlayerHandicapXP",
    "RecycleGuardPosition", "RemoveGuardPosition", "SetUnitCreepGuard", "Preloader", "Preload",
    "PreloadStart", "PreloadEnd", "PreloadEndEx", "PreloadRefresh", "PreloadGenClear", "PreloadGenStart",
  ]) {
    def(rt, name, () => JNULL);
  }
  // PickMeleeAI compares against AI_DIFFICULTY_NEWBIE = ConvertAIDifficulty(0), so hand
  // back a real handle rather than a null one.
  def(rt, "GetAIDifficulty", (c) => c.rt.enumHandle("AIDifficulty", 0));
}
