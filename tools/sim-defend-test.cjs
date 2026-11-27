// DEFEND slows a Footman BY its DataC, not TO it (issue #353).
//
// `Units\HumanAbilityStrings.txt [Adef]` Ubertip, 1.30.4: "While Defend is active, move speed is
// reduced by <Adef,DataC1,%>%." — and `AbilityData.slk` Adef DataC1 ("Movement Speed Factor") is
// 0.3. So a 270-speed Footman defends at 189. Read the other way round he computed 81, which
// `MinUnitSpeed` (150) then floored — a Footman that crawled.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const DEFEND = {
  id: "Adef", code: "Adef", target: "none", targetFlags: [],
  buffFx: [], buffArt: "", targetArt: "", casterArt: "", specialArt: "", effectArt: "", areaArt: "", missileArt: "", lightning: [],
  levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: [0.35, 1, 0.3, 0, 1, 30], buffs: [], summon: "" }],
};

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const W = 64, H = 64;
const w = new SimWorld(new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]), 1);
w.abilities = { get: (id) => (id === "Adef" ? DEFEND : undefined), all: () => [DEFEND], buffFx: () => [] };
const footman = w.add({
  id: 1, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
  hp: 420, maxHp: 420, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
  speed: 270, turnRate: 100, radius: 16, scale: 1, armor: 2, armorType: "heavy", defUp: 0,
  weapons: [], oldWeapons: [], sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
  castPoint: 0, castBackswing: 0, flying: false, mechanical: false, invulnerable: false, race: "human",
  isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0, abilities: [], upgrades: [], moveType: "foot",
  collisionSize: 16, canFlee: false, targetedAs: "ground", deathTime: 2, name: "Footman",
  worker: null, depotGold: false, depotLumber: false,
});
footman.abilities = [{ id: "Adef", code: "Adef", level: 1, cooldownLeft: 0, autocastOn: false }];
w.recomputeStats(footman);
check("a Footman walks at his 270", Math.round(footman.speed), 270);
footman.abilities[0].autocastOn = true; // Defend is a toggle: on is the stance
w.recomputeStats(footman);
check("…and DEFENDING at 30% less — 189, not 81 floored to 150", Math.round(footman.speed), 189);
footman.abilities[0].autocastOn = false;
w.recomputeStats(footman);
check("…and back at 270 when he lowers the shield", Math.round(footman.speed), 270);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
