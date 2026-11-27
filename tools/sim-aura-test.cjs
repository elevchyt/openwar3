// Headless check of the HOSTILE aura path — Disease Cloud (`Aapl`, the Abomination).
//
// Every other aura in the game helps its owner's army; this one afflicts the other side,
// and which side it lands on is read from the ability's own `targs1`
// (`ground,enemy,organic,neutral`) rather than decided in code. The rest of those flags
// have to hold too: no flyer and no mechanical unit catches the plague.
//
// Numbers are the real row: Area 176, dataA "Aura Duration" 120, dataB "Damage per
// Second" 1.
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

const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
world.abilities = {
  get: () => ({
    targetFlags: ["ground", "enemy", "organic", "neutral"],
    levelData: [{ area: 176, duration: 0, heroDuration: 0, data: [120, 1] }],
  }),
};

let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, hp: 500, maxHp: 500, x: 0, y: 0, buffs: [], abilities: [],
    weapons: [], inventory: [], flying: false, building: null, mechanical: false, isHero: false,
    invulnerable: false, neutralPassive: false, magicImmune: false, race: "undead", summonLeft: 0,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}

const abom = unit({ team: 0, x: 0, y: 0, abilities: [{ id: "Aap1", code: "Aapl", level: 1 }] });
const nearFoe = unit({ team: 1, x: 100, y: 0 });
const farFoe = unit({ team: 1, x: 600, y: 0 });
const ally = unit({ team: 0, x: 100, y: 0 });
const flyer = unit({ team: 1, x: 120, y: 0, flying: true });
const golem = unit({ team: 1, x: 120, y: 0, mechanical: true });
const dryad = unit({ team: 1, x: 120, y: 0, magicImmune: true });

world.applyAuras();

const plague = (u) => u.buffs.filter((b) => b.group === "Aapl:dot").map((b) => [b.value, b.timeLeft]);
check("an enemy inside the cloud catches it, at dataB dps", plague(nearFoe), [[1, 120]]);
check("…for dataA seconds, not the aura refresh tick", plague(nearFoe)[0][1], 120);
check("an enemy outside the radius does not", plague(farFoe), []);
check("the Abomination's OWN side does not", plague(ally), []);
check("a flyer does not — targs1 says ground", plague(flyer), []);
check("a mechanical unit does not — targs1 says organic", plague(golem), []);
check("a magic-immune unit does not", plague(dryad), []);
check("…and the Abomination does not infect itself", plague(abom), []);

// Endurance Aura (`AOae`; `SCae` and the `AIae` item share the code) — two columns, not one:
// DataA "Movement Speed Increase (%)" and DataB "Attack Speed Increase (%)". The real rows are
// 0.10/0.20/0.30 and 0.05/0.10/0.15; the attack half used to be read off DataA (issue #288).
{
  const { AURA_BUFFS } = require(join(REPO, ".sim-build", "src", "sim", "spells.js"));
  const at = (move, attack) => AURA_BUFFS.AOae({ data: [move, attack] }).map((b) => [b.kind, b.value, b.value2]);
  check("Endurance rank 1: +10% move, +5% attack", at(0.1, 0.05), [["haste", 0.1, 0.05]]);
  check("Endurance rank 3: +30% move, +15% attack", at(0.3, 0.15), [["haste", 0.3, 0.15]]);
}

// MiscGame's six `*BestowAuras` switches, all 0 (issue #361): a source in one of those states
// carries its aura and hands it to nobody.
{
  const states = [
    ["an ILLUSION", { isIllusion: true }],
    ["an INVISIBLE unit", { invisible: true }],
    ["a HEXED unit", { hexed: true }],
    ["an ANIMATED corpse", { raisedBy: "AUan" }],
    ["a FLYING hero", { isHero: true, flying: true }],
  ];
  for (const [what, over] of states) {
    for (const u of [...world.units.values()]) world.units.delete(u.id);
    const src = unit({ team: 0, x: 0, y: 0, abilities: [{ id: "Aap1", code: "Aapl", level: 1 }], ...over });
    const foe = unit({ team: 1, x: 100, y: 0 });
    world.applyAuras();
    check(`${what} bestows no aura`, plague(foe), []);
    void src;
  }
  // …and a flying unit that is NOT a hero still does (the switch names heroes).
  for (const u of [...world.units.values()]) world.units.delete(u.id);
  unit({ team: 0, x: 0, y: 0, flying: true, abilities: [{ id: "Aap1", code: "Aapl", level: 1 }] });
  const foe = unit({ team: 1, x: 100, y: 0 });
  world.applyAuras();
  check("a flying NON-hero still bestows it", plague(foe).length, 1);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
