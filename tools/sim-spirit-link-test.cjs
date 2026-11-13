// Headless check that a DISPEL ends Spirit Link for the unit it lands on. The link is the
// `[Bspl]` buff the cast hangs on every member (spells.ts Aspl, SPIRIT_LINK_GROUP): take it off
// one member — Dispel Magic, Purge, Abolish Magic, a Wand of Negation — and that member stops
// sharing, in both directions, while the rest of the group stays linked among themselves.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${ok ? "" : `  want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};
const W = 64;
const w = new SimWorld(new PathingGrid({ width: W, height: W, flags: new Uint8Array(W * W) }, [0, 0]), 1);
const add = (id, x) => w.add({
  id, owner: 0, team: 0, typeId: "ogru", x, y: 1000, facing: 0,
  hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
  speed: 270, turnRate: 6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
  sightDay: 1800, sightNight: 1800, flying: false, mechanical: false, invulnerable: false,
  race: "orc", isBuilding: false, foodCost: 1, goldCost: 0, lumberCost: 0, upgrades: [],
  moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground", deathTime: 2,
  name: "Grunt", worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
  weapons: [], oldWeapons: [],
});
const [a, b, c] = [add(1, 1000), add(2, 1100), add(3, 1200)];
const ids = [a.id, b.id, c.id];
for (const u of [a, b, c]) {
  // What spells.ts Aspl leaves on every member: the link state and the buff that IS it.
  u.linkGroup = [...ids]; u.linkT = 75; u.linkShare = 0.5;
  u.buffs.push({ kind: "mark", group: "spiritlink", timeLeft: 75, total: 75, sourceId: a.id, value: 0, value2: 0, art: "", fx: [], buffId: "Bspl", delay: 0 });
}
const tick = () => w.tick(1 / 60);
tick();
check("linked, all three keep their link through a tick", [a, b, c].map((u) => u.linkT > 0), [true, true, true]);

// 90 damage on A: half is shared, 15 to each of the three.
const kept = w.spiritLinkSplit(a, 90);
check("a blow is spread over all three", [kept, b.hp, c.hp], [60, 985, 985]);

console.log("Dispel Magic on B");
w.spellApi.dispel(b);
tick();
check("B's buff is gone", b.buffs.some((x) => x.group === "spiritlink"), false);
check("…and so is its link", [b.linkT, b.linkGroup], [0, []]);
check("…and A and C no longer count it", [a.linkGroup, c.linkGroup], [[a.id, c.id], [a.id, c.id]]);
const bBefore = b.hp, cBefore = c.hp;
const kept2 = w.spiritLinkSplit(a, 90);
check("a blow on A is spread over A and C only", [kept2, b.hp, c.hp - cBefore], [67.5, bBefore, -22.5]);
check("a blow on B is all B's", w.spiritLinkSplit(b, 90), 90);

console.log("Purge on C as well leaves A alone");
w.spellApi.dispel(c);
tick();
check("A is linked to nobody it can share with", w.spiritLinkSplit(a, 90), 90);

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
