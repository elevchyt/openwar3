// Headless check of PASSIVE hit-point regeneration (issue #93).
//
// The whole rule lives in two Units\UnitBalance.slk columns — `regenHP` (hp/sec) and
// `regenType` (when it may run) — and the numbers below are the real 1.27a ones read
// straight out of the MPQ:
//
//   hfoo Footman      always 0.25      hbar Barracks    none   -
//   earc Archer       night  0.5       Hpal Paladin     always 0.25 (+ Strength regen)
//   ugho Ghoul        blight 2         hphx Phoenix     always -25  (it burns down)
//
// Blight itself is not a terrain type: it is the union of the Undead structures' Blight
// Growth discs, whose radii come from Units\AbilityData.slk — `Abgs` (Ziggurat, Crypt)
// Area1 768 and `Abgl` (Necropolis, halls, haunted mine) Area1 960.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

// Just enough of the two registries recomputeStats consults: the unit rows' regen columns
// and the two blight-growth abilities' radii.
const DEFS = {
  hfoo: { hpRegen: 0.25, regenType: "always", abilities: [] },
  hbar: { hpRegen: 0, regenType: "none", abilities: [] },
  earc: { hpRegen: 0.5, regenType: "night", abilities: [] },
  ugho: { hpRegen: 2, regenType: "blight", abilities: [] },
  Hpal: { hpRegen: 0.25, regenType: "always", abilities: [] },
  hphx: { hpRegen: -25, regenType: "always", abilities: [] },
  uzig: { hpRegen: 0, regenType: "none", abilities: ["Abgs"] }, // Ziggurat — small blight
  unpl: { hpRegen: 0, regenType: "none", abilities: ["Abgl"] }, // Necropolis — large blight
};
const ABILS = { Abgs: { levelData: [{ area: 768 }] }, Abgl: { levelData: [{ area: 960 }] } };

const world = new SimWorld(
  { width: 4, height: 4, cell: 128, blocked: new Uint8Array(16) },
  1,
  { get: (id) => ABILS[id] }, // abilities
  undefined, // items
  { get: (id) => DEFS[id] }, // units
);

let nextId = 1;
function unit(typeId, over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId, x: 0, y: 0, hp: 100, maxHp: 1000, mana: 0, maxMana: 0,
    manaRegen: 0, hpRegen: 0, buffs: [], inventory: [], weapons: [], abilities: [], level: 1,
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, race: "human", str: 0, agi: 0, int: 0,
    baseStr: 0, baseAgi: 0, baseInt: 0, strPerLevel: 0, agiPerLevel: 0, intPerLevel: 0,
    bonusStr: 0, bonusAgi: 0, bonusInt: 0, baseDamage: 0,
    baseMaxHp: 1000, baseMaxMana: 0, baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270,
    baseSightDay: 1400, baseSightNight: 800, ...over,
  };
  world.units.set(u.id, u);
  return u;
}

let failed = 0;
function check(what, got, want, tol = 0.001) {
  const ok = typeof want === "number" ? Math.abs(got - want) <= tol : got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}\n        want ${want}, got ${got}`);
}

/** Regen the sim derives for a unit at the given hour. */
function regenAt(u, hour) {
  world.timeOfDay = hour;
  world.rebuildBlight();
  world.recomputeStats(u);
  return u.hpRegen;
}

const DAY = 12, NIGHT = 0;

// --- always: Human/Orc units heal round the clock, and this is the bug in issue #93 ---
{
  const foot = unit("hfoo");
  check("Footman regenerates by day", regenAt(foot, DAY), 0.25);
  check("Footman regenerates by night", regenAt(foot, NIGHT), 0.25);
  foot.hp = 100;
  for (let i = 0; i < 60; i++) world.tickRegen(foot, 1);
  check("…60s of it is 15 hp", foot.hp - 100, 15);
  foot.hp = foot.maxHp;
  world.tickRegen(foot, 1);
  check("…and it never overshoots maxHp", foot.hp, foot.maxHp);
}

// --- none: a barracks has to be repaired, it does not heal itself ---
check("Barracks never regenerates", regenAt(unit("hbar"), NIGHT), 0);

// --- night: the night elf rule ---
{
  const archer = unit("earc");
  check("Archer regenerates at night", regenAt(archer, NIGHT), 0.5);
  check("…and not at all in daylight", regenAt(archer, DAY), 0);
}

// --- blight: the Undead rule, disc by disc ---
{
  const ghoul = unit("ugho");
  check("Ghoul on bare ground regenerates nothing", regenAt(ghoul, DAY), 0);

  const zig = unit("uzig", { x: 0, y: 0, building: {} });
  ghoul.x = 700; // inside the Ziggurat's 768
  check("Ghoul inside a Ziggurat's blight regenerates", regenAt(ghoul, DAY), 2);
  ghoul.x = 800; // outside 768, inside a Necropolis' 960
  check("…and steps off it at 800", regenAt(ghoul, DAY), 0);

  zig.typeId = "unpl"; // same spot, the larger disc
  check("…the Necropolis' larger disc reaches 800", regenAt(ghoul, DAY), 2);
  check("IsPointBlighted agrees", world.isBlighted(800, 0), true);
  check("…and stops at 960", world.isBlighted(1000, 0), false);

  zig.hp = 0; // a razed structure spreads nothing
  check("Ghoul loses the blight when the building dies", regenAt(ghoul, DAY), 0);
}

// --- heroes: the type's own regen ADDS to the Strength regen (MiscGame StrRegenBonus 0.05) ---
{
  const pal = unit("Hpal", { isHero: true, str: 22, baseStr: 22, agi: 13, baseAgi: 13, int: 17, baseInt: 17 });
  check("Paladin = 0.25 base + 22 Strength * 0.05", regenAt(pal, DAY), 0.25 + 22 * 0.05);
}

// --- the one negative regen in the game ---
{
  const phoenix = unit("hphx", { hp: 100, maxHp: 1250, baseMaxHp: 1250, garrison: [], inCombat: false });
  check("Phoenix regen is negative", regenAt(phoenix, DAY), -25);
  for (let i = 0; i < 3; i++) world.tickRegen(phoenix, 1);
  check("…so it burns down", phoenix.hp, 25);
  world.tickRegen(phoenix, 1);
  check("…and dies", phoenix.hp, 0);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
