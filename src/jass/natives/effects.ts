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

import type { JassPlayer, JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jHandle, jReal, JNULL, type JassValue } from "../values";

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

/** `ANIM_TYPE_*` by its `ConvertAnimType` index (common.j lines 303-313) — the word a model's
 *  sequence names start with ("Stand Second", "Birth"). */
const ANIM_WORDS = ["birth", "death", "decay", "dissipate", "stand", "walk", "attack", "morph", "sleep", "spell", "portrait"];

/** `SUBANIM_TYPE_*` by its `ConvertSubAnimType` index (common.j lines 315-366, starting at
 *  11) — the qualifying word in a sequence name ("Stand SECOND", "Attack SLAM"). The one
 *  that is not its own constant name is ALTERNATE_EX: the world models spell that tag
 *  "Alternate" (see render/unitAnims.ts applyAnimProps — not one of them says AlternateEx). */
const SUBANIM_WORDS: Record<number, string> = Object.fromEntries(
  ("rooted alternate looping slam throw spiked fast spin ready channel defend victory turn left right fire " +
    "flesh hit wounded light moderate severe critical complete gold lumber work talk first second third " +
    "fourth fifth one two three four five small medium large upgrade drain fill chainlightning eattree " +
    "puke flail off swim entangle berserk")
    .split(" ")
    .map((w, i) => [i + 11, w]),
);

/** A 0–255 channel as the BlzSetSpecialEffectColor/Alpha natives take it: "only accepts values
 *  0-255", and "does nothing if any single parameter is invalid or out of range" (jassbot). */
