import type { AiPlayer } from "./aiPlayer";
import type { MeleeScript } from "./script";
import {
  ARCANE_TOWER, ARCANE_VAULT, ARCHMAGE, AVATAR, AVIARY, BANISH, BARRACKS, BASH, BLACKSMITH,
  BLIZZARD, BLOOD_MAGE, BRILLIANCE_AURA, CASTLE, COPTER, DEVOTION_AURA, DIVINE_SHIELD,
  FLAME_STRIKE, FOOTMAN, GRYPHON, GUARD_TOWER, HOLY_BOLT, HOUSE, HUMAN_ALTAR,
  HUMAN_DRAGON_HAWK, KEEP, KNIGHT, LUMBER_MILL, MASS_TELEPORT, MELEE_NEWBIE, MORTAR, MTN_KING,
  PALADIN, PEASANT, PRIEST, RESURRECTION, RIFLEMAN, SANCTUM, SIPHON_MANA, SORCERESS,
  SPELL_BREAKER, SUMMON_PHOENIX, TANK, THUNDER_BOLT, THUNDER_CLAP, TOWN_HALL, UPG_ARMOR,
  UPG_BOMBS, UPG_BREEDING, UPG_CLOUD, UPG_CONT_MAGIC, UPG_DEFEND, UPG_FLAK, UPG_FRAGS,
  UPG_GUN_RANGE, UPG_HAMMERS, UPG_LEATHER, UPG_MASONRY, UPG_MELEE, UPG_PRAYING, UPG_RANGED,
  UPG_SENTINEL, UPG_SORCERY, UPG_TANK, UPG_WOOD, UPKEEP_TIER1, UPKEEP_TIER2, WATCH_TOWER,
  WATER_ELEMENTAL, WORKSHOP,
} from "./ids";

// `Scripts\human.ai` (v1.15, 2003/04/23), ported function for function. The `c_*` globals
// `set_vars` refreshed once a second are read live here instead (see MeleeScript); everything
// else — every count, every threshold, every `SetBuildUnit` in its original order — is the
// file's.

/** `set_skills` — human.ai 51–110. */
function setSkills(ai: AiPlayer): void {
  const paladin = [HOLY_BOLT, DEVOTION_AURA, HOLY_BOLT, DIVINE_SHIELD, HOLY_BOLT, RESURRECTION,
    DEVOTION_AURA, DEVOTION_AURA, DIVINE_SHIELD, DIVINE_SHIELD];
  const mtnKing = [THUNDER_BOLT, BASH, THUNDER_BOLT, THUNDER_CLAP, THUNDER_BOLT, AVATAR,
    BASH, BASH, THUNDER_CLAP, THUNDER_CLAP];
  const archmage = [WATER_ELEMENTAL, BRILLIANCE_AURA, WATER_ELEMENTAL, BLIZZARD, WATER_ELEMENTAL,
    MASS_TELEPORT, BRILLIANCE_AURA, BRILLIANCE_AURA, BLIZZARD, BLIZZARD];
  const bloodMage = [FLAME_STRIKE, SIPHON_MANA, FLAME_STRIKE, SIPHON_MANA, FLAME_STRIKE,
    SUMMON_PHOENIX, SIPHON_MANA, BANISH, BANISH, BANISH];
  for (const slot of [1, 2, 3]) {
    ai.setSkillArray(slot, PALADIN, paladin);
    ai.setSkillArray(slot, MTN_KING, mtnKing);
    ai.setSkillArray(slot, ARCHMAGE, archmage);
    ai.setSkillArray(slot, BLOOD_MAGE, bloodMage);
  }
}

/** `setup_force` — human.ai 115–136. */
function setupForce(ai: AiPlayer): void {
  ai.initMeleeGroup();
  ai.setMeleeGroup(ai.heroId);
  ai.setMeleeGroup(ai.heroId2);
  ai.setMeleeGroup(ai.heroId3);
  ai.setMeleeGroup(FOOTMAN);
  ai.setMeleeGroup(KNIGHT);
  ai.setMeleeGroup(RIFLEMAN);
  ai.setMeleeGroup(PRIEST);
  ai.setMeleeGroup(SORCERESS);
  ai.setMeleeGroup(GRYPHON);
  ai.setMeleeGroup(COPTER);
  ai.setMeleeGroup(SPELL_BREAKER);
  ai.setMeleeGroup(HUMAN_DRAGON_HAWK);
}

