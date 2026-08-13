// Who actually THROWS something — `weapTp` is the only column that decides, and the whole
// Warden/Demon Hunter class of "wrong projectile" bugs came from reading a different one.
//
// The trap, straight out of the install: EVERY hero's UnitWeapons row carries a switched-off
// second weapon slot (`weapsOn` = 1, slot 2 = `missile`, range 500), the dormant air attack an
// orb wakes (docs/orbs.md, `DataE` = "Enabled Attack Index"). The single `Missileart` on the
// hero's UnitFunc row belongs to THAT slot — and Ewar's WardenMissile, Edem's
// DemonHunterMissile, the Brewmaster's and the Gargoyle's occur NOWHERE else in the game data,
// no ability and no other unit. So "the row has a missile model, therefore this unit shoots"
// gave a melee Warden a glaive to throw at 100 range, with a missile impact sound to match.
//
// The second half is `instant`, which is ranged but does NOT fly: all six stock instant slots
// (hrif, hgyr, hmtt, hrtt, zhyd, zmar) name a `*Impact.mdx` holding a lone "Birth" sequence —
// nothing to loop in flight — while every real missile carries "Stand" + "Death". thehelper on
// the Rifleman: "he attacks, and immediately the target will be hit […] without any flying
// thing". So the art is a burst on the unit struck and the damage lands on the fire frame.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const SIM_DT = 1 / 60;
const W = 96, H = 96;
const grid = () => new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);

const MELEE_TARGETS = ["ground", "structure", "debris", "item", "ward"];
const AIR_TARGETS = ["ground", "structure", "debris", "air", "item", "ward"];

/** A UnitWeapons slot as src/data/units.ts hands it over (a WeaponSlotDef). */
const slot = (over = {}) => ({
  enabled: true, targets: MELEE_TARGETS, weaponType: "normal", attackType: "hero",
  damage: 20, dice: 1, sides: 1, cooldown: 1.0, range: 100, damagePoint: 0.1, backswing: 0.1,
  missileArt: "", missileSpeed: 900,
  spillDist: 0, spillRadius: 0, damageLoss: 0, areaFull: 0, areaHalf: 0, areaQuarter: 0,
  splashTargets: [], showUI: true, ...over,
});
const def = (weapons) => ({
  weapons, acquireRange: 800, launchX: 0, launchY: 0, launchZ: 0, impactZ: 60,
});

function addUnit(w, id, owner, x, y, weapons, over = {}) {
  return w.add({
    id, owner, team: owner, typeId: "t" + id, x, y, facing: 0,
    hp: 100000, maxHp: 100000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: false, targetedAs: "ground", deathTime: 2, name: "T" + id,
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    ...over, weapons, oldWeapons: weapons,
  });
}

/** Attack `target` until the swing fires, and report what came out of the sim. */
function swing(attackerWeapons) {
  const w = new SimWorld(grid(), 2);
  const a = addUnit(w, 1, 0, 500, 500, attackerWeapons);
  const t = addUnit(w, 2, 1, 560, 500, []);
  w.issueOrder(a.id, { kind: "attack", targetId: t.id, force: true });
  const out = { projectiles: [], effects: [], hits: [] };
  for (let i = 0; i < 240; i++) {
    w.tick(SIM_DT);
    out.projectiles.push(...w.drainSpawnedProjectiles());
    out.effects.push(...w.drainSpellEffects());
    out.hits.push(...w.drainHits());
    if (out.projectiles.length || out.hits.length) break;
  }
  out.hp = t.hp;
  return out;
}

// ---------------------------------------------------------------------------------------
console.log("\na melee slot never throws, however the row is written");
{
  // What units.ts NOW produces for Ewar: the melee slot's art gated off, the air slot keeping
  // it. The Warden stays a melee unit and her WardenMissile waits for the orb that wakes slot 2.
  const warden = def([
    slot({ weaponType: "normal", range: 100, missileArt: "" }),
    slot({ weaponType: "missile", range: 500, targets: AIR_TARGETS, enabled: false, missileArt: "WardenMissile.mdx" }),
  ]);
  const sw = weaponsFromDef(warden);
  check("Warden slot 1 (weapTp normal) is melee", sw[0].ranged === false);
  check("Warden slot 1 carries no missile art", sw[0].missileArt === "");
  check("her switched-off air slot keeps WardenMissile", sw[1].missileArt === "WardenMissile.mdx" && sw[1].enabled === false);

  const r = swing(sw);
  check("she swings without loosing a projectile", r.projectiles.length === 0, `${r.projectiles.length} spawned`);
  check("and the blow lands as a melee hit", r.hits.length === 1 && r.hp < 100000);

  // Belt and braces: even handed a melee slot that still carries art (an old cached def, a
  // custom map's object data), the sim must not fly it. `weapTp` is the only vote.
  const legacy = weaponsFromDef(def([slot({ weaponType: "normal", missileArt: "WardenMissile.mdx" })]));
  check("a melee slot WITH art is still melee", legacy[0].ranged === false);
  check("and still spawns nothing", swing(legacy).projectiles.length === 0);
}

