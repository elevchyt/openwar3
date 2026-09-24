// Headless check of a 1.33+ map's SKIN object files (src/data/objectData.ts `ObjectLayer`), against
// the developer's own copy of Test of Balance (Warcraft III/Maps/Download — skipped if absent).
//
// A map saved by a 1.33+ editor splits every object in two: the gameplay columns stay in
// war3map.w3u/.w3a/.w3t and the ART and WORDS (model, icon, name, tooltips) move to
// war3mapSkin.w3u/.w3a/.w3t, same ids, same field codes. What is pinned:
//   * the skin pass lays its fields on the row the MAIN pass built — the hero pillar keeps the
//     1500 hit points war3map.w3u gave it and takes the Obelisk model and its name from the skin;
//   * without the skin pass it is a Marketplace, which is what the map looked like before;
//   * an ability's NAME comes from the skin — and the map's whole ability system matches abilities
//     by name (`GetAbilityName(a) == udg_Abilities[n] + " Q"`), so without it no pick ever landed;
//   * a unit a script put on a shop's shelf (AddUnitToStock) is one the shop sells.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const B = (...p) => require(join(REPO, ".sim-build", "src", ...p));
const { applyMapUnitData, applyMapAbilityData } = B("data", "objectData.js");
const { UnitRegistry } = B("data", "units.js");

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const MAP = join(REPO, "Warcraft III", "Maps", "Download", "Test of Balance v1.24-4p.w3x");
const META = join(REPO, "Warcraft III", "ExtractedData", "merged", "Units", "AbilityMetaData.slk");
if (!existsSync(MAP) || !existsSync(META)) {
  console.log("  (skip — needs the local Test of Balance map and `pnpm data:extract`)");
} else {
  const mpq = require("mdx-m3-viewer/dist/cjs/parsers/mpq");
  const Archive = (mpq.default ?? mpq).Archive;
  const buf = readFileSync(MAP);
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  const archive = new Archive();
  archive.load(bytes, true);
  const file = (name) => archive.get(name)?.bytes();
  const wts = file("war3map.wts");

  // Just enough of the install's rows for the two objects under test to clone from.
  const baseUnit = (id, name, model) => ({
    id, name, model, isHero: false, hitPoints: 500, mana: 0, armor: 0, strength: 0, agility: 0, intelligence: 0,
    primaryAttr: "", abilities: [], heroAbilities: [], classification: [], properNames: [], animProps: [],
    attachAnimProps: [], attachLinkProps: [], upgradesUsed: [], tint: [255, 255, 255], modelScale: 1,
    weapons: [{ damage: 0, dice: 1, sides: 1, targets: [], splashTargets: [] }],
  });
  const units = () => new UnitRegistry(new Map([
    ["nmrk", baseUnit("nmrk", "Marketplace", "Buildings\\Other\\Marketplace\\Marketplace.mdx")],
    ["hpea", baseUnit("hpea", "Peasant", "Units\\Human\\Peasant\\Peasant.mdx")],
  ]));

  console.log("a unit: gameplay from war3map.w3u, art and words from war3mapSkin.w3u");
  {
    const plain = units();
    applyMapUnitData(plain, file("war3map.w3u"), wts);
    check("without the skin file, the pillar is a Marketplace", [plain.get("n02S").name, plain.get("n02S").model.split("\\").pop()], ["Marketplace", "Marketplace.mdx"]);
    const reg = units();
    applyMapUnitData(reg, file("war3map.w3u"), wts);
    applyMapUnitData(reg, file("war3mapSkin.w3u"), wts, { skin: true });
    const pillar = reg.get("n02S");
    check("with it, the Sacred Pillar wears the map's Obelisk", [pillar.name, pillar.model], ["Sacred Pillar", "war3mapImported\\Obelisk.mdx"]);
    check("…and keeps the 1500 hit points the MAIN file gave it", pillar.hitPoints, 1500);
    const picker = reg.get("h000");
    check("the hero-picker is the invisible Dummy, not a Peasant", [picker.name, picker.model], ["Dummy", "none.mdx"]);
    check("…still at the 0 speed war3map.w3u set", picker.speed ?? 0, 0);
  }

  console.log("\nan ability's NAME is the skin's — the map matches abilities by it");
  {
    const meta = readFileSync(META);
    const abil = (id) => ({ id, code: id, name: "Base " + id, levels: 1, levelData: [{ data: [], dataStr: [], buffs: [] }], targetFlags: [], tips: [], uberTips: [], buffFx: [], lightning: [], animNames: [], targetAttach: [] });
    const regOf = () => {
      const custom = new Map();
      const base = new Map([["AIgx", abil("AIgx")]]);
      return {
        base: (id) => base.get(id), get: (id) => custom.get(id) ?? base.get(id), has: (id) => custom.has(id) || base.has(id),
        setCustom: (id, d) => custom.set(id, d), buffFx: () => [],
      };
    };
    const reg = regOf();
    applyMapAbilityData(reg, file("war3map.w3a"), meta, wts);
    check("without the skin, A03G reads as its base", reg.get("A03G")?.name, "Base AIgx");
    applyMapAbilityData(reg, file("war3mapSkin.w3a"), meta, wts, { skin: true });
    check("with it, A03G is the map's Glow", reg.get("A03G")?.name, "Glow");
  }
}

console.log("\na unit a SCRIPT stocked is one the shop sells");
{
  const { SimWorld } = B("sim", "world.js");
  const w = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
  const shop = { id: 3, owner: 0, hp: 100, building: { stock: null, unitSlots: 11, itemSlots: 11 } };
  w.units.set(shop.id, shop);
  w.typeSlots = () => 11;
  check("nothing on the shelf, nothing sold", w.stockedUnits(3), []);
  w.addToStock(3, "H01A", "unit", 1, 1); // AddUnitToStockBJ(heroType, pillar, 1, 1)
  w.addToStock(3, "ratf", "item", 1, 1);
  check("the stocked hero is listed — and the item is not a unit", w.stockedUnits(3), ["H01A"]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall object-skin checks passed");
process.exit(failed ? 1 : 0);
