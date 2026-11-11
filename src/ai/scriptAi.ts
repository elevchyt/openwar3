import { intToRawcode, rawcodeToInt } from "../jass/lexer";
import { buildInterpreter } from "../jass/headless";
import type { Interpreter } from "../jass/interpreter";
import type { EngineHooks, JassUnit, NativeCtx, Runtime } from "../jass/runtime";
import { asInt, asNum, jBool, jInt, JNULL, truthy, type JassValue } from "../jass/values";
import { jassOwnerOf, type SimUnit } from "../sim/world";
import { AiPlayer, type AiHost, REGROUP_HP_FRACTION, RETREAT_HP_FRACTION, TOWN_RADIUS } from "./aiPlayer";
import { AiCaster, CAST_PERIOD } from "./casting";

// A computer player that runs ITS MAP'S OWN `.ai` SCRIPT (docs/melee-ai.md, "A map's own AI").
//
// `StartMeleeAI(p, name)` names a file, and for the four melee races that file is Blizzard's —
// `human.ai`, `orc.ai`, `undead.ai`, `elf.ai` — which src/ai/ carries as hand ports. Anything
// else is the map's: (4)Monolith seats its four "Monolithic Creeps" players on
// `war3mapImported\Murloc_AI.ai`, `…\Spider_AI.ai` and six more, imported into the map and
// written in the World Editor's AI Editor. Those are not ported; they are RUN. So is a CAMPAIGN
// chapter's `StartCampaignAI(p, "o03_blue.ai")` — 207 files in the install's `Scripts\`, all on
// common.ai's campaign library (defenders, guard posts, suicide waves; see the GuardPosts and
// ScriptCaptain headers and docs/melee-ai.md "Campaign chapters").
//
// An `.ai` file is JASS on top of `Scripts\common.ai` (which is itself JASS on top of ~120 AI
// natives the engine answers). So each such computer gets a VM of its own — the AI keeps its
// own globals per player in the real client too — loaded with common.j, common.ai and the
// script, and the natives here answer common.ai's questions out of the SAME library the melee
// ports use: `AiPlayer` is common.ai's build loop, harvest split and counts function for
// function, and is reused rather than duplicated.
//
// Three seams make the rest work:
//
//   • THREADS. `main()` is `StartThread(WorkerAssignment)` / `StartThread(AttackAssignment)` /
//     `PlayGame()` — three loops that `Sleep`. The interpreter already parks trigger threads on
//     game time; an AI VM (`Interpreter.aiScript`) adds common.ai's two thread natives to it.
//
//   • THE BUILD LOOP. common.ai's `OneBuildLoop` walks the `build_*` arrays the script filled
//     and ends in `SetProduce`, i.e. in placement and training. That walk is `AiPlayer.runBuildLoop`
//     already, so `OneBuildLoop` is answered by a native of the same name (a native outranks a
//     script function at every call site): it hands the arrays over row for row and runs the
//     ported loop. Everything above it — the editor's priorities, `SetBuildAll` — stays JASS.
//
//   • THE CAPTAIN. The attack group is engine state in WC3 (`AddAssault`, `CaptainIsFull`,
//     `AttackMoveKill`, `CaptainRetreating`…); `ScriptCaptain` below is it. The decisions —
//     when to form, what to hit, when to give up — are all the script's own JASS
//     (`FormGroup`, `AttackMoveKillA`, `LaunchAttack`), unchanged.
//
// A native the scripts reach that is not answered here falls through to the interpreter's
// "declared but unimplemented" path: a typed default, logged once by name.

/** How often the captain re-states its orders and checks its health — the melee port's own
 *  attack clock (src/ai/index.ts ATTACK_PERIOD). */
const CAPTAIN_PERIOD = 1;
/** …and how often an order nothing has changed about is re-stated — index.ts REISSUE_PERIOD. */
const REISSUE_PERIOD = 4;
/** How close a member must be to the captain's TARGET before it is ordered onto it by name
 *  rather than attack-moved at its position. `AttackMoveKill(target)` is "attack-move toward
 *  it, then kill it" — and an attack-move whose acquisition prefers the defenders around a
 *  building would otherwise stand beside the building it was sent for. OURS: one screen. */
const KILL_RANGE = 900;
/** "At the goal": any member within this of it — index.ts `atGoal`'s 600. */
const AT_GOAL = 600;
/** How far a guard may stand from its post before `ReturnGuardPosts` walks it back. OURS: a
 *  unit's own few strides — a guard pushed aside by a passing army is not "away". */
const GUARD_LEASH = 200;
/** …and a defender from its captain's home once the town is clear. OURS: half a town. */
const DEFENSE_LEASH = TOWN_RADIUS / 2;

/** The sources a script AI is built from: the install's libraries and the map's file. */
export interface ScriptAiSources {
  commonJ: string;
  commonAi: string;
  script: string;
  /** The map's `SetPlayers` — what `GetPlayers()` answers in the AI's VM, which runs no
   *  `config()` of its own. */
  players: number;
}

/** A command a map trigger left on this computer's stack — `CommandAI(p, command, data)`. */
interface AiCommand {
  command: number;
  data: number;
}

/** Who else may hold a unit — the seat answers for the other captain and the guard posts. */
type Holder = "attack" | "defense" | "guard" | "ignored" | null;

/**
 * A CAPTAIN — the engine half of common.ai's `Captain*` / `AddAssault` / `AddDefenders` natives.
 * common.ai names two (`ATTACK_CAPTAIN = 1`, `DEFENSE_CAPTAIN = 2`, `BOTH_CAPTAINS = 3`), and
 * `CaptainInCombat(attack_captain)` asks after either.
 *
 * The ATTACK captain's membership is accumulated by `AddAssault` (FormGroup calls `InitAssault`
 * and then one `AddAssault(qty, id)` per row, every few seconds, until `CaptainIsFull`), its goal
 * is set by `AttackMoveKill` / `CaptainAttack` / `SuicidePlayer`, and it turns for home on its
 * own when its hit points fall — what `CaptainRetreating()` reports and every editor-written
 * attack loop waits on — unless the script said `SetGroupsFlee(false)`, which every campaign
 * script does through `CampaignAI`. A SUICIDE wave never turns back: `SuicideOnPlayerWave`
 * waits for `CaptainIsEmpty()`. Retreat and regroup reuse the melee port's two fractions
 * (index.ts) so the two AIs break and re-form at the same points.
 *
 * The DEFENSE captain is what a campaign's `CampaignDefender*` rows fill (`BuildDefenders` →
 * `AddDefenders`): units held at home that answer an enemy in the town and walk back after it.
 */
