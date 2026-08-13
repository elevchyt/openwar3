// Where a blow's CLANG comes from — `<weapon sound><target material>`, e.g. MetalHeavySlice +
// Flesh → the UnitCombatSounds row MetalHeavySliceFlesh.
//
// WC3 writes the weapon half down TWICE, in two tables, under two names one letter apart from
// a THIRD column that means something else entirely. That is the whole trap:
//
//   UnitWeapons  `weapType1/2`  the per-ATTACK sound. The object editor's "Attack 1 - Weapon
//                               Sound" — UnitMetaData maps it to `ucs1`/`ucs2`, and
//                               WorldEditStrings spells the label out.
//   UnitWeapons  `weapTp1/2`    NOT a sound. normal / missile / instant — "Attack 1 - Weapon
//                               Type" (`ua1w`). One letter away, and the reason this is easy
//                               to get wrong twice.
//   UnitUI       `weap1/2`      a unit-level pair, which the object editor does not expose at
//                               all, usually saying the same thing as the slot.
//
// Neither copy is complete, which is why reading either one alone is wrong:
//
//   • 60 armed units name a sound ONLY on the slot — Ewar and Ewrd (MetalHeavySlice), the
//     Dreadlord, Anub'arak, Tichondrius, the Mountain Giant, and every spider, sea turtle and
//     murgul in the game. Reading UnitUI alone left all 60 landing blows in dead silence.
//   • 36 name one ONLY in UnitUI — the Keeper of the Grove, Cenarius, Sylvanas, the Spirit
//     Tower — and 32 of those carry no SND "K" model event either, so reading the slot alone
//     would silence THEM instead.
//
// So the rule is: the slot's own sound, and UnitUI only when the slot names none. Both halves
// are pinned below, against the developer's own unpacked install when it is there.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { syncPrimaryWeapon, UnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

/** A CSV line, honouring the quoted fields the SoundInfo tables use for their flag lists. */
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const slot = (over = {}) => ({
  enabled: true, targets: ["ground"], weaponType: "normal", attackType: "hero",
  damage: 20, dice: 1, sides: 1, cooldown: 2.05, range: 100, damagePoint: 0.1, backswing: 0.1,
  weaponSound: "", missileArt: "", missileSpeed: 900,
  spillDist: 0, spillRadius: 0, damageLoss: 0, areaFull: 0, areaHalf: 0, areaQuarter: 0,
  splashTargets: [], showUI: true, ...over,
});

// ---------------------------------------------------------------------------------------
// The flat `weaponSound` on a def is a VIEW of the primary slot, exactly as the rest of the
// attack* summary is — so an orb that moves which slot is primary moves the clang with it.
console.log("the def's weaponSound is the primary slot's");
{
  const def = {
    weapons: [slot({ weaponSound: "MetalHeavySlice" }), slot({ enabled: false, weaponSound: "WoodLightBash" })],
  };
  syncPrimaryWeapon(def);
  check("slot 1 is primary, so its sound is the summary's", def.weaponSound === "MetalHeavySlice", def.weaponSound);

  def.weapons[0].enabled = false;
  def.weapons[1].enabled = true;
  syncPrimaryWeapon(def);
  check("switching slots moves the clang too", def.weaponSound === "WoodLightBash", def.weaponSound);

  const silent = { weapons: [slot({ weaponSound: "" })] };
  syncPrimaryWeapon(silent);
  check("a slot that names none stays silent", silent.weaponSound === "");
}

