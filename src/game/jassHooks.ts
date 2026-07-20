import type { SimWorld } from "../sim/world";
import type { EngineHooks } from "../jass/runtime";

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
//   * `setUnitFlyHeight` writes the sim AND the render lift; `setUnitOwner` writes the sim AND
//     re-tints the model. Two systems in one native — they cannot move until the presentation
//     half has a seam of its own.
//   * `getUnitX`/`getUnitY`/`getResourceAmount`/`createBlightedGoldMine` fall back to the gold-mine
//     table, which is map-placement state the renderer owns.
//   * `createUnit`/`removeUnit`/`killUnit`/`issueUnitOrder` route through `RtsController`, which
//     owns spawning and the order funnel.
//   * `getPlayerState` reads `stashFor`/`foodFor` — the frozen-copy accessors on `Authority`, not
//     the live stash. It stays put deliberately; see `setPlayerState` below.
//   * selection, camera, sound, weather, effects, text and the registries are presentation by
//     nature and belong to whoever is drawing.
//
// Composition is a spread: every `EngineHooks` member is optional, so the renderer merges this
// table with its own and the compiler still checks both halves against the same interface.
export function simHooks(sim: SimWorld): Partial<EngineHooks> {
  return {
    // Player resources: SetPlayerState/GetPlayerState → the sim stash. This is what grants a
    // custom map its starting gold/lumber (its init triggers set it). Food is derived from
    // units, so it's read-only. state: 1=gold 2=lumber 4=cap 5=used.
    //
    // This is the last live-stash WRITE that used to live in the renderer, and it is legitimate:
    // a JASS native is the authority acting, not a client spending. It reads the live stash
    // rather than `Authority.stashFor`'s frozen copy for exactly that reason. Promoting it to a
    // named `Authority` method is still worth doing (docs/multiplayer.md Phase E item 1) — but
    // that is a second change, and getting it out of the renderer is this one.
    setPlayerState: (p, state, value) => {
      if (state === 1) sim.stashOf(p).gold = value;
      else if (state === 2) sim.stashOf(p).lumber = value;
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
