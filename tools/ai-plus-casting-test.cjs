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
const { PLUS_EASY, PLUS_NORMAL, PLUS_INSANE } = require(join(REPO, ".sim-build", "src", "ai", "plus", "profile.js"));

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
const lvl = (o = {}) => ({ area: 0, castRange: 800, cost: 0, duration: 0, heroDuration: 0, data: [200, NaN], buffs: [], summon: "", ...o });
const ABILS = {
  AHhb: { code: "AHhb", target: "unit", autocast: false, targetFlags: ["air", "ground", "organic", "notself", "vuln", "invu", "nonancient"], levelData: [lvl()] },
  AUdc: { code: "AUdc", target: "unit", autocast: false, targetFlags: ["air", "ground", "organic", "notself", "vuln", "invu", "nonancient"], levelData: [lvl()] },
  // A plain single-target nuke, for the mana gate: Storm Bolt is a `disable`, Frost Nova a `nuke`.
  AHtb: { code: "AHtb", target: "unit", autocast: false, targetFlags: ["air", "ground", "enemy", "organic", "vuln", "invu"], levelData: [lvl({ duration: 5, heroDuration: 1.5 })] },
  // Unholy Frenzy — a BUFF whose row names no allegiance at all (`[Auhf] targs1` =
  // "air,ground,organic"), which is the whole of the reported bug: with the flags silent the
  // pool fell through to the enemy list and a Necromancer hasted the other player's army.
  Auhf: { code: "Auhf", target: "unit", autocast: false, targetFlags: ["air", "ground", "organic"], levelData: [lvl({ castRange: 500, duration: 45 })] },
  // Purge — `[Aprg] targs1` names no allegiance either, and it is a `disable` (its slow is
  // real), so its only gate was the target search: 75 mana at whatever stood nearest.
  Aprg: { code: "Aprg", target: "unit", autocast: false, targetFlags: ["air", "ground", "ward", "vuln", "invu", "tree"], levelData: [lvl({ castRange: 700, duration: 15 })] },
  // Dispel Magic — the AREA one, and the code Disenchant (`Adcn`) shares. Its handler clears
  // every unit inside the circle without asking allegiance, which is why the AI aims it at both
  // sides. `[Adis] Area1` 200, `Rng1` 600.
  Adis: { code: "Adis", target: "point", autocast: false, targetFlags: ["air", "ground", "ward", "invu", "vuln", "tree"], levelData: [lvl({ area: 200, castRange: 600 })] },
  // THE TWO WAVES, with their real rows — because the whole point of the section below is that
  // their Data columns are numbered DIFFERENTLY and reading one family's order off the other is
  // what silenced Impale. `Units\AbilityData.slk`, rank 1:
  //   [AOsh] Area1 125  Rng1 700  DataA 75 (damage)  DataB 900 (max damage)  DataC 800 (distance)
  //   [AUim] Area1 250  Rng1 700  DataA 600 (distance)  DataB 0.3 (wave time)  DataC 75 (damage)
  AOsh: { code: "AOsh", target: "point", autocast: false, targetFlags: ["ground", "structure"], levelData: [lvl({ area: 125, castRange: 700, data: [75, 900, 800] })] },
  AUim: { code: "AUim", target: "point", autocast: false, targetFlags: ["ground", "enemy", "neutral", "organic"], levelData: [lvl({ area: 250, castRange: 700, duration: 2, heroDuration: 2, data: [600, 0.3, 75] })] },
  // MANA BURN, with its real row: `[AEmb] targs1` "air,ground,enemy,neutral", `Rng1` 300,
  // `Cost1` 60, `Cool1` 7 and `DataA1` 50 — the rank a Demon Hunter has from hero level 1.
  AEmb: { code: "AEmb", target: "unit", autocast: false, targetFlags: ["air", "ground", "enemy", "neutral"], levelData: [lvl({ castRange: 300, cost: 60, data: [50, 0.25, 1] })] },
  // SUMMON WATER ELEMENTAL, with its real row — and every field of it matters here.
  // `Units\AbilityData.slk [AHwe]`: `targs1` "_" (no target at all), `Cost1` 125, `Cool1` 20,
  // `Dur1` 60, `UnitID1` hwat … and **`Area1` 200**, which is NOT an area of effect. It is the
  // radius the elemental is placed in around its caster. Reading it as one made the summon ask
  // for a QUORUM of two enemy bodies within 200 units of the Archmage — see `pickSpot`.
  // FORCE OF NATURE, with its real row. `Units\AbilityData.slk [AEfn]`: `targs1` **"tree"** and
  // nothing else, `Rng1` 800 to a spot, `Area1` 150/225/300 around it, `DataA` 2/3/4 trees
  // felled there with a Treant (`UnitID1` efon) standing in each hole, `Cost1` 100, `Dur1` 60.
  AEfn: { code: "AEfn", target: "point", autocast: false, targetFlags: ["tree"], levelData: [lvl({ area: 150, castRange: 800, cost: 100, duration: 60, heroDuration: 60, buffs: ["BEfn"], summon: "efon", data: [2, NaN] })] },
  AHwe: { code: "AHwe", target: "none", autocast: false, targetFlags: [], levelData: [lvl({ area: 200, castRange: 0, cost: 125, duration: 60, heroDuration: 60, buffs: ["BHwe"], summon: "hwat" })] },
};

