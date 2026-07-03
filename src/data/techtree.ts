import type { PlayableRace } from "./races";

// Curated melee tech tree (plan Phase 6). WC3 stores the command-card layout in
// ability object-data that's costly to parse, so the melee build/train
// relationships — which are stable and well-known — are declared here. Costs,
// build times, food and icons come from the unit registry by id; this table
// only says *who builds/trains what*. Tier requirements are deliberately
// omitted for now (everything a worker/building could ever make is offered).

// Structures each race's worker can construct (base-tier melee set: production,
// tech, caster, air, supply, altar, first-tier tower, shop). Tier upgrades of a
// town hall (Keep/Castle, etc.) are hall upgrades, not worker builds, so they're
// omitted here but still listed as trainers below. Rawcodes verified against the
// wc3edit rawcode dump + StrategyWiki (TFT 1.27); see docs/REFERENCES.md.
export const WORKER_BUILDS: Record<PlayableRace, string[]> = {
  human: ["htow", "hhou", "hbar", "halt", "hlum", "hbla", "hars", "harm", "hgra", "hwtw", "hvlt"],
  orc: ["ogre", "otrb", "obar", "oalt", "ofor", "obea", "osld", "otto", "owtw", "ovln"],
  undead: ["unpl", "usep", "uaod", "ugrv", "utod", "uslh", "ubon", "usap", "uzig", "utom"],
  nightelf: ["etol", "eaom", "eaoe", "eaow", "odob", "eate", "emow", "edos", "etrp", "eden"],
};

// Units each building trains (workers + combat/caster/siege/air units). Altars
// train the four heroes (uppercase-initial rawcodes). Tier-upgraded halls keep
// training the worker.
export const BUILDING_TRAINS: Record<string, string[]> = {
  // --- Human ---
  htow: ["hpea"], hkee: ["hpea"], hcas: ["hpea"], // Town Hall / Keep / Castle
  hbar: ["hfoo", "hrif", "hkni"], // Barracks: Footman, Rifleman, Knight
  harm: ["hmtm", "hgyr", "hmtt"], // Workshop: Mortar Team, Flying Machine, Siege Engine
  hars: ["hmpr", "hsor", "hspt"], // Arcane Sanctum: Priest, Sorceress, Spell Breaker
  hgra: ["hgry", "hdhw"], // Gryphon Aviary: Gryphon Rider, Dragonhawk Rider
  halt: ["Hpal", "Hamg", "Hmkg", "Hblm"], // Altar of Kings (heroes)
  // --- Orc ---
  ogre: ["opeo"], ostr: ["opeo"], ofrt: ["opeo"], // Great Hall / Stronghold / Fortress
  obar: ["ogru", "ohun", "ocat"], // Barracks: Grunt, Headhunter, Demolisher
  obea: ["orai", "okod", "owyv", "otbr"], // Beastiary: Raider, Kodo, Wind Rider, Batrider
  osld: ["oshm", "odoc", "ospw"], // Spirit Lodge: Shaman, Witch Doctor, Spirit Walker
  otto: ["otau"], // Tauren Totem: Tauren
  oalt: ["Obla", "Ofar", "Otch", "Oshd"], // Altar of Storms (heroes)
  // --- Undead ---
  unpl: ["uaco"], unp1: ["uaco"], unp2: ["uaco"], // Necropolis / Halls of the Dead / Black Citadel
  usep: ["ugho", "ucry", "ugar"], // Crypt: Ghoul, Crypt Fiend, Gargoyle
  utod: ["unec", "uban"], // Temple of the Damned: Necromancer, Banshee
  uslh: ["umtw", "uabo", "uobs"], // Slaughterhouse: Meat Wagon, Abomination, Obsidian Statue
  ubon: ["ufro"], // Boneyard: Frost Wyrm
  uaod: ["Udea", "Udre", "Ulic", "Ucrl"], // Altar of Darkness (heroes)
  // --- Night Elf ---
  etol: ["ewsp"], etoa: ["ewsp"], etoe: ["ewsp"], // Tree of Life / Ages / Eternity
  eaom: ["earc", "esen", "ebal"], // Ancient of War: Archer, Huntress, Glaive Thrower
  eaoe: ["edry", "edoc", "emtg"], // Ancient of Lore: Dryad, Druid of the Claw, Mountain Giant
  eaow: ["edot", "ehip", "efdr"], // Ancient of Wind: Druid of the Talon, Hippogryph, Faerie Dragon
  edos: ["echm"], // Chimaera Roost: Chimaera
  eate: ["Edem", "Ekee", "Emoo", "Ewar"], // Altar of Elders (heroes)
  // --- Neutral ---
  // Tavern: the 8 neutral heroes any race can hire (Liquipedia/Wowpedia "Tavern" +
  // MPQ ntav — 425g/135L, first hero free). Grid slots come from each hero's own
  // NeutralUnitFunc buttonpos (rows 1-2). The Tavern is Neutral Passive (player 15);
  // the command card still offers these to the local player (see commandCard()).
  ntav: ["Nngs", "Nbrn", "Npbm", "Nfir", "Nplh", "Nbst", "Ntin", "Nalc"],
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
