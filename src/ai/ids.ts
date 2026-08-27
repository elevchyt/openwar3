// The AI scripts' vocabulary — `Scripts\common.ai`'s `globals` block (lines 144–736), which
// is where Blizzard's own melee AI names every unit, building, upgrade and hero ability it
// asks for. Transcribed here under the SAME NAMES so `human.ts`/`orc.ts`/`undead.ts`/`elf.ts`
// read line-for-line against `human.ai`/`orc.ai`/`undead.ai`/`elf.ai` (see docs/melee-ai.md).
//
// Nothing here is a guess or a lookup: `constant integer FOOTMAN = 'hfoo'` is the game's own
// line. The aliases the file declares (FOOTMEN = FOOTMAN, GYRO = COPTER, CRYPT_FIEND =
// PIT_FIEND, MOON_BABE = MOON_CHICK…) are kept too, because the race scripts use both halves
// of several of them and dropping one would silently rename a build order.

// --------------------------------------------------------------------------------------
//  HUMANS
// --------------------------------------------------------------------------------------

export const ARCHMAGE = "Hamg";
export const PALADIN = "Hpal";
export const MTN_KING = "Hmkg";
export const BLOOD_MAGE = "Hblm";

export const AVATAR = "AHav";
export const BASH = "AHbh";
export const THUNDER_BOLT = "AHtb";
export const THUNDER_CLAP = "AHtc";
export const DEVOTION_AURA = "AHad";
export const DIVINE_SHIELD = "AHds";
export const HOLY_BOLT = "AHhb";
export const RESURRECTION = "AHre";
export const BLIZZARD = "AHbz";
export const BRILLIANCE_AURA = "AHab";
export const MASS_TELEPORT = "AHmt";
export const WATER_ELEMENTAL = "AHwe";
export const BANISH = "AHbn";
export const FLAME_STRIKE = "AHfs";
export const SUMMON_PHOENIX = "AHpx";
export const SIPHON_MANA = "AHdr";

export const COPTER = "hgyr";
export const GYRO = COPTER;
export const FOOTMAN = "hfoo";
export const FOOTMEN = FOOTMAN;
export const GRYPHON = "hgry";
export const KNIGHT = "hkni";
export const MORTAR = "hmtm";
export const PEASANT = "hpea";
export const PRIEST = "hmpr";
export const RIFLEMAN = "hrif";
export const RIFLEMEN = RIFLEMAN;
export const SORCERESS = "hsor";
export const TANK = "hmtt";
export const MILITIA = "hmil";
export const SPELL_BREAKER = "hspt";
export const HUMAN_DRAGON_HAWK = "hdhw";

export const AVIARY = "hgra";
export const BARRACKS = "hbar";
export const BLACKSMITH = "hbla";
export const CANNON_TOWER = "hctw";
export const CASTLE = "hcas";
export const GUARD_TOWER = "hgtw";
export const HOUSE = "hhou";
export const HUMAN_ALTAR = "halt";
export const KEEP = "hkee";
export const LUMBER_MILL = "hlum";
export const SANCTUM = "hars";
export const TOWN_HALL = "htow";
export const WATCH_TOWER = "hwtw";
export const WORKSHOP = "harm";
export const ARCANE_VAULT = "hvlt";
export const ARCANE_TOWER = "hatw";

export const UPG_MELEE = "Rhme";
export const UPG_RANGED = "Rhra";
export const UPG_ARMOR = "Rhar";
export const UPG_MASONRY = "Rhac";
export const UPG_DEFEND = "Rhde";
export const UPG_BREEDING = "Rhan";
export const UPG_PRAYING = "Rhpt";
export const UPG_SORCERY = "Rhst";
export const UPG_LEATHER = "Rhla";
export const UPG_GUN_RANGE = "Rhri";
export const UPG_WOOD = "Rhlh";
export const UPG_SENTINEL = "Rhse";
export const UPG_BOMBS = "Rhgb";
export const UPG_HAMMERS = "Rhhb";
/** common.ai declares `UPG_CONT_MAGIC = 'Rhss'` — the SAME rawcode as `UPG_SIGHT`. That is
 *  the file's own value, kept rather than "corrected": Control Magic is `Rhss` in
 *  HumanUpgradeFunc.txt and Improved Sight never had a separate row. */
export const UPG_CONT_MAGIC = "Rhss";
export const UPG_FRAGS = "Rhfs";
export const UPG_TANK = "Rhrt";
export const UPG_FLAK = "Rhfc";
export const UPG_CLOUD = "Rhcd";

// --------------------------------------------------------------------------------------
//  ORCS
// --------------------------------------------------------------------------------------

export const BLADE_MASTER = "Obla";
export const FAR_SEER = "Ofar";
export const TAUREN_CHIEF = "Otch";
export const SHADOW_HUNTER = "Oshd";

