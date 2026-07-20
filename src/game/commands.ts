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
  | { c: "repair"; unitId: number; buildingId: number; queued: boolean };
