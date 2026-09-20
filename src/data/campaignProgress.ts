import type { Campaign, CampaignEntry } from "./campaigns";
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
//
// What is LOCKED is not merely dead — it is not on the screen at all (`openCampaigns` /
// `openRows` below, which is what the screen is built from). The reference lists a campaign
// and a chapter only once the profile has reached it, so the screen never names what is
// still ahead of the player.

// The BASE keys. Never read one directly — `profileKey` suffixes it with the profile in play,
// and these two are listed in that module's PROFILE_OWNED so a deleted profile takes them with it.
const STORAGE_KEY = "openwar3.campaigns";
const DIFFICULTY_KEY = "openwar3.campaignDifficulty";

/**
 * common.j's `gamedifficulty` rungs, by name — MAP_DIFFICULTY_EASY / NORMAL / HARD.
 *
 * All three are real: a chapter runs at any of them and `GetGameDifficulty` answers with any
 * of them. Only two are ever OFFERED — see `DIFFICULTIES` in ui/fdfCampaign.ts. Easy is
 * reached exclusively by losing and taking the defeat dialog's Reduce Difficulty
 * (`CustomDefeatReduceDifficultyBJ`), which is why the name stays here while the campaign
 * screens no longer list it.
 */
export type Difficulty = "easy" | "normal" | "hard";

/** What may be REMEMBERED as the player's choice: the rungs the screens offer. A profile that
 *  stored "easy" before the menu was corrected — or by hand — reads back as Normal, the
 *  game's own default, rather than as a row that is no longer on the menu. */
const OFFERED: Difficulty[] = ["normal", "hard"];

/** The difficulty the player last chose — remembered between visits, as the reference
 *  remembers it per profile. WC3's own default is Normal. */
export function loadDifficulty(): Difficulty {
  try {
    const raw = localStorage.getItem(profileKey(DIFFICULTY_KEY)) as Difficulty | null;
    return raw && OFFERED.includes(raw) ? raw : "normal";
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

/**
 * The campaigns this profile may SEE, in list order, each with its index into `campaigns`.
 *
 * A campaign it has not opened yet is not drawn at all — not a greyed row, not a placeholder —
 * which is what the reference does: a fresh Frozen Throne profile's campaign screen lists the
 * Sentinels and the Bonus campaign and nothing else, and Curse of the Blood Elves APPEARS when
 * Terror of the Tides is finished. (A locked row that named the campaign would also spoil the
 * one thing the screen is holding back.)
 */
export function openCampaigns(campaigns: Campaign[], p = loadProgress()): Array<{ campaign: Campaign; index: number }> {
  return campaigns
    .map((campaign, index) => ({ campaign, index }))
    .filter(({ index }) => isCampaignOpen(campaigns, index, p));
}

/** One row of a chapter list: the entry, and — for a chapter — which of `campaign.missions`
 *  it is. A cinematic is not a chapter and carries `-1`. */
export interface CampaignRow {
  entry: CampaignEntry;
  /** Index into `campaign.missions`, or -1 for one of the campaign's three cinematics. */
  mission: number;
}

/**
 * The rows of `c`'s chapter list this profile may SEE, top to bottom — `campaignRows` order,
 * minus everything it has not reached.
 *
 * The list GROWS as the campaign is played, exactly as the reference's does: chapter N+1 is not
 * listed until chapter N is finished, so the screen never names a chapter ahead of the player.
 * The campaign's own cinematics are not chapters and are not gated the same way (see
 * `isCampaignOpen`'s note): the Intro and Open ones bracket the campaign from the front and are
 * there from the first visit, and the End one is the campaign's last word — it appears with the
 * last chapter done, and not before.
 */
export function openRows(c: Campaign, p = loadProgress()): CampaignRow[] {
  const done = completed(c, p);
  const out: CampaignRow[] = [];
  for (const cinematic of [c.intro, c.open]) if (cinematic) out.push({ entry: cinematic, mission: -1 });
  c.missions.forEach((entry, mission) => { if (isMissionOpen(c, mission, p)) out.push({ entry, mission }); });
  if (c.end && done >= c.missions.length) out.push({ entry: c.end, mission: -1 });
  return out;
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
