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

/** Fog-of-war start mode chosen in the lobby:
 *   • explored   — whole map begins dimmed grey (terrain memory), live fog still on
 *   • unexplored — normal WC3 fog: unseen ground is pitch black
 *   • revealall  — no fog of war at all; the entire map + every unit stays visible */
export type FogMode = "explored" | "unexplored" | "revealall";

export interface MeleeConfig {
  slots: SlotConfig[];
  fog: FogMode; // fog-of-war start mode; default "explored"
}

const CONTROLLERS: Array<[Controller, string]> = [
  ["user", "You"],
  ["computer", "Computer"],
  ["open", "Open"],
  ["closed", "Closed"],
];

const FOG_MODES: Array<[FogMode, string]> = [
  ["explored", "Explored (dimmed, fog on)"],
  ["unexplored", "Unexplored (black fog)"],
  ["revealall", "Reveal all (no fog)"],
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

  // A custom map runs its OWN script rather than the melee setup (Phase 7 — the triggers
  // do execute now), so it spawns no starting base: the map decides what the player gets.
  if (!info.isMelee) {
    const note = document.createElement("p");
    note.className = "lobby-meta";
    note.style.opacity = "0.7";
    note.textContent = info.fixedPlayerSettings
      ? "Custom map: it runs its own triggers, and it fixes the races and teams itself."
      : "Custom map: it runs its own triggers instead of the melee setup, so no starting base is spawned.";
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
    // The team comes from the MAP when the map says so (w3i "use custom forces" → PlayerSlot
    // .team); otherwise every slot opens on its own team, which is the melee free-for-all.
    // Getting this wrong is not cosmetic: the lobby's teams are what seed the sim's unit
    // teams and the alliance matrix, so inventing `slot.id + 1` for a co-op map made the
    // other players' units ENEMIES — on WarChasers, three allied wisps with red health bars,
    // while the map's own config() had just allied all four of them on team 0.
    const teams = new Set(info.slots.map((s) => s.team));
    const team = makeSelect(
      [...teams].sort((a, b) => a - b).map((t) => [String(t + 1), `Team ${t + 1}`] as [string, string]),
      String(slot.team + 1),
    );
    // "Fixed player settings" (w3i 0x0020): the map dictates race and team; the lobby's job
    // is only to seat players. Show them, don't let them be contradicted.
    if (info.fixedPlayerSettings) {
      race.disabled = true;
      team.disabled = true;
    }

    row.append(label, controller, race, team);
    table.appendChild(row);
    rows.push({ slot, controller, race, team });
  });
  panel.appendChild(table);

  // Fog-of-war start mode (default "explored": whole map dimmed grey but fog still on).
  const options = document.createElement("div");
  options.className = "lobby-options";
  const fogLabel = document.createElement("span");
  fogLabel.className = "lobby-label";
  fogLabel.textContent = "Fog of war";
  const fog = makeSelect(FOG_MODES, "explored");
  options.append(fogLabel, fog);
  panel.appendChild(options);

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
        fog: fog.value as FogMode,
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
