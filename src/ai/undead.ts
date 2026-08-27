import type { AiPlayer } from "./aiPlayer";
import type { MeleeScript } from "./script";
import {
  ABOMINATION, ACOLYTE, ANIM_DEAD, BANSHEE, BLK_SPHINX, BONEYARD, CARRION_SCARAB, CARRION_SWARM,
  CRYPT, CRYPT_FIEND, CRYPT_LORD, DAMNED_TEMPLE, DARK_RITUAL, DEATH_COIL, DEATH_DECAY,
  DEATH_KNIGHT, DEATH_PACT, DREAD_LORD, FROST_ARMOR, FROST_NOVA, FROST_WYRM, GARGOYLE,
  GHOUL, GRAVEYARD, IMPALE, INFERNO, LICH, LOCUST_SWARM, MEAT_WAGON, MELEE_NEWBIE,
  NECRO, NECROPOLIS_1, NECROPOLIS_2, NECROPOLIS_3, OBS_STATUE, SAC_PIT, SLAUGHTERHOUSE, SLEEP,
  THORNY_SHIELD, TOMB_OF_RELICS, UNDEAD_ALTAR, UNDEAD_MINE, UNHOLY_AURA, UPG_BANSHEE,
  UPG_BLK_SPHINX, UPG_BURROWING, UPG_CANNIBALIZE, UPG_CR_ARMOR, UPG_CR_ATTACK, UPG_FIEND_WEB,
  UPG_GHOUL_FRENZY, UPG_NECROS, UPG_PLAGUE, UPG_SKEL_LIFE, UPG_SKEL_MASTERY, UPG_STONE_FORM,
  UPG_UNHOLY_ARMOR, UPG_UNHOLY_STR, UPG_WYRM_BREATH, UPKEEP_TIER1, UPKEEP_TIER2, VAMP_AURA,
  ZIGGURAT_1, ZIGGURAT_2,
} from "./ids";

// `Scripts\undead.ai`, ported function for function.
//
// The undead is the one race whose WORKERS are two different units doing two different jobs:
// Acolytes only ever mine (in a ring around a Haunted Gold Mine — docs/undead.md) and Ghouls
// only ever chop. That is why this script alone carries `AG`/`WG`, a running split of its
// ghouls between the attack wave and the forest, and why its `peon_assignment` asks for gold
// town by town rather than in one priority ladder.

const AG = "AG"; // attacking ghouls
const WG = "WG"; // wood ghouls

/** `set_skills` — undead.ai 61–145. Note the Dread Lord and the Crypt Lord get a DIFFERENT
 *  array in slot 1 than in slots 2 and 3: the first one you draw is built to lead. */
function setSkills(ai: AiPlayer): void {
  const lich = [FROST_NOVA, FROST_ARMOR, FROST_NOVA, DARK_RITUAL, FROST_NOVA, DEATH_DECAY,
    FROST_ARMOR, DARK_RITUAL, FROST_ARMOR, DARK_RITUAL];
  for (const slot of [1, 2, 3]) ai.setSkillArray(slot, LICH, lich);

  ai.setSkillArray(1, DREAD_LORD, [SLEEP, VAMP_AURA, SLEEP, CARRION_SWARM, SLEEP, INFERNO,
    CARRION_SWARM, VAMP_AURA, CARRION_SWARM, VAMP_AURA]);
  const dreadLord23 = [CARRION_SWARM, SLEEP, CARRION_SWARM, VAMP_AURA, CARRION_SWARM, INFERNO,
    VAMP_AURA, VAMP_AURA, SLEEP, SLEEP];
  ai.setSkillArray(2, DREAD_LORD, dreadLord23);
  ai.setSkillArray(3, DREAD_LORD, dreadLord23);

  const deathKnight = [DEATH_COIL, UNHOLY_AURA, DEATH_COIL, UNHOLY_AURA, DEATH_COIL, ANIM_DEAD,
    UNHOLY_AURA, DEATH_PACT, DEATH_PACT, DEATH_PACT];
  for (const slot of [1, 2, 3]) ai.setSkillArray(slot, DEATH_KNIGHT, deathKnight);

  ai.setSkillArray(1, CRYPT_LORD, [CARRION_SCARAB, THORNY_SHIELD, CARRION_SCARAB, IMPALE,
    CARRION_SCARAB, LOCUST_SWARM, THORNY_SHIELD, IMPALE, THORNY_SHIELD, IMPALE]);
  const cryptLord23 = [IMPALE, THORNY_SHIELD, IMPALE, THORNY_SHIELD, IMPALE, LOCUST_SWARM,
    THORNY_SHIELD, CARRION_SCARAB, CARRION_SCARAB, CARRION_SCARAB];
  ai.setSkillArray(2, CRYPT_LORD, cryptLord23);
  ai.setSkillArray(3, CRYPT_LORD, cryptLord23);
}

