// Computer+ on WarChasers — the MAP, as the AI needs to know it.
//
// Everything in this file is read off Blizzard's own "(4)WarChasers.w3m" (Maps\Scenario): its
// `war3map.j`, `war3mapUnits.doo` and `war3map.w3u`. Nothing is guessed, and every table names the
// trigger, rect or object it came from, so a number can be checked against the script it belongs
// to. What is OURS (the roles, the skill orders) is marked as ours.

export interface Pt { readonly x: number; readonly y: number }
export interface Box { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }

export const inBox = (b: Box, x: number, y: number): boolean => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
export const centre = (b: Box): Pt => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Is the running script WarChasers?
 *
 * Asked of the script's own GLOBALS rather than of the file name, exactly as the Candy War check
 * is (candy/map.ts `isCandyWarScript`). The four are the map's hero picker and its spawner — the
 * two things this AI actually leans on — and no other script in the install has all four.
 */
export const WARCHASERS_SCRIPT_MARKERS = [
  "gg_trg_RoboX", "gg_trg_Skeletorus", "gg_trg_Snap_Camera_to_Player", "gg_trg_Monster_Spawn_Sweep",
] as const;

export function isWarChasersScript(globals: { has(name: string): boolean }): boolean {
  return WARCHASERS_SCRIPT_MARKERS.every((g) => globals.has(g));
}

/**
 * The four seats a HERO is played from — `InitCustomPlayerSlots`: Player(0), Player(1), Player(5) and
 * Player(6), all MAP_CONTROL_USER and all in `udg_Playersgroup` (`Initialize_WarChasers`). Player(11)
 * is the dungeon ("Dungeon Denizens", MAP_CONTROL_COMPUTER) and is never ours.
 */
export const HERO_SEATS: ReadonlySet<number> = new Set([0, 1, 5, 6]);

/** The dungeon's own player — every monster, spawner and boss (`Initialize_Allies`: "Dungeon Creatures"). */
export const DUNGEON = 11;

/** A seat's selector wisp (`ewsp`), which picks a hero by walking onto a pedestal. */
export const WISP = "ewsp";

/**
 * THE HERO PICKER. `Trig_<name>_Actions`: a unit entering the pedestal's rect is removed and
 * `CreateNUnitsAtLoc(1, <hero>, owner, GetRectCenter(gg_rct_Start2))` is created with an Ankh
 * (`UnitAddItemByIdSwapped('ankh', …)`). Seven of the eight check the entering unit is a wisp;
 * `RoboX` checks nothing. The trigger name, its rect (`TriggerRegisterEnterRectSimple`) and the hero
 * it makes do NOT always agree by name — `Skeletorus` watches `gg_rct_DreadKnight` and `Demonus` makes
 * Mumm-Rah — so this table is keyed on what the trigger CREATES.
 *
 * `role` is OURS: what the hero is for in a party, off its four `uhab` abilities (war3map.w3u).
 */
export type Role = "tank" | "healer" | "caster" | "damage";

export interface HeroPick {
  readonly hero: string;
  readonly name: string;
  readonly rect: Box;
  readonly role: Role;
}

export const PICKS: readonly HeroPick[] = [
  // `Hmkg` base: Thunder Clap, Devotion Aura, Shockwave, Avatar — the front line.
  { hero: "HC07", name: "Optimus Primo", rect: { minX: -8320, minY: -8640, maxX: -8064, maxY: -8320 }, role: "tank" },
  // `Otch` base: Wind Walk, Divine Shield, Thorns Aura, Tranquility — a tank who heals the party.
  { hero: "OC10", name: "Megotron X", rect: { minX: -7424, minY: -8192, maxX: -7168, maxY: -7936 }, role: "tank" },
  // `Emoo` base: Cold Arrows, Searing Arrows, Holy Light, Rain of Fire.
  { hero: "EC12", name: "Snake Aes", rect: { minX: -8320, minY: -7808, maxX: -8064, maxY: -7552 }, role: "healer" },
  // `Udea` base: Feral Spirit, Holy Light, Summon Water Elemental, Inferno.
  { hero: "UC13", name: "Beast Knight", rect: { minX: -8320, minY: -7424, maxX: -8064, maxY: -7168 }, role: "healer" },
  // `Ulic` base: Chain Lightning, Brilliance Aura, Death and Decay, Mana Burn.
  { hero: "UC09", name: "Skeletorus", rect: { minX: -7424, minY: -8640, maxX: -7168, maxY: -8320 }, role: "caster" },
  // `Udre` base, INT: Frost Nova, Vampiric Aura, Sleep, Animate Dead.
  { hero: "UC11", name: "Mumm-Rah", rect: { minX: -7424, minY: -7424, maxX: -7168, maxY: -7168 }, role: "caster" },
  // `Nbbc` base: Endurance Aura, Death Coil, Immolation, Bladestorm.
  { hero: "NC03", name: "Blade Berserker", rect: { minX: -8320, minY: -8192, maxX: -8064, maxY: -7936 }, role: "damage" },
  // `Ekee` base, AGI: Storm Bolt, Entangling Roots, Bash, Starfall.
  { hero: "EC08", name: "Assassin", rect: { minX: -7424, minY: -7808, maxX: -7168, maxY: -7552 }, role: "damage" },
];

