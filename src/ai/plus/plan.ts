import type { UnitDef } from "../../data/units";
import type { AiPlayer } from "../aiPlayer";
import { AIR_HEAVY, counterScore, type EnemyRead } from "./counter";
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
 *
 * A DEFAULT rather than the number: a race that wants its second tier sooner overrides it with
 * `PlusRaceTable.tier2Clock`, and the human does — see the comment there.
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

/**
 * Is the tier-2 row PAST ITS CLOCK and still unpaid — is the plan now saving for a Keep?
 *
 * The same question `tierUpDue` asks, asked one row earlier, and it reads the race's own clock
 * for the same reason that row does.
 */
function tierUpOverdue(c: PlusCtx): boolean {
  return c.tier < 2 && c.profile.techTier >= 2 && c.clock >= tier2Clock(c);
}

/**
 * The floor as this pass sees it — and it STOPS GROWING while an overdue tier-up is being saved
 * for.
 *
 * The core army is the row DIRECTLY ABOVE the tier row (see `buildPlan`), so every point of it
 * is gold the hall is not getting, and it is an `army` row: `setBuildNext` asks for one more
 * soldier every pass, for ever, up to whatever budget it is handed. Past the clock the plan has
 * already decided the hall is what it wants most, and then sixteen food of core army is simply
 * the same "there is always another soldier" leak the ladder's own ordering exists to stop,
 * arrived at from inside a single row.
 *
 * It holds at `TIER2_ARMY` and not at nothing, because those two numbers are one number said
 * twice: the army the plan insists on HAVING before it techs is exactly the army it is content
 * to hold WHILE it techs. Measured over ten headless minutes (tools/ai-plus-ladder-test.cjs),
 * every race reached its second tier sooner and none of them fielded a smaller army at ten
 * minutes for it — the Keep landing earlier pays the soldiers back with interest:
 *
 *     human   442-487s -> 336-358s      orc       402-490s -> 362-384s
 *     undead  398-589s -> 382-430s      nightelf  466-510s -> 384s
 *
 * The hold ends the moment the hall is standing, where `CORE_ARMY_PER_TIER` takes over and the
 * floor grows with the tier for the reason stated above.
 */
