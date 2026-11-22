import { pickInstall, requestPersistence, type PickedInstall } from "../assets/opfs";
import {
  downloadInstall, gameFilesSources, gb, storedInstall, type DownloadProgress, type GameFilesSource,
} from "../assets/downloadInstall";
import { cancelNativeDownload, downloadNativeInstall, isDesktopApp, loadNativeInstall, pickNativeInstall, rememberedInstall } from "../assets/nativeInstall";
import { loadProfile } from "../vfs/loader";
import { RECOMMENDED_INSTALL, wrongVersionMessage } from "../vfs/version";
import { DEFAULT_PROFILE } from "../vfs/profiles";
import type { DataSource } from "../vfs/types";
import { bindHotkeys, createGlueButton, createPanel, createProgressBar } from "@openwar3/ui/dom";

// The load-files gate (issue #54). WC3's menus are constructed from the game's own
// UI\FrameDef\*.fdf files and textures, so the install must be mounted before the
// main menu can exist. We therefore prompt for the game folder first, up front —
// a single button in the centre of the screen — and hand the mounted VFS back so
// the caller can build the FDF main menu and continue automatically.
//
// The DESKTOP app asks once and then never again (src/assets/nativeInstall.ts): the folder is
// remembered by the shell, so a launch that already knows where it is puts up nothing to press
// and goes straight to the menu. That is a real difference in kind, not a saved click — a game
// you install does not ask you where it is every time you start it. What is left of this screen
// there is the FIRST run, and the day the folder moves.
//
// There are no FrameDef files to build THIS screen from — it is what reads them — so it is dressed
// in the shared UI kit instead (packages/ui, the same glue button, Human panel and loading bar the
// landing page wears), drawn from scratch with colours sampled off the install's own BLPs.

export interface GateLoad {
  vfs: DataSource;
  mounted: string[];
  missing: string[];
  fileCount: number;
  /** The install's `Maps\` folder — what the Custom Game screen lists (issue #61). */
  maps: Map<string, File>;
  /** Which game files this is, as a replay's header names it (vfs/loader.ts). */
  flavour: string;
}

/** What the bar says while the install mounts. */
const LOADING = "Loading game data…";

/** How the mount's stages share the one bar (see `mount`). The index is read before anything has
 *  a size — the encoding and root files, a few tens of megabytes against the preload's ~291 —
 *  and the last sliver past LOADED_SHARE is the work after the preload (deriving icons) that the
 *  bar's own fill to 1 announces. Ours, not the game's: 1.30.4's own bar is the loading screen's. */
const INDEX_SHARE = 0.1;
const LOADED_SHARE = 0.97;
/** The index stage's creep: ~63 % of its share after this long, never all of it. */
const INDEX_CREEP_MS = 1500;

export interface LoadGate {
  dispose(): void;
}

