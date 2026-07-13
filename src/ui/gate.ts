import { pickInstall, requestPersistence } from "../assets/opfs";
import { loadProfile } from "../vfs/loader";
import { DEFAULT_PROFILE } from "../vfs/profiles";
import type { DataSource } from "../vfs/types";

// The load-files gate (issue #54). WC3's menus are constructed from the game's own
// UI\FrameDef\*.fdf files and textures, so the install must be mounted before the
// main menu can exist. We therefore prompt for the game folder first, up front —
// a single button in the centre of the screen — and hand the mounted VFS back so
// the caller can build the FDF main menu and continue automatically.

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
  const gate = document.createElement("div");
  gate.className = "load-gate";

  const panel = document.createElement("div");
  panel.className = "load-gate-panel";

  const title = document.createElement("h1");
  title.className = "load-gate-title";
  title.textContent = "OpenWar3";

  const sub = document.createElement("p");
  sub.className = "load-gate-sub";
  sub.textContent =
    "Select your Warcraft III (TFT 1.27a) folder to begin. The menu is built from the game's own files, so they're loaded first. Nothing is uploaded — your install is read locally in the browser.";

  const btn = document.createElement("button");
  btn.className = "load-gate-btn";
  btn.textContent = "Load Game Files";

  const status = document.createElement("p");
  status.className = "load-gate-status";

  const fail = (msg: string): void => {
    status.textContent = msg;
    status.classList.add("error");
    btn.disabled = false;
    btn.textContent = "Load Game Files";
  };

  btn.onclick = async (): Promise<void> => {
    status.classList.remove("error");
    const files = await pickInstall();
    if (!files) { status.textContent = "No folder selected."; return; }
    btn.disabled = true;
    btn.textContent = "Loading…";
    status.textContent = "Mounting archives…";
    try {
      await requestPersistence();
      const load = await loadProfile(files, DEFAULT_PROFILE);
      status.textContent = `Mounted ${load.mounted.join(", ")} — ${load.fileCount.toLocaleString()} files, ${load.maps.size} maps. Building menu…`;
      onLoaded(load);
    } catch (err) {
      fail(`Couldn't load that folder: ${(err as Error).message}`);
    }
  };

  panel.append(title, sub, btn, status);
  gate.appendChild(panel);
  root.appendChild(gate);

  return { dispose: () => gate.remove() };
}
