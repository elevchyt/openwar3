import { MELEE_INSANE, MELEE_NEWBIE, MELEE_NORMAL } from "../../ids";

// Computer+ on Azeroth Grand Prix — what a difficulty means for a RACER.
//
// A race has no strategy to grade, so a rung is how well it DRIVES and how well it uses what it
// picks up: how close to the limit it takes a corner, how late it brakes, how soon it notices a
// rival in front of its gun, and whether a power-up is saved for the moment it is worth something.
//
// The standing rule from plus/profile.ts holds: **no rung cheats** — every seat presses the same
// four arrow keys and the same buttons a person has, on the same cart physics — and none of these
// numbers are Warcraft III's. Every one is OURS.

export interface GrandPrixProfile {
  readonly difficulty: number;
  /** Seconds between looks at the road. The cart itself moves every 0.05 s. */
  readonly think: number;
  /** The share of the cart's top speed it will drive at on a straight. */
  readonly pace: number;
  /** The share of the speed a corner can physically be taken at that it dares. */
  readonly corner: number;
  /** How hard it counts on its brakes: 1 brakes at the last metre, less brakes earlier. */
  readonly braking: number;
  /** Does it hold the throttle open through the 3-2-1? The map lets anybody (index.ts `think`). */
  readonly flyingStart: boolean;
  /** Seconds between seeing a use for a power-up (or a target for the gun) and pressing it. */
  readonly react: readonly [number, number];
  /** Seconds a power-up may sit in a slot before it is pressed anyway, so the four slots are
   *  not left full of things it is saving. */
  readonly hoard: number;
  /** Life fraction a Repair Kit is spent at. */
  readonly repairAt: number;
  /** Seconds between bursts of the machine gun, and rounds in a burst. */
  readonly gunGap: number;
  readonly burst: number;
  /** How many laps it asks for when the lap dialog is its to answer (the map offers 3…6). */
  readonly laps: number;
}

/** Easy — lifts early, takes corners wide and slow, sits on its power-ups. */
export const GP_EASY: GrandPrixProfile = {
  difficulty: MELEE_NEWBIE, think: 0.2, pace: 0.8, corner: 0.7, braking: 0.5, flyingStart: false,
  react: [1.5, 3], hoard: 12, repairAt: 0.3, gunGap: 3, burst: 1, laps: 3,
};

/** Normal — a clean lap a little under the limit. */
export const GP_NORMAL: GrandPrixProfile = {
  difficulty: MELEE_NORMAL, think: 0.1, pace: 0.92, corner: 0.85, braking: 0.7, flyingStart: true,
  react: [0.5, 1.2], hoard: 20, repairAt: 0.45, gunGap: 1.5, burst: 2, laps: 3,
};

/** Insane — on the limit everywhere, and every power-up lands when it hurts. */
export const GP_INSANE: GrandPrixProfile = {
  difficulty: MELEE_INSANE, think: 0.05, pace: 1, corner: 0.97, braking: 0.9, flyingStart: true,
  react: [0.1, 0.3], hoard: 30, repairAt: 0.6, gunGap: 0.6, burst: 3, laps: 3,
};

/** The profile a lobby difficulty seats — anything unrecognised plays Normal. */
export function grandPrixProfile(difficulty: number): GrandPrixProfile {
  return difficulty === MELEE_NEWBIE ? GP_EASY : difficulty === MELEE_INSANE ? GP_INSANE : GP_NORMAL;
}
