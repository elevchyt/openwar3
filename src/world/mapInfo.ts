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
  /** The slot's TEAM, and on a custom map it is the map's to decide, not the lobby's.
   *  A w3i carries FORCE definitions (a name + a bitmask of member players), and the
   *  "use custom forces" flag (0x0040) says they are authoritative — which is exactly what
   *  the map's own `config()` then re-states through `SetPlayerTeam`. WarChasers sets it:
   *  force 0 holds players 0/1/5/6 (a co-op party) and force 1 holds player 11. Melee maps
   *  do NOT set it (Echo Isles: one force, every player in it), which is the free-for-all
   *  the melee lobby is entitled to re-team at will — so without the flag we keep the old
   *  "each slot on its own team" default and melee is untouched. */
  team: number;
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
  /** w3i flag 0x0020 — the map fixes each slot's race/team and the lobby may not change
   *  them (WarChasers sets it). The lobby greys those controls out rather than letting the
   *  player author a setup the map's own config() immediately contradicts. */
  fixedPlayerSettings: boolean;
  /** Melee/custom classification + the map's flags and trigger script. */
  classification: MapClassification;
}

/** w3i flags — see PlayerSlot.team. */
const W3I_FIXED_PLAYER_SETTINGS = 0x0020;
const W3I_USE_CUSTOM_FORCES = 0x0040;

export function parseMapInfo(bytes: Uint8Array, fallbackName: string): MapInfo {
  const mpq = new MpqDataSource("map", bytes);
  const classification = classifyMap(mpq); // melee vs. custom, from the w3i flags
  const empty: MapInfo = {
    name: fallbackName, recommendedPlayers: "", tileset: "", width: 0, height: 0,
    slots: [], isMelee: classification.isMelee, fixedPlayerSettings: false, classification,
  };
  const w3iBytes = mpq.rawBytes("war3map.w3i");
  if (!w3iBytes) return empty;

  const info = new w3iParser.File();
  info.load(w3iBytes);
  const customForces = (info.flags & W3I_USE_CUSTOM_FORCES) !== 0;
  const slots: PlayerSlot[] = info.players
    .filter((p) => p.type === 1 || p.type === 2) // user + computer playable slots
    .map((p) => ({
      id: p.id,
      defaultRace: raceFromW3i(p.race),
      startX: p.startLocation[0],
      startY: p.startLocation[1],
      team: customForces ? forceOf(info, p.id) : p.id, // see PlayerSlot.team
    }));

  return {
    name: resolveName(info.name, fallbackName),
    recommendedPlayers: resolveName(info.recommendedPlayers, ""),
    tileset: info.tileset,
    width: info.playableSize[0],
    height: info.playableSize[1],
    slots,
    isMelee: classification.isMelee,
    fixedPlayerSettings: (info.flags & W3I_FIXED_PLAYER_SETTINGS) !== 0,
    classification,
  };
}

/** Which FORCE (team) player `id` belongs to — the index of the first force whose player
 *  bitmask has that player's bit. A player in no force keeps their own id as their team. */
function forceOf(info: { forces: Array<{ playerMasks: number }> }, id: number): number {
  const i = info.forces.findIndex((f) => (f.playerMasks & (1 << id)) !== 0);
  return i < 0 ? id : i;
}

// Names are often TRIGSTR_### references into war3map.wts; until we resolve those,
// fall back to the file name.
function resolveName(value: string, fallback: string): string {
  return !value || value.startsWith("TRIGSTR_") ? fallback : value;
}