// ---------------------------------------------------------------------------------------
// A map may retune it, through `ucs1`/`ucs2` — which had no setter at all, so a custom unit's
// weapon sound was dropped on the floor however the map wrote it.
console.log("\na map's own units can retune the clang (ucs1/ucs2)");
{
  const { applyMapUnitData } = require(join(REPO, ".sim-build", "src", "data", "objectData.js"));
  const War3MapW3u = require("mdx-m3-viewer/dist/cjs/parsers/w3x/w3u/file").default;
  const ModifiedObject = require("mdx-m3-viewer/dist/cjs/parsers/w3x/w3u/modifiedobject").default;
  const Modification = require("mdx-m3-viewer/dist/cjs/parsers/w3x/w3u/modification").default;

  const w3u = (oldId, newId, fields) => {
    const file = new War3MapW3u();
    const obj = new ModifiedObject();
    obj.oldId = oldId;
    obj.newId = newId;
    for (const [id, value] of fields) {
      const m = new Modification();
      m.id = id;
      m.variableType = typeof value === "string" ? 3 : 0;
      m.value = value;
      obj.modifications.push(m);
    }
    file.customTable.objects.push(obj);
    return file.save();
  };
  const baseDef = () => ({
    id: "Ewar", name: "Warden", race: "nightelf", weapons: [
      slot({ weaponSound: "MetalHeavySlice" }),
      slot({ weaponType: "missile", range: 500, enabled: false, weaponSound: "" }),
    ],
    abilities: [], heroAbilities: [], classification: [], properNames: [],
    attackDamage: 0, attackDice: 0, attackSides: 0, attackCooldown: 0, attackDamagePoint: 0,
    attackBackswing: 0, attackRange: 0, weaponType: "", attackType: "", weaponSound: "",
    missileArt: "", missileSpeed: 900, primaryAttr: "", strength: 0, agility: 0, intelligence: 0,
    acquireRange: 800, launchX: 0, launchY: 0, launchZ: 0, impactZ: 60,
  });
  const withMods = (fields) => {
    const reg = new UnitRegistry(new Map([["Ewar", baseDef()]]));
    applyMapUnitData(reg, w3u("Ewar", "x000", fields));
    return reg.get("x000");
  };

  const plain = withMods([["unam", "Custom Warden"]]);
  check("a plain clone keeps the Warden's clang", plain.weaponSound === "MetalHeavySlice", plain.weaponSound);

  const retuned = withMods([["ucs1", "WoodHeavyBash"]]);
  check("ucs1 reaches the slot", retuned.weapons[0].weaponSound === "WoodHeavyBash");
  check("...and the summary follows it", retuned.weaponSound === "WoodHeavyBash");

  // `uaen` moves which slot is primary, so it moves which clang the blow makes.
  const air = withMods([["ucs2", "MetalLightSlice"], ["uaen", 2]]);
  check("uaen=2 takes slot 2's clang with it", air.weaponSound === "MetalLightSlice", air.weaponSound);
}

