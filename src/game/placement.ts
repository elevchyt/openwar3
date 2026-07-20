import type { PlacedFootprint } from "../sim/destructibles";

// Everything war3mapUnits.doo says about a placed entity, and the position lookups that
// match a seeded unit back to it. AUTHORITY-SIDE (docs/multiplayer.md Phase B): this is
// what the MAP declares, identical on every machine that opens the file, and it decides
// sim ids — so it must exist on a host with no renderer attached.
//
// Every lookup uses the same 48-unit tolerance, because the renderer's settled location
// and the .doo's authored one differ slightly for anything the engine drops onto the
// ground. That number is repeated at each site rather than shared, exactly as it was in
// rts.ts — the tolerances are independent decisions that happen to agree today.

/** One placed unit as the .doo lists it, before an id is reserved for it. */
export interface PlacedRef {
  x: number;
  y: number;
  typeId: string;
}

export class PlacedIndex {
  private neutralPositions: Array<{ x: number; y: number }> = []; // Neutral Passive sites (from the doo)
  private creepData: Array<{ x: number; y: number; aggro: number; drops?: Array<{ items: Array<{ id: string; chance: number }> }> }> = []; // Neutral Hostile guard/aggro/drop data (from the doo)
  private playerSeeds: Array<{ x: number; y: number; owner: number; team: number }> = [];
  private placedFootprints: PlacedFootprint[] = [];
  private nextId = 1;
  /** Placed units in .doo order, each with the sim id reserved for it. See setPlacedOrder. */
  private placedIds: Array<{ x: number; y: number; typeId: string; id: number; taken: boolean }> = [];

  /** The next id for a unit the .doo never described — trained, summoned, or created by
   *  a map script. Runs ABOVE the reserved block; see setPlacedOrder. */
  nextUnitId(): number {
    return this.nextId++;
  }

  /** Register the world positions of Neutral Passive entities (from the map's
   *  war3mapUnits.doo, player 15). trySeed matches rendered units to these and
   *  seeds them as non-hostile, yellow-ringed selectables. */
  setNeutralPassive(positions: Array<{ x: number; y: number }>): void {
    this.neutralPositions = positions;
  }

  /**
   * Every placed unit in war3mapUnits.doo ORDER, which fixes each one's sim id.
   *
   * Sim ids used to be handed out by trySeed in the order the viewer finished LOADING
   * each unit's model — i.e. in disk/network/cache order. That made a unit's identity a
   * property of one machine's I/O timing: the same map could number the same creep
   * differently on two runs, let alone on two machines. Harmless while nothing outside
   * the process ever named a unit; fatal the moment a command says "attack unit 57"
   * (docs/multiplayer.md), because 57 is a different creep on the other end.
   *
   * The .doo's own order is the identity the MAP gives its units — every client reads
   * the same file and agrees, with no coordination. So ids are reserved up front, before
   * a single model has loaded, and adoption just looks its own up.
   */
  setPlacedOrder(order: PlacedRef[]): void {
    this.placedIds = order.map((p, i) => ({ ...p, id: i + 1, taken: false }));
    // Dynamically created units (trained, summoned, JASS CreateUnit) continue ABOVE the
    // reserved block. Their ids stay ordinal because the creating events are themselves
    // ordered by the sim clock — the host decides them, and tells everyone.
    this.nextId = order.length + 1;
  }

  /**
   * The id reserved for the placed unit at this position, consumed so two units stacked
   * on one spot still get distinct ids. Falls back to the running counter for anything
   * the .doo doesn't describe (a unit the map's script created before seeding finished).
   *
   * 48u tolerance, matching isNeutralPassiveAt/playerSeedAt: the renderer's location and
   * the .doo's differ slightly for units the engine settles onto the ground.
   */
  reserveIdAt(x: number, y: number, typeId: string): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.placedIds.length; i++) {
      const p = this.placedIds[i];
      if (p.taken || p.typeId !== typeId) continue;
      const dx = Math.abs(p.x - x);
      const dy = Math.abs(p.y - y);
      if (dx >= 48 || dy >= 48) continue;
      const d = dx + dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return this.nextId++;
    this.placedIds[best].taken = true;
    return this.placedIds[best].id;
  }

  isNeutralPassiveAt(x: number, y: number): boolean {
    for (const p of this.neutralPositions) if (Math.abs(p.x - x) < 48 && Math.abs(p.y - y) < 48) return true;
    return false;
  }

  /** Register the world positions + per-instance target-acquisition of Neutral
   *  Hostile creeps (from war3mapUnits.doo, player 12+). trySeed matches each
   *  rendered creep to this to set its guard post and aggro range. */
  setCreepData(data: Array<{ x: number; y: number; aggro: number; drops?: Array<{ items: Array<{ id: string; chance: number }> }> }>): void {
    this.creepData = data;
  }

  /** The placed creep's editor target-acquisition at a position (-1 if none):
   *  -1 = use the unit's default acquisition, -2 = "Camp", >0 = a custom range. */
  creepAggroAt(x: number, y: number): number {
    for (const p of this.creepData) if (Math.abs(p.x - x) < 48 && Math.abs(p.y - y) < 48) return p.aggro;
    return -1;
  }

  /** The placed creep's dropped-item table at a position (empty if none). */
  creepDropsAt(x: number, y: number): Array<{ items: Array<{ id: string; chance: number }> }> {
    for (const p of this.creepData) if (Math.abs(p.x - x) < 48 && Math.abs(p.y - y) < 48) return p.drops ?? [];
    return [];
  }

  /** Register the world positions + owner/team of pre-placed PLAYER units (custom
   *  maps, war3mapUnits.doo owner 0–11). trySeed matches each rendered unit to this
   *  and adopts it as an OWNED sim unit (see seedPlayerUnit / issue #33). */
  setPlayerUnitSeeds(seeds: Array<{ x: number; y: number; owner: number; team: number }>): void {
    this.playerSeeds = seeds;
  }

  /** Register the pathing footprint the map loader stamped for each pre-placed BUILDING.
   *  trySeed hands each one to the sim unit that adopts that spot, so the building owns
   *  its own collision and takes it away when it dies — the same deal a building the
   *  player raises gets from the spawner. */
  setPlacedFootprints(stamps: PlacedFootprint[]): void {
    this.placedFootprints = stamps;
  }

  /** Claim the map-stamped footprint at this position (if any) for a freshly-seeded
   *  building; the caller hands it to the sim. Matched by position on the same 48u tolerance as every other .doo lookup
   *  here — the sim unit is seeded from the instance the .doo placed, so the two agree.
   *  The nearest match wins and is then CLAIMED (dropped from the list): a stamp belongs
   *  to one building, or two neighbours could each free the same cells while the other's
   *  collision stayed behind forever. */
  claimFootprintAt(x: number, y: number): PlacedFootprint | null {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.placedFootprints.length; i++) {
      const p = this.placedFootprints[i];
      if (Math.abs(p.x - x) >= 48 || Math.abs(p.y - y) >= 48) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    const [p] = this.placedFootprints.splice(best, 1);
    return p;
  }

  /** The owner/team of a pre-placed player unit at a position, or null. */
  playerSeedAt(x: number, y: number): { owner: number; team: number } | null {
    for (const p of this.playerSeeds) if (Math.abs(p.x - x) < 48 && Math.abs(p.y - y) < 48) return { owner: p.owner, team: p.team };
    return null;
  }
}
