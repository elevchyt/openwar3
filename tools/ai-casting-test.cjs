// Headless check of the computer player's SPELL chooser (src/ai/casting.ts).
//
// What is being verified is the thing that has no script behind it: the trigger each base
// ability is cast on, taken from Boris_Spider's "Base Abilities for Custom Spells used by AI
// Casters" (hiveworkshop thread 193280) — the only systematic record of what the real melee
// AI does with each spell. Every case below quotes the line it is testing.
//
// The chooser is driven over a REAL SimWorld, not a stub of one: its legality gate is
// `SimWorld.castError` / `castUseError` — the same door a player's click goes through — so a
// test that faked those would be testing nothing. Only the ability ROWS are stubs, and their
// numbers are the 1.27a ones from Units\AbilityData.slk.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { AiCaster } = require(join(REPO, ".sim-build", "src", "ai", "casting.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** One rank of an ability row — every field present, like `emptyAbilityLevel`. */
function lvl(over = {}) {
  return {
    cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0,
    data: new Array(9).fill(NaN), dataStr: new Array(9).fill(""), buffs: [], summon: "", ...over,
  };
}
function ability(over) {
  return {
    id: over.code, code: over.code, isHero: false, isItem: false, levels: 1, target: "unit",
    targetFlags: [], autocast: false, missileArt: "", missileSpeed: 0, buffFx: [],
    levelData: [lvl()], ...over,
  };
}

// The rows the cases use. Real `Rng1`/`Area1`/`Cost1`/`targs1` from AbilityData.slk.
const DEFS = {};
for (const d of [
  // Storm Bolt — Rng1 600, Cost1 75, `targs1 = air,ground,enemy,neutral,nonancient,organic`.
  ability({ code: "AHtb", target: "unit", targetFlags: ["air", "ground", "enemy", "neutral", "organic"], levelData: [lvl({ castRange: 600, cost: 75 })] }),
  // Thunder Clap — no target, Area1 300, Cost1 75; hits air as well as ground.
  ability({ code: "AHtc", target: "none", targetFlags: ["air", "ground", "enemy", "neutral"], levelData: [lvl({ area: 300, cost: 75 })] }),
  // Divine Shield — no target, `targs1 = self`, and a buff of its own (`BHds`).
  ability({ code: "AHds", target: "none", targetFlags: ["self"], levelData: [lvl({ cost: 25, buffs: ["BHds"] })] }),
  // Holy Light — Rng1 800, Cost1 65, `targs1 = air,ground,friend,self,organic,…`.
  ability({ code: "AHhb", target: "unit", targetFlags: ["air", "ground", "friend", "self", "organic"], levelData: [lvl({ castRange: 800, cost: 65 })] }),
  // Carrion Swarm — a WAVE: point-aimed, DataC 700 out, Area1 100 to either side.
  ability({ code: "AUcs", target: "point", targetFlags: ["ground", "air", "enemy"], levelData: [lvl({ area: 100, castRange: 700, cost: 110, data: [100, 300, 700, ...new Array(6).fill(NaN)] })] }),
  // Death Pact — the thread's flat "Never".
  ability({ code: "AUdp", target: "unit", targetFlags: ["ground", "friend", "organic"], levelData: [lvl({ castRange: 600 })] }),
  // Heal — an autocast, so the chooser ARMS it rather than aiming it.
  ability({ code: "Ahea", target: "unit", autocast: true, targetFlags: ["air", "ground", "friend", "self", "organic"], levelData: [lvl({ castRange: 250, cost: 5 })] }),
  // Defend — the autocast with a condition (piercing attackers only).
  ability({ code: "Adef", target: "none", autocast: true, targetFlags: [], levelData: [lvl()] }),
  // Force of Nature — `targs1 = tree` ALONE, `Rng1` 800 to a spot, `Area1` 150 around it,
  // `DataA` 2 trees felled with a Treant in each hole, `Cost1` 100. The one point spell in the
  // game whose target is not a body.
  ability({ code: "AEfn", target: "point", targetFlags: ["tree"], levelData: [lvl({ area: 150, castRange: 800, cost: 100, duration: 60, summon: "efon", data: [2, ...new Array(8).fill(NaN)] })] }),
]) DEFS[d.id] = d;

