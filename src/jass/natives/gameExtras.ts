// Game setup, players, score, UI input, terrain and the engine-internal natives (issue #313).
//
// Everything here is declared in the install's own 1.30.4 `Scripts\common.j` and had no
// implementation, so each call logged "not implemented" once and answered a typed default.
// They fall into three honest kinds, and the kind is stated beside each registration:
//
//   1. BEHAVIOUR — the native changes or reads something the engine really keeps: terrain
//      pathing, a region's cells, a doodad's clip, whether the player may select, a key pressed
//      on the player's behalf, a cheat, the tax between two players, the score table.
//   2. STORED — the game keeps a setting that nothing else in THIS engine consumes (the lobby's
//      creature density, which game types a map supports, a custom campaign's button row). It is
//      written and read back faithfully, so a script that sets one and asks for it later gets
//      its own answer rather than 0.
//   3. NOTHING, on purpose — Blizzard's own test harness (`Automation…`), the Battle.net ladder
//      (`RequestExtra…Data`, the tournament getters), the sync markers of a lockstep network
//      model this engine does not use (`TriggerSync…`), and a few natives the game itself never
//      finished. Registered as explicit no-ops so the log stops reporting them as missing work.
//
// Sources: common.j for the signatures, `Scripts\Blizzard.j` for the callers (line numbers
// beside each), jassdoc (github.com/lep/jassdoc) for behaviour no file states.

import { intToRawcode, rawcodeToInt } from "../lexer";
import type { JassPlayer, NativeCtx, RectObj, RegionObj, Runtime, TriggerObj } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, JNULL, jReal, jStr, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const playerOf = (c: NativeCtx, v: JassValue | undefined): number => c.rt.data<JassPlayer>(v ?? JNULL)?.index ?? -1;
/** This module's own settings, kept on the runtime so a saved game carries them. */
const store = (c: NativeCtx): Map<string, number> => c.rt.nativeTable<string, number>("gameExtras");

/** A `trackable` — an invisible (or modelled) spot on the ground that hears the mouse. */
interface TrackableObj {
  handleId: number;
  x: number;
  y: number;
  facing: number;
  /** The engine's id for the model standing there, -1 when the path was "" or there is no engine. */
  effectId: number;
}

/** Pathing cells are 32 world units (jassdoc on RegionClearCell: "Cells are 32x32 world units
 *  and aligned with multiples of 32"). */
const CELL = 32;

