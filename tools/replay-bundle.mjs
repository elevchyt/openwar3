// The REPLAY BUNDLE of a release (issue #158, docs/replays.md "Versions").
//
// A replay is a match's inputs, re-simulated, so it plays back exactly only on a build that
// simulates the way the recording one did. Rather than ask a player to install an old OpenWar3
// to watch an old replay, every release publishes the GAME half of itself as one small archive —
// `replay-bundle-<version>.zip`, the built page (`dist/`) without the Voice Control runtime, which
// is two thirds of `dist/` and nothing a replay needs — and the desktop app of any LATER version
// fetches it, checks it, and plays the replay in it, in a window of its own
// (electron/replayBundles.mjs). The player's installed app is never touched.
//
// Beside it goes `replay-bundle-<version>.json`, the manifest the shell reads FIRST:
//
//   version      the release
//   commit       the commit it was cut from
//   fingerprint  its sim fingerprint (tools/sim-fingerprint.mjs)
//   contract     the `ow3replay` bridge version the page inside needs (src/replayBoot.ts)
//   size         the archive's length
//   sha512       its hash, base64 — a bundle that does not match is refused
//
//   node tools/replay-bundle.mjs             build both into release/ (needs `pnpm build` first)
//   node tools/replay-bundle.mjs --publish   …and upload them to the release's GitHub page
//
// The zip is written here rather than by a `zip` on the PATH: the release is cut from one machine
// for three platforms, and the archive must be the same bytes whichever it is.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { simFingerprint } from "./sim-fingerprint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The `ow3replay` contract this tree's page speaks (src/replayBoot.ts `REPLAY_CONTRACT`). */
export const REPLAY_CONTRACT = 1;

/**
 * What a replay never needs, by file name: Voice Control's recogniser (the ONNX runtime's wasm
 * and its glue, and the Whisper worker — src/voice/), which is most of `dist/`, and the landing
 * page's screenshots.
 */
export const BUNDLE_SKIPS = [/^assets\/ort-wasm[^/]*$/, /^assets\/whisperWorker-[^/]*$/, /^demoscreens\//];

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
}

/** A .zip of `files` (`{ name, bytes }`, names with `/`), deflated, with a fixed timestamp so
 *  the same tree makes the same archive. */
export function writeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1; // 1980-01-01: the format's zero
  for (const { name, bytes } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(bytes, { level: 9 });
    const stored = packed.length >= bytes.length;
    const data = stored ? bytes : packed;
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** Build the bundle of `dist` for `version`; answers the archive and its manifest. */
export function buildReplayBundle({ dist, version, commit, fingerprint }) {
  const paths = [];
  walk(dist, paths);
  const files = paths
    .map((path) => ({ name: relative(dist, path).split(sep).join("/"), path }))
    .filter((f) => !BUNDLE_SKIPS.some((re) => re.test(f.name)))
    .map((f) => ({ name: f.name, bytes: readFileSync(f.path) }));
  if (!files.some((f) => f.name === "index.html")) throw new Error(`${dist} has no index.html — run \`pnpm build\` first.`);
  const zip = writeZip(files);
  const manifest = {
    version, commit, fingerprint,
    contract: REPLAY_CONTRACT,
    size: zip.length,
    sha512: createHash("sha512").update(zip).digest("base64"),
  };
  return { zip, manifest, files: files.length };
}

// ---- the command -------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    /* no repository around it */
  }
  const { zip, manifest, files } = buildReplayBundle({ dist: join(ROOT, "dist"), version, commit, fingerprint: simFingerprint(ROOT) });
  const out = join(ROOT, "release");
  mkdirSync(out, { recursive: true });
  const zipPath = join(out, `replay-bundle-${version}.zip`);
  const jsonPath = join(out, `replay-bundle-${version}.json`);
  writeFileSync(zipPath, zip);
  writeFileSync(jsonPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`replay-bundle-${version}.zip — ${files} files, ${(zip.length / 1024 / 1024).toFixed(2)} MB, fingerprint ${manifest.fingerprint}`);
  if (process.argv.includes("--publish")) {
    // Onto the release electron-builder has just made (a draft until the notes are written —
    // `gh` uploads to a draft by its tag all the same).
    execFileSync("gh", ["release", "upload", `v${version}`, zipPath, jsonPath, "--clobber"], { cwd: ROOT, stdio: "inherit" });
    console.log(`uploaded to v${version}`);
  }
}
