// Unit object-data FIELD COVERAGE — every field a map's war3map.w3u can override, and what
// this engine does with it (src/data/objectData.ts).
//
// The bug it pins: **an edited STANDARD unit came up wearing half its edits.** Azure Tower
// Defense's "Azure Wisp" is not a custom unit at all — it is the Acolyte (`uaco`) in the
// w3u's ORIGINAL table, renamed, given the Wisp model, made to fly, and given `usnd` =
// "Wisp". It flew and it wore the right model, and it answered in the Acolyte's voice,
// because nothing read `usnd`. That was not one missing line: the setter table covered ~45
// of the 236 field codes a unit can carry, so the bounty a creep pays, its splash radius,
// its tint, its selection scale, its classification, its shadow, its walk gait and fifty
// other fields were all being dropped — on custom and edited-standard units alike, since
// both tables go through the same `applyMods`.
//
// So coverage is now a TEST rather than a hope. Every unit-usable code in the game's own
// Units\UnitMetaData.slk must appear in exactly one of:
//   • UNIT_SETTERS         — applied straight onto the UnitDef
//   • UNIT_DEFERRED_FIELDS — applied by applyMods after the loop (the attribute folds, text)
//   • UNIT_FIELD_NOTES     — deliberately not applied, WITH the reason
// A new field can then only go missing loudly.
//
// The code list comes from the developer's own install when it is unpacked
// (`pnpm data:extract`) and otherwise from the snapshot below, taken from 1.30.4's
// UnitMetaData.slk — so this runs on a machine with no Warcraft III on it.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

const { UNIT_SETTERS, UNIT_DEFERRED_FIELDS, UNIT_FIELD_NOTES, applyMapUnitData } =
  require(join(REPO, ".sim-build", "src", "data", "objectData.js"));
const { UnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const W3u = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "w3x", "w3u", "file")).default;
const ModifiedObject = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "w3x", "w3u", "modifiedobject")).default;
const Modification = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "w3x", "w3u", "modification")).default;
const { MappedData } = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "utils", "mappeddata"));

let failed = 0;
/** Round every real in a value to 4 places. The .w3u stores a `real`/`unreal` field as a
 *  FLOAT32, so a cooldown written as 0.9 reads back as 0.8999999761581421 — the game's own
 *  precision, not a bug, and not something a check about coverage should trip over. */
function round4(v) {
  if (typeof v === "number") return Math.round(v * 1e4) / 1e4;
  if (Array.isArray(v)) return v.map(round4);
  return v;
}
function check(what, got, want) {
  const ok = JSON.stringify(round4(got)) === JSON.stringify(round4(want));
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** Every unit-usable field code in 1.30.4's Units\UnitMetaData.slk (`useUnit`/`useHero`/
 *  `useBuilding` = 1), code → the SLK column it writes. Grouped by the meta's own `category`,
 *  which is what the object editor's "Art - …" / "Combat - …" headings are. */
