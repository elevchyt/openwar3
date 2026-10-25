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
const { PLUS_RACES, insaneVariant, rollStrategy, rollTransition, TAVERN_HEROES } = require(join(REPO, ".sim-build", "src", "ai", "plus", "races.js"));
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
    ai: { countDone: (id) => (have.has(id) ? 1 : 0), minesOwned: () => 1, gold: () => 0, wood: () => 0 },
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
  // (The Druid of the Claw waits for tier 3 — `[DRUID_CLAW] tier: 3`, the bear's tier.)
  check("…and drops it once the Dryad is up", later.map((r) => r.unit).join(","), "edry");
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
  check("…beside Riflemen that never stop", three.some((r) => r.unit === "hrif"), true);
  // The other transition (`thenAt3Or`), rolled at seat time: Gryphon Riders instead.
  const air = rollTransition(rifles, (lo, hi) => hi);
  check("a rifle seat may roll the Gryphon transition", air.thenAt3, "riflegryphons");
  check("…and the Knight one", rollTransition(rifles, (lo) => lo).thenAt3, "rifleknights");
  const airThree = buildableMix(ctx(human, air, PLUS_NORMAL, [human.halls[2], ...standing, "hgra"], 3));
  check("…which fields Gryphons and keeps its Riflemen", `${airThree.some((r) => r.unit === "hgry")},${airThree.some((r) => r.unit === "hrif")}`, "true,true");
  const sanctums = human.strategies.find((s) => s.id === "sanctums");
  check("the Sanctum build has both transitions too", [sanctums.thenAt3, ...sanctums.thenAt3Or].join(","), "sanctumknights,sanctumgryphons");
}

// THE NIGHT ELF'S LATE GAME. Reported: *"going for archers + huntresses a bit too much … later it
// should go for bears (druid of the claw + his upgrades) and dryads and even chimeras if it has
// the resources (or an expo at least)"*.
console.log("\n--- night elf: Archers and Huntresses is an opening ---");
{
  const elf = PLUS_RACES.nightelf;
  const hunt = elf.strategies.find((s) => s.id === "huntresses");
  const standing = [elf.barracks, "edob", elf.units.edoc.from, "eden"];
  const at = (tier, extra = {}) => {
    const c = ctx(elf, hunt, PLUS_INSANE, [elf.halls[tier - 1], ...standing, ...(extra.also ?? [])], tier);
    c.ai = { ...c.ai, minesOwned: () => extra.mines ?? 1, gold: () => extra.gold ?? 200, wood: () => extra.wood ?? 100 };
    return buildableMix(c).map((r) => r.unit);
  };
  check("at tier 1 it is Archers and Huntresses", at(1).includes("esen") && !at(1).includes("edoc"), true);
  // The bears build at tier 2 holds out on Archers and the Lores' Dryads; the Druid of the Claw
  // is a TIER-3 unit for Computer+ (the developer: "holding out with archers until then").
  check("…at tier 2 it has grown into Dryads behind Archers, no Druids of the Claw yet",
    `${at(2).includes("edry")},${at(2).includes("earc")},${at(2).includes("edoc")}`, "true,true,false");
  check("…and trains no more Huntresses", at(2).includes("esen"), false);
  check("at tier 3, one mine and a lean bank: druids and dryads, no Chimaeras", `${at(3).includes("edoc")},${at(3).includes("echm")}`, "true,false");
  check("…with an expansion, Chimaeras too", at(3, { mines: 2, also: ["edos"] }).includes("echm"), true);
  check("…or with the resources", at(3, { gold: 1500, wood: 800, also: ["edos"] }).includes("echm"), true);
  check("…or once a Roost already stands", at(3, { also: ["edos"] }).includes("echm"), true);
  check("every other night elf build but the air one grows into the late grove",
    elf.strategies.filter((s) => s.weight > 0 && s.id !== "chimaeras").every((s) => s.thenAt3 === "lategrove"), true);
  check("…and the air one into its own grove, bears and Dryads included",
    ["edoc", "edry"].every((u) => u in elf.strategies.find((s) => s.id === elf.strategies.find((x) => x.id === "chimaeras").thenAt3).mix), true);
  check("…which is never rolled on its own", elf.strategies.find((s) => s.id === "lategrove").weight, 0);
}

