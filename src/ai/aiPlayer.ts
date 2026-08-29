import type { Command } from "../game/commands";
import type { AbilityRegistry } from "../data/abilities";
import type { ItemRegistry } from "../data/items";
import type { UnitDef, UnitRegistry } from "../data/units";
import type { TechRegistry } from "../data/techtree";
import type { UpgradeRegistry } from "../data/upgrades";
import { isOffField, type SimMine, type SimUnit, type SimWorld } from "../sim/world";
import { footprintBuildable, footprintCellsAt, type Footprint } from "../sim/destructibles";
import { PATHING_CELL } from "../sim/pathing";
import {
  BUILD_EXPAND, BUILD_UNIT, BUILD_UPGRADE, ELF_MINE, MELEE_INSANE, MELEE_NEWBIE, TOWN_COUNT_EQUIVALENTS,
} from "./ids";

// The melee AI engine: `Scripts\common.ai`'s library, plus the ~150 AI natives that library
// stands on (issue #119; see docs/melee-ai.md for the shape of the whole thing).
//
// **What this is a port of.** WC3's melee AI is TWO layers. The four race scripts
// (`human.ai`, `orc.ai`, `elf.ai`, `undead.ai`) are strategy — build orders, upgrade
// priorities, harvest splits, when to attack — and they are ported line-for-line in the four
// files beside this one. `common.ai` is the library they call, and BELOW it sit the engine's
// own natives (`SetProduce`, `HarvestGold`, `CaptainAttack`, `GetCreepCamp`…) which are C++
// in the original. Both of those lower layers live here, because the seam between them is
// Blizzard's, not ours: `SetBuildUnit` is one line that pushes a row onto an array, and the
// interesting behaviour is in `OneBuildLoop` reading it back.
//
// **What is faithful and what is ours.** Everything with a name out of common.ai does what
// common.ai's own source says, including the parts that look odd:
//
//  · `OneBuildLoop` walks the build array IN ORDER and STOPS at the first row it cannot
//    afford, having already deducted the full cost of every row it passed from a running
//    `total_gold`. That is the whole priority mechanism — a build order is a list of things
//    you want in the order you want them, and gold is reserved down the list.
//  · `SetBuildUnit(n, X)` means "have at least n of X" (counting ones under construction and
//    in queues), NOT "make n more". `SetBuildNext(n, X)` is the relative form.
//  · `TownCount` folds upgraded forms into their base (a Castle is a Town Hall) — see
//    TOWN_COUNT_EQUIVALENTS.
//
// What the original engine does that we approximate rather than reproduce is called out at
// each site: the captain's pathing and formation logic, `GetEnemyPower`/`GetMegaTarget`,
// ally coordination (`SetAllianceTarget`), zeppelins, and `SetPeonsRepair`.
//
// **Where it runs.** Authority-side only — `RtsController.tick` drives it inside the branch a
// frozen LAN client never enters, and every decision leaves as a `Command` through
// `RtsController.execute`, so the AI is gated by exactly the same ownership, cost, tech and
// food rules a human player's click is. It cannot cheat because it has no route that would
// let it.

/** What one AI player needs from the world around it. Injected rather than imported so this
 *  file never reaches into the renderer — the AI is sim-side, and a headless host runs it. */
export interface AiHost {
  world: SimWorld;
  registry: UnitRegistry;
  /** Every ability's row — what `AiCaster` reads a spell's reach, area, targets and buffs
   *  off (src/ai/casting.ts). The sim keeps its own copy privately, so the caster is handed
   *  the registry rather than digging for it. */
  abilities: AbilityRegistry;
  /** Every ITEM's row — cost, charges, and the ability ids it grants. Handed in for the same
   *  reason `abilities` is: an item's behaviour is not in the item, it is the ability in its
   *  `abilList` (docs/items.md), so shopping and pressing both need this and the ability
   *  registry together. Only Computer+ reads it (src/ai/plus/items.ts). */
  items: ItemRegistry;
  tech: TechRegistry;
  upgrades: UpgradeRegistry;
  /** The one door out: every AI decision is a player command, judged by the authority. */
  execute(player: number, cmd: Command): boolean;
  /** A building's pathing footprint, for placement (`RtsController.setFootprintReader`). */
  footprintOf(pathTex: string): Footprint | null;
  coAllied(a: number, b: number): boolean;
  /** The clustered creep camps — `GetCreepCamp`'s haystack. */
  creepCamps(): ReadonlyArray<{ x: number; y: number; level: number; members: number[] }>;
  /** Is that spot under this player's side's eyes RIGHT NOW — the fog of war, asked of the
   *  computer's own viewpoint (game/viewpoint.ts) rather than the local one. What
   *  `AiPlayer.knows` is built on. */
  visible(player: number, x: number, y: number): boolean;
}

/** One row of the build array — `build_qty`/`build_type`/`build_item`/`build_town`. */
interface BuildRow {
  type: number; // BUILD_UNIT | BUILD_UPGRADE | BUILD_EXPAND
  qty: number;
  item: string;
  town: number; // -1 = "anywhere", else a town index (SecondaryTown)
}

/** One row of the assault group — `harass_qty`/`harass_max`/`harass_units`. */
interface AssaultRow {
  qty: number; // the minimum that makes a wave
  max: number; // how many the captain will take if it has them
  item: string;
}

/**
 * A TOWN, which in the AI's vocabulary is a gold mine and the base around it.
 *
 * Town 0 is the start location. Every other town is a mine the AI has decided to expand to,
 * in the order `GetNextExpansion` picked them — which is what makes `HarvestGold(T+1, 5)` and
 * `GuardSecondary(1, 2, WATCH_TOWER)` mean anything: the scripts address towns by index.
 */
interface Town {
  x: number;
  y: number;
  mineId: number;
}

/** Per-pass census of one unit type, the shape `set_vars` caches its `c_*` globals in. */
interface Census {
  all: number; // GetUnitCount — built, building, queued and ordered
  done: number; // GetUnitCountDone — standing and finished
  allAt: Map<number, number>; // per town, for GetTownUnitCount
  doneAt: Map<number, number>;
}

/** How far from a town's mine the base around it reaches. WC3's AI keeps a town's buildings
 *  in a cluster around its hall; this is the radius `TownHasHall`, the per-town census and
 *  the placement search all read "this town" as. */
const TOWN_RADIUS = 1600;

/** Nothing may be founded closer than this to a gold mine's centre — the mine's own mouth and
 *  the lane its miners walk. The mine's footprint is already unbuildable, but a Farm flush
 *  against it still wedges the queue. */
const MINE_CLEAR = 320;

/**
 * How far out an expansion hall may stand from its mine.
 *
 * Bounded from ABOVE by the NIGHT ELF and by nothing else: `Aent` Entangle has `Rng1` = 500, so
 * a Tree of Life planted further than that from the mine it came to take can never wrap it
 * (docs/night-elf.md). 460 leaves room for the snap without ever crossing that line.
 *
 * The other three races have no such rule — their hall only needs its miners' walk to be short
 * — and holding them to the elf's number is a real cost, because the search is RINGS: at
 * `SITE_RING_STEP` = 96 a ceiling of 460 offers exactly two of them, 320 and 416, in a
 * 140-unit band around a mine that on most maps is hemmed in by trees. Two rings is easily
 * blocked outright, and a blocked expansion hall is silent — `startUnit` has already reserved
 * its gold by the time placement fails, so the AI pays for a hall it never founds, every pass,
 * and starves everything below it in the build order. Give the races that can afford it a
 * wider search; 700 is still a shorter haul than the width of a base.
 */
const EXPANSION_HALL_RANGE = 460;
const EXPANSION_HALL_RANGE_WIDE = 700;

/** Placement search: rings this far apart, out to this far from the town centre. */
const SITE_RING_STEP = 96;
const SITE_MAX_RADIUS = 1800;