const UNIT_CODES = {
  // abil
  uabi: "abilList",
  udaa: "auto",
  uhab: "heroAbilList",
  // art
  uaap: "Attachmentanimprops",
  ualp: "Attachmentlinkprops",
  uani: "animProps",
  uble: "blend",
  ubpr: "Boneprops",
  ubpx: "Buttonpos[0]",
  ubpy: "Buttonpos[1]",
  ucbs: "castbsw",
  uclb: "blue",
  uclg: "green",
  uclr: "red",
  ucpt: "castpt",
  ucua: "Casterupgradeart",
  udtm: "death",
  uept: "elevPts",
  uerd: "elevRad",
  ufrd: "fogRad",
  uico: "Art[0]",
  uimz: "impactZ",
  uisz: "impactSwimZ",
  ulos: "fatLOS",
  ulpx: "launchX",
  ulpy: "launchY",
  ulpz: "launchZ",
  ulsz: "launchSwimZ",
  umdl: "file",
  umxp: "maxPitch",
  umxr: "maxRoll",
  uocc: "occH",
  uori: "orientInterp",
  uprw: "propWin",
  urun: "run",
  usca: "modelScale",
  uscb: "scaleBull",
  usew: "selCircOnWater",
  ushb: "buildingShadow",
  ushh: "shadowH",
  ushr: "shadowOnWater",
  ushu: "unitShadow",
  ushw: "shadowW",
  ushx: "shadowX",
  ushy: "shadowY",
  uslz: "selZ",
  uspa: "Specialart[0]",
  ussc: "scale",
  ussi: "ScoreScreenIcon[0]",
  utaa: "Targetart[0]",
  utcc: "customTeamColor",
  utco: "teamColor",
  uubs: "uberSplat",
  uver: "fileVerFlags",
  uwal: "walk",
  // combat
  ua1b: "dmgplus1",
  ua1c: "cool1",
  ua1d: "dice1",
  ua1f: "Farea1",
  ua1g: "targs1",
  ua1h: "Harea1",
  ua1m: "Missileart[0]",
  ua1p: "splashTargs1",
  ua1q: "Qarea1",
  ua1r: "rangeN1",
  ua1s: "sides1",
  ua1t: "atkType1",
  ua1w: "weapTp1",
  ua1z: "Missilespeed[0]",
  ua2b: "dmgplus2",
  ua2c: "cool2",
  ua2d: "dice2",
  ua2f: "Farea2",
  ua2g: "targs2",
  ua2h: "Harea2",
  ua2m: "Missileart[1]",
  ua2p: "splashTargs2",
  ua2q: "Qarea2",
  ua2r: "rangeN2",
  ua2s: "sides2",
  ua2t: "atkType2",
  ua2w: "weapTp2",
  ua2z: "Missilespeed[1]",
  uacq: "acquire",
  uaen: "weapsOn",
  uamn: "minRange",
  uarm: "armor",
  ubs1: "backSw1",
  ubs2: "backSw2",
  ucs1: "weapType1",
  ucs2: "weapType2",
  udea: "deathType",
  udef: "def",
  udl1: "damageLoss1",
  udl2: "damageLoss2",
  udp1: "dmgpt1",
  udp2: "dmgpt2",
  udty: "defType",
  udu1: "dmgUp1",
  udu2: "dmgUp2",
  udup: "defUp",
  uhd1: "Hfact1",
  uhd2: "Hfact2",
  uma1: "Missilearc[0]",
  uma2: "Missilearc[1]",
  umh1: "MissileHoming[0]",
  umh2: "MissileHoming[1]",
  uqd1: "Qfact1",
  uqd2: "Qfact2",
  urb1: "RngBuff1",
  urb2: "RngBuff2",
  usd1: "spillDist1",
  usd2: "spillDist2",
  usr1: "spillRadius1",
  usr2: "spillRadius2",
  utar: "targType",
  utc1: "targCount1",
  utc2: "targCount2",
  uwu1: "showUI1",
  uwu2: "showUI2",
  // editor
  ucam: "campaign",
  udro: "dropItems",
  uhos: "hostilePal",
  uine: "inEditor",
  uspe: "special",
  util: "tilesets",
  utss: "tilesetSpecific",
  uuch: "useClickHelper",
  // move
  umas: "maxSpd",
  umis: "minSpd",
  umvf: "moveFloor",
  umvh: "moveHeight",
  umvr: "turnRate",
  umvs: "spd",
  umvt: "movetp",
  urpg: "repulseGroup",
  urpo: "repulse",
  urpp: "repulseParam",
  urpr: "repulsePrio",
  // path
  uabr: "buffRadius",
  uabt: "buffType",
  ucol: "collision",
  upap: "preventPlace",
  upar: "requirePlace",
  upat: "pathTex",
  upaw: "requireWaterRadius",
  // sound
  ubsl: "BuildingSoundLabel[0]",
  ulfi: "LoopingSoundFadeIn[0]",
  ulfo: "LoopingSoundFadeOut[0]",
  umsl: "MovementSoundLabel[0]",
  ursl: "RandomSoundLabel[0]",
  usnd: "unitSound",
  // stats
  uagi: "AGI",
  uagp: "AGIplus",
  ubba: "bountyplus",
  ubdg: "isbldg",
  ubdi: "bountydice",
  ubld: "bldtm",
  ubsi: "bountysides",
  ucar: "cargoSize",
  ucbo: "canBuildOn",
  ufle: "canFlee",
  ufma: "fmade",
  ufoo: "fused",
  ufor: "formation",
  ugol: "goldcost",
  ugor: "goldRep",
  uhhb: "hideHeroBar",
  uhhd: "hideHeroDeathMsg",
  uhhm: "hideHeroMinimap",
  uhom: "hideOnMinimap",
  uhpm: "HP",
  uhpr: "regenHP",
  uhrt: "regenType",
  uibo: "isBuildOn",
  uinp: "INTplus",
  uint: "INT",
  ulba: "lumberbountyplus",
  ulbd: "lumberbountydice",
  ulbs: "lumberbountysides",
  ulev: "level",
  ulum: "lumbercost",
  ulur: "lumberRep",
  umpi: "mana0",
  umpm: "manaN",
  umpr: "regenMana",
  unbm: "nbmmIcon",
  unbr: "nbrandom",
  upoi: "points",
  upra: "Primary",
  upri: "prio",
  urac: "race",
  urtm: "reptm",
  usid: "sight",
  usin: "nsight",
  usle: "canSleep",
  usma: "stockMax",
  usrg: "stockRegen",
  usst: "stockStart",
  ustp: "STRplus",
  ustr: "STR",
  utyp: "type",
  // tech
  ubui: "Builds",
  udep: "DependencyOr",
  umki: "Makeitems",
  upgr: "upgrades",
  ureq: "Requires",
  ures: "Researches",
  urev: "Revive[0]",
  urq1: "Requires1",
  urq2: "Requires2",
  urq3: "Requires3",
  urq4: "Requires4",
  urq5: "Requires5",
  urq6: "Requires6",
  urq7: "Requires7",
  urq8: "Requires8",
  urqa: "Requiresamount",
  urqc: "Requirescount[0]",
  urva: "Reviveat",
  usei: "Sellitems",
  useu: "Sellunits",
  utra: "Trains",
  uupt: "Upgrade",
  // text
  ides: "Description[0]",
  uawt: "Awakentip[0]",
  ucun: "Casterupgradename",
  ucut: "Casterupgradetip",
  uhot: "Hotkey[0]",
  unam: "Name[0]",
  unsf: "EditorSuffix[0]",
  upro: "Propernames",
  upru: "nameCount",
  utip: "Tip[0]",
  utpr: "Revivetip[0]",
  utub: "Ubertip[0]",
};

