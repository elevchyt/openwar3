// Headless check of the VAMPIRIC drain's own flash — the one-shot a life steal plays on the
// unit it heals.
//
// The art is the buff row's, not the ability's: `[BUav] Specialart = Abilities\Spells\Undead\
// VampiricAura\VampiricAuraTarget.mdl` (`Specialattach = origin`), which is the data naming
// this model as the drain FIRING rather than as something worn — ItemAbilityFunc says so in
// as many words over the Mask of Death's `[AIvd]`: "special art played on hero when ability
// fires", reaching for the same model. `[BUav] Targetart` is the plain GeneralAuraTarget
// every aura wears and is a different thing entirely.
//
// A row that names no such art shows none, which is the data's own answer for two members of
// the family: the Potion of Vampirism's `[BIpv]` carries a button icon and nothing else, and
// the creep Vampiric Aura `[ACvp]` names no BuffID1 at all.
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
// `AUav` as the game states it, with its buff row's Specialart.
const AURA = {
  code: "AUav", targetFlags: ["air", "ground", "friend", "self", "vuln", "invu", "organic"],
  buffSpecialArt: VAMP_ART, buffArt: "", buffFx: [], targetArt: "",
  levelData: [{ area: 900, duration: 0, heroDuration: 0, data: [0.15], buffs: ["BUav"] }],
};
world.abilities = { get: (id) => (id === "AUav" ? AURA : undefined) };

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

unit({ abilities: [{ id: "AUav", code: "AUav", level: 1 }] }); // the Dread Lord broadcasting it
const ghoul = unit({ x: 150, hp: 200, weapon: weapon(), weapons: [weapon()] });
const foe = unit({ team: 1, x: 200 });
world.applyAuras();
world.recomputeStats(ghoul);

check("the aura grants dataA life steal", ghoul.lifesteal, 0.15);
check("…and caches its buff row's Specialart with it", ghoul.lifestealArt, VAMP_ART);

const drain = () => world.drainSpellEffects().filter((e) => e.art === VAMP_ART).map((e) => [e.art, e.targetId]);
world.drainSpellEffects();
world.dealDamage(ghoul, foe, weapon());
check("a 100-damage blow heals 15", ghoul.hp, 215);
check("…and the drain flashes on the unit it HEALED, riding it", drain(), [[VAMP_ART, ghoul.id]]);

ghoul.hp = ghoul.maxHp;
world.dealDamage(ghoul, foe, weapon());
check("a Ghoul already at full life drinks nothing and shows nothing", drain(), []);

// The POTION of Vampirism (`AIpv`) steals the same way and shows nothing: its `[BIpv]` row
// carries a button icon and no Specialart, and its buff group names no ability row at all.
const drinker = unit({ x: 3000, y: 3000, hp: 200, weapon: weapon(), weapons: [weapon()] });
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
