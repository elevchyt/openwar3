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
const { scoutRing, SCOUT_RING_LEGS, lumberCrew, reliefCount } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
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
// EVERY leg is on OUR side of it — the side the scout reaches first. Anything else is a walk
// round the whole base, which on a map whose main sits on a plateau with one ramp is the
// pathfinder routing the scout straight back through the base it was standing off. (Leg 0 alone
// used to be checked here, and the two beside it swept 63 degrees each way.)
for (let leg = 0; leg < SCOUT_RING_LEGS; leg++) {
  const p = scoutRing(BASE, HOME, leg);
  const toHome = Math.hypot(p.x - HOME.x, p.y - HOME.y);
  const baseToHome = Math.hypot(BASE.x - HOME.x, BASE.y - HOME.y);
  check(`leg ${leg} is on the approach side (nearer home than the base is)`, toHome < baseToHome, true);
}
// …and the other two are genuinely different vantage points, not the same spot again.
{
  const [a, b, c] = [0, 1, 2].map((l) => scoutRing(BASE, HOME, l));
  check("the three stops are three different places",
    Math.hypot(a.x - b.x, a.y - b.y) > 500 && Math.hypot(a.x - c.x, a.y - c.y) > 500, true);
  check("…on the same ring", Math.abs(Math.hypot(b.x - BASE.x, b.y - BASE.y) - Math.hypot(c.x - BASE.x, c.y - BASE.y)) < 1, true);
}

// ==========================================================================================
console.log("\n-- the undead keeps ghouls in the forest -------------------------------------");
// ==========================================================================================
// The reported bug: "undead ai doesn't use the ghouls to gather lumber at all". A Ghoul is not
// `isPeon`, so it is a fighter by every test in the sim, and `recruit` took every one of them
// into the wave the moment it was trained — `captainHeld` then kept `applyHarvest` off it, and
// an undead computer chopped nothing for the whole match. It is the one race whose lumber comes
// out of its army, and undead.ai says so by name (`WG`, the wood ghouls).
//
// The BANK's rule and both its numbers are BLIZZARD'S — undead.ai 205-219, ported at
// `UNDEAD_AI.waveGate` — so what is pinned here is that we took it whole rather than picking a
// constant: the crew shrinks by one per 120 lumber standing in the bank.
check("120 lumber banked releases one of the ten", lumberCrew(120, 30), 9);
check("600 releases five", lumberCrew(600, 30), 5);
// …down to a FLOOR of two, which is ours and not undead.ai's. Taken literally the formula
// reaches zero at 1200 lumber, which is a bank an undead player passes through in the middle of
// every game: every ghoul joined the wave, the wood stopped, the bank drained back down with
// nothing chopping, and the AI never noticed. Two ghouls on the trees is what a player keeps
// back for exactly that reason and it costs the wave almost nothing.
check("…a full bank leaves the FLOOR chopping", lumberCrew(1200, 20), 2);
check("…and however full it gets, still two", lumberCrew(5000, 20), 2);
check("…but never more ghouls than there are", lumberCrew(5000, 1), 1);
check("…and none at all with no ghouls", lumberCrew(5000, 0), 0);
check("a race with no ghoul-shaped fighter reserves nobody", lumberCrew(0, 0), 0);

// THE SECOND CEILING, and it is ours: never more than a THIRD of the ghouls, whatever the bank
// says. The bank's rule alone is a LATE-game rule read onto an opening — a melee undead's first
// ghouls arrive with 150 lumber banked, where it asks for nine choppers and there are five, so
// every ghoul chopped, the hero was the only thing in the squad, and it stood in its own base
// until the bank had grown enough to release a party. That is the reported bug: "its hero seems
// to like to stay in their base for quite a while until going out to creep".
check("an empty bank does NOT put the whole crypt in the forest", lumberCrew(0, 6), 2);
check("…four ghouls: two chop, two fight", lumberCrew(0, 4), 2);
check("…seven: three chop, four fight", lumberCrew(0, 7), 3);
check("…and twelve: four chop, eight fight", lumberCrew(0, 12), 4);
// The LOWER of the two ceilings wins, so the bank still returns the crew to the wave as the wood
// piles up — a third of thirty is ten, and 600 lumber banked is five.
check("the bank still binds when it is the smaller", lumberCrew(600, 30), 5);
// The self-regulating half, which is why the bank's rule is worth taking whole: it can never ask
// for more lumberjacks than there are ghouls, so a two-ghoul opening puts two in the forest and
// leaves the wave to everything else.
check("it never asks for more choppers than exist", lumberCrew(0, 2), 2);
check("…nor when the floor is above the whole crypt", lumberCrew(0, 1), 1);

