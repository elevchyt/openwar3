// Headless check of Shadow Meld (`Ashm`) — the night elf racial, and the one invisibility
// that is a STANCE rather than a spell.
//
// Two halves are verified, because the ability lives in two places:
//   1. the handler (spells.ts)  — which Data column it spends, and the buff it builds
//   2. tickMeld (world.ts)      — the two break conditions no other invisibility has
//
// Numbers are the real ones from Units\AbilityData.slk, with the column meanings from
// AbilityMetaData.slk Shm1/2/3 → UI\WorldEditStrings.txt:
//   DataA "Fade Duration"      1.5   (Sshm, the instant variant, 0.1)
//   DataB "Day/Night Duration" 2.5   — unspent: named but no source says what it measures
//   DataC "Action Duration"    0.5   — likewise
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SPELL_HANDLERS } = require(join(REPO, ".sim-build", "src", "sim", "spells.js"));
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// --- the handler ---------------------------------------------------------------------

function def(data) {
  return {
    id: "Ashm", code: "Ashm", missileArt: "", targetArt: "", casterArt: "", specialArt: "",
    effectArt: "", areaArt: "", buffArt: "", buffFx: [], buffEffectArt: "", buffSpecialArt: "",
    levelData: [{ cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0, data, buffs: [], summon: "" }],
  };
}

function cast(data, isDay) {
  const caster = { id: 1, owner: 0, team: 0, hp: 500, x: 0, y: 0 };
  const log = { buffs: [], held: [] };
  const api = {
    rng: () => 0.5,
    getUnit: () => caster,
    unitsInArea: () => [caster],
    hostile: () => false,
    ally: () => true,
    spellDamage: () => {}, spellHeal: () => {}, dispel: () => {}, emitEffect: () => {},
    isDay: () => isDay,
    holdPosition: (u) => log.held.push(u.id),
    applyBuff: (t, b) => log.buffs.push({ id: t.id, kind: b.kind, group: b.group, timeLeft: b.timeLeft, delay: b.delay, meld: b.meld, value: b.value }),
  };
  SPELL_HANDLERS.Ashm(api, caster, def(data), 1);
  return log;
}

// Ashm at night: one invisible buff, no duration, faded in over DataA.
{
  const log = cast([1.5, 2.5, 0.5], false);
  check("melds at night", log.buffs.length, 1);
  check("…as an invisibility", log.buffs[0].kind, "invisible");
  // Spelled out rather than compared against Infinity directly: `check` goes through
  // JSON.stringify, which turns Infinity into null and would pass for anything non-finite.
  check("…with no duration — the conditions are the duration", log.buffs[0].timeLeft === Infinity, true);
  check("…faded in over DataA \"Fade Duration\" 1.5", log.buffs[0].delay, 1.5);
  check("…marked as a meld, so tickMeld will police it", log.buffs[0].meld, true);
  check("…carrying no Backstab Damage (that is Wind Walk's)", log.buffs[0].value, 0);
  check("…and holding position, so it can't walk out of hiding", log.held, [1]);
}

// Sshm, the instant variant, is the SAME code with a shorter fade.
{
  const log = cast([0.1, 2.5, 0.5], false);
  check("the instant variant fades in 0.1s", log.buffs[0].delay, 0.1);
}

// By day the button is dead — nothing happens at all.
{
  const log = cast([1.5, 2.5, 0.5], true);
  check("refuses to meld by day", log.buffs.length, 0);
  check("…and does not take the stance either", log.held, []);
}

// --- the break conditions (tickMeld) ---------------------------------------------------

const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);

