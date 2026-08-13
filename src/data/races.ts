import { MELEE } from "./gameplayConstants";

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
export const MELEE_UNIT_SPACING = MELEE.MELEE_UNIT_SPACING;

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

// Worker harvesting profiles.
//
// **The numbers are not written here.** Every worker in the game carries a HARVEST ABILITY —
// Units\UnitAbilities.slk names it in that unit's `abilList`, and the row it points at carries
// the rates — so `harvestAbility` below is the citation and `SimWorld.applyHarvestData` reads
// the rates off it. What is left in this table is what the ability row does NOT say (which
// resources the worker may gather at all, whether its chopping kills the tree, whether it
// hauls) plus the pre-data fallbacks the headless tests run on.
//
// The four rows, straight out of UnitAbilities.slk, and what AbilityData.slk gives each:
//
//   hpea/opeo `Ahar` "Harvest"         DataA 1 lumber, DataB 10 capacity, DataC 10 gold, Dur 1.1s
//   ugho      `Ahrl` "Harvest Lumber"  DataA 2 lumber, DataB 20 capacity, no gold,       Dur 1.35s
//   ewsp      `Awha` "Wisp Harvest"    DataA 5 lumber,                                   Dur 8s
//   uaco      `Aaha` "Acolyte Harvest" gold only — the row carries no rate at all,       Dur 1s
//
// (Har1/Har2/Har3 mean the same three things for `Ahrl` and `Awha` as for `Ahar`, which is what
// makes one reader serve all four: a Peasant's 10-lumber load and a Ghoul's 20 are the same
// column, and the Wisp simply has no use for it.)
//
// The WISP is the one whose behaviour is not the shared one: `Awha` is a different ability
// CLASS, with no depot leg at all — the lumber is credited where it is cut (`deliversInPlace`).
// 5 per 8s is 0.63 lumber/sec, which lands within a rounding error of a Peasant's 10-per-trip
// round trip; the wisp buys that parity by being stuck in the tree. Its DataB = 5 and DataC =
// 150 have field ids of their own (Wha2/Wha3) and no source that names them, so they are left
// unspent rather than guessed at (CLAUDE.md).
//
// `damagesTree: false` is the night elf's signature and it is literal: a wisp-worked tree
// never falls, so night elf lumber is bounded only by how many wisps are in the forest.
export interface WorkerProfile {
  gold: boolean;
  lumber: boolean;
  /** The ability whose row carries this worker's rates — its own `abilList` entry in
   *  Units\UnitAbilities.slk. Read by SimWorld.applyHarvestData; the numbers below are only
   *  what stands in when no ability registry is mounted. */
  harvestAbility: string;
  lumberCapacity: number;
  lumberPerChop: number;
  chopPeriod: number; // seconds between chops
  /** Gold carried out of a classic gold mine per trip (`Ahar` DataC). Unused by the Wisp,
   *  whose gold never leaves the mine building (`Aegm`, see SimWorld.tickEntangledMines). */
  goldPerTrip: number;
  damagesTree: boolean;
  /** Credit the load at the tree instead of hauling it to a depot — the Wisp, and only the
   *  Wisp. See SimWorld.tickHarvest. */
  deliversInPlace: boolean;
}

export const WORKERS: Record<string, WorkerProfile> = {
  hpea: { gold: true, lumber: true, harvestAbility: "Ahar", lumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1.1, goldPerTrip: 10, damagesTree: true, deliversInPlace: false },
  opeo: { gold: true, lumber: true, harvestAbility: "Ahar", lumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1.1, goldPerTrip: 10, damagesTree: true, deliversInPlace: false },
  uaco: { gold: true, lumber: false, harvestAbility: "Aaha", lumberCapacity: 0, lumberPerChop: 0, chopPeriod: 1, goldPerTrip: 10, damagesTree: false, deliversInPlace: false },
  ugho: { gold: false, lumber: true, harvestAbility: "Ahrl", lumberCapacity: 20, lumberPerChop: 2, chopPeriod: 1.35, goldPerTrip: 0, damagesTree: true, deliversInPlace: false },
  ewsp: { gold: true, lumber: true, harvestAbility: "Awha", lumberCapacity: 0, lumberPerChop: 5, chopPeriod: 8, goldPerTrip: 0, damagesTree: false, deliversInPlace: true },
};

// The four main-hall chains, keyed by the BASE hall's internal type name (UnitUI.slk's
// `name` column). blizzard.j's MeleeGetAllyKeyStructureCount asks for exactly these four
// with GetPlayerTypedUnitCount(p, "townhall", true, true) — "…and its upgrades", which is
// why a Keep or a Castle has to answer to "townhall" as well (7.3). Owning no key
// structure while still holding buildings is what makes a melee player "crippled".
export const MAIN_HALL_CHAINS: Record<string, string[]> = {
  townhall: ["htow", "hkee", "hcas"], // Town Hall / Keep / Castle
  greathall: ["ogre", "ostr", "ofrt"], // Great Hall / Stronghold / Fortress
  treeoflife: ["etol", "etoa", "etoe"], // Tree of Life / Ages / Eternity
  necropolis: ["unpl", "unp1", "unp2"], // Necropolis / Halls of the Dead / Black Citadel
};

// common.j `race`: ConvertRace(1) HUMAN, (2) ORC, (3) UNDEAD, (4) NIGHTELF. What
// GetPlayerRace hands the script — MeleeStartingUnits branches the whole starting roster
// on it, so a lobby "random" must already be resolved (see resolveRace).
export const RACE_INDEX: Record<PlayableRace, number> = {
  human: 1,
  orc: 2,
  undead: 3,
  nightelf: 4,
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
