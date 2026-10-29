import type { UnitDef } from "../../data/units";
import type { AiPlayer } from "../aiPlayer";
import { BLK_SPHINX, OBSIDIAN_STATUE, PIT_FIEND, TOWN_COUNT_EQUIVALENTS } from "../ids";
import { AIR_HEAVY, counterScore, type EnemyRead } from "./counter";
import type { PlusProfile } from "./profile";
import type { PlusRaceTable, PlusStrategy, PowerSpike } from "./races";

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
  /**
   * How many of the race's LUMBER units the brain is keeping in the trees this pass — the
   * undead's Ghouls (plus/index.ts `lumberCrew`, about a third of them). Only those are the
   * economy; every other Ghoul is recruited into the waves and is a soldier the ceiling prices.
   * Absent = the old flat `LUMBER_UNITS`.
   */
  readonly lumberCrew?: number;
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
  /**
   * Gold to hold back from the ladder below the opening for a missing Scroll of Town Portal —
   * `PlusItems.portalSaving`. 0 or absent when there is nothing to save for. See `portalSaving`.
   */
  readonly portalReserve?: number;
  /** …and, once the scroll is carried, for a missing FIGHT item (Scroll of Healing, Potion of
   *  Lesser Invulnerability — `PlusItems.fightSaving`), held lower down. See `fightSaving`. */
  readonly fightReserve?: number;
  /** When this player last WON a fight against a player's army and chose to spend it on an
   *  expansion, on `clock`'s scale (-1 or absent = never) — `ComputerPlusAi.expandOnWin`. What
   *  `expand` reads as "now is the time". */
  readonly wonAt?: number;
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
  if (tierUpOverdue(c)) return Math.min(c.profile.armyFood, full, tier2Army(c));
  // …and the same hold one tier up, while a RUSHED tier 3 is being saved for (`tier3Rushing`):
  // the army the rush insists on having before it asks (`TIER3_ARMY`) is the army it holds while
  // it pays — and once that much is on the field the row asks for NOTHING. Held at the number
  // instead it still leaked: every row is one unit's SHARE of the budget, so a Sanctum build with
  // eight fallback Footmen standing kept buying its Sorceress and its Priest share on top, and
  // on the ladder fixture the Castle waited two minutes behind them with the Keep long up. The
  // hold ends the moment the hall is in the queue — the gold is spent by then.
  if (tier3Rushing(c)) return c.armyFood >= TIER3_ARMY ? 0 : Math.min(c.profile.armyFood, full, TIER3_ARMY);
  return Math.min(c.profile.armyFood, full);
}

/**
 * Is a RUSHED tier 3 (`PlusProfile.tier3Rush`) still unpaid — tier 2 standing, the third hall not
 * yet in the queue? What the core army holds for (`coreArmy`) and what keeps the smith's research
 * back (`upgrades`).
 */
function tier3Rushing(c: PlusCtx): boolean {
  return c.profile.tier3Rush && c.profile.techTier >= 3 && c.tier === 2 && c.ai.count(c.table.halls[2]) < 1
    && !tier3Held(c);
}

/**
 * Is a build that names its OWN tier-3 clock (`PlusStrategy.tier3Clock`) still before it? Then the
 * third hall is not bought at all — not by the rush, not out of leftover gold at the bottom of the
 * ladder — exactly as `tier2` holds a build's own tier-2 clock: a build that names one has decided
 * its tier-2 army is the plan until then (the orc's two-Beastiary builds, plus/races.ts).
 */
function tier3Held(c: PlusCtx): boolean {
  if (c.strategy.tier3Clock !== undefined && c.clock < c.strategy.tier3Clock + c.profile.tier3Delay) return true;
  // …and one that names a CONDITION (`PlusStrategy.tier3After`) is held until it holds — or until
  // `TIER3_AFTER_LATEST`, so a seat that keeps losing what it waits for still tiers up.
  const after = c.strategy.tier3After ?? c.table.tier3After;
  return !!after && !holds(c, after) && c.clock < TIER3_AFTER_LATEST + c.profile.tier3Delay;
}

/** The latest a `PlusStrategy.tier3After` condition holds the third hall back. OURS: a minute past
 *  the orc's old 9:00 Fortress — the four Raiders arrive by then in a fight-free ladder run. */
const TIER3_AFTER_LATEST = 600;

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
 * the whole gate now — the price is `PlusProfile.factoryGold`, the file's own 800 below Insane;
 * what went is the army clause it was ANDed with. The other half is the army still being short of
 * what the difficulty allows, so a computer that has already massed its ceiling does not carpet
 * its base with production it has no food for. How many copies there may ever be is
 * `PlusProfile.factoryMax`: three is what a player who is teching AND fighting keeps, and Insane's
 * four is a player who means to mass.
 */

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
/** Every fallen hero of ours, revived at the altar before anything else (see `buildPlan`). */
function reviveFirst(c: PlusCtx): void {
  const { ai, table } = c;
  if (ai.countDone(table.altar) < 1) return;
  for (const id of [ai.heroId, ai.heroId2, ai.heroId3]) {
    if (id && ai.heroFallen?.(id)) ai.setBuildUnit(1, id);
  }
}

export function buildPlan(c: PlusCtx): void {
  const { ai, table } = c;
  ai.initBuildArray();
  // A new pass, a new ledger: what `fitted` let through last pass is standing or queued now,
  // and `soldierFood` counts it there. Cleared here rather than trusted to a fresh ctx.
  passLedger.delete(c);

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
  // …EXCEPT A DEAD HERO. The developer: *"when a hero of the Computer+ AI dies, it must make it
  // its number 1 (top) priority to revive them via their Altar"*. Each hero's own row already
  // turned into a revival (`AiPlayer.reviveFallen`) — but it sat where that hero's PURCHASE
  // sits, and a dead hero is not the build order's next step: it is the army's captain and most
  // of its power, standing in a queue behind farms, soldiers and the tier. A revival is
  // `ReviveBaseFactor`-cheap below level 7 (`rowCost`) and the miners keep earning while the row
  // saves, so the crew rows lose a few seconds at worst; and a raid that has ALSO killed every
  // miner is the dead end `releaseStall` exists for, which lets the ladder past.
  reviveFirst(c);
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
  // …but NOT WHILE THE CAMP IS STILL STANDING ON TOWN 1 — `townGuarded`, the same question
  // `startExpansion` (through `expansionFoe`) and `mineBuildings` already ask. `expand` CLAIMS
  // the town before it asks about the camp (`nextExpansion` registers it first), and from that
  // pass on this row — near the TOP of the ladder — asked for its hall with nobody asking about
  // the camp at all. Watched on Echo Isles (Insane night elf against a human, both claiming the
  // troll-guarded mine at five minutes): the human's builder walked into the camp and its Town
  // Hall site went down with it, and the night elf's row reserved a Tree of Life's 340/185 off
  // the top of every pass for as long as the trolls lived, starving the rows under it (its
  // second hero halted with 750 gold in the bank). The army is what clears the camp
  // (`pickTarget` rung 0, off `takeExp`); the hall follows it, from this same row.
  if (!ai.townGuarded(1)) ai.meleeTownHall(1, table.halls[0]);

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
  // …and AT TIER 2, THE SECOND HERO — straight after the opening's own three rows, once the army
  // has something on the field for it to lead. See `heroBanked`: below this point every row was
  // spending the hero's gold a soldier at a time.
  if (heroBanked(c)) c.ai.setBuildUnit(1, c.ai.heroId2);
  // SAVING FOR A MISSING TOWN PORTAL — see `portalSaving` for why HERE.
  portalSaving(c);
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
  // AT TIER 3 THE `always` UNITS COME BEFORE THE ARMY — the undead's two Obsidian Statues, its
  // only healers. Down at their ordinary place they sat under the tier-3 power rows (the
  // Abominations, `leadUnits`), which halt the ladder every pass, so a tier-3 undead "only
  // pumped Abominations" and a statue lost was not replaced for minutes, or ever (the
  // developer's: *"it should give a higher priority to having 2 obsidian statues first"*). Two
  // is a bounded row, so it costs the army nothing past them.
  if (c.tier >= 3) always(c);
  // …and the race's TIER-3 RESEARCH, saved for ahead of the army — see `tier3First`.
  tier3Research(c);
  // …and THE THIRD HERO right behind that research once tier 3 stands with an army out — the
  // second hero's `heroBanked` one tier up. See `tier3Banked`.
  if (tier3Banked(c)) tier3Hero(c);
  army(c, coreArmy(c)); // enough not to die to the first raid, cheap enough not to block tech
  // …and on a rung that MATCHES the enemy's air (`PlusProfile.antiAirMatch`), the ANSWER TO AIR
  // comes up here, under the core army and above every row that halts the ladder to save — the
  // tier rows above all. Down at its ordinary place it could not be reached while an Insane
  // computer saved for its rushed tier 3 (`tier3Due`), which is the very window an air army
  // arrives in. See `antiAir`.
  if (c.profile.antiAirMatch) antiAir(c);
  // THE SECOND HERO COMES WITH THE KEEP — see `tierTwoHero`, and note WHERE it is: directly under
  // the core army, above the fight-item reserve, the support buildings, the unit-ability
  // research, the Castle, the tech and the upgrades, because at tier 2 that is the order a ladder
  // player spends in. Below the core army, so it can never be the reason there is nothing on the field.
  tierTwoHero(c);
  // …and the THIRD hero, right behind it, for every race — saved for while the tier-3 hall goes
  // up, and asked for here at tier 3 until there is the army that banks it higher (`tier3Banked`).
  if (!tier3Banked(c)) tier3Hero(c);
  // …and for a missing FIGHT item once the scroll is carried — see `fightSaving`.
  fightSaving(c);
  // …and JUST AFTER A WON FIGHT, the expansion comes up to here from the bottom of the ladder —
  // see `wonExpansion`. Inert the rest of the time: the ordinary row is `expand` below.
  expand(c, true);
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
  // …and the UNIT-ABILITY UNLOCKS (Web, Berserker, Defend…), saved for — see `abilityUpgrades`.
  abilityUpgrades(c);
  // …and on the rungs that do NOT match air (`antiAirMatch` already put it under the core army),
  // the ANSWER TO AIR goes in above the build's lead counts: an orc's four Raiders and its Kodo
  // otherwise took the room under the army ceiling and no Batrider fitted (ai-plus-ladder-test).
  // It is only ever emitted once enough air has been SEEN (`antiAirDue`).
  if (!c.profile.antiAirMatch) antiAir(c);
  leadUnits(c);
  tierUpDue(c); // …and from three minutes, the Keep — see TIER2_CLOCK
  tier3Due(c); // …and the race's tier 3 on ITS clock, if it has one — see `tier3Due`
  // …and the undead's SIEGE, up here rather than below the upgrades — see
  // `PlusRaceTable.siegeEarly`. The same row; only its place in the ladder moves. Above the
  // first tower too: both want the same scarce lumber, and below it the Slaughterhouse stood a
  // minute later — after the second wave it is for.
  if (c.table.siegeEarly) siegeLine(c);
  // ONE TOWER AT HOME, on Normal and Insane — see `firstTower` for why it is up here and not
  // only in `towers` at the bottom.
  firstTower(c);
  techBuildings(c);
  upgrades(c);
  if (c.tier < 3) always(c); // …at tier 3 it is under `shop`, above the army — see there
  // …and SIEGE, the same kind of row for the other thing a build may not have planned for: the
  // towers at the end of the march. Bounded to two bodies, so its reservation ends.
  if (!c.table.siegeEarly) siegeLine(c);
  expand(c);
  extraHeroes(c);
  tierUp(c);
  towers(c);
  army(c, c.profile.armyFood); // …and the rest of it, with everything above already paid for
}

