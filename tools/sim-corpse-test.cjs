// Headless check of the CORPSE family — the shared detect + claim layer (src/sim/corpses.ts)
// and the four shapes every corpse ability is built out of (src/sim/spells.ts).
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
const { corpseAdmits, corpseNeed, corpseUseError } = require(join(REPO, ".sim-build", "src", "sim", "corpses.js"));

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
  return { raised: false, isHero: false, mechanical: false, unitId: "hfoo", owner: 0, heldBy: 0, ...over };
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
eq("…nor eaten", corpseUseError(corpse({ isHero: true }), TARGS.Acan, "ally", { needsType: false }), "hero");
eq("a machine leaves a wreck, not a body", corpseUseError(corpse({ mechanical: true }), TARGS.AUan, "ally"), "mechanical");
eq("no type = nothing to rebuild", corpseUseError(corpse({ unitId: "" }), TARGS.AUan, "ally"), "notype");
ok("…but a meal does not care what died", corpseAdmits(corpse({ unitId: "" }), TARGS.Acan, "ally", { needsType: false }));
eq("a unit still FALLING is not a corpse to Raise Dead yet", corpseUseError(corpse({ fallingLeft: 1.5 }), TARGS.Arai, "ally", corpseNeed("Arai")), "falling");
eq("…nor to the Rod of Necromancy, nor to a meal", [
  corpseUseError(corpse({ fallingLeft: 1.5 }), TARGS.Arai, "ally", corpseNeed("AIrd")),
  corpseUseError(corpse({ fallingLeft: 1.5 }), TARGS.Acan, "ally", corpseNeed("Acan")),
], ["falling", "falling"]);
eq("…but Resurrection, Animate Dead and the wagon take it at once", [
  corpseUseError(corpse({ fallingLeft: 1.5 }), TARGS.AHre, "ally", corpseNeed("AHre")),
  corpseUseError(corpse({ fallingLeft: 1.5 }), TARGS.AUan, "ally", corpseNeed("AUan")),
  corpseUseError(corpse({ fallingLeft: 1.5 }), TARGS.AUan, "ally", { ...corpseNeed("Amel"), forLoad: true }),
], [null, null, null]);
eq("…and it is one to Raise Dead the moment its death has played", corpseUseError(corpse({ fallingLeft: 0 }), TARGS.Arai, "ally", corpseNeed("Arai")), null);

console.log("whose dead — read off the ability's own targs1");
ok("Resurrection takes an ally's", corpseAdmits(corpse(), TARGS.AHre, "ally"));
eq("…and refuses the enemy's", corpseUseError(corpse(), TARGS.AHre, "enemy"), "notfriendly");
ok("Ancestral Spirit's `player` reads the same way", corpseAdmits(corpse(), TARGS.Aast, "ally"));
eq("…refusing anyone else's", corpseUseError(corpse(), TARGS.Aast, "enemy"), "notfriendly");
ok("Animate Dead takes the enemy's", corpseAdmits(corpse(), TARGS.AUan, "enemy"));
ok("…and Carrion Scarabs too", corpseAdmits(corpse(), TARGS.AUcb, "enemy"));
ok("…and the Avatar's Spirits", corpseAdmits(corpse(), TARGS.Avng, "enemy"));

