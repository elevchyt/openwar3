// Headless checks on `ShowUnit` — a unit HIDDEN by the map's script (SimUnit.hidden).
//
// The native called `hooks.hideUnit` and nothing implemented it, so every `ShowUnitHide` in every
// map did nothing. The case that reported it is (4)WarChasers: `Player_N_Enters_Tank` hides each
// hero where it stands while its player drives a steam tank, and the monsters around the tank
// entrance went on killing the hero nobody was controlling.
//
// What a hidden unit IS comes from the people who measured it, not from us (see SimUnit.hidden):
//   hiveworkshop 325292 — "Both unselectable and untargetable … You can't order unit to target
//                          hidden or locust unit … Hidden units are vulnerable to code damage …
//                          Both retain order"
//   hiveworkshop 221667 — "Other units will also be able to target the unhidden unit as well as
//                          collide with it"
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef, isOffField } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { simHooks } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));
const { snapshotFor } = require(join(REPO, ".sim-build", "src", "game", "snapshot.js"));
const { encodeSnapshot, decodeSnapshot } = require(join(REPO, ".sim-build", "src", "game", "snapshotWire.js"));
const { minimapDots } = require(join(REPO, ".sim-build", "src", "game", "minimapView.js"));

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
function run(w, seconds, keep) {
  for (let i = 0; i < seconds * 20; i++) {
    w.tick(0.05);
    keep?.();
  }
}
const immortal = (...us) => () => { for (const u of us) u.hp = Math.max(u.hp, u.maxHp * 0.5); };
const hooksOf = (w) => simHooks(w, (p) => p);

console.log("ShowUnit reaches the world, and IsUnitHidden reads it back");
{
  const w = world();
  const hooks = hooksOf(w);
  const hero = spawn(w, "hfoo", 3000, 3000, 0, 0);
  hooks.hideUnit(hero.id, true);
  check("hideUnit sets SimUnit.hidden", hero.hidden, true);
  check("IsUnitHidden answers true", hooks.isUnitHidden(hero.id), true);
  check("a hidden unit is OFF THE FIELD (isOffField)", isOffField(hero), true);
  check("…but not invulnerable — trigger damage still lands (325292)", hero.invulnerable, false);
  hooks.hideUnit(hero.id, false);
  check("ShowUnit(true) puts it back", [hero.hidden, hooks.isUnitHidden(hero.id), isOffField(hero)], [false, false, false]);
}

console.log("\nnothing attacks a hidden unit");
{
  const w = world();
  const hooks = hooksOf(w);
  const hero = spawn(w, "hfoo", 3000, 3000, 0, 0);
  const murloc = spawn(w, "nmrl", 3100, 3000, 11, 1); // well inside its own acquisition range
  hooks.hideUnit(hero.id, true);
  run(w, 3, immortal(hero, murloc));
  check("an enemy standing beside it never acquires it", murloc.order, "idle");
  check("an ordered attack on it is refused", w.issueAttack(murloc.id, hero.id, false, true), false);
  check("…and it took no hits", hero.hp, hero.maxHp);
  hooks.hideUnit(hero.id, false);
  run(w, 2, immortal(hero, murloc));
  check("shown again, it is fought at once", murloc.order === "attack" && murloc.targetId === hero.id, true);
}

console.log("\nan attacker loses a target that is hidden mid-fight");
{
  const w = world();
  const hooks = hooksOf(w);
  const hero = spawn(w, "hfoo", 3000, 3000, 0, 0);
  const murloc = spawn(w, "nmrl", 3100, 3000, 11, 1);
  w.issueAttack(murloc.id, hero.id, false, true);
  run(w, 1, immortal(hero, murloc));
  check("the Murloc is on the Footman", murloc.targetId, hero.id);
  hooks.hideUnit(hero.id, true);
  const hp = hero.hp;
  run(w, 2, immortal(murloc));
  check("…and stops when it is hidden", murloc.targetId === hero.id && murloc.order === "attack", false);
  check("…with no blow landing after", hero.hp, hp);
}

