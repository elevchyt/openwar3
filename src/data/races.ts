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

/**
 * A worker is not a LIST OF FIVE IDS — it is a unit CARRYING a harvest ability.
 *
 * WC3 has no register of worker types: gathering is an ability (`Ahar` Gather, `Aaha` Acolyte
 * Harvest, `Ahrl` Ghoul Harvest Lumber, `Awha` Wisp Harvest), and a unit that lists one in its
 * `abilList` gathers — which is why the Object Editor's whole recipe for "my map's own worker"
 * is to put `Ahar` on something. Keying the profile off the four ability CODES rather than the
 * five stock ids is therefore not a convenience, it is the actual rule: a custom map's builder
 * had no worker state at all, so it could not gather, could not repair, and — the visible half
 * — had **no Build button**, because `SelectionInfo.isWorker` is `!!u.worker`. "WTii's Unit
 * Tester" sells four such builders (`h01W` "All Round Nice Guy" and friends, each a Peasant
 * carrying `Ahar` with the map's own `Builds` list), and every one of them came up unable to
 * build anything.
 *
 * The numbers are still stand-ins — SimWorld.applyHarvestData reads the real rates off the
 * ability's own row — so keying by that row is also what keeps the two in step.
 */
const WORKER_BY_HARVEST: Record<string, WorkerProfile> = Object.fromEntries(
  Object.values(WORKERS).map((w) => [w.harvestAbility, w]),
);

/** The worker profile for a type, by id first and then by the harvest ability it carries.
 *  `abilityCodes` is the unit's abilities resolved to their BASE codes (a custom map's
 *  `A000` based on `Ahar` is still `Ahar`) — the caller has the ability registry. */
export function workerProfileFor(typeId: string, abilityCodes: Iterable<string>): WorkerProfile | null {
  const direct = WORKERS[typeId];
  if (direct) return direct;
  for (const code of abilityCodes) {
    const hit = WORKER_BY_HARVEST[code];
    if (hit) return hit;
  }
  return null;
}

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

/**
 * A resource DEPOT is a building CARRYING the "Return Resources" ability, not one of a
 * known thirteen ids.
 *
 * `Artn` is the base code, and the game ships exactly three aliases of it — the whole rule is
 * in their two Data columns (`AbilityData.slk`, and `AbilityMetaData.slk` names the columns
 * `Rtn1`/`Rtn2`):
 *
 *     alias  comments                   DataA (Rtn1)  DataB (Rtn2)   carried by
 *     Argd   "Return (Gold)"                 1             0         — (nothing stock)
 *     Argl   "Return (Gold & Lumber)"        1             1         the human + orc halls
 *     Arlm   "Return (Lumber)"               0             1         Lumber Mill, WAR MILL,
 *                                                                    GRAVEYARD, Necropolis
 *                                                                    chain, Tree chain
 *
 * Keying off the ability instead of the id is the actual rule, and it is what makes a custom
 * map work: a clone of a Town Hall carries `Argl` the same way it carries its model, so it
 * accepts gold — while the old id set named the twelve stock halls and the Lumber Mill and
 * nothing else, so WTii's Unit Tester's own `htow`-based hall (`h02X`) took no deposits at all.
 * It also closes two holes in the STOCK data the id set had: `ofor` (the orc **War Mill**) and
 * `ugrv` (the undead **Graveyard**) both carry `Arlm` and were not in it, so orc and undead
 * lumber had to be walked all the way back to the hall.
 *
 * The one place we depart from the data, and deliberately: **a `TownHall`-classified building
 * accepts GOLD even when its `Artn` row does not say so.** The Necropolis and Tree of Life
 * chains carry only `Arlm`, because in the real game neither race's gold ever leaves the mine
 * — undead acolytes and night elf wisps stand INSIDE a haunted/entangled mine and the gold is
 * credited where it is dug, so there is nothing to return. We model the night elf's version
 * (SimWorld.tickEntangledMines) but not the undead's (see the "we do not model a Haunted Gold
 * Mine" note in world.ts), so our acolytes shuttle gold like a peasant and need somewhere to
 * put it. `UnitBalance.slk`'s `type` column carries the classification and a clone inherits
 * it, so this stays as data-driven as the rest — and it applies to exactly the seventeen
 * TownHall-classified types (the twelve halls, the three corrupted trees, the Draenei Haven
 * and the Temple of Tides). Drop this clause when the Haunted Gold Mine is modelled.
 */
export const RETURN_RESOURCES_CODE = "Artn";

/** Which resources a building takes deposits of. */
export interface DepotRole {
  gold: boolean;
  lumber: boolean;
}

/**
 * The depot role for a type. `abilities` is its innate ability list resolved to base
 * `code` + level-1 Data columns (the caller has the ability registry); `classification` is
 * `UnitDef.classification` (UnitBalance `type`, lowercased).
 */
export function depotRoleFor(classification: string[], abilities: Array<{ code: string; data: number[] }>): DepotRole {
  const role: DepotRole = { gold: false, lumber: false };
  for (const a of abilities) {
    if (a.code !== RETURN_RESOURCES_CODE) continue;
    if (a.data[0]) role.gold = true; // Rtn1 — accepts gold
    if (a.data[1]) role.lumber = true; // Rtn2 — accepts lumber
  }
  // The Haunted Gold Mine stand-in — see the block comment above.
  if (!role.gold && classification.includes("townhall")) role.gold = true;
  return role;
}

const POOL: PlayableRace[] = ["human", "orc", "undead", "nightelf"];

export function resolveRace(race: Race): PlayableRace {
  return race === "random" ? POOL[Math.floor(Math.random() * POOL.length)] : race;
}
