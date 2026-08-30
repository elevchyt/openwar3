import type { UnitDef } from "../../data/units";
import type { AiPlayer } from "../aiPlayer";
import { counterScore, type EnemyRead } from "./counter";
import type { PlusProfile } from "./profile";
import type { PlusRaceTable, PlusStrategy } from "./races";

// Computer+ — the build plan (issue #124).
//
// ONE routine for all four races. Where the classic AI has four transcribed Blizzard scripts
// (src/ai/human.ts and siblings), Computer+ has this and four tables (plus/races.ts), because
// a melee opening is the same game in four vocabularies: keep the workers coming, stay ahead
// of your food, get a hero out, get an army out, tech, upgrade, expand.
//
// **What it inherits and what it replaces.** It still fills `AiPlayer`'s build array and lets
// `OneBuildLoop` spend down it — that is common.ai's LIBRARY and it is the same machinery a
// human player's gold obeys: rows are a priority ladder, a row's cost is reserved whether or
// not it started, and the loop stops at the first row it cannot afford. What is replaced is
// the STRATEGY on top: what goes in the ladder, in what order, and how much of it.
//
// Two rules run through the whole file and are worth stating once:
//
//  1. **Nothing is asked for that cannot be built.** Because a row reserves its gold even when
//     it could not start, a row for a unit whose producer is missing silently starves every
//     row under it. So every army/tech row is gated on its producer STANDING (`countDone`),
//     never on "we intend to have one".
//  2. **The strategy names UNITS; everything else is derived.** A build says "Gryphon Riders,
//     Dragonhawks, a few Riflemen" and the buildings it needs (`UnitRow.from` / `needs`) and
//     the upgrades it takes (whichever its buildings can research) fall out of that. A strategy
//     therefore cannot ask for a unit it has not built the producer for — see plus/races.ts.
//  3. **The army has a ceiling, and it is enforced here.** `PlusProfile.armyFood` is a food
//     budget spent down the race's mix; an easy computer asks for twelve food of soldiers and
//     then stops asking. That is issue #124's "must NOT mass armies at all (must have
//     constraints for this)", and it has to be at PRODUCTION — an AI that builds twenty Grunts
//     and attacks with six still owns twenty Grunts when you walk into its base.

/** Everything the plan reads about the world. Assembled once per pass by the brain, which is
 *  the half that has the host and can count things. */
export interface PlusCtx {
  readonly ai: AiPlayer;
  readonly profile: PlusProfile;
  readonly table: PlusRaceTable;
  /** The build this player rolled at seat time (plus/races.ts). */
  readonly strategy: PlusStrategy;
  /** The enemy army as this player has SCOUTED it — the input to countering. Empty until
   *  something has been seen, which is the whole of "it only counters what it has seen". */
  readonly enemy: EnemyRead;
  /** Seconds since this computer was seated. */
  readonly clock: number;
  /** Food currently spent on FIGHTERS — workers, buildings and the things they are building
   *  left out, production queues counted in. The number the whole plan is scaled by. */
  readonly armyFood: number;
  /** The highest hall tier STANDING (1/2/3). */
  readonly tier: number;
  /** Is something hostile in one of our towns right now. */
  readonly threatened: boolean;
  /**
   * Can this player's ORDINARY worker chop? False for exactly one race, and it changes what a
   * worker is FOR — see `workers`.
   *
   * Asked of the data (`WorkerState.lumber` off a worker actually standing on the field)
   * rather than of the race, for the same reason `ComputerPlusAi.lumberCrew` asks it that way:
   * a custom map that hands its Acolytes an axe is then answered correctly with no list of
   * races anywhere.
   */
  readonly workerChops: boolean;
  /** A unit type's food cost. */
  foodOf(id: string): number;
  /** A unit type's whole row — what `counterScore` reads its attack type and weapons off. */
  defOf(id: string): UnitDef | undefined;
}

/** How much food headroom to keep. Six is one Farm's worth of slack, which is about how far
 *  ahead a player who is paying attention stays. */
const FOOD_HEADROOM = 6;

/** Army food that has to be on the field before the AI spends on teching up a tier. Teching
 *  with nothing out is how a computer dies to the first six Footmen it meets. */
const TIER2_ARMY = 8;
const TIER3_ARMY = 20;

/**
 * …and WHEN the tier-up stops waiting its turn in the ladder — the developer's own "tier 2
 * transition starts at around 3-4 mins for all races".
 *
 * It is a POSITION rather than a permission: `tierUp` emits the same row wherever it is called
 * from, and this clock is what moves it above the things that were quietly eating the gold it
 * needed (`tierUpDue`, and the ladder in `buildPlan`). Below the tier-up sit the Forge, the
 * upgrades, the shop and the expansion, and the reason they are above it is real — a 200-gold
 * Forge makes the army you already have better, where a Keep is 320 and blocks everything under
 * it while the AI saves. But "cheap things first" with no clock on it is a computer that never
 * tiers at all: there is always another upgrade, and a `setBuildNext` army row asks for one more
 * soldier every pass, for ever. Three minutes is when a ladder player has their hall going up.
 *
 * Only tier 2 has one. Tier 3 keeps its old place at the bottom, where the same argument runs
 * the other way: at ten minutes there is an army on the field to spend on, and the thing that
 * loses games there is teching past what you can defend.
 */
const TIER2_CLOCK = 180;

/**
 * The army the plan keeps while it is teching — a hero and four or five soldiers.
 *
 * It is a FLOOR, not the army it intends to fight with: the rest of the mix is bought after the
 * tier, the tech and the upgrades have been paid for. Capped again by the profile, so an easy
 * computer's twelve-food ceiling is not quietly raised by it.
 *
 * Note this number does not change how much gold a pass RESERVES — the rows use `SetBuildNext`,
 * which asks for one more than is finished whatever the target is. It only decides how big the
 * army gets before the plan starts banking for a Stronghold.
 *
 * It GROWS WITH THE TIER, and that is a fix rather than a flourish. A tier-up is a unit row and
 * halts the ladder while the AI saves for it, so everything under it — the towers, and above
 * all the `army(profile.armyFood)` row that is the bulk of the army — stops for the whole of
 * that wait. Sixteen food is a reasonable floor to hold while saving 315 for a Stronghold; it
 * is not a reasonable one to hold while saving a THOUSAND for a Fortress, and a computer that
 * stood at sixteen food from the sixth minute to the ninth is the developer's "not building an
 * army" seen at the other end of the game. A player keeps growing the army they already have
 * while the hall goes up. Capped by the profile throughout, so an Easy computer's twelve-food
 * ceiling is never quietly raised by it.
 */