/** A guard tower goes at the FRONT of a town — between its hall and the enemy — rather than
 *  wherever the spiral first fits. This is how far from the hall it aims. */
const TOWER_RADIUS = 640;

/** `CaptainReadinessHP` — the group turns for home below this share of its hit points, and
 *  `CaptainRetreating` stays true until it is back. */
const RETREAT_HP_FRACTION = 0.35;
/** …and comes back out once it has healed to this. */
const REGROUP_HP_FRACTION = 0.7;

export class AiPlayer {
  /** `hero_id`/`hero_id2`/`hero_id3` — PickMeleeHero's three picks, in order. */
  heroId = "";
  heroId2 = "";
  heroId3 = "";
  /** `SetSkillArray` — hero type → the ten levels' abilities (index 0 is level 1). */
  readonly skills = new Map<string, string[]>();
  /** `basic_opening` — every race script's opening latch. */
  basicOpening = true;
  /** `take_exp` — StartExpansion sets it when an expansion is wanted. */
  takeExp = false;
  /** `min_creeps`/`max_creeps`/`allow_air_creeps` — CreepAttackEx's filter. */
  minCreeps = -1;
  maxCreeps = 0;
  allowAirCreeps = false;
  /** `exp_seen` — how many attack decisions have gone by with an enemy expansion in view. */
  expSeen = 0;
  /** The handful of race-script globals that are genuinely per-player STATE rather than a
   *  count derived from the world: undead.ai's `AG`/`WG` ghoul split and elf.ai's `wave` and
   *  `archer_opening`. They live here because a `MeleeScript` is one shared object serving
   *  every computer slot on the map — a module-level global would be all of them at once. */
  readonly vars: Record<string, number> = {};

  /**
   * The unit ids the CAPTAIN is holding — assigned once by `MeleeAi` and mutated in place, so
   * this is a live view of the attack group rather than a copy.
   *
   * Read by `applyHarvest`, and it is the other half of the Ghoul: `HarvestWood(0, WG)` asks
   * for the ghouls the wave did NOT take, so without this the harvest plan would walk every
   * ghoul in the attack group straight back into the forest a second after the captain
   * mustered it.
   */
  captainHeld: ReadonlySet<number> = new Set();

  private readonly rng: () => number;
  private buildList: BuildRow[] = [];
  private assault: AssaultRow[] = [];
  private towns: Town[] = [];
  /** The running census, rebuilt once per build pass (what `set_vars` does once a second). */
  private census = new Map<string, Census>();
  private censusStamp = -1;
  private pass = 0;
  /** `total_gold`/`total_wood` — OneBuildLoop's running reservation. */
  private totalGold = 0;
  private totalWood = 0;
  /** The harvest plan `ClearHarvestAI`/`HarvestGold`/`HarvestWood` build up, in call order. */
  private harvestPlan: Array<{ res: "gold" | "lumber"; town: number; count: number }> = [];

  constructor(
    readonly player: number,
    readonly race: string,
    readonly difficulty: number,
    private readonly host: AiHost,
    startX: number,
    startY: number,
    seed: number,
  ) {
    // The AI's own stream, NOT `SimWorld.random()`. The sim's stream is part of the match's
    // identity (a client replays it), and an AI that drew from it would advance it on the host
    // and nowhere else. Seeded off the match seed and the slot so two computers on one map
    // still pick different heroes.
    this.rng = lcg(seed + player * 7919 + 1);
    this.bypassFog = difficulty === MELEE_INSANE;
    const mine = host.world.nearestMine(startX, startY, 3000);
    this.towns.push({ x: startX, y: startY, mineId: mine?.id ?? 0 });
  }

  // ======================================================================================
  //  Trace helpers — the numbers the scripts read (GetGold, FoodUsed, GetUnitCount…)
  // ======================================================================================

  /** `GetGold()` — PLAYER_STATE_RESOURCE_GOLD. */
  gold(): number {
    return this.host.world.stashOf(this.player).gold;
  }

  /** `GetWood()` — PLAYER_STATE_RESOURCE_LUMBER. */
  wood(): number {
    return this.host.world.stashOf(this.player).lumber;
  }

  /** `MeleeDifficulty()`. */
  meleeDifficulty(): number {
    return this.difficulty;
  }

  /**
   * Does this computer KNOW about that enemy thing?
   *
   * The one advantage an INSANE computer has that is not a number: it is told everything, fog
   * or no fog — "completely bypassing the fog of war to always know your base location and
   * unit movements" is how the difficulty has been described for as long as it has existed.
   * An easy or a normal computer has to have laid eyes on it.
   *
   * **What this deliberately does NOT gate**, because none of it is fog knowledge in WC3
   * either: the enemy's MAIN base (every melee player is handed the start locations — that is
   * what a melee map's start locations ARE, and the AI's waves have always walked to them),
   * the CREEP CAMPS (map data too, which is why every computer creeps from the first minute),
   * and the AI's own towns. What is gated is what you can only learn by looking: a hall that
   * went up somewhere the map never promised one, and whether it has towers around it.
   */
  knows(u: SimUnit): boolean {
    return this.bypassFog || this.host.visible(this.player, u.x, u.y);
  }

  /**
   * Is this player told everything, fog or no fog?
   *
   * Defaults to "insane, and only insane", which is the classic computer's own rule (above).
   * It is a FIELD rather than the test itself because Computer+ turns it off at every
   * difficulty: an improved AI that plays better by seeing through walls is not an improved
   * AI, and issue #124 asks for meaningful difficulties rather than bigger advantages. See
   * src/ai/plus/ and docs/computer-plus.md. (Assigned in the constructor rather than here:
   * `difficulty` is a parameter property and is not written until the constructor runs.)
   */
  bypassFog = false;

  /** `GetRandomInt(low, high)`, off the AI's own stream. */
  randomInt(low: number, high: number): number {
    return low + Math.floor(this.rng() * (high - low + 1));
  }

  /**
   * `GetUnitCount(id)` — everything of this type the player has SPOKEN FOR: standing units,
   * structures under construction, jobs in production queues, units finished but not yet
   * born, and build orders a worker is still walking to.
   *
   * That last clause is the one that matters and has no direct WC3 analogue to copy: the
   * original engine reserves a production request inside `SetProduce` itself, so a Farm it
   * has decided on already counts. Ours counts the worker's `buildPending`/queued `buildnew`
   * instead, which is the same fact read off the world rather than off a private table —
   * without it, `SetBuildUnit(1, HOUSE)` re-orders a Farm every pass and the AI carpets its
   * base in half-built Farms while never finishing one.
   */
  count(id: string): number {
    return this.censusOf(id).all;
  }

  /** `GetUnitCountDone(id)` — standing and finished only. */
  countDone(id: string): number {
    return this.censusOf(id).done;
  }

  /** `GetTownUnitCount(id, town, done)`. */
  countAt(id: string, town: number, done: boolean): number {
    const c = this.censusOf(id);
    return (done ? c.doneAt : c.allAt).get(town) ?? 0;
  }

  /** `TownCountEx(id, only_done, town)` — the count with upgraded forms folded in. */
  townCountEx(id: string, onlyDone: boolean, town: number): number {
    const self = town === -1
      ? (onlyDone ? this.countDone(id) : this.count(id))
      : this.countAt(id, town, onlyDone);
    let n = self;
    // The equivalents are counted with `only_done` FALSE whatever was asked, exactly as
    // TownCountEx does: a Keep going up over your Town Hall still means you have a hall.
    for (const other of TOWN_COUNT_EQUIVALENTS[id] ?? []) {
      n += town === -1 ? this.count(other) : this.countAt(other, town, false);
    }
    return n;
  }

  /** `TownCount(id)`. */
  townCount(id: string): number {
    return this.townCountEx(id, false, -1);
  }

  /** `TownCountDone(id)`. */
  townCountDone(id: string): number {
    return this.townCountEx(id, true, -1);
  }