/** `setup_force` — undead.ai 150–177. */
function setupForce(ai: AiPlayer): void {
  ai.initMeleeGroup();
  // The ghouls join by the running split, not by three-quarters of the count: `WG` of them
  // are in the forest and must stay there.
  ai.setAssaultGroup(ai.vars[AG] ?? 0, ai.vars[AG] ?? 0, GHOUL);
  ai.setMeleeGroup(ai.heroId);
  ai.setMeleeGroup(ai.heroId2);
  ai.setMeleeGroup(ai.heroId3);
  ai.setMeleeGroup(CRYPT_FIEND);
  ai.setMeleeGroup(ABOMINATION);
  ai.setMeleeGroup(NECRO);
  ai.setMeleeGroup(BANSHEE);
  ai.setMeleeGroup(GARGOYLE);
  ai.setMeleeGroup(FROST_WYRM);
  ai.setMeleeGroup(OBS_STATUE);
  if (ai.countDone(BLK_SPHINX) >= 1) ai.setMeleeGroup(BLK_SPHINX);
}

/** `force_level` — undead.ai 182–190. */
function forceLevel(ai: AiPlayer): number {
  let level = 4; // basic hero
  level += 2 * ((ai.vars[AG] ?? 0) + ai.countDone(NECRO) + ai.countDone(BANSHEE) + ai.countDone(OBS_STATUE));
  level += 3 * (ai.countDone(CRYPT_FIEND) + ai.townCountDone(GARGOYLE) + ai.countDone(BLK_SPHINX));
  level += 4 * ai.countDone(ABOMINATION);
  level += 5 * ai.countDone(ai.heroId3);
  level += 6 * (ai.countDone(ai.heroId2) + ai.countDone(FROST_WYRM));
  return level;
}

/** `undead_mine(townid)` — undead.ai 315–319. Keep haunting mines while gold is short. */
function undeadMine(ai: AiPlayer, town: number): void {
  if (ai.gold() < 1000 && ai.townHasMine(town)) ai.secondaryTown(town, 1, UNDEAD_MINE);
}

/** `do_upgrades` — undead.ai 324–392. */
function doUpgrades(ai: AiPlayer): void {
  const hallsDone = ai.townCountDone(NECROPOLIS_2);
  const citadelDone = ai.countDone(NECROPOLIS_3);
  const graveDone = ai.countDone(GRAVEYARD);
  const templeDone = ai.countDone(DAMNED_TEMPLE);

  if (hallsDone >= 1 && ai.count(CRYPT_FIEND) >= 1) ai.setBuildUpgr(1, UPG_BURROWING);

  if (graveDone >= 1 && citadelDone >= 1) {
    if (ai.townCount(GARGOYLE) >= 1) ai.setBuildUpgr(1, UPG_STONE_FORM);
    ai.setBuildUpgr(1, UPG_GHOUL_FRENZY);
  }

  if (ai.countDone(BONEYARD) >= 1) ai.setBuildUpgr(1, UPG_WYRM_BREATH);

  if (templeDone >= 1) {
    if (ai.count(NECRO) >= 1) {
      ai.setBuildUpgr(1, UPG_NECROS);
      if (citadelDone >= 1) {
        ai.setBuildUpgr(2, UPG_NECROS);
        ai.setBuildUpgr(2, UPG_SKEL_MASTERY);
      }
    }
    if (ai.count(BANSHEE) >= 1) {
      ai.setBuildUpgr(1, UPG_BANSHEE);
      if (citadelDone >= 1) ai.setBuildUpgr(2, UPG_BANSHEE);
    }
    if (ai.count(NECRO) >= 1) ai.setBuildUpgr(1, UPG_SKEL_LIFE);
  }

  if (graveDone >= 1) {
    ai.setBuildUpgr(1, UPG_CR_ATTACK);
    ai.setBuildUpgr(1, UPG_CR_ARMOR);
    ai.setBuildUpgr(1, UPG_UNHOLY_STR);
    ai.setBuildUpgr(1, UPG_UNHOLY_ARMOR);
    if (hallsDone >= 1) {
      ai.setBuildUpgr(2, UPG_CR_ATTACK);
      ai.setBuildUpgr(2, UPG_CR_ARMOR);
      ai.setBuildUpgr(2, UPG_UNHOLY_STR);
      ai.setBuildUpgr(2, UPG_UNHOLY_ARMOR);
      if (citadelDone >= 1) {
        ai.setBuildUpgr(3, UPG_CR_ATTACK);
        ai.setBuildUpgr(3, UPG_CR_ARMOR);
        ai.setBuildUpgr(3, UPG_UNHOLY_STR);
        ai.setBuildUpgr(3, UPG_UNHOLY_ARMOR);
      }
    }
  }

  if (ai.countDone(SLAUGHTERHOUSE) >= 1 && citadelDone >= 1) {
    if (ai.count(ABOMINATION) >= 1) ai.setBuildUpgr(1, UPG_PLAGUE);
    if (ai.count(OBS_STATUE) >= 1 && ai.countDone(TOMB_OF_RELICS) >= 1) ai.setBuildUpgr(1, UPG_BLK_SPHINX);
  }
  // (`UPG_EXHUME` is commented out in the shipped script — left out here too.)
}