/** The aisle between the two columns of pedestals (x -8064…-7424 is clear of every rect above). */
export const PICK_AISLE_X = -7744;

export const PICK_OF: ReadonlyMap<string, HeroPick> = new Map(PICKS.map((p) => [p.hero, p]));

/**
 * The order each hero spends its skill points in (OURS — every id is the hero's own `uhab`).
 * A priority list, exactly as candy/map.ts `SKILLS`: `learnskill` enforces the level gates, so the
 * ultimate listed first is simply refused until level 6 and the rest are ranked as the gates allow.
 * The HEAL goes first on a hero that has one, because a party of four lives on it.
 */
export const SKILLS: Readonly<Record<string, readonly string[]>> = {
  HC07: ["AHav", "AOsh", "AHtc", "AHad"],
  OC10: ["AEtq", "AHds", "AEah", "AOwk"],
  EC12: ["AHhb", "AHfa", "ANrf", "AHca"],
  UC13: ["AUin", "AHhb", "AOsf", "AHwe"],
  UC09: ["AUdd", "AOcl", "AHab", "AEmb"],
  UC11: ["AUan", "AUfn", "AUsl", "AUav"],
  NC03: ["AOww", "AUdc", "AEim", "AOae"],
  EC08: ["AEsf", "AHtb", "AHbh", "AEer"],
};

/**
 * THE TANK SECTION. `Player_N_Enters_Tank`: a player's unit entering `gg_rct_Tank_Enter_01` is given a
 * `hC25` KITT Steam Tank at `Tank_Enter_02` and becomes it (`udg_PlayerN`); its hero is hidden.
 * `Player_N_Leaves_Tank`: the tank entering `gg_rct_Tank_Leave_02` hands the hero back at `Waygate2_A`.
 * So while a player drives one, the TANK is the body that follows and fights.
 */
export const TANK = "hC25";
export const TANK_ENTER: Box = { minX: 4224, minY: 3200, maxX: 4608, maxY: 3584 };
export const TANK_LEAVE: Box = { minX: 2848, minY: -2432, maxX: 3360, maxY: -1920 };

/**
 * The KEYS (`kymn` Moon Key, `kysn` Sun Key). A door opens when a hero CARRYING one enters its rect
 * (`DoorTriggerDoor1`, `DoorTriggerDoor4`, …) — so a key is the leader's to carry, and a computer that
 * followed a step behind with the key in its bag would stand the party in front of a shut door.
 */
export const KEYS: ReadonlySet<string> = new Set(["kymn", "kysn"]);

/**
 * `Convert_Amulet_of_Recall` / `…_Scroll_of_Town_Portal` / `…_Crystal_Ball` / `…_Goblin_Night_Scope` /
 * `…_Sentry_Wards`: picking one up removes it and pays the picker +200 gold. They cost a free slot to
 * pick up, and nothing after.
 */
export const GOLD_ITEMS: ReadonlySet<string> = new Set(["amrc", "stwp", "crys", "tels", "wswd"]);
export const GOLD_ITEM_VALUE = 200;

/**
 * `Game_Over`: a hero that dies WITHOUT an `ankh` or an `IC17` (Ankh of Reincarnation Deluxe) is lost
 * for good — "You are dead!  Your soul is lost forever..." (TRIGSTR_103). There is no altar on this
 * map. So the Ankh is not an item among others; it is the hero's only second life, and both ids are
 * recognised here while `SimWorld` recognises the ability (`AIrc`) that actually does it.
 */
export const ANKHS: ReadonlySet<string> = new Set(["ankh", "IC17"]);
export const ANKH = "ankh";

/** The two shops (`CreateNeutralPassiveBuildings`): `nC04` Big Al's Shop and `nC16` Amy's Magical
 *  Shoppe. Their shelves are their `usei` in war3map.w3u and are read off the tech tree at runtime. */
export const SHOPS: ReadonlySet<string> = new Set(["nC04", "nC16"]);

/** `nfoh` Fountain of Health — the map's three places to heal (`CreateNeutralPassiveBuildings`). */
export const FOUNTAIN = "nfoh";
