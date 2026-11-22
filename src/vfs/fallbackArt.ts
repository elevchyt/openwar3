import type { DataSource } from "./types";
import { FALLBACK_ART_PATHS } from "../fallback/paths";

// Our own remakes of art an OLDER build lacks, served where the game would have it
// (src/fallback/README.md, docs/versions.md, issue #319).
//
// A build from before 1.29 has no widescreen console; one from before 1.28 has no edition
// switch. The engine asks for that art whatever the install is, OpenWar3 ships none of
// Blizzard's, and so the answer is art of OUR OWN: a PNG dropped into `src/fallback/art/` at
// the path the game files the original under is converted to a BLP (tools/patch-art.mjs) and
// answered here — at that path, for any install that has no file there.
//
// Three rules, and each is what makes it a FALLBACK:
//
//   • THE INSTALL WINS. A path the install has is never answered from here, so a 1.29+ player
//     sees Blizzard's console and only an older one sees ours.
//   • It is asked BEFORE anything is derived. `DerivedArtDataSource` sits above this layer and
//     derives only what nothing below it has, so drawing a remake retires the computed stand-in
//     for that file with no code change (the stone side panels, vfs/derivedArt.ts).
//   • It costs an up-to-date install nothing. The art is megabytes of base64, so only the list
//     of paths is always loaded; the art itself is fetched when this install lacks one of them.

function key(path: string): string {
  return path.replace(/\//g, "\\").replace(/^\\+/, "").toLowerCase();
}

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class FallbackArtDataSource implements DataSource {
  /** Lower-cased WC3 path → the BLP, for the paths this install lacks. */
  private art = new Map<string, Uint8Array>();
  /** The paths answered from here, as the game spells them — for the gate's report and tests. */
  readonly served: string[] = [];

  private constructor(private base: DataSource) {}

  /**
   * `base` with our remakes under it — or `base` itself, untouched, when it lacks none of them.
   * `art` is for the tests: the generated module's table, in place of the dynamic import.
   */
  static async over(base: DataSource, art?: Record<string, string>, paths: readonly string[] = FALLBACK_ART_PATHS): Promise<DataSource> {
    const lacking = paths.filter((p) => !base.exists(p));
    if (!lacking.length) return base;
    const table = art ?? (await import("../fallback/art")).FALLBACK_ART;
    const source = new FallbackArtDataSource(base);
    for (const path of lacking) {
      const blp = table[path];
      if (blp === undefined) continue; // paths.ts and art.ts out of step — `patch-art --check`
      source.art.set(key(path), decodeBase64(blp));
      source.served.push(path);
    }
    return source;
  }

  get label(): string {
    return `${this.base.label} + ${this.served.length} of our own`;
  }

  exists(path: string): boolean {
    return this.base.exists(path) || this.art.has(key(path));
  }

  async read(path: string): Promise<Uint8Array> {
    return this.base.exists(path) ? this.base.read(path) : (this.art.get(key(path)) ?? this.base.read(path));
  }

  rawBytes(path: string): Uint8Array | null {
    return this.base.rawBytes(path) ?? this.art.get(key(path)) ?? null;
  }

  list(): string[] {
    return this.served.length ? [...this.base.list(), ...this.served] : this.base.list();
  }

  openArchive(path: string): DataSource | null {
    return this.base.openArchive?.(path) ?? null;
  }
}
