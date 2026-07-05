import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";

// Unit data registry (plan §4). Merges WC3's split unit SLK tables into one
// lookup keyed by unit id — our own data layer, independent of the renderer.
// Movement speed etc. live across several files: UnitData (race/movement),
// UnitBalance (spd/collision/hp/costs), UnitUI (model), UnitWeapons (attack).

export interface UnitDef {
  id: string;
  name: string;
  race: string; // human | orc | undead | nightelf | ...
  model: string; // MDX path, backslashes, with extension
  modelScale: number;
  selScale: number; // Art - Selection Scale (unitUI "scale"); ring size basis
  animBlend: number; // Art - Animation Blend Time (unitUI "blend", seconds): cross-fade
  // duration between animation sequences. Real WC3 default is 0.15s (808 of ~836 units);
  // a handful differ (0.01/0.3/0.4/0.5/1.5). Verified against War3Patch.mpq UnitUI.slk.
  soundSet: string; // unitUI "unitSound" label (e.g. "Footman") → UI\SoundInfo lookups
  weaponSound: string; // unitUI "weap1" weapon-impact base ("MetalMediumSlice"); "_" = none
  lumberSound: string; // unitUI "weap2" 2nd-weapon base — workers' chop ("AxeMediumChop"); "" = none
  armorSound: string; // unitUI "armor" material struck ("Metal"/"Flesh"/…) → combat-sound suffix
  icon: string; // command-card BTN icon path (from UnitFunc "art")
  description: string; // command-card tooltip text (UnitStrings "Ubertip"), cleaned
  hotkey: string; // command hotkey letter (UnitStrings "Hotkey")
  buttonX: number; // command-card grid column (0-3), from "buttonpos"
  buttonY: number; // command-card grid row (0-2)
  isHero: boolean;
  priority: number; // UnitData `prio`: selection sub-group order (heroes 9, Footman 6, Peasant 1) — higher sorts first & leads the group
  moveType: string; // foot | fly | horse | hover | float | amph | "" (building/immovable)
  isBuilding: boolean;
  pathTex: string; // pathing-footprint texture (buildings); "" for units
  speed: number; // world units / second
  turnRate: number; // radians-ish per second scale (UnitData turnrate)
  moveHeight: number; // fly altitude above ground (0 for ground units)
  collision: number;
  // Fog-of-war sight radii (UnitBalance.slk `sight`/`nsight`, world units). Night
  // is normally shorter — e.g. Footman 1400/800, Peasant 800/600, Town Hall 900/600.
  // Ultravision (rare; the `Ault` ability) would set nsight == sight, but no stock
  // melee unit carries it — night elves take the same night penalty as everyone.
  sightDay: number;
  sightNight: number;
  hitPoints: number;
  mana: number;
  armor: number;
  foodUsed: number;
  foodMade: number;
  goldCost: number;
  lumberCost: number;
  buildTime: number;
  attackDamage: number; // weapon 1 base (dmgplus1); total = base + dice rolls
  attackDice: number; // number of damage dice (dice1)
  attackSides: number; // sides per damage die (sides1)
  attackCooldown: number;
  attackDamagePoint: number; // dmgpt1: delay from swing start to strike/launch (s)
  attackRange: number;
  acquireRange: number; // auto-acquisition range (0 = never auto-attacks)
  canSleep: boolean; // UnitData `cansleep`: Neutral Hostile creeps of this type sleep at night
  weaponType: string; // weapTp1: "normal"/"instant" = melee, "missile"/… = ranged
  attackType: string; // atkType1: normal/pierce/siege/magic/chaos/hero (damage table)
  armorType: string; // defType: small/medium/large/fort/hero/divine/none
  missileArt: string; // weapon-1 projectile model (MDX path, backslashes) or ""
  missileSpeed: number; // projectile travel speed (world units/sec)
  // Projectile launch offset from the unit's origin, in its LOCAL frame (x forward,
  // y left, z up), rotated by facing — UnitWeapons.slk launchx/y/z. e.g. the Archmage
  // fires his fireball from launchz=66 (rod height), the Archer from launchy=62 (bow
  // offset to the side), not from the unit's feet. impactZ is the height the missile
  // aims for on the target (impactz, ~60 for everything).
  launchX: number;
  launchY: number;
  launchZ: number;
  impactZ: number;
  // Hero attributes (0 for non-heroes). primaryAttr is "STR"/"AGI"/"INT" or "".
  strength: number;
  agility: number;
  intelligence: number;
  strPerLevel: number; // hero attribute growth per level (STRplus/AGIplus/INTplus)
  agiPerLevel: number;
  intPerLevel: number;
  primaryAttr: string;
  level: number;
  abilities: string[]; // innate abilities (UnitAbilities.slk abilList)
  heroAbilities: string[]; // learnable hero abilities in slot order (heroAbilList)
  autoAbility: string; // default autocast ability id (UnitAbilities.slk "auto"), "" = none
  classification: string[]; // UnitBalance "type": mechanical/undead/peon/ancient/… (lowercased)
}

