import type { FogMode } from "../ui/lobby";
import { DEFAULT_GAME_SPEED, toGameSpeed, type GameSpeed } from "../data/gameSpeed";

// The ADVANCED OPTIONS of a hosted game — the pane behind the "Advanced Options" button on the
// LAN create screen (`UI\FrameDef\Glue\AdvancedOptionsPane.fdf`), as one plain record.
//
// It is here, in `src/net/`, and DOM-free on purpose: the host picks these on the create
// screen, they ride in every `lobby` broadcast so the game lobby can print them
// (`AdvancedOptionsDisplay.fdf`, the summary under the map), and they cross in `start` so the
// match is built from them on every machine. Three places read one shape.
//
// The seven rows are the game's own, and the values the two menus carry are the GlobalStrings
// KEYS of their `MenuItem`s (`FULL_OBSERVERS`, `MAP_EXPLORED`…) — so the wire says exactly what
// the FDF says, and a screen prints a value by looking its key up, never by re-typing it.
// `computerPlus` is the eighth row and OURS (src/overrides/, issue #124); `allTalk` the ninth (#133).

/** `ObserversPopupMenuMenu`'s four items, by their GlobalStrings key. */
export const OBSERVER_ITEMS = ["FULL_OBSERVERS", "OBSERVERS_ON_DEFEAT", "REFEREES", "NO_OBSERVERS"] as const;
export type ObserverSetting = (typeof OBSERVER_ITEMS)[number];

/** `MapVisibilityPopupMenuMenu`'s four items, by their GlobalStrings key. */
export const VISIBILITY_ITEMS = ["DEFAULT", "HIDE_TERRAIN", "MAP_EXPLORED", "ALWAYS_VISIBLE"] as const;
export type Visibility = (typeof VISIBILITY_ITEMS)[number];

export interface AdvancedOptions {
  /** Alliances are fixed for the match: the Allies dialog's boxes are dead in-game. */
  lockTeams: boolean;
  /** Allies start on adjacent start locations. Carried and shown; not yet modelled — a slot
   *  takes the map's own start location by index (fdfSkirmish's `toConfig`). */
  teamsTogether: boolean;
  /** Team-mates share unit control from the first tick (`AllianceType.SharedControl`). */
  sharedControl: boolean;
  /** Every seat's race is rolled at Start, whatever the row said. */
  randomRaces: boolean;
  /** Each player STARTS with a rolled hero instead of a free-hero token: Blizzard.j's four
   *  `MeleeStartingUnits<Race>` read `IsMapFlagSet(MAP_RANDOM_HERO)` (`mapFlagsOf`). */
  randomHero: boolean;
  /**
   * How other people may WATCH the game. Only `FULL_OBSERVERS` changes anything here: it
   * opens an Observers force in the lobby (`lobbySetup.ts` `observerSlots`) whose members
   * see the whole map and talk only to each other. A referee is a full observer who may also
   * talk to the players, and that rule is not written yet. Observers-on-defeat is a defeated
   * player staying to watch: it reaches the script as `MAP_OBSERVERS_ON_DEATH` (`mapFlagsOf`),
   * which is what makes Blizzard.j's defeat dialog offer "Continue Observing" — the button is
   * the game's; what the loser then SEES is still their own fog, not an observer's whole map.
   */
  observers: ObserverSetting;
  visibility: Visibility;
  /** Play the computer seats with Computer+ (src/ai/plus/) rather than Blizzard's scripts. */
  computerPlus: boolean;
  /** Voice chat has no channels: everybody hears everybody (issue #133). Off, a talker is heard
   *  by their allies only — the same audience "To Allies:" chat has. OURS, the ninth row. */
  allTalk: boolean;
  /** The create screen's Game Speed slider (src/data/gameSpeed.ts) — not a row of THIS pane, but
   *  it travels the same road (create screen → every `lobby` broadcast → `start`), so it rides
   *  in the same record. An older host's silence reads as Fast (`advancedOf`). */
  gameSpeed: GameSpeed;
}

/**
 * What the pane opens on — the real client's own defaults: teams locked and together, no
 * observers, the map's own visibility.
 *
 * VISIBILITY opens on **Default**, the real client's own choice, on both screens — which is the
 * MAP's own visibility: explored when the map says so, else the black mask (`visibilityFog`). It is the default in BOTH senses, so a LAN game on it prints no
 * Advanced Options block (`isDefaultAdvanced`) and an older client's silence reads as it too
 * (`advancedOf`).
 *
 * `computerPlus` is false HERE and only here — a host's own preference (Options → Gameplay)
 * decides what the create screen opens on, but the game's default is what the lobby's summary
 * measures against, so a match on Computer+ is always printed as one.
 */
export const DEFAULT_ADVANCED: AdvancedOptions = {
  lockTeams: true,
  teamsTogether: true,
  sharedControl: false,
  randomRaces: false,
  randomHero: false,
  observers: "NO_OBSERVERS",
  visibility: "DEFAULT",
  computerPlus: false,
  allTalk: false,
  gameSpeed: DEFAULT_GAME_SPEED,
};

