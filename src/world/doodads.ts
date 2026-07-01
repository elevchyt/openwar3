import doo from "mdx-m3-viewer/dist/cjs/parsers/w3x/doo";

// war3map.doo → placed doodads/destructibles (plan §4, Phase 2). Rendered as
// placeholder primitives until the MDX pipeline lands (Phase 3).

export interface DoodadInstance {
  id: string; // object id, e.g. "ATtr" — resolved to a model in Phase 3/4
  x: number;
  y: number;
  z: number; // editor-placed world height
  angle: number; // radians
  scale: [number, number, number];
}

/**
 * Parse war3map.doo. buildVersion comes from war3map.w3i (gates post-1.32
 * fields) — pass what the map's w3i reports, mirroring the reference handler.
 */
export function parseDoo(bytes: Uint8Array, buildVersion: number): DoodadInstance[] {
  const file = new doo.File();
  file.load(bytes, buildVersion);
  return file.doodads.map((d) => ({
    id: d.id,
    x: d.location[0],
    y: d.location[1],
    z: d.location[2],
    angle: d.angle,
    scale: [d.scale[0], d.scale[1], d.scale[2]],
  }));
}
