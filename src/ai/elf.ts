import type { AiPlayer } from "./aiPlayer";
import type { MeleeScript } from "./script";
import {
  ANCIENT_LORE, ANCIENT_PROTECT, ANCIENT_WAR, ANCIENT_WIND, ARCHER, BALLISTA, BLINK, CHIMAERA,
  CHIMAERA_ROOST, DEMON_HUNTER, DEN_OF_WONDERS, DRUID_CLAW, DRUID_TALON, DRYAD, ELF_ALTAR,
  ELF_MINE, ENT_ROOTS, EVASION, FAERIE_DRAGON, FAN_KNIVES, FORCE_NATURE, HUNTERS_HALL, HUNTRESS,
  IMMOLATION, KEEPER, MANA_BURN, MELEE_NEWBIE, METAMORPHOSIS, MOON_CHICK, MOON_WELL,
  MOUNTAIN_GIANT, SCOUT, SEARING_ARROWS, SHADOW_TOUCH, STARFALL, THORNS_AURA, TRANQUILITY,
  TREE_AGES, TREE_ETERNITY, TREE_LIFE, TRUESHOT, UPG_ABOLISH, UPG_BOLT, UPG_BOWS, UPG_CHIM_ACID,
  UPG_DRUID_CLAW, UPG_DRUID_TALON, UPG_GLAIVE, UPG_HARD_SKIN, UPG_HIDES, UPG_MARK_CLAW,
  UPG_MARK_TALON, UPG_MARKSMAN, UPG_MOON_ARMOR, UPG_RESIST_SKIN, UPG_SCOUT, UPG_STR_MOON,
  UPG_STR_WILD, UPG_ULTRAVISION, UPG_WELL_SPRING, UPKEEP_TIER1, UPKEEP_TIER2, VENGEANCE, WARDEN,
  WISP,
} from "./ids";

// `Scripts\elf.ai` (v1.18, 2003/04/23), ported function for function.
//
// Two things about this one are the race and not the script: a Wisp is CONSUMED by the
// Ancient it raises (so the peon target is a running cost, not a stock), and gold comes from
// wrapping a mine in roots rather than from walking into it — which is why `c_mines_done`
// counts `ELF_MINE` (`egol`, the Entangled Gold Mine) and why nothing here ever asks to BUILD
// one. See docs/night-elf.md.

const WAVE = "wave";
const ARCHER_OPENING = "archer_opening"; // 1 while true — elf.ai's second opening latch

/** `set_skills` — elf.ai 59–141. The Keeper and the Demon Hunter get a different array in
 *  slot 1 than in slots 2 and 3. */
function setSkills(ai: AiPlayer): void {
  const priestess = [SEARING_ARROWS, TRUESHOT, SEARING_ARROWS, TRUESHOT, SEARING_ARROWS,
    STARFALL, TRUESHOT, SCOUT, SCOUT, SCOUT];
  // MOON_CHICK / MOON_BABE / MOON_HONEY are all 'Emoo' — three names, one hero.
  for (const slot of [1, 2, 3]) ai.setSkillArray(slot, MOON_CHICK, priestess);

  ai.setSkillArray(1, KEEPER, [FORCE_NATURE, ENT_ROOTS, FORCE_NATURE, ENT_ROOTS, FORCE_NATURE,
    TRANQUILITY, ENT_ROOTS, THORNS_AURA, THORNS_AURA, THORNS_AURA]);
  const keeper23 = [ENT_ROOTS, THORNS_AURA, ENT_ROOTS, THORNS_AURA, ENT_ROOTS, TRANQUILITY,
    THORNS_AURA, FORCE_NATURE, FORCE_NATURE, FORCE_NATURE];
  ai.setSkillArray(2, KEEPER, keeper23);
  ai.setSkillArray(3, KEEPER, keeper23);

  ai.setSkillArray(1, DEMON_HUNTER, [IMMOLATION, MANA_BURN, EVASION, MANA_BURN, EVASION,
    METAMORPHOSIS, MANA_BURN, EVASION, IMMOLATION, IMMOLATION]);
  const demon23 = [MANA_BURN, EVASION, MANA_BURN, EVASION, MANA_BURN, METAMORPHOSIS, EVASION,
    IMMOLATION, IMMOLATION, IMMOLATION];
  ai.setSkillArray(2, DEMON_HUNTER, demon23);
  ai.setSkillArray(3, DEMON_HUNTER, demon23);

  const warden = [FAN_KNIVES, SHADOW_TOUCH, FAN_KNIVES, BLINK, FAN_KNIVES, VENGEANCE,
    SHADOW_TOUCH, BLINK, SHADOW_TOUCH, BLINK];
  for (const slot of [1, 2, 3]) ai.setSkillArray(slot, WARDEN, warden);
}

