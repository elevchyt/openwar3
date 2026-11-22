// What does another Warcraft III build HAVE, against the 1.30.4 the engine is written to (issue #319)?
//
//   node tools/version-survey.mjs --install <folder> [--label 1.27b]   an MPQ-era install (≤ 1.29.2)
//   node tools/version-survey.mjs --reference                         the repo's own 1.30.4 store
//   node tools/version-survey.mjs --compare <label>                   what <label> lacks, by kind
//
// `--install` mounts the folder's archives in the order the game did and writes two things under
// `.cdn-cache/` (gitignored — the developer's own files, on the developer's own disk):
//   • `extract/<label>/`  the DATA TABLES and scripts in 1.30.4's layout, so tools/patch-extract.mjs
//     can `--diff` them and write `--downgrade` edits exactly as it does for a CASC build;
//   • `survey/<label>.files.txt`  every logical path the mount resolves, a tileset's own copy
//     as `Z.mpq:<path>` (which is how 1.30.4's store spells it, src/vfs/tileset.ts).
//
// The layering is src/vfs/mpqEra.ts's — this tool is how that file's claims were measured.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(REPO, ".cdn-cache");
const mpq = require(path.join(REPO, "node_modules/mdx-m3-viewer/dist/cjs/parsers/mpq")).default;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

/** Lowest priority first. Every name a build of the MPQ era ever used; a folder has a subset. */
export const MPQ_ORDER = ["deprecated.mpq", "war3.mpq", "war3local.mpq", "war3x.mpq", "war3xlocal.mpq", "war3patch.mpq"];
const WANTED = /^((custom|melee)_v[01]\\)?(units\\[^\\]+\.(slk|txt)|scripts\\[^\\]+\.(ai|j|pld))$/i;
const FOLDERS = { units: "Units", scripts: "Scripts", custom_v0: "Custom_V0", custom_v1: "Custom_V1", melee_v0: "Melee_V0" };
const TILESET = /^[a-z]\.mpq$/i;

function mountMpqInstall(dir) {
  const present = new Map(fs.readdirSync(dir).map((n) => [n.toLowerCase(), n]));
  const layers = [];
  for (const name of MPQ_ORDER) {
    const real = present.get(name);
    if (!real) continue;
    const a = new mpq.Archive();
    a.load(new Uint8Array(fs.readFileSync(path.join(dir, real))), true);
    layers.push({ name: real, archive: a });
  }
  /** lower path → { archive, name } — the highest layer wins. */
  const files = new Map();
  for (const { name, archive } of layers) {
    for (const n of archive.getFileNames()) {
      if (n.startsWith("(") || /^File\d{8}$/.test(n)) continue;
      if (TILESET.test(n)) {
        const inner = new mpq.Archive();
        try { inner.load(archive.get(n).bytes(), true); } catch { continue; }
        for (const m of inner.getFileNames()) {
          if (m.startsWith("(") || /^File\d{8}$/.test(m)) continue;
          files.set(`${n.toLowerCase()}:${m.toLowerCase()}`, { archive: inner, name: m, from: `${name}:${n}` });
        }
        continue;
      }
      if (/\.mpq$/i.test(n)) continue; // _low / _med: lower-detail twins nothing here reads
      files.set(n.toLowerCase(), { archive, name: n, from: name });
    }
  }
  // WHO OWNS a path is asked by name too, never read off the listfiles: 1.21a's War3Patch.mpq
  // overrides `Units\AbilityData.slk` without its listfile saying so, and the lower archive's
  // stale copy is what a listfile walk extracts.
  for (const [key, hit] of files) {
    if (key.includes(":")) continue;
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i].archive.has(hit.name)) { hit.archive = layers[i].archive; hit.from = layers[i].name; break; }
    }
  }
  // An MPQ finds a file by the HASH of its name, and its (listfile) is only a courtesy — an
  // archive carries files its listfile never names (1.29.2's War3.mpq: `Textures\Arrow.blp` and
  // ninety more). So every path 1.30.4 has is ASKED for by name as well.
  const refFile = surveyFile("1.30.4");
  let probed = 0;
  if (fs.existsSync(refFile)) {
    const tilesets = new Map();
    for (const { name, archive } of layers) for (const n of archive.getFileNames()) if (TILESET.test(n)) {
      const inner = new mpq.Archive();
      try { inner.load(archive.get(n).bytes(), true); } catch { continue; }
      tilesets.set(n.toLowerCase(), [...(tilesets.get(n.toLowerCase()) ?? []), { archive: inner, from: `${name}:${n}` }]);
    }
    for (const ref of fs.readFileSync(refFile, "utf8").split("\n")) {
      if (!ref || files.has(ref) || /^maps\\.*\.w3[xm]:/.test(ref)) continue;
      const m = /^([a-z]\.mpq):(.*)$/.exec(ref);
      const pool = m ? (tilesets.get(m[1]) ?? []).slice().reverse() : layers.slice().reverse().map((l) => ({ archive: l.archive, from: l.name }));
      const name = m ? m[2] : ref;
      if (ref.includes(":") && !m) continue;
      const hit = pool.find((l) => l.archive.has(name));
      if (hit) { files.set(ref, { archive: hit.archive, name, from: hit.from, unlisted: true }); probed++; }
    }
  }
  return { layers: layers.map((l) => l.name), files, probed };
}

