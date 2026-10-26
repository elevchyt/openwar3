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
    ai: { countDone: (id) => (have.has(id) ? 1 : 0), townCountDone: (id) => (have.has(id) ? 1 : 0), townCount: (id) => (have.has(id) ? 1 : 0), upgradeLevel: () => 0, researchBegun: () => false, minesOwned: () => 1, gold: () => 0, wood: () => 0 },
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
  const casters = { ...orc.strategies[0], id: "casters", mix: { ogru: 1, oshm: 4, odoc: 4 }, thenAt2: undefined, thenAt3: undefined };
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
  check("…with their Priests", three.some((r) => r.unit === "hmpr"), true);
  check("…and no more Riflemen: the Knight army replaces the line", three.some((r) => r.unit === "hrif"), false);
  // The Gryphon Riders wait for "too many knights" (`waitFor`, six).
  check("…and no Gryphons beside the first Knights", three.some((r) => r.unit === "hgry"), false);
  const sixKnights = ctx(human, rifles, PLUS_NORMAL, [human.halls[2], ...standing, "hgra"], 3);
  const done = sixKnights.ai.townCountDone;
  sixKnights.ai.townCountDone = (id) => (id === "hkni" ? 6 : done(id));
  check("…but Gryphons once six Knights stand", buildableMix(sixKnights).some((r) => r.unit === "hgry"), true);
  check("…and the three Flying Machines are a lead count, not a share",
    human.strategies.find((s) => s.id === "knightpriests").lead.hgyr, 3);
  // EVERY human tier-2 build grows into the same tier 3 (the developer's Knights + Flying
  // Machines + Priests), the Sanctum build included.
  for (const id of ["rifles", "sanctums", "riflecaster", "knights"]) {
    check(`${id} grows into the Knight army`, human.strategies.find((s) => s.id === id).thenAt3, "knightpriests");
  }
  check("…with no second transition to roll", rollTransition(rifles, (lo, hi) => hi).thenAt3, "knightpriests");
}

