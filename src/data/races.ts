// Playable races (plan Phase 5.5). Central place for race identity + labels;
// the melee starting-unit rosters per race will be added here next.

export type Race = "human" | "orc" | "undead" | "nightelf" | "random";

export const RACES: Race[] = ["human", "orc", "undead", "nightelf", "random"];

export const RACE_LABEL: Record<Race, string> = {
  human: "Human",
  orc: "Orc",
  undead: "Undead",
  nightelf: "Night Elf",
  random: "Random",
};

// war3map.w3i player race field: 1=Human, 2=Orc, 3=Undead, 4=Night Elf.
export function raceFromW3i(n: number): Race {
  return (["random", "human", "orc", "undead", "nightelf"][n] as Race) ?? "random";
}

export type PlayableRace = Exclude<Race, "random">;

// Melee starting units per race (plan Phase 5.5): main hall + workers.
export const STARTING_UNITS: Record<PlayableRace, Array<{ id: string; count: number }>> = {
  human: [{ id: "htow", count: 1 }, { id: "hpea", count: 5 }],
  orc: [{ id: "ogre", count: 1 }, { id: "opeo", count: 5 }],
  undead: [{ id: "unpl", count: 1 }, { id: "uaco", count: 3 }, { id: "ugho", count: 1 }],
  nightelf: [{ id: "etol", count: 1 }, { id: "ewsp", count: 5 }],
};

// Authentic melee worker placement (blizzard.j MeleeStartingUnits*, verified vs
// War3x.mpq Scripts\Blizzard.j — see the blizzard-j-melee-template memory). WC3
// does NOT ring the workers around the town hall: it spawns them in a tight clump
// on the line between the hall (start location) and the NEAREST GOLD MINE, sitting
// `dist` world-units out from the mine (the ghoul instead sits out from the hall).
// Offsets are per-worker (x, y) in multiples of MELEE_UNIT_SPACING around that
// clump centre. bj_UNIT_FACING = 270° (south) is spawnUnit's default facing.
export const MELEE_UNIT_SPACING = 64; // blizzard.j `unitSpacing`

export interface WorkerCluster {
  id: string; // worker rawcode this group places (count = offsets.length)
  anchor: "mine" | "start"; // project the clump centre FROM here…
  toward: "start" | "mine"; // …in the direction of here…
  dist: number; // …by this many world units (blizzard.j MeleeGetProjectedLoc)
  offsets: Array<[number, number]>; // per-worker (x, y), in MELEE_UNIT_SPACING units
}

export const MELEE_WORKER_CLUSTERS: Record<PlayableRace, WorkerCluster[]> = {
  // 5 peasants, projected 320u from the mine back toward the hall.
  human: [{ id: "hpea", anchor: "mine", toward: "start", dist: 320,
    offsets: [[0, 1], [1, 0.15], [-1, 0.15], [0.6, -1], [-0.6, -1]] }],
  // 5 peons, same layout.
  orc: [{ id: "opeo", anchor: "mine", toward: "start", dist: 320,
    offsets: [[0, 1], [1, 0.15], [-1, 0.15], [0.6, -1], [-0.6, -1]] }],
  // 3 acolytes cluster at the mine; the lone ghoul sits 288u out from the hall.
  undead: [
    { id: "uaco", anchor: "mine", toward: "start", dist: 320,
      offsets: [[0, 0.5], [0.65, -0.5], [-0.65, -0.5]] },
    { id: "ugho", anchor: "start", toward: "mine", dist: 288, offsets: [[0, 0]] },
  ],
  // 5 wisps, projected 320u from the mine (blizzard.j uses ±0.58 on the back row).
  nightelf: [{ id: "ewsp", anchor: "mine", toward: "start", dist: 320,
    offsets: [[0, 1], [1, 0.15], [-1, 0.15], [0.58, -1], [-0.58, -1]] }],
};

// Worker harvesting profiles (verified vs community-documented WC3 values:
// 10 gold/trip; peasant/peon 1 lumber per ~1s chop, capacity 10; ghoul 2/chop
// capacity 20; wisp 5 per 5s without damaging the tree; acolytes only mine).
export interface WorkerProfile {
  gold: boolean;
  lumber: boolean;
  lumberCapacity: number;
  lumberPerChop: number;
  chopPeriod: number; // seconds between chops
  damagesTree: boolean;
}

export const WORKERS: Record<string, WorkerProfile> = {
  hpea: { gold: true, lumber: true, lumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true },
  opeo: { gold: true, lumber: true, lumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true },
  uaco: { gold: true, lumber: false, lumberCapacity: 0, lumberPerChop: 0, chopPeriod: 1, damagesTree: false },
  ugho: { gold: false, lumber: true, lumberCapacity: 20, lumberPerChop: 2, chopPeriod: 1.1, damagesTree: true },
  ewsp: { gold: true, lumber: true, lumberCapacity: 5, lumberPerChop: 5, chopPeriod: 5, damagesTree: false },
};

// Buildings that accept resource deposits (town halls + upgrades).
export const DEPOT_IDS = new Set([
  "htow", "hkee", "hcas", // Town Hall / Keep / Castle
  "ogre", "ostr", "ofrt", // Great Hall / Stronghold / Fortress
  "unpl", "unp1", "unp2", // Necropolis / Halls of the Dead / Black Citadel
  "etol", "etoa", "etoe", // Tree of Life / Ages / Eternity
  "hlum", // Lumber Mill (lumber drop-off)
]);

const POOL: PlayableRace[] = ["human", "orc", "undead", "nightelf"];

export function resolveRace(race: Race): PlayableRace {
  return race === "random" ? POOL[Math.floor(Math.random() * POOL.length)] : race;
}
