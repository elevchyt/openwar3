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
  /** Life as a PERCENT of the type's HP (the .doo stores it that way). 100 for everything the
   *  editor places normally; 0 for one placed DEAD — the stock dungeon gates that start open. */
  life: number;
  /** The .doo flags byte's 0x2 bit is CLEAR — the World Editor moved this doodad into
   *  `war3map.j` and the live one is made by `CreateDestructable`/`CreateDestructableZ`
   *  (that is exactly what a `gg_dest_*` trigger variable is). The record left behind is
   *  the editor's placeholder, which is why the byte reads as the "invisible & non-solid"
   *  state the format docs describe.
   *
   *  Measured against the real 1.27a maps: on WarChasers all 31 records without the bit
   *  are created by its script, position for position, and all 800 with it are not — and
   *  those 31 are the ONLY records missing the bit in the whole stock map set. So a clear
   *  bit never means "the mapmaker wanted units to walk through here": the doodad is still
   *  standing at runtime, solid, with its collider. We keep drawing (and now colliding) the
   *  record itself rather than hiding it and waiting on the script, so a gate is a gate
   *  even on a map whose triggers we don't run. */
  scriptCreated: boolean;
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
    life: d.life,
    // The byte is a bitfield, not the 0/1/2 enum the format docs imply: stock maps carry
    // 0, 2, 3, 4, 6 and 7, with 0x2 set on 99.96% of records (every tree, rock and wall).
    // 0x1 and 0x4 vary freely on ordinary trees, so 0x2 alone is the meaningful bit.
    scriptCreated: (d.flags & 0x2) === 0,
  }));
}
