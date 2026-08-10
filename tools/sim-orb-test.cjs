// Headless check of ORB EFFECTS — the family of attack modifiers (orb items, the arrow
// abilities, Slow Poison, Feedback, Frost Attack) and the rule that only ONE of them may
// ride any one blow. See src/sim/orbs.ts and docs/orbs.md for the sources.
//
// The ladder under test (Liquipedia, Orb § Priority):
//   1. Arrows have the highest priority
//   2. Mask of Death has the highest priority of all items
//   3. Items have a higher priority than passive abilities
//   4. All orbs have the same priority
//   5. If multiple orbs are in one inventory, their position determines which is active
//
// Every number below is the real 1.30.4 one from Units\AbilityData.slk.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

const lvl = (o = {}) => ({
  cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0,
  data: new Array(9).fill(NaN), dataStr: new Array(9).fill(""), buffs: [], summon: "", ...o,
});
const abil = (id, code, level, o = {}) => ({
  id, code, levels: 1, levelData: [lvl(level)], missileArt: "", targetArt: "", targetAttach: [],
  casterArt: "", specialArt: "", buffFx: [], buffArt: "", ...o,
});

// --- the real rows -----------------------------------------------------------------
// Orb of Fire (`ofir` → AIfb): DataA 10 damage, Area 150 splash, DataE 2 = Enabled Attack Index.
const AIfb = abil("AIfb", "AIfb", { area: 150, data: [10, NaN, NaN, NaN, 2] }, { missileArt: "fireball", targetArt: "AIfbTarget", targetAttach: ["weapon"] });
// Orb of Frost (`ofro` → AIob): DataA 6, Dur 3 / HeroDur 1, buff Bfro.
const AIob = abil("AIob", "AIob", { duration: 3, heroDuration: 1, data: [6, NaN, NaN, NaN, 2] }, { missileArt: "lichmissile", targetArt: "AIobTarget", targetAttach: ["weapon"] });
// Orb of Corruption (`ocor` → AIcb): DataA 5, DataB 4 armour, Dur 5.
const AIcb = abil("AIcb", "AIcb", { duration: 5, heroDuration: 5, data: [5, 4, NaN, NaN, 2] });
// Mask of Death (`modt` → AIva): DataA 0.5 life stolen per attack, and NO DataE.
const AIva = abil("AIva", "AIva", { data: [0.5] });
// Searing Arrows (`AHfa`): DataA 10 damage, Cost 8 a shot.
const AHfa = abil("AHfa", "AHfa", { cost: 8, castRange: 600, data: [10] }, { missileArt: "searingarrow" });
// Slow Poison (`Aspo`, the Dryad's): DataA 4 dps, DataB 0.5 move, DataC 0.25 attack, Dur 5/1.
const Aspo = abil("Aspo", "Aspo", { duration: 5, heroDuration: 1, data: [4, 0.5, 0.25, 1] });
// Feedback (`Afbk`, Spell Breaker): 20 mana off a unit / 4 off a hero, ×1 as damage.
const Afbk = abil("Afbk", "Afbk", { castRange: 20, data: [20, 1, 4, 1, 0] });

const ABILITIES = Object.fromEntries([AIfb, AIob, AIcb, AIva, AHfa, Aspo, Afbk].map((a) => [a.id, a]));
const ITEMS = {
  ofir: { abilities: ["AIfb"] },
  ofro: { abilities: ["AIob"] },
  ocor: { abilities: ["AIcb"] },
  modt: { abilities: ["AIva"] },
};

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

function world() {
  const w = new SimWorld({ width: 4, height: 4, cell: 128, blocked: new Uint8Array(16) }, 1);
  w.abilities = { get: (id) => ABILITIES[id], all: () => Object.values(ABILITIES) };
  w.itemReg = { get: (id) => ITEMS[id] };
  return w;
}

let nextId = 1;
function unit(w, over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, x: 0, y: 0, hp: 1000, maxHp: 1000, mana: 100, maxMana: 100,
    buffs: [], abilities: [], inventory: [], weapons: [], arrowShot: null, blackArrow: null,
    incinerate: null, isHero: false, isSummon: false, building: null, mechanical: false,
    flying: false, invulnerable: false, neutralPassive: false, isIllusion: false, race: "human",
    typeId: "hfoo", level: 1, baseMaxHp: 1000, baseMaxMana: 100, baseArmor: 0, armor: 0,
    baseSpeed: 270, speed: 270, hpRegen: 0, manaRegen: 0, lifesteal: 0,
    ...over,
  };
  w.units.set(u.id, u);
  return u;
}
/** A six-slot hero inventory with `items` laid into the named slots. */
const bag = (pairs) => {
  const inv = new Array(6).fill(null);
  for (const [slot, itemId] of pairs) inv[slot] = { itemId, charges: 0 };
  return inv;
};

