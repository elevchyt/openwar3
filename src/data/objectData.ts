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
import { PrimaryAttribute, toArmorType, toAttackType, toMoveType } from "./enums";
import type { UnitDef, UnitRegistry } from "./units";
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
export function applyMapUnitData(registry: UnitRegistry, w3uBytes: Uint8Array, wtsBytes?: Uint8Array): number {
  const table = wtsBytes ? parseWts(new TextDecoder("utf-8").decode(wtsBytes)) : null;
  const trigStr = (v: string): string => {
    if (!table || !v.startsWith("TRIGSTR_")) return v;
    const id = parseInt(v.slice("TRIGSTR_".length), 10);
    return Number.isNaN(id) ? v : table.get(id) ?? v;
  };

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