/**
 * Hold the price of a missing Scroll of Town Portal back from everything below this row.
 *
 * Reported: a Computer+ player with no scroll and too little gold for one never came to have
 * enough, because the build ladder spent the bank down every pass and the shop only ever looked
 * at what was left (plus/items.ts `portalSaving`). A ladder player who has lost their scroll puts
 * the next one ahead of the next building, and this row is that: a `reserveGold` row, which
 * builds nothing and never halts, so the rows under it simply see 350 gold less.
 *
 * WHERE it sits is the whole design. Below the crews, the hall, the supply, the altar, the first
 * hero and the Barracks — the rows that keep the economy paying and the game going — and above
 * EVERYTHING ELSE, the rest of the workers, the shop row and the core army included. It used to
 * sit under the core army, and reported was that an Insane computer "is still not making a big
 * effort to always try to buy a scroll of town portal when it doesn't have one". Measured on two
 * observed twelve-minute Insane matches (Lost Temple, Echo Isles): the players spent 2–5 minutes
 * of the match after 2:30 with no scroll, and in nearly all of it the bank was under the 350 the
 * scroll costs — the core army's `SetBuildNext` rows and the workers' ask one more body every
 * pass, so with the reserve beneath them the gold was spent before the reserve was ever read. The
 * reserve is one scroll's price, held only while a scroll is MISSING and a shop that sells one is
 * in reach, so above them it delays a soldier or a worker by a few seconds of mining — which is
 * the trade a ladder player makes for the one item that decides how a lost fight ends.
 */
function portalSaving(c: PlusCtx): void {
  if (c.portalReserve && c.portalReserve > 0) c.ai.reserveGold(c.portalReserve);
}

/**
 * …and the same for a missing FIGHT item (`PlusItems.fightSaving`), which is NOT moved up with
 * the scroll: a Scroll of Healing is a better fight, not a saved army, and it waits behind the
 * core army where the scroll's reserve used to.
 */
function fightSaving(c: PlusCtx): void {
  if (c.fightReserve && c.fightReserve > 0) c.ai.reserveGold(c.fightReserve);
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
  if (!c.profile.wholeArmyCeiling) return void ai.setBuildNext(LUMBER_UNITS, table.lumberUnit);
  // …under a WHOLE-army ceiling only the CREW is the economy's to rebuild. The brain keeps about
  // a third of the Ghouls in the trees (`PlusCtx.lumberCrew`) and walks the rest into the wave,
  // so a row that rebuilt all six whatever the ceiling said bought every Ghoul the army lost
  // back on top of it — an undead Normal was seen standing on six Ghouls, three Fiends, a Meat
  // Wagon and a Statue, some 24 food of soldiers on a 20 ceiling. Past the crew a Ghoul is a
  // soldier like any other and is FITTED (`fitted`); the crew itself never waits for room, and
  // `forestCrew`'s `LUMBER_FLOOR` above keeps the trees worked whatever happens here.
  const crew = Math.min(LUMBER_UNITS, c.lumberCrew ?? LUMBER_UNITS);
  const want = ai.count(table.lumberUnit) < crew ? crew : fitted(c, table.lumberUnit, LUMBER_UNITS);
  if (want > 0) ai.setBuildNext(want, table.lumberUnit);
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
  // At the food CEILING (100 in melee) a supply building makes nothing more — `foodCap` reads
  // no higher — so without this the row would ask for another one every pass for ever. A Farm
  // LOST at the ceiling is still replaced: the cap drops below it the moment the survivors no
  // longer reach it.
  if (cap >= ai.foodCeiling()) return;
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
    //
    // …and only once the hero is LEGAL. A second hero's requirement is the tier-2 hall
    // (`Requires1=TWN2,…` on every melee hero, the Tavern's included), so at tier 1 this row was
    // a 425-gold reservation that could never be spent, taken off every row beneath it — the
    // whole army among them — for as long as the hall was not up. A build that holds its tier-up
    // back on purpose (`PlusStrategy.tier2Clock`, the Head Hunter rush) held its army flat for
    // the minute before its Stronghold for exactly that (tools/ai-plus-ladder-test.cjs).
    if (c.tier < 2 && profile.heroes >= 2 && armyFood >= HERO2_ARMY && (ai.heroLegal?.(ai.heroId2) ?? true)) {
      ai.setBuildUnit(1, ai.heroId2);
    }
    return;
  }
  // The THIRD hero is not asked for down here at all any more — it is `tier3Hero`'s, much higher
  // up, for every race. Two things were wrong with this row. A third hero's requirement is the
  // tier-3 hall (`[Ofar] Requires2=ofrt`, the same rank on every melee hero and the Tavern's), so
  // at TIER 2 it was a dead 425-gold reservation sitting directly ABOVE `tierUp` — from
  // 30 army food on, every pass held a hero's price back from the hall the hero was waiting on.
  // And at tier 3 it was read after the running budget had paid for everything above it.
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
 * WHERE it sits is the whole of whether it happens. Above the expansion measured as no change
 * at all, and above the Castle, the tech and the upgrades still left it a minute or two behind
 * the Keep — and three INSANE builds never asked for it inside ten minutes
 * (tools/ai-plus-ladder-test.cjs, `hero2@`). A row does not have to be UNREACHED to be
 * unaffordable: the loop spends a RUNNING budget, so every row above it took the gold — and,
 * for the undead, the hundred LUMBER — before the hero row was read. The Arcane Sanctum
 * (`supportBuildings`) and the unit-ability research (`abilityUpgrades`) were those rows. So it
 * goes directly under `army(coreArmy)`, which is the one thing that must never be saved
 * through — a base with no army does not need a second hero, it needs an army.
 *
 * …and it is SAVED FOR WHILE THE HALL GOES UP. A hero cannot be bought before the tier-2 hall
 * stands (`Requires1=TWN2`), so with only the row the price began to be saved the moment the Keep
 * finished, and the hero walked out a gold-mine's worth of seconds behind it. While the upgrade
 * is in the hall's queue this holds the hero's gold and lumber back from everything below
 * (`reserveGold`, which never halts), so the row finds its price waiting the pass the Keep
 * lands — which is when a ladder player clicks the altar.
 *
 * Only the SECOND. The third is a luxury at any tier and stays where it is.
 */