// ---------------------------------------------------------------------------------------
// The BLOW carries the sound, not the attacker. Which of a unit's two slots is swinging is a
// RUNTIME fact — an orb wakes a hero's dormant air attack (`DataE`), `renw` switches the
// Flying Machine's bombs on — and none of it touches the def the flat summary came from. So
// the hit event names the weapon that landed it, and the renderer never has to ask which.
console.log("\nthe hit names the weapon that landed it");
{
  const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
  const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
  const W = 96;
  const unit = (w, id, owner, x, weapons) => w.add({
    id, owner, team: owner, typeId: "t" + id, x, y: 500, facing: 0,
    hp: 100000, maxHp: 100000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000, flying: false, mechanical: false, invulnerable: false,
    race: "human", isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16, canFlee: false, targetedAs: "ground",
    deathTime: 2, name: "T" + id, worker: null, depotGold: false, depotLumber: false,
    castPoint: 0, castBackswing: 0, weapons, oldWeapons: weapons,
  });
  /** Swing with `weapons` and report the clang the landed blow carried. */
  const clangOf = (weapons) => {
    const w = new SimWorld(new PathingGrid({ width: W, height: W, flags: new Uint8Array(W * W) }, [0, 0]), 2);
    const a = unit(w, 1, 0, 500, weapons);
    const t = unit(w, 2, 1, 560, []);
    w.issueOrder(a.id, { kind: "attack", targetId: t.id, force: true });
    for (let i = 0; i < 600; i++) {
      w.tick(1 / 60);
      const hits = w.drainHits();
      if (hits.length) return hits[0].weaponSound;
    }
    return "(no hit)";
  };

  // A hero exactly as the install writes one: a melee slot 1 that names a clang, and the
  // switched-off air slot 2 beside it naming a different one.
  const slots = () => [
    slot({ weaponSound: "MetalHeavySlice", weaponType: "normal", range: 100 }),
    slot({ weaponSound: "WoodLightBash", weaponType: "normal", range: 100, enabled: false }),
  ];
  const melee = slots();
  check("slot 1 swinging lands slot 1's clang", clangOf(weaponsFromDef({ weapons: melee, acquireRange: 800, launchX: 0, launchY: 0, launchZ: 0, impactZ: 60 })) === "MetalHeavySlice");

  // Now the orb case, done the way the sim does it: slot 2 switched on and slot 1 off. The
  // def is untouched — this is the state a runtime effect leaves the UNIT in.
  const woken = slots();
  woken[0].enabled = false;
  woken[1].enabled = true;
  const sim = weaponsFromDef({ weapons: woken, acquireRange: 800, launchX: 0, launchY: 0, launchZ: 0, impactZ: 60 });
  check("...and slot 2 swinging lands SLOT 2's", clangOf(sim) === "WoodLightBash", clangOf(sim));

  // A slot that names none stays silent rather than borrowing its neighbour's.
  const silent = [slot({ weaponSound: "", weaponType: "normal", range: 100 })];
  check("a weapon with no sound lands none", clangOf(weaponsFromDef({ weapons: silent, acquireRange: 800, launchX: 0, launchY: 0, launchZ: 0, impactZ: 60 })) === "");
}

