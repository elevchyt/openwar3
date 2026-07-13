// Neutral-building stock natives — the Marketplace (issue #57; see docs/triggers.md).
//
// The Marketplace (`nmrk`) is the one shop whose wares live in no data file: NeutralUnitFunc
// gives it no `Sellitems` at all. Blizzard stocks it from JASS instead, and since we RUN
// Blizzard's script rather than reimplement it, all we owe it is the natives it stands on.
//
// The loop, in Scripts\Blizzard.j:
//
//   InitBlizzard → InitNeutralBuildings                                       (:10033)
//        SetAllItemTypeSlots(bj_MAX_STOCK_ITEM_SLOTS)   -- 11 item types per shop
//        SetAllUnitTypeSlots(bj_MAX_STOCK_UNIT_SLOTS)
//        TimerStart(t, bj_STOCK_RESTOCK_INITIAL_DELAY, false, StartStockUpdates)   -- 120s
//        …and a SELL_ITEM trigger on PLAYER_NEUTRAL_PASSIVE → RemovePurchasedItem
//
//   t+120s  StartStockUpdates → PerformStockUpdates, then every 30s thereafter    (:10022)
//        PerformStockUpdates picks a random (item class, level) among the combinations the
//        map's creeps are known to drop — `bj_stockAllowed*[]`, filled by UpdateStockAvailability
//        off UnitDropItem — so a Marketplace stays EMPTY until the first creep dies with a
//        drop table. It then calls:
//   UpdateEachStockBuilding → GroupEnumUnitsOfType(g, "marketplace", null)        (:9967)
//        → ChooseRandomItemEx(class, level) up to bj_STOCK_MAX_ITERATIONS times until
//          IsItemIdSellable, then AddItemToStock(GetEnumUnit(), id, 1, 1).
//
//   On a sale: RemovePurchasedItem → RemoveItemFromStock(GetSellingUnit(), …)     (:10029)
//        which frees the type slot, so the shelf ROTATES instead of filling up once.
//
// Every other native on that path (the timers, GroupEnumUnitsOfType, ChooseRandomItemEx,
// IsItemIdSellable, GetSellingUnit) was already real — these eight were the whole gap.

import { intToRawcode } from "../lexer";
import type { JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, JNULL, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const unitSim = (c: NativeCtx, v: JassValue): number | undefined => {
  const u = c.rt.data<JassUnit>(v);
  return u && u.simId >= 0 ? u.simId : undefined;
};

export function registerStockNatives(rt: Runtime): void {
  // AddItemToStock/AddUnitToStock take (unit, id, currentStock, stockMax). Blizzard.j always
  // passes 1,1 — one on the shelf, room for one.
  const add = (c: NativeCtx, a: JassValue[], kind: "item" | "unit"): JassValue => {
    const shop = unitSim(c, a[0]);
    if (shop !== undefined) c.rt.hooks?.addToStock?.(shop, intToRawcode(asInt(a[1])), kind, asInt(a[2]), asInt(a[3]));
    return JNULL;
  };
  def(rt, "AddItemToStock", (c, a) => add(c, a, "item"));
  def(rt, "AddUnitToStock", (c, a) => add(c, a, "unit"));

  // Remove*FromStock takes the ware OFF the shelf entirely (freeing its type slot) — it is
  // not a decrement. This is what a sale does, and why the Marketplace's window turns over.
  const remove = (c: NativeCtx, a: JassValue[]): JassValue => {
    const shop = unitSim(c, a[0]);
    if (shop !== undefined) c.rt.hooks?.removeFromStock?.(shop, intToRawcode(asInt(a[1])));
    return JNULL;
  };
  def(rt, "RemoveItemFromStock", remove);
  def(rt, "RemoveUnitFromStock", remove);

  // How many distinct TYPES one shop may carry — per shop, or (SetAll*) the default for all.
  def(rt, "SetItemTypeSlots", (c, a) => {
    const shop = unitSim(c, a[0]);
    if (shop !== undefined) c.rt.hooks?.setTypeSlots?.(shop, "item", asInt(a[1]));
    return JNULL;
  });
  def(rt, "SetUnitTypeSlots", (c, a) => {
    const shop = unitSim(c, a[0]);
    if (shop !== undefined) c.rt.hooks?.setTypeSlots?.(shop, "unit", asInt(a[1]));
    return JNULL;
  });
  def(rt, "SetAllItemTypeSlots", (c, a) => {
    c.rt.hooks?.setAllTypeSlots?.("item", asInt(a[0]));
    return JNULL;
  });
  def(rt, "SetAllUnitTypeSlots", (c, a) => {
    c.rt.hooks?.setAllTypeSlots?.("unit", asInt(a[0]));
    return JNULL;
  });
}