class ScriptCaptain {
  readonly members = new Set<number>();
  /** `InitAssault`/`AddAssault` — what the group wants, by type. */
  private desired = new Map<string, number>();
  private goal: { x: number; y: number; id: number } | null = null;
  retreating = false;
  /** `SetGroupsFlee` — the attack group breaks off at the melee port's retreat fraction. */
  groupsFlee = true;
  /** `SuicidePlayer` / `SuicidePlayerUnits`: the wave goes after this player's buildings
   *  (or units) one after another until it is dead. */
  private suicide: { player: number; buildings: boolean } | null = null;
  /** `SetCaptainHome(which, x, y)` — else the town (AiPlayer.home). */
  homeAt: { x: number; y: number } | null = null;
  private reissueIn = 0;
  private clock = 0;

  constructor(
    private readonly ai: AiPlayer,
    private readonly host: AiHost,
    readonly kind: "attack" | "defense",
    /** Who holds a unit other than this captain (the other captain, a guard post…). */
    private readonly heldBy: (id: number) => Holder,
    /** A guard post gives up the unit this captain just drafted (the post falls vacant). */
    private readonly draft: (id: number) => void,
  ) {}

  private get world() {
    return this.host.world;
  }

  home(): { x: number; y: number } {
    return this.homeAt ?? this.ai.home();
  }

  private alive(id: number): SimUnit | null {
    const u = this.world.units.get(id);
    return u && u.hp > 0 && u.owner === this.ai.player ? u : null;
  }

  prune(): void {
    for (const id of [...this.members]) if (!this.alive(id)) this.members.delete(id);
  }

  private countOf(id: string): number {
    let n = 0;
    for (const m of this.members) if (this.world.units.get(m)?.typeId === id) n++;
    return n;
  }

  initAssault(): void {
    this.desired.clear();
    // A new wave is being formed: whatever is left of the last suicide run is no longer sent
    // anywhere by name (it finishes the fight it is in), and the new members muster at home.
    if (this.suicide) {
      this.suicide = null;
      this.goal = null;
    }
  }

  /** `AddAssault(qty, id)` / `AddDefenders(qty, id)` — take up to `qty` finished units of this
   *  type into the group. True when the group now holds that many.
   *
   *  The ATTACK captain may draft a GUARD (a preplaced unit at its post) once the free units of
   *  that type run out — "the AI adds guard units to the attack group and then trains
   *  replacements for them" (Hive, "Replacing preplaced units"; the editor's own hint for
   *  Ignore Guard Position is that it stops the AI USING the unit). The defense captain only
   *  ever takes free units. Neither takes an IGNORED unit. */
  addAssault(qty: number, id: string): boolean {
    this.prune();
    this.desired.set(id, qty);
    let have = this.countOf(id);
    if (have >= qty) return true;
    const home = this.home();
    const free: SimUnit[] = [];
    const guards: SimUnit[] = [];
    for (const u of this.ai.army()) {
      if (u.typeId !== id || this.members.has(u.id)) continue;
      if (u.building?.constructionLeft) continue;
      const h = this.heldBy(u.id);
      if (h === null) free.push(u);
      else if (h === "guard" && this.kind === "attack") guards.push(u);
    }
    for (const u of [...free, ...guards]) {
      if (have >= qty) break;
      if (guards.includes(u)) this.draft(u.id);
      this.members.add(u.id);
      have++;
      // A soldier joining a group that is not out on the field musters at home.
      if (!this.goal && Math.hypot(u.x - home.x, u.y - home.y) > TOWN_RADIUS / 2) this.move(u, home.x, home.y);
    }
    return have >= qty;
  }

  isFull(): boolean {
    this.prune();
    for (const [id, qty] of this.desired) if (this.countOf(id) < qty) return false;
    return true;
  }

  /** `CaptainReadiness` / `…HP` — the group's hit points as a percentage of its maximum. */
  readinessHp(): number {
    let hp = 0;
    let max = 0;
    for (const id of this.members) {
      const u = this.alive(id);
      if (!u) continue;
      hp += u.hp;
      max += u.maxHp;
    }
    return max > 0 ? Math.round((100 * hp) / max) : 100;
  }

  readinessMana(): number {
    let mp = 0;
    let max = 0;
    for (const id of this.members) {
      const u = this.alive(id);
      if (!u || u.maxMana <= 0) continue;
      mp += u.mana;
      max += u.maxMana;
    }
    return max > 0 ? Math.round((100 * mp) / max) : 100;
  }

  inCombat(): boolean {
    for (const id of this.members) {
      const u = this.alive(id);
      if (u && (u.inCombat || (u.order === "attack" && u.targetId !== null))) return true;
    }
    return false;
  }

