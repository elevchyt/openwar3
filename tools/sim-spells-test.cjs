// Headless check of the creep/neutral caster spells added from the ability audit.
//
// Each handler is called directly with a stub SpellApi, so what is being verified is the
// thing that actually matters: which Data column each spell reads, and what buff it turns
// it into. The numbers are the real 1.27a ones from Units\AbilityData.slk, and the column
// MEANINGS are the game's own (AbilityMetaData.slk `useSpecific` → WorldEditStrings.txt).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SPELL_HANDLERS } = require(join(REPO, ".sim-build", "src", "sim", "spells.js"));

/** An AbilityDef with just the fields a handler reads. `data` is dataA..dataI. */
function def(over = {}) {
  const { data = [], duration = 0, area = 0, ...rest } = over;
  return {
    id: "TEST", code: "TEST", missileArt: "", targetArt: "", casterArt: "", specialArt: "",
    effectArt: "", areaArt: "", buffArt: "", buffFx: [], buffEffectArt: "", buffSpecialArt: "",
    levelData: [{ cost: 0, cooldown: 0, duration, heroDuration: duration, castRange: 0, area, castTime: 0, data, buffs: [], summon: "" }],
    ...rest,
  };
}

function unit(over = {}) {
  return { id: 1, owner: 0, team: 0, hp: 500, maxHp: 1000, mana: 0, maxMana: 300, x: 0, y: 0, flying: false, building: null, mechanical: false, isHero: false, ...over };
}

/** Records what the handler did instead of touching a world. */
function harness(units) {
  const log = { buffs: [], damage: [], heals: [], effects: [] };
  const api = {
    rng: () => 0.5,
    getUnit: (id) => units.find((u) => u.id === id),
    unitsInArea: () => units,
    hostile: (a, b) => a.team !== b.team,
    ally: (a, b) => a.team === b.team,
    spellDamage: (t, amount) => log.damage.push({ id: t.id, amount }),
    spellHeal: (t, amount) => log.heals.push({ id: t.id, amount }),
    applyBuff: (t, b) => log.buffs.push({ id: t.id, kind: b.kind, group: b.group, value: b.value, value2: b.value2, timeLeft: b.timeLeft }),
    emitEffect: (art) => log.effects.push(art),
    dispel: () => {}, emitSplat: () => {}, summon: () => {}, killUnit: () => {},
  };
  return { api, log };
}

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}
const round = (n) => Math.round(n * 1000) / 1000;

// Roar — dataA "Damage Increase (%)" = 0.25 over 45s, Area 500, friendlies only.
{
  const caster = unit({ id: 1, team: 0 });
  const ally = unit({ id: 2, team: 0 });
  const { api, log } = harness([caster, ally]);
  SPELL_HANDLERS.Aroa(api, caster, def({ data: [0.25, 0, 0], duration: 45, area: 500 }), 1, { targetId: 0, x: 0, y: 0 });
  check("Roar buffs damage by dataA, not armour or regen", log.buffs.map((b) => [b.kind, b.value]), [["damagePct", 0.25], ["damagePct", 0.25]]);
  check("…for the row's duration", log.buffs[0].timeLeft, 45);
}

// Fire Bolt — dataA "Damage" = 100 plus a 2s stun.
{
  const caster = unit({ id: 1, team: 0 });
  const foe = unit({ id: 2, team: 1 });
  const { api, log } = harness([caster, foe]);
  SPELL_HANDLERS.ANfb(api, caster, def({ data: [100], duration: 2 }), 1, { targetId: 2, x: 0, y: 0 });
  check("Fire Bolt deals dataA damage", log.damage, [{ id: 2, amount: 100 }]);
  check("…and stuns for the duration", [log.buffs[0].kind, log.buffs[0].timeLeft], ["stun", 2]);
}

// Finger of Death — the damage is dataC (500). dataA/dataB are graphic timings, and
// reading dataA the way most nukes do would deal 0.25 damage instead of 500.
{
  const caster = unit({ id: 1, team: 0 });
  const foe = unit({ id: 2, team: 1 });
  const { api, log } = harness([caster, foe]);
  SPELL_HANDLERS.ANfd(api, caster, def({ data: [0.25, 1, 500] }), 1, { targetId: 2, x: 0, y: 0 });
  check("Finger of Death reads dataC for damage, not dataA", log.damage, [{ id: 2, amount: 500 }]);
  check("…and applies no buff", log.buffs, []);
}

// Heal (creep) — dataA "Hit Points Gained" = 15, allies only, never a mechanical unit.
{
  const caster = unit({ id: 1, team: 0 });
  const ally = unit({ id: 2, team: 0 });
  const golem = unit({ id: 3, team: 0, mechanical: true });
  const foe = unit({ id: 4, team: 1 });
  {
    const { api, log } = harness([caster, ally]);
    SPELL_HANDLERS.Anhe(api, caster, def({ data: [15] }), 1, { targetId: 2, x: 0, y: 0 });
    check("creep Heal restores dataA to an ally", log.heals, [{ id: 2, amount: 15 }]);
  }
  {
    const { api, log } = harness([caster, golem]);
    SPELL_HANDLERS.Anhe(api, caster, def({ data: [15] }), 1, { targetId: 3, x: 0, y: 0 });
    check("…but not a mechanical one", log.heals, []);
  }
  {
    const { api, log } = harness([caster, foe]);
    SPELL_HANDLERS.Anhe(api, caster, def({ data: [15] }), 1, { targetId: 4, x: 0, y: 0 });
    check("…nor an enemy", log.heals, []);
  }
}

