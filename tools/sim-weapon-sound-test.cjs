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

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