/** The install's own meta table when it is unpacked, so a patch that adds a field is caught
 *  on the developer's machine rather than only when the snapshot above is next refreshed. */
function liveCodes() {
  const p = join(REPO, "Warcraft III", "ExtractedData", "merged", "Units", "UnitMetaData.slk");
  if (!existsSync(p)) return null;
  const md = new MappedData(readFileSync(p, "latin1"));
  const out = {};
  for (const id of Object.keys(md.map)) {
    const r = md.getRow(id);
    if (r.string("useUnit") === "1" || r.string("useHero") === "1" || r.string("useBuilding") === "1") {
      out[id] = r.string("field");
    }
  }
  return out;
}

// --- 1. coverage -----------------------------------------------------------------
console.log("\n[unit fields] every field a w3u can override is accounted for");
{
  const live = liveCodes();
  const codes = live ?? UNIT_CODES;
  console.log(`  (${Object.keys(codes).length} codes, from ${live ? "the local install" : "the embedded 1.30.4 snapshot"})`);
  if (live) {
    const drift = Object.keys(live).filter((c) => !(c in UNIT_CODES)).concat(Object.keys(UNIT_CODES).filter((c) => !(c in live)));
    check("the embedded snapshot still matches the install's UnitMetaData.slk", drift, []);
  }

  const handled = new Set([...Object.keys(UNIT_SETTERS), ...UNIT_DEFERRED_FIELDS]);
  const noted = new Set(Object.keys(UNIT_FIELD_NOTES));

  const missing = Object.keys(codes).filter((c) => !handled.has(c) && !noted.has(c));
  check("no unit field code is silently dropped", missing.map((c) => `${c} (${codes[c]})`), []);

  const both = Object.keys(codes).filter((c) => handled.has(c) && noted.has(c));
  check("...and none is both applied and excused", both, []);

  const stale = [...handled, ...noted].filter((c) => !(c in codes));
  check("...and nothing in our tables names a code the game does not have", stale, []);

  // The excuses are load-bearing: a blank one would let a field be waved through.
  const blank = Object.entries(UNIT_FIELD_NOTES).filter(([, why]) => !why || why.length < 8).map(([c]) => c);
  check("every excused field states a reason", blank, []);

  const applied = Object.keys(codes).filter((c) => handled.has(c)).length;
  console.log(`  → ${applied} applied, ${Object.keys(codes).length - applied} excused with a reason`);
}