function tierTwoHero(c: PlusCtx): void {
  const { ai, profile, table, tier } = c;
  if (profile.heroes < 2) return;
  if (heroBanked(c)) return; // already asked, near the top of the ladder — never twice (see `extraHeroes`)
  if (ai.countDone(table.altar) < 1 || ai.count(ai.heroId) < 1) return;
  if (ai.count(ai.heroId2) >= 1) return;
  if (tier >= 2) return void ai.setBuildUnit(1, ai.heroId2);
  // The Keep is in the hall's queue (a tier-2 hall counted, none of it finished — `tier` is
  // read off finished halls).
  if (!table.halls[1] || ai.count(table.halls[1]) < 1) return;
  const hero = c.defOf(ai.heroId2);
  if (hero) ai.reserveGold(hero.goldCost, hero.lumberCost);
}

/**
 * IS THE SECOND HERO THE NEXT THING BOUGHT? — true from the moment the tier-2 hall stands, the
 * hero is legal and the army already fields `HERO2_ARMY`, until the hero is in the altar's queue.
 *
 * Reported: an Insane human "took quite a lot to train its second hero after reaching Tier 2".
 * `tierTwoHero` sits directly under `army(coreArmy)`, and at tier 2 the core army's floor rises
 * to 24 food — an `army` row is `SetBuildNext`, one more soldier per row per pass, so every
 * pass spent the running budget on another soldier before the hero row was read and the hero
 * waited for the whole core army to fill. The workers and the shop above it took their share
 * the same way. A ladder player clicks the altar the moment the Keep lands and keeps the
 * gold for it in the bank until then.
 *
 * So once the army has soldiers to lead — the same `HERO2_ARMY` the tier-1 row asks — the row
 * moves to just under the opening (crews, hall, supply, altar, first hero, Barracks), where its
 * halt BANKS everything the rows below would have spent: the next soldier, the next worker, the
 * shop. The halt is one purchase long (`ai.count` counts the hero the moment it is queued) and
 * `AiPlayer.releaseStall` still lets the ladder past a row that stops getting nearer its price,
 * so a broken base is not locked out of an army. Below `HERO2_ARMY` it stays under the core army,
 * which is the one thing never saved through. Every rung that fields a second hero.
 */
/**
 * …and the GOLD that row is holding, for the one buyer outside the ladder — the hero's belt
 * (plus/items.ts shops out of `ItemView.gold`). The second hero's price while `heroBanked` is
 * up, or while the Keep is in the hall's queue (`tierTwoHero`'s own reserve); the third hero's
 * while the tier-3 hall is (`tier3Hero`'s); and 0 otherwise.
 */
export function secondHeroHold(c: PlusCtx): number {
  const { ai, profile, table, tier } = c;
  const keepGoingUp = tier < 2 && profile.heroes >= 2 && !!table.halls[1] && ai.count(table.halls[1]) >= 1
    && ai.countDone(table.altar) >= 1 && ai.count(ai.heroId) >= 1 && ai.count(ai.heroId2) < 1;
  // …and the THIRD hero's while its tier-3 hall goes up (`tier3Hero`'s reserve).
  if (!heroBanked(c) && !keepGoingUp) return thirdHallGoingUp(c) ? (c.defOf(ai.heroId3)?.goldCost ?? 0) : 0;
  return c.defOf(ai.heroId2)?.goldCost ?? 0;
}

function heroBanked(c: PlusCtx): boolean {
  const { ai, profile, table, tier, armyFood } = c;
  if (profile.heroes < 2 || tier < 2 || armyFood < HERO2_ARMY) return false;
  if (ai.countDone(table.altar) < 1 || ai.count(ai.heroId) < 1 || ai.count(ai.heroId2) >= 1) return false;
  return ai.heroLegal?.(ai.heroId2) ?? true;
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
  // `SetBuildNext` for the same reason the workers use it (above): a row that reserved its
  // whole shortfall would hold the entire ladder under it — the tier-up, the tech, the
  // upgrades — until the army was full. One more at a time per row keeps production
  // continuous and lets the rest of the plan breathe.
  //
  // Each row's count is FITTED under the whole army's ceiling first (`fitted`): the shares are
  // a target, the ceiling is the limit, and the room the side rows are owed is kept back.
  for (const r of armyRows(c, budget)) {
    const want = fitted(c, r.unit, r.want, sideOwed(c, buildableMix(c)));
    if (want > 0) c.ai.setBuildNext(want, r.unit);
  }
}

/**
 * The army `army` asks for, row by row: each buildable unit's share of `budget`, as a count.
 *
 * Its own function because the ARMY MANAGER has to know the same number — an Easy computer that
 * fell back waits until it has its whole army again before the next wave (`PlusProfile.refill`),
 * and "its whole army" is exactly what these rows ask for. Measured any other way the two would
 * disagree: the shares ROUND DOWN (a seven-food share of a three-food unit is two of them, six
 * food), so a wave waiting for the profile's raw `armyFood` would wait for food the plan is
 * never going to train.
 */
function armyRows(c: PlusCtx, budget: number): Array<{ unit: string; want: number }> {
  const rows = buildableMix(c);
  let spend = Math.max(0, Math.min(budget, c.profile.armyFood) - offMixFood(c, rows) - sideOwed(c, rows));
  // A STOPGAP, NOT AN OPENING: while the build's own tier-1 soldier is one building away and that
  // building is already going up, the fallback buys `FALLBACK_WHILE_TECHING` food and waits.
  // The core army is 16 food and sits above the support rows, so a rifle build used to fill the
  // Blacksmith's whole construction time with Footmen — eight of them, standing in the army for
  // the rest of the match ("it should get mass riflemen, not footmen!", the developer).
  if (techArriving(c)) spend = Math.min(spend, Math.max(0, FALLBACK_WHILE_TECHING - soldierFood(c)));
  const total = rows.reduce((n, r) => n + r.weight, 0);
  if (total <= 0) return [];
  const out: Array<{ unit: string; want: number }> = [];
  let heaviest = rows[0];
  for (const r of rows) {
    if (r.weight > heaviest.weight) heaviest = r;
    const food = Math.max(1, c.foodOf(r.unit));
    const want = Math.floor((spend * r.weight) / total / food);
    if (want > 0) out.push({ unit: r.unit, want });
  }
  // A budget spread thinly enough rounds EVERY share to nothing — a wide mix of expensive
  // units under an Easy computer's ceiling, say — and then a pass that can plainly build
  // something asks for nothing at all. That is the same empty field `buildableMix`'s fallback
  // exists to prevent, arrived at from the other side, and it feeds the same food gates. So
  // the heaviest share of the build order gets one body whatever the arithmetic says.
  // Not when the ceiling is already SPENT on soldiers outside the mix: the field is not empty
  // then, and the one body would be one over the ceiling for ever (`wholeArmyCeiling`).
  if (out.length === 0 && spend > 0) out.push({ unit: heaviest.unit, want: 1 });
  return out;
}

/** The most food of opening soldiers bought while the build's own unit is a building away — see
 *  `armyRows`. OURS: two Footmen, which is what a ladder rifle opening escorts its hero with. */
const FALLBACK_WHILE_TECHING = 4;

/**
 * Is the mix producing NOTHING of its own only because a building it needs is under construction
 * right now — the Blacksmith of a rifle opening, the War Mill of a Head Hunter one? Only at the
 * tier the unit is from, with its producer standing, and only for a building ALREADY started
 * (`count` > `countDone`): one nobody has begun is the deadlock `buildableMix`'s fallback exists
 * to break, and holding the soldiers back for it would bring that back.
 */
function techArriving(c: PlusCtx): boolean {
  if (strategyMix(c).length > 0) return false;
  const cap = Math.min(c.profile.techTier, c.tier);
  for (const unit of Object.keys(activeStrategy(c).mix)) {
    const row = c.table.units[unit];
    if (!row || row.tier > cap || !row.needs?.length) continue;
    if (row.from && c.ai.countDone(row.from) < 1) continue;
    const missing = row.needs.filter((n) => c.ai.countDone(n) < 1);
    if (missing.length && missing.every((n) => c.ai.count(n) > 0)) return true;
  }
  return false;
}

/**
 * Food of the soldiers standing (or queued) OUTSIDE the mix's rows — what `armyRows` takes off
 * the ceiling when `PlusProfile.wholeArmyCeiling` says the ceiling is the whole army.
 *
 * Read off the race's own catalogue (`table.units`), so it sees exactly the bodies this plan
 * can have asked for: the soldiers an earlier tier's mix bought, the siege, the `always` rows
 * and the anti-air. Heroes are not in the catalogue and are not the army the ceiling prices
 * (see `armyTarget`). The undead's LUMBER Ghouls are the economy and not the army, so the
 * forest crew's `LUMBER_UNITS` are left out — a Ghoul past that is a soldier like any other.
 */
function offMixFood(c: PlusCtx, rows: ReadonlyArray<{ unit: string }>): number {
  if (!c.profile.wholeArmyCeiling) return 0;
  const inMix = new Set(rows.map((r) => r.unit));
  let food = 0;
  for (const unit of Object.keys(c.table.units)) {
    if (!inMix.has(unit)) food += soldiers(c, unit) * Math.max(1, c.foodOf(unit));
  }
  return food;
}

