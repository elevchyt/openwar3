import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";

// The tech tree — WC3's own, read from the game's own files (issue #57).
//
// None of this lives in the SLKs. UnitMetaData.slk's `slk` column names the file each
// field is written to, and every tech field (`ureq` Requires, `utra` Trains, `ures`
// Researches, `ubui` Builds, `uupt` Upgrade, `usei` Sellitems, `useu` Sellunits, `umki`
// Makeitems, `udep` DependencyOr) says **Profile** — i.e. the per-race `*UnitFunc.txt`
// INI. The same three fields sit on upgrades (`*UpgradeFunc.txt`) and items
// (`ItemFunc.txt`), with identical semantics, so ONE graph covers all three id spaces
// and `requirements()` answers for a unit, an upgrade or a shop item alike.
//
// This replaces the old hand-curated WORKER_BUILDS/BUILDING_TRAINS tables. They were
// right — `[hpea] Builds=htow,hhou,hbar,hbla,hwtw,halt,harm,hars,hlum,hgra,hvlt` is
// exactly the list that was typed out by hand — but they carried no requirements, and
// the other three races had to be transcribed by hand. Reading the profiles gives every
// race its real build/train/research lists AND its gating for free.

/** One node of the tech graph: what an id needs, and what it unlocks. */
export interface TechDef {
  id: string;
  /** Display name, for the red "Requires: …" tooltip line. Usually redundant with the unit /
   *  upgrade registry — but NOT for the pseudo-techs, which exist in neither: TWN2's name is
   *  "Keep or Stronghold or Tree of Ages or Halls of the Dead", and it is spelled out in
   *  ItemStrings.txt precisely so the tooltip can say that instead of "TWN2". */
  name: string;
  /** Requirement TIERS. `Requirescount` ("Requirements - Tiers Used") says how many are
   *  live; tier 0 is the plain `Requires`, tier N is `Requires<N>`. The tier index means
   *  different things per id kind, and a tier REPLACES rather than adds to tier 0:
   *   - an UPGRADE indexes by the level being researched (Forged Swords lv1 is free,
   *     lv2 needs `Requires1=hkee`, lv3 needs `Requires2=hcas`);
   *   - a UNIT indexes by how many it already owns (hero #2 needs a Keep, #3 a Castle).
   *  Ids with no `Requirescount` have a single tier that applies to every copy/level. */
  requiresTiers: string[][];
  /** `Requiresamount` ("Requirements - Levels"), parallel to the tier's requires list:
   *  the LEVEL each listed tech must be at. Night elf's Enchanted Bears is the clear
   *  case — `[Reeb] Requires=Redc, Requiresamount=2` needs Druid of the Claw training
   *  at level 2, not merely researched. Missing entries mean 1. */
  requiresAmount: number[];
  /** `DependencyOr` ("Dependency Equivalents") — declared ON the required id, naming
   *  OTHER ids that also satisfy a requirement for it. `[ohun] DependencyOr=otbk`: a
   *  Troll Berserker satisfies a "needs a Headhunter" requirement. It is deliberately
   *  one-way — UndeadUnitFunc.txt carries the comment "do NOT put a similar DependencyOr
   *  under ucrm" next to `[ucry] DependencyOr=ucrm`. */
  dependencyOr: string[];
  trains: string[]; // `Trains` — units this building produces
  researches: string[]; // `Researches` — upgrades this building can research
  builds: string[]; // `Builds` — structures this worker can place
  upgrade: string[]; // `Upgrade` — what this building can become. A LIST: [hwtw] Upgrade=hgtw,hctw,hatw
  makeitems: string[]; // `Makeitems` — a RACE shop's stock (Arcane Vault, Voodoo Lounge, ...)
  sellitems: string[]; // `Sellitems` — a NEUTRAL shop's item stock (Goblin Merchant)
  sellunits: string[]; // `Sellunits` — a shop's unit stock (Tavern heroes, Mercenary Camp creeps)
  revive: boolean; // `Revive` — an altar; revives dead heroes
}

const EMPTY: TechDef = {
  id: "",
  name: "",
  requiresTiers: [[]],
  requiresAmount: [],
  dependencyOr: [],
  trains: [],
  researches: [],
  builds: [],
  upgrade: [],
  makeitems: [],
  sellitems: [],
  sellunits: [],
  revive: false,
};