export function mountLoadGate(root: HTMLElement, onLoaded: (r: GateLoad) => void): LoadGate {
  const native = isDesktopApp();
  const gate = document.createElement("div");
  gate.className = "load-gate";

  const panel = createPanel("div", "load-gate-panel");

  const title = document.createElement("h1");
  title.className = "ow3-heading load-gate-title";
  title.textContent = "OpenWar3";

  const sub = document.createElement("p");
  sub.className = "load-gate-sub";
  // Any classic Warcraft III will do (issue #319): the mount brings every build's game data to
  // the same patch (src/vfs/normalize.ts), so what is NAMED here is the one a player can still
  // get — the Legacy install Battle.net offers to everybody who owns the game.
  sub.textContent = native
    ? `Select your Warcraft III folder. We recommend ${RECOMMENDED_INSTALL}; any classic install up to 1.31.1 with The Frozen Throne works, and its game data is brought to the current patch for you. You will only be asked once: the game remembers where it is. Nothing is uploaded; your install is read from your own disk.`
    : `Select your Warcraft III folder to begin. We recommend ${RECOMMENDED_INSTALL}; any classic install up to 1.31.1 with The Frozen Throne works, and its game data is brought to the current patch for you. The menu is built from the game's own files, so they're loaded first. Nothing is uploaded — your install is read locally in the browser.`;

  /** What the button says when it is not busy. The desktop app changes it once — a player who
   *  is being asked a SECOND time is choosing a folder, not loading files — so a failure has to
   *  restore this rather than the original wording. */
  let idleLabel = "Load Game Files";
  const btn = createGlueButton({ label: idleLabel, hotkey: "L", size: "lg", bordered: true });

  // The bar takes the button's place while the install mounts: there is nothing left to press,
  // and the mount is the one wait on this screen worth watching.
  const bar = createProgressBar({ scale: 1.5 });
  bar.root.classList.add("load-gate-progress");
  bar.root.hidden = true;

  const action = document.createElement("div");
  action.className = "load-gate-action";
  action.append(btn.root, bar.root);

  // A live region: the errors ("wrong folder" and the like) are read out as they appear (issue #310).
  const status = document.createElement("p");
  status.className = "load-gate-status";
  status.setAttribute("role", "status");

  // "Download game files": the player's OWN install, zipped and kept somewhere they can reach from
  // a new machine (src/assets/downloadInstall.ts). A link under the button rather than a second
  // button beside it — picking the folder is still THE way in, and this is for the player who
  // has no folder on this machine to pick. The press IS the start: it goes straight down the
  // link the game ships with (GAME_FILES_LINK) into the bar below, Cancel under it.
  const downloadable = native || !!navigator.storage?.getDirectory;
  const dlToggle = document.createElement("button");
  dlToggle.type = "button";
  dlToggle.className = "load-gate-link";
  dlToggle.textContent = "Download game files";
  dlToggle.hidden = !downloadable;

  const dlCancel = document.createElement("button");
  dlCancel.type = "button";
  dlCancel.className = "load-gate-link load-gate-cancel";
  dlCancel.textContent = "Cancel";
  dlCancel.hidden = true;

  /** `cancelable` puts the Cancel link under the bar: the download's, and the mount's too — a
   *  player watching "Loading game data…" may have realised it is the WRONG folder (or the desktop
   *  app went straight into the one it remembered), and the way out is back to this screen's
   *  choice, not a wait for a menu they did not want. */
  const showBar = (on: boolean, cancelable = false): void => {
    bar.root.hidden = !on;
    btn.root.hidden = on;
    dlToggle.hidden = on || !downloadable;
    dlCancel.hidden = !on || !cancelable;
  };

  const fail = (msg: string): void => {
    showBar(false);
    status.textContent = msg;
    status.classList.add("error");
    btn.setDisabled(false);
    btn.setLabel(idleLabel);
  };

  /** Mount whatever was picked and hand it on. Shared by both doors, because past the picking
   *  there is no difference between them: a `PickedInstall` is a `PickedInstall`. */
  const mount = async (install: PickedInstall): Promise<void> => {
    // A mount cannot be stopped part-way (the CASC index is read in one go, vfs/casc.ts), so
    // Cancel ABANDONS it instead: every await below asks whether it is still the current one,
    // and one that is not hands nothing on — what it read is dropped with it.
    const gen = ++mountGen;
    const stale = (): boolean => gen !== mountGen;
    mounting = true;
    btn.setDisabled(true);
    status.textContent = "";
    status.classList.remove("error");
    bar.set(0);
    // One line for the whole wait. The mount narrates itself stage by stage (which archive,
    // the content index, a percentage) and that is a developer's reading, not a player's: what a
    // player needs from this screen is "it is loading", then "it loaded" — or, in red, why not.
    bar.setLabel(LOADING);
    showBar(true, true);
    try {
      // Browser only: the desktop app reads the folder off disk and has no quota to be evicted
      // from, which is the other half of why the export is native.
      if (!native) await requestPersistence();
      if (stale()) return;
      // ONE bar for the whole load, and it only ever moves forward. The mount is stages (vfs/casc.ts:
      // the content index, then the ~291 MB preload, then "Preparing icons…"), and only the
      // preload knows how far through it is — drawn stage by stage, the bar swept the hole while
      // the index was read, then dropped to empty and started again: a bar that went BACK, which
      // reads as "it started over". So the stages share it instead: the index takes the first
      // INDEX_SHARE, which it CREEPS toward on the clock (it has no number to report, and a bar
      // standing at zero reads as hung), the preload maps onto the rest, and the high-water mark
      // means a report that would move it backwards is simply not drawn.
      let shown = 0;
      const advance = (f: number): void => {
        if (stale() || f <= shown) return;
        shown = Math.min(1, f);
        bar.set(shown);
      };
      const crept = performance.now();
      const creep = window.setInterval(
        () => advance(INDEX_SHARE * (1 - Math.exp(-(performance.now() - crept) / INDEX_CREEP_MS))),
        100,
      );
      let load: Awaited<ReturnType<typeof loadProfile>>;
      try {
        load = await loadProfile(install, DEFAULT_PROFILE, (_msg, fraction) => {
          if (fraction == null) return;
          window.clearInterval(creep);
          advance(INDEX_SHARE + (LOADED_SHARE - INDEX_SHARE) * fraction);
        });
      } finally {
        window.clearInterval(creep);
      }
      if (stale()) return;
      // Past here it has loaded, and there is nothing left to cancel.
      mounting = false;
      dlCancel.hidden = true;
      bar.set(1);
      bar.setLabel("Data successfully loaded");
      // Let the full bar and that line reach the screen and be READ first: building the menu
      // holds the main thread, and whatever frame was painted last is what the player looks at
      // until it lets go — a confirmation shown for one frame is a confirmation nobody saw.
      await new Promise((r) => setTimeout(r, 600));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
      if (stale()) return;
      onLoaded(load);
    } catch (err) {
      if (stale()) return;
      mounting = false;
      fail(`Couldn't load that folder: ${(err as Error).message}`);
    }
  };

  /** The browser half's abort; the desktop half's lives in the shell (electron/download.mjs).
   *  `dlCancelled` is the press of Cancel, which tells an abort apart from a failure. */
  let dlAbort: AbortController | null = null;
  let dlCancelled = false;
  /** The mount in flight, if any, and its generation: Cancel bumps the number, which is how a
   *  mount still reading in the background learns it was abandoned. */
  let mounting = false;
  let mountGen = 0;

  const cancelled = (): void => {
    if (mounting) {
      mountGen++;
      mounting = false;
      // Back to the choice this screen exists for. On the desktop the button now picks a folder
      // (the shell's dialog), so it says so, as it does for a remembered folder that failed.
      if (native) idleLabel = "Choose Warcraft III Folder";
      showBar(false);
      // The screen as it was before the load, with nothing to say about it: the player chose this.
      status.classList.remove("error");
      status.textContent = "";
      btn.setDisabled(false);
      btn.setLabel(idleLabel);
      return;
    }
    dlCancelled = true;
    dlAbort?.abort();
    void cancelNativeDownload();
  };

  const download = async (): Promise<void> => {
    // The Drive install first, the Internet Archive behind it (src/assets/downloadInstall.ts).
    const sources = gameFilesSources();
    dlCancelled = false;
    btn.setDisabled(true);
    status.textContent = "";
    status.classList.remove("error");
    bar.set(0);
    bar.setLabel("Connecting…");
    showBar(true, true);
    /** Which source the bytes are coming from — said only once it is a mirror, since the
     *  primary is the ordinary case and needs no name on the bar. */
    let from = "";
    const onSource = (source: GameFilesSource, index: number): void => {
      from = index > 0 ? ` from ${source.name}` : "";
      if (index > 0) bar.setLabel(`Trying ${source.name}…`);
    };
    const progress = (p: DownloadProgress): void => {
      bar.set(p.fraction);
      bar.setLabel(`Downloading game files${from}… ${gb(p.received)} of ${gb(p.total)}`);
    };
    try {
      if (native) {
        // The shell asks where to put it before a byte moves, and its own dialog cannot be
        // cancelled from here — only the transfer itself can, once it has started. It walks the
        // same sources in the same order, and says which one it is on through the progress.
        const folder = await downloadNativeInstall(sources, (p) => {
          if (p.source !== undefined) onSource(sources[p.source], p.source);
          progress(p);
        });
        if (!folder) {
          showBar(false);
          btn.setDisabled(false);
          // A press of Cancel leaves nothing to say: the player chose it.
          status.textContent = dlCancelled ? "" : "No folder chosen.";
          return;
        }
        return mount(await loadNativeInstall());
      }
      dlAbort = new AbortController();
      await downloadInstall(sources, progress, dlAbort.signal, onSource);
      const install = await storedInstall();
      if (!install) throw new Error("the files did not arrive whole.");
      return mount(install);
    } catch (err) {
      if (dlCancelled) {
        showBar(false);
        btn.setDisabled(false);
        status.textContent = "";
        return;
      }
      // An IPC rejection arrives wrapped in Electron's own words around the shell's message.
      const msg = (err as Error).message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
      fail(`Couldn't download the game files: ${msg}`);
    } finally {
      dlAbort = null;
    }
  };

  dlToggle.onclick = (): void => void download();
  dlCancel.onclick = (): void => cancelled();

  btn.button.onclick = async (): Promise<void> => {
    status.classList.remove("error");
    if (native) {
      // The shell's own folder dialog, and it refuses a folder that is not an install before
      // anything is mounted — so "that is not it" arrives at the moment of choosing.
      const path = await pickNativeInstall();
      if (!path) { status.textContent = "No Warcraft III folder selected."; return; }
      return mount(await loadNativeInstall());
    }
    const install = await pickInstall();
    if (!install) { status.textContent = "No folder selected."; return; }
    return mount(install);
  };

  panel.append(title, sub, action, dlToggle, dlCancel, status);
  gate.appendChild(panel);
  root.appendChild(gate);
  const unbindHotkeys = bindHotkeys(gate);

  // The desktop app's ordinary launch: it already knows where the install is, so nothing here is
  // ever seen — this screen exists for the first run and for the day the folder moves.
  if (native) {
    btn.setDisabled(true);
    void rememberedInstall().then(async ({ path, valid, present, version }) => {
      if (valid) return mount(await loadNativeInstall());
      // A remembered folder that cannot be used is NAMED, and named for the right reason:
      // "pick your folder again" with no explanation is the same screen as a first run, and a
      // folder that is still exactly where it was but has been PATCHED is not a folder that
      // moved. The game checks the version at every launch (src/vfs/version.ts), so this is the
      // screen a player who updated Warcraft III between sessions arrives at.
      if (path) idleLabel = "Choose Warcraft III Folder";
      btn.setDisabled(false);
      btn.setLabel(idleLabel);
      if (path && !present) fail(`Your Warcraft III folder is no longer at ${path}.`);
      else if (path) fail(wrongVersionMessage(version));
    });
  }

  // The browser's twin of that: a copy an earlier "Download game files" left in this origin's
  // storage is this browser's install, so it is mounted without asking — the same as the desktop
  // app's remembered folder, and for the same reason.
  if (!native && downloadable) {
    btn.setDisabled(true);
    void storedInstall().then((install) => {
      if (install) return mount(install);
      btn.setDisabled(false);
    });
  }

  return {
    dispose: () => {
      unbindHotkeys();
      gate.remove();
    },
  };
}
