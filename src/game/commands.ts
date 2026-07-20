import type { QueuedOrder, RallyKind } from "../sim/world";

// The player command vocabulary — everything a CLIENT can ask the authority to do
// (docs/multiplayer.md Phase C).
//
// This is the type that goes on the wire. It is deliberately one level ABOVE `QueuedOrder`:
// that type is the sim's queue entry, "an order a unit performs and can queue", and it is a
// wire format for those — but several of the player actions the funnel audit turned up are not
// that shape at all, and forcing them in would produce members that can never be queued and
// never be dispatched:
//
//   * `shopbuyer` nominates who buys from a SHOP. The shop is typically a neutral Goblin
//     Merchant that nobody owns — the whole point of the ability — so it is not an order to a
//     unit you control, and rts.ts checks it before the usual ownership gate for that reason.
//   * `autocast` toggles a flag on an ability. No target, no execution, nothing to queue.
//   * `swapitem` rearranges a unit's own inventory and `learnskill` spends a skill point —
//     both mutate the unit rather than telling it to do something.
//
// Everything here is plain JSON with numeric ids and no object references, exactly as
// `QueuedOrder` already was, so it survives the trip through the relay untouched.
//
// Ownership is NOT encoded here. A command says what was asked for, never who is allowed to
// ask — that judgement belongs to the authority, which is the only party that can be trusted
// to make it (`RtsController.execute`). A client that fakes a `unitId` it does not own gets
// the command dropped there.

export type Command =
  /** Any queueable unit order — move, attack, harvest, build, hold, stop… */
  | { c: "order"; unitId: number; order: QueuedOrder; queued: boolean }
  /** Cast an ability. `targetId` 0 and x/y 0 for a self/instant cast; one or the other is
   *  set for unit- and point-target spells respectively (the ability's own data says which). */
  | { c: "cast"; unitId: number; code: string; targetId: number; x: number; y: number }
  /** Load a worker into a burrow / transport. */
  | { c: "garrison"; unitId: number; buildingId: number }
  /** Walk over and pick up a ground item. */
  | { c: "getitem"; unitId: number; itemId: number }
  /** Use a carried item. Point-target items carry x/y; instant ones use the holder's own. */
  | { c: "useitem"; unitId: number; slot: number; targetId: number; x: number; y: number }
  /** Drop a carried item on the ground (the unit walks there first). */
  | { c: "dropitem"; unitId: number; slot: number; x: number; y: number }
  /** Sell a carried item back to a shop that buys (WC3 pawns by dragging the item onto it). */
  | { c: "sellitem"; unitId: number; slot: number; shopId: number }
  /** Hand a carried item to another unit with an inventory. */
  | { c: "giveitem"; unitId: number; slot: number; targetId: number }
  /** Nominate which of your units buys from `shopId` (0 clears it). Not a unit order — see above. */
  | { c: "shopbuyer"; shopId: number; unitId: number }
  /** Flip an ability's autocast. Not a unit order — see above. */
  | { c: "autocast"; unitId: number; code: string }
  /** Set a production building's rally point (a point, or a unit/mine to rally onto). */
  | { c: "rally"; unitId: number; x: number; y: number; kind: RallyKind; targetId: number }
  /** Rearrange a unit's own inventory. Not an order — nothing is performed, two slots swap. */
  | { c: "swapitem"; unitId: number; from: number; to: number }
  /** Spend a hero skill point. Not an order either — it mutates the hero, not its behaviour. */
  | { c: "learnskill"; unitId: number; abilityId: string }
  /**
   * Send a worker to repair a building. Carries INTENT ONLY — which worker, which building.
   *
   * `QueuedOrder`'s own `repair` member carries the derived rates (`hpPerSec`, `goldPerHp`,
   * `lumberPerHp`), and those must never come off the wire: they are the price and speed of
   * the repair, so a client that sent its own would be setting them. The authority derives
   * them from the building's `UnitDef` in `execute` and builds the `QueuedOrder` itself.
   *
   * The general rule this is an instance of: a command carries what the player ASKED FOR,
   * never what the engine DERIVED from it.
   */
  | { c: "repair"; unitId: number; buildingId: number; queued: boolean }
  /**
   * Send a worker to put up a building. Intent only: which worker, what, where.
   *
   * The PRICE is not on the wire and must never be. The renderer used to deduct gold and
   * lumber from the live stash itself and then post the amounts it had charged into the
   * `buildnew` order, which the sim trusts for the abandon-refund — so a client set both what
   * it paid and what it got back. `execute` looks the cost up in the registry, checks the
   * player can afford it, charges, and only then issues the order.
   */
  | { c: "build"; unitId: number; defId: string; x: number; y: number; queued: boolean }
  /**
   * Train a unit at a production building, or HIRE one from a shop (a Tavern hero, a
   * Mercenary Camp creep). Intent only: which building, which unit.
   *
   * Four derived things that used to be the client's are deliberately absent from the wire:
   * the gold and lumber cost, the build time, and whether this is the player's **free first
   * hero**. The renderer decided all of them — it read the live stash, consulted its own
   * `freeHeroUsed` set, deducted the price itself, and then handed the sim whichever build
   * time it liked — so a client could have hired a Mountain King for nothing, instantly.
   * `execute` looks the cost and the build time up in the registry and keeps the free-hero
   * record itself, one per player, authority-side.
   *
   * The card's gates go with them: hero cap and uniqueness, food, tech requirements, the
   * 7-deep queue, shop stock, and "does this building even train that?" are all re-checked
   * there. A command card is a picture of what is allowed, not the thing that allows it.
   */
  | { c: "train"; buildingId: number; unitId: string }
  /**
   * Research an upgrade at a building. Intent only: which building, which upgrade.
   *
   * The LEVEL is not on the wire either, and that is the subtle one — an upgrade's price
   * rises with its level (Steel Forged Swords costs more than Iron), so a client that named
   * its own level would be buying level 3 at level 1's price. The authority works the next
   * level out from what the player has already researched plus what is already queued here.
   * The cost and the research time come from `UpgradeRegistry`, never from the caller.
   */
  | { c: "research"; buildingId: number; upgradeId: string }
  /**
   * Transform a building into its next tier (Town Hall → Keep, Scout Tower → Guard Tower).
   * Intent only: which building, what it becomes.
   *
   * A tier upgrade costs the DIFFERENCE between the two buildings, and that subtraction is
   * exactly the kind of arithmetic a client must not be trusted with — the renderer used to
   * do it, deduct the result itself, and hand the sim its own build time. `execute` computes
   * the difference from both registry entries and derives the time from the target.
   */
  | { c: "upgradebuilding"; buildingId: number; toTypeId: string };
