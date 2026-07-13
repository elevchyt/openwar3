import "./style.css";
import { AssetResolver } from "./assets/resolver";
import { decodeBlp } from "./assets/blp";
import { mountMainMenu } from "./ui/mainMenu";
import { mountFdfMainMenu } from "./ui/fdfMainMenu";
import { mountSinglePlayerMenu } from "./ui/fdfSinglePlayerMenu";
import { mountSkirmish } from "./ui/fdfSkirmish";
import { GlueManager } from "./ui/glue";
import { mountLoadGate, type GateLoad } from "./ui/gate";
import type { FdfScreen } from "./ui/fdf/render";
import type { DataSource } from "./vfs/types";
import type { MeleeConfig } from "./ui/lobby";
import type { MapInfo } from "./world/mapInfo";
import { TerrainScene } from "./render/scene";
import { buildTerrainMesh } from "./render/terrainMesh";
import { makePlaceholderTerrain } from "./world/placeholderTerrain";
import { loadMapBytes } from "./world/map";
import { ModelViewerScene, type SequenceInfo } from "./render/modelViewer";
import { MapViewerScene } from "./render/mapViewer";
import { MenuScene } from "./render/menuScene";
import { applyMenuCursor } from "./ui/cursor";

// Entry point (plan §6). WebGL scenes, one visible at a time:
//   #menubg — the animated main-menu glue scene (issue #54), behind the FDF menu
//   #bg     — Phase 2 placeholder terrain (WebGL2), the zero-asset fallback
//   #model  — Phase 3 single animated MDX unit (mdx-m3-viewer)
//   #map    — authentic full map + our sim (War3MapViewer)
// Boot shows nothing (an empty black background under the load gate) until the game
// files are imported — the menu's 3D scene is one of those files.
const bgCanvas = document.getElementById("bg") as HTMLCanvasElement;
const menuBgCanvas = document.getElementById("menubg") as HTMLCanvasElement;
const modelCanvas = document.getElementById("model") as HTMLCanvasElement;
const mapCanvas = document.getElementById("map") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const resolver = new AssetResolver(null);

// Placeholder terrain is now only the zero-asset map fallback (kept idle until then),
// not the menu background — the menu uses the real MainMenu3D glue scene once loaded.
const terrain = new TerrainScene(bgCanvas);
terrain.setTerrain(buildTerrainMesh(makePlaceholderTerrain()));
terrain.setDoodads([]);

let modelScene: ModelViewerScene | null = null;
let mapScene: MapViewerScene | null = null;
let menuScene: MenuScene | null = null;
let menuDebug: { dispose(): void } | null = null;
let meleeConfig: MeleeConfig | null = null; // consumed by the melee initializer (next)
let installMaps: Map<string, File> = new Map(); // the install's Maps\ folder (Custom Game)

// The glue-screen stack (issue #61): main menu → Single Player → Custom Game, each
// leaving and arriving the way the reference does.
const glue = new GlueManager(null);

type Which = "none" | "menubg" | "bg" | "model" | "map";
function show(which: Which): void {
  menuBgCanvas.hidden = which !== "menubg";
  bgCanvas.hidden = which !== "bg";
  modelCanvas.hidden = which !== "model";
  mapCanvas.hidden = which !== "map";
  if (which !== "menubg") menuScene?.stop();
  if (which !== "bg") terrain.stop();
  if (which !== "model") modelScene?.stop();
  if (which !== "map") mapScene?.stop();
}

/** Show the animated main-menu 3D scene behind the menu (built on first use). Falls
 *  back to an empty background if the glue model is missing/fails to load. */
async function showMenuBackground(vfs: DataSource | null): Promise<void> {
  if (!vfs) { show("none"); return; }
  try {
    if (!menuScene) {
      menuScene = new MenuScene(menuBgCanvas, vfs);
      await menuScene.load();
    }
    show("menubg");
    menuScene.start();
    // Opt-in on-screen framing controls (?menudebug) — tune the camera/panel, then
    // "Log values" to print numbers to bake into MenuScene.tuning.
    if (menuScene && !menuDebug && new URLSearchParams(location.search).has("menudebug")) {
      const { mountMenuDebug } = await import("./ui/menuDebug");
      menuDebug = mountMenuDebug(ui, menuScene);
    }
  } catch (err) {
    console.warn("[OpenWar3] main-menu 3D scene unavailable:", err);
    show("none"); // empty background
  }
}

/** Load a map's bytes into the right scene (authentic with an install, else placeholder). */
async function enterMap(bytes: Uint8Array, name: string): Promise<string> {
  const vfs = resolver.installSource;
  document.body.classList.add("in-game"); // hide the main-menu panel over the map
  if (vfs) {
    show("map");
    if (!mapScene) mapScene = await MapViewerScene.create(mapCanvas, vfs);
    mapScene.onExit = () => exitToMenu(); // F10 → End Game leaves the match
    mapScene.loadMap(bytes);
    mapScene.start();
    return `${name} — authentic render (textures & models stream in)`;
  }
  show("bg");
  const { terrain: data, doodads } = loadMapBytes(bytes, name);
  terrain.setTerrain(buildTerrainMesh(data));
  terrain.setDoodads(doodads);
  terrain.start();
  return `${name}: placeholder terrain (import an install for authentic assets)`;
}

// --- the glue screens (issue #61) -------------------------------------------------
//
// Each is a GlueScreenDef: which chrome the panel model wears, and how to build the DOM.
// GlueManager runs the transition between them (every button goes disabled → contents fade
// out and the panel slides away → beat → the next panel drops in and its contents fade up),
// all of it timed off the chrome's own Birth/Death clips.

