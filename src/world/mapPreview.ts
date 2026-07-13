import { MpqDataSource } from "../vfs/mpq";
import { CELL } from "./terrain";
import { GOLD_MINE_ID, parseMapUnits } from "./mapUnits";
import { PlayerSlot } from "../data/enums";

// The markers the Custom Game screen paints over a map's minimap picture (issue #61).
//
// WC3's lobby preview is war3mapMap.blp with three kinds of glyph stamped on it, all read
// straight out of the map: a yellow ball on every gold mine, a house on every neutral
// building worth visiting (shops, taverns, mercenary camps), and each player's start
// location as a cross in that player's colour. The art is the game's own
// (UI\MiniMap\MiniMapIcon\*) — the icon set the RoC archive keeps for exactly this screen,
// distinct from the in-game minimap's (UI\Minimap\*, added by the expansion).
//
// Creep camps are deliberately absent: the reference client does not mark them in the
// lobby, only in the match (where they get a difficulty dot — see ui/hud.ts).

export type MarkerKind = "gold" | "building" | "start";

export interface PreviewMarker {
  kind: MarkerKind;
  x: number;
  y: number;
  /** The owning player slot, for a start location (its colour); -1 otherwise. */
  player: number;
}

export interface MapPreview {
  /** World rect the minimap PICTURE covers: the whole terrain grid, boundary included. */
  minX: number;
  minY: number;
  width: number;
  height: number;
  markers: PreviewMarker[];
}

/**
 * Read a map's preview markers. `showsMinimapIcon` decides which neutral buildings earn a
 * house glyph — the engine asks the unit's `nbmmIcon` field ("Art - Neutral Building - Show
 * Minimap Icon"), which is set on the useful ones and clear on the scenery.
 */
export function readMapPreview(bytes: Uint8Array, showsMinimapIcon: (typeId: string) => boolean): MapPreview | null {
  const mpq = new MpqDataSource("map", bytes);
  const bounds = terrainBounds(mpq.rawBytes("war3map.w3e"));
  if (!bounds) return null;

  const markers: PreviewMarker[] = [];
  for (const u of parseMapUnits(mpq.rawBytes("war3mapUnits.doo") ?? null)) {
    if (u.typeId === GOLD_MINE_ID) markers.push({ kind: "gold", x: u.x, y: u.y, player: -1 });
    else if (u.player === PlayerSlot.NeutralPassive && showsMinimapIcon(u.typeId)) {
      markers.push({ kind: "building", x: u.x, y: u.y, player: -1 });
    }
  }
  return { ...bounds, markers };
}

/** war3map.w3e's header alone — the grid size and where its origin sits in the world. The
 *  corners after it are megabytes we have no use for here, so they are never decoded. */
function terrainBounds(bytes: Uint8Array | null): { minX: number; minY: number; width: number; height: number } | null {
  if (!bytes || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "W3E!") return null;
  let at = 4 + 4 + 1 + 4; // version, tileset char, custom-tileset flag
  at += 4 + view.getInt32(at, true) * 4; // ground tileset ids
  at += 4 + view.getInt32(at, true) * 4; // cliff tileset ids
  const cols = view.getInt32(at, true);
  const rows = view.getInt32(at + 4, true);
  return {
    minX: view.getFloat32(at + 8, true),
    minY: view.getFloat32(at + 12, true),
    width: (cols - 1) * CELL,
    height: (rows - 1) * CELL,
  };
}
