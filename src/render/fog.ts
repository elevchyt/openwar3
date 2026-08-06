// Linear distance fog for the 3D scenes — the WC3 environment/menu haze (issue: fog
// on the render). Attached to an mdx-m3-viewer scene as `scene.distFog`; the patched
// SD model shaders and the terrain shaders (via the mdx-m3-viewer patch) fade each
// fragment toward `color` between `start` and `end` world units from the camera.
// Distinct from fog-of-war (the `u_fog*` vision mask), which dims by explored state.

export interface DistFog {
  enabled: boolean;
  /** World-space distance from the eye where the haze begins. */
  start: number;
  /** World-space distance where the haze is full (fragment == fog colour). */
  end: number;
  /** Fog colour, rgb in 0..1. */
  color: Float32Array;
}

/** Build a fog config (rgb in 0..1). */
export function makeFog(start: number, end: number, r: number, g: number, b: number): DistFog {
  return { enabled: true, start, end, color: new Float32Array([r, g, b]) };
}

/**
 * How much of a MAP's authored haze we actually lay on — a house call, not a WC3 number.
 *
 * The engine reads the ramp a map states (`SetTerrainFogEx`, or the w3i's own fog block) and the
 * arithmetic under it is now D3D's — the shaders take the fog distance as the view-space DEPTH
 * rather than the straight-line range from the eye, which is what D3D linear fog does with
 * `D3DRS_RANGEFOGENABLE` off (its default, and WC3 never sets it). What is left after that
 * correction is still heavier than we want it: the maps that turn fog on mostly ask for a bright
 * grey (0.502 or 0.784 across the corpus) that lands on ground far darker than itself, so a 15 %
 * blend triples the brightness of a night tile and flattens its texture with it. Extreme Candy
 * War is the extreme case — it locks the clock at 23:59, so every frame is the dark end.
 *
 * So: keep every map's ramp SHAPE and scale how far along it we go. Same start, a proportionally
 * longer run to full — which is exactly `haze × STRENGTH` at every distance inside the original
 * ramp, and nothing renders beyond it (a map's fog end sits at the camera's own FarZ, 5000).
 *
 * MAP fog only. The glue screens carry hand-tuned fog of their own (`menuScene.ts` — baked
 * against reference shots, see the campaign/menu backdrop work) and must not be re-graded by a
 * knob meant for gameplay.
 */
const MAP_FOG_STRENGTH = 0.65;

/** A map's own environment haze, at the strength we render maps with (`MAP_FOG_STRENGTH`). */
export function makeMapFog(start: number, end: number, r: number, g: number, b: number): DistFog {
  return makeFog(start, start + (end - start) / MAP_FOG_STRENGTH, r, g, b);
}
