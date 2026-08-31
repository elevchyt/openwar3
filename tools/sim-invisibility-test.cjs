// Headless check of THE FADE — the one rule every invisibility in the game shares.
//
// Nothing here is instant. A unit that presses Wind Walk, drinks a Potion of Invisibility or
// is hidden by a Sorceress keeps the movement bonus straight away and stays perfectly
// targetable for the length of its Transition Time: a shot already in the air lands, and an
// attack ordered inside the window connects. What the window BUYS, for Wind Walk, is the
// Backstab Damage — which is therefore owed only once the fade has landed.
//
// The numbers are the install's own (Units\AbilityData.slk, column meanings from
// AbilityMetaData.slk → UI\WorldEditStrings.txt):
//
//   [AOwk] Wind Walk     DataA "Transition Time"  0.6    DataB speed 0.1/0.4/0.7   DataC 40/70/100
//   [Ashm] Shadow Meld   DataA "Fade Duration"    1.5    (Sshm, the instant variant, 0.1)
//   [Aivs] Invisibility  DataA                    0      Dur1 120, BuffID1 Binv
//   [AIvi] the Potions   no Data column at all           Dur1 120 / 180, BuffID1 Binv
//
// The last two are why `invisTransition` exists: a 0.00 transition is finalised on the
// engine's own ~0.25s reaction-delay loop rather than on the frame of the press. That 0.25 is
// OURS (see the function's comment and its sources); every other number above is the game's
// and is kept exactly as stated, 0.1 included.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SPELL_HANDLERS, invisTransition } = require(join(REPO, ".sim-build", "src", "sim", "spells.js"));
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// --- the fade rule itself --------------------------------------------------------------

check("a stated fade is the game's and is kept", invisTransition(0.6), 0.6);
check("…however short it is stated (Sshm)", invisTransition(0.1), 0.1);
check("a row that states 0.00 fades over the engine's reaction delay", invisTransition(0), 0.25);
check("…and so does one with no column at all", invisTransition(NaN), 0.25);

// --- the handlers ----------------------------------------------------------------------

function def(id, data, duration, over = {}) {
  return {
    id, code: id, missileArt: "", targetArt: "", casterArt: "", specialArt: "", effectArt: "",
    areaArt: "", buffArt: "", buffFx: [], buffEffectArt: "", buffSpecialArt: "", lightning: [],
    targetFlags: [],
    levelData: data.map((d, i) => ({
      cost: 0, cooldown: 0, duration: duration[i] ?? duration[0] ?? 0, heroDuration: duration[i] ?? duration[0] ?? 0,
      castRange: 0, area: 0, castTime: 0, data: d, buffs: [], summon: "",
    })),
    ...over,
  };
}

/** Runs one handler against a stub world and records the buffs it laid down. */
function cast(code, d, target) {
  const caster = { id: 1, owner: 0, team: 0, hp: 500, maxHp: 500, x: 0, y: 0 };
  const log = { buffs: [], effects: [] };
  const api = {
    rng: () => 0.5,
    getUnit: (id) => (target && target.id === id ? target : caster),
    unitsInArea: () => [caster],
    hostile: (a, b) => a.team !== b.team,
    ally: (a, b) => a.team === b.team,
    admits: () => true,
    isDay: () => false,
    holdPosition: () => {},
    emitEffect: (art) => log.effects.push(art),
    applyBuff: (t, b) => log.buffs.push({ id: t.id, kind: b.kind, group: b.group, timeLeft: b.timeLeft, delay: b.delay ?? 0, value: b.value ?? 0 }),
  };
  SPELL_HANDLERS[code](api, caster, d, 1, { targetId: target ? target.id : 0, x: 0, y: 0 });
  return log;
}

// Wind Walk lays down TWO buffs and they land at different times — the speed at the press,
// the fade (and the backstab it carries) after DataA.
{
  const log = cast("AOwk", def("AOwk", [[0.6, 0.1, 40]], [20]));
  const haste = log.buffs.find((b) => b.kind === "haste");
  const invis = log.buffs.find((b) => b.kind === "invisible");
  check("Wind Walk applies a haste and an invisibility", log.buffs.length, 2);
  check("…the Movement Speed Increase is DataB, and lands at once", [haste.value, haste.delay], [0.1, 0]);
  check("…the fade is DataA \"Transition Time\"", invis.delay, 0.6);
  check("…carrying DataC \"Backstab Damage\"", invis.value, 40);
  check("…both under one group, so the break ends the speed too", [haste.group, invis.group], ["windwalk", "windwalk"]);
  check("…for Dur1 seconds", invis.timeLeft, 20);
}

// A map that edits the Transition Time away does not get an instant vanish.
{
  const log = cast("AOwk", def("AOwk", [[0, 0.7, 100]], [50]));
  check("a Wind Walk edited to 0.00 still fades over the reaction delay", log.buffs.find((b) => b.kind === "invisible").delay, 0.25);
}

