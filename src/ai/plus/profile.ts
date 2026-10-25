import { engineFoodCeiling } from "../../data/gameplayConstants";
import { MELEE_INSANE, MELEE_NEWBIE, MELEE_NORMAL, UPKEEP_TIER2 } from "../ids";
import { CAMP_GREEN_MAX } from "./power";
import type { TargetSkill } from "./targeting";

// Computer+ — what a difficulty MEANS (issue #124).
//
// This is the file to read first, and the one place a difficulty is defined. It is also the
// clearest difference between Computer+ and the classic melee AI, so it is worth stating the
// contrast up front (docs/melee-ai.md "The difficulty spread" is the other half):
//
//   • The CLASSIC computer's difficulty is scattered across five Blizzard scripts as forty
//     `MeleeDifficulty() != MELEE_NEWBIE` guards, and INSANE is not in the scripts at all —
//     it is an engine cheat (double harvest, no fog). One rung is a build order with holes
//     punched in it and another is the same build order with a bigger bank.
//   • COMPUTER+ has no cheats at ANY rung — see `docs/computer-plus.md`. Every difference is
//     a number in the table below, and every one of them is something a HUMAN player varies:
//     how fast they notice, how much they build, how far they tech, whether they micro.
//
// **None of these numbers are Warcraft III's.** Nothing in the install describes an improved
// AI, so unlike `src/ai/human.ts` and its three siblings — where a number is Blizzard's unless
// a comment says otherwise — every value here is OURS, chosen to hit the brief in issue #124
// and stated with the reasoning beside it. Treat them as tuning, not as reference data.

/** One difficulty, in full. Everything the Computer+ brain reads about "how well do I play". */
export interface PlusProfile {
  /** `MeleeDifficulty()` — the lobby's Easy/Normal/Insane, as common.ai numbers it. Shared
   *  with the classic AI so a slot's difficulty means the same thing on both sides of the
   *  Computer+ checkbox. */
  readonly difficulty: number;

  // --- reaction: how long the AI takes to NOTICE things ---------------------------------
  /** Seconds between economy/production passes. A human checks their queues every couple of
   *  seconds when they are concentrating and much less often when they are not. */
  readonly buildPeriod: number;
  /** Seconds between army passes — re-aiming, retreating, regrouping. */
  readonly armyPeriod: number;
  /** Seconds between spell passes (see plus/casting.ts). */
  readonly castPeriod: number;
  /** How long an enemy has to stand in the base before the army turns around. THE single
   *  most-felt difficulty number: an easy computer lets you kill four peasants first. */
  readonly defendDelay: number;
  /** How long a fight has to have been going before a spell is pressed. A human does not
   *  Storm Bolt on the first frame of an engagement. */
  readonly castDelay: number;

  // --- aiming: how well it CHOOSES, as opposed to how fast it reacts ----------------------
  /**
   * How it reads a fight when it picks a target — for a spell and for the army alike
   * (plus/targeting.ts).
   *
   * `castDelay` above is how fast this player sees the fight; this is how well they understand
   * it, and the two are genuinely different axes. A `naive` player aims at the biggest body on
   * the screen: Storm Bolt goes on the Tauren, Death Coil on the Abomination, and the Shaman
   * behind them keeps casting. A `sound` one values what a unit IS. An `expert` also knows what
   * the SPELL is for — a nuke where it finishes something, a disable on the highest damage per
   * second, and never a full-length stun spent on a hero that only eats a third of it.
   */
  readonly castTargeting: TargetSkill;
  /**
   * Chance that a cast is aimed at a random legal target instead of at the best one.
   *
   * The other half of "aims badly": `castTargeting` is a consistently wrong MODEL of a fight,
   * this is ordinary sloppiness on top of it — the click that went on the wrong unit. Kept
   * small, because a computer that misclicks a third of its spells stops reading as a player
   * and starts reading as broken.
   */
  readonly castMistake: number;
  /**
   * How hard the kill-priority ladder is allowed to pull onto an enemy HERO. 0 = a hero is
   * just another soldier; 1 = the full curve in plus/targeting.ts.
   *
   * This is the knob on the single most-complained-about habit of Blizzard's own melee AI: it
   * drops everything to swing at the enemy hero, follows it out of the fight, and loses the
   * army to the units it walked past. Even at 1 the curve is conditional — a HEALTHY hero is
   * worth barely more than a soldier and only a hero that can be finished (`heroKillable`)
   * climbs — so a higher number here means "is better at spotting the kill", not "chases
   * harder". The army adds a second gate on top: it will not walk after one (`HERO_CHASE`).
   */
  readonly heroFocus: number;

  // --- economy --------------------------------------------------------------------------
  /** Workers per town it aims for.
   *
   *  A WC3 gold mine takes five at a time, so everything past the fifth is a lumberjack — and
   *  every one of them is 75 gold that did not become an army. The ladder's own answer for a
   *  one-base game is around five on gold and half a dozen in the trees, which is what these
   *  are; the top rung is higher because it expands and crews the second mine too. */
  readonly workers: number;
  /**
   * How many EXTRA towns it will take. 0 = it never expands, which is issue #124's "Easy must
   * not execute complex strategies like fast expansions".
   *
   * A CEILING and nothing else. WHEN a computer expands is the build order's business, not the
   * difficulty's — every strategy carries its own `expandAt` / `expandAgainAt` (plus/races.ts),
   * because taking a second mine early is what a fast-expand build IS. All the difficulty adds
   * is `expandDelay`.
   */
  readonly expansions: number;
  /** Seconds ADDED to whatever clock the build order set. A weaker player runs the same build
   *  late; they do not run a different build. */
  readonly expandDelay: number;

