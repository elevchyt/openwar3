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
  casterArt: "", specialArt: "", buffFx: [], buffArt: "", targetFlags: [], ...o,
});

// --- the real rows -----------------------------------------------------------------
// Orb of Fire (`ofir` → AIfb): DataA 10 damage, Area 150 splash, DataE 2 = Enabled Attack Index.
const AIfb = abil("AIfb", "AIfb", { area: 150, data: [10, NaN, NaN, NaN, 2] }, { missileArt: "fireball", targetArt: "AIfbTarget", targetAttach: ["weapon"], targetFlags: ["ground", "air", "ward"] });
// Orb of Frost (`ofro` → AIob): DataA 6, Dur 3 / HeroDur 1, buff Bfro.
const AIob = abil("AIob", "AIob", { duration: 3, heroDuration: 1, data: [6, NaN, NaN, NaN, 2] }, { missileArt: "lichmissile", targetArt: "AIobTarget", targetAttach: ["weapon"], targetFlags: ["ground", "air", "ward"] });
// Orb of Corruption (`ocor` → AIcb): DataA 5, DataB 4 armour, Dur 5.
const AIcb = abil("AIcb", "AIcb", { duration: 5, heroDuration: 5, data: [5, 4, NaN, NaN, 2] }, { targetFlags: ["ground", "air", "ward"] });
// Mask of Death (`modt` → AIva): DataA 0.5 life stolen per attack, and NO DataE.
// Its `[AIva] Specialart` is VampiricAuraTarget — "special art played on hero when ability fires".
const AIva = abil("AIva", "AIva", { data: [0.5] }, { specialArt: "VampiricAuraTarget", targetFlags: ["air", "ground", "enemy"] });
// Searing Arrows (`AHfa`): DataA 10 damage, Cost 8 a shot.
const AHfa = abil("AHfa", "AHfa", { cost: 8, castRange: 600, data: [10] }, { missileArt: "searingarrow", targetFlags: ["air", "ground", "structure", "enemy", "neutral"] });
// Cold Arrows (`AHca`): DataA 5 damage, DataB/DataC 0.3 move/attack slow, Dur 6/1, Cost 8 a
// shot — and `targs1` = air,ground,enemy,neutral, with no `friend`, no `self`, no `structure`.
const AHca = abil("AHca", "AHca", { cost: 8, castRange: 700, duration: 6, heroDuration: 1, data: [5, 0.3, 0.3, 7] }, { missileArt: "frostarrow", targetFlags: ["air", "ground", "enemy", "neutral"] });
// Slow Poison (`Aspo`, the Dryad's): DataA 4 dps, DataB 0.5 move, DataC 0.25 attack, Dur 5/1.
const Aspo = abil("Aspo", "Aspo", { duration: 5, heroDuration: 1, data: [4, 0.5, 0.25, 1] }, { targetFlags: ["air", "ground", "organic"] });
// Feedback (`Afbk`, Spell Breaker): 20 mana off a unit / 4 off a hero, ×1 as damage.
const Afbk = abil("Afbk", "Afbk", { castRange: 20, data: [20, 1, 4, 1, 0] }, { targetFlags: ["air", "ground", "enemy", "neutral"] });

// Black Arrow (`ANba`, Dark Ranger): DataA 2 bonus damage, DataB 1 minion of UnitID1 `ndr1`
// for DataC 80 s, Dur 2 — `targs1` air,ground,enemy,organic,neutral.
const ANba = abil("ANba", "ANba", { cost: 6, castRange: 600, duration: 2, data: [2, 1, 80], summon: "ndr1" }, { targetFlags: ["air", "ground", "enemy", "organic", "neutral"] });

// Orb of Annihilation (`Afak`, Destroyer): DataA 15 bonus, DataB 0.45 "Medium Damage Factor",
// DataC 0.25 "Small Damage Factor", DataD 1 "Full Damage Radius", DataE 75 "Half Damage
// Radius", Area1 150.
const Afak = abil("Afak", "Afak", { area: 150, data: [15, 0.45, 0.25, 1, 75] }, { targetFlags: ["air", "ground", "structure", "enemy", "neutral"] });