const CORE_ARMY_FOOD = 16;
/** …and by how much per tier standing — 16 / 24 / 32, before the profile's own cap. */
const CORE_ARMY_PER_TIER = 8;

/** The floor as this pass sees it. */
function coreArmy(c: PlusCtx): number {
  return Math.min(c.profile.armyFood, CORE_ARMY_FOOD + CORE_ARMY_PER_TIER * Math.max(0, c.tier - 1));
}

/** Workers on a mine. WC3 mines take five at a time, so a sixth is a peasant standing in a
 *  queue: five per town, everybody else in the trees. */
const MINE_CREW = 5;

/**
 * …and how many go to the TREES before anything else is bought — the opening forest crew.
 *
 * Reported: "Computer+ takes a lot of minutes to start training wisps for gathering lumber…
 * lumber wisps should be trained as soon as possible independent of the build order." It is
 * not a preference, it is a DEADLOCK, and a night elf match shows the whole of it: `mineCrew`
 * asks for five wisps and a spare, `harvestPlan` puts five in the mine, and that leaves ONE
 * wisp in the trees. The next row the ladder cannot pay for is the hero — 425 gold and **100
 * lumber** — and `runBuildLoop` RETURNS at a row it cannot afford, so everything under it
 * stops, `workers` (the row that would train more lumberjacks) included. One wisp chops at
 * about ten lumber a quarter-minute, so the AI stood in its base for **four and a half
 * minutes** with six wisps, no hero, no second building and two and a half THOUSAND gold
 * banked, waiting for the one lumberjack it had to earn the hundred wood that would let the
 * row it was stuck on move — the only row that could have hired a second lumberjack being
 * underneath it.
 *
 * Four, so the forest has five with the spare in it and the mine keeps its own five: that is
 * the opening every race actually plays, and it is what turns a hundred lumber from four
 * minutes' work into one. It is a BOUNDED target, which is what makes it safe to put above the
 * hero where the old `workers` row was not (see `workers`): it asks for ten workers and then
 * stops asking, where a row for the profile's whole economy asks for one more every pass for
 * ever and the altar underneath it is never reached.
 */
const LUMBER_OPENING = 4;

/**
 * The forest's crew for a race whose WORKER cannot chop — the undead, and only the undead —
 * AND the creeping party it has to leave over.
 *
 * Six Ghouls. It is deliberately stated as a PRODUCTION row rather than left to the army mix:
 * two of the five undead builds (`aboms`, `gargoyles`) name no Ghoul at all, and under those the
 * race chopped nothing whatever for the whole match — but that is only half of what this row is
 * for, and six rather than five is the other half. `ComputerPlusAi.lumberCrew` keeps a THIRD of
 * the ghouls on the trees (`LUMBER_SHARE`), so this row is what decides how big the party the
 * hero creeps with is, and the bar it has to clear is `plus/power.ts`'s green one: a Ghoul is
 * 340 hit points and 13 damage over a 1.3-second cooldown (UnitBalance `realHP`, UnitWeapons
 * `avgdmg1`/`cool1`), so behind a level-1 hero three of them price at √(3 × 10 × 340) × 1.35 ≈
 * 136 and four at ≈ 157, against a GREEN camp's 120. Five ghouls is two on the trees and three in
 * the party, which clears that bar and stops clearing it the moment anything scratches one of
 * them (the power is read off CURRENT hit points); six is two and four, which is the opening a
 * player actually has. Under the builds that DO name the Ghoul the army mix asks for more than
 * this anyway, and the row is then satisfied by them.
 */
const LUMBER_UNITS = 6;

/**
 * …and how many of them the forest keeps NO MATTER WHAT the bank says.
 *
 * `ComputerPlusAi.lumberCrew` ports undead.ai's self-regulating split — ten choppers minus one
 * per 120 lumber banked — and taken literally it reaches ZERO at 1200 wood, which is a bank an
 * undead player passes through in the middle of every game. At that point every ghoul joined
 * the wave, the wood stopped, and the bank drained back down with nothing chopping. Two ghouls
 * is the floor a player keeps on the trees for exactly that reason, and it costs the wave
 * almost nothing.
 */
export const LUMBER_FLOOR = 2;

/**
 * …and how many workers such a race wants: a mine's crew per town, plus ONE.
 *
 * The plus is the builder — and the scout. An Acolyte is not a lumberjack, so every one past
 * the fifth on a mine is 75 gold standing in a queue, which is exactly what the profile's
 * `workers` (11 on Normal, 14 on Insane) bought: a real match ended with THIRTY-EIGHT of them.
 * The sixth is the one a player keeps out of the mine to put up buildings with and to send to
 * go and look, which is what an undead opening actually looks like.
 */
const SPARE_WORKERS = 1;

/** Nobody's second hero before this much army is fielded — the altar's gold is the army's
 *  until there is an army. */
const HERO2_ARMY = 14;
const HERO3_ARMY = 30;

/** When a tower goes up unprovoked (seconds). Before this the AI only towers if something is
 *  actually in its base, which is what a player does. */
const TOWER_CLOCK = 480;

/**
 * A second (and third) copy of the building that makes the bulk of the army — a rich player's
 * answer to "my army arrives too slowly".
 *
 * **It is gated on the BANK, and it used to be gated on army food.** That number was 40, which
 * is above two of the three difficulties' own army CEILINGS (`PlusProfile.armyFood` is 12 on
 * Easy and 30 on Normal), so neither could ever reach it — and it was circular besides. One
 * building trains one thing at a time (`AiPlayer.trainUnits`), so a single Barracks turns into
 * at most a Grunt every thirty seconds however rich the player is; "get a big army, then buy a
 * second Barracks" therefore says "buy a second Barracks once you no longer need one".
 * Measured headless (tools/ai-plus-ladder-test.cjs): a Normal computer of every race reached
 * ten minutes with FIVE TO SEVEN THOUSAND unspent gold and six food of soldiers, which is the
 * developer's "stuck not building an initial army" exactly.
 *
 * Gold a player can SEE is not being spent is when they put up another Barracks, so that is
 * the whole gate now — `FACTORY_GOLD` is the file's own 800, unchanged; what went is the army
 * clause it was ANDed with. The other half is the army still being short of what the
 * difficulty allows, so a computer that has already massed its ceiling does not carpet its
 * base with production it has no food for.
 */
