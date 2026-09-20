import type { DataSource } from "../vfs/types";
import type { Campaign } from "../data/campaigns";
import {
  completed, loadProgress, openCampaigns, openRows,
  type CampaignRow, type Difficulty,
} from "../data/campaignProgress";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { arg, num, setProp, str } from "./mapBrowser";

// The Campaign screen (issue #101), built from the game's own UI\FrameDef\Glue\CampaignMenu.fdf.
//
// It is the one glue screen with no panel chrome: the campaign's 3D backdrop fills the frame
// (render/menuScene.ts owns that half), and this file is the text and the buttons that sit on
// it — the campaign/chapter list on the right, the difficulty box bottom-left, the WarCraft III
// logo peeking off the top-right corner, and Back.
//
// TWO SCREENS IN ONE FILE, as the reference has it: pick a campaign, then pick a chapter of it.
// The file itself says so — `CampaignSelectFrame` and `MissionSelectFrame` are siblings, and
// WC3's glue script shows one or the other.
//
// WHERE THE ROWS COME FROM. TFT's CampaignMenu.fdf declares no rows at all: it dropped RoC's
// fourteen hand-authored `MissionNFrame`s in favour of a runtime list (UI\FrameDef\Glue\
// CampaignListBox.fdf, whose entire contents are a scrollbar), because a custom campaign may
// carry up to 128 missions — "putting more than 15 will make a scrollbar appear to see the
// rest" (UI\CampaignStrings_exp.txt). None of the four stock TFT campaigns reaches 15 (Legacy
// of the Damned is the longest at 14 chapters + 1 cinematic), so nothing scrolls, and the
// geometry we build the rows with is RoC's own, out of the same file one edition earlier:
// each row is a small header line, the mission's name in grey under it, and a
// `CampaignArrowButtonTemplate` hanging off its left, the stack anchored above the Back
// button and growing upwards. Every template used here is the game's.
//
// The four TFT campaigns are laid out top-to-bottom in `CampaignList` order (NightElf, Human,
// Undead, Orc) — the index calls that order "significant, as that is the order in which they
// will appear on the campaign selection screen" — and RoC's frame chain confirms which end is
// which: its bottom-most row is the LAST campaign of its list, each next one anchored above.

/**
 * The list is CENTRED on the screen and grows both ways, and that is a correction to RoC's own
 * chain rather than a copy of it. `CampaignMenu.fdf` anchors its bottom-most `MissionNFrame`
 * above the Back button and hangs every other row off the one below — which is exactly right
 * for a list that is always fourteen rows long, and wrong for ours: since the unreached rows
 * stopped being drawn (data/campaignProgress.ts) the list's LENGTH is what changes as a profile
 * plays, and an end-anchored list walks up or down the screen as it does. Pinning its MIDDLE is
 * the only anchor that stands still: a fresh profile's two campaigns and the Scourge's fifteen
 * chapters are the same column, centred the same way, and the rows the next chapter adds arrive
 * half above and half below rather than shunting the lot.
 *
 * `LIST_CENTRE` is that middle, measured UP from the Back button's own top edge — the frame the
 * rows already take their indent from, so the whole column stays tied to the one anchor the file
 * gives it. The Back button's top is 0.05 over the bottom of a screen 0.6 tall
 * (`SetPoint TOPRIGHT, "CampaignMenu", BOTTOMRIGHT, -0.04, 0.05`), so the screen's own middle is
 * 0.3 − 0.05 above it.
 *
 * The first row is then `LIST_CENTRE + listSpan()/2` (see there: the span is arithmetic, not a
 * measurement), and everything below chains off it as before.
 */
const LIST_CENTRE = 0.25;
/** The left indent both lists take off the Back button (RoC's own -0.03). */
const ROW_INDENT = -0.03;
/** Row to row: the gap between one row's header line and the next one's, RoC's own 0.023 for
 *  chapters… */