  /** `TownCountTown(id, town)`. */
  townCountTown(id: string, town: number): number {
    return this.townCountEx(id, false, town);
  }

  /** `HallsCompleted(id)` — nothing of this type is still going up. */
  hallsCompleted(id: string): boolean {
    return this.townCount(id) === this.townCountDone(id);
  }

  /** `GetUpgradeLevel(id)`. */
  upgradeLevel(id: string): number {
    return this.host.world.tech?.researchLevel(this.player, id) ?? 0;
  }

  /** `FoodUsed()` / `FoodCap()`. Food made is the LIVE cap, so a Farm still going up
   *  doesn't count — which is why the scripts compare against their own `c_food_made`
   *  (halls × GetFoodMade(hall) + farms × GetFoodMade(farm)) instead. */
  foodUsed(): number {
    return this.foodOf().used;
  }

  foodCap(): number {
    return this.foodOf().made;
  }

  /** `GetFoodMade(id)` — a type's supply contribution, off its own registry row. */
  foodMade(id: string): number {
    return this.host.registry.get(id)?.foodMade ?? 0;
  }

  /** `GetMinesOwned()` — towns whose mine still has gold and whose hall is standing. */
  minesOwned(): number {
    let n = 0;
    for (let t = 0; t < this.towns.length; t++) if (this.townHasMine(t) && this.townHasHall(t)) n++;
    return n;
  }

  /** `GetGoldOwned()` — the gold left in those mines. This is the number every race script
   *  expands on (`c_gold_owned < 2000`), so it must count the ORE, not the purse. */
  goldOwned(): number {
    let n = 0;
    for (let t = 0; t < this.towns.length; t++) {
      if (!this.townHasHall(t)) continue;
      const mine = this.host.world.mines.get(this.towns[t].mineId);
      if (mine) n += mine.gold;
    }
    return n;
  }

  /** `TownHasMine(town)`. */
  townHasMine(town: number): boolean {
    const t = this.towns[town];
    if (!t) return false;
    const mine = this.host.world.mines.get(t.mineId);
    return !!mine && mine.gold > 0 && !this.mineHeldByEnemy(mine);
  }

  /**
   * `TownHasHall(town)` — a FINISHED depot inside the town.
   *
   * "Depot" and not "town hall", because for two races the thing that makes a mine YOURS is
   * not a hall at all: a Haunted Gold Mine pays its Acolytes where they kneel and an
   * Entangled Gold Mine pays the wisps inside it, and neither needs a Necropolis or a Tree
   * standing over it to be a working mine (docs/undead.md, docs/night-elf.md). So a building
   * of ours ON this town's mine counts, and that is what keeps `GetMinesOwned` honest for
   * the two races whose expansion is the mine building itself.
   */
  townHasHall(town: number): boolean {
    const t = this.towns[town];
    if (!t) return false;
    for (const u of this.host.world.units.values()) {
      if (u.owner !== this.player || u.hp <= 0 || !u.building) continue;
      if (u.building.constructionLeft > 0) continue;
      if (u.mineId === t.mineId && t.mineId > 0) return true; // an Entangled Gold Mine
      if (this.host.world.hauntsMines(u.typeId) && Math.hypot(u.x - t.x, u.y - t.y) <= MINE_CLEAR) return true;
      if (!u.depotGold) continue;
      if (Math.hypot(u.x - t.x, u.y - t.y) <= TOWN_RADIUS) return true;
    }
    return false;
  }

  /** `TownWithMine()` — the first town still worth mining. */
  townWithMine(): number {
    for (let t = 0; t < this.towns.length; t++) if (this.townHasMine(t)) return t;
    return 0;
  }

