import { computerPlusDefault } from "../data/options";
import { LAN_ADVANCED_OPTIONS_OVERRIDE, OW3_STRINGS } from "../overrides";
import {
  DEFAULT_ADVANCED, OBSERVER_ITEMS, VISIBILITY_ITEMS,
  type AdvancedOptions, type ObserverSetting, type Visibility,
} from "../net/advancedOptions";
import type { DataSource } from "../vfs/types";
import type { MapInfo } from "../world/mapInfo";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import {
  BLURB_SCROLLBAR_FDF, MapBrowser, adopt, findFrame, layoutInfoPane, nudgeX, setProp,
} from "./mapBrowser";
import { savedPlayerName } from "./fdfLan";

// "Create Game" on the LAN screen, built from UI\FrameDef\Glue\LocalMultiplayerCreate.fdf:
// pick the map you are going to host, set the game's Advanced Options, then Create Game.
//
// In the real client this is its own screen, and it has to be — the game you announce on the
// network IS a map, so the map has to be chosen before the room exists (the game list's rows
// carry it, and a joiner reads the map's summary before deciding to join). So Create Game on
// LocalMultiplayerJoin.fdf comes HERE, and this screen's own Create Game announces the room.
//
// It is the Custom Game screen's two outer columns with the player rows taken out, and the
// engine builds it from the same files — MapListBox.fdf into MapListContainer,
// MapInfoPane.fdf into MapInfoPaneContainer, AdvancedOptionsPane.fdf into
// AdvancedOptionsPaneContainer. ui/mapBrowser.ts owns the first two.
//
// The right-hand column has the Custom Game screen's two FACES (see PANEL_FACES there): the
// map's summary, and the Advanced Options pane the button under it swaps in. The pane here is
// the GAME's pane, Observers dropdown and all — on a hosted game that row means exactly what
// it says — plus our one Computer+ row (src/overrides/, `LAN_ADVANCED_OPTIONS_OVERRIDE`).
// What the host sets here is FIXED for the room's life and printed in the lobby, as in the
// real client; it is the `AdvancedOptions` record the lobby carries (src/net/advancedOptions.ts).
//
// The Game Speed slider is shown parked on Fast and greyed: WC3's three speeds scale the
// sim's tick rate, ours is fixed at the fastest by Phase A (docs/multiplayer.md), and a slider
// that says "Fast" and takes no other answer is the truth of it. It stays on screen because
// the reference has it, and because "Select Map:" hangs off it.

const MAP_LIST_FDF = "UI\\FrameDef\\Glue\\MapListBox.fdf";
const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";
const ADVANCED_OPTIONS_FDF = "UI\\FrameDef\\Glue\\AdvancedOptionsPane.fdf";

/** The right-hand column's two faces — the same pair, under the same names, as Skirmish.fdf's.
 *  `MapInfoButton` is the button ON the map-info face, captioned "Advanced Options". */
const PANEL_FACES = { info: "MapInfoPanel", advanced: "AdvancedOptionsPanel" } as const;

/** LocalMultiplayerCreate.fdf's own `GameSpeedSlider` range: 0 slow, 1 normal, 2 fast. */
const GAME_SPEED_FAST = 2;

export interface LanCreateHandlers {
  /** The host settled on a map: announce the room and drop into the game lobby (issue #77).
   *  `gameName` is the game's own default — GlobalStrings' GAMENAME, "Local Game (%s)";
   *  `advanced` is what the pane was left on, fixed for the room's life. */
  onCreate: (path: string, info: MapInfo, gameName: string, advanced: AdvancedOptions) => void;
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
  /** The FDF library, captured on build so the pane's own MenuItem labels resolve through
   *  GlobalStrings ("Full Observers", "Map Explored") rather than being re-typed here. */
  let lib: FdfLibrary | null = null;
  /**
   * Which of the right-hand column's two faces is up — the array `mountFdfScreen` reads its
   * `hidden` set out of on every build, so swapping its contents and asking for a relayout IS
   * the panel swap (the same trick, and the same array-identity caveat, as fdfSkirmish).
   */
  const hiddenPanels: string[] = [PANEL_FACES.advanced];
  /**
   * The Advanced Options, as the pane opens: the game's own defaults, except that Computer+
   * opens on whatever Options → Gameplay → "Use Computer+ as default AI" was left at — the
   * host's own preference is what a fresh game should assume about its computers.
   */
  const advanced: AdvancedOptions = { ...DEFAULT_ADVANCED, computerPlus: computerPlusDefault() };

  const create = (): void => {
    const picked = browser.selected;
    if (picked) h.onCreate(picked.path, picked.info, gameName, { ...advanced });
  };

  browser.onChange = () => screen.relayout();
  browser.onActivate = () => create();

