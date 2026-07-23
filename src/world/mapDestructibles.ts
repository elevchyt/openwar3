import type { DoodadInstance } from "./doodads";

// The map's DESTRUCTIBLES — the subset of war3map.doo that has a row in
// `Units\DestructableData.slk`: trees, rocks, walls, bridges, and the gates a trigger opens.
// (The rest of the .doo is scenery from `Doodads\Doodads.slk`, which has no life and cannot
// be killed.) Kept as a flat list in .doo order, because that order IS a destructible's only
// stable identity — the same rule the pre-placed units follow (see RtsController.setPlacedOrder).
//
// **A gate opens by DYING.** WC3 has no separate "open" state: `blizzard.j`'s `ModifyGateBJ`
// spells it out — OPEN is `KillDestructable` + the "death alternate" clip, CLOSE is
// `DestructableRestoreLife` + "stand", DESTROY is the kill with the ordinary "death" clip. So
// the collider follows the life, and a dead destructible swaps to its `pathTexDeath`: a gate's
// `Gate1PathDeath.tga` blocks only the two posts and leaves the middle walkable, which is
// exactly what an open gate looks like to a unit walking through it.
//
// A record placed with `life` 0 in the editor starts dead — the stock maps do this (every
// `DTg3` in the corpus is a dungeon gate placed already open).

export interface MapDestructible {
  /** 1-based index in war3map.doo — the map's own ordering, and the handle a script gets. */
  id: number;
  typeId: string;
  x: number;
  y: number;
  z: number;
  angle: number; // radians; the pathing footprint turns with it
  /** Max life from `DestructableData.HP`. The .doo carries a PERCENTAGE, which is why the
   *  record's own byte can't be used as a life value directly. */
  maxLife: number;
  life: number;
  pathTex: string;
  /** `pathTexDeath` — the footprint once it is killed. Empty when the type has none (a felled
   *  tree, a smashed crate: nothing is left to walk around). */
  pathTexDeath: string;
  /** `targType == "tree"` — harvestable, and felled by the SIM rather than by a script. */
  isTree: boolean;
  /** The SLK's `Name` — usually a `WESTRING_*` key into `UI\WorldEditStrings.txt`, resolved
   *  by the caller (GetDestructableName is the only thing that reads it). */
  name: string;
}

/** Read one destructible's row. Returns undefined for a plain doodad (no DestructableData row). */
export type DestructableRow = (typeId: string) => { string(col: string): string | undefined } | undefined;

export function collectMapDestructibles(doodads: DoodadInstance[], rowOf: DestructableRow): MapDestructible[] {
  const out: MapDestructible[] = [];
  for (let i = 0; i < doodads.length; i++) {
    const d = doodads[i];
    const row = rowOf(d.id);
    if (!row) continue; // scenery, not a destructible
    const maxLife = Number(row.string("HP")) || 0;
    const pathTex = tex(row.string("pathTex"));
    const pathTexDeath = tex(row.string("pathTexDeath"));
    out.push({
      id: i + 1,
      typeId: d.id,
      x: d.x,
      y: d.y,
      z: d.z,
      angle: d.angle,
      maxLife,
      // The .doo's `life` byte is a PERCENT of the type's HP (100 for everything the editor
      // places normally, 0 for one placed dead, 40/50 for the pre-damaged trees a few maps use).
      life: (maxLife * d.life) / 100,
      pathTex,
      pathTexDeath,
      isTree: row.string("targType") === "tree",
      name: row.string("Name") || "",
    });
  }
  return out;
}

/** SLK's two spellings of "no texture" — a bare `_` and the literal `none`. */
function tex(v: string | undefined): string {
  return !v || v === "_" || v === "none" ? "" : v;
}

/** The destructible a script's `CreateDestructable`/`CreateDestructableZ` is re-making.
 *
 *  The World Editor writes a `CreateDestructable` call into war3map.j for every doodad a
 *  trigger names, and leaves the .doo record behind as a placeholder (see
 *  DoodadInstance.scriptCreated). We already drew and stamped that record, so the native must
 *  ADOPT it rather than add a second gate on top of the first. Matched on type and position —
 *  the editor writes the .doo's own coordinates back out, so the match is exact; the tolerance
 *  is only there for the float round-trip through the script's decimal literals. */
export function findDestructibleAt(
  list: readonly MapDestructible[],
  typeId: string,
  x: number,
  y: number,
  tolerance = 8,
): MapDestructible | undefined {
  let best: MapDestructible | undefined;
  let bestD = tolerance;
  for (const d of list) {
    if (d.typeId !== typeId) continue;
    const dist = Math.hypot(d.x - x, d.y - y);
    if (dist <= bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}
