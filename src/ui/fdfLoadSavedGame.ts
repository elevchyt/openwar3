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
import { replayMapPath } from "./fdfViewReplay";
import { readSaveHeader, type SaveHeader } from "../game/save/saveFile";
import { SAVE_EXT, type SaveFileInfo, type SaveSink } from "../game/save/saveSink";
import { OW3_STRINGS } from "../overrides";
import { stripMarkup } from "../game/chat";

// The Single Player menu's LOAD SAVED GAME screen (issue #159, docs/save-games.md), built from the
// game's own UI\FrameDef\Glue\LoadSavedGameScreen.fdf: the saved games down the left
// (`FileListFrame`, an empty container the engine fills, so the shared ListBoxWar3.fdf goes in
// as every glue list does), the highlighted save's map top-right (`MapInfoPaneContainer`, the
// shared MapInfoPane.fdf), and Load Game / Back at the bottom.
//
// The file is structurally IDENTICAL to ViewReplayScreen.fdf — same list box, same pane box, same
// buttons, same offsets — so it wears the same panel chrome (ui/fdfViewReplay.ts says which and
// why). A row is the save's name; highlighting one reads its HEADER only (`readSaveHeader`) and
// shows the map it was saved on — a campaign chapter, which is not in the install's Maps folder,
// by its name. Load Game (or a double-click) loads it; a save this build cannot load says why in
// the menus' message box, as the game itself does. The highlighted row carries the trash can the
// View Replay list has, asking the game's own DELETE_MESSAGE first.

const LIST_FDF = "UI\\FrameDef\\Glue\\ListBoxWar3.fdf";
const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";
const SUMMARY_ROWS = INFO_ROWS.slice(0, 3);
const MAP_INFO_NUDGE = 0.052;

/** Lucide's `trash` icon (lucide.dev, ISC licence) — the same row action View Replay has. */
const TRASH_SVG =
  '<svg class="ow3-row-trash" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/>' +
  '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

export interface LoadSavedGameHandlers {
  onCancel: () => void;
  /** Load the named save (a name `SaveSink.read` takes). */
  onLoad: (name: string) => void;
  /** Why this build cannot load a save, in words, or null when it can (main.ts `saveLoadRefusal`). */
  refusal: (header: SaveHeader) => string | null;
}

