import type { Lane } from "./chat";

// Computer+ on Extreme Candy War — the MAP, as the AI needs to know it.
//
// Everything in this file is read off Blizzard's own "(10)ExtremeCandyWar2004.w3x" (Maps\FrozenThrone\
// Scenario): its `war3map.j`, `war3mapUnits.doo` and object data. Nothing is guessed, and every
// table names the trigger or rect it came from, so a number can be checked against the script it
// belongs to. What is OURS (the class builds, the skill priorities) is marked as ours.
//
// The user-made "ExtremeCandyWarAI.w3x" (Maps\Download) was STUDIED for the shape of a computer on
// this map and nothing was lifted from it: its lanes and buy lists agree with the stock script
// because both read the same rects, and where it cheats (550 gold, items created out of nothing,
// a free potion) or is broken (two ultimates never learned, a missing spell brain) this file does
// what the map's own rules say instead.

export interface Pt { readonly x: number; readonly y: number }
export interface Box { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }

export function inBox(b: Box, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Is the running script Extreme Candy War?
 *
 * Asked of the script's own GLOBALS rather than of the file name — a copy renamed in the Download
 * folder is still this map, and a different map called "Candy War" is not. The four triggers named
 * are the map's whole game (the hero picker and the three candy-monster pushes); a script with all
 * four of them is this one.
 */
export const CANDY_SCRIPT_MARKERS = [
  "gg_trg_Pick_Heroes", "gg_trg_Crate_Detection_North", "gg_trg_Crate_Detection_Middle", "gg_trg_Crate_Detection_South",
] as const;

export function isCandyWarScript(globals: { has(name: string): boolean }): boolean {
  return CANDY_SCRIPT_MARKERS.every((g) => globals.has(g));
}

/**
 * The seats a HERO is played from. `InitCustomPlayerSlots`: Player(0..4) are the Horde's people and
 * Player(6..10) the Alliance's, all MAP_CONTROL_USER; Player(5) and Player(11) are the two ARMY
 * computers (creeps, towers, shops, vault, mages) and are the map's own — never ours to drive.
 */
export const HERO_SEATS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 6, 7, 8, 9, 10]);

/**
 * What `Initialize_Players` hands a PERSON at the start and nobody else — `SetPlayerStateBJ(…,
 * PLAYER_STATE_RESOURCE_FOOD_CAP, 10)` and `AdjustPlayerStateBJ(300, …, PLAYER_STATE_RESOURCE_GOLD)`,
 * both under a `MAP_CONTROL_USER` filter. The map never imagined a computer in a hero seat, so a
 * Computer+ seat is given exactly these two and nothing more (`RtsController.startCandyWarAI`) — the
 * same starting purse as the person beside it, which is parity and not a cheat. (The user-made AI
 * map SETS its computers' gold to 550.)
 */
export const START_GOLD = 300;
export const START_FOOD_CAP = 10;

/** One team's half of the map. */
export interface Side {
  readonly name: "horde" | "alliance";
  /** The ARMY computer this side's creeps, towers, shops and vault belong to. */
  readonly army: number;
  /** +1 when this side's forward is towards larger lane `t` (the Horde, in the west), -1 otherwise. */
  readonly forward: 1 | -1;
  /** `gg_rct_*_Hero_Spawn` centre — where a picked hero appears. */
  readonly spawn: Pt;
  /** `nfnp` Fountain of Power — +2% life and mana a second within 500, the only healing building. */
  readonly fountain: Pt;
  /** `gg_rct_*_Shopping_Area` — the shops, the fountain and the spawn. An ENEMY hero entering it is
   *  teleported out (`Anti_Camping_*`), so it is never a place to chase anybody into. */
  readonly shopArea: Box;
  /** `gg_rct_*_Graveyard` centre — where a dead hero's ghost appears (`Hero_Spirit_Spawn`). */
  readonly graveyard: Pt;
  /** `earc` Spirit Healer — a ghost within 300 of it may pay to be revived (`Resurrect_Detection`). */
  readonly healer: Pt;
  /** `gg_rct_*_Base` centre. */
  readonly base: Pt;
  /** The Candy Vault's type — its death is the other side's victory (`Horde_Victory` / `Alliance_Victory`). */
  readonly vault: string;
  /** The three Candy Mages by lane (A north, B middle, C south — `Killing_*_Mages`). */
  readonly mages: Readonly<Record<Lane, string>>;
  /** `gg_rct_*_Heroes` — the costume models `Pick_Heroes` hands a hero out for. */
  readonly pickArea: Box;
}

