/**
 * The TARGET of `IssueTargetOrder` — a `widget`, not a `unit` (issue #294).
 *
 * common.j declares it so (`native IssueTargetOrder takes unit whichUnit, string order, widget
 * targetWidget`), and Blizzard.j's `IssueTargetItemOrder` and `IssueTargetDestructableOrder` are
 * that one native and nothing else (`return IssueTargetOrder(whichUnit, order, targetWidget)`) —
 * which is what the GUI's "Unit - Issue Order Targeting An Item" compiles to, defaulted by
 * `UI\TriggerData.txt` to `UnitOrderSmartItem`.
 *
 * So the handle's KIND has to be asked before its id means anything: a `JassItem`'s `simId` is
 * an ITEM id, and handed on as a unit id it either named nobody (the hero never picked the item
 * up) or named whichever unrelated unit happened to hold that number (the hero followed or
 * attacked it). The three kinds leave by three doors:
 *
 *   • a UNIT    → `issueUnitOrder`, as before;
 *   • an ITEM   → `issueItemOrder` (smart picks it up, attack strikes it);
 *   • a DESTRUCTABLE → the sim unit standing in for it when it has one (a gate, a crate —
 *     `destructableUnit`; the authority's own "smart on a destructible is an attack" rule then
 *     applies), else `issueTreeOrder` at the record's own spot, since a tree is not a unit in
 *     the sim and is known there only by where it stands.
 *
 * Shared by the single-unit natives (world.ts) and the group ones (groups.ts).
 */
import type { JassItem, JassUnit, NativeCtx } from "../runtime";
import type { JassValue } from "../values";
import type { JassDestructable } from "./destructables";

/** Issue a TARGET order from `unitSimId` at whatever widget `targetV` is. False when the
 *  target is gone, has no engine behind it, or the order did not take. */
export function issueTargetOrder(c: NativeCtx, unitSimId: number, orderId: number, order: string, targetV: JassValue): boolean {
  const hooks = c.rt.hooks;
  if (targetV.k === "handle" && targetV.ty === "item") {
    const it = c.rt.data<JassItem>(targetV);
    if (!it || it.simId < 0) return false;
    return hooks?.issueItemOrder?.(unitSimId, orderId, order, it.simId) ?? false;
  }
  if (targetV.k === "handle" && targetV.ty === "destructable") {
    const d = c.rt.data<JassDestructable>(targetV);
    if (!d) return false;
    const standIn = d.mapId > 0 ? hooks?.destructableUnit?.(d.mapId) ?? 0 : 0;
    if (standIn > 0) return hooks?.issueUnitOrder?.(unitSimId, orderId, order, "target", 0, 0, standIn) ?? false;
    return hooks?.issueTreeOrder?.(unitSimId, orderId, order, d.x, d.y) ?? false;
  }
  const t = c.rt.data<JassUnit>(targetV);
  return hooks?.issueUnitOrder?.(unitSimId, orderId, order, "target", 0, 0, t?.simId ?? 0) ?? false;
}
