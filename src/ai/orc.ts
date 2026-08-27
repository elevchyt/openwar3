import type { AiPlayer } from "./aiPlayer";
import type { MeleeScript } from "./script";
import {
  BATRIDER, BERSERKER, BESTIARY, BLADE_MASTER, BLADE_STORM, BURROW, CATAPULT, CHAIN_LIGHTNING,
  CRITICAL_STRIKE, EARTHQUAKE, ENDURANE_AURA, FAR_SEER, FAR_SIGHT, FORGE, FORTRESS, GREAT_HALL,
  GRUNT, HEAD_HUNTER, HEALING_WAVE, HEX, KODO_BEAST, LODGE, MELEE_NEWBIE, MIRROR_IMAGE,
  ORC_ALTAR, ORC_BARRACKS, ORC_WATCH_TOWER, PEON, RAIDER, REINCARNATION, SERPENT_WARD, SHADOW_HUNTER,
  SHAMAN, SHOCKWAVE, SPIRIT_WALKER, SPIRIT_WOLF, STRONGHOLD, TAUREN, TAUREN_CHIEF, TOTEM,
  UPG_ORC_ARMOR, UPG_ORC_BERSERK, UPG_ORC_BERSERKER, UPG_ORC_BURROWS, UPG_ORC_DOCS,
  UPG_ORC_ENSNARE, UPG_ORC_FIRE, UPG_ORC_MELEE, UPG_ORC_PILLAGE, UPG_ORC_PULVERIZE,
  UPG_ORC_RANGED, UPG_ORC_REGEN, UPG_ORC_SHAMAN, UPG_ORC_SPIKES, UPG_ORC_SWALKER,
  UPG_ORC_VENOM, UPG_ORC_WAR_DRUMS, UPKEEP_TIER1, UPKEEP_TIER2, VOODOO, VOODOO_LOUNGE,
  WAR_STOMP, WIND_WALK, WITCH_DOCTOR, WYVERN,
} from "./ids";

// `Scripts\orc.ai` (v1.14, 2003/04/23), ported function for function.

/** `set_skills` — orc.ai 61–124. */
function setSkills(ai: AiPlayer): void {
  const bladeMaster = [MIRROR_IMAGE, CRITICAL_STRIKE, WIND_WALK, MIRROR_IMAGE, MIRROR_IMAGE,
    BLADE_STORM, CRITICAL_STRIKE, CRITICAL_STRIKE, WIND_WALK, WIND_WALK];
  const farSeer = [CHAIN_LIGHTNING, SPIRIT_WOLF, CHAIN_LIGHTNING, SPIRIT_WOLF, CHAIN_LIGHTNING,
    EARTHQUAKE, SPIRIT_WOLF, FAR_SIGHT, FAR_SIGHT, FAR_SIGHT];
  const taurenChief = [SHOCKWAVE, ENDURANE_AURA, SHOCKWAVE, ENDURANE_AURA, SHOCKWAVE,
    REINCARNATION, ENDURANE_AURA, WAR_STOMP, WAR_STOMP, WAR_STOMP];
  const shadowHunter = [HEALING_WAVE, SERPENT_WARD, HEALING_WAVE, SERPENT_WARD, HEALING_WAVE,
    VOODOO, SERPENT_WARD, HEX, HEX, HEX];
  for (const slot of [1, 2, 3]) {
    ai.setSkillArray(slot, BLADE_MASTER, bladeMaster);
    ai.setSkillArray(slot, FAR_SEER, farSeer);
    ai.setSkillArray(slot, TAUREN_CHIEF, taurenChief);
    ai.setSkillArray(slot, SHADOW_HUNTER, shadowHunter);
  }
}

/** `setup_force` — orc.ai 129–152. */
function setupForce(ai: AiPlayer): void {
  ai.initMeleeGroup();
  ai.setMeleeGroup(ai.heroId);
  ai.setMeleeGroup(ai.heroId2);
  ai.setMeleeGroup(ai.heroId3);
  ai.setMeleeGroup(GRUNT);
  ai.setMeleeGroup(RAIDER);
  ai.setMeleeGroup(TAUREN);
  ai.setMeleeGroup(HEAD_HUNTER);
  ai.setMeleeGroup(BERSERKER);
  ai.setMeleeGroup(WYVERN);
  ai.setMeleeGroup(WITCH_DOCTOR);
  ai.setMeleeGroup(SHAMAN);
  ai.setMeleeGroup(KODO_BEAST);
  ai.setMeleeGroup(BATRIDER);
  ai.setMeleeGroup(SPIRIT_WALKER);
}

