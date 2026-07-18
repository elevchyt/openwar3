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
// columns). Unmapped codes are ignored (the base type's value carries through), which
// is safe: an unhandled tint or tooltip field never stops the unit from spawning.

import War3MapW3u from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3u/file";
import War3MapW3d from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3d/file";
import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import { PrimaryAttribute, toArmorType, toAttackType, toMoveType } from "./enums";
import type { UnitDef, UnitRegistry, WeaponSlotDef } from "./units";
import { mdlPath, type AbilityDef, type AbilityLevel, type AbilityRegistry } from "./abilities";
import type { ItemDef, ItemRegistry } from "./items";
import type { UpgradeDef, UpgradeRegistry } from "./upgrades";
import { parseWts } from "../jass/wts";

type Val = number | string;
const s = (v: Val): string => (typeof v === "string" ? v : String(v));
const n = (v: Val): number => (typeof v === "number" ? v : parseFloat(v) || 0);

/** Model/path field → the `.mdx` the MPQ actually ships (WE stores `.mdl` or no ext). */
function normModel(v: string): string {
  return v.replace(/\//g, "\\").replace(/\.(mdl|mdx)$/i, "") + ".mdx";
}

/** The hero primary-attribute value that a hero's base attack damage adds in. */
function primaryVal(d: UnitDef): number {
  return d.primaryAttr === PrimaryAttribute.Strength ? d.strength
    : d.primaryAttr === PrimaryAttribute.Agility ? d.agility
    : d.primaryAttr === PrimaryAttribute.Intelligence ? d.intelligence
    : 0;
}

/** The unit's primary weapon slot — what the `ua1*` overrides address. A map that retunes
 *  "Attack 1" must reach the slot the sim actually swings with, not just the flat summary
 *  the HUD prints, or a custom Footman would show 40 damage and deal 12. */
function slot1(d: UnitDef): WeaponSlotDef | undefined {
  return d.weapons[0];
}

/** "Targets Allowed" as the sim wants it: lowercase tokens, minus the SLK's empties. */
function targetList(v: string): string[] {
  return v.split(",").map((x) => x.trim().toLowerCase()).filter((x) => x && x !== "_" && x !== "-");
}

// Field-code → UnitDef setter. `ua1b` (base attack damage) is handled specially
// after the loop because it folds in the primary attribute. Verified field codes /
// meaning against Units\UnitMetaData.slk.
const SETTERS: Record<string, (d: UnitDef, v: Val) => void> = {
  umdl: (d, v) => { d.model = normModel(s(v)); },
  usca: (d, v) => { d.modelScale = n(v); },
  uble: (d, v) => { d.animBlend = n(v); },
  uico: (d, v) => { d.icon = s(v).replace(/\//g, "\\").replace(/\.tga$/i, ".blp"); },
  // Movement / geometry.
  ucol: (d, v) => { d.collision = n(v); },
  umvt: (d, v) => { d.moveType = toMoveType(s(v)); },
  umvs: (d, v) => { d.speed = n(v); },
  umvh: (d, v) => { d.moveHeight = n(v); },
  umvr: (d, v) => { d.turnRate = n(v); },
  usid: (d, v) => { d.sightDay = n(v); },
  usin: (d, v) => { d.sightNight = n(v); },
  // Combat / vitals.
  uhpm: (d, v) => { d.hitPoints = n(v); },
  umpm: (d, v) => { d.mana = n(v); },
  udef: (d, v) => { d.armor = Math.round(n(v)); },
  udty: (d, v) => { d.armorType = toArmorType(s(v)); },
  uacq: (d, v) => { d.acquireRange = n(v); },
  ua1r: (d, v) => { d.attackRange = n(v); const w = slot1(d); if (w) w.range = n(v); },
  ua1t: (d, v) => { d.attackType = toAttackType(s(v)); const w = slot1(d); if (w) w.attackType = toAttackType(s(v)); },
  ua1c: (d, v) => { d.attackCooldown = n(v); const w = slot1(d); if (w) w.cooldown = n(v); },
  ua1d: (d, v) => { d.attackDice = n(v); const w = slot1(d); if (w) w.dice = n(v); },
  ua1s: (d, v) => { d.attackSides = n(v); const w = slot1(d); if (w) w.sides = n(v); },
  udp1: (d, v) => { d.attackDamagePoint = n(v); const w = slot1(d); if (w) w.damagePoint = n(v); },
  ucbs: (d, v) => { d.castBackswing = n(v); },
  ua1z: (d, v) => { d.missileSpeed = n(v); const w = slot1(d); if (w) w.missileSpeed = n(v); },
  // "Attacks Enabled" (weapsOn). A custom unit may switch a slot on or off outright — the
  // same mask the `renw` upgrades write. 1 = slot 1, 2 = slot 2, 3 = both.
  uaen: (d, v) => { d.weapons.forEach((w, i) => { w.enabled = (n(v) & (1 << i)) !== 0; }); },
  ua1g: (d, v) => { const w = slot1(d); if (w) w.targets = targetList(s(v)); },
  usd1: (d, v) => { const w = slot1(d); if (w) w.spillDist = n(v); },
  usr1: (d, v) => { const w = slot1(d); if (w) w.spillRadius = n(v); },
  udl1: (d, v) => { const w = slot1(d); if (w) w.damageLoss = n(v); },
  // Attack 2. Reaches the second slot only — a unit that declares none simply ignores these.
  ua2r: (d, v) => { const w = d.weapons[1]; if (w) w.range = n(v); },
  ua2t: (d, v) => { const w = d.weapons[1]; if (w) w.attackType = toAttackType(s(v)); },
  ua2c: (d, v) => { const w = d.weapons[1]; if (w) w.cooldown = n(v); },
  ua2d: (d, v) => { const w = d.weapons[1]; if (w) w.dice = n(v); },
  ua2s: (d, v) => { const w = d.weapons[1]; if (w) w.sides = n(v); },
  ua2b: (d, v) => { const w = d.weapons[1]; if (w) w.damage = n(v) + primaryVal(d); },
  ua2g: (d, v) => { const w = d.weapons[1]; if (w) w.targets = targetList(s(v)); },
  udp2: (d, v) => { const w = d.weapons[1]; if (w) w.damagePoint = n(v); },
  // Abilities.
  uabi: (d, v) => { d.abilities = s(v).split(",").map((x) => x.trim()).filter(Boolean); },
  uhab: (d, v) => { d.heroAbilities = s(v).split(",").map((x) => x.trim()).filter(Boolean); },
  // Hero attributes / level.
  ustr: (d, v) => { d.strength = n(v); },
  uagi: (d, v) => { d.agility = n(v); },
  uint: (d, v) => { d.intelligence = n(v); },
  ulev: (d, v) => { if (!d.isHero) d.level = n(v); }, // heroes stay level 1 (no XP system yet)
  // Economy.
  ufoo: (d, v) => { d.foodUsed = n(v); },
  ugol: (d, v) => { d.goldCost = n(v); },
  ulum: (d, v) => { d.lumberCost = n(v); },
  ubld: (d, v) => { d.buildTime = n(v); },
};

/** Apply one modified object's field overrides onto a UnitDef (mutated in place). */
function applyMods(def: UnitDef, mods: Array<{ id: string; value: Val }>, trigStr: (v: string) => string): void {
  let dmgOverride: number | undefined;
  for (const m of mods) {
    if (m.id === "unam") { def.name = trigStr(s(m.value)); continue; }
    if (m.id === "utip") { def.tip = trigStr(s(m.value)); continue; }
    if (m.id === "utub") { def.description = trigStr(s(m.value)); continue; }
    if (m.id === "uhot") { def.hotkey = (s(m.value).trim()[0] ?? "").toUpperCase(); continue; }
    if (m.id === "ua1b") { dmgOverride = n(m.value); continue; }
    SETTERS[m.id]?.(def, m.value);
  }
  // Base attack damage folds in the hero's primary attribute (as loadUnitRegistry does).
  if (dmgOverride !== undefined) {
    def.attackDamage = dmgOverride + primaryVal(def);
    const w = slot1(def);
    if (w) w.damage = def.attackDamage;
  }
}

/** A fresh clone of a UnitDef under a new id (arrays copied so overrides don't alias). The
 *  weapon slots are OBJECTS, so they need copying one level deeper — a shallow spread would
 *  leave a custom unit retuning the stock type's attack for every other player on the map. */
function cloneDef(base: UnitDef, id: string): UnitDef {
  return {
    ...base,
    id,
    abilities: [...base.abilities],
    heroAbilities: [...base.heroAbilities],
    classification: [...base.classification],
    properNames: [...base.properNames],
    weapons: base.weapons.map((w) => ({ ...w, targets: [...w.targets] })),
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

const emptyLevel = (): AbilityLevel => ({
  cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0,
  data: new Array(9).fill(NaN), buffs: [], summon: "",
});
const cloneLevel = (l: AbilityLevel): AbilityLevel => ({ ...l, data: [...l.data], buffs: [...l.buffs] });

function cloneAbility(base: AbilityDef, id: string): AbilityDef {
  return {
    ...base, id,
    levelData: base.levelData.map(cloneLevel),
    tips: [...base.tips], uberTips: [...base.uberTips], targetFlags: [...base.targetFlags], animNames: [...base.animNames],
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
// NOT applied: `Requires`/`Requiresamount`. Prerequisites live in the tech GRAPH (techtree.ts),
// which has no per-map overlay yet — a custom map that re-gates an upgrade still gets the stock
// gating. Costs, levels, names and EFFECTS all land, which is the hole that mattered: a map
// that retunes Forged Swords to +3 dice now gets +3 dice.

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
