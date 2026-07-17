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
  /** The .doo flags byte, decoded. WC3 stores a base state (0 = invisible & non-solid,
   *  1 = visible & non-solid, 2 = visible & solid) plus +4 for "fixed Z". Only a *solid*
   *  doodad blocks pathing — a mapmaker who unticks "Solid" on a gate/prop wants units to
   *  walk through it, so its pathTex must NOT be stamped (verified format: base value 2 is
   *  the only solid one; WC3MapTranslator DoodadFlag). */
  solid: boolean;
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
    // Base state lives in the low bits (fixed-Z is +4); "visible & solid" is base 2, so a
    // set 0x2 bit is exactly the solid ones. Every tree/rock a melee map places has it;
    // the gates & Force Walls WarChasers leaves open do not.
    solid: (d.flags & 0x2) !== 0,
  }));
}
