import { MELEE } from "../../data/gameplayConstants";
import type { ChatLine, ChatScope } from "../../game/chat";
import type { PlayableRace } from "../../data/races";
import type { UnitDef } from "../../data/units";
import { ITEM_REGEN_GROUP, isOffField, type SimUnit } from "../../sim/world";
import { simProfile, perfNow } from "../../sim/profile";
import { AiPlayer, type AiHost, REGROUP_HP_FRACTION, TOWN_RADIUS } from "../aiPlayer";
import { PlusCaster } from "./casting";
import { EnemyMemory, counterScore, type EnemyRead } from "./counter";
import {
  CONCEDE_NOT_BEFORE, CONCESSIONS, GREETINGS, GREET_AT, GREET_SPREAD, GREET_STAGGER, LEAVE_AFTER,
  hopeless,
  type Standing,
} from "./chatter";
import { PlusItems, type ItemCtx } from "./items";
import { LUMBER_FLOOR, buildPlan, buildableMix, harvestPlan, type PlusCtx } from "./plan";
import {
  BUSY_LINES, COMING_LINES, COUNTER_TELL, HELP_ANSWER_GAP, HELP_ANSWER_STAGGER, HELP_CALLS,
  HELP_CALL_FOES, HELP_CALL_GAP, HELP_CLEAR, HELP_GRACE, HELP_TIMEOUT, OPENER_AT, OPENER_UNITS,
  PORTAL_LINES, PORTAL_WALK, SWITCH_MARGIN, TALK_GAP, openerLine, readAllyCall, switchLine,
  type SwitchReason,
} from "./teamchat";
import { plusProfile, type PlusProfile } from "./profile";
import { aimCtx, heroKillable, killValue } from "./targeting";
import { PLUS_RACES, rollStrategy, type PlusRaceTable, type PlusStrategy } from "./races";
import { CAMP_GREEN_MAX, armyPower, maxCampLevel, type CreepForce, type Fighter } from "./power";

// Computer+ — the improved melee AI (issue #124). Start at docs/computer-plus.md.
//
// **What this is, next to `src/ai/index.ts`.** The classic melee AI is Blizzard's own, ported:
// four race scripts on `common.ai`'s library on ~150 engine natives (docs/melee-ai.md). This is
// a DIFFERENT PLAYER sitting at the same controls. It reuses the bottom two layers — `AiPlayer`
// is the library and the natives, and it is race-neutral bookkeeping (a census, a build array,
// placement, a harvest plan, hero skills) rather than a strategy — and replaces everything
// above them: which build it is playing and what that build wants (plus/races.ts + plus/plan.ts),
// how hard to play (plus/profile.ts), how to answer what the enemy turns out to be fielding
// (plus/counter.ts), when to cast (plus/casting.ts), and what to say (plus/chatter.ts for the
// manners, plus/teamchat.ts for a TEAM game — what it tells its allies, and what it does when
// one of them asks it for help).
//
// **What AMAI contributed.** AMAI (github.com/SMUnlimited/AMAI) is GPL and ships as JASS inside
// a map; it was STUDIED and never copied, which is the standing rule in CLAUDE.md. Two of its
// ideas are here, both as shapes rather than as data: a race owns a weighted TABLE of named
// builds and each build carries its own expansion clock (plus/races.ts), and a beaten AI says
// so and leaves (plus/chatter.ts). Its personality profiles are deliberately not — issue #124
// rules them out.
//
// **It never touches the classic AI.** `MeleeAi` and `ComputerPlusAi` are two objects with no
// shared mutable state; `RtsController` seats a slot in exactly one of them, per seat, so a
// match can even hold both. Nothing in `src/ai/*.ts` imports anything from `src/ai/plus/`.
//
// **And it does not cheat, at any difficulty.** The two advantages the classic INSANE computer
// gets are engine cheats rather than skill — it is credited twice what its workers carry home,
// and it is told what is behind the fog — and Computer+ takes neither (`AiPlayer.bypassFog` is
// switched off here, and `RtsController.startMeleeAIFor` withholds the harvest bonus). Every
// difference between its three difficulties is a number in `PlusProfile`.
//
// **Where it runs, and why it cannot cheat even by accident.** Authority-side only, driven from
// `RtsController.tick` inside the branch a frozen LAN client never enters, and every decision
// leaves as a `Command` through `RtsController.execute` — the same door, and the same
// ownership/cost/tech/food judgement, a human player's click gets.

/** What the brain needs beyond the ordinary AI host: a voice, and a way out of the game. */
export interface PlusHost extends AiHost {
  /**
   * Say something. Routed exactly like a human player's chat (see plus/chatter.ts) — there is
   * no second channel for computers.
   *
   * The SCOPE is the ordinary chat channel and means what the two send keys mean: "all" is
   * Enter, "allies" is Ctrl+Enter. Manners are said to everybody (a gg is for the person who
   * beat you); everything in plus/teamchat.ts is said to allies, because that is who it is
   * about and because a computer announcing its build to the enemy would be scouting them for
   * free. Defaults to "all", so the two lines that predate teams are unchanged.
   */
  say(player: number, text: string, scope?: ChatScope): void;
  /**
   * Leave the game — the ORDINARY player-left path, `EVENT_PLAYER_LEAVE`, which the map's own
   * melee script is already listening for.
   *
   * This is the answer to the one thing issue #124 asks us NOT to copy from AMAI: "when the AI
   * leaves it destroys its buildings, which shouldn't be happening in our case". AMAI has no
   * choice — it ships as JASS inside a map, and a script's only way to end its own player is to
   * satisfy the defeat condition, which is "your team owns no structures". We are not
   * constrained that way, because the engine is ours: raising the event runs Blizzard's own
   * `MeleeTriggerActionPlayerLeft`, which hands the units to Neutral Passive
   * (`MakeUnitsPassiveForTeam`) and calls `MeleeDoLeave`. Nothing is destroyed, and the
   * remaining player is declared the winner by the map's own victory check rather than by us.
   */
  leave(player: number): void;
  /**
   * EVERY PLAYING SEAT'S START LOCATION — the lobby's, not the fog's.
   *
   * Map data, exactly as the creep camps are, and gated by nothing: "every melee player is
   * handed the start locations — that is what a melee map's start locations ARE" is already
   * the rule `AiPlayer.knows` states for the enemy's main base, and the classic AI's waves
   * have always walked to them. So reading them here is not a fog bypass; it is the same fact
   * the minimap prints for a person before the match starts.
   *
   * The SCOUT is what wants them (`scoutWaypoint`). A gold mine is a guarded expansion and a
   * building is wherever that player happened to put it; a start location is the one point on
   * the map that names an opponent's base before anybody has looked at it, and it is what a
   * person sends their first worker at.
   */
  startLocations(): ReadonlyArray<{ player: number; x: number; y: number }>;
}

/** How often the manners pass runs — greeting, conceding, leaving. Cheap, and none of it is
 *  time-critical, so it does not need the profile's reaction clock. */
const MANNERS_PERIOD = 1;

/** How often an attacking squad re-states its order to a member that has drifted. */
const REISSUE_PERIOD = 4;
/** How far the wave's objective must have DRIFTED before re-stating the order is worth a
 *  fresh search — see `commit`. Four pathing cells: a building's width, and below the
 *  REPATH_LOOKAHEAD (five cells) at which the sim itself decides a route has gone stale. */
const REISSUE_SLACK = 128;

/**
 * How far in front of the base the army waits.
 *
 * Small, and it has to be. A muster point a long way out towards the enemy is a muster point
 * on top of whatever creep camp sits between the two bases: an earlier value of half the town
 * radius walked an insane orc's Grunts into a camp one at a time as they were trained, and its
 * army SHRANK across the fourth and fifth minutes. Far enough to read as a defensive stance,
 * well inside the base's own radius. (The classic captain musters at home for the same reason.)
 */
const RALLY_OUT = 300;
/** …and how close to that spot counts as "there". */
const RALLY_SLACK = 320;

/** A wave is over when the group is standing on its objective and nothing hostile is within
 *  this of it. */
const CLEARED_RADIUS = 900;
/** How far a unit broken off a healthy hero will look for something else to hit. Deliberately
 *  short: the point is to swing at what is standing in this fight, not to go and find a better
 *  one somewhere else. */
const SWAP_LOOK = 700;

/**
 * How far from the group a HEALTHY enemy hero may be and still be worth focusing.
 *
 * The anti-chase rule (`focusTarget`). A hero standing in the fight is a target like any other
 * and the ladder prices it (plus/targeting.ts); a hero that has walked out of it is bait, and
 * following it is exactly how Blizzard's own melee AI loses armies. About a screen's width at
 * the game's own camera — close enough that the group is still fighting the same fight.
 * A hero it can actually FINISH is exempt: that walk is worth taking.
 */
const HERO_CHASE = 700;

/** When the scout goes out, and how close to a waypoint counts as having looked at it. */
const SCOUT_AT = 60;
const SCOUT_ARRIVED = 400;
/**
 * How far off the enemy's town CENTRE the scout stops.
 *
 * A scout looks at a base; it does not walk into one. Two things this has to be measured
 * from, and getting either wrong is what put a worker in the middle of somebody's army:
 *
 *  • The CENTRE, which is the enemy's START LOCATION (`scoutWaypoint`) and not the enemy
 *    building nearest to us. `enemyBase()` hands back whatever structure is closest to OUR
 *    home — the near EDGE of the base, or a tower they put up facing us — so a ring drawn
 *    round it is a ring drawn round the doorstep: the stop on our own bearing is genuinely
 *    outside, and the two beside it are 900 from an edge building and therefore well INSIDE
 *    the base. That is the reported "the scout walks too deep and dies", and it is geometry
 *    rather than tuning. A start location does not move and does not depend on what the
 *    enemy has built.
 *  • Far enough out to be outside the base, near enough in to SEE it. A worker's sight is
 *    800 by day and 600 by night (UnitBalance.slk `sight`/`nsight`; a Wisp's is 1000/750) —
 *    NOT the 1400 an earlier comment here claimed — so a stop has to be about a base radius
 *    out, not a screen. A melee main's buildings sprawl to roughly 600-1000 from the hall
 *    (`AiPlayer`'s own placement rings), so from 1000 the scout stands at the edge of the
 *    sprawl with its near half inside its own eyes, and the tech is read off the buildings
 *    it can see rather than off the hall it cannot reach.
 *
 * It is also what a player does, and for the same reason.
 */
const SCOUT_STANDOFF = 1000;
/**
 * Radians between the stops it makes AROUND the base. Roughly 40 degrees, so three stops
 * sweep an arc of about 80 and the base is looked at from three angles on the side the scout
 * arrived from.
 *
 * NARROW on purpose. At 1.1 (63 degrees each way) the three stops spanned 126 degrees, which
 * is not a look from three sides — it is a lap, and a melee main sits on a plateau with one
 * ramp, so the walk from one stop to the next is routed by the pathfinder straight back
 * through the base it was standing off. Keeping the sweep on the approach side means every
 * leg of the tour is a walk the scout can make without crossing the enemy's front door.
 */
const SCOUT_ARC = 0.7;
/** Stops on the standoff ring before the tour moves on to the OTHER start locations. */
export const SCOUT_RING_LEGS = 3;

/**
 * Where leg `leg` of the ring puts the scout: a point `SCOUT_STANDOFF` from the enemy town
 * centre, never the centre itself.
 *
 * The first stop is on the bearing the scout is already coming from (our home), because that is
 * the side it reaches first and walking round to a far side to begin is a walk past the whole
 * base. The next two step off it by `SCOUT_ARC` either way, so the base is looked at from three
 * angles on that same side and the scout is never inside it — and never behind it either, which
 * is a walk through it on every map whose main sits on a plateau with one ramp.
 *
 * `base` is the enemy's START LOCATION (`scoutWaypoint`), which is what makes the ring mean
 * "outside the base": drawn round the enemy building nearest to US, which is what this used to
 * be handed, the two side stops sit 900 from the near EDGE and therefore inside the base.
 *
 * Pure, and exported, so the one thing that actually matters about it — that every stop is
 * OUTSIDE the base — is pinned by a test rather than by reading it (tools/ai-plus-items-test).
 */
export function scoutRing(
  base: { x: number; y: number },
  home: { x: number; y: number },
  leg: number,
): { x: number; y: number } {
  const approach = Math.atan2(home.y - base.y, home.x - base.x);
  const a = approach + (leg === 0 ? 0 : leg === 1 ? SCOUT_ARC : -SCOUT_ARC);
  return { x: base.x + Math.cos(a) * SCOUT_STANDOFF, y: base.y + Math.sin(a) * SCOUT_STANDOFF };
}
/**
 * HOW OFTEN THE SCOUT IS THOUGHT ABOUT — its own clock, not the army's.
 *
 * This used to run inside `armyPass`, whose period is the difficulty's reaction time:
 * three seconds on Easy, 1.5 on Normal. A worker walks 190-350 a second, so on Easy the
 * route was re-asked once every 600-1000 units of walking — wider than `CREEP_BERTH`
 * itself. Every arc round a camp was therefore decided once and then walked blind, which is
 * exactly the "it still aggroes creep camps sometimes" report: the berth was never wrong,
 * it was simply not being re-asked while the scout crossed it.
 *
 * One unit, one waypoint and one distance check, so it is cheap enough to ask twice a second
 * whatever the difficulty — and the difficulty has no business in it anyway. An easy computer
 * reacts to an ATTACK slowly; it does not walk into trees more often.
 */
const SCOUT_PERIOD = 0.5;

/**
 * HOW CLOSE SOMETHING THAT SHOOTS MAY COME BEFORE THE TOUR IS OVER.
 *
 * The other half of "it goes too deep and dies", and the half no amount of geometry fixes: a
 * standoff ring says where the scout MEANT to stand, and an army that walks out to meet it or
 * a tower that goes up while it is looking says where it actually is. A person pulls the
 * worker out the moment either happens; nothing in the tour did.
 *
 * Just outside a worker's own daylight sight (800, UnitBalance.slk `sight`), so this fires on
 * things the scout can genuinely see rather than on things the player happens to have eyes on
 * elsewhere — and comfortably outside the reach of everything that could kill it in the open.
 */
const SCOUT_DANGER = 700;

/**
 * HOW WIDE THE SCOUT GIVES A CREEP A BERTH.
 *
 * A scout is one worker with no escort, and a melee map's creep camps sit on exactly the ground
 * between two bases — so the straight line from home to the enemy's front door usually runs
 * through one or two of them. It walked into them, got acquired, and died; and because a lost
 * scout LATCHES (`Brain.scoutDone` — nobody follows it), that one walk was the whole of what the
 * AI ever learnt about the map.
 *
 * Bigger than the creeps' own acquisition range (`MiscGame` AcquisitionRange is 500, and a guard
 * chases `GuardDistance` past it) so that passing outside this is passing outside their notice
 * rather than merely outside their reach. It also has to cover the ~1s between passes: this is
 * re-asked once per `armyPeriod` and a worker walks 190-350 of it in that time.
 *
 * Measured from EVERY LIVE CREEP, never from a camp's centre — see `ComputerPlusAi.safeStep`.
 */
const CREEP_BERTH = 900;
/** Extra margin thrown into a detour past what merely clearing the creep needs, so the arc is a
 *  walk round rather than a graze. Widened a step at a time — see `safeLeg`. */
const CREEP_DETOUR = 450;
/** How many widths of detour are tried, each side, before the best of them is taken. */
const DETOUR_TRIES = 4;

/** How near `p` comes to the SEGMENT `from`→`to` — the question "does this leg pass it". */
function gapToLeg(
  from: { x: number; y: number },
  to: { x: number; y: number },
  p: { x: number; y: number },
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return Math.hypot(p.x - from.x, p.y - from.y);
  const t = Math.max(0, Math.min(1, ((p.x - from.x) * dx + (p.y - from.y) * dy) / len2));
  return Math.hypot(from.x + dx * t - p.x, from.y + dy * t - p.y);
}

/** How near the WORST creep comes to this leg. `Infinity` when there are none. */
function clearance(
  from: { x: number; y: number },
  to: { x: number; y: number },
  creeps: ReadonlyArray<{ x: number; y: number }>,
): number {
  let worst = Infinity;
  for (const c of creeps) worst = Math.min(worst, gapToLeg(from, to, c));
  return worst;
}

/**
 * `to` pulled back along the approach until it is outside every creep's berth — or `to` itself
 * when it already is.
 *
 * This is the half of the problem the old routine did not have at all, and it is where scouts
 * actually died. It only ever looked at camps the line ran PAST (`along >= len` was skipped), so
 * a waypoint that was ITSELF inside a camp was walked straight to — and the tour's later legs
 * used to be GOLD MINES, every one of which a melee map guards, so the scout was aimed at the
 * middle of the camp guarding the expansion, every game. (Those legs are now the other START
 * LOCATIONS, which nothing guards — see `scoutWaypoint` — but this still earns its place: a
 * base whose owner has walled a camp in, and a mine the ARMY is sent to, are the same case.)
 *
 * Standing off instead is what a player does. It costs the tour some of the look rather than
 * none of it — a worker sees 800 by day and 600 by night (UnitBalance.slk `sight`/`nsight`;
 * a Wisp 1000/750), so from the edge of a 900 berth the camp itself is a step beyond its
 * eyes — and that trade is the right way round: the whole point of the leg is the ground it
 * is standing on being denied, which it has now learnt without dying to learn it.
 */
function standOff(
  from: { x: number; y: number },
  to: { x: number; y: number },
  creeps: ReadonlyArray<{ x: number; y: number }>,
  berth: number,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return to;
  const ux = dx / len;
  const uy = dy / len;
  let stop = len;
  for (const c of creeps) {
    if (Math.hypot(c.x - to.x, c.y - to.y) >= berth) continue; // the destination is not in this one
    const along = (c.x - from.x) * ux + (c.y - from.y) * uy;
    const side = (c.x - from.x) * -uy + (c.y - from.y) * ux;
    const gap = Math.abs(side);
    if (gap >= berth) continue; // can't happen while `to` is inside it, but the sqrt below needs it
    // Where the line first crosses this creep's berth. Negative when `from` is ALREADY inside
    // it, which clamps to "do not move" below — and that is the right answer: this is as close
    // as the leg may be approached, so there is nothing further to walk towards.
    stop = Math.min(stop, along - Math.sqrt(berth * berth - gap * gap));
  }
  if (stop >= len) return to;
  stop = Math.max(0, stop);
  return { x: from.x + ux * stop, y: from.y + uy * stop };
}

/** The first creep the line `from`→`to` walks inside the berth of, in `(along, side)` terms. */
function firstBlocker(
  from: { x: number; y: number },
  to: { x: number; y: number },
  creeps: ReadonlyArray<{ x: number; y: number }>,
  berth: number,
): { along: number; side: number; gap: number } | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  let worst: { along: number; side: number; gap: number } | null = null;
  for (const c of creeps) {
    // Where the creep falls along the line, and how far off it — the ordinary point-to-segment
    // decomposition. One BEHIND us or beyond the destination is not on the way.
    const along = (c.x - from.x) * ux + (c.y - from.y) * uy;
    if (along <= 0 || along >= len) continue;
    const side = (c.x - from.x) * -uy + (c.y - from.y) * ux;
    const gap = Math.abs(side);
    if (gap >= berth) continue;
    if (!worst || along < worst.along) worst = { along, side, gap };
  }
  return worst;
}

/** The waypoint thrown out to `away`'s side of the line `from`→`to`, level with `worst`. */
function thrown(
  from: { x: number; y: number },
  to: { x: number; y: number },
  worst: { along: number; side: number; gap: number },
  away: number,
  push: number,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x: from.x + ux * worst.along + -uy * away * push,
    y: from.y + uy * worst.along + ux * away * push,
  };
}

/**
 * A waypoint on the way to `to` that does NOT walk into a creep's notice, or `to` itself when
 * the straight line is already clear.
 *
 * The route is re-asked at every step (`scoutPass` orders one leg at a time and re-issues on
 * arrival), so this does not have to be a path — it has to be a next STEP that is not into a
 * camp, and the pathfinder does the rest.
 *
 * Three things it does, in the order they matter:
 *
 *  1. **The destination is stood off** when it is itself inside a camp — see `standOff`. That is
 *     the case the old routine ignored, and the tour's gold-mine legs are all of them. Asked of
 *     EVERY creep, including one already on top of us: standing still is then the honest answer
 *     to "how much closer may I get", and `ComputerPlusAi.lookedAt` reads it as exactly that.
 *  2. **Creeps already this close are not the DETOUR's problem.** A creep within the berth of
 *     where we are standing has seen us or is about to; no arc changes that, and leaving them
 *     in would make every candidate below score equally badly and cancel the detour outright.
 *  3. **Then it goes round.** The creep that matters is the FIRST one the line runs near, since
 *     clearing it changes where everything after it lies; the detour is thrown out perpendicular
 *     to the line, preferring the side the creep is not on. The throw is then WIDENED a step at
 *     a time and the resulting leg is re-measured against every creep, because a single fixed
 *     push only ever cleared the one creep it was computed from — with the camp's other four
 *     standing 600 either side of it (`CAMP_LINK`, minimapView.ts), the arc that missed the
 *     centre walked into a flank. Both sides are tried at each width, so a camp against a cliff
 *     is passed on the open side rather than on the geometrically prettier one.
 *
 * Pure, and exported, for the same reason `scoutRing` is: what actually matters about it — that
 * the leg it hands back clears every creep it was given — is then pinned by a test rather than
 * by reading it (tools/ai-plus-army-test.cjs).
 */
export function safeLeg(
  from: { x: number; y: number },
  to: { x: number; y: number },
  creeps: ReadonlyArray<{ x: number; y: number }>,
  berth = CREEP_BERTH,
  detour = CREEP_DETOUR,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1) return to;
  // (1)
  const goal = standOff(from, to, creeps, berth);
  // (2) — anything already inside the berth of where we stand is not avoidable from here.
  const ahead = creeps.filter((c) => Math.hypot(c.x - from.x, c.y - from.y) >= berth);
  // (3)
  const worst = firstBlocker(from, goal, ahead, berth);
  if (!worst) return goal;
  const sides = worst.side > 0 ? [-1, 1] : [1, -1];
  let best = goal;
  let bestGap = clearance(from, goal, ahead);
  for (let step = 1; step <= DETOUR_TRIES; step++) {
    const push = berth - worst.gap + detour * step;
    for (const away of sides) {
      const aim = thrown(from, goal, worst, away, push);
      const gap = clearance(from, aim, ahead);
      if (gap >= berth) return aim; // clears everything: nothing wider to look for
      if (gap > bestGap) { bestGap = gap; best = aim; }
    }
  }
  return best;
}

/**
 * Is this worker on GOLD — asked the way each race actually answers it, and NOT the way three
 * of the four happen to make easy.
 *
 * Three races put the worker inside something: a Peasant and a Peon go down the shaft
 * (`inMine`) and a Wisp climbs inside an Entangled Gold Mine (a garrison). `isOffField` covers
 * all of those, which is why "the first worker still standing on the field" used to be a
 * perfectly good way to find a lumberjack.
 *
 * **The undead breaks it.** An Acolyte does not go anywhere — it kneels in a ring in the OPEN
 * around a Haunted Gold Mine (`Abgm`, docs/undead.md), holding a mark in that mine's own ring
 * (`SimWorld.tickRingHarvest`), and is therefore on the field by every test `isOffField` has.
 * `ringSlot` is the fact that says so, and asking it is the whole difference between the scout
 * being the spare Acolyte the build ladder trained for the job and the scout being a fifth of
 * the undead's entire income.
 *
 * The harvest ORDER is the third clause and it catches everybody, in the moment between being
 * sent to a mine and arriving at it.
 *
 * Pure and exported for the same reason `scoutRing` is: this is a trap that is invisible from
 * the call site, so it is pinned by a test rather than by reading it.
 */
export function onGoldDuty(u: {
  ringSlot?: number; inMineId?: number; order?: string | null; resKind?: string | null;
}): boolean {
  if ((u.ringSlot ?? 0) > 0 || (u.inMineId ?? 0) > 0) return true;
  return u.order === "harvest" && u.resKind === "gold";
}

/** How far PAST the berth a back-off aims, so the next pass is comfortably clear of the camp
 *  rather than balanced on its rim — where `safeLeg` would flip between seeing the creep and
 *  not seeing it (it drops creeps inside the berth from the detour) and the scout would jitter
 *  in and out instead of walking round. */
const CREEP_BACKOFF = 200;

/**
 * WHERE A SCOUT STANDING TOO CLOSE TO A CREEP WALKS TO — or null when nothing is too close.
 *
 * `safeLeg` cannot route round a creep that is already inside the berth of where the scout
 * stands: it drops those from the detour on purpose, since no waypoint avoids them and leaving
 * them in scores every candidate equally badly. So a scout that has blundered inside a camp's
 * notice is handed a step computed as though that camp were not there, and walks straight on
 * into it. This is the answer to that position, and it is the one a player gives: walk OUT.
 *
 * Away from the POOLED bearing of everything inside the berth rather than from the nearest one
 * — a scout standing between two creeps that alternated as "nearest" would alternate between
 * their two answers and go nowhere — and far enough out to clear the worst of them by
 * `CREEP_BACKOFF`. With creeps on every side the sum cancels and there is no "away" to name, so
 * it falls back to the bearing of `home`: not necessarily clear, but a direction, and standing
 * still is the one thing that is certainly wrong.
 *
 * Pure and exported for the same reason `scoutRing` is — what matters about it is that the
 * point it hands back is genuinely further from every creep than the point it was given.
 */
