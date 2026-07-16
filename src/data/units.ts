import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";
import {
  ArmorType,
  AttackType,
  MoveType,
  PrimaryAttribute,
  WeaponType,
  toArmorType,
  toAttackType,
  toMoveType,
  toPrimaryAttribute,
  toWeaponType,
} from "./enums";

// Unit data registry (plan §4). Merges WC3's split unit SLK tables into one
// lookup keyed by unit id — our own data layer, independent of the renderer.
// Movement speed etc. live across several files: UnitData (race/movement),
// UnitBalance (spd/collision/hp/costs), UnitUI (model), UnitWeapons (attack).

/** One weapon SLOT of a unit (UnitWeapons.slk's parallel `*1` / `*2` column families).
 *
 *  A WC3 unit may carry two attacks and choose between them BY TARGET — this is not a
 *  curiosity, it is how half the anti-air roster works. The Flying Machine's slot 1 is
 *  `air`-only and its slot 2 bombs the ground; the Gryphon Rider hammers ground with
 *  slot 1 and air with slot 2; the Mortar Team keeps a separate `structure`-only slot for
 *  buildings. Modelling one weapon per unit made a Footman able to swing at a Gryphon and
 *  a Siege Engine able to mow down Footmen — neither of which WC3 permits. */
export interface WeaponSlotDef {
  /** This slot's bit in `weapsOn` ("Attacks Enabled"). The Flying Machine ships weapsOn=1
   *  (air only) and the Chimaera weapsOn=2 (ground only — its acid breath is slot 1, OFF).
   *  The `renw` upgrade effect REPLACES the whole mask: Flying Machine Bombs (`Rhgb`) and
   *  Corrosive Breath (`Recb`) carry renw=3 → both slots; Impaling Bolt (`Repb`) carries
   *  renw=2 → the Glaive Thrower SWAPS to slot 2 (which is why it starts hitting trees). */
  enabled: boolean;
  /** `targs1`/`targs2` — "Targets Allowed". The Footman's list has no `air`, which is
   *  precisely why he cannot answer a Gryphon Rider; the Siege Engine's is `structure,debris`,
   *  which is why it can only knock down buildings. Empty = the row declares no slot. */
  targets: string[];
  damage: number; // dmgplus1/2 (+ the hero's primary attribute, folded in as it is for slot 1)
  dice: number;
  sides: number;
  cooldown: number;
  damagePoint: number;
  /** `backSw1/2` — "Animation Backswing Point": the follow-through AFTER the strike
   *  lands, before the unit may act again. It never gates the cooldown. Attack speed
   *  divides it along with the damage point, which is the one thing the renderer wants
   *  it for: the live/base ratio of the pair IS the attack-speed factor the swing clip
   *  plays at (see rts.ts attackAnimRate — the pair is NOT the clip's length). */
  backswing: number;
  range: number;
  weaponType: WeaponType; // weapTp1/2 — Normal/Instant strike at once, the Missile kinds fly
  attackType: AttackType; // atkType1/2 → the damage table's row
  missileArt: string; // this slot's projectile model — `Missileart` is a per-slot comma list
  missileSpeed: number; // ...and so is `Missilespeed` (Flying Machine: 2000 air, 900 bombs)
  /** Line-splash ("spill") — `spillDist1/2` + `spillRadius1/2` + `damageLoss1/2`. The
   *  Gryphon Rider's hammer already carries a 50-unit spill RADIUS and a 0.2 falloff, but a
   *  spill DISTANCE of 0, so it hits one unit; Storm Hammers (`Rhhb`, `rasd` = 200) opens the
   *  distance and the same hammer starts carrying through the rank behind its target. */
  spillDist: number;
  spillRadius: number;
  damageLoss: number; // fraction of damage shed per further unit down the line
}

