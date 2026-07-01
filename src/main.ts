import "./style.css";
import { AssetResolver } from "./assets/resolver";
import { decodeBlp } from "./assets/blp";
import { mountMainMenu } from "./ui/mainMenu";
import { TerrainScene } from "./render/scene";
import { buildTerrainMesh } from "./render/terrainMesh";
import { makePlaceholderTerrain } from "./world/placeholderTerrain";
import { loadMapFile } from "./world/map";

// Phase 2 entry point (plan §6). Boots the terrain scene behind the menu:
// procedural placeholder terrain with zero assets (§2), swappable for a real
// .w3x. Fly with WASD / drag / wheel.
const canvas = document.getElementById("bg") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const resolver = new AssetResolver(null);
const scene = new TerrainScene(canvas);
scene.setTerrain(buildTerrainMesh(makePlaceholderTerrain()));
scene.setDoodads([]);
scene.start();

async function loadMap(file: File): Promise<string> {
  const { terrain, doodads } = await loadMapFile(file);
  scene.setTerrain(buildTerrainMesh(terrain));
  scene.setDoodads(doodads);
  return `${file.name}: ${terrain.width}×${terrain.height} corners, ${doodads.length} doodads`;
}

mountMainMenu(ui, resolver, { loadMap });

// Console hooks for the Phase 1/2 exit criteria (enumerate/extract, load a map).
(window as unknown as { openwar3: Record<string, unknown> }).openwar3 = {
  resolver,
  loadMap,
  decodeBlp,
};