  // --- countering: rebuilding against what the enemy turns out to be fielding ---------------
  /**
   * How hard it re-weights its army mix against the enemy composition it has SCOUTED
   * (plus/counter.ts). 0 = it never counters; 1 = a unit's share moves by the full damage-table
   * advantage its attack type has against what it has seen.
   *
   * Applied as a nudge to the strategy's own weights rather than as a rewrite, so a countering
   * computer is still visibly playing the build it opened with.
   */
  readonly counterWeight: number;
  /** How many distinct enemy fighters it must have seen before it reacts at all. A bigger
   *  sample is a slower, more careful read — and a weaker player needs more of it. */
  readonly counterSample: number;
  /** …and the share of that sample a type must reach before it counts as a composition rather
   *  than as a sighting. Issue #124: "after scouting a certain percentage of units of a certain
   *  type". */
  readonly counterShare: number;
  /** How long a sighting stays in the memory. A short memory is a player who only reacts to
   *  what they saw a moment ago. */
  readonly counterMemory: number;

  // --- the ceiling on the army ------------------------------------------------------------
  /**
   * The HARD CAP on food spent on fighters — issue #124's "must NOT mass armies at all (must
   * have constraints for this)".
   *
   * It is a food number rather than a unit count because that is the only cap that means the
   * same thing to every race: 12 food is six Footmen, or four Grunts, or six Archers. Enforced
   * where production is asked for (plus/plan.ts `armyBudget`), not at the wave — an AI that
   * builds twenty Grunts and attacks with six still owns twenty Grunts when you walk into its
   * base.
   */
  readonly armyFood: number;
  /**
   * Is `armyFood` a ceiling on the WHOLE army, or on the build order's mix alone?
   *
   * `army` spends the ceiling as a SHARE PER ROW of whatever the mix is right now, so every
   * soldier standing outside those rows is on top of it: the opening Footmen a tier-2 mix no
   * longer names, the siege (`siegeLine`), the undead's Obsidian Statues (`always`) and the
   * anti-air (`antiAir`) — every one of which asks for its bodies with no reference to the
   * ceiling. Measured over thirty headless minutes (tools/ai-plus-ladder-test.cjs) a Normal
   * computer with a 17-food ceiling stood on up to 31 food of soldiers, the most at the end of the
   * game, where each new tier had added its rows beside the last one's survivors (issue #210:
   * "build smaller armies even on late game"). With this on, those bodies are priced out of the
   * mix's budget instead, so the ceiling is the army.
   *
   * Normal only. Easy's twelve was tuned with the leftovers standing beside it ("eight proved
   * TOO easy"), and Insane's ceiling is upkeep, not a handicap.
   */
  readonly wholeArmyCeiling: boolean;
  /**
   * The game clock at which `armyFood` stops being a ceiling at all — from then on the army may
   * grow to the ENGINE's own food ceiling (`engineFoodCeiling`, 100 in The Frozen Throne), which
   * the workers already share. Infinity = never.
   *
   * Normal's, and the developer's: "remove the food cap after minute 25 for Computer+ Normal
   * difficulty. right now games tend to get stuck. we must unlock it after minute 25 so that
   * games can finish in all-out brawls." A twenty-food army is the right size against a newer
   * player in the first half of a game and the wrong one forty minutes in, when two maxed-out
   * bases trade waves that neither can push through. Applied where the plan reads its profile
   * (`liveProfile`), so every gate that is stated against the ceiling moves with it. OURS.
   */
  readonly unlockAt: number;
  /**
   * …and the army food a wave waits for from then on, in place of `attackFood`. The developer:
   * "late game waves should wait for a bit more food". With the ceiling off, a wave that still
   * left at twelve food walked out in a trickle of small groups while the army behind it grew,
   * which is the stuck game the unlock was meant to end, from the other side. OURS.
   */
  readonly lateAttackFood: number;
  /** Towers it will ever put up, across every town together (plan.ts `towers`). Easy builds
   *  none at all; Insane at most two — the developer's ceiling (it was four, all at home). */
  readonly towers: number;
  /**
   * SIEGE it keeps on the field once its second tier is standing — the race's own artillery
   * (`PlusRaceTable.siegeUnit`: Mortar Team, Demolisher, Meat Wagon, Glaive Thrower), ON TOP of
   * whatever the build order's mix asks for (plus/plan.ts `siegeLine`). OURS, and the number is
   * the developer's: "two demolishers or mortar teams or meat wagons or glaive throwers later
   * into the game would make a lot of sense" — only a few builds name a siege unit, so most
   * armies walked into a base full of towers with nothing that out-ranges them. Insane keeps
   * two, Normal one (it was two, until Normal was brought towards Easy); Easy stays on its
   * tier-1 soldiers.
   */
  readonly siegeUnits: number;
  /** How many heroes it fields. */
  readonly heroes: number;
  /** The highest hall tier it will build (1 Town Hall / 2 Keep / 3 Castle). Capping this is
   *  what keeps an easy computer on tier-1 units without a per-unit blacklist. */
  readonly techTier: number;
  /** The highest RANK of a repeatable upgrade (armour, weapons) it will research. */
  readonly upgradeRank: number;

