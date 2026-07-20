import type { SimWorld, QueuedOrder } from "../sim/world";
import type { UnitRegistry } from "../data/units";
import type { AbilityRegistry } from "../data/abilities";
import { ORDER_IDS } from "../jass/orders";

// The authority half of the bridge (docs/multiplayer.md Phase B): the questions whose
// answers are THE GAME'S, not one machine's view of it — who owns what, what a player can
// afford, how much supply they are using, which hero types they already field, and how an
// order reaches the sim.
//
// It imports `SimWorld`, the registries and the order ids, and NOTHING else. No renderer,
// no DOM, no transport. That is the whole point: this is the code that has to keep working
// when the match runs on a host with no window open.
//
// This is landing in two commits. Right now it holds the LEAVES — the helpers `execute()`
// calls. `execute()` and `applyOrder()` themselves follow in the next one, once the things
// they lean on are already over here.

export class Authority {
  /** Players who have already taken their free first hero. Lives here, not on a client:
   *  a client that kept this set could hire a hero a game for free. */
  private freeHeroUsed = new Set<number>();
  /** Debug "add food" cheat: extra supply cap per player. */
  private cheatFoodBonus = new Map<number, number>();

  constructor(
    private sim: SimWorld,
    private registry: UnitRegistry,
    private abilities: AbilityRegistry,
  ) {}

  /**
   * Does `player` own unit `id`? The AUTHORITY's ownership question, and deliberately not
   * the same one as the controller's `controls()`.
   *
   * `controls()` asks "is this mine", where "mine" is this machine's own seat — the right
   * question for the client half (may I click it, does it get a selection circle, does the
   * command card light up). The authority must instead ask "is this the ISSUING player's",
   * because on the host it judges commands that arrived from somebody else. Conflating the
   * two is why `execute()` could not gate a remote peer: every check resolved to "does the
   * host own it", which is false for every command a client ever sends.
   */
  ownedBy(player: number, id: number): boolean {
    return this.sim.units.get(id)?.owner === player;
  }

  /**
   * A player's gold and lumber, as a **frozen copy**. For display and for greying buttons —
   * never for spending.
   *
   * This used to hand out the sim's live stash object, and the renderer wrote to it in
   * fourteen places: it checked what you could afford, deducted the price, and paid its own
   * refunds, all before the sim was told anything. The whole economy ran client-side. Every
   * one of those sites is now a `Command` and the charging happens in `execute`, so the
   * escape hatch itself can close: a copy means a renderer CAN'T spend, and `Object.freeze`
   * means an attempt fails loudly in dev rather than mutating a throwaway in silence.
   */
  stashFor(owner: number): Readonly<{ gold: number; lumber: number }> {
    const s = this.sim.stashOf(owner);
    return Object.freeze({ gold: s.gold, lumber: s.lumber });
  }

  /** How many of `typeId` a player owns or has in production. This picks the REQUIREMENT
   *  TIER for that unit: WC3 gates the Nth copy, not the type — hero #1 is free, #2 needs a
   *  Keep and #3 a Castle (`[Hpal] Requirescount=3, Requires1=hkee, Requires2=hcas`). Queued
   *  ones count, or you could queue three heroes at a Town Hall in one click. */
  countOwned(owner: number, typeId: string): number {
    let n = 0;
    for (const u of this.sim.units.values()) {
      if (u.hp <= 0) continue;
      if (u.owner === owner && u.typeId === typeId) n++;
      if (u.building && (u.owner === owner || u.neutralPassive)) {
        for (const job of u.building.queue) {
          if (job.kind !== "unit" || job.unitId !== typeId) continue;
          // A NEUTRAL shop's queue belongs to nobody by ownership — a Tavern is Neutral
          // Passive — so the job itself says who is buying. Without that, a hero one player is
          // hiring would count toward every other player's copy count, and so pick their
          // requirement tier for them (harmless in 1v1, wrong in an FFA).
          if (job.buyer !== undefined ? job.buyer === owner : u.owner === owner) n++;
        }
      }
    }
    return n;
  }

  /**
   * Food used/made by a player's units — including food RESERVED for units still in
   * training (WC3 takes food when training begins, like gold/lumber). A queued unit's food
   * moves seamlessly to the live count when it spawns (no double-up).
   *
   * The per-unit figures come from the REGISTRY, keyed by the sim unit's own `typeId`.
   * They used to be read off the render `Entry`, which meant the supply cap — a rule
   * `execute()` enforces — was computed from records that only exist where there is a
   * renderer. On a headless host every player would have had infinite supply.
   *
   * The two agree for every unit a player can own, because an `Entry`'s food fields are
   * copied from this same registry entry at seed time. The one place they differ is
   * `seedNeutral`, which deliberately writes 0/0 over the def: a neutral shop or critter
   * carries no food. That cannot change a player's count here — neutrals are filtered out
   * by `u.owner === owner` — but it does mean a unit HANDED to a player by JASS
   * `SetUnitOwner` now contributes its registry food where before it contributed the
   * Entry's zero. That is the correct reading (it is a real unit the player now owns) and
   * it is the only behavioural difference in this move.
   */
  foodFor(owner: number): { used: number; made: number } {
    let used = 0;
    let made = 0;
    for (const u of this.sim.units.values()) {
      if (u.owner !== owner) continue;
      const def = this.registry.get(u.typeId);
      used += def?.foodUsed ?? 0;
      made += def?.foodMade ?? 0;
      if (u.building) for (const job of u.building.queue) used += this.registry.get(job.unitId)?.foodUsed ?? 0;
    }
    made += this.cheatFoodBonus.get(owner) ?? 0; // debug "add food" cheat
    return { used, made };
  }

