// Unit pools, item pools and the "all stock" natives (issue #313).
//
// A POOL is a weighted bag of type ids a script fills and then draws from:
//
//     set p = CreateItemPool()
//     call ItemPoolAddItemType(p, 'rat6', 3)      // three times as likely as…
//     call ItemPoolAddItemType(p, 'rde1', 1)      // …this
//     call PlaceRandomItem(p, x, y)               // draw one and put it on the ground
//
// It is the engine-side twin of the random tables the World Editor compiles into a map's
// `Unit000NN_DropItems` triggers, and the whole family — six natives a side — answered null
// until now, so a `PlaceRandomUnit` placed nothing and its caller configured a unit that was not
// there. The draw is weight-proportional over the script's seeded stream (`Runtime.random`), so
// a replay re-draws the same thing. Adding a type that is already in the pool REPLACES its
// weight rather than stacking a second entry, so a remove takes the type out for good; no file
// states either rule, and both are OURS.
//
// The "all stock" four are the shop natives of natives/stock.ts with the shop left out:
// `AddItemToAllStock(itemId, currentStock, stockMax)` puts the ware on the shelf of every
// building that sells items ("to all shops and marketplaces" — jassdoc). Five maps in the
// install call `RemoveUnitFromAllStock` (46 call sites) to take a hero out of every Tavern once
// somebody has hired it.

import { intToRawcode } from "../lexer";
import type { NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, jHandle, jInt, JNULL, jReal, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** A `unitpool` / `itempool`: type id (the rawcode INT, as the script gave it) → weight. */
interface PoolObj {
  handleId: number;
  entries: Map<number, number>;
}

const pool = (c: NativeCtx, v: JassValue): PoolObj | undefined => c.rt.data<PoolObj>(v);

/** Draw one type id, each in proportion to its weight. 0 from an empty pool (or one whose
 *  weights are all zero), which the placing natives read as "nothing to place". */
function draw(c: NativeCtx, p: PoolObj | undefined): number {
  if (!p) return 0;
  let total = 0;
  for (const w of p.entries.values()) if (w > 0) total += w;
  if (total <= 0) return 0;
  let roll = c.rt.random() * total;
  let last = 0;
  for (const [id, w] of p.entries) {
    if (w <= 0) continue;
    last = id;
    roll -= w;
    if (roll < 0) return id;
  }
  return last; // the roll landed on the upper edge
}

export function registerPoolNatives(rt: Runtime): void {
  const create = (ty: string): NativeFn => (c) => {
    const p: PoolObj = { handleId: 0, entries: new Map() };
    p.handleId = c.rt.handles.alloc(p);
    return jHandle(p.handleId, ty);
  };
  const destroy: NativeFn = (c, a) => (a[0]?.k === "handle" && c.rt.handles.free(a[0].h), JNULL);
  const add: NativeFn = (c, a) => {
    const id = asInt(a[1]);
    if (id !== 0) pool(c, a[0])?.entries.set(id, asNum(a[2]));
    return JNULL;
  };
  const remove: NativeFn = (c, a) => (pool(c, a[0])?.entries.delete(asInt(a[1])), JNULL);

  def(rt, "CreateUnitPool", create("unitpool"));
  def(rt, "DestroyUnitPool", destroy);
  def(rt, "UnitPoolAddUnitType", add);
  def(rt, "UnitPoolRemoveUnitType", remove);
  def(rt, "CreateItemPool", create("itempool"));
  def(rt, "DestroyItemPool", destroy);
  def(rt, "ItemPoolAddItemType", add);
  def(rt, "ItemPoolRemoveItemType", remove);

  // The placing pair are a draw followed by the ordinary create, so they are routed through the
  // create natives themselves: the unit or item they hand back is minted, bound and announced
  // exactly as one made by `CreateUnit` / `CreateItem` is.
  //   PlaceRandomUnit(pool, forWhichPlayer, x, y, facing) → unit
  //   PlaceRandomItem(pool, x, y)                         → item
  def(rt, "PlaceRandomUnit", (c, a) => {
    const id = draw(c, pool(c, a[0]));
    const make = c.rt.natives.get("CreateUnit");
    return id && make ? make(c, [a[1] ?? JNULL, jInt(id), jReal(asNum(a[2])), jReal(asNum(a[3])), jReal(asNum(a[4]))]) : JNULL;
  });
  def(rt, "PlaceRandomItem", (c, a) => {
    const id = draw(c, pool(c, a[0]));
    const make = c.rt.natives.get("CreateItem");
    return id && make ? make(c, [jInt(id), jReal(asNum(a[1])), jReal(asNum(a[2]))]) : JNULL;
  });

  // --- every shop at once ---
  const addAll = (kind: "item" | "unit"): NativeFn => (c, a) => {
    const id = asInt(a[0]);
    if (id !== 0) c.rt.hooks?.addToAllStock?.(intToRawcode(id), kind, asInt(a[1]), asInt(a[2]));
    return JNULL;
  };
  const removeAll: NativeFn = (c, a) => {
    const id = asInt(a[0]);
    if (id !== 0) c.rt.hooks?.removeFromAllStock?.(intToRawcode(id));
    return JNULL;
  };
  def(rt, "AddItemToAllStock", addAll("item"));
  def(rt, "AddUnitToAllStock", addAll("unit"));
  def(rt, "RemoveItemFromAllStock", removeAll);
  def(rt, "RemoveUnitFromAllStock", removeAll);
}
