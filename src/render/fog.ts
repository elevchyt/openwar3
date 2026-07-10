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
