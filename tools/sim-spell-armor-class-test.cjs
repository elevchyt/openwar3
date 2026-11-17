// Headless check that ABILITY damage is graded by the target's ARMOUR CLASS (issue #277).
//
// Units\MiscGame.txt: `DamageBonusSpells=1.00,1.00,1.00,1.00,1.00,0.70,0.05,1.00` — a Hero
// takes 0.70 of a spell and a Divine body 0.05. The row was in gameplayConstants.ts and was
// only ever applied to a WEAPON whose attack type is Spells: `spellDamage` went straight to
// `landDamage`, so a rank-1 Storm Bolt took 100 off a hero instead of 70.
//
// The Hero cell is one of the few the data sets disagree on: 0.75 in `Custom_V1\` and in
// Reign of Chaos (docs/editions.md), which is why this goes through `damageTable()`.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { setEdition, setMapDataSet } = require(join(REPO, ".sim-build", "src", "data", "edition.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

function world() {
  const W = 64, H = 64;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  w.abilities = { get: () => undefined, all: () => [] };
  return w;
}

let nextId = 1;
function add(w, over) {
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
    hp: 5000, maxHp: 5000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 0.6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: null, weapons: [], oldWeapons: [],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    ...over,
  });
  u.x = over.x ?? 0;
  u.y = over.y ?? 0;
  return u;
}

/** What a 100-point spell takes off a body of `armorType` carrying `armor` points. */
function spell(armorType, armor = 0) {
  const w = world();
  const src = add(w, { owner: 1, team: 1, x: 300 });
  const t = add(w, { armorType, armor });
  w.recomputeStats(t);
  const before = t.hp;
  w.spellApi.spellDamage(t, 100, src.id);
  return Math.round((before - t.hp) * 100) / 100;
}

setEdition("tft");
setMapDataSet("melee");
check("a spell lands whole on Medium armour", spell("medium"), 100);
for (const a of ["small", "large", "fort", "normal", "none"]) check(`…and on ${a}`, spell(a), 100);
check("a HERO takes 0.70 of it — Storm Bolt rank 1 is 70", spell("hero"), 70);
check("DIVINE armour takes 0.05", spell("divine"), 5);
check("the armour VALUE is still not paid: a hero with 10 armour takes the same 70", spell("hero", 10), 70);

// The dot is ability damage too: 10 a second for one second on a hero is 7.
{
  const w = world();
  const src = add(w, { owner: 1, team: 1, x: 300 });
  const hero = add(w, { armorType: "hero" });
  const foot = add(w, { armorType: "medium", x: 100 });
  for (const t of [hero, foot]) w.spellApi.applyBuff(t, { kind: "dot", group: "test", timeLeft: 1, value: 10, sourceId: src.id });
  for (let i = 0; i < 40; i++) w.tick(0.05);
  check("a dot bites a hero at 0.70 and a Footman whole", [Math.round(5000 - hero.hp), Math.round(5000 - foot.hp)], [7, 10]);
}

setMapDataSet("custom");
check("a CUSTOM map's Hero cell is 0.75 (Custom_V1\\Units\\MiscGame.txt)", spell("hero"), 75);
setMapDataSet("melee");
setEdition("roc");
check("…and so is Reign of Chaos's (Melee_V0)", spell("hero"), 75);
setEdition("tft");

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
