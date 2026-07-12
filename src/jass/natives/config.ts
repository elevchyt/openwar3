// config() + player-setup natives (Phase 7 — issue #33; see docs/triggers.md).
//
// These are the natives a map's config() calls to declare its players, teams, and
// start locations (verified on PlunderIsle / WarChasers). They record into the
// runtime's MapSetup, which we cross-check against war3map.w3i — the free
// correctness oracle for this milestone (7.1). No engine bridge is needed: config
// is pure declaration, so it runs identically headless or live.

import type { JassPlayer, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jBool, jInt, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const player = (ctx: NativeCtx, v: JassValue): JassPlayer | undefined => ctx.rt.data<JassPlayer>(v);

export function registerConfigNatives(rt: Runtime): void {
  // --- map identity + counts ---
  def(rt, "SetMapName", (c, a) => ((c.rt.setup.mapName = asStr(a[0])), JNULL));
  def(rt, "SetMapDescription", (c, a) => ((c.rt.setup.mapDescription = asStr(a[0])), JNULL));
  def(rt, "SetPlayers", (c, a) => ((c.rt.setup.numPlayers = asInt(a[0])), JNULL));
  def(rt, "SetTeams", (c, a) => ((c.rt.setup.numTeams = asInt(a[0])), JNULL));
  def(rt, "SetGamePlacement", (c, a) => ((c.rt.setup.placement = c.rt.enumIndex(a[0])), JNULL));

  // --- start locations (whichStartLoc, x, y) → the map's placement grid ---
  def(rt, "DefineStartLocation", (c, a) => {
    c.rt.setup.startLocations.set(asInt(a[0]), { x: asNum(a[1]), y: asNum(a[2]) });
    return JNULL;
  });
  def(rt, "SetStartLocPrio", () => JNULL); // AI start-loc priorities — recorded as no-ops
  def(rt, "SetStartLocPrioCount", () => JNULL);

  // --- per-player setup (SetPlayer*) ---
  def(rt, "SetPlayerColor", (c, a) => {
    const p = player(c, a[0]);
    if (p) p.color = c.rt.enumIndex(a[1]);
    return JNULL;
  });
  def(rt, "SetPlayerRacePreference", (c, a) => {
    const p = player(c, a[0]);
    if (p) p.race = c.rt.enumIndex(a[1]);
    return JNULL;
  });
  def(rt, "SetPlayerRaceSelectable", (c, a) => {
    const p = player(c, a[0]);
    if (p) p.raceSelectable = truthy(a[1]);
    return JNULL;
  });
  def(rt, "SetPlayerController", (c, a) => {
    const p = player(c, a[0]);
    if (p) p.controller = c.rt.enumIndex(a[1]);
    return JNULL;
  });
  def(rt, "SetPlayerStartLocation", (c, a) => {
    const p = player(c, a[0]);
    if (p) p.startLocation = asInt(a[1]);
    return JNULL;
  });
  def(rt, "ForcePlayerStartLocation", (c, a) => {
    const p = player(c, a[0]);
    if (p) {
      p.startLocation = asInt(a[1]);
      p.forcedStartLocation = true;
    }
    return JNULL;
  });
  def(rt, "SetPlayerTeam", (c, a) => {
    const p = player(c, a[0]);
    if (p) p.team = asInt(a[1]);
    return JNULL;
  });

  // --- player queries (used by blizzard.j slot logic + custom triggers) ---
  def(rt, "Player", (c, a) => c.rt.playerHandle(asInt(a[0])));
  def(rt, "GetPlayerId", (c, a) => jInt(player(c, a[0])?.index ?? 0));
  def(rt, "GetLocalPlayer", (c) => c.rt.playerHandle(c.rt.localPlayer)); // the human at THIS machine
  def(rt, "GetPlayerController", (c, a) => c.rt.enumHandle("MapControl", player(c, a[0])?.controller ?? 4));
  // Is the slot actually being played? The lobby's answer (Runtime.applyLobby), not the
  // map's — and the gate on blizzard.j's entire melee library (7.3): a slot that isn't
  // PLAYING gets no starting units, no resources, and keeps its start-location creeps.
  def(rt, "GetPlayerSlotState", (c, a) => c.rt.enumHandle("PlayerSlotState", player(c, a[0])?.slotState ?? 0));
  // The race the player actually plays (a lobby "random" already resolved) — what
  // MeleeStartingUnits branches on. ConvertRace: 1 human, 2 orc, 3 undead, 4 night elf.
  def(rt, "GetPlayerRace", (c, a) => c.rt.enumHandle("Race", player(c, a[0])?.raceIndex ?? 0));
  def(rt, "IsPlayerObserver", () => jBool(false)); // no observer slots (GetPlayerName lives in natives/text.ts)
  def(rt, "GetPlayerTeam", (c, a) => jInt(player(c, a[0])?.team ?? 0));
  def(rt, "GetPlayerColor", (c, a) => c.rt.enumHandle("PlayerColor", player(c, a[0])?.color ?? 0));
  def(rt, "GetPlayerStartLocation", (c, a) => jInt(player(c, a[0])?.startLocation ?? -1));
  def(rt, "GetStartLocationX", (c, a) => ({ k: "real", n: c.rt.setup.startLocations.get(asInt(a[0]))?.x ?? 0 }));
  def(rt, "GetStartLocationY", (c, a) => ({ k: "real", n: c.rt.setup.startLocations.get(asInt(a[0]))?.y ?? 0 }));

  // The selected game type gates blizzard.j's generic slot init (melee vs custom).
  def(rt, "GetGameTypeSelected", (c) => c.rt.enumHandle("GameType", c.rt.gameType));

  // --- player resources / state (SetPlayerState & the AdjustPlayerState*BJ family
  //     ride on these two). `state` is the raw playerstate index — the sim maps
  //     1 = gold, 2 = lumber, 4/5 = food cap/used (see the bridge in mapViewer). ---
  def(rt, "SetPlayerState", (c, a) => {
    const p = player(c, a[0]);
    if (p) c.rt.hooks?.setPlayerState?.(p.index, c.rt.enumIndex(a[1]), asInt(a[2]));
    return JNULL;
  });
  def(rt, "GetPlayerState", (c, a) => {
    const p = player(c, a[0]);
    return jInt(p ? c.rt.hooks?.getPlayerState?.(p.index, c.rt.enumIndex(a[1])) ?? 0 : 0);
  });
  def(rt, "SetPlayerAlliance", () => JNULL);
  def(rt, "SetPlayerAllianceStateBJ", () => JNULL);
  // SetPlayerName is implemented in natives/text.ts (it feeds GetPlayerName).
}
