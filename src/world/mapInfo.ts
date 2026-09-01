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
  /** What the MAP says the slot is: w3i player type 1 = user (a human may take it), 2 =
   *  computer. A computer slot is the map's own AI player and the lobby may not re-seat it —
   *  WarChasers' "Dungeon Denizens" (player 11) is a computer, and the real client shows its
   *  slot menu greyed at "Computer (Normal)" while the four user slots still offer Open/Closed.
   *  A melee map declares every slot as a user slot, so nothing is locked there. Types 3 and 4
   *  are players no lobby seats and so are not slots at all — see `MapInfo.neutralPlayers`. */
  controller: "user" | "computer";
  /**
   * The slot's NAME, as the map wrote it in the w3i player record (a TRIGSTR key into
   * war3map.wts, resolved here). This is what WC3 shows on the owner line of a hover
   * tooltip, and on a campaign map it is the whole point of the field: Rise of the Naga's
   * nine slots are "Watchers", "Illidan's Naga", "Illidan's Servitors", "Ferocious Beasts",
   * "Wild Mur'guls", "Night Elf Villagers", "Prisoners" and "Illidan" — the sides the
   * mission is about. A MELEE map fills it too and says nothing with it — Echo Isles' two
   * records resolve to "Player 1" and "Player 2", the World Editor's placeholders — so there
   * the lobby's seating names the slot instead (`slotLabel`, ui/playerSlots.ts).
   */
  name: string;
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

/** A player the map declares but no lobby seats — the same record as a `PlayerSlot`, minus
 *  the one thing it isn't: a slot. See `MapInfo.neutralPlayers`. */
export type NeutralPlayer = Omit<PlayerSlot, "controller"> & { controller: "neutral" | "rescuable" };

/**
 * What the members of a force grant one another, out of the w3i force's own flag word.
 *
 * **Being on a team is not being allied, and being allied is not sharing sight.** The World
 * Editor compiles these flags into the map's `InitCustomTeams`, which is what makes the mapping
 * checkable rather than guessed — each force's block in that function says exactly what its
 * flags meant. Read per force across the campaign maps:
 *
 * | flags | InitCustomTeams emits                          | maps                          |
 * |-------|------------------------------------------------|-------------------------------|
 * | 0     | nothing                                        | NightElfX06 force 0           |
 * | 1     | `SetPlayerAllianceStateAllyBJ` only            | NightElfX01, OrcX01, X05      |
 * | 8     | `SetPlayerAllianceStateVisionBJ` only          | NightElfX07 force 2           |
 * | 9     | ally + vision                                  | NightElfX06/07, UndeadX01     |
 * | 57/59 | ally + vision + `…ControlBJ` (+allied victory) | HumanX02, UndeadX01 force 0   |
 *
 * So `0x01` = allied, `0x02` = allied victory, `0x08` = shared vision, `0x10`/`0x20` = shared
 * (advanced) unit control. Terror of the Tides' first chapter is the case that matters: its two
 * forces are flags **1**, allied and NOT sharing vision — so the Watchers' trackers, the Night
 * Elf Villagers and the Prisoners are your allies and you still have to go and LOOK at them.
 */
export interface ForceGrants {
  /** 0x01 — mutually passive (the five settings `SetPlayerAllianceStateAllyBJ` sets). */
  allied: boolean;
  /** 0x08 — ALLIANCE_SHARED_VISION, i.e. their units' sight lifts your fog. */
  sharedVision: boolean;
}

/**
 * What the map says its LOADING SCREEN is (issue #78) — the four w3i fields the World
 * Editor's "Loading Screen" dialog writes, and nothing else on the screen comes from the map.
 *
 * The numbering is the trap. mdx-m3-viewer calls the first int `campaignBackground`, which
 * reads as "only campaigns use this" — but it is the row number into `UI\WorldEditData.txt`'s
 * `[LoadingScreens]` for EVERY map that names a preset screen, and the int AFTER the subtitle
 * (its `loadingScreen`) is not a screen at all. Read straight out of the archives:
 *
 * | map                     | 1st int | 2nd int | `[LoadingScreens]` row it names   |
 * |-------------------------|---------|---------|-----------------------------------|
 * | NightElfX01 (v25)       | 46      | −1      | WESTRING_LOADINGSCREEN_NIGHTELFX01|
 * | HumanX01 (v25)          | 57      | −1      | …HUMANX01                         |
 * | Human01 (RoC, v18)      | 2       | −1      | …HUMAN01                          |
 * | WarChasers (RoC, v18)   | 44      | −1      | …CREDITS                          |
 * | Echo Isles (melee, v25) | −1      | 0       | none — melee shows a RACE screen   |
 *
 * Every campaign chapter's number is exactly its own chapter's row, and the melee map is the
 * one that names none. So: first int = the screen, second int = the TFT "used game data set"
 * field, which has nothing to do with this.
 */
export interface MapLoadingScreen {
  /** The `[LoadingScreens]` row this map asks for, or −1 for "none" (every melee map). */
  screen: number;
  /** The map's OWN imported loading-screen model, when it ships one (TFT w3i only). Wins over
   *  `screen` — a map that imported art means to show it. Empty on everything stock. */
  model: string;
  /** The three lines the screen prints, TRIGSTR-resolved. A campaign chapter fills all three
   *  ("Chapter One" / "Rise of the Naga" / the mission blurb); a melee map fills none. */
  title: string;
  subtitle: string;
  text: string;
}

/** The force flag bits we act on — see `ForceGrants` for how each was pinned down. */
const FORCE_ALLIED = 0x01;
const FORCE_SHARED_VISION = 0x08;

