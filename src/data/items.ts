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
  description: string; // Ubertip — shown on the HUD when the ground item is selected
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
  pawnable: boolean; // sellable back to a shop
  pickRandom: boolean; // eligible to fill a "random item of level N" drop slot
  maxHp: number; // item HP (destructible on the ground; 75 default in WC3)
}

export class ItemRegistry {
  /** Items eligible for random-drop tables, indexed by level then class. */
  private byLevel = new Map<number, ItemDef[]>();
  constructor(private defs: Map<string, ItemDef>) {
    for (const d of defs.values()) {
      if (!d.droppable || !d.pickRandom) continue;
      const list = this.byLevel.get(d.level) ?? [];
      list.push(d);
      this.byLevel.set(d.level, list);
    }
  }
  get(id: string): ItemDef | undefined {
    return this.defs.get(id);
  }
  has(id: string): boolean {
    return this.defs.has(id);
  }
  get size(): number {
    return this.defs.size;
  }
  all(): ItemDef[] {
    return [...this.defs.values()];
  }

  /** Resolve a dropped-item id from a creep's drop set to a concrete item. The id
   *  is either a real item rawcode ("ratf") or a "random item of level N" marker
   *  `Y<class><'I'><level>` (e.g. YkI1) that the World Editor writes for a random
   *  drop — verified against the bundled melee maps. `l`=Artifact (lv 7-8),
   *  `k`=Purchasable, `i`=Permanent, `j`=Charged, `Y…`=any. Returns null (no drop)
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

// Random-drop class-filter letters (the 2nd char of a `Y?I?` marker). Verified by
// level distribution across the bundled maps: `l` markers appear only at levels 7-8
// (the Artifact band), `k` dominates level 1 (Purchasable consumables).
const RANDOM_CLASS_BY_LETTER: Record<string, string | undefined> = {
  i: "Permanent",
  j: "Charged",
  k: "Purchasable",
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
      description: cleanTip(s ? str(s, "Ubertip") : ""),
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

// Strip WC3 tooltip markup (colour codes, line breaks) and the surrounding quotes
// the SLK reader leaves on. `<ABIL,Field>` value placeholders are kept for the sim
// to resolve against the ability data (e.g. a potion's heal amount).
function cleanTip(v: string): string {
  return v
    .replace(/^"|"$/g, "")
    .replace(/\|c[0-9a-fA-F]{8}/g, "")
    .replace(/\|r/g, "")
    .replace(/\|n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