interface Row {
  string(key: string): string | undefined;
}

export class UnitRegistry {
  constructor(private defs: Map<string, UnitDef>) {}

  get(id: string): UnitDef | undefined {
    return this.defs.get(id);
  }
  has(id: string): boolean {
    return this.defs.has(id);
  }
  all(): UnitDef[] {
    return [...this.defs.values()];
  }
  get size(): number {
    return this.defs.size;
  }
  byRace(race: string): UnitDef[] {
    return this.all().filter((d) => d.race === race);
  }
}

const SLK = {
  data: "Units\\UnitData.slk",
  balance: "Units\\UnitBalance.slk",
  ui: "Units\\UnitUI.slk",
  weapons: "Units\\UnitWeapons.slk",
  abilities: "Units\\UnitAbilities.slk",
};

// Canonical display names ("Great Hall", not the SLK's internal "ogre1") live
// in per-race INI string files.
const STRING_FILES = [
  "Units\\HumanUnitStrings.txt",
  "Units\\OrcUnitStrings.txt",
  "Units\\UndeadUnitStrings.txt",
  "Units\\NightElfUnitStrings.txt",
  "Units\\NeutralUnitStrings.txt",
  "Units\\CampaignUnitStrings.txt",
];

// Command-card icon (`art`) and grid position (`buttonpos`) live in the per-race
// UnitFunc INI files, not the SLKs.
const FUNC_FILES = [
  "Units\\HumanUnitFunc.txt",
  "Units\\OrcUnitFunc.txt",
  "Units\\UndeadUnitFunc.txt",
  "Units\\NightElfUnitFunc.txt",
  "Units\\NeutralUnitFunc.txt",
  "Units\\CampaignUnitFunc.txt",
];

