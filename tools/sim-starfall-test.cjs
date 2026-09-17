// Headless check of STARFALL's (`AEsf`) rules as a player meets them, through the real cast
// pipeline (`issueCast` → the channel → the field → `landWave`) and the real item door
// (`useItem`). Numbers are the install's 1.30.4 `[AEsf]` row (Units\AbilityData.slk):
// Dur1 45, Area1 1000, DataA "Damage Dealt" 50, DataB "Damage Interval" 1.5, DataC "Building
// Reduction" 0.35, targs1 air,ground,structure,enemy,neutral.
//
// And two potions a player drinks before casting it (the developer, from the original game):
// casting Starfall ENDS a Potion of Invulnerability (`AIvu`, buff `Bvul`, Dur1 15), while an
// Anti-magic Potion (`AIxs`, code `Aami`, Dur1 15 — spell immunity) survives the cast.
//
// The rules, from Liquipedia's Starfall page:
//   - "If you use potions it will interrupt the Starfall."
//   - "Starfall damage vs. buildings is reduced to 35%."
//   - it "hits units automatically without the caster having to aim", so the only way out is
//     to leave the area;
//   - it "must be maintained by having the Priestess of the Moon stand still".
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
  AEsf: ability("AEsf", "AEsf", {
    targetFlags: ["air", "ground", "structure", "enemy", "neutral"],
    levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 1000, duration: 45, heroDuration: 30, castTime: 0, data: D(50, 1.5, 0.35), buffs: ["AEsd"], summon: "" }],
  }),
  // Potion of Healing (`AIh1`, code AIhe): DataA 250, the drinker's own.
  AIh1: ability("AIh1", "AIhe", { isItem: true, levelData: [{ cost: 0, cooldown: 20, castRange: 0, area: 0, duration: 0, heroDuration: 0, castTime: 0, data: D(250), buffs: [], summon: "" }] }),
  AIvu: ability("AIvu", "AIvu", { isItem: true, targetFlags: ["vuln", "invu"], levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 0, duration: 15, heroDuration: 15, castTime: 0, data: D(), buffs: ["Bvul"], summon: "" }] }),
  AIxs: ability("AIxs", "Aami", { isItem: true, targetFlags: ["air", "ground"], levelData: [{ cost: 0, cooldown: 0, castRange: 0, area: 0, duration: 15, heroDuration: 15, castTime: 0, data: D(0), buffs: ["Bams", "Bam2"], summon: "" }] }),
};
const ITEMS = {
  phea: { id: "phea", name: "Potion of Healing", abilities: ["AIh1"], charges: 1, usable: true, perishable: true, powerup: false, cooldownGroup: "phea", classType: "Purchasable" },
  pnvu: { id: "pnvu", name: "Potion of Invulnerability", abilities: ["AIvu"], charges: 1, usable: true, perishable: true, powerup: false, cooldownGroup: "pnvu", classType: "Purchasable" },
  pams: { id: "pams", name: "Anti-magic Potion", abilities: ["AIxs"], charges: 1, usable: true, perishable: true, powerup: false, cooldownGroup: "pams", classType: "Purchasable" },
};

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

/** The Priestess at the origin with Starfall, an enemy footman 400 away, an enemy building 600
 *  away, one enemy well outside the 1000 circle — and the cast pressed and landed. */
function scene(before) {
  const w = world();
  const pom = add(w, { name: "Priestess", hp: 500, maxHp: 800 });
  pom.isHero = true;
  pom.abilities = [{ id: "AEsf", code: "AEsf", level: 1, cooldownLeft: 0, autocastOn: false }];
  pom.inventory = [{ id: nextId++, itemId: "phea", charges: 1, cooldownLeft: 0 }, { id: nextId++, itemId: "pnvu", charges: 1, cooldownLeft: 0 },
    { id: nextId++, itemId: "pams", charges: 1, cooldownLeft: 0 }, null, null, null];
  const foe = add(w, { owner: 1, team: 1, x: 400, name: "Footman" });
  const tower = add(w, { owner: 1, team: 1, x: -600, name: "Tower", isBuilding: true, speed: 0, radius: 48 },
    { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: -600, rallyY: 0, rallyKind: "point", rallyTargetId: 0, producesUnits: false });
  const far = add(w, { owner: 1, team: 1, y: 1400, name: "Far away" });
  step(w, 0.05);
  before?.(w, pom);
  const ok = w.issueCast(pom.id, "AEsf", 0, pom.x, pom.y);
  step(w, 0.05); // the first wave lands the tick the effect fires
  return { w, pom, foe, tower, far, ok };
}
const fields = (w) => w.activeSpellFields().filter((f) => f.code === "AEsf").length;

