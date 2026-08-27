import type { PlayableRace } from "../data/races";
import type { SimUnit } from "../sim/world";
import { AiPlayer, type AiHost, REGROUP_HP_FRACTION, RETREAT_HP_FRACTION, TOWN_RADIUS } from "./aiPlayer";
import type { MeleeScript } from "./script";
import { HUMAN_AI } from "./human";
import { ORC_AI } from "./orc";
import { UNDEAD_AI } from "./undead";
import { ELF_AI } from "./elf";
import { MELEE_NEWBIE, MELEE_NORMAL } from "./ids";

// The melee AI's scheduler — `StandardAI`'s three threads, plus the CAPTAIN they feed
// (issue #119). `AiPlayer` is the library and the natives; the four race files are the
// strategy; this is `main()`.
//
// The original is cooperative threads with `Sleep`:
//
//     call StandardAI(function SkillArrays, function peon_assignment, function attack_sequence)
//     call StartThread(function set_vars)     // Sleep(1)  — refresh the c_* globals
//     call PlayGame()                          // StartBuildLoop: OneBuildLoop, Sleep(2)
//
// Four loops on three different clocks, which on a frame-stepped sim is four timers. Two of
// them are folded together here and it is worth saying why: `peon_assignment` FILLS the build
// array (its last act is `call build_sequence()`) and `BuildLoop` READS it, on independent
// 1–3s and 2s clocks — so in the original the array being consumed is up to three seconds
// stale. Running fill-then-consume in one pass is the same program with that staleness taken
// out, and `set_vars`' once-a-second census goes the same way (see MeleeScript).

/** How often a player's build/harvest pass runs — `BuildLoop`'s `Sleep(2)`. */
const BUILD_PERIOD = 2;
/** …and the attack thread's own clock, which polls far more often than it acts. */
const ATTACK_PERIOD = 1;

/** `if MeleeDifficulty() == MELEE_NEWBIE then call Sleep(240) endif` — an easy computer sits
 *  on its hands for four minutes before its first wave, and a minute between every one after. */
const NEWBIE_FIRST_WAVE_DELAY = 240;
const NEWBIE_WAVE_GAP = 60;

/** `FormGroup`'s patience. The original computes `PrepTime()` from the build times of what is
 *  missing and sends the wave anyway when `sleep_seconds` runs past it; this is that timeout
 *  as a flat number, which is what it works out to for a wave that is nearly assembled. */
const FORM_TIMEOUT = 60;

/** How often the captain re-states its attack order to a member that has gone idle. */
const REISSUE_PERIOD = 4;

/** `daytime >= 4 and daytime <= 12` — SingleMeleeAttack's siege window, in game hours. */
const SIEGE_DAY_START = 4;
const SIEGE_DAY_END = 12;

const SCRIPTS: Record<PlayableRace, MeleeScript> = {
  human: HUMAN_AI,
  orc: ORC_AI,
  undead: UNDEAD_AI,
  nightelf: ELF_AI,
};

type CaptainMode = "idle" | "forming" | "attacking" | "home";

interface Brain {
  ai: AiPlayer;
  script: MeleeScript;
  buildIn: number;
  attackIn: number;
  /** The opening `loop exitwhen c_hero1_done > 0 and …` has been passed once. */
  started: boolean;
  /** `Sleep(240)` / `Sleep(60)` — an easy computer's enforced idleness. */
  waveDelay: number;
  mode: CaptainMode;
  members: Set<number>;
  modeTimer: number;
  reissueIn: number;
  targetId: number;
  targetX: number;
  targetY: number;
  /** `setup_force()` has run for THIS wave and the creep window is set.
   *
   *  The attack thread polls once a second, and `SingleMeleeAttack` can find nothing worth
   *  attacking and come back — so without a latch the whole preamble would run again every
   *  second, and two of the four scripts have a preamble with side effects (elf.ai counts its
   *  waves and holds the second one for four archers; undead.ai splits its ghouls). */
  prepared: boolean;
  flags: { needsExp: boolean; hasSiege: boolean; airUnits: boolean; allowAirCreeps: boolean };
  /** `CaptainRetreating()` — true from the moment the group breaks until it is home and
   *  healed, and every race script's attack loop stalls on it. */
  retreating: boolean;
}