  // --- fighting ---------------------------------------------------------------------------
  /** Seconds before the first wave may leave home, whatever it has built — the FLOOR of it. */
  readonly firstAttack: number;
  /**
   * …and how much LATER than that floor each seat's own first wave may be, rolled once per
   * seat off its own random stream (`Brain.firstAttackAt`, uniform in `[firstAttack,
   * firstAttack + firstAttackSpread]`). Reported of Easy: every Computer+ Easy player sat in its
   * base until seven minutes and then every one of them rushed out at once, which "feels very
   * scripted". The floor is the difficulty's promise not to attack early and it stays; the
   * spread is what stops four computers keeping the same clock. OURS, like every number here.
   */
  readonly firstAttackSpread: number;
  /** Quiet time between waves. */
  readonly waveGap: number;
  /**
   * …as a share of itself after a WON fight (`Brain.lastWon`): 0.5 = the next wave may leave
   * after half the gap. The developer's "more velocity between fights" — the army that just
   * beat theirs goes back out while the loser's heroes are still in the altar. 1 on Easy, which
   * is not meant to punish anybody. OURS.
   */
  readonly wonGap: number;
  /**
   * Army food that makes a wave.
   *
   * Kept at or below `CORE_ARMY_FOOD` (plus/plan.ts), which is the army the plan holds while it
   * is teching — so the AI fights with the army it has rather than waiting for the one it is
   * saving up for. Set it above that and the first wave lands only after the tier-up, the tech
   * buildings and the upgrades have all been paid for, which on a one-base map is most of the
   * game.
   */
  readonly attackFood: number;
  /**
   * …and how much bigger the wave gets per hall tier STANDING above the first: Insane's 16 at
   * tier 1 is 26 at tier 2 and 36 at tier 3. 0 on Easy and Normal, whose waves stay the size
   * their army ceilings were set for.
   *
   * The developer's *"make the Computer+ AI (Insane) MASS more units, it should go over 50 food
   * easily and build big armies"*. A flat 16 with a 30-second gap meant the army walked out the
   * moment it had sixteen food standing, every time, all game — so it never stood anywhere long
   * enough to BE big: what the barracks made, the next wave spent. A wave that grows with the
   * tier keeps the early pressure and lets the late army accumulate. Kept a little ABOVE the
   * core army a tier holds (plus/plan.ts `CORE_ARMY_FOOD` + `CORE_ARMY_PER_TIER`) on purpose:
   * Insane's own ceiling is the full `armyFood` row at the bottom of the ladder, and the gap
   * between the two is what the second and third production buildings fill
   * (`producersAtTier2`). OURS.
   */
  readonly attackFoodPerTier: number;
  /**
   * The bank, in gold, that buys each further copy of the main production building
   * (plus/plan.ts `extraCopies`), and how many copies there may ever be. The file's own 800 and
   * 3 on Easy and Normal; Insane spends sooner and on more, because a production building is
   * the only thing that turns income into soldiers any faster — one Barracks is one Footman at a
   * time however rich the player is. OURS.
   */
  readonly factoryGold: number;
  readonly factoryMax: number;
  /** Copies of the main production building held from TIER 2 whatever the bank says — 2 on
   *  Insane, the second Barracks every ladder player has up by the time the Keep lands; 1
   *  elsewhere (no floor). OURS. */
  readonly producersAtTier2: number;
  /** Group hit-point fraction that sends a wave home. 0 = it never retreats, which is what
   *  makes an easy computer's army feedable one clump at a time. */
  readonly retreatHp: number;
  /**
   * After the army FALLS BACK — a lost fight it walked or teleported out of, or a wave wiped
   * out to the last body — does the next wave wait for the WHOLE army again?
   *
   * Without it the only bar on the next wave is `attackFood`, and that is a bar the survivors
   * often already clear: the hero and two soldiers walk home, heal, `waveGap` runs out, and the
   * same broken party walks straight back into the fight that broke it. That is the developer's
   * report of the easy computer — "it re-attacks immediately after falling back" — and it reads
   * as a computer that has not noticed it lost. With this on, the latch set by the fall-back
   * holds every wave until the soldiers mustered at the rally point are the whole army the plan
   * is building (plus/plan.ts `armyTarget`), and the next wave to leave clears it.
   *
   * Easy only. The rungs above it already price a fight before they take it (`contactPass`,
   * `canClearCamp`) and pull out of one at `retreatHp`, so a wave they send back out has been
   * judged; the easy computer's is the one that has not.
   */
  readonly refill: boolean;
  /** Does the whole group pick ONE target and kill it? The clearest "this AI micros" tell. */
  readonly focusFire: boolean;
  /**
   * Hit-point fraction at which a unit standing in a fight is WALKED OUT of it. 0 = it never
   * is, which is Easy — and that is the whole of what the bottom rung gives up here.
   *
   * The other half of "this AI micros", and the half a player notices first: a Grunt on its
   * last quarter is one blow from being 200 gold spent on nothing, and pulling it behind the
   * line keeps the body — and the food it is standing in — in the game. It is a decision about
   * ONE unit, unlike `retreatHp`, which is the whole army leaving; the two are independent and
   * a wave that is winning still walks its wounded out one at a time.
   *
   * The threshold is the same at both rungs that have it, because "a quarter of my hit points"
   * is not a thing a better player knows more precisely — what a better player does is NOTICE
   * sooner, and that is `armyPeriod` (1.5 s against 0.5 s) rather than a second number here.
   *
   * See `PULL_BACK_DIST` / `PULL_BACK_HOLD` / `PULL_BACK_AGAIN` in plus/index.ts for how far
   * out, how long for, and the cooldown that stops the unit see-sawing in and out of the line.
   */
  readonly pullOutHp: number;
  /**
   * Does it STUTTER-STEP its ranged units? The player's micro between shots: the blow has gone
   * out, the weapon is cooling down, so the unit spends that dead time walking — away from a
   * melee unit that is on it, or after a target that is backing off — and is ordered back onto
   * its attack just before the weapon is ready (`stutterPass` in plus/index.ts). Insane only:
   * it is the same animation-cancelling that seat alone does (`SimWorld.cancelsBackswing`).
   */
  readonly stutterStep: boolean;
  /**
   * Does a RANGED soldier walked out of the line (`pullOutHp`) come back the moment it reaches
   * the spot it was sent to, rather than standing there for `PULL_BACK_HOLD`? The developer's
   * own ("ranged units that are microed away due to low health must rejoin the fight once they
   * have reached their kite destination"): an archer at a quarter of its life is a body that
   * still SHOOTS from 600 units out, and ten seconds stood behind the line is ten seconds of
   * damage the fight did not get. A melee unit has no such range to hide behind, so it keeps
   * the hold. Insane only — it is the attentive player's micro. See `pullPass`.
   */
  readonly pullRejoin: boolean;
  /**
   * Hit-point fraction under which a MELEE soldier is not stepped behind the line but sent all
   * the way HOME (`pullPass`) — the developer's 12 %: a Grunt that low dies to the first blow it
   * walks back into, and the base is where it heals (its regeneration, a Moon Well, a statue).
   * 0 = never, which is every rung but Insane.
   */
  readonly sendHomeHp: number;
  /**
   * Does it spend its DISPELS on enemy SUMMONS before anything else (`PlusCaster.dispelSummons`)?
   * A Water Elemental, a Lava Spawn or a pair of Spirit Wolves dies to one Dispel Magic, Purge,
   * Abolish Magic, Disenchant or Devour Magic (each handler damages or destroys a summon — see
   * sim/spells.ts), which is the cheapest kill on the field and the one a good player never
   * leaves standing. Insane only, per the developer.
   */
  readonly dispelSummons: boolean;
  /** Does it go and level its hero on creep camps? */
  readonly creeps: boolean;
  /**
   * Seconds before it will go creeping — its OWN clock, not `firstAttack`.
   *
   * This is the whole reason `creeps: true` used not to produce a computer that creeps.
   * Creeping was a rung of `pickTarget`, and `pickTarget` is only reached once the wave gates
   * have opened — `firstAttack` (then 300 s on Normal), `waveGap`, and `attackFood`. So a Normal
   * computer's first creep camp came at FIVE MINUTES, by which time a ladder player has three
   * camps and a level-4 hero, and its hero was still level 1 at the first fight.
   *
   * A creep camp is not an attack: it is the early game's other economy, it goes out with the
   * hero and a couple of units rather than with a wave, and it starts about when the hero
   * does. Hence a separate clock and a separate (much smaller) force — `creepFood`.
   */
  readonly creepAt: number;
  /** Army food that makes a creeping party, as `attackFood` is for a wave. Small on purpose:
   *  a hero and two soldiers clear a green camp, and waiting for a wave's worth is waiting
   *  until creeping is pointless. */
  readonly creepFood: number;
  /**
   * How many creep RUNS it will ever set off on (a run that is beaten counts too), the hardest
   * camp it will walk into (a level sum on plus/power.ts's own colour scale — `CAMP_GREEN_MAX`
   * is "green"), and how far from HOME a camp may be. Infinity for all three = creeping as the
   * rest of this file describes it.
   *
   * Easy's, and the developer's own: "let's make Computer+ Easy … also take/farm creep camps,
   * but only one to two green camps that are close to its base and that's it". So it is two
   * runs, green only, within the first ring of `CREEP_REACH` measured from its own town rather
   * than from wherever the party stands — a beginner's habit, not a route. OURS.
   */
  readonly creepCamps: number;
  readonly creepCampMax: number;
  readonly creepRange: number;
  /**
   * Seconds a party spends at HOME between one creep run and the next (`Brain.lastCreepEnd`),
   * and the game clock before which it takes GREEN camps only (`CAMP_GREEN_MAX`) whatever it
   * could price. 0 / 0 = straight on from camp to camp, any colour the party can take.
   *
   * Normal's, and the developer's: "slow down the Computer+ Normal difficulty's creeping as it
   * seems to be creeping both heroes to level 3 quite fast for newer players". Going camp to
   * camp with no pause, and into orange camps the moment the party priced them, is the route
   * a ladder player takes; a newer one walks home between camps and leaves the big ones for
   * later. OURS.
   */
  readonly creepRest: number;
  readonly creepGreenUntil: number;
  /**
   * How HUNGRY it is for the big camps — a multiplier on the party's price against the camp bars
   * (plus/power.ts `maxCampLevel`), and what makes it PREFER an orange or red camp over a green
   * one once it clears that harder bar with room to spare (`preferredCampFloor`), and keep taking
   * them past the level the hero stops wanting green ones at (index.ts `HUNGRY_UNTIL_LEVEL`).
   * 1 = priced as the bars say and nearest first. The developer's Insane: *"don't seem too keen
   * towards creeping orange and red camps, we must make them more hungry for them, especially as
   * their armies and hero levels grow"* — and Insane's own micro (focus fire, the pull-back, the
   * stutter step) is worth the margin. OURS.
   */
  readonly creepHunger: number;
  /** In an enemy base, does it turn on the WORKERS rather than whatever swung first? */
  readonly harass: boolean;
  /**
   * Does the army mass OUT ON THE MAP rather than in its base — walking a circuit of the free gold
   * mines on its own half while it waits for a camp it can take or a wave it can send (index.ts
   * `roamSpot`)? The developer's "always be on the move instead of sitting around in its base",
   * measured before it existed at 14–19 % of an Insane army's time after 2:00 spent massing at
   * home with nothing to do (no camp it could price, too small for a wave). Insane only: map
   * presence is a ladder player's habit, and the reinforcements walk out to it alone. OURS.
   */
  readonly roam: boolean;
  /**
   * The chance, per Mercenary Camp it clears the guards off, that it hires one or two of the
   * camp's mercenaries there and then (index.ts `mercPass`). 0 = never. The developer's Insane:
   * *"buy 1-2 mercenaries from a Mercenary Camp after clearing the creeps guarding it (not
   * always, but it would add some nice variation)"*. OURS.
   */
  readonly mercChance: number;
  /** Does it send an early scout? (Only matters for finding expansions — a melee player is
   *  handed every start location, see AiPlayer.knows.) */
  readonly scout: boolean;
  /**
   * Seconds between EXPANSION SWEEPS — a worker sent round the mines an opponent could have
   * taken, after the opening tour is over (`ComputerPlusAi.sweepPass`). Infinity = it never
   * looks again, which is Easy (it does not scout at all).
   *
   * The opening tour sees the enemy's MAIN, which every melee player is handed anyway; the one
   * thing worth walking a worker across the map for later is the hall that went up somewhere
   * the map promised nobody, and a player who has been here before checks the likely spots
   * every couple of minutes. Ours.
   */
  readonly sweepEvery: number;
  /**
   * The chance a wave with a known enemy EXPANSION to go at picks it over the main base. An
   * expansion is the soft target — a hall, a mine and few towers, a long walk for the defence —
   * and trading an army for the main is how a computer loses one. "Most of the time", per the
   * developer; ours.
   */
  readonly expansionFirst: number;