export function backOffSpot(
  from: { x: number; y: number },
  creeps: ReadonlyArray<{ x: number; y: number }>,
  home: { x: number; y: number },
  berth = CREEP_BERTH,
): { x: number; y: number } | null {
  let ax = 0;
  let ay = 0;
  let need = 0;
  for (const c of creeps) {
    const dx = from.x - c.x;
    const dy = from.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d >= berth) continue;
    need = Math.max(need, berth + CREEP_BACKOFF - d);
    // A creep exactly underfoot has no bearing of its own to add; the pool carries the rest.
    if (d > 1) { ax += dx / d; ay += dy / d; }
  }
  if (need <= 0) return null;
  let len = Math.hypot(ax, ay);
  if (len < 0.001) {
    // Surrounded (or stood on): no "away" exists, so take the way home as the direction.
    ax = home.x - from.x;
    ay = home.y - from.y;
    len = Math.hypot(ax, ay);
    if (len < 1) return null; // …and if home is here too, there is nothing to walk out of
  }
  return { x: from.x + (ax / len) * need, y: from.y + (ay / len) * need };
}

/** How long the scout may make no PROGRESS before its waypoint is written off (seconds).
 *
 *  The bug this exists for: `scoutPass` returns early while the scout's order is still "move",
 *  so a worker that had been stopped by a cliff, wedged behind a building, or knocked off its
 *  route by a creep it survived was left standing with a stale order and a goal it would never
 *  reach — for the rest of the match, out of the economy, one worker of eleven. Nothing else
 *  ever looked at it again, because the tour only advances on ARRIVAL. */
const SCOUT_STUCK_AFTER = 8;
/** …and how far it has to have moved in that time to count as making progress. A worker's own
 *  `spd` is 190+ (UnitBalance.slk), so this is under two seconds' walk: generous enough that
 *  going round a cliff is not "stuck", short enough that standing still is. */
const SCOUT_PROGRESS = 300;
/**
 * HOW LONG THE WHOLE TOUR MAY TAKE (seconds from the moment the scout sets out).
 *
 * A scout is a WORKER, and a worker walking is a worker not harvesting. Every other way out of
 * `scoutPass` is an EVENT — it arrived, it got stuck, it died — so a tour whose events simply
 * never came (a leg it can approach but never reach, a stand-off it keeps re-deciding, an
 * enemy base on the far side of a map it must walk round) kept one worker out of the economy
 * for the rest of the match with nothing to show for it. That is the "fixated on scouting"
 * report, and it costs the night elf most: a Wisp is a lumberjack whose lumber is credited in
 * the tree (docs/night-elf.md), so the one the tour is holding is a chopper that has stopped.
 *
 * Generous — this is a backstop, not a schedule. A worker crosses a 128x128 melee map in about
 * a minute, and the tour is worth its while at twice that.
 */
const SCOUT_TOUR = 150;
/**
 * …and how long the WALK HOME may take, measured from when it STARTED (`Brain.scoutBackAt`).
 *
 * The walk home is a leg like any other (`headHome`), which means it can fail like any other —
 * a route the pathfinder cannot find, a camp that has parked itself between the scout and its
 * own base. A held worker that will never arrive is worth less than an idle one in the wrong
 * place, because the harvest plan can at least give the second one a job.
 *
 * A worker crosses a 128x128 melee map in about a minute, so this is one crossing. Measured
 * from the start of the WALK and not from the start of the tour, because the tour can end at
 * any point in it: a scout that turns for home at ninety seconds must not be held to a deadline
 * pinned to a `SCOUT_TOUR` it never reached.
 */
const SCOUT_HOME_BY = 60;
/** Below this, a "step" is not a step and ordering a walk to it is ordering nothing — see the
 *  end of `scoutPass`. Half a pathing cell: shorter than any walk worth issuing an order for. */
const SCOUT_STRIDE = 64;

// ITEMS live in plus/items.ts, not here — an item ability is not in `SimUnit.abilities` (it
// hangs off the inventory slot and dispatches through `useItem`), so neither this file's army
// manager nor plus/casting.ts's ability walk can see one. What this file owns is the CONTEXT the
// belt cannot know for itself: where home is, whether the army has decided it is losing, and
// whether a hero may walk off to a shop right now — see `itemCtx`.

/**
 * The forest's crew, and how fast a full bank returns it to the wave — `undead.ai`'s own two
 * numbers (205-219, and `UNDEAD_AI.waveGate` in src/ai/undead.ts): ten lumberjacks, one fewer
 * per 120 lumber standing in the bank.
 */
const LUMBER_CREW = 10;
const LUMBER_PER_CHOPPER = 120;

/**
 * …and the SHARE of the ghouls the forest may take, which is OURS and is the half undead.ai
 * does not have (docs/computer-plus.md: a number here is ours unless a comment cites something).
 *
 * undead.ai's ten is not an opening. Its script has TWO branches and only the second one is the
 * decay above: in the OPENING the wave takes its six ghouls FIRST and *"the rest keep chopping"*
 * (undead.ai 205-219, `UNDEAD_AI.waveGate`) — the split is stated from the WAVE's side, and the
 * forest gets the remainder. Computer+ has no opening branch, so it ran the late-game decay on
 * the opening, where it means the opposite of what it means late: a melee undead's first ghouls
 * arrive with 150 lumber in the bank, the decay asks for nine choppers, and there are five, so
 * EVERY ghoul chopped. The hero was then the only thing in the squad — five food against a
 * `creepFood` of eight or ten — and the reported symptom is exactly what falls out of that: the
 * undead hero stood in its own base until the bank had grown to about 600 lumber and the decay
 * released the fourth ghoul, minutes after every other race had left to creep.
 *
 * A THIRD, because two thirds of the ghouls are the army — this is the one race whose soldiers
 * and whose lumberjacks are the same body, and a rule that lets the forest bid for them by the
 * bank alone is a rule that puts the army in the trees. It is the developer's own reading of the
 * opening ("2-3 ghouls stay at home gathering lumber", the rest creeping) and it scales the way
 * a player's hand does: two on the trees behind a four-ghoul opening, three behind seven, four
 * behind ten — never the whole crypt, at any bank.
 */
const LUMBER_SHARE = 1 / 3;

/**
 * How many of `choppers` the forest keeps.
 *
 * Two ceilings, and the LOWER one wins. `undead.ai`'s is the bank's — *"the forest keeps however
 * many the LUMBER stock says (10 minus a ghoul per 120 wood) and everything left over attacks"*
 * — which is what returns the crew to the wave as the wood piles up. Ours is the pool's
 * (`LUMBER_SHARE`), which is what stops the forest claiming the whole army before the bank has
 * had time to grow. Floored at `LUMBER_FLOOR` so a full bank still leaves somebody on the trees,
 * and never more choppers than there are ghouls.
 *
 * Pure and exported for the same reason `scoutRing` is: the thing that actually matters about it
 * — that it self-regulates, that a party is always left over for the hero to creep with, and
 * that none of them chop once the bank is full — is then pinned by a test rather than by
 * reading it. See `ComputerPlusAi.lumberCrew` for who is counted.
 */
/**
 * THE RELIEF, for the race whose soldiers are also its lumberjacks: a ghoul under this much
 * life is exchanged for one at least this fresh, and the pair swap jobs.
 *
 * The developer's own rule — "send hurt ghouls to mine lumber and get some healthy ghouls from
 * lumber" — and it is free healing rather than a rotation for its own sake: a Ghoul regenerates
 * 2 hp/s on BLIGHT and not one point off it (UnitBalance `regenType` = blight, docs/undead.md),
 * and the trees a base is chopping stand on the blight its own Necropolis painted. So the wave
 * is topped up and the wounded are healed by the same one order.
 *
 * The GAP between the two numbers is what stops it thrashing. A single threshold would swap a
 * ghoul out at 49 % for one at 51 % and swap it back the moment either ticked past the other;
 * with a half-dead one leaving and a nearly-whole one arriving, every exchange is worth making
 * and the loop runs out of pairs rather than out of patience. `RELIEVE_UNDER` is deliberately
 * below `RECOVER_TO` (0.65, the bar a unit under treatment is held back to) — this is not a
 * "hurt" ghoul, it is one about to die.
 */
const RELIEVE_UNDER = 0.5;
const RELIEVE_WITH = 0.9;

/** One unit's hit points over its own maximum. */
function health(u: SimUnit): number {
  return u.hp / Math.max(1, u.maxHp);
}

/**
 * How many one-for-one RELIEFS to make, given the two sides already sorted: the crew serving in
 * the wave worst-off first, the crew resting in the forest best-off first.
 *
 * Pure and exported for the same reason `lumberCrew` is — what matters about it is that it
 * pairs the worst with the best, that it stops at the first pair not worth exchanging, and that
 * the gap between the two thresholds is what stops the same ghoul walking in and out of the
 * wave for the rest of the match. Pinned by a test rather than by reading it.
 */
export function reliefCount(serving: readonly number[], rested: readonly number[]): number {
  let k = 0;
  while (k < serving.length && k < rested.length) {
    if (serving[k] >= RELIEVE_UNDER || rested[k] < RELIEVE_WITH) break;
    k++;
  }
  return k;
}

export function lumberCrew(wood: number, choppers: number): number {
  if (choppers <= 0) return 0;
  const bank = LUMBER_CREW - Math.floor(wood / LUMBER_PER_CHOPPER);
  const share = Math.ceil(choppers * LUMBER_SHARE);
  const want = Math.max(LUMBER_FLOOR, Math.min(bank, share));
  return Math.max(0, Math.min(want, choppers));
}

/**
 * HOW FAR THE ARMY MAY SPREAD while it is walking.
 *
 * The army moves as ONE BODY, which is the thing every one of these constants is for. Without
 * it a wave is only a list of units that were all given the same destination: a Grunt walks at
 * 270 and a Meat Wagon at 190 (UnitBalance.slk `spd`), a hero that stopped to kill something
 * falls a screen behind, and what arrives at the camp — or at the enemy's base — is a file of
 * ones and twos being killed in the order they turn up. It is the same mistake as chasing a
 * hero, made by nobody in particular.
 *
 * A unit further than this from the group's centre AND ahead of it is walked back to the centre
 * instead of onward. Roughly a screen at the game's own camera (docs/camera.md), which is as
 * spread out as an army can be and still be one fight.
 */
const COHESION_RADIUS = 600;
/**
 * …except when it is already fighting. A unit with an enemy this close is IN the battle, and
 * pulling it back to a centre of mass is retreating one soldier at a time. Half the acquisition
 * range of a ranged soldier: close enough that its own acquisition already has something.
 */
const COHESION_COMBAT = 500;
/**
 * …and how far behind the captain a unit has to be before it goes to the CAPTAIN rather than to
 * the objective.
 *
 * The difference matters, and it is the one that was reported: within `COHESION_RADIUS` the
 * army is one body and only the leaders are held; beyond THIS it is not one body at all, and a
 * unit that far back walking to the objective under its own attack-move arrives at the fight
 * alone and dies in it. Set well past `COHESION_RADIUS` so an ordinary marching column is not
 * constantly re-aimed at its own hero — this is for the unit that was trained after the party
 * left, or that fell behind killing something.
 */
const FOLLOW_RADIUS = 1400;
/**
 * How much of the wave has to be AT the muster point before it may leave.
 *
 * A fraction of food rather than "everybody", so one straggler — a unit stuck behind a
 * building, a hero walking back from a shop — cannot hold the whole army at home for ever. Four
 * fifths is an army with its tail still coming; anything less is half an army setting off.
 */
const GATHER_SHARE = 0.8;
/** …and how close to the muster point counts as gathered. Wider than `RALLY_SLACK`, which is
 *  the "stop nudging me" radius for one unit; this is a question about the whole group. */
const GATHER_RADIUS = 700;
/** How long it waits for the stragglers before going anyway. A player gives their army a few
 *  seconds to bunch up at the rally point and then leaves with whatever came — see `gathered`
 *  for the deadlock this exists to break. */
const GATHER_PATIENCE = 12;

/**
 * Creep camps: the window `AiPlayer.creepCamp` is asked for.
 *
 * The floor is 0 — every camp this party can take is a camp worth taking, and the nearest of
 * them is what `creepCamp` hands back. The CEILING is the whole decision and it is not a food
 * number: it is `maxCampLevel` (plus/power.ts), which prices the party against the camp colours
 * the game itself paints. See that file for what this used to be and what it cost.
 */
const CREEP_FLOOR = 0;
/**
 * …and how far it will WALK to one, tried in order — measured from wherever the party is
 * standing (`creepTarget`), which is home while it is at home and the captain once it is out.
 *
 * Three rings rather than one sweep, so a camp beside the base is always taken before one
 * across the map — the developer's "target nearby creep camps first before expanding their
 * choices to further creep camps". The first is about the base and its own expansion, the
 * second is the middle of a melee map, and the last is "anywhere" for the late game, when the
 * army is big enough that the walk is affordable and the near camps are long gone.
 */
const CREEP_REACH = [3000, 6000, Infinity];
/**
 * Hit-point fraction a unit heals up to before it is asked to fight again.
 *
 * A Healing Salve, a Scroll of Regeneration and a Moon Well all pour over TIME — 45 seconds for
 * the two scrolls — so a unit that walks back into a fight the moment it is dosed spends the
 * whole effect being hit for more than it is regaining. The heal is the point of the errand;
 * this is what makes the errand mean something.
 */
const RECOVER_TO = 0.65;
/** How far a hurt unit will walk to a Moon Well. Beyond this the trip costs more than the pour
 *  is worth and it heals where it stands. */
const WELL_WALK = 2000;
/** Hit-point fraction the CAPTAIN must have before the party goes to the next camp. A hero
 *  that walks into a second camp on a third of its life is a hero the camp kills, and a dead
 *  hero is the most expensive thing on a melee map. It heals up at home first. */
const CREEP_HEALTH = 0.65;
/** …and the hero level past which creeping stops being worth the walk. A PREFERENCE rather than
 *  an ability — see `creepNext`, which only applies it when there is actually an attack to
 *  prefer over the camp. */
const CREEP_UNTIL_LEVEL = 5;

/**
 * THE ILLUSIONS GO IN FIRST: how close to the camp the party is when the wand comes out.
 *
 * A Wand of Illusion makes a body that fights, is swung at, and hurts nothing (docs/
 * illusions.md) — so what it is worth against a creep camp is the opening exchange, the one the
 * camp's whole roster spends on whoever walked in first. That is a decision about a camp the
 * party has not reached yet, which is why it is the army manager's and not the belt's: by the
 * time the ladder's own `illusion` rung can see a fight, the creeps have already picked their
 * targets and the hero is one of them.
 *
 * It is pressed HERE rather than at the muster point because a double lasts sixty seconds
 * (`[AIil] Dur1`), and a vanguard conjured at home spends most of that walking. Wide enough to
 * be outside the camp's own notice — `MiscGame` AcquisitionRange is 500 — with room for the
 * copies to get in front, and narrow enough that they arrive with the clock barely started.
 */
const VANGUARD_RANGE = 1200;
/**
 * …and how long the body waits behind them, measured from the moment the copies SET OFF.
 *
 * From the press would be the wrong clock: the doubles do not exist yet when the wand is
 * pressed (spawning is asynchronous — docs/illusions.md) and the pass that orders them is the
 * next army pass, which is three seconds away on Easy and half of one on Insane. A lead counted
 * from the press is therefore a different lead per difficulty, and on the slow one it is spent
 * before the copies have taken a step.
 *
 * The head start is the only thing that puts them in front — a copy is exactly as fast as what
 * it copies — and at a soldier's ~300 units a second three seconds is most of the walk in from
 * `VANGUARD_RANGE`. Shorter and the party arrives with them and the camp spreads its blows over
 * everybody; much longer and the copies are fighting the camp alone for a fight they cannot
 * win — they deal no damage at all, and at DOUBLE damage taken a double is not a long wall.
 *
 * ONLY the orange and red camps get one. A green camp is a hero and a soldier or two against
 * something that was never going to hurt them (plus/power.ts), and the wand has three charges
 * for the whole match.
 */
const VANGUARD_LEAD = 3;
/**
 * …and how long the hold may stand before the copies have set off at all.
 *
 * The hold has to be up the moment the wand is pressed — the body must not walk on under the
 * order it is already carrying — but the lead itself cannot start until the copies exist, which
 * is the next army pass (`armyPeriod`, three seconds at its slowest). So the hold is armed for
 * the lead PLUS this, and `commit` brings it back in to `VANGUARD_LEAD` from the moment they
 * actually move. That direction matters: the clock only ever moves EARLIER once set off, so a
 * copy that arrives, idles and is re-ordered cannot push the deadline out in front of itself and
 * stand the whole army still for the rest of the match.
 */
const VANGUARD_SPAWN_GRACE = 4;

/**
 * A camp the party could not get to — how long it is left alone before it is offered again.
 *
 * The other half of the stall watchdog (`stalled`/`abandon`). Without it the watchdog is a loop
 * rather than a decision: the wave gives up on an unreachable camp, `massing` asks for the
 * nearest camp it can handle, gets the SAME one back, and walks at it again for ever. A camp is
 * shunned rather than struck off because "unreachable" is usually a statement about right now —
 * a building in the way, a camp on the far side of a fight — and the map's own geometry has not
 * changed.
 */
const CAMP_SHUN = 120;
/** How near a point has to be to a shunned camp to BE it. Both numbers are camp CENTROIDS off
 *  the same fixed table, so this is slack for the arithmetic and nothing else — wide enough to
 *  match and far narrower than the gap between two camps. */
const SHUN_MATCH = 200;

/**
 * WHEN AN OBJECTIVE IS WRITTEN OFF: how long the group may make no progress towards it, and
 * how far it has to move to count as progress.
 *
 * The wave had no deadline of any kind, and every state without one eventually deadlocks — this
 * is `GATHER_PATIENCE` and `SCOUT_STUCK_AFTER` again, at the other end of the walk. A party
 * standing on ground it cannot leave (a camp across a cliff, a target behind its own base's
 * buildings, an objective the pathfinder will not route to) held the whole army — hero included
 * — for the rest of the match. Measured against the group's own POSITION rather than against
 * its orders, because "has this order gone stale" is a question no order can answer about
 * itself, and never while there is something in front of it to fight.
 */
const PUSH_STUCK_AFTER = 20;
const PUSH_PROGRESS = 300;

/**
 * How long a broken army waits at home before it is put back on the board.
 *
 * `retreating` ends when everybody is home AND the group has healed to `REGROUP_HP_FRACTION`,
 * and there are two ways that never happens. One unit that cannot path home keeps `allHome`
 * false for ever; and — the one that actually bites — most of the game's units do not
 * REGENERATE at all (heroes do, the undead do on blight, the night elf does at night, a
 * Footman does not), so a human or orc group that came home at half health can sit in its own
 * base until fresh production alone lifts the average. Either way the party is out of the game.
 * `massing` is where the decision to creep, to attack or to keep waiting belongs, and it is a
 * much better place to wait than this one.
 */
const REGROUP_PATIENCE = 45;

/**
 * THE WOUNDED WALK OUT OF THE FIGHT — how far back, how long for, and how long before the same
 * unit may do it again (`PlusProfile.pullOutHp` is the bar that starts it, and 0 on Easy).
 *
 * This is micro at the level of ONE unit and it is a different decision from `retreatHp`, which
 * is the whole army leaving: a wave that is winning still has a Grunt on its last quarter, and
 * that Grunt is one blow from being 200 gold and 2 food spent on nothing. A player pulls it
 * behind the line, lets the fight go on without it, and puts it back in.
 *
 * The distance is the developer's own ("around 800-1000 out of the fight"), measured from the
 * ARMY's anchor rather than from the unit — see `pullBackSpot`, and note that "out of the
 * fight" and "behind the owner's army" are the same point only when it is measured from there.
 * A ranged soldier's acquisition is 500 and a caster's cast range 700-800, so 900 is out of
 * everything that was about to land on it.
 *
 * `PULL_BACK_AGAIN` is the whole of "it must not go back and forth", and it is why this is a
 * per-unit clock rather than a test on hit points: a unit released at 24 % health wants to be
 * pulled again on the very next pass, and a rule with no memory is a unit that walks in and out
 * of the line for the rest of the battle instead of fighting in it. Measured from when the pull
 * STARTED, so the cooldown is the whole cycle rather than an extra wait bolted onto the hold.
 */
const PULL_BACK_DIST = 900;
const PULL_BACK_HOLD = 10;
const PULL_BACK_AGAIN = 45;
/** …and how close to the spot counts as arrived, so a unit that has got there is not re-ordered
 *  to it every pass. Wider than `RALLY_SLACK` for the same reason `GATHER_RADIUS` is: this is a
 *  question about roughly where a unit ended up, not about a pixel. */
const PULL_BACK_ARRIVE = 200;

/**
 * How long a hero that WIND WALKED out of a fight stays out of it (`escapePass`).
 *
 * Much longer than `PULL_BACK_HOLD`, because the two are different withdrawals: a pull-back is a
 * step behind the line taken while the fight goes on winning without that soldier, and this is
 * the hero leaving the fight altogether — the whole walk home, which is what `[AOwk]`'s own
 * `Dur1` is sized for and what its Movement Speed Increase (DataB) makes survivable. Set inside
 * the shortest rank of that duration, so the hero is still invisible when it arrives rather than
 * being dropped back into the army's orders halfway there.
 */
const WINDWALK_OUT = 18;

/**
 * WHERE a unit pulled out of a fight goes: `PULL_BACK_DIST` behind the army, away from what is
 * hitting it.
 *
 * Measured from the ARMY's own anchor (its captain, or its centre of mass) rather than from the
 * unit's feet, which is what makes it "behind the owner's army" rather than merely "away from
 * the enemy": a soldier that had run out in front walks all the way back past the line, and one
 * that was already at the back does not walk twice as far as it needed to. It falls back to the
 * unit's own position when there is no army left to stand behind, and to the anchor itself when
 * the two points coincide and there is no direction to be had.
 *
 * Pure and exported for the same reason `safeLeg` and `pushStalled` are — the thing that
 * actually matters about it (that the spot is on the FAR side of the army from the enemy, and
 * that it is a screen away rather than a step) is then pinned by a test rather than by reading
 * it (tools/ai-plus-army-test.cjs).
 */
export function pullBackSpot(
  at: { x: number; y: number },
  foe: { x: number; y: number },
  anchor: { x: number; y: number } | null,
): { x: number; y: number } {
  const from = anchor ?? at;
  let dx = from.x - foe.x;
  let dy = from.y - foe.y;
  let len = Math.hypot(dx, dy);
  if (len < 1) {
    // The anchor is standing on the enemy — back away along the unit's own line instead.
    dx = at.x - foe.x;
    dy = at.y - foe.y;
    len = Math.hypot(dx, dy);
  }
  if (len < 1) return { x: from.x, y: from.y };
  return { x: from.x + (dx / len) * PULL_BACK_DIST, y: from.y + (dy / len) * PULL_BACK_DIST };
}

/** One unit's pull-back clock: when it may come back, and when it may be pulled again. */
export interface PullBack {
  readonly x: number;
  readonly y: number;
  /** `clock` at which it rejoins the army. */
  readonly until: number;
  /** …and the earliest `clock` at which it may be pulled out a SECOND time. */
  readonly next: number;
}

/** Is this unit currently OUT of the line? The one question `commit` and `squadFood` ask, so
 *  that a withdrawn unit is neither ordered into the fight nor counted as part of the wave. */
export const pulledOut = (entry: PullBack | undefined, clock: number): boolean =>
  !!entry && clock < entry.until;

/**
 * Should this unit be walked out of the fight NOW?
 *
 * Four clauses and every one of them is load-bearing: the difficulty does this at all
 * (`threshold` — 0 on Easy), the unit is actually hurt, it is not already out, and its own
 * cooldown has expired. The last is the see-saw guard (`PULL_BACK_AGAIN`): without it a unit
 * released at a hair under the bar is pulled again on the very next pass and spends the battle
 * walking rather than fighting.
 *
 * Pure and exported so both directions are pinned by a test — and the FALSE one matters most,
 * exactly as it does for `pushStalled`: an over-eager rule is an army that never fights.
 */
export function pullDue(
  entry: PullBack | undefined,
  hpFraction: number,
  threshold: number,
  clock: number,
): boolean {
  if (threshold <= 0) return false;
  if (hpFraction >= threshold) return false;
  if (!entry) return true;
  return clock >= entry.until && clock >= entry.next;
}

/**
 * The stall watchdog itself, as arithmetic — see `PUSH_STUCK_AFTER` for what it is for.
 *
 * `w` is the wave's own memory of where it last made progress and when; it is written through,
 * so one call per army pass IS the watchdog. Pure and exported for the reason `safeLeg` is: both
 * directions have to be pinned by a test rather than by reading it, and the FALSE one matters
 * most — a wave written off while it is merely walking is an army that never arrives anywhere
 * (tools/ai-plus-army-test.cjs).
 */
export function pushStalled(
  w: { was: { x: number; y: number } | null; since: number },
  at: { x: number; y: number },
  clock: number,
  fighting: boolean,
): boolean {
  // A group in a fight is not stuck. Forgetting where it was is what makes the clock start
  // again from where the fight ENDS rather than from where it began.
  if (fighting) {
    w.was = null;
    return false;
  }
  if (!w.was || Math.hypot(at.x - w.was.x, at.y - w.was.y) > PUSH_PROGRESS) {
    w.was = { x: at.x, y: at.y };
    w.since = clock;
    return false;
  }
  return clock - w.since >= PUSH_STUCK_AFTER;
}

/**
 * IS THIS UNIT A PICTURE OF THE ARMY RATHER THAN PART OF IT?
 *
 * An illusion — a Blademaster's Mirror Image, or a double off a Wand of Illusion — is a body
 * that walks, is swung at and deals NO DAMAGE AT ALL (docs/illusions.md). It belongs in the
 * squad, because it has to be given orders like anything else; it belongs in none of the
 * arithmetic the squad is judged by, and every one of those readings is wrong in a way that
 * matters:
 *
 *  · **power** (`creepForce`, `oppositionHealthy`) — priced off `dps × hp`, and a copy's damage
 *    per second is zero however its weapon reads on the sheet. Counting it walks the party into
 *    a camp on strength it has not got, which is the very thing plus/power.ts was written for.
 *  · **health** (`creepForce`, `readiness`) — copies arrive at FULL hit points and are meant to
 *    die. Left in, the vanguard popping IS the army "breaking", and `fightLost` marches the
 *    party home from a camp it has not started fighting yet.
 *  · **food** (`squadFood`, `gathered`, `armyFood`) — a double occupies no food and lasts sixty
 *    seconds. Left in, a wave believes it is big enough to attack because of bodies that are
 *    about to vanish, and the production ceiling stops training the real ones.
 *  · **the line** (`squadCentre`, `pullPass`) — the copies are deliberately out in front, so
 *    they must not drag the army's anchor forward, and one on its last quarter is doing exactly
 *    what it is for and must not be walked out of the fight.
 */
