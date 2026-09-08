// Headless checks on how a CREEP CAMP picks its fights and its targets — the rules every
// creeping guide teaches, with the install's own rows. Each block quotes its source; the sim
// code it exercises (SimWorld.threatTier / creepScore / bestCreepTarget / tickCreep) quotes
// the same lines. docs/creeps.md is the index.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef, CREEP_CAMP_ACQUIRE_RANGE } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry, KNOWN_ABILITIES } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry, autoArmed } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { CreepCaster } = require(join(REPO, ".sim-build", "src", "ai", "creeps.js"));

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
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

const W = 200, H = 200;
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
function creep(w, typeId, x, y, aggro) {
  const c = spawn(w, typeId, x, y, -1, -1);
  c.isCreep = true;
  c.guardX = c.x;
  c.guardY = c.y;
  c.guardFacing = c.facing;
  c.aggroRange = aggro ?? c.weapon?.acquire ?? 0;
  c.canSleep = false;
  return c;
}
const footman = (w, x, y) => spawn(w, "hfoo", x, y, 0, 0);
const buffOn = (u, kind) => u.buffs.some((b) => b.kind === kind);
const buffIdOn = (u, id) => u.buffs.some((b) => b.buffId && b.buffId.toLowerCase() === id.toLowerCase());
function run(w, caster, seconds) {
  for (let i = 0; i < seconds * 20; i++) {
    if (caster) caster.tick(0.05);
    w.tick(0.05);
  }
}
/** Hold a unit's health where it is, so a fight can be watched without anybody dying. */
function immortal(...units) {
  return () => { for (const u of units) u.hp = Math.max(u.hp, u.maxHp * 0.5); };
}
function runKeeping(w, caster, seconds, keep) {
  for (let i = 0; i < seconds * 20; i++) {
    if (caster) caster.tick(0.05);
    w.tick(0.05);
    keep();
  }
}

console.log("a Camp creep stirs at 200, a Normal one at its weapon's 500");
{
  // Wowpedia (Creep): "Creeps have a different auto-acquire range which is usually set at a
  // value of 500 or 200. The 200 value is frequently used as this prevents creeps from being
  // immediately hostile from a distance."
  check("the editor's Camp setting is 200", CREEP_CAMP_ACQUIRE_RANGE, 200);
  const w = world();
  const camp = creep(w, "ngno", 1000, 1000, CREEP_CAMP_ACQUIRE_RANGE);
  const f = footman(w, 1350, 1000); // 350 off — inside the Gnoll's own 500, outside Camp's 200
  run(w, null, 3);
  check("a Footman at 350 does not rouse a Camp creep", camp.order, "idle");
  const w2 = world();
  const normal = creep(w2, "ngno", 1000, 1000); // Normal: the Gnoll's acquire, 500
  footman(w2, 1350, 1000);
  run(w2, null, 3);
  check("…and does rouse a Normal one", normal.order, "attack");
}

console.log("\nthe threat ladder: the camp goes for what is ATTACKING it");
{
  // warcraft3.info 176: "Creeps will prioritize to attack units that are a threat to them…
  // issuing an attack with the attacked unit onto one of your other units. Your initial unit
  // will no longer be viewed as a threat and the creeps will therefore change their target."
  const w = world();
  const gnoll = creep(w, "ngno", 1000, 1000);
  const a = footman(w, 1120, 960);
  const b = footman(w, 1120, 1040);
  const decoy = footman(w, 1300, 1300);
  w.issueHold(b.id); // b stands by (an idle Footman would pick the fight up itself)
  w.issueAttack(a.id, gnoll.id, false, true);
  runKeeping(w, null, 3, immortal(gnoll, a, b, decoy));
  check("of two Footmen beside it, the Gnoll turns on the one attacking it", gnoll.targetId, a.id);
  // The guide's trick, to the letter: the attacked unit is told to attack one of its own…
  w.issueAttack(a.id, decoy.id, true, true);
  w.issueAttack(b.id, gnoll.id, false, true); // …and the other takes over the fight
  runKeeping(w, null, 3, immortal(gnoll, a, b, decoy));
  check("…and switches to the other when the roles swap", gnoll.targetId, b.id);
}