/**
 * How many of `unit` are SOLDIERS — standing, queued or reviving, less the forest crew if it is
 * the race's lumber unit. The forest crew is the brain's real one (`PlusCtx.lumberCrew`): the
 * flat six this used to subtract was every Ghoul the economy row asks for, and `recruit`
 * (plus/index.ts) walks all but a third of those into the wave — four Ghouls, eight food, on
 * top of an undead Normal's ceiling in every fight.
 */
function soldiers(c: PlusCtx, unit: string): number {
  const n = c.ai.count(unit);
  if (unit !== c.table.lumberUnit || c.workerChops) return n;
  return Math.max(0, n - Math.min(LUMBER_UNITS, c.lumberCrew ?? LUMBER_UNITS));
}

/**
 * Food of EVERY soldier this race's catalogue can field, in the mix or not — the number the
 * whole army's ceiling is measured against (`fitted`). `offMixFood` alone was not that: it
 * skips the units the current mix still names, so the six Grunts a Grunt-only opening bought
 * stood uncounted beside the Head Hunters' full share once the War Mill went up, and every
 * re-weighting (a tier, a counter, `thenAt3`) left the old row's surplus standing the same way.
 */
function soldierFood(c: PlusCtx): number {
  let food = 0;
  const seen = new Set<string>();
  const add = (id: string, n: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    food += n * Math.max(1, c.foodOf(id));
  };
  for (const unit of Object.keys(c.table.units)) add(unit, soldiers(c, unit));
  // …and every soldier standing in ANOTHER FORM, which the census counts under that form's own
  // id (`AiPlayer.censusOf` folds a morph back for heroes alone) and so under no catalogue row:
  // a Berserker, a Druid in Bear Form, a Destroyer — each a body the ceiling would otherwise
  // hand to somebody else, priced at its own food (a Destroyer is 5 against a Statue's 3).
  for (const unit of Object.keys(c.table.units)) {
    for (const form of [...(TOWN_COUNT_EQUIVALENTS[unit] ?? []), ...(OTHER_FORMS[unit] ?? [])]) {
      add(form, c.ai.count(form));
    }
  }
  return food;
}

/** Forms a soldier can take that `TOWN_COUNT_EQUIVALENTS` does not fold — because common.ai's
 *  `TownCountEx` does not, and folding them there would change what the build rows ask for —
 *  but which are still the same body on the field. */
const OTHER_FORMS: Record<string, string[]> = {
  [OBSIDIAN_STATUE]: [BLK_SPHINX], // Destroyer Form (`Rusp`)
  [PIT_FIEND]: ["ucrm"], // a burrowed Crypt Fiend (`Abur`)
};

/** Bodies each unit's rows have been let through this pass, beyond what already stands —
 *  emptied by `buildPlan` at the top of every pass. Without it every row would see
 *  the same room and each spend all of it; per UNIT, because `army` is asked twice a pass (the
 *  core and the full budget) and the second call's row for a unit is the same bodies again. */
const passLedger = new WeakMap<PlusCtx, Map<string, number>>();

/**
 * `want` of `unit`, cut down to what fits under the WHOLE army's ceiling — or `want` itself
 * when the profile's ceiling is the mix's alone (`PlusProfile.wholeArmyCeiling` off).
 *
 * The room is the ceiling less every soldier standing or queued (`soldierFood`), less what this
 * pass has already let through for OTHER units, less `keep` — the room the side rows are owed
 * and have not claimed yet, which the MIX must leave them. A count already met asks for nothing
 * new and passes unchanged; a count that does not fit is lowered to the most that does, so a
 * full army grows again only as it loses bodies, which is what a ceiling is.
 */
function fitted(c: PlusCtx, unit: string, want: number, keep = 0, roundUp = false): number {
  if (!c.profile.wholeArmyCeiling) return want;
  const have = c.ai.count(unit);
  if (want <= have) return want;
  let ledger = passLedger.get(c);
  if (!ledger) passLedger.set(c, (ledger = new Map()));
  const food = Math.max(1, c.foodOf(unit));
  let others = 0;
  for (const [id, n] of ledger) if (id !== unit) others += n * Math.max(1, c.foodOf(id));
  const room = c.profile.armyFood - soldierFood(c) - others - keep;
  const prior = ledger.get(unit) ?? 0;
  // `roundUp`: a body may take whatever room is LEFT, even a little less than it costs — the
  // siege's privilege alone (`siegeLine`), and one body at a time, so the most it ever puts the
  // army over the ceiling is its own food less one.
  const fits = roundUp && room > 0 && room < food ? 1 : Math.floor(room / food);
  const more = Math.max(prior, Math.min(want - have, fits));
  ledger.set(unit, more);
  return have + Math.min(more, want - have);
}

/**
 * Room under the ceiling the SIDE rows are owed and have not yet claimed — the siege, the
 * `always` rows and the anti-air (while its trigger holds), each once it can be trained. An
 * army that filled the ceiling before then makes the row wait for its first loss, which is a
 * ceiling doing its job rather than a leak. Kept back from the mix so the side rows arrive INSIDE the ceiling
 * rather than on top of it. A unit the mix itself names is the mix's, and owed nothing here.
 */
function sideOwed(c: PlusCtx, rows: ReadonlyArray<{ unit: string }>): number {
  const { profile, table, tier } = c;
  if (!profile.wholeArmyCeiling) return 0;
  const inMix = new Set(rows.map((r) => r.unit));
  const owed = new Map<string, number>();
  const owe = (unit: string | undefined, n: number): void => {
    if (unit && n > 0 && !inMix.has(unit)) owed.set(unit, Math.max(owed.get(unit) ?? 0, n));
  };
  // Owed only once the row could actually TRAIN — its tier standing and its producer up. Held
  // from the start instead, an undead Normal kept ten of its twenty food back for a Meat Wagon
  // and two Statues it had no Slaughterhouse or Temple for, and fielded half an army for it.
  const cap = Math.min(profile.techTier, tier);
  const ready = (unit: string | undefined): boolean => {
    const row = unit ? table.units[unit] : undefined;
    return !!row && row.tier <= cap && producerReady(c, row.from, row.needs);
  };
  // The SIEGE is owed from the pass `siegeLine` starts working toward it — the tier, its army
  // gate, the unit's own requirements met — not from the pass its producer stands: the army
  // fills the ceiling while the Slaughterhouse goes up, and a wagon owed nothing until then
  // only ever came in after a loss, which is too late for the second wave it is meant for.
  if (siegeDue(c)) owe(table.siegeUnit, profile.siegeUnits);
  for (const r of table.always ?? []) if (ready(r.unit)) owe(r.unit, r.count);
  if (table.antiAir && antiAirDue(c) && ready(table.antiAir.unit)) owe(table.antiAir.unit, antiAirCount(c, table.antiAir.count));
  let food = 0;
  for (const [unit, n] of owed) food += Math.max(0, n - c.ai.count(unit)) * Math.max(1, c.foodOf(unit));
  return food;
}

/**
 * The FOOD of the whole army the plan is building toward — `army(c, profile.armyFood)`'s rows,
 * priced. Soldiers only: the heroes are their own rows. See `armyRows` for why this is not
 * simply `profile.armyFood`.
 */