// --- 2. the reported bug ---------------------------------------------------------
//
// `variableType` 3 = string, 0 = int, 1 = real (parsers/w3x/w3u/modification.js). An
// ORIGINAL-table object carries FOUR ZERO BYTES where a custom one carries its rawcode.
function mod(id, value) {
  const m = new Modification();
  m.id = id;
  m.variableType = typeof value === "number" ? (Number.isInteger(value) ? 0 : 1) : 3;
  m.value = value;
  m.levelOrVariation = 0;
  return m;
}
function obj(oldId, newId, mods) {
  const o = new ModifiedObject();
  o.oldId = oldId;
  o.newId = newId;
  o.modifications = mods;
  return o;
}
function w3u(customs, originals) {
  const f = new W3u();
  f.version = 2;
  f.customTable.objects = customs;
  f.originalTable.objects = originals;
  return f.save();
}

/** A UnitDef as loadUnitRegistry hands it over — every field cloneDef touches. */
function baseDef(over = {}) {
  return {
    id: "uaco", name: "Acolyte", typeName: "acolyte", race: "undead",
    model: "units\\undead\\Acolyte\\Acolyte.mdx", modelScale: 1, selScale: 1,
    animWalkSpeed: 200, animRunSpeed: 200, animBlend: 0.15, animProps: [],
    soundSet: "Acolyte", tint: [1, 1, 1], targType: "ground",
    weaponSound: "", lumberSound: "", armorSound: "Flesh",
    icon: "", description: "", tip: "", hotkey: "", buttonX: 0, buttonY: 0,
    isHero: false, properNames: [], priority: 1, buffType: "",
    moveType: "foot", isBuilding: false, pathTex: "", requirePlace: "", uberSplat: "",
    minimapIcon: false, unitShadow: "Shadow", buildingShadow: "",
    shadowW: 140, shadowH: 140, shadowX: 50, shadowY: 50,
    speed: 270, turnRate: 0.5, moveHeight: 0, collision: 16, cargoSize: 1,
    sightDay: 800, sightNight: 600, hitPoints: 220, hpRegen: 0.5, regenType: "blight",
    mana: 200, manaStart: 0, manaRegen: 0, armor: 0, defUp: 1,
    stockMax: 0, stockRegen: 0, stockStart: 0, upgradesUsed: [],
    foodUsed: 5, foodMade: 0, goldCost: 75, lumberCost: 0, buildTime: 15,
    goldRep: 75, lumberRep: 0, repairTime: 15,
    bountyDice: 1, bountySides: 1, bountyPlus: 1,
    lumberBountyDice: 0, lumberBountySides: 0, lumberBountyPlus: 0,
    weapons: [], attackDamage: 0, attackDice: 0, attackSides: 0, attackCooldown: 0,
    attackDamagePoint: 0, attackBackswing: 0, castPoint: 0, castBackswing: 0,
    attackRange: 0, acquireRange: 0, canSleep: false,
    weaponType: "none", attackType: "none", armorType: "medium",
    missileArt: "", missileSpeed: 900, launchX: 0, launchY: 0, launchZ: 0, impactZ: 60,
    strength: 0, agility: 0, intelligence: 0, strPerLevel: 0, agiPerLevel: 0, intPerLevel: 0,
    primaryAttr: "", level: 1, abilities: ["Aall"], heroAbilities: [], autoAbility: "",
    classification: ["undead", "peon"],
    ...over,
  };
}

