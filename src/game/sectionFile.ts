// The container both of OpenWar3's own match files are written in — a REPLAY (`.o3r`,
// game/replay.ts) and a SAVED GAME (`.o3s`, game/save/saveFile.ts): four magic bytes, a 16-bit
// format number, then tagged sections `[tag:4][length:u32][gzip'd JSON]`. A reader skips a tag it
// does not know, so a newer writer can add a section without an older reader failing on it.
//
// Kept free of the DOM and the renderer: the headless round-trip tests compile it for Node.

/** gzip, through the platform's own stream (the page and Node 18+ both have it). */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** JSON that survives a non-finite number (an aura's `Infinity` would arrive as `null`). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? { $n: String(v) } : v));
}

export function fromJson(text: string): unknown {
  return JSON.parse(text, (_k, v) => (v && typeof v === "object" && typeof (v as { $n?: unknown }).$n === "string" && Object.keys(v).length === 1 ? Number((v as { $n: string }).$n) : v));
}

/** Write a section file. Each value is written with `toJson` unless it is already a string. */
export async function writeSectionFile(magic: readonly number[], format: number, sections: ReadonlyArray<readonly [string, unknown]>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [new Uint8Array([...magic, format & 0xff, format >> 8])];
  const enc = new TextEncoder();
  for (const [tag, value] of sections) {
    const body = await gzip(enc.encode(typeof value === "string" ? value : toJson(value)));
    const head = new Uint8Array(8);
    for (let i = 0; i < 4; i++) head[i] = tag.charCodeAt(i);
    new DataView(head.buffer).setUint32(4, body.length, true);
    parts.push(head, body);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The sections of a file, by tag, inflated and parsed — those `want` names. A section this
 *  reader does not know is skipped, not refused: that is the point of tags. Throws on a file
 *  with another magic (`what` names the kind in the message) or a format newer than `maxFormat`. */
export async function readSectionFile(
  bytes: Uint8Array, magic: readonly number[], maxFormat: number, want: readonly string[], what: string,
): Promise<Map<string, unknown>> {
  if (bytes.length < 6 || magic.some((b, i) => bytes[i] !== b)) throw new Error(`not an OpenWar3 ${what}`);
  const format = bytes[4] | (bytes[5] << 8);
  if (format > maxFormat) throw new Error(`${what} format ${format} is newer than this build reads (${maxFormat})`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const found = new Map<string, unknown>();
  let at = 6;
  while (at + 8 <= bytes.length) {
    const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const len = view.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + len);
    at += 8 + len;
    if (!want.includes(tag)) continue;
    found.set(tag, fromJson(dec.decode(await gunzip(body))));
  }
  return found;
}
