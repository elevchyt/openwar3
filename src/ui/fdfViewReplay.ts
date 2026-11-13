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
import { OW3_STRINGS, VIEW_REPLAY_OVERRIDE } from "../overrides";
import { PLAYER_COLORS } from "./hud";
import { setGameTip } from "./gameTip";

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
//
// Two things are OURS, neither having a frame in the 2003 file. Under "Number of Players" the
// highlighted replay's PLAYERS are listed out of its header (`paintPlayers`, in the box
// src/overrides/ui/ViewReplayScreen.fdf adds), grouped by team the way the loading screen does.
// And the highlighted row carries a TRASH button at its far right (the list's row action) that
// deletes the file from this machine after the game's own question, DELETE_REPLAY_MESSAGE — the
// one the score screen's Save Replay panel asks before its Delete.

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

/** The race stamps the Allies dialog and the voice plates wear beside a name (mapViewer.ts
 *  `raceSymbol`): the campaign screens' `<X>Symbol.blp`. A race the header names that is not one
 *  of the four (a custom map's own) has none. */
const RACE_SYMBOL: Record<string, string> = { human: "Human", orc: "Orc", undead: "Undead", nightelf: "NightElf" };
/** …and its name in GlobalStrings.fdf, the symbol's hover hint (the Allies dialog's too). */
const RACE_STRING: Record<string, [string, string]> = {
  human: ["HUMAN", "Human"], orc: ["ORC", "Orc"], undead: ["UNDEAD", "Undead"], nightelf: ["NIGHT_ELF", "Night Elf"],
};

/** Lucide's `trash` icon (lucide.dev, ISC licence) — the delete button on the highlighted row.
 *  Stroked in `currentColor`, so the row action's own colours (quiet, brighter on hover, red
 *  under the pointer) apply to it unchanged. */
