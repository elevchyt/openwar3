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
const { nukeBurst, nukeWorthIt } = require(join(REPO, ".sim-build", "src", "ai", "plus", "casting.js"));

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
    building: null, weapon: null, weapons: [], ...over,
  };
}

// The two units the whole "who does an easy computer hit" question is about. Numbers are the
// real ones: a Tauren is 1300 hit points of meat, a Shaman 400 with a mana bar.
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

console.log("\n-- a nuke is not spent on a worker it cannot finish --------------------------");

// `nukeWorthIt` (plus/casting.ts), applied as a LEGALITY gate in `PlusCaster.pickTarget`.
// What is Warcraft III's here are the ability columns and the hit points: `Units\AbilityData.slk`
// gives Death Coil `DataA` = 200/400/600 and Frost Nova `DataB` = 100 at every rank (its share
// to the unit the missile hits — the scaling `DataA` 50/100/150 is the ring around it), and
// `UnitBalance.slk` gives a Peasant 220 hit points, an Acolyte 230, a Peon 250 and a Wisp 120.
// The RULE is the developer's: two Frost Novas on a peon is two novas spent on nothing.
const nine = () => ({ data: new Array(9).fill(NaN), dataStr: new Array(9).fill(""), buffs: [], summon: "" });
const rank = (...data) => ({ ...nine(), data: [...data, ...new Array(9 - data.length).fill(NaN)] });

const DEATH_COIL_1 = rank(200);
const DEATH_COIL_2 = rank(400);
const FROST_NOVA_1 = rank(50, 100);   // DataA ring, DataB primary
const TRANSMUTE = rank(1.25, 0);

check("Death Coil rank 1 reads its DataA", nukeBurst("AUdc", DEATH_COIL_1), 200);
check("Frost Nova reads DataB, not DataA", nukeBurst("AUfn", FROST_NOVA_1), 100);
check("an unpriced nuke scores nothing", nukeBurst("AUnknown", DEATH_COIL_1), 0);

const worker = (hp, maxHp = hp, over = {}) =>
  unit({ hp, maxHp, isPeon: true, magicImmune: false, magicReduction: 0, ...over });
const peasant = () => worker(220);
const wisp = () => worker(120);
const grunt = () => unit({ hp: 700, maxHp: 700, magicImmune: false, magicReduction: 0 });

check("Frost Nova is NOT thrown at a healthy peasant", nukeWorthIt("AUfn", FROST_NOVA_1, peasant()), false);
check("Death Coil rank 1 is not either — 200 does not finish 220",
  nukeWorthIt("AUdc", DEATH_COIL_1, peasant()), false);
check("…but rank 2 does, so it is", nukeWorthIt("AUdc", DEATH_COIL_2, peasant()), true);
check("…and rank 1 finishes one already down to 150", nukeWorthIt("AUdc", DEATH_COIL_1, worker(150, 220)), true);
// Frost Nova's primary share never scales, so it does not finish even the flimsiest worker in
// the game at full health — which is exactly the cast the developer asked us to stop making.
check("Frost Nova does not finish a full-health Wisp either", nukeWorthIt("AUfn", FROST_NOVA_1, wisp()), false);
check("…but Death Coil does", nukeWorthIt("AUdc", DEATH_COIL_1, wisp()), true);
check("Transmute takes the body whatever is left of it", nukeWorthIt("ANtm", TRANSMUTE, peasant()), true);
check("a damage-over-time 'nuke' never finishes a worker now", nukeWorthIt("ANso", rank(7.81), peasant()), false);

// The rule is ONLY about workers, and it must not quietly disarm the caster against anything else.
check("a soldier is never gated by this", nukeWorthIt("AUfn", FROST_NOVA_1, grunt()), true);
check("nor is a hero", nukeWorthIt("AUfn", FROST_NOVA_1, unit({ hp: 900, maxHp: 900, isHero: true, magicImmune: false, magicReduction: 0 })), true);

