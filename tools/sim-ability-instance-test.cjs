// Headless check of ability INSTANCES (docs/map-compatibility.md — the 1.31 ability-field API):
// one unit's ability or one item's ability given its own copy of the row by a script's
// `BlzSetAbility…Field`, read by everything that reads that ability — and nothing else.
//
// WC3's abilities are instances, and later-format maps are built on that: Test of Balance's
// items STACK (each charge rewrites THAT item's own `Idef`/`Iatt`), its cooldown rewards shorten
// ONE hero's `acdn`, and its pillar's Rejuvenation grows each wave. Writes go through the
// install's own `Units\AbilityMetaData.slk` routing — the same one a map's w3a edits take
// (objectData.ts writeAbilityField), so the file is read here rather than restated.
//
// Also here: SetUnitExploded — the burst of "Art - Special" and no corpse.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { MappedData } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata"));

const META = join(REPO, "Warcraft III", "ExtractedData", "merged", "Units", "AbilityMetaData.slk");
if (!existsSync(META)) {
  console.error("Run `pnpm data:extract` first — this test routes through the install's own AbilityMetaData.slk.");
  process.exit(2);
}
const meta = new MappedData(new TextDecoder("windows-1252").decode(readFileSync(META)));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const D = (...v) => { const a = new Array(9).fill(NaN); v.forEach((x, i) => { a[i] = x; }); return a; };
const lvl = (over = {}) => ({ cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0, data: D(), dataStr: [], buffs: [], summon: "", ...over });
const ability = (id, code, over = {}) => ({
  id, code, isHero: false, isItem: false, levels: 1, reqLevel: 0, levelSkip: 0,
  target: "none", targetFlags: [], autocast: false, name: id, icon: "", hotkey: "",
  researchHotkey: "", buttonX: 0, buttonY: 0, learnX: 0, learnY: 0, research: false,
  tips: [""], uberTips: [""], researchTip: "", researchUberTip: "",
  missileArt: "", targetArt: "", targetAttach: [], casterArt: "", specialArt: "", effectArt: "",
  areaArt: "", fxArt: "", effectSound: "", buffFx: [], buffArt: "", buffEffectArt: "",
  buffSpecialArt: "", lightning: [], animNames: [], order: "", orderOn: "", orderOff: "",
  levelData: [lvl()], ...over,
});
const ABILITIES = new Map([
  // AId1 — a Ring of Protection +1 (`AIde`, "Idef" = DataA): the kind of item Test of Balance stacks.
  ["AId1", ability("AId1", "AIde", { isItem: true, levelData: [lvl({ data: D(1) })] })],
  // A0PD — the pillar's Rejuvenation (`Arej`, "Rej1" = DataA), three ranks.
  ["A0PD", ability("A0PD", "Arej", { levels: 3, uberTips: ["r1", "r2", "r3"], levelData: [lvl({ cooldown: 30, data: D(400) }), lvl({ cooldown: 30, data: D(400) }), lvl({ cooldown: 30, data: D(400) })] })],
]);
const abilityReg = { get: (id) => ABILITIES.get(id), has: (id) => ABILITIES.has(id), buffFx: () => [], meta };
const item = (id, abils) => ({ id, name: id, abilities: abils, charges: 0, usable: false, perishable: false, powerup: false, droppable: true, classType: "Permanent" });
const ITEMS = new Map([["rde1", item("rde1", ["AId1"])]]);
const unitRow = { priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2, specialArt: "Objects\\Spawnmodels\\Human\\HumanLargeDeathExplode\\HumanLargeDeathExplode.mdx" };
const N = 128;
const world = new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
  abilityReg, { get: (id) => ITEMS.get(id), has: (id) => ITEMS.has(id) }, { get: () => unitRow, has: () => true });

let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 1000, y: 1000, prevX: 1000, prevY: 1000,
    hp: 100, maxHp: 1000, mana: 0, maxMana: 0, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "human", level: 1, xp: 0,
    skillPoints: 0, hpRegen: 0, manaRegen: 0, baseMaxHp: 1000, baseMaxMana: 0, baseHpRegen: 0,
    baseManaRegen: 0, baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, radius: 16, footprint: 0,
    order: "idle", targetId: null, path: [], waypoint: 0, moving: false, facing: 0,
    pendingCast: null, followLeaderId: null, inCombat: false, working: false, atNode: false,
    noCollision: false, stallT: 0, waitT: 0, gaveUp: false, acquireT: 0, arrowShot: null,
    constructing: 0, cooldownLeft: 0, linkT: 0, linkGroup: [], repathT: 0, stunned: false,
    baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0, str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0,
    intPerLevel: 0, primaryAttr: 0, magicImmune: false, detectRadius: 0, summonLeft: 0,
    immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false,
    garrison: [], itemCooldowns: new Map(),
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const give = (u, itemId, entity) => { u.inventory.push({ id: entity, itemId, charges: 0, cooldownLeft: 0 }); world.recomputeStats(u); };
const ref = (kind, owner, abilId) => ({ kind, owner, abilId });

