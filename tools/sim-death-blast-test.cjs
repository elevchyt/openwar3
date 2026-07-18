// Headless check of `Adda` ("AOE damage upon death") — the Goblin Land Mine and Sapper
// blast, and above all that a CHAIN of them terminates.
//
// Rings come from the columns every death blast shares (AbilityMetaData Dda1..Dda4):
// dataA full radius, dataB full amount, dataC partial radius, dataD partial amount.
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

/** A world whose ability registry answers with one `Adda` def (100/200/300/50). */
function makeWorld() {
  const world = new SimWorld({ width: 4, height: 4, cell: 128, blocked: new Uint8Array(16) }, 1);
  world.abilities = { get: () => ({ levelData: [{ data: [100, 200, 300, 50] }] }) };
  return world;
}

let nextId = 1;
function unit(world, over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, hp: 500, maxHp: 500, mana: 0, maxMana: 0, x: 0, y: 0,
    buffs: [], abilities: [], inventory: [], weapons: [], garrison: [], flying: false,
    building: null, mechanical: false, isHero: false, isIllusion: false, invulnerable: false,
    neutralPassive: false, ethereal: false, thorns: 0, summonLeft: 0, constructing: null,
    inMine: false, resId: 0, typeId: "nmin", level: 1, race: "other",
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const mine = (world, x, hp) => unit(world, { x, hp, abilities: [{ id: "Adda", code: "Adda", level: 1 }] });

// A single mine: full damage inside 100, partial between 100 and 300, nothing beyond.
{
  const w = makeWorld();
  const m = mine(w, 0, 1);
  const near = unit(w, { x: 50 });
  const far = unit(w, { x: 250 });
  const away = unit(w, { x: 900 });
  w.kill(m);
  check("inside the full radius takes dataB", 500 - near.hp, 200);
  check("inside the partial radius takes dataD", 500 - far.hp, 50);
  check("beyond both takes nothing", 500 - away.hp, 0);
}

// A chain: three mines in a row, each inside the next one's full radius. This must
// terminate — and it is the case that would loop forever without the guards, because the
// blast can otherwise re-kill a unit that is already dead and set it off again.
{
  const w = makeWorld();
  // Each mine must be frail enough that its neighbour's blast kills it — that is what a
  // chain IS. At 500 hp a 200-damage blast just dents them and nothing propagates.
  const a = mine(w, 0, 1);
  mine(w, 60, 150);
  mine(w, 120, 150);
  const bystander = unit(w, { x: 150, hp: 5000, maxHp: 5000 });
  w.kill(a); // if this returns at all, the chain terminated
  check("a chain of mines terminates", true, true);
  // The bystander at x=150 is caught by all three: partial from the mine at 0 (distance
  // 150), then full from the mines at 60 and 120 as the chain walks toward it.
  check("…and every mine in it went off (the bystander took three blasts)", 5000 - bystander.hp, 50 + 200 + 200);
}

// A unit with no `Adda` ability does not explode.
{
  const w = makeWorld();
  const plain = unit(w, { x: 0, hp: 1 });
  const near = unit(w, { x: 50 });
  w.kill(plain);
  check("a unit without the ability does not blast", 500 - near.hp, 0);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
