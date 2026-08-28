import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";
import {
  ArmorType,
  AttackType,
  MoveType,
  PrimaryAttribute,
  RegenType,
  WeaponType,
  isRangedWeapon,
  toArmorType,
  toAttackType,
  toMoveType,
  toPrimaryAttribute,
  toRegenType,
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
  weaponType: WeaponType; // weapTp1/2 — normal = melee, instant = hitscan, the rest fly
  attackType: AttackType; // atkType1/2 → the damage table's row
  /** This slot's weapon-impact base — the clang half of `<weapon><armour>`, paired with the
   *  TARGET's material to name a UnitCombatSounds row ("MetalHeavySlice" + "Flesh"). "" = a
   *  silent blow. It is `UnitWeapons.weapType1/2`, which the object editor exposes as
   *  **"Attack 1 - Weapon Sound"** (`ucs1`/`ucs2` in UnitMetaData) — NOT `weapTp1/2`, the
   *  neighbouring column with the confusingly similar name that holds normal/missile/instant.
   *  See weaponSlots() for why `UnitUI.weap1/2` is only the fallback. */
  weaponSound: string;
  /** This slot's `Missileart` AS DECLARED — a per-slot comma list in the UnitFunc profile.
   *  Whether the slot actually shows it is `weaponType`'s call: ask slotMissileArt(), never
   *  this field, or you re-open the melee-hero bug it exists to close. */
  missileArt: string;
  missileSpeed: number; // ...and so is `Missilespeed` (Flying Machine: 2000 air, 900 bombs)
  /** Line-splash ("spill") — `spillDist1/2` + `spillRadius1/2` + `damageLoss1/2`. The
   *  Gryphon Rider's hammer already carries a 50-unit spill RADIUS and a 0.2 falloff, but a
   *  spill DISTANCE of 0, so it hits one unit; Storm Hammers (`Rhhb`, `rasd` = 200) opens the
   *  distance and the same hammer starts carrying through the rank behind its target. */
  spillDist: number;
  spillRadius: number;
  damageLoss: number; // fraction of damage shed per further unit down the line
  /**
   * AREA splash — `Farea`/`Harea`/`Qarea` (the Object Editor's "Area of Effect (Full/Medium/
   * Small Damage)"), the three concentric rings an ARTILLERY shot lands in: full damage inside
   * `areaFull`, half out to `areaHalf`, a quarter out to `areaQuarter`. The Cannon Tower is
   * 50/100/125, the Demolisher 25/50/150, the Mortar Team 25/100/200. 0 = a single-target hit.
   */
  areaFull: number;
  areaHalf: number;
  areaQuarter: number;
  /**
   * What FRACTION of the damage each outer ring gets — `Hfact`/`Qfact` (the Object Editor's
   * "Damage Factor - Medium/Small Damage"). The names of the rings are a trap: they are NOT
   * fixed at a half and a quarter, and 26 of the 73 splashing slots in the game say so. The
   * Demolisher and every catapult are 0.4/0.25, the Mortar Team 0.4/0.1, the Cannon Tower
   * 0.5/0.1, the Frost Wyrm 0.2/0.1, the Glaive Thrower 0.4/0.25, the Chimaera 0.5/0.1 —
   * i.e. the entire siege roster. Two slots state no factor at all and take the half/quarter
   * the ring is named for, which is the only case the old hard-coded pair was right about.
   */
  areaHalfFactor: number;
  areaQuarterFactor: number;
  splashTargets: string[]; // `splashTargs` — what the AREA may catch (vs `targets`, what it may aim at)
  /**
   * `showUI` — "Attack N - Show UI". Whether this attack gets an ATTACK COMMAND on the card.
   *
   * This is what separates a tower from a town hall: every tower, and the Orc Burrow, ships
   * `showUI1=1` and can be told what to shoot; the fourteen rows that ship 0 are the Undead
   * halls (Necropolis / Halls of the Dead / Black Citadel) and the Night Elf Ancients — armed
   * buildings whose attack is not yours to aim. See mapViewer's building command card.
   */
  showUI: boolean;
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
  /**
   * UnitUI `red`/`green`/`blue` — "Art - Tinting Color", the model's own vertex colour as
   * 0..1 multipliers (the SLK writes 0–255, and 255,255,255 = untinted). WC3 uses it for the
   * recoloured variants it did not author a texture for (the Ghoul/Abomination greens, the
   * Chaos units), and a custom map uses it constantly: Azure Tower Defense tints 38 of its
   * types. It multiplies the model exactly as JASS `SetUnitVertexColor` does, which is the
   * same channel our fog dimming composes over — see rts.ts applyFogTint.
   */
  tint: readonly [number, number, number];
  /**
   * UnitData `targType` — "Combat - Targeted As", the class this unit answers to in another
   * unit's "Targets Allowed" list. Every row declares exactly one of `ground` / `structure` /
   * `air` / `ward`, so it is data rather than a derivation, and 17 rows disagree with the
   * obvious guess: the twelve WARDS (Serpent/Healing/Sentry/Plague/Stasis) are `ward` and not
   * `ground`, the Fountains of Health/Mana are `structure` while carrying `isbldg=0`, and one
   * flyer (`zjug`) is targeted as `ground`. See sim/world.ts targetKeyOf, which prefers this
   * over its own building/flying fallback.
   */
  targType: string;
  /** The PRIMARY slot's weapon-impact base ("MetalMediumSlice"), a view of `weapons` filled
   *  in by syncPrimaryWeapon; "" = a silent blow. Its source is the slot's own
   *  `weapType1/2`, not `UnitUI.weap1` — see WeaponSlotDef.weaponSound and weaponSlots(). */
  weaponSound: string;
  /** unitUI "weap2" — the HARVEST chop ("AxeMediumChop"), which is not a weapon slot and so
   *  stays a unit-level field; "" = none. (The Peasant and Peon write the same value in both
   *  tables, so the two readings agree where they overlap.) */
  lumberSound: string;
  armorSound: string; // unitUI "armor" material struck ("Metal"/"Flesh"/…) → combat-sound suffix
  icon: string; // command-card BTN icon path (from UnitFunc "art")
  description: string; // command-card tooltip body (UnitStrings "Ubertip"), WC3 markup intact
  // The command-card tooltip TITLE, exactly as the game writes it (UnitStrings
  // "Tip"): "Train |cffffcc00P|reasant" / "Build |cffffcc00F|rarm". It already
  // carries the Train/Build verb and gilds the hotkey letter, so the HUD renders
  // it verbatim rather than re-deriving either.
  tip: string;
  /** The same title for the REVIVE button an altar puts up when this hero is dead
   *  (UnitStrings "Revivetip"): "Revive |cffffcc00D|remon Hunter". A separate field from
   *  `tip` because the game authors it separately — `tip` says "Train", this one says
   *  "Revive", and the gilded hotkey letter can differ between them. Empty for everything
   *  that is not a hero. */
  reviveTip: string;
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
  /** UnitData `buffType` — the building's PICK CATEGORY, one of `townhall` / `resource` /
   *  `factory` / `buffer`, and "" (SLK "_") for everything that has none. The column name is
   *  a red herring: it has nothing to do with buffs. It is the unit half of the object
   *  editor's `pickFlags` domain, whose four bits UI\UnitEditorData.txt lists in exactly this
   *  order — TOWNHALL / RESOURCE / FACTORY / BUFFER — and WorldEditStrings names "Hall",
   *  "Resource", "Factory", "General". The staves' "Building Types Allowed" (ANpr/ANsa DataA
   *  = 15 = all four) is a mask over it, which is how the sim picks where a Staff of
   *  Preservation sends its target — see SimWorld.staffDestination.
   *
   *  Only 63 of the 836 rows carry one, and the split is the ranked list Liquipedia
   *  documents for the staves: `factory` = the unit/hero producers (Barracks, Workshop,
   *  Arcane Sanctum, the Altars, the Ancients of War/Lore/Wind), `buffer` = the towers, the
   *  Moon Well and the Orc Burrow, `resource` = the three gold mines, `townhall` = the
   *  twelve main halls. A Farm, Blacksmith, Lumber Mill, Arcane Vault, Gryphon Aviary,
   *  Hunter's Hall or Chimaera Roost carries none — which is exactly Liquipedia's
   *  "cannot be teleported to" list, for both races it documents. */
  buffType: string;
  /**
   * UnitData `cargoSize` — "Stats - Transported Size", how many SEATS this unit takes in a
   * cargo hold. Not a headcount: a transport ship's hold is 10 and a Demolisher, Mortar Team,
   * Kodo Beast, Glaive Thrower, Meat Wagon, Sea Giant or Goblin Sapper each cost 2 of it,
   * while a Siege Engine, Rocket Engine or Mountain Giant costs 4 — so one ship carries five
   * Demolishers or two Siege Engines, not ten of either. 1 for everything else, which is what
   * a row that states none means. See SimWorld.garrisonLoad.
   */
  cargoSize: number;
  moveType: MoveType; // UnitData `movetp` (None for buildings/immovable units)
  isBuilding: boolean;
  pathTex: string; // pathing-footprint texture (buildings); "" for units
  /** UnitBalance `requirePlace` — "Pathing - Placement Requires". The ONE thing the ground a
   *  building goes on has to be, over and above being buildable at all. Only one value is
   *  used in the whole stock table: **`blighted`**, on exactly eleven Undead structures — the
   *  Ziggurat and both its towers, the Crypt, Graveyard, Altar of Darkness, Temple of the
   *  Damned, Slaughterhouse, Boneyard, Tomb of Relics and Sacrificial Pit.
   *
   *  What is NOT in that list is the point: the Necropolis chain and the Haunted Gold Mine,
   *  which is precisely the manual's "the Necropolis and a Haunted Gold Mine can be placed on
   *  normal land" (classic.battle.net/war3/undead/basics.shtml). The column IS the rule, so
   *  nothing anywhere needs a list of ids, and a custom map's own blight-bound building works
   *  for free. Lowercased; "" when the row says none. See SimWorld.footprintBlighted. */
  requirePlace: string;
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
  /** UnitData `turnRate` (a 0..1 scale, see sim turnSpeed()). **0 means the unit CANNOT turn** —
   *  which is what the SLK's "-" says, and every structure row carries it: a Guard Tower, a
   *  Ziggurat and a Phoenix Egg all read `turnRate="-", orientInterp=0`. A tower shoots
   *  whatever comes into range from the facing it was PLACED at (its head may swivel inside
   *  its own attack clip, but the model never rotates). The uprootable Ancients are the
   *  structures that DO turn, and the data says so: `etol`/`etoa` carry turnRate 0.4. */
  turnRate: number;
  moveHeight: number; // fly altitude above ground (0 for ground units)
  collision: number;
  // Fog-of-war sight radii (UnitBalance.slk `sight`/`nsight`, world units). Night
  // is normally shorter — e.g. Footman 1400/800, Peasant 800/600, Town Hall 900/600.
  // Ultravision (the `Ault` ability) makes a unit use `sight` at night instead of `nsight`.
  // Stock melee units DO carry it — the four night elf heroes, the Archer and the Glaive
  // Thrower list it in UnitAbilities.slk — but it is gated behind the Ultravision upgrade
  // (`[Ault] Requires=Reuv`, researched at the Hunter's Hall), so a night elf takes the
  // same night penalty as everyone until that research lands. See recomputeStats.
  sightDay: number;
  sightNight: number;
  /**
   * UnitData.slk `death` — "Death Time (seconds)", the length of this type's death animation
   * (Footman 3.04, Paladin 1.5, Phoenix 0.7). The World Editor calls it "Stats - Death Time"
   * and the object-data field is `udtm`.
   *
   * It is a GAMEPLAY number, not just an art one: a unit goes on seeing for exactly this long
   * after it falls (capped by MiscData `DyingRevealRadius` — see SimWorld.kill), and a hero's
   * body is not finished with until its death clip and then its Dissipate have both run
   * (see `heroBodyTime`), which is what the altar's revive button waits on.
   */
  deathTime: number;
  hitPoints: number;
  /** UnitBalance.slk `regenHP` — the unit type's own hit-point regeneration (hp/sec). The sim
   *  adds the attribute/buff/item regen on top of this (world.ts recomputeStats), so this is
   *  the DATA value, quoted by the tooltips that promise it ("<ucrm,regenHP> hit points per
   *  second"). Only the Phoenix (`hphx`) ships a NEGATIVE one: -25, i.e. it burns down. */
  hpRegen: number;
  /** UnitBalance.slk `regenType` — WHEN `hpRegen` applies (always / night / blight / none).
   *  See RegenType: this column, not the race field, is what makes night elves heal after
   *  dark and the Undead heal only on blight. */
  regenType: RegenType;
  mana: number;
  /** UnitBalance.slk `mana0` — the mana a unit is BORN with, which is not its maximum. A
   *  Priest is trained at 75 of 200, a Sorceress at 75, a Moon Well finishes construction at
   *  100 of 300 (Liquipedia lists it as "Initial Mana"). 40 of the game's rows differ from
   *  their `manaN`, and every one of them is a caster you have to wait on. */
  manaStart: number;
  /** UnitBalance.slk `regenMana` — mana/sec for a NON-hero caster (a hero's comes from its
   *  Intelligence instead). It is a real per-type number and it spreads wide: a Sorceress
   *  0.667, a Priest 0.72, a Spirit Walker 1, a Moon Well and an Obsidian Statue 1.5. The sim
   *  used one flat approximation for all of them until this column arrived. 0 when the row
   *  has none, which is most units — they have no mana either. */
  manaRegen: number;
  armor: number;
  // UnitBalance.slk `defUp` — how much ONE level of an armour upgrade is worth to this
  // unit. WC3's armour upgrades (`rarm`: Plating, Leather Armor, Masonry) deliberately
  // ship with an EMPTY base/mod in UpgradeData.slk, because the magnitude is a property of
  // the target, not of the upgrade: 2 for a unit, 1 for a building. So Mithril Plating
  // (level 3) is +6 armour on a Footman but Imbued Masonry (level 3) is only +3 on a Farm.
  defUp: number;
  // Shop stock for a unit a shop SELLS (Tavern heroes, Mercenary Camp creeps) — the same
  // three fields as ItemDef, but from UnitBalance.slk. A Mercenary Camp bandit is 1/160/60:
  // one on the shelf, first available at 1:00, another 160 seconds after each hire.
  //
  // `stockRegen` 0 is NOT "never again" — it is "no time need pass", i.e. the ware replenishes
  // the instant it is taken and so is effectively UNLIMITED. Only 15 units in UnitBalance.slk
  // carry it and they are the Tavern heroes (1/0/135) plus a few campaign heroes: a Tavern hero
  // is gated until 2:15 by `stockStart` and from then on is always there — every player can hire
  // the Naga Sea Witch, and hiring then cancelling does not delete her from the match. (No ITEM
  // in ItemData.slk has regen 0 at all, so the shelf-empties-forever reading never had a case
  // to stand on.) See SimWorld.ShopStock.unlimited.
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
  /**
   * What a full repair is priced and timed AGAINST — UnitBalance `goldRep` / `lumberRep` /
   * `reptm` ("Stats - Repair Gold/Lumber Cost", "Stats - Repair Time"). The repair ABILITY
   * then takes its cut of them (`Arep` DataA = 0.35 of the cost, DataB = 1.5 of the time).
   *
   * Not the same as the build cost and time, which is what the engine used to substitute:
   * an upgraded tier states its own basis, so a Keep, a Castle and a Stronghold all repair
   * in 120 seconds where they were BUILT in 140, and a Scout Tower repairs in 20 where it
   * was built in 25. A custom map may move any of the three on its own.
   */
  goldRep: number;
  lumberRep: number;
  repairTime: number;
  /**
   * What killing this unit PAYS the killer — UnitBalance `bountyplus` + `bountydice`×d`bountysides`
   * ("Stats - Bounty Awarded - Base / Number of Dice / Sides per Die" in the World Editor).
   *
   * A flat base plus a dice roll, exactly like a weapon's damage (`dmgplus1`/`dice1`/`sides1`),
   * and the numbers say so: a Gnoll (`ngno`, level 1) is 3 + 1d3 = 4-6 gold, which is what a
   * level-1 creep hands over in a real melee game.
   *
   * Every unit in the game carries a bounty — a Footman is 20 + 6d3 — but who actually PAYS is a
   * per-player switch (`PLAYER_STATE_GIVES_BOUNTY`), and in melee only the creeps have it on;
   * see SimWorld.awardBounty. The lumber trio is real too and is read for a custom map's sake,
   * but no stock TFT unit sets it (verified: 0 non-zero `lumberbounty*` rows in UnitBalance.slk).
   */
  bountyDice: number;
  bountySides: number;
  bountyPlus: number;
  lumberBountyDice: number;
  lumberBountySides: number;
  lumberBountyPlus: number;
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
  weaponType: WeaponType; // weapTp1: normal = melee, instant = hitscan, the rest fly
  attackType: AttackType; // atkType1 → the damage table's row
  armorType: ArmorType; // defType → the damage table's column
  missileArt: string; // weapon-1 projectile model (MDX path, backslashes) — "" if melee
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

    // Both weapon slots. The primary (= the first one `weapsOn` enables) is flattened into the
    // legacy attack* fields afterwards, by syncPrimaryWeapon. A unit with no weapons row, or
    // with weapsOn=0 (every building, the Scout Tower), ends up with no slots at all and
    // simply cannot attack.
    const slots = weaponSlots(w, fn, primaryVal, u);
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
      // "Art - Tinting Color": three 0–255 columns, absent on an untinted row. See UnitDef.tint.
      tint: u ? [num(u, "red", 255) / 255, num(u, "green", 255) / 255, num(u, "blue", 255) / 255] : [1, 1, 1],
      targType: (d ? str(d, "targType") : "").toLowerCase().trim(),
      weaponSound: "", // a view of the primary slot — syncPrimaryWeapon fills it below
      lumberSound: soundBase(u ? str(u, "weap2") : ""),
      armorSound: soundBase(u ? str(u, "armor") : ""),
      icon: fn ? str(fn, "art") : "",
      // Tooltip text (Name/Tip/Ubertip/Hotkey) lives in the per-race *UnitStrings*
      // INI, NOT the *UnitFunc* INI (which only holds art/buttonpos/missile). The
      // description was previously read from `fn` → always empty → generic fallback.
      description: strings ? rawTip(str(strings, "Ubertip")) : "",
      tip: strings ? rawTip(str(strings, "Tip")) : "",
      reviveTip: strings ? rawTip(str(strings, "Revivetip")) : "",
      hotkey: strings ? (str(strings, "Hotkey").trim()[0] ?? "").toUpperCase() : "",
      buttonX: bx,
      buttonY: by,
      isHero,
      properNames: strings
        ? str(strings, "Propernames").split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      priority: d ? num(d, "prio", 0) : 0, // UnitData `prio` — WC3 selection-order priority
      buffType: ((d ? str(d, "buffType") : "") || "").toLowerCase().trim().replace(/^[-_]$/, ""),
      // A row that states no size takes ONE seat — the reading 518 of the 836 rows write out.
      cargoSize: Math.max(1, d ? num(d, "cargoSize", 1) : 1),
      moveType: toMoveType(d ? str(d, "movetp") : ""),
      isBuilding: (b ? num(b, "isbldg", 0) : 0) === 1,
      pathTex: d ? str(d, "pathTex") : "",
      requirePlace: ((b ? str(b, "requirePlace") : "") || "").toLowerCase().trim().replace(/^[-_]$/, ""),
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
      // "-" is NOT a missing value here, it is "no turn rate" — so it must not fall back to
      // the 0.5 default the way `num` would. See UnitDef.turnRate: 0 = this thing never rotates.
      turnRate: d && d.string("turnrate") === "-" ? 0 : d ? num(d, "turnrate", 0.5) : 0.5,
      moveHeight: d ? num(d, "moveheight", 0) : 0,
      // 1.27 layering quirk: collision lives in UnitBalance.slk in the
      // expansion/patch MPQs but in UnitData.slk in the RoC base.
      collision: (b && num(b, "collision", 0)) || (d ? num(d, "collision", 0) : 0),
      // Sight radii live in UnitBalance.slk (`sight` day / `nsight` night). Verified
      // against the real 1.27 MPQ; buildings use the same fields (Town Hall 900/600).
      sightDay: b ? num(b, "sight", 0) : 0,
      sightNight: b ? num(b, "nsight", 0) : 0,
      // UnitData.slk `death` — how long this type takes to die. See UnitDef.deathTime.
      deathTime: d ? num(d, "death", 0) : 0,
      hitPoints: isHero && realhp > 0 ? realhp : b ? num(b, "hp", 0) : 0,
      hpRegen: b ? num(b, "regenHP", 0) : 0,
      regenType: toRegenType(b ? str(b, "regenType") : ""),
      mana: isHero && realm > 0 ? realm : b ? num(b, "manaN", 0) : 0,
      manaStart: b ? num(b, "mana0", 0) : 0,
      manaRegen: b ? num(b, "regenMana", 0) : 0,
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
      // The repair basis, which defaults to the BUILD basis only when the row states none —
      // every structure states all three. See UnitDef.goldRep.
      goldRep: b ? num(b, "goldRep", num(b, "goldcost", 0)) : 0,
      lumberRep: b ? num(b, "lumberRep", num(b, "lumbercost", 0)) : 0,
      repairTime: b ? num(b, "reptm", num(b, "bldtm", 0)) : 0,
      bountyDice: b ? num(b, "bountydice", 0) : 0,
      bountySides: b ? num(b, "bountysides", 0) : 0,
      bountyPlus: b ? num(b, "bountyplus", 0) : 0,
      lumberBountyDice: b ? num(b, "lumberbountydice", 0) : 0,
      lumberBountySides: b ? num(b, "lumberbountysides", 0) : 0,
      lumberBountyPlus: b ? num(b, "lumberbountyplus", 0) : 0,
      weapons: slots,
      // The eleven "Attack 1" summary fields below are a VIEW of the primary slot, filled in
      // by syncPrimaryWeapon() once the def exists — the same call a map's overrides run
      // through — so nothing here can state what the slot does not. (Missile art and speed
      // come from the per-race UnitFunc.txt rather than UnitWeapons.slk: Archmage
      // FireBallMissile, Archer ArrowMissile.)
      attackDamage: 0,
      attackDice: 0,
      attackSides: 0,
      attackCooldown: 0,
      attackDamagePoint: 0,
      attackBackswing: 0,
      // castpt/castbsw live in UnitWeapons.slk alongside the attack timing (they
      // apply to the unit's casting, not to any one weapon). Default 0 → an instant
      // cast / no backswing for units with no weapons row (wards, most summons).
      castPoint: w ? num(w, "castpt", 0) : 0,
      castBackswing: w ? num(w, "castbsw", 0) : 0,
      attackRange: 0,
      acquireRange: w ? num(w, "acquire", 0) : 0,
      canSleep: (d ? num(d, "cansleep", 0) : 0) === 1,
      weaponType: WeaponType.None,
      attackType: AttackType.None,
      armorType: toArmorType(b ? str(b, "defType") : ""),
      missileArt: "",
      missileSpeed: 900,
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
    syncPrimaryWeapon(defs.get(id)!); // fill the attack* view from the slots just built
  }
  return new UnitRegistry(defs);
}