console.log("\n[unit fields] Azure Tower Defense's Azure Wisp — an edited STANDARD unit");
{
  // The real modification list, read out of (8)AzureTowerDefense.w3x's war3map.w3u. It is an
  // ORIGINAL-table override of the Acolyte, so it replaces `uaco` itself for that map.
  const reg = new UnitRegistry(new Map([["uaco", baseDef()]]));
  applyMapUnitData(reg, w3u([], [obj("uaco", "\0\0\0\0", [
    mod("unam", "Azure Wisp"),
    mod("umdl", "units\\nightelf\\Wisp\\Wisp"),
    mod("uico", "ReplaceableTextures\\CommandButtons\\BTNWisp.blp"),
    mod("ucol", 0),
    mod("ugol", 5),
    mod("ubld", 10),
    mod("uabi", "Avul"),
    mod("umvt", "fly"),
    mod("utar", "air"),
    mod("umvh", 100),
    mod("umvs", 300),
    mod("uaen", 0),
    mod("ufoo", 0),
    mod("usnd", "Wisp"),
  ])]));
  const wisp = reg.get("uaco");
  check("it is renamed", wisp.name, "Azure Wisp");
  check("it wears the Wisp model (this already worked)", wisp.model, "units\\nightelf\\Wisp\\Wisp.mdx");
  check("**and it now speaks with the Wisp's voice** — the reported bug", wisp.soundSet, "Wisp");
  check("...is targeted as air, because the map says so", wisp.targType, "air");
  check("...flies", [wisp.moveType, wisp.moveHeight], ["fly", 100]);
  check("...costs 5 gold and no food", [wisp.goldCost, wisp.foodUsed], [5, 0]);
  check("...and the INSTALL's Acolyte is untouched", [reg.base("uaco").soundSet, reg.base("uaco").name], ["Acolyte", "Acolyte"]);
}

