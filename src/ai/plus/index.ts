import { MELEE } from "../../data/gameplayConstants";
import type { PlayableRace } from "../../data/races";
import type { SimUnit } from "../../sim/world";
import { simProfile, perfNow } from "../../sim/profile";
import { AiPlayer, type AiHost, REGROUP_HP_FRACTION, TOWN_RADIUS } from "../aiPlayer";
import { PlusCaster } from "./casting";
import { EnemyMemory, type EnemyRead } from "./counter";
import {
  CONCEDE_NOT_BEFORE, CONCESSIONS, GREETINGS, GREET_AT, GREET_STAGGER, LEAVE_AFTER, hopeless,
  type Standing,
} from "./chatter";
import { buildPlan, harvestPlan, type PlusCtx } from "./plan";
import { plusProfile, type PlusProfile } from "./profile";
import { aimCtx, heroKillable, killValue } from "./targeting";
import { PLUS_RACES, rollStrategy, type PlusRaceTable, type PlusStrategy } from "./races";

// Computer+ — the improved melee AI (issue #124). Start at docs/computer-plus.md.
//
// **What this is, next to `src/ai/index.ts`.** The classic melee AI is Blizzard's own, ported:
// four race scripts on `common.ai`'s library on ~150 engine natives (docs/melee-ai.md). This is
// a DIFFERENT PLAYER sitting at the same controls. It reuses the bottom two layers — `AiPlayer`
// is the library and the natives, and it is race-neutral bookkeeping (a census, a build array,
// placement, a harvest plan, hero skills) rather than a strategy — and replaces everything
// above them: which build it is playing and what that build wants (plus/races.ts + plus/plan.ts),
// how hard to play (plus/profile.ts), how to answer what the enemy turns out to be fielding
// (plus/counter.ts), when to cast (plus/casting.ts), and what to say (plus/chatter.ts).
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
   * Say something on the all-channel. Routed exactly like a human player's chat (see
   * plus/chatter.ts) — there is no second channel for computers.
   */
  say(player: number, text: string): void;
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
/** How many gold mines it checks after the enemy's main before coming home. */
const SCOUT_LEGS = 3;

// ITEMS — Computer+ does not buy or use any, and no code path here reaches one. Not an
// oversight: see docs/computer-plus.md "Items: not yet, and what goes here when they land",
// which names the seams (`buyitem` / `useitem`), the Goblin Merchant's own `Sellitems` line and
// the shopping list, and the two gates to check first (item abilities are not in
// `SimUnit.abilities`; item gold is gold `OneBuildLoop` was reserving). The item side of the
// sim is still being filled in, and an AI built against half an inventory would encode the half.

/** Creep camps: the window `AiPlayer.creepCamp` is asked for, derived from the army's food the
 *  way the race scripts derive theirs from `force_level` — four fifths of it, less ten. */
const CREEP_WINDOW = 10;
/** …and the hero level past which creeping stops being worth the walk. */
const CREEP_UNTIL_LEVEL = 5;

type Mode = "massing" | "attacking" | "retreating" | "defending";

