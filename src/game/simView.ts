import type { SimUnit, SimMine, SimItem, ItemSnapshot } from "../sim/world";
import type { TechState } from "../sim/tech";

// A READ-ONLY window onto the world (docs/multiplayer.md Phase B item 7).
//
// `RtsController.simWorld` hands out the whole authoritative `SimWorld`, and the renderer
// holds it 127 times. Those uses are not one thing: roughly a third are plain lookups the
// renderer needs in order to DRAW (where is this unit, what is in this shop, is it night
// yet), and the rest are the JASS `EngineHooks`, which mutate the world and are
// authority-side work that merely happens to be wired up inside the renderer.
//
// This interface is the first half of separating those. Everything here is a read; the maps
// are `ReadonlyMap`, so a consumer that tries to insert or delete a unit stops compiling
// rather than quietly editing the authoritative world. `SimWorld` satisfies it structurally,
// so nothing had to change shape to serve it.
//
// Deliberately ABSENT: `stashOf`. It returns the live, mutable stash object, and the whole
// point of `stashFor()` returning a frozen copy is that a renderer cannot spend. A read of a
// player's gold goes through `RtsController.stashFor`, not through here.
//
// Under AoI (Phase E) this is also the natural place for the world to become a per-recipient
// snapshot view rather than the real thing — the consumers already only read.
export interface SimView {
  readonly units: ReadonlyMap<number, SimUnit>;
  readonly mines: ReadonlyMap<number, SimMine>;
  readonly items: ReadonlyMap<number, SimItem>;
  readonly tech: TechState | null;

  /** Game-clock hour, and whether the day/night cycle is advancing at all. */
  readonly timeOfDay: number;
  readonly dawnDusk: boolean;

  techMeets(player: number, id: string): boolean;
  groundItems(): SimItem[];
  itemSnapshot(id: number): ItemSnapshot | null;

  getUnitX(id: number): number | undefined;
  getUnitY(id: number): number | undefined;
  getUnitFacing(id: number): number | undefined;
  getUnitFlyHeight(id: number): number | undefined;
  getUnitMoveSpeed(id: number): number | undefined;
  isUnitPaused(id: number): boolean;

  inventorySizeOf(unitId: number): number;
  itemInSlot(unitId: number, slot: number): number;
  abilityLevelOf(unitId: number, abilityId: string): number;
  shopStock(shopId: number, wareId: string): number;

  waygateIsActive(id: number): boolean;
  waygateDestination(id: number): { x: number; y: number } | null;
}
