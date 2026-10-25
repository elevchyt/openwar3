// The MATCH LOG's writer (src/game/matchLog.ts) — the one piece of it that touches a disk.
//
// Two processes own a `.logs/` folder and both use this file: the desktop shell
// (electron/main.mjs, `<userData>/.logs/` — the player's OpenWar3 data folder) and the dev server
// (tools/vite-plugin-match-log.ts, the repo's own `.logs/`, beside the opt-in perf recorder's
// sessions — docs/perf-logging.md). The page itself cannot write a file, so it hands its lines to
// whichever of the two is serving it, and the rules about how big and how old are kept HERE, once.
//
// Plain Node and nothing else (no Electron), so the dev server can import it and the legacy
// 32-bit shell's bundler can carry it (docs/linux.md: Node 16 — sync fs calls only).
//
// The developer's two limits:
//   • about 1 MB per file — a match that writes more ROLLS OVER into `<name>.part2.log`,
//     `.part3.log`…, so no single file is ever much bigger than `MAX_BYTES` and the whole of a
//     long match is still kept;
//   • nothing older than three days — `sweep` deletes every file in the folder whose last write
//     is older than `MAX_AGE_MS`, the perf recorder's own `.ndjson`/`.txt` sessions included. It
//     runs when the store is opened (the app starting, the dev server starting) and again each
//     time a match begins, so a game left open for a week still keeps its folder clean.

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** About a megabyte per file — the developer's ceiling. A line is never split across two. */
export const MAX_BYTES = 1024 * 1024;
/** Three days, in milliseconds. */
export const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** The longest single append we accept — a page bug must not be able to fill a disk. */
const MAX_APPEND = 512 * 1024;

function stamp(d = new Date()) {
  // Local time, sortable, filename-safe: 2026-10-25_14-03-22 — the perf recorder's own shape.
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function slug(s) {
  const out = String(s ?? "")
    .replace(/\.[wW]3[xmn]$/, "")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return out || "match";
}

/**
 * A `.logs/` folder: open a match's file, append to it, close it. `dir` is created on first use.
 * Every call swallows its own I/O errors and reports them through `warn` — a full disk or a
 * read-only folder must never take the GAME down with it.
 */
export function createLogStore(dir, { maxBytes = MAX_BYTES, maxAgeMs = MAX_AGE_MS, warn = () => {} } = {}) {
  /** id → { base, part, bytes, file } */
  const open = new Map();
  let seq = 0;

  const fileFor = (base, part) => join(dir, part === 1 ? `${base}.log` : `${base}.part${part}.log`);

  function sweep(now = Date.now()) {
    try {
      if (!existsSync(dir)) return 0;
      let gone = 0;
      const live = new Set([...open.values()].map((s) => s.file));
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (live.has(path)) continue;
        try {
          const info = statSync(path);
          if (!info.isFile() || now - info.mtimeMs <= maxAgeMs) continue;
          unlinkSync(path);
          gone++;
        } catch { /* raced with another writer — leave it */ }
      }
      return gone;
    } catch (err) {
      warn(`match log sweep failed: ${String(err)}`);
      return 0;
    }
  }

  function begin(name) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      sweep();
      const id = `m${++seq}-${Date.now().toString(36)}`;
      let base = `${stamp()}_${slug(name)}`;
      // Two matches started inside the same second (a fast test loop) must not share a file.
      for (let n = 2; existsSync(fileFor(base, 1)); n++) base = `${stamp()}_${slug(name)}-${n}`;
      const file = fileFor(base, 1);
      appendFileSync(file, "");
      open.set(id, { base, part: 1, bytes: 0, file });
      return { id, file };
    } catch (err) {
      warn(`match log begin failed: ${String(err)}`);
      return null;
    }
  }

  function append(id, text) {
    const s = open.get(String(id));
    if (!s || typeof text !== "string" || !text) return false;
    const chunk = text.length > MAX_APPEND ? text.slice(0, MAX_APPEND) : text;
    try {
      // Roll over BEFORE the write that would cross the line, at a line boundary: the chunk is
      // whole lines (the page sends them that way), so no line is ever split between parts.
      const size = Buffer.byteLength(chunk, "utf8");
      if (s.bytes > 0 && s.bytes + size > maxBytes) {
        s.part++;
        s.file = fileFor(s.base, s.part);
        s.bytes = 0;
        appendFileSync(s.file, `# continued from ${s.base}${s.part === 2 ? "" : `.part${s.part - 1}`}.log\n`);
      }
      appendFileSync(s.file, chunk);
      s.bytes += size;
      return true;
    } catch (err) {
      warn(`match log append failed: ${String(err)}`);
      return false;
    }
  }

  function end(id) {
    const s = open.get(String(id));
    open.delete(String(id));
    return s ? s.file : null;
  }

  return { dir, begin, append, end, sweep };
}
