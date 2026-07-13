import type { TechRegistry } from "../data/techtree";
import type { UpgradeRegistry } from "../data/upgrades";

// Per-player tech state (issue #57): what each player has RESEARCHED, and what their live
// units make AVAILABLE. Together these answer the one question the whole tech tree reduces
// to — "may player P do X right now?" — for a unit, an upgrade, an ability or a shop item,
// since all four declare their prerequisites the same way (see src/data/techtree.ts).

/** The slice of a unit the census cares about. */
export interface TechUnit {
  owner: number;
  typeId: string;
  alive: boolean;
  underConstruction: boolean;
}

/** WC3's "New Availability" enum, from UI\UnitEditorData.txt [techAvail]:
 *  `-1` = Available (the default), `1` = Unavailable. The `rtma` upgrade effect carries one
 *  of these in its `base`, and `SetPlayerTechMaxAllowed` in JASS sets a cap directly. */
const AVAILABLE = -1;

export class TechState {
  /** player → upgrade id → researched level (absent = 0 = not researched). */
  private research = new Map<number, Map<string, number>>();
  /** player → tech id → how many live units satisfy it. Rebuilt lazily; see invalidate(). */
  private counts = new Map<number, Map<string, number>>();
  private dirty = true;
  /** player → unit id → max allowed (JASS SetPlayerTechMaxAllowed / Blizzard.j). */
  private maxAllowedOverride = new Map<number, Map<string, number>>();
  /** The `rtma` ("Tech Max Allowed") effects, indexed by the unit they name. This is how WC3
   *  SWAPS a unit for its upgraded form. Barrage (`Rhrt`) carries two of them at once:
   *
   *      rtma  +1 → hmtt   make the plain Siege Engine UNAVAILABLE
   *      rtma  -1 → hrtt   make the Barrage-equipped Siege Engine AVAILABLE
   *
   *  So researching Barrage withdraws one unit from the Workshop's card and puts another in
   *  its place. The -1 direction also implies hrtt starts unavailable — an upgrade whose whole
   *  job is to turn a unit on is only meaningful if it is off to begin with. Blizzard.j says
   *  as much out loud in InitSummonableCaps:
   *    `if (not GetPlayerTechResearched(p,'Rhrt',true)) then SetPlayerTechMaxAllowed(p,'hrtt',0)`
   *  Deriving it from the data means it holds even on a map whose script never runs. */
  private techAvail = new Map<string, Array<{ upgrade: string; value: number }>>();

  constructor(
    private tech: TechRegistry,
    private upgrades: UpgradeRegistry,
    private census: () => Iterable<TechUnit>,
  ) {
    for (const up of upgrades.all()) {
      for (const e of up.effects) {
        if (e.effect !== "rtma" || !e.code) continue;
        const list = this.techAvail.get(e.code) ?? [];
        list.push({ upgrade: up.id, value: e.base });
        this.techAvail.set(e.code, list);
      }
    }
  }

  /** The unit census is stale — a unit was born, died, finished construction, or morphed. */
  invalidate(): void {
    this.dirty = true;
  }

  private recount(): void {
    this.counts.clear();
    for (const u of this.census()) {
      // A half-built structure unlocks nothing in WC3 — the Barracks button stays grey until
      // the Town Hall's scaffolding comes down.
      if (!u.alive || u.underConstruction) continue;
      let m = this.counts.get(u.owner);
      if (!m) this.counts.set(u.owner, (m = new Map()));
      for (const id of this.tech.satisfies(u.typeId)) m.set(id, (m.get(id) ?? 0) + 1);
    }
    this.dirty = false;
  }

  /** JASS GetPlayerTechCount. For an UPGRADE this is the researched level; for a unit type
   *  it's how many the player owns — counting anything that satisfies it via the upgrade
   *  chain or a DependencyOr, so a Castle answers for "a Town Hall". */
  count(player: number, id: string): number {
    if (this.upgrades.has(id)) return this.researchLevel(player, id);
    if (this.dirty) this.recount();
    return this.counts.get(player)?.get(id) ?? 0;
  }

  researchLevel(player: number, id: string): number {
    return this.research.get(player)?.get(id) ?? 0;
  }

  setResearchLevel(player: number, id: string, level: number): void {
    let m = this.research.get(player);
    if (!m) this.research.set(player, (m = new Map()));
    m.set(id, Math.max(0, level));
  }

  /** The levels this player has researched — used to apply upgrade effects to their units. */
  researchedBy(player: number): Map<string, number> {
    return this.research.get(player) ?? new Map();
  }

  /** Whether `player` meets the prerequisites for `id` at `tier`. The tier is 0-based and
   *  means the LEVEL for an upgrade (Forged Swords 2 needs a Keep) and the Nth COPY for a
   *  unit (hero #2 needs a Keep) — see TechRegistry.requirements. */
  meets(player: number, id: string, tier = 0): boolean {
    for (const r of this.tech.requirements(id, tier)) {
      if (this.count(player, r.tech) < r.level) return false;
    }
    return true;
  }

  /** The unmet prerequisites for `id`, as tech ids — what the tooltip must list in red. */
  missing(player: number, id: string, tier = 0): string[] {
    return this.tech
      .requirements(id, tier)
      .filter((r) => this.count(player, r.tech) < r.level)
      .map((r) => r.tech);
  }

  /** JASS SetPlayerTechMaxAllowed — a hard cap on a unit type (0 = cannot be trained). */
  setMaxAllowed(player: number, unitId: string, max: number): void {
    let m = this.maxAllowedOverride.get(player);
    if (!m) this.maxAllowedOverride.set(player, (m = new Map()));
    m.set(unitId, max);
  }

  /** JASS GetPlayerTechMaxAllowed. -1 = no cap, 0 = cannot be made at all. An explicit cap
   *  (from a map script) wins; otherwise the `rtma` effects decide — see techAvail. */
  maxAllowed(player: number, unitId: string): number {
    const override = this.maxAllowedOverride.get(player)?.get(unitId);
    if (override !== undefined) return override;
    const effects = this.techAvail.get(unitId);
    if (!effects) return -1;
    let gatedOff = false;
    for (const e of effects) {
      const researched = this.researchLevel(player, e.upgrade) > 0;
      if (e.value === AVAILABLE) {
        if (researched) return -1; // the upgrade that turns it on is in
        gatedOff = true; // ...and until then it is off
      } else if (researched) {
        return 0; // an upgrade explicitly withdrew it (the plain Siege Engine, post-Barrage)
      }
    }
    return gatedOff ? 0 : -1;
  }

  /** Whether the player may train/build `unitId` at all right now (cap + prerequisites).
   *  `owned` is how many they already have, which selects the requirement tier. */
  canMake(player: number, unitId: string, owned = 0): boolean {
    return this.maxAllowed(player, unitId) !== 0 && this.meets(player, unitId, owned);
  }

  /** Drop every player's state (new match). */
  reset(): void {
    this.research.clear();
    this.counts.clear();
    this.maxAllowedOverride.clear();
    this.dirty = true;
  }
}
