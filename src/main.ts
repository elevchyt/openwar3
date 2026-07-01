import "./style.css";
import { AssetResolver } from "./assets/resolver";
import { decodeBlp } from "./assets/blp";
import { mountMainMenu } from "./ui/mainMenu";
import { TerrainScene } from "./render/scene";
import { buildTerrainMesh } from "./render/terrainMesh";
import { makePlaceholderTerrain } from "./world/placeholderTerrain";
import { loadMapBytes } from "./world/map";
import { ModelViewerScene, type SequenceInfo } from "./render/modelViewer";
import { MapViewerScene } from "./render/mapViewer";

// Entry point (plan §6). Three WebGL scenes, one visible at a time:
//   #bg    — Phase 2 placeholder terrain (WebGL2), the zero-asset fallback
//   #model — Phase 3 single animated MDX unit (mdx-m3-viewer)
//   #map   — authentic full map: terrain/cliffs/water/doodads/units (War3MapViewer)
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

type Which = "bg" | "model" | "map";
function show(which: Which): void {
  bgCanvas.hidden = which !== "bg";
  modelCanvas.hidden = which !== "model";
  mapCanvas.hidden = which !== "map";
  if (which !== "bg") terrain.stop();
  if (which !== "model") modelScene?.stop();
  if (which !== "map") mapScene?.stop();
}

/** Single Player: authentic render with an install, placeholder terrain without. */
async function loadMap(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const vfs = resolver.installSource;

  if (vfs) {
    show("map");
    if (!mapScene) mapScene = await MapViewerScene.create(mapCanvas, vfs);
    mapScene.loadMap(bytes);
    mapScene.start();
    return `${file.name} — authentic render (textures & models stream in)`;
  }

  show("bg");
  const { terrain: data, doodads } = loadMapBytes(bytes, file.name);
  terrain.setTerrain(buildTerrainMesh(data));
  terrain.setDoodads(doodads);
  terrain.start();
  return `${file.name}: ${data.width}×${data.height} corners, ${doodads.length} doodads (placeholder — import an install for authentic assets)`;
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

/** Switch to the model viewer and render an animated MDX by VFS path (Phase 3). */
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

mountMainMenu(ui, resolver, { loadMap });

// Console hooks for the phase exit criteria (see README "Testing manually").
(window as unknown as { openwar3: Record<string, unknown> }).openwar3 = {
  resolver,
  loadMap,
  decodeBlp,
  listModels,
  viewModel,
  setSequence: (index: number) => modelScene?.setSequence(index),
  showTerrain,
};
