import { decodeBlte } from "./blte";
import { type DataSource, normalizeMpqPath } from "./types";

/**
 * CASC — the storage a Warcraft III 1.30+ install uses in place of MPQ archives (issue #102).
 *
 * The MPQ-era install we started on is four MoPaQ files; 1.30.4's `Data/` folder is Blizzard's
 * NGDP content store, and NOTHING in it is addressed by name. Four indirections stand between
 * a path and its bytes, and all four have to be walked before the first file can be read:
 *
 *   `.build.info`   a `|`-separated table beside the exe. Its Build Key names…
 *   build config    …a `key = value` text file under `Data/config/<xx>/<yy>/<hash>`, which
 *                   names the `root` and the `encoding` file by content key.
 *   encoding        CKey (what a file's contents hash to) → EKey (what its STORED form hashes
 *                   to). Content addressing is the whole point: two files with identical bytes
 *                   are one entry, which is why the eleven locales cost far less than 11×.
 *   `.idx`          EKey (first 9 bytes) → (data file, offset, length). Sixteen buckets, and
 *                   each bucket is versioned — `0000000009.idx` and `000000000a.idx` are the
 *                   same bucket and only the higher one is live.
 *
 * The bytes at that offset are a 30-byte record header followed by a BLTE payload (blte.ts).
 *
 * Warcraft III's ROOT is a plain-text listing, one line per file:
 *
 *     War3.mpq:Units/UnitData.slk|bd17648d524aaab3d54f4d3affe58613|
 *     enUS-War3Local.mpq:UI/CampaignStrings_exp.txt|ebbf1847…|enUS
 *
 * — which is to say 1.30 kept the MPQ layering in NAME even after dropping the format. The
 * archives it names are `Deprecated.mpq` (art old custom maps still reference), `War3.mpq`
 * (everything shared) and one `<locale>-War3Local.mpq`, and they layer in that order, exactly
 * as war3.mpq < war3x.mpq < war3xlocal.mpq did (profiles.ts). Verified against the retail
 * 1.30.4 build: the three sets are disjoint but for two files, so the order barely bites —
 * but it is the order the paths themselves imply, so it is the one we mount.
 *
 * A campaign map is the one thing that does NOT survive the move: `Maps/.../OrcX01.w3x` is
 * not a blob in CASC, it is ~22 root entries of the form `…OrcX01.w3x:war3map.j`. The map got
 * flattened into the store along with everything else. `openArchive()` puts it back together
 * as a DataSource, which is all any caller ever wanted from those bytes anyway.
 */

/** A file read in ranges rather than whole: a picked `File`, or the dev server's HTTP reader.
 *  `data.000` is a gigabyte — reading it whole to reach a 4 KB .slk is not an option. */
export interface ByteReader {
  readonly size: number;
  slice(start: number, end: number): Promise<Uint8Array>;
}

/** A `File` (or any Blob) as a ByteReader. */
export function fileReader(file: Blob): ByteReader {
  return {
    size: file.size,
    slice: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
  };
}

/** The pieces of a CASC storage a mount needs, as gathered by the install picker. */
export interface CascFiles {
  /** Text of `.build.info`. */
  buildInfo: string;
  /** `Data/config/**` — hash → file text. Only a handful of these are ever read. */
  config: Map<string, string>;
  /** `Data/data/*.idx` — file name → bytes (32 × 64 KB). */
  idx: Map<string, Uint8Array>;
  /** `Data/data/data.NNN` — NNN → reader. */
  data: Map<number, ByteReader>;
}

/** True when a picked folder is a 1.30+ CASC install rather than an MPQ-era one. */
export function isCascInstall(files: CascFiles | null): files is CascFiles {
  return !!files && files.buildInfo.length > 0 && files.data.size > 0 && files.idx.size > 0;
}

// ---------------------------------------------------------------------------
// The four indirections
// ---------------------------------------------------------------------------

