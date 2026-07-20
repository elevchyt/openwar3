import type { SimWorld, SimMine } from "../sim/world";
import type { EngineHooks } from "../jass/runtime";
import { MELEE } from "../data/gameplayConstants";
import { fogStateOf, type FogState } from "../sim/vision";
import type { FogArea } from "./fog";

/**
 * The id space gold mines occupy when a SCRIPT is looking at them.
 *
 * A mine is not a `SimUnit` for us — it lives in `SimWorld.mines`, its own table — but to JASS
 * it IS a unit, and that fiction is load-bearing rather than cosmetic: `blizzard.j`'s
 * `MeleeFindNearestMine` enumerates units, keeps the nearest `'ngol'`, and clumps the starting
 * workers 320 units off it. Break the fiction and every melee start places its workers at the
 * map origin.
 *
 * So mines are handed out as `MINE_ID_BASE + mine.id` and recognised on the way back in. The
 * base lives here, with the bridge that invents it, because five natives and the renderer's
 * enumeration all have to agree on it — it used to be a `private static` on the renderer, which
 * meant the convention was owned by the one participant that could not be the authority.
 */
export const MINE_ID_BASE = 1_000_000;

/**
 * The mine behind a script's unit handle, or undefined if that handle is a real unit.
 *
 * Takes the narrowest thing that can answer — a map of mines — rather than `SimWorld`, so the
 * renderer can hand it `simView` and not widen its grip on the world just to resolve a handle.
 * `ReadonlyMap` still lets `setResourceAmount` write `mine.gold`: the map cannot gain or lose
 * mines through here, which is the part that matters.
 */
export function mineForScript(world: { readonly mines: ReadonlyMap<number, SimMine> }, unitId: number): SimMine | undefined {
  if (unitId < MINE_ID_BASE) return undefined;
  return world.mines.get(unitId - MINE_ID_BASE);
}