/**
 * The missile model a weapon slot ACTUALLY shows. **The one place this rule lives** — the SLK
 * loader, a map's `war3map.w3u` overrides and the sim all ask here, so a stock hero, a retuned
 * one and a brand-new custom unit are decided by the same line.
 *
 * `weapTp` is the only column with a vote, and it has three answers:
 *
 *   `normal`    MELEE. No art at all, however the row is written. This is the whole
 *               Warden/Demon Hunter class of bug: every hero ships a switched-off slot 2
 *               (`weapsOn` = 1, `missile`, range 500) that an orb wakes as an air attack
 *               (docs/orbs.md, `DataE` = "Enabled Attack Index"), and the ONE `Missileart` on
 *               the hero's UnitFunc row belongs to THAT slot. WardenMissile,
 *               DemonHunterMissile, BrewmasterMissile and GargoyleMissile occur nowhere else
 *               in the install — no ability, no other unit — so letting the melee slot inherit
 *               one invents a projectile the game never throws, and a missile impact sound
 *               where WC3 plays none.
 *   `instant`   RANGED hitscan. The art IS shown, but as a one-shot burst on the unit struck
 *               rather than a thing in flight — all six stock instant slots name a
 *               `*Impact.mdx` carrying a lone "Birth" sequence (see World.tickSwing).
 *   the rest    A travelling projectile (launchesMissile).
 */
