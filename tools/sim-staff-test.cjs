// Headless check of the two STAVES that send a unit home — Staff of Preservation (`spre` →
// `ANpr`) and Staff of Sanctuary (`ssan` → `ANsa`). Both are driven through the real
// useItem() with stub registries carrying the install's own numbers:
//
//   ANpr  Cool1 30, Rng1 700, DataA 15 ("Building Types Allowed" = Hall|Resource|Factory|General)
//   ANsa  Cool1 45, Rng1 700, DataA 15, DataB 1 ("Hero Regeneration Delay"),
//         DataC 5 ("Unit Regeneration Delay"), DataE 15 ("Hit Points Per Second")
//
// …and the destination ranking is checked against Liquipedia's documented Human fallback
// chain: halls first, then Barracks (prio 9), Workshop/Arcane Sanctum/Altar (5), Cannon
// Tower (3), Arcane/Guard Tower (2), Scout Tower (1) — with Farm/Blacksmith/Lumber Mill/
// Arcane Vault/Gryphon Aviary (no `buffType` at all) never a destination.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const lvl = (over) => ({
  cost: 0, cooldown: 30, duration: 0, heroDuration: 0, castRange: 700, area: 0, castTime: 0,
  data: [15, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN], dataStr: [], buffs: [], summon: "", ...over,
});
const ability = (id, over = {}) => ({
  id, code: id, isHero: false, isItem: true, levels: 1, reqLevel: 0, levelSkip: 0,
  target: "unit", targetFlags: ["ground", "air", "vuln", "invu", "player", "neutral"],
  autocast: false, name: id, icon: "", hotkey: "", researchHotkey: "", buttonX: 0, buttonY: 0,
  learnX: 0, learnY: 0, research: false, tips: [], uberTips: [], researchTip: "", researchUberTip: "",
  // The Mass Teleport set the staves borrow, basenames only — the sound the renderer plays
  // is resolved off these paths (MassTeleportTarget.wav), so which art carries `sound` is
  // what the checks below pin down.
  missileArt: "", targetArt: "MassTeleportTarget.mdx", targetAttach: [],
  casterArt: "MassTeleportCaster.mdx", specialArt: "MassTeleportTarget.mdx", effectArt: "",
  areaArt: "", effectSound: "", buffFx: [], buffArt: "", buffEffectArt: "", buffSpecialArt: "",
  lightning: [], animNames: [], order: "", orderOn: "", orderOff: "",
  levelData: [lvl()], ...over,
});
const ABILITIES = new Map([
  ["ANpr", ability("ANpr")],
  ["ANsa", ability("ANsa", {
    levelData: [lvl({ cooldown: 45, data: [15, 1, 5, 10, 15, NaN, NaN, NaN, NaN], buffs: ["BNsa"] })],
    buffFx: [{ path: "Staff_Sanctuary_Target.mdx", attach: [] }],
    buffArt: "Staff_Sanctuary_Target.mdx",
  })],
]);
const item = (id, abil, cooldownGroup) => ({
  id, name: id, description: "", icon: "", tip: "", hotkey: "", buttonX: -1, buttonY: -1,
  model: "", scale: 1, gold: 0, lumber: 0, level: 0, classType: "Purchasable", abilities: [abil],
  charges: 0, cooldownGroup, usable: true, perishable: false, powerup: false, droppable: true,
  sellable: true, pawnable: true, pickRandom: false, maxHp: 75, stockMax: 1, stockRegen: 120, stockStart: 0,
});
const ITEMS = new Map([["spre", item("spre", "ANpr", "ANpr")], ["ssan", item("ssan", "ANsa", "ANsa")]]);

// The Human building set, verbatim from UnitData.slk's `prio` + `buffType` columns.
const BUILDINGS = {
  hcas: { priority: 8, buffType: "townhall" }, hkee: { priority: 7, buffType: "townhall" },
  htow: { priority: 6, buffType: "townhall" }, hbar: { priority: 9, buffType: "factory" },
  harm: { priority: 5, buffType: "factory" }, hars: { priority: 5, buffType: "factory" },
  halt: { priority: 5, buffType: "factory" }, hctw: { priority: 3, buffType: "buffer" },
  hatw: { priority: 2, buffType: "buffer" }, hgtw: { priority: 2, buffType: "buffer" },
  hwtw: { priority: 1, buffType: "buffer" },
  // The five with no category — Liquipedia's "cannot be teleported to" list.
  hgra: { priority: 5, buffType: "" }, hbla: { priority: 4, buffType: "" },
  hlum: { priority: 4, buffType: "" }, hvlt: { priority: 1, buffType: "" },
  hhou: { priority: 1, buffType: "" },
};
const UNITS = { get: (id) => BUILDINGS[id] ?? { priority: 0, buffType: "" } };

// 256 × 32-unit cells = 8192 world units of open ground, which comfortably holds every
// coordinate below (0x40 = open land, the flag the melee maps' own wpm uses).
const N = 256;
const newWorld = () =>
  new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [] },
    { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) },
    UNITS);