/** Every row still as the pane opened it — the game lobby prints the Advanced Options block
 *  only when there is something in it to tell a joiner. */
export function isDefaultAdvanced(a: AdvancedOptions): boolean {
  // The speed is not a row of the summary the lobby prints, so it cannot make it print one.
  return (Object.keys(DEFAULT_ADVANCED) as Array<keyof AdvancedOptions>)
    .every((k) => k === "gameSpeed" || a[k] === DEFAULT_ADVANCED[k]);
}

/**
 * What each visibility choice means to the match — on THIS map, because `DEFAULT` is not a fog
 * mode of its own: it is "whatever the map says", and a map says it with the w3i's "Masked
 * areas are partially visible" flag (`startsExplored`, mapKind.ts). Every one of the 192 stock
 * melee maps in the 1.30.4 install carries it, and a real melee game on Default opens with the
 * whole map as grey terrain memory — gold mines, shops and trees in the fog from the first
 * second — never on the pitch-black mask. A custom map is the MAP's call as well, not a rule
 * about custom maps: this used to read the MELEE flag instead, which agrees on every stock map
 * and put WTii's Unit Tester (the flag set, no melee bit, no reveal trigger anywhere in its
 * script) under a black mask the real client never draws on it.
 *
 * `HIDE_TERRAIN` stays unexplored on every map (that is what it is for), and lands on the same
 * `FogMode` as an unexplored map's Default because we model one unexplored state, not two: WC3's
 * Hide Terrain additionally blanks the terrain in the minimap preview and the loading screen,
 * which is a presentation difference on ground that is black either way while you play.
 */
export function visibilityFog(v: Visibility, mapExplored: boolean): FogMode {
  switch (v) {
    case "MAP_EXPLORED": return "explored";
    case "ALWAYS_VISIBLE": return "revealall";
    case "HIDE_TERRAIN": return "unexplored";
    default: return mapExplored ? "explored" : "unexplored";
  }
}

/** A broadcast from an older client may carry no options at all; read it as the defaults. */
export function advancedOf(a: Partial<AdvancedOptions> | undefined): AdvancedOptions {
  const out = { ...DEFAULT_ADVANCED, ...(a ?? {}) };
  out.gameSpeed = toGameSpeed(out.gameSpeed); // off the wire: never trust it to be a rung
  return out;
}

/**
 * common.j's `mapflag` constants — each one its own bit (`MAP_RANDOM_HERO =
 * ConvertMapFlag(8192*16)`), which is what `IsMapFlagSet` is asked with. Only the ones a lobby
 * option stands behind; the rest (handicaps, trading, cheats…) are a script's to set.
 */
export const MAP_FLAG = {
  FOG_HIDE_TERRAIN: 1,
  FOG_MAP_EXPLORED: 2,
  FOG_ALWAYS_VISIBLE: 4,
  OBSERVERS: 16,
  OBSERVERS_ON_DEATH: 32,
  LOCK_ALLIANCE_CHANGES: 1024,
  SHARED_ADVANCED_CONTROL: 8192 * 8,
  RANDOM_HERO: 8192 * 16,
  RANDOM_RACES: 8192 * 32,
} as const;

/**
 * The lobby's options as the map flags a script reads them back by (`Runtime.mapFlags`, issue
 * #296). The two Blizzard.j itself asks for are `RANDOM_HERO` (the starting units) and
 * `OBSERVERS_ON_DEATH` (the defeat dialog's "Continue Observing"); the others are stated so
 * that a map's own `IsMapFlagSet` hears what the host chose rather than a flat false. Which
 * option stands behind which flag is read off the flags' own NAMES — nothing in the install
 * pairs them — and `fog` is the visibility as already resolved against the map's w3i
 * (`visibilityFog`), so Default on an explored map reads as Map Explored.
 */
export function mapFlagsOf(a: Partial<AdvancedOptions>, fog: FogMode): number {
  let flags = 0;
  if (a.visibility === "HIDE_TERRAIN") flags |= MAP_FLAG.FOG_HIDE_TERRAIN;
  else if (fog === "explored") flags |= MAP_FLAG.FOG_MAP_EXPLORED;
  else if (fog === "revealall") flags |= MAP_FLAG.FOG_ALWAYS_VISIBLE;
  if (a.observers === "FULL_OBSERVERS" || a.observers === "REFEREES") flags |= MAP_FLAG.OBSERVERS;
  if (a.observers === "OBSERVERS_ON_DEFEAT") flags |= MAP_FLAG.OBSERVERS_ON_DEATH;
  if (a.lockTeams) flags |= MAP_FLAG.LOCK_ALLIANCE_CHANGES;
  if (a.sharedControl) flags |= MAP_FLAG.SHARED_ADVANCED_CONTROL;
  if (a.randomHero) flags |= MAP_FLAG.RANDOM_HERO;
  if (a.randomRaces) flags |= MAP_FLAG.RANDOM_RACES;
  return flags;
}