  // --- items (plus/items.ts) ----------------------------------------------------------------
  /**
   * How many of a hero's six inventory slots it will fill by SHOPPING. 0 = it never shops,
   * which is Easy: a novice knows the shop is there and forgets about it.
   *
   * A ceiling on the habit rather than on the wallet — `itemReserve` is the wallet — so the
   * difference between the top two rungs is that one of them keeps a full belt.
   */
  readonly shopping: number;
  /**
   * Does the belt keep MORE mana than the race's one Lesser Clarity Potion — a second one, and
   * a Potion of Mana (every race's shop stocks `pman` from tier 2: `[hvlt]`/`[ovln]`/`[eden]`/
   * `[utom] Makeitems`, gated by its own `Requires = TWN2`) — and swallow the instant one at
   * half a bar rather than a third (plus/items.ts `RACE_MANA_EAGER`, `MANA_LOW_EAGER`)?
   * Insane only: *"the Computer+ AI (Insane) must utilize mana potions from its shop a bit more
   * (for all races)"* (the developer). OURS.
   */
  readonly eagerMana: boolean;
  /**
   * Gold it will NOT spend on items.
   *
   * The gate docs/computer-plus.md warns about: item gold is gold `OneBuildLoop` was going to
   * spend, so a shopping list needs a place in the build ladder rather than a side budget. A
   * floor is that place expressed the only way a separate pass honestly can — the build loop
   * still gets first call on everything below it, and the shop only ever sees the surplus a
   * player would also be looking at. It is not a rung in the ladder, and it does not pretend
   * to be one: it is the surplus test, stated as a number.
   */
  readonly itemReserve: number;
  /**
   * Does it keep a Scroll of Town Portal on the hero, and REPLACE it as soon as it can?
   *
   * The clearest "this player has played before" tell there is, and the one item that changes
   * how a lost fight ends. It puts the scroll at the top of the shopping list rather than the
   * bottom, which is what makes the replacement prompt: the moment one is spent, the next
   * shopping trip buys another before it buys anything else.
   *
   * Off only on Easy, where nothing is bought at all.
   */
  readonly keepPortal: boolean;
  /**
   * Does it refuse to START a fight with a player while no hero carries a Town Portal?
   *
   * The developer's Insane rule: *"should avoid attacking/fighting an enemy as much as possible
   * if it doesn't own a scroll of town portal (as the attacker of course)"*. The scroll is how a
   * lost assault ends with the army alive, so an attack without one is the one this player does
   * not make. Only as the ATTACKER — a wave set off, or an ally's attack joined; a base being
   * defended, a fight already in the field and a creep camp are not gated (plus/index.ts
   * `portalHeld`). "As much as possible" is a deadline, not a lock (`PORTAL_WAIT`): a scroll
   * nobody can buy must not keep the army at home for the rest of the match.
   */
  readonly portalToAttack: boolean;