/** `setup_force` — elf.ai 149–176. (The two Hippogryph rows are gated on owning any, and we
 *  never tame one — `MergeUnits` is not modelled — so they simply never fire.) */
function setupForce(ai: AiPlayer): void {
  ai.initMeleeGroup();
  ai.setMeleeGroup(ai.heroId);
  ai.setMeleeGroup(ai.heroId2);
  ai.setMeleeGroup(ai.heroId3);
  ai.setMeleeGroup(ARCHER);
  ai.setMeleeGroup(HUNTRESS);
  ai.setMeleeGroup(DRUID_TALON);
  ai.setMeleeGroup(DRUID_CLAW);
  ai.setMeleeGroup(DRYAD);
  ai.setMeleeGroup(CHIMAERA);
  ai.setMeleeGroup(MOUNTAIN_GIANT);
  ai.setMeleeGroup(FAERIE_DRAGON);
}

/** `force_level` — elf.ai 181–191. */
function forceLevel(ai: AiPlayer): number {
  let level = 4;
  level += ai.countDone(FAERIE_DRAGON) + ai.townCountDone(DRUID_TALON);
  level += Math.floor((2 * ai.countDone(ARCHER)) / 3);
  level += 2 * ai.countDone(DRYAD);
  level += 3 * ai.countDone(HUNTRESS);
  level += 4 * (ai.countDone(CHIMAERA) + ai.townCountDone(DRUID_CLAW));
  level += 5 * ai.countDone(ai.heroId3);
  level += 6 * (ai.countDone(ai.heroId2) + ai.countDone(MOUNTAIN_GIANT));
  return level;
}

/** `basics(food)` — elf.ai 344–369. The opening's front line, expressed as a food budget:
 *  archers until the Hunter's Hall is up and six of them are out, then huntresses. */
function basics(ai: AiPlayer, food: number): void {
  if ((ai.vars[ARCHER_OPENING] ?? 1) === 1 || ai.countDone(HUNTERS_HALL) < 1) {
    let archers = Math.floor(food / 2);
    if (archers > 6) archers = 6;
    ai.setBuildUnit(archers, ARCHER);
    return;
  }
  let hunts = Math.floor((food - 2 * ai.count(ARCHER)) / 3);
  if (hunts > 3) hunts = 3;
  ai.setBuildUnit(hunts, HUNTRESS);
  if (food >= 15) ai.setBuildUnit(3, ARCHER);
}