const WEAPON = {
  enabled: true, targets: ["ground", "air", "structure"], acquire: 600, range: 90, baseRange: 90, rangeBuffer: 250,
  dice: 1, baseDice: 1, sides: 2, damage: 12, baseDamage: 12, cooldown: 1.5, baseCooldown: 1.5,
  damagePoint: 0.3, baseDamagePoint: 0.3, backswing: 0.3, baseBackswing: 0.3,
  baseSpillDist: 0, baseSpillRadius: 0, spillDist: 0, spillRadius: 0, damageLoss: 0,
  attackType: "normal", ranged: false, missileArt: "", missileSpeed: 900,
  areaFull: 0, areaHalf: 0, areaQuarter: 0, areaHalfFactor: 0, areaQuarterFactor: 0,
  splashTargets: [], weaponType: "normal", showUI: true, weaponSound: "", launchZ: 0, impactZ: 0,
};
/** An archer's — the only thing that differs is `attackType`, which is Defend's whole trigger. */
const PIERCE_WEAPON = { ...WEAPON, attackType: "pierce", range: 600, baseRange: 600, ranged: true };

function world() {
  const W = 64, H = 64;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  w.abilities = { get: (id) => DEFS[id], all: () => Object.values(DEFS) };
  return w;
}

let nextId = 1;
function add(w, over) {
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
    hp: 500, maxHp: 500, mana: 300, maxMana: 300, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 0.6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: WEAPON, weapons: [WEAPON], oldWeapons: [WEAPON],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    ...over,
  });
  u.x = over.x ?? 0;
  u.y = over.y ?? 0;
  u.mana = over.mana ?? 300;
  // `add()` derives these from its own options (a hero comes in through `opts.hero`, a
  // worker through `opts.isPeon`), so a case that just wants the FLAG sets it here.
  if (over.isHero) u.isHero = true;
  if (over.isPeon) u.isPeon = true;
  if (over.level) u.level = over.level;
  return u;
}

/** One of ours, carrying the listed base abilities at rank 1. */
function caster(w, codes, over = {}) {
  const u = add(w, over);
  u.abilities = codes.map((code) => ({ id: code, code, level: 1, cooldownLeft: 0, autocastOn: false }));
  return u;
}
const foe = (w, over = {}) => add(w, { owner: 1, team: 1, ...over });

/** The chooser, wired to a log instead of to `RtsController.execute`. Team 0 is ours. */
function ai(w) {
  const log = [];
  const c = new AiCaster({
    world: w,
    player: 0,
    def: (id) => DEFS[id],
    hostile: (u) => u.team !== 0,
    order: (cmd) => { log.push(cmd); return true; },
  });
  return { c, log };
}
/** Just the casts, as [code, targetId] / [code, "point"]. */
const casts = (log) => log.filter((c) => c.c === "cast").map((c) => [c.code, c.targetId || "point"]);

// --- "~Storm Bolt … has preference to target heroes." --------------------------------
{
  const w = world();
  const mk = caster(w, ["AHtb"], { x: 0, y: 0 });
  foe(w, { x: 200, y: 0 }); // nearer, but not a hero
  const hero = foe(w, { x: 400, y: 0, isHero: true, level: 3 });
  const { c, log } = ai(w);
  c.pass();
  check("Storm Bolt is spammed at the HERO, not at the nearer footman", casts(log), [["AHtb", hero.id]]);
  check("…and only one button is pressed per pass", log.length, 1);
}

// --- …and nothing out of `Rng1` ------------------------------------------------------
{
  const w = world();
  caster(w, ["AHtb"], { x: 0, y: 0 });
  foe(w, { x: 900, y: 0 }); // past Storm Bolt's 600
  const { c, log } = ai(w);
  c.pass();
  check("a target past the spell's own cast range is not reached for", casts(log), []);
}

// --- the mana gate is the sim's, not the chooser's -----------------------------------
{
  const w = world();
  const mk = caster(w, ["AHtb"], { x: 0, y: 0 });
  mk.mana = 10; // Storm Bolt costs 75
  foe(w, { x: 200, y: 0 });
  const { c, log } = ai(w);
  c.pass();
  check("an unaffordable spell is refused by castUseError", casts(log), []);
}

