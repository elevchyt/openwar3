import { isOffField, type SimWorld, type QueuedOrder } from "../sim/world";
import type { UnitRegistry } from "../data/units";
import type { AbilityRegistry } from "../data/abilities";
import { ORDER_IDS, orderIdToString } from "../jass/orders";
import type { TechRegistry } from "../data/techtree";
import type { UpgradeRegistry } from "../data/upgrades";
import type { Command } from "./commands";
import { MELEE, MISC_GAME } from "../data/gameplayConstants";

// The authority half of the bridge (docs/multiplayer.md Phase B): the questions whose
// answers are THE GAME'S, not one machine's view of it — who owns what, what a player can
// afford, how much supply they are using, which hero types they already field, and how an
// order reaches the sim.
//
// It imports `SimWorld`, the registries, the order ids and the `Command` type, and NOTHING
// else. No renderer, no DOM, no transport. That is the whole point: this is the code that has
// to keep working when the match runs on a host with no window open.
//
// `execute()` is THE choke point (docs/multiplayer.md Phase C): every player action arrives
// here, ownership is judged here, and only then does the sim hear about it. `applyOrder()` is
// `private` to this class, which is what finally makes "nothing reaches applyOrder except
// execute" a rule the compiler keeps rather than one a grep has to police.

/** Tavern heroes are HIRED, not trained — no build time, the hero just spawns (pops next tick). */
const TAVERN_HIRE_TIME = 0;

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
    private tech: TechRegistry,
    private upgrades: UpgradeRegistry,
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

  /**
   * Set a player's gold or lumber outright. The counterpart to `stashFor`'s frozen copy, and
   * the ONLY write to the live stash that does not go through `execute()`.
   *
   * That exception is deliberate rather than an oversight. `execute` judges a player's
   * COMMANDS — it asks "can this player afford this, do they own that" — but a map script
   * setting starting gold is not a command from a player: it is the map's own configuration,
   * arriving through the JASS `SetPlayerState` native, and the interpreter runs on the
   * authority. There is nobody to judge. Routing it through `execute` would mean inventing a
   * command that no client may ever send, which is worse than naming the exception.
   *
   * It takes a resource NAME, not JASS's `PLAYER_STATE` number: the 1=gold/2=lumber encoding
   * is the interpreter's, and the authority should not have to learn it to do its job. The
   * mapping lives at the seam, in `authorityHooks` (src/game/jassHooks.ts).
   */
  setPlayerResource(player: number, resource: "gold" | "lumber", value: number): void {
    this.sim.stashOf(player)[resource] = value;
  }

  /** JASS IssueXOrder → the sim (Phase 7 — issue #33). Maps a generic order id + target
   *  kind to the matching sim command so a trigger-issued unit actually marches/attacks/
   *  casts, then records the ISSUED-order event. Unlike the player `order()` path this
   *  does NOT gate on ownership — a trigger can command any unit. Returns whether the
   *  order took. `order` is the order string; an ABILITY order (the GUI's "Order <unit>
   *  to <ability>" → `IssueTargetOrder(u, "holybolt", t)`) is matched by name against the
   *  unit's own abilities — the engine's numeric ids for ability orders live in no data
   *  file, so the STRING is the reliable key (7.17).
   *
   *  NOT A COMMAND, and not a hole in the funnel — do not "fix" it into one.
   *  `order()` gates what a CLIENT originates, because a client must not be trusted to
   *  command units it does not own. This is reached only from the JASS natives
   *  (jass/natives/world.ts, groups.ts) through `EngineHooks`, and the interpreter runs on
   *  the AUTHORITY, once (docs/multiplayer.md "JASS"). So a trigger order is an *effect of*
   *  the authoritative sim, never an input to it: gating it on ownership would break every
   *  map script, and putting it on the wire would have clients issuing orders nobody asked
   *  for. Host-only is the correct behaviour here, not the bug it is for the player paths.
   *  It needs no recording for replays either — same seed + same script + same state
   *  re-derives it (seeded PRNG in jass/runtime.ts, game-time timers in interpreter.ts). */
  issueUnitOrder(unitId: number, orderId: number, order: string, kind: "immediate" | "point" | "target", x: number, y: number, targetId: number): boolean {
    const s = order || orderIdToString(orderId);
    // Ability order? Find the ability on this unit whose Order/Orderon/Orderoff string
    // matches, and cast it (autocast toggles flip the autocast instead of casting).
    const cast = this.castOrder(unitId, s, targetId, x, y);
    if (cast !== null) {
      if (cast) this.sim.noteOrder(unitId, orderId, kind, x, y, targetId);
      return cast;
    }
    let ok = false;
    if (kind === "point") {
      if (s === "attack" || s === "attackground") ok = this.sim.issueAttackMove(unitId, x, y);
      else if (s === "patrol") ok = this.sim.issuePatrol(unitId, x, y);
      else ok = this.sim.issueMove(unitId, x, y); // move / smart / unknown-point → move
    } else if (kind === "target") {
      const u = this.sim.units.get(unitId);
      const t = this.sim.units.get(targetId);
      if (s === "attack") ok = this.sim.issueAttack(unitId, targetId, true);
      // smart on a unit: attack a hostile (incl. team -1 creeps), else follow (ally/neutral).
      else if (u && t) ok = this.sim.hostile(u, t) ? this.sim.issueAttack(unitId, targetId, false) : this.sim.issueFollow(unitId, targetId);
    } else {
      if (s === "stop") (this.sim.stop(unitId), (ok = true));
      else if (s === "holdposition") ok = this.sim.issueHold(unitId);
    }
    if (ok) this.sim.noteOrder(unitId, orderId, kind, x, y, targetId);
    return ok;
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

  /**
   * Apply a player command. THE choke point (docs/multiplayer.md Phase C).
   *
   * Every player action arrives here, ownership is judged here, and only then does the sim
   * hear about it. That is what makes the set of things a client may ask for a closed,
   * inspectable list — and once commands go over the wire this is where a peer's command
   * lands, so a client that fakes a `unitId` it does not own is refused right here rather
   * than being trusted because it asked nicely.
   *
   * Returns whether the command took.
   */
  execute(player: number, cmd: Command): boolean {
    const took = this.dispatch(player, cmd);
    if (took) this.appliedCount++;
    return took;
  }

  /**
   * How many commands this world has accepted.
   *
   * Not a statistic — the PRECONDITION of the drift detector (docs/multiplayer.md Phase F
   * item 5). A client's local sim is an uncorrected prediction that is fed only its OWN input,
   * so the moment any command has been applied to either world the two are no longer running
   * the same match and a difference between them says "different inputs", not "different
   * code". The count is what lets `MatchLink.compare` know that and stop guessing.
   */
  get applied(): number {
    return this.appliedCount;
  }
  private appliedCount = 0;

  private dispatch(player: number, cmd: Command): boolean {
    switch (cmd.c) {
      case "order":
        return this.applyOrder(player, cmd.unitId, cmd.order, cmd.queued);
      case "cast":
        return this.ownedBy(player, cmd.unitId) && this.sim.issueCast(cmd.unitId, cmd.code, cmd.targetId, cmd.x, cmd.y);
      case "garrison":
        return this.ownedBy(player, cmd.unitId) && this.sim.issueGarrison(cmd.unitId, cmd.buildingId);
      case "getitem":
        return this.ownedBy(player, cmd.unitId) && this.sim.issueGetItem(cmd.unitId, cmd.itemId);
      case "useitem":
        return this.ownedBy(player, cmd.unitId) && this.sim.useItem(cmd.unitId, cmd.slot, cmd.targetId, cmd.x, cmd.y);
      case "dropitem":
        if (!this.ownedBy(player, cmd.unitId)) return false;
        this.sim.dropItem(cmd.unitId, cmd.slot, cmd.x, cmd.y);
        return true;
      case "sellitem":
        return this.ownedBy(player, cmd.unitId) && this.sim.issueSellItem(cmd.unitId, cmd.slot, cmd.shopId);
      case "giveitem":
        // BOTH ends are checked: you may not push an item into a unit you don't own.
        return this.ownedBy(player, cmd.unitId) && this.ownedBy(player, cmd.targetId)
          && this.sim.issueGiveItem(cmd.unitId, cmd.slot, cmd.targetId);
      case "shopbuyer":
        // The SHOP is deliberately not ownership-checked — a neutral Goblin Merchant belongs
        // to nobody, which is the entire point. What must be the issuer's is the unit it
        // nominates, and the buyer is recorded against the ISSUER, never against this machine.
        return (cmd.unitId === 0 || this.ownedBy(player, cmd.unitId))
          && this.sim.setShopBuyer(cmd.shopId, player, cmd.unitId);
      case "autocast":
        if (!this.ownedBy(player, cmd.unitId)) return false;
        this.sim.toggleAutocast(cmd.unitId, cmd.code);
        return true;
      case "rally":
        // "Is it even a building that trains?" is a VALIDITY check, and so belongs to the
        // authority rather than to whichever caller happened to remember it — a client is
        // not trusted to only ever rally rally-capable buildings.
        if (!this.ownedBy(player, cmd.unitId)) return false;
        if (!this.sim.units.get(cmd.unitId)?.building?.producesUnits) return false;
        this.sim.setRally(cmd.unitId, cmd.x, cmd.y, cmd.kind, cmd.targetId);
        return true;
      case "swapitem":
        if (!this.ownedBy(player, cmd.unitId)) return false;
        this.sim.swapItems(cmd.unitId, cmd.from, cmd.to);
        return true;
      case "learnskill":
        return this.ownedBy(player, cmd.unitId) && this.sim.learnAbility(cmd.unitId, cmd.abilityId);
      case "build": {
        // Everything the renderer used to decide for itself, decided here instead: that the
        // worker is yours and is a worker, what the building costs, and whether you can
        // afford it. Placement validity stays client-side for now — it needs the footprint
        // grid the renderer owns (docs/multiplayer.md).
        if (!this.ownedBy(player, cmd.unitId)) return false;
        if (!this.sim.units.get(cmd.unitId)?.worker) return false;
        const def = this.registry.get(cmd.defId);
        if (!def) return false;
        const stash = this.sim.stashOf(player);
        if (stash.gold < def.goldCost || stash.lumber < def.lumberCost) return false;
        stash.gold -= def.goldCost;
        stash.lumber -= def.lumberCost;
        // The cost rides on the order so the sim can refund it if the build is abandoned
        // before it starts — but it is OUR figure now, not one the caller handed us.
        return this.applyOrder(player, cmd.unitId, {
          kind: "buildnew", defId: cmd.defId, x: cmd.x, y: cmd.y,
          gold: def.goldCost, lumber: def.lumberCost,
        }, cmd.queued);
      }
      case "repair": {
        // Everything the old call site checked CLIENT-side is re-checked here, because none of
        // it survives a trip over the wire: that it is your worker, that it is your building,
        // that the building is finished and actually damaged.
        if (!this.ownedBy(player, cmd.unitId) || !this.ownedBy(player, cmd.buildingId)) return false;
        if (!this.sim.units.get(cmd.unitId)?.worker) return false;
        const target = this.sim.units.get(cmd.buildingId);
        if (!target?.building || target.building.constructionLeft > 0 || target.hp >= target.maxHp) return false;
        // The def comes off the SIM unit's own typeId, not the render Entry — a headless
        // authority has no Entry, and reaching through one would silently return undefined
        // and refuse every repair rather than failing loudly.
        const def = this.registry.get(target.typeId);
        if (!def) return false;
        // WC3 repair rates: 35% of the build cost and 150% of the build time, 1 HP -> full.
        const maxHp = Math.max(1, target.maxHp);
        return this.applyOrder(player, cmd.unitId, {
          kind: "repair",
          buildingId: cmd.buildingId,
          hpPerSec: maxHp / Math.max(1, (def.buildTime || 60) * 1.5),
          goldPerHp: (def.goldCost * 0.35) / maxHp,
          lumberPerHp: (def.lumberCost * 0.35) / maxHp,
        }, cmd.queued);
      }
      case "train": {
        const b = this.sim.units.get(cmd.buildingId);
        if (!b?.building || b.hp <= 0) return false;
        // A SHOP is deliberately exempt from ownership — a Tavern is Neutral Passive, so
        // nobody owns the building you hire your first hero from. Anything else must be
        // yours. (Same carve-out the command card makes for a foreign shop.)
        if (b.owner !== player && !this.sim.isShopUnit(cmd.buildingId)) return false;
        const def = this.registry.get(cmd.unitId);
        if (!def) return false;
        // "Does this building even train that?" — never checked before, because the card
        // only ever offered what the building trains. The card does not come over the wire.
        const isSold = this.tech.get(b.typeId).sellunits.includes(cmd.unitId);
        if (!isSold && !this.tech.trains(b.typeId).includes(cmd.unitId)) return false;
        if (this.sim.queueFull(cmd.buildingId)) return false; // 7-deep — before charging
        // WC3 hero rules: unique per player, and MELEE_HERO_LIMIT across altars + tavern.
        let heroCount = 0;
        if (def.isHero) {
          const inProduction = this.heroTypesInProduction(player);
          if (inProduction.has(cmd.unitId) || inProduction.size >= MELEE.MELEE_HERO_LIMIT) return false;
          heroCount = inProduction.size;
        }
        // Tech gate. A hero indexes the requirement tier by how many HEROES the player has,
        // not how many of this hero — see the trainTier note in mapViewer.
        const owned = def.isHero ? heroCount : this.countOwned(player, cmd.unitId);
        if (!this.sim.canMake(player, cmd.unitId, owned)) return false;
        // The melee free FIRST hero: gold- and lumber-free, food still counts. This record
        // lives here and not on the client precisely because it is worth 425 gold.
        const freeHero = def.isHero && this.hasFreeHero(player);
        const gold = freeHero ? 0 : def.goldCost;
        const lumber = freeHero ? 0 : def.lumberCost;
        const stash = this.sim.stashOf(player);
        if (stash.gold < gold || stash.lumber < lumber) return false;
        // Food is committed when training BEGINS, exactly like gold and lumber.
        const food = this.foodFor(player);
        if (food.used + def.foodUsed > food.made) return false;
        // A unit the building SELLS comes off its shelf, and hiring is loud — purchaseUnit
        // both depletes the stock and shouts to the creeps. It can still refuse (sold out,
        // requirements), so it runs before anything is charged.
        if (isSold && this.sim.purchaseUnit(cmd.buildingId, cmd.unitId, player) !== "ok") return false;
        stash.gold -= gold;
        stash.lumber -= lumber;
        if (freeHero) this.takeFreeHero(player);
        // A neutral shop hires near-instantly; a building you own takes the unit's real
        // build time (altar heroes ~55s). Derived here — the client used to send it.
        const hireTime = b.neutralPassive ? TAVERN_HIRE_TIME : def.buildTime || 15;
        // Tagged with its BUYER: a Tavern belongs to nobody, so countOwned (which picks the
        // requirement tier) has no other way to tell whose queued hero this is.
        return this.sim.enqueueTrain(cmd.buildingId, cmd.unitId, hireTime, freeHero, player);
      }
      case "research": {
        // Ownership was never checked at this call site at all — the command card was, in
        // effect, the check, because you are only ever shown your own building's card.
        if (!this.ownedBy(player, cmd.buildingId)) return false;
        const b = this.sim.units.get(cmd.buildingId);
        if (!b?.building || b.hp <= 0) return false;
        const state = this.sim.tech;
        const d = this.upgrades.get(cmd.upgradeId);
        if (!d || !state) return false;
        // Does this building even research that? Same gap as `train` had.
        if (!this.tech.researches(b.typeId).includes(cmd.upgradeId)) return false;
        if (this.sim.queueFull(cmd.buildingId)) return false; // before charging
        // The LEVEL is derived, not sent: an upgrade's price climbs with its level, so a
        // client naming its own level would buy level 3 at level 1's price. It is one past
        // whatever the player already has, or already has queued here — whichever is further.
        const have = state.researchLevel(player, cmd.upgradeId);
        const next = Math.max(have, this.sim.researchingLevel(cmd.buildingId, cmd.upgradeId)) + 1;
        if (next > d.maxLevel) return false;
        if (!state.meets(player, cmd.upgradeId, next - 1)) return false;
        const cost = this.upgrades.cost(cmd.upgradeId, next);
        const stash = this.sim.stashOf(player);
        if (stash.gold < cost.gold || stash.lumber < cost.lumber) return false;
        stash.gold -= cost.gold;
        stash.lumber -= cost.lumber;
        return this.sim.enqueueResearch(cmd.buildingId, cmd.upgradeId, next, cost.time || 1);
      }
      case "upgradebuilding": {
        if (!this.ownedBy(player, cmd.buildingId)) return false;
        const b = this.sim.units.get(cmd.buildingId);
        if (!b?.building || b.hp <= 0) return false;
        const to = this.registry.get(cmd.toTypeId);
        if (!to) return false;
        if (!this.tech.upgradesTo(b.typeId).includes(cmd.toTypeId)) return false;
        if (this.sim.queueFull(cmd.buildingId)) return false; // before charging
        // Not merely hidden on the card: without this a second click pays for the Keep twice.
        if (this.sim.isUpgrading(cmd.buildingId)) return false;
        if (!this.sim.canMake(player, cmd.toTypeId, 0)) return false;
        // A tier upgrade costs the DIFFERENCE between the two buildings, not the full price
        // of the new one (WC3): a Stronghold (700/375) over a Great Hall (385/185) is
        // 315/190. Both halves of that subtraction are read here, from the registry.
        const from = this.registry.get(b.typeId);
        const gold = Math.max(0, to.goldCost - (from?.goldCost ?? 0));
        const lumber = Math.max(0, to.lumberCost - (from?.lumberCost ?? 0));
        const stash = this.sim.stashOf(player);
        if (stash.gold < gold || stash.lumber < lumber) return false;
        stash.gold -= gold;
        stash.lumber -= lumber;
        return this.sim.enqueueUpgrade(cmd.buildingId, cmd.toTypeId, to.buildTime || 1);
      }
      case "cancelbuild": {
        if (!this.ownedBy(player, cmd.buildingId)) return false;
        const b = this.sim.units.get(cmd.buildingId);
        // Only an UNFINISHED building can be cancelled — a finished one is demolished, which
        // is not this command and pays nothing back.
        if (!b?.building || b.building.constructionLeft <= 0) return false;
        // The typeId comes off the sim unit, never off the caller. It used to ride along in
        // the call from the renderer's own selection, so cancelling a Farm while naming a
        // Castle would have refunded a Castle.
        const def = this.registry.get(b.typeId);
        if (def) {
          const stash = this.sim.stashOf(player);
          stash.gold += Math.round(def.goldCost * MISC_GAME.ConstructionRefundRate);
          stash.lumber += Math.round(def.lumberCost * MISC_GAME.ConstructionRefundRate);
        }
        return this.sim.cancelBuilding(cmd.buildingId); // frees its footprint's cells too
      }
      case "canceltrain": {
        const b = this.sim.units.get(cmd.buildingId);
        if (!b?.building) return false;
        // Both ends. Normally the building must be yours — but a hero you are hiring at a
        // Tavern sits in a queue owned by nobody, so a job's own `buyer` also entitles you to
        // cancel it. Checked against the job that is actually there, before removing it.
        const slot = cmd.index < 0 ? b.building.queue[b.building.queue.length - 1] : b.building.queue[cmd.index];
        if (!slot) return false;
        const owns = b.owner === player || (slot.kind === "unit" && slot.buyer === player);
        if (!owns) return false;
        const job = cmd.index < 0
          ? this.sim.cancelLastTrain(cmd.buildingId)
          : this.sim.cancelTrainAt(cmd.buildingId, cmd.index);
        if (!job) return false;
        // Refund the job the SIM removed, at the rate its own kind carries in MiscGame.txt:
        // training and research come back in full (Train/ResearchRefundRate = 1.0), a
        // structure upgrade only 75% (UpgradeRefundRate) — the same haircut as cancelling a
        // building mid-construction.
        const stash = this.sim.stashOf(player);
        if (job.kind === "research") {
          const c = this.upgrades.cost(job.unitId, job.level);
          stash.gold += Math.round(c.gold * MISC_GAME.ResearchRefundRate);
          stash.lumber += Math.round(c.lumber * MISC_GAME.ResearchRefundRate);
          return true;
        }
        // The melee free first hero cost nothing, so it refunds nothing — otherwise queueing
        // and cancelling one would simply mint 425 gold. It does hand the freebie back. That
        // `free` flag is the sim's own, set when the authority granted it.
        if (job.kind === "unit" && job.free) {
          this.restoreFreeHero(player);
          return true;
        }
        const d = this.registry.get(job.unitId);
        if (d) {
          const rate = job.kind === "upgrade" ? MISC_GAME.UpgradeRefundRate : MISC_GAME.TrainRefundRate;
          stash.gold += Math.round(d.goldCost * rate);
          stash.lumber += Math.round(d.lumberCost * rate);
        }
        return true;
      }
      case "battlestations":
        // The sim gathers peons belonging to the BURROW's owner, so without this an enemy
        // could have marched your workers off their gold and into your own burrow.
        return this.ownedBy(player, cmd.buildingId) && this.sim.battleStations(cmd.buildingId);
      case "standdown":
        return this.ownedBy(player, cmd.buildingId) && this.sim.unloadBurrow(cmd.buildingId);
      case "buyitem": {
        // No ownership gate ON PURPOSE — a Goblin Merchant is Neutral Passive and an ally's
        // Vault is shoppable (Aall). Who may buy is `purchaseItem`'s own judgement: it checks
        // the shop's tech gate, the shelf, the patron's range and that the patron is the
        // BUYER's unit — and the patron is nominated here, by the same `shopBuyer` rule the
        // card's overhead arrow uses, never named by the wire.
        const buyer = this.sim.shopBuyer(cmd.shopId, player);
        if (!buyer) return false;
        return this.sim.purchaseItem(cmd.shopId, buyer.id, cmd.itemId, player) === "ok";
      }
    }
  }


  /**
   * Route an order to a unit: either append it to the unit's shift-queue, or execute it
   * immediately (replacing its current order + queue). Silently ignores units the local
   * player doesn't own.
   *
   * **Call `execute({ c: "order", … })`, never this.** It is the implementation of one
   * `Command` member, not a second way in — reaching it directly is how move/attack/harvest
   * (i.e. nearly every order in the game) would end up never becoming a `Command` and so
   * never crossing the wire. That is exactly what happened between the first Phase C pass and
   * the audit that caught it: closing the direct *sim* calls is only half of it, because
   * `order()` is itself a door.
   */
  private applyOrder(player: number, id: number, o: QueuedOrder, queued: boolean): boolean {
    if (!this.ownedBy(player, id)) return false;
    // No WC3 UI can address an OFF-FIELD unit — a worker inside a mine or its own build,
    // a garrisoned peon, a devoured sheep — because the game deselects it the moment it
    // leaves the field. But a LAN client's deselect is one payload-interval STALE (it
    // fires when the snapshot lands, not when the sim swallowed the unit), so a client's
    // selection CAN still name one for a beat. Refused here, same door as a forged
    // unitId: mid-mine state is not order-shaped — a re-targeted `resId` made the emerge
    // branch clear the WRONG mine's one-worker `busy` latch, and every later peon parked
    // at the wedged mine's entrance forever (the "stuck outside the gold mine" playtest).
    const u = this.sim.units.get(id);
    if (!u || isOffField(u)) return false;
    this.notePlayerOrder(id, o); // fire EVENT_..._ISSUED_ORDER for the trigger engine
    if (queued) {
      this.sim.queueOrder(id, o);
      return true;
    }
    return this.sim.issueOrder(id, o);
  }
}