const MISSION_PITCH = 0.023;
/** …and 0.05 for the campaign rows, which are the same shape but stand further apart because
 *  each carries a campaign title rather than a chapter number. */
const CAMPAIGN_PITCH = 0.05;
/** The row's arrow button, hung off the label's left edge. */
const ARROW_DX = -0.004;
const ARROW_DY = 0.005;
/** The grey the FDF paints a row's second line (`FontColor 0.764 0.764 0.764 1.0`). */
const DESC_GREY = 0.764;
/**
 * A row's two lines, one size down from the templates they inherit (`StandardSmallTextTemplate`
 * 0.011 over the header, `StandardTitleTextTemplate` 0.015 over the name). Set here rather than
 * left to the templates because the LIST has to fit: a row is as tall as its own type — the
 * chain that stacks them adds `pitch` to the height each line asks for — so the type size is
 * what decides whether a campaign fits the screen. Legacy of the Damned is the one that settles
 * it, at 14 chapters plus 2 cinematics; at the templates' own sizes its top three rows ran off
 * the top edge and behind the corner logo.
 *
 * The reference never faces this: it has a scrollbar (`CampaignListBox.fdf`), and the file says
 * when it appears — "putting more than 15 will make a scrollbar appear to see the rest"
 * (UI\CampaignStrings_exp.txt). Until that list box is real, the type is what makes room.
 */
const ROW_HEADER_FONT = 0.0095;
const ROW_NAME_FONT = 0.0125;
/** The campaign list is four rows and never crowds, so it only comes down a hair. */
const CAMPAIGN_HEADER_FONT = 0.0105;
const CAMPAIGN_NAME_FONT = 0.0135;

/**
 * Drawn by the scene behind the DOM rather than here (the backdrop and the doors between two
 * of them) — plus `WarCraftIIILogo`, which is suppressed rather than delegated.
 *
 * **The logo is deliberately off.** TFT's campaign screen does wear it (the corner sprite the
 * engine hands `war3skins.txt`'s `CampaignLogo`, and on an expansion install the Frozen Throne
 * art at `MainMenuLogo_V1`); it is hidden here by request, and it is the one thing on this
 * screen that overlaps the chapter list on a long campaign. docs/campaigns.md keeps what it
 * takes to bring it back — the art it resolves to, the size, and the anchor correction a flat
 * texture needs where the file positions a MODEL.
 */
const SCENE_SPRITES = ["CampaignBackdrop", "SlidingDoors", "WarCraftIIILogo"];

export type { Difficulty };

/**
 * The difficulty menu, as GlobalStrings keys: **NORMAL / HARD**, in that order. Exported
 * because the Custom Campaign screen is real too (ui/fdfCustomCampaign.ts) and it is the same
 * two rows out of the same file.
 *
 * **EASY is not on it**, in either game. `GlobalStrings.fdf` does carry the string and
 * common.j does carry the constant (`MAP_DIFFICULTY_EASY` 0), but nothing on the campaign
 * screens ever picks it — the only way into Easy is **losing**. Blizzard.j says so in as many
 * words: `CustomDefeatDialogBJ` offers "Reduce |CFFFFFFFFD|Rifficulty" only
 * `if (GetGameDifficulty() != MAP_DIFFICULTY_EASY)`, and `CustomDefeatReduceDifficultyBJ`
 * steps HARD→NORMAL→EASY and then stops ("Sorry, but it doesn't get any easier than this").
 * A rung you can only fall to is not a rung you can start on, so offering it here handed the
 * player a difficulty the reference client has no way to select.
 */
export const DIFFICULTIES: Array<{ value: Difficulty; key: string }> = [
  { value: "normal", key: "NORMAL" },
  { value: "hard", key: "HARD" },
];