{
  const s = scene();
  check("the cast goes through", s.ok, true);
  check("a Starfall field is running", fields(s.w), 1);
  check("…with no target: an enemy inside the circle is struck without being aimed at", s.foe.hp, 950);
  check("an enemy building takes 35% of a wave (50 × 0.35), not 65%", s.tower.hp, 1000 - 17.5);
  check("an enemy outside the 1000 circle is not struck", s.far.hp, 1000);
  step(s.w, 1.5);
  check("a second wave 1.5 s later", s.foe.hp, 900);
  // The only escape is to LEAVE: walk the footman out of the circle and it stops being hit.
  s.foe.x = 1300;
  step(s.w, 3);
  check("…and a unit that leaves the area is no longer hit", s.foe.hp, 900);
  s.foe.x = 400;
  step(s.w, 1.5);
  check("…and is hit again the moment it walks back in", s.foe.hp < 900, true);
}

{
  const s = scene();
  const before = s.foe.hp;
  s.w.issueOrder(s.pom.id, { kind: "move", x: -300, y: 0 });
  step(s.w, 0.1);
  check("moving the Priestess breaks the channel", fields(s.w), 0);
  step(s.w, 4.5);
  check("…and no wave lands after it", s.foe.hp, before);
}

{
  const s = scene();
  const before = s.foe.hp;
  check("the Potion of Healing is drunk mid-channel", s.w.useItem(s.pom.id, 0, 0, s.pom.x, s.pom.y), true);
  check("…and heals", s.pom.hp, 750);
  step(s.w, 0.05);
  check("…and the potion breaks the Starfall", [s.pom.order, fields(s.w)], ["idle", 0]);
  step(s.w, 4.5);
  check("…so no wave lands after it", s.foe.hp, before);
}

{
  const s = scene();
  const before = s.foe.hp;
  s.w.applyBuffInternal(s.pom, { kind: "stun", group: "test", timeLeft: 2, sourceId: 0, value: 0 });
  step(s.w, 0.1);
  check("a stun breaks the channel too", fields(s.w), 0);
  step(s.w, 4.5);
  check("…and no wave lands after it", s.foe.hp, before);
}

{
  // A Potion of Invulnerability, then Starfall: the cast takes the bubble off.
  let wasInvulnerable = false;
  const s = scene((w, pom) => {
    w.useItem(pom.id, 1, 0, pom.x, pom.y);
    step(w, 0.05);
    wasInvulnerable = pom.invulnerable;
  });
  check("(the Potion of Invulnerability made her invulnerable)", wasInvulnerable, true);
  check("an invulnerable Priestess can still cast Starfall", [s.ok, fields(s.w)], [true, 1]);
  check("…and casting it ends the invulnerability", [s.pom.invulnerable, s.pom.buffs.some((b) => b.group === "item:invuln")], [false, false]);
  step(s.w, 1);
  check("…for good (not re-derived next tick)", s.pom.invulnerable, false);
}

{
  // An Anti-magic Potion, then Starfall: the immunity stays.
  let wasImmune = false;
  const s = scene((w, pom) => {
    w.useItem(pom.id, 2, 0, pom.x, pom.y);
    step(w, 0.05);
    wasImmune = pom.magicImmune;
  });
  check("(the Anti-magic Potion made her spell immune)", wasImmune, true);
  check("a spell-immune Priestess can cast Starfall", [s.ok, fields(s.w)], [true, 1]);
  step(s.w, 1);
  check("…and casting it does NOT remove the immunity", [s.pom.magicImmune, s.pom.buffs.some((b) => b.group === "item:antimagic")], [true, true]);
  check("…while the stars still fall", s.foe.hp < 1000, true);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
