import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";

// Item data registry (issue #22). Merges WC3's ItemData.slk (numbers/flags),
// ItemFunc.txt (icon + ground model) and ItemStrings.txt (name/tooltip) into one
// lookup keyed by item id (rawcode, e.g. "ratf" = Claws of Attack +15).
//
// An item's *behaviour* — the stat bonus it grants, the potion it drinks, the
// tome it consumes — lives in the ABILITIES it carries (`abillist`), dispatched
// off the base ability `code` in the sim (world.ts `itemBonuses`/`useItem`/
// `applyPowerup`), exactly like unit spells dispatch off `code`. So this module
// stays pure data; the item ability rows are already loaded by the AbilityRegistry
// (flagged `isItem`). Verified 2026-07 against the real 1.27a MPQ (ItemData.slk).

export interface ItemDef {
  id: string; // item rawcode
  name: string;
  description: string; // Ubertip, WC3 markup intact — shown on the HUD when the ground item is selected
  icon: string; // command-button BLP path (ItemFunc "Art")
  model: string; // ground model (.mdx) shown where the item lies (ItemData "file")
  scale: number; // ground-model scale
  gold: number; // gold cost (buy) / sell base
  lumber: number;
  level: number; // item level (drives random drop tables + camp difficulty)
  classType: string; // Permanent/Charged/Purchasable/Artifact/PowerUp/Miscellaneous/Campaign
  abilities: string[]; // ability ids this item grants (first is the primary)
  charges: number; // `uses` — starting charges (0 = passive/unlimited)
  cooldownGroup: string; // `cooldownid` — items in the same group share a use cooldown
  usable: boolean; // has an active, player-triggered effect (potions, scrolls, wands)
  perishable: boolean; // destroyed when its charges hit 0
  powerup: boolean; // consumed instantly on pickup (tomes, runes, gold) — never stored
  droppable: boolean; // can be dropped / dropped by a creep
  sellable: boolean; // a shop may sell it (JASS IsItemSellable) — distinct from pawnable
  pawnable: boolean; // sellable back to a shop
  pickRandom: boolean; // eligible to fill a "random item of level N" drop slot
  maxHp: number; // item HP (destructible on the ground; 75 default in WC3)
}

export class ItemRegistry {
  /** Items eligible for random-drop tables, indexed by level then class. */
  private byLevel = new Map<number, ItemDef[]>();
  // Per-map custom overlay from war3map.w3t (see src/data/objectData.ts), mirroring
  // UnitRegistry: get() checks it first; cleared on map change.
  constructor(private defs: Map<string, ItemDef>, private custom = new Map<string, ItemDef>()) {
    this.rebuildByLevel();
  }
  private rebuildByLevel(): void {
    this.byLevel.clear();
    for (const d of new Map([...this.defs, ...this.custom]).values()) {
      if (!d.droppable || !d.pickRandom) continue;
      const list = this.byLevel.get(d.level) ?? [];
      list.push(d);
      this.byLevel.set(d.level, list);
    }
  }
  get(id: string): ItemDef | undefined {
    return this.custom.get(id) ?? this.defs.get(id);
  }
  has(id: string): boolean {
    return this.custom.has(id) || this.defs.has(id);
  }
  get size(): number {
    return new Set([...this.defs.keys(), ...this.custom.keys()]).size;
  }
  all(): ItemDef[] {
    return [...new Map([...this.defs, ...this.custom]).values()];
  }
  /** The base (install) def for `id`, ignoring the custom overlay. */
  base(id: string): ItemDef | undefined {
    return this.defs.get(id);
  }
  setCustom(id: string, def: ItemDef): void {
    this.custom.set(id, def);
    this.rebuildByLevel(); // a custom droppable/random item joins the drop tables
  }
  clearCustom(): void {
    this.custom.clear();
    this.rebuildByLevel();
  }

  /** ChooseRandomItem / ChooseRandomItemEx (JASS, 7.18) — a random item of a class and
   *  level, drawn from the same "eligible for a random drop" pool the creep drop tables
   *  use (`droppable` + `pickRandom`). `classType` null = any class (ITEM_TYPE_ANY);
   *  `level` < 0 = any level (common.j's documented "-1 for any level"). Null when the
   *  pool is empty — the native then returns 0, as the engine does. */
  chooseRandom(classType: string | null, level: number, rng: () => number): ItemDef | null {
    const pool: ItemDef[] = [];
    for (const [lvl, defs] of this.byLevel) {
      if (level >= 0 && lvl !== level) continue;
      for (const d of defs) if (!classType || d.classType === classType) pool.push(d);
    }
    return pool.length ? pool[Math.floor(rng() * pool.length)] ?? null : null;
  }

