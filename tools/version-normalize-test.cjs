// EVERY BUILD PLAYS THE SAME GAME — an MPQ-era install, mounted through the engine's own code,
// reads the tables a 1.30.4 install reads (docs/versions.md, issue #319).
//
// The mount turns another build's object tables into 1.30.4's (src/vfs/normalize.ts). A cell it
// gets wrong is not an error anywhere: that player's Footman simply has different hit points
// from everybody else's, and a LAN game desyncs with nothing to say why. So this mounts each
// REAL install it is pointed at — MpqEraDataSource, NormalizeDataSource, the engine's own
// classes — and compares every object table of all four data sets against the 1.30.4 install's,
// as tables (row → column → value), plus the parts of the mount a table diff cannot see.
//
//   node tools/version-normalize-test.cjs <label>=<folder> [<label>=<folder> …]
//   OPENWAR3_VERSIONS="1.29.2=/path;1.21a=/path" pnpm versions:test
//
// Skips (exit 0) with no installs named, and without the extracted 1.30.4 tables.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const REPO = path.join(__dirname, "..");
const BUILD = path.join(REPO, ".sim-build");
const REF = path.join(REPO, "Warcraft III", "ExtractedData", "merged");

const installs = [...process.argv.slice(2), ...(process.env.OPENWAR3_VERSIONS ?? "").split(";")]
  .filter((a) => a.includes("=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]);
if (!installs.length) { console.log("skip  no installs named (see the header)"); process.exit(0); }
if (!fs.existsSync(path.join(REF, "Units", "UnitBalance.slk"))) { console.log("skip  no extracted 1.30.4 install (pnpm data:extract)"); process.exit(0); }

fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(path.join(BUILD, "package.json"), '{"type":"commonjs"}');
if (!fs.existsSync(path.join(BUILD, "src", "vfs", "normalize.js")) || process.argv.includes("--build")) {
  execFileSync("npx", ["tsc", "-p", "tools/tsconfig.sim.json"], { cwd: REPO, stdio: "inherit" });
}
const { MpqEraDataSource, isMpqEraInstall, buildFingerprint } = require(path.join(BUILD, "src", "vfs", "mpqEra.js"));
const { NormalizeDataSource, mpqEraBuild } = require(path.join(BUILD, "src", "vfs", "normalize.js"));
const { loadNormalization } = require(path.join(BUILD, "src", "patches", "normalize", "index.js"));
const { MappedData } = require(path.join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata.js"));

let failures = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };
const table = (bytes) => new MappedData(new TextDecoder("windows-1252").decode(bytes));
const empty = (v) => v === undefined || v === "" || v === "_" || v === "-" || v === " - ";
const TABLE = /^((custom|melee)_v[01]\\)?units\\[^\\]+\.(slk|txt)$/i;

function refTables() {
  const out = [];
  for (const set of ["", "Custom_V0", "Custom_V1", "Melee_V0"]) {
    const dir = path.join(REF, set, "Units");
    for (const f of fs.readdirSync(dir)) {
      const name = `${set ? `${set}\\` : ""}Units\\${f}`;
      if (TABLE.test(name) && !/strings\.txt$/i.test(f)) out.push([name, path.join(dir, f)]);
    }
  }
  return out;
}

function slkColumns(bytes) {
  const cols = new Set();
  let first = null;
  for (const line of new TextDecoder("windows-1252").decode(bytes).split("\n")) {
    if (/^C;.*Y(?!1;)\d+/.test(line)) break;
    const m = /^C;X(\d+)(;Y1)?;K"?([^";\r]*)/.exec(line);
    if (!m) continue;
    if (m[1] === "1") first = m[3].toLowerCase();
    cols.add(m[3].toLowerCase());
  }
  cols.delete(first); // the row's key, by PLACE — 1.30 renamed UnitWeapons.slk's
  return cols;
}

(async () => {
  for (const [label, dir] of installs) {
    console.log(`\n${label}: ${dir}`);
    if (!fs.existsSync(dir)) { console.log("  skip  not there"); continue; }
    const files = new Map();
    for (const name of fs.readdirSync(dir)) {
      if (!/\.mpq$/i.test(name)) continue;
      const full = path.join(dir, name);
      // A standalone copy: Node pools Buffers, and the parser wants its tables aligned from 0.
      files.set(name.toLowerCase(), { name, arrayBuffer: async () => { const b = fs.readFileSync(full); const u = new Uint8Array(b.byteLength); u.set(b); return u.buffer; } });
    }
    check(isMpqEraInstall(files.keys()), "the folder is an MPQ-era install");
    const mpq = await MpqEraDataSource.open(files);
    console.log(`        ${mpq.mounted.join(" < ")}`);
    const build = mpqEraBuild(mpq, mpq.mounted);
    check(build.exact && build.version === label, `its tables are recognised as ${label}`, `fingerprint ${buildFingerprint(mpq)} → ${build.version}${build.exact ? "" : " (nearest)"}`);
    const vfs = new NormalizeDataSource(mpq, await loadNormalization(build.version), build.version);

    let cells = 0, tables = 0;
    const left = [];
    for (const [name, file] of refTables()) {
      const ours = fs.readFileSync(file);
      const theirs = vfs.rawBytes(name);
      if (!theirs) { left.push(`${name}: not answered`); continue; }
      if (!vfs.exists(name)) left.push(`${name}: read but not there`);
      tables++;
      const ta = table(ours), tb = table(theirs);
      const ca = /\.slk$/i.test(name) ? slkColumns(ours) : null;
      for (const id of new Set([...Object.keys(ta.map), ...Object.keys(tb.map)])) {
        const ra = ta.map[id]?.map, rb = tb.map[id]?.map;
        if (!ra || !rb) { left.push(`${name} [${id}] ${ra ? "missing" : "extra"}`); continue; }
        for (const col of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
          if (ca && !ca.has(col)) continue; // a column 1.30.4's readers never ask for
          cells++;
          const va = ra[col] ?? "", vb = rb[col] ?? "";
          if (va === vb || (empty(va) && empty(vb))) continue;
          if (/^-?[\d.]+$/.test(va) && /^-?[\d.]+$/.test(vb) && parseFloat(va) === parseFloat(vb)) continue;
          left.push(`${name} [${id}] ${col}: ${JSON.stringify(vb)} should be ${JSON.stringify(va)}`);
        }
      }
    }
    for (const l of left.slice(0, 12)) console.log(`        ${l}`);
    check(left.length === 0, `all four data sets read as 1.30.4's`, `${tables} tables, ${cells.toLocaleString()} cells, ${left.length} differ`);
    check(vfs.problems.length === 0, "every edit applied", `${vfs.problems.length} problems`);

    // What a table diff cannot see.
    check(vfs.exists("Units\\Human\\Footman\\Footman.mdx") && vfs.exists("Scripts\\common.j") && vfs.exists("UI\\war3skins.txt"), "the files the engine boots on are there");
    const cliff = vfs.rawBytes("Z.mpq:ReplaceableTextures\\Cliff\\Cliff0.blp"), base = vfs.rawBytes("ReplaceableTextures\\Cliff\\Cliff0.blp");
    check(!!cliff && !!base && Buffer.compare(Buffer.from(cliff), Buffer.from(base)) !== 0, "a tileset's own cliff is reachable as Z.mpq:<path>, and is not the default");
    check(vfs.exists("A.mpq:ReplaceableTextures\\Cliff\\Cliff0.blp") && !vfs.exists("A.mpq:Units\\Human\\Footman\\Footman.mdx"), "…and a tileset answers only for what it carries");
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall ok");
  process.exit(failures ? 1 : 0);
})();