export function mountLoadSavedGameScreen(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  sink: SaveSink,
  h: LoadSavedGameHandlers,
): Promise<FdfScreen> {
  const minimapIcons = loadMinimapIcons(vfs);
  let strings: FdfLibrary | null = null;
  let files: SaveFileInfo[] = [];
  let picked: string | null = null;
  const headers = new Map<string, SaveHeader | null>();
  let screen: FdfScreen | null = null;

  const bare = (name: string): string => name.replace(/\.o3s$/i, "");
  const str = (key: string, fallback: string): string => {
    const v = strings?.string(key);
    return v && v !== key ? v : fallback;
  };

  return mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\LoadSavedGameScreen.fdf",
    rootFrame: "LoadSavedGameScreen",
    includeFdf: [LIST_FDF, MAP_INFO_FDF],
    buildRoot: (lib) => { strings = lib; return buildRoot(lib); },
    overrides: [OW3_STRINGS],
    buttonWidthScale: 1.35,
    hidden: paneRowsToHide(SUMMARY_ROWS),
    panels: ["GameSettingsPanel", "MapInfoPaneContainer", "OKBackdrop", "CancelBackdrop"],
    latePanels: ["GameSettingsPanel", "MapInfoPaneContainer"],
    handlers: {
      CancelButton: h.onCancel,
      OKButton: () => load(),
    },
    onBuild: (s) => {
      screen = s;
      // The FDF titles this screen LOAD_SINGLEPLAYER_SAVED_GAME ("Load Single-Player Saved
      // Game"); ours reads as the button that opened it does — GlobalStrings.fdf's own
      // KEY_LOAD_SAVED_GAME, "|CffffffffL|Road Saved Game", with its hotkey colour taken off.
      s.setText("LoadSavedGameTitle", stripMarkup(str("KEY_LOAD_SAVED_GAME", "Load Saved Game")));
      paint();
      void sink.list().then((all) => {
        files = all.filter((f) => f.name.toLowerCase().endsWith(SAVE_EXT));
        paint();
      });
    },
  });

  function load(): void {
    const name = picked;
    const header = name ? headers.get(name) : null;
    if (!name || !header) return;
    const why = h.refusal(header);
    if (why) {
      void showGlueDialog({ container, vfs, text: why, buttons: "ok" });
      return;
    }
    h.onLoad(name);
  }

  function paint(): void {
    const s = screen;
    if (!s) return;
    const list = s.list("ListBoxWar3");
    const scroll = list?.scrollTop ?? 0;
    const rows: ListItem[] = files.map((f) => ({
      value: f.name,
      label: bare(f.name),
      action: f.name === picked
        ? { label: str("DELETE", "Delete"), title: str("DELETE", "Delete"), svg: TRASH_SVG, onClick: () => askDelete(f.name) }
        : undefined,
    }));
    if (list) {
      list.setItems(rows);
      list.onChange = (value) => {
        picked = value;
        paint();
      };
      list.onActivate = (value) => {
        picked = value;
        void show(value).then(() => load());
      };
      if (picked) list.select(picked);
      list.scrollTop = scroll;
    }
    void show(picked);
  }

  /** The highlighted save's map — the install's own summary of it when it is an install map,
   *  else (a campaign chapter) its name — and the moment it was saved at. */
  async function show(name: string | null): Promise<void> {
    const s = screen;
    if (!s) return;
    if (!name) {
      clearMapInfo(s);
      s.setEnabled("OKButton", false);
      return;
    }
    if (!headers.has(name)) {
      const bytes = await sink.read(name).catch(() => null);
      headers.set(name, bytes ? await readSaveHeader(bytes).catch(() => null) : null);
    }
    if (picked !== name) return;
    const header = headers.get(name) ?? null;
    s.setEnabled("OKButton", !!header);
    const path = header ? replayMapPath(maps, header.map.path) : null;
    const info = path ? await readMapInfo(maps, path).catch(() => null) : null;
    if (picked !== name) return;
    if (!info || !path) {
      clearMapInfo(s);
      if (header) note(`${header.config.mapName ?? header.map.name}  |cffc0c0c0${clock(header.gameTime)}|r`);
      return;
    }
    fillMapInfo(s, info, null, minimapIcons);
    const preview = await readMapPreviewFor(vfs, maps, path).catch(() => null);
    if (picked === name && preview) fillMapInfo(s, info, preview, minimapIcons);
  }

  function note(text: string): void {
    const s = screen;
    const row = s?.frame("MapNameValue");
    if (!s || !row) return;
    row.style.display = "";
    s.setText("MapNameValue", text);
  }

  function askDelete(name: string): void {
    void showGlueDialog({
      container,
      vfs,
      buttons: "yesno",
      text: str("DELETE_MESSAGE", "Are you sure you want to delete the saved game '%s'?").replace("%s", bare(name)),
      onConfirm: () => void remove(name),
    });
  }

  async function remove(name: string): Promise<void> {
    if (!(await sink.remove(name).catch(() => false))) return;
    files = files.filter((f) => f.name !== name);
    headers.delete(name);
    if (picked === name) picked = null;
    paint();
  }
}

/** Game seconds as the in-game clock prints them (h:mm:ss / m:ss). */
function clock(secs: number): string {
  const t = Math.max(0, Math.floor(secs));
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const p = (n: number): string => String(n).padStart(2, "0");
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

/** LoadSavedGameScreen + the list box and the summary pane dropped into its two containers. */
function buildRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("LoadSavedGameScreen");
  if (!root) throw new Error("LoadSavedGameScreen.fdf: no LoadSavedGameScreen frame");
  const listBox = lib.resolveRoot("ListBoxWar3");
  if (listBox) {
    setProp(listBox, "SetAllPoints", []);
    adopt(root, "FileListFrame", [listBox]);
  }
  const pane = lib.resolveRoot("MapInfoPane");
  if (pane) adopt(root, "MapInfoPaneContainer", [layoutInfoPane(pane, { w: 0.271875, h: 0.223125, rows: SUMMARY_ROWS })]);
  nudgeX(findFrame(root, "MapInfoPaneContainer"), -widescreen(MAP_INFO_NUDGE));
  return root;
}
