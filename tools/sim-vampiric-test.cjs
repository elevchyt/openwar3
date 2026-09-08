// Headless check of the VAMPIRIC family — the life steal itself and the one-shot it flashes
// on the unit it heals.
//
// The art is the BUFF row's, not the ability's: `[BUav] Specialart = Abilities\Spells\Undead\
// VampiricAura\VampiricAuraTarget.mdl` (`Specialattach = origin`), which is the data naming
// this model as the drain FIRING rather than as something worn — ItemAbilityFunc says so in
// as many words over the Mask of Death's `[AIvd]`: "special art played on hero when ability
// fires", reaching for the same model. `[BUav] Targetart` is the plain GeneralAuraTarget
// every aura wears and is a different thing entirely.
//
// The other half of what this pins is that the family is THREE ROWS AND ONE BEHAVIOUR. All
// of AbilityData's `AUav` (the Dread Lord's), `ACvp` ("Vampiric Aura (creep)") and `AIav`
// ("ItemAuraVampiric", which is Scourge Bone Chimes — its Ubertip quotes `<AIav,DataA1,%>`)
// carry **`code` = `AUav`** and **BuffID1 = `BUav`**, and every gate on the way reads the
// base code rather than the alias: buildInitialAbilities' `KNOWN_ABILITIES[a.code]`,
// auraSources' `AURA_BUFFS[def.code]`, the `${ab.code}:${kind}` group that makes the three
// refuse to stack ("Does not stack with Vampiric Aura", the item's own tooltip), and
// lifestealArtOf reading that group back. So a creep and a carried chime steal and flash
// exactly as the hero's aura does, WITHOUT a row of their own anywhere — and their own
// numbers still come off their own rank (`ACvp` DataA1 0.2, `AIav` 0.15).
//
// A member that names no such art shows none, which is the data's answer for the Potion of
// Vampirism: `[BIpv]` carries a button icon and nothing else.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const VAMP_ART = "Abilities\\Spells\\Undead\\VampiricAura\\VampiricAuraTarget.mdl";
const world = new SimWorld({ width: 8, height: 8, cell: 128, blocked: new Uint8Array(64) }, 1);
// The three rows as AbilityData states them: one `code`, one buff, three DataA columns.
const row = (dataA) => ({
  code: "AUav", targetFlags: ["air", "ground", "friend", "self", "vuln", "invu", "organic"],
  buffSpecialArt: VAMP_ART, buffArt: "", buffFx: [], targetArt: "",
  levelData: [{ area: 900, duration: 0, heroDuration: 0, data: [dataA], buffs: ["BUav"] }],
});
const ROWS = { AUav: row(0.2), ACvp: row(0.2), AIav: row(0.15) };
world.abilities = { get: (id) => ROWS[id] };
// Scourge Bone Chimes (`sbch`), whose whole contribution is the ability id it carries.
world.itemReg = { get: (id) => (id === "sbch" ? { abilities: ["AIav"] } : undefined) };

let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, x: 100, y: 200, hp: 1000, maxHp: 1000, mana: 0, maxMana: 0,
    buffs: [], abilities: [], inventory: [], weapons: [], garrison: [], orderQueue: [],
    arrowShot: null, blackArrow: null, incinerate: null, isHero: false, isSummon: false,
    building: null, mechanical: false, flying: false, invulnerable: false, neutralPassive: false,
    isIllusion: false, race: "undead", typeId: "ugho", level: 1, baseMaxHp: 1000, baseMaxMana: 0,
    baseArmor: 0, armor: 0, baseSpeed: 270, speed: 270, hpRegen: 0, manaRegen: 0, lifesteal: 0,
    lifestealArt: "", thorns: 0, swingCrit: false, swingBash: false, cloaked: false, devouring: 0,
    devouredBy: 0, garrisonHost: 0, constructing: 0, inMine: false, resId: 0, linkShare: 0,
    linkT: 0, linkGroup: [], summonLeft: 0,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const weapon = () => ({ damage: 100, dice: 0, sides: 0, cooldown: 1, damagePoint: 0, backswing: 0, range: 90, ranged: false, attackType: "normal", weaponSound: "MetalHeavyChop" });
const soldier = (over) => unit({ hp: 200, weapon: weapon(), weapons: [weapon()], ...over });
const drain = () => world.drainSpellEffects().filter((e) => e.art === VAMP_ART).map((e) => [e.art, e.targetId]);

const foe = unit({ team: 1, x: 200, hp: 100000, maxHp: 100000 });

// --- the Dread Lord's own aura ------------------------------------------------------
unit({ abilities: [{ id: "AUav", code: "AUav", level: 1 }] });
const ghoul = soldier({ x: 150 });
world.applyAuras();
world.recomputeStats(ghoul);

check("the aura grants dataA life steal", ghoul.lifesteal, 0.2);
check("…and caches its buff row's Specialart with it", ghoul.lifestealArt, VAMP_ART);

world.drainSpellEffects();
world.dealDamage(ghoul, foe, weapon());
check("a 100-damage blow heals 20", ghoul.hp, 220);
check("…and the drain flashes on the unit it HEALED, riding it", drain(), [[VAMP_ART, ghoul.id]]);

ghoul.hp = ghoul.maxHp;
world.dealDamage(ghoul, foe, weapon());
check("a Ghoul already at full life drinks nothing and shows nothing", drain(), []);

// --- the CREEP aura (`ACvp`), which has no handler of its own ------------------------
// Its holder's SimAbility carries the base code, exactly as buildInitialAbilities writes it.
const creep = soldier({ x: 3000, y: 3000, abilities: [{ id: "ACvp", code: "AUav", level: 1 }] });
world.applyAuras();
world.recomputeStats(creep);
check("a creep's `ACvp` steals, riding `AUav`'s handler", creep.lifesteal, 0.2);
check("…off its OWN row's DataA1", world.abilities.get("ACvp").levelData[0].data[0], 0.2);
world.drainSpellEffects();
world.dealDamage(creep, foe, weapon());
check("…and flashes the same drain, on itself", [creep.hp, drain()], [220, [[VAMP_ART, creep.id]]]);

// --- SCOURGE BONE CHIMES (`AIav`), carried rather than learned -----------------------
const bearer = soldier({ x: -3000, y: -3000, inventory: [{ id: 1, itemId: "sbch" }] });
world.applyAuras();
world.recomputeStats(bearer);
check("the chimes' aura reaches its own bearer", bearer.lifesteal, 0.15);
check("…and names the same drain art", bearer.lifestealArt, VAMP_ART);
world.drainSpellEffects();
world.dealDamage(bearer, foe, weapon());
check("…which flashes on the bearer it healed", [bearer.hp, drain()], [215, [[VAMP_ART, bearer.id]]]);
// One group for all three, which is the "does not stack" the item's tooltip states.
check("all three share one buff group", bearer.buffs.map((b) => b.group), ["AUav:lifesteal"]);

// --- the POTION of Vampirism (`AIpv`), which steals and shows nothing ----------------
const drinker = soldier({ x: 6000, y: 6000 });
drinker.buffs.push({
  kind: "lifesteal", group: "item:vampiric", timeLeft: 45, sourceId: drinker.id,
  value: 0.75, value2: 0, art: "", fx: [], buffId: "BIpv", delay: 0,
});
world.recomputeStats(drinker);
check("the potion steals its own dataB", drinker.lifesteal, 0.75);
check("…and names no drain art", drinker.lifestealArt, "");
world.drainSpellEffects();
world.dealDamage(drinker, foe, weapon());
check("so a potion's drain heals silently", [drinker.hp, drain()], [275, []]);

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
