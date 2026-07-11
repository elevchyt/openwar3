// Force (player-group) natives (Phase 7 — issue #33; see docs/triggers.md).
//
// A `force` is a set of players. It's the target of most "Text Message" trigger
// actions — the GUI "Game - Display text" action compiles to
// `DisplayTextToForce(GetPlayersAll(), msg)`, and blizzard.j's DisplayTextToForce /
// ClearTextMessagesBJ / ShowTextTagForceBJ all gate on
// `IsPlayerInForce(GetLocalPlayer(), toForce)`. So text actions don't work until
// forces do; this module is a prerequisite for the text subsystem.
//
// blizzard.j itself builds bj_FORCE_ALL_PLAYERS / bj_FORCE_PLAYER[] in
// InitBlizzardGlobals via CreateForce + ForceEnumPlayers/ForceAddPlayer — so once
// these natives exist the presets populate for free when main() runs.

import type { JassPlayer, NativeCtx, Runtime } from "../runtime";
import { asInt, jBool, jHandle, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** A force is just a set of player indices (0–15). */
interface ForceObj {
  handleId: number;
  players: Set<number>;
}

const force = (c: NativeCtx, v: JassValue): ForceObj | undefined => c.rt.data<ForceObj>(v);
const playerIndex = (c: NativeCtx, v: JassValue): number => c.rt.data<JassPlayer>(v)?.index ?? asInt(v);

/** The player slots ForceEnumPlayers should walk. Prefer the slots config()
 *  actually declared (both melee and custom maps declare their players there);
 *  fall back to all 16 for synthetic scripts that never ran config(). Real WC3
 *  also gates on slot-playing state — we don't model that yet, which at worst
 *  over-includes a slot in bj_FORCE_ALL_PLAYERS (harmless for text; noted). */
function enumSlots(rt: Runtime): number[] {
  if (rt.setup.players.size) return [...rt.setup.players.keys()].sort((a, b) => a - b);
  return Array.from({ length: 16 }, (_v, i) => i);
}

/** Run a boolexpr `filter` for player `idx`, exposing it as GetFilterPlayer.
 *  A null filter means "match everything". */
function filterPasses(c: NativeCtx, filterV: JassValue | undefined, idx: number): boolean {
  const be = filterV ? c.rt.data<{ fn: string }>(filterV) : undefined;
  if (!be) return true;
  c.rt.eventStack.push(new Map([["FilterPlayer", c.rt.playerHandle(idx)]]));
  try {
    return truthy(c.call(be.fn, []));
  } finally {
    c.rt.eventStack.pop();
  }
}

export function registerForceNatives(rt: Runtime): void {
  def(rt, "CreateForce", (c) => {
    const f: ForceObj = { handleId: 0, players: new Set() };
    f.handleId = c.rt.handles.alloc(f);
    return jHandle(f.handleId, "force");
  });
  def(rt, "DestroyForce", (c, a) => {
    if (a[0].k === "handle") c.rt.handles.free(a[0].h);
    return JNULL;
  });
  def(rt, "ForceClear", (c, a) => (force(c, a[0])?.players.clear(), JNULL));
  def(rt, "ForceAddPlayer", (c, a) => (force(c, a[0])?.players.add(playerIndex(c, a[1])), JNULL));
  def(rt, "ForceRemovePlayer", (c, a) => (force(c, a[0])?.players.delete(playerIndex(c, a[1])), JNULL));
  def(rt, "IsPlayerInForce", (c, a) => jBool(force(c, a[1])?.players.has(playerIndex(c, a[0])) ?? false));

  // ForceEnumPlayers(force, filter): add every (matching) slot to the force.
  const enumInto = (c: NativeCtx, f: ForceObj | undefined, filter: JassValue | undefined, limit = Infinity): void => {
    if (!f) return;
    let n = 0;
    for (const idx of enumSlots(c.rt)) {
      if (n >= limit) break;
      if (filterPasses(c, filter, idx)) {
        f.players.add(idx);
        n++;
      }
    }
  };
  def(rt, "ForceEnumPlayers", (c, a) => (enumInto(c, force(c, a[0]), a[1]), JNULL));
  def(rt, "ForceEnumPlayersCounted", (c, a) => (enumInto(c, force(c, a[0]), a[1], asInt(a[2])), JNULL));
  // Allies/enemies: approximate from SetPlayerTeam (same team = ally). Good enough
  // for the force-targeted text/message actions; refine with real alliance state later.
  def(rt, "ForceEnumAllies", (c, a) => {
    const f = force(c, a[0]);
    const team = c.rt.data<JassPlayer>(a[1])?.team;
    if (f) for (const idx of enumSlots(c.rt)) if (c.rt.setup.players.get(idx)?.team === team && filterPasses(c, a[2], idx)) f.players.add(idx);
    return JNULL;
  });
  def(rt, "ForceEnumEnemies", (c, a) => {
    const f = force(c, a[0]);
    const team = c.rt.data<JassPlayer>(a[1])?.team;
    if (f) for (const idx of enumSlots(c.rt)) if (c.rt.setup.players.get(idx)?.team !== team && filterPasses(c, a[2], idx)) f.players.add(idx);
    return JNULL;
  });

  // ForForce(force, callback): run `callback` once per player, exposed as
  // GetEnumPlayer (the loop body of every "Player Group - Pick every player" action).
  def(rt, "ForForce", (c, a) => {
    const f = force(c, a[0]);
    if (f && a[1].k === "code") {
      for (const idx of [...f.players].sort((x, y) => x - y)) {
        c.rt.eventStack.push(new Map([["EnumPlayer", c.rt.playerHandle(idx)]]));
        try {
          c.call(a[1].fn, []);
        } catch {
          /* one player's callback throwing must not abort the whole loop */
        } finally {
          c.rt.eventStack.pop();
        }
      }
    }
    return JNULL;
  });

  // Enum/filter responses read by the callbacks above.
  def(rt, "GetEnumPlayer", (c) => c.rt.eventResponse("EnumPlayer"));
  def(rt, "GetFilterPlayer", (c) => c.rt.eventResponse("FilterPlayer"));
}
