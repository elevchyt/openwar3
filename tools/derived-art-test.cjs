// DERIVED ICONS — the art a later patch names and a 1.30.4 install lacks, computed at mount from
// the art it has (src/vfs/derivedArt.ts, docs/icons.md), checked against the REAL install.
//
//   • A PASBTN derived from its BTN matches the game's own PASBTN — tested on the pairs 1.30.4
//     ships both halves of (Evasion, Critical Strike), within a few levels of 255.
//   • A missing DISPASBTN is its DISBTN, byte for byte.
//   • A file the install HAS is never replaced.
//   • `prepare()` over the patched tables derives the 1.32 upgrade badges' icons, and every one
//     of them decodes.
//   • `placeholderIcon`: a live button icon nothing can supply falls back to BTNTemp; a texture
//     and a greyed twin do not.
//
// Run: pnpm sim:test   (skips without the install in `Warcraft III/`)
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".sim-build");
fs.writeFileSync(join(BUILD, "package.json"), '{"type":"commonjs"}');
globalThis.ImageData ??= class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
const { DerivedArtDataSource, passiveFromCommand } = require(join(BUILD, "src", "vfs", "derivedArt.js"));
const { PatchDataSource } = require(join(BUILD, "src", "vfs", "patch.js"));
const { EditionDataSource } = require(join(BUILD, "src", "vfs", "edition.js"));
const { placeholderIcon } = require(join(BUILD, "src", "data", "commandStrings.js"));
const { BlpImage } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "blp", "image.js"));
const { openInstall } = require("./install.cjs");

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
}
const decode = (bytes) => {
  const img = new BlpImage();
  img.load(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice());
  return img.getMipmap(0);
};
/** Mean absolute difference per channel, over RGB. */
const mae = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i + c] - b.data[i + c]);
  return sum / (a.data.length / 4 * 3);
};

console.log("\nplaceholderIcon — the last resort is BTNTemp, and only for a live button icon");
check("a missing command icon", placeholderIcon("ReplaceableTextures\\CommandButtons\\BTNNoSuchThing.blp"), "ReplaceableTextures\\CommandButtons\\BTNTemp.blp");
check("a missing passive icon", placeholderIcon("ReplaceableTextures\\PassiveButtons\\PASBTNNoSuchThing.blp"), "ReplaceableTextures\\CommandButtons\\BTNTemp.blp");
check("a map's imported icon by name", placeholderIcon("war3mapImported\\BTNCustom.blp"), "ReplaceableTextures\\CommandButtons\\BTNTemp.blp");
check("not a greyed twin (its fallback is the live art)", placeholderIcon("ReplaceableTextures\\CommandButtonsDisabled\\DISBTNNoSuchThing.blp"), null);
check("not a model's texture", placeholderIcon("Units\\Human\\Footman\\Footman.blp"), null);
check("not BTNTemp itself", placeholderIcon("ReplaceableTextures\\CommandButtons\\BTNTemp.blp"), null);

if (!fs.existsSync(join(REPO, "Warcraft III", ".build.info"))) {
  console.log("skip  the rest: no install in Warcraft III/");
  process.exit(failed ? 1 : 0);
}

(async () => {
  const install = await openInstall(join(REPO, "Warcraft III"));
  const base = install.vfs ?? install;
  const vfs = new DerivedArtDataSource(new EditionDataSource(new PatchDataSource(base)));
  const CB = "ReplaceableTextures\\CommandButtons\\";
  const PB = "ReplaceableTextures\\PassiveButtons\\";
  const DB = "ReplaceableTextures\\CommandButtonsDisabled\\";

  console.log("\nthe passive rule, against the pairs 1.30.4 ships both halves of");
  for (const n of ["Evasion", "CriticalStrike"]) {
    const derived = decode(passiveFromCommand(base.rawBytes(`${CB}BTN${n}.blp`)));
    const real = decode(base.rawBytes(`${PB}PASBTN${n}.blp`));
    const bordered = decode(base.rawBytes(`${CB}BTN${n}.blp`));
    const e = mae(derived, real);
    check(`PASBTN${n} derived from BTN${n} is within 4/255 of the real one (${e.toFixed(2)}; the bordered BTN is ${mae(bordered, real).toFixed(1)})`, e < 4, true);
  }
  check("a file the install has is served as it is", Buffer.compare(Buffer.from(vfs.rawBytes(`${PB}PASBTNEvasion.blp`)), Buffer.from(base.rawBytes(`${PB}PASBTNEvasion.blp`))), 0);

  console.log("\nprepare(): the icons the patched tables name and the install lacks");
  const made = vfs.prepare();
  check(`derives the upgrade badges' art at mount (${made} icons)`, made >= 30, true);
  for (const n of ["Berserk", "DwarvenLongRifle", "HumanLumberUpgrade2", "WellSpring", "GhoulFrenzy"]) {
    check(`PASBTN${n} exists and decodes to 64×64`, (() => { const b = vfs.rawBytes(`${PB}PASBTN${n}.blp`); if (!b || !vfs.exists(`${PB}PASBTN${n}.blp`)) return null; const d = decode(b); return [d.width, d.height]; })(), [64, 64]);
  }
  check("DISPASBTNBerserk is DISBTNBerserk, byte for byte", Buffer.compare(Buffer.from(vfs.rawBytes(`${DB}DISPASBTNBerserk.blp`)), Buffer.from(base.rawBytes(`${DB}DISBTNBerserk.blp`))), 0);
  check("a PASBTN with no BTN to come from is not invented", vfs.exists(`${PB}PASBTNNoSuchThing.blp`), false);

  if (failed) {
    console.error(`\nderived icons: ${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nderived icons: all checks passed");
  process.exit(0);
})();