const surveyFile = (label) => path.join(CACHE, "survey", `${label}.files.txt`);

if (opt("--install")) {
  const dir = opt("--install");
  const label = opt("--label") ?? path.basename(path.dirname(dir));
  const { layers, files, probed } = mountMpqInstall(dir);
  fs.mkdirSync(path.dirname(surveyFile(label)), { recursive: true });
  fs.writeFileSync(surveyFile(label), [...files.keys()].sort().join("\n") + "\n");
  // The build's fingerprint, as src/vfs/mpqEra.ts `buildFingerprint` computes it at the mount.
  const fnv = (b) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); };
  const print = fnv(Buffer.concat(["units\\unitbalance.slk", "units\\abilitydata.slk", "melee_v0\\units\\abilitydata.slk"].map((f) => { const hit = files.get(f); return hit ? Buffer.from(hit.archive.get(hit.name).bytes()) : Buffer.alloc(0); })));
  console.log(`${label}: fingerprint ${print}`);
  const out = path.join(CACHE, "extract", label);
  fs.rmSync(out, { recursive: true, force: true });
  let n = 0;
  for (const [key, { archive, name }] of files) {
    if (!WANTED.test(key)) continue;
    const bytes = archive.get(name)?.bytes();
    if (!bytes) continue;
    // One spelling per folder, whatever the archive's: Linux would make `units/` beside `Units/`.
    const parts = name.split("\\").map((seg, i, all) => (i === all.length - 1 ? seg : FOLDERS[seg.toLowerCase()] ?? seg));
    const file = path.join(out, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    n++;
  }
  // A data set is an OVERLAY: 1.29 files only the tables a set changes under `Custom_V1\` and the
  // rest are read from the live path (which is what src/vfs/edition.ts does when a twin is
  // absent), while 1.30.4 files every set whole. So the fallback is made explicit here, and a
  // diff against 1.30.4 then states what each set really reads.
  const live = path.join(out, "Units");
  for (const set of ["Custom_V0", "Custom_V1", "Melee_V0"]) {
    const have = new Set(fs.existsSync(path.join(out, set, "Units")) ? fs.readdirSync(path.join(out, set, "Units")).map((f) => f.toLowerCase()) : []);
    for (const f of fs.readdirSync(live)) {
      if (have.has(f.toLowerCase())) continue;
      fs.mkdirSync(path.join(out, set, "Units"), { recursive: true });
      fs.copyFileSync(path.join(live, f), path.join(out, set, "Units", f));
    }
  }
  console.log(`${label}: ${layers.join(" < ")} — ${files.size} files (${probed} of them in no listfile), ${n} data files to ${path.relative(REPO, out)}`);
}

if (args.includes("--reference")) {
  const { openCascInstall } = require("./install.cjs");
  const vfs = await openCascInstall(opt("--wc3-dir") ?? path.join(REPO, "Warcraft III"));
  fs.mkdirSync(path.dirname(surveyFile("1.30.4")), { recursive: true });
  fs.writeFileSync(surveyFile("1.30.4"), vfs.list().map((p) => p.toLowerCase().replace(/\//g, "\\")).sort().join("\n") + "\n");
  console.log(`1.30.4: ${vfs.list().length} files`);
}

if (opt("--compare")) {
  const label = opt("--compare");
  const read = (l) => new Set(fs.readFileSync(surveyFile(l), "utf8").split("\n").filter(Boolean));
  const ref = read("1.30.4"), theirs = read(label);
  // A campaign chapter is exploded in the store (`maps\…\x.w3x:war3map.j`) and a blob in an MPQ.
  const fold = (p) => p.replace(/^(maps\\.*?\.w3[xm]):.*$/, "$1");
  const have = new Set([...theirs].map(fold));
  const missing = [...new Set([...ref].map(fold))].filter((p) => !have.has(p) && !/^(war3_|_)(low|med)|^[a-z]\.mpq:.*_(low|med)/.test(p));
  const kind = (p) => {
    const ext = (/\.([a-z0-9]+)$/.exec(p) ?? [, "?"])[1];
    const top = p.includes(":") && !p.startsWith("maps") ? "tileset" : p.split("\\")[0];
    return `${top} .${ext}`;
  };
  const by = new Map();
  for (const p of missing) by.set(kind(p), [...(by.get(kind(p)) ?? []), p]);
  console.log(`${label}: ${theirs.size} files; lacks ${missing.length} of 1.30.4's ${ref.size}`);
  for (const [k, list] of [...by].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(list.length).padStart(5)}  ${k}   e.g. ${list.slice(0, 2).join(" · ")}`);
  fs.writeFileSync(path.join(CACHE, "survey", `${label}.missing.txt`), missing.join("\n") + "\n");
}