/** `force_level` — orc.ai 157–164. */
function forceLevel(ai: AiPlayer): number {
  let level = 4;
  level += 2 * (ai.townCountDone(HEAD_HUNTER) + ai.countDone(RAIDER) + ai.countDone(BATRIDER)
    + ai.countDone(SHAMAN) + ai.countDone(WITCH_DOCTOR) + ai.townCountDone(SPIRIT_WALKER));
  level += 3 * (ai.countDone(GRUNT) + ai.countDone(KODO_BEAST) + ai.countDone(WYVERN));
  level += 5 * (ai.countDone(ai.heroId3) + ai.countDone(TAUREN));
  level += 6 * ai.countDone(ai.heroId2);
  return level;
}

/**
 * `hunter_code` — orc.ai 226–230.
 *
 * Note the file's own polarity, kept verbatim: `if GetUpgradeLevel(UPG_ORC_BERSERK) >= 1 then
 * hunter_code = HEAD_HUNTER else hunter_code = BERSERKER`. Read literally that is backwards
 * (Berserker Upgrade is what TURNS Headhunters into Berserkers), and it is backwards in
 * Blizzard's shipped script too — `SetProduce(BERSERKER)` before the upgrade simply cannot be
 * satisfied, so the AI trains nothing from that branch until the research lands and the id
 * flips to the trainable one. Left as written rather than "fixed": the whole point of a port
 * is that it plays like the original, bugs and all.
 */
function hunterCode(ai: AiPlayer): string {
  return ai.upgradeLevel(UPG_ORC_BERSERK) >= 1 ? HEAD_HUNTER : BERSERKER;
}

/** `do_upgrades` — orc.ai 296–398. */
function doUpgrades(ai: AiPlayer): void {
  const forgeDone = ai.countDone(FORGE);
  const fortressDone = ai.townCountDone(FORTRESS);
  const strongholdDone = ai.townCountDone(STRONGHOLD);
  const bestiaryDone = ai.countDone(BESTIARY);
  const barracksDone = ai.countDone(ORC_BARRACKS);
  const lodgeDone = ai.countDone(LODGE);

  if (ai.countDone(TOTEM) >= 1 && ai.count(TAUREN) >= 1) ai.setBuildUpgr(1, UPG_ORC_PULVERIZE);

  if (forgeDone >= 1) {
    if (fortressDone >= 1) {
      ai.setBuildUpgr(1, UPG_ORC_BURROWS);
      ai.setBuildUpgr(3, UPG_ORC_MELEE);
      ai.setBuildUpgr(3, UPG_ORC_RANGED);
      ai.setBuildUpgr(3, UPG_ORC_ARMOR);
      ai.setBuildUpgr(3, UPG_ORC_SPIKES);
    } else if (strongholdDone >= 1) {
      ai.setBuildUpgr(2, UPG_ORC_MELEE);
      ai.setBuildUpgr(2, UPG_ORC_RANGED);
      ai.setBuildUpgr(2, UPG_ORC_ARMOR);
    } else {
      ai.setBuildUpgr(1, UPG_ORC_MELEE);
      ai.setBuildUpgr(1, UPG_ORC_RANGED);
      ai.setBuildUpgr(1, UPG_ORC_ARMOR);
    }
  }

  if (bestiaryDone >= 1) {
    if (ai.count(RAIDER) >= 1) ai.setBuildUpgr(1, UPG_ORC_ENSNARE);
    if (fortressDone >= 1) {
      if (ai.count(WYVERN) >= 1) ai.setBuildUpgr(1, UPG_ORC_VENOM);
      if (forgeDone >= 1 && ai.count(KODO_BEAST) >= 1) ai.setBuildUpgr(1, UPG_ORC_WAR_DRUMS);
      if (ai.countDone(VOODOO_LOUNGE) >= 1 && ai.count(BATRIDER) >= 1) ai.setBuildUpgr(1, UPG_ORC_FIRE);
    }
  }

  if (barracksDone >= 1) {
    if (fortressDone >= 1 && ai.count(GRUNT) >= 2) ai.setBuildUpgr(1, UPG_ORC_BERSERK);
    if (strongholdDone >= 1 && ai.count(HEAD_HUNTER) >= 2) {
      if (forgeDone >= 1) ai.setBuildUpgr(1, UPG_ORC_BERSERKER);
      ai.setBuildUpgr(1, UPG_ORC_REGEN);
    }
  }

  if (lodgeDone >= 1) {
    if (fortressDone >= 1) {
      if (ai.count(SHAMAN) >= 1) ai.setBuildUpgr(2, UPG_ORC_SHAMAN);
      if (ai.count(WITCH_DOCTOR) >= 1) ai.setBuildUpgr(2, UPG_ORC_DOCS);
      if (ai.townCount(SPIRIT_WALKER) >= 1) ai.setBuildUpgr(2, UPG_ORC_SWALKER);
    } else {
      if (ai.count(SHAMAN) >= 2) ai.setBuildUpgr(1, UPG_ORC_SHAMAN);
      if (ai.count(WITCH_DOCTOR) >= 2) ai.setBuildUpgr(1, UPG_ORC_DOCS);
      if (ai.townCount(SPIRIT_WALKER) >= 1) ai.setBuildUpgr(1, UPG_ORC_SWALKER);
    }
  }

  if (ai.townCountDone(GREAT_HALL) >= 1 && ai.count(RAIDER) >= 1) ai.setBuildUpgr(1, UPG_ORC_PILLAGE);

  if (forgeDone >= 1) {
    if (fortressDone >= 1) ai.setBuildUpgr(3, UPG_ORC_SPIKES);
    else if (strongholdDone >= 1) ai.setBuildUpgr(2, UPG_ORC_SPIKES);
    else ai.setBuildUpgr(1, UPG_ORC_SPIKES);
  }
}