function melded(over = {}) {
  const u = {
    id: 1, owner: 0, team: 0, hp: 100, x: 0, y: 0, prevX: 0, prevY: 0,
    detectRadius: 0, invisible: true, cloaked: true, inventory: [], weapons: [], abilities: [],
    baseArmor: 0, baseMaxHp: 100, baseMaxMana: 0, baseMoveSpeed: 270, baseSight: 1800,
    buffs: [{ kind: "invisible", group: "shadowmeld", timeLeft: Infinity, sourceId: 1, value: 0, value2: 0, art: "", fx: [], delay: 0, meld: true }],
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const stillMelded = (u) => u.buffs.some((b) => b.kind === "invisible");

// Standing still in the dark: the meld holds. This is the case the whole ability exists for.
{
  world.timeOfDay = 22; // night
  const u = melded();
  world.tickMeld(u);
  check("standing still at night keeps the meld", stillMelded(u), true);
}

// Moving breaks it — Shadow Meld's own condition, the one Wind Walk does NOT have.
{
  world.timeOfDay = 22;
  const u = melded({ x: 40, prevX: 0 });
  world.tickMeld(u);
  check("moving breaks the meld", stillMelded(u), false);
}

// A shove counts as moving. Displacement is tested, not the ORDER: a melded Archer pushed by
// a collision resolve has moved whether she meant to or not.
{
  world.timeOfDay = 22;
  const u = melded({ y: 12, prevY: 0, order: "hold", moving: false });
  world.tickMeld(u);
  check("being shoved while on hold still breaks it", stillMelded(u), false);
}

// Dawn breaks a meld already in force — it is not merely a bar on casting.
{
  world.timeOfDay = 12; // midday
  const u = melded();
  world.tickMeld(u);
  check("daybreak breaks a meld already in force", stillMelded(u), false);
}

// A NON-meld invisibility (Wind Walk) is untouched by both: it survives movement and daylight.
{
  world.timeOfDay = 12;
  const u = melded({ x: 500, prevX: 0 });
  u.buffs[0].meld = false;
  u.buffs[0].group = "windwalk";
  world.tickMeld(u);
  check("Wind Walk survives moving in broad daylight", stillMelded(u), true);
}

// By day the BUTTON is dead, not just the effect: every door into the sim refuses the order
// (so the unit is not parked on Hold for a meld that never comes), and the card greys it off
// the same answer. At night the same ability is live.
{
  world.timeOfDay = 12;
  check("Shadow Meld is barred by day", world.barredByDay("Ashm"), true);
  check("…Wind Walk is not", world.barredByDay("AOwk"), false);
  world.timeOfDay = 22;
  check("…and Shadow Meld is live at night", world.barredByDay("Ashm"), false);
}

// HIDE TAKES ITSELF — but never out of a fight. Measured live on Echo Isles before the fix:
// an Archer on Hold re-melded between every two arrows, and one whose ATTACK target died was
// handed back as idle for a tick and melded with the next Footman still shooting at her.
{
  const w = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
  w.timeOfDay = 22;
  let casts = 0;
  let enemyNear = false;
  w.issueCast = () => { casts++; return true; };
  w.techMeets = () => true;
  w.acquireTarget = () => (enemyNear ? { id: 99 } : null);
  const archer = (over = {}) => ({
    id: 3, owner: 0, hp: 100, x: 0, y: 0, prevX: 0, prevY: 0, order: "idle", moving: false, swingLeft: -1,
    targetId: null, inCombat: false, cloaked: false, stunned: false, paused: false, isCreep: false,
    weapon: { acquire: 700, range: 500 }, inventory: [], buffs: [],
    abilities: [{ id: "Ashm", code: "Ashm", level: 1 }], ...over,
  });
  const tries = (over, near = false) => { casts = 0; enemyNear = near; w.tickAutoMeld(archer(over)); return casts; };
  check("an idle Archer alone at night melds", tries({}), 1);
  check("…on Hold with nobody about too", tries({ order: "hold" }), 1);
  check("an Archer on Hold shooting (between arrows) does not", tries({ order: "hold", targetId: 9, inCombat: true }), 0);
  check("…nor one still holding a target it has not reached", tries({ order: "hold", targetId: 9 }), 0);
  check("an attack's target died, an enemy still in acquisition range: no meld", tries({}, true), 0);
  check("…nor on Hold with one in range", tries({ order: "hold" }, true), 0);
  check("an Archer on an attack order never melds", tries({ order: "attack", targetId: 9 }), 0);
  check("…nor one attack-moving", tries({ order: "attackmove" }), 0);
  // A cinematic's actors stand idle between lines because the script is directing them.
  w.inCinematic = () => true;
  check("nobody hides of their own accord during a cinematic", tries({}), 0);
  w.inCinematic = () => false;
  check("…and melds again once it is over", tries({}), 1);
}

// The Hero Abilities page lists a hero's SKILLS only. The Warden carries Shadow Meld as an
// innate unit ability beside her heroAbilList; it is not learnable and a point cannot rank it.
{
  const defs = new Map([
    ["Ashm", { id: "Ashm", code: "Ashm", research: false, levels: 3, reqLevel: 1, levelSkip: 2, levelData: [{}, {}, {}] }],
    ["AEbl", { id: "AEbl", code: "AEbl", research: true, levels: 3, reqLevel: 1, levelSkip: 2, levelData: [{}, {}, {}] }],
  ]);
  defs.set("AUdd", { id: "AUdd", code: "AUdd", research: true, levels: 3, reqLevel: 1, levelSkip: 2, levelData: [{}, {}, {}] });
  const w = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
  w.abilities = defs;
  // The Warden's own UnitAbilities.slk row: heroAbilList AEbl,AEfk,AEsh,AEsv beside abilList AInv,Ashm.
  w.unitReg = new Map([["Ewar", { id: "Ewar", heroAbilities: ["AEbl", "AEfk", "AEsh", "AEsv"] }]]);
  const hero = {
    id: 7, typeId: "Ewar", isHero: true, level: 1, skillPoints: 1, owner: 0,
    abilities: [{ id: "Ashm", code: "Ashm", level: 1 }, { id: "AEbl", code: "AEbl", level: 0 }],
  };
  w.units.set(hero.id, hero);
  check("a hero's innate Shadow Meld is not learnable", w.learnable(hero, "Ashm"), false);
  check("…her Blink is", w.learnable(hero, "AEbl"), true);
  // A hero-class ability a SCRIPT added is not on the page either: "Abilities added through
  // triggers will not show up in the skill level list" (hiveworkshop 257081) — the whole of
  // Test of Balance's reward dialog, which adds hero spells at rank 1 and levels them by trigger.
  hero.abilities.push({ id: "AUdd", code: "AUdd", level: 1 });
  check("a trigger-added hero ability is not learnable, hero flag or no", w.learnable(hero, "AUdd"), false);
  check("…so a hero with only those has no learn page", w.hasHeroSkills({ ...hero, abilities: [{ id: "AUdd", code: "AUdd", level: 1 }] }), false);
  check("…while one with a skill of its own does", w.hasHeroSkills(hero), true);
  // (given three ranks here, so it is the learnable gate that refuses and not "already maxed")
  check("learnskill refuses Shadow Meld", w.learnAbility(7, "Ashm"), false);
  check("…and keeps the point", hero.skillPoints, 1);
}

// THE CLOAK OF SHADOWS: `[clsd] abilList = Ashm`, "Provides the Shadowmeld ability." The
// carrier gets the ability on its SHEET — so the card's button, the hotkey and issueCast all
// see it — and loses it with the cloak, along with any meld the cloak was holding.
{
  const w = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
  w.abilities = new Map([["Ashm", { id: "Ashm", code: "Ashm", research: false, levels: 1, levelData: [{ data: [1.5, 2.5, 0.5] }] }]]);
  w.itemReg = new Map([["clsd", { id: "clsd", abilities: ["Ashm"] }], ["rat6", { id: "rat6", abilities: ["AItg"] }]]);
  const hero = { id: 8, owner: 0, abilities: [], buffs: [], inventory: [{ id: 1, itemId: "clsd", charges: 0 }, null], pendingCast: null };
  w.syncCarriedAbilities(hero);
  check("a hero carrying a Cloak of Shadows has Shadow Meld on its sheet", hero.abilities.map((a) => [a.code, a.level]), [["Ashm", 1]]);
  w.syncCarriedAbilities(hero);
  check("…once, however many ticks pass", hero.abilities.length, 1);
  let broke = 0;
  w.breakInvisibility = () => { broke++; };
  hero.buffs.push({ kind: "invisible", group: "shadowmeld", meld: true });
  hero.inventory[0] = null;
  w.syncCarriedAbilities(hero);
  check("dropping the cloak takes the ability back off", hero.abilities.length, 0);
  check("…and ends the meld it was holding", broke, 1);
  const warden = { id: 9, owner: 0, abilities: [{ id: "Ashm", code: "Ashm", level: 1, cooldownLeft: 0, autocastOn: false }], buffs: [], inventory: [{ id: 2, itemId: "clsd", charges: 0 }] };
  w.syncCarriedAbilities(warden);
  check("a Warden's own Shadow Meld is not doubled by a cloak", warden.abilities.length, 1);
  warden.inventory[0] = null;
  w.syncCarriedAbilities(warden);
  check("…nor taken away when she drops it", warden.abilities.length, 1);
  const other = { id: 10, owner: 0, abilities: [], buffs: [], inventory: [{ id: 3, itemId: "rat6", charges: 0 }] };
  w.syncCarriedAbilities(other);
  check("an ordinary item puts nothing on the sheet", other.abilities.length, 0);
}

// NO GESTURE. `[Ashm]`/`[Sshm]` in NightElfAbilityFunc carry no `Animnames`, so the unit just
// stands and fades. Through the wound-up pipeline the Warden played her "Spell" clip every time
// tickAutoMeld hid her at night; the press must now resolve at once and start no cast clip.
{
  const w = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
  w.timeOfDay = 22;
  w.techMeets = () => true;
  w.abilities = new Map([["Ashm", {
    id: "Ashm", code: "Ashm", target: "none", targetFlags: [], animNames: [],
    buffFx: [], effectArt: [], casterArt: [], targetArt: [], specialArt: [], lightning: [],
    levelData: [{ cost: 0, cooldown: 0, castTime: 0, castRange: 0, area: 0, data: [1.5, 2.5, 0.5], dataStr: [] }],
  }]]);
  const warden = {
    id: 5, owner: 0, team: 0, hp: 500, x: 0, y: 0, prevX: 0, prevY: 0, mana: 0, order: "idle", moving: false,
    swingLeft: -1, targetId: null, inCombat: false, cloaked: false, stunned: false, silenced: false, paused: false,
    isCreep: false, castPoint: 0.3, castBackswing: 0.5, pendingCast: null, inventory: [], buffs: [], weapons: [],
    abilities: [{ id: "Ashm", code: "Ashm", level: 1, cooldownLeft: 0 }],
  };
  w.units.set(warden.id, warden);
  check("an automatic meld is accepted", w.issueCast(5, "Ashm", 0, 0, 0, true), true);
  check("…resolves at once, with no pending cast to wind up", warden.pendingCast, null);
  check("…starts no cast animation", w.drainCastStarts().length, 0);
  check("…still plays its Effectsound", w.drainCastFires().length, 1);
  check("…and lays the meld", warden.buffs.map((b) => b.group), ["shadowmeld"]);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
