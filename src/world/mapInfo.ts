import w3iParser from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";
import { MpqDataSource } from "../vfs/mpq";
import { raceFromW3i, type Race } from "../data/races";
import { parseWts } from "../jass/wts";
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
  /** The author's blurb (w3i description) — the Custom Game screen's "Map Description". */
  description: string;
  recommendedPlayers: string;
  tileset: string;
  width: number;
  height: number;
  slots: PlayerSlot[];
  /**
   * How many players the map is FOR — the badge on its row and beside its name. Only the
   * slots a human may take (w3i player type 1) count: Monolith seats eight, but four of them
   * are its own "Monolithic Creeps" computers, and the game calls it a 4-player map. On a
   * melee map every slot is a user slot, so this is simply `slots.length`.
   */
  maxPlayers: number;
  /** The map's own minimap image (war3mapMap.blp), for the Custom Game preview. */
  minimap: Uint8Array | null;
  /** Whether the map is a standard melee map (drives melee vs. custom start). */
  isMelee: boolean;
  /**
   * The map's own FORCES, when it declares custom ones (w3i flag 0x0040): a name and the
   * players in it. WC3's lobby shows these as headings over the player rows — "Forest Task
   * Force" above the four humans, "Monolithic Creeps" above the four computers — because on
   * a custom map the teams are the map's to name, not the lobby's. Empty on a melee map,
   * which declares one nameless force holding everybody.
   */
  forces: Array<{ name: string; players: number[] }>;
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
  const minimap = mpq.rawBytes("war3mapMap.blp") ?? null;
  const empty: MapInfo = {
    name: fallbackName, description: "", recommendedPlayers: "", tileset: "", width: 0, height: 0,
    slots: [], maxPlayers: 0, minimap, isMelee: classification.isMelee, forces: [], fixedPlayerSettings: false,
    classification,
  };
  const w3iBytes = mpq.rawBytes("war3map.w3i");
  if (!w3iBytes) return empty;

  const info = new w3iParser.File();
  info.load(w3iBytes);

  // The name/description a map shows are usually TRIGSTR_### keys into its own war3map.wts
  // (every Blizzard melee map is), so resolve them the way the engine does. war3map.wts is
  // UTF-8 (with a BOM) — read as latin1, the BOM turns into three stray characters glued to
  // the first "STRING 0" header, and the map's NAME is the one entry that fails to parse.
  const wtsBytes = mpq.rawBytes("war3map.wts");
  const strings = wtsBytes ? parseWts(new TextDecoder("utf-8").decode(wtsBytes)) : new Map<number, string>();
  const customForces = (info.flags & W3I_USE_CUSTOM_FORCES) !== 0;
  // Player TYPE: 1 = user (a human may take the slot), 2 = computer (the map's own AI). Both
  // are seated in the lobby — Monolith's creeps get four rows of their own — but only the
  // user slots are what the map is "for" (maxPlayers).
  const playable = info.players.filter((p) => p.type === 1 || p.type === 2);
  const slots: PlayerSlot[] = playable
    .map((p) => ({
      id: p.id,
      defaultRace: raceFromW3i(p.race),
      startX: p.startLocation[0],
      startY: p.startLocation[1],
      team: customForces ? forceOf(info, p.id) : p.id, // see PlayerSlot.team
    }));

  return {
    name: resolveName(info.name, fallbackName, strings),
    description: resolveName(info.description, "", strings),
    recommendedPlayers: resolveName(info.recommendedPlayers, "", strings),
    tileset: info.tileset,
    width: info.playableSize[0],
    height: info.playableSize[1],
    slots,
    maxPlayers: playable.filter((p) => p.type === 1).length || slots.length,
    minimap,
    isMelee: classification.isMelee,
    // Only a map that claims its forces gets to name them; a melee map's single force is an
    // implementation detail of the file, not a heading the lobby should print.
    forces: customForces
      ? info.forces.map((f) => ({
          name: resolveName(f.name, "", strings),
          players: slots.filter((s) => (f.playerMasks & (1 << s.id)) !== 0).map((s) => s.id),
        }))
      : [],
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

// A w3i string is either literal or a "TRIGSTR_019" key into the map's own war3map.wts.
// Resolve the key; only a key we can't find falls back.
function resolveName(value: string, fallback: string, strings: Map<number, string>): string {
  if (!value) return fallback;
  const m = /^TRIGSTR_(\d+)$/.exec(value.trim());
  if (!m) return value;
  return strings.get(parseInt(m[1], 10))?.trim() || fallback;
}