export const HORDE: Side = {
  name: "horde", army: 5, forward: 1,
  spawn: { x: -7168, y: -80 },
  fountain: { x: -7552, y: -64 },
  shopArea: { minX: -7968, minY: -992, maxX: -6848, maxY: 928 },
  graveyard: { x: -6768, y: -2096 },
  healer: { x: -6874, y: -1982 },
  base: { x: -5904, y: 16 },
  vault: "unp2",
  mages: { top: "nzom", mid: "uswb", bot: "uktg" },
  pickArea: { minX: -7488, minY: -8640, maxX: -6304, maxY: -7680 },
};

export const ALLIANCE: Side = {
  name: "alliance", army: 11, forward: -1,
  spawn: { x: 7760, y: -16 },
  fountain: { x: 8128, y: 0 },
  shopArea: { minX: 7488, minY: -800, maxX: 8608, maxY: 1120 },
  graveyard: { x: 5904, y: 1520 },
  healer: { x: 5783, y: 1627 },
  base: { x: 6640, y: 16 },
  vault: "hcas",
  mages: { top: "nemi", mid: "nhef", bot: "enec" },
  pickArea: { minX: 6432, minY: -8896, maxX: 7616, maxY: -7936 },
};

/** The side a hero seat plays for, or null for a seat that is not a hero seat. */
export function sideOf(player: number): Side | null {
  if (player >= 0 && player <= 4) return HORDE;
  if (player >= 6 && player <= 10) return ALLIANCE;
  return null;
}

export function enemySide(side: Side): Side {
  return side === HORDE ? ALLIANCE : HORDE;
}

// --- the lanes ---------------------------------------------------------------------------------

/**
 * The three lanes, WEST to EAST — `udg_zMonster_Movement_*_Array` (`Initialize_Movement_Regions`),
 * the candy monsters' own waypoints and therefore the lanes themselves. Index 0 is the Horde's end.
 */
export const LANE_PATHS: Readonly<Record<Lane, readonly Pt[]>> = {
  top: [{ x: -5712, y: 544 }, { x: -6112, y: 2992 }, { x: -672, y: 2128 }, { x: -64, y: 2128 }, { x: 448, y: 2112 }, { x: 6432, y: 3712 }, { x: 6368, y: 352 }],
  mid: [{ x: -5360, y: -256 }, { x: -464, y: -2528 }, { x: -16, y: -2560 }, { x: 432, y: -2560 }, { x: 6160, y: -256 }],
  bot: [{ x: -5984, y: -592 }, { x: -5984, y: -3376 }, { x: -5696, y: -5424 }, { x: -544, y: -6480 }, { x: -160, y: -6512 }, { x: 288, y: -6544 }, { x: 6400, y: -5392 }, { x: 6816, y: -3152 }, { x: 6624, y: -560 }],
};

/** The candy monster that walks each lane (`Initialize_Units`): `hmtt` Candy Craving Stitches,
 *  `h001` Fozruk the Sweet Tooth, `h002` Diablo, Closet Cookie Thief. */
export const MONSTERS: Readonly<Record<Lane, string>> = { top: "hmtt", mid: "h001", bot: "h002" };

/** `Crate_Detection_*`: a hero within this of a monster pushes it (or, with both sides there, stops it). */
export const PUSH_REACH = 600;

/** A lane's length, polyline distance. */
export function laneLength(lane: Lane): number {
  const p = LANE_PATHS[lane];
  let len = 0;
  for (let i = 1; i < p.length; i++) len += dist(p[i - 1], p[i]);
  return len;
}

/** Where on a lane a point is: `t` the distance along it from the west end of the point's nearest
 *  spot on the polyline, `off` how far the point is from that spot. */
export function project(lane: Lane, at: Pt): { t: number; off: number } {
  const p = LANE_PATHS[lane];
  let best = { t: 0, off: Infinity };
  let run = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const u = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / (len * len)));
    const off = Math.hypot(a.x + dx * u - at.x, a.y + dy * u - at.y);
    if (off < best.off) best = { t: run + u * len, off };
    run += len;
  }
  return best;
}

/** The point `t` along a lane from its west end (clamped to the lane). */
export function pointAt(lane: Lane, t: number): Pt {
  const p = LANE_PATHS[lane];
  let left = Math.max(0, t);
  for (let i = 1; i < p.length; i++) {
    const len = dist(p[i - 1], p[i]);
    if (left <= len) {
      const u = len ? left / len : 0;
      return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * u, y: p[i - 1].y + (p[i].y - p[i - 1].y) * u };
    }
    left -= len;
  }
  return p[p.length - 1];
}