/** `force_level` — human.ai 141–148. */
function forceLevel(ai: AiPlayer): number {
  let level = 4; // basic hero
  level += 2 * (ai.countDone(FOOTMAN) + ai.countDone(PRIEST) + ai.countDone(SORCERESS) + ai.countDone(SPELL_BREAKER));
  level += 3 * (ai.countDone(RIFLEMAN) + ai.countDone(GRYPHON) + ai.countDone(HUMAN_DRAGON_HAWK));
  level += 5 * (ai.countDone(ai.heroId3) + ai.countDone(KNIGHT));
  level += 6 * ai.countDone(ai.heroId2);
  return level;
}

/** `do_upgrades` — human.ai 249–330. */
function doUpgrades(ai: AiPlayer): void {
  const keepDone = ai.townCountDone(KEEP);
  const castleDone = ai.townCountDone(CASTLE);
  const smithDone = ai.countDone(BLACKSMITH);
  const millDone = ai.countDone(LUMBER_MILL);
  const sanctumDone = ai.countDone(SANCTUM);
  const knightsOk = castleDone >= 1 && millDone >= 1 && smithDone >= 1;

  if (keepDone >= 1) {
    ai.setBuildUpgr(1, UPG_WOOD);
    if (castleDone >= 1) ai.setBuildUpgr(2, UPG_WOOD);
    if (knightsOk) ai.setBuildUpgr(1, UPG_BREEDING);
    if (sanctumDone >= 1) {
      if (ai.countDone(PRIEST) >= 1) ai.setBuildUpgr(1, UPG_PRAYING);
      if (ai.countDone(SORCERESS) >= 1) ai.setBuildUpgr(1, UPG_SORCERY);
    }
    if (castleDone >= 1) {
      ai.setBuildUpgr(2, UPG_WOOD);
      if (sanctumDone >= 1) {
        if (ai.countDone(PRIEST) >= 1) ai.setBuildUpgr(2, UPG_PRAYING);
        if (ai.countDone(SORCERESS) >= 1) ai.setBuildUpgr(2, UPG_SORCERY);
      }
    }
  }

  ai.setBuildUpgr(1, UPG_DEFEND);

  if (smithDone >= 1) {
    ai.setBuildUpgr(1, UPG_ARMOR);
    ai.setBuildUpgr(1, UPG_MELEE);
    ai.setBuildUpgr(1, UPG_RANGED);
    ai.setBuildUpgr(1, UPG_LEATHER);
    if (keepDone >= 1) {
      ai.setBuildUpgr(2, UPG_ARMOR);
      ai.setBuildUpgr(2, UPG_MELEE);
      ai.setBuildUpgr(2, UPG_RANGED);
      ai.setBuildUpgr(2, UPG_LEATHER);
      if (castleDone >= 1) {
        ai.setBuildUpgr(3, UPG_ARMOR);
        ai.setBuildUpgr(3, UPG_MELEE);
        ai.setBuildUpgr(3, UPG_RANGED);
        ai.setBuildUpgr(3, UPG_LEATHER);
      }
    }
  }

  if (ai.countDone(RIFLEMAN) >= 1 && castleDone >= 1) ai.setBuildUpgr(1, UPG_GUN_RANGE);
  if (ai.countDone(WORKSHOP) >= 1 && ai.countDone(MORTAR) >= 1) ai.setBuildUpgr(1, UPG_FRAGS);

  if (millDone >= 1) {
    ai.setBuildUpgr(1, UPG_MASONRY);
    if (keepDone >= 1) ai.setBuildUpgr(2, UPG_MASONRY);
  }

  if (ai.countDone(WORKSHOP) >= 1 && ai.countDone(COPTER) >= 1) {
    if (castleDone >= 1) ai.setBuildUpgr(1, UPG_FLAK);
    ai.setBuildUpgr(1, UPG_BOMBS);
  }

  if (ai.countDone(AVIARY) >= 1 && ai.countDone(GRYPHON) >= 1) ai.setBuildUpgr(1, UPG_HAMMERS);
  if (sanctumDone >= 1 && ai.countDone(SPELL_BREAKER) >= 1) ai.setBuildUpgr(1, UPG_CONT_MAGIC);
  if (ai.countDone(AVIARY) >= 1 && ai.countDone(HUMAN_DRAGON_HAWK) >= 1) ai.setBuildUpgr(1, UPG_CLOUD);
  if (ai.countDone(WORKSHOP) >= 1 && ai.countDone(TANK) >= 1) ai.setBuildUpgr(1, UPG_TANK);
}