export function registerGameExtraNatives(rt: Runtime): void {
  // ======================================================================================
  // 1. BEHAVIOUR
  // ======================================================================================

  // SetTerrainPathable(x, y, pathingtype, flag) — Blizzard.j 2038 (SetTerrainPathableBJ, the
  // GUI's "Environment - Set Terrain Pathing"). `flag` TRUE makes the cell pathable — the
  // setter reads the way its name does, unlike IsTerrainPathable (natives/predicates.ts).
  def(rt, "SetTerrainPathable", (c, a) => {
    c.rt.hooks?.setTerrainPathable?.(asNum(a[0]), asNum(a[1]), c.rt.enumIndex(a[2]), truthy(a[3]));
    return JNULL;
  });

  // A region's CELLS. `RegionAddCell` was already here (natives/region.ts); these are its
  // location twin and the two that take a cell back out. A region is kept as a list of rects,
  // so a cleared cell is recorded as a HOLE the membership test subtracts (RegionObj.holes).
  const region = (c: NativeCtx, v: JassValue): RegionObj | undefined => c.rt.data<RegionObj>(v);
  const cellOf = (x: number, y: number): { minx: number; miny: number; maxx: number; maxy: number } => {
    const minx = Math.floor(x / CELL) * CELL, miny = Math.floor(y / CELL) * CELL;
    return { minx, miny, maxx: minx + CELL, maxy: miny + CELL };
  };
  const clearCell = (rg: RegionObj | undefined, x: number, y: number): void => {
    if (rg) (rg.holes ??= []).push(cellOf(x, y));
  };
  def(rt, "RegionAddCellAtLoc", (c, a) => {
    const l = c.rt.data<{ x: number; y: number }>(a[1]);
    const add = c.rt.natives.get("RegionAddCell");
    if (l && add) add(c, [a[0], jReal(l.x), jReal(l.y)]);
    return JNULL;
  });
  def(rt, "RegionClearCell", (c, a) => (clearCell(region(c, a[0]), asNum(a[1]), asNum(a[2])), JNULL));
  def(rt, "RegionClearCellAtLoc", (c, a) => {
    const l = c.rt.data<{ x: number; y: number }>(a[1]);
    if (l) clearCell(region(c, a[0]), l.x, l.y);
    return JNULL;
  });

  // SetDoodadAnimation(x, y, radius, doodadID, nearestOnly, animName, animRandom) and its rect
  // twin — Blizzard.j 2126/2131, the GUI's "Doodad - Play Animation For Doodads In Circle/Region".
  // A doodad id of 0 is not "any" in the BJ's use (it always names a type), so it is passed as
  // the empty string and the host decides.
  const doodadId = (v: JassValue | undefined): string => {
    const n = asInt(v ?? JNULL);
    return n ? intToRawcode(n) : "";
  };
  def(rt, "SetDoodadAnimation", (c, a) => {
    c.rt.hooks?.setDoodadAnimation?.({ x: asNum(a[0]), y: asNum(a[1]), radius: asNum(a[2]) }, doodadId(a[3]), truthy(a[4]), asStr(a[5]), truthy(a[6]));
    return JNULL;
  });
  def(rt, "SetDoodadAnimationRect", (c, a) => {
    const r = c.rt.data<RectObj>(a[0]);
    if (r) c.rt.hooks?.setDoodadAnimation?.({ minx: r.minx, miny: r.miny, maxx: r.maxx, maxy: r.maxy }, doodadId(a[1]), false, asStr(a[2]), truthy(a[3]));
    return JNULL;
  });

  // EnableSelect / EnableDragSelect / EnablePreSelect (state, ui) — "Controls whether you can
  // de/select any units and the green visual indicator" (jassdoc); the drag and the hover
  // preselection are the other two.
  for (const [name, kind] of [["EnableSelect", "select"], ["EnableDragSelect", "drag"], ["EnablePreSelect", "preselect"]] as const) {
    def(rt, name, (c, a) => (c.rt.hooks?.enableSelection?.(kind, truthy(a[0]), truthy(a[1])), JNULL));
  }
  // ForceUIKey(key) / ForceUICancel() — Blizzard.j 4288/4296, which call them inside
  // `if GetLocalPlayer() == whichPlayer`. "Only the first character of the string is taken …
  // Accepts ASCII digits and Latin letters, other characters are ignored" (jassdoc); cancel
  // "emulates an ESCAPE key press".
  def(rt, "ForceUIKey", (c, a) => {
    const key = asStr(a[0]).charAt(0);
    if (/^[0-9A-Za-z]$/.test(key)) c.rt.hooks?.forceUiKey?.(key.toUpperCase());
    return JNULL;
  });
  def(rt, "ForceUICancel", (c) => (c.rt.hooks?.forceUiKey?.("Escape"), JNULL));
  // Cheat(cheatStr) — "Applies the specified cheat, but only if the game is single player".
  def(rt, "Cheat", (c, a) => (c.rt.hooks?.cheat?.(asStr(a[0])), JNULL));
  def(rt, "DoNotSaveReplay", (c) => (c.rt.hooks?.doNotSaveReplay?.(), JNULL));
  // DisplayLoadDialog() — Blizzard.j 5319 (the defeat dialog's Load button). "Singleplayer only".
  def(rt, "DisplayLoadDialog", (c) => (c.rt.hooks?.displayLoadDialog?.(), JNULL));
  // DisableRestartMission(flag) — TRUE disables "Restart Mission" (jassdoc).
  def(rt, "DisableRestartMission", (c, a) => (c.rt.hooks?.disableRestartMission?.(truthy(a[0])), JNULL));
  def(rt, "SetReservedLocalHeroButtons", (c, a) => (c.rt.hooks?.setReservedHeroButtons?.(Math.max(0, asInt(a[0]))), JNULL));

  // The tax one player pays another (Blizzard.j 7678/7683): `rate` per cent of what
  // `sourcePlayer` earns of a resource is paid over to `otherPlayer`. Read back from the store
  // so the getter answers what the setter wrote; the host applies it to income.
  const taxKey = (src: number, other: number, res: number): string => `tax:${src}:${other}:${res}`;
  def(rt, "SetPlayerTaxRate", (c, a) => {
    const src = playerOf(c, a[0]), other = playerOf(c, a[1]), res = c.rt.enumIndex(a[2]);
    if (src < 0 || other < 0 || src === other) return JNULL;
    const rate = Math.max(0, Math.min(100, asInt(a[3])));
    store(c).set(taxKey(src, other, res), rate);
    c.rt.hooks?.setPlayerTaxRate?.(src, other, res, rate);
    return JNULL;
  });
  def(rt, "GetPlayerTaxRate", (c, a) => jInt(store(c).get(taxKey(playerOf(c, a[0]), playerOf(c, a[1]), c.rt.enumIndex(a[2]))) ?? 0));

  // The score screen. SetPlayerOnScoreScreen(p, flag) — Blizzard.j 5400. GetPlayerScore(p,
  // playerscore) reads one column of the live table; a column the host does not keep is 0.
  def(rt, "SetPlayerOnScoreScreen", (c, a) => {
    const p = playerOf(c, a[0]);
    if (p >= 0) c.rt.hooks?.setPlayerOnScoreScreen?.(p, truthy(a[1]));
    return JNULL;
  });
  def(rt, "GetPlayerScore", (c, a) => {
    const p = playerOf(c, a[0]);
    return jInt(p >= 0 ? c.rt.hooks?.playerScore?.(p, c.rt.enumIndex(a[1])) ?? 0 : 0);
  });
  // ChooseRandomNPBuilding() — Blizzard.j 2911. "A random neutral passive building, such as the
  // 'Goblin Merchant' or 'Tavern' … not necessarily on the map already" (jassdoc).
  def(rt, "ChooseRandomNPBuilding", (c) => {
    const id = c.rt.hooks?.chooseRandomNPBuilding?.() ?? "";
    return jInt(id ? rawcodeToInt(id) : 0);
  });

  // --- triggers that wait on the triggers they run ---
  // TriggerWaitOnSleeps(t, flag) marks a trigger; TriggerExecuteWait(t) "does the same as
  // TriggerExecute but if the caller has been marked with TriggerWaitOnSleeps … will
  // additionally wait for TriggerSleepActions of the callee" (jassdoc). The flag is kept and
  // read back. TriggerExecuteWait runs the callee as TriggerExecute does — to its first wait;
  // parking the CALLER until the callee's thread ends needs the scheduler and is not done.
  def(rt, "TriggerWaitOnSleeps", (c, a) => {
    const t = c.rt.data<TriggerObj>(a[0]);
    if (t) t.waitOnSleeps = truthy(a[1]);
    return JNULL;
  });
  def(rt, "IsTriggerWaitOnSleeps", (c, a) => jBool(c.rt.data<TriggerObj>(a[0])?.waitOnSleeps ?? false));
  def(rt, "TriggerExecuteWait", (c, a) => c.rt.natives.get("TriggerExecute")?.(c, a) ?? JNULL);

  // --- trackables ---
  // CreateTrackable(modelPath, x, y, facing) — a spot that "register[s] mouse clicks or hovers"
  // (jassdoc). The object, its model ("" is an invisible one) and its two registrations are
  // real; what is NOT raised yet is the event itself — no pointer is tested against a
  // trackable — so a trigger registered on one never fires. Stated here rather than hidden.
  def(rt, "CreateTrackable", (c, a) => {
    const path = asStr(a[0]);
    const t: TrackableObj = { handleId: 0, x: asNum(a[1]), y: asNum(a[2]), facing: asNum(a[3]), effectId: -1 };
    if (path) {
      t.effectId = c.rt.hooks?.addSpecialEffect?.(path, t.x, t.y) ?? -1;
      if (t.effectId >= 0) c.rt.hooks?.setSpecialEffectOrientation?.(t.effectId, (t.facing * Math.PI) / 180, null, null);
    }
    t.handleId = c.rt.handles.alloc(t);
    return jHandle(t.handleId, "trackable");
  });
  const registerTrackable = (kind: string): NativeFn => (c, a) => {
    const t = c.rt.data<TriggerObj>(a[0]);
    if (t && a[1]?.k === "handle") c.rt.addTriggerReg({ kind, trigId: t.handleId, params: [a[1]] });
    return jHandle(0, "event");
  };
  def(rt, "TriggerRegisterTrackableHitEvent", registerTrackable("trackableHit"));
  def(rt, "TriggerRegisterTrackableTrackEvent", registerTrackable("trackableTrack"));
  def(rt, "GetTriggeringTrackable", (c) => c.rt.eventResponse("TriggeringTrackable"));

  // ======================================================================================
  // 2. STORED — written and read back; nothing else here consumes them
  // ======================================================================================

  // The lobby's two density settings (MAP_DENSITY_NONE/LIGHT/MEDIUM/HEAVY, common.j 431–434).
  // This engine's lobby has no such control, so they start at NONE — the typed default the
  // getters answered before, now as a real handle a script can compare.
  def(rt, "SetCreatureDensity", (c, a) => (store(c).set("creatureDensity", c.rt.enumIndex(a[0])), JNULL));
  def(rt, "GetCreatureDensity", (c) => c.rt.enumHandle("MapDensity", store(c).get("creatureDensity") ?? 0));
  def(rt, "SetResourceDensity", (c, a) => (store(c).set("resourceDensity", c.rt.enumIndex(a[0])), JNULL));
  def(rt, "GetResourceDensity", (c) => c.rt.enumHandle("MapDensity", store(c).get("resourceDensity") ?? 0));
  // Which game types a map says it supports (GAME_TYPE_* are bit values, common.j 387–394).
  def(rt, "SetGameTypeSupported", (c, a) => {
    const bit = c.rt.enumIndex(a[0]);
    const have = store(c).get("gameTypes") ?? 0;
    store(c).set("gameTypes", truthy(a[1]) ? have | bit : have & ~bit);
    return JNULL;
  });
  def(rt, "IsGameTypeSupported", (c, a) => jBool(((store(c).get("gameTypes") ?? 0) & c.rt.enumIndex(a[0])) !== 0));
  def(rt, "GetGamePlacement", (c) => c.rt.enumHandle("Placement", c.rt.setup.placement));
  def(rt, "DefineStartLocationLoc", (c, a) => {
    const l = c.rt.data<{ x: number; y: number }>(a[1]);
    if (l) c.rt.setup.startLocations.set(asInt(a[0]), { x: l.x, y: l.y });
    return JNULL;
  });
  // Start-location priorities: SetStartLocPrio(whichStartLoc, prioSlotIndex, otherStartLocIndex,
  // priority) is recorded by natives/config.ts into the same table these two read.
  const prio = (c: NativeCtx, a: JassValue[]): number | undefined =>
    c.rt.nativeTable<string, number>("startLocPrio").get(`${asInt(a[0])}:${asInt(a[1])}`);
  // The slot's OTHER start location, and the priority given it (packed as other * 4 + prio).
  def(rt, "GetStartLocPrioSlot", (c, a) => jInt(Math.floor((prio(c, a) ?? 0) / 4)));
  def(rt, "GetStartLocPrio", (c, a) => c.rt.enumHandle("StartLocPrio", (prio(c, a) ?? 0) % 4));
  // GetPlayerSelectable — the flag SetPlayerRaceSelectable writes (natives/config.ts).
  def(rt, "GetPlayerSelectable", (c, a) => jBool(c.rt.data<JassPlayer>(a[0])?.raceSelectable ?? false));
  // IsPlayerRacePrefSet(p, pref) — RACE_PREF_* are BIT values (common.j: HUMAN 1, ORC 2,
  // NIGHTELF 4, UNDEAD 8, DEMON 16, RANDOM 32, USER_SELECTABLE 64), so this is a mask test.
  def(rt, "IsPlayerRacePrefSet", (c, a) => jBool(((c.rt.data<JassPlayer>(a[0])?.race ?? 0) & c.rt.enumIndex(a[1])) !== 0));
  // A custom campaign's button row (Blizzard.j 7556/7561, 0-based here and 1-based in the BJ).
  def(rt, "SetCustomCampaignButtonVisible", (c, a) => (store(c).set(`campaignButton:${asInt(a[0])}`, truthy(a[1]) ? 1 : 0), JNULL));
  def(rt, "GetCustomCampaignButtonVisible", (c, a) => jBool((store(c).get(`campaignButton:${asInt(a[0])}`) ?? 0) === 1));
  // SetDefaultDifficulty has no reader of its own: GetDefaultDifficulty answers the difficulty
  // the MATCH started on (natives/cinematic.ts), which is the host's and not a script's to set.
  def(rt, "SetDefaultDifficulty", () => JNULL);

  // --- event responses for events this engine answers, or will ---
  // Read off the event stack, so each is null (or its typed zero) outside its own event —
  // exactly what the game answers. EVENT_UNIT_STATE_LIMIT / EVENT_PLAYER_STATE_LIMIT /
  // EVENT_GAME_STATE_LIMIT set theirs where the pump fires them (Interpreter.pumpUnitStates …).
  for (const [name, key] of [
    ["GetEventUnitState", "EventUnitState"],
    ["GetEventPlayerState", "EventPlayerState"],
    ["GetEventGameState", "EventGameState"],
    ["GetTriggeringRegion", "TriggeringRegion"],
    ["GetWinningPlayer", "WinningPlayer"], // EVENT_GAME_VICTORY
    ["GetDecayingUnit", "DecayingUnit"], // EVENT_PLAYER_UNIT_DECAY
    ["GetRescuer", "Rescuer"], // EVENT_PLAYER_UNIT_RESCUED — Blizzard.j 6739
    ["GetSpellTargetItem", "SpellTargetItem"],
    // Raised by nothing yet — the hero-revive, acquire and detect events are not pumped:
    ["GetRevivableUnit", "RevivableUnit"], // EVENT_PLAYER_HERO_REVIVABLE
    ["GetRevivingUnit", "RevivingUnit"], // EVENT_PLAYER_HERO_REVIVE_START/CANCEL/FINISH
    ["GetEventTargetUnit", "EventTargetUnit"], // EVENT_UNIT_ACQUIRED_TARGET / _TARGET_IN_RANGE
    ["GetDetectedUnit", "DetectedUnit"], // EVENT_PLAYER_UNIT_DETECTED
    ["GetEventDetectingPlayer", "EventDetectingPlayer"],
  ] as const) {
    def(rt, name, (c) => c.rt.eventResponse(key));
  }

  // ======================================================================================
  // 3. NOTHING, on purpose
  // ======================================================================================

  // No tournament is ever running: Blizzard.j's MeleeTriggerTournamentFinishSoon/Now (9351,
  // 9532) are registered on game events this engine never raises, and read these.
  def(rt, "GetTournamentFinishSoonTimeRemaining", () => jReal(0));
  def(rt, "GetTournamentFinishNowRule", () => jInt(0));
  def(rt, "GetTournamentFinishNowPlayer", () => JNULL);
  def(rt, "GetTournamentScore", () => jInt(0));
  // CachePlayerHeroData(p) — "Used to store hero level data for the scorescreen, before units
  // are moved to neutral passive in melee games" (jassdoc; Blizzard.j 5057, 8848…). Our score
  // table counts a hero's levels as they are gained (sim/matchStats.ts), so there is nothing to
  // snapshot when the units change hands.
  def(rt, "CachePlayerHeroData", () => JNULL);
  // Cosmetic, with nothing behind them here: a terrain deformation does not move our water
  // mesh either way; an image is drawn on the ground, never over water; SetUbersplatRender has
  // the same "does not work, use …RenderAlways" history its image twin has (natives/imagery.ts).
  for (const name of ["SetWaterDeforms", "SetImageAboveWater", "SetUbersplatRender"]) def(rt, name, () => JNULL);
  // The intro shot (a model and a line of text shown before a map) is not a feature of the
  // shipped game: nothing in the install calls either.
  for (const name of ["SetIntroShotModel", "SetIntroShotText"]) def(rt, name, () => JNULL);
  // PreloadGenEnd(filename) "writes the current Preload buffer to specified file" on the
  // player's disk. A map does not get to write files here; its Preload siblings are no-ops too
  // (natives/melee.ts).
  def(rt, "PreloadGenEnd", () => JNULL);
  // ReloadGame() restarts the match from its own load; the supported way out of a lost chapter
  // is RestartGame (natives/cinematic.ts), which the defeat dialog calls.
  def(rt, "ReloadGame", () => JNULL);
  // Blizzard's automated test harness, the ladder's extra-data requests and the lockstep sync
  // markers. None has a meaning outside Blizzard's own tooling and servers.
  for (const name of ["AutomationSetTestType", "AutomationTestStart", "AutomationTestEnd", "AutomationTestingFinished", "TriggerSyncStart", "TriggerSyncReady"]) {
    def(rt, name, () => JNULL);
  }
  def(rt, "RequestExtraIntegerData", () => jInt(0));
  def(rt, "RequestExtraBooleanData", () => jBool(false));
  def(rt, "RequestExtraStringData", () => jStr(""));
  def(rt, "RequestExtraRealData", () => jReal(0));
}