const ABILITIES = Object.fromEntries([AIfb, AIob, AIcb, AIva, AHfa, AHca, Aspo, Afbk, ANba, Afak].map((a) => [a.id, a]));
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
  // …and the drink flashes on the HERO, not on the unit it drank from (issue #193).
  const fx = w.drainSpellEffects().filter((e) => e.art === "VampiricAuraTarget");
  check("…flashing VampiricAuraTarget on the carrier", fx.map((e) => e.targetId), [hero.id]);
}
{
  // "make sure that mask of death only works when fighting units and not when attacking
  // buildings" (issue #193): `targs1` air,ground,enemy names no `structure`, so on a
  // building the Mask is not the blow's orb at all — no heal, no flash.
  const w = world();
  const hero = unit(w, { isHero: true, hp: 500, inventory: bag([[0, "modt"]]) });
  const farm = unit(w, { owner: 1, team: 1, building: { footprint: 2 }, typeId: "hhou" });
  const orb = w.resolveOrb(hero, farm);
  check("on a building the Mask is no orb", orb?.def.id ?? null, null);
  w.applyOrbEffect(hero, farm, orb, 40);
  check("…heals nothing", hero.hp, 500);
  check("…and flashes nothing", w.drainSpellEffects().length, 0);
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

console.log("\nBlack Arrow: the arrow that KILLS raises a Dark Minion too");
// What applyDamage → kill() reads off a body beyond the orb fields above.
const BODY = { linkT: 0, linkGroup: [], garrison: [], ethereal: false, thorns: 0, summonLeft: 0, constructing: null, inMine: false, resId: 0, order: "idle", facing: 0, radius: 16 };
{
  // The Sunhoof Mesa report: with autocast on, a creep the arrow itself dropped left no
  // skeleton — the mark was laid after the blow and only on a unit still standing, so only
  // a creep marked by an EARLIER arrow ever rose. The killing blow is what the spell is for.
  const w = world();
  const ranger = unit(w, { isHero: true, abilities: [{ id: "ANba", code: "ANba", level: 1, cooldownLeft: 0, autocastOn: true }] });
  const pig = unit(w, { owner: 12, team: 12, hp: 5, maxHp: 50, typeId: "npig", ...BODY });
  const orb = w.resolveOrb(ranger, pig);
  check("the arrow is the blow's orb", orb?.def.id ?? null, "ANba");
  w.applyOrbArmorFirst(ranger, pig, orb);
  const dealt = w.applyDamage(pig, 20, ranger.id, "hero", "", true);
  w.applyOrbEffect(ranger, pig, orb, dealt);
  check("the arrow killed the creep", pig.hp <= 0, true);
  check("…and a Dark Minion is raised for the Dark Ranger's owner", w.summonRequests.map((r) => [r.unitId, r.owner, r.summonLeft]), [["ndr1", 0, 80]]);
  check("…and nothing of the blow is left behind", w.arrowBlow, null);
}
{
  // A creep the arrow merely wounds is MARKED, and dies to anybody's blow inside the 2 s.
  const w = world();
  const ranger = unit(w, { isHero: true, abilities: [{ id: "ANba", code: "ANba", level: 1, cooldownLeft: 0, autocastOn: true }] });
  const foe = unit(w, { owner: 12, team: 12, hp: 500, maxHp: 500, ...BODY });
  const orb = w.resolveOrb(ranger, foe);
  w.applyOrbArmorFirst(ranger, foe, orb);
  w.applyOrbEffect(ranger, foe, orb, w.applyDamage(foe, 20, ranger.id, "hero", "", true));
  check("a wounding arrow leaves the mark", !!foe.blackArrow && foe.buffs.some((b) => b.group === "blackarrow"), true);
  check("…and raises nothing yet", w.summonRequests.length, 0);
}
{
  // A blow that misses carries no arrow, and leaves nothing pending for the next death.
  const w = world();
  const ranger = unit(w, { isHero: true, abilities: [{ id: "ANba", code: "ANba", level: 1, cooldownLeft: 0, autocastOn: true }] });
  const foe = unit(w, { owner: 12, team: 12, hp: 500, maxHp: 500 });
  const orb = w.resolveOrb(ranger, foe);
  w.applyOrbArmorFirst(ranger, foe, orb);
  w.applyOrbEffect(ranger, foe, orb, 0);
  check("a missed arrow marks nothing", foe.blackArrow, null);
  check("…and holds no arrow over to the next blow", w.arrowBlow, null);
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

console.log("\nwho a blow may carry an orb TO (Targets Allowed, targs1)");
{
  // THE FRIENDLY BLOW. Cold Arrows is `air,ground,enemy,neutral` — no `friend`, no `self` —
  // and no orb in the family lists one either. Autocast used to duck this gate: picking an
  // autocast target went through Targets Allowed, but a blow the player ordered by hand did
  // not, so arrows-on froze an ally the ability's own data forbids. The swing still happens;
  // it is simply an ORDINARY attack, and the 8 mana a shot is not spent on it.
  const w = world();
  const hero = unit(w, { isHero: true, mana: 100, abilities: [{ id: "AHca", code: "AHca", level: 1, cooldownLeft: 0, autocastOn: true }] });
  const friend = unit(w, { owner: 0, team: 0 });
  check("an arrow does not ride a blow at a friendly unit", w.resolveOrb(hero, friend), null);
  check("…and the shot costs no mana", hero.mana, 100);
  const foe = unit(w, { owner: 1, team: 1 });
  check("…while the same arrow rides a blow at an enemy", w.resolveOrb(hero, foe).def.id, "AHca");
  check("…and that one is paid for", hero.mana, 92);
}
{
  // An ally with an ORB in the bag rather than an arrow: same answer, from the family rule
  // (the item rows name no allegiance at all — `ground,air,ward`).
  const w = world();
  const hero = unit(w, { isHero: true, inventory: bag([[0, "ofro"]]) });
  check("an item orb does not ride a friendly blow either", w.resolveOrb(hero, unit(w, { owner: 0, team: 0 })), null);
  check("…but does ride a hostile one", w.resolveOrb(hero, unit(w, { owner: 1, team: 1 })).def.id, "AIob");
}
{
  // The KIND half of the same table, and why the two arrows differ: Searing Arrows lists
  // `structure`, Cold Arrows does not. So the Priestess sets a tower alight and the Sea
  // Witch's shot lands on it bare.
  const w = world();
  const tower = unit(w, { owner: 1, team: 1, building: {} });
  const searing = unit(w, { isHero: true, abilities: [{ id: "AHfa", code: "AHfa", level: 1, cooldownLeft: 0, autocastOn: true }] });
  const cold = unit(w, { isHero: true, abilities: [{ id: "AHca", code: "AHca", level: 1, cooldownLeft: 0, autocastOn: true }] });
  check("Searing Arrows fires at a building (targs1 lists structure)", w.resolveOrb(searing, tower).def.id, "AHfa");
  check("Cold Arrows does not (it does not)", w.resolveOrb(cold, tower), null);
  // …and the same gate is where "vampiric does not drain buildings" comes from: the Mask of
  // Death's `AIva` is `air,ground,enemy`, with no `structure` in it.
  const masked = unit(w, { isHero: true, inventory: bag([[0, "modt"]]) });
  check("the Mask of Death steals nothing from a building", w.resolveOrb(masked, tower), null);
}

console.log("\nFrost Armor: 45 seconds of armour, and a slow for whoever swings at it (issue #284)");
{
  // The real rows. [AUfu]: Dur 4 / HeroDur 4 is the SLOW, DataA 45 the "Armor Duration",
  // DataB 3/5/7 the "Armor Bonus" (AbilityMetaData Ufa1/Ufa2). The creep's [ACf2] is the same
  // code with a 5-second slow. `[BUfa] Specialart` is the chill on the attacker.
  const frostLvl = (dur, armor) => lvl({ cost: 40, castRange: 800, duration: dur, heroDuration: dur, data: [45, armor] });
  const AUfu = { ...abil("AUfu", "AUfu", {}, { buffSpecialArt: "FrostArmorDamage", buffSpecialAttach: ["chest"], targetFlags: ["air", "ground", "friend", "self", "neutral"] }),
    levels: 3, levelData: [frostLvl(4, 3), frostLvl(4, 5), frostLvl(4, 7)] };
  const ACf2 = abil("ACf2", "AUfu", { cost: 40, castRange: 800, duration: 5, heroDuration: 5, data: [45, 3] }, { buffSpecialArt: "FrostArmorDamage", targetFlags: ["air", "ground", "friend", "self", "neutral"] });
  const w = world();
  const rows = { AUfu, ACf2 };
  w.abilities = { get: (id) => rows[id], all: () => Object.values(rows), buffFx: (id) => (id === "Bfro" ? [{ path: "FrostDamage", attach: [] }] : []) };
  const lich = unit(w, { isHero: true });
  const ghoul = unit(w);
  w.applySpellEffect("AUfu", 2, lich, { targetId: ghoul.id }, AUfu);
  const shield = ghoul.buffs.find((b) => b.group === "frostarmor");
  check("the shield lasts DataA — 45 s, not the 4 s of Dur1", shield.timeLeft, 45);
  check("…and adds the rank's DataB armour", [shield.kind, shield.value], ["armor", 5]);

  const footman = unit(w, { owner: 1, team: 1 });
  w.applyFrostArmorChill(footman, ghoul);
  const chill = footman.buffs.find((b) => b.kind === "slow");
  check("a melee attacker takes the generic Slowed buff", [chill.buffId, chill.art], ["Bfro", "FrostDamage"]);
  check("…at the frost constants (MiscGame FrostMoveSpeedDecrease / FrostAttackSpeedDecrease)", [chill.value, chill.value2], [0.5, 0.25]);
  check("…for the row's Dur1 = 4 s", chill.timeLeft, 4);
  check("…with [BUfa] Specialart flashed on the ATTACKER", w.spellEffects.filter((e) => e.art === "FrostArmorDamage").map((e) => e.targetId), [footman.id]);
  check("an unshielded unit chills nobody", (w.applyFrostArmorChill(ghoul, footman), ghoul.buffs.some((b) => b.kind === "slow")), false);

  // The creep row: same code, its own 5-second slow.
  const ogre = unit(w, { owner: 2, team: 2 });
  w.applySpellEffect("AUfu", 1, ogre, { targetId: ogre.id }, ACf2);
  const grunt = unit(w, { owner: 1, team: 1 });
  w.applyFrostArmorChill(grunt, ogre);
  check("the creep Frost Armor (ACf2) slows for ITS Dur1 = 5 s", grunt.buffs.find((b) => b.kind === "slow").timeLeft, 5);
  check("the plain code AUfa (the creeps' ACfa) has the same handler", typeof require(join(REPO, ".sim-build", "src", "sim", "spells.js")).SPELL_HANDLERS.AUfa, "function");
}

console.log("\nOrb of Annihilation splashes in three bands (issue #366)");
{
  const w = world();
  const destroyer = unit(w, { abilities: [{ id: "Afak", code: "Afak", level: 1, cooldownLeft: 0, autocastOn: true }] });
  const foe = unit(w, { owner: 1, team: 1, x: 500, radius: 16 });
  const half = unit(w, { owner: 1, team: 1, x: 500 + 16 + 60, radius: 16 }); // hull 60 out: inside DataE 75
  const small = unit(w, { owner: 1, team: 1, x: 500 + 16 + 120, radius: 16 }); // hull 120 out: inside Area1 150
  const out = unit(w, { owner: 1, team: 1, x: 500 + 16 + 200, radius: 16 }); // past the outer ring
  const orb = w.resolveOrb(destroyer, foe);
  check("the Destroyer's blow carries the orb", orb?.def?.id ?? orb?.id ?? null, "Afak");
  w.applyOrbEffect(destroyer, foe, orb, 20);
  check("the target takes DataA 15", 1000 - foe.hp, 15);
  check("…inside DataE 75, DataB 0.45 of it", Math.round((1000 - half.hp) * 100) / 100, 6.75);
  check("…out to Area1 150, DataC 0.25 of it", Math.round((1000 - small.hp) * 100) / 100, 3.75);
  check("…and nothing past it", 1000 - out.hp, 0);
}

console.log(`\n${failed ? `${failed} FAILED` : "orbs: all checks passed"}`);
process.exit(failed ? 1 : 0);