/** One `.build.info` row, by column name. The file is a header row of `Name!TYPE:size`
 *  followed by one row per installed branch; the active branch is the one we want. */
function parseBuildInfo(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error(".build.info: no branch rows");
  const columns = lines[0].split("|").map((c) => c.split("!")[0].trim());
  const rows = lines.slice(1).map((l) => {
    const cells = l.split("|");
    return new Map(columns.map((c, i) => [c, cells[i] ?? ""]));
  });
  return rows.find((r) => r.get("Active") === "1") ?? rows[0];
}

/** A build/CDN config: `key = value`, `#` comments. Values with two hashes are `CKey EKey`. */
function parseConfig(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

/** Where one stored file sits: which `data.NNN`, at what offset, how many bytes. */
interface Location {
  archive: number;
  offset: number;
  /** Includes the 30-byte record header that precedes the BLTE payload. */
  size: number;
}

/** The 30-byte record header in front of every BLTE payload inside a `data.NNN`. */
const RECORD_HEADER = 30;

/**
 * The local index: EKey → Location. Sixteen buckets, each shipped as `<bucket><version>.idx`,
 * and only the highest version of a bucket is live — mounting a stale one resolves keys to
 * offsets that were reused by a later patch, which reads as corrupt data rather than as a
 * missing file.
 */
function parseIndex(idx: Map<string, Uint8Array>): Map<string, Location> {
  const live = new Map<number, { version: number; bytes: Uint8Array }>();
  for (const [name, bytes] of idx) {
    const m = /^([0-9a-f]{2})([0-9a-f]{8})\.idx$/i.exec(name);
    if (!m) continue;
    const bucket = parseInt(m[1], 16);
    const version = parseInt(m[2], 16);
    const prev = live.get(bucket);
    if (!prev || version > prev.version) live.set(bucket, { version, bytes });
  }

  const out = new Map<string, Location>();
  for (const { bytes } of live.values()) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = view.getUint32(0, true);
    // header: version(2) bucket(1) extra(1) spanSize(1) spanOffset(1) key(1) segmentBits(1)
    const spanSizeBytes = bytes[8 + 4];
    const spanOffsetBytes = bytes[8 + 5];
    const keyBytes = bytes[8 + 6];
    const segmentBits = bytes[8 + 7];
    // The entry block is aligned to 16 from the start of the file, not merely padded to the
    // header's own size — 8 + 16 lands on 24 and the entries actually begin at 32.
    let p = (8 + headerSize + 15) & ~15;
    const entriesSize = view.getUint32(p, true);
    p += 8; // size + hash
    const entryLength = keyBytes + spanOffsetBytes + spanSizeBytes;
    const segment = 2 ** segmentBits;
    for (const end = p + entriesSize; p + entryLength <= end; p += entryLength) {
      // The span offset is BIG-endian and 40 bits wide: the top bits pick the data file, the
      // low `segmentBits` are the offset inside it.
      let span = 0;
      for (let i = 0; i < spanOffsetBytes; i++) span = span * 256 + bytes[p + keyBytes + i];
      const size = view.getUint32(p + keyBytes + spanOffsetBytes, true);
      if (size === 0) continue; // a freed entry
      out.set(hex(bytes, p, keyBytes), {
        archive: Math.floor(span / segment),
        offset: span % segment,
        size,
      });
    }
  }
  return out;
}

/** CKey → the EKey its bytes are stored under. (The e-key half of the file is not read: we
 *  never need to go the other way.) */
