// Destructable natives (Phase 7 — issue #85; see docs/triggers.md).
//
// The trigger surface for the map's destructibles: gates, doors, cage bars, the walls a
// lever drops. Signatures are taken from the real `Scripts\common.j` (1.27a).
//
// **The whole point is that a gate OPENS by DYING.** `blizzard.j`'s `ModifyGateBJ` — which
// is what the GUI's "Destructible - Open/Close gate" action compiles to, and what every one
// of WarChasers' twenty gates is driven by — spells it out:
//
//     OPEN    → KillDestructable(d)              + SetDestructableAnimation(d, "death alternate")
//     CLOSE   → DestructableRestoreLife(d, max, true) + …"stand"
//     DESTROY → KillDestructable(d)              + …"death"
//
// So there is no "gate" native to write: implement life and the animation and the whole GUI
// gate vocabulary lights up, because ModifyGateBJ is blizzard.j code we already interpret.
// The engine side moves the collider with the life — a dead gate wears its `pathTexDeath`,
// which blocks the two posts and leaves the middle walkable.
//
// `CreateDestructable` does NOT create a second gate. The World Editor moves any doodad a
// trigger names out of war3map.doo and into war3map.j (that is what a `gg_dest_*` variable
// is), leaving the .doo record behind as a placeholder — which we already drew and stamped.
// So the native ADOPTS the record standing at those coordinates. Verified on WarChasers: all
// 31 of its script-created records match a .doo record position for position.

import { intToRawcode, rawcodeToInt } from "../lexer";
import type { BoolExpr, DestructableSnapshot, NativeCtx, RectObj, Runtime } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, JNULL, jReal, jStr, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** A `destructable` handle: the map's own id for the record (its war3map.doo index), plus the
 *  last-known facts a headless run with no engine attached still has to answer from. */
export interface JassDestructable {
  handleId: number;
  mapId: number; // 0 = no record was found (a script placing a brand-new destructible)
  typeId: string;
  x: number;
  y: number;
  life: number;
  maxLife: number;
  invulnerable?: boolean;
}

const dest = (c: NativeCtx, v: JassValue): JassDestructable | undefined => c.rt.data<JassDestructable>(v);

/** The record's LIVE state, or null when there is no engine (headless) or it is gone. */
const info = (c: NativeCtx, d: JassDestructable | undefined): DestructableSnapshot | null =>
  d && d.mapId > 0 ? c.rt.hooks?.destructableInfo?.(d.mapId) ?? null : null;

/** One handle per map record, interned per runtime — so the `gg_dest_*` a map sets in main(),
 *  the handle `EnumDestructablesInRect` hands a filter, and the one a later `ModifyGateBJ`
 *  operates on are all the same object, and JASS `==` between them is true. */
const interned = new WeakMap<Runtime, Map<number, JassDestructable>>();

function handleFor(c: NativeCtx, mapId: number, fallback: Omit<JassDestructable, "handleId">): JassValue {
  let byMapId = interned.get(c.rt);
  if (!byMapId) interned.set(c.rt, (byMapId = new Map()));
  const existing = mapId > 0 ? byMapId.get(mapId) : undefined;
  if (existing) return jHandle(existing.handleId, "destructable");
  const d: JassDestructable = { handleId: 0, ...fallback, mapId };
  d.handleId = c.rt.handles.alloc(d);
  if (mapId > 0) byMapId.set(mapId, d);
  return jHandle(d.handleId, "destructable");
}