export interface CampaignHandlers {
  /** A campaign row was clicked: show its chapters (and swap the screen's backdrop to it). */
  onSelectCampaign(campaign: Campaign): void;
  /** A chapter was clicked — its index into `campaign.missions`. */
  onPlayMission(campaign: Campaign, index: number): void;
  /** Back: to the chapter list's campaign list, or off the screen entirely. */
  onBack(): void;
  /** The player changed the difficulty (persisted by the caller). */
  onDifficulty(difficulty: Difficulty): void;
}

export interface CampaignScreenState {
  /** Which campaign the screen is showing — its backdrop is up whichever mode we are in. */
  campaign: Campaign;
  /** false = the campaign list, true = that campaign's chapters. */
  chapters: boolean;
  difficulty: Difficulty;
}

/** Mount the Campaign screen over `campaigns`, showing `state`. */
export function mountCampaignScreen(
  container: HTMLElement,
  vfs: DataSource,
  campaigns: Campaign[],
  state: CampaignScreenState,
  h: CampaignHandlers,
): Promise<FdfScreen> {
  const progress = loadProgress();
  // Only what this profile has OPENED is built: a locked campaign and an unreached chapter are
  // not rows at all (data/campaignProgress.ts). Both lists are therefore indexed by where a row
  // sits ON SCREEN, and each row carries what it stands for.
  const rows = state.chapters ? openRows(state.campaign, progress) : [];
  const shown = state.chapters ? [] : openCampaigns(campaigns, progress);
  // Captured from buildRoot so the difficulty labels resolve through GlobalStrings, exactly
  // as the Options screen resolves LOW/MEDIUM/HIGH (ui/fdfOptions.ts).
  let lib: FdfLibrary | null = null;

  return mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\CampaignMenu.fdf",
    rootFrame: "CampaignMenu",
    // The campaign backdrop is a 3D model in the scene behind us, and the sliding doors are
    // the transition between two of them — neither is a texture this screen can draw.
    hidden: SCENE_SPRITES,
    // The bottom-centre pair names the campaign whose chapters are on screen, and it has to be
    // handed over HERE rather than written in afterwards. Both frames declare no Width — the
    // engine auto-sizes a TEXT frame to its string — so the layout measures whatever text it
    // can see, and what the FDF gives it is `EMPTY_STRING`. Filled in after the build, the
    // campaign's name landed in a box measured for nothing and came out a column of single
    // letters. On the campaign list there is nothing selected yet and the file's own empty
    // string stands, exactly as the reference has it.
    textOverrides: state.chapters
      ? { MissionNameHeader: state.campaign.header, MissionName: state.campaign.name }
      : {},
    buildRoot: (l) => { lib = l; return buildCampaignRoot(l, state, rows, shown); },
    // One panel: the whole screen fades as one, because there is no chrome to fade it
    // against — every other glue screen's panels are carried by the 3D chain panels.
    panels: ["MissionSelectFrame", "CampaignSelectFrame", "BackButton"],
    handlers: rowHandlers(state, rows, shown, h),
    onBuild: (s) => fill(s),
  });

  function fill(s: FdfScreen): void {
    const difficulty = s.popup("DifficultySelect");
    if (difficulty) {
      difficulty.setOptions(DIFFICULTIES.map((d) => ({ value: d.value, label: lib?.string(d.key) ?? d.key })));
      difficulty.value = state.difficulty;
      difficulty.onChange = (v) => { state.difficulty = v as Difficulty; h.onDifficulty(state.difficulty); };
    }

    // Everything on screen is open — what is not is not drawn. The one dead row left is a
    // cinematic: it is listed (the reference lists it) and there is nothing to play, because
    // the movies are AVIs this engine does not decode yet (docs/campaigns.md).
    if (state.chapters) {
      rows.forEach((row, i) => {
        s.setEnabled(rowButton(i), row.entry.playable);
        if (row.entry.playable) wireRowText(s, i);
      });
    } else {
      shown.forEach((_, i) => wireRowText(s, i));
    }
  }
}