function isCopy(u: SimUnit): boolean {
  return u.isIllusion;
}

/** Is this camp one the party gave up on recently (`CAMP_SHUN`)? Pure and exported for the same
 *  reason `pushStalled` is — an over-eager shun list is an AI that stops creeping. */
export function isShunned(
  list: ReadonlyArray<{ x: number; y: number; until: number }>,
  camp: { x: number; y: number },
  clock: number,
): boolean {
  return list.some((s) => s.until > clock && Math.hypot(camp.x - s.x, camp.y - s.y) <= SHUN_MATCH);
}

/**
 * When a FIGHT is broken off — see `ComputerPlusAi.fightLost`, which explains why these are so
 * much lower than the bars a creep run is STARTED at (plus/power.ts): that one asks "is this
 * party good enough to begin", and a party is always weaker once it has, so re-asking it
 * mid-fight would abort every run on the first scratch.
 *
 * All three are ours and all three are the developer's own numbers: leave when the group is
 * under 40 % of its hit points, or when the captain is under 20 % and what it is fighting is
 * still more than half up. They apply to a creep camp and to an opponent's army alike — only
 * the way "still more than half up" is MEASURED differs (`oppositionHealthy`).
 */
const ABORT_GROUP_HP = 0.4;
const ABORT_HERO_HP = 0.2;
const CAMP_STILL_UP = 0.5;

/** How often the ally list is rebuilt. An alliance changes about as often as a player leaves,
 *  and the answer costs a walk of the whole unit table — see `alliesOf`. */
const ALLY_REFRESH = 5;

/**
 * The Orc Burrow's own cargo-hold ability — `Abun` Load, off its `abilList`.
 *
 * What tells a burrow from the other worker-only hold in the game, the Entangled Gold Mine's
 * `Aenc`. See `burrowPass`, which is the one place it matters and the one place it cost a bug.
 */
const BURROW_HOLD = "Abun";

/** The `buffType` category a town hall carries — UI\UnitEditorData.txt's pickFlags, the first
 *  of the four, and the same one `SimWorld.nearestHall` ranks a Town Portal's destination by. */
const HALL_CATEGORY = "townhall";

/** The Moon Well / Obsidian Statue battery (`Ambt`, "Mana Battery"), and the statue's own two
 *  autocasts — `Arpl` Essence of Blight (life) and `Arpm` Spirit Touch (mana), straight off
 *  `uobs`'s UnitAbilities row. See `wellPass` and `statuePass`. */
const REPLENISH_CODE = "Ambt";
const STATUE_LIFE = "Arpl";
const STATUE_MANA = "Arpm";

type Mode = "massing" | "attacking" | "retreating" | "defending";

interface Brain {
  readonly ai: AiPlayer;
  readonly profile: PlusProfile;
  readonly table: PlusRaceTable;
  /** The build it rolled at seat time and plays for the whole match (plus/races.ts). */
  readonly strategy: PlusStrategy;
  readonly caster: PlusCaster;
  /** What it buys and what it drinks (plus/items.ts). Separate from the caster because an item
   *  ability is NOT in `SimUnit.abilities` — it hangs off the inventory slot and dispatches
   *  through `useItem` — so the caster's ability walk cannot see one (docs/items.md). */
  readonly items: PlusItems;
  /** What it has seen of the enemy army, and the read taken off it — the input to countering
   *  (plus/counter.ts). Refreshed on the army pass, since that is when it is looking anyway. */
  readonly memory: EnemyMemory;
  enemy: EnemyRead;
  /** Seconds since this computer was seated. */
  clock: number;
  /** Can this player's ordinary worker chop? Null until one has been looked at — a property of
   *  the unit data, so it is answered once and held (`ComputerPlusAi.workerChops`). */
  chops: boolean | null;
  buildIn: number;
  armyIn: number;
  castIn: number;
  mannersIn: number;
  /** The whole army. Computer+ fields ONE group and fights with all of it, which is what a
   *  player does — there is no muster list to satisfy, unlike the classic captain. */
  readonly squad: Set<number>;
  /** Everyone the ECONOMY may not re-task: the army, plus the scout. Handed to
   *  `AiPlayer.captainHeld` once and mutated in place, so `applyHarvest` sees a live view. */
  readonly held: Set<number>;
  /** The worker sent to go and look, and how far round its tour it is. ONE of them, ever:
   *  `scoutDone` latches when the tour ends, when it runs out of time, and — this is the whole
   *  rule — the moment the scout dies, because a player who loses a scout sends their workers
   *  back to work rather than feeding a second one to the same creeps. */
  scoutId: number;
  scoutLeg: number;
  scoutGoal: { x: number; y: number } | null;
  scoutDone: boolean;
  /** Where the scout was when it was last seen to have MOVED, and how long it has been standing
   *  there since. The watchdog on a tour that only ever advanced on arrival — see `scoutPass`. */
  scoutWas: { x: number; y: number } | null;
  scoutStill: number;
  /** `b.clock` when the scout set out — the tour's own deadline (`SCOUT_TOUR`). */
  scoutSince: number;
  /** What the scout's health was last pass. A drop means somebody is shooting at it, which
   *  ends the tour — see `scoutPass`. */
  scoutHp: number;
  /** The scout's own clock, which is NOT the army's — see `SCOUT_PERIOD`. */
  scoutIn: number;
  /** Is the tour over and the scout on its way HOME? The walk back is a leg like any other —
   *  arc'd round the creeps, re-aimed every pass, and the worker is not handed back to the
   *  economy until it arrives. See `headHome`. */
  scoutBack: boolean;
  /** `b.clock` when the walk home began — its own deadline (`SCOUT_HOME_BY`), measured from
   *  there rather than from the tour's start, because the tour can end at any point in it. */
  scoutBackAt: number;
  mode: Mode;
  /** When the wave first found itself short at the muster point (-1 = it is gathered). The
   *  deadline on `gathered`, without which one stuck soldier holds the army at home for ever. */
  gatherSince: number;
  /** WHAT this retreat is running from, which is what decides whether the hero spends its
   *  Scroll of Town Portal on it. Null while nothing is retreating. */
  retreatFrom: "creeps" | "player" | null;
  /** When this retreat began — the deadline on it (`REGROUP_PATIENCE`). */
  retreatSince: number;
  /** Where the group was when it was last seen to have MOVED towards its objective, and when.
   *  The watchdog on a wave that is going nowhere — see `PUSH_STUCK_AFTER` and `pushStalled`. */
  push: { was: { x: number; y: number } | null; since: number };
  /** Camps this party gave up on, and when each may be offered again (`CAMP_SHUN`). */
  shunned: Array<{ x: number; y: number; until: number }>;
  /**
   * The wounded that have been walked OUT of the fight, by unit id — where each was sent, when
   * it rejoins, and when it may be pulled again (`pullBack`, `PULL_BACK_AGAIN`).
   *
   * Empty at every rung that does not do this (`PlusProfile.pullOutHp` is 0 on Easy), and
   * cleared outright whenever the whole army is going home or waiting at the rally point: a
   * general retreat and a rally both supersede one soldier's errand, and a stale entry would
   * hold that soldier out of the next wave.
   */
  readonly pulls: Map<number, PullBack>;
  /** Is the army mustering IN THE FIELD — on its captain, with another camp in front of it —
   *  rather than at home? Written by `muster` on every massing pass, and read by the errands
   *  that only make sense at home (the shop, `itemCtx.mayShop`). */
  afield: boolean;
  target: { id: number; x: number; y: number } | null;
  reissueIn: number;
  /** When the last wave came home — `waveGap` is measured from it. */
  lastWaveEnd: number;
  /** When something hostile first appeared in one of our towns (-1 = nothing there). The
   *  difficulty's `defendDelay` is measured off this: an easy computer lets you kill four
   *  workers before it looks up. */
  threatSince: number;
  greeted: boolean;
  /** WHEN this seat says its "glhf" — drawn once, off its own stream, inside the window
   *  `GREET_AT`…`GREET_AT + GREET_SPREAD` (plus/chatter.ts). A moment rather than a slot beat,
   *  so the lobby's greetings arrive in a different order and at different gaps each match. */
  greetAt: number;
  /** When the position first looked unwinnable (-1 = it doesn't). */
  hopelessSince: number;

  // --- the team game (plus/teamchat.ts). All of it is inert in a 1v1: `allies` is empty and
  // every branch below reads it first.
  /** Who this computer is co-allied with, as of `alliesAt`. Refreshed on a slow clock of its
   *  own because an alliance changes about as often as a player leaves, and the answer costs a
   *  walk of the whole unit table. */
  allies: number[];
  alliesAt: number;
  /** Has it told its allies what it is building yet (`openerLine`)? Once a match, near the top
   *  of it — and only ever reached with an audience, since `teamPass` returns on an empty
   *  `allies` before anything here runs. */
  opened: boolean;
  /** The unit at the top of the production mix as last ANNOUNCED, so a change is a change
   *  rather than a re-statement. "" until it has said anything at all — and the opener SEEDS
   *  it, so the first thing `mixTalk` reports is a change from the build rather than the build
   *  said twice. */
  said: string;
  /** When it last said anything to its allies (TALK_GAP), last asked for help (HELP_CALL_GAP),
   *  and last answered somebody else's call (HELP_ANSWER_GAP). */
  spokeAt: number;
  askedAt: number;
  answeredAt: number;
  /** An ally's call for help that has not been acted on yet (-1 = none).
   *
   *  Taken in by `heard` and acted on by the manners pass, never inside `heard` itself: that is
   *  called from the middle of chat delivery, and answering there would re-enter `deliverChat`
   *  from inside its own routing. */
  called: number;
  /** When that call may be ANSWERED. One "help" reaches every allied computer on the same
   *  frame; `HELP_ANSWER_STAGGER` gives each of them its own turn to speak and to decide. */
  answerAt: number;
  /** The ally this relief wave is for (-1 = none), and the clock it gives up on. */
  helping: number;
  helpUntil: number;
  /** When this rescue set off (`HELP_GRACE` is measured from it) and when the ally last looked
   *  to be in danger — the two clocks that let a rescue be CALLED OFF. See `helpWave`. */
  helpSince: number;
  helpDangerAt: number;
  /** What the wave was doing when the call came, so a cancelled rescue can go back to it rather
   *  than standing in the middle of the map wondering. Null when there was nothing to go back
   *  to (it was at home). */
  helpResume: { mode: Mode; target: { id: number; x: number; y: number } | null; creeping: boolean } | null;
  /** When it said gg (-1 = it hasn't). It leaves LEAVE_AFTER seconds later. */
  /** Is the wave in the field a CREEPING party rather than an attack? The two end on
   *  different terms — a creep run is over the moment the captain is gone (see `attacking`). */
  creeping: boolean;
  /** …and the combined LEVEL of the camp it is on, which is what plus/power.ts prices the party
   *  against — both to set off and, every pass after that, to decide it is still winning. */
  creepLevel: number;
  /** Until when the BODY holds while its illusions walk into the camp ahead of it — 0 when
   *  there is no vanguard out. See `VANGUARD_LEAD` and `vanguardPass`. */
  vanguardUntil: number;
  /** …and whether this run has already had its one attempt at throwing one. Without it a hero
   *  standing outside a camp with no wand asks the belt the same question every army pass, and
   *  one WITH a wand pops a fresh double every few seconds instead of a vanguard. */
  vanguardDone: boolean;
  concededAt: number;
  gone: boolean;
}

/** Every Computer+ player in the match. */
export class ComputerPlusAi {
  private readonly brains: Brain[] = [];

  constructor(private readonly host: PlusHost) {}

  /** Seat one Computer+ slot. Same signature as `MeleeAi.add`, and called from the same place
   *  (`StartMeleeAI`, i.e. the map's own Melee Initialization) — the checkbox decides which of
   *  the two objects the seat lands in, and nothing else changes. */
  add(player: number, race: PlayableRace, difficulty: number, startX: number, startY: number, seed: number): void {
    const table = PLUS_RACES[race];
    if (!table) return;
    const profile = plusProfile(difficulty);
    const ai = new AiPlayer(player, race, difficulty, this.host, startX, startY, seed);
    // No fog cheat at any difficulty — see the file header.
    ai.bypassFog = false;
    // WHICH BUILD this computer is playing, rolled once off its own stream and held for the
    // match. Two Computer+ players on one map open differently; the same seat on the same seed
    // opens the same way twice.
    const strategy = rollStrategy(table, profile.techTier, (lo, hi) => ai.randomInt(lo, hi));
    this.pickHeroes(ai, table, strategy);
    const squad = new Set<number>();
    // The harvest plan has to know who is spoken for, or an undead computer marches its attack
    // ghouls straight back into the forest a second after mustering them — and the scout would
    // be sent back to the mine before it reached the first waypoint.
    const held = new Set<number>();
    ai.captainHeld = held;
    this.brains.push({
      ai, profile, table, strategy,
      memory: new EnemyMemory(),
      enemy: { seen: 0, air: 0, armor: {} },
      caster: new PlusCaster({
        world: this.host.world,
        player,
        def: (id) => this.host.abilities.get(id),
        hostile: (u) => ai.hostileTo(u),
        order: (cmd) => ai.order(cmd),
        // The AI's OWN random stream, so a misclick (`PlusProfile.castMistake`) is as
        // deterministic as every other decision it takes.
      }, profile, () => ai.randomInt(0, 9999) / 10000),
      items: new PlusItems({
        world: this.host.world,
        player,
        def: (id) => this.host.abilities.get(id),
        hostile: (u) => ai.hostileTo(u),
        order: (cmd) => ai.order(cmd),
        item: (id) => this.host.items.get(id),
        // A shop's shelf from the buyer's side: `Makeitems` is a race shop's and `Sellitems` a
        // neutral one's, and nothing that shops cares which column it came out of.
        wares: (typeId) => {
          const t = this.host.tech.get(typeId);
          return [...t.makeitems, ...t.sellitems];
        },
        gold: () => ai.gold(),
        // WHOSE SHELF this is — the race's own first buys (plus/items.ts `RACE_FIRST`).
      }, profile, race),
      clock: 0,
      chops: null,
      // Staggered across the interval, so twelve computers never all think on one frame.
      buildIn: profile.buildPeriod * (1 + player / 12),
      armyIn: profile.armyPeriod * (1 + player / 12),
      castIn: profile.castPeriod * (1 + player / 12),
      mannersIn: MANNERS_PERIOD,
      squad,
      held,
      scoutId: 0,
      scoutLeg: 0,
      scoutGoal: null,
      scoutDone: false,
      scoutWas: null,
      scoutHp: 0,
      scoutIn: 0,
      scoutBack: false,
      scoutBackAt: 0,
      scoutStill: 0,
      scoutSince: 0,
      mode: "massing",
      gatherSince: -1,
      retreatFrom: null,
      retreatSince: 0,
      push: { was: null, since: 0 },
      shunned: [],
      pulls: new Map(),
      afield: false,
      target: null,
      reissueIn: 0,
      lastWaveEnd: 0,
      threatSince: -1,
      greeted: false,
      // Tenths of a second off the seat's own stream, so it is as deterministic-per-seed as
      // every other Computer+ decision and as unpredictable between matches as the seed is.
      greetAt: GREET_AT + ai.randomInt(0, GREET_SPREAD * 10) / 10,
      hopelessSince: -1,
      allies: [],
      alliesAt: -Infinity,
      opened: false,
      said: "",
      spokeAt: -Infinity,
      askedAt: -Infinity,
      answeredAt: -Infinity,
      called: -1,
      answerAt: 0,
      helping: -1,
      helpUntil: 0,
      helpSince: 0,
      helpDangerAt: 0,
      helpResume: null,
      creeping: false,
      creepLevel: 0,
      vanguardUntil: 0,
      vanguardDone: false,
      concededAt: -1,
      gone: false,
    });
  }

  get active(): boolean {
    return this.brains.some((b) => !b.gone);
  }

  /**
   * A line was said, and `recipients` is who heard it — `RtsController.heardChat`, which is the
   * routing `chatRecipients` already did rather than a second opinion.
   *
   * The ONE way anything from outside this player's own eyes reaches it, and it is fenced three
   * ways so that stays true: the line must have been addressed to this computer (it cannot read
   * chat it was not a recipient of, any more than it can see through the fog), it must come from
   * somebody it is actually co-allied with (an enemy typing "help" on the all-channel is
   * taunting), and it must not be its own (every line this file says is in the same vocabulary
   * `readAllyCall` reads).
   *
   * Nothing is DONE here — the call is parked on the brain and answered by the manners pass. See
   * `Brain.called` for why that separation is not optional.
   */
  heard(line: ChatLine, recipients: readonly number[]): void {
    // How many computers have already taken a turn at this ONE line. Every allied Computer+
    // player hears it on the same frame, so without a turn each they all typed "omw" onto the
    // same frame as well — see `HELP_ANSWER_STAGGER`. Counted here rather than derived from the
    // slot number so the offsets are 0, 1, 2 for whoever actually heard it, not 0, 3, 7 for
    // wherever they happen to sit in the lobby.
    let turn = 0;
    for (const b of this.brains) {
      if (b.gone || b.concededAt >= 0) continue; // a computer on its way out answers nobody
      const me = b.ai.player;
      if (line.from === me || !recipients.includes(me)) continue;
      if (!this.host.coAllied(me, line.from)) continue;
      if (readAllyCall(line.text) !== "help") continue;
      b.called = line.from;
      b.answerAt = b.clock + HELP_ANSWER_STAGGER * turn++;
    }
  }

  reset(): void {
    this.brains.length = 0;
  }

  /**
   * Heroes, in the table's own preference order rather than by the dice.
   *
   * `PickMeleeHero` draws three of the four at random, which is common.ai's own behaviour and
   * is why the classic AI opens with a Blood Mage as often as an Archmage. A human opens with
   * the hero their BUILD wants, so Computer+ takes the strategy's own order where it states one
   * (a Tauren build opens Tauren Chieftain, a Bear build opens Keeper of the Grove) and the
   * race's otherwise — with the SECOND and THIRD swapped at random, because two computers
   * playing the same build should still not be identical.
   */
  private pickHeroes(ai: AiPlayer, table: PlusRaceTable, strategy: PlusStrategy): void {
    const [first, ...rest] = strategy.heroes ?? table.heroes;
    if (ai.randomInt(0, 1) === 1 && rest.length >= 2) [rest[0], rest[1]] = [rest[1], rest[0]];
    ai.heroId = first ?? "";
    ai.heroId2 = rest[0] ?? "";
    ai.heroId3 = rest[1] ?? "";
    for (const slot of [1, 2, 3]) {
      for (const [hero, skills] of Object.entries(table.skills)) ai.setSkillArray(slot, hero, skills);
    }
  }

  tick(dt: number): void {
    for (const b of this.brains) {
      if (b.gone) continue;
      b.clock += dt;
      if ((b.buildIn -= dt) <= 0) {
        b.buildIn = b.profile.buildPeriod;
        simProfile.begin("sim.ai.build");
        const t0 = perfNow();
        this.buildPass(b);
        simProfile.end("sim.ai.build");
        simProfile.gauge("aiBuildPass", perfNow() - t0);
      }
      if ((b.armyIn -= dt) <= 0) {
        b.armyIn = b.profile.armyPeriod;
        simProfile.begin("sim.ai.attack");
        const t0 = perfNow();
        this.armyPass(b);
        simProfile.end("sim.ai.attack");
        simProfile.gauge("aiAttackPass", perfNow() - t0);
      }
      if ((b.castIn -= dt) <= 0) {
        b.castIn = b.profile.castPeriod;
        simProfile.begin("sim.ai.cast");
        const t0 = perfNow();
        // The belt's one answer the caster needs and cannot reach for itself: Wind Walk's exit
        // is the escape a hero takes when it has no Scroll of Town Portal (plus/casting.ts
        // `windWalkRole`), and an item ability is not in `SimUnit.abilities` at all.
        b.caster.pass(b.clock, { holdsPortal: (u) => b.items.holdsEscape(u), home: b.ai.home() });
        simProfile.end("sim.ai.cast");
        simProfile.gauge("aiCastPass", perfNow() - t0);
        // The BELT, on the same clock as the buttons — it is the same kind of decision, and a
        // hero whose spells and whose potions were considered at different rates would drink
        // late in exactly the fights its casting is fast enough for. Its own span (and its own
        // `worst` gauge) because it also does the shopping, which is a walk rather than a
        // press and costs something quite different — see docs/perf-logging.md on why a pass
        // that fires on its own period needs a maximum and not only a mean.
        simProfile.begin("sim.ai.items");
        const t1 = perfNow();
        b.items.pass(b.clock, this.itemCtx(b));
        simProfile.end("sim.ai.items");
        simProfile.gauge("aiItemPass", perfNow() - t1);
      }
      // THE SCOUT, on its OWN clock rather than the army's — see `SCOUT_PERIOD`. `hold` after
      // it, because the pass is what decides whether there IS a scout, and the economy may not
      // re-task one; leaving that to the next army pass handed the worker back to the mine for
      // up to three seconds on Easy.
      if ((b.scoutIn -= dt) <= 0) {
        b.scoutIn = SCOUT_PERIOD;
        this.scoutPass(b);
        this.hold(b);
      }
      if ((b.mannersIn -= dt) <= 0) {
        b.mannersIn = MANNERS_PERIOD;
        this.mannersPass(b);
      }
    }
  }

  // ======================================================================================
  //  Economy and production
  // ======================================================================================

  private buildPass(b: Brain): void {
    const { ai } = b;
    ai.refresh();
    const ctx = this.ctx(b);
    // Workers first, then the list they will be spending on — the same order the classic AI
    // runs its two halves in (`peon_assignment` fills the harvest plan, `OneBuildLoop` spends).
    harvestPlan(ctx);
    ai.applyHarvest();
    buildPlan(ctx);
    // What it is building is worth telling a TEAMMATE, and this is where the answer is already
    // in hand. Said after the plan rather than before it, so the line and the build array are
    // the same decision read twice.
    this.mixTalk(b, ctx);
    ai.runBuildLoop();
    ai.spendSkillPoints();
    ai.entangleMines(); // the night elf's gold, which is a cast rather than a build order
  }

  /**
   * What the belt needs to know that only the army manager does.
   *
   * `losing` is the manager's OWN read rather than a second opinion — it is the retreat it has
   * already decided on. That matters: a Town Portal and a walk home are one decision, and a
   * hero that judged the fight separately would scroll out of fights the army was winning, or
   * stay in ones it had already given up on.
   *
   * `mayShop` is false whenever there is a wave in the field, which is what keeps the errand
   * off the battlefield: a hero is only ever sent to a shop from the muster point.
   */
  private itemCtx(b: Brain): ItemCtx {
    return {
      home: b.ai.home(),
      // Either the group is walking home broken, or this wave is already over and what is left
      // of it is standing in somebody else's base.
      losing: b.mode === "retreating",
      // …and whether that retreat is worth a Scroll of Town Portal, which turns entirely on
      // WHAT it is running from (see `ItemCtx.portalWorthIt` and `Brain.retreatFrom`). Creeps
      // do not chase; an army does.
      portalWorthIt: b.retreatFrom === "player",
      // MASSING AT HOME only. "Defending" is the base under attack, which is the one moment a
      // hero walking off to buy a potion is worse than having no potion at all — and a party
      // mustering in the FIELD between two creep camps (`muster`) is not at home either: the
      // shop is behind it, and sending the captain back to it walks the army's anchor off the
      // map while the rest of the party stands on a cleared camp waiting for it.
      mayShop: b.mode === "massing" && !b.afield,
    };
  }

  /** The world as the plan reads it, assembled once per pass. */
  private ctx(b: Brain): PlusCtx {
    return {
      ai: b.ai,
      profile: b.profile,
      table: b.table,
      strategy: b.strategy,
      enemy: b.enemy,
      clock: b.clock,
      armyFood: this.armyFood(b),
      tier: this.tier(b),
      threatened: b.ai.townThreatened(),
      workerChops: this.workerChops(b),
      foodOf: (id) => this.host.registry.get(id)?.foodUsed ?? 0,
      defOf: (id) => this.host.registry.get(id),
    };
  }

  /**
   * Can this player's ordinary worker CHOP?
   *
   * The same question `lumberCrew` asks and asked the same way — of a worker standing on the
   * field (`WorkerState.lumber`) rather than of the race — so a custom map that hands its
   * Acolytes an axe is answered correctly with no list of races anywhere. What it decides is how
   * many workers the plan asks for at all, which for the undead is a mine's crew rather than an
   * economy's worth (plus/plan.ts `workers`).
   *
   * CACHED once an answer has been seen, because it is a property of the unit DATA and cannot
   * change — and because the alternative is a wrong answer at the one moment it matters most:
   * with every worker dead or down a mine the scan finds nothing, and defaulting to "yes" would
   * put an undead computer straight back onto its thirty-eight Acolytes.
   */
  private workerChops(b: Brain): boolean {
    if (b.chops !== null) return b.chops;
    for (const u of this.host.world.units.values()) {
      if (u.owner !== b.ai.player || u.hp <= 0 || !u.worker || !u.isPeon) continue;
      b.chops = u.worker.lumber;
      return b.chops;
    }
    return true; // nothing seen yet: the ordinary case, and re-asked next pass
  }

