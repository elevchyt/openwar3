// Headless check that TRANQUILITY (`AEtq`) keeps the same channel and potion rules as Starfall
// (tools/sim-starfall-test.cjs), through the real cast pipeline and the real item door.
// Numbers are the install's 1.30.4 `[AEtq]` row (Units\\AbilityData.slk): Dur1 15, Area1 900,
// DataA "Life Healed" 40, DataB "Heal Interval" 1, DataC "Building Reduction" 1, DataD "Initial
// Immunity Duration" 3, targs1 air,ground,friend,self,vuln,invu,neutral; the Ubertip: "healing
// friendly allied units for 40 hit points per second".
//
//   - it heals whoever is in the circle, wave by wave: walk in and be healed, walk out and stop;
//   - moving, a stun or a pressed potion ends the channel, and the HEALING ends with it;
//   - casting it ends a Potion of Invulnerability, and leaves an Anti-magic Potion alone.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const D = (...v) => { const a = new Array(9).fill(NaN); v.forEach((x, i) => { a[i] = x; }); return a; };
const ability = (id, code, over) => ({
  id, code, target: "none", targetFlags: [], lightning: [], buffFx: [], buffArt: "", targetArt: "", casterArt: "",
  specialArt: "", effectArt: "", areaArt: "", fxArt: "", missileArt: "", animNames: [], isItem: false,
  levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: D(), buffs: [], summon: "" }],
  ...over,
});
const ABILITIES = {
  AEtq: ability("AEtq", "AEtq", {
    targetFlags: ["air", "ground", "friend", "self", "vuln", "invu", "neutral"],
    levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 900, duration: 15, heroDuration: 15, castTime: 0, data: D(40, 1, 1, 3), buffs: ["AEtr"], summon: "" }],
  }),
  AIh1: ability("AIh1", "AIhe", { isItem: true, levelData: [{ cost: 0, cooldown: 20, castRange: 0, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: D(250), buffs: [], summon: "" }] }),
  AIvu: ability("AIvu", "AIvu", { isItem: true, targetFlags: ["vuln", "invu"], levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 0, duration: 15, heroDuration: 15, castTime: 0, data: D(), buffs: ["Bvul"], summon: "" }] }),
  AIxs: ability("AIxs", "Aami", { isItem: true, targetFlags: ["air", "ground"], levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 0, duration: 15, heroDuration: 15, castTime: 0, data: D(0), buffs: ["Bams", "Bam2"], summon: "" }] }),
};
const item = (id, name, abil) => ({ id, name, abilities: [abil], charges: 1, usable: true, perishable: true, powerup: false, cooldownGroup: id, classType: "Purchasable" });
const ITEMS = { phea: item("phea", "Potion of Healing", "AIh1"), pnvu: item("pnvu", "Potion of Invulnerability", "AIvu"), pams: item("pams", "Anti-magic Potion", "AIxs") };

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

function world() {
  const W = 128, H = 128;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  w.abilities = { get: (id) => ABILITIES[id], has: (id) => id in ABILITIES, all: () => Object.values(ABILITIES), buffFx: () => [] };
  w.itemReg = { get: (id) => ITEMS[id], has: (id) => id in ITEMS };
  return w;
}

let nextId = 1;
function add(w, over, building = null) {
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 100, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: null, weapons: [], oldWeapons: [],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "nightelf",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Unit",
    worker: null, depotGold: false, depotLumber: false,
    ...over,
  }, building);
  u.x = over.x ?? 0;
  u.y = over.y ?? 0;
  return u;
}
const step = (w, seconds, dt = 0.05) => { for (let i = 0; i < Math.round(seconds / dt); i++) w.tick(dt); };

/** The Keeper at the origin with Tranquility and a belt of three potions, a hurt ally 400 away,
 *  a hurt ally outside the 900 circle, a hurt Siege Engine and a hurt ENEMY beside her — and
 *  the cast pressed and landed. `before` runs just ahead of the press. */