function coreArmy(c: PlusCtx): number {
  const full = CORE_ARMY_FOOD + CORE_ARMY_PER_TIER * Math.max(0, c.tier - 1);
  return Math.min(c.profile.armyFood, tierUpOverdue(c) ? Math.min(full, TIER2_ARMY) : full);
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
 *  · …and ABOVE ALL OF IT, THE CREWS. Nothing whatever may precede the gold crew and the forest
 *    crew — see `mineCrew`. Every other row in this list is bought with what those two earn, so
 *    a row that halts the ladder above them is a computer that has stopped paying for itself,
 *    and it cannot get out of it: the halted row's shortfall never shrinks, because the income
 *    that would shrink it is what the halt is holding up.
 *
 * Read the list as a ladder player's priorities, top to bottom.
 */
export function buildPlan(c: PlusCtx): void {
  const { ai, table } = c;
  ai.initBuildArray();

  // THE GOLD CREW, AND THEN THE FOREST CREW. FIRST, ALWAYS, AT EVERY DIFFICULTY.
  //
  // Reported: "when its town gets raided/attacked and workers die, it doesn't replace them by
  // producing new ones". The rows themselves always ASKED — a crew target is an absolute one
  // ("have at least five per mine"), so a dead miner makes it short on the very next pass — but
  // they were the THIRD and FOURTH rows of the ladder, and `OneBuildLoop` RETURNS at the first
  // row it cannot afford. Both rows above them are priced at a BUILDING, and both come due in
  // exactly the situation this is about:
  //
  //  · `meleeTownHall` asks for a hall on any town of ours that has a mine and no hall — which
  //    is what a razed expansion is. That is 385/500/600 gold saved for above the 75-gold peasant
  //    that would have replaced the miner the same raid killed, so the ladder stopped there and
  //    the mine crew was never refilled at all.
  //  · `mineBuildings` asks for a Haunted Gold Mine (225 gold and **210 lumber**) the moment an
  //    undead player holds an unhaunted rock, with the same effect on its Acolytes.
  //
  // A raid is precisely when a computer's income is worst and its bank is smallest, so this is
  // the one moment those rows are certain to halt — and with the crew rows underneath them the
  // halt is permanent by construction, because the gold that would clear it comes out of a mine
  // nobody is standing in. A ladder player replaces the dead worker FIRST and rebuilds the hall
  // out of what it earns. So do these two rows, and nothing is ever written above them.
  mineCrew(c);
  // …and the FOREST crew with it, because a build order that cannot pay its lumber stops dead
  // and the row that would have hired a lumberjack is underneath the row it stopped on. See
  // `LUMBER_OPENING` for the four and a half minutes that cost a night elf.
  forestCrew(c);

  // THE MINE ITSELF, for the one race whose mine is a BUILDING — ABOVE the hall rows, which is
  // undead.ai's own order (`undeadMine(ai, 1)`, then `basicExpansion(…, UNDEAD_MINE)`, and only
  // then `meleeTownHall(1, NECROPOLIS_1)`, undead.ai 299–302). It sat below them and that is the
  // whole of the developer's "it only builds a necropolis": a Necropolis is 225 gold and NO
  // lumber, a Haunted Gold Mine is 225 and **210** — the most lumber any undead building costs
  // (UnitBalance.slk) — so the cheap half of an undead expansion was bought first every pass and
  // the half that actually earns anything was left underneath it competing for wood that the
  // rows below kept spending. See `mineBuildings`.
  mineBuildings(c);
  // A hall — under the crews and over everything else, because with no hall there is no economy,
  // no worker and no game. (Town 1 as well, because an expansion whose hall died is a town with
  // a mine and no hall. That is the row the crews used to sit underneath.)
  ai.meleeTownHall(0, table.halls[0]);
  ai.meleeTownHall(1, table.halls[0]);

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
  // THE RACE'S OWN SMITH — the Blacksmith, the Forge, the Graveyard, the Hunter's Hall — ABOVE
  // the tier-up, which is where this file's own header always said it belonged ("a Forge is two
  // hundred gold and makes the army you already have better; a Stronghold is three hundred and
  // fifteen and blocks everything under it while the AI saves"). It was stated there and
  // implemented one screen lower, inside `techBuildings`, which sits below `tierUpDue` — so from
  // `TIER2_CLOCK` onward the smith was in fact bought AFTER the hall. Measured on the razed-base
  // fixture (tools/ai-plus-ladder-test.cjs), where the two orders are told apart: a razed
  // Graveyard — the building the undead's fiends, its Gargoyles and every one of its armour and
  // attack upgrades come out of — was queued behind a Tomb of Relics and a Halls of the Dead and
  // took over five minutes to come back.
  supportBuildings(c);
  // THE SECOND HERO COMES WITH THE KEEP — see `tierTwoHero`, and note WHERE it is: above the
  // Castle, above the tech buildings and above the upgrades, because at tier 2 that is the order
  // a ladder player spends in. Below the core army, so it can never be the reason there is
  // nothing on the field.
  tierTwoHero(c);
  tierUpDue(c); // …and from three minutes, the Keep — see TIER2_CLOCK
  techBuildings(c);
  upgrades(c);
  always(c);
  // …and the ANSWER TO AIR, which is the only row here the build order did not ask for — see
  // `antiAir`. Beside `always` because it is the same kind of row: support the plan assumed
  // (or, here, did not know it would need), above the expansion and below the buildings that
  // make the army.
  antiAir(c);
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
 * The GOLD CREW: five workers per mine we own, and NOTHING in the ladder above it.
 *
 * Two jobs in one row, and both of them are "the mine must never be short".
 *
 *  · **It is the opening.** Five on gold is what every melee build opens with, and it is what
 *    pays for the altar and the hero underneath it.
 *  · **It is the dead-worker replacement, at the highest priority there is.** A worker killed
 *    off a mine is income that has stopped, so it outranks a hero, a soldier and a building —
 *    which is exactly where this row sits. Nothing special is needed to notice the death: the
 *    target is an absolute one ("have at least five per mine"), so the moment one dies the row
 *    is short again and the next pass asks for a replacement.
 *
 * **It is the FIRST row of the whole ladder**, above the hall rows and above the undead's mine,
 * and that is a fix rather than a tidy-up — see `buildPlan` for the raid that a hall row above
 * it made unrecoverable. The rule to keep is simply stated: this row is what every other row is
 * bought with, so a row that can halt the loop must never sit over it.
 *
 * The FOREST crew is the row immediately under it (`forestCrew`), which is the same priority
 * one step down: a lost miner costs the game, a lost lumberjack costs the rest of the list.
 *
 * `MINE_CREW` is five because that is what a WC3 gold mine takes at once; a sixth worker on a
 * mine is a worker standing in a queue.
 *
 * None of this is graded by difficulty. An Easy computer economises on how big its army and its
 * economy GROW (`PlusProfile.workers`, `armyFood`, and `workers` far below); it does not play
 * with a mine standing empty, because that is not an easier opponent, it is a broken one.
 */
function mineCrew(c: PlusCtx): void {
  const { ai, table } = c;
  if (ai.townCountDone(table.halls[0]) < 1) return;
  const towns = Math.max(1, ai.minesOwned());
  crewRow(c, MINE_CREW * towns + SPARE_WORKERS);
}

/**
 * A crew row: short of `want` workers, ask for one more per HALL that could take the order.
 *
 * `setBuildNext` — the relative form, one more than is finished — is what every worker row here
 * used, and it is the right shape for the reason `workers` gives: it reserves ONE worker's gold
 * rather than the whole shortfall, so the ladder under it keeps breathing while the crew fills
 * up. What it is not is a shape that can REFILL a crew: `AiPlayer.trainUnits` puts one job in a
 * building and moves on, and `startUnit` counts what is already in a queue, so "one more than is
 * finished" means exactly one worker in flight in the whole base however many are missing and
 * however many halls are standing idle. A raid that kills five workers is then repaired one at a
 * time through a single hall while the second hall does nothing — which is what "it doesn't
 * really like to replenish its dead workers" looks like from the outside even once the row is
 * reached every pass.
 *
 * So the target is the absolute one, capped at one in flight PER HALL. With one hall that is
 * `setBuildNext` exactly; with two it refills both queues at once, and the most it can ever
 * reserve out of the rows below is one worker per hall — never the whole shortfall, which is the
 * `SetBuildUnit(12, PEON)` trap that cost the opening (see `workers`).
 */
function crewRow(c: PlusCtx, want: number): void {
  const { ai, table } = c;
  if (ai.count(table.worker) >= want) return; // counting what is already in a queue
  const halls = Math.max(1, ai.townCountDone(table.halls[0]));
  ai.setBuildUnit(Math.min(want, ai.countDone(table.worker) + halls), table.worker);
}

/**
 * THE FOREST CREW — the lumberjacks, the SECOND row of the ladder and under nothing but the gold.
 *
 * `mineCrew` above is the gold; this is the wood, and the two are one decision taken twice
 * because they are crewed from the same queue and neither may wait on the other. See
 * `LUMBER_OPENING` for what waiting cost — and `buildPlan` for why nothing that costs a
 * BUILDING's price is allowed above either of them.
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
 * `crewRow` for the workers and `setBuildNext` for the Ghouls: both are relative forms, so the
 * row reserves a worker or two rather than the whole shortfall and the ladder under it keeps
 * breathing while the crew fills up.
 */
function forestCrew(c: PlusCtx): void {
  const { ai, table } = c;
  if (ai.townCountDone(table.halls[0]) < 1) return; // nothing to make them at
  if (c.workerChops) {
    const towns = Math.max(1, ai.minesOwned());
    crewRow(c, MINE_CREW * towns + SPARE_WORKERS + LUMBER_OPENING);
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

/**
 * Stay ahead of the food.
 *
 * Two numbers, and BOTH of them used to be the Human's. The headroom was a flat six and exactly
 * one supply building was ever allowed in flight (`countDone + 1` is already satisfied by one
 * under construction, since `setBuildUnit` counts what is going up), which is a fair description
 * of a player putting up Farms — 80 gold, 20 lumber, **35 seconds**, six food — and is not a
 * description of any other race. A **Moon Well is 180 gold, 40 lumber, 50 seconds and ten
 * food** (UnitBalance.slk): the most expensive supply building in the game, half again as slow
 * as a Farm, and the night elf is also paying one food per Wisp out of the same cap. Six food of
 * warning is most of a Farm's build time and about a third of a Moon Well's, so the elf reached
 * the cap while its one well was still going up and stopped producing — the developer's "not
 * building enough moon wells, rendering it unable to produce more army units".
 *
 * So both numbers are asked of the building itself:
 *
 *  · **The headroom is one of these buildings' worth of food** (`GetFoodMade`) rather than six.
 *    Ten for a Moon Well, a Burrow and a Ziggurat, six for a Farm — which leaves the Human
 *    exactly where it was.
 *  · **Two may be in flight once the cap has actually been REACHED**, and only then. Blocked is
 *    a different position from nearly-blocked: nothing below this row can be trained at all
 *    until the cap moves, so the gold a second building reserves is gold that had nothing else
 *    to buy. Below the cap it is still one at a time, which is what keeps this from carpeting
 *    the base.
 *
 * **`townCountDone`, never `countDone`** — the row is RELATIVE ("one more than I have"), so it
 * has to count what `startUnit` will count, and what `startUnit` counts is `TownCount`: the id
 * WITH its upgraded forms folded in (`TOWN_COUNT_EQUIVALENTS`). One race's supply building
 * upgrades, and it is the one whose supply building is also its TOWER — a Ziggurat becomes a
 * Spirit Tower (`towers`, `PlusRaceTable.tower` = `uzg1`) and goes on making its ten food. Asked
 * of the plain Ziggurat alone the row said "I have none, give me one", `startUnit` folded the
 * three Spirit Towers back in and answered "you have three", and the undead never built another
 * supply building for the rest of the match — a food block that a RAID brings on, since `towers`
 * fires the moment a town is threatened.
 */
function supply(c: PlusCtx): void {
  const { ai, table } = c;
  const used = ai.foodUsed();
  const cap = ai.foodCap();
  const headroom = Math.max(1, ai.foodMade(table.farm));
  if (used + headroom < cap) return;
  ai.setBuildUnit(ai.townCountDone(table.farm) + (used >= cap ? 2 : 1), table.farm);
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
    // TIER 1 ONLY. From tier 2 the second hero is `tierTwoHero`'s row, much higher up the
    // ladder, and asking for it again down here would put the SAME row in the build array twice
    // — `OneBuildLoop` reserves a row's gold whether or not it started it, so a duplicate unit
    // row is four hundred gold withheld from everything below it for nothing.
    if (c.tier < 2 && profile.heroes >= 2 && armyFood >= HERO2_ARMY) ai.setBuildUnit(1, ai.heroId2);
    return;
  }
  if (profile.heroes >= 3 && ai.count(ai.heroId3) < 1 && armyFood >= HERO3_ARMY) {
    ai.setBuildUnit(1, ai.heroId3);
  }
}

/**
 * …and the SECOND hero once the Keep is standing, which is a different row in a different place.
 *
 * `extraHeroes` sits below the expansion on purpose — a hero row HALTS the build loop while the
 * AI saves four hundred gold for it, and above the expansion that halt is what stopped an insane
 * orc ever founding a second town. That reasoning is about the first five minutes, when a second
 * hero is a luxury and a second mine is the game. At TIER 2 it is the other way round: the army
 * is out, the income is running, and the second hero is the next thing a ladder player buys —
 * "more keen towards training a second hero when it reaches tier 2" (the developer's own words).
 *
 * So the row is asked TWICE, at two different heights, and the tier decides which of the two
 * ever fires — exclusively, since a unit row that appeared twice would reserve its gold twice
 * (see `extraHeroes`). The halt is bounded in both directions: it is ONE purchase (nothing re-asks once
 * the hero is queued — `ai.count` counts a job in a queue), and `AiPlayer.releaseStall` lets the
 * ladder past a row that has stopped getting nearer its price, so a base too poor to buy it
 * cannot be locked out of everything underneath it.
 *
 * WHERE it sits is the whole of whether it happens, and the first attempt at this put it just
 * above the expansion — which measured as no change at all (tools/ai-plus-ladder-test.cjs: ten
 * of twenty builds reached ten minutes at tier 2 with one hero, halted on the second hero's own
 * row for a third of their passes). A row does not have to be UNREACHED to be unaffordable: the
 * loop spends a RUNNING budget, so the tech buildings, the upgrades and the Castle above it took
 * the gold before the hero row was read, every pass, for ever. It goes above all three. Below
 * `army(coreArmy)`, which is the one thing that must never be saved through — a base with no
 * army does not need a second hero, it needs an army.
 *
 * Only the SECOND. The third is a luxury at any tier and stays where it is.
 */
function tierTwoHero(c: PlusCtx): void {
  const { ai, profile, table, tier } = c;
  if (tier < 2 || profile.heroes < 2) return;
  if (ai.countDone(table.altar) < 1 || ai.count(ai.heroId) < 1) return;
  if (ai.count(ai.heroId2) >= 1) return;
  ai.setBuildUnit(1, ai.heroId2);
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
  const rows = capCasters(c, strategyMix(c));
  if (rows.length > 0) return rows;
  return fallbackMix(c);
}

/**
 * The LAST RESORT: whatever the race's own opening building can still make.
 *
 * "If it loses its production buildings for its designated build, it should fall back to tier 1
 * (barracks / crypt / ancient of war) units as a last resort" — which is the same row that gets
 * a tier-3 build order out of its opening (see `buildableMix`), asked from the other end. It is
 * every tier-appropriate unit `table.barracks` can produce RIGHT NOW, so a human whose Arcane
 * Sanctums have been razed goes back to Footmen and Riflemen rather than to Footmen alone, and
 * an orc that has lost its Beastiary keeps making Grunts and Head Hunters.
 *
 * Derived off the catalogue rather than named, like every other building and upgrade in this
 * file (rule 2 at the top). `producerReady` is what makes it a last resort and not a second
 * build order: a razed Barracks leaves this empty too, which is correct — a row for something we
 * cannot make starves every row below it.
 */
function fallbackMix(c: PlusCtx): Array<{ unit: string; weight: number }> {
  const cap = Math.min(c.profile.techTier, c.tier);
  const out: Array<{ unit: string; weight: number }> = [];
  for (const [unit, row] of Object.entries(c.table.units)) {
    if (row.from !== c.table.barracks || row.tier > cap) continue;
    if (row.siege || row.air) continue; // an army, not a siege line — see `openingUnit`
    if (!producerReady(c, row.from, row.needs)) continue;
    out.push({ unit, weight: 1 });
  }
  return out;
}

/**
 * …and the SPELLCASTERS held to a share of it.
 *
 * The developer's report is the whole of this: "it seems to tunnel-vision a build like Orc going
 * Shamans, which is ok, but there is no true strategy that has ONLY shamans — usually shamans
 * are mixed with actual army units". No build order in plus/races.ts asks for that, and it is
 * still reachable, because the two things that move a weight after the table has spoken can only
 * push one way: `counterScore` leaves a weaponless caster at a flat 1.0 (the damage table says
 * nothing about a spell) while it pushes everything with a weapon up or down around it, so a bad
 * matchup PROMOTES the casters it could not judge — and `MIN_COUNTER_WEIGHT` floors the soldiers
 * at a fifth while the casters keep their whole share.
 *
 * So the cap is a backstop rather than a rebalancing, and `CASTER_SHARE` is set where it does
 * not argue with a build that MEANS to be caster-heavy: half the army. A double-Arcane-Sanctum
 * build is genuinely half Priests and Sorceresses and is left exactly where its weights put it;
 * an army that has become nothing but Shamans is not.
 *
 * Applied inside `buildableMix` rather than in `army`, so everything downstream sees the capped
 * weights — `mainProducer` (which building is worth a second copy) and the ally chat's "switching
 * to…" line included. And never when the casters are all there IS: with no body in the mix the
 * cap would ask for nothing at all, which is the empty field the fallback exists to prevent.
 */
function capCasters(c: PlusCtx, rows: Array<{ unit: string; weight: number }>): Array<{ unit: string; weight: number }> {
  let casters = 0;
  let body = 0;
  for (const r of rows) (c.table.units[r.unit]?.caster ? (casters += r.weight) : (body += r.weight));
  if (casters <= 0 || body <= 0) return rows;
  const allowed = (body * CASTER_SHARE) / (1 - CASTER_SHARE);
  if (casters <= allowed) return rows;
  const scale = allowed / casters;
  return rows.map((r) => (c.table.units[r.unit]?.caster ? { ...r, weight: r.weight * scale } : r));
}

/** The most of the army that may be spellcasters — see `capCasters`. Ours, not the game's. */
const CASTER_SHARE = 0.5;

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
export function openingUnit(c: PlusCtx): string | null {
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
  const { profile, table, tier, enemy } = c;
  const strategy = activeStrategy(c);
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

/**
 * The build this pass actually produces from — the one the seat rolled, or the build that one
 * GROWS INTO at tier 3 (`PlusStrategy.thenAt3`).
 *
 * "Tier 3 Knights, Priests, Mortars, Flying Machines… can be transitioned into from other builds
 * when tier 3 is reached." A tier-2 rifle build that reaches a Castle is a Knight build, and a
 * mass-Grunt build that reaches a Fortress is a Tauren one; naming the successor on the build
 * itself is what keeps that a clause of the BUILD ORDER rather than the mid-game strategy switch
 * plus/races.ts rejects — nothing here reacts to anything, and a build with no `thenAt3` never
 * moves at all.
 *
 * It is a build order and not a purge: the successor's mix decides what is TRAINED from now on,
 * and everything the earlier build put on the field goes on standing in the army.
 *
 * Read on every pass rather than latched, because the tier itself is: a razed Castle takes the
 * build back to what its owner can actually produce, which is the same rule every other row here
 * obeys (rule 1 at the top of the file).
 */
function activeStrategy(c: PlusCtx): PlusStrategy {
  const { strategy } = c;
  if (!strategy.thenAt3 || c.tier < 3 || c.profile.techTier < 3) return strategy;
  return c.table.strategies.find((s) => s.id === strategy.thenAt3) ?? strategy;
}

/** The buildings the strategy's mix implies — every producer it names, and everything those
 *  units need. Derived rather than listed, so a build cannot ask for a unit whose building it
 *  forgot to put up (plus/races.ts explains why that mattered). */
function mixBuildings(c: PlusCtx): Array<{ build: string; tier: number }> {
  const { table } = c;
  const strategy = activeStrategy(c);
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
  if (c.clock < tier2Clock(c)) return;
  tier2(c);
}

/** …and the clock is the RACE'S — see `PlusRaceTable.tier2Clock`. */
function tier2Clock(c: PlusCtx): number {
  return c.table.tier2Clock ?? TIER2_CLOCK;
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
 * THE RACE'S OWN SMITH — the Blacksmith, the Forge, the Graveyard, the Hunter's Hall.
 *
 * The building every build wants whatever it is making: without it a Gryphon build would take no
 * armour upgrades at all, since `upgrades` gates on the researching building standing, and for
 * the undead it is also what its Crypt Fiends and its Gargoyles are made of.
 *
 * It is its OWN block, above the tier-up, rather than the first half of `techBuildings` — see
 * `buildPlan` for the five minutes that cost a razed undead base. What is left in
 * `techBuildings` is the derived half: a building the MIX implies, which waits on army food
 * scaled by its tier.
 */
function supportBuildings(c: PlusCtx): void {
  for (const build of supportDue(c)) c.ai.setBuildUnit(1, build);
}

/** Which of the race's support buildings this pass is asking for — the same answer given to
 *  `supportBuildings`, which emits them, and to `techBuildings`, which must not emit them a
 *  SECOND time (see the Set there). A row held back by its own food gate is not in it, so the
 *  mix is still free to ask for the same building on its own terms. */
function supportDue(c: PlusCtx): string[] {
  const { profile, table, tier, armyFood } = c;
  const cap = Math.min(profile.techTier, tier);
  const stuck = starved(c);
  return table.support.filter((r) => r.tier <= cap && (armyFood >= r.after || stuck)).map((r) => r.build);
}

/**
 * …and the buildings the strategy's MIX implies, plus the copies of them a rich player or the
 * build order itself asks for.
 *
 * A derived building waits on army food scaled by its TIER, which is the same "don't tech with
 * nothing on the field" rule the support rows state by hand.
 */
function techBuildings(c: PlusCtx): void {
  const { ai, profile, tier, armyFood } = c;
  const cap = Math.min(profile.techTier, tier);
  // …unless there is nothing it can train at all, in which case the food gate is the thing
  // KEEPING the field empty and the building under it is the way out — see `starved`.
  const stuck = starved(c);
  // ONE ROW PER BUILDING, and the race's own smith is already SPOKEN FOR — `supportBuildings`
  // asked for it higher up the ladder. The two lists overlap constantly, because a support
  // building is quite often also a `needs` of something in the mix (the undead's Graveyard is
  // the Crypt Fiend's and the Gargoyle's, the orc's War Mill is the Head Hunter's and the
  // Kodo's), and a building asked for twice in one pass is not merely untidy: `startUnit`
  // prices each row separately off the same running budget, so an unsatisfied duplicate
  // reserves the building's cost twice over and everything below it starves for a payment that
  // is only ever made once — and `setProduce` can be called twice for it besides.
  const asked = new Set<string>(supportDue(c));
  const want = (build: string): void => {
    if (asked.has(build)) return;
    asked.add(build);
    ai.setBuildUnit(1, build);
  };
  for (const row of mixBuildings(c)) {
    if (row.tier > cap || (armyFood < TECH_AFTER[row.tier - 1] && !stuck)) continue;
    want(row.build);
  }
  // …and more copies of the buildings that make the army — ONE row per building, however many
  // reasons there are to want another of it (see `extraCopies`).
  for (const [build, qty] of extraCopies(c, stuck)) ai.setBuildNext(qty, build);
}

/**
 * How many copies of a producer to ask for, and why there are two answers to fold together.
 *
 *  · **The BANK.** More copies of the building that makes the bulk of the army, once the bank is
 *    deeper than the queue — the one thing that stops a rich computer sitting on 2000 gold. The
 *    gate used to be `armyFood >= 40 && gold > 800`, and the first half is above the army CEILING
 *    of two of the three difficulties, so it could never fire; see `FACTORY_GOLD`.
 *  · **The BUILD ORDER.** "Two Arcane Sanctums", "two Ancient of Lores", "two Crypts"
 *    (`PlusStrategy.factories`) — three of the builds in plus/races.ts are named after their
 *    second building, because one Sanctum makes one caster at a time and a build whose army IS
 *    casters arrives at half speed with one of them. Two gates keep that honest: the building
 *    must be one the MIX ALREADY IMPLIES (rule 2 at the top of the file — a strategy may say
 *    *how many*, never *which*), and the first copy must be STANDING, so the second is bought
 *    once the build has come online rather than beside it.
 *
 * FOLDED, because the two can name the same building and a building asked for twice in one pass
 * reserves its price twice over out of the same running budget (see `techBuildings`). The bigger
 * of the two wins, which is the only reading that can satisfy both.
 *
 * `setBuildNext` rather than `setBuildUnit`, like every other growing row in this file: one more
 * than is STANDING, so it reserves one building's gold instead of the whole shortfall and the
 * rows under it keep breathing while the next one goes up.
 */
function extraCopies(c: PlusCtx, stuck: boolean): Array<[string, number]> {
  const { ai, profile, tier, armyFood } = c;
  const want = new Map<string, number>();
  const ask = (build: string, qty: number): void => {
    if (qty > 1) want.set(build, Math.max(want.get(build) ?? 0, qty));
  };
  if (armyFood < profile.armyFood) {
    const main = mainProducer(c);
    if (main) ask(main, Math.min(FACTORY_MAX, 1 + Math.floor(ai.gold() / FACTORY_GOLD)));
  }
  const cap = Math.min(profile.techTier, tier);
  const implied = new Map(mixBuildings(c).map((r) => [r.build, r.tier]));
  for (const [build, count] of Object.entries(activeStrategy(c).factories ?? {})) {
    const at = implied.get(build);
    if (at === undefined || at > cap) continue;
    if (armyFood < TECH_AFTER[at - 1] && !stuck) continue;
    if (ai.countDone(build) < 1) continue; // the first one is `techBuildings`'s row, above
    ask(build, count);
  }
  return [...want];
}

/**
 * THE ANSWER TO AIR — one producer and a handful of the race's own anti-air unit, bolted onto
 * whatever build is being played.
 *
 * "If they see the enemy getting a lot of air units, the Computer+ AI must transition into 1
 * workshop and train Flying Machines to counter enemy air — this can be done on top of whatever
 * is the current strategy (no full commitment to anti-air), and this should be true for other
 * races' anti-air units."
 *
 * It is the counter system's missing half. `strategyMix` re-weights the units a build ALREADY
 * NAMES against what has been scouted (plus/counter.ts), which is the right answer to "they have
 * a lot of Footmen" and no answer at all to "they have Gryphons": a Grunt build re-weighted for
 * air is still a Grunt build, and `AIR_PENALTY` merely tells it that everything it owns is
 * worthless. So this row adds the one unit the build could not — `PlusRaceTable.antiAir`, the
 * race's dedicated answer rather than its best flyer — and adds it BOUNDED, four bodies and one
 * building, because the brief is explicit that this is not a change of army.
 *
 * The same three gates the rest of the countering obeys, so it can never be a fog bypass or a
 * difficulty-free upgrade: only what has been SEEN (`EnemyMemory`), only off a sample this
 * difficulty believes (`counterSample`), and never at a difficulty that does not counter at all
 * (`counterWeight` is 0 on Easy). `AIR_HEAVY` is counter.ts's own bar for "the enemy went air",
 * shared rather than re-stated so the row and the re-weighting can never disagree about it.
 *
 * Nothing is asked for that cannot be built (rule 1): the producer goes up first and only then
 * the unit, and a missing REQUIREMENT is left to the row that already owns it — the human's
 * Blacksmith is `support`, the orc's Voodoo Lounge is `shop` — rather than asked for twice, since
 * a duplicated row reserves its gold twice over (`OneBuildLoop`).
 */
function antiAir(c: PlusCtx): void {
  const { ai, profile, table, tier, enemy } = c;
  const answer = table.antiAir;
  if (!answer || profile.counterWeight <= 0) return;
  if (enemy.seen < profile.counterSample || enemy.air < AIR_HEAVY) return;
  const row = table.units[answer.unit];
  if (!row || row.tier > Math.min(profile.techTier, tier)) return;
  for (const need of row.needs ?? []) if (ai.countDone(need) < 1) return;
  if (ai.countDone(row.from) < 1) {
    // The one building in the ladder that no build order asked for — unless the mix already
    // wants it, in which case `techBuildings` has the row and a second one would only reserve
    // the same gold twice.
    if (!mixBuildings(c).some((b) => b.build === row.from)) ai.setBuildUnit(1, row.from);
    return;
  }
  ai.setBuildNext(answer.count, answer.unit);
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
  // WHAT AN EXPANSION *IS* is not the same building for all four races, and `undead.ai` says so
  // in as many words: every one of its four expansion sites reads
  // `ai.basicExpansion(mines < N, UNDEAD_MINE)` — the Haunted Gold Mine, never the Necropolis
  // (undead.ai 179/215/302/322, ported in src/ai/undead.ts). It is the right reading of the
  // race too: an Acolyte kneels in a ring that only the haunt creates, so a Necropolis founded
  // beside a bare rock is a second base with no income at all (docs/undead.md). Founding the
  // town with the mine also settles the ORDER for free — `nextExpansion` registers the town at
  // the moment the haunt is ordered, so nothing can put the hall up first.
  ai.basicExpansion(true, table.mineBuilding ?? table.halls[0]);
}

/**
 * HAUNT THE MINE — the undead's expansion, and the row without which it is not one.
 *
 * `PlusRaceTable.mineBuilding` is set for exactly one race and the rest of this function is
 * inert for the other three. An undead expansion is not the Necropolis: it is the **Haunted
 * Gold Mine** raised on the rock (`ugol`, docs/undead.md), and until it stands the town has no
 * ring for an Acolyte to kneel in — `SimWorld.issueGoldWork` refuses the gold order outright
 * ([Errors] `Blightminefirst` = "Must haunt gold mine first."). So a Computer+ undead that
 * expanded put up a hall, sent five Acolytes, and earned nothing at that town for the rest of
 * the match; and because `townHasHall` counts the Necropolis as a depot, `minesOwned` read the
 * dead town as a working one and no later pass ever revisited it.
 *
 * The classic AI has always done this — `undead.ai`'s `undead_mine(townid)` is one line per
 * town — and this is the same rule stated per town, without its `c_gold < 1000` clause: that
 * clause is about not spending 240 gold you would rather put into an army, and a town with no
 * income at all is not a saving.
 *
 * Where it sits in the ladder is the point, and it moved: **above** `meleeTownHall` rather than
 * beside it, which is undead.ai's own order (undead.ai 299–302). A Necropolis is 225 gold and no
 * lumber; a Haunted Gold Mine is 225 and **210**, the most lumber of any undead building
 * (UnitBalance.slk). Under the hall rows the cheap half of an expansion was therefore bought
 * first and the half that earns anything was left to compete for wood that every row below kept
 * spending — "it only builds a necropolis". Above them, `OneBuildLoop`'s own halt does the
 * saving: nothing under this row spends a stick until the 210 is banked. Whichever of the two
 * finishes first satisfies `townHasHall` and retires the other, which is authentic either way,
 * since an undead expansion in a real game is quite often the haunted mine and a Ziggurat with
 * no Necropolis over it at all.
 *
 * It is also the row that catches the town `expand` has only just claimed. `startExpansion`
 * calls `nextExpansion()` — which REGISTERS the town — before it asks whether the row can be
 * paid for, so a Computer+ undead that cannot yet afford the 225/210 still owns the town from
 * that pass on, and this row picks it up at the top of the ladder where the saving is protected.
 *
 * Counted with `townCountTown` rather than `townCountDone`, so a mine already being haunted is
 * not asked for a second time every pass; and placement is the library's, which knows a
 * mine-standing building goes on the mine and nowhere else (`AiPlayer.siteFor`).
 */
function mineBuildings(c: PlusCtx): void {
  const { ai, table } = c;
  const id = table.mineBuilding;
  if (!id) return;
  for (let t = 0; t < ai.townCountTotal(); t++) {
    if (!ai.townHasMine(t)) continue;
    if (ai.townCountTown(id, t) >= 1) continue; // already haunted, or a haunting under way
    // NOT WHILE THE CAMP IS STILL STANDING ON IT. This is the row that catches a town `expand`
    // has only just CLAIMED (see above), and claiming is exactly what happens on the pass where
    // `startExpansion` finds the site guarded and holds the hall back — `nextExpansion` registers
    // the town before the foe is asked about. So without this the one race whose expansion is
    // the mine itself walked an Acolyte into the very camp the Necropolis was being held back
    // from, every build pass, for as long as the camp lived. `townGuarded` is the same question
    // `expansionFoe` asks and answers it the same way, town 0 excepted (our own mine is ours).
    if (ai.townGuarded(t)) continue;
    ai.secondaryTown(t, 1, id);
  }
}

/** Is everything this row needs actually STANDING? See rule 1 at the top of the file. */
function producerReady(c: PlusCtx, from: string, needs?: readonly string[]): boolean {
  if (from && c.ai.countDone(from) < 1) return false;
  for (const n of needs ?? []) if (c.ai.countDone(n) < 1) return false;
  return true;
}

/**
 * The harvest split — the MAIN mine's crew INTERLEAVED with the first lumberjacks, then every
 * other mine, then the forest.
 *
 * This is `peon_assignment`'s own shape, and it is worth taking whole because the interleave is
 * the point rather than a detail. All three chopping races write the same four lines
 * (human.ai 623-626, orc.ai 628-631, elf.ai 688-691):
 *
 *     call HarvestGold(T,4)
 *     call HarvestWood(0,1)
 *     call HarvestGold(T,1)
 *     call HarvestWood(0,1)          // elf.ai asks 2 here
 *     if <a second mine> then call HarvestGold(T+1,5) endif
 *     call HarvestWood(0,15)
 *
 * The slices are ORDERED and cumulative, so what those lines say is *the fifth miner is worth
 * less than the first lumberjack, and the second town's whole crew is worth less than the
 * second lumberjack*. Written as "five per mine, then everybody else in the trees" — which is
 * what this was — it says the opposite, and the difference is not cosmetic:
 *
 *  · **an expanded Computer+ chopped NOTHING.** Three towns is fifteen gold seats against an
 *    Insane profile's fourteen workers (`PlusProfile.workers`), so the trailing lumber slice
 *    swept up nobody at all — and every row the ladder halts on is priced in wood.
 *  · **a raided one chopped nothing either**, for as long as it was short of five workers per
 *    mine, which is exactly when it is rebuilding and needs lumber most.
 *
 * `LUMBER_DRY` below was the plaster over the second of those (one worker, and only while the
 * bank was empty); the interleave is the fix, and it is the game's own.
 *
 * **The undead is the exception and the game says so too** (undead.ai 647-652): every town's
 * mine crewed, and only then `HarvestWood(0, WG)`. There is nothing to interleave, because an
 * Acolyte cannot chop — `uaco` `lumber: false`, docs/undead.md — so the undead's gold seats and
 * its forest are not competing for the same bodies at all. Its gold is Acolytes at the Haunted
 * Gold Mine and its lumber is Ghouls, and the trailing wood slice picks up the Ghouls the wave
 * did not take (`ComputerPlusAi.lumberCrew`). Asked as `c.workerChops` — a question about this
 * player's WORKER — rather than as a race, so a custom map that hands its Acolytes an axe gets
 * the interleave with no list of races anywhere.
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
  // The interleave below already guarantees a forest crew wherever there are five workers to
  // split. This is the floor UNDER that, for the base that has just lost most of them: with
  // four workers left, four gold seats take all four and the wood slices find nobody. Every row
  // the ladder halts on early is priced in wood (a Burrow at 40, a Moon Well at 40, the hero at
  // 100, a Hunter's Hall at 145), and a lumber shortfall with no lumber income never shrinks —
  // `runBuildLoop` returns at the row, and the rows below it (the farm that would lift the food
  // cap, the worker that would go and chop) are never read again. That is a match-ending state
  // a computer cannot walk out of, and one worker in the trees makes it unreachable.
  //
  // Only while the bank is DRY, so it costs the opening nothing: a melee start is 150 lumber
  // (`MELEE_STARTING_LUMBER_V1`) and every race spends its way under `LUMBER_DRY` a minute in,
  // by which time the forest crew is being hired anyway. And only for a race whose worker can
  // chop — the undead's lumber is a Ghoul and comes out of `lumberUnits` instead.
  if (c.workerChops && ai.wood() < LUMBER_DRY) ai.harvestWood(0, LUMBER_MIN);
  const mines: number[] = [];
  for (let t = 0; t < ai.townCountTotal(); t++) {
    if (ai.townHasMine(t) && ai.townHasHall(t) && mineWorkable(c, t)) mines.push(t);
  }
  // The MAIN mine — `T` in the scripts, which is `TownWithMine()`: the first town that has one.
  const [main, ...rest] = mines;
  if (main !== undefined) {
    // Four, an axe, the fifth miner, another axe — human.ai 623-626 to the line, and the whole
    // of "the fifth miner is worth less than the first lumberjack".
    if (c.workerChops) {
      ai.harvestGold(main, MINE_CREW - 1);
      ai.harvestWood(0, LUMBER_MIN);
      ai.harvestGold(main, 1);
      ai.harvestWood(0, LUMBER_MIN);
    } else {
      // …and nothing to interleave for the race whose worker cannot chop: undead.ai crews every
      // mine outright (647-652) and leaves the forest to the Ghouls in the sweep below.
      ai.harvestGold(main, MINE_CREW);
    }
  }
  // Every other town's crew, which even for a chopping race sits UNDER the first two axes.
  for (const t of rest) ai.harvestGold(t, MINE_CREW);
  ai.harvestWood(0, 40);
}

/**
 * Can this race actually WORK the mine at this town yet?
 *
 * True for three races and for the undead's own main, and it exists for the fourth's
 * expansions: `SimWorld.issueGoldWork` refuses a gold order outright while the mine is not
 * haunted ([Errors] `Blightminefirst` = "Must haunt gold mine first.", docs/undead.md), and
 * `townHasHall` says yes to a Necropolis standing beside a bare rock because a Necropolis is a
 * gold DEPOT by its own row. So the plan sent five Acolytes to kneel at nothing, every pass,
 * for as long as the haunt took — and the slices are cumulative, so those five were counted
 * before anybody was sent anywhere else.
 *
 * `countAt(…, done)` and not `townCountTown`: a haunt still going up is a mine that still
 * cannot be worked, whatever the build array thinks of it.
 */
function mineWorkable(c: PlusCtx, town: number): boolean {
  const id = c.table.mineBuilding;
  return !id || c.ai.countAt(id, town, true) >= 1;
}

/** Lumber below which the forest is crewed BEFORE the mine — see `harvestPlan`. A little over
 *  the cheapest lumber row in any race's opening (a farm, at 40). */
const LUMBER_DRY = 100;
/** …and by how many. One: it is a floor against a deadlock, not a lumber policy.
 *
 *  It is also the size of each of the two slices the main mine's crew is interleaved with, and
 *  that one IS the game's — human.ai and orc.ai both write `HarvestWood(0,1)` twice, for two
 *  lumberjacks before the second town is crewed at all. (elf.ai asks 2 on its second slice; the
 *  extra wisp is inside `LUMBER_OPENING`'s four either way.) */
const LUMBER_MIN = 1;