// NO TAVERN ON THE MAP, NO TAVERN HERO. The developer: "if a map doesn't have a Tavern building
// at all then the Computer+ AI just gets an altar second/third hero instead even if it was
// planning on going for a tavern hero". Every build of every race, every way the seat's stream
// can fall, with nothing for sale: three heroes, all three off the race's own altar.
console.log("\n--- no Tavern on the map: the second and third heroes are altar heroes ---");
{
  const { pickHeroOrder } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
  const streams = [(lo) => lo, (lo, hi) => hi, (lo, hi) => Math.floor((lo + hi) / 2)];
  let altarOnly = true, whole = true, distinct = true, tavernWhenSold = false;
  for (const table of Object.values(PLUS_RACES)) {
    for (const strategy of table.strategies) {
      for (const rand of streams) {
        const h = pickHeroOrder(table, strategy, () => false, rand);
        const three = [h.first, h.second, h.third];
        if (three.some((x) => !table.heroes.includes(x))) altarOnly = false;
        if (three.some((x) => !x)) whole = false;
        if (new Set(three).size !== 3) distinct = false;
        const sold = pickHeroOrder(table, strategy, () => true, rand);
        if ([sold.second, sold.third].some((x) => TAVERN_HEROES.has(x))) tavernWhenSold = true;
      }
    }
  }
  check("with no Tavern, every planned hero is one the race's altar trains", altarOnly, true);
  check("…and there are still three of them", whole, true);
  check("…three different ones", distinct, true);
  check("with a Tavern on the map, the pairings do reach for Tavern heroes", tavernWhenSold, true);
  const human = PLUS_RACES.human;
  const pal = human.strategies.find((s) => (s.heroes ?? human.heroes)[0] === "Hpal");
  check("a Paladin build's Alchemist (Tavern) becomes an altar hero with no Tavern",
    human.heroes.includes(pickHeroOrder(human, pal, () => false, () => 1).third), true);
}

// THE BUILD'S HERO ORDER IS FOLLOWED STRICTLY. The developer: "it played Orc and got Tauren
// Chieftain first and Blademaster second which is a very wrong build" — a coin flip swapped the
// second and third of a build's list, and `taurens` listed the Blademaster third. Every stream,
// every orc build, Tavern or not.
console.log("\n--- a Tauren Chieftain is never followed by a Blademaster ---");
{
  const { pickHeroOrder } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
  const orc = PLUS_RACES.orc;
  const streams = [(lo) => lo, (lo, hi) => hi, (lo, hi) => Math.floor((lo + hi) / 2)];
  let bmSecond = false, shSecond = true;
  for (const strategy of [...orc.strategies, { ...orc.strategies[0], id: "tc", heroes: ["Otch", "Obla", "Ofar", "Oshd"] }]) {
    if ((strategy.heroes ?? orc.heroes)[0] !== "Otch") continue;
    for (const rand of streams) for (const sold of [true, false]) {
      const h = pickHeroOrder(orc, strategy, () => sold, rand);
      if (h.second === "Obla") bmSecond = true;
      if (h.second !== "Oshd") shSecond = false;
    }
  }
  check("no Tauren Chieftain opening fields the Blademaster second", bmSecond, false);
  check("…it is the Shadow Hunter, every time", shSecond, true);
}