export function armyTarget(c: PlusCtx): number {
  return armyRows(c, c.profile.armyFood).reduce((n, r) => n + r.want * Math.max(1, c.foodOf(r.unit)), 0);
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
  const rows = massCap(c, capCasters(c, strategyMix(c)));
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
 * …and the race's MASS unit held to its share once there are enough of it — see
 * `PlusRaceTable.mass`. `capCasters`' arithmetic asked of one unit, and only once `count` of it
 * stand (queued included, its upgraded form folded in by `townCount`: a Berserker is the Head
 * Hunter it was trained as). Never when it is all the mix can make — a tier-1 Head Hunter opening
 * has nothing else to hand the budget to, and the cap would only leave the food unspent.
 */
function massCap(c: PlusCtx, rows: Array<{ unit: string; weight: number }>): Array<{ unit: string; weight: number }> {
  const mass = c.table.mass;
  if (!mass) return rows;
  const row = rows.find((r) => r.unit === mass.unit);
  if (!row || c.ai.townCount(mass.unit) < mass.count) return rows;
  const others = rows.reduce((n, r) => (r === row ? n : n + r.weight), 0);
  if (others <= 0) return rows;
  const allowed = (others * mass.share) / (1 - mass.share);
  if (row.weight <= allowed) return rows;
  return rows.map((r) => (r === row ? { ...r, weight: allowed } : r));
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
export function activeStrategy(c: PlusCtx): PlusStrategy {
  return waiting(c, affordable(c, grownInto(c)));
}

/** …less the units still WAITING on something (`PlusStrategy.waitFor`) — the human's Gryphon
 *  Riders until there are Knights enough, the orc's Taurens until the Berserker Upgrade. Read
 *  every pass, like the tier: a waiting unit's producer is not put up either (`mixBuildings`
 *  reads this same mix), so nothing is spent on it before it is wanted. */
function waiting(c: PlusCtx, strategy: PlusStrategy): PlusStrategy {
  const wait = strategy.waitFor;
  if (!wait) return strategy;
  const drop = Object.entries(wait).filter(([, w]) => !holds(c, w)).map(([u]) => u);
  if (!drop.length) return strategy;
  const keep = ([u]: [string, number]): boolean => !drop.includes(u);
  // …and out of the LEAD rows as well: the undead's Frost Wyrms are a lead count that waits for
  // the Abominations in front of them (plus/races.ts `THEN_WYRMS`).
  const lead = strategy.lead && Object.fromEntries(Object.entries(strategy.lead).filter(keep));
  return { ...strategy, mix: Object.fromEntries(Object.entries(strategy.mix).filter(keep)), lead };
}

/** How many of this player's ordered heroes are trained or in training (`PowerSpike.heroes`). */
function heroesOut(c: PlusCtx): number {
  const { ai } = c;
  return [ai.heroId, ai.heroId2, ai.heroId3].filter((id) => !!id && ai.count(id) > 0).length;
}

/** Does every clause of `w` hold? A clause left out asks nothing — the same reading index.ts
 *  `spikeHeld` gives a `PowerSpike`, except that a unit is counted with its other forms
 *  (`townCountDone`, `TOWN_COUNT_EQUIVALENTS`): a Druid of the Claw in Bear Form is still one. */
function holds(c: PlusCtx, w: PowerSpike): boolean {
  return (!w.research || c.ai.upgradeLevel(w.research[0]) >= w.research[1])
    && (!w.units || c.ai.townCountDone(w.units[0]) >= w.units[1])
    && (!w.started || c.ai.townCount(w.started[0]) >= w.started[1])
    && (!w.heroes || heroesOut(c) >= w.heroes)
    && (!w.researching || c.ai.researchBegun(w.researching))
    && (!w.tier || c.tier >= w.tier)
    && (!w.armyFood || c.armyFood >= w.armyFood);
}

/** …the rolled build, or what it has grown into: `thenAt3` at tier 3, `thenAt2` from tier 2
 *  (`PlusStrategy.thenAt2`), each only where the difficulty may reach that tier at all. */
function grownInto(c: PlusCtx): PlusStrategy {
  const { strategy } = c;
  const find = (id: string | undefined): PlusStrategy | undefined =>
    id ? c.table.strategies.find((s) => s.id === id) : undefined;
  if (c.tier >= 3 && c.profile.techTier >= 3) {
    const at3 = find(strategy.thenAt3) ?? find(find(strategy.thenAt2)?.thenAt3);
    if (at3) return at3;
  }
  if (c.tier >= 2 && c.profile.techTier >= 2) return find(strategy.thenAt2) ?? strategy;
  return strategy;
}

/** A bank the build order is visibly not spending — `PlusStrategy.affluent`'s "the resources".
 *  OURS, and the same order of purse elf.ai's own `setBuildUnit(gold > 1000 && wood > 500 ? 2
 *  : 1, …)` reads as "rich" (src/ai/aiPlayer.ts). */
const AFFLUENT_GOLD = 1000;
const AFFLUENT_LUMBER = 500;

/** …less the `affluent` units, unless there is something to spare: a second mine, a rich bank,
 *  or their producer already standing (so a Roost that was built is not left idle the moment
 *  the bank dips). Read every pass, like the tier. */
function affordable(c: PlusCtx, strategy: PlusStrategy): PlusStrategy {
  if (!strategy.affluent?.length) return strategy;
  const { ai } = c;
  const rich = ai.minesOwned() >= 2 || (ai.gold() >= AFFLUENT_GOLD && ai.wood() >= AFFLUENT_LUMBER);
  const drop = strategy.affluent.filter((u) => {
    if (rich) return false;
    const from = c.table.units[u]?.from;
    return !(from && ai.countDone(from) > 0);
  });
  if (!drop.length) return strategy;
  const mix = Object.fromEntries(Object.entries(strategy.mix).filter(([u]) => !drop.includes(u)));
  return { ...strategy, mix };
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
  // …and the build's LEAD units (`PlusStrategy.lead`), which may name a unit the mix does not —
  // the human's three Flying Machines are a count beside the Knight army, not a share of it.
  // FIRST, because they are the build's priority and `techBuildings` asks in this order with a
  // thin purse: an orc standard plan put its Spirit Lodge (off the mix's Shamans) up ahead of the
  // Beastiary its four Raiders and its Kodo come out of.
  const wanted = [
    ...Object.keys(strategy.lead ?? {}),
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
  if (profile.techTier >= 3 && tier >= 2 && armyFood >= TIER3_ARMY && !tier3Held(c)) ai.setBuildUnit(1, table.halls[2]);
}

/** …and the same tier-2 row HIGH in the ladder once its clock is up — see `TIER2_CLOCK`. Asking
 *  twice in one pass is free: the first ask starts the upgrade and `townCount` counts a job in a
 *  queue, so the second is already satisfied; and if the first could not afford it the loop never
 *  reaches the second. */
function tierUpDue(c: PlusCtx): void {
  if (c.clock < tier2Clock(c)) return;
  tier2(c);
}

/**
 * …and the TIER-3 row HIGH in the ladder, for a race whose tier 3 is its plan
 * (`PlusRaceTable.tier3Clock`, the build's own over it). The same row `tierUp` asks at the
 * bottom — asking twice in a pass is free, as for tier 2 — but placed above the tech buildings,
 * the upgrades, the siege, the expansion and the third hero, so from the clock on the hall is
 * what the gold is saved for and the loop halts here until it can pay.
 *
 * NOT while the player is REBUILDING: an army under `TIER3_ARMY` or a gold crew short of its
 * five per mine is a player who has just lost a fight or a raid, and a ladder player puts the
 * bodies back before the tech. The rows that replace them are all ABOVE this one, so the clock
 * only waits for them and never competes with them; the bottom-of-the-ladder row still applies.
 */
function tier3Due(c: PlusCtx): void {
  // …or from the moment the tier-2 hall stands, on a rung that RUSHES it (`PlusProfile.tier3Rush`,
  // Insane): every race, every build, no clock at all. The gates below still hold — a rush that
  // left the army or the mine crew short would be the first raid's to punish.
  // A build's OWN clock is kept even under the rush (`tier3Held`) — it is the build saying when.
  const at = c.strategy.tier3Clock ?? (c.profile.tier3Rush ? 0 : c.table.tier3Clock);
  if (at === undefined || c.clock < at + c.profile.tier3Delay) return;
  if (tier3Held(c)) return; // …and a build's own condition (`tier3After`)
  const { ai, profile, table, armyFood, tier } = c;
  if (profile.techTier < 3 || tier < 2 || armyFood < TIER3_ARMY) return;
  if (ai.count(table.worker) < MINE_CREW * Math.max(1, ai.minesOwned())) return;
  ai.setBuildUnit(1, table.halls[2]);
}

/** The army held while the second tier is saved for — the race's, else `TIER2_ARMY` (see
 *  `PlusRaceTable.tier2Army`). */
function tier2Army(c: PlusCtx): number {
  return c.table.tier2Army ?? TIER2_ARMY;
}

/** …and the clock is the BUILD'S, then the RACE'S — see `PlusStrategy.tier2Clock` and
 *  `PlusRaceTable.tier2Clock`. */
function tier2Clock(c: PlusCtx): number {
  return c.strategy.tier2Clock ?? c.table.tier2Clock ?? TIER2_CLOCK;
}

function tier2(c: PlusCtx): void {
  const { ai, profile, table, armyFood, tier } = c;
  if (profile.techTier < 2 || tier < 1) return;
  // A build that names its OWN tier-2 clock (a rush, a fast expand) does not buy the hall before
  // it, not even out of leftover gold at the bottom of the ladder — the gold is the army's and
  // the second mine's until then. See `PlusStrategy.tier2Clock`.
  if (c.strategy.tier2Clock !== undefined && c.clock < c.strategy.tier2Clock && !starved(c)) return;
  if (armyFood < tier2Army(c) && !starved(c)) return;
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
  const due = new Set(supportDue(c));
  // A row for several (`SupportRow.count`, the night elf's two Lores) asks for ONE MORE THAN IS
  // BEGUN, not for all of them: a row reserves the price of everything it asks for, and asking for
  // both Lores at once held the first back until both could be paid for — measured live, the first
  // Lore went up at 8:00–8:20 instead of 6:45–7:25.
  for (const r of c.table.support) {
    if (!due.has(r.build)) continue;
    const begun = c.ai.townCount(r.build);
    // …and the copies after the first wait for `SupportRow.moreWhen` (the night elf's second Lore,
    // for Abolish Magic to begin).
    const more = begun < 1 || !r.moreWhen || holds(c, r.moreWhen);
    c.ai.setBuildUnit(Math.min(r.count ?? 1, more ? begun + 1 : Math.max(1, begun)), r.build);
  }
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
  // …and so is the undead's Slaughterhouse, when the early siege row has already asked for it.
  const early = earlySiegeProducer(c);
  if (early) asked.add(early);
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
 *    of two of the three difficulties, so it could never fire; see `PlusProfile.factoryGold`.
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
    // The bank's copies at the profile's own price and ceiling (`PlusProfile.factoryGold`/
    // `factoryMax` — the file's 800 and 3 below Insane), and from tier 2 the floor Insane holds
    // whatever the bank says (`producersAtTier2`): "MASS more units" is production buildings
    // first, because one Barracks is one soldier at a time.
    const floor = tier >= 2 ? profile.producersAtTier2 : 1;
    if (main) ask(main, Math.min(profile.factoryMax, Math.max(floor, 1 + Math.floor(ai.gold() / profile.factoryGold))));
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
/** Has this player SEEN enough enemy air, at a difficulty that counters at all, to want the
 *  race's anti-air row? `antiAir`'s gate, shared with `sideOwed`. */
function antiAirDue(c: PlusCtx): boolean {
  const { profile, enemy } = c;
  if (profile.counterWeight <= 0) return false;
  // …or, on a rung that MATCHES the air (`PlusProfile.antiAirMatch`), enough flyers to be an air
  // army however much ground stands beside them — see `AIR_BODIES`.
  if (profile.antiAirMatch && (enemy.airBodies ?? 0) >= AIR_BODIES) return true;
  return enemy.seen >= profile.counterSample && enemy.air >= AIR_HEAVY;
}

/**
 * How many flyers seen make an air threat on a rung that matches the air, whatever their share
 * of the army (`antiAirDue`) — four, a Gryphon or Frost Wyrm squad's worth: three Gargoyles
 * escorting a ghoul army are a nuisance the fiends already answer, four Frost Wyrms are not.
 * And how far the answer may grow past the race's own count (`antiAirCount`): three times it,
 * so twelve Flying Machines or Gargoyles at most — an answer to air, never an air army. Ours.
 */
const AIR_BODIES = 4;
const ANTI_AIR_GROWTH = 3;

/**
 * The anti-air row's size: the race's own count (`PlusRaceTable.antiAir`), or — where the rung
 * matches the air (`PlusProfile.antiAirMatch`) — one body per flyer seen once there are more of
 * them than that, up to `ANTI_AIR_GROWTH` times it. Four Flying Machines are an answer to four
 * Gryphon Riders and a snack for ten. Shared with `sideOwed`, which keeps the room for it.
 */
function antiAirCount(c: PlusCtx, base: number): number {
  if (!c.profile.antiAirMatch) return base;
  return Math.min(base * ANTI_AIR_GROWTH, Math.max(base, c.enemy.airBodies ?? 0));
}

function antiAir(c: PlusCtx): void {
  const { ai, profile, table, tier } = c;
  const answer = table.antiAir;
  if (!answer || !antiAirDue(c)) return;
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
  const want = fitted(c, answer.unit, antiAirCount(c, answer.count));
  if (want > 0) ai.setBuildNext(want, answer.unit);
}

/**
 * SIEGE — `PlusProfile.siegeUnits` of the race's artillery (`PlusRaceTable.siegeUnit`), on top of
 * whatever build is being played, once the second tier is standing.
 *
 * The developer's brief: Computer+ "must build more siege units to grow its army — two
 * demolishers or mortar teams or meat wagons or glaive throwers later into the game would make a
 * lot of sense". Four of the twenty-one builds name a siege unit at all, so most armies reached
 * the mid-game with nothing that out-ranges a tower, and the attack ladder already knows what to
 * do with one when it has it (a siege unit is aimed at the buildings — plus/index.ts
 * `siegeTarget`). Its own row, rather than a weight in the mix, because `army` spends a SHARE of
 * a food budget and two bodies of a 3–4-food unit is a share no mix states the same way twice.
 *
 * "Later into the game" is two gates: a tier-2 hall STANDING (the Glaive Thrower is tier 1 on
 * the tables, but a tier-1 army is an army that should be creeping, not besieging) and
 * `SIEGE_AFTER` food of army already fielded, so the siege joins an army rather than replacing
 * one. `setBuildUnit` (absolute — "have two"): a lost Mortar Team is replaced, and once both
 * stand the row reserves nothing, so it cannot halt the ladder under it for longer than two
 * trainings take.
 *
 * Nothing is asked for that cannot be built (rule 1): the producer is put up only if the build
 * order does not already have it and its own `Requires` are met (a Workshop wants a Keep and a
 * Blacksmith, a Slaughterhouse a Halls of the Dead and a Graveyard), and a missing smith is the
 * `support` row's to put up rather than this one's.
 */
/** Is `siegeLine` working toward its siege this pass — the hall tier, the army gate, and the
 *  unit's own `needs` all met (its producer may still be going up)? Shared with `sideOwed`. */
function siegeDue(c: PlusCtx): boolean {
  const { ai, profile, table, tier } = c;
  const unit = table.siegeUnit;
  if (!unit || profile.siegeUnits <= 0) return false;
  if (tier < SIEGE_TIER || c.armyFood < SIEGE_AFTER) return false;
  const row = table.units[unit];
  if (!row || row.tier > Math.min(profile.techTier, tier)) return false;
  for (const need of row.needs ?? []) if (ai.countDone(need) < 1) return false;
  return true;
}

/**
 * The siege producer an EARLY siege row (`PlusRaceTable.siegeEarly`) asks for this pass, or ""
 * — asked for even when the build's own mix names it too, since the mix's row is further down
 * the ladder, and then left out of `techBuildings` so it is not asked for (and priced) twice.
 */
function earlySiegeProducer(c: PlusCtx): string {
  const { ai, table } = c;
  if (!table.siegeEarly || !table.siegeUnit || !siegeDue(c)) return "";
  const from = table.units[table.siegeUnit]?.from;
  return from && ai.countDone(from) < 1 && ai.techMeets(from) ? from : "";
}

/** Food of the siege `siegeLine` is working toward and has not got — the room a row BELOW it
 *  must leave alone (`always`). Nothing when the mix names the siege itself. */
function siegeStillOwed(c: PlusCtx): number {
  const { ai, profile, table } = c;
  const unit = table.siegeUnit;
  if (!unit || !siegeDue(c) || buildableMix(c).some((r) => r.unit === unit)) return 0;
  return Math.max(0, profile.siegeUnits - ai.count(unit)) * Math.max(1, c.foodOf(unit));
}

function siegeLine(c: PlusCtx): void {
  const { ai, profile, table } = c;
  const unit = table.siegeUnit;
  if (!unit || !siegeDue(c)) return;
  const row = table.units[unit];
  if (ai.countDone(row.from) < 1) {
    if (earlySiegeProducer(c) || (!mixBuildings(c).some((b) => b.build === row.from) && ai.techMeets(row.from))) {
      ai.setBuildUnit(1, row.from);
    }
    return;
  }
  if (!ai.techMeets(unit)) return;
  // ROUNDED UP for the race whose waves wait for it (`siegeEarly`): a lost lumber Ghoul
  // re-bought by the economy row, or one Gargoyle bought while it was dead, leaves three food of
  // room for a four-food Meat Wagon, and then the wagon the second wave is held for never fits.
  const want = fitted(c, unit, profile.siegeUnits, 0, !!table.siegeEarly);
  if (want > 0) ai.setBuildUnit(want, unit);
}

/** The hall tier `siegeLine` waits for — the Keep, the Stronghold, the Halls of the Dead, the
 *  Tree of Ages. OURS. */
const SIEGE_TIER = 2;
/** …and the army food it waits for on top: the siege is added to an army, never in place of
 *  one. OURS — a Normal computer's army is 20 food at most, so this is most of it. */
const SIEGE_AFTER = 16;

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
    // …leaving the SIEGE its room while it is still owed: a Statue is three food and a Meat
    // Wagon four, both out of one Slaughterhouse, and three food of room went to the Statue
    // every time, so the wagon never fitted at all.
    const want = fitted(c, row.unit, row.count, siegeStillOwed(c));
    if (want > 0) ai.setBuildUnit(want, row.unit);
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
  // Reign of Chaos has no race shop to put up (`tableForEdition` leaves this empty): its heroes
  // buy at whatever neutral shelf the map has, which plus/items.ts has always looked for.
  if (!table.shop) return;
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

/**
 * Towers: none at all on Easy, and never before something has actually gone wrong or the
 * game has gone long. Placement puts them at the town's FRONT (see AiPlayer.siteFor).
 *
 * …and, for the human, what the Scout Towers BECOME (`PlusRaceTable.towerUpgrades`). The base
 * row is asked in the FOLDED count (`TownCount`: a Guard Tower is a Scout Tower, ids.ts
 * `TOWN_COUNT_EQUIVALENTS`), so a town's `each` is its towers of any kind and an upgrade never
 * makes it ask for another Scout Tower. The upgrade rows are asked per TOWN, off the town's own
 * standing Scout Towers, and each id only when its `Requires` is met — the human computer was
 * seen standing behind plain Scout Towers all match, and that was this row asking for a Guard
 * Tower (`Requires=hlum`) at a base with no Lumber Mill: refused every pass, and never the Arcane
 * Tower that needs nothing. A row it cannot buy still costs it — see `towerUpgrades`.
 */
function towers(c: PlusCtx): void {
  const { ai, profile, table, clock, threatened } = c;
  if (profile.towers < 1) return;
  if (!threatened && clock < TOWER_CLOCK) return;
  // Split between the main and the expansions: an expansion is the thing that actually needs
  // guarding, so it gets the first one.
  //
  // `profile.towers` is the WHOLE MATCH's count, never a per-town one. `each` rounds UP to one, so
  // three towns at two towers was three, and a per-town quota of four on Insane was a main with
  // four towers in it — reported: *"building a lot of towers in its base. it should build at
  // most 2."* So the towns draw on one budget, in town order, until it is spent.
  const towns = Math.max(1, ai.minesOwned());
  const each = Math.max(1, Math.floor(profile.towers / towns));
  const quota: number[] = [];
  let budget = profile.towers;
  for (let t = 0; t < ai.townCountTotal(); t++) {
    quota[t] = Math.min(each, budget);
    budget -= quota[t];
    if (quota[t] > 0) ai.guardSecondary(t, quota[t], table.tower);
  }
  if (!table.towerUpgrades) return;
  for (let t = 0; t < ai.townCountTotal(); t++) {
    // Something to upgrade: a FINISHED plain tower here. (One whose upgrade is already in its
    // queue is still its base type, and the row below counts that queued job as done.)
    if (ai.countAt(table.tower, t, true) < 1) continue;
    let left = quota[t];
    for (const up of table.towerUpgrades) {
      if (left < 1) break;
      const qty = up.perTown === undefined ? left : Math.min(up.perTown, left);
      left -= qty;
      if (!ai.techMeets(up.id)) continue; // not legal yet — a Lumber Mill for the Guard Tower
      ai.guardSecondary(t, qty, up.id);
    }
  }
}

/**
 * AT LEAST ONE TOWER — the developer's *"for Normal and Insane difficulty, make the Computer+ AI
 * get at least one tower"*: an Arcane Tower for the human, a Watch Tower for the orc, a Spirit
 * Tower for the undead and an Ancient Protector for the night elf (`PlusRaceTable.tower`, and
 * for the human the first of `towerUpgrades`).
 *
 * `towers` below already asks for them, and asks at the very BOTTOM of the ladder — under the
 * tier-up, the extra heroes and the expansion, every one of them a row that halts the loop while
 * it saves — so in practice the row that reached it was the rare pass on which the AI had
 * nothing else to buy, and whole matches went by without one. This is the first of them lifted
 * to just under the tier-2 row, where it is reached once the Keep is paid for.
 *
 * Gated on the SECOND TIER STANDING (or something already in the base): below that the
 * opening's gold is the hero's, the army's and the Keep's, and a player's first tower goes up
 * with the tech rather than ahead of it. `profile.towers` is what keeps Easy out, and each race's
 * tower has a `Requires` (`[owtw]` a War Mill, `[uzg1]` a Graveyard, `[etrp]` a Hunter's Hall —
 * the support rows above) that is asked first, so an illegal row never halts the ladder.
 * One at the MAIN: the expansions get theirs from `towers`, which counts this one as its own.
 */
function firstTower(c: PlusCtx): void {
  const { ai, profile, table, tier, threatened } = c;
  if (profile.towers < 1) return;
  if (tier < 2 && !threatened) return;
  if (!ai.techMeets(table.tower)) return;
  ai.guardSecondary(0, 1, table.tower);
  // …and for the human, the Scout Tower BECOMES the Arcane Tower (`[hatw] Requires=` is empty).
  const up = table.towerUpgrades?.[0];
  if (up && ai.countAt(table.tower, 0, true) >= 1 && ai.techMeets(up.id)) ai.guardSecondary(0, 1, up.id);
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
/**
 * THE UNIT-ABILITY UNLOCKS — Web, Ghoul Frenzy, the Berserker Upgrade, Ensnare, Defend, Abolish
 * Magic (`UpgradeRow.unlock`) — high in the ladder and SAVED for.
 *
 * The developer's: "make sure that each race uses their upgrades like Web (undead) and Berserker
 * Strength (orc), footmen Defend". As ordinary research rows at the bottom of the ladder they were
 * bought out of spare change, and only from an IDLE building — and every one of them is researched
 * at a PRODUCTION building the army rows never leave idle. Measured live (Insane, Echo Isles,
 * fourteen minutes): no Defend after twelve enemy ranged units had been scouted, and no Web at all
 * with both its requirements standing. Here, just under the support buildings, each is a saving row
 * (`AiPlayer.setBuildUpgrSaved`): once legal it keeps its price back from everything below and
 * frees one of its buildings to start it. Same gates as any research row — its building standing,
 * the army it is for (`after`), and its `when`.
 */
function abilityUpgrades(c: PlusCtx): void {
  const { ai, table, armyFood } = c;
  for (const row of table.upgrades) {
    if (!row.unlock || ai.countDone(row.from) < 1) continue;
    if (tier3Owns(c, row.id)) continue; // already asked, far higher up — never twice (`tier3Research`)
    if (armyFood < (row.after ?? 0)) continue;
    if (row.forUnit && ai.townCount(row.forUnit) < (row.forCount ?? 1)) continue; // `UpgradeRow.forUnit` — its other forms count too
    if (row.when === "enemyRanged" && (c.enemy.pierce ?? 0) < ENEMY_RANGED) continue;
    ai.setBuildUpgrSaved(row.ranks, row.id);
  }
}

/**
 * WHAT TIER 3 BUYS FIRST — `PlusRaceTable.tier3First`, the orc's Berserker Upgrade and then its
 * Shaman Master Training, saved for in that order (`setBuildUpgrSaved`) from the pass the
 * tier-3 hall stands, ABOVE the core army: the developer's *"orc must make it its number one
 * priority to get the berserker upgrade upon reaching tier 3, its second priority to get the
 * shaman master training"*. A saving row never halts the loop, so the army under it still
 * trains out of whatever the two researches leave; what changes is that the research is paid
 * FIRST rather than out of the gold the army rows did not want. No `after` gate — the army food
 * an unlock usually waits for is the tier-2 army, long out by tier 3 — but a row's `forUnit`
 * still holds (Master Training with no Shaman yet waits for the first one).
 */
function tier3Research(c: PlusCtx): void {
  const { ai, table } = c;
  if (c.tier < 3 || !table.tier3First) return;
  for (const id of table.tier3First) {
    const row = table.upgrades.find((r) => r.id === id);
    if (!row || ai.countDone(row.from) < 1) continue;
    if (row.forUnit && ai.townCount(row.forUnit) < 1) continue;
    ai.setBuildUpgrSaved(row.ranks, row.id);
  }
}

/** Does `tier3Research` own this research row this pass? Then `abilityUpgrades` leaves it alone,
 *  because a research row emitted twice would be saved for twice. */
function tier3Owns(c: PlusCtx, id: string): boolean {
  return c.tier >= 3 && !!c.table.tier3First?.includes(id);
}

/**
 * …and its THIRD priority, the last hero: directly under the second hero's own tier-2 row, and so
 * under the core army — the one row this file never saves through — but above every other row
 * of the ladder, which is where `extraHeroes` had it waiting behind the expansion and the tier
 * rows. Its old 30-food army gate goes with it: by tier 3 the army it waits for is out.
 *
 * FOR EVERY RACE, not only the one with a `tier3First`. Reported: *"the orc ai doesn't seem to
 * keen towards getting its 3rd hero. same for human … we should have a logic that allows them get
 * their 3rd hero as part of their tier 3 priorities"*. A race with no `tier3First` still had only
 * `extraHeroes`, under the tech, the upgrades, the siege and the expansion; on the ladder fixture
 * two of the five Insane human builds (`sanctums`, `knights`) never asked for a third hero in
 * twenty minutes and a third asked seven minutes after its Castle.
 *
 * …and SAVED FOR while the tier-3 hall goes up (`tierTwoHero`'s own trick, one tier up): a hero
 * is not legal before that hall stands, so with only the row the saving began the moment the
 * Fortress or Castle finished, behind the research `tier3First` puts above it. While the upgrade
 * is in the hall's queue this holds the hero's price back from everything below (`reserveGold`,
 * which never halts), and the hero is in the altar the pass the hall lands.
 */
function tier3Hero(c: PlusCtx): void {
  const { ai, profile, table, tier } = c;
  if (profile.heroes < 3 || !ai.heroId3) return;
  if (ai.countDone(table.altar) < 1 || ai.count(ai.heroId) < 1 || ai.count(ai.heroId2) < 1) return;
  if (ai.count(ai.heroId3) >= 1) return;
  if (tier >= 3) {
    if (ai.heroLegal?.(ai.heroId3) ?? true) ai.setBuildUnit(1, ai.heroId3);
    return;
  }
  if (!thirdHallGoingUp(c)) return;
  const hero = c.defOf(ai.heroId3);
  if (hero) ai.reserveGold(hero.goldCost, hero.lumberCost);
}

/**
 * IS THE THIRD HERO BANKED FOR, ABOVE THE CORE ARMY? — from the pass the tier-3 hall stands with
 * `HERO3_BANK` of army out, until the hero is in the altar. `heroBanked` one tier up, and for the
 * reason that row moved: under `army(coreArmy)` the hero waited for the core army to fill, and an
 * `army` row is `SetBuildNext` — one more soldier per row per pass — so every pass bought a
 * soldier with the hero's gold. Measured on the ladder fixture with the row only under the core
 * army: the human's `sanctums` asked for its third hero four and a half minutes after its Castle.
 * Directly under `tier3Research`, so the orc's own tier-3 order (*Berserkers, then Bloodlust, then
 * the third hero*) still holds; and `releaseStall` lets the ladder past a hero it has stopped
 * getting nearer, so a broken base is not locked out of an army.
 */
function tier3Banked(c: PlusCtx): boolean {
  const { ai, profile, table } = c;
  if (c.tier < 3 || profile.heroes < 3 || !ai.heroId3 || c.armyFood < HERO3_BANK) return false;
  if (ai.countDone(table.altar) < 1 || ai.count(ai.heroId) < 1 || ai.count(ai.heroId2) < 1) return false;
  return ai.count(ai.heroId3) < 1;
}

/** The army that must be out before `tier3Banked` puts the third hero above the core army — the
 *  food the old bottom-of-the-ladder row waited for. Ours. */
const HERO3_BANK = 30;

/** Is the tier-3 hall in the queue — counted, none of it finished (`tier` is read off finished
 *  halls) — with the third hero still to buy? `tier3Hero`'s saving, and `secondHeroHold`'s. */
function thirdHallGoingUp(c: PlusCtx): boolean {
  const { ai, profile, table, tier } = c;
  return tier < 3 && profile.heroes >= 3 && !!ai.heroId3 && !!table.halls[2] && ai.count(table.halls[2]) >= 1
    && ai.countDone(table.altar) >= 1 && ai.count(ai.heroId2) >= 1 && ai.count(ai.heroId3) < 1;
}

/**
 * The build's POWER UNIT, high in the ladder (`PlusStrategy.lead`): under the ability unlocks,
 * which are what make it the power unit (Bear Form is `Redc`), and above the expansion, the third
 * hero, the towers and the rest of the army — every row that can halt the loop. A `SetBuildNext`
 * row like the army's, so it reserves one body's price at a time; only once the unit can be
 * trained at all (its tier standing, its producer up), or it would hold its price for a building
 * nobody has started.
 */
function leadUnits(c: PlusCtx): void {
  const lead = activeStrategy(c).lead;
  if (!lead) return;
  const cap = Math.min(c.profile.techTier, c.tier);
  for (const [unit, n] of Object.entries(lead)) {
    const row = c.table.units[unit];
    if (!row || row.tier > cap || !producerReady(c, row.from, row.needs)) continue;
    const want = fitted(c, unit, n);
    if (want > 0) c.ai.setBuildNext(want, unit);
  }
}

/** How many enemy PIERCING units must have been seen before Defend is worth researching
 *  (`UpgradeRow.when`) — "a few". Ours. */
const ENEMY_RANGED = 3;

function upgrades(c: PlusCtx): void {
  const { ai, profile, table, armyFood } = c;
  // A RUSHED tier 3 (`PlusProfile.tier3Rush`) takes NONE of the smith's research until the third
  // hall is paid for, and only the first rank of each while it goes up — the developer's "don't
  // buy many upgrades from the Hunter's Hall etc. until tier 3 is reached, same for other races".
  // Four Hunter's Hall ranks are 600 gold and 400 lumber, which is most of a Tree of Eternity.
  // The ability UNLOCKS are not this row (`abilityUpgrades`): they are what the army is for.
  if (tier3Rushing(c)) return;
  const rush = profile.tier3Rush && c.tier < 3;
  for (const row of table.upgrades) {
    if (row.unlock) continue; // `abilityUpgrades`, much higher up
    if (ai.countDone(row.from) < 1) continue;
    if (armyFood < (row.after ?? 0)) continue;
    if (row.forUnit && ai.townCount(row.forUnit) < (row.forCount ?? 1)) continue; // `UpgradeRow.forUnit` — its other forms count too
    // …and an upgrade that only answers one thing waits until that thing has been SEEN — see
    // `UpgradeRow.when`. Asked of the scouting read, so it is only as good as the scouting.
    if (row.when === "enemyRanged" && (c.enemy.pierce ?? 0) < ENEMY_RANGED) continue;
    ai.setBuildUpgr(Math.min(row.ranks, profile.upgradeRank, rush ? 1 : Infinity), row.id);
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
function expand(c: PlusCtx, early = false): void {
  const { ai, profile, table, strategy, clock, threatened } = c;
  // ONE row, at one of two depths: high in the ladder in the window after a won fight, and at its
  // ordinary place otherwise — never both, because a row that appears twice reserves its price
  // twice (`OneBuildLoop`).
  //
  // A build that expands WITH ITS TIER (`PlusStrategy.expandWithTier`) has its clock lifted for
  // its second town from the moment that hall stands — but the row STAYS where it is. It used to
  // move up with the won-fight row, and a hall row up there halts the ladder while it saves:
  // measured over 48 observed Insane matches, the orc's two-Beastiary builds stood their first
  // Raider three minutes after their Beastiary, every pass halted on the Great Hall above it.
  const owned = Math.max(1, ai.minesOwned());
  const withTier = owned === 1 && strategy.expandWithTier !== undefined && c.tier >= strategy.expandWithTier;
  const won = wonExpansion(c);
  if (early !== won) return;
  if (profile.expansions < 1 || threatened) return;
  if (owned >= 1 + profile.expansions) return;
  const planned = (owned === 1 ? strategy.expandAt : strategy.expandAgainAt) + profile.expandDelay;
  const needed = ai.goldOwned() < EXPAND_GOLD;
  if (clock < planned && !needed && !won && !withTier) return;
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
 * IS THIS THE MOMENT A WON FIGHT HAS MADE — expand now, whatever the build's clock says?
 *
 * Reported: the night elf "rarely expands", and its clearest missed chance was straight after it
 * had beaten the other army — theirs wiped, fled or Town-Portalled home, ours standing. A ladder
 * player takes the next mine THEN, because the one thing that punishes a new hall standing
 * exposed at a rock is the army that has just been sent away, and it will be minutes before it
 * is back. `ComputerPlusAi.victoryPass` is what notices, and when its roll spends the win on a
 * mine (`rollWin` → `expandOnWin`) it leaves `PlusCtx.wonAt` behind; this is the row
 * spending it, for every race — nothing about the moment is the night elf's.
 *
 * It does two things for `WON_EXPAND_WINDOW` seconds, and each fixes a different half of "never
 * gets round to it":
 *
 *  · the CLOCK is lifted — the build's `expandAt`/`expandAgainAt` and the difficulty's
 *    `expandDelay` are a plan for an ordinary game, and a won fight is not one — down to a
 *    floor of `WON_EXPAND_FLOOR`, before which a "won fight" is two openings bumping into each
 *    other and the economy has nothing to spare for a second hall;
 *  · and the ROW MOVES UP, from the bottom of the ladder to just under the core army
 *    (`buildPlan`). Down there it is below the tech, the tier-up and every support row, and a
 *    clock that is open does nothing for a row the loop never reaches.
 *
 * Everything else still applies: the difficulty's ceiling (`expansions`, so Easy never), never
 * while our own base is under attack, and `startExpansion`'s own refusals — a free mine, the
 * price, the camp on it (which the army is then sent at, `pickTarget` rung 0). The window is
 * bounded, so the high row's reservation ends with it: a halt it causes is the ladder saving for
 * one hall for a minute and a half, and the town the row CLAIMED keeps its hall row near the top
 * afterwards anyway (`meleeTownHall(1, …)`, and the undead's `mineBuildings`).
 */
/**
 * COULD this player take an expansion off a won fight at all? — asked by
 * `ComputerPlusAi.rollWin` before it spends the win on one, with `expand`'s own gates: the
 * difficulty's ceiling (Easy none), the mines already held, and `WON_EXPAND_FLOOR`, before which
 * `wonExpansion` would not lift the clock anyway.
 */
export function expansionOpen(ai: AiPlayer, profile: PlusProfile, clock: number): boolean {
  if (profile.expansions < 1 || clock < WON_EXPAND_FLOOR) return false;
  return Math.max(1, ai.minesOwned()) < 1 + profile.expansions;
}

function wonExpansion(c: PlusCtx): boolean {
  const at = c.wonAt ?? -1;
  return at >= 0 && c.clock >= at && c.clock - at <= WON_EXPAND_WINDOW && c.clock >= WON_EXPAND_FLOOR;
}

/** How long after a won fight the expansion is pressed for — see `wonExpansion`. OURS: long
 *  enough to bank one hall's price at an ordinary income, short enough that it is still the same
 *  moment the enemy army is walking home in. */
const WON_EXPAND_WINDOW = 90;
/** …and not before this game clock. OURS: three minutes is `TIER2_CLOCK`, the point at which a
 *  melee economy has anything past its opening to spend at all. */
const WON_EXPAND_FLOOR = TIER2_CLOCK;

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