/** The lane a point is ON, or null when it is further than `within` from all three. */
export function laneOf(at: Pt, within = 1200): Lane | null {
  let best: Lane | null = null;
  let off = within;
  for (const lane of ["top", "mid", "bot"] as const) {
    const pr = project(lane, at);
    if (pr.off < off) { off = pr.off; best = lane; }
  }
  return best;
}

// --- the heroes --------------------------------------------------------------------------------

export type HeroClass = "warrior" | "mage" | "rogue" | "warlock" | "shaman" | "hunter" | "priest" | "druid" | "paladin";

/** Hero type → class, by the costume's point value (`upoi`, which `Hero_Descriptions` reads). */
export const HERO_CLASS: Readonly<Record<string, HeroClass>> = {
  Nklj: "warrior", Hart: "warrior",
  Ulic: "mage", Hjai: "mage",
  Ewar: "rogue", Edem: "rogue",
  Uwar: "warlock", Hblm: "warlock",
  Oshd: "shaman",
  Usyl: "hunter", Hvwd: "hunter",
  Ucrl: "priest", Harf: "priest",
  Otch: "druid", Hapm: "druid",
  Hpal: "paladin",
};

/** Warriors and Rogues are `sapper`s: the item rules and Mana Burn key on it, and their mana is rage
 *  and energy rather than something the fountain gives back (`ANre` skips them). */
export const SAPPER: ReadonlySet<HeroClass> = new Set(["warrior", "rogue"]);
/** Melee attackers (`urng` 100). */
export const MELEE: ReadonlySet<HeroClass> = new Set(["warrior", "rogue", "paladin"]);
/** The classes that heal someone else. */
export const HEALER: ReadonlySet<HeroClass> = new Set(["priest", "druid", "paladin", "shaman"]);
/** The classes whose fight is their MANA — they go home for it. */
export const CASTER: ReadonlySet<HeroClass> = new Set(["mage", "warlock", "shaman", "priest", "druid"]);

/**
 * Which class a computer picks, in preference order for a team that has none of the kind yet (OURS).
 * A team wants somebody who heals and somebody who stands in front, and after that damage — so the
 * first computer on a team of people fills whichever of those is missing, and two computers on one
 * team never play the same class if another is free.
 */
export const PICK_ORDER: readonly HeroClass[] = ["priest", "warrior", "mage", "hunter", "druid", "warlock", "rogue", "paladin", "shaman"];

/** `Hero_Spirit_Spawn`'s ghost types, by class, both sides — what a DEAD hero's player controls. */
export const GHOST_TYPES: ReadonlySet<string> = new Set([
  "odoc", "okod", "otau", "otbr", "ocat", "oshm", "owyv", "ohun",
  "ospw", "hmpr", "hpea", "hgry", "orai", "hdhw", "opeo", "hgyr",
]);

/** `Resurrect_Detection`: the ability a ghost is given at its corpse (free, 70% life), at the Spirit
 *  Healer below level 10 (full, costs level×30 XP) and at the healer at level 10 (400 gold). */
export const REVIVE_CORPSE = "AEsb";
export const REVIVE_HEALER = "ANbr";
export const REVIVE_HEALER_MAX = "AAns";
/** …and the reach each is handed out at. */
export const CORPSE_REACH = 600;
export const HEALER_REACH = 300;
/** `Hero_Dead_State`: the death timer is 5 + 2 × level. */
export function deathTimer(level: number): number {
  return 5 + 2 * level;
}

/**
 * The order each class spends its skill points in (OURS — but every id is the map's `uhab`).
 *
 * A priority list, not a schedule: `learnAbility` enforces the map's own level gates (a basic ability
 * ranks at 1/3/5, an ultimate at 6), so trying these in order spreads the points exactly as a player
 * would — the main spell to rank 3 as early as the gates allow, the ultimate the moment it opens,
 * then the rest. The ultimate is listed first because at level 6 nothing should come before it.
 *
 * Two things the user-made AI got wrong are right here by construction: the Warrior's and Hunter's
 * ultimates are `AIfz`/`AIbt` (a capital I — its `Alfz`/`Albt` never matched, so they were never
 * learned), and nothing is spent past level 10, the map's `MaxHeroLevel`.
 */
