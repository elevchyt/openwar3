// Special effects — the trigger puts a MODEL in the world (Phase 7 — issue #33, #68;
// see docs/triggers.md §7.26).
//
// common.j's "Effects API" (lines 2295-2318) is two families under one `effect` handle.
// This file implements the special-effect half:
//
//     native AddSpecialEffect       takes string modelName, real x, real y returns effect
//     native AddSpecialEffectLoc    takes string modelName, location where returns effect
//     native AddSpecialEffectTarget takes string modelName, widget targetWidget, string attachPointName returns effect
//     native DestroyEffect          takes effect whichEffect returns nothing
//
// The whole family was UNIMPLEMENTED, and that is the systemic reason behind issue #68:
// there was no path at all from a trigger to a model in the world, so every one of these
// calls fell back to the interpreter's typed default (a null `effect`) and the map ran on,
// quietly missing its art. (4)WarChasers' own "Spawn One Monster" is the reported case —
//
//     call AddSpecialEffectTargetUnitBJ( "origin", GetLastCreatedUnit(), "Abilities\Spells\Undead\AnimateDead\AnimateDeadTarget.mdl" )
//
// — but it is far from alone: 11 of the 165 corpus maps call this family, ~200 call sites
// between them (Skibi's Castle TD and ExtremeCandyWar are built out of it), and the
// coverage tool undercounts it because most maps reach it through the BJ layer.
//
// Nothing here is a BJ: blizzard.j's AddSpecialEffectLocBJ / AddSpecialEffectTargetUnitBJ /
// DestroyEffectBJ are plain JASS over these four natives (they only add the
// `bj_lastCreatedEffect` bookkeeping GetLastCreatedEffectBJ reads back), so implementing
// the natives lights up the BJ layer for free — which is how WarChasers reaches it.
//
// An `effect` is PERSISTENT, and that is what separates it from the fire-and-forget spell
// art the sim already spawns: the model plays Birth, settles into a looping Stand, and
// stays until DestroyEffect plays its Death clip. A map leans on that — WormWar keeps a
// SoulBurn buff model on a worm's head for as long as it is eating, AzeroGrandPrix parks a
// TalkToMe over a cart until it turns around. So the lifetime is the SCRIPT's, not a TTL.

import type { JassUnit, NativeCtx, Runtime } from "../runtime";
import { asNum, asStr, jHandle, JNULL, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** An `effect` handle — the engine's id for the model it put in the world. */
interface EffectObj {
  handleId: number;
  engineId: number;
}

/** WC3 names an attachment point as a comma-list of TOKENS ("origin", "overhead",
 *  "hand,left", "chest,mount,left") — the same spelling the ability data's `Targetattach`
 *  uses, and the renderer matches them against the model's own "<Tokens…> Ref" nodes the
 *  same way (see MapViewerScene.attachmentNode). An empty name means the model's root. */
const attachTokens = (name: string): string[] =>
  name.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);

/** Mint the `effect` handle for an engine id. A negative id means the engine refused it —
 *  or there is no engine at all (headless): hand back a null handle, and DestroyEffect on
 *  it is a no-op, so the map runs on either way (CLAUDE.md: never hard-crash the map). */
function effectHandle(ctx: NativeCtx, engineId: number): JassValue {
  if (engineId < 0) return JNULL;
  const e: EffectObj = { handleId: 0, engineId };
  e.handleId = ctx.rt.handles.alloc(e);
  return jHandle(e.handleId, "effect");
}

export function registerEffectNatives(rt: Runtime): void {
  def(rt, "AddSpecialEffect", (c, a) =>
    effectHandle(c, c.rt.hooks?.addSpecialEffect?.(asStr(a[0]), asNum(a[1]), asNum(a[2])) ?? -1),
  );
  def(rt, "AddSpecialEffectLoc", (c, a) => {
    const loc = c.rt.data<{ x: number; y: number }>(a[1]);
    if (!loc) return JNULL; // a null location — the BJ layer hands these over unchecked
    return effectHandle(c, c.rt.hooks?.addSpecialEffect?.(asStr(a[0]), loc.x, loc.y) ?? -1);
  });
  // The widget is a UNIT in every one of the ~200 corpus call sites (common.j types the
  // parameter as `widget` because an item or a destructable would be legal, but blizzard.j
  // itself has AddSpecialEffectTargetDestructableBJ/…ItemBJ COMMENTED OUT, and no map
  // reaches for either). Anything that isn't a unit we hold gets a null handle.
  def(rt, "AddSpecialEffectTarget", (c, a) => {
    const u = c.rt.data<JassUnit>(a[1]);
    if (!u || u.simId < 0) return JNULL;
    return effectHandle(c, c.rt.hooks?.addSpecialEffectTarget?.(asStr(a[0]), u.simId, attachTokens(asStr(a[2]))) ?? -1);
  });
  def(rt, "DestroyEffect", (c, a) => {
    const e = c.rt.data<EffectObj>(a[0]);
    if (!e) return JNULL; // destroying a null effect is legal JASS and common in the corpus
    c.rt.hooks?.destroyEffect?.(e.engineId);
    c.rt.handles.free(e.handleId);
    return JNULL;
  });
}
