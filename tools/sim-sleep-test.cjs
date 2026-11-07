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
    let dir = EXTRACT;
    for (const part of p.split("\\")) {
      const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase());
      if (!hit) return null;
      dir = join(dir, hit);
    }
    return fs.statSync(dir).isFile() ? new Uint8Array(fs.readFileSync(dir)) : null;
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
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const W = 200, H = 200;
const DT = 1 / 32;
function world() {
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  return new SimWorld(grid, 1, ABILITIES, undefined, UNITS);
}
let nextId = 1;
/** A unit from its own row, as RtsController.buildInitialAbilities lists it — `heroLevel` puts
 *  every hero skill at that rank. */
function spawn(w, typeId, x, y, owner, team, heroLevel = 0) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  const abilities = [];
  for (const id of def.abilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: autoArmed(def, id, a.code) });
  }
  for (const id of def.heroAbilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: heroLevel, cooldownLeft: 0, autocastOn: false });
  }
  const flying = def.moveType === "fly";
  return w.add(
    {
      id: nextId++, owner, team, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying, flyHeight: flying ? def.moveHeight : 0,
      sightDay: def.sightDay || 1400, sightNight: def.sightNight || 800,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: flying ? "air" : "ground", moveType: flying ? "fly" : "foot",
      worker: null, depotGold: false, depotLumber: false, isHero: def.isHero,
    },
    null,
    { abilities, level: def.level, isPeon: def.classification.includes("peon"), building: def.isBuilding ? {} : undefined },
  );
}
const run = (w, secs) => { for (let t = 0; t < secs; t += DT) w.tick(DT); };
const has = (u, code) => u.abilities.some((a) => a.code === code);
const C = 3200; // the middle of the 200×200-cell world (32-unit cells)

// Headless check of SLEEP (`AUsl`, the Dreadlord's — and `ACsl`, the creeps' copy), with the
// install's own rows:
//
//   · it disables the target like a stun (no move, no attack, no spell), and so it ENDS A
//     CHANNEL (Blizzard) the moment it lands;
//   · for `DataA` "Stun Delay" (2 s) the sleeper is INVULNERABLE — nothing can hurt it, so
//     nothing can wake it — and the ward strips none of its other buffs;
//   · after that ANY damage wakes it, a blow from its own side included (the counter-play);
//   · nothing picks a sleeper for itself: an idle unit and an attack-move walk past it, and a
//     creep camp turns on it only when nothing else is left.
//
// Run: pnpm sim:test
const sleepBuff = (u) => u.buffs.find((b) => b.kind === "sleep");
/** Cast Sleep from a fresh Dreadlord and step until the buff lands; returns the Dreadlord. */
function sleepIt(w, target, owner = 0) {
  const dl = spawn(w, "Udre", target.x - 500, target.y, owner, owner, 1);
  dl.weapons = []; // the Dreadlord would otherwise wake his own victim by swinging at it
  dl.mana = dl.maxMana = 1000;
  check("the Dreadlord's Sleep is accepted", w.issueCast(dl.id, "AUsl", target.id), true);
  for (let i = 0; i < 200 && !sleepBuff(target); i++) w.tick(DT);
  return dl;
}

console.log("Sleep lands: a disable with a 2 s invulnerable opening (Stun Delay)");
{
  const w = world();
  const f = spawn(w, "hfoo", C, C, 1, 1);
  f.weapons = [];
  w.spellApi.applyBuff(f, { kind: "slow", group: "slow", timeLeft: 30, sourceId: 0, value: 0.5, value2: 0.25 });
  sleepIt(w, f);
  w.tick(DT);
  check("Stun Delay is AUsl's DataA (2)", ABILITIES.get("AUsl").levelData[0].data[0], 2);
  check("the Footman is asleep, disabled and warded", [f.magicSleep, f.stunned, f.invulnerable, f.sleepWard], [true, true, true, true]);
  check("…and the ward wiped nothing (the Slow is still on it)", f.buffs.some((b) => b.kind === "slow"), true);
  const hp = f.hp;
  w.spellApi.spellDamage(f, 50, 0);
  check("damage inside the ward does nothing", [f.hp, f.magicSleep], [hp, true]);
  const pal = spawn(w, "hfoo", C + 200, C, 1, 1); // its own side
  check("…and its own side cannot be ordered onto it yet", w.issueAttack(pal.id, f.id, true, true), false);
  run(w, 2.1);
  check("past the delay: still asleep, no longer invulnerable", [f.magicSleep, f.stunned, f.invulnerable, f.sleepWard], [true, true, false, false]);
  check("a friendly forced attack is accepted now", w.issueAttack(pal.id, f.id, true, true), true);
  let woke = false;
  for (let i = 0; i < 32 * 6 && !woke; i++) { w.tick(DT); woke = !f.magicSleep; }
  check("…and its first blow wakes the Footman", [woke, f.stunned, f.hp < hp], [true, false, true]);
}