// PALADIN FIRST IS A RIFLE BUILD. The developer: "when the Human Computer+ AI goes Paladin first,
// it should get mass riflemen, not footmen!" Every human build that opens on the Paladin names
// the Rifleman as its tier-1/2 line, and no Footman at all.
console.log("\n--- a Paladin opening masses Riflemen ---");
{
  const human = PLUS_RACES.human;
  const pal = human.strategies.filter((s) => (s.heroes ?? human.heroes)[0] === "Hpal");
  check("there are Paladin builds to check", pal.length >= 2, true);
  check("every one of them names Riflemen and no Footmen",
    pal.every((s) => (s.mix.hrif ?? 0) >= 2 && !s.mix.hfoo), true);
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


// THE HERO PAIRINGS AND THE INSANE-ONLY BUILDS (plus/races.ts `HeroCombo`, `PlusStrategy.replaces`).
// The pairings are the developer's own rules, so what is pinned is that the table SAYS them; the
// two builds that replace a rolled one must never be rolled on their own, must replace only the
// openers they name, and must keep the rolled build's opening hero.
console.log("\n--- hero pairings, and the Insane-only builds ---");
{
  const { human, orc, undead, nightelf } = PLUS_RACES;
  check("Paladin → Blood Mage", human.combos.Hpal.second.join(), "Hblm");
  check("…with Siphon Mana as his first skill", human.combos.Hpal.skills.Hblm[0], "AHdr");
  check("Archmage → Mountain King", human.combos.Hamg.second.join(), "Hmkg");
  check("human third: Paladin if missing, else the Alchemist", human.combos["*"].third[0].join(), "Hpal,Nalc");
  check("Blademaster → Shadow Hunter", orc.combos.Obla.second.join(), "Oshd");
  check("Far Seer → Tauren Chieftain or Shadow Hunter", orc.combos.Ofar.second.join(), "Otch,Oshd");
  check("every Shadow Hunter build opens on Hex or Healing Wave",
    orc.skills.Oshd.every((b) => b[0] === "AOhx" || b[0] === "AOhw"), true);
  check("Death Knight → Lich", undead.combos.Udea.second.join(), "Ulic");
  check("a Crypt Lord who opens starts on Carrion Beetles", undead.combos.Ucrl.skills.Ucrl[0], "AUcb");
  check("…and as a third hero keeps Impale first", undead.skills.Ucrl[0][0], "AUim");
  check("Crypt Lord → Death Knight, then the Dark Ranger", undead.combos.Ucrl.second.join() + "/" + undead.combos.Ucrl.third.flat().join(), "Udea/Nbrn");
  check("Demon Hunter → Keeper, Naga Sea Witch or Pandaren Brewmaster", nightelf.combos.Edem.second.join(), "Ekee,Nngs,Npbm");
  check("Keeper → Demon Hunter, Pit Lord or Pandaren Brewmaster", nightelf.combos.Ekee.second.join(), "Edem,Nplh,Npbm");
  // …and the Brewmaster opens on Breath of Fire, maxes it first, and takes Drunken Haze beside
  // it — the haze is what makes the breath ignite (plus/casting.ts `DRUNKEN_HAZE`).
  const brew = nightelf.skills.Npbm[0];
  check("a Brewmaster opens on Breath of Fire", brew[0], "ANbf");
  check("…and maxes it first", brew.slice(0, 5).filter((s) => s === "ANbf").length, 3);
  check("…with Drunken Haze as his second skill", brew[1], "ANdh");
  check("every tavern hero has a skill build in every race table",
    Object.values(PLUS_RACES).every((t) => [...TAVERN_HEROES].every((h) => t.skills[h]?.length)), true);

  for (const table of Object.values(PLUS_RACES)) {
    for (let k = 1; k <= 200; k++) {
      const s = rollStrategy(table, 3, () => k);
      if (s.replaces) { check(`${table.race}: a replacing build is never rolled`, s.id, "(none)"); break; }
    }
  }
  const fs = orc.strategies.find((s) => s.id === "headhunters");
  check("Insane Far Seer: the rush on a low roll", insaneVariant(orc, fs, () => 0.1).id, "hhrush");
  check("…its own build on a high one", insaneVariant(orc, fs, () => 0.9).id, "headhunters");
  check("…and the rush keeps the Far Seer", insaneVariant(orc, fs, () => 0.1).heroes[0], "Ofar");
  const bm = orc.strategies.find((s) => s.id === "grunts");
  check("a Blademaster opening is never the rush", insaneVariant(orc, bm, () => 0).id, "grunts");
  for (const id of ["meatwagons", "ghouls", "aboms"]) {
    const s = undead.strategies.find((x) => x.id === id);
    const v = insaneVariant(undead, s, () => 0.99);
    check(`Insane undead ${id} (${s.heroes[0]}) becomes the fast expand, same opener`, `${v.id}/${v.heroes[0]}`, `fastexpand/${s.heroes[0]}`);
  }
  check("a Death Knight opening is never the fast expand",
    insaneVariant(undead, undead.strategies.find((x) => x.id === "fiends"), () => 0).id, "fiends");
}

console.log(failed === 0 ? "\nAll Computer+ plan checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