/** `do_upgrades` — elf.ai 374–478. */
function doUpgrades(ai: AiPlayer): void {
  const agesDone = ai.townCountDone(TREE_AGES);
  const eternityDone = ai.townCountDone(TREE_ETERNITY);
  const huntHallDone = ai.countDone(HUNTERS_HALL);
  const loreDone = ai.countDone(ANCIENT_LORE);
  const wonders = ai.countDone(DEN_OF_WONDERS);
  const war = ai.countDone(ANCIENT_WAR);

  if (eternityDone >= 1 && huntHallDone >= 1) ai.setBuildUpgr(1, UPG_WELL_SPRING);
  if (ai.count(DRYAD) >= 1 && loreDone >= 1) ai.setBuildUpgr(1, UPG_ABOLISH);
  if (ai.countDone(CHIMAERA_ROOST) >= 1) ai.setBuildUpgr(1, UPG_CHIM_ACID);

  if (huntHallDone >= 1) {
    if (ai.count(ARCHER) + ai.count(HUNTRESS) + ai.count(BALLISTA) >= 3) {
      ai.setBuildUpgr(1, UPG_STR_MOON);
      ai.setBuildUpgr(1, UPG_MOON_ARMOR);
      if (agesDone >= 1) {
        ai.setBuildUpgr(2, UPG_STR_MOON);
        ai.setBuildUpgr(2, UPG_MOON_ARMOR);
        if (eternityDone >= 1) {
          ai.setBuildUpgr(3, UPG_STR_MOON);
          ai.setBuildUpgr(3, UPG_MOON_ARMOR);
        }
      }
    }
    if (ai.count(DRYAD) + ai.count(MOUNTAIN_GIANT) + ai.count(CHIMAERA) >= 3) {
      ai.setBuildUpgr(1, UPG_STR_WILD);
      ai.setBuildUpgr(1, UPG_HIDES);
      if (agesDone >= 1) {
        ai.setBuildUpgr(2, UPG_STR_WILD);
        ai.setBuildUpgr(2, UPG_HIDES);
        if (eternityDone >= 1) {
          ai.setBuildUpgr(3, UPG_STR_WILD);
          ai.setBuildUpgr(3, UPG_HIDES);
        }
      }
    }
  }

  if (ai.count(MOUNTAIN_GIANT) >= 1 && eternityDone >= 1 && wonders >= 1 && loreDone >= 1) {
    ai.setBuildUpgr(1, UPG_HARD_SKIN);
    ai.setBuildUpgr(1, UPG_RESIST_SKIN);
  }

  if (war >= 1) {
    if (ai.count(HUNTRESS) >= 3 && eternityDone >= 1 && huntHallDone >= 1) {
      ai.setBuildUpgr(1, UPG_GLAIVE);
      ai.setBuildUpgr(1, UPG_SCOUT);
    }
    if (ai.count(ARCHER) >= 3 && agesDone >= 1) {
      ai.setBuildUpgr(1, UPG_BOWS);
      if (eternityDone >= 1 && huntHallDone >= 1) ai.setBuildUpgr(1, UPG_MARKSMAN);
    }
    if (ai.count(BALLISTA) >= 1) {
      ai.setBuildUpgr(1, UPG_ULTRAVISION);
      ai.setBuildUpgr(1, UPG_BOLT);
    }
  }

  if (loreDone >= 1) {
    if (ai.townCount(DRUID_CLAW) >= 1) {
      ai.setBuildUpgr(1, UPG_DRUID_CLAW);
      if (eternityDone >= 1) {
        ai.setBuildUpgr(2, UPG_DRUID_CLAW);
        ai.setBuildUpgr(1, UPG_MARK_CLAW);
      }
    }
    if (ai.townCount(DRUID_TALON) >= 1) {
      ai.setBuildUpgr(1, UPG_DRUID_TALON);
      if (eternityDone >= 1) {
        ai.setBuildUpgr(2, UPG_DRUID_TALON);
        ai.setBuildUpgr(1, UPG_MARK_TALON);
      }
    }
  }
}