// --- "~Thunderclap/Warstomp - Will cast if there are 2 to 3 units around the caster." -
{
  const w = world();
  caster(w, ["AHtc"], { x: 0, y: 0 });
  foe(w, { x: 100, y: 0 });
  const { c, log } = ai(w);
  c.pass();
  check("Thunder Clap holds for a single enemy", casts(log), []);
}
{
  const w = world();
  caster(w, ["AHtc"], { x: 0, y: 0 });
  foe(w, { x: 100, y: 0 });
  foe(w, { x: 0, y: 120 });
  const { c, log } = ai(w);
  c.pass();
  check("…and fires once two stand inside its Area1", casts(log), [["AHtc", "point"]]);
}
// --- "…May not be used if air units are present (despite being allowed to hit them to)."
{
  const w = world();
  caster(w, ["AHtc"], { x: 0, y: 0 });
  foe(w, { x: 100, y: 0 });
  foe(w, { x: 0, y: 120, flying: true, targetedAs: "air" });
  const { c, log } = ai(w);
  c.pass();
  check("…but not with an air unit in the ring", casts(log), []);
}

// --- "~Fire Breath/Shockwave/Carrion Swarm/Impale - … at least 2 to 3 units in a cone." -
{
  const w = world();
  caster(w, ["AUcs"], { x: 0, y: 0 });
  foe(w, { x: 300, y: 0 });
  const { c, log } = ai(w);
  c.pass();
  check("Carrion Swarm holds for one body in the line", casts(log), []);
}
{
  const w = world();
  caster(w, ["AUcs"], { x: 0, y: 0 });
  foe(w, { x: 300, y: 0 });
  foe(w, { x: 600, y: 40 }); // same corridor, inside DataC 700 and Area1 100
  foe(w, { x: 0, y: 600 }); // off to the side — a different direction entirely
  const { c, log } = ai(w);
  c.pass();
  const cast = log.find((x) => x.c === "cast");
  check("…and fires down the line that holds two", [cast.code, Math.round(cast.x), Math.round(cast.y)], ["AUcs", 300, 0]);
}

// --- "~Divine Shield - Casts when attacked… The health of the unit isn't a factor." ---
{
  const w = world();
  const pal = caster(w, ["AHds"], { x: 0, y: 0 });
  const { c, log } = ai(w);
  c.pass();
  check("Divine Shield is not spent on a quiet field", casts(log), []);
  pal.hp -= 30; // took a hit between passes
  c.pass();
  check("…and is spent the moment the caster is hit", casts(log), [["AHds", "point"]]);
}
// …and not twice, because the bubble is already up.
{
  const w = world();
  const pal = caster(w, ["AHds"], { x: 0, y: 0 });
  const { c, log } = ai(w);
  c.pass();
  pal.hp -= 30;
  pal.buffs.push({ kind: "invulnerable", group: "divineshield", timeLeft: 10, sourceId: pal.id, value: 0, value2: 0, art: "", fx: [], buffId: "BHds", delay: 0 });
  c.pass();
  check("a self-buff already in force is not re-cast", casts(log), []);
}

// --- "~Holy Light … prefers heroes" (used as a HEAL by the AI) ------------------------
{
  const w = world();
  caster(w, ["AHhb"], { x: 0, y: 0 });
  add(w, { x: 100, y: 0 }); // a healthy ally
  const { c, log } = ai(w);
  c.pass();
  check("Holy Light is not poured onto a full-health army", casts(log), []);
}
{
  const w = world();
  caster(w, ["AHhb"], { x: 0, y: 0 });
  add(w, { x: 100, y: 0, hp: 100 }); // badly hurt, but not a hero
  const hero = add(w, { x: 200, y: 0, hp: 300, isHero: true });
  const { c, log } = ai(w);
  c.pass();
  check("…and goes to the wounded HERO first", casts(log), [["AHhb", hero.id]]);
}

// --- "~Death Pact - Never" ------------------------------------------------------------
{
  const w = world();
  caster(w, ["AUdp"], { x: 0, y: 0 });
  add(w, { x: 100, y: 0, hp: 50 });
  const { c, log } = ai(w);
  c.pass();
  check("Death Pact is never cast", log, []);
}

// --- the channel trap: a unit already casting is left alone ---------------------------
{
  const w = world();
  const mk = caster(w, ["AHtb"], { x: 0, y: 0 });
  foe(w, { x: 200, y: 0 });
  mk.order = "cast";
  const { c, log } = ai(w);
  c.pass();
  check("a caster mid-channel is not given a fresh order", log, []);
}

