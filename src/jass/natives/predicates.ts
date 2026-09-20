// The PREDICATES a custom map gates on (docs/map-compatibility.md pass 4).
//
// Twenty-odd `Is…` natives, and together they are the largest single family a later-format map
// calls that we had no answer for — ~1200 call sites across the eleven maps in the install's own
// `Maps\Download`. They matter more than their size suggests because they are all CONDITIONS: an
// unimplemented native returns a typed default, and the typed default of a boolean is FALSE, so
// an unanswered predicate does not degrade a map's behaviour — it inverts it. DotA gates most of
// its targeting on `IsUnitVisible`, and with no answer every one of those 153 calls says "no
// eyes on it", which is an AoS whose spells believe nothing is ever in sight.
//
// Three of them carry a trap worth reading before touching this file:
//
//   * `IsUnitInRange` is measured to the COLLISION, not centre to centre (SimWorld.unitInRange).
//   * `IsTerrainPathable` returns TRUE when the terrain is NOT pathable — the install says so
//     in as many words, see below.
//   * `IsUnitVisible` is eyes-on-it-NOW, which is a different question from whether the unit's
//     model is drawn (VisionSet.unitVisibleTo explains why they must not be the same test).

import { intToRawcode } from "../lexer";
import type { JassPlayer, JassUnit, NativeCtx, RectObj, RegionObj, Runtime } from "../runtime";
import { asInt, asNum, jBool, jHandle, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const simOf = (c: NativeCtx, v: JassValue): number | undefined => {
  const u = c.rt.data<JassUnit>(v);
  return u && u.simId >= 0 ? u.simId : undefined;
};
const unit = (c: NativeCtx, v: JassValue): JassUnit | undefined => c.rt.data<JassUnit>(v);
/** The slot behind a `player` handle — the same one-liner every natives file uses. */
const playerIndex = (c: NativeCtx, v: JassValue): number => c.rt.data<JassPlayer>(v)?.index ?? asInt(v);
/** A `force` is a script object (natives/forces.ts) and its shape is all this file needs. */
interface ForceLike { players: Set<number> }
const loc = (c: NativeCtx, v: JassValue): { x: number; y: number } | undefined =>
  c.rt.data<{ x: number; y: number }>(v);

/** `UNIT_TYPE_HERO` — common.j's `ConvertUnitType(0)`. `IsHeroUnitId` asks the type table the
 *  same question `IsUnitType(u, UNIT_TYPE_HERO)` asks an instance, so it goes through the
 *  classification hook that already exists rather than growing one of its own. */
const UNIT_TYPE_HERO = 0;

/** common.j's `pathingtype` indices (290–297). Only the three our grid actually carries a bit
 *  for are answered; the rest say so once rather than inventing a "no". */
const PATHING_WALKABILITY = 1;
const PATHING_FLYABILITY = 2;
const PATHING_BUILDABILITY = 3;

export function registerPredicateNatives(rt: Runtime): void {
  // --- identity and ownership ---
  // `IsUnit(a, b)` is handle identity, and it exists because JASS `==` on two `unit` variables
  // is the same test — a map uses the native where a BJ wants a function reference.
  def(rt, "IsUnit", (c, a) => {
    const x = unit(c, a[0]);
    const y = unit(c, a[1]);
    return jBool(!!x && !!y && x.handleId === y.handleId);
  });
  def(rt, "IsUnitOwnedByPlayer", (c, a) => {
    const u = unit(c, a[0]);
    return jBool(!!u && u.player === playerIndex(c, a[1]));
  });
  def(rt, "IsUnitInForce", (c, a) => {
    const u = unit(c, a[0]);
    const f = c.rt.data<ForceLike>(a[1]);
    return jBool(!!u && !!f && f.players.has(u.player));
  });
  // `IsUnitRace(u, RACE_HUMAN)` — the unit's own race column, matched against the `race`
  // constant's index. The names are `UnitData.slk`'s own spellings, which is what the bridge
  // hands back, so the mapping lives here rather than being re-spelled in the sim.
  const RACES = ["", "human", "orc", "undead", "nightelf", "demon", "other", "creep"];
  def(rt, "IsUnitRace", (c, a) => {
    const id = simOf(c, a[0]);
    if (id === undefined) return jBool(false);
    return jBool((c.rt.hooks?.unitRace?.(id) ?? "") === (RACES[c.rt.enumIndex(a[1])] ?? ""));
  });
  def(rt, "IsHeroUnitId", (c, a) =>
    jBool(c.rt.hooks?.isUnitIdType?.(intToRawcode(asInt(a[0])), UNIT_TYPE_HERO) ?? false));
  // An ILLUSION is a copy the enemy is not meant to be able to tell from the original
  // (docs/illusions.md), which is exactly why a map asks: its own damage triggers must not
  // credit one. 275 call sites, all DotA's.
  def(rt, "IsUnitIllusion", (c, a) => {
    const id = simOf(c, a[0]);
    return jBool(id === undefined ? false : c.rt.hooks?.isUnitIllusion?.(id) ?? false);
  });
  def(rt, "IsUnitSelected", (c, a) => {
    const id = simOf(c, a[0]);
    if (id === undefined) return jBool(false);
    return jBool((c.rt.hooks?.selectedUnits?.(playerIndex(c, a[1])) ?? []).includes(id));
  });

  // --- range ---
  // Measured to the COLLISION rather than centre to centre — see SimWorld.unitInRange. All
  // three spellings are one question; only how the far end is named differs.
  def(rt, "IsUnitInRange", (c, a) => {
    const id = simOf(c, a[0]);
    const other = simOf(c, a[1]);
    if (id === undefined || other === undefined) return jBool(false);
    return jBool(c.rt.hooks?.isUnitInRange?.(id, other, asNum(a[2])) ?? false);
  });
  const inRangeXY = (c: NativeCtx, unitV: JassValue, x: number, y: number, d: number): JassValue => {
    const id = simOf(c, unitV);
    return jBool(id === undefined ? false : c.rt.hooks?.isUnitInRangeXY?.(id, x, y, d) ?? false);
  };
  def(rt, "IsUnitInRangeXY", (c, a) => inRangeXY(c, a[0], asNum(a[1]), asNum(a[2]), asNum(a[3])));
  def(rt, "IsUnitInRangeLoc", (c, a) => {
    const p = loc(c, a[1]);
    return inRangeXY(c, a[0], p?.x ?? 0, p?.y ?? 0, asNum(a[2]));
  });

  // --- what a player can see ---
  // Five questions about a unit, three about a point, and they are genuinely five questions
  // rather than one — see VisionSet for what each one means. Each answers from the very
  // viewpoint the renderer draws from, so a script cannot be told something the player is not.
  const unitVision = (name: string, ask: (h: NonNullable<Runtime["hooks"]>, id: number, p: number) => boolean | undefined): void => {
    def(rt, name, (c, a) => {
      const id = simOf(c, a[0]);
      const hooks = c.rt.hooks;
      if (id === undefined || !hooks) return jBool(false);
      return jBool(ask(hooks, id, playerIndex(c, a[1])) ?? false);
    });
  };
  unitVision("IsUnitVisible", (h, id, p) => h.isUnitVisibleTo?.(id, p));
  unitVision("IsUnitFogged", (h, id, p) => h.isUnitFoggedTo?.(id, p));
  unitVision("IsUnitMasked", (h, id, p) => h.isUnitMaskedTo?.(id, p));
  unitVision("IsUnitInvisible", (h, id, p) => h.isUnitInvisibleTo?.(id, p));
  unitVision("IsUnitDetected", (h, id, p) => h.isUnitDetectedTo?.(id, p));
  const pointVision = (name: string, ask: (h: NonNullable<Runtime["hooks"]>, p: number, x: number, y: number) => boolean | undefined): void => {
    def(rt, name, (c, a) => {
      const p = loc(c, a[0]);
      const hooks = c.rt.hooks;
      if (!p || !hooks) return jBool(false);
      return jBool(ask(hooks, playerIndex(c, a[1]), p.x, p.y) ?? false);
    });
  };
  pointVision("IsLocationVisibleToPlayer", (h, p, x, y) => h.isPointVisibleTo?.(p, x, y));
  pointVision("IsLocationFoggedToPlayer", (h, p, x, y) => h.isPointFoggedTo?.(p, x, y));
  pointVision("IsLocationMaskedToPlayer", (h, p, x, y) => h.isPointMaskedTo?.(p, x, y));

  // --- regions ---
  // Pure geometry against the rects a region is made of, so there is no hook: a region is a
  // script object (RegionObj) and its rects are script objects, and the engine never held
  // either. A region is a UNION — `RegionAddRect` can be called any number of times — so the
  // test is "inside any one of them".
  const inRegion = (c: NativeCtx, regionV: JassValue, x: number, y: number): boolean => {
    const reg = c.rt.data<RegionObj>(regionV);
    if (!reg) return false;
    for (const id of reg.rects) {
      const r = c.rt.handles.get(id) as RectObj | undefined;
      if (r && x >= r.minx && x <= r.maxx && y >= r.miny && y <= r.maxy) return true;
    }
    return false;
  };
  def(rt, "IsPointInRegion", (c, a) => jBool(inRegion(c, a[0], asNum(a[1]), asNum(a[2]))));
  def(rt, "IsUnitInRegion", (c, a) => {
    const id = simOf(c, a[1]);
    if (id === undefined) return jBool(false);
    return jBool(inRegion(c, a[0], c.rt.hooks?.getUnitX?.(id) ?? 0, c.rt.hooks?.getUnitY?.(id) ?? 0));
  });
  def(rt, "IsUnitInRegionXY", (c, a) => jBool(inRegion(c, a[0], asNum(a[2]), asNum(a[3]))));

  // --- terrain ---
  //
  // **`IsTerrainPathable` returns TRUE when the terrain is NOT pathable.** Its name says the
  // opposite and this is not community lore — the install states it. `UI\TriggerStrings.txt`
  // names the BJ that wraps it "Terrain Pathing Is Off" and spells the rule out in its hint:
  //
  //     IsTerrainPathableBJHint="Terrain pathing is off if it is not pathable to the given
  //     pathing type.  For example, 'Buildability' is off if the pathing cell is unbuildable."
  //
  // Read it the way its name reads and every "can I put something here" check in a custom map
  // answers backwards, which is worse than answering nothing.
  def(rt, "IsTerrainPathable", (c, a) => {
    const type = c.rt.enumIndex(a[2]);
    if (type !== PATHING_WALKABILITY && type !== PATHING_FLYABILITY && type !== PATHING_BUILDABILITY) {
      // Amphibious / blight / peon-harvest / floatability / ANY have no bit of their own in our
      // grid. Say so once; do not answer "pathable" for a question we did not ask the ground.
      c.rt.warnOnce(`IsTerrainPathable:${type}`, "this pathing type has no bit in our grid — reported pathable");
      return jBool(false);
    }
    return jBool(c.rt.hooks?.isTerrainPathable?.(asNum(a[0]), asNum(a[1]), type) ?? false);
  });

  // --- the world rect ---
  // The OUTER of the three rects a map states (docs/unplayable-area.md): the whole terrain
  // grid, black border and all — not the playable area and not the camera bounds, which are
  // 512/256 inside it and inside each other. A map uses it to clamp its own arithmetic, so
  // handing it the playable rect by mistake shrinks whatever it was clamping.
  def(rt, "GetWorldBounds", (c) => {
    const b = c.rt.hooks?.worldBounds?.() ?? { minx: 0, miny: 0, maxx: 0, maxy: 0 };
    const r: RectObj = { handleId: 0, minx: b.minx, miny: b.miny, maxx: b.maxx, maxy: b.maxy };
    r.handleId = c.rt.handles.alloc(r);
    return jHandle(r.handleId, "rect");
  });
}
