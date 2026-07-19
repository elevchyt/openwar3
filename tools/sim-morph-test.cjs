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
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** The two Crypt Fiend forms, with the fields morphUnit actually reads off a UnitDef. */
const UNITS = {
  hpea: { id: "hpea", hitPoints: 220, armor: 0, armorType: "medium", sightDay: 1800, sightNight: 800, speed: 190, abilities: ["Ahar", "Amil"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, baseDamage: 4, baseRange: 90 }] },
  hmil: { id: "hmil", hitPoints: 220, armor: 4, armorType: "large", sightDay: 1800, sightNight: 800, speed: 270, abilities: ["Ahar", "Amil"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, baseDamage: 11, baseRange: 90 }] },
  ucry: { id: "ucry", hitPoints: 550, armor: 0, armorType: "medium", sightDay: 1800, sightNight: 800, speed: 270, abilities: ["Aweb", "Aspa", "Abur"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, baseDamage: 26, baseRange: 550 }] },
  ucrm: { id: "ucrm", hitPoints: 550, armor: 0, armorType: "medium", sightDay: 1800, sightNight: 800, speed: 0, abilities: ["Aspa", "Abur"], heroAbilities: [], autoAbility: "", weapons: [] },
};
const unitReg = { get: (id) => UNITS[id] };

// Only the two columns the toggle reads. `summon` is UnitID1 — that is where the parser puts
// it (str(r, `unitid${L}`)), which is why the alternate form arrives under that name.
const ABILS = {
  Abur: { id: "Abur", code: "Abur", levelData: [{ data: [NaN], dataStr: ["ucry"], summon: "ucrm", castRange: 0, area: 0, duration: 0, buffs: [] }] },
  // Call to Arms puts its alternate form in DataB and carries a 45s duration — the two ways
  // it differs from Burrow, and the two things altFormOf/tickAltForm exist for.
  Amil: { id: "Amil", code: "Amil", levelData: [{ data: [NaN, NaN], dataStr: ["hpea", "hmil"], summon: "", castRange: 0, area: 0, duration: 45, buffs: [] }] },
};
const abilReg = { get: (id) => ABILS[id] };

const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1, abilReg, undefined, unitReg);

function fiend(typeId = "ucry") {
  const d = UNITS[typeId];
  const u = {
    id: 1, owner: 0, team: 0, hp: 400, maxHp: 550, x: 0, y: 0, prevX: 0, prevY: 0, typeId,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0, altModel: false,
    inventory: [], buffs: [], footprint: 0, hasReservation: false, etherealForm: false,
    abilities: [{ id: "Abur", code: "Abur", level: 1, cooldownLeft: 0, autocastOn: false }],
    weapons: d.weapons.map((w) => ({ ...w, damage: 0, baseDice: 1, dice: 0, range: 0, baseDamagePoint: 0.3, damagePoint: 0, baseBackswing: 0.3, backswing: 0, baseCooldown: 2, cooldown: 0, baseSpillDist: 0, spillDist: 0, baseSpillRadius: 0, spillRadius: 0 })),
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
  check("…and armed again", !!u.weapon, true);
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
  const broken = { id: "Abur", code: "Abur", levelData: [{ data: [NaN], dataStr: ["ucry"], summon: "nope", castRange: 0, area: 0, buffs: [] }] };
  check("an unknown alternate form is refused", world.morphToggle(u, broken), false);
  check("…leaving the unit exactly as it was", u.typeId, "ucry");
}

// A row missing the columns entirely (a non-morph ability handed to the toggle) does nothing.
{
  const u = fiend();
  const empty = { id: "X", code: "X", levelData: [{ data: [NaN], dataStr: [""], summon: "", castRange: 0, area: 0, buffs: [] }] };
  check("a row naming no forms is refused", world.morphToggle(u, empty), false);
}
// --- Call to Arms: the alternate form in DataB, and a form on a clock -------------------

function peasant(id, typeId = "hpea") {
  const d = UNITS[typeId];
  const u = {
    id, owner: 0, team: 0, hp: 220, maxHp: 220, x: 0, y: 0, prevX: 0, prevY: 0, typeId,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0,
    altModel: false, altFormLeft: 0, altFormAbil: "",
    inventory: [], buffs: [], footprint: 0, hasReservation: false, etherealForm: false,
    abilities: [{ id: "Amil", code: "Amil", level: 1, cooldownLeft: 0, autocastOn: false }],
    weapons: d.weapons.map((w) => ({ ...w, damage: 0, baseDice: 1, dice: 0, range: 0, baseDamagePoint: 0.3, damagePoint: 0, baseBackswing: 0.3, backswing: 0, baseCooldown: 2, cooldown: 0, baseSpillDist: 0, spillDist: 0, baseSpillRadius: 0, spillRadius: 0 })),
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