export class TechRegistry {
  /** unit type id → every tech id a live one of them satisfies (see `satisfies`). */
  private satisfiesCache = new Map<string, string[]>();
  /** id → the ids whose `Upgrade` list names it (its upgrade-chain PARENTS). */
  private parents = new Map<string, string[]>();
  /** id → the ids that name it in their `DependencyOr` (i.e. requirements it helps meet). */
  private equivalents = new Map<string, string[]>();
  /** Per-MAP overlay from the map's own object data (war3map.w3u/.w3t/.w3a/.w3q — see
   *  applyMapTechData in src/data/objectData.ts). Mirrors UnitRegistry/ItemRegistry: the base
   *  (install) graph is immutable, `get()` checks the overlay first, and it is cleared on map
   *  change so one map's tech tree never leaks into the next.
   *
   *  This is what makes a custom map's own buildings work at all. The whole tech tree is
   *  authored in the Profile INIs (`Trains`, `Sellunits`, `Sellitems`, `Researches`, `Builds`,
   *  `Upgrade`, `Requires`), and a map that declares a shop does it by overriding exactly those
   *  fields — so a registry built only from the install answers "sells nothing" for every
   *  custom building on the map and its command card comes up EMPTY. */
  private custom = new Map<string, TechDef>();
  /** The two indexes above are derived from `defs` + `custom`, so an overlay change
   *  invalidates them. Rebuilt lazily — a map installs hundreds of overrides in a loop. */
  private indexDirty = false;

  constructor(private defs: Map<string, TechDef>) {
    this.reindex();
  }

  get(id: string): TechDef {
    return this.custom.get(id) ?? this.defs.get(id) ?? EMPTY;
  }
  has(id: string): boolean {
    return this.custom.has(id) || this.defs.has(id);
  }
  /** The base (install) node for `id`, ignoring the overlay — what a custom object clones
   *  from, and what an original-table override is applied on top of. */
  base(id: string): TechDef | undefined {
    return this.defs.get(id);
  }
  /** Add/override a node in the per-map overlay (custom object data). */
  setCustom(id: string, def: TechDef): void {
    this.custom.set(id, def);
    this.indexDirty = true;
  }
  /** Drop the map's overlay (on map change). */
  clearCustom(): void {
    if (!this.custom.size) return;
    this.custom.clear();
    this.indexDirty = true;
  }

  /** Rebuild `parents`/`equivalents` (and drop the `satisfies` cache they feed) from the
   *  base graph with the overlay laid over it. */
  private reindex(): void {
    this.parents.clear();
    this.equivalents.clear();
    this.satisfiesCache.clear();
    for (const def of new Map([...this.defs, ...this.custom]).values()) {
      for (const to of def.upgrade) push(this.parents, to, def.id);
      // `[TWN2] DependencyOr=hkee,ostr,...` — owning a Keep satisfies the pseudo-tech TWN2.
      for (const from of def.dependencyOr) push(this.equivalents, from, def.id);
    }
    this.indexDirty = false;
  }
  trains(id: string): string[] {
    return this.get(id).trains;
  }
  researches(id: string): string[] {
    return this.get(id).researches;
  }
  builds(id: string): string[] {
    return this.get(id).builds;
  }
  upgradesTo(id: string): string[] {
    return this.get(id).upgrade;
  }
  revives(id: string): boolean {
    return this.get(id).revive;
  }
  /** Does a building of this type PRODUCE units — i.e. does it take a rally point?
   *
   *  `Trains` and nothing else. `Sellunits` is a different field and a different thing: a
   *  Tavern, a Mercenary Camp, a Goblin Laboratory and a Shipyard all sell units and none of
   *  them has a Set Rally Point button in WC3 — a hired unit appears beside the building and
   *  stands there. Measured on WTii's Unit Tester, whose only buildings the real client
   *  rallies are its altars (the ones carrying `Trains`), out of forty-odd shops.
   *
   *  One rule in one place because two callers derive `BuildingState.producesUnits` from it —
   *  RtsController.addSimUnit at birth and SimWorld.morphTo on an upgrade — and they must
   *  never disagree about what a building is. */
  producesUnits(id: string): boolean {
    return this.get(id).trains.length > 0;
  }