console.log("\nonly one orb effect rides a blow, and the ladder says which");
{
  // A Priestess with Searing Arrows ON and an Orb of Frost in the bag: the ARROW wins.
  const w = world();
  const hero = unit(w, { isHero: true, abilities: [{ id: "AHfa", code: "AHfa", level: 1, cooldownLeft: 0, autocastOn: true }], inventory: bag([[0, "ofro"]]) });
  const foe = unit(w, { owner: 1, team: 1 });
  check("arrows outrank an item orb", w.resolveOrb(hero, foe).def.id, "AHfa");
  check("…and the shot is drawn as the arrow's own missile", w.orbMissileArt(w.resolveOrb(hero, foe)), "searingarrow");
}
{
  // Same hero, autocast OFF: the arrow is not a candidate at all, so the orb takes over.
  const w = world();
  const hero = unit(w, { isHero: true, abilities: [{ id: "AHfa", code: "AHfa", level: 1, cooldownLeft: 0, autocastOn: false }], inventory: bag([[0, "ofro"]]) });
  const foe = unit(w, { owner: 1, team: 1 });
  check("an arrow that is switched off yields to the orb", w.resolveOrb(hero, foe).def.id, "AIob");
}
{
  // …and so does one the hero cannot pay for (Searing Arrows costs 8 a shot).
  const w = world();
  const hero = unit(w, { isHero: true, mana: 2, abilities: [{ id: "AHfa", code: "AHfa", level: 1, cooldownLeft: 0, autocastOn: true }], inventory: bag([[0, "ofro"]]) });
  const foe = unit(w, { owner: 1, team: 1 });
  check("an arrow with no mana for it yields to the orb", w.resolveOrb(hero, foe).def.id, "AIob");
  check("…and no mana was spent", hero.mana, 2);
}
{
  // Mask of Death is "the highest priority of all items" — even in a LOWER slot.
  const w = world();
  const hero = unit(w, { isHero: true, inventory: bag([[0, "modt"], [5, "ofro"]]) });
  const foe = unit(w, { owner: 1, team: 1 });
  check("Mask of Death outranks an orb in a later slot", w.resolveOrb(hero, foe).def.id, "AIva");
}
{
  // Two ordinary orbs: the LATER inventory slot wins (r/warcraft3, "Do two orbs cancel each
  // other's effect?" — slots 1 and 2 held, and the slot-2 orb is the one that fires).
  const w = world();
  const hero = unit(w, { isHero: true, inventory: bag([[0, "ofro"], [1, "ofir"]]) });
  const foe = unit(w, { owner: 1, team: 1 });
  check("between two orbs the later slot wins", w.resolveOrb(hero, foe).def.id, "AIfb");
  const hero2 = unit(w, { isHero: true, inventory: bag([[0, "ofir"], [4, "ofro"]]) });
  check("…whichever pair it is", w.resolveOrb(hero2, foe).def.id, "AIob");
}
{
  // "Items have a higher priority than passive abilities": a Dryad handed an orb loses her
  // Slow Poison for as long as she carries it.
  const w = world();
  const dryad = unit(w, { abilities: [{ id: "Aspo", code: "Aspo", level: 1, cooldownLeft: 0, autocastOn: false }], inventory: bag([[2, "ofro"]]) });
  const foe = unit(w, { owner: 1, team: 1 });
  check("an item orb switches a passive orb off", w.resolveOrb(dryad, foe).def.id, "AIob");
  const bare = unit(w, { abilities: [{ id: "Aspo", code: "Aspo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  check("…and without it the passive is back", w.resolveOrb(bare, foe).def.id, "Aspo");
}

console.log("\nwhat the winning orb actually does");
{
  const w = world();
  const hero = unit(w, { isHero: true, inventory: bag([[0, "ofro"]]) });
  const foe = unit(w, { owner: 1, team: 1 });
  w.applyOrbEffect(hero, foe, w.resolveOrb(hero, foe), 20);
  const slow = foe.buffs.find((b) => b.group === "frostattack");
  check("Orb of Frost hangs the generic Slowed buff", !!slow, true);
  check("…at 50% movement (Liquipedia, Infobox_Buff/Slowed)", slow.value, 0.5);
  check("…and 25% attack speed", slow.value2, 0.25);
  check("…for the row's 3s on a unit", slow.timeLeft, 3);
  const enemyHero = unit(w, { owner: 1, team: 1, isHero: true });
  w.applyOrbEffect(hero, enemyHero, w.resolveOrb(hero, enemyHero), 20);
  check("…and its 1s HeroDur on a hero", enemyHero.buffs.find((b) => b.group === "frostattack").timeLeft, 1);
}
{
  // Orb of Corruption strips armour BEFORE the blow it rode in on.
  const w = world();
  const hero = unit(w, { isHero: true, inventory: bag([[0, "ocor"]]) });
  const foe = unit(w, { owner: 1, team: 1, baseArmor: 5, armor: 5 });
  w.applyOrbArmorFirst(hero, foe, w.resolveOrb(hero, foe));
  check("Orb of Corruption's -4 armour is live before the damage", foe.armor, 1);
}
{
  const w = world();
  const hero = unit(w, { isHero: true, hp: 500, inventory: bag([[0, "modt"]]) });
  const foe = unit(w, { owner: 1, team: 1 });
  w.applyOrbEffect(hero, foe, w.resolveOrb(hero, foe), 40);
  check("Mask of Death heals half the damage dealt", hero.hp, 520);
}
{
  // Feedback burns 20 off a unit and 4 off a hero, dealing that much damage.
  const w = world();
  const breaker = unit(w, { abilities: [{ id: "Afbk", code: "Afbk", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const caster = unit(w, { owner: 1, team: 1, mana: 100, hp: 500 });
  w.applyOrbEffect(breaker, caster, w.resolveOrb(breaker, caster), 10);
  check("Feedback burns 20 mana off a unit", caster.mana, 80);
  check("…and deals it back as damage", caster.hp, 480);
  const enemyHero = unit(w, { owner: 1, team: 1, isHero: true, mana: 100, hp: 500 });
  w.applyOrbEffect(breaker, enemyHero, w.resolveOrb(breaker, enemyHero), 10);
  check("a HERO only loses the row's 4", enemyHero.mana, 96);
}
{
  // Poison is non-lethal: it whittles and stops at 1 hp.
  const w = world();
  const dryad = unit(w, { abilities: [{ id: "Aspo", code: "Aspo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const foe = unit(w, { owner: 1, team: 1, hp: 10 });
  w.applyOrbEffect(dryad, foe, w.resolveOrb(dryad, foe), 5);
  for (let i = 0; i < 5; i++) w.tickBuffs(foe, 1);
  check("Slow Poison cannot land the killing blow", foe.hp, 1);
}
{
  // Stacking Types (`Aspo` DataD = 1 = the Damage bit): two Dryads' poison ADDS, one Dryad's
  // second hit only refreshes. The slow half carries neither the Movement nor the Attack
  // Rate bit, so it stays a single buff either way.
  const w = world();
  const a = unit(w, { abilities: [{ id: "Aspo", code: "Aspo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const b2 = unit(w, { abilities: [{ id: "Aspo", code: "Aspo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const foe = unit(w, { owner: 1, team: 1 });
  w.applyOrbEffect(a, foe, w.resolveOrb(a, foe), 5);
  w.applyOrbEffect(a, foe, w.resolveOrb(a, foe), 5);
  check("one Dryad's poison is one dot however often she hits", foe.buffs.filter((x) => x.kind === "dot").length, 1);
  w.applyOrbEffect(b2, foe, w.resolveOrb(b2, foe), 5);
  check("a SECOND Dryad's poison stacks (the Damage bit is set)", foe.buffs.filter((x) => x.kind === "dot").length, 2);
  check("…but the slow does not", foe.buffs.filter((x) => x.kind === "slow").length, 1);
  check("no buff group contains a colon (that would read as an aura)", foe.buffs.filter((x) => x.group.includes(":")).length, 0);
}
{
  // A blow that did not connect carries nothing ("Missing an Attack does not trigger the
  // reduction" — Liquipedia, Orb of Corruption).
  const w = world();
  const hero = unit(w, { isHero: true, inventory: bag([[0, "ofro"]]) });
  const foe = unit(w, { owner: 1, team: 1 });
  w.applyOrbEffect(hero, foe, w.resolveOrb(hero, foe), 0);
  check("a missed swing applies no orb effect", foe.buffs.length, 0);
}

console.log("\ncarrying an orb, as opposed to winning with one");
{
  // The damage bonus is a CARRIED stat — "Adds <DataA> bonus damage… when carried" — so two
  // orbs give two bonuses even though only one effect fires.
  const w = world();
  const one = unit(w, { isHero: true, inventory: bag([[0, "ofir"]]) });
  const two = unit(w, { isHero: true, inventory: bag([[0, "ofir"], [1, "ofro"]]) });
  check("one orb is +10 damage", w.itemBonuses(one).damage, 10);
  check("two orbs stack to +16", w.itemBonuses(two).damage, 16);
  check("Mask of Death adds no damage", w.itemBonuses(unit(w, { isHero: true, inventory: bag([[0, "modt"]]) })).damage, 0);
}
{
  // "Enabled Attack Index" = 2 → the hero's dormant second weapon (ranged, hits air).
  const w = world();
  const armed = unit(w, { isHero: true, inventory: bag([[3, "ofro"]]) });
  check("an orb switches attack index 2 on", w.itemBonuses(armed).weaponsOn, 0b10);
  check("…and the Mask of Death does not", w.itemBonuses(unit(w, { isHero: true, inventory: bag([[3, "modt"]]) })).weaponsOn, 0);
}
{
  // The orb worn on the weapon hand: not exclusive, so both show.
  const w = world();
  const hero = unit(w, { isHero: true, inventory: bag([[0, "ofir"], [1, "ofro"]]) });
  check("both carried orbs are worn", w.orbAttachments(hero).map((f) => f.path), ["AIfbTarget", "AIobTarget"]);
  check("…on the weapon bone", w.orbAttachments(hero)[0].attach, ["weapon"]);
  check("Mask of Death wears nothing (its Targetart is blank)", w.orbAttachments(unit(w, { isHero: true, inventory: bag([[0, "modt"]]) })).length, 0);
}

console.log(`\n${failed ? `${failed} FAILED` : "orbs: all checks passed"}`);
process.exit(failed ? 1 : 0);