console.log("\n…and the drop STICKS past the cancel, which is the whole of how it is played");
{
  // The guide's own sequence: "issue an attack… onto one of your other units", then "let the
  // animation start for just a fraction of a second, then immediately move, issue a stop
  // command (S), or hold position (H) before your unit actually strikes your own target".
  // Read off the LIVE order, the drop lasted exactly as long as the player held the order and
  // the camp walked straight back the moment it was called off — and back it went to the same
  // weak unit, because the unit a camp is chewing on is the closest thing to it and the
  // half-second re-pick took the nearest of a rung. Both halves are fixed: the drop is
  // REMEMBERED (SimUnit.aggroDropped) and a re-pick is an UPGRADE, a strictly higher rung.
  const w = world();
  const gnoll = creep(w, "ngno", 1000, 1000);
  const a = footman(w, 1100, 1000); // the one being hit — and the NEAREST thing to the camp
  const b = footman(w, 1340, 1000); // further off, and never attacks: an ordinary armed unit
  const decoy = footman(w, 2600, 2600); // …and one right out of it, to point the trick at
  const keep = immortal(gnoll, a, b, decoy);
  w.issueHold(b.id);
  w.issueHold(decoy.id); // an idle Footman within reach would rally to the fight by itself
  w.issueAttack(a.id, gnoll.id, false, true);
  runKeeping(w, null, 3, keep);
  check("the Gnoll is on the Footman hitting it", gnoll.targetId, a.id);

  w.issueAttack(a.id, decoy.id, true, true); // A + click on one of our own
  runKeeping(w, null, 0.2, keep); // "let the animation start for a fraction of a second…"
  w.stop(a.id); // "…then immediately move, issue a stop command (S), or hold position (H)"
  runKeeping(w, null, 4, keep);
  check("the camp has changed target", gnoll.targetId, b.id);
  check("…to the one that never touched it", gnoll.targetId !== a.id, true);
  runKeeping(w, null, 6, keep);
  check("…and it does NOT come back, though the tricked unit is nearer", gnoll.targetId, b.id);
  check("…which is what the drop being remembered means", a.aggroDropped, true);

  // Sending it back in by hand is what ends the drop — a deliberate attack order, never a
  // swing the unit took by itself (see issueAttack): now it is the top rung again and the
  // camp, which only ever moves UP a rung, comes for it.
  w.issueAttack(a.id, gnoll.id, false, true);
  runKeeping(w, null, 4, keep);
  check("ordered back onto the camp, it is a threat again", a.aggroDropped, false);
  check("…and the camp comes for it", gnoll.targetId, a.id);
}

console.log("\na summon is worth hitting even when it is not fighting");
{
  // 176: "Creeps tend to prioritize summoned units with attacks (not spells like Purge) even
  // though they are not a threat, so the Water Elemental will soak up damage".
  const w = world();
  const gnoll = creep(w, "ngno", 1000, 1000);
  const f = footman(w, 1120, 960);
  const ele = spawn(w, "hwat", 1120, 1040, 0, 0);
  ele.isSummon = true;
  w.issueHold(ele.id); // "use the move-command and click a creep": there, and not attacking
  w.issueAttack(f.id, gnoll.id, false, true);
  runKeeping(w, null, 3, immortal(gnoll, f, ele));
  check("the Gnoll takes the idle Water Elemental over the Footman hitting it", gnoll.targetId, ele.id);
}

console.log("\na level 7+ creep goes for the lowest hit points in reach");
{
  // warcraft-gym: "Creeps lvl 7 or over always attack the lowest hitpoint unit in reach."
  // The Ogre Lord (`nogl`) is level 7.
  const w = world();
  const lord = creep(w, "nogl", 1000, 1000);
  check("the Ogre Lord is level 7", lord.level, 7);
  const healthy = footman(w, 1090, 970);
  const hurt = footman(w, 1090, 1030);
  hurt.hp = 120;
  w.issueAttack(healthy.id, lord.id, false, true); // the healthy one is the "threat"
  runKeeping(w, null, 3, () => { lord.hp = lord.maxHp; healthy.hp = healthy.maxHp; hurt.hp = 120; });
  check("…and it swings at the wounded Footman rather than the one attacking it", lord.targetId, hurt.id);
  const w2 = world();
  const gnoll = creep(w2, "ngno", 1000, 1000);
  const h2 = footman(w2, 1090, 970);
  const hurt2 = footman(w2, 1090, 1030);
  hurt2.hp = 120;
  w2.issueAttack(h2.id, gnoll.id, false, true);
  runKeeping(w2, null, 3, () => { gnoll.hp = gnoll.maxHp; h2.hp = h2.maxHp; hurt2.hp = 120; });
  check("a level 1 Gnoll in the same spot keeps to the ladder: the attacker", gnoll.targetId, h2.id);
}

