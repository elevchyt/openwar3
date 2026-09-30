// THE TORNADO (`ntor`, the Naga Sea Witch's `ANto`) — a unit whose three passives are all it
// does (SimWorld.tickTornado, AURA_BUFFS `Aasl`).
//
// Numbers are the live rows (1.30.4 under src/patches/data/1.32.6.json):
//   Atdg  targs structure,enemy   Area1 650   DataA 14 dps · DataB 125 / DataC 100 dps · DataD 0 / DataE 0
//   Atsp  targs ground,enemy      Area1 275   Dur1 12 · HeroDur1 6 · DataA 22 (per-unit cooldown) · DataB 3 (interval)
//   Aasl  targs air,ground,enemy,vuln,invu    Area1 600  DataA -0.6 (move) · DataB 0 (attack)
// Liquipedia's Tornado notes say the same in words: 100/s to buildings under it and 14/s near
// it, a toss every 3 seconds lasting 12, the same unit once every 22 seconds.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const DEFS = {
  Atdg: { code: "Atdg", targetFlags: ["structure", "enemy"], levelData: [{ area: 650, duration: 0, heroDuration: 0, data: [14, 125, 100, 0, 0], buffs: ["Btdg"] }] },
  Atsp: { code: "Atsp", targetFlags: ["ground", "enemy"], levelData: [{ area: 275, duration: 12, heroDuration: 6, data: [22, 3], buffs: ["Btsp", "Btsa"] }] },
  Aasl: { code: "Aasl", targetFlags: ["air", "ground", "enemy", "vuln", "invu"], levelData: [{ area: 600, duration: 0, heroDuration: 0, data: [-0.6, 0], buffs: ["Basl"] }] },
};
const CARRIER = { path: "Abilities\\Spells\\Other\\Tornado\\TornadoElementalSmall.mdx", attach: [], carry: ["sprite", "first"] };

const W = 96, H = 96;
const grid = () => new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
function world() {
  const w = new SimWorld(grid(), 7);
  w.abilities = {
    get: (id) => DEFS[id],
    all: () => Object.values(DEFS),
    buffFx: () => [],
    buffCarrier: (id) => (id === "Btsp" ? CARRIER : null),
    buff: () => undefined,
  };
  return w;
}
function addUnit(w, id, team, x, y, over = {}) {
  return w.add({
    id, owner: team, team, typeId: "t" + id, x, y, facing: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
    sightDay: 1400, sightNight: 800,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 0, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: false, targetedAs: "ground", deathTime: 2, name: "T" + id,
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    weapons: [], oldWeapons: [], ...over,
  });
}
const tornadoOf = (w, x, y) => {
  const t = addUnit(w, 1, 0, x, y);
  t.abilities = [
    { id: "Atdg", code: "Atdg", level: 1 },
    { id: "Atsp", code: "Atsp", level: 1 },
    { id: "Aasl", code: "Aasl", level: 1 },
  ];
  return t;
};
const tick = (w, u, secs) => {
  for (let s = 0; s < Math.round(secs * 60); s++) w.tickTornado(u, 1 / 60);
};
const spun = (u) => u.buffs.filter((b) => b.group === "tornadoSpin");

console.log("\nBuilding Damage Aura: 100/s within the medium radius, 14/s out to 650, nothing past it");
{
  const w = world();
  const tor = tornadoOf(w, 1000, 1000);
  const under = addUnit(w, 2, 1, 1060, 1000, { radius: 64 });
  const near = addUnit(w, 3, 1, 1400, 1000, { radius: 64 });
  const far = addUnit(w, 4, 1, 1800, 1000, { radius: 64 });
  const ours = addUnit(w, 5, 0, 1060, 1060, { radius: 64 });
  for (const b of [under, near, far, ours]) b.building = { constructionLeft: 0, buildTimeTotal: 1, queue: [] };
  tick(w, tor, 1.001);
  check("a building under it loses DataC (100) a second", under.hp === 900, `hp ${under.hp}`);
  check("one in its vicinity loses DataA (14)", near.hp === 986, `hp ${near.hp}`);
  check("one past Area1 (650) loses nothing", far.hp === 1000, `hp ${far.hp}`);
  check("its OWNER's building loses nothing", ours.hp === 1000, `hp ${ours.hp}`);
}

