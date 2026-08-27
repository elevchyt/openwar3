// Headless check of the ability targeting gate (SimWorld.targetError).
//
// The "Targets Allowed" flags (AbilityData `targs1`) decide what a spell may be aimed at,
// and the refusals are commandstrings.txt [Errors] keys. This drives the real SimWorld with
// hand-built units so the rule can be checked without a browser or the MPQs.
//
// Run: pnpm sim:test  (compiles src/sim/world.ts to CommonJS first — see tools/tsconfig.sim.json)
// The repo is `"type": "module"`, so the CommonJS the throwaway config emits needs its own
// package.json to be loadable — same trick as tools/jass-corpus-test.cjs.
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

// SimWorld only needs a pathing grid it never walks for this; targetError touches nothing else.
const world = new SimWorld({ width: 4, height: 4, cell: 128, blocked: new Uint8Array(16) }, 1);

let nextId = 1;
/** A unit stripped to what targetError actually reads. */
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, hp: 100, maxHp: 100, isHero: false, building: null,
    mechanical: false, flying: false, invulnerable: false, neutralPassive: false, race: "human",
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}

const caster = unit({ owner: 0, team: 0 });
const enemyGround = unit({ owner: 1, team: 1 });
const enemyAir = unit({ owner: 1, team: 1, flying: true });
const enemyBuilding = unit({ owner: 1, team: 1, building: { constructionLeft: 0 } });
const allyGround = unit({ owner: 0, team: 0 });
const allyAir = unit({ owner: 0, team: 0, flying: true });
const allyBuilding = unit({ owner: 0, team: 0, building: { constructionLeft: 0 } });

// Each case is a real ability's targs1, straight out of Units\AbilityData.slk (1.27a).
const CASES = [
  // Keeper of the Grove — Entangling Roots. Ground only: roots come out of the earth.
  ["AEer", "ground,enemy,neutral,organic", enemyGround, null, "roots an enemy footman"],
  ["AEer", "ground,enemy,neutral,organic", enemyAir, "Noair", "cannot root a gryphon"],
  ["AEer", "ground,enemy,neutral,organic", enemyBuilding, "Notmechanical", "cannot root a building"],
  // "Notfriendly" is the game's own wording for this: "Unable to target friendly units."
  ["AEer", "ground,enemy,neutral,organic", allyGround, "Notfriendly", "cannot root an ally"],
  // Batrider — Unstable Concoction. Air only: it is the anti-air suicide.
  ["Auco", "air,neutral,enemy", enemyAir, null, "blows up on an enemy gryphon"],
  ["Auco", "air,neutral,enemy", enemyGround, "Noground", "not spent on a grunt"],
  // Shaman — Lightning Shield. Ground, either allegiance.
  ["Alsh", "ground,friend,enemy,neutral", enemyGround, null, "shields an enemy ground unit"],
  ["Alsh", "ground,friend,enemy,neutral", allyGround, null, "shields a friendly ground unit"],
  ["Alsh", "ground,friend,enemy,neutral", allyAir, "Noair", "cannot shield a flyer"],
  // Kodo Beast — Devour. Ground, non-hero, organic, enemy.
  ["Adev", "ground,nonhero,enemy,organic,neutral", enemyGround, null, "swallows a grunt"],
  ["Adev", "ground,nonhero,enemy,organic,neutral", enemyAir, "Noair", "cannot swallow a flyer"],
  // Sorceress — Slow. Both movement types, enemy only.
  ["Aslo", "air,ground,enemy", enemyAir, null, "slows an air unit"],
  ["Aslo", "air,ground,enemy", enemyGround, null, "slows a ground unit"],
  ["Aslo", "air,ground,enemy", allyGround, "Notfriendly", "cannot slow an ally"],
  // Absorb Mana — no movement flag at all, so movement type must not be gated.
  ["Aabs", "player,vuln,invu", allyAir, null, "no movement flag leaves flyers legal"],
  ["Aabs", "player,vuln,invu", allyGround, null, "no movement flag leaves ground legal"],
  // A structure-only ability keeps the game's positive wording.
  ["Arep", "structure,friend,self", allyBuilding, null, "repairs a friendly building"],
  ["Arep", "structure,friend,self", enemyBuilding, "Notenemy", "cannot repair an enemy building"],
  ["Arep", "structure,friend,self", enemyGround, "Targetstructure", "must target a building"],
];