  /** Debug "add food" cheat — raise a player's supply cap. */
  addFoodBonus(player: number, amount: number): void {
    this.cheatFoodBonus.set(player, (this.cheatFoodBonus.get(player) ?? 0) + amount);
  }

  /** Has this player still got their free first hero? WC3 gives hero #1 away. */
  hasFreeHero(player: number): boolean {
    return !this.freeHeroUsed.has(player);
  }

  /** Spend the free-hero allowance. */
  takeFreeHero(player: number): void {
    this.freeHeroUsed.add(player);
  }

  /** Give it back (a cancelled hero train refunds the allowance along with the gold). */
  restoreFreeHero(player: number): void {
    this.freeHeroUsed.delete(player);
  }

  /** Hero types the player already fields or has queued — at their own altars AND at any
   *  neutral shop (a tavern) they are hiring from. WC3 heroes are unique per player, so this
   *  is both the uniqueness check and the count the hero cap is measured against. */
  heroTypesInProduction(player: number): Set<string> {
    const set = new Set<string>();
    for (const u of this.sim.units.values()) {
      if (u.owner === player && this.registry.get(u.typeId)?.isHero) set.add(u.typeId);
      if (u.building && (u.owner === player || u.neutralPassive)) {
        for (const job of u.building.queue) {
          if (job.kind === "unit" && this.registry.get(job.unitId)?.isHero) set.add(job.unitId);
        }
      }
    }
    return set;
  }

  /** Record a player-issued order on the sim as a generic order id, so
   *  `GetUnitCurrentOrder` and the order-event triggers see it. */
  notePlayerOrder(id: number, o: QueuedOrder): void {
    switch (o.kind) {
      case "move":
        this.sim.noteOrder(id, ORDER_IDS.move, "point", o.x, o.y, 0);
        break;
      case "attackmove":
        this.sim.noteOrder(id, ORDER_IDS.attack, "point", o.x, o.y, 0);
        break;
      case "patrol":
        this.sim.noteOrder(id, ORDER_IDS.patrol, "point", o.x, o.y, 0);
        break;
      case "attack":
        this.sim.noteOrder(id, ORDER_IDS.attack, "target", 0, 0, o.targetId);
        break;
      case "follow":
        this.sim.noteOrder(id, ORDER_IDS.smart, "target", 0, 0, o.targetId);
        break;
      case "hold":
        this.sim.noteOrder(id, ORDER_IDS.holdposition, "immediate", 0, 0, 0);
        break;
      case "stop":
        this.sim.noteOrder(id, ORDER_IDS.stop, "immediate", 0, 0, 0);
        break;
    }
  }

  /** A JASS order string that names one of the unit's ABILITIES (rather than a generic
   *  move/attack/stop): cast it, or flip its autocast. Null when it is not one. */
  castOrder(unitId: number, order: string, targetId: number, x: number, y: number): boolean | null {
    if (!order || ORDER_IDS[order] !== undefined) return null; // a generic order
    const u = this.sim.units.get(unitId);
    if (!u) return null;
    for (const ab of u.abilities) {
      const def = this.abilities.get(ab.id);
      if (!def) continue;
      if (def.order === order) return this.sim.issueCast(unitId, ab.code, targetId, x, y);
      // "…on"/"…off" are the autocast toggles (Heal's "autocastoff"/"autocaston").
      if (def.orderOn === order || def.orderOff === order) {
        const want = def.orderOn === order;
        if (ab.autocastOn !== want) this.sim.toggleAutocast(unitId, ab.code);
        return true;
      }
    }
    return null; // no such ability on this unit — not an ability order we can serve
  }

  /** GetUnitCurrentOrder — the unit's active sim order as a generic order id (0 = none). */
  currentOrderId(unitId: number): number {
    const u = this.sim.units.get(unitId);
    if (!u) return 0;
    switch (u.order) {
      case "move":
      case "follow":
        return ORDER_IDS.move;
      case "attack":
      case "attackmove":
        return ORDER_IDS.attack;
      case "patrol":
        return ORDER_IDS.patrol;
      case "hold":
        return ORDER_IDS.holdposition;
      default:
        return 0; // idle / harvest / cast / repair / getitem / return → no generic id
    }
  }
}