  // --- manners ------------------------------------------------------------------------------
  /**
   * How long the position has to be hopeless before it says gg and leaves. A weaker player
   * takes longer to accept it — the ORDERING is what carries the meaning here, not the
   * absolute values.
   *
   * All three came down twice, after the wait was reported as too long both times. The dwell is
   * a guard against a position that recovers, and `hopeless` is five clauses of "there is no
   * move from here" plus a weighed reading (`despair`) on top of them: a third of a minute of a
   * decided game is a third of a minute nobody wants to play, and every term of both readings
   * un-latches the moment the position recovers anyway. So the dwell is the only thing paying
   * for a position that was never lost, and it does not have to be long to do that — a defence
   * that holds, a revived hero or one soldier out of a Barracks resets it inside a second.
   */
  readonly concedeAfter: number;
}

/**
 * Computer+ (Easy) — "must essentially be able to be beaten by players who have played MOBAs"
 * (issue #124).
 *
 * The shape of it: it builds one barracks' worth of tier-1 soldiers, never expands, never puts
 * up a tower, never teches past its Town Hall, and takes seven minutes to come and find you
 * with its hero and about three soldiers — and once it has been beaten back it does not come
 * again until it has its whole army again (`refill`). It reacts to an attack on its base
 * fifteen seconds late, it never pulls a broken army out of a fight, and it never notices what
 * you are building. It is a player who knows the buttons and nothing else.
 *
 * `techTier` 1 also decides which BUILDS it can roll: a strategy that aims higher than the
 * difficulty can reach is not offered to it (`rollStrategy`), so an easy computer only ever
 * plays its race's simplest openings.
 */
