import w3i from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";
import { MpqDataSource } from "../vfs/mpq";
import { parseW3E, type TerrainData } from "./terrain";
import { parseDoo, type DoodadInstance } from "./doodads";

// Load a playable map (plan Phase 2/5). A .w3x/.w3m is itself an MPQ, so we open
// it with the same reader and pull out terrain + doodads. This is the real-asset
// path; makePlaceholderTerrain() is the zero-asset counterpart.

export interface LoadedMap {
  terrain: TerrainData;
  doodads: DoodadInstance[];
}

/** Open a .w3x/.w3m file (an MPQ) and extract its terrain and doodads. */
export async function loadMapFile(file: File): Promise<LoadedMap> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return loadMapBytes(bytes, file.name);
}

export function loadMapBytes(bytes: Uint8Array, label = "map"): LoadedMap {
  const mpq = new MpqDataSource(label, bytes);

  const w3eFile = mpq.rawBytes("war3map.w3e");
  if (!w3eFile) throw new Error(`${label}: no war3map.w3e (not a Warcraft III map?)`);
  const terrain = parseW3E(w3eFile);

  // buildVersion gates doodad parsing; default 0 (pre-1.32) if w3i is absent.
  let buildVersion = 0;
  const w3iBytes = mpq.rawBytes("war3map.w3i");
  if (w3iBytes) {
    const info = new w3i.File();
    info.load(w3iBytes);
    buildVersion = info.getBuildVersion();
  }

  const dooBytes = mpq.rawBytes("war3map.doo");
  const doodads = dooBytes ? parseDoo(dooBytes, buildVersion) : [];

  return { terrain, doodads };
}