/**
 * Every computer player in the match.
 *
 * Lives on the AUTHORITY and only there: `RtsController.tick` drives it inside the branch a
 * frozen LAN client never enters, so the AI thinks once per match rather than once per
 * machine, and its decisions reach the clients as ordinary snapshot state.
 */
export class MeleeAi {
  private readonly brains: Brain[] = [];

  constructor(private readonly host: AiHost) {}

  /** Seat one computer slot. `seed` is the match seed — see AiPlayer's constructor for why
   *  the AI draws from its own stream rather than the sim's. */
  add(player: number, race: PlayableRace, difficulty: number, startX: number, startY: number, seed: number): void {
    const script = SCRIPTS[race];
    if (!script) return;
    const ai = new AiPlayer(player, race, difficulty, this.host, startX, startY, seed);
    // `main()`: PickMeleeHero, then set_skills (which only writes the arrays of the three
    // heroes this player actually drew — see SetSkillArray).
    ai.pickMeleeHero(script.heroes);
    script.setSkills(ai);
    const members = new Set<number>();
    // The harvest plan has to know who the captain is holding, or an undead computer marches
    // its attack ghouls back into the forest the moment it musters them (see captainHeld).
    ai.captainHeld = members;
    this.brains.push({
      ai, script,
      // `StaggerSleep(1, 2)` — the computers' passes are spread across the interval rather
      // than all landing on the same frame.
      buildIn: 1 + (2 * player) / 12,
      attackIn: ATTACK_PERIOD,
      started: false,
      waveDelay: 0,
      mode: "idle",
      members,
      modeTimer: 0,
      reissueIn: 0,
      targetId: 0,
      targetX: 0,
      targetY: 0,
      prepared: false,
      flags: { needsExp: false, hasSiege: false, airUnits: false, allowAirCreeps: false },
      retreating: false,
    });
  }

  get active(): boolean {
    return this.brains.length > 0;
  }

  reset(): void {
    this.brains.length = 0;
  }

  tick(dt: number): void {
    for (const b of this.brains) {
      b.buildIn -= dt;
      if (b.buildIn <= 0) {
        b.buildIn = BUILD_PERIOD;
        this.buildPass(b);
      }
      b.attackIn -= dt;
      if (b.attackIn <= 0) {
        b.attackIn = ATTACK_PERIOD;
        this.attackPass(b, ATTACK_PERIOD);
      }
    }
  }

  // ======================================================================================
  //  peon_assignment + build_sequence + OneBuildLoop, in one pass
  // ======================================================================================

  private buildPass(b: Brain): void {
    const { ai, script } = b;
    ai.refresh();
    script.initVars?.(ai); // the `c_*` refresh's non-count half (undead's WG, elf's archer latch)
    // …and `init_vars`' last act: the opening latch, which never goes back once it has dropped.
    if (ai.basicOpening && script.openingDone(ai)) ai.basicOpening = false;

    script.peonAssignment(ai); // ClearHarvestAI + the Harvest* split
    ai.applyHarvest();
    script.buildSequence(ai); // fills the build array
    ai.runBuildLoop(); // …and spends down it
    ai.spendSkillPoints(); // SetHeroLevels(SkillArrays)
    this.entangleMines(ai); // the night elf's gold, which is a cast and not a build order
  }

  /**
   * The one production step that is not a build order: a rooted Tree of Life beside a free
   * gold mine wraps it (`Aent`).
   *
   * Night elf gold begins with Entangle and there is no "build an Entangled Gold Mine"
   * anywhere — `egol` is what the ability CREATES — so a port that only ran the build array
   * would leave every night elf computer with five wisps standing around a bare rock. The
   * original engine does this inside its own expansion handling; here it is a pass over our
   * own halls, which is the same rule stated where it can be seen. See docs/night-elf.md.
   */
  private entangleMines(ai: AiPlayer): void {
    const world = this.host.world;
    for (const u of world.units.values()) {
      if (u.owner !== ai.player || u.hp <= 0 || !u.building || u.uprooted) continue;
      if (u.building.constructionLeft > 0) continue;
      if (!u.abilities.some((a) => a.code === "Aent")) continue;
      if (u.order === "cast") continue; // already throwing its roots — a re-issue restarts it
      // `Aent` is a no-target cast that takes the nearest un-entangled mine inside its own
      // Rng1 — so the only question here is whether there is one.
      const mine = world.nearestMine(u.x, u.y, 500);
      if (!mine || mine.entangledBy > 0 || mine.gold <= 0) continue;
      ai.order({ c: "cast", unitId: u.id, code: "Aent", targetId: 0, x: 0, y: 0, queued: false });
    }
  }

