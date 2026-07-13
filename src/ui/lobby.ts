import type { Race } from "../data/races";

// The game-setup config: what the Custom Game screen (ui/fdfSkirmish.ts) produces and the
// melee initializer consumes (render/mapViewer.ts — it spawns each race's starting units at
// the map's start locations).
//
// This used to also hold a hand-authored DOM lobby. It doesn't any more: the setup screen
// is now built from the game's own UI\FrameDef\Glue\Skirmish.fdf like every other menu
// (issue #61), so all that is left here is the contract between it and the sim.

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
