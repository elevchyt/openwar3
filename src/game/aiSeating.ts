import { AI_SCRIPT_RACES } from "../ai";
import type { PlayableRace } from "../data/races";

// WHICH AI a computer seat gets — the decision `RtsController.startMeleeAIFor` acts on, kept here
// as two pure functions so it can be pinned headlessly (tools/ai-seating-test.cjs) without the
// controller, which needs a renderer to construct.
//
// Three AIs can sit behind a computer (docs/melee-ai.md, docs/computer-plus.md):
//   • a SCRIPT — any file that is not one of the four race files: a map's own `.ai`
//     ((4)Monolith's creeps) or a campaign chapter's (`h02_red.ai`), RUN by src/ai/scriptAi.ts;
//   • Blizzard's MELEE AI — the four race files, ported (src/ai/);
//   • COMPUTER+ — ours, a melee player end to end, chosen per seat in the lobby's Advanced Options.
//
// Computer+ is refused in two places, and each refusal hands the seat Blizzard's own AI: on a
// CUSTOM map (w3i melee flag clear — it has no melee shape to play), and in a CAMPAIGN chapter,
// always, whatever the map's flag says. A chapter's computers are the mission's.

/** One computer seat as the lobby arms it. */
export interface AiSeat {
  player: number;
  race: PlayableRace;
  startX: number;
  startY: number;
  difficulty: number;
  /** The Advanced Options switch — this seat asked for Computer+. */
  plus?: boolean;
}

/** What kind of match the seat is in. */
export interface AiMatch {
  /** The w3i melee flag. */
  melee: boolean;
  /** A campaign chapter (`MeleeConfig.campaign`). */
  campaign: boolean;
}

export type AiPick =
  /** The named file is a map's or a chapter's own script: run it. */
  | { ai: "script" }
  /** Blizzard's melee AI for `race`; `plusRefused` says why a Computer+ seat did not get it. */
  | { ai: "melee"; race: PlayableRace; plusRefused: "custom" | "campaign" | null }
  /** Computer+ for `race`. */
  | { ai: "plus"; race: PlayableRace };

/**
 * The lobby's computer seats as a match ARMS them (`RtsController.prepareMeleeAI`). In a campaign
 * chapter every seat's Computer+ flag is cleared before anything reads it — a chapter's config
 * sets none today (main.ts `campaignConfig`), and this keeps it so whatever a preference, a LAN
 * lobby or a dev boot later puts on a slot.
 */
export function armAiSeats<T extends AiSeat>(slots: readonly T[], campaign: boolean): T[] {
  return campaign ? slots.map((s) => (s.plus ? { ...s, plus: false } : s)) : [...slots];
}

/**
 * `StartMeleeAI(p, script)` / `StartCampaignAI(p, script)` — which AI this seat gets.
 *
 * The file is named by its BASENAME for the four race files (`Scripts\human.ai` and `human.ai`
 * are the same AI); any other name is a script of the map's or the chapter's own and is run,
 * never replaced by a race AI. A race file goes to Computer+ only for a seat that asked for it, on
 * a melee map, outside a campaign — checked again here rather than trusted to `armAiSeats`, so the
 * rule does not live in one caller.
 */
export function pickAi(script: string, seat: AiSeat, match: AiMatch): AiPick {
  const file = script.toLowerCase().split(/[\\/]/).pop() ?? "";
  const race = AI_SCRIPT_RACES[file];
  if (!race) return { ai: "script" };
  if (!seat.plus) return { ai: "melee", race, plusRefused: null };
  if (match.campaign) return { ai: "melee", race, plusRefused: "campaign" };
  if (!match.melee) return { ai: "melee", race, plusRefused: "custom" };
  return { ai: "plus", race };
}
