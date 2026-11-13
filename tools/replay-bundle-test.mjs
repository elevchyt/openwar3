// The replay bundle, end to end without Electron or the network (issue #158):
// tools/replay-bundle.mjs builds one, electron/replayBundles.mjs checks, unpacks and sweeps.
//
// Run: pnpm app:test

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReplayBundle, writeZip } from "./replay-bundle.mjs";
import {
  SANDBOX_MARKER, SANDBOX_PREFIX, bundleUrls, createSandbox, downloadBundle, fetchBundleManifest,
  removeSandbox, sweepSandboxes, verifyBundle,
} from "../electron/replayBundles.mjs";

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};
const throws = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

const work = mkdtempSync(join(tmpdir(), "ow3-bundle-test-"));
try {
  // ---- build ---------------------------------------------------------------------------------
  const dist = join(work, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  mkdirSync(join(dist, "demoscreens"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><script src=assets/index-abc.js></script>");
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log('game');".repeat(2000));
  writeFileSync(join(dist, "assets", "ort-wasm-simd-threaded.asyncify-X.wasm"), Buffer.alloc(50_000, 7));
  writeFileSync(join(dist, "assets", "whisperWorker-Y.js"), "voice");
  writeFileSync(join(dist, "demoscreens", "a.png"), "png");
  const { zip, manifest, files } = buildReplayBundle({ dist, version: "0.9.1", commit: "abc1234", fingerprint: "feedfacefeedface" });
  check("the bundle leaves the voice runtime and the landing page's screenshots out", files === 2);
  check("the manifest names the version, the fingerprint and the archive", manifest.version === "0.9.1" && manifest.fingerprint === "feedfacefeedface" && manifest.size === zip.length && manifest.contract === 1);
  check("the same tree makes the same archive", buildReplayBundle({ dist, version: "0.9.1", commit: "abc1234", fingerprint: "feedfacefeedface" }).manifest.sha512 === manifest.sha512);

  // ---- where it comes from -------------------------------------------------------------------
  check("a bundle is asked of OpenWar3's own releases", bundleUrls("0.9.1", {}).zip === "https://github.com/elevchyt/openwar3/releases/download/v0.9.1/replay-bundle-0.9.1.zip");
  check("a version that is not one is refused", await throws(() => bundleUrls("../../evil", {})) && await throws(() => bundleUrls("1.2", {})));
  const served = new Map([["http://mirror/replay-bundle-0.9.1.json", JSON.stringify(manifest)], ["http://mirror/replay-bundle-0.9.1.zip", zip]]);
  const fetchFn = async (url) => {
    const body = served.get(url);
    if (body === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => JSON.parse(body), body: (async function* () { for (let i = 0; i < body.length; i += 1000) yield body.subarray(i, i + 1000); })() };
  };
  const env = { OW3_REPLAY_BUNDLE_BASE: "http://mirror" };
  const got = await fetchBundleManifest("0.9.1", { fetchFn, env });
  check("the manifest is read", got?.sha512 === manifest.sha512 && got.size === zip.length);
  check("a version with no bundle answers null", (await fetchBundleManifest("0.1.0", { fetchFn, env })) === null);
  let last = 0;
  const down = await downloadBundle(got, { fetchFn, env, onProgress: (n) => { last = n; } });
  check("the archive downloads, with progress, and passes its check", down.equals(zip) && last === zip.length);

  // ---- the check -----------------------------------------------------------------------------
  const bad = Buffer.from(zip);
  bad[bad.length >> 1] ^= 0xff;
  check("a tampered archive is refused", await throws(() => verifyBundle(bad, manifest)));
  check("a short one is refused", await throws(() => verifyBundle(zip.subarray(0, zip.length - 1), manifest)));

  // ---- the sandbox ---------------------------------------------------------------------------
  const tmp = join(work, "tmp");
  mkdirSync(tmp);
  const dir = await createSandbox(zip, "0.9.1", { tmp, pid: 4242 });
  check("the sandbox is a folder of ours in the temp folder", dir.startsWith(join(tmp, SANDBOX_PREFIX + "0.9.1-")) && existsSync(join(dir, SANDBOX_MARKER)));
  check("…holding the page, byte for byte", readFileSync(join(dir, "assets", "index-abc.js")).equals(readFileSync(join(dist, "assets", "index-abc.js"))) && existsSync(join(dir, "index.html")));
  check("…and not the voice runtime", !readdirSync(join(dir, "assets")).some((n) => n.startsWith("ort-wasm")));
  for (const name of ["../escape.txt", "/abs.txt", "a/../../b.txt", "c:\\x.txt", SANDBOX_MARKER]) {
    const evil = writeZip([{ name: "index.html", bytes: Buffer.from("x") }, { name, bytes: Buffer.from("x") }]);
    const before = readdirSync(tmp).length;
    check(`an archive naming "${name}" is refused, and leaves nothing behind`, await throws(() => createSandbox(evil, "0.9.1", { tmp })) && readdirSync(tmp).length === before && !existsSync(join(work, "escape.txt")));
  }
  check("an archive with no page is refused", await throws(() => createSandbox(writeZip([{ name: "a.js", bytes: Buffer.from("x") }]), "0.9.1", { tmp })));

  // ---- the sweep -----------------------------------------------------------------------------
  const dead = await createSandbox(zip, "0.9.1", { tmp, pid: 1111 });
  const live = await createSandbox(zip, "0.9.2", { tmp, pid: 2222 });
  const lookalike = join(tmp, SANDBOX_PREFIX + "not-ours");
  mkdirSync(lookalike);
  writeFileSync(join(lookalike, "keep.txt"), "somebody else's");
  const other = join(tmp, "another-app");
  mkdirSync(other);
  writeFileSync(join(other, SANDBOX_MARKER), "{}");
  const swept = sweepSandboxes(tmp, { alive: (pid) => pid === 2222, self: 999 });
  check("the sweep deletes a sandbox whose owner is gone", !existsSync(dead) && !existsSync(dir) && swept.removed.length === 2);
  check("…leaves one whose owner is still running", existsSync(live) && swept.kept.length === 1);
  check("…and never touches a folder without our marker, or without our prefix", existsSync(join(lookalike, "keep.txt")) && existsSync(join(other, SANDBOX_MARKER)));
  check("a folder that is not ours is not removed by name either", removeSandbox(lookalike) === false && existsSync(lookalike));
  check("the owner's own leftovers go at its next launch (a recycled pid is not an owner)", sweepSandboxes(tmp, { alive: () => true, self: 2222 }).removed.length === 1 && !existsSync(live));
  check("sweeping a folder that does not exist does nothing", sweepSandboxes(join(work, "nope")).removed.length === 0);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\nreplay bundle: ${failures} check(s) FAILED` : "\nreplay bundle: all checks passed");
process.exit(failures ? 1 : 0);
