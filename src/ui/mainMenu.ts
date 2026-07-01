import type { AssetResolver } from "../assets/resolver";
import { pickInstall, requestPersistence } from "../assets/opfs";

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

export function mountMainMenu(root: HTMLElement, resolver: AssetResolver): void {
  const panel = document.createElement("div");
  panel.className = "menu-panel";

  const title = document.createElement("h1");
  title.className = "menu-title";
  title.textContent = "OpenWar3";
  panel.appendChild(title);

  for (const label of BUTTONS) {
    panel.appendChild(makeButton(label, () => onSelect(label)));
  }

  const quit = makeButton("Quit", () => window.close());
  quit.classList.add("menu-quit");
  panel.appendChild(quit);

  const status = document.createElement("p");
  status.className = "menu-status";
  status.textContent = resolver.hasInstall
    ? "Install loaded — authentic assets active."
    : "No install — running on placeholders. Click to import your Warcraft III folder.";
  status.onclick = async () => {
    const handle = await pickInstall();
    if (handle) {
      await requestPersistence();
      status.textContent = `Selected "${handle.name}". MPQ import lands in Phase 1.`;
    }
  };
  panel.appendChild(status);

  root.appendChild(panel);
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "menu-button";
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}

function onSelect(label: string): void {
  // TODO: wire screens as later phases land (skirmish setup, lobby, options...).
  console.log(`[OpenWar3] menu: ${label}`);
}
