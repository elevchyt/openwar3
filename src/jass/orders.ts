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
// --- which strings ARE orders --------------------------------------------------------------
// `OrderId("footman")` is 0 in the game: a unit's NAME is not an order string, and blizzard.j's
// String2OrderIdBJ says so by falling back on `UnitId` when OrderId answers 0 ("Check to see if
// it's a (train) unit order"). Minting an id for every string made that fallback unreachable.
// So the OrderId NATIVE answers only for a string that is an order somewhere in the data — an
// ability's `Order`/`Orderon`/`Orderoff`/`Unorder`, or one of `UI\TriggerData.txt`'s
// `UnitOrder…` strings — and 0 for anything else. The ISSUE paths still mint (a script's order
// must reach the unit whatever it spells), and a string one of them has already minted keeps
// its id here too, so the two can never disagree about an order that was actually given.
const VOCABULARY = new Set<string>();

/**
 * The ENGINE's orders that no data file names — real order strings (each has an order id and a
 * string in the game) that are neither an ability's `Order` column nor a TriggerData `UnitOrder`:
 * the Acolyte's `acolyteharvest`, the worker's `resumeharvesting`, the inventory's `getitem` /
 * `dropitem`, a toggle's other half (`unwindwalk`, `barkskinoff`). The list is the difference
 * between that vocabulary and the table of every order that HAS a string counterpart in
 * WurstStdlib2's `_wurst/assets/Orders.wurst` (class `OrderIds`, credited there to cJass's
 * cj_order.j) — names only. DotA's AI asks for `OrderId("acolyteharvest")`, the one corpus call
 * the data alone would have answered 0.
 */
const ENGINE_ORDERS: ReadonlySet<string> = new Set([
  "acolyteharvest", "ancestralspirittarget", "auraunholy", "auravampiric", "barkskin",
  "barkskinoff", "barkskinon", "blight", "coupletarget", "detectaoe", "disassociate", "dropitem",
  "ensnareoff", "ensnareon", "flamingarrowstarg", "getitem", "gold2lumber", "loadcorpseinstant",
  "lumber2gold", "mechanicalcritter", "militiaconvert", "militiaunconvert", "moveai",
  "neutraldetectaoe", "neutralinteract", "neutralspell", "phaseshiftinstant", "phoenixfire",
  "phoenixmorph", "preservation", "rainofchaos", "request_hero", "resumebuild", "resumeharvesting",
  "sanctuary", "shadowsight", "spellshield", "spellshieldaoe", "spies", "spirittroll", "steal",
  "tankdroppilot", "tankloadpilot", "tankpilot", "unavatar", "unavengerform", "unloadallinstant",
  "unwindwalk", "wispharvest",
]);

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
  if (ORDER_IDS[name] !== undefined || MINTED.has(name) || !VOCABULARY.size || VOCABULARY.has(name) || ENGINE_ORDERS.has(name)) {
    return orderStringToId(name);
  }
  return 0;
}

/** OrderId2String — integer id → name ("" if unknown). */
export function orderIdToString(id: number): string {
  return ID_TO_STRING.get(id) ?? "";
}
/** Is this a minted ability-order id (not one of the generic movement/attack orders)? */
export function isAbilityOrder(id: number): boolean {
  return id >= ABILITY_ORDER_BASE;
}