function scene(before) {
  const w = world();
  const keeper = add(w, { name: "Keeper", hp: 300, maxHp: 800 });
  keeper.isHero = true;
  keeper.abilities = [{ id: "AEtq", code: "AEtq", level: 1, cooldownLeft: 0, autocastOn: false }];
  keeper.inventory = ["phea", "pnvu", "pams"].map((itemId) => ({ id: nextId++, itemId, charges: 1, cooldownLeft: 0 })).concat([null, null, null]);
  const ally = add(w, { x: 400, name: "Archer", hp: 100 });
  const outside = add(w, { y: 1300, name: "Outside", hp: 100 });
  const engine = add(w, { x: -300, name: "Glaive Thrower", hp: 100 });
  engine.mechanical = true;
  const foe = add(w, { owner: 1, team: 1, x: 200, y: 200, name: "Grunt", hp: 100 });
  step(w, 0.05);
  before?.(w, keeper);
  const ok = w.issueCast(keeper.id, "AEtq", 0, keeper.x, keeper.y);
  step(w, 0.05); // the first wave lands the tick the effect fires
  return { w, keeper, ally, outside, engine, foe, ok };
}
const fields = (w) => w.activeSpellFields().filter((f) => f.code === "AEtq").length;

{
  const s = scene();
  check("the cast goes through", [s.ok, fields(s.w)], [true, 1]);
  check("an ally in the circle is healed 40 at once", s.ally.hp, 140);
  check("…and so is the Keeper herself (`self`)", s.keeper.hp, 340);
  check("…and it WEARS the Tranquility art while it is", s.ally.buffs.some((b) => b.group === "tranquility"), true);
  check("an ally outside the circle is not", s.outside.hp, 100);
  check("a mechanical unit is not", s.engine.hp, 100);
  check("an enemy is not", s.foe.hp, 100);
  step(s.w, 1);
  check("40 more a second later", s.ally.hp, 180);
  s.outside.y = 300;
  step(s.w, 1);
  check("a unit that WALKS IN is healed", s.outside.hp, 140);
  s.ally.x = 1300;
  const left = s.ally.hp;
  step(s.w, 2);
  check("a unit that walks OUT stops being healed", s.ally.hp, left);
  check("…and its Tranquility art goes", s.ally.buffs.some((b) => b.group === "tranquility"), false);
}

const broken = (what, s, breakIt) => {
  breakIt();
  step(s.w, 0.1);
  const hp = s.ally.hp;
  check(`${what} breaks the channel`, fields(s.w), 0);
  step(s.w, 3);
  check("…and the healing STOPS with it (no heal-over-time left running)", s.ally.hp, hp);
  check("…and nobody is left wearing the art", [s.ally.buffs.some((b) => b.group === "tranquility"), s.keeper.buffs.some((b) => b.group === "tranquility")], [false, false]);
};
{
  const s = scene();
  broken("moving the Keeper", s, () => s.w.issueOrder(s.keeper.id, { kind: "move", x: -300, y: 0 }));
}
{
  const s = scene();
  broken("a stun", s, () => s.w.applyBuffInternal(s.keeper, { kind: "stun", group: "test", timeLeft: 2, sourceId: 0, value: 0 }));
}
{
  const s = scene();
  let drank = false;
  broken("drinking a Potion of Healing", s, () => { drank = s.w.useItem(s.keeper.id, 0, 0, s.keeper.x, s.keeper.y); });
  check("…which is still drunk", drank, true);
}

{
  let wasInvulnerable = false;
  const s = scene((w, keeper) => {
    w.useItem(keeper.id, 1, 0, keeper.x, keeper.y);
    step(w, 0.05);
    wasInvulnerable = keeper.invulnerable;
  });
  check("(the Potion of Invulnerability made her invulnerable)", wasInvulnerable, true);
  check("an invulnerable Keeper can still cast Tranquility", [s.ok, fields(s.w)], [true, 1]);
  step(s.w, 1);
  check("…and casting it ends the invulnerability", [s.keeper.invulnerable, s.keeper.buffs.some((b) => b.group === "item:invuln")], [false, false]);
}

{
  let wasImmune = false;
  const s = scene((w, keeper) => {
    w.useItem(keeper.id, 2, 0, keeper.x, keeper.y);
    step(w, 0.05);
    wasImmune = keeper.magicImmune;
  });
  check("(the Anti-magic Potion made her spell immune)", wasImmune, true);
  check("a spell-immune Keeper can cast Tranquility", [s.ok, fields(s.w)], [true, 1]);
  step(s.w, 1);
  check("…and casting it does NOT remove the immunity", [s.keeper.magicImmune, s.keeper.buffs.some((b) => b.group === "item:antimagic")], [true, true]);
  check("…while the rain still heals", s.ally.hp > 100, true);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