const channel255 = (v: JassValue | undefined): number | null => {
  const n = asInt(v ?? JNULL);
  return n >= 0 && n <= 255 ? n : null;
};

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

  // --- BlzSetSpecialEffect…: the effect's transform and look (docs/map-compatibility.md pass
  // 10). All of them are in the install's own 1.30.4 common.j. Every position is ABSOLUTE —
  // Test of Faith writes `BlzSetSpecialEffectZ(e, BlzGetLocalUnitZ(u) + 150)` — and none of
  // them applies to an effect riding an attachment point (jassbot); the engine ignores those.
  //
  // One place this follows the documented INTENT rather than a version's bug: jassbot notes
  // that in "1.29-??" setting X alone reset Y and Z to where the effect spawned. The maps that
  // call these were written for a client where it works (Test of Faith sets X, then Y, then Z
  // on the same effect every tick), so each setter here moves only its own axis.
  //
  // Not here: BlzSetSpecialEffectTimeScale/Time and BlzPlaySpecialEffectWithTimeScale. Their
  // documentation does not settle whether normal speed is 1.0 or 100.0, and no map in the corpus
  // calls any of them — a guessed scale would be exactly the invented number CLAUDE.md forbids.
  const fx = (c: NativeCtx, v: JassValue | undefined): number | undefined => c.rt.data<EffectObj>(v ?? JNULL)?.engineId;
  const onFx = (name: string, fn: (c: NativeCtx, id: number, a: JassValue[]) => void): void =>
    def(rt, name, (c, a) => {
      const id = fx(c, a[0]);
      if (id !== undefined) fn(c, id, a);
      return JNULL;
    });
  const pos = (c: NativeCtx, id: number, x: number | null, y: number | null, z: number | null) =>
    c.rt.hooks?.setSpecialEffectPosition?.(id, x, y, z);
  onFx("BlzSetSpecialEffectPosition", (c, id, a) => pos(c, id, asNum(a[1]), asNum(a[2]), asNum(a[3])));
  onFx("BlzSetSpecialEffectPositionLoc", (c, id, a) => {
    const l = c.rt.data<{ x: number; y: number }>(a[1]);
    // A location carries no height of its own: the effect goes to the surface there.
    if (l) pos(c, id, l.x, l.y, c.rt.hooks?.surfaceZ?.(l.x, l.y) ?? 0);
  });
  onFx("BlzSetSpecialEffectX", (c, id, a) => pos(c, id, asNum(a[1]), null, null));
  onFx("BlzSetSpecialEffectY", (c, id, a) => pos(c, id, null, asNum(a[1]), null));
  onFx("BlzSetSpecialEffectZ", (c, id, a) => pos(c, id, null, null, asNum(a[1])));
  // "Sets the effect's absolute Z position (height). This native appears to be mostly
  // identical to BlzSetSpecialEffectZ" (jassbot).
  onFx("BlzSetSpecialEffectHeight", (c, id, a) => pos(c, id, null, null, asNum(a[1])));
  const turn = (c: NativeCtx, id: number, yaw: number | null, pitch: number | null, roll: number | null) =>
    c.rt.hooks?.setSpecialEffectOrientation?.(id, yaw, pitch, roll);
  onFx("BlzSetSpecialEffectOrientation", (c, id, a) => turn(c, id, asNum(a[1]), asNum(a[2]), asNum(a[3])));
  onFx("BlzSetSpecialEffectYaw", (c, id, a) => turn(c, id, asNum(a[1]), null, null));
  onFx("BlzSetSpecialEffectPitch", (c, id, a) => turn(c, id, null, asNum(a[1]), null));
  onFx("BlzSetSpecialEffectRoll", (c, id, a) => turn(c, id, null, null, asNum(a[1])));
  onFx("BlzSetSpecialEffectScale", (c, id, a) => c.rt.hooks?.setSpecialEffectScale?.(id, asNum(a[1])));
  onFx("BlzSetSpecialEffectColor", (c, id, a) => {
    const [r, g, b] = [channel255(a[1]), channel255(a[2]), channel255(a[3])];
    if (r !== null && g !== null && b !== null) c.rt.hooks?.setSpecialEffectColor?.(id, r, g, b);
  });
  onFx("BlzSetSpecialEffectAlpha", (c, id, a) => {
    const alpha = channel255(a[1]);
    if (alpha !== null) c.rt.hooks?.setSpecialEffectAlpha?.(id, alpha);
  });
  // "Sets the tinting color to match the specific player's color" — the player's COLOUR,
  // which SetPlayerColor can have moved off their slot.
  onFx("BlzSetSpecialEffectColorByPlayer", (c, id, a) => {
    const p = c.rt.data<JassPlayer>(a[1]);
    if (p) c.rt.hooks?.setSpecialEffectTeamColor?.(id, p.color);
  });

  // --- …its animation: a clip by NAME, qualified by sub-animation tags ---
  onFx("BlzPlaySpecialEffect", (c, id, a) => {
    const word = ANIM_WORDS[c.rt.enumIndex(a[1] ?? JNULL)];
    if (word) c.rt.hooks?.playSpecialEffect?.(id, word);
  });
  const tag = (c: NativeCtx, v: JassValue | undefined) => SUBANIM_WORDS[c.rt.enumIndex(v ?? JNULL)];
  onFx("BlzSpecialEffectAddSubAnimation", (c, id, a) => {
    const t = tag(c, a[1]);
    if (t) c.rt.hooks?.specialEffectSubAnim?.(id, t, true);
  });
  onFx("BlzSpecialEffectRemoveSubAnimation", (c, id, a) => {
    const t = tag(c, a[1]);
    if (t) c.rt.hooks?.specialEffectSubAnim?.(id, t, false);
  });
  onFx("BlzSpecialEffectClearSubAnimations", (c, id) => c.rt.hooks?.specialEffectSubAnim?.(id, null, false));

  // --- …and where it is. "If the effect is attached to something, returns 0.0" (jassbot). ---
  const where = (axis: "x" | "y" | "z") => (c: NativeCtx, a: JassValue[]): JassValue => {
    const id = fx(c, a[0]);
    return jReal(id === undefined ? 0 : c.rt.hooks?.specialEffectPosition?.(id)?.[axis] ?? 0);
  };
  def(rt, "BlzGetLocalSpecialEffectX", where("x"));
  def(rt, "BlzGetLocalSpecialEffectY", where("y"));
  def(rt, "BlzGetLocalSpecialEffectZ", where("z"));

  // BlzGetUnitZ / BlzGetLocalUnitZ — "Alias for BlzGetUnitZ" (jassbot). The surface under the
  // unit plus its occluder height; "Returns 0.0 if unit was removed or is null".
  const unitZ: NativeFn = (c, a) => {
    const u = c.rt.data<JassUnit>(a[0]);
    return jReal(u && u.simId >= 0 ? c.rt.hooks?.unitZ?.(u.simId) ?? 0 : 0);
  };
  def(rt, "BlzGetUnitZ", unitZ);
  def(rt, "BlzGetLocalUnitZ", unitZ);
}
