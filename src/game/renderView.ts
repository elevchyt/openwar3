import { isOffField } from "../sim/world";
import type { UnitSnapshot, WorldSnapshot } from "./snapshot";

/**
 * The CLIENT's reading of the payload it was sent (docs/multiplayer.md Phase E item 10c-2c).
 *
 * The host draws its own `SimWorld` and asks its own fog grid what may be seen. A client
 * cannot do the second half — not "should not", *cannot correctly*: the snapshot arrived
 * AoI-filtered (item 6), so the authority has already answered "may this seat see it", and a
 * client that answers again is a client that can answer differently. That is the maphack the
 * per-recipient design exists to prevent, and `dotsFromSnapshot` is the shape of the fix:
 * **draw what you were sent, and consult no grid of your own.**
 *
 * This module is that rule for the MODELS rather than for the minimap dots, plus the id index
 * a render loop needs to reach a payload that is a flat array.
 *
 * **This file imports no renderer and no transport.** It reads a `WorldSnapshot` and answers
 * questions about it; who delivered it is `MatchLink`'s business.
 */

/**
 * Is this unit's model off the screen, for the seat this snapshot was addressed to?
 *
 * Two reasons, and only two — which is the whole point, because the host's `hiddenFor` has
 * three and the third is the fog:
 *
 *  1. **It is not in the payload.** Not "it is fogged" — *absent*. Fog, undetected
 *     invisibility and another player's off-field units all collapse into this one case,
 *     because `visibilityFor` answered `"omit"` for each of them and the record never left
 *     the host. Absence IS the fog, arriving as a fact instead of as a grid to re-derive.
 *  2. **It is off the field** — in a mine, inside a build, in a burrow, swallowed, mid-Mirror
 *     Image shuffle. This one survives because the snapshot deliberately still SENDS these to
 *     their owner and its allies (a Burrow has to be able to list its garrison), so their
 *     absence cannot carry the message. Same `isOffField` the sim minimap and the send rule
 *     use — one disjunction, four callers, no chance for a fifth term to be added to some.
 *
 * Pinned equal to `minimapView.hiddenFor(vp, simUnit)` in `tools/sim-minimap-test.cjs`: for
 * every unit in a world, revealed and fogged, the client hides exactly what the host hides.
 * That equality is the correctness of this file — not the reasoning above it.
 */
export function hiddenFromSnapshot(u: UnitSnapshot | undefined): boolean {
  return u === undefined || isOffField(u);
}

/**
 * The latest snapshot, indexed by unit id.
 *
 * A payload is a flat array; a render loop walks entries and needs random access. Re-indexing
 * per frame would be a map rebuild at 60 Hz for a payload that changes at 10, so the index is
 * rebuilt only when the snapshot OBJECT changes — identity, not a version counter, because
 * `MatchLink.latest()` hands back the same object until a new one lands.
 *
 * `active` is what every consumer switches on, and it is false in three cases that must all
 * keep the sim path: single-player (no link), the host (it never receives) and a client that
 * has connected but not yet been sent a frame.
 */
const EMPTY: readonly UnitSnapshot[] = [];

export class SnapshotIndex {
  private snap: WorldSnapshot | null = null;
  private readonly byId = new Map<number, UnitSnapshot>();

  /** Adopt the newest payload. Cheap and idempotent when nothing has arrived since. */
  update(snap: WorldSnapshot | null): void {
    if (snap === this.snap) return;
    this.snap = snap;
    this.byId.clear();
    if (snap) for (const u of snap.units) this.byId.set(u.id, u);
  }

  /** Has a snapshot arrived? False on the host and in single-player — see the header. */
  get active(): boolean {
    return this.snap !== null;
  }

  unit(id: number): UnitSnapshot | undefined {
    return this.byId.get(id);
  }

  /** Every unit in the payload, for the consumers that walk it rather than look one up — the
   *  minimap dots. Empty when no snapshot has arrived, so a caller can switch on `active`
   *  alone and never ask the transport a second time. */
  get units(): readonly UnitSnapshot[] {
    return this.snap ? this.snap.units : EMPTY;
  }

  /** @see hiddenFromSnapshot — the authority's answer, not a second derivation of the grid. */
  hidden(id: number): boolean {
    return hiddenFromSnapshot(this.byId.get(id));
  }
}
