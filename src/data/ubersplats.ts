import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";

// UberSplat registry — the "ground texture" decals WC3 paints on the terrain under
// buildings (and gold mines). A unit's `uberSplat` code (UnitUI.slk, see units.ts)
// keys a row in `Splats\UberSplatData.slk` that gives the texture + how big to draw
// it. Verified against the real game data (War3x.mpq holds UberSplatData.slk):
//
//   HTOW → dir=ReplaceableTextures\Splats file=HumanTownHallUberSplat scale=230 blend=0
//   HMED → …\HumanUberSplat scale=190 …   OLAR → …\OrcUberSplat scale=240 …
//
// `scale` is the splat's HALF-WIDTH in world units (the quad spans center ± scale);
// `dir\file.blp` is the texture. Note the actual BLPs ship BOTH as the plain
// `dir\file.blp` AND as detail-tier variants `A_/B_/C_<file>.blp` (the engine's
// internal LODs). The plain path is the canonical one — and the path a map author
// imports a custom building ground texture to (Hive Workshop thread 326827). We
// render the plain texture; see src/render/uberSplatOverlay.ts.

export interface UberSplatDef {
  id: string;
  texture: string; // resolved BLP path, backslashes, with extension (`dir\file.blp`)
  scale: number; // half-width in world units (quad spans center ± scale)
  blend: number; // UberSplatData "blendmode" (0 = alpha blend; used verbatim)
  // The fade a TEMPORARY splat plays through, in seconds. A building's splat just holds
  // (its row's times are irrelevant while the building stands), but a spell's — THND,
  // "ThunderClap": BirthTime=0.2 PauseTime=2 Decay=2, StartA=0 MiddleA=255 EndA=0 — is
  // the whole effect: fade in over BirthTime, hold PauseTime, fade out over Decay.
  birthTime: number;
  pauseTime: number;
  decay: number;
  /** The colour at each end of those three phases, R,G,B,A as 0..1 — `StartR..A`,
   *  `MiddleR..A`, `EndR..A`: Start → Middle across BirthTime, Middle held through PauseTime,
   *  Middle → End across Decay. Every stock row is white, 0 → 255 → 0 alpha. */
  start: [number, number, number, number];
  middle: [number, number, number, number];
  end: [number, number, number, number];
}

interface Row {
  string(key: string): string | undefined;
}

export class UberSplatRegistry {
  constructor(private defs: Map<string, UberSplatDef>) {}
  get(id: string): UberSplatDef | undefined {
    return this.defs.get(id.toUpperCase());
  }
  get size(): number {
    return this.defs.size;
  }
}

// UberSplatData.slk lives under Splats\ (NOT TerrainArt\) — verified in War3x.mpq.
const SLK = "Splats\\UberSplatData.slk";

export function loadUberSplatRegistry(vfs: DataSource): UberSplatRegistry {
  const defs = new Map<string, UberSplatDef>();
  const bytes = vfs.rawBytes(SLK);
  if (!bytes) return new UberSplatRegistry(defs);
  const table = new MappedData(new TextDecoder("windows-1252").decode(bytes));

  for (const id of Object.keys(table.map)) {
    const r = table.getRow(id) as Row | undefined;
    if (!r) continue;
    const dir = str(r, "dir");
    const file = str(r, "file");
    if (!dir || !file) continue; // header / empty rows
    defs.set(id.toUpperCase(), {
      id,
      texture: `${dir.replace(/\//g, "\\")}\\${file}.blp`,
      scale: num(r, "scale", 100),
      blend: num(r, "blendmode", 0),
      birthTime: num(r, "birthtime", 0),
      pauseTime: num(r, "pausetime", 0),
      decay: num(r, "decay", 0),
      start: rgba(r, "start", 0),
      middle: rgba(r, "middle", 255),
      end: rgba(r, "end", 0),
    });
  }
  return new UberSplatRegistry(defs);
}

/** One of the envelope's colours: `<phase>R/G/B/A` as 0..1, white by default with `alpha`. */
function rgba(row: Row, phase: string, alpha: number): [number, number, number, number] {
  return [num(row, `${phase}r`, 255) / 255, num(row, `${phase}g`, 255) / 255, num(row, `${phase}b`, 255) / 255, num(row, `${phase}a`, alpha) / 255];
}

// SLK cells use "-" for "none"; treat that (and missing) as empty/default.
function str(row: Row, key: string): string {
  const v = row.string(key);
  return v === undefined || v === "-" ? "" : v;
}
function num(row: Row, key: string, fallback: number): number {
  const v = row.string(key);
  if (v === undefined || v === "-") return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}