  centre(): { x: number; y: number } | null {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const id of this.members) {
      const u = this.alive(id);
      if (!u) continue;
      x += u.x;
      y += u.y;
      n++;
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  atGoal(): boolean {
    if (!this.goal) return false;
    for (const id of this.members) {
      const u = this.alive(id);
      if (u && Math.hypot(u.x - this.goal.x, u.y - this.goal.y) <= AT_GOAL) return true;
    }
    return false;
  }

  isHome(): boolean {
    const c = this.centre();
    if (!c) return true;
    const home = this.home();
    return Math.hypot(c.x - home.x, c.y - home.y) <= TOWN_RADIUS / 2;
  }

  /** `AttackMoveKill(target)` / `CaptainAttack(x, y)` / `AttackMoveXY(x, y)`. Called every few
   *  seconds by `CommonSleepUntilTargetDead`, so a call that changes nothing changes nothing. */
  attack(x: number, y: number, id = 0): void {
    if (this.retreating) return;
    const same = this.goal && this.goal.id === id && Math.hypot(this.goal.x - x, this.goal.y - y) < 128;
    this.goal = { x, y, id };
    if (!same) this.reissueIn = 0;
    this.issue();
  }

  /**
   * `SuicidePlayer(p, check_full)` / `SuicidePlayerUnits(p, check_full)` — send the wave at
   * player `p`, and report whether it went. common.ai calls it as
   * `exitwhen SuicidePlayer(p, sleep_seconds >= -60)`: while the wave is not overdue it must be
   * FULL to go, and a minute past its time it goes with whatever it has. A group with nobody in
   * it does not go (OURS: the script then forms again five seconds later, rather than declaring
   * an empty wave sent and moving on to the next).
   *
   * What it is sent AT is the engine's to choose and is not in any file: OURS is the nearest of
   * `p`'s buildings to the group (its units for `…Units`), re-picked as each one falls, until
   * `p` has nothing left. A campaign computer knows where the player's base is — the missions
   * are written around waves that walk straight to it — so the pick reads the world rather than
   * this computer's fog; the ORDERS still go through `execute` like a click.
   */
  suicidePlayer(player: number, buildings: boolean, checkFull: boolean): boolean {
    this.prune();
    if (!this.members.size) return false;
    if (checkFull && !this.isFull()) return false;
    this.suicide = { player, buildings };
    this.retreating = false;
    const t = this.suicideTarget();
    if (!t) {
      this.suicide = null;
      return false;
    }
    this.goal = { x: t.x, y: t.y, id: t.id };
    this.reissueIn = 0;
    this.issue();
    return true;
  }

  private suicideTarget(): SimUnit | null {
    const s = this.suicide;
    if (!s) return null;
    const from = this.centre() ?? this.home();
    let best: SimUnit | null = null;
    let bestD = Infinity;
    let fallback: SimUnit | null = null;
    let fallbackD = Infinity;
    for (const u of this.world.units.values()) {
      if (u.owner !== s.player || u.hp <= 0) continue;
      const d = Math.hypot(u.x - from.x, u.y - from.y);
      if (!!u.building === s.buildings) {
        if (d < bestD) { bestD = d; best = u; }
      } else if (d < fallbackD) {
        fallbackD = d;
        fallback = u;
      }
    }
    return best ?? fallback;
  }

  clearTargets(): void {
    this.goal = null;
    this.suicide = null;
  }

  goHome(): void {
    this.goal = null;
    this.suicide = null;
    const home = this.home();
    for (const id of this.members) {
      const u = this.alive(id);
      if (u) this.move(u, home.x, home.y);
    }
  }

  /** `TeleportCaptain(x, y)` — the group is PUT there, as a trigger's `SetUnitPosition` puts a
   *  unit (h06_green.ai's portals). Through the map's own engine table, so it is the same
   *  world write a map makes; with no table (headless) it is a move. */
  teleport(x: number, y: number, hooks: EngineHooks | null): void {
    for (const id of this.members) {
      const u = this.alive(id);
      if (!u) continue;
      if (hooks?.setUnitPosition) hooks.setUnitPosition(u.id, x, y);
      else this.move(u, x, y);
    }
  }

  /** `RemoveInjuries` — the hurt leave the group (and stay home). The melee port's retreat
   *  fraction, so "injured" means one thing to both AIs. */
  removeInjuries(): void {
    for (const id of [...this.members]) {
      const u = this.alive(id);
      if (!u || u.hp < u.maxHp * RETREAT_HP_FRACTION) this.members.delete(id);
    }
  }

  /** Let a unit go (Recycle/Ignore Guard Position reaching a member, a script taking it). */
  release(id: number): void {
    this.members.delete(id);
  }

  tick(dt: number): void {
    this.clock += dt;
    if (this.clock < CAPTAIN_PERIOD) return;
    this.clock = 0;
    this.prune();
    if (this.kind === "defense") return this.defend();
    if (!this.members.size) {
      this.retreating = false;
      this.suicide = null;
      return;
    }
    if (this.retreating) {
      // Home and healed: the group is the script's again.
      if (this.isHome() && this.readinessHp() >= REGROUP_HP_FRACTION * 100) this.retreating = false;
      return;
    }
    if (!this.goal) return;
    // SetGroupsFlee — a broken group turns for home rather than feeding itself in. A suicide
    // wave is the one that does not.
    if (!this.suicide && this.groupsFlee && this.readinessHp() < RETREAT_HP_FRACTION * 100) {
      this.retreating = true;
      this.goHome();
      return;
    }
    if (this.goal.id) {
      const t = this.world.units.get(this.goal.id);
      if (t && t.hp > 0) {
        this.goal.x = t.x;
        this.goal.y = t.y;
      } else if (this.suicide) {
        // The building fell: on to the next one of theirs.
        const next = this.suicideTarget();
        if (!next) {
          this.suicide = null;
          this.goal = null;
          return;
        }
        this.goal = { x: next.x, y: next.y, id: next.id };
        this.reissueIn = 0;
      }
    }
    this.reissueIn -= CAPTAIN_PERIOD;
    if (this.reissueIn <= 0) this.issue();
  }

  /**
   * The defense captain's whole job: an enemy fighting unit inside the town (the same reading
   * as `TownThreatened`) is attack-moved at; with none, the defenders walk back to their home
   * and stand there. `CaptainInCombat(false)` is what the script reads of it — `CampaignBasicsA`
   * pulls its lumberjacks and stops topping the group up while it is fighting.
   */
  private defend(): void {
    if (!this.members.size) return;
    const home = this.home();
    let threat: SimUnit | null = null;
    let threatD = Infinity;
    for (const u of this.world.units.values()) {
      if (u.hp <= 0 || u.owner === this.ai.player || u.building || !this.ai.hostileTo(u)) continue;
      const d = Math.hypot(u.x - home.x, u.y - home.y);
      if (d <= TOWN_RADIUS && d < threatD && this.ai.knows(u)) {
        threatD = d;
        threat = u;
      }
    }
    if (threat) {
      const moved = !this.goal || Math.hypot(this.goal.x - threat.x, this.goal.y - threat.y) > 300;
      this.goal = { x: threat.x, y: threat.y, id: 0 };
      this.reissueIn -= CAPTAIN_PERIOD;
      if (moved || this.reissueIn <= 0) this.issue();
      return;
    }
    this.goal = null;
    for (const id of this.members) {
      const u = this.alive(id);
      if (!u || u.inCombat || (u.order === "attack" && u.targetId)) continue;
      if (u.order === "move" || Math.hypot(u.x - home.x, u.y - home.y) <= DEFENSE_LEASH) continue;
      this.move(u, home.x, home.y);
    }
  }

  private issue(): void {
    const g = this.goal;
    if (!g) return;
    this.reissueIn = REISSUE_PERIOD;
    const target = g.id ? this.world.units.get(g.id) : undefined;
    const targetUp = !!target && target.hp > 0;
    for (const id of this.members) {
      const u = this.alive(id);
      if (!u) continue;
      // Already swinging at something: left alone (index.ts issueAttack says why).
      if (u.order === "attack" && u.targetId) continue;
      if (targetUp && Math.hypot(u.x - target!.x, u.y - target!.y) <= KILL_RANGE) {
        this.ai.order({ c: "order", unitId: u.id, order: { kind: "attack", targetId: target!.id }, queued: false });
        continue;
      }
      if (u.order === "attackmove" && Math.hypot(u.amDestX - g.x, u.amDestY - g.y) <= 128) continue;
      this.ai.order({ c: "order", unitId: u.id, order: { kind: "attackmove", x: g.x, y: g.y }, queued: false });
    }
  }

  private move(u: SimUnit, x: number, y: number): void {
    this.ai.order({ c: "order", unitId: u.id, order: { kind: "move", x, y }, queued: false });
  }
}

/** One post: a type, a spot, the unit holding it (0 = vacant) and how often it was refilled. */
interface GuardPost {
  typeId: string;
  x: number;
  y: number;
  unitId: number;
  refills: number;
  /** `AddGuardPost` makes a post nobody stands at yet; filling it the first time is not a
   *  REPLACEMENT and costs nothing of `SetReplacementCount`. */
  filled: boolean;
}

/**
 * GUARD POSTS — the engine state behind `AddGuardPost` / `FillGuardPosts` / `ReturnGuardPosts`
 * and the map's `RemoveGuardPosition` / `RecycleGuardPosition` / `RemoveAllGuardPositions`.
 *
 * Nothing in a data file states what a guard position is; the World Editor's own hints do
 * (UI\TriggerStrings.txt): every PRE-PLACED unit of a computer has one — "This has no effect on
 * Heroes and peon-type units" — Ignore tells the AI "to neither use nor replace" the unit, and
 * Recycle frees "the guard position that once belonged to the specified unit". Blizzard.j's
 * own `MeleeStartingAI` recycles the undead's starting Ghoul so the melee AI may use it, which
 * is the same reading: a guard is a unit the AI is minding at a spot until told otherwise.
 * The rest is Hive's (threads 104831 "Replacing preplaced units", 357079 "SetReplacements — when
 * does it count", the wc3we "GUI Triggering" reference): the attack captain may DRAFT a guard
 * and the post is then refilled — "how many times the AI will send units to the position of
 * killed units" is `SetReplacementCount`; Recycle hands the unit to the DEFENSE group and sends
 * no one to the post again; and units a TRIGGER creates for the computer get posts too, which is
 * why HumanX03 calls Ignore on `GetLastCreatedUnit()` a dozen times.
 */
class GuardPosts {
  readonly posts: GuardPost[] = [];
  /** Units whose post was IGNORED: never used, never replaced, never walked back. */
  readonly ignored = new Set<number>();
  /** `SetReplacementCount` — refills per post. OURS: 0 until a script says otherwise (common.ai
   *  never sets it outside `SetReplacements`, and the editor's AI has no field for it). */
  replacements = 0;