export function registerDestructableNatives(rt: Runtime): void {
  // --- create / remove ------------------------------------------------------
  const create = (c: NativeCtx, typeInt: number, x: number, y: number, dead: boolean): JassValue => {
    const typeId = intToRawcode(typeInt);
    const found = c.rt.hooks?.findDestructable?.(typeId, x, y) ?? 0;
    const snap = found > 0 ? c.rt.hooks?.destructableInfo?.(found) ?? null : null;
    // CreateDeadDestructable places one already destroyed — an arch that starts collapsed.
    if (dead && found > 0) c.rt.hooks?.killDestructable?.(found, "death");
    return handleFor(c, found, {
      mapId: found,
      typeId,
      x: snap?.x ?? x,
      y: snap?.y ?? y,
      life: dead ? 0 : snap?.life ?? 1,
      maxLife: snap?.maxLife ?? 0,
    });
  };
  def(rt, "CreateDestructable", (c, a) => create(c, asInt(a[0]), asNum(a[1]), asNum(a[2]), false));
  def(rt, "CreateDestructableZ", (c, a) => create(c, asInt(a[0]), asNum(a[1]), asNum(a[2]), false));
  def(rt, "CreateDeadDestructable", (c, a) => create(c, asInt(a[0]), asNum(a[1]), asNum(a[2]), true));
  def(rt, "CreateDeadDestructableZ", (c, a) => create(c, asInt(a[0]), asNum(a[1]), asNum(a[2]), true));
  def(rt, "RemoveDestructable", (c, a) => {
    const d = dest(c, a[0]);
    if (d) {
      d.life = 0;
      if (d.mapId > 0) c.rt.hooks?.removeDestructable?.(d.mapId);
    }
    return JNULL;
  });

  // --- life: the gate's open/closed state -----------------------------------
  // Invulnerability does NOT stop this. It blocks DAMAGE — which is exactly why a mapmaker
  // sets it on a gate: the players must not be able to smash their way through, only the
  // lever may open it. WarChasers does this to all eighteen of its gates and then opens every
  // one with ModifyGateBJ, so a KillDestructable that respected the flag would weld the map
  // shut at the first door.
  def(rt, "KillDestructable", (c, a) => {
    const d = dest(c, a[0]);
    if (d) {
      d.life = 0;
      if (d.mapId > 0) c.rt.hooks?.killDestructable?.(d.mapId, "death");
    }
    return JNULL;
  });
  def(rt, "DestructableRestoreLife", (c, a) => {
    const d = dest(c, a[0]);
    if (d) {
      d.life = asNum(a[1]);
      if (d.mapId > 0) c.rt.hooks?.restoreDestructable?.(d.mapId, asNum(a[1]), truthy(a[2]));
    }
    return JNULL;
  });
  def(rt, "SetDestructableLife", (c, a) => {
    const d = dest(c, a[0]);
    if (d) {
      d.life = asNum(a[1]);
      if (d.mapId > 0) c.rt.hooks?.setDestructableLife?.(d.mapId, asNum(a[1]));
    }
    return JNULL;
  });
  def(rt, "GetDestructableLife", (c, a) => {
    const d = dest(c, a[0]);
    return jReal(info(c, d)?.life ?? d?.life ?? 0);
  });
  def(rt, "SetDestructableMaxLife", (c, a) => {
    const d = dest(c, a[0]);
    if (d) d.maxLife = asNum(a[1]);
    return JNULL;
  });
  def(rt, "GetDestructableMaxLife", (c, a) => {
    const d = dest(c, a[0]);
    return jReal(info(c, d)?.maxLife ?? d?.maxLife ?? 0);
  });
  def(rt, "SetDestructableInvulnerable", (c, a) => {
    const d = dest(c, a[0]);
    if (d) d.invulnerable = truthy(a[1]);
    return JNULL;
  });
  def(rt, "IsDestructableInvulnerable", (c, a) => jBool(!!dest(c, a[0])?.invulnerable));

  // --- animation: cosmetic. The collider follows LIFE, never the clip name ---
  const animate = (c: NativeCtx, v: JassValue, name: string): JassValue => {
    const d = dest(c, v);
    if (d && d.mapId > 0) c.rt.hooks?.setDestructableAnimation?.(d.mapId, name);
    return JNULL;
  };
  def(rt, "SetDestructableAnimation", (c, a) => animate(c, a[0], asStr(a[1])));
  def(rt, "QueueDestructableAnimation", (c, a) => animate(c, a[0], asStr(a[1])));
  def(rt, "SetDestructableAnimationSpeed", () => JNULL);
  def(rt, "ShowDestructable", (c, a) => {
    const d = dest(c, a[0]);
    if (d && d.mapId > 0) c.rt.hooks?.showDestructable?.(d.mapId, truthy(a[1]));
    return JNULL;
  });
  // Occluder height is the "how tall is this for line-of-sight" knob a gate toggles with its
  // state. We have no per-destructible LOS blocker, so it is accepted and reported back.
  def(rt, "SetDestructableOccluderHeight", () => JNULL);
  def(rt, "GetDestructableOccluderHeight", () => jReal(0));

  // --- identity -------------------------------------------------------------
  def(rt, "GetDestructableTypeId", (c, a) => jInt(rawcodeToInt(dest(c, a[0])?.typeId ?? "\0\0\0\0")));
  def(rt, "GetDestructableX", (c, a) => {
    const d = dest(c, a[0]);
    return jReal(info(c, d)?.x ?? d?.x ?? 0);
  });
  def(rt, "GetDestructableY", (c, a) => {
    const d = dest(c, a[0]);
    return jReal(info(c, d)?.y ?? d?.y ?? 0);
  });
  def(rt, "GetDestructableName", (c, a) => jStr(info(c, dest(c, a[0]))?.name ?? ""));

  // --- enumeration ----------------------------------------------------------
  // EnumDestructablesInRect(r, filter, action): the action runs once per match, with the
  // record exposed as GetEnumDestructable — the same shape ForGroup/GroupEnum* use, so the
  // event stack carries it rather than a field. Blizzard's own "Pick every destructible in
  // region" (EnumDestructablesInRectAllBJ) is that native with a null filter.
  def(rt, "EnumDestructablesInRect", (c, a) => {
    const r = c.rt.data<RectObj>(a[0]);
    const list = r ? c.rt.hooks?.enumDestructables?.(r.minx, r.miny, r.maxx, r.maxy) ?? [] : [];
    for (const snap of list) {
      const h = handleFor(c, snap.id, { mapId: snap.id, typeId: snap.typeId, x: snap.x, y: snap.y, life: snap.life, maxLife: snap.maxLife });
      const be = a[1] ? c.rt.data<BoolExpr>(a[1]) : undefined;
      c.rt.eventStack.push(new Map([["FilterDestructable", h], ["EnumDestructable", h]]));
      try {
        if (be?.fn && !truthy(c.call(be.fn, []))) continue;
        if (a[2]?.k === "code") c.call(a[2].fn, []);
      } catch {
        /* one match's callback throwing must not abort the whole scan */
      } finally {
        c.rt.eventStack.pop();
      }
    }
    return JNULL;
  });
  def(rt, "GetEnumDestructable", (c) => c.rt.eventResponse("EnumDestructable"));
  def(rt, "GetFilterDestructable", (c) => c.rt.eventResponse("FilterDestructable"));
}