export function loadUnitRegistry(vfs: DataSource): UnitRegistry {
  const table = (path: string): MappedData | null => {
    const bytes = vfs.rawBytes(path);
    return bytes ? new MappedData(new TextDecoder("windows-1252").decode(bytes)) : null;
  };
  const data = table(SLK.data);
  const balance = table(SLK.balance);
  const ui = table(SLK.ui);
  const weapons = table(SLK.weapons);
  const abilities = table(SLK.abilities);

  const names = new MappedData();
  for (const path of STRING_FILES) {
    const bytes = vfs.rawBytes(path);
    if (bytes) names.load(new TextDecoder("windows-1252").decode(bytes));
  }
  const funcs = new MappedData();
  for (const path of FUNC_FILES) {
    const bytes = vfs.rawBytes(path);
    if (bytes) funcs.load(new TextDecoder("windows-1252").decode(bytes));
  }

  const defs = new Map<string, UnitDef>();
  if (!data || !ui) return new UnitRegistry(defs);

  for (const id of Object.keys(data.map)) {
    const d = data.getRow(id) as Row | undefined;
    const u = ui.getRow(id) as Row | undefined;
    const file = u ? str(u, "file") : "";
    if (!file) continue; // header rows / non-placeable entries have no model

    const b = balance?.getRow(id) as Row | undefined;
    const w = weapons?.getRow(id) as Row | undefined;
    const a = abilities?.getRow(id) as Row | undefined;

    const strings = names.getRow(id) as Row | undefined;
    const fn = funcs.getRow(id) as Row | undefined;
    const [bx, by] = fn ? parseButtonPos(str(fn, "buttonpos")) : [0, 0];

    // Heroes: the base hp/mana/def fields are level-1 BASE values; the game
    // precomputes the real level-1 stats (base + attributes) into realhp/realm/
    // realdef — Paladin: hp 100 → realhp 650 (100 + STR 22×25). Their attack base
    // also gets the primary attribute (Paladin dmg 0 + STR 22 + 2d6 = 24–34).
    // Verified against the real MPQ UnitBalance.slk.
    const primary = b ? str(b, "primary") : "";
    const isHero = primary === "STR" || primary === "AGI" || primary === "INT";
    const attr = { STR: b ? num(b, "STR", 0) : 0, AGI: b ? num(b, "AGI", 0) : 0, INT: b ? num(b, "INT", 0) : 0 };
    const realhp = b ? num(b, "realhp", 0) : 0;
    const realm = b ? num(b, "realm", 0) : 0;
    const realdef = b ? num(b, "realdef", 0) : 0;
    const primaryVal = isHero ? attr[primary as "STR" | "AGI" | "INT"] : 0;

    defs.set(id, {
      id,
      name: (strings && str(strings, "Name")) || (u && (str(u, "Name") || str(u, "name"))) || id,
      race: d ? str(d, "race") : "",
      model: `${file.replace(/\//g, "\\")}.mdx`,
      modelScale: u ? num(u, "modelScale", 1) : 1,
      selScale: u ? num(u, "scale", 1) : 1,
      animBlend: u ? num(u, "blend", 0.15) : 0.15,
      soundSet: u ? str(u, "unitSound") : "",
      weaponSound: u ? str(u, "weap1") : "",
      lumberSound: u ? str(u, "weap2") : "",
      armorSound: u ? str(u, "armor") : "",
      icon: fn ? str(fn, "art") : "",
      // Tooltip text (Name/Tip/Ubertip/Hotkey) lives in the per-race *UnitStrings*
      // INI, NOT the *UnitFunc* INI (which only holds art/buttonpos/missile). The
      // description was previously read from `fn` → always empty → generic fallback.
      description: strings ? cleanTip(str(strings, "Ubertip")) : "",
      hotkey: strings ? (str(strings, "Hotkey").trim()[0] ?? "").toUpperCase() : "",
      buttonX: bx,
      buttonY: by,
      isHero,
      priority: d ? num(d, "prio", 0) : 0, // UnitData `prio` — WC3 selection-order priority
      moveType: d ? str(d, "movetp") : "",
      isBuilding: (b ? num(b, "isbldg", 0) : 0) === 1,
      pathTex: d ? str(d, "pathTex") : "",
      speed: b ? num(b, "spd", 0) : 0,
      turnRate: d ? num(d, "turnrate", 0.5) : 0.5,
      moveHeight: d ? num(d, "moveheight", 0) : 0,
      // 1.27 layering quirk: collision lives in UnitBalance.slk in the
      // expansion/patch MPQs but in UnitData.slk in the RoC base.
      collision: (b && num(b, "collision", 0)) || (d ? num(d, "collision", 0) : 0),
      // Sight radii live in UnitBalance.slk (`sight` day / `nsight` night). Verified
      // against the real 1.27 MPQ; buildings use the same fields (Town Hall 900/600).
      sightDay: b ? num(b, "sight", 0) : 0,
      sightNight: b ? num(b, "nsight", 0) : 0,
      hitPoints: isHero && realhp > 0 ? realhp : b ? num(b, "hp", 0) : 0,
      mana: isHero && realm > 0 ? realm : b ? num(b, "manaN", 0) : 0,
      armor: Math.round(isHero && realdef > 0 ? realdef : b ? num(b, "def", 0) : 0),
      foodUsed: b ? num(b, "fused", 0) : 0,
      foodMade: b ? num(b, "fmade", 0) : 0,
      goldCost: b ? num(b, "goldcost", 0) : 0,
      lumberCost: b ? num(b, "lumbercost", 0) : 0,
      buildTime: b ? num(b, "bldtm", 0) : 0,
      attackDamage: (w ? num(w, "dmgplus1", 0) : 0) + primaryVal,
      attackDice: w ? num(w, "dice1", 0) : 0,
      attackSides: w ? num(w, "sides1", 0) : 0,
      attackCooldown: w ? num(w, "cool1", 0) : 0,
      attackDamagePoint: w ? num(w, "dmgpt1", 0) : 0,
      attackRange: w ? num(w, "rangeN1", 0) : 0,
      acquireRange: w ? num(w, "acquire", 0) : 0,
      canSleep: (d ? num(d, "cansleep", 0) : 0) === 1,
      weaponType: w ? str(w, "weapTp1") : "",
      attackType: w ? str(w, "atkType1") : "",
      armorType: b ? str(b, "defType") : "",
      // Missile art + speed live in the per-race UnitFunc.txt (NOT UnitWeapons.slk),
      // as .mdl paths (e.g. Archmage FireBallMissile, Archer ArrowMissile).
      missileArt: fn ? missilePath(str(fn, "missileart")) : "",
      missileSpeed: fn ? num(fn, "missilespeed", 900) : 900,
      // Launch/impact offsets live in UnitWeapons.slk (launchx/y/z, impactz). Verified
      // against the real 1.27 MPQ: Archmage launchx=15/launchz=66, Archer launchy=62.
      launchX: w ? num(w, "launchx", 0) : 0,
      launchY: w ? num(w, "launchy", 0) : 0,
      launchZ: w ? num(w, "launchz", 0) : 0,
      impactZ: w ? num(w, "impactz", 0) : 0,
      strength: attr.STR,
      agility: attr.AGI,
      intelligence: attr.INT,
      strPerLevel: b ? num(b, "STRplus", 0) : 0,
      agiPerLevel: b ? num(b, "AGIplus", 0) : 0,
      intPerLevel: b ? num(b, "INTplus", 0) : 0,
      primaryAttr: isHero ? primary : "",
      // Heroes spawn at level 1. UnitBalance's `level` for heroes is 5 (their
      // creep-threat/bounty level), which wrongly showed newly-trained heroes as
      // Level 5. With no XP/leveling system yet, pin trained heroes to level 1.
      level: isHero ? 1 : b ? num(b, "level", 0) : 0,
      abilities: a ? (str(a, "abilList") || "").split(",").filter(Boolean) : [],
      heroAbilities: a ? (str(a, "heroAbilList") || "").split(",").filter(Boolean) : [],
      autoAbility: a ? str(a, "auto") : "",
      classification: b ? (str(b, "type") || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean) : [],
    });
  }
  return new UnitRegistry(defs);
}