// --- the shapes, driven through the real handlers over a stub SpellApi ---
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
function pool(corpses, owned = {}, rrai = 0) {
  const log = { summons: [], raised: [], buffs: [], evictions: [] };
  const api = {
    countOwned: (_o, typeId) => owned[typeId] || 0,
    raiseDeadBonus: () => rrai, // the caster's researched `rrai` (Skeletal Mastery)
    summonCapMake: (casterId, typeIds, cap, incoming) => log.evictions.push({ casterId, cap, incoming, beetles: typeIds.includes("ucs1") && typeIds.includes("ucsB") }),
    claimCorpses: (c, d, x, y, radius, max, o = {}) => {
      const order = o.order || "nearest";
      const live = corpses
        .filter((k) => Math.hypot(k.x - x, k.y - y) <= radius)
        .filter((k) => corpseAdmits(k, d.targetFlags, k.owner === c.owner ? "ally" : "enemy", o));
      live.sort((a, b) => (order === "freshest" ? b.decayLeft - a.decayLeft : Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)));
      const taken = live.slice(0, max);
      for (const k of taken) {
        if (o.hold) k.heldBy = c.id; // loaded — borrowed, not used up
        else if (o.eat) k.eatenBy = c.id; // a meal — reserved, spent when the eating stops
        else { k.raised = true; k.heldBy = 0; } // spent — and it leaves whatever hold it was in
      }
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
    heldCorpseCount: (id) => corpses.filter((k) => k.heldBy === id && !k.raised).length,
    cargoCapacity: () => 8, // [Amtc] DataA on the Meat Wagon
    dropHeldCorpses: (id, x, y) => {
      let n = 0;
      for (const k of corpses) {
        if (k.heldBy !== id || k.raised) continue;
        k.heldBy = 0;
        k.x = x;
        k.y = y;
        k.decayLeft = 88; // MiscData BoneDecayTime — a dropped body is fresh again
        n++;
      }
      return n;
    },
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
  // Skeletal Mastery (issue #280). [Arai] LEVEL 2 is DataA 1 / DataB 1 / DataC uske / DataD uskm —
  // "Causes one of the two skeletons created by Raise Dead to be a Skeletal Mage" — and the
  // research's `rrai` 20 is added to the life of both.
  const row2 = { data: [1, 1], dataStr: [, , "uske", "uskm"], duration: 45, castRange: 600 };
  const { api, log } = pool([corpse({ x: 100, y: 0, decayLeft: 80 })], {}, 20);
  SPELL_HANDLERS.Arai(api, caster, def("Arai", row2), 1);
  eq("Skeletal Mastery: a Skeleton Warrior and a Skeletal Mage", log.summons.map((s) => s.unitId), ["uske", "uskm"]);
  eq("…both for 45 + the research's 20 seconds", log.summons.map((s) => s.dur), [65, 65]);
  // The creep copy answers to code `Arai` but its caster lists no research: bonus 0, its own Dur1.
  const creep = pool([corpse({ x: 100, y: 0, decayLeft: 80 })]);
  SPELL_HANDLERS.Arai(creep.api, caster, def("Arai", { data: [2, 0], dataStr: [, , "uske", "-"], duration: 40, castRange: 600 }), 1);
  eq("a row whose DataD is blank raises no second type", creep.log.summons.map((s) => `${s.unitId}:${s.dur}`), ["uske:40", "uske:40"]);
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
{
  // The beetle cap makes ROOM rather than refusing: "If you summon a new beetle while you already
  // have 6 active, the oldest beetle will automatically die" (Liquipedia, Crypt Lord). At the cap
  // a beetle still hatches, and the world is asked to cull this Crypt Lord's oldest — across
  // every rank's beetle and the burrowed forms.
  const { api, log } = pool([corpse({ x: 200, y: 0, decayLeft: 88 })], { ucs1: 6 });
  SPELL_HANDLERS.AUcb(api, caster, def("AUcb", { data: [2, 0, , , 6], dataStr: [, , "ucs1"], duration: 0, castRange: 900 }), 1);
  eq("at the six-beetle cap the cast still hatches its two", log.summons.length, 2);
  eq("…and room is made for both, oldest first", log.evictions, [{ casterId: 1, cap: 6, incoming: 2, beetles: true }]);
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
  ok("…and the body is the Ghoul's meal, still lying there", body.eatenBy === caster.id && !body.raised);
  eq("…which nobody else may have", corpseUseError(body, TARGS.Arai, "ally"), "eaten");
}
{
  const { api, log } = pool([]);
  SPELL_HANDLERS.Acan(api, caster, def("Acan", { data: [10, 800], duration: 33, castRange: 50 }), 1, { targetId: 0, x: 0, y: 0 });
  eq("no corpse, no meal — and no buff either", log.buffs, []);
}

console.log("shape D — the Meat Wagon carries, and spends nothing");
TARGS.Amel = ["ground", "dead", "nonhero"];
TARGS.Amed = [];
{
  // [Amel] Rng1 100 — one body a cast, into a hold of [Amtc] DataA = 8.
  const near = corpse({ x: 60, y: 0, decayLeft: 88 });
  const far = corpse({ x: 500, y: 0, decayLeft: 88 });
  const wagon = { id: 9, owner: 0, team: 0, x: 0, y: 0, facing: 0 };
  const { api } = pool([near, far]);
  SPELL_HANDLERS.Amel(api, wagon, def("Amel", { castRange: 100, area: 600 }), 1);
  eq("Get Corpse loads the body in reach", near.heldBy, 9);
  ok("…and it is NOT spent — a borrowed body is still a body", !near.raised);
  eq("…the one it can only see is left alone", far.heldBy, 0);
}
{
  // A held body still answers a raiser — "Dropping corpses is not required for Necromancers
  // to cast Raise Dead" (Liquipedia, Meat Wagon).
  const aboard = corpse({ x: 0, y: 0, heldBy: 9, decayLeft: 88 });
  ok("a loaded corpse is still raisable", corpseAdmits(aboard, TARGS.Arai, "enemy"));
  eq("…but cannot be loaded a second time", corpseUseError(aboard, TARGS.Amel, "enemy", { forLoad: true }), "held");
  ok("…while a free one can", corpseAdmits(corpse(), TARGS.Amel, "enemy", { forLoad: true }));
}
{
  // Part-decayed on purpose: these were picked up with 12 and 30 seconds left on them.
  const held = [corpse({ x: 0, y: 0, heldBy: 9, decayLeft: 12 }), corpse({ x: 0, y: 0, heldBy: 9, decayLeft: 30 })];
  const wagon = { id: 9, owner: 0, team: 0, x: 700, y: 300, facing: 0 };
  const { api } = pool(held);
  SPELL_HANDLERS.Amed(api, wagon, def("Amed"), 1);
  eq("Drop All Corpses empties the hold", held.map((k) => k.heldBy), [0, 0]);
  eq("…where the wagon now stands, not where they fell", held.map((k) => [k.x, k.y]), [[700, 300], [700, 300]]);
  eq("…and FRESH: the decay clock goes back to full", held.map((k) => k.decayLeft), [88, 88]);
}
{
  // Raising OUT of the hold frees the slot. Without this the wagon counted bodies it no longer
  // had, reported itself full, and never picked up another for the rest of the match.
  const aboard = [corpse({ x: 0, y: 0, heldBy: 9, decayLeft: 88 }), corpse({ x: 0, y: 0, heldBy: 9, decayLeft: 88 })];
  const nec = { id: 3, owner: 1, team: 1, x: 40, y: 0, facing: 0 };
  const { api, log } = pool(aboard);
  SPELL_HANDLERS.Arai(api, nec, def("Arai", { data: [2, 0], dataStr: [, , "uske"], duration: 45, castRange: 600 }), 1);
  eq("a Necromancer raises straight out of the wagon", log.summons.length, 2);
  ok("…the body is spent", aboard[0].raised);
  eq("…and the slot is free again", api.heldCorpseCount(9), 1);
}
{
  const wagon = { id: 9, owner: 0, team: 0, x: 0, y: 0, facing: 0 };
  const full = Array.from({ length: 8 }, () => corpse({ x: 0, y: 0, heldBy: 9, decayLeft: 88 }));
  const spare = corpse({ x: 60, y: 0, decayLeft: 88 });
  const { api } = pool([...full, spare]);
  SPELL_HANDLERS.Amel(api, wagon, def("Amel", { castRange: 100, area: 600 }), 1);
  eq("a full wagon (8) picks up nothing more", spare.heldBy, 0);
}

console.log("Raise Dead and eating wait for the body to finish falling (Art - Death Time); nothing else does");
{
  // A real world: the clock is filed by SimWorld.spawnCorpse off the type's own `death`
  // (a Footman's 3.04 s) and run down by tickCorpses, and corpsesFor is the one door every
  // corpse spell — the Rod's Raise Dead included — finds its bodies through.
  const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
  const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
  const { UnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
  const units = new UnitRegistry(new Map([
    ["hfoo", { id: "hfoo", name: "hfoo", isHero: false, isBuilding: false, deathTime: 3.04, foodUsed: 2, foodMade: 0, classification: [] }],
  ]));
  const grid = new PathingGrid({ width: 32, height: 32, flags: new Uint8Array(32 * 32) }, [0, 0]);
  const world = new SimWorld(grid, 1, undefined, undefined, units);
  const hero = { id: 1, owner: 0, team: 0, x: 0, y: 0 };
  world.spawnCorpse({ id: 2, typeId: "hfoo", owner: 0, x: 10, y: 0, facing: 0 });
  const rod = { code: "AIrd", targetFlags: TARGS.Arai };
  eq("the Footman has just fallen: nothing to raise", world.corpsesFor(hero, rod, 0, 0, 900).length, 0);
  world.tickCorpses(3);
  eq("…still nothing at 3 s of its 3.04", world.corpsesFor(hero, rod, 0, 0, 900).length, 0);
  world.tickCorpses(0.05);
  eq("…a corpse once its death has played", world.corpsesFor(hero, rod, 0, 0, 900).length, 1);
  world.spawnCorpseOf("hfoo", 0, 0, 0);
  eq("a body that never fell (Create Corpse) is usable at once", world.corpsesFor(hero, rod, 0, 0, 900).length, 2);
  // Resurrection and Animate Dead do not wait: a fresh body is theirs the instant it drops,
  // through the same door with no need passed (raiseCorpses claims with only an order).
  world.spawnCorpse({ id: 3, typeId: "hfoo", owner: 0, x: 20, y: 0, facing: 0 });
  eq("…a Footman that has JUST fallen is not the Rod's", world.corpsesFor(hero, rod, 0, 0, 900).length, 2);
  eq("…but it is Resurrection's at once", world.corpsesFor(hero, { code: "AHre", targetFlags: TARGS.AHre }, 0, 0, 900, { order: "freshest" }).length, 3);
  eq("…and Animate Dead's", world.corpsesFor(hero, { code: "AUan", targetFlags: TARGS.AUan }, 0, 0, 900, { order: "freshest" }).length, 3);
  eq("…and still not a Ghoul's meal", world.corpsesFor(hero, { code: "Acan", targetFlags: TARGS.Acan }, 0, 0, 900, { eat: true }).length, 2);
}

console.log(failed ? `\ncorpses: ${failed} FAILED` : "\ncorpses: all checks passed");
process.exit(failed ? 1 : 0);