// Magic Immunity (`Amim`) — the Dryad, Spell Breaker, Destroyer, Faerie Dragon. It refuses
// BOTH directions: no Polymorph on an enemy one, no Bloodlust or Heal on a friendly one.
const immuneFoe = unit({ owner: 1, team: 1, magicImmune: true });
const immuneAlly = unit({ owner: 0, team: 0, magicImmune: true });
CASES.push(
  ["Aslo", "air,ground,enemy", immuneFoe, "Immunetomagic", "no Slow on an enemy Dryad"],
  ["Ablo", "air,ground,friend,organic,self,neutral", immuneAlly, "Immunetomagic", "no Bloodlust on a friendly Spell Breaker"],
  ["Ahea", "air,ground,friend,vuln,invu,self,organic,nonancient,neutral", immuneAlly, "Immunetomagic", "…nor a Priest's Heal"],
  // The dispels are exempt: a debuff placed before the immunity applied must be removable.
  ["Adis", "air,ground,ward,invu,vuln,tree", immuneFoe, null, "Dispel Magic still reaches it"],
  ["Aadm", "air,ground,ward,invu,vuln,tree", immuneAlly, null, "…and so does Abolish Magic"],
);

// Mana Burn (`AEmb`) — the rule `targs1` cannot state. Its flags are satisfied in full by a
// Footman, and the Demon Hunter still may not pick him: there is no mana bar to burn. The
// game ships the refusal written for this one ability — commandstrings.txt [Errors]
// `Cantmanaburn` = "Unable to cast Mana Burn on this target." An EMPTY pool is a different
// thing and stays legal, because a drained Sorceress is still a caster.
const MB = "air,ground,enemy,organic,nonancient,vuln,invu";
const foeCaster = unit({ owner: 1, team: 1, mana: 40, maxMana: 200 });
const foeDrained = unit({ owner: 1, team: 1, mana: 0, maxMana: 200 });
const foeFootman = unit({ owner: 1, team: 1, mana: 0, maxMana: 0 });
CASES.push(
  ["AEmb", MB, foeCaster, null, "burns an enemy Sorceress"],
  ["AEmb", MB, foeDrained, null, "…and one that is already empty"],
  ["AEmb", MB, foeFootman, "Cantmanaburn", "but not a Footman, who has no mana at all"],
);

// Invulnerability — `Notinvulnerable` = "That target is invulnerable." It is checked ahead of
// the flag list, so it answers for every ability alike rather than for the ones whose `targs1`
// happens to name it, and it is one-directional: a hostile spell is refused, a friendly one is
// not (the flags decide that half).
const invuFoe = unit({ owner: 1, team: 1, invulnerable: true });
const invuAlly = unit({ owner: 0, team: 0, invulnerable: true, hp: 40 }); // hurt, so the heal has work to do
CASES.push(
  ["AHtb", "air,ground,debris,enemy,neutral,organic", invuFoe, "Notinvulnerable", "no Storm Bolt on an invulnerable enemy"],
  ["AUfn", "ground,enemy,air,neutral,organic", invuFoe, "Notinvulnerable", "…nor a Frost Nova"],
  ["Ahea", "air,ground,friend,vuln,invu,self,organic,nonancient,neutral", invuAlly, null, "a friendly Heal still reaches one"],
);

let failed = 0;
for (const [code, targs, target, want, what] of CASES) {
  const flags = targs.split(",").map((s) => s.trim()).filter((s) => s && s !== "_");
  const got = world.targetError(caster, target, flags, code);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${code}  ${what}\n        want ${want ?? "(allowed)"}, got ${got ?? "(allowed)"}`);
}

// The ATTACK half of the same rule (SimWorld.attackRefusal). issueAttack has always turned an
// attack on an invulnerable target down; what is checked here is that the refusal now has WORDS
// — and that only a deliberate Attack command hears them. A right-click is a smart order, and a
// smart click on something that cannot be attacked is simply not an attack.
const swinger = unit({
  owner: 0, team: 0, abilities: [], baseSpeed: 270, uprooted: false,
  weapon: { enabled: true, targets: ["ground", "air", "structure"], range: 90, ranged: false },
});
const ATTACK_CASES = [
  [invuFoe, true, "Notinvulnerable", "the Attack command on an invulnerable enemy says so"],
  [invuFoe, false, null, "a right-click on the same one says nothing"],
  [enemyGround, true, null, "and a vulnerable enemy is attacked as before"],
];
for (const [target, commanded, want, what] of ATTACK_CASES) {
  const got = world.attackRefusal(swinger.id, target.id, commanded);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  attack  ${what}\n        want ${want ?? "(allowed)"}, got ${got ?? "(allowed)"}`);
}

const total = CASES.length + ATTACK_CASES.length;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
