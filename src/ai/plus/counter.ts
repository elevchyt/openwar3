import { DAMAGE_TABLE } from "../../data/gameplayConstants";
import { ArmorType, AttackType, MoveType } from "../../data/enums";
import type { UnitDef } from "../../data/units";
import type { SimUnit } from "../../sim/world";

// Computer+ — countering what the enemy is actually building (issue #124 follow-up).
//
// Warcraft III's rock-paper-scissors is not a metaphor: it is a TABLE, `Units\MiscGame.txt`'s
// `DamageBonus*` lists, and it decides most of a melee game. Piercing does 2.00 against Light
// and 0.35 against Fortified; Magic does 2.00 against Heavy and 0.35 against Fortified; Siege
// does 1.50 against Fortified and 0.50 against Medium. (Liquipedia's "Armor and Attack types"
// page and classic.battle.net's own armorandweapontypes.shtml are the community renderings of
// exactly these numbers — Small/Large are the Editor's "Light"/"Heavy".)
//
// So this file does NOT contain a counter table. It reads the game's own
// (`DAMAGE_TABLE[attack][armor]`, computed from the raw lists in gameplayConstants.ts), which
// means a data reload or a custom map that re-tunes the matrix moves the AI with it, and a
// hand-typed counter chart can never drift from what the damage actually does.
//
// Two rules from the brief shape the rest:
//
//  1. **It only counters what it has SEEN.** Computer+ never bypasses the fog, so the input is
//     a MEMORY of scouted units — the enemy army as this player last observed it — not a census
//     of the enemy's units. An opponent who is never scouted is never countered.
//  2. **A couple of units is noise; a third of an army is a fact.** A share below the
//     difficulty's threshold is dropped from the read entirely, so the AI does not re-tool its
//     whole build because it saw one Gryphon.
//
// Difficulty decides how much of this happens at all — see `PlusProfile.counterWeight`: Easy
// does not counter, Normal does it weakly and off a bigger sample, Insane does it in full.

/** What the enemy army looks like, as far as this player has seen it. Shares sum to ≤ 1. */
export interface EnemyRead {
  /** How many distinct enemy fighters the memory holds — the SAMPLE SIZE. Nothing is
   *  countered until this is over the difficulty's floor. */
  seen: number;
  /** The share of them that flies. */
  air: number;
  /** Share by armour type, thresholded (see the file header). */
  armor: Readonly<Partial<Record<ArmorType, number>>>;
}

const EMPTY_READ: EnemyRead = { seen: 0, air: 0, armor: {} };

/**
 * What this player has seen of the enemy, and when.
 *
 * Keyed by unit id so the same Grunt walking past the same tower for a minute is one sighting,
 * not sixty; timestamped so the read is of the CURRENT army rather than of everything that has
 * ever existed. A unit that died is forgotten when its sighting ages out, which is the right
 * behaviour for the same reason: an army you killed is not an army you have to counter.
 */
export class EnemyMemory {
  private readonly seen = new Map<number, { typeId: string; at: number }>();

  /** Record a sighting. Called for every hostile unit currently under this player's own eyes. */
  note(u: SimUnit, now: number): void {
    this.seen.set(u.id, { typeId: u.typeId, at: now });
  }

  /** Drop everything older than the window — called once per pass so the map cannot grow. */
  forget(now: number, window: number): void {
    for (const [id, s] of this.seen) if (now - s.at > window) this.seen.delete(id);
  }

  /**
   * The army as read off the memory.
   *
   * `minShare` is the noise floor: an armour type (or the air share) under it is dropped, so
   * the AI reacts to a COMPOSITION rather than to a sighting. Buildings and workers are left
   * out — neither is what an army has to be built against.
   */
  read(minShare: number, defOf: (typeId: string) => UnitDef | undefined): EnemyRead {
    const armor = new Map<ArmorType, number>();
    let total = 0;
    let air = 0;
    for (const s of this.seen.values()) {
      const def = defOf(s.typeId);
      if (!def || def.isBuilding || def.classification.includes("peon")) continue;
      total++;
      if (def.moveType === MoveType.Fly) air++; // `movetp` fly — the same test the sim flies on
      armor.set(def.armorType, (armor.get(def.armorType) ?? 0) + 1);
    }
    if (total === 0) return EMPTY_READ;
    const shares: Partial<Record<ArmorType, number>> = {};
    for (const [type, n] of armor) {
      const share = n / total;
      if (share >= minShare) shares[type] = share;
    }
    const airShare = air / total;
    return { seen: total, air: airShare >= minShare ? airShare : 0, armor: shares };
  }
}

/**
 * How well this unit answers what has been seen — 1.0 is "no better or worse than average".
 *
 * Two independent factors, multiplied:
 *
 *  · **the damage table.** The unit's own attack type is looked up against each armour type in
 *    the read, weighted by that armour's share. A Rifleman (Piercing) against an army that is
 *    two-thirds Light scores well above 1; the same Rifleman against Fortified scores far below
 *    it. Normalised against `NEUTRAL` so the number means "relative to a plain trade".
 *  · **whether it can reach them at all.** Against an air-heavy army a unit whose weapon has no
 *    `air` in its Targets Allowed is worth almost nothing however good its attack type is, and
 *    one that can shoot up is worth a premium. This is the half that turns "the enemy went
 *    Gryphons" into "build Dragonhawks", and no damage multiplier expresses it.
 *
 * A caster with no weapon is left at 1.0 rather than scored: what a Sorceress is worth against
 * an army is her spells, and the damage table says nothing about those.
 */
export function counterScore(def: UnitDef, read: EnemyRead): number {
  if (read.seen === 0) return 1;
  let score = 1;

  const attack = def.attackType;
  if (attack !== AttackType.None) {
    let weighted = 0;
    let covered = 0;
    for (const [type, share] of Object.entries(read.armor) as Array<[ArmorType, number]>) {
      const row = DAMAGE_TABLE[attack];
      const mult = row?.[type];
      if (mult === undefined) continue;
      weighted += mult * share;
      covered += share;
    }
    // Only the share the table actually spoke about is scored; the rest stays neutral.
    if (covered > 0) score *= (weighted + (1 - covered) * NEUTRAL) / NEUTRAL;
  }

  if (read.air >= AIR_HEAVY) {
    const hitsAir = def.weapons.some((w) => w.enabled && w.targets.includes("air"));
    score *= hitsAir ? AIR_BONUS : AIR_PENALTY;
  }
  return score;
}

/** The multiplier a "plain" trade is worth — Normal into Medium, the middle of the table.
 *  Scores are stated relative to it so a 1.5 reads as "half again as good as an even fight". */
const NEUTRAL = 1;

/** The share of an enemy army that has to fly before being unable to shoot up is disqualifying
 *  rather than merely awkward. A third: below that a ground army still decides the fight.
 *
 *  Exported because it is also the bar the PLAN reads — `plan.ts`'s `antiAir`, the row that puts
 *  up a Workshop for a build that never asked for one. The re-weighting and the transition are
 *  answers to the same observation and must not be able to disagree about when it has been made. */
export const AIR_HEAVY = 1 / 3;
/** …and what it is worth to be able to, or not. The penalty is deliberately harsher than the
 *  bonus: a unit that cannot fight back at all is not a bad trade, it is no trade. */
const AIR_BONUS = 1.6;
const AIR_PENALTY = 0.25;
