// Headless check of the generic FORM TOGGLE — Burrow (`Abur`) and the mechanism behind every
// other two-form ability (Bear/Crow/Stone/Destroyer/Ethereal Form, Submerge).
//
// The thing worth pinning is that a form is not a state we model but a UNIT the ability names,
// so the toggle is a morph and the target unit's own row supplies the behaviour. If that holds,
// nobody ever has to write "a burrowed Crypt Fiend cannot move" in code.
//
// Real 1.27a rows (Units\AbilityData.slk; column meanings from AbilityMetaData.slk through
// UI\WorldEditStrings.txt):
//   DataA   "Normal Form Unit"     Abur = ucry, Abu2 = ucs2, Aetf = ospw
//   UnitID1 "Alternate Form Unit"  Abur = ucrm, Abu2 = ucsB, Aetf = ospm
//
// And the two Crypt Fiend rows from Units\UnitBalance.slk / UnitWeapons.slk:
//   ucry  spd 270  regenHP 2  weapsOn 1     the walking Fiend
//   ucrm  spd "-"  regenHP 5  weapsOn 0     burrowed: immobile, unarmed, healing faster
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
// A unit's live weapon slots come from the SAME builder the morph uses, so a stub can't
// disagree with what morphUnit will hand the unit on the other side. (Hand-rolled slots used
// the SIM-side field names — `baseDamage`/`baseRange` — which weaponsFromDef does not read, so
// every morphed unit in this file silently came out unarmed and nothing asserted otherwise.)
const simWeapons = (d) => weaponsFromDef(d);
// Build ranks from the real blank rather than a literal — a stub that spells the shape out
// by hand drifts from AbilityLevel the moment a field is added (see jass-corpus-test 7.8).
const { emptyAbilityLevel } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const lvl = (over) => ({ ...emptyAbilityLevel(), ...over });

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** The two Crypt Fiend forms, with the fields morphUnit actually reads off a UnitDef.
 *  edoc/edcm are the Druid of the Claw and his bear — the pair that proves the type's WHOLE
 *  sheet has to follow the morph, not just the visible stats: hp 430→810, def 1→3,
 *  dmgplus 18→26, castpt 0.5→0.3, castbsw 1.17→0.51, and a mana pool of 200 on BOTH sides
 *  (Units\UnitBalance.slk + UnitWeapons.slk, 1.27a). */