// The Potion of Invisibility: no Data column at all, so the floor is the whole of its fade.
{
  const log = cast("AIvi", def("AIvi", [[]], [120]));
  const invis = log.buffs[0];
  check("the Potion of Invisibility fades in over the reaction delay", invis.delay, 0.25);
  check("…for Dur1 seconds", invis.timeLeft, 120);
  check("…and carries no Backstab Damage (that is Wind Walk's DataC)", invis.value, 0);
}

// The Sorceress's Invisibility — the same buff, cast on somebody ELSE.
{
  const t = { id: 2, owner: 0, team: 0, hp: 300, maxHp: 300, x: 100, y: 0 };
  const log = cast("Aivs", def("Aivs", [[0]], [120], { targetArt: "InvisibilityTarget.mdl" }), t);
  check("Invisibility hides the TARGET, not the caster", log.buffs.map((b) => b.id), [2]);
  check("…over the reaction delay, since DataA1 reads 0", log.buffs[0].delay, 0.25);
  check("…for Dur1 = 120", log.buffs[0].timeLeft, 120);
  check("…and plays the ability's own Targetart as the cast flash", log.effects, ["InvisibilityTarget.mdl"]);
}

// …and refuses an enemy: `targs1` says "friend", and the handler asks `ally` outright.
{
  const t = { id: 2, owner: 1, team: 1, hp: 300, maxHp: 300, x: 100, y: 0 };
  const log = cast("Aivs", def("Aivs", [[0]], [120]), t);
  check("Invisibility refuses an enemy", log.buffs.length, 0);
}

// --- the break, and what it is worth (world.ts) -----------------------------------------

const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);

function walking(delay) {
  const u = {
    id: 1, owner: 0, team: 0, hp: 100, x: 0, y: 0, prevX: 0, prevY: 0,
    detectRadius: 0, invisible: delay <= 0, cloaked: true, inventory: [], weapons: [], abilities: [],
    baseArmor: 0, baseMaxHp: 100, baseMaxMana: 0, baseMoveSpeed: 270, baseSight: 1800,
    buffs: [
      { kind: "haste", group: "windwalk", timeLeft: 20, sourceId: 1, value: 0.4, value2: 0, art: "", fx: [], delay: 0 },
      { kind: "invisible", group: "windwalk", timeLeft: 20, sourceId: 1, value: 70, art: "", value2: 0, fx: [], delay },
    ],
  };
  world.units.set(u.id, u);
  return u;
}

// Struck the moment the fade landed: the blow is the backstab.
{
  const u = walking(0);
  const bonus = world.breakInvisibility(u);
  check("a blow out of a LANDED fade earns the Backstab Damage", bonus, 70);
  check("…and ends the whole ability, speed included", u.buffs.length, 0);
}

// Struck INSIDE the Transition Time: the walk is still given away — attacking is attacking —
// but it has bought nothing yet, so the blow is an ordinary blow.
{
  const u = walking(0.35);
  const bonus = world.breakInvisibility(u);
  check("a blow struck inside the transition earns nothing", bonus, 0);
  check("…but still breaks the walk", u.buffs.length, 0);
}

// The derived flags: under the effect from the press, faded only after the transition. This is
// the vulnerability window — `invisible` is what canSee and the attack paths ask, and it is
// false for the whole of it.
{
  const u = walking(0.35);
  world.recomputeStats(u);
  check("mid-transition the unit is cloaked…", u.cloaked, true);
  check("…and NOT yet invisible", u.invisible, false);
  u.buffs[1].delay = 0;
  world.recomputeStats(u);
  check("once the transition elapses it is invisible", u.invisible, true);
}

// --- and the button that must not be pressed twice ---------------------------------------
//
// `[AOwk] Cool1` is 5 seconds against a `Dur1` of 20-50, so the cooldown is long gone while
// the Blademaster is still walking. `alreadyHidden` is what both the greyed card button and
// every door into the sim ask so the press cannot happen in between.

{
  const u = walking(0.35);
  check("a hero mid-fade is already wind walking", world.alreadyHidden(u, "AOwk"), true);
  check("…and so is one whose fade has landed", world.alreadyHidden(walking(0), "AOwk"), true);
  // Asked of the BUFF's group, so being hidden by something else is a different fact: a
  // Blademaster who drank a Potion of Invisibility has not spent his own cooldown.
  const drunk = walking(0);
  drunk.buffs = drunk.buffs.filter((b) => b.kind === "invisible");
  drunk.buffs[0].group = "item:invis";
  check("a Potion's invisibility is not a Wind Walk", world.alreadyHidden(drunk, "AOwk"), false);
  // …and an ability with no self-invisibility at all is never refused by this rule.
  check("Bladestorm is not an invisibility", world.alreadyHidden(walking(0), "AOww"), false);
  const clear = walking(0);
  clear.buffs = [];
  check("a hero standing in the open may press it", world.alreadyHidden(clear, "AOwk"), false);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
