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
// The REAL Targets Allowed predicate (src/sim/targeting.ts), not a stub of it — a spell's
// target sweep is filtered by its own `targs1`, so the tests must read the same table.
const { targsAdmit } = require(join(REPO, ".sim-build", "src", "sim", "targeting.js"));

/** An AbilityDef with just the fields a handler reads. `data` is dataA..dataI. */
function def(over = {}) {
  const { data = [], duration = 0, area = 0, ...rest } = over;
  return {
    id: "TEST", code: "TEST", missileArt: "", missileSpeed: 0, targetArt: "", casterArt: "", specialArt: "",
    effectArt: "", areaArt: "", buffArt: "", buffFx: [], buffEffectArt: "", buffSpecialArt: "", lightning: [],
    levelData: [{ cost: 0, cooldown: 0, duration, heroDuration: duration, castRange: 0, area, castTime: 0, data, buffs: [], summon: "" }],
    ...rest,
  };
}

function unit(over = {}) {
  return { id: 1, owner: 0, team: 0, hp: 500, maxHp: 1000, mana: 0, maxMana: 300, x: 0, y: 0, flying: false, building: null, mechanical: false, isHero: false, ...over };
}

/** Records what the handler did instead of touching a world. */
function harness(units) {
  const log = { buffs: [], damage: [], heals: [], effects: [], bolts: [], boltStops: [], waves: [], transmutes: [] };
  const api = {
    rng: () => 0.5,
    getUnit: (id) => units.find((u) => u.id === id),
    unitsInArea: () => units,
    hostile: (a, b) => a.team !== b.team,
    ally: (a, b) => a.team === b.team,
    admits: (d, t) => targsAdmit(t, d.targetFlags),
    // The wave launch: records the request the way the world would act on it, and answers
    // false for a row with no Missileart so the artless fallback can be tested too.
    launchWave: (c, d, rank, o) => {
      if (!d.missileArt && !(o.trail && o.trail.art)) return false;
      log.waves.push({ art: d.missileArt, speed: o.speed || d.missileSpeed, from: c.id, tx: o.tx, ty: o.ty,
        dist: o.dist, halfWidth: o.halfWidth, budget: o.budget, ...(o.trail ? { trail: o.trail } : {}) });
      return true;
    },
    spellDamage: (t, amount) => log.damage.push({ id: t.id, amount }),
    spellHeal: (t, amount) => log.heals.push({ id: t.id, amount }),
    applyBuff: (t, b) => log.buffs.push({ id: t.id, kind: b.kind, group: b.group, value: b.value, value2: b.value2, timeLeft: b.timeLeft, art: b.art }),
    emitEffect: (art) => log.effects.push(art),
    emitLightning: (id, from, to, life = 0, delay = 0, tag) => log.bolts.push({ id, from: from.id, to: to.id, life: round(life), delay: round(delay), ...(tag ? { tag } : {}) }),
    stopLightning: (tag) => log.boltStops.push(tag),
    // The buff-model lookup a handler makes when its ability lists several buff rows and
    // picks between them (the Drain's caster/target x life/mana grid). The stub returns the
    // id itself as the "path" so a test can assert WHICH row was chosen.
    buffFxOf: (buffId) => (buffId ? [{ path: buffId, attach: [] }] : []),
    dispel: () => {}, emitSplat: () => {}, summon: () => {}, killUnit: () => {},
    transmute: (t, c, goldFactor, lumberFactor) => { log.transmutes.push({ id: t.id, by: c.id, goldFactor, lumberFactor }); return 0; },
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
  // …while dataA/dataB ARE read — as what they are named, the AFOD bolt's "Graphic Delay"
  // and "Graphic Duration" (issue #97).
  const { api: api2, log: log2 } = harness([caster, foe]);
  SPELL_HANDLERS.ANfd(api2, caster, def({ data: [0.25, 1, 500], lightning: ["AFOD"] }), 1, { targetId: 2, x: 0, y: 0 });
  check("…and strikes with its AFOD bolt on dataA/dataB's timing", log2.bolts, [{ id: "AFOD", from: 1, to: 2, life: 1, delay: 0.25 }]);
}

// Lightning effects (issue #97) — the bolt art these abilities use INSTEAD of an effect
// model, taken off the ability's own `LightningEffect` list.
{
  const caster = unit({ id: 1, team: 0 });
  const a = unit({ id: 2, team: 1 });
  const b = unit({ id: 3, team: 1 });
  const c = unit({ id: 4, team: 1 });
  {
    // Chain Lightning: CLPB caster→first, CLSB down the rest, one bounce apart.
    const { api, log } = harness([caster, a, b, c]);
    SPELL_HANDLERS.AOcl(api, caster, def({ data: [85, 3, 0.15], area: 500, lightning: ["CLPB", "CLSB"] }), 1, { targetId: 2, x: 0, y: 0 });
    check("Chain Lightning strings CLPB then CLSB, staggered by bounce", log.bolts, [
      { id: "CLPB", from: 1, to: 2, life: 0, delay: 0 },
      { id: "CLSB", from: 2, to: 3, life: 0, delay: 0.15 },
      { id: "CLSB", from: 3, to: 4, life: 0, delay: 0.3 },
    ]);
  }
  {
    // Forked Lightning: cast ON A UNIT (NeutralAbilityStrings [ANfl]: "a cone of lightning
    // on a target enemy unit"), one FORK bolt per target, all at once. The aimed unit is
    // always in the fan; the rest is whoever the cone sweeps on the way, dataC (900) long
    // and `Area1` (125) to either side — so the unit standing 400 off the axis is missed.
    const near = unit({ id: 2, team: 1, x: 300, y: 0, radius: 0 });
    const behind = unit({ id: 3, team: 1, x: 700, y: 0, radius: 0 });
    const aside = unit({ id: 4, team: 1, x: 300, y: 400, radius: 0 });
    const { api, log } = harness([caster, near, behind, aside]);
    SPELL_HANDLERS.ANfl(api, caster, def({ data: [85, 3, 900], area: 125, lightning: ["FORK"] }), 1, { targetId: 2, x: 0, y: 0 });
    check("Forked Lightning forks from the AIMED unit down the cone", log.bolts.map((l) => `${l.id}:${l.to}`), ["FORK:2", "FORK:3"]);
    // …and with no unit aimed at, nothing happens: there is no point to cast it at.
    const bare = harness([caster, near, behind, aside]);
    SPELL_HANDLERS.ANfl(bare.api, caster, def({ data: [85, 3, 900], area: 125, lightning: ["FORK"] }), 1, { targetId: 0, x: 300, y: 0 });
    check("Forked Lightning aimed at bare ground does nothing", bare.log.bolts, []);
  }
  {
    // Drain: `LightningEffect=DRAB,DRAL,DRAM` and dataA/dataB (life/mana per second) pick
    // which — the Dark Ranger's Drain takes life, so DRAL, for the drain's whole duration.
    // The tether is tagged with its caster so an interrupted channel can cut it.
    const { api, log } = harness([caster, a]);
    SPELL_HANDLERS.AHdr(api, caster, def({ data: [25, 0], duration: 8, lightning: ["DRAB", "DRAL", "DRAM"] }), 1, { targetId: 2, x: 0, y: 0 });
    check("a life Drain tethers with DRAL for the duration", log.bolts, [{ id: "DRAL", from: 1, to: 2, life: 8, delay: 0, tag: "drain:1" }]);
    // …and the buff ART follows the same two axes: the VICTIM wears the target row, the
    // caster the caster row, each in the life flavour (Bdtl / Bdcl).
    check("…the victim wears Bdtl and the caster Bdcl", log.buffs.map((b) => `${b.id}:${b.kind}:${b.art}`), ["2:dot:Bdtl", "1:hot:Bdcl"]);
  }
  {
    // …and the Blood Mage's Siphon Mana takes mana, so DRAM — and the MANA buff rows, which
    // is the bug the green life-drain swirl on a mana drain's victim came from.
    const { api, log } = harness([caster, a]);
    SPELL_HANDLERS.AHdr(api, caster, def({ data: [0, 15], duration: 6, lightning: ["DRAB", "DRAL", "DRAM"] }), 1, { targetId: 2, x: 0, y: 0 });
    check("…a mana Drain with DRAM", log.bolts, [{ id: "DRAM", from: 1, to: 2, life: 6, delay: 0, tag: "drain:1" }]);
    check("…and the mana buff rows Bdtm / Bdcm", log.buffs.map((b) => b.art), ["Bdtm", "Bdcm"]);
    check("…moving mana rather than health", log.buffs.map((b) => `${b.id}:${b.kind}:${b.value}`), ["2:manaRegen:-15", "1:manaRegen:15"]);
  }
  {
    // An ability that takes both drains BOTH — a life pair and a mana pair — and gets the
    // combined beam. Only the life pair wears the art: one set of models, not two.
    const { api, log } = harness([caster, a]);
    SPELL_HANDLERS.AHdr(api, caster, def({ data: [10, 10], duration: 6, lightning: ["DRAB", "DRAL", "DRAM"] }), 1, { targetId: 2, x: 0, y: 0 });
    check("…and one that takes both with DRAB", log.bolts, [{ id: "DRAB", from: 1, to: 2, life: 6, delay: 0, tag: "drain:1" }]);
    check("…draining life and mana at once", log.buffs.map((b) => `${b.id}:${b.kind}:${b.value}`), ["2:dot:10", "1:hot:10", "2:manaRegen:-10", "1:manaRegen:10"]);
    check("…wearing Bdtb / Bdcb, once", log.buffs.map((b) => b.art).filter(Boolean), ["Bdtb", "Bdcb"]);
  }
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

// Cannibalize — a corpse is worth dataA hp/sec for the duration, and NOTHING happens with
// no corpse to eat (the whole ability is the meal).
{
  const ghoul = unit({ id: 1, team: 0 });
  {
    const { api, log } = harness([ghoul]);
    api.consumeCorpse = () => true; // a body is under his feet
    SPELL_HANDLERS.Acan(api, ghoul, def({ data: [10, 800], duration: 33 }), 1, { targetId: 0, x: 0, y: 0 });
    check("Cannibalize regenerates at dataA per second", [log.buffs[0].kind, log.buffs[0].value, log.buffs[0].timeLeft], ["hot", 10, 33]);
  }
  {
    const { api, log } = harness([ghoul]);
    let asked = 0;
    api.consumeCorpse = () => { asked++; return false; }; // nothing to eat
    SPELL_HANDLERS.Acan(api, ghoul, def({ data: [10, 800], duration: 33 }), 1, { targetId: 0, x: 0, y: 0 });
    check("…and grants nothing without a corpse", log.buffs, []);
    check("…having looked for one first", asked, 1);
  }
}

// The WAVE family (Shock Wave, Carrion Swarm, Breath of Fire): their Missileart IS the
// spell, so the cast launches a travelling front and each unit is struck as the front
// reaches it, rather than everything at once. Real rows: `[AOsh] Missileart =
// ShockwaveMissile.mdl, Missilespeed = 1050`; DataC 800 distance, Area 125 width.
{
  const caster = unit({ id: 1, team: 0, radius: 0 });
  const foe = unit({ id: 2, team: 1, x: 400, y: 0, radius: 0 });
  const shockwave = (over = {}) => def({ data: [75, 900, 800], area: 125, missileArt: "ShockwaveMissile", missileSpeed: 1050, ...over });
  {
    const { api, log } = harness([caster, foe]);
    SPELL_HANDLERS.AOsh(api, caster, shockwave(), 1, { targetId: 0, x: 800, y: 0 });
    check("the cast launches the wave, and damages nobody yet", log.damage, []);
    check("…at the row's own speed, dataC far, `Area` wide", log.waves, [
      { art: "ShockwaveMissile", speed: 1050, from: 1, tx: 800, ty: 0, dist: 800, halfWidth: 125, budget: 900 },
    ]);
  }
  {
    // …and the world re-enters the handler per unit as the front arrives.
    const { api, log } = harness([caster, foe]);
    SPELL_HANDLERS.AOsh(api, caster, shockwave(), 1, { targetId: 2, x: 400, y: 0, wave: { budget: 900 } });
    check("the front reaching a unit deals dataA to it", log.damage, [{ id: 2, amount: 75 }]);
    check("…and launches nothing further", log.waves, []);
  }
  {
    // A row stripped of its Missileart (a custom map may) falls back to the instant sweep.
    const { api, log } = harness([caster, foe]);
    SPELL_HANDLERS.AOsh(api, caster, shockwave({ missileArt: "", missileSpeed: 0 }), 1, { targetId: 0, x: 800, y: 0 });
    check("with no missile in the row, the line is swept at once", log.damage, [{ id: 2, amount: 75 }]);
  }
  {
    // Carrion Swarm spends a dataB TOTAL-damage budget as the swarm passes, and each unit
    // it bites wears the Specialart (`CarrionSwarmDamage.mdl`).
    const swarm = def({ data: [75, 100, 800], area: 100, missileArt: "CarrionSwarmMissile", missileSpeed: 1100, specialArt: "CarrionSwarmDamage" });
    const { api, log } = harness([caster, foe]);
    const wave = { budget: 100 };
    SPELL_HANDLERS.AUcs(api, caster, swarm, 1, { targetId: 2, x: 400, y: 0, wave });
    check("Carrion Swarm bites for dataA…", log.damage, [{ id: 2, amount: 75 }]);
    check("…spending the wave's shared budget", wave.budget, 25);
    check("…and marks the victim with its Specialart", log.effects, ["CarrionSwarmDamage"]);
    // The next unit gets only what is left of the budget, and the one after that nothing.
    SPELL_HANDLERS.AUcs(api, caster, swarm, 1, { targetId: 2, x: 400, y: 0, wave });
    SPELL_HANDLERS.AUcs(api, caster, swarm, 1, { targetId: 2, x: 400, y: 0, wave });
    check("…then the tail of the swarm has nothing left to give", log.damage.map((d) => d.amount), [75, 25]);
  }
}

// Impale is the one wave whose art is not a missile. `[AUim]` names no Missileart at all,
// only `Specialart = ImpaleMissTarget.mdl` — one tendril — so the wave lays a TRAIL of them
// down the line. Its columns are the game's own (UI\WorldEditStrings.txt): `Uim1` Wave
// Distance 600, `Uim2` Wave Time 0.3s, `Uim3` Damage Dealt 75, `Uim4` Air Time 1s.
{
  const caster = unit({ id: 1, team: 0, radius: 0 });
  const foe = unit({ id: 2, team: 1, x: 300, y: 0, radius: 0 });
  const impale = def({ data: [600, 0.3, 75, 1], area: 250, duration: 2, specialArt: "ImpaleMissTarget" });
  {
    const { api, log } = harness([caster, foe]);
    SPELL_HANDLERS.AUim(api, caster, impale, 1, { targetId: 0, x: 600, y: 0 });
    check("Impale launches a trail wave, not a missile", log.waves, [
      { art: "", speed: 2000, from: 1, tx: 600, ty: 0, dist: 600, halfWidth: 125, budget: undefined,
        trail: { art: "ImpaleMissTarget", step: 125 } },
    ]);
    check("…preceded by the Crypt Lord's own slam", log.effects, ["Abilities\\Spells\\Undead\\Impale\\ImpaleCaster.mdx"]);
    check("…and nothing is damaged at the cast", log.damage, []);
  }
  {
    // The front reaching a unit: dataC damage, the stun, and the tendril that CAUGHT it.
    const { api, log } = harness([caster, foe]);
    SPELL_HANDLERS.AUim(api, caster, impale, 1, { targetId: 2, x: 300, y: 0, wave: { budget: 0 } });
    check("a unit the tendrils reach takes dataC", log.damage, [{ id: 2, amount: 75 }]);
    check("…and is stunned for the row's duration", [log.buffs[0].kind, log.buffs[0].timeLeft], ["stun", 2]);
    check("…and wears the hit tendril, not the miss one", log.effects, ["Abilities\\Spells\\Undead\\Impale\\ImpaleHitTarget.mdx"]);
  }
  {
    // Air units are not impaled — the ground is what erupts (targs1 `ground,…`).
    const flyer = unit({ id: 3, team: 1, x: 300, y: 0, radius: 0, flying: true });
    const { api, log } = harness([caster, flyer]);
    SPELL_HANDLERS.AUim(api, caster, impale, 1, { targetId: 3, x: 300, y: 0, wave: { budget: 0 } });
    check("a flyer is passed under", log.damage, []);
  }
}

// Transmute — `[ANtm]` is the one spell whose whole effect is a transaction, and the row
// carries the price as a pair of `unreal` factors on what the victim COST:
//   Ntm1 (DataA) = 1.25   × its gold cost      Ntm2 (DataB) = 0   × its lumber cost
// (Ntm3 = 5 is the creep level it refuses above, enforced at the order rather than here.)
// The World Editor's names for these fields live in strings the install does not ship, so
// the reading is checked against the numbers players quote — `goldcost × 1.25` rounded: a
// Footman (135) pays 169, a Rifleman (205) 256, a Knight (245) 306.
{
  const caster = unit({ id: 1, team: 0 });
  const foe = unit({ id: 2, team: 1 });
  const { api, log } = harness([caster, foe]);
  SPELL_HANDLERS.ANtm(api, caster, def({ code: "ANtm", data: [1.25, 0, 5, 1] }), 1, { targetId: 2, x: 0, y: 0 });
  check("Transmute melts the target down at the row's two factors", log.transmutes, [{ id: 2, by: 1, goldFactor: 1.25, lumberFactor: 0 }]);
  {
    // A HERO is refused by the row's own `nonhero` flag; the handler holds the line too.
    const hero = unit({ id: 3, team: 1, isHero: true });
    const { api: a2, log: l2 } = harness([caster, hero]);
    SPELL_HANDLERS.ANtm(a2, caster, def({ code: "ANtm", data: [1.25, 0, 5, 1] }), 1, { targetId: 3, x: 0, y: 0 });
    check("…and never a Hero", l2.transmutes, []);
  }
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
