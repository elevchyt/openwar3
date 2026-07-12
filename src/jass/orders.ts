// WC3 unit order IDs (Phase 7 — issue #33; see docs/triggers.md).
//
// The engine's OrderId(string) maps an order name to a stable integer the trigger
// API compares against — GUI code always writes `GetIssuedOrderId() == OrderId("attack")`,
// never a raw literal, so the exact numbers only need to be *self-consistent*. We still
// use the real engine constants where we know them: the generic movement/attack orders
// live in the 0x000D0000 block (base 851968), the well-known community values, so a
// hand-written script that hard-codes the literal (e.g. 851983) still matches.

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

// --- ability orders (7.17) ---------------------------------------------------
// Every castable ability has its own order string (AbilityFunc `Order=holybolt`), and
// the GUI's "Unit - Order <unit> to <ability>" compiles to
// `IssueTargetOrder(u, "holybolt", target)`. The engine's ids for those live in a big
// table we don't have (they're not in any data file — see docs/triggers.md), so we MINT
// a stable id for each ability order string on first sight, in a private block above the
// generic ones. Self-consistency is what matters: `GetIssuedOrderId() == OrderId("holybolt")`
// holds, and the order still reaches the sim (the bridge carries the STRING alongside the
// id, so the cast doesn't depend on the number at all). A script that hard-codes an
// ability order's raw literal — vanishingly rare, and unwritable in the GUI — won't match.
const ABILITY_ORDER_BASE = 0x000e0000; // 917504 — clear of the 0xD block
let nextAbilityOrderId = ABILITY_ORDER_BASE;
const MINTED = new Map<string, number>();

/** OrderId / String2OrderId — name → integer id. Generic orders keep their real engine
 *  id; any other non-empty string is an ability order and gets a minted, stable id. */
export function orderStringToId(s: string): number {
  const name = s.trim().toLowerCase();
  if (!name) return 0;
  const known = ORDER_IDS[name];
  if (known !== undefined) return known;
  let id = MINTED.get(name);
  if (id === undefined) {
    id = nextAbilityOrderId++;
    MINTED.set(name, id);
    ID_TO_STRING.set(id, name);
  }
  return id;
}
/** OrderId2String — integer id → name ("" if unknown). */
export function orderIdToString(id: number): string {
  return ID_TO_STRING.get(id) ?? "";
}
/** Is this a minted ability-order id (not one of the generic movement/attack orders)? */
export function isAbilityOrder(id: number): boolean {
  return id >= ABILITY_ORDER_BASE;
}
