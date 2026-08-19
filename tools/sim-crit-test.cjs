// Headless check of CRITICAL STRIKE and the floating combat text the engine raises off it —
// the Blademaster's AOcr, the Pandaren Brewmaster's Drunken Brawler (ANdb), and the DENY mark
// left over a unit killed by its own side. See src/sim/world.ts (CombatText, criticalStrikeLevel).
//
// Every number below is the real 1.30.4 one from Units\AbilityData.slk:
//   AOcr  Blade Master - Critical Strike  DataA 15/15/15 (chance %)  DataB 2/3/4  DataD 0
//   ANdb  Brewmaster - Drunken Brawler    DataA 10/10/10 (chance %)  DataB 2/3/4  DataD .07/.14/.21
//   AEev  Demon Hunter - Evasion          DataA 0.1/0.2/0.3 (a FRACTION — Ocr4 is maxVal=1)
// The two rows share one field group: AbilityMetaData.slk declares Ocr1..Ocr6 with
// `useSpecific=AOcr,ACct,ANdb`, which is why one implementation serves both. The clones fold
// in for free off their `code` column — ACct/AIcs carry code=AOcr, Chen's Acdb carries code=ANdb.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

const lvl = (data) => ({
  cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0,
  data: Object.assign(new Array(9).fill(NaN), data), dataStr: new Array(9).fill(""), buffs: [], summon: "",
});
const abil = (id, code, levels) => ({
  id, code, levels: levels.length, levelData: levels.map(lvl), missileArt: "", targetArt: "",
  targetAttach: [], casterArt: "", specialArt: "", buffFx: [], buffArt: "", targetFlags: [],
});

// dataA = chance %, dataB = multiplier, dataC = flat bonus, dataD = chance to evade.
const AOcr = abil("AOcr", "AOcr", [[15, 2, 0, 0], [15, 3, 0, 0], [15, 4, 0, 0]]);
const ANdb = abil("ANdb", "ANdb", [[10, 2, 0, 0.07], [10, 3, 0, 0.14], [10, 4, 0, 0.21]]);
// Chen's campaign clone and the creep/item crits: different alias, same base `code`.
const Acdb = abil("Acdb", "ANdb", [[10, 2, 0, 0.07]]);
const ACct = abil("ACct", "AOcr", [[20, 2, 0, 0]]);
// Evasion is its OWN ability, and its chance sits in dataA as a fraction.
const AEev = abil("AEev", "AEev", [[0.1], [0.2], [0.3]]);

const ABILITIES = Object.fromEntries([AOcr, ANdb, Acdb, ACct, AEev].map((a) => [a.id, a]));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

function world(roll = 0.5) {
  const w = new SimWorld({ width: 4, height: 4, cell: 128, blocked: new Uint8Array(16) }, 1);
  w.abilities = { get: (id) => ABILITIES[id], all: () => Object.values(ABILITIES) };
  w.rng = () => roll; // every chance in the sim reads this one source
  return w;
}

let nextId = 1;
function unit(w, over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, x: 100, y: 200, hp: 1000, maxHp: 1000, mana: 0, maxMana: 0,
    buffs: [], abilities: [], inventory: [], weapons: [], garrison: [], orderQueue: [],
    arrowShot: null, blackArrow: null, incinerate: null, isHero: false, isSummon: false,
    building: null, mechanical: false, flying: false, invulnerable: false, neutralPassive: false,
    isIllusion: false, race: "orc", typeId: "Obla", level: 1, baseMaxHp: 1000, baseMaxMana: 0,
    baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, hpRegen: 0, manaRegen: 0, lifesteal: 0,
    thorns: 0, swingCrit: false, swingBash: false, cloaked: false, devouring: 0, devouredBy: 0,
    garrisonHost: 0, constructing: 0, inMine: false, resId: 0, linkShare: 0, linkT: 0, linkGroup: [],
    ...over,
  };
  w.units.set(u.id, u);
  return u;
}
const skill = (id, level = 1) => ({ id, code: ABILITIES[id].code, level, cooldownLeft: 0, autocastOn: false });
// A plain melee weapon: 100 flat damage, no dice, so the roll is exactly 100.
const weapon = () => ({ damage: 100, dice: 0, sides: 0, cooldown: 1, damagePoint: 0, backswing: 0, range: 90, ranged: false, attackType: "normal", weaponSound: "MetalHeavyChop" });

console.log("\nCritical Strike is ONE implementation over two rows (AOcr + ANdb)");
{
  const w = world(0.05); // under both 15% and 10%
  const bm = unit(w, { isHero: true, abilities: [skill("AOcr", 3)] });
  const pm = unit(w, { isHero: true, typeId: "Npbm", abilities: [skill("ANdb", 2)] });
  const chen = unit(w, { isHero: true, typeId: "Nbrn", abilities: [skill("Acdb")] });
  const grunt = unit(w, { abilities: [skill("ACct")] });
  const plain = unit(w, {});
  check("a Blademaster rolls a crit", w.rollCriticalStrike(bm), true);
  check("a Brewmaster rolls one too (Drunken Brawler)", w.rollCriticalStrike(pm), true);
  check("…and so does Chen's campaign clone, off its `code`", w.rollCriticalStrike(chen), true);
  check("…and the creep crit, off the same `code`", w.rollCriticalStrike(grunt), true);
  check("a unit with neither rolls nothing", w.rollCriticalStrike(plain), false);
}
{
  // dataA is a PERCENT (Ocr1 maxVal=100): a 0.12 roll is over the Brewmaster's 10% and under
  // the Blademaster's 15%. Reading it as a fraction would make both fire on every swing.
  const w = world(0.12);
  const bm = unit(w, { isHero: true, abilities: [skill("AOcr")] });
  const pm = unit(w, { isHero: true, abilities: [skill("ANdb")] });
  check("15% fires at a 0.12 roll", w.rollCriticalStrike(bm), true);
  check("10% does not", w.rollCriticalStrike(pm), false);
}
{
  const w = world();
  const bm = unit(w, { isHero: true, swingCrit: true, abilities: [skill("AOcr", 3)] });
  const pm = unit(w, { isHero: true, swingCrit: true, abilities: [skill("ANdb", 2)] });
  const cold = unit(w, { isHero: true, abilities: [skill("AOcr", 3)] });
  check("AOcr rank 3 multiplies by 4", w.applyCriticalStrike(bm, 50), 200);
  check("ANdb rank 2 multiplies by 3", w.applyCriticalStrike(pm, 50), 150);
  check("a swing that did not roll one is untouched", w.applyCriticalStrike(cold, 50), 50);
}