console.log("\nan `instant` slot is ranged but does not fly");
{
  // The Rifleman (hrif): weapTp1 instant, rangeN1 400, Missileart RifleImpact.mdl.
  const rifle = weaponsFromDef(def([slot({
    weaponType: "instant", range: 400, targets: AIR_TARGETS, attackType: "pierce",
    missileArt: "Abilities\\Weapons\\Rifle\\RifleImpact.mdx",
  })]));
  check("the Rifleman's instant slot is RANGED", rifle[0].ranged === true);

  const r = swing(rifle);
  check("nothing is put in flight", r.projectiles.length === 0, `${r.projectiles.length} spawned`);
  check("the damage lands on the fire frame", r.hits.length === 1 && r.hp < 100000);
  check("RifleImpact bursts on the unit struck", r.effects.length === 1 && r.effects[0].art === rifle[0].missileArt, JSON.stringify(r.effects));
  check("...attached to that unit, not to the ground", r.effects[0]?.targetId === 2);
}

console.log("\na missile slot still flies");
{
  const archer = weaponsFromDef(def([slot({
    weaponType: "missile", range: 600, targets: AIR_TARGETS, attackType: "pierce",
    missileArt: "Abilities\\Weapons\\Arrow\\ArrowMissile.mdx",
  })]));
  check("the Archer's slot is ranged", archer[0].ranged === true);
  const r = swing(archer);
  check("her arrow is spawned", r.projectiles.length === 1 && r.projectiles[0].art === archer[0].missileArt);
  check("and nothing landed yet — it is in flight", r.hits.length === 0);
}

// ---------------------------------------------------------------------------------------
// The claim above is about the DATA, so check it against the data when the developer's own
// unpacked copy is there (`pnpm data:extract`). Never committed; skipped when absent.
console.log("\nthe rows this is about, in the real install");
{
  const dir = join(REPO, "Warcraft III", "ExtractedData", "merged", "Units");
  if (!existsSync(dir)) {
    console.log("  skip  no Warcraft III/ExtractedData — run `pnpm data:extract`");
  } else {
    const rows = readFileSync(join(dir, "UnitWeapons.csv"), "latin1").split(/\r?\n/).map((l) => splitCsv(l));
    const head = rows[0];
    const col = (r, name) => r[head.indexOf(name)] ?? "";
    const weapons = new Map(rows.slice(1).filter((r) => r[0]).map((r) => [r[0], r]));

    const art = new Map(); // unit id → its UnitFunc Missileart, comma list intact
    for (const f of readdirSync(dir).filter((f) => /UnitFunc\.txt$/i.test(f))) {
      let cur = null;
      for (const line of readFileSync(join(dir, f), "latin1").split(/\r?\n/)) {
        const s = line.trim();
        const m = /^\[(.+)\]$/.exec(s);
        if (m) { cur = m[1]; continue; }
        if (cur && /^Missileart\s*=/i.test(s)) art.set(cur, s.slice(s.indexOf("=") + 1).trim());
      }
    }

    // The melee heroes whose UnitFunc art is slot 2's. If this ever stops being true the gate
    // in units.ts is solving a problem the data no longer has.
    for (const [id, who] of [["Ewar", "Warden"], ["Edem", "Demon Hunter"], ["Nal3", "Brewmaster"], ["ugar", "Gargoyle"]]) {
      const r = weapons.get(id);
      const ok = r && col(r, "weapTp1").toLowerCase() === "normal" && col(r, "weapTp2").toLowerCase() === "missile" && !!art.get(id);
      check(`${who} (${id}): melee slot 1, missile slot 2, one Missileart between them`, !!ok,
        r ? `${col(r, "weapTp1")}/${col(r, "weapTp2")} ${art.get(id) || "(no art)"}` : "no row");
    }

    // …and every `instant` slot in the game names an *Impact model, never a missile.
    const instants = [];
    for (const [id, r] of weapons) for (const n of [1, 2]) {
      if (col(r, `weapTp${n}`).toLowerCase() === "instant") instants.push([id, n]);
    }
    check("the install has exactly the six known instant slots", instants.length === 6, instants.map(([i, n]) => `${i}#${n}`).join(" "));
    const allImpact = instants.every(([id, n]) => {
      const list = (art.get(id) || "").split(",").map((s) => s.trim()).filter(Boolean);
      return /Impact\.mdl$/i.test(list[n - 1] ?? list[0] ?? "");
    });
    check("every one of them names an *Impact model", allImpact);
  }
}

/** SLK-derived CSV: fields may be quoted, and a quoted field may hold commas. */
function splitCsv(line) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall good\n");
process.exit(failures ? 1 : 0);