  /** The town a world point belongs to (-1 if none) — how the per-town census is bucketed. */
  private townAt(x: number, y: number): number {
    let best = -1;
    let bestD = TOWN_RADIUS;
    for (let t = 0; t < this.towns.length; t++) {
      const d = Math.hypot(this.towns[t].x - x, this.towns[t].y - y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  // ======================================================================================
  //  The build array — SetBuildUnit and friends (common.ai 977–1045)
  // ======================================================================================

  /** `InitBuildArray()`. */
  initBuildArray(): void {
    this.buildList = [];
  }

  /** `SetBuildAll(t, qty, id, town)` — the one push every setter below goes through. */
  private setBuildAll(type: number, qty: number, item: string, town: number): void {
    if (qty > 0) this.buildList.push({ type, qty, item, town });
  }

  /** `SetBuildUnit(qty, id)` — "have at least qty of these". */
  setBuildUnit(qty: number, item: string): void {
    this.setBuildAll(BUILD_UNIT, qty, item, -1);
  }

  /** `SetBuildNext(qty, id)` — the RELATIVE form: while short of qty, ask for one more than
   *  is finished. (Note it reads `GetUnitCount` for the test and `GetUnitCountDone`+1 for the
   *  ask, which is what keeps it from queueing the whole shortfall at once.) */
  setBuildNext(qty: number, item: string): void {
    if (this.count(item) >= qty) return;
    this.setBuildAll(BUILD_UNIT, this.countDone(item) + 1, item, -1);
  }

  /** `SecondaryTown(town, qty, id)` / `SecTown`. */
  secondaryTown(town: number, qty: number, item: string): void {
    this.setBuildAll(BUILD_UNIT, qty, item, town);
  }

  /** `SetBuildUpgr(qty, id)` — qty is the LEVEL wanted. An easy computer researches level 1
   *  of anything and no more, which is the file's own rule and not a simplification. */
  setBuildUpgr(level: number, item: string): void {
    if (this.difficulty !== MELEE_NEWBIE || level === 1) this.setBuildAll(BUILD_UPGRADE, level, item, -1);
  }

  /** `SetBuildExpa(qty, id)`. */
  setBuildExpa(qty: number, item: string): void {
    this.setBuildAll(BUILD_EXPAND, qty, item, -1);
  }

  /** `BasicExpansion(build_it, hall)`. */
  basicExpansion(buildIt: boolean, hall: string): void {
    if (buildIt && this.hallsCompleted(hall)) this.setBuildExpa(this.townCount(hall) + 1, hall);
  }

  /** `MeleeTownHall(town, hall)` — put a hall on a mine we hold but haven't built on. */
  meleeTownHall(town: number, hall: string): void {
    if (this.townHasMine(town) && !this.townHasHall(town)) this.secondaryTown(town, 1, hall);
  }

  /** `GuardSecondary(town, qty, id)` — towers (and burrows) for an expansion, and only for
   *  one that is actually a base: a mine with a hall on it. */
  guardSecondary(town: number, qty: number, item: string): void {
    if (this.townHasMine(town) && this.townHasHall(town)) this.secondaryTown(town, qty, item);
  }

  /** `BuildFactory(id)` — a second production building once the purse is deep. */
  buildFactory(item: string): void {
    this.setBuildUnit(this.gold() > 1000 && this.wood() > 500 ? 2 : 1, item);
  }

  /** `FoodAvail(base)`. */
  foodAvail(farm: string, base: string): number {
    return this.foodMade(farm) * this.townCount(farm) + this.foodMade(base) * this.townCount(base);
  }

  // ======================================================================================
  //  OneBuildLoop — the build array read back (common.ai 1344–1380)
  // ======================================================================================

  /**
   * Walk the build array in order, spending a RUNNING budget.
   *
   * The two things that make this the whole strategy layer, both straight out of the file:
   * the cost of every row is deducted from `total_gold`/`total_wood` whether or not it was
   * actually started (so a row further down cannot spend the gold an earlier one is saving
   * for), and the loop RETURNS at the first unit row it cannot afford (so nothing below a
   * Barracks you are saving for gets bought first). An upgrade row that can't be afforded is
   * skipped rather than halting — `StartUpgrade`'s false return is discarded by the caller,
   * and that asymmetry is deliberate in the original.
   */
  runBuildLoop(): void {
    this.totalGold = this.gold();
    this.totalWood = this.wood();
    for (const row of this.buildList) {
      if (row.type === BUILD_UNIT) {
        if (!this.startUnit(row.qty, row.item, row.town)) return;
      } else if (row.type === BUILD_UPGRADE) {
        this.startUpgrade(row.qty, row.item);
      } else {
        if (!this.startExpansion(row.qty, row.item)) return;
      }
    }
  }

  /** `StartUnit(ask_qty, id, town)`. */
  private startUnit(askQty: number, id: string, town: number): boolean {
    const have = town === -1 ? this.townCount(id) : this.townCountTown(id, town);
    if (have >= askQty) return true;
    const need = askQty - have;

    const def = this.host.registry.get(id);
    if (!def) return true; // an id this install doesn't have is not a reason to stall the list
    const goldCost = def.goldCost;
    const woodCost = def.lumberCost;

    let affordQty = goldCost === 0 ? need : Math.floor(this.totalGold / goldCost);
    if (affordQty > need) affordQty = need;
    const affordWood = woodCost === 0 ? need : Math.floor(this.totalWood / woodCost);
    if (affordWood < affordQty) affordQty = affordWood;

    if (affordQty < 1) return false; // waiting on resources: hold everything below this row

    this.totalGold = Math.max(0, this.totalGold - goldCost * need);
    this.totalWood = Math.max(0, this.totalWood - woodCost * need);

    this.setProduce(affordQty, id, town);
    return true;
  }

  /** `StartUpgrade(level, id)`. The level compared against counts what is already IN a
   *  building's queue as well as what is researched: two of our buildings can research the
   *  same upgrade, each is priced from its own `researchingLevel`, and an AI that asked twice
   *  would buy level 1 twice. */
  private startUpgrade(level: number, id: string): boolean {
    const have = this.upgradeLevelOrQueued(id);
    if (have >= level) return true;
    const next = have + 1;
    const cost = this.host.upgrades.cost(id, next);
    if (this.totalGold < cost.gold || this.totalWood < cost.lumber) return false;
    return this.setUpgrade(id);
  }

  /** The research level counting jobs in progress — `GetUpgradeLevel` plus the queues. */
  private upgradeLevelOrQueued(id: string): number {
    let level = this.upgradeLevel(id);
    for (const b of this.host.world.units.values()) {
      if (b.owner !== this.player || b.hp <= 0 || !b.building) continue;
      for (const job of b.building.queue) {
        if (job.kind === "research" && job.unitId === id) level = Math.max(level, job.level);
      }
    }
    return level;
  }

  /** `StartExpansion(qty, hall)`. */
  private startExpansion(qty: number, hall: string): boolean {
    if (this.townCount(hall) >= qty) return true;
    const town = this.nextExpansion();
    if (town < 0) return true;
    this.takeExp = true;

    const def = this.host.registry.get(hall);
    if (!def) return true;
    if (def.goldCost > this.totalGold) return false;
    this.totalGold -= def.goldCost;

    // `GetExpansionFoe()` — creeps camped on the next expansion. The hall waits; the attack
    // sequence is what clears them (SingleMeleeAttack's `needs_exp` branch).
    if (this.expansionFoe()) return true;

    return this.setProduce(1, hall, town);
  }

  // ======================================================================================
  //  The producer — `SetProduce` / `SetUpgrade` / `SetExpansion`
  // ======================================================================================

  /**
   * `SetProduce(qty, id, town)` — make `qty` of this, wherever it comes from.
   *
   * Three different things wear this one name in WC3 and the id alone says which:
   *   · a UNIT is trained at a building that lists it in `Trains`;
   *   · a STRUCTURE is placed by a worker that lists it in `Builds`;
   *   · a TIER (Keep, Stronghold, Tree of Ages, Spirit Tower, Guard Tower) is an UPGRADE of a
   *     building you already own, and the scripts ask for it exactly like any other structure
   *     — `SetBuildUnit(1, KEEP)`. Reading that as "found a Keep" is the classic way to get an
   *     AI that never leaves tier 1, so the upgrade route is tried first.
   */
  private setProduce(qty: number, id: string, town: number): boolean {
    const def = this.host.registry.get(id);
    if (!def) return false;
    // A hero this player has lying DEAD is not trained again, it is brought back — which is
    // what every race script's "always rebuild heroes for defense" branch has always meant.
    // `GetUnitCountDone(hero_id)` reads 0 for a corpse, so the script asks for the hero by id
    // exactly as it would for a fresh one, and the engine turns that request into a revival.
    // Without this the AI would ask forever and be refused forever: the authority counts a
    // fallen hero as one you already have.
    if (def.isHero && this.reviveFallen(id)) return true;
    const made = !def.isBuilding ? this.trainUnits(qty, id)
      : this.upgradeExisting(id, town) || this.placeStructure(qty, id, town);
    // …and drop this type's cached count, so the REST of this same pass sees what was just
    // spoken for. Every route above lands synchronously in the world the census reads — a
    // train pushes onto the building's queue, a build sets the worker's `buildPending` — so a
    // re-count is honest rather than a guess at a reservation. Without it a build order that
    // asks for the same thing twice (undead.ai's `MeleeTownHall(0, …)` followed by
    // `SetBuildUnit(1, NECROPOLIS_1)`) starts it twice, in one pass, and pays for both.
    if (made) this.census.delete(id);
    return made;
  }

  /** Train `qty` of a unit, spreading across every building that makes it. */
  private trainUnits(qty: number, id: string): boolean {
    let made = 0;
    for (const b of this.buildingsThatTrain(id)) {
      if (made >= qty) break;
      // One job at a time per building: WC3's AI does not stack five Grunts in one Barracks
      // while a second stands empty, and a deep queue is gold it cannot take back.
      if (b.building!.queue.length > 0) continue;
      if (this.host.execute(this.player, { c: "train", buildingId: b.id, unitId: id })) made++;
    }
    return made > 0;
  }

  /** Bring this hero type back, if we have one of it dead and an altar to do it at. */
  private reviveFallen(typeId: string): boolean {
    const fallen = this.host.world.fallenHeroesOf(this.player).find((f) => f.typeId === typeId && !f.revivingAt);
    if (!fallen) return false;
    for (const b of this.host.world.units.values()) {
      if (b.owner !== this.player || b.hp <= 0 || !b.building) continue;
      if (b.building.constructionLeft > 0 || b.building.queue.length > 0) continue;
      // An altar of ours, and one that trains this hero — the same rule the authority applies
      // (a Human altar does not raise an orc hero). The AI never uses a Tavern for this: its
      // scripts ask for a hero by id and the altar is where their build order puts it.
      const t = this.host.tech.get(b.typeId);
      if (!t.revive || !t.trains.includes(typeId)) continue;
      if (this.host.execute(this.player, { c: "revive", buildingId: b.id, heroId: fallen.id })) return true;
    }
    return false;
  }

  /** The tier route: a building of ours whose `Upgrade` list names `id`. */
  private upgradeExisting(id: string, town: number): boolean {
    for (const b of this.host.world.units.values()) {
      if (b.owner !== this.player || b.hp <= 0 || !b.building) continue;
      if (b.building.constructionLeft > 0 || b.building.queue.length > 0) continue;
      if (town >= 0 && this.townAt(b.x, b.y) !== town) continue;
      if (!this.host.tech.get(b.typeId).upgrade.includes(id)) continue;
      if (this.host.execute(this.player, { c: "upgradebuilding", buildingId: b.id, toTypeId: id })) return true;
    }
    return false;
  }

  /** Place a structure: pick a worker, pick a site, order the build. */
  private placeStructure(qty: number, id: string, town: number): boolean {
    // Night elf gold is not a building order at all — an Entangled Gold Mine is what a Tree of
    // Life's `Aent` MAKES, so nothing may ever try to found one. See docs/night-elf.md.
    if (id === ELF_MINE) return false;
    const site = this.siteFor(id, town);
    if (!site) return false;
    const worker = this.freeWorker(id, site[0], site[1]);
    if (!worker) return false;
    void qty; // one at a time: the next pass places the next, once this one is spoken for
    return this.host.execute(this.player, {
      c: "build", unitId: worker.id, defId: id, x: site[0], y: site[1], queued: false,
    });
  }

  /** `SetUpgrade(id)` — research it at whichever building can. */
  private setUpgrade(id: string): boolean {
    for (const b of this.host.world.units.values()) {
      if (b.owner !== this.player || b.hp <= 0 || !b.building) continue;
      if (b.building.constructionLeft > 0 || b.building.queue.length > 0) continue;
      if (!this.host.tech.researches(b.typeId).includes(id)) continue;
      if (this.host.execute(this.player, { c: "research", buildingId: b.id, upgradeId: id })) return true;
    }
    return false;
  }

  private *buildingsThatTrain(id: string): Generator<SimUnit> {
    for (const b of this.host.world.units.values()) {
      if (b.owner !== this.player || b.hp <= 0 || !b.building) continue;
      if (b.building.constructionLeft > 0) continue;
      if (!this.host.tech.trains(b.typeId).includes(id)) continue;
      yield b;
    }
  }

  // ======================================================================================
  //  Placement
  // ======================================================================================

  /**
   * Where a structure of this type goes.
   *
   * A mine-standing building (the undead Haunted Gold Mine) goes on the mine and nowhere
   * else. A hall for an EXPANSION goes beside that town's mine, close enough to be its depot.
   * A tower goes at the town's front, between its hall and the map's centre of gravity.
   * Everything else spirals out from the town centre until its footprint fits.
   */
  private siteFor(id: string, town: number): [number, number] | null {
    const world = this.host.world;
    const t = this.towns[Math.max(0, town)] ?? this.towns[0];
    if (!t) return null;

    if (world.hauntsMines(id)) {
      const mine = world.mines.get(t.mineId);
      if (!mine) return null;
      return world.hauntTarget(id, mine.x, mine.y) ? [mine.x, mine.y] : null;
    }

    const def = this.host.registry.get(id);
    if (!def) return null;

    // A hall placed for a town that has none yet is that town's DEPOT: it has to be within
    // haul range of the mine, so its ring is anchored on the mine rather than the town centre.
    // `townhall` is UnitData's own classification, and the same column `depotRoleFor` falls
    // back to for the campaign halls whose `Artn` row says nothing.
    if (def.classification.includes("townhall") && town >= 0 && !this.townHasHall(town)) {
      // The night elf's hall has to end up inside Entangle's reach; everyone else's only has to
      // be near. See EXPANSION_HALL_RANGE.
      const reach = this.race === "nightelf" ? EXPANSION_HALL_RANGE : EXPANSION_HALL_RANGE_WIDE;
      const mine = world.mines.get(t.mineId);
      if (mine) return this.spiral(def, mine.x, mine.y, MINE_CLEAR, reach, t);
    }

    // A tower belongs at the town's threat-facing edge.
    if (this.isTower(def)) {
      const [fx, fy] = this.townFront(t);
      return this.spiral(def, fx, fy, 0, TOWER_RADIUS, t);
    }

    return this.spiral(def, t.x, t.y, MINE_CLEAR, SITE_MAX_RADIUS, t);
  }

  /**
   * A structure that shoots and does nothing else — the thing `GuardSecondary` asks for, and
   * the only kind that belongs at a town's threat-facing edge rather than in the cluster.
   *
   * `foodMade` is the clause that earns its place: three of the four races defend with a
   * building that ALSO feeds them (an Orc Burrow, a Ziggurat, a Moon Well), and those are
   * base furniture that happens to have a weapon, not a picket line. Without the test the
   * scripts' own `SetBuildUnit(c_burrow_done + 1, BURROW)` — a supply order — would march
   * the AI's farms out toward the enemy.
   */
  private isTower(def: UnitDef): boolean {
    return def.isBuilding && def.weapons.length > 0 && def.foodMade === 0
      && this.host.tech.get(def.id).trains.length === 0;
  }

  /** Where a town faces: away from its own hall, toward the nearest enemy town (or, with no
   *  enemy found yet, toward the map's other start locations by way of the world's centre). */
  private townFront(t: Town): [number, number] {
    const enemy = this.nearestEnemyBuilding(t.x, t.y);
    const tx = enemy ? enemy.x : this.host.world.grid.width * PATHING_CELL / 2 + this.host.world.grid.origin[0];
    const ty = enemy ? enemy.y : this.host.world.grid.height * PATHING_CELL / 2 + this.host.world.grid.origin[1];
    const d = Math.hypot(tx - t.x, ty - t.y) || 1;
    return [t.x + ((tx - t.x) / d) * TOWER_RADIUS, t.y + ((ty - t.y) / d) * TOWER_RADIUS];
  }

  /**
   * Spiral out from (cx, cy) for a spot this footprint fits on.
   *
   * The footprint is INFLATED by a cell on each side before it is tested, which is the whole
   * of "the AI leaves lanes to walk down": a building tested at its own size can be founded
   * flush against its neighbour, and a base built that way seals its own workers in. WC3's
   * pathing textures already carry a walkable blue border for the same reason; this widens it
   * by one more cell so two neighbours are always two cells apart rather than zero.
   */
  private spiral(def: UnitDef, cx: number, cy: number, minR: number, maxR: number, t: Town): [number, number] | null {
    const grid = this.host.world.grid;
    const fp = def.pathTex ? this.host.footprintOf(def.pathTex) : null;
    if (!fp) return [cx, cy]; // no footprint: it reserves nothing and can go anywhere
    const padded = inflate(fp);
    const reserved = this.pendingBuildCells();
    const mine = this.host.world.mines.get(t.mineId);
    // A per-player phase so two computers on one map don't build identical-looking bases, and
    // a per-ring one so successive rings don't line every building up on the same spokes.
    const phase = this.rng() * Math.PI * 2;
    for (let r = Math.max(minR, SITE_RING_STEP); r <= maxR; r += SITE_RING_STEP) {
      const steps = Math.max(8, Math.round((2 * Math.PI * r) / 160));
      for (let i = 0; i < steps; i++) {
        const a = phase + (i / steps) * Math.PI * 2 + r * 0.01;
        const [sx, sy] = grid.snapForBuildingRect(cx + Math.cos(a) * r, cy + Math.sin(a) * r, fp.w, fp.h);
        if (mine && Math.hypot(sx - mine.x, sy - mine.y) < MINE_CLEAR) continue;
        if (!footprintBuildable(grid, padded, sx, sy, reserved)) continue;
        if (!this.groundSuits(def, sx, sy, fp)) continue;
        return [sx, sy];
      }
    }
    return null;
  }

  /** `UnitBalance.requirePlace` — the undead's "must be on blight" rule (docs/undead.md).
   *  The same second half of "may this go here" the placement ghost asks. */
  private groundSuits(def: UnitDef, x: number, y: number, fp: Footprint): boolean {
    if (def.requirePlace !== "blighted") return true;
    return this.host.world.footprintBlighted(x, y, fp.w, fp.h);
  }

  /** Cells our own un-raised build orders have already spoken for. */
  private pendingBuildCells(): Set<number> {
    const cells = new Set<number>();
    const grid = this.host.world.grid;
    const add = (defId: string, x: number, y: number): void => {
      const tex = this.host.registry.get(defId)?.pathTex;
      const fp = tex ? this.host.footprintOf(tex) : null;
      if (fp) footprintCellsAt(grid, inflate(fp), x, y, cells);
    };
    for (const u of this.host.world.units.values()) {
      if (u.owner !== this.player) continue;
      if (u.buildPending) add(u.buildPending.defId, u.buildPending.x, u.buildPending.y);
      for (const o of u.orderQueue) if (o.kind === "buildnew") add(o.defId, o.x, o.y);
    }
    return cells;
  }

  /** The nearest worker that can build this and isn't already committed to something. */
  /**
   * Who builds it: the nearest worker that can, and that is NOT already down a hole.
   *
   * The second half is the whole method, and leaving it out cost a real bug. A worker that is
   * off the field — a Wisp inside an Entangled Gold Mine, a Peasant in a shaft, a Peon in a
   * Burrow — is standing at its HOST's own coordinates, which for a gold mine is the middle of
   * the base and therefore nearer almost any build site than the workers actually available.
   * So it won the distance test every single time, and every structure the plan placed pulled a
   * miner out of the mine while free workers stood in the trees beside it. `applyHarvest` sent
   * it straight back on the next pass, the next row pulled the next one out, and a night elf
   * computer spent the whole match putting wisps in and out of its mine.
   *
   * They are still eligible, because a player with every worker down the mine must still be
   * able to build — but only once nothing on the surface can do it. Two passes rather than a
   * distance penalty, so "on the field" strictly beats "closer", which is the actual rule.
   */
  private freeWorker(defId: string, x: number, y: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = Infinity;
    let sunk: SimUnit | null = null;
    let sunkD = Infinity;
    for (const u of this.host.world.units.values()) {
      if (u.owner !== this.player || u.hp <= 0 || !u.worker) continue;
      if (u.buildPending || u.insideBuild || u.constructing) continue;
      if (!this.host.tech.builds(u.typeId).includes(defId)) continue;
      const d = Math.hypot(u.x - x, u.y - y);
      if (isOffField(u)) {
        if (d < sunkD) { sunkD = d; sunk = u; }
      } else if (d < bestD) { bestD = d; best = u; }
    }
    return best ?? sunk;
  }

  // ======================================================================================
  //  Expansions
  // ======================================================================================

  /**
   * `GetNextExpansion()` — the town index of the next mine worth taking, or -1.
   *
   * Registers the mine as a TOWN the first time it is picked, which is what gives the race
   * scripts their `HarvestGold(T+1, 5)` and `GuardSecondary(1, …)` something to address.
   */
  nextExpansion(): number {
    for (let t = 0; t < this.towns.length; t++) {
      if (this.townHasMine(t) && !this.townHasHall(t)) return t; // one already chosen, unbuilt
    }
    const home = this.towns[0];
    let best: SimMine | null = null;
    let bestD = Infinity;
    for (const m of this.host.world.mines.values()) {
      if (m.gold <= 0) continue;
      if (this.towns.some((t) => t.mineId === m.id)) continue;
      if (this.mineHeldByEnemy(m)) continue;
      const d = Math.hypot(m.x - home.x, m.y - home.y);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (!best) return -1;
    this.towns.push({ x: best.x, y: best.y, mineId: best.id });
    return this.towns.length - 1;
  }

  /** `GetExpansionFoe()` — whoever is sitting on the expansion we want. */
  expansionFoe(): SimUnit | null {
    for (let t = 1; t < this.towns.length; t++) {
      if (this.townHasHall(t)) continue;
      const town = this.towns[t];
      let best: SimUnit | null = null;
      let bestD = 900;
      for (const u of this.host.world.units.values()) {
        if (u.hp <= 0 || u.owner === this.player) continue;
        if (!u.isCreep && !this.hostileTo(u)) continue;
        const d = Math.hypot(u.x - town.x, u.y - town.y);
        if (d < bestD) { bestD = d; best = u; }
      }
      if (best) return best;
    }
    return null;
  }

  private mineHeldByEnemy(mine: SimMine): boolean {
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || !u.building || u.owner === this.player || u.owner < 0) continue;
      if (!u.depotGold && !this.host.world.hauntsMines(u.typeId)) continue;
      if (!this.hostileTo(u)) continue;
      if (Math.hypot(u.x - mine.x, u.y - mine.y) <= EXPANSION_HALL_RANGE) return true;
    }
    return false;
  }

  hostileTo(u: SimUnit): boolean {
    if (u.owner < 0 || u.isCreep) return !u.neutralPassive;
    if (u.neutralPassive) return false;
    return !this.host.coAllied(this.player, u.owner);
  }

  // ======================================================================================
  //  Harvesting — ClearHarvestAI / HarvestGold / HarvestWood (common.ai natives)
  // ======================================================================================

  /** `ClearHarvestAI()`. */
  clearHarvestAI(): void {
    this.harvestPlan = [];
  }

  /** `HarvestGold(town, peons)` — CUMULATIVE, in call order. The race scripts lean on that:
   *  human.ai asks for 4 on gold, then 1 on wood, then 1 more on gold, so the fifth miner is
   *  worth less than the first lumberjack and the plan says so by its ORDER. */
  harvestGold(town: number, peons: number): void {
    if (peons > 0) this.harvestPlan.push({ res: "gold", town, count: peons });
  }

  /** `HarvestWood(town, peons)`. */
  harvestWood(town: number, peons: number): void {
    if (peons > 0) this.harvestPlan.push({ res: "lumber", town, count: peons });
  }

  /**
   * Hand the plan to the workers.
   *
   * Walked in the order it was declared, each slice taking the nearest unassigned worker that
   * can do that job. A worker already doing the right thing keeps doing it — the plan is a
   * TARGET, not an order, and re-issuing it every second would reset every miner's trip.
   */
  applyHarvest(): void {
    const world = this.host.world;
    const free: SimUnit[] = [];
    for (const u of world.units.values()) {
      if (u.owner !== this.player || u.hp <= 0 || !u.worker) continue;
      if (u.buildPending || u.insideBuild || u.constructing || u.order === "repair") continue;
      if (this.captainHeld.has(u.id)) continue; // in the wave — see captainHeld
      free.push(u);
    }
    free.sort((a, b) => a.id - b.id); // stable, so a re-plan doesn't shuffle the crews

    const taken = new Set<number>();
    for (const slice of this.harvestPlan) {
      const town = this.towns[slice.town];
      if (!town) continue;
      const anchor = slice.res === "gold" ? world.mines.get(town.mineId) : null;
      if (slice.res === "gold" && !anchor) continue;
      const ax = anchor ? anchor.x : town.x;
      const ay = anchor ? anchor.y : town.y;

      // Whoever is ALREADY on this job counts against the slice before anybody is moved.
      let assigned = 0;
      for (const u of free) {
        if (taken.has(u.id) || assigned >= slice.count) continue;
        if (!this.alreadyHarvesting(u, slice.res, town.mineId)) continue;
        taken.add(u.id);
        assigned++;
      }
      if (assigned >= slice.count) continue;

      const pool = free
        .filter((u) => !taken.has(u.id) && (slice.res === "gold" ? u.worker!.gold : u.worker!.lumber))
        .sort((a, b) => Math.hypot(a.x - ax, a.y - ay) - Math.hypot(b.x - ax, b.y - ay));
      for (const u of pool) {
        if (assigned >= slice.count) break;
        if (slice.res === "gold" ? this.sendToGold(u, town.mineId) : this.sendToWood(u, town)) {
          taken.add(u.id);
          assigned++;
        }
      }
    }
  }

  private alreadyHarvesting(u: SimUnit, res: "gold" | "lumber", mineId: number): boolean {
    if (u.order === "harvest" && u.resKind === res) return res === "lumber" || u.resId === mineId;
    if (u.inMine || u.inMineId) return res === "gold";
    // A wisp inside an Entangled Gold Mine is "on gold" while showing no harvest order at all
    // — its whole crew is cargo (`Aegm` Car1 = 5). See docs/night-elf.md.
    if (res === "gold" && u.garrisonHost) {
      const host = this.host.world.units.get(u.garrisonHost);
      if (host && host.mineId > 0) return true;
    }
    return false;
  }

  /**
   * "Go and work that mine" — which is a DIFFERENT ORDER for each race, and the mine says
   * which: three races walk into the shaft, the night elf climbs inside an Entangled Gold
   * Mine (a garrison), the undead kneels in a Haunted one's ring. Mirrors
   * `SimWorld.issueGoldWork`, but through the command funnel so the authority still judges it.
   */
  private sendToGold(u: SimUnit, mineId: number): boolean {
    const world = this.host.world;
    const mine = world.mines.get(mineId);
    if (!mine) return false;
    const host = mine.entangledBy > 0 ? world.units.get(mine.entangledBy) : undefined;
    if (host && host.garrisonCap > 0) {
      return this.host.execute(this.player, { c: "garrison", unitId: u.id, buildingId: host.id });
    }
    return this.host.execute(this.player, {
      c: "order", unitId: u.id, order: { kind: "harvest", res: "gold", nodeId: mineId }, queued: false,
    });
  }

  private sendToWood(u: SimUnit, town: Town): boolean {
    const tree = this.host.world.nearestTree(town.x, town.y, 3000);
    if (!tree) return false;
    return this.host.execute(this.player, {
      c: "order", unitId: u.id, order: { kind: "harvest", res: "lumber", nodeId: tree.id }, queued: false,
    });
  }

  // ======================================================================================
  //  Heroes — PickMeleeHero, SkillArrays
  // ======================================================================================

  /**
   * `PickMeleeHero(race)` — three of the race's four heroes, in a random order, drawn exactly
   * as common.ai draws them: pick one of `last`, swap the last into its slot, pick one of
   * `last-1`, and so on. (TFT makes `last` 4; Reign of Chaos made it 3.)
   */
  pickMeleeHero(heroes: readonly string[]): void {
    const pool = [...heroes];
    const last = pool.length; // 4 — VersionCompatible(VERSION_FROZEN_THRONE)
    const first = this.randomInt(1, last);
    const second = this.randomInt(1, last - 1);
    const third = this.randomInt(1, last - 2);
    this.heroId = pool[first - 1];
    pool[first - 1] = pool[last - 1];
    this.heroId2 = pool[second - 1];
    pool[second - 1] = pool[last - 2];
    this.heroId3 = pool[third - 1];
  }

  /** `SetSkillArray(index, id)` — record a hero's ten levels, but only under the hero this
   *  player actually drew for that slot (the scripts call it once per slot per hero type and
   *  the mismatched ones return without writing). */
  setSkillArray(index: number, heroType: string, skills: readonly string[]): void {
    const want = index === 1 ? this.heroId : index === 2 ? this.heroId2 : this.heroId3;
    if (want !== heroType) return;
    this.skills.set(heroType, [...skills]);
  }

  /**
   * `SetHeroLevels(SkillArrays)` — spend every hero's points down its own list.
   *
   * The list is what the script wrote; anything it names that this hero does not actually
   * carry (a renamed ability on a custom map, a mis-transcribed rawcode) falls through to the
   * first thing the hero CAN learn, so a hero never sits on unspent points.
   */
  spendSkillPoints(): void {
    for (const u of this.host.world.units.values()) {
      if (u.owner !== this.player || u.hp <= 0 || !u.isHero || u.skillPoints <= 0) continue;
      const list = this.skills.get(u.typeId) ?? [];
      const want = list[u.level - 1];
      if (want && this.host.execute(this.player, { c: "learnskill", unitId: u.id, abilityId: want })) continue;
      for (const ab of u.abilities) {
        if (this.host.execute(this.player, { c: "learnskill", unitId: u.id, abilityId: ab.id })) break;
      }
    }
  }

  // ======================================================================================
  //  The captain — the attack group (common.ai's Captain* natives)
  // ======================================================================================

  /** `InitAssaultGroup()` / `InitMeleeGroup()`. */
  initMeleeGroup(): void {
    this.assault = [];
  }

  /** `SetAssaultGroup(qty, max, id)`. */
  setAssaultGroup(qty: number, max: number, item: string): void {
    if (qty <= 0 && this.townCountDone(item) === 0) return;
    this.assault.push({ qty, max, item });
  }

  /** `SetMeleeGroup(id)` — take three quarters of what you have of this type, and the hero
   *  whatever happens. */
  setMeleeGroup(item: string): void {
    if (!item) return;
    if (item === this.heroId) this.setAssaultGroup(1, 9, item);
    else this.setAssaultGroup(Math.floor((this.townCountDone(item) * 3) / 4), 20, item);
  }

  /** The types (and counts) the current wave wants — read by the captain. */
  assaultRows(): readonly AssaultRow[] {
    return this.assault;
  }

  // ======================================================================================
  //  Bookkeeping
  // ======================================================================================

  /** Invalidate the per-pass census. Called at the top of each build/harvest pass, which is
   *  what `set_vars`' one-second loop does for the `c_*` globals. */
  refresh(): void {
    this.pass++;
    this.census.clear();
    this.censusStamp = this.pass;
    this.pruneTowns();
  }

  /** A town whose mine is dry (or has been taken) stops being a town — otherwise
   *  `TownWithMine` keeps sending miners at a hole in the ground. Town 0 is never dropped:
   *  it is the start location, and the scripts address it by index. */
  private pruneTowns(): void {
    for (let t = this.towns.length - 1; t >= 1; t--) {
      const mine = this.host.world.mines.get(this.towns[t].mineId);
      if (!mine || mine.gold <= 0) this.towns.splice(t, 1);
    }
  }

  townCountTotal(): number {
    return this.towns.length;
  }

  townAtIndex(i: number): { x: number; y: number } | null {
    return this.towns[i] ?? null;
  }

  /** Where the army musters and where it runs home to — the main base. */
  home(): { x: number; y: number } {
    return this.towns[0];
  }

  private foodCache: { used: number; made: number } | null = null;
  private foodStamp = -1;

  private foodOf(): { used: number; made: number } {
    if (this.foodStamp === this.pass && this.foodCache) return this.foodCache;
    let used = 0;
    let made = 0;
    for (const u of this.host.world.units.values()) {
      if (u.owner !== this.player || u.hp <= 0) continue;
      const def = this.host.registry.get(u.typeId);
      if (!def) continue;
      used += def.foodUsed;
      if (!u.building || u.building.constructionLeft <= 0) made += def.foodMade;
      for (const job of u.building?.queue ?? []) {
        if (job.kind === "unit") used += this.host.registry.get(job.unitId)?.foodUsed ?? 0;
      }
    }
    this.foodCache = { used, made };
    this.foodStamp = this.pass;
    return this.foodCache;
  }

  /** The census, built lazily per type and thrown away by `refresh`. */
  private censusOf(id: string): Census {
    if (this.censusStamp !== this.pass) {
      this.census.clear();
      this.censusStamp = this.pass;
    }
    const hit = this.census.get(id);
    if (hit) return hit;
    const c: Census = { all: 0, done: 0, allAt: new Map(), doneAt: new Map() };
    const bump = (map: Map<number, number>, town: number): void => {
      if (town >= 0) map.set(town, (map.get(town) ?? 0) + 1);
    };
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0) continue;
      const town = this.townAt(u.x, u.y);
      if (u.owner === this.player && u.typeId === id) {
        c.all++;
        bump(c.allAt, town);
        if (!u.building || u.building.constructionLeft <= 0) {
          c.done++;
          bump(c.doneAt, town);
        }
      }
      if (u.owner !== this.player) continue;
      // Jobs in this building's queue, and the structure this worker is on its way to raise:
      // both are already spoken for and must not be ordered a second time.
      for (const job of u.building?.queue ?? []) {
        if (job.unitId === id && (job.kind === "unit" || job.kind === "upgrade")) {
          c.all++;
          bump(c.allAt, town);
        }
      }
      if (u.buildPending?.defId === id) {
        c.all++;
        bump(c.allAt, this.townAt(u.buildPending.x, u.buildPending.y));
      }
      for (const o of u.orderQueue) {
        if (o.kind === "buildnew" && o.defId === id) {
          c.all++;
          bump(c.allAt, this.townAt(o.x, o.y));
        }
      }
    }
    for (const t of this.host.world.pendingTrained()) {
      if (t.owner === this.player && t.unitId === id) c.all++;
    }
    this.census.set(id, c);
    return c;
  }

