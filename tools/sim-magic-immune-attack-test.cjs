// Headless check that a MAGIC-type attack has nothing to strike a magic-immune unit with
// (Units\MiscGame.txt `MagicImmunesResistDamage=1`): a Chimaera never picks a Dryad, an ordered
// attack on one is refused, a blow already in the air lands for 0, and a unit with a second
// weapon of another type falls through to it (SimWorld.weaponVs / applyDamage).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
const check = (what, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${ok ? "" : `  want ${want}, got ${got}`}`);
};
const W = 64;
const weapon = (attackType, over = {}) => ({
  enabled: true, targets: ["ground", "air", "structure"], ranged: false,
  damage: 50, baseDamage: 50, dice: 1, baseDice: 1, sides: 1,
  cooldown: 1, baseCooldown: 1, range: 120, baseRange: 120, rangeBuffer: 250,
  damagePoint: 0.1, baseDamagePoint: 0.1, backswing: 0.1, baseBackswing: 0.1,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 600, attackType, missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0, ...over,
});
function addUnit(w, id, owner, x, y, weapons) {
  return w.add({
    id, owner, team: owner, typeId: "unit", x, y, facing: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    sightDay: 1800, sightNight: 1800, flying: false, mechanical: false, invulnerable: false,
    race: "human", isBuilding: false, foodCost: 1, goldCost: 0, lumberCost: 0, upgrades: [],
    moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground", deathTime: 2,
    name: "u", worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    weapons, oldWeapons: weapons,
  });
}
const immune = (u) => {
  u.buffs.push({ kind: "magicImmune", group: "Bams", timeLeft: 999, total: 999, sourceId: 0, value: 0, value2: 0, art: "", fx: [], buffId: "", delay: 0 });
};
const run = (w, s) => { for (let i = 0; i < Math.round(s * 60); i++) w.tick(1 / 60); };
const grid = () => new PathingGrid({ width: W, height: W, flags: new Uint8Array(W * W) }, [0, 0]);

console.log("a magic weapon and a magic-immune target");
{
  const w = new SimWorld(grid(), 1);
  const chim = addUnit(w, 1, 0, 1000, 1000, [weapon("magic")]);
  const dryad = addUnit(w, 2, 1, 1100, 1000, [weapon("pierce")]);
  dryad.weapons = []; dryad.weapon = null; // a target that does not fight back
  immune(dryad);
  run(w, 0.1);
  check("the dryad is magic immune", dryad.magicImmune, true);
  check("an ordered attack is refused", w.issueAttack(chim.id, dryad.id, false, true), false);
  run(w, 3);
  check("it never auto-acquires her", chim.targetId === dryad.id, false);
  check("…and she takes nothing", dryad.hp, 1000);
}

console.log("a NORMAL weapon still hits her");
{
  const w = new SimWorld(grid(), 1);
  const foot = addUnit(w, 1, 0, 1000, 1000, [weapon("normal")]);
  const dryad = addUnit(w, 2, 1, 1100, 1000, []);
  immune(dryad);
  run(w, 0.1);
  check("the attack is taken", w.issueAttack(foot.id, dryad.id, false, true), true);
  run(w, 3);
  check("…and lands", dryad.hp < 1000, true);
}

console.log("a second weapon of another type is used instead");
{
  const w = new SimWorld(grid(), 1);
  const two = addUnit(w, 1, 0, 1000, 1000, [weapon("magic"), weapon("normal")]);
  const dryad = addUnit(w, 2, 1, 1100, 1000, []);
  immune(dryad);
  run(w, 0.1);
  check("the attack is taken", w.issueAttack(two.id, dryad.id, false, true), true);
  run(w, 3);
  check("…and lands", dryad.hp < 1000, true);
}

console.log("immunity that lands mid-fight stops the fight");
{
  const w = new SimWorld(grid(), 1);
  const chim = addUnit(w, 1, 0, 1000, 1000, [weapon("magic")]);
  const target = addUnit(w, 2, 1, 1100, 1000, []);
  w.issueAttack(chim.id, target.id, false, true);
  run(w, 2);
  const hit = target.hp;
  check("it was being hit", hit < 1000, true);
  immune(target);
  run(w, 3);
  check("…and is not once it is immune", target.hp, hit);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