/** `build_sequence` — undead.ai 397–566. */
function buildSequence(ai: AiPlayer): void {
  const newbie = ai.meleeDifficulty() === MELEE_NEWBIE;
  ai.initBuildArray();

  if (ai.basicOpening) {
    ai.meleeTownHall(0, NECROPOLIS_1);

    ai.setBuildUnit(1, ACOLYTE);
    ai.setBuildUnit(1, UNDEAD_MINE);
    ai.setBuildNext(5, ACOLYTE);
    ai.setBuildUnit(1, CRYPT);
    ai.setBuildUnit(1, GHOUL);
    ai.setBuildUnit(1, ZIGGURAT_1);
    ai.setBuildUnit(1, UNDEAD_ALTAR);
    ai.setBuildUnit(2, GHOUL);
    ai.setBuildUnit(2, ZIGGURAT_1);
    ai.setBuildUnit(3, GHOUL);
    ai.setBuildUnit(1, ai.heroId);
    ai.setBuildUnit(6, GHOUL);
    ai.setBuildUpgr(1, UPG_CANNIBALIZE);
    ai.setBuildUnit(1, GRAVEYARD);
    ai.setBuildUnit(7, GHOUL);
    ai.setBuildUnit(1, NECROPOLIS_2);
    ai.setBuildUnit(3, ZIGGURAT_1);
    ai.setBuildUnit(8, GHOUL);
    ai.setBuildUnit(2, CRYPT_FIEND);
    ai.setBuildUnit(1, TOMB_OF_RELICS);
    ai.setBuildUnit(3, CRYPT_FIEND);
    ai.setBuildUpgr(1, UPG_FIEND_WEB);

    if (!newbie) ai.setBuildUnit(1, ai.heroId2);

    undeadMine(ai, 1);
    ai.basicExpansion(ai.minesOwned() < 2, UNDEAD_MINE);
    return;
  }

  const gold = ai.gold();
  const wood = ai.wood();
  const mines = ai.minesOwned();
  const goldOwned = ai.goldOwned();
  const foodUsed = ai.foodUsed();
  const necropolises = ai.townCount(NECROPOLIS_1);
  const zigs = ai.townCount(ZIGGURAT_1);
  const foodMade = necropolises * ai.foodMade(NECROPOLIS_1) + zigs * ai.foodMade(ZIGGURAT_1);
  const citadelDone = ai.countDone(NECROPOLIS_3);
  const hallsDone = ai.townCountDone(NECROPOLIS_2);
  const undeadMines = ai.count(UNDEAD_MINE);
  const sphinxOk = ai.upgradeLevel(UPG_BLK_SPHINX) > 0;

  // need an acolyte or nothing will get built
  if (ai.townCountDone(NECROPOLIS_1) >= 1) ai.setBuildUnit(1, ACOLYTE);

  // keep producing mines and acolytes to get gold
  undeadMine(ai, 0);
  undeadMine(ai, 1);

  if (undeadMines >= 2) ai.setBuildNext(10, ACOLYTE);
  else if (undeadMines === 1) ai.setBuildNext(5, ACOLYTE);

  // ghouls collect lumber
  const wg2 = Math.max(0, 10 - Math.floor(wood / 120));
  if (wg2 > 0) {
    ai.setBuildUnit(1, CRYPT);
    ai.setBuildNext(wg2, GHOUL);
  }

  // if we have low gold in our mines then we need to expand
  if (goldOwned < 2000 || (mines < 2 && ai.count(ACOLYTE) > 5)) {
    ai.basicExpansion(mines < 2, UNDEAD_MINE);
    if (!newbie) {
      ai.guardSecondary(1, 2, ZIGGURAT_1);
      if (ai.countDone(GRAVEYARD) >= 1) ai.guardSecondary(1, 2, ZIGGURAT_2);
    }
  }

  // get enough ziggurats to handle current food demand
  if (foodUsed + 7 >= foodMade) ai.setBuildUnit(ai.townCountDone(ZIGGURAT_1) + 1, ZIGGURAT_1);

  // always rebuild heroes for defense
  if (ai.countDone(UNDEAD_ALTAR) >= 1) {
    if (ai.countDone(ai.heroId) >= 1 && !newbie) {
      if (ai.countDone(ai.heroId2) >= 1) {
        if (ai.countDone(ai.heroId3) >= 1 || citadelDone >= 1) ai.setBuildUnit(1, ai.heroId3);
      } else {
        ai.setBuildUnit(1, ai.heroId2);
      }
    } else {
      ai.setBuildUnit(1, ai.heroId);
    }
  } else {
    ai.setBuildUnit(1, UNDEAD_ALTAR);
  }

  // minimum melee defense
  if (ai.countDone(SLAUGHTERHOUSE) >= 1 && citadelDone >= 1) {
    ai.setBuildNext(2, ABOMINATION);
  } else {
    ai.setBuildUnit(1, CRYPT);
    ai.setBuildNext(wg2 + 6, GHOUL);
  }

  // minimum ranged/air defense
  ai.setBuildUnit(1, GRAVEYARD);
  if (citadelDone >= 1) {
    ai.setBuildNext(4, GARGOYLE);
  } else {
    ai.setBuildUnit(1, CRYPT);
    ai.setBuildNext(3, CRYPT_FIEND);
  }

  // siege attackers
  if (ai.countDone(BONEYARD) >= 1) {
    ai.setBuildNext(2, FROST_WYRM);
  } else if (ai.countDone(SLAUGHTERHOUSE) >= 1) {
    ai.setBuildNext(2, MEAT_WAGON);
  } else {
    ai.meleeTownHall(0, NECROPOLIS_1);
    ai.setBuildUnit(1, NECROPOLIS_1);
    ai.setBuildUnit(1, NECROPOLIS_2);
    ai.setBuildUnit(1, SLAUGHTERHOUSE);
    ai.setBuildNext(2, MEAT_WAGON);
  }

  // if we have a lot of gold then advance the tech tree
  if (gold > 1000) {
    ai.meleeTownHall(0, NECROPOLIS_1);

    ai.setBuildUnit(1, NECROPOLIS_1);
    ai.setBuildUnit(1, CRYPT);
    ai.setBuildUnit(1, GRAVEYARD);
    ai.setBuildUnit(1, TOMB_OF_RELICS);
    ai.setBuildUnit(1, NECROPOLIS_2);

    ai.setBuildNext(Math.min(ai.townCountDone(NECROPOLIS_1), hallsDone + 1), NECROPOLIS_2);
    ai.setBuildNext(Math.min(ai.townCountDone(ZIGGURAT_1), ai.countDone(ZIGGURAT_2) + 1), ZIGGURAT_2);

    ai.setBuildUnit(1, SLAUGHTERHOUSE);
    ai.setBuildUnit(1, DAMNED_TEMPLE);
    ai.setBuildUnit(1, NECROPOLIS_3);
    ai.setBuildUnit(1, SAC_PIT);
    ai.setBuildUnit(1, BONEYARD);

    doUpgrades(ai);

    if (gold > 2000) {
      ai.buildFactory(CRYPT);
      ai.buildFactory(DAMNED_TEMPLE);
      ai.buildFactory(SLAUGHTERHOUSE);
      ai.buildFactory(BONEYARD);
    }
  } else if (foodUsed >= UPKEEP_TIER1) {
    doUpgrades(ai);
  }

  undeadMine(ai, 1);
  ai.basicExpansion(mines < 2, UNDEAD_MINE);
  ai.meleeTownHall(1, NECROPOLIS_1);

  if (foodUsed >= UPKEEP_TIER2 - 10 && gold < 2000) return;

  // extra troops
  if (citadelDone >= 1 && ai.countDone(TOMB_OF_RELICS) >= 1) {
    ai.setBuildUnit(1, OBS_STATUE);
    if (sphinxOk) ai.setBuildUnit(1, BLK_SPHINX);
  }

  if (ai.countDone(DAMNED_TEMPLE) >= 1) {
    ai.setBuildUnit(4, NECRO);
    ai.setBuildUnit(2, BANSHEE);
  }

  if (citadelDone >= 1 && ai.countDone(TOMB_OF_RELICS) >= 1 && sphinxOk) ai.setBuildUnit(2, BLK_SPHINX);

  if (goldOwned < 10000) {
    undeadMine(ai, 2);
    ai.basicExpansion(mines < 3, UNDEAD_MINE);
    ai.meleeTownHall(2, NECROPOLIS_1);
    ai.guardSecondary(2, 2, ZIGGURAT_1);
  }
  // (Zeppelin branch not ported — see human.ts.)
}