const TRASH_SVG =
  '<svg class="ow3-row-trash" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/>' +
  '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

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
  /** Race symbols as data URLs, decoded once per visit. */
  const symbols = new Map<string, string>();
  const symbolOf = (race: string): string => {
    let url = symbols.get(race);
    if (url === undefined) {
      const c = RACE_SYMBOL[race] ? icon(`UI\\Glues\\Loading\\Backgrounds\\Campaigns\\${RACE_SYMBOL[race]}Symbol.blp`) : null;
      symbols.set(race, (url = c ? c.toDataURL() : ""));
    }
    return url;
  };
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
    overrides: [OW3_STRINGS, VIEW_REPLAY_OVERRIDE],
    buttonWidthScale: 1.35,
    hidden: paneRowsToHide(SUMMARY_ROWS),
    // The screen's panels, one per piece of chrome that carries them: the list under its
    // title on the left, the summary column on the right, and the two buttons at the bottom.
    panels: ["GameSettingsPanel", "MapInfoPaneContainer", "NumPlayersLabel", "NumPlayersValue", "ReplayPlayersBox", "OKBackdrop", "CancelBackdrop"],
    // The list and the summary are what the screen is FOR rather than furniture it arrives
    // with, so they fade up a beat after the chrome has landed (ui/fdf/anim.ts). The
    // "Number of Players" row is part of the summary — it hangs off the pane's own bottom —
    // and has to travel with it, or it appears on an empty panel a beat early.
    latePanels: ["GameSettingsPanel", "MapInfoPaneContainer", "NumPlayersLabel", "NumPlayersValue", "ReplayPlayersBox"],
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

  /** A string out of the screen's FDF library, or its English when the install lacks it. */
  function str(key: string, fallback: string): string {
    const v = strings?.string(key);
    return v && v !== key ? v : fallback;
  }

  /** Why this replay cannot be watched on this machine as it stands, or null. Said when View
   *  Replay is PRESSED, as the game does — the button stays live and the answer is a message box,
   *  never a line squeezed into the map's name row. */
  function blocked(header: ReplayHeader): string | null {
    // The game's own words, naming the file it looked for (GlobalStrings.fdf) — by its file name
    // alone, and without the blank line between its two sentences: DialogWar3's box is a fixed
    // 0.35 × 0.2 and the folder or the gap takes the message down into its OK button. The file
    // is looked for under any folder anyway (`replayMapPath`).
    if (!mapPathOf(header)) {
      return str(
        "NETERROR_CANTFINDREPLAYMAP",
        "The map file associated with the replay could not be found.|n|nPlease make sure the map file '%s' used by the recorded game exists and try again.",
      ).replace("|n|n", "|n").replace("%s", header.map.path.split(/[\\/]/).pop() ?? header.map.path);
    }
    // The two games read different object tables (data/edition.ts); a replay is a match on one.
    if ((header.edition === "roc") !== isRoc()) return `This replay was recorded on ${header.edition === "roc" ? "Reign of Chaos" : "The Frozen Throne"}.|n|nSwitch editions on the main menu to watch it.`;
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
    if (!name || !header || busy) return;
    const why = blocked(header);
    if (why) {
      void showGlueDialog({ container, vfs, text: why, buttons: "ok" });
      return;
    }
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
          run({ name, version: header.version, options: replayWindowOptions(), mapPath: mapPathOf(header) ?? undefined }, ({ received, total }) => {
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
      rows.push({
        value: f.name,
        label: `${leafName(f.name)}${other}`,
        // Only the HIGHLIGHTED row carries the trash can: a column of them down a whole folder
        // would invite a delete by a stray click on a row nobody meant to pick.
        action: f.name === picked && !busy
          ? { label: str("DELETE", "Delete"), title: str("DELETE", "Delete"), svg: TRASH_SVG, onClick: () => askDelete(f.name) }
          : undefined,
      });
    }
    if (list) {
      list.setItems(rows);
      list.onChange = (value) => {
        picked = value;
        paintRows(); // the trash can moves to the new pick
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
      paintPlayers(null);
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
    paintPlayers(header);
    s.setEnabled("OKButton", !!header && !busy);
    const info = path ? await readMapInfo(maps, path).catch(() => null) : null;
    if (picked !== name) return;
    if (!info || !path) {
      clearMapInfo(s);
      // The map this machine does not have: its name, as the replay recorded it, and nothing
      // else — View Replay says why when pressed (`blocked`).
      if (header) note(header.map.name, "ffffff");
      return;
    }
    fillMapInfo(s, info, null, minimapIcons);
    const preview = await readMapPreviewFor(vfs, maps, path).catch(() => null);
    if (picked === name && preview) fillMapInfo(s, info, preview, minimapIcons);
  }

  /**
   * The replay's players, under "Number of Players" (ReplayPlayersBox): grouped by TEAM the way
   * the loading screen groups its roster — "Team %d" (GlobalStrings TEAM_FORMAT) over each, and
   * no heading at all when everybody is on one team, which is not a team game — then the
   * replay's WATCHERS under "Observers". A row is the seat's colour, its name as the match named
   * it, and the race symbol the Allies dialog puts right after a name, with the race's name as its
   * hover. The race is the one the match ROLLED: a replay is a match already played.
   *
   * The box is a fixed height ending above the panel's border; more rows than fit scroll, under
   * the game's own scrollbar (the override gives the FRAME a SCROLLBAR, so the renderer builds it
   * a viewport — `.fdf-scroll-view` — and the bar; the rows go in the viewport).
   */
  function paintPlayers(header: ReplayHeader | null): void {
    const frame = screen?.frame("ReplayPlayersBox");
    const box = frame?.querySelector<HTMLElement>(":scope > .fdf-scroll-view") ?? frame;
    if (!frame || !box) return;
    frame.classList.add("ow3-replay-players");
    box.textContent = "";
    box.scrollTop = 0;
    // The bar shows only while the rows overrun the box, and it measures on a scroll.
    const resync = (): void => void box.dispatchEvent(new Event("scroll"));
    if (!header) return resync();
    // The type of the row above it, so the list reads as part of the same summary.
    const ref = screen?.frame("NumPlayersValue");
    if (ref) {
      const cs = getComputedStyle(ref);
      frame.style.fontFamily = cs.fontFamily;
      frame.style.fontSize = `${parseFloat(cs.fontSize) * 0.85}px`;
    }
    const teams = [...new Set(header.seats.map((x) => x.team))].sort((a, b) => a - b);
    const watchers = header.config.observers ?? [];
    const headed = teams.length > 1 || watchers.length > 0;
    const heading = (text: string): void => {
      const h = document.createElement("div");
      h.className = "ow3-replay-team";
      h.textContent = text;
      box.append(h);
    };
    const row = (name: string, color: number | undefined, race: string | null): void => {
      const r = document.createElement("div");
      r.className = "ow3-replay-player";
      const swatch = document.createElement("span");
      swatch.className = "ow3-replay-swatch";
      const hex = color !== undefined ? PLAYER_COLORS[color] : undefined;
      if (hex) swatch.style.background = hex;
      else swatch.style.visibility = "hidden";
      const label = document.createElement("span");
      label.className = "ow3-replay-name";
      label.textContent = name;
      r.append(swatch, label);
      const url = race ? symbolOf(race) : "";
      if (race && url) {
        const img = document.createElement("img");
        img.className = "ow3-replay-race";
        img.src = url;
        img.alt = "";
        const [key, english] = RACE_STRING[race] ?? [race, race];
        setGameTip(img, str(key, english));
        r.append(img);
      }
      box.append(r);
    };
    for (const team of teams) {
      if (headed) heading(str("TEAM_FORMAT", "Team %d").replace("%d", String(team + 1)));
      for (const seat of header.seats.filter((x) => x.team === team)) row(seat.name, seat.color ?? seat.player, seat.race);
    }
    if (watchers.length) {
      heading(str("OBSERVERS_TEAM", "Observers"));
      for (const w of watchers) row(w.name, undefined, null);
    }
    resync();
  }

  /** The trash can on the highlighted row: the game's own question first (DELETE_REPLAY_MESSAGE,
   *  on the menus' message box), then the file goes from this machine's replay folder. */
  function askDelete(name: string): void {
    if (busy || !sink) return;
    void showGlueDialog({
      container,
      vfs,
      buttons: "yesno",
      text: str("DELETE_REPLAY_MESSAGE", "Are you sure you want to delete the replay '%s'?").replace("%s", leafName(name)),
      onConfirm: () => void deleteReplay(name),
    });
  }

  async function deleteReplay(name: string): Promise<void> {
    const gone = await sink?.remove(name).catch(() => false);
    if (!gone) {
      void showGlueDialog({ container, vfs, buttons: "ok", text: `The replay '${leafName(name)}' could not be deleted.` });
      return;
    }
    files = files.filter((f) => f.name !== name);
    headers.delete(name);
    if (picked === name) picked = null;
    paint();
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
  const found = [...maps.keys()].find((p) => leaf(p) === leaf(recorded));
  if (found) return found;
  // 0.3.84 named a skirmish map by its DISPLAY name ("Bandit Ridge" for `(2)BanditRidge.w3x`):
  // the words alone, without the player count, the extension, spaces or case.
  const words = (p: string): string => leaf(p).replace(/^\(\d+\)/, "").replace(/\.w3[mx]$/, "").replace(/[^a-z0-9]/g, "");
  const want = words(recorded);
  return want ? [...maps.keys()].find((p) => words(p) === want) ?? null : null;
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
