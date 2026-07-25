// Headless check that the DRAIN is a channel — Life Drain / Siphon Mana (`AHdr`).
//
// Everything else about the spell was already right (the transfer, the duration, and since
// issue #97 the beam). What was missing is that in WC3 the drain is *channelled*: the caster
// stands there and does nothing else, and the instant she moves, attacks, casts again or is
// stunned, the drain stops — the life stops transferring and the beam goes out. Liquipedia's
// Dark Ranger page calls Drain "a channeling spell" and lists exactly that; the Blood Mage's
// Siphon Mana page says the same of its 6 seconds.
//
// The interesting part is that a drain's effect is not a field like Blizzard's — it is a pair
// of ordinary timed buffs, one on each end — and a buff does not know its caster walked away.
// So `tickDrains` is the teardown, and this pins what it must do:
//
//   • the caster is LOCKED for the channel (`Dur1` seconds — 6 for Siphon Mana, 8 for Drain),
//   • an interrupt strips the drain buffs off BOTH units, not just the victim,
//   • …and cuts the beam by tag, so the ribbon does not hang in the air for the rest of the
//     duration (`drainLightningStops`).
//
// Real 1.27a rows (Units\AbilityData.slk; column names via AbilityMetaData → WorldEditStrings):
//   AHdr Blood Mage - Siphon Mana   Dur1 6   DataA "Life Transferred Per Second" 0, DataB 15
//   ANdr Dark Ranger - Drain        Dur1 8   DataA 25, DataB 0
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

/** The Dark Ranger's Drain (`ANdr`, base code `AHdr`): 25 life/sec for 8s at 800 range. */
const DRAIN = {
  id: "ANdr", code: "AHdr", target: "unit",
  targetFlags: ["air", "ground", "organic", "enemy"],
  lightning: ["DRAB", "DRAL", "DRAM"],
  buffFx: [], buffArt: "", targetArt: "", casterArt: "", specialArt: "", effectArt: "", areaArt: "", missileArt: "",
  levelData: [{ cost: 75, cooldown: 8, castRange: 800, area: 500, duration: 8, heroDuration: 8, castTime: 0, data: [25, 0], buffs: [], summon: "" }],
};

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const WEAPON = {
  enabled: true, targets: ["ground", "air", "structure"], acquire: 0, range: 600,
  dice: 1, sides: 2, base: 9, damage: 9, baseDamage: 9, cooldown: 1.9, rangeMotionBuffer: 250,
  damagePoint: 0.3, backswing: 0.3, attackType: "normal", ranged: true,
  projectile: "", projectileSpeed: 900, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0,
  spillDist: 0, spillRadius: 0, damageLoss: 0,
};

function world() {
  const W = 64, H = 64;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  w.abilities = { get: (id) => (id === "ANdr" ? DRAIN : undefined), all: () => [DRAIN], buffFx: () => [] };
  return w;
}

let nextId = 1;
function add(w, over) {
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 100, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: WEAPON, weapons: [WEAPON], oldWeapons: [WEAPON],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "undead",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Unit",
    worker: null, depotGold: false, depotLumber: false,
    ...over,
  });
  u.x = over.x ?? 0;
  u.y = over.y ?? 0;
  return u;
}

/** A Dark Ranger with Drain, and a victim of the other team a step away. */
function pair() {
  const w = world();
  const ranger = add(w, { x: 0, y: 0, mana: 300, maxMana: 300, name: "Dark Ranger" });
  ranger.abilities = [{ id: "ANdr", code: "AHdr", level: 1, cooldownLeft: 0, autocastOn: false }];
  const victim = add(w, { x: 200, y: 0, team: 1, owner: 1, name: "Victim" });
  return { w, ranger, victim };
}

const drainBuffs = (u) => u.buffs.filter((b) => b.group === "drain").map((b) => b.kind);
const step = (w, seconds, dt = 0.05) => { for (let i = 0; i < Math.round(seconds / dt); i++) w.tick(dt); };

// --- the channel runs, and both ends carry the drain ------------------------------------
{
  const { w, ranger, victim } = pair();
  check("the drain is cast", w.issueCast(ranger.id, "AHdr", victim.id), true);
  step(w, 0.2);
  w.drainSpellLightnings(); // consume the cast's beam event
  check("the victim takes the damage-over-time", drainBuffs(victim), ["dot"]);
  check("…and the caster the matching heal", drainBuffs(ranger), ["hot"]);
  check("…while she stands channelling", ranger.order, "cast");
  // Locked for the ability's own Dur1, not for a wind-up: 8 seconds of standing still.
  step(w, 3);
  check("…still channelling three seconds in", [ranger.order, drainBuffs(victim).length], ["cast", 1]);
  check("…and the victim is losing 25 hp/sec", victim.hp < 500 - 25 * 2.5, true);
}

