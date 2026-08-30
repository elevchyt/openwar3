// Headless check that a Computer+ BUILD LADDER never gets stuck — the other half of
// tools/ai-plus-plan-test.cjs, which pins what there is to TRAIN. This one pins what happens to
// the list once `OneBuildLoop` starts spending down it.
//
// Reported from real matches: "Computer+ Orc AI is a lot of times stuck not building an initial
// army of grunts and/or headhunters and is also not teching up", and the same of the night elf's
// Archers and Huntresses. The two halves of that sentence turned out to be one fault with four
// causes, and each of them is a way for the ladder to stop being READ:
//
//   1. `AiPlayer.rowCost` priced a TIER-UP off the idle-only `upgradeCandidates` scan, so a hall
//      busy training a worker — which is a hall for most of the first three minutes, because the
//      worker rows sit above the tier row in every build order there is — priced a Stronghold at
//      its whole 700/375 rather than the 315/190 an upgrade is charged. A row the loop cannot
//      afford HALTS it, so four passes in five over the first two minutes stopped at a price the
//      player would never have been asked for, with the tech, the upgrades and the army rows all
//      underneath it.
//   2. …and even priced right the upgrade could not START, because `upgradeExisting` needs that
//      hall idle and the worker rows above it re-filled its queue every pass.
//   3. `techBuildings` gated a second production building on `armyFood >= 40`, which is ABOVE
//      two of the three difficulties' own army ceilings (12 on Easy, 30 on Normal) — so neither
//      could ever build one, and one Barracks makes one Grunt every thirty seconds however rich
//      the player is.
//   4. `CORE_ARMY_FOOD` was a flat 16, and it is the ONLY army row above the tier-up. Saving 315
//      for a Stronghold behind a 16-food army is a player's opening; saving a THOUSAND for a
//      Fortress behind one is a computer that stops growing at the sixth minute.
//
// None of these numbers are Warcraft III's — nothing in the install describes an improved AI —
// so what is pinned here is OUR tuning. What IS the game's is everything the economy half reads:
// the costs, build times, food and supply out of `Units\UnitBalance.slk`.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");

