import { type AbilityDef, type AbilityRegistry, tipFieldValue } from "./abilities";
import type { ItemDef, ItemRegistry } from "./items";
import type { UnitDef, UnitRegistry } from "./units";
import type { UpgradeDef, UpgradeRegistry } from "./upgrades";

// WC3 tooltip VALUE REFERENCES — the `<ID,Field>` tokens Blizzard writes its Ubertips with, so
// that a tooltip never repeats a number the data already holds:
//
//   "Increases the hit points of the Hero by <AIlf,DataA1> when worn."   (Periapt of Vitality)
//   "Contains <dust,uses> charges. |nLasts <AItb,Dur1> seconds."         (Dust of Appearance)
//
// A reference is a literal DATA-TABLE COLUMN READ, and the table is chosen by the id:
//   <AIlf,DataA1>  AbilityData.slk  row AIlf, column dataa1
//   <dust,uses>    ItemData.slk     row dust, column uses      ← an item referencing ITSELF
//   <hwat,realHP>  UnitBalance.slk  row hwat, column realhp    (the Water Elemental's HP)
//   <hrtt,mindmg2> UnitWeapons.slk  the SECOND weapon slot's minimum damage
//   <Rhan,base1>   UpgradeData.slk  row Rhan, column base1     (effect SLOT 1 — not level 1)
//
// So the trailing digit belongs to the COLUMN NAME, not to the rank being shown: an ability's
// per-level Ubertips each name their own column (Devotion Aura's level-2 string says DataA2), and
// Improved Lumber Harvesting's two Ubertips BOTH say <Rhlh,mod1> because +10 is what each rank adds.
//
// Format flags (the optional third field), verified by resolving all 2017 references in the real
// 1.27a MPQs against the tables:
//   (none)  round to a whole number — which is why Shadow Meld's Dur1 of 15.1 reads "15 seconds"
//           and a 1.01s stun reads "1". 23 of the game's references rely on this.
//   ,%      multiply by 100 (Boots of Speed's DataA1 is 0.6 → "60"; the % sign is in the sentence).
//           Every one of the 302 percent references lands on a whole number, as you'd hope.
//   ,.      keep the fraction — the flag exists for exactly one thing, Devotion Aura's +1.5 armour.
//
// Ten of Blizzard's own 2017 references name a row/column that does not exist (`<Acyc,DataC1>`,
// `<ACbr,Dur1>`, …); they are broken in the real game too. Render those as nothing rather than
// leaking the raw token onto the tooltip.

/** The object tables a reference can name. Every tooltip surface has all four to hand. */
export interface TipTables {
  abilities: AbilityRegistry;
  items: ItemRegistry;
  units: UnitRegistry;
  upgrades: UpgradeRegistry;
}

/** Fill every `<ID,Field[,fmt]>` reference in a tooltip with the value it names.
 *
 *  `self` is the ability whose tooltip this is (if any) — a reference to an id no table knows
 *  resolves against it, which is what makes a CUSTOM ability's inherited Ubertip still read
 *  correctly. `level` is the rank being shown, used only for a column that carries no rank digit. */
export function resolveTipRefs(text: string, tables: TipTables, opts: { self?: AbilityDef; level?: number } = {}): string {
  if (!text.includes("<")) return text;
  return text.replace(/<([^,>]+),([^,>]+)(?:,([^>]*))?>/g, (_m, rawId: string, rawField: string, fmt?: string) => {
    const v = lookup(rawId.trim(), rawField.trim(), tables, opts);
    if (v === null || Number.isNaN(v)) return "";
    return format(v, fmt ?? "");
  });
}

function lookup(id: string, field: string, t: TipTables, opts: { self?: AbilityDef; level?: number }): number | null {
  // Ability first: 1705 of the game's 2017 references are ability fields, and no stock id is
  // shared between two tables (an item's `dust` is not a unit, an ability's `AItb` is not an item).
  const abil = t.abilities.get(id);
  if (abil) return abilityField(abil, field, opts.level ?? 1);
  const item = t.items.get(id);
  if (item) return itemField(item, field);
  const unit = t.units.get(id);
  if (unit) return unitField(unit, field);
  const upgrade = t.upgrades.get(id);
  if (upgrade) return upgradeField(upgrade, field);
  return opts.self ? abilityField(opts.self, field, opts.level ?? 1) : null;
}