/** `build_sequence` — orc.ai 403–608. */
function buildSequence(ai: AiPlayer): void {
  const newbie = ai.meleeDifficulty() === MELEE_NEWBIE;
  ai.initBuildArray();

  if (ai.basicOpening) {
    ai.meleeTownHall(0, GREAT_HALL);
    ai.meleeTownHall(1, GREAT_HALL);

    ai.setBuildUnit(6, PEON);
    ai.setBuildUnit(1, ORC_ALTAR);
    ai.setBuildUnit(7, PEON);
    ai.setBuildUnit(1, BURROW);
    ai.setBuildUnit(8, PEON);
    ai.setBuildUnit(2, BURROW);
    ai.setBuildUnit(10, PEON);
    ai.setBuildUnit(1, ai.heroId);
    ai.setBuildUnit(11, PEON);
    ai.setBuildUnit(1, ORC_BARRACKS);
    ai.setBuildUnit(1, FORGE);
    ai.setBuildUnit(14, PEON);
    ai.setBuildUnit(1, GRUNT);
    ai.setBuildUpgr(1, UPG_ORC_MELEE);
    ai.setBuildUnit(2, GRUNT);
    ai.setBuildUnit(3, BURROW);
    ai.setBuildUnit(1, HEAD_HUNTER);
    ai.setBuildUnit(1, VOODOO_LOUNGE);
    ai.setBuildUpgr(1, UPG_ORC_RANGED);
    ai.setBuildUnit(3, HEAD_HUNTER);
    ai.setBuildUpgr(1, UPG_ORC_ARMOR);
    ai.setBuildUnit(4, GRUNT);

    ai.basicExpansion(ai.minesOwned() < 2, GREAT_HALL);

    if (!newbie) {
      ai.guardSecondary(1, 1, BURROW);
      ai.guardSecondary(1, 2, ORC_WATCH_TOWER);
    }

    ai.setBuildUnit(4, BURROW);
    ai.setBuildUnit(6, GRUNT);
    ai.setBuildUnit(1, STRONGHOLD);
    ai.setBuildUpgr(1, UPG_ORC_SPIKES);

    if (!newbie) ai.setBuildUnit(1, ai.heroId2);

    ai.setBuildUnit(5, BURROW);
    ai.setBuildUnit(1, CATAPULT);
    ai.setBuildUpgr(2, UPG_ORC_MELEE);
    ai.setBuildUpgr(1, UPG_ORC_PILLAGE);
    ai.setBuildUnit(2, CATAPULT);
    return;
  }

  const gold = ai.gold();
  const mines = ai.minesOwned();
  const goldOwned = ai.goldOwned();
  const foodUsed = ai.foodUsed();
  const foodMade = ai.townCount(GREAT_HALL) * ai.foodMade(GREAT_HALL) + ai.count(BURROW) * ai.foodMade(BURROW);
  const hallDone = ai.townCountDone(GREAT_HALL);
  const fortressDone = ai.townCountDone(FORTRESS);
  const bestiaryDone = ai.countDone(BESTIARY);
  const ensnare = ai.upgradeLevel(UPG_ORC_ENSNARE) >= 1;
  const hunter = hunterCode(ai);

  // need a peon or nothing will get built
  if (hallDone >= 1) {
    let peons = 6 - Math.floor(ai.wood() / 200);
    if (peons < 3) peons = 3;
    peons += mines < 2 || hallDone < 2 ? 5 : 10;
    if (peons > 15) peons = 15;
    ai.setBuildNext(peons, PEON);
  }

  // need a great hall or we can't resource and make more peons
  if (ai.townCount(GREAT_HALL) < 1 && ai.countDone(PEON) >= 1) {
    ai.meleeTownHall(0, GREAT_HALL);
    ai.meleeTownHall(1, GREAT_HALL);
    ai.meleeTownHall(2, GREAT_HALL);
  }

  if (gold > 500 && ai.wood() < 100) ai.setBuildNext(15, PEON);

  if (goldOwned < 2000) {
    ai.basicExpansion(mines < 2, GREAT_HALL);
    if (!newbie) ai.guardSecondary(1, 1, BURROW);
  }

  // get enough burrows to handle current food demand
  if (foodUsed + 5 >= foodMade) ai.setBuildUnit(ai.countDone(BURROW) + 1, BURROW);

  // always rebuild heroes for defense
  if (ai.countDone(ORC_ALTAR) >= 1) {
    if (ai.countDone(ai.heroId) >= 1 && !newbie) ai.setBuildUnit(1, ai.heroId2);
    else ai.setBuildUnit(1, ai.heroId);
  } else {
    ai.setBuildUnit(1, ORC_ALTAR);
  }

  // minimum melee defense
  if (ai.countDone(TOTEM) >= 1) {
    ai.setBuildUnit(2, TAUREN);
  } else {
    ai.setBuildUnit(1, ORC_BARRACKS);
    ai.setBuildUnit(3, GRUNT);
  }

  // minimum ranged/air defense and siege units
  if (bestiaryDone >= 1) {
    if (fortressDone >= 1) ai.setBuildUnit(2, WYVERN);
    else if (ensnare) ai.setBuildUnit(2, RAIDER);
    else {
      ai.setBuildUnit(1, ORC_BARRACKS);
      ai.setBuildUnit(3, hunter);
    }

    if (ai.countDone(VOODOO_LOUNGE) >= 1 && fortressDone >= 1) ai.setBuildUnit(2, BATRIDER);
    else ai.setBuildUnit(3, RAIDER);
  } else {
    ai.setBuildUnit(1, ORC_BARRACKS);
    ai.setBuildUnit(3, hunter);
    ai.setBuildUnit(2, CATAPULT);
  }

  // if we have a lot of gold then advance the tech tree
  if (gold > 1000) {
    if (!newbie) {
      ai.guardSecondary(1, 1, BURROW);
      ai.guardSecondary(1, 1, ORC_WATCH_TOWER);
      ai.guardSecondary(1, 2, BURROW);
      ai.guardSecondary(1, 2, ORC_WATCH_TOWER);
    }

    ai.setBuildUnit(1, ORC_BARRACKS);
    ai.setBuildUnit(1, FORGE);
    ai.setBuildUnit(1, VOODOO_LOUNGE);
    ai.setBuildUnit(1, STRONGHOLD);
    ai.setBuildUnit(1, LODGE);
    ai.setBuildUnit(1, BESTIARY);
    ai.setBuildUnit(1, FORTRESS);
    ai.setBuildUnit(1, TOTEM);

    doUpgrades(ai);

    if (gold > 2000) {
      ai.buildFactory(ORC_BARRACKS);
      ai.buildFactory(LODGE);
      ai.buildFactory(BESTIARY);
      ai.buildFactory(TOTEM);
    }
  } else if (foodUsed >= UPKEEP_TIER1) {
    doUpgrades(ai);
  }

  ai.basicExpansion(mines < 2, GREAT_HALL);
  if (!newbie) {
    ai.guardSecondary(1, 1, BURROW);
    ai.guardSecondary(1, 2, ORC_WATCH_TOWER);
  }

  if (foodUsed >= UPKEEP_TIER2 - 10 && gold < 2000) return;

  // full up with more troops in general
  if (ai.countDone(TOTEM) >= 1) ai.setBuildNext(4, TAUREN);
  else ai.setBuildNext(6, GRUNT);

  if (bestiaryDone >= 1) {
    if (fortressDone >= 1) ai.setBuildNext(3, WYVERN);
    else if (ensnare) ai.setBuildNext(4, RAIDER);
    if (ai.countDone(FORGE) >= 1) ai.setBuildUnit(1, KODO_BEAST);
  }

  if (ai.countDone(LODGE) >= 1) {
    ai.setBuildUnit(1, SHAMAN);
    ai.setBuildUnit(1, WITCH_DOCTOR);
    ai.setBuildUnit(1, SPIRIT_WALKER);
    ai.setBuildNext(4, SHAMAN);
    ai.setBuildNext(2, WITCH_DOCTOR);
  }

  if (goldOwned < 10000) {
    ai.basicExpansion(mines < 3, GREAT_HALL);
    if (!newbie) {
      ai.guardSecondary(2, 1, BURROW);
      ai.guardSecondary(2, 2, ORC_WATCH_TOWER);
    }
  }
  // (Zeppelin branch not ported — see human.ts.)
}