console.log("\n[unit fields] the families that were being dropped wholesale");
{
  const slot = () => ({
    enabled: true, targets: ["ground"], damage: 10, dice: 1, sides: 3, cooldown: 1.4,
    damagePoint: 0.3, backswing: 0.3, range: 90, weaponType: "normal", attackType: "normal",
    weaponSound: "MetalMediumSlice", missileArt: "", missileSpeed: 900,
    spillDist: 0, spillRadius: 0, damageLoss: 0,
    areaFull: 0, areaHalf: 0, areaQuarter: 0, areaHalfFactor: 0.5, areaQuarterFactor: 0.25,
    splashTargets: [], showUI: true,
  });
  const reg = new UnitRegistry(new Map([["hfoo", baseDef({ id: "hfoo", weapons: [slot(), slot()] })]]));
  applyMapUnitData(reg, w3u([obj("hfoo", "x000", [
    // Sound
    mod("usnd", "Rifleman"), mod("uarm", "Metal"),
    // Stats — bounty, the single most-overridden family in a tower-defence map
    mod("ubdi", 4), mod("ubsi", 5), mod("ubba", 12),
    mod("ulbd", 1), mod("ulbs", 2), mod("ulba", 3),
    mod("umpi", 75), mod("umpr", 0.67), mod("upri", 9), mod("ufma", 10),
    mod("utyp", "mechanical,peon"), mod("urac", "orc"), mod("ubdg", 1), mod("usle", 1),
    mod("unbm", 1), mod("udup", 2), mod("upgr", "Rhme,Rhla"),
    // Art
    mod("ussc", 2.5), mod("uwal", 320), mod("urun", 400), mod("uani", "upgrade,second"),
    mod("ubpx", 2), mod("ubpy", 1), mod("ucpt", 0.4),
    mod("ushu", "ShadowFlyer"), mod("ushw", 200), mod("ushh", 210), mod("ushx", 60), mod("ushy", 70),
    mod("ulpx", 11), mod("ulpy", 12), mod("ulpz", 66), mod("uimz", 80),
    mod("uclr", 255), mod("uclg", 128), mod("uclb", 0),
    // Combat — the whole area-splash family, both slots' spill, showUI, backswing
    mod("ua1f", 25), mod("ua1h", 100), mod("ua1q", 200), mod("ua1p", "ground,air"),
    mod("ubs1", 0.9), mod("uwu1", 0), mod("usd2", 200), mod("usr2", 50), mod("udl2", 0.2),
    mod("ua2f", 10), mod("uhd1", 0.4), mod("uqd1", 0.1),
    // Repair basis + transported size — three more columns the engine used to substitute a
    // guess for (the BUILD cost/time, and a headcount).
    mod("ugor", 700), mod("ulur", 375), mod("urtm", 120), mod("ucar", 4),
    // Pathing
    mod("upat", "PathTextures\\4x4SimpleSolid.tga"), mod("upar", "blighted"), mod("uabt", "townhall"),
    // Abilities
    mod("udaa", "Ahea"),
  ])], []));
  const d = reg.get("x000");
  check("Sound - Unit Sound Set", d.soundSet, "Rifleman");
  check("Combat - Armor Sound Type", d.armorSound, "Metal");
  check("Stats - Bounty (gold: base + dice×sides)", [d.bountyPlus, d.bountyDice, d.bountySides], [12, 4, 5]);
  check("Stats - Bounty (lumber)", [d.lumberBountyPlus, d.lumberBountyDice, d.lumberBountySides], [3, 1, 2]);
  check("Stats - Starting Mana / Mana Regeneration", [d.manaStart, d.manaRegen], [75, 0.67]);
  check("Stats - Priority / Food Produced", [d.priority, d.foodMade], [9, 10]);
  check("Stats - Unit Classification (decides corpses, Heal, Wisp consumption)", d.classification, ["mechanical", "peon"]);
  check("Stats - Race / Is a Building / Can Sleep", [d.race, d.isBuilding, d.canSleep], ["orc", true, true]);
  check("Stats - Neutral Building icon / Defense Upgrade Bonus", [d.minimapIcon, d.defUp], [true, 2]);
  check("Techtree - Upgrades Used", d.upgradesUsed, ["Rhme", "Rhla"]);
  check("Stats - Repair Gold/Lumber Cost and Repair Time (their OWN basis, not the build one)", [d.goldRep, d.lumberRep, d.repairTime], [700, 375, 120]);
  check("Stats - Transported Size (a hold is seats, not heads)", d.cargoSize, 4);
  check("Art - Selection Scale", d.selScale, 2.5);
  check("Art - Walk / Run gait", [d.animWalkSpeed, d.animRunSpeed], [320, 400]);
  check("Art - Required Animation Names", d.animProps, ["upgrade", "second"]);
  check("Art - Button Position", [d.buttonX, d.buttonY], [2, 1]);
  check("Art - Cast Point", d.castPoint, 0.4);
  check("Art - Shadow image + quad", [d.unitShadow, d.shadowW, d.shadowH, d.shadowX, d.shadowY], ["ShadowFlyer", 200, 210, 60, 70]);
  check("Art - Projectile Launch / Impact offsets", [d.launchX, d.launchY, d.launchZ, d.impactZ], [11, 12, 66, 80]);
  check("Art - Tinting Color (0–255 → 0–1, one channel per code)", d.tint, [1, 128 / 255, 0]);
  check("Combat - Area of Effect, full/medium/small", [d.weapons[0].areaFull, d.weapons[0].areaHalf, d.weapons[0].areaQuarter], [25, 100, 200]);
  check("...on slot 2 as well", d.weapons[1].areaFull, 10);
  check("Combat - Splash Targets (what the burst may CATCH)", d.weapons[0].splashTargets, ["ground", "air"]);
  check("Combat - Damage Factor, medium/small (NOT fixed at half and a quarter)", [d.weapons[0].areaHalfFactor, d.weapons[0].areaQuarterFactor], [0.4, 0.1]);
  check("Combat - Backswing / Show UI", [d.weapons[0].backswing, d.weapons[0].showUI], [0.9, false]);
  check("Combat - slot 2's line splash (only slot 1 was reachable)", [d.weapons[1].spillDist, d.weapons[1].spillRadius, d.weapons[1].damageLoss], [200, 50, 0.2]);
  check("Pathing - Pathing Map / Placement Requires / AI Placement Type", [d.pathTex, d.requirePlace, d.buffType], ["PathTextures\\4x4SimpleSolid.tga", "blighted", "townhall"]);
  check("Abilities - Default Active Ability", d.autoAbility, "Ahea");
  // The base type keeps everything, including the arrays the clone now deep-copies.
  check("the install's Footman is untouched", [reg.base("hfoo").soundSet, reg.base("hfoo").weapons[0].areaFull, reg.base("hfoo").tint], ["Acolyte", 0, [1, 1, 1]]);
}

