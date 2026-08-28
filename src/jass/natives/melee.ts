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
  // How fast the clock runs, and whether it runs at all — the sim owns both, beside the clock
  // itself. The scale used to be parked on the runtime and multiplied by nothing, so a map
  // that asked for a slow night got a normal one: Rise of the Naga opens at 19:00 with
  // `SetTimeOfDayScalePercentBJ(25.00)` and was in daylight minutes later.
  //
  // `SuspendTimeOfDay` is the MAP's freeze (blizzard.j's `UseTimeOfDayBJ(false)` is a call to
  // it) and is deliberately a different switch from the cinematic's `EnableDawnDusk`: a
  // cinematic restores dawn/dusk on its way out and must not thereby restart a cycle the map
  // stopped for the whole mission.
  def(rt, "SetTimeOfDayScale", (c, a) => (c.rt.hooks?.setTimeOfDayScale?.(asNum(a[0])), JNULL));
  def(rt, "GetTimeOfDayScale", (c) => jReal(c.rt.hooks?.getTimeOfDayScale?.() ?? 1));
  def(rt, "SuspendTimeOfDay", (c, a) => (c.rt.hooks?.suspendTimeOfDay?.(truthy(a[0])), JNULL));

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
  // A defeated/victorious player is "removed" — we keep them in the world (their units stay,
  // as MeleeDoDefeat's own RemovePlayerPreserveUnitsBJ name promises), but the FACT that their
  // game just ended is load-bearing: it is what closes the match's wire (Phase G item 1).
  def(rt, "RemovePlayer", (c, a) => (c.rt.hooks?.playerGameOver?.(playerIndex(c, a[0]), c.rt.enumIndex(a[1])), JNULL));

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
  //
  // The hook raises a real `ugol` over the mine (SimWorld.hauntMine) — but the HANDLE it
  // hands back is still the mine's own, and deliberately. Our mine is not a unit (see
  // MINE_ID_BASE): the gold lives on the mine record, the building merely stands over it, and
  // the two things Blizzard.j does with this return value are `SetResourceAmount(newMine,
  // mineGold)` and `GetUnitLoc(nearestMine)` — both of which are questions about the MINE.
  def(rt, "CreateBlightedGoldmine", (c, a) => {
    const x = asNum(a[1]), y = asNum(a[2]), facing = asNum(a[3]);
    const simId = c.rt.hooks?.createBlightedGoldMine?.(playerIndex(c, a[0]), x, y, facing) ?? -1;
    if (simId < 0) return JNULL;
    return c.rt.unitForSim({ id: simId, typeId: "ngol", owner: PLAYER_NEUTRAL_PASSIVE, x, y, facing });
  });

  // --- blight (Undead) -------------------------------------------------------------------
  //
  // These paint the ground, and the melee opening is the reason they have to: every Undead
  // start ends with `SetBlightLoc(whichPlayer, nearMineLoc, 768, true)` (Blizzard.j,
  // MeleeStartingUnitsUndead) — the patch of rot around the haunted mine, which is what the
  // three Acolytes standing there regenerate on. As no-ops the race began its game off
  // blight.
  //
  // `whichPlayer` is ignored, because blight is not owned: it is one property of the terrain,
  // and the native takes a player only so the engine knows whose sight to reveal it in.
  def(rt, "SetBlight", (c, a) => {
    c.rt.hooks?.setBlight?.(asNum(a[1]), asNum(a[2]), asNum(a[3]), truthy(a[4]));
    return JNULL;
  });
  def(rt, "SetBlightPoint", (c, a) => {
    // No radius: one point, which is one terrain corner (BlightGrid's lattice is 128 apart).
    c.rt.hooks?.setBlight?.(asNum(a[1]), asNum(a[2]), 1, truthy(a[3]));
    return JNULL;
  });
  def(rt, "SetBlightLoc", (c, a) => {
    const loc = c.rt.data<{ x: number; y: number }>(a[1]);
    if (loc) c.rt.hooks?.setBlight?.(loc.x, loc.y, asNum(a[2]), truthy(a[3]));
    return JNULL;
  });
  def(rt, "SetBlightRect", (c, a) => {
    const r = c.rt.data<{ minX: number; minY: number; maxX: number; maxY: number }>(a[1]);
    if (!r) return JNULL;
    // A rect, painted as the disc that covers it from its own centre — the grid paints discs
    // and nothing in the stock scripts uses this one, so a corner-exact rect would be
    // machinery with no caller. Recorded rather than silently approximated.
    const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2;
    c.rt.hooks?.setBlight?.(cx, cy, Math.hypot(r.maxX - cx, r.maxY - cy), truthy(a[2]));
    return JNULL;
  });
  def(rt, "IsPointBlighted", (c, a) => jBool(c.rt.hooks?.isPointBlighted?.(asNum(a[0]), asNum(a[1])) ?? false));

  // --- melee AI (MeleeStartingAI) ---------------------------------------------------------
  //
  // `StartMeleeAI(p, "orc.ai")` is where a computer player is actually seated, and it is the
  // MAP that gets there: Blizzard.j's MeleeStartingAI walks the slots, keeps the PLAYING ones
  // whose controller is MAP_CONTROL_COMPUTER, and picks the .ai file for the race each
  // resolved to. Ours are ports of those same four files (src/ai/, docs/melee-ai.md), so the
  // filename names the race and nothing else has to be passed.
  //
  // Driving it from here rather than from the match setup is the whole point: a map whose
  // Melee Initialization trigger omits "Run melee AI scripts", and every custom map (which
  // runs none of the melee library at all), then gets exactly what the real game gives them —
  // computer slots that sit still, driven by the map's own triggers if it has any.
  def(rt, "StartMeleeAI", (c, a) => (c.rt.hooks?.startMeleeAI?.(playerIndex(c, a[0]), asStr(a[1])), JNULL));
  // StartCampaignAI stays a no-op: a chapter's computers are the mission's, and what this
  // would load is a per-campaign .ai file we do not run.
  for (const name of [
    "StartCampaignAI", "CommandAI", "SetPlayerHandicap", "SetPlayerHandicapXP",
    "RecycleGuardPosition", "RemoveGuardPosition", "SetUnitCreepGuard", "Preloader", "Preload",
    "PreloadStart", "PreloadEnd", "PreloadEndEx", "PreloadRefresh", "PreloadGenClear", "PreloadGenStart",
  ]) {
    def(rt, name, () => JNULL);
  }
  // PickMeleeAI compares against AI_DIFFICULTY_NEWBIE = ConvertAIDifficulty(0), so hand
  // back a real handle rather than a null one.
  def(rt, "GetAIDifficulty", (c) => c.rt.enumHandle("AIDifficulty", 0));
}
