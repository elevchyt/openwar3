// Headless check of the ARMOUR OF A BUILDING THAT IS STILL GOING UP.
//
// A construction site is not a weakly-armoured building — it has no armour at all, on both
// axes at once, and the two halves are enforced in two different places (recomputeStats zeroes
// the VALUE, applyDamage drops the CLASS), so it is worth pinning that they agree:
//   • armour value 0 — the type's own `def1` does not apply, and neither does anything laid on
//     top of it (an upgrade, an aura, an item);
//   • no armour CLASS — the site is neither Fortified nor Unarmored, so nothing in the damage
//     table applies and every attack type lands undivided. Both directions matter: Siege does
//     NOT get its ×1.5 against the foundation of a Fortified building, and Piercing is NOT cut
//     to ×0.35 by it either.
// Observed in the real client (see also the r/warcraft3 "what are the armor of building that
// under construction" thread the behaviour is written up in).
//
// The numbers below are the real 1.30.4 ones from Units\MiscGame.txt:
//   DamageBonusSiege  = 1.00,0.50,1.00,1.50,1.00,0.50,0.05,1.50   (Small,Medium,Large,Fort,…)
//   DamageBonusPierce = 2.00,0.75,1.00,0.35,1.00,0.50,0.05,1.50
//   DefenseArmor      = 0.06   → reduction = 0.06·armor / (1 + 0.06·armor)
//
// A structure UPGRADING in place is the counter-case and is checked too: a Town Hall becoming a
// Keep keeps the finished building's armour, because an upgrade is a queue job rather than
// construction and carries no `constructionLeft`.
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
const round = (n) => Math.round(n * 1000) / 1000;

function world() {
  const w = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
  w.rng = () => 0.5;
  return w;
}

let nextId = 1;
/** A Fortified building with 5 armour — a Human Barracks' shape, not its exact row. */
function barracks(w, over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, x: 100, y: 100, hp: 1500, maxHp: 1500, mana: 0, maxMana: 0,
    baseMaxHp: 1500, baseMaxMana: 0, baseArmor: 5, armor: 5, bonusArmor: 0, armorType: "fort",
    baseSpeed: 0, speed: 0, hpRegen: 0, manaRegen: 0, lifesteal: 0, thorns: 0, hp0: 0,
    buffs: [], abilities: [], inventory: [], weapons: [], garrison: [], orderQueue: [],
    isHero: false, isSummon: false, isIllusion: false, mechanical: false, flying: false,
    invulnerable: false, neutralPassive: false, cloaked: false, level: 1, race: "human",
    typeId: "hbar", constructing: 0, inMine: false, resId: 0, devouring: 0, devouredBy: 0,
    garrisonHost: 0, linkShare: 0, linkT: 0, linkGroup: [], rangedReduction: 0, ethereal: false,
    building: { constructionLeft: 0, buildTimeTotal: 60, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0, producesUnits: true },
    ...over,
  };
  w.units.set(u.id, u);
  return u;
}
/** The same building, still a foundation: `constructionLeft` is the whole difference. */
function raising(w, over = {}) {
  const b = barracks(w, over);
  b.building.constructionLeft = 30;
  return b;
}

console.log("\nThe armour VALUE is 0 while the site is being raised");
{
  const w = world();
  const b = raising(w);
  // A Devotion Aura standing over the site, and Masonry researched: neither reaches it.
  b.buffs.push({ kind: "armor", group: "devotion", timeLeft: Infinity, sourceId: 0, value: 3 });
  w.recomputeStats(b);
  check("a half-built Barracks has 0 armour", b.armor, 0);
  check("…and no green bonus either (an aura does not armour a scaffold)", b.bonusArmor, 0);
  // …and it comes back the moment the building is finished, with the aura on top.
  b.building.constructionLeft = 0;
  w.recomputeStats(b);
  check("the finished Barracks has its own armour back", b.armor, 8);
  check("…with the aura's +3 as the bonus portion", b.bonusArmor, 3);
}

console.log("\nA site has no armour CLASS: every attack type lands undivided");
{
  // Siege vs Fortified is ×1.5 and armour 5 cuts 23.08% — the finished building takes
  // 100 × 1.5 × (1 − 0.3/1.3) = 115.385. The site takes the raw 100.
  const w = world();
  const site = raising(w);
  const done = barracks(w);
  w.recomputeStats(site);
  w.recomputeStats(done);
  check("SIEGE on a site: flat 100, no ×1.5", round(w.applyDamage(site, 100, 0, "siege")), 100);
  check("SIEGE on the finished building: ×1.5, then armour", round(w.applyDamage(done, 100, 0, "siege")), 115.385);
}
{
  // …and the same rule the other way round. Piercing vs Fortified is ×0.35: an Archer shooting
  // a foundation does her FULL damage, which is the half of this that helps the attacker.
  const w = world();
  const site = raising(w);
  const done = barracks(w);
  w.recomputeStats(site);
  w.recomputeStats(done);
  check("PIERCE on a site: flat 100, no ×0.35", round(w.applyDamage(site, 100, 0, "pierce")), 100);
  check("PIERCE on the finished building: ×0.35, then armour", round(w.applyDamage(done, 100, 0, "pierce")), 26.923);
}

console.log("\nA building UPGRADING in place keeps the armour it already has");
{
  // Town Hall → Keep: `enqueueUpgrade` puts a job in the queue and leaves constructionLeft at
  // 0, so the hall defends as a hall for the whole upgrade.
  const w = world();
  const hall = barracks(w, { typeId: "htow" });
  w.enqueueUpgrade(hall.id, "hkee", 140);
  w.recomputeStats(hall);
  check("it is upgrading", w.isUpgrading(hall.id), true);
  check("…and is not under construction", w.isUnderConstruction(hall.id), false);
  check("…so it keeps its 5 armour", hall.armor, 5);
  check("…and Siege still gets its ×1.5 against it", round(w.applyDamage(hall, 100, 0, "siege")), 115.385);
}

console.log(failed ? `\n${failed} FAILED\n` : "\nall ok\n");
process.exit(failed ? 1 : 0);
