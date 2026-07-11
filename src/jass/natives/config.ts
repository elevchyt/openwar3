// config() + player-setup natives (Phase 7 — issue #33; see docs/triggers.md).
//
// These are the natives a map's config() calls to declare its players, teams, and
// start locations (verified on PlunderIsle / WarChasers). They record into the
// runtime's MapSetup, which we cross-check against war3map.w3i — the free
// correctness oracle for this milestone (7.1). No engine bridge is needed: config
// is pure declaration, so it runs identically headless or live.

import type { JassPlayer, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jInt, JNULL, truthy, type JassValue } from "../values";

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
  def(rt, "GetLocalPlayer", (c) => c.rt.playerHandle(0)); // single-player: the one human is slot 0
  def(rt, "GetPlayerController", (c, a) => c.rt.enumHandle("MapControl", player(c, a[0])?.controller ?? 4));
  def(rt, "GetPlayerTeam", (c, a) => jInt(player(c, a[0])?.team ?? 0));
  def(rt, "GetPlayerColor", (c, a) => c.rt.enumHandle("PlayerColor", player(c, a[0])?.color ?? 0));
  def(rt, "GetPlayerStartLocation", (c, a) => jInt(player(c, a[0])?.startLocation ?? -1));
  def(rt, "GetStartLocationX", (c, a) => ({ k: "real", n: c.rt.setup.startLocations.get(asInt(a[0]))?.x ?? 0 }));
  def(rt, "GetStartLocationY", (c, a) => ({ k: "real", n: c.rt.setup.startLocations.get(asInt(a[0]))?.y ?? 0 }));

  // The selected game type gates blizzard.j's generic slot init (melee vs custom).
  def(rt, "GetGameTypeSelected", (c) => c.rt.enumHandle("GameType", c.rt.gameType));

  // --- player-state / alliance stubs used during setup (safe no-ops/defaults) ---
  def(rt, "SetPlayerState", () => JNULL);
  def(rt, "SetPlayerAlliance", () => JNULL);
  def(rt, "SetPlayerAllianceStateBJ", () => JNULL);
  // SetPlayerName is implemented in natives/text.ts (it feeds GetPlayerName).
}