/** `peon_assignment` — undead.ai 571–594, and its `harvest_gold` helper above it. */
function peonAssignment(ai: AiPlayer): void {
  ai.clearHarvestAI();
  for (const t of [0, 1, 2, 3]) if (ai.townHasMine(t)) ai.harvestGold(t, 5);
  ai.harvestWood(0, ai.vars[WG] ?? 0);
}

export const UNDEAD_AI: MeleeScript = {
  heroes: [DEATH_KNIGHT, DREAD_LORD, LICH, CRYPT_LORD], // PickMeleeHero(RACE_UNDEAD)
  setSkills,
  /** `set WG = Max(0, c_ghoul_done - AG)` — undead.ai 296. Every ghoul the wave has not
   *  claimed is a lumberjack, and this is the line that says so: `peon_assignment` asks for
   *  `WG` of them by name, so a `WG` that is never refreshed is an undead that never chops. */
  initVars(ai) {
    ai.vars[WG] = Math.max(0, ai.countDone(GHOUL) - (ai.vars[AG] ?? 0));
  },
  setupForce,
  forceLevel,
  /** `loop exitwhen c_hero1_done >= 1` — the undead does not wait for a front line. */
  firstWaveReady: (ai) => ai.countDone(ai.heroId) >= 1,
  /**
   * undead.ai 205–219 — the ghoul split. In the opening the wave is exactly six ghouls and
   * the rest keep chopping; afterwards the forest keeps however many the LUMBER stock says
   * (10 minus a ghoul per 120 wood) and everything left over attacks, once there are four
   * attackers' worth (an Abomination counting double).
   */
  waveGate(ai) {
    const ghouls = ai.countDone(GHOUL);
    if (ai.basicOpening) {
      if (ghouls < 6) return false;
      ai.vars[AG] = 6;
      ai.vars[WG] = ghouls - 6;
      return true;
    }
    const wg = Math.max(0, Math.min(10 - Math.floor(ai.wood() / 120), ghouls));
    ai.vars[WG] = wg;
    ai.vars[AG] = ghouls - wg;
    return ai.vars[AG] + 2 * ai.countDone(ABOMINATION) >= 4;
  },
  /** `set AG = 0 / set WG = c_ghoul_done` — everything goes back to the forest. */
  afterWave(ai) {
    ai.vars[AG] = 0;
    ai.vars[WG] = ai.countDone(GHOUL);
  },
  attackFlags(ai) {
    const level = forceLevel(ai);
    // `c_web_fiend_done` — fiends only count toward air creeping once they can web.
    const webFiends = ai.upgradeLevel(UPG_FIEND_WEB) > 0 ? ai.countDone(CRYPT_FIEND) : 0;
    return {
      needsExp: ai.takeExp && (level >= 9 || ai.goldOwned() < 2000),
      hasSiege: level >= 40 || ai.countDone(MEAT_WAGON) > 0 || ai.countDone(FROST_WYRM) > 0,
      airUnits: ai.townCountDone(GARGOYLE) > 0 || ai.countDone(BLK_SPHINX) > 0 || ai.countDone(FROST_WYRM) > 0,
      allowAirCreeps: 3 * ai.townCountDone(GARGOYLE) + 6 * ai.countDone(FROST_WYRM) + 2 * webFiends >= 6,
    };
  },
  /** `if basic_opening and (b_hero2_done or (NEWBIE and c_tomb_done >= 1))` */
  openingDone: (ai) =>
    ai.countDone(ai.heroId2) >= 1 || (ai.meleeDifficulty() === MELEE_NEWBIE && ai.countDone(TOMB_OF_RELICS) >= 1),
  buildSequence,
  peonAssignment,
};
