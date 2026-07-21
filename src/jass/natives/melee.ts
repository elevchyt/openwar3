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
import { intToRawcode } from "../lexer";

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
  // Answers 0 to every igamestate query, which reads correctly for the ones that matter:
  // GAME_STATE_DISCONNECTED (1) → 0, nobody has dropped. (The comment here used to name
  // DISCONNECTED as index 0; common.j numbers DIVINE_INTERVENTION 0 and DISCONNECTED 1 —
  // harmless, since the stub ignores its argument, but the 7.25 enum gate exists because
  // that kind of miscount is exactly what went wrong with `mapcontrol`.)
  def(rt, "GetIntegerGameState", () => jInt(0));
  def(rt, "SetTimeOfDayScale", (c, a) => ((c.rt.timeOfDayScale = asNum(a[0])), JNULL));
  def(rt, "GetTimeOfDayScale", (c) => jReal(c.rt.timeOfDayScale));

  // --- the camera (MeleeStartingUnits* frames the starting workers, not the hall) ---
  // The …ForPlayer BJs gate on GetLocalPlayer — and since item 7b that gate is re-run once per
  // recipient, so a call reaching here is for whoever `localViewer` currently says. Which one
  // of those passes is allowed to move the real camera is settled at the HOOK, by
  // `Runtime.localViewHooks`: the extra passes get a stub.
  def(rt, "SetCameraPosition", (c, a) => (c.rt.hooks?.setCameraPosition?.(asNum(a[0]), asNum(a[1])), JNULL));
  def(rt, "SetCameraQuickPosition", (c, a) => (c.rt.hooks?.setCameraPosition?.(asNum(a[0]), asNum(a[1])), JNULL));

  // --- hero + tech limits (MeleeStartingHeroLimit) ---
  // The availability cap is now REAL (issue #57): the sim's TechState reads it, so
  // Blizzard.j's InitSummonableCaps genuinely hides the Barrage Siege Engine (`hrtt`) until
  // Barrage is researched — `SetPlayerTechMaxAllowed(p,'hrtt',0)`. -1 is WC3's "no limit",
  // which is what ReducePlayerTechMaxAllowed tests for.
  def(rt, "SetPlayerTechMaxAllowed", (c, a) => {
    const player = playerIndex(c, a[0]);
    const tech = intToRawcode(asInt(a[1]));
    const max = asInt(a[2]);
    c.rt.techMaxAllowed.set(`${player}:${asInt(a[1])}`, max);
    c.rt.hooks?.setPlayerTechMaxAllowed?.(player, tech, max);
    return JNULL;
  });
  def(rt, "GetPlayerTechMaxAllowed", (c, a) => jInt(c.rt.techMaxAllowed.get(`${playerIndex(c, a[0])}:${asInt(a[1])}`) ?? -1));
  // For an upgrade the count is its researched LEVEL; for a unit type it's how many the
  // player owns. One native, both meanings — that's WC3's own overload.
  def(rt, "GetPlayerTechCount", (c, a) =>
    jInt(c.rt.hooks?.playerTechCount?.(playerIndex(c, a[0]), intToRawcode(asInt(a[1])), truthy(a[2])) ?? 0),
  );
  def(rt, "SetPlayerTechResearched", (c, a) => {
    c.rt.hooks?.setPlayerTechResearched?.(playerIndex(c, a[0]), intToRawcode(asInt(a[1])), asInt(a[2]));
    return JNULL;
  });
  def(rt, "GetPlayerTechResearched", (c, a) => {
    // "researched at level N or better" — the 3rd arg is the level being asked about.
    const have = c.rt.hooks?.playerTechCount?.(playerIndex(c, a[0]), intToRawcode(asInt(a[1])), true) ?? 0;
    return jBool(have >= Math.max(1, asInt(a[2])));
  });

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
  // GetPlayerAlliance — the native PlayersAreCoAllied (the BJ every ally count rides on)
  // reads both ways — moved to natives/vision.ts (7.22), where it reads the real per-pair
  // alliance matrix instead of collapsing to a team comparison that ignored the setting.
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