  /** Every tech id that owning one live `unitId` satisfies.
   *
   *  Three ways a unit answers for a requirement, applied to fixpoint:
   *   1. itself;
   *   2. anything it UPGRADED FROM — `[hbla] Requires=htow` is met by a Keep, because
   *      `htow Upgrade=hkee`. Human declares no DependencyOr at all, so the tier chain is
   *      purely this: the engine walks the `Upgrade` chain back to its root;
   *   3. anything that names it in `DependencyOr` — which is how the pseudo-techs work
   *      (`TWN2 DependencyOr=hkee,...`, `HERO DependencyOr=Hamg,...`).
   *
   *  The closure matters: a Castle reaches `hkee` by (2), and `hkee` reaches `TWN2` by (3),
   *  so a Castle satisfies TWN2 — which is what lets a Castle-tier player buy the Potion of
   *  Healing (`[phea] Requires=TWN2`). Cached: the graph is immutable once loaded. */
  satisfies(unitId: string): string[] {
    if (this.indexDirty) this.reindex();
    const hit = this.satisfiesCache.get(unitId);
    if (hit) return hit;
    const seen = new Set<string>([unitId]);
    const stack = [unitId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const next of [...(this.parents.get(id) ?? []), ...(this.equivalents.get(id) ?? [])]) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    const out = [...seen];
    this.satisfiesCache.set(unitId, out);
    return out;
  }

  /** The requirements for the `tier`-th copy of a unit / the `tier`-th level of an upgrade
   *  (both 0-based). Tiers past the last declared one clamp to it. Returns the tech ids and
   *  the level each must be at (parallel arrays). */
  requirements(id: string, tier = 0): Array<{ tech: string; level: number }> {
    const def = this.get(id);
    const tiers = def.requiresTiers;
    const list = tiers[Math.min(Math.max(tier, 0), tiers.length - 1)] ?? [];
    return list.map((tech, i) => ({ tech, level: def.requiresAmount[i] ?? 1 }));
  }
}

// The tech fields live in the per-race Func profiles, and every id space declares them the
// same way, so all four are loaded into one graph:
//   - UNITS     — the bulk of it (Requires/Trains/Researches/Builds/Upgrade/Sell*/Makeitems).
//   - UPGRADES  — an upgrade's own prerequisites, tiered by LEVEL (`[Rhme] Requires1=hkee`).
//   - ABILITIES — an ability the engine hides until its upgrade is researched. This is how
//     the "effectless" upgrades work: Defend, Control Magic, Flak Cannons and Cloud grant no
//     stat at all, they simply satisfy `[…] Requires=Rhde/Rhss/Rhfc/Rhcd` on the ability that
//     was always on the unit. The command card asks the same question every other id space
//     asks — SimWorld.techMeets() in pushAbilityButtons — so one graph gates spells too.
//   - ITEMS     — a shop item's tech gate (`[phea] Requires=TWN2`). ItemFunc.txt is ALSO
//     where the pseudo-tech OR-groups live (TWN1/TWN2/TWN3 = the four races' tier-1/2/3
//     halls, TALT = any altar); HERO ("A Hero") is declared in NeutralUnitFunc.txt.
const FUNC_FILES = [
  "Units\\HumanUnitFunc.txt",
  "Units\\OrcUnitFunc.txt",
  "Units\\UndeadUnitFunc.txt",
  "Units\\NightElfUnitFunc.txt",
  "Units\\NeutralUnitFunc.txt",
  "Units\\CampaignUnitFunc.txt",
  "Units\\HumanUpgradeFunc.txt",
  "Units\\OrcUpgradeFunc.txt",
  "Units\\UndeadUpgradeFunc.txt",
  "Units\\NightElfUpgradeFunc.txt",
  "Units\\NeutralUpgradeFunc.txt",
  "Units\\CampaignUpgradeFunc.txt",
  "Units\\HumanAbilityFunc.txt",
  "Units\\OrcAbilityFunc.txt",
  "Units\\UndeadAbilityFunc.txt",
  "Units\\NightElfAbilityFunc.txt",
  "Units\\NeutralAbilityFunc.txt",
  "Units\\CommonAbilityFunc.txt",
  "Units\\ItemAbilityFunc.txt",
  "Units\\CampaignAbilityFunc.txt",
  "Units\\ItemFunc.txt",
];

