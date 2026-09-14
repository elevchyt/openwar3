import { MELEE_INSANE, MELEE_NEWBIE, MELEE_NORMAL } from "../../ids";

// Computer+ on WarChasers — what a difficulty means for a PARTY MEMBER.
//
// A computer here plays none of the game's strategy: the leader decides where the party goes. What
// separates a weak party member from a good one is how fast it reacts, how well it chooses what to
// hit, and whether it knows when to stop and heal — so those are the numbers. Its SPELLS are the
// melee Computer+ caster's (plus/casting.ts) with that rung's own profile, which already grades the
// reaction delay, the read of a fight and the misclicks.
//
// The standing rule from plus/profile.ts holds: **no rung cheats**, and none of these numbers are
// Warcraft III's — every one is OURS.

export interface WarChasersProfile {
  readonly difficulty: number;
  /** Seconds between decision passes — how often it LOOKS. */
  readonly think: number;
  /** Life fraction it stops to heal at (on its own — an order from the party overrides it). */
  readonly restHp: number;
  /** Life fraction it is ready to go on at. */
  readonly readyHp: number;
  /** Mana fraction a caster stops for (0 = never stops for mana). */
  readonly restMana: number;
  /** Does it pick its target — the leader's, whatever is hitting the party, the wounded — rather
   *  than whatever is nearest? */
  readonly focus: boolean;
  /** How long a PLAYER sees a monster before swinging: the first beat of a fight. */
  readonly react: number;
}

/** Easy — follows, fights what is closest, stops to heal late and gets up early. */
export const WC_EASY: WarChasersProfile = {
  difficulty: MELEE_NEWBIE, think: 1.0, restHp: 0.22, readyHp: 0.6, restMana: 0, focus: false, react: 1.2,
};

/** Normal — focuses with the leader, rests at a third, keeps a caster's mana for the fight. */
export const WC_NORMAL: WarChasersProfile = {
  difficulty: MELEE_NORMAL, think: 0.5, restHp: 0.33, readyHp: 0.8, restMana: 0.15, focus: true, react: 0.5,
};

/** Insane — reacts at once, rests before it is in danger rather than after, gets up full. */
export const WC_INSANE: WarChasersProfile = {
  difficulty: MELEE_INSANE, think: 0.25, restHp: 0.4, readyHp: 0.9, restMana: 0.2, focus: true, react: 0.1,
};

/** The profile a lobby difficulty seats — anything unrecognised plays Normal. */
export function warChasersProfile(difficulty: number): WarChasersProfile {
  return difficulty === MELEE_NEWBIE ? WC_EASY : difficulty === MELEE_INSANE ? WC_INSANE : WC_NORMAL;
}