const FACTORY_GOLD = 800;
/** …and how many copies of it there may ever be. Three is what a player who is teching AND
 *  fighting keeps; more than that is a base built out of Barracks. */
const FACTORY_MAX = 3;

/** Ore left in our own mines below which it is time to take another whatever the build order
 *  planned — the same question every race script asks as `c_gold_owned < 2000`, at the same
 *  number. This is the NEED half of expanding; the strategy's clock is the PLAN half. */
const EXPAND_GOLD = 2000;

/**
 * Fill the build array for one pass.
 *
 * **The ORDER of these blocks is the whole strategy**, because `OneBuildLoop` reserves gold
 * down the list and RETURNS at the first unit row it cannot afford. Three consequences shape it,
 * and all three were measured in a live match rather than reasoned about:
 *
 *  · the bulk of the army goes LAST. There are always more army rows than gold, so a plan with
 *    them in the middle never reaches what is under them: an insane orc reached seven minutes
 *    with sixteen peons, three Grunts, no Stronghold and eleven hundred unspent lumber, because
 *    the Grunt row halted the loop every pass. This is the same shape `human.ai` has — a
 *    "minimum melee defense" of four Footmen near the top, the tech tree and the upgrades in
 *    the middle, and "full up with more troops in general" at the bottom;
 *  · a small CORE army sits high, so that saving for a Keep never means standing there with
 *    nothing on the field;
 *  · the support buildings AND THE EXPANSION come before the tier-up, because the tier-up is
 *    the one row the AI genuinely SAVES for and a saved-for row blocks everything under it. A
 *    Forge is two hundred gold and makes the army you already have better; a Stronghold is
 *    three hundred and fifteen over the Great Hall. Put the Stronghold first and the Forge never
 *    gets built at all — measured, and it is also the order every real orc build writes down.
 *    The expansion is above it for the same reason and a second one: expanding INSTEAD of
 *    teching is what a fast-expand build order is, and a strategy that has decided to take a
 *    second mine at four minutes must not be held behind a Stronghold it is not saving for yet.
 *    It emits no row at all when its clock has not come due, so this costs a build that is not
 *    expanding nothing.
 *
 *    …UNTIL THREE MINUTES, at which point the tier-up stops waiting its turn and is asked for
 *    again from high in the ladder (`tierUpDue`, `TIER2_CLOCK`). "Cheap things first" with no
 *    clock on it is a computer that never tiers at all — there is always another upgrade, and
 *    an army row asks for one more soldier every pass, for ever.
 *
 * Read the list as a ladder player's priorities, top to bottom.
 */
export function buildPlan(c: PlusCtx): void {
  const { ai, table } = c;
  ai.initBuildArray();

  // A hall, first and always: with no hall there is no economy, no worker and no game. (Town 1
  // as well, because an expansion whose hall died is a town with a mine and no hall.)
  ai.meleeTownHall(0, table.halls[0]);
  ai.meleeTownHall(1, table.halls[0]);

  // THE GOLD CREW before anything else — see `mineCrew`. Everything that pays for the rest of
  // this list comes out of a mine, so a dead miner is replaced ahead of a hero, a soldier and a
  // building alike; and a worker past the fifth on a mine pays for no GOLD at all, which is why
  // the profile's whole economy still waits until after the hero (`workers`).
  mineCrew(c);
  // …and the FOREST crew with it, because a build order that cannot pay its lumber stops dead
  // and the row that would have hired a lumberjack is underneath the row it stopped on. See
  // `LUMBER_OPENING` for the four and a half minutes that cost a night elf.
  forestCrew(c);
  supply(c);
  // The ALTAR, then the HERO, then somewhere to make a soldier. The order of those three is the
  // opening, and the middle one moved: the Barracks used to sit above the hero, and a Barracks
  // is 160 gold reserved out of the 425 the altar is saving for. Measured on Echo Isles: an
  // INSANE orc with its altar standing at 1:17 did not queue its Blademaster until past 3:30.
  // A ladder player buys the hero the moment the altar finishes and puts the Barracks up around
  // it — the hero is the single biggest thing in the first five minutes of a melee game, and
  // `army(CORE_ARMY_FOOD)` two rows down is what stops that becoming "no army at all".
  altar(c);
  firstHero(c);
  barracks(c);
  // …and NOW the REST of the economy — the profile's full worker count, whatever it is. This is
  // the hero-delay fix and it is why only a BOUNDED opening crew sits above the hero: `workers`
  // used to sit where `mineCrew` does and ask for the profile's whole number (14 on Insane), and
  // because it is a `SetBuildNext` row it asks for one more EVERY pass — so the ladder spent its
  // gold a peon at a time, for ever, and the altar row underneath it was reached with nothing
  // left. Measured before the fix: an INSANE orc at 2:30 with fourteen peons, no hero and no
  // army, and its Blademaster finally out at nearly five minutes. A ladder player crews the mine
  // and the forest, puts up the altar, buys the hero, and grows the rest around it.
  workers(c);
  // The SHOP, and it is up here with the opening rather than down with the tech for the reason
  // `shop` gives: it is 130 gold, the hero is what it is for, and a row below the army rows is
  // a row that is never reached at all.
  shop(c);
  army(c, coreArmy(c)); // enough not to die to the first raid, cheap enough not to block tech
  tierUpDue(c); // …and from three minutes, the Keep — see TIER2_CLOCK
  techBuildings(c);
  upgrades(c);
  always(c);
  expand(c);
  extraHeroes(c);
  tierUp(c);
  towers(c);
  army(c, c.profile.armyFood); // …and the rest of it, with everything above already paid for
}

/**
 * Keep the mines crewed and the forest busy.
 *
 * `SetBuildNext`, NOT `SetBuildUnit`, and the difference is the whole opening. A row's gold is
 * reserved for its full shortfall (`AiPlayer.runBuildLoop`), so `SetBuildUnit(12, PEON)` on a
 * player who owns five reserves SEVEN peons' worth — nine hundred gold — and every row below it
 * starves until the target is met. Measured: an orc Computer+ reached three minutes with twelve
 * peons, no hero and one Grunt. The relative form asks for one more than is finished, so it
 * builds workers just as continuously while reserving one worker's cost. It is the same tool
 * the race scripts reach for once their hand-interleaved opening is over.
 */
