import type { DataSource } from "../vfs/types";
import type { Campaign, CampaignEntry } from "../data/campaigns";
import { campaignRows } from "../data/campaigns";
import { completed, isCampaignOpen, isMissionOpen, loadProgress, type Difficulty } from "../data/campaignProgress";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { arg, num, setProp, size, str } from "./mapBrowser";

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

/** RoC CampaignMenu.fdf, MissionNFrame: the bottom row sits 0.04 above the Back button's top,
 *  indented 0.03 left of it, and each row above is 0.023 clear of the one below. */
const MISSION_BOTTOM = 0.04;
const MISSION_PITCH = 0.023;
/** …and the campaign rows, which are the same shape but stand further apart (0.05) and start
 *  higher (0.11), because each carries a campaign title rather than a chapter number. */
const CAMPAIGN_BOTTOM = 0.11;
const CAMPAIGN_PITCH = 0.05;
/** The row's arrow button, hung off the label's left edge. */
const ARROW_DX = -0.004;
const ARROW_DY = 0.005;
/** The grey the FDF paints a row's second line (`FontColor 0.764 0.764 0.764 1.0`). */
const DESC_GREY = 0.764;
/**
 * The corner logo. It is a SPRITE in the FDF with neither art nor size — the engine hands it
 * both — and what it hands it is a MODEL: war3skins.txt's `CampaignLogo` =
 * `UI\Glues\SinglePlayer\CampaignWarCraftIIILogo\CampaignWarCraftIIILogo.mdl`, whose own extent
 * is 0.2235 × 0.1115 in these units (a 2:1 box, matching the 512×256 texture inside it).
 *
 * **The art is the EXPANSION logo on an expansion install.** `CampaignLogo` is the one skin key
 * with no `_V1` twin, so the naming convention that resolves the campaign backdrops
 * (data/campaigns.ts) has nothing to resolve here and the RoC-era model is all the table
 * offers — its texture is the Reign of Chaos logo. The Frozen Throne art is real and shipped:
 * `MainMenuLogo_V1` → `WarCraftIIILogo_exp.mdx`, which references
 * `ReplaceableTextures\WorldEditUI\WarcraftIIIFTLogo.blp` (dumped from the model in the
 * archives). TFT's own campaign screen wears the expansion logo, so we take that texture when
 * the install has it and fall back to the RoC one when it does not.
 */
const LOGO_W = 0.2235;
const LOGO_H = 0.1115;
const LOGO_ART_TFT = "ReplaceableTextures\\WorldEditUI\\WarcraftIIIFTLogo.blp";
const LOGO_ART_ROC = "UI\\Glues\\SinglePlayer\\CampaignWarCraftIIILogo\\WarcraftIII-logo-alpha.blp";
/**
 * …and it is anchored INSIDE the corner, against the FDF's own `SetPoint TOPRIGHT … 0.08, 0.04`.
 * Those offsets belong to the MODEL: a glue model is a scene with its art somewhere inside a
 * much larger authored extent, and the file pushes that extent off the corner so the art lands
 * on it. We draw a flat texture that fills its whole box instead, so honouring the offsets
 * pushes the LOGO itself off-screen — the same substitution, one layer down, that makes a
 * sprite's size our problem in the first place. This inset puts the whole logo on screen.
 */
const LOGO_INSET = -0.012;

/** The 3D backdrop and the sliding doors are drawn by the scene behind the DOM, not here. */
const SCENE_SPRITES = ["CampaignBackdrop", "SlidingDoors"];

export type { Difficulty };

/** The difficulty menu, as CustomCampaignMenu.fdf declares it: EASY / NORMAL / HARD, in that
 *  order, as GlobalStrings keys. */
const DIFFICULTIES: Array<{ value: Difficulty; key: string }> = [
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
  const rows = state.chapters ? campaignRows(state.campaign) : [];
  const progress = loadProgress();
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
    sprites: { WarCraftIIILogo: vfs.exists(LOGO_ART_TFT) ? LOGO_ART_TFT : LOGO_ART_ROC },
    buildRoot: (l) => { lib = l; return buildCampaignRoot(l, campaigns, state, rows); },
    // One panel: the whole screen fades as one, because there is no chrome to fade it
    // against — every other glue screen's panels are carried by the 3D chain panels.
    panels: ["MissionSelectFrame", "CampaignSelectFrame", "BackButton"],
    handlers: rowHandlers(campaigns, state, rows, progress, h),
    onBuild: (s) => fill(s),
  });

  function fill(s: FdfScreen): void {
    // The bottom-centre pair names the campaign whose chapters are on screen. On the campaign
    // list there is nothing selected yet, and the FDF's own EMPTY_STRING stands.
    if (state.chapters) {
      s.setText("MissionNameHeader", state.campaign.header);
      s.setText("MissionName", state.campaign.name);
    }

    const difficulty = s.popup("DifficultySelect");
    if (difficulty) {
      difficulty.setOptions(DIFFICULTIES.map((d) => ({ value: d.value, label: lib?.string(d.key) ?? d.key })));
      difficulty.value = state.difficulty;
      difficulty.onChange = (v) => { state.difficulty = v as Difficulty; h.onDifficulty(state.difficulty); };
    }

    // A locked campaign, a locked chapter, and every cinematic row answer to nothing.
    if (state.chapters) {
      rows.forEach((row, i) => {
        s.setEnabled(rowButton(i), playable(row, state.campaign, rows, i, progress));
      });
    } else {
      campaigns.forEach((_, i) => s.setEnabled(rowButton(i), isCampaignOpen(campaigns, i, progress)));
    }
  }
}