export const CRITICAL_STRIKE = "AOcr";
export const MIRROR_IMAGE = "AOmi";
export const BLADE_STORM = "AOww";
export const WIND_WALK = "AOwk";
export const CHAIN_LIGHTNING = "AOcl";
export const EARTHQUAKE = "AOeq";
export const FAR_SIGHT = "AOfs";
export const SPIRIT_WOLF = "AOsf";
export const ENDURANE_AURA = "AOae"; // (sic — common.ai spells it this way)
export const REINCARNATION = "AOre";
export const SHOCKWAVE = "AOsh";
export const WAR_STOMP = "AOws";
export const HEALING_WAVE = "AOhw";
export const HEX = "AOhx";
export const SERPENT_WARD = "AOsw";
export const VOODOO = "AOvd";

export const CATAPULT = "ocat";
export const WITCH_DOCTOR = "odoc";
export const GRUNT = "ogru";
export const HEAD_HUNTER = "ohun";
export const BERSERKER = "otbk";
export const KODO_BEAST = "okod";
export const PEON = "opeo";
export const RAIDER = "orai";
export const SHAMAN = "oshm";
export const TAUREN = "otau";
export const WYVERN = "owyv";
export const BATRIDER = "otbr";
export const SPIRIT_WALKER = "ospw";
export const SPIRIT_WALKER_M = "ospm";

export const ORC_ALTAR = "oalt";
export const ORC_BARRACKS = "obar";
export const BESTIARY = "obea";
export const FORGE = "ofor";
export const FORTRESS = "ofrt";
export const GREAT_HALL = "ogre";
export const LODGE = "osld";
export const STRONGHOLD = "ostr";
export const BURROW = "otrb";
export const TOTEM = "otto";
export const ORC_WATCH_TOWER = "owtw";
export const VOODOO_LOUNGE = "ovln";

export const UPG_ORC_MELEE = "Rome";
export const UPG_ORC_RANGED = "Rora";
export const UPG_ORC_ARMOR = "Roar";
export const UPG_ORC_WAR_DRUMS = "Rwdm";
export const UPG_ORC_PILLAGE = "Ropg";
export const UPG_ORC_BERSERK = "Robs";
export const UPG_ORC_PULVERIZE = "Rows";
export const UPG_ORC_ENSNARE = "Roen";
export const UPG_ORC_VENOM = "Rovs";
export const UPG_ORC_DOCS = "Rowd";
export const UPG_ORC_SHAMAN = "Rost";
export const UPG_ORC_SPIKES = "Rosp";
export const UPG_ORC_BURROWS = "Rorb";
export const UPG_ORC_REGEN = "Rotr";
export const UPG_ORC_FIRE = "Rolf";
export const UPG_ORC_SWALKER = "Rowt";
export const UPG_ORC_BERSERKER = "Robk";

export const ZEPPLIN = "nzep";
export const ZEPPELIN = ZEPPLIN;

// --------------------------------------------------------------------------------------
//  UNDEAD
// --------------------------------------------------------------------------------------

export const DEATH_KNIGHT = "Udea";
export const DREAD_LORD = "Udre";
export const LICH = "Ulic";
export const CRYPT_LORD = "Ucrl";

export const SLEEP = "AUsl";
export const VAMP_AURA = "AUav";
export const CARRION_SWARM = "AUcs";
export const INFERNO = "AUin";
export const DARK_RITUAL = "AUdr";
export const DEATH_DECAY = "AUdd";
export const FROST_ARMOR = "AUfu";
export const FROST_NOVA = "AUfn";
export const ANIM_DEAD = "AUan";
export const DEATH_COIL = "AUdc";
export const DEATH_PACT = "AUdp";
export const UNHOLY_AURA = "AUau";
export const CARRION_SCARAB = "AUcb";
export const IMPALE = "AUim";
export const LOCUST_SWARM = "AUls";
export const THORNY_SHIELD = "AUts";

export const ABOMINATION = "uabo";
export const ACOLYTE = "uaco";
export const BANSHEE = "uban";
export const PIT_FIEND = "ucry";
export const CRYPT_FIEND = PIT_FIEND;
export const FROST_WYRM = "ufro";
export const GARGOYLE = "ugar";
export const GARGOYLE_MORPH = "ugrm";
export const GHOUL = "ugho";
export const MEAT_WAGON = "umtw";
export const NECRO = "unec";
export const SHADE = "ushd";
export const OBSIDIAN_STATUE = "uobs";
export const OBS_STATUE = OBSIDIAN_STATUE;
export const BLK_SPHINX = "ubsp";

