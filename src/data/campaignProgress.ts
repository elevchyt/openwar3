import type { Campaign } from "./campaigns";
import { profileKey } from "./profiles";

// Campaign progress (issue #101) — which campaigns are open and how far into each one the
// player has got. In Warcraft III this lives in the PROFILE (SinglePlayerMenu.fdf's profile
// half: "Each profile will hold information for your campaign progress as well as a personal
// saved games list" — GlobalStrings PROFILE_MESSAGE), and since issue #80 it does here too:
// both keys below are read and written through `profileKey`, so they land under the profile in
// play and deleting that profile takes them with it (data/profiles.ts). The store is the one
// the Options screen uses — localStorage, one JSON blob (data/options.ts).
//
// The rules are the game's own, and both come out of the campaign index itself:
//   • a campaign with `DefaultOpen=1` is "initially open and selectable by a new user"; TFT
//     opens Terror of the Tides and the Bonus campaign, and holds Curse of the Blood Elves
//     and Legacy of the Damned back;
//   • a locked campaign opens when the one before it IN LIST ORDER is finished — the order
//     the index calls "significant", i.e. the order the screen lists them in.
// Within a campaign, chapter N+1 opens when chapter N is completed; cinematics never gate
// anything (you may watch the opening one, or not, and chapter one is open either way).

// The BASE keys. Never read one directly — `profileKey` suffixes it with the profile in play,
// and these two are listed in that module's PROFILE_OWNED so a deleted profile takes them with it.
const STORAGE_KEY = "openwar3.campaigns";
const DIFFICULTY_KEY = "openwar3.campaignDifficulty";

/** The three the campaign screens offer (CustomCampaignMenu.fdf's own menu items:
 *  EASY / NORMAL / HARD). */
export type Difficulty = "easy" | "normal" | "hard";

const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"];

/** The difficulty the player last chose — remembered between visits, as the reference
 *  remembers it per profile. WC3's own default is Normal. */
export function loadDifficulty(): Difficulty {
  try {
    const raw = localStorage.getItem(profileKey(DIFFICULTY_KEY)) as Difficulty | null;
    return raw && DIFFICULTIES.includes(raw) ? raw : "normal";
  } catch {
    return "normal";
  }
}

export function saveDifficulty(d: Difficulty): void {
  try {
    localStorage.setItem(profileKey(DIFFICULTY_KEY), d);
  } catch { /* storage unavailable */ }
}

/** campaign key → how many of its ROWS (campaignRows order) the player has completed. */
type Progress = Record<string, number>;

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(profileKey(STORAGE_KEY));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Progress = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && v >= 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {}; // private mode, corrupt JSON — a fresh profile is the right answer either way
  }
}

function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(profileKey(STORAGE_KEY), JSON.stringify(p));
  } catch { /* storage unavailable — progress is lost, the menus still work */ }
}

/** Is `campaign` selectable? DefaultOpen, or the previous campaign in the list is finished. */
export function isCampaignOpen(campaigns: Campaign[], index: number, p = loadProgress()): boolean {
  const c = campaigns[index];
  if (!c) return false;
  if (c.defaultOpen) return true;
  const prev = campaigns[index - 1];
  if (!prev) return true;
  return completed(prev, p) >= prev.missions.length;
}

/** How many of a campaign's MISSIONS are done (cinematic rows don't count as progress). */
export function completed(c: Campaign, p = loadProgress()): number {
  return Math.min(p[c.key] ?? 0, c.missions.length);
}

/** Is mission `index` (an index into `campaign.missions`) playable yet? The first always is;
 *  the rest need the one before them finished. */
export function isMissionOpen(c: Campaign, index: number, p = loadProgress()): boolean {
  return index <= completed(c, p);
}

/** Record a mission as finished — everything up to and including `index` is now done. */
export function markMissionComplete(campaignKey: string, index: number): void {
  const p = loadProgress();
  p[campaignKey] = Math.max(p[campaignKey] ?? 0, index + 1);
  saveProgress(p);
}

/** Wipe all progress (the console hook behind a "new profile"). */
export function resetProgress(): void {
  saveProgress({});
}
