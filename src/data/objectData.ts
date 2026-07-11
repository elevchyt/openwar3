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
import type { UnitDef, UnitRegistry } from "./units";
import { mdlPath, type AbilityDef, type AbilityLevel, type AbilityRegistry } from "./abilities";
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
  ua1r: (d, v) => { d.attackRange = n(v); },
  ua1t: (d, v) => { d.attackType = toAttackType(s(v)); },
  ua1c: (d, v) => { d.attackCooldown = n(v); },
  ua1d: (d, v) => { d.attackDice = n(v); },
  ua1s: (d, v) => { d.attackSides = n(v); },
  udp1: (d, v) => { d.attackDamagePoint = n(v); },
  ucbs: (d, v) => { d.castBackswing = n(v); },
  ua1z: (d, v) => { d.missileSpeed = n(v); },
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
  if (dmgOverride !== undefined) def.attackDamage = dmgOverride + primaryVal(def);
}

/** A fresh clone of a UnitDef under a new id (arrays copied so overrides don't alias). */
function cloneDef(base: UnitDef, id: string): UnitDef {
  return { ...base, id, abilities: [...base.abilities], heroAbilities: [...base.heroAbilities], classification: [...base.classification] };
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
