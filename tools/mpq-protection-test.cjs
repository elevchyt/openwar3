// The MPQ reader against the tricks map PROTECTORS play (docs/map-compatibility.md, "Protected
// archives"). Every case below builds a small, valid archive with the reader's own writer, then
// damages it the way a protector does, and asserts that every real file still reads back byte for
// byte — which is what Storm, the game's own reader, does with such a map.
//
//   1. a hash/block table the header claims is LONGER than the file (cut off by EOF)
//   2. a header claiming an absurd table size (2^28 slots)
//   3. a same-name DECOY hash entry ahead of the real one, pointing at a block that does not exist
//   4. a same-name decoy pointing at a block WITHOUT FILE_EXISTS
//   5. a decoy in a foreign locale ahead of the locale-neutral entry
//   6. a (listfile) that does not decode
//   7. "MoonLight" layout: the header AFTER the data, every position a wrapping negative offset
//   8. the archive handed over as a VIEW at an odd byteOffset (a Node Buffer out of the pool)
//   9. the hash table's empty slots all filled with junk (0xEEEEEEEE), as Bleach vs One Piece does
//
// Run: pnpm sim:test (or node tools/mpq-protection-test.cjs)
const mpqMod = require("mdx-m3-viewer/dist/cjs/parsers/mpq");
const Archive = (mpqMod.default ?? mpqMod).Archive;
const C = require("mdx-m3-viewer/dist/cjs/parsers/mpq/constants.js");

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${ok || !detail ? "" : `\n        ${detail}`}`);
}

// --- a clean archive: three files, one with a name that sorts into a busy probe chain --------
const FILES = new Map([
  ["war3map.j", new TextEncoder().encode("function main takes nothing returns nothing\nendfunction\n".repeat(40))],
  ["war3mapImported\\LoadingScreen.mdx", Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff)],
  ["FullScreen.blp", Uint8Array.from({ length: 900 }, (_, i) => (i * 13 + 5) & 0xff)],
]);
function cleanArchive() {
  const a = new Archive();
  a.hashTable.addEmpties(16 - a.hashTable.entries.length); // a 16-slot table: room for decoys
  for (const [name, bytes] of FILES) if (!a.set(name, bytes)) throw new Error(`could not add ${name}`);
  const out = a.save();
  if (!out) throw new Error("save failed");
  return out;
}

/** Raw access to a saved archive's header and DECRYPTED tables, to damage them by hand. */
function open(bytes) {
  const a = new Archive();
  a.load(bytes.slice(), true);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = a.headerOffset;
  const hdr = { hashPos: dv.getUint32(h + 16, true), blockPos: dv.getUint32(h + 20, true), hashSize: dv.getUint32(h + 24, true), blockSize: dv.getUint32(h + 28, true) };
  return { a, h, hdr, dv };
}
const enc = (c, words, key) => {
  const u8 = new Uint8Array(Uint32Array.from(words).buffer);
  c.encryptBlock(u8, key);
  return u8;
};
function hashWords(a) {
  const w = [];
  for (const e of a.hashTable.entries) w.push(e.nameA, e.nameB, (e.locale & 0xffff) | ((e.platform & 0xffff) << 16), e.blockIndex);
  return w;
}
function blockWords(a) {
  const w = [];
  for (const b of a.blockTable.entries) w.push(b.offset, b.compressedSize, b.normalSize, b.flags);
  return w;
}
/** Rewrite the two tables (as given, decrypted) in place and the header's four fields. */
function rewrite(bytes, h, hdr, hash, block) {
  const out = new Uint8Array(Math.max(bytes.length, h + hdr.blockPos + block.length * 4, h + hdr.hashPos + hash.length * 4));
  out.set(bytes);
  const a = new Archive();
  out.set(enc(a.c, hash, C.HASH_TABLE_KEY), h + hdr.hashPos);
  out.set(enc(a.c, block, C.BLOCK_TABLE_KEY), h + hdr.blockPos);
  const dv = new DataView(out.buffer);
  dv.setUint32(h + 16, hdr.hashPos >>> 0, true);
  dv.setUint32(h + 20, hdr.blockPos >>> 0, true);
  dv.setUint32(h + 24, hdr.hashSize >>> 0, true);
  dv.setUint32(h + 28, hdr.blockSize >>> 0, true);
  return out;
}
/** Where `name`'s probe chain starts in a table of `size` slots. */
const home = (a, name, size) => a.c.hash(name, C.HASH_TABLE_INDEX) & (size - 1);

function readsBack(label, bytes) {
  let a;
  try {
    a = new Archive();
    a.load(bytes, true);
  } catch (e) {
    check(`${label}: the archive opens`, false, e.message);
    return;
  }
  for (const [name, want] of FILES) {
    let got = null;
    try { got = a.get(name)?.bytes() ?? null; } catch (e) { got = null; }
    const same = !!got && got.length === want.length && got.every((v, i) => v === want[i]);
    check(`${label}: ${name} reads back`, same, got ? `got ${got.length} bytes` : "not found");
  }
}

console.log("\na clean archive (the control)");
const clean = cleanArchive();
readsBack("clean", clean);

console.log("\n1. tables the header claims run past the end of the file");
{
  // The hash table moved to the very END of the file and the file then cut short through its
  // trailing EMPTY slots — the slots are still "there" by the header's count, and a reader that
  // trusts the count decrypts a buffer that is not a whole number of entries. The block table
  // claims 4000 entries on top. Every real entry is still in the file, so every file must read.
  const { a, h } = open(clean);
  const hash = hashWords(a);
  const block = blockWords(a);
  let emptyTail = 0;
  for (let i = hash.length - 4; i >= 0 && hash[i + 3] === 0xffffffff; i -= 4) emptyTail++;
  check("(the fixture has empty slots at the end of its table to cut)", emptyTail >= 2, `only ${emptyTail}`);
  const blockPos = clean.length - h; // block table appended…
  const hashPos = blockPos + block.length * 4; // …and the hash table after it, at EOF
  const whole = rewrite(clean, h, { hashPos, blockPos, hashSize: hash.length / 4, blockSize: block.length / 4 }, hash, block);
  const cut = whole.slice(0, whole.length - (emptyTail - 1) * 16 - 7); // through the empties, mid-entry
  new DataView(cut.buffer).setUint32(h + 28, 4000, true); // and the block table "4000 long"
  readsBack("hash table cut off by EOF", cut);
}

console.log("\n2. an absurd table size in the header");
{
  const { h } = open(clean);
  const bytes = clean.slice();
  new DataView(bytes.buffer).setUint32(h + 28, 0x10000000, true); // block table "2^28 entries"
  readsBack("2^28 blocks", bytes);
}

/** Put a same-name decoy at `name`'s home slot and move the real entry one slot on. */
function withDecoy(label, mutate) {
  const { a, h, hdr } = open(clean);
  const size = a.hashTable.entries.length;
  const name = "war3map.j";
  const real = a.hashTable.get(name);
  const at = home(a, name, size);
  const hash = hashWords(a);
  const block = blockWords(a);
  // Free the real slot, then lay the chain out as [decoy, real] from the home slot.
  const realIdx = a.hashTable.entries.indexOf(real);
  const realWords = hash.slice(realIdx * 4, realIdx * 4 + 4);
  hash.splice(realIdx * 4, 4, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff);
  // Make sure the next slot is free too (displace whatever is there to the end of the chain).
  const next = (at + 1) % size;
  const moved = [hash.slice(at * 4, at * 4 + 4), hash.slice(next * 4, next * 4 + 4)].filter((w) => w[3] !== 0xffffffff);
  const decoy = mutate(realWords.slice(), block);
  hash.splice(at * 4, 4, ...decoy);
  hash.splice(next * 4, 4, ...realWords);
  for (const w of moved) {
    // re-home anything we displaced into the first empty slot after the pair
    for (let i = 2; i < size; i++) {
      const j = (at + i) % size;
      if (hash[j * 4 + 3] === 0xffffffff) { hash.splice(j * 4, 4, ...w); break; }
    }
  }
  readsBack(label, rewrite(clean, h, { ...hdr, blockSize: block.length / 4 }, hash, block));
}

console.log("\n3–5. same-name decoys ahead of the real entry");
withDecoy("decoy → a block index past the table", (w) => [w[0], w[1], w[2], 0x00001000]);
withDecoy("decoy → a block without FILE_EXISTS", (w, block) => {
  block.push(0, 0, 0, C.FILE_COMPRESSED); // a block that says nothing exists
  return [w[0], w[1], w[2], block.length / 4 - 1];
});
withDecoy("decoy in a foreign locale → a garbage block", (w, block) => {
  block.push(0, 64, 64, C.FILE_EXISTS); // 64 bytes of the header, "a file"
  return [w[0], w[1], 0x0409, block.length / 4 - 1];
});

console.log("\n6. a (listfile) that does not decode");
{
  const a = new Archive();
  a.hashTable.addEmpties(16 - a.hashTable.entries.length);
  for (const [name, bytes] of FILES) a.set(name, bytes);
  const out = a.save();
  // Corrupt the (listfile)'s stored bytes: mark it compressed so the junk cannot decompress.
  const { a: b, h } = open(out);
  const lf = b.hashTable.get("(listfile)");
  const block = blockWords(b);
  block[lf.blockIndex * 4 + 3] = (C.FILE_EXISTS | C.FILE_COMPRESSED | C.FILE_SINGLE_UNIT) >>> 0;
  block[lf.blockIndex * 4 + 2] = 999999; // "decompresses to" far more than it holds
  const { hdr } = open(out);
  readsBack("garbage (listfile)", rewrite(out, h, hdr, hashWords(b), block));
}

console.log("\n7. MoonLight: the header after the data, every position a negative wrapped offset");
{
  const { a, h, hdr } = open(clean);
  // New layout: [512 bytes of map header][the old archive's body, header included][new header].
  const body = clean.slice(h);
  const newHeaderAt = 512 + Math.ceil(body.length / 512) * 512 + 512;
  const out = new Uint8Array(newHeaderAt + 32);
  out.set(body, 512);
  out.set(clean.slice(h, h + 32), newHeaderAt);
  out[512] = 0; // un-header the moved copy, so the search finds only the new one
  const dv = new DataView(out.buffer);
  const wrap = (oldRel) => (512 + oldRel - newHeaderAt) >>> 0; // old position, re-based
  dv.setUint32(newHeaderAt + 16, wrap(hdr.hashPos), true);
  dv.setUint32(newHeaderAt + 20, wrap(hdr.blockPos), true);
  // Every block's offset re-based to the new header too (they were relative to the old one).
  const block = blockWords(a);
  for (let i = 0; i < block.length; i += 4) block[i] = wrap(block[i]);
  out.set(enc(a.c, block, C.BLOCK_TABLE_KEY), 512 + hdr.blockPos);
  readsBack("MoonLight", out);
}

console.log("\n8. the archive as a VIEW at an odd byteOffset");
{
  const backing = new Uint8Array(clean.length + 3);
  backing.set(clean, 3);
  readsBack("view at byteOffset 3", backing.subarray(3));
}

console.log("\n9. every empty hash slot filled with junk (Bleach vs One Piece)");
{
  const { a, h, hdr } = open(clean);
  const hash = hashWords(a);
  for (let i = 0; i < hash.length; i += 4) if (hash[i + 3] === 0xffffffff) hash.splice(i, 4, 0xeeeeeeee, 0xeeeeeeee, 0, 0xeeeeeeee);
  readsBack("no empty slot left", rewrite(clean, h, hdr, hash, blockWords(a)));
  // …and a name that is NOT there still answers "not found" rather than looping or throwing.
  const b = new Archive();
  b.load(rewrite(clean, h, hdr, hash, blockWords(a)), true);
  check("…and a missing name is simply missing", b.get("war3mapUnits.doo") === null);
}

console.log(failed ? `\n${failed} FAILED` : "\nall MPQ protection checks passed");
process.exit(failed ? 1 : 0);
