import unitsdoo from "mdx-m3-viewer/dist/cjs/parsers/w3x/unitsdoo";

// Pre-placed units/buildings from war3mapUnits.doo (plan §5 / custom-map support).
// Every WC3 map — melee or custom — stores its placed units here: creeps, gold
// mines, neutral shops, start-location markers, and (on custom/campaign maps)
// each player's own units & buildings. Parsing it is what lets us drive unit and
// building placement FROM THE MAP instead of hard-coding a per-race roster, which
// is the prerequisite for loading arbitrary custom maps.
//
// This is a thin, typed pass over the mdx-m3-viewer `unitsdoo` parser: it keeps
// only the fields the sim/renderer need and tags each entry so callers can route
// it (start marker vs. gold mine vs. neutral-passive vs. a player's own unit).

// war3mapUnits.doo owner slots (WC3 fixed player indices).
export const START_LOCATION_ID = "sloc"; // the StartLocation.mdx marker prop
export const GOLD_MINE_ID = "ngol"; // a gold mine (a resource, not a unit)
export const PLAYER_NEUTRAL_PASSIVE = 15; // shops, taverns, labs, fountains, critters
export const PLAYER_NEUTRAL_HOSTILE = 12; // creeps
export const PLAYER_NEUTRAL_EXTRA = 13; // "Neutral Extra" (rarely used)
export const PLAYER_NEUTRAL_VICTIM = 14; // "Neutral Victim"

/** One placed unit/building read from war3mapUnits.doo. */
export interface PlacedUnit {
  typeId: string; // unit-type rawcode (e.g. "hfoo", "ngol", "sloc")
  x: number;
  y: number;
  facing: number; // radians (the .doo stores it in radians already)
  player: number; // owner slot 0–11 = players; 12–15 = neutral variants
  /** HP as a fraction 0..1 (-1 in the file ⇒ full ⇒ 1 here). */
  hpFraction: number;
  mana: number; // starting mana (-1 ⇒ default)
  goldAmount: number; // for gold mines
  /** Per-instance acquisition range set in the editor: -1 = use the unit's default,
   *  -2 = "Camp" (guard the camp with default acquisition), >0 = a custom range.
   *  This is the map's own per-creep aggro range. */
  targetAcquisition: number;
  heroLevel: number; // 0 for non-heroes
  /** True for the four Neutral player slots (12–15). */
  neutral: boolean;
  /** True for the Neutral Passive slot (15): shops/taverns/critters. */
  neutralPassive: boolean;
}

/** Parse war3mapUnits.doo into typed placed units. `buildVersion` comes from
 *  war3map.w3i (0 for pre-1.32); returns [] if the file is absent/unparseable. */
export function parseMapUnits(bytes: Uint8Array | null, buildVersion = 0): PlacedUnit[] {
  if (!bytes) return [];
  const file = new unitsdoo.File();
  try {
    file.load(bytes, buildVersion);
  } catch {
    return []; // a format we can't read yet — degrade to no pre-placed units
  }
  return file.units.map((u): PlacedUnit => {
    const player = u.player ?? 0;
    const neutral = player >= PLAYER_NEUTRAL_HOSTILE;
    return {
      typeId: u.id,
      x: u.location[0],
      y: u.location[1],
      facing: u.angle ?? 0,
      player,
      hpFraction: u.hitpoints === undefined || u.hitpoints < 0 ? 1 : u.hitpoints / 100,
      mana: u.mana ?? -1,
      goldAmount: u.goldAmount ?? 0,
      targetAcquisition: u.targetAcquisition ?? -1,
      heroLevel: u.heroLevel ?? 0,
      neutral,
      neutralPassive: player === PLAYER_NEUTRAL_PASSIVE,
    };
  });
}

/** Split placed units into the categories a game setup cares about. Start-location
 *  markers and gold mines are separated out; the rest are grouped by whether they
 *  belong to a player slot (0–11) or a neutral slot (12–15). */
export function categorizeMapUnits(units: PlacedUnit[]): {
  startLocations: PlacedUnit[];
  goldMines: PlacedUnit[];
  playerUnits: PlacedUnit[]; // owned by a real player slot (custom/campaign maps)
  neutralUnits: PlacedUnit[]; // creeps + neutral-passive (shops/critters/etc.)
} {
  const startLocations: PlacedUnit[] = [];
  const goldMines: PlacedUnit[] = [];
  const playerUnits: PlacedUnit[] = [];
  const neutralUnits: PlacedUnit[] = [];
  for (const u of units) {
    if (u.typeId === START_LOCATION_ID) startLocations.push(u);
    else if (u.typeId === GOLD_MINE_ID) goldMines.push(u);
    else if (u.neutral) neutralUnits.push(u);
    else playerUnits.push(u);
  }
  return { startLocations, goldMines, playerUnits, neutralUnits };
}
