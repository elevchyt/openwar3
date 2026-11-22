// FALLBACK ART — a remake in src/fallback/art/ is served where an older build has no file, and
// nowhere else (src/fallback/README.md, src/vfs/fallbackArt.ts, issue #319).
//
// Run: node tools/fallback-art-test.cjs   (part of pnpm sim:test; needs no install)
const { join } = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".sim-build");
fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(join(BUILD, "package.json"), '{"type":"commonjs"}');
if (!fs.existsSync(join(BUILD, "src", "vfs", "fallbackArt.js")) || process.argv.includes("--build")) {
  execFileSync("npx", ["tsc", "-p", "tools/tsconfig.sim.json"], { cwd: REPO, stdio: "inherit" });
}
globalThis.ImageData ??= class { constructor(d, w, h) { if (typeof d === "number") { this.width = d; this.height = w; this.data = new Uint8ClampedArray(d * w * 4); } else { this.data = d; this.width = w; this.height = h; } } };
const { FallbackArtDataSource } = require(join(BUILD, "src", "vfs", "fallbackArt.js"));
const { DerivedArtDataSource } = require(join(BUILD, "src", "vfs", "derivedArt.js"));
const { encodeBlp } = require(join(BUILD, "src", "assets", "blpEncode.js"));
const { BlpImage } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "blp", "image.js"));
const { FALLBACK_ART_PATHS } = require(join(BUILD, "src", "fallback", "paths.js"));
const { FALLBACK_ART } = require(join(BUILD, "src", "fallback", "art.js"));

let failures = 0;
const ok = (cond, what, detail = "") => { console.log(`${cond ? "ok   " : "FAIL "} ${what}${detail ? ` — ${detail}` : ""}`); if (!cond) failures++; };

const flat = (w, h, rgba) => { const d = new Uint8Array(w * h * 4); for (let i = 0; i < d.length; i += 4) d.set(rgba, i); return encodeBlp({ width: w, height: h, data: d }); };
const pixel = (bytes) => { const b = new BlpImage(); b.load(bytes.slice()); return [...b.getMipmap(0).data.slice(0, 3)]; };
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 8);
/** An install as a table of path → bytes. */
const install = (files) => {
  const m = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const key = (p) => p.replace(/\//g, "\\").toLowerCase();
  return { label: "test", exists: (p) => m.has(key(p)), rawBytes: (p) => m.get(key(p)) ?? null, read: async (p) => m.get(key(p)), list: () => [...m.keys()] };
};

const TILE5 = "UI\\Console\\Human\\HumanUITile05.blp";
const TILE1 = "UI\\Console\\Human\\HumanUITile01.blp";
const OURS = [200, 30, 200], THEIRS = [20, 160, 40];
const art = { [TILE5]: Buffer.from(flat(8, 8, [...OURS, 255])).toString("base64") };

(async () => {
  // An install that has the file: untouched, and the art is never even loaded.
  const modern = install({ [TILE5]: flat(8, 8, [...THEIRS, 255]) });
  const same = await FallbackArtDataSource.over(modern, art, [TILE5]);
  ok(same === modern, "an install that has every file is handed back untouched");

  // An install that lacks it.
  const old = install({ [TILE1]: flat(64, 64, [90, 90, 90, 255]) });
  const vfs = await FallbackArtDataSource.over(old, art, [TILE5]);
  ok(vfs.exists(TILE5) && near(pixel(vfs.rawBytes(TILE5)), OURS), "a file the install lacks is served from our remake");
  ok(vfs.exists("ui/console/human/humanuitile05.blp"), "…whatever the case and the slashes");
  ok(near(pixel(await vfs.read(TILE5)), OURS), "…and by the async read as well");
  ok(near(pixel(vfs.rawBytes(TILE1)), [90, 90, 90]), "a file the install has is still the install's");
  ok(!vfs.exists("UI\\Console\\Orc\\OrcUITile05.blp"), "a path with no remake is still absent");
  ok(vfs.served.length === 1 && vfs.list().includes(TILE5), "what is served is listed");

  // The layer above derives only what nothing below has: a remake retires the stand-in.
  const derived = new DerivedArtDataSource(vfs);
  ok(near(pixel(derived.rawBytes(TILE5)), OURS), "a remake is found BEFORE a stand-in is derived");
  // war3skins.txt names a tile with no extension, and the UI asks for that name and then for
  // it with `.blp` (ui/fdf/render.ts). The first must come back EMPTY, not as a stand-in.
  ok(derived.rawBytes("UI\\Console\\Human\\HumanUITile05") === null, "…and the extension-less name is not answered with a stand-in over it");
  const bare = new DerivedArtDataSource(old);
  ok(bare.exists(TILE5) && !near(pixel(bare.rawBytes(TILE5)), OURS), "with no remake the stand-in is still derived");

  // The generated pair agree (tools/patch-art.mjs writes both).
  ok(FALLBACK_ART_PATHS.every((p) => typeof FALLBACK_ART[p] === "string") && Object.keys(FALLBACK_ART).length === FALLBACK_ART_PATHS.length,
     "paths.ts and art.ts name the same files", `${FALLBACK_ART_PATHS.length} remakes`);
  ok(FALLBACK_ART_PATHS.every((p) => /^[^/]+(\\[^/\\]+)+\.blp$/.test(p)), "every remake is filed at a WC3 path");

  console.log(failures ? `\n${failures} FAILED` : "\nfallback art: all checks passed");
  process.exit(failures ? 1 : 0);
})();