export const UNDEAD_MINE = "ugol";
export const UNDEAD_ALTAR = "uaod";
export const BONEYARD = "ubon";
export const NECROPOLIS_1 = "unpl"; // normal
export const NECROPOLIS_2 = "unp1"; // upgraded once
export const NECROPOLIS_3 = "unp2"; // full upgrade
export const SAC_PIT = "usap";
export const CRYPT = "usep";
export const SLAUGHTERHOUSE = "uslh";
export const DAMNED_TEMPLE = "utod";
export const ZIGGURAT_1 = "uzig"; // normal
export const ZIGGURAT_2 = "uzg1"; // upgraded (Spirit Tower)
export const ZIGGURAT_FROST = "uzg2"; // frost tower
export const GRAVEYARD = "ugrv";
export const TOMB_OF_RELICS = "utom";

export const UPG_UNHOLY_STR = "Rume";
export const UPG_CR_ATTACK = "Rura";
export const UPG_UNHOLY_ARMOR = "Ruar";
export const UPG_CANNIBALIZE = "Ruac";
export const UPG_GHOUL_FRENZY = "Rugf";
export const UPG_FIEND_WEB = "Ruwb";
export const UPG_STONE_FORM = "Rusf";
export const UPG_NECROS = "Rune";
export const UPG_BANSHEE = "Ruba";
export const UPG_WYRM_BREATH = "Rufb";
export const UPG_SKEL_LIFE = "Rusl";
export const UPG_SKEL_MASTERY = "Rusm";
export const UPG_CR_ARMOR = "Rucr";
export const UPG_PLAGUE = "Rupc";
export const UPG_BLK_SPHINX = "Rusp";
export const UPG_BURROWING = "Rubu";

// --------------------------------------------------------------------------------------
//  NIGHT ELVES
// --------------------------------------------------------------------------------------

export const DEMON_HUNTER = "Edem";
export const KEEPER = "Ekee";
export const MOON_CHICK = "Emoo";
export const MOON_BABE = MOON_CHICK;
export const MOON_HONEY = MOON_CHICK;
export const WARDEN = "Ewar";

export const FORCE_NATURE = "AEfn";
export const ENT_ROOTS = "AEer";
export const THORNS_AURA = "AEah";
export const TRANQUILITY = "AEtq";
export const EVASION = "AEev";
export const IMMOLATION = "AEim";
export const MANA_BURN = "AEmb";
export const METAMORPHOSIS = "AEme";
/** Not a typo: Searing Arrows really is an `AH*` code — common.ai says `'AHfa'`. */
export const SEARING_ARROWS = "AHfa";
export const SCOUT = "AEst";
export const STARFALL = "AEsf";
export const TRUESHOT = "AEar";
export const BLINK = "AEbl";
export const FAN_KNIVES = "AEfk";
export const SHADOW_TOUCH = "AEsh";
export const VENGEANCE = "AEsv";

export const WISP = "ewsp";
export const ARCHER = "earc";
export const DRUID_TALON = "edot";
export const DRUID_TALON_M = "edtm";
export const BALLISTA = "ebal";
export const DRUID_CLAW = "edoc";
export const DRUID_CLAW_M = "edcm";
export const DRYAD = "edry";
export const HIPPO = "ehip";
export const HIPPO_RIDER = "ehpr";
export const HUNTRESS = "esen";
export const CHIMAERA = "echm";
export const MOUNTAIN_GIANT = "emtg";
export const FAERIE_DRAGON = "efdr";

export const ANCIENT_LORE = "eaoe";
export const ANCIENT_WAR = "eaom";
export const ANCIENT_WIND = "eaow";
export const TREE_AGES = "etoa";
export const TREE_ETERNITY = "etoe";
export const TREE_LIFE = "etol";
export const ANCIENT_PROTECT = "etrp";
export const ELF_ALTAR = "eate";
export const CHIMAERA_ROOST = "edos";
export const HUNTERS_HALL = "edob";
export const MOON_WELL = "emow";
export const ELF_MINE = "egol";
export const DEN_OF_WONDERS = "eden";

export const UPG_STR_MOON = "Resm";
export const UPG_STR_WILD = "Resw";
export const UPG_MOON_ARMOR = "Rema";
export const UPG_HIDES = "Rerh";
export const UPG_ULTRAVISION = "Reuv";
export const UPG_SCOUT = "Resc";
export const UPG_GLAIVE = "Remg";
export const UPG_BOWS = "Reib";
export const UPG_MARKSMAN = "Remk";
export const UPG_DRUID_TALON = "Redt";
export const UPG_DRUID_CLAW = "Redc";
export const UPG_ABOLISH = "Resi";
export const UPG_CHIM_ACID = "Recb";
export const UPG_BOLT = "Repd";
export const UPG_MARK_CLAW = "Reeb";
export const UPG_MARK_TALON = "Reec";
export const UPG_HARD_SKIN = "Rehs";
export const UPG_RESIST_SKIN = "Rers";
export const UPG_WELL_SPRING = "Rews";

