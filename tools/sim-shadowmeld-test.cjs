// Headless check of Shadow Meld (`Ashm`) — the night elf racial, and the one invisibility
// that is a STANCE rather than a spell.
//
// Two halves are verified, because the ability lives in two places:
//   1. the handler (spells.ts)  — which Data column it spends, and the buff it builds
//   2. tickMeld (world.ts)      — the two break conditions no other invisibility has
//
// Numbers are the real 1.27a ones from Units\AbilityData.slk, with the column meanings from
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

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
