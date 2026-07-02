import type { PlayableRace } from "./races";

// Curated melee tech tree (plan Phase 6). WC3 stores the command-card layout in
// ability object-data that's costly to parse, so the melee build/train
// relationships — which are stable and well-known — are declared here. Costs,
// build times, food and icons come from the unit registry by id; this table
// only says *who builds/trains what*. Tier requirements are deliberately
// omitted for now (everything a worker/building could ever make is offered).

// Buildings each race's worker can construct (basic tier-1 melee set).
export const WORKER_BUILDS: Record<PlayableRace, string[]> = {
  human: ["htow", "hhou", "hbar", "halt", "hlum", "hbla", "hwtw"],
  orc: ["ogre", "otrb", "obar", "oalt", "ofor", "obea", "owtw"],
  undead: ["unpl", "usep", "uzig", "uaod", "ugol", "ubon"],
  nightelf: ["etol", "emow", "edob", "eaom", "eden", "eaoe"],
};

// Units each building can train (workers + basic combat units).
export const BUILDING_TRAINS: Record<string, string[]> = {
  // Human
  htow: ["hpea"],
  hkee: ["hpea"],
  hcas: ["hpea"],
  hbar: ["hfoo", "hrif", "hmtm"],
  halt: ["Hpal", "Hamg", "Hmkg", "Hblm"],
  // Orc
  ogre: ["opeo"],
  ostr: ["opeo"],
  ofrt: ["opeo"],
  obar: ["ogru", "orai", "okod"],
  oalt: ["Obla", "Ofar", "Otch", "Oshd"],
  // Undead
  unpl: ["uaco"],
  unp1: ["uaco"],
  unp2: ["uaco"],
  usep: ["ugho", "ucry", "unec"],
  uaod: ["Udea", "Udre", "Ulic", "Ucrl"],
  // Night Elf
  etol: ["ewsp"],
  etoa: ["ewsp"],
  etoe: ["ewsp"],
  edob: ["earc", "esen", "edoc"],
  eaom: ["Edem", "Ekee", "Emoo", "Ewar"],
};

// Ground-order hotkeys (WC3 standard). Build/train use the unit's name hotkey.
export const ORDER_HOTKEYS = {
  move: "M",
  stop: "S",
  hold: "H",
  attack: "A",
  patrol: "P",
  build: "B",
  buildAdvanced: "V",
  repair: "R",
  gather: "G",
  cancel: "Escape",
} as const;

/** Whether a unit id is a worker that can construct buildings. */
export function buildsFor(race: PlayableRace): string[] {
  return WORKER_BUILDS[race] ?? [];
}

/** Units a given building trains (empty if none). */
export function trainsFor(buildingId: string): string[] {
  return BUILDING_TRAINS[buildingId] ?? [];
}