// --------------------------------------------------------------------------------------
//  Scalars
// --------------------------------------------------------------------------------------

/** `MeleeDifficulty()` — the lobby's Computer (Easy/Normal/Insane) as common.ai numbers it
 *  (Scripts\common.ai 662-664). Each slot is seated at one of these on the Custom Game and
 *  LAN lobby screens, under GlobalStrings.fdf's own labels (COMPUTER_NEWBIE / COMPUTER_NORMAL
 *  / COMPUTER_INSANE) — see ui/playerSlots.ts.
 *
 *  The scripts branch on NEWBIE heavily (`MeleeDifficulty() != MELEE_NEWBIE` guards every
 *  tower, second hero and upgrade tier); INSANE they never mention, because everything it
 *  gets is the ENGINE's rather than the script's — see docs/melee-ai.md "The difficulty
 *  spread". */
export const MELEE_NEWBIE = 1;
export const MELEE_NORMAL = 2;
export const MELEE_INSANE = 3;

/**
 * What an INSANE computer is paid for a load its workers actually carried home.
 *
 * Not a value in any of the game's files — it is engine behaviour, and this is the one number
 * on the ladder that had to be sourced from outside the install. Empirically documented in the
 * community for as long as the difficulty has existed: an insane AI banks **twice** what it
 * harvested (a +10 gold trip credits +20), while easy and normal are paid the flat rate. See
 * TV Tropes' "Not Playing Fair With Resources" (Warcraft III entry) and the Hive Workshop
 * thread "How to double resources workers harvest?", which describes the same doubling in
 * terms of the Harvest ability's gold/lumber capacity.
 *
 * Applied by `RtsController.startMeleeAI` to the CREDIT (SimWorld.setHarvestBonus), never to
 * the load: the mine gives up the same ten gold and runs dry on the same schedule for
 * everyone. An insane computer is paid double for the same digging.
 */
export const INSANE_HARVEST_FACTOR = 2;

/** The food counts the scripts throttle themselves at — common.ai's own
 *  `UPKEEP_TIER1`/`UPKEEP_TIER2`, the same 50/80 the resource bar's `upkeepBand` colours. */
export const UPKEEP_TIER1 = 50;
export const UPKEEP_TIER2 = 80;

/** `SetBuildAll`'s `t` argument — which of the three lists a build-array row belongs to. */
export const BUILD_UNIT = 1;
export const BUILD_UPGRADE = 2;
export const BUILD_EXPAND = 3;

/** Every id whose completed count folds into another's, straight out of `TownCountEx`
 *  (common.ai 1102–1163): a Castle IS a Town Hall for "do I have a hall?" purposes, a
 *  Berserker IS a Headhunter, a Spirit Tower IS a Ziggurat. Read by `AiPlayer.townCount`.
 *
 *  Direction matters and is the file's: asking for the BASE id counts the upgraded ones,
 *  never the other way round — `SetBuildUnit(1, KEEP)` on a player who owns a Castle must
 *  be satisfied, while `SetBuildUnit(1, TOWN_HALL)` on one who owns only a Keep must not
 *  raise a second hall. */
export const TOWN_COUNT_EQUIVALENTS: Record<string, string[]> = {
  [TOWN_HALL]: [KEEP, CASTLE],
  [KEEP]: [CASTLE],
  [WATCH_TOWER]: [GUARD_TOWER, CANNON_TOWER, ARCANE_TOWER],
  [PEASANT]: [MILITIA],
  [GREAT_HALL]: [STRONGHOLD, FORTRESS],
  [STRONGHOLD]: [FORTRESS],
  [HEAD_HUNTER]: [BERSERKER],
  [SPIRIT_WALKER]: [SPIRIT_WALKER_M],
  [SPIRIT_WALKER_M]: [SPIRIT_WALKER],
  [NECROPOLIS_1]: [NECROPOLIS_2, NECROPOLIS_3],
  [NECROPOLIS_2]: [NECROPOLIS_3],
  [ZIGGURAT_1]: [ZIGGURAT_2, ZIGGURAT_FROST],
  [GARGOYLE]: [GARGOYLE_MORPH],
  [TREE_LIFE]: [TREE_AGES, TREE_ETERNITY],
  [TREE_AGES]: [TREE_ETERNITY],
  [DRUID_TALON]: [DRUID_TALON_M],
  [DRUID_TALON_M]: [DRUID_TALON],
  [DRUID_CLAW]: [DRUID_CLAW_M],
  [DRUID_CLAW_M]: [DRUID_CLAW],
};
