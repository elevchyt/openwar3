// PATCHES IN PLAY — the objects the game's later patches added, read through the real patched
// data door and run through the real sim (docs/patches.md, src/patches/).
//
// tools/patch-check.cjs proves every release APPLIES. This proves the result is a GAME: that
// the engine's own loaders, fed by `EditionDataSource(PatchDataSource(install))` exactly as
// vfs/loader.ts builds it, see the patched shops, and that the three new base codes the chain
// brings in — the Ritual Dagger's `AIdg`, Sundering Blades' `Aaab`, the Orb of Slow's `Aosl` —
// do what their rows say. And the scoping: a custom map, Reign of Chaos and a rolled-back patch
// level read the install untouched.
//
// Run: pnpm sim:test   (skips without `pnpm data:extract`)
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".sim-build");
fs.writeFileSync(join(BUILD, "package.json"), '{"type":"commonjs"}');
const { PatchDataSource } = require(join(BUILD, "src", "vfs", "patch.js"));
const { EditionDataSource } = require(join(BUILD, "src", "vfs", "edition.js"));
const { setMapDataSet, setEdition } = require(join(BUILD, "src", "data", "edition.js"));
const { setPatchLevel, BASE_PATCH, LATEST_PATCH } = require(join(BUILD, "src", "patches", "index.js"));
const { loadAbilityRegistry, KNOWN_ABILITIES } = require(join(BUILD, "src", "data", "abilities.js"));
const { loadItemRegistry } = require(join(BUILD, "src", "data", "items.js"));
const { loadTechRegistry } = require(join(BUILD, "src", "data", "techtree.js"));
const { loadUnitRegistry } = require(join(BUILD, "src", "data", "units.js"));
const { SimWorld } = require(join(BUILD, "src", "sim", "world.js"));
const { PathingGrid } = require(join(BUILD, "src", "sim", "pathing.js"));
const { BlpImage } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "blp", "image.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "UnitBalance.slk"))) {
  console.log("skip  no extracted install (run `pnpm data:extract` on a 1.30.4 install)");
  process.exit(0);
}
const onDisk = (p) => {
  let dir = EXTRACT;
  for (const part of p.replace(/\//g, "\\").split("\\")) {
    if (!part) continue;
    let hit;
    try { hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase()); } catch { return null; }
    if (!hit) return null;
    dir = join(dir, hit);
  }
  return fs.statSync(dir).isFile() ? dir : null;
};
const base = {
  label: "ExtractedData",
  exists: (p) => onDisk(p) !== null,
  rawBytes: (p) => { const f = onDisk(p); return f ? new Uint8Array(fs.readFileSync(f)) : null; },
  read: async (p) => base.rawBytes(p),
  list: () => [],
};
const vfs = new EditionDataSource(new PatchDataSource(base));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
}

setEdition("tft");
setMapDataSet("melee");

console.log(`\nthe shops, at the latest patch (${LATEST_PATCH})`);
const tech = loadTechRegistry(vfs);
const items = loadItemRegistry(vfs);
const abilities = loadAbilityRegistry(vfs);
const tomb = tech.get("utom").makeitems;
check("the Tomb of Relics sells a Wand of Negation (1.36.2)", tomb.includes("wneg"), true);
check("…and a Ritual Dagger (1.31.0)", tomb.includes("ritd"), true);
check("…and no longer a Scroll of Healing", tomb.includes("shea"), false);
check("the Arcane Vault sells an Orb of Slow instead of an Orb of Fire (2.0.2)",
  [tech.get("hvlt").makeitems.includes("oslo"), tech.get("hvlt").makeitems.includes("ofir")], [true, false]);
