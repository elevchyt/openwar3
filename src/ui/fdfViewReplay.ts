import type { DataSource } from "../vfs/types";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { ListItem } from "./fdf/widgets";
import {
  INFO_ROWS, adopt, clearMapInfo, fillMapInfo, findFrame, layoutInfoPane, loadMinimapIcons, nudgeX,
  paneRowsToHide, readMapInfo, readMapPreviewFor, setProp,
} from "./mapBrowser";
import { widescreen } from "./widescreen";
import { showGlueDialog } from "./glueDialog";
import { blpToCanvas } from "../render/blputil";
import { readReplayHeader, REPLAY_EXT, type ReplayHeader } from "../game/replay";
import type { ReplayFileInfo, ReplaySink } from "../game/replaySink";

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
// THE LIST is the replay folder (game/replaySink.ts, docs/replays.md): `LastReplay` and the
// replays the player saved at the top level, newest first, and the game's own `Autosaved`
// folder as a FOLDER row, walked into and out of as the map list's folders are (the same
// `icon-folder` art and `UP_ONE_LEVEL` row, ui/mapBrowser.ts). A row is the file's name without
// its extension, as the game lists `LastReplay`. Highlighting one reads its HEADER and shows
// its map in the summary pane, with the replay's own player count under it; View Replay (or a
// double-click) watches it. A replay whose map is not in this install stays listed and says
// so — its name is in the header — but cannot be watched.

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

/** OpenWar3's version, from package.json (vite.config.ts `define`). */
declare const __OW3_VERSION__: string;

const ICON_FOLDER = "UI\\Widgets\\Glues\\icon-folder.blp";
const ICON_FOLDER_UP = "UI\\Widgets\\Glues\\icon-folder-up.blp";

/** The game's own subfolder for "Automatically Save Replays" (electron/replayStore.mjs). */
const AUTOSAVED = "Autosaved";
const FOLDER = "folder:";

export interface ViewReplayHandlers {
  onCancel: () => void;
  /** Watch the named replay (a name `ReplaySink.read` takes). */
  onView: (name: string) => void;
}

