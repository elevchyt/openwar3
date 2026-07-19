// Headless check of True Sight against invisibility.
//
// Two rules are pinned here. First, detection is a TEAM property: the Shade stands at the
// back and the whole army sees what it uncovers. Second — and this is the one that got
// away — the radius is DERIVED from the ability's `Rng1`, not from dataA.
//
// This file used to hand-set `detectRadius` for every case and assert the derivation only in
// a comment ("Atru, dataA = 900"). The comment was wrong and the tests passed anyway: dataA
// reads 3 for all three detect abilities, so every detector really had a 3-unit reach and
// revealed nothing. Radii below are Rng1 of the real 1.27a AbilityData.slk rows:
//
//   Atru  "Detect (Shade)"           Rng1  900
//   Adet  "Detect (Sentry Ward)"     Rng1 1100
//   Adts  "Detect (Magic Sentinel)"  Rng1  900
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
let nextId = 1;
function unit(over = {}) {
  const u = { id: nextId++, owner: 0, team: 0, hp: 100, x: 0, y: 0, detectRadius: 0, invisible: false, ...over };
  world.units.set(u.id, u);
  return u;
}

const hidden = unit({ team: 1, x: 0, y: 0, invisible: true });

check("nothing detects it to begin with", world.teamDetects(0, hidden.x, hidden.y), false);

// A Shade (Atru, Rng1 = 900) 500 away — well inside its radius.
const shade = unit({ team: 0, x: 500, y: 0, detectRadius: 900 });
check("a Shade 500 away uncovers it", world.teamDetects(0, hidden.x, hidden.y), true);
// …and only for the Shade's OWN team. Detection is shared sideways across an army, never
// handed to the other side.
check("…but not for the hidden unit's own team, which owns no detector", world.teamDetects(1, hidden.x, hidden.y), false);

// Out of range again.
shade.x = 2000;
check("a Shade 2000 away does not", world.teamDetects(0, hidden.x, hidden.y), false);

// The Sentry Ward's radius is wider (Adet Rng1 = 1100), so it still covers from 1000.
const ward = unit({ team: 0, x: 1000, y: 0, detectRadius: 1100 });
check("a Sentry Ward reaches further (1100)", world.teamDetects(0, hidden.x, hidden.y), true);

// A dead detector detects nothing.
ward.hp = 0;
check("a dead detector uncovers nothing", world.teamDetects(0, hidden.x, hidden.y), false);

// --- the derivation itself -----------------------------------------------------------
//
// Everything above takes `detectRadius` as given, which is exactly how the dataA bug hid:
// the property was pinned but the thing that COMPUTES it was not. These cases run
// recomputeStats against a stubbed registry carrying the real Rng1/dataA split, so reading
// the wrong column fails here instead of shipping.
const RNG1 = { Atru: 900, Adet: 1100, Adts: 900 };
const DATA_A = 3; // what all three rows actually carry in dataA — never a distance
const stubReg = {
  get: (id) => (RNG1[id] === undefined ? undefined : { levelData: [{ castRange: RNG1[id], data: [DATA_A] }] }),
};
const derived = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1, stubReg);
function radiusOf(abilities) {
  // recomputeStats derives the unit's WHOLE stat block, so the bare fields it walks
  // (inventory, weapons, base*) have to be present even though only detectRadius is read.
  const u = {
    id: 9000, owner: 0, team: 0, hp: 100, x: 0, y: 0, detectRadius: 0, invisible: false,
    buffs: [], inventory: [], weapons: [], abilities,
    baseArmor: 0, baseMaxHp: 100, baseMaxMana: 0, baseMoveSpeed: 270, baseSight: 1800,
  };
  derived.recomputeStats(u);
  return u.detectRadius;
}
const abil = (id, level = 1) => ({ id, code: id, level, cooldownLeft: 0, autocastOn: false });

check("a Shade derives 900 from Atru's Rng1", radiusOf([abil("Atru")]), 900);
check("a Sentry Ward derives 1100 from Adet's Rng1", radiusOf([abil("Adet")]), 1100);
check("Magic Sentinel derives 900 from Adts' Rng1", radiusOf([abil("Adts")]), 900);
// The widest wins when a unit somehow carries more than one.
check("carrying two, the widest wins", radiusOf([abil("Atru"), abil("Adet")]), 1100);
// An unlearned ability grants nothing — level 0 is "on the card but not trained".
check("an unlearned detect ability grants no sight", radiusOf([abil("Atru", 0)]), 0);
// And a unit with no detect ability at all detects nothing.
check("a unit with no detect ability has no radius", radiusOf([abil("Amim")]), 0);

// --- availability, not membership ----------------------------------------------------
//
// All four Human towers carry `Adts` from birth, but `[Adts] Requires=Rhse` (Magic Sentry).
// Carrying the ability is not having it: without the research the tower sees nothing, which
// is the standing "abilList membership is not availability" rule.
const gated = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1, stubReg);
let researched = false;
gated.techMeets = (_player, id) => (id === "Adts" ? researched : true);
function gatedRadius() {
  const u = {
    id: 9001, owner: 0, team: 0, hp: 100, x: 0, y: 0, detectRadius: 0, invisible: false,
    buffs: [], inventory: [], weapons: [], abilities: [abil("Adts")],
    baseArmor: 0, baseMaxHp: 100, baseMaxMana: 0, baseMoveSpeed: 270, baseSight: 1800,
  };
  gated.recomputeStats(u);
  return u.detectRadius;
}
check("a tower without Magic Sentry researched detects nothing", gatedRadius(), 0);
researched = true;
check("…and 900 once the research lands", gatedRadius(), 900);

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
