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
  /** Draw the way the real client does: an Unfogged layer and every additive one take no fog, and
   *  blended particles do. Off, additive layers fade to black and particles are never fogged. */
  honourFlags?: boolean;
}

/** Build a fog config (rgb in 0..1). */
export function makeFog(start: number, end: number, r: number, g: number, b: number): DistFog {
  return { enabled: true, start, end, color: new Float32Array([r, g, b]) };
}

/**
 * A map's fog as a camera zoomed out past the real client's distance should see it.
 *
 * The real client opens on bj_CAMERA_DEFAULT_DISTANCE (1650) and has no wheel to leave it. Bandit
 * Ridge's ramp starts at 2000, so through the 32° lens it only just reaches the top of the screen:
 * measured on 1.30.4, grass is (26,98,23) at the top and the bottom alike. We open at 2400
 * (docs/camera.md), which puts every piece of ground in view past that same 2000, and a stock melee
 * map drew grey over all of it: (48,108,46) at the top, bleaching the colours.
 *
 * Scaling the ramp by the distance keeps every row of the screen on the fog value it has at 1650,
 * since depth along the view axis scales with the camera's distance. So a zoom out shows more of
 * the world in the light the real client shows it, and no haze the real client cannot show. The
 * result is one shared object, reused per frame, because this runs every frame.
 */
const zoomed: DistFog = { enabled: true, start: 0, end: 0, color: new Float32Array(3) };
export function fogForZoom(fog: DistFog, distance: number, defaultDistance: number): DistFog {
  if (distance <= defaultDistance) return fog;
  const scale = distance / defaultDistance;
  zoomed.start = fog.start * scale;
  zoomed.end = fog.end * scale;
  zoomed.color = fog.color;
  zoomed.honourFlags = fog.honourFlags;
  return zoomed;
}