console.log("\nTornado Spin: one enemy ground unit every 3 s, never the same one within 22 s");
{
  const w = world();
  const tor = tornadoOf(w, 1000, 1000);
  const a = addUnit(w, 2, 1, 1100, 1000);
  const b = addUnit(w, 3, 1, 1000, 1120);
  const hero = addUnit(w, 4, 1, 900, 1000, { isHero: true });
  const flyer = addUnit(w, 5, 1, 1050, 1050, { flying: true, targetedAs: "air" });
  const ally = addUnit(w, 6, 0, 1080, 980);
  const outside = addUnit(w, 7, 1, 1500, 1000);
  const ground = [a, b, hero];
  tick(w, tor, 2.9);
  check("nobody is tossed before the interval has run", ground.every((u) => !spun(u).length));
  tick(w, tor, 0.2);
  const first = ground.filter((u) => spun(u).length);
  check("at 3 s exactly one is tossed", first.length === 1, `${first.length}`);
  const v = first[0];
  check("…as a Cyclone: stunned and untouchable", spun(v).map((x) => x.kind).sort().join() === "invuln,stun", JSON.stringify(spun(v).map((x) => x.kind)));
  check("…for Dur1 (12), or HeroDur1 (6) on a hero", Math.abs(spun(v)[0].timeLeft - (v.isHero ? 6 : 12)) < 0.2, `${spun(v)[0].timeLeft}`);
  check("…wearing the buff row's carrier", spun(v).some((x) => x.fx?.[0]?.path === CARRIER.path && x.fx[0].carry));
  check("…and the Btsp row, for its Status icon", spun(v).every((x) => x.buffId === "Btsp"));
  check("…and may not be caught again for DataA (22) seconds", Math.abs(v.spinCooldown - 22) < 0.2, `${v.spinCooldown}`);
  tick(w, tor, 3);
  const second = ground.filter((u) => u !== v && spun(u).length);
  check("three seconds later a DIFFERENT unit is tossed", second.length === 1, `${second.length}`);
  tick(w, tor, 3.05);
  check("…and the third is the last one left", ground.every((u) => spun(u).length));
  check("a flyer is never caught (targs ground)", !spun(flyer).length);
  check("nor one of the Tornado's own side", !spun(ally).length);
  check("nor anybody outside Area1 (275)", !spun(outside).length);
}

console.log("\nan empty tornado catches the first unit to walk in AT ONCE, not on the next beat");
{
  const w = world();
  const tor = tornadoOf(w, 1000, 1000);
  tick(w, tor, 7);
  const late = addUnit(w, 2, 1, 1100, 1000);
  tick(w, tor, 1 / 60);
  check("caught the tick it arrived", spun(late).length === 2);
}

console.log("\nSlow Aura: the row writes the reduction negative, it lands as a 60% slow on enemies");
{
  const w = world();
  const tor = tornadoOf(w, 1000, 1000);
  const foe = addUnit(w, 2, 1, 1400, 1000);
  const bat = addUnit(w, 3, 1, 1300, 1000, { flying: true, targetedAs: "air" });
  const ally = addUnit(w, 4, 0, 1100, 1000);
  w.applyAuras();
  const slow = (u) => u.buffs.find((b) => b.kind === "slow");
  check("an enemy inside 600 is slowed by 0.6", slow(foe)?.value === 0.6, JSON.stringify(slow(foe)));
  check("…a flyer too (targs air)", slow(bat)?.value === 0.6);
  check("…never the Tornado's own side", !slow(ally));
  void tor;
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
