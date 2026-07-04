import { RACES, RACE_LABEL, type Race } from "../data/races";
import type { MapInfo, PlayerSlot } from "../world/mapInfo";

// Melee game-setup screen (plan Phase 5.5). Placeholder DOM UI: player slots with
// controller / race / team, over the map info. Produces a MeleeConfig consumed by
// the melee initializer (spawns each race's starting units at start locations).

export type Controller = "user" | "computer" | "open" | "closed";

export interface SlotConfig {
  id: number;
  controller: Controller;
  race: Race;
  team: number;
  startX: number;
  startY: number;
}

export interface MeleeConfig {
  slots: SlotConfig[];
}

const CONTROLLERS: Array<[Controller, string]> = [
  ["user", "You"],
  ["computer", "Computer"],
  ["open", "Open"],
  ["closed", "Closed"],
];

export function showLobby(
  root: HTMLElement,
  info: MapInfo,
  cb: { onStart: (config: MeleeConfig) => void; onCancel: () => void },
): () => void {
  const overlay = document.createElement("div");
  overlay.className = "lobby";
  const panel = document.createElement("div");
  panel.className = "lobby-panel";
  overlay.appendChild(panel);

  const title = document.createElement("h2");
  title.className = "lobby-title";
  title.textContent = info.name;
  panel.appendChild(title);

  const meta = document.createElement("p");
  meta.className = "lobby-meta";
  const kind = info.isMelee ? "Melee" : "Custom";
  meta.textContent =
    `${kind} · ${info.slots.length} players · ${info.width}×${info.height} · tileset ${info.tileset || "?"}` +
    (info.recommendedPlayers ? ` · suggested: ${info.recommendedPlayers}` : "");
  panel.appendChild(meta);

  // Custom maps set up their game from triggers we don't execute yet (Phase 7),
  // so warn that this loads the terrain/units without the map's own game logic.
  if (!info.isMelee) {
    const note = document.createElement("p");
    note.className = "lobby-meta";
    note.style.opacity = "0.7";
    note.textContent = "Custom map: triggers aren't run yet — melee setup is skipped, so no starting base is spawned.";
    panel.appendChild(note);
  }

  const rows: Array<{ slot: PlayerSlot; controller: HTMLSelectElement; race: HTMLSelectElement; team: HTMLSelectElement }> = [];
  const table = document.createElement("div");
  table.className = "lobby-slots";
  info.slots.forEach((slot, idx) => {
    const row = document.createElement("div");
    row.className = "lobby-row";

    const label = document.createElement("span");
    label.className = "lobby-label";
    label.textContent = `Player ${slot.id + 1}`;

    const controller = makeSelect(CONTROLLERS, idx === 0 ? "user" : "computer");
    const race = makeSelect(RACES.map((r) => [r, RACE_LABEL[r]] as [string, string]), slot.defaultRace);
    const team = makeSelect(
      info.slots.map((_, i) => [String(i + 1), `Team ${i + 1}`] as [string, string]),
      String(slot.id + 1),
    );

    row.append(label, controller, race, team);
    table.appendChild(row);
    rows.push({ slot, controller, race, team });
  });
  panel.appendChild(table);

  const actions = document.createElement("div");
  actions.className = "lobby-actions";
  actions.append(
    makeButton("Start Game", () => {
      cb.onStart({
        slots: rows
          .filter((r) => r.controller.value === "user" || r.controller.value === "computer")
          .map((r) => ({
            id: r.slot.id,
            controller: r.controller.value as Controller,
            race: r.race.value as Race,
            team: parseInt(r.team.value, 10),
            startX: r.slot.startX,
            startY: r.slot.startY,
          })),
      });
    }),
    makeButton("Cancel", () => cb.onCancel()),
  );
  panel.appendChild(actions);

  root.appendChild(overlay);
  return () => overlay.remove();
}

function makeSelect(options: Array<[string, string]>, value: string): HTMLSelectElement {
  const el = document.createElement("select");
  el.className = "lobby-select";
  for (const [v, label] of options) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = label;
    if (v === value) opt.selected = true;
    el.appendChild(opt);
  }
  return el;
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "menu-button";
  el.textContent = label;
  el.onclick = onClick;
  return el;
}
