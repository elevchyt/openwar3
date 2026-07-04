import w3iParser from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";
import { MpqDataSource } from "../vfs/mpq";
import { raceFromW3i, type Race } from "../data/races";
import { classifyMap, type MapClassification } from "./mapKind";

// Map metadata for the lobby (plan Phase 5.5), read from war3map.w3i: name,
// recommended players, tileset/size, and the player slots with their start
// locations and default races.

export interface PlayerSlot {
  id: number;
  defaultRace: Race;
  startX: number;
  startY: number;
}

export interface MapInfo {
  name: string;
  recommendedPlayers: string;
  tileset: string;
  width: number;
  height: number;
  slots: PlayerSlot[];
  /** Whether the map is a standard melee map (drives melee vs. custom start). */
  isMelee: boolean;
  /** Melee/custom classification + the map's flags and trigger script. */
  classification: MapClassification;
}

export function parseMapInfo(bytes: Uint8Array, fallbackName: string): MapInfo {
  const mpq = new MpqDataSource("map", bytes);
  const classification = classifyMap(mpq); // melee vs. custom, from the w3i flags
  const empty: MapInfo = {
    name: fallbackName, recommendedPlayers: "", tileset: "", width: 0, height: 0,
    slots: [], isMelee: classification.isMelee, classification,
  };
  const w3iBytes = mpq.rawBytes("war3map.w3i");
  if (!w3iBytes) return empty;

  const info = new w3iParser.File();
  info.load(w3iBytes);
  const slots: PlayerSlot[] = info.players
    .filter((p) => p.type === 1 || p.type === 2) // user + computer playable slots
    .map((p) => ({
      id: p.id,
      defaultRace: raceFromW3i(p.race),
      startX: p.startLocation[0],
      startY: p.startLocation[1],
    }));

  return {
    name: resolveName(info.name, fallbackName),
    recommendedPlayers: resolveName(info.recommendedPlayers, ""),
    tileset: info.tileset,
    width: info.playableSize[0],
    height: info.playableSize[1],
    slots,
    isMelee: classification.isMelee,
    classification,
  };
}

// Names are often TRIGSTR_### references into war3map.wts; until we resolve those,
// fall back to the file name.
function resolveName(value: string, fallback: string): string {
  return !value || value.startsWith("TRIGSTR_") ? fallback : value;
}