export const PLUS_EASY: PlusProfile = {
  difficulty: MELEE_NEWBIE,
  buildPeriod: 3, armyPeriod: 3, castPeriod: 2, defendDelay: 15, castDelay: 2.5,
  // It aims like a new player: at whatever is biggest. This is the requested behaviour in one
  // line — an easy computer's Storm Bolt lands on the Tauren and its Death Coil on the
  // Abomination — and it is why its casters never feel like they are answering your army.
  castTargeting: "naive", castMistake: 0.35, heroFocus: 0.3,
  workers: 8, expansions: 0, expandDelay: 0,
  // It does not counter at all: an easy computer builds what it opened with, whatever walks
  // into its base. This is the single biggest thing the top two difficulties do that it doesn't.
  counterWeight: 0, counterSample: Infinity, counterShare: 1, counterMemory: 0,
  // Twelve food of soldiers, and a wave of ten. It was twelve and ten, then eight and six after
  // "builds kinda big armies for beginner players" — the ceiling is spent PER ROW of the mix, so
  // the opening Footmen a rifle build falls back on stay standing when the Riflemen come online
  // beside them. Eight then proved TOO easy to beat ("about 2 units more"), so it is back to two
  // more bodies than that: twelve is six Footmen or three Riflemen, and the wave (`squadFood`
  // counts the hero's five) is the hero and about three soldiers.
  armyFood: 12, wholeArmyCeiling: false, unlockAt: Infinity, lateAttackFood: 10, towers: 0, siegeUnits: 0, heroes: 1, techTier: 1, upgradeRank: 1,
  // Seven minutes at the EARLIEST, and each seat somewhere in the three after it
  // (`firstAttackSpread`) — so a table of Easy computers does not all leave home on one tick.
  firstAttack: 420, firstAttackSpread: 180, waveGap: 150, wonGap: 1, attackFood: 10, attackFoodPerTier: 0, retreatHp: 0, refill: true,
  factoryGold: 800, factoryMax: 3, producersAtTier2: 1,
  // It never shops, so the purse below never matters. It DOES creep now, and only a little:
  // from four minutes, with the hero and a soldier or two, at most TWO green camps near its own
  // base and then never again (`creepCamps`) — the developer's "only one to two green camps
  // that are close to its base and that's it".
  // …and it does NOT micro its wounded out of a fight — issue #124's Easy is a player who
  // gives an order and then watches it happen. `pullOutHp` 0 is that in one number.
  focusFire: false, pullOutHp: 0, stutterStep: false, pullRejoin: false, sendHomeHp: 0, dispelSummons: false, creeps: true, creepAt: 240, creepFood: 8,
  creepCamps: 2, creepCampMax: CAMP_GREEN_MAX, creepRange: 3000, creepRest: 0, creepGreenUntil: 0, creepHunger: 1,
  harass: false, roam: false, mercChance: 0, scout: false, sweepEvery: Infinity, expansionFirst: 0.5,
  shopping: 0, eagerMana: false, itemReserve: Infinity, keepPortal: false, portalToAttack: false,
  concedeAfter: 24,
};

/**
 * Computer+ (Normal) — "a bit of a faster reaction time and executes simple build orders, but
 * again, NO unit massing".
 *
 * Two heroes, the whole tech tree, one expansion, one tower, and an army it will actually pull
 * out of a lost fight. Twenty food is a real army and well under half of what the map can feed,
 * which is the line the brief draws — and it is the FOOD ceiling, not the tech ceiling, that
 * carries "no unit massing". It counters, but late and half-heartedly (see `counterWeight`), it
 * upgrades only two ranks deep, and it is three minutes later to expand.
 *
 * Brought DOWN towards Easy on the developer's report that the step from Easy was "quite a
 * massive difference … not very friendly for beginners". Nearly every dial had been nearer
 * Insane's value than Easy's, so the cut is in the numbers a beginner FEELS — the size of the
 * army, when it first arrives, how levelled and how equipped its hero is when it does, and how
 * hard the base is to break — and not in what makes Normal a different player rather than a
 * bigger Easy (two heroes, tier 3, the expansion, the wounded walked out of a fight).
 */