console.log("\nany damage wakes it — a spell's too");
{
  const w = world();
  const f = spawn(w, "hfoo", C, C, 1, 1);
  sleepIt(w, f);
  run(w, 2.2);
  w.spellApi.spellDamage(f, 10, 0);
  check("10 spell damage after the delay wakes it", [f.magicSleep, f.stunned], [false, false]);
}

console.log("\nSleep ends a channel (Blizzard)");
{
  const w = world();
  const am = spawn(w, "Hamg", C, C, 1, 1, 1);
  am.mana = am.maxMana = 1000;
  check("the Archmage starts a Blizzard", w.issueCast(am.id, "AHbz", 0, C + 600, C + 600), true);
  let channelling = false;
  for (let i = 0; i < 32 * 3 && !channelling; i++) { w.tick(DT); channelling = am.order === "cast" && am.pendingCast?.fired && am.pendingCast.channelLeft > 0; }
  check("…and is channelling it", channelling, true);
  sleepIt(w, am);
  w.tick(DT);
  check("slept: the channel is over", [am.magicSleep, am.order === "cast"], [true, false]);
}

console.log("\nnothing picks a sleeper for itself: idle units and an attack-move pass it by");
{
  const w = world();
  const sleeper = spawn(w, "hfoo", C, C, 1, 1);
  sleeper.weapons = [];
  sleepIt(w, sleeper);
  run(w, 2.2);
  const idle = spawn(w, "ogru", C + 150, C, 0, 0); // well inside its acquisition, idle
  const amover = spawn(w, "ogru", C - 1200, C + 60, 0, 0);
  check("the attack-move is accepted", w.issueAttackMove(amover.id, C + 1200, C + 60), true);
  const hp = sleeper.hp;
  run(w, 8);
  check("the idle Grunt never acquired it", idle.targetId === sleeper.id || idle.order === "attack", false);
  check("the attack-moving Grunt walked past it", amover.x > C + 600, true);
  check("…and the sleeper is untouched and still asleep", [sleeper.hp, sleeper.magicSleep], [hp, true]);
  check("an ORDERED attack on it is accepted", w.issueAttack(idle.id, sleeper.id, false, true), true);
  run(w, 3);
  check("…and wakes it", sleeper.magicSleep, false);
}

console.log("\nan auto-acquired lock on a unit that falls asleep is let go");
{
  const w = world();
  const victim = spawn(w, "hfoo", C, C, 1, 1);
  victim.weapons = [];
  victim.hp = victim.maxHp = 100000; // outlives the test
  const g = spawn(w, "ogru", C + 120, C, 0, 0);
  run(w, 1);
  check("the idle Grunt picked the Footman up by itself", g.targetId, victim.id);
  sleepIt(w, victim, 2); // a third side's Dreadlord
  run(w, 3);
  check("…and has let it sleep", [victim.magicSleep, g.targetId === victim.id], [true, false]);
}

console.log("\na creep camp turns on a sleeper LAST");
{
  const w = world();
  const ogre = spawn(w, "nogr", C, C, -1, -1);
  ogre.isCreep = true;
  ogre.guardX = ogre.x; ogre.guardY = ogre.y; ogre.guardFacing = 0;
  ogre.aggroRange = ogre.weapon?.acquire ?? 0;
  ogre.canSleep = false;
  const near = spawn(w, "hfoo", C + 110, C, 1, 1); // the nearer of the two — slept
  const far = spawn(w, "hfoo", C - 220, C, 1, 1); // awake, and further off
  near.weapons = [];
  far.weapons = [];
  far.hp = far.maxHp = 2000;
  const dl = sleepIt(w, near, 2);
  w.removeUnit(dl.id); // only the two Footmen are left for the camp to choose between
  run(w, 2.2);
  w.spellApi.spellDamage(ogre, 1, far.id); // the camp is provoked
  run(w, 1.5);
  check("the Ogre is fighting the AWAKE Footman, not the nearer sleeper", ogre.targetId, far.id);
  check("…and the sleeper sleeps on", near.magicSleep, true);
  w.removeUnit(far.id);
  run(w, 2);
  check("with nobody else left, the sleeper is its target", ogre.targetId, near.id);
}

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nall sleep checks passed");