  // ======================================================================================
  //  Targeting — SingleMeleeAttack's ladder
  // ======================================================================================

  /** `TownThreatened()` — an enemy fighting unit standing in one of our towns. */
  townThreatened(): boolean {
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || u.owner === this.player || !this.hostileTo(u)) continue;
      if (u.building || u.worker) continue;
      for (const t of this.towns) if (Math.hypot(u.x - t.x, u.y - t.y) <= TOWN_RADIUS) return true;
    }
    return false;
  }

  /** `GetEnemyBase()` — the nearest enemy hall (or, failing that, any enemy structure). */
  enemyBase(): SimUnit | null {
    const home = this.towns[0];
    let hall: SimUnit | null = null;
    let hallD = Infinity;
    let any: SimUnit | null = null;
    let anyD = Infinity;
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || !u.building || u.owner === this.player || u.owner < 0) continue;
      if (!this.hostileTo(u)) continue;
      const d = Math.hypot(u.x - home.x, u.y - home.y);
      if (u.depotGold && d < hallD) { hallD = d; hall = u; }
      if (d < anyD) { anyD = d; any = u; }
    }
    return hall ?? any;
  }

  /** `GetEnemyExpansion()` — an enemy hall that is NOT their nearest-to-home main: the one
   *  the scripts try to deny before committing to a base assault. */
  enemyExpansion(): SimUnit | null {
    const halls: Array<{ u: SimUnit; d: number }> = [];
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || !u.building || !u.depotGold || u.owner === this.player || u.owner < 0) continue;
      if (!this.hostileTo(u) || !this.knows(u)) continue;
      halls.push({ u, d: Math.hypot(u.x - this.towns[0].x, u.y - this.towns[0].y) });
    }
    if (halls.length < 2) return null;
    halls.sort((a, b) => a.d - b.d);
    // The FURTHEST from its owner's own start is the expansion; approximated here as "not the
    // one closest to us", which is the same hall on every symmetric melee map.
    return halls[0].u;
  }

  /** `IsTowered(target)` — is that hall under a tower's guns? */
  isTowered(target: SimUnit): boolean {
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || !u.building || u.owner === this.player) continue;
      if (!this.hostileTo(u) || u.weapons.length === 0 || !this.knows(u)) continue;
      if (Math.hypot(u.x - target.x, u.y - target.y) <= 900) return true;
    }
    return false;
  }

  /** `GetCreepCamp(min, max, flyers_ok)` — the nearest camp whose total level is in range. */
  creepCamp(min: number, max: number, flyersOk: boolean): { x: number; y: number; level: number } | null {
    const home = this.towns[0];
    let best: { x: number; y: number; level: number } | null = null;
    let bestD = Infinity;
    for (const camp of this.host.creepCamps()) {
      const alive = camp.members.filter((id) => {
        const u = this.host.world.units.get(id);
        return u && u.hp > 0;
      });
      if (!alive.length) continue;
      if (camp.level < min || camp.level > max) continue;
      if (!flyersOk && alive.some((id) => this.host.world.units.get(id)!.flying)) continue;
      const d = Math.hypot(camp.x - home.x, camp.y - home.y);
      // The camp's own combined LEVEL travels with it: it is the one number that says how hard
      // the camp is (green 1-9 / orange 10-19 / red 20+, the colours the minimap paints — see
      // game/minimapView.ts), and Computer+ prices its party against it both when it sets off
      // and while it is fighting (plus/power.ts). It is fixed map data and never re-derived.
      if (d < bestD) { bestD = d; best = { x: camp.x, y: camp.y, level: camp.level }; }
    }
    return best;
  }

  private nearestEnemyBuilding(x: number, y: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const u of this.host.world.units.values()) {
      if (u.hp <= 0 || !u.building || u.owner === this.player || u.owner < 0) continue;
      if (!this.hostileTo(u)) continue;
      const d = Math.hypot(u.x - x, u.y - y);
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  /**
   * Every unit of ours that could be commanded somewhere — alive, not a building, able to
   * move.
   *
   * **Workers are NOT excluded, and that is the Ghoul.** `undead.ai` names GHOUL in its
   * assault group and splits its ghouls between the wave and the forest by hand (`AG`/`WG`),
   * because a Ghoul is a lumberjack and a front-line melee unit in the same body. A filter
   * that dropped every `worker` therefore emptied the undead's wave down to its hero, and
   * left the one race whose opening IS six ghouls unable to field them. The captain only ever
   * takes what the assault rows asked for, so nothing else a worker could be gets swept up.
   */
  *army(): Generator<SimUnit> {
    for (const u of this.host.world.units.values()) {
      if (u.owner !== this.player || u.hp <= 0) continue;
      if (u.building || u.speed <= 0) continue;
      yield u;
    }
  }

  /**
   * The one production step that is not a build order: a rooted Tree of Life beside a free
   * gold mine wraps it (`Aent`).
   *
   * Night elf gold begins with Entangle and there is no "build an Entangled Gold Mine"
   * anywhere — `egol` is what the ability CREATES — so a build loop on its own would leave
   * every night elf computer with five wisps standing around a bare rock. The original engine
   * does this inside its own expansion handling; here it is a pass over our own halls, which
   * is the same rule stated where it can be seen. See docs/night-elf.md.
   *
   * It lives on `AiPlayer` — the LIBRARY layer — rather than on a scheduler because it is not
   * a strategy decision at all: both the classic melee AI and Computer+ have to do it, and
   * they have to do it identically.
   */
  entangleMines(): void {
    const world = this.host.world;
    for (const u of world.units.values()) {
      if (u.owner !== this.player || u.hp <= 0 || !u.building || u.uprooted) continue;
      if (u.building.constructionLeft > 0) continue;
      if (!u.abilities.some((a) => a.code === "Aent")) continue;
      if (u.order === "cast") continue; // already throwing its roots — a re-issue restarts it
      // `Aent` is a no-target cast that takes the nearest un-entangled mine inside its own
      // Rng1 — so the only question here is whether there is one.
      const mine = world.nearestMine(u.x, u.y, ENTANGLE_RANGE);
      if (!mine || mine.entangledBy > 0 || mine.gold <= 0) continue;
      this.order({ c: "cast", unitId: u.id, code: "Aent", targetId: 0, x: 0, y: 0, queued: false });
    }
  }

  order(cmd: Command): boolean {
    return this.host.execute(this.player, cmd);
  }
}

/** `Aent` Entangle Gold Mine's own `Rng1`. The bound `EXPANSION_HALL_RANGE` is chosen under. */
const ENTANGLE_RANGE = 500;

/** A footprint one cell bigger on every side, with the whole border unbuildable. See
 *  `AiPlayer.spiral` for why placement is asked of this rather than of the real thing. */
function inflate(fp: Footprint): Footprint {
  const w = fp.w + 2;
  const h = fp.h + 2;
  const buildBlocked = new Array<boolean>(w * h).fill(true);
  return { w, h, blocked: buildBlocked, buildBlocked };
}

/** The AI's own Park–Miller stream (see the constructor for why it is not the sim's). */
function lcg(seed: number): () => number {
  let s = Math.abs(Math.floor(seed)) % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export { RETREAT_HP_FRACTION, REGROUP_HP_FRACTION, TOWN_RADIUS };
