// Headless check of SpellCastRangeBuffer (issue #235) — with the real 1.30.4 rows.
//
//   `Units\MiscData.txt` [Misc] SpellCastRangeBuffer = 300, "distance target can move between
//   starting cast and spell effect"
//
// The cast range is checked once, before the wind-up begins. A UNIT target that then gets more
// than the buffer past that range before the effect fires is out of the spell's reach: the cast
// is dropped as an interrupt is — no effect, no mana, no cooldown. One that stays inside the
// buffer is still struck.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry, KNOWN_ABILITIES } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry, autoArmed } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const G = require(join(REPO, ".sim-build", "src", "data", "gameplayConstants.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "AbilityData.slk"))) {
  console.log("skip  no extracted game data (run `pnpm data:extract`)");
  process.exit(0);
}
/** The unpacked install as a DataSource, case-insensitively (see sim-creep-spells-test.cjs). */
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

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

const W = 200, H = 200;
const world = () => new SimWorld(new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]), 1, ABILITIES, undefined, UNITS);

let nextId = 1;
function spawn(w, typeId, x, y, owner, team) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  const abilities = [];
  for (const id of def.abilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: autoArmed(def, id, a.code) });
  }
  return w.add(
    {
      id: nextId++, owner, team, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying: false, flyHeight: 0,
      sightDay: 3000, sightNight: 3000,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: "ground", moveType: "foot",
      worker: null, depotGold: false, depotLumber: false,
    },
    null,
    { abilities, level: def.level, isPeon: def.classification.includes("peon") },
  );
}
const DT = 0.05;
const tick = (w, n = 1) => { for (let i = 0; i < n; i++) w.tick(DT); };

check("the buffer is MiscData's 300", G.miscData("SpellCastRangeBuffer"), 300);

/**
 * A Mountain King throws Storm Bolt at a Footman; once the wind-up has begun the Footman is
 * moved `away` units straight back (a Blink, a Wind Walk — anything quicker than a walk), and
 * the bolt either goes out or the cast is dropped.
 */
function boltAfterStep(away) {
  const w = world();
  const mk = spawn(w, "Hmkg", 1000, 3000, 0, 0);
  if (!mk.abilities.some((a) => a.id === "AHtb")) mk.abilities.push({ id: "AHtb", code: "AHtb", level: 1, cooldownLeft: 0, autocastOn: false });
  mk.baseMaxMana = mk.maxMana = mk.mana = 1000;
  // A long cast point, so the step lands well inside the wind-up whatever the row says.
  mk.castPoint = 1;
  const f = spawn(w, "hfoo", 1500, 3000, 1, 1);
  const issued = w.issueCast(mk.id, "AHtb", f.id, 0, 0);
  for (let i = 0; i < 400 && !(mk.pendingCast && mk.pendingCast.started); i++) tick(w);
  const range = mk.pendingCast ? mk.pendingCast.range : 0;
  const started = !!(mk.pendingCast && mk.pendingCast.started);
  f.x += away;
  tick(w, 60); // the rest of the wind-up and the bolt's flight
  const stunned = f.buffs.some((b) => b.kind === "stun");
  const ab = mk.abilities.find((a) => a.id === "AHtb");
  return { issued, started, range, stunned, manaSpent: mk.mana < 1000, cooling: ab.cooldownLeft > 0, order: mk.order };
}

console.log("\nA target that stays inside the buffer is still struck");
{
  const r = boltAfterStep(200);
  check("the cast is taken", r.issued, true);
  check("…and winds up", r.started, true);
  check("Storm Bolt's cast range is its Rng1 (600)", r.range, 600);
  check("the bolt lands (stun)", r.stunned, true);
  check("…and is paid for", r.manaSpent, true);
  check("…and goes on cooldown", r.cooling, true);
}

console.log("\nA target that gets past range + buffer during the wind-up escapes it");
{
  const r = boltAfterStep(900);
  check("the cast winds up", r.started, true);
  check("no bolt lands", r.stunned, false);
  check("no mana is spent", r.manaSpent, false);
  check("no cooldown starts", r.cooling, false);
  check("the caster is stopped, not left chasing", r.order === "cast", false);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