export function slotMissileArt(w: WeaponSlotDef): string {
  return isRangedWeapon(w.weaponType) ? w.missileArt : "";
}

/**
 * Re-derive a UnitDef's flat "Attack 1" summary from its weapon SLOTS — the slots are the
 * truth, these fields are a view of the primary one (the first `weapsOn` enables).
 *
 * Called at load and again after a map's overrides land, so the two can never drift. They did:
 * every `ua1*` setter used to write the slot AND its own copy of the summary by hand, which is
 * how `missileArt` ended up stating something `weapTp` disagreed with — and `uaen` ("Attacks
 * Enabled") could move which slot is primary without any of the summary following it.
 */
export function syncPrimaryWeapon(def: UnitDef): void {
  const prime = def.weapons.find((s) => s.enabled) ?? def.weapons[0];
  if (!prime) return; // no weapons row at all (every building, the Scout Tower) — nothing to view
  def.attackDamage = prime.damage;
  def.attackDice = prime.dice;
  def.attackSides = prime.sides;
  def.attackCooldown = prime.cooldown;
  def.attackDamagePoint = prime.damagePoint;
  def.attackBackswing = prime.backswing;
  def.attackRange = prime.range;
  def.weaponType = prime.weaponType;
  def.attackType = prime.attackType;
  def.missileArt = slotMissileArt(prime);
  def.missileSpeed = prime.missileSpeed;
  def.weaponSound = prime.weaponSound;
}

