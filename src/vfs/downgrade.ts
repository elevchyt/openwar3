import type { DataSource } from "./types";
import { normalize } from "../patches";
import { patchTable, type FileEdits, type PatchProblem } from "../patches/tables";
import DOWNGRADE_1_31_1 from "../patches/downgrade/1.31.1.json";

// A 1.31.1 store, played as the 1.30.4 it came from (docs/casc.md, "1.31.1").
//
// "Download game files" falls back on the Internet Archive's Warcraft III, and the only copy it
// keeps is 1.31.1 (src/assets/downloadInstall.ts). OpenWar3 plays 1.30.4 and every player must
// read the same game data (src/vfs/version.ts), so a 1.31.1 store is turned back into 1.30.4 at
// the mount, in two halves:
//
//   • its LAYOUT — 1.31.0's `War3.w3mod` tree in place of 1.30's archive names — is renamed back
//     where the root is read (vfs/casc.ts `legacyRootName`);
//   • its GAME DATA — every cell of every object table 1.31.0 and 1.31.1 changed, in all four
//     data sets — is put back here, from `src/patches/downgrade/1.31.1.json`: the 1.30.4 value
//     of each cell, made by `node tools/patch-extract.mjs --install <1.31.1> --downgrade` off the
//     two builds' own tables and checked by the same tool to leave NO difference behind.
//
// What it does not turn back is ART and WORDING — 1.31 re-encoded textures and reworded tooltips
// for its hotkey editor. Neither is game data, and putting either back would mean shipping
// Blizzard's bytes, which this repository never does (CLAUDE.md, legal boundary): the edits are
// values in the game's terms, exactly as a patch is.
//
// It sits UNDER `PatchDataSource`, so the later patches are laid over 1.30.4's tables exactly as
// they are on a 1.30.4 install, and it is not scoped to the live melee set the way a patch is —
// a downgrade has to reach every set the newer build touched.

const EDITS: Record<string, Record<string, FileEdits>> = {
  "1.31.1": (DOWNGRADE_1_31_1 as unknown as { files: Record<string, FileEdits> }).files,
};

/** The edits that turn `version` (a `.build.info` Version) back into 1.30.4, or null when it
 *  needs none. */
export function downgradeEdits(version: string | null): Record<string, FileEdits> | null {
  const build = version?.split(".").slice(0, 3).join(".") ?? "";
  return EDITS[build] ?? null;
}

export class DowngradeDataSource implements DataSource {
  private edits = new Map<string, FileEdits>();
  private cache = new Map<string, Uint8Array | null>();
  /** Everything that did not apply — logged once per file. */
  readonly problems: PatchProblem[] = [];

  constructor(
    private base: DataSource,
    edits: Record<string, FileEdits>,
    private from: string,
  ) {
    for (const [path, e] of Object.entries(edits)) this.edits.set(normalize(path), e);
  }

  get label(): string {
    return `${this.base.label} as 1.30.4`;
  }

  private downgraded(path: string): Uint8Array | null {
    const key = normalize(path);
    const edits = this.edits.get(key);
    if (!edits) return null;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const bytes = this.base.rawBytes(path);
    let out: Uint8Array | null = null;
    if (bytes) {
      const problems: PatchProblem[] = [];
      out = patchTable(path, bytes, edits, problems);
      for (const p of problems) console.warn(`[downgrade ${this.from}] ${p.file} [${p.row}]: ${p.message}`);
      this.problems.push(...problems);
    }
    this.cache.set(key, out);
    return out;
  }

  exists(path: string): boolean {
    return this.base.exists(path);
  }

  async read(path: string): Promise<Uint8Array> {
    return this.downgraded(path) ?? this.base.read(path);
  }

  rawBytes(path: string): Uint8Array | null {
    return this.downgraded(path) ?? this.base.rawBytes(path);
  }

  list(): string[] {
    return this.base.list();
  }

  openArchive(path: string): DataSource | null {
    return this.base.openArchive?.(path) ?? null;
  }
}
