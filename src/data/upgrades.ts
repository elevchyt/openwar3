import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";

// Upgrade (research) registry — WC3's `Units\UpgradeData.slk` plus the per-race
// `*UpgradeFunc.txt` (icon + button slot) and `*UpgradeStrings.txt` (names/tooltips).
// Requirements do NOT live here: they're `Requires`/`Requires1..8` in the Func profile and
// are read by the tech graph (src/data/techtree.ts), which gates units, upgrades, abilities
// and shop items through one code path.
//
// Two formulas, both straight off the SLK columns, both "value AT level L" rather than a
// per-level increment:
//     cost(L)   = base + mod*(L-1)      (goldbase/goldmod, lumberbase/lumbermod, timebase/timemod)
//     effect(L) = base + mod*(L-1)      (base1/mod1 next to effect1)
// So Forged Swords is 100g at level 1, 175g at level 2, 250g at level 3; and Priest Master
// Training's `rmnx` reads +200 max mana at level 2 — the TOTAL over the base, not another
// +100 on top of level 1.

/** One of an upgrade's up-to-4 effects (`effect1..4` + `base1..4`/`mod1..4`/`code1..4`). */
export interface UpgradeEffect {
  /** Which of the four columns this came from (1..4). An upgrade's own tooltip quotes the raw
   *  column by slot — "<Rhan,base1>" — so the slot has to survive the load (src/data/tipRefs.ts);
   *  the array index would not, since an empty `effect1` shifts everything up. */
  slot: number;
  /** `effectN` — the engine's effect id from UpgradeEffectMetaData.slk. See applyUpgrades()
   *  in src/sim/world.ts for the ones the sim honours. */
  effect: string;
  base: number; // value at level 1
  mod: number; // added per level beyond the first
  /** `codeN` — the unit type the effect names. Only the tech-availability effect (`rtma`)
   *  uses it: Barrage (`Rhrt`) carries TWO rtma effects, one making the plain Siege Engine
   *  (`hmtt`) unavailable and one making the Barrage-equipped `hrtt` available. */
  code: string;
}

export interface UpgradeDef {
  id: string;
  race: string;
  /** `class` — melee/ranged/armor/caster/_. WC3 groups the research buttons by it. */
  className: string;
  maxLevel: number;
  goldBase: number;
  goldMod: number;
  lumberBase: number;
  lumberMod: number;
  timeBase: number;
  timeMod: number;
  effects: UpgradeEffect[];
  // Everything below is per-LEVEL: an upgrade renames itself as it ranks up (Iron → Steel →
  // Mithril Forged Swords), with its own icon each time. Index = level-1, clamped.
  names: string[];
  tips: string[]; // "Upgrade to Iron Forged |cffffcc00S|rwords" — hotkey already gilded
  uberTips: string[];
  hotkeys: string[];
  icons: string[];
  buttonX: number;
  buttonY: number;
}

const lv = <T,>(list: T[], level: number): T | undefined => list[Math.min(Math.max(level, 1), list.length) - 1];

export class UpgradeRegistry {
  // Mirrors UnitRegistry/ItemRegistry: a per-map overlay from war3map.w3q shadows the
  // install defs and is cleared on map change.
  constructor(private defs: Map<string, UpgradeDef>, private custom = new Map<string, UpgradeDef>()) {}

  get(id: string): UpgradeDef | undefined {
    return this.custom.get(id) ?? this.defs.get(id);
  }
  has(id: string): boolean {
    return this.custom.has(id) || this.defs.has(id);
  }
  all(): UpgradeDef[] {
    return [...new Map([...this.defs, ...this.custom]).values()];
  }
  get size(): number {
    return new Set([...this.defs.keys(), ...this.custom.keys()]).size;
  }
  base(id: string): UpgradeDef | undefined {
    return this.defs.get(id);
  }
  setCustom(id: string, def: UpgradeDef): void {
    this.custom.set(id, def);
  }
  clearCustom(): void {
    this.custom.clear();
  }

  /** Gold/lumber/seconds to research `id` AT `level` (1-based). */
  cost(id: string, level: number): { gold: number; lumber: number; time: number } {
    const d = this.get(id);
    if (!d) return { gold: 0, lumber: 0, time: 0 };
    const n = Math.max(0, level - 1);
    return {
      gold: d.goldBase + d.goldMod * n,
      lumber: d.lumberBase + d.lumberMod * n,
      time: d.timeBase + d.timeMod * n,
    };
  }
  /** The value of `effect` at `level`, or null when this upgrade has no such effect. */
  effectValue(id: string, effect: string, level: number): number | null {
    const d = this.get(id);
    if (!d || level < 1) return null;
    const e = d.effects.find((x) => x.effect === effect);
    return e ? e.base + e.mod * (level - 1) : null;
  }
  name(id: string, level: number): string {
    const d = this.get(id);
    return (d && lv(d.names, level)) || id;
  }
  icon(id: string, level: number): string {
    const d = this.get(id);
    return (d && lv(d.icons, level)) || "";
  }
  tip(id: string, level: number): string {
    const d = this.get(id);
    return (d && lv(d.tips, level)) || this.name(id, level);
  }
  uberTip(id: string, level: number): string {
    const d = this.get(id);
    return (d && lv(d.uberTips, level)) || "";
  }
  hotkey(id: string, level: number): string {
    const d = this.get(id);
    return (d && lv(d.hotkeys, level)) || "";
  }
}