export const PLUS_NORMAL: PlusProfile = {
  difficulty: MELEE_NORMAL,
  // `defendDelay` 10, not the 6 it was: the beginner's raid gets a few more seconds in the base
  // before the army comes home — still a third less than Easy's fifteen.
  // `castPeriod` and `castDelay` 1.5, not 1: a hero presses one button per spell pass, so at
  // one pass a second two heroes had emptied both bars within a few seconds of contact — the
  // developer's "not so fast at casting all of their heroes' abilities (just a bit)". Half a
  // second more on each; Easy's 2 / 2.5 is still slower.
  buildPeriod: 2, armyPeriod: 1.5, castPeriod: 1.5, defendDelay: 10, castDelay: 1.5,
  // It knows what the units are and mostly aims at the right one, and misclicks about one
  // spell in seven. It does not price a spell's effect — a nuke goes on whoever is lowest
  // rather than on whoever it can finish.
  castTargeting: "sound", castMistake: 0.15, heroFocus: 0.7,
  workers: 11, expansions: 1, expandDelay: 180,
  // It counters, badly: it wants to have seen a dozen enemy units and half its army to be one
  // thing before it believes it, it only moves its mix a third of the way, and it forgets in a
  // minute and a half. That reads as a player who noticed late and over-corrected slightly.
  counterWeight: 0.35, counterSample: 12, counterShare: 0.4, counterMemory: 90,
  // TIER 3. It used to stop at a Keep, which is a bigger handicap than it reads as: `techTier`
  // is also the filter on which BUILDS may be rolled (`rollStrategy`), so a tier-2 ceiling shut
  // a Normal computer out of most of its race's table — no Knights, no Bears, no Frost Wyrms,
  // no Tauren — and left it playing two or three openings for ever. A Normal player reaches
  // tier 3; they just take longer over it and stop short of the whole tree, which is what
  // `upgradeRank` and the clocks above already say.
  // 20 food: it was 30, then 26 on "reduce the target army size … by 1-2 units", and then 20
  // when the whole rung was brought towards Easy (see above) — 26 was more than twice Easy's
  // twelve, and the army is the first thing a beginner measures themselves against. Twenty is
  // ten Footmen or five Grunts, between Easy's ceiling and the old one. One tower and one siege
  // unit for the same reason: a base with two towers and two Demolishers behind the army is a
  // base a beginner's tier-1 push cannot break, and Insane keeps the developer's two.
  // …and 17 after "a little bit of a smaller army (just a little less)": one or two bodies off
  // the ceiling, still above `CORE_ARMY_FOOD` (16, plus/plan.ts) so the floor the plan keeps
  // while it saves is not cut with it, and above the twelve-food wave.
  // …and then 20 that is the WHOLE army (`wholeArmyCeiling`, issue #210): 17 was a ceiling on
  // the current mix alone, and the late game stood on 12–31 food of soldiers (20.9 on average
  // at thirty minutes, ten headless builds over the ceiling). Counted whole, 20 holds the same
  // average army a beginner already met — 22.4 — but stops the tail (17–34), and nothing past
  // the mix's leftovers is ever bought on top of it again. 22 was measured too and was the
  // bigger army of the two at every minute (23.9, up to 36), so not the one the issue asks for.
  // …and 18 on "reduce the target army size (excluding heroes) by 2 food": one Footman off the
  // whole army. The ceiling prices soldiers only (`armyTarget`), while the plan's own gates
  // (`TIER3_ARMY` 20, `TECH_AFTER` 24) read `PlusCtx.armyFood`, which counts the heroes' food
  // too — so 18 soldiers beside a tier-2 Normal's two heroes still clear every one of them.
  // …and 17 on "reduce the target army of the Normal Computer+ AI by one food": still above
  // `CORE_ARMY_FOOD` (16), so the floor the plan keeps while it saves is untouched, and 17 plus
  // two heroes' ten still clears `TIER3_ARMY` and `TECH_AFTER`.
  armyFood: 17, wholeArmyCeiling: true, unlockAt: 1500, lateAttackFood: 30, towers: 1, siegeUnits: 1, heroes: 2, techTier: 3, upgradeRank: 2,
  // Six minutes at the earliest and each seat somewhere in the two after it — it was five on the
  // dot, which is both two minutes sooner than Easy and the "every computer leaves on one tick"
  // habit `firstAttackSpread` was added to Easy to cure. A wave of twelve (the hero's five on top)
  // and two minutes between waves rather than a minute and a half.
  firstAttack: 360, firstAttackSpread: 120, waveGap: 120, wonGap: 0.5, attackFood: 12, attackFoodPerTier: 0, retreatHp: 0.35, refill: false,
  factoryGold: 800, factoryMax: 3, producersAtTier2: 1,
  // Creeps from FIVE minutes with the hero and ten food behind it — about a hero, a couple of
  // soldiers and whatever else is standing around, which is what clears a green camp. It was two
  // and a half, and that was most of the gap to Easy on its own: a hero creeping from 2:30 met
  // the first fight at level 3–4 with a belt of potions, against an Easy hero still at level 1.
  // Then four, and still "creeping both heroes to level 3 quite fast for newer players" — so it
  // is five, with a minute at home between camps (`creepRest`) and green camps only until seven
  // minutes (`creepGreenUntil`).
  // It does not focus-fire, but it DOES pull a soldier out of the line at a quarter health —
  // the one piece of micro a player picks up long before they learn to focus a target.
  focusFire: false, pullOutHp: 0.25, stutterStep: false, pullRejoin: false, sendHomeHp: 0, dispelSummons: false, creeps: true, creepAt: 300, creepFood: 10,
  creepCamps: Infinity, creepCampMax: Infinity, creepRange: Infinity, creepRest: 60, creepGreenUntil: 420, creepHunger: 1,
  harass: false, roam: false, mercChance: 0, scout: true, sweepEvery: 120, expansionFirst: 0.75,
  // A third of a belt, and it keeps 500 gold back for the build order. It DOES keep a Town
  // Portal and replace it: a scroll is the difference between losing a fight and losing an army,
  // and a player at this level has learnt that much.
  //
  // Two, down from four, when the rung was brought towards Easy. This number is a ceiling on the
  // habit and it is counted against everything the hero is holding, so two slots is the race's
  // opening (`RACE_FIRST`) and little else: the MANA row behind it, which the fourth slot was
  // added for, is no longer reached here — a hero with a shorter bar is the point. What it does
  // not touch is `ESSENTIAL` (plus/items.ts) — the Town Portal, the Potion of Healing and the two
  // fight items are bought past the ceiling — so the belt is thinner, not empty. Insane keeps
  // the full six.
  shopping: 2, eagerMana: false, itemReserve: 500, keepPortal: true, portalToAttack: false,
  concedeAfter: 14,
};

