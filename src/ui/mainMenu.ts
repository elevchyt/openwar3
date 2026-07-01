import type { AssetResolver } from "../assets/resolver";
import { pickInstall, requestPersistence } from "../assets/opfs";
import { loadProfile } from "../vfs/loader";
import { DEFAULT_PROFILE } from "../vfs/profiles";

// Main-menu shell (plan §10.1, §10.4). Layout/logic is our own code as HTML/CSS;
// the 3D background renders behind it. Flat skin with no assets; once an install
// is imported (Phase 1) layout switches to derive from MainMenu.fdf for fidelity.
//
// Button set per §10.1 — note "Battle.net" is intentionally renamed "Online":
// OpenWar3 multiplayer targets our own server, not Blizzard's Battle.net.
const BUTTONS = [
  "Single Player",
  "Online",
  "Local Area Network",
  "Options",
  "Credits",
] as const;

export interface MenuHandlers {
  /** Start the Single Player flow (map picker → game-setup lobby). */
  onSinglePlayer?: () => void;
}

export function mountMainMenu(
  root: HTMLElement,
  resolver: AssetResolver,
  handlers: MenuHandlers = {},
): void {
  const panel = document.createElement("div");
  panel.className = "menu-panel";

  const title = document.createElement("h1");
  title.className = "menu-title";
  title.textContent = "OpenWar3";
  panel.appendChild(title);

  const status = document.createElement("p");
  status.className = "menu-status";
  status.textContent = resolver.hasInstall
    ? "Install loaded — authentic assets active."
    : "No install — flying placeholder terrain (WASD / drag / wheel). Click to import your Warcraft III folder.";

  for (const label of BUTTONS) {
    panel.appendChild(
      makeButton(label, () => onSelect(label, handlers, status)),
    );
  }

  const quit = makeButton("Quit", () => window.close());
  quit.classList.add("menu-quit");
  panel.appendChild(quit);

  status.onclick = () => importInstall(resolver, status);
  panel.appendChild(status);

  root.appendChild(panel);
}

async function importInstall(resolver: AssetResolver, status: HTMLElement): Promise<void> {
  const files = await pickInstall();
  if (!files) return;
  status.textContent = "Loading archives…";
  try {
    await requestPersistence();
    const { vfs, mounted, missing, fileCount } = await loadProfile(files, DEFAULT_PROFILE);
    resolver.setInstall(vfs);
    // Expose the mounted VFS so files can be enumerated/extracted by path from
    // the console — the Phase 1 exit criterion (plan §1).
    ((window as unknown as { openwar3: Record<string, unknown> }).openwar3 ??= {}).vfs = vfs;
    status.textContent =
      `${DEFAULT_PROFILE.name}: mounted ${mounted.join(", ")}` +
      (missing.length ? ` — missing ${missing.join(", ")}` : "") +
      ` — ${fileCount.toLocaleString()} files. Try openwar3.vfs.list() in the console.`;
  } catch (err) {
    status.textContent = `Import failed: ${(err as Error).message}`;
  }
}

function onSelect(label: string, handlers: MenuHandlers, _status: HTMLElement): void {
  // Single Player opens the map picker → game-setup lobby (Phase 5.5). Other
  // screens (Online lobby, Options...) arrive with later phases.
  if (label === "Single Player" && handlers.onSinglePlayer) {
    handlers.onSinglePlayer();
    return;
  }
  console.log(`[OpenWar3] menu: ${label}`);
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "menu-button";
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}
