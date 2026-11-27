// The unit events the engine raised for nothing until issue #376 (SimWorld.unitNews):
//   * EVENT_(PLAYER_)HERO_REVIVABLE when a player's hero falls, and REVIVE_START / _CANCEL /
//     _FINISH as an altar takes it up, lets it go, and hands it back under its own id;
//   * EVENT_UNIT_ACQUIRED_TARGET when a unit picks a target by itself, once per new target, and
//     EVENT_UNIT_TARGET_IN_RANGE when that target first comes inside its strike band;
//   * EVENT_(PLAYER_)UNIT_DETECTED when an invisible unit comes under an ENEMY team's true
//     sight, once per crossing, naming who did the seeing.
// The JASS half (Interpreter.pumpUnitNews) is tools/jass-native-stubs-test.cjs.
//
// Reads the install's own unit and ability tables. Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry, KNOWN_ABILITIES } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry, autoArmed } = require(join(REPO, ".sim-build", "src", "data", "units.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "AbilityData.slk"))) {
  console.log("skip  no extracted game data (run `pnpm data:extract`)");
  process.exit(0);
}
const vfs = {
  label: "ExtractedData",
  rawBytes(p) {
    const parts = p.split("\\");
    let dir = EXTRACT;
    for (const part of parts) {
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

const W = 512, H = 512; // 16384 x 16384 world units
function world() {
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  return new SimWorld(grid, 1, ABILITIES, undefined, UNITS);
}
let nextId = 1;
function spawn(w, typeId, x, y, owner, team, over = {}) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  const abilities = [];
  for (const id of def.abilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: autoArmed(def, id, a.code) });
  }
  const flying = def.moveType === "fly";
  return w.add(
    {
      id: nextId++, owner, team, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying, flyHeight: flying ? 200 : 0,
      sightDay: def.sightDay || 1400, sightNight: def.sightNight || 800,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: flying ? "air" : "ground", moveType: def.moveType,
      worker: null, depotGold: false, depotLumber: false,
    },
    // A structure carries building state — that is what makes it a building to the sim.
    def.isBuilding ? { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: def.goldCost, lumberCost: def.lumberCost, queue: [], rallyX: x, rallyY: y - 200, rallyKind: "none", rallyTargetId: 0, producesUnits: false } : null,
    { abilities, level: def.level, isPeon: def.classification.includes("peon"), ...over },
  );
}



const news = (w) => w.drainUnitNews().map((e) => [e.kind, e.unit.id, e.other ? e.other.id : null, e.player]);
const run = (w, secs) => { for (let t = 0; t < secs; t += 0.05) w.tick(0.05); };

console.log("acquiring a target, and the target coming into range");
{
  const w = world();
  w.captureAcquires = w.captureInRange = true;
  const foot = spawn(w, "hfoo", 1000, 1000, 0, 0);
  const grunt = spawn(w, "ogru", 1400, 1000, 1, 1);
  run(w, 1);
  const first = news(w);
  check("each picks the other, once", first.filter((e) => e[0] === "acquired").sort(), [["acquired", foot.id, grunt.id, 0], ["acquired", grunt.id, foot.id, 1]]);
  run(w, 3);
  const all = [...first, ...news(w)];
  check("…and each is in range of the other exactly once", all.filter((e) => e[0] === "inRange").map((e) => e[1]).sort(), [foot.id, grunt.id].sort());
  check("nothing is raised again while the fight goes on", all.filter((e) => e[0] === "acquired").length, 2);
  const w2 = world();
  const a = spawn(w2, "hfoo", 1000, 1000, 0, 0);
  spawn(w2, "ogru", 1400, 1000, 1, 1);
  run(w2, 2);
  check("with no script listening nothing is collected", w2.drainUnitNews().length, 0);
  check("…and the fight is the same fight", a.targetId !== null, true);
}

console.log("\nan invisible unit under an enemy team's true sight");
{
  const w = world();
  w.captureDetects = true;
  const s1 = spawn(w, "ushd", 5000, 5000, 2, 2);
  const s2 = spawn(w, "ushd", 5300, 5000, 3, 3);
  const mate = spawn(w, "ushd", 5100, 5100, 2, 2);
  run(w, 1);
  const ev = news(w);
  check("each Shade is detected by the other side, naming the detector's owner", ev.filter((e) => e[1] !== mate.id).sort(), [["detected", s1.id, null, 3], ["detected", s2.id, null, 2]].sort());
  check("a teammate's true sight is not a detection", ev.some((e) => e[1] === s1.id && e[3] === 2), false);
  run(w, 2);
  check("staying detected raises nothing more", news(w).filter((e) => e[1] !== mate.id).length, 0);
  s2.x = s2.prevX = 12000;
  run(w, 1);
  news(w);
  s2.x = s2.prevX = 5300;
  run(w, 1);
  check("walking out and back in is a new crossing", news(w).filter((e) => e[1] === s1.id), [["detected", s1.id, null, 3]]);
}

console.log("\na hero through the altar");
{
  const w = world();
  w.captureRevives = true;
  const hero = spawn(w, "Hpal", 2000, 2000, 0, 0, { hero: { properName: "Uther", level: 1, primaryAttr: "STR", str: 20, agi: 15, int: 15, strPerLevel: 2, agiPerLevel: 1, intPerLevel: 1 } });
  const altar = spawn(w, "halt", 2600, 2000, 0, 0);
  w.killUnit(hero.id);
  run(w, 0.25);
  check("a fallen hero is REVIVABLE", news(w), [["revivable", hero.id, null, 0]]);
  w.enqueueRevive(altar.id, hero.id, 10);
  check("queued at the altar: REVIVE_START", news(w), [["reviveStart", hero.id, null, 0]]);
  w.cancelTrainAt(altar.id, 0);
  check("taken off the queue: REVIVE_CANCEL", news(w), [["reviveCancel", hero.id, null, 0]]);
  w.enqueueRevive(altar.id, hero.id, 10);
  news(w);
  // The renderer brings the body back under the same id and tells the sim (noteTrainFinish).
  w.units.set(hero.id, hero);
  w.noteTrainFinish(altar.id, hero.id, true);
  check("standing again: REVIVE_FINISH, under its own id", news(w), [["reviveFinish", hero.id, null, 0]]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall unit-news checks passed");
process.exit(failed ? 1 : 0);