function workers(c: PlusCtx): void {
  const { ai, profile, table } = c;
  if (ai.townCountDone(table.halls[0]) < 1) return; // nothing to make them at
  // A race whose worker cannot chop wants a MINE'S CREW and no more, and `mineCrew` has already
  // asked for it — see `SPARE_WORKERS`. The profile's number is a whole economy's worth of
  // workers and only means that where a worker is also a lumberjack.
  if (!c.workerChops) return void lumberUnits(c);
  ai.setBuildNext(profile.workers * Math.max(1, ai.minesOwned()), table.worker);
}

/**
 * The GOLD CREW: five workers per mine we own, at the very top of the ladder.
 *
 * Two jobs in one row, and both of them are "the mine must never be short".
 *
 *  · **It is the opening.** Five on gold is what every melee build opens with, and it is what
 *    pays for the altar and the hero underneath it.
 *  · **It is the dead-worker replacement, at the highest priority there is.** A worker killed
 *    off a mine is income that has stopped, so it outranks a hero, a soldier and a building —
 *    which is exactly where this row sits. Nothing special is needed to notice the death:
 *    `SetBuildNext` is an absolute target ("have at least five per mine"), so the moment one
 *    dies the row is short again and the next pass asks for one. The lumberjacks are replaced
 *    the same way by `workers`, lower down, which is also the right order — a lost lumberjack
 *    costs wood, a lost miner costs the game.
 *
 * `MINE_CREW` is five because that is what a WC3 gold mine takes at once; a sixth worker on a
 * mine is a worker standing in a queue.
 */
function mineCrew(c: PlusCtx): void {
  const { ai, table } = c;
  if (ai.townCountDone(table.halls[0]) < 1) return;
  const towns = Math.max(1, ai.minesOwned());
  ai.setBuildNext(MINE_CREW * towns + SPARE_WORKERS, table.worker);
}

/**
 * THE FOREST CREW — the lumberjacks, bought with the miners and before everything else.
 *
 * `mineCrew` above is the gold; this is the wood, and the two are one decision taken twice
 * because they are crewed from the same queue and neither may wait on the other. See
 * `LUMBER_OPENING` for what waiting cost.
 *
 * Two shapes, because a race's lumberjack is either a worker or a soldier and the difference
 * is not a tuning value (docs/undead.md):
 *
 *  · **A race whose worker can chop** simply wants more workers — the mine's crew, the spare,
 *    and `LUMBER_OPENING` for the trees. `harvestPlan` does the rest: five per mine on gold,
 *    everybody else in the forest.
 *  · **The undead's lumber comes out of a BUILDING**, so its opening forest crew is that
 *    building and the first two Ghouls out of it — and the building is the Crypt, which is
 *    also `table.barracks`, so this asks for it a few rows earlier than the opening otherwise
 *    would. That is what a real undead opening does and for exactly this reason: an Acolyte
 *    cannot chop, so an undead player who buys the altar first has 150 starting lumber, spends
 *    50 of it on the altar and 100 on the hero, and then owns nothing that can earn another
 *    stick. Two Ghouls is `LUMBER_FLOOR`, the number `ComputerPlusAi.lumberCrew` keeps on the
 *    trees whatever the bank says; the rest of the crew is still `lumberUnits`, below.
 *
 * `setBuildNext` throughout, like every other worker row here: it asks for one more than is
 * finished, so it reserves ONE worker's gold rather than the whole shortfall and the ladder
 * under it keeps breathing while the crew fills up.
 */
function forestCrew(c: PlusCtx): void {
  const { ai, table } = c;
  if (ai.townCountDone(table.halls[0]) < 1) return; // nothing to make them at
  if (c.workerChops) {
    const towns = Math.max(1, ai.minesOwned());
    ai.setBuildNext(MINE_CREW * towns + SPARE_WORKERS + LUMBER_OPENING, table.worker);
    return;
  }
  if (!table.lumberUnit) return;
  const row = table.units[table.lumberUnit];
  if (!row) return;
  if (ai.countDone(row.from) < 1) return void ai.setBuildUnit(1, row.from);
  ai.setBuildNext(LUMBER_FLOOR, table.lumberUnit);
}

/**
 * The forest, for the race that has to BUILD one.
 *
 * Sits with the workers because that is what it is: the undead's lumber comes out of the Crypt
 * rather than out of the Necropolis, but it is still the economy and it still outranks the
 * army. Gated on the producer STANDING, like every other row here (rule 1 at the top of the
 * file) — and `setBuildNext` rather than `setBuildUnit`, so the ladder under it breathes while
 * the crew fills up.
 */
function lumberUnits(c: PlusCtx): void {
  const { ai, table } = c;
  if (c.workerChops || !table.lumberUnit) return;
  const row = table.units[table.lumberUnit];
  if (!row || ai.countDone(row.from) < 1) return;
  ai.setBuildNext(LUMBER_UNITS, table.lumberUnit);
}

/** Stay ahead of the food. One building at a time — `countDone + 1` is already satisfied by a
 *  farm in progress (`setBuildUnit` counts what is under construction), so this cannot carpet
 *  the base the way a `count + 1` would. */
function supply(c: PlusCtx): void {
  const { ai, table } = c;
  if (ai.foodUsed() + FOOD_HEADROOM < ai.foodCap()) return;
  ai.setBuildUnit(ai.countDone(table.farm) + 1, table.farm);
}

/**
 * Somewhere to buy a hero — the first thing built after the food, in every melee opening there
 * is, and above the hero itself for the obvious reason.
 */
function altar(c: PlusCtx): void {
  c.ai.setBuildUnit(1, c.table.altar);
}

/**
 * …and somewhere to make a soldier, BELOW the hero.
 *
 * It used to be above, and that is most of why the first hero was late: gold is reserved down
 * the list, so a 160-gold Barracks row took its cut of every pass while the altar underneath it
 * was trying to save 425 for a Blademaster. Below the hero, the same gold arrives in the same
 * order a player spends it — and nothing is actually delayed by much, because the hero row stops
 * reserving the instant the hero is QUEUED (`ai.count` counts a job in a queue), which is a
 * minute before it walks out.
 */
function barracks(c: PlusCtx): void {
  c.ai.setBuildUnit(1, c.table.barracks);
}

