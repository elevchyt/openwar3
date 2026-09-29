import type { DataSource } from "./types";
import { dataSetFolder } from "../data/edition";
import { hasPatchedArt, normalize, onPatchLevelChange, patchedArt, patchedEdits } from "../patches";
import { patchTable, patchableFile, type PatchProblem } from "../patches/tables";
import { PATCH_ART } from "../patches/art";

// The game's later patches, laid over a 1.30.4 install (docs/patches.md, src/patches/).
//
// This sits UNDER `EditionDataSource`, and that order is the whole of the scoping rule: the
// edition overlay turns `Units\UnitBalance.slk` into `Custom_V1\Units\UnitBalance.slk` (or a
// `Melee_V0\`/`Custom_V0\` twin) before the path reaches here, and a patch only ever names the
// LIVE path — so a campaign chapter, a custom map and Reign of Chaos read their own frozen
// tables untouched, exactly as Blizzard left them. `dataSetFolder()` is asked as well, for the
// one case the path cannot tell: a file with no twin in the other set, which the edition overlay
// hands through at its live path.
//
// Only a 1.30.4 CASC store is wrapped (vfs/loader.ts). A patch states its values against 1.30.4,
// and an MPQ-era install is older than that — laying 1.31's rows over 1.27's tables would leave
// a game that is neither.
//
// A rewritten table is cached per path until the patch level moves, so the chain costs one
// parse and one write per file per session. Our own art (`art` in a patch — the Ritual Dagger's
// and Sundering Blades' icons) is served at its WC3 path from src/patches/art.ts.

export class PatchDataSource implements DataSource {
  private cache = new Map<string, Uint8Array | null>();
  /** Everything the chain could not apply — logged once, and what tools/patch-check.cjs fails on. */
  readonly problems: PatchProblem[] = [];

  constructor(private base: DataSource) {
    onPatchLevelChange(() => this.cache.clear());
  }

  get label(): string {
    return `${this.base.label} + patches`;
  }

  /** The bytes the patches make of `path`, null when the chain leaves it alone. */
  private patched(path: string): Uint8Array | null {
    if (dataSetFolder() !== null) return null; // not the live melee tables — see the header
    const key = normalize(path);
    if (this.cache.has(key)) return this.cache.get(key)!;
    let out: Uint8Array | null = null;
    const art = hasPatchedArt(path) ? PATCH_ART[patchedArt().find((p) => normalize(p) === key)!] : undefined;
    if (art !== undefined) {
      out = decodeBase64(art);
    } else {
      const edits = patchableFile(path) ? patchedEdits(path) : null;
      const bytes = edits ? this.base.rawBytes(path) : null;
      if (edits && bytes) {
        const problems: PatchProblem[] = [];
        out = patchTable(path, bytes, edits, problems, true);
        for (const p of problems) console.warn(`[patches] ${p.file} [${p.row}]: ${p.message}`);
        this.problems.push(...problems);
      }
    }
    this.cache.set(key, out);
    return out;
  }

  exists(path: string): boolean {
    return this.base.exists(path) || (dataSetFolder() === null && hasPatchedArt(path));
  }

  async read(path: string): Promise<Uint8Array> {
    return this.patched(path) ?? this.base.read(path);
  }

  rawBytes(path: string): Uint8Array | null {
    return this.patched(path) ?? this.base.rawBytes(path);
  }

  list(): string[] {
    const own = patchedArt().filter((p) => !this.base.exists(p));
    return own.length ? [...this.base.list(), ...own] : this.base.list();
  }

  openArchive(path: string): DataSource | null {
    return this.base.openArchive?.(path) ?? null;
  }
}

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