console.log("\n[unit fields] a HERO's vitals are the game's PRECOMPUTED ones, so overrides re-fold");
{
  // UnitBalance ships realhp = hp + STR×25, realm = manaN + INT×15, realdef = def − 2 +
  // AGI×0.3, and dmgplus1 + the primary attribute; loadUnitRegistry stores those. The object
  // editor exposes only the BASE column, so applying `uhpm` raw robbed a custom hero of its
  // Strength. Paladin numbers, straight out of the install's UnitBalance.slk:
  //   hp 100, STR 22 → realhp 650 · manaN 0, INT 17 → realm 255 · def 2, AGI 13 → realdef 3.9
  const slot = () => ({
    enabled: true, targets: ["ground"], damage: 22, dice: 2, sides: 6, cooldown: 1.9,
    damagePoint: 0.4, backswing: 0.5, range: 90, weaponType: "normal", attackType: "hero",
    weaponSound: "MetalHeavyBash", missileArt: "", missileSpeed: 900,
    spillDist: 0, spillRadius: 0, damageLoss: 0,
    areaFull: 0, areaHalf: 0, areaQuarter: 0, areaHalfFactor: 0.5, areaQuarterFactor: 0.25,
    splashTargets: [], showUI: true,
  });
  const paladin = () => baseDef({
    id: "Hpal", name: "Paladin", isHero: true, primaryAttr: "STR", // PrimaryAttribute.Strength
    strength: 22, agility: 13, intelligence: 17,
    hitPoints: 650, mana: 255, armor: 4 /* round(3.9) */, weapons: [slot()],
  });
  const run = (mods) => {
    const reg = new UnitRegistry(new Map([["Hpal", paladin()]]));
    applyMapUnitData(reg, w3u([obj("Hpal", "H000", mods)], []));
    return reg.get("H000");
  };

  const plain = run([mod("unam", "Custom Paladin")]);
  check("a clone that retunes nothing keeps the folded stats exactly", [plain.hitPoints, plain.mana, plain.armor, plain.weapons[0].damage], [650, 255, 4, 22]);

  const retuned = run([mod("uhpm", 500), mod("umpm", 100), mod("udef", 5), mod("ua1b", 10)]);
  check("a stated BASE hp folds the hero's Strength back in (500 + 22×25)", retuned.hitPoints, 1050);
  check("...a stated base mana folds Intelligence (100 + 17×15)", retuned.mana, 355);
  check("...a stated base armour folds Agility (5 − 2 + 13×0.3)", retuned.armor, 7);
  check("...and a stated base damage folds the PRIMARY attribute (10 + STR 22)", retuned.weapons[0].damage, 32);

  const stronger = run([mod("ustr", 40)]);
  check("a bare Strength override moves hit points with it (650 + 18×25)", stronger.hitPoints, 1100);
  check("...and the attack damage, because Strength is the primary (22 + 18)", stronger.weapons[0].damage, 40);
  check("...but not mana or armour", [stronger.mana, stronger.armor], [255, 4]);

  const swapped = run([mod("upra", "INT")]);
  check("moving the PRIMARY attribute moves the damage to it (22 − STR 22 + INT 17)", swapped.weapons[0].damage, 17);

  const order = run([mod("ua1b", 10), mod("ustr", 40)]); // stated in the awkward order
  check("the fold is order-independent — attributes settle before the damage does", order.weapons[0].damage, 50);

  const noHero = run([mod("uhpm", 500), mod("unam", "x")]);
  check("(a NON-hero clone folds nothing — it has no attributes)", (() => {
    const reg = new UnitRegistry(new Map([["uaco", baseDef()]]));
    applyMapUnitData(reg, w3u([obj("uaco", "u000", [mod("uhpm", 500)])], []));
    return reg.get("u000").hitPoints;
  })(), 500);
  check("(…and the hero one really did fold)", noHero.hitPoints, 1050);
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
