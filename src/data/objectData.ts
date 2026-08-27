// Custom object data — war3map.w3u (Phase 7 — issue #33; see docs/triggers.md).
//
// Custom maps define their own units in war3map.w3u: a table of "custom" objects
// (a NEW 4-char id based on a base-game unit, plus field overrides) and a table of
// "original" objects (field overrides applied to a base-game unit in-place). Our
// UnitRegistry only ships the base-game types, so a custom rawcode (e.g. WarChasers'
// Shandris-based hero `EC12`) isn't found and its CreateUnit no-ops (7.2b). This
// loads the map's w3u, clones the base UnitDef, applies the overrides, and installs
// it into the registry's per-map overlay so custom units spawn with the right model,
// name, and stats.
//
// The overrides are keyed by 4-char META field codes (`umdl` = model file, `unam` =
// name, `uhpm` = HP, …). We map each to its UnitDef field directly — the codes and
// their meaning are verified against Units\UnitMetaData.slk (its `field`/`type`
// columns).
//
// **Every one of the 236 unit-usable codes is accounted for**, and that is enforced rather
// than hoped for: `UNIT_FIELD_NOTES` below names, with a reason, each code this file does not
// write, and tools/unit-fields-test.cjs walks UnitMetaData.slk and fails if a code is in
// neither table. A silently-dropped field is exactly the bug this closes — Azure Tower
// Defense's Azure Wisp is an ORIGINAL-table override of the Acolyte (`uaco`) that renames it,
// gives it the Wisp model and sets `usnd` = "Wisp", and it kept the Acolyte's voice because
// nothing here read `usnd`. Fifty-odd other codes were being dropped the same way, on both
// tables — an edited stock unit and a brand-new custom one go through this identical path.

import War3MapW3u from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3u/file";
import War3MapW3d from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3d/file";
import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import { PrimaryAttribute, toArmorType, toAttackType, toMoveType, toPrimaryAttribute, toRegenType, toWeaponType } from "./enums";
import { MISC_GAME } from "./gameplayConstants";
import { syncPrimaryWeapon, type UnitDef, type UnitRegistry, type WeaponSlotDef } from "./units";
import { emptyAbilityLevel, mdlPath, type AbilityDef, type AbilityLevel, type AbilityRegistry } from "./abilities";
import type { ItemDef, ItemRegistry } from "./items";
import type { UpgradeDef, UpgradeRegistry } from "./upgrades";
import type { TechDef, TechRegistry } from "./techtree";
import { parseWts } from "../jass/wts";

type Val = number | string;
const s = (v: Val): string => (typeof v === "string" ? v : String(v));
const n = (v: Val): number => (typeof v === "number" ? v : parseFloat(v) || 0);

/**
 * Model/path field → the `.mdx` the MPQ actually ships (WE stores `.mdl` or no ext).
 *
 * A BLANK field is not a path — it is the DUMMY UNIT, and it answers `""`. Clearing
 * "Art - Model File" in the object editor leaves a single space behind, and WC3 then draws
 * the unit with no model at all rather than refusing to make it: that is how every map builds
 * an invisible unit to carry vision, an aura or a dummy cast. Extreme Candy War places two of
 * them, named in the map's own data — `hrdh` "Dummy Cinematic Vision Horde" and `njks` "Dummy
 * Cinematic Vision Alliance", one per team, standing in the opening shot and removed the
 * moment it ends. Appending `.mdx` to the space instead asked for a file called " .mdx", and
 * a unit whose art fails to load is one this engine used to drop (see `spawnUnit` and
 * `seedModellessPlaced`) — so the cinematic played with nobody's fog lifted.
 */