/**
 * A row is ONE target: its two lines of text answer the click exactly as the arrow beside them
 * does (by pressing that button, so its disabled/mid-transition gates and its click sound
 * still apply), and hovering any part of it lights the arrow and turns both lines white.
 * Wired per build — `relayout` replaces every element, listeners and all.
 */
function wireRowText(s: FdfScreen, i: number): void {
  const button = s.frame(rowButton(i));
  if (!button) return;
  const parts = [button, s.frame(rowLabel(i)), s.frame(rowDesc(i))].filter((e): e is HTMLElement => !!e);
  const hot = (on: boolean): void => {
    const live = on && !button.classList.contains("fdf-disabled") && !button.closest(".fdf-screen-disabled, .fdf-screen-inert");
    for (const el of parts) el.classList.toggle("campaign-row-hot", live);
  };
  for (const el of parts) {
    el.addEventListener("mouseenter", () => hot(true));
    el.addEventListener("mouseleave", () => hot(false));
    if (el === button) continue;
    el.classList.add("campaign-row-text");
    el.addEventListener("click", () => button.click());
  }
}

/** frameName → click handler for every row on screen. A row's index is its place in the list
 *  as BUILT, and the row itself says what it stands for — a cinematic names no chapter, and a
 *  campaign row's index into `campaigns` is not where it sits once locked ones are dropped. */
function rowHandlers(
  state: CampaignScreenState,
  rows: CampaignRow[],
  shown: Array<{ campaign: Campaign }>,
  h: CampaignHandlers,
): Record<string, () => void> {
  const out: Record<string, () => void> = { BackButton: h.onBack };
  if (state.chapters) {
    rows.forEach((row, i) => {
      if (!row.entry.playable) return;
      out[rowButton(i)] = () => h.onPlayMission(state.campaign, row.mission);
    });
  } else {
    shown.forEach(({ campaign }, i) => {
      out[rowButton(i)] = () => h.onSelectCampaign(campaign);
    });
  }
  return out;
}

const rowButton = (i: number): string => `CampaignRow${i}Button`;
const rowLabel = (i: number): string => `CampaignRow${i}Label`;
const rowDesc = (i: number): string => `CampaignRow${i}Desc`;

// --- composing the screen out of the game's templates ------------------------------

function buildCampaignRoot(
  lib: FdfLibrary,
  state: CampaignScreenState,
  rows: CampaignRow[],
  shown: Array<{ campaign: Campaign }>,
): FdfFrame {
  const root = lib.resolveRoot("CampaignMenu");
  if (!root) throw new Error("CampaignMenu.fdf: no CampaignMenu frame");

  // The rows, into whichever of the two select frames this mode is.
  const container = state.chapters ? "MissionSelectFrame" : "CampaignSelectFrame";
  const built = state.chapters
    ? buildRows(lib, rows.map(({ entry }) => ({ header: entry.header, name: entry.name, camera: !entry.playable })),
        MISSION_PITCH, ROW_HEADER_FONT, ROW_NAME_FONT)
    : buildRows(lib, shown.map(({ campaign }) => ({ header: `${campaign.header}:`, name: campaign.name, camera: false })),
        CAMPAIGN_PITCH, CAMPAIGN_HEADER_FONT, CAMPAIGN_NAME_FONT);
  const target = findChild(root, container);
  if (target) target.children.push(...built);

  // Both select frames stay up: what the reference swaps is the ROWS inside them (RoC's glue
  // script hides `NightElfFrame`/`Mission7Frame`, never the two containers), and the logo, the
  // difficulty box and the bottom-centre title belong to the screen in either mode.
  return root;
}

/**
 * How tall a list of `n` of these rows is, from the first header line's top to the last name
 * line's bottom — and it is EXACT rather than a guess, which is what lets the list be centred
 * without measuring anything on screen.
 *
 * A one-line TEXT frame is exactly its own font size tall, with no leading: that is the engine's
 * shrink-wrap and `ui/fdf/layout.ts` proves it off OptionsMenu.fdf's two parallel chains. So a
 * row is `headerFont + nameFont` (the grey name hangs straight off the header's bottom), and the
 * step from one row's top to the next is `headerFont + pitch` — the chain's own link. Checked
 * against the running screen at 1600×900: the Scourge's fifteen chapters measure 715 px against
 * 0.477 units × 1500, and the four-campaign list 308 px against 0.2055.
 */
