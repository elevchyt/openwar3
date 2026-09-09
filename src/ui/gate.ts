import { pickInstall, requestPersistence, type PickedInstall } from "../assets/opfs";
import { isDesktopApp, loadNativeInstall, pickNativeInstall, rememberedInstall } from "../assets/nativeInstall";
import { loadProfile } from "../vfs/loader";
import { DEFAULT_PROFILE } from "../vfs/profiles";
import type { DataSource } from "../vfs/types";

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

export interface GateLoad {
  vfs: DataSource;
  mounted: string[];
  missing: string[];
  fileCount: number;
  /** The install's `Maps\` folder — what the Custom Game screen lists (issue #61). */
  maps: Map<string, File>;
}

export interface LoadGate {
  dispose(): void;
}

export function mountLoadGate(root: HTMLElement, onLoaded: (r: GateLoad) => void): LoadGate {
  const native = isDesktopApp();
  const gate = document.createElement("div");
  gate.className = "load-gate";

  const panel = document.createElement("div");
  panel.className = "load-gate-panel";

  const title = document.createElement("h1");
  title.className = "load-gate-title";
  title.textContent = "OpenWar3";

  const sub = document.createElement("p");
  sub.className = "load-gate-sub";
  sub.textContent = native
    ? "Select your Warcraft III (TFT 1.30.4) folder — that is the recommended version. You will only be asked once: the game remembers where it is. Nothing is uploaded; your install is read from your own disk."
    : "Select your Warcraft III (TFT 1.30.4) folder to begin — that is the recommended version. The menu is built from the game's own files, so they're loaded first. Nothing is uploaded — your install is read locally in the browser.";

  const btn = document.createElement("button");
  btn.className = "load-gate-btn";
  btn.textContent = "Load Game Files";

  const status = document.createElement("p");
  status.className = "load-gate-status";

  /** What the button says when it is not busy. The desktop app changes it once — a player who
   *  is being asked a SECOND time is choosing a folder, not loading files — so a failure has to
   *  restore this rather than the original wording. */
  let idleLabel = "Load Game Files";

  const fail = (msg: string): void => {
    status.textContent = msg;
    status.classList.add("error");
    btn.disabled = false;
    btn.textContent = idleLabel;
  };

  /** Mount whatever was picked and hand it on. Shared by both doors, because past the picking
   *  there is no difference between them: a `PickedInstall` is a `PickedInstall`. */
  const mount = async (install: PickedInstall): Promise<void> => {
    btn.disabled = true;
    btn.textContent = "Loading…";
    status.textContent = "Mounting archives…";
    try {
      // Browser only: the desktop app reads the folder off disk and has no quota to be evicted
      // from, which is the other half of why the export is native.
      if (!native) await requestPersistence();
      // A CASC mount reads a few hundred megabytes off disk before the first file can be
      // asked for (vfs/casc.ts), so it reports as it goes rather than sitting mute.
      const load = await loadProfile(install, DEFAULT_PROFILE, (msg) => { status.textContent = msg; });
      status.textContent = `Mounted ${load.mounted.join(", ")} — ${load.fileCount.toLocaleString()} files, ${load.maps.size} maps. Building menu…`;
      onLoaded(load);
    } catch (err) {
      fail(`Couldn't load that folder: ${(err as Error).message}`);
    }
  };

  btn.onclick = async (): Promise<void> => {
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

  panel.append(title, sub, btn, status);
  gate.appendChild(panel);
  root.appendChild(gate);

  // The desktop app's ordinary launch: it already knows where the install is, so nothing here is
  // ever seen — this screen exists for the first run and for the day the folder moves.
  if (native) {
    btn.disabled = true;
    void rememberedInstall().then(async ({ path, valid }) => {
      if (valid) return mount(await loadNativeInstall());
      // A remembered folder that is GONE is named. "Pick your folder again" with no reason is
      // the same screen as a first run, and the player has no way to tell that they moved it.
      if (path) idleLabel = "Choose Warcraft III Folder";
      btn.disabled = false;
      btn.textContent = idleLabel;
      if (path) fail(`Your Warcraft III folder is no longer at ${path}.`);
    });
  }

  return { dispose: () => gate.remove() };
}
