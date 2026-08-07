import type { DataSource } from "../vfs/types";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import {
  INFO_ROWS, adopt, clearMapInfo, findFrame, layoutInfoPane, nudgeX, paneRowsToHide, setProp,
} from "./mapBrowser";

// The View Replay screen, built from the game's own UI\FrameDef\Glue\ViewReplayScreen.fdf:
// the replay list down the left, the map of the highlighted replay top-right, and
// View Replay / Back at the bottom.
//
// WHICH CHROME IT WEARS. The panel models carry no "ViewReplay" sequence triple — no glue
// model does — so this screen wears one of the shared sets, and the FDF says which: the file
// is structurally IDENTICAL to LoadSavedGameScreen.fdf and LocalMultiplayerLoad.fdf (a
// 0.37×0.325 `FileListFrame` under a title at 0.02625/-0.039, a 0.271875×0.223125
// `MapInfoPaneContainer` at TOP→TOPRIGHT -0.180625/-0.0375, and OK/Cancel at
// BOTTOMRIGHT -0.014375/0.124375). LocalMultiplayerLoad is the transport-swapped twin of
// BattleNetCustomLoadPanel.fdf, whose siblings Join and Create wear "BattlenetCustom" and
// "BattlenetCustomCreate" — and of those two only BattlenetCustomCreate is the right SHAPE:
// one tall left-hand frame and no lower-left strip, which is what a screen that is a file
// list and nothing else needs (BattlenetCustom's lower strip carries the LAN screen's
// Create/Load buttons, and this screen has none). Dumped and compared against the models
// themselves — see render/menuScene.ts.
//
// Like Skirmish.fdf and LocalMultiplayerJoin.fdf, this file declares `FileListFrame` and
// `MapInfoPaneContainer` as EMPTY containers the engine fills at runtime, so `buildRoot`
// composes the game's own ListBoxWar3.fdf and MapInfoPane.fdf into them.
//
// THE LIST IS EMPTY, and that is not a stub — it is what the reference shows on an install
// with no saved replays. OpenWar3 records none yet, so nothing can land in it; View Replay
// stays greyed exactly as it does there with nothing picked.

const LIST_FDF = "UI\\FrameDef\\Glue\\ListBoxWar3.fdf";
const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";

/** This screen's pane is the SHORT one (0.223125, the LAN summary's height), so it carries
 *  the three stat rows and no description — see ui/fdfLan.ts for why that is a height
 *  question rather than a taste one. */
const SUMMARY_ROWS = INFO_ROWS.slice(0, 3);

/** How far left the summary pane's contents move to sit inside the 3D chrome that frames
 *  them — the same widescreen correction every glue screen's right-hand column needs
 *  (ui/mapBrowser.ts `nudgeX`). */
const MAP_INFO_NUDGE = 0.052;

export interface ViewReplayHandlers {
  onCancel: () => void;
}

export function mountViewReplayScreen(
  container: HTMLElement,
  vfs: DataSource,
  h: ViewReplayHandlers,
): Promise<FdfScreen> {
  return mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\ViewReplayScreen.fdf",
    rootFrame: "ViewReplayScreen",
    includeFdf: [LIST_FDF, MAP_INFO_FDF],
    buildRoot: (lib) => buildViewReplayRoot(lib),
    buttonWidthScale: 1.35,
    hidden: paneRowsToHide(SUMMARY_ROWS),
    // The screen's panels, one per piece of chrome that carries them: the list under its
    // title on the left, the summary column on the right, and the two buttons at the bottom.
    panels: ["GameSettingsPanel", "MapInfoPaneContainer", "NumPlayersLabel", "NumPlayersValue", "OKBackdrop", "CancelBackdrop"],
    // The list and the summary are what the screen is FOR rather than furniture it arrives
    // with, so they fade up a beat after the chrome has landed (ui/fdf/anim.ts). The
    // "Number of Players" row is part of the summary — it hangs off the pane's own bottom —
    // and has to travel with it, or it appears on an empty panel a beat early.
    latePanels: ["GameSettingsPanel", "MapInfoPaneContainer", "NumPlayersLabel", "NumPlayersValue"],
    handlers: {
      CancelButton: h.onCancel,
    },
    onBuild: (s) => fill(s),
  });

  function fill(s: FdfScreen): void {
    const list = s.list("ListBoxWar3");
    list?.setItems([]);
    s.setText("NumPlayersValue", "");
    clearMapInfo(s);
    // Nothing to watch: no replay is picked, and none can be.
    s.setEnabled("OKButton", false);
  }
}

/** ViewReplayScreen + the list box and the summary pane dropped into its two containers —
 *  the engine composes this screen from three files, so we do too. */
function buildViewReplayRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("ViewReplayScreen");
  if (!root) throw new Error("ViewReplayScreen.fdf: no ViewReplayScreen frame");

  const listBox = lib.resolveRoot("ListBoxWar3");
  if (listBox) {
    setProp(listBox, "SetAllPoints", []); // fill the container the FDF already sized
    adopt(root, "FileListFrame", [listBox]);
  }

  const pane = lib.resolveRoot("MapInfoPane");
  if (pane) {
    adopt(root, "MapInfoPaneContainer", [layoutInfoPane(pane, { w: PANE_W, h: PANE_H, rows: SUMMARY_ROWS })]);
  }

  // The pane and the "Number of Players" row under it move left together — the row is
  // anchored to the container's own BOTTOMLEFT, so nudging the container carries it.
  nudgeX(findFrame(root, "MapInfoPaneContainer"), -MAP_INFO_NUDGE);
  return root;
}

/** ViewReplayScreen.fdf's own MapInfoPaneContainer box. */
const PANE_W = 0.271875;
const PANE_H = 0.223125;