/**
 * Computer+ (Insane) — "should play as well as possible with little reaction times and it must
 * execute build orders fairly well".
 *
 * No artificial ceiling anywhere: it takes the whole tech tree, expands on its build order's
 * own clock, creeps its heroes up, focus-fires, retreats, goes for workers in your base, reads
 * your army composition and rebuilds against it, and thinks four times a second. `armyFood` is `UPKEEP_TIER2` rather than Infinity because that is where the
 * game itself says an army stops paying for itself — an AI that ignored upkeep would be
 * playing worse, not better.
 */
export const PLUS_INSANE: PlusProfile = {
  difficulty: MELEE_INSANE,
  buildPeriod: 1, armyPeriod: 0.5, castPeriod: 0.35, defendDelay: 1, castDelay: 0,
  // The whole ladder: kill shots, damage-per-second, and the game's own `herodur1` — so it
  // saves the Hex for the Shaman rather than spending it on a hero that eats a third of it.
  castTargeting: "expert", castMistake: 0, heroFocus: 1,
  workers: 14, expansions: 3, expandDelay: 0,
  // Full countering, off a small sample and a long memory: six units and a quarter of them one
  // type is enough to start shifting, and it remembers what it saw four minutes ago.
  counterWeight: 1, counterSample: 6, counterShare: 0.25, counterMemory: 240,
  armyFood: UPKEEP_TIER2, wholeArmyCeiling: false, unlockAt: Infinity, lateAttackFood: 16, towers: 2, siegeUnits: 2, heroes: 3, techTier: 3, upgradeRank: 3,
  // Half a minute of `firstAttackSpread` — it was none, so two Insane computers left home on the
  // same tick at 2:30 every game ("attack each other at the same moment").
  firstAttack: 150, firstAttackSpread: 30, waveGap: 30, wonGap: 0.5, attackFood: 16, attackFoodPerTier: 10, retreatHp: 0.4, refill: false,
  // Two Barracks from the Keep whatever the bank, and up to FOUR off it — see `factoryGold`. (A
  // cheaper copy, 500, bought the second one at TIER 1 and starved the hero and the Stronghold.)
  factoryGold: 800, factoryMax: 4, producersAtTier2: 2,
  // Creeping starts at ninety seconds with the hero and eight food — the ladder's own answer,
  // which is "as soon as the hero walks out of the altar".
  // …and its wounded are micro'd both ways from there: an archer is back in the fight the moment
  // it reaches the spot it was walked to, and a melee soldier under 12 % goes home to heal
  // instead (`pullRejoin` / `sendHomeHp`, the developer's numbers). It also kills summons with
  // its dispels first (`dispelSummons`).
  focusFire: true, pullOutHp: 0.25, stutterStep: true, pullRejoin: true, sendHomeHp: 0.12, dispelSummons: true, creeps: true, creepAt: 90, creepFood: 8,
  creepCamps: Infinity, creepCampMax: Infinity, creepRange: Infinity, creepRest: 0, creepGreenUntil: 0, creepHunger: 1.2,
  harass: true, roam: true, mercChance: 0.5, scout: true, sweepEvery: 75, expansionFirst: 0.85,
  // A full belt and a Town Portal on the hero. Both are what separates a player who has been
  // here before from one who has not.
  shopping: 6, eagerMana: true, itemReserve: 200, keepPortal: true, portalToAttack: true,
  concedeAfter: 8,
};

/** The profile a lobby difficulty seats. Anything unrecognised plays Normal, which is what
 *  every seat was before the menu offered three. */
export function plusProfile(difficulty: number): PlusProfile {
  return difficulty === MELEE_NEWBIE ? PLUS_EASY : difficulty === MELEE_INSANE ? PLUS_INSANE : PLUS_NORMAL;
}

/**
 * The profile as the plan (and the wave gate) should read it at `clock` — `profile` itself, or,
 * from `PlusProfile.unlockAt` on, the same profile with its army ceiling lifted to the engine's
 * own food ceiling and its waves waiting for `lateAttackFood`. A new object only once unlocked; before then the seat's own profile, unchanged.
 */
export function liveProfile(profile: PlusProfile, clock: number): PlusProfile {
  if (clock < profile.unlockAt) return profile;
  return {
    ...profile,
    armyFood: Math.max(profile.armyFood, engineFoodCeiling()),
    attackFood: Math.max(profile.attackFood, profile.lateAttackFood),
  };
}
