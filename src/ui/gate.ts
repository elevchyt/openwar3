import { pickInstall, requestPersistence, type PickedInstall } from "../assets/opfs";
import { isDesktopApp, loadNativeInstall, pickNativeInstall, rememberedInstall } from "../assets/nativeInstall";
import { loadProfile } from "../vfs/loader";
import { REQUIRED_VERSION, wrongVersionMessage } from "../vfs/version";
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
}

/** What the bar says while the install mounts. */
const LOADING = "Loading game data…";

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
  // "Required", not "recommended": the version is a gate now (src/vfs/version.ts), and a screen
  // that suggests where the game refuses is a screen that reads as broken.
  sub.textContent = native
    ? `Select your Warcraft III (The Frozen Throne ${REQUIRED_VERSION}) folder. That version is required — every player has to be on the same game data — and it is checked at every launch. You will only be asked once: the game remembers where it is. Nothing is uploaded; your install is read from your own disk.`
    : `Select your Warcraft III (The Frozen Throne ${REQUIRED_VERSION}) folder to begin. That version is required — every player has to be on the same game data. The menu is built from the game's own files, so they're loaded first. Nothing is uploaded — your install is read locally in the browser.`;

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

  const status = document.createElement("p");
  status.className = "load-gate-status";

  const showBar = (on: boolean): void => {
    bar.root.hidden = !on;
    btn.root.hidden = on;
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
    btn.setDisabled(true);
    status.textContent = "";
    status.classList.remove("error");
    bar.set(null);
    // One line for the whole wait. The mount narrates itself stage by stage (which archive,
    // the content index, a percentage) and that is a developer's reading, not a player's: what a
    // player needs from this screen is "it is loading", then "it loaded" — or, in red, why not.
    bar.setLabel(LOADING);
    showBar(true);
    try {
      // Browser only: the desktop app reads the folder off disk and has no quota to be evicted
      // from, which is the other half of why the export is native.
      if (!native) await requestPersistence();
      // A CASC mount reads a few hundred megabytes off disk before the first file can be
      // asked for (vfs/casc.ts), so it reports as it goes rather than sitting mute — and says
      // how far through it is once it knows, which is what the bar draws.
      const load = await loadProfile(install, DEFAULT_PROFILE, (_msg, fraction) => bar.set(fraction ?? null));
      bar.set(1);
      bar.setLabel("Data successfully loaded");
      // Let the full bar and that line reach the screen and be READ first: building the menu
      // holds the main thread, and whatever frame was painted last is what the player looks at
      // until it lets go — a confirmation shown for one frame is a confirmation nobody saw.
      await new Promise((r) => setTimeout(r, 600));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
      onLoaded(load);
    } catch (err) {
      fail(`Couldn't load that folder: ${(err as Error).message}`);
    }
  };

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

  panel.append(title, sub, action, status);
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

  return {
    dispose: () => {
      unbindHotkeys();
      gate.remove();
    },
  };
}
