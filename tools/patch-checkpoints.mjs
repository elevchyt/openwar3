// Fetch the CHECKPOINTS — real builds' data tables — that tools/patch-audit.mjs checks every
// release of the patch chain against (docs/patches.md, "Checking every release").
//
// Blizzard's CDN keeps only the live build (`patch-extract.mjs --cdn` fetches that one). Every
// intermediate build survives only as a copy some community project committed to GitHub, so each
// checkpoint below is pinned to the exact commit it was read from, and to how its version was
// established. They land in `.cdn-cache/extract/<version>-community/Units/`, gitignored like the
// install: they are Blizzard's data, fetched to the developer's own disk, never shipped.
//
// Three of the copies do not say which build they are (flowtsohg's and two of warpack's); their
// version was established by fingerprinting them against the chain — the release whose folded
// state they disagree with LEAST — and is corroborated by commit dates and messages where
// there are any. 1.32.10's copy cannot be told from 1.33/1.34, which changed no table.
//
//   node tools/patch-checkpoints.mjs          fetch any that are missing
//   node tools/patch-checkpoints.mjs --force  fetch them all again

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outArg = process.argv.indexOf("--out");
const OUT = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(REPO, ".cdn-cache", "extract");
const UA = { "User-Agent": "openwar3-patch-checkpoints" };

/** version → sources, applied in order; a later source only adds files the earlier ones lack. */
const CHECKPOINTS = {
  "1.31.1": [["sumneko/w3x2lni", "cdc5f5208fb924e5be2f26fbfa2a8d3ffb368f45", "data/zhCN-1.31.1/mpq/units"]],
  "1.32.1": [["sumneko/w3x2lni", "bd4236c797c92bd91ceb8d86e9fa0e1bb17db398", "data/zhCN-1.32.1/mpq/units"]],
  "1.32.5": [["sumneko/w3x2lni", "6159624102170afb3f665b2f5e31f39d50ea2409", "data/zhCN-1.32.5/mpq/units"]],
  "1.32.7": [["sumneko/w3x2lni", "69c358272cb11e4d27a6d3cf385ba8cd71b743ad", "data/zhCN-1.32.7/mpq/units"]],
  "1.32.8": [["sumneko/w3x2lni", "4aab2fbb852aa4bb6019e3db815d1043bd13c0d7", "data/zhCN-1.32.8/mpq/units"]],
  "1.32.9": [["flowtsohg/war3-objectdata", "dc5e2da21217dba8e5f750c1e867d691ab193ec1", "objectdata/units"]], // fingerprint
  "1.32.10": [["rhazarian/warpack", "06213709819c8ef316f95e6d19deab4ceba04fdc", "stock-data/data/units"]], // fingerprint
  "2.0.2": [["rhazarian/warpack", "d6443bd4cbe9c080e7ed03b24d1d505a6b812b3a", "stock-data/data/units"]], // fingerprint: build 22692
  "2.0.3": [["rhazarian/warpack", "fa5e065f5711055bb7ce481ac542cb0a2444cf42", "stock-data/data/units"]], // commit says 2.0.3
  "2.0.4": [
    ["tdauth/wowr", "b864da7544077acfb37ba3d032da7643df92c135", "wc3/wc3wowre/Units"],
    ["voces/wc3data", "e53bc463fd668d9803465dbb96e82738320c2638", "data/units"],
    ["voces/wc3data", "e53bc463fd668d9803465dbb96e82738320c2638", "data/items"],
  ],
};

const force = process.argv.includes("--force");
for (const [version, sources] of Object.entries(CHECKPOINTS)) {
  const name = version === "1.32.8" ? "1.32.8-w3x2lni" : `${version}-community`;
  const dir = path.join(OUT, name, "Units");
  if (fs.existsSync(dir) && !force) {
    console.log(`have  ${name}`);
    continue;
  }
  fs.rmSync(path.join(OUT, name), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const have = new Set();
  for (const [repo, sha, prefix] of sources) {
    const tree = await (await fetch(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, { headers: UA })).json();
    if (!tree.tree) throw new Error(`${repo}@${sha}: ${JSON.stringify(tree).slice(0, 200)}`);
    const files = tree.tree.filter((t) => t.type === "blob" && t.path.toLowerCase().startsWith(prefix.toLowerCase() + "/")
      && !t.path.slice(prefix.length + 1).includes("/") && /\.(slk|txt)$/i.test(t.path));
    for (const f of files) {
      const base = path.basename(f.path);
      if (have.has(base.toLowerCase())) continue;
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${f.path}`, { headers: UA });
      if (!res.ok) throw new Error(`${f.path}: ${res.status}`);
      let bytes = Buffer.from(await res.arrayBuffer());
      // CRLF throughout and a final newline: the copies strip or mix them, and mdx-m3-viewer's
      // IniFile splits on \r\n alone (a bare \r on the last line hides its last key).
      if (/\.txt$/i.test(base)) bytes = Buffer.from(bytes.toString("latin1").replace(/\r*\n/g, "\r\n").replace(/\r*$/, "\r\n"), "latin1");
      fs.writeFileSync(path.join(dir, base), bytes);
      have.add(base.toLowerCase());
    }
  }
  fs.writeFileSync(path.join(OUT, name, "SOURCE.txt"), sources.map((s) => `${s[0]}@${s[1]} ${s[2]}`).join("\n") + "\n");
  console.log(`wrote ${name} (${have.size} files)`);
}