/** `build_sequence` — elf.ai 483–664. */
function buildSequence(ai: AiPlayer): void {
  const newbie = ai.meleeDifficulty() === MELEE_NEWBIE;
  ai.initBuildArray();

  if (ai.basicOpening) {
    ai.setBuildUnit(1, TREE_LIFE);
    ai.setBuildUnit(5, WISP);
    ai.setBuildUnit(1, ELF_ALTAR);
    ai.setBuildUnit(7, WISP);
    ai.setBuildUnit(1, MOON_WELL);
    ai.setBuildUnit(8, WISP);
    ai.setBuildUnit(1, ANCIENT_WAR);
    ai.setBuildUnit(9, WISP);
    ai.setBuildUnit(1, ai.heroId);
    ai.setBuildUnit(10, WISP);
    ai.setBuildUnit(2, MOON_WELL);
    basics(ai, 2);
    ai.setBuildUnit(1, DEN_OF_WONDERS);
    basics(ai, 4);
    ai.setBuildUnit(11, WISP);
    basics(ai, 6);
    ai.setBuildUnit(12, WISP);
    ai.setBuildUnit(1, HUNTERS_HALL);
    ai.setBuildUnit(3, MOON_WELL);
    ai.setBuildUnit(13, WISP);
    basics(ai, 8);
    ai.setBuildUnit(14, WISP);
    basics(ai, 10);
    ai.setBuildUnit(15, WISP);
    basics(ai, 15);
    ai.setBuildUnit(1, TREE_AGES);

    ai.basicExpansion(ai.minesOwned() < 2, TREE_LIFE);

    ai.setBuildUpgr(1, UPG_STR_MOON);
    ai.setBuildUpgr(1, UPG_MOON_ARMOR);
    ai.setBuildUnit(4, MOON_WELL);

    if (!newbie) ai.setBuildUnit(1, ai.heroId2);
    return;
  }

  const gold = ai.gold();
  const mines = ai.minesOwned();
  const goldOwned = ai.goldOwned();
  const foodUsed = ai.foodUsed();
  const treeLife = ai.townCount(TREE_LIFE);
  const moonWells = ai.count(MOON_WELL);
  const foodMade = treeLife * ai.foodMade(TREE_LIFE) + moonWells * ai.foodMade(MOON_WELL);
  const loreDone = ai.countDone(ANCIENT_LORE);
  const wondersDone = ai.countDone(DEN_OF_WONDERS);
  const agesDone = ai.townCountDone(TREE_AGES);
  const eternityDone = ai.townCountDone(TREE_ETERNITY);

  if (treeLife < 1 && ai.countDone(WISP) > 0) {
    ai.meleeTownHall(0, TREE_LIFE);
    ai.meleeTownHall(1, TREE_LIFE);
    ai.meleeTownHall(2, TREE_LIFE);
  }

  if (ai.townCountDone(TREE_LIFE) > 0) {
    let wisps = 6 - Math.floor(ai.wood() / 200);
    if (wisps < 3) wisps = 3;
    wisps += mines < 2 || ai.townCountDone(TREE_LIFE) < 2 ? 5 : 10;
    if (wisps > 15) wisps = 15;
    ai.setBuildNext(wisps, WISP);
  }

  if (gold > 500 && ai.wood() < 100) ai.setBuildNext(15, WISP);

  // having enough gold is the highest priority
  if (goldOwned < 2000) {
    ai.basicExpansion(mines < 2, TREE_LIFE);
    if (!newbie) {
      ai.guardSecondary(1, 1, ANCIENT_PROTECT);
      ai.guardSecondary(1, 2, ANCIENT_PROTECT);
    }
  }

  // get enough moon wells to cover food need
  if (foodUsed + 7 > foodMade) ai.setBuildUnit(ai.countDone(MOON_WELL) + 1, MOON_WELL);

  // recover heroes for basic defense
  if (ai.countDone(ELF_ALTAR) >= 1) {
    if (ai.countDone(ai.heroId) > 0 && !newbie) ai.setBuildUnit(1, ai.heroId2);
    else ai.setBuildUnit(1, ai.heroId);
  } else {
    ai.setBuildUnit(1, ELF_ALTAR);
  }

  // the primary melee force is the mountain giant
  const primaryMelee = loreDone >= 1 && wondersDone >= 1 && agesDone >= 1;
  if (primaryMelee) {
    ai.setBuildNext(1, MOUNTAIN_GIANT);
  } else {
    ai.setBuildUnit(1, ANCIENT_WAR);
    ai.setBuildNext(3, HUNTRESS);
  }

  // the primary ranged force is the dryad
  if (loreDone >= 1) {
    ai.setBuildUnit(2, DRYAD);
  } else {
    ai.setBuildUnit(1, ANCIENT_WAR);
    ai.setBuildUnit(3, ARCHER);
  }

  // need siege to take out enemy towns and expansions
  if (ai.upgradeLevel(UPG_CHIM_ACID) >= 1 && ai.countDone(CHIMAERA_ROOST) >= 1) {
    ai.setBuildUnit(2, CHIMAERA);
  } else if (ai.count(MOUNTAIN_GIANT) < 1) {
    ai.setBuildUnit(2, BALLISTA);
  }

  // if we have enough gold then advance on the tech tree
  if (gold > 1000) {
    if (!newbie) {
      ai.guardSecondary(1, 1, ANCIENT_PROTECT);
      ai.guardSecondary(1, 2, ANCIENT_PROTECT);
    }

    ai.setBuildUnit(1, ANCIENT_WAR);
    ai.setBuildUnit(1, HUNTERS_HALL);
    ai.setBuildUnit(1, TREE_AGES);
    ai.setBuildUnit(1, DEN_OF_WONDERS);
    ai.setBuildUnit(1, ANCIENT_LORE);
    ai.setBuildUnit(1, TREE_ETERNITY);
    ai.setBuildUnit(1, ANCIENT_WIND);
    ai.setBuildUnit(1, CHIMAERA_ROOST);

    doUpgrades(ai);

    if (gold > 2000) {
      ai.buildFactory(ANCIENT_LORE);
      ai.buildFactory(ANCIENT_WAR);
      ai.buildFactory(CHIMAERA_ROOST);
      ai.buildFactory(ANCIENT_WIND);
    }
  } else if (foodUsed >= UPKEEP_TIER1) {
    doUpgrades(ai);
  }

  ai.basicExpansion(mines < 2, TREE_LIFE);
  if (!newbie) {
    ai.guardSecondary(1, 1, ANCIENT_PROTECT);
    ai.guardSecondary(1, 2, ANCIENT_PROTECT);
  }

  if (foodUsed >= UPKEEP_TIER2 - 10 && gold < 2000) return;

  // build units from whatever buildings we already have
  if (primaryMelee) ai.setBuildNext(3, MOUNTAIN_GIANT);
  else ai.setBuildNext(7, HUNTRESS);

  if (loreDone >= 1) ai.setBuildNext(4, DRYAD);
  else ai.setBuildNext(6, ARCHER);

  if (agesDone >= 1) {
    if (eternityDone >= 1 && ai.countDone(ELF_ALTAR) >= 1 && !newbie) ai.setBuildUnit(1, ai.heroId3);
    if (loreDone >= 1) ai.setBuildUnit(1, DRUID_CLAW);
  }

  if (ai.countDone(ANCIENT_WIND) >= 1) {
    if (wondersDone >= 1) ai.setBuildUnit(1, FAERIE_DRAGON);
    ai.setBuildUnit(1, DRUID_TALON);
  }

  if (goldOwned < 10000) {
    ai.basicExpansion(mines < 3, TREE_LIFE);
    if (!newbie) {
      ai.guardSecondary(2, 1, ANCIENT_PROTECT);
      ai.guardSecondary(2, 2, ANCIENT_PROTECT);
    }
  }
  // (Zeppelin branch not ported — see human.ts.)
}