export const SKILLS: Readonly<Record<HeroClass, readonly string[]>> = {
  warrior: ["AIfz", "ACfb", "Acri", "AHtc"],
  mage: ["AHbz", "Awfb", "Aroa", "ANms"],
  rogue: ["AUsl", "ANfl", "Afod", "AOwk"],
  warlock: ["AEsf", "Auhf", "ANdr", "ACfd"],
  shaman: ["AOsw", "AOcl", "Ahwd", "ACbl"],
  hunter: ["AIbt", "ANab", "ANdh", "Aprg"],
  priest: ["Ainf", "ACuf", "Ahea", "AEmb"],
  druid: ["AEtq", "Suhf", "Arej", "AEer"],
  paladin: ["AHds", "AHtb", "AIhl", "ACro"],
};

// --- items -------------------------------------------------------------------------------------

/**
 * The slot rules — `Weapon_Limitation_*`, `Armor_Limitation_*`, `Accessory_Limitation_*`,
 * `Artifact_Limitation_*`. Classified by RAWCODE LIST, never by item class or level, and counted per
 * player. A pick-up that breaks one is destroyed and refunded — to the wrong player, in two of the
 * triggers — so the AI keeps to them itself rather than lean on the refund.
 */
export const WEAPONS: ReadonlySet<string> = new Set(["rat9", "rat6", "ratc", "rag1", "sehr", "clsd", "modt"]);
export const ARMORS: ReadonlySet<string> = new Set(["hval", "rde2", "rde1", "rde3", "rat3", "rst1", "rin1", "brac", "ciri"]);
export const ACCESSORIES: ReadonlySet<string> = new Set(["hlst", "mnst", "rlif", "I003", "bgst", "hcun", "lgdh", "penr", "spsh", "clfm", "bspd", "dtsb", "axas", "mcou"]);
export const ARTIFACTS: ReadonlySet<string> = new Set(["clsd", "axas", "dtsb", "mcou", "sneg", "modt"]);
/** `Warrior_and_Rogue_Item_Limitation` / `Warrior_and_Rogue_Only_Items`. */
export const SAPPER_FORBIDDEN: ReadonlySet<string> = new Set(["pmna", "evtl", "I003", "mnst", "pinv", "bgst", "lgdh", "mcou", "pgma"]);
export const SAPPER_ONLY: ReadonlySet<string> = new Set(["pams"]);

/** May a hero of this class carry `item` on top of what it already holds? */
export function mayCarry(cls: HeroClass, held: readonly string[], item: string): boolean {
  const sapper = SAPPER.has(cls);
  if (sapper && SAPPER_FORBIDDEN.has(item)) return false;
  if (!sapper && SAPPER_ONLY.has(item)) return false;
  const count = (set: ReadonlySet<string>): number => held.filter((h) => set.has(h)).length + (set.has(item) ? 1 : 0);
  return count(WEAPONS) <= 1 && count(ARMORS) <= 1 && count(ACCESSORIES) <= 2 && count(ARTIFACTS) <= 1;
}

/** Which shop sells an item — each shop's `usei` (war3map.w3u). Both sides' shops are the same types. */
export const SHOP_OF: Readonly<Record<string, string>> = (() => {
  const shelves: Record<string, readonly string[]> = {
    utom: ["rat9", "rat6", "ratc", "rag1"],
    utod: ["rde1", "rde2", "ciri", "rde3", "rat3", "rin1", "hval", "rst1", "spsh"],
    uaod: ["tels", "I000", "stpg", "rwiz", "odef", "evtl", "ward", "dust", "kpin", "sfog", "I002", "desc"],
    usap: ["hlst", "mnst", "rlif", "I003", "bspd", "bgst", "belv", "hcun", "clfm", "lgdh", "penr"],
    usep: ["dtsb", "axas", "sneg", "modt", "mcou", "clsd", "sehr"],
    uzg2: ["wlsd", "shas", "pinv", "I001", "pmna", "prvt", "stwp", "arsc", "pams", "esaz", "grsl"],
    // The three upgrade shops are stocked by TRIGGER (`Initialize_Gameplay_and_Camera`,
    // `AddItemToStockBJ`) rather than by `usei`, and each purchase unlocks the next.
    nmrk: ["rres", "rre2", "rre1", "guvi", "rdis", "lmbr"],
    unpl: ["tint", "tstr", "tdex", "rsps", "rhe2", "rman", "gfor", "rhe3", "gold"],
    unp1: ["tin2", "tst2", "tdx2", "rspd", "rhe1", "rreb", "gomn", "rma2", "manh"],
  };
  const out: Record<string, string> = {};
  for (const [shop, items] of Object.entries(shelves)) for (const it of items) out[it] = shop;
  return out;
})();

