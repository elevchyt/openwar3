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
// written in the World Editor's AI Editor. Those are not ported; they are RUN.
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

/**
 * The attack captain — the engine half of common.ai's `Captain*` / `AddAssault` natives.
 *
 * Membership is accumulated by `AddAssault` (FormGroup calls `InitAssault` and then one
 * `AddAssault(qty, id)` per row, every few seconds, until `CaptainIsFull`), the goal is set by
 * `AttackMoveKill` / `CaptainAttack`, and the group turns for home on its own when its hit
 * points fall — which is what `CaptainRetreating()` reports and every editor-written attack loop
 * waits on. Retreat and regroup reuse the melee port's two fractions (index.ts) so the two AIs
 * break and re-form at the same points.
 */
class ScriptCaptain {
  readonly members = new Set<number>();
  /** `InitAssault`/`AddAssault` — what the group wants, by type. */
  private desired = new Map<string, number>();
  private goal: { x: number; y: number; id: number } | null = null;
  retreating = false;
  private reissueIn = 0;
  private clock = 0;

  constructor(private readonly ai: AiPlayer, private readonly host: AiHost) {}

  private get world() {
    return this.host.world;
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
  }

  /** `AddAssault(qty, id)` — take up to `qty` finished units of this type into the group.
   *  True when the group now holds that many. */
  addAssault(qty: number, id: string): boolean {
    this.prune();
    this.desired.set(id, qty);
    let have = this.countOf(id);
    if (have >= qty) return true;
    const home = this.ai.home();
    for (const u of this.ai.army()) {
      if (have >= qty) break;
      if (u.typeId !== id || this.members.has(u.id)) continue;
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
    const home = this.ai.home();
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

  clearTargets(): void {
    this.goal = null;
  }

  goHome(): void {
    this.goal = null;
    const home = this.ai.home();
    for (const id of this.members) {
      const u = this.alive(id);
      if (u) this.move(u, home.x, home.y);
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

  tick(dt: number): void {
    this.clock += dt;
    if (this.clock < CAPTAIN_PERIOD) return;
    this.clock = 0;
    this.prune();
    if (!this.members.size) {
      this.retreating = false;
      return;
    }
    if (this.retreating) {
      // Home and healed: the group is the script's again.
      if (this.isHome() && this.readinessHp() >= REGROUP_HP_FRACTION * 100) this.retreating = false;
      return;
    }
    if (!this.goal) return;
    // SetGroupsFlee — a broken group turns for home rather than feeding itself in.
    if (this.readinessHp() < RETREAT_HP_FRACTION * 100) {
      this.retreating = true;
      this.goHome();
      return;
    }
    if (this.goal.id) {
      const t = this.world.units.get(this.goal.id);
      if (t && t.hp > 0) {
        this.goal.x = t.x;
        this.goal.y = t.y;
      }
    }
    this.reissueIn -= CAPTAIN_PERIOD;
    if (this.reissueIn <= 0) this.issue();
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

/** One computer running a script of its own. */
class ScriptSeat {
  readonly ai: AiPlayer;
  readonly interp: Interpreter;
  readonly captain: ScriptCaptain;
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
    this.captain = new ScriptCaptain(this.ai, host);
    this.ai.captainHeld = this.captain.members;
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

  /** The script's `main()` — runs at once up to its first `Sleep`, as the real client does. */
  start(): void {
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
  for (const n of [
    "SetCampaignAI", "SetMeleeAI", "SetTargetHeroes", "SetRandomPaths", "SetDefendPlayer", "SetHeroesFlee",
    "SetHeroesBuyItems", "SetWatchMegaTargets", "SetIgnoreInjured", "SetHeroesTakeItems", "SetUnitsFlee",
    "SetGroupsFlee", "SetSlowChopping", "SetCaptainChanges", "SetSmartArtillery", "SetReplacementCount",
    "SetNewHeroes", "SetAmphibious", "DisablePathing", "StopGathering", "CreateCaptains", "PurchaseZeppelin",
    "GroupTimedLife", "Unsummon", "SetStagePoint", "LoadZepWave", "TeleportCaptain", "ResetCaptainLocs",
    "CaptainVsUnits", "CaptainVsPlayer", "ShiftTownSpot", "AddGuardPost", "FillGuardPosts", "ReturnGuardPosts",
  ]) def(n, nothing);
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
  def("IgnoredUnits", () => jInt(0));
  def("MergeUnits", () => jBool(false));
  def("ConvertUnits", () => jBool(false));

  // --- the build loop (see the header): common.ai's arrays, the port's loop ----------------
  def("OneBuildLoop", (c) => {
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
    seat.spendSkillPoints(host);
    return JNULL;
  });

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
  // No second (defence) captain: the melee port answers a threatened town by turning its one
  // group around, and so do these (SetDefendPlayer is false in every editor AI anyway).
  def("AddDefenders", () => jBool(true));
  def("CaptainIsFull", () => jBool(cap.isFull()));
  def("CaptainIsEmpty", () => (cap.prune(), jBool(cap.members.size === 0)));
  def("CaptainGroupSize", () => (cap.prune(), jInt(cap.members.size)));
  def("CaptainReadiness", () => jInt(cap.readinessHp()));
  def("CaptainReadinessHP", () => jInt(cap.readinessHp()));
  def("CaptainReadinessMa", () => jInt(cap.readinessMana()));
  def("CaptainInCombat", () => jBool(cap.inCombat()));
  def("CaptainRetreating", () => jBool(cap.retreating));
  def("CaptainAtGoal", () => jBool(cap.atGoal()));
  def("CaptainIsHome", () => jBool(cap.isHome()));
  def("CaptainGoHome", () => (cap.goHome(), JNULL));
  def("ClearCaptainTargets", () => (cap.clearTargets(), JNULL));
  def("RemoveInjuries", () => (cap.removeInjuries(), JNULL));
  def("RemoveSiege", nothing);
  def("SetCaptainHome", nothing); // the town is the home (AiPlayer.home), as for the melee port
  def("CaptainAttack", (_c, a) => (cap.attack(asNum(a[0]), asNum(a[1])), JNULL));
  def("AttackMoveXY", (_c, a) => (cap.attack(asInt(a[0]), asInt(a[1])), JNULL));
  def("AttackMoveKill", (_c, a) => {
    const t = simUnit(a[0]);
    if (t && t.hp > 0) cap.attack(t.x, t.y, t.id);
    return JNULL;
  });
  def("SuicidePlayer", () => jBool(false));
  def("SuicidePlayerUnits", () => jBool(false));
  def("SuicideUnit", nothing);
  def("SuicideUnitEx", nothing);

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