/**
 * The FIRST hero, which every build wants and wants early.
 *
 * A dead hero is handled for free — `SetProduce` turns a request for a hero this player has
 * lying dead into a revival, which is what "always rebuild heroes for defense" has always
 * meant — and that is the reason this row sits high rather than being a one-off: replacing a
 * lost hero outranks almost everything.
 */
function firstHero(c: PlusCtx): void {
  const { ai, table } = c;
  if (ai.countDone(table.altar) < 1) return;
  if (ai.count(ai.heroId) < 1) ai.setBuildUnit(1, ai.heroId);
}

/**
 * …and the second and third, which are a LUXURY and are priced like one.
 *
 * They sit below the expansion deliberately. A hero is four hundred gold and, being a unit row,
 * HALTS the build loop while the AI saves for it — so with the second hero above the expansion
 * an insane orc past its own expansion time never founded a second town at all, because it was
 * always saving for a Far Seer. A ladder player takes the mine first, and so does this.
 *
 * Each is gated on army food rather than on a clock: a second hero is what you buy when the
 * first one has soldiers to lead.
 */
function extraHeroes(c: PlusCtx): void {
  const { ai, profile, armyFood, table } = c;
  if (ai.countDone(table.altar) < 1 || ai.count(ai.heroId) < 1) return;
  if (ai.count(ai.heroId2) < 1) {
    if (profile.heroes >= 2 && armyFood >= HERO2_ARMY) ai.setBuildUnit(1, ai.heroId2);
    return;
  }
  if (profile.heroes >= 3 && ai.count(ai.heroId3) < 1 && armyFood >= HERO3_ARMY) {
    ai.setBuildUnit(1, ai.heroId3);
  }
}

/**
 * The army, as a MIX spent down a food budget.
 *
 * Every row that can actually be produced right now takes its share of `budget` by weight, and
 * the share is turned into a unit count by the unit's own food cost — so twelve food is six
 * Footmen or four Grunts without either race's table having to know what the other's units
 * cost. The counts are ABSOLUTE ("have at least six"), which is why the mix re-balances itself
 * as the tech opens up rather than needing anything torn down: a Footman row that asked for six
 * at tier 1 asks for three once Knights are in the mix, and the six standing Footmen simply
 * satisfy it.
 *
 * Called TWICE per pass with two budgets — a small core near the top of the ladder and the
 * profile's full ceiling at the bottom (see `buildPlan`). The second call's rows are satisfied
 * by whatever the first bought, so the two never double-order.
 */
function army(c: PlusCtx, budget: number): void {
  const { ai, profile } = c;
  const spend = Math.min(budget, profile.armyFood);
  const rows = buildableMix(c);
  const total = rows.reduce((n, r) => n + r.weight, 0);
  if (total <= 0) return;
  let asked = 0;
  let heaviest = rows[0];
  for (const r of rows) {
    if (r.weight > heaviest.weight) heaviest = r;
    const food = Math.max(1, c.foodOf(r.unit));
    const want = Math.floor((spend * r.weight) / total / food);
    // `SetBuildNext` for the same reason the workers use it (above): a row that reserved its
    // whole shortfall would hold the entire ladder under it — the tier-up, the tech, the
    // upgrades — until the army was full. One more at a time per row keeps production
    // continuous and lets the rest of the plan breathe.
    if (want > 0) {
      ai.setBuildNext(want, r.unit);
      asked++;
    }
  }
  // A budget spread thinly enough rounds EVERY share to nothing — a wide mix of expensive
  // units under an Easy computer's twelve food, say — and then a pass that can plainly build
  // something asks for nothing at all. That is the same empty field `buildableMix`'s fallback
  // exists to prevent, arrived at from the other side, and it feeds the same food gates. So
  // the heaviest share of the build order gets one body whatever the arithmetic says.
  if (asked === 0) ai.setBuildNext(1, heaviest.unit);
}

/**
 * What to train right now: the strategy's mix if it can make any of it, and the race's OPENING
 * SOLDIER if it cannot.
 *
 * The fallback is the safeguard, and it is the whole of "Computer+ delays its first army units".
 * A strategy names the army it INTENDS to field, and six of the twenty builds name nothing that
 * can be made at tier 1 — the night elf's `bears` and `chimaeras` are Druids of the Claw and
 * Dryads and Mountain Giants, the human's `gryphons` is air, the undead's `aboms` and
 * `gargoyles` likewise. With no fallback `army` had nothing to ask for, and that is not merely
 * a quiet opening: it is a DEADLOCK, because every gate that would open the tech is stated in
 * army food. `TIER2_ARMY` wants 8, a support building wants its `after`, `TECH_AFTER` wants 12
 * for a tier-2 producer — and with nothing trainable the only food on the field is the hero's
 * five, for ever. So a `bears` night elf trained no Archers and no Huntresses, a `gryphons`
 * human trained nothing at all (its one tier-1 unit, the Rifleman, waits on a Blacksmith that
 * waits on six army food), and the race that was reported as FINE is the one that is immune:
 * the undead's Ghouls come out of `lumberUnits`, which is the economy and sits above all of it.
 *
 * A player in that position does not stand still — they open with the race's basic soldier and
 * tech behind it, which is what every real Bear or Gryphon build order actually writes down. So
 * that is what this does, and only while the build order itself can make nothing: the moment one
 * row of the mix comes online the fallback stops being offered, and the soldiers it already
 * bought simply stand in the army.
 */
export function buildableMix(c: PlusCtx): Array<{ unit: string; weight: number }> {
  const rows = strategyMix(c);
  if (rows.length > 0) return rows;
  const opening = openingUnit(c);
  if (!opening) return rows;
  const row = c.table.units[opening];
  if (!row || row.tier > Math.min(c.profile.techTier, c.tier)) return rows;
  if (!producerReady(c, row.from, row.needs)) return rows;
  return [{ unit: opening, weight: 1 }];
}

/**
 * The race's OPENING SOLDIER — the Footman, the Grunt, the Archer, the Ghoul.
 *
 * DERIVED rather than named, like every other building and upgrade in this file (rule 2 at the
 * top): the lowest-tier thing `table.barracks` makes that needs nothing else standing, and that
 * is neither siege nor air. Naming it on the race table instead would let it disagree with the
 * catalogue — and the whole reason a fallback is needed is a build order that disagreed with
 * what its owner could actually make.
 *
 * "Needs nothing else standing" is the load-bearing clause. The human's Rifleman is a tier-1
 * unit too, but it waits on a Blacksmith, and a Blacksmith waits on army food (`SupportRow.after`)
 * — so choosing it would fall back onto the same deadlock this is here to break.
 */
