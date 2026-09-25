// Headless check of the SYNCHRONOUS damage events (SimWorld.damageHook — docs/map-compatibility.md):
// a blow handed to the map's script twice while it is dealt, and changed by it.
//
//   "EVENT_PLAYER_UNIT_DAMAGING — triggers before any armor, armor type and other resistances …
//    Amount you set will be reduced later according to target's resistance, armor etc. If set to
//    <=0 during [DAMAGING], then [DAMAGED] will never fire. … Set to 0.00 to completely block the
//    damage. Set to negative value to heal the target instead of damaging." (jassbot, BlzSetEventDamage)
//
// Plus the two things the game does not do for us: a handler that deals damage raises another
// event ("it will cause infinite loop and game will crash") — we cap the depth instead — and a
// handler may kill or remove the target mid-blow, which must land nothing after it.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const N = 128;
const world = new SimWorld(
  new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
  { get: () => undefined, has: () => false, buffFx: () => [] },
  { get: () => undefined, has: () => false },
  { get: () => ({ priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 }), has: () => true },
);
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 500, y: 500, prevX: 500, prevY: 500,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    baseInvulnerable: false, neutralPassive: false, isIllusion: false, isSummon: false,
    race: "human", level: 1, xp: 0, xpSuspended: false, skillPoints: 0, hpRegen: 0, manaRegen: 0,
    baseMaxHp: 1000, baseMaxMana: 0, baseHpRegen: 0, baseManaRegen: 0, baseArmor: 0, armor: 0,
    baseSpeed: 270, speed: 270, radius: 16, footprint: 0, order: "idle", targetId: null, path: [],
    waypoint: 0, moving: false, facing: 0, stunned: false, magicImmune: false, detectRadius: 0,
    summonLeft: 0, immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false,
    baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0,
    str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0, intPerLevel: 0, primaryAttr: "",
    armorType: "large", targClass: "ground", garrison: [], itemCooldowns: new Map(), linkT: 0, linkGroup: [], thorns: 0, rangedReduction: 0, magicReduction: 0, ethereal: false,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
let failed = 0;
function check(what, got, want) {
  const ok = typeof want === "number" && typeof got === "number" ? Math.abs(got - want) < 1e-6 : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}
const seen = [];
const hit = (a, b, raw, type = "normal") => world.applyDamage(b, raw, a.id, type, "MetalMediumSlice");

console.log("no hook: the engine as it was");
{
  const a = unit(), b = unit({ armorType: "fort" });
  world.damageHook = null;
  // Normal vs Fortified is 0.70 in the damage table (MiscGame DamageBonusNormal); armour 0.
  check("a Normal blow of 100 on Fortified lands 70", hit(a, b, 100), 70);
}

console.log("\nDAMAGING changes the RAW blow, before the table and the armour");
{
  const a = unit(), b = unit({ armorType: "fort" }); // so the Chaos swap is visible: 0.70 → 1.0
  world.damageHook = (phase, blow) => {
    seen.push([phase, blow.amount, blow.attackType, blow.damageType, blow.weaponSound]);
    if (phase === "damaging") { blow.amount *= 2; blow.attackType = "chaos"; }
  };
  seen.length = 0;
  const dealt = hit(a, b, 100);
  check("DAMAGING sees the raw 100, a Normal attack, DAMAGE_TYPE_NORMAL, and its weapon", JSON.stringify(seen[0]), JSON.stringify(["damaging", 100, "normal", 4, "MetalMediumSlice"]));
  check("doubled and made Chaos (Chaos is 1.0 against everything), it lands 200", dealt, 200);
  check("DAMAGED then sees what is about to come off", JSON.stringify(seen[1]), JSON.stringify(["damaged", 200, "chaos", 4, "MetalMediumSlice"]));
  check("…and it came off", b.hp, 800);
}

console.log("\nDAMAGED changes the FINAL blow");
{
  const a = unit(), b = unit();
  world.damageHook = (phase, blow) => { if (phase === "damaged") blow.amount = 5; };
  hit(a, b, 100);
  check("the final amount the handler set is the one that lands", b.hp, 995);
}

console.log("\n0 blocks, a negative amount heals, and DAMAGED never fires after a blocked DAMAGING");
{
  const a = unit(), b = unit({ hp: 500 });
  seen.length = 0;
  world.damageHook = (phase, blow) => { seen.push(phase); if (phase === "damaging") blow.amount = 0; };
  hit(a, b, 100);
  check("blocked: nothing came off", b.hp, 500);
  check("…and DAMAGED was never raised", JSON.stringify(seen), JSON.stringify(["damaging"]));
  world.damageHook = (phase, blow) => { if (phase === "damaging") blow.amount = -120; };
  hit(a, b, 100);
  check("negative: the target was healed by 120", b.hp, 620);
}

console.log("\nthe script's own UnitDamageTarget and a spell's damage raise it too");
{
  const a = unit(), b = unit();
  seen.length = 0;
  world.damageHook = (phase, blow) => seen.push([phase, blow.amount, blow.damageType]);
  world.damageTarget(a.id, b.id, 50, { attack: false, ranged: false, attackType: "chaos", magic: false, universal: false, damageType: 13 });
  check("UnitDamageTarget: DAMAGING with the native's own damage type, then DAMAGED", JSON.stringify(seen), JSON.stringify([["damaging", 50, 13], ["damaged", 50, 13]]));
  seen.length = 0;
  world.landDamage(b, 30, a.id, false);
  check("a spell's direct damage: DAMAGING (type UNKNOWN) and DAMAGED", JSON.stringify(seen), JSON.stringify([["damaging", 30, 0], ["damaged", 30, 0]]));
}

console.log("\na handler that kills the target, and one that deals damage");
{
  const a = unit(), b = unit();
  world.damageHook = (phase) => { if (phase === "damaging") world.killUnit(b.id); };
  check("the target died inside DAMAGING: nothing lands after it", hit(a, b, 100), 0);
  const c = unit(), d = unit();
  let raised = 0;
  world.damageHook = (phase) => {
    raised++;
    // Retaliate from INSIDE the event — the loop the game crashes on.
    if (phase === "damaging") world.damageTarget(d.id, c.id, 1, { attack: false, ranged: false, attackType: "chaos", magic: false, universal: false });
  };
  hit(c, d, 10);
  check("nested damage from a handler terminates (depth cap)", raised > 0 && raised < 100, true);
  check("…and every blow still landed", c.hp < 1000 && d.hp < 1000, true);
}

console.log("\nnothing is raised twice: with the hook set, the queued DAMAGED is not used");
{
  const a = unit(), b = unit();
  world.captureDamage = true;
  world.damageHook = () => {};
  world.drainDamageEvents();
  hit(a, b, 100);
  check("the queue is empty", world.drainDamageEvents().length, 0);
  world.damageHook = null;
  hit(a, b, 100);
  check("…and without a hook the queue is exactly as before", world.drainDamageEvents().length, 1);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall damage-hook checks passed");