function listSpan(n: number, pitch: number, headerFont: number, nameFont: number): number {
  return Math.max(0, n - 1) * (headerFont + pitch) + headerFont + nameFont;
}

/**
 * One row per entry, stacked TOP-DOWN from a list CENTRED on `LIST_CENTRE`: the first row is
 * anchored half the list's height above the middle, and every row below is anchored to the row
 * above it. Chaining (rather than computing a y per row) is what keeps the spacing right — a
 * row's height is its text's, and only a chain knows it without measuring — and it is the same
 * chain RoC's CampaignMenu.fdf builds, read from the other end (see LIST_CENTRE for why).
 */
function buildRows(
  lib: FdfLibrary,
  entries: Array<{ header: string; name: string; camera: boolean }>,
  pitch: number,
  headerFont: number,
  nameFont: number,
): FdfFrame[] {
  const out: FdfFrame[] = [];
  const top = LIST_CENTRE + listSpan(entries.length, pitch, headerFont, nameFont) / 2;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const label = lib.resolveRoot("StandardSmallTextTemplate");
    const desc = lib.resolveRoot("StandardTitleTextTemplate");
    // A cinematic gets the film-camera button, a mission the arrow — both are the file's own
    // (RoC hangs a CampaignCameraButton on every mission row for exactly this).
    const button = lib.resolveRoot(entry.camera ? "CampaignCameraButtonTemplate" : "CampaignArrowButtonTemplate");
    if (!label || !desc || !button) break;

    label.name = rowLabel(i);
    setProp(label, "Text", [str(entry.header)]);
    // Same shape the FDF spells a size in — "MasterFont", size, flags (StandardTemplates.fdf).
    setProp(label, "FrameFont", [str("MasterFont"), num(headerFont), str("")]);
    // The first row off the Back button, every other off the HEADER LINE of the row above it
    // — the same link RoC's own chain makes, followed the other way, with that row's grey
    // name line hanging inside the gap. `pitch` is the same number read from either end, so
    // only its sign changes with the direction the chain runs.
    const above = i === 0
      ? [arg("TOPLEFT"), str("BackButton"), arg("TOPLEFT"), num(ROW_INDENT), num(top)]
      : [arg("TOPLEFT"), str(rowLabel(i - 1)), arg("BOTTOMLEFT"), num(0), num(-pitch)];
    setProp(label, "SetPoint", above);

    desc.name = rowDesc(i);
    setProp(desc, "Text", [str(entry.name)]);
    setProp(desc, "FrameFont", [str("MasterFont"), num(nameFont), str("")]);
    setProp(desc, "FontColor", [num(DESC_GREY), num(DESC_GREY), num(DESC_GREY), num(1)]);
    setProp(desc, "SetPoint", [arg("TOPLEFT"), str(rowLabel(i)), arg("BOTTOMLEFT"), num(0), num(0)]);

    button.name = rowButton(i);
    setProp(button, "SetPoint", [arg("TOPRIGHT"), str(rowLabel(i)), arg("TOPLEFT"), num(ARROW_DX), num(ARROW_DY)]);

    // Built top-down, each anchoring to the row above it — so list order IS build order, and
    // the DOM reads top-to-bottom like the screen does.
    out.push(label, desc, button);
  }
  return out;
}

function findChild(f: FdfFrame, name: string): FdfFrame | undefined {
  if (f.name === name) return f;
  for (const c of f.children) {
    const hit = findChild(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** How far into `campaign` the player has got — for the caller's "resume here" default. */
export function resumeIndex(c: Campaign): number {
  return Math.min(completed(c), Math.max(0, c.missions.length - 1));
}