/** `build_sequence` — human.ai 335–537. */
function buildSequence(ai: AiPlayer): void {
  const newbie = ai.meleeDifficulty() === MELEE_NEWBIE;
  ai.initBuildArray();

  if (ai.basicOpening) {
    ai.meleeTownHall(0, TOWN_HALL);
    ai.meleeTownHall(1, TOWN_HALL);

    ai.setBuildUnit(6, PEASANT);
    ai.setBuildUnit(1, HUMAN_ALTAR);
    ai.setBuildUnit(7, PEASANT);
    ai.setBuildUnit(1, HOUSE);
    ai.setBuildUnit(1, BARRACKS);
    ai.setBuildUnit(9, PEASANT);
    ai.setBuildUnit(2, HOUSE);
    ai.setBuildUnit(1, ai.heroId);
    ai.setBuildUnit(11, PEASANT);
    ai.setBuildUnit(1, FOOTMAN);
    ai.setBuildUnit(3, HOUSE);
    ai.setBuildUnit(12, PEASANT);
    ai.setBuildUnit(2, FOOTMAN);
    ai.setBuildUnit(13, PEASANT);
    ai.setBuildUnit(3, FOOTMAN);
    ai.setBuildUnit(14, PEASANT);
    ai.setBuildUnit(4, HOUSE);
    ai.setBuildUnit(15, PEASANT);
    ai.setBuildUnit(4, FOOTMAN);
    ai.setBuildUnit(16, PEASANT);
    ai.setBuildUnit(5, FOOTMAN);
    ai.setBuildUnit(1, BLACKSMITH);
    ai.setBuildUnit(6, FOOTMAN);
    ai.setBuildUnit(5, HOUSE);
    ai.setBuildUnit(8, FOOTMAN);
    ai.setBuildUnit(6, HOUSE);
    ai.setBuildUnit(2, RIFLEMAN);
    ai.setBuildUnit(7, HOUSE);
    ai.setBuildUnit(3, RIFLEMAN);
    ai.setBuildUnit(1, ARCANE_VAULT);

    ai.basicExpansion(ai.minesOwned() < 2, TOWN_HALL);

    ai.setBuildUnit(4, RIFLEMAN);
    ai.setBuildUnit(1, LUMBER_MILL);

    if (!newbie) {
      ai.guardSecondary(1, 2, WATCH_TOWER);
      if (ai.countDone(LUMBER_MILL) >= 1) ai.guardSecondary(1, 1, GUARD_TOWER);
      if (ai.countDone(WATCH_TOWER) >= 1) ai.guardSecondary(1, 1, ARCANE_TOWER);
    }

    ai.setBuildUnit(1, KEEP);
    ai.setBuildUpgr(1, UPG_DEFEND);
    ai.setBuildUpgr(1, UPG_ARMOR);
    ai.setBuildUnit(7, HOUSE);
    ai.setBuildUpgr(1, UPG_MELEE);

    if (ai.townCountDone(KEEP) < 1) return;

    ai.setBuildUnit(1, WORKSHOP);
    if (!newbie) ai.setBuildUnit(1, ai.heroId2);
    ai.setBuildUnit(1, CASTLE);

    ai.guardSecondary(0, 2, WATCH_TOWER);
    if (ai.countDone(WATCH_TOWER) >= 3) {
      ai.guardSecondary(0, 1, GUARD_TOWER);
      if (ai.countDone(WATCH_TOWER) >= 4) ai.guardSecondary(0, 1, ARCANE_TOWER);
    }

    ai.setBuildUpgr(1, UPG_RANGED);
    ai.setBuildUnit(1, SANCTUM);
    ai.setBuildUnit(2, MORTAR);
    ai.setBuildUpgr(1, UPG_WOOD);
    ai.setBuildUpgr(2, UPG_ARMOR);
    ai.setBuildUpgr(2, UPG_WOOD);
    return;
  }

  const gold = ai.gold();
  const mines = ai.minesOwned();
  const goldOwned = ai.goldOwned();
  const foodUsed = ai.foodUsed();
  const foodMade = ai.townCount(TOWN_HALL) * ai.foodMade(TOWN_HALL) + ai.count(HOUSE) * ai.foodMade(HOUSE);
  const castleDone = ai.townCountDone(CASTLE);
  const knightsOk = castleDone >= 1 && ai.countDone(LUMBER_MILL) >= 1 && ai.countDone(BLACKSMITH) >= 1;

  // need a peasant or nothing will get built
  if (ai.townCountDone(TOWN_HALL) >= 1) {
    let peasants = 6 - Math.floor(ai.wood() / 200);
    if (peasants < 3) peasants = 3;
    peasants += mines < 2 ? 5 : 10;
    if (peasants > 15) peasants = 15;
    ai.setBuildNext(peasants, PEASANT);
  }

  // need a hall or we can't resource and make more peasants
  if (ai.townCount(TOWN_HALL) < 1 && ai.countDone(PEASANT) >= 1) {
    ai.meleeTownHall(0, TOWN_HALL);
    ai.meleeTownHall(1, TOWN_HALL);
    ai.meleeTownHall(2, TOWN_HALL);
  }

  if (gold > 500 && ai.wood() < 100) ai.setBuildNext(20, PEASANT);

  // if we have low gold in our mines then we need to expand
  if (goldOwned < 2000) {
    ai.basicExpansion(mines < 2, TOWN_HALL);
    if (!newbie) {
      ai.guardSecondary(1, 2, WATCH_TOWER);
      if (ai.count(WATCH_TOWER) >= 2) {
        ai.guardSecondary(1, 1, GUARD_TOWER);
        ai.guardSecondary(1, 1, ARCANE_TOWER);
      }
    }
  }

  // get enough houses to handle current food demand
  if (foodUsed + 5 >= foodMade) ai.setBuildUnit(ai.countDone(HOUSE) + 1, HOUSE);

  // always rebuild heroes for defense
  if (ai.countDone(HUMAN_ALTAR) >= 1) {
    if (ai.countDone(ai.heroId) >= 1 && !newbie) {
      if (ai.countDone(ai.heroId2) >= 1) {
        if (ai.countDone(ai.heroId3) >= 1 || castleDone >= 1) ai.setBuildUnit(1, ai.heroId3);
      } else {
        ai.setBuildUnit(1, ai.heroId2);
      }
    } else {
      ai.setBuildUnit(1, ai.heroId);
    }
  } else {
    ai.setBuildUnit(1, HUMAN_ALTAR);
  }

  // minimum melee defense
  ai.setBuildUnit(1, BARRACKS);
  if (knightsOk) ai.setBuildUnit(2, KNIGHT);
  else ai.setBuildUnit(4, FOOTMAN);

  // minimum ranged/air defense
  if (ai.countDone(AVIARY) >= 1) {
    ai.setBuildUnit(3, GRYPHON);
  } else {
    ai.setBuildUnit(1, BLACKSMITH);
    if (ai.countDone(BLACKSMITH) >= 1 || gold < 1000) ai.setBuildUnit(4, RIFLEMAN);
  }

  // siege attackers
  ai.setBuildUnit(1, KEEP);
  ai.setBuildUnit(1, WORKSHOP);
  ai.setBuildUnit(2, MORTAR);

  ai.setBuildUnit(ai.countDone(WATCH_TOWER) - ai.count(ARCANE_TOWER), GUARD_TOWER);

  // if we have a lot of gold then advance the tech tree
  if (gold > 1000) {
    ai.setBuildUnit(1, ARCANE_VAULT);
    ai.setBuildUnit(1, BLACKSMITH);
    ai.setBuildUnit(1, LUMBER_MILL);
    ai.setBuildUnit(1, SANCTUM);
    ai.setBuildUnit(1, CASTLE);
    ai.setBuildUnit(1, AVIARY);

    doUpgrades(ai);

    if (gold > 2000) {
      ai.buildFactory(BARRACKS);
      ai.buildFactory(SANCTUM);
      ai.buildFactory(AVIARY);
    }

    ai.setBuildUpgr(1, UPG_SENTINEL);
  } else if (foodUsed >= UPKEEP_TIER1) {
    doUpgrades(ai);
  }

  ai.basicExpansion(mines < 2, TOWN_HALL);

  if (foodUsed >= UPKEEP_TIER2 - 10 && gold < 2000) return;

  // full up with more troops in general
  if (knightsOk) ai.setBuildNext(4, KNIGHT);

  if (ai.countDone(SANCTUM) >= 1) {
    ai.setBuildNext(2, PRIEST);
    ai.setBuildNext(1, SORCERESS);
    ai.setBuildNext(1, SPELL_BREAKER);

    if (ai.countDone(AVIARY) >= 1) {
      ai.setBuildNext(4, GRYPHON);
      ai.setBuildNext(2, HUMAN_DRAGON_HAWK);
    }
    if (ai.countDone(WORKSHOP) >= 1) ai.setBuildNext(2, COPTER);

    ai.setBuildNext(2, SORCERESS);
    ai.setBuildNext(1, SPELL_BREAKER);
  }

  if (goldOwned < 10000) ai.basicExpansion(mines < 3, TOWN_HALL);

  // (The zeppelin branch — `if c_food_used >= 60 and c_zep < 3 then GetZeppelin()` — is not
  //  ported: `PurchaseZeppelin` is an engine native that buys from a Goblin Laboratory and
  //  loads a wave into it, and we model neither the purchase nor the airlift.)
}