  /**
   * Food spent on FIGHTERS — the number every ceiling in `PlusProfile` is stated in.
   *
   * Workers and buildings are left out (they are the economy, not the army) and production
   * queues are counted in (a Grunt half-trained is a Grunt you have decided to have, and
   * counting only what is standing makes the AI order the same wave twice).
   */
  private armyFood(b: Brain): number {
    let food = 0;
    for (const u of this.host.world.units.values()) {
      if (u.owner !== b.ai.player || u.hp <= 0) continue;
      const def = this.host.registry.get(u.typeId);
      if (!def) continue;
      if (!u.building && !u.isPeon && !isCopy(u)) food += def.foodUsed;
      for (const job of u.building?.queue ?? []) {
        if (job.kind !== "unit") continue;
        const made = this.host.registry.get(job.unitId);
        // `UnitDef` carries the classification list rather than a flag — "peon" in
        // UnitBalance.slk's `type` column is the same fact `SimUnit.isPeon` is derived from.
        if (made && !made.classification.includes("peon")) food += made.foodUsed;
      }
    }
    return food;
  }

  /** The highest hall tier STANDING (1/2/3). */
  private tier(b: Brain): number {
    const [t1, t2, t3] = b.table.halls;
    if (b.ai.countDone(t3) > 0) return 3;
    if (b.ai.countDone(t2) > 0) return 2;
    return b.ai.countDone(t1) > 0 ? 1 : 0;
  }

  // ======================================================================================
  //  The army
  // ======================================================================================

  private armyPass(b: Brain): void {
    this.prune(b);
    this.scoutEnemy(b);
    this.recruit(b);
    this.hold(b);
    // The base's own defences, and the wounded, before anything is aimed anywhere: a peon in a
    // burrow and a Grunt at a well are both decisions about home, and both are wrong to take
    // after the wave has already been pointed at something.
    const threatened = !!this.nearestThreat(b);
    this.burrowPass(b, threatened);
    // The statues are split EVERY pass, whatever the army is doing: a statue's job is to heal
    // the fight it is standing in, so unlike the Moon Well trip below this is not a decision
    // about being at home. (A statue trained mid-battle arrives with both autocasts off.)
    this.statuePass(b);
    // Only while MASSING. A well trip replaces whatever the unit was doing, so running this
    // during a fight would walk a Grunt at 60 % out of the battle line and across the base —
    // which is not healing, it is leaving. "When it returned to the base" is the whole
    // condition, and `massing` is what that is called here.
    if (b.mode === "massing" && !threatened) this.wellPass(b);
    // THE WOUNDED WALK OUT OF THE FIGHT, one at a time — before anything is aimed, because who
    // is in the line is what the aiming below is about. Above `defendPass` rather than inside a
    // mode branch: a Grunt on its last quarter is worth pulling out of a fight in the enemy's
    // base and out of one in its own, and `pullPass` reads the fight itself rather than the
    // mode. Inert on Easy (`pullOutHp` 0).
    this.pullPass(b);
    // …and so does a hero that has just WIND WALKED out of one, which is the same withdrawal
    // taken with a spell instead of with a pair of feet. After `pullPass`, so that the escape's
    // own entry is the one that stands rather than being overwritten by a pull-back a pass
    // later.
    this.escapePass(b);
    if (this.defendPass(b)) return;
    switch (b.mode) {
      case "defending": return void this.setMode(b, "massing"); // the threat is gone
      case "massing": return this.massing(b);
      case "attacking": return this.attacking(b);
      case "retreating": return this.retreating(b);
    }
  }

  /**
   * Everything that fights joins the army.
   *
   * Computer+ has no muster list: a ladder player attacks with what they have, and the size of
   * the attack is decided by the PRODUCTION ceiling (`PlusProfile.armyFood`) rather than by a
   * list of how many of each type a wave wants.
   *
   * The one exception is the unit that is both a soldier and a lumberjack — the Ghoul, which
   * is not `isPeon` and so is a fighter by every other test in the sim. The FOREST's crew is
   * held back (`lumberCrew`) and everything above it joins, which is undead.ai's own `AG`/`WG`
   * split (attack ghouls / wood ghouls) arrived at from the other direction.
   *
   * That crew is the ONLY thing held back, and it used to be two things. There was a second cap
   * here — a chopper was taken only while the squad was under `attackFood` — from before
   * `lumberCrew` existed, when it was the sole protection for the forest. Left in beside it, it
   * capped the undead's ARMY at a wave: every ghoul past the fourteen or sixteen food was left
   * standing in the trees, so the one race that pays for its army out of its forest was the one
   * race that could not attack with what it had built. It is also the rule this file's first paragraph
   * says it does not have. The forest's share is a share of the POOL now (`LUMBER_SHARE`), which
   * is what that cap was reaching for and states properly.
   */
  private recruit(b: Brain): void {
    const spare: SimUnit[] = [];
    for (const u of b.ai.army()) {
      if (b.squad.has(u.id) || u.isPeon) continue;
      if (u.worker) spare.push(u);
      else b.squad.add(u.id);
    }
    // A worker that cannot chop is not the forest's business at all: it is in the wave or it is
    // nothing. (Nobody's ordinary worker reaches here — `isPeon` took them out above.)
    for (const u of spare) if (!u.worker?.lumber) b.squad.add(u.id);
    // THE TWO ENDS OF ONE EXCHANGE, and every move below is between them: the choppers OUTSIDE
    // the wave with the freshest first, and the ones inside it with the most hurt first. Sorted
    // by health rather than taken in whatever order the world happened to yield them, because
    // WHICH ghoul walks each way is the developer's own rule — "send hurt ghouls to mine lumber
    // and get some healthy ghouls from lumber". A hurt ghoul is worth more on the trees than in
    // the line twice over: the party it leaves is priced off CURRENT hit points (plus/power.ts),
    // so the wave is stronger the moment the exchange is made rather than in the minute and a
    // half a Ghoul takes to heal itself — and it heals while it chops, since a Ghoul regenerates
    // 2 hp/s on BLIGHT and nowhere else (UnitBalance `regenType`) and the blight is where its
    // base is.
    const rested = spare.filter((u) => !!u.worker?.lumber).sort((x, y) => health(y) - health(x));
    const serving: SimUnit[] = [];
    for (const u of this.squadUnits(b)) if (u.worker?.lumber) serving.push(u);
    serving.sort((x, y) => health(x) - health(y));
    // Choppers currently outside the wave. Both directions below are stated against this one
    // number, so "let one go back to the forest" and "take one into the wave" are one rule
    // rather than two that can disagree.
    const want = this.lumberCrew(b);
    let free = rested.length;
    // Short of the crew — take them back OUT of the wave, the most hurt first.
    let out = 0;
    while (free < want && out < serving.length) {
      b.squad.delete(serving[out++].id);
      free++;
    }
    // …and everything above the crew joins it, the freshest first.
    let inn = 0;
    while (free > want && inn < rested.length) {
      b.squad.add(rested[inn++].id);
      free--;
    }
    // THE RELIEF: one for one, a hurt ghoul goes back to the trees and a rested one takes its
    // place. The crew is the same size afterwards, so this is not the rule above in another
    // guise — it is which BODIES are on which side of it, and it is the whole of what a player
    // is doing when they pull a ghoul at half health out of the party and send a fresh one.
    //
    // Only at HOME, and that is not a detail: a relief in the field is two lone ghouls walking
    // in opposite directions across a melee map, one of them wounded, and the creep camp between
    // them eats both. `massing` at home is also exactly when a player does it.
    //
    // The lists are sorted, so the exchange is always the worst-off for the best-off and the
    // loop stops of its own accord at the first pair not worth swapping. `out`/`inn` are where
    // the two rules above left off, so nobody is moved twice in one pass.
    if (b.mode === "massing" && !b.afield) {
      const swaps = reliefCount(serving.slice(out).map(health), rested.slice(inn).map(health));
      for (let k = 0; k < swaps; k++) {
        b.squad.delete(serving[out + k].id);
        b.squad.add(rested[inn + k].id);
      }
    }
  }

  /**
   * How many LUMBERJACKS the forest keeps back from the wave — the undead's Ghoul, and nobody
   * else's anything.
   *
   * The BANK's half of it is `undead.ai`'s own rule and its number is the game's: *"the forest
   * keeps however many the LUMBER stock says (10 minus a ghoul per 120 wood) and everything left
   * over attacks"* (undead.ai 205-219, ported at `UNDEAD_AI.waveGate` in src/ai/undead.ts). It
   * self-regulates, which is why it is worth taking whole rather than picking a constant: by the
   * time there is a thousand lumber in the bank every ghoul fights. The other half — never more
   * than a THIRD of the ghouls, whatever the bank says — is ours, and is what undead.ai states
   * from the wave's side in its opening branch instead. See `LUMBER_SHARE`, and note that
   * without it this rule read "with nothing banked every ghoul chops", which in an OPENING is
   * the whole army standing in the forest and a hero with nobody to creep with.
   *
   * Without it Computer+ had NO ghoul split at all. `recruit` takes anything that fights, a
   * Ghoul is not `isPeon` and so is a fighter by every test in the sim, and the undead opens
   * with one — so the wave claimed every ghoul the moment it was trained, `captainHeld` kept
   * `applyHarvest` off it, and an undead computer chopped no lumber for the entire match. It is
   * the one race whose lumber comes out of its army, and the one race that has to say so.
   *
   * Asked of the DATA rather than of the race: if this player's ordinary workers can chop
   * (`WorkerState.lumber` — a Peasant, a Peon, a Wisp), nothing has to be held back and the
   * answer is zero. Only a race whose worker cannot — the Acolyte, `uaco` `lumber: false` — ever
   * reaches the formula, so a custom map that gives its acolytes an axe is answered correctly
   * without a list of races anywhere.
   */
  private lumberCrew(b: Brain): number {
    let choppers = 0;
    for (const u of this.host.world.units.values()) {
      if (u.owner !== b.ai.player || u.hp <= 0 || !u.worker?.lumber) continue;
      if (u.isPeon) return 0; // the ordinary workers chop — this is not that race's problem
      choppers++;
    }
    return lumberCrew(b.ai.wood(), choppers);
  }