// ---------------------------------------------------------------------------------------
// All of the above is a claim about the DATA, so check it against the developer's own
// unpacked copy when it is there (`pnpm data:extract`). Never committed; skipped when absent.
console.log("\nthe two columns, in the real install");
{
  const units = join(REPO, "Warcraft III", "ExtractedData", "merged", "Units");
  const info = join(REPO, "Warcraft III", "ExtractedData", "merged", "UI", "SoundInfo");
  if (!existsSync(units) || !existsSync(info)) {
    console.log("  skip  no Warcraft III/ExtractedData — run `pnpm data:extract`");
  } else {
    const load = (p) => {
      const rows = readFileSync(p, "latin1").split(/\r?\n/).map(splitCsv);
      const head = rows[0];
      const map = new Map();
      for (const r of rows.slice(1)) if (r[0]) map.set(r[0], r);
      return { head, map, col: (r, n) => r[head.indexOf(n)] ?? "" };
    };
    const weapons = load(join(units, "UnitWeapons.csv"));
    const ui = load(join(units, "unitUI.csv"));
    const combat = load(join(info, "UnitCombatSounds.csv"));
    const rowNames = new Set([...combat.map.keys()].map((k) => k.toLowerCase()));
    const norm = (v) => { const s = (v || "").trim(); return !s || s === "_" || s === "-" ? "" : s; };

    let agree = 0;
    const slotOnly = [], uiOnly = [];
    for (const [id, r] of ui.map) {
      const w = weapons.map.get(id);
      if (!w || (weapons.col(w, "weapsOn") || "0") === "0") continue;
      const a = norm(ui.col(r, "weap1"));
      const b = norm(weapons.col(w, "weapType1"));
      if (a === b) { if (a) agree++; continue; }
      if (a && !b) uiOnly.push(id);
      else if (!a && b) slotOnly.push(id);
    }
    // Pinned counts: a patch that redraws the split says so here rather than in someone's game.
    check("183 armed units write the same sound in both tables", agree === 183, String(agree));
    check("60 name one ONLY on the slot (silent before this)", slotOnly.length === 60, String(slotOnly.length));
    check("36 name one ONLY in UnitUI (the fallback is for these)", uiOnly.length === 36, String(uiOnly.length));

    // The units the bug was actually about, named.
    for (const [id, who, want] of [
      ["Ewar", "Warden", "MetalHeavySlice"],
      ["Ewrd", "Maiev", "MetalHeavySlice"],
      ["Udth", "Dreadlord", "WoodHeavyBash"],
      ["Uanb", "Anub'arak", "WoodHeavyBash"],
      ["emtg", "Mountain Giant", "WoodHeavyBash"],
    ]) {
      const w = weapons.map.get(id);
      const r = ui.map.get(id);
      const ok = w && norm(weapons.col(w, "weapType1")) === want && norm(ui.col(r, "weap1")) === "";
      check(`${who} (${id}): slot says ${want}, UnitUI says nothing`, !!ok,
        w ? `slot=${weapons.col(w, "weapType1")} ui=${ui.col(r, "weap1")}` : "no row");
    }
    // The other direction, so the fallback cannot be quietly deleted.
    for (const [id, who, want] of [["Ekee", "Keeper of the Grove", "WoodHeavyBash"], ["Ogld", "Gul'dan", "MetalHeavyBash"]]) {
      const w = weapons.map.get(id);
      const r = ui.map.get(id);
      const ok = w && norm(weapons.col(w, "weapType1")) === "" && norm(ui.col(r, "weap1")) === want;
      check(`${who} (${id}): slot says nothing, UnitUI says ${want}`, !!ok,
        w ? `slot=${weapons.col(w, "weapType1")} ui=${ui.col(r, "weap1")}` : "no row");
    }

    // Every sound either column names must actually PAIR with its unit's material into a real
    // UnitCombatSounds row — a base that resolves to nothing is a silent blow either way.
    const dead = [];
    for (const [id, r] of ui.map) {
      const w = weapons.map.get(id);
      if (!w || (weapons.col(w, "weapsOn") || "0") === "0") continue;
      const snd = norm(weapons.col(w, "weapType1")) || norm(ui.col(r, "weap1"));
      const armor = norm(ui.col(r, "armor"));
      if (!snd || !armor) continue;
      if (!rowNames.has((snd + armor).toLowerCase())) dead.push(`${id}:${snd}+${armor}`);
    }
    check("every resolved <weapon><material> names a real row", dead.length === 0, dead.slice(0, 8).join(" "));
  }
}