interface Brain {
  readonly ai: AiPlayer;
  readonly profile: PlusProfile;
  readonly table: PlusRaceTable;
  /** The build it rolled at seat time and plays for the whole match (plus/races.ts). */
  readonly strategy: PlusStrategy;
  readonly caster: PlusCaster;
  /** What it has seen of the enemy army, and the read taken off it — the input to countering
   *  (plus/counter.ts). Refreshed on the army pass, since that is when it is looking anyway. */
  readonly memory: EnemyMemory;
  enemy: EnemyRead;
  /** Seconds since this computer was seated. */
  clock: number;
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
  /** The worker sent to go and look, and how far round its tour it is. `scoutDone` latches
   *  when the tour ends (or the scout dies), because a player who loses a scout sends their
   *  workers back to work rather than feeding a second one to the same creeps. */
  scoutId: number;
  scoutLeg: number;
  scoutGoal: { x: number; y: number } | null;
  scoutDone: boolean;
  mode: Mode;
  target: { id: number; x: number; y: number } | null;
  reissueIn: number;
  /** When the last wave came home — `waveGap` is measured from it. */
  lastWaveEnd: number;
  /** When something hostile first appeared in one of our towns (-1 = nothing there). The
   *  difficulty's `defendDelay` is measured off this: an easy computer lets you kill four
   *  workers before it looks up. */
  threatSince: number;
  greeted: boolean;
  /** When the position first looked unwinnable (-1 = it doesn't). */
  hopelessSince: number;
  /** When it said gg (-1 = it hasn't). It leaves LEAVE_AFTER seconds later. */
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
      clock: 0,
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
      mode: "massing",
      target: null,
      reissueIn: 0,
      lastWaveEnd: 0,
      threatSince: -1,
      greeted: false,
      hopelessSince: -1,
      concededAt: -1,
      gone: false,
    });
  }

  get active(): boolean {
    return this.brains.some((b) => !b.gone);
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
        b.caster.pass(b.clock);
        simProfile.end("sim.ai.cast");
        simProfile.gauge("aiCastPass", perfNow() - t0);
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
    ai.runBuildLoop();
    ai.spendSkillPoints();
    ai.entangleMines(); // the night elf's gold, which is a cast rather than a build order
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
      foodOf: (id) => this.host.registry.get(id)?.foodUsed ?? 0,
      defOf: (id) => this.host.registry.get(id),
    };
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
      if (!u.building && !u.isPeon) food += def.foodUsed;
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
    this.scoutPass(b);
    this.hold(b);
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
   * is not `isPeon` and so is a fighter by every other test in the sim. It is only taken while
   * the army is short of what makes a wave, so the rest go on chopping. That is undead.ai's own
   * `AG`/`WG` split (attack ghouls / wood ghouls) arrived at from the other direction.
   */
  private recruit(b: Brain): void {
    const spare: SimUnit[] = [];
    for (const u of b.ai.army()) {
      if (b.squad.has(u.id) || u.isPeon) continue;
      if (u.worker) spare.push(u);
      else b.squad.add(u.id);
    }
    for (const u of spare) {
      if (this.squadFood(b) >= b.profile.attackFood) break;
      b.squad.add(u.id);
    }
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
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.owner === b.ai.player || u.building) continue;
      // A PLAYER's army, not the map's. `hostileTo` is true of creeps too — and it should be,
      // they are hostile — but a creep camp is not a build order to answer: reading them in
      // made Echo Isles look like a seventy-unit Heavy-armour army before either player had
      // made a soldier, and the whole mix would have been re-weighted against the map.
      if (u.isCreep || u.owner < 0 || u.owner >= MELEE.MAX_PLAYERS) continue;
      if (!b.ai.hostileTo(u) || !b.ai.knows(u)) continue;
      b.memory.note(u, b.clock);
    }
    b.memory.forget(b.clock, b.profile.counterMemory);
    b.enemy = b.memory.read(b.profile.counterShare, (id) => this.host.registry.get(id));
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
   * `knows` for this AI means "under my own eyes". One worker, one tour: the enemy's main base
   * and then the nearest few gold mines, and then home. It is not replaced when it dies, which
   * is both what a player does and what stops a computer feeding workers to a creep camp.
   */
  private scoutPass(b: Brain): void {
    if (!b.profile.scout || b.scoutDone) return;
    const scout = b.scoutId ? this.host.world.units.get(b.scoutId) : null;
    if (b.scoutId && (!scout || scout.hp <= 0 || scout.owner !== b.ai.player)) {
      b.scoutId = 0;
      b.scoutDone = true; // it did not come back; nobody follows it
      return;
    }
    if (!scout) {
      if (b.clock < SCOUT_AT) return;
      const worker = this.freeWorker(b);
      if (!worker) return;
      b.scoutId = worker.id;
      b.scoutLeg = 0;
      b.scoutGoal = null;
      return;
    }
    if (b.scoutGoal && Math.hypot(scout.x - b.scoutGoal.x, scout.y - b.scoutGoal.y) > SCOUT_ARRIVED) {
      if (scout.order === "move") return; // still walking
    } else if (b.scoutGoal) {
      b.scoutLeg++;
    }
    const goal = this.scoutWaypoint(b);
    if (!goal) {
      // Tour over: back to work. Dropping it out of `held` is what puts it back on a mine.
      b.scoutId = 0;
      b.scoutDone = true;
      b.scoutGoal = null;
      return;
    }
    b.scoutGoal = goal;
    b.ai.order({ c: "order", unitId: scout.id, order: { kind: "move", x: goal.x, y: goal.y }, queued: false });
  }

  /** Leg 0 is the enemy's main base (map data every melee player is handed); the rest are the
   *  gold mines nearest to it, which is where an expansion would be. */
  private scoutWaypoint(b: Brain): { x: number; y: number } | null {
    if (b.scoutLeg > SCOUT_LEGS) return null;
    const base = b.ai.enemyBase();
    if (!base) return null;
    if (b.scoutLeg === 0) return { x: base.x, y: base.y };
    const home = b.ai.home();
    const mines = [...this.host.world.mines.values()]
      .filter((m) => m.gold > 0 && Math.hypot(m.x - home.x, m.y - home.y) > TOWN_RADIUS)
      .sort((p, q) => Math.hypot(p.x - base.x, p.y - base.y) - Math.hypot(q.x - base.x, q.y - base.y));
    const mine = mines[b.scoutLeg - 1];
    return mine ? { x: mine.x, y: mine.y } : null;
  }

  /** A worker with nothing important in its hands. */
  private freeWorker(b: Brain): SimUnit | null {
    for (const u of this.host.world.units.values()) {
      if (u.owner !== b.ai.player || u.hp <= 0 || !u.isPeon) continue;
      if (u.buildPending || u.insideBuild || u.constructing || u.inMine) continue;
      return u;
    }
    return null;
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

  /** Waiting at home with the army, until there is enough of it and the clock allows. */
  private massing(b: Brain): void {
    const { profile } = b;
    const rally = this.rally(b);
    for (const u of this.squadUnits(b)) {
      if (Math.hypot(u.x - rally.x, u.y - rally.y) <= RALLY_SLACK) continue;
      if (u.order === "move" || u.order === "attack") continue;
      b.ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: rally.x, y: rally.y }, queued: false });
    }
    if (b.clock < profile.firstAttack) return;
    if (b.clock - b.lastWaveEnd < profile.waveGap) return;
    if (this.squadFood(b) < profile.attackFood) return;
    const target = this.pickTarget(b);
    if (!target) return;
    b.target = target;
    this.setMode(b, "attacking");
    this.commit(b, target.x, target.y);
  }

  /** On the way, and once there. */
  private attacking(b: Brain): void {
    if (!b.squad.size) return void this.endWave(b);
    if (b.profile.retreatHp > 0 && this.readiness(b) < b.profile.retreatHp) {
      this.setMode(b, "retreating");
      return;
    }
    const target = b.target;
    if (!target) return void this.endWave(b);
    if (target.id) {
      const u = this.host.world.units.get(target.id);
      if (!u || u.hp <= 0) return void this.endWave(b);
      target.x = u.x;
      target.y = u.y;
    } else if (this.atGoal(b, target) && !this.enemyNear(b, target.x, target.y, CLEARED_RADIUS)) {
      return void this.endWave(b);
    }
    this.recommit(b, target.x, target.y);
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
    if (!b.squad.size || (allHome && this.readiness(b) >= REGROUP_HP_FRACTION)) this.endWave(b);
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
    for (const u of this.squadUnits(b)) {
      if (focus && !u.isPeon) {
        if (u.order === "attack" && u.targetId === focus.id) continue;
        b.ai.order({ c: "order", unitId: u.id, order: { kind: "attack", targetId: focus.id }, queued: false });
        continue;
      }
      // A unit already swinging at something is left alone: re-aiming a melee fighter at the
      // far end of a base every few seconds is how an army walks past what is killing it.
      if (u.order === "attack" && u.targetId) continue;
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
    b.reissueIn = REISSUE_PERIOD;
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

  /** Where the group actually is — the anti-chase rule measures from here rather than from the
   *  wave's objective, because "has it pulled away from us" is a question about the ARMY. */
  private squadCentre(b: Brain): { x: number; y: number } | null {
    let n = 0, sx = 0, sy = 0;
    for (const u of this.squadUnits(b)) { if (u.isPeon) continue; sx += u.x; sy += u.y; n++; }
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
    if (profile.creeps && this.heroLevel(b) < CREEP_UNTIL_LEVEL) {
      const max = Math.floor((this.squadFood(b) * 4) / 5);
      const camp = ai.creepCamp(Math.max(0, max - CREEP_WINDOW), max, this.hasAir(b));
      if (camp) return { id: 0, x: camp.x, y: camp.y };
    }
    const expansion = ai.enemyExpansion();
    if (expansion && !ai.isTowered(expansion)) return { id: expansion.id, x: expansion.x, y: expansion.y };
    const base = ai.enemyBase();
    return base ? { id: base.id, x: base.x, y: base.y } : null;
  }

  private endWave(b: Brain): void {
    b.target = null;
    b.lastWaveEnd = b.clock;
    this.setMode(b, "massing");
  }

  private setMode(b: Brain, mode: Mode): void {
    b.mode = mode;
    b.reissueIn = 0;
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

  private squadFood(b: Brain): number {
    let food = 0;
    for (const u of this.squadUnits(b)) food += this.host.registry.get(u.typeId)?.foodUsed ?? 0;
    return food;
  }

  private heroLevel(b: Brain): number {
    let best = 0;
    for (const u of this.squadUnits(b)) if (u.isHero) best = Math.max(best, u.level);
    return best;
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
    }
  }

  // ======================================================================================
  //  Manners — glhf, gg, and leaving
  // ======================================================================================

  private mannersPass(b: Brain): void {
    const { ai, profile } = b;
    if (!b.greeted && b.clock >= GREET_AT + GREET_STAGGER * ai.player) {
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
