// Headless check of the generic FORM TOGGLE — Burrow (`Abur`) and the mechanism behind every
// other two-form ability (Bear/Crow/Stone/Destroyer/Ethereal Form, Submerge).
//
// The thing worth pinning is that a form is not a state we model but a UNIT the ability names,
// so the toggle is a morph and the target unit's own row supplies the behaviour. If that holds,
// nobody ever has to write "a burrowed Crypt Fiend cannot move" in code.
//
// Real real rows (Units\AbilityData.slk; column meanings from AbilityMetaData.slk through
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
 *  (Units\UnitBalance.slk + UnitWeapons.slk). */
const UNITS = {
  hpea: { id: "hpea", classification: ["peon"], acquireRange: 500, hitPoints: 220, armor: 0, armorType: "medium", sightDay: 1800, sightNight: 800, speed: 190, abilities: ["Ahar", "Amil"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 4, dice: 1, sides: 2, cooldown: 2.0, damagePoint: 0.3, backswing: 0.51, range: 90, rangeBuffer: 250, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  hmil: { id: "hmil", classification: [], acquireRange: 500, hitPoints: 220, armor: 4, armorType: "large", sightDay: 1800, sightNight: 800, speed: 270, abilities: ["Ahar", "Amil"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 11, dice: 1, sides: 2, cooldown: 2.0, damagePoint: 0.3, backswing: 0.51, range: 90, rangeBuffer: 250, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  ucry: { id: "ucry", acquireRange: 500, hitPoints: 550, armor: 0, armorType: "medium", sightDay: 1800, sightNight: 800, speed: 270, abilities: ["Aweb", "Aspa", "Abur"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 26, dice: 1, sides: 4, cooldown: 1.9, damagePoint: 0.3, backswing: 0.51, range: 550, rangeBuffer: 250, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  ucrm: { id: "ucrm", acquireRange: 500, hitPoints: 550, armor: 0, armorType: "medium", sightDay: 1800, sightNight: 800, speed: 0, abilities: ["Aspa", "Abur"], heroAbilities: [], autoAbility: "", weapons: [] },
  edoc: { id: "edoc", acquireRange: 500, hitPoints: 430, mana: 200, armor: 1, armorType: "large", sightDay: 1400, sightNight: 800, speed: 270, castPoint: 0.5, castBackswing: 1.17, abilities: ["Abrf", "Arej"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 18, dice: 1, sides: 4, cooldown: 1.5, damagePoint: 0.33, backswing: 0.53, range: 100, rangeBuffer: 250, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  edcm: { id: "edcm", acquireRange: 500, hitPoints: 810, mana: 200, armor: 3, armorType: "large", sightDay: 1400, sightNight: 800, speed: 270, castPoint: 0.3, castBackswing: 0.51, abilities: ["Abrf", "Arej"], heroAbilities: [], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 26, dice: 1, sides: 6, cooldown: 1.5, damagePoint: 0.5, backswing: 0.83, range: 100, rangeBuffer: 250, weaponType: "normal", attackType: "normal", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  // The Alchemist and his three ogres — one per rank of Chemical Rage, which is the whole
  // reason the toggle has to carry a rank at all. Everything the tooltip quotes lives on
  // these rows: spd 290→405, cool1 2.5→2.0/1.42/1.11 (UnitBalance.slk / UnitWeapons.slk).
  Nalc: { id: "Nalc", acquireRange: 500, hitPoints: 725, mana: 270, armor: 0, armorType: "hero", sightDay: 1800, sightNight: 800, speed: 290, abilities: [], heroAbilities: ["ANcr"], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 3, dice: 3, sides: 10, cooldown: 2.5, damagePoint: 0.35, backswing: 0.65, range: 100, rangeBuffer: 250, weaponType: "normal", attackType: "hero", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  Nalm: { id: "Nalm", acquireRange: 500, hitPoints: 725, mana: 270, armor: 0, armorType: "hero", sightDay: 1800, sightNight: 800, speed: 405, abilities: [], heroAbilities: ["ANcr"], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 3, dice: 3, sides: 10, cooldown: 2.0, damagePoint: 0.35, backswing: 0.65, range: 100, rangeBuffer: 250, weaponType: "normal", attackType: "hero", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  Nal2: { id: "Nal2", acquireRange: 500, hitPoints: 725, mana: 270, armor: 0, armorType: "hero", sightDay: 1800, sightNight: 800, speed: 405, abilities: [], heroAbilities: ["ANcr"], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 3, dice: 3, sides: 10, cooldown: 1.42, damagePoint: 0.35, backswing: 0.65, range: 100, rangeBuffer: 250, weaponType: "normal", attackType: "hero", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
  Nal3: { id: "Nal3", acquireRange: 500, hitPoints: 725, mana: 270, armor: 0, armorType: "hero", sightDay: 1800, sightNight: 800, speed: 405, abilities: [], heroAbilities: ["ANcr"], autoAbility: "", weapons: [{ enabled: true, targets: ["ground", "structure"], damage: 3, dice: 3, sides: 10, cooldown: 1.11, damagePoint: 0.35, backswing: 0.65, range: 100, rangeBuffer: 250, weaponType: "normal", attackType: "hero", missileArt: "", missileSpeed: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 }] },
};
const unitReg = { get: (id) => UNITS[id] };

// Only the two columns the toggle reads. `summon` is UnitID1 — that is where the parser puts
// it (str(r, `unitid${L}`)), which is why the alternate form arrives under that name.
// `unOrder` is the ability's `Unorder` field, and its PRESENCE is what says a form can be
// switched off by pressing the button again (SimWorld.morphToggle). All three of these rows
// carry one — `[Abur] Unorder=unburrow`, `[Amil] Unorder=militiaoff`, `[Abrf] Unorder=unbearform`
// — where the two timed hero forms (Chemical Rage, Metamorphosis) carry none at all.
const ABILS = {
  Abur: { id: "Abur", code: "Abur", unOrder: "unburrow", levelData: [lvl({ dataStr: ["ucry"], summon: "ucrm" })] },
  // Call to Arms puts its alternate form in DataB and is TIMED — the two ways it differs
  // from Burrow, and the two things altFormOf/tickAltForm exist for. Both of its duration
  // columns read 40 in 1.30's AbilityData.slk (`Amil Dur1 = HeroDur1 = 40`), and it is
  // **HeroDur** the toggle counts: on a morph row `Dur` is the transition between models
  // (Burrow 1.45, Ethereal Form 0.7, Robo-Goblin 1.5 — none of them a form duration) while
  // HeroDur is how long the form lasts. See SimWorld.morphToggle.
  Amil: { id: "Amil", code: "Amil", unOrder: "militiaoff", levelData: [lvl({ dataStr: ["hpea", "hmil"], duration: 40, heroDuration: 40 })] },
  // Bear Form — the same two columns again, on a pair that carries mana.
  Abrf: { id: "Abrf", code: "Abrf", unOrder: "unbearform", levelData: [lvl({ dataStr: ["edoc"], summon: "edcm" })] },
  // Chemical Rage — the counter-example, and the only shape in the family that has BOTH a
  // per-rank alternate form and no way out but the clock. `[ANcr]` carries no Unorder, no
  // Unart and no Untip: one order, one icon, 15 seconds.
  ANcr: { id: "ANcr", code: "ANcr", unOrder: "", levelData: [
    lvl({ dataStr: ["Nalc"], summon: "Nalm", heroDuration: 15 }),
    lvl({ dataStr: ["Nalc"], summon: "Nal2", heroDuration: 15 }),
    lvl({ dataStr: ["Nalc"], summon: "Nal3", heroDuration: 15 }),
  ] },
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
    radius: 16, isPeon: typeId === "hpea", ward: false, mechanical: false, ancient: false,
    militiaCall: 0, nodeRetries: 0, waitT: 0,
    // The Peasant's own harvest profile (data/races WORKERS.hpea), carrying a load — `worker`
    // is the one switch the Build, Gather and Repair buttons all hang off.
    worker: typeId === "hpea"
      ? { gold: true, lumber: true, harvestAbility: "Ahar", lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1.1, goldPerTrip: 10, damagesTree: true, deliversInPlace: false, minesInRing: false, carryGold: 0, carryLumber: 6 }
      : null,
  };
  u.weapon = u.weapons.find((w) => w.enabled) ?? null;
  world.units.set(u.id, u);
  return u;
}

/** A hall to be armed at. What makes one is the BELL — `Amic`, which only `hkee` and `hcas`
 *  carry in Units\UnitAbilities.slk, plus whatever Blizzard.j hands it to at a melee start
 *  (MeleeStartingUnitsHuman: `UnitAddAbilityBJ('Amic', townHall)`). `bell: false` is the
 *  expansion Town Hall that has none. */
function hall(id, x, bell = true) {
  const u = {
    id, owner: 0, team: 0, hp: 1200, maxHp: 1200, mana: 0, maxMana: 0, x, y: 0, prevX: x, prevY: 0,
    typeId: "hkee", radius: 100, building: { constructionLeft: 0 },
    abilities: bell ? [{ id: "Amic", code: "Amic", level: 1, cooldownLeft: 0, autocastOn: false }] : [],
    buffs: [], inventory: [], weapons: [], weapon: null, order: "idle", targetId: null, path: [], moving: false,
  };
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
  check("…and the 40s clock is running (Amil HeroDur1)", u.altFormLeft, 40);
  check("…through the ability that owns both ids", u.altFormAbil, "Amil");
}

// The clock runs out and he goes back to work on his own, wherever he is standing.
{
  const u = peasant(11);
  world.morphToggle(u, ABILS.Amil);
  world.tickAltForm(u, 39);
  check("at 39s he is still a militia", u.typeId, "hmil");
  world.tickAltForm(u, 1.5);
  check("past 40s he reverts himself", u.typeId, "hpea");
  check("…and the clock is cleared", u.altFormLeft, 0);
  check("…back to Peasant speed", (world.recomputeStats(u), u.speed), 190);
}

// --- Call to Arms is an ERRAND: the shape changes AT THE HALL, not where the button is ----
//
// The ability says so itself. `[Amil]` Ubertip: "Run to the nearest Keep, Castle or starting
// Town Hall to arm the Peasant, converting him into Militia", and the Unubertip repeats it for
// the way back; `[Amic]`, the town bell, "Call all nearby Peasants to the Town Hall to be
// converted to Militia". Morphing on the spot made the bell a free instant army anywhere on
// the map, including inside the enemy's base.
{
  const u = peasant(12);
  check("with no hall standing, nobody can be armed", world.callToArms(u), false);
  check("…and he is still a Peasant", u.typeId, "hpea");

  hall(90, 3000, false); // an expansion Town Hall: no bell, so no muster
  check("a hall with no `Amic` is not a muster point", world.callToArms(u), false);

  const keep = hall(91, 100); // …and one with the bell, a body's width away
  check("the bell books the errand", world.callToArms(u), true);
  check("…naming the hall he is to run to", u.militiaCall, keep.id);
  check("…and the PRESS does not arm him", u.typeId, "hpea");

  world.tickMilitiaCall(u); // he is already at the door
  check("arriving is what arms him", u.typeId, "hmil");
  check("…and the errand is spent", u.militiaCall, 0);
  check("…on the ability's own clock", u.altFormLeft, 40);
}

// The half that made the Militia a bystander in its own defence: the four UnitBalance `type`
// flags belong to the TYPE, so they have to follow the morph. `hpea` is `Peon` and `hmil` is
// `_`, and `isPeon` is what says a unit never auto-acquires (acquireRange returns 0) and is the
// last thing a creep camp turns on (lowPriorityTarget) — carried across, the Militia stood in
// the middle of a fight swinging at nothing.
{
  const u = peasant(13);
  check("a Peasant is a worker", u.isPeon, true);
  world.morphToggle(u, ABILS.Amil);
  check("…and a Militia is not (hmil type = \"_\")", u.isPeon, false);
  world.morphToggle(u, ABILS.Amil);
  check("…and is a worker again on the way back", u.isPeon, true);
}

// …and the JOB goes with the classification. `hmil` carries `Ahar,Amil,Ahrp` and the Peasant's
// whole `Builds` list all the same, so this cannot be keyed off the ability list — it is the
// `Peon` type, which is also what `sort2` (peo → me1) and `upgrades` (Improved Lumber
// Harvesting → melee attack + armour) say twice more.
{
  const u = peasant(14);
  check("a Peasant has a harvest profile", !!u.worker, true);
  world.morphToggle(u, ABILS.Amil);
  check("an armed Militia has none — no Build, Gather or Repair", u.worker, null);
  world.morphToggle(u, ABILS.Amil);
  check("…and gets it back when it goes back to work", !!u.worker, true);
  check("…which is the Peasant's own row (Ahar)", u.worker.harvestAbility, "Ahar");
  // A worker has one pair of hands (dropOtherLoad); taking up a sword drops what was in them.
  check("…and the load it was carrying did not come back", [u.worker.carryGold, u.worker.carryLumber], [0, 0]);
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

// --- a TIMED form, which is a different animal from a toggle -----------------------------
//
// Chemical Rage names a different ogre per rank and has no `Unorder`, and both of those are
// load-bearing. The rank picks which ogre (each carries the attack cooldown its level's
// tooltip quotes), and the missing Unorder means the button cannot take the form OFF — only
// the clock can. Read as a toggle, a second press UN-raged the Alchemist, which looks exactly
// like the ability doing nothing and leaves every other press working.
{
  const u = fiend("Nalc");
  u.abilities = [{ id: "ANcr", code: "ANcr", level: 3, cooldownLeft: 0, autocastOn: false }];
  u.baseSpeed = UNITS.Nalc.speed;
  world.recomputeStats(u);
  check("rank 3 rages into rank 3's ogre", [world.morphToggle(u, ABILS.ANcr, 3), u.typeId], [true, "Nal3"]);
  check("…which is where the attack rate lives (2.5 → 1.11)", u.weapon.cooldown, 1.11);
  check("…and the movement rate (290 → 405)", u.speed, 405);
  check("…for HeroDur, not Dur", u.altFormLeft, 15);

  // The press that used to cancel it. Chemical Rage's 30s cooldown outlives its 15s form, so
  // the real game can never ask — but anything that shortens the cooldown can.
  u.altFormLeft = 4;
  check("pressing it again does NOT un-rage him", [world.morphToggle(u, ABILS.ANcr, 3), u.typeId], [true, "Nal3"]);
  check("…it re-arms the clock", u.altFormLeft, 15);

  // …and the clock still gets him out — back to the ALCHEMIST, not into rank 1's ogre, which
  // is what "a press can't end it" turns into if the timer isn't told it is the exception.
  // …exactly as tickAltForm calls it when the clock runs out: rank 1 (the revert reads the
  // NORMAL form, which is Nalc at every rank) and `byTimer`. Without that flag the rule above
  // sends an expiring rank-3 rage into rank 1's OGRE with a fresh 15 seconds, for ever.
  check("the clock reverts him to the Alchemist", [world.morphToggle(u, ABILS.ANcr, 1, true), u.typeId], [true, "Nalc"]);
  check("…with the rage's stats gone with it", [u.speed, u.weapon.cooldown, u.altFormLeft], [290, 2.5, 0]);
}

console.log(`
${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