// …and it cannot promise a kill the sim will not deliver: magic immunity takes the whole cast
// and magic reduction takes a share of it, exactly as `SimWorld.spellDamage` does.
check("a magic-immune worker is never nuked", nukeWorthIt("AUdc", DEATH_COIL_2, worker(220, 220, { magicImmune: true })), false);
check("…and reduction is netted off before the comparison",
  nukeWorthIt("AUdc", DEATH_COIL_1, worker(150, 220, { magicReduction: 0.5 })), false);

// ==========================================================================================
console.log("\n-- a heal goes on the HERO first ---------------------------------------------");
// ==========================================================================================
// The one place the anti-chase reading has to be inverted rather than reused. `bodyValue` prices
// a healthy hero at barely more than a soldier, and read as-is that says heal the Footman at
// 40% before your own Archmage at 45% — which is nobody's play at any level. `HEAL_HERO` is the
// correction, and it is a PREFERENCE: the wound multiplier reaches 3x at a sliver of health, so
// a soldier about to die still outbids a lightly scratched hero.
const footman = (hp) => unit({ hp, maxHp: 1000 });
const archmage = (hp) => unit({ hp, maxHp: 1000, isHero: true });
for (const profile of [PLUS_EASY, PLUS_NORMAL, PLUS_INSANE]) {
  const name = profile === PLUS_EASY ? "Easy" : profile === PLUS_NORMAL ? "Normal" : "Insane";
  check(`${name}: the hero at 45% before the soldier at 40%`,
    pick([["footman", footman(400)], ["hero", archmage(450)]], "heal", profile), "hero");
}
// …and it is a PREFERENCE, not a rule: a soldier on its last fifth still outbids a hero that is
// merely scratched. `naive` is exempt and deliberately so — it aims by BULK, so a hero's own
// hit points already put it in front, which is the same player who Storm Bolts your Tauren.
for (const profile of [PLUS_NORMAL, PLUS_INSANE]) {
  const name = profile === PLUS_NORMAL ? "Normal" : "Insane";
  check(`${name}: …but a soldier about to die still comes first`,
    pick([["footman", footman(60)], ["hero", archmage(700)]], "heal", profile), "footman");
}

// ==========================================================================================
console.log("\n-- a building is not a target while anything is defending it ------------------");
// ==========================================================================================
// The report: "the Computer+ AI attacks buildings first when sieging an enemy's town". A Farm
// does not shoot back and will still be standing when the fight is over, so it loses to
// everything with a pulse — INCLUDING a worker, which is the comparison that matters, and at
// every difficulty. `naive` is NOT exempt this time (it is elsewhere): it reads bulk, and a
// Town Hall is three Tauren of bulk, so left alone the easy computer would be the worst
// offender of the three.
const farm = () => unit({ hp: 500, maxHp: 500, building: {} });
const hall = () => unit({ hp: 1500, maxHp: 1500, building: {} });
for (const profile of [PLUS_EASY, PLUS_NORMAL, PLUS_INSANE]) {
  const name = profile === PLUS_EASY ? "Easy" : profile === PLUS_NORMAL ? "Normal" : "Insane";
  check(`${name}: the Footman before the Farm`,
    pickKill([["farm", farm()], ["footman", unit({ hp: 420, maxHp: 420 })]], profile), "footman");
  check(`${name}: even the PEASANT before the Town Hall`,
    pickKill([["hall", hall()], ["peasant", peasant()]], profile), "peasant");
}

// …with the one exception every player makes: the building that is IN the fight. A tower cannot
// be walked away from — it goes on shooting the army's back for as long as the army is in the
// base — so it is priced as a soldier that cannot retreat, above a soldier and below a caster.
const tower = () => unit({
  hp: 500, maxHp: 500, building: {},
  weapon: { enabled: true, damage: 26, dice: 1, sides: 1, cooldown: 1, targets: ["ground", "structure"], weaponType: "missile" },
});
check("isTower: an armed building", T.isTower(tower()), true);
check("isTower: a Farm is not", T.isTower(farm()), false);
check("isTower: nor is a Footman", T.isTower(unit({})), false);
for (const profile of [PLUS_EASY, PLUS_NORMAL, PLUS_INSANE]) {
  const name = profile === PLUS_EASY ? "Easy" : profile === PLUS_NORMAL ? "Normal" : "Insane";
  check(`${name}: the Guard Tower before a Footman`,
    pickKill([["tower", tower()], ["footman", unit({ hp: 420, maxHp: 420 })]], profile), "tower");
}
check("normal: …but the Shaman before the tower", pickKill([["tower", tower()], ["shaman", shaman()]], PLUS_NORMAL), "shaman");