  // ======================================================================================
  //  attack_sequence + the captain
  // ======================================================================================

  private attackPass(b: Brain, dt: number): void {
    const { ai } = b;
    b.modeTimer += dt;
    if (b.waveDelay > 0) {
      b.waveDelay -= dt;
      return;
    }

    // `SetDefendPlayer(true)` — a threatened town outranks anything the wave was doing. The
    // original hands this to a second, DEFENSE captain; ours turns the one captain around,
    // which is the same answer for a melee AI that only ever fields one group.
    if (ai.townThreatened() && this.defend(b)) return;

    switch (b.mode) {
      case "idle": return this.tickIdle(b);
      case "forming": return this.tickForming(b);
      case "attacking": return this.tickAttacking(b);
      case "home": return this.tickHome(b);
    }
  }

  /** `loop exitwhen not CaptainRetreating()` → `setup_force()` → `SingleMeleeAttack(...)`. */
  private tickIdle(b: Brain): void {
    const { ai, script } = b;
    if (b.retreating) return void this.setMode(b, "home");
    if (!b.started) {
      if (!script.firstWaveReady(ai)) return;
      b.started = true;
      if (ai.meleeDifficulty() === MELEE_NEWBIE) {
        b.waveDelay = NEWBIE_FIRST_WAVE_DELAY;
        return;
      }
    }
    if (!b.prepared) {
      if (script.waveGate && !script.waveGate(ai)) return;

      script.setupForce(ai);

      // attack_sequence's own four lines, in every race file:
      //   set level = force_level()
      //   set max_creeps = level * 4 / 5
      //   set min_creeps = max_creeps - 10   (floored at 0)
      const level = script.forceLevel(ai);
      ai.maxCreeps = Math.floor((level * 4) / 5);
      ai.minCreeps = Math.max(0, ai.maxCreeps - 10);
      b.flags = script.attackFlags(ai);
      ai.allowAirCreeps = b.flags.allowAirCreeps;
      b.prepared = true;
    }

    const target = this.pickTarget(ai, b.flags);
    if (!target) return; // nothing worth attacking yet — try again next second
    b.targetId = target.id;
    b.targetX = target.x;
    b.targetY = target.y;
    this.setMode(b, "forming");
  }

  /**
   * `SingleMeleeAttack(needs_exp, has_siege, major_ok, air_units)` — common.ai 2135–2268,
   * the ladder that decides what a wave is FOR.
   *
   * Ported: the town-threatened bail, the expansion-clearing branch, deny-an-expansion (with
   * its `exp_seen` patience counter and the `IsTowered` test), the base assault once siege is
   * available, and the two creep branches. Not ported, and each for a reason the engine owns
   * rather than the script: `GetMegaTarget` (an all-out attack keyed on `GetEnemyPower`, which
   * is the engine's running estimate of an opponent's army), `GetAllianceTarget` (allied
   * computers agreeing on one target over a channel we do not have) and `PurchaseZeppelin`.
   */
  private pickTarget(
    ai: AiPlayer,
    flags: { needsExp: boolean; hasSiege: boolean; airUnits: boolean },
  ): { id: number; x: number; y: number } | null {
    // take expansions as needed
    if (flags.needsExp) {
      const foe = ai.expansionFoe();
      if (foe) {
        ai.takeExp = false;
        return { id: foe.id, x: foe.x, y: foe.y };
      }
    }

    const hall = ai.enemyExpansion();
    const daytime = this.host.world.timeOfDay;
    const canSiege = flags.hasSiege && (flags.airUnits || (daytime >= SIEGE_DAY_START && daytime <= SIEGE_DAY_END));

    // deny player an expansion
    if (hall && (canSiege || !ai.isTowered(hall))) {
      const allies = this.allyCount(ai) > 0;
      const minimum = ai.meleeDifficulty() === MELEE_NEWBIE ? 3
        : allies && ai.meleeDifficulty() === MELEE_NORMAL ? 1
        : 0;
      if (ai.expSeen >= minimum) {
        ai.expSeen = 0;
        return { id: hall.id, x: hall.x, y: hall.y };
      }
      ai.expSeen++;
    }

    // attack player's main base when siege is available
    if (canSiege) {
      const base = ai.enemyBase();
      if (base) return { id: base.id, x: base.x, y: base.y };
    }

    // extended, more specific method of determining creep levels
    if (ai.minCreeps !== -1) {
      const camp = ai.creepCamp(ai.minCreeps, ai.maxCreeps, ai.allowAirCreeps);
      if (camp) return { id: 0, x: camp.x, y: camp.y };
    }

    // nothing better to do, so kill a creep camp — GetMinorCreep() = GetCreepCamp(0, 9, false)
    const minor = ai.creepCamp(0, 9, false);
    if (minor) return { id: 0, x: minor.x, y: minor.y };

    // …and with the map cleared, the enemy is the only thing left.
    const base = ai.enemyBase();
    return base ? { id: base.id, x: base.x, y: base.y } : null;
  }