/** `peon_assignment` — human.ai 542–566, harvest half only (the build half is the loop body). */
function peonAssignment(ai: AiPlayer): void {
  ai.clearHarvestAI();
  const T = ai.townWithMine();
  ai.harvestGold(T, 4);
  ai.harvestWood(0, 1);
  ai.harvestGold(T, 1);
  ai.harvestWood(0, 1);
  if (ai.townCountDone(TOWN_HALL) > 1 && ai.minesOwned() > 1) ai.harvestGold(T + 1, 5);
  ai.harvestWood(0, 15);
}

export const HUMAN_AI: MeleeScript = {
  heroes: [ARCHMAGE, MTN_KING, PALADIN, BLOOD_MAGE], // PickMeleeHero(RACE_HUMAN)
  setSkills,
  setupForce,
  forceLevel,
  /** `loop exitwhen c_hero1_done > 0 and c_footman_done >= 2` */
  firstWaveReady: (ai) => ai.countDone(ai.heroId) > 0 && ai.countDone(FOOTMAN) >= 2,
  attackFlags(ai) {
    const level = forceLevel(ai);
    return {
      needsExp: ai.takeExp && (level >= 9 || ai.goldOwned() < 2000),
      hasSiege: level >= 40 || ai.countDone(MORTAR) > 0 || ai.countDone(TANK) > 0,
      airUnits: ai.countDone(COPTER) > 0 || ai.countDone(GRYPHON) > 0 || ai.countDone(HUMAN_DRAGON_HAWK) > 0,
      allowAirCreeps:
        ai.countDone(RIFLEMAN) + ai.countDone(HUMAN_DRAGON_HAWK) + 2 * ai.countDone(COPTER) + ai.countDone(GRYPHON) >= 3,
    };
  },
  /** `if basic_opening and (b_hero2_done or (NEWBIE and c_castle_done >= 1))` */
  openingDone: (ai) =>
    ai.countDone(ai.heroId2) >= 1 || (ai.meleeDifficulty() === MELEE_NEWBIE && ai.townCountDone(CASTLE) >= 1),
  buildSequence,
  peonAssignment,
};
