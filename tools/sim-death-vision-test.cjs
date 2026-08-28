// Headless checks on what a unit leaves behind when it falls (issue #126).
//
// Two facts, and they are the same fact seen from two ends: **a body is not instantly gone.**
//
//   • **It goes on seeing.** WC3 lets a dying unit keep its eyes for its own death time
//     (`Units\UnitData.slk` `death`, the World Editor's "Stats - Death Time"), capped at
//     `Units\MiscData.txt` [Misc] `DyingRevealRadius` = 500 — the constant the World Editor
//     calls "Fog Reveal Radius - Dying Unit". A CAP, not a radius handed out: nearly every
//     unit in the game outsees it and is cut back to 500, but a crab (350) dies seeing
//     exactly what it saw in life.
//
//   • **A hero leaves no remains at all.** It plays its death, dissipates, fades and is gone,
//     which is why no corpse ability in the game can touch it — Raise Dead and Resurrection
//     have nothing to work with rather than a body they are forbidden to take. Its name is on
//     the altar the instant it falls, but the revive button is dead until the body has left
//     the field (`FallenHero.bodyLeft`).
//
// The original has a BUG in the first of those and this file pins the shape that avoids it.
// WC3 caps the dying unit's OWN sight and restores it when the death clock runs out, so a hero
// revived faster than its death time never gets the restore and walks around on 500 sight for
// the rest of the match. Here the cap lives on a record that outlived the unit, and nothing on
// the hero was ever touched — so there is nothing to restore and nothing to forget.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, heroBodyTime, HERO_FADE_TIME, HERO_DISSIPATE_TIME } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { VisionSet } = require(join(REPO, ".sim-build", "src", "game", "viewpoint.js"));
const { FogState } = require(join(REPO, ".sim-build", "src", "sim", "vision.js"));
const { MISC_DATA } = require(join(REPO, ".sim-build", "src", "data", "gameplayConstants.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// The real rows this file leans on, straight out of the install's UnitBalance.slk
// (sight/nsight) and UnitData.slk (death).
//   hfoo Footman:   1400 / 800, death 3.04
//   Hpal Paladin:   1800 / 800, death 1.5
//   ncrb Crab:       350 / 350, death 2      — one of the few things the cap does not touch
//   htow Town Hall:  900 / 600, death 3.17
const TYPES = {
  hfoo: { sightDay: 1400, sightNight: 800, deathTime: 3.04, isHero: false },
  ncrb: { sightDay: 350, sightNight: 350, deathTime: 2, isHero: false },
  Hpal: { sightDay: 1800, sightNight: 800, deathTime: 1.5, isHero: true },
  htow: { sightDay: 900, sightNight: 600, deathTime: 3.17, isHero: false },
};
const registry = { get: (id) => TYPES[id] };

function unit(over = {}) {
  const u = {
    id: 1, owner: 0, team: 0, typeId: "hfoo", race: "human", isHero: false, properName: "",
    level: 1, xp: 0, skillPoints: 0, abilities: [], inventory: [],
    baseStr: 10, baseAgi: 10, baseInt: 10, baseMaxHp: 100,
    hp: 0, maxHp: 100, mana: 0, maxMana: 0, x: 500, y: 500,
    sightDay: 1400, sightNight: 800, flying: false, mechanical: false, isSummon: false,
    isCreep: false, neutralPassive: false, isIllusion: false,
    buffs: [], weapons: [], orderQueue: [], path: [], footprint: 0, hasReservation: false,
    building: null, worker: null, order: "idle", targetId: null, moving: false,
    garrison: [], garrisonCap: 0, inMine: false, inBurrow: false, insideBuild: false,
    summonLeft: 0, constructing: 0, mineId: 0, entangledBy: 0, heldCorpses: [],
    noCollision: false, radius: 16, facing: 0,
    ...over,
  };
  // The pre-upgrade baselines `recomputeStats` rebuilds the live sight from every tick, which
  // the real spawn path fills in. They matter to the last section: a living unit's sight is
  // re-derived from these constantly, so there is nowhere for a capped value to hide on one.
  u.baseSightDay = u.baseSightDay ?? u.sightDay;
  u.baseSightNight = u.baseSightNight ?? u.sightNight;
  return u;
}

// The unit registry is the fifth constructor argument (abilities, items, units, …); the death
// time and the hero flag are both read off it, so it is what makes this file's numbers real.
function worldOf() {
  const grid = new PathingGrid({ width: 64, height: 64, flags: new Uint8Array(64 * 64) }, [0, 0]);
  return new SimWorld(grid, 1, { get: () => undefined }, undefined, registry);
}

console.log("\nMiscData names the cap, and the World Editor names it 'Fog Reveal Radius - Dying Unit'");
check("DyingRevealRadius is 500", MISC_DATA.DyingRevealRadius, 500);

console.log("\na body goes on seeing — capped, for its own death time");
{
  const w = worldOf();
  const u = unit({ typeId: "hfoo" });
  w.units.set(u.id, u);
  w.killUnit(u.id);

  const reveals = [...w.activeDeathReveals()];
  check("one reveal was filed", reveals.length, 1);
  check("…where the unit fell", [reveals[0].x, reveals[0].y], [500, 500]);
  check("…for the DEAD unit's own side", [reveals[0].owner, reveals[0].team], [0, 0]);
  // 1400 day sight, cut to the 500 cap.
  check("a far-sighted unit is cut back to the cap", reveals[0].radius, 500);
  check("…and it lasts exactly the type's death time", reveals[0].timeLeft, 3.04);

  // It ages out on its own, and only then.
  w.tick(3);
  check("still watching just before its time is up", [...w.activeDeathReveals()].length, 1);
  w.tick(0.1);
  check("…and gone the moment it is", [...w.activeDeathReveals()].length, 0);
}

console.log("\n…but the cap is a CAP, not a radius handed out");
{
  // A crab is one of the handful of things in the game that sees LESS than the cap, so it is
  // what proves the constant is a ceiling rather than a value: 350 in life, 350 dying.
  const w = worldOf();
  const u = unit({ id: 2, typeId: "ncrb", sightDay: 350, sightNight: 350 });
  w.units.set(u.id, u);
  w.killUnit(u.id);
  check("a crab dies seeing everything it saw in life", [...w.activeDeathReveals()][0].radius, 350);
}
{
  // …and "what it saw in life" means RIGHT NOW: the reading is the live day/night one, not
  // whichever of the two is bigger.
  const w = worldOf();
  w.timeOfDay = 0; // midnight
  const u = unit({ id: 2, typeId: "ncrb", sightDay: 700, sightNight: 300 });
  w.units.set(u.id, u);
  w.killUnit(u.id);
  check("…and after dark it dies on its NIGHT radius", [...w.activeDeathReveals()][0].radius, 300);
}

console.log("\na STRUCTURE does not die on a clock — it collapses");
{
  const w = worldOf();
  const u = unit({ id: 3, typeId: "htow", building: { constructionLeft: 0, builderIds: [], queue: [], rallyX: 0, rallyY: 0, rallyKind: "none", rallyTargetId: 0 } });
  w.units.set(u.id, u);
  w.killUnit(u.id);
  check("a razed building leaves no eyes behind", [...w.activeDeathReveals()].length, 0);
}

console.log("\nthe eyes belong to the dead unit's own side  (Viewpoint)");
{
  const w = worldOf();
  const u = unit({ id: 4, typeId: "hfoo", owner: 0, team: 0, x: 500, y: 500 });
  w.units.set(u.id, u);
  w.killUnit(u.id);
  check("nothing of ours is standing anywhere", w.units.size, 0);

  const noAlliances = { sharesVisionWith: () => false, coAllied: () => false };
  const set = new VisionSet(w, noAlliances, () => [], 0, 0, 1024, 1024);
  const mine = set.viewpointFor(0);
  mine.setTeam(0);
  const theirs = set.viewpointFor(1);
  theirs.setTeam(1);
  set.tick(1, []);

  check("our own fog is lifted where our unit fell", mine.vision.stateAt(500, 500), FogState.Visible);
  check("…and the enemy learns nothing from it", theirs.vision.stateAt(500, 500) === FogState.Visible, false);

  // …and it goes when the body's clock does, rather than lingering as a hole in the fog.
  w.tick(4);
  set.tick(1, []);
  check("the hole closes when the reveal ages out", mine.vision.stateAt(500, 500) === FogState.Visible, false);
}

console.log("\na hero leaves NO corpse — its body dissipates instead");
{
  const w = worldOf();
  const u = unit({ id: 5, typeId: "Hpal", isHero: true, properName: "Uther", sightDay: 1800 });
  w.units.set(u.id, u);
  w.killUnit(u.id);
  check("no body was filed for anything to raise, eat or carry", w.corpses.size, 0);
  check("…while an ordinary footman still leaves one", (() => {
    const w2 = worldOf();
    const f = unit({ id: 6, typeId: "hfoo" });
    w2.units.set(f.id, f);
    w2.killUnit(f.id);
    return w2.corpses.size;
  })(), 1);

  const f = w.fallen.get(5);
  check("the hero is on the altar roster the instant it falls", !!f, true);
  // 1.5 death + 3 dissipate (the fade being the last second of the dissipate, not a fourth
  // phase after it — see HERO_FADE_TIME).
  check("…and its body has a clock of its own", f.bodyLeft, heroBodyTime(1.5));
  check("which is death time + DissipateTime", heroBodyTime(1.5), 1.5 + HERO_DISSIPATE_TIME);
  check("DissipateTime is the file's own", HERO_DISSIPATE_TIME, MISC_DATA.DissipateTime);
  check("…and the fade is one second, inside it", [HERO_FADE_TIME, HERO_FADE_TIME <= HERO_DISSIPATE_TIME], [1, true]);

  // The button is dead until the body is gone, then alive — and the record STAYS.
  w.tick(3);
  check("the body is still on the field", w.fallen.get(5).bodyLeft > 0, true);
  w.tick(2);
  check("…and gone once its clock runs out", w.fallen.get(5).bodyLeft, 0);
  check("the hero is still on the roster, waiting to be paid for", w.fallenHeroesOf(0).length, 1);
}

console.log("\nand the original's bug is not reachable from here");
{
  // WC3 caps the DYING UNIT'S OWN sight and restores it on a timer. Revive faster than that
  // timer and the restore never lands — "he will permanently have incorrect vision until he
  // respawns correctly". The record here is not the unit, so a hero that comes back while its
  // own death reveal is still running comes back on its full sight.
  const w = worldOf();
  const u = unit({ id: 7, typeId: "Hpal", isHero: true, sightDay: 1800, sightNight: 800 });
  w.units.set(u.id, u);
  w.killUnit(u.id);
  check("the body's eyes are capped", [...w.activeDeathReveals()][0].radius, 500);

  // A Tavern brings it straight back — well inside the 1.5s the body is still falling.
  w.tick(0.2);
  const back = unit({ id: 8, typeId: "Hpal", isHero: true, sightDay: 1800, sightNight: 800 });
  w.units.set(back.id, back);
  check("the hero standing there again has its own full sight", [back.sightDay, back.sightNight], [1800, 800]);
  check("…and nothing on it was ever capped to be restored", back.sightDay === TYPES.Hpal.sightDay, true);
  check("the body's own reveal is still running, and is a separate thing", [...w.activeDeathReveals()].length, 1);
  w.tick(2);
  check("…which ages out without touching the living hero", [...w.activeDeathReveals()].length, 0);
  check("the hero's sight is untouched afterwards too", [back.sightDay, back.sightNight], [1800, 800]);
}

console.log(failed ? `\ndeath vision: ${failed} CHECK(S) FAILED` : "\ndeath vision: all checks passed");
process.exit(failed ? 1 : 0);
