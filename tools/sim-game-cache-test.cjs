// GAME CACHES — a hero's level, skills and belt on their way to the next chapter.
//
// The sim's half of `StoreUnit` / `RestoreUnit` (src/jass/natives/gamecache.ts,
// docs/campaigns.md). Nothing in the install states which unit properties the cache carries, so
// the field list comes from what the CAMPAIGN does with it, and this file pins each one:
//
//   * level, experience, unspent skill points and the RANK of every learned ability — what
//     RoC's Human02 hand-writes as its fallback (`SetHeroLevel(udg_Arthas, 2, false)` plus two
//     `SelectHeroSkill` calls) for the case where there is nothing to restore;
//   * the INVENTORY, slot for slot — which is the only thing the TFT campaign's shared STASH
//     carries: `OrcX02` stores a throwaway `Obla` holding the stash building's items and
//     restores it on the next chapter;
//   * permanent TOME gains, as a delta over the unit type's own numbers, so a chapter that
//     retunes the hero in its own `war3map.w3u` still gets its own hero;
//
// and two that deliberately do NOT travel: hit points and mana (a restored unit arrives whole —
// no chapter in the game tops one up afterwards) and the level-up NOVA, because a restore is
// not a promotion.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { loadItemRegistry } = require(join(REPO, ".sim-build", "src", "data", "items.js"));
const { simHooks } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "UnitData.slk"))) {
  console.log("skip  no extracted game data (run `pnpm data:extract`)");
  process.exit(0);
}
const vfs = {
  label: "ExtractedData",
  rawBytes(p) {
    let dir = EXTRACT;
    for (const part of p.split("\\")) {
      const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase());
      if (!hit) return null;
      dir = join(dir, hit);
    }
    return new Uint8Array(fs.readFileSync(dir));
  },
  exists: () => false,
  list: () => [],
};
const ABILITIES = loadAbilityRegistry(vfs);
const UNITS = loadUnitRegistry(vfs);
const ITEMS = loadItemRegistry(vfs);

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const N = 200;
const world = () =>
  new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N) }, [0, 0]), 1, ABILITIES, ITEMS, UNITS);
let nextId = 1;
function spawn(w, typeId, x = 1600, y = 1600, owner = 0) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  return w.add(
    {
      id: nextId++, owner, team: 0, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying: false, flyHeight: 0,
      sightDay: def.sightDay || 1400, sightNight: def.sightNight || 800,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: "ground", moveType: def.moveType,
      worker: null, depotGold: false, depotLumber: false,
    },
    null,
    {
      hero: def.isHero
        ? {
          properName: "", level: Math.max(1, def.level), str: def.strength, agi: def.agility, int: def.intelligence,
          strPerLevel: def.strPerLevel, agiPerLevel: def.agiPerLevel, intPerLevel: def.intPerLevel, primaryAttr: def.primaryAttr,
        }
        : undefined,
      abilities: initialAbilities(def),
      level: def.level,
    },
  );
}

/** The ability sheet `RtsController.buildInitialAbilities` gives a new unit: its innate
 *  abilities at rank 1 and its HERO abilities at rank 0 (unlearned). Mirrored here because the
 *  restore has to put ranks onto exactly that sheet. */
function initialAbilities(def) {
  const out = [];
  for (const id of def.abilities) {
    const a = ABILITIES.get(id);
    if (a) out.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: false });
  }
  for (const id of def.heroAbilities) {
    const a = ABILITIES.get(id);
    if (a) out.push({ id, code: a.code, level: 0, cooldownLeft: 0, autocastOn: false });
  }
  return out;
}