const UNITS = {
  hpea: { id: "hpea", acquireRange: 500, hitPoints: 220, armor: 0, armorType: "medium", sightDay: 1800, sightNight: 800, speed: 190, abilities: ["Ahar", "Amil"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 4, dice: 1, sides: 2, cooldown: 2.0, damagePoint: 0.3, backswing: 0.51, range: 90, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  hmil: { id: "hmil", acquireRange: 500, hitPoints: 220, armor: 4, armorType: "large", sightDay: 1800, sightNight: 800, speed: 270, abilities: ["Ahar", "Amil"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 11, dice: 1, sides: 2, cooldown: 2.0, damagePoint: 0.3, backswing: 0.51, range: 90, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  ucry: { id: "ucry", acquireRange: 500, hitPoints: 550, armor: 0, armorType: "medium", sightDay: 1800, sightNight: 800, speed: 270, abilities: ["Aweb", "Aspa", "Abur"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 26, dice: 1, sides: 4, cooldown: 1.9, damagePoint: 0.3, backswing: 0.51, range: 550, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  ucrm: { id: "ucrm", acquireRange: 500, hitPoints: 550, armor: 0, armorType: "medium", sightDay: 1800, sightNight: 800, speed: 0, abilities: ["Aspa", "Abur"], heroAbilities: [], autoAbility: "", weapons: [] },
  edoc: { id: "edoc", acquireRange: 500, hitPoints: 430, mana: 200, armor: 1, armorType: "large", sightDay: 1400, sightNight: 800, speed: 270, castPoint: 0.5, castBackswing: 1.17, abilities: ["Abrf", "Arej"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 18, dice: 1, sides: 4, cooldown: 1.5, damagePoint: 0.33, backswing: 0.53, range: 100, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  edcm: { id: "edcm", acquireRange: 500, hitPoints: 810, mana: 200, armor: 3, armorType: "large", sightDay: 1400, sightNight: 800, speed: 270, castPoint: 0.3, castBackswing: 0.51, abilities: ["Abrf", "Arej"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 26, dice: 1, sides: 6, cooldown: 1.5, damagePoint: 0.5, backswing: 0.83, range: 100, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
};
const unitReg = { get: (id) => UNITS[id] };

// Only the two columns the toggle reads. `summon` is UnitID1 — that is where the parser puts
// it (str(r, `unitid${L}`)), which is why the alternate form arrives under that name.
const ABILS = {
  Abur: { id: "Abur", code: "Abur", levelData: [lvl({ dataStr: ["ucry"], summon: "ucrm" })] },
  // Call to Arms puts its alternate form in DataB and carries a 45s duration — the two ways
  // it differs from Burrow, and the two things altFormOf/tickAltForm exist for.
  Amil: { id: "Amil", code: "Amil", levelData: [lvl({ dataStr: ["hpea", "hmil"], duration: 45 })] },
  // Bear Form — the same two columns again, on a pair that carries mana.
  Abrf: { id: "Abrf", code: "Abrf", levelData: [lvl({ dataStr: ["edoc"], summon: "edcm" })] },
};
const abilReg = { get: (id) => ABILS[id] };

const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1, abilReg, undefined, unitReg);

function fiend(typeId = "ucry") {
  const d = UNITS[typeId];
  const u = {
    id: 1, owner: 0, team: 0, hp: 400, maxHp: 550, mana: 0, maxMana: 0, x: 0, y: 0, prevX: 0, prevY: 0, typeId,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0, altModel: false,
    inventory: [], buffs: [], footprint: 0, hasReservation: false, etherealForm: false,
    abilities: [{ id: "Abur", code: "Abur", level: 1, cooldownLeft: 0, autocastOn: false }],
    weapons: simWeapons(d),
    weapon: null, order: "idle", targetId: null, path: [], moving: false,
    baseArmor: 0, baseMaxHp: 550, baseMaxMana: 0, baseSpeed: d.speed, baseSight: 1800,
    baseSightDay: 1800, baseSightNight: 800, armorType: "medium",
  };
  u.weapon = u.weapons.find((w) => w.enabled) ?? null;
  world.units.set(u.id, u);
  return u;
}

// --- burrowing -------------------------------------------------------------------------
{
  const u = fiend();
  world.recomputeStats(u);
  check("a Crypt Fiend starts walking", u.typeId, "ucry");
  check("…at its own speed", u.speed, 270);
  check("…armed", !!u.weapon, true);

  check("it burrows", world.morphToggle(u, ABILS.Abur), true);
  world.recomputeStats(u);
  check("…becoming the burrowed unit", u.typeId, "ucrm");
  // Nothing below is coded anywhere — it is ucrm's own row doing the work.
  check("…which cannot move (ucrm spd \"-\")", u.speed, 0);
  check("…and cannot attack (ucrm weapsOn 0)", u.weapon, null);
  check("…and has lost Web, keeping Burrow to dig out", u.abilities.map((a) => a.id).sort(), ["Abur"]);

  // Both forms are the SAME MDX (ucrm is CryptFiend.mdx), so the burrowed unit also wears the
  // alternate half of the model — the underground pose. The renderer reads only this flag.
  check("…and wears the alternate half of its model", u.altModel, true);

  check("it digs out again", world.morphToggle(u, ABILS.Abur), true);
  world.recomputeStats(u);
  check("…back to the walking Fiend", u.typeId, "ucry");
  check("…mobile once more", u.speed, 270);
  // Armed with a REAL slot, not merely a non-null one: the numbers have to be ucry's own
  // (dmgplus 26, rangeN1 550). `!!u.weapon` alone passed for years against a slot whose every
  // field was undefined, which is exactly how the stub drift went unnoticed.
  check("…and armed again", [u.weapon.baseDamage, u.weapon.baseRange], [26, 550]);
  check("…back on the plain half of the model", u.altModel, false);
}

// Health carries across as a FRACTION, not a number: morphUnit's rule. Both Crypt Fiend forms
// have 550 max, so a wounded one stays exactly as wounded as it was.
{
  const u = fiend();
  u.hp = 275; // half
  world.morphToggle(u, ABILS.Abur);
  check("burrowing preserves the wound", Math.round(u.hp), 275);
}

// The pair can be entered from EITHER side — several of these units are trained already in
// their alternate form, so the toggle reads the direction off the unit rather than tracking it.
{
  const u = fiend("ucrm");
  check("a unit that starts burrowed digs OUT", world.morphToggle(u, ABILS.Abur), true);
  check("…to the normal form", u.typeId, "ucry");
}

// A row naming a form this install doesn't ship is refused rather than half-applied.
{
  const u = fiend();
  const broken = { id: "Abur", code: "Abur", levelData: [lvl({ dataStr: ["ucry"], summon: "nope" })] };
  check("an unknown alternate form is refused", world.morphToggle(u, broken), false);
  check("…leaving the unit exactly as it was", u.typeId, "ucry");
}

// A row missing the columns entirely (a non-morph ability handed to the toggle) does nothing.
{
  const u = fiend();
  const empty = { id: "X", code: "X", levelData: [lvl()] };
  check("a row naming no forms is refused", world.morphToggle(u, empty), false);
}
// --- Call to Arms: the alternate form in DataB, and a form on a clock -------------------

function peasant(id, typeId = "hpea") {
  const d = UNITS[typeId];
  const u = {
    id, owner: 0, team: 0, hp: 220, maxHp: 220, mana: 0, maxMana: 0, x: 0, y: 0, prevX: 0, prevY: 0, typeId,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0,
    altModel: false, altFormLeft: 0, altFormAbil: "",
    inventory: [], buffs: [], footprint: 0, hasReservation: false, etherealForm: false,
    abilities: [{ id: "Amil", code: "Amil", level: 1, cooldownLeft: 0, autocastOn: false }],
    weapons: simWeapons(d),
    weapon: null, order: "idle", targetId: null, path: [], moving: false,
    baseArmor: d.armor, baseMaxHp: 220, baseMaxMana: 0, baseSpeed: d.speed, baseSight: 1800,
    baseSightDay: 1800, baseSightNight: 800, armorType: d.armorType,
  };
  u.weapon = u.weapons.find((w) => w.enabled) ?? null;
  world.units.set(u.id, u);
  return u;
}

{
  const u = peasant(10);
  world.recomputeStats(u);
  check("a Peasant starts as a Peasant", u.typeId, "hpea");
  // The alternate form is in DataB here, NOT UnitID1 — reading UnitID1 alone finds nothing.
  check("the bell calls him up", world.morphToggle(u, ABILS.Amil), true);
  world.recomputeStats(u);
  check("…he becomes a militia", u.typeId, "hmil");
  // Again: none of this is coded, it is hmil's row.
  check("…faster (hmil spd 270)", u.speed, 270);
  check("…better armoured (hmil def 4)", u.baseArmor, 4);
  check("…and the 45s clock is running (Amil Dur1)", u.altFormLeft, 45);
  check("…through the ability that owns both ids", u.altFormAbil, "Amil");
}

// The clock runs out and he goes back to work on his own, wherever he is standing.
{
  const u = peasant(11);
  world.morphToggle(u, ABILS.Amil);
  world.tickAltForm(u, 44);
  check("at 44s he is still a militia", u.typeId, "hmil");
  world.tickAltForm(u, 1.5);
  check("past 45s he reverts himself", u.typeId, "hpea");
  check("…and the clock is cleared", u.altFormLeft, 0);
  check("…back to Peasant speed", (world.recomputeStats(u), u.speed), 190);
}

// --- Bear Form: the whole sheet follows the type, mana pool and cast clock included -------

function druid(id, typeId = "edoc") {
  const d = UNITS[typeId];
  const u = {
    id, owner: 0, team: 0, hp: d.hitPoints, maxHp: d.hitPoints, mana: 200, maxMana: 200,
    x: 0, y: 0, prevX: 0, prevY: 0, typeId,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0,
    altModel: false, altFormLeft: 0, altFormAbil: "",
    inventory: [], buffs: [], footprint: 0, hasReservation: false, etherealForm: false,
    abilities: [{ id: "Abrf", code: "Abrf", level: 1, cooldownLeft: 0, autocastOn: false }],
    weapons: simWeapons(d),
    weapon: null, order: "idle", targetId: null, path: [], moving: false,
    baseArmor: d.armor, baseMaxHp: d.hitPoints, baseMaxMana: d.mana, baseSpeed: d.speed,
    baseDamage: d.weapons[0].baseDamage, baseSight: 1400,
    baseSightDay: d.sightDay, baseSightNight: d.sightNight, armorType: d.armorType,
    castPoint: d.castPoint, castBackswing: d.castBackswing,
  };
  u.weapon = u.weapons.find((w) => w.enabled) ?? null;
  world.units.set(u.id, u);
  return u;
}

{
  const u = druid(20);
  world.recomputeStats(u);
  check("a Druid of the Claw starts in caster form", u.typeId, "edoc");
  check("…with edoc's mana pool", [u.maxMana, u.mana], [200, 200]);
  check("…and edoc's cast clock", [u.castPoint, u.castBackswing], [0.5, 1.17]);
  u.mana = 50; // spent most of it on a Rejuvenation
  check("he shifts", world.morphToggle(u, ABILS.Abrf), true);
  check("…into the bear", u.typeId, "edcm");
  // THE BUG: without baseMaxMana following the type this read 0/0 and the bear could never
  // shift back, let alone cast — and nothing else in the sheet was wrong enough to notice.
  check("…keeping a mana pool at all", u.maxMana > 0, true);
  check("…which is the bear's own 200 (edcm manaN)", u.maxMana, 200);
  check("…and the mana he had left, untouched (the pools match, so the ratio is 1)", u.mana, 50);
  check("…on the bear's faster cast clock (edcm castpt/castbsw)", [u.castPoint, u.castBackswing], [0.3, 0.51]);
  check("…with the bear's damage baseline for Inner Fire to size (dmgplus 26)", u.baseDamage, 26);
  check("…the bear's hit points (edcm hp 810)", u.maxHp, 810);
  check("…and the bear's armour (edcm def 3)", u.baseArmor, 3);
}

// A wounded Druid comes back wounded: the pools move, the SHARE of them does not.
{
  const u = druid(21);
  world.recomputeStats(u);
  u.hp = 215; // half of edoc's 430
  u.mana = 100; // half of the 200 pool
  world.morphToggle(u, ABILS.Abrf);
  check("half a Druid becomes half a bear (215/430 → 405/810)", Math.round(u.hp), 405);
  check("…and half his mana is still half his mana", u.mana, 100);
  world.morphToggle(u, ABILS.Abrf);
  check("…and shifting back leaves him where he started", [Math.round(u.hp), u.mana, u.maxHp], [215, 100, 430]);
  check("…on the caster form's clock again", [u.castPoint, u.castBackswing], [0.5, 1.17]);
}

// A form with no pool at all: nothing to take a share of, so the new pool opens empty.
{
  const u = peasant(22);
  world.recomputeStats(u);
  check("a Peasant has no mana", [u.maxMana, u.mana], [0, 0]);
  world.morphUnit(u, "edoc");
  check("morphed into something that does, he gains the pool", u.maxMana, 200);
  check("…but starts it empty — a share of nothing is nothing", u.mana, 0);
}

// Ringing the bell again sends them back early — same path, so the clock clears too.
{
  const u = peasant(12);
  world.morphToggle(u, ABILS.Amil);
  world.morphToggle(u, ABILS.Amil);
  check("ringing off reverts early", u.typeId, "hpea");
  check("…with no clock left running", u.altFormLeft, 0);
}

console.log(`
${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