/** AbilityData.slk: the rank-indexed columns (`DataA1`, `Dur2`, `Cost1`, …). The rank in the
 *  column name wins — a Researchubertip spells out every rank in ONE string ("Level 1 - <…A1>,
 *  Level 2 - <…A2>"), so resolving them all against the shown rank would print one number thrice. */
function abilityField(def: AbilityDef, field: string, level: number): number | null {
  const named = /(\d+)$/.exec(field);
  const rank = named ? Number(named[1]) : level;
  const lvl = def.levelData[Math.min(Math.max(rank, 1), def.levelData.length) - 1];
  return lvl ? tipFieldValue(lvl, field) : null;
}

/** ItemData.slk. `uses` (charges) is the only column the game's item tooltips read, but the rest
 *  are one line each and a custom map may name any of them. */
function itemField(def: ItemDef, field: string): number | null {
  switch (field.toLowerCase()) {
    case "uses":
      return def.charges; // "Contains <dust,uses> charges."
    case "goldcost":
      return def.gold;
    case "lumbercost":
      return def.lumber;
    case "level":
      return def.level;
    case "hp":
      return def.maxHp;
    case "stockmax":
      return def.stockMax;
    case "stockregen":
      return def.stockRegen;
    case "stockstart":
      return def.stockStart;
    default:
      return null;
  }
}

/** UnitBalance.slk / UnitWeapons.slk — what a summon/morph tooltip quotes about the unit it makes
 *  ("Summons a Water Elemental with <hwat,realHP> hit points"). */
function unitField(def: UnitDef, field: string): number | null {
  const f = field.toLowerCase();
  // A weapon column names its SLOT in its trailing digit: <hrtt,mindmg2> is the upgraded Siege
  // Engine's SECOND attack (the anti-air gun), not its second level. Damage rolls as
  // `dmgplus + dice d sides`, so the floor is one pip per die and the ceiling is `sides` per die —
  // which reproduces the SLK's own precomputed mindmg/avgdmg/maxdmg columns exactly.
  const w = /^(min|max|avg)dmg(\d*)$/.exec(f);
  if (w) {
    const slot = def.weapons[(parseInt(w[2] || "1", 10) || 1) - 1];
    if (!slot) return null;
    if (w[1] === "min") return slot.damage + slot.dice;
    if (w[1] === "max") return slot.damage + slot.dice * slot.sides;
    return slot.damage + (slot.dice * (slot.sides + 1)) / 2;
  }
  switch (f) {
    case "hp":
    case "realhp":
      return def.hitPoints;
    case "regenhp":
      return def.hpRegen;
    case "manan":
    case "realm":
      return def.mana;
    case "def":
    case "realdef":
      return def.armor;
    case "spd":
      return def.speed;
    case "sight":
      return def.sightDay;
    case "nsight":
      return def.sightNight;
    case "goldcost":
      return def.goldCost;
    case "lumbercost":
      return def.lumberCost;
    case "level":
      return def.level;
    case "fused":
      return def.foodUsed;
    case "fmade":
      return def.foodMade;
    default:
      return null;
  }
}

/** UpgradeData.slk. `base1`/`mod1` name the effect SLOT (effect1..effect4) — the value AT a level
 *  is base + mod*(level-1), which is why an upgrade's own tooltip quotes the raw column: Animal
 *  War Training says <Rhan,base1> ("+150 hit points"), Improved Lumber Harvesting <Rhlh,mod1>. */
function upgradeField(def: UpgradeDef, field: string): number | null {
  const f = field.toLowerCase();
  const m = /^(base|mod)(\d*)$/.exec(f);
  if (m) {
    const slot = parseInt(m[2] || "1", 10) || 1;
    const e = def.effects.find((x) => x.slot === slot);
    return e ? (m[1] === "base" ? e.base : e.mod) : null;
  }
  switch (f) {
    case "goldbase":
      return def.goldBase;
    case "goldmod":
      return def.goldMod;
    case "lumberbase":
      return def.lumberBase;
    case "lumbermod":
      return def.lumberMod;
    case "timebase":
      return def.timeBase;
    case "timemod":
      return def.timeMod;
    case "maxlevel":
      return def.maxLevel;
    default:
      return null;
  }
}

function format(v: number, fmt: string): string {
  if (fmt.includes("%")) return String(Math.round(v * 100));
  if (fmt.includes(".")) return String(Math.round(v * 100) / 100); // 1.5 stays 1.5
  return String(Math.round(v));
}
