// Watching a replay recorded by ANOTHER OpenWar3 — in that version (issue #158, docs/replays.md
// "Versions").
//
// A replay is a match's inputs, re-simulated, so only a build that simulates the way the
// recording one did plays it back exactly. Every release therefore publishes the GAME half of
// itself as a small archive (tools/replay-bundle.mjs: `replay-bundle-<version>.zip`, the built
// page without the Voice Control runtime, and a manifest with its SHA-512), and this module is
// what a later desktop app does with one:
//
//   1. reads the manifest and the archive from OpenWar3's own releases, and refuses an archive
//      whose hash is not the manifest's;
//   2. unpacks it into a SANDBOX — a folder of its own in the OS temp folder,
//      `openwar3-replay-<version>-<random>`, marked as ours;
//   3. (electron/main.mjs) serves that folder on a port of its own and opens it in a window with
//      an in-memory session and a restricted bridge, which plays the one replay and nothing else;
//   4. deletes the sandbox when that window closes.
//
// The player's installed app is never replaced, so there is nothing to roll back: the worst a
// crash in the replay window can do is leave a folder in the temp folder, and `sweepSandboxes`
// removes those on the next launch.
//
// Everything here is plain Node and takes what it touches as arguments (the folder, the fetch,
// the "is this process alive" question), so tools/replay-bundle-test.mjs can drive all of it
// without Electron and without the network.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { readZipIndex } from "./zip.mjs";

/** The `ow3replay` bridge versions THIS shell can serve (electron/replayPreload.cjs). A bundle
 *  whose page needs a newer one is the one case there is no answer for but "update OpenWar3". */
export const SHELL_CONTRACT = 1;

/** Where the bundles are: OpenWar3's own releases, and nowhere else. `OW3_REPLAY_BUNDLE_BASE`
 *  replaces it for the tests and for a developer's own mirror; `{version}` is filled in. */
const RELEASES = "https://github.com/elevchyt/openwar3/releases/download/v{version}";

/** A version as it may appear in a file name and a URL: digits and dots, an optional suffix. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The folders this module makes, and the file that proves one is ours. */
export const SANDBOX_PREFIX = "openwar3-replay-";
export const SANDBOX_MARKER = ".openwar3-replay.json";

/** The largest archive taken: 64 MiB, many times a bundle (~3 MB). */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export function bundleUrls(version, env = process.env) {
  if (!VERSION.test(String(version))) throw new Error(`"${version}" is not an OpenWar3 version.`);
  const base = (env.OW3_REPLAY_BUNDLE_BASE || RELEASES).replace("{version}", version).replace(/\/+$/, "");
  return { manifest: `${base}/replay-bundle-${version}.json`, zip: `${base}/replay-bundle-${version}.zip` };
}

/**
 * The manifest of a version's bundle, or null when that version published none (a release from
 * before replays, a 404) or cannot be reached. `fetchFn` is the platform's `fetch`.
 */
export async function fetchBundleManifest(version, { fetchFn = fetch, env = process.env } = {}) {
  let urls;
  try {
    urls = bundleUrls(version, env);
  } catch {
    return null;
  }
  try {
    const res = await fetchFn(urls.manifest, { redirect: "follow" });
    if (!res.ok) return null;
    const m = await res.json();
    if (!m || m.version !== version || typeof m.sha512 !== "string" || !Number.isFinite(m.size) || m.size <= 0 || m.size > MAX_BUNDLE_BYTES) return null;
    return { version, commit: String(m.commit ?? ""), fingerprint: String(m.fingerprint ?? ""), contract: Number(m.contract) || 1, size: m.size, sha512: m.sha512 };
  } catch {
    return null;
  }
}

/** Download a version's archive and check it against its manifest. `onProgress(received, total)`. */
export async function downloadBundle(manifest, { fetchFn = fetch, env = process.env, onProgress = () => {}, signal } = {}) {
  const res = await fetchFn(bundleUrls(manifest.version, env).zip, { redirect: "follow", signal });
  if (!res.ok || !res.body) throw new Error(`The replay files for OpenWar3 ${manifest.version} could not be downloaded (${res.status}).`);
  const chunks = [];
  let received = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    if (received > MAX_BUNDLE_BYTES || received > manifest.size) throw new Error("The download is larger than its manifest says.");
    chunks.push(chunk);
    onProgress(received, manifest.size);
  }
  const zip = Buffer.concat(chunks);
  verifyBundle(zip, manifest);
  return zip;
}