let nextId = 1;
const unit = (o = {}) => ({
  id: nextId++, owner: 0, x: 0, y: 0, radius: 16, hp: 1000, maxHp: 1000, mana: 300, maxMana: 300,
  isHero: false, isPeon: false, isCreep: false, isSummon: false, isIllusion: false, building: null,
  paused: false, stunned: false, silenced: false, morphT: 0, order: "", constructing: false,
  repair: false, immolation: false, altModel: false, altFormLeft: 0, cloaked: false, level: 1,
  race: "human", weapon: null, weapons: [], abilities: [], buffs: [], inventory: [], speed: 270,
  // `team` is how the sim's own area effects tell the sides apart, and what `worthDispelling`
  // asks of a buff's SOURCE; seat 2 is our ally, so it shares ours. `summonLeft` > 0 is the
  // sim's own test for "a Purge would destroy this" (`Aprg` in sim/spells.ts).
  team: o.owner === 1 ? 1 : 0, summonLeft: 0,
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
    // The sim's own signature, PADDING included: `nearestTrees` hands back the nearest `limit`
    // trees whether or not they are inside `maxDist`, which is why every caller re-filters by
    // distance (`SimWorld.fellTrees` does, and so must `treeSpot`).
    nearestTrees: (x, y, maxDist, limit) => (opts.trees ?? [])
      .map((t, i) => ({ id: i + 1, x: t.x, y: t.y, lumber: 100, hp: 50, blockRadius: 64 }))
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))
      .slice(0, Math.max(1, limit)),
    techMeets: () => true,
    castUseError: () => null,
    targsAdmit: () => true,
    castError: (casterId, code, targetId) => {
      // A POINT cast carries no target id — `pickSpot` passes 0 and an (x, y). Nothing in the
      // stub's rules is about where the ground is, so the only answer it can give is yes.
      if (!targetId) return null;
      const t = units.find((u) => u.id === targetId);
      if (!t) return "notarget";
      // The sim's own `MANA_TARGET_SPELLS` gate (sim/spells.ts): "Unable to cast Mana Burn on
      // this target." is what a Footman gets — a pool of zero is the test, not an empty one.
      if (code === "AEmb" && t.maxMana <= 0) return "Cantmanaburn";
      const healsUndead = POLARITY[code];
      if (healsUndead === undefined) {
        // The sim's own rule (`targetAllowed`): a row that names no allegiance flag allows ANY
        // allegiance — which is exactly why a flagless buff could be cast at the enemy at all.
        const F = new Set((ABILS[code]?.targetFlags ?? []).map((f) => f.toLowerCase()));
        if (!F.has("enemy") && !F.has("friend")) return null;
        return t.owner === 0 ? "mustargetenemy" : null;
      }
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
  // `opts.passes` is for the REACTION DELAY alone (`PlusProfile.castDelay`): the fight is first
  // seen on the pass that starts it, so a difficulty that waits two and a half seconds cannot
  // cast on the pass that noticed. Ten seconds apart, and only the LAST pass's decision is
  // reported — one caster presses at most one button a pass.
  const t0 = opts.now ?? 100;
  for (let i = 0; i < (opts.passes ?? 1); i++) {
    if (i > 0) orders.length = 0;
    c.pass(t0 + i * 10, { holdsPortal: () => false, home: { x: 0, y: 0 } });
  }
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

// ==========================================================================================
console.log("\n-- a beneficial spell with no allegiance flag still goes on OUR side ----------");
// ==========================================================================================
// Reported: *"the Computer+ AI seems to like to cast Unholy Frenzy on enemy units"*. `[Auhf]
// targs1` is "air,ground,organic" — no allegiance flag — so `friendlySpell` answered false and
// the pool was the enemy list. What settles it when the data does not is the ROLE (`friendlyAim`).
{
  const n = caster({ abilId: "Auhf", race: "undead" });
  const ghoul = unit({ x: 200 });
  const foe = unit({ owner: 1, x: -200 }); // …and a fight, since a buff is pre-fight, not idle
  const cmd = cast([n, ghoul, foe]);
  check("Unholy Frenzy goes on our own Ghoul", cmd && cmd.code, "Auhf");
  check("…aimed at it, and never at the enemy", cmd && cmd.targetId, ghoul.id);
}
{
  const n = caster({ abilId: "Auhf", race: "undead" });
  const ally = unit({ owner: 2, x: 200 });
  const cmd = cast([n, ally, unit({ owner: 1, x: -200 })]);
  check("…an ALLY's unit counts as ours", cmd && cmd.targetId, ally.id);
}
{
  // …and with nobody of ours to buff, nothing is cast at all — which is the bug, stated the
  // other way round: the enemy in front of it is not a target for this button.
  const n = caster({ abilId: "Auhf", race: "undead" });
  check("…and with only enemies in reach it is not pressed", cast([n, unit({ owner: 1, x: 200 })]), null);
}

// ==========================================================================================
console.log("\n-- a Purge is spent on what a Purge does -------------------------------------");
// ==========================================================================================
// Reported: *"only use Purge against enemy Summoned units and enemy units that have positive
// buffs/effects"*. Both halves are read off the sim's own handler — `summonLeft > 0` is what it
// destroys, and a buff hung by the target's OWN side is what it strips (`worthDispelling`).
const shaman = () => unit({ owner: 1, x: -400 }); // whoever hung the buff, still standing
const theirBuff = (src) => ({ kind: "haste", group: "bloodlust", timeLeft: 45, sourceId: src.id, buffId: "Bblo" });
{
  const s = caster({ abilId: "Aprg" });
  check("a plain enemy soldier with nothing on it is not purged",
    cast([s, unit({ owner: 1, x: 200 })]), null);
}
{
  const s = caster({ abilId: "Aprg" });
  const wolf = unit({ owner: 1, x: 200, summonLeft: 30 });
  const cmd = cast([s, wolf, unit({ owner: 1, x: 250 })]);
  check("…a SUMMON is, because the purge deletes it", cmd && cmd.targetId, wolf.id);
}
{
  const s = caster({ abilId: "Aprg" });
  const src = shaman();
  const lusted = unit({ owner: 1, x: 200, buffs: [theirBuff(src)] });
  const cmd = cast([s, lusted, src, unit({ owner: 1, x: 250 })]);
  check("…and so is one their own side has Bloodlusted", cmd && cmd.targetId, lusted.id);
}
{
  // A buff WE hung is not a reason to purge: stripping it is doing their dispelling for them.
  const s = caster({ abilId: "Aprg" });
  const slowed = unit({ owner: 1, x: 200, buffs: [{ kind: "slow", group: "slow", timeLeft: 15, sourceId: 1, buffId: "Bslo" }] });
  check("…but our own slow on it is not", cast([s, slowed]), null);
}
{
  // An AURA is back the tick after the purge lands — `timeLeft` Infinity is what says so.
  const s = caster({ abilId: "Aprg" });
  const src = shaman();
  const aura = unit({ owner: 1, x: 200, buffs: [{ kind: "armor", group: "devotion", timeLeft: Infinity, sourceId: src.id, buffId: "Bdev" }] });
  check("…nor is an aura it is standing in", cast([s, aura, src]), null);
}
{
  // Doom cannot be dispelled by anything — `dispelUnit` keeps exactly the undispellable ones.
  const s = caster({ abilId: "Aprg" });
  const src = shaman();
  const doomed = unit({ owner: 1, x: 200, buffs: [{ kind: "dot", group: "doom", timeLeft: Infinity, sourceId: src.id, undispellable: true }] });
  check("…nor a Doom, which no dispel may touch", cast([s, doomed, src]), null);
}

// ==========================================================================================
console.log("\n-- …and the AREA dispels ask the same question, of both sides -----------------");
// ==========================================================================================
// Dispel Magic (`Adis`, which is also Disenchant `Adcn`'s code) clears every unit in its circle
// whichever side they are on, so the AI aims it at both — and one body worth dispelling is
// enough, which is the classic caster's own `count: 1`.
const spotOf = (cmd) => (cmd ? { x: cmd.x, y: cmd.y } : null);
{
  const p = caster({ abilId: "Adis" });
  const plain = [1, 2, 3].map((i) => unit({ owner: 1, x: 200 + 20 * i }));
  check("a pack with nothing on it is not worth a Dispel", cast([p, ...plain]), null);
}
{
  const p = caster({ abilId: "Adis" });
  const src = shaman();
  const lusted = unit({ owner: 1, x: 300, buffs: [theirBuff(src)] });
  check("…one Bloodlusted body in it is", spotOf(cast([p, lusted, src])), { x: 300, y: 0 });
}
{
  // OUR OWN SIDE, which is the half a "debuff" role could never reach: Entangling Roots hangs
  // its `root` and `dot` with the enemy Keeper's own `sourceId`, so the same line that reads
  // Bloodlust as a buff on their Grunt reads the roots as a debuff on our Huntress.
  const p = caster({ abilId: "Adis" });
  const keeper = unit({ owner: 1, x: -600 });
  const roots = (src) => ({ kind: "root", group: "roots", timeLeft: 9, sourceId: src.id, buffId: "BEer" });
  const rooted = unit({ x: 300, buffs: [roots(keeper)] });
  check("an ENTANGLED friendly unit is dispelled free", spotOf(cast([p, rooted, keeper])), { x: 300, y: 0 });
  // …and an ALLY's, for the same reason.
  const p2 = caster({ abilId: "Adis" });
  const allyRooted = unit({ owner: 2, x: 250, buffs: [roots(keeper)] });
  check("…and an ALLY's too", spotOf(cast([p2, allyRooted, keeper])), { x: 250, y: 0 });
}
{
  // …but never a circle that would take our OWN summon with it — a dispel damages summons, and
  // the Water Elemental we paid for is worth more than the buff coming off their Grunt.
  const p = caster({ abilId: "Adis" });
  const src = shaman();
  const lusted = unit({ owner: 1, x: 300, buffs: [theirBuff(src)] });
  const ours = unit({ x: 340, summonLeft: 45 });
  check("a spot that would delete our own summon is not a spot", cast([p, lusted, ours, src]), null);
}

// ==========================================================================================
console.log("\n-- Impale is aimed like Shock Wave, off its OWN wave columns -------------------");
// ==========================================================================================
// Reported: *"the Computer+ AI usage of Cryptlord doesn't really like to use the Impale
// ability"*, with the developer's own fix — treat it like Shock Wave.
//
// The cause was arithmetic, not policy, and it lived in the ONE helper both casters share
// (`waveDistance`, src/ai/casting.ts). Read as the Shock Wave family is — distance in `DataC` —
// Impale's reach came back as **75**, which is its DAMAGE column: no enemy was ever inside it,
// so no candidate direction was ever considered and the button was never pressed. Its distance
// is `DataA` = 600, because `Uim1..4` is its own meta group.
{
  const cl = caster({ abilId: "AUim", race: "undead" });
  // Two Gnolls down the same line, four and five hundred out — well inside Impale's 600 reach
  // and far outside the 75 the old reading gave it.
  const a = unit({ owner: 1, x: 400 });
  const b = unit({ owner: 1, x: 500 });
  const cmd = cast([cl, a, b]);
  check("a Crypt Lord Impales a line of two", cmd && cmd.code, "AUim");
  check("…aimed down the corridor that catches them", spotOf(cmd), { x: 400, y: 0 });
}
{
  // …and the reach is the wave's own, not the cast range: `Rng1` is 700, `DataA` 600, and a
  // body at 650 is one the tendrils stop short of.
  const cl = caster({ abilId: "AUim", race: "undead" });
  const far = [650, 660].map((x) => unit({ owner: 1, x }));
  check("…and nothing past 600 is worth aiming at", cast([cl, ...far]), null);
}
{
  // THE WIDTH IS THE WHOLE WIDTH for this family (`(Area1) / 2` in the sim's own handler),
  // where the Shock Wave family's `Area1` is the half. Read as a half-width, Impale's 250 makes
  // a 500-wide lane and counts bodies the tendrils miss — here, two Gnolls 200 either side of
  // the line, which no single Impale can catch together.
  const cl = caster({ abilId: "AUim", race: "undead" });
  const spread = [200, -200].map((y) => unit({ owner: 1, x: 400, y }));
  check("…and the corridor is 125 to either side, not 250", cast([cl, ...spread]), null);
}
{
  // Shock Wave, unchanged, off ITS columns: 800 out and 125 either side.
  const tc = caster({ abilId: "AOsh", race: "orc" });
  const line = [700, 780].map((x) => unit({ owner: 1, x }));
  const cmd = cast([tc, ...line]);
  check("Shock Wave still reaches its own 800", cmd && spotOf(cmd), { x: 700, y: 0 });
}
{
  // The other half of "treat it like Shock Wave": it is a NUKE, so it is on the novice's card.
  // Graded `disable` it fell out of `rolesFor` entirely — an easy computer plays heal, nuke,
  // summon and morph and nothing else — so an easy Crypt Lord had no offensive button at all
  // while an easy Tauren Chieftain Shock Waved.
  const cl = caster({ abilId: "AUim", race: "undead" });
  const pack = [400, 460].map((x) => unit({ owner: 1, x }));
  check("an EASY computer's Crypt Lord Impales too", !!cast([cl, ...pack], PLUS_EASY, { passes: 2 }), true);
}

// ==========================================================================================
console.log("\n-- Mana Burn is aimed at the biggest BAR, and heroes hold the biggest ---------");
// ==========================================================================================
// Reported: *"the Computer+ AI is not utilizing the Demon Hunter's Mana Burn at all"*, with the
// developer's own rule for it — heroes first, then casters. Two things were wrong and the first
// is Impale's bug exactly: graded `debuff`, `AEmb` sat in a vocabulary only INSANE has
// (`rolesFor`), so the one skill every Computer+ Demon Hunter learns at level 1 could not be
// pressed at all below it. The second is the aim: `debuff` scores off `bodyValue` alone, which
// prices a healthy hero (1.15, and less once `heroFocus` scales it) UNDER any caster (2.5).
const dh = (o = {}) => caster({ abilId: "AEmb", race: "nightelf", ...o });
const sorceress = (o = {}) => unit({ owner: 1, mana: 300, maxMana: 300, ...o });
{
  const hero = unit({ owner: 1, isHero: true, mana: 300, maxMana: 300, x: 250 });
  const cmd = cast([dh(), sorceress({ x: 200 }), hero]);
  check("a Demon Hunter burns the enemy HERO", cmd && cmd.code, "AEmb");
  check("…and not the Sorceress standing closer", cmd && cmd.targetId, hero.id);
}
{
  // …and with no hero in reach, the caster is the target. A Footman never is: he has no pool at
  // all, and the sim will not let the button be aimed at him (`Cantmanaburn`).
  const witch = sorceress({ x: 200 });
  const cmd = cast([dh(), witch, unit({ owner: 1, mana: 0, maxMana: 0, x: 100 })]);
  check("…with no hero about, the caster", cmd && cmd.targetId, witch.id);
}
{
  // A HERO ALREADY BURNED DRY stops outbidding a full bar — there is nothing left on it to take.
  const dry = unit({ owner: 1, isHero: true, mana: 5, maxMana: 300, x: 150 });
  const witch = sorceress({ x: 250 });
  const cmd = cast([dh(), dry, witch]);
  check("…and a hero with an empty bar is not the target any more", cmd && cmd.targetId, witch.id);
}
{
  // …and a field of empty bars is not a cast: 60 mana to take four is what makes an AI look
  // like it is pressing buttons for the sake of it (`manaBurnWorthIt`).
  const drained = [1, 2].map((i) => unit({ owner: 1, mana: 4, maxMana: 300, x: 150 + 50 * i }));
  check("nobody worth burning, nothing pressed", cast([dh(), ...drained]), null);
}
{
  // THE FLOOR IS THE TARGET'S OWN CHEAPEST BUTTON, not a constant: keep burning while it can
  // still afford something. This Sorceress holds 40 — under a 50-mana Invisibility, over a
  // 35-mana Slow — so which of the two she has learned decides whether she is worth the press.
  const slow = { code: "Aslo", target: "unit", autocast: true, targetFlags: ["air", "ground", "enemy"], levelData: [lvl({ castRange: 600, cost: 35 })] };
  const invis = { code: "Aivs", target: "unit", autocast: false, targetFlags: ["air", "ground"], levelData: [lvl({ castRange: 600, cost: 50 })] };
  ABILS.Aslo = slow;
  ABILS.Aivs = invis;
  const bar = (code) => sorceress({ x: 200, mana: 40, abilities: [{ id: code, code, level: 1, cooldownLeft: 0, autocastOn: false }] });
  check("40 mana and a 35-mana Slow to spend it on: burned", !!cast([dh(), bar("Aslo")]), true);
  check("…40 mana and nothing under 50 to cast: left alone", cast([dh(), bar("Aivs")]), null);
}
{
  // THE VOCABULARY, which is the whole of "not utilizing it at all": `debuff` is Insane's and
  // nobody else's, so an easy or normal Demon Hunter never pressed the button in its life.
  const foe = () => unit({ owner: 1, isHero: true, mana: 300, maxMana: 300, x: 200 });
  check("an EASY computer's Demon Hunter burns mana too",
    !!cast([dh(), foe()], PLUS_EASY, { passes: 2 }), true);
  check("…and a NORMAL one", !!cast([dh(), foe()], PLUS_NORMAL, { passes: 2 }), true);
}

// ==========================================================================================
console.log("\n-- a summon's `Area1` is where the body goes, not who is caught ---------------");
// ==========================================================================================
// Reported: *"the Computer+ Archmage does not cast Water Elemental during fights or during
// creeping"*. Nothing about the summon was gated — it is `summon` in every difficulty's
// vocabulary and it costs 125 of a 300-mana bar — but the aim read `[AHwe] Area1` 200 as a
// catchment and refused to press the button until TWO enemies were standing inside 200 units of
// a hero whose own attack reaches 600. The same row shape is Feral Spirit's, the Phoenix's and
// Vengeance's, so this was every no-target summon in the game.
{
  const mage = caster({ abilId: "AHwe", isHero: true });
  const cmd = cast([mage, unit({ owner: 1, x: 500 })]);
  check("an Archmage with ONE enemy in front of him summons", cmd && cmd.code, "AHwe");
  check("…aimed at nothing — it is a bare press", cmd && cmd.targetId, 0);
}
{
  // …and the condition it DOES have is the thread's own — "casts when caster or nearby allies
  // are engaging enemies" — so an Archmage standing in an empty field keeps his mana.
  const mage = caster({ abilId: "AHwe", isHero: true });
  check("…and nothing to fight is no summon", cast([mage, unit({ owner: 1, x: 4000 })]), null);
}
{
  // Every difficulty, because `summon` is in all three vocabularies (`rolesFor`) and the
  // reported behaviour was not difficulty-specific.
  const at = (p) => !!cast([caster({ abilId: "AHwe", isHero: true }), unit({ owner: 1, x: 500 })], p, { passes: 2 });
  check("an EASY computer's Archmage summons too", at(PLUS_EASY), true);
  check("…and a NORMAL one", at(PLUS_NORMAL), true);
}

// ==========================================================================================
console.log("\n-- Force of Nature is aimed at the TREES, and at the ones by the fight --------");
// ==========================================================================================
// `[AEfn] targs1` is "tree" alone — the one point spell in the game whose target is not a body.
// Aimed like an area nuke it went down on a clump of ENEMIES, which is a spot with trees in it
// only by luck: `fellTrees` raises one Treant per felled tree, so a point with no tree inside
// `Area1` summons nothing at all and still charges the 100 mana and the 20-second cooldown.
const keeper = () => caster({ abilId: "AEfn", isHero: true, x: 0, y: 0 });
{
  // A fight to the east, a lone trunk beside the hero, and a stand of trees out by the enemy.
  const foe = unit({ owner: 1, x: 600, y: 0 });
  const trees = [{ x: -100, y: 0 }, { x: 560, y: 40 }, { x: 620, y: 90 }];
  const cmd = cast([keeper(), foe], PLUS_NORMAL, { trees, passes: 2 });
  check("a Keeper casts Force of Nature at all", cmd && cmd.code, "AEfn");
  check("…on the trees and not on the enemy", cmd && Math.round(Math.hypot(cmd.x - 600, cmd.y)) < 120, true);
  check("…and not on the lone trunk behind him", cmd && cmd.x > 0, true);
}
{
  // NO TREES IN REACH, NO CAST — `Rng1` is 800, and `nearestTrees` pads its answer past the
  // radius, so a forest on the other side of the map comes back from the sim looking like a
  // candidate. 100 mana on a spot that fells nothing is the whole bug this file is pinning.
  const foe = unit({ owner: 1, x: 600, y: 0 });
  check("a forest out of range is not a spot", cast([keeper(), foe], PLUS_NORMAL, { trees: [{ x: 5000, y: 5000 }], passes: 2 }), null);
  check("…and neither is no forest at all", cast([keeper(), foe], PLUS_NORMAL, { trees: [], passes: 2 }), null);
}
{
  // THE QUORUM IS THE DIFFICULTY'S, as everywhere else here — but never more than the rank can
  // fell (`DataA` 2 at level 1), or the ability would be held to a bar it cannot reach.
  const foe = () => unit({ owner: 1, x: 600, y: 0 });
  // Well off the enemy, so that "it landed on the tree" and "it landed on the body" are
  // different answers — under the old aim this spot is the FOE's and the trunk is never read.
  const lone = [{ x: 400, y: -300 }];
  check("a NORMAL Keeper wants a clump, not one trunk", cast([keeper(), foe()], PLUS_NORMAL, { trees: lone, passes: 2 }), null);
  const easy = cast([keeper(), foe()], PLUS_EASY, { trees: lone, passes: 2 });
  check("…an EASY one presses it on the single tree", easy && [easy.x, easy.y], [400, -300]);
  check("…and two trunks together are a clump for anybody",
    !!cast([keeper(), foe()], PLUS_NORMAL, { trees: [{ x: 560, y: 0 }, { x: 620, y: 60 }], passes: 2 }), true);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
