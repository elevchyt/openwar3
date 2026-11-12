// WC3 unit order IDs (Phase 7 — issue #33; see docs/triggers.md).
//
// The engine's OrderId(string) maps an order name to a stable integer the trigger API compares
// against. GUI code writes `GetIssuedOrderId() == OrderId("attack")`, for which the numbers
// would only need to be self-consistent — but a hand-written script writes the LITERAL, and an
// optimiser inlines `OrderId("blizzard")` to 852089 for everybody else. So every order that has
// an engine id answers with it (orderIds.ts), and only a string the engine never numbered —
// a map's own Channel "Base Order ID" spelled as something new — is minted one.
import { ENGINE_ORDER_IDS } from "./orderIds";

/** The generic order strings the GUI point/target/immediate order actions emit. */
export const ORDER_IDS: Record<string, number> = {
  smart: 851971, // 0xD0003 — right-click default (move / attack / harvest / follow)
  stop: 851972, // 0xD0004
  attack: 851983, // 0xD000F
  attackground: 851984, // 0xD0010
  move: 851986, // 0xD0012
  patrol: 851990, // 0xD0016
  holdposition: 851993, // 0xD0019
};

/**
 * The orders with NO string counterpart — `OrderId2String` answers nothing for them, and a
 * script can only ever name them by number (WurstStdlib2 Orders.wurst, class `SpecialOrders`).
 * The inventory's are the ones maps lean on: 852002–852007 drag an item to slot 0–5 (an item-
 * targeted order) and 852008–852013 USE the item in slot 0–5, which is the only way a trigger
 * can tell "the hero used an item" from "the hero cast a spell" before the cast happens.
 */
export const SPECIAL_ORDERS = {
  stunned: 851973, // the "order" a stunned / paused unit reports
  cancel: 851976,
  skillMenu: 852000,
  itemDrag0: 852002,
  itemUse0: 852008,
} as const;

/** 852008–852013 → the inventory slot (0–5) the order uses, else -1. */
export function itemUseSlot(orderId: number): number {
  const slot = orderId - SPECIAL_ORDERS.itemUse0;
  return slot >= 0 && slot < 6 ? slot : -1;
}
/** 852002–852007 → the inventory slot (0–5) the order drags an item to, else -1. */
export function itemDragSlot(orderId: number): number {
  const slot = orderId - SPECIAL_ORDERS.itemDrag0;
  return slot >= 0 && slot < 6 ? slot : -1;
}

const ID_TO_STRING = new Map<number, string>([...Object.entries(ENGINE_ORDER_IDS), ...Object.entries(ORDER_IDS)].map(([s, i]) => [i, s]));

// --- orders the engine never numbered ----------------------------------------------------------
// A map may give a Channel-based ability an order string of its own choosing, and a headless
// test may ask for any word at all. Those get a stable id MINTED on first sight, in a private
// block above the engine's (which end at 0xD02BD). Self-consistency is all such a string can
// ask for: `GetIssuedOrderId() == OrderId("mycustomorder")` holds, and the order still reaches
// the sim, since the bridge carries the STRING alongside the id.
const ABILITY_ORDER_BASE = 0x000e0000; // 917504 — clear of the 0xD block
let nextAbilityOrderId = ABILITY_ORDER_BASE;
const MINTED = new Map<string, number>();

/** Name → integer id: the engine's own where it has one (orderIds.ts), else a minted,
 *  stable one. */
export function orderStringToId(s: string): number {
  const name = s.trim().toLowerCase();
  if (!name) return 0;
  const known = ORDER_IDS[name] ?? ENGINE_ORDER_IDS[name];
  if (known !== undefined) return known;
  let id = MINTED.get(name);
  if (id === undefined) {
    id = nextAbilityOrderId++;
    MINTED.set(name, id);
    ID_TO_STRING.set(id, name);
  }
  return id;
}
// --- which strings ARE orders --------------------------------------------------------------
// `OrderId("footman")` is 0 in the game: a unit's NAME is not an order string, and blizzard.j's
// String2OrderIdBJ says so by falling back on `UnitId` when OrderId answers 0 ("Check to see if
// it's a (train) unit order"). Minting an id for every string made that fallback unreachable.
// So the OrderId NATIVE answers only for a string that is an order — one the engine numbers
// (orderIds.ts, which is also what answers the orders no data file names: the Acolyte's
// `acolyteharvest`, the inventory's `getitem`/`dropitem`, a toggle's other half), an ability's
// `Order`/`Orderon`/`Orderoff`/`Unorder`, or one of `UI\TriggerData.txt`'s `UnitOrder…`
// strings — and 0 for anything else. The ISSUE paths still mint (a script's order
// must reach the unit whatever it spells), and a string one of them has already minted keeps
// its id here too, so the two can never disagree about an order that was actually given.
const VOCABULARY = new Set<string>();

/** Teach the order vocabulary (the ability registry's order strings, TriggerData's list). */
export function learnOrderStrings(strings: Iterable<string>): void {
  for (const s of strings) {
    const name = s.trim().toLowerCase();
    if (name) VOCABULARY.add(name);
  }
}

/** The `OrderId` / `String2OrderId` natives: a generic order's real id, an ability order's minted
 *  one, and 0 for a string that is no order at all (see VOCABULARY). With no vocabulary taught
 *  (a headless interpreter with no data behind it) every string is taken as an order, as before. */
export function orderIdOf(s: string): number {
  const name = s.trim().toLowerCase();
  if (!name) return 0;
  if (ORDER_IDS[name] !== undefined || ENGINE_ORDER_IDS[name] !== undefined || MINTED.has(name) || !VOCABULARY.size || VOCABULARY.has(name)) {
    return orderStringToId(name);
  }
  return 0;
}

/** OrderId2String — integer id → name ("" if unknown). */
export function orderIdToString(id: number): string {
  return ID_TO_STRING.get(id) ?? "";
}
/** Is this an ABILITY order's id — anything with a string that is not one of the generic
 *  movement/attack orders? */
export function isAbilityOrder(id: number): boolean {
  const s = ID_TO_STRING.get(id);
  return s !== undefined && ORDER_IDS[s] === undefined;
}