// --- moving breaks it, and takes the buffs and the beam with it -------------------------
{
  const { w, ranger, victim } = pair();
  w.issueCast(ranger.id, "AHdr", victim.id);
  step(w, 1);
  w.drainSpellLightnings();
  w.drainLightningStops();
  check("the drain is running", [drainBuffs(victim), drainBuffs(ranger)], [["dot"], ["hot"]]);

  w.issueMove(ranger.id, 400, 400); // she walks — the channel is over
  w.tick(0.05);
  check("moving ends the channel", drainBuffs(victim), []);
  check("…on the caster too — no free heal for a drain she stopped", drainBuffs(ranger), []);
  check("…and the beam is cut by tag rather than left hanging", w.drainLightningStops(), [`drain:${ranger.id}`]);
  // From here on the victim is untouched. (Measured AFTER the breaking tick: the interrupt is
  // noticed at the end of the tick the order landed on, so that tick's drain still counted.)
  const hpAtBreak = victim.hp;
  step(w, 2);
  check("…and the victim stops losing health", Math.round(victim.hp), Math.round(hpAtBreak));
}

// --- so does anything else: a stun is an interrupt like any other ------------------------
{
  const { w, ranger, victim } = pair();
  w.issueCast(ranger.id, "AHdr", victim.id);
  step(w, 1);
  w.drainSpellLightnings();
  w.drainLightningStops();
  ranger.buffs.push({ kind: "stun", group: "test", timeLeft: 3, sourceId: victim.id, value: 0, value2: 0, fx: [] });
  step(w, 0.2);
  check("a stunned caster's drain stops", [drainBuffs(victim), drainBuffs(ranger)], [[], []]);
  check("…and its beam with it", w.drainLightningStops(), [`drain:${ranger.id}`]);
}

// --- a channel that simply RAN OUT is not an interrupt -----------------------------------
{
  const { w, ranger, victim } = pair();
  w.issueCast(ranger.id, "AHdr", victim.id);
  step(w, 1);
  const hpAfter1s = victim.hp;
  step(w, 7.5); // past the 8-second Dur1
  check("the drain runs its full duration", victim.hp < hpAfter1s - 25 * 6, true);
  check("…then releases the caster", ranger.order !== "cast", true);
  check("…leaving no buff behind on either end", [drainBuffs(victim), drainBuffs(ranger)], [[], []]);
}

// --- Siphon Mana takes MANA, and gives it to the caster ---------------------------------
//
// Same ability, same handler, different columns: `DataA` 0 / `DataB` 15 makes it a mana
// drain, which the old single-rate reading turned into 15 points of HP damage a second — a
// life drain wearing Siphon Mana's name (and, before this, its green art too).
{
  const w = world();
  const mage = add(w, { x: 0, y: 0, mana: 100, maxMana: 300, name: "Blood Mage" });
  mage.abilities = [{ id: "ANdr", code: "AHdr", level: 1, cooldownLeft: 0, autocastOn: false }];
  const victim = add(w, { x: 200, y: 0, team: 1, owner: 1, mana: 300, maxMana: 300, name: "Victim" });
  DRAIN.levelData[0].data = [0, 15];
  DRAIN.levelData[0].cost = 0;
  const hp0 = victim.hp;
  const mana0 = mage.mana;
  w.issueCast(mage.id, "AHdr", victim.id);
  step(w, 2);
  check("a mana drain moves MANA, not health", Math.round(hp0 - victim.hp), 0);
  // A FULL-mana victim is drainable at all only because the regen tick stopped skipping
  // units at full — a negative manaRegen is what a mana drain is.
  check("…off the victim", victim.mana < 300 - 15, true);
  check("…and into the caster", mage.mana > mana0 + 15, true);
  // At DataB's own rate. (The caster's gain is a hair larger — she is also regenerating her
  // own mana the whole time, which the drain has nothing to do with.)
  check("…at dataB's 15 a second", Math.abs(300 - victim.mana - 15 * 2) <= 2, true);
  DRAIN.levelData[0].data = [25, 0];
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