function openingUnit(c: PlusCtx): string | null {
  const { table } = c;
  let best: string | null = null;
  let bestTier = Infinity;
  for (const [unit, row] of Object.entries(table.units)) {
    if (row.from !== table.barracks || (row.needs?.length ?? 0) > 0) continue;
    if (row.siege || row.air) continue;
    if (row.tier >= bestTier) continue;
    bestTier = row.tier;
    best = unit;
  }
  return best;
}

/**
 * The strategy's mix, narrowed to what can be produced now and RE-WEIGHTED against what the
 * enemy has been seen to field.
 *
 * The counter half is the difficulty's (`PlusProfile.counterWeight`, 0 on Easy) and is applied
 * as a nudge rather than a rewrite: `1 + (score − 1) × weight` leaves a neutral matchup exactly
 * where the build order put it and pushes a good or bad one by as much as the difficulty is
 * willing to react. So an insane computer that has scouted an air army shifts its Riflemen up
 * and its Footmen down without ever abandoning the build it is playing — which is what a
 * player does, and is why this is not a strategy SWITCH.
 */
function strategyMix(c: PlusCtx): Array<{ unit: string; weight: number }> {
  const { profile, table, strategy, tier, enemy } = c;
  const cap = Math.min(profile.techTier, tier);
  const counter = profile.counterWeight > 0 && enemy.seen >= profile.counterSample;
  const out: Array<{ unit: string; weight: number }> = [];
  for (const [unit, weight] of Object.entries(strategy.mix)) {
    const row = table.units[unit];
    if (!row || row.tier > cap || !producerReady(c, row.from, row.needs)) continue;
    let w = weight;
    if (counter) {
      const def = c.defOf(unit);
      if (def) w *= Math.max(MIN_COUNTER_WEIGHT, 1 + (counterScore(def, enemy) - 1) * profile.counterWeight);
    }
    if (w > 0) out.push({ unit, weight: w });
  }
  return out;
}

/** A unit the enemy's composition answers well is built LESS, never not at all: a mix that
 *  collapsed to one type would be countered in turn, and the build order still has a shape. */
const MIN_COUNTER_WEIGHT = 0.2;

/** The buildings the strategy's mix implies — every producer it names, and everything those
 *  units need. Derived rather than listed, so a build cannot ask for a unit whose building it
 *  forgot to put up (plus/races.ts explains why that mattered). */
function mixBuildings(c: PlusCtx): Array<{ build: string; tier: number }> {
  const { table, strategy } = c;
  const seen = new Map<string, number>();
  // The `always` units drag their own producers up with them, which is how "the undead ALWAYS
  // builds a Slaughterhouse at tier 2" is stated: nowhere. It falls out of wanting the statue,
  // exactly as every other building here falls out of wanting the unit it makes (rule 2 at the
  // top of the file). The same is true of the lumber unit's Crypt.
  const wanted = [
    ...Object.keys(strategy.mix),
    ...(table.always ?? []).map((r) => r.unit),
    ...(table.lumberUnit ? [table.lumberUnit] : []),
  ];
  for (const unit of wanted) {
    const row = table.units[unit];
    if (!row) continue;
    for (const b of [row.from, ...(row.needs ?? [])]) {
      seen.set(b, Math.min(seen.get(b) ?? row.tier, row.tier));
    }
  }
  seen.delete("");
  return [...seen].map(([build, tier]) => ({ build, tier })).sort((a, b) => a.tier - b.tier);
}

/** Tier up — but only with an army on the field, and never past what the difficulty allows.
 *  A tier is an UPGRADE of the hall you own, and `SetProduce` tries that route first, which is
 *  why this reads as "have a Keep" rather than "found one" — and it is priced as one too, which
 *  is a fix of its own: the build loop used to reserve a Keep's whole 705 gold rather than the
 *  320 the upgrade is charged, and no computer of any race tiered up on time (`AiPlayer.rowCost`). */
function tierUp(c: PlusCtx): void {
  tier2(c);
  const { ai, profile, table, armyFood, tier } = c;
  if (profile.techTier >= 3 && tier >= 2 && armyFood >= TIER3_ARMY) ai.setBuildUnit(1, table.halls[2]);
}

/** …and the same tier-2 row HIGH in the ladder once its clock is up — see `TIER2_CLOCK`. Asking
 *  twice in one pass is free: the first ask starts the upgrade and `townCount` counts a job in a
 *  queue, so the second is already satisfied; and if the first could not afford it the loop never
 *  reaches the second. */
function tierUpDue(c: PlusCtx): void {
  if (c.clock < TIER2_CLOCK) return;
  tier2(c);
}

function tier2(c: PlusCtx): void {
  const { ai, profile, table, armyFood, tier } = c;
  if (profile.techTier < 2 || tier < 1) return;
  if (armyFood < TIER2_ARMY && !starved(c)) return;
  ai.setBuildUnit(1, table.halls[1]);
}

/**
 * The DEADLOCK BREAKER: is there nothing at all this player can currently train?
 *
 * Every "don't tech with nothing on the field" gate in this file is stated in army food —
 * `TIER2_ARMY`, `SupportRow.after`, `TECH_AFTER` — and that is the right rule right up to the
 * moment the AI has no way to put anything on the field. Then it is circular: the army waits on
 * the buildings and the buildings wait on the army, and the pair sit there for the whole match.
 * `buildableMix`'s opening-soldier fallback is what makes this unreachable in practice (there is
 * always a Footman, a Grunt, an Archer or a Ghoul), so this is the belt to that pair of braces —
 * a custom race table with no basic soldier, or a producer that has been razed, must still be
 * able to spend its way back out.
 *
 * Deliberately asked of `buildableMix` and not of the strategy's own mix: while the fallback is
 * feeding the queue there IS an army coming, and the food gates should hold exactly as written.
 */
function starved(c: PlusCtx): boolean {
  return buildableMix(c).length === 0;
}

/**
 * The buildings: the race's own support first, then whatever the strategy's mix implies.
 *
 * The support row is the smith every build wants whatever it is making (the Blacksmith, the
 * Forge, the Graveyard, the Hunter's Hall) — without it a Gryphon build would take no armour
 * upgrades at all, since `upgrades` gates on the researching building standing.
 *
 * A derived building waits on army food scaled by its TIER, which is the same "don't tech with
 * nothing on the field" rule the support rows state by hand.
 */