const UPGRADE_FUNC_FILES = [
  "Units\\HumanUpgradeFunc.txt",
  "Units\\OrcUpgradeFunc.txt",
  "Units\\UndeadUpgradeFunc.txt",
  "Units\\NightElfUpgradeFunc.txt",
  "Units\\NeutralUpgradeFunc.txt",
  "Units\\CampaignUpgradeFunc.txt",
];
const UPGRADE_STRING_FILES = [
  "Units\\HumanUpgradeStrings.txt",
  "Units\\OrcUpgradeStrings.txt",
  "Units\\UndeadUpgradeStrings.txt",
  "Units\\NightElfUpgradeStrings.txt",
  "Units\\NeutralUpgradeStrings.txt",
  "Units\\CampaignUpgradeStrings.txt",
];

interface Row {
  string(key: string): string | undefined;
}

export function loadUpgradeRegistry(vfs: DataSource): UpgradeRegistry {
  const defs = new Map<string, UpgradeDef>();
  const bytes = vfs.rawBytes("Units\\UpgradeData.slk");
  if (!bytes) return new UpgradeRegistry(defs);
  const data = new MappedData(new TextDecoder("windows-1252").decode(bytes));

  const funcs = new MappedData();
  for (const p of UPGRADE_FUNC_FILES) {
    const b = vfs.rawBytes(p);
    if (b) funcs.load(new TextDecoder("windows-1252").decode(b));
  }
  const strs = new MappedData();
  for (const p of UPGRADE_STRING_FILES) {
    const b = vfs.rawBytes(p);
    if (b) strs.load(new TextDecoder("windows-1252").decode(b));
  }

  for (const id of Object.keys(data.map)) {
    const r = data.getRow(id) as Row | undefined;
    if (!r) continue;
    // `used` is Blizzard's own "is this live in the game" flag; the header/scratch rows and
    // the cut upgrades have no race and never reach a command card.
    const race = str(r, "race");
    if (!race) continue;

    const f = funcs.getRow(id) as Row | undefined;
    const s = strs.getRow(id) as Row | undefined;

    const effects: UpgradeEffect[] = [];
    for (const n of [1, 2, 3, 4]) {
      const effect = str(r, `effect${n}`);
      if (!effect) continue;
      effects.push({
        slot: n,
        effect,
        // `rarm` (armor) deliberately ships EMPTY base/mod — its magnitude is a property of
        // the unit being upgraded, not of the upgrade: UnitBalance.slk's `defUp` (2 for a
        // unit, 1 for a building). So a 0 here is correct and the sim reads defUp instead.
        base: num(r, `base${n}`, 0),
        mod: num(r, `mod${n}`, 0),
        code: str(r, `code${n}`),
      });
    }

    const [bx, by] = buttonPos(f ? str(f, "buttonpos") : "");
    defs.set(id, {
      id,
      race,
      className: str(r, "class"),
      maxLevel: Math.max(1, num(r, "maxlevel", 1)),
      goldBase: num(r, "goldbase", 0),
      goldMod: num(r, "goldmod", 0),
      lumberBase: num(r, "lumberbase", 0),
      lumberMod: num(r, "lumbermod", 0),
      timeBase: num(r, "timebase", 0),
      timeMod: num(r, "timemod", 0),
      effects,
      names: csv(s, "Name"),
      tips: csv(s, "Tip"),
      uberTips: quotedList(s, "Ubertip"),
      hotkeys: csv(s, "Hotkey"),
      icons: csv(f, "Art"),
      buttonX: bx,
      buttonY: by,
    });
  }
  return new UpgradeRegistry(defs);
}

/** A per-level string list. Most are a plain comma list ("S,S,S"), but Ubertip's values
 *  contain commas of their own and so are QUOTED — `"Increases the attack damage of Militia,
 *  Footmen…","Further increases…"`. MappedData's INI reader strips only the outermost pair
 *  of quotes, leaving `a, b","c, d`, so splitting on the `","` seam is what separates the
 *  levels; a naive split on "," would shred the sentence. */
function csv(row: Row | undefined, key: string): string[] {
  if (!row) return [];
  const v = row.string(key);
  if (v === undefined || v === "" || v === "-" || v === "_") return [];
  const parts = v.includes('","') ? v.split('","') : v.split(",");
  return parts.map((p) => p.replace(/^"|"$/g, "").trim());
}

/** Ubertip values are QUOTED sentences that carry commas of their own — both prose commas and
 *  the `,` inside `<ID,Field>` value refs (Berserker Strength: "…with a <Robs,base1> hit point
 *  increase, and <Robs,base2>…"). Levels are separated ONLY by the `","` seam MappedData leaves
 *  after stripping the outer quotes; a bare-comma split (csv) would shred the sentence AND the
 *  refs. So a single-level tip stays one whole string. */
function quotedList(row: Row | undefined, key: string): string[] {
  if (!row) return [];
  const v = row.string(key);
  if (v === undefined || v === "" || v === "-" || v === "_") return [];
  return v.split('","').map((p) => p.replace(/^"|"$/g, "").trim());
}

function buttonPos(v: string): [number, number] {
  const p = (v || "").split(",");
  return [parseInt(p[0] ?? "0", 10) || 0, parseInt(p[1] ?? "0", 10) || 0];
}

function str(row: Row, key: string): string {
  const v = row.string(key);
  return v === undefined || v === "-" || v === "_" ? "" : v;
}
function num(row: Row, key: string, fallback: number): number {
  const v = row.string(key);
  if (v === undefined || v === "" || v === "-" || v === "_") return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}