  constructor(private readonly ai: AiPlayer, private readonly host: AiHost) {}

  /** Is this a unit a post is made for? Not a hero, a worker, a building or a summon. */
  private guardable(u: SimUnit): boolean {
    return u.owner === this.ai.player && u.hp > 0 && !u.isHero && !u.worker && !u.building
      && u.speed > 0 && u.summonLeft <= 0 && !u.isIllusion;
  }

  /** At the seat's start: every unit already standing gets a post where it stands. */
  seed(): void {
    for (const u of this.host.world.units.values()) this.adopt(u.id);
  }

  /** A unit appeared that is not the AI's own production (a trigger's `CreateUnit`). */
  adopt(id: number): void {
    const u = this.host.world.units.get(id);
    if (!u || !this.guardable(u) || this.holder(id)) return;
    this.posts.push({ typeId: u.typeId, x: u.x, y: u.y, unitId: u.id, refills: 0, filled: true });
  }

  /** `AddGuardPost(id, x, y)`. */
  add(typeId: string, x: number, y: number): void {
    this.posts.push({ typeId, x, y, unitId: 0, refills: 0, filled: false });
  }

  holder(id: number): GuardPost | undefined {
    return id ? this.posts.find((p) => p.unitId === id) : undefined;
  }

  /** The attack captain took this unit: its post falls vacant. */
  vacate(id: number): void {
    const p = this.holder(id);
    if (p) p.unitId = 0;
  }

  /** `RemoveGuardPosition(u)` — "neither use nor replace". */
  ignore(id: number): void {
    const i = this.posts.findIndex((p) => p.unitId === id);
    if (i >= 0) this.posts.splice(i, 1);
    this.ignored.add(id);
  }

  /** `RecycleGuardPosition(u)` — the post is gone; the unit is the AI's to use again. */
  recycle(id: number): void {
    const i = this.posts.findIndex((p) => p.unitId === id);
    if (i >= 0) this.posts.splice(i, 1);
    this.ignored.delete(id);
  }

  /** `RemoveAllGuardPositions(p)`. */
  ignoreAll(): void {
    for (const p of this.posts) if (p.unitId) this.ignored.add(p.unitId);
    this.posts.length = 0;
  }

  /** `IgnoredUnits(id)` — how many of this type are standing out of the AI's reach. common.ai
   *  adds it to every wave it trains for (`BuildAttackers`, `PrepTime`), because `TownCount`
   *  counts them and the captain cannot have them. */
  ignoredCount(typeId: string): number {
    let n = 0;
    for (const id of this.ignored) {
      const u = this.host.world.units.get(id);
      if (u && u.hp > 0 && u.owner === this.ai.player && u.typeId === typeId) n++;
    }
    return n;
  }

  /** `FillGuardPosts()` — every vacant post the budget still covers gets a free unit of its
   *  type sent to it; with none standing, one is asked for (`SetProduce`, through `execute` like
   *  everything else). */
  fill(free: (u: SimUnit) => boolean): void {
    const world = this.host.world;
    const asked = new Set<string>();
    for (const p of this.posts) {
      const cur = p.unitId ? world.units.get(p.unitId) : undefined;
      if (cur && cur.hp > 0 && cur.owner === this.ai.player) continue;
      p.unitId = 0;
      if (p.filled && p.refills >= this.replacements) continue;
      let best: SimUnit | null = null;
      let bestD = Infinity;
      for (const u of this.ai.army()) {
        if (u.typeId !== p.typeId || !free(u)) continue;
        const d = Math.hypot(u.x - p.x, u.y - p.y);
        if (d < bestD) { bestD = d; best = u; }
      }
      if (best) {
        p.unitId = best.id;
        if (p.filled) p.refills++;
        p.filled = true;
        this.walk(best, p);
      } else if (!asked.has(p.typeId)) {
        asked.add(p.typeId);
        this.ai.produce(this.ai.count(p.typeId) + 1, p.typeId, -1);
      }
    }
  }

  /** `ReturnGuardPosts()` — a guard standing idle away from its post walks back to it. One
   *  that is fighting is left to finish (it chased something, which is what a guard does). */
  returnAll(): void {
    for (const p of this.posts) {
      const u = p.unitId ? this.host.world.units.get(p.unitId) : undefined;
      if (!u || u.hp <= 0 || u.inCombat || (u.order === "attack" && u.targetId)) continue;
      if (u.order !== "idle" && u.order !== "hold") continue;
      if (Math.hypot(u.x - p.x, u.y - p.y) > GUARD_LEASH) this.walk(u, p);
    }
  }

