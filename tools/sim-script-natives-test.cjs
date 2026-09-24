// Headless check of the natives the two rebalance maps reach only THROUGH blizzard.j — the
// ones a map's own call list does not show (docs/map-compatibility.md): UnitStripHeroLevel
// (SetHeroLevelBJ going down), the XP handicap, UnitPauseTimedLife, UnitAddType /
// UnitRemoveType, the buff filters, UnitDamagePoint, CreateCorpse and ChooseRandomCreep.
//
// Each rule is jassbot's documentation, or the measurement the sim cites beside the code.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { rosterHooks } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));
const { UnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { xpToReachLevel } = require(join(REPO, ".sim-build", "src", "data", "gameplayConstants.js"));

// Unit TYPE rows: a footman, a tower (a building leaves no corpse), and a Kobold.
const TYPES = {
  hfoo: { priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2, classification: [], isBuilding: false },
  htow: { priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 1, classification: ["townhall"], isBuilding: true },
  nkob: { priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2, classification: [], isBuilding: false },
};
const N = 128;
const world = new SimWorld(
  new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
  { get: () => undefined, has: () => false, buffFx: () => [] },
  { get: () => undefined, has: () => false },
  { get: (id) => TYPES[id], has: (id) => id in TYPES },
);
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 500, y: 500, prevX: 500, prevY: 500,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    baseInvulnerable: false, neutralPassive: false, isIllusion: false, isSummon: false, isPeon: false, ancient: false,
    race: "human", level: 1, xp: 0, xpSuspended: false, skillPoints: 0, hpRegen: 0, manaRegen: 0,
    baseMaxHp: 1000, baseMaxMana: 0, baseHpRegen: 0, baseManaRegen: 0, baseArmor: 0, armor: 0,
    baseSpeed: 270, speed: 270, radius: 16, footprint: 0, order: "idle", targetId: null, path: [],
    waypoint: 0, moving: false, facing: 0, stunned: false, magicImmune: false, detectRadius: 0,
    summonLeft: 0, immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false,
    baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0,
    str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0, intPerLevel: 0, primaryAttr: "",
    armorType: "large", targClass: "ground", garrison: [], itemCooldowns: new Map(), linkT: 0, linkGroup: [], thorns: 0, rangedReduction: 0, magicReduction: 0, ethereal: false,
    orderQueue: [], silenced: false, morphT: 0, portalLeft: 0, hidden: false, summonMax: 0, weapon: null,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
let failed = 0;
function check(what, got, want) {
  const ok = typeof want === "number" && typeof got === "number" ? Math.abs(got - want) < 1e-6 : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}
// A hero ability row: rank r needs hero level reqLevel + 2·(r − 1).
const skill = (id, reqLevel, rank) => ({ id, code: id, level: rank, cooldownLeft: 0, autocastOn: false, def: { id, code: id, isHero: true, reqLevel, levelSkip: 2, levels: 3, levelData: [] } });

console.log("UnitStripHeroLevel");
{
  // Level 7: three ranks of A (1/3/5), two of B (1/3), the level-6 ultimate — six points spent,
  // one in hand.
  const h = unit({ isHero: true, level: 7, skillPoints: 1, xp: xpToReachLevel(7) + 10,
    abilities: [skill("A001", 1, 3), skill("A002", 1, 2), skill("A003", 6, 1)] });
  check("a strip that took levels answers true", world.stripHeroLevel(h.id, 3), true);
  check("…and the hero is level 4", h.level, 4);
  check("A's third rank needs level 5 and goes; B's second needs 3 and stays; the ultimate goes",
    h.abilities.map((a) => a.level), [2, 2, 0]);
  check("four levels pay for the four ranks left, and no point comes back", h.skillPoints, 0);
  check("the bar sits at level 4's threshold", h.xp, xpToReachLevel(4));
  check("a hero at level 1 cannot be stripped", world.stripHeroLevel(unit({ isHero: true, level: 1 }).id, 1), false);
  check("nor can a unit that is not a hero", world.stripHeroLevel(unit().id, 1), false);
  check("nor 0 levels", world.stripHeroLevel(h.id, 0), false);
  const n = unit({ isHero: true, level: 5, skillPoints: 5 });
  check("a NEGATIVE count answers false…", world.stripHeroLevel(n.id, -1), false);
  check("…and still takes the hero to 1", n.level, 1);
  check("…and the points with it (5 − 4)", n.skillPoints, 1);
  const s = unit({ isHero: true, level: 4, skillPoints: 0, abilities: [skill("A001", 1, 2), skill("A002", 1, 2)] });
  world.stripHeroLevel(s.id, 1);
  check("points short: EARLIER abilities in the list unlearn first", s.abilities.map((a) => a.level), [1, 2]);
}

console.log("\nthe XP handicap");
{
  check("a player's rate is 100 % until a script says otherwise", world.xpHandicap(3), 1);
  world.setXpHandicap(3, 0.5);
  check("…and reads back what it was set to", world.xpHandicap(3), 0.5);
  const full = unit({ isHero: true, owner: 0, team: 0, level: 1, x: 2000, y: 2000 });
  const half = unit({ isHero: true, owner: 3, team: 4, level: 1, x: 6000, y: 6000 });
  const v1 = unit({ owner: 1, team: 1, level: 2, x: 2000, y: 2000, hp: 0 });
  const v2 = unit({ owner: 1, team: 1, level: 2, x: 6000, y: 6000, hp: 0 });
  world.awardKillXp(v1, full.id);
  world.awardKillXp(v2, half.id);
  check("the same kill pays the halved player half", [full.xp > 0, half.xp * 2], [true, full.xp]);
}

console.log("\nUnitPauseTimedLife");
{
  const s = unit({ summonLeft: 5, summonMax: 5 });
  world.pauseTimedLife(s.id, true);
  world.tick(1);
  check("a paused clock stands still", s.summonLeft, 5);
  world.pauseTimedLife(s.id, false);
  world.tick(1);
  check("…and runs again when released", s.summonLeft, 4);
}

console.log("\nUnitAddType / UnitRemoveType — 9..20 only (hiveworkshop 218444)");
{
  const roster = rosterHooks(world, { get: (id) => TYPES[id] }, (p) => p);
  const u = unit({ mechanical: true, ancient: true });
  check("FLYING (3) cannot be removed", world.setUnitClassification(u.id, 3, false), false);
  check("MAGIC_IMMUNE (26) cannot either", world.setUnitClassification(u.id, 26, false), false);
  check("MECHANICAL (15) can", world.setUnitClassification(u.id, 15, false), true);
  check("…and the sim's own flag follows (Heal, corpses read it)", u.mechanical, false);
  world.setUnitClassification(u.id, 19, false);
  check("ANCIENT (19) goes, and IsUnitType says so", roster.isUnitType(u.id, 19, "hfoo"), false);
  world.setUnitClassification(u.id, 14, true);
  check("UNDEAD (14) added to a human answers true", roster.isUnitType(u.id, 14, "hfoo"), true);
  world.setUnitClassification(u.id, 16, true);
  check("PEON (16) makes it a worker", u.isPeon, true);
  check("TOWNHALL (18) off the type row", roster.isUnitType(unit({ typeId: "htow" }).id, 18, "htow"), true);
}

console.log("\nthe buff filters");
{
  const friend = unit({ team: 0 }), foe = unit({ team: 1 });
  const buffs = () => [
    { kind: "haste", sourceId: friend.id, timeLeft: 10, undispellable: false, tag: "bloodlust" },
    { kind: "slow", sourceId: foe.id, timeLeft: 10, undispellable: false, tag: "slow" },
    { kind: "armor", sourceId: friend.id, timeLeft: Infinity, undispellable: false, tag: "aura" },
    { kind: "dot", sourceId: foe.id, timeLeft: Infinity, undispellable: true, tag: "doom" },
    { kind: "stun", sourceId: 9999, timeLeft: 2, undispellable: false, tag: "orphan stun" },
  ];
  const q = (o) => ({ positive: false, negative: false, magic: false, physical: false, timedLife: true, aura: false, autoDispel: false, ...o });
  const t = unit({ team: 0 });
  const left = () => t.buffs.map((b) => b.tag);
  t.buffs = buffs();
  world.removeBuffs(t.id, q({ positive: true }));
  check("positive, no auras: only the ally's Bloodlust goes", left(), ["slow", "aura", "doom", "orphan stun"]);
  t.buffs = buffs();
  world.removeBuffs(t.id, q({ negative: true, aura: true }));
  check("negative with auras: the slow, Doom, and a stun whose caster is gone", left(), ["bloodlust", "aura"]);
  t.buffs = buffs();
  world.removeBuffs(t.id, q({ negative: true, aura: true, autoDispel: true }));
  check("…but only what a dispel may take: Doom stays", left(), ["bloodlust", "aura", "doom"]);
  t.buffs = buffs();
  world.removeBuffs(t.id, q({}));
  check("to REMOVE, neither polarity removes nothing", left().length, 5);
  check("to COUNT, neither polarity counts both (timed ones)", world.countBuffs(t.id, q({})), 3);
  check("physical alone counts nothing (no buff here is physical)", world.countBuffs(t.id, q({ physical: true })), 0);
  check("magic and physical both counts nothing", world.countBuffs(t.id, q({ magic: true, physical: true })), 0);
}

console.log("\nUnitDamagePoint");
{
  const src = unit({ team: 0, x: 3000, y: 3000 });
  const ally = unit({ team: 0, x: 3050, y: 3000 });
  const near = unit({ team: 1, x: 3100, y: 3000, armorType: "large" });
  const far = unit({ team: 1, x: 3400, y: 3000 });
  const opts = { attack: false, ranged: false, attackType: "chaos", magic: false, universal: true };
  check("a blast with a source is queued", world.damagePoint(src.id, 0.5, 200, 3000, 3000, 100, opts), true);
  world.tickPointDamage(0.3);
  check("nothing lands before the delay", near.hp, 1000);
  world.tickPointDamage(0.3);
  check("the enemy in the circle takes it", near.hp, 900);
  check("the ally beside it does not", ally.hp, 1000);
  check("the source does not", src.hp, 1000);
  check("the enemy outside the circle does not", far.hp, 1000);
  check("no source, no blast", world.damagePoint(99999, 0, 200, 0, 0, 100, opts), false);
}

console.log("\nCreateCorpse");
{
  const before = world.corpses.size;
  check("a footman leaves a body", world.createCorpse("hfoo", 700, 800, 2, 90), true);
  const c = [...world.corpses.values()].pop();
  check("…where it was asked, for that player, facing 90°", [world.corpses.size - before, c.x, c.y, c.owner, +c.facing.toFixed(4)], [1, 700, 800, 2, +(Math.PI / 2).toFixed(4)]);
  check("a building leaves none", world.createCorpse("htow", 0, 0, 0, 0), false);
}

console.log("\nChooseRandomCreep");
{
  const row = (id, o) => ({ id, level: 3, isHero: false, isBuilding: false, hostilePal: true, special: false, campaign: false, ...o });
  const reg = new UnitRegistry(new Map([
    ["nkob", row("nkob", {})],
    ["nhid", row("nhid", { special: true })], // hidden from the palette
    ["ncam", row("ncam", { campaign: true })], // campaign-only
    ["hfoo", row("hfoo", { hostilePal: false })], // not a creep
    ["ntow", row("ntow", { isBuilding: true })],
    ["Nher", row("Nher", { isHero: true })],
    ["nlv5", row("nlv5", { level: 5 })],
  ]));
  const draws = new Set();
  let r = 0;
  for (let i = 0; i < 20; i++) draws.add(reg.chooseRandomCreep(3, () => (r = (r + 0.37) % 1))?.id);
  check("level 3 draws only the one palette creep of that level", [...draws], ["nkob"]);
  check("level 5 draws its own", reg.chooseRandomCreep(5, () => 0)?.id, "nlv5");
  check("an empty level draws nothing", reg.chooseRandomCreep(9, () => 0), undefined);
  check("a negative level is any level", reg.chooseRandomCreep(-1, () => 0.99)?.id, "nlv5");
}

console.log(failed ? `\n${failed} FAILED` : "\nall script-native checks passed");
process.exit(failed ? 1 : 0);