// ==========================================================================================
console.log("\n-- …and swaps the hurt ones for the rested ones ------------------------------");
// ==========================================================================================
// The developer's own rule: "send hurt ghouls to mine lumber and get some healthy ghouls from
// lumber". It is free healing rather than a rotation for its own sake — a Ghoul regenerates
// 2 hp/s on BLIGHT and nowhere else (UnitBalance `regenType`), and the trees a base chops stand
// on the blight its own Necropolis painted.
//
// Both sides arrive sorted: the ones SERVING worst-off first, the ones RESTING best-off first.
check("a half-dead ghoul is exchanged for a whole one", reliefCount([0.3], [1]), 1);
check("…and two of them for two", reliefCount([0.2, 0.4], [1, 0.95]), 2);
// It stops at the first pair not worth exchanging, which is what keeps it one pass rather than
// a churn: a scratched ghoul is not relieved, and a ghoul is not relieved by another hurt one.
check("a scratched ghoul keeps its place", reliefCount([0.8], [1]), 0);
check("…and nothing is relieved by a body just as hurt", reliefCount([0.2], [0.6]), 0);
check("…the second pair being unworthy ends it, not the first", reliefCount([0.2, 0.8], [1, 1]), 1);
check("nobody in the forest, nobody relieved", reliefCount([0.1, 0.1], []), 0);
check("…and nobody in the wave, nothing to relieve", reliefCount([], [1, 1]), 0);
// THE GAP between the two thresholds is the whole of "it must not go back and forth": the ghoul
// that leaves is under half and the one that arrives is all but whole, so no exchange can be
// undone by the same rule on the next pass.
check("a ghoul is never swapped for one barely better", reliefCount([0.49], [0.51]), 0);

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
check("…and so does Normal, so both replace it", PLUS_NORMAL.keepPortal, true);
check("Easy does not", PLUS_EASY.keepPortal, false);
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
  pman: { id: "pman", gold: 200, usable: true, abilities: ["AIm1"] }, // Potion of Mana
  sreg: { id: "sreg", gold: 100, usable: true, abilities: ["AIsl"] }, // Scroll of Regeneration
  prep: { id: "prep", gold: 100, usable: true, abilities: ["AIp1"] }, // Replenishment Potion
  bspd: { id: "bspd", gold: 250, usable: false, abilities: ["AIms"] }, // Boots of Speed — passive
  will: { id: "will", gold: 150, usable: true, abilities: ["AIil"] }, // Wand of Illusion
  // --- the permanent drops, for the PAWNING pass. What separates them is whether the game adds
  // a second one to the first (`itemBonuses`' own switch, mirrored as `STACKS`).
  clsd: { id: "clsd", gold: 150, usable: false, pawnable: true, charges: 0, abilities: ["Ashm"] }, // Cloak of Shadows
  rat3: { id: "rat3", gold: 100, usable: false, pawnable: true, charges: 0, abilities: ["AIat"] }, // Claws of Attack +3
  qbot: { id: "qbot", gold: 50, usable: false, pawnable: false, charges: 0, abilities: ["Ashm"] }, // a quest item: not pawnable
};
// The ability rows: the `target` that is the whole of how an item is AIMED (items.ts `aim`), the
// base `code` that decides what pressing it is FOR (items.ts `USE_OF`), and — for the one code
// that is four different items — the columns that tell them apart (items.ts `regenUse`).
//
// **`alias` and `code` are DIFFERENT, and this stub used to pretend they were not.** Every row
// below is `AbilityData.slk`'s own pair, and the reason to spell them out is the bug this file
// failed to catch: `USE_OF` was keyed on the aliases, `useOf` looks a card up by `code`, and a
// stub that set `code` to the alias made all of it agree with itself while the real game could
// press none of it. An AI that had bought a Potion of Healing, a Potion of Mana, a Healing Salve
// and a Clarity Potion could use no single one of the four.
const lvl = (o = {}) => ({ area: 0, castRange: 0, duration: 0, data: [NaN, NaN], ...o });
const ABILS = {
  // alias   code            what the row carries
  AItp: { code: "AItp", target: "point", levelData: [lvl({ area: 1100, castTime: 5 })] },
  AIh1: { code: "AIhe", target: "", levelData: [lvl({ castRange: 100, data: [250, NaN] })] },
  AIm1: { code: "AIma", target: "", levelData: [lvl({ castRange: 100, data: [150, NaN] })] },
  AIvl: { code: "AIvu", target: "", levelData: [lvl({ duration: 7 })] },
  AIha: { code: "AIha", target: "", levelData: [lvl({ area: 600, data: [250, NaN] })] },
  // The `AIrg` family — one code, four answers, each read off its own row.
  AIrl: { code: "AIrg", target: "unit", levelData: [lvl({ castRange: 500, duration: 45, data: [400, 0] })] },
  AIsl: { code: "AIrg", target: "", levelData: [lvl({ area: 600, duration: 45, data: [225, 0] })] },
  AIpr: { code: "AIrg", target: "", levelData: [lvl({ duration: 45, data: [0, 200] })] },
  AIp1: { code: "AIrg", target: "", levelData: [lvl({ duration: 30, data: [100, 25] })] },
  AIda: { code: "AIda", target: "", levelData: [lvl()] },
  // `[AIil] targs1` = "ground,air,friend,self", `Rng1` = 500, `Dur1` = 60, and DataA "Damage
  // Dealt (%)" is EMPTY — the 0 that makes the copy harmless (docs/illusions.md).
  AIil: { code: "AIil", target: "unit", levelData: [lvl({ castRange: 500, duration: 60, data: [0, 2] })] },
  AIms: { code: "AIms", target: "", levelData: [lvl()] },
  // Shadow Meld — a granted ABILITY. A hero carrying two of them melds exactly as well as one
  // carrying one, which is the whole of why the second is worth pawning.
  Ashm: { code: "Ashm", target: "", levelData: [lvl()] },
  // …and Claws of Attack, which IS in `itemBonuses`' switch: two of them are +6 damage.
  AIat: { code: "AIat", target: "", levelData: [lvl({ data: [3, NaN] })] },
};

let nextId = 1;
const unit = (o = {}) => ({
  id: nextId++, owner: 0, x: 0, y: 0, radius: 16, hp: 1000, maxHp: 1000, mana: 100, maxMana: 100,
  isHero: false, isPeon: false, building: null, paused: false, stunned: false, isIllusion: false,
  morphT: 0, spawning: 0, level: 1, typeId: "hfoo", inventory: [], buffs: [], ...o,
});
/** A unit already pouring a regeneration item — `applyItemAbility`'s `AIrg` branch hangs this
 *  buff (group `item:regen`) for the row's own `Dur1`. A second charge on it is thrown away,
 *  which is what `PlusItems.regenerating` is for. */
const regenBuff = () => ({ kind: "hot", group: "item:regen", timeLeft: 40, buffId: "BIrl" });
const hero = (o = {}) => unit({ isHero: true, typeId: "Hamg", inventory: [null, null, null, null, null, null], ...o });
const belt = (h, ...ids) => { ids.forEach((id, i) => { h.inventory[i] = { itemId: id, charges: 1 }; }); return h; };