  private walk(u: SimUnit, p: GuardPost): void {
    this.ai.order({ c: "order", unitId: u.id, order: { kind: "move", x: p.x, y: p.y }, queued: false });
  }
}

/** One computer running a script of its own. */
class ScriptSeat {
  readonly ai: AiPlayer;
  readonly interp: Interpreter;
  /** `ATTACK_CAPTAIN` and `DEFENSE_CAPTAIN` (common.ai). */
  readonly captain: ScriptCaptain;
  readonly defense: ScriptCaptain;
  readonly guards: GuardPosts;
  /** Everything held by a captain, a post or an Ignore — what `AiPlayer.captainHeld` keeps the
   *  harvest off. Rebuilt every tick. */
  private readonly held = new Set<number>();
  readonly caster: AiCaster;
  readonly commands: AiCommand[] = [];
  /** `SetHeroLevels(function f)` — the script's skill chooser, and the hero it is being asked
   *  about while it runs (`GetHeroId` / `GetHeroLevelAI`). */
  heroLevels: string | null = null;
  heroCtx: { typeId: string; level: number } | null = null;
  allianceTarget = 0;
  castIn = 0;
  censusIn = 0;

  constructor(
    readonly player: number,
    readonly name: string,
    host: AiHost,
    race: string,
    difficulty: number,
    startX: number,
    startY: number,
    seed: number,
    sources: ScriptAiSources,
    hooks: EngineHooks | null,
  ) {
    this.ai = new AiPlayer(player, race, difficulty, host, startX, startY, seed);
    this.hooks = hooks;
    this.guards = new GuardPosts(this.ai, host);
    this.captain = new ScriptCaptain(this.ai, host, "attack", (id) => this.heldBy(id), (id) => this.guards.vacate(id));
    this.defense = new ScriptCaptain(this.ai, host, "defense", (id) => this.heldBy(id), (id) => this.guards.vacate(id));
    this.ai.captainHeld = this.held;
    this.caster = new AiCaster({
      world: host.world,
      player,
      def: (id) => host.abilities.get(id),
      hostile: (u) => this.ai.hostileTo(u),
      order: (cmd) => this.ai.order(cmd),
    });
    this.castIn = CAST_PERIOD * (1 + player / 12);
    this.interp = buildInterpreter([sources.commonJ, sources.commonAi, sources.script], {
      hooks: hooks ?? undefined,
      seed: (seed + player * 7919 + 1) >>> 0,
    });
    this.interp.aiScript = true;
    this.interp.rt.setup.numPlayers = sources.players;
    registerAiNatives(this.interp.rt, this, host);
  }

  /** The map's engine table — what `TeleportCaptain` puts units with. */
  readonly hooks: EngineHooks | null;

  /** Who holds this unit, if anybody. */
  heldBy(id: number): Holder {
    if (this.captain.members.has(id)) return "attack";
    if (this.defense.members.has(id)) return "defense";
    if (this.guards.ignored.has(id)) return "ignored";
    if (this.guards.holder(id)) return "guard";
    return null;
  }

  /** A unit nothing holds, standing finished and idle — what a post or a suicide run may take. */
  freeUnit(u: SimUnit): boolean {
    return this.heldBy(u.id) === null && !u.building && (u.order === "idle" || u.order === "hold");
  }

  /** `RemoveGuardPosition` / `RecycleGuardPosition` (a map trigger, via ScriptAi). */
  guardPosition(id: number, op: "ignore" | "recycle"): void {
    this.captain.release(id);
    this.defense.release(id);
    if (op === "ignore") this.guards.ignore(id);
    else {
      this.guards.recycle(id);
      // "Clears the unit's guard position and orders it to join the defense group" (wc3we).
      this.defense.members.add(id);
    }
  }

  /**
   * `SuicideUnit(count, id)` / `SuicideUnitEx(count, id, player)` — `count` of this type, one at
   * a time, sent to die at a player: the free ones standing are sent at once, and for any
   * shortfall one more is asked of the build (common.ai's `SuicideUnits` calls this once a
   * second per type, "MASS SUICIDE"). With no player named, the target is the nearest hostile
   * one's nearest building to our town (OURS — the native names nobody).
   */
  suicideUnit(count: number, typeId: string, player: number | null, host: AiHost): void {
    const home = this.ai.home();
    let target: SimUnit | null = null;
    let best = Infinity;
    for (const u of host.world.units.values()) {
      if (u.hp <= 0 || !u.building || u.owner === this.player || u.owner < 0) continue;
      if (player !== null ? u.owner !== player : !this.ai.hostileTo(u)) continue;
      const d = Math.hypot(u.x - home.x, u.y - home.y);
      if (d < best) { best = d; target = u; }
    }
    if (!target) return;
    let sent = 0;
    for (const u of this.ai.army()) {
      if (sent >= count) break;
      if (u.typeId !== typeId || !this.freeUnit(u)) continue;
      this.ai.order({ c: "order", unitId: u.id, order: { kind: "attackmove", x: target.x, y: target.y }, queued: false });
      sent++;
    }
    if (sent < count) this.ai.produce(this.ai.count(typeId) + 1, typeId, -1);
  }

  /** The script's `main()` — runs at once up to its first `Sleep`, as the real client does.
   *  Everything standing for this computer when it starts gets a guard post first. */
  start(): void {
    this.guards.seed();
    try {
      this.interp.run("main", []);
    } catch (err) {
      console.warn(`[ai] ${this.name} (player ${this.player}) main() failed:`, err);
    }
  }

  tick(dt: number): void {
    this.censusIn -= dt;
    if (this.censusIn <= 0) {
      // `set_vars`' once-a-second census — the counts the script's natives read.
      this.censusIn = 1;
      this.ai.refresh();
    }
    try {
      this.interp.advanceTime(dt);
    } catch (err) {
      console.warn(`[ai] ${this.name} (player ${this.player}) thread failed:`, err);
    }
    this.captain.tick(dt);
    this.defense.tick(dt);
    this.held.clear();
    for (const id of this.captain.members) this.held.add(id);
    for (const id of this.defense.members) this.held.add(id);
    for (const id of this.guards.ignored) this.held.add(id);
    for (const p of this.guards.posts) if (p.unitId) this.held.add(p.unitId);
    this.castIn -= dt;
    if (this.castIn <= 0) {
      this.castIn = CAST_PERIOD;
      this.caster.pass();
    }
  }

