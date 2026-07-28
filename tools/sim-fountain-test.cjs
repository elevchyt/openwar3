// Headless check of the SIDELESS aura — the two Fountains — and of the runes' area.
//
// A Fountain of Health (`nfoh`) carries `Avul,ACnr` and a Fountain of Mana (`nmoo`)
// `Avul,ANre` (Units\UnitAbilities.slk), and those rows' base codes are `Aoar` and `Aarm`:
// ordinary regeneration auras, 1% of the target's MAXIMUM per second inside 500 (DataA 0.01,
// DataB "Percentage" 1). A fountain is nothing but a building standing inside one.
//
// The part that is easy to get wrong is the SIDE. `targs1` for both is
// `ground,air,organic,vuln,invu` — it names neither `friend` nor `enemy`, and a fountain
// really does restore whoever stands in it, the enemy army included. `organic` is the one
// restriction, which is the description's own wording ("all non-mechanical units nearby").
//
// The runes are the same shape one step along: `AIha`/`AImr`/`AIra` each carry `Area1 = 600`
// and `targs1 = ground,air,friend,self,organic,vuln,invu`, and their `comments` column reads
// "ItemHealAoe" / "ItemManaRestoreAoe" / "ItemRestoreAoe". A rune is the squad's, not the
// picker's.
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

const world = new SimWorld({ width: 16, height: 16, cell: 128, blocked: new Uint8Array(256) }, 1);

// The two real rows, keyed by the alias a unit actually lists.
const ROWS = {
  // Fountain of Health — Units\AbilityData.slk [ACnr] code Aoar
  ACnr: { targetFlags: ["ground", "air", "organic", "vuln", "invu"], levelData: [{ area: 500, duration: 0, heroDuration: 0, data: [0.01, 1] }] },
  // Fountain of Mana — [ANre] code Aarm
  ANre: { targetFlags: ["ground", "air", "organic", "vuln", "invu"], levelData: [{ area: 500, duration: 0, heroDuration: 0, data: [0.01, 1] }] },
};
world.abilities = { get: (id) => ROWS[id], buffFx: () => [] };

let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, hp: 500, maxHp: 500, mana: 0, maxMana: 0, x: 0, y: 0, radius: 16,
    buffs: [], abilities: [], weapons: [], inventory: [], flying: false, building: null,
    mechanical: false, isHero: false, invulnerable: false, neutralPassive: false,
    magicImmune: false, race: "other", summonLeft: 0, ...over,
  };
  world.units.set(u.id, u);
  return u;
}

// --- the Fountain of Health -------------------------------------------------------------
// Neutral Passive (player 15), as every fountain on every map is, on its own team.
const fountain = unit({ owner: -1, team: -2, neutralPassive: true, building: {}, x: 0, y: 0, abilities: [{ id: "ACnr", code: "Aoar", level: 1 }] });
const mine = unit({ team: 0, x: 100, y: 0, maxHp: 245 });
const theirs = unit({ team: 1, x: 100, y: 0, maxHp: 1000 });
const golem = unit({ team: 1, x: 100, y: 0, mechanical: true });
const flyer = unit({ team: 0, x: 100, y: 0, flying: true, maxHp: 700 });
const outside = unit({ team: 0, x: 900, y: 0 });

world.applyAuras();

const regen = (u) => u.buffs.filter((b) => b.group === "Aoar:hpRegen").map((b) => b.value);
check("a fountain restores my units", regen(mine), [2.45]);
check("…1% of the TARGET's own maximum per second, not a flat amount", regen(theirs), [10]);
check("…the ENEMY's too — its targs1 names no side, and that is the point of a fountain", regen(theirs).length, 1);
check("…and a flyer, which targs1 does list", regen(flyer), [7]);
check("a mechanical unit gets nothing — targs1 says organic", regen(golem), []);
check("nor does anything past the 500 radius", regen(outside), []);

// --- the Fountain of Mana ---------------------------------------------------------------
for (const u of world.units.values()) u.buffs = [];
fountain.abilities = [{ id: "ANre", code: "Aarm", level: 1 }];
const caster = unit({ team: 0, x: 100, y: 0, maxMana: 300 });
world.applyAuras();
const manaRegen = (u) => u.buffs.filter((b) => b.group === "Aarm:manaRegen").map((b) => b.value);
check("a mana fountain restores 1% of max mana per second", manaRegen(caster), [3]);
check("…and nothing at all to a unit with no pool", manaRegen(mine), []);

// --- the runes ---------------------------------------------------------------------------
// applyPowerup is private; reach it the way pickUpItem does, through the item registry.
for (const u of world.units.values()) u.buffs = [];
world.abilities = {
  get: () => ({
    code: "AIra", // Rune of Restoration
    targetFlags: ["ground", "air", "friend", "self", "organic", "vuln", "invu"],
    levelData: [{ area: 600, duration: 0, heroDuration: 0, data: [300, 150] }],
    targetArt: "", casterArt: "", effectSound: "",
  }),
  buffFx: () => [],
};
world.itemReg = { get: () => ({ powerup: true, abilities: ["AIra"], charges: 0, perishable: false, cooldownGroup: "", usable: false }) };
// applyPowerup ends in recomputeStats, which reads the unit registry; this world has none.
world.unitReg = { get: () => undefined };

const picker = unit({ team: 0, x: 0, y: 0, hp: 100, maxHp: 1000, mana: 0, maxMana: 400 });
const squadMate = unit({ team: 0, x: 300, y: 0, hp: 100, maxHp: 1000, mana: 0, maxMana: 400 });
const farMate = unit({ team: 0, x: 1200, y: 0, hp: 100, maxHp: 1000, mana: 0, maxMana: 400 });
const enemyNear = unit({ team: 1, x: 200, y: 0, hp: 100, maxHp: 1000, mana: 0, maxMana: 400 });
const mechMate = unit({ team: 0, x: 200, y: 0, hp: 100, maxHp: 1000, mechanical: true });

// Straight to `applyPowerup` rather than through a ground pickup: the item half of the path
// (spawn, walk, consume) is `sim-item-regen-test`'s, and spawning one needs a pathing grid
// this world has no reason to build. What is under test is who the powerup LANDS on.
// Read the picker's pools BEFORE the trailing recomputeStats, which reads a unit registry
// this bare world does not have.
const pickerBefore = (() => {
  const orig = world.recomputeStats;
  world.recomputeStats = () => {};
  try { world.applyPowerup(picker, world.itemReg.get("rrst")); } finally { world.recomputeStats = orig; }
  return [picker.hp, picker.mana];
})();

check("the rune restores the unit that took it", pickerBefore, [400, 150]);
check("…and every friendly unit inside its 600", [squadMate.hp, squadMate.mana], [400, 150]);
check("…but nothing outside it", [farMate.hp, farMate.mana], [100, 0]);
check("…nor the enemy standing next to you — targs1 says friend", [enemyNear.hp, enemyNear.mana], [100, 0]);
check("…nor a mechanical unit — targs1 says organic", mechMate.hp, 100);

console.log(failed ? `\nfountain/rune: ${failed} FAILED` : "\nfountain/rune: all checks passed");
process.exit(failed ? 1 : 0);