// --- autocast: "their autocast doesn't have to be enabled for IAs" --------------------
{
  const w = world();
  const priest = caster(w, ["Ahea"], { x: 0, y: 0 });
  const { c, log } = ai(w);
  c.pass();
  check("an autocast the computer owns is ARMED, not aimed", log, [{ c: "autocast", unitId: priest.id, code: "Ahea" }]);
  priest.abilities[0].autocastOn = true;
  log.length = 0;
  c.pass();
  check("…once, and never toggled back off", log, []);
}

// --- Defend: "…only if the caster is being attacked by a unit with Piercing damage" ---
{
  const w = world();
  const foot = caster(w, ["Adef"], { x: 0, y: 0 });
  const swordsman = foe(w, { x: 200, y: 0 }); // normal damage
  const { c, log } = ai(w);
  c.pass();
  check("Defend stays down against a melee attacker", log, []);
  swordsman.weapons = [PIERCE_WEAPON];
  swordsman.weapon = PIERCE_WEAPON;
  c.pass();
  check("…and goes up against a piercing one", log, [{ c: "autocast", unitId: foot.id, code: "Adef" }]);
  foot.abilities[0].autocastOn = true;
  log.length = 0;
  c.pass();
  check("…and stays up while the archer is there", log, []);
  swordsman.hp = 0;
  c.pass();
  check("…and comes back down when it is gone (it costs 30% move speed)", log, [{ c: "autocast", unitId: foot.id, code: "Adef" }]);
}

// --- workers are the economy's, not the captain's -------------------------------------
{
  const w = world();
  const acolyte = caster(w, ["AHtb"], { x: 0, y: 0, isPeon: true });
  foe(w, { x: 200, y: 0 });
  const { c, log } = ai(w);
  c.pass();
  check("a worker is never pulled off its job to cast", log, []);
}

// --- Force of Nature is aimed at the TREES --------------------------------------------
// The derived rule for anything that summons is `{ when: "engaged" }` (`ruleFor`), so the Keeper
// pressed the button in every fight — and `pickSpot` scored the spot like an area nuke, on the
// bodies caught, which put 100 mana on a point that fells nothing at all. `[AEfn] targs1` is
// "tree": what has to be inside `Area1` is TRUNKS, and `SimWorld.fellTrees` raises one Treant
// for each of them.
{
  const w = world();
  const keeper = caster(w, ["AEfn"], { x: 0, y: 0, isHero: true });
  foe(w, { x: 600, y: 0 });
  // A stand off to one side of the enemy — deliberately further from it than `Area1` (150), so
  // that "aimed at the trees" and "aimed at the body" are different answers and the old aim
  // cannot pass by luck — and one lone trunk behind the hero.
  let tid = 1;
  for (const t of [{ x: 700, y: 300 }, { x: 760, y: 340 }, { x: -200, y: 0 }]) {
    w.trees.set(tid, { id: tid, x: t.x, y: t.y, lumber: 200, hp: 50, blockRadius: 64 });
    tid++;
  }
  const { c, log } = ai(w);
  c.pass();
  const cmd = log.find((o) => o.c === "cast" && o.code === "AEfn");
  check("a Keeper casts Force of Nature in a fight", !!cmd, true);
  check("…on a TRUNK rather than on the enemy", cmd && [cmd.x, cmd.y], [700, 300]);
  check("…and on the stand by the fight, not the one behind him", cmd && cmd.x > 0, true);
}
{
  // NO TREES IN REACH, NO CAST. `nearestTrees` pads its answer past the radius, so a forest on
  // the far side of the map comes back looking like a candidate; 100 mana on a spot that fells
  // nothing is exactly what this is here to stop.
  const w = world();
  caster(w, ["AEfn"], { x: 0, y: 0, isHero: true });
  foe(w, { x: 600, y: 0 });
  w.trees.set(1, { id: 1, x: 4000, y: 4000, lumber: 200, hp: 50, blockRadius: 64 });
  const { c, log } = ai(w);
  c.pass();
  check("a forest out of `Rng1` is not a spot", log.filter((o) => o.c === "cast"), []);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