function techBuildings(c: PlusCtx): void {
  const { ai, profile, table, tier, armyFood } = c;
  const cap = Math.min(profile.techTier, tier);
  // …unless there is nothing it can train at all, in which case the food gate is the thing
  // KEEPING the field empty and the building under it is the way out — see `starved`.
  const stuck = starved(c);
  for (const row of table.support) {
    if (row.tier > cap || (armyFood < row.after && !stuck)) continue;
    ai.setBuildUnit(1, row.build);
  }
  for (const row of mixBuildings(c)) {
    if (row.tier > cap || (armyFood < TECH_AFTER[row.tier - 1] && !stuck)) continue;
    ai.setBuildUnit(1, row.build);
  }
  // …and more copies of the building that makes the bulk of the army, once the bank is deeper
  // than the queue. The one thing that stops a rich computer sitting on 2000 gold — see
  // `FACTORY_GOLD` for the gate this replaced and why it could never fire.
  //
  // `setBuildNext` rather than `setBuildUnit`, like every other growing row in this file: it
  // asks for one more than is STANDING, so it reserves one Barracks' gold instead of the whole
  // shortfall and the rows under it keep breathing while the second one goes up.
  if (armyFood < profile.armyFood) {
    const main = mainProducer(c);
    const want = Math.min(FACTORY_MAX, 1 + Math.floor(ai.gold() / FACTORY_GOLD));
    if (main && want > 1) ai.setBuildNext(want, main);
  }
}

/**
 * The units this race wants WHATEVER build it rolled — `PlusRaceTable.always`.
 *
 * There is one today, and it is the undead's Obsidian Statue: the race's only healer, the thing
 * that lets an undead army fight twice without walking home, and absent from three of the five
 * undead builds. A build order is a plan for an ARMY; this is the support that plan assumed.
 *
 * Above the expansion and below the tech, in the same place the shop is and for the same
 * reason: it is a want rather than an opening, and it must not out-rank the buildings that make
 * the army. `setBuildUnit` (absolute) rather than `setBuildNext`, because "have two" is exactly
 * what this means and two is small enough to ask for outright.
 */
function always(c: PlusCtx): void {
  const { ai, profile, table, tier } = c;
  const cap = Math.min(profile.techTier, tier);
  for (const row of table.always ?? []) {
    const unit = table.units[row.unit];
    if (!unit || unit.tier > cap || !producerReady(c, unit.from, unit.needs)) continue;
    ai.setBuildUnit(row.count, row.unit);
  }
}

/**
 * The race's own shop, as soon as there is a hero to equip.
 *
 * A computer that shops needs somewhere to shop. Without this the AI's whole item side was
 * theoretical: the shopping pass would run every five seconds, find no shop of ours, and fall
 * back on a map's Goblin Merchant — which is shared, usually across the map, and on plenty of
 * maps not there at all. Measured on Echo Isles: a Normal orc at ten minutes with a level-3
 * hero, no Town Portal and no Healing Salve, because nothing had put up a Voodoo Lounge.
 *
 * It used to sit AFTER `techBuildings` and `upgrades`, on the argument that a shop is a want
 * rather than an opening — and there it was never built either. A row is only "lower priority"
 * if the ladder gets to it: `runBuildLoop` RETURNS at the first unit row it cannot afford, and
 * the army rows above it ask for one more soldier every pass for ever. Measured, with the shop
 * two rows further down: a Normal orc at eight and a half minutes with a Blademaster, three
 * Grunts, no Stronghold, no upgrade and no Voodoo Lounge — the ladder had halted on a 200-gold
 * Grunt every pass since the third minute and nothing below that row had run at all.
 *
 * So it goes with the opening, where its price says it belongs: a Voodoo Lounge is 130 gold and
 * 30 lumber, less than one Grunt, and what it sells is what keeps the hero and the party alive
 * through the creep camps the next ten minutes are made of.
 *
 * `SHOP_AFTER` is the hero's own food, which is to say: as soon as there is a hero. That is
 * what the shop is FOR — the belt is a hero's — and a shop with nobody to carry what it sells
 * is a hundred and thirty gold spent on nothing.
 *
 * Skipped entirely at a difficulty that does not shop, since nothing would ever buy from it.
 */
function shop(c: PlusCtx): void {
  const { ai, profile, table } = c;
  if (profile.shopping <= 0) return;
  if (c.armyFood < SHOP_AFTER) return;
  ai.setBuildUnit(1, table.shop);
}

/** Army food on the field before the shop goes up — a HERO's worth, which is five in every
 *  race (UnitBalance `fused`). Read it as "once the hero is out": nothing else on a melee map
 *  has an inventory, so before that the shop has nobody to sell to. */
const SHOP_AFTER = 5;

/** Army food a derived building waits for, by the tier of the unit that wants it. A tier-1
 *  producer is the opening and comes almost at once; a tier-3 one is a commitment. */
const TECH_AFTER = [0, 12, 24];

/** The building that makes the heaviest share of this build's army — what a second copy of is
 *  worth buying. Read off the mix rather than named, like everything else here. */
function mainProducer(c: PlusCtx): string | null {
  let best: string | null = null;
  let bestWeight = 0;
  for (const r of buildableMix(c)) {
    if (r.weight <= bestWeight) continue;
    const row = c.table.units[r.unit];
    if (!row) continue;
    bestWeight = r.weight;
    best = row.from;
  }
  return best;
}

/** Towers: none at all on Easy, and never before something has actually gone wrong or the
 *  game has gone long. Placement puts them at the town's FRONT (see AiPlayer.siteFor). */
function towers(c: PlusCtx): void {
  const { ai, profile, table, clock, threatened } = c;
  if (profile.towers < 1) return;
  if (!threatened && clock < TOWER_CLOCK) return;
  // Split between the main and the expansions: an expansion is the thing that actually needs
  // guarding, so it gets the first one.
  const towns = Math.max(1, ai.minesOwned());
  const each = Math.max(1, Math.floor(profile.towers / towns));
  for (let t = 0; t < ai.townCountTotal(); t++) ai.guardSecondary(t, each, table.tower);
  if (table.towerUpgrade && ai.countDone(table.tower) >= 1) {
    ai.guardSecondary(0, Math.max(1, each - 1), table.towerUpgrade);
  }
}

