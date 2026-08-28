import type { Race } from "../data/races";

// The game-setup config: what the Custom Game screen (ui/fdfSkirmish.ts) produces and the
// melee initializer consumes (render/mapViewer.ts — it spawns each race's starting units at
// the map's start locations).
//
// This used to also hold a hand-authored DOM lobby. It doesn't any more: the setup screen
// is now built from the game's own UI\FrameDef\Glue\Skirmish.fdf like every other menu
// (issue #61), so all that is left here is the contract between it and the sim.

/** Who is at the wheel of a slot. `open`/`closed` are lobby states (an empty seat a joiner
 *  drops into, and one the host took off the table); `neutral`/`rescuable` are the MAP's, for
 *  the players it declares that no lobby ever seats — see MapInfo.neutralPlayers. */
export type Controller = "user" | "computer" | "open" | "closed" | "neutral" | "rescuable";

export interface SlotConfig {
  id: number;
  controller: Controller;
  race: Race;
  team: number;
  startX: number;
  startY: number;
  /** The MAP's own name for this slot (w3i player record), when it has one. A campaign map
   *  names every side it fields — "Illidan's Naga", "Wild Mur'guls", "Night Elf Villagers" —
   *  and that name is what the owner line of a hover tooltip reads, exactly as in WC3. Absent
   *  on a melee map, where a slot is named after whoever sits in it. */
  name?: string;
  /**
   * WHO is in the seat — the human's own name, as they typed it on the LAN screen or as the
   * profile saved it. Distinct from `name`, which is what the MAP calls the side: on Rise of
   * the Naga slot 0 is "Watchers" and the person playing it is you.
   *
   * It is here for the LOADING SCREEN, which is the one screen that lists the players by name
   * (issue #78) — `UI\FrameDef\Glue\Loading.fdf`'s `LoadingPlayerSlotName`. Absent on a
   * computer slot and on everything the map owns, which are named by what they are.
   */
  playerName?: string;
  /** In a LAN game, the relay peer sitting in this slot (src/net/protocol.ts). Absent in a
   *  single-player match, and absent on a computer slot in any match. */
  peer?: number;
  /**
   * WHICH computer this is — `MeleeDifficulty()`'s MELEE_NEWBIE / MELEE_NORMAL / MELEE_INSANE
   * (src/ai/ids.ts), as the slot's name menu named it ("Computer (Easy)" / "(Normal)" /
   * "(Insane)").
   *
   * Only a `computer` slot has one, and only in a MELEE match: a campaign chapter's computers
   * are the mission's and take no melee AI at all. Omitted reads as NORMAL, which is what
   * every seat was before the menu offered the other two.
   */
  aiDifficulty?: number;
  /**
   * This computer is a **Computer+** — OpenWar3's own improved melee AI (src/ai/plus/,
   * docs/computer-plus.md) rather than Blizzard's ported one.
   *
   * Set on every computer seat by the Custom Game screen's Advanced Options checkbox, which is
   * one switch for the whole match; it rides per SLOT all the same, because that is the grain
   * the two AIs are seated at (`RtsController.startMeleeAIFor`) and a lobby that mixed them
   * would need no other change. Absent reads as false — the classic AI, which is what every
   * seat was before the checkbox existed.
   */
  aiPlus?: boolean;
}

/** Fog-of-war start mode chosen in the lobby:
 *   • explored   — whole map begins dimmed grey (terrain memory), live fog still on
 *   • unexplored — normal WC3 fog: unseen ground is pitch black
 *   • revealall  — no fog of war at all; the entire map + every unit stays visible */
export type FogMode = "explored" | "unexplored" | "revealall";

export interface MeleeConfig {
  slots: SlotConfig[];
  fog: FogMode; // fog-of-war start mode; default "explored"
  /**
   * What each TEAM's members grant one another, indexed by team — which on a custom map is
   * the map's own force list, flags and all (`MapInfo.forces`). Omitted (every melee game)
   * means the lobby's promise: allies are allied and share vision.
   *
   * It is here and not on the slots because it is a property of the force, and because the
   * one thing it must reach is the alliance seeding, which happens once for the whole match.
   */
  forces?: ReadonlyArray<{ allied: boolean; sharedVision: boolean }>;
  /**
   * What to CALL this match — the quest log's header, and nothing else. A map names itself in
   * its w3i and that is normally the answer, but a campaign chapter does not: Rise of the
   * Naga's own w3i name is the literal string "NightElfX01", and the title WC3 shows is the
   * campaign index's ("Chapter One — Rise of the Naga"). So the campaign start states it.
   */
  mapName?: string;
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
  /**
   * The CAMPAIGN difficulty the player chose on the campaign screen, as the common.j
   * `gamedifficulty` index (MAP_DIFFICULTY_EASY 0 / NORMAL 1 / HARD 2 / INSANE 3). Omitted
   * outside a campaign, where the reference offers no such choice — a skirmish's difficulty
   * is the AI's, not the game's. Campaign chapters read it through `GetGameDifficulty`.
   */
  difficulty?: number;
  /**
   * This match is a CAMPAIGN chapter rather than a game off a map list.
   *
   * Set by the campaign start (src/main.ts) and read for the things a mission is not: there is
   * nobody to ally with and nobody to talk to, so WC3 leaves the console's Allies and Chat
   * buttons dead in a campaign (see MapViewerScene.togglePanel). `difficulty` happens to be
   * campaign-only too, but reading THAT as "this is a campaign" is reading a coincidence.
   */
  campaign?: boolean;
}
