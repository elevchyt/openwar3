// Headless check of autocast PRIORITY and autocast REACH (issue #94).
//
// Two rules, both taken from the game rather than invented:
//
//  * An order suppresses autocast, but attack-move / patrol / stop do not — Liquipedia
//    (Autocast): "If a unit is given a order, it usually prioritizes this order and does not
//    cast the autocast ability until the order is finished", with attack-move, patrol, stop
//    and hold position called out as leaving autocast active. An attack the Priest picked up
//    by ITSELF never beats his Heal. What an EXPLICIT single-target Attack command
//    (`attackOrdered`) buys is the WALK, not the fight: while he is still closing on the
//    target the group was pointed at he marches with them and casts nothing, and once he is
//    in striking distance of it the Heal comes first again — an army's healer is not an
//    archer, and a group order that turned him into one is the bug this half guards.
//  * The search reaches the caster's ACQUISITION range, not the spell's cast range —
//    "Any friendly unit within acquisition range of the Priest will be automatically healed"
//    (Warcraft Wiki, Priest), and autocast "can cause it to move in order to cast their
//    spell" (Liquipedia). Real real numbers: Priest `acquire` 600 (Units\UnitWeapons.slk)
//    against Heal `Rng1` 250 / `Cost1` 5 (Units\AbilityData.slk).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

// Heal (`Ahea`) as the real row has it.
const HEAL = {
  id: "Ahea", code: "Ahea", target: "unit",
  targetFlags: ["air", "ground", "friend", "vuln", "invu", "self", "organic", "nonancient", "neutral"],
  levelData: [{ cost: 5, cooldown: 1, castRange: 250, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: [25], buffs: [], summon: "" }],
};

/**
 * Abolish Magic (`Aadm`) as the 1.30.4 row has it — `targs1` with NO allegiance flag, `Rng1`
 * 500, `Cost1` 50. The missing flag is the whole of the last section of this file: read as "not
 * friendly" it made the Dryad a hunter, firing at the nearest enemy whether or not it carried
 * anything, and never freeing an ally from anything.
 */
const ABOLISH = {
  id: "Aadm", code: "Aadm", target: "unit", autocast: true,
  targetFlags: ["air", "ground", "ward", "invu", "vuln", "tree"],
  levelData: [{ cost: 50, cooldown: 0, castRange: 500, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: [0, 250], buffs: [], summon: "" }],
};

/** The Priest's ranged slot — `acquire` 600 is the number this whole issue turns on. */
// Every `base*` twin is spelled out because recomputeStats REBUILDS the live fields off them
// each tick (`w.range = w.baseRange + upg.range`) — leave one out and the weapon's range comes
// back NaN, which reads as "never in range of anything" everywhere a band is measured.
const PRIEST_WEAPON = {
  enabled: true, targets: ["ground", "air", "structure"], acquire: 600, range: 600, baseRange: 600, rangeBuffer: 250,
  dice: 1, baseDice: 1, sides: 2, base: 9, damage: 9, baseDamage: 9, cooldown: 1.9, baseCooldown: 1.9, rangeMotionBuffer: 250,
  damagePoint: 0.3, baseDamagePoint: 0.3, backswing: 0.3, baseBackswing: 0.3, baseSpillDist: 0, baseSpillRadius: 0,
  attackType: "magic", ranged: true,
  projectile: "", projectileSpeed: 900, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0,
  spillDist: 0, spillRadius: 0, damageLoss: 0,
};
const FOOTMAN_WEAPON = { ...PRIEST_WEAPON, acquire: 500, range: 90, baseRange: 90, ranged: false, attackType: "normal" };

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A fresh world over open ground. Each case gets its own so nothing leaks between them. */
function world() {
  const W = 64, H = 64;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  const rows = { Ahea: HEAL, Aadm: ABOLISH };
  w.abilities = { get: (id) => rows[id], all: () => Object.values(rows) };
  return w;
}

let nextId = 1;
function add(w, over) {
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 0.6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: FOOTMAN_WEAPON, weapons: [FOOTMAN_WEAPON], oldWeapons: [FOOTMAN_WEAPON],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    ...over,
  });
  // add() settles a spawn onto a free cell; put it back where the case asked for it.
  u.x = over.x ?? 0;
  u.y = over.y ?? 0;
  return u;
}

/** A Priest with Heal on autocast. */
function priest(w, over = {}) {
  const u = add(w, {
    typeId: "hmpr", hp: 290, maxHp: 290, mana: 200, maxMana: 200,
    weapon: PRIEST_WEAPON, weapons: [PRIEST_WEAPON], oldWeapons: [PRIEST_WEAPON], name: "Priest",
    ...over,
  });
  u.abilities = [{ id: "Ahea", code: "Ahea", level: 1, cooldownLeft: 0, autocastOn: true }];
  u.mana = 200;
  return u;
}

