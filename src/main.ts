import "./style.css";
import { AssetResolver } from "./assets/resolver";
import { decodeBlp } from "./assets/blp";
import { mountMainMenu } from "./ui/mainMenu";
import { mountFdfMainMenu } from "./ui/fdfMainMenu";
import { mountLoadGate, type GateLoad } from "./ui/gate";
import type { FdfScreen } from "./ui/fdf/render";
import type { DataSource } from "./vfs/types";
import { showLobby, type MeleeConfig } from "./ui/lobby";
import { parseMapInfo } from "./world/mapInfo";
import { TerrainScene } from "./render/scene";
import { buildTerrainMesh } from "./render/terrainMesh";
import { makePlaceholderTerrain } from "./world/placeholderTerrain";
import { loadMapBytes } from "./world/map";
import { ModelViewerScene, type SequenceInfo } from "./render/modelViewer";
import { MapViewerScene } from "./render/mapViewer";

// Entry point (plan §6). Three WebGL scenes, one visible at a time:
//   #bg    — Phase 2 placeholder terrain (WebGL2), the zero-asset fallback
//   #model — Phase 3 single animated MDX unit (mdx-m3-viewer)
//   #map   — authentic full map + our sim (War3MapViewer)
const bgCanvas = document.getElementById("bg") as HTMLCanvasElement;
const modelCanvas = document.getElementById("model") as HTMLCanvasElement;
const mapCanvas = document.getElementById("map") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const resolver = new AssetResolver(null);

const terrain = new TerrainScene(bgCanvas);
terrain.setTerrain(buildTerrainMesh(makePlaceholderTerrain()));
terrain.setDoodads([]);
terrain.start();

let modelScene: ModelViewerScene | null = null;
let mapScene: MapViewerScene | null = null;
let meleeConfig: MeleeConfig | null = null; // consumed by the melee initializer (next)

type Which = "bg" | "model" | "map";
function show(which: Which): void {
  bgCanvas.hidden = which !== "bg";
  modelCanvas.hidden = which !== "model";
  mapCanvas.hidden = which !== "map";
  if (which !== "bg") terrain.stop();
  if (which !== "model") modelScene?.stop();
  if (which !== "map") mapScene?.stop();
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

/** Single Player flow: pick a map → game setup lobby → Start loads the map. */
async function singlePlayer(): Promise<void> {
  const file = await pickMapFile();
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = parseMapInfo(bytes, file.name.replace(/\.(w3x|w3m)$/i, ""));
  // Fully release the GPU while the setup modal is open: pause every scene AND
  // hide the canvases, so there's no live WebGL surface for the compositor to
  // keep blending under a full-screen overlay (the cause of the freeze).
  terrain.stop();
  mapScene?.stop();
  modelScene?.stop();
  bgCanvas.hidden = true;
  modelCanvas.hidden = true;
  mapCanvas.hidden = true;
  document.body.classList.add("menu-suspended"); // hide the main menu behind the lobby
  const teardown = showLobby(ui, info, {
    onCancel: () => {
      teardown();
      document.body.classList.remove("menu-suspended");
      showTerrain();
    },
    onStart: async (config) => {
      meleeConfig = config;
      teardown();
      document.body.classList.remove("menu-suspended");
      await enterMap(bytes, info.name);
      // Melee maps get the standard setup (town hall + workers, melee rules);
      // custom/scenario maps run their own triggers instead (see mapKind.ts).
      if (info.isMelee) await mapScene?.startMelee(config);
      else await mapScene?.startCustom(config);
    },
  });
}

function pickMapFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".w3x,.w3m";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
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

/** Leave the current match (F10 → End Game): tear down the map scene and return
 *  to the main menu over the placeholder terrain. A fresh scene is built next game. */
function exitToMenu(): void {
  mapScene?.dispose();
  mapScene = null;
  meleeConfig = null;
  document.body.classList.remove("in-game"); // reveal the main-menu panel again
  showTerrain();
}

// Boot flow (issue #54): the WC3 menus are constructed from the install's own
// UI\FrameDef\*.fdf files, so we gate on loading the game files first — a single
// button over the flying terrain — then build the FDF main menu and continue.
let mainMenu: FdfScreen | null = null;
let gate: { dispose(): void } | null = null;

/** Build the authentic FDF-driven main menu; fall back to the flat skin if the
 *  install lacks the glue files or the FDF fails to construct. */
async function showMainMenu(vfs: DataSource): Promise<void> {
  try {
    mainMenu = await mountFdfMainMenu(ui, vfs, {
      onSinglePlayer: singlePlayer,
      onQuit: () => window.close(),
    });
  } catch (err) {
    console.warn("[OpenWar3] FDF main menu unavailable, using flat menu:", err);
    mountMainMenu(ui, resolver, { onSinglePlayer: singlePlayer });
  }
}

/** Hand off from the load gate to the main menu once the archives are mounted. */
function onFilesLoaded(load: GateLoad): void {
  resolver.setInstall(load.vfs);
  ((window as unknown as { openwar3: Record<string, unknown> }).openwar3 ??= {}).vfs = load.vfs;
  gate?.dispose();
  gate = null;
  void showMainMenu(load.vfs);
}

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
  mainMenu: () => mainMenu,
};