  /** `GetAllyCount(p)` — allies with at least one standing structure. */
  private allyCount(ai: AiPlayer): number {
    const seen = new Set<number>();
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || !u.building || u.owner < 0 || u.owner === ai.player) continue;
      if (!this.host.coAllied(ai.player, u.owner)) continue;
      seen.add(u.owner);
    }
    return seen.size;
  }

  /** `FormGroup(3, true)` — muster whatever the assault rows asked for, at home. */
  private tickForming(b: Brain): void {
    const { ai } = b;
    this.prune(b);
    const home = ai.home();
    const want = new Map<string, number>();
    for (const row of ai.assaultRows()) want.set(row.item, Math.max(want.get(row.item) ?? 0, row.max));

    const have = new Map<string, number>();
    for (const id of b.members) {
      const u = this.host.world.units.get(id);
      if (u) have.set(u.typeId, (have.get(u.typeId) ?? 0) + 1);
    }
    for (const u of ai.army()) {
      if (b.members.has(u.id)) continue;
      const cap = want.get(u.typeId);
      if (cap === undefined) continue;
      const got = have.get(u.typeId) ?? 0;
      if (got >= cap) continue;
      b.members.add(u.id);
      have.set(u.typeId, got + 1);
      // Walk it to the muster point — but only if it is not already standing there, so a
      // wave that is waiting for one more Grunt does not re-order itself every second.
      if (Math.hypot(u.x - home.x, u.y - home.y) > TOWN_RADIUS / 2) {
        ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: home.x, y: home.y }, queued: false });
      }
    }

    // `CaptainIsFull()` — every row has its MINIMUM. The maxima are what the group will take
    // if it has them, and the timeout is what stops it waiting for twenty Grunts forever.
    let full = true;
    for (const row of ai.assaultRows()) {
      if ((have.get(row.item) ?? 0) < row.qty) full = false;
    }
    if (full || b.modeTimer >= FORM_TIMEOUT) {
      if (!b.members.size) return void this.setMode(b, "idle");
      this.setMode(b, "attacking");
      this.issueAttack(b);
    }
  }

  /** `AttackMoveKillA(target)` → `SleepUntilAtGoal()` → `SleepInCombat()`. */
  private tickAttacking(b: Brain): void {
    const { ai, script } = b;
    this.prune(b);
    if (!b.members.size) return void this.endWave(b);

    // `CaptainReadinessHP()` — a broken group goes home rather than feeding itself in.
    if (this.readiness(b) < RETREAT_HP_FRACTION) {
      b.retreating = true;
      b.prepared = false;
      script.afterWave?.(ai);
      return void this.setMode(b, "home");
    }

    const target = b.targetId ? this.host.world.units.get(b.targetId) : undefined;
    if (b.targetId && (!target || target.hp <= 0)) return void this.endWave(b);
    if (target) {
      b.targetX = target.x;
      b.targetY = target.y;
    }
    // `CaptainAtGoal()` with nothing left to fight: a point target (a creep camp) is done
    // when the group is standing on it and nothing hostile is near.
    if (!b.targetId && this.atGoal(b) && !this.enemyNear(ai, b.targetX, b.targetY, 900)) {
      return void this.endWave(b);
    }

    b.reissueIn -= ATTACK_PERIOD;
    if (b.reissueIn <= 0) {
      b.reissueIn = REISSUE_PERIOD;
      this.issueAttack(b);
    }
  }

  /** `CaptainGoHome()` — and `CaptainRetreating()` stays true until it has healed up. */
  private tickHome(b: Brain): void {
    const { ai } = b;
    this.prune(b);
    const home = ai.home();
    let allHome = true;
    for (const id of b.members) {
      const u = this.host.world.units.get(id);
      if (!u) continue;
      if (Math.hypot(u.x - home.x, u.y - home.y) > TOWN_RADIUS / 2) {
        allHome = false;
        if (u.order !== "move") {
          ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: home.x, y: home.y }, queued: false });
        }
      }
    }
    if (!b.members.size || (allHome && this.readiness(b) >= REGROUP_HP_FRACTION)) {
      b.retreating = false;
      b.members.clear();
      this.setMode(b, "idle");
    }
  }

  /** Turn everything that can fight on whatever is standing in a town. */
  private defend(b: Brain): boolean {
    const { ai } = b;
    const threat = this.nearestThreat(ai);
    if (!threat) return false;
    for (const u of ai.army()) {
      // Everything that fights, and only that: `army()` yields workers (the Ghoul is one), and
      // an Acolyte sent at an attacker is a dead Acolyte and a stopped gold mine.
      if (u.worker && !u.weapons.length) continue;
      if (u.order === "attack" || u.order === "attackmove") continue;
      ai.order({ c: "order", unitId: u.id, order: { kind: "attackmove", x: threat.x, y: threat.y }, queued: false });
    }
    // The wave is called off; the captain re-forms from scratch once the town is clear.
    if (b.mode === "attacking" || b.mode === "forming") {
      b.members.clear();
      b.prepared = false;
      this.setMode(b, "idle");
    }
    return true;
  }

  private nearestThreat(ai: AiPlayer): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (let t = 0; t < ai.townCountTotal(); t++) {
      const town = ai.townAtIndex(t);
      if (!town) continue;
      for (const u of this.host.world.units.values()) {
        if (u.hp <= 0 || u.owner === ai.player || !ai.hostileTo(u)) continue;
        if (u.building || u.worker) continue;
        const d = Math.hypot(u.x - town.x, u.y - town.y);
        if (d <= TOWN_RADIUS && d < bestD) { bestD = d; best = u; }
      }
    }
    return best;
  }

  private issueAttack(b: Brain): void {
    const { ai } = b;
    for (const id of b.members) {
      const u = this.host.world.units.get(id);
      if (!u) continue;
      // A unit already swinging at something is left alone: re-aiming a melee fighter at the
      // far end of a base every four seconds is how an army walks past the thing killing it.
      if (u.order === "attack" && u.targetId) continue;
      ai.order({ c: "order", unitId: id, order: { kind: "attackmove", x: b.targetX, y: b.targetY }, queued: false });
    }
  }

  private endWave(b: Brain): void {
    b.script.afterWave?.(b.ai);
    b.members.clear();
    b.targetId = 0;
    b.prepared = false;
    this.setMode(b, "idle");
    if (b.ai.meleeDifficulty() === MELEE_NEWBIE) b.waveDelay = NEWBIE_WAVE_GAP;
  }

  private setMode(b: Brain, mode: CaptainMode): void {
    b.mode = mode;
    b.modeTimer = 0;
    b.reissueIn = 0;
  }

  private prune(b: Brain): void {
    for (const id of [...b.members]) {
      const u = this.host.world.units.get(id);
      if (!u || u.hp <= 0 || u.owner !== b.ai.player) b.members.delete(id);
    }
  }

  /** `CaptainReadinessHP()` as a fraction — the group's hit points over its maximum. */
  private readiness(b: Brain): number {
    let hp = 0;
    let max = 0;
    for (const id of b.members) {
      const u = this.host.world.units.get(id);
      if (!u) continue;
      hp += u.hp;
      max += u.maxHp;
    }
    return max > 0 ? hp / max : 1;
  }

  private atGoal(b: Brain): boolean {
    for (const id of b.members) {
      const u = this.host.world.units.get(id);
      if (u && Math.hypot(u.x - b.targetX, u.y - b.targetY) <= 600) return true;
    }
    return false;
  }

  private enemyNear(ai: AiPlayer, x: number, y: number, radius: number): boolean {
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.owner === ai.player || !ai.hostileTo(u)) continue;
      if (Math.hypot(u.x - x, u.y - y) <= radius) return true;
    }
    return false;
  }
}

export type { AiHost } from "./aiPlayer";