// --- reach: the search runs to acquisition range and walks the rest ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const hurt = add(w, { x: 500, y: 0, hp: 100, maxHp: 220 }); // past Heal's 250, inside acquire 600
  check("a wounded ally past cast range but inside acquisition range is taken", w.tickAutocast(p), true);
  check("…as a cast order aimed at it", [p.order, p.pendingCast.targetId], ["cast", hurt.id]);
  check("…flagged as autocast, so the approach can give up", p.pendingCast.auto, true);
  check("…with Heal's own 250 as the range to close to", p.pendingCast.range, 250);
}

// --- reach: and stops at acquisition range ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  add(w, { x: 900, y: 0, hp: 100, maxHp: 220 }); // past acquire 600
  check("a wounded ally past acquisition range is not", w.tickAutocast(p), false);
  check("…and the Priest keeps its order", p.order, "idle");
}

// --- priority: an attack the unit picked up itself yields ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const foe = add(w, { owner: 1, team: 1, x: 300, y: 0 });
  const hurt = add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  w.issueAttack(p.id, foe.id); // no `ordered` flag: this is the unit's own auto-acquisition
  check("…which really is an attack order", [p.order, p.attackOrdered], ["attack", false]);
  w.tickAttack(p, 0.1);
  check("an AUTO-acquired attack gives way to Heal", [p.order, p.pendingCast && p.pendingCast.targetId], ["cast", hurt.id]);
}

// --- priority: an explicit Attack command buys the WALK, not the fight ---
{
  // The group is told to attack something across the field. The Priest marches with it —
  // he does not peel off to heal a straggler behind him — and that is the whole of what the
  // Attack command wins: while he is still closing, the order holds.
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const foe = add(w, { owner: 1, team: 1, x: 1500, y: 0 }); // past the Priest's 600 range
  add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  w.issueAttack(p.id, foe.id, false, true); // the player clicked Attack on that one unit
  w.tickAttack(p, 0.1);
  check("marching to a commanded target, the Priest keeps marching", [p.order, p.targetId], ["attack", foe.id]);
}

// --- priority: …and once the fight is joined, Heal comes first anyway ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const foe = add(w, { owner: 1, team: 1, x: 300, y: 0 }); // inside the Priest's 600 — he is in it
  const hurt = add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  w.issueAttack(p.id, foe.id, false, true);
  w.tickAttack(p, 0.1);
  check("in the fight, Heal outranks the commanded attack", [p.order, p.pendingCast && p.pendingCast.targetId], ["cast", hurt.id]);
  check("…and he goes back to the target he was told to kill", p.pendingCast.resume, { kind: "attack", id: foe.id, force: false });
  // Run the cast out: instant (castTime 0, no castPoint/backswing) → endCast on the next tick.
  w.tickCast(p, 0.1);
  w.tickCast(p, 0.1);
  check("…which is exactly what he does", [p.order, p.targetId, p.attackOrdered], ["attack", foe.id, true]);
  check("…having actually healed", hurt.hp > 100, true);
}

// --- priority: a commanded fight with nothing to heal is just a fight ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const foe = add(w, { owner: 1, team: 1, x: 300, y: 0 });
  const hurt = add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  w.issueAttack(p.id, foe.id, false, true);
  hurt.hp = hurt.maxHp; // nobody needs healing…
  w.tickAttack(p, 0.1);
  check("nothing to heal: the Priest attacks", [p.order, p.targetId], ["attack", foe.id]);
  hurt.hp = 100;
  p.mana = 4; // …and neither does an empty mana pool stop the fight (Heal costs 5)
  w.tickAttack(p, 0.1);
  check("no mana: the Priest attacks", [p.order, p.targetId], ["attack", foe.id]);
}

// --- priority: in the fight the autocast reaches as far as it does anywhere else ---
{
  // A Priest's weapon is 600 and his Heal is 250, so in a real fight the men he is there to
  // keep alive are past his cast range and he has to walk. Refusing that would have been a
  // healer who heals whatever happens to be beside him and nothing else.
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const foe = add(w, { owner: 1, team: 1, x: 300, y: 0 });
  const hurt = add(w, { x: 500, y: 0, hp: 100, maxHp: 220 }); // past Heal's 250, inside acquire 600
  w.issueAttack(p.id, foe.id, false, true);
  w.tickAttack(p, 0.1);
  check("a wounded ally out of Heal's range but inside his own is walked to", [p.order, p.pendingCast && p.pendingCast.targetId], ["cast", hurt.id]);
  check("…and the commanded target is still waiting for him", p.pendingCast.resume, { kind: "attack", id: foe.id, force: false });
}

// --- priority: attack-move heals before it shoots ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  add(w, { owner: 1, team: 1, x: 400, y: 0 }); // an enemy well inside acquisition range
  const hurt = add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  p.order = "attackmove";
  p.amDestX = 2000;
  p.amDestY = 0;
  w.tickAttackMove(p, 0.1);
  check("attack-move casts instead of acquiring the enemy", [p.order, p.pendingCast && p.pendingCast.targetId], ["cast", hurt.id]);
  check("…and remembers to resume the march afterwards", p.pendingCast.resume, { kind: "attackmove", x: 2000, y: 0 });
}