// WC3 tooltip text (Ubertip) uses |cAARRGGBB…|r colour codes and |n line breaks.
// Strip the colour markup and normalize breaks/whitespace for plain display.
function cleanTip(v: string): string {
  return v
    .replace(/\|c[0-9a-fA-F]{8}/g, "")
    .replace(/\|r/g, "")
    .replace(/\|n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "missileart" from UnitFunc.txt is a .mdl model path. It may be comma-separated
// (weapon1,weapon2) — prefer the *Missile* model (vs an *Impact* effect). Strip
// the .mdl extension and use .mdx (the compiled file the MPQ actually ships).
function missilePath(v: string): string {
  if (!v) return "";
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  const pick = parts.find((p) => /missile/i.test(p)) ?? parts[0];
  if (!pick) return "";
  const p = pick.replace(/\//g, "\\").replace(/\.mdl$/i, "");
  return /\.mdx$/i.test(p) ? p : `${p}.mdx`;
}

// "buttonpos" is "col,row" on the 4×3 command grid; default top-left.
function parseButtonPos(v: string): [number, number] {
  const m = /(\d+)\s*,\s*(\d+)/.exec(v);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [0, 0];
}

// SLK cells use "-" for "none"; treat that (and missing) as empty/default.
function str(row: Row, key: string): string {
  const v = row.string(key);
  return v === undefined || v === "-" ? "" : v;
}
function num(row: Row, key: string, fallback: number): number {
  const v = row.string(key);
  if (v === undefined || v === "-") return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}
