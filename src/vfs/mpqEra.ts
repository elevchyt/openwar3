import { MpqDataSource } from "./mpq";
import { type DataSource, type LoadProgress, normalizeMpqPath } from "./types";

// An MPQ-era install (every build before 1.30), mounted as the game mounted it (issue #319).
//
// Before the content store there were archives beside the exe, and three generations of them,
// measured with tools/version-survey.mjs against real installs of 1.21a, 1.28.5, 1.29.1 and
// 1.29.2 (the "Warcraft III (Legacy)" Battle.net ships beside Reforged):
//
//   ≤ 1.27b   war3.mpq < war3x.mpq < war3xlocal.mpq < war3patch.mpq
//   1.28.x    War3.mpq < War3Local.mpq < War3x.mpq < War3xLocal.mpq < War3Patch.mpq
//   1.29.x    Deprecated.mpq < War3.mpq < War3Local.mpq < War3x.mpq < War3xLocal.mpq
//
// They are ONE order with names missing, so it is written as one: every archive of the list a
// folder has is mounted, lowest first, and a later one wins. `War3Local` is Reign of Chaos's
// locale and sits directly over the base it localizes; 1.29 folded the patch archive into the
// four it patched and moved the art old custom maps reference into `Deprecated.mpq`, which is
// the name and the job that archive still has in a 1.30.4 store (src/vfs/casc.ts).
//
// Two things an MPQ mount has to answer that a list of layers does not:
//
//   • A TILESET's own art (src/vfs/tileset.ts). `War3.mpq` and `War3x.mpq` each carry a nested
//     `<letter>.mpq`, and the two halves of one tileset are in different parents — Sunken Ruins'
//     cliffs are in War3x's `Z.mpq`, Lordaeron's creep skins in both `L.mpq`s. A 1.30.4 store
//     spells such a file `Z.mpq:<path>`, so that is the name answered here, across every parent.
//   • A file its archive's (listfile) does not name. An MPQ finds a file by the HASH of its
//     name and the listfile is a courtesy: 1.21a's archives hold 333 files of 1.30.4's that no
//     listfile mentions. `exists` and the reads therefore never consult the list.

/** Lowest priority first. Every archive name the MPQ era used; a folder has a subset. */
export const MPQ_ERA_ORDER = ["deprecated.mpq", "war3.mpq", "war3local.mpq", "war3x.mpq", "war3xlocal.mpq", "war3patch.mpq"] as const;

/** Is this folder an MPQ-era install OpenWar3 can play — the base game AND The Frozen Throne?
 *  Asked of the folder's top-level file names, before anything is read. It wins over a
 *  `.build.info`: the Legacy install Battle.net ships has both, and its `Data\` is the
 *  launcher's own small store rather than the game. */
export function isMpqEraInstall(names: Iterable<string>): boolean {
  const have = new Set([...names].map((n) => n.toLowerCase()));
  return have.has("war3.mpq") && have.has("war3x.mpq");
}

const TILESET_PATH = /^([a-z])\.mpq:(.+)$/i;

export class MpqEraDataSource implements DataSource {
  /** Highest priority first. */
  private layers: MpqDataSource[] = [];
  /** Tileset letter → its nested archives, highest parent first; opened on first use. */
  private tilesets = new Map<string, MpqDataSource[]>();
  /** The archives mounted, lowest first, as the folder spells them. */
  mounted: string[] = [];

  static async open(files: Map<string, { name?: string; arrayBuffer(): Promise<ArrayBuffer> }>, onProgress?: LoadProgress): Promise<MpqEraDataSource> {
    const source = new MpqEraDataSource();
    const byName = new Map([...files].map(([key, file]) => [key.toLowerCase(), file]));
    const present = MPQ_ERA_ORDER.filter((name) => byName.has(name));
    for (const [i, name] of present.entries()) {
      const file = byName.get(name)!;
      const label = file.name ?? name;
      onProgress?.(`Mounting ${label}…`, i / present.length);
      source.layers.unshift(new MpqDataSource(label, new Uint8Array(await file.arrayBuffer())));
      source.mounted.push(label);
    }
    if (!source.layers.length) throw new Error("No Warcraft III archives in this folder.");
    return source;
  }

  get label(): string {
    return `mpq[${this.mounted.join(" < ")}]`;
  }

  private tileset(letter: string): MpqDataSource[] {
    const key = letter.toLowerCase();
    let nested = this.tilesets.get(key);
    if (!nested) {
      nested = [];
      for (const layer of this.layers) {
        const bytes = layer.rawBytes(`${key}.mpq`);
        if (!bytes) continue;
        try {
          nested.push(new MpqDataSource(`${layer.label}:${key}.mpq`, bytes));
        } catch {
          // Not an archive after all — a tileset this parent does not carry.
        }
      }
      this.tilesets.set(key, nested);
    }
    return nested;
  }

  /** The sources to ask for `path`, and the name to ask them for. */
  private route(path: string): { sources: MpqDataSource[]; name: string } {
    const m = TILESET_PATH.exec(normalizeMpqPath(path));
    return m ? { sources: this.tileset(m[1]), name: m[2] } : { sources: this.layers, name: path };
  }

  exists(path: string): boolean {
    const { sources, name } = this.route(path);
    return sources.some((s) => s.exists(name));
  }

  rawBytes(path: string): Uint8Array | null {
    const { sources, name } = this.route(path);
    for (const s of sources) {
      const bytes = s.rawBytes(name);
      if (bytes) return bytes;
    }
    return null;
  }

  async read(path: string): Promise<Uint8Array> {
    const bytes = this.rawBytes(path);
    if (!bytes) throw new Error(`${this.label}: file not found: ${path}`);
    return bytes;
  }

  private names: string[] | null = null;

  /** What the listfiles name — NOT everything `exists` answers for (see the header). */
  list(): string[] {
    if (!this.names) {
      const all = new Set<string>();
      for (const layer of this.layers) for (const name of layer.list()) all.add(name);
      this.names = [...all].sort();
    }
    return this.names;
  }
}

// ---------------------------------------------------------------------------------------------
// Which build is it?

/** FNV-1a, 32 bits, as eight hex digits. */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The tables a build is told apart by: the balance of every unit and of every ability, and
 *  Reign of Chaos's melee abilities — the one table 1.29.2 has and 1.29.1 does not, with every
 *  live table the same between them. */
export const FINGERPRINT_FILES = ["Units\\UnitBalance.slk", "Units\\AbilityData.slk", "Melee_V0\\Units\\AbilityData.slk"] as const;

/**
 * A build's fingerprint: a hash of its live balance tables.
 *
 * An MPQ install does not say which patch it is — there is no `.build.info`, and the version in
 * the exe's resources is not something a browser can read out of a folder handle. What it IS can
 * be read, though, and is the better question: the normalization (src/vfs/normalize.ts) is stated
 * against a build's TABLES, so the tables are what picks it.
 */
export function buildFingerprint(source: DataSource): string {
  const parts = FINGERPRINT_FILES.map((f) => source.rawBytes(f) ?? new Uint8Array(0));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return fnv1a(all);
}
