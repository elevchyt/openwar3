/**
 * Script-placed fog-of-war types (7.22).
 *
 * These were declared in `rts.ts`, which was fine until `viewpoint.ts` needed them too —
 * and `rts.ts` imports `viewpoint.ts`, so leaving them there would have been a cycle. They
 * are plain data with no owner, so they get their own module rather than a direction.
 */

/** Where a fog modifier applies. common.j offers both shapes and they are not
 *  interchangeable: `CreateFogModifierRect` takes a rect, `CreateFogModifierRadius[Loc]`
 *  a centre + radius. */
export type FogArea =
  | { kind: "rect"; minX: number; minY: number; maxX: number; maxY: number }
  | { kind: "circle"; x: number; y: number; radius: number };

/** A script-placed fog-of-war modifier: hold `area` at `state` for `player`, while
 *  `running`. `state` is the raw common.j fogstate (1 MASKED / 2 FOGGED / 4 VISIBLE). */
export interface FogModifier {
  player: number;
  state: number;
  area: FogArea;
  /** The natives' last argument, and not a render detail: whether the modifier is laid
   *  AFTER the units' own sight (and so overrides it) or BEFORE it (and the units still see
   *  through it). Every BJ passes `false` — `CreateFogModifierRectBJ`, `…RadiusLocBJ` — so a
   *  GUI modifier is a floor under unit vision, never a lid over it. (4)Monolith marks each
   *  Monolith with a FOGGED one at 0:45 to show where it is; laid over unit sight, it blinded
   *  every army standing beside a Monolith, which could then never be auto-acquired or
   *  attack-moved onto, and no computer ever damaged one. */
  afterUnits: boolean;
  running: boolean;
}
