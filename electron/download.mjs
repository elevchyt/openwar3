// "Download game files" in the DESKTOP app (src/ui/gate.ts): an install, fetched from the first of
// the page's SOURCES that works (src/assets/downloadInstall.ts — the Drive zip, then the Internet
// Archive's 1.31.1 CASC store file by file) and unpacked into a real folder, which is
// then remembered exactly as a picked one is. A zip is read by electron/zip.mjs, the same reader
// the browser's half uses — the page resolves the link, so a Drive share URL has one meaning in
// both.
//
// The WHOLE folder is unpacked, executables and all, where the browser keeps only what the game
// reads: this is a copy of the player's install on their own disk, and a copy missing half its
// files is not one they can point anything else at.

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { safeJoin } from "./install.mjs";
import { installEntries, readZipIndex, ZipCursor } from "./zip.mjs";

async function rangeReader(url, signal) {
  const read = async (start, end) => {
    const res = await fetch(url, { headers: { range: `bytes=${start}-${end}` }, signal });
    if (res.status !== 206) throw new Error(notAZip(res));
    return new Uint8Array(await res.arrayBuffer());
  };
  const probe = await fetch(url, { headers: { range: "bytes=0-0" }, signal });
  const size = Number(/\/(\d+)$/.exec(probe.headers.get("content-range") ?? "")?.[1]);
  await probe.body?.cancel();
  if (probe.status !== 206 || !size) throw new Error(notAZip(probe));
  return { size, read };
}

/** The same wording the browser's half uses (src/assets/downloadInstall.ts `notAZip`). */
function notAZip(res) {
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    return "That link opened a web page instead of the file. Make sure it is shared with \"Anyone with the link\".";
  }
  if (!res.ok) return `The download failed (${res.status}).`;
  return "That server does not allow resumable downloads, which this needs.";
}

/**
 * Try each of `sources` in turn (the page's `GameFilesSource` list) and resolve to the folder the
 * first one that works produced. A Cancel is never handed on to the next source. A bare string is
 * a zip URL, which is what a page older than the sources sent.
 */
export async function downloadFromSources(sources, parent, onProgress, signal) {
  const list = typeof sources === "string" ? [{ kind: "zip", name: "the link", url: sources }] : Array.isArray(sources) ? sources : [];
  if (!list.length) throw new Error("There is nowhere to download the game files from.");
  let last = null;
  for (const [i, source] of list.entries()) {
    const progress = (p) => onProgress({ ...p, source: i });
    progress({ fraction: null, received: 0, total: 0 });
    try {
      return source?.kind === "files"
        ? await downloadFiles(source, parent, progress, signal)
        : await downloadInstall(String(source?.url ?? ""), parent, progress, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[download] ${source?.name} failed:`, err);
      last = err;
    }
  }
  throw last;
}

/** The folder a download lands in, refused if something is already there — a download never
 *  writes into, or over, a folder it did not make. */
function landingFolder(parent, name) {
  const target = join(parent, name);
  if (existsSync(target)) throw new Error(`There is already a folder at ${target}. Choose another place, or pick that folder with Load Game Files.`);
  return target;
}

/**
 * A `files` source: every file fetched whole from `base + encodeURIComponent(path)` into a
 * `.download` staging folder, renamed into place once all of them have arrived at their stated
 * sizes. The paths come from the page, so each one goes through `safeJoin` like a zip entry's.
 */
async function downloadFiles(source, parent, onProgress, signal) {
  if (typeof fetch !== "function") throw new Error("This build of the app cannot download. Use a newer one.");
  const files = Array.isArray(source.files) ? source.files : [];
  const base = String(source.base ?? "");
  if (!/^https:\/\//i.test(base) || !files.length) throw new Error("That source is not one this can download.");
  const total = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
  const target = landingFolder(parent, "Warcraft III");
  const staging = `${target}.download`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  let received = 0;
  onProgress({ fraction: 0, received: 0, total });
  const timer = setInterval(() => onProgress({ fraction: received / total, received, total }), 250);
  try {
    for (const file of files) {
      const full = safeJoin(staging, String(file.path));
      if (!full) throw new Error(`${file.path} is not a path inside the install.`);
      const res = await fetch(base + encodeURIComponent(String(file.path)), { signal });
      if (!res.ok || !res.body) throw new Error(`${source.name} answered ${res.status} for ${file.path}.`);
      await mkdir(dirname(full), { recursive: true });
      // Iterated rather than `Readable.fromWeb`, as ZipCursor iterates its body: the legacy
      // 32-bit shell's Node is older than that converter.
      const body = res.body;
      async function* counted() {
        for await (const chunk of body) {
          received += chunk.length;
          yield chunk;
        }
      }
      await pipeline(Readable.from(counted()), createWriteStream(full), { signal });
      const got = (await stat(full)).size;
      if (got !== Number(file.size)) throw new Error(`${file.path} arrived ${got} bytes long, not ${file.size}.`);
    }
    await rename(staging, target);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  } finally {
    clearInterval(timer);
  }
  onProgress({ fraction: 1, received: total, total });
  return target;
}

/**
 * Download the archive at `url` and unpack the install into `<parent>/<name>`, where `name` is the
 * folder the archive itself wraps the install in ("Warcraft III"), else "Warcraft III". Unpacks
 * into a `.download` sibling first and renames it into place only when whole, so a download that
 * dies — or is cancelled through `signal`, the load gate's Cancel — leaves no folder that looks
 * like an install. Resolves to the finished folder.
 */
export async function downloadInstall(url, parent, onProgress, signal) {
  if (typeof fetch !== "function") throw new Error("This build of the app cannot download. Use a newer one.");
  if (!/^https?:\/\//i.test(url)) throw new Error("That is not a link.");

  const { size, read } = await rangeReader(url, signal);
  const all = await readZipIndex(read, size);
  const entries = installEntries(all);
  const wrapper = /^([^/]+)\/\.build\.info$/i.exec(all.find((e) => /(^|\/)\.build\.info$/i.test(e.name))?.name ?? "")?.[1];
  const target = landingFolder(parent, wrapper ?? "Warcraft III");
  const staging = `${target}.download`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(notAZip(res));
    const cursor = new ZipCursor(res.body);
    onProgress({ fraction: 0, received: 0, total: size });
    const timer = setInterval(() => onProgress({ fraction: cursor.pos / size, received: cursor.pos, total: size }), 250);
    try {
      for (const entry of entries) {
        const full = safeJoin(staging, entry.path);
        if (!full) continue;
        await cursor.enter(entry);
        await mkdir(dirname(full), { recursive: true });
        if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.path} is packed with a method this cannot unpack (${entry.method}).`);
        await pipeline(
          Readable.from(cursor.take(entry.compressedSize)),
          entry.method === 8 ? createInflateRaw() : new PassThrough(),
          createWriteStream(full),
        );
        if ((await stat(full)).size !== entry.uncompressedSize) throw new Error(`${entry.path} did not unpack whole.`);
      }
    } finally {
      clearInterval(timer);
      await cursor.close().catch(() => {});
    }
    await rename(staging, target);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  onProgress({ fraction: 1, received: size, total: size });
  return target;
}
