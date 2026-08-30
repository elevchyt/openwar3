// Headless check of the Computer+ CASTER's two decisions that are not pure arithmetic
// (src/ai/plus/casting.ts): which HALF of a polarity spell a target is, and whether this fight
// is worth offensive mana at all.
//
// Both were reported behaviours rather than theory:
//
//   1. *"the Undead AI must use the Death Coil both for damage but also for restoring health on
//      friendly/allied undead units"* and *"the Human AI must use the paladin's Holy Light on
//      allied players' units as well"*. Neither worked, and for one reason: `friendlySpell` reads
//      the `targs1` flags and **neither row carries an allegiance flag** — the engine hardcodes
//      the rule instead (`POLARITY_SPELLS`, sim/spells.ts). So both spells were pooled against
//      the ENEMY list alone and neither had a healing half at all.
//   2. *"lower the chances of casting nuke-type/offensive spells … it feels like the AI is
//      spending too much mana on small creep camps"*.
//
// Driven through `PlusCaster.pass` with a stub world, because what is being pinned is the POOL
// and the roll — neither of which is visible from the pure functions.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { PlusCaster } = require(join(REPO, ".sim-build", "src", "ai", "plus", "casting.js"));
const { PLUS_NORMAL, PLUS_INSANE } = require(join(REPO, ".sim-build", "src", "ai", "plus", "profile.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// The two mirror rows. `castRange` and the ranks are the game's; what matters here is that both
// are `target: "unit"` with no allegiance flag in `targetFlags`, which is the fact that broke
// them (`friendlySpell` answers false for both).
const lvl = (o = {}) => ({ area: 0, castRange: 800, duration: 0, heroDuration: 0, data: [200, NaN], buffs: [], summon: "", ...o });
const ABILS = {
  AHhb: { code: "AHhb", target: "unit", autocast: false, targetFlags: ["air", "ground", "organic", "notself", "vuln", "invu", "nonancient"], levelData: [lvl()] },
  AUdc: { code: "AUdc", target: "unit", autocast: false, targetFlags: ["air", "ground", "organic", "notself", "vuln", "invu", "nonancient"], levelData: [lvl()] },
  // A plain single-target nuke, for the mana gate: Storm Bolt is a `disable`, Frost Nova a `nuke`.
  AHtb: { code: "AHtb", target: "unit", autocast: false, targetFlags: ["air", "ground", "enemy", "organic", "vuln", "invu"], levelData: [lvl({ duration: 5, heroDuration: 1.5 })] },
};

let nextId = 1;
const unit = (o = {}) => ({
  id: nextId++, owner: 0, x: 0, y: 0, radius: 16, hp: 1000, maxHp: 1000, mana: 300, maxMana: 300,
  isHero: false, isPeon: false, isCreep: false, isSummon: false, isIllusion: false, building: null,
  paused: false, stunned: false, silenced: false, morphT: 0, order: "", constructing: false,
  repair: false, immolation: false, altModel: false, altFormLeft: 0, cloaked: false, level: 1,
  race: "human", weapon: null, weapons: [], abilities: [], buffs: [], inventory: [], speed: 270,
  targetId: 0, ...o,
});
const caster = (o = {}) => unit({ isHero: true, abilities: [{ id: o.abilId ?? "AHhb", code: o.abilId ?? "AHhb", level: 1, cooldownLeft: 0, autocastOn: false }], ...o });

/**
 * Drive one caster pass and report the `cast` command it produced.
 *
 * `castError` is the sim's own door and this stub answers it the way the sim does — including
 * the polarity rule, which is the whole point: a Paladin may touch a friendly LIVING unit or an
 * enemy UNDEAD one, and a Death Knight the mirror of that.
 */
function cast(units, profile = PLUS_INSANE, opts = {}) {
  const orders = [];
  const POLARITY = { AHhb: false, AUdc: true }; // healsUndead
  const world = {
    units: new Map(units.map((u) => [u.id, u])),
    techMeets: () => true,
    castUseError: () => null,
    targsAdmit: () => true,
    castError: (casterId, code, targetId) => {
      const t = units.find((u) => u.id === targetId);
      if (!t) return "notarget";
      const healsUndead = POLARITY[code];
      if (healsUndead === undefined) return t.owner === 0 ? "mustargetenemy" : null;
      const undead = t.race === "undead";
      const friendly = t.owner === 0 || t.owner === 2; // 2 is our ally — see `allied` below
      if (friendly ? undead !== healsUndead : undead === healsUndead) return "polarity";
      // A heal with nothing to heal is refused, never wasted — WC3's own `HPmaxed`.
      if (friendly && t.hp >= t.maxHp) return "HPmaxed";
      return null;
    },
  };
  const rolls = opts.rolls ? [...opts.rolls] : null;
  const c = new PlusCaster({
    world, player: 0,
    def: (id) => ABILS[id],
    hostile: (u) => u.owner === 1,
    allied: (u) => u.owner === 2,
    order: (cmd) => { orders.push(cmd); return true; },
  }, profile, () => (rolls && rolls.length ? rolls.shift() : (opts.roll ?? 0)));
  c.pass(opts.now ?? 100, { holdsPortal: () => false, home: { x: 0, y: 0 } });
  return orders.find((o) => o.c === "cast") ?? null;
}

// ==========================================================================================
console.log("\n-- Holy Light and Death Coil are two spells on one button ---------------------");
// ==========================================================================================
{
  // THE HEALING HALF, which did not exist. A Paladin beside a hurt Footman of his own.
  const p = caster({ abilId: "AHhb" });
  const hurt = unit({ hp: 400, x: 200 });
  const cmd = cast([p, hurt]);
  check("a Paladin heals his own hurt Footman", cmd && cmd.code, "AHhb");
  check("…aimed at it", cmd && cmd.targetId, hurt.id);
}
{
  // …AND AN ALLY'S. `castError` never minded — the polarity rule asks about allegiance, not
  // ownership — so the only thing that stopped it was the caster's own pool.
  const p = caster({ abilId: "AHhb" });
  const ally = unit({ owner: 2, hp: 400, x: 200 });
  const cmd = cast([p, ally]);
  check("…and an ALLIED player's hurt Footman too", cmd && cmd.targetId, ally.id);
}
{
  // HEROES FIRST. `bodyValue` prices a healthy hero at barely more than a soldier — the
  // anti-chase rule — and read as-is that says heal the Footman before your own Archmage.
  const p = caster({ abilId: "AHhb", x: -200 });
  // A Footman, so `maxMana` 0 — the ladder prices anything with a mana bar as a CASTER (2.5)
  // and that is a different comparison from the one being pinned here.
  const soldier = unit({ hp: 400, maxMana: 0, x: 200 });
  const mage = unit({ hp: 450, maxHp: 1000, isHero: true, x: 100 });
  const cmd = cast([p, soldier, mage]);
  check("…and the HERO before the soldier at the same sort of health", cmd && cmd.targetId, mage.id);
}
{
  // The SMITING half still works, and it is still the enemy Undead only.
  const p = caster({ abilId: "AHhb" });
  const ghoul = unit({ owner: 1, race: "undead", hp: 300, x: 200 });
  const cmd = cast([p, ghoul]);
  check("…and it still smites an enemy Ghoul", cmd && cmd.targetId, ghoul.id);
}
{
  // A COPY IS NOT SOMEBODY TO HEAL: it deals no damage, arrives whole and is meant to die.
  const p = caster({ abilId: "AHhb" });
  const copy = unit({ hp: 400, x: 200, isIllusion: true });
  check("…and never an illusion of one", cast([p, copy]), null);
}

// --- Death Coil, the mirror ---------------------------------------------------------------
{
  // THE 30% BAR, the developer's own number. `AUdc`'s other half is the undead's opening nuke,
  // so a coil poured into a scratch is a burst that was going to finish something.
  const dk = caster({ abilId: "AUdc", race: "undead" });
  const ghoul = unit({ race: "undead", hp: 250, x: 200 }); // a quarter — under COIL_HEAL_HP
  const cmd = cast([dk, ghoul]);
  check("a Death Knight coils a friendly Ghoul at a quarter health", cmd && cmd.targetId, ghoul.id);
}
{
  const dk = caster({ abilId: "AUdc", race: "undead" });
  const scratched = unit({ race: "undead", hp: 600, x: 200 }); // 60% — hurt, but not 30%
  check("…and not one at 60%, which an ordinary heal would take", cast([dk, scratched]), null);
}
{
  // …and an ALLIED undead player's, for the same reason a Paladin reaches an ally's Footman.
  const dk = caster({ abilId: "AUdc", race: "undead" });
  const ally = unit({ owner: 2, race: "undead", hp: 250, x: 200 });
  check("…an ally's Ghoul counts", cast([dk, ally]) && cast([dk, ally]).targetId, ally.id);
}
{
  // THE HEAL OUTBIDS THE NUKE. Both halves are legal here and the two are scored on different
  // ladders, so without `POLARITY_HEAL_FIRST` the coil goes into the enemy standing in front.
  const dk = caster({ abilId: "AUdc", race: "undead" });
  const dying = unit({ race: "undead", hp: 200, x: 200 });
  const foe = unit({ owner: 1, hp: 400, x: -200 });
  const cmd = cast([dk, dying, foe]);
  check("a body worth saving outbids a body worth hurting", cmd && cmd.targetId, dying.id);
}
{
  // …and with nobody to save, it is a nuke as it always was.
  const dk = caster({ abilId: "AUdc", race: "undead" });
  const foe = unit({ owner: 1, hp: 400, x: 200 });
  const cmd = cast([dk, foe]);
  check("…and it still burns an enemy living unit", cmd && cmd.targetId, foe.id);
}

// ==========================================================================================
console.log("\n-- a fight has to be worth the mana ------------------------------------------");
// ==========================================================================================

// The roll is made ONCE PER ENGAGEMENT (`worthTheMana`), and a roll at or above the chance is a
// refusal. Against a small creep camp the chance is CREEP_SPELL_SMALL (0.25).
{
  const mk = () => caster({ abilId: "AHtb" });
  const creeps = () => [unit({ owner: 1, isCreep: true, x: 200 }), unit({ owner: 1, isCreep: true, x: 250 })];
  check("two creeps and an unlucky roll: the hammer stays on the belt",
    cast([mk(), ...creeps()], PLUS_INSANE, { roll: 0.9 }), null);
  const cmd = cast([mk(), ...creeps()], PLUS_INSANE, { roll: 0.1 });
  check("…and a lucky one spends it", cmd && cmd.code, "AHtb");
}
{
  // A BIG camp is worth it far more often — CREEP_SPELL_BIG (0.7) from four bodies up.
  const big = [1, 2, 3, 4, 5].map((i) => unit({ owner: 1, isCreep: true, x: 150 + 20 * i }));
  const cmd = cast([caster({ abilId: "AHtb" }), ...big], PLUS_INSANE, { roll: 0.5 });
  check("a five-body camp is worth it at a roll a small one is not", cmd && cmd.code, "AHtb");
}
{
  // AGAINST A PLAYER IT IS ALWAYS YES: a spell held back in the fight that decides the game is
  // wasted far more expensively than one thrown at a Gnoll.
  const cmd = cast([caster({ abilId: "AHtb" }), unit({ owner: 1, x: 200 })], PLUS_INSANE, { roll: 0.99 });
  check("…and against a player's soldier the roll never matters", cmd && cmd.code, "AHtb");
}
{
  // DEATH COIL NEEDS THE RULE STATED TWICE. The card is graded `heal` and a heal is never held
  // back, so the gate in `ready` cannot see it — the same test is applied to its nuke half in
  // `pickTarget`, or the one nuke the report named first is the one the rule misses.
  const dk = caster({ abilId: "AUdc", race: "undead" });
  const creeps = [unit({ owner: 1, isCreep: true, x: 200 }), unit({ owner: 1, isCreep: true, x: 250 })];
  check("Death Coil's nuke half is gated like every other nuke",
    cast([dk, ...creeps], PLUS_INSANE, { roll: 0.9 }), null);
  // …and its HEALING half is not: a heal is an answer to something that has already happened.
  const dk2 = caster({ abilId: "AUdc", race: "undead" });
  const dying = unit({ race: "undead", hp: 200, x: 200 });
  const cmd = cast([dk2, dying, ...creeps.map((c) => unit({ ...c, id: nextId++ }))], PLUS_INSANE, { roll: 0.9 });
  check("…and its healing half is never held back", cmd && cmd.targetId, dying.id);
}
{
  // A HEAL is never gated either, on the ordinary polarity spell.
  const p = caster({ abilId: "AHhb" });
  const hurt = unit({ hp: 400, x: 200 });
  const cmd = cast([p, hurt, unit({ owner: 1, isCreep: true, x: 250 })], PLUS_NORMAL, { roll: 0.99 });
  check("Holy Light is not held back by the mana gate", cmd && cmd.targetId, hurt.id);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