/** `peon_assignment` — elf.ai 669–692. */
function peonAssignment(ai: AiPlayer): void {
  ai.clearHarvestAI();
  const T = ai.townWithMine();
  ai.harvestGold(T, 4);
  ai.harvestWood(0, 1);
  ai.harvestGold(T, 1);
  ai.harvestWood(0, 2);
  if (ai.countDone(ELF_MINE) > 1) ai.harvestGold(T + 1, 5);
  ai.harvestWood(0, 20);
}

export const ELF_AI: MeleeScript = {
  heroes: [DEMON_HUNTER, KEEPER, MOON_CHICK, WARDEN], // PickMeleeHero(RACE_NIGHTELF)
  setSkills,
  /** elf.ai 306–309 — the SECOND opening latch, and it runs on its own: `archer_opening`
   *  drops at six archers and turns `basics()` from archers to huntresses, whether or not
   *  `basic_opening` is still up. */
  initVars(ai) {
    if ((ai.vars[ARCHER_OPENING] ?? 1) === 1 && ai.countDone(ARCHER) >= 6) ai.vars[ARCHER_OPENING] = 0;
  },
  setupForce,
  forceLevel,
  /** `loop exitwhen c_hero1_done > 0 and c_archer_done >= 2` */
  firstWaveReady: (ai) => ai.countDone(ai.heroId) > 0 && ai.countDone(ARCHER) >= 2,
  /** elf.ai 217–224 — the SECOND wave waits for four archers, and no other one does. */
  waveGate(ai) {
    const wave = (ai.vars[WAVE] ?? 0) + 1;
    if (wave === 2 && ai.countDone(ARCHER) < 4) return false;
    ai.vars[WAVE] = wave;
    return true;
  },
  attackFlags(ai) {
    const level = forceLevel(ai);
    const airUnits = ai.countDone(CHIMAERA) > 0 || ai.countDone(FAERIE_DRAGON) > 0;
    return {
      needsExp: ai.takeExp && (level >= 9 || ai.goldOwned() < 2000),
      hasSiege: level >= 40 || ai.countDone(BALLISTA) > 0 || ai.countDone(CHIMAERA) > 0
        || ai.countDone(MOUNTAIN_GIANT) > 0,
      airUnits,
      allowAirCreeps: airUnits || ai.countDone(ARCHER) > 3,
    };
  },
  /** `if b_hero2_done or (NEWBIE and c_moon_well_done >= 4)` — the archer latch beside it in
   *  the same `if basic_opening then` block is `initVars`' above, because it keeps running
   *  after this one has dropped. */
  openingDone: (ai) =>
    ai.countDone(ai.heroId2) > 0 || (ai.meleeDifficulty() === MELEE_NEWBIE && ai.countDone(MOON_WELL) >= 4),
  buildSequence,
  peonAssignment,
};
