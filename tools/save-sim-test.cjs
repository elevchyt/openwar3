// SAVED GAMES (issue #159, docs/save-games.md) — the WORLD, round trip.
//
// Two squads fight under a seeded stream of orders (the replay test's fixture). At several moments
// the world is saved — through the codec and real JSON, the way the `.o3s` file carries it — and
// loaded into a FRESH world, built as a load builds one (constructed, its wiring in place, nothing
// in it). Both are then run on under the same orders, and must be the SAME world: the replay state
// hash, and the codec's own encoding of the whole SimWorld (every field of every unit, every
// buff, the banks, the random stream), agree at every step after the load.
//
// The comparison must be able to bite, so one save is also loaded with a single unit's hit points
// nudged, and has to part.
//
// Run: pnpm sim:test

const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const B = (...p) => require(join(REPO, ".sim-build", "src", ...p));
const { SimWorld } = B("sim", "world.js");
const { PathingGrid } = B("sim", "pathing.js");
const { Authority } = B("game", "authority.js");
const { stateHash } = B("game", "replayHash.js");
const { encodeGraph, decodeGraph, newEncodeStats } = B("game", "save", "graph.js");
const { registerSaveClasses } = B("game", "save", "classes.js");

registerSaveClasses();

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};

const SIM_DT = 1 / 60;
const STEPS = 3600;
const SAVES = [300, 900, 1500, 2400];

const WEAPON = () => ({
  enabled: true, targets: ["ground", "air", "structure"], ranged: false,
  damage: 12, baseDamage: 12, dice: 1, baseDice: 1, sides: 6,
  cooldown: 1.2, baseCooldown: 1.2, range: 90, baseRange: 90, rangeBuffer: 250,
  damagePoint: 0.4, baseDamagePoint: 0.4, backswing: 0.3, baseBackswing: 0.3,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 500, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

function grid() {
  const W = 64, H = 64;
  return new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
}

function addUnit(w, id, owner, x, y) {
  const weapons = [WEAPON()];
  w.add({
    id, owner, team: owner, typeId: "hfoo", x, y, facing: 0,
    hp: 420, maxHp: 420, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0.25,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 2, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    castPoint: 0, castBackswing: 0,
    weapons, oldWeapons: weapons,
  });
}

/** A world as a match builds it. `empty` is the one a load writes into: the same construction,
 *  nothing in it. */
function world(seed, empty = false) {
  const w = new SimWorld(grid(), seed);
  if (!empty) {
    for (let i = 0; i < 6; i++) {
      addUnit(w, 1 + i, 0, -600, -250 + i * 100);
      addUnit(w, 11 + i, 1, 600, -250 + i * 100);
    }
    w.initStash(0, 500, 150);
    w.initStash(1, 500, 150);
  }
  const stub = { get: () => undefined };
  return { w, auth: new Authority(w, stub, stub, stub, stub) };
}

function stream(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The orders of step `s`: a pure function of the step, so two worlds can be handed the same. */
function ordersAt(s, w) {
  const rnd = stream(s * 7919);
  const out = [];
  if (rnd() > 0.08) return out;
  const ids = [...w.units.keys()].sort((a, b) => a - b);
  for (let i = 0; i < 2 && ids.length; i++) {
    const unitId = ids[Math.floor(rnd() * ids.length)];
    const owner = w.units.get(unitId).owner;
    const foes = ids.filter((id) => w.units.get(id).owner !== owner);
    const x = Math.round((rnd() - 0.5) * 1400), y = Math.round((rnd() - 0.5) * 1000);
    const roll = rnd();
    const order = roll < 0.5 && foes.length ? { kind: "attack", targetId: foes[Math.floor(rnd() * foes.length)] }
      : roll < 0.7 ? { kind: "attackmove", x, y } : roll < 0.9 ? { kind: "move", x, y } : { kind: "hold" };
    out.push([owner, { c: "order", unitId, order, queued: false }]);
  }
  return out;
}

function step(m, s) {
  for (const [p, cmd] of ordersAt(s, m.w)) m.auth.execute(p, cmd);
  m.w.tick(SIM_DT);
}

/** The whole world as the codec writes it — the strictest comparison there is. */
const full = (m) => JSON.stringify(encodeGraph({ sim: m.w, auth: m.auth }));

function save(m) {
  m.w.settleForSave(); // what MapViewerScene.captureSave does first
  const stats = newEncodeStats();
  const doc = encodeGraph({ sim: m.w, auth: m.auth }, {}, stats);
  return { json: JSON.stringify(doc), stats };
}

function load(json, seed) {
  const m = world(seed, true);
  const report = { lost: [], missingExternals: [] };
  decodeGraph(JSON.parse(json), { sim: m.w, auth: m.auth }, {}, report);
  return { m, report };
}

// ---- the original, saved along the way --------------------------------------------------------
// Each save is taken off an original run to that step, which then carries on as the saved match
// does (`originals`): a save may settle a path search early (SimWorld.settleForSave), so the
// match that was saved is the reference, not one that was never saved at all.
const a = world(7);
const saves = new Map();
const originals = new Map();
for (let s = 1; s <= STEPS; s++) {
  step(a, s);
  if (SAVES.includes(s)) {
    const o = world(7);
    for (let i = 1; i <= s; i++) step(o, i);
    saves.set(s, save(o));
    originals.set(s, o);
  }
}
const dead = 12 - a.w.units.size;
const hurt = [...a.w.units.values()].filter((u) => u.hp < 420).length;
check(`the match was a fight (${dead} dead, ${hurt} hurt)`, dead + hurt >= 3);
const first = saves.get(SAVES[0]);
check("the codec met no class it does not know", first.stats.unregistered.size === 0, [...first.stats.unregistered].join(", "));

for (const s of SAVES) {
  const sv = saves.get(s);
  const { m: b, report } = load(sv.json, 7);
  check(`step ${s}: the load lost nothing`, report.lost.length === 0 && report.missingExternals.length === 0, [...report.lost, ...report.missingExternals].slice(0, 5).join("; "));
  // The match that was saved, carrying on.
  const c = originals.get(s);
  check(`step ${s}: the loaded world equals the original at the moment of the load`, full(b) === full(c));
  let parted = -1;
  for (let i = s + 1; i <= STEPS && parted < 0; i++) {
    step(b, i);
    step(c, i);
    if (stateHash(b.w) !== stateHash(c.w) || (i % 120 === 0 && full(b) !== full(c))) parted = i;
  }
  check(`step ${s}: loaded and original stay the same world to step ${STEPS}`, parted < 0, `parted at step ${parted}`);
  check(`step ${s}: …ending with the same survivors`, [...b.w.units.keys()].join() === [...c.w.units.keys()].join());
}

// ---- the comparison bites ----------------------------------------------------------------------
{
  const doc = JSON.parse(saves.get(900).json);
  const unit = doc.nodes.find((n) => n && n.t === "o" && n.p && n.p.typeId === "hfoo" && typeof n.p.hp === "number" && n.p.hp > 10);
  unit.p.hp -= 7;
  const { m: b } = load(JSON.stringify(doc), 7);
  const c = world(7);
  for (let i = 1; i <= 900; i++) step(c, i);
  c.w.settleForSave();
  let parted = false;
  for (let i = 901; i <= STEPS && !parted; i++) {
    step(b, i);
    step(c, i);
    parted = stateHash(b.w) !== stateHash(c.w);
  }
  check("a save with one unit's hit points nudged is caught", parted);
}

console.log(failures ? `\nsave sim round trip: ${failures} check(s) FAILED` : "\nsave sim round trip: all checks passed");
process.exit(failures ? 1 : 0);
