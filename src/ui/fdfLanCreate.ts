import type { DataSource } from "../vfs/types";
import type { MapInfo } from "../world/mapInfo";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { MapBrowser, adopt, arg, findFrame, layoutInfoPane, nudgeX, num, setProp, str } from "./mapBrowser";
import { savedPlayerName } from "./fdfLan";

// "Create Game" on the LAN screen, built from UI\FrameDef\Glue\LocalMultiplayerCreate.fdf:
// pick the map you are going to host, then Create Game.
//
// In the real client this is its own screen, and it has to be — the game you announce on the
// network IS a map, so the map has to be chosen before the room exists (the game list's rows
// carry it, and a joiner reads the map's summary before deciding to join). So Create Game on
// LocalMultiplayerJoin.fdf comes HERE, and this screen's own Create Game announces the room.
//
// It is the Custom Game screen's two outer columns with the player rows taken out, and the
// engine builds it from the same two files — MapListBox.fdf into MapListContainer,
// MapInfoPane.fdf into MapInfoPaneContainer. ui/mapBrowser.ts owns both.
//
// Not modelled: the Game Speed slider the FDF declares. WC3's three speeds scale the sim's
// tick rate, and ours is fixed at 60 Hz by Phase A (docs/multiplayer.md) — a slider that
// changed nothing would be a lie, so it is hidden rather than shown dead.

const MAP_LIST_FDF = "UI\\FrameDef\\Glue\\MapListBox.fdf";
const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";

export interface LanCreateHandlers {
  /** The host settled on a map: announce the room and drop into the game lobby (issue #77).
   *  `gameName` is the game's own default — GlobalStrings' GAMENAME, "Local Game (%s)". */
  onCreate: (path: string, info: MapInfo, gameName: string) => void;
  onCancel: () => void;
}

export async function mountLanCreateScreen(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  h: LanCreateHandlers,
): Promise<FdfScreen> {
  const browser = new MapBrowser(vfs, maps);
  /** GlobalStrings' own GAMENAME format — "Local Game (%s)", the name the real client gives a
   *  local game it creates. Filled in from the library the screen is built with. */
  let gameName = `Local Game (${savedPlayerName()})`;

  const create = (): void => {
    const picked = browser.selected;
    if (picked) h.onCreate(picked.path, picked.info, gameName);
  };

  browser.onChange = () => screen.relayout();
  browser.onActivate = () => create();

  const screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\LocalMultiplayerCreate.fdf",
    rootFrame: "LocalMultiplayerCreate",
    includeFdf: [MAP_LIST_FDF, MAP_INFO_FDF],
    buildRoot: (lib) => {
      browser.useStrings(lib);
      gameName = lib.string("GAMENAME").replace("%s", savedPlayerName());
      return buildCreateRoot(lib);
    },
    // Two mutually exclusive panels in the FDF, as on Skirmish: the map info is the one on
    // screen, so its Advanced Options twin stays hidden.
    hidden: ["AdvancedOptionsPanel", "GameSpeedLabel", "GameSpeedSliderBackdrop", "GameSpeedValue"],
    textOverrides: {
      GameSettingsTitle: "Create Game",
      MapListLabel: "Select Map:",
      PlayButtonText: "Create Game",
    },
    panels: ["GameSettingsPanel", "MapInfoPanel", "PlayBackdrop", "CancelBackdrop"],
    // The map list and the summary of the map picked out of it are what the screen is FOR;
    // they arrive after the chrome has landed, as on the Custom Game screen.
    latePanels: ["GameSettingsPanel", "MapInfoPanel"],
    handlers: {
      PlayButton: () => create(),
      CancelButton: h.onCancel,
    },
    onBuild: (s) => {
      browser.fill(s);
      s.setEnabled("PlayButton", !!browser.selected); // nothing picked yet: nothing to host
      // Advanced Options is a screen of its own that we don't have (as on Skirmish).
      s.setEnabled("MapInfoButton", false);
    },
  });

  const dispose = screen.dispose.bind(screen);
  screen.dispose = (): void => { browser.dispose(); dispose(); };

  void browser.openFolder(browser.cwd);
  return screen;
}

/** LocalMultiplayerCreate + the map list and the info pane dropped into its containers. */
function buildCreateRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("LocalMultiplayerCreate");
  if (!root) throw new Error("LocalMultiplayerCreate.fdf: no LocalMultiplayerCreate frame");

  const listBox = lib.resolveRoot("MapListBox");
  if (listBox) {
    setProp(listBox, "SetAllPoints", []); // the list fills the container the FDF sized
    adopt(root, "MapListContainer", [listBox]);
  }

  // This screen's own MapInfoPaneContainer is TALLER than Skirmish's (0.323125 against
  // 0.2875) — hence passing the box rather than letting the pane assume one.
  const pane = lib.resolveRoot("MapInfoPane");
  if (pane) adopt(root, "MapInfoPaneContainer", [layoutInfoPane(pane, { w: PANE_W, h: PANE_H })]);

  // …and the map-info panel moves left to sit inside the 3D chrome that frames it, the same
  // correction (and the same distance) the Custom Game and LAN screens make — see nudgeX.
  nudgeX(findFrame(root, "MapInfoPaneContainer"), -MAP_INFO_NUDGE);
  nudgeX(findFrame(root, "MapInfoBackdrop"), -MAP_INFO_NUDGE);

  // The Game Speed slider is not modelled (see the file header), and the FDF chains the map
  // list's label off it — so with the slider gone the label re-anchors to the title above it,
  // and the list comes up into the room the slider is no longer using rather than leaving a
  // hole where it stood.
  setProp(findFrame(root, "MapListLabel"), "SetPoint", [
    arg("TOPLEFT"), str("GameSettingsTitle"), arg("BOTTOMLEFT"), num(0), num(-0.02),
  ]);

  return root;
}

/** LocalMultiplayerCreate.fdf's own MapInfoPaneContainer box. */
const PANE_W = 0.271875;
const PANE_H = 0.323125;

/** How far left the map-info panel's contents move to sit inside the 3D chrome. */
const MAP_INFO_NUDGE = 0.052;
