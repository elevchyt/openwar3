// Headless check that a kill by a DAMAGE-OVER-TIME buff is credited to the buff's owner (issue
// #348): `tickBuffs` used to call `kill(u)` with no killer, so a creep finished by Shadow Strike,
// a Flame Strike burn, Doom or Acid Bomb paid no experience, no bounty and no kill. Also that an
// invulnerable unit's dot does not bite.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

let nextId = 1;
function unit(world, over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, hp: 500, maxHp: 500, mana: 0, maxMana: 0, x: 0, y: 0,
    buffs: [], abilities: [], inventory: [], weapons: [], garrison: [], flying: false,
    building: null, mechanical: false, isHero: false, isIllusion: false, invulnerable: false,
    neutralPassive: false, ethereal: false, thorns: 0, summonLeft: 0, constructing: null,
    inMine: false, resId: 0, typeId: "hfoo", level: 1, race: "human", magicTaken: 1, magicReduction: 0,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const dot = (sourceId, value, over = {}) => ({ kind: "dot", value, timeLeft: 10, delay: 0, sourceId, group: "shadowstrike", ...over });

{
  const w = new SimWorld({ width: 4, height: 4, cell: 128, blocked: new Uint8Array(16) }, 1);
  const killer = unit(w, { owner: 1, team: 1, x: 300 });
  const victim = unit(w, { hp: 5, buffs: [dot(killer.id, 100)] });
  let seen = null;
  w.deathObserver = (v, k) => { if (v === victim) seen = k ? k.id : 0; };
  w.tickBuffs(victim, 0.1);
  check("the dot's owner is the killer", seen, killer.id);
}

{
  // Two dots: the one whose bite took the last point is credited.
  const w = new SimWorld({ width: 4, height: 4, cell: 128, blocked: new Uint8Array(16) }, 1);
  const a = unit(w, { owner: 1, team: 1 });
  const b = unit(w, { owner: 2, team: 2 });
  const victim = unit(w, { hp: 15, buffs: [dot(a.id, 100), dot(b.id, 100)] });
  let seen = null;
  w.deathObserver = (v, k) => { if (v === victim) seen = k ? k.id : 0; };
  w.tickBuffs(victim, 0.1);
  check("the second dot took the last point", seen, b.id);
}

{
  const w = new SimWorld({ width: 4, height: 4, cell: 128, blocked: new Uint8Array(16) }, 1);
  const killer = unit(w, { owner: 1, team: 1 });
  const victim = unit(w, { hp: 5, invulnerable: true, buffs: [dot(killer.id, 100)] });
  w.tickBuffs(victim, 0.1);
  check("an invulnerable unit's dot does not bite", victim.hp, 5);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