/** `peon_assignment` — orc.ai 613–635. */
function peonAssignment(ai: AiPlayer): void {
  ai.clearHarvestAI();
  const T = ai.townWithMine();
  ai.harvestGold(T, 4);
  ai.harvestWood(0, 1);
  ai.harvestGold(T, 1);
  ai.harvestWood(0, 1);
  if (ai.townCountDone(GREAT_HALL) > 1 && ai.minesOwned() > 1) ai.harvestGold(T + 1, 5);
  ai.harvestWood(0, 10);
}

export const ORC_AI: MeleeScript = {
  heroes: [BLADE_MASTER, FAR_SEER, TAUREN_CHIEF, SHADOW_HUNTER], // PickMeleeHero(RACE_ORC)
  setSkills,
  setupForce,
  forceLevel,
  /** `loop exitwhen c_hero1_done > 0 and c_grunt_done >= 2` */
  firstWaveReady: (ai) => ai.countDone(ai.heroId) > 0 && ai.countDone(GRUNT) >= 2,
  attackFlags(ai) {
    const level = forceLevel(ai);
    return {
      needsExp: ai.takeExp && (level >= 9 || ai.goldOwned() < 2000),
      hasSiege: level >= 40 || 2 * ai.countDone(CATAPULT) + ai.countDone(RAIDER) + ai.countDone(BATRIDER) >= 2,
      airUnits: ai.countDone(WYVERN) > 0 || ai.countDone(BATRIDER) > 0,
      allowAirCreeps: ai.countDone(WYVERN) + ai.countDone(RAIDER) + ai.townCountDone(HEAD_HUNTER) >= 3,
    };
  },
  /** `if basic_opening and (b_hero2_done or (NEWBIE and c_stronghold_done >= 1))` */
  openingDone: (ai) =>
    ai.countDone(ai.heroId2) >= 1 || (ai.meleeDifficulty() === MELEE_NEWBIE && ai.townCountDone(STRONGHOLD) >= 1),
  buildSequence,
  peonAssignment,
};