/** Refuse an archive that is not the one the manifest describes. */
export function verifyBundle(zip, manifest) {
  if (zip.length !== manifest.size) throw new Error("The downloaded replay files are incomplete.");
  if (createHash("sha512").update(zip).digest("base64") !== manifest.sha512) {
    throw new Error("The downloaded replay files do not match their checksum, and were not used.");
  }
}

/**
 * Unpack an archive into a new sandbox under `tmp` and mark it ours. Answers the folder.
 * Every name is checked — it is a file off the internet: nothing absolute, nothing that climbs.
 */
export async function createSandbox(zip, version, { tmp, pid = process.pid } = {}) {
  if (!VERSION.test(String(version))) throw new Error(`"${version}" is not an OpenWar3 version.`);
  const dir = join(tmp, `${SANDBOX_PREFIX}${version}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  // The marker goes in FIRST: a crash halfway through unpacking still leaves a folder the sweep
  // can prove is ours.
  writeFileSync(join(dir, SANDBOX_MARKER), JSON.stringify({ pid, version, created: new Date().toISOString() }));
  try {
    const entries = await readZipIndex(async (start, end) => zip.subarray(start, end + 1), zip.length);
    for (const e of entries) {
      if (e.name.endsWith("/")) continue;
      const parts = e.name.split("/");
      if (e.name.startsWith("/") || e.name.includes("\\") || e.name.includes(":") || parts.includes("..") || parts.includes("") || e.name === SANDBOX_MARKER) {
        throw new Error(`The replay files hold a name that is not allowed (${e.name}).`);
      }
      // The local header's own name and extra lengths place the data (they need not match the
      // central directory's).
      const at = e.offset;
      if (zip.readUInt32LE(at) !== 0x04034b50) throw new Error("The replay files are damaged.");
      const data = zip.subarray(at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28)).subarray(0, e.compressedSize);
      const bytes = e.method === 0 ? data : e.method === 8 ? inflateRawSync(data) : null;
      if (!bytes || bytes.length !== e.uncompressedSize) throw new Error(`The replay files are damaged (${e.name}).`);
      const out = join(dir, ...parts);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, bytes);
    }
    if (!existsSync(join(dir, "index.html"))) throw new Error("The replay files have no page in them.");
  } catch (err) {
    removeSandbox(dir);
    throw err;
  }
  return dir;
}

/** Is `dir` a sandbox of ours — the prefix AND the marker? Answers the marker, or null. */
function sandboxMarker(dir) {
  const name = dir.split(sep).pop() ?? "";
  if (!name.startsWith(SANDBOX_PREFIX)) return null;
  try {
    if (!statSync(dir).isDirectory()) return null;
    const m = JSON.parse(readFileSync(join(dir, SANDBOX_MARKER), "utf8"));
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

/** Delete one sandbox. Only a folder that is provably ours is touched. True when it is gone. */
export function removeSandbox(dir, { warn = () => {} } = {}) {
  if (!sandboxMarker(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return !existsSync(dir);
  } catch (err) {
    warn(`could not delete ${dir}: ${err?.code ?? err}`);
    return false;
  }
}

/** Is this process still running? `kill(pid, 0)` sends nothing: it only asks. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // it exists, and is somebody else's
  }
}

/**
 * THE STARTUP SWEEP: delete the sandboxes an earlier run left behind — the app crashed, was
 * killed, the machine lost power, or a delete failed on a file still held open. Rules:
 *
 *   · only a folder with OUR PREFIX in `tmp` that also holds OUR MARKER is ever touched;
 *   · one whose owning process is STILL ALIVE is left alone — OpenWar3 has no single-instance
 *     lock, so another copy of the game may be showing a replay out of it right now;
 *   · one that will not delete is left for the next launch, and said so; nothing here throws,
 *     because nothing here may stand between the player and the main menu.
 *
 * Answers what it did, for the console and for the test.
 */
export function sweepSandboxes(tmp, { alive = processAlive, warn = () => {}, self = process.pid } = {}) {
  const out = { removed: [], kept: [], failed: [] };
  let names = [];
  try {
    names = readdirSync(tmp);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.startsWith(SANDBOX_PREFIX)) continue;
    const dir = join(tmp, name);
    const marker = sandboxMarker(dir);
    if (!marker) continue; // the prefix alone proves nothing
    if (marker.pid !== self && alive(marker.pid)) {
      out.kept.push(name);
      continue;
    }
    (removeSandbox(dir, { warn }) ? out.removed : out.failed).push(name);
  }
  return out;
}
