import type { FogMode } from "../ui/lobby";

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
// `computerPlus` is the eighth row and OURS (src/overrides/, issue #124).

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
  /** Each hero is a rolled one (`IsMapFlagSet(MAP_RANDOM_HERO)` in Blizzard.j). Carried and
   *  shown; the native still answers false (src/jass/natives/melee.ts). */
  randomHero: boolean;
  /**
   * How other people may WATCH the game. Only `FULL_OBSERVERS` changes anything here: it
   * opens an Observers force in the lobby (`lobbySetup.ts` `observerSlots`) whose members
   * see the whole map and talk only to each other. The other two ways of watching are
   * chosen, shown and carried, and nothing more — a referee is a full observer who may also
   * talk to the players, and observers-on-defeat is a defeated player staying to watch; both
   * are the same seat with one extra rule, and neither rule is written yet.
   */
  observers: ObserverSetting;
  visibility: Visibility;
  /** Play the computer seats with Computer+ (src/ai/plus/) rather than Blizzard's scripts. */
  computerPlus: boolean;
}

/**
 * What the pane opens on — the real client's own defaults: teams locked and together, no
 * observers, default fog. Visibility opens on DEFAULT here where the Custom Game screen opens
 * on Map Explored: that screen chose its own default long before there was a pane to say
 * otherwise, while a LAN game has always been the game's own pitch-black fog.
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
};

/** Every row still as the pane opened it — the game lobby prints the Advanced Options block
 *  only when there is something in it to tell a joiner. */
export function isDefaultAdvanced(a: AdvancedOptions): boolean {
  return (Object.keys(DEFAULT_ADVANCED) as Array<keyof AdvancedOptions>).every((k) => a[k] === DEFAULT_ADVANCED[k]);
}

/**
 * What each visibility choice means to the match.
 *
 * `HIDE_TERRAIN` and `DEFAULT` land on the same `FogMode` because we model one unexplored
 * state, not two: WC3's Hide Terrain additionally blanks the terrain in the minimap preview
 * and the loading screen, which is a presentation difference on ground that is black either
 * way while you play.
 */
export function visibilityFog(v: Visibility): FogMode {
  switch (v) {
    case "MAP_EXPLORED": return "explored";
    case "ALWAYS_VISIBLE": return "revealall";
    default: return "unexplored";
  }
}

/** A broadcast from an older client may carry no options at all; read it as the defaults. */
export function advancedOf(a: Partial<AdvancedOptions> | undefined): AdvancedOptions {
  return { ...DEFAULT_ADVANCED, ...(a ?? {}) };
}