console.log("\nDrunken Brawler's dodge is the OTHER half of the same row (dataD, a fraction)");
{
  const w = world(0.1);
  const pm1 = unit(w, { isHero: true, abilities: [skill("ANdb", 1)] }); // 7%
  const pm2 = unit(w, { isHero: true, abilities: [skill("ANdb", 2)] }); // 14%
  const dh = unit(w, { isHero: true, abilities: [skill("AEev", 1)] }); // 10% — dataA
  const bm = unit(w, { isHero: true, abilities: [skill("AOcr", 3)] }); // dataD is 0
  check("rank 1 (7%) does not dodge a 0.1 roll", w.tryEvade(pm1), false);
  check("rank 2 (14%) does", w.tryEvade(pm2), true);
  check("Evasion still reads its own dataA", w.tryEvade(dh), false); // 0.1 < 0.1 is false
  check("a Blademaster dodges nothing", w.tryEvade(bm), false);
}

console.log("\na crit prints the damage DEALT in red, with an exclamation mark");
{
  const w = world();
  const bm = unit(w, { isHero: true, swingCrit: true, abilities: [skill("AOcr", 1)] }); // ×2
  const foe = unit(w, { owner: 1, team: 1 });
  w.dealDamage(bm, foe, weapon());
  const texts = w.drainCombatTexts();
  check("one text, over the unit that was struck", texts.map((t) => [t.kind, t.unitId, t.text, t.colorSlot]), [["crit", foe.id, "200!", -1]]);
  check("…and the queue is drained", w.drainCombatTexts().length, 0);
}
{
  // A Brewmaster's crit prints the same way — that is the whole point of one implementation.
  const w = world();
  const pm = unit(w, { isHero: true, swingCrit: true, abilities: [skill("ANdb", 3)] }); // ×4
  const foe = unit(w, { owner: 1, team: 1 });
  w.dealDamage(pm, foe, weapon());
  check("Drunken Brawler prints its crit too", w.drainCombatTexts().map((t) => t.text), ["400!"]);
}
{
  const w = world();
  const bm = unit(w, { isHero: true, abilities: [skill("AOcr", 1)] });
  const foe = unit(w, { owner: 1, team: 1 });
  w.dealDamage(bm, foe, weapon());
  check("an ordinary swing prints nothing", w.drainCombatTexts().length, 0);
}
{
  // Nothing landed, nothing printed: an invulnerable target eats the whole blow.
  const w = world();
  const bm = unit(w, { isHero: true, swingCrit: true, abilities: [skill("AOcr", 1)] });
  const foe = unit(w, { owner: 1, team: 1, invulnerable: true });
  w.dealDamage(bm, foe, weapon());
  check("a crit that dealt nothing prints nothing", w.drainCombatTexts().length, 0);
}

console.log("\na deny leaves a '!' in the colour of the player who owned the unit");
{
  const w = world();
  const mine = unit(w, { owner: 3, team: 0, x: 640, y: 512 });
  const myOther = unit(w, { owner: 3, team: 0 });
  w.kill(mine, myOther.id);
  check("killing your own unit denies", w.drainCombatTexts().map((t) => [t.kind, t.text, t.colorSlot, t.x, t.y]), [["deny", "!", 3, 640, 512]]);
}
{
  const w = world();
  const ally = unit(w, { owner: 5, team: 0 });
  const me = unit(w, { owner: 3, team: 0 });
  w.kill(ally, me.id);
  check("…and so does killing an ALLY's unit, in the ally's colour", w.drainCombatTexts().map((t) => t.colorSlot), [5]);
}
{
  const w = world();
  const mine = unit(w, { owner: 0, team: 0, building: { queue: [], builderIds: [], constructionLeft: 0 } });
  const foe = unit(w, { owner: 1, team: 1 });
  w.kill(mine, foe.id);
  check("an enemy's kill is not a deny", w.drainCombatTexts().length, 0);
}
{
  const w = world();
  const creep = unit(w, { owner: -1, team: -1 });
  const otherCreep = unit(w, { owner: -1, team: -1 });
  w.kill(creep, otherCreep.id);
  check("a creep camp culling its own is not a deny", w.drainCombatTexts().length, 0);
}
{
  const w = world();
  const sapper = unit(w, { owner: 2, team: 0 });
  w.kill(sapper, sapper.id);
  check("a unit that killed itself denied nobody", w.drainCombatTexts().length, 0);
}
{
  const w = world();
  const orphan = unit(w, { owner: 2, team: 0 });
  w.kill(orphan, 0);
  check("an unattributed death is not a deny", w.drainCombatTexts().length, 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