/**
 * Upgrades, capped twice over: by what the row is worth (armour is 3 ranks, Defend is 1) and by
 * what the difficulty allows. `setBuildUpgr` applies common.ai's own third cap on top — an easy
 * computer never buys rank 2 of anything.
 *
 * **It sits with the TECH BUILDINGS and above the tier-up, and that is the whole of why the AI
 * was seen never to upgrade anything.** An upgrade row cannot halt the build loop (only a unit
 * or an expansion row can — `runBuildLoop`), but it can be UNREACHABLE, and it was: `tierUp`
 * and `extraHeroes` are unit rows that halt the loop while the AI saves for a Keep, a Castle or
 * a second hero, and everything below them is therefore never read at all for minutes at a
 * time. Down there, upgrades were reached only in the moments the AI happened to be rich.
 *
 * Above the tier-up is also where a player puts them, and for the reason the file header already
 * gives about the support buildings: Forged Swords is a hundred gold and makes the army you
 * ALREADY HAVE better, where a Castle is a thousand and makes nothing until it lands.
 */
function upgrades(c: PlusCtx): void {
  const { ai, profile, table, armyFood } = c;
  for (const row of table.upgrades) {
    if (ai.countDone(row.from) < 1) continue;
    if (armyFood < (row.after ?? 0)) continue;
    ai.setBuildUpgr(Math.min(row.ranks, profile.upgradeRank), row.id);
  }
}

/**
 * A second (third, fourth) town.
 *
 * **Expanding is part of the BUILD ORDER, not of the difficulty.** Each strategy carries its
 * own two clocks (`expandAt` / `expandAgainAt`, plus/races.ts): a ranged line that holds ground
 * takes its second mine at four minutes, a Raider build that intends to be somewhere else takes
 * it at eight, and an air build later still. That is the model AMAI arrived at too — an
 * `expansion time` column on the strategy row rather than on the player — and it is the reason
 * a "fast expand" is a thing an AI can be seen to DO rather than a number somebody set.
 *
 * Three gates on top of the clock, and each answers a different question:
 *
 *  · CAN it? A cap from the difficulty (Easy expands never — issue #124 is explicit that an
 *    easy computer must not run fast expansions), and `AiPlayer.startExpansion` itself refuses
 *    when there is no free mine, when it cannot afford the hall, or when creeps are sitting on
 *    the spot (the attack ladder clears those first).
 *  · SHOULD it now? The strategy's clock — or, whatever the plan said, the ore in the mines it
 *    already owns running out. A build order is a plan, not a promise.
 *  · IS IT SAFE? Never while something hostile is standing in one of its towns. Founding a
 *    second base during a raid is how an AI loses its first one.
 */
function expand(c: PlusCtx): void {
  const { ai, profile, table, strategy, clock, threatened } = c;
  if (profile.expansions < 1 || threatened) return;
  const owned = Math.max(1, ai.minesOwned());
  if (owned >= 1 + profile.expansions) return;
  const planned = (owned === 1 ? strategy.expandAt : strategy.expandAgainAt) + profile.expandDelay;
  const needed = ai.goldOwned() < EXPAND_GOLD;
  if (clock < planned && !needed) return;
  ai.basicExpansion(true, table.halls[0]);
}

/** Is everything this row needs actually STANDING? See rule 1 at the top of the file. */
function producerReady(c: PlusCtx, from: string, needs?: readonly string[]): boolean {
  if (from && c.ai.countDone(from) < 1) return false;
  for (const n of needs ?? []) if (c.ai.countDone(n) < 1) return false;
  return true;
}

/**
 * The harvest split: five per mine, everybody else in the trees.
 *
 * Five because that is what a WC3 gold mine takes at once — a sixth worker on a mine is a
 * worker standing in a queue. The slices are ORDERED and cumulative (see docs/melee-ai.md):
 * every mine is crewed before anybody is sent to chop, which is the priority a melee opening
 * actually has, and the trailing lumber slice is deliberately larger than any roster so it
 * sweeps up whatever is left.
 *
 * "Go and work that mine" is a different order for each race and none of it is here: the AI
 * hands the job to `SimWorld.issueGoldWork` through `AiPlayer.applyHarvest`, which knows that
 * three races walk into the shaft, the night elf climbs inside an Entangled Gold Mine and the
 * undead kneels in a Haunted one's ring.
 */
export function harvestPlan(c: PlusCtx): void {
  const { ai } = c;
  ai.clearHarvestAI();
  // THE AXE THAT IS NEVER PUT DOWN, and it goes FIRST because the slices are cumulative.
  //
  // Five per mine before anybody chops is the right opening and the wrong floor: a player
  // reduced to five workers — a raid on the mine, an Ancient eating its wisps — put all five
  // back on the gold and earned NO LUMBER AT ALL. Every row the ladder halts on early is
  // priced in wood (a Burrow at 40, a Moon Well at 40, the hero at 100, a Hunter's Hall at
  // 145), and a lumber shortfall with no lumber income never shrinks: `runBuildLoop` returns
  // at the row and the rows below it — the farm that would lift the food cap, the worker that
  // would go and chop — are never read again. That is a match-ending state a computer cannot
  // walk out of, and one worker in the trees makes it unreachable.
  //
  // Only while the bank is DRY, so it costs the opening nothing: a melee start is 150 lumber
  // (`MELEE_STARTING_LUMBER_V1`) and every race spends its way under `LUMBER_DRY` a minute in,
  // by which time the forest crew is being hired anyway. And only for a race whose worker can
  // chop — the undead's lumber is a Ghoul and comes out of `lumberUnits` instead.
  if (c.workerChops && ai.wood() < LUMBER_DRY) ai.harvestWood(0, LUMBER_MIN);
  for (let t = 0; t < ai.townCountTotal(); t++) {
    if (ai.townHasMine(t) && ai.townHasHall(t)) ai.harvestGold(t, MINE_CREW);
  }
  ai.harvestWood(0, 40);
}

/** Lumber below which the forest is crewed BEFORE the mine — see `harvestPlan`. A little over
 *  the cheapest lumber row in any race's opening (a farm, at 40). */
const LUMBER_DRY = 100;
/** …and by how many. One: it is a floor against a deadlock, not a lumber policy. */
const LUMBER_MIN = 1;