// The matching Strings profiles — the only place a pseudo-tech's display name exists.
const STRING_FILES = [
  "Units\\HumanUnitStrings.txt",
  "Units\\OrcUnitStrings.txt",
  "Units\\UndeadUnitStrings.txt",
  "Units\\NightElfUnitStrings.txt",
  "Units\\NeutralUnitStrings.txt",
  "Units\\HumanUpgradeStrings.txt",
  "Units\\OrcUpgradeStrings.txt",
  "Units\\UndeadUpgradeStrings.txt",
  "Units\\NightElfUpgradeStrings.txt",
  "Units\\NeutralUpgradeStrings.txt",
  "Units\\ItemStrings.txt",
];

export function loadTechRegistry(vfs: DataSource): TechRegistry {
  const funcs = new MappedData();
  for (const path of FUNC_FILES) {
    const bytes = vfs.rawBytes(path);
    if (bytes) funcs.load(new TextDecoder("windows-1252").decode(bytes));
  }
  const strs = new MappedData();
  for (const path of STRING_FILES) {
    const bytes = vfs.rawBytes(path);
    if (bytes) strs.load(new TextDecoder("windows-1252").decode(bytes));
  }
  const defs = new Map<string, TechDef>();
  for (const id of Object.keys(funcs.map)) {
    const row = funcs.getRow(id) as { string(key: string): string | undefined } | undefined;
    if (!row) continue;
    const s = strs.getRow(id) as { string(key: string): string | undefined } | undefined;
    // An upgrade renames itself per level ("Iron Forged Swords,Steel…"); for a requirement
    // line the first is the one to show.
    const name = ((s && s.string("Name")) || "").split(",")[0]?.replace(/^"|"$/g, "").trim() || id;

    // Tier 0 is `Requires`; `Requirescount` counts how many tiers are live. Only heroes use
    // more than one in the melee data (Requirescount=3 — hero #2 needs a Keep, #3 a Castle)
    // plus the 3-level Blacksmith/Lumber Mill upgrades.
    const tierCount = Math.max(1, int(row, "requirescount", 1));
    const requiresTiers: string[][] = [];
    for (let t = 0; t < tierCount; t++) {
      requiresTiers.push(list(row, t === 0 ? "requires" : `requires${t}`));
    }
    const def: TechDef = {
      id,
      name,
      requiresTiers,
      requiresAmount: list(row, "requiresamount").map((v) => parseInt(v, 10) || 1),
      dependencyOr: list(row, "dependencyor"),
      trains: list(row, "trains"),
      researches: list(row, "researches"),
      builds: list(row, "builds"),
      upgrade: list(row, "upgrade"),
      makeitems: list(row, "makeitems"),
      sellitems: list(row, "sellitems"),
      sellunits: list(row, "sellunits"),
      revive: int(row, "revive", 0) === 1,
    };
    // Keep only rows that say something about the tech tree — the Func files are mostly
    // art/tooltip rows, and an empty node would just bloat the graph.
    if (
      def.requiresTiers.some((t) => t.length) ||
      def.dependencyOr.length ||
      def.trains.length ||
      def.researches.length ||
      def.builds.length ||
      def.upgrade.length ||
      def.makeitems.length ||
      def.sellitems.length ||
      def.sellunits.length ||
      def.revive
    ) {
      defs.set(id, def);
    }
  }
  return new TechRegistry(defs);
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** A comma-separated id list. "_" and "-" are the data's "empty" markers. */
function list(row: { string(key: string): string | undefined }, key: string): string[] {
  const v = row.string(key);
  if (!v || v === "_" || v === "-") return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "_" && s !== "-");
}

function int(row: { string(key: string): string | undefined }, key: string, fallback: number): number {
  const v = row.string(key);
  if (v === undefined || v === "" || v === "-" || v === "_") return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

// Ground-order hotkeys (WC3 standard). Build/train use the unit's name hotkey.
export const ORDER_HOTKEYS = {
  move: "M",
  stop: "S",
  hold: "H",
  attack: "A",
  patrol: "P",
  build: "B",
  buildAdvanced: "V",
  repair: "R",
  gather: "G",
  cancel: "Escape",
} as const;