// 'Hart' is Arthas — the hero the human campaign carries from chapter to chapter, and the very
// unit RoC's Human01 stores and Human02 restores.
console.log("a hero's PROGRESS crosses the chapter boundary");
{
  const w = world();
  const arthas = spawn(w, "Hart");
  arthas.properName = "Arthas Menethil";
  w.setHeroLevel(arthas.id, 5);
  arthas.skillPoints = 2;
  // 'AHhb' Holy Light and 'AHad' Devotion Aura — the two skills Human02's own fallback hands a
  // default Arthas, so they are the two the real thing has to survive with.
  w.setAbilityLevel(arthas.id, "AHhb", 2);
  w.setAbilityLevel(arthas.id, "AHad", 1);
  const stored = w.storeUnitState(arthas.id);
  check("the type is written down", stored.typeId, "Hart");
  check("…with the level, the bar and the unspent points",
    [stored.level, stored.xp > 0, stored.skillPoints], [5, true, 2]);
  check("…and the RANK of each skill",
    [stored.abilities.find((a) => a.id === "AHhb").level, stored.abilities.find((a) => a.id === "AHad").level], [2, 1]);

  // The next chapter: a brand-new Arthas, then the cache put back on top of him.
  const next = world();
  const fresh = spawn(next, "Hart");
  check("a fresh hero starts at level 1 with nothing learned",
    [fresh.level, next.abilityLevelOf(fresh.id, "AHhb")], [1, 0]);
  check("applyStoredUnit answers true", next.applyStoredUnit(fresh.id, stored), true);
  check("he arrives at the level he left on", fresh.level, 5);
  check("…with his experience", fresh.xp, stored.xp);
  check("…his unspent skill points", fresh.skillPoints, 2);
  check("…his skills at their ranks",
    [next.abilityLevelOf(fresh.id, "AHhb"), next.abilityLevelOf(fresh.id, "AHad")], [2, 1]);
  check("…and his given name, not a fresh roll", fresh.properName, "Arthas Menethil");
  // The attributes are DERIVED from the level (`baseStr + strPerLevel × (level − 1)`), which is
  // what lets the restore write the level down instead of levelling the hero up five times.
  check("his attributes match a level-5 hero's", [fresh.str, fresh.agi, fresh.int], [arthas.str, arthas.agi, arthas.int]);
  check("…and so does his life ceiling", fresh.maxHp, arthas.maxHp);
}

console.log("\n…and a restore is not a promotion");
{
  const w = world();
  const stored = (() => {
    const a = spawn(w, "Hart");
    w.setHeroLevel(a.id, 6);
    return w.storeUnitState(a.id);
  })();
  const next = world();
  const fresh = spawn(next, "Hart");
  next.drainLevelUps?.(); // clear anything the spawn itself queued
  next.applyStoredUnit(fresh.id, stored);
  // Five ranks crossed by `setHeroLevel` would be five novas and five EVENT_PLAYER_HERO_LEVEL
  // firings on the opening frame of a chapter whose triggers are already registered.
  check("no level-up nova is queued", (next.drainLevelUps?.() ?? []).length, 0);
  check("…and the hero is still level 6", fresh.level, 6);
}

// common.j: `SetHeroLevel takes unit whichHero, integer level, boolean showEyeCandy`. The flag
// is the NOVA, and the campaign leans on it — Human01's own opening line is
// `call SetHeroLevel( gg_unit_Huth_0024, 10, false )`, Uther arriving at Strahnbrad already a
// level-10 paladin. Ignored, it burned Levelupcaster.mdx over him mid-cinematic.
console.log("\n…and `showEyeCandy` is a knob, not a comment");
{
  const w = world();
  // `Huth` is Uther the Lightbringer, the very hero Human01 names.
  const uther = spawn(w, UNITS.get("Huth") ? "Huth" : "Hart");
  w.drainLevelUps();
  w.setHeroLevel(uther.id, 10, false);
  check("a script that seats a hero plays no nova", w.drainLevelUps().length, 0);
  check("…but he is level 10 all the same", uther.level, 10);

  const loud = spawn(w, "Hart");
  w.drainLevelUps();
  w.setHeroLevel(loud.id, 4, true);
  check("showEyeCandy true still flashes, once per rank crossed", w.drainLevelUps().length, 3);

  // The XP writers take the same flag, for the levels the new bar crosses.
  const quiet = spawn(w, "Hart");
  w.drainLevelUps();
  w.addHeroXp(quiet.id, 100000, false);
  check("AddHeroXP obeys it too", [w.drainLevelUps().length, quiet.level > 1], [0, true]);
}