// ---------------------------------------------------------------------------------------
// …and the same claim through the REAL LOADER, over the WHOLE roster. The rule above is only
// worth anything if every unit in the game goes through it, so this asks loadUnitRegistry for
// all 800-odd defs and re-derives each one's clang straight from the two raw columns. There is
// no allowlist and nothing is named: a single unit the loader disagrees with fails the sweep.
console.log("\nevery unit in the install, through the loader itself");
{
  const units = join(REPO, "Warcraft III", "ExtractedData", "merged", "Units");
  const installed = join(REPO, "Warcraft III");
  if (!existsSync(units) || !existsSync(join(installed, ".build.info"))) {
    console.log("  skip  needs the local install + `pnpm data:extract`");
  } else {
    const { openInstall } = require(join(REPO, "tools", "install.cjs"));
    const { loadUnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
    const { weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
    const load = (p) => {
      const rows = readFileSync(p, "latin1").split(/\r?\n/).map(splitCsv);
      const head = rows[0];
      const map = new Map();
      for (const r of rows.slice(1)) if (r[0]) map.set(r[0], r);
      return { map, col: (r, n) => r[head.indexOf(n)] ?? "" };
    };
    const weapons = load(join(units, "UnitWeapons.csv"));
    const ui = load(join(units, "unitUI.csv"));
    const norm = (v) => { const s = (v || "").trim(); return !s || s === "_" || s === "-" ? "" : s; };

    module.exports.sweep = (async () => {
      const { vfs } = await openInstall(installed);
      const reg = loadUnitRegistry(vfs);
      const all = reg.all();
      const wrongSlot = [], wrongView = [], notCarried = [], stillSilent = [];
      for (const d of all) {
        const w = weapons.map.get(d.id);
        const r = ui.map.get(d.id);
        if (!w || !r) continue; // no weapons/UI row: nothing this rule applies to
        for (let i = 0; i < d.weapons.length; i++) {
          const want = norm(weapons.col(w, `weapType${i + 1}`)) || norm(ui.col(r, `weap${i + 1}`));
          if (d.weapons[i].weaponSound !== want) wrongSlot.push(`${d.id}#${i + 1}:${d.weapons[i].weaponSound}≠${want}`);
        }
        const prime = d.weapons.find((s) => s.enabled) ?? d.weapons[0];
        if (prime && d.weaponSound !== prime.weaponSound) wrongView.push(d.id);
        // …and the sim must carry each slot's own sound, since the BLOW is what plays it.
        // Match by index against the same filter weaponsFromDef applies (a slot with no
        // cooldown or no damage is not a weapon), so the pairing cannot be guessed wrong.
        const kept = d.weapons.filter((s) => !(s.cooldown <= 0 || s.damage + s.dice * s.sides <= 0));
        const sim = weaponsFromDef(d);
        if (sim.length !== kept.length) notCarried.push(`${d.id}:${sim.length}≠${kept.length}`);
        else for (let i = 0; i < sim.length; i++) {
          if (sim[i].weaponSound !== kept[i].weaponSound) notCarried.push(`${d.id}#${i + 1}`);
        }
        // The regression this whole thing is about: an armed melee unit whose data names a
        // clang must not come out of the loader unable to make one.
        const armed = (weapons.col(w, "weapsOn") || "0") !== "0";
        const named = norm(weapons.col(w, "weapType1")) || norm(ui.col(r, "weap1"));
        if (armed && named && !d.weaponSound && (d.weapons[0]?.enabled ?? false)) stillSilent.push(d.id);
      }
      check(`all ${all.length} defs: every SLOT's sound is its own weapType/weap`, wrongSlot.length === 0, wrongSlot.slice(0, 6).join(" "));
      check("...the flat weaponSound is the primary slot's, on every one", wrongView.length === 0, wrongView.slice(0, 6).join(" "));
      check("...and weaponsFromDef carries it onto every SimWeapon", notCarried.length === 0, notCarried.slice(0, 6).join(" "));
      check("no armed unit whose data names a clang is left silent", stillSilent.length === 0, stillSilent.slice(0, 6).join(" "));

      // Named spot-checks, so a sweep that silently matched nothing cannot pass.
      const ewar = reg.get("Ewar");
      check("Warden: MetalHeavySlice on the melee slot", ewar.weapons[0].weaponSound === "MetalHeavySlice", ewar.weapons[0].weaponSound);
      check("Warden: nothing on the dormant air slot", ewar.weapons[1].weaponSound === "", JSON.stringify(ewar.weapons[1].weaponSound));
      check("Warden: the summary shows the melee slot", ewar.weaponSound === "MetalHeavySlice");
      const hpea = reg.get("hpea");
      check("Peasant: slot 1 hammer, slot 2 axe (the chop)",
        hpea.weapons[0].weaponSound === "MetalLightChop" && hpea.weapons[1].weaponSound === "AxeMediumChop",
        hpea.weapons.map((s) => s.weaponSound).join("/"));
      check("Peasant: lumberSound is still the harvest axe", hpea.lumberSound === "AxeMediumChop", hpea.lumberSound);

      console.log(failures ? `\n${failures} FAILED` : "\nall passed");
      process.exit(failures ? 1 : 0);
    })().catch((e) => { console.error(e); process.exit(1); });
  }
}
if (!module.exports.sweep) {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
