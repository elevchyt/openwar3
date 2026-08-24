// Headless check of the CORPSE family — the shared detect + claim layer (src/sim/corpses.ts)
// and the two shapes every corpse-spending ability is built out of (src/sim/spells.ts).
//
// What is being verified is the thing four hand-written filters used to disagree about: which
// bodies an ability may have. The real predicate is exercised — not a stub of it — with the
// real `targs1` strings out of Units\AbilityData.slk, so the tests read the same table the
// game does.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SPELL_HANDLERS } = require(join(REPO, ".sim-build", "src", "sim", "spells.js"));
const { corpseAdmits, corpseUseError } = require(join(REPO, ".sim-build", "src", "sim", "corpses.js"));

let failed = 0;
function ok(name, cond, extra) {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) {
    failed++;
    if (extra !== undefined) console.log("        " + JSON.stringify(extra));
  }
}
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${same ? "ok  " : "FAIL"}  ${name}`);
  if (!same) {
    failed++;
    console.log("        want " + JSON.stringify(want));
    console.log("        got  " + JSON.stringify(got));
  }
}

function corpse(over = {}) {
  return { raised: false, isHero: false, mechanical: false, unitId: "hfoo", owner: 0, ...over };
}

// The real Targets Allowed strings, from Units\AbilityData.slk.
const TARGS = {
  AHre: ["air", "ground", "dead", "friend"], // Resurrection — YOUR dead
  AUan: ["air", "ground", "dead"], //           Animate Dead — anyone's
  AUcb: ["dead"], //                            Carrion Scarabs
  Avng: ["air", "ground", "dead"], //           Spirit of Vengeance
  Arai: ["dead"], //                            Raise Dead
  Aast: ["ground", "player", "dead"], //        Ancestral Spirit — the caster's OWN
  Acan: ["ground", "dead", "organic"], //       Cannibalize
};

console.log("the filter every corpse ability shares");
eq("a plain body is fair game", corpseUseError(corpse(), TARGS.AUcb, "ally"), null);
eq("…a spent one is not", corpseUseError(corpse({ raised: true }), TARGS.AUcb, "ally"), "spent");
eq("a HERO corpse is never usable", corpseUseError(corpse({ isHero: true }), TARGS.AUcb, "ally"), "hero");
eq("…not by Animate Dead either", corpseUseError(corpse({ isHero: true }), TARGS.AUan, "ally"), "hero");
eq("…nor eaten", corpseUseError(corpse({ isHero: true }), TARGS.Acan, "ally", false), "hero");
eq("a machine leaves a wreck, not a body", corpseUseError(corpse({ mechanical: true }), TARGS.AUan, "ally"), "mechanical");
eq("no type = nothing to rebuild", corpseUseError(corpse({ unitId: "" }), TARGS.AUan, "ally"), "notype");
ok("…but a meal does not care what died", corpseAdmits(corpse({ unitId: "" }), TARGS.Acan, "ally", false));

console.log("whose dead — read off the ability's own targs1");
ok("Resurrection takes an ally's", corpseAdmits(corpse(), TARGS.AHre, "ally"));
eq("…and refuses the enemy's", corpseUseError(corpse(), TARGS.AHre, "enemy"), "notfriendly");
ok("Ancestral Spirit's `player` reads the same way", corpseAdmits(corpse(), TARGS.Aast, "ally"));
eq("…refusing anyone else's", corpseUseError(corpse(), TARGS.Aast, "enemy"), "notfriendly");
ok("Animate Dead takes the enemy's", corpseAdmits(corpse(), TARGS.AUan, "enemy"));
ok("…and Carrion Scarabs too", corpseAdmits(corpse(), TARGS.AUcb, "enemy"));
ok("…and the Avatar's Spirits", corpseAdmits(corpse(), TARGS.Avng, "enemy"));

// --- the two shapes, driven through the real handlers over a stub SpellApi ---
function def(code, over = {}) {
  const { data = [], duration = 0, area = 0, castRange = 0, dataStr = [], summon = "", ...rest } = over;
  return {
    id: code, code, targetFlags: TARGS[code] || [], missileArt: "", missileSpeed: 0,
    targetArt: "", casterArt: "", specialArt: "", effectArt: "", areaArt: "",
    buffArt: "", buffFx: [], buffEffectArt: "", buffSpecialArt: "", lightning: [],
    levelData: [{ cost: 0, cooldown: 0, duration, heroDuration: duration, castRange, area, castTime: 0, data, dataStr, buffs: [], summon }],
    ...rest,
  };
}
const caster = { id: 1, owner: 0, team: 0, x: 0, y: 0, facing: 0, hp: 500, maxHp: 500, isHero: true };

/** A stub world holding a corpse pool, running the REAL claim rules over it. */
function pool(corpses, owned = {}) {
  const log = { summons: [], raised: [], buffs: [] };
  const api = {
    countOwned: (_o, typeId) => owned[typeId] || 0,
    claimCorpses: (c, d, x, y, radius, max, order = "nearest", needsType = true) => {
      const live = corpses
        .filter((k) => Math.hypot(k.x - x, k.y - y) <= radius)
        .filter((k) => corpseAdmits(k, d.targetFlags, k.owner === c.owner ? "ally" : "enemy", needsType));
      live.sort((a, b) => (order === "freshest" ? b.decayLeft - a.decayLeft : Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)));
      const taken = live.slice(0, max);
      for (const k of taken) k.raised = true; // spent — one taker per body
      return taken.map((k) => ({ x: k.x, y: k.y, facing: k.facing || 0, unitId: k.unitId, owner: k.owner }));
    },
    raiseClaimed: (taken, owner, team, opts) => {
      for (const t of taken) log.raised.push({ unitId: t.unitId, x: t.x, dur: (opts && opts.durationSec) || 0, invuln: !!(opts && opts.invulnerable) });
      return taken.length;
    },
    requestSummon: (unitId, x, y, facing, owner, team, dur, src, art, atPoint, bound) =>
      log.summons.push({ unitId, x, dur, atPoint: !!atPoint, bound: !!bound }),
    applyBuff: (t, b) => log.buffs.push({ kind: b.kind, value: b.value, timeLeft: b.timeLeft }),
    emitEffect: () => {},
  };
  return { api, log };
}

console.log("shape A — one body becomes N of a fixed type");
{
  // [Arai] DataA 2, DataC uske, Dur 45, Rng 600 — 2 skeletons out of one corpse.
  const corpses = [corpse({ x: 100, y: 0, decayLeft: 80 }), corpse({ x: 400, y: 0, decayLeft: 88 })];
  const { api, log } = pool(corpses);
  SPELL_HANDLERS.Arai(api, caster, def("Arai", { data: [2, 0], dataStr: [, , "uske"], duration: 45, castRange: 600 }), 1);
  eq("Raise Dead: two skeletons", log.summons.map((s) => s.unitId), ["uske", "uske"]);
  eq("…for the row's 45 seconds", log.summons.map((s) => s.dur), [45, 45]);
  eq("…standing where the body fell, not by the caster", log.summons.map((s) => s.x), [100, 100]);
  ok("…the NEAREST body, not the freshest", corpses[0].raised && !corpses[1].raised);
  eq("…and it is spent: a second cast finds the other one", (() => {
    const l2 = pool(corpses).log;
    SPELL_HANDLERS.Arai(pool(corpses).api, caster, def("Arai", { data: [2, 0], dataStr: [, , "uske"], duration: 45, castRange: 600 }), 1);
    return corpses[1].raised;
  })(), true);
}
{
  // [Avng] DataA 1, DataC even, DataE 6, Dur 50 — and BOUND to the Avatar.
  const { api, log } = pool([corpse({ x: 50, y: 0, decayLeft: 88 })]);
  SPELL_HANDLERS.Avng(api, caster, def("Avng", { data: [1, 0, , , 6], dataStr: [, , "even"], duration: 50, castRange: 600 }), 1);
  eq("Vengeance: one Spirit, timed and bound", log.summons, [{ unitId: "even", x: 50, dur: 50, atPoint: true, bound: true }]);
}
{
  // …and the cap is DataE against the caster's live count.
  const { api, log } = pool([corpse({ x: 50, y: 0, decayLeft: 88 })], { even: 6 });
  SPELL_HANDLERS.Avng(api, caster, def("Avng", { data: [1, 0, , , 6], dataStr: [, , "even"], duration: 50, castRange: 600 }), 1);
  eq("…at the six-Spirit cap it raises nothing", log.summons, []);
}
{
  // [AUcb] DataA 1, DataC ucs1, Dur 0 — beetles are permanent, and never bound.
  const { api, log } = pool([corpse({ x: 200, y: 0, decayLeft: 88 })]);
  SPELL_HANDLERS.AUcb(api, caster, def("AUcb", { data: [1, 0, , , 5], dataStr: [, , "ucs1"], duration: 0, castRange: 900 }), 1);
  eq("Carrion Scarabs: one permanent beetle", log.summons, [{ unitId: "ucs1", x: 200, dur: 0, atPoint: true, bound: false }]);
}
{
  const { api, log } = pool([corpse({ x: 50, y: 0, isHero: true, decayLeft: 88 })]);
  SPELL_HANDLERS.AUcb(api, caster, def("AUcb", { data: [1, 0, , , 5], dataStr: [, , "ucs1"], castRange: 900 }), 1);
  eq("…and nothing hatches out of a dead hero", log.summons, []);
}

console.log("shape B — up to N bodies get back up as themselves");
{
  // [AHre] DataA 6, Area 900, Dur 0, targs1 …,friend — the Paladin's own dead, permanent.
  const mine = corpse({ x: 100, y: 0, owner: 0, decayLeft: 40 });
  const alsoMine = corpse({ x: 300, y: 0, owner: 0, decayLeft: 88 });
  const theirs = corpse({ x: 120, y: 0, owner: 1, decayLeft: 88 });
  const { api, log } = pool([mine, alsoMine, theirs]);
  SPELL_HANDLERS.AHre(api, caster, def("AHre", { data: [6, 0], area: 900 }), 1, { targetId: 0, x: 0, y: 0 });
  eq("Resurrection raises only the caster's dead", log.raised.length, 2);
  ok("…leaving the enemy's where it lies", !theirs.raised);
  eq("…freshest first", log.raised.map((r) => r.x), [300, 100]);
  eq("…whole and permanent", log.raised.map((r) => r.dur), [0, 0]);
}
{
  // [AUan] DataA 6, DataB 1 (invulnerable), Dur 40, targs1 without an allegiance flag.
  const theirs = corpse({ x: 120, y: 0, owner: 1, decayLeft: 88 });
  const { api, log } = pool([theirs]);
  SPELL_HANDLERS.AUan(api, caster, def("AUan", { data: [6, 1], area: 900, duration: 40 }), 1);
  eq("Animate Dead takes the enemy's dead", log.raised, [{ unitId: "hfoo", x: 120, dur: 40, invuln: true }]);
}

console.log("shape C — the body spent on something that is not a unit");
{
  const body = corpse({ x: 30, y: 0, unitId: "", decayLeft: 88 }); // type unknown: still a meal
  const { api, log } = pool([body]);
  SPELL_HANDLERS.Acan(api, caster, def("Acan", { data: [10, 800], duration: 33, castRange: 50 }), 1, { targetId: 0, x: 0, y: 0 });
  eq("Cannibalize eats it for hit points", log.buffs, [{ kind: "hot", value: 10, timeLeft: 33 }]);
  ok("…and the body is spent", body.raised);
}
{
  const { api, log } = pool([]);
  SPELL_HANDLERS.Acan(api, caster, def("Acan", { data: [10, 800], duration: 33, castRange: 50 }), 1, { targetId: 0, x: 0, y: 0 });
  eq("no corpse, no meal — and no buff either", log.buffs, []);
}

console.log(failed ? `\ncorpses: ${failed} FAILED` : "\ncorpses: all checks passed");
process.exit(failed ? 1 : 0);