let world = newWorld();
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 1000, y: 1000, prevX: 1000, prevY: 1000,
    hp: 100, maxHp: 1000, mana: 0, maxMana: 0, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "human", level: 1,
    hpRegen: 0, manaRegen: 0, baseMaxHp: 1000, baseMaxMana: 0, baseHpRegen: 0, baseManaRegen: 0,
    baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, radius: 16, footprint: 0,
    order: "idle", targetId: null, path: [], waypoint: 0, moving: false, facing: 0,
    pendingCast: null, followLeaderId: null, inCombat: false, working: false, atNode: false,
    noCollision: false, stallT: 0, waitT: 0, gaveUp: false, acquireT: 0, arrowShot: null,
    constructing: 0, cooldownLeft: 0, linkT: 0, linkGroup: [], repathT: 0, stunned: false,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const building = (typeId, x, y, owner = 0) =>
  unit({ typeId, x, y, prevX: x, prevY: y, owner, hp: 500, maxHp: 500, radius: 0, footprint: 0,
    building: { constructionLeft: 0, queue: [], builderIds: [], rally: null } });
const give = (u, itemId) => { u.inventory[0] = { id: nextId++, itemId, charges: 0, cooldownLeft: 0 }; return u; };

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}, got ${got}`}`);
}
const near = (what, got, want, tol = 0.5) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}±${tol}, got ${got}`}`);
};

// --- Staff of Preservation: the target goes to the highest-tier hall -------------------
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "spre");
  const target = unit({ x: 1400, y: 1000, prevX: 1400, prevY: 1000 });
  building("htow", 5000, 5000);
  building("hcas", 3000, 3000); // Castle (prio 8) outranks the Town Hall (6)
  building("hbar", 2000, 2000); // …and the prio-9 Barracks is a Factory, so it stays behind both
  check("Preservation fires", world.useItem(hero.id, 0, target.id, 0, 0), true);
  near("…and the target lands at the Castle (x)", target.x, 3000, 200);
  near("…and the target lands at the Castle (y)", target.y, 3000, 200);
  check("…and it spends the item's 30s cooldown", hero.inventory[0].cooldownLeft, 30);
  check("…and the target takes no buff", target.buffs.length, 0);
  // Three models: the staff-bearer's flourish, the traveller's departure, its arrival — and
  // the teleport whoosh on the two that are the TRAVELLER's, at each end of the hop.
  const fx = world.drainSpellEffects();
  check("three effects play", fx.length, 3);
  check("…the caster's, silently, on the bearer", `${fx[0].art}@${fx[0].x},${fx[0].y}:${!!fx[0].sound}`, "MassTeleportCaster.mdx@1000,1000:false");
  check("…the departure, with the whoosh", `${fx[1].art}@${fx[1].x},${fx[1].y}:${!!fx[1].sound}`, "MassTeleportTarget.mdx@1400,1000:true");
  check("…and the arrival, with it too", `${fx[2].art}:${!!fx[2].sound}`, "MassTeleportTarget.mdx:true");
  near("…at the Castle it arrived on", Math.hypot(fx[2].x - 3000, fx[2].y - 3000), 0, 200);
}

// --- The fallback chain, exactly as Liquipedia documents it for the Human race ---------
{
  const chain = ["hbar", "harm", "hars", "halt", "hctw", "hatw", "hgtw", "hwtw"];
  for (let i = 0; i < chain.length; i++) {
    world = newWorld();
    nextId = 1;
    const hero = give(unit({ isHero: true }), "spre");
    const target = unit({ x: 1400, y: 1000, prevX: 1400, prevY: 1000 });
    // Every never-a-destination building is standing, plus the rest of the chain from `i` on.
    for (const none of ["hgra", "hbla", "hlum", "hvlt", "hhou"]) building(none, 6000, 6000);
    const want = building(chain[i], 3000, 3000);
    for (let j = i + 1; j < chain.length; j++) building(chain[j], 5000, 5000);
    world.useItem(hero.id, 0, target.id, 0, 0);
    near(`fallback #${i + 1} is ${chain[i]}`, Math.hypot(target.x - want.x, target.y - want.y), 0, 200);
  }
}
{
  // Nothing but the uncategorised buildings: there is nowhere to send anybody.
  world = newWorld();
  const hero = give(unit({ isHero: true }), "spre");
  const target = unit({ x: 1400, y: 1000, prevX: 1400, prevY: 1000 });
  for (const none of ["hgra", "hbla", "hlum", "hvlt", "hhou"]) building(none, 6000, 6000);
  check("no categorised building = no teleport", world.useItem(hero.id, 0, target.id, 0, 0), false);
  check("…and the game's own error says so", world.itemUseError(hero.id, 0, target.id), "Nopreservationtarget");
  check("…and no charge/cooldown was spent", hero.inventory[0].cooldownLeft, 0);
}

