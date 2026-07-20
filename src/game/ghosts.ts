import type { SimUnit } from "../sim/world";
import { rememberedUnit, visibilityFor, type SnapshotViewer, type UnitSnapshot } from "./snapshot";

/**
 * The buildings a player still believes are standing (docs/multiplayer.md Phase E item 6b).
 *
 * Item 6 gave a structure three states — watched, remembered, absent — and left one hole: a
 * remembered building that has since been DESTROYED simply stops appearing, because
 * `visibilityFor` classifies what is in `world.units` and a dead building is not. **Measured
 * against the real 1.27a client: it keeps the ghost image until you re-scout the spot.** So the
 * memory outlives the thing it is a memory of, which is the entire point of a memory and the
 * one case the live world cannot answer.
 *
 * This is the first genuinely per-recipient HISTORY the authority carries. Item 6 got to avoid
 * it — a live remembered building needs no history because a building's last-seen position is
 * its current position, so the record could be derived on the spot. A dead one has no current
 * position to derive from, so somebody has to have written it down.
 *
 * ## The two rules, and why each is the shape it is
 *
 * **A ghost is minted only for a viewer who was NOT watching.** The rule is
 * `visibilityFor(...) === "remembered"` at the moment of death — not `!== "omit"`. If you are
 * looking at a Barracks when it burns down, you SAW it burn down: you know it is gone, and
 * leaving an image standing would be a lie the real client does not tell. If you scouted it an
 * hour ago and walked away, you have no way to know, and the image stays. The distinction falls
 * straight out of item 6's three states, which is the second time that split has paid for
 * itself.
 *
 * **A ghost is forgotten by SIGHT, not by a clock.** The measurement was specific about this:
 * no timeout and no decay. That is the cheapest rule there is — one `fogBlocksAt` test per
 * ghost per rebuild — and it is self-correcting: the same eyes that would refresh a live
 * building's record are what clear a dead one's, so a player who walks back to the ruins sees
 * empty ground the instant they arrive.
 *
 * Deliberately NOT here: the ghost's own record is `rememberedUnit`'s, byte for byte. A dead
 * building must not be MORE informative than a live one you cannot see, and giving ghosts their
 * own redaction would be two rules to keep in step. It also means a ghost carries `hp: 0` and an
 * empty queue like any other memory, so nothing downstream can tell them apart — which is
 * correct, because to the player they are the same thing.
 */
export class GhostMemory {
  /** recipient → (unit id → the last-seen image). Keyed by id so a rebuild is idempotent and a
   *  building cannot be remembered twice. */
  private byPlayer = new Map<number, Map<number, UnitSnapshot>>();

  /**
   * A unit has left the world. Offer it to every viewpoint; the ones that were not watching
   * keep an image.
   *
   * Takes the viewers rather than reaching for a `VisionSet`, the same injection shape as
   * `teamOf` in item 1c and `setFootprintReader` in 1h: this module must stay compilable
   * without the fog implementation, and a test must be able to pass two stubs.
   */
  noteDestroyed(u: SimUnit, viewers: Iterable<{ player: number; viewer: SnapshotViewer }>): void {
    // Only STRUCTURES are remembered. WC3 leaves no image of a dead footman, and item 6's
    // `remembered` state is likewise buildings-only — mobile units have no last-seen position
    // worth trusting, which is the whole reason the fog "conceals enemy movements".
    if (u.building == null) return;
    for (const { player, viewer } of viewers) {
      if (visibilityFor(viewer, u) !== "remembered") continue;
      let mine = this.byPlayer.get(player);
      if (!mine) this.byPlayer.set(player, (mine = new Map()));
      mine.set(u.id, rememberedUnit(u));
    }
  }

  /** Drop every ghost this viewer now has eyes on. Cheap enough to call each fog rebuild. */
  forgetSeen(player: number, viewer: SnapshotViewer): void {
    const mine = this.byPlayer.get(player);
    if (!mine) return;
    for (const [id, g] of mine) if (!viewer.fogBlocksAt(g)) mine.delete(id);
  }

  /** The images this recipient still believes in. Empty array for a player with none, so a
   *  caller can splice unconditionally. */
  ghostsFor(player: number): UnitSnapshot[] {
    const mine = this.byPlayer.get(player);
    return mine ? [...mine.values()] : [];
  }

  /** For a fresh match. */
  clear(): void {
    this.byPlayer.clear();
  }
}
