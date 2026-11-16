// SAVED GAMES (issue #159, docs/save-games.md) — the `.o3s` file.
//
// Warcraft III's own saved game (`.w3z`) is the engine's memory written down — not a replay to
// re-simulate — and so is ours: loading one costs about what loading the map costs, however long
// the match had run. The file is the same tagged-section container a replay is written in
// (game/sectionFile.ts), under its own magic:
//
//   HEAD  who saved what, where: the build, the game files, the map, the lobby's config as it was
//         RESOLVED, the campaign chapter, the edition and the balance patch — everything needed to
//         put the same map on the screen again before a byte of state is read;
//   STAT  the state: one object graph (game/save/graph.ts) holding the world, the map's script
//         with its sleeping threads, the computers' brains and the controller's books;
//   SCEN  what the SCENE was showing that only the scene knows — the camera, the cinematic
//         letterbox, the special effects a script placed — rebuilt on load (MapViewerScene).
//
// THE VERSION CHECK (the issue's own words): a save is the engine's memory, and another build's
// memory is a different shape. So a save names the OpenWar3 build that wrote it and its SIM
// FINGERPRINT (tools/sim-fingerprint.mjs — the same hash replays carry), and the game files it was
// made on (1.30.4 is the only target, and checked anyway). Load Saved Game refuses a save from
// another fingerprint in the game's own words rather than load a match that is quietly wrong.
//
// Kept free of the DOM and the renderer: the headless save tests compile it for Node.

import type { MeleeConfig } from "../../ui/lobby";
import type { GraphDoc } from "./graph";
import { readSectionFile, writeSectionFile } from "../sectionFile";

/** The format of the FILE, not of OpenWar3 — bumped when a reader of the old one could not read
 *  the new one. A new SECTION is not a bump. */
export const SAVE_FORMAT = 1;

/** "OW3S" — the first four bytes of every saved game. */
const MAGIC = [0x4f, 0x57, 0x33, 0x53];

/** The game files every save is made on. 1.30.4 is the only target (CLAUDE.md); kept in the
 *  header and checked anyway, the issue asks for it. */
export const SAVE_GAME_VERSION = "1.30.4";

export interface SaveHeader {
  format: number;
  /** OpenWar3's own version (`package.json`) and commit. */
  version: string;
  commit?: string;
  /** The SIM FINGERPRINT of the build that wrote it (tools/sim-fingerprint.mjs): two builds that
   *  agree on it simulate — and therefore lay their state out — identically. */
  fingerprint?: string;
  /** The Warcraft III game files: always 1.30.4 (`SAVE_GAME_VERSION`)… */
  gameVersion: string;
  /** …and how they were mounted (`casc-1.30.4`, `…-downgraded`, `mpq`). */
  install?: string;
  /** When, wall-clock ISO, and how far into the match (game seconds). */
  savedAt: string;
  gameTime: number;
  /** The name the player gave it — what the Load screen lists. */
  name: string;
  /** The map — its install path (or archive path, for a chapter), its name and a hash of its bytes. */
  map: { path: string; name: string; hash: string; size: number; melee: boolean };
  /** The lobby's config as it was RESOLVED (the seed, every Random race already rolled). */
  config: MeleeConfig;
  /** The campaign chapter this match IS, when it is one — so a victory after the load is still
   *  credited to it, and Continue still leads to the next chapter. */
  campaign?: { key: string; index: number; difficulty: string };
  /** The profile it was saved on (data/profiles.ts) — a campaign's carried heroes live there. */
  profile?: string;
  edition: "roc" | "tft";
  patch: string;
  /** The seat the saving machine played. */
  localPlayer: number;
}

/** What only the SCENE knows about a match (MapViewerScene.captureScene) — what a script put on
 *  the screen, and where the player was looking. */
export interface SavedScene {
  /** The computers the script seated, in order: replayed before the state is written back. */
  aiSeats: Array<[number, string]>;
  camera?: {
    target: [number, number, number];
    distance: number; yaw: number; pitch: number; fov: number; roll: number; farZ: number;
    zOffset: number; playerDistance: number; playerPitch: number;
  };
  gameSpeed?: number;
  difficulty?: number;
  defaultDifficulty?: number;
  interfaceShown?: boolean;
  userUi?: boolean;
  userControl?: boolean;
  /** Every map destructible's life, by its .doo id — the scene keeps it, the script reads it. */
  destructibles?: Array<[number, number]>;
  destSimIds?: Array<[number, number]>;
  matchDecided?: boolean;
  questFlashesSeen?: number;
  /** Further presentation a script put up — see MapViewerScene.captureScene. */
  [more: string]: unknown;
}

export interface SaveFile {
  header: SaveHeader;
  /** The state graph. Written as one JSON string, so the codec's output is not walked twice. */
  state: GraphDoc;
  /** The scene's own presentation (MapViewerScene.capturePresentation). */
  scene: unknown;
}

/** Write a saved game. */
export async function encodeSave(f: SaveFile): Promise<Uint8Array> {
  return writeSectionFile(MAGIC, SAVE_FORMAT, [
    ["HEAD", f.header],
    ["STAT", JSON.stringify(f.state)],
    ["SCEN", f.scene],
  ]);
}

/** Read a saved game. Throws on something that is not one, or a format this build cannot read. */
export async function decodeSave(bytes: Uint8Array): Promise<SaveFile> {
  const found = await readSectionFile(bytes, MAGIC, SAVE_FORMAT, ["HEAD", "STAT", "SCEN"], "saved game");
  const header = found.get("HEAD") as SaveHeader | undefined;
  const state = found.get("STAT") as GraphDoc | undefined;
  if (!header || !state) throw new Error("saved game has no header or no state");
  return { header, state, scene: found.get("SCEN") ?? null };
}

/** Read only the header — what the Load screen lists — without inflating the state. */
export async function readSaveHeader(bytes: Uint8Array): Promise<SaveHeader> {
  const found = await readSectionFile(bytes, MAGIC, SAVE_FORMAT, ["HEAD"], "saved game");
  const header = found.get("HEAD") as SaveHeader | undefined;
  if (!header) throw new Error("saved game has no header");
  return header;
}

/**
 * Why THIS build cannot load a save, or null when it can (the issue: "loading a saved game must
 * check that saved game's openwar3 version that it was saved in as well as the game version").
 *
 * The engine's memory only means the same thing to a build that lays it out the same way, which
 * is exactly what the sim fingerprint hashes — so a save loads when the fingerprint matches (a
 * release that only touched the menus changes nothing a save holds) or, for a save written by a
 * build with no fingerprint, when the version does.
 */
export function saveIncompatibility(h: SaveHeader, build: { version: string; fingerprint: string }): "game" | "build" | null {
  if (h.gameVersion !== SAVE_GAME_VERSION) return "game";
  if (h.fingerprint && build.fingerprint) return h.fingerprint === build.fingerprint ? null : "build";
  return h.version === build.version ? null : "build";
}
