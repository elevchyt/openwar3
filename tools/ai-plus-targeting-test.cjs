// Headless check of Computer+'s TARGET LADDER (src/ai/plus/targeting.ts).
//
// This is the file both Computer+ target pickers go through — `plus/casting.ts` for "where does
// this button point" and `plus/index.ts` for "who does the squad kill first" — and it is pure:
// units in, a number out, no world and no orders. So it is testable exactly as written, and the
// two behaviours it exists to produce are the two that are worth pinning down:
//
//   1. a DIFFICULTY AIMS DIFFERENTLY, not just faster. An easy computer reads a fight by bulk
//      and puts its Storm Bolt on the Tauren; an insane one puts it on the Shaman.
//   2. it DOES NOT CHASE HEROES. A healthy hero is worth barely more than a soldier and loses to
//      a spellcaster; a hero that can be finished is the best target on the field.
//
// None of these numbers are Warcraft III's (see the file header) — this test pins OUR tuning so
// a later edit to it is a deliberate one. The two facts that ARE the game's are `herodur1/dur1`
// (a stun on a hero is a fraction of a stun) and the weapon damage roll.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const T = require(join(REPO, ".sim-build", "src", "ai", "plus", "targeting.js"));
const { PLUS_EASY, PLUS_NORMAL, PLUS_INSANE } = require(join(REPO, ".sim-build", "src", "ai", "plus", "profile.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A unit, only the fields the ladder reads. */
function unit(over = {}) {
  return {
    hp: 100, maxHp: 100, maxMana: 0, isHero: false, isSummon: false, isPeon: false,
    weapon: null, ...over,
  };
}

// The two units the whole "who does an easy computer hit" question is about. Numbers are the
// 1.27a ones: a Tauren is 1300 hit points of meat, a Shaman 400 with a mana bar.
const tauren = () => unit({ hp: 1300, maxHp: 1300 });
const shaman = () => unit({ hp: 400, maxHp: 400, maxMana: 300 });

/** Which of a list scores highest for a role — the pick, without the distance tie-break. */
function pick(units, role, profile, facts) {
  const ctx = T.aimCtx(profile);
  let best = null;
  let bestScore = -Infinity;
  for (const [name, u] of units) {
    const s = T.spellValue(u, role, ctx, facts);
    if (s > bestScore) { bestScore = s; best = name; }
  }
  return best;
}

function pickKill(units, profile) {
  const ctx = T.aimCtx(profile);
  let best = null;
  let bestScore = -Infinity;
  for (const [name, u] of units) {
    const s = T.killValue(u, ctx);
    if (s > bestScore) { bestScore = s; best = name; }
  }
  return best;
}

console.log("\n-- a difficulty aims differently --------------------------------------------");

// The request this file was written for: "easy computer should Storm Bolt high hp units like
// Taurens". A naive read is bulk and nothing else, so the biggest body wins.
const line = [["tauren", tauren()], ["shaman", shaman()]];
check("easy disables the TAUREN (biggest body)", pick(line, "disable", PLUS_EASY), "tauren");
check("normal disables the SHAMAN (kill the support)", pick(line, "disable", PLUS_NORMAL), "shaman");
check("insane disables the SHAMAN", pick(line, "disable", PLUS_INSANE), "shaman");
check("easy nukes the TAUREN too", pick(line, "nuke", PLUS_EASY), "tauren");

// A summon is leaving on its own clock; only the naive read is fooled by how big it is.
const withSummon = [["shaman", shaman()], ["infernal", unit({ hp: 1200, maxHp: 1200, isSummon: true })]];
check("easy nukes the big SUMMON", pick(withSummon, "nuke", PLUS_EASY), "infernal");
check("insane ignores it", pick(withSummon, "nuke", PLUS_INSANE), "shaman");

console.log("\n-- expert: what the SPELL is for --------------------------------------------");

// "Lowest bar" and "one I can actually kill" are different units: 23 % of a Tauren is 300 hit
// points, which is more than a whole wounded Footman. A sound player takes the percentage; an
// expert takes the kill.
const finish = [
  ["hurtTauren", unit({ hp: 300, maxHp: 1300 })],
  ["hurtFootman", unit({ hp: 150, maxHp: 400 })],
];
check("normal nukes the lowest PERCENTAGE", pick(finish, "nuke", PLUS_NORMAL), "hurtTauren");
check("insane nukes the one it can FINISH", pick(finish, "nuke", PLUS_INSANE), "hurtFootman");

// Damage per second, off the weapon's own roll — the expert's "who is hurting us most".
const dps = [
  ["knight", unit({ hp: 800, maxHp: 800, weapon: { enabled: true, damage: 30, dice: 2, sides: 6, cooldown: 1.35 } })],
  ["militia", unit({ hp: 800, maxHp: 800, weapon: { enabled: true, damage: 6, dice: 1, sides: 2, cooldown: 1.9 } })],
];
check("insane disables the harder hitter", pick(dps, "disable", PLUS_INSANE), "knight");

// `herodur1 / dur1` — the game's own number. Storm Bolt is 5 s on a soldier and 1.5 s on a hero,
// so a stun spent on a hero buys a fraction of the fight it buys on a Footman.
const stun = [["hero", unit({ hp: 900, maxHp: 900, isHero: true })], ["footman", unit({ hp: 420, maxHp: 420 })]];
const bolt = T.spellFacts(5, 1.5);
check("herodur1 known: insane stuns the FOOTMAN", pick(stun, "disable", PLUS_INSANE, bolt), "footman");
check("no duration to shorten: it stuns the HERO", pick(stun, "disable", PLUS_INSANE), "hero");
check("spellFacts with no duration is neutral", T.spellFacts(0, 0).heroDurationRatio, 1);

console.log("\n-- it does not chase heroes -------------------------------------------------");

const healthyHero = unit({ hp: 900, maxHp: 900, isHero: true });
const killableHero = unit({ hp: 180, maxHp: 900, isHero: true });
check("a healthy hero is NOT killable", T.heroKillable(healthyHero), false);
check("…and one at 20 % is", T.heroKillable(killableHero), true);

check(
  "insane kills the SHAMAN over a healthy hero",
  pickKill([["hero", healthyHero], ["shaman", shaman()]], PLUS_INSANE),
  "shaman",
);
check(
  "…and the HERO once it can be finished",
  pickKill([["hero", killableHero], ["shaman", shaman()]], PLUS_INSANE),
  "hero",
);
check(
  "normal does not chase a healthy hero either",
  pickKill([["hero", healthyHero], ["shaman", shaman()]], PLUS_NORMAL),
  "shaman",
);

// A hero is never worth LESS than a soldier, whatever `heroFocus` is — an AI that refuses to
// touch heroes is as broken as one that touches nothing else.
const soldier = unit({ hp: 420, maxHp: 420 });
for (const [name, p] of [["easy", PLUS_EASY], ["normal", PLUS_NORMAL], ["insane", PLUS_INSANE]]) {
  const ctx = T.aimCtx(p);
  check(`${name}: a healthy hero still outranks a footman`,
    T.killValue(healthyHero, ctx) > T.killValue(soldier, ctx), true);
}

console.log("\n-- raiding ------------------------------------------------------------------");

// `harass` is what turns a worker from noise into the reason we walked into this base.
const base = [["peon", unit({ hp: 220, maxHp: 220, isPeon: true })], ["grunt", unit({ hp: 700, maxHp: 700 })]];
check("not raiding: it swings at the grunt", pickKill(base, PLUS_NORMAL), "grunt");
check("raiding (insane): it goes for the worker", pickKill(base, PLUS_INSANE), "peon");

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