export interface UnitDef {
  id: string;
  name: string;
  /** The unit's internal TYPE name (unitUI "name": "townhall", "greathall", "footman").
   *  Not the display name — this is what JASS's GetPlayerTypedUnitCount matches on, which
   *  is how blizzard.j's melee library counts a team's main halls (7.3). */
  typeName: string;
  race: string; // human | orc | undead | nightelf | ...
  model: string; // MDX path, backslashes, with extension
  modelScale: number;
  selScale: number; // Art - Selection Scale (unitUI "scale"); ring size basis
  /** Art - Animation - Walk Speed / Run Speed (unitUI "walk"/"run"). NOT how fast the unit
   *  moves — the movement speed at which the model's "Walk" / "Walk Fast" clips were AUTHORED
   *  to look natural at 1.0x playback. They are literal copies of the MDX sequence's own
   *  MoveSpeed field (verified against the real 1.27a models: Kodo Beast's Walk=100 /
   *  Walk Fast=240 match its SLK 100/240 exactly). The renderer re-rates the walk cycle by
   *  `current speed / gait` so a slowed or hasted unit's feet stay planted — nearly every
   *  stock unit has spd > walk (Footman 270 vs 210), so they habitually walk slightly fast.
   *  Only 33 units author a distinct `run` (a "Walk Fast" clip); for the rest walk == run. */
  animWalkSpeed: number;
  animRunSpeed: number;
  animBlend: number; // Art - Animation Blend Time (unitUI "blend", seconds): cross-fade
  // duration between animation sequences. Real WC3 default is 0.15s (808 of ~836 units);
  // a handful differ (0.01/0.3/0.4/0.5/1.5). Verified against War3Patch.mpq UnitUI.slk.
  // `Animprops` ("Art - Required Animation Names", in the per-race *UnitFunc.txt profile —
  // NOT the SLK). A tiered building is ONE model whose tiers live in it as SEQUENCES:
  // TownHall.mdx carries Stand / Stand Upgrade First / Stand Upgrade Second, and HumanTower.mdx
  // carries the Scout, Guard, Cannon and Arcane towers the same way. The unit's Animprops say
  // which set is its own — the Keep is `upgrade,first`, the Castle `upgrade,second`, the Arcane
  // Tower `upgrade,third`. Without this, every tier renders as tier 1. See applyAnimProps().
  animProps: string[];
  soundSet: string; // unitUI "unitSound" label (e.g. "Footman") → UI\SoundInfo lookups
  weaponSound: string; // unitUI "weap1" weapon-impact base ("MetalMediumSlice"); "_" = none
  lumberSound: string; // unitUI "weap2" 2nd-weapon base — workers' chop ("AxeMediumChop"); "" = none
  armorSound: string; // unitUI "armor" material struck ("Metal"/"Flesh"/…) → combat-sound suffix
  icon: string; // command-card BTN icon path (from UnitFunc "art")
  description: string; // command-card tooltip body (UnitStrings "Ubertip"), WC3 markup intact
  // The command-card tooltip TITLE, exactly as the game writes it (UnitStrings
  // "Tip"): "Train |cffffcc00P|reasant" / "Build |cffffcc00F|rarm". It already
  // carries the Train/Build verb and gilds the hotkey letter, so the HUD renders
  // it verbatim rather than re-deriving either.
  tip: string;
  hotkey: string; // command hotkey letter (UnitStrings "Hotkey")
  buttonX: number; // command-card grid column (0-3), from "buttonpos"
  buttonY: number; // command-card grid row (0-2)
  isHero: boolean;
  // A hero's pool of given names (UnitStrings "Propernames", a comma-separated
  // list: "Shadowsong,Shadowfury,…,Painkiller,…"). Each hero draws one at birth
  // and the info panel titles it above the XP bar, with "Level N <Name>" inside.
  // Empty for everything that isn't a hero.
  properNames: string[];
  priority: number; // UnitData `prio`: selection sub-group order (heroes 9, Footman 6, Peasant 1) — higher sorts first & leads the group
  moveType: MoveType; // UnitData `movetp` (None for buildings/immovable units)
  isBuilding: boolean;
  pathTex: string; // pathing-footprint texture (buildings); "" for units
  // Art - Ground Texture (unitUI "uberSplat"): a 4-char UberSplatData.slk code
  // (e.g. HTOW, HMED) for the dirt/foundation decal painted on the terrain under a
  // building. "" (SLK "_") = no splat. Resolved to a texture + scale via
  // loadUberSplatRegistry (src/data/ubersplats.ts).
  uberSplat: string;
  // unitUI "nbmmIcon" — WE: "Art - Neutral Building - Show Minimap Icon". Set on the
  // neutral buildings a player can actually *use* (taverns, shops, mercenary camps,
  // fountains, laboratories, waygates, dragon roosts); clear on the scenery ones
  // (murloc/gnoll/troll huts, city buildings, centaur tents). Only the former get a
  // house glyph on the minimap.
  minimapIcon: boolean;
  // Unit shadow blob (unitUI shadow columns) — WC3's cheap "shadow system": a soft,
  // directional shadow decal painted on the terrain under the unit. `unitShadow` names a
  // texture in ReplaceableTextures\Shadows\ (Shadow, ShadowFlyer, …); "" = none (SLK "_"),
  // as on buildings (which carry `buildingShadow` instead). The quad is shadowW×shadowH
  // world units with its MIN corner at (unit − shadowX, unit − shadowY): a Footman's 140²
  // blob with a 50 offset centres at +20,+20 — north-east, i.e. the top-right screen
  // direction WC3 always casts. Verified against War3.mpq UnitUI.slk.
  unitShadow: string;
  buildingShadow: string; // per-building baked shadow texture (unitUI "buildingShadow"); "" = none
  shadowW: number;
  shadowH: number;
  shadowX: number;
  shadowY: number;
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
  /** UnitBalance.slk `regenHP` — the unit type's own hit-point regeneration (hp/sec). The sim
   *  builds a unit's live regen from its attributes and buffs (world.ts), so this is the DATA
   *  value, quoted by the tooltips that promise it ("<ucrm,regenHP> hit points per second"). */
  hpRegen: number;
  mana: number;
  armor: number;
  // UnitBalance.slk `defUp` — how much ONE level of an armour upgrade is worth to this
  // unit. WC3's armour upgrades (`rarm`: Plating, Leather Armor, Masonry) deliberately
  // ship with an EMPTY base/mod in UpgradeData.slk, because the magnitude is a property of
  // the target, not of the upgrade: 2 for a unit, 1 for a building. So Mithril Plating
  // (level 3) is +6 armour on a Footman but Imbued Masonry (level 3) is only +3 on a Farm.
  defUp: number;
  // Shop stock for a unit a shop SELLS (Tavern heroes, Mercenary Camp creeps) — the same
  // three fields as ItemDef, but from UnitBalance.slk. A Tavern hero is 1/0/135: one in
  // stock, first available 2:15 into the game, and `stockRegen` 0 means once hired it never
  // comes back — which is exactly why a neutral hero is unique across the whole match.
  stockMax: number;
  stockRegen: number;
  stockStart: number;
  // UnitBalance.slk `upgrades` ("Upgrades Used") — the upgrades that affect this unit, and
  // the reason Forged Swords arms Footmen while Gunpowder arms Riflemen even though both
  // are the same `ratd` effect: hfoo lists Rhme, hrif lists Rhra. An upgrade the unit does
  // not list is simply not applied to it.
  upgradesUsed: string[];
  foodUsed: number;
  foodMade: number;
  goldCost: number;
  lumberCost: number;
  buildTime: number;
  /** Every weapon slot the UnitWeapons row declares, in slot order. This is the real attack
   *  data; the flat `attack*` fields below are a summary of the PRIMARY slot for the HUD. */
  weapons: WeaponSlotDef[];
  // The primary weapon (the first slot `weapsOn` has switched on), flattened for the HUD
  // info card, the impact-sound lookup, and war3map.w3u's `ua1*` overrides. For the ~4 units
  // whose primary is not slot 1 (the Chimaera), this is still the attack the player sees.
  attackDamage: number; // weapon 1 base (dmgplus1); total = base + dice rolls
  attackDice: number; // number of damage dice (dice1)
  attackSides: number; // sides per damage die (sides1)
  attackCooldown: number;
  attackDamagePoint: number; // dmgpt1: delay from swing start to strike/launch (s)
  attackBackswing: number; // backSw1: the follow-through after the strike (s) — see WeaponSlot.backswing
  // Ability casting animation timing, per-unit (UnitWeapons.slk castpt/castbsw),
  // NOT per-ability. WC3's Object Editor exposes these as "Art - Animation - Cast
  // Point" / "Cast Backswing". Cast point = the wind-up the caster plays before a
  // spell takes effect (added to the ability's own Casting Time); 0 = instant.
  // Cast backswing = the recovery animation AFTER the effect — pure follow-through
  // that a new order cancels for free (the "animation canceling" micro). Verified
  // against the real 1.27 MPQ (Archmage 0.3/2.4, Paladin 0.5/1.67, MK 0.4/0.5).
  castPoint: number;
  castBackswing: number;
  attackRange: number;
  acquireRange: number; // auto-acquisition range (0 = never auto-attacks)
  canSleep: boolean; // UnitData `cansleep`: Neutral Hostile creeps of this type sleep at night
  weaponType: WeaponType; // weapTp1: Normal/Instant strike at once, the Missile kinds fly
  attackType: AttackType; // atkType1 → the damage table's row
  armorType: ArmorType; // defType → the damage table's column
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
  // Hero attributes (0 for non-heroes).
  strength: number;
  agility: number;
  intelligence: number;
  strPerLevel: number; // hero attribute growth per level (STRplus/AGIplus/INTplus)
  agiPerLevel: number;
  intPerLevel: number;
  primaryAttr: PrimaryAttribute; // None for non-heroes
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
  // Base (install) defs are immutable; a per-MAP overlay holds custom types + field
  // overrides from the map's war3map.w3u (see src/data/objectData.ts). get() checks the
  // overlay first, so a custom unit id resolves and an original-table override wins.
  // Cleared on map change (clearCustom) so one map's data never leaks into the next.
  constructor(private defs: Map<string, UnitDef>, private custom = new Map<string, UnitDef>()) {}

