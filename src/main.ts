import "./style.css";
import { AssetResolver } from "./assets/resolver";
import { decodeBlp } from "./assets/blp";
import { mountMainMenu } from "./ui/mainMenu";
import { TerrainScene } from "./render/scene";
import { buildTerrainMesh } from "./render/terrainMesh";
import { makePlaceholderTerrain } from "./world/placeholderTerrain";
import { loadMapFile } from "./world/map";
import { ModelViewerScene, type SequenceInfo } from "./render/modelViewer";

// Entry point (plan §6). Boots the Phase 2 terrain scene behind the menu, with a
// Phase 3 model-viewer mode that renders real animated MDX units on its own
// canvas. Both work with the user's own imported install (§0).
const bgCanvas = document.getElementById("bg") as HTMLCanvasElement;
const modelCanvas = document.getElementById("model") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const resolver = new AssetResolver(null);

// Phase 2 terrain scene (procedural placeholder until a map is loaded).
const terrain = new TerrainScene(bgCanvas);
terrain.setTerrain(buildTerrainMesh(makePlaceholderTerrain()));
terrain.setDoodads([]);
terrain.start();

let modelScene: ModelViewerScene | null = null;

async function loadMap(file: File): Promise<string> {
  showTerrain();
  const { terrain: data, doodads } = await loadMapFile(file);
  terrain.setTerrain(buildTerrainMesh(data));
  terrain.setDoodads(doodads);
  return `${file.name}: ${data.width}×${data.height} corners, ${doodads.length} doodads`;
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
  terrain.stop();
  bgCanvas.hidden = true;
  modelCanvas.hidden = false;
  if (!modelScene) modelScene = new ModelViewerScene(modelCanvas, vfs);
  const sequences = await modelScene.load(path);
  modelScene.start();
  return sequences;
}

function showTerrain(): void {
  modelScene?.stop();
  modelCanvas.hidden = true;
  bgCanvas.hidden = false;
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