/** Is a chapter row clickable? Only a row that names a MAP is: the campaign cinematics are
 *  AVI movies under Movies\*.mpq and the Scourge finale is a model played in-engine (see
 *  CampaignEntry.file) — neither is something to launch. A mission also needs the one before
 *  it finished. */
function playable(row: CampaignEntry, c: Campaign, rows: CampaignEntry[], i: number, progress: ReturnType<typeof loadProgress>): boolean {
  if (!row.playable) return false;
  return isMissionOpen(c, missionIndex(rows, i), progress);
}

/** Row `i` of the chapter list as an index into `campaign.missions` — the list also carries
 *  the campaign's own three cinematics, which are not chapters and are not counted. */
function missionIndex(rows: CampaignEntry[], i: number): number {
  let n = 0;
  for (let k = 0; k < i; k++) if (rows[k].mission) n++;
  return n;
}

/** frameName → click handler for every row on screen. */
function rowHandlers(
  campaigns: Campaign[],
  state: CampaignScreenState,
  rows: CampaignEntry[],
  progress: ReturnType<typeof loadProgress>,
  h: CampaignHandlers,
): Record<string, () => void> {
  const out: Record<string, () => void> = { BackButton: h.onBack };
  if (state.chapters) {
    rows.forEach((row, i) => {
      if (!row.playable) return;
      const mission = missionIndex(rows, i);
      out[rowButton(i)] = () => h.onPlayMission(state.campaign, mission);
    });
  } else {
    campaigns.forEach((c, i) => {
      if (!isCampaignOpen(campaigns, i, progress)) return;
      out[rowButton(i)] = () => h.onSelectCampaign(c);
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
  campaigns: Campaign[],
  state: CampaignScreenState,
  rows: CampaignEntry[],
): FdfFrame {
  const root = lib.resolveRoot("CampaignMenu");
  if (!root) throw new Error("CampaignMenu.fdf: no CampaignMenu frame");

  // The logo: a SPRITE with neither art nor size in TFT's file (the engine hands it both), and
  // re-anchored inside the corner because we draw a flat texture where the file expects a model
  // (see LOGO_ART_TFT / LOGO_INSET).
  const logo = findChild(root, "WarCraftIIILogo");
  if (logo) {
    size(logo, LOGO_W, LOGO_H);
    setProp(logo, "SetPoint", [arg("TOPRIGHT"), str("CampaignMenu"), arg("TOPRIGHT"), num(LOGO_INSET), num(LOGO_INSET)]);
  }

  // The rows, into whichever of the two select frames this mode is.
  const container = state.chapters ? "MissionSelectFrame" : "CampaignSelectFrame";
  const built = state.chapters
    ? buildRows(lib, rows.map((r) => ({ header: r.header, name: r.name, camera: !r.playable })), MISSION_BOTTOM, MISSION_PITCH)
    : buildRows(lib, campaigns.map((c) => ({ header: `${c.header}:`, name: c.name, camera: false })), CAMPAIGN_BOTTOM, CAMPAIGN_PITCH);
  const target = findChild(root, container);
  if (target) target.children.push(...built);

  // Both select frames stay up: what the reference swaps is the ROWS inside them (RoC's glue
  // script hides `NightElfFrame`/`Mission7Frame`, never the two containers), and the logo, the
  // difficulty box and the bottom-centre title belong to the screen in either mode.
  return root;
}

/**
 * One row per entry, stacked bottom-up exactly as RoC's CampaignMenu.fdf chains them: the
 * LAST row is anchored above the Back button, and every row above is anchored to the row
 * below it. Chaining (rather than computing a y per row) is what keeps the spacing right —
 * a row's height is its text's, and only the file's own chain knows it without measuring.
 */
function buildRows(
  lib: FdfLibrary,
  entries: Array<{ header: string; name: string; camera: boolean }>,
  bottom: number,
  pitch: number,
): FdfFrame[] {
  const out: FdfFrame[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const label = lib.resolveRoot("StandardSmallTextTemplate");
    const desc = lib.resolveRoot("StandardTitleTextTemplate");
    // A cinematic gets the film-camera button, a mission the arrow — both are the file's own
    // (RoC hangs a CampaignCameraButton on every mission row for exactly this).
    const button = lib.resolveRoot(entry.camera ? "CampaignCameraButtonTemplate" : "CampaignArrowButtonTemplate");
    if (!label || !desc || !button) break;

    label.name = rowLabel(i);
    setProp(label, "Text", [str(entry.header)]);
    const below = i === entries.length - 1
      ? [arg("BOTTOMLEFT"), str("BackButton"), arg("TOPLEFT"), num(-0.03), num(bottom)]
      : [arg("BOTTOMLEFT"), str(rowLabel(i + 1)), arg("TOPLEFT"), num(0), num(pitch)];
    setProp(label, "SetPoint", below);

    desc.name = rowDesc(i);
    setProp(desc, "Text", [str(entry.name)]);
    setProp(desc, "FontColor", [num(DESC_GREY), num(DESC_GREY), num(DESC_GREY), num(1)]);
    setProp(desc, "SetPoint", [arg("TOPLEFT"), str(rowLabel(i)), arg("BOTTOMLEFT"), num(0), num(0)]);

    button.name = rowButton(i);
    setProp(button, "SetPoint", [arg("TOPRIGHT"), str(rowLabel(i)), arg("TOPLEFT"), num(ARROW_DX), num(ARROW_DY)]);

    // Built bottom-up (each anchors to the row below), but pushed in list order so the DOM
    // reads top-to-bottom like the screen does.
    out.unshift(label, desc, button);
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
