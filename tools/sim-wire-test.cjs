// Headless round-trip check of the binary hot lane (docs/multiplayer.md Phase G —
// src/game/snapshotWire.ts): decode(encode(snap)) must hand back the payload every
// consumer already reads, for a snapshot with EVERY field populated — remembered stubs,
// illusion masks, building queues, shop stock with Infinity-encoded timers, buffs with an
// aura's real Infinity, inventory with holes, projectiles, corpses, fx, deaths.
//
// Two disciplines keep the equality honest:
//   • The exact-equality payload is built ON THE CODEC'S GRID (integer positions, u16
//     facings, f32-representable floats), so a deep-equal failure is a LAYOUT bug — a
//     field written and read in different orders — not quantization noise.
//   • Quantization itself is then checked separately, off-grid, against its documented
//     tolerances (±0.5 world units, one 65536th of a turn).
//
// The file also MEASURES the win — encoded bytes vs JSON.stringify for the same world,
// and host-side encode time — because the whole point of the lane is a number.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { encodeSnapshot, decodeSnapshot } = require(join(REPO, ".sim-build", "src", "game", "snapshotWire.js"));
const { rememberedUnit } = require(join(REPO, ".sim-build", "src", "game", "snapshot.js"));

let failed = 0;
function check(what, got, want) {
  const ok = deepEqual(got, want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${show(want)}\n        got  ${show(got)}`);
}
const show = (v) => JSON.stringify(v, (_k, x) => (x === Infinity ? "∞" : x));

// JSON.stringify-comparison would wave Infinity through as null on BOTH sides — the exact
// corruption the binary lane exists to stop shipping — so equality is checked for real.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}
/** Name the first differing path — a 90-field unit diff is unreadable without it. */
function firstDiff(a, b, path = "") {
  if (a === b) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return `${path}: ${show(b)} → ${show(a)}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

// --- the rich payload, on the codec's grid --------------------------------------------

const weapon = (over = {}) => ({
  damage: 25, dice: 2, sides: 6, range: 128, cooldown: 1.5, damagePoint: 0.5,
  backswing: 0.75, baseDamagePoint: 0.5, baseBackswing: 0.75, ...over,
});

const base = () => ({
  id: 0, owner: 0, team: 0, typeId: "hfoo", race: "human", neutralPassive: false,
  isHero: false, properName: "", isCreep: false, remembered: false,
  x: 0, y: 0, facing: 0, flyHeight: 0, speed: 270, radius: 16, flying: false,
  order: "idle", moving: false, inCombat: false, working: false,
  swingSeq: 0, chopSeq: 0, swingBroken: false, swingSlam: false, altModel: false,
  spawning: 0, constructing: 0, repair: null,
  inMine: false, insideBuild: false, inBurrow: false, devouredBy: 0, vanished: false,
  invisible: false, ethereal: false,
  hp: 420, maxHp: 420, mana: 0, maxMana: 0, armor: 2.5, bonusArmor: 0, bonusDamage: 0,
  invulnerable: false, weapon: null, swingWeapon: null,
  level: 0, xp: 0, skillPoints: 0, str: 0, agi: 0, int: 0, bonusStr: 0, bonusAgi: 0, bonusInt: 0,
  worker: null, building: null, abilities: [], buffs: [], inventory: [], garrison: [], garrisonCap: 0,
  isSummon: false, summonLeft: 0, summonMax: 0, isIllusion: false, illusionOf: 0,
  guardX: 0, guardY: 0, buildPending: null, orderQueue: null, pendingCastCode: null,
});

// A hero wearing everything at once: both weapon slots, hero stats, abilities with a
// ticking cooldown, an AURA buff whose timeLeft is the Infinity JSON never carried, a
// Shadow-Meld-style buff with its `meld` latch and multi-attach fx, an inventory with a
// hole in it, private intent (buildPending/orderQueue/pendingCast — this is the
// recipient's own unit), and the summon/illusion tell unmasked.
const hero = () => ({
  ...base(),
  id: 1042, owner: 1, team: 1, typeId: "Ogld", race: "orc", isHero: true,
  properName: "Grom Hellscream", x: -1204, y: 887, facing: Math.PI / 2, flyHeight: 90.5,
  speed: 320, radius: 24, flying: true, order: "attack", moving: true, inCombat: true,
  swingSeq: 17, chopSeq: 3, swingBroken: true, swingSlam: true, altModel: true,
  spawning: 0.75, constructing: 0, repair: { active: true },
  devouredBy: 88, vanished: true, invisible: true, ethereal: true,
  hp: 875, maxHp: 1050, mana: 240, maxMana: 405, armor: 6.25, bonusArmor: 1.25,
  bonusDamage: -7, invulnerable: true,
  weapon: weapon(), swingWeapon: weapon({ damage: 12, range: 600, cooldown: 2.25 }),
  level: 6, xp: 74000, skillPoints: 2, str: 34, agi: 21, int: 18,
  bonusStr: -2, bonusAgi: 4, bonusInt: 0,
  abilities: [
    { id: "AOwk", code: "AOwk", level: 3, cooldownLeft: 7.25, autocastOn: false },
    { id: "AOcr", code: "AOcr", level: 1, cooldownLeft: 0, autocastOn: true },
  ],
  buffs: [
    { kind: "damagePct", group: "aura:command", timeLeft: Infinity, sourceId: 1042, value: 0.25, value2: 0,
      art: "Abilities\\Spells\\Orc\\CommandAura\\CommandAura.mdx", fx: [{ path: "cmd.mdx", attach: ["overhead"] }], delay: 0 },
    { kind: "invuln", group: "", timeLeft: 9.5, sourceId: 77, value: 0, value2: 0.5,
      art: "", fx: [{ path: "meld.mdx", attach: ["chest", "mount", "left"] }, { path: "second.mdx", attach: [] }], delay: 0.5, meld: true },
  ],
  inventory: [
    { id: 5001, itemId: "pinv", charges: 1, cooldownLeft: 0 },
    null,
    { id: 5002, itemId: "stwp", charges: 3, cooldownLeft: 42.5 },
  ],
  garrison: [1201, 1202], garrisonCap: 4,
  isSummon: true, summonLeft: 40.5, summonMax: 60, isIllusion: true, illusionOf: 1040,
  guardX: -300, guardY: 250,
  buildPending: { defId: "obar", x: -1216, y: 896 },
  orderQueue: [{ kind: "move", x: 10, y: 20 }, { kind: "attack", targetId: 9, force: true }],
  pendingCastCode: "AOsh",
});

// A production building mid-upgrade: queue with all three BuildJob kinds (a free hero with
// a buyer, so the union's optional members cross too), a shelf whose never-restocking ware
// carries the -1 Infinity encoding `snapshotFor` stamped, and a unit-target rally.
const shop = () => ({
  ...base(),
  id: 2, owner: 2, team: 2, typeId: "ovln", race: "orc", neutralPassive: true,
  x: 3100, y: -2900, hp: 1500, maxHp: 1500, armor: 5,
  working: true, constructing: 22.5,
  building: {
    constructionLeft: 12.5, buildTimeTotal: 70,
    queue: [
      { kind: "unit", unitId: "opeo", timeLeft: 11.25, buildTime: 15 },
      { kind: "unit", unitId: "Ofar", timeLeft: 55, buildTime: 55, free: true, buyer: 3 },
      { kind: "research", unitId: "Rome", level: 2, timeLeft: 13.7, buildTime: 60 },
      { kind: "upgrade", unitId: "ostr", timeLeft: 100, buildTime: 140 },
    ],
    producesUnits: true, rallyX: -512.25, rallyY: 300.5, rallyKind: "unit", rallyTargetId: 1042,
    stock: [
      { id: "pinv", count: 2, max: 3, timer: 30.5, period: 120, kind: "item" },
      { id: "nkod", count: 1, max: 1, timer: -1, period: -1, kind: "unit" },
    ],
  },
});

// A harvesting worker — the composite the hero does not wear.
const peon = () => ({
  ...base(),
  id: 3, owner: 1, team: 1, typeId: "opeo", race: "orc", x: 512, y: -64, order: "harvest",
  working: true, worker: { gold: true, lumber: false, carryGold: 10, carryLumber: 0 },
});

const projectiles = () => [
  { id: 9001, x: -1200, y: 880, z: 60.5, targetId: 1042, tx: -1100, ty: 900, speed: 900,
    art: "Abilities\\Weapons\\Arrow\\ArrowMissile.mdx", startZ: 45.5, impactZ: 60, startDist: 512 },
  { id: 9002, x: 0, y: 0, z: 0, targetId: 0, tx: 128, ty: -128, speed: 1300,
    art: "chainlightning.mdx", startZ: 0, impactZ: 0, startDist: 0 },
];

/** The whole payload: three live shapes + a remembered image, both hot arrays, every cold
 *  lane populated. Ghost via the real `rememberedUnit`, so its stub building crosses too. */
function richSnapshot() {
  return {
    recipient: 1, time: 321.5, timeOfDay: 14.25, dawnDusk: true,
    stash: { gold: 812, lumber: 344 },
    research: { Rome: 2, Rowd: 1 },
    creepCamps: [{ x: 900, y: -700, level: 12 }],
    units: [hero(), shop(), peon(), rememberedUnit({ ...base(), id: 4, owner: 3, team: 3, typeId: "hcas", x: 4000, y: 4000, facing: 0, altModel: true, building: {} })],
    mines: [{ id: 501, x: 2000, y: 2000, radius: 96, gold: 11250 }, { id: 502, x: -2000, y: -2000, radius: 96, gold: -1 }],
    items: [{ id: 7001, itemId: "gold", x: 44, y: -12 }],
    projectiles: projectiles(),
    fx: {
      effects: [{ art: "HolyBolt.mdx", x: 10, y: 20, targetId: 7, z: 0, life: 1.2, sound: true }],
      splats: [{ splatId: "THND", x: 50, y: 60 }],
      castStarts: [{ casterId: 1, code: "AOws", abilityId: "AOws", hold: 0.5, loop: false, tx: 1, ty: 2, targetId: 0, warnArt: "", x: 3, y: 4 }],
      castFires: [{ casterId: 1, code: "AOws", abilityId: "AOws", x: 3, y: 4 }],
    },
    deaths: [{ id: 999, x: 100, y: 200 }],
    corpses: [{ id: 601, deadId: 999, unitId: "ogru", x: 100, y: 200, facing: 1.25, owner: 2, isHero: false, mechanical: false, decayLeft: 61.7, raised: false }],
    commands: 17,
  };
}

console.log("decode(encode(snap)) is the same payload, field for field");
{
  const snap = richSnapshot();
  const wire = encodeSnapshot(snap);
  check("the hot lane left as one base64 string", [typeof wire.hot, "units" in wire, "projectiles" in wire], ["string", false, false]);
  const back = decodeSnapshot(wire);
  const diff = firstDiff(back, snap);
  check(`round-trip is exact on the codec's grid${diff ? ` (first diff ${diff})` : ""}`, diff, null);
  check("an aura's timeLeft survives as real Infinity, which JSON never carried", back.units[0].buffs[0].timeLeft, Infinity);
  check("the never-restocking ware still crosses -1-encoded (snapshotFor's stamp)", back.units[1].building.stock[1].timer, -1);
  check("the inventory keeps its hole where it was", back.units[0].inventory.map((i) => i && i.itemId), ["pinv", null, "stwp"]);
  check("meld is a latch, not a default — absent stays absent", ["meld" in back.units[0].buffs[0], back.units[0].buffs[1].meld], [false, true]);
  check("the remembered stub is still a building-shaped memory", [back.units[3].remembered, back.units[3].hp, back.units[3].building.queue], [true, 0, []]);
  check("encoding did not mutate the source payload", firstDiff(snap, richSnapshot()), null);
}

console.log("\nan empty world crosses too — match start before the first unit is even sent");
{
  const snap = { ...richSnapshot(), units: [], projectiles: [], deaths: [], corpses: [], items: [], mines: [], creepCamps: [] };
  check("round-trips whole", firstDiff(decodeSnapshot(encodeSnapshot(snap)), snap), null);
}

console.log("\nquantization stays inside its documented tolerances, off the grid");
{
  const u = { ...hero(), x: 123.449, y: -8191.51, facing: 1.2345, hp: 874.6, armor: 6.17, spawning: 0.123 };
  const snap = { ...richSnapshot(), units: [u] };
  const back = decodeSnapshot(encodeSnapshot(snap)).units[0];
  check("positions round to the nearest world unit", [back.x, back.y], [123, -8192]);
  check("facing lands within one 65536th of a turn", Math.abs(back.facing - 1.2345) < (2 * Math.PI) / 65536, true);
  check("hp rounds to the integer the HUD shows", back.hp, 875);
  check("f32 fields hold ~7 significant digits", [Math.abs(back.armor - 6.17) < 1e-6, Math.abs(back.spawning - 0.123) < 1e-7], [true, true]);
  // The swing counters wrap at u16 — the client retriggers on CHANGE, so a wrapped counter
  // still reads as one (65539 ≠ 65538 both before and after the wrap).
  const w = decodeSnapshot(encodeSnapshot({ ...richSnapshot(), units: [{ ...hero(), swingSeq: 65539 }] })).units[0];
  check("a wrapped swing counter still changed", w.swingSeq, 3);
}

// --- the measurement --------------------------------------------------------------------
// A late-game teamfight's shape: 190 ordinary soldiers (one weapon, one ability, one aura
// buff — what an upkeep-capped army actually fields), 10 full heroes, 24 buildings with
// queues and a shelf, 16 remembered images, 60 missiles in the air.

const grunt = (i) => ({
  ...base(),
  id: 10000 + i, owner: 1 + (i % 4), team: 1 + (i % 2), typeId: "ogru", race: "orc",
  x: (i % 64) * 128 - 4000, y: Math.floor(i / 64) * 128 - 3000, facing: Math.PI / 2,
  order: "attack", moving: true, inCombat: true, swingSeq: i % 11, hp: 520, maxHp: 700,
  weapon: weapon({ damage: 19 }),
  abilities: [{ id: "Sbsk", code: "Sbsk", level: 1, cooldownLeft: 0, autocastOn: false }],
  buffs: [{ kind: "damagePct", group: "aura:command", timeLeft: Infinity, sourceId: 1042, value: 0.25, value2: 0,
    art: "Abilities\\Spells\\Orc\\CommandAura\\CommandAura.mdx", fx: [{ path: "cmd.mdx", attach: ["overhead"] }], delay: 0 }],
});

console.log("\nthe win, measured on a teamfight-sized world");
{
  const units = [];
  for (let i = 0; i < 190; i++) units.push(grunt(i));
  for (let i = 0; i < 10; i++) units.push({ ...hero(), id: 15000 + i, orderQueue: null, buildPending: null, pendingCastCode: null });
  for (let i = 0; i < 24; i++) units.push({ ...shop(), id: 20000 + i });
  for (let i = 0; i < 16; i++) units.push(rememberedUnit({ ...base(), id: 30000 + i, typeId: "hcas", building: {} }));
  const projs = [];
  for (let i = 0; i < 60; i++) projs.push({ ...projectiles()[0], id: 40000 + i });
  const snap = { ...richSnapshot(), units, projectiles: projs };

  const jsonBytes = JSON.stringify({ k: "snap", snap }).length;
  const wire = encodeSnapshot(snap);
  const wireBytes = JSON.stringify({ k: "snapw", snap: wire }).length;
  const rawBytes = Math.floor((wire.hot.length * 3) / 4);

  const N = 200;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) JSON.stringify({ k: "snap", snap });
  const jsonMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) encodeSnapshot(snap);
  const encMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) decodeSnapshot(wire);
  const decMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;

  console.log(`        ${units.length} units + ${projs.length} projectiles`);
  console.log(`        JSON envelope   ${jsonBytes.toLocaleString()} B   (stringify ${jsonMs.toFixed(3)} ms)`);
  console.log(`        wire envelope   ${wireBytes.toLocaleString()} B   (encode ${encMs.toFixed(3)} ms, decode ${decMs.toFixed(3)} ms)`);
  console.log(`        binary payload  ${rawBytes.toLocaleString()} B   (${(rawBytes / units.length).toFixed(0)} B/unit incl. projectiles+strings)`);
  console.log(`        ratio           ${(jsonBytes / wireBytes).toFixed(1)}x smaller on the wire`);
  check("the wire envelope is at least 8x smaller than JSON (the lane's reason to exist)", wireBytes * 8 < jsonBytes, true);
  check("and it still round-trips exactly", firstDiff(decodeSnapshot(wire), snap), null);
}

console.log(failed === 0 ? "\nsim-wire: all checks passed" : `\nsim-wire: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