console.log("\nno spell may be aimed at it, and no area finds it");
{
  const w = world();
  const hooks = hooksOf(w);
  const hero = spawn(w, "hfoo", 3000, 3000, 0, 0);
  const caster = spawn(w, "Hmkg", 3300, 3000, 11, 1);
  const flags = ["air", "ground", "enemy"];
  check("a unit-target spell is legal on it first", w.targetError(caster, hero, flags, "AHtb"), null);
  check("an area finds it first", w.spellApi.unitsInArea(3000, 3000, 200).some((u) => u.id === hero.id), true);
  hooks.hideUnit(hero.id, true);
  check("hidden, the spell is refused", w.targetError(caster, hero, flags, "AHtb") !== null, true);
  check("…and silently — nobody can click one, so the game has no line for it", w.targetError(caster, hero, flags, "AHtb"), "");
  check("…and no area finds it", w.spellApi.unitsInArea(3000, 3000, 200).some((u) => u.id === hero.id), false);
}

console.log("\nit keeps its order, collides with nothing, and picks no fights");
{
  const w = world();
  const hooks = hooksOf(w);
  const walker = spawn(w, "hfoo", 2000, 3000, 0, 0);
  const murloc = spawn(w, "nmrl", 2600, 3000, 11, 1);
  w.issueMove(walker.id, 3400, 3000);
  run(w, 0.2);
  hooks.hideUnit(walker.id, true);
  check("hiding holds no cells (reservation and claim handed back)", walker.hasReservation || walker.hasClaim, false);
  run(w, 8, immortal(walker, murloc));
  check("it retains its order and walks on (325292: \"Both retain order\")", walker.x > 3200, true);
  check("…through the Murloc's spot without fighting it", walker.order === "attack", false);
  check("…and holds no cells while hidden", walker.hasReservation || walker.hasClaim, false);
  hooks.hideUnit(walker.id, false);
  run(w, 0.1);
  check("shown again standing still, it takes its ground back", walker.hasReservation || walker.hasClaim, true);
}

console.log("\nan IDLE hidden unit starts nothing either (ours — see SimUnit.hidden)");
{
  const w = world();
  const hooks = hooksOf(w);
  const footman = spawn(w, "hfoo", 3000, 3000, 0, 0);
  const murloc = spawn(w, "nmrl", 3090, 3000, 11, 1);
  w.issueHold(murloc.id); // the Murloc swings at nothing that is not in its reach anyway
  hooks.hideUnit(footman.id, true);
  run(w, 3, immortal(footman, murloc));
  check("a hidden Footman beside an enemy does not acquire it", footman.order, "idle");
  check("…and the enemy took no hits", murloc.hp, murloc.maxHp);
  hooks.hideUnit(footman.id, false);
  run(w, 2, immortal(footman, murloc));
  check("shown, the same Footman picks the fight up", footman.order === "attack" && footman.targetId === murloc.id, true);
}

console.log("\nthe snapshot and the minimap agree it is off the field");
{
  const w = world();
  const hooks = hooksOf(w);
  const mine = spawn(w, "hfoo", 3000, 3000, 0, 0);
  const theirs = spawn(w, "hfoo", 3200, 3000, 1, 1);
  hooks.hideUnit(mine.id, true);
  hooks.hideUnit(theirs.id, true);
  mine.chopSeq = 5;
  // A viewer with eyes everywhere: anything left out is left out by the off-field rule alone.
  const viewer = {
    player: 0, seesFor: (owner) => owner === 0,
    fogHides: () => false, fogBlocksClick: () => false, invisHides: () => false, fogBlocksAt: () => false,
  };
  const snap = decodeSnapshot(encodeSnapshot(snapshotFor(w, viewer, 0, 1)));
  const m = snap.units.find((u) => u.id === mine.id);
  check("the owner's snapshot still lists its hidden unit, flagged hidden", !!m && m.hidden, true);
  check("…and the chop counter beside the bit survives the wire", m && m.chopSeq, 5);
  check("another player's hidden unit is not sent at all", snap.units.some((u) => u.id === theirs.id), false);
  const dots = minimapDots(w, viewer);
  check("no minimap dot for a hidden unit, even its owner's", dots.some((d) => d.x === mine.x && d.y === mine.y), false);
  hooks.hideUnit(mine.id, false);
  check("…and the dot is back when it is shown", minimapDots(w, viewer).some((d) => d.x === mine.x && d.y === mine.y), true);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall ShowUnit checks passed");