const ritd = items.get("ritd");
check("the Ritual Dagger is an item, on its regenerate ability", ritd?.abilities, ["AIg2"]);
check("…at 75 gold, one charge (2.0.2)", [ritd?.gold, ritd?.charges], [75, 1]);
check("…wearing the game's own icon path", ritd?.icon, "ReplaceableTextures\\CommandButtons\\BTNSacrificialDagger.blp");
for (const icon of [ritd?.icon, "ReplaceableTextures\\CommandButtonsDisabled\\DISBTNSacrificialDagger.blp",
  "ReplaceableTextures\\CommandButtons\\BTNSunderingBlades.blp", "ReplaceableTextures\\PassiveButtons\\PASBTNSunderingBlades.blp"]) {
  const bytes = vfs.rawBytes(icon);
  let size = null;
  try { const img = new BlpImage(); img.load(bytes); size = [img.width, img.height]; } catch { /* reported below */ }
  check(`our icon is served and decodes: ${icon.split("\\").pop()}`, size, [64, 64]);
}
const wand = items.get("wneg");
check("the Wand of Negation is a single-target purge (2.0.2), 120 gold and 3 charges (2.0.4)",
  [wand?.abilities, wand?.gold, wand?.charges], [["AIpw"], 120, 3]);
check("Sundering Blades is a research of the Barracks", tech.get("hbar").researches.includes("Rhsb"), true);
check("…and the Knight carries its passive", loadUnitRegistry(vfs).get("hkni")?.abilities.includes("Ahsb"), true);
// A unit SPAWNS with only the abilities whose base code the engine knows
// (RtsController.buildInitialAbilities), so a new code the chain brings in and nobody
// registered is dropped at the door — which is how the Knight first came out of the Barracks
// without Sundering Blades while every check on the data passed.
for (const id of ["Ahsb", "AIg2", "AIno", "AUa2", "AIpw"]) {
  const def = abilities.get(id);
  check(`${id} (code ${def?.code}) is a code the engine implements`, !!KNOWN_ABILITIES[def?.code], true);
}

const { gameNum } = require(join(BUILD, "src", "data", "gameplayConstants.js"));
check("a shop pays 60% of an item's price for it (1.32.10 PawnItemRate)", gameNum("PawnItemRate"), 0.6);
check("…and a Hero revives in 0.6 × level × build time (1.35.0 ReviveTimeFactor)", gameNum("ReviveTimeFactor"), 0.6);

console.log("\nthe patches reach the live melee tables and nothing else");
setMapDataSet("custom");
check("a custom map's Tomb still sells the Scroll of Healing", loadTechRegistry(vfs).get("utom").makeitems.includes("shea"), true);
check("…and has never heard of a Ritual Dagger", loadItemRegistry(vfs).get("ritd") ?? null, null);
check("…and pays the custom rate, 50%", gameNum("PawnItemRate"), 0.5);
setMapDataSet("melee");
setEdition("roc");
check("Reign of Chaos has no Ritual Dagger either", loadItemRegistry(vfs).get("ritd") ?? null, null);
setEdition("tft");
setPatchLevel(BASE_PATCH);
check(`rolled back to ${BASE_PATCH}: the Tomb sells the Scroll of Healing again`, loadTechRegistry(vfs).get("utom").makeitems.includes("shea"), true);
check("…and our icons are gone with the dagger", vfs.exists("ReplaceableTextures\\CommandButtons\\BTNSacrificialDagger.blp"), false);
setPatchLevel("1.32.10");
check("rolled back to 1.32.10: the Ritual Dagger costs 100", loadItemRegistry(vfs).get("ritd")?.gold, 100);
setPatchLevel(LATEST_PATCH);

// --- the sim, on the real rows -----------------------------------------------------------------
const N = 256;
const units = loadUnitRegistry(vfs);
const newWorld = () => new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1, abilities, items, units);
let world = newWorld();
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 1000, y: 1000, prevX: 1000, prevY: 1000,
    hp: 100, maxHp: 1000, mana: 0, maxMana: 500, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "undead", level: 1, xp: 0,
    skillPoints: 0, hpRegen: 0, manaRegen: 0, baseMaxHp: 1000, baseMaxMana: 500, baseHpRegen: 0,
    baseManaRegen: 0, baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, radius: 16, footprint: 0,
    order: "idle", targetId: null, path: [], waypoint: 0, moving: false, facing: 0,
    pendingCast: null, followLeaderId: null, inCombat: false, working: false, atNode: false,
    noCollision: false, stallT: 0, waitT: 0, gaveUp: false, acquireT: 0, arrowShot: null,
    constructing: 0, cooldownLeft: 0, linkT: 0, linkGroup: [], repathT: 0, stunned: false,
    baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0, str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0,
    intPerLevel: 0, primaryAttr: 0, magicImmune: false, detectRadius: 0, summonLeft: 0,
    immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false, armorType: "medium",
    pierceTaken: 1, magicTaken: 1, garrison: [],
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}

