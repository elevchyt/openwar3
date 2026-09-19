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
 * The list is anchored by its TOP and grows DOWNWARD, and that is a correction to RoC's own
 * chain rather than a copy of it. `CampaignMenu.fdf` anchors its bottom-most `MissionNFrame`
 * above the Back button and hangs every other row off the one below — which is exactly right
 * for a list that is always fourteen rows long, and wrong for ours: since the unreached rows
 * stopped being drawn (data/campaignProgress.ts), a bottom-anchored list SLID DOWN the screen
 * as it got shorter, so a fresh profile's two campaigns sat in the bottom corner and every
 * chapter finished pushed the list back up. Anchoring the FIRST row instead pins the list where
 * the reference's full one starts and lets it grow towards the Back button, which is the
 * direction it fills in.
 *
 * `LIST_TOP` is that first row's top, measured UP from the Back button's own top edge — the
 * frame the rows already take their 0.03 indent from, so the whole list stays tied to the one
 * anchor the file gives this column. Both lists start there: the campaign list and the chapter
 * list are the same column in the same place, and a list that moved when you stepped into a
 * campaign would read as the screen jumping.
 *
 * The number is where the LONGEST list already started — Legacy of the Damned's fifteen rows,
 * measured on the running screen at 1600x900 (row one's top 68 px down, the Back button's top
 * at 825; 757 px over a 900 px screen that is 0.6 units tall). So the list that decides whether
 * this column fits at all has not moved an inch: every shorter one now starts where it does
 * instead of hanging off the bottom.
 */
const LIST_TOP = 0.5047;
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

/** The difficulty menu, as CustomCampaignMenu.fdf declares it: EASY / NORMAL / HARD, in that
 *  order, as GlobalStrings keys. Exported because that screen is real too (ui/fdfCustomCampaign.ts)
 *  and it is the same three rows out of the same file. */
export const DIFFICULTIES: Array<{ value: Difficulty; key: string }> = [
  { value: "easy", key: "EASY" },
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
 * One row per entry, stacked TOP-DOWN: the FIRST row is anchored `LIST_TOP` above the Back
 * button and every row below is anchored to the row above it. Chaining (rather than computing
 * a y per row) is what keeps the spacing right — a row's height is its text's, and only a
 * chain knows it without measuring — and it is the same chain RoC's CampaignMenu.fdf builds,
 * read from the other end (see LIST_TOP for why that end).
 */
function buildRows(
  lib: FdfLibrary,
  entries: Array<{ header: string; name: string; camera: boolean }>,
  pitch: number,
  headerFont: number,
  nameFont: number,
): FdfFrame[] {
  const out: FdfFrame[] = [];
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
      ? [arg("TOPLEFT"), str("BackButton"), arg("TOPLEFT"), num(ROW_INDENT), num(LIST_TOP)]
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