export function mountViewReplayScreen(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  sink: ReplaySink | null,
  h: ViewReplayHandlers,
): Promise<FdfScreen> {
  const minimapIcons = loadMinimapIcons(vfs);
  const icon = (path: string): HTMLCanvasElement | null => {
    const bytes = vfs.rawBytes(path);
    return bytes ? blpToCanvas(bytes) : null;
  };
  const folderIcon = icon(ICON_FOLDER);
  const upIcon = icon(ICON_FOLDER_UP);
  let strings: FdfLibrary | null = null;
  let files: ReplayFileInfo[] = [];
  /** The folder shown: "" (the top) or `Autosaved`. */
  let cwd = "";
  let picked: string | null = null;
  /** Headers read so far, by file name — a replay is read once per visit to the screen. */
  const headers = new Map<string, ReplayHeader | null>();
  let screen: FdfScreen | null = null;

  const leafName = (name: string): string => name.slice(name.lastIndexOf("/") + 1).replace(/\.o3r$/i, "");
  const inFolder = (name: string): string => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");

  return mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\ViewReplayScreen.fdf",
    rootFrame: "ViewReplayScreen",
    includeFdf: [LIST_FDF, MAP_INFO_FDF],
    buildRoot: (lib) => { strings = lib; return buildViewReplayRoot(lib); },
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
      OKButton: () => watch(),
    },
    onBuild: (s) => {
      screen = s;
      paint();
      void sink?.list().then((all) => {
        files = all.filter((f) => f.name.toLowerCase().endsWith(REPLAY_EXT));
        paint();
      });
    },
  });

  function watch(): void {
    const name = picked;
    const header = name && !name.startsWith(FOLDER) ? headers.get(name) : null;
    if (!name || !header || !mapPathOf(header)) return;
    if (header.version === __OW3_VERSION__) return h.onView(name);
    // Recorded by another OpenWar3: asked first, in the game's own words for its own case — a
    // replay from another build, played "ignoring recorded checksums" (GlobalStrings
    // REPLAY_CONFIRM*). The game's two rows are NET VERSION and BUILD; ours has one number, the
    // release, so the BUILD pair says it. A different release may simulate differently, and the
    // state checks then say where it parted (the panel's timeline turns red).
    const str = (key: string, fallback: string): string => {
      const v = strings?.string(key);
      return v && v !== key ? v : fallback;
    };
    void showGlueDialog({
      container,
      vfs,
      buttons: "yesno",
      // Six lines are all the menus' message box has above its buttons — the question's four and
      // the two builds — so the box goes without the REPLAY_CONFIRM heading the game's own
      // dialog puts in its title bar, which this one does not have.
      text: [
        str("REPLAY_CONFIRM_DESC", "The replay was recorded by a different version of the game. Do you wish to attempt running the replay while ignoring recorded checksums?"),
        `${str("REPLAY_CONFIRM_RE_BUILD", "Recorded build:")} ${header.version}`,
        `${str("REPLAY_CONFIRM_GA_BUILD", "Game build:")} ${__OW3_VERSION__}`,
      ].join("|n"),
      onConfirm: () => h.onView(name),
    });
  }

  function mapPathOf(header: ReplayHeader | null | undefined): string | null {
    return header ? replayMapPath(maps, header.map.path) : null;
  }

  /** The list, the summary and the buttons, as they stand. */
  function paint(): void {
    const s = screen;
    if (!s) return;
    const list = s.list("ListBoxWar3");
    const here = files.filter((f) => inFolder(f.name) === cwd);
    const rows: ListItem[] = [];
    if (cwd) rows.push({ value: FOLDER, label: strings?.string("UP_ONE_LEVEL") ?? "(up one level)", icon: upIcon });
    else if (files.some((f) => inFolder(f.name) === AUTOSAVED)) rows.push({ value: FOLDER + AUTOSAVED, label: AUTOSAVED, icon: folderIcon });
    for (const f of here) rows.push({ value: f.name, label: leafName(f.name) });
    if (list) {
      list.setItems(rows);
      list.onChange = (value) => {
        picked = value;
        void show(value);
      };
      list.onActivate = (value) => {
        if (value.startsWith(FOLDER)) {
          cwd = value.slice(FOLDER.length);
          picked = null;
          paint();
        } else watch();
      };
      if (picked) list.select(picked);
    }
    void show(picked);
  }

  /** The highlighted replay's map and player count — or an empty pane for a folder or nothing. */
  async function show(name: string | null): Promise<void> {
    const s = screen;
    if (!s) return;
    if (!name || name.startsWith(FOLDER)) {
      clearMapInfo(s);
      s.setText("NumPlayersValue", "");
      s.setEnabled("OKButton", false);
      return;
    }
    if (!headers.has(name)) {
      const bytes = await sink?.read(name).catch(() => null);
      const header = bytes ? await readReplayHeader(bytes).then((r) => r.header).catch(() => null) : null;
      headers.set(name, header);
    }
    if (picked !== name) return;
    const header = headers.get(name) ?? null;
    const path = mapPathOf(header);
    // The players who PLAYED it — the seats, never the watchers.
    s.setText("NumPlayersValue", header ? String(header.seats.length) : "");
    s.setEnabled("OKButton", !!path);
    const info = path ? await readMapInfo(maps, path).catch(() => null) : null;
    if (picked !== name) return;
    if (!info || !path) {
      clearMapInfo(s);
      // Not watchable here, and why: the map it was played on is not in this install. Said in
      // the name row, where the map's name would be.
      const name = s.frame("MapNameValue");
      if (header && name) {
        name.style.display = "";
        s.setText("MapNameValue", `|cffff8080${header.map.name} — not installed|r`);
      }
      return;
    }
    fillMapInfo(s, info, null, minimapIcons);
    const preview = await readMapPreviewFor(vfs, maps, path).catch(() => null);
    if (picked === name && preview) fillMapInfo(s, info, preview, minimapIcons);
  }
}

/** The install's copy of the map a replay was played on: the path it was recorded under, or the
 *  same file name anywhere in the install (another machine keeps its maps elsewhere, and a map a
 *  LAN game handed over lands in Maps\Download\). Which copy is RIGHT is the map hash's call
 *  (main.ts `watchReplay`). */
export function replayMapPath(maps: ReadonlyMap<string, File>, recorded: string): string | null {
  if (maps.has(recorded)) return recorded;
  const leaf = (p: string): string => p.split(/[\\/]/).pop()!.toLowerCase();
  return [...maps.keys()].find((p) => leaf(p) === leaf(recorded)) ?? null;
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
  nudgeX(findFrame(root, "MapInfoPaneContainer"), -widescreen(MAP_INFO_NUDGE));
  return root;
}

/** ViewReplayScreen.fdf's own MapInfoPaneContainer box. */
const PANE_W = 0.271875;
const PANE_H = 0.223125;