  /** Spend every unspent skill point through the script's own chooser (`SetHeroLevels`). One
   *  call per point, lowest level first: `ChooseHeroSkill` indexes `skills1[level]`. */
  spendSkillPoints(host: AiHost): void {
    if (!this.heroLevels) return;
    for (const u of host.world.units.values()) {
      if (u.owner !== this.player || u.hp <= 0 || !u.isHero) continue;
      for (let guard = 0; u.skillPoints > 0 && guard < 10; guard++) {
        this.heroCtx = { typeId: u.typeId, level: u.level - u.skillPoints + 1 };
        let pick = 0;
        try {
          pick = asInt(this.interp.callFunction(this.heroLevels, []));
        } finally {
          this.heroCtx = null;
        }
        const want = pick ? intToRawcode(pick) : "";
        if (want && host.execute(this.player, { c: "learnskill", unitId: u.id, abilityId: want })) continue;
        // A pick the hero cannot take (a typo, a maxed skill): anything it can — the melee
        // port's rule, so a hero never sits on its points (AiPlayer.spendSkillPoints).
        if (!u.abilities.some((ab) => host.execute(this.player, { c: "learnskill", unitId: u.id, abilityId: ab.id }))) break;
      }
    }
  }
}

/** The JASS value for a sim unit, interned in this VM. */
function unitValue(rt: Runtime, u: SimUnit | null | undefined): JassValue {
  if (!u || u.hp <= 0) return JNULL;
  return rt.unitForSim({ id: u.id, typeId: u.typeId, owner: jassOwnerOf(u), x: u.x, y: u.y, facing: u.facing });
}

/** The common.ai natives, answered for one seat. */
function registerAiNatives(rt: Runtime, seat: ScriptSeat, host: AiHost): void {
  const ai = seat.ai;
  const cap = seat.captain;
  const def = (name: string, fn: (c: NativeCtx, a: JassValue[]) => JassValue): void => void rt.natives.set(name, fn);
  const id = (v: JassValue | undefined): string => intToRawcode(asInt(v ?? jInt(0)));
  const simUnit = (v: JassValue | undefined): SimUnit | undefined => {
    const ju = v ? rt.data<JassUnit>(v) : undefined;
    return ju && ju.simId >= 0 ? host.world.units.get(ju.simId) : undefined;
  };
  const nothing = (): JassValue => JNULL;

  // --- identity, threads, debugging -------------------------------------------------------
  def("GetAiPlayer", () => jInt(seat.player));
  def("MeleeDifficulty", () => jInt(ai.meleeDifficulty()));
  def("DoAiScriptDebug", () => jBool(false));
  for (const n of ["DebugS", "DebugFI", "DebugUnitID", "DisplayText", "DisplayTextI", "DisplayTextII", "DisplayTextIII"]) def(n, nothing);

  // --- the flags block every editor-written InitOptions sets. What the engine would do with
  // them is behaviour the captain and the build loop already have (they group-flee, repair…);
  // only SetPeonsRepair is a switch on the library, and it is read.
  def("SetPeonsRepair", (_c, a) => ((ai.peonsRepair = truthy(a[0])), JNULL));
  def("SetGroupsFlee", (_c, a) => ((cap.groupsFlee = truthy(a[0])), JNULL));
  def("SetReplacementCount", (_c, a) => ((seat.guards.replacements = Math.max(0, asInt(a[0]))), JNULL));
  for (const n of [
    "SetCampaignAI", "SetMeleeAI", "SetTargetHeroes", "SetRandomPaths", "SetDefendPlayer", "SetHeroesFlee",
    "SetHeroesBuyItems", "SetWatchMegaTargets", "SetIgnoreInjured", "SetHeroesTakeItems", "SetUnitsFlee",
    "SetSlowChopping", "SetCaptainChanges", "SetSmartArtillery",
    "SetNewHeroes", "SetAmphibious", "DisablePathing", "StopGathering", "CreateCaptains", "PurchaseZeppelin",
    "GroupTimedLife", "Unsummon", "SetStagePoint", "LoadZepWave", "CaptainVsUnits", "CaptainVsPlayer",
  ]) def(n, nothing);
  // `Cheat("showmap")`, `"dg"`, `"av"`, `"control 4"`… — eight campaign scripts still carry the
  // designers' own debugging switches (h04_orange.ai, h07_aqua.ai, n07_rainbow.ai…). A computer
  // here does not cheat, and these were never meant to reach a player: refused, silently.
  def("Cheat", nothing);
  // Two common.j natives no map VM has needed and every campaign script reaches:
  // `CampaignBasicsA` sizes its farms by `GetFoodMade(racial_farm)` (UnitBalance `fmade`).
  def("GetFoodMade", (_c, a) => jInt(host.registry.get(id(a[0]))?.foodMade ?? 0));
  def("GetFoodUsed", (_c, a) => jInt(host.registry.get(id(a[0]))?.foodUsed ?? 0));
  def("SetHeroLevels", (_c, a) => ((seat.heroLevels = a[0]?.k === "code" ? a[0].fn : null), JNULL));
  def("GetHeroId", () => jInt(seat.heroCtx ? rawcodeToInt(seat.heroCtx.typeId) : 0));
  def("GetHeroLevelAI", () => jInt(seat.heroCtx?.level ?? 0));

  // --- counts and the economy -------------------------------------------------------------
  def("GetUnitCount", (_c, a) => jInt(ai.count(id(a[0]))));
  def("GetUnitCountDone", (_c, a) => jInt(ai.countDone(id(a[0]))));
  def("GetTownUnitCount", (_c, a) => jInt(ai.countAt(id(a[0]), asInt(a[1]), truthy(a[2]))));
  def("GetPlayerUnitTypeCount", (c, a) => {
    const p = c.rt.data<{ index: number }>(a[0])?.index ?? -1;
    let n = 0;
    const want = id(a[1]);
    for (const u of host.world.units.values()) if (u.owner === p && u.hp > 0 && u.typeId === want) n++;
    return jInt(n);
  });
  def("GetUnitGoldCost", (_c, a) => jInt(host.registry.get(id(a[0]))?.goldCost ?? 0));
  def("GetUnitWoodCost", (_c, a) => jInt(host.registry.get(id(a[0]))?.lumberCost ?? 0));
  def("GetUnitBuildTime", (_c, a) => jInt(host.registry.get(id(a[0]))?.buildTime ?? 0));
  def("GetUpgradeLevel", (_c, a) => jInt(ai.upgradeLevel(id(a[0]))));
  def("GetUpgradeGoldCost", (_c, a) => jInt(host.upgrades.cost(id(a[0]), ai.upgradeLevel(id(a[0])) + 1).gold));
  def("GetUpgradeWoodCost", (_c, a) => jInt(host.upgrades.cost(id(a[0]), ai.upgradeLevel(id(a[0])) + 1).lumber));
  def("GetMinesOwned", () => jInt(ai.minesOwned()));
  def("GetGoldOwned", () => jInt(ai.goldOwned()));
  def("TownWithMine", () => jInt(ai.townWithMine()));
  def("TownHasMine", (_c, a) => jBool(ai.townHasMine(asInt(a[0]))));
  def("TownHasHall", (_c, a) => jBool(ai.townHasHall(asInt(a[0]))));
  def("GetNextExpansion", () => jInt(ai.nextExpansion()));
  def("ClearHarvestAI", () => (ai.clearHarvestAI(), JNULL));
  def("HarvestGold", (_c, a) => (ai.harvestGold(asInt(a[0]), asInt(a[1])), JNULL));
  def("HarvestWood", (_c, a) => (ai.harvestWood(asInt(a[0]), asInt(a[1])), JNULL));
  def("CreepsOnMap", () => jBool(host.creepCamps().length > 0));
  // `IgnoredUnits(id)` — how many of this type the ATTACK captain cannot have. common.ai adds it
  // to every wave it trains for (`BuildAttackers`: desire = harass_qty + IgnoredUnits) because
  // `TownCount` counts them all. The name is the editor's "Ignore Unit Guard Position", and
  // ignored units are in it; so are the DEFENDERS (OURS: nothing documents the native, but a
  // campaign script defends and attacks with the same types — h02_red.ai holds a Head Hunter
  // and sends one in wave 1 — and without them counted here the wave waits on the defender for
  // its whole form-up timeout and goes without it).
  def("IgnoredUnits", (_c, a) => {
    const t = id(a[0]);
    let n = seat.guards.ignoredCount(t);
    for (const m of seat.defense.members) if (host.world.units.get(m)?.typeId === t) n++;
    return jInt(n);
  });
  def("MergeUnits", () => jBool(false));
  def("ConvertUnits", () => jBool(false));

  // --- the build loop (see the header): common.ai's arrays, the port's loop ----------------
  def("OneBuildLoop", (c) => {
    // `total_gold = GetGold() - gold_buffer` is the first thing the JASS loop does.
    const len = asInt(c.rt.globals.get("build_length") ?? jInt(0));
    const qty = c.rt.globalArrays.get("build_qty");
    const type = c.rt.globalArrays.get("build_type");
    const item = c.rt.globalArrays.get("build_item");
    const town = c.rt.globalArrays.get("build_town");
    ai.initBuildArray();
    if (qty && type && item && town) {
      for (let i = 0; i < len; i++) ai.setBuildRow(asInt(type.get(i)), asInt(qty.get(i)), id(item.get(i)), asInt(town.get(i)));
    }
    // What the melee port does around its own loop each pass (index.ts buildPass), in order:
    // repairs before the harvest split, then the split the script asked for, then the spend.
    if (ai.peonsRepair) ai.applyRepairs();
    ai.applyHarvest();
    ai.runBuildLoop();
    // …and what it leaves is what EVERY other thread's `StartUnit` prices itself against: the
    // campaign's `BuildAttackers` and its farms run in `CampaignBasics`, a different thread,
    // on the globals this loop last wrote. Answered natively, the loop must still write them,
    // or `total_gold` stays 0 and not one wave unit is ever trained.
    const left = ai.budgetLeft();
    c.rt.globals.set("total_gold", jInt(left.gold));
    c.rt.globals.set("total_wood", jInt(left.wood));
    seat.spendSkillPoints(host);
    return JNULL;
  });
  // `StartUnit` from those other threads ends here, and h05xD.ai calls it by hand.
  def("SetProduce", (_c, a) => jBool(ai.produce(asInt(a[0]), id(a[1]), asInt(a[2]))));
  def("SetUpgrade", (_c, a) => jBool(ai.research(id(a[0]))));

  // --- targets -----------------------------------------------------------------------------
  def("GetCreepCamp", (c, a) => {
    const camp = ai.creepCamp(asInt(a[0]), asInt(a[1]), truthy(a[2]));
    if (!camp) return JNULL;
    return unitValue(c.rt, ai.campCreepsAt(camp.x, camp.y).find((u) => u.hp > 0));
  });
  def("StartGetEnemyBase", nothing);
  def("WaitGetEnemyBase", () => jBool(false));
  def("GetEnemyBase", (c) => unitValue(c.rt, ai.enemyBase()));
  def("GetEnemyExpansion", (c) => unitValue(c.rt, ai.enemyExpansion()));
  def("GetExpansionFoe", (c) => unitValue(c.rt, ai.expansionFoe()));
  // Not ported in the melee AI either (index.ts pickTarget): the engine's all-out target.
  def("GetMegaTarget", () => JNULL);
  def("GetEnemyPower", () => jInt(0));
  def("GetBuilding", () => JNULL);
  def("GetExpansionPeon", () => JNULL);
  def("SetAllianceTarget", (_c, a) => ((seat.allianceTarget = simUnit(a[0])?.id ?? 0), JNULL));
  def("GetAllianceTarget", (c) => unitValue(c.rt, seat.allianceTarget ? host.world.units.get(seat.allianceTarget) : null));
  def("TownThreatened", () => jBool(ai.townThreatened()));
  def("IsTowered", (_c, a) => {
    const u = simUnit(a[0]);
    return jBool(!!u && ai.isTowered(u));
  });
  def("UnitAlive", (_c, a) => jBool((simUnit(a[0])?.hp ?? 0) > 0));
  def("UnitInvis", (_c, a) => jBool(!!simUnit(a[0])?.invisible));

  // --- the captain -------------------------------------------------------------------------
  def("InitAssault", () => (cap.initAssault(), JNULL));
  def("AddAssault", (_c, a) => jBool(cap.addAssault(asInt(a[0]), id(a[1]))));
  def("AddDefenders", (_c, a) => jBool(seat.defense.addAssault(asInt(a[0]), id(a[1]))));
  def("CaptainIsFull", () => jBool(cap.isFull()));
  def("CaptainIsEmpty", () => (cap.prune(), jBool(cap.members.size === 0)));
  def("CaptainGroupSize", () => (cap.prune(), jInt(cap.members.size)));
  def("CaptainReadiness", () => jInt(cap.readinessHp()));
  def("CaptainReadinessHP", () => jInt(cap.readinessHp()));
  def("CaptainReadinessMa", () => jInt(cap.readinessMana()));
  // `CaptainInCombat(attack_captain)` — true asks after the attack group, false the defense.
  def("CaptainInCombat", (_c, a) => jBool((a[0] === undefined || truthy(a[0]) ? cap : seat.defense).inCombat()));
  def("CaptainRetreating", () => jBool(cap.retreating));
  def("CaptainAtGoal", () => jBool(cap.atGoal()));
  def("CaptainIsHome", () => jBool(cap.isHome()));
  def("CaptainGoHome", () => (cap.goHome(), JNULL));
  def("ClearCaptainTargets", () => (cap.clearTargets(), JNULL));
  def("RemoveInjuries", () => (cap.removeInjuries(), JNULL));
  def("RemoveSiege", nothing);
  // `SetCaptainHome(which, x, y)` — ATTACK_CAPTAIN 1, DEFENSE_CAPTAIN 2, BOTH_CAPTAINS 3
  // (common.ai). Until then a captain's home is the town (AiPlayer.home), as for the melee port.
  def("SetCaptainHome", (_c, a) => {
    const which = asInt(a[0]);
    const at = { x: asNum(a[1]), y: asNum(a[2]) };
    if (which & 1) cap.homeAt = at;
    if (which & 2) seat.defense.homeAt = at;
    return JNULL;
  });
  def("ResetCaptainLocs", () => ((cap.homeAt = null), (seat.defense.homeAt = null), JNULL));
  def("ShiftTownSpot", (_c, a) => (ai.shiftTownSpot(asNum(a[0]), asNum(a[1])), JNULL));
  def("TeleportCaptain", (_c, a) => (cap.teleport(asNum(a[0]), asNum(a[1]), seat.hooks), JNULL));
  def("CaptainAttack", (_c, a) => (cap.attack(asNum(a[0]), asNum(a[1])), JNULL));
  def("AttackMoveXY", (_c, a) => (cap.attack(asInt(a[0]), asInt(a[1])), JNULL));
  def("AttackMoveKill", (_c, a) => {
    const t = simUnit(a[0]);
    if (t && t.hp > 0) cap.attack(t.x, t.y, t.id);
    return JNULL;
  });
  const playerOf = (c: NativeCtx, v: JassValue | undefined): number => (v ? c.rt.data<{ index: number }>(v)?.index ?? -1 : -1);
  def("SuicidePlayer", (c, a) => jBool(cap.suicidePlayer(playerOf(c, a[0]), true, truthy(a[1]))));
  def("SuicidePlayerUnits", (c, a) => jBool(cap.suicidePlayer(playerOf(c, a[0]), false, truthy(a[1]))));
  def("SuicideUnit", (_c, a) => (seat.suicideUnit(asInt(a[0]), id(a[1]), null, host), JNULL));
  // SuicideUnitEx's third argument is a player INDEX, not a handle (common.ai: `integer pid`).
  def("SuicideUnitEx", (_c, a) => (seat.suicideUnit(asInt(a[0]), id(a[1]), asInt(a[2]), host), JNULL));

  // --- guard posts (see GuardPosts) ----------------------------------------------------------
  def("AddGuardPost", (_c, a) => (seat.guards.add(id(a[0]), asNum(a[1]), asNum(a[2])), JNULL));
  def("FillGuardPosts", () => (seat.guards.fill((u) => seat.freeUnit(u)), JNULL));
  def("ReturnGuardPosts", () => (seat.guards.returnAll(), JNULL));

  // --- the command stack (CommandAI) -------------------------------------------------------
  def("CommandsWaiting", () => jInt(seat.commands.length));
  def("GetLastCommand", () => jInt(seat.commands[seat.commands.length - 1]?.command ?? 0));
  def("GetLastData", () => jInt(seat.commands[seat.commands.length - 1]?.data ?? 0));
  def("PopLastCommand", () => (seat.commands.pop(), JNULL));
}

/**
 * Every computer in the match that runs a script of its own. Driven beside `MeleeAi` from the
 * authority's tick (RtsController), and only there.
 */
export class ScriptAi {
  private readonly seats: ScriptSeat[] = [];
  private readonly paused = new Set<number>();

