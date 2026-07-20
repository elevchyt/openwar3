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
  /** In a LAN game, the relay peer sitting in this slot (src/net/protocol.ts). Absent in a
   *  single-player match, and absent on a computer slot in any match. */
  peer?: number;
}

/** Fog-of-war start mode chosen in the lobby:
 *   • explored   — whole map begins dimmed grey (terrain memory), live fog still on
 *   • unexplored — normal WC3 fog: unseen ground is pitch black
 *   • revealall  — no fog of war at all; the entire map + every unit stays visible */
export type FogMode = "explored" | "unexplored" | "revealall";

export interface MeleeConfig {
  slots: SlotConfig[];
  fog: FogMode; // fog-of-war start mode; default "explored"
  /** The match's RNG seed. Everything the sim rolls — damage dice, crits, evasion, item
   *  drops, summon scatter — comes off this one number, so it is part of the match's
   *  identity rather than of any one machine's: a replay needs it to replay, and in a LAN
   *  game the host picks it and every client is told (docs/multiplayer.md). Omitted means
   *  "roll one" — only single-player setup may leave it out. */
  seed?: number;
  /**
   * Which slot THIS MACHINE plays — the one whose units it selects and whose sight lifts its
   * fog. Omitted means "the first `user` slot", which is the whole answer in single player
   * because there is only one.
   *
   * A LAN match is the case that needs it stated: every client is handed the SAME config (it
   * is the match's identity, not one machine's) and every human slot in it says `user`, so
   * "the first user slot" would point all of them at the same player. Each client sets this
   * from the slot holding its own peer id instead. See docs/multiplayer.md.
   */
  localPlayer?: number;
}
