// Headless checks of the three Computer+ behaviours that all turn on the HERO:
// its belt (src/ai/plus/items.ts), its creeping clock (src/ai/plus/profile.ts) and where its
// scout stops (src/ai/plus/index.ts `scoutRing`).
//
// What each is here to pin:
//
//   1. THE SCOUT STOPS OUTSIDE. Leg 0 used to be the enemy town centre, which walks a lone
//      worker through the front door; it dies, `scoutDone` latches, and that one walk is the
//      whole of what the AI ever learns about the map.
//   2. NORMAL AND INSANE ACTUALLY CREEP. `creeps: true` did not produce a computer that creeps,
//      because creeping was a rung of `pickTarget` and `pickTarget` sits behind the WAVE gates —
//      so a Normal computer's first camp came at five minutes. The clock is now its own.
//   3. THE BELT. Which button a hero presses, and when. `hopeless`-style: both directions
//      matter and the false one matters more — a hero that drinks its Potion of Invulnerability
//      because a Peasant walked past has wasted the game's most expensive save.
//
// None of these numbers are Warcraft III's (nothing in the install describes an AI that shops)
// so this pins OUR tuning. What IS the game's is the item data every case is built from — the
// ability codes in `abilList`, and the shop rows quoted in items.ts.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { PlusItems } = require(join(REPO, ".sim-build", "src", "ai", "plus", "items.js"));
const { scoutRing, SCOUT_RING_LEGS } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
const { PLUS_EASY, PLUS_NORMAL, PLUS_INSANE } = require(join(REPO, ".sim-build", "src", "ai", "plus", "profile.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// ==========================================================================================
console.log("\n-- the scout looks at a base, it does not walk into one --------------------");
// ==========================================================================================

// A melee start pair: our hall bottom-left, theirs top-right, the usual Echo Isles diagonal.
const HOME = { x: -3000, y: -3000 };
const BASE = { x: 3000, y: 3000 };
// A generous read of "their base": a melee start location's buildings sit well inside this.
const BASE_RADIUS = 700;

for (let leg = 0; leg < SCOUT_RING_LEGS; leg++) {
  const p = scoutRing(BASE, HOME, leg);
  const d = Math.hypot(p.x - BASE.x, p.y - BASE.y);
  check(`leg ${leg} stops outside the base (${Math.round(d)} units out)`, d > BASE_RADIUS, true);
}
// Leg 0 is on OUR side of it — the side the scout reaches first. Anything else is a walk round
// the whole base before it has looked at any of it.
{
  const p = scoutRing(BASE, HOME, 0);
  const toHome = Math.hypot(p.x - HOME.x, p.y - HOME.y);
  const baseToHome = Math.hypot(BASE.x - HOME.x, BASE.y - HOME.y);
  check("leg 0 is on the approach side (nearer home than the base is)", toHome < baseToHome, true);
}
// …and the other two are genuinely different vantage points, not the same spot again.
{
  const [a, b, c] = [0, 1, 2].map((l) => scoutRing(BASE, HOME, l));
  check("the three stops are three different places",
    Math.hypot(a.x - b.x, a.y - b.y) > 500 && Math.hypot(a.x - c.x, a.y - c.y) > 500, true);
  check("…on the same ring", Math.abs(Math.hypot(b.x - BASE.x, b.y - BASE.y) - Math.hypot(c.x - BASE.x, c.y - BASE.y)) < 1, true);
}

// ==========================================================================================
console.log("\n-- Normal and Insane farm creep camps --------------------------------------");
// ==========================================================================================

for (const [name, p] of [["Normal", PLUS_NORMAL], ["Insane", PLUS_INSANE]]) {
  check(`${name} creeps at all`, p.creeps, true);
  // THE BUG. Creeping used to be reached only after the wave gates opened, so this comparison
  // is the whole fix: the creep clock has to be well BEFORE the attack clock or the AI is
  // creeping with the army it built to attack with, at the time it meant to attack.
  check(`${name} creeps well before it attacks (${p.creepAt}s vs ${p.firstAttack}s)`,
    p.creepAt < p.firstAttack, true);
  // …and with a party, not a wave. Waiting for `attackFood` is waiting until creeping is over.
  check(`${name} creeps with less than a wave (${p.creepFood} vs ${p.attackFood} food)`,
    p.creepFood < p.attackFood, true);
}
check("Easy never creeps", PLUS_EASY.creeps, false);
check("Insane starts creeping before Normal", PLUS_INSANE.creepAt < PLUS_NORMAL.creepAt, true);

console.log("\n-- …and shops ---------------------------------------------------------------");
check("Easy never shops", PLUS_EASY.shopping, 0);
check("Normal shops", PLUS_NORMAL.shopping > 0, true);
check("Insane fills the whole belt", PLUS_INSANE.shopping, 6);
check("Insane keeps a Town Portal", PLUS_INSANE.keepPortal, true);
check("Insane parts with more gold than Normal", PLUS_INSANE.itemReserve < PLUS_NORMAL.itemReserve, true);

// ==========================================================================================
console.log("\n-- the belt: which button, and when ----------------------------------------");
// ==========================================================================================

// The real item rows, from ItemData.slk (`abilList`, `usable`, `goldcost`) — see items.ts.
const ITEMS = {
  stwp: { id: "stwp", gold: 350, usable: true, abilities: ["AItp"] }, // Scroll of Town Portal
  phea: { id: "phea", gold: 150, usable: true, abilities: ["AIh1"] }, // Potion of Healing
  pnvl: { id: "pnvl", gold: 150, usable: true, abilities: ["AIvl"] }, // Potion of Lesser Invuln.
  shea: { id: "shea", gold: 250, usable: true, abilities: ["AIha"] }, // Scroll of Healing
  hslv: { id: "hslv", gold: 100, usable: true, abilities: ["AIrl"] }, // Healing Salve
  pclr: { id: "pclr", gold: 160, usable: true, abilities: ["AIpr"] }, // Clarity Potion
  spro: { id: "spro", gold: 150, usable: true, abilities: ["AIda"] }, // Scroll of Protection
  bspd: { id: "bspd", gold: 250, usable: false, abilities: ["AIms"] }, // Boots of Speed — passive
};
// And the ability rows' `target`, which is the whole of how an item is AIMED (items.ts `aim`).
const ABILS = {
  AItp: { code: "AItp", target: "point" }, // click anywhere; the nearest hall answers
  AIh1: { code: "AIh1", target: "" },
  AIvl: { code: "AIvl", target: "" },
  AIha: { code: "AIha", target: "" }, // Area1 600 — the area, not a click
  AIrl: { code: "AIrl", target: "unit" }, // the one regeneration item you point at somebody
  AIpr: { code: "AIpr", target: "" },
  AIda: { code: "AIda", target: "" },
  AIms: { code: "AIms", target: "" },
};

let nextId = 1;
const unit = (o = {}) => ({
  id: nextId++, owner: 0, x: 0, y: 0, radius: 16, hp: 1000, maxHp: 1000, mana: 100, maxMana: 100,
  isHero: false, isPeon: false, building: null, paused: false, stunned: false, isIllusion: false,
  morphT: 0, spawning: 0, level: 1, typeId: "hfoo", inventory: [], ...o,
});
const hero = (o = {}) => unit({ isHero: true, typeId: "Hamg", inventory: [null, null, null, null, null, null], ...o });
const belt = (h, ...ids) => { ids.forEach((id, i) => { h.inventory[i] = { itemId: id, charges: 1 }; }); return h; };

/** Drive one pass and report the `useitem` command it produced, if any. */
function pressed(units, profile, ctx, opts = {}) {
  const orders = [];
  const world = {
    units: new Map(units.map((u) => [u.id, u])),
    itemReadyError: () => opts.notReady ?? null,
    itemUseError: () => opts.badTarget ?? null,
    shopReaches: () => false,
    shopStock: () => -1,
    missingForShop: () => [],
    isShopUnit: () => false,
  };
  const items = new PlusItems({
    world, player: 0,
    def: (id) => ABILS[id],
    hostile: (u) => u.owner !== 0,
    order: (cmd) => { orders.push(cmd); return true; },
    item: (id) => ITEMS[id],
    wares: () => [],
    gold: () => opts.gold ?? 0,
  }, profile);
  items.pass(opts.now ?? 100, ctx);
  return orders.find((c) => c.c === "useitem") ?? null;
}

const CTX = { home: { x: 0, y: 0 }, losing: false, mayShop: false };
const AWAY = { ...CTX, home: { x: 9000, y: 9000 } }; // the fight is far from home
const enemy = (o = {}) => unit({ owner: 1, ...o });
const itemOf = (cmd) => (cmd ? cmd.slot : null);

// --- nothing is pressed when nothing is happening ------------------------------------------
{
  const h = belt(hero(), "phea", "pnvl", "stwp");
  check("a healthy hero standing alone presses nothing", pressed([h], PLUS_INSANE, AWAY), null);
}

// --- the healing potion, in a fight ----------------------------------------------------------
{
  const h = belt(hero({ hp: 400 }), "phea"); // 40% — under HURT_HP, over PANIC_HP
  const cmd = pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY);
  check("a hurt hero in a fight drinks its healing potion", itemOf(cmd), 0);
  check("…on itself, with no target", cmd && cmd.targetId, 0);
}
{
  const h = belt(hero({ hp: 400 }), "phea");
  check("…but not while nothing is attacking it", pressed([h], PLUS_INSANE, AWAY), null);
}
{
  const h = belt(hero({ hp: 950 }), "phea");
  check("…nor at a scratch", pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}

// --- the panic button outranks the potion -----------------------------------------------------
{
  const h = belt(hero({ hp: 200 }), "phea", "pnvl"); // 20% — under PANIC_HP
  check("about to die, it reaches for invulnerability rather than the potion",
    itemOf(pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY)), 1);
}

// --- the Town Portal outranks everything -------------------------------------------------------
{
  const h = belt(hero({ hp: 200 }), "phea", "pnvl", "stwp");
  const cmd = pressed([h, enemy({ x: 200 })], PLUS_INSANE, { ...AWAY, losing: true });
  check("a lost fight: it scrolls out before it drinks anything", itemOf(cmd), 2);
  // Where it goes is the whole question — itemTownPortal picks the hall nearest the CLICKED
  // point, so clicking home is what sends it home rather than to whichever hall is nearest here.
  check("…aimed at home, not at the fight", cmd && cmd.x === 9000 && cmd.y === 9000, true);
}
{
  const h = belt(hero({ hp: 1000, x: 0, y: 0 }), "stwp");
  check("…but never from the doorstep of its own base",
    pressed([h, enemy({ x: 200 })], PLUS_INSANE, { ...CTX, losing: true }), null);
}
{
  const h = belt(hero(), "stwp");
  check("…nor when it is winning", pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}

// --- healing the ARMY, not just the hero --------------------------------------------------------
{
  // Three hurt soldiers around a healthy hero: this is what the scroll is for.
  const h = belt(hero(), "shea", "phea");
  const hurt = [1, 2, 3].map((i) => unit({ hp: 300, maxHp: 1000, x: 100 * i }));
  check("three hurt soldiers: it reads the area heal", itemOf(pressed([h, ...hurt, enemy({ x: 200 })], PLUS_INSANE, AWAY)), 0);
}
{
  // One hurt soldier is a potion's job, not a scroll's — and the hero itself is fine.
  const h = belt(hero(), "shea");
  check("…one hurt soldier is not worth a charge",
    pressed([h, unit({ hp: 300, maxHp: 1000, x: 100 }), enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}
{
  // The Healing Salve is the one healing item you point at somebody.
  const h = belt(hero(), "hslv");
  const wounded = unit({ hp: 200, maxHp: 1000, x: 150 });
  const cmd = pressed([h, wounded, enemy({ x: 200 })], PLUS_INSANE, AWAY);
  check("the Healing Salve goes on the hurt soldier", itemOf(cmd), 0);
  check("…aimed at that unit", cmd && cmd.targetId, wounded.id);
}

// --- mana ------------------------------------------------------------------------------------
{
  const h = belt(hero({ mana: 10, maxMana: 100 }), "pclr");
  check("an empty caster drinks its Clarity Potion", itemOf(pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY)), 0);
}
{
  const h = belt(hero({ mana: 90, maxMana: 100 }), "pclr");
  check("…and a full one does not", pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}

// --- refusals ----------------------------------------------------------------------------------
{
  const h = belt(hero({ hp: 400 }), "phea");
  check("a cooling-down item is never pressed (itemReadyError is the sim's)",
    pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY, { notReady: "cooldown" }), null);
}
{
  const h = belt(hero({ hp: 400 }), "phea");
  check("nor one the sim refuses to aim (itemUseError)",
    pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY, { badTarget: "Targetunit" }), null);
}
{
  const h = belt(hero({ hp: 400, stunned: true }), "phea");
  check("a stunned hero drinks nothing", pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}
{
  const h = belt(hero({ hp: 400 }), "bspd"); // Boots of Speed are carried, not pressed
  check("a passive item is never pressed", pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}
{
  // An illusion of a hero shows a copy of the belt; pressing from it would spend real charges.
  const h = belt(hero({ hp: 400, isIllusion: true }), "phea");
  check("an illusion presses nothing", pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}

// ==========================================================================================
console.log("\n-- shopping ------------------------------------------------------------------");
// ==========================================================================================

const MERCHANT = unit({ owner: 12, typeId: "ngme", building: { constructionLeft: 0, stock: null } });

/** Drive one pass against a shop and report what it did about buying. */
function shopped(units, profile, opts = {}) {
  const orders = [];
  const shelf = opts.shelf ?? ["stwp", "phea", "shea", "pnvl", "spro", "bspd"]; // [ngme] Sellitems
  const world = {
    units: new Map(units.map((u) => [u.id, u])),
    itemReadyError: () => null,
    itemUseError: () => null,
    shopReaches: () => opts.inRange ?? true,
    // -1 is "not stock-limited"; 0 is "sold out" — the sim's own distinction.
    shopStock: (_id, ware) => (opts.soldOut?.includes(ware) ? 0 : -1),
    missingForShop: (_id, ware) => (opts.needsTech?.includes(ware) ? ["TWN2"] : []),
    isShopUnit: (id) => id === MERCHANT.id,
  };
  const items = new PlusItems({
    world, player: 0,
    def: (id) => ABILS[id],
    hostile: (u) => u.owner !== 0 && u.owner !== 12, // a Goblin Merchant is Neutral Passive
    order: (cmd) => { orders.push(cmd); return true; },
    item: (id) => ITEMS[id],
    wares: () => shelf,
    gold: () => opts.gold ?? 5000,
  }, profile);
  items.pass(opts.now ?? 500, { home: { x: 0, y: 0 }, losing: false, mayShop: opts.mayShop ?? true });
  return {
    buy: orders.find((c) => c.c === "buyitem") ?? null,
    move: orders.find((c) => c.c === "order") ?? null,
  };
}

{
  const h = hero();
  const r = shopped([h, MERCHANT], PLUS_INSANE);
  // Insane keeps a Town Portal, so it is first on its list — before the potions, because the
  // potions are no use if the army the scroll would have saved is dead.
  check("Insane buys the Town Portal first", r.buy && r.buy.itemId, "stwp");
}
{
  const h = hero();
  // Normal has no Town Portal habit, so the healing potion leads instead.
  check("Normal buys the healing potion first", shopped([h, MERCHANT], PLUS_NORMAL).buy?.itemId, "phea");
}
{
  const h = hero();
  check("Easy buys nothing at all", shopped([h, MERCHANT], PLUS_EASY).buy, null);
}
{
  // It does not buy what it already carries enough of. `stwp` wants 1.
  const h = belt(hero(), "stwp");
  check("…and never a second Town Portal", shopped([h, MERCHANT], PLUS_INSANE).buy?.itemId, "phea");
}
{
  // Counted across ALL heroes — two heroes with a scroll each is one wasted slot.
  const a = belt(hero(), "stwp");
  const b = hero();
  check("a second hero does not buy the scroll the first is carrying",
    shopped([a, b, MERCHANT], PLUS_INSANE).buy?.itemId, "phea");
}
{
  const h = hero();
  check("a sold-out shelf is skipped", shopped([h, MERCHANT], PLUS_INSANE, { soldOut: ["stwp"] }).buy?.itemId, "phea");
}
{
  // A RACE shop's tech gate: an Arcane Vault's Town Portal wants a Keep. A neutral shelf has none.
  const h = hero();
  check("a race shop's unmet requirement is skipped",
    shopped([h, MERCHANT], PLUS_INSANE, { needsTech: ["stwp"] }).buy?.itemId, "phea");
}
{
  // The purse is gold ABOVE the reserve the build order keeps — see PlusProfile.itemReserve.
  const h = hero();
  check("it will not dip into the build order's gold",
    shopped([h, MERCHANT], PLUS_INSANE, { gold: PLUS_INSANE.itemReserve + 10 }).buy, null);
}
{
  const h = hero();
  const r = shopped([h, MERCHANT], PLUS_INSANE, { inRange: false });
  check("out of range it walks to the shop instead", !!r.move && !r.buy, true);
}
{
  // …but never out of a fight: the errand only ever starts from the muster point.
  const h = hero();
  const r = shopped([h, MERCHANT], PLUS_INSANE, { inRange: false, mayShop: false });
  check("…and not while there is a wave in the field", !r.move && !r.buy, true);
}
{
  // A full belt has nothing to put anything in.
  const h = belt(hero(), "stwp", "phea", "phea", "shea", "pnvl", "spro");
  check("a full belt stops shopping", shopped([h, MERCHANT], PLUS_INSANE).buy, null);
}
{
  // …and so does the difficulty's own ceiling, well before the belt is full.
  const h = belt(hero(), "phea", "phea", "shea");
  check("Normal stops at its own three slots", shopped([h, MERCHANT], PLUS_NORMAL).buy, null);
}
{
  check("no hero, no shopping", shopped([unit(), MERCHANT], PLUS_INSANE).buy, null);
}

// The errand latch — what stops the army manager dragging a shopping hero back to the muster
// point between trips (the trip is only re-issued every SHOP_PERIOD, so it would arrive at
// neither the shop nor the rally).
{
  const h = hero();
  const orders = [];
  const world = {
    units: new Map([[h.id, h], [MERCHANT.id, MERCHANT]]),
    itemReadyError: () => null, itemUseError: () => null,
    shopReaches: () => false, shopStock: () => -1, missingForShop: () => [],
    isShopUnit: (id) => id === MERCHANT.id,
  };
  const mk = () => new PlusItems({
    world, player: 0, def: (id) => ABILS[id], hostile: (u) => u.owner !== 0 && u.owner !== 12,
    order: (cmd) => { orders.push(cmd); return true; }, item: (id) => ITEMS[id],
    wares: () => ["stwp", "phea"], gold: () => 5000,
  }, PLUS_INSANE);

  const walking = mk();
  walking.pass(500, { home: { x: 0, y: 0 }, losing: false, mayShop: true });
  check("a hero sent to a shop is flagged as on an errand", walking.errand, h.id);

  // …and the flag is dropped the instant the army has somewhere to be, so a wave never leaves
  // a hero permanently exempt from its own rally.
  walking.pass(600, { home: { x: 0, y: 0 }, losing: false, mayShop: false });
  check("…and released the moment a wave goes out", walking.errand, 0);

  // Arriving releases it too: the purchase is made and the hero belongs to the army again.
  const arriving = mk();
  world.shopReaches = () => true;
  arriving.pass(500, { home: { x: 0, y: 0 }, losing: false, mayShop: true });
  check("…and on arrival, when it buys", arriving.errand, 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
