import { inflate } from "pako";

// BLTE — the block-table encoding every file inside a CASC storage is wrapped in
// (issue #102). Blizzard's own name for it; the four magic bytes are in Game.dll's
// string table alongside the rest of the CASC plumbing.
//
// A BLTE file is a header naming N chunks, then the chunks back to back. Each chunk
// starts with a one-byte MODE that says how the rest of it is stored:
//
//   'N'  the bytes as they are
//   'Z'  zlib (this is nearly all of a WC3 install)
//   'F'  a nested BLTE frame — recurse
//   'E'  Salsa20-encrypted, keyed by a TACT key delivered out of band
//
// Every multi-byte field here is BIG-endian, which is worth stating once because
// the rest of the CASC format (the .idx entries, the data-file headers) is little-
// endian and mixing the two silently yields plausible-looking garbage.
//
// 'E' does not appear in a Warcraft III install — encrypted chunks are how Blizzard
// ships content before a patch goes live, and a shipped 1.30.4 has none (verified by
// decoding every entry of the retail build, see tools/extract-data.mjs). We throw
// rather than return zeros so that a future build that DOES carry one says so.

/** Magic at the head of every BLTE payload: "BLTE". */
const MAGIC = 0x424c5445;

/** The fixed per-chunk record in a BLTE header: compressed size, decompressed size, MD5. */
const CHUNK_INFO_SIZE = 24;

export function isBlte(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) === MAGIC;
}

/**
 * Decode one BLTE payload. `label` only ever shows up in error messages, so pass
 * something that identifies the file when you have it.
 */
export function decodeBlte(bytes: Uint8Array, label = "blte"): Uint8Array {
  if (!isBlte(bytes)) throw new Error(`${label}: not a BLTE payload`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(4);

  // headerSize 0 is the degenerate single-chunk form: no chunk table, the payload is
  // everything after the 8-byte magic+size.
  const chunks: Array<{ start: number; end: number }> = [];
  if (headerSize === 0) {
    chunks.push({ start: 8, end: bytes.length });
  } else {
    const count = (view.getUint8(9) << 16) | (view.getUint8(10) << 8) | view.getUint8(11);
    let info = 12;
    let data = headerSize; // chunk data begins where the header ends
    for (let i = 0; i < count; i++) {
      const compressed = view.getUint32(info);
      info += CHUNK_INFO_SIZE;
      chunks.push({ start: data, end: data + compressed });
      data += compressed;
    }
  }

  const parts: Uint8Array[] = [];
  let total = 0;
  for (const { start, end } of chunks) {
    const part = decodeChunk(bytes, start, end, label);
    parts.push(part);
    total += part.length;
  }
  if (parts.length === 1) return parts[0];

  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function decodeChunk(bytes: Uint8Array, start: number, end: number, label: string): Uint8Array {
  const mode = String.fromCharCode(bytes[start]);
  const body = bytes.subarray(start + 1, end);
  switch (mode) {
    case "N":
      return body;
    case "Z":
      // pako, not DecompressionStream: the VFS contract is a SYNCHRONOUS rawBytes()
      // (vfs/types.ts) and the web streams API has no sync form.
      return inflate(body);
    case "F":
      return decodeBlte(body, label);
    case "E":
      throw new Error(
        `${label}: BLTE chunk is encrypted ('E'). That only happens in a pre-release ` +
          `build — a shipped Warcraft III install has none.`,
      );
    default:
      throw new Error(`${label}: unknown BLTE chunk mode '${mode}'`);
  }
}
