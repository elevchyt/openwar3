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
  moveType: string; // foot | fly | horse | hover | float | amph | "" (building/immovable)
  isBuilding: boolean;
  speed: number; // world units / second
  turnRate: number; // radians-ish per second scale (UnitData turnrate)
  moveHeight: number; // fly altitude above ground (0 for ground units)
  collision: number;
  hitPoints: number;
  mana: number;
  armor: number;
  foodUsed: number;
  foodMade: number;
  goldCost: number;
  lumberCost: number;
  buildTime: number;
  attackDamage: number; // weapon 1 base
  attackCooldown: number;
  attackRange: number;
  abilities: string[];
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

    defs.set(id, {
      id,
      name: (u && (str(u, "Name") || str(u, "name"))) || id,
      race: d ? str(d, "race") : "",
      model: `${file.replace(/\//g, "\\")}.mdx`,
      modelScale: u ? num(u, "modelScale", 1) : 1,
      moveType: d ? str(d, "movetp") : "",
      isBuilding: (b ? num(b, "isbldg", 0) : 0) === 1,
      speed: b ? num(b, "spd", 0) : 0,
      turnRate: d ? num(d, "turnrate", 0.5) : 0.5,
      moveHeight: d ? num(d, "moveheight", 0) : 0,
      collision: b ? num(b, "collision", 0) : 0,
      hitPoints: b ? num(b, "hp", 0) : 0,
      mana: b ? num(b, "manaN", 0) : 0,
      armor: b ? num(b, "def", 0) : 0,
      foodUsed: b ? num(b, "fused", 0) : 0,
      foodMade: b ? num(b, "fmade", 0) : 0,
      goldCost: b ? num(b, "goldcost", 0) : 0,
      lumberCost: b ? num(b, "lumbercost", 0) : 0,
      buildTime: b ? num(b, "bldtm", 0) : 0,
      attackDamage: w ? num(w, "dmgplus1", 0) : 0,
      attackCooldown: w ? num(w, "cool1", 0) : 0,
      attackRange: w ? num(w, "rangeN1", 0) : 0,
      abilities: a ? (str(a, "abilList") || "").split(",").filter(Boolean) : [],
    });
  }
  return new UnitRegistry(defs);
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
