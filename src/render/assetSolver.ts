// The one place a logical asset path becomes bytes for the match's viewer — the "path solver"
// mdx-m3-viewer calls for every model and texture the scene loads (MapViewerScene.create).
//
// Three layers, first hit wins:
//
//   1. the running MAP's archive. A map's imported art (`war3mapImported\Santa.mdx` and the
//      textures it names) is inside the .w3x and nowhere else, and the search order puts the
//      map first — the viewer's own map handler does exactly that for the units the map PLACES
//      (`pathSolver` in handlers/w3x/map.js). Without this layer a pre-placed custom hero looked
//      right while every unit a trigger created or a shop sold came out with no model, no body
//      and so no command card at all (Test of Balance's drafted heroes). The audio half is
//      SoundBoard.mountMap.
//   2. the map's TILESET archive (issue #152). Cliff faces, water frames and ubersplats are one
//      path per set and one SET PER TILESET, told apart by the archive they sit in — see
//      vfs/tileset.ts. The viewer hands the tileset letter down with every load the map handler
//      makes, its own models and their textures included.
//   3. the install.
//
// Every path resolves to a STABLE, cached blob-url string — never a Promise<bytes>. This is the
// load-time win behind issue #14: the viewer only DEDUPES a resource when the solver hands it a
// string it can key its promiseMap/resourceMap on. A Promise (what `vfs.read()` returns) sends
// the load down the viewer's __DIRECT_LOAD path, which mints a unique id and parses a *fresh*
// resource EVERY call — so a map with hundreds of trees all referencing one LordaeronTree.mdx
// re-read and re-parsed that model once per tree, the dominant cost of map init. One blob url
// per path (tracked in `created` for revocation) means each shared model/texture is fetched
// once and parsed exactly once.

import type { DataSource } from "../vfs/types";
import { tilesetOverlay } from "../vfs/tileset";

/** The viewer calls the solver as (src, solverParams) — params carry the map's tileset letter
 *  once war3map.w3i is parsed. */
export type Solver = (src: unknown, params?: { tileset?: string }) => unknown;

/** The running map's archive, as the solver sees it. `epoch` moves on every mount, so a second
 *  map's `war3mapImported\x.mdx` is never handed the first map's bytes. */
export interface MapFileLayer {
  archive: DataSource | null;
  epoch: number;
}

/**
 * @param baseUrls the base SLKs, already minted before the viewer existed (and dropped from the
 *   map once the viewer has them).
 * @param created every blob URL minted, in order — the scene revokes them.
 */
export function createAssetSolver(vfs: DataSource, mapFiles: MapFileLayer, baseUrls: Map<string, string>, created: string[]): Solver {
  const blobUrls = new Map<string, string | null>();
  const overlay = tilesetOverlay(vfs);
  const mint = (key: string, read: () => Uint8Array | null): string | null => {
    let url = blobUrls.get(key);
    if (url === undefined) {
      const bytes = read(); // MPQ decode is synchronous (mpq.ts)
      url = bytes ? URL.createObjectURL(new Blob([bytes as BlobPart])) : null;
      blobUrls.set(key, url);
      if (url) created.push(url);
    }
    return url;
  };
  return (src, params) => {
    if (typeof src !== "string") return src; // in-memory loads pass through
    const logical = src.replace(/\//g, "\\");
    const map = mapFiles.archive;
    if (map) {
      const url = mint(`map${mapFiles.epoch}:${logical.toLowerCase()}`, () => map.rawBytes(logical));
      if (url) return url;
    }
    const { key, source, path } = overlay(logical, params?.tileset);
    const cached = baseUrls.get(key);
    if (cached) return cached; // preloaded base SLKs
    return mint(key, () => source.rawBytes(path)) ?? src; // string ⇒ the viewer caches+dedupes by this url
  };
}