  constructor(private readonly host: AiHost) {}

  get active(): boolean {
    return this.seats.length > 0;
  }

  has(player: number): boolean {
    return this.seats.some((s) => s.player === player);
  }

  /** Seat `player` on `sources.script`. One seat, one computer (see MeleeAi.add). */
  add(
    player: number,
    name: string,
    race: string,
    difficulty: number,
    startX: number,
    startY: number,
    seed: number,
    sources: ScriptAiSources,
    hooks: EngineHooks | null,
  ): void {
    if (this.has(player)) return;
    let seat: ScriptSeat;
    try {
      seat = new ScriptSeat(player, name, this.host, race, difficulty, startX, startY, seed, sources, hooks);
    } catch (err) {
      console.warn(`[ai] ${name} would not load for player ${player} — that computer will not play:`, err);
      return;
    }
    this.seats.push(seat);
    seat.start();
  }

  /** `CommandAI(p, command, data)` — pushed onto that computer's stack (GetLastCommand reads the
   *  newest). A player with no script AI behind it has nothing to read it with. */
  command(player: number, command: number, data: number): void {
    this.seats.find((s) => s.player === player)?.commands.push({ command, data });
  }

  /** A unit a map TRIGGER created (`CreateUnit`) — a computer on a script gives it a guard post
   *  where it stands, as it does its preplaced units (see GuardPosts). */
  unitCreated(unitId: number): void {
    const u = this.host.world.units.get(unitId);
    if (u) this.seats.find((s) => s.player === u.owner)?.guards.adopt(unitId);
  }

  /** `RemoveGuardPosition(u)` ("ignore") / `RecycleGuardPosition(u)` — reaches the computer that
   *  owns the unit, if it runs a script. Blizzard.j's own melee start recycles the undead's
   *  Ghoul for every computer; on a race port there is nothing to tell. */
  guardPosition(unitId: number, op: "ignore" | "recycle"): void {
    const u = this.host.world.units.get(unitId);
    if (u) this.seats.find((s) => s.player === u.owner)?.guardPosition(unitId, op);
  }

  /** `RemoveAllGuardPositions(p)`. */
  ignoreAllGuardPositions(player: number): void {
    this.seats.find((s) => s.player === player)?.guards.ignoreAll();
  }

  setPaused(player: number, pause: boolean): void {
    if (pause) this.paused.add(player);
    else this.paused.delete(player);
  }

  reset(): void {
    this.seats.length = 0;
  }

  tick(dt: number): void {
    for (const s of this.seats) if (!this.paused.has(s.player)) s.tick(dt);
  }
}
