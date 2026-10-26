// A FINISHED MOVE IS A STOP — and that includes a move that has got as far as the CROWD on its
// goal (world.ts `holdOrGiveUp`, `CROWD_ARRIVE`).
//
// In the game a unit that has carried out a move stands on the plain stopped order, and a group
// sent to one point stops in a blob AROUND it. Here the outer ring of such a blob used to PARK
// instead — still carrying the move, re-pathing every few seconds for the cell in the middle —
// and a move is the one order that switches both auto-acquire and autocast off, so a Priest at
// the edge of an army mustered on a rally point stood beside the wounded and never healed them.
// The developer's: "move commands turn to simple stop command (the default command when a unit
// is stopped) in the original game".
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "UnitData.slk"))) {
  console.log("skip  no extracted game data (run `pnpm data:extract`)");
  process.exit(0);
}
const vfs = {
  label: "ExtractedData",
  rawBytes(p) {
    let dir = EXTRACT;
    for (const part of p.split("\\")) {
      const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase());
      if (!hit) return null;
      dir = join(dir, hit);
    }
    return new Uint8Array(fs.readFileSync(dir));
  },
  exists: () => false,
  list: () => [],
};
const ABILITIES = loadAbilityRegistry(vfs);
const UNITS = loadUnitRegistry(vfs);

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// A 200x200-cell field of open ground (32 world units a cell, origin 0,0).
const W = 200, H = 200;
function world() {
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  return new SimWorld(grid, 1, ABILITIES, undefined, UNITS);
}
let nextId = 1;
function spawn(w, typeId, x, y, owner, team) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  return w.add(
    {
      id: nextId++, owner, team, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying: false, flyHeight: 0,
      sightDay: def.sightDay || 1400, sightNight: def.sightNight || 800,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: "ground", moveType: def.moveType,
      worker: null, depotGold: false, depotLumber: false,
    },
    null,
    { abilities: [], level: def.level, isPeon: def.classification.includes("peon") },
  );
}
function run(w, seconds) {
  for (let i = 0; i < seconds * 20; i++) w.tick(0.05);
}


console.log("a group sent to one point all STOP there");
{
  const w = world();
  const GOAL = { x: 3200, y: 3200 };
  const group = [];
  for (let i = 0; i < 18; i++) group.push(spawn(w, "hfoo", 1600 + (i % 6) * 64, 1600 + Math.floor(i / 6) * 64, 0, 0));
  for (const u of group) w.issueMove(u.id, GOAL.x, GOAL.y, false);
  run(w, 30);
  check("every Footman has arrived", group.every((u) => Math.hypot(u.x - GOAL.x, u.y - GOAL.y) < 400), true);
  check("…and not one is still on its move", group.filter((u) => u.order !== "idle").length, 0);
}

console.log("\n…which is what lets a Priest at the edge of the blob HEAL");
{
  const w = world();
  const GOAL = { x: 3200, y: 3200 };
  const group = [];
  for (let i = 0; i < 16; i++) group.push(spawn(w, "hfoo", 1600 + (i % 4) * 64, 1600 + Math.floor(i / 4) * 64, 0, 0));
  const priest = spawn(w, "hmpr", 1500, 1500, 0, 0);
  priest.abilities = [{ id: "Ahea", code: "Ahea", level: 1, cooldownLeft: 0, autocastOn: true }];
  for (const u of [...group, priest]) w.issueMove(u.id, GOAL.x, GOAL.y, false);
  run(w, 30);
  // Wound the Footman standing nearest the Priest, wherever the blob put them both.
  const hurt = group.reduce((a, b) => (Math.hypot(a.x - priest.x, a.y - priest.y) <= Math.hypot(b.x - priest.x, b.y - priest.y) ? a : b));
  hurt.hp = hurt.maxHp - 200;
  run(w, 6);
  check("the Priest is standing, not walking", priest.order === "idle" || priest.order === "cast", true);
  check("…and heals the Footman beside him", hurt.hp > hurt.maxHp - 200, true);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