console.log("\na resting camp ignores a flyer passing over, not one that stops");
{
  // Patch 1.10: "Creeps that are not in combat now ignore flying units… if you move flying
  // units around using 'move' instead of 'attack move', creeps will generally not attack them."
  // Wowpedia: "unless the unit stops directly above the creep camp".
  const w = world();
  const harpy = creep(w, "nhar", 1000, 1000); // ranged, hits air
  const gry = spawn(w, "hgry", 1300, 1000, 0, 0);
  check("the Gryphon is a flyer", gry.flying, true);
  w.issueMove(gry.id, 700, 1000); // straight over the harpy
  run(w, null, 1.5);
  check("the Harpy lets a moving Gryphon pass", harpy.order, "idle");
  run(w, null, 6);
  w.issueMove(gry.id, 1000, 1150);
  run(w, null, 6); // it arrives and stops over the camp
  check("…and turns on it once it has stopped overhead", harpy.targetId, gry.id);
}

console.log("\na poisoner spreads itself around before fighting like the rest");
{
  // Wowpedia: "Any creeps with the passive Envenomed Weapons or Slow Poison will prioritize
  // applying the status onto all hostile units in range before following normal creep
  // aggression"; 176: "they'll try to attack all your units once."
  const w = world();
  const nc = creep(w, "nmrm", 1000, 1000);
  const a = footman(w, 1100, 960);
  const b = footman(w, 1100, 1040);
  const c = footman(w, 1100, 1120);
  w.issueAttack(a.id, nc.id, false, true);
  runKeeping(w, null, 12, immortal(nc, a, b, c));
  check("all three Footmen carry the Nightcrawler's poison", [a, b, c].every((f) => f.buffs.some((x) => x.kind === "dot" && x.sourceId === nc.id)), true);
}

console.log("\na creep breaks off a tower below 60% of its own health");
{
  // Wowpedia: "They are very aggressive with buildings, but will retreat from defensive
  // towers if they fall below 60% health."
  const w = world();
  const gnoll = creep(w, "ngno", 1000, 1000);
  const tower = spawn(w, "hgtw", 1500, 1000, 0, 0);
  w.issueAttack(gnoll.id, tower.id);
  run(w, null, 3);
  check("the Gnoll is on the Guard Tower", gnoll.targetId, tower.id);
  gnoll.hp = gnoll.maxHp * 0.5;
  run(w, null, 1);
  check("…and leaves it once under 60%", gnoll.returning, true);
  run(w, null, 3);
  check("…walking home under its fire rather than turning back on it", gnoll.returning || gnoll.order !== "attack", true);
}

console.log("\nHurl Boulder and Slam exist, under their own codes");
{
  const w = world();
  const caster = new CreepCaster(w, ABILITIES);
  const golem = creep(w, "ngst", 1000, 1000); // Rock Golem: `ACtb`
  const f = footman(w, 1400, 1000);
  let stunned = false; // `Dur1` is 2 s — watch for it rather than look afterwards
  runKeeping(w, caster, 6, () => { immortal(golem, f)(); stunned ||= buffIdOn(f, "BPSE"); });
  check("the Rock Golem's boulder stuns the Footman (`BPSE`)", stunned, true);
  const w2 = world();
  const caster2 = new CreepCaster(w2, ABILITIES);
  const granite = creep(w2, "nggr", 1000, 1000); // Granite Golem: `ACtb` + `ACtc`
  const fs3 = [footman(w2, 1100, 960), footman(w2, 1100, 1000), footman(w2, 1100, 1040)];
  for (const x of fs3) w2.issueAttack(x.id, granite.id, false, true);
  let slammed = false;
  runKeeping(w2, caster2, 8, () => { immortal(granite, ...fs3)(); slammed ||= fs3.some((x) => buffIdOn(x, "BCtc")); });
  check("three Footmen at the Granite Golem's feet are Slammed (`BCtc`)", slammed, true);
}

console.log("\nLightning Shield wants a crowd");
{
  // 176: "it will cast Lightning Shield on any unit that is touching at least two of your
  // other units." `[ACls] Area1` is 160.
  const w = world();
  const caster = new CreepCaster(w, ABILITIES);
  const wiz = creep(w, "nwzg", 1000, 1000);
  const lone = footman(w, 1500, 1000);
  w.issueAttack(lone.id, wiz.id, false, true);
  runKeeping(w, caster, 6, immortal(wiz, lone));
  check("a lone Footman is not shielded", buffIdOn(lone, "Blsh"), false);
  const w2 = world();
  const caster2 = new CreepCaster(w2, ABILITIES);
  const wiz2 = creep(w2, "nwzg", 1000, 1000);
  const trio = [footman(w2, 1500, 970), footman(w2, 1500, 1000), footman(w2, 1500, 1030)];
  w2.issueAttack(trio[1].id, wiz2.id, false, true);
  runKeeping(w2, caster2, 6, immortal(wiz2, ...trio));
  check("one touching two others is", trio.some((x) => buffIdOn(x, "Blsh")), true);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall creep-behaviour checks passed");
process.exit(failed ? 1 : 0);