/** Drive one pass and report the `useitem` command it produced, if any. */
function pressed(units, profile, ctx, opts = {}) {
  const orders = [];
  const world = {
    units: new Map(units.map((u) => [u.id, u])),
    // Ground items — what the `loot` pass walks. Empty unless a case puts something on the
    // grass, since every case here is about which BUTTON is pressed rather than what is picked
    // up (see tools/ai-plus-army-test.cjs for the pricing side of the belt).
    items: new Map((opts.ground ?? []).map((it) => [it.id, it])),
    itemReadyError: () => opts.notReady ?? null,
    itemUseError: () => opts.badTarget ?? null,
    shopReaches: () => false,
    shopStock: () => -1,
    missingForShop: () => [],
    isShopUnit: () => false,
    canPawnAt: () => false,
  };
  const items = new PlusItems({
    world, player: 0,
    def: (id) => ABILS[id],
    hostile: (u) => u.owner !== 0,
    order: (cmd) => { orders.push(cmd); return true; },
    item: (id) => ITEMS[id],
    wares: () => [],
    gold: () => opts.gold ?? 0,
  }, profile, opts.race ?? "human");
  items.pass(opts.now ?? 100, ctx);
  return orders.find((c) => c.c === "useitem") ?? null;
}

const CTX = { home: { x: 0, y: 0 }, losing: false, mayShop: false, portalWorthIt: true };
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
  const h = belt(hero({ hp: 200, x: 4000, y: 4000 }), "phea", "pnvl", "stwp");
  const cmd = pressed([h, enemy({ x: 4200, y: 4000 })], PLUS_INSANE, { ...AWAY, losing: true });
  check("a lost fight: it scrolls out before it drinks anything", itemOf(cmd), 2);
  // THE DOUBLE-CLICK. `itemTownPortal` resolves nearestHall(owner, x, y), so aiming at the hero
  // itself IS "the user's nearest hall" — which is what double-clicking the scroll does in the
  // real game, and the only aim that cannot go out of date while the hero runs.
  check("…aimed at the hero itself, which is the double-click", cmd && cmd.x === 4000 && cmd.y === 4000, true);
  check("…and with no target unit", cmd && cmd.targetId, 0);
}
{
  // …BUT NOT TO LEAVE A CREEP CAMP. `portalWorthIt` is the army manager's answer to "what are
  // we running from" (plus/index.ts `retreatFrom`): creeps do not chase, do not follow you
  // home, and will still be standing there in two minutes, so a scroll spent to leave one buys
  // a few seconds of walking and is then not in the belt for the fight that decides the game.
  // A HEALTHY hero on a lost creep run walks.
  const h = belt(hero({ hp: 900, x: 4000, y: 4000 }), "phea", "pnvl", "stwp");
  const vsCreeps = { ...AWAY, losing: true, portalWorthIt: false };
  check("a lost CREEP fight: the healthy hero walks home rather than scrolling",
    pressed([h, enemy({ x: 4200, y: 4000 })], PLUS_INSANE, vsCreeps), null);
  // …and the hero's OWN skin is still unconditional: a hero about to die is a hero about to
  // die, and a creep camp is not a reason to lose one.
  const dying = belt(hero({ hp: 200, x: 4000, y: 4000 }), "phea", "pnvl", "stwp");
  check("…but a DYING hero scrolls out of a creep camp all the same",
    itemOf(pressed([dying, enemy({ x: 4200, y: 4000 })], PLUS_INSANE, vsCreeps)), 2);
}
{
  // THE HERO'S OWN SKIN, not just the army's. A hero about to die in a fight the army has not
  // given up on still leaves — this is the same conclusion reached about a smaller group.
  const h = belt(hero({ hp: 200 }), "stwp");
  check("a hero about to die scrolls out even when the army is not retreating",
    itemOf(pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY)), 0);
}
{
  // THE THRESHOLD, which is the reported bug: a hero that waits for PANIC_HP (0.3) to reach for
  // a FIVE-SECOND scroll dies holding it. 0.39 is above the panic line and below ESCAPE_HP.
  const h = belt(hero({ hp: 390 }), "stwp", "phea");
  check("it leaves at 39% — above the panic line, where the old rule kept fighting",
    itemOf(pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY)), 0);
}
{
  // …and not at half health, which is a fight, not a rout.
  const h = belt(hero({ hp: 500 }), "stwp");
  check("…and not at 50%", pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}
{
  // …but a healthy hero in a fight the army is winning stays and fights.
  const h = belt(hero({ hp: 950 }), "stwp");
  check("…and a healthy one does not", pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
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
  // Three hurt soldiers around a healthy hero, and the camp already dead: this is what the
  // scroll is for, and WHEN it is for it.
  const h = belt(hero(), "shea", "phea");
  const hurt = [1, 2, 3].map((i) => unit({ hp: 300, maxHp: 1000, x: 100 * i }));
  check("three hurt soldiers: it reads the area heal", itemOf(pressed([h, ...hurt], PLUS_INSANE, AWAY)), 0);
}
{
  // …AND NOT WHILE THE BLOWS ARE STILL LANDING. `AIrg` is a 45-second HOT and the sim cancels it
  // the moment its bearer is hit (ITEM_REGEN_GROUP), so a scroll poured into a live fight — a
  // creep camp included, which is the reported case — is 100 gold spent on the next blow.
  const h = belt(hero(), "shea", "phea");
  const hurt = [1, 2, 3].map((i) => unit({ hp: 300, maxHp: 1000, x: 100 * i }));
  check("…and never with something still swinging at the party",
    pressed([h, ...hurt, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}

{
  // One hurt soldier is a potion's job, not a scroll's — and the hero itself is fine.
  const h = belt(hero(), "shea");
  check("…one hurt soldier is not worth a charge",
    pressed([h, unit({ hp: 300, maxHp: 1000, x: 100 }), enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}
{
  // MORE THAN HALF THE ARMY HAS TO BE IN THE CIRCLE. The developer's own rule for the human's
  // Scroll of Regeneration: "it must make sure that their hero uses it while close to its army
  // so that more than half the army is in range". Three hurt soldiers beside the hero and five
  // more of the army a screen away is a 100-gold scroll poured over three units.
  const h = belt(hero(), "sreg");
  const hurt = [1, 2, 3].map((i) => unit({ hp: 300, maxHp: 1000, x: 100 * i }));
  const rest = [1, 2, 3, 4, 5].map((i) => unit({ hp: 300, maxHp: 1000, x: 3000 + 100 * i }));
  check("half the army out of the circle: the scroll is held",
    pressed([h, ...hurt, ...rest], PLUS_INSANE, AWAY), null);
  // …and once the army is around the hero, the same party is worth it.
  const near = [1, 2, 3, 4, 5].map((i) => unit({ hp: 300, maxHp: 1000, x: 100 * i }));
  check("…and poured the moment they are all standing in it",
    itemOf(pressed([belt(hero(), "sreg"), ...hurt, ...near], PLUS_INSANE, AWAY)), 0);
}
{
  // THE CIRCLE IS THE ITEM'S OWN. `[AIsl] Area1` is 600; a rule written against the 900 the
  // rest of this file calls "the fight" would promise to heal units it cannot reach.
  const h = belt(hero(), "sreg");
  const hurt = [1, 2, 3].map((i) => unit({ hp: 300, maxHp: 1000, x: 700 + i }));
  check("soldiers outside Area1 but inside LOOK do not count",
    pressed([h, ...hurt], PLUS_INSANE, AWAY), null);
}
{
  // TOTAL ARMY HEALTH, pooled — "it should base its usage around total army health". Three
  // soldiers with a scratch each is not an army that needs a scroll, however many of them there
  // are, which is a different answer from the head-count this used to be.
  const h = belt(hero(), "sreg");
  const scratched = [1, 2, 3].map((i) => unit({ hp: 900, maxHp: 1000, x: 100 * i }));
  check("a party at nine tenths keeps its scroll",
    pressed([h, ...scratched], PLUS_INSANE, AWAY), null);
  // …and three nearly dead among three whole ones is the case a head-count misses: only three
  // of the six are under `HURT_HP`, but POOLED (the hero's own bar included, since the circle
  // heals the hero too) the party is under two thirds and the scroll is worth its charge.
  const mixed = [
    unit({ hp: 150, maxHp: 1000, x: 100 }), unit({ hp: 150, maxHp: 1000, x: 200 }),
    unit({ hp: 150, maxHp: 1000, x: 300 }),
    unit({ hp: 1000, maxHp: 1000, x: 400 }), unit({ hp: 1000, maxHp: 1000, x: 500 }),
    unit({ hp: 1000, maxHp: 1000, x: 100, y: 100 }),
  ];
  check("…three nearly dead among the whole ones is worth it",
    itemOf(pressed([belt(hero(), "sreg"), ...mixed], PLUS_INSANE, AWAY)), 0);
}
{
  // NOT ON SOMEBODY ALREADY POURING. A regeneration item is a 45-second HOT in one buff group,
  // so a second charge REPLACES the first rather than stacking — and without this guard the
  // whole belt goes into one camp: a Blademaster with two Healing Salves (six charges) emptied
  // both in fifteen seconds, because the unit it kept picking was still the most hurt one there.
  const h = belt(hero(), "hslv");
  const pouring = unit({ hp: 200, maxHp: 1000, x: 150, buffs: [regenBuff()] });
  check("the Salve is held back from a unit already regenerating",
    pressed([h, pouring], PLUS_INSANE, AWAY), null);
  // …and goes to the next worst one that is not.
  const other = unit({ hp: 400, maxHp: 1000, x: 200 });
  const cmd = pressed([belt(hero(), "hslv"), pouring, other], PLUS_INSANE, AWAY);
  check("…and goes to the next one that is not", cmd && cmd.targetId, other.id);
}
{
  // The same for the AREA heal: a party already pouring is not a party the circle still covers,
  // so a second scroll cannot follow the first over the same units a second later.
  const h = belt(hero(), "sreg");
  const hurt = [1, 2, 3].map((i) => unit({ hp: 300, maxHp: 1000, x: 100 * i, buffs: [regenBuff()] }));
  check("no second scroll over a party that is already regenerating",
    pressed([h, ...hurt], PLUS_INSANE, AWAY), null);
}
{
  // The Healing Salve is the one healing item you point at somebody.
  const h = belt(hero(), "hslv");
  const wounded = unit({ hp: 200, maxHp: 1000, x: 150 });
  const cmd = pressed([h, wounded], PLUS_INSANE, AWAY);
  check("the Healing Salve goes on the hurt soldier", itemOf(cmd), 0);
  check("…aimed at that unit", cmd && cmd.targetId, wounded.id);
  // …and is held for as long as anything is swinging, for the same reason the scroll is: the
  // orc's opening buy is the developer's own example ("avoid using healing salve during fights
  // and fighting with creeps"), because a salve poured into damage is a salve cancelled.
  check("…and never during the fight",
    pressed([belt(hero(), "hslv"), wounded, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}
{
  // THE BODY IS ASKED, NOT ONLY THE PRESSER. A hero can be a screen from the fight its own army
  // is standing in. `near` is hull-to-hull (16 + 16 here), so an enemy 1600 out is 1568 from the
  // hero — well outside its own `LOOK` of 900, so the hero is not "engaged" — and 768 from the
  // soldier at 800, which is inside it.
  const far = unit({ hp: 200, maxHp: 1000, x: 800 });
  check("…nor onto a body that is itself under fire",
    pressed([belt(hero(), "hslv"), far, enemy({ x: 1600 })], PLUS_INSANE, AWAY), null);
  // …and the same soldier, with the fight over, gets it.
  check("…and gets it once nothing is swinging",
    itemOf(pressed([belt(hero(), "hslv"), unit({ hp: 200, maxHp: 1000, x: 800 })], PLUS_INSANE, AWAY)), 0);
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

// --- the alias/code trap: everything it BUYS, it can press ---------------------------------------
// The reported bug in one line: "orc is not able to use healing salves (it buys them though)".
// It was not the salve — `USE_OF` was keyed on ALIASES and `useOf` looks a card up by `code`, so
// most of the shopping list was unreachable. One case per shop row, so a future re-key of the
// table cannot quietly take one of them out again.
{
  const h = belt(hero(), "hslv");
  const wounded = unit({ hp: 200, maxHp: 1000, x: 150 });
  const cmd = pressed([h, wounded], PLUS_INSANE, AWAY);
  check("the Healing Salve (AIrl → AIrg, Rng1) reaches a hurt soldier", itemOf(cmd), 0);
  check("…aimed at that unit", cmd && cmd.targetId, wounded.id);
}
{
  // …and out of a FIGHT, which is where a 45-second pour is actually worth spending — the job
  // the shopping list says it bought them for ("between creep camps").
  const h = belt(hero(), "hslv");
  const wounded = unit({ hp: 200, maxHp: 1000, x: 150 });
  check("…with nothing attacking, which is when a 45s pour is worth it",
    itemOf(pressed([h, wounded], PLUS_INSANE, AWAY)), 0);
}
{
  const h = belt(hero(), "sreg");
  const hurt = [1, 2, 3].map((i) => unit({ hp: 300, maxHp: 1000, x: 100 * i }));
  const cmd = pressed([h, ...hurt], PLUS_INSANE, AWAY);
  check("the Scroll of Regeneration (AIsl → AIrg, Area1 600) reads as an AREA heal", itemOf(cmd), 0);
  check("…fired on the hero, not pointed at anybody", cmd && cmd.targetId, 0);
}
{
  const h = belt(hero({ mana: 10, maxMana: 100 }), "pman");
  check("the Potion of Mana (AIm1 → AIma) is drunk", itemOf(pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY)), 0);
}
{
  const h = belt(hero({ hp: 400 }), "prep");
  check("a Replenishment Potion (AIp1 → AIrg, no area, no range) is a heal on the drinker",
    itemOf(pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY)), 0);
}
{
  // The other half of `regenUse`: the same code, mana only, must NOT read as a heal — a mana
  // item pressed as a heal is pressed at the wrong moment.
  const h = belt(hero({ hp: 400, mana: 100, maxMana: 100 }), "pclr");
  check("…and a Clarity Potion (same code, mana only) is not drunk by a hurt, full-mana hero",
    pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
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
console.log("\n-- the Wand of Illusion ------------------------------------------------------");
// ==========================================================================================

// What a double is FOR: it fights, it is swung at, and it deals no damage at all (`[AIil] DataA`
// = 0). So the whole of its value is soaking blows that would otherwise land on the party — in a
// fight, and, when the army manager asks for it, a few seconds BEFORE an orange or red creep
// camp so the copies walk in first (plus/index.ts `vanguardPass`).
const bigUn = (o = {}) => unit({ typeId: "otau", maxHp: 1300, hp: 1300, ...o });

{
  const h = belt(hero(), "will");
  const cmd = pressed([h, enemy({ x: 200 }), enemy({ x: 250 }), enemy({ x: 300 })], PLUS_INSANE, AWAY);
  check("a hero in a real fight waves its wand", itemOf(cmd), 0);
}
{
  // ONE scout walking past is not a fight, and the wand has three charges for the whole match.
  const h = belt(hero(), "will");
  check("…but not at a single enemy", pressed([h, enemy({ x: 200 })], PLUS_INSANE, AWAY), null);
}
{
  // WHO IT COPIES: the biggest body in reach, because the copy arrives at FULL hit points and
  // its only job is to stand there. A Tauren's double outlasts a hero's, so this is deliberately
  // not "always the caster".
  const h = belt(hero({ maxHp: 900, hp: 900 }), "will");
  const tauren = bigUn({ x: 100 });
  const cmd = pressed([h, tauren, enemy({ x: 200 }), enemy({ x: 250 }), enemy({ x: 300 })], PLUS_INSANE, AWAY);
  check("…copying the biggest body in the party, not the hero", cmd && cmd.targetId, tauren.id);
}
{
  // …and NOT one of its own copies. A copy of a copy is the same body at a further remove, and
  // it stops being the biggest thing in the party the moment anything hits it.
  const h = belt(hero({ maxHp: 900, hp: 900 }), "will");
  const ghost = bigUn({ x: 100, maxHp: 5000, hp: 5000, isIllusion: true });
  const cmd = pressed([h, ghost, enemy({ x: 200 }), enemy({ x: 250 }), enemy({ x: 300 })], PLUS_INSANE, AWAY);
  check("…never a double of a double", cmd && cmd.targetId, h.id);
}
{
  // The wand reaches 500 (`[AIil] Rng1`), so a body across the map is not a body it can copy.
  const h = belt(hero({ maxHp: 900, hp: 900 }), "will");
  const far = bigUn({ x: 4000 });
  const cmd = pressed([h, far, enemy({ x: 200 }), enemy({ x: 250 }), enemy({ x: 300 })], PLUS_INSANE, AWAY);
  check("…and only one inside the wand's own 500 range", cmd && cmd.targetId, h.id);
}
{
  // THE CAP. Three charges, `Cool1` = 0: nothing in the data stops a hero emptying the wand into
  // the first skirmish of the match. `ILLUSION_CAP` is what does, and it is stated in doubles
  // ALIVE — so the third charge is only ever spent once one of them has popped.
  const h = belt(hero(), "will");
  const foes = [enemy({ x: 200 }), enemy({ x: 250 }), enemy({ x: 300 })];
  const two = [unit({ x: 40, isIllusion: true }), unit({ x: 60, isIllusion: true })];
  check("two doubles already standing is enough", pressed([h, ...two, ...foes], PLUS_INSANE, AWAY), null);
  check("…one is not", itemOf(pressed([h, two[0], ...foes], PLUS_INSANE, AWAY)), 0);
}
{
  // THE LADDER. A hero that is about to die leaves; it does not stop to conjure scenery.
  const h = belt(hero({ hp: 200, x: 4000, y: 4000 }), "will", "stwp");
  const foes = [enemy({ x: 4200, y: 4000 }), enemy({ x: 4250, y: 4000 }), enemy({ x: 4300, y: 4000 })];
  check("the Town Portal still outranks the wand", itemOf(pressed([h, ...foes], PLUS_INSANE, AWAY)), 1);
}

// --- the vanguard: the press the ARMY MANAGER makes, before a camp --------------------------
/** A `PlusItems` over these units, plus the orders it produced — `makeIllusions` is called by
 *  plus/index.ts rather than by the belt's own pass, so it needs the object and not just a
 *  press. */
function wand(units, profile = PLUS_INSANE) {
  const orders = [];
  const world = {
    units: new Map(units.map((u) => [u.id, u])),
    items: new Map(),
    itemReadyError: () => null, itemUseError: () => null,
    shopReaches: () => false, shopStock: () => -1, missingForShop: () => [], isShopUnit: () => false,
    canPawnAt: () => false,
  };
  const items = new PlusItems({
    world, player: 0, def: (id) => ABILS[id], hostile: (u) => u.owner !== 0,
    order: (cmd) => { orders.push(cmd); return true; }, item: (id) => ITEMS[id],
    wares: () => [], gold: () => 0,
  }, profile, "human");
  return { items, orders };
}
{
  // A vanguard has to set off TOGETHER — doubles dribbled out a press per pass arrive a second
  // apart and are killed in ones — and the data allows it: `Cool1` is 0, so the second charge is
  // legal the instant the first is spent. The copies do not exist yet when the next press is
  // decided (spawning is asynchronous), so the loop counts its own presses.
  const h = belt(hero(), "will");
  const { items, orders } = wand([h]);
  check("the manager's press throws the whole vanguard at once", items.makeIllusions(h), 2);
  check("…as two useitem commands", orders.filter((c) => c.c === "useitem").length, 2);
}
{
  // …and it obeys the same cap the ladder does: one double already out, one more thrown.
  const h = belt(hero(), "will");
  const { items } = wand([h, unit({ x: 40, isIllusion: true })]);
  check("…counting what is already standing", items.makeIllusions(h), 1);
}
{
  const h = belt(hero(), "phea"); // no wand
  check("a hero with no wand throws nothing", wand([h]).items.makeIllusions(h), 0);
}
{
  const h = belt(hero({ stunned: true }), "will");
  check("…and neither does a stunned one", wand([h]).items.makeIllusions(h), 0);
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
    items: new Map((opts.ground ?? []).map((it) => [it.id, it])), // ground drops — see `pressed`
    itemReadyError: () => null,
    itemUseError: () => null,
    shopReaches: () => opts.inRange ?? true,
    // -1 is "not stock-limited"; 0 is "sold out" — the sim's own distinction.
    shopStock: (_id, ware) => (opts.soldOut?.includes(ware) ? 0 : -1),
    missingForShop: (_id, ware) => (opts.needsTech?.includes(ware) ? ["TWN2"] : []),
    // Every building in the fixture is a shop; which one gets the sale is the ordering rule.
    isShopUnit: () => true,
    canPawnAt: () => false, // the pawning trip has its own fixture below
  };
  const items = new PlusItems({
    world, player: 0,
    def: (id) => ABILS[id],
    hostile: (u) => u.owner !== 0 && u.owner !== 12, // a Goblin Merchant is Neutral Passive
    order: (cmd) => { orders.push(cmd); return true; },
    item: (id) => ITEMS[id],
    wares: () => shelf,
    gold: () => opts.gold ?? 5000,
    // WHOSE list this is: `RACE_FIRST` gives the orc two Healing Salves before anything else,
    // and every other race shops off `LIST` alone.
  }, profile, opts.race ?? "human");
  items.pass(opts.now ?? 500, { home: { x: 0, y: 0 }, losing: false, mayShop: opts.mayShop ?? true, portalWorthIt: true });
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
  // Normal keeps one too, so the scroll leads for it as well.
  check("Normal buys the Town Portal first", shopped([h, MERCHANT], PLUS_NORMAL).buy?.itemId, "stwp");
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
  // …and so does the difficulty's own ceiling, well before the belt is full — while the gold
  // is ordinary. `shopping` is a HABIT ("how much of a belt will this player bother to fill"),
  // so it is measured against everything the hero is holding, drops included.
  const h = belt(hero(), "phea", "phea", "shea");
  const purse = PLUS_NORMAL.itemReserve + 200; // spare, but not SURPLUS spare
  check("Normal stops at its own three slots", shopped([h, MERCHANT], PLUS_NORMAL, { gold: purse }).buy, null);
}
{
  // …but not when the build order has visibly failed to spend the gold. A player sitting on a
  // banked purse fills the belt whatever is already in it — see items.ts `RICH` / `SURPLUS`.
  const h = belt(hero(), "phea", "phea", "shea");
  check("…but a rich Normal fills the belt anyway", !!shopped([h, MERCHANT], PLUS_NORMAL, { gold: 5000 }).buy, true);
}
{
  // The Goblin Merchant's own shelf, and the one PERMANENT thing on the list. With the
  // consumables above it satisfied, Boots of Speed is what the ladder reaches next.
  const h = belt(hero(), "stwp", "phea", "phea", "shea", "pnvl");
  check("boots of speed are bought off the Merchant", shopped([h, MERCHANT], PLUS_INSANE).buy?.itemId, "bspd");
}
{
  // THE UNDEAD'S MANA. The Tomb of Relics' shelf, with the core list already satisfied off it —
  // so what is left to buy is only what the SURPLUS rows want. `RACE_SURPLUS` leads them, so a
  // banked undead computer keeps buying Potions of Mana. Reported: "undead is a very
  // mana-hungry race".
  const shelf = ["stwp", "phea", "pman"]; // [utom] Makeitems, less what this fixture has no row for
  const h = belt(hero(), "stwp", "phea", "phea", "pman");
  check("a rich undead keeps buying mana",
    shopped([h, MERCHANT], PLUS_INSANE, { race: "undead", shelf, gold: 5000 }).buy?.itemId, "pman");
  // …and only when it IS rich: an ordinary purse stops at the core list, which wanted one.
  const lean = PLUS_INSANE.itemReserve + 300;
  check("…and stops at one on an ordinary purse",
    shopped([h, MERCHANT], PLUS_INSANE, { race: "undead", shelf, gold: lean }).buy, null);
}
{
  check("no hero, no shopping", shopped([unit(), MERCHANT], PLUS_INSANE).buy, null);
}

// THE ARMY'S HEALING. A creeping computer's problem is hit points, not mana, so the cheap area
// heals sit above the mana potions — 100 gold for three Salve charges is the best hit points
// per gold in the game, and it is what puts a party back together between camps. Reported:
// "it crept its hero nicely up to level 3 … however it didn't buy healing salves".
{
  // Asked of a race with no opening habit of its own (`RACE_FIRST`), so what is being pinned is
  // the general `LIST`'s order rather than the orc's or the human's first buys.
  const h = belt(hero(), "stwp", "phea", "phea", "shea", "sreg");
  const shelf = ["stwp", "phea", "shea", "sreg", "hslv", "pman", "pclr"];
  check("with the portal and the potions bought, the Salve is next — before any mana",
    shopped([h, MERCHANT], PLUS_INSANE, { race: "undead", shelf }).buy?.itemId, "hslv");
}

// THE ORC BUYS ITS SALVES FIRST (`RACE_FIRST`). Reported: an orc Computer+ "must buy two
// healing salves on its hero from its shop as soon as possible". The Voodoo Lounge `[ovln]` is
// the one race shop that stocks `hslv`, and the reason the AI never had one is arithmetic
// rather than preference: the general list opens with a Town Portal and two Potions of Healing,
// and Normal's belt is only three slots deep — so the Salve two rows further down was never
// once reached. It is a `healOther` (Rng1 500, no Area1), which is why it is the ORC's first
// buy and not merely a cheap potion: it is the item that heals the ARMY between creep camps.
{
  const LOUNGE = ["shas", "hslv", "plcl", "phea", "pman", "stwp", "tgrh", "oli2"]; // [ovln] Makeitems
  const h = hero();
  check("an orc's first buy is a Healing Salve, ahead of the Town Portal",
    shopped([h, MERCHANT], PLUS_NORMAL, { race: "orc", shelf: LOUNGE }).buy?.itemId, "hslv");
  // TWO of them — one is spent on the first camp.
  const one = belt(hero(), "hslv");
  check("…and a second one after that",
    shopped([one, MERCHANT], PLUS_NORMAL, { race: "orc", shelf: LOUNGE }).buy?.itemId, "hslv");
  // …and then the habit the general list describes resumes, scroll first.
  const two = belt(hero(), "hslv", "hslv");
  check("…and only then the Town Portal",
    shopped([two, MERCHANT], PLUS_NORMAL, { race: "orc", shelf: LOUNGE }).buy?.itemId, "stwp");
}
{
  // THE HUMAN OPENS WITH ITS SCROLL OF REGENERATION, for the same reason and off the same kind
  // of row: `[hvlt] Makeitems` opens with `sreg`, it is 100 gold, and `[AIsl] Area1` 600 makes
  // it the ARMY's heal rather than the hero's.
  const VAULT = ["sreg", "mcri", "plcl", "phea", "pman", "stwp", "tsct", "ofir", "ssan"]; // [hvlt]
  const h = hero();
  check("a human's first buy is a Scroll of Regeneration, ahead of the Town Portal",
    shopped([h, MERCHANT], PLUS_NORMAL, { race: "human", shelf: VAULT }).buy?.itemId, "sreg");
  const two = belt(hero(), "sreg", "sreg");
  check("…and only then the Town Portal",
    shopped([two, MERCHANT], PLUS_NORMAL, { race: "human", shelf: VAULT }).buy?.itemId, "stwp");
}
{
  // THE OPENING BUY IS NOT DISCRETIONARY SPENDING. Everything on the general list waits for
  // gold above `itemReserve`; the race's own first buys do not, because a Normal computer's
  // gold is almost never 300 above anything (measured: an orc's purse sat between 2 and 162 for
  // a whole match) and a 100-gold salve it can never reach is a Voodoo Lounge built for nothing.
  const LOUNGE = ["shas", "hslv", "plcl", "phea", "pman", "stwp", "tgrh", "oli2"]; // [ovln]
  check("120 gold buys the opening salve, reserve or no reserve",
    shopped([hero(), MERCHANT], PLUS_NORMAL, { race: "orc", shelf: LOUNGE, gold: 120 }).buy?.itemId, "hslv");
  // …and the rest of the list still waits for the surplus, which is what the reserve is for.
  const stocked = belt(hero(), "hslv", "hslv");
  check("…but the general list still waits above the reserve",
    shopped([stocked, MERCHANT], PLUS_NORMAL, { race: "orc", shelf: LOUNGE, gold: PLUS_NORMAL.itemReserve + 10 }).buy, null);
}
{
  // Nobody else gets the habit: an undead off the same shelf still opens with the scroll.
  const h = hero();
  const shelf = ["stwp", "phea", "hslv", "sreg"];
  check("an undead's list is unchanged — the Town Portal still leads",
    shopped([h, MERCHANT], PLUS_NORMAL, { race: "undead", shelf }).buy?.itemId, "stwp");
}

// OUR OWN SHOP FIRST, the Goblin Merchant as the last resort. A race shop is in the base (so
// the errand is seconds, not a trek) and its shelf cannot be emptied by the other player.
{
  const h = hero();
  // An Arcane Vault of ours, further from home than the Merchant, and it still wins.
  const vault = unit({ owner: 0, typeId: "hvlt", x: 900, y: 0, building: { constructionLeft: 0, stock: null } });
  const near = unit({ owner: 12, typeId: "ngme", x: 100, y: 0, building: { constructionLeft: 0, stock: null } });
  const r = shopped([h, vault, near], PLUS_INSANE);
  check("it replaces the Town Portal at its OWN shop", r.buy && r.buy.shopId, vault.id);
}
{
  // …and falls back to the Merchant when we have no shop of our own.
  const h = hero();
  const r = shopped([h, MERCHANT], PLUS_INSANE);
  check("…and at the Goblin Merchant when there is no shop of ours", r.buy && r.buy.shopId, MERCHANT.id);
}
{
  // REPLACEMENT. Both top difficulties keep a scroll, so the moment one is spent the next trip
  // buys another before it buys anything else.
  for (const [name, p] of [["Normal", PLUS_NORMAL], ["Insane", PLUS_INSANE]]) {
    check(`${name} keeps a Town Portal and replaces it first`, p.keepPortal, true);
    const spent = hero(); // the scroll is gone; the belt has room
    check(`…${name} buys the replacement before anything else`,
      shopped([spent, MERCHANT], p).buy?.itemId, "stwp");
  }
}

// The errand latch — what stops the army manager dragging a shopping hero back to the muster
// point between trips (the trip is only re-issued every SHOP_PERIOD, so it would arrive at
// neither the shop nor the rally).
{
  const h = hero();
  const orders = [];
  const world = {
    units: new Map([[h.id, h], [MERCHANT.id, MERCHANT]]),
    items: new Map(), // no drops on the grass — see `pressed`
    itemReadyError: () => null, itemUseError: () => null,
    shopReaches: () => false, shopStock: () => -1, missingForShop: () => [],
    isShopUnit: (id) => id === MERCHANT.id,
    canPawnAt: () => false,
  };
  const mk = () => new PlusItems({
    world, player: 0, def: (id) => ABILS[id], hostile: (u) => u.owner !== 0 && u.owner !== 12,
    order: (cmd) => { orders.push(cmd); return true; }, item: (id) => ITEMS[id],
    wares: () => ["stwp", "phea"], gold: () => 5000,
  }, PLUS_INSANE, "human");

  const walking = mk();
  walking.pass(500, { home: { x: 0, y: 0 }, losing: false, mayShop: true, portalWorthIt: true });
  check("a hero sent to a shop is flagged as on an errand", walking.errand, h.id);

  // …and the flag is dropped the instant the army has somewhere to be, so a wave never leaves
  // a hero permanently exempt from its own rally.
  walking.pass(600, { home: { x: 0, y: 0 }, losing: false, mayShop: false, portalWorthIt: true });
  check("…and released the moment a wave goes out", walking.errand, 0);

  // Arriving releases it too: the purchase is made and the hero belongs to the army again.
  const arriving = mk();
  world.shopReaches = () => true;
  arriving.pass(500, { home: { x: 0, y: 0 }, losing: false, mayShop: true, portalWorthIt: true });
  check("…and on arrival, when it buys", arriving.errand, 0);
}

// ==========================================================================================
console.log("\n-- somewhere to shop ---------------------------------------------------------");
// ==========================================================================================

// The reason the whole item side was theoretical in a real game: the build order never put up a
// shop, so the only shelf was a map's Goblin Merchant — shared, usually across the map, and on
// plenty of maps not there at all. Measured on Echo Isles: a Normal orc at ten minutes with a
// level-3 hero, no Town Portal and no Healing Salve.
const { PLUS_RACES } = require(join(REPO, ".sim-build", "src", "ai", "plus", "races.js"));
// The four race shops, off `Makeitems` in the install's own UnitFunc files.
const SHOPS = { human: "hvlt", orc: "ovln", undead: "utom", nightelf: "eden" };
for (const [race, id] of Object.entries(SHOPS)) {
  const table = PLUS_RACES[race];
  check(`${race} names its shop (${id})`, table && table.shop, id);
}

// ==========================================================================================
console.log("\n-- selling the duplicate -----------------------------------------------------");
// ==========================================================================================

// "Heroes that carry multiple Cloak of Shadows must try to sell them at shops … and keep only 1."
// WHICH duplicates is not a list of items: it is the question *does the game add the second one
// to the first*, which the sim answers in exactly one place (`SimWorld.itemBonuses`' switch,
// mirrored as `STACKS` in plus/items.ts).
const PAWNSHOP = unit({ owner: 12, typeId: "ngme", x: 500, building: { constructionLeft: 0, stock: null } });

/** Drive one pass against a shop that DEALS IN ITEMS, and report the sale it asked for. */
function pawned(units, opts = {}) {
  const orders = [];
  const world = {
    units: new Map([...units, PAWNSHOP].map((u) => [u.id, u])),
    items: new Map(),
    itemReadyError: () => null, itemUseError: () => null,
    shopReaches: () => true, shopStock: () => 0, missingForShop: () => [],
    isShopUnit: (id) => id === PAWNSHOP.id,
    // The `Apit` question, which is what makes a Marketplace or a Goblin Merchant a place you
    // may sell to and a Tavern not one.
    canPawnAt: () => opts.dealsInItems ?? true,
  };
  const items = new PlusItems({
    world, player: 0, def: (id) => ABILS[id], hostile: (u) => u.owner !== 0 && u.owner !== 12,
    order: (cmd) => { orders.push(cmd); return true; }, item: (id) => ITEMS[id],
    wares: () => [], gold: () => 0,
  }, PLUS_INSANE, "human");
  items.pass(500, { home: { x: 0, y: 0 }, losing: false, mayShop: opts.mayShop ?? true, portalWorthIt: true });
  return orders.find((c) => c.c === "sellitem") ?? null;
}

{
  const h = belt(hero(), "clsd", "clsd", "phea");
  const sale = pawned([h]);
  check("a second Cloak of Shadows is sold", sale && sale.c, "sellitem");
  check("…the LATER slot, so the granted ability never blinks off", sale && sale.slot, 1);
  check("…at the shop that deals in items", sale && sale.shopId, PAWNSHOP.id);
}
{
  check("one cloak is kept", pawned([belt(hero(), "clsd", "phea")]), null);
}
{
  // Claws of Attack ARE in the switch: two of them are +6 damage, and the second is worth its
  // slot. Being wrong the other way THROWS AN ITEM AWAY, so anything unlisted is never sold.
  check("two Claws of Attack both stay", pawned([belt(hero(), "rat3", "rat3")]), null);
}
{
  // Two Potions of Healing are two heals whatever their ability does — `usable`/`charges` is
  // refused before the duplicate test is even asked.
  check("two potions are two heals", pawned([belt(hero(), "phea", "phea")]), null);
}
{
  check("…and nothing the shops will not take back", pawned([belt(hero(), "qbot", "qbot")]), null);
}
{
  check("a Tavern is not somewhere to sell", pawned([belt(hero(), "clsd", "clsd")], { dealsInItems: false }), null);
}
{
  // It is a WALK, so it waits like the shopping trip does: never while there is a wave out.
  check("…and never while the army is in the field",
    pawned([belt(hero(), "clsd", "clsd")], { mayShop: false }), null);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