// THE NIGHT ELF AFTER THE 48-MATCH BENCHMARK (7–16 on Insane). The developer's: more bears at tier
// 3 and Chimaeras after five or six of them; no Talon or Dryad build on Insane; a Priestess
// opening's second hero (Demon Hunter or Brewmaster) is the carry.
console.log("\n--- night elf: bears first, Chimaeras after ---");
{
  const elf = PLUS_RACES.nightelf;
  const grove = elf.strategies.find((s) => s.id === "lategrove");
  const standing = [elf.halls[2], elf.barracks, "eaoe", "edob", "eden", "edos"];
  const rich = (bears) => {
    const c = ctx(elf, grove, PLUS_INSANE, standing, 3);
    c.ai.minesOwned = () => 2; // the `affluent` half is met — the bears are what is under test
    const done = c.ai.townCountDone;
    c.ai.townCountDone = (id) => (id === "edoc" ? bears : done(id));
    return buildableMix(c);
  };
  check("the late grove is mostly bears", Object.entries(grove.mix).sort((a, b) => b[1] - a[1])[0][0], "edoc");
  // INSANE trains its druids a tier early (`insaneTier`), and only Insane (index.ts `recruit`
  // keeps them at home until Bear Form).
  const { tableForDifficulty } = require(join(REPO, ".sim-build", "src", "ai", "plus", "races.js"));
  const bears = elf.strategies.find((s) => s.id === "bears");
  const t2 = [elf.halls[1], elf.barracks, "eaoe", "edob", "eden"];
  const at2 = (insane, lores = 2) => {
    const c = ctx(tableForDifficulty(elf, insane), bears, insane ? PLUS_INSANE : PLUS_NORMAL, t2, 2);
    c.ai.townCount = (id) => (id === "eaoe" ? lores : t2.includes(id) ? 1 : 0);
    return buildableMix(c).some((r) => r.unit === "edoc");
  };
  check("an Insane night elf trains Druids of the Claw at tier 2", at2(true), true);
  check("…a Normal one waits for tier 3", at2(false), false);
  check("…and the Insane druids wait for the second Lore to be begun", at2(true, 1), false);
  check("…and the table is only changed for Insane", tableForDifficulty(elf, false), elf);
  const { heldAtHome } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
  check("a druid stays home until Master Training", [0, 1, 2].map((r) => heldAtHome("edoc", r)).join(), "true,true,false");
  check("…and nothing else does", heldAtHome("edry", 0), false);
  check("an Ancient of Lore is a tier-2 support row, two of them", elf.support.find((r) => r.build === "eaoe")?.count, 2);
  check("…the Tree of Eternity waits for it to be begun", elf.tier3After?.started?.join(), "eaoe,1");
  check("…a second Lore waits for Abolish Magic to begin", elf.support.find((r) => r.build === "eaoe").moreWhen?.researching, "Resi");
  check("…and the bear builds' druids wait for the second Lore",
    ["bears", "potmbears"].every((id) => elf.strategies.find((x) => x.id === id).waitFor?.edoc?.started?.join() === "eaoe,2"), true);
  check("…and for the second hero", elf.tier3After?.heroes, 2);
  check("…and asks for eight of them high in the ladder", grove.lead.edoc, 8);
  check("no Chimaeras beside four bears", rich(4).some((r) => r.unit === "echm"), false);
  check("…but Chimaeras once five bears stand", rich(5).some((r) => r.unit === "echm"), true);
  const chim = elf.strategies.find((s) => s.id === "chimgrove");
  check("the Chimaera build's grove waits for the same bears", chim.waitFor.echm.units.join(), "edoc,5");
  // Insane never rolls the Talon or the Dryad build; Normal still may.
  const seen = (insane) => {
    const ids = new Set();
    for (let k = 1; k <= 200; k++) ids.add(rollStrategy(elf, 3, () => k, insane).id);
    return ids;
  };
  check("Insane never rolls talons or dryads", ["talons", "dryads"].some((id) => seen(true).has(id)), false);
  check("…Normal still does", ["talons", "dryads"].every((id) => seen(false).has(id)), true);
  const { pickHeroOrder } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
  const potm = elf.strategies.find((s) => s.id === "potmbears");
  check("a build opens on the Priestess of the Moon", potm.heroes[0], "Emoo");
  const picks = [(lo) => lo, (lo, hi) => hi].map((rand) => pickHeroOrder(elf, potm, () => true, rand));
  check("…her second is the Demon Hunter or the Brewmaster", picks.map((h) => h.second).sort().join(), "Edem,Npbm");
  check("…and that hero is the carry", picks.every((h) => h.carry === h.second), true);
  check("a Demon Hunter opening's carry is the Demon Hunter", pickHeroOrder(elf, elf.strategies[0], () => true, (lo) => lo).carry, "Edem");
  check("…on every build that opens on him", elf.strategies.filter((s) => s.weight > 0 && (s.heroes ?? elf.heroes)[0] === "Edem").every((s) => s.carry === "Edem"), true);
}

// THE DEVELOPER'S HERO RULES: the Far Seer's Tauren Chieftain opens on War Stomp, a second
// Mountain King on Storm Bolt (index.ts `mountainKingSkills` makes the undead exception), and the
// human's carry is the Mountain King.
console.log("\n--- second-hero skill builds and the human carry ---");
{
  const orc = PLUS_RACES.orc;
  const human = PLUS_RACES.human;
  const ws = orc.combos.Ofar.skills.Otch;
  check("a Far Seer's Tauren Chieftain opens on War Stomp", ws[0], "AOws");
  check("…and maxes it first", ws.slice(0, 5).filter((x) => x === "AOws").length, 3);
  check("an Archmage's Mountain King opens on Storm Bolt", human.combos.Hamg.skills.Hmkg[0], "AHtb");
  const { pickHeroOrder } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
  const rifles = human.strategies.find((s) => s.id === "rifles");
  check("the human's carry is the Mountain King", pickHeroOrder(human, rifles, () => true, (lo) => lo).carry, "Hmkg");
  const fs = orc.strategies.find((s) => s.id === "fsstandard");
  check("…while a build's own carry still wins", pickHeroOrder(orc, fs, () => true, (lo) => lo).carry, "Otch");
  // Who a staff saves first: a hero, then a melee body (the bigger first), then a ranged one.
  const { staffRank } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
  const body = (o) => ({ isHero: false, maxHp: 400, weapon: { ranged: false }, ...o });
  const order = [
    body({ id: "archer", weapon: { ranged: true }, maxHp: 900 }),
    body({ id: "bear", maxHp: 960 }),
    body({ id: "dryad", weapon: { ranged: true }, maxHp: 435 }),
    body({ id: "hero", isHero: true, maxHp: 700 }),
    body({ id: "huntress", maxHp: 600 }),
  ].sort((a, b) => staffRank(b) - staffRank(a)).map((u) => u.id).join();
  check("a staff saves heroes, then melee (bigger first), then ranged", order, "hero,bear,huntress,archer,dryad");
  // The first hero ever seen of each opponent is LATCHED (`EnemyMemory.openingHeroes`).
  const { EnemyMemory } = require(join(REPO, ".sim-build", "src", "ai", "plus", "counter.js"));
  const mem = new EnemyMemory();
  mem.note({ id: 1, owner: 1, typeId: "Udre", isHero: true }, 10);
  mem.note({ id: 2, owner: 1, typeId: "Udea", isHero: true }, 300);
  mem.forget(1000, 60);
  check("an opponent's opening hero is the first one seen, and outlives the sightings", mem.openingHeroes().get(1), "Udre");
}

