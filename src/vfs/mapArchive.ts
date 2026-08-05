import mpqParser from "mdx-m3-viewer/dist/cjs/parsers/mpq";
import type { DataSource } from "./types";

/**
 * Getting a map's bytes out of the mounted install, whichever storage it uses (issue #102).
 *
 * A Warcraft III map IS an MPQ, and everything downstream of here relies on that: the terrain,
 * the w3i, the triggers, the minimap, and mdx-m3-viewer's own `loadMap` all take the archive's
 * raw bytes. That held for every install until 1.30 — a CASC store has no `.w3x` blob for a
 * campaign chapter, only the ~20 files that used to be inside it, filed under
 * `Maps\…\OrcX01.w3x:war3map.j` (vfs/casc.ts).
 *
 * So we put the archive back together. That is what the real 1.30 client does too — its TVFS
 * presents those same entries to the engine as one mounted archive — and it keeps the ONE map
 * path the engine has always had, rather than growing a second one that only campaigns take
 * and only campaigns can break.
 */

/**
 * The bytes of a map named by a path inside the install: the stored `.w3x` where there is one,
 * a repack of its exploded entries where there isn't. Null when the install has neither.
 */
export async function readMapBytes(vfs: DataSource, path: string): Promise<Uint8Array | null> {
  if (vfs.exists(path)) return vfs.read(path);
  const exploded = vfs.openArchive?.(path);
  return exploded ? packArchive(exploded) : null;
}

/**
 * Repack a DataSource as an MPQ, so anything that wants "a map file" can have one. The files
 * go in uncompressed (which is what `set()` does), the right trade for bytes that are read
 * once, immediately, by code in this same tab and never leave memory. `save()` writes the
 * `(listfile)` itself, so the repacked map enumerates like any other.
 *
 * A fresh Archive's hash table holds FOUR entries and never grows: `set()` past that returns
 * false and the file is silently dropped, which reads downstream as "this chapter has no
 * terrain" rather than as an error. So size the table up front — a power of two (the table
 * indexes by mask) with room to spare, since a full table also makes every lookup a full scan.
 */
export function packArchive(source: DataSource): Uint8Array {
  const archive = new mpqParser.Archive();
  const names = source.list();
  archive.hashTable.addEmpties(hashTableSize(names.length + 1) - archive.hashTable.entries.length);
  for (const name of names) {
    const bytes = source.rawBytes(name);
    if (bytes && !archive.set(name, bytes)) {
      throw new Error(`${source.label}: no room in the archive for ${name}`);
    }
  }
  const packed = archive.save();
  if (!packed) throw new Error(`${source.label}: could not repack as an archive`);
  return packed;
}

/** Smallest power of two at least twice `count`, and never below MPQ's minimum of 4. */
function hashTableSize(count: number): number {
  let size = 4;
  while (size < count * 2) size *= 2;
  return size;
}