  get(id: string): UnitDef | undefined {
    return this.custom.get(id) ?? this.defs.get(id);
  }
  has(id: string): boolean {
    return this.custom.has(id) || this.defs.has(id);
  }
  all(): UnitDef[] {
    return [...new Map([...this.defs, ...this.custom]).values()]; // custom overrides base by id
  }
  get size(): number {
    return new Set([...this.defs.keys(), ...this.custom.keys()]).size;
  }
  byRace(race: string): UnitDef[] {
    return this.all().filter((d) => d.race === race);
  }
  /** The base (install) def for `id`, ignoring the custom overlay — the thing a
   *  custom unit clones from. */
  base(id: string): UnitDef | undefined {
    return this.defs.get(id);
  }
  /** Add/override a def in the per-map overlay (custom object data). */
  setCustom(id: string, def: UnitDef): void {
    this.custom.set(id, def);
  }
  /** Drop all custom-object-data overrides (on map change). */
  clearCustom(): void {
    this.custom.clear();
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
    const primary = toPrimaryAttribute(b ? str(b, "primary") : "");
    const isHero = primary !== PrimaryAttribute.None; // only heroes carry a primary attribute
    const strAttr = b ? num(b, "STR", 0) : 0;
    const agiAttr = b ? num(b, "AGI", 0) : 0;
    const intAttr = b ? num(b, "INT", 0) : 0;
    const realhp = b ? num(b, "realhp", 0) : 0;
    const realm = b ? num(b, "realm", 0) : 0;
    const realdef = b ? num(b, "realdef", 0) : 0;
    const primaryVal =
      primary === PrimaryAttribute.Strength ? strAttr
      : primary === PrimaryAttribute.Agility ? agiAttr
      : primary === PrimaryAttribute.Intelligence ? intAttr
      : 0;

    // Both weapon slots, then the primary (= the first one `weapsOn` enables) flattened into
    // the legacy attack* fields. A unit with no weapons row, or with weapsOn=0 (every
    // building, the Scout Tower), ends up with no slots at all and simply cannot attack.
    const slots = weaponSlots(w, fn, primaryVal);
    const prime = slots.find((s) => s.enabled) ?? slots[0];
    const animProps = fn ? (str(fn, "Animprops") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];

    defs.set(id, {
      id,
      name: (strings && str(strings, "Name")) || (u && (str(u, "Name") || str(u, "name"))) || id,
      typeName: u ? str(u, "name") : "",
      race: d ? str(d, "race") : "",
      model: unitModelPath(vfs, file, animProps),
      modelScale: u ? num(u, "modelScale", 1) : 1,
      selScale: u ? num(u, "scale", 1) : 1,
      animWalkSpeed: u ? num(u, "walk", 0) : 0,
      animRunSpeed: u ? num(u, "run", 0) : 0,
      animBlend: u ? num(u, "blend", 0.15) : 0.15,
      animProps,
      soundSet: u ? str(u, "unitSound") : "",
      weaponSound: u ? str(u, "weap1") : "",
      lumberSound: u ? str(u, "weap2") : "",
      armorSound: u ? str(u, "armor") : "",
      icon: fn ? str(fn, "art") : "",
      // Tooltip text (Name/Tip/Ubertip/Hotkey) lives in the per-race *UnitStrings*
      // INI, NOT the *UnitFunc* INI (which only holds art/buttonpos/missile). The
      // description was previously read from `fn` → always empty → generic fallback.
      description: strings ? rawTip(str(strings, "Ubertip")) : "",
      tip: strings ? rawTip(str(strings, "Tip")) : "",
      hotkey: strings ? (str(strings, "Hotkey").trim()[0] ?? "").toUpperCase() : "",
      buttonX: bx,
      buttonY: by,
      isHero,
      properNames: strings
        ? str(strings, "Propernames").split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      priority: d ? num(d, "prio", 0) : 0, // UnitData `prio` — WC3 selection-order priority
      moveType: toMoveType(d ? str(d, "movetp") : ""),
      isBuilding: (b ? num(b, "isbldg", 0) : 0) === 1,
      pathTex: d ? str(d, "pathTex") : "",
      uberSplat: u ? str(u, "uberSplat") : "", // building ground-texture code (UberSplatData.slk)
      minimapIcon: (u ? num(u, "nbmmIcon", 0) : 0) === 1,
      // Shadow decal art + geometry (see UnitDef). "_" (SLK "none") → "".
      unitShadow: u ? shadowName(str(u, "unitShadow")) : "",
      buildingShadow: u ? shadowName(str(u, "buildingShadow")) : "",
      shadowW: u ? num(u, "shadowW", 0) : 0,
      shadowH: u ? num(u, "shadowH", 0) : 0,
      shadowX: u ? num(u, "shadowX", 0) : 0,
      shadowY: u ? num(u, "shadowY", 0) : 0,
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
      hpRegen: b ? num(b, "regenHP", 0) : 0,
      mana: isHero && realm > 0 ? realm : b ? num(b, "manaN", 0) : 0,
      armor: Math.round(isHero && realdef > 0 ? realdef : b ? num(b, "def", 0) : 0),
      defUp: b ? num(b, "defUp", 0) : 0,
      stockMax: b ? num(b, "stockMax", 0) : 0,
      stockRegen: b ? num(b, "stockRegen", 0) : 0,
      stockStart: b ? num(b, "stockStart", 0) : 0,
      upgradesUsed: b ? (str(b, "upgrades") || "").split(",").map((s) => s.trim()).filter(Boolean) : [],
      foodUsed: b ? num(b, "fused", 0) : 0,
      foodMade: b ? num(b, "fmade", 0) : 0,
      goldCost: b ? num(b, "goldcost", 0) : 0,
      lumberCost: b ? num(b, "lumbercost", 0) : 0,
      buildTime: b ? num(b, "bldtm", 0) : 0,
      weapons: slots,
      attackDamage: prime?.damage ?? 0,
      attackDice: prime?.dice ?? 0,
      attackSides: prime?.sides ?? 0,
      attackCooldown: prime?.cooldown ?? 0,
      attackDamagePoint: prime?.damagePoint ?? 0,
      attackBackswing: prime?.backswing ?? 0,
      // castpt/castbsw live in UnitWeapons.slk alongside the attack timing (they
      // apply to the unit's casting, not to any one weapon). Default 0 → an instant
      // cast / no backswing for units with no weapons row (wards, most summons).
      castPoint: w ? num(w, "castpt", 0) : 0,
      castBackswing: w ? num(w, "castbsw", 0) : 0,
      attackRange: prime?.range ?? 0,
      acquireRange: w ? num(w, "acquire", 0) : 0,
      canSleep: (d ? num(d, "cansleep", 0) : 0) === 1,
      weaponType: prime?.weaponType ?? WeaponType.None,
      attackType: prime?.attackType ?? AttackType.None,
      armorType: toArmorType(b ? str(b, "defType") : ""),
      // Missile art + speed live in the per-race UnitFunc.txt (NOT UnitWeapons.slk),
      // as .mdl paths (e.g. Archmage FireBallMissile, Archer ArrowMissile).
      missileArt: prime?.missileArt ?? "",
      missileSpeed: prime?.missileSpeed ?? 900,
      // Launch/impact offsets live in UnitWeapons.slk (launchx/y/z, impactz). Verified
      // against the real 1.27 MPQ: Archmage launchx=15/launchz=66, Archer launchy=62.
      launchX: w ? num(w, "launchx", 0) : 0,
      launchY: w ? num(w, "launchy", 0) : 0,
      launchZ: w ? num(w, "launchz", 0) : 0,
      impactZ: w ? num(w, "impactz", 0) : 0,
      strength: strAttr,
      agility: agiAttr,
      intelligence: intAttr,
      strPerLevel: b ? num(b, "STRplus", 0) : 0,
      agiPerLevel: b ? num(b, "AGIplus", 0) : 0,
      intPerLevel: b ? num(b, "INTplus", 0) : 0,
      primaryAttr: primary,
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

// WC3 tooltip text (Tip/Ubertip) uses |cAARRGGBB…|r colour codes and |n line
// breaks. That markup IS the tooltip's formatting, so only the surrounding quotes
// the reader leaves on come off here; the HUD renders the rest (src/ui/wc3Text.ts).
function rawTip(v: string): string {
  return v.replace(/^"|"$/g, "").trim();
}

/** Both weapon slots of a UnitWeapons row. A slot exists only if it declares Targets
 *  Allowed (`targs`) — the SLK writes "_" in every column of an undeclared slot. `enabled`
 *  is that slot's bit in `weapsOn`; a slot can exist and be OFF, which is the whole point
 *  of the `renw` upgrades (see WeaponSlotDef). */
function weaponSlots(w: Row | undefined, fn: Row | undefined, primaryVal: number): WeaponSlotDef[] {
  if (!w) return [];
  const mask = num(w, "weapsOn", 0);
  // `Missileart` / `Missilespeed` (UnitFunc.txt) are themselves per-slot comma lists when the
  // unit has two attacks: the Flying Machine's is "GyroCopterImpact.mdl,GyroCopterMissile.mdl"
  // at speeds 2000,900 — the air shot and the bombs. One entry serves both slots (the Gryphon
  // fires the same hammer at ground and air).
  const arts = (fn ? str(fn, "missileart") : "").split(",").map((s) => s.trim()).filter(Boolean);
  const speeds = (fn ? str(fn, "missilespeed") : "").split(",").map((s) => parseFloat(s.trim())).filter((n) => !Number.isNaN(n));
  const out: WeaponSlotDef[] = [];
  for (const n of [1, 2]) {
    const targets = list(str(w, `targs${n}`));
    if (!targets.length) continue; // the row declares no such slot
    out.push({
      enabled: (mask & (1 << (n - 1))) !== 0,
      targets,
      damage: num(w, `dmgplus${n}`, 0) + primaryVal,
      dice: num(w, `dice${n}`, 0),
      sides: num(w, `sides${n}`, 0),
      cooldown: num(w, `cool${n}`, 0),
      damagePoint: num(w, `dmgpt${n}`, 0),
      backswing: num(w, `backSw${n}`, 0),
      range: num(w, `rangeN${n}`, 0),
      weaponType: toWeaponType(str(w, `weapTp${n}`)),
      attackType: toAttackType(str(w, `atkType${n}`)),
      missileArt: mdxPath(arts[n - 1] ?? arts[0] ?? ""),
      missileSpeed: speeds[n - 1] ?? speeds[0] ?? 900,
      spillDist: num(w, `spillDist${n}`, 0),
      spillRadius: num(w, `spillRadius${n}`, 0),
      damageLoss: num(w, `damageLoss${n}`, 0),
    });
  }
  return out;
}

/** A comma-separated token list, minus the SLK's "-"/"_" empties, lowercased. */
function list(v: string): string[] {
  return v.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s && s !== "_" && s !== "-");
}

// A unit's model file (UnitUI `file`, no extension) → the .mdx to load. Some models ship an SD
// variant suffixed `_V1` that carries EXTRA sequences the plain file omits — notably
// HeadHunter_V1.mdx holds the Troll Berserker's "* Alternate" clips that HeadHunter.mdx lacks.
// We only reach for `_V1` when the unit actually needs those alternate clips (its Animprops name
// `alternate`), since forcing `_V1` on every unit swaps sequence sets in ways that break some
// models' idle/stand pickers; everything else keeps the plain `.mdx`.
function unitModelPath(vfs: DataSource, file: string, animProps: string[]): string {
  const base = file.replace(/\//g, "\\");
  const wantsAlternate = animProps.includes("alternate") || animProps.includes("alternateex");
  const v1 = `${base}_V1.mdx`;
  return wantsAlternate && vfs.exists(v1) ? v1 : `${base}.mdx`;
}

// A .mdl model path from the Func profile → the .mdx the MPQ actually ships.
function mdxPath(v: string): string {
  if (!v) return "";
  const p = v.replace(/\//g, "\\").replace(/\.mdl$/i, "");
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
// Shadow texture code as stored in UnitUI.slk: "_" is the SLK's "none" sentinel → "".
function shadowName(v: string): string {
  return v === "_" ? "" : v;
}
function num(row: Row, key: string, fallback: number): number {
  const v = row.string(key);
  if (v === undefined || v === "-") return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}