// ENSNARE ON THE UNDEAD'S SPINE, AND ARROWS ON WHAT IS NETTED. The developer's: "raiders should
// aim their ensnare at crypt fiends, obsidian statues and Lich more when playing against undead",
// and "ensnared targets must be focused more by ranged units if it makes sense".
console.log("\n--- Ensnare targets, and the netted are shot first ---");
{
  const { spellValue, spellFacts } = require(join(REPO, ".sim-build", "src", "ai", "plus", "targeting.js"));
  const { nettedPick } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
  const ctx = { skill: "expert", heroFocus: 0.3, harass: false };
  const body = (typeId, o = {}) => ({ typeId, hp: 500, maxHp: 500, maxMana: 0, isHero: false, isSummon: false, isPeon: false, building: null, weapon: null, ...o });
  const net = spellFacts(12, 3, "Aens");
  const ranked = [body("ugho", { hp: 340, maxHp: 340 }), body("uabo", { hp: 1080, maxHp: 1080 }), body("ucry", { hp: 550, maxHp: 550 }), body("uobs", { hp: 700, maxHp: 700, maxMana: 200 })]
    .sort((x, y) => spellValue(y, "disable", ctx, net) - spellValue(x, "disable", ctx, net)).map((t) => t.typeId);
  check("Ensnare goes on the Statue and the Fiend before an Abomination or a Ghoul", ranked.slice(0, 2).sort().join(), "ucry,uobs");
  const plain = spellFacts(12, 3);
  check("…and only Ensnare: another disable reads them as before",
    spellValue(body("ucry"), "disable", ctx, plain) < spellValue(body("ucry"), "disable", ctx, net), true);
  const archer = { x: 0, y: 0, radius: 16, weapon: { ranged: true, range: 600 } };
  const foe = (id, x, netted, hp = 400) => ({ id, x, y: 0, radius: 16, hp, maxHp: 500, building: null, buffs: netted ? [{ group: "ensnare" }] : [] });
  check("a ranged unit shoots the netted enemy in reach", nettedPick(archer, [foe(1, 300, false, 100), foe(2, 400, true)], () => true)?.id, 2);
  check("…not one out of reach", nettedPick(archer, [foe(3, 1400, true)], () => true), null);
  check("…and a melee unit is not asked", nettedPick({ ...archer, weapon: { ranged: false, range: 100 } }, [foe(4, 50, true)], () => true), null);
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
    const done = c.ai.townCountDone;
    c.ai = { ...c.ai, minesOwned: () => extra.mines ?? 1, gold: () => extra.gold ?? 200, wood: () => extra.wood ?? 100,
      townCountDone: (id) => (id === "edoc" ? extra.bears ?? 0 : done(id)) };
    return buildableMix(c).map((r) => r.unit);
  };
  check("at tier 1 it is Archers and Huntresses", at(1).includes("esen") && !at(1).includes("edoc"), true);
  // The bears build at tier 2 holds out on Archers and the Lores' Dryads; the Druid of the Claw
  // is a TIER-3 unit for Computer+ (the developer: "holding out with archers until then").
  check("…at tier 2 it has grown into Dryads behind Archers, no Druids of the Claw yet",
    `${at(2).includes("edry")},${at(2).includes("earc")},${at(2).includes("edoc")}`, "true,true,false");
  check("…and trains no more Huntresses", at(2).includes("esen"), false);
  check("at tier 3, one mine and a lean bank: druids and dryads, no Chimaeras", `${at(3).includes("edoc")},${at(3).includes("echm")}`, "true,false");
  // …and every one of these with the five bears the Chimaeras also wait for (`waitFor`).
  check("…with an expansion, Chimaeras too", at(3, { mines: 2, also: ["edos"], bears: 5 }).includes("echm"), true);
  check("…or with the resources", at(3, { gold: 1500, wood: 800, also: ["edos"], bears: 5 }).includes("echm"), true);
  check("…or once a Roost already stands", at(3, { also: ["edos"], bears: 5 }).includes("echm"), true);
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
  check("…then the Tauren Chieftain", orc.combos.Obla.third.map((o) => o.join("/")).join(), "Otch");
  check("Far Seer → Tauren Chieftain", orc.combos.Ofar.second.join(), "Otch");
  check("…then the Shadow Hunter", orc.combos.Ofar.third.map((o) => o.join("/")).join(), "Oshd");
  check("a Blademaster maxes Critical Strike first, in every build",
    orc.skills.Obla.every((b) => b[0] === "AOcr" && b.slice(0, 5).filter((x) => x === "AOcr").length === 3), true);
  // The orc plays TWO openings (Blademaster, Far Seer), each with two tier-2 plans.
  const rolled = orc.strategies.filter((s) => s.weight > 0);
  check("the orc rolls four builds", rolled.map((s) => s.id).join(), "bmraiders,bmstandard,fsraiders,fsstandard");
  check("…two Blademaster and two Far Seer openings", rolled.map((s) => s.heroes[0]).join(), "Obla,Obla,Ofar,Ofar");
  check("…a Far Seer build's carry is the Tauren Chieftain", rolled.filter((s) => s.heroes[0] === "Ofar").every((s) => s.carry === "Otch"), true);
  check("…a Blademaster build's carry is the Blademaster", rolled.filter((s) => s.heroes[0] === "Obla").every((s) => s.carry === "Obla"), true);
  // Each opening grows into its tier-2 ARMY at the Stronghold: Head Hunters as the main damage,
  // four Raiders and the Kodo as counts (the developer's "3-4 raiders and the rest should be
  // headhunters and maybe 1-2 grunts").
  const at2 = (s) => orc.strategies.find((x) => x.id === s.thenAt2);
  check("…every one grows into a tier-2 army", rolled.every((s) => !!at2(s)), true);
  check("…with four Raiders and one Kodo as counts", rolled.every((s) => at2(s).lead?.orai === 4 && at2(s).lead?.okod === 1), true);
  check("…and Head Hunters as the main damage", rolled.every((s) => Object.entries(at2(s).mix).sort((a, b) => b[1] - a[1])[0][0] === "ohun"), true);
  check("…the standard plans wait for three Raiders before the Fortress",
    rolled.filter((s) => s.id.endsWith("standard")).every((s) => s.tier3After?.units?.join() === "orai,3"), true);
  check("…and grows into the Tauren army", rolled.every((s) => s.thenAt3 === "taurens"), true);
  check("…and researches Ensnare once a Raider is out", orc.upgrades.find((u) => u.id === "Roen").forUnit, "orai");
  // A ranged hero is walked behind its line (index.ts `backlineSpot`).
  const { backlineSpot } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
  const enemyAt = { x: 1000, y: 0 }, line = { x: 600, y: 0 };
  check("a ranged hero ahead of its melee line is walked behind it", JSON.stringify(backlineSpot({ x: 700, y: 0 }, enemyAt, 500, line)), JSON.stringify({ x: 300, y: 0 }));
  check("…one already behind it, with nobody close, is left alone", backlineSpot({ x: 400, y: 0 }, enemyAt, 600, line), null);
  check("…and with no line it steps out of reach", JSON.stringify(backlineSpot({ x: 800, y: 0 }, enemyAt, 200, null)), JSON.stringify({ x: 500, y: 0 }));
  const taurens = orc.strategies.find((x) => x.id === "taurens");
  check("…and two Kodo Beasts at tier 3", taurens.lead?.okod, 2);
  const drums = orc.upgrades.find((u) => u.id === "Rwdm");
  check("War Drums is a saved-for unlock, once a Kodo is out", `${drums.unlock},${drums.ranks},${drums.forUnit}`, "true,1,okod");
  check("the two-Beastiary builds hold tier 3 to their own clock", rolled.filter((s) => at2(s).factories?.obea === 2).every((s) => s.tier3Clock === 600), true);
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
  // The Head Hunter rush is gone: a Far Seer opening now techs (the developer's "mass producing
  // head hunters while also teching up"), so no orc build replaces another on Insane.
  for (const s of orc.strategies.filter((x) => x.weight > 0)) {
    check(`Insane orc ${s.id} plays itself`, insaneVariant(orc, s, () => 0).id, s.id);
  }
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