// The half of the JASS `EngineHooks` table that is pure world (docs/multiplayer.md Phase E item 1).
//
// `MapViewerScene.textHooks()` builds all 149 entries inside the RENDERER. That is the last of the
// `simWorld` escape hatch: 66 of the 70 remaining `simWorld` uses in mapViewer.ts are JASS natives
// mutating the authoritative world from a file whose job is to draw. The interpreter runs on the
// AUTHORITY, once (docs/multiplayer.md "JASS"), so a headless host needs a hook table — and today
// one can only be built by something holding a WebGL context.
//
// Everything here needs `SimWorld` and NOTHING else: no renderer, no DOM, no registries, no
// `RtsController`. That is the whole selection rule, and it is why this file compiles standalone.
// The entries that did NOT come across are the ones whose bodies genuinely read something else,
// and each is a different reason rather than one:
//
//   * `getUnitX`/`getUnitY`/`getResourceAmount`/`createBlightedGoldMine` fall back to the gold-mine
//     table, which is map-placement state the renderer owns.
//   * `createUnit`/`removeUnit`/`killUnit`/`issueUnitOrder` route through `RtsController`, which
//     owns spawning and the order funnel.
//   * selection, camera, sound, weather, effects, text and the registries are presentation by
//     nature and belong to whoever is drawing.
//
// The player-resource pair (`setPlayerState`/`getPlayerState`) is NOT here either, and for a
// third reason again: their answer is the authority's rather than the raw world's. They live in
// `authorityHooks` at the bottom of this file.
//
// Composition is a spread: every `EngineHooks` member is optional, so the renderer merges this
// table with its own and the compiler still checks both halves against the same interface.
//
// `teamOf` is the one thing the world half cannot answer for itself. `SetUnitOwner` has to write
// a TEAM alongside the new owner — the sim decides allegiance and vision by team, not by slot —
// and the slot→team seating is the LOBBY's, which the world does not carry. It is injected rather
// than looked up so that both callers can supply the mapping they actually have: the renderer
// passes its `meleeTeams` lookup, a headless host passes `MeleeConfig.slots`. See item 1c-note in
// docs/multiplayer.md — that this mapping has no authority-side owner at all is a real finding,
// and a separate one.
export function simHooks(sim: SimWorld, teamOf: (player: number) => number): Partial<EngineHooks> {
  return {
    // --- the two DUAL-WRITERS, sim half only -------------------------------------------------
    //
    // `SetUnitOwner` and `SetUnitFlyHeight` each write two systems: the world, and the model
    // standing in it (a re-tint of the team-coloured parts; the render lift). Only the world half
    // is here. The renderer re-declares both AFTER spreading this table and calls back into these
    // entries, so the model half decorates the world half instead of replacing it — which is why
    // these are the only two keys that legitimately appear on both sides of the split.
    //
    // A headless host spreads this table and declares nothing over it: it gets the world write
    // and there is no model to re-tint, which is the correct behaviour rather than a gap.
    setUnitOwner: (id, player) => sim.setUnitOwner(id, player, teamOf(player)),
    setUnitFlyHeight: (id, height) => sim.setUnitFlyHeight(id, height),
    // --- unit lifecycle (7.7) ----------------------------------------------------------------
    //
    // Both are one line into the sim, which is the finding: the list had `removeUnit` filed as
    // "entangled with model seeding", and it never was — `RtsController.removeUnit` was a bare
    // pass-through to `sim.removeUnit`. Only `createUnit` is genuinely entangled, because
    // spawning has to load a model.
    killUnit: (id) => sim.killUnit(id),
    // A gold mine isn't a sim unit for us, so RemoveUnit can't take it off the map — and the only
    // caller that tries is the Undead start's mine swap, which puts one straight back (see
    // createBlightedGoldMine). Leaving it standing IS the swap.
    removeUnit: (id) => {
      if (mineForScript(sim, id)) return;
      sim.removeUnit(id);
    },
    // --- gold mines, which are units only to a script (see MINE_ID_BASE) --------------------
    //
    // Position reads fall back to the mine table because `MeleeGetProjectedLoc` measures the
    // hall/worker clump off `GetUnitLoc(nearestMine)`. `undefined` (not 0) when the unit is
    // gone — the native then reads the handle's last-known value instead of the map origin.
    // See SimWorld.getUnitX.
    getUnitX: (id) => mineForScript(sim, id)?.x ?? sim.getUnitX(id),
    getUnitY: (id) => mineForScript(sim, id)?.y ?? sim.getUnitY(id),
    getResourceAmount: (id) => mineForScript(sim, id)?.gold ?? 0,
    setResourceAmount: (id, amount) => {
      const mine = mineForScript(sim, id);
      if (mine) mine.gold = amount;
    },
    // The Undead start's mine swap: our engine has no haunted mine, so hand back the one still
    // standing at (x, y) — `RemoveUnit` deliberately left it alone (see the renderer's
    // removeUnit). Acolytes then clump around a real mine instead of a null location.
    createBlightedGoldMine: (_player, x, y) => {
      let best: SimMine | undefined;
      let bestD = MELEE.MELEE_MINE_SEARCH_RADIUS ** 2;
      for (const m of sim.mines.values()) {
        const d = (m.x - x) ** 2 + (m.y - y) ** 2;
        if (d <= bestD) {
          bestD = d;
          best = m;
        }
      }
      return best ? MINE_ID_BASE + best.id : -1;
    },
    // Unit state: SetUnitState/GetUnitState → sim HP/mana. state: 0=life 1=maxlife 2=mana 3=maxmana.
    setUnitState: (id, state, value) => {
      const u = sim.units.get(id);
      if (!u) return;
      if (state === 0) u.hp = Math.max(0, Math.min(u.maxHp, value));
      else if (state === 1) u.maxHp = Math.max(1, value);
      else if (state === 2) u.mana = Math.max(0, Math.min(u.maxMana, value));
      else if (state === 3) u.maxMana = Math.max(0, value);
    },
    getUnitState: (id, state) => {
      const u = sim.units.get(id);
      if (!u) return 0;
      return state === 0 ? u.hp : state === 1 ? u.maxHp : state === 2 ? u.mana : state === 3 ? u.maxMana : 0;
    },
    // --- unit-mutation effects (7.7 cont.) — a trigger visibly moves/alters a unit ---
    setUnitPosition: (id, x, y) => sim.setUnitPosition(id, x, y),
    setUnitFacing: (id, rad, instant) => sim.setUnitFacing(id, rad, instant),
    pauseUnit: (id, flag) => sim.pauseUnit(id, flag),
    isUnitPaused: (id) => sim.isUnitPaused(id),
    getUnitFlyHeight: (id) => sim.getUnitFlyHeight(id),
    setUnitMoveSpeed: (id, speed) => sim.setUnitMoveSpeed(id, speed),
    getUnitMoveSpeed: (id) => sim.getUnitMoveSpeed(id),
    setUnitTurnSpeed: (id, turn) => sim.setUnitTurnSpeed(id, turn),
    getUnitFacing: (id) => sim.getUnitFacing(id),
    // --- way gates (7.22) ---
    waygateSetDestination: (id, x, y) => sim.setWaygateDestination(id, x, y),
    waygateActivate: (id, active) => sim.waygateActivate(id, active),
    waygateDestination: (id) => sim.waygateDestination(id),
    waygateIsActive: (id) => sim.waygateIsActive(id),
    // --- the day/night clock ---
    // MeleeStartingVisibility opens a melee game at 08:00 (bj_MELEE_STARTING_TOD). These two
    // WRITE `timeOfDay`/`dawnDusk`, which is why Phase B 7a deliberately kept them off the
    // read-only `SimView` — a `readonly` type caught that, and it stays true here.
    setTimeOfDay: (hour) => {
      sim.timeOfDay = hour;
    },
    getTimeOfDay: () => sim.timeOfDay,
    setDawnDusk: (enable) => {
      sim.dawnDusk = enable;
    },
    isDawnDuskEnabled: () => sim.dawnDusk,
    // --- the tech tree (issue #57) ---
    playerTechCount: (player, tech) => sim.tech?.count(player, tech) ?? 0,
    setPlayerTechResearched: (player, tech, level) => sim.tech?.setResearchLevel(player, tech, level),
    setPlayerTechMaxAllowed: (player, tech, max) => sim.tech?.setMaxAllowed(player, tech, max),
    // --- abilities + heroes (7.17): a trigger grants a spell / levels a hero ---
    unitAddAbility: (id, abilityId) => sim.addAbility(id, abilityId),
    unitRemoveAbility: (id, abilityId) => sim.removeAbility(id, abilityId),
    getUnitAbilityLevel: (id, abilityId) => sim.abilityLevelOf(id, abilityId),
    setUnitAbilityLevel: (id, abilityId, level) => sim.setAbilityLevel(id, abilityId, level),
    selectHeroSkill: (id, abilityId) => sim.learnAbility(id, abilityId),
    resetUnitCooldown: (id) => sim.resetCooldowns(id),
    getUnitLevel: (id) => sim.units.get(id)?.level ?? 0,
    setHeroLevel: (id, level) => sim.setHeroLevel(id, level),
    getHeroXp: (id) => sim.units.get(id)?.xp ?? 0,
    setHeroXp: (id, xp) => sim.setHeroXp(id, xp),
    addHeroXp: (id, xp) => sim.addHeroXp(id, xp),
    getHeroSkillPoints: (id) => sim.units.get(id)?.skillPoints ?? 0,
    modifySkillPoints: (id, delta) => sim.modifySkillPoints(id, delta),
    // --- per-unit flags (7.17) ---
    // `setUnitAnimation` is NOT here: an animation is a model's, not the world's.
    setUnitInvulnerable: (id, flag) => sim.setInvulnerable(id, flag),
    setUnitPathing: (id, flag) => sim.setPathing(id, flag),
    // --- items (7.18): a trigger creates/gives/drops/uses an item ---
    // The sim already owns the item system (ground items, hero inventories, charges, powerups,
    // item abilities), so each of these is a one-line bridge into it. A trigger-created item is
    // spawned through the sim's normal ground-item queue, so the renderer models it
    // (drainItemSpawns) and a hero can walk over and pick it up.
    //
    // `itemTypeInfo` and `chooseRandomItem` stayed behind: both read the ItemRegistry (with the
    // custom .w3t overlay), which is a data table rather than world state.
    createItem: (typeId, x, y) => sim.createItem(typeId, x, y),
    removeItem: (id) => void sim.removeItemById(id),
    itemInfo: (id) => sim.itemSnapshot(id),
    setItemCharges: (id, charges) => void sim.setItemCharges(id, charges),
    setItemPosition: (id, x, y) => void sim.setItemPosition(id, x, y),
    unitAddItem: (unitId, itemId, slot) => sim.unitAddItem(unitId, itemId, slot),
    unitRemoveItem: (unitId, itemId) => sim.unitRemoveItem(unitId, itemId),
    unitRemoveItemFromSlot: (unitId, slot) => sim.unitRemoveItemFromSlot(unitId, slot),
    unitDropItemPoint: (unitId, itemId, x, y) => sim.unitDropItemPoint(unitId, itemId, x, y),
    unitDropItemSlot: (unitId, itemId, slot) => sim.unitDropItemSlot(unitId, itemId, slot),
    unitDropItemTarget: (unitId, itemId, targetId) => sim.unitDropItemTarget(unitId, itemId, targetId),
    unitUseItem: (unitId, itemId, targetId, x, y) => sim.unitUseItem(unitId, itemId, targetId, x, y),
    unitInventorySize: (unitId) => sim.inventorySizeOf(unitId),
    unitItemInSlot: (unitId, slot) => sim.itemInSlot(unitId, slot),
    enumItems: () =>
      sim.groundItems().map((it) => ({ id: it.id, typeId: it.itemId, charges: it.charges, x: it.x, y: it.y, holder: 0, slot: -1, owner: 15 })),
    // Neutral-building stock (issue #57): Blizzard.j stocks the Marketplace itself, off its own
    // 30s timer — these just hand its natives the shelves. See src/jass/natives/stock.ts.
    addToStock: (shopId, wareId, kind, count, max) => void sim.addToStock(shopId, wareId, kind, count, max),
    removeFromStock: (shopId, wareId) => void sim.removeFromStock(shopId, wareId),
    setTypeSlots: (shopId, kind, slots) => void sim.setTypeSlots(shopId, kind, slots),
    setAllTypeSlots: (kind, slots) => void sim.setAllTypeSlots(kind, slots),
  };
}