function mainMenuScreen(vfs: DataSource): { chrome: "MainMenu"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "MainMenu",
    mount: () => mountFdfMainMenu(ui, vfs, {
      onSinglePlayer: () => void glue.goTo(singlePlayerScreen(vfs)),
      onQuit: () => window.close(),
    }),
  };
}

function singlePlayerScreen(vfs: DataSource): { chrome: "SinglePlayer"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "SinglePlayer",
    mount: () => mountSinglePlayerMenu(ui, vfs, {
      onCustomGame: () => void glue.goTo(skirmishScreen(vfs)),
      onCancel: () => void glue.goTo(mainMenuScreen(vfs)),
    }),
  };
}

function skirmishScreen(vfs: DataSource): { chrome: "SinglePlayerSkirmish"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "SinglePlayerSkirmish",
    mount: () => mountSkirmish(ui, vfs, installMaps, {
      onCancel: () => void glue.goTo(singlePlayerScreen(vfs)),
      onStart: (file, info, config) => void startGame(file, info, config),
    }),
  };
}

/** Leave the menus and play: load the map, then melee or custom setup as the map asks. */
async function startGame(file: File, info: MapInfo, config: MeleeConfig): Promise<void> {
  meleeConfig = config;
  glue.dispose(); // the menus are done; the match owns the screen now
  const bytes = new Uint8Array(await file.arrayBuffer());
  await enterMap(bytes, info.name);
  // Melee maps get the standard setup (town hall + workers, melee rules);
  // custom/scenario maps run their own triggers instead (see mapKind.ts).
  if (info.isMelee) await mapScene?.startMelee(config);
  else await mapScene?.startCustom(config);
}

/** Enumerable unit models from the mounted install (portraits excluded). */
function listModels(): string[] {
  const vfs = resolver.installSource;
  if (!vfs) return [];
  return vfs
    .list()
    .filter((p) => /^units\\.*\.mdx$/i.test(p) && !/portrait/i.test(p))
    .sort();
}

async function viewModel(path: string): Promise<SequenceInfo[]> {
  const vfs = resolver.installSource;
  if (!vfs) throw new Error("Import a Warcraft III install first (click the menu status text).");
  show("model");
  if (!modelScene) modelScene = new ModelViewerScene(modelCanvas, vfs);
  const sequences = await modelScene.load(path);
  modelScene.start();
  return sequences;
}

function showTerrain(): void {
  show("bg");
  terrain.start();
}

/** Leave the current match (F10 → End Game): tear down the map scene and return to
 *  the main menu over its animated 3D scene. A fresh scene is built next game. */
function exitToMenu(): void {
  mapScene?.dispose();
  mapScene = null;
  meleeConfig = null;
  document.body.classList.remove("in-game"); // reveal the main-menu panel again
  const vfs = resolver.installSource;
  void showMenuBackground(vfs).then(() => {
    // The menu's chrome is back on the main-menu clip, so the DOM must be too.
    menuScene?.playChromeBirth("MainMenu");
    if (vfs) void glue.show(mainMenuScreen(vfs));
  });
}

// Boot flow (issue #54): the WC3 menus are constructed from the install's own
// UI\FrameDef\*.fdf files, so we gate on loading the game files first — a single
// button over the flying terrain — then build the FDF main menu and continue.
let gate: { dispose(): void } | null = null;

/** Build the authentic FDF-driven main menu; fall back to the flat skin if the install
 *  lacks the glue files or the FDF fails to construct. Every screen the game can reach is
 *  now built from the FrameDef — the Custom Game screen included — so the flat menu is a
 *  diagnostic, not a second way to play: it can only tell the player what's missing. */
async function showMainMenu(vfs: DataSource): Promise<void> {
  try {
    await glue.show(mainMenuScreen(vfs));
  } catch (err) {
    console.warn("[OpenWar3] FDF main menu unavailable, using flat menu:", err);
    mountMainMenu(ui, resolver, {
      onSinglePlayer: () => window.alert(
        "This install is missing the UI\\FrameDef\\Glue files the menus are built from, " +
        "so the game can't be set up. Re-import a complete Warcraft III (TFT 1.27a) folder.",
      ),
    });
  }
}

/** Hand off from the load gate to the main menu once the archives are mounted. */
function onFilesLoaded(load: GateLoad): void {
  resolver.setInstall(load.vfs);
  installMaps = load.maps; // the Custom Game screen's map list
  ((window as unknown as { openwar3: Record<string, unknown> }).openwar3 ??= {}).vfs = load.vfs;
  gate?.dispose();
  gate = null;
  applyMenuCursor(load.vfs); // WC3 human hand cursor in the menus
  // The 3D scene has to exist before the menus do: it owns the panel chrome whose
  // Birth/Death clips time their transitions (ui/glue.ts).
  void showMenuBackground(load.vfs).then(() => {
    glue.setScene(menuScene);
    void showMainMenu(load.vfs);
  });
}

// The right mouse button belongs to the GAME (it is the move/attack order), and a game has no
// browser context menu — anywhere, on any surface: the 3D canvas, the HUD, the menus. The
// individual canvases already swallowed it; this closes the rest of the page.
window.addEventListener("contextmenu", (e) => e.preventDefault());

gate = mountLoadGate(ui, onFilesLoaded);

// Console hooks for the phase exit criteria (see README "Testing manually").
(window as unknown as { openwar3: Record<string, unknown> }).openwar3 = {
  resolver,
  decodeBlp,
  listModels,
  viewModel,
  setSequence: (index: number) => modelScene?.setSequence(index),
  showTerrain,
  loadMap: async (file: File) => enterMap(new Uint8Array(await file.arrayBuffer()), file.name),
  meleeConfig: () => meleeConfig,
  mainMenu: () => glue.screen,
  menuScene: () => menuScene,
};