function normModel(v: string): string {
  const p = v.trim().replace(/\//g, "\\").replace(/\.(mdl|mdx)$/i, "");
  return p ? `${p}.mdx` : "";
}

/** Icon field → the `.blp` the MPQ ships. Same shape as `normModel`, and for the same
 *  reason: the World Editor stores whatever the author typed into the box, which is a `.blp`,
 *  a `.tga` (the extension the import list uses) or — often — NO extension at all. Extreme
 *  Candy War writes `…\BTNproudmoore` and `…\BTNAvengingAssassin` bare, and a bare path
 *  resolves to nothing, so those two custom units came up with an empty command-card button. */
function normIcon(v: string): string {
  return v.replace(/\//g, "\\").replace(/\.(blp|tga|dds)$/i, "") + ".blp";
}

/** The hero primary-attribute value that a hero's base attack damage adds in. */
function primaryVal(d: UnitDef): number {
  return d.primaryAttr === PrimaryAttribute.Strength ? d.strength
    : d.primaryAttr === PrimaryAttribute.Agility ? d.agility
    : d.primaryAttr === PrimaryAttribute.Intelligence ? d.intelligence
    : 0;
}

/** "Targets Allowed" as the sim wants it: lowercase tokens, minus the SLK's empties. */
function targetList(v: string): string[] {
  return v.split(",").map((x) => x.trim().toLowerCase()).filter((x) => x && x !== "_" && x !== "-");
}

/** A comma list kept verbatim (case and all) — an id list, not a token list. */
function idList(v: string): string[] {
  return v.split(",").map((x) => x.trim()).filter((x) => x && x !== "_" && x !== "-");
}

/** A single SLK token: lowercased, with the table's three spellings of "none" ("", "_", "-")
 *  all collapsing to "". Matches loadUnitRegistry's reading of the same columns. */
function token(v: string): string {
  const t = v.trim().toLowerCase();
  return t === "_" || t === "-" ? "" : t;
}

/** A weapon/armour SOUND base, which is a row KEY rather than a token, so its case survives.
 *  "_"/"-" is the SLK's "this row names none" and must become "" — see units.ts soundBase(). */
function soundName(v: string): string {
  const t = v.trim();
  return t === "_" || t === "-" ? "" : t;
}

/** A shadow texture name; "_" is UnitUI's "none" sentinel (units.ts shadowName()). */
function shadowName(v: string): string {
  const t = v.trim();
  return t === "_" ? "" : t;
}

const bool01 = (v: Val): boolean => n(v) === 1;

/** One weapon SLOT, addressed the way the `ua1*` / `ua2*` code families do. A row that
 *  declares no such slot simply ignores the override, exactly as the SLK loader does. */
function slot(d: UnitDef, i: 0 | 1): WeaponSlotDef | undefined {
  return d.weapons[i];
}
/** Write one field on both slots' worth of codes with one line each. `w1`/`w2` below. */
function w1<T>(conv: (v: Val) => T, set: (w: WeaponSlotDef, v: T) => void) {
  return (d: UnitDef, v: Val): void => { const w = slot(d, 0); if (w) set(w, conv(v)); };
}
function w2<T>(conv: (v: Val) => T, set: (w: WeaponSlotDef, v: T) => void) {
  return (d: UnitDef, v: Val): void => { const w = slot(d, 1); if (w) set(w, conv(v)); };
}

/**
 * Field-code → UnitDef setter, grouped by the OBJECT EDITOR's own categories (which are
 * UnitMetaData.slk's `category` column: abil / art / combat / editor / move / path / sound /
 * stats / tech / text) so a field can be found here the way the developer sees it there.
 *
 * Five codes are NOT here and are folded in by `applyMods` after the loop instead, because
 * each writes a column the game PRECOMPUTES an attribute into and the attribute may be
 * retuned by the same object: `uhpm`/`umpm`/`udef` (a hero's realhp/realm/realdef) and
 * `ua1b`/`ua2b` (base damage + the primary attribute). Order in the modification list is the
 * map author's, not ours, so they cannot be settled until every attribute has landed.
 *
 * Codes deliberately left out entirely are in `UNIT_FIELD_NOTES`, each with its reason.
 */
export const UNIT_SETTERS: Record<string, (d: UnitDef, v: Val) => void> = {
  // --- Abilities ------------------------------------------------------------------
  uabi: (d, v) => { d.abilities = idList(s(v)); },
  uhab: (d, v) => { d.heroAbilities = idList(s(v)); },
  // "Abilities - Default Active Ability" (UnitAbilities `auto`) — which of the unit's
  // autocastable abilities starts switched ON. The Priest is trained with Heal already
  // autocasting because his row names it here; a map that moves the autocast to another
  // ability (or clears it) is writing this one field.
  udaa: (d, v) => { d.autoAbility = token(s(v)) ? s(v).trim() : ""; },

  // --- Art ------------------------------------------------------------------------
  umdl: (d, v) => { d.model = normModel(s(v)); },
  usca: (d, v) => { d.modelScale = n(v); },
  // "Art - Selection Scale" (unitUI `scale`) — the SELECTION CIRCLE's size, which is a
  // different column from the model scale above and the one the click radius is measured in
  // (SEL_RADIUS_PER_SCALE). Azure Tower Defense sets it on 37 of its types.
  ussc: (d, v) => { d.selScale = n(v); },
  uble: (d, v) => { d.animBlend = n(v); },
  // "Art - Animation - Walk/Run Speed": the gait the walk clips were AUTHORED at, which the
  // renderer re-rates the cycle against — see UnitDef.animWalkSpeed. A model swapped in by
  // `umdl` almost always wants these swapped with it, or its feet skate.
  uwal: (d, v) => { d.animWalkSpeed = n(v); },
  urun: (d, v) => { d.animRunSpeed = n(v); },
  // "Art - Required Animation Names" (`Animprops`) — which set of a multi-tier model's
  // sequences is this type's own (the Keep is `upgrade,first`). A custom building that names
  // its tier here rendered as tier 1 without this. Note this arrives too late to re-pick the
  // `_V1` model variant (units.ts unitModelPath), which only the SLK path does.
  uani: (d, v) => { d.animProps = targetList(s(v)); },
  uico: (d, v) => { d.icon = normIcon(s(v)); },
  ubpx: (d, v) => { d.buttonX = n(v); },
  ubpy: (d, v) => { d.buttonY = n(v); },
  // "Art - Tinting Color" — three 0–255 channels written as three separate codes. Each lands
  // on its own channel of the def's tint triple, so a map that reddens a unit with `uclg`
  // and `uclb` alone (which is how the editor writes it) still gets the other two.
  uclr: (d, v) => { d.tint = [n(v) / 255, d.tint[1], d.tint[2]]; },
  uclg: (d, v) => { d.tint = [d.tint[0], n(v) / 255, d.tint[2]]; },
  uclb: (d, v) => { d.tint = [d.tint[0], d.tint[1], n(v) / 255]; },
  // "Art - Ground Texture" (unitUI `uberSplat`) — the dirt/foundation decal under a building,
  // a 4-char UberSplatData.slk code. CLEARING it is the point: a map that stands a building on
  // ground it doesn't want scarred empties the field, and an empty field is a real value ("no
  // decal"), not an absence. WTii's Unit Tester empties it on all 111 of its buildings — they
  // are Human Farms wearing other models, and every one of them was drawing the Farm's
  // foundation ring on the grass underneath.
  uubs: (d, v) => { d.uberSplat = s(v).trim(); },
  // The shadow BLOB and its quad (see UnitDef.unitShadow). A custom unit wearing a model three
  // times the size of its base's kept the base's shadow footprint without these.
  ushu: (d, v) => { d.unitShadow = shadowName(s(v)); },
  ushb: (d, v) => { d.buildingShadow = shadowName(s(v)); },
  ushw: (d, v) => { d.shadowW = n(v); },
  ushh: (d, v) => { d.shadowH = n(v); },
  ushx: (d, v) => { d.shadowX = n(v); },
  ushy: (d, v) => { d.shadowY = n(v); },
  // Cast wind-up / follow-through (UnitWeapons castpt/castbsw). Both are per-UNIT, not
  // per-ability — see UnitDef.castPoint. `ucbs` was already here; `ucpt` was not, so a custom
  // caster given a 0-second cast point still played the base type's wind-up before the spell.
  ucpt: (d, v) => { d.castPoint = n(v); },
  ucbs: (d, v) => { d.castBackswing = n(v); },
  // Projectile launch offset / impact height (UnitWeapons launchx/y/z, impactz) — where the
  // missile leaves the body and how high up it lands. A custom unit on a taller model fires
  // from its base's rod height without these.
  ulpx: (d, v) => { d.launchX = n(v); },
  ulpy: (d, v) => { d.launchY = n(v); },
  ulpz: (d, v) => { d.launchZ = n(v); },
  uimz: (d, v) => { d.impactZ = n(v); },

  // --- Combat ---------------------------------------------------------------------
  // The `ua1*`/`ua2*` families write the SLOT and nothing else — the flat attack* summary on
  // the def is re-derived from the slots by syncPrimaryWeapon() once every override has
  // landed. Writing both by hand is what let `missileArt` state something `weapTp` disagreed
  // with. A unit that declares no second slot simply ignores every `*2` code.
  ua1r: w1(n, (w, v) => { w.range = v; }),
  ua2r: w2(n, (w, v) => { w.range = v; }),
  ua1t: w1((v) => toAttackType(s(v)), (w, v) => { w.attackType = v; }),
  ua2t: w2((v) => toAttackType(s(v)), (w, v) => { w.attackType = v; }),
  ua1c: w1(n, (w, v) => { w.cooldown = v; }),
  ua2c: w2(n, (w, v) => { w.cooldown = v; }),
  ua1d: w1(n, (w, v) => { w.dice = v; }),
  ua2d: w2(n, (w, v) => { w.dice = v; }),
  ua1s: w1(n, (w, v) => { w.sides = v; }),
  ua2s: w2(n, (w, v) => { w.sides = v; }),
  udp1: w1(n, (w, v) => { w.damagePoint = v; }),
  udp2: w2(n, (w, v) => { w.damagePoint = v; }),
  // "Animation Backswing Point" — the follow-through after the strike. Half of the pair the
  // renderer rates the swing clip by (see WeaponSlotDef.backswing), so retuning the damage
  // point alone left a custom unit's attack animation playing at the base type's speed.
  ubs1: w1(n, (w, v) => { w.backswing = v; }),
  ubs2: w2(n, (w, v) => { w.backswing = v; }),
  // `weapTp` — the column that says melee / instant / which missile kind. A map retuning it is
  // retuning whether the unit throws anything at all, so it has to reach the slot the sim
  // swings with; without this setter a custom "ranged Footman" stayed melee and a custom melee
  // Archer kept flying arrows.
  ua1w: w1((v) => toWeaponType(s(v)), (w, v) => { w.weaponType = v; }),
  ua2w: w2((v) => toWeaponType(s(v)), (w, v) => { w.weaponType = v; }),
  // `Missileart` — the Profile's, per slot. A custom unit that ships its own projectile art
  // (every third custom map does) was dropping it on the floor before this.
  ua1m: w1((v) => mdlPath(s(v)), (w, v) => { w.missileArt = v; }),
  ua2m: w2((v) => mdlPath(s(v)), (w, v) => { w.missileArt = v; }),
  ua1z: w1(n, (w, v) => { w.missileSpeed = v; }),
  ua2z: w2(n, (w, v) => { w.missileSpeed = v; }),
  // "Attack N - Weapon Sound" (`weapType1/2`) — the clang, per slot. Named one letter apart
  // from `ua1w` above and meaning something else entirely; see WeaponSlotDef.weaponSound.
  ucs1: w1((v) => soundName(s(v)), (w, v) => { w.weaponSound = v; }),
  ucs2: w2((v) => soundName(s(v)), (w, v) => { w.weaponSound = v; }),
  ua1g: w1((v) => targetList(s(v)), (w, v) => { w.targets = v; }),
  ua2g: w2((v) => targetList(s(v)), (w, v) => { w.targets = v; }),
  // Line-splash ("spill"), both slots. Only slot 1 was reachable before.
  usd1: w1(n, (w, v) => { w.spillDist = v; }),
  usd2: w2(n, (w, v) => { w.spillDist = v; }),
  usr1: w1(n, (w, v) => { w.spillRadius = v; }),
  usr2: w2(n, (w, v) => { w.spillRadius = v; }),
  udl1: w1(n, (w, v) => { w.damageLoss = v; }),
  udl2: w2(n, (w, v) => { w.damageLoss = v; }),
  // AREA splash — the three concentric rings an artillery shot lands in (`Farea`/`Harea`/
  // `Qarea`) and what the burst may CATCH (`splashTargs`, which is not the same list as what
  // the shot may be aimed at). A custom tower given an area of effect had none of it: 42 of
  // Azure Tower Defense's overrides are these five codes.
  ua1f: w1(n, (w, v) => { w.areaFull = v; }),
  ua2f: w2(n, (w, v) => { w.areaFull = v; }),
  ua1h: w1(n, (w, v) => { w.areaHalf = v; }),
  ua2h: w2(n, (w, v) => { w.areaHalf = v; }),
  ua1q: w1(n, (w, v) => { w.areaQuarter = v; }),
  ua2q: w2(n, (w, v) => { w.areaQuarter = v; }),
  // …and the FRACTION each outer ring gets, which is not fixed at a half and a quarter — see
  // WeaponSlotDef.areaHalfFactor.
  uhd1: w1(n, (w, v) => { w.areaHalfFactor = v; }),
  uhd2: w2(n, (w, v) => { w.areaHalfFactor = v; }),
  uqd1: w1(n, (w, v) => { w.areaQuarterFactor = v; }),
  uqd2: w2(n, (w, v) => { w.areaQuarterFactor = v; }),
  ua1p: w1((v) => targetList(s(v)), (w, v) => { w.splashTargets = v; }),
  ua2p: w2((v) => targetList(s(v)), (w, v) => { w.splashTargets = v; }),
  // "Attack N - Show UI" — whether this attack gets an ATTACK COMMAND on the card. What
  // separates a tower you can aim from a Necropolis you cannot; see WeaponSlotDef.showUI.
  uwu1: w1(bool01, (w, v) => { w.showUI = v; }),
  uwu2: w2(bool01, (w, v) => { w.showUI = v; }),
  // "Attacks Enabled" (weapsOn). A custom unit may switch a slot on or off outright — the
  // same mask the `renw` upgrades write. 1 = slot 1, 2 = slot 2, 3 = both. This can MOVE which
  // slot is primary, which is the other reason the summary is re-derived rather than patched.
  uaen: (d, v) => { d.weapons.forEach((w, i) => { w.enabled = (n(v) & (1 << i)) !== 0; }); },
  uacq: (d, v) => { d.acquireRange = n(v); },
  udty: (d, v) => { d.armorType = toArmorType(s(v)); },
  // "Combat - Armor Sound Type" (unitUI `armor`) — the MATERIAL struck (Flesh/Metal/Wood),
  // which pairs with the attacker's weapon sound to name a UnitCombatSounds row. Not the
  // damage-table armour class, which is `udty` right above.
  uarm: (d, v) => { d.armorSound = soundName(s(v)); },
  // "Combat - Defense Upgrade Bonus" — what ONE level of an armour upgrade is worth to this
  // type (2 for a unit, 1 for a building), because WC3 leaves the magnitude off the upgrade.
  udup: (d, v) => { d.defUp = n(v); },
  // "Combat - Targeted As" — the class this unit answers to in a Targets Allowed list. See
  // UnitDef.targType: it is data, and the obvious derivation gets 17 stock rows wrong.
  utar: (d, v) => { d.targType = targetList(s(v))[0] ?? ""; },

  // --- Movement -------------------------------------------------------------------
  umvt: (d, v) => { d.moveType = toMoveType(s(v)); },
  umvs: (d, v) => { d.speed = n(v); },
  umvh: (d, v) => { d.moveHeight = n(v); },
  umvr: (d, v) => { d.turnRate = n(v); },

  // --- Pathing --------------------------------------------------------------------
  ucol: (d, v) => { d.collision = n(v); },
  // "Pathing - Pathing Map" — the building FOOTPRINT texture. A custom building on a bigger
  // model kept its base's footprint, so it could be squeezed into a gap it does not fit.
  upat: (d, v) => { d.pathTex = s(v).trim(); },
  // "Pathing - Placement Requires" — the one thing the ground has to BE (`blighted`, and in
  // stock data nothing else). See UnitDef.requirePlace: the column IS the rule, so a custom
  // map's own blight-bound building works for free once this is read.
  upar: (d, v) => { d.requirePlace = token(s(v)); },
  // "Pathing - AI Placement Type" (UnitData `buffType`) — the building's PICK CATEGORY
  // (townhall/resource/factory/buffer), which is what a Staff of Preservation's "Building
  // Types Allowed" mask is a mask over. Nothing to do with buffs; see UnitDef.buffType.
  uabt: (d, v) => { d.buffType = token(s(v)); },

  // --- Sound ----------------------------------------------------------------------
  // "Sound - Unit Sound Set" (unitUI `unitSound`) — the label every voice line, the death
  // sound and the portrait's talking head are looked up under (UI\SoundInfo\*). THE reported
  // bug: Azure Tower Defense's Azure Wisp is `uaco` (the Acolyte) wearing the Wisp model, and
  // it kept answering in the Acolyte's voice because this code was not read.
  usnd: (d, v) => { d.soundSet = s(v).trim(); },

  // --- Stats ----------------------------------------------------------------------
  // Hero attributes and their per-level growth. The base values feed back into hit points,
  // mana, armour and attack damage — folded in by applyMods once the whole list has landed.
  ustr: (d, v) => { d.strength = n(v); },
  uagi: (d, v) => { d.agility = n(v); },
  uint: (d, v) => { d.intelligence = n(v); },
  ustp: (d, v) => { d.strPerLevel = n(v); },
  uagp: (d, v) => { d.agiPerLevel = n(v); },
  uinp: (d, v) => { d.intPerLevel = n(v); },
  // "Stats - Primary Attribute" — which attribute carries the hero's attack damage. Moving it
  // moves the damage with it (see the fold in applyMods).
  upra: (d, v) => { d.primaryAttr = toPrimaryAttribute(s(v)); },
  ulev: (d, v) => { if (!d.isHero) d.level = n(v); }, // heroes stay level 1 (no XP system yet)
  // Vitals. `uhpm`/`umpm`/`udef` are folded in by applyMods (see the header) — these are the
  // rest of the block.
  uhpr: (d, v) => { d.hpRegen = n(v); },
  // Passive regeneration's RULE, not its rate (UnitBalance `regenType`): a custom unit that
  // heals in daylight is a map rewriting this, not `uhpr`.
  uhrt: (d, v) => { d.regenType = toRegenType(s(v)); },
  umpi: (d, v) => { d.manaStart = n(v); }, // the mana a caster is BORN with, not its maximum
  umpr: (d, v) => { d.manaRegen = n(v); }, // mana/sec for a NON-hero caster
  usid: (d, v) => { d.sightDay = n(v); },
  usin: (d, v) => { d.sightNight = n(v); },
  // "Stats - Is a Building". A custom unit that becomes (or stops being) a building changes
  // rally points, repair, the `structure` target key and its whole command card with it.
  ubdg: (d, v) => { d.isBuilding = bool01(v); },
  // "Stats - Can Sleep" — whether a Neutral Hostile creep of this type sleeps at night.
  usle: (d, v) => { d.canSleep = bool01(v); },
  // "Stats - Transported Size" — how many SEATS this unit takes in a cargo hold, which is not
  // one for the siege roster. See UnitDef.cargoSize.
  ucar: (d, v) => { d.cargoSize = Math.max(1, n(v)); },
  // "Stats - Race" — which race's tech tree, upkeep and AI this type belongs to.
  urac: (d, v) => { d.race = token(s(v)); },
  // "Stats - Unit Classification" — mechanical / undead / peon / ancient / ward / summoned…
  // Far more than a label: it decides whether the unit leaves a raisable corpse, whether Heal
  // touches it, whether a Wisp is consumed by it. Azure Tower Defense re-classes 12 types.
  utyp: (d, v) => { d.classification = targetList(s(v)); },
  // "Stats - Priority" — selection sub-group order, i.e. which unit of a mixed selection the
  // portrait and the voice belong to.
  upri: (d, v) => { d.priority = n(v); },
  // "Stats - Hide Minimap Display" is the OTHER neutral-building flag; this one is
  // "Show Neutral Building Icon" — the house glyph a usable neutral building wears.
  unbm: (d, v) => { d.minimapIcon = bool01(v); },
  // Economy.
  ufoo: (d, v) => { d.foodUsed = n(v); },
  ufma: (d, v) => { d.foodMade = n(v); }, // a custom Farm that supplies nothing was this
  ugol: (d, v) => { d.goldCost = n(v); },
  ulum: (d, v) => { d.lumberCost = n(v); },
  ubld: (d, v) => { d.buildTime = n(v); },
  // What a REPAIR is priced and timed against, which is its own basis and not the build one —
  // see UnitDef.goldRep. The repair ability takes its 35%/150% cut of these.
  ugor: (d, v) => { d.goldRep = n(v); },
  ulur: (d, v) => { d.lumberRep = n(v); },
  urtm: (d, v) => { d.repairTime = n(v); },
  // Bounty — what killing this unit PAYS (a flat base plus a dice roll, exactly like weapon
  // damage). The single most-overridden family in a tower-defence map: Azure Tower Defense
  // writes these 312 times, and every creep was paying its BASE type's bounty instead.
  ubdi: (d, v) => { d.bountyDice = n(v); },
  ubsi: (d, v) => { d.bountySides = n(v); },
  ubba: (d, v) => { d.bountyPlus = n(v); },
  ulbd: (d, v) => { d.lumberBountyDice = n(v); },
  ulbs: (d, v) => { d.lumberBountySides = n(v); },
  ulba: (d, v) => { d.lumberBountyPlus = n(v); },
  // Shop SHELF (UnitBalance stockMax/stockRegen/stockStart) — what a `Sellunits` ware costs in
  // TIME rather than gold. A unit with `stockMax` 0 is not stocked at all, which the sim reads
  // as "not stock-limited"; a tester map that puts every creep in the game on a shelf sets
  // these per ware, so without them a shop either hands out unlimited copies or (with a
  // `stockStart` the map meant to zero) makes you wait out the stock creep's own delay.
  usma: (d, v) => { d.stockMax = n(v); },
  usrg: (d, v) => { d.stockRegen = n(v); },
  usst: (d, v) => { d.stockStart = n(v); },

  // --- Techtree -------------------------------------------------------------------
  // Everything a building OFFERS (Trains/Builds/Researches/Requires/…) is a tech-GRAPH field
  // and is applied by applyMapTechData at the bottom of this file, off the same .w3u. This is
  // the one tech-category code that is a UnitDef field instead: "Techtree - Upgrades Used",
  // the list of upgrades that may touch this unit at all. Forged Swords arms Footmen and not
  // Riflemen because of this column, so a custom unit that lists none is a custom unit no
  // upgrade reaches.
  upgr: (d, v) => { d.upgradesUsed = idList(s(v)); },
};

/**
 * Unit field codes this file does NOT write, and why. Kept as data rather than as prose so
 * tools/unit-fields-test.cjs can assert that `UNIT_SETTERS` ∪ these ∪ the text/vitals codes cover
 * every unit-usable row of UnitMetaData.slk — an override that goes missing again fails a
 * test instead of quietly reverting a unit to its base type.
 *
 * Three kinds live here: fields the WORLD EDITOR keeps for itself (which palette a type shows
 * in), fields the tech GRAPH owns (applied by applyMapTechData off this same file), and
 * fields naming an engine behaviour this project has not built yet. The last group is the
 * to-do list: give the behaviour a UnitDef field and it moves up into UNIT_SETTERS.
 */
export const UNIT_FIELD_NOTES: Record<string, string> = {
  // Owned by the tech graph — applyMapTechData reads these off the same war3map.w3u.
  ubui: "tech graph (Builds)", udep: "tech graph (DependencyOr)", umki: "tech graph (Makeitems)",
  ureq: "tech graph (Requires)", ures: "tech graph (Researches)", urev: "tech graph (Revive)",
  urq1: "tech graph (Requires1)", urq2: "tech graph (Requires2)", urq3: "tech graph (Requires3)",
  urq4: "tech graph (Requires4)", urq5: "tech graph (Requires5)", urq6: "tech graph (Requires6)",
  urq7: "tech graph (Requires7)", urq8: "tech graph (Requires8)", urqa: "tech graph (Requiresamount)",
  urqc: "tech graph (Requirescount)", usei: "tech graph (Sellitems)", useu: "tech graph (Sellunits)",
  utra: "tech graph (Trains)", uupt: "tech graph (Upgrade)",

  // World-Editor-only: which palette/tileset a type is offered under, and whether the editor
  // draws a placement helper for it. None of it survives into a running match.
  ucam: "editor palette only (campaign)", udro: "editor palette only (dropItems)",
  uhos: "editor palette only (hostilePal)", uine: "editor palette only (inEditor)",
  uspe: "editor palette only (special)", util: "editor palette only (tilesets)",
  utss: "editor palette only (tilesetSpecific)", uuch: "editor placement helper (useClickHelper)",
  unsf: "editor palette only (EditorSuffix)",

  // Art we do not drive yet. Each names a real WC3 behaviour; the note is the feature that
  // has to exist before the field has anywhere to land.
  uaap: "no attachment system (Attachmentanimprops)", ualp: "no attachment system (Attachmentlinkprops)",
  ubpr: "no per-bone art overrides (Boneprops)",
  ucua: "no caster-upgrade art (Casterupgradeart)", ussi: "no score screen (ScoreScreenIcon)",
  uspa: "no per-unit Specialart hook", utaa: "no per-unit Targetart hook",
  udtm: "no per-type death-clip length yet (death) — the renderer times the Death clip off the MDX",
  uept: "no elevation sampling (elevPts)", uerd: "no elevation sampling (elevRad)",
  ufrd: "fog radius is taken from sight, not fogRad", uocc: "no occluder height (occH)",
  ulos: "no fat line-of-sight (fatLOS)", uver: "no SD/HD asset split (fileVerFlags)",
  umxp: "no terrain pitch/roll on models (maxPitch)", umxr: "no terrain pitch/roll on models (maxRoll)",
  uori: "orientInterp — turnRate carries the turn; no interpolation mode",
  uprw: "no propulsion window (propWin)", uscb: "no bull-scaling (scaleBull)",
  usew: "no selection circle on water flag", ushr: "no shadow-on-water flag",
  uslz: "no selection-circle Z offset (selZ)",
  utcc: "no custom team colour (customTeamColor)", utco: "no team-colour override (teamColor)",
  uisz: "no swim launch/impact heights (impactSwimZ)", ulsz: "no swim launch/impact heights (launchSwimZ)",

  // Combat we do not model yet.
  // `deathType` is a two-bit field (1 = raisable, 2 = decays), and it IS the game's answer to
  // "does this leave a corpse". The sim reaches the same answer a different way — through the
  // classification (utyp, which is applied), the hero flag and the air/ground split, each with
  // its own citation in world.ts — so wiring this in means replacing that rule wholesale
  // rather than adding a field. Left for that change, not for this one.
  udea: "deathType — corpse rules come from classification + hero/air instead; see world.ts",
  udu1: "dmgUp1 — every one of the 837 stock rows leaves it empty", udu2: "dmgUp2 — likewise empty on every stock row",
  uamn: "minRange — no minimum attack range; 6 stock rows carry one (the mortar/siege pair)",
  uma1: "no missile arc (Missilearc)", uma2: "no missile arc (Missilearc)",
  umh1: "missiles always home (MissileHoming)", umh2: "missiles always home (MissileHoming)",
  urb1: "no ranged range buffer (RngBuff1)", urb2: "no ranged range buffer (RngBuff2)",
  utc1: "no multi-target attacks (targCount1)", utc2: "no multi-target attacks (targCount2)",

  // Movement / pathing we do not model yet.
  umas: "maxSpd — no speed clamp of either kind is applied yet, per-type or global",
  umis: "minSpd — no speed clamp of either kind is applied yet, per-type or global",
  umvf: "no move floor (moveFloor)", uabr: "no AI buffer radius (buffRadius)",
  upap: "no placement-prevention list (preventPlace)", upaw: "no water-radius placement (requireWaterRadius)",
  urpo: "no unit repulsion (repulse)", urpg: "no unit repulsion (repulseGroup)",
  urpp: "no unit repulsion (repulseParam)", urpr: "no unit repulsion (repulsePrio)",

  // Sound labels we do not drive yet. `usnd` (the sound SET) is applied; these four are the
  // per-type one-off labels beside it.
  ubsl: "no per-building looping sound (BuildingSoundLabel)",
  umsl: "no movement sound (MovementSoundLabel)", ursl: "no ambient random sound (RandomSoundLabel)",
  ulfi: "no looping-sound fades (LoopingSoundFadeIn)", ulfo: "no looping-sound fades (LoopingSoundFadeOut)",

  // Stats we do not model yet.
  ucbo: "no build-on-top (canBuildOn)", uibo: "no build-on-top (isBuildOn)",
  ufle: "canFlee — no creep flee behaviour (and only 2 stock rows clear it)", ufor: "no formation ranks (formation)",
  upoi: "no score screen (points)",
  uhhb: "no hero bar hiding (hideHeroBar)", uhhd: "no hero death message (hideHeroDeathMsg)",
  uhhm: "no hero minimap glyph hiding (hideHeroMinimap)", uhom: "hideOnMinimap — 0 on all 836 stock rows; no engine hook",
  unbr: "no random neutral-building rolls (nbrandom)",
  urva: "no altar revive-at list (Reviveat)",

  // Text we do not print yet.
  ides: "Description — the HUD prints Ubertip (utub), which IS applied",
  uawt: "no sleeping-creep awaken tip (Awakentip)",
  ucun: "no caster-upgrade name (Casterupgradename)", ucut: "no caster-upgrade tip (Casterupgradetip)",
  upru: "nameCount — the proper-name pool's length is taken from upro itself",
};

/** The five codes `applyMods` folds in after the loop, plus the text codes it resolves
 *  through the .wts. Listed for the coverage test — they are handled, just not in UNIT_SETTERS. */
export const UNIT_DEFERRED_FIELDS = ["uhpm", "umpm", "udef", "ua1b", "ua2b", "unam", "upro", "utip", "utpr", "utub", "uhot"];

/**
 * Apply one modified object's field overrides onto a UnitDef (mutated in place).
 *
 * Two things happen after the loop rather than inside it, because both depend on values the
 * loop may still be changing and the modification ORDER is the map author's:
 *
 *  1. **The attribute fold.** UnitBalance ships a hero's level-1 stats PRECOMPUTED —
 *     `realhp` = hp + STR×25, `realm` = manaN + INT×15, `realdef` = def − 2 + AGI×0.3, and
 *     `dmgplus1` + the primary attribute — and loadUnitRegistry stores those folded values.
 *     The object editor exposes only the BASE column, so `uhpm` = 500 on a hero means 500
 *     *before* its Strength. Applying it raw is how a custom hero came out with a fraction of
 *     the hit points the map gave it; and a bare `ustr` override has to move hp and damage
 *     with it even though it names neither.
 *  2. **syncPrimaryWeapon**, which re-derives the flat attack* summary from the slots. Doing
 *     it once, HERE, is what makes a custom unit obey exactly the rules a stock one does —
 *     including "a melee slot shows no missile art", which the base row may satisfy and an
 *     override then break (`ua1w` = normal on an Archer) or the other way about.
 */
function applyMods(def: UnitDef, mods: Array<{ id: string; value: Val }>, trigStr: (v: string) => string): void {
  // What the clone's folded values already contain, before any of this object's overrides.
  const was = { str: def.strength, agi: def.agility, int: def.intelligence, primary: primaryVal(def) };
  // The RAW (un-folded) values an override states, if it states them at all.
  let rawHp: number | undefined;
  let rawMana: number | undefined;
  let rawArmor: number | undefined;
  const rawDmg: Array<number | undefined> = [undefined, undefined];

  for (const m of mods) {
    switch (m.id) {
      case "unam": def.name = trigStr(s(m.value)); continue;
      // Proper Names (`upro` → the Profile's `Propernames`, a stringList): the pool a HERO draws
      // its given name from, which is the name the HUD and the hover label actually print for one
      // (hud.ts prefers properName over the type name). A custom hero that ships its own name —
      // WarChasers' "Snake Aes" on a Priestess of the Moon — otherwise inherits the base hero's
      // pool and rolls a Priestess name at spawn. Resolved BEFORE splitting: the whole list is one
      // TRIGSTR_ reference, so splitting first would hand the .wts a key it can't find.
      case "upro": def.properNames = idList(trigStr(s(m.value))); continue;
      case "utip": def.tip = trigStr(s(m.value)); continue;
      case "utpr": def.reviveTip = trigStr(s(m.value)); continue; // Revivetip — the altar's button title
      case "utub": def.description = trigStr(s(m.value)); continue;
      case "uhot": def.hotkey = (trigStr(s(m.value)).trim()[0] ?? "").toUpperCase(); continue;
      case "uhpm": rawHp = n(m.value); continue;
      case "umpm": rawMana = n(m.value); continue;
      case "udef": rawArmor = n(m.value); continue;
      case "ua1b": rawDmg[0] = n(m.value); continue;
      case "ua2b": rawDmg[1] = n(m.value); continue;
      default: UNIT_SETTERS[m.id]?.(def, m.value);
    }
  }

  // 1. The attribute fold. A stated base is re-folded against the FINAL attributes; an
  //    unstated one keeps the clone's already-folded value and moves by the attribute delta.
  //    Non-heroes carry no attributes, so both arms collapse to "use what was stated".
  const hero = def.isHero;
  if (rawHp !== undefined) def.hitPoints = rawHp + (hero ? def.strength * MISC_GAME.StrHitPointBonus : 0);
  else if (hero) def.hitPoints += (def.strength - was.str) * MISC_GAME.StrHitPointBonus;
  if (rawMana !== undefined) def.mana = rawMana + (hero ? def.intelligence * MISC_GAME.IntManaBonus : 0);
  else if (hero) def.mana += (def.intelligence - was.int) * MISC_GAME.IntManaBonus;
  if (rawArmor !== undefined) {
    def.armor = Math.round(rawArmor + (hero ? MISC_GAME.AgiDefenseBase + def.agility * MISC_GAME.AgiDefenseBonus : 0));
  } else if (hero) {
    def.armor = Math.round(def.armor + (def.agility - was.agi) * MISC_GAME.AgiDefenseBonus);
  }
  const primary = primaryVal(def);
  def.weapons.forEach((w, i) => {
    if (rawDmg[i] !== undefined) w.damage = rawDmg[i]! + primary;
    else w.damage += primary - was.primary;
  });

  // 2. The slots are settled; re-derive the flat attack* view from them.
  syncPrimaryWeapon(def);
}

/** A fresh clone of a UnitDef under a new id (arrays copied so overrides don't alias). The
 *  weapon slots are OBJECTS, so they need copying one level deeper — a shallow spread would
 *  leave a custom unit retuning the stock type's attack for every other player on the map.
 *  Every array on the def is copied, including the ones only the newer setters reach
 *  (`animProps`, `upgradesUsed`, a slot's `splashTargets`): a setter that REPLACES its array
 *  is safe either way, but one that is ever changed to mutate in place would otherwise reach
 *  through into the install's own def. */
function cloneDef(base: UnitDef, id: string): UnitDef {
  return {
    ...base,
    id,
    abilities: [...base.abilities],
    heroAbilities: [...base.heroAbilities],
    classification: [...base.classification],
    properNames: [...base.properNames],
    animProps: [...base.animProps],
    upgradesUsed: [...base.upgradesUsed],
    tint: [base.tint[0], base.tint[1], base.tint[2]],
    weapons: base.weapons.map((w) => ({ ...w, targets: [...w.targets], splashTargets: [...w.splashTargets] })),
  };
}

/**
 * Load a map's war3map.w3u custom units into the registry's per-map overlay. Returns
 * how many custom types were installed. `wtsBytes` (war3map.wts) resolves TRIGSTR_
 * name references; without it names stay as their raw key.
 */
/** Build a TRIGSTR_-resolver from a map's war3map.wts bytes (identity if none). */
function makeTrigStr(wtsBytes?: Uint8Array): (v: string) => string {
  const table = wtsBytes ? parseWts(new TextDecoder("utf-8").decode(wtsBytes)) : null;
  return (v: string): string => {
    if (!table || !v.startsWith("TRIGSTR_")) return v;
    const id = parseInt(v.slice("TRIGSTR_".length), 10);
    return Number.isNaN(id) ? v : table.get(id) ?? v;
  };
}

export function applyMapUnitData(registry: UnitRegistry, w3uBytes: Uint8Array, wtsBytes?: Uint8Array): number {
  const trigStr = makeTrigStr(wtsBytes);

  const w3u = new War3MapW3u();
  w3u.load(w3uBytes);
  let count = 0;

  // Custom table: NEW unit ids, each based on (oldId) an existing type.
  for (const obj of w3u.customTable.objects) {
    const base = registry.base(obj.oldId) ?? registry.get(obj.oldId);
    if (!base) continue; // base type unknown (chained custom / non-unit) — skip, don't crash
    const def = cloneDef(base, obj.newId);
    applyMods(def, obj.modifications, trigStr);
    registry.setCustom(obj.newId, def);
    count++;
  }
  // Original table: field overrides applied to a base-game type in-place (overlay it).
  for (const obj of w3u.originalTable.objects) {
    const base = registry.base(obj.oldId);
    if (!base) continue;
    const def = cloneDef(base, obj.oldId);
    applyMods(def, obj.modifications, trigStr);
    registry.setCustom(obj.oldId, def);
    count++;
  }
  return count;
}

// --- custom abilities (war3map.w3a) --------------------------------------------
//
// Abilities are level-indexed (a field has a value per rank) and their DataA..DataI
// columns use PER-ABILITY field codes (Holy Light's heal amount is `Hhb1`, Critical
// Strike's chance is `Ocr1`), so — unlike units — we can't hard-map codes. Instead we
// route every override through Units\AbilityMetaData.slk: its `field` column names the
// target (`Area`, `Cool`, `Data`, …) and `data` gives the DataA..I slot (1–9). The
// modification's `levelOrVariation` is the rank (0 = level-independent).

interface AbilMod { id: string; levelOrVariation: number; value: Val }

const emptyLevel = emptyAbilityLevel; // the canonical blank rank — see src/data/abilities.ts
const cloneLevel = (l: AbilityLevel): AbilityLevel => ({ ...l, data: [...l.data], dataStr: [...l.dataStr], buffs: [...l.buffs] });

function cloneAbility(base: AbilityDef, id: string): AbilityDef {
  return {
    ...base, id,
    levelData: base.levelData.map(cloneLevel),
    tips: [...base.tips], uberTips: [...base.uberTips], targetFlags: [...base.targetFlags], animNames: [...base.animNames],
    lightning: [...base.lightning],
    buffFx: base.buffFx.map((f) => ({ ...f, attach: [...f.attach] })),
  };
}

/** Apply one custom ability's modifications, routed through AbilityMetaData. */
function applyAbilityMods(def: AbilityDef, mods: AbilMod[], meta: MappedData, trigStr: (v: string) => string): void {
  // Grow levelData to cover the highest rank any override touches (+ an `alev` bump).
  let maxLevel = def.levels;
  for (const m of mods) {
    maxLevel = Math.max(maxLevel, m.levelOrVariation);
    if (m.id === "alev") maxLevel = Math.max(maxLevel, n(m.value));
  }
  while (def.levelData.length < maxLevel) def.levelData.push(cloneLevel(def.levelData[def.levelData.length - 1] ?? emptyLevel()));
  if (maxLevel > def.levels) def.levels = maxLevel;

  for (const m of mods) {
    const row = meta.getRow(m.id) as { string(k: string): string | undefined } | undefined;
    if (!row) continue;
    const field = row.string("field") ?? "";
    const lvl = def.levelData[Math.max(0, m.levelOrVariation - 1)];
    switch (field) {
      // Level-independent.
      case "Name": def.name = trigStr(s(m.value)); break;
      case "Art": def.icon = s(m.value).replace(/\//g, "\\"); break;
      case "hero": def.isHero = n(m.value) === 1; def.research = def.isHero; break;
      case "levels": def.levels = n(m.value); break;
      case "Hotkey": def.hotkey = (s(m.value).trim()[0] ?? "").toUpperCase(); break;
      case "Missileart": def.missileArt = mdlPath(s(m.value)); break;
      case "CasterArt": def.casterArt = mdlPath(s(m.value)); break;
      case "TargetArt": def.targetArt = mdlPath(s(m.value)); break;
      case "SpecialArt": def.specialArt = mdlPath(s(m.value)); break;
      case "Effectart": def.effectArt = mdlPath(s(m.value)); break;
      case "Areaeffectart": def.areaArt = mdlPath(s(m.value)); break;
      case "EffectSound": def.effectSound = s(m.value).trim(); break; // a SLK label, not a path
      // Per-level.
      case "Area": if (lvl) lvl.area = n(m.value); break;
      case "Cool": if (lvl) lvl.cooldown = n(m.value); break;
      case "Cost": if (lvl) lvl.cost = n(m.value); break;
      case "Dur": if (lvl) lvl.duration = n(m.value); break;
      case "HeroDur": if (lvl) lvl.heroDuration = n(m.value); break;
      case "Rng": if (lvl) lvl.castRange = n(m.value); break;
      case "Cast": if (lvl) lvl.castTime = n(m.value); break;
      case "targs": def.targetFlags = s(m.value).split(",").map((x) => x.trim()).filter((x) => x && x !== "_"); break;
      case "Tip": def.tips[Math.max(0, m.levelOrVariation - 1)] = trigStr(s(m.value)); break;
      case "Ubertip": def.uberTips[Math.max(0, m.levelOrVariation - 1)] = trigStr(s(m.value)); break;
      case "Data": {
        // DataA..DataI slot from the meta `data` column (1–9). Behaviour (Holy Light's
        // heal, Critical Strike's chance) reads these off `code`, which the clone kept.
        const slot = parseInt(row.string("data") ?? "0", 10) - 1;
        if (lvl && slot >= 0 && slot < lvl.data.length) lvl.data[slot] = n(m.value);
        break;
      }
      default: break; // unhandled field (race, buttonpos, buff art, …) — inherit from base
    }
  }
}

/**
 * Load a map's war3map.w3a custom abilities into the registry overlay. Returns how
 * many were installed. `metaBytes` = the install's Units\AbilityMetaData.slk (routes
 * each 4-char field code to its column/data slot); without it nothing can be applied.
 */
export function applyMapAbilityData(registry: AbilityRegistry, w3aBytes: Uint8Array, metaBytes: Uint8Array, wtsBytes?: Uint8Array): number {
  const meta = new MappedData(new TextDecoder("windows-1252").decode(metaBytes));
  const trigStr = makeTrigStr(wtsBytes);
  const w3a = new War3MapW3d();
  w3a.load(w3aBytes);
  let count = 0;

  for (const obj of w3a.customTable.objects) {
    const base = registry.base(obj.oldId) ?? registry.get(obj.oldId);
    if (!base) continue; // base ability unknown — skip (the clone would have no `code`)
    const def = cloneAbility(base, obj.newId);
    applyAbilityMods(def, obj.modifications as AbilMod[], meta, trigStr);
    registry.setCustom(obj.newId, def);
    count++;
  }
  for (const obj of w3a.originalTable.objects) {
    const base = registry.base(obj.oldId);
    if (!base) continue;
    const def = cloneAbility(base, obj.oldId);
    applyAbilityMods(def, obj.modifications as AbilMod[], meta, trigStr);
    registry.setCustom(obj.oldId, def);
    count++;
  }
  return count;
}

// --- custom upgrades (war3map.w3q) ----------------------------------------------
//
// Same shape as abilities: level-indexed (an upgrade renames and re-prices itself per rank),
// so it uses the same War3MapW3d parser and the same "route the 4-char code through the game's
// own MetaData SLK" trick — here Units\UpgradeMetaData.slk, whose `field` column names the
// UpgradeData column each code writes (`gglb` → goldbase, `gef1` → effect1). Its `repeat`
// column says which fields are per-LEVEL (Name/Tip/Ubertip/Hotkey/Art/Requires) and which are
// flat; `levelOrVariation` on the modification carries the rank (0 = level-independent).
//
// NOT applied HERE: `Requires`/`Requiresamount`. Prerequisites are not an UpgradeDef field at
// all — they live in the tech GRAPH, so `greq`/`grqc` are picked up by applyMapTechData at the
// bottom of this file, which reads the same .w3q. Costs, levels, names and EFFECTS land here.

const UPGRADE_SETTERS: Record<string, (d: UpgradeDef, v: Val) => void> = {
  grac: (d, v) => { d.race = s(v); },
  gcls: (d, v) => { d.className = s(v); },
  glvl: (d, v) => { d.maxLevel = Math.max(1, n(v)); },
  gglb: (d, v) => { d.goldBase = n(v); },
  gglm: (d, v) => { d.goldMod = n(v); },
  glmb: (d, v) => { d.lumberBase = n(v); },
  glmm: (d, v) => { d.lumberMod = n(v); },
  gtib: (d, v) => { d.timeBase = n(v); },
  gtim: (d, v) => { d.timeMod = n(v); },
  // Buttonpos is TWO codes writing one field name, so these can only be told apart by code.
  gbpx: (d, v) => { d.buttonX = n(v); },
  gbpy: (d, v) => { d.buttonY = n(v); },
};

/** An upgrade's up-to-4 effect slots (`effect1..4` + `base`/`mod`/`code`), by field code. */
function applyEffectMod(def: UpgradeDef, field: string, value: Val): boolean {
  const m = /^(effect|base|mod|code)([1-4])$/.exec(field);
  if (!m) return false;
  // Address the effect by its SLOT, not by its position in the array: the loader skips empty
  // slots, so effects[0] is not necessarily effect1 — and the slot is what a tooltip's
  // "<Rhan,base1>" names (src/data/tipRefs.ts).
  const slot = parseInt(m[2], 10);
  let e = def.effects.find((x) => x.slot === slot);
  if (!e) {
    e = { slot, effect: "", base: 0, mod: 0, code: "" };
    def.effects.push(e);
  }
  if (m[1] === "effect") e.effect = s(value);
  else if (m[1] === "base") e.base = n(value);
  else if (m[1] === "mod") e.mod = n(value);
  else e.code = s(value);
  return true;
}

/** A per-level string list (names/tips/icons/hotkeys), grown to fit the rank being set. */
function setLevel(list: string[], level: number, value: string): void {
  const i = Math.max(0, level - 1);
  while (list.length <= i) list.push(list[list.length - 1] ?? "");
  list[i] = value;
}

function cloneUpgrade(base: UpgradeDef, id: string): UpgradeDef {
  return {
    ...base, id,
    effects: base.effects.map((e) => ({ ...e })),
    names: [...base.names], tips: [...base.tips], uberTips: [...base.uberTips],
    hotkeys: [...base.hotkeys], icons: [...base.icons],
  };
}

function applyUpgradeMods(def: UpgradeDef, mods: AbilMod[], meta: MappedData, trigStr: (v: string) => string): void {
  for (const m of mods) {
    const row = meta.getRow(m.id) as { string(k: string): string | undefined } | undefined;
    if (!row) continue;
    const field = row.string("field") ?? "";
    const lvl = Math.max(1, m.levelOrVariation);
    if (UPGRADE_SETTERS[m.id]) { UPGRADE_SETTERS[m.id](def, m.value); continue; }
    if (applyEffectMod(def, field, m.value)) continue;
    switch (field) {
      case "Name": setLevel(def.names, lvl, trigStr(s(m.value))); break;
      case "Tip": setLevel(def.tips, lvl, trigStr(s(m.value))); break;
      case "Ubertip": setLevel(def.uberTips, lvl, trigStr(s(m.value))); break;
      case "Hotkey": setLevel(def.hotkeys, lvl, s(m.value)); break;
      case "Art": setLevel(def.icons, lvl, s(m.value).replace(/\//g, "\\")); break;
      default: break; // Requires/Requiresamount (see above), EditorSuffix, inherit, global
    }
  }
}

/**
 * Load a map's war3map.w3q custom upgrades into the registry overlay. Returns how many were
 * installed. `metaBytes` = the install's Units\UpgradeMetaData.slk, which routes each 4-char
 * field code to its UpgradeData column; without it nothing can be applied.
 */
export function applyMapUpgradeData(registry: UpgradeRegistry, w3qBytes: Uint8Array, metaBytes: Uint8Array, wtsBytes?: Uint8Array): number {
  const meta = new MappedData(new TextDecoder("windows-1252").decode(metaBytes));
  const trigStr = makeTrigStr(wtsBytes);
  const w3q = new War3MapW3d(); // level-indexed, like abilities
  w3q.load(w3qBytes);
  let count = 0;

  for (const obj of w3q.customTable.objects) {
    const base = registry.base(obj.oldId) ?? registry.get(obj.oldId);
    if (!base) continue;
    const def = cloneUpgrade(base, obj.newId);
    applyUpgradeMods(def, obj.modifications as AbilMod[], meta, trigStr);
    registry.setCustom(obj.newId, def);
    count++;
  }
  for (const obj of w3q.originalTable.objects) {
    const base = registry.base(obj.oldId);
    if (!base) continue;
    const def = cloneUpgrade(base, obj.oldId);
    applyUpgradeMods(def, obj.modifications as AbilMod[], meta, trigStr);
    registry.setCustom(obj.oldId, def);
    count++;
  }
  return count;
}

// --- custom items (war3map.w3t) -------------------------------------------------
//
// Items are flat (no level data — the War3MapW3u parser, like units) and have no
// separate MetaData SLK, so — as with units — we map the 4-char field codes to
// ItemDef fields directly. An item's *behaviour* rides on the abilities it carries
// (`iabi` → abilList), dispatched off the base ability `code` in the sim, so the
// crucial fields are the ability list, class, name, and cost.

const bool = (v: Val): boolean => n(v) === 1;

const ITEM_SETTERS: Record<string, (d: ItemDef, v: Val) => void> = {
  iico: (d, v) => { d.icon = s(v).replace(/\//g, "\\"); },
  ifil: (d, v) => { d.model = normModel(s(v)); },
  isca: (d, v) => { d.scale = n(v); },
  igol: (d, v) => { d.gold = n(v); },
  ilum: (d, v) => { d.lumber = n(v); },
  ilev: (d, v) => { d.level = n(v); },
  icla: (d, v) => { d.classType = s(v); },
  iabi: (d, v) => { d.abilities = s(v).split(",").map((x) => x.trim()).filter((x) => x && x !== "_" && x !== "-"); },
  iuse: (d, v) => { d.charges = n(v); },
  icid: (d, v) => { d.cooldownGroup = s(v); },
  iusa: (d, v) => { d.usable = bool(v); },
  iper: (d, v) => { d.perishable = bool(v); },
  ipow: (d, v) => { d.powerup = bool(v); },
  idrp: (d, v) => { d.droppable = bool(v); },
  isel: (d, v) => { d.sellable = bool(v); }, // "can be sold by a shop" (JASS IsItemSellable)
  ipaw: (d, v) => { d.pawnable = bool(v); },
  iprn: (d, v) => { d.pickRandom = bool(v); },
  ihtp: (d, v) => { d.maxHp = n(v); },
  // The item's shop SHELF (ItemData stockMax/stockRegen/stockStart) — the unit twin of
  // `usma`/`usrg`/`usst` above. These are the codes the ITEM editor writes; a map that stocks
  // its own shop sets all three (the tester map sets `istr` on 273 items).
  isto: (d, v) => { d.stockMax = n(v); },
  istr: (d, v) => { d.stockRegen = n(v); },
  isst: (d, v) => { d.stockStart = n(v); },
};

function cloneItem(base: ItemDef, id: string): ItemDef {
  return { ...base, id, abilities: [...base.abilities] };
}

/**
 * Load a map's war3map.w3t custom items into the registry overlay. Returns how many
 * were installed. `wtsBytes` resolves TRIGSTR_ name/tooltip refs.
 */
export function applyMapItemData(registry: ItemRegistry, w3tBytes: Uint8Array, wtsBytes?: Uint8Array): number {
  const trigStr = makeTrigStr(wtsBytes);
  const w3t = new War3MapW3u(); // items reuse the flat unit parser (no level data)
  w3t.load(w3tBytes);
  let count = 0;

  const applyItemMods = (def: ItemDef, mods: AbilMod[]): void => {
    for (const m of mods) {
      if (m.id === "unam") { def.name = trigStr(s(m.value)); continue; }
      if (m.id === "utub" || m.id === "ides") { def.description = trigStr(s(m.value)); continue; } // Ubertip / Description
      ITEM_SETTERS[m.id]?.(def, m.value);
    }
  };
  for (const obj of w3t.customTable.objects) {
    const base = registry.base(obj.oldId) ?? registry.get(obj.oldId);
    if (!base) continue;
    const def = cloneItem(base, obj.newId);
    applyItemMods(def, obj.modifications as AbilMod[]);
    registry.setCustom(obj.newId, def);
    count++;
  }
  for (const obj of w3t.originalTable.objects) {
    const base = registry.base(obj.oldId);
    if (!base) continue;
    const def = cloneItem(base, obj.oldId);
    applyItemMods(def, obj.modifications as AbilMod[]);
    registry.setCustom(obj.oldId, def);
    count++;
  }
  return count;
}

// --- the map's own TECH TREE (war3map.w3u / .w3t / .w3a / .w3q) -------------------
//
// The bug this closes: **a custom map's buildings had empty command cards.** Everything a
// building OFFERS is a tech field — `Trains`, `Sellunits`, `Sellitems`, `Makeitems`,
// `Researches`, `Builds`, `Upgrade` — and none of them lives in an SLK. UnitMetaData.slk's
// `slk` column says **Profile** for every one, i.e. the per-race `*UnitFunc.txt` INI, which is
// exactly what `loadTechRegistry` reads and what a map's object data OVERRIDES. So a registry
// built only from the install answers "trains nothing, sells nothing" for every type a map
// declares, and `buildCommandCard` has nothing to draw.
//
// It is not a rare corner: a map that gives you a building to click is *made* of these fields.
// "WTii's Unit Tester" is ~105 pre-placed buildings, all of them a Human Farm (`hhou`) with a
// `Sellunits`/`Trains`/`Researches` list bolted on and nothing else — every one of them came up
// blank. The other half of the same bug is quieter: a CUSTOM id (`h002`) is not in the install
// graph at all, so even a Tavern-based shop (`ntav` → `n001`) lost the base type's own wares,
// because a clone inherits nothing it isn't given.
//
// So the graph gets the same per-map overlay the unit/item/ability/upgrade registries already
// have: clone the base node, apply the map's fields, install under the object's id. All four
// object files feed ONE graph because all four id spaces declare requirements the same way
// (see the header of techtree.ts) — units and items through UnitMetaData's codes, abilities
// through `areq`, upgrades through `greq`.

/** The tech fields, by their 4-char code. Verified against the install's own
 *  Units\UnitMetaData.slk (`field` / `slk` / `type` columns) — see docs/wc3-data-formats.md.
 *  `ureq` and friends carry `useitem=1` as well as `useunit=1`, so ONE table serves both the
 *  .w3u and the .w3t; the ability/upgrade files use their own `areq`/`greq` and are handled
 *  by `requiresTierOf` below. */
const TECH_LIST_SETTERS: Record<string, (d: TechDef, ids: string[]) => void> = {
  utra: (d, ids) => { d.trains = ids; }, // Trains
  useu: (d, ids) => { d.sellunits = ids; }, // Sellunits
  usei: (d, ids) => { d.sellitems = ids; }, // Sellitems
  umki: (d, ids) => { d.makeitems = ids; }, // Makeitems
  ubui: (d, ids) => { d.builds = ids; }, // Builds
  ures: (d, ids) => { d.researches = ids; }, // Researches
  uupt: (d, ids) => { d.upgrade = ids; }, // Upgrade
  udep: (d, ids) => { d.dependencyOr = ids; }, // DependencyOr
};

/** Which requirement TIER a field code writes, or -1 for "not a Requires field".
 *  `ureq` = tier 0 (`Requires`), `urq1`..`urq8` = tiers 1..8 (`Requires1`..`Requires8`).
 *  An ABILITY (`areq`) has a single tier. An UPGRADE (`greq`) is tiered by LEVEL and carries
 *  that level in the modification's `levelOrVariation` instead of in the code — handled by the
 *  caller, which is why this returns 0 for it. */
function requiresTierOf(code: string): number {
  if (code === "ureq" || code === "areq" || code === "greq") return 0;
  const m = /^urq([1-8])$/.exec(code);
  return m ? parseInt(m[1], 10) : -1;
}

/** A comma-separated id list as the graph wants it. Same "_"/"-" empties `loadTechRegistry`
 *  strips — and an EMPTY string is meaningful here rather than absent: clearing a field in the
 *  object editor is how a map says "this has no requirements at all", which is precisely what
 *  the tester map does to all 88 of its upgrades. */
function techList(v: Val): string[] {
  return s(v)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && x !== "_" && x !== "-");
}

/** Deep clone — every field is an array, and the base node is shared with the install graph. */
function cloneTech(base: TechDef, id: string): TechDef {
  return {
    ...base,
    id,
    requiresTiers: base.requiresTiers.map((t) => [...t]),
    requiresAmount: [...base.requiresAmount],
    dependencyOr: [...base.dependencyOr],
    trains: [...base.trains],
    researches: [...base.researches],
    builds: [...base.builds],
    upgrade: [...base.upgrade],
    makeitems: [...base.makeitems],
    sellitems: [...base.sellitems],
    sellunits: [...base.sellunits],
  };
}

/** One object's tech overrides, applied onto a (already cloned) node. */
function applyTechMods(def: TechDef, mods: AbilMod[], trigStr: (v: string) => string): boolean {
  let touched = false;
  for (const m of mods) {
    // The display name, for the red "Requires: …" line a gated button prints. Carried here as
    // well as on the UnitDef because a pseudo-tech (TWN2, HERO) has no unit row to read it off.
    if (m.id === "unam" || m.id === "gnam" || m.id === "anam") {
      def.name = trigStr(s(m.value)).split(",")[0]?.replace(/^"|"$/g, "").trim() || def.name;
      continue;
    }
    const listSetter = TECH_LIST_SETTERS[m.id];
    if (listSetter) { listSetter(def, techList(m.value)); touched = true; continue; }
    if (m.id === "urev") { def.revive = n(m.value) === 1; touched = true; continue; }
    if (m.id === "urqa" || m.id === "arqa" || m.id === "grqc") {
      def.requiresAmount = techList(m.value).map((x) => parseInt(x, 10) || 1);
      touched = true;
      continue;
    }
    // `Requirescount` ("Requirements - Tiers Used") only ever GROWS the tier list here: the
    // tiers themselves arrive as their own fields, and a tier the map doesn't mention keeps
    // whatever the base type had (WC3 stores the whole ladder, not a diff).
    if (m.id === "urqc") {
      const want = Math.max(1, n(m.value));
      while (def.requiresTiers.length < want) def.requiresTiers.push([]);
      touched = true;
      continue;
    }
    const tier = requiresTierOf(m.id);
    if (tier < 0) continue;
    // An upgrade's Requires is per-LEVEL and rides `levelOrVariation` (1-based), which is
    // tier `level - 1` — `Requires` gates level 1, `Requires1` gates level 2. Verified against
    // the tester map's own .w3q, which clears `greq` at lvl 2 and lvl 3 on exactly the
    // three-level Blacksmith upgrades (Rhme/Rhar/Rhla) and at lvl 1 on the single-level ones.
    const t = m.id === "greq" ? Math.max(0, (m.levelOrVariation || 1) - 1) : tier;
    while (def.requiresTiers.length <= t) def.requiresTiers.push([]);
    def.requiresTiers[t] = techList(m.value);
    touched = true;
  }
  return touched;
}

/**
 * Merge a map's own tech tree into the registry's per-map overlay. Returns how many nodes
 * were installed. Every file is optional — a map that ships none simply runs on the install's
 * graph, which is what a melee map does.
 *
 * A CUSTOM object is always installed, even when it overrides no tech field at all: a clone
 * has to inherit its base type's wares (a `ntav`-based shop still sells the Tavern's heroes).
 * An ORIGINAL-table object is installed only when it actually says something about the tech
 * tree, so a map retuning a Footman's damage doesn't fill the overlay with copies.
 */
export function applyMapTechData(
  tech: TechRegistry,
  files: { w3u?: Uint8Array; w3t?: Uint8Array; w3a?: Uint8Array; w3q?: Uint8Array },
  wtsBytes?: Uint8Array,
): number {
  const trigStr = makeTrigStr(wtsBytes);
  let count = 0;

  const merge = (oldId: string, newId: string, mods: AbilMod[]): void => {
    // An original-table object carries FOUR ZERO BYTES where a custom one carries its new
    // rawcode — not an empty string (milestone 7.29). Treat anything that isn't a real
    // rawcode as "this is an override of oldId".
    const id = newId && newId !== "\0\0\0\0" ? newId : oldId;
    const isClone = id !== oldId;
    const base = tech.get(oldId); // overlay-aware, so a chained custom inherits its parent
    const def = cloneTech(base, id);
    if (!base.id) def.name = id; // no base row at all (a Farm has no tech node) — start blank
    const touched = applyTechMods(def, mods, trigStr);
    if (!touched && !isClone) return; // a pure stat/art override — nothing for the graph
    tech.setCustom(id, def);
    count++;
  };

  const flat = (bytes?: Uint8Array): void => {
    if (!bytes) return;
    const f = new War3MapW3u(); // units + items: no level data
    f.load(bytes);
    for (const o of f.customTable.objects) merge(o.oldId, o.newId, o.modifications as AbilMod[]);
    for (const o of f.originalTable.objects) merge(o.oldId, o.newId, o.modifications as AbilMod[]);
  };
  const levelled = (bytes?: Uint8Array): void => {
    if (!bytes) return;
    const f = new War3MapW3d(); // abilities + upgrades: level-indexed
    f.load(bytes);
    for (const o of f.customTable.objects) merge(o.oldId, o.newId, o.modifications as AbilMod[]);
    for (const o of f.originalTable.objects) merge(o.oldId, o.newId, o.modifications as AbilMod[]);
  };

  // Order matters exactly as it does for the other registries: customs first, so an
  // original-table override of a type a custom cloned from lands on top of the base row
  // rather than being read through a half-built overlay.
  try { flat(files.w3u); } catch (err) { console.warn("[jass] map tech (war3map.w3u) failed (non-fatal):", err); }
  try { flat(files.w3t); } catch (err) { console.warn("[jass] map tech (war3map.w3t) failed (non-fatal):", err); }
  try { levelled(files.w3a); } catch (err) { console.warn("[jass] map tech (war3map.w3a) failed (non-fatal):", err); }
  try { levelled(files.w3q); } catch (err) { console.warn("[jass] map tech (war3map.w3q) failed (non-fatal):", err); }
  return count;
}
