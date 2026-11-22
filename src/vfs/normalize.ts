import type { DataSource } from "./types";
import { normalize } from "../patches";
import { emptyTable, patchTable, type FileEdits, type PatchProblem } from "../patches/tables";
import { FINGERPRINTS, type Normalization } from "../patches/normalize";
import { buildFingerprint } from "./mpqEra";

// Another build of Warcraft III, played as 1.30.4 (docs/versions.md, issue #319).
//
// OpenWar3 is written against 1.30.4's tables, the patch chain is stated against them
// (src/vfs/patch.ts), and every player must read the same game data (src/vfs/version.ts). So an
// install of any other build has its object tables turned INTO 1.30.4's before anything reads
// them — forward for an MPQ-era build (1.21a … 1.29.2, the Legacy install Battle.net ships),
// back for the 1.31.1 store "Download game files" falls back on (docs/casc.md). The edits are
// `src/patches/normalize/<version>.json`: the 1.30.4 value of every cell that build has
// differently, in all four data sets, made by `tools/patch-extract.mjs --normalize` off the two
// builds' own tables and checked by it to leave NO cell of difference.
//
// Three things an older build needs that a 1.31.1 store does not:
//
//   • A DATA SET it files partly or not at all. 1.30.4 keeps four whole copies of every object
//     table (src/vfs/edition.ts); 1.28–1.29 file only the tables a set changes, and before 1.28
//     there are no sets. A set's table the build lacks therefore STARTS as the build's own live
//     table — which is what that build's game read there — and the edits are stated against that.
//     It has to be answered for (`exists`) even with no edits of its own, because the live table
//     beside it is being rewritten into something else.
//   • A TABLE it never shipped: made from nothing, from the header the edits carry (`create`).
//   • A COLUMN its SLK never had (1.30 added `legacyScale`): added by the rewrite (`grow`).
//
// What is NOT normalized is ART, WORDING and SCRIPTS — a build's own models and textures, its
// own tooltips, its own `common.j`/`Blizzard.j`. None is game data, and stating any of them
// would mean shipping Blizzard's bytes (CLAUDE.md, legal boundary). Art a later build added is
// answered by the fallback art instead (src/vfs/fallbackArt.ts).
//
// It sits UNDER `PatchDataSource`, so the later patches are laid over 1.30.4's tables exactly as
// they are on a 1.30.4 install, and it is not scoped to the live melee set the way a patch is.

const SET_TABLE = /^(custom_v0|custom_v1|melee_v0)\\(units\\[^\\]+\.(?:slk|txt))$/i;

/**
 * Which normalization an MPQ-era mount needs: the build its tables ARE, by fingerprint, or —
 * for a build nobody has measured (1.22 … 1.27b, 1.28.0 … 1.28.4, 1.29.0) — the nearest one
 * that has the same archive layout. `exact` is false then, and the mount says so: the edits
 * state 1.30.4's value for every cell the NEAREST build has differently, so a cell only the
 * unmeasured build changed is left as that build has it.
 */
export function mpqEraBuild(source: DataSource, mounted: string[]): { version: string; exact: boolean } {
  const known = FINGERPRINTS[buildFingerprint(source)];
  if (known) return { version: known, exact: true };
  const has = (name: string): boolean => mounted.some((m) => m.toLowerCase() === name);
  if (has("deprecated.mpq")) return { version: "1.29.2", exact: false };
  if (source.exists("Custom_V0\\Units\\UnitBalance.slk")) return { version: "1.28.5", exact: false };
  return { version: "1.21a", exact: false };
}

export class NormalizeDataSource implements DataSource {
  private edits = new Map<string, FileEdits>();
  private create = new Map<string, string[]>();
  private cache = new Map<string, Uint8Array | null>();
  /** Everything that did not apply — logged once per file. */
  readonly problems: PatchProblem[] = [];

  constructor(
    private base: DataSource,
    edits: Normalization,
    private from: string,
  ) {
    for (const [path, e] of Object.entries(edits.files)) this.edits.set(normalize(path), e);
    for (const [path, columns] of Object.entries(edits.create ?? {})) this.create.set(normalize(path), columns);
  }

  get label(): string {
    return `${this.base.label} as 1.30.4`;
  }

  /** What `path` starts as, before its edits: the build's own file, the live table a set's
   *  missing twin stands for, or a table made from nothing. Null when it is none of ours. */
  private start(key: string, path: string): Uint8Array | null | undefined {
    if (this.base.exists(path)) return this.edits.has(key) ? this.base.rawBytes(path) : undefined;
    const set = SET_TABLE.exec(key);
    if (set && this.base.exists(set[2])) return this.base.rawBytes(set[2]);
    const columns = this.create.get(key);
    return columns ? emptyTable(path, columns) : undefined;
  }

  /** `path` as 1.30.4 has it — undefined when this layer has nothing to say about it. */
  private normalized(path: string): Uint8Array | null | undefined {
    const key = normalize(path);
    if (this.cache.has(key)) return this.cache.get(key)!;
    const start = this.start(key, path);
    if (start === undefined) return undefined;
    let out = start;
    const edits = this.edits.get(key);
    if (out && edits) {
      const problems: PatchProblem[] = [];
      out = patchTable(path, out, edits, problems, false, true);
      for (const p of problems) console.warn(`[normalize ${this.from}] ${p.file} [${p.row}]: ${p.message}`);
      this.problems.push(...problems);
    }
    this.cache.set(key, out);
    return out;
  }

  exists(path: string): boolean {
    if (this.base.exists(path)) return true;
    const key = normalize(path);
    const set = SET_TABLE.exec(key);
    return (!!set && this.base.exists(set[2])) || this.create.has(key);
  }

  async read(path: string): Promise<Uint8Array> {
    return this.normalized(path) ?? this.base.read(path);
  }

  rawBytes(path: string): Uint8Array | null {
    const hit = this.normalized(path);
    return hit === undefined ? this.base.rawBytes(path) : hit;
  }

  list(): string[] {
    return this.base.list();
  }

  openArchive(path: string): DataSource | null {
    return this.base.openArchive?.(path) ?? null;
  }
}