  const screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\LocalMultiplayerCreate.fdf",
    // Every letter belongs to the map list's type-ahead search here (issue #137) — a map's
    // name is spelled with the same letters this screen's buttons answer to.
    noShortcutKeys: true,
    rootFrame: "LocalMultiplayerCreate",
    includeFdf: [MAP_LIST_FDF, MAP_INFO_FDF, ADVANCED_OPTIONS_FDF, BLURB_SCROLLBAR_FDF],
    // …and our own layer on the Advanced Options pane: the Computer+ switch, which the 2003 UI
    // has no frame for. The game's Observers row is KEPT on this screen — see src/overrides/.
    overrides: [OW3_STRINGS, LAN_ADVANCED_OPTIONS_OVERRIDE],
    buildRoot: (l) => {
      lib = l;
      browser.useStrings(l);
      gameName = l.string("GAMENAME").replace("%s", savedPlayerName());
      return buildCreateRoot(l);
    },
    // Advanced Options and the map info are one column with two faces, and exactly one of
    // them is on screen at a time (see PANEL_FACES). `hiddenPanels` is which.
    hidden: hiddenPanels,
    panels: ["GameSettingsPanel", "MapInfoPanel", "AdvancedOptionsPanel", "PlayBackdrop", "CancelBackdrop"],
    // The map list and the summary of the map picked out of it are what the screen is FOR;
    // they arrive after the chrome has landed, as on the Custom Game screen.
    latePanels: ["GameSettingsPanel", "MapInfoPanel", "AdvancedOptionsPanel"],
    handlers: {
      PlayButton: () => create(),
      CancelButton: h.onCancel,
      // The two buttons that swap the column over. Each lives on the panel it is leaving and
      // is captioned with the one it goes to — MapInfoButton reads "Advanced Options".
      MapInfoButton: () => showFace("advanced"),
      AdvancedOptionsButton: () => showFace("info"),
    },
    onBuild: (s) => fill(s),
  });

  /** Swap the right-hand column's face: one line of state and a rebuild. */
  function showFace(face: keyof typeof PANEL_FACES): void {
    hiddenPanels.length = 0;
    hiddenPanels.push(face === "advanced" ? PANEL_FACES.info : PANEL_FACES.advanced);
    screen.relayout();
  }

  const dispose = screen.dispose.bind(screen);
  screen.dispose = (): void => { browser.dispose(); dispose(); };

  void browser.openFolder(browser.cwd);
  return screen;

  /** (Re)fill every widget from the state above — called after each build/rebuild. */
  function fill(s: FdfScreen): void {
    browser.fill(s);
    const picked = !!browser.selected;
    s.setEnabled("PlayButton", picked); // nothing picked yet: nothing to host
    // …and nothing to configure either: the options are the MATCH's, so the button that
    // opens them is dead until there is a map to play.
    s.setEnabled("MapInfoButton", picked);

    // The one speed we run at, said by the slider and the value beside it (GlobalStrings FAST).
    const speed = s.slider("GameSpeedSlider");
    if (speed) {
      speed.value = GAME_SPEED_FAST;
      speed.setEnabled(false);
    }
    s.setText("GameSpeedValue", lib?.string("FAST") ?? "Fast");

    fillAdvanced(s);
  }

  /**
   * The Advanced Options pane — five checkboxes, two menus, our Computer+ row, and the button
   * back. Called on every build whether the pane is up or not: when it is hidden none of these
   * frames exist and every lookup answers null, which is exactly the right no-op.
   *
   * All of them are LIVE here, unlike on the Custom Game screen, because on a hosted game each
   * is a real setting the lobby prints and the match is built from (src/net/advancedOptions.ts
   * says which ones the match acts on yet and which it only carries).
   */
  function fillAdvanced(s: FdfScreen): void {
    const text = (key: string): string => lib?.string(key) ?? key;
    const boxes: Array<[string, keyof AdvancedOptions & ("lockTeams" | "teamsTogether" | "sharedControl" | "randomRaces" | "randomHero" | "computerPlus")]> = [
      ["LockTeamsCheckBox", "lockTeams"],
      ["TeamsTogetherCheckBox", "teamsTogether"],
      ["AdvSharedControlCheckBox", "sharedControl"],
      ["RandomRacesCheckBox", "randomRaces"],
      ["RandomHeroCheckBox", "randomHero"],
      ["ComputerPlusCheckBox", "computerPlus"],
    ];
    for (const [name, key] of boxes) {
      const box = s.checkBox(name);
      if (!box) continue;
      box.checked = advanced[key];
      box.onChange = (on) => { advanced[key] = on; };
    }
    // The two menus: their items are the FDF's own MenuItem lists, under the GlobalStrings
    // names the game prints them by, and the value each carries is that KEY.
    const observers = s.popup("ObserversMenu");
    if (observers) {
      observers.setOptions(OBSERVER_ITEMS.map((v) => ({ value: v, label: text(v) })));
      observers.value = advanced.observers;
      observers.onChange = (v) => { advanced.observers = v as ObserverSetting; };
    }
    const visibility = s.popup("MapVisibilityMenu");
    if (visibility) {
      visibility.setOptions(VISIBILITY_ITEMS.map((v) => ({ value: v, label: text(v) })));
      visibility.value = advanced.visibility;
      visibility.onChange = (v) => { advanced.visibility = v as Visibility; };
    }
  }
}

/** LocalMultiplayerCreate + the map list, the info pane and the options pane dropped into
 *  its containers. */
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
  if (pane) adopt(root, "MapInfoPaneContainer", [layoutInfoPane(pane, { w: PANE_W, h: PANE_H, lib })]);

  // …and the same box's OTHER face, out of AdvancedOptionsPane.fdf. Like the map list it is a
  // bare `FRAME` whose children anchor to it, so it takes the container's own box.
  const advanced = lib.resolveRoot("AdvancedOptionsPane");
  if (advanced) {
    setProp(advanced, "SetAllPoints", []);
    adopt(root, "AdvancedOptionsPaneContainer", [advanced]);
  }

  // Both faces move left to sit inside the 3D chrome that frames them, the same correction
  // (and the same distance) the Custom Game and LAN screens make — see nudgeX. Both, so the
  // swap reads as a swap rather than a jump.
  for (const name of ["MapInfoPaneContainer", "MapInfoBackdrop", "AdvancedOptionsPaneContainer", "AdvancedOptionsBackdrop"]) {
    nudgeX(findFrame(root, name), -MAP_INFO_NUDGE);
  }

  return root;
}

/** LocalMultiplayerCreate.fdf's own MapInfoPaneContainer box. */
const PANE_W = 0.271875;
const PANE_H = 0.323125;

/** How far left the right-hand column's contents move to sit inside the 3D chrome. */
const MAP_INFO_NUDGE = 0.052;