// The natives whose answer is the AUTHORITY'S, not the raw world's.
//
// The distinction is not pedantry, and `getPlayerState` is the case that shows why. Food is
// not stored anywhere: `Authority.foodFor` derives it by walking the units and reading each
// one's registry row, and it was the bug Phase B 6a found — the old body iterated the
// renderer's `Entry` records, so a headless host would have handed every player infinite
// supply. Gold and lumber come back through `stashFor`, the FROZEN copy, because a reader has
// no business holding the live object. Only the write takes the live stash, and only through
// the one named method that is allowed to.
//
// This is also where JASS's `PLAYER_STATE` numbering stops. `Authority.setPlayerResource`
// takes "gold" | "lumber"; the 1/2/4/5 encoding is the interpreter's business and it ends
// here, at the seam, rather than leaking into the authority.
export function authorityHooks(authority: {
  stashFor(owner: number): Readonly<{ gold: number; lumber: number }>;
  foodFor(owner: number): { used: number; made: number };
  setPlayerResource(player: number, resource: "gold" | "lumber", value: number): void;
  currentOrderId(unitId: number): number;
  issueUnitOrder(
    unitId: number,
    orderId: number,
    order: string,
    kind: "immediate" | "point" | "target",
    x: number,
    y: number,
    targetId: number,
  ): boolean;
}): Partial<EngineHooks> {
  return {
    // Orders (7.14): trigger issue → the sim; current order ← the sim.
    //
    // `issueUnitOrder` is on `Authority` rather than in `simHooks` because it is not a plain sim
    // write: it first asks `castOrder` whether the order string names one of the unit's own
    // ABILITIES, and only falls through to move/attack/patrol/hold if not. That question is the
    // authority's, and its answer lives next to `execute` for the same reason.
    //
    // It is deliberately NOT gated on ownership and is NOT a hole in the command funnel — see
    // the method's own comment. A trigger order is an effect of the authoritative sim, not an
    // input to it.
    issueUnitOrder: (id, orderId, order, kind, x, y, targetId) =>
      authority.issueUnitOrder(id, orderId, order, kind, x, y, targetId),
    getUnitCurrentOrder: (id) => authority.currentOrderId(id),
    // SetPlayerState → the live stash, via the authority's named setter. This is what grants a
    // custom map its starting gold/lumber (its init triggers set it). Food is derived from
    // units, so states 4 and 5 are read-only and a write to them is ignored rather than
    // invented. state: 1=gold 2=lumber 4=cap 5=used.
    setPlayerState: (p, state, value) => {
      if (state === 1) authority.setPlayerResource(p, "gold", value);
      else if (state === 2) authority.setPlayerResource(p, "lumber", value);
    },
    getPlayerState: (p, state) => {
      if (state === 1) return Math.floor(authority.stashFor(p).gold);
      if (state === 2) return Math.floor(authority.stashFor(p).lumber);
      if (state === 4) return authority.foodFor(p).made; // FOOD_CAP
      if (state === 5) return authority.foodFor(p).used; // FOOD_USED
      return 0;
    },
  };
}