  /**
   * Look at the enemy — and remember it.
   *
   * Every hostile unit currently under this player's OWN eyes is noted (`AiPlayer.knows`, which
   * for Computer+ is never the fog cheat), and the read taken off that memory is what
   * `buildableMix` re-weights the army against. So the countering is only ever as good as the
   * scouting: an opponent this computer has not looked at is an opponent it does not counter.
   *
   * Skipped entirely at a difficulty that does not counter, since nothing would read it.
   */
  private scoutEnemy(b: Brain): void {
    if (b.profile.counterWeight <= 0) return;
    // Who to pass a sighting on to, worked out once rather than per sighting — see `teammates`.
    const team = this.teammates(b);
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.owner === b.ai.player || u.building) continue;
      // A PLAYER's army, not the map's. `hostileTo` is true of creeps too — and it should be,
      // they are hostile — but a creep camp is not a build order to answer: reading them in
      // made Echo Isles look like a seventy-unit Heavy-armour army before either player had
      // made a soldier, and the whole mix would have been re-weighted against the map.
      if (u.isCreep || u.owner < 0 || u.owner >= MELEE.MAX_PLAYERS) continue;
      if (!b.ai.hostileTo(u) || !b.ai.knows(u)) continue;
      b.memory.note(u, b.clock);
      for (const other of team) {
        // A sighting is only news to somebody it is an enemy OF. Always true on a team, and
        // not in a free-for-all with a lopsided matrix, where an ally's enemy may be our
        // friend — countering a player we are not fighting is countering nothing.
        if (other.ai.hostileTo(u)) other.memory.note(u, other.clock);
      }
    }
    b.memory.forget(b.clock, b.profile.counterMemory);
    b.enemy = b.memory.read(b.profile.counterShare, (id) => this.host.registry.get(id));
  }

  /**
   * SCOUTING INTELLIGENCE: what one ally has seen, the whole team has seen.
   *
   * Without this, every computer on a team pays for the same scout — three of them each walk a
   * worker into the same base to learn the same thing, and the one that dies on the way (which
   * latches `scoutDone`, see `Brain.scoutId`) plays the rest of the match against an opponent it
   * never looked at. A team that shares what it knows is most of what a team IS, and it is what
   * a person does the moment they see something: they say so.
   *
   * This is NOT a fog bypass, and the distinction is the one the whole file turns on. The
   * sighting being passed on was made through somebody's own eyes — `knows`, and Computer+ never
   * sets `bypassFog` — so what travels here is a fact one player LEARNED, exactly as a typed
   * "they're going gryphons" would be. Nothing is learned that nobody saw.
   *
   * It only runs between COMPUTER+ players, because they are the only ones with a memory to pour
   * into. A human teammate's scouting reaches an AI ally by the engine's own route instead: a
   * melee force grants ALLIANCE_SHARED_VISION, so `AiPlayer.knows` is already looking through
   * the human's units as well as its own, and the loop above notes what it finds there.
   *
   * Timestamped with the RECEIVER's clock rather than the sharer's. They are the same number
   * today (every seat is seated on the same frame), and writing it this way means they do not
   * have to be — a sighting always ages out on the clock of the memory holding it.
   *
   * This half is the ADDRESS BOOK — which computers a sighting travels to. The passing on itself
   * is one line in `scoutEnemy`, where the sighting is made.
   */
  private teammates(b: Brain): Brain[] {
    const me = b.ai.player;
    const out: Brain[] = [];
    for (const other of this.brains) {
      if (other === b || other.gone) continue;
      // A difficulty that does not counter has no use for a sighting and no memory to keep it
      // in — `scoutEnemy` returns before reading one for the same reason (Easy, `counterWeight`).
      if (other.profile.counterWeight <= 0) continue;
      if (this.host.coAllied(me, other.ai.player)) out.push(other);
    }
    return out;
  }

  /** Who the economy may not touch: the army and the scout, in one live set. */
  private hold(b: Brain): void {
    b.held.clear();
    for (const id of b.squad) b.held.add(id);
    if (b.scoutId) b.held.add(b.scoutId);
  }

  /**
   * Go and LOOK.
   *
   * Computer+ never bypasses the fog (see the file header), so this is the only way it can
   * find out about an enemy expansion — `AiPlayer.enemyExpansion` is gated on `knows`, and
   * `knows` for this AI means "under my own eyes". One worker, one tour: round the outside of
   * the nearest enemy's main base, then the other enemy START LOCATIONS, then home
   * (`scoutWaypoint`). It is not replaced when it dies, which is both what a player does and
   * what stops a computer feeding workers to a creep camp.
   *
   * AND IT COMES HOME ALIVE. Three separate rules, because the scout was dying three separate
   * ways: it stands off a base's CENTRE rather than its doorstep (`SCOUT_STANDOFF`), it gives
   * the leg up rather than walking a step that is inside a creep's notice (`CREEP_BERTH`), and
   * it abandons the tour the moment it is shot at or something that shoots comes near
   * (`SCOUT_DANGER`). The third is the one no geometry could have covered: where the scout
   * MEANT to stand says nothing about where the enemy army decided to walk.
   */
  private scoutPass(b: Brain): void {
    if (!b.profile.scout || b.scoutDone) return;
    const scout = b.scoutId ? this.host.world.units.get(b.scoutId) : null;
    if (b.scoutId && (!scout || scout.hp <= 0 || scout.owner !== b.ai.player)) {
      // NOBODY FOLLOWS IT. One scout is sent, ever, and a scout that does not come back is not
      // replaced — which is what a player does, and what stops a computer feeding its economy
      // to the same creep camp one worker at a time. This briefly allowed a second (the map is
      // worth 75 gold, went the argument) and the second walked into whatever killed the first:
      // the tour is the same tour, so the replacement dies at the same camp, and the cost is
      // paid by whoever can least afford it. A WISP is a 120-hitpoint lumberjack whose lumber
      // is credited in the tree it is standing at (docs/night-elf.md), so a night elf lost a
      // third of its forest crew to a walk it had already learnt nothing from.
      //
      // What the AI loses by not looking again is countering, expanding and creeping running
      // off an older read of the enemy — and that is `EnemyMemory`'s whole job, plus a
      // teammate's sightings arriving through `shareIntel`.
      b.scoutId = 0;
      b.scoutDone = true;
      b.scoutGoal = null;
      b.scoutWas = null;
      b.scoutBack = false;
      return;
    }
    if (!scout) {
      if (b.clock < SCOUT_AT) return;
      const worker = this.freeWorker(b);
      if (!worker) return;
      b.scoutId = worker.id;
      b.scoutLeg = 0;
      b.scoutGoal = null;
      b.scoutWas = { x: worker.x, y: worker.y };
      b.scoutStill = 0;
      b.scoutSince = b.clock;
      b.scoutHp = worker.hp;
      return;
    }
    // IT RUNS AT THE FIRST SCRATCH. A worker has no answer to anything it can meet out there,
    // so the only question a hit raises is whether the tour is worth dying for, and it never
    // is: what is left to look at is worth less than the worker, and a scout that walks home
    // hurt has already delivered everything it saw on the way in. Read off the HP falling
    // rather than off a damage event, because "am I being shot at" is a question the order
    // system cannot answer and a comparison against last pass can.
    //
    // ONLY ONCE IT HAS LEFT, and that clause is not a detail: a rush standing in our own base at
    // the sixtieth second would otherwise end the tour before the worker had taken a step, and
    // a tour ended at home is a tour that never happened. Being shot at at home is the defence
    // pass's business (`defendPass`), not the tour's. It also means the scan below is only ever
    // run by a scout that is actually out.
    const home = b.ai.home();
    const away = Math.hypot(scout.x - home.x, scout.y - home.y) > TOWN_RADIUS;
    if (away) {
      if (scout.hp < b.scoutHp) this.headHome(b);
      // …and it does not wait to be hit when it can see what is coming — see `SCOUT_DANGER`.
      else if (this.scoutInDanger(b, scout)) this.headHome(b);
    }
    b.scoutHp = scout.hp;
    // THE TOUR HAS A DEADLINE — see `SCOUT_TOUR`. Every other way out of this routine is an
    // event, so a tour whose events never arrive holds a worker out of the economy for the
    // rest of the match. Written as "start walking home" rather than as a special case, so it
    // goes back to work exactly as a finished tour does.
    if (b.clock - b.scoutSince >= SCOUT_TOUR) this.headHome(b);
    // …and the WALK HOME has one of its own, because it is a walk and walks can fail. Measured
    // from when the walk STARTED rather than from the tour's start, since the tour can end at
    // any point in it — a scout that turns for home at ninety seconds must not be held to a
    // deadline pinned to the two-and-a-half-minute one it never reached. Past this the worker is
    // simply let go wherever it is standing: an idle worker in the wrong place is worth more
    // than a held one, and the harvest plan will at least give it a job.
    if (b.scoutBack && b.clock - b.scoutBackAt >= SCOUT_HOME_BY) return this.release(b);
    // IS IT ACTUALLY MOVING? The tour only ever advanced on arrival, so a scout that stopped
    // short of a waypoint — wedged behind a building, turned round by a creep it survived, left
    // holding a stale order — stood there for the rest of the match. See `SCOUT_STUCK_AFTER`.
    // Measured against the last position rather than against the order, because "has the order
    // gone stale" is a question no order can answer about itself.
    const moved = b.scoutWas ? Math.hypot(scout.x - b.scoutWas.x, scout.y - b.scoutWas.y) : Infinity;
    if (moved >= SCOUT_PROGRESS) {
      b.scoutWas = { x: scout.x, y: scout.y };
      b.scoutStill = 0;
    } else {
      b.scoutStill += SCOUT_PERIOD;
    }
    const stuck = b.scoutStill >= SCOUT_STUCK_AFTER;
    if (stuck) {
      // Write the waypoint off and take the next one. A leg it cannot reach in eight seconds is
      // a leg something is in the way of, and the tour's whole value is the ones after it.
      b.scoutLeg++;
      b.scoutGoal = null;
      b.scoutWas = { x: scout.x, y: scout.y };
      b.scoutStill = 0;
    } else if (b.scoutGoal) {
      // LOOKING AT a place and GETTING TO it are different questions, and the walk home is the
      // second one. `lookedAt` counts "the next safe step is nowhere" as arrival, which is
      // right for a leg whose whole purpose is the look — and catastrophic for the walk home,
      // where it would release the worker in the middle of the map the first time a camp stood
      // between it and its own base. Home is a place it has to actually reach.
      const there = b.scoutBack
        ? Math.hypot(scout.x - b.scoutGoal.x, scout.y - b.scoutGoal.y) <= SCOUT_ARRIVED
        : this.lookedAt(scout, b.scoutGoal);
      if (there) {
        if (b.scoutBack) return this.release(b);
        b.scoutLeg++;
      } else if (scout.order === "move") return; // still walking
    }
    let goal = b.scoutBack ? b.ai.home() : this.scoutWaypoint(b);
    // NO WAYPOINT is two different things and only one of them ends the tour. A tour that has
    // run off the end of its legs is finished; a tour that cannot name leg 0 because there is
    // nothing to look at yet (no start location, no enemy building this player can find) is
    // simply not ready — and latching on THAT, which is what this used to do, switched
    // scouting off for the whole match on the first pass it ran.
    if (!goal) {
      if (b.scoutLeg === 0) { b.scoutGoal = null; return; }
      this.headHome(b);
      goal = b.ai.home();
    }
    b.scoutGoal = goal;
    // THE STEP, in four parts — and the GOAL is unchanged by all of them: the tour still visits
    // what it set out to visit, and what is re-decided every `SCOUT_PERIOD` is only the next
    // stride towards it.
    const creeps = this.liveCreeps();
    // (1) BACK OUT OF WHAT IS ALREADY TOO CLOSE, before anything else is decided.
    //
    // `safeLeg` cannot route round a creep that is already inside the berth of where we stand —
    // it deliberately drops those from the detour (no waypoint avoids them, and leaving them in
    // scores every candidate equally badly), so a scout that has blundered inside a camp's
    // notice is handed a step computed as though that camp were not there, and walks straight
    // on into it. That is the Wisp that "hugged a creep camp and died on the way home", and it
    // is not a walk-home bug: the same hole is on every leg.
    //
    // A player turns and walks OUT. So does this: away from the pooled bearing of everything
    // inside the berth — pooled rather than nearest, so a scout between two of them steps out
    // on one consistent bearing instead of alternating between their two answers — and far
    // enough that the next pass is comfortably clear, at which point `safeLeg` can see the
    // camp again and will arc round it properly.
    //
    // Only once it has left home (`away`), for the same reason the retreat rules are: a camp
    // near our own base must not stop the tour before it starts.
    const out = away ? backOffSpot(scout, creeps, home) : null;
    if (out) {
      b.ai.order({ c: "order", unitId: scout.id, order: { kind: "move", ...out }, queued: false });
      return;
    }
    // (2) ROUND the creep camps, not through them — see `safeLeg`. The GOAL is unchanged (the
    // tour still visits what it set out to visit); what is re-aimed is the step taken towards
    // it, which is re-asked every `SCOUT_PERIOD`, so the scout walks an arc round a camp rather
    // than a line into one.
    const step = safeLeg(scout, goal, creeps);
    // (3) …AND, ON THE WAY OUT, IT TAKES NO FOR AN ANSWER. `safeLeg` hands back the BEST leg it
    // found, which is not always a SAFE one: a camp between us and the waypoint with no room to
    // go round it still yields a step that walks inside its notice, and the scout took it —
    // which is most of "it still aggroes creep camps sometimes". Being offered a step that is
    // not clear is a reason not to take it. (1) has already guaranteed we are standing clear of
    // everything, so this is only ever about the ground ahead.
    //
    // IT WAITS; IT DOES NOT BURN THE LEG. Giving the leg up here is what made the tour
    // evaporate: nothing about the position changes when the scout stands still, so the very
    // next pass re-decided the same refusal for the NEXT leg, half a second later, and the
    // whole itinerary was spent in about a second and a half — the scout turned for home
    // before it had walked anywhere. ("The acolyte came home before reaching the enemy base",
    // twice.) `SCOUT_STUCK_AFTER` is already the right answer to "this waypoint is not
    // happening": eight seconds of no progress writes ONE leg off, at a rate a tour survives.
    //
    // THE WALK HOME IS EXEMPT, and it has to be. There is no next leg to fall through to and no
    // watchdog that can help — it writes off a waypoint, and the waypoint was never the problem
    // — so refusing here meant refusing to move at all, for ever, which is the "all the scouts
    // froze in the middle of the map" report. Between walking past a camp and standing in the
    // open until the match ends, a player walks past the camp; (1) is what keeps that honest,
    // and the retreat rule above is already pointed at home if it costs a hit.
    if (!b.scoutBack && clearance(scout, step, creeps) < CREEP_BERTH) return;
    // (4) A STEP OF NOWHERE IS NOT AN ORDER. `standOff` clamps a goal that is itself inside a
    // creep's berth back to "do not move" (which is the honest answer for a leg whose whole
    // purpose was to approach that goal), and a camp parked near our own base makes it the
    // answer for HOME too — so the walk home was ordered to the spot it was already standing
    // on, completed instantly, and re-decided identically next pass. Walking straight at the
    // hall and letting the pathfinder deal with it is the right trade here for the same reason
    // (3)'s exemption is.
    const stride = Math.hypot(step.x - scout.x, step.y - scout.y);
    const aim = b.scoutBack && stride < SCOUT_STRIDE ? goal : step;
    b.ai.order({ c: "order", unitId: scout.id, order: { kind: "move", ...aim }, queued: false });
  }

  /**
   * Is something that could kill the scout within `SCOUT_DANGER` of it?
   *
   * A PLAYER's armed unit — the enemy army walking out to meet it, a tower that went up while
   * it was looking. A worker is not a threat (it is what the scout itself is) and neither is an
   * unarmed building, or the tour would abandon itself on the first Farm it saw.
   *
   * **CREEPS ARE NOT ASKED ABOUT HERE**, and leaving them in was what made the whole tour
   * pointless: a melee map's camps sit on exactly the ground between two bases, `safeLeg` gives
   * them a 900 berth but hands back its BEST attempt rather than a guarantee, and 700 of best
   * effort is a very ordinary result — so the scout turned round and went home on the first
   * camp it walked past, every game, usually before it had seen anything. Creeps already have
   * two rules of their own and they are the right two: the berth arcs the route round them
   * (`safeLeg`, re-asked twice a second), and if one does acquire the scout anyway its health
   * goes down and `scoutPass`'s first rule sends it home. What this rule is FOR is the thing no
   * berth can be computed against — a player's army, which chose to be there.
   *
   * Gated on `knows` like everything else this AI decides on: at 700 the scout's own eyes
   * (sight 800) already cover it, so this is honest by construction rather than by promise —
   * but saying it in the code means a later change to the radius cannot quietly turn it into
   * a fog bypass.
   */
  private scoutInDanger(b: Brain, scout: SimUnit): boolean {
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.owner === b.ai.player || u.weapons.length === 0) continue;
      if (u.isCreep || u.owner < 0 || u.owner >= MELEE.MAX_PLAYERS) continue; // see above
      if (u.isPeon || !b.ai.hostileTo(u) || !b.ai.knows(u)) continue;
      if (Math.hypot(u.x - scout.x, u.y - scout.y) <= SCOUT_DANGER) return true;
    }
    return false;
  }

  /**
   * Tour over: WALK HOME. Not "released", and not one move order either.
   *
   * This used to fire a single `safeStep` toward home and latch `scoutDone` on the same line,
   * and both halves of that were wrong in the same way — the tour stopped being managed at the
   * exact moment the scout still had the whole map to cross:
   *
   *  • `safeStep` hands back a STEP, and when a camp is on the way that step is a detour
   *    waypoint thrown out SIDEWAYS from the line home. So the order the scout was released
   *    with was not "go home" at all: it was "walk to a point in the middle of the map", and
   *    that is where the worker stopped and where the harvest plan then found it. That is the
   *    "they came back and started chopping miles from the hall" report — the scout never came
   *    back at all.
   *  • Nothing re-asked the route, so every creep camp the walk home passed was passed blind.
   *    The way OUT was arc'd round camps twice a second and the way BACK was a straight line
   *    through them, which is the "scouts don't avoid creeps on the way home" report, and it is
   *    the more expensive direction: a scout that dies on the way out has at least looked.
   *
   * So the walk home is a LEG like any other. It keeps the scout `held` (the economy may not
   * re-task a worker that is halfway across the map), it is re-aimed every `SCOUT_PERIOD`
   * through the same `safeLeg` arcs, and the worker is handed back to the harvest plan only by
   * `release`, standing at its own hall, where the plan is good at placing it.
   *
   * Idempotent: the deadline and both retreat rules re-fire every pass while the scout is on
   * its way, and a second call must not restart the leg it is already walking.
   */
  private headHome(b: Brain): void {
    if (b.scoutBack) return;
    b.scoutBack = true;
    b.scoutBackAt = b.clock;
    b.scoutGoal = null;
    b.scoutStill = 0;
  }

  /** Home, or out of patience: hand the worker back to the economy. */
  private release(b: Brain): void {
    b.scoutId = 0;
    b.scoutDone = true;
    b.scoutGoal = null;
    b.scoutWas = null;
    b.scoutBack = false;
  }

  /**
   * Has the scout LOOKED at this leg — which is not the same question as "has it stood on it".
   *
   * Two ways to have looked, and the second is the one the tour needs. Standing within
   * `SCOUT_ARRIVED` of the waypoint is the obvious one. The other is standing as close to it as
   * the creeps guarding it allow: `safeStep` stands the walk OFF a camp sitting on the
   * destination rather than walking into it (see `standOff`), so a leg something has camped on
   * hands back a step of nowhere once the scout has reached the edge of the berth. Reading that
   * as arrival is what makes standing off a decision instead of a stall: without it the scout
   * stood at the edge of the camp doing nothing until `SCOUT_STUCK_AFTER` wrote the leg off
   * eight seconds later, every leg, every game.
   */
  private lookedAt(scout: SimUnit, goal: { x: number; y: number }): boolean {
    if (Math.hypot(scout.x - goal.x, scout.y - goal.y) <= SCOUT_ARRIVED) return true;
    const step = this.safeStep(scout, goal);
    return Math.hypot(scout.x - step.x, scout.y - step.y) <= SCOUT_ARRIVED;
  }

  /**
   * The next step towards `to` that does not walk into a creep camp.
   *
   * `safeLeg` does the geometry; this is the half that has the host and can say where the creeps
   * are. Only ones still ALIVE count — a cleared camp is ground — and their positions are map
   * data rather than anything this player has had to see (the AI is on the authority's side of
   * the fog for creep camps exactly as the engine always was; `AiPlayer.creepCamp` reads the
   * same table).
   *
   * EVERY CREEP, not the camp's centre, and that one word is most of why the berth was not
   * working. A camp is a CLUSTER — `CreepCamps` links guard posts up to `CAMP_LINK` (600) apart
   * and hands back their centroid (src/game/minimapView.ts) — so a six-Gnoll camp spans a good
   * 1200, and giving its CENTRE a 900 berth walks the scout 300 from the Gnoll on the near edge.
   * That is well inside `MiscGame` AcquisitionRange, one of them shouts (`CreepCallForHelp`) and
   * the whole camp comes. Asking the same 900 of each creep in turn is the berth the constant
   * always claimed to be.
   *
   * Their CURRENT position rather than their guard post, because a creep chasing something else
   * is a creep whose acquisition circle has moved with it.
   */
  private safeStep(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number } {
    return safeLeg(from, to, this.liveCreeps());
  }

  /** Every creep still standing, as points — the haystack `safeStep` and `scoutPass` both
   *  measure a berth against. See `safeStep` for why it is every MEMBER and not the camp. */
  private liveCreeps(): Array<{ x: number; y: number }> {
    const creeps: Array<{ x: number; y: number }> = [];
    for (const camp of this.host.creepCamps()) {
      for (const id of camp.members) {
        const c = this.host.world.units.get(id);
        if (c && c.hp > 0) creeps.push({ x: c.x, y: c.y });
      }
    }
    return creeps;
  }

  /**
   * THE ITINERARY: every enemy START LOCATION, nearest to us first.
   *
   * This is what a melee player's first worker walks, and it is the map's own list rather
   * than anything this player has had to see — `PlusHost.startLocations` says at length why
   * reading it is not a fog bypass (`AiPlayer.knows` already exempts the enemy main for
   * exactly the same reason, and the classic AI's waves have always walked to them).
   *
   * Ordered by distance from HOME rather than from the scout, so the list a leg is indexed
   * into does not reshuffle underneath the tour as the worker walks along it.
   */
  private scoutStops(b: Brain): Array<{ x: number; y: number }> {
    const me = b.ai.player;
    const home = b.ai.home();
    return this.host.startLocations()
      .filter((s) => s.player !== me && !this.host.coAllied(me, s.player))
      .map((s) => ({ x: s.x, y: s.y, d: Math.hypot(s.x - home.x, s.y - home.y) }))
      .sort((p, q) => p.d - q.d)
      .map(({ x, y }) => ({ x, y }));
  }

  /**
   * The tour: around the OUTSIDE of the nearest enemy's main base, then the OTHER enemy start
   * locations.
   *
   * The first `SCOUT_RING_LEGS` legs are points on a ring of `SCOUT_STANDOFF` about that base's
   * centre — never the centre itself, which is the middle of somebody's army. The first is on
   * the bearing the scout is already coming from (our home), because that is the side it
   * reaches first and walking round to a far side to begin is a walk past the whole base; the
   * next two step off it by `SCOUT_ARC` either way, so the base is looked at from three angles
   * on the side it arrived from.
   *
   * THEN THE OTHER START LOCATIONS, and this replaces the GOLD MINES the tour used to finish
   * on. Two things were wrong with the mines and only one of them was tuning:
   *
   *  • A melee map's gold mines are GUARDED, every one of them. The tour therefore ended by
   *    aiming a lone worker at a creep camp — `standOff` was written to stop it walking all
   *    the way in, but a leg whose whole purpose is to approach a camp is a leg spent standing
   *    at the edge of one, and every pass that misjudged the berth was paid for with the scout.
   *  • They are not what the scout is FOR. What a person wants out of the first worker is the
   *    opponents' bases — who is where, what race, what they have built — and on a melee map
   *    that is precisely the start locations. An expansion is read off the same walk anyway:
   *    an enemy hall standing somewhere the map promised nobody is what `AiPlayer.knows` and
   *    `enemyExpansion` are looking for, and the route between two start locations passes the
   *    ground between them.
   *
   * Each of them is STOOD OFF exactly as the first base is (`scoutRing` leg 0), so the rule
   * "a scout looks at a base, it does not walk into one" holds for the whole tour and not only
   * for its opening.
   */
  private scoutWaypoint(b: Brain): { x: number; y: number } | null {
    const home = b.ai.home();
    const stops = this.scoutStops(b);
    // A custom map with no start locations to read, or a lobby that named none: fall back to
    // whatever enemy building this player can name, and the ring is then the whole tour.
    let base: { x: number; y: number } | null = stops[0] ?? null;
    if (!base) {
      const found = b.ai.enemyBase();
      base = found ? { x: found.x, y: found.y } : null;
    }
    if (!base) return null;
    if (b.scoutLeg < SCOUT_RING_LEGS) return scoutRing(base, home, b.scoutLeg);
    // Leg SCOUT_RING_LEGS is the SECOND start location — the first one is what the ring was
    // drawn round — and so on until the map runs out of enemies, which ends the tour.
    const next = stops[b.scoutLeg - SCOUT_RING_LEGS + 1];
    return next ? scoutRing(next, home, 0) : null;
  }

  /**
   * A worker with nothing important in its hands — who gets sent to go and look.
   *
   * "Off the field" rather than `inMine` alone (`isOffField`, the sim's own answer): a Wisp
   * inside an Entangled Gold Mine and a Peon inside a Burrow are as busy as a Peasant down a
   * shaft, and pulling one of THEM out to walk across the map is the same mistake
   * `AiPlayer.freeWorker` made with the builder.
   *
   * THE SPARE FIRST, THEN THE FOREST, AND THE GOLD CREW LAST — a preference and not a filter,
   * because a player with nothing but miners still sends one. It used to be "the first worker
   * this player owns", with a comment claiming a scout comes off the trees, and on three races
   * that comment happened to be true: a gold worker is inside the shaft or inside the Entangled
   * Gold Mine, so `isOffField` had already skipped it and the first body left standing was a
   * lumberjack.
   *
   * THE UNDEAD IS THE RACE THAT BREAKS IT, and it breaks it completely. An Acolyte does not go
   * anywhere — it kneels in a ring in the OPEN around a Haunted Gold Mine (`Abgm`,
   * docs/undead.md), so it is on the field by every test this had, and the first Acolyte in the
   * world's own iteration order is Acolyte number one, a member of the crew of five. The tour
   * therefore took a fifth of the undead's entire income and left the SIXTH Acolyte — the spare
   * the build ladder trains for exactly this (`SPARE_WORKERS`, plan.ts: *"the one a player keeps
   * out of the mine to put up buildings with and to send to go and look"*) — standing in the
   * base for the whole match. `onGold` is what closes that hole, and it asks the question the
   * undead's way as well as everybody else's.
   */
  private freeWorker(b: Brain): SimUnit | null {
    let spare: SimUnit | null = null;
    let chopper: SimUnit | null = null;
    let miner: SimUnit | null = null;
    for (const u of this.host.world.units.values()) {
      if (u.owner !== b.ai.player || u.hp <= 0 || !u.isPeon) continue;
      if (u.buildPending || u.constructing || isOffField(u)) continue;
      if (b.held.has(u.id)) continue; // already the scout, or standing in the wave
      if (onGoldDuty(u)) miner ??= u;
      else if (u.order === "harvest") chopper ??= u;
      else spare ??= u;
    }
    return spare ?? chopper ?? miner;
  }



  /**
   * Something is in one of our towns.
   *
   * The DELAY is the difficulty: `defendDelay` is fifteen seconds on Easy and one on Insane, so
   * the same raid gets you four workers against one computer and nothing against another. Once
   * it does look up, everything comes home — including a wave that was halfway to the enemy,
   * because a base is worth more than a trade.
   */
  private defendPass(b: Brain): boolean {
    const threat = this.nearestThreat(b);
    if (!threat) {
      b.threatSince = -1;
      return false;
    }
    if (b.threatSince < 0) b.threatSince = b.clock;
    if (b.clock - b.threatSince < b.profile.defendDelay) return false;
    if (b.mode !== "defending") {
      this.setMode(b, "defending"); // …which zeroes the re-issue clock, so the turn is immediate
      b.target = null;
    }
    this.recommit(b, threat.x, threat.y);
    return true;
  }

  /**
   * Waiting with the army, until there is enough of it and the clock allows.
   *
   * **Not always at home.** The muster point is the captain's own feet whenever the party is
   * already out with another camp in front of it (`muster`), which is what turns creeping into
   * a tour rather than a series of round trips: a party that has just cleared a camp used to be
   * walked all the way back to the rally point, re-gathered there and sent out again, so most
   * of a Computer+ army's match was spent walking past its own base. Home is what it falls back
   * to — when the captain is hurt, when the party is not strong enough for anything left on the
   * map, or when there is nothing left to take.
   */
  private massing(b: Brain): void {
    // Asked BEFORE the rally orders, because what it answers is what those orders are for.
    const camp = this.creepNext(b);
    const rally = this.muster(b, camp);
    for (const u of this.squadUnits(b)) {
      // A hero walking to a shop is left alone. The errand is only re-issued every SHOP_PERIOD,
      // so a rally order in between would send it back and it would arrive at neither. Same for
      // one walking to a DROP (`getitem`): the loot pass re-issues on its own clock, and a
      // rally order in between is what left the tomes on the grass.
      if (u.id === b.items.errand || u.order === "getitem") continue;
      if (Math.hypot(u.x - rally.x, u.y - rally.y) <= RALLY_SLACK) continue;
      if (u.order === "move" || u.order === "attack") continue;
      b.ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: rally.x, y: rally.y }, queued: false });
    }
    // NOTHING LEAVES UNTIL THE ARMY IS TOGETHER. This gate is above both the creep run and the
    // wave because it is the same rule for both, and because the creep run is where its absence
    // actually hurt: `creepFood` is eight food on Insane, which is reached the moment the
    // fourth soldier is TRAINED — so the party set off from the production line rather than
    // from the muster point, with the hero somewhere behind it, and walked into a camp in
    // ones. See `COHESION_RADIUS` for the other half of the same idea, on the road.
    if (!this.gathered(b, rally)) return;
    // Creeping is NOT an attack and does not wait behind the attack's clocks — see
    // `PlusProfile.creepAt` for what waiting behind them did to it.
    if (camp) return void this.creepGo(b, camp);
    if (!this.waveReady(b)) return;
    // The reset goes BEFORE the ask rather than after it. `pickTarget`'s rung 1 answers with a
    // CAMP and marks the wave a creeping party when it does, and clearing the flag on the line
    // after the call quietly undid that: a wave sent to a camp was then priced, ended and
    // retreated from as if it were an assault on a player — including spending the hero's
    // Scroll of Town Portal to leave creeps, which `ItemCtx.portalWorthIt` exists to prevent.
    b.creeping = false;
    const target = this.pickTarget(b);
    if (!target) return;
    b.target = target;
    this.setMode(b, "attacking");
    this.commit(b, target.x, target.y);
  }

  /** Are the WAVE's own clocks open — is there an attack to be preferred over a camp? One
   *  question in one place, because `creepNext` has to ask it too and the two must agree. */
  private waveReady(b: Brain): boolean {
    const { profile } = b;
    if (b.clock < profile.firstAttack) return false;
    if (b.clock - b.lastWaveEnd < profile.waveGap) return false;
    return this.squadFood(b) >= profile.attackFood;
  }

  /**
   * Where the army waits — its own captain while it is out creeping, the home rally otherwise.
   *
   * Also WRITES `Brain.afield`, because the same fact decides the errands that only make sense
   * at home: a hero sent shopping from the middle of the map walks away from the party it is
   * leading (`itemCtx.mayShop`).
   */
  private muster(b: Brain, camp: { x: number; y: number } | null): { x: number; y: number } {
    const at = camp ? this.afieldAt(b) : null;
    b.afield = !!at;
    return at ?? this.rally(b);
  }

  /**
   * Where the party IS, once it has left town — the captain's feet, or null while it is home.
   *
   * "Out" is measured against the town's own radius rather than against the rally point: a
   * party standing among its own buildings is at home whatever it is doing, and one that is a
   * screen past them is on the map.
   */
  private afieldAt(b: Brain): { x: number; y: number } | null {
    const captain = this.squadHero(b);
    if (!captain) return null;
    const home = b.ai.home();
    if (Math.hypot(captain.x - home.x, captain.y - home.y) <= TOWN_RADIUS) return null;
    return { x: captain.x, y: captain.y };
  }

  /**
   * Is enough of the wave standing at the muster point to set off?
   *
   * Measured in FOOD rather than in bodies, like every other size question here, and against
   * the food that would actually leave (`squadFood` — the wounded are not in it, and neither is
   * a unit that is still healing). A squad with nothing in it is not "gathered": the callers
   * have their own size gates and this must not answer yes to an empty field.
   */
  private gathered(b: Brain, rally: { x: number; y: number }): boolean {
    let total = 0;
    let here = 0;
    for (const u of this.squadUnits(b)) {
      if (isCopy(u) || this.recovering(u)) continue;
      const food = this.host.registry.get(u.typeId)?.foodUsed ?? 0;
      total += food;
      if (Math.hypot(u.x - rally.x, u.y - rally.y) <= GATHER_RADIUS) here += food;
    }
    if (total <= 0) return false;
    if (here >= total * GATHER_SHARE) {
      b.gatherSince = -1;
      return true;
    }
    // IT GIVES UP WAITING. A gate with no deadline is a deadlock, and this one deadlocked in
    // the way that costs the most: a single soldier that cannot reach the muster point — stuck
    // behind a building, walled in by its own base, chasing something — holds the WHOLE army at
    // home, hero included, and the reported symptom was exactly that ("the AI is moving the
    // hero to its base and locking it there instead of going out to creep"). A player waits a
    // few seconds for their army to bunch up and then leaves with what came.
    if (b.gatherSince < 0) b.gatherSince = b.clock;
    return b.clock - b.gatherSince >= GATHER_PATIENCE;
  }

  /**
   * Take the hero creeping — the GATES and the camp in one question.
   *
   * Asked twice on a massing pass and deliberately so: once to decide where the army musters (a
   * party with another camp in front of it does not walk home first — `muster`) and once to set
   * off with it. It answers null the moment any gate closes, so the two askings cannot disagree.
   *
   * Everything here is a gate on the CAPTAIN, because that is what the run is for: a creep camp
   * is experience, and experience goes on the hero. A party without one is a party trading
   * soldiers for nothing, which is the state this used to reach whenever the hero was dead or
   * still in the altar — so `squadHero` is required rather than merely preferred, and the run
   * ends the moment it is gone (`attacking`). It also refuses to start on a hurt hero: a camp
   * entered at a third life is a dead hero, and a dead hero is the most expensive thing on a
   * melee map. It heals at home and goes again.
   *
   * WHICH camp is `creepTarget`'s business, and it is priced rather than measured in food:
   * a party is compared against the camp COLOUR the game itself paints (plus/power.ts), so a
   * hero and two soldiers go to a green camp and nobody walks into a red one.
   */
  private creepNext(b: Brain): { x: number; y: number; level: number } | null {
    const { profile } = b;
    if (!profile.creeps || b.clock < profile.creepAt) return null;
    const hero = this.squadHero(b);
    if (!hero) return null;
    // THE LEVEL CAP IS A PREFERENCE, not an ability. Past it a camp is worth less to the hero
    // than the enemy's base is — so the party goes to the base, but only when it can actually
    // go NOW. Applied unconditionally it produced the thing the developer asked us to stop: a
    // level-six hero standing at the rally point behind `waveGap` with three camps still on the
    // map and nothing whatever to do for two minutes.
    if (hero.level >= CREEP_UNTIL_LEVEL && this.waveReady(b)) return null;
    if (hero.hp / Math.max(1, hero.maxHp) < CREEP_HEALTH) return null;
    if (this.squadFood(b) < profile.creepFood) return null;
    return this.creepTarget(b);
  }

  /** Set off — the commit half of a creep run, once `creepNext` has said which camp. */
  private creepGo(b: Brain, camp: { x: number; y: number; level: number }): void {
    b.target = { id: 0, x: camp.x, y: camp.y };
    b.creeping = true;
    b.creepLevel = camp.level;
    this.setMode(b, "attacking");
    this.commit(b, camp.x, camp.y);
  }

  /**
   * The camp this party may actually take, or null.
   *
   * Two halves, and the second one is new. `creepForce` prices the party — fighter food behind
   * the hero, the hero's level, and how healthy the whole thing is — and `maxCampLevel`
   * (plus/power.ts) turns that into the hardest camp COLOUR it is allowed to walk into. The
   * ceiling then goes to `AiPlayer.creepCamp` exactly as the old food number did, so the AI
   * still takes the NEAREST camp it can handle rather than shopping around.
   *
   * Asked from both places a camp is chosen (`creepNext` starts a run, `pickTarget` aims a wave
   * that has no better idea) so the two cannot disagree — which they did, and which is how a
   * party that `creepNext` had refused to send was sent anyway a moment later.
   */
  private creepTarget(b: Brain): { x: number; y: number; level: number } | null {
    const ceiling = maxCampLevel(this.creepForce(b));
    if (ceiling < 0) return null;
    const air = this.hasAir(b);
    // NEAREST TO THE PARTY, not to the base it left. A party that has just cleared a camp is
    // standing on the map, and "the camp nearest home" from out there is usually the one it
    // has to walk past its own front door to reach — which is most of why a Computer+ army
    // spent its match commuting. Home is still the answer while it is at home.
    const from = this.afieldAt(b) ?? b.ai.home();
    if (b.shunned.length) b.shunned = b.shunned.filter((s) => s.until > b.clock);
    const skip = (camp: { x: number; y: number }): boolean => isShunned(b.shunned, camp, b.clock);
    // NEAREST FIRST, and the search widens rather than being one sweep of the whole map.
    // `creepCamp` already answers with the nearest camp inside the level window, but "nearest"
    // over the whole map still walks a party clean across it when the two camps beside home are
    // one point too hard — and a party that is walking is a party that is neither creeping nor
    // defending. Stepping the radius out means a camp next door is always taken first, and the
    // long walk is only ever offered once nothing closer is left.
    for (const reach of CREEP_REACH) {
      const camp = b.ai.creepCamp(CREEP_FLOOR, ceiling, air, reach, from, skip);
      if (camp) return camp;
    }
    return null;
  }

  /**
   * The party, priced — what plus/power.ts reads.
   *
   * The wounded are left out of the food for the same reason `squadFood` leaves them out: a unit
   * `commit` will not move is not in the party. They ARE in the health fraction, because a squad
   * that is half-hurt is exactly the squad that should not be walking into a camp — leaving them
   * out of both would let a party heal itself by ignoring its casualties.
   */
  private creepForce(b: Brain): CreepForce {
    const fighters: Fighter[] = [];
    let hp = 0;
    let maxHp = 0;
    const captain = this.squadHero(b);
    for (const u of this.squadUnits(b)) {
      if (isCopy(u)) continue;
      hp += Math.max(0, u.hp);
      maxHp += Math.max(1, u.maxHp);
      if (u.isHero || this.recovering(u)) continue;
      fighters.push({ dps: this.dpsOf(u), hp: Math.max(0, u.hp), maxHp: Math.max(1, u.maxHp) });
    }
    return {
      fighters,
      heroLevel: captain?.level ?? 0,
      heroHealth: captain ? captain.hp / Math.max(1, captain.maxHp) : 0,
      health: maxHp > 0 ? hp / maxHp : 0,
    };
  }

  /**
   * A unit's damage per second, as the party's power is priced from (plus/power.ts).
   *
   * The mean of the weapon's own roll (`damage` + `dice` × (`sides` + 1) / 2 — WC3's base plus
   * NdS, which is why an upgrade that adds a DIE widens the spread) over its cooldown, off the
   * unit's LIVE `SimWeapon`, so upgrades, auras and buffs are all already in it.
   *
   * The best enabled slot rather than the sum: a unit does not fire both weapons at once, and
   * a Dragonhawk's dormant second attack is not damage it is dealing. A worker's harvest
   * "weapon" scores near nothing on its own and needs no special case.
   */
  private dpsOf(u: SimUnit): number {
    let best = 0;
    for (const w of u.weapons) {
      if (!w.enabled || w.cooldown <= 0) continue;
      const mean = w.damage + (w.dice * (w.sides + 1)) / 2;
      best = Math.max(best, mean / w.cooldown);
    }
    return best;
  }

  /**
   * Is this creep run lost — break off and walk home?
   *
   * **A different question from `canClearCamp`, and deliberately a much lower bar.** That one
   * asks "is this party good enough to START this fight", and re-asking it mid-fight aborts
   * every run the moment the first soldier is scratched: a party is always weaker after it has
   * begun, so a run judged by the starting bar can never be finished. This one asks the thing a
   * player actually asks — *is this going badly enough to leave?* — and there are two ways to
   * answer yes:
   *
   *  · **the GROUP is broken** (under `CREEP_ABORT_HP` of its hit points). At that point the
   *    party is losing units rather than trading them, whatever the camp has left.
   *  · **the CAPTAIN is nearly dead and the camp is not** — under `CREEP_ABORT_HERO` while the
   *    camp still holds more than `CAMP_STILL_UP` of its own hit points. The second half is
   *    what stops it running from a fight it has all but won: a hero at 15 % standing over the
   *    last creep on a sliver finishes it and collects the experience, where the same hero at
   *    15 % in front of a fresh camp is a dead hero. A dead hero is the most expensive thing on
   *    a melee map, and it is also the whole reason the party was there.
   */
  private fightLost(b: Brain): boolean {
    if (b.mode !== "attacking") return false;
    const force = this.creepForce(b);
    if (force.health < ABORT_GROUP_HP) return true;
    // No captain at all: for a creep run `attacking` has already ended it; for an assault on a
    // player this is a broken army in somebody else's base.
    if (force.heroLevel < 1) return b.creeping;
    if (force.heroHealth >= ABORT_HERO_HP) return false;
    return this.oppositionHealthy(b);
  }

  /**
   * Is what we are fighting still strong enough that leaving is the right answer?
   *
   * The second half of `fightLost`, and it is what stops the army running from a fight it has
   * all but won: a hero at 15 % standing over the last creep on a sliver finishes it and
   * collects the experience, where the same hero at 15 % in front of a fresh camp is a dead
   * hero. Two ways of asking it, because the two kinds of opposition report themselves
   * differently:
   *
   *  · a CREEP CAMP is a fixed roster, so it can be measured directly — `campHealthAt` is the
   *    fraction of its own hit points still standing;
   *  · a PLAYER's army is not a roster we can enumerate (their dead units are simply gone), so
   *    it is priced instead: the enemy we can SEE around the group, through the same
   *    `armyPower` metric the party itself is priced by (plus/power.ts). Still outgunning us is
   *    what "still healthy" means about an opponent.
   */
  private oppositionHealthy(b: Brain): boolean {
    if (b.creeping) {
      const camp = b.target;
      return !camp || b.ai.campHealthAt(camp.x, camp.y) > CAMP_STILL_UP;
    }
    const centre = this.squadCentre(b) ?? this.squadHero(b);
    if (!centre) return true;
    const foes: Fighter[] = [];
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.building || u.owner === b.ai.player) continue;
      if (!b.ai.hostileTo(u) || !b.ai.knows(u)) continue;
      if (Math.hypot(u.x - centre.x, u.y - centre.y) > CLEARED_RADIUS) continue;
      foes.push({ dps: this.dpsOf(u), hp: Math.max(0, u.hp), maxHp: Math.max(1, u.maxHp) });
    }
    if (!foes.length) return false; // nothing left in front of us: the fight is over, not lost
    return armyPower(foes) > armyPower(this.creepForce(b).fighters);
  }

  /** Break off, and REMEMBER WHAT FROM — the one thing the hero's Scroll of Town Portal turns
   *  on (`itemCtx`). Creeps do not chase and will still be there in two minutes; an army does,
   *  and a hero walking away from one usually does not get home. */
  private retreat(b: Brain, from: "creeps" | "player"): void {
    b.retreatFrom = from;
    b.retreatSince = b.clock;
    this.setMode(b, "retreating");
  }

  /** On the way, and once there. */
  private attacking(b: Brain): void {
    if (!b.squad.size) return void this.endWave(b);
    // A creep run is FOR the hero, so it is over the moment the hero is not in it — dead, or
    // pulled home by something else. Carrying on would be trading soldiers for experience
    // nobody is left to collect.
    // THE CAPTAIN IS DEAD: fall back. A creep run is FOR the hero, so with the hero gone the
    // party is trading soldiers for experience nobody is left to collect — and it is standing in
    // a camp that has just proved it can kill a hero. `retreating` rather than `endWave`, which
    // is the difference between WALKING HOME and merely being told the wave is over: `endWave`
    // drops the party into `massing`, whose rally order is skipped for anything already fighting
    // (`u.order === "attack"`), so the soldiers stayed in the camp and died in it one by one.
    if (b.creeping && !this.squadHero(b)) {
      this.retreat(b, "creeps");
      return;
    }
    // …and it BREAKS OFF a fight that has gone badly — the other half of not suiciding into
    // one. ONE rule for both kinds of fight (`fightLost`), and note it is a different question
    // from `canClearCamp`, which is the bar for STARTING a creep run.
    if (this.fightLost(b)) {
      this.retreat(b, b.creeping ? "creeps" : "player");
      return;
    }
    if (b.profile.retreatHp > 0 && this.readiness(b) < b.profile.retreatHp) {
      this.retreat(b, b.creeping ? "creeps" : "player");
      return;
    }
    const target = b.target;
    if (!target) return void this.endWave(b);
    if (b.creeping) {
      // A CREEP RUN IS OVER WHEN THE CAMP IS DEAD, and that is a question about the CAMP rather
      // than about a radius drawn round where it stood. Asked the generic way — "is anybody
      // standing at the goal, and is nothing hostile within `CLEARED_RADIUS` of it" — the run
      // could not end at all in two ordinary cases, and the party then stood on the cleared
      // camp for the rest of the match:
      //
      //  · the camps NEXT DOOR. Clustering links creeps whose guard posts are within 600
      //    (`CAMP_LINK`), so two distinct camps only have to be a little further apart than
      //    that — well inside the 900 this was asking about. The neighbours are outside their
      //    own acquisition range (500) and nobody walks at anybody: the wave is neither
      //    fighting nor finished, for ever. Orange camps are the ones this happens to because
      //    they are the big sprawling ones, and on a melee map they are the ones with a second
      //    camp beside them guarding a shop or an expansion.
      //  · a party that STOPPED SHORT of the centroid — a camp in a nook, cohesion holding the
      //    leaders behind a captain that is itself blocked — so no unit is ever within the 600
      //    `atGoal` wants and the run never ends however dead the camp is.
      //
      // `campHealthAt` is the same measure `oppositionHealthy` already prices a run by, off the
      // fixed camp table, so this cannot disagree with what the run was sent at.
      if (b.ai.campHealthAt(target.x, target.y) <= 0) return void this.endWave(b);
    } else if (target.id) {
      const u = this.host.world.units.get(target.id);
      if (!u || u.hp <= 0) return void this.endWave(b);
      target.x = u.x;
      target.y = u.y;
    } else if (this.atGoal(b, target) && !this.enemyNear(b, target.x, target.y, CLEARED_RADIUS)) {
      return void this.endWave(b);
    }
    // …AND NOTHING WAITS FOR EVER. Every end condition above is a statement about the objective,
    // and none of them can answer "we are never going to get there" — see `PUSH_STUCK_AFTER`.
    if (this.stalled(b)) return void this.abandon(b);
    // Asked BEFORE the re-commit, because what it decides is what that commit does: while a
    // vanguard is out, `commit` walks the copies in and leaves the body standing.
    this.vanguardPass(b, target);
    this.recommit(b, target.x, target.y);
  }

  /**
   * THE ILLUSIONS GO IN FIRST.
   *
   * A Wand of Illusion (`will`, `[AIil]`) makes a double that fights, is swung at, and hurts
   * nothing whatever — `DataA "Damage Dealt (%)"` is 0 and `DataB "Damage Received"` is 2
   * (docs/illusions.md). So the one thing it is worth is the OPENING of a fight: a camp's whole
   * roster acquires whoever walked in first, and for `VANGUARD_LEAD` that is a copy rather than
   * the hero the run is for. This throws them, and holds the party back long enough for it to mean
   * something.
   *
   * Four conditions, and each is a different way of wasting a charge:
   *
   *  · **A creep run, and an ORANGE or RED one.** A green camp is priced at a hero and a soldier
   *    or two (plus/power.ts) and takes no casualties worth a charge; the wand has three for the
   *    whole match. `creepLevel` is the camp's own combined level, which is the number the game
   *    itself paints the minimap dot with.
   *  · **Once per run.** Marked done whether or not anything was pressed, so a hero with no wand
   *    is not re-asked every army pass and a hero with one does not dribble a fresh double into
   *    the walk every few seconds. What happens INSIDE the fight is the belt's own `illusion`
   *    rung (plus/items.ts), which has its own bar and its own cap.
   *  · **Near the camp.** A double lasts sixty seconds and conjuring one at the muster point
   *    spends most of that walking — see `VANGUARD_RANGE`.
   *  · **Something actually went in.** No press, no hold: standing the army still in front of a
   *    camp buys nothing at all if there is no vanguard to buy it for.
   *
   * The body is STOPPED rather than merely left out of the commit. Skipping it would leave every
   * soldier walking on under the attack-move it was already carrying, which is the party
   * arriving with the copies instead of behind them — the same order the hold is there to undo.
   * Anything already swinging is left alone: a unit in a fight is not walking into the camp, it
   * is in one, and stopping it is how a Grunt turns its back on something.
   */
  private vanguardPass(b: Brain, target: { x: number; y: number }): void {
    if (!b.creeping || b.vanguardDone || b.creepLevel <= CAMP_GREEN_MAX) return;
    const hero = this.squadHero(b);
    if (!hero || Math.hypot(hero.x - target.x, hero.y - target.y) > VANGUARD_RANGE) return;
    b.vanguardDone = true;
    if (b.items.makeIllusions(hero) <= 0) return;
    // Armed, but the clock is not started here — `commit` restarts it when the copies actually
    // set off, which is a pass later (see `VANGUARD_LEAD`). This value is only what keeps the
    // hold up until then. The re-issue clock is zeroed so that pass is the very next army pass
    // rather than up to `REISSUE_PERIOD` away.
    b.vanguardUntil = b.clock + VANGUARD_LEAD + VANGUARD_SPAWN_GRACE;
    b.reissueIn = 0;
    for (const u of this.squadUnits(b)) {
      if (isCopy(u) || u.inCombat) continue;
      b.ai.order({ c: "order", unitId: u.id, order: { kind: "stop" }, queued: false });
    }
  }

  /**
   * Is this wave going nowhere?
   *
   * The watchdog `gathered` has at the other end of the walk, and it is measured the same way:
   * against the group's own POSITION over time rather than against its orders, because an order
   * cannot tell you it has gone stale. The anchor is the captain for the same reason the
   * cohesion rule uses it — the centroid of a hero at a camp and six soldiers at home is a point
   * nobody is standing on.
   *
   * A group that is FIGHTING is not stuck, and the clock is reset for it — but that is asked of
   * the group's own swings (`fighting`) rather than of what is standing within a radius, because
   * the standoff is precisely the case where something IS nearby and nobody is walking at it.
   */
  private stalled(b: Brain): boolean {
    const anchor = this.squadHero(b) ?? this.squadCentre(b);
    if (!anchor) return false;
    return pushStalled(b.push, anchor, b.clock, this.fighting(b, anchor));
  }

  /**
   * Is any of this group actually in a fight?
   *
   * Asked of the units rather than of a radius, because an attack-move does NOT change a unit's
   * order when it engages — `tickAttackMove` sets `targetId` and swings with `order` still
   * "attackmove" — so "is it fighting" is `targetId` plus `inCombat`, exactly as the sim itself
   * records it. The radius is only the fallback for the moment before contact: something inside
   * a soldier's own acquisition is a fight about to start.
   */
  private fighting(b: Brain, anchor: { x: number; y: number }): boolean {
    for (const u of this.squadUnits(b)) {
      if (u.inCombat) return true;
      if (!u.targetId) continue;
      const t = this.host.world.units.get(u.targetId);
      if (t && t.hp > 0 && b.ai.hostileTo(t)) return true;
    }
    return this.enemyNear(b, anchor.x, anchor.y, COHESION_COMBAT);
  }

  /** Write this objective off — and REMEMBER it, or the next massing pass hands the party the
   *  same unreachable camp and the watchdog becomes a loop instead of a decision (`CAMP_SHUN`).
   *  Only a camp is shunned: the enemy's base is not somewhere the AI may decide to stop going. */
  private abandon(b: Brain): void {
    if (b.creeping && b.target) b.shunned.push({ x: b.target.x, y: b.target.y, until: b.clock + CAMP_SHUN });
    this.endWave(b);
  }

  /** Broken, and going home to heal. */
  private retreating(b: Brain): void {
    const home = b.ai.home();
    let allHome = true;
    for (const u of this.squadUnits(b)) {
      if (Math.hypot(u.x - home.x, u.y - home.y) <= TOWN_RADIUS / 2) continue;
      allHome = false;
      if (u.order !== "move") {
        b.ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: home.x, y: home.y }, queued: false });
      }
    }
    if (!b.squad.size || (allHome && this.readiness(b) >= REGROUP_HP_FRACTION)) return void this.endWave(b);
    // …AND IT GIVES UP WAITING, for the same reason `gathered` does — see `REGROUP_PATIENCE`
    // for the two ways this state never ends on its own. `massing` is not "go and attack": it
    // is where the decision to creep, to attack or to keep waiting is taken, and every one of
    // those gates is still in front of a party that got here broken.
    if (b.clock - b.retreatSince >= REGROUP_PATIENCE) this.endWave(b);
  }

  /**
   * Re-state the army's order, but only every `REISSUE_PERIOD`.
   *
   * A fresh order RESTARTS a unit's path, so a squad re-committed on every army pass — twice a
   * second at the top difficulty — walks on the spot. `commit` itself is immediate and is what
   * a state TRANSITION calls (`setMode` zeroes the clock, so the first order after a change of
   * mind goes out at once); this is what the steady state calls.
   */
  private recommit(b: Brain, x: number, y: number): void {
    if ((b.reissueIn -= b.profile.armyPeriod) > 0) return;
    this.commit(b, x, y);
  }

  /**
   * Point the army at a spot — and, at the top difficulty, at a UNIT.
   *
   * `focusFire` is the clearest "this AI micros" tell there is: instead of every soldier
   * attack-moving and picking its own nearest target, the whole group is aimed at the one enemy
   * worth killing first (`worth`), which is a hero, then a spellcaster, then — when raiding —
   * a worker. An attack-move is still what everyone else gets, because a group that is ordered
   * onto one unit and nothing else walks past the thing killing it.
   */
  private commit(b: Brain, x: number, y: number): void {
    const focus = b.profile.focusFire ? this.focusTarget(b, x, y) : null;
    // WHERE THE ARMY IS, for the cohesion rule below — and it is the CAPTAIN when there is one.
    //
    // "The army follows its hero" is the developer's own framing and it is a better anchor than
    // a centre of mass for the reason a centroid always is: the centroid of a hero at a creep
    // camp and six soldiers at home is a point in the middle of the map that nobody is standing
    // on and nobody should walk to. Anchoring on the captain makes the same rule say the right
    // thing — the soldiers close on the hero, and the hero itself is held back by it whenever
    // IT is the one out in front, which is the case that gets a hero killed.
    //
    // Cohesion holds a marching army together; it must NOT hold a defence back. Something is
    // standing in the base, everyone who can reach it should be swinging at it, and a Grunt
    // that is "ahead of the group" on the way home is a Grunt that got there first.
    const centre = b.mode === "defending" ? null : this.armyAnchor(b);
    // …AND THE CAPTAIN IS NOT EXEMPT FROM ITS OWN RULE. `armyAnchor` IS the captain whenever
    // there is one, so `strayed` measured against it is a distance of zero for the captain: the
    // one unit cohesion never held back was the hero, which is the unit whose death loses the
    // game and the unit most likely to be out in front, because it is usually the fastest thing
    // in the group. A Blademaster under Wind Walk is 10-70 % faster again (`[AOwk]` DataB), and
    // it showed: "the Blademaster seems to be using Windwalk to leave its army and go and fight
    // another creep camp while its army is currently fighting another one." The hero is held to
    // the BODY — the rest of the squad, itself left out — so the same rule can be asked of it.
    const captain = centre ? this.squadHero(b) : null;
    const body = captain ? this.squadCentre(b, captain.id) : null;
    // THE ILLUSIONS ARE IN FRONT, ON PURPOSE — see `vanguardPass`. For the length of the lead
    // the only thing this commit moves is the copies; the body was stopped where it stands and
    // nothing here may start it walking again.
    const vanguard = b.vanguardUntil > b.clock;
    for (const u of this.squadUnits(b)) {
      if (vanguard) {
        if (!isCopy(u)) continue;
        // Straight at the camp, and no cohesion: being out ahead of the anchor is the whole
        // job, and `strayed` would walk every copy back to the hero it is supposed to be
        // walking in front of. The re-issue guard is `commit`'s own, for the same reason — an
        // attack-move restated every pass is a full path search per copy.
        if (u.order === "attackmove" && Math.hypot(u.amDestX - x, u.amDestY - y) <= REISSUE_SLACK) continue;
        b.ai.order({ c: "order", unitId: u.id, order: { kind: "attackmove", x, y }, queued: false });
        // THE LEAD IS MEASURED FROM HERE — this copy has just been pointed at the camp, and the
        // press is the wrong moment to count from (see `VANGUARD_LEAD`). `min`, never `max`:
        // the deadline may only ever come in, so a copy that reaches the camp, idles and is
        // re-ordered cannot keep pushing it out and hold the army still for the rest of the
        // match. `VANGUARD_SPAWN_GRACE` is what it is coming in FROM.
        b.vanguardUntil = Math.min(b.vanguardUntil, b.clock + VANGUARD_LEAD);
        continue;
      }
      // A unit that is HEALING is not ordered anywhere. It is standing in the base with a Salve
      // on it or its head in a Moon Well, and marching it out is what makes the heal pointless.
      // Nor is one two steps from a drop it is walking to — the loot pass only ever sends a
      // hero somewhere nothing hostile is standing (plus/items.ts `loot`), so this cannot leave
      // one wandering into a fight.
      // …and neither is one that has been WALKED OUT of the fight (`pullPass`). It is behind
      // the line on its own clock, and an attack-move issued over the top of that is the whole
      // army's order undoing one soldier's — which is how a pull-back becomes a see-saw.
      if (this.recovering(u) || u.order === "getitem" || pulledOut(b.pulls.get(u.id), b.clock)) continue;
      // THE ARMY MOVES AS ONE BODY. A unit that has pulled AHEAD of the group waits for it
      // instead of walking on — see `COHESION_RADIUS`, and note the two conditions that make
      // this a regroup rather than a leash: it only ever holds back the units in FRONT (the
      // ones behind are already being carried forward by the same order), and it never touches
      // a unit that is in a fight. The hero is not exempt: a hero out in front of its army is
      // the single most expensive thing on the map standing on its own.
      const anchor = captain && u.id === captain.id ? body : centre;
      if (anchor && this.strayed(b, u, anchor, x, y)) {
        // Already walking back to about there: leave it alone. A move order RESTARTS the path
        // search (the same cost the attack-move guard below is about), and the centre of mass
        // drifts by a few units every pass — so without this the whole tail of the army would
        // re-path every `REISSUE_PERIOD` for a destination that had not really moved. The end
        // of its current path IS its destination, which is the only place a plain move records
        // one.
        const end = u.order === "move" && u.path.length ? u.path[u.path.length - 1] : null;
        if (end && Math.hypot(end[0] - anchor.x, end[1] - anchor.y) <= REISSUE_SLACK) continue;
        b.ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: anchor.x, y: anchor.y }, queued: false });
        continue;
      }
      if (focus && !u.isPeon) {
        if (u.order === "attack" && u.targetId === focus.id) continue;
        b.ai.order({ c: "order", unitId: u.id, order: { kind: "attack", targetId: focus.id }, queued: false });
        continue;
      }
      // A unit already swinging at something is left alone: re-aiming a melee fighter at the
      // far end of a base every few seconds is how an army walks past what is killing it.
      //
      // …UNLESS what it is swinging at is a healthy enemy HERO, in which case it is broken off.
      // This is the anti-chase rule applied to the whole army rather than only to the focus-fire
      // path, and it had to be: `focusTarget` is the only other place that knows about heroes,
      // and it does not run below Insane (`focusFire`) — so on Normal nothing whatever stopped
      // the group parking on a hero it could not finish while the army that came with it killed
      // them. (Observed, and reported: "the AI units still focused the hero quite a lot".) The
      // hero premium in plus/targeting.ts is deliberately conditional on `heroKillable` for
      // exactly this reason; without this the ARMY had no such condition at all.
      if (u.order === "attack" && u.targetId) {
        const swap = this.stuckOnHero(b, u) ? this.besideHero(b, u) : null;
        if (!swap) continue;
        // Re-aimed at a BODY rather than merely released. An attack-move here would be
        // answered by the sim's own acquisition, which takes the NEAREST enemy — and the hero
        // it just walked away from is standing right there, so the group would pick it up
        // again on the next tick and this would be a four-second loop instead of a decision.
        b.ai.order({ c: "order", unitId: u.id, order: { kind: "attack", targetId: swap.id }, queued: false });
        continue;
      }
      // …and so is a unit already walking to this same spot. A re-issued attack-move
      // RESTARTS the search (SimWorld.issueAttackMove calls pathTo), so re-stating an order
      // nothing has changed about buys nothing and costs a full-map A* per soldier — the
      // session logs had `aiAttackPass` at 100-420 ms every REISSUE_PERIOD, which is a whole
      // wave re-pathing across the map inside ONE sim step (docs/perf-logging.md). A player
      // does not re-drag their army onto the same pixel every four seconds either; what the
      // re-issue is FOR is a target that has moved, and REISSUE_SLACK is how far it has to
      // have moved to be worth a new route. En-route acquisition is unaffected — that is
      // tickAttackMove's business and does not read the destination.
      if (u.order === "attackmove" && Math.hypot(u.amDestX - x, u.amDestY - y) <= REISSUE_SLACK) continue;
      b.ai.order({ c: "order", unitId: u.id, order: { kind: "attackmove", x, y }, queued: false });
    }
    // A vanguard is re-considered EVERY army pass rather than every `REISSUE_PERIOD`. The copies
    // do not exist yet when the wand is pressed — spawning is asynchronous, the request is
    // drained by the renderer (docs/illusions.md) — so the pass that throws them cannot also
    // order them, and waiting four seconds for the next one would spend most of the lead
    // standing still. It costs nothing: inside the window this loop only ever looks at the
    // copies, and their attack-move is not re-issued once it is pointed at the camp.
    b.reissueIn = vanguard ? 0 : REISSUE_PERIOD;
  }

  /**
   * Is this unit swinging at a HEALTHY enemy hero — one it is not going to finish?
   *
   * `heroKillable` is the game's own line (plus/targeting.ts `HERO_KILL_HP`): below it a hero is
   * the best target on the field and every blow is worth landing, above it a hero is a strong
   * soldier with an escape and a healer, and hitting one is hitting the enemy's most expendable
   * hit points. A unit stuck on the second kind is re-aimed by its caller.
   *
   * Not applied to a hero of OURS: our own hero picks its fights through the caster and the
   * ordinary acquisition, and a duel is sometimes the right answer for it.
   */
  private stuckOnHero(b: Brain, u: SimUnit): boolean {
    if (u.isHero) return false;
    const t = u.targetId ? this.host.world.units.get(u.targetId) : null;
    if (!t || !t.isHero || t.hp <= 0) return false;
    return !heroKillable(t) && b.ai.hostileTo(t);
  }

  /** Something else to hit: the nearest enemy body beside the hero this unit is stuck on. A
   *  building is a last resort rather than a target — walking off to punch a Farm while the
   *  fight goes on behind you is its own mistake — so one is only taken when nothing else is
   *  in reach at all, and a worker counts as somebody. */
  private besideHero(b: Brain, u: SimUnit): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = SWAP_LOOK;
    let fallback: SimUnit | null = null;
    for (const t of this.host.world.units.values()) {
      if (t.hp <= 0 || t.isHero || t.invulnerable || !b.ai.hostileTo(t)) continue;
      const d = Math.hypot(t.x - u.x, t.y - u.y);
      if (d > SWAP_LOOK) continue;
      if (t.building) {
        if (!fallback) fallback = t;
        continue;
      }
      if (d < bestD) { bestD = d; best = t; }
    }
    return best ?? fallback;
  }

  /**
   * The enemy the group should kill first, from around where it is fighting.
   *
   * The ladder is `killValue` (plus/targeting.ts) — the same one its casters aim by, which is
   * the point of that file: an army swinging at the Shaman while the Mountain King stuns the
   * Tauren is two decisions that undo each other.
   *
   * The second clause here is the ANTI-CHASE rule, and it is the whole answer to Blizzard's own
   * melee AI's worst habit: it drops everything to swing at the enemy hero, follows it out of
   * the fight, and loses the army to the units it walked past. A hero this group cannot finish
   * (`heroKillable`) and that has already pulled away from where the group is standing is not a
   * target at all — the ladder's hero premium only applies to one that is standing IN the
   * fight, or one that is nearly dead and worth the walk.
   */
  private focusTarget(b: Brain, x: number, y: number): SimUnit | null {
    const ctx = aimCtx(b.profile);
    const centre = this.squadCentre(b);
    let best: SimUnit | null = null;
    // -Infinity, NOT 0: the score is `worth × 1000 − distance`, and a Peasant nine hundred
    // units away scores below zero. Starting at zero silently means "only pick something
    // valuable AND close", which is not what the ladder says.
    let bestScore = -Infinity;
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.owner === b.ai.player || !b.ai.hostileTo(u)) continue;
      if (u.building || u.invulnerable) continue;
      const d = Math.hypot(u.x - x, u.y - y);
      if (d > CLEARED_RADIUS) continue;
      if (u.isHero && !heroKillable(u) && centre && Math.hypot(u.x - centre.x, u.y - centre.y) > HERO_CHASE) continue;
      const s = killValue(u, ctx) * 1000 - d;
      if (s > bestScore) { bestScore = s; best = u; }
    }
    return best;
  }

  /**
   * Has this unit run out in front of the army?
   *
   * Three conditions, and all three are needed. It is FAR from the group's centre of mass; it is
   * NEARER the objective than that centre is (so it is a leader rather than a straggler — a
   * straggler is already walking the right way); and there is nothing hostile beside it, because
   * a unit with an enemy in reach is fighting and pulling it out is not cohesion, it is
   * abandoning the fight one soldier at a time.
   *
   * The distance is measured from the CENTRE rather than between pairs, which is what makes it
   * a body rather than a chain: a group strung out along a road closes up towards its own
   * middle instead of each unit chasing the one in front.
   */
  private strayed(b: Brain, u: SimUnit, centre: { x: number; y: number }, x: number, y: number): boolean {
    // A COPY IS NEVER HELD BACK. Cohesion is about keeping the army's real bodies together so
    // they arrive as one; an illusion's entire job is to be the thing in front (`vanguardPass`),
    // and it costs nothing when it dies alone. Without this the doubles thrown ahead of a camp
    // are walked back to the captain the moment the lead expires — a pass short of contact, and
    // exactly the contact they were spent on.
    if (isCopy(u)) return false;
    const off = Math.hypot(u.x - centre.x, u.y - centre.y);
    if (off <= COHESION_RADIUS) return false;
    // A unit that is IN a fight is left in it — pulling it out is not cohesion.
    if (this.enemyNear(b, u.x, u.y, COHESION_COMBAT)) return false;
    // Far enough behind to be LOST rather than merely trailing: close on the captain instead of
    // attack-moving to an objective the group has already left it behind for. This is the half
    // that answers "army units stuck at base while the hero is out creeping alone" — a Grunt
    // trained after the party set off is a straggler by every measure, and the objective's own
    // attack-move walks it into the camp the party is already fighting in, one at a time.
    if (off > FOLLOW_RADIUS) return true;
    // …otherwise only the LEADERS wait: a unit nearer the objective than the anchor is.
    return Math.hypot(u.x - x, u.y - y) < Math.hypot(centre.x - x, centre.y - y);
  }

  /** Where the group actually is — the anti-chase rule measures from here rather than from the
   *  wave's objective, because "has it pulled away from us" is a question about the ARMY. */
  private squadCentre(b: Brain, exceptId = 0): { x: number; y: number } | null {
    let n = 0, sx = 0, sy = 0;
    for (const u of this.squadUnits(b)) {
      // The units still IN the line. One walked out of the fight (`pullPass`) is standing a
      // screen behind it by design, and letting it drag the centre back is how one wounded
      // Grunt re-aims the whole army at the ground behind itself.
      if (u.isPeon || isCopy(u) || pulledOut(b.pulls.get(u.id), b.clock)) continue;
      // …and one unit may be left out on purpose: `commit` asks where the BODY is in order to
      // hold the captain to it, and a captain measured against a centre it is itself half of is
      // a captain that can only ever be a fraction of its own lead out of position.
      if (u.id === exceptId) continue;
      sx += u.x; sy += u.y; n++;
    }
    return n ? { x: sx / n, y: sy / n } : null;
  }

  /**
   * What the wave is FOR.
   *
   * Four rungs, in the order a player thinks about them:
   *  0. whatever is SITTING ON the mine the build order has decided to take. `AiPlayer.takeExp`
   *     is set by `startExpansion` when it wants a town it cannot found yet and `expansionFoe`
   *     is what is in the way — which on a melee map is almost always a creep camp, since that
   *     is what expansions are guarded by. Without this rung a strategy's expansion clock fires
   *     for ever and the AI never takes a second mine at all (measured on Echo Isles: an insane
   *     orc past its own expansion time, still on one mine, with nothing trying to clear it).
   *     It is the classic captain's own second rung, for the same reason;
   *  1. a CREEP CAMP the army can handle, while the hero still has levels to gain from it
   *     (`PlusProfile.creeps` — an easy computer never creeps at all, which is most of why its
   *     hero stays level 1);
   *  2. an enemy EXPANSION, if we have actually seen one (`AiPlayer.knows`, and Computer+ never
   *     bypasses the fog — so this rung only exists once it has scouted or been attacked from
   *     there);
   *  3. the enemy's main base, which every melee player is handed and always knows.
   */
  private pickTarget(b: Brain): { id: number; x: number; y: number } | null {
    const { ai, profile } = b;
    if (ai.takeExp) {
      const foe = ai.expansionFoe();
      if (foe) {
        ai.takeExp = false; // asked and answered; `startExpansion` sets it again if still wanted
        return { id: foe.id, x: foe.x, y: foe.y };
      }
    }
    // The same rule `creepNext` states: no captain, no creeping. Reached when a wave is being
    // aimed rather than when a creep run is being started, and it must agree with it — an army
    // sent to a camp from here without a hero is the very thing `creepNext` refuses to do.
    const captain = this.squadHero(b);
    if (profile.creeps && captain && captain.level < CREEP_UNTIL_LEVEL) {
      const camp = this.creepTarget(b);
      if (camp) {
        b.creeping = true;
        b.creepLevel = camp.level;
        return { id: 0, x: camp.x, y: camp.y };
      }
    }
    const expansion = ai.enemyExpansion();
    if (expansion && !ai.isTowered(expansion)) return { id: expansion.id, x: expansion.x, y: expansion.y };
    const base = ai.enemyBase();
    return base ? { id: base.id, x: base.x, y: base.y } : null;
  }

  private endWave(b: Brain): void {
    b.target = null;
    b.creeping = false;
    b.retreatFrom = null;
    b.lastWaveEnd = b.clock;
    this.setMode(b, "massing");
  }

  private setMode(b: Brain, mode: Mode): void {
    b.mode = mode;
    b.reissueIn = 0;
    // A new objective is a fresh start for the stall watchdog, and nothing is mustering in the
    // field until the next massing pass says so.
    b.push.was = null;
    b.push.since = b.clock;
    b.afield = false;
    // A new objective is also a fresh vanguard: the old one's hold must not survive into a
    // retreat (it would stand the army still while it was supposed to be walking home), and the
    // next creep run gets its own attempt at throwing one.
    b.vanguardUntil = 0;
    b.vanguardDone = false;
    // A general retreat and a rally both SUPERSEDE one soldier's errand: both states issue a
    // destination of their own for every unit in the squad, and a stale pull-back entry would
    // either fight that order or hold the unit out of the wave that forms next.
    if (mode === "massing" || mode === "retreating") b.pulls.clear();
  }

  /** Where the army waits: in front of the base, on the line to the enemy. */
  private rally(b: Brain): { x: number; y: number } {
    const home = b.ai.home();
    const foe = b.ai.enemyBase();
    if (!foe) return home;
    const dx = foe.x - home.x;
    const dy = foe.y - home.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: home.x + (dx / len) * RALLY_OUT, y: home.y + (dy / len) * RALLY_OUT };
  }

  private *squadUnits(b: Brain): Generator<SimUnit> {
    for (const id of b.squad) {
      const u = this.host.world.units.get(id);
      if (u) yield u;
    }
  }

  /** The food a wave would actually LEAVE with — the wounded are not in it. Counting a unit
   *  that `commit` will not move is how a wave of four sets off believing it is a wave of ten. */
  private squadFood(b: Brain): number {
    let food = 0;
    for (const u of this.squadUnits(b)) {
      if (isCopy(u) || this.recovering(u) || pulledOut(b.pulls.get(u.id), b.clock)) continue;
      food += this.host.registry.get(u.typeId)?.foodUsed ?? 0;
    }
    return food;
  }

  /**
   * Is this unit HEALING, and so not to be walked into a fight?
   *
   * Three sources, one rule. A Healing Salve or a Scroll of Regeneration hangs a regeneration
   * buff (the sim's own `ITEM_REGEN_GROUP`, which is one prefix precisely so a single filter
   * catches the whole family — docs/items.md); a Moon Well pours into whoever it has been sent
   * (`drinkWellId`). All three pour over TIME, so the unit has to be left alone for it: a
   * soldier dosed and marched straight back out spends the effect being hit for more than it
   * regains, which is the same as not having healed it at all.
   *
   * It ends the way the developer asked for it to end — when the effect does, or at
   * `RECOVER_TO`, whichever comes first. The health test is checked FIRST because that is the
   * one that releases a unit early: a Salve on a lightly-hurt Grunt is done in ten seconds and
   * there is no reason to stand it in the base for the other thirty-five.
   */
  private recovering(u: SimUnit): boolean {
    if (u.hp / Math.max(1, u.maxHp) >= RECOVER_TO) return false;
    if (u.drinkWellId > 0) return true;
    return u.buffs.some((f) => f.group.startsWith(ITEM_REGEN_GROUP));
  }

  /**
   * Take the wounded to a Moon Well.
   *
   * The night elf's healing IS the Moon Well — there is no other source of it in the race — and
   * it is an autocast on a BUILDING, which is why the caster now arms those too
   * (plus/casting.ts). Arming is only half of it though: `Ambt`'s own `Area1` is 400, so a well
   * pours into whoever is STANDING at it, and an army waiting at the rally point three hundred
   * units in front of the base is not standing at it. This is the other half — the walk.
   *
   * Any race may do this: `isReplenisher` is the sim's own question and an Obsidian Statue
   * answers to it as well as a Moon Well.
   */
  /**
   * MICRO: a unit on its last quarter is walked out of the fight, and put back in later.
   *
   * The single most visible thing a player does that a computer does not, and it is a decision
   * about ONE unit rather than about the army — `retreatHp` is the wave giving up, this is a
   * Grunt stepping back out of range while the wave goes on winning without it. A body kept is
   * a body that fights in the NEXT engagement too, and the food it is standing in is food the
   * production ceiling (`armyFood`) would otherwise not give back.
   *
   * Three gates, and each answers a different way of getting this wrong:
   *
   *  • **The difficulty does this at all.** `pullOutHp` is 0 on Easy — issue #124's easy
   *    computer gives an order and watches it happen — so nothing here runs for it, and the map
   *    is cleared so a rung that stops microing does not leave a soldier standing out of play.
   *  • **It has to be IN a fight.** A hurt unit walking home across an empty map is not micro,
   *    it is desertion: without this, every soldier that ever dropped below the bar would spend
   *    the rest of the match at the back. `COHESION_COMBAT` is the same radius the cohesion rule
   *    means "this unit is in the battle" by, and the two must agree — one says do not drag a
   *    fighting unit back into formation, this one says drag exactly those out.
   *  • **It must not see-saw.** `pullDue`'s cooldown is the developer's "some sort of internal
   *    unit timer": a unit released at a hair under the bar wants pulling again immediately, and
   *    a rule with no memory is a soldier that walks in and out of the line for the rest of the
   *    battle instead of fighting in it.
   *
   * A general RETREAT supersedes all of it — `retreating` is already walking everybody home, and
   * a second destination for the same unit is two orders undoing each other.
   */
  private pullPass(b: Brain): void {
    if (b.profile.pullOutHp <= 0 || b.mode === "retreating") {
      b.pulls.clear();
      return;
    }
    // WHERE THE LINE IS. The same anchor `commit` holds the army together on — the captain when
    // there is one — so "behind the army" means the same place to both rules. A captain that is
    // itself out of the line does not count as one (see `armyAnchor`).
    const anchor = this.armyAnchor(b);
    for (const u of this.squadUnits(b)) {
      const entry = b.pulls.get(u.id);
      if (pulledOut(entry, b.clock)) {
        // Already out: keep it walking there, and nothing else. A unit that arrived is left
        // alone rather than re-ordered — a fresh move order restarts the path search, which is
        // the same cost `commit` guards against.
        if (entry && u.order !== "move" && Math.hypot(u.x - entry.x, u.y - entry.y) > PULL_BACK_ARRIVE) {
          b.ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: entry.x, y: entry.y }, queued: false });
        }
        continue;
      }
      // A worker is not part of the line (the scout and the harvest crew are the economy's, and
      // `recruit` keeps them out of the squad anyway), and a unit already being healed is
      // standing still on purpose — walking it somewhere is what `recovering` exists to stop.
      if (u.isPeon || isCopy(u) || this.recovering(u)) continue;
      if (!pullDue(entry, u.hp / Math.max(1, u.maxHp), b.profile.pullOutHp, b.clock)) continue;
      const foe = this.foeBeside(b, u, COHESION_COMBAT);
      if (!foe) continue; // not in a fight — there is nothing to walk out of
      const spot = pullBackSpot(u, foe, anchor);
      b.pulls.set(u.id, { x: spot.x, y: spot.y, until: b.clock + PULL_BACK_HOLD, next: b.clock + PULL_BACK_AGAIN });
      b.ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: spot.x, y: spot.y }, queued: false });
    }
  }

  /**
   * A hero that has just WIND WALKED out of a fight is walked out of it.
   *
   * The press is the caster's (plus/casting.ts `windWalk`); this is the other half of the same
   * decision, and without it the ability does nothing at all. `AOwk` is IMMEDIATE
   * (`SimWorld.castImmediate`): it fires on the spot and leaves the caster's current order
   * completely alone, so a hero that pressed it mid-fight fades and keeps swinging — the next
   * blow breaks the invisibility, and the escape was spent standing in the fight it meant to
   * leave. Reported in as many words: "it seems to like to use it and just stay in the fight
   * invisible."
   *
   * It leaves through `pulls` rather than through an order of its own, because that map is
   * already the one channel in this file that means *this unit is out of the fight and nothing
   * may re-order it*: `commit` skips it, `squadFood` does not count it, `pullPass` keeps it
   * walking, and — the clause that matters most here — `armyAnchor` refuses to anchor the army
   * on a captain that has withdrawn, so the army holds its ground instead of following its hero
   * home.
   *
   * HOME is the destination rather than `pullBackSpot`'s screen behind the line: a hero at
   * `HERO_KILL_HP` is not stepping out of range for ten seconds, it is going to where it can be
   * healed. It rejoins the way every other withdrawal does, when `WINDWALK_OUT` runs out.
   */
  private escapePass(b: Brain): void {
    const ids = b.caster.drainEscapes();
    if (!ids.length) return;
    const home = b.ai.home();
    for (const id of ids) {
      const u = this.host.world.units.get(id);
      if (!u || u.hp <= 0) continue;
      b.pulls.set(u.id, {
        x: home.x,
        y: home.y,
        until: b.clock + WINDWALK_OUT,
        // The same see-saw guard an ordinary pull-back gets, measured from the same place —
        // see `PULL_BACK_AGAIN`.
        next: b.clock + PULL_BACK_AGAIN,
      });
      b.ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: home.x, y: home.y }, queued: false });
    }
  }

  /**
   * WHERE THE ARMY IS — the captain, or the centre of mass of what is still in the line.
   *
   * "The army follows its hero" is the developer's own framing and a better anchor than a
   * centroid for the reason a centroid always is (see `commit`), with one exception this pass
   * created: a captain that has itself been pulled out of the fight is standing a screen behind
   * the line, and anchoring on it there would walk the whole army back after it — turning one
   * hurt hero into a general retreat nobody ordered. So a withdrawn captain is not one.
   */
  private armyAnchor(b: Brain): { x: number; y: number } | null {
    const hero = this.squadHero(b);
    if (hero && !pulledOut(b.pulls.get(hero.id), b.clock)) return hero;
    return this.squadCentre(b);
  }

  /** The nearest hostile within `radius` of this unit — "what is it fighting", as a body rather
   *  than as a yes/no. `enemyNear` is the same walk when only the answer is wanted. */
  private foeBeside(b: Brain, u: SimUnit, radius: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = radius;
    for (const t of this.host.world.units.values()) {
      if (t.hp <= 0 || t.owner === b.ai.player || t.invulnerable || !b.ai.hostileTo(t)) continue;
      const d = Math.hypot(t.x - u.x, t.y - u.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  private wellPass(b: Brain): void {
    const wells: SimUnit[] = [];
    for (const u of this.host.world.units.values()) {
      if (u.owner !== b.ai.player || u.hp <= 0) continue;
      if (!this.host.world.isReplenisher(u.id)) continue;
      // ARM IT. `Ambt` is in plus/casting.ts's `HAND_AUTOCAST` — the short list of autocasts
      // that file deliberately does NOT switch on for itself — which left the decision here,
      // and here never made it: a night elf's wells poured into nobody but the units this pass
      // explicitly walked to them. With autocast on, `tickReplenish`'s third rung tops up
      // whoever is standing at the well already, which is most of what a Moon Well does for a
      // player and all of what it does for an army that just walked home.
      this.arm(b, u, REPLENISH_CODE);
      if (u.mana > 0) wells.push(u);
    }
    if (!wells.length) return;
    // THE HERO FIRST, then the rest of the army. A well's mana is finite and a hero is worth
    // more than a Grunt is — sending them in squad order gave the hero whatever the soldiers
    // in front of it had not already drunk, which on one Moon Well is nothing.
    const hurt = [...this.squadUnits(b)].filter((u) => u.hp / Math.max(1, u.maxHp) < RECOVER_TO);
    hurt.sort((p, q) => (q.isHero ? 1 : 0) - (p.isHero ? 1 : 0));
    for (const u of hurt) {
      if (u.drinkWellId > 0) continue; // already on its way to one
      let best: SimUnit | null = null;
      let bestD = WELL_WALK;
      for (const w of wells) {
        const d = Math.hypot(w.x - u.x, w.y - u.y);
        if (d < bestD) { bestD = d; best = w; }
      }
      if (!best) continue;
      // The ORDINARY right-click on a friendly well: it walks there and the well pours when it
      // arrives (SimWorld.issueDrink). Not a second channel — the same order a player gives.
      b.ai.order({ c: "drink", unitId: u.id, wellId: best.id });
    }
  }

  /**
   * THE OBSIDIAN STATUES — one on life, one on mana.
   *
   * The undead's healing, and the reason `PlusRaceTable.always` exists (plus/races.ts). Both
   * abilities live on every statue and both draw on the SAME mana pool, so a statue with both
   * switched on does neither job well — which is why an undead player builds two and splits
   * them, and why this is a pass rather than one more line in `armAutocasts`.
   *
   * **Life first.** `Arpl` Essence of Blight is what keeps an army alive; `Arpm` Spirit Touch
   * only shortens the wait for the next spell. So the statues are walked in a stable order and
   * the first one gets life, the second mana, the third life again — a player with one statue
   * has it on Essence of Blight, always.
   *
   * The toggle is the ordinary autocast command, judged by the authority exactly as the
   * player's click on the same button is.
   */
  private statuePass(b: Brain): void {
    const statues: SimUnit[] = [];
    for (const u of this.host.world.units.values()) {
      if (u.owner !== b.ai.player || u.hp <= 0 || u.building) continue;
      if (!u.abilities.some((a) => a.code === STATUE_LIFE && a.level >= 1)) continue;
      statues.push(u);
    }
    statues.sort((p, q) => p.id - q.id); // stable, so a statue does not swap jobs every pass
    statues.forEach((u, i) => {
      const wants = i % 2 === 0 ? STATUE_LIFE : STATUE_MANA;
      const other = wants === STATUE_LIFE ? STATUE_MANA : STATUE_LIFE;
      this.arm(b, u, wants);
      this.disarm(b, u, other);
    });
  }

  /** Switch an autocast ON if it is off. `{ c: "autocast" }` is a TOGGLE, so both of these
   *  have to read the current state before pressing — an unconditional press every pass would
   *  flip the button twice a second. */
  private arm(b: Brain, u: SimUnit, code: string): void {
    const ab = u.abilities.find((a) => a.code === code && a.level >= 1);
    if (!ab || ab.autocastOn) return;
    b.ai.order({ c: "autocast", unitId: u.id, code });
  }

  private disarm(b: Brain, u: SimUnit, code: string): void {
    const ab = u.abilities.find((a) => a.code === code && a.level >= 1);
    if (!ab || !ab.autocastOn) return;
    b.ai.order({ c: "autocast", unitId: u.id, code });
  }

  /**
   * ORC BURROWS — the town bell the orcs have instead of a bell.
   *
   * A Burrow with peons in it shoots, which makes it the one structure in the game that a
   * worker turns into a tower. So when something is in the base, the workers go in.
   *
   * ONLY the LUMBER ones, and that is the whole point of doing it a peon at a time rather than
   * through the building's own Battle Stations button: `battleStations` gathers whatever
   * workers are nearest, which on a threatened base means the gold crew — and a gold mine that
   * stops paying for the fight it is funding is a bad trade for a few arrows. `resKind` is the
   * sim's own answer to "what is this worker on", and it outlives the trip home, so a peon
   * walking a load of lumber back still counts as a lumberjack.
   *
   * They come back out through `standdown`, which is the door that REMEMBERS the job
   * (`unloadBurrow(id, true)` → `resumeGarrisonJob`) — so a peon that went in chopping comes
   * out chopping, at the same tree, with no re-planning at all.
   */
  private burrowPass(b: Brain, threatened: boolean): void {
    const burrows: SimUnit[] = [];
    for (const u of this.host.world.units.values()) {
      if (u.owner !== b.ai.player || u.hp <= 0 || !u.building) continue;
      if (u.building.constructionLeft > 0 || u.garrisonCap <= 0) continue;
      // A BURROW, asked of the hold's own ability code rather than of "has a hold at all".
      // `Abun` is Load (Orc Burrow); the other worker-only hold in the game is `Aenc`, the
      // ENTANGLED GOLD MINE — five Wisps' worth of `garrisonCap` (`Aegm` Car1 = 5,
      // docs/night-elf.md) sitting on a finished building of ours, which this used to sweep up
      // as a burrow. The un-threatened branch below then stood the whole mine crew down every
      // army pass, the next build pass put them back through `applyHarvest`, and a night elf
      // computer spent the entire match marching its wisps in and out of its own gold mine
      // twice a second — which is not a cosmetic bug, it is most of the race's income.
      if (this.host.world.cargoHoldCode(u.typeId) !== BURROW_HOLD) continue;
      burrows.push(u);
    }
    if (!burrows.length) return;
    if (!threatened) {
      // The siege is over: everyone back to work, through the door that remembers the job.
      for (const bur of burrows) {
        if (bur.garrison.length) b.ai.order({ c: "standdown", buildingId: bur.id });
      }
      return;
    }
    for (const bur of burrows) {
      let room = bur.garrisonCap - bur.garrison.length;
      if (room <= 0) continue;
      for (const p of this.host.world.units.values()) {
        if (room <= 0) break;
        if (p.owner !== b.ai.player || p.hp <= 0 || !p.worker || p.inBurrow) continue;
        if (p.resKind !== "lumber") continue; // the gold crew keeps paying for the war
        if (p.insideBuild || p.constructing || p.inMine) continue;
        if (Math.hypot(p.x - bur.x, p.y - bur.y) > TOWN_RADIUS) continue;
        b.ai.order({ c: "garrison", unitId: p.id, buildingId: bur.id });
        room--;
      }
    }
  }

  /**
   * The CAPTAIN — the hero the army is built around.
   *
   * **The FIRST hero this player bought, then the second, then the third.** Not the highest
   * level, which is what this used to pick: the AI's own hero ORDER (`heroId`/`heroId2`/
   * `heroId3`, rolled at seat time from the strategy — see `pickHeroes`) is the order they were
   * trained in and therefore the order they are levelled and equipped in, so the first one is
   * the one that is ahead and the one the camps are being farmed for. When it dies the second
   * takes over, and when that dies the third — which is what the developer asked for, and it
   * also stops the captaincy CHANGING HANDS mid-run every time a second hero happens to ding:
   * `creepNext` gates on the captain's health and `attacking` ends the run when the captain is
   * gone, and both of those become nonsense if "the captain" moves around.
   *
   * Falls back to any hero in the squad, so a hero this player was given rather than bought
   * (a tavern hero, a map's gift) can still lead a party.
   */
  private squadHero(b: Brain): SimUnit | null {
    const alive: SimUnit[] = [];
    for (const u of this.squadUnits(b)) if (u.isHero && u.hp > 0) alive.push(u);
    if (!alive.length) return null;
    for (const id of [b.ai.heroId, b.ai.heroId2, b.ai.heroId3]) {
      if (!id) continue;
      const found = alive.find((u) => u.typeId === id);
      if (found) return found;
    }
    return alive[0];
  }

  private hasAir(b: Brain): boolean {
    for (const u of this.squadUnits(b)) if (u.flying) return true;
    return false;
  }

  /** The group's hit points over its maximum. */
  private readiness(b: Brain): number {
    let hp = 0;
    let max = 0;
    for (const u of this.squadUnits(b)) {
      if (isCopy(u)) continue;
      hp += u.hp;
      max += u.maxHp;
    }
    return max > 0 ? hp / max : 1;
  }

  private atGoal(b: Brain, at: { x: number; y: number }): boolean {
    for (const u of this.squadUnits(b)) if (Math.hypot(u.x - at.x, u.y - at.y) <= 600) return true;
    return false;
  }

  private enemyNear(b: Brain, x: number, y: number, radius: number): boolean {
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.owner === b.ai.player || !b.ai.hostileTo(u)) continue;
      if (Math.hypot(u.x - x, u.y - y) <= radius) return true;
    }
    return false;
  }

  /** Enemy fighters standing in one of our towns. */
  private invaders(b: Brain): number {
    let n = 0;
    for (const u of this.host.world.units.values()) if (this.isInvader(b, u)) n++;
    return n;
  }

  /** …and how many of the group standing in our towns are HEROES. Counted off the very same
   *  `isInvader` predicate, so "part of the group that is attacking" means exactly what it
   *  means everywhere else in this file, and the count can never exceed `invaders`. */
  private invaderHeroes(b: Brain): number {
    let n = 0;
    for (const u of this.host.world.units.values()) if (u.isHero && this.isInvader(b, u)) n++;
    return n;
  }

  private nearestThreat(b: Brain): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const u of this.host.world.units.values()) {
      if (!this.isInvader(b, u)) continue;
      const d = this.townDistance(b, u);
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  /**
   * Is this something ATTACKING one of our towns?
   *
   * The distinction that matters, and it cost a whole game to find: a CREEP CAMP near the base
   * is not an attack. `TOWN_RADIUS` is 1600, which on a small map reaches the nearest camp, and
   * counting the creeps standing in it made an insane orc read as "under attack" from the first
   * minute to the last — permanently in `defending`, never massing, and never expanding, since
   * the plan will not found a second town during a raid.
   *
   * So a creep counts only when it is actually swinging at something of ours; a hostile PLAYER
   * unit counts for being there at all, because a player standing in your base has walked there
   * on purpose. Buildings and workers are neither.
   */
  private isInvader(b: Brain, u: SimUnit): boolean {
    if (u.hp <= 0 || u.owner === b.ai.player || u.building || u.isPeon) return false;
    if (!b.ai.hostileTo(u)) return false;
    if (this.townDistance(b, u) > TOWN_RADIUS) return false;
    if (!u.isCreep && u.owner >= 0 && u.owner < MELEE.MAX_PLAYERS) return true;
    // A creep (or a neutral-hostile guard): only while it is fighting one of ours.
    const target = u.targetId ? this.host.world.units.get(u.targetId) : null;
    return !!target && target.owner === b.ai.player;
  }

  /** How far this unit is from the nearest of our towns. */
  private townDistance(b: Brain, u: SimUnit): number {
    let best = Infinity;
    for (let t = 0; t < b.ai.townCountTotal(); t++) {
      const town = b.ai.townAtIndex(t);
      if (town) best = Math.min(best, Math.hypot(u.x - town.x, u.y - town.y));
    }
    return best;
  }

  private prune(b: Brain): void {
    for (const id of [...b.squad]) {
      const u = this.host.world.units.get(id);
      if (u && u.hp > 0 && u.owner === b.ai.player) continue;
      b.squad.delete(id);
      b.pulls.delete(id); // …and its pull-back clock dies with it
    }
  }

  // ======================================================================================
  //  Manners — glhf, gg, and leaving
  // ======================================================================================

  private mannersPass(b: Brain): void {
    const { ai, profile } = b;
    if (!b.greeted && b.clock >= b.greetAt) {
      b.greeted = true;
      this.host.say(ai.player, GREETINGS[ai.randomInt(0, GREETINGS.length - 1)]);
    }
    if (b.concededAt >= 0) {
      // Said its piece; now it goes. The delay is so the line is on screen before the
      // "player left the game" that follows it.
      if (b.clock - b.concededAt >= LEAVE_AFTER) {
        b.gone = true;
        this.host.leave(ai.player);
      }
      return;
    }
    // The TEAM game — after the concession check, so a computer that has already said gg does not
    // then announce a build or promise to come and help (plus/teamchat.ts).
    this.teamPass(b);
    if (b.clock < CONCEDE_NOT_BEFORE) return; // nothing is decided this early — see the constant
    if (!hopeless(this.standing(b), this.host.registry.get(b.table.halls[0])?.goldCost ?? 0)) {
      b.hopelessSince = -1;
      return;
    }
    if (b.hopelessSince < 0) b.hopelessSince = b.clock;
    // It has to STAY hopeless: a base that looks lost for five seconds while the army walks
    // home is not a lost game, and `concedeAfter` is longer the weaker the player is.
    if (b.clock - b.hopelessSince < profile.concedeAfter) return;
    b.concededAt = b.clock;
    this.host.say(ai.player, CONCESSIONS[ai.randomInt(0, CONCESSIONS.length - 1)]);
  }

  // ======================================================================================
  //  The team game — what it tells its allies, and what it does when one of them calls
  //
  //  All of plus/teamchat.ts hangs off here. Every method reads `b.allies` first and does
  //  nothing when it is empty, so a 1v1 and a free-for-all are exactly the game they were.
  // ======================================================================================

  /** Once a second, with the rest of the manners. */
  private teamPass(b: Brain): void {
    if (b.clock - b.alliesAt >= ALLY_REFRESH) {
      b.allies = this.alliesOf(b);
      b.alliesAt = b.clock;
    }
    if (!b.allies.length) {
      b.called = -1; // nobody to have called; a stale one must not fire if a team forms later
      return;
    }
    this.openerTalk(b);
    this.helpWave(b);
    this.answerCall(b);
    this.callForHelp(b);
  }

  /**
   * Who this computer counts as an ally: the players it is CO-ALLIED with that still have
   * something on the map.
   *
   * `coAllied` rather than a team number, for the reason src/game/chat.ts states at length — an
   * alliance is a directed matrix and a one-way passive grant is not an alliance. Derived from
   * the units on the field rather than from a roster because that is also the useful question:
   * a teammate who has been wiped out is not somebody to tell about your build.
   */
  private alliesOf(b: Brain): number[] {
    const me = b.ai.player;
    const out: number[] = [];
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.owner === me) continue;
      if (u.owner < 0 || u.owner >= MELEE.MAX_PLAYERS) continue; // creeps and the shops are nobody
      if (out.includes(u.owner)) continue;
      if (this.host.coAllied(me, u.owner)) out.push(u.owner);
    }
    return out;
  }

  /** Say something to the allies. The channel is the ALLIES channel — Ctrl+Enter's — because
   *  a computer announcing its build on the all-channel would be scouting itself for the enemy. */
  private tell(b: Brain, lines: readonly string[]): void {
    if (!b.allies.length || !lines.length) return;
    b.spokeAt = b.clock;
    this.host.say(b.ai.player, lines[b.ai.randomInt(0, lines.length - 1)], "allies");
  }

  // --- what it is building --------------------------------------------------------------

  /**
   * "i'm going footmen and riflemen" — the build, stated once, near the top of the game.
   *
   * Off the STRATEGY rather than off the production mix, which is the whole difference between
   * this and `mixTalk`: at twelve seconds there is no production to report and no producer to
   * report it from, but the build has already been decided — it was rolled at seat time and is
   * held for the match (plus/races.ts). So this is the plan, and `mixTalk` is the running
   * commentary on carrying it out.
   *
   * It SEEDS `said` with the top of that mix. Without it the first thing `mixTalk` says is
   * "going footmen" to an ally who was told "i'm going footmen and riflemen" a minute earlier,
   * which reads as a computer with nothing to say rather than as a teammate.
   */
  private openerTalk(b: Brain): void {
    if (b.opened) return;
    // AFTER THE GREETINGS — every seat's, not only this one's. `OPENER_AT` is the floor the
    // developer asked for (fourteen seconds, by which time the "glhf"s should be gone) and
    // `greetingsDone` is the rest of it: each seat's greeting lands at a moment it drew for
    // itself, so the last one is later than any fixed floor can know, and the two sets of lines
    // interleaved into one wall at the start of the match.
    if (b.clock < Math.max(OPENER_AT, this.greetingsDone()) + GREET_STAGGER * this.seatOrder(b)) return;
    b.opened = true;
    const ranked = Object.entries(b.strategy.mix).sort((a, c) => c[1] - a[1]);
    if (!ranked.length) return;
    b.said = ranked[0][0];
    const named = ranked.slice(0, OPENER_UNITS)
      .map(([unit]) => this.host.registry.get(unit)?.name ?? "")
      .filter(Boolean);
    const line = openerLine(named);
    if (line) this.tell(b, [line]);
  }

  /**
   * When the LAST seat's greeting goes out — the latest `Brain.greetAt` actually drawn.
   *
   * Off the seats that exist rather than off `MELEE.MAX_PLAYERS`, so a 1v1 does not hold its
   * openers back for a lobby's worth of greetings that were never said. Read from the drawn
   * moments rather than from the window's ceiling for the same reason: two computers that both
   * rolled early should not hold the openers back to `GREET_AT + GREET_SPREAD` regardless.
   */
  private greetingsDone(): number {
    let last = GREET_AT;
    for (const other of this.brains) if (!other.gone) last = Math.max(last, other.greetAt);
    return last;
  }

  /** This computer's place among the Computer+ seats (0, 1, 2 …) rather than its LOBBY SLOT.
   *  What the openers are staggered by, so three computers speak three beats apart whether they
   *  sit in slots 1-3 or in slots 2, 7 and 11 — staggering by the slot made the last one wait
   *  most of a minute after the others for no reason a listener could see. */
  private seatOrder(b: Brain): number {
    return Math.max(0, this.brains.filter((o) => !o.gone).indexOf(b));
  }

  /**
   * "switching to knights", "going hippogryphs to counter their air units".
   *
   * The top of `buildableMix` is what this announces, and it is worth being precise about what
   * that is: NOT a change of strategy — Computer+ plays the build it rolled for the whole match
   * (plus/races.ts) — but the thing a player actually types, which is what the majority of their
   * production has just become. Two things move it: the tech tree opening up (a Footman build
   * becomes a Knight build the moment the Castle lands) and the counter re-weighting
   * (plus/counter.ts). `switchReason` tells the ally which.
   *
   * `SWITCH_MARGIN` is what keeps this from being noise, and `said` is deliberately NOT updated
   * when the line is held back by `TALK_GAP` — the change is still un-announced, so the next
   * pass says it.
   */
  private mixTalk(b: Brain, ctx: PlusCtx): void {
    if (!b.allies.length || b.concededAt >= 0) return;
    const rows = buildableMix(ctx);
    if (!rows.length) return;
    let top = rows[0];
    for (const r of rows) if (r.weight > top.weight) top = r;
    if (top.unit === b.said) return;
    // Hysteresis: the new top has to actually BEAT what was announced, not merely edge past it
    // this pass. A row that has vanished from the mix altogether (untrainable now) does not get
    // a vote, which is why this is looked up rather than remembered.
    const said = rows.find((r) => r.unit === b.said);
    if (said && top.weight < said.weight * SWITCH_MARGIN) return;
    if (b.clock - b.spokeAt < TALK_GAP) return;
    const def = this.host.registry.get(top.unit);
    if (!def) return;
    const first = b.said === "";
    b.said = top.unit;
    this.tell(b, [switchLine(def.name, this.switchReason(b, def), first)]);
  }

  /**
   * Why the mix moved — the half of the announcement that is worth reading.
   *
   * Only ever the ENEMY, and only when this difficulty is actually countering at all
   * (`counterWeight`, 0 on Easy) off a sample it believes (`counterSample`): a computer that
   * blamed the enemy for a switch it made because its Castle finished is a computer talking
   * nonsense to its teammate. The air clause is first because it is the one that is worth acting
   * on — "they have air" is a fact about the whole team's game, not only about this player's.
   */
  private switchReason(b: Brain, def: UnitDef): SwitchReason {
    if (b.profile.counterWeight <= 0 || b.enemy.seen < b.profile.counterSample) return null;
    if (b.enemy.air > 0 && def.weapons.some((w) => w.enabled && w.targets.includes("air"))) return "air";
    return counterScore(def, b.enemy) > COUNTER_TELL ? "counter" : null;
  }

  // --- asking ----------------------------------------------------------------------------

  /**
   * "help me, im getting attacked by two of them."
   *
   * The condition is the request's own: MULTIPLE OPPONENTS, counted as distinct enemy players
   * with units in our towns (`isInvader`, so a creep camp next door is not an invasion and a
   * creep's owner is nobody's anyway). One opponent in your base is a melee game; two at once is
   * the thing a team is for.
   *
   * It does not ask while it is off answering somebody else's call — an army that is not at home
   * is not a base that can be defended, and the honest thing at that point is to go back rather
   * than to ask a third player to cover for it.
   */
  private callForHelp(b: Brain): void {
    if (b.helping >= 0) return;
    if (b.clock - b.askedAt < HELP_CALL_GAP) return;
    if (b.clock - b.spokeAt < TALK_GAP) return;
    if (this.attackers(b) < HELP_CALL_FOES) return;
    b.askedAt = b.clock;
    this.tell(b, HELP_CALLS);
  }

  /** How many distinct enemy PLAYERS have units in one of our towns right now. */
  private attackers(b: Brain): number {
    const seen = new Set<number>();
    for (const u of this.host.world.units.values()) {
      if (u.owner < 0 || u.owner >= MELEE.MAX_PLAYERS) continue;
      if (this.isInvader(b, u)) seen.add(u.owner);
    }
    return seen.size;
  }

  // --- answering -------------------------------------------------------------------------

  /**
   * An ally asked for help. Go, or say why not.
   *
   * The DECLINE is as much of the feature as the relief wave is, and it is the honest half: an
   * ally who is told "im under attack too" knows nobody is coming and can play the fight
   * accordingly, where an ally who is told nothing waits for an army that never arrives. Every
   * reason is a state the army manager is already in, so none of this is a second opinion about
   * the position — `busyLines` reads the mode and nothing else.
   *
   * `HELP_ANSWER_GAP` is what stops a player spamming "help" from turning the army round three
   * times: a second call inside it is the same emergency, and the army is already walking.
   */
  private answerCall(b: Brain): void {
    if (b.called < 0) return;
    // Its TURN to answer. Parked rather than dropped, so a computer whose turn has not come yet
    // still answers — a beat later, which is the point (`HELP_ANSWER_STAGGER`).
    if (b.clock < b.answerAt) return;
    const from = b.called;
    b.called = -1;
    if (!b.allies.includes(from)) return;
    if (b.clock - b.answeredAt < HELP_ANSWER_GAP) return;
    b.answeredAt = b.clock;
    const spot = this.helpSpot(b, from);
    // No army of theirs we can see and no hall left standing is an ally there is nowhere to send
    // an army TO. Nothing is said either: "you have no base" is not help.
    if (!spot) return;
    const busy = this.busyLines(b);
    if (busy) return void this.tell(b, busy);
    // What this wave was doing, so calling the rescue off puts it back rather than leaving it
    // standing in the middle of the map — see `helpWave`. Only a wave in the FIELD is worth
    // remembering; a computer that was massing at home simply goes back to massing.
    b.helpResume = b.mode === "attacking" && b.target
      ? { mode: b.mode, target: { ...b.target }, creeping: b.creeping }
      : null;
    b.helping = from;
    b.helpUntil = b.clock + HELP_TIMEOUT;
    b.helpSince = b.clock;
    b.helpDangerAt = b.clock;
    b.target = { id: 0, x: spot.x, y: spot.y };
    b.creeping = false;
    this.setMode(b, "attacking");
    // ON FOOT, or by scroll — and the scroll is spent on ONE thing: an ally whose BASE is being
    // attacked. That is what a Town Portal is for and it is the only trip that pays for it. A
    // teammate whose army is in trouble in the middle of the map is a teammate you walk to: the
    // scroll goes to a town hall (`SimWorld.nearestHall`, docs/items.md), the fight is not at
    // one, and a scroll spent on a field battle is a scroll that is not there for the base.
    // `PORTAL_WALK` still applies on top — a base three seconds' walk away is a walk.
    const centre = this.squadCentre(b) ?? b.ai.home();
    const far = Math.hypot(centre.x - spot.x, centre.y - spot.y) > PORTAL_WALK;
    const hero = this.squadHero(b);
    const tp = far && hero && this.baseUnderAttack(b, from)
      ? b.items.portalTo(hero, spot.x, spot.y)
      : false;
    this.tell(b, tp ? PORTAL_LINES : COMING_LINES);
    this.commit(b, spot.x, spot.y);
  }

  /** Why it cannot come, or null if it can. In the order a player would give them: my own base
   *  first, then what is left of my army, then what I am in the middle of. */
  private busyLines(b: Brain): readonly string[] | null {
    if (b.mode === "defending" || b.ai.townThreatened()) return BUSY_LINES.attacked;
    if (b.mode === "retreating") return BUSY_LINES.broken;
    // Not enough to be a wave is not enough to be a rescue either — `attackFood` is this
    // difficulty's own answer to "is this an army yet".
    if (this.squadFood(b) < b.profile.attackFood) return BUSY_LINES.small;
    if (b.mode === "attacking") return b.creeping ? BUSY_LINES.creeping : BUSY_LINES.fighting;
    return null;
  }

  /**
   * Where the relief wave goes: TO THE ALLY'S ARMY.
   *
   * Three answers, in that order, and the first two are both "where their units are" — because
   * that is what "help me" means. It used to be the FIGHT or, failing that, the ally's BASE, and
   * the fallback was wrong far more often than the first rung was right: `allyFight` needs
   * enemies of theirs that WE can see, which across a map usually means it answers null, and the
   * army then walked to a base the ally was not standing in. A teammate under pressure is with
   * their army; a person asked for help walks to the friendly units on the minimap, not to the
   * friendly buildings.
   *
   *  · **The fight**, when we can see one: the ally unit with the most enemies around it. This
   *    is still the best answer when it exists, because it is where the help is needed rather
   *    than merely where the ally is.
   *  · **Their army**, otherwise: the centre of mass of their fighting units. Where that is is
   *    not public, so it is asked of `AiPlayer.knows` — and in a melee team game the answer is
   *    usually yes without any cheating, because a force grants ALLIANCE_SHARED_VISION and this
   *    computer is already looking through its teammate's units.
   *  · **The base**, only when they have no army left to find. Public: a melee player is shown
   *    their teammates' start locations from the first frame. At this point the ally has nothing
   *    on the field, so their base is genuinely where they are.
   */
  private helpSpot(b: Brain, ally: number): { x: number; y: number } | null {
    return this.allyFight(b, ally) ?? this.allyArmy(b, ally) ?? this.allyBase(b, ally);
  }

  /**
   * Where the ally's ARMY is — the centre of mass of their fighting units that we can see.
   *
   * Workers and buildings are not in it: a teammate's peasants are their base, and their base is
   * the rung below this one. A centre of mass rather than the nearest of them, for the same
   * reason `squadCentre` is one — it is a question about a body of units, and picking any single
   * one of them aims the rescue at whichever soldier happened to wander furthest.
   */
  private allyArmy(b: Brain, ally: number): { x: number; y: number } | null {
    let n = 0, sx = 0, sy = 0;
    for (const u of this.host.world.units.values()) {
      if (u.owner !== ally || u.hp <= 0 || u.building || u.isPeon) continue;
      if (!b.ai.knows(u)) continue;
      sx += u.x; sy += u.y; n++;
    }
    return n ? { x: sx / n, y: sy / n } : null;
  }

  /**
   * Is one of the ally's TOWN HALLS actually being attacked?
   *
   * The one question the Scroll of Town Portal is asked (`answerCall`), and the reason it is
   * asked separately from `helpSpot`: the scroll's destination is a town hall, so it can only
   * ever answer "their base is under attack" — spending it on a field battle drops the army
   * somewhere near the fight at best and wastes the item at worst. Gated on our own eyes like
   * everything else here.
   */
  private baseUnderAttack(b: Brain, ally: number): boolean {
    for (const u of this.host.world.units.values()) {
      if (u.owner !== ally || u.hp <= 0 || !u.building || u.building.constructionLeft > 0) continue;
      if (this.host.registry.get(u.typeId)?.buffType !== HALL_CATEGORY) continue;
      if (this.fightAt(b, u)) return true;
    }
    return false;
  }

  /**
   * Is this ally still in trouble — the question a rescue is CALLED OFF by.
   *
   * Deliberately broader than `baseUnderAttack`: anything hostile we can see near any of their
   * units or halls counts, because the rescue was sent for a fight and a fight moves. It is the
   * same shape as `isInvader`, asked about somebody else's things.
   */
  private allyInDanger(b: Brain, ally: number): boolean {
    const theirs: SimUnit[] = [];
    for (const u of this.host.world.units.values()) {
      if (u.owner !== ally || u.hp <= 0 || u.isPeon) continue;
      if (b.ai.knows(u)) theirs.push(u);
    }
    if (!theirs.length) return false;
    for (const f of this.host.world.units.values()) {
      if (f.hp <= 0 || f.building || f.isCreep) continue;
      if (f.owner < 0 || f.owner >= MELEE.MAX_PLAYERS) continue;
      if (!b.ai.hostileTo(f) || !b.ai.knows(f)) continue;
      for (const t of theirs) if (Math.hypot(f.x - t.x, f.y - t.y) <= TOWN_RADIUS) return true;
    }
    return false;
  }

  /**
   * The ally unit with the most enemies around it that we can see — "where the fight is".
   *
   * Enemy PLAYERS only. `hostileTo` is true of creeps as well, and it should be, but a creep
   * camp a teammate chose to walk into is not what "help" means in a team game — it is the same
   * distinction `isInvader` draws about our own towns, and reading them in would march the army
   * across the map to somebody's creeping party. `CLEARED_RADIUS` is what the rest of this file
   * already calls "this fight".
   */
  private allyFight(b: Brain, ally: number): { x: number; y: number } | null {
    const theirs: SimUnit[] = [];
    const foes: SimUnit[] = [];
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.building || u.isPeon) continue;
      if (u.owner === ally) { if (b.ai.knows(u)) theirs.push(u); continue; }
      if (u.isCreep || u.owner < 0 || u.owner >= MELEE.MAX_PLAYERS) continue;
      if (b.ai.hostileTo(u) && b.ai.knows(u)) foes.push(u);
    }
    if (!theirs.length || !foes.length) return null;
    let best: SimUnit | null = null;
    let bestN = 0;
    for (const t of theirs) {
      let n = 0;
      for (const f of foes) if (Math.hypot(f.x - t.x, f.y - t.y) <= CLEARED_RADIUS) n++;
      if (n > bestN) { bestN = n; best = t; }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * The ally's town hall to go to: the one with a fight at it if we can see one, else the one
   * nearest us.
   *
   * "Town hall" is UnitData's own `buffType` category (UI\UnitEditorData.txt's pickFlags, the
   * same one `SimWorld.nearestHall` ranks a Town Portal's destination by), so a Great Hall, a
   * Necropolis and a Tree of Life all answer to it without a per-race list. No hall at all means
   * there is nowhere to send an army TO, and the caller says nothing: "you have no base" is not
   * help.
   */
  private allyBase(b: Brain, ally: number): { x: number; y: number } | null {
    const halls: SimUnit[] = [];
    for (const u of this.host.world.units.values()) {
      if (u.owner !== ally || u.hp <= 0 || !u.building || u.building.constructionLeft > 0) continue;
      if (this.host.registry.get(u.typeId)?.buffType === HALL_CATEGORY) halls.push(u);
    }
    if (!halls.length) return null;
    const under = halls.filter((h) => this.fightAt(b, h));
    const home = b.ai.home();
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const h of under.length ? under : halls) {
      const d = Math.hypot(h.x - home.x, h.y - home.y);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /** Is there a fight at this building that we can SEE? Same test `isInvader` makes about our
   *  own towns, asked about somebody else's and gated on our own eyes. */
  private fightAt(b: Brain, hall: SimUnit): boolean {
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.building || u.isPeon || !b.ai.hostileTo(u)) continue;
      if (Math.hypot(u.x - hall.x, u.y - hall.y) > TOWN_RADIUS) continue;
      if (b.ai.knows(u)) return true;
    }
    return false;
  }

  /**
   * The relief wave, once it is out.
   *
   * THREE ends to it, and the middle one is the answer to "how does a rescue get called off":
   *
   *  · it ARRIVED and cleared the spot — `attacking` ends the wave the moment the group is
   *    standing on its objective with nothing hostile around it, exactly as it would at an enemy
   *    base, and this only has to notice that it happened;
   *  · the ally is OUT OF DANGER, whether or not this army had anything to do with it. A rescue
   *    used to be a one-way commitment: the wave walked to where the fight had been and stood
   *    there until the spot read clear or `HELP_TIMEOUT` ran out, and only then remembered it had
   *    a game of its own. `dropHelp` puts it back on what it was doing;
   *  · `HELP_TIMEOUT`: an ally whose base fell while we were walking is an ally we cannot help,
   *    and standing in the wreckage of it is how the second base is lost as well.
   */
  private helpWave(b: Brain): void {
    if (b.helping < 0) return;
    if (b.mode !== "attacking") return void this.dropHelp(b, false); // home, defending, or broken
    // THE RESCUE IS CALLED OFF when the ally is out of danger. Without this a relief wave was a
    // one-way commitment: it walked to where the fight had been, stood there until `attacking`
    // decided the spot was clear or `HELP_TIMEOUT` ran out, and only then remembered it had a
    // game of its own. Two clocks make it a decision rather than a twitch — `HELP_GRACE`, because
    // the danger is judged through OUR eyes and there is nothing to see for the first part of the
    // walk, and `HELP_CLEAR`, because a fight ebbs.
    if (this.allyInDanger(b, b.helping)) b.helpDangerAt = b.clock;
    const settled = b.clock - b.helpSince >= HELP_GRACE;
    if (settled && b.clock - b.helpDangerAt >= HELP_CLEAR) return void this.dropHelp(b, true);
    // …and the other end: an ally whose base fell while we were walking is an ally we cannot
    // help, and standing in the wreckage of it is how the second base is lost as well.
    if (b.clock <= b.helpUntil) return;
    this.dropHelp(b, true);
  }

  /**
   * Stop helping, and go back to what the wave was doing.
   *
   * `resume` is the difference between a rescue that ENDED and one that was interrupted by
   * something bigger: a wave pulled home to defend has already been given a new job by
   * `defendPass` and must not have an old objective pushed back onto it, so that path drops the
   * memory instead. Otherwise the wave picks up the target it was walking to when the call came
   * — a creep camp, an expansion, the enemy's base — which is what "returns to what it was
   * doing" actually means. A remembered target that has since died falls through to `endWave`,
   * i.e. home and re-decide, which is the honest answer when the plan has expired.
   */
  private dropHelp(b: Brain, resume: boolean): void {
    const back = b.helpResume;
    b.helping = -1;
    b.helpResume = null;
    if (!resume) return;
    const still = back?.target && (!back.target.id || (this.host.world.units.get(back.target.id)?.hp ?? 0) > 0);
    if (!back || !still) return void this.endWave(b);
    b.target = back.target;
    b.creeping = back.creeping;
    this.setMode(b, back.mode);
  }

  /** The numbers `hopeless` judges the position by. */
  private standing(b: Brain): Standing {
    let structures = 0;
    let workers = 0;
    let heroes = 0;
    for (const u of this.host.world.units.values()) {
      if (u.owner !== b.ai.player || u.hp <= 0) continue;
      if (u.building) {
        if (u.building.constructionLeft <= 0) structures++;
      } else if (u.isPeon) workers++;
      else if (u.isHero) heroes++;
    }
    // A hero on an altar's clock is one we HAVE — it is coming back at full strength inside
    // the minute, which is a move from here (see `hopeless` clause 4). `revivingAt` is the
    // altar it was queued at, and 0 is "nobody is bringing this one back".
    const fallen = this.host.world.fallenHeroesOf(b.ai.player);
    for (const f of fallen) if (f.revivingAt) heroes++;
    return {
      halls: b.ai.townCountDone(b.table.halls[0]),
      structures,
      workers,
      armyFood: this.armyFood(b),
      gold: b.ai.gold(),
      invaders: this.invaders(b),
      invaderHeroes: this.invaderHeroes(b),
      heroes,
      // Heroes of ours lying dead. The roster is authoritative for "right now": a hero is
      // struck off it the instant it is actually revived (SimWorld.reviveFallenHero) and put
      // back on if the revival is cancelled (dropJob), so this never lags the field.
      heroesLost: fallen.length,
    };
  }
}