/**
 * What each class buys, in order (OURS). Four items, because every hero is handed two at the pick
 * (`shas` Boots of Haste and `stwp` Scroll of Teleportation) and carries six. Each list is legal under
 * the slot rules as a whole — one weapon, one armour, two accessories, one artifact, and nothing a
 * sapper may not hold — so nothing bought is ever refunded, and nothing has to be sold to make room.
 *
 *  · The fighters buy damage and armour, and life: the Warrior's Thor's Hammer and Super Charged
 *    Gloves, the Rogue's Mask of the Faceless (attack speed and life steal on a class that lives in
 *    melee).
 *  · The casters buy MANA — Caster Robes, a mana-regeneration mask and Paleth's Visage — because a
 *    caster without mana is a hero standing in a lane doing nothing.
 *  · Valiant Heart Charm (+3 armour, +30 speed) is the cheap first accessory for everybody who fights
 *    in front, because on a lane map the hero that can walk away is the hero that lives.
 */
export const BUILDS: Readonly<Record<HeroClass, readonly string[]>> = {
  warrior: ["bspd", "ratc", "rst1", "penr"],
  rogue: ["ciri", "bspd", "modt", "penr"],
  mage: ["I003", "rin1", "rat6", "mcou"],
  warlock: ["I003", "rin1", "rat6", "mcou"],
  priest: ["I003", "rin1", "rat6", "mcou"],
  shaman: ["I003", "rin1", "rat6", "mcou"],
  hunter: ["bspd", "rat6", "ciri", "axas"],
  druid: ["I003", "rin1", "rat6", "axas"],
  paladin: ["bspd", "hval", "rag1", "lgdh"],
};

/** …and what a player who does not think about it buys: the cheapest thing on each shelf. */
export const CHEAP_BUILD: readonly string[] = ["rde1", "rat9", "rlif", "belv"];

/** `I001` Souldust Potion — heals 1000. The potion a hero with a free slot and gold to spare carries. */
export const POTION = "I001";

/**
 * The TEAM upgrades, in the order worth buying them (OURS): each is an item any hero on the side buys
 * and it improves that side's CREEP WAVES for good (`Upgrade_*_Level_1/2/3`). The tier items first —
 * a better unit is worth more than +1 armour on a worse one — then the attack and armour researches.
 * The shops are stocked by trigger, so an item that is not on the shelf yet simply fails to buy.
 */
export const TEAM_UPGRADES: readonly string[] = [
  "tstr", "tint", "tdex", "tst2", "tin2", "tdx2",
  "guvi", "rre1", "rdis", "rres", "lmbr", "rre2",
  "gold", "rman", "rhe3", "rsps", "gfor", "rhe2",
  "rreb", "manh", "rma2", "rspd", "gomn", "rhe1",
];

// --- what an item is FOR ------------------------------------------------------------------------

/**
 * The map's usable items, by what pressing one does (map item → its ability, war3map.w3t). Kept as a
 * table of the map's own items rather than inferred from ability codes, because the map rebuilt most
 * of them on unrelated bases (a "Toy Penguin" that is a heal-over-time, a "Cup of Root Beer" whose
 * ability is still the invisibility potion).
 */
export type ItemUse =
  | "heal" // a burst of life
  | "regen" // life over time — broken by damage, so only out of a fight
  | "mana"
  | "haste" // run faster
  | "teleport" // `AImt` to a friendly unit or structure
  | "blink" // Kelen's Dagger
  | "shield" // a panic button: invulnerability / spell immunity
  | "armor" // a defensive self-buff for a fight
  | "roar" // an offensive buff for a fight
  | "curse" // weakens the enemies around
  | "hex" // a disable on one enemy
  | "nova"; // an area disable around a target

export const ITEM_USE: Readonly<Record<string, ItemUse>> = {
  shas: "haste", stwp: "teleport",
  I001: "heal", pghe: "heal", hlst: "heal", esaz: "heal", arsc: "heal",
  stpg: "regen",
  mnst: "mana", evtl: "mana", pgma: "mana",
  desc: "blink",
  pnvl: "shield", pams: "shield",
  I000: "armor",
  odef: "roar",
  rwiz: "curse",
  I002: "hex",
  ward: "nova",
};