function parseEncoding(bytes: Uint8Array): Map<string, string> {
  if (bytes[0] !== 0x45 || bytes[1] !== 0x4e) throw new Error("encoding: bad magic (want 'EN')");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cKeySize = bytes[3];
  const eKeySize = bytes[4];
  const pageKB = view.getUint16(5); // c-key page size, in KB
  const pageCount = view.getUint32(9);
  const especSize = view.getUint32(18);
  // 22 = the header, then the ESpec string block, then a page index we don't need (each page
  // is self-describing), then the pages themselves.
  const pages = 22 + especSize + pageCount * (cKeySize + 16);
  const pageSize = pageKB * 1024;

  const out = new Map<string, string>();
  for (let i = 0; i < pageCount; i++) {
    const start = pages + i * pageSize;
    for (let p = start; p + 6 + cKeySize <= start + pageSize; ) {
      const keyCount = bytes[p]; // 0 = the page's entries are done (pages are zero-padded)
      if (keyCount === 0) break;
      out.set(hex(bytes, p + 6, cKeySize), hex(bytes, p + 6 + cKeySize, eKeySize));
      p += 6 + cKeySize + keyCount * eKeySize;
    }
  }
  return out;
}

function hex(bytes: Uint8Array, at: number, length: number): string {
  let s = "";
  for (let i = at; i < at + length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

/** A file's own EKey is 16 bytes; the index is keyed by the first 9. */
const INDEX_KEY_HEX = 18;

// ---------------------------------------------------------------------------
// The root listing
// ---------------------------------------------------------------------------

/** Mount order, LOWEST priority first — the CASC spelling of profiles.ts's archive list.
 *  `%s` stands in for the install's locale. */
const ARCHIVE_ORDER = ["Deprecated.mpq", "War3.mpq", "%s-War3Local.mpq"] as const;

/** The locale archives a Warcraft III install can carry; a given install ships exactly one. */
const LOCALES = ["enUS", "deDE", "esES", "frFR", "itIT", "koKR", "plPL", "ruRU", "zhCN", "zhTW"];

/** Files big enough — and rare enough per session — that they are read on demand instead of
 *  being held in memory. Audio and video are 1.3 GB of a 1.6 GB install and every one of them
 *  is fetched through the ASYNC `read()` (audio/sounds.ts decodes into an AudioBuffer), so
 *  nothing sync ever asks for them. Everything else preloads; see `CascDataSource.preload`. */
const STREAMED = /\.(wav|mp3|avi|flac|ogg)$/i;

/** One root line: `<archive>:<path>|<ckey>|<locale>`, or an unprefixed installer file. */
interface RootEntry {
  /** The logical path in MPQ form (`Units\UnitData.slk`), original case. */
  path: string;
  ckey: string;
}

function parseRoot(text: string): Map<string, RootEntry[]> {
  const byArchive = new Map<string, RootEntry[]>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const bar = line.indexOf("|");
    if (bar < 0) continue;
    const name = line.slice(0, bar);
    const colon = name.indexOf(":");
    if (colon < 0) continue; // an installer file (the exes, the .app bundles) — not game data
    const archive = name.slice(0, colon);
    const ckey = line.slice(bar + 1, line.indexOf("|", bar + 1));
    let list = byArchive.get(archive);
    if (!list) byArchive.set(archive, (list = []));
    // The rest of the name keeps its inner `:` separators: a campaign map's contents are
    // `Maps/…/OrcX01.w3x:war3map.j`, and openArchive() finds them by that prefix.
    list.push({ path: name.slice(colon + 1).replace(/\//g, "\\"), ckey });
  }
  return byArchive;
}

// ---------------------------------------------------------------------------
// The DataSource
// ---------------------------------------------------------------------------

/** How many decoded bytes to keep around. A decoded install is ~585 MB, which is more than
 *  the compressed 291 MB we already hold, so decoded files are a CACHE and not the store. */
const DECODED_BUDGET = 96 * 1024 * 1024;

/** Reads are coalesced into runs: entries this close together are fetched in one slice, since
 *  one 8 MB read beats two hundred 40 KB reads by far more than the skipped bytes cost. */
const COALESCE_GAP = 256 * 1024;

interface Entry {
  ckey: string;
  location: Location;
  /** Preloaded BLTE payload (record header already stripped), or null while streamed. */
  raw: Uint8Array | null;
}

export class CascDataSource implements DataSource {
  readonly label: string;
  /** Lower-cased logical path → entry. Built lowest-archive-first so a later layer wins. */
  private entries = new Map<string, Entry>();
  /** Path as the root spells it, for `list()`. */
  private names: string[] = [];
  private decoded = new Map<string, Uint8Array>();
  private decodedBytes = 0;

  private constructor(
    label: string,
    private data: Map<number, ByteReader>,
  ) {
    this.label = label;
  }

  /** The archives that resolved, lowest priority first — what the gate reports as "mounted". */
  mounted: string[] = [];
  /** What each of those archives contributes, in the same order. The merged view above keeps
   *  only the winner of each path, so this is the only record of who owns and who overrides —
   *  which is what the extractor's override report is (tools/extract-data.mjs). */
  private contents: Array<{ archive: string; paths: string[] }> = [];

  archiveContents(): Array<{ archive: string; paths: string[] }> {
    return this.contents;
  }

  static async open(
    files: CascFiles,
    onProgress?: (message: string) => void,
  ): Promise<CascDataSource> {
    const info = parseBuildInfo(files.buildInfo);
    const buildKey = info.get("Build Key");
    if (!buildKey) throw new Error(".build.info: no Build Key");
    const configText = files.config.get(buildKey.toLowerCase());
    if (!configText) throw new Error(`build config ${buildKey} is missing from Data/config`);
    const build = parseConfig(configText);

    const index = parseIndex(files.idx);
    if (index.size === 0) throw new Error("Data/data holds no usable .idx entries");

    const source = new CascDataSource(
      `casc[${info.get("Version") ?? "unknown"}]`,
      files.data,
    );

    // Bootstrap: encoding is named by EKey directly, so it can be read before we have the
    // CKey→EKey table that everything else needs.
    onProgress?.("Reading the content index…");
    const encodingEKey = (build.get("encoding") ?? "").split(" ")[1];
    if (!encodingEKey) throw new Error("build config names no encoding file");
    const encoding = parseEncoding(
      await source.readLocation(index.get(encodingEKey.slice(0, INDEX_KEY_HEX)), "encoding"),
    );

    const rootCKey = (build.get("root") ?? "").split(" ")[0];
    const rootEKey = encoding.get(rootCKey);
    if (!rootEKey) throw new Error("the encoding table has no entry for the root file");
    const rootText = new TextDecoder("latin1").decode(
      await source.readLocation(index.get(rootEKey.slice(0, INDEX_KEY_HEX)), "root"),
    );

    const byArchive = parseRoot(rootText);
    source.mount(byArchive, encoding, index, pickLocale(info, byArchive, encoding, index));
    await source.preload(onProgress);
    return source;
  }

  /** Fold the root's archives into one path→entry map, in mount order. */
  private mount(
    byArchive: Map<string, RootEntry[]>,
    encoding: Map<string, string>,
    index: Map<string, Location>,
    locale: string,
  ): void {
    for (const template of ARCHIVE_ORDER) {
      const archive = template.replace("%s", locale);
      const list = byArchive.get(archive);
      if (!list) continue;
      const paths: string[] = [];
      for (const { path, ckey } of list) {
        const ekey = encoding.get(ckey);
        const location = ekey && index.get(ekey.slice(0, INDEX_KEY_HEX));
        // A root entry with no local index entry is content this install did not download
        // (another platform's, or an optional locale). It is not an error; it is absent.
        if (!location) continue;
        const key = path.toLowerCase();
        if (!this.entries.has(key)) this.names.push(path);
        this.entries.set(key, { ckey, location, raw: null });
        paths.push(path);
      }
      if (paths.length > 0) {
        this.mounted.push(archive);
        this.contents.push({ archive, paths });
      }
    }
    if (this.entries.size === 0) {
      throw new Error("no Warcraft III archives in this CASC storage — is Data/ complete?");
    }
  }

  /**
   * Pull every non-streamed file into memory, compressed, in one sequential sweep.
   *
   * The VFS contract has a SYNCHRONOUS `rawBytes()` (vfs/types.ts) and half the engine reads
   * through it — the SLK tables, the fonts, the cursors, and `resolveModelSounds` parsing an
   * .mdx mid-combat. A Blob can only be read asynchronously, so the bytes have to be here
   * before the first caller asks. Compressed, that is ~291 MB for a 1.30.4 install, which is
   * less than the ~1 GB the four MPQs already cost us; the 1.3 GB of audio and video is what
   * we leave on disk, because every one of those goes through the async path.
   */
  private async preload(onProgress?: (message: string) => void): Promise<void> {
    // Unique by location: the eleven locales share most of their content, and even inside one
    // locale `Units\MiscData.txt` and `Melee_V0\Units\MiscData.txt` are one stored file.
    const wanted = new Map<string, Location>();
    for (const [key, entry] of this.entries) {
      if (STREAMED.test(key)) continue;
      wanted.set(`${entry.location.archive}:${entry.location.offset}`, entry.location);
    }

    const byArchive = new Map<number, Location[]>();
    let total = 0;
    for (const location of wanted.values()) {
      let list = byArchive.get(location.archive);
      if (!list) byArchive.set(location.archive, (list = []));
      list.push(location);
      total += location.size - RECORD_HEADER;
    }

    const store = new Uint8Array(total);
    const at = new Map<string, Uint8Array>();
    let written = 0;
    let done = 0;

    for (const [archive, list] of byArchive) {
      const reader = this.data.get(archive);
      if (!reader) continue;
      list.sort((a, b) => a.offset - b.offset);
      for (let i = 0; i < list.length; ) {
        // Grow a run while the next entry is close enough that reading the gap is cheaper
        // than issuing a second read.
        let end = list[i].offset + list[i].size;
        let j = i + 1;
        while (j < list.length && list[j].offset - end <= COALESCE_GAP) {
          end = Math.max(end, list[j].offset + list[j].size);
          j++;
        }
        const runStart = list[i].offset;
        const run = await reader.slice(runStart, Math.min(end, reader.size));
        for (let k = i; k < j; k++) {
          const from = list[k].offset - runStart + RECORD_HEADER;
          const length = list[k].size - RECORD_HEADER;
          store.set(run.subarray(from, from + length), written);
          at.set(`${archive}:${list[k].offset}`, store.subarray(written, written + length));
          written += length;
        }
        done += j - i;
        i = j;
        onProgress?.(`Loading game data… ${Math.round((done / wanted.size) * 100)}%`);
      }
    }

    for (const entry of this.entries.values()) {
      entry.raw = at.get(`${entry.location.archive}:${entry.location.offset}`) ?? null;
    }
  }

  /** Read one stored file's BLTE payload straight off the data file (no cache). */
  private async readLocation(location: Location | undefined, label: string): Promise<Uint8Array> {
    if (!location) throw new Error(`${this.label}: ${label} is not in the local index`);
    const reader = this.data.get(location.archive);
    if (!reader) throw new Error(`${this.label}: ${label} wants data.${location.archive}`);
    const raw = await reader.slice(location.offset, location.offset + location.size);
    return decodeBlte(raw.subarray(RECORD_HEADER), label);
  }

  private remember(key: string, bytes: Uint8Array): Uint8Array {
    if (this.decodedBytes + bytes.length > DECODED_BUDGET) {
      // Plain FIFO. The access pattern is "read a table once, then never again", so a real
      // LRU would buy nothing over dropping whatever came first.
      for (const [k, v] of this.decoded) {
        this.decoded.delete(k);
        this.decodedBytes -= v.length;
        if (this.decodedBytes + bytes.length <= DECODED_BUDGET) break;
      }
    }
    this.decoded.set(key, bytes);
    this.decodedBytes += bytes.length;
    return bytes;
  }

  exists(path: string): boolean {
    return this.entries.has(normalizeMpqPath(path).toLowerCase());
  }

  rawBytes(path: string): Uint8Array | null {
    const key = normalizeMpqPath(path).toLowerCase();
    const cached = this.decoded.get(key);
    if (cached) return cached;
    const entry = this.entries.get(key);
    // `raw` is null for the streamed files (audio, video). Those are read through `read()`,
    // and nothing in the engine reaches for one synchronously.
    if (!entry?.raw) return null;
    return this.remember(key, decodeBlte(entry.raw, path));
  }

  async read(path: string): Promise<Uint8Array> {
    const key = normalizeMpqPath(path).toLowerCase();
    const cached = this.decoded.get(key);
    if (cached) return cached;
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`${this.label}: file not found: ${path}`);
    if (entry.raw) return this.remember(key, decodeBlte(entry.raw, path));
    // Streamed: a ranged read, and deliberately NOT cached — these are the megabyte files,
    // and their callers (audio/sounds.ts) keep their own decoded copies.
    return this.readLocation(entry.location, path);
  }

  list(): string[] {
    return this.names;
  }

  /**
   * A map that CASC stores exploded rather than as a `.w3x` blob — every campaign chapter.
   * Returns a DataSource over the entries filed under `<path>:`, or null if this install has
   * no such map. (An MPQ source has no exploded maps at all, so it does not implement this.)
   */
  openArchive(path: string): DataSource | null {
    const prefix = `${normalizeMpqPath(path).toLowerCase()}:`;
    const inner = new Map<string, string>();
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) inner.set(key.slice(prefix.length), key);
    }
    if (inner.size === 0) return null;
    return new CascSubArchive(path.split("\\").pop() ?? path, this, inner);
  }
}

/** One exploded map, presented as if it were the archive it used to be. Its own paths are
 *  relative (`war3map.j`); it forwards to the store under the full `<map>:<inner>` key. */
class CascSubArchive implements DataSource {
  constructor(
    readonly label: string,
    private store: CascDataSource,
    /** relative lower-cased name → the store's key. */
    private inner: Map<string, string>,
  ) {}

  private key(path: string): string | undefined {
    return this.inner.get(normalizeMpqPath(path).toLowerCase());
  }

  exists(path: string): boolean {
    return this.key(path) !== undefined;
  }

  rawBytes(path: string): Uint8Array | null {
    const key = this.key(path);
    return key ? this.store.rawBytes(key) : null;
  }

  async read(path: string): Promise<Uint8Array> {
    const key = this.key(path);
    if (!key) throw new Error(`${this.label}: file not found: ${path}`);
    return this.store.read(key);
  }

  list(): string[] {
    return [...this.inner.keys()];
  }
}

/**
 * Which `<locale>-War3Local.mpq` this install actually carries. `.build.info`'s Tags column
 * names it ("Windows EU? enUS speech?"), but a tag is a claim about what was REQUESTED, so it
 * is only a tie-breaker: the answer that counts is which locale archive's files are in the
 * local index, because an install downloads exactly one.
 */
function pickLocale(
  info: Map<string, string>,
  byArchive: Map<string, RootEntry[]>,
  encoding: Map<string, string>,
  index: Map<string, Location>,
): string {
  const present = (locale: string): number => {
    const list = byArchive.get(`${locale}-War3Local.mpq`);
    if (!list) return 0;
    let n = 0;
    for (const { ckey } of list) {
      const ekey = encoding.get(ckey);
      if (ekey && index.has(ekey.slice(0, INDEX_KEY_HEX))) n++;
    }
    return n;
  };
  const tagged = LOCALES.find((l) => (info.get("Tags") ?? "").includes(l));
  if (tagged && present(tagged) > 0) return tagged;
  let best = "enUS";
  let bestCount = -1;
  for (const locale of LOCALES) {
    const n = present(locale);
    if (n > bestCount) {
      best = locale;
      bestCount = n;
    }
  }
  return best;
}
