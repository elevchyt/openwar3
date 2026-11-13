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
import { isRoc } from "../data/edition";
import { replayWindowOptions } from "../data/options";
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
declare const __OW3_SIM_FINGERPRINT__: string;

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
  /** A download is under way: the list still browses, but nothing else is started. */
  let busy = false;
  /** Which `readHeaders` pass is current — a folder change starts a new one. */
  let reading = 0;
  const bundles = new Map<string, Promise<{ size: number; usable: boolean } | null>>();

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

  /** Does this build simulate the way the one that recorded `header` did? The same release does;
   *  so does a different one with the same SIM FINGERPRINT (tools/sim-fingerprint.mjs) — most
   *  releases change the menus or the renderer and leave the match alone. */
  function sameSim(header: ReplayHeader): boolean {
    return header.version === __OW3_VERSION__ || (!!header.fingerprint && header.fingerprint === __OW3_SIM_FINGERPRINT__);
  }

  /** Why this replay cannot be watched on this machine as it stands, or null. */
  function blocked(header: ReplayHeader): string | null {
    if (!mapPathOf(header)) return `${header.map.name} — not installed`;
    // The two games read different object tables (data/edition.ts); a replay is a match on one.
    if ((header.edition === "roc") !== isRoc()) return `Recorded on ${header.edition === "roc" ? "Reign of Chaos" : "The Frozen Throne"} — switch editions to watch`;
    return null;
  }

  /** That version's replay files, as the shell reports them (once per version, per visit). */
  function bundleOf(version: string): Promise<{ size: number; usable: boolean } | null> {
    let info = bundles.get(version);
    if (!info) bundles.set(version, (info = sink?.bundleInfo ? sink.bundleInfo(version).catch(() => null) : Promise.resolve(null)));
    return info;
  }

  function megabytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /** A line in the summary's name row, in place of the map's name. */
  function note(text: string, colour = "ff8080"): void {
    const s = screen;
    const row = s?.frame("MapNameValue");
    if (!s || !row) return;
    row.style.display = "";
    s.setText("MapNameValue", `|cff${colour}${text}|r`);
  }

  function watch(): void {
    const name = picked;
    const header = name && !name.startsWith(FOLDER) ? headers.get(name) : null;
    if (!name || !header || busy || blocked(header)) return;
    if (sameSim(header)) return h.onView(name);
    void watchOther(name, header);
  }

  /**
   * A replay this build may not play back exactly (issue #158, docs/replays.md "Versions"). The
   * desktop app watches it IN THE VERSION THAT RECORDED IT: that version's replay files are
   * downloaded (a few megabytes, deleted again when the replay is closed) and opened in a window
   * of their own, with this player's options. Where that cannot be done — no desktop app, a
   * version that published none, no connection — it is the game's own question instead: play it
   * on this build, "ignoring recorded checksums", and let the state checks say how far it held.
   */
  async function watchOther(name: string, header: ReplayHeader): Promise<void> {
    const str = (key: string, fallback: string): string => {
      const v = strings?.string(key);
      return v && v !== key ? v : fallback;
    };
    const info = await bundleOf(header.version);
    if (picked !== name) return;
    if (info && !info.usable) {
      void showGlueDialog({ container, vfs, buttons: "ok", text: `This replay was recorded on OpenWar3 ${header.version}. Update OpenWar3 to watch it.` });
      return;
    }
    if (info && sink?.watchVersion) {
      const run = sink.watchVersion;
      void showGlueDialog({
        container,
        vfs,
        buttons: "yesno",
        text: `This replay was recorded on OpenWar3 ${header.version}.|nDownload that version's replay files (${megabytes(info.size)}) to watch it exactly as it was played? They are removed again when the replay is closed.`,
        onConfirm: () => {
          busy = true;
          screen?.setEnabled("OKButton", false);
          // The wait, on the menus' own message box: its text is the progress, and its OK only
          // puts the box away — the download carries on and the replay opens when it is in.
          const text = (line: string): string => `Downloading the replay files of OpenWar3 ${header.version}…|n|n${line}`;
          const box = showGlueDialog({ container, vfs, buttons: "ok", text: text("0%") });
          const say = (line: string): void => void box.then((b) => {
            const el = b.frame("DialogText");
            if (el) el.innerText = text(line).replace(/\|n/g, "\n");
          });
          run({ name, version: header.version, options: replayWindowOptions() }, ({ received, total }) => {
            say(`${Math.round((received / Math.max(1, total)) * 100)}% of ${megabytes(total)}`);
          }).then(
            () => {
              busy = false;
              void box.then((b) => b.close());
              void show(picked);
            },
            (err: unknown) => {
              busy = false;
              say(String((err as Error)?.message ?? err));
              void show(picked);
            },
          );
        },
      });
      return;
    }
    // Recorded by another OpenWar3, and no way to run that one: asked first, in the game's own
    // words for its own case (GlobalStrings REPLAY_CONFIRM*). The game's two rows are NET
    // VERSION and BUILD; ours has one number, the release, so the BUILD pair says it.
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
    paintRows();
    void show(picked);
    void readHeaders();
  }

  /** The list's rows alone — repainted as headers come in, keeping the scroll and the pick. */
  function paintRows(): void {
    const s = screen;
    if (!s) return;
    const list = s.list("ListBoxWar3");
    const scroll = list?.scrollTop ?? 0;
    const here = files.filter((f) => inFolder(f.name) === cwd);
    const rows: ListItem[] = [];
    if (cwd) rows.push({ value: FOLDER, label: strings?.string("UP_ONE_LEVEL") ?? "(up one level)", icon: upIcon });
    else if (files.some((f) => inFolder(f.name) === AUTOSAVED)) rows.push({ value: FOLDER + AUTOSAVED, label: AUTOSAVED, icon: folderIcon });
    for (const f of here) {
      // A replay from an OpenWar3 that simulates differently says which, in grey after its
      // name: it is the one that needs that version's files to be watched exactly.
      const header = headers.get(f.name);
      const other = header && !sameSim(header) ? `  |cff808080OpenWar3 ${header.version}|r` : "";
      rows.push({ value: f.name, label: `${leafName(f.name)}${other}` });
    }
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
      list.scrollTop = scroll;
    }
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
    const why = header ? blocked(header) : null;
    // The players who PLAYED it — the seats, never the watchers.
    s.setText("NumPlayersValue", header ? String(header.seats.length) : "");
    s.setEnabled("OKButton", !!header && !why && !busy);
    const info = path ? await readMapInfo(maps, path).catch(() => null) : null;
    if (picked !== name) return;
    if (!info || !path || why) {
      clearMapInfo(s);
      // Not watchable here, and why — said in the name row, where the map's name would be.
      if (why) note(why);
      return;
    }
    fillMapInfo(s, info, null, minimapIcons);
    const preview = await readMapPreviewFor(vfs, maps, path).catch(() => null);
    if (picked === name && preview) fillMapInfo(s, info, preview, minimapIcons);
  }

  /** Read the headers of the folder on show, a few at a time, so the rows can say which replays
   *  are another version's. Only the header is inflated (game/replay.ts `readReplayHeader`). */
  async function readHeaders(): Promise<void> {
    const mine = ++reading;
    for (const f of files.filter((x) => inFolder(x.name) === cwd)) {
      if (headers.has(f.name)) continue;
      const bytes = await sink?.read(f.name).catch(() => null);
      if (mine !== reading) return;
      const header = bytes ? await readReplayHeader(bytes).then((r) => r.header).catch(() => null) : null;
      headers.set(f.name, header);
      if (header && !sameSim(header)) paintRows();
    }
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