console.log("\nthe Ritual Dagger sacrifices, and the allies around the body regenerate");
{
  const hero = unit({ isHero: true });
  hero.inventory[0] = { id: nextId++, itemId: "ritd", charges: 1, cooldownLeft: 0 };
  world.recomputeStats(hero);
  const ghoul = unit({ typeId: "ugho", x: 1200, y: 1000, prevX: 1200, prevY: 1000, hp: 340, maxHp: 340 });
  const hurt = unit({ typeId: "ugho", x: 1400, y: 1000, prevX: 1400, prevY: 1000, hp: 50, maxHp: 340 });
  const far = unit({ typeId: "ugho", x: 2500, y: 1000, prevX: 2500, prevY: 1000, hp: 50, maxHp: 340 });
  const enemy = unit({ x: 1300, y: 1000, prevX: 1300, prevY: 1000, owner: 1, team: 1, hp: 50, maxHp: 340, race: "human" });
  check("the dagger fires on a friendly non-hero", world.useItem(hero.id, 0, ghoul.id, 0, 0), true);
  check("…which it kills", ghoul.hp <= 0 || !world.units.has(ghoul.id) || world.units.get(ghoul.id).dead === true, true);
  const regen = (u) => u.buffs.find((b) => b.group === "item:regen");
  check("the ally beside the body regenerates", !!regen(hurt), true);
  check("…200 over 45 s (2.0.2)", regen(hurt) && Math.round(regen(hurt).value * 45), 200);
  check("…but not one 1500 away (Area 450)", !!regen(far), false);
  check("…nor the enemy", !!regen(enemy), false);
}

console.log("\nSundering Blades: the Knight hits Medium armour 10% harder, and only Medium");
{
  world = newWorld();
  const knight = unit({ typeId: "hkni", race: "human", abilities: [{ id: "Ahsb", code: "Aaab", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const plain = unit({ typeId: "hkni", race: "human" });
  const medium = unit({ owner: 1, team: 1, x: 1100, prevX: 1100, hp: 10000, maxHp: 10000, armorType: "medium" });
  const heavy = unit({ owner: 1, team: 1, x: 1100, prevX: 1100, hp: 10000, maxHp: 10000, armorType: "large" });
  const hit = (a, t) => { const before = t.hp; world.applyDamage(t, 100, a.id, "normal"); return Math.round((before - t.hp) * 100) / 100; };
  const withBlades = hit(knight, medium);
  const without = hit(plain, medium);
  check("against Medium armour: ×1.10", Math.round((withBlades / without) * 100) / 100, 1.1);
  check("against Heavy armour: no bonus", hit(knight, heavy), hit(plain, heavy));
}

console.log("\nthe Orb of Slow's own slow (AIno, code Aosl) slows on the Sorceress's terms");
{
  world = newWorld();
  const caster = unit({ race: "human" });
  const foe = unit({ owner: 1, team: 1, x: 1100, prevX: 1100 });
  const def = abilities.get("AIno");
  check("AIno is on base code Aosl", def?.code, "Aosl");
  world.applySpellEffect("Aosl", 1, caster, { targetId: foe.id, x: foe.x, y: foe.y }, def);
  const slow = foe.buffs.find((b) => b.kind === "slow");
  check("the target is slowed 55% move / 25% attack for 10 s", slow && [slow.value, slow.value2, slow.timeLeft], [0.55, 0.25, 10]);
}

if (failed) {
  console.error(`\npatches in play: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\npatches in play: all checks passed");
