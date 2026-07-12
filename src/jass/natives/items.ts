// Item natives (Phase 7 milestone 7.18 — issue #33; see docs/triggers.md).
//
// The trigger surface for items: create one, give it to a hero, drop it, use it,
// destroy it, and ask what/where it is. Signatures are taken from the real
// `Scripts\common.j` (1.27a), and everything the GUI actually emits — the whole
// `…BJ` family (UnitAddItemByIdSwapped, UnitDropItemPointLoc, GetItemLoc,
// GetInventoryIndexOfItemTypeBJ, ChooseRandomItemExBJ, CheckItemStatus, the
// RandomDist* distribution) — is blizzard.j code we already interpret, riding on
// these. So implementing the natives lights up the whole item action/condition set.
//
// The item model, in one line: **an item is ONE entity that moves between the ground
// and an inventory**, and a JASS `item` handle follows it across that move. Our sim
// now gives every item a stable entity id (SimItem.id == HeldItem.id, 7.18), so the
// handle just carries that id and reads everything mutable — charges, position, who
// holds it — live through the bridge (EngineHooks.itemInfo), exactly as a `unit`
// handle reads GetUnitX. Nothing is cached on the handle except the fallbacks a
// headless run (no engine attached) needs.
//
// Slot indices are 0-based here (as in common.j). The BJ layer does the 1-based
// translation the GUI shows the user (UnitItemInSlotBJ passes itemSlot-1).

