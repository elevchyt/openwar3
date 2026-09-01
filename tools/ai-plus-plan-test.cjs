// Headless check of the one Computer+ decision that could leave a computer with NO ARMY AT ALL:
// what `plus/plan.ts` finds to train (`buildableMix`).
//
// What this is here to pin, and it is one thing said two ways:
//
//   1. EVERY BUILD CAN OPEN. A strategy names the army it INTENDS to field, and several builds
//      in plus/races.ts can field none of it in the first two minutes — the night elf's
//      `chimaeras` (its Huntress waits on a Hunter's Hall), the undead's `aboms` and
//      `frostwyrms` (their Crypt Fiend waits on a Graveyard) and all three rifle builds, whose
//      tier-1 Rifleman waits on a Blacksmith. With nothing to ask for, the
//      army rows emitted nothing; and because every "don't tech with nothing on the field" gate
//      in the plan is stated in ARMY FOOD (`TIER2_ARMY`, `SupportRow.after`, `TECH_AFTER`), the
//      field stayed empty and the gates stayed shut. Reported from a real match: a Normal orc
//      training no Grunts and a Normal night elf training no Archers, while the undead — whose
//      Ghouls come out of the ECONOMY (`lumberUnits`) and not out of the mix — played normally.
//   2. THE FALLBACK IS ONLY A FALLBACK. The moment one row of the build order can be produced,
//      the opening soldier stops being offered: this must not quietly turn every build into
//      Footmen-and-tech.
//
// None of these numbers are Warcraft III's — nothing in the install describes an improved AI —
// so what is pinned here is OUR tuning. What is the game's is the catalogue it reads: which
// building makes a unit, and at which hall tier (plus/races.ts, off the race UnitFunc tables).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { buildableMix } = require(join(REPO, ".sim-build", "src", "ai", "plus", "plan.js"));
const { PLUS_RACES } = require(join(REPO, ".sim-build", "src", "ai", "plus", "races.js"));
const { PLUS_EASY, PLUS_NORMAL, PLUS_INSANE } = require(join(REPO, ".sim-build", "src", "ai", "plus", "profile.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/**
 * A `PlusCtx` with a named set of our buildings STANDING and nothing else. Only the four things
 * `buildableMix` reads are real; the rest of the context belongs to other rows of the ladder.
 */
function ctx(table, strategy, profile, standing, tier) {
  const have = new Set(standing);
  return {
    ai: { countDone: (id) => (have.has(id) ? 1 : 0) },
    profile, table, strategy, tier,
    // Nothing scouted, so the counter half of the weighting is off and the weights under test
    // are the build order's own.
    enemy: { seen: 0, share: () => 0 },
    clock: 0, armyFood: 0, threatened: false, workerChops: true,
    foodOf: () => 2,
    defOf: () => undefined,
  };
}

// The opening every race actually plays: a hall and the building the opening is built around.
// That is the state `buildPlan` reaches within the first two minutes and holds until the
// tier-up, so it is the state that decides whether anything is ever trained.
console.log("--- every build order can open ---");
for (const [race, table] of Object.entries(PLUS_RACES)) {
  for (const strategy of table.strategies) {
    const rows = buildableMix(ctx(table, strategy, PLUS_NORMAL, [table.halls[0], table.barracks], 1));
    check(`${race}/${strategy.id} has something to train at tier 1`, rows.length > 0, true);
  }
}

// …and it is the race's OWN opening soldier, derived off the catalogue rather than named: the
// lowest-tier thing the barracks makes that needs nothing else standing.
console.log("\n--- the fallback is the race's basic soldier ---");
const OPENING = { human: "hfoo", orc: "ogru", undead: "ugho", nightelf: "earc" };
for (const [race, table] of Object.entries(PLUS_RACES)) {
  // A build that names nothing buildable — the shape `bears` / `gryphons` / `aboms` have.
  const empty = { ...table.strategies[0], id: "empty", mix: {} };
  const rows = buildableMix(ctx(table, empty, PLUS_NORMAL, [table.halls[0], table.barracks], 1));
  check(`${race} falls back on its opening soldier`, rows.map((r) => r.unit).join(","), OPENING[race]);
}

// The Rifleman is the trap the derivation has to avoid: a tier-1 unit that waits on a Blacksmith,
// and a Blacksmith waits on army food — so falling back on it would be the same deadlock again.
console.log("\n--- the fallback needs nothing standing but the barracks ---");
{
  const human = PLUS_RACES.human;
  const empty = { ...human.strategies[0], id: "empty", mix: {} };
  const rows = buildableMix(ctx(human, empty, PLUS_NORMAL, [human.halls[0], human.barracks], 1));
  check("human falls back on the Footman, not the Rifleman", rows[0] && rows[0].unit, "hfoo");
}

// …and with no barracks there is nothing to fall back ON, which must stay true: a row for a unit
// whose producer is missing starves every row under it (`OneBuildLoop` reserves its gold anyway).
console.log("\n--- nothing is asked for that cannot be built ---");
for (const [race, table] of Object.entries(PLUS_RACES)) {
  const empty = { ...table.strategies[0], id: "empty", mix: {} };
  const rows = buildableMix(ctx(table, empty, PLUS_NORMAL, [table.halls[0]], 1));
  check(`${race} asks for nothing with no ${table.barracks} standing`, rows.length, 0);
}

// The fallback yields the moment the build order itself comes online — otherwise every build
// would quietly become "the basic soldier and tech".
console.log("\n--- the fallback is only a fallback ---");
{
  const elf = PLUS_RACES.nightelf;
  // A build that names nothing below tier 2 — the shape the undead's `aboms` and the human's
  // `gryphons` still have. (`bears` itself now opens on Archers of its own, which is the point
  // of the rewritten tables: a build order that can be played from the first minute.)
  const late = { ...elf.strategies.find((s) => s.id === "bears"), id: "late", mix: { edry: 2, edoc: 1 } };
  // Tier 1, only the War: nothing it names can be made, so the Archer stands in.
  const early = buildableMix(ctx(elf, late, PLUS_NORMAL, [elf.halls[0], elf.barracks], 1));
  check("a tier-2 elf build opens on Archers", early.map((r) => r.unit).join(","), "earc");
  // Tier 2 with an Ancient of Lore up: the mix can be produced, so the Archer is not offered.
  const later = buildableMix(ctx(elf, late, PLUS_NORMAL, [elf.halls[1], elf.barracks, "eaoe"], 2));
  check("…and drops it once the Dryad is up", later.map((r) => r.unit).join(","), "edry,edoc");
}

// THE LAST RESORT is everything the opening building can still make, not one named unit: a
// build whose tier-2 producers have been razed goes back to the whole tier-1 line.
console.log("\n--- the last resort is the whole tier-1 line ---");
{
  const human = PLUS_RACES.human;
  const sanctums = human.strategies.find((s) => s.id === "sanctums");
  const razed = { ...sanctums, id: "razed", mix: { hspt: 2, hsor: 1 } };
  // A Keep and a Blacksmith standing and no Arcane Sanctum — the shape a raid leaves behind.
  const rows = buildableMix(ctx(human, razed, PLUS_NORMAL, [human.halls[1], human.barracks, "hbla"], 2));
  check("human falls back on Footmen AND Riflemen", rows.map((r) => r.unit).sort().join(","), "hfoo,hrif");
}

// THE CASTER SHARE. No build order asks for an army of nothing but Shamans, and the counter
// re-weighting can still get there (it cannot score a spell, so it only ever pushes the units
// around them). `CASTER_SHARE` is the backstop: half the army, never more.
console.log("\n--- spellcasters are a share of the army, not the army ---");
{
  const orc = PLUS_RACES.orc;
  const casters = { ...orc.strategies[0], id: "casters", mix: { ogru: 1, oshm: 4, odoc: 4 } };
  const rows = buildableMix(ctx(orc, casters, PLUS_NORMAL, [orc.halls[1], orc.barracks, "osld", "ofor"], 2));
  const total = rows.reduce((n, r) => n + r.weight, 0);
  const share = rows.filter((r) => orc.units[r.unit].caster).reduce((n, r) => n + r.weight, 0) / total;
  check("a caster-only mix is capped at half the army", Math.round(share * 100) / 100, 0.5);
  check("…and the soldier keeps its own weight", rows.find((r) => r.unit === "ogru").weight, 1);
}
{
  // …and a build that MEANS to be half casters is left exactly where its weights put it.
  const human = PLUS_RACES.human;
  const sanctums = human.strategies.find((s) => s.id === "sanctums");
  const standing = [human.halls[1], human.barracks, "hars", "hvlt"];
  const rows = buildableMix(ctx(human, sanctums, PLUS_NORMAL, standing, 2));
  const of = (id) => rows.find((r) => r.unit === id).weight;
  check("the double Sanctum keeps its Priests and Sorceresses", `${of("hmpr")},${of("hsor")}`, "1.5,1.5");
}

// A BUILD THAT NAMES A SUCCESSOR grows into it when the tier-3 hall lands, and not before.
console.log("\n--- thenAt3: the tier-3 transition ---");
{
  const human = PLUS_RACES.human;
  const rifles = human.strategies.find((s) => s.id === "rifles");
  const standing = [human.barracks, "hbla", "hlum", "hars", "harm"];
  const two = buildableMix(ctx(human, rifles, PLUS_NORMAL, [human.halls[1], ...standing], 2));
  check("the rifle build is Riflemen at tier 2", two.some((r) => r.unit === "hrif"), true);
  check("…and no Knights yet", two.some((r) => r.unit === "hkni"), false);
  const three = buildableMix(ctx(human, rifles, PLUS_NORMAL, [human.halls[2], ...standing], 3));
  check("…and Knights once the Castle is standing", three.some((r) => r.unit === "hkni"), true);
}

// The cap is the difficulty's, not the fallback's: an Easy computer never reaches past tier 1
// and must still open, and an Insane one gets the same opening for the same reason.
console.log("\n--- every difficulty opens the same way ---");
for (const profile of [PLUS_EASY, PLUS_NORMAL, PLUS_INSANE]) {
  const orc = PLUS_RACES.orc;
  const empty = { ...orc.strategies[0], id: "empty", mix: {} };
  const rows = buildableMix(ctx(orc, empty, profile, [orc.halls[0], orc.barracks], 1));
  check(`orc opens on Grunts at difficulty ${profile.difficulty}`, rows.map((r) => r.unit).join(","), "ogru");
}

console.log(failed === 0 ? "\nAll Computer+ plan checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