console.log("an ITEM's own ability");
{
  const a = unit(), b = unit();
  give(a, "rde1", 501);
  give(b, "rde1", 502);
  check("two copies of one item start at the row's +1 armour each", [a.armor, b.armor], [1, 1]);
  check("the item's ability reads through its instance", world.abilityInstanceField(ref("item", 501, "AId1"), "Idef", 1), 1);
  // Test of Balance: `BlzSetAbilityIntegerLevelFieldBJ(BlzGetItemAbilityByIndex(item, 0), ABILITY_ILF_DEFENSE_BONUS_IDEF, 0, 2 * charges)`
  check("a script's write lands", world.setAbilityInstanceField(ref("item", 501, "AId1"), "Idef", 1, 6), true);
  world.recomputeStats(a); world.recomputeStats(b);
  check("THAT item gives +6 now…", a.armor, 6);
  check("…and the other copy is still +1", b.armor, 1);
  check("…and the TYPE's row is untouched", ABILITIES.get("AId1").levelData[0].data[0], 1);
  // It travels with the item: hand it to b (same entity id, as every move keeps it).
  b.inventory.push(a.inventory.pop()); world.recomputeStats(a); world.recomputeStats(b);
  check("handed over, the rewritten item still gives +6 (to its new carrier)", [a.armor, b.armor], [0, 7]);
  check("an item's ability ids, in its row's order", world.itemAbilityIds(501), ["AId1"]);
  check("a field the meta file does not have is refused", world.setAbilityInstanceField(ref("item", 501, "AId1"), "Zzzz", 1, 5), false);
  check("an ability the item does not carry is refused", world.setAbilityInstanceField(ref("item", 501, "A0PD"), "Rej1", 1, 5), false);
  world.removeItemById(501);
  check("RemoveItem takes its rows with it (a new item with that id would be the type's)", world.itemAbilityDefOf(501, "AId1").levelData[0].data[0], 1);
}

console.log("\na UNIT's own ability");
{
  const pillar = unit({ abilities: [{ id: "A0PD", code: "Arej", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const other = unit({ abilities: [{ id: "A0PD", code: "Arej", level: 1, cooldownLeft: 0, autocastOn: false }] });
  // `BlzSetAbilityRealLevelFieldBJ(BlzGetUnitAbility(pillar, 'A0PD'), ABILITY_RLF_HIT_POINTS_GAINED_REJ1, lvl, 250 + 10 * wave)`
  world.setAbilityInstanceField(ref("unit", pillar.id, "A0PD"), "Rej1", 2, 310);
  check("the write is on rank 2 of THIS unit's copy", world.abilityInstanceField(ref("unit", pillar.id, "A0PD"), "Rej1", 2), 310);
  check("…ranks it did not name keep the row's value", world.abilityInstanceField(ref("unit", pillar.id, "A0PD"), "Rej1", 1), 400);
  check("…and the other unit's is the type's", world.abilityInstanceField(ref("unit", other.id, "A0PD"), "Rej1", 2), 400);
  // A cooldown reward: `ABILITY_RLF_COOLDOWN` ('acdn') on one hero.
  world.setAbilityInstanceField(ref("unit", pillar.id, "A0PD"), "acdn", 1, 18);
  check("the cooldown the CAST reads (abilityDefOf) is the instance's", world.abilityDefOf(pillar.abilities[0]).levelData[0].cooldown, 18);
  check("BlzGetUnitAbilityCooldown's rank data is the instance's", world.unitAbilityRankData(pillar.id, "A0PD", 0).cooldown, 18);
  check("…and the other unit's still the type's", world.unitAbilityRankData(other.id, "A0PD", 0).cooldown, 30);
  world.setAbilityInstanceField(ref("unit", pillar.id, "A0PD"), "aub1", 1, "Restores 260 hit points");
  check("a string field (the extended tooltip) per rank", world.abilityInstanceField(ref("unit", pillar.id, "A0PD"), "aub1", 1), "Restores 260 hit points");
  world.startAbilityCooldown(pillar.id, "A0PD", 4);
  check("BlzStartUnitAbilityCooldown sets that unit's clock", pillar.abilities[0].cooldownLeft, 4);
  // Losing the ability loses the changes, as in the game: the copy lives on the entry.
  pillar.abilities = [{ id: "A0PD", code: "Arej", level: 1, cooldownLeft: 0, autocastOn: false }];
  check("a fresh entry of the same ability is the type's again", world.abilityInstanceField(ref("unit", pillar.id, "A0PD"), "Rej1", 2), 400);
}

console.log("\nSetUnitExploded");
{
  const a = unit(), b = unit();
  world.setUnitExploded(a.id, true);
  world.drainSpellEffects();
  const before = world.corpses.size;
  world.killUnit(a.id);
  const fx = world.drainSpellEffects().map((e) => e.art);
  check("an exploded unit bursts into its Art - Special", fx.includes(unitRow.specialArt), true);
  check("…and leaves no corpse", world.corpses.size, before);
  check("…and the renderer is told (once)", [world.diedExploded(a.id), world.diedExploded(a.id)], [true, false]);
  world.killUnit(b.id);
  check("an ordinary death still leaves its corpse", world.corpses.size, before + 1);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall ability-instance checks passed");