const REPO = join(__dirname, "..");
writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { buildPlan, harvestPlan } = require(join(REPO, ".sim-build", "src", "ai", "plus", "plan.js"));
const { PLUS_RACES } = require(join(REPO, ".sim-build", "src", "ai", "plus", "races.js"));
const { PLUS_EASY, PLUS_NORMAL, PLUS_INSANE } = require(join(REPO, ".sim-build", "src", "ai", "plus", "profile.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// ======================================================================================
//  Part one: the rows the plan emits. No install data needed — this is our own tuning.
// ======================================================================================

/**
 * A `PlusCtx` whose `ai` RECORDS the build array instead of spending it, with a named set of our
 * buildings standing. Everything `buildPlan` reads is real; nothing is placed.
 */
function recorder(table, strategy, profile, opts = {}) {
  const have = new Map(Object.entries(opts.standing ?? {}));
  const build = [];
  const harvest = [];
  const count = (id) => have.get(id) ?? 0;
  const ai = {
    heroId: (strategy.heroes ?? table.heroes)[0],
    heroId2: (strategy.heroes ?? table.heroes)[1],
    heroId3: (strategy.heroes ?? table.heroes)[2],
    initBuildArray: () => { build.length = 0 },
    setBuildUnit: (qty, item) => { if (qty > 0) build.push({ kind: "unit", qty, item }) },
    setBuildNext: (qty, item) => { if (count(item) < qty) build.push({ kind: "unit", qty: count(item) + 1, item }) },
    setBuildUpgr: (level, item) => build.push({ kind: "upgrade", qty: level, item }),
    setBuildExpa: (qty, item) => build.push({ kind: "expand", qty, item }),
    secondaryTown: (town, qty, item) => { if (qty > 0) build.push({ kind: "unit", qty, item, town }) },
    basicExpansion: (go, hall) => { if (go) ai.setBuildExpa(count(hall) + 1, hall) },
    meleeTownHall: () => {},
    guardSecondary: () => {},
    buildFactory: (item) => ai.setBuildUnit(1, item),
    count, countDone: count, townCountDone: count, townCountTotal: () => opts.towns ?? 1,
    // Per TOWN, because that is the only shape in which "this mine is haunted and that one is
    // not" can be said — see the undead's `mineBuildings` rows below.
    townCountTown: (id, town) => opts.perTown?.[town]?.[id] ?? count(id),
    minesOwned: () => 1, goldOwned: () => 20000,
    foodUsed: () => opts.foodUsed ?? 0, foodCap: () => opts.foodCap ?? 100,
    gold: () => opts.gold ?? 500, wood: () => opts.wood ?? 500,
    clearHarvestAI: () => { harvest.length = 0 },
    harvestGold: (town, n) => harvest.push({ res: "gold", town, n }),
    harvestWood: (town, n) => harvest.push({ res: "lumber", town, n }),
    townHasMine: () => true, townHasHall: () => true, townThreatened: () => false,
  };
  const ctx = {
    ai, profile, table, strategy,
    enemy: { seen: 0, share: () => 0 },
    clock: opts.clock ?? 0,
    armyFood: opts.armyFood ?? 0,
    tier: opts.tier ?? 1,
    threatened: false,
    workerChops: opts.workerChops ?? true,
    foodOf: (id) => opts.foodOf?.(id) ?? 2,
    defOf: () => undefined,
  };
  return { ctx, build, harvest, ai };
}

// --- the extra production building -----------------------------------------------------
//
// The gate was `armyFood >= 40 && gold > 800`, and the first half is above the army CEILING of
// two of the three difficulties, so a Normal computer could never reach it at all. One Barracks
// trains one thing at a time (`AiPlayer.trainUnits`), so that gate said "buy a second Barracks
// once you no longer need one".
console.log("--- a deep bank buys another production building ---");
for (const [race, table] of Object.entries(PLUS_RACES)) {
  const strategy = table.strategies[0];
  const standing = { [table.halls[0]]: 1, [table.barracks]: 1, [table.altar]: 1 };
  const rich = recorder(table, strategy, PLUS_NORMAL, { standing, gold: 2000, armyFood: 10 });
  buildPlan(rich.ctx);
  const asked = Math.max(0, ...rich.build.filter((r) => r.item === table.barracks).map((r) => r.qty));
  check(`${race} asks for a second ${table.barracks} on 2000 gold`, asked >= 2, true);

  const poor = recorder(table, strategy, PLUS_NORMAL, { standing, gold: 200, armyFood: 10 });
  buildPlan(poor.ctx);
  const asked2 = Math.max(0, ...poor.build.filter((r) => r.item === table.barracks).map((r) => r.qty));
  check(`${race} asks for only one on 200 gold`, asked2 <= 1, true);
}

// …and it is what the ARMY is made of that gets a second copy, never something the build order
// merely happens to own — and never past the difficulty's own army ceiling.
{
  const orc = PLUS_RACES.orc;
  const standing = { [orc.halls[0]]: 1, [orc.barracks]: 1, [orc.altar]: 1 };
  const massed = recorder(orc, orc.strategies[0], PLUS_NORMAL, { standing, gold: 4000, armyFood: PLUS_NORMAL.armyFood });
  buildPlan(massed.ctx);
  const asked = Math.max(0, ...massed.build.filter((r) => r.item === orc.barracks).map((r) => r.qty));
  check("orc at its army ceiling stops adding production", asked <= 1, true);
}

// --- the undead's expansion is the MINE ---------------------------------------------------
//
// Reported: "when undead is expanding, it doesn't use its acolyte to turn the gold mine into a
// haunted gold mine, rendering the expansion useless." The Necropolis is not the expansion —
// the Haunted Gold Mine is (docs/undead.md). Until it stands there is no ring for an Acolyte to
// kneel in and `SimWorld.issueGoldWork` refuses the order outright, while `townHasHall` counts
// the Necropolis as a depot and every gate above reads the dead town as a working one.
console.log("\n--- the undead's expansion is the MINE ---");
{
  const u = PLUS_RACES.undead;
  const standing = { [u.halls[0]]: 1 };
  // Two towns: the main, whose mine a melee game STARTS haunted (`MeleeStartingUnitsUndead`
  // calls `BlightGoldMineForPlayerBJ`), and the expansion just founded beside a bare rock.
  const r = recorder(u, u.strategies[0], PLUS_NORMAL, { standing, towns: 2, perTown: { 0: { [u.mineBuilding]: 1 } } });
  buildPlan(r.ctx);
  const rows = r.build.filter((x) => x.item === u.mineBuilding);
  check("the undead haunts the expansion's mine", rows.length, 1);
  check("…the town that needs it, not the one already haunted", rows[0]?.town, 1);
  // `meleeTownHall` is a no-op in this fixture, so the first row recorded is the top of the
  // ladder — which is where the thing that makes a town a town belongs.
  check("…and it is the first row of the ladder", r.build[0]?.item, u.mineBuilding);

  const done = recorder(u, u.strategies[0], PLUS_NORMAL, {
    standing, towns: 2, perTown: { 0: { [u.mineBuilding]: 1 }, 1: { [u.mineBuilding]: 1 } },
  });
  buildPlan(done.ctx);
  check("…and asks for nothing once both are haunted", done.build.some((x) => x.item === u.mineBuilding), false);
}
// Nobody else has one, and the night elf's absence is the load-bearing half: an Entangled Gold
// Mine is what the `Aent` CAST creates, issued from the library layer both AIs share
// (`AiPlayer.entangleMines`, docs/night-elf.md), never something a build order asks for.
for (const [race, table] of Object.entries(PLUS_RACES)) {
  if (race === "undead") continue;
  check(`${race} builds nothing onto a mine`, table.mineBuilding, undefined);
}

// --- the forest floor -------------------------------------------------------------------
//
// `harvestGold` is cumulative and comes first, so five per mine before anybody chops left a
// player reduced to five workers with NO lumber income at all — and a lumber shortfall with no
// lumber income never shrinks, so the row it halts on halts the ladder for the rest of the match.
console.log("\n--- the forest is never left empty ---");
for (const [race, table] of Object.entries(PLUS_RACES)) {
  const chops = race !== "undead";
  const dry = recorder(table, table.strategies[0], PLUS_NORMAL, { wood: 20, workerChops: chops });
  harvestPlan(dry.ctx);
  check(`${race} crews the trees first when the bank is dry`, dry.harvest[0]?.res, chops ? "lumber" : "gold");

  const flush = recorder(table, table.strategies[0], PLUS_NORMAL, { wood: 800, workerChops: chops });
  harvestPlan(flush.ctx);
  check(`${race} opens on the mine when it is not`, flush.harvest[0]?.res, "gold");
}

// --- the army always asks for something --------------------------------------------------
//
// A budget spread thinly enough rounds every share to nothing, and a pass that can plainly build
// something then asks for nothing at all — the same empty field `buildableMix`'s own fallback
// exists to prevent, arrived at from the other side, and it starves the same food gates.
console.log("\n--- a thin budget still asks for a body ---");
{
  const elf = PLUS_RACES.nightelf;
  const wide = { ...elf.strategies[0], id: "wide", mix: { earc: 1, esen: 1, edry: 1, ebal: 1 } };
  const standing = { [elf.halls[0]]: 1, [elf.barracks]: 1, edob: 1, eaoe: 1 };
  // Every unit fifty food apiece: every share rounds to zero however the weights fall.
  const r = recorder(elf, wide, PLUS_EASY, { standing, tier: 2, foodOf: () => 50 });
  buildPlan(r.ctx);
  const soldiers = r.build.filter((row) => elf.units[row.item]);
  check("a mix nobody can afford a whole body of still asks for one", soldiers.length > 0, true);
}

// ======================================================================================
//  Part two: ten minutes of economy. Needs the unpacked install (`pnpm data:extract`).
// ======================================================================================

const BALANCE = join(REPO, "Warcraft III", "ExtractedData", "merged", "Units", "UnitBalance.csv");
if (!existsSync(BALANCE)) {
  console.log("\n(skipping the economy run: no Warcraft III/ExtractedData — run `pnpm data:extract`)");
} else {
  runEconomy();
}

function runEconomy() {
  // --- the game's own numbers ------------------------------------------------------------
  const DATA = {};
  {
    const lines = readFileSync(BALANCE, "utf8").split(/\r?\n/);
    const split = (l) => {
      const out = []; let cell = "", quoted = false;
      for (const ch of l) {
        if (ch === '"') { quoted = !quoted; continue; }
        if (ch === "," && !quoted) { out.push(cell); cell = ""; continue; }
        cell += ch;
      }
      out.push(cell); return out;
    };
    const head = split(lines[0]); const at = {};
    head.forEach((n, i) => { at[n] = i; });
    const num = (s) => { const n = parseFloat(String(s).trim()); return Number.isFinite(n) ? n : 0 };
    for (const line of lines.slice(1)) {
      const c = split(line);
      if (!c[0]) continue;
      DATA[c[0].trim()] = {
        gold: num(c[at.goldcost]), lumber: num(c[at.lumbercost]),
        foodMade: num(c[at.fmade]), foodUsed: num(c[at.fused]),
        buildTime: num(c[at.bldtm]) || 20,
        isBuilding: String(c[at.isbldg]).trim() === "1",
        // `UnitBalance.type` — the same column docs/night-elf.md reads: an ANCIENT eats the wisp
        // that raises it, and no other night elf building does.
        ancient: /ancient/i.test(String(c[at.type] ?? "")),
      };
    }
  }
  const def = (id) => DATA[id];

  // `TOWN_COUNT_EQUIVALENTS` for the halls, which is all this run needs of it: a Keep going up
  // over your Town Hall still means you have a hall.
  const EQUIV = {
    ogre: ["ostr", "ofrt"], ostr: ["ofrt"], ohun: ["otbk"],
    etol: ["etoa", "etoe"], etoa: ["etoe"],
    htow: ["hkee", "hcas"], hkee: ["hcas"], hpea: ["hmil"],
    unpl: ["unp1", "unp2"],
  };
  /** A tier is an UPGRADE of the hall you own — never a building a worker founds. */
  const UPGRADE_FROM = {
    ostr: "ogre", ofrt: "ostr", etoa: "etol", etoe: "etoa",
    hkee: "htow", hcas: "hkee", unp1: "unpl", unp2: "unp1",
  };

  // A gatherer's rates, off the harvest abilities (`Ahar`/`Ahrl`: ten to twenty a load, a swing
  // every 1.1–1.35 s, plus the walk). Close enough for a ten-minute economy; nothing here is
  // measuring the harvest itself.
  const GOLD_RATE = 2.0;
  const WOOD_RATE = 0.8;
  /** WC3 mines take five workers at a time. */
  const MINE_CREW = 5;
  /** `MELEE_STARTING_GOLD_V1` / `MELEE_STARTING_LUMBER_V1`. */
  const START_GOLD = 500;
  const START_LUMBER = 150;
  /** The computer creeps and skirmishes, so the army is not a monotonic thing. */
  const ATTRITION_EVERY = 90;
  const ATTRITION_SHARE = 0.25;

  function run(race, strategyId, profile, seconds) {
    const table = PLUS_RACES[race];
    const strategy = table.strategies.find((s) => s.id === strategyId);
    const S = {
      t: 0, gold: START_GOLD, lumber: START_LUMBER,
      units: { [table.worker]: 5 },
      bldgs: [
        { type: table.halls[0], ready: true, finishAt: 0, job: null },
        // …and, for the undead, the Haunted Gold Mine a melee game STARTS with — Blizzard.j's
        // `MeleeStartingUnitsUndead` calls `BlightGoldMineForPlayerBJ`, so the first mine is
        // already haunted before anybody has built anything (docs/undead.md).
        ...(table.mineBuilding ? [{ type: table.mineBuilding, ready: true, finishAt: 0, job: null }] : []),
      ],
      mines: 1, freeMines: 1, research: {}, hold: new Set(),
      stallItem: "", stallBest: Infinity, stallPasses: 0, short: 0,
      halted: null, tierHaltsEarly: 0, passesEarly: 0,
    };
    const alive = (id) => S.units[id] ?? 0;
    const of = (id) => S.bldgs.filter((b) => b.type === id);
    const jobs = () => S.bldgs.map((b) => b.job).filter(Boolean);
    const countRaw = (id) => alive(id) + of(id).length + jobs().filter((j) => j.id === id).length;
    const doneRaw = (id) => alive(id) + of(id).filter((b) => b.ready).length;
    const townCount = (id) => countRaw(id) + (EQUIV[id] ?? []).reduce((n, o) => n + countRaw(o), 0);
    const townCountDone = (id) => doneRaw(id) + (EQUIV[id] ?? []).reduce((n, o) => n + countRaw(o), 0);
    const producers = (id) => {
      if (id === table.worker) return table.halls;
      if (table.heroes.includes(id)) return [table.altar];
      return table.units[id] ? [table.units[id].from] : [];
    };

    let list = [];
    const ai = {
      heroId: (strategy.heroes ?? table.heroes)[0],
      heroId2: (strategy.heroes ?? table.heroes)[1],
      heroId3: (strategy.heroes ?? table.heroes)[2],
      initBuildArray: () => { list = [] },
      setBuildUnit: (q, item) => { if (q > 0) list.push({ type: "u", qty: q, item }) },
      setBuildNext: (q, item) => { if (countRaw(item) < q) list.push({ type: "u", qty: doneRaw(item) + 1, item }) },
      setBuildUpgr: (lvl, item) => list.push({ type: "r", qty: lvl, item }),
      setBuildExpa: (q, item) => list.push({ type: "e", qty: q, item }),
      secondaryTown: (t, q, item) => { if (q > 0) list.push({ type: "u", qty: q, item }) },
      basicExpansion: (go, hall) => { if (go && townCount(hall) === townCountDone(hall)) ai.setBuildExpa(townCount(hall) + 1, hall) },
      meleeTownHall: () => {},
      guardSecondary: () => {},
      buildFactory: (item) => ai.setBuildUnit(1, item),
      count: countRaw, countDone: doneRaw, townCountDone, townCountTotal: () => S.mines,
      // One town's worth is the whole model here — the run has one base — so a per-town count
      // is the global one. What it is FOR is the undead's Haunted Gold Mine (plan.ts
      // `mineBuildings`), which must not be asked for twice.
      townCountTown: (id) => townCount(id),
      minesOwned: () => S.mines, goldOwned: () => 20000,
      foodUsed: () => Object.entries(S.units).reduce((n, [id, q]) => n + (def(id)?.foodUsed ?? 0) * q, 0)
        + jobs().filter((j) => j.kind === "unit").reduce((n, j) => n + (def(j.id)?.foodUsed ?? 0), 0),
      foodCap: () => S.bldgs.filter((b) => b.ready).reduce((n, b) => n + (def(b.type)?.foodMade ?? 0), 0),
      gold: () => S.gold, wood: () => S.lumber,
      clearHarvestAI: () => {}, harvestGold: () => {}, harvestWood: () => {},
      townHasMine: () => true, townHasHall: () => true, townThreatened: () => false,
    };
    const ctx = {
      ai, profile, table, strategy,
      enemy: { seen: 0, share: () => 0 },
      get clock() { return S.t },
      get armyFood() {
        let f = 0;
        for (const [id, q] of Object.entries(S.units)) { const d = def(id); if (d && !d.isBuilding && d.foodUsed > 1) f += d.foodUsed * q }
        for (const j of jobs()) if (j.kind === "unit") { const d = def(j.id); if (d && d.foodUsed > 1) f += d.foodUsed }
        return f;
      },
      get tier() { const [a, b, c] = table.halls; return doneRaw(c) ? 3 : doneRaw(b) ? 2 : doneRaw(a) ? 1 : 0 },
      threatened: false, workerChops: race !== "undead",
      foodOf: (id) => def(id)?.foodUsed ?? 0,
      defOf: (id) => { const d = def(id); return d ? { goldCost: d.gold, lumberCost: d.lumber, foodUsed: d.foodUsed } : undefined },
    };

    /** `AiPlayer.rowCost` — a structure upgrade is charged the DIFFERENCE, off a STANDING
     *  source rather than an idle one. */
    function rowCost(id) {
      const d = def(id);
      const from = UPGRADE_FROM[id];
      if (d.isBuilding && from && of(from).some((b) => b.ready)) {
        const f = def(from);
        return { gold: Math.max(0, d.gold - f.gold), lumber: Math.max(0, d.lumber - f.lumber) };
      }
      return { gold: d.gold, lumber: d.lumber };
    }
    function pay(id) { const c = rowCost(id); S.gold -= c.gold; S.lumber -= c.lumber; }

    /** `AiPlayer.holdForUpgrades` — a building this pass means to upgrade takes no worker. */
    function holdForUpgrades() {
      const held = new Set();
      for (const row of list) {
        if (row.type !== "u") continue;
        const d = def(row.item);
        if (!d?.isBuilding || townCount(row.item) >= row.qty) continue;
        const from = UPGRADE_FROM[row.item];
        if (!from) continue;
        const src = of(from).filter((b) => b.ready);
        if (!src.length) continue;
        const c = rowCost(row.item);
        if (S.gold < c.gold || S.lumber < c.lumber) continue;
        for (const b of src) held.add(b);
      }
      return held;
    }

    function setProduce(qty, id) {
      const d = def(id);
      if (!d) return false;
      if (!d.isBuilding) {
        let made = 0;
        const from = producers(id);
        for (const b of S.bldgs) {
          if (made >= qty) break;
          if (!b.ready || b.job || !from.includes(b.type) || S.hold.has(b)) continue;
          b.job = { kind: "unit", id, finishAt: S.t + d.buildTime };
          pay(id); made++;
        }
        return made > 0;
      }
      const from = UPGRADE_FROM[id];
      if (from) {
        const b = of(from).find((x) => x.ready && !x.job);
        if (!b) return false; // a tier is an upgrade only: no worker founds one
        b.job = { kind: "tier", id, finishAt: S.t + d.buildTime };
        pay(id); return true;
      }
      if (alive(table.worker) < 1) return false;
      if (d.ancient) S.units[table.worker] = alive(table.worker) - 1;
      S.bldgs.push({ type: id, ready: false, finishAt: S.t + d.buildTime, job: null });
      pay(id); return true;
    }

    /** `AiPlayer.releaseStall`. */
    function releaseStall(item) {
      if (item !== S.stallItem) { S.stallItem = item; S.stallBest = S.short; S.stallPasses = 0; return false }
      if (S.short < S.stallBest) { S.stallBest = S.short; S.stallPasses = 0; return false }
      if (++S.stallPasses < 20) return false;
      S.stallPasses = 0; S.stallBest = Infinity; return true;
    }

    /** `AiPlayer.runBuildLoop`. */
    function loop() {
      let tg = S.gold, tw = S.lumber;
      S.hold = holdForUpgrades();
      let released = false;
      S.halted = null;
      for (const row of list) {
        if (row.type === "r") {
          const have = S.research[row.item] ?? 0;
          if (have >= row.qty) continue;
          const cost = { gold: 100 + 50 * have, lumber: 100 + 50 * have }; // flat: not what this measures
          if (tg < cost.gold || tw < cost.lumber) continue;
          const src = (table.upgrades.find((u) => u.id === row.item) ?? {}).from;
          const b = S.bldgs.find((x) => x.ready && !x.job && x.type === src);
          if (!b) continue;
          b.job = { kind: "research", id: row.item, level: have + 1, finishAt: S.t + 60 };
          tg -= cost.gold; tw -= cost.lumber; S.gold -= cost.gold; S.lumber -= cost.lumber;
          continue;
        }
        const have = townCount(row.item);
        if (have >= row.qty) continue;
        const need = row.qty - have;
        const c = rowCost(row.item);
        let afford = c.gold === 0 ? need : Math.floor(tg / c.gold);
        if (afford > need) afford = need;
        const wood = c.lumber === 0 ? need : Math.floor(tw / c.lumber);
        if (wood < afford) afford = wood;
        if (afford < 1) {
          S.short = Math.max(0, c.gold * need - tg) + Math.max(0, c.lumber * need - tw);
          S.halted = row.item;
          if (released || !releaseStall(row.item)) return;
          released = true;
          continue;
        }
        tg = Math.max(0, tg - c.gold * need);
        tw = Math.max(0, tw - c.lumber * need);
        if (row.type === "e") {
          if (S.freeMines > 0 && setProduce(1, row.item)) { S.freeMines--; S.mines++ }
          continue;
        }
        setProduce(afford, row.item);
      }
      S.stallItem = ""; S.stallBest = Infinity; S.stallPasses = 0;
    }

    const DT = 0.25;
    let nextPass = 0;
    let nextKill = ATTRITION_EVERY;
    while (S.t < seconds) {
      const workers = alive(table.worker);
      const miners = Math.min(MINE_CREW * S.mines, workers);
      S.gold += miners * GOLD_RATE * DT;
      // …and the undead's lumber, which is a GHOUL and not a worker (`lumberCrew`'s third).
      const ghouls = table.lumberUnit ? alive(table.lumberUnit) : 0;
      const axes = Math.max(0, workers - miners) + (ghouls ? Math.max(2, Math.floor(ghouls / 3)) : 0);
      S.lumber += axes * WOOD_RATE * DT;
      for (const b of S.bldgs) {
        if (!b.ready && S.t >= b.finishAt) b.ready = true;
        if (b.job && S.t >= b.job.finishAt) {
          if (b.job.kind === "unit") S.units[b.job.id] = alive(b.job.id) + 1;
          else if (b.job.kind === "research") S.research[b.job.id] = b.job.level;
          else b.type = b.job.id;
          b.job = null;
        }
      }
      if (S.t >= nextKill) {
        nextKill = S.t + ATTRITION_EVERY;
        for (const [id, q] of Object.entries(S.units)) {
          const d = def(id);
          if (!d || d.foodUsed <= 1 || d.foodUsed >= 5) continue; // heroes come back; workers are not the army
          S.units[id] = Math.max(0, q - Math.floor(q * ATTRITION_SHARE));
        }
      }
      if (S.t >= nextPass) {
        nextPass = S.t + profile.buildPeriod;
        harvestPlan(ctx);
        buildPlan(ctx);
        loop();
        // …and how often the OPENING stopped at the tier row, which is the mispriced-upgrade
        // fault's own signature: a hall the AI could always have afforded to upgrade, read as
        // a hall it had to found from nothing.
        if (S.t < 150) { S.passesEarly++; if (S.halted === table.halls[1]) S.tierHaltsEarly++ }
      }
      S.t += DT;
    }
    return {
      tier: ctx.tier, armyFood: ctx.armyFood, gold: Math.round(S.gold),
      lumber: Math.round(S.lumber), workers: alive(table.worker),
      producers: of(table.barracks).length,
      tierHaltShare: S.tierHaltsEarly / Math.max(1, S.passesEarly),
    };
  }

  console.log("\n--- ten minutes of build ladder ---");
  for (const [race, table] of Object.entries(PLUS_RACES)) {
    for (const s of table.strategies) {
      for (const [name, profile] of [["EASY", PLUS_EASY], ["NORM", PLUS_NORMAL], ["INSA", PLUS_INSANE]]) {
        if (s.tier > profile.techTier) continue;
        const r = run(race, s.id, profile, 600);
        console.log(`      ${name} ${(race + "/" + s.id).padEnd(22)} tier=${r.tier} army=${String(r.armyFood).padStart(3)}`
          + ` ${table.barracks}x${r.producers} workers=${String(r.workers).padStart(2)}`
          + ` gold=${String(r.gold).padStart(4)} lumber=${String(r.lumber).padStart(4)}`
          + ` openingStuckOnTier=${Math.round(r.tierHaltShare * 100)}%`);
        if (name !== "NORM") continue;
        // A NORMAL computer that is not stuck reaches its second tier and fields a real army.
        // The bar is deliberately well under what the fixed plan actually manages (24–37 food):
        // what is pinned is "the ladder kept being read", not a tuning number.
        check(`${race}/${s.id} reaches tier 2 in ten minutes`, r.tier >= 2, true);
        check(`${race}/${s.id} fields an army`, r.armyFood >= 20, true);
        // …and is not sitting on money it never found anything to do with.
        check(`${race}/${s.id} spends what it earns`, r.gold < 2000, true);
        // The tier row halting most of the opening was the mispriced-upgrade fault's signature
        // — the ladder saving 700/375 for something it would have been charged 315/190 for,
        // with the Barracks, the tech and the army rows all underneath it.
        check(`${race}/${s.id} does not spend its opening stuck on the tier row`, r.tierHaltShare < 0.3, true);
      }
    }
  }
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