// The raze ladder is the other way up: for the siege, a tower first and then whatever is
// nearest falling over. A Farm at a sliver outbids one at full health.
check("razeValue: the tower first", T.razeValue(tower()) > T.razeValue(farm()), true);
check("razeValue: …then whatever is nearly down",
  T.razeValue(unit({ hp: 50, maxHp: 500, building: {} })) > T.razeValue(farm()), true);

// ==========================================================================================
console.log("\n-- …unless you are siege -----------------------------------------------------");
// ==========================================================================================
// `isSiege` is read off UnitWeapons.slk rather than off a list of ids, but the list it has to
// produce is the game's own — `AddSiege` in Scripts\common.ai names the Meat Wagon, the Mortar
// Team, the Siege Engine, the Glaive Thrower and the Demolisher. The rows below are those units'
// real columns.
const weap = (over) => ({ enabled: true, damage: 10, dice: 1, sides: 1, cooldown: 1, targets: [], weaponType: "normal", ...over });
const siegeUnit = (weapons) => unit({ weapons, weapon: weapons.find((w) => w.enabled) ?? null });

// Mortar Team (hmtm): an artillery ground shot that lists no `structure` at all, plus the
// structure-only second slot that is what actually knocks the wall down.
const mortar = () => siegeUnit([
  weap({ weaponType: "artillery", targets: ["ground", "debris", "tree", "wall", "item", "ward"] }),
  weap({ targets: ["structure"] }),
]);
// Glaive Thrower (ebal): one `aline` slot, and it does list `structure`.
const glaive = () => siegeUnit([weap({ weaponType: "aline", targets: ["ground", "structure", "debris", "wall", "item", "ward"] })]);
// Siege Engine (hrtt): not artillery at all — an `instant` cannon that can hit NOTHING but
// buildings, which is the second half of the rule.
const tank = () => siegeUnit([weap({ weaponType: "instant", targets: ["structure", "debris"] }), weap({ targets: ["air"] })]);
// Chimaera (echm): the structure-only slot is switched OFF until Corrosive Breath is bought.
const chimaera = (breath) => siegeUnit([
  weap({ enabled: breath, weaponType: "missile", targets: ["structure", "debris"] }),
  weap({ weaponType: "missile", targets: ["ground", "item", "ward", "structure", "debris"] }),
]);

check("isSiege: Mortar Team", T.isSiege(mortar()), true);
check("isSiege: Glaive Thrower", T.isSiege(glaive()), true);
check("isSiege: Siege Engine", T.isSiege(tank()), true);
check("isSiege: Chimaera with Corrosive Breath", T.isSiege(chimaera(true)), true);
check("isSiege: …and without it, not yet", T.isSiege(chimaera(false)), false);

// A Raider does SIEGE damage and is not a siege unit — which is the whole reason this is read
// off `weapTp` and the targets list rather than off `atkType1`.
const raider = () => siegeUnit([weap({ targets: ["ground", "structure", "debris", "item", "ward"] })]);
check("isSiege: a Raider is NOT siege (siege damage is not a siege unit)", T.isSiege(raider()), false);
check("isSiege: nor is a Footman", T.isSiege(siegeUnit([weap({ targets: ["ground", "structure"] })])), false);
// A Cannon Tower is artillery, and a tower is not a unit that walks to a base.
check("isSiege: nor is a Cannon Tower", T.isSiege(unit({
  building: {}, weapons: [weap({ weaponType: "artillery", targets: ["ground"] })],
})), false);
check("isSiege: nor is a worker", T.isSiege(unit({ isPeon: true, weapons: [weap({ weaponType: "artillery" })] })), false);

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