console.log("\nhe keeps his BELT, slot for slot");
{
  const w = world();
  const arthas = spawn(w, "Hart");
  // A potion with a charge spent, an empty slot, then a permanent — so the order and the
  // charges both have to survive rather than just the set of items.
  const potion = w.createItem("phea", arthas.x, arthas.y);
  w.unitAddItem(arthas.id, potion, 0);
  const ring = w.createItem("rde1", arthas.x, arthas.y);
  w.unitAddItem(arthas.id, ring, 2);
  w.setItemCharges(potion, 3);
  const stored = w.storeUnitState(arthas.id);
  check("the belt is stored slot for slot",
    stored.inventory.slice(0, 3).map((h) => (h ? `${h.typeId}x${h.charges}` : null)),
    ["pheax3", null, "rde1x0"]);

  const next = world();
  const fresh = spawn(next, "Hart");
  next.applyStoredUnit(fresh.id, stored);
  check("…and comes back in the same slots",
    fresh.inventory.slice(0, 3).map((h) => (h ? `${h.itemId}x${h.charges}` : null)),
    ["pheax3", null, "rde1x0"]);
  // A restored item is a NEW entity with an id of its own — the one it had belonged to a world
  // that no longer exists — but it is a real item: it can be used, dropped and sold.
  check("the potion is a live item", next.items.has(fresh.inventory[0].id) === false && fresh.inventory[0].id > 0, true);
  // `rde1` is the Ring of Protection +2 — so the restore has to end with a recompute, or the
  // hero comes back holding his gear with none of it counted.
  check("…and the ring's +2 armour is counted", Math.round(fresh.armor - spawn(next, "Hart").armor), 2);
}

console.log("\nwhat the hero ATE travels; what the chapter says he is does not");
{
  const w = world();
  const arthas = spawn(w, "Hart");
  const before = { str: arthas.baseStr, hp: arthas.baseMaxHp };
  arthas.baseStr += 6; // three Tomes of Strength
  arthas.baseMaxHp += 200; // a Manual of Health
  w.recomputeStats(arthas);
  const stored = w.storeUnitState(arthas.id);
  check("the tomes are a DELTA, not an absolute", [stored.tomes.str, stored.tomes.hp], [6, 200]);
  check("…and the untouched attributes are zero", [stored.tomes.agi, stored.tomes.int], [0, 0]);

  const next = world();
  const fresh = spawn(next, "Hart");
  next.applyStoredUnit(fresh.id, stored);
  check("they land on the new chapter's own hero", [fresh.baseStr - before.str, fresh.baseMaxHp - before.hp], [6, 200]);
}

console.log("\na restored unit arrives WHOLE");
{
  const w = world();
  const arthas = spawn(w, "Hart");
  w.setHeroLevel(arthas.id, 3);
  arthas.hp = 40;
  arthas.mana = 5;
  const stored = w.storeUnitState(arthas.id);
  const next = world();
  const fresh = spawn(next, "Hart");
  next.applyStoredUnit(fresh.id, stored);
  check("hit points are full, not the wreck he finished on", fresh.hp, fresh.maxHp);
  check("…and so is the mana pool", fresh.mana, fresh.maxMana);
}

console.log("\nthe STASH: a unit that is nothing but an inventory");
{
  // The TFT campaign's shared stash, in miniature: a throwaway body carries the items across.
  // It has no level, no experience and no abilities, so if `StoreUnit` did not save an
  // inventory the whole mechanism would be a no-op.
  const w = world();
  const dummy = spawn(w, "Obla");
  const axe = w.createItem("klmm", dummy.x, dummy.y); // Killmaim, one of OrcX02's own stash items
  w.unitAddItem(dummy.id, axe, 0);
  const stored = w.storeUnitState(dummy.id);
  check("a non-hero's inventory is stored too", stored.inventory[0].typeId, "klmm");
  const next = world();
  const fresh = spawn(next, "Obla");
  next.applyStoredUnit(fresh.id, stored);
  check("…and comes back", fresh.inventory[0].itemId, "klmm");
}

console.log("\nthe hooks reach the world");
{
  const w = world();
  const hooks = simHooks(w, (p) => p);
  const arthas = spawn(w, "Hart");
  w.setHeroLevel(arthas.id, 7);
  check("hooks.storeUnit reads the live unit", hooks.storeUnit(arthas.id).level, 7);
  check("…and answers null for a unit that is gone", hooks.storeUnit(99999), null);
}

console.log(failed ? `\ngame cache: ${failed} check(s) FAILED` : "\ngame cache: all checks passed");
process.exit(failed ? 1 : 0);