/** A weapon/armour sound base as the SLK writes it, or "" for "this row names none". The
 *  tables spell absence three ways — an empty cell, "_" and "-" — and only "" may reach a
 *  row key, since "_" + "Flesh" is a lookup that quietly finds nothing. */
function soundBase(v: string): string {
  const s = (v || "").trim();
  return s === "_" || s === "-" ? "" : s;
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
 *  of the `renw` upgrades (see WeaponSlotDef).
 *
 *  `ui` is the unit's UnitUI row, read for ONE thing: the weapon-sound fallback. WC3 writes
 *  that sound down TWICE, in two tables, and neither copy is complete:
 *
 *    UnitWeapons `weapType1/2`  the per-ATTACK sound, and the one the object editor exposes
 *                               ("Attack 1 - Weapon Sound", `ucs1`/`ucs2`).
 *    UnitUI      `weap1/2`      a unit-level pair that usually says the same thing.
 *
 *  183 armed units agree. 60 name a sound ONLY on the slot — the Warden (MetalHeavySlice),
 *  Maiev, the Dreadlord, Anub'arak, the Mountain Giant, and every spider, turtle and murgul
 *  — and reading UnitUI alone left all 60 landing blows in total silence, which is the
 *  Warden bug. 36 name one ONLY in UnitUI (the Keeper of the Grove, Cenarius, Sylvanas…),
 *  and 32 of those carry no SND "K" event either, so reading the slot alone would silence
 *  THEM. So: the slot's own sound, and UnitUI only when the slot names none. (All 60 + 36
 *  pair with their target's material to name a real UnitCombatSounds row — checked against
 *  the install by tools/sim-weapon-sound-test.cjs.) */
