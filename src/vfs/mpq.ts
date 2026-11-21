import mpqParser from "mdx-m3-viewer/dist/cjs/parsers/mpq";
import { type DataSource, normalizeMpqPath } from "./types";

// One WC3 MoPaQ (MPQ v1) archive as a DataSource, backed by mdx-m3-viewer's
// battle-tested parser (plan §1 "borrow parsing", §3 oracle). Handles the WC3
// compression set (PKWARE implode, zlib, huffman+ADPCM, bzip2) internally.

type MpqArchive = InstanceType<typeof mpqParser.Archive>;

export class MpqDataSource implements DataSource {
  private archive: MpqArchive;

  constructor(readonly label: string, buffer: Uint8Array) {
    this.archive = new mpqParser.Archive();
    this.archive.load(buffer, true); // readonly — we never write back
  }

  /**
   * The name to ask the archive for. An MPQ has no folders: a file is found by the hash of its
   * WHOLE name, so `\Naruto.mdx` and `Naruto.mdx` are two different entries — and a map may
   * import a file under the first. Angel Arena Allstars does it 66 times over (its `UnitUI.slk`
   * says `file` = `\Naruto`, the game appends `.mdx` and Storm hashes exactly that), and with
   * the leading backslash dropped none of them was ever found: heroes with no body, effects
   * and sounds that never played. So the name AS WRITTEN is asked first, and the stripped form
   * (`/war3map.j`, a caller's stray leading slash) only when the archive has no such entry.
   */
  private nameOf(path: string): string {
    const stripped = normalizeMpqPath(path);
    const written = path.replace(/\//g, "\\");
    return written !== stripped && this.archive.has(written) ? written : stripped;
  }

  exists(path: string): boolean {
    return this.archive.has(this.nameOf(path));
  }

  async read(path: string): Promise<Uint8Array> {
    const bytes = this.rawBytes(path);
    if (!bytes) throw new Error(`${this.label}: file not found: ${path}`);
    return bytes;
  }

  /** Synchronous read — returns null if absent (MPQ decode is itself sync). */
  rawBytes(path: string): Uint8Array | null {
    const file = this.archive.get(this.nameOf(path));
    return file ? file.bytes() : null; // decodes + decompresses on demand
  }

  list(): string[] {
    // load() auto-applies the internal (listfile); drop MPQ metadata entries.
    return this.archive.getFileNames().filter((n) => !n.startsWith("("));
  }
}