// Rejuvenation — dataA hp ACROSS the duration (400 over 12s), dataB mana likewise.
{
  const caster = unit({ id: 1, team: 0 });
  const ally = unit({ id: 2, team: 0 });
  const { api, log } = harness([caster, ally]);
  SPELL_HANDLERS.Arej(api, caster, def({ data: [400, 0], duration: 12 }), 1, { targetId: 2, x: 0, y: 0 });
  check("Rejuvenation is a hot at dataA/duration", [log.buffs[0].kind, round(log.buffs[0].value)], ["hot", round(400 / 12)]);
  check("…with no mana half when dataB is 0", log.buffs.length, 1);
}
{
  const caster = unit({ id: 1, team: 0 });
  const ally = unit({ id: 2, team: 0 });
  const { api, log } = harness([caster, ally]);
  SPELL_HANDLERS.Arej(api, caster, def({ data: [400, 120], duration: 12 }), 1, { targetId: 2, x: 0, y: 0 });
  check("…and a manaRegen half when it isn't", log.buffs.map((b) => [b.kind, round(b.value)]), [["hot", round(400 / 12)], ["manaRegen", 10]]);
}

// Cripple — dataA move slow, dataB attack slow, dataC "Damage Reduction" as a NEGATIVE
// damagePct. That third column is what makes it more than a Slow.
{
  const caster = unit({ id: 1, team: 0 });
  const foe = unit({ id: 2, team: 1 });
  const { api, log } = harness([caster, foe]);
  SPELL_HANDLERS.Acri(api, caster, def({ data: [0.75, 0.5, 0.5], duration: 60 }), 1, { targetId: 2, x: 0, y: 0 });
  check("Cripple slows move by dataA and attack by dataB", [log.buffs[0].kind, log.buffs[0].value, log.buffs[0].value2], ["slow", 0.75, 0.5]);
  check("…and cuts the target's damage by dataC", [log.buffs[1].kind, log.buffs[1].value], ["damagePct", -0.5]);
}

// Faerie Fire — dataA "Defense Reduction" = 4, i.e. a negative armour buff.
{
  const caster = unit({ id: 1, team: 0 });
  const foe = unit({ id: 2, team: 1 });
  const { api, log } = harness([caster, foe]);
  SPELL_HANDLERS.Afae(api, caster, def({ data: [4], duration: 90 }), 1, { targetId: 2, x: 0, y: 0 });
  check("Faerie Fire is negative armour of dataA", [log.buffs[0].kind, log.buffs[0].value], ["armor", -4]);
}

// Unholy Frenzy — dataA attack speed, dataB damage per second paid by the target.
{
  const caster = unit({ id: 1, team: 0 });
  const ally = unit({ id: 2, team: 0 });
  const { api, log } = harness([caster, ally]);
  SPELL_HANDLERS.Auhf(api, caster, def({ data: [0.75, 4], duration: 45 }), 1, { targetId: 2, x: 0, y: 0 });
  check("Unholy Frenzy hastes ATTACK only (value2), not movement", [log.buffs[0].kind, log.buffs[0].value, log.buffs[0].value2], ["haste", 0, 0.75]);
  check("…and bleeds the target for dataB per second", [log.buffs[1].kind, log.buffs[1].value], ["dot", 4]);
}

// Abolish Magic — a single-target Dispel Magic. dataB "Summoned Unit Damage" (300) lands
// only on a summon; dataA "Mana Loss" is 0 on every stock row.
{
  const caster = unit({ id: 1, team: 0 });
  const foe = unit({ id: 2, team: 1, summonLeft: 0 });
  const summon = unit({ id: 3, team: 1, summonLeft: 30 });
  {
    const { api, log } = harness([caster, foe]);
    let dispelled = 0;
    api.dispel = () => dispelled++;
    SPELL_HANDLERS.Aadm(api, caster, def({ data: [0, 300, 1] }), 1, { targetId: 2, x: 0, y: 0 });
    check("Abolish Magic dispels its target", dispelled, 1);
    check("…and does not damage a non-summon", log.damage, []);
  }
  {
    const { api, log } = harness([caster, summon]);
    api.dispel = () => {};
    SPELL_HANDLERS.Aadm(api, caster, def({ data: [0, 300, 1] }), 1, { targetId: 3, x: 0, y: 0 });
    check("…but a summon takes dataB", log.damage, [{ id: 3, amount: 300 }]);
  }
}

// Kaboom! — two concentric rings, and no allegiance filter: the sapper's own escort is hit.
{
  const sapper = unit({ id: 1, team: 0, x: 0, y: 0 });
  const inner = unit({ id: 2, team: 1, x: 50, y: 0 }); // inside the 100 full radius
  const outer = unit({ id: 3, team: 1, x: 200, y: 0 }); // inside the 250 partial radius
  const escort = unit({ id: 4, team: 0, x: 60, y: 0 }); // FRIENDLY, and inside the blast
  const { api, log } = harness([sapper, inner, outer, escort]);
  let died = 0;
  api.killUnit = () => died++;
  SPELL_HANDLERS.Asds(api, sapper, def({ data: [100, 250, 250, 100, 100] }), 1, { targetId: 2, x: 0, y: 0 });
  check("Kaboom! deals dataB inside dataA and dataD beyond it", log.damage, [
    { id: 2, amount: 250 }, { id: 3, amount: 100 }, { id: 4, amount: 250 },
  ]);
  check("…and the sapper dies", died, 1);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
