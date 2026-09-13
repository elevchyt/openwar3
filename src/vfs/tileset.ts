import { MpqDataSource } from "./mpq";
import type { DataSource } from "./types";

/**
 * The tileset overlay — the per-tileset archive a map's art is layered with (issue #152).
 *
 * Warcraft III ships a set of cliff faces, water frames and building ubersplats PER TILESET,
 * and every one of those sets is filed under the SAME logical path: the Sunken Ruins cliff and
 * the Lordaeron Summer cliff are both `ReplaceableTextures\Cliff\Cliff0.blp`, and
 * `TerrainArt\CliffTypes.slk` has only the one `texDir`/`texFile` to name them with. What tells
 * them apart is the ARCHIVE they sit in: war3.mpq carries a nested MoPaQ per tileset letter and
 * the engine mounts the one the loaded map names on top of everything else — which is why a
 * tileset is a map-level property rather than a per-tile one.
 *
 * 1.30.4 kept that split in the CASC root exactly as it kept the MPQ names (src/vfs/casc.ts).
 * The entries read
 *
 *     War3.mpq:Z.mpq:ReplaceableTextures\Cliff\Cliff0.blp
 *
 * so in the mounted store a tileset's own copy is reachable at `Z.mpq:<path>` while the
 * unprefixed path is the default. Seventeen letters carry cliffs and water; `L` carries
 * neither, because the unprefixed default IS Lordaeron Summer's — which is why Echo Isles
 * always looked right and Circumvention (tileset `Z`, Sunken Ruins) drew Lordaeron dirt cliffs
 * in a jungle.
 *
 * What each tileset archive holds, verified against the retail 1.30.4 store: the two cliff
 * textures, the 45 water frames, the nine ubersplats every race's town centre stamps, and the
 * two or three creep skins the game re-tints per tileset (the bear, the war eagle, the
 * quillbeast). So this is not a cliff rule with a cliff-shaped exception list — it is one
 * overlay, and anything the tileset has its own copy of comes from it.
 *
 * The RoC-era naming is still in the install and is NOT the same art: `Deprecated.mpq` (the
 * archive whose whole job is paths old custom maps hard-reference) keeps twelve of the
 * eighteen tilesets' cliffs as `ReplaceableTextures\Cliff\<letter>_Cliff0.blp`, a few kilobytes
 * apart from the live copy each time and absent for every tileset The Frozen Throne added
 * (I, J, K, O, Z). It stays here as the last rung, for an install old enough to have only that.
 */

/** Where a path's bytes come from once the map's tileset has had its say. */
export interface TilesetFile {
  /** A stable, unique cache key — the overlay's own path when the tileset has its own copy. */
  key: string;
  /** The source holding it… */
  source: DataSource;
  /** …and the path within that source. */
  path: string;
}

/**
 * A resolver over one mounted install. Cheap to call: every answer is memoized per
 * (tileset, path), because the caller is an asset path solver on the hot load path.
 */
export function tilesetOverlay(vfs: DataSource): (path: string, tileset?: string) => TilesetFile {
  const memo = new Map<string, TilesetFile>();
  /** A nested `<letter>.mpq`, opened once, for an install that keeps them as real files. */
  const nested = new Map<string, DataSource | null>();

  const archive = (letter: string): DataSource | null => {
    let source = nested.get(letter);
    if (source === undefined) {
      const name = `${letter}.mpq`;
      const bytes = vfs.exists(name) ? vfs.rawBytes(name) : null;
      source = bytes ? new MpqDataSource(name, bytes) : null;
      nested.set(letter, source);
    }
    return source;
  };

  return (path, tileset) => {
    const letter = tileset?.[0]?.toUpperCase() ?? "";
    if (letter < "A" || letter > "Z") return { key: path, source: vfs, path };
    const memoKey = `${letter}|${path.toLowerCase()}`;
    let hit = memo.get(memoKey);
    if (hit) return hit;

    const prefixed = `${letter}.mpq:${path}`;
    if (vfs.exists(prefixed)) {
      // 1.30.4: the tileset archives are flattened into the store under their own names.
      hit = { key: prefixed, source: vfs, path: prefixed };
    } else {
      const own = archive(letter);
      if (own?.exists(path)) {
        // MPQ-era: the tileset archive is a real nested MoPaQ inside the mounted one.
        hit = { key: prefixed, source: own, path };
      } else {
        // RoC-era: `<letter>_` beside the default, for the twelve tilesets that have it.
        const deprecated = path.replace(/([^\\]+)$/, `${letter}_$1`);
        hit = /\\cliff\\[^\\]+$/i.test(path) && vfs.exists(deprecated)
          ? { key: deprecated, source: vfs, path: deprecated }
          : { key: path, source: vfs, path };
      }
    }
    memo.set(memoKey, hit);
    return hit;
  };
}