export interface MapInfo {
  name: string;
  /** The author's blurb (w3i description) — the Custom Game screen's "Map Description". */
  description: string;
  recommendedPlayers: string;
  tileset: string;
  width: number;
  height: number;
  /** The slots the LOBBY seats: w3i player types 1 (user) and 2 (computer). */
  slots: PlayerSlot[];
  /**
   * The players the map declares that no lobby ever seats — w3i player type 3 (neutral) and
   * 4 (rescuable, i.e. neutral until you free it). They are real players all the same: they
   * own units, they hold a slot's colour, they sit in one of the map's forces, and the map
   * names them.
   *
   * Kept beside `slots` rather than in it because everything that reads `slots` is asking
   * "what rows does the setup screen have?", and the answer for these is "none" — the real
   * client shows no row for Rise of the Naga's "Prisoners" either. But the MATCH needs them:
   * a chapter's config() re-states each one with `SetPlayerController(p, MAP_CONTROL_NEUTRAL)`
   * and its w3i name is what WC3 prints on the owner line of their units. Without them, the
   * villagers you are sent to save, the Watchers' trackers and the caged Prisoners all
   * hovered as a bare "Player 10" while every hostile side across the map read its own name.
   */
  neutralPlayers: NeutralPlayer[];
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
   * The map's own FORCES, when it declares custom ones (w3i flag 0x0040): a name, the players
   * in it, and **what its members grant each other**. WC3's lobby shows these as headings over
   * the player rows — "Forest Task Force" above the four humans, "Monolithic Creeps" above the
   * four computers — because on a custom map the teams are the map's to name, not the lobby's.
   * Empty on a melee map, which declares one nameless force holding everybody.
   *
   * A force is NOT automatically an alliance, and a team number is not shared sight. See
   * `ForceGrants`.
   */
  forces: Array<{ name: string; players: number[] } & ForceGrants>;
  /** w3i flag 0x0020 ("fixed player settings", set by WarChasers) — the map, not the lobby,
   *  owns the setup. Measured against the real client on WarChasers, what it actually fixes is
   *  every slot BUT your own: the AI player's team and handicap are greyed while yours are
   *  still yours to pick, and the race stays open on any seated slot (the client happily lets
   *  you re-race the Dungeon Denizens). See fdfSkirmish's row rules. */
  fixedPlayerSettings: boolean;
  /** What the map asks its loading screen to be (issue #78). */
  loading: MapLoadingScreen;
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
    slots: [], neutralPlayers: [], maxPlayers: 0, minimap, isMelee: classification.isMelee, forces: [], fixedPlayerSettings: false,
    loading: { screen: -1, model: "", title: "", subtitle: "", text: "" },
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
  // Player TYPE: 1 = user (a human may take the slot), 2 = computer (the map's own AI),
  // 3 = neutral, 4 = rescuable. The first two are seated in the lobby — Monolith's creeps get
  // four rows of their own — but only the user slots are what the map is "for" (maxPlayers).
  // The other two are players the lobby never shows and the match still needs: see
  // MapInfo.neutralPlayers.
  const record = <C extends string>(p: (typeof info.players)[number], controller: C): Omit<PlayerSlot, "controller"> & { controller: C } => ({
    id: p.id,
    defaultRace: raceFromW3i(p.race),
    startX: p.startLocation[0],
    startY: p.startLocation[1],
    controller,
    name: resolveName(p.name, "", strings), // see PlayerSlot.name
    team: customForces ? forceOf(info, p.id) : p.id, // see PlayerSlot.team
  });
  const playable = info.players.filter((p) => p.type === 1 || p.type === 2);
  const slots: PlayerSlot[] = playable.map((p) => record(p, p.type === 2 ? "computer" : "user"));
  const neutralPlayers: NeutralPlayer[] = info.players
    .filter((p) => p.type === 3 || p.type === 4)
    .map((p) => record(p, p.type === 4 ? ("rescuable" as const) : ("neutral" as const)));

  return {
    name: resolveName(info.name, fallbackName, strings),
    description: resolveName(info.description, "", strings),
    recommendedPlayers: resolveName(info.recommendedPlayers, "", strings),
    tileset: info.tileset,
    width: info.playableSize[0],
    height: info.playableSize[1],
    slots,
    neutralPlayers,
    maxPlayers: playable.filter((p) => p.type === 1).length || slots.length,
    minimap,
    isMelee: classification.isMelee,
    // Only a map that claims its forces gets to name them; a melee map's single force is an
    // implementation detail of the file, not a heading the lobby should print.
    forces: customForces
      ? info.forces.map((f) => ({
          name: resolveName(f.name, "", strings),
          players: slots.filter((s) => (f.playerMasks & (1 << s.id)) !== 0).map((s) => s.id),
          allied: (f.flags & FORCE_ALLIED) !== 0, // see ForceGrants
          sharedVision: (f.flags & FORCE_SHARED_VISION) !== 0,
        }))
      : [],
    fixedPlayerSettings: (info.flags & W3I_FIXED_PLAYER_SETTINGS) !== 0,
    // See MapLoadingScreen for why the screen number is the field named `campaignBackground`.
    loading: {
      screen: info.campaignBackground,
      model: info.loadingScreenModel.replace(/\.mdl$/i, ".mdx"),
      title: resolveName(info.loadingScreenTitle, "", strings),
      subtitle: resolveName(info.loadingScreenSubtitle, "", strings),
      text: resolveName(info.loadingScreenText, "", strings),
    },
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