// --- the off switches: autocast toggled off, and no mana ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  add(w, { x: 200, y: 0, hp: 100, maxHp: 220 });
  p.abilities[0].autocastOn = false;
  check("autocast off: nothing is cast", w.tickAutocast(p), false);
  p.abilities[0].autocastOn = true;
  p.mana = 4; // Heal costs 5
  check("not enough mana: nothing is cast", w.tickAutocast(p), false);
}

// --- nobody is hurt ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  add(w, { x: 200, y: 0, hp: 220, maxHp: 220 });
  check("a full-health ally is not healed", w.tickAutocast(p), false);
}

// --- give up mid-walk when somebody else heals the target first ---
{
  const w = world();
  const p = priest(w, { x: 0, y: 0 });
  const hurt = add(w, { x: 500, y: 0, hp: 100, maxHp: 220 });
  w.tickAutocast(p);
  check("the Priest sets off", p.order, "cast");
  w.tickCast(p, 0.1);
  check("…still walking while the ally is hurt", p.order, "cast");
  hurt.hp = hurt.maxHp; // somebody else got there first
  w.tickCast(p, 0.1);
  check("…and turns back once it is topped up", p.order, "idle");
}

// ==========================================================================================
// A DISPEL AUTOCAST GOES BOTH WAYS, and only at a body with something on it.
// ==========================================================================================
// `tickAutocast` reads friendly-versus-hostile off the ability's allegiance flags, which is
// right for every other autocast in the game and cannot describe this one: Abolish Magic has no
// allegiance flag at all, because it strips a buff off their Grunt AND frees our Huntress from
// Entangling Roots. See `dispelAutocastTarget` and `worthDispelling` (sim/spells.ts).
function dryad(w, over = {}) {
  const u = add(w, { typeId: "edry", hp: 380, maxHp: 380, mana: 200, maxMana: 200, name: "Dryad", ...over });
  u.abilities = [{ id: "Aadm", code: "Aadm", level: 1, cooldownLeft: 0, autocastOn: true }];
  u.mana = 200;
  return u;
}
/** A buff hung by `src` — the source's TEAM is what says whether it is a buff or a debuff. */
const from = (src, over = {}) => ({
  kind: "haste", group: "bloodlust", timeLeft: 45, sourceId: src.id, value: 0, value2: 0,
  art: "", fx: [], buffId: "Bblo", delay: 0, ...over,
});
{
  const w = world();
  const d = dryad(w, { x: 0, y: 0 });
  add(w, { owner: 1, team: 1, x: 300, y: 0 });
  check("a plain enemy with nothing on it is not dispelled", w.tickAutocast(d), false);
  check("…and the Dryad keeps its mana", d.mana, 200);
}
{
  const w = world();
  const d = dryad(w, { x: 0, y: 0 });
  const shaman = add(w, { owner: 1, team: 1, x: 400, y: 0 });
  const lusted = add(w, { owner: 1, team: 1, x: 300, y: 0 });
  lusted.buffs = [from(shaman)];
  check("…one their own side has Bloodlusted is", w.tickAutocast(d), true);
  check("…aimed at it", d.pendingCast && d.pendingCast.targetId, lusted.id);
}
{
  // THE HALF THAT DID NOT EXIST. Entangling Roots hangs its `root` with the enemy Keeper's own
  // `sourceId`, so the same comparison that reads Bloodlust as a buff on their Grunt reads the
  // roots as a debuff on our Huntress.
  const w = world();
  const d = dryad(w, { x: 0, y: 0 });
  const keeper = add(w, { owner: 1, team: 1, x: -400, y: 0 });
  const rooted = add(w, { x: 300, y: 0 });
  rooted.buffs = [from(keeper, { kind: "root", group: "roots", timeLeft: 9, buffId: "BEer" })];
  check("an ENTANGLED friendly unit is freed", w.tickAutocast(d), true);
  check("…aimed at it", d.pendingCast && d.pendingCast.targetId, rooted.id);
}
{
  // …and OUR summon is never a target: a dispel damages summons, so that is a reason not to
  // cast rather than a reason to.
  const w = world();
  const d = dryad(w, { x: 0, y: 0 });
  // `summonLeft` is set by the SUMMON path, never by `add`'s init — so it is stamped on here.
  const elemental = add(w, { x: 300, y: 0 });
  elemental.summonLeft = 45;
  check("our own summon is not dispelled", w.tickAutocast(d), false);
}
{
  // …and theirs is, because that is a kill rather than a strip.
  const w = world();
  const d = dryad(w, { x: 0, y: 0 });
  const wolf = add(w, { owner: 1, team: 1, x: 300, y: 0 });
  wolf.summonLeft = 45;
  check("an enemy summon is", w.tickAutocast(d), true);
  check("…aimed at it", d.pendingCast && d.pendingCast.targetId, wolf.id);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