// --- What a staff refuses -------------------------------------------------------------
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "spre");
  building("htow", 3000, 3000);
  const summon = unit({ x: 1400, y: 1000, isSummon: true });
  check("summoned units are refused", world.itemUseError(hero.id, 0, summon.id), "Notsummoned");
  const enemy = unit({ x: 1400, y: 1000, owner: 1, team: 1 });
  check("another player's unit is refused", world.itemUseError(hero.id, 0, enemy.id) !== null, true);
  const far = unit({ x: 1000 + 900, y: 1000 });
  check("out of the 700 range is refused", world.itemUseError(hero.id, 0, far.id), "Notinrange");
  const held = unit({ x: 1400, y: 1000 });
  held.buffs.push({ kind: "slow", group: "", timeLeft: 10, sourceId: 0, value: 0.5, value2: 0, art: "", fx: [], buffId: "", delay: 0 });
  check("a crowd-controlled unit is refused (Purge's slow)", world.itemUseError(hero.id, 0, held.id), "Teleportfail");
  check("bare ground is refused", world.itemUseError(hero.id, 0, 0), "Targetunit");
  const ok = unit({ x: 1400, y: 1000 });
  check("a plain own unit in range is accepted", world.itemUseError(hero.id, 0, ok.id), null);
}

// --- A cooling-down item is refused ON THE PRESS, before anything is aimed --------------
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "spre");
  building("htow", 3000, 3000);
  const target = unit({ x: 1400, y: 1000 });
  check("a ready item arms", world.itemReadyError(hero.id, 0), null);
  check("…and fires", world.useItem(hero.id, 0, target.id, 0, 0), true);
  check("the spent item is now cooling down", world.itemReadyError(hero.id, 0), "Itemcooldown");
  check("…which is what an aimed click would say too", world.itemUseError(hero.id, 0, target.id), "Itemcooldown");
  check("…and a second use does nothing", world.useItem(hero.id, 0, target.id, 0, 0), false);
  check("an empty slot is not usable either", world.itemReadyError(hero.id, 3), "Cantuseitem");
}

// --- Staff of Sanctuary: teleport + stun + regenerate until full -----------------------
{
  world = newWorld();
  const hero = give(unit({ isHero: true }), "ssan");
  building("htow", 3000, 3000);
  const target = unit({ x: 1400, y: 1000, prevX: 1400, prevY: 1000, hp: 100, maxHp: 400, baseMaxHp: 400 });
  check("Sanctuary fires", world.useItem(hero.id, 0, target.id, 0, 0), true);
  check("…and spends its own 45s cooldown", hero.inventory[0].cooldownLeft, 45);
  check("…and the target is stunned", target.buffs.some((b) => b.kind === "stun"), true);
  const hot = target.buffs.find((b) => b.kind === "hot");
  check("…and regenerates 15 hp/sec", hot.value, 15);
  check("…after the 5s non-hero Regeneration Delay", hot.delay, 5);
  check("…wearing BNsa's own art", hot.fx[0].path, "Staff_Sanctuary_Target.mdx");
  // 5s of delay, then 300 hp to make up at 15/sec = 20s.
  for (let i = 0; i < 5; i++) world.tickBuffs(target, 1);
  check("nothing heals during the delay", target.hp, 100);
  for (let i = 0; i < 19; i++) world.tickBuffs(target, 1);
  near("…then it heals at 15 hp/sec", target.hp, 385);
  check("…and is still pinned", target.buffs.some((b) => b.kind === "stun"), true);
  world.tickBuffs(target, 1);
  check("at full health the effect ends", target.hp, 400);
  check("…both halves of it", target.buffs.length, 0);
}
{
  // A HERO waits 1 second instead of 5 ("Hero Regeneration Delay" = DataB).
  world = newWorld();
  const hero = give(unit({ isHero: true }), "ssan");
  building("htow", 3000, 3000);
  const target = unit({ x: 1400, y: 1000, isHero: true, hp: 100, maxHp: 400, baseMaxHp: 400 });
  world.useItem(hero.id, 0, target.id, 0, 0);
  check("a hero's Regeneration Delay is 1s", target.buffs.find((b) => b.kind === "hot").delay, 1);
}
{
  // "Multiple instances of the heal-over-time effect stack" (Liquipedia) — but two stuns
  // are one stun, so the stun half takes a group and the regeneration half does not.
  world = newWorld();
  const a = give(unit({ isHero: true }), "ssan");
  const b = give(unit({ isHero: true, x: 1100, y: 1000 }), "ssan");
  building("htow", 1500, 1000); // close by, so both bearers are still in range after the hop
  const target = unit({ x: 1400, y: 1000, hp: 100, maxHp: 4000, baseMaxHp: 4000 });
  world.useItem(a.id, 0, target.id, 0, 0);
  world.useItem(b.id, 0, target.id, 0, 0);
  check("two staves stack two regenerations", target.buffs.filter((x) => x.kind === "hot").length, 2);
  check("…but only ever one stun", target.buffs.filter((x) => x.kind === "stun").length, 1);
}

console.log(failed ? `\n${failed} FAILED` : "\nall staff checks passed");
process.exit(failed ? 1 : 0);
