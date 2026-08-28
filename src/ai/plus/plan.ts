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
 * The army the plan keeps while it is teching — a hero and four or five soldiers.
 *
 * It is a FLOOR, not the army it intends to fight with: the rest of the mix is bought after the
 * tier, the tech and the upgrades have been paid for. Capped again by the profile, so an easy
 * computer's twelve-food ceiling is not quietly raised by it.
 *
 * Note this number does not change how much gold a pass RESERVES — the rows use `SetBuildNext`,
 * which asks for one more than is finished whatever the target is. It only decides how big the
 * army gets before the plan starts banking for a Stronghold.
 */
const CORE_ARMY_FOOD = 16;

/** Workers on a mine. WC3 mines take five at a time, so a sixth is a peasant standing in a
 *  queue: five per town, everybody else in the trees. */
const MINE_CREW = 5;

/** Nobody's second hero before this much army is fielded — the altar's gold is the army's
 *  until there is an army. */
const HERO2_ARMY = 14;
const HERO3_ARMY = 30;

/** When a tower goes up unprovoked (seconds). Before this the AI only towers if something is
 *  actually in its base, which is what a player does. */
const TOWER_CLOCK = 480;

/** A second Barracks (etc.) is a rich player's answer to "my army arrives too slowly". */
const FACTORY_GOLD = 800;
const FACTORY_ARMY = 40;

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
 *    seven hundred. Put the Stronghold first and the Forge never gets built at all — measured,
 *    and it is also the order every real orc build writes down. The expansion is above it for
 *    the same reason and a second one: expanding INSTEAD of teching is what a fast-expand build
 *    order is, and a strategy that has decided to take a second mine at four minutes must not
 *    be held behind a Stronghold it is not saving for yet. It emits no row at all when its
 *    clock has not come due, so this costs a build that is not expanding nothing.
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

  workers(c);
  supply(c);
  basics(c);
  firstHero(c);
  army(c, CORE_ARMY_FOOD); // enough not to die to the first raid, cheap enough not to block tech
  techBuildings(c);
  expand(c);
  extraHeroes(c);
  tierUp(c);
  towers(c);
  upgrades(c);
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
  const towns = Math.max(1, ai.minesOwned());
  ai.setBuildNext(profile.workers * towns, table.worker);
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
 * The two buildings every opening is the same shape around: somewhere to buy a hero and
 * somewhere to make a soldier.
 *
 * They come BEFORE the hero rather than after it, and the order matters because gold is
 * reserved down the list: a hero is four hundred gold, and a plan that saved for one before it
 * had asked for a Barracks would stand around with an Altar and nothing to defend it.
 */
function basics(c: PlusCtx): void {
  c.ai.setBuildUnit(1, c.table.altar);
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
  for (const r of rows) {
    const food = Math.max(1, c.foodOf(r.unit));
    const want = Math.floor((spend * r.weight) / total / food);
    // `SetBuildNext` for the same reason the workers use it (above): a row that reserved its
    // whole shortfall would hold the entire ladder under it — the tier-up, the tech, the
    // upgrades — until the army was full. One more at a time per row keeps production
    // continuous and lets the rest of the plan breathe.
    if (want > 0) ai.setBuildNext(want, r.unit);
  }
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
function buildableMix(c: PlusCtx): Array<{ unit: string; weight: number }> {
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
  for (const unit of Object.keys(strategy.mix)) {
    const row = table.units[unit];
    if (!row) continue;
    for (const b of [row.from, ...(row.needs ?? [])]) {
      seen.set(b, Math.min(seen.get(b) ?? row.tier, row.tier));
    }
  }
  return [...seen].map(([build, tier]) => ({ build, tier })).sort((a, b) => a.tier - b.tier);
}

/** Tier up — but only with an army on the field, and never past what the difficulty allows.
 *  A tier is an UPGRADE of the hall you own, and `SetProduce` tries that route first, which is
 *  why this reads as "have a Keep" rather than "found one". */
function tierUp(c: PlusCtx): void {
  const { ai, profile, table, armyFood, tier } = c;
  if (profile.techTier >= 2 && tier >= 1 && armyFood >= TIER2_ARMY) ai.setBuildUnit(1, table.halls[1]);
  if (profile.techTier >= 3 && tier >= 2 && armyFood >= TIER3_ARMY) ai.setBuildUnit(1, table.halls[2]);
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
  for (const row of table.support) {
    if (row.tier > cap || armyFood < row.after) continue;
    ai.setBuildUnit(1, row.build);
  }
  for (const row of mixBuildings(c)) {
    if (row.tier > cap || armyFood < TECH_AFTER[row.tier - 1]) continue;
    ai.setBuildUnit(1, row.build);
  }
  // …and a second copy of the building that makes the bulk of the army, once the bank is
  // deeper than the queue. The one thing that stops a rich computer sitting on 2000 gold.
  if (armyFood >= FACTORY_ARMY && ai.gold() > FACTORY_GOLD) {
    const main = mainProducer(c);
    if (main) ai.buildFactory(main);
  }
}

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

/** Upgrades, capped twice over: by what the row is worth (armour is 3 ranks, Defend is 1) and
 *  by what the difficulty allows. `setBuildUpgr` applies common.ai's own third cap on top —
 *  an easy computer never buys rank 2 of anything. */
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
  for (let t = 0; t < ai.townCountTotal(); t++) {
    if (ai.townHasMine(t) && ai.townHasHall(t)) ai.harvestGold(t, MINE_CREW);
  }
  ai.harvestWood(0, 40);
}
