import type { DataSource } from "../vfs/types";
import { loadDifficulty, saveDifficulty, type Difficulty } from "../data/campaignProgress";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { DIFFICULTIES } from "./fdfCampaign";
import { adopt, arg, findFrame, nudgeX, num, setProp, size, str } from "./mapBrowser";

// The Custom Campaign screen, built from the game's own UI\FrameDef\Glue\CustomCampaignMenu.fdf:
// the list of installed custom campaigns down the left with the difficulty box under it, the
// chosen campaign's details top-right, and Play Campaign / Back at the bottom.
//
// WHICH CHROME IT WEARS — the same question, and the same answer, as ui/fdfViewReplay.ts: no
// panel model carries a "CustomCampaign" triple, and this file's geometry is the file-list
// shape (a 0.37-wide `FileListFrame` under a title at 0.02625/-0.039, a 0.271875×0.223125
// info pane at TOP→TOPRIGHT -0.180625/-0.0375, OK/Cancel at BOTTOMRIGHT -0.014375/0.124375),
// which is "BattlenetCustomCreate": one tall left-hand frame, no lower-left strip. Its list is
// shorter than the replay screen's (0.3 against 0.325) because the difficulty box sits under
// it — inside the same frame.
//
// THE PANE IS THIS FILE'S OWN, not MapInfoPane.fdf. CustomCampaignMenu.fdf declares
// `CampaignInfoPane`'s contents inline (name + author badge, the minimap under its cover art,
// author / difficulty / number of missions, then the blurb) and anchors all but the first of
// them to each other, exactly as MapInfoPane.fdf does — so the one unanchored frame is placed
// here, the way ui/mapBrowser.ts `layoutInfoPane` places that pane's.
//
// THE LIST IS EMPTY on a stock install, and that is the reference's own behaviour rather than
// a stub: a custom campaign is a `.w3n` the player drops into Maps\Download, this install has
// none, and OpenWar3 does not open `.w3n` archives yet. Play Campaign stays greyed exactly as
// it does there with nothing picked.

const LIST_FDF = "UI\\FrameDef\\Glue\\ListBoxWar3.fdf";

/** How far left the info pane's contents move to sit inside the 3D chrome that frames them —
 *  the same widescreen correction every glue screen's right-hand column needs
 *  (ui/mapBrowser.ts `nudgeX`). */
const PANE_NUDGE = 0.052;

/** CustomCampaignMenu.fdf's own CampaignInfoPane box, and where the name row sits in it. The
 *  minimap is anchored 0.0325 below the pane's top by the file itself; the name row goes in
 *  the gap above it, on the same inset MapInfoPane.fdf's name row uses. */
const NAME_ROW_INSET = 0.03;
const NAME_ROW_TOP = 0.004;
const NAME_W = 0.14;
const NAME_H = 0.019;

export interface CustomCampaignHandlers {
  onCancel: () => void;
}

export function mountCustomCampaignScreen(
  container: HTMLElement,
  vfs: DataSource,
  h: CustomCampaignHandlers,
): Promise<FdfScreen> {
  // The difficulty is the same setting the Campaign screen keeps — one difficulty for the
  // player, not one per screen (data/campaignProgress.ts).
  let difficulty = loadDifficulty();
  let lib: FdfLibrary | null = null;

  return mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\CustomCampaignMenu.fdf",
    rootFrame: "CustomCampaignMenu",
    includeFdf: [LIST_FDF],
    buildRoot: (l) => { lib = l; return buildCustomCampaignRoot(l); },
    buttonWidthScale: 1.35,
    // The screen's panels, one per piece of chrome that carries them: the list and the
    // difficulty box on the left, the details column on the right, the two buttons below it.
    panels: ["GameSettingsPanel", "CampaignInfoPane", "OKBackdrop", "CancelBackdrop"],
    // The list and the details are what the screen is FOR rather than furniture it arrives
    // with, so they fade up a beat after the chrome has landed (ui/fdf/anim.ts).
    latePanels: ["GameSettingsPanel", "CampaignInfoPane"],
    handlers: {
      CancelButton: h.onCancel,
    },
    onBuild: (s) => fill(s),
  });

  function fill(s: FdfScreen): void {
    const list = s.list("ListBoxWar3");
    list?.setItems([]);

    const select = s.popup("DifficultySelect");
    if (select) {
      select.setOptions(DIFFICULTIES.map((d) => ({ value: d.value, label: lib?.string(d.key) ?? d.key })));
      select.value = difficulty;
      select.onChange = (v) => { difficulty = v as Difficulty; saveDifficulty(difficulty); };
    }

    // Nothing picked: the details are blank and the badge that describes a campaign is a
    // FRAME rather than text, so it is hidden rather than emptied (as clearMapInfo does).
    for (const name of ["CampaignNameValue", "AuthorValue", "DifficultyValue", "NumMissionsValue", "MapDescValue"]) {
      s.setText(name, "");
    }
    const badge = s.frame("AuthIcon");
    if (badge) badge.style.display = "none";
    s.setEnabled("OKButton", false);
  }
}

/** CustomCampaignMenu + the list box dropped into its empty container, and the one frame of
 *  its info pane the file leaves for the engine to place. */
function buildCustomCampaignRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("CustomCampaignMenu");
  if (!root) throw new Error("CustomCampaignMenu.fdf: no CustomCampaignMenu frame");

  const listBox = lib.resolveRoot("ListBoxWar3");
  if (listBox) {
    setProp(listBox, "SetAllPoints", []); // fill the container the FDF already sized
    adopt(root, "FileListFrame", [listBox]);
  }

  // The name row. Everything else in the pane is chained — the author badge to the name, the
  // minimap to the pane, the stat rows to the minimap's cover — but the name itself carries
  // no SetPoint and no size, so it would inherit the pane's box and print down the middle of
  // the minimap. Place it, and give it the line it draws.
  const name = findFrame(root, "CampaignNameValue");
  setProp(name, "SetPoint", [arg("TOPLEFT"), str("CampaignInfoPane"), arg("TOPLEFT"), num(NAME_ROW_INSET), num(-NAME_ROW_TOP)]);
  size(name, NAME_W, NAME_H);

  // …and the whole right-hand column moves left to sit inside the 3D chrome that frames it.
  nudgeX(findFrame(root, "CampaignInfoPane"), -PANE_NUDGE);
  return root;
}
