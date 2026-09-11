import { computerPlusDefault } from "../data/options";
import { relayAuthority, type HostTarget, type LanLobby } from "../net/lobby";
import { OFFICIAL_SERVER_NAME } from "../net/officialServer";
import { LAN_ADVANCED_OPTIONS_OVERRIDE, LAN_CREATE_OVERRIDE, OW3_STRINGS } from "../overrides";
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
//
// Under the map list is a row of OURS, "Server:" (src/overrides/ui/LocalMultiplayerCreate.fdf):
// which relay the room is announced on — this computer, which only the local network can reach,
// or a server the Servers List watches, the OpenWar3 server first (src/net/officialServer.ts).
// It opens on wherever the host last put a game (`HOST_SERVER_KEY`) while that still answers,
// and otherwise on the official server.

const MAP_LIST_FDF = "UI\\FrameDef\\Glue\\MapListBox.fdf";
const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";
const ADVANCED_OPTIONS_FDF = "UI\\FrameDef\\Glue\\AdvancedOptionsPane.fdf";

/** The right-hand column's two faces — the same pair, under the same names, as Skirmish.fdf's.
 *  `MapInfoButton` is the button ON the map-info face, captioned "Advanced Options". */
const PANEL_FACES = { info: "MapInfoPanel", advanced: "AdvancedOptionsPanel" } as const;

/** LocalMultiplayerCreate.fdf's own `GameSpeedSlider` range: 0 slow, 1 normal, 2 fast. */
const GAME_SPEED_FAST = 2;

/** Where the host last announced a game (a `HostTarget.url`, "" for this computer). The Server
 *  menu opens on it again, as long as it is still answering. */
const HOST_SERVER_KEY = "openwar3.hostServer";

export interface LanCreateHandlers {
  /** The host settled on a map: announce the room and drop into the game lobby (issue #77).
   *  `gameName` is the game's own default — GlobalStrings' GAMENAME, "Local Game (%s)";
   *  `advanced` is what the pane was left on, fixed for the room's life; `server` is the Server
   *  menu's pick, a `HostTarget.url` ("" for this computer). */
  onCreate: (path: string, info: MapInfo, gameName: string, advanced: AdvancedOptions, server: string) => void;
  onCancel: () => void;
}

export async function mountLanCreateScreen(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  /** The LAN session's lobby — asked where a game can be announced (`hostTargets`), and followed
   *  while this screen is up, since a server can start answering with nobody touching anything. */
  lobby: LanLobby,
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
  /** The Server menu's last pick — null when the host has never picked one. */
  let server: string | null = null;
  try { server = localStorage.getItem(HOST_SERVER_KEY); } catch { /* no storage: no memory */ }

  /**
   * Where the game would be announced right now: the pick, while it is still answering; else the
   * OpenWar3 server, because a game there is one every player can see; else whatever answers at
   * all, which is this computer. Null only while nothing is answering yet.
   */
  const target = (): HostTarget | null => {
    const targets = lobby.hostTargets;
    return targets.find((t) => t.url === server)
      ?? targets.find((t) => t.kind === "official")
      ?? targets[0]
      ?? null;
  };

  const create = (): void => {
    const picked = browser.selected;
    const where = target();
    if (picked && where) h.onCreate(picked.path, picked.info, gameName, { ...advanced }, where.url);
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
    overrides: [OW3_STRINGS, LAN_ADVANCED_OPTIONS_OVERRIDE, LAN_CREATE_OVERRIDE],
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

  // The Server menu follows the lobby: the official server answering a beat after this screen
  // came up — or dropping — changes what can be offered with nobody having clicked anything. The
  // screen that comes next installs its own handler; `alive` quiets this one if it outlives us.
  let alive = true;
  lobby.onChange = () => { if (alive) fillServer(screen); };

  const dispose = screen.dispose.bind(screen);
  screen.dispose = (): void => { alive = false; browser.dispose(); dispose(); };

  void browser.openFolder(browser.cwd);
  return screen;

  /** The Server row, and Create Game with it: there is nothing to host ON until something answers. */
  function fillServer(s: FdfScreen): void {
    const targets = lobby.hostTargets;
    const where = target();
    const menu = s.popup("HostServerMenu");
    if (menu) {
      menu.setOptions(targets.map((t) => ({ value: t.url, label: targetLabel(t) })));
      if (where) menu.value = where.url;
      menu.setEnabled(targets.length > 1);
      menu.onChange = (v) => {
        server = v;
        try { localStorage.setItem(HOST_SERVER_KEY, v); } catch { /* no storage: no memory */ }
      };
    }
    s.setEnabled("PlayButton", !!browser.selected && !!where);
  }

  /** A place as a player reads it: the machine, the server's name, or the address they typed. */
  function targetLabel(t: HostTarget): string {
    if (t.kind === "own") return lib?.string("THIS_COMPUTER") ?? "This Computer";
    if (t.kind === "official") return OFFICIAL_SERVER_NAME;
    return relayAuthority(t.url);
  }

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
    fillServer(s);
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