import { intToRawcode, rawcodeToInt } from "../lexer";
import type { BoolExpr, ItemSnapshot, JassItem, JassUnit, NativeCtx, RectObj, Runtime } from "../runtime";
import { asInt, asNum, jBool, jHandle, jInt, JNULL, jReal, jStr, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const item = (c: NativeCtx, v: JassValue): JassItem | undefined => c.rt.data<JassItem>(v);
const unitSim = (c: NativeCtx, v: JassValue): number | undefined => {
  const u = c.rt.data<JassUnit>(v);
  return u && u.simId >= 0 ? u.simId : undefined;
};

/** The item's LIVE state (where it is, what's left of it) — null once it's destroyed,
 *  or when there's no engine attached. */
const info = (c: NativeCtx, it: JassItem | undefined): ItemSnapshot | null =>
  it && it.simId >= 0 ? c.rt.hooks?.itemInfo?.(it.simId) ?? null : null;

/** common.j's `itemtype` (ConvertItemType) ↔ ItemData.slk's `class` column. The enum's
 *  order IS the SLK's vocabulary (verified against the 1.27a ItemData.slk, whose only
 *  class values are exactly these seven). ITEM_TYPE_UNKNOWN (7) and _ANY (8) match no
 *  single class — _ANY means "don't filter", which is how ChooseRandomItemEx reads it. */
const ITEM_CLASSES = ["Permanent", "Charged", "PowerUp", "Artifact", "Purchasable", "Campaign", "Miscellaneous"];
const classOfIndex = (i: number): string | null => ITEM_CLASSES[i] ?? null;
const indexOfClass = (cls: string): number => {
  const i = ITEM_CLASSES.indexOf(cls);
  return i >= 0 ? i : 7; // ITEM_TYPE_UNKNOWN
};

/** Mint (or reuse) the `item` handle for a sim item id — the same interning unitForSim
 *  does, so the item a trigger created, a hero picked up, and a PICKUP event reports are
 *  all one handle. Null for an id that no longer exists. */
function itemHandle(c: NativeCtx, simId: number): JassValue {
  if (simId <= 0) return JNULL;
  const snap = c.rt.hooks?.itemInfo?.(simId);
  return snap ? c.rt.itemForSim(snap) : JNULL;
}

export function registerItemNatives(rt: Runtime): void {
  // --- create / destroy -----------------------------------------------------
  // CreateItem is NOT gated by the record-only spawn rule that CreateUnit obeys (7.3):
  // a map's pre-placed items live in the SCRIPT (main() → CreateAllItems() → CreateItem),
  // and although war3mapUnits.doo carries them too, we only draw those as static scenery.
  // So the script is the authority — its CreateItem calls spawn the one real, pickable
  // item, and the renderer hides the duplicate .doo widget (rts.trySeed). Verified across
  // the bundled corpus: every map with .doo item entries also ships CreateAllItems().
  const createItem = (c: NativeCtx, typeInt: number, x: number, y: number): JassValue => {
    const typeId = intToRawcode(typeInt);
    const simId = c.rt.hooks?.createItem?.(typeId, x, y) ?? -1;
    const it: JassItem = { handleId: 0, simId, typeId, charges: c.rt.hooks?.itemInfo?.(simId)?.charges ?? 0, x, y };
    it.handleId = c.rt.handles.alloc(it);
    c.rt.bindSimItem(it); // one item entity = one handle
    return jHandle(it.handleId, "item");
  };
  def(rt, "CreateItem", (c, a) => createItem(c, asInt(a[0]), asNum(a[1]), asNum(a[2])));
  def(rt, "RemoveItem", (c, a) => {
    const it = item(c, a[0]);
    if (it && it.simId >= 0) c.rt.hooks?.removeItem?.(it.simId);
    return JNULL;
  });

  // --- item queries (live through the bridge; the handle's fields are the fallback) ---
  def(rt, "GetItemTypeId", (c, a) => jInt(rawcodeToInt(item(c, a[0])?.typeId ?? "")));
  def(rt, "GetItemX", (c, a) => {
    const it = item(c, a[0]);
    return jReal(info(c, it)?.x ?? it?.x ?? 0);
  });
  def(rt, "GetItemY", (c, a) => {
    const it = item(c, a[0]);
    return jReal(info(c, it)?.y ?? it?.y ?? 0);
  });
  def(rt, "SetItemPosition", (c, a) => {
    const it = item(c, a[0]);
    if (it && it.simId >= 0) c.rt.hooks?.setItemPosition?.(it.simId, asNum(a[1]), asNum(a[2]));
    return JNULL;
  });
  def(rt, "GetItemCharges", (c, a) => {
    const it = item(c, a[0]);
    return jInt(info(c, it)?.charges ?? it?.charges ?? 0);
  });
  def(rt, "SetItemCharges", (c, a) => {
    const it = item(c, a[0]);
    const n = asInt(a[1]);
    if (it) {
      it.charges = n;
      if (it.simId >= 0) c.rt.hooks?.setItemCharges?.(it.simId, n);
    }
    return JNULL;
  });
  // GetItemPlayer: the holder's slot; an item lying on the ground belongs to Neutral
  // Passive (player 15), which is what the sim's snapshot reports.
  def(rt, "GetItemPlayer", (c, a) => c.rt.playerHandle(info(c, item(c, a[0]))?.owner ?? 15));
  def(rt, "IsItemOwned", (c, a) => jBool((info(c, item(c, a[0]))?.holder ?? 0) > 0));

  // --- item TYPE data (the ItemRegistry, not the instance) ---
  const typeInfo = (c: NativeCtx, typeId: string) => c.rt.hooks?.itemTypeInfo?.(typeId) ?? null;
  const ofItem = (c: NativeCtx, v: JassValue) => {
    const it = item(c, v);
    return it ? typeInfo(c, it.typeId) : null;
  };
  def(rt, "GetItemName", (c, a) => jStr(ofItem(c, a[0])?.name ?? ""));
  def(rt, "GetItemLevel", (c, a) => jInt(ofItem(c, a[0])?.level ?? 0));
  def(rt, "GetItemType", (c, a) => c.rt.enumHandle("ItemType", indexOfClass(ofItem(c, a[0])?.classType ?? "")));
  def(rt, "IsItemPowerup", (c, a) => jBool(ofItem(c, a[0])?.powerup ?? false));
  def(rt, "IsItemSellable", (c, a) => jBool(ofItem(c, a[0])?.sellable ?? false));
  // Pawnable can be overridden per item (SetItemPawnable); default from the item's data.
  def(rt, "IsItemPawnable", (c, a) => {
    const it = item(c, a[0]);
    return jBool(it?.pawnable ?? (it ? typeInfo(c, it.typeId)?.pawnable ?? false : false));
  });
  def(rt, "IsItemIdPowerup", (c, a) => jBool(typeInfo(c, intToRawcode(asInt(a[0])))?.powerup ?? false));
  def(rt, "IsItemIdSellable", (c, a) => jBool(typeInfo(c, intToRawcode(asInt(a[0])))?.sellable ?? false));
  def(rt, "IsItemIdPawnable", (c, a) => jBool(typeInfo(c, intToRawcode(asInt(a[0])))?.pawnable ?? false));

  // --- per-instance flags. WC3 keeps these on the item; our sim models none of them
  // (a ground item here is neither hideable nor destructible), so they live on the handle:
  // set and read back faithfully — CheckItemStatus and the GUI conditions that ride on it
  // work — but only the script observes them. Honest, and no lie to the map. ---
  def(rt, "SetItemVisible", (c, a) => {
    const it = item(c, a[0]);
    if (it) it.visible = a[1].k === "bool" && a[1].b;
    return JNULL;
  });
  def(rt, "IsItemVisible", (c, a) => jBool(item(c, a[0])?.visible ?? true));
  def(rt, "SetItemInvulnerable", (c, a) => {
    const it = item(c, a[0]);
    if (it) it.invulnerable = a[1].k === "bool" && a[1].b;
    return JNULL;
  });
  def(rt, "IsItemInvulnerable", (c, a) => jBool(item(c, a[0])?.invulnerable ?? false));
  def(rt, "SetItemDroppable", (c, a) => {
    const it = item(c, a[0]);
    if (it) it.droppable = a[1].k === "bool" && a[1].b;
    return JNULL;
  });
  def(rt, "SetItemPawnable", (c, a) => {
    const it = item(c, a[0]);
    if (it) it.pawnable = a[1].k === "bool" && a[1].b;
    return JNULL;
  });
  def(rt, "GetItemUserData", (c, a) => jInt(item(c, a[0])?.userData ?? 0));
  def(rt, "SetItemUserData", (c, a) => {
    const it = item(c, a[0]);
    if (it) it.userData = asInt(a[1]);
    return JNULL;
  });
  // Drop-on-death / drop-id (which unit an item is bound to drop from) and item ownership
  // colour have no counterpart in our engine yet — accept them rather than log a miss.
  def(rt, "SetItemDropOnDeath", () => JNULL);
  def(rt, "SetItemDropID", () => JNULL);
  def(rt, "SetItemPlayer", () => JNULL);

  // --- a unit's inventory ---------------------------------------------------
  def(rt, "UnitAddItem", (c, a) => {
    const u = unitSim(c, a[0]);
    const it = item(c, a[1]);
    if (u === undefined || !it || it.simId < 0) return jBool(false);
    return jBool(c.rt.hooks?.unitAddItem?.(u, it.simId, -1) ?? false);
  });
  // UnitAddItemById — create the item AT THE UNIT and hand it over. If the inventory is
  // full it simply stays on the ground at the hero's feet, which is exactly the behaviour
  // blizzard.j's UnitAddItemByIdSwapped spells out in its own comment ("create the item at
  // the hero's feet first … so that it will be left at his feet if his inventory is full").
  // This is what finally gives a melee hero its Town Portal scroll (MeleeGrantItemsToHero).
  def(rt, "UnitAddItemById", (c, a) => {
    const u = c.rt.data<JassUnit>(a[0]);
    const simId = u && u.simId >= 0 ? u.simId : undefined;
    const x = simId !== undefined ? c.rt.hooks?.getUnitX?.(simId) ?? u!.x : u?.x ?? 0;
    const y = simId !== undefined ? c.rt.hooks?.getUnitY?.(simId) ?? u!.y : u?.y ?? 0;
    const handle = createItem(c, asInt(a[1]), x, y);
    const it = item(c, handle);
    if (simId !== undefined && it && it.simId >= 0) c.rt.hooks?.unitAddItem?.(simId, it.simId, -1);
    return handle;
  });
  // UnitAddItemToSlotById — into ONE slot, or not at all: an occupied slot fails, and the
  // item we speculatively created is destroyed again so no stray appears on the ground.
  def(rt, "UnitAddItemToSlotById", (c, a) => {
    const u = c.rt.data<JassUnit>(a[0]);
    const simId = u && u.simId >= 0 ? u.simId : undefined;
    if (simId === undefined) return jBool(false);
    const x = c.rt.hooks?.getUnitX?.(simId) ?? u!.x;
    const y = c.rt.hooks?.getUnitY?.(simId) ?? u!.y;
    const it = item(c, createItem(c, asInt(a[1]), x, y));
    if (!it || it.simId < 0) return jBool(false);
    const ok = c.rt.hooks?.unitAddItem?.(simId, it.simId, asInt(a[2])) ?? false;
    if (!ok) c.rt.hooks?.removeItem?.(it.simId);
    return jBool(ok);
  });
  def(rt, "UnitRemoveItem", (c, a) => {
    const u = unitSim(c, a[0]);
    const it = item(c, a[1]);
    if (u !== undefined && it && it.simId >= 0) c.rt.hooks?.unitRemoveItem?.(u, it.simId);
    return JNULL;
  });
  def(rt, "UnitRemoveItemFromSlot", (c, a) => {
    const u = unitSim(c, a[0]);
    if (u === undefined) return JNULL;
    return itemHandle(c, c.rt.hooks?.unitRemoveItemFromSlot?.(u, asInt(a[1])) ?? 0);
  });
  def(rt, "UnitHasItem", (c, a) => {
    const u = unitSim(c, a[0]);
    const it = item(c, a[1]);
    return jBool(u !== undefined && !!it && info(c, it)?.holder === u);
  });
  def(rt, "UnitItemInSlot", (c, a) => {
    const u = unitSim(c, a[0]);
    if (u === undefined) return JNULL;
    return itemHandle(c, c.rt.hooks?.unitItemInSlot?.(u, asInt(a[1])) ?? 0);
  });
  def(rt, "UnitInventorySize", (c, a) => {
    const u = unitSim(c, a[0]);
    return jInt(u === undefined ? 0 : c.rt.hooks?.unitInventorySize?.(u) ?? 0);
  });

  // --- dropping / giving / using -------------------------------------------
  // A trigger's drop is INSTANT (unlike the player's drop order, which walks the hero to
  // the spot first) — the GUI's "Hero - Drop item" puts it there and then.
  const withUnitItem = (c: NativeCtx, uv: JassValue, iv: JassValue, fn: (u: number, i: number) => boolean): JassValue => {
    const u = unitSim(c, uv);
    const it = item(c, iv);
    return jBool(u !== undefined && !!it && it.simId >= 0 && fn(u, it.simId));
  };
  def(rt, "UnitDropItemPoint", (c, a) =>
    withUnitItem(c, a[0], a[1], (u, i) => c.rt.hooks?.unitDropItemPoint?.(u, i, asNum(a[2]), asNum(a[3])) ?? false));
  // UnitDropItemSlot MOVES the item within the unit's own inventory (the GUI's "Give item
  // to slot") — despite the name, nothing is dropped.
  def(rt, "UnitDropItemSlot", (c, a) =>
    withUnitItem(c, a[0], a[1], (u, i) => c.rt.hooks?.unitDropItemSlot?.(u, i, asInt(a[2])) ?? false));
  // UnitDropItemTarget hands the item to another unit (the GUI's "Give item to hero").
  def(rt, "UnitDropItemTarget", (c, a) =>
    withUnitItem(c, a[0], a[1], (u, i) => {
      const t = unitSim(c, a[2]);
      return t === undefined ? false : c.rt.hooks?.unitDropItemTarget?.(u, i, t) ?? false;
    }));
  const useItem = (c: NativeCtx, uv: JassValue, iv: JassValue, targetV: JassValue | undefined, x: number, y: number): JassValue =>
    withUnitItem(c, uv, iv, (u, i) => c.rt.hooks?.unitUseItem?.(u, i, (targetV && unitSim(c, targetV)) || 0, x, y) ?? false);
  def(rt, "UnitUseItem", (c, a) => useItem(c, a[0], a[1], undefined, 0, 0));
  def(rt, "UnitUseItemPoint", (c, a) => useItem(c, a[0], a[1], undefined, asNum(a[2]), asNum(a[3])));
  def(rt, "UnitUseItemTarget", (c, a) => useItem(c, a[0], a[1], a[2], 0, 0));

  // --- enumeration ----------------------------------------------------------
  // EnumItemsInRect(rect, filter, actionFunc) — the ground items inside a rect, each
  // exposed to the filter as GetFilterItem and to the action as GetEnumItem. blizzard.j's
  // RandomItemInRectBJ ("pick a random item in <region>") is built on exactly this.
  def(rt, "EnumItemsInRect", (c, a) => {
    const r = c.rt.data<RectObj>(a[0]);
    const be = a[1].k === "handle" ? c.rt.data<BoolExpr>(a[1]) : undefined;
    const action = a[2].k === "code" ? a[2].fn : null;
    if (!r) return JNULL;
    for (const snap of c.rt.hooks?.enumItems?.() ?? []) {
      if (snap.x < r.minx || snap.x > r.maxx || snap.y < r.miny || snap.y > r.maxy) continue;
      const handle = c.rt.itemForSim(snap);
      if (be?.fn) {
        c.rt.eventStack.push(new Map([["FilterItem", handle]]));
        let passed = false;
        try {
          passed = truthy(c.call(be.fn, []));
        } finally {
          c.rt.eventStack.pop();
        }
        if (!passed) continue;
      }
      if (!action) continue;
      c.rt.eventStack.push(new Map([["EnumItem", handle]]));
      try {
        c.call(action, []);
      } finally {
        c.rt.eventStack.pop();
      }
    }
    return JNULL;
  });

  // --- random item pools ----------------------------------------------------
  // ChooseRandomItemEx(itemtype, level) → an item TYPE id (a rawcode int), drawn from the
  // same "eligible for a random drop" pool the creep drop tables use. 151 of the bundled
  // maps call it (usually through ChooseRandomItemExBJ, and often to fill a
  // RandomDistAddItem distribution — which is pure blizzard.j and needs nothing from us).
  // ITEM_TYPE_ANY (8) means any class; a level < 0 means any level (common.j's rule).
  const chooseRandom = (c: NativeCtx, classIdx: number, level: number): JassValue => {
    const cls = classIdx === 8 ? null : classOfIndex(classIdx);
    return jInt(rawcodeToInt(c.rt.hooks?.chooseRandomItem?.(cls, level) ?? ""));
  };
  def(rt, "ChooseRandomItem", (c, a) => chooseRandom(c, 8, asInt(a[0])));
  def(rt, "ChooseRandomItemEx", (c, a) => chooseRandom(c, c.rt.enumIndex(a[0]), asInt(a[1])));
}
