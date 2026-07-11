// WC3 unit order IDs (Phase 7 — issue #33; see docs/triggers.md).
//
// The engine's OrderId(string) maps an order name to a stable integer the trigger
// API compares against — GUI code always writes `GetIssuedOrderId() == OrderId("attack")`,
// never a raw literal, so the exact numbers only need to be *self-consistent*. We still
// use the real engine constants: the generic movement/attack orders live in the
// 0x000D0000 block (base 851968), the well-known community values, so a hand-written
// script that hard-codes the literal (e.g. 851983) still matches. Ability-based orders
// (a spell's "Order String") are NOT in this table — OrderId returns 0 for anything
// unknown, exactly like the engine does for an unrecognised string.

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

const ID_TO_STRING = new Map<number, string>(Object.entries(ORDER_IDS).map(([s, i]) => [i, s]));

/** OrderId / String2OrderId — name → integer id (0 if unknown, matching the engine). */
export function orderStringToId(s: string): number {
  return ORDER_IDS[s.toLowerCase()] ?? 0;
}
/** OrderId2String — integer id → name ("" if unknown). */
export function orderIdToString(id: number): string {
  return ID_TO_STRING.get(id) ?? "";
}