// The natives about who can SEE what, and who counts as whose ally (docs/multiplayer.md
// Phase E item 1e).
//
// These were the largest block still routed through `RtsController`, and the reason given was
// that the fog-modifier registry had to stay there: modifier ids are one global handle space
// shared with JASS, so N viewpoints minting their own would collide. That is true — and it is an
// argument against putting the registry on a `Viewpoint`, not against putting it on the
// `VisionSet`, which is a single object that owns all of them. Once it moved there, nothing in
// this group needed a controller at all.
//
// `cripplePlayer` and `setFogState` are stated in terms of a RECIPIENT rather than "local", which
// is what Phase D item 4 already fixed inside the set; this just stops routing them through an
// object that also holds a camera.
export function visionHooks(
  vision: {
    createFogModifier(m: { player: number; state: number; area: FogArea }): number;
    fogModifierStart(id: number): void;
    fogModifierStop(id: number): void;
    destroyFogModifier(id: number): void;
    stampFor(player: number, area: FogArea, state: FogState): void;
    setExposed(recipient: number, player: number, flag: boolean): void;
    setFogEnabled(on: boolean): void;
    setFogMaskEnabled(on: boolean): void;
    isFogEnabled(): boolean;
    isFogMaskEnabled(): boolean;
  },
  alliances: {
    set(source: number, other: number, type: number, value: boolean): void;
    get(source: number, other: number, type: number): boolean;
    coAllied(a: number, b: number): boolean;
  },
): Partial<EngineHooks> {
  return {
    // --- alliances + shared vision (7.22) ---
    // IsPlayerAlly reads the alliance MATRIX, not the raw lobby team — a script that allies two
    // players from different teams changes both, which is the whole point of the native.
    isPlayerAlly: (p, q) => alliances.coAllied(p, q),
    setPlayerAlliance: (src, other, type, value) => alliances.set(src, other, type, value),
    getPlayerAlliance: (src, other, type) => alliances.get(src, other, type),
    // CripplePlayer — blizzard.j's MeleeExposePlayer, what happens to a player whose "Build
    // Town Hall" timer runs out. Every recipient in the force is told, not just this machine's
    // player: the old early-out was correct while one viewpoint was rendered and silently wrong
    // the moment the authority answers for somebody else.
    cripplePlayer: (player, toPlayers, flag) => {
      for (const recipient of toPlayers) vision.setExposed(recipient, player, flag);
    },
    // --- fog of war: script-placed modifiers (7.22) ---
    createFogModifier: (player, state, area) => vision.createFogModifier({ player, state, area }),
    fogModifierStart: (id) => vision.fogModifierStart(id),
    fogModifierStop: (id) => vision.fogModifierStop(id),
    destroyFogModifier: (id) => vision.destroyFogModifier(id),
    // SetFogStateRect / SetFogStateRadius[Loc] — a ONE-SHOT stamp, not a standing modifier. On a
    // `visible` layer rebuilt every tick a one-shot VISIBLE only *lights* the area for an
    // instant; the lasting effect is on sticky `explored`, so the area ends up discovered (grey),
    // and a one-shot MASKED un-discovers it. A script that wants an area held open uses a
    // modifier — which is exactly the distinction the two APIs exist to draw.
    setFogState: (player, state, area) => vision.stampFor(player, area, fogStateOf(state)),
    // FogEnable / FogMaskEnable — the grey veil and the black mask. Global natives, and now
    // actually global: every viewpoint gets the switch rather than only the local one.
    fogEnable: (flag) => vision.setFogEnabled(flag),
    fogMaskEnable: (flag) => vision.setFogMaskEnabled(flag),
    isFogEnabled: () => vision.isFogEnabled(),
    isFogMaskEnabled: () => vision.isFogMaskEnabled(),
  };
}