function weaponSlots(w: Row | undefined, fn: Row | undefined, primaryVal: number, ui: Row | undefined): WeaponSlotDef[] {
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
    const weaponType = toWeaponType(str(w, `weapTp${n}`));
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
      weaponType,
      attackType: toAttackType(str(w, `atkType${n}`)),
      weaponSound: soundBase(str(w, `weapType${n}`)) || soundBase(ui ? str(ui, `weap${n}`) : ""),
      // …as DECLARED. Whether it is ever shown is `weapTp`'s call and is asked at every use
      // site through slotMissileArt() — never gated here, because a map may flip `weapTp`
      // (`ua1w`) on this very slot afterwards and clearing the art now would lose it.
      missileArt: mdxPath(arts[n - 1] ?? arts[0] ?? ""),
      missileSpeed: speeds[n - 1] ?? speeds[0] ?? 900,
      spillDist: num(w, `spillDist${n}`, 0),
      spillRadius: num(w, `spillRadius${n}`, 0),
      damageLoss: num(w, `damageLoss${n}`, 0),
      areaFull: num(w, `Farea${n}`, 0),
      areaHalf: num(w, `Harea${n}`, 0),
      areaQuarter: num(w, `Qarea${n}`, 0),
      // …and only when the row states NOTHING does a ring take the fraction it is named for.
      areaHalfFactor: num(w, `Hfact${n}`, 0.5),
      areaQuarterFactor: num(w, `Qfact${n}`, 0.25),
      splashTargets: list(str(w, `splashTargs${n}`)),
      // The column is missing on a custom row that never thought about it; an attack that
      // exists is one you can aim, so "not stated" reads as shown — only an explicit 0 hides it.
      showUI: num(w, `showUI${n}`, 1) !== 0,
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

/**
 * A destructible's unit def — how a gate, a crate or a barricade becomes something the sim
 * can hold, hit and kill (issue: "the gate cannot be targeted").
 *
 * WC3's own class tree has a destructable and a unit meeting one level up: both are
 * `CWidget`s, which is where life, the collider and "can this be attacked" live
 * (docs/reverse-engineering/tinkerworx-repos.md). Our sim only ever had units, so a
 * destructible existed as map geometry and a JASS handle and nothing else — no life to
 * spend, no body to stand next to, no identity a weapon could match. Rather than grow a
 * second combat path beside the unit one, an attackable destructible becomes a real sim
 * unit built from THIS def, and every existing rule — approach, fan-out, damage point,
 * backswing, death — applies to it unchanged.
 *
 * What the destructible data actually says (`Units\DestructableData.slk`):
 *   • `targType` is the weapon-target class, and weapons really do name it: every melee
 *     unit carries `ground,structure,debris,item,ward`, so `debris` (the gates and crates)
 *     is attackable by anyone and `bridge`/`decoration` are attackable by no one.
 *   • `armor` is the MATERIAL struck (Wood/Stone/Flesh) — the same thing a unit's UnitUI
 *     `armor` column is, i.e. the impact SOUND. It is not a damage-table class, and there
 *     is no destructable row in the table (`DamageBonus*` carries exactly the eight unit
 *     armour classes), so a blow lands undivided: `ArmorType.Unknown`, which the damage
 *     table already resolves to a 1.0 multiplier.
 *   • `radius` is the collider; `selectable` decides whether a click can pick it up at all.
 *
 * Everything a unit is and a destructible is not is zeroed here rather than left to a
 * default: no speed, no sight (it reveals nothing for anybody), no food, no weapons, no
 * bounty and no XP (`level` 0 — killing a gate levels nobody).
 */
export function destructibleUnitDef(d: {
  typeId: string;
  name: string;
  maxLife: number;
  radius: number;
  /** `selcircsize` — the DIAMETER of the game's selection circle, in world units. */
  selCircle: number;
  armorSound: string;
  targType: string;
  /** Bust for the portrait pane, already resolved to a real `.mdx` (or "" for none). */
  portraitModel: string;
}): UnitDef {
  return {
    // Prefixed so it can never collide with a real unit id in the registry — a
    // destructible type code (`LTe1`) and a unit type code are the same four characters
    // drawn from different tables.
    id: `dest:${d.typeId}`,
    name: d.name || "Destructible",
    typeName: "destructible",
    race: "other",
    // The renderer never spawns a body for one of these (the doodad batch already drew it),
    // so `model` is read for exactly one thing: the selection portrait. The data ships a
    // dedicated bust for that — the doodad's own model is a piece of terrain.
    model: d.portraitModel,
    modelScale: 1,
    // The selection circle, which is the field the CLICK is measured against, and it is
    // NOT `radius`. `radius` is the "Elevation Sample Radius" — 50 on every gate in the
    // game, so a 640-unit-long Elven Gate could only be picked within a stride of its
    // centre, and the far half of it read as terrain. `selcircsize` ("Selection Size -
    // Game") is what the data sizes a selection by, and it says 512 for those same gates,
    // 128 for a tree, 60 for a crate. `selScale` is a MULTIPLE of the 72-unit circle a
    // unit at scale 1 wears (SEL_RADIUS_PER_SCALE), so the diameter converts by 72.
    selScale: (d.selCircle || d.radius * 2 || 72) / 72,
    animWalkSpeed: 0,
    animRunSpeed: 0,
    animBlend: 0.15,
    animProps: [],
    soundSet: "",
    tint: [1, 1, 1],
    // A destructible's own weapon-target class is carried in `classification` (see the tail of
    // this def) because that is where SimUnit.targetKey reads it from; this field is the UNIT
    // table's column and a destructible has no row in it.
    targType: "",
    weaponSound: "",
    lumberSound: "",
    armorSound: d.armorSound,
    icon: "",
    description: "",
    tip: "",
    reviveTip: "",
    hotkey: "",
    buttonX: 0,
    buttonY: 0,
    isHero: false,
    properNames: [],
    priority: 0,
    buffType: "",
    cargoSize: 1, // a destructible is never carried
    moveType: MoveType.None,
    // Not a BUILDING: `isBuilding` carries a tail of building behaviour with it (rally
    // points, a production queue, repair, the "structure" weapon-target key). Immobility
    // comes from MoveType.None and speed 0 instead, and the target key from `targType`.
    isBuilding: false,
    pathTex: "", // the map loader already stamped the destructible's own footprint
    requirePlace: "", // a destructible is never PLACED by a player
    uberSplat: "",
    minimapIcon: false,
    unitShadow: "",
    buildingShadow: "",
    shadowW: 0,
    shadowH: 0,
    shadowX: 0,
    shadowY: 0,
    speed: 0,
    turnRate: 0,
    moveHeight: 0,
    collision: d.radius,
    sightDay: 0,
    sightNight: 0,
    deathTime: 0,
    hitPoints: d.maxLife,
    hpRegen: 0,
    regenType: RegenType.None,
    mana: 0,
    manaStart: 0,
    manaRegen: 0,
    armor: 0,
    defUp: 0,
    stockMax: 0,
    stockRegen: 0,
    stockStart: 0,
    upgradesUsed: [],
    foodUsed: 0,
    foodMade: 0,
    goldCost: 0,
    lumberCost: 0,
    buildTime: 0,
    goldRep: 0, // a destructible is never repaired
    lumberRep: 0,
    repairTime: 0,
    bountyDice: 0,
    bountySides: 0,
    bountyPlus: 0,
    lumberBountyDice: 0,
    lumberBountySides: 0,
    lumberBountyPlus: 0,
    weapons: [],
    attackDamage: 0,
    attackDice: 0,
    attackSides: 0,
    attackCooldown: 0,
    attackDamagePoint: 0,
    attackBackswing: 0,
    castPoint: 0,
    castBackswing: 0,
    attackRange: 0,
    acquireRange: 0,
    canSleep: false,
    weaponType: WeaponType.None,
    attackType: AttackType.None,
    // See the header: no destructable row in the damage table → no multiplier.
    armorType: ArmorType.Unknown,
    missileArt: "",
    missileSpeed: 0,
    launchX: 0,
    launchY: 0,
    launchZ: 0,
    impactZ: 0,
    strength: 0,
    agility: 0,
    intelligence: 0,
    strPerLevel: 0,
    agiPerLevel: 0,
    intPerLevel: 0,
    primaryAttr: PrimaryAttribute.None,
    level: 0,
    abilities: [],
    heroAbilities: [],
    autoAbility: "",
    // The weapon-target class, verbatim from `targType`. SimUnit.targetKey reads it.
    classification: [`targ:${d.targType}`],
  };
}
