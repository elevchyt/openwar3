import type { AiPlayer } from "./aiPlayer";

/**
 * One race's melee AI script — the shape `human.ai`, `orc.ai`, `elf.ai` and `undead.ai` all
 * have, because `main()` is the same five lines in every one of them:
 *
 *     call PickMeleeHero(RACE_x)
 *     call set_skills()
 *     call StandardAI(function SkillArrays, function peon_assignment, function attack_sequence)
 *     call StartThread(function set_vars)
 *     call PlayGame()
 *
 * so the only things a race actually supplies are its hero pool, its skill arrays, its
 * build order, its harvest split and its attack conditions. Those are the members here.
 *
 * `set_vars` has no member: it exists in the original to cache a hundred `c_*` globals off
 * `GetUnitCount` once a second, and the same job is done by `AiPlayer.refresh()` invalidating
 * a lazily-built census. The counts a script reads are therefore live rather than up to a
 * second stale, which is the one place these ports are deliberately not the original — the
 * staleness was a cost of the JASS VM, not a behaviour.
 */
export interface MeleeScript {
  /** `PickMeleeHero`'s pool for this race, in the file's own order (heroes[1..4]). */
  readonly heroes: readonly string[];
  /** `set_skills` — every `SetSkillArray(slot, hero)` call, in order. */
  setSkills(ai: AiPlayer): void;
  /**
   * The part of `init_vars` that is NOT a count — the per-player state a script keeps between
   * passes, refreshed once a pass exactly as the original's `set_vars` thread refreshes it
   * once a second.
   *
   * Two of the four races have one and both matter: undead.ai's `set WG = Max(0, c_ghoul_done
   * - AG)` is what puts ghouls in the FOREST (without it an undead computer never chops a log,
   * because `HarvestWood(0, WG)` is asking for zero), and elf.ai's `archer_opening` latch is
   * what turns its opening from archers to huntresses. Absent for the other two.
   */
  initVars?(ai: AiPlayer): void;
  /** `setup_force` — the `SetMeleeGroup` list that says what a wave is made of. */
  setupForce(ai: AiPlayer): void;
  /** `force_level` — how strong this army counts as, which picks the creep camps it dares. */
  forceLevel(ai: AiPlayer): number;
  /** The `loop exitwhen …` at the head of `attack_sequence`: when the first wave may form. */
  firstWaveReady(ai: AiPlayer): boolean;
  /** `attack_sequence`'s four booleans, recomputed before each wave. */
  attackFlags(ai: AiPlayer): { needsExp: boolean; hasSiege: boolean; airUnits: boolean; allowAirCreeps: boolean };
  /** `init_vars`' `basic_opening` latch — when the opening build order gives way. */
  openingDone(ai: AiPlayer): boolean;
  /** `build_sequence` — fills the build array. */
  buildSequence(ai: AiPlayer): void;
  /** `peon_assignment`'s harvest half — `ClearHarvestAI` and the `Harvest*` split. */
  peonAssignment(ai: AiPlayer): void;
  /** The extra per-wave gate two of the four scripts carry between `CaptainRetreating()` and
   *  `setup_force()`: undead.ai splits its ghouls into attackers and lumberjacks and waits
   *  for four of them, elf.ai holds its SECOND wave until it has four archers. Absent means
   *  the wave may form as soon as the captain is home. */
  waveGate?(ai: AiPlayer): boolean;
  /** What the script does once `SingleMeleeAttack` has returned — undead.ai puts its ghouls
   *  back in the forest (`set AG = 0`). */
  afterWave?(ai: AiPlayer): void;
}