  /** Resolve a dropped-item id from a creep's drop set to a concrete item. The id
   *  is either a real item rawcode ("ratf") or a "random item of level N" marker
   *  `Y<class><'I'><level>` (e.g. YkI1) that the World Editor writes for a random
   *  drop — verified against the bundled melee maps. `i`=Permanent, `j`=Charged,
   *  `k`=PowerUp (tomes), `l`=Artifact, `Y…`=any (see RANDOM_CLASS_BY_LETTER).
   *  Returns null (no drop)
   *  when the id is unknown/empty (e.g. the "gold" coins marker we don't drop). */
  resolveDrop(id: string, rng: () => number): ItemDef | null {
    if (!id) return null;
    const direct = this.defs.get(id);
    if (direct) return direct;
    const m = /^Y(.)I(\d)$/.exec(id);
    if (!m) return null;
    const classLetter = m[1];
    const level = parseInt(m[2], 10);
    const wantClass = RANDOM_CLASS_BY_LETTER[classLetter];
    const pool = this.byLevel.get(level);
    if (!pool || !pool.length) return null;
    const filtered = wantClass ? pool.filter((d) => d.classType === wantClass) : pool;
    const use = filtered.length ? filtered : pool; // class pool empty → any item at this level
    return use[Math.floor(rng() * use.length)] ?? null;
  }
}

// Random-drop class-filter letters (the 2nd char of a `Y?I?` marker). The letter is
// `'h' + WC3 item-class index` (Permanent=1, Charged=2, PowerUp=3, Artifact=4), with a
// literal `Y` meaning "any class". Verified by decoding the drop markers across all 161
// bundled maps AND cross-checking each letter's level band against the class inventory:
// `i` (Permanent) spans lv 1-6, `j` (Charged) lv 1-6, `k` (PowerUp = tomes/manuals) is
// overwhelmingly lv 1-2 (the tome band), `l` (Artifact) appears ONLY at lv 7-8. The
// earlier `k`=Purchasable guess was wrong: it silently sent every `YkI1`/`YkI2` slot —
// the single most common drop marker in the game — through the "no items of that class,
// fall back to any" path, diluting tomes out of existence. `k`=PowerUp fixes tome drops.
const RANDOM_CLASS_BY_LETTER: Record<string, string | undefined> = {
  i: "Permanent",
  j: "Charged",
  k: "PowerUp",
  l: "Artifact",
  Y: undefined, // "any class"
};

interface Row {
  string(key: string): string | undefined;
}

export function loadItemRegistry(vfs: DataSource): ItemRegistry {
  const defs = new Map<string, ItemDef>();
  const bytes = vfs.rawBytes("Units\\ItemData.slk");
  if (!bytes) return new ItemRegistry(defs);
  const data = new MappedData(new TextDecoder("windows-1252").decode(bytes));

  const func = new MappedData();
  const fb = vfs.rawBytes("Units\\ItemFunc.txt");
  if (fb) func.load(new TextDecoder("windows-1252").decode(fb));
  const strs = new MappedData();
  const sb = vfs.rawBytes("Units\\ItemStrings.txt");
  if (sb) strs.load(new TextDecoder("windows-1252").decode(sb));

  for (const id of Object.keys(data.map)) {
    const r = data.getRow(id) as Row | undefined;
    if (!r) continue;
    // Skip SLK header/comment artefacts (no real class column).
    const classType = str(r, "class");
    if (!classType) continue;
    const f = func.getRow(id) as Row | undefined;
    const s = strs.getRow(id) as Row | undefined;
    const abilities = (str(r, "abilList") || "")
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a && a !== "_" && a !== "-");
    defs.set(id, {
      id,
      name: (s && str(s, "Name")) || id,
      description: rawTip(s ? str(s, "Ubertip") : ""),
      icon: f ? str(f, "Art") : "",
      model: itemModel(str(r, "file")),
      scale: num(r, "scale", 1),
      gold: num(r, "goldcost", 0),
      lumber: num(r, "lumbercost", 0),
      level: num(r, "level", 0),
      classType,
      abilities,
      charges: num(r, "uses", 0),
      cooldownGroup: str(r, "cooldownid"),
      usable: num(r, "usable", 0) === 1,
      perishable: num(r, "perishable", 0) === 1,
      powerup: num(r, "powerup", 0) === 1,
      droppable: num(r, "droppable", 0) === 1,
      sellable: num(r, "sellable", 0) === 1,
      pawnable: num(r, "pawnable", 0) === 1,
      pickRandom: num(r, "pickRandom", 0) === 1,
      maxHp: num(r, "hp", 75),
    });
  }
  return new ItemRegistry(defs);
}

// Ground-model paths in the data are ".mdl"; the MPQ ships compiled ".mdx".
// Fall back to the generic treasure chest (what the SLK uses for most items).
function itemModel(v: string): string {
  const pick = (v || "").split(",")[0]?.trim();
  const p = (pick || "Objects\\InventoryItems\\TreasureChest\\treasurechest.mdl").replace(/\//g, "\\").replace(/\.mdl$/i, "");
  return /\.mdx$/i.test(p) ? p : `${p}.mdx`;
}

// Strip only the surrounding quotes the SLK reader leaves on. The WC3 markup
// (`|cAARRGGBB`, `|r`, `|n`) is the tooltip's own formatting and is kept for the
// HUD to render (src/ui/wc3Text.ts); so are the `<ABIL,Field>` value placeholders,
// which the sim resolves against the ability data (e.g. a potion's heal amount).
function rawTip(v: string): string {
  return v.replace(/^"|"$/g, "").trim();
}

function str(row: Row, key: string): string {
  const v = row.string(key);
  return v === undefined || v === "-" ? "" : v;
}
function num(row: Row, key: string, fallback: number): number {
  const v = row.string(key);
  if (v === undefined || v === "-" || v === "") return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}
