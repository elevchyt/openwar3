import War3MapViewer from "mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/viewer";
import ModelViewer from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import type { DataSource } from "../vfs/types";
import w3iParser from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";
import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import { MpqDataSource } from "../vfs/mpq";
import { parseW3E, type TerrainData } from "../world/terrain";
import { parseDoo } from "../world/doodads";
import { collectMapDestructibles, findDestructibleAt, type MapDestructible } from "../world/mapDestructibles";
import { destructibleUnitDef } from "../data/units";
import { PathingGrid, parseWpm, footprintCells, PATHING_CELL, BUILD_CELL, BUILD_CELL_CELLS } from "../sim/pathing";
import { AllianceType } from "../sim/alliances";
import { summonsBuildings, type Alert, type RallyKind, type ShopResult, type SimUnit, type SimWorld } from "../sim/world";
import { stampFootprints, stampFootprint, unstampFootprint, decodePathTex, footprintBuildable, footprintCellsAt, footprintRadius, quarterTurns, rotateFootprint, type Footprint, type PlacedFootprint } from "../sim/destructibles";
import { parseMapUnits, GOLD_MINE_ID, START_LOCATION_ID } from "../world/mapUnits";
import { loadMapScript, type MapScriptEngine } from "../jass/index";
import { EVENT_PLAYER_END_CINEMATIC } from "../jass/interpreter";
import { MAP_CONTROL, type DestructableSnapshot, type DialogObj, type EngineHooks, type RectObj, type Runtime } from "../jass/runtime";
import { makeHeightSampler, makeCliffLevelSampler, makeFootprintMaxSampler, type HeightSampler, type FootprintMaxSampler } from "../game/heightmap";
import { FogOverlay } from "./fogOverlay";
import { UberSplatOverlay } from "./uberSplatOverlay";
import { ShadowOverlay } from "./shadowOverlay";
import { parseTerrainShadows, TerrainShadowOverlay } from "./terrainShadowOverlay";
import { LightningOverlay } from "./lightningOverlay";
import { WeatherOverlay } from "./weather";
import { loadWeatherRegistry, type WeatherRegistry } from "../data/weather";
import { DebugColliders, OverlayLayer, COLLIDER_COLORS, FLOATS_PER_VERT, type ColliderBatch } from "./debugColliders";
import { FogState, VISION_CELL, type VisionMap } from "../sim/vision";
import { RtsController, ILLUSION_TINT, type RtsHost, type SelectionInfo, type PlacedRef } from "../game/rts";
import type { Instance as RtsInstance } from "../game/rts";
import type { MatchLinkSetup } from "../game/matchLink";
import { unitSnapshot, unitSnapshots } from "../game/jassHooks";
import { SoundBoard } from "../audio/sounds";
import { loadUnitRegistry, type UnitRegistry, type UnitDef } from "../data/units";
import { applyMapUnitData, applyMapAbilityData, applyMapItemData, applyMapUpgradeData, applyMapTechData } from "../data/objectData";
import { loadUberSplatRegistry, type UberSplatRegistry } from "../data/ubersplats";
import { loadLightningRegistry } from "../data/lightning";
import { specialFxPhaseAt, type SpecialFxClips } from "./specialFxClock";
import { loadAbilityRegistry, mdlPath, type AbilityRegistry, type AbilityDef, type BuffFx, isRepairCode, KNOWN_ABILITIES, requiredHeroLevel } from "../data/abilities";
import { loadCommandStrings, type CommandStrings } from "../data/commandStrings";
import { resolveTipRefs } from "../data/tipRefs";
import { loadItemRegistry, type ItemRegistry } from "../data/items";
import { CAMERA, MELEE, MISC_DATA, TEXT_TAG } from "../data/gameplayConstants";
import { DayNightCycle, type DayNightLight } from "./dayNight";
import { makeMapFog, type DistFog } from "./fog";
import { TimeIndicatorClock, timeIndicatorPath } from "./timeIndicator";

/** Per-creep seed data collected from the map (guard post + drop table). */
interface CreepSeed {
  x: number;
  y: number;
  aggro: number;
  drops: Array<{ items: Array<{ id: string; chance: number }> }>;
}
import { RACE_INDEX, STARTING_UNITS, WORKERS, MELEE_UNIT_SPACING, MELEE_WORKER_CLUSTERS, isHarvestCode, resolveRace, type PlayableRace, type WorkerCluster } from "../data/races";
import { ModelViewerScene } from "./modelViewer";
import type { Controller, MeleeConfig, SlotConfig } from "../ui/lobby";
import { MetricsOverlay } from "../ui/metrics";
import { wc3ToPlain } from "../ui/wc3Text";
import { GameHud, isTyping, upkeepBand, PLAYER_COLORS, type HudDriver, type CommandButton } from "../ui/hud";
import { GAME_WIDTH, GAME_HEIGHT, disposeWorldLayer, worldLayer } from "../ui/stage";
import { MatchOverDialog } from "../ui/gameMenu";
import { EscMenu } from "../ui/escMenu";
import { AllianceDialogOverlay } from "../ui/allianceDialog";
import { ChatDialogOverlay } from "../ui/chatDialog";
import { QuestDialogOverlay, primeQuestStrings } from "../ui/questDialog";
import { ConsoleUi, type ConsolePanel } from "../ui/consoleUi";
import { parseMapInfo } from "../world/mapInfo";
import {
  chatPrompt, chatRecipients, formatChatLine,
  type ChatLine, type ChatTarget, type ChatWorld,
} from "../game/chat";
import { teamColorHex, teamColorRgb } from "./teamColor";
import { GameDialogOverlay } from "../ui/gameDialog";
import { LeaderboardOverlay } from "../ui/leaderboard";
import { MultiboardOverlay } from "../ui/multiboard";
import { TimerDialogOverlay } from "../ui/timerDialog";
import { CinematicPanelOverlay } from "../ui/cinematicPanel";
import { ScriptCamera, type CameraState } from "./scriptCamera";
import { BOUNTY_TEXT_STYLE, CombatTextTags, GOLD_TEXT_STYLE, LUMBER_TEXT_STYLE, TextTagOverlay, XP_TEXT_STYLE, type CombatTextStyle, type TextTagContext } from "./textTags";
import { FdfLibrary } from "../ui/fdf/library";
import { blpToCanvas, blpToDataUrl } from "./blputil";
import { loadTechRegistry, type TechRegistry } from "../data/techtree";
import { loadUpgradeRegistry, type UpgradeRegistry } from "../data/upgrades";
import { parseWar3Skins, skinValue, WAR3SKINS } from "../data/war3skins";

// Our race ids → the section names in the game's own skin table (UI\war3skins.txt), which
// is what decorates a `DecorateFileNames` frame's textures. WC3 skins the in-game panels
// (leaderboard, dialogs, quest log) with the LOCAL player's race, so an Orc player's
// victory dialog wears the orc border. See src/ui/fdf/library.ts `decorate`.
const SKIN_SECTION: Record<PlayableRace, string> = {
  human: "Human",
  orc: "Orc",
  undead: "Undead",
  nightelf: "NightElf",
};

/** Gap (FDF 0.8×0.6 units) between the leaderboard and the countdown-window stack below it. */
const TIMER_STACK_GAP = 0.006;

// War3MapViewer.update() hardcodes super.update() to 1000/60 ms per frame, so
// animations run at 2x on a 120Hz display, 2.4x at 144Hz, etc. We bypass it and
// drive the base scene update with REAL elapsed time (see start()).
const baseUpdate = (ModelViewer as unknown as { prototype: { update(dt: number): void } })
  .prototype.update;

// Authentic full-map rendering via mdx-m3-viewer's War3MapViewer (plan §1.1, §2):
// real terrain textures, cliffs, ramps, water, and doodads/units as MDX models.
// Used when an install is mounted; the Phase 2 placeholder terrain stays the
// zero-asset fallback.
//
// Critical: War3MapViewer's solver has TWO contracts. The base SLK tables below
// are passed straight to fetch(), so the solver must return a STRING url for them
// (we preload blob URLs); everything else takes Promise<Uint8Array>. Returning a
// Promise for a base file silently aborts the whole map (blank screen).
const BASE_FILES = [
  "TerrainArt\\Terrain.slk",
  "TerrainArt\\CliffTypes.slk",
  "TerrainArt\\Water.slk",
  "Doodads\\Doodads.slk",
  "Doodads\\DoodadMetaData.slk",
  "Units\\DestructableData.slk",
  "Units\\DestructableMetaData.slk",
  "Units\\UnitData.slk",
  "Units\\unitUI.slk",
  "Units\\ItemData.slk",
  "Units\\UnitMetaData.slk",
];

/**
 * The simulation's fixed rate.
 *
 * 60 Hz, not a lower rate, because the visual sync loop (game/rts.ts `tick`) pushes sim
 * positions straight onto the model instances — there is no render interpolation between
 * sim steps, so the sim rate IS the animation rate, and anything below display refresh
 * shows as judder. Decoupling those (interpolate the sync loop, then drop to 20–30 Hz as
 * the original's net rate did) is a worthwhile follow-up and would cut sim CPU per match,
 * which matters once one machine hosts several.
 *
 * 16.7 ms also sits well inside the ≤50 ms window the movement/collision code is tuned for.
 */
const SIM_HZ = 60;
const SIM_DT = 1 / SIM_HZ;
/** Catch-up steps allowed in one frame before the remainder is dropped. Without a cap, a
 *  long stall (tab-switch, GC) queues more work than the next frame can retire, which
 *  queues still more — the classic spiral of death. */
const MAX_STEPS_PER_FRAME = 5;

/** Time constant of the hold-to-follow camera's spring (issue #114) — see `followHeld`.
 *  Critically damped, so the lag it costs a group moving at speed `v` is `2·τ·v`: 45 ms
 *  trails a running hero by ~27 units, a fifth of a terrain tile. */
const FOLLOW_TAU_MS = 45;

/** A match seed for a game nobody specified one for (single player). Math.random is fine
 *  HERE and nowhere near the sim: this picks the seed, it doesn't roll off it. The Park-
 *  Miller LCG the sim uses wants a positive int below 2^31-1. */
function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 2147483645);
}

const UP = new Float32Array([0, 0, 1]); // WC3 world space is Z-up
const LEVEL_UP_FX = "Abilities\\Spells\\Other\\Levelup\\Levelupcaster.mdx"; // hero level-up nova
// Floating combat text (see CombatTextTags). A crit's number is red for EVERYONE — it is not a
// player colour and must not be read as one, even though it happens to be the same red the
// palette gives slot 0. `Z` lifts the text off the victim's feet to roughly over its head; the
// overlay adds the terrain and, for a flier, its altitude, so one offset serves ground and air.
const CRIT_TEXT_COLOR = 0xffff0303;
// A gold credit's colour is the game's own, and it is not the `|cffffcc00` a tooltip gilds a
// price with: `UI\MiscData.txt` keeps a `GoldTextColor` for exactly this tag, ARGB, and it is
// a paler, warmer gold (255,220,0). Not a player colour either — the number is the money,
// not whose money it is.
const GOLD_TEXT_COLOR = argbOfParts(TEXT_TAG.GoldTextColor);
const COMBAT_TEXT_Z = 100;
// A gold credit starts HIGHER, above the floating status bar rather than behind it. The bar
// is drawn at the unit's overhead (`WorldOverlays.syncBars`: the projected selection radius
// plus a fixed 24px), and a tag spawned at chest height rises THROUGH it — so the first
// third of a two-second "+400", the part the eye actually catches, was reading out from
// behind a health bar. A crit is left where it is: it belongs ON the unit it struck, and it
// is the blow that is being reported, not a number you are meant to sit and read.
const GOLD_TEXT_Z = 220;
// The rest of the credit family (issue #116), same idea: the file's own ARGB, no eyeballing.
// Lumber is GREEN (0,200,80) and a bounty is the identical gold to a credit's — the money does
// not change colour depending on where it came from; only how long the number hangs around does
// (see BOUNTY_TEXT_STYLE).
const LUMBER_TEXT_COLOR = argbOfParts(TEXT_TAG.LumberTextColor);
const BOUNTY_TEXT_COLOR = argbOfParts(TEXT_TAG.BountyTextColor);
// ...and the one exception, the XP number, which 1.30.4 does not raise at all and therefore
// keeps no colour for — see XP_TEXT_STYLE. A violet matched to the Reforged client that does.
const XP_TEXT_COLOR = 0xffb478ff;
// A bounty sits where a credit does; the XP goes a hair above it. The two are raised by the
// SAME event a step apart, and a hero that killed the creep in melee is standing on top of it,
// so at one identical height they would print over each other.
//
// A HAIR, though, and not a clear line: the floor here is the status bar (the credit height is
// what it is because issue #120 tuned it to clear the bar rather than rise through it), and the
// ceiling is that this is a number over a hero's HEAD — lifted much further it stops reading as
// his and starts floating in the trees behind him. 300 was over that ceiling.
const XP_TEXT_Z = 240;

/** Colour, spec and height for one CREDIT kind — the four tags the engine raises to tell you
 *  what you were just paid (see CombatText). A crit and a deny are not in here: they report a
 *  blow, not a payment, and wear the victim's colour rather than the resource's. */
const CREDIT_TEXT: Record<"gold" | "lumber" | "bounty" | "xp", { color: number; style: CombatTextStyle; z: number }> = {
  gold: { color: GOLD_TEXT_COLOR, style: GOLD_TEXT_STYLE, z: GOLD_TEXT_Z },
  lumber: { color: LUMBER_TEXT_COLOR, style: LUMBER_TEXT_STYLE, z: GOLD_TEXT_Z },
  bounty: { color: BOUNTY_TEXT_COLOR, style: BOUNTY_TEXT_STYLE, z: GOLD_TEXT_Z },
  xp: { color: XP_TEXT_COLOR, style: XP_TEXT_STYLE, z: XP_TEXT_Z },
};

/** An `A,R,G,B` quadruple from the Misc files → the 0xAARRGGBB a text tag carries. */
function argbOfParts([a, r, g, b]: readonly number[]): number {
  return (((a & 255) << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;
}

/** "#rrggbb" → the 0xAARRGGBB a text tag carries, opaque. */
function argbOf(css: string): number {
  return (0xff000000 | parseInt(css.slice(1), 16)) >>> 0;
}
/** The shop indicator: the team-coloured arrow over whoever will receive the next purchase.
 *  `Targetattach=overhead` in the ability data, hence the attach token. See collectShopArrows
 *  for why this is AneuTarget and not the AneuCaster the data names first. */
const SHOP_ARROW_FX: BuffFx = { path: "Abilities\\Spells\\Other\\Aneu\\AneuTarget.mdx", attach: ["overhead"] };
/** The mark a Haunted Gold Mine paints for each Acolyte of its crew — the rune circle the
 *  five of them kneel on (`Abgm` DataC1 = 5 stations at DataD1 = 200; docs/undead.md §4).
 *  Its own file is where the whole lifecycle is written: `UndeadMineCircle.mdx` authors
 *  exactly Birth · Stand · Death, which is the three-act shape the persistent-FX pool already
 *  plays — so the marks bloom when the mine finishes being haunted, sit while it is worked,
 *  and die with it, whether it runs dry or is knocked down (see collectMineCircles). Placed by
 *  hand rather than attached: they belong on the GROUND at the stations, not on the building's
 *  origin bone. */
const MINE_CIRCLE_FX: BuffFx = { path: "Abilities\\Spells\\Undead\\UndeadMine\\UndeadMineCircle.mdx", attach: [] };
// Cast sounds for spells whose effect model doesn't sit next to a folder WAV
// (e.g. Divine Shield has no target/caster art), by base ability code.
const SPELL_SOUND_FALLBACK: Record<string, string> = {
  AHds: "Abilities\\Spells\\Human\\DivineShield\\DivineShield.wav",
};
// Which of an ability's art fields carries its CAST sound, for the few whose data lists an
// art the ability never actually shows. The default order (target → caster → special) reads
// the first art that carries an SND event, which is normally the effect the player sees —
// but Mirror Image's `TargetArt` is `LevelupCaster.mdl`, a model AOmi never plays, and it
// carries SND…AHER → Levelupcaster.wav. So every Mirror Image announced itself with the
// hero LEVEL-UP chime. What it plays is Specialart (MirrorImageCaster → SND…AOMC →
// MirrorImage.wav), so name that here and let the sound follow the model on screen.
// The other case this table answers: an ability whose art plays at the WIND-UP (world.ts
// CAST_START_ART) took its own sound with it, so the default order would sound the same WAV
// a second time at the cast point. Name the art that belongs to THIS instant instead —
// which for Blink is the far end of the hop, the pair the folder ships:
//   BlinkCaster.mdx  → BlinkBirth1.wav    (departure, at the wind-up)
//   BlinkTarget.mdx  → BlinkArrival1.wav  (arrival, here)
const SPELL_SOUND_ART: Record<string, (d: AbilityDef) => string[]> = {
  AOmi: (d) => [d.specialArt],
  AEbl: (d) => [d.areaArt],
};
// The looping bed a channelled area field lays down for as long as it runs. This is DATA,
// not a hardcode: the label rides on the field (SpellFieldInit.loopSound), taken from the
// ability's `Effectsoundlooped` or — for the six fields that carry their art on an effect
// object rather than on themselves — from that object's (see AbilityDef.fxLoopSound).
//   [XHbz] Effectsoundlooped = BlizzardLoop      [XUdd] → DeathAndDecayLoop
//   [XErf] → RainOfFireLoop                      [XOeq] → EarthquakeLoop
//   [XEtq] → TranquilityLoop                     [ANst] → StampedeLoop (on the ability)
// Each label is an AbilitySounds.slk row naming the WAV; Sounds.abilityLoopPath resolves it.
// The item icon carried on the cursor while moving it, as a fraction of an inventory
// slot: just under it, so the hand looks like it's holding that same icon.
const CARRIED_ITEM_SCALE = 0.85;
const BUILD_CLEAR_TIMEOUT = 2; // seconds a builder waits for units to vacate before giving up
// Command-card icons that aren't tied to a specific unit/ability: the order row
// (Move/Stop/Hold/Attack/Patrol), a worker's Build/Repair, Cancel, and the four
// race rally-point flags. Warmed up-front with the data-driven icons so the very
// first selection of any unit doesn't decode its whole order row in one frame.
const FIXED_CARD_ICONS = [
  "BTNMove", "BTNStop", "BTNHoldPosition", "BTNAttack", "BTNPatrol",
  "BTNHumanBuild", "BTNRepair", "BTNCancel",
  "BTNRallyPoint", "BTNOrcRallyPoint", "BTNRallyPointUndead", "BTNRallyPointNightElf",
];
// Blizzard.j's InitDNCSounds(): a rooster crows the moment the clock reaches Dawn, a
// wolf howls at Dusk. Both are rows of UI\SoundInfo\AmbienceSounds.slk, playing
// Sound\Time\DaybreakRooster.wav and Sound\Time\DuskWolf.wav.
/** How close the camera has to be looking to feel an Earthquake, and how hard it bucks.
 *  In no data file — `CameraSetEQNoiseForPlayer(p, richter)` is a Blizzard.j helper that
 *  takes its magnitude from the caller, and the ability row carries no camera field at all.
 *  Read as `velocity / magnitude` Hz (see ScriptCamera's NOISE_* note): 240/30 = 8 Hz. */
const EQ_FEEL_RANGE = 2200;
const EQ_MAGNITUDE = 30;
const EQ_VELOCITY = 240;
const DAWN_SOUND = "RoosterSound";
const DUSK_SOUND = "WolfSound";
const MAX_HEROES = MELEE.MELEE_HERO_LIMIT; // altars + tavern combined
/** A unit walks out of its factory facing south, like a placed building (spawnUnit's own
 *  default). Named here because the sim unit and its model are now made in two steps and
 *  both have to be told the same thing. */
const TRAINED_FACING = (3 * Math.PI) / 2;

/** A lobby `Controller` as common.j's `mapcontrol` — what `applyLobby` hands the script for
 *  each slot. An empty seat ("open"/"closed") never reaches that handoff, and a slot the MAP
 *  owns as neutral or rescuable keeps exactly what the map made it (see MapInfo.neutralPlayers). */
const MAP_CONTROL_FOR: Record<Controller, number> = {
  user: MAP_CONTROL.USER,
  computer: MAP_CONTROL.COMPUTER,
  open: MAP_CONTROL.USER,
  closed: MAP_CONTROL.USER,
  neutral: MAP_CONTROL.NEUTRAL,
  rescuable: MAP_CONTROL.RESCUABLE,
};

/** Fill a commandstrings row's printf slots left to right ("%s the %s (level %d) has
 *  fallen."). The engine's own strings are C format strings; a missing argument leaves the
 *  slot empty rather than printing "%s" at the player. */
function fillSlots(text: string, args: Array<string | number>): string {
  let i = 0;
  return text.replace(/%[sd]/g, () => String(args[i++] ?? ""));
}

// Our race ids → the suffix WC3's UISounds.slk uses on its per-race cues
// (ResearchCompleteHuman, UpgradeCompleteNightElf, …).
const UI_SOUND_RACE: Record<PlayableRace, string> = {
  human: "Human",
  orc: "Orc",
  undead: "Undead",
  nightelf: "NightElf",
};

// Why a shop refused a purchase → the [Errors] key that says so. "A valid patron must be
// nearby." is the one players know, and it is why a hero has to walk up to the Arcane
// Vault before you can buy anything.
const SHOP_ERROR: Record<ShopResult, string> = {
  ok: "",
  no: "",
  nostock: "Outofstock",
  nopatron: "Neednearbypatron",
  full: "Inventoryfull",
  cost: "Nogold",
  req: "", // the red "Requires:" line on the button already says which building is missing
};

// The [Errors] keys that aren't spoken by any one subsystem — the resource refusals the
// command card hands out. The strings themselves come out of the archive (data/commandStrings.ts).
// Nofood is race-indexed: each race names its own supply building.
const ERR_NOGOLD = "Nogold";
const ERR_NOLUMBER = "Nolumber";
const ERR_NOFOOD = "Nofood";

// The [Errors] keys that get a spoken warning rather than the generic error beep, and the
// UISounds.slk cue prefix each maps to (NoGold + Orc → NoGoldOrc).
const ERROR_VOICE: Record<string, string> = {
  Nogold: "NoGold",
  Nolumber: "NoLumber",
  Nofood: "NoFood",
  Cantplace: "CantPlace",
  // The Undead's own refusal, and the one race that has a SECOND one: UISounds.slk gives
  // "Must summon structures upon Blight." its own row, `OffBlightUndead` →
  // AcolytePlacedOffBlight1.wav, distinct from the CantPlace* the four races share. No
  // other race has an OffBlight row, and none needs one.
  Offblight: "OffBlight",
};

// Building-cancel explosion effect per race (verified in the MPQs). Orc ships no
// dedicated cancel model, so it reuses the Human one.
const CANCEL_FX: Record<PlayableRace, string> = {
  human: "Objects\\Spawnmodels\\Human\\HCancelDeath\\HCancelDeath.mdx",
  orc: "Objects\\Spawnmodels\\Human\\HCancelDeath\\HCancelDeath.mdx",
  undead: "Objects\\Spawnmodels\\Undead\\UCancelDeath\\UCancelDeath.mdx",
  nightelf: "Objects\\Spawnmodels\\NightElf\\NECancelDeath\\NECancelDeath.mdx",
};

// WC3's real ground indicator for a point-target area spell (Blizzard, Flame Strike,
// …), painted under the cursor while the ability is armed (issue #20). One texture per
// caster race — the game colour-codes the ring by race (all four verified in War3.mpq).
const AOE_SPLAT_TEXTURE: Record<PlayableRace, string> = {
  human: "ReplaceableTextures\\Selection\\SpellAreaOfEffect.blp",
  nightelf: "ReplaceableTextures\\Selection\\SpellAreaOfEffect_NE.blp",
  orc: "ReplaceableTextures\\Selection\\SpellAreaOfEffect_Orc.blp",
  undead: "ReplaceableTextures\\Selection\\SpellAreaOfEffect_Undead.blp",
};

/**
 * Abilities an Ancient may only use once it has pulled itself up.
 *
 * The rest of the root/unroot split is structural — an uprooted Ancient is handed the mobile
 * order card instead of the building one, which takes its training, research, rally point and
 * cargo buttons away in one move — so this is only for rows that sit in a unit's ABILITY list
 * and would otherwise show in both stances.
 *
 * **Eat Tree** (`Aeat`) is the one, and the DATA settles it rather than intuition. `[Aeat]
 * Buttonpos=0,2` — and the Ancient of War's own research row wants that exact cell:
 * `[Reib] Buttonpos=0,2` (Improved Bows), with Sentinel at 1,2 and Vorpal Blades at 2,2
 * filling the rest of that line. Two buttons cannot share a cell in the real client, so the
 * bottom row of the PLANTED card belongs to the upgrades and Eat Tree cannot be on it. That
 * also matches how it is used: an Ancient eats a tree by walking to one.
 *
 * **Entangle Gold Mine** (`Aent`) is the other, and it is the one that reads backwards. It
 * looks like a rooted ability and the game even has a refusal line for it — commandstrings.txt
 * [Errors] `Mustroottoentangle` = "Must root adjacent to a gold mine to entangle it." — but
 * that error is the proof rather than the counter-argument: an ability the walking card never
 * offered could never raise it. It is a WALKING tree's button, and it is the card you take an
 * expansion from, since a Tree of Life is uprooted for precisely as long as it takes to reach
 * one. Pressing it is an ERRAND rather than a cast (SimWorld.issueEntangleAt): the tree walks
 * to a spot from which Entangle reaches the mine, and the roots go out as it plants.
 *
 * `Aroo` is on NEITHER list, and must not be: it is the one button that has to show in both
 * stances or a state becomes unreachable. It shows opposite FACES instead — `Art`/"Root" while
 * walking, `Unart`/"Uproot" while planted (see `reversed` in pushAbilityButtons).
 */
const UPROOTED_ONLY = new Set(["Aeat", "Aent"]);

/**
 * How far above a Moon Well's own origin its water model is placed, in world units.
 *
 * MEASURED, because nothing in the data states it: `[Ambt] Effectart` names the model and
 * nothing names where to put it, and the model is authored to be dropped INTO the basin rather
 * than at the building's feet. Read off a ladder of copies planted at rising offsets beside
 * real wells — at 0 and 20 the pool is inside the stone (a sliver shows at the rim at 20), at
 * 40 it fills the basin, and by 80 it has floated clear of the rock. The artist's own answer is
 * the well's `Sprite First Ref` bone, which lands at this height — but that bone sits on the
 * RIM, so riding it puts the pool half off the well; this is its height without its offset.
 */
const MOON_WELL_WATER_LIFT = 32;

/**
 * The half-extents a building's SEAT HEIGHT is sampled over — its BODY, not its whole
 * stamped pathing footprint.
 *
 * A structure is seated on the tallest terrain across a rectangle so it does not sink into a
 * slope (issue #15, and `FOOTPRINT_LIFT` in src/game/heightmap.ts halves the resulting perch).
 * Handing that sampler the pathing stamp asks the wrong question: `12x12Simple.tga` is 384
 * units across and includes the walkable margin that keeps the next building from crowding in —
 * ground the model never stands on. On a slope the max is reached at the far up-slope corner of
 * that rectangle, so the bigger the stamp the higher the building perches, and it floats off
 * the ubersplat, which hugs the real terrain. The night elf ANCIENTS are where it shows worst:
 * they carry the race's largest stamps AND they are tall, so off the camera's axis the lift
 * spreads sideways too and the tree reads as standing beside its own root patch.
 *
 * `collision` (UnitBalance) is the disc the unit actually occupies — 96 for an Ancient of War
 * against its 192 stamp half — so it is the closest thing the data has to "where the model
 * touches the ground". Clamped by the stamp so a unit with an outsized collision can never
 * sample MORE ground than it blocks.
 */
function seatHalfExtents(def: { collision: number }, fp: { w: number; h: number } | null): [number, number] {
  if (!fp) return [0, 0];
  const stampW = (fp.w * PATHING_CELL) / 2;
  const stampH = (fp.h * PATHING_CELL) / 2;
  const body = def.collision > 0 ? def.collision : Math.min(stampW, stampH);
  return [Math.min(stampW, body), Math.min(stampH, body)];
}

// Over-bright green a tree flashes while it sits under an armed tree-destroying AoE
// (Flame Strike) — the doodad counterpart of the green unit-target tint, so the player
// sees the forest the cast would fell. setVertexColor multiplies the model, so heavy
// green + suppressed red/blue and RGB >1 makes any canopy or trunk glow valid-target green.
const AOE_TREE_TINT = [0.2, 2.6, 0.2, 1];

// Selection/hover rings are painted through the ubersplat overlay (tessellated over the
// terrain corner grid) so a ring conforms to the terrain — warps over slopes/ramps with
// its whole body visible, like the AoE indicator (issue #34). The overlay draws the ring
// PROCEDURALLY in the alliance colour (green/red/yellow); it just needs a real, loadable
// BLP named per entry so the entry draws (the pixels are ignored — see uberSplatOverlay).
const RING_TEX_UNIT = "ui\\Feedback\\selectioncircle\\SelectionCircleUnit.blp";
const RING_TEX_BUILDING = "ui\\Feedback\\selectioncircle\\SelectionCircleBuilding.blp";
// selectioncircle.mdx's native half-width in world units — the ring's outer edge sat at
// scale·38, so half-width = scale·38 keeps a ring the same size it used to draw.
const RING_NATIVE = 38;

// Minimal local typings (mdx-m3-viewer's exports drag in their own gl-matrix).
// The viewer calls the solver as (src, solverParams) — params carry the map's
// tileset letter once war3map.w3i is parsed.
type Solver = (src: unknown, params?: { tileset?: string }) => unknown;
interface Camera {
  perspective(fov: number, aspect: number, near: number, far: number): void;
  moveToAndFace(from: Float32Array, to: Float32Array, up: Float32Array): void;
  viewProjectionMatrix: Float32Array; // World → Clip; drives the fog-overlay pass
  // The eye and its two screen axes (mdx-m3-viewer Camera: location + the X/Y axes in
  // camera space). The weather pass needs all three to billboard a snowflake at the camera
  // and to turn a rain streak's flat quad toward it (src/render/weather.ts).
  location: Float32Array;
  directionX: Float32Array;
  directionY: Float32Array;
}
interface Scene {
  camera: Camera;
  viewport: Float32Array;
  // Split render hooks (mdx-m3-viewer Scene) — let us slot the ubersplat pass BETWEEN
  // the opaque world and the translucent ground rings so the rings draw on top (issue #16).
  startFrame(): void;
  renderOpaque(): void;
  renderTranslucent(): void;
  // OpenWar3 patch hook: the day/night light the ground/cliff and model shaders read
  // (see src/render/dayNight.ts). Left at 0/null on scenes with no cycle.
  dncEnabled: number;
  dncTerrain: DayNightLight | null;
  dncUnit: DayNightLight | null;
  // OpenWar3 patch hook: linear distance fog (the map's w3i environment haze) that the
  // ground/cliff/water and model shaders read (src/render/fog.ts). Undefined = no fog.
  distFog?: DistFog;
}
interface HideableWidget {
  instance: {
    localLocation: Float32Array;
    hide(): void;
    show(): void;
    vertexColor?: Float32Array; // MDX instance tint (base colour before fog dimming)
    setVertexColor?(c: ArrayLike<number>): void;
    /** The viewer's own "is this being drawn" flag — `hide()` clears it, `show()` sets it.
     *  Read by the fog sweep so it only ever re-shows what IT hid (fogSpawnedInstances). */
    rendered?: boolean;
    // A placed doodad is a full MDX instance/model, but War3MapViewer renders it through a
    // STATIC batched path: its animation never advances and Widget.update resets any sequence
    // we set, so we can't play the tree's clips on it directly (see treeActor). We only read
    // its transform/model to spawn a scene-animated stand-in.
    localRotation?: Float32Array;
    localScale?: Float32Array;
    model?: { sequences: Array<{ name: string; interval?: ArrayLike<number> }>; addInstance?(): SpawnInstance };
  };
}
interface W3xMap {
  worldScene: Scene;
  centerOffset: Float32Array;
  mapSize: Int32Array;
  update(): void;
  render(): void;
  // Terrain sub-passes (mdx-m3-viewer w3x map). `render()` runs them as
  // ground → cliffs → opaque instances → water → translucent instances; we replay that
  // sequence ourselves to insert the ubersplat pass before the translucent one (issue #16).
  anyReady: boolean;
  /** OpenWar3 patch hook: mark one terrain CORNER blighted / clean, and push every tile
   *  changed since the last push. See src/sim/blight.ts for what drives it. */
  setBlight(column: number, row: number, on: boolean): boolean;
  flushBlight(): void;
  renderGround(): void;
  renderCliffs(): void;
  renderWater(): void;
  units: unknown[];
  doodads: HideableWidget[];
  doodadsReady: boolean;
  unitsReady: boolean;
}
interface W3xViewer {
  loadedBaseFiles: boolean;
  gl: WebGLRenderingContext; // the viewer's GL context, shared by the fog overlay pass
  map: W3xMap | null;
  /** UnitData + UnitUI + ItemData, merged — and the map's war3map.w3u/.w3t declarations
   *  folded in on top of it by the map handler. See repairCustomRowIds. */
  unitsData: MappedData;
  /** Doodad + destructable data, merged — and, like `unitsData`, GLOBAL across maps. */
  doodadsData: MappedData;
  /** OpenWar3 patch hook: lets the map handler check which cliff-ramp
   *  (CliffTrans) models exist in the VFS before placing them. */
  terrainModelExists?: (path: string) => boolean;
  on(event: string, cb: (e: unknown) => void): void;
  once(event: string, cb: () => void): void;
  loadMap(buffer: ArrayBuffer | Uint8Array): void;
  load(src: unknown, solver: Solver): Promise<SpawnModel | undefined>;
  /** Everything the viewer is still fetching. It pushes each pre-placed unit into
   *  `map.units` only when that unit's MODEL resolves, so "promiseMap is empty" is the
   *  only sound "the map's units are all here" signal (see waitForMapUnits). */
  promiseMap: Map<string, Promise<unknown>>;
  removeScene(scene: Scene): boolean;
  startFrame(): void;
  render(): void;
}

// The bits of an mdx model/instance the melee spawner drives. A superset of the
// RtsController's Instance, so a spawned instance is accepted by addUnit().
interface SpawnInstance {
  setScene(scene: unknown): void;
  setTeamColor(id: number): void;
  setUniformScale(s: number): void;
  setVertexColor(c: ArrayLike<number>): void;
  frame: number;
  timeScale: number; // animation playback rate (attack/walk clips are re-rated — see rts.ts animRate)
  sequenceEnded: boolean; // mdx-m3-viewer: true once a non-looping clip finishes
  hide(): void;
  show(): void;
  setSequence(i: number): void;
  setSequenceLoopMode(m: number): void;
  // mdx re-samples an instance's bones only when its animation advanced this frame; a
  // caller that writes `frame` itself sets `forced` so the pose follows (the viewer's own
  // rule — "if an instance is transformed, always do a forced update"). Self-clearing.
  forced?: boolean;
  setLocation(v: ArrayLike<number>): unknown;
  setRotation(q: ArrayLike<number>): unknown;
  detach(): boolean; // remove from the scene (projectiles on impact)
  localLocation: Float32Array;
  localRotation: Float32Array;
  worldLocation?: Float32Array; // node's world-space position (valid after a scene update)
  // Parent this instance to another instance's attachment node (mdx setParent), so
  // it rides that node's animated transform — how the Blood Mage's spheres orbit.
  setParent?(node: unknown): unknown;
  getAttachment?(id: number): unknown; // an attachment node by its model.attachments index
  sequence: number; // index of the clip currently playing
  model: {
    sequences: Array<{ name: string; interval?: ArrayLike<number> }>;
    attachments?: Array<{ name: string }>; // "Sprite First Ref", "Hand Right Ref", …
  };
}
interface SpawnModel {
  addInstance(): SpawnInstance;
}

/** A placed doodad's scene-animated stand-in — the only way a map doodad can move
 *  (see doodadActors). `clipT` is seconds into the one-shot clip it is playing, or -1
 *  when it is just idling and has nothing to finish. */
interface DoodadActor {
  inst: SpawnInstance;
  dead: boolean;
  revertEnd: number;
  clipT: number;
}

/** One live script `effect` (7.26 — issue #68): the model AddSpecialEffect* put in the
 *  world, held until the script's DestroyEffect. See MapViewerScene.specialFx. */
interface SpecialFx {
  /** null while the model is still loading — the handle exists before the art does. */
  inst: SpawnInstance | null;
  /** Seconds since the script created it. THE effect's clock: an mdx instance only
   *  advances its own `frame` on the frames the scene actually draws it, so anything the
   *  player isn't looking at freezes. Age is what makes the effect's life independent of
   *  that (issue #68 follow-up) — see updateSpecialFx. */
  age: number;
  /** Which clips the model has — the input to specialFxPhaseAt. Read once, on load. */
  clips: SpecialFxClips;
  /** The model's Stand clip, or -1. */
  standIdx: number;
  /** Already handed over to its looping Stand (so we only setSequence once). */
  standing: boolean;
  /** Its whole life has run out: a Birth-only model that has played its last frame. It is
   *  over, and is never drawn again — however long it took the player to look. */
  spent: boolean;
  /** Currently taken off the screen (fogged, or spent). */
  hidden: boolean;
  /** The unit it rides, or -1 for one standing on the ground. */
  hostId: number;
  /** The attachment point's tokens ("origin", ["hand","left"]) — see attachmentNode. */
  attach: string[];
  /** True once parented to the host's attachment node: it moves and animates on its own. */
  parented: boolean;
  /** Where a ground effect stands (a host's live position wins while unparented). */
  x: number;
  y: number;
  /** DestroyEffect landed before the model did — drop it the moment it loads. */
  doomed: boolean;
}

// A Blood Mage's orbiting spheres (issue #37). The Sphere ability (Asph) attaches
// BloodElfBall.mdx to the hero model's three "Sprite N Ref" attachment points; the
// orbit is baked into the model's animation of those nodes, so parenting one ball to
// each node gives the circling for free. A spell cast hurls one ball at the target
// as a missile, and it regrows after a moment.
interface SphereRig {
  balls: (SpawnInstance | null)[]; // one per sprite attachment point (orbit instances)
  attachIdx: number[]; // the model.attachments index each ball rides
  thrown: SphereThrow[]; // balls currently in flight / regrowing (not orbiting)
  visible: boolean; // last show/hide state applied (kept in sync with the hero)
}
interface SphereThrow {
  ballIdx: number;
  phase: "fly" | "regrow";
  t: number; // seconds elapsed in the current phase
  flyDur: number; // total flight time (distance / missile speed)
  regrowLeft: number; // seconds until the ball returns to orbit
  sx: number; sy: number; sz: number; // launch point (the ball's orbit position)
  tx: number; ty: number; tz: number; // impact point
  peak: number; // parabolic arc apex height
}

const ViewerClass = War3MapViewer as unknown as {
  new (canvas: HTMLCanvasElement, solver: Solver, isReforged: boolean): W3xViewer;
};

/**
 * How far along a streaming load is, when nothing knows how much there is to load.
 *
 * The loader discovers its own work as it goes — a model's fetch dispatches its textures',
 * and each of those may dispatch more — so there is no total to divide by until it is over.
 * What there IS at any moment is the work DISCOVERED so far and how much of it has landed:
 * `done / (done + pending)`, counted off the viewer's own in-flight map by watching which
 * keys disappear.
 *
 * That ratio climbs as the queue drains and DIPS when a fresh burst is discovered, so it is
 * reported through a high-water mark: a load bar may only ever go forwards, and one that
 * stepped back would look exactly like the frame-time wobble we just took out of it
 * (render/loadingScene.ts).
 *
 * Measured on `(2)EchoIsles.w3x`: the map's own art is 279 fetches over ~1.0 s, which the
 * ratio walks in ~17 steps at 0.00 → 0.36 → 0.51 → 0.64 → 0.85 → 0.99 → 1.
 */
class LoaderProgress {
  /** The keys that were in flight at the previous sample — a key that is gone by the next
   *  one has landed. (The loader hands out no completion count of its own.) */
  private inFlight = new Set<string>();
  private done = 0;
  private high = 0;

  /** Sample the loader's in-flight set and answer the fraction to report, 0…1. */
  sample(promiseMap: Map<string, unknown>): number {
    for (const key of this.inFlight) if (!promiseMap.has(key)) this.done++;
    this.inFlight = new Set(promiseMap.keys());
    const total = this.done + this.inFlight.size;
    this.high = Math.max(this.high, total > 0 ? this.done / total : 0);
    return this.high;
  }
}

export class MapViewerScene {
  // The game camera's shape — what the view opens at and what ResetToGameCamera returns to
  // (7.24).
  //
  // The FOV *field* (Blizzard.j bj_CAMERA_DEFAULT_FOV = 70) is NOT the angle the client renders
  // with. The rendered lens is **32° vertical**, measured off the real 1.27a client (issue #73):
  //
  //   Blizzard.j's MeleeStartingUnits places the five starting workers at EXACT offsets around
  //   the point it then centres the camera on (`unitSpacing = 64`, so the two side workers sit
  //   ±64 in world X — 128 apart, at the focus). That is a ruler no model size or asset scale
  //   can corrupt. In a 1424x720 melee opening frame (camera untouched, so distance is
  //   bj_CAMERA_DEFAULT_DISTANCE = 1650) their selection circles measure 128 world units across
  //   as ~102 px, i.e. k = (H/2)/tan(fov/2) ≈ 1269 ⇒ fov ≈ 31.7°.
  //
  // Two earlier passes got this wrong in both directions. The 45° pass fitted two landmarks but
  // had to guess the camera's focus; the 70° pass measured a town hall's wall ring at 320 px in
  // a frame it believed was 1080 tall — it was 720, and the same numbers on the true height say
  // 45°, not 70°. Both calibrated against a MODEL, so both inherited whatever our own render got
  // wrong about its size. (Sanity check on 70°: it would make the hall's wall ring ~690 units
  // wide while its own ubersplat — Splats\UberSplatData.slk HTOW, scale 230 = half-width — is
  // only 460 across. The walls cannot spill that far outside their own dirt patch.)
  //
  // A wrong lens does not announce itself as a wrong lens. Framing is distance × tan(fov/2), so
  // it announces itself as every distance in the game meaning the wrong thing — and as an urge
  // to keep "fixing" the zoom constants to compensate. Don't; fix the lens. See docs/camera.md.
  private static readonly WC3_FOV_DEG = CAMERA.DEFAULT_FOV; // the FIELD a script speaks (70)
  private static readonly LENS_FOV_DEG = 32; // …and the lens we render it with, measured above
  private static readonly GAME_FOV = (MapViewerScene.LENS_FOV_DEG * Math.PI) / 180;
  // WC3's AOA 304 is -56°: the view tilts 56° down, so the eye sits 56° above the focus.
  private static readonly GAME_PITCH = ((360 - CAMERA.DEFAULT_AOA) * Math.PI) / 180;

  // Orbit camera state. target[2] is NOT free state: it is the GROUND under the focus plus
  // `zOffset`, recomputed every frame by followGround (issue #73) — write the offset, not it.
  private target = new Float32Array([0, 0, 0]);
  // CAMERA_FIELD_ZOFFSET: how far the focus floats ABOVE the terrain. 0 unless a script says
  // otherwise, which is what makes the camera ride the ground rather than the z = 0 plane.
  private zOffset = 0;
  // The ground height the focus is currently sitting on. Eased toward the terrain each frame
  // (see followGround) so cresting a cliff glides instead of snapping; `groundSnap` skips the
  // ease for the frame after a teleport (map load, minimap jump, a script camera apply).
  private groundZ = 0;
  private groundSnap = true;
  // Terrain extent the camera focus is kept inside so it can't scroll off into the
  // black void (issue #5). Set on map load from centerOffset + mapSize; null = no map.
  private mapBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  private distance = 4000;
  // Look from the south toward +Y (north up), matching WC3's default camera so
  // units/buildings (which default to facing 270° = south) face the viewer.
  private yaw = Math.PI / 2;
  private pitch = MapViewerScene.GAME_PITCH;
  // The rest of WC3's camera fields (7.24). They only move when a SCRIPT moves them —
  // CAMERA_FIELD_FIELD_OF_VIEW / ROLL / FARZ have no player-facing control — so the game
  // camera keeps WC3's own defaults (the 70 field on our 32° lens, no roll, far plane derived
  // from the distance) until a camera setup says otherwise, and ResetToGameCamera comes here.
  private fov = MapViewerScene.GAME_FOV;
  private roll = 0;
  private farZ = 0; // 0 = derive from the distance (the game camera's own rule)
  // The camera the map's SCRIPT drives: CameraSetupApply / PanCameraTo / SetCameraField all
  // blend the ONE camera above, over time (src/render/scriptCamera.ts).
  /**
   * The zoom the PLAYER chose — the one thing about the game camera that is theirs.
   *
   * `ResetToGameCamera` is how a map hands the camera back at the end of a cinematic, and
   * every chapter's cleanup calls it. Answering it with the constant start distance threw the
   * player's zoom away each time: you set your view, a scene played, and the game gave you
   * back a camera you had not asked for. This is read instead — it is written only by the
   * wheel (and by the match's own opening framing), never by the script's tweens, so a
   * cinematic that spends 40 seconds dollying through six camera setups still returns to
   * exactly the zoom the player was on.
   *
   * The camera's other fields have no player-facing control (see the block above), so for
   * those "the game camera" really is WC3's own defaults.
   */
  private playerDistance: number = CAMERA.DEFAULT_DISTANCE;
  /** …and the tilt that goes with it. The wheel is the only thing that moves the game camera's
   *  angle of attack (see pitchForZoomStep), so the player's zoom is a distance AND a pitch, and
   *  both have to survive a cinematic for ResetToGameCamera to hand back the view you had. */
  private playerPitch = MapViewerScene.GAME_PITCH;
  // The wheel's in-flight ease (see updatePlayerCamera). A notch does not jump the camera: it
  // starts a short tween from wherever the view currently is to the new step's distance+pitch,
  // so notching four times in a second reads as one smooth dolly rather than four snaps.
  private zoomFromDistance: number = CAMERA.DEFAULT_DISTANCE;
  private zoomFromPitch = MapViewerScene.GAME_PITCH;
  private zoomT = 1; // 0…1 through the current step's ease; 1 = settled
  /** Insert/Delete's yaw offset, in radians, CURRENTLY applied to `yaw`. Kept as a separate
   *  book so the spin rides on top of whatever else owns the rotation (a script's tween, a map
   *  camera) instead of replacing it: each frame only the DELTA is added to `yaw`. */
  private spin = 0;
  /** Game seconds stepped since the last frame drained it — the clock the cinematic runs on. */
  private simAdvanced = 0;
  private scriptCam = new ScriptCamera(() => ({
    distance: this.playerDistance,
    farZ: 0,
    aoaDeg: (-this.playerPitch * 180) / Math.PI,
    // Degrees, and on the scale a SCRIPT speaks — fovFromWc3 puts it on our lens.
    fovDeg: MapViewerScene.WC3_FOV_DEG,
    rollDeg: 0,
    rotationDeg: CAMERA.DEFAULT_ROTATION,
    zOffset: 0,
  }));
  private keys = new Set<string>();
  private dragging = false;
  private midPanning = false; // middle-mouse (button 1) held → drag-pan the camera (WC3)
  private downX = 0;
  private downY = 0;
  private moved = false;
  private lastClickAt = 0; // for double-click detection (select same type)
  private lastClickX = 0;
  private lastClickY = 0;
  private raf = 0;
  private last = 0;
  private rts: RtsController | null = null;
  private sounds: SoundBoard | null = null; // unit voice lines / sfx from the game data
  private grid: PathingGrid | null = null;
  // Fog of war: the 3D terrain overlay + the doodads it can't darken (hidden until
  // their cell is explored). Rebuilt per map; updated a few times a second.
  private fog: FogOverlay | null = null;
  private fogTerrain: TerrainData | null = null; // corner grid the fog mesh is built on
  // The tileset's day/night lighting (issue #47), loaded from Environment\DNC\* on map
  // load. Null when the install can't supply it — the world then keeps the viewer's
  // stock fullbright shading rather than going black.
  private dayNight: DayNightCycle | null = null;
  private mapFog: DistFog | null = null; // the map's w3i environment fog (distance haze)
  private w3iFog: DistFog | null = null; // …as the w3i declared it — what ResetTerrainFog restores
  // The top-bar day/night medallion — the real UI\Console\<Race>\<Race>UI-TimeIndicator
  // model on its own canvas, scrubbed to the sim clock each frame (issue #47).
  private clock: TimeIndicatorClock | null = null;
  // Last frame's daylight flag, so crossing Dawn/Dusk can cry once. null = not yet
  // sampled, which suppresses a spurious cry on the first frame of a match.
  private wasDay: boolean | null = null;
  // Building ground textures (ubersplats): the dirt/foundation decals under buildings
  // + gold mines (issue #12). Built at map load (needs only terrain + gl). uberSplats
  // resolves a building's `uberSplat` code → texture + scale. simBuildingSplats tracks
  // the ids we register from spawnUnit so they can be pruned when the building dies.
  private splats: UberSplatOverlay | null = null;
  private weather: WeatherOverlay | null = null; // AddWeatherEffect — rain/snow/fog (7.23)
  private weatherSampler: HeightSampler | null = null;
  private weatherDefs: WeatherRegistry | null = null; // TerrainArt\Weather.slk (loaded on first use)
  private uberSplats: UberSplatRegistry | null = null;
  private simBuildingSplats = new Set<number>();
  /** Ancients whose ground decal we lifted when they uprooted, so it can be laid back down
   *  where they plant. See the splat reconcile in the frame loop. */
  private liftedSplats = new Set<number>();
  // Pre-placed map buildings paint their splat keyed by index (p<i>), not sim id, so the
  // sim-id reconcile can't prune them when destroyed. Track each with its world position
  // so we can reconcile it BY POSITION (issue #40): once a live sim building has been seen
  // at its spot, its later disappearance (the neutral shop/fountain was destroyed) removes
  // the decal. `seen` guards the progressive seed — the neutral unit loads a couple frames
  // after the splat is painted, so we must not remove it before it ever exists.
  /** Pre-placed buildings' ground splats, keyed `p<i>` by .doo index. `simId` is the id the
   *  placement registry reserves for that same index (`i + 1` — setPlacedOrder's rule), known
   *  statically, so the splat can follow its building's record and image without the old
   *  position-matching pass. `seen` latches once the record has EXISTED, so a record that is
   *  merely still streaming in at boot is not mistaken for a destroyed building. */
  private mapBuildingSplats = new Map<string, { simId: number; seen: boolean }>();
  private debug: DebugColliders | null = null; // debug collider overlay (lazy)
  private showColliders = false; // debug overlay toggle (bottom-right cheat button)
  private heightSampler: HeightSampler | null = null; // terrain height for the overlay
  private footMaxHeight: FootprintMaxSampler | null = null; // tallest terrain across a footprint (issue #15)
  // Building-placement footprint grid: rebuilt each frame while positioning a build and
  // drawn as its own colored-quad pass (reuses the debug-collider overlay). One quad per
  // blocked footprint cell — green where buildable, red where the pathing grid obstructs.
  private placeCells = new Float32Array(0);
  private placeCellVerts = 0;
  /** Ground the player's own not-yet-started builds hold, as of the last ghost update — see
   *  `pendingBuildCells`. Refreshed with the ghost so the squares it reddens and the click
   *  `placementValid` refuses are always the same answer. */
  private placeReserved: ReadonlySet<number> = new Set();
  // Static geometry (pathing/vision cells + tree click-rings) — rebuilt on a slow timer;
  // dynamic geometry (unit click-rings) — rebuilt every frame since units move.
  private dbgCells = new Float32Array(0); // pathing + vision quads (triangles)
  private dbgCellVerts = 0;
  private dbgTreeRings = new Float32Array(0); // tree click rings (lines)
  private dbgTreeVerts = 0;
  private dbgUnitRings = new Float32Array(0); // unit/building click rings (lines)
  private dbgUnitVerts = 0;
  private dbgStaticAccum = 1e9; // ms since static rebuild (force one on first frame)
  // "Show Pathing" overlay (separate toggle). Static geometry (the cell lattice, built
  // once per map; the unwalkable-cell outlines, rebuilt on a slow timer) lives in
  // PERSISTENT GPU buffers uploaded only when it changes — re-streaming its >1M verts
  // every frame tanked the framerate. Only the small per-frame route layer re-uploads.
  private showPathing = false;
  private pathGridLayer: OverlayLayer | null = null; // pathing-cell lattice (lines)
  private pathBlockedLayer: OverlayLayer | null = null; // unwalkable cell outlines (triangles)
  private pathRouteLayer: OverlayLayer | null = null; // moving units' remaining routes (lines)
  private dbgGridFor: PathingGrid | null = null; // grid the lattice was built for (cache key)
  private dbgBlockAccum = 1e9; // ms since the blocked-cell rebuild (force one on first frame)
  // "Show Regions" overlay (Phase 7 trigger debug): the map's named gg_rct_* rects,
  // outlined on the terrain with a floating DOM name label centred in each.
  private showRegions = false;
  private regionLayer: OverlayLayer | null = null; // rect outlines (lines)
  private regionFillLayer: OverlayLayer | null = null; // faint rect fills (triangles)
  private regionGeomFor: MapScriptEngine | null = null; // map script the geometry was built for (cache key)
  private regionCache: Array<{ name: string; cx: number; cy: number; cz: number }> = []; // label anchors
  private regionLabelBox: HTMLDivElement | null = null; // DOM container for the name labels
  private regionLabelPool: HTMLDivElement[] = []; // reused label elements
  private fogAccum = 0; // ms since the last fog resample (throttle)
  private removedWidgets = new Set<HideableWidget>(); // felled trees / mined-out mines — stay gone, never re-fogged
  /** Gold-mine widgets hidden UNDER an Entangled Gold Mine, keyed by that building's sim id.
   *  Unlike `removedWidgets` these come back: knock the roots down and the mine is a mine
   *  again. See raiseEntangledMines. */
  private entangledMines = new Map<number, { widget: HideableWidget; mineId: number }>();
  private baseColors = new WeakMap<object, Float32Array>(); // each widget's tint before fog dimming
  private tintScratch = new Float32Array(4); // reused fog tint, avoids per-widget allocation
  private cheatBuf = ""; // rolling buffer of typed letters, for WC3 chat cheat codes
  private footprints = new Map<string, Footprint | null>();
  private metrics = new MetricsOverlay();
  private hud: GameHud | null = null;
  private mapScript: MapScriptEngine | null = null; // the running JASS interpreter (Phase 7), pumped from the frame loop
  /** Registration count the sim's capture flags were derived from — re-derive when it
   *  changes (a trigger, or a thread resuming from a Wait, can register events late). */
  private scriptRegCount = 0;
  /** Does the script watch a unit-state threshold (EVENT_UNIT_STATE_LIMIT)? That event is
   *  polled per tick rather than raised by the sim, so it needs its own gate (7.17). */
  private scriptWatchesUnitState = false;
  /** Does the script watch SELECTION (EVENT_PLAYER_UNIT_SELECTED/…)? Raised by the RTS's own
   *  diff of the local selection rather than by the sim — see pumpSelectionEvents. */
  private scriptWatchesSelection = false;
  private gameMenu: EscMenu | null = null; // F10 — the game's own EscMenuMainPanel.fdf
  private allies: AllianceDialogOverlay | null = null; // F11 — AllianceDialog.fdf + AllianceSlot.fdf
  private chatDialog: ChatDialogOverlay | null = null; // F12 — ChatDialog.fdf
  private questLog: QuestDialogOverlay | null = null; // F9 — QuestDialog.fdf
  /** The console — both bands of ConsoleUI + UpperButtonBar + ResourceBar, all from the FDF. */
  private consoleUi: ConsoleUi | null = null;
  /** war3map.w3i's name — the Quest Log's subtitle. May be a TRIGSTR_ until the script loads. */
  private mapDisplayName = "";
  /** The last FlashQuestDialogButton count the HUD was shown, so a new flash glows once. */
  private questFlashesSeen = 0;
  /** Dialogs already relayed to a remote player, by `handleId:revision` — so a screen that is
   *  shown for the rest of the match is sent once rather than sixty times a second (item F7). */
  private readonly relayedDialogs = new Map<number, string>();
  /** A dialog the AUTHORITY raised for us, when we are a client. Null on the host. */
  private remoteDialog: DialogObj | null = null;
  /**
   * The MATCH is decided — somebody won, or it was a tie — as opposed to one player being
   * knocked out (Phase G item 1).
   *
   * The distinction is the whole rule. A defeat ends one player's game; a defeated player in a
   * three-way is still watching somebody else's, and hanging up on them would be taking it
   * away. So `RemovePlayer` sets this only for a result that ends the match for everyone, and
   * the wire lives until then.
   */
  private matchDecided = false;
  /** This machine has hung up (or is about to). Also what stops a `room-closed` arriving
   *  afterwards from putting "You were disconnected." over a perfectly good Victory screen. */
  private matchEnded = false;
  /** Shown when the match ends out from under the player — v1's only cause is the host
   *  leaving, since there is no migration (docs/multiplayer.md Phase F item 6). */
  private matchOver: MatchOverDialog | null = null;
  private paused = false; // F10 game menu freezes the sim (rendering continues)
  /** The world is standing at the gate: built, but not yet begun — a campaign chapter whose
   *  loading screen is still holding for "PRESS ANY KEY TO CONTINUE" (see `holdAtStart`). */
  private startHeld = false;
  private simAccum = 0; // unspent real time, in seconds, waiting to become whole sim steps
  /** Ticks elapsed since the match began. THE match clock — the number a multiplayer
   *  command is stamped with and a snapshot is taken at (docs/multiplayer.md). */
  private simTick = 0;
  /** When the sim last advanced (performance.now() ms). Owned by `advanceSim` and SHARED
   *  between the rAF frame and the background pump: whichever driver runs next advances
   *  only by the time the other has not already spent, so time is never counted twice. */
  private simLast = 0;
  /** When the last rAF frame ran — how the background pump tells "the render loop is
   *  alive, stand down" from "the window is hidden/occluded and rAF has stopped". */
  private lastFrameAt = 0;
  /** The LAN authority's clock when Chrome stops the render loop — see startBackgroundPump. */
  private bgPump: Worker | null = null;
  /** Called when the player picks "End Game" — host tears the match down. */
  onExit: (() => void) | null = null;
  /** The LOCAL player's game ended in a win — `RemovePlayer(p, PLAYER_GAME_RESULT_VICTORY)`,
   *  which `CustomVictoryBJ` calls before it shows anything. A campaign uses it to open the
   *  next chapter (src/data/campaignProgress.ts); a skirmish has nobody listening. */
  onLocalVictory: (() => void) | null = null;
  // --- the trigger's on-screen output (7.19) ---
  private textTags: TextTagOverlay | null = null; // CreateTextTag, drawn in the world
  // The ENGINE's own floating combat text — a Critical Strike's red "127!", a deny's "!".
  // Drawn by the overlay above but owned here, because no script is involved: it must work in
  // a melee match, where `rt.textTags` stays empty for the whole game.
  private readonly combatText = new CombatTextTags();
  private leaderboard: LeaderboardOverlay | null = null; // CreateLeaderboard, top-right
  private multiboard: MultiboardOverlay | null = null; // CreateMultiboard — the grid scoreboard (7.22)
  private timerDialogs: TimerDialogOverlay | null = null; // CreateTimerDialog — the countdown windows (7.21)
  private cinematic: CinematicPanelOverlay | null = null; // the letterbox + transmissions + the fade (7.24)
  // The two switches CinematicModeBJ throws, tracked so they can be restored: the HUD is on
  // screen only when BOTH the interface (ShowInterface) and the UI (EnableUserUI) are on —
  // they are different natives, and a cinematic uses them for different things (the letterbox
  // vs. hiding everything under a fade).
  private interfaceShown = true;
  private userUi = true;
  /** EnableUserControl — false while a cinematic owns the mouse, keyboard and camera. */
  private userControl = true;
  /** SetGameSpeed / GetGameSpeed — the common.j gamespeed index. 2 = MAP_SPEED_NORMAL. */
  private gameSpeed = 2;
  /** common.j gamedifficulty index — MAP_DIFFICULTY_NORMAL until a campaign says otherwise. */
  private gameDifficulty = 1;
  /** This match is a campaign CHAPTER (MeleeConfig.campaign) — a mission, not a game off a
   *  map list. Read by panelDead: no allies to talk to, nobody to chat with. */
  private campaign = false;
  // The speaker's animated bust during a transmission — its own bust viewer, on the FDF
  // panel's canvas, exactly like the HUD's portrait (which it must not steal).
  private cinePortraitViewer: ModelViewerScene | null = null;
  /** `<unit type>|<player colour>` of the bust ON the canvas, and the one last asked for.
   *  Two fields, for the same reason the panel has two — see `loadCinematicPortrait`. */
  private cinePortraitFor = "";
  private cinePortraitWant = "";
  private cinePortraitLoading = false;
  private dialog: GameDialogOverlay | null = null; // DialogCreate — and the melee end screen
  /** The game's own string table (UI\FrameDef\GlobalStrings.fdf) behind GetLocalizedString:
   *  blizzard.j writes the whole victory/defeat screen in its keys. Loaded once, lazily. */
  private globalStrings: FdfLibrary | null = null;
  private screen3 = new Float32Array(3); // scratch for the world→screen projection
  private world3 = new Float32Array(3);
  private minimap: HTMLCanvasElement | null = null;
  private iconCache = new Map<string, string | null>();
  /** Every icon URL blpIcon() has handed out, mapped back to the BLP it was decoded from.
   *  A greyed command button needs its icon's DIS* twin, and by the time the card is
   *  assembled the call site has long since thrown the path away — this is how `cmd()`
   *  finds it again without threading a second path through every push site. */
  private iconSource = new Map<string, string>();
  private localPlayer = 0;
  private localRace: PlayableRace = "human";
  // Footprints of registered resource nodes, for unstamping on removal.
  private nodeFootprints = new Map<number, { fp: Footprint; x: number; y: number }>();
  // The map's destructibles (war3map.doo ∩ DestructableData) in .doo order — what a script's
  // `destructable` handle points at, and what `ModifyGateBJ` opens and closes. See
  // src/world/mapDestructibles.ts; the live half (which collider is stamped right now, and the
  // scene-animated stand-in playing its clips) is tracked here.
  private destructibles: MapDestructible[] = [];
  // Fog footprint half-extent of each tree, keyed by its rounded world position — the
  // doodad widgets stream in async, so we can't hold instance refs here. Lets fogWidgets
  // light a tree from ANY cell it covers rather than one self-shadowed origin cell (#43).
  private treeFogRadius = new Map<number, number>();
  // Animated portrait of the selected unit (own small viewer + canvas).
  private portraitViewer: ModelViewerScene | null = null;
  private portraitFor: number | null = null;
  private portraitLoading = false;
  // Background portrait-model warming (kills the first-select spike): types whose
  // bust is already parsed/cached, the pending decode queue, and the idle-drain guard.
  private warmedPortraits = new Set<string>();
  private portraitWarmQueue: string[] = [];
  private portraitWarmScheduled = false;
  private portraitWarmAccum = 0; // ms since the last on-map type re-scan
  private portraitLabel = ""; // sound-set of the unit currently in the portrait (drives talk anim)
  private lastVoice: { label: string; until: number } | null = null; // most recent voice line (label + when it ends), so a bust that finishes loading mid-line still mouths it
  private cameraLock = false; // portrait held → camera follows the selected unit
  private groupFollow = false; // hero key / control-group digit held after its double-tap → camera rides the group
  private followVel: [number, number] = [0, 0]; // that follow's spring velocity, world units/s
  /** GAME milliseconds the PREVIOUS frame's `advanceSim` actually retired (0, one or two
   *  SIM_DT steps, and 0 while paused). The follow moves on this clock rather than the render
   *  one — see `followHeld`. */
  private lastSimStep = 0;
  private cardPage: "root" | "build" | "learn" = "root";
  private lastSelected: number | null = null;
  /** The building riding the cursor, waiting for the click that puts it down.
   *
   *  `rootUnitId` makes it a ROOT rather than a build: an uprooted Ancient being told where to
   *  plant itself. Same silhouette, same green/red footprint grid, same click — what differs
   *  is that no worker is involved, nothing is paid for, and the order goes to the Ancient
   *  itself (`{kind:"rootat"}`). See runCommand's `Aroo` branch. */
  private placement: { def: UnitDef; fp: Footprint | null; workerId: number; rootUnitId?: number } | null = null;
  private ghost: HTMLDivElement | null = null;
  // Translucent building-silhouette ghost that follows the cursor while placing.
  private buildGhosts = new Map<string, SpawnInstance>();
  private buildGhost: SpawnInstance | null = null;
  private ghostBirthFrame = -1; // frame to pin the ghost at (Birth end = built)
  // Dark-blue "pending build" ghosts shown at each queued build site while the worker
  // walks there (issue #18) — only for the owning player. Keyed by build site so a
  // site's ghost is created once and dropped the instant its worker's order clears
  // (build starts, is canceled, or the worker is re-tasked). pendingGhostLoading guards
  // the async model load so a site isn't double-spawned.
  private pendingGhosts = new Map<string, { inst: SpawnInstance; defId: string; frame: number }>();
  private pendingGhostLoading = new Set<string>();
  // Workers whose build foundation is mid-spawn (async model load), so
  // tickPendingBuild doesn't raise the same building twice.
  private buildSpawning = new Set<number>();
  // Workers waiting for their build site to clear of units → seconds waited so far.
  private buildWait = new Map<number, number>();
  private meleeTeams = new Map<number, number>(); // owner slot → team
  /** Lobby labels by slot — the owner line, and the Allies dialog's player rows. */
  private playerNames = new Map<number, string>();
  /** Every chat line this player has heard, rendered — the F12 dialog's Chat History and the
   *  Message Log both read it. Kept here rather than in the HUD because it must outlive the
   *  on-screen lines, which expire. */
  private chatHistory: string[] = [];
  /** How many seats a person is sitting in — what makes a match "multiplayer" for chat. */
  private humanPlayers = 1;
  // Custom maps only: the map's pre-placed player units (from war3mapUnits.doo) and
  // its own archive (to read war3map.j). startCustom seeds the units OWNED so the
  // local player has vision/control (issue #33) and runs the map's config() (Phase 7).
  private mapPlayerUnits: Array<{ x: number; y: number; owner: number }> = [];
  private mapArchive: MpqDataSource | null = null;
  /** The viewer's object-data tables as the GAME ships them, snapshotted at the first map load
   *  so every map after it starts from the game's data rather than the last map's. Keyed by
   *  table name → row id → that row's raw values. See resetObjectData. */
  private pristineObjectData = new Map<string, Map<string, Record<string, unknown>>>();
  // Start-location (`sloc`) markers load async: the viewer flips `unitsReady`
  // synchronously but pushes each Unit into `map.units` only once its model has
  // finished loading, so a marker can arrive a frame or two after `unitsReady`.
  // A one-shot hide misses those late ones (they render forever); instead we
  // re-scan whenever the unit count grows, mirroring RtsController.trySeed. -1
  // means "not scanned yet" so the first real count always triggers a pass.
  private lastMarkerScanCount = -1;
  // Selection/hover/preview/flash rings, painted through a terrain-tessellated splat
  // overlay so each ring conforms to the ground (issue #34) instead of a flat model
  // that clips into slopes. Rebuilt every frame; ringKeys tracks the entries live from
  // the previous frame so stale ones (deselected units, expired flashes) get pruned.
  private ringSplats: UberSplatOverlay | null = null;
  private ringKeys = new Set<string>();
  // Shadows (issue #58): the cheap directional blob shadow each unit casts on the terrain.
  // Its own batched GL pass (src/render/shadowOverlay.ts) — rebuilt every frame from the
  // visible units, dimmed by the fog like the ground. UNITS and BUILDINGS use separate
  // overlays so they can draw at different points in the frame (units before the models,
  // buildings after the foundation decals — see the render loop).
  private shadows: ShadowOverlay | null = null;
  private buildingShadows: ShadowOverlay | null = null;
  /** The map's own baked shadow layer (war3map.shd) — cliffs, doodads and scenery. */
  private terrainShadows: TerrainShadowOverlay | null = null;
  // Lightning ribbons (issue #97) — Chain Lightning, Healing Wave, the Drains and kin.
  // Its own GL pass, drawn after the world's translucent instances and before the fog; the
  // bolts are strung by the sim's `drainFxLightnings` events and follow their units.
  private lightning: LightningOverlay | null = null;
  private rallyFlag: SpawnInstance | null = null; // shown at the selected building's rally
  private queueFlagModel: SpawnModel | null = null; // the (smaller) waypoint flag, pooled below
  private queueFlags: SpawnInstance[] = []; // pool: small flags at queued-order positions
  private selectBoxEl: HTMLDivElement | null = null;
  private cursorStyleEl: HTMLStyleElement | null = null;
  private reticleEl: HTMLDivElement | null = null; // follows the cursor while armed
  private carryEl: HTMLDivElement | null = null; // the item icon "held" by the hand while moving it
  private lastCursor = { x: 0, y: 0 }; // viewport cursor position, tracked everywhere (see trackCursor)
  private cursorSheet: HTMLCanvasElement | null = null; // race cursor sprite sheet
  private reticleUrls = new Map<string, string>(); // tinted WC3 reticle by colour key
  private handUrls = new Map<string, string>(); // tinted race hand cursor by colour key
  private lastMouse = { x: 0, y: 0 };
  // Transient harvest-/attack-order ring flashes: a colour + lifetime; the ring itself
  // is (re)painted into ringSplats each frame it's "on" (see tickFlashCircles).
  private flashRings: Array<{ id: number; t: number; x: number; y: number; radius: number; color: number[]; sizeToRadius: boolean }> = [];
  private flashSeq = 0;
  // Order-feedback arrows (Confirmation.mdx), green=move / red=attack-move.
  private arrowModel: SpawnModel | null = null;
  private orderArrows: Array<{ inst: SpawnInstance; t: number }> = [];
  // One-shot spawn effects (e.g. the building cancel explosion), cached by path.
  private effectModels = new Map<string, SpawnModel | null>();
  private effects: Array<{ inst: SpawnInstance; t: number }> = [];
  // Ground items (dropped / creep-dropped): one model instance per sim item id.
  private itemInstances = new Map<number, SpawnInstance>();
  private itemShown = new Map<number, boolean>(); // last fog visibility pushed to each item model
  private itemLoading = new Set<number>();
  // Items mid-"Birth": once the birth clip finishes, switch them to a looping Stand.
  private itemBirthing: Array<{ id: number; inst: SpawnInstance; standIdx: number; birthEnd: number }> = [];
  // Trees briefly tinted yellow when a worker is sent to harvest them.
  private treePulses: Array<{ inst: { setVertexColor(c: ArrayLike<number>): unknown }; t: number }> = [];
  // Projectile (missile) instances, keyed by the sim projectile id.
  private projectileModels = new Map<string, SpawnModel | null>();
  private projectileInsts = new Map<number, SpawnInstance>();
  private projectileLoading = new Set<number>();
  // Blood Mage orbiting spheres (issue #37): one rig per live Blood Mage, keyed by
  // sim id. Spawned on demand; balls ride the hero model's sprite attachment nodes.
  private bloodMageSpheres = new Map<number, SphereRig>();
  private bloodMageSpheresLoading = new Set<number>();
  private mq = new Float32Array(4);
  private loc3 = new Float32Array(3);
  private consoleSkinCache: boolean | undefined;
  /** UI\war3skins.txt, parsed once — see skinPath(). */
  private skins: Map<string, Map<string, string>> | undefined;
  private strings!: CommandStrings; // Units\commandstrings.txt [Errors] — every refusal line

  private constructor(
    private canvas: HTMLCanvasElement,
    private viewer: W3xViewer,
    private blobUrls: string[],
    private vfs: DataSource,
    private registry: UnitRegistry,
    private abilities: AbilityRegistry,
    private items: ItemRegistry,
    private tech: TechRegistry,
    private upgrades: UpgradeRegistry,
    private solver: Solver,
    shared: SoundBoard | null,
  ) {
    // The menu already built a SoundBoard (and with it the page's one AudioContext) to play
    // its theme and its wind — take that same one into the match rather than opening a second.
    this.sounds = shared ?? new SoundBoard(vfs);
    this.strings = loadCommandStrings(vfs); // the console's refusal lines, out of the archive
    this.setupKeyboardLock();
    // When the unit shown in the portrait speaks, mouth it on the 3D bust. Also
    // remember the line: a fresh selection plays its "What" voice while the bust
    // model is still loading, so onVoiceStart fires before the instance exists and
    // playTalk here no-ops — updatePortrait() replays it once the bust is ready.
    this.sounds.onVoiceStart = (label, durationSec) => {
      if (!label) return;
      this.lastVoice = { label, until: performance.now() + durationSec * 1000 };
      if (label === this.portraitLabel) this.portraitViewer?.playTalk(durationSec);
    };
    // Mute toggle on the bottom-left debug panel.
    this.metrics.onToggleMute = (muted) => this.sounds?.setMuted(muted);
    this.attachControls();
    // Decode command-card icons ahead of time (idle) so the first selection of a
    // unit/building type doesn't stall a frame decoding its whole card at once.
    this.warmIconCache();
  }

  /** Construct the viewer and wait for its base SLK tables (required before loadMap). */
  static async create(canvas: HTMLCanvasElement, vfs: DataSource, sounds: SoundBoard | null = null): Promise<MapViewerScene> {
    syncCanvasSize(canvas);

    const baseUrls = new Map<string, string>();
    const created: string[] = [];
    for (const path of BASE_FILES) {
      const bytes = await vfs.read(path);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      baseUrls.set(path, url);
      created.push(url);
    }

    // Every model/texture path resolves to a STABLE, cached blob-url string —
    // never a Promise<bytes>. This is the load-time win behind issue #14: the
    // viewer only DEDUPES a resource when the path solver hands it a string it
    // can key its promiseMap/resourceMap on. A Promise (what `vfs.read()`
    // returns) sends the load down the viewer's __DIRECT_LOAD path, which mints a
    // unique id and parses a *fresh* resource EVERY call — so a map with hundreds
    // of trees all referencing one LordaeronTree.mdx re-read and re-parsed that
    // model once per tree, the dominant cost of map init. One blob url per path
    // (cached here, tracked in `created` for revocation on dispose) means each
    // shared model/texture is fetched once and parsed exactly once.
    const blobUrls = new Map<string, string | null>();
    const solver: Solver = (src, params) => {
      if (typeof src !== "string") return src; // in-memory loads pass through
      let path = src.replace(/\//g, "\\");
      // Tileset-specific cliff textures: CliffTypes.slk just says "Cliff0"/
      // "Cliff1", but the game prepends the tileset letter (W_Cliff0.blp on
      // winter maps, …). Not every tileset ships prefixed files — fall back to
      // the plain (Lordaeron summer) texture when absent.
      const tileset = params?.tileset?.toUpperCase();
      if (tileset) {
        const cliffTex = /^(.*\\cliff\\)(cliff[01]\.(?:blp|dds))$/i.exec(path);
        if (cliffTex) {
          const variant = `${cliffTex[1]}${tileset}_${cliffTex[2]}`;
          if (vfs.exists(variant)) path = variant;
        }
      }
      const cached = baseUrls.get(path);
      if (cached) return cached; // preloaded base SLKs
      let url = blobUrls.get(path);
      if (url === undefined) {
        const bytes = vfs.rawBytes(path); // MPQ decode is synchronous (mpq.ts)
        url = bytes ? URL.createObjectURL(new Blob([bytes as BlobPart])) : null;
        blobUrls.set(path, url);
        if (url) created.push(url);
      }
      return url ?? src; // string ⇒ the viewer caches+dedupes by this url
    };

    const viewer = new ViewerClass(canvas, solver, false);
    viewer.terrainModelExists = (path) => vfs.exists(path);
    viewer.on("error", (e) => console.error("[mapviewer]", e));

    await new Promise<void>((resolve) => {
      if (viewer.loadedBaseFiles) resolve();
      else viewer.once("loadedbasefiles", resolve);
    });

    return new MapViewerScene(canvas, viewer, created, vfs, loadUnitRegistry(vfs), loadAbilityRegistry(vfs), loadItemRegistry(vfs), loadTechRegistry(vfs), loadUpgradeRegistry(vfs), solver, sounds);
  }

  /** Load a .w3x/.w3m (raw archive bytes) and frame the camera on the whole map. */
  loadMap(bytes: Uint8Array): void {
    syncCanvasSize(this.canvas);
    // Drop the previous map's scene so reloading doesn't stack renders.
    const prev = this.viewer.map?.worldScene;
    if (prev) this.viewer.removeScene(prev);
    this.disposeFog(); // drop the old map's fog overlay + un-hide its doodads
    this.splats?.dispose();
    this.splats = null;
    this.ringSplats?.dispose();
    this.ringSplats = null;
    this.ringKeys.clear();
    this.shadows?.dispose();
    this.shadows = null;
    this.buildingShadows?.dispose();
    this.buildingShadows = null;
    this.terrainShadows?.dispose();
    this.terrainShadows = null;
    this.simBuildingSplats.clear();
    this.liftedSplats.clear();
    this.mapBuildingSplats.clear();
    this.rts?.dispose();
    this.rts = null;
    this.dayNight = null;
    this.lastMarkerScanCount = -1;
    this.rallyFlag = null;
    this.queueFlagModel = null;
    this.queueFlags = [];

    // The viewer's object-data tables are global and every map merges into them, so give the
    // next map the game's own tables rather than the last map's (see resetObjectData).
    this.resetObjectData();
    this.viewer.loadMap(bytes);
    this.repairCustomRowIds(); // …before anything asks a placed unit which type it is
    const map = this.viewer.map;
    if (!map) return;

    const [cols, rows] = map.mapSize;
    const [ox, oy] = map.centerOffset;
    // Terrain spans centerOffset → centerOffset + (n-1) tiles, 128 world units per
    // tile (CELL); the map centre lands on world origin. Keep the camera focus
    // clamped to this rect so it can't drift into the void beyond the map (issue #5).
    const CELL = 128;
    this.mapBounds = { minX: ox, maxX: ox + (cols - 1) * CELL, minY: oy, maxY: oy + (rows - 1) * CELL };
    this.target = new Float32Array([ox + (cols - 1) * 64, oy + (rows - 1) * 64, 0]);
    // A new map is a teleport: no previous ground to ease away from, and no script offset yet.
    this.zOffset = 0;
    this.lastFocus = null;
    this.groundSnap = true;
    // Start near gameplay zoom rather than a whole-map overview — far better
    // draw performance and closer to WC3's default camera.
    this.distance = this.playerDistance = MapViewerScene.MELEE_START;
    this.pitch = this.playerPitch = MapViewerScene.GAME_PITCH; // …and its overhead angle
    this.zoomT = 1; // no wheel ease in flight across a map load

    // Stand up the simulation: terrain height + pathing from the map's own files.
    const archive = new MpqDataSource("map", bytes);
    this.mapArchive = archive; // kept so startCustom can read war3map.j (Phase 7 triggers)
    // The map's own object data goes in FIRST — before anything reads the registries for this
    // map. It is the map's declaration of what its types ARE, so every question asked below
    // (a building's pathing footprint, its ground texture, whether it is a building at all)
    // has to be asked of the map's answer and not the install's. Loading it later — it used
    // to run at the top of startCustom, hundreds of lines after this — is what left WTii's
    // Unit Tester's mercenary camps wearing ubersplats: the map clears `uubs` on all fourteen
    // of them through the ORIGINAL table, but stampMapPathing had already painted the stock
    // decal from the un-overridden row. Its custom `h0xx` shops only looked right by accident
    // (a custom id resolves to nothing at all before the overlay lands, so nothing was
    // painted). Doing it here also means a MELEE map with object data finally gets it — the
    // startCustom call meant melee maps were reading their own .w3u nowhere.
    this.loadMapObjectData();
    // …and mounted over the install for AUDIO, so a map's imported clips resolve: the paths
    // its CreateSound calls name (`war3mapImported\HalloweenMusic.wav`) are inside this
    // archive and nowhere else. See SoundBoard.mountMap.
    this.sounds?.mountMap(archive);
    // The map's own display name (war3map.w3i) — the Quest Log's white subtitle line.
    // parseMapInfo takes the whole MAP ARCHIVE (it opens the MPQ itself and resolves the
    // name's TRIGSTR_ through war3map.wts), not the w3i bytes — feeding it the w3i was a
    // "No MPQ header" throw that killed the entire map load.
    try {
      this.mapDisplayName = parseMapInfo(bytes, "").name;
    } catch {
      this.mapDisplayName = ""; // a nameless log is a poorer log, not a failed boot
    }
    const minimapBytes = archive.rawBytes("war3mapMap.blp");
    this.minimap = minimapBytes ? blpToCanvas(minimapBytes) : null;
    const w3e = archive.rawBytes("war3map.w3e");
    const wpm = archive.rawBytes("war3map.wpm");
    if (w3e && wpm) {
      const terrain = parseW3E(w3e);
      this.fogTerrain = terrain; // corner grid for the fog overlay mesh
      // The tileset picks which DNC light models shade this map (WorldEditData.txt).
      this.dayNight = DayNightCycle.load(this.vfs, lightEnvironment(archive, terrain.tileset));
      // Building ground-texture (ubersplat) overlay — needs only terrain + the GL
      // context, both ready here, so build it now (unlike fog, which waits on vision).
      // stampMapPathing (pre-placed buildings) and spawnUnit register splats into it.
      const splatLoader = (p: string) => {
        const b = this.vfs.rawBytes(p);
        return b ? blpToCanvas(b) : null;
      };
      this.splats = new UberSplatOverlay(this.viewer.gl, terrain, splatLoader);
      // Separate overlay for selection/hover rings: same terrain-tessellation, but drawn
      // as its OWN pass AFTER the building splats so a ring paints on top of a foundation
      // decal (issue #16) — while still under the units (issue #34).
      this.ringSplats = new UberSplatOverlay(this.viewer.gl, terrain, splatLoader);
      // Shadow overlays (issue #58) — same terrain + BLP loader as the splats. Two passes
      // because they need OPPOSITE render orders: unit shadows draw BEFORE the units (the
      // top-right cast falls north = behind the unit, so drawing after would let the body
      // occlude it), while building shadows draw AFTER the ubersplats so they darken the
      // foundation decal, not just the grass around it.
      this.shadows = new ShadowOverlay(this.viewer.gl, terrain, splatLoader);
      this.buildingShadows = new ShadowOverlay(this.viewer.gl, terrain, splatLoader);
      // …and the STATIC half of WC3's shadows: the mask the World Editor bakes for
      // everything that never moves (render/terrainShadowOverlay.ts). Maps without one
      // simply get no layer.
      const shadowMask = parseTerrainShadows(archive.rawBytes("war3map.shd"), terrain);
      this.terrainShadows = shadowMask ? new TerrainShadowOverlay(this.viewer.gl, terrain, shadowMask) : null;
      // Weather (7.23) — the map's rain/snow/fog particles. Its own pass, drawn last:
      // atmosphere sits between the eye and the world. Particles are born at
      // `height` above the GROUND, so it needs the same terrain sampler the sim uses.
      this.weatherSampler = makeHeightSampler(terrain);
      this.weather = new WeatherOverlay(this.viewer.gl, splatLoader, (x, y) => this.weatherSampler!(x, y));
      // Lightning (issue #97): the same BLP loader, plus Splats\LightningData.slk — the
      // table that holds every bolt's texture, width, tint, fray and scroll speed.
      this.lightning = new LightningOverlay(this.viewer.gl, splatLoader, loadLightningRegistry(this.vfs));
      const grid = new PathingGrid(parseWpm(wpm), terrain.centerOffset);
      this.grid = grid;
      const nodes = this.stampMapPathing(grid, archive);
      const host: RtsHost = {
        canvas: this.canvas,
        camera: map.worldScene.camera as unknown as RtsHost["camera"],
        viewport: () => map.worldScene.viewport,
        units: () => map.units as ReturnType<RtsHost["units"]>,
        unitsReady: () => map.unitsReady,
      };
      this.heightSampler = makeHeightSampler(terrain);
      this.footMaxHeight = makeFootprintMaxSampler(terrain);
      this.rts = new RtsController(grid, this.heightSampler, host, this.registry, this.abilities, this.items, this.tech, this.upgrades, this.footMaxHeight);
      this.rts.setFootprintReader((tex) => this.footprintFor(tex)); // pathTex decode is a VFS read
      this.rts.setSoundBoard(this.sounds);
      this.rts.onRefuse = (key) => this.refuse(key); // refused orders → the gold line + error sound
      // Somebody handed us the keys to their army (or took them back). SHARED CONTROL only:
      // the other alliance settings change constantly and silently, and the data keeps a line
      // for this one alone.
      this.rts.onAllianceChange = (source, other, type, value) => {
        if (other !== this.localPlayer || type !== AllianceType.SharedControl) return;
        this.announce(fillSlots(this.strings.forRace(value ? "Controlgranted" : "Controlrevoked", this.localRace), [this.playerLabel(source)]));
      };
      this.registerResourceNodes(nodes);
      this.rts.initVisionBlockers(makeCliffLevelSampler(terrain)); // fog LOS: only cliff LEVELS + treelines block sight (not rolling groundHeight)
      this.rts.setNeutralPassive(nodes.neutral); // yellow ring for shops/taverns/etc.
      this.rts.setPlacedFootprints(nodes.placedFootprints); // each map building's stamp → freed when it dies
      this.rts.setCreepData(nodes.creeps); // per-creep guard/aggro data (Neutral Hostile)
      this.rts.setPlacedOrder(nodes.placedOrder); // sim ids from .doo order, not model-load order
      // AFTER setPlacedOrder, never before: that call reserves ids 1..N for the .doo's own
      // units and resets the counter above them. Seeding destructibles first handed them ids
      // 1..14 and the placed units then took those same ids back — a gate quietly became a
      // Watcher. Above the reserved block they are ordinal and identical on every machine,
      // because this walks the .doo in its own order.
      this.seedDestructibles();
      this.mapPlayerUnits = nodes.players; // pre-placed player units → seeded owned in startCustom (issue #33)
    }
  }

  /** `targType`s a weapon can actually name. The stock Targets Allowed lists carry `debris`
   *  and `wall`; `bridge` and `decoration` appear in none of them, and `tree` is the harvest
   *  path (SimWorld.trees), not this one. */
  private static readonly ATTACKABLE_TARG = new Set(["debris", "wall"]);

  /** simId → the .doo id of the destructible it stands for, and back again. Both, because
   *  life crosses this bridge in BOTH directions: an axe drives the sim unit's hp down and
   *  the script's own SetDestructableLife drives the record's. */
  private destSimIds = new Map<number, number>();
  private destSimByDoo = new Map<number, number>();
  /** One def per destructible TYPE (a map lays down 11 identical crates). */
  private destDefs = new Map<string, UnitDef>();

  /**
   * Give every attackable destructible a sim unit, so it can be clicked, ordered onto and
   * broken (the Elven Gate that shuts Rise of the Naga's first path).
   *
   * Which ones: `selectable` (the flag that decides whether a click can pick it up at all —
   * 0 on the invisible platforms a map lays down by the hundred) and a `targType` a weapon
   * can name. That is ~18 of this map's 2698 destructibles; the other 2502 are trees, which
   * have their own path, and the rest is scenery.
   *
   * A record placed DEAD stays dead — a felled tree, a smashed crate — and giving one a body
   * would put it back. What is NOT placed dead is a gate written with a life of 0: no gate in
   * the game can be placed dead (`canPlaceDead`), and NightElfX07 proves the byte means
   * something else by opening one of those with a script later. See collectMapDestructibles.
   */
  private seedDestructibles(): void {
    const rts = this.rts;
    const map = this.viewer.map;
    if (!rts || !map) return;
    this.destSimIds.clear();
    this.destSimByDoo.clear();
    this.destAwaitingBody.clear();
    for (const d of this.destructibles) {
      if (d.isTree || !d.selectable || d.life <= 0) continue;
      if (!MapViewerScene.ATTACKABLE_TARG.has(d.targType)) continue;
      let def = this.destDefs.get(d.typeId);
      if (!def) {
        def = destructibleUnitDef({
          typeId: d.typeId,
          name: this.westring(d.name),
          maxLife: d.maxLife,
          radius: d.radius,
          selCircle: d.selCircle,
          armorSound: d.armorSound,
          targType: d.targType,
          portraitModel: this.destructiblePortrait(d),
        });
        this.destDefs.set(d.typeId, def);
      }
      const simId = rts.addDestructible(def, d.x, d.y, d.angle, d.life);
      this.destSimIds.set(simId, d.id);
      this.destSimByDoo.set(d.id, simId);
      this.destAwaitingBody.add(simId);
    }
  }

  /** The bust the selection panel shows. The data ships one (`portraitmodel`) because the
   *  doodad's own model is a piece of terrain; `.mdl` as the editor spells it, `.mdx` as the
   *  archives ship it. Falls back to the doodad model when a type has no bust. */
  private destructiblePortrait(d: MapDestructible): string {
    const mdx = d.portraitModel.replace(/\.mdl$/i, ".mdx");
    if (mdx && this.vfs.exists(mdx)) return mdx;
    return ""; // no bust for this type — the panel shows an empty pane, as it does for a unit with none
  }

  /** Destructibles still waiting for the doodad pass to build their model. */
  private destAwaitingBody = new Set<number>();

  /**
   * Hand each destructible the doodad widget the viewer drew for it.
   *
   * Not at seed time, because there is nothing to hand over yet: the sim units are created
   * the moment the map's pathing is known, and mdx-m3-viewer builds the 3905 doodad
   * instances after that. Seeding with a null body left every gate orderable but
   * unCLICKABLE — picking walks the Entry list, and an Entry is exactly what a body buys.
   * So it is retried each frame until the widget appears, the same late-attach a
   * script-spawned unit gets while its model streams in.
   */
  private bodyDestructibles(): void {
    if (!this.destAwaitingBody.size || !this.rts) return;
    const map = this.viewer.map;
    if (!map) return;
    const doodads = map.doodads as unknown as HideableWidget[];
    if (!doodads.length) return;
    for (const simId of this.destAwaitingBody) {
      const destId = this.destSimIds.get(simId);
      const d = destId !== undefined ? this.destructibleById(destId) : null;
      const def = d ? this.destDefs.get(d.typeId) : undefined;
      if (!d || !def) {
        this.destAwaitingBody.delete(simId);
        continue;
      }
      const w = this.nearestDoodadWidget(d.x, d.y, doodads);
      if (!w?.instance?.model) continue; // the pass has not reached this one yet
      this.rts.attachDestructibleBody(simId, def, w.instance as unknown as RtsInstance);
      this.destAwaitingBody.delete(simId);
    }
  }
  /**
   * A destructible that died in the SIM is a destructible that died, full stop: hand it to
   * the same killDestructible the script's own KillDestructable goes through, so a gate
   * broken by an axe opens exactly as one opened by a trigger — death clip held on its last
   * frame, collider down to the posts its `pathTexDeath` keeps.
   *
   * Polled rather than pushed because the sim's death queue is drained inside the RTS tick
   * and this is the one caller that needs to know a NEUTRAL-passive widget went; ~18 map
   * entries is nothing to sweep, and the entry is removed as it goes.
   */
  private reapDestructibles(): void {
    if (!this.destSimIds.size || !this.rts) return;
    this.bodyDestructibles();
    for (const [simId, destId] of this.destSimIds) {
      const u = this.rts.simWorld.units.get(simId);
      if (u && u.hp > 0) {
        // The record is what GetDestructableLife reads and what the .doo/`w3d` world calls
        // life, so damage dealt in the sim has to land there too.
        const d = this.destructibleById(destId);
        if (d) {
          // …and a blow that landed since the last frame makes the thing SHUDDER. The record
          // still holds last frame's life, so a drop here is damage the sim just dealt — and
          // only that: a script's SetDestructableLife writes the record and the body together
          // (syncDestructibleToSim), which is right, because setting a gate's life in WC3
          // does not make it flinch.
          if (u.hp < d.life) this.hitDestructibleVisual(d);
          d.life = u.hp;
        }
        continue;
      }
      // Kill it FIRST, while the doo→sim link is still there to follow. `killDestructible`
      // retires the sim body through `syncDestructibleToSim`, which looks it up in
      // `destSimByDoo` — so clearing these two first (as this used to) meant the lookup found
      // nothing, silently skipped the `removeUnit`, and left the destructible's sim unit in
      // the world forever at zero life. That orphan kept its render Entry alive, and an Entry
      // whose body is the gate's own placed doodad is an Entry that will eventually draw over
      // the stand-in (see RtsController.borrowedBody). Both deletes stay for the case
      // syncDestructibleToSim returns early — the sim already dropped the unit itself.
      this.killDestructible(destId);
      this.destSimIds.delete(simId);
      this.destSimByDoo.delete(destId);
    }
  }

  /** The other direction: a script wrote this destructible's life, so the widget standing in
   *  the fight has to agree. `SetDestructableLife`, `DestructableRestoreLife` and
   *  `KillDestructable` all pass through here — Rise of the Naga opens by knocking its gate
   *  down to a fifth of its life (`SetDestructableLife(gg_dest_LTe1_1140, 0.20 * life)`), and
   *  without this the gate on screen would still have taken all 500. */
  private syncDestructibleToSim(d: MapDestructible): void {
    const simId = this.destSimByDoo.get(d.id);
    const u = simId !== undefined ? this.rts?.simWorld.units.get(simId) : undefined;
    if (!u) return;
    if (d.life <= 0) {
      // Killed by the script: retire the widget, and do NOT let the reaper kill it again
      // (killDestructible is idempotent, but the death clip is not worth replaying).
      this.destSimIds.delete(simId!);
      this.destSimByDoo.delete(d.id);
      this.rts?.simWorld.removeUnit(simId!);
      return;
    }
    u.hp = Math.min(d.life, u.maxHp);
  }
  /** Feed harvestable trees and gold mines into the headless sim, remembering
   *  each node's stamped footprint so it can be unstamped on removal. */
  private registerResourceNodes(nodes: { trees: Array<{ x: number; y: number; angle: number; pathTex: string }>; mines: Array<{ x: number; y: number; gold: number }> }): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    this.nodeFootprints.clear();
    this.treeFogRadius.clear();
    for (const t of nodes.trees) {
      // The tree's blocked extent doubles as its fog line-of-sight blocker, so a
      // 4x4Default tree shadows all four 64-unit vision cells it stands on (#43).
      const fp = this.footprintFor(t.pathTex, t.angle);
      const blockRadius = fp ? footprintRadius(fp) || 64 : 64;
      const tree = world.addTree(t.x, t.y, undefined, blockRadius);
      this.treeFogRadius.set(fogKey(t.x, t.y), blockRadius);
      if (fp) this.nodeFootprints.set(tree.id, { fp, x: t.x, y: t.y });
    }
    const minePathTex = this.registry.get("ngol")?.pathTex || "";
    const mineFp = minePathTex ? this.footprintFor(minePathTex) : null;
    // Size the mine's collider off the footprint's *blocked* extent, not the
    // full texture: `16x16Goldmine.tga` pads to 16 cells but only blocks the
    // central 8×8, so the true radius is 128, not 256 — the padded value made
    // the ring huge and swallowed workers ~1.5 tiles early.
    const mineDef = this.registry.get(GOLD_MINE_ID);
    for (const m of nodes.mines) {
      const radius = mineFp ? footprintRadius(mineFp) || 96 : 96;
      const mine = world.addMine(m.x, m.y, m.gold, radius);
      if (mineFp) this.nodeFootprints.set(mine.id, { fp: mineFp, x: m.x, y: m.y });
      // Gold-mine ground texture (NGOL splat); keyed by sim id so it's removed when
      // the mine depletes (drainDepletedMines).
      if (mineDef) this.addBuildingSplat(`m${mine.id}`, mineDef, m.x, m.y);
    }
  }

  /** A tree fell or a mine ran dry: hide its widget and free its cells. */
  private removeNodeVisual(nodeId: number, x: number, y: number, widgets: HideableWidget[]): void {
    const meta = this.nodeFootprints.get(nodeId);
    if (meta && this.grid) {
      unstampFootprint(this.grid, meta.fp, meta.x, meta.y);
      this.nodeFootprints.delete(nodeId);
    }
    let best: HideableWidget | null = null;
    let bestD = 128; // match within a tile
    for (const w of widgets) {
      const loc = w.instance?.localLocation;
      if (!loc) continue;
      const d = Math.hypot(loc[0] - x, loc[1] - y);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    if (best) {
      best.instance.hide();
      this.removedWidgets.add(best); // gone for good — keep the fog pass from re-showing it
    }
  }

  /** Stamp destructible (tree) AND building footprints onto the terrain grid so
   *  units path around them (war3map.wpm is terrain-only). Also collects the
   *  harvestable resource nodes (trees + gold mines) for the sim. */
  private stampMapPathing(
    grid: PathingGrid,
    archive: MpqDataSource,
  ): { trees: Array<{ x: number; y: number; angle: number; pathTex: string }>; mines: Array<{ x: number; y: number; gold: number }>; neutral: Array<{ x: number; y: number }>; creeps: CreepSeed[]; players: Array<{ x: number; y: number; owner: number }>; placedFootprints: PlacedFootprint[]; placedOrder: PlacedRef[] } {
    const placedFootprints: PlacedFootprint[] = []; // each map building's stamp, handed to its unit at seed time
    const trees: Array<{ x: number; y: number; angle: number; pathTex: string }> = [];
    const mines: Array<{ x: number; y: number; gold: number }> = [];
    const neutral: Array<{ x: number; y: number }> = []; // Neutral Passive (player 15) sites
    const creeps: CreepSeed[] = []; // Neutral Hostile (player 12+) guard + drop data
    const players: Array<{ x: number; y: number; owner: number }> = []; // pre-placed player units (custom maps)
    let buildVersion = 0;
    const w3iBytes = archive.rawBytes("war3map.w3i");
    if (w3iBytes) {
      const info = new w3iParser.File();
      info.load(w3iBytes);
      buildVersion = info.getBuildVersion();
      // The map's environment fog (w3i): useTerrainFog 0 = off; fogHeight is [z-start,
      // z-end] camera distance, fogColor is RGBA bytes. Applied to the world scene so the
      // terrain + units fade to the fog colour with distance, as in the real game.
      const fi = info as unknown as { useTerrainFog: number; fogHeight: Float32Array; fogColor: Uint8Array };
      if (fi.useTerrainFog > 0 && fi.fogHeight[1] > fi.fogHeight[0]) {
        const c = fi.fogColor;
        this.mapFog = makeMapFog(fi.fogHeight[0], fi.fogHeight[1], c[0] / 255, c[1] / 255, c[2] / 255);
      }
      // Remember it: a script's SetTerrainFogEx replaces the haze, and ResetTerrainFog
      // puts the map's OWN fog back (7.22) — so the w3i's settings are the baseline, not
      // "no fog". A map with useTerrainFog 0 resets to none, which is equally correct.
      this.w3iFog = this.mapFog;
    }
    const readBytes = (p: string): Uint8Array | null => this.vfs.rawBytes(p);

    // Destructibles (trees, rocks) from war3map.doo.
    const dooBytes = archive.rawBytes("war3map.doo");
    if (dooBytes) {
      const doodads = parseDoo(dooBytes, buildVersion);
      const destr = new MappedData(this.slkText("Units\\DestructableData.slk"));
      const dood = new MappedData(this.slkText("Doodads\\Doodads.slk"));
      // The destructibles get their own registry: they have life, and a script can end it —
      // a gate OPENS by dying (see mapDestructibles.ts), which swaps its collider for the
      // `pathTexDeath` one that blocks only the posts.
      this.destructibles = collectMapDestructibles(doodads, (id) => destr.getRow(id) ?? undefined);
      // A record the editor placed DEAD (the pre-felled trees a few maps scatter) stamps its
      // `pathTexDeath` instead, or nothing at all when its type leaves no wreckage. A gate
      // written with a life of 0 is not one of those — see collectMapDestructibles.
      const dead = new Map<number, string>(); // .doo index (1-based) → the texture that replaces pathTex
      for (const d of this.destructibles) if (d.life <= 0) dead.set(d.id, d.pathTexDeath);
      const pathTexOf = (id: string): string | undefined =>
        destr.getRow(id)?.string("pathTex") || dood.getRow(id)?.string("pathTex") || undefined;
      // EVERY doodad the map draws also blocks — including the `scriptCreated` ones, whose
      // .doo record only looks non-solid because the editor handed the live copy to
      // war3map.j (see DoodadInstance). Skipping those was issue #85: WarChasers' gates
      // rendered as gates and let units stroll through them. And the footprint TURNS with
      // the doodad — the two gates share one 20×4 texture and are told apart by facing
      // alone, so an unrotated stamp laid a vertical gate's wall across the corridor
      // instead of through it.
      const placements = doodads
        .map((d, i) => ({ id: d.id, x: d.x, y: d.y, angle: d.angle, pathTex: dead.get(i + 1), isDead: dead.has(i + 1) }))
        .filter((p) => !p.isDead || p.pathTex); // dead with no wreckage → no collider at all
      stampFootprints(grid, placements, pathTexOf, readBytes);
      // A tree placed dead is a stump: scenery, not something a wisp can chop.
      for (const d of this.destructibles) {
        if (d.isTree && d.life > 0) trees.push({ x: d.x, y: d.y, angle: d.angle, pathTex: d.pathTex });
      }
    }

    // Pre-placed units/buildings (gold mines, neutral buildings, creeps, and on
    // custom maps each player's own units) from war3mapUnits.doo — parsed by the
    // shared map-units module so the data path is the same everywhere.
    const placed = parseMapUnits(archive.rawBytes("war3mapUnits.doo"), buildVersion);
    const buildings = placed
      .filter((u) => this.registry.get(u.typeId)?.isBuilding)
      .map((u) => ({ id: u.typeId, x: u.x, y: u.y }));
    // Stamp them now — the sim needs the map's collision right, from the first tick, and
    // these buildings' sim units only stream in over the following frames. Each stamp is
    // handed to its unit as it seeds (see setPlacedFootprints), so a map building that is
    // destroyed frees its ground exactly like one the player built. Without that hand-off
    // the collision outlived the building: on WarChasers the gnoll huts you level at the
    // start went on blocking the path they stood in for the rest of the game.
    stampFootprints(grid, buildings, (id) => this.registry.get(id)?.pathTex || undefined, readBytes);
    for (const b of buildings) {
      const pathTex = this.registry.get(b.id)?.pathTex;
      const fp = pathTex ? this.footprintFor(pathTex) : null;
      if (fp) placedFootprints.push({ x: b.x, y: b.y, fp });
    }
    for (let i = 0; i < placed.length; i++) {
      const u = placed[i];
      // Pre-placed buildings (neutral shops, taverns, fountains, altars, etc.) get
      // their ground texture too. Keyed "p<i>" — static; these don't die in melee.
      // Gold mines are handled in registerResourceNodes (keyed by sim id, so the
      // splat can be removed when the mine depletes).
      if (u.typeId !== GOLD_MINE_ID) {
        const def = this.registry.get(u.typeId);
        if (def?.isBuilding && def.uberSplat) {
          this.addBuildingSplat(`p${i}`, def, u.x, u.y);
          // Track it against the sim id the placement registry reserves for this same .doo
          // index, so the decal follows the building's record — pruned when it is destroyed
          // (issue #40), withheld while its image is out of sight (the splat-visibility sync).
          this.mapBuildingSplats.set(`p${i}`, { simId: i + 1, seen: false });
        }
      }
      if (u.typeId === GOLD_MINE_ID) {
        mines.push({ x: u.x, y: u.y, gold: u.goldAmount || 12500 });
      } else if (u.neutralPassive) {
        // Shops, taverns, labs, merchants, fountains, critters — anything owned
        // by Neutral Passive gets the yellow selection/hover ring.
        neutral.push({ x: u.x, y: u.y });
      } else if (u.neutral) {
        // Neutral Hostile (player 12+) — a creep. Carry its per-instance
        // target-acquisition so the sim can use the map's own aggro range for it
        // (-1/-2 → the unit's default, resolved at seed time). x,y is its guard post.
        // Its dropped-item table rides along so the sim can scatter loot on death.
        creeps.push({ x: u.x, y: u.y, aggro: u.targetAcquisition, drops: u.dropSets });
      } else if (u.typeId !== START_LOCATION_ID) {
        // Owned by a real player slot (0–11) — a custom/campaign map's own units.
        // Seeded OWNED so the local player sees + controls them (issue #33); start-
        // location markers (sloc) are excluded (they aren't real units).
        players.push({ x: u.x, y: u.y, owner: u.player });
      }
    }
    // Every placed unit in war3mapUnits.doo ORDER. This is the map's own ordering of its
    // units and the only stable identity they have — see RtsController.setPlacedOrder.
    const placedOrder: PlacedRef[] = placed.map((u) => ({ x: u.x, y: u.y, typeId: u.typeId, facing: u.facing }));
    return { trees, mines, neutral, creeps, players, placedFootprints, placedOrder };
  }

  private slkText(path: string): string {
    const bytes = this.vfs.rawBytes(path);
    return bytes ? new TextDecoder("windows-1252").decode(bytes) : "";
  }

  /** Shared match bring-up for both melee and custom starts: pick the local
   *  player, aim the camera at their base, resolve each slot's race (so roster +
   *  console skin agree), seed teams/stashes, and mount the HUD. Returns the
   *  resolved race per slot (melee needs it for the starting roster). */
  private beginMatch(config: MeleeConfig, startGold: number, startLumber: number): Map<number, PlayableRace> {
    // Seed the match's RNG before anything can roll. The world is built at map load, when
    // the lobby's choices aren't known yet, so the seed arrives here — still ahead of unit
    // seeding, the map script and the first tick, which is the last moment it is safe.
    // Until this existed every match ran off a hardcoded 1 and rolled identically.
    this.rts!.setSeed(config.seed ?? randomSeed());
    // The campaign difficulty the player picked, before a line of the map's script runs —
    // its chapters branch on GetGameDifficulty from map init onwards. A skirmish sends none
    // and the match runs at MAP_DIFFICULTY_NORMAL, which is what the reference calls it.
    this.gameDifficulty = config.difficulty ?? 1;
    // …and whether this is a MISSION at all, which decides the two console buttons a campaign
    // has no use for (see panelDead).
    this.campaign = config.campaign === true;
    // What the Quest Log calls this match. The map's own w3i name is the default and is right
    // for every map you pick off a list; a CAMPAIGN chapter is titled by the campaign index
    // instead, because its w3i name is the file's ("NightElfX01") and nothing a player has
    // ever seen. See MeleeConfig.mapName.
    if (config.mapName) this.mapDisplayName = config.mapName;
    // Who WE are. A LAN client is told (every human slot in a shared config says "user", so
    // the fallback would seat every machine on the same player — see MeleeConfig.localPlayer).
    this.localPlayer = config.localPlayer
      ?? config.slots.find((s) => s.controller === "user")?.id
      ?? config.slots[0]?.id
      ?? 0;
    this.rts!.setLocalPlayer(this.localPlayer); // drag-box selects this player's units
    // Owner-line names for the hover tooltip.
    //
    // **The MAP's name for the slot wins.** A campaign map names every side it fields in its
    // w3i player records — "Illidan's Naga", "Wild Mur'guls", "Ferocious Beasts", "Night Elf
    // Villagers" — and that is what WC3 prints under a hovered enemy. Reading "Computer
    // (Normal)" over every one of them is a melee lobby's answer given to a mission, and it
    // erases the one thing the line is there to tell you: WHOSE that unit is.
    //
    // Only a slot the map left unnamed falls back — an AI slot to "Computer (Normal)" (the
    // one difficulty we model, matching the Custom Game screen's label), a human slot to a
    // generic "Player N". The local player never shows an owner line, so its own label is
    // never seen. Neutral and rescuable players are in this map too and only ever take the
    // map's name: nobody is playing them, so "Computer (Normal)" would be a lie about them.
    this.playerNames = new Map(
      config.slots.map((s) => [
        s.id,
        s.name?.trim() || (s.controller === "computer" ? "Computer (Normal)" : `Player ${s.id + 1}`),
      ]),
    );
    this.humanPlayers = config.slots.filter((s) => s.controller === "user").length;
    this.rts!.setPlayerNames(this.playerNames);
    // Whose placed units hold their ground (see SimUnit.guarding). Set before seeding, since
    // that is when a unit is told whether it has a post.
    this.rts!.setAiPlayers(config.slots.filter((s) => s.controller === "computer").map((s) => s.id));
    // Open on the local player's base at gameplay zoom.
    const home = config.slots.find((s) => s.id === this.localPlayer);
    if (home) {
      this.target[0] = home.startX;
      this.target[1] = home.startY;
      this.distance = this.playerDistance = MapViewerScene.MELEE_START;
      this.pitch = this.playerPitch = MapViewerScene.GAME_PITCH;
      this.zoomT = 1;
    }
    // Resolve "random" once per slot: roster and console skin must agree.
    const races = new Map(config.slots.map((s) => [s.id, resolveRace(s.race)]));
    this.localRace = races.get(this.localPlayer) ?? "human";
    this.meleeTeams = new Map(config.slots.map((s) => [s.id, s.team]));
    this.rts!.setLocalTeam(this.teamOf(this.localPlayer)); // whose combined sight lifts the fog
    // Every seat gets its own eyes NOW, with the lobby's team, rather than a grid conjured
    // mid-match the first time something asks whether that side can see. Ordered before the
    // fog-mode calls below so the match setting reaches all of them by both routes.
    this.rts!.seatPlayers(config.slots.map((s) => ({ player: s.id, team: s.team })));
    // Seed the alliance matrix from those teams (7.22) BEFORE the map script runs, so the
    // script's own SetPlayerAlliance calls land on top of it rather than under it — and seed
    // it with what the map says a force GRANTS, which on a custom map is not "everything"
    // (see MapInfo.ForceGrants). A team index IS the force index there.
    this.rts!.seedAlliances((p) => this.teamOf(p), (team) => config.forces?.[team]);
    // Fog-of-war start mode from the lobby: "explored" reveals the whole map as grey
    // terrain memory (live fog still hides current enemy movement); "revealall" drops
    // fog entirely; "unexplored" leaves the default pitch-black unseen ground.
    if (config.fog === "explored") this.rts!.exploreAll();
    else if (config.fog === "revealall") this.rts!.setRevealAll(true);
    this.applyRaceCursor();
    for (const slot of config.slots) this.rts!.simWorld.initStash(slot.id, startGold, startLumber);
    this.mountHud();
    void this.loadSelectionCircles();
    // Warm portrait busts in the background so the first selection of a unit type
    // doesn't stall a frame parsing its model (see warmPortraits). Kicked off once
    // the HUD (portrait canvas) and local race exist; re-scanned in the frame loop.
    this.warmPortraits();
    return races;
  }

  /** Standard-melee start — run from the MAP'S OWN SCRIPT (7.3; see docs/triggers.md).
   *
   *  A melee map's war3map.j carries a "Melee Initialization" trigger, and its eight calls
   *  into blizzard.j's `Melee*` library ARE the melee game: MeleeStartingVisibility (the
   *  08:00 clock), MeleeStartingHeroLimit, MeleeGrantHeroItems, MeleeStartingResources
   *  (500/150), MeleeClearExcessUnits (the creeps camped on a used start location),
   *  MeleeStartingUnits (the town hall + the five workers clumped by the nearest gold
   *  mine), MeleeStartingAI, MeleeInitVictoryDefeat. We interpret Blizzard's own code
   *  rather than reimplement it, so the rules are the game's, not our guess at them.
   *
   *  Order matters, and it's WC3's own: the map's pre-placed units exist BEFORE the init
   *  trigger runs (in WC3 main() calls CreateAllUnits first). Ours arrive with their
   *  models, asynchronously — so wait for the .doo adoption to settle, else
   *  MeleeFindNearestMine would find no mine and MeleeClearExcessUnits no creeps.
   *
   *  The old hard-coded roster survives only as a fallback for a melee-flagged map that
   *  ships no script at all (see startMeleeFallback). */

  /** Hand the LAN match's end of the wire to the controller (docs/multiplayer.md 10b-note).
   *  A plain pass-through — the scene owns the `RtsController`, and `startGame` in main.ts
   *  owns the setup; neither should reach across the other. */
  attachMatchLink(setup: MatchLinkSetup): void {
    this.rts?.attachMatchLink(setup);
    // Arm the background pump HERE, not from the frame loop: rAF is stopped in a hidden
    // window, so a host whose tab is already covered when the match starts would otherwise
    // never run the frame that starts the pump — the authority sits dead until refocused
    // (exactly how the two-tab harness kills it). The pump stands down while rAF is alive,
    // so arming it early costs nothing on a visible window.
    this.startBackgroundPump();
    // A client turns the authority's payload back into the same `DialogObj` its own script
    // would have built, so `GameDialog` renders the real screen off the game's own FDF and the
    // two engine button behaviours (any click closes; a quit button leaves) work unchanged.
    if (this.rts) {
      this.rts.onRemoteDialog = (msg) => {
        // A CLIENT never sees `RemovePlayer` for itself — its own script never runs the defeat
        // check (that is the whole of item F7) — so the authority's stamp is the only way it can
        // know its game is over, and it is what hangs up this end of the wire.
        if (msg.over && !this.matchEnded) {
          this.matchEnded = true;
          this.rts?.endMatchWire();
        }
        this.remoteDialog = {
          handleId: -1, // not the script's; nothing looks it up
          message: msg.message,
          buttons: msg.buttons.map((b, i) => ({
            handleId: -(i + 2), dialogId: -1, text: b.text, hotkey: 0, quit: b.quit, doScoreScreen: false,
          })),
          visibleFor: new Set([this.localPlayer]),
          revision: 0,
        };
      };
    }
  }

  async startMelee(config: MeleeConfig, onProgress?: (p: number) => void): Promise<void> {
    if (!this.rts || !this.viewer.map) return;
    // Resources come from the script (MeleeStartingResources), so open empty.
    const races = this.beginMatch(config, 0, 0);
    this.rts.enableSeeding(); // owners/teams configured → trySeed may adopt the map's units
    // …and the creeps/mines must all be in the sim before the script runs. This is the LONG
    // wait of the whole load — the map's art streaming in — and the only one of them the
    // browser is free to paint through, so it is what the loading bar creeps on (see
    // `startGame` in src/main.ts).
    await this.waitForMapUnits(onProgress);
    this.rts.seedModellessPlaced(); // …including the ones the renderer never delivers (dummy units)
    const engine = this.runMapScript({ melee: true, races, slots: config.slots });
    // No script (or it created nothing for the local player — a script that leans on
    // natives we haven't written yet): fall back to our own roster so the match still
    // starts, rather than dropping the player onto an empty map.
    const spawned = [...this.rts.simView.units.values()].some((u) => u.owner === this.localPlayer);
    if (!engine || !spawned) {
      console.warn(`[jass] melee init did not spawn a base (script: ${engine ? "ran" : "absent"}) — using the built-in roster.`);
      await this.startMeleeFallback(config, races);
    }
  }

  /** Melee start with no map script: our own roster, the pre-7.3 path. Kept because a
   *  melee-flagged map that ships no war3map.j (or whose script fails) must still be
   *  playable — the numbers are the same ones blizzard.j uses (src/data/races.ts). */
  private async startMeleeFallback(config: MeleeConfig, races: Map<number, PlayableRace>): Promise<void> {
    if (!this.rts) return;
    for (const slot of config.slots) this.rts.simWorld.initStash(slot.id, MELEE.MELEE_STARTING_GOLD_V1, MELEE.MELEE_STARTING_LUMBER_V1);
    // Clear the creep camps on each USED start location so bases spawn on clean ground
    // (what MeleeClearExcessUnits does from the script). Unused start locations keep theirs.
    this.rts.setStartLocationClearZones(config.slots.map((s) => ({ x: s.startX, y: s.startY })));
    for (const slot of config.slots) {
      const race = races.get(slot.id) ?? "human";
      // Nearest gold mine to the start location (blizzard.j MeleeFindNearestMine).
      // Workers cluster on the mine→hall line; the hall itself sits on the start location.
      const mine = this.nearestMine(slot.startX, slot.startY, MELEE.MELEE_MINE_SEARCH_RADIUS);
      for (const { id, count } of STARTING_UNITS[race]) {
        const def = this.registry.get(id);
        if (!def?.isBuilding) continue; // workers are placed from the authentic clusters below
        for (let i = 0; i < count; i++) await this.spawnUnit(def, slot.startX, slot.startY, slot.id, slot.team);
      }
      const clusters = MELEE_WORKER_CLUSTERS[race];
      for (const cluster of clusters) {
        const def = this.registry.get(cluster.id);
        if (!def) continue;
        const [cx, cy] = this.meleeClusterCenter(slot.startX, slot.startY, mine, cluster);
        for (const [ox, oy] of cluster.offsets) {
          await this.spawnUnit(def, cx + ox * MELEE_UNIT_SPACING, cy + oy * MELEE_UNIT_SPACING, slot.id, slot.team);
        }
      }
      // Frame the local player on their starting workers, as WC3 does (blizzard.j centres
      // the camera on the initial peasants, not the town hall).
      if (slot.id === this.localPlayer && clusters[0]) {
        const [cx, cy] = this.meleeClusterCenter(slot.startX, slot.startY, mine, clusters[0]);
        this.target[0] = cx;
        this.target[1] = cy;
      }
    }
  }

  /** Wait until every pre-placed war3mapUnits.doo unit is on the map AND adopted into the
   *  sim. WC3's equivalent is CreateAllUnits(), which completes before any trigger fires;
   *  our melee init has to see the same world — the gold mines it clumps the workers
   *  around, the creeps it clears off the start locations.
   *
   *  The wait must be on the LOADER, not on the unit list: the viewer pushes each unit
   *  into `map.units` as its model resolves, and a big map's models arrive in bursts, so
   *  "the list stopped growing" fires in the first lull — which is how a 10-player map
   *  once ran its melee init before its start-location creeps existed (they survived the
   *  clear, then ate the workers). So: unitsReady (every load dispatched) → promiseMap
   *  empty (every load resolved) → two more frames, for trySeed to adopt the stragglers.
   *  Capped, so a model that never resolves can't hang the match. */
  private waitForMapUnits(onProgress?: (p: number) => void, timeoutMs = 30000): Promise<void> {
    return this.waitForLoader(
      () => !!this.viewer.map?.unitsReady && this.viewer.promiseMap.size === 0,
      timeoutMs,
      "map units",
      onProgress,
    );
  }

  /** Poll until the loader goes quiet — `ready()` true on two CONSECUTIVE frames, because a
   *  fetch that resolves often dispatches the next one (a model's textures) and a single
   *  empty `promiseMap` is just the gap between them. Capped: a model that never resolves
   *  must not hang the match. Shared by `waitForMapUnits` and the start preload.
   *
   *  `onProgress` is fed `LoaderProgress` on every poll, which is what keeps the loading
   *  screen's bar moving through the wait rather than parked on the last milestone. */
  private waitForLoader(
    ready: () => boolean, timeoutMs: number, what: string, onProgress?: (p: number) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const drain = onProgress ? new LoaderProgress() : null;
      let settledFrames = 0;
      const poll = (): void => {
        if (drain && onProgress) onProgress(drain.sample(this.viewer.promiseMap));
        settledFrames = ready() ? settledFrames + 1 : 0;
        if (settledFrames >= 2 || performance.now() - t0 > timeoutMs) {
          if (settledFrames < 2) console.warn(`[openwar3] ${what} still streaming after ${Math.round(timeoutMs / 1000)}s — starting anyway.`);
          onProgress?.(1);
          resolve();
          return;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  }

  /**
   * Pull in what the first minutes of the match will ask for, while the loading screen is
   * still up — the last stretch of the bar, and what makes the beat at the end of the load
   * worth anything (see `startGame` in src/main.ts).
   *
   * The original does exactly this from the map's own script: `Preload` / `PreloadStart` /
   * `PreloadEnd` (common.j) exist so a map can name the art it is about to want and have the
   * engine fetch it before the mission runs, rather than hitch the frame each piece is first
   * drawn on. We have the same two costs — an `.mdx` is parsed and uploaded the first time
   * something asks for it, and an icon's `.blp` is decoded the first time a command card
   * shows it — so this fetches:
   *
   *   1. everything already in flight (the models the map's script spawned, and their
   *      textures), and
   *   2. the local player's ROSTER: what their worker builds, what those buildings train and
   *      what they upgrade into — models AND command-card icons. That is the set the opening
   *      minutes actually touch, and being one race's tech tree it is bounded.
   *
   * Portrait busts stay on the idle warmer (`warmPortraits`): they are the heaviest models
   * here and nothing is drawn with one until a unit is CLICKED, so they are not worth holding
   * the screen for.
   */
  async preloadForStart(onProgress: (p: number) => void = () => {}): Promise<void> {
    const t0 = performance.now();
    // The two halves of this are timed alike, so they take half the span each: measured on
    // `(2)EchoIsles.w3x`, the whole call is ~0.7 s of which the drain is ~0.25 s — and that is
    // with a roster the map had already spawned, which is the case that flatters the roster
    // half. Fixed shares rather than one count across both, because a queued fetch and a
    // tech-tree entry are not the same unit of work.
    const DRAIN_SHARE = 0.5;
    // Whatever the script set going — its spawns are still streaming when it returns. Reported
    // per poll rather than as one step at the end, or the bar stands still through it.
    await this.waitForLoader(
      () => this.viewer.promiseMap.size === 0, 20000, "the map's art",
      (p) => onProgress(DRAIN_SHARE * p),
    );
    const roster = this.producibleRoster();
    let done = 0;
    await Promise.all(roster.map(async (id) => {
      const def = this.registry.get(id);
      if (def?.icon) this.blpIcon(def.icon); // decodes the BLP into the icon cache, once
      if (def?.model) await this.viewer.load(def.model, this.solver).catch(() => undefined);
      onProgress(DRAIN_SHARE + ((1 - DRAIN_SHARE) * ++done) / roster.length);
    }));
    onProgress(1);
    console.info(`[openwar3] preloaded ${roster.length} ${this.localRace} unit model(s) + icons in ${Math.round(performance.now() - t0)}ms.`);
  }

  /** Everything the local player is likely to MAKE: their worker, what it builds, and what
   *  each of those buildings trains or upgrades into. The start preload fetches this set and
   *  the portrait warmer walks it — one definition of "what this player is about to need". */
  private producibleRoster(): string[] {
    const workerId = (STARTING_UNITS[this.localRace] ?? []).map((s) => s.id).find((id) => WORKERS[id]);
    const out = new Set<string>();
    if (workerId) out.add(workerId);
    for (const bid of workerId ? this.tech.builds(workerId) : []) {
      out.add(bid);
      for (const uid of this.tech.trains(bid)) out.add(uid);
      for (const uid of this.tech.upgradesTo(bid)) out.add(uid);
    }
    return [...out];
  }

  /** Debug (cheat panel): spawn a hero at the camera centre for the local player, maxed
   *  to level 6 with every skill at full rank and full mana — so a whole kit can be cast
   *  on camera for verification. Not a gameplay path; only the debug UI reaches it. */
  private async spawnTestHero(typeId: string): Promise<void> {
    const def = this.registry.get(typeId);
    if (!def || !this.rts) return;
    const world = this.rts.simWorld;
    const simId = await this.spawnUnit(def, this.target[0], this.target[1], this.localPlayer, this.teamOf(this.localPlayer));
    if (simId === null) return;
    world.setHeroLevel(simId, 6);
    const u = world.units.get(simId);
    if (!u) return;
    for (const ab of u.abilities) {
      const ad = this.abilities.get(ab.id);
      if (ad) world.setAbilityLevel(simId, ab.id, ad.levels); // max every learnable/innate spell
    }
    u.mana = u.maxMana;
    this.rts.selectSingle(simId);
  }

  /** Nearest gold mine to (x, y) within `radius`, or null (blizzard.j
   *  MeleeFindNearestMine). The mine anchors the starting-worker clump. */
  private nearestMine(x: number, y: number, radius: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestD = radius * radius;
    for (const m of this.rts?.simView.mines.values() ?? []) {
      const d = (m.x - x) ** 2 + (m.y - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = { x: m.x, y: m.y };
      }
    }
    return best;
  }

  /** Centre of a starting-worker clump (blizzard.j MeleeGetProjectedLoc): `dist`
   *  world units out from the cluster's anchor (mine or hall) toward the other.
   *  With no mine on the map, fall back to blizzard's no-mine spot: 224u south of
   *  the hall (workers then clump there instead of by a nonexistent mine). */
  private meleeClusterCenter(
    sx: number,
    sy: number,
    mine: { x: number; y: number } | null,
    cluster: WorkerCluster,
  ): [number, number] {
    if (!mine) return [sx, sy - 224];
    const anchor = cluster.anchor === "mine" ? mine : { x: sx, y: sy };
    const toward = cluster.toward === "mine" ? mine : { x: sx, y: sy };
    const dir = Math.atan2(toward.y - anchor.y, toward.x - anchor.x);
    return [anchor.x + cluster.dist * Math.cos(dir), anchor.y + cluster.dist * Math.sin(dir)];
  }

  /** Custom / scenario / game-mode start (maps NOT flagged melee). Such a map sets
   *  up its own game — starting units, heroes, resources, regions, win conditions —
   *  from its own triggers (war3map.j). Unlike a melee map we do NOT inject the
   *  town-hall-and-workers roster (that was the old always-melee bug on scenario
   *  maps). Instead (issue #33 / Phase 7):
   *   1. Adopt the map's pre-placed PLAYER units as OWNED, simulated units, so the
   *      local player has vision of and control over their own units (the reported
   *      "no vision of our own units on custom maps" bug) instead of a black map.
   *   2. Run the map's own config() through our JASS interpreter (src/jass/) — the
   *      first live use of the trigger engine on the real script. Best-effort: a
   *      script problem must never abort the match. */
  async startCustom(config: MeleeConfig, onProgress?: (p: number) => void): Promise<void> {
    if (!this.rts || !this.viewer.map) return;
    // Custom maps get their starting resources from triggers (not the melee default),
    // so seed empty stashes; the map's own script grants gold/lumber where it wants.
    this.beginMatch(config, 0, 0);

    // (The map's custom object data is already in — loadMap installs it the moment the
    // archive is opened, so the pre-placed .doo pass and the pathing/ubersplat stamps see
    // the map's own types too. See the note there.)

    // Seed the pre-placed player units OWNED. Team comes from teamOf(owner), so the
    // local player's units share the local team and lift the fog (updateVision keys
    // on team); other slots' units exist too but stay fogged like any other player.
    const seeds = this.mapPlayerUnits.map((p) => ({ x: p.x, y: p.y, owner: p.owner, team: this.teamOf(p.owner) }));
    this.rts.setPlayerUnitSeeds(seeds);

    // The map's units must ALL be in the sim before its script runs — WC3's own order
    // (main() calls CreateAllUnits before InitCustomTriggers), and the same wait startMelee
    // already does. Custom maps skipped it, and the whole world the script talks to was
    // therefore empty when it talked to it. Two consequences, both of them bugs we shipped:
    //
    //   • A pre-placed unit's `gg_unit_*` handle bound to NOTHING. CreateUnit inside
    //     CreateAllUnits only records its row (the unit is already on the map, .doo-adopted)
    //     and binds the handle to the unit standing at (x, y) — but there was no unit
    //     standing anywhere yet, so every handle came back with simId -1. WarChasers then
    //     asks the camera to ride one (`SetCameraTargetControllerNoZForPlayer(Player(0),
    //     gg_unit_ewsp_0006, …)` — the player's selector wisp) and removes the wisps of the
    //     slots nobody is playing (`RemoveUnit(gg_unit_ewsp_0007)`); both fell on the floor.
    //
    //   • The enter-region baseline (7.4b) was seeded from an EMPTY world. Units already
    //     inside a rect when its trigger registers must never fire it — in WC3 they can't,
    //     because they exist first. Ours streamed in afterwards, so every pre-placed unit
    //     standing in a watched rect counted as ENTERING it. On WarChasers that is not
    //     cosmetic: each hero pedestal is a rect holding a Circle of Power and a display
    //     statue, both Neutral Passive, and the Robo-X pedestal's trigger carries no
    //     "is it a wisp?" condition — so the two of them each spawned a hero for player 15
    //     on the players' shared hero spawn.
    // Hold the world still until the script has initialised: the wait below is real time, and
    // a map whose init has not run yet must not be simulated through it (see holdWorld).
    this.rts.holdWorld(true);
    this.rts.enableSeeding(); // owners/teams configured → trySeed may adopt the map's units
    await this.waitForMapUnits(onProgress); // …and every one of them must be adopted before the script runs
    // A dummy unit never arrives through the renderer at all, and on a custom map it is often
    // load-bearing — Extreme Candy War's cinematic vision pair is the whole reason its intro
    // is visible. Seed those from the .doo before the script runs, like everything else.
    const dummies = this.rts.seedModellessPlaced();

    // Run the map's own script (Phase 7). config() sets players/start-locations;
    // main() fires the map's initialization triggers, so its welcome text / quest
    // messages appear in the HUD message log.
    this.runMapScript({ melee: false, slots: config.slots });
    this.rts.holdWorld(false); // the map has had its say — let the world run
    console.info(`[openwar3] Custom map: ${seeds.length} pre-placed player unit(s) seeded owned (issue #33)${dummies ? `, plus ${dummies} model-less dummy unit(s)` : ""}.`);
  }

  /** The engine bridge the JASS interpreter calls into. A script `CreateUnit` inside
   *  CreateAllUnits only records its row (those units are already on the map, adopted from
   *  war3mapUnits.doo — the gate lives in the runtime now: Runtime.recordOnlySpawnFns);
   *  every other CreateUnit spawns for real. Only the LOCAL player's messages reach the
   *  HUD — the BJ force helpers already gate on GetLocalPlayer, so a per-player loop won't
   *  spam duplicates. */
  /**
   * The names of the hook entries that WRITE THE WORLD (docs/multiplayer.md item 7b).
   *
   * Computed from the same factories `textHooks` spreads, not transcribed — so it cannot drift
   * from the table it describes, and a native moved into `simHooks` tomorrow is refused inside
   * a `GetLocalPlayer` gate without anyone remembering to add it here. The two DUAL-WRITERS
   * (`setUnitOwner`, `setUnitFlyHeight`) are in this set and belong in it: their world half is
   * exactly what must not run N times.
   */
  private worldWritingHookNames(): string[] {
    return Object.keys(this.rts?.worldHooks((p) => this.teamOf(p)) ?? {});
  }

  /**
   * The hooks that write THE VIEW IN FRONT OF THE PERSON AT THIS MACHINE.
   *
   * A set of their own because the interpreter has to be able to refuse them. A
   * `GetLocalPlayer` gate is re-run once per recipient (item 7b), and every hook below acts on
   * the one screen that is actually here — so letting them through in a pass evaluated as
   * somebody else means the LAST recipient silently wins. That is not hypothetical: blizzard.j
   * calls `SetCameraPositionForPlayer` once per player at every melee start, so a two-player
   * match opened both machines on the last seat's base and the host spent the opening seconds
   * looking at an empty enemy island (docs/multiplayer.md Phase F item 3).
   *
   * Only WRITERS. The camera readers stay in `textHooks` — see the note there.
   *
   * `localViewHookNames()` is `Object.keys` of this, so the refusal list is computed from the
   * table it describes and cannot drift from it — the same discipline `worldWritingHookNames`
   * follows.
   */
  private localViewHooks(): Partial<EngineHooks> {
    return {
      // --- cameras + cinematics (7.24) ---
      // Every camera MOVE is one call: the script names fields and (maybe) a destination,
      // and ScriptCamera blends the live camera there. It used to say here that the …ForPlayer
      // BJs had already gated on GetLocalPlayer so anything arriving was for the human at this
      // machine — that stopped being true the day a gate began re-running per recipient, and
      // the refusal above is what makes it true again.
      // read → mutate → WRITE BACK. A zero-duration move lands NOW (see ScriptCamera.apply),
      // and the very next line of Monolith's trigger reads the camera straight back through
      // ResetToGameCamera — it must see the shot the line before it just applied.
      applyCamera: (move) => {
        const cam = this.readCamera();
        this.scriptCam.apply(move, cam);
        this.writeCamera(cam);
      },
      setCameraTargetUnit: (id, xOff, yOff) => {
        this.cameraLock = false; // the script's controller replaces the portrait's follow-lock
        this.groupFollow = false; // …and the held hotkey's, which follows the same way
        this.scriptCam.setTargetUnit(id, xOff, yOff);
      },
      resetToGameCamera: (duration) => this.scriptCam.resetToGameCamera(duration, this.readCamera()),
      stopCamera: () => this.scriptCam.stop(),
      cameraRotateMode: (x, y, radians, duration) => this.scriptCam.setRotateMode(x, y, radians, duration, this.readCamera()),
      setCameraNoise: (source, mag, vel, vertOnly) => this.scriptCam.setNoise(source, mag, vel, vertOnly),
      // ShowInterface(false) is the letterbox: the console goes, the bars come in.
      showInterface: (show, fade) => {
        this.interfaceShown = show;
        this.cinematic?.setLetterbox(!show, fade);
        this.syncHudVisible();
      },
      enableUserControl: (enable) => {
        this.userControl = enable;
        if (!enable) {
          this.rts?.clearSelection(); // a cinematic runs with nothing selected, as in WC3
          this.rts?.clearHover(); // …and with nothing lit up under the cursor either
          this.hud?.clearOrderMode();
          this.keys.clear(); // a key held when control was taken must not pan on resume
        }
      },
      displayCineFilter: (filter) => this.cinematic?.setFilter(filter),
      setCinematicScene: (scene) => {
        this.cinematic?.setScene(scene);
        // Ask for the bust the CURRENT scene wants, every time — never on a "did it change?"
        // answer from the panel. See loadCinematicPortrait and CinematicPanelOverlay.setScene.
        void this.loadCinematicPortrait(scene?.portraitUnitId ?? "", scene?.playerColor ?? 0, scene?.voiceoverDuration ?? 0);
      },
      pingMinimap: (ping) => this.hud?.ping(ping),
      // --- melee from the script (7.3) ---
      // MeleeStartingUnits* frames the view on the starting WORKERS, not the hall.
      setCameraPosition: (x, y) => {
        this.target[0] = x;
        this.target[1] = y;
      },
    };
  }

  /** The names of the hook entries that write THIS MACHINE'S SCREEN — `Object.keys` of the
   *  table itself, so it cannot drift (see `localViewHooks`). */
  private localViewHookNames(): string[] {
    return Object.keys(this.localViewHooks());
  }

  private textHooks(): EngineHooks {
    // The world/authority half, built once so the two DUAL-WRITER natives below can call back
    // into it. `SetUnitOwner` and `SetUnitFlyHeight` each write the world AND the model, and the
    // model half only exists here — so the renderer decorates those two rather than replacing
    // them, and the world write happens exactly once either way.
    const world = this.rts?.worldHooks((p) => this.teamOf(p)) ?? {};
    return {
      // The non-presentation half of the table — every native whose answer comes from the world
      // (src/game/jassHooks.ts `simHooks`) or from the authority (`authorityHooks`). The
      // controller composes both, because it is the only object holding both and neither the
      // world nor the authority should have to be handed out to build a table.
      //
      // Spread FIRST so the presentation entries below win any overlap, which is how the two
      // natives that write both halves (setUnitFlyHeight, setUnitOwner) keep their renderer
      // bodies.
      //
      // The guard is the one behavioural difference: each moved entry used to be `this.rts?.…`,
      // re-checked on every call, and is now bound once when the table is built. `runMapScript`
      // runs long after `RtsController` is constructed — a map script cannot execute before the
      // world it mutates exists — so the null branch is unreachable in practice; when it is
      // taken, the natives fall back to their own defaults instead of silently no-opping.
      ...world,
      // `duration` is seconds (timed action) or < 0 (untimed) — showMessage handles both.
      displayText: (player, msg, duration) => {
        if (player === this.localPlayer) this.hud?.showMessage(msg, duration);
      },
      clearText: (player) => {
        if (player === this.localPlayer) this.hud?.clearMessages();
      },
      // GetObjectName / GetUnitName resolve rawcodes to their real data-table names. A
      // rawcode can name a unit, an ability ('AHhb' — what GetSpellAbilityId hands back)
      // or an item, so try each registry: "Paladin cast Holy Light on Peasant" needs all
      // three (the custom overlays are checked first inside each `get`).
      objectName: (typeId) => this.registry.get(typeId)?.name ?? this.abilities.get(typeId)?.name ?? this.items.get(typeId)?.name,
      // --- destructibles (issue #85): a gate opens by dying ---
      // Presentation-side because the map's destructibles ARE renderer state: the .doo records
      // it drew, the footprints it stamped, and the stand-in instances that play their clips.
      findDestructable: (typeId, x, y) => findDestructibleAt(this.destructibles, typeId, x, y)?.id ?? 0,
      destructableInfo: (id) => this.destructibleSnapshot(id),
      killDestructable: (id, clip) => this.killDestructible(id, clipRe(clip)),
      restoreDestructable: (id, life, birth) => this.restoreDestructible(id, life, birth),
      setDestructableLife: (id, life) => this.setDestructibleLife(id, life),
      setDestructableAnimation: (id, name) => this.setDestructibleAnimation(id, name),
      removeDestructable: (id) => this.removeDestructible(id),
      showDestructable: (id, show) => this.showDestructible(id, show),
      enumDestructables: (minX, minY, maxX, maxY) =>
        this.destructibles
          .filter((d) => d.x >= minX && d.x <= maxX && d.y >= minY && d.y <= maxY)
          .map((d) => this.snapshotOf(d)),
      // --- the trigger's on-screen output (7.19) ---
      // GetLocalizedString → the game's own GlobalStrings.fdf table. Not cosmetic: the
      // melee victory/defeat dialog is written entirely in its keys, so without this the
      // player would be shown "GAMEOVER_VICTORY_MSG" instead of "Victory!".
      localizedString: (key) => this.globalStrings?.strings.get(key),
      // The quit button of the victory/defeat dialog. `doScoreScreen` asks for WC3's
      // post-game score screen (Glue\ScoreScreen.fdf) — we don't build one yet, so both
      // paths simply leave the match.
      endGame: () => {
        this.showDialog(null);
        this.paused = false;
        this.onExit?.();
      },
      // RemovePlayer(p, PLAYER_GAME_RESULT_*) — blizzard.j's own "this player's game is over",
      // called by CustomVictoryBJ/CustomDefeatBJ before either of them shows anything. Recorded
      // rather than acted on HERE: the wire must not close until the dialog relay below has run,
      // or the loser would never be handed the screen that says why (Phase G item 1).
      playerGameOver: (player, result) => {
        // `Scripts\common.j`, verified in War3.mpq AND War3x.mpq (identical):
        //   PLAYER_GAME_RESULT_VICTORY = 0, _DEFEAT = 1, _TIE = 2, _NEUTRAL = 3
        // DEFEAT is the ONLY one that leaves the match running — victory is declared in melee
        // only when every opponent is out, and a tie or a neutral game-over ends it outright.
        // So the test is written as "anything but defeat", not as "equals victory": a tie that
        // left the wire up would leave it up forever.
        const PLAYER_GAME_RESULT_VICTORY = 0;
        const PLAYER_GAME_RESULT_DEFEAT = 1;
        if (result !== PLAYER_GAME_RESULT_DEFEAT) this.matchDecided = true;
        // A campaign chapter is "completed" exactly when its own script declares the local
        // player the winner — the same signal, read for a different reason.
        if (result === PLAYER_GAME_RESULT_VICTORY && player === this.localPlayer) this.onLocalVictory?.();
      },
      pauseGame: (flag) => (this.paused = flag),
      // EnableUserUI hides EVERYTHING, interface and all — blizzard.j calls it before each
      // cinematic fade (the filter covers the world, not the UI, so the UI has to go). It is
      // a different switch from ShowInterface's letterbox, and the HUD needs both to be on.
      enableUserUi: (flag) => {
        this.userUi = flag;
        this.syncHudVisible();
      },
      // --- the trigger's AUDIO output (7.20) ---
      // A sound LABEL is how a map names volume/pitch/3D/distances without re-typing them;
      // the SoundBoard searches every UI\SoundInfo table for it. This one hook is what
      // SetSoundParamsFromLabel and CreateSoundFromLabel both stand on — including
      // blizzard.j's victory/defeat stings (CreateSoundFromLabel("QuestCompleted", …)).
      soundLabelInfo: (label) => this.sounds?.labelParams(label) ?? null,
      playSound: (s) =>
        this.sounds?.playScript(s.handleId, {
          file: s.file,
          volume: s.volume,
          pitch: s.pitch,
          looping: s.looping,
          is3D: s.is3D,
          // A 3D sound with no position never got one (no SetSoundPosition, no attached
          // unit) — WC3 plays it flat rather than at the world origin, so pass null.
          at: s.is3D && s.positioned ? { x: s.x, y: s.y, z: s.z } : null,
          minDist: s.minDist,
          maxDist: s.maxDist,
          cutoff: s.cutoff,
          coneInside: s.coneInside,
          coneOutside: s.coneOutside,
          coneOutsideVolume: s.coneOutsideVolume,
          coneOrient: s.coneOrient,
        },
        // The clip's first sample is going out NOW — which is when the line actually began,
        // and therefore what `TriggerWaitForSound` has to measure from (see SoundObj.pending).
        // Reading the archive and decoding it took however long it took.
        () => {
          s.pending = false;
          const rt = this.mapScript?.interp.rt;
          if (rt) s.startedAt = rt.gameTime;
        }) ?? false,
      stopSound: (id, fadeOut) => this.sounds?.stopScript(id, fadeOut),
      soundIsPlaying: (id) => this.sounds?.isScriptPlaying(id) ?? false,
      moveSound: (id, x, y, z) => this.sounds?.moveScript(id, { x, y, z }),
      soundFileDuration: (file) => this.sounds?.fileDurationMs(file) ?? 0,
      setMapMusic: (name, random, index) => this.sounds?.setMapMusic(name, random, index),
      clearMapMusic: () => this.sounds?.clearMapMusic(),
      playMusic: (name, fromMs, fadeInMs) => this.sounds?.playMusic(name, fromMs, fadeInMs),
      stopMusic: (fadeOut) => this.sounds?.stopMusic(fadeOut),
      resumeMusic: () => this.sounds?.resumeMusic(),
      playThematicMusic: (name, fromMs) => this.sounds?.playThematicMusic(name, fromMs),
      endThematicMusic: () => this.sounds?.endThematicMusic(),
      setMusicVolume: (v) => this.sounds?.setMusicVolume(v),
      setVolumeGroup: (group, scale) => this.sounds?.setVolumeGroup(group, scale),
      resetVolumeGroups: () => this.sounds?.resetVolumeGroups(),
      // --- unit-mutation effects (7.7 cont.) — a trigger visibly moves/alters a unit ---
      // SetUnitOwner: reassign in the sim (team decides allegiance/vision), then re-tint
      // the team-coloured model parts to the new slot's colour if changeColor is set.
      // DUAL-WRITER: the reassignment is `world`'s (and the only half a headless host has);
      // this entry adds the re-tint, which needs a model.
      setUnitOwner: (id, player, changeColor) => {
        world.setUnitOwner?.(id, player, changeColor);
        // …to the new owner's COLOUR, which is not the new owner's SLOT. Every campaign map
        // reassigns both: Rise of the Naga paints slot 0 blue (`SetPlayerColorBJ`) in its
        // init and then hands the player its rescued prisoners with
        // `SetUnitOwner(u, udg_AP1_Player, true)` — passing the slot re-tinted each of them
        // RED, the default colour of a slot nobody had recoloured, so a freed Huntress came
        // out a colour no unit on the field wore. Same lookup the spawner uses (playerColor).
        if (changeColor) this.rts?.setUnitTeamColor(id, this.rts.playerColor(player));
      },
      setUnitColor: (id, color) => this.rts?.setUnitTeamColor(id, color),
      setPlayerColor: (p, color) => this.rts?.setPlayerColor(p, color),
      setPlayerNeutral: (p, neutral) => this.rts?.setPlayerNeutral(p, neutral),
      setUnitScale: (id, scale) => this.rts?.setUnitScale(id, scale),
      setUnitVertexColor: (id, r, g, b, a) => this.rts?.setUnitVertexColor(id, r, g, b, a),
      // Fly height lives in two places: the sim (missile launch/land Z) and the render lift.
      // DUAL-WRITER, same shape as setUnitOwner above — `world` writes the sim, this adds the lift.
      setUnitFlyHeight: (id, height) => {
        world.setUnitFlyHeight?.(id, height);
        this.rts?.setUnitFlyHeight(id, height);
      },
      setUnitTimeScale: (id, scale) => this.rts?.setUnitTimeScale(id, scale),
      selectedUnits: (player) => (player === this.localPlayer ? this.rts?.selectedUnitIds() ?? [] : []),
      selectUnit: (id, select) => this.rts?.scriptSelect(id, select),
      clearSelection: () => this.rts?.clearSelection(),
      // IsUnitAlly/IsUnitEnemy: team-based, so neutral hostile (team -1) is nobody's ally.
      // --- the atmospheric distance haze — a DIFFERENT system (7.22) ---
      // Replaces the map's w3i fog on `scene.distFog` (read fresh each frame, so this
      // lands next frame with no extra plumbing). Our shader is linear, which is all the
      // corpus asks for: every SetTerrainFogEx call in all 165 maps passes style 0.
      setTerrainFog: (_style, zstart, zend, _density, r, g, b) => {
        this.mapFog = makeMapFog(zstart, zend, r, g, b);
      },
      resetTerrainFog: () => {
        this.mapFog = this.w3iFog;
      },
      // --- weather: the map's atmosphere (7.23) ---
      addWeatherEffect: (effectId, area) => {
        this.weatherDefs ??= loadWeatherRegistry(this.vfs);
        const def = this.weatherDefs.get(effectId);
        if (!def || !this.weather) return -1; // not a weather type we know — the map runs on
        return this.weather.add(def, area);
      },
      enableWeatherEffect: (id, on) => this.weather?.enable(id, on),
      removeWeatherEffect: (id) => this.weather?.remove(id),
      // --- special effects: the trigger puts a model in the world (7.26 — issue #68) ---
      addSpecialEffect: (path, x, y) => this.addSpecialEffect(path, x, y),
      addSpecialEffectTarget: (path, unitId, attach) => this.addSpecialEffectTarget(path, unitId, attach),
      destroyEffect: (id) => this.destroySpecialFx(id),
      // --- cameras + cinematics (7.24) ---
      // The WRITERS live in `localViewHooks` — see there for why they are a set of their own.
      ...this.localViewHooks(),
      // The camera READERS stay here: they answer a question rather than change a picture, and
      // a muzzled reader would take a different BRANCH in a per-recipient pass, not just skip
      // a move. `GetCameraTargetPositionX` must answer the same thing whoever is being
      // evaluated — it is a fact about this machine's camera either way.
      cameraField: (field) => {
        const cam = this.readCamera();
        return [cam.distance, cam.farZ, cam.aoaDeg, cam.fovDeg, cam.rollDeg, cam.rotationDeg, cam.zOffset][field] ?? 0;
      },
      cameraTarget: () => ({ x: this.target[0], y: this.target[1], z: this.target[2] }),
      cameraEye: () => {
        const cp = Math.cos(this.pitch);
        return {
          x: this.target[0] - Math.cos(this.yaw) * cp * this.distance,
          y: this.target[1] - Math.sin(this.yaw) * cp * this.distance,
          z: this.target[2] + Math.sin(this.pitch) * this.distance,
        };
      },
      cameraBounds: () => {
        const b = this.mapBounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
      },
      // SetGameSpeed is RECORDED, not applied: WC3's five speeds are engine constants that
      // live in no data file we have, and guessing a multiplier would be exactly the kind of
      // invented number CLAUDE.md forbids. Recording it is still load-bearing — cinematic
      // mode saves GetGameSpeed on the way in and restores it on the way out, so a lying
      // getter would leave the map running at cinematic speed forever.
      setGameSpeed: (speed) => {
        this.gameSpeed = speed;
      },
      getGameSpeed: () => this.gameSpeed,
      // The campaign difficulty is the LOBBY's (the campaign screen's dropdown), so it is set
      // at match start and read back here; blizzard.j's "Reduce Difficulty" writes it too.
      setGameDifficulty: (difficulty) => {
        this.gameDifficulty = difficulty;
      },
      getGameDifficulty: () => this.gameDifficulty,
      // --- animation (7.17) — a model's, not the world's, so it stays with the renderer ---
      setUnitAnimation: (id, animation) => this.rts?.setUnitAnimation(id, animation),
      // --- items (7.18) ---
      // The item natives themselves moved to jassHooks.ts (the sim owns the item system).
      // These two stayed: both read the ItemRegistry — a DATA table with the custom .w3t
      // overlay applied — rather than world state.
      itemTypeInfo: (typeId) => {
        const d = this.items.get(typeId); // the ItemRegistry (custom .w3t overlay first)
        return d ? { name: d.name, level: d.level, classType: d.classType, powerup: d.powerup, sellable: d.sellable, pawnable: d.pawnable } : null;
      },
      // ChooseRandomItem(Ex): draw from the registry's random-drop pool. The RNG is the
      // interpreter's seeded one, so the pick stays deterministic (replays / future MP).
      chooseRandomItem: (classType, level) => this.mapScript?.interp.rt.random
        ? this.items.chooseRandom(classType, level, this.mapScript.interp.rt.random)?.id ?? ""
        : "",
    };
  }








  /** Merge the map's custom object data (war3map.w3u units + war3map.w3a abilities)
   *  into the registry overlays (Phase 7 — issue #33). Best-effort: a missing/bad file
   *  just means the map runs with base-game types only. Clears prior overlays first. */
  private loadMapObjectData(): void {
    this.registry.clearCustom();
    this.abilities.clearCustom();
    this.items.clearCustom();
    this.upgrades.clearCustom();
    this.tech.clearCustom();
    if (!this.mapArchive) return;
    const wts = this.mapArchive.rawBytes("war3map.wts") ?? this.mapArchive.rawBytes("war3map\\wts") ?? undefined;
    const w3u = this.mapArchive.rawBytes("war3map.w3u") ?? this.mapArchive.rawBytes("war3map\\w3u") ?? undefined;
    const w3a = this.mapArchive.rawBytes("war3map.w3a") ?? this.mapArchive.rawBytes("war3map\\w3a") ?? undefined;
    const w3t = this.mapArchive.rawBytes("war3map.w3t") ?? this.mapArchive.rawBytes("war3map\\w3t") ?? undefined;
    const w3q = this.mapArchive.rawBytes("war3map.w3q") ?? this.mapArchive.rawBytes("war3map\\w3q") ?? undefined;
    try {
      if (w3u) console.info(`[jass] custom object data: ${applyMapUnitData(this.registry, w3u, wts)} custom unit type(s) (war3map.w3u).`);
    } catch (err) {
      console.warn("[jass] custom unit data failed (non-fatal):", err);
    }
    try {
      const meta = this.vfs.rawBytes("Units\\AbilityMetaData.slk");
      if (w3a && meta) console.info(`[jass] custom object data: ${applyMapAbilityData(this.abilities, w3a, meta, wts)} custom abilit(ies) (war3map.w3a).`);
    } catch (err) {
      console.warn("[jass] custom ability data failed (non-fatal):", err);
    }
    try {
      if (w3t) console.info(`[jass] custom object data: ${applyMapItemData(this.items, w3t, wts)} custom item(s) (war3map.w3t).`);
    } catch (err) {
      console.warn("[jass] custom item data failed (non-fatal):", err);
    }
    try {
      const meta = this.vfs.rawBytes("Units\\UpgradeMetaData.slk");
      if (w3q && meta) console.info(`[jass] custom object data: ${applyMapUpgradeData(this.upgrades, w3q, meta, wts)} custom upgrade(s) (war3map.w3q).`);
    } catch (err) {
      console.warn("[jass] custom upgrade data failed (non-fatal):", err);
    }
    // …and the map's own TECH TREE, which is what a building's command card is BUILT from
    // (`Trains`, `Sellunits`, `Sellitems`, `Researches`, `Builds`, `Upgrade`, `Requires`).
    // One call over all four files because one graph covers all four id spaces — see
    // applyMapTechData. Without it every building a custom map declares comes up with an
    // EMPTY card, which is exactly what "WTii's Unit Tester" showed.
    if (w3u || w3t || w3a || w3q) {
      const nodes = applyMapTechData(this.tech, { w3u, w3t, w3a, w3q }, wts);
      console.info(`[jass] custom object data: ${nodes} map tech-tree node(s) (Trains/Sell*/Researches/Builds/Requires).`);
    }
  }

  /** Run the map's config() + main() through the JASS interpreter (Phase 7 — issue #33).
   *  On a MELEE map that's the whole start: main() fires the map's "Melee Initialization"
   *  trigger, whose eight Melee* calls spawn the bases, set the purse, clear the start-
   *  location creeps and arm the victory conditions (7.3). On a custom map it fires the
   *  map's own init triggers (welcome text, quests, spawns).
   *
   *  The lobby is handed over between config() and main() (Runtime.applyLobby): which slots
   *  are PLAYING, as which race — the melee library asks for exactly that, and config()
   *  can't know it. Best-effort and non-fatal: a script error is swallowed so the match
   *  continues. Returns the running engine, or null if the map ships no script. */
  private runMapScript(opts: { melee: boolean; races?: Map<number, PlayableRace>; slots: SlotConfig[] }): MapScriptEngine | null {
    if (!this.mapArchive) return null;
    try {
      const lobby = {
        slots: opts.slots.map((s) => ({
          index: s.id,
          raceIndex: RACE_INDEX[opts.races?.get(s.id) ?? resolveRace(s.race)],
          // common.j: MAP_CONTROL_USER = ConvertMapControl(0), _COMPUTER = 1 (NOT 1 and 2 —
          // we had it off by one, so `GetPlayersByMapControl(MAP_CONTROL_USER)` built an
          // EMPTY force and every GUI "for each user player" loop silently did nothing.
          // config() had already set the right value; applyLobby was overwriting it. Found
          // by 7.24: Monolith runs its whole intro cinematic inside one of those loops.)
          // A neutral/rescuable player keeps what the MAP made it: applyLobby writes this over
          // whatever config() set, so handing it USER would undo the map's own
          // SetPlayerController(p, MAP_CONTROL_NEUTRAL) an instant after it ran.
          controller: MAP_CONTROL_FOR[s.controller],
          team: s.team,
          startLocation: -1, // config()'s SetPlayerStartLocation already placed each slot
        })),
        localPlayer: this.localPlayer,
      };
      const engine = loadMapScript(this.vfs, this.mapArchive, {
        melee: opts.melee,
        runMain: true,
        hooks: this.textHooks(),
        worldWritingHooks: this.worldWritingHookNames(),
        localViewHooks: this.localViewHookNames(),
        lobby,
        // Publish the engine BEFORE config()/main() run: a hook fired during init may need
        // the interpreter itself (ChooseRandomItem draws from its seeded RNG — 7.18).
        onBoot: (e) => { this.mapScript = e; },
      });
      if (!engine) return null;
      this.mapScript = engine; // pumped each tick (timers + region + death/damage/attack events — 7.4b/c)
      this.syncEventCaptures(engine);
      const s = engine.setup;
      const trigs = engine.interp.rt.triggerRegs.length;
      console.info(
        `[jass] config()+main() ran — ${s.players.size} players, ${s.startLocations.size} start locations, ` +
          `${trigs} event registration(s) (Phase 7 trigger engine).`,
      );
      return engine;
    } catch (err) {
      console.warn("[jass] map script failed (non-fatal):", err);
      return null;
    }
  }

  /** Tell the sim which events to record — only the kinds the script actually listens for,
   *  so a map with no death/damage/attack/order triggers pays nothing. Event indices from
   *  common.j: DEATH 53/20, DAMAGED 52, ATTACKED 62/18, ISSUED-order 38–40 (player) / 75–77
   *  (unit), CONSTRUCT 26–28 / 64–65, TRAIN 32–34 / 69–71, HERO level+skill 41–42 / 78–79,
   *  SPELL 272–276 / 289–293. Re-run whenever the registration list grows: a trigger thread
   *  that's sleeping on a `Wait` (7.15) can register new events when it resumes, long after
   *  main() returned. */
  private syncEventCaptures(engine: MapScriptEngine): void {
    if (!this.rts) return;
    const rt = engine.interp.rt;
    const idx = (r: { params: unknown[] }): number => (r.params[1] ? rt.enumIndex(r.params[1] as never) : -1);
    const sw = this.rts.simWorld;
    /** Does any registration watch an event in [lo, hi] of the given kind? */
    const any = (kind: string, lo: number, hi = lo): boolean =>
      rt.triggerRegs.some((r) => r.kind === kind && idx(r) >= lo && idx(r) <= hi);
    sw.captureDeaths = rt.triggerRegs.some((r) => r.kind === "unitDeath") || any("unitEvent", 53) || any("playerUnitEvent", 20);
    sw.captureDamage = any("unitEvent", 52);
    sw.captureAttacks = any("unitEvent", 62) || any("playerUnitEvent", 18);
    sw.captureOrders = any("playerUnitEvent", 38, 40) || any("unitEvent", 75, 77);
    sw.captureConstruct = any("playerUnitEvent", 26, 28) || any("unitEvent", 64, 65);
    sw.captureTrain = any("playerUnitEvent", 32, 34) || any("unitEvent", 69, 71);
    sw.captureHeroEvents = any("playerUnitEvent", 41, 42) || any("unitEvent", 78, 79);
    sw.captureSpells = any("playerUnitEvent", 272, 276) || any("unitEvent", 289, 293);
    // 7.18 — items: DROP/PICKUP/USE are contiguous (48–50 player / 85–87 unit); SELL_ITEM
    // is 271 / 288.
    sw.captureItems = any("playerUnitEvent", 48, 50) || any("unitEvent", 85, 87)
      || any("playerUnitEvent", 271) || any("unitEvent", 288);
    // LOADED — 51 player / 88 unit. A campaign harbour scene is the case: the ship leaves the
    // moment its passenger is aboard, and it is a unit-scoped registration on the PASSENGER.
    sw.captureLoads = any("playerUnitEvent", 51) || any("unitEvent", 88);
    // SELECTED / DESELECTED — 24/25 player, 57/58 unit. Not a sim capture: a selection is
    // not world state, so the RTS diffs its own (see RtsController.drainSelectionEvents) and
    // this flag only decides whether we bother asking.
    this.scriptWatchesSelection = any("playerUnitEvent", 24, 25) || any("unitEvent", 57, 58);
    // EVENT_UNIT_STATE_LIMIT is polled, not raised by the sim (see pumpUnitStates).
    this.scriptWatchesUnitState = rt.triggerRegs.some((r) => r.kind === "unitState");
    this.scriptRegCount = rt.triggerRegs.length;

    // A creep whose DEATH the script watches drops its loot through the SCRIPT, not through
    // us. The World Editor compiles each creep's dropped-item table out of war3mapUnits.doo
    // and into war3map.j as a `Unit000NN_DropItems` death trigger (Echo Isles ships 24 of
    // them) — so we were rolling the .doo table AND the script was rolling the same table,
    // and every creep camp dropped twice the loot it should. The script's copy is the one
    // that counts: it goes through Blizzard.j's UnitDropItem, which also tells
    // UpdateStockAvailability what this map's creeps can drop — and that, and only that, is
    // what a Marketplace ever stocks from.
    for (const r of rt.triggerRegs) {
      if (r.kind !== "unitEvent" || idx(r) !== 53) continue; // EVENT_UNIT_DEATH
      const u = rt.data<{ simId: number }>(r.params[0] as never);
      if (u && u.simId >= 0) sw.clearUnitDrops(u.simId);
    }
  }

  /** Drive the running map script from the sim tick (Phase 7 — 7.4b/c): advance its
   *  timers, resume any trigger thread whose Wait has run out (7.15), and pump
   *  enter/leave-region + unit-death events. Best-effort — a throwing trigger is swallowed
   *  inside the interpreter, but wrap the whole pump too so one bad tick can't kill the
   *  frame loop. `dt` is seconds (the clamped sim step). */
  private pumpMapScript(dt: number): void {
    const engine = this.mapScript;
    if (!engine || !this.rts) return;
    try {
      engine.interp.advanceTime(dt); // timers + trigger threads (waits) — 7.4a/7.15
      // A resumed thread (or any live trigger) may have registered new events — re-derive
      // what the sim needs to record if the registration list changed.
      if (engine.interp.rt.triggerRegs.length !== this.scriptRegCount) this.syncEventCaptures(engine);
      // Combat events this tick (7.4c). Each drain is empty unless the sim was told to
      // record that kind (capture* flags), so a map that doesn't listen pays nothing.
      const sw = this.rts.simWorld;
      const deaths = sw.drainDeathEvents();
      if (deaths.length) engine.interp.pumpUnitDeaths(deaths);
      // A gate that broke this tick is a death too — the widget kind (see killDestructible).
      if (this.destructibleDeaths.length) {
        const dead = this.destructibleDeaths;
        this.destructibleDeaths = [];
        engine.interp.pumpDestructableDeaths(dead);
      }
      const damage = sw.drainDamageEvents();
      if (damage.length) engine.interp.pumpDamageEvents(damage);
      const attacks = sw.drainAttackEvents();
      if (attacks.length) engine.interp.pumpAttackEvents(attacks);
      const orders = sw.drainOrderEvents();
      if (orders.length) engine.interp.pumpOrderEvents(orders);
      // 7.17: spells, construction, training, hero level/skill.
      const spells = sw.drainSpellEvents();
      if (spells.length) engine.interp.pumpSpellEvents(spells);
      const construct = sw.drainConstructEvents();
      if (construct.length) engine.interp.pumpConstructEvents(construct);
      const trains = sw.drainTrainEvents();
      if (trains.length) engine.interp.pumpTrainEvents(trains);
      const heroes = sw.drainHeroEvents();
      if (heroes.length) engine.interp.pumpHeroEvents(heroes);
      // 7.18: items picked up / dropped / used (a trigger's UnitAddItem and a hero walking
      // over the item both come through here — they're the same sim path).
      const items = sw.drainItemEvents();
      if (items.length) engine.interp.pumpItemEvents(items);
      // A unit that just boarded a transport / burrow (EVENT_UNIT_LOADED).
      const loads = sw.drainLoadEvents();
      if (loads.length) engine.interp.pumpLoadEvents(loads);
      // What the player selected or deselected this frame. The RTS owns the selection, so
      // this drain is off the controller rather than the world (the one non-sim event kind).
      // Drained every tick even when nothing listens — it is the drain that advances the
      // "what was selected last time" baseline, so a trigger registered mid-match must not
      // find the whole standing selection waiting for it as news.
      const picks = this.rts.drainSelectionEvents();
      if (picks.length && this.scriptWatchesSelection) {
        engine.interp.pumpSelectionEvents(picks.flatMap((p) => {
          const u = this.rts ? unitSnapshot(this.rts.simView, p.unitId) : null;
          return u ? [{ unit: u, player: p.player, selected: p.selected }] : [];
        }));
      }
      // Unit-state thresholds (EVENT_UNIT_STATE_LIMIT) are POLLED — nothing in the sim
      // raises "life dropped below 100", so the interpreter tests each watched unit itself.
      if (this.scriptWatchesUnitState) engine.interp.pumpUnitStates();
      // Enter/leave-region — only snapshot the world if some trigger watches a region.
      if (engine.interp.rt.triggerRegs.some((r) => r.kind === "enterRegion" || r.kind === "leaveRegion")) {
        engine.interp.pumpRegions(this.rts ? unitSnapshots(this.rts.simView) : []);
      }
      this.pumpScriptSounds(engine.interp.rt); // 7.20
    } catch (err) {
      console.warn("[jass] trigger pump failed (non-fatal):", err);
    }
  }

  /** The two things a `sound` handle needs over TIME, which the natives can't do
   *  themselves (7.20):
   *   • an `AttachSoundToUnit`'d sound rides its unit — so a hero's line pans across the
   *     field as he walks, instead of freezing where he stood when it started;
   *   • a `KillSoundWhenDone` handle is destroyed once its clip actually ends, which only
   *     this side knows. blizzard.j's `PlaySound()` is CreateSound + StartSound +
   *     KillSoundWhenDone, so without the sweep every fire-and-forget sound leaks a handle. */
  private pumpScriptSounds(rt: Runtime): void {
    if (!rt.sounds.length || !this.sounds || !this.rts) return;
    for (let i = rt.sounds.length - 1; i >= 0; i--) {
      const s = rt.sounds[i];
      const playing = this.sounds.isScriptPlaying(s.handleId);
      if (playing && s.is3D && s.attachUnit >= 0) {
        // A unit that died out from under its sound has no position left to follow: leave
        // the sound where it last was rather than yanking it to the map origin.
        const x = this.rts.simView.getUnitX(s.attachUnit);
        const y = this.rts.simView.getUnitY(s.attachUnit);
        if (x !== undefined && y !== undefined) {
          this.sounds.moveScript(s.handleId, { x, y, z: this.rts.groundHeightAt(x, y) });
        }
      }
      if (s.killWhenDone && s.started && !playing) rt.destroySound(s);
    }
  }

  // --- the trigger's on-screen output (7.19) ---------------------------------------

  /** Mount the surfaces a trigger can talk to the player through, beyond the HUD message
   *  log: floating text in the world, the leaderboard, the countdown windows (7.21), and
   *  dialogs (which is what the melee victory/defeat screen IS — see ui/gameDialog.ts).
   *  Also kicks off the load of the game's string table, which GetLocalizedString reads. */
  private mountScriptUi(ui: HTMLElement): void {
    this.textTags?.dispose();
    this.leaderboard?.dispose();
    this.multiboard?.dispose();
    this.timerDialogs?.dispose();
    this.cinematic?.dispose();
    this.dialog?.dispose();
    // A fresh match starts out of any cinematic the last one may have ended in — including
    // the body classes the cursor rules read, which outlive the match that set them: a game
    // quit mid-cinematic would otherwise hand the next one a `cine-on` body and no mouse.
    this.interfaceShown = true;
    this.userUi = true;
    this.userControl = true;
    document.body.classList.remove("cine-on", "dialog-on");
    this.gameSpeed = 2; // MAP_SPEED_NORMAL
    this.cinePortraitFor = "";
    this.cinePortraitWant = "";
    this.destructibleDeaths = []; // …and out of any gate the last one broke
    this.chatHistory = []; // last match's conversation is not this one's
    // Chat arriving over the wire lands in the same place a locally typed line does.
    if (this.rts) {
      this.rts.onChatSaid = (line) =>
        // On the HOST this is a client asking to be heard, so it goes through the full
        // routing. On a CLIENT it is the host's ruling, already routed — just show it.
        this.rts?.frozenClient ? this.showChat(line) : this.deliverChat(line);
    }
    // WC3 skins the in-game panels with the LOCAL player's race (an Orc player's dialog is
    // Orc-bordered) — that's what the war3skins.txt section names are (see fdf/library.ts).
    // The same sections hold the MUSIC playlists, which is how melee gives an Orc player
    // orc music: SetMapMusic("Music", …) → [Orc] Music_V1 (7.20).
    const skin = SKIN_SECTION[this.localRace];
    if (this.sounds) this.sounds.musicSkin = skin;
    // Floating combat text is world-anchored (project() hands it canvas CSS pixels), so it
    // belongs in the world layer — the leaderboard/multiboard/timers below are SCREEN-anchored
    // UI and belong in #ui, which CSS has already fitted to the same stage.
    this.textTags = new TextTagOverlay(worldLayer());
    this.combatText.clear(); // last match's numbers are not this one's
    this.leaderboard = new LeaderboardOverlay(ui, this.vfs, skin, (p) => this.rts?.playerColor(p) ?? p);
    this.multiboard = new MultiboardOverlay(ui, this.vfs, skin);
    this.timerDialogs = new TimerDialogOverlay(ui, this.vfs, skin);
    this.cinematic = new CinematicPanelOverlay(ui, this.vfs, skin);
    this.dialog = new GameDialogOverlay(ui, this.vfs, skin, {
      // WC3 closes a dialog on ANY button click, and a QUIT button additionally ends the
      // game — both are the engine's doing, which is why blizzard.j's MeleeVictoryDialogBJ
      // registers a trigger on its quit button and gives it no action. Order matters: the
      // script's own dialog-button triggers run first (they can still read GetClickedButton),
      // and the quit is what tears the match down.
      onClick: (button) => {
        const engine = this.mapScript;
        const dialog = engine?.interp.rt.dialogs.find((d) => d.handleId === button.dialogId);
        if (dialog) {
          dialog.visibleFor.delete(this.localPlayer);
          dialog.revision++;
        }
        // A RELAYED dialog (item F7) belongs to no script here, so dismissing it is dropping
        // it. Without this the per-frame update below would hand it straight back and the
        // screen could never be closed.
        this.remoteDialog = null;
        this.showDialog(null);
        engine?.interp.fireDialogClick(button.handleId, button.dialogId, this.localPlayer);
        if (button.quit) {
          this.paused = false;
          this.onExit?.();
        }
      },
    });
    if (!this.globalStrings) {
      const lib = new FdfLibrary(this.vfs);
      // GlobalStrings.fdf is what FdfLibrary.load() pulls in first for any screen, so
      // loading the leaderboard's file gives us the string table as a side effect.
      void lib.load("UI\\FrameDef\\UI\\LeaderBoard.fdf").then(() => {
        this.globalStrings = lib;
        primeQuestStrings(lib.strings); // the log's status captions, from the player's own table
      });
    }
  }

  /** Project every live floating text onto this frame's camera. Runs on the RENDER clock (a
   *  text tag must keep tracking its unit and the camera while the game is paused), while its
   *  ageing/drift/expiry run on the SIM tick — so a paused game leaves the text hanging
   *  exactly where it was rather than freezing it off-screen.
   *
   *  TWO sources, one overlay and therefore one call: the script's tags (`CreateTextTag`) and
   *  the engine's own combat text. The overlay drops every tag it was not shown this frame, so
   *  handing it one list and then the other would have each half erase the other's elements.
   *  Deliberately NOT gated on a running map script — a melee match has one but never pumps
   *  it on a client, and a crit number is the engine's to draw either way. */
  private updateFloatingText(): void {
    if (!this.textTags || !this.rts) return;
    const script = this.mapScript?.interp.rt.textTags ?? [];
    const combat = this.combatText.live;
    if (!script.length && !combat.length) {
      this.textTags.clear();
      return;
    }
    // Concatenated only when both halves are live — the common case is one or the other.
    const tags = !combat.length ? script : !script.length ? combat : [...script, ...combat];
    this.textTags.update(tags, this.textTagContext());
  }

  /** Drive the script's on-screen output for this frame — everything BUT the floating text,
   *  which `updateFloatingText` owns because the engine raises some of its own. */
  private updateScriptUi(): void {
    const engine = this.mapScript;
    if (!engine || !this.rts) return;
    const rt = engine.interp.rt;
    // An open Quest Log repaints when the script changes a quest under it; and a
    // FlashQuestDialogButton since last frame lights the HUD's Quests button, which
    // opening the log is what clears — as in the game.
    this.questLog?.update();
    if (rt.questFlashes !== this.questFlashesSeen) {
      this.questFlashesSeen = rt.questFlashes;
      this.hud?.flashQuests(true);
    }
    if (this.questLog?.visible) this.hud?.flashQuests(false);
    // **The top-right stack is INTERFACE, and a cinematic takes the interface away.**
    // `ShowInterface(false)` is the letterbox (see syncHudVisible), and in WC3 it takes the
    // scoreboard, the leaderboard and the countdown windows with the console — there is no
    // scoreboard hanging over a cutscene. Ours stayed up, so Extreme Candy War's intro played
    // under its own kill-count board. Keyed on the letterbox alone, like the cursor and the
    // console panels: `EnableUserUI(false)` is the momentary blackout blizzard.j flicks around
    // each cinematic fade, and a board must not blink for it.
    const cine = !this.interfaceShown;
    this.leaderboard?.update(cine ? null : rt.leaderboardFor(this.localPlayer));
    // The three top-right panels stack, in the order WC3 stacks them: leaderboard, then
    // multiboard, then the countdown windows — each hangs below whatever the ones above it
    // are already using, so they never overlap.
    const underBoard = this.leaderboard?.occupiedHeight() ?? 0;
    this.multiboard?.update(rt.multiboards, cine || rt.multiboardSuppressed, underBoard ? underBoard + TIMER_STACK_GAP : 0);
    // Countdown windows stack below both (7.21). Their TIME isn't pushed — it's read live
    // off each dialog's timer, so this runs every frame, not just when something changed.
    if (this.timerDialogs) {
      const below = underBoard + (this.multiboard?.occupiedHeight() ?? 0);
      this.timerDialogs.update(cine ? [] : rt.timerDialogs, (td) => rt.timerDialogSeconds(td), below ? below + TIMER_STACK_GAP : 0);
    }
    // The AUTHORITY's dialogs, for players who are not sitting here (item F7). A client's own
    // script never raises the melee victory/defeat screen — blizzard.j's check runs off unit
    // DEATH events in the world it can see, and a client's world never receives the host's
    // commands, so the hall that was razed is still standing in it. The host is the only
    // machine that knows, and this is where it says so.
    for (const d of rt.dialogs) {
      for (const p of d.visibleFor) {
        if (p === this.localPlayer) continue; // ours; rendered below, not relayed
        const stamp = `${d.handleId}:${d.revision}`;
        if (this.relayedDialogs.get(p) === stamp) continue;
        const sent = this.rts?.relayDialog(p, {
          k: "dlg",
          message: d.message,
          buttons: d.buttons.map((b) => ({ text: b.text, quit: b.quit })),
          // Whether this screen is the end of the MATCH, decided by the AUTHORITY rather than
          // guessed by the recipient — a map raising a quest popup for a remote player must not
          // drop that player off the wire mid-match, and neither must their own defeat while
          // somebody else is still playing.
          ...(this.matchDecided ? { over: true } : {}),
        });
        // Remembered only when it actually went somewhere, so a player who has not been
        // seated yet is retried rather than silently written off.
        if (sent) this.relayedDialogs.set(p, stamp);
      }
    }
    // A dialog the authority sent US wins over our own script's, which on a client is empty
    // anyway — and on the host `remoteDialog` is never set, so this reads as it always did.
    this.showDialog(this.remoteDialog ?? rt.dialogs.find((d) => d.visibleFor.has(this.localPlayer)) ?? null);

    // THE WIRE CLOSES HERE, AND THE PLACE IS THE POINT (Phase G item 1). The match is decided,
    // so every machine keeping its own private idea of the world from now on costs nothing —
    // that is the developer's rule and it is how WC3 behaves. But it has to happen AFTER the
    // relay loop above: the host learns the outcome from `RemovePlayer` DURING the script call,
    // and closing there would tear the socket down in the same frame that owes the loser the
    // screen explaining why. Relay first, then hang up.
    if (this.matchDecided && !this.matchEnded) {
      this.matchEnded = true;
      this.rts?.endMatchWire();
    }
  }

  /** The world→screen bridge the floating-text pass runs on. */
  private textTagContext(): TextTagContext {
    const rts = this.rts!;
    const scene = this.viewer.map?.worldScene;
    const dpr = this.canvas.width / this.canvas.clientWidth || 1;
    const vision = rts.getVision();
    return {
      // The FDF UI space is 0.6 tall (ui/fdf/layout.ts) and is fitted to the GAME frame, so a
      // text tag's size/offset scales with the stage — not with the window around it.
      // A text tag's height and drift are fractions of the WHOLE screen (a tag of height 1
      // fills it), so this is the viewport height plain — not the FDF `/ UI_HEIGHT` scale
      // the panels are laid out with, which over-set every tag by 1/0.6 (issue #120).
      uiScale: this.canvas.clientHeight || GAME_HEIGHT,
      groundHeight: (x, y) => rts.groundHeightAt(x, y),
      unitAt: (simId) => {
        const u = rts.simView.units.get(simId);
        return u ? { x: u.x, y: u.y, flyHeight: rts.simView.getUnitFlyHeight(simId) ?? 0 } : null;
      },
      visible: (x, y) => vision.stateAt(x, y) === FogState.Visible,
      project: (x, y, z) => {
        if (!scene) return null;
        this.world3[0] = x;
        this.world3[1] = y;
        this.world3[2] = z;
        (scene.camera as unknown as RtsHost["camera"]).worldToScreen(this.screen3, this.world3, scene.viewport);
        // worldToScreen gives GL pixels (y-UP from the canvas bottom). A point behind the
        // eye still projects to a finite spot, so reject it rather than draw the text
        // mirrored in front of the camera.
        const sx = this.screen3[0] / dpr;
        const sy = (this.canvas.height - this.screen3[1]) / dpr;
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
        return { x: sx, y: sy };
      },
    };
  }

  /** Make every CUSTOM unit/item row the viewer built name ITSELF.
   *
   *  mdx-m3-viewer declares a map's war3map.w3u/.w3t objects by CLONING the base type's row
   *  (`row.map = {...base.map}`) and then writing only the fields the modification file lists.
   *  `unitid`/`itemid` are not modification fields — no .w3u carries them — so a custom type's
   *  row goes on reporting the BASE type's rawcode: WarChasers' Shandris-based hero `EC12`
   *  answers `unitid = "Emoo"`.
   *
   *  That column is the only thing identifying a pre-placed unit when we adopt it (rts.trySeed
   *  reads `row.string("unitid")`), so every custom unit a map PLACES was seeded from the base
   *  UnitDef — base name, base portrait model, base stats — and off the .doo's reserved id
   *  block, since PlacedIndex.reserveIdAt matches on the rawcode. Units the map's SCRIPT made
   *  were fine, because CreateUnit carries the rawcode itself; that split is exactly the
   *  "the hero pedestals show the original hero, but the hero you pick is correct" report.
   *
   *  The repair is "the key is the truth": every table the viewer merges into `unitsData` is
   *  keyed BY its identity column (UnitData/UnitUI by `unitid`, ItemData by `itemid`) — checked
   *  across all 1110 stock rows, zero disagree — so a row that contradicts its own key is a
   *  clone and nothing else is touched. Runs for every map, melee or custom, before a single
   *  unit has been adopted. */
  private repairCustomRowIds(): void {
    for (const [id, row] of Object.entries(this.viewer.unitsData.map)) {
      for (const col of ["unitid", "itemid"]) {
        if (row.string(col) !== undefined && row.string(col) !== id) row.set(col, id);
      }
    }
  }

  /**
   * Put the viewer's object-data tables back the way the GAME ships them, before the next map
   * writes its own over the top.
   *
   * `unitsData` and `doodadsData` are the viewer's own words: *"Global tables like WC3. It's
   * bad."* They are loaded once from the SLKs and every map's `war3map.w3u`/`.w3t`/`.w3d`/`.w3b`
   * is merged INTO them — so a map's overrides outlive the map. That did no harm while the
   * library mis-filed every ORIGINAL-table override onto a junk row (the `'\0\0\0\0'` newId bug
   * this repo patches); now that they land on the type they name, they leak: play Extreme Candy
   * War, quit to the menu, start Echo Isles, and its Footmen are still Zombies.
   *
   * So the first map to load takes a snapshot of every row, and each map after it restores from
   * that snapshot and drops the rows a previous map INVENTED (its `h001`-style custom ids). One
   * shallow copy per row, taken once — the tables are ~1100 rows of plain values.
   */
  private resetObjectData(): void {
    const tables: Array<[string, MappedData]> = [["units", this.viewer.unitsData], ["doodads", this.viewer.doodadsData]];
    for (const [name, table] of tables) {
      const rows = table.map as Record<string, { map: Record<string, unknown> }>;
      const saved = this.pristineObjectData.get(name);
      if (!saved) {
        const snap = new Map<string, Record<string, unknown>>();
        for (const [id, row] of Object.entries(rows)) snap.set(id, { ...row.map });
        this.pristineObjectData.set(name, snap);
        continue; // nothing has overwritten anything yet — this IS the pristine state
      }
      for (const id of Object.keys(rows)) {
        const pristine = saved.get(id);
        if (pristine) rows[id].map = { ...pristine };
        else delete rows[id]; // a type the last map invented
      }
    }
  }

  /** Hide the map's start-location marker props (the `sloc` StartLocation.mdx
   *  units). The viewer hard-codes those with an UNDEFINED row (they're not in
   *  the unit tables), so a rowless rendered unit is a start marker — hide it so
   *  it isn't visible after players spawn. They're never selectable (not seeded
   *  into the sim). Runs once the map's units have finished loading (async). */
  private hideStartLocations(): void {
    const map = this.viewer.map;
    if (!map) return;
    for (const u of map.units as Array<{ row?: unknown; instance?: { hide(): void } }>) {
      if (!u.row) u.instance?.hide();
    }
  }

  /** Where to place a summoned unit, on the nearest free tile of the UNIT grid.
   *
   *  `atPoint` is the difference between the two kinds of summon WC3 has, and getting it
   *  wrong is very visible:
   *   • false — (x, y) is the CASTER. The unit materializes a step in front of them, the
   *     way the Far Seer's wolves trot out ahead of him.
   *   • true  — (x, y) is a point the player TARGETED (Serpent Ward, Healing Ward, Sentry
   *     Ward, Stasis Trap, Inferno, Force of Nature). The unit belongs exactly there.
   *     Applying the forward step here threw every ward ~96 units PAST the click, in
   *     whatever direction the hero happened to be facing.
   *
   *  The snap honours footprint PARITY (snapForFootprint), it does not just take the cell
   *  centre: a Serpent Ward's collision of 16 is a 2×2 (even) footprint, which WC3 centres
   *  on a cell CORNER. Centre-snapping an even footprint puts the unit half a cell off the
   *  grid its own footprint math (footprintFits/footprintOrigin) assumes — the ward reads
   *  as sitting on the coarse building lattice instead of the unit one. */
  private summonSpot(x: number, y: number, facing: number, collision: number, atPoint: boolean, claimed: Set<string>): [number, number] {
    const dist = atPoint ? 0 : 96; // the step in front of the caster — never past a target point
    const fx = x + Math.cos(facing) * dist;
    const fy = y + Math.sin(facing) * dist;
    if (this.grid) {
      const n = footprintCells(collision);
      // Index by the footprint's own anchor cell, not worldToCell: an even footprint (a
      // Serpent Ward's collision of 16 is 2×2) anchors on the cell CORNER, and seeding the
      // search from the wrong parity is what put wards half a cell off the unit grid.
      const [cx, cy] = this.grid.footprintAnchor(fx, fy, n);
      // `claimed` are the cells already handed out this frame. The sim reserves a
      // footprint only on settle (a tick later), so without this a multi-unit summon
      // aimed at ONE point — Force of Nature's treants, Storm/Earth/Fire — would hand
      // every copy the same cell and stack them. The caster-relative summons never hit
      // this because summonMany fans their facings, and that fan is what the forward
      // step turns into distinct spots.
      const unclaimed = (sx: number, sy: number): boolean => !claimed.has(`${sx},${sy}`);
      const spot = this.grid.nearestFit(cx, cy, n, 14, unclaimed) ?? this.grid.nearestFit(cx, cy, n, 14) ?? this.grid.nearestWalkable(cx, cy, 14);
      if (spot) {
        claimed.add(`${spot[0]},${spot[1]}`);
        return this.grid.footprintCenter(spot[0], spot[1], n);
      }
    }
    return [fx, fy];
  }

  /** Where a freshly-trained unit exits its production building. WC3: units leave
   *  from the building corner nearest the rally point (bottom-left when the rally
   *  sits on the building itself); if that corner is blocked by a unit, building
   *  or trees, the game rotates counterclockwise around the building to the next
   *  clear spot. `claimed` are spots already given out this frame — a batch
   *  trained simultaneously walks out to distinct corners instead of stacking. */
  private trainSpawnSpot(
    buildingId: number,
    bx: number,
    by: number,
    rallyX: number,
    rallyY: number,
    collision: number,
    claimed: Array<[number, number]>,
  ): [number, number] {
    if (!this.grid) return [bx, by];
    const n = footprintCells(collision);
    // Building half-extents in world units (cell = 32 → half-cell = 16). Fall back
    // to a 3×3-ish structure if we somehow have no stamped footprint on record.
    const fp = this.rts?.simView.units.get(buildingId)?.pathStamp?.fp;
    const halfW = fp ? fp.w * 16 : 48;
    const halfH = fp ? fp.h * 16 : 48;
    // Four corners in counterclockwise order (WC3 rotates CCW): SW → SE → NE → NW,
    // i.e. bottom-left, bottom-right, top-right, top-left. World +y is north.
    const corners: Array<[number, number]> = [
      [bx - halfW, by - halfH], // SW (bottom-left)
      [bx + halfW, by - halfH], // SE (bottom-right)
      [bx + halfW, by + halfH], // NE (top-right)
      [bx - halfW, by + halfH], // NW (top-left)
    ];
    // Start corner: the one nearest the rally point, or bottom-left (SW, index 0)
    // when the rally sits on the building footprint itself (WC3's default corner).
    let start = 0;
    const rallyOnBuilding = Math.abs(rallyX - bx) <= halfW && Math.abs(rallyY - by) <= halfH;
    if (!rallyOnBuilding) {
      let bestD = Infinity;
      for (let i = 0; i < 4; i++) {
        const d = Math.hypot(corners[i][0] - rallyX, corners[i][1] - rallyY);
        if (d < bestD) { bestD = d; start = i; }
      }
    }
    // Try each corner in CCW order from the chosen one; take the first with a free
    // spot our footprint fits on that no unit (settled OR walking) already holds.
    for (let k = 0; k < 4; k++) {
      const [cwx, cwy] = corners[(start + k) % 4];
      const spot = this.freeSpotNear(cwx, cwy, n, collision, claimed, 4);
      if (spot) { claimed.push(spot); return spot; }
    }
    // Every corner crowded (heavy congestion): widen the search from the building
    // centre so the unit still lands somewhere free rather than inside another.
    const [ccx, ccy] = this.grid.worldToCell(bx, by);
    const wide = this.grid.nearestFit(ccx, ccy, n, 24) ?? this.grid.nearestWalkable(ccx, ccy, 24);
    if (wide) {
      const w = this.grid.cellToWorld(wide[0], wide[1]);
      claimed.push(w);
      return w;
    }
    return [bx, by];
  }

  /** Spiral out from world (wx,wy) for the nearest cell an n×n footprint fits on
   *  that is neither claimed this frame nor overlapping a live unit. Radius is in
   *  cells; null if nothing clear within it. */
  private freeSpotNear(
    wx: number,
    wy: number,
    n: number,
    collision: number,
    claimed: Array<[number, number]>,
    maxRadius: number,
  ): [number, number] | null {
    if (!this.grid) return null;
    const world = this.rts?.simWorld;
    const gap = collision * 2; // keep spawned bodies at least a diameter apart
    const [cx, cy] = this.grid.worldToCell(wx, wy);
    for (let r = 0; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          if (!this.grid.footprintFits(cx + dx, cy + dy, n)) continue;
          const [sx, sy] = this.grid.cellToWorld(cx + dx, cy + dy);
          if (claimed.some(([px, py]) => Math.hypot(px - sx, py - sy) < gap)) continue;
          if (world?.spotOccupied(sx, sy, collision)) continue;
          return [sx, sy];
        }
      }
    }
    return null;
  }

  /** Lazily-built UberSplat table (building ground-texture code → texture + scale). */
  private uberSplatRegistry(): UberSplatRegistry {
    if (!this.uberSplats) this.uberSplats = loadUberSplatRegistry(this.vfs);
    return this.uberSplats;
  }

  /** Paint a building's ground texture (ubersplat) on the terrain under it, keyed by
   *  `key`. A no-op for units without a `uberSplat`, or before the overlay exists. */
  private addBuildingSplat(key: number | string, def: UnitDef, x: number, y: number): void {
    if (!def.uberSplat || !this.splats) return;
    const s = this.uberSplatRegistry().get(def.uberSplat);
    if (s) this.splats.add(key, x, y, s.scale, s.texture);
  }

  /** Re-skin a live unit as another type — a Town Hall that just became a Keep (issue #57).
   *  The sim already swapped the type and kept the entity, so this only replaces the model
   *  instance and the render-side facts that hang off the type: the food it supplies, its
   *  selection ring, and its ground splat (a Keep's is bigger than a Town Hall's).
   *
   *  It deliberately does NOT re-stamp the pathing footprint. Every tier of a WC3 hall shares
   *  one footprint (`htow`/`hkee`/`hcas` all use the same pathing texture and a 176 collision),
   *  and re-stamping would mean unsettling a building with units standing around it. If a
   *  future upgrade DID change footprint, that would need handling here. */
  private async remodelUnit(simId: number, toTypeId: string): Promise<void> {
    const map = this.viewer.map;
    const def = this.registry.get(toTypeId);
    if (!map || !this.rts || !def) return;
    const su = this.rts.simView.units.get(simId);
    if (!su || su.hp <= 0) return; // died while the new model streamed in
    // A morph onto the SAME model file needs no new body — and must not be given one. Most
    // WC3 form pairs are one MDX under two unit ids (Nalc↔Nalm↔Nal2↔Nal3 are all
    // HeroGoblinAlchemist.mdx, ucry↔ucrm both CryptFiend.mdx), and swapping the instance
    // resets the pose, which lands squarely on the "Morph" transition applyFormAnims starts
    // the same frame — the Alchemist snapped into his ogre instead of shuffling into it.
    if (this.rts.renderedModelPath(simId) !== def.model) {
      const model = await this.viewer.load(def.model, this.solver);
      if (!model) return;
      const instance = model.addInstance();
      instance.setScene(map.worldScene);
      instance.setTeamColor(this.rts.playerColor(su.owner)); // the owner's COLOUR, not its slot
      if (!this.rts.remodel(simId, instance, def)) {
        instance.hide(); // the unit went away while we were loading
        return;
      }
    } else if (!this.rts.retype(simId, def)) {
      return; // the unit went away
    }
    // Re-lay the ground splat: a Keep's foundation is a different texture and scale from a
    // Town Hall's, so drop the old decal before painting the new one.
    this.splats?.remove(simId);
    this.simBuildingSplats.delete(simId);
    if (def.uberSplat) {
      this.simBuildingSplats.add(simId);
      this.addBuildingSplat(simId, def, su.x, su.y);
    }
  }

  /**
   * Entangle Gold Mine (`Aent`), renderer half: raise the building the sim asked for, and put
   * the gold mine it swallowed out of sight.
   *
   * The sim cannot do this itself for the same reason it cannot summon: `egol` needs a model,
   * and the model is a load away (see drainSummonRequests). It also cannot do the second half
   * at all — the plain gold mine is a MAP WIDGET, a doodad-style instance from
   * war3mapUnits.doo rather than a unit, and hiding it is a render-side act.
   *
   * `EntangledGoldMine.mdx` is a whole mine wrapped in roots, not a decoration to lay over
   * one, so both models on screen at once would be two mines in the same hole. Hidden and
   * remembered rather than retired: an entangled mine that is destroyed leaves the gold mine
   * standing, and the second loop here is what puts it back.
   */
  private raiseEntangledMines(world: SimWorld): void {
    const map = this.viewer.map;
    for (const e of world.drainEntangleRequests()) {
      const d = this.registry.get(e.unitId);
      const mine = world.mines.get(e.mineId);
      if (!d || !mine) continue;
      const widget = map ? this.nearestDoodadWidget(e.x, e.y, map.units as unknown as HideableWidget[]) : null;
      const mineId = e.mineId;
      // The roots do not snap shut. An Entangled Gold Mine is CONSTRUCTED — `egol` carries a
      // UnitBalance `bldtm` of 60, and it serves it the way every other structure does, from a
      // tenth of its hit points to all of them, paying nothing until it is finished. It just
      // has nobody hammering it (SimWorld.attachEntangled marks it `selfBuilds`). The melee
      // opening's `entangleinstant` is the one that skips both clocks (EntangleRequest.instant).
      void this.spawnUnit(d, e.x, e.y, e.owner, e.team, e.instant ? 0 : d.buildTime).then((simId) => {
        if (simId === null) {
          mine.entangledBy = 0; // the model never arrived — leave the mine as it was
          return;
        }
        world.attachEntangled(simId, mineId, e.casterId);
        this.claimMineWidget(simId, mineId, widget);
      });
    }
    // …and the way back. The building has left the world (destroyed, or the mine ran dry and
    // it collapsed with it): un-hide the gold mine under it and repaint its foundation.
    if (!this.entangledMines.size) return;
    for (const [simId, held] of [...this.entangledMines]) {
      if (world.units.has(simId)) continue;
      this.entangledMines.delete(simId);
      if (world.mines.has(held.mineId)) {
        held.widget.instance.show();
        const mineDef = this.registry.get(GOLD_MINE_ID);
        const m = world.mines.get(held.mineId)!;
        if (mineDef) this.addBuildingSplat(`m${held.mineId}`, mineDef, m.x, m.y);
      }
    }
  }

  /** A building has taken a gold mine over (entangled or haunted): hide the mine's own model
   *  under it, remember the pair so the mine can be un-hidden when the building goes, and take
   *  the mine's foundation decal away — `egol` paints EMDB and `ugol` UGOL in the same place,
   *  and two ubersplats in one spot blend to a dark smear. */
  private claimMineWidget(simId: number, mineId: number, widget: HideableWidget | null): void {
    if (widget) {
      widget.instance.hide();
      this.entangledMines.set(simId, { widget, mineId });
    }
    this.splats?.remove(`m${mineId}`);
  }

  private async spawnUnit(
    def: UnitDef, x: number, y: number, owner: number, team: number, constructionTime = 0,
    facing = (3 * Math.PI) / 2, reservedId?: number,
  ): Promise<number | null> {
    const map = this.viewer.map;
    if (!map || !this.rts) return null;
    // Buildings snap to WC3's 64-unit BUILD grid, so their stamped footprint lands on
    // whole build cells (an even pathing-cell boundary) exactly as the original does.
    const fp = def.isBuilding && def.pathTex && this.grid ? this.footprintFor(def.pathTex) : null;
    if (fp && this.grid) [x, y] = this.grid.snapForBuildingRect(x, y, fp.w, fp.h);

    // A type with NO model is invisible, not absent — WC3's dummy-unit convention (see
    // `normModel`). It is still a unit in every other respect, so it gets a record and no
    // body. Distinct from art we merely failed to FIND, which falls through to the load
    // below and is still dropped: that is a broken asset, and it should look like one.
    if (!def.model) {
      // A reserved id means the record already exists (the JASS CreateUnit path) and this
      // call was only here to hand it a body. There is none. Every other caller is asking
      // for the unit itself, so make it.
      return reservedId !== undefined
        ? null
        : this.rts.addSimUnit(def, x, y, facing, owner, team, constructionTime);
    }
    const model = await this.viewer.load(def.model, this.solver);
    if (!model) return null;
    const instance = model.addInstance();
    instance.setScene(map.worldScene);
    instance.setTeamColor(this.rts.playerColor(owner)); // a slot's colour is not its index
    const simId = this.rts.addUnit(instance, def, x, y, facing, owner, team, constructionTime, reservedId); // default: face south
    // -1: the sim unit this model was loading for is already gone (a trigger created and
    // then removed it while the model streamed). Drop the model rather than leave a ghost.
    if (simId < 0) {
      instance.hide();
      return null;
    }
    // Seat the body NOW. Owned units are re-seated by the entry sync every frame, but a
    // NEUTRAL PASSIVE entry is skipped there (map furniture is placed by the map loader) —
    // so a drain-spawned neutral building (a frozen client re-scouting a merchant, item 2c)
    // otherwise renders at the map origin forever. Everything else just gets its first
    // frame's pose a frame early.
    //
    // …and it must be seated where the unit IS, not where it was asked for. On the reserved-id
    // path the sim unit was already alive while the model streamed, and a script gets to move
    // it in that window (WTii's Unit Tester teleports every unit you buy out of the shop the
    // same tick it is created). Seating at the stale spot puts the body at the shop for the one
    // frame before the entry sync catches up — the flicker this whole path exists to avoid.
    if (reservedId !== undefined) {
      const u = this.rts.simWorld.units.get(simId);
      if (u) {
        x = u.x;
        y = u.y;
        facing = u.facing;
      }
    }
    const [seatW, seatH] = seatHalfExtents(def, fp);
    const z = fp && this.footMaxHeight ? this.footMaxHeight(x, y, seatW, seatH) : (this.heightSampler ? this.heightSampler(x, y) : 0);
    instance.setLocation([x, y, z]);
    const halfFacing = facing / 2;
    instance.setRotation(new Float32Array([0, 0, Math.sin(halfFacing), Math.cos(halfFacing)]));

    // Buildings block pathing: stamp their footprint so units route around them.
    if (fp && this.grid) {
      stampFootprint(this.grid, fp, x, y);
      // The sim owns the stamp from here: it frees those cells the moment the building
      // leaves the world (death, RemoveUnit, cancelled construction).
      this.rts.simWorld.setPathStamp(simId, fp, x, y);
      // Seat the structure on the tallest terrain its BODY spans so it never clips into a
      // small hill/slope (issue #15) without perching above its own ground decal — see
      // seatHalfExtents for why that is the body and not the stamp.
      this.rts.setBuildingFootprint(simId, seatW, seatH);
    }
    // Paint the building's ground texture (ubersplat) on the terrain under it. Tracked
    // so it's removed when the building is destroyed (reconcile) or cancelled. A frozen
    // client re-creating a MAP-PLACED building it scouted (the snapshot drain) skips the
    // paint — that building's `p<i>` decal already exists and would double-blend darker.
    if (def.isBuilding && def.uberSplat) {
      let placedHasIt = false;
      for (const s of this.mapBuildingSplats.values()) {
        if (s.simId === simId) {
          placedHasIt = true;
          break;
        }
      }
      if (!placedHasIt) {
        this.simBuildingSplats.add(simId);
        this.addBuildingSplat(simId, def, x, y);
      }
    }
    return simId;
  }

  /** Place the building being positioned at the cursor, if valid and affordable.
   *  The structure is NOT spawned yet — the worker walks to the site (tracked by
   *  the sim as `buildPending`) and the building rises once it arrives (see
   *  tickPendingBuild). Shift queues the build after the worker's current orders. */
  private placeBuilding(cssX: number, cssY: number, queued = false): void {
    const p = this.placement;
    if (!p || !this.rts || !this.grid) return;
    const hit = this.rts.groundPoint(cssX, cssY);
    if (!hit) return;
    let [x, y] = this.snapPlacement(p.def, hit[0], hit[1], p.fp);
    // A refused placement keeps the building on the cursor, exactly like a refused cast
    // keeps the reticle: the player gets told why and clicks again, without re-picking the
    // building off the card. Asked against the grid AND this player's own pending build
    // sites — a shift-queued building placed over a ghost is refused here rather than
    // discovered a minute later when the worker walks over. An unshifted click retires this
    // worker's own orders first, so its own ghosts don't refuse it.
    // Planting an Ancient, not raising a building: no worker, no price, and the game's own
    // words for a refused site — commandstrings.txt [Errors] `Cantroot` = "Unable to root
    // there." The Ancient walks to the spot and settles when it arrives (SimWorld.issueRootAt).
    if (p.rootUnitId !== undefined) {
      if (!this.placementValid(x, y, this.pendingBuildCells(0))) {
        this.refuse("Cantroot");
        return;
      }
      if (!this.rts.execute(this.localPlayer, {
        c: "order", unitId: p.rootUnitId, order: { kind: "rootat", x, y }, queued,
      })) return;
      this.sounds?.playUi("PlaceBuildingDefault");
      if (queued) return;
      this.cardPage = "root";
      this.cancelPlacement();
      return;
    }
    if (!this.placementValid(x, y, this.pendingBuildCells(queued ? 0 : p.workerId))) {
      // Which refusal depends on WHY: clear ground that simply is not rotted gets the
      // Undead's own line, everything else the shared one.
      this.refuse(this.groundSuitsBuilding(p.def, x, y) ? "Cantplace" : "Offblight");
      return;
    }
    // Feedback only, and deliberately duplicated (same contract as trainUnit): `execute`
    // decides, but it can't SAY anything, and a placement that fails on price is otherwise
    // a click that does nothing at all. The ghost stays on the cursor either way.
    //
    // A SHIFT-queued placement is exempt: it is not spending this instant's gold but the gold
    // the next minute's mining will bring in, so it is queued whatever the stash says and
    // priced when the worker gets there (`SimWorld.payPendingBuild`). The refusal is not
    // skipped, only MOVED: until then the player reads the answer off the silhouette, which
    // stands red while the stash can't cover it, and if it is still red when the worker
    // arrives the order is refused out loud there and dropped.
    if (!queued && !this.canAfford(p.def.goldCost, p.def.lumberCost)) return;
    // Affordability, the charge and the order are all the authority's now — the renderer
    // used to charge the stash itself and post the price into the order (docs/multiplayer.md).
    if (!this.rts.execute(this.localPlayer, {
      c: "build", unitId: p.workerId, defId: p.def.id, x, y, queued,
    })) return;
    this.sounds?.playUi("PlaceBuildingDefault"); // WC3 building-placement confirm
    // Shift-placing KEEPS the building on the cursor, so the next site is one more click
    // rather than Build → pick the tower again → click (WC3 — it is how a line of towers or
    // a wall of Farms actually gets laid down). The armed ghost stays with the same worker
    // and the same building; it ends the way any placement does — an unshifted click, a
    // right-click, Escape, or selecting something else. An unshifted click is unchanged:
    // one building, cursor cleared, back to the root page.
    if (queued) return;
    this.cardPage = "root";
    this.cancelPlacement();
  }

  /** The Acolyte's summoning kneel, played once over the structure it has just laid down.
   *
   *  Fired at the raise rather than driven by the picker because there is no job left to
   *  read: `assignBuilder` has already handed the building its own clock and released the
   *  Acolyte (`summonsBuildings`). Asked of every race and answered only by the one that
   *  summons, so the rule stays where the sim keeps it. */
  private playSummonGesture(workerId: number): void {
    const w = this.rts?.simWorld.units.get(workerId);
    if (w && summonsBuildings(w)) this.rts?.playWorkAnimOnce(workerId);
  }

  /** When a worker walking to raise a new building (`buildPending`) reaches its
   *  site, clear any of our own units off the footprint, then spawn the
   *  foundation (under construction) and attach it as builder. If the site can't
   *  be cleared within BUILD_CLEAR_TIMEOUT, give up and refund. A guard set
   *  prevents a double-spawn during the async model load — the worker keeps its
   *  `buildPending` (so the sim holds queued follow-ups) until assignBuilder clears it. */
  private tickPendingBuild(dt: number): void {
    if (!this.rts) return;
    const world = this.rts.simWorld;
    for (const w of world.units.values()) {
      // A worker mid-spawn is exempt from BOTH halves below: its foundation's own footprint
      // is already on the grid (spawnUnit stamps before its model promise settles) while it
      // still holds the `buildPending` that raised it, so asking would refuse the very build
      // that is happening.
      if (this.buildSpawning.has(w.id)) continue;
      // Re-ask the ground of every build order this worker still holds, and drop the ones it
      // now refuses (with a refund). A build site is authorised when the player CLICKS it,
      // and a shift-queued one can sit for a minute before the worker walks over — long
      // enough for the previous building in the same queue to rise straight through it, which
      // is exactly the "two buildings inside each other" the queue used to allow. Runs every
      // tick rather than only on arrival so a doomed order clears (and its ghost with it) the
      // moment the ground goes, whoever took it — this worker, an ally, or an enemy.
      if (w.buildPending || w.orderQueue.length) {
        const dropped = world.dropBlockedBuilds(w.id, this.siteBlocked);
        // "Unable to build there." — the same refusal the click itself would have got, said
        // once however many orders went, and only to the player whose orders they were.
        if (dropped && w.owner === this.localPlayer) this.refuse("Cantplace");
      }
      const pb = w.buildPending;
      // No owner filter: on a LAN host EVERY player's pending builds are this machine's to
      // start — the client's worker walked here on the host's own sim, and skipping it left
      // the foundation never rising (playtest bug 6's true root, the localPlayer disease
      // bug 4 had). Single-player is unchanged: only the local player ever has one. A
      // frozen client never runs this at all (advanceSim's gate).
      if (!pb) continue;
      const def = this.registry.get(pb.defId);
      if (!def) { world.cancelPendingBuild(w.id); this.buildWait.delete(w.id); continue; }
      // "There yet" is measured against the site's EDGE, not a fixed 160 from its centre —
      // which for anything bigger than a Farm was a circle INSIDE the footprint, so the only
      // way to arrive was to walk into the middle of it. The worker is sent to the edge now
      // (SimWorld.buildApproach) and this is the same stand-off read back, with a cell of
      // slack for wherever the pathfinder actually parked it. Still gated on having STOPPED:
      // a worker crossing the site on its way somewhere else is not building anything.
      const siteFp = def.pathTex ? this.footprintFor(def.pathTex) : null;
      const half = siteFp ? (Math.max(siteFp.w, siteFp.h) * PATHING_CELL) / 2 : 0;
      const reach = Math.max(160, half + (w.radius || 16) + 2 * PATHING_CELL);
      if (Math.hypot(w.x - pb.x, w.y - pb.y) >= reach || w.moving) { this.buildWait.delete(w.id); continue; } // not there yet
      // The worker is standing on the site, so this is the moment a shift-queued build is
      // asked for its money (it was queued without being asked — see Authority's `build`).
      // Short of it, the build is off: the order goes, every unpaid one queued behind it goes
      // with it, and the player is told which resource ran out in the game's own voice — the
      // same "Not enough gold." they would have got at the click, arriving where the decision
      // actually happened. The silhouettes vanish with their orders.
      if (!world.payPendingBuild(w.id)) {
        this.buildWait.delete(w.id);
        const short = world.dropUnpaidBuilds(w.id);
        if (short && w.owner === this.localPlayer) this.refuse(short === "gold" ? ERR_NOGOLD : ERR_NOLUMBER);
        continue;
      }
      // A Haunted Gold Mine rises on the mine itself. The mine's own cells are already
      // stamped (they are the mine's footprint, and `ugol` carries the very same
      // 16x16Goldmine pathTex), so there is nothing to clear and nothing to wait for — but
      // the mine has to be CLAIMED here, at the raise, or two Acolytes walking to the same
      // one would each raise their own.
      if (pb.mineId !== undefined) {
        const mine = world.mines.get(pb.mineId);
        if (!mine || mine.entangledBy) { world.cancelPendingBuild(w.id); continue; } // gone, or beaten to it
        mine.entangledBy = -1; // claimed while the model is in flight (see SimWorld.entangleMine)
        const workerId = w.id;
        const mineId = pb.mineId;
        const vmap = this.viewer.map;
        const widget = vmap ? this.nearestDoodadWidget(mine.x, mine.y, vmap.units as unknown as HideableWidget[]) : null;
        this.buildSpawning.add(workerId);
        void this.spawnUnit(def, mine.x, mine.y, w.owner, this.teamOf(w.owner), def.buildTime || 60).then((simId) => {
          this.buildSpawning.delete(workerId);
          if (simId === null) {
            mine.entangledBy = 0; // the model never arrived — leave the mine as it was
            world.cancelPendingBuild(workerId);
            return;
          }
          // `entangler` 0: nothing HOLDS a haunted mine. An Entangled Gold Mine is released
          // the moment its Tree uproots; a Haunted one outlives the Acolyte that summoned it,
          // like every other Undead structure (see summonsBuildings).
          world.attachEntangled(simId, mineId, 0);
          this.claimMineWidget(simId, mineId, widget);
          world.assignBuilder(workerId, simId); // clears buildPending, and lets the Acolyte go
          this.playSummonGesture(workerId);
        });
        continue;
      }
      const fp = def.pathTex ? this.footprintFor(def.pathTex) : null;
      const occupants = fp ? this.footprintOccupants(fp, pb.x, pb.y, w.id) : [];
      if (occupants.length === 0) {
        // Site clear (only the builder was there) → raise the foundation.
        this.buildWait.delete(w.id);
        const workerId = w.id;
        this.buildSpawning.add(workerId);
        // The foundation belongs to the WORKER's owner, never to this machine's player —
        // the second half of the localPlayer disease (see the gate above, and bug 4).
        void this.spawnUnit(def, pb.x, pb.y, w.owner, this.teamOf(w.owner), def.buildTime || 60).then((simId) => {
          this.buildSpawning.delete(workerId);
          if (simId !== null) {
            world.assignBuilder(workerId, simId); // clears buildPending
            this.playSummonGesture(workerId);
          } else world.cancelPendingBuild(workerId); // model failed to load → refund
        });
        continue;
      }
      // Units are standing where the building must go: shove our own off the
      // footprint and count down the patience window; when it expires, cancel
      // (the sim refunds the spent cost).
      this.clearFootprint(fp!, pb.x, pb.y, occupants);
      const waited = (this.buildWait.get(w.id) ?? 0) + dt;
      if (waited >= BUILD_CLEAR_TIMEOUT) {
        this.buildWait.delete(w.id);
        world.cancelPendingBuild(w.id);
      } else {
        this.buildWait.set(w.id, waited);
      }
    }
  }

  /** Movable ground units whose hull overlaps a building footprint (excluding the
   *  builder). These are what must vacate before the structure can rise. */
  private footprintOccupants(fp: Footprint, x: number, y: number, excludeId: number): SimUnit[] {
    const world = this.rts!.simWorld;
    const halfW = fp.w * 16; // cell = 32 world units → half-extent = cells × 16
    const halfH = fp.h * 16;
    const out: SimUnit[] = [];
    for (const u of world.units.values()) {
      if (u.id === excludeId || u.building || u.flying || u.speed <= 0) continue;
      if (Math.abs(u.x - x) < halfW + u.radius && Math.abs(u.y - y) < halfH + u.radius) out.push(u);
    }
    return out;
  }

  /** Order our own footprint occupants to step off the site (radially outward).
   *  Only pushes settled units so a unit already walking away isn't re-pathed
   *  every frame; foreign units we can't command stay and let the timeout fire. */
  private clearFootprint(fp: Footprint, x: number, y: number, occupants: SimUnit[]): void {
    const world = this.rts!.simWorld;
    const push = Math.max(fp.w, fp.h) * 16 + 96; // clear of the footprint edge
    for (const u of occupants) {
      if (u.owner !== this.localPlayer || u.moving) continue;
      let dx = u.x - x;
      let dy = u.y - y;
      const d = Math.hypot(dx, dy);
      if (d < 1) { dx = 1; dy = 0; } // dead-centre → push along +x
      const n = Math.hypot(dx, dy);
      world.issueMove(u.id, x + (dx / n) * push, y + (dy / n) * push);
    }
  }

  private teamOf(owner: number): number {
    return this.meleeTeams.get(owner) ?? owner;
  }

  /** Send a freshly-produced unit to its building's rally target: harvest a
   *  rallied mine/tree (workers only), follow a rallied unit, or move to a plain
   *  point. Falls back to the stored point when a smart target is gone (mine mined
   *  out, tree felled, unit dead — WC3's "last spot"). */
  private applyRally(simId: number, rally: { kind: RallyKind; targetId: number; x: number; y: number }): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    // No flag has been planted — the unit stays where it came out. WC3 gives a building no
    // default rally point, so this is the ordinary case, not an edge one.
    if (rally.kind === "none") return;
    const u = world.units.get(simId);
    if (!u) return;
    if (rally.kind === "mine" && u.worker?.gold && world.mines.has(rally.targetId)) {
      // issueGoldWork, not issueHarvest: an ENTANGLED mine is not mined, it is MANNED, and a
      // wisp rallied at one climbs inside it (see issueGoldWork). Rallied at a bare mine a
      // wisp has no pick and falls through to the move below, as it should.
      if (world.issueGoldWork(simId, rally.targetId)) return;
    } else if (rally.kind === "tree" && u.worker?.lumber && world.trees.has(rally.targetId)) {
      if (world.issueHarvest(simId, "lumber", rally.targetId)) return;
    } else if (rally.kind === "unit") {
      const t = world.units.get(rally.targetId);
      // Follow the rallied unit rather than moving to its frozen spawn-time spot,
      // so the new unit trails the leader as it moves (issue #32).
      if (t) { world.issueFollow(simId, rally.targetId); return; }
    }
    world.issueMove(simId, rally.x, rally.y);
  }

  // --- selection circles (flat ground models) -------------------------------

  private async loadSelectionCircles(): Promise<void> {
    const map = this.viewer.map;
    if (!map) return;
    // Selection/hover/preview/flash rings are no longer flat MDX models — they're painted
    // through the ringSplats overlay (terrain-conforming, issue #34). Only the 3D order
    // feedback (rally flag, queue flags, confirmation arrows) stays as real models below.
    // Move/attack order-confirmation arrows (one model, tinted per order type).
    this.arrowModel = ((await this.viewer.load("UI\\Feedback\\Confirmation\\Confirmation.mdx", this.solver)) as SpawnModel | undefined) ?? null;
    // Preload the local race's cancel-explosion so the first cancel is instant.
    const cancelPath = CANCEL_FX[this.localRace];
    void this.viewer.load(cancelPath, this.solver).then((m) => this.effectModels.set(cancelPath, (m as SpawnModel | undefined) ?? null));
    // Rally flag shown at a selected building's rally point, and the smaller waypoint flag
    // dropped on each shift-queued order. Both are per-race art, and war3skins.txt is where
    // the game itself keeps that mapping — `[Orc] RallyIndicatorDst=…\OrcRallyFlag.mdl`,
    // `WaypointIndicator=…\OrcWaypointFlag.mdl` — so they resolve through the same skin
    // table (the LOCAL player's race) that dresses the console and the rally button icon.
    this.rallyFlag = await this.spawnFlag(this.skinModel("RallyIndicatorDst"));
    this.queueFlagModel = ((await this.viewer.load(this.skinModel("WaypointIndicator"), this.solver)) as SpawnModel | undefined) ?? null;
  }

  /** A war3skins.txt model key → a loadable path. The table spells every model `.mdl` (the
   *  World Editor's own spelling) and the archives ship the compiled `.mdx` — same fixup the
   *  campaign backdrops need (data/campaigns.ts). */
  private skinModel(key: string): string {
    return this.skinPath(key).replace(/\.mdl$/i, ".mdx");
  }

  /** Load a flag model and put one hidden, looping instance of it in the world. */
  private async spawnFlag(path: string): Promise<SpawnInstance | null> {
    const model = (await this.viewer.load(path, this.solver)) as SpawnModel | undefined;
    const map = this.viewer.map;
    if (!model || !map) return null;
    const inst = model.addInstance();
    inst.setScene(map.worldScene);
    // Play the waving clip by NAME: the human flags carry a Birth clip at index 0 and Stand
    // at 1, the other three races ship Stand alone — so a hard-coded 0 loops the human
    // flag's pop-in forever and waves for everyone else.
    inst.setSequence(Math.max(0, this.seqIndex(inst, /^stand/i)));
    inst.setSequenceLoopMode(2); // loop always
    inst.hide();
    return inst;
  }

  /** Get (or lazily create) the i-th small queue flag — one per queued order of the current
   *  selection. This is its own model (WaypointFlag), natively about half the rally flag's
   *  height, rather than the rally flag scaled down. */
  private queueFlag(i: number): SpawnInstance | null {
    const scene = this.viewer.map?.worldScene;
    if (!this.queueFlagModel || !scene) return null;
    while (this.queueFlags.length <= i) {
      const inst = this.queueFlagModel.addInstance();
      inst.setScene(scene);
      inst.setSequence(Math.max(0, this.seqIndex(inst, /^stand/i)));
      inst.setSequenceLoopMode(2); // loop the waving clip
      inst.hide();
      this.queueFlags.push(inst);
    }
    return this.queueFlags[i];
  }

  /** Spawn a converging-arrows marker for the newest move/attack-move order and
   *  time out the live one (the model plays once, then we detach it).
   *
   *  Only the most recent order matters, so we keep a SINGLE live instance and
   *  reset its animation (re-tint, re-place, restart the clip) instead of adding
   *  a fresh instance per click. Spamming orders would otherwise pile up a stack
   *  of overlapping arrows — this reuse both fixes that and avoids create/detach
   *  churn each frame. */
  private updateOrderArrows(dt: number): void {
    const map = this.viewer.map;
    const reqs = this.rts?.drainOrderArrows() ?? [];
    if (reqs.length && map && this.arrowModel) {
      const req = reqs[reqs.length - 1]; // newest order wins; drop any earlier ones
      let a = this.orderArrows[0];
      if (!a) {
        const inst = this.arrowModel.addInstance();
        inst.setScene(map.worldScene);
        a = { inst, t: 0 };
        this.orderArrows.push(a);
      }
      this.loc3[0] = req.x;
      this.loc3[1] = req.y;
      this.loc3[2] = req.z + 4; // just above the ground
      a.inst.setLocation(this.loc3);
      a.inst.setVertexColor(req.color);
      a.inst.setSequence(0); // restart the single-shot "converge" clip from frame 0
      a.inst.setSequenceLoopMode(0); // play once
      a.inst.show();
      a.t = 0.9;
    }
    for (let i = this.orderArrows.length - 1; i >= 0; i--) {
      const a = this.orderArrows[i];
      a.t -= dt;
      if (a.t <= 0) {
        a.inst.detach();
        this.orderArrows.splice(i, 1);
      }
    }
  }

  /** The sequence an effect model should play: its "Birth" clip if it has one, else
   *  the first sequence with a SANE interval. Some WC3 effect models (e.g.
   *  ThunderClapCaster) put a junk `nothing [4294966896-400]` clip at index 0 and the
   *  real animation ("stand"/"birth") later — blindly playing index 0 shows nothing,
   *  which is why Thunder Clap's shockwave never animated (issue #19). */
  private effectSequence(inst: SpawnInstance): number {
    const seqs = inst.model?.sequences ?? [];
    const birth = seqs.findIndex((s) => /birth/i.test(s.name));
    if (birth >= 0) return birth;
    const sane = seqs.findIndex((s) => {
      const iv = s.interval;
      return iv && iv[0] >= 0 && iv[0] < 1e7 && iv[1] > iv[0];
    });
    return sane >= 0 ? sane : 0;
  }

  /** The sequence a missile should play while it FLIES: its "Stand" clip.
   *
   *  A WC3 missile model carries three clips — Birth (the launch flash), Stand (the
   *  in-flight loop: the spinning bolt, the ribbon trail, the particle emitters) and
   *  Death (the impact burst, played by impactProjectile). Their ORDER in the file is
   *  not fixed, and that is the whole bug: FarseerMissile happens to list
   *  `[0] Stand | [1] Birth | [2] Death`, so playing index 0 blindly looked right,
   *  while ShadowHunterMissile lists `[0] Birth | [1] "Stand -1" | [2] Death` — so the
   *  Shadow Hunter's bolt looped a 34ms Birth clip forever and never animated.
   *  SerpentWardMissile (the wards he summons) has the same Birth-first layout.
   *
   *  Match `/^stand/i`, not `/^stand$/i`: WC3 suffixes a clip name with its rarity
   *  ("Stand -1"), and that suffix is part of the sequence name in the MDX. */
  private missileSequence(inst: SpawnInstance): number {
    const seqs = inst.model?.sequences ?? [];
    const stand = seqs.findIndex((s) => /^stand/i.test(s.name));
    return stand >= 0 ? stand : this.effectSequence(inst);
  }

  /** Loop keys of the channelled fields that were running last frame, so a field that
   *  has since ended can have its bed stopped (`FIELD_LOOP_SOUND`). */
  private fieldLoops = new Set<string>();
  /** True while this client's camera is being shaken by an Earthquake (see updateFieldLoops).
   *  Tracked so the noise is set once on each edge rather than every frame — and so it is
   *  cleared when the quake ends without stamping on a cinematic that set its own. */
  private quaking = false;

  /** Reconcile the looping bed of every running channelled field against last frame:
   *  start one for each new field, stop the ones whose field is gone. Keyed by code +
   *  position so two simultaneous Blizzards each howl at their own spot. */
  private updateFieldLoops(fields: Array<{ code: string; x: number; y: number; loopSound: string; shake: boolean }>): void {
    const live = new Set<string>();
    // Earthquake is the one thing in the game that moves the CAMERA as a gameplay effect,
    // and Blizzard.j says how: `CameraSetEQNoiseForPlayer` → `CameraSetTargetNoiseEx(…,
    // vertOnly = true)`, i.e. the ground bucks rather than sliding sideways. Felt only if
    // you are looking anywhere near it — the rumble belongs to the shot, not to the match.
    const quake = fields.some((f) => f.shake && Math.hypot(f.x - this.target[0], f.y - this.target[1]) < EQ_FEEL_RANGE);
    if (quake !== this.quaking) {
      this.quaking = quake;
      this.scriptCam.setNoise(false, quake ? EQ_MAGNITUDE : 0, quake ? EQ_VELOCITY : 0, true);
    }
    for (const f of fields) {
      const wav = this.sounds?.abilityLoopPath(f.loopSound) ?? "";
      if (!wav) continue;
      const key = `${f.code}|${Math.round(f.x)}|${Math.round(f.y)}`;
      live.add(key);
      if (!this.fieldLoops.has(key)) {
        this.fieldLoops.add(key);
        this.sounds?.setPathLoop(key, wav, true, { x: f.x, y: f.y, z: this.rts!.groundHeightAt(f.x, f.y) });
      }
    }
    for (const key of this.fieldLoops) {
      if (live.has(key)) continue;
      this.fieldLoops.delete(key);
      this.sounds?.setPathLoop(key, "", false);
    }
  }

  /** Play a one-shot spawn-effect model (its "Birth" clip) at a point, then detach it
   *  after `life` seconds. Model is loaded+cached on demand. */
  private async spawnEffect(path: string, x: number, y: number, z: number, life = 2.5): Promise<void> {
    const map = this.viewer.map;
    if (!map) return;
    let model = this.effectModels.get(path);
    if (model === undefined) {
      model = ((await this.viewer.load(path, this.solver)) as SpawnModel | undefined) ?? null;
      this.effectModels.set(path, model);
    }
    if (!model || !this.viewer.map) return;
    const inst = model.addInstance();
    inst.setScene(map.worldScene);
    this.loc3[0] = x;
    this.loc3[1] = y;
    this.loc3[2] = z;
    inst.setLocation(this.loc3);
    inst.setSequence(this.effectSequence(inst));
    inst.setSequenceLoopMode(0); // play once
    inst.show();
    this.effects.push({ inst, t: life });
  }

  /** Spawn the ground model for a dropped item (its own .mdx, looping its stand/
   *  birth clip) at the item's position. Cached by model path like spell effects. */
  private async spawnItemModel(itemId: number, itemDefId: string, x: number, y: number): Promise<void> {
    if (this.itemInstances.has(itemId) || this.itemLoading.has(itemId)) return;
    const def = this.items.get(itemDefId);
    const path = def?.model || "Objects\\InventoryItems\\TreasureChest\\treasurechest.mdx";
    this.itemLoading.add(itemId);
    let model = this.effectModels.get(path);
    if (model === undefined) {
      model = ((await this.viewer.load(path, this.solver)) as SpawnModel | undefined) ?? null;
      this.effectModels.set(path, model);
    }
    this.itemLoading.delete(itemId);
    const map = this.viewer.map;
    // The item may have been picked up while its model was still loading.
    if (!model || !map || !this.rts?.simView.items.has(itemId) || this.itemInstances.has(itemId)) return;
    const inst = model.addInstance();
    inst.setScene(map.worldScene);
    this.loc3[0] = x;
    this.loc3[1] = y;
    this.loc3[2] = this.rts.groundHeightAt(x, y);
    inst.setLocation(this.loc3);
    if (def && def.scale !== 1) inst.setUniformScale(def.scale);
    const seqs = inst.model?.sequences ?? [];
    const stand = seqs.findIndex((s) => /^stand/i.test(s.name)); // "Stand - 1" (open idle)
    const birth = seqs.findIndex((s) => /birth/i.test(s.name));
    const standIdx = stand >= 0 ? stand : this.effectSequence(inst);
    // The treasure chest (the shared default item model) sinks into the ground during
    // its Birth clip, so it just loops its open "Stand" idle. Other item models (tomes,
    // pot of gold, …) play Birth ONCE on spawn, then switch to looping their Stand idle.
    if (/treasurechest/i.test(path) || birth < 0) {
      inst.setSequence(standIdx);
      inst.setSequenceLoopMode(2); // loop the open idle
    } else {
      inst.setSequence(birth);
      inst.setSequenceLoopMode(0); // play birth once, then hand off to Stand (below)
      const birthEnd = seqs[birth]?.interval?.[1] ?? 0;
      this.itemBirthing.push({ id: itemId, inst, standIdx, birthEnd });
    }
    // An item dropped where we have no eyes (a creep camp cleared across the map by an
    // ally) starts hidden rather than blinking into the black for a frame.
    const visible = this.rts.itemVisible(itemId);
    if (visible) inst.show();
    else inst.hide();
    this.itemShown.set(itemId, visible);
    this.itemInstances.set(itemId, inst);
  }

  /** Drop a ground item's model. `died` = it was consumed where it lay (a powerup taken
   *  off the ground), so it plays its DEATH clip out instead of blinking away — the same
   *  courtesy fadeOutFx does for buff art, and the mechanism behind the little burst left
   *  behind: every powerup ground model fires a spawn event on its death track (the tomes,
   *  glyph and runes an `SPN…TOBO` → Objects\Spawnmodels\Other\ToonBoom\ToonBoom.mdl, the
   *  Chest of Gold an `SPN…GDCR` → UI\Feedback\GoldCredit\GoldCredit.mdl), which the mdx
   *  handler spawns for us off Splats\SpawnData.slk. Death lengths run 233ms (runes, pot
   *  of gold) to 3633ms (tomes) — verified against the 1.27a models. */
  private removeItemModel(itemId: number, died = false): void {
    const inst = this.itemInstances.get(itemId);
    if (inst) {
      // Only a VISIBLE item earns a death: one that died under fog would otherwise sit
      // out its clip hidden, and the fog pass no longer tracks it to reveal it anyway.
      if (died && this.itemShown.get(itemId)) this.fadeOutFx(inst);
      else inst.detach();
      this.itemInstances.delete(itemId);
    }
    this.itemShown.delete(itemId);
    const bi = this.itemBirthing.findIndex((b) => b.id === itemId);
    if (bi >= 0) this.itemBirthing.splice(bi, 1);
  }

  /** Hide a ground item that no longer has eyes on it. An item is a live widget, not a
   *  remembered building: WC3 shows it only while the ground it lies on is actually
   *  visible, so it winks out with the fog rather than sitting in the black. */
  private updateItemFog(): void {
    if (!this.rts) return;
    for (const [id, inst] of this.itemInstances) {
      const visible = this.rts.itemVisible(id);
      if (visible === this.itemShown.get(id)) continue; // only touch it when it changes
      this.itemShown.set(id, visible);
      if (visible) inst.show();
      else inst.hide();
    }
  }

  /** Hand a birthing item off to its looping Stand idle once the Birth clip ends. */
  private updateItemAnims(): void {
    for (let i = this.itemBirthing.length - 1; i >= 0; i--) {
      const b = this.itemBirthing[i];
      if (b.inst.frame >= b.birthEnd) {
        b.inst.setSequence(b.standIdx);
        b.inst.setSequenceLoopMode(2); // loop the open idle for the rest of its life
        this.itemBirthing.splice(i, 1);
      }
    }
  }

  /** Draw the live lightning bolts (issue #97).
   *
   *  The overlay owns the geometry; this owns the ANSWER to "where are this bolt's two ends
   *  right now", which only the scene can give: a unit's live position out of the world (the
   *  sim's where it steps, the payload's records on a frozen client), the terrain height
   *  under it, and whether the local viewpoint may see it at all. A unit that has left the
   *  world entirely doesn't kill the bolt — it stays anchored where that end last was, which
   *  is what a Finger of Death striking a unit it kills has to look like. */
  private renderLightning(camera: { viewProjectionMatrix: Float32Array; location: Float32Array }): void {
    const overlay = this.lightning;
    const rts = this.rts;
    if (!overlay || !rts || overlay.count === 0) return;
    const units = rts.simView.units;
    overlay.render(camera.viewProjectionMatrix, camera.location, (b) => {
      const src = b.srcId ? units.get(b.srcId) : undefined;
      const dst = b.dstId ? units.get(b.dstId) : undefined;
      const sx = src ? src.x : b.sx;
      const sy = src ? src.y : b.sy;
      const tx = dst ? dst.x : b.tx;
      const ty = dst ? dst.y : b.ty;
      // Seen if EITHER end is: a bolt reaching out of the fog into your army is a bolt you
      // watch land, and that is how WC3 shows it too.
      const visible = (b.srcId !== 0 && rts.unitImageShown(b.srcId)) || (b.dstId !== 0 && rts.unitImageShown(b.dstId)) || (b.srcId === 0 && b.dstId === 0);
      return {
        sx,
        sy,
        sz: rts.groundHeightAt(sx, sy) + b.sz + (src?.flyHeight ?? 0),
        tx,
        ty,
        tz: rts.groundHeightAt(tx, ty) + b.tz + (dst?.flyHeight ?? 0),
        visible,
      };
    });
  }

  private updateEffects(dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t -= dt;
      if (e.t <= 0) {
        e.inst.detach();
        this.effects.splice(i, 1);
      }
    }
  }

  // --- Temporary spell ground splats (Thunder Clap's scorch) -----------------------
  //
  // Same overlay as a building's foundation decal, but on a clock: an UberSplatData row
  // gives the texture, the half-width and an alpha envelope — fade in over BirthTime,
  // hold PauseTime at full, fade out over Decay (THND: 0.2 / 2 / 2, StartA=0 MiddleA=255
  // EndA=0). Ids are unique per cast so two claps overlap instead of replacing each other.
  private spellSplats: Array<{ key: string; t: number; birth: number; pause: number; decay: number }> = [];
  private nextSpellSplatId = 1;

  private addSpellSplat(splatId: string, x: number, y: number): void {
    if (!this.splats) return;
    const s = this.uberSplatRegistry().get(splatId);
    if (!s) return;
    const key = `fx:${splatId}:${this.nextSpellSplatId++}`;
    this.splats.add(key, x, y, s.scale, s.texture, { alpha: 0 }); // opens at StartA = 0
    this.spellSplats.push({ key, t: 0, birth: s.birthTime, pause: s.pauseTime, decay: s.decay });
  }

  private updateSpellSplats(dt: number): void {
    for (let i = this.spellSplats.length - 1; i >= 0; i--) {
      const s = this.spellSplats[i];
      s.t += dt;
      const a = s.t < s.birth ? s.t / s.birth : s.t < s.birth + s.pause ? 1 : 1 - (s.t - s.birth - s.pause) / (s.decay || 1);
      if (a <= 0) {
        this.splats?.remove(s.key);
        this.spellSplats.splice(i, 1);
      } else {
        this.splats?.setAlpha(s.key, Math.min(1, a));
      }
    }
  }

  // --- Mirror Image missiles ------------------------------------------------------
  //
  // Pure decoration: the sim has already decided where each one lands and when, and puts
  // the image (or the hero) there on its own clock. These just have to be seen arriving,
  // so they lerp start→destination over the sim's own flight time and detach on landing.
  private mirrorMissiles: Array<{ inst: SpawnInstance; sx: number; sy: number; tx: number; ty: number; t: number; flight: number }> = [];

  private async spawnMirrorMissile(m: { art: string; sx: number; sy: number; tx: number; ty: number; flight: number }): Promise<void> {
    const map = this.viewer.map;
    if (!map || !m.art) return;
    let model = this.effectModels.get(m.art);
    if (model === undefined) {
      model = ((await this.viewer.load(m.art, this.solver)) as SpawnModel | undefined) ?? null;
      this.effectModels.set(m.art, model);
    }
    if (!model || !this.viewer.map) return;
    const inst = model.addInstance();
    inst.setScene(map.worldScene);
    inst.setSequence(this.effectSequence(inst));
    inst.setSequenceLoopMode(2);
    inst.show();
    this.mirrorMissiles.push({ inst, sx: m.sx, sy: m.sy, tx: m.tx, ty: m.ty, t: 0, flight: m.flight });
  }

  private updateMirrorMissiles(dt: number): void {
    for (let i = this.mirrorMissiles.length - 1; i >= 0; i--) {
      const m = this.mirrorMissiles[i];
      m.t += dt;
      const k = Math.min(1, m.t / m.flight);
      const x = m.sx + (m.tx - m.sx) * k;
      const y = m.sy + (m.ty - m.sy) * k;
      this.loc3[0] = x;
      this.loc3[1] = y;
      // A shallow arc so it reads as thrown rather than dragged along the floor.
      this.loc3[2] = (this.rts?.groundHeightAt(x, y) ?? 0) + Math.sin(k * Math.PI) * 60;
      m.inst.setLocation(this.loc3);
      if (k >= 1) {
        m.inst.detach();
        this.mirrorMissiles.splice(i, 1);
      }
    }
  }

  // Persistent per-unit buff models: a looping effect worn by a unit for as long as
  // it carries a given buff. Pooled by a stable key so it's created once and detached
  // when the buff falls off. Two families feed this, both data-driven:
  //   • auras — WC3 shows TWO models: a BIG one under the aura's OWNER only (the
  //     ability's own TargetArt, e.g. DevotionAura) and a SMALL swirl under EVERY
  //     affected unit incl. the owner (the buff's TargetArt = GeneralAuraTarget).
  //   • single-target buffs that carry their own art (Banish's ethereal BanishTarget).
  private buffFx = new Map<string, SpawnInstance>();
  private buffFxLoading = new Set<string>();
  /** buffFx keys whose instance is parented to an attachment node — it moves with the
   *  unit on its own, so trackBuffFx must not fight it with a ground setLocation. */
  private buffFxParented = new Set<string>();
  /** buffFx keys still playing their Birth clip (settleBuffFx moves them to Stand). */
  private buffFxBirthing = new Set<string>();
  /** Models playing out their Death clip before leaving the scene — buff art whose buff
   *  ended (dropBuffFx) and script effects a trigger destroyed (destroySpecialFx). */
  private dyingFx: Array<{ inst: SpawnInstance; ttl: number }> = [];
  private abilityByCode: Map<string, AbilityDef> | null = null;
  /** First ability def with the given base code (aura visuals only need its art). */
  private abilityDefByCode(code: string): AbilityDef | undefined {
    if (!this.abilityByCode) {
      this.abilityByCode = new Map();
      for (const a of this.abilities.all()) if (!this.abilityByCode.has(a.code)) this.abilityByCode.set(a.code, a);
    }
    return this.abilityByCode.get(code);
  }
  private updateAuraEffects(): void {
    const world = this.rts?.simWorld;
    const map = this.viewer.map;
    if (!world || !map) return;
    const active = new Set<string>();
    for (const u of world.units.values()) {
      if (u.hp <= 0 || !u.buffs.length) continue;
      const seen = new Set<string>();
      for (const b of u.buffs) {
        // Aura buffs are grouped "code:kind". A colon alone does NOT make one, though:
        // the item buffs are grouped "item:invuln" / "item:regen" too, and treating those
        // as auras dropped their art on the floor — a Potion of Invulnerability showed no
        // bubble and a Healing Salve no swirl, because the group's first half named no
        // ability and the loop skipped the unit entirely instead of falling through. So an
        // aura is a group whose first half RESOLVES to an ability, and everything else is a
        // plain single-target buff wearing its own models.
        const auraCode = b.group.includes(":") ? b.group.split(":")[0] : "";
        const def = auraCode ? this.abilityDefByCode(auraCode) : undefined;
        if (def) {
          if (seen.has("a:" + auraCode)) continue;
          seen.add("a:" + auraCode);
          // Small swirl on every affected unit; big model on the owner only (its own
          // aura copy carries sourceId === its id — allies get the owner's id).
          def.buffFx.forEach((fx, i) => this.trackBuffFx(active, `${u.id}|${auraCode}|s${i}`, fx, u.id));
          if (b.sourceId === u.id) this.trackBuffFx(active, `${u.id}|${auraCode}|o`, { path: def.targetArt, attach: [] }, u.id);
        } else if (b.fx.length) {
          // Key off the models themselves, not `art`: a buff whose fx came from its own
          // [B….] row (the regeneration items) leaves `art` empty, so two such buffs on one
          // unit would share the key "b:" and the second would be dropped as a duplicate.
          const key = b.art || b.fx[0].path;
          if (seen.has("b:" + key)) continue;
          seen.add("b:" + key);
          b.fx.forEach((fx, i) => this.trackBuffFx(active, `${u.id}|${key}|${i}`, fx, u.id));
        }
      }
    }
    this.collectShopArrows(active);
    this.collectOrbAttachments(active);
    this.collectMoonWellWater(active);
    this.collectMineCircles(active);
    for (const [key, inst] of this.buffFx) {
      if (!active.has(key)) this.dropBuffFx(key, inst);
    }
  }

  /**
   * The ORB a hero is carrying, worn on its model.
   *
   * An orb item's ability names both the model and the bone:
   *
   *     [AIfb]  Targetart    = Abilities\Spells\Items\AIfb\AIfbTarget.mdl
   *             Targetattach = weapon
   *
   * — and despite the "Target" in the field name that model is not a hit effect on the
   * victim: it is a single LOOPING `Stand` sequence (verified by parsing AIfbTarget,
   * AIobTarget, AIlbTarget, OrbVenom, OrbCorruption and OrbDarkness out of the install), i.e.
   * the glowing sphere that orbits the hero's weapon hand for as long as the orb is in the
   * bag. `Targetattach` is the attachment node to hang it from, in the same token form a
   * buff's is, so it rides the identical persistent-FX pool: found → parented to the bone and
   * animated by the hero's own skeleton, not found → left at the unit's origin.
   *
   * Not exclusive, unlike the on-hit effect: carrying two orbs shows two orbs, because
   * wearing one asks nothing of the priority ladder (src/sim/orbs.ts). The Mask of Death is
   * the deliberate blank — its row writes `Targetart=` with nothing after it.
   */
  private collectOrbAttachments(active: Set<string>): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    for (const u of world.units.values()) {
      if (u.hp <= 0 || !u.inventory.length) continue;
      world.orbAttachments(u).forEach((fx, i) => this.trackBuffFx(active, `orb|${u.id}|${i}|${fx.path}`, fx, u.id));
    }
  }

  /**
   * The five marks a Haunted Gold Mine paints on the ground for its crew.
   *
   * The ring is not an invisible convention: WC3 draws a rune circle on every one of the
   * stations an Acolyte may kneel at, which is what makes a mine with three of the five taken
   * legible at a glance — and what makes a crew that stops *near* its spots read as broken.
   * They are placed from `SimWorld.mineRingStations`, the same answer `tickRingHarvest` walks
   * the Acolytes to, so the mark and the miner cannot disagree.
   *
   * How many and how far out is `Abgm`'s own data (`DataC1` = 5 Max Number of Miners,
   * `DataD1` = 200 Radius of Mining Ring), never a count typed in here — a map that widens
   * the ring or seats a sixth Acolyte gets the marks to match for free. The Entangled Gold
   * Mine has none, and its row says why: its crew is CARGO, so `mineCrewOf` gives it ring 0
   * and `mineRingStations` hands back nothing.
   *
   * The lifecycle comes from the model. `UndeadMineCircle.mdx` authors Birth · Stand · Death
   * and nothing else, which is exactly the three acts the persistent-FX pool plays: the
   * circles bloom as the haunting finishes (they are withheld while the structure is still
   * rising), hold while it stands, and play their Death when the record goes — mined out, or
   * knocked down by an enemy and left as the bare rock it was.
   */
  private collectMineCircles(active: Set<string>): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    for (const u of world.units.values()) {
      if (u.hp <= 0 || !u.mineId) continue;
      if (u.building && u.building.constructionLeft > 0) continue; // still being haunted
      const stations = world.mineRingStations(u);
      for (let i = 0; i < stations.length; i++) {
        const key = `minering|${u.id}|${i}`;
        this.trackBuffFx(active, key, MINE_CIRCLE_FX, u.id, undefined, true);
        const inst = this.buffFx.get(key);
        if (!inst) continue;
        const [sx, sy] = stations[i];
        this.loc3[0] = sx;
        this.loc3[1] = sy;
        this.loc3[2] = this.rts!.groundHeightAt(sx, sy);
        inst.setLocation(this.loc3);
        // …and TURNED to face the mine. The mark is not radially symmetric: it is a broken
        // ring whose open side — the straight bar the runes hang off — is the side the
        // Acolyte kneels on, so every one of the five has to be rolled around the building
        // like numbers on a clock face. Unrotated they all pointed the same way and four of
        // the five read as litter dropped on the ground.
        //
        // The half-turn is the model's own zero: `UndeadMineCircle.mdx` is authored with its
        // bar along −X, so the heading that puts the bar INTO the mine is the one pointing
        // away from it. Measured against the real client rather than assumed from the usual
        // "models face +X".
        const face = Math.atan2(sy - u.y, sx - u.x);
        this.mq[0] = 0;
        this.mq[1] = 0;
        this.mq[2] = Math.sin(face / 2);
        this.mq[3] = Math.cos(face / 2);
        inst.setRotation(this.mq);
      }
    }
  }

  /**
   * The WATER in a Moon Well, whose level is the well's mana.
   *
   * `[Ambt] Effectart` is a five-entry list and the data's own comment says what the five
   * are: "One for each normal race, and a special one for demons and their corrupted moon
   * well." That is a list of WELLS, not of drinkers — the model is the pool of water sitting
   * in the basin, and the corrupted twin is the one a demon player's well wears. Reading it
   * as an effect to throw at whoever drinks is the bug this replaces: the water model flew to
   * the drinking unit and evaporated a few seconds later.
   *
   * The LEVEL is the same trick the loading bar uses (docs/loading-screens.md): the clip
   * animates the surface from empty to full and the engine simply parks the playhead — mana
   * fraction along the interval, `timeScale` 0 so it holds there. `forced` makes the pose
   * follow a frame written from outside (the viewer only re-samples bones for animations it
   * advanced itself). So a full well brims, a drained one shows bare stone, and a well
   * refilling through the night visibly climbs.
   *
   * Rides the persistent-FX pool like buff art, so it gets the Birth → Stand lifecycle, the
   * `origin` attachment and the tidy-up when the well dies for free. A well still under
   * construction has no mana and no water (recomputeStats withholds the pool until it is
   * finished), which is also what the game shows.
   */
  private collectMoonWellWater(active: Set<string>): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    for (const u of world.units.values()) {
      if (u.hp <= 0 || u.maxMana <= 0) continue;
      if (u.building && u.building.constructionLeft > 0) continue;
      const ab = u.abilities.find((a) => a.code === "Ambt" && a.level >= 1);
      const art = ab && this.abilities.get(ab.id)?.effectArt;
      if (!art) continue;
      const key = `well|${u.id}`;
      // Unattached, and placed by hand below. The model is a flat hexagon of rippling water
      // that carries its own height above wherever it is put, so it wants the well's CENTRE
      // and a lift — hung off a bone instead it inherits that bone's offset (`Sprite First
      // Ref` is on the rim, and the pool ends up half off the rock), and left at the unit's
      // feet it sits inside the stone, drawn and invisible.
      this.trackBuffFx(active, key, { path: art, attach: [] }, u.id, undefined, true);
      const inst = this.buffFx.get(key);
      if (!inst) continue;
      const stand = this.seqIndex(inst, /^stand/i);
      const iv = stand >= 0 ? inst.model.sequences[stand]?.interval : undefined;
      if (stand < 0 || !iv || iv.length < 2) continue;
      if (inst.sequence !== stand) {
        inst.setSequence(stand);
        inst.setSequenceLoopMode(2);
        this.buffFxBirthing.delete(key); // it is a gauge, not a three-act effect
      }
      inst.timeScale = 0; // parked: the clip is a dial, not a loop
      inst.frame = iv[0] + Math.max(0, Math.min(1, u.mana / u.maxMana)) * (iv[1] - iv[0]);
      inst.forced = true;
      // Centred on the well and lifted into the basin. The building's OWN drawn height is the
      // reference rather than the terrain: a structure is seated above the ground it stands on
      // (seatHalfExtents), and its water has to rise with it.
      const host = this.rts?.unitInstance(u.id) as unknown as SpawnInstance | undefined;
      this.loc3[0] = u.x;
      this.loc3[1] = u.y;
      this.loc3[2] = (host?.localLocation[2] ?? this.rts!.groundHeightAt(u.x, u.y)) + MOON_WELL_WATER_LIFT;
      inst.setLocation(this.loc3);
    }
  }

  /** WC3's shop indicator: a team-coloured arrow that hangs over the unit which will take
   *  delivery of the local player's next purchase, for as long as it is standing in a
   *  shop's activation radius. Rides the same persistent-FX pool as buff art, so it gets
   *  the Birth → Stand(loop) → Death lifecycle and the `overhead` attachment for free.
   *
   *  On the model, and this is the trap: the ability data names `AneuCaster.mdl`, but in
   *  TFT that file is BROKEN for our purposes. War3.mpq's copy textures the arrow with
   *  `replaceableId 1` (the team-colour slot, which setTeamColor drives), while War3x.mpq
   *  OVERRIDES it with a copy that hardcodes `Textures\TeamColor01.blp` — player 0's red.
   *  Since the patch layering makes War3x win, using AneuCaster would paint every player's
   *  arrow red. `AneuTarget.mdl` is the same model — same single "Arrow" bone, same
   *  Birth/Stand/Death intervals, same MercArrow texture — with the team-colour slot
   *  intact, and it is what the ability names as its TARGET art (`Targetattach=overhead`),
   *  i.e. the one that belongs over the purchasing unit. So: target art, team colour works.
   *  (Verified by parsing both models out of both archives.) */
  private collectShopArrows(active: Set<string>): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    for (const unitId of world.shopArrowUnits(this.localPlayer)) {
      const key = `shoparrow|${unitId}`;
      this.trackBuffFx(active, key, SHOP_ARROW_FX, unitId, this.rts?.playerColor(this.localPlayer) ?? this.localPlayer);
    }
  }

  /** Dying models are no longer tracked by anything: hold each until its Death clip has
   *  played out (or its deadline passes), then take it off the scene. Ticked from the
   *  frame loop, not from updateAuraEffects — buff art is no longer its only source, and
   *  updateAuraEffects gives up early on a scene with no world. */
  private updateDyingFx(dt: number): void {
    for (let i = this.dyingFx.length - 1; i >= 0; i--) {
      const d = this.dyingFx[i];
      d.ttl -= dt;
      if (!d.inst.sequenceEnded && d.ttl > 0) continue;
      d.inst.setParent?.(null);
      d.inst.detach();
      this.dyingFx.splice(i, 1);
    }
  }

  /** Take a persistent effect model off the world the way the game does: play its Death
   *  clip out rather than snapping it out of existence (the shield pops, it doesn't blink
   *  off), then let updateDyingFx reap it. A model with no Death clip just leaves.
   *
   *  The instance stays PARENTED while it dies. Unparenting it first looks tempting —
   *  play the clip where it died — but an orphaned instance belongs to no scene, so
   *  nothing advances its animation and it freezes on Death's first frame forever
   *  (measured: frame stuck at 2333, the start of DivineShieldTarget's [2333,3000]).
   *  Staying parented also matches the game, where the pop happens on the unit. */
  private fadeOutFx(inst: SpawnInstance): void {
    const death = this.seqIndex(inst, /death/i);
    if (death < 0) {
      inst.setParent?.(null);
      inst.detach();
      return;
    }
    inst.setSequence(death);
    inst.setSequenceLoopMode(0);
    // Back the sequenceEnded check with a deadline: the clip's own length plus a beat.
    // If this instance's animation stops being driven at all — its host unit dies and
    // takes the attachment node with it — `sequenceEnded` never flips, and without a
    // deadline the instance would sit in this list for the rest of the match.
    const iv = inst.model.sequences[death]?.interval;
    const secs = iv && iv[1] > iv[0] ? (iv[1] - iv[0]) / 1000 : 1;
    this.dyingFx.push({ inst, ttl: secs + 0.5 });
  }

  /** The buff is gone: let the model die on the unit (fadeOutFx) rather than snapping it
   *  out of existence. */
  private dropBuffFx(key: string, inst: SpawnInstance): void {
    this.buffFx.delete(key);
    this.buffFxBirthing.delete(key);
    this.buffFxParented.delete(key);
    this.fadeOutFx(inst);
  }

  /** Mark a persistent buff model live this frame: (re)position an existing instance,
   *  or spawn it on demand. An empty path is a no-op (aura with no small/big model).
   *
   *  A buff model that found its attachment node is PARENTED to it (setParent), so it
   *  rides the unit's animation — Divine Shield's bubble stays around the Paladin,
   *  Bloodlust's flames stay on the moving hands — and needs no per-frame positioning.
   *  Only an unattached one is walked along the ground here. */
  private trackBuffFx(active: Set<string>, key: string, fx: BuffFx, simId: number, teamColor?: number, ground = false): void {
    if (!fx.path) return;
    active.add(key);
    const inst = this.buffFx.get(key);
    if (inst) {
      this.settleBuffFx(key, inst);
      if (this.buffFxParented.has(key)) return; // rides its attachment node
      const u = this.rts?.simView.units.get(simId);
      if (u) {
        this.loc3[0] = u.x;
        this.loc3[1] = u.y;
        this.loc3[2] = this.rts!.groundHeightAt(u.x, u.y);
        inst.setLocation(this.loc3);
      }
    } else if (!this.buffFxLoading.has(key)) {
      this.buffFxLoading.add(key);
      void this.spawnBuffFx(key, fx, simId, teamColor, ground);
    }
  }

  private async spawnBuffFx(key: string, fx: BuffFx, simId: number, teamColor?: number, ground = false): Promise<void> {
    const path = fx.path;
    let model = this.effectModels.get(path);
    if (model === undefined) {
      model = ((await this.viewer.load(path, this.solver)) as SpawnModel | undefined) ?? null;
      this.effectModels.set(path, model);
    }
    this.buffFxLoading.delete(key);
    const map = this.viewer.map;
    const u = this.rts?.simView.units.get(simId);
    if (!model || !map || !u || u.hp <= 0 || this.buffFx.has(key)) return;
    const inst = model.addInstance();
    inst.setScene(map.worldScene);
    // Team-coloured art (the shop arrow) resolves its `replaceableId 1` layer against the
    // owning player's slot, the same way a unit model does.
    if (teamColor !== undefined) inst.setTeamColor?.(teamColor);
    // `ground` opts out of attachment entirely — NOT the same as naming no tokens, which
    // attachmentNode reads as "the origin bone" and parents anyway. A model that carries its
    // own height above the unit's feet (the Moon Well's water) must stand on the ground and
    // inherit nothing, or the building's own transform swallows it.
    const host = ground ? undefined : (this.rts?.unitInstance(simId) as unknown as SpawnInstance | undefined);
    const node = host ? this.attachmentNode(host, fx.attach) : undefined;
    if (node) {
      inst.setParent?.(node); // ride the unit's own animated attachment point
      this.buffFxParented.add(key);
    } else {
      this.loc3[0] = u.x;
      this.loc3[1] = u.y;
      this.loc3[2] = this.rts!.groundHeightAt(u.x, u.y);
      inst.setLocation(this.loc3);
    }
    // A buff model is a three-act clip — Birth, Stand, Death (verified on
    // DivineShieldTarget.mdx and friends). Open on Birth, unlooped; settleBuffFx moves it
    // to a looping Stand the frame Birth ends, and dropBuffFx plays Death. Looping Birth
    // instead (what we used to do) replays the flash forever and the effect never settles.
    const birth = this.seqIndex(inst, /birth/i);
    if (birth >= 0) {
      inst.setSequence(birth);
      inst.setSequenceLoopMode(0); // play once, then settleBuffFx takes over
      this.buffFxBirthing.add(key);
    } else {
      // No Birth clip: there is no flash to open on, so go straight to the steady state —
      // the looping Stand. Mana Shield is the case that needs it. `ManaShieldCaster.mdx`
      // ships four sequences — `nothing`, `Stand First`, `Stand Second`, `Stand Third` (the
      // three strengths the sphere shows as it soaks damage) — and effectSequence, which
      // takes the first clip with a sane interval, picked **"nothing"**. So the Naga wore a
      // frozen yellow flare and no blue sphere at all, which is exactly the "wrong colour"
      // it looked like: the shield's own Blue_Star2/Blue_Glow2 layers only animate in Stand.
      const idle = this.seqIndex(inst, /^stand/i);
      inst.setSequence(idle >= 0 ? idle : this.effectSequence(inst));
      inst.setSequenceLoopMode(2);
    }
    inst.show();
    this.buffFx.set(key, inst);
  }

  /** Birth is done → settle into the looping Stand. A model with no Stand just holds its
   *  last Birth frame, which is what the game does too. */
  private settleBuffFx(key: string, inst: SpawnInstance): void {
    if (!this.buffFxBirthing.has(key)) return;
    if (!inst.sequenceEnded) return;
    this.buffFxBirthing.delete(key);
    const stand = this.seqIndex(inst, /^stand/i);
    if (stand < 0) return;
    inst.setSequence(stand);
    inst.setSequenceLoopMode(2); // the steady state: loop for the buff's lifetime
  }

  /** The attachment node on `host` for a buff's `Targetattach` tokens. WC3 names these
   *  nodes "<Tokens…> Ref" — verified against the real 1.27 MDXs (Paladin/Grunt/Footman/
   *  Headhunter/Crypt Fiend): "Origin Ref", "OverHead Ref", "Hand Left Ref", "Head - Ref".
   *
   *  Matching is a BEST match, not an exact one, because the data routinely asks for a
   *  point a given model doesn't have: Berserk wants `weapon,left` but a Headhunter
   *  carries a single "Weapon Ref", and Spiked Carapace's `chest,mount,left` has no
   *  mount on an unmounted unit. So: the first token (the body part) must match — it's
   *  what the effect is FOR, and without this test `weapon,left` would happily land on
   *  "Hand Left Ref" — then take the most qualifiers matched, tie-broken by the fewest
   *  extra words so `chest` picks "Chest Ref" over "Chest Mount Left Ref". A model with
   *  no such part at all falls back to its origin, as the engine does; only a model with
   *  no attachments returns undefined, leaving the caller to walk it along the ground. */
  private attachmentNode(host: SpawnInstance, attach: string[]): unknown {
    const atts = host.model?.attachments ?? [];
    if (!atts.length) return undefined;
    // No tokens named ("Targetattach" absent) means the model's root — same as origin.
    const want = attach.length ? attach : ["origin"];
    const wordsOf = (name: string) => name.toLowerCase().replace(/\bref\b/g, "").split(/[\s-]+/).filter(Boolean);
    let best = -1;
    let bestScore = 0;
    let bestExtra = Infinity;
    atts.forEach((a, i) => {
      const words = wordsOf(a.name);
      if (!words.includes(want[0])) return;
      const score = want.filter((t) => words.includes(t)).length;
      const extra = words.length - score;
      if (score > bestScore || (score === bestScore && extra < bestExtra)) {
        bestScore = score;
        bestExtra = extra;
        best = i;
      }
    });
    if (best < 0) best = atts.findIndex((a) => wordsOf(a.name).includes("origin"));
    return best >= 0 ? host.getAttachment?.(best) : undefined;
  }

  // --- Special effects: a trigger puts a model in the world (7.26 — issue #68) ------
  //
  // What AddSpecialEffect[Loc] / AddSpecialEffectTarget / DestroyEffect stand on. Same
  // models and the same three-act clip as a buff's art above (Birth → looping Stand →
  // Death), and deliberately the same attachmentNode — an `effect` on a unit is the same
  // thing on screen as a buff's Targetart, so it must ride the unit's animated node the
  // same way. What differs is WHO decides it should end: a buff's art is reconciled
  // against the sim every frame, but only the script knows when its effect is done, so
  // these are keyed by the engine id its `effect` handle carries and live until
  // destroySpecialFx.
  private specialFx = new Map<number, SpecialFx>();
  private nextSpecialFxId = 1;

  /** AddSpecialEffect[Loc] — a persistent model standing on the ground. */
  private addSpecialEffect(path: string, x: number, y: number): number {
    return this.createSpecialFx(path, -1, [], x, y);
  }

  /** AddSpecialEffectTarget — a persistent model riding a unit's attachment point. */
  private addSpecialEffectTarget(path: string, unitId: number, attach: string[]): number {
    const u = this.rts?.simView.units.get(unitId);
    if (!u) return -1;
    return this.createSpecialFx(path, unitId, attach, u.x, u.y);
  }

  /** Mint the id and start loading. The id is handed back SYNCHRONOUSLY — the script's very
   *  next line is routinely `set udg_SFX = GetLastCreatedEffectBJ()` and then a
   *  `DestroyEffect` on it, so the handle has to exist long before the model does. An
   *  effect destroyed while its model is still loading is marked `doomed` and never shows. */
  private createSpecialFx(path: string, hostId: number, attach: string[], x: number, y: number): number {
    // Script paths are ".mdl" as the World Editor spells them; the MPQ ships compiled ".mdx".
    const model = mdlPath(path);
    if (!model) return -1;
    const id = this.nextSpecialFxId++;
    const fx: SpecialFx = {
      inst: null, age: 0, spent: false, standing: false, standIdx: -1,
      clips: { hasBirth: false, birthStart: 0, birthSecs: 0, hasStand: false },
      hidden: true, hostId, attach, parented: false, x, y, doomed: false,
    };
    this.specialFx.set(id, fx);
    void this.loadSpecialFx(id, model, fx);
    return id;
  }

  private async loadSpecialFx(id: number, path: string, fx: SpecialFx): Promise<void> {
    let model = this.effectModels.get(path);
    if (model === undefined) {
      model = ((await this.viewer.load(path, this.solver)) as SpawnModel | undefined) ?? null;
      this.effectModels.set(path, model);
    }
    const map = this.viewer.map;
    // Destroyed (or the map torn down) while we were loading — never put it on screen.
    if (!model || !map || fx.doomed || this.specialFx.get(id) !== fx) {
      this.specialFx.delete(id);
      return;
    }
    const inst = model.addInstance();
    inst.setScene(map.worldScene);
    inst.hide(); // starts off-screen; updateSpecialFxOne below is the only thing that shows it
    // Read the model's clips once — specialFxPhaseAt turns them plus `age` into a phase.
    const birth = this.seqIndex(inst, /birth/i);
    fx.standIdx = this.seqIndex(inst, /^stand/i);
    const iv = birth >= 0 ? inst.model.sequences[birth]?.interval : undefined;
    fx.clips = {
      hasBirth: birth >= 0,
      birthStart: iv?.[0] ?? 0,
      birthSecs: iv && iv[1] > iv[0] ? (iv[1] - iv[0]) / 1000 : 0,
      hasStand: fx.standIdx >= 0,
    };
    if (birth >= 0) {
      inst.setSequence(birth);
      inst.setSequenceLoopMode(0); // play once; updateSpecialFxOne settles it into Stand
    } else {
      // No Birth to play out: it just loops the one clip it has, for as long as it lives.
      inst.setSequence(this.effectSequence(inst));
      inst.setSequenceLoopMode(2);
      fx.standing = true;
    }
    fx.inst = inst;
    this.placeSpecialFx(fx); // land it before its first frame is drawn
    // The model may have taken long enough to arrive that the effect is already over, or
    // it may be standing in fog: never show() blind — let the age/fog pass below decide.
    this.updateSpecialFxOne(fx);
  }

  /** Put an effect where it belongs this frame: parented to its host's attachment node if
   *  it has one, else standing on the ground at its point.
   *
   *  The parenting is RETRIED, not done once at spawn, because the two clocks don't line
   *  up: a trigger that spawns a monster and attaches art to it on the next line runs
   *  ahead of the renderer, whose model for that brand-new unit does not exist yet — and
   *  that is exactly (4)WarChasers' "Spawn One Monster". Parenting once, at spawn, would
   *  silently leave the art on the ground at the spawn point while the monster walked off. */
  private placeSpecialFx(fx: SpecialFx): void {
    const inst = fx.inst;
    if (!inst) return;
    if (fx.hostId >= 0 && !fx.parented) {
      const host = this.rts?.unitInstance(fx.hostId) as unknown as SpawnInstance | undefined;
      const node = host ? this.attachmentNode(host, fx.attach) : undefined;
      if (node) {
        inst.setParent?.(node);
        fx.parented = true;
        this.loc3[0] = this.loc3[1] = this.loc3[2] = 0; // the node IS the origin now
        inst.setLocation(this.loc3);
        return;
      }
    }
    if (fx.parented) return; // rides its host's node — nothing to do
    // On the ground: an attached effect whose host has no usable node still follows him
    // (the engine falls back to the unit's origin), so re-read the host's live position.
    const u = fx.hostId >= 0 ? this.rts?.simView.units.get(fx.hostId) : undefined;
    if (u) {
      fx.x = u.x;
      fx.y = u.y;
    }
    this.loc3[0] = fx.x;
    this.loc3[1] = fx.y;
    this.loc3[2] = this.rts?.groundHeightAt(fx.x, fx.y) ?? 0;
    inst.setLocation(this.loc3);
  }

  /** Age every live effect and reconcile what the player sees.
   *
   *  An effect runs on the GAME's clock, not the renderer's. An mdx instance only advances
   *  its own `frame` on the frames the scene draws it — `ModelInstance.update` is gated on
   *  `rendered && isVisible(camera)` — so anything off-camera or hidden freezes where it
   *  stands. Left to that, an effect created in the fog sat at frame 0 for as long as the
   *  player looked elsewhere and then played its Birth from the start, minutes late: the
   *  art queued up rather than happening. `age` is the fix — it ticks here every frame, for
   *  every effect, seen or not, and it alone decides where in its life the effect is. */
  private updateSpecialFx(dt: number): void {
    for (const [id, fx] of this.specialFx) {
      // An effect attached to a unit dies with him: WC3 destroys it when the widget leaves
      // the game, and our attachment node goes with the host's model either way.
      if (fx.hostId >= 0 && !this.rts?.simView.units.has(fx.hostId)) {
        this.destroySpecialFx(id);
        continue;
      }
      fx.age += dt;
      this.updateSpecialFxOne(fx);
    }
  }

  private updateSpecialFxOne(fx: SpecialFx): void {
    const inst = fx.inst;
    if (!inst) return; // still loading — age is already running, and the load will catch up
    if (!fx.spent) {
      this.placeSpecialFx(fx);
      const phase = specialFxPhaseAt(fx.age, fx.clips);
      if (phase.kind === "birth") {
        // Drive Birth off `age` rather than letting the instance count for itself. On screen
        // this writes what mdx would have anyway (measured: 14 ms apart, one frame of skew);
        // after a spell frozen it snaps to where the effect really is by now, so it resumes
        // mid-flight instead of restarting.
        inst.frame = phase.frame;
        inst.forced = true; // we moved the clock by hand — re-pose the bones
      } else if (phase.kind === "stand") {
        if (!fx.standing) {
          fx.standing = true;
          inst.setSequence(fx.standIdx);
          inst.setSequenceLoopMode(2); // the steady state: loop until the script destroys it
        }
      } else {
        fx.spent = true; // over — see SpecialFxPhase
      }
    }
    // You cannot see an effect through the fog of war, and one that burned out in the fog
    // has nothing left to show. Same live-sight rule the dropped items use (fogItems).
    const show = !fx.spent && this.specialFxVisible(fx);
    if (show !== !fx.hidden) {
      fx.hidden = !show;
      if (show) inst.show();
      else inst.hide();
    }
  }

  /** Can the local player see this effect right now? An attached one follows its host's own
   *  verdict (`unitHidden` — fog, but also a gold mine or a transport's hold); a ground one
   *  needs live sight of its point, not merely an explored memory of it. */
  private specialFxVisible(fx: SpecialFx): boolean {
    const rts = this.rts;
    if (!rts) return true;
    if (fx.hostId >= 0) return !rts.unitHidden(fx.hostId);
    const vision = rts.getVision();
    return vision.revealed || vision.stateAt(fx.x, fx.y) === FogState.Visible;
  }

  /** DestroyEffect — the model dies where it stands (fadeOutFx plays its Death clip). */
  private destroySpecialFx(id: number): void {
    const fx = this.specialFx.get(id);
    if (!fx) return;
    this.specialFx.delete(id);
    fx.doomed = true; // if it's still loading, loadSpecialFx drops it on arrival
    if (!fx.inst) return;
    // Nobody is watching one that is fogged or already spent, and a hidden instance is not
    // animated by the scene — so its Death clip would only sit out its deadline unseen.
    if (fx.hidden) fx.inst.detach();
    else this.fadeOutFx(fx.inst);
  }

  // --- Blood Mage orbiting spheres (issue #37) ------------------------------
  // Data from the Sphere ability (Asph) in Units\HumanAbilityFunc.txt:
  //   Targetart      = Units\Human\HeroBloodElf\BloodElfBall.mdl  (the orbiting ball)
  //   Targetattachcount = 3, Targetattach = sprite,first / second / third
  //   Missileart     = BloodElfBall,  Missilespeed = 1400,  Missilearc = 0.05
  // The hero model carries "Sprite First/Second/Third Ref" nodes whose animation
  // does the orbiting, so parenting a ball to each gives the circling for free. On a
  // spell cast one ball is hurled at the target as a missile, then regrows — matching
  // WC3 ("1 of his sphere will disappear and will return after a while", hive 221265).
  private static readonly SPHERE_MODEL = "Units\\Human\\HeroBloodElf\\BloodElfBall.mdx"; // Asph Targetart (.mdl → compiled .mdx)
  private static readonly SPHERE_ABILITY = "Asph"; // the ability that grants the spheres
  private static readonly SPHERE_THROW_CODES = new Set(["AHfs", "AHbn"]); // Flame Strike, Banish
  private static readonly SPHERE_SPEED = 1400; // Asph Missilespeed
  private static readonly SPHERE_ARC = 0.05; // Asph Missilearc (fraction of range → apex)
  private static readonly SPHERE_REGROW = 1.6; // seconds a thrown ball stays gone after impact

  /** Index of the first sequence whose name matches `re` (-1 if none). */
  private seqIndex(inst: SpawnInstance, re: RegExp): number {
    return (inst.model?.sequences ?? []).findIndex((s) => re.test(s.name));
  }

  /** True for a unit type that carries the Sphere ability (only the Blood Mage in
   *  stock data, but data-driven so any such unit gets the orbiting spheres). */
  private hasSpheres(typeId: string): boolean {
    return this.registry.get(typeId)?.abilities.includes(MapViewerScene.SPHERE_ABILITY) ?? false;
  }

  /** Keep every Blood Mage's three orbiting spheres alive: spawn rigs on demand,
   *  advance thrown balls, match visibility to the hero, and prune dead heroes. */
  private updateBloodMageSpheres(dt: number): void {
    const world = this.rts?.simWorld;
    const map = this.viewer.map;
    if (!world || !map) return;
    const live = new Set<number>();
    for (const u of world.units.values()) {
      if (u.hp <= 0 || !this.hasSpheres(u.typeId)) continue;
      live.add(u.id);
      const rig = this.bloodMageSpheres.get(u.id);
      if (rig) this.updateSphereRig(u.id, rig, dt);
      else if (!this.bloodMageSpheresLoading.has(u.id)) {
        this.bloodMageSpheresLoading.add(u.id);
        void this.spawnSphereRig(u.id);
      }
    }
    for (const [id, rig] of this.bloodMageSpheres) {
      if (!live.has(id)) {
        this.destroySphereRig(rig);
        this.bloodMageSpheres.delete(id);
      }
    }
  }

  private async spawnSphereRig(simId: number): Promise<void> {
    const path = MapViewerScene.SPHERE_MODEL;
    let model = this.effectModels.get(path);
    if (model === undefined) {
      model = ((await this.viewer.load(path, this.solver)) as SpawnModel | undefined) ?? null;
      this.effectModels.set(path, model);
    }
    this.bloodMageSpheresLoading.delete(simId);
    const map = this.viewer.map;
    const u = this.rts?.simView.units.get(simId);
    const inst = this.rts?.unitInstance(simId) as unknown as SpawnInstance | undefined;
    if (!model || !map || !u || u.hp <= 0 || !inst || this.bloodMageSpheres.has(simId)) return;
    // Find the three "Sprite N Ref" attachment indices by name (Asph Targetattach =
    // sprite,first/second/third) rather than hardcoding indices.
    const atts = inst.model?.attachments ?? [];
    const attachIdx: number[] = [];
    for (const key of ["first", "second", "third"]) {
      const idx = atts.findIndex((a) => new RegExp(`sprite\\s+${key}\\b`, "i").test(a.name));
      if (idx >= 0) attachIdx.push(idx);
    }
    if (!attachIdx.length) return; // not the Blood Mage model (no sprite points)
    const balls: (SpawnInstance | null)[] = [];
    for (const idx of attachIdx) {
      const ball = model.addInstance();
      ball.setScene(map.worldScene);
      const stand = this.seqIndex(ball, /^stand/i);
      ball.setSequence(stand >= 0 ? stand : 0);
      ball.setSequenceLoopMode(2); // loop the ball's idle/glow while it orbits
      const node = inst.getAttachment?.(idx);
      if (node) ball.setParent?.(node); // ride the animated sprite node → orbit for free
      ball.show();
      balls.push(ball);
    }
    this.bloodMageSpheres.set(simId, { balls, attachIdx, thrown: [], visible: true });
  }

  private updateSphereRig(simId: number, rig: SphereRig, dt: number): void {
    const inst = this.rts?.unitInstance(simId) as unknown as SpawnInstance | undefined;
    const hidden = !inst || this.rts!.unitHidden(simId);
    // Orbiting balls follow their node automatically; only match the hero's visibility.
    if (hidden !== !rig.visible) {
      for (let i = 0; i < rig.balls.length; i++) {
        if (rig.thrown.some((t) => t.ballIdx === i)) continue; // thrown balls set their own visibility
        if (hidden) rig.balls[i]?.hide();
        else rig.balls[i]?.show();
      }
      rig.visible = !hidden;
    }
    for (let k = rig.thrown.length - 1; k >= 0; k--) {
      const th = rig.thrown[k];
      const ball = rig.balls[th.ballIdx];
      if (th.phase === "fly") {
        th.t += dt;
        const p = th.flyDur > 0 ? Math.min(1, th.t / th.flyDur) : 1;
        if (ball) {
          this.loc3[0] = th.sx + (th.tx - th.sx) * p;
          this.loc3[1] = th.sy + (th.ty - th.sy) * p;
          // linear height + a parabolic arc (0 at both ends, peak at mid-flight).
          this.loc3[2] = th.sz + (th.tz - th.sz) * p + th.peak * 4 * p * (1 - p);
          ball.setLocation(this.loc3);
        }
        if (p >= 1) {
          if (ball) {
            const death = this.seqIndex(ball, /death/i); // the ball's impact burst
            if (death >= 0) {
              ball.setSequence(death);
              ball.setSequenceLoopMode(0);
            }
            ball.hide();
          }
          th.phase = "regrow";
          th.regrowLeft = MapViewerScene.SPHERE_REGROW;
        }
      } else {
        th.regrowLeft -= dt;
        if (th.regrowLeft <= 0) {
          if (ball && inst) {
            const node = inst.getAttachment?.(rig.attachIdx[th.ballIdx]);
            if (node) ball.setParent?.(node);
            this.loc3[0] = this.loc3[1] = this.loc3[2] = 0;
            ball.setLocation(this.loc3); // sit exactly on the node again
            const stand = this.seqIndex(ball, /^stand/i);
            if (stand >= 0) {
              ball.setSequence(stand);
              ball.setSequenceLoopMode(2);
            }
            if (!hidden) ball.show();
          }
          rig.thrown.splice(k, 1);
        }
      }
    }
  }

  /** Hurl one orbiting sphere at a cast's target as a missile (BloodElfBall, speed
   *  1400, arc 0.05); it regrows shortly after impact. No-op if the hero has no free
   *  sphere left to throw. */
  private throwSphere(simId: number, tx: number, ty: number, targetId: number): void {
    const rig = this.bloodMageSpheres.get(simId);
    const world = this.rts?.simWorld;
    if (!rig || !world) return;
    const busy = new Set(rig.thrown.map((t) => t.ballIdx));
    let ballIdx = -1;
    for (let i = 0; i < rig.balls.length; i++)
      if (rig.balls[i] && !busy.has(i)) {
        ballIdx = i;
        break;
      }
    if (ballIdx < 0) return; // every sphere already in flight
    const ball = rig.balls[ballIdx]!;
    const caster = world.units.get(simId);
    // Launch from the ball's current orbit point; fall back to the hero's chest.
    const wl = ball.worldLocation;
    let sx: number, sy: number, sz: number;
    if (wl && (wl[0] || wl[1] || wl[2])) {
      sx = wl[0];
      sy = wl[1];
      sz = wl[2];
    } else if (caster) {
      sx = caster.x;
      sy = caster.y;
      sz = this.rts!.groundHeightAt(caster.x, caster.y) + 90;
    } else return;
    ball.setParent?.(null); // detach from orbit and fly free
    this.loc3[0] = sx;
    this.loc3[1] = sy;
    this.loc3[2] = sz;
    ball.setLocation(this.loc3);
    ball.show();
    const t = targetId ? world.units.get(targetId) : null;
    const dtx = t ? t.x : tx;
    const dty = t ? t.y : ty;
    const dtz = this.rts!.groundHeightAt(dtx, dty) + (t ? 60 : 30); // aim at the body, or just off the ground
    const dist = Math.hypot(dtx - sx, dty - sy);
    rig.thrown.push({
      ballIdx,
      phase: "fly",
      t: 0,
      flyDur: dist > 0 ? dist / MapViewerScene.SPHERE_SPEED : 0.001,
      regrowLeft: 0,
      sx, sy, sz,
      tx: dtx, ty: dty, tz: dtz,
      peak: MapViewerScene.SPHERE_ARC * dist,
    });
  }

  private destroySphereRig(rig: SphereRig): void {
    for (const ball of rig.balls) ball?.detach();
    rig.balls.length = 0;
    rig.thrown.length = 0;
  }

  private static readonly TREE_PULSE = 0.7; // two quick blinks over this window

  /** Blink a harvested tree a bright, saturated yellow TWICE (abrupt on/off), then
   *  back to normal — a strong, unmissable "gather here" cue. */
  private updateTreePulses(dt: number): void {
    const map = this.viewer.map;
    for (const p of this.rts?.drainTreePulses() ?? []) {
      const inst = map ? this.nearestDoodad(p.x, p.y, map.doodads) : null;
      if (inst) this.treePulses.push({ inst, t: MapViewerScene.TREE_PULSE });
    }
    for (let i = this.treePulses.length - 1; i >= 0; i--) {
      const tp = this.treePulses[i];
      tp.t -= dt;
      // Two abrupt on/off blinks across the 0.7s window (period 0.35s, on ~60%).
      const on = tp.t > 0 && tp.t % 0.35 > 0.14;
      // OVER-BRIGHT, fully-saturated yellow when on (heavy red so a green canopy
      // reads as yellow; zero blue; RGB >1 glows).
      tp.inst.setVertexColor(on ? [3.2, 1.5, 0, 1] : [1, 1, 1, 1]);
      if (tp.t <= 0) {
        tp.inst.setVertexColor([1, 1, 1, 1]); // restore
        this.treePulses.splice(i, 1);
      }
    }
  }

  private nearestDoodad(x: number, y: number, doodads: HideableWidget[]): { setVertexColor(c: ArrayLike<number>): unknown } | null {
    const w = this.nearestDoodadWidget(x, y, doodads);
    return w ? (w.instance as unknown as { setVertexColor(c: ArrayLike<number>): unknown }) : null;
  }

  /** The doodad widget closest to (x,y) within a tile — used to map a sim tree back to
   *  its rendered instance (harvest blink, chop wobble, fell death, AoE highlight). */
  private nearestDoodadWidget(x: number, y: number, doodads: HideableWidget[]): HideableWidget | null {
    let best: HideableWidget | null = null;
    let bestD = 96;
    for (const d of doodads) {
      const loc = d.instance?.localLocation;
      if (!loc) continue;
      const dist = Math.hypot(loc[0] - x, loc[1] - y);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  }

  /** Index of the first sequence whose name matches `re` (tree clips: "stand",
   *  "stand hit", "death"); -1 if the model has none. */
  private seqByName(seqs: Array<{ name: string; interval?: ArrayLike<number> }> | undefined, re: RegExp): number {
    return (seqs ?? []).findIndex((s) => re.test(s.name));
  }

  // A doodad that has to MOVE — a tree being chopped or felled, a gate swinging open — is
  // drawn by a spawned, scene-animated stand-in instance keyed by its (static) placed doodad,
  // because War3MapViewer never advances a placed doodad's animation and Widget.update resets
  // any sequence we set on it, so its "stand hit"/"death"/"death alternate" clips can't play in
  // place. The stand-in hides the static doodad and plays the clips, holding the final frame:
  // the cut stump WC3 leaves behind, or the open gate. `revertEnd` (>0) is a one-shot clip's
  // end frame, when we drop back to the looping "stand"; `dead` poses are held forever.
  // `clipT` is seconds into the running one-shot clip, and -1 while the actor just idles —
  // see the catch-up pass in updateTreeActors for why we keep that clock ourselves.
  private doodadActors = new Map<HideableWidget, DoodadActor>();

  /** The scene-animated stand-in for a placed doodad, spawned (and the static doodad hidden)
   *  on first use. null if the doodad has no spawnable model. */
  private doodadActor(widget: HideableWidget): DoodadActor | null {
    let a = this.doodadActors.get(widget);
    if (a) return a;
    const map = this.viewer.map;
    const src = widget.instance;
    const model = src.model as { sequences: Array<{ name: string; interval?: ArrayLike<number> }>; addInstance?(): SpawnInstance } | undefined;
    if (!map || !model || typeof model.addInstance !== "function") return null;
    const inst = model.addInstance();
    inst.setScene(map.worldScene);
    inst.setLocation(src.localLocation);
    if (src.localRotation) inst.setRotation(src.localRotation);
    if (src.localScale && src.localScale[0]) inst.setUniformScale(src.localScale[0]);
    const stand = this.seqByName(inst.model.sequences, /^stand$/i);
    if (stand >= 0) {
      inst.setSequence(stand);
      inst.setSequenceLoopMode(2); // idle until it wobbles or dies
    }
    src.hide(); // the static doodad is replaced by this animated stand-in
    this.removedWidgets.add(widget); // and the fog pass never re-shows it
    a = { inst, dead: false, revertEnd: 0, clipT: -1 };
    this.doodadActors.set(widget, a);
    return a;
  }

  /** Play each chopped tree's "stand hit" wobble once per chop (SimWorld.drainTreeHits),
   *  then settle it back to "stand". WC3 trees visibly shudder at every axe blow. Also
   *  keeps every stand-in's one-shot clip running while it is off-camera (see below).
   *  `dt` is SECONDS. */
  private updateTreeActors(dt: number): void {
    const map = this.viewer.map;
    const world = this.rts?.simWorld;
    if (!map || !world) return;
    for (const h of world.drainTreeHits()) {
      const w = this.nearestDoodadWidget(h.x, h.y, map.doodads);
      if (!w) continue;
      const a = this.doodadActor(w);
      if (!a || a.dead) continue;
      this.playHitWobble(a);
    }
    this.advanceDoodadClips(dt);
    for (const a of this.doodadActors.values()) {
      if (a.dead || a.revertEnd <= 0 || a.inst.frame < a.revertEnd) continue; // wobble still playing
      const stand = this.seqByName(a.inst.model.sequences, /^stand$/i);
      if (stand >= 0) {
        a.inst.setSequence(stand);
        a.inst.setSequenceLoopMode(2); // settle into the looping idle
      }
      a.revertEnd = 0;
      a.clipT = -1; // a looping idle needs no clock
    }
  }

  /** Play a stand-in's "Stand Hit" flinch once — the shudder a tree gives at every axe blow
   *  and a gate at every axe blow landed on IT. The settle back to "stand" is the loop above,
   *  which watches `revertEnd` for every actor, so this only has to start it. */
  private playHitWobble(a: DoodadActor): void {
    const hit = this.seqByName(a.inst.model.sequences, /stand hit/i);
    if (hit < 0) return;
    a.inst.setSequence(hit);
    a.inst.setSequenceLoopMode(0); // play the wobble once
    a.revertEnd = a.inst.model.sequences[hit].interval?.[1] ?? 0;
    a.clipT = 0; // start this actor's own clip clock (and so it plays out off-camera, issue #88)
  }

  /** Drive every stand-in's one-shot clip (a tree's fall, a gate swinging open) off our own
   *  clock instead of the viewer's.
   *
   *  mdx-m3-viewer advances an instance's animation ONLY while it is inside the camera
   *  frustum (`ModelInstance.update` calls `updateAnimations` behind `isVisible(camera)`), so
   *  a tree felled off-camera sat frozen at the first frame of "death" and only started
   *  toppling when the player finally panned over — a tree that died minutes ago falling in
   *  front of you (issue #88). WC3 fells it where and when it dies, so the frame we write here
   *  is authoritative on- and off-screen: it clamps at the clip's end (the stump WC3 leaves,
   *  held forever) and `forced` re-poses the nodes for the frame it comes back into view. */
  private advanceDoodadClips(dt: number): void {
    for (const a of this.doodadActors.values()) {
      if (a.clipT < 0) continue; // idling — nothing to finish
      a.clipT += dt;
      const iv = a.inst.model.sequences[a.inst.sequence]?.interval;
      if (!iv) {
        a.clipT = -1;
        continue;
      }
      const frame = Math.min(iv[0] + a.clipT * 1000, iv[1]);
      if (frame === a.inst.frame) continue; // already there (a finished, held pose)
      a.inst.frame = frame;
      a.inst.forced = true; // we wrote `frame` ourselves, so make the pose follow
    }
  }

  /** Fell a tree's visual: free its pathing footprint, then play the model's "death" clip
   *  once on its scene-animated stand-in and hold the final frame — the cut stump WC3 leaves
   *  behind. A model with no death clip (or that can't be spawned) is just hidden. */
  private fellTreeVisual(nodeId: number, x: number, y: number, doodads: HideableWidget[]): void {
    const meta = this.nodeFootprints.get(nodeId);
    if (meta && this.grid) {
      unstampFootprint(this.grid, meta.fp, meta.x, meta.y);
      this.nodeFootprints.delete(nodeId);
    }
    const w = this.nearestDoodadWidget(x, y, doodads);
    if (!w) return;
    const a = this.doodadActor(w);
    if (!a) {
      w.instance.hide(); // no spawnable model — just remove the tree
      this.removedWidgets.add(w);
      return;
    }
    const death = this.seqByName(a.inst.model.sequences, /death/i);
    if (death >= 0) {
      a.inst.setSequence(death);
      a.inst.setSequenceLoopMode(0); // play once; the last frame is the stump, held forever
      a.clipT = 0; // and it falls on our clock, so it plays out off-camera too (issue #88)
    }
    a.dead = true;
    a.revertEnd = 0;
    // A tree is a destructible too, and the SIM felled this one. Mark its record dead so a
    // later script KillDestructable on the same tree can't unstamp a footprint that is
    // already off the grid (the stamps are counted — a double release would punch a hole).
    const rec = this.destructibles.find((r) => r.isTree && r.life > 0 && r.x === x && r.y === y);
    if (rec) rec.life = 0;
  }

  // --- destructibles: a gate opens by dying (7.x; see src/world/mapDestructibles.ts) --------

  private destructibleById(id: number): MapDestructible | undefined {
    return this.destructibles[id - 1]?.id === id ? this.destructibles[id - 1] : this.destructibles.find((d) => d.id === id);
  }

  private snapshotOf(d: MapDestructible): DestructableSnapshot {
    return { id: d.id, typeId: d.typeId, name: this.westring(d.name), x: d.x, y: d.y, life: d.life, maxLife: d.maxLife };
  }

  private destructibleSnapshot(id: number): DestructableSnapshot | null {
    const d = this.destructibleById(id);
    return d ? this.snapshotOf(d) : null;
  }

  // Where DestructableData's `Name` column points ("Gate", "Crates") — and it is TWO files,
  // with the destructibles in the second: `UI\WorldEditStrings.txt` is the editor's own
  // chrome, while every `WESTRING_DEST_*` the game DATA references lives in
  // `UI\WorldEditGameStrings.txt`. Reading only the first left a gate's name as the raw key,
  // which is what a selected gate showed. Parsed on first use only — they are big.
  private worldEditStrings: Map<string, string> | null = null;

  /** Resolve a `WESTRING_*` key to its display text; anything else is already the text. */
  private westring(key: string): string {
    if (!key.startsWith("WESTRING")) return key;
    if (!this.worldEditStrings) {
      this.worldEditStrings = new Map();
      for (const file of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
        const bytes = this.vfs.rawBytes(file);
        if (!bytes) continue;
        for (const line of new TextDecoder("windows-1252").decode(bytes).split(/\r?\n/)) {
          const eq = line.indexOf("=");
          if (eq > 0 && line.startsWith("WESTRING")) {
            this.worldEditStrings.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^"|"$/g, ""));
          }
        }
      }
    }
    return this.worldEditStrings.get(key) || key;
  }

  /** The collider a destructible wears at the life it has now: its `pathTex` while it stands,
   *  its `pathTexDeath` once it is dead (a gate's posts), nothing when its type leaves no
   *  wreckage. Turned to the doodad's facing, like every other footprint. */
  private destructibleFootprint(d: MapDestructible, alive: boolean): Footprint | null {
    const tex = alive ? d.pathTex : d.pathTexDeath;
    return tex ? this.footprintFor(tex, d.angle) : null;
  }

  /** Move a destructible's collider from the `wasAlive` footprint to the one its current life
   *  calls for. Counted stamps, so this is exact: the cells the old footprint took come back
   *  and only the new one's are held. */
  private restampDestructible(d: MapDestructible, wasAlive: boolean): void {
    const nowAlive = d.life > 0;
    if (!this.grid || nowAlive === wasAlive) return;
    const from = this.destructibleFootprint(d, wasAlive);
    const to = this.destructibleFootprint(d, nowAlive);
    if (from) unstampFootprint(this.grid, from, d.x, d.y);
    if (to) stampFootprint(this.grid, to, d.x, d.y);
  }

  /** Play one of a destructible's own clips on its scene-animated stand-in. `hold` keeps the
   *  final frame (an open gate stays open); otherwise it settles back into "stand". */
  private playDestructibleClip(d: MapDestructible, re: RegExp, hold: boolean): void {
    const map = this.viewer.map;
    if (!map) return;
    const w = this.nearestDoodadWidget(d.x, d.y, map.doodads as unknown as HideableWidget[]);
    if (!w) return;
    const a = this.doodadActor(w);
    if (!a) {
      if (hold) {
        w.instance.hide(); // no spawnable model — the best "open" we can draw is gone
        this.removedWidgets.add(w);
      }
      return;
    }
    const seq = this.seqByName(a.inst.model.sequences, re);
    if (seq < 0) return;
    a.inst.setSequence(seq);
    a.inst.setSequenceLoopMode(hold ? 0 : 2);
    a.dead = hold;
    a.revertEnd = 0;
    a.clipT = hold ? 0 : -1; // a held clip (the gate swinging open) runs off-camera too
  }

  /**
   * A destructible took a blow: flinch, exactly as a chopped tree does.
   *
   * Every gate and door in the game ships the clip to do it — `stand` / **`Stand Hit`** /
   * `Death Alternate` / `death` is the sequence list of the Elven Gate, the Demon Gate and
   * both Dungeon Gates alike (read off the models loaded for Rise of the Naga). Without this
   * a gate under an axe was the one thing in the world that took damage without moving: the
   * health bar fell and the model stood there, and the first sign anything had happened was
   * the gate swinging open at zero.
   *
   * A model that has no such clip is left ALONE rather than swapped for a stand-in that
   * would play nothing — the crates are `Stand`/`Death` only, and standing one in is pure
   * cost (it hides the batched doodad and adds a scene instance for no motion at all).
   */
  private hitDestructibleVisual(d: MapDestructible): void {
    const map = this.viewer.map;
    if (!map) return;
    const w = this.nearestDoodadWidget(d.x, d.y, map.doodads as unknown as HideableWidget[]);
    const existing = w ? this.doodadActors.get(w) : undefined;
    const sequences = existing?.inst.model.sequences ?? w?.instance?.model?.sequences;
    if (!w || !sequences || this.seqByName(sequences, /stand hit/i) < 0) return;
    const a = existing ?? this.doodadActor(w);
    if (!a || a.dead) return;
    this.playHitWobble(a);
  }

  /**
   * The crash a destructible makes when it goes — and the data keeps it in TWO places, so
   * this asks both, in the order the game does.
   *
   * `DestructableData`'s own `deathSnd` column is an `AnimSounds.slk` label and covers the
   * crates and the walls (`CrateDeath`, `RockWallDeath`, `TreeWallDeath`,
   * `MagicalCellDeathSound`) — 43 of the 247 types. It is EMPTY on the other 204, and that
   * includes **every one of the game's 25 gates**, whose crash is instead an SND event
   * object on the model: `SNDXDGAT` → AnimLookups `DGAT` → AnimSounds `GateDeath` →
   * `Doodads\LordaeronSummer\Terrain\Gate\GateEpicDeath.wav`, keyed at frame 2533 — 33 ms
   * into the `death` clip [2500..3333] that is starting right now. So a column-only reading
   * leaves every gate in the game silent, which is exactly how this was found.
   *
   * (Both end up in the same table, which is why the two lines below look alike: one
   * arrives with its label already written down, the other has to fetch it from the model.)
   */
  private playDestructibleDeathSound(d: MapDestructible): void {
    if (!this.sounds) return;
    const at = { x: d.x, y: d.y, z: d.z };
    if (d.deathSound) this.sounds.playAnimSound(d.deathSound, at);
    else this.sounds.playModelDeath(d.model, at);
  }

  /** `KillDestructable` — and, through `ModifyGateBJ`, "open gate". The gate does not vanish:
   *  it plays its death clip and holds the last frame (swung open), and its collider drops to
   *  the two posts `pathTexDeath` keeps. Idempotent, so a script that opens an open gate is a
   *  no-op rather than a double-unstamp. */
  killDestructible(id: number, clip: RegExp = /^death$/i): void {
    const d = this.destructibleById(id);
    if (!d || d.life <= 0) return;
    d.life = 0;
    this.syncDestructibleToSim(d);
    this.restampDestructible(d, true);
    this.playDestructibleClip(d, clip, true);
    this.playDestructibleDeathSound(d);
    // …and the map is told. A destructable is a WIDGET, and `TriggerRegisterDeathEvent` takes
    // widgets — three of Rise of the Naga's triggers hang off exactly this (the harbour
    // sequence off its demon gate, two lines off the village's elven gate). Queued rather
    // than fired here because this is called from inside the sim's own reaper as well as
    // from a script's KillDestructable, and a trigger must not run inside a sim tick.
    this.destructibleDeaths.push(id);
  }

  /** Destructibles that died since the last script pump (see killDestructible). */
  private destructibleDeaths: number[] = [];

  /** `DestructableRestoreLife` — "close gate". Puts the full collider back and stands the
   *  model up again (`birth` plays the birth clip, as the native's flag asks). */
  restoreDestructible(id: number, life: number, birth: boolean): void {
    const d = this.destructibleById(id);
    if (!d) return;
    const wasAlive = d.life > 0;
    d.life = Math.max(0, Math.min(life, d.maxLife || life));
    this.syncDestructibleToSim(d);
    this.restampDestructible(d, wasAlive);
    if (d.life > 0) this.playDestructibleClip(d, birth ? /^birth$/i : /^stand$/i, false);
  }

  /** `SetDestructableLife` — the collider follows life across zero in either direction.
   *  Life driven to zero IS a death, not merely an empty bar: it plays the death clip and
   *  raises the widget's death event, so `SetDestructableLife(d, 0)` and `KillDestructable(d)`
   *  end at the same place (which is how WC3 has it). */
  setDestructibleLife(id: number, life: number): void {
    const d = this.destructibleById(id);
    if (!d) return;
    const wasAlive = d.life > 0;
    if (life <= 0) {
      if (wasAlive) this.killDestructible(id);
      return;
    }
    d.life = life;
    this.syncDestructibleToSim(d);
    this.restampDestructible(d, wasAlive);
  }

  /** `SetDestructableAnimation` — the clip name the script asked for ("stand", "death",
   *  "death alternate": the three `ModifyGateBJ` uses). Purely cosmetic; life is what moves
   *  the collider. */
  setDestructibleAnimation(id: number, name: string): void {
    const d = this.destructibleById(id);
    if (!d || !name) return;
    this.playDestructibleClip(d, clipRe(name), /death/i.test(name));
  }

  /** `RemoveDestructable` — gone outright: no wreckage, no collider, no model. */
  removeDestructible(id: number): void {
    const d = this.destructibleById(id);
    if (!d) return;
    const fp = this.destructibleFootprint(d, d.life > 0);
    if (fp && this.grid) unstampFootprint(this.grid, fp, d.x, d.y);
    d.life = 0;
    d.pathTexDeath = ""; // nothing left to walk around
    this.hideDestructibleWidget(d);
  }

  /** `ShowDestructable(d, false)` — hidden, and (as in WC3) still solid: hiding a doodad is a
   *  render call, not a pathing one. */
  showDestructible(id: number, show: boolean): void {
    const d = this.destructibleById(id);
    if (!d || show) return;
    this.hideDestructibleWidget(d);
  }

  private hideDestructibleWidget(d: MapDestructible): void {
    const map = this.viewer.map;
    if (!map) return;
    const w = this.nearestDoodadWidget(d.x, d.y, map.doodads as unknown as HideableWidget[]);
    if (!w) return;
    const a = this.doodadActors.get(w);
    if (a) a.inst.hide();
    w.instance.hide();
    this.removedWidgets.add(w); // and the fog pass never re-shows it
  }

  /** Position/scale/colour the flat selection + hover rings each frame, plus
   *  the transient yellow harvest-order flashes. */
  private updateSelectionCircles(dt: number): void {
    // "Aiming mode": a spell is armed for targeting (orderMode === "cast"). While
    // aiming, the persistent selection/preview rings under the army are suppressed so
    // the ground isn't cluttered (issue #20). What replaces them depends on the aim:
    //   • point-AoE (ubersplat): the splat + green rings on the units it would hit;
    //     the hover ring is hidden (the green target rings are the indicator).
    //   • single-target: the normal hover ring stays on whatever unit the cursor is
    //     over — allegiance-coloured, NOT green — so the player still sees their target.
    const cast = this.rts?.armedCast ?? null;
    const aiming = !!cast;
    const aoeAiming = !!(cast && cast.target === "point" && cast.area);
    // The ring keys painted this frame; anything in ringKeys that isn't refreshed here
    // is a stale ring (deselected unit / expired flash) and gets removed at the end.
    const live = new Set<string>();
    const rings = aiming ? [] : (this.rts?.selectionRings() ?? []);
    for (let i = 0; i < rings.length; i++) this.addRing(`sel-${i}`, rings[i], null, false, live);
    // Live drag-box preview: full-green rings on the units the marquee currently
    // covers, so the player sees the pick before releasing the mouse.
    const preview = aiming ? [] : (this.rts?.previewRings() ?? []);
    for (let i = 0; i < preview.length; i++) this.addRing(`prev-${i}`, preview[i], null, false, live);
    // hoverRing() already returns null when the hovered unit is selected. Dimmed so
    // a hover ring stays more discrete than the committed selection rings. Kept for a
    // single-target aim (the target indicator); dropped for a point-AoE aim.
    this.addRing("hover", aoeAiming ? null : (this.rts?.hoverRing() ?? null), null, true, live);
    // Rally flag at the selected building's rally point.
    if (this.rallyFlag) {
      const rally = this.rts?.selectedRally() ?? null;
      if (rally) {
        this.loc3[0] = rally.x;
        this.loc3[1] = rally.y;
        this.loc3[2] = rally.z;
        this.rallyFlag.setLocation(this.loc3);
        this.rallyFlag.setTeamColor(this.rts?.playerColor(rally.owner) ?? rally.owner); // team-coloured (issue #86)
        this.rallyFlag.show();
      } else {
        this.rallyFlag.hide();
      }
    }
    // Small queue flags at each selected unit's shift-queued order positions.
    const markers = this.rts?.queueMarkers() ?? [];
    for (let i = 0; i < markers.length; i++) {
      const inst = this.queueFlag(i);
      if (!inst) break;
      this.loc3[0] = markers[i].x;
      this.loc3[1] = markers[i].y;
      this.loc3[2] = markers[i].z;
      inst.setLocation(this.loc3);
      inst.setTeamColor(this.rts?.playerColor(markers[i].owner) ?? markers[i].owner); // pooled across owners
      inst.show();
    }
    for (let i = markers.length; i < this.queueFlags.length; i++) this.queueFlags[i].hide();
    this.updateAoeCircle();
    this.tickFlashCircles(dt, live);
    // Prune ring overlay entries that weren't repainted this frame.
    for (const key of this.ringKeys) if (!live.has(key)) this.ringSplats?.remove(key);
    this.ringKeys = live;
  }

  /** Paint one selection/hover/preview/flash ring into the terrain-conforming overlay
   *  (issue #34). `tint` non-null = a flash (its colour carries the ring); otherwise the
   *  colour is by alliance (green own/allied, red hostile, yellow neutral-passive). `dim`
   *  fades a hover ring. `live` collects the keys painted this frame for pruning. */
  private addRing(
    key: string,
    info: { x: number; y: number; z: number; radius: number; owner: number; team: number; allegiance: "own" | "neutral" | "enemy"; isBuilding?: boolean } | null,
    tint: number[] | null,
    dim: boolean,
    live: Set<string>,
  ): void {
    if (!this.ringSplats || !info) return;
    // Ring colour — flashes carry their own tint off a white base; a real ring wears one of
    // the three colours `UI\MiscData.txt` [SelectionCircle] defines, picked where the alliance
    // table is (RtsController.ringAllegiance). The overlay MULTIPLIES it into the (white) ring
    // texture.
    const vcolor0 = tint
      ?? (info.allegiance === "own" ? MapViewerScene.FRIENDLY_RING_TINT
        : info.allegiance === "neutral" ? MapViewerScene.NEUTRAL_RING_TINT
        : MapViewerScene.ENEMY_RING_TINT);
    let vcolor: number[] = vcolor0;
    // Half-width matches the old model sizing (scale = max(0.7, radius/38), native 38),
    // so a ring's outer edge still lands on the unit's click collider.
    const scale = Math.max(0.7, info.radius / 38);
    const half = scale * RING_NATIVE;
    // Small rings (workers, critters) get a hair more additive glow so their thin border
    // reads about as bold as a big unit's — the same nudge the flat model used.
    const thicken = scale < 1 ? 1 + (1 - scale) * 0.4 : 1;
    let mult = thicken;
    if (dim) mult *= MapViewerScene.HOVER_RING_DIM; // hover rings read fainter than a committed selection
    if (mult !== 1) vcolor = vcolor.map((c) => c * mult);
    const texture = info.isBuilding ? RING_TEX_BUILDING : RING_TEX_UNIT;
    // `mask`: the overlay draws a crisp procedural ring in the vcolor, fully visible on
    // bright grass as well as dark dirt (the real ring BLP is a hairline built for additive
    // blend that washes out as a terrain splat — issue #34 f/u). The BLP is still named so
    // the entry loads/draws; its pixels are ignored.
    this.ringSplats.add(key, info.x, info.y, half, texture, { tint: [vcolor[0], vcolor[1], vcolor[2]], mask: true });
    live.add(key);
  }

  /** AoE cast indicator at the cursor while a point-target area spell (Blizzard,
   *  Flame Strike, …) is armed — WC3's real per-race SpellAreaOfEffect ground splat,
   *  sized to the ability's area of effect (issue #20). Painted through the ubersplat
   *  overlay so it's genuinely coplanar with the terrain (flats, slopes, ramps). The
   *  units the spell would hit are green-tinted (rts.setAoeHighlight) so the player
   *  sees its valid targets — friendly fire included — before clicking. */
  private aoeSplatShown = false;
  private updateAoeCircle(): void {
    const cast = this.rts?.armedCast;
    const area = cast && cast.target === "point" ? cast.area : undefined;
    const hit = this.rts && area ? this.rts.groundPoint(this.lastMouse.x, this.lastMouse.y) : null;
    if (!this.splats || !hit || !area) {
      if (this.aoeSplatShown) {
        this.splats?.remove("aoe");
        this.aoeSplatShown = false;
      }
      this.rts?.setAoeHighlight([]);
      this.updateAoeTreeHighlight([]);
      return;
    }
    // `scale` is the splat's half-width, so a radius-`area` circle maps directly.
    this.splats.add("aoe", hit[0], hit[1], area, AOE_SPLAT_TEXTURE[this.localRace]);
    this.aoeSplatShown = true;
    // Green-tint the units this cast would actually affect (applied in applyFogTint).
    this.rts?.setAoeHighlight(this.rts?.aoeTargetIds(hit[0], hit[1]) ?? []);
    // …and the trees it would fell (Flame Strike), so the forest lights up green too.
    this.updateAoeTreeHighlight(this.rts?.aoeTreePoints(hit[0], hit[1]) ?? []);
  }

  // Tree doodads currently glowing green under an armed tree-destroying AoE. Painted
  // green every frame while armed (so the highlight tracks the cursor) and skipped by
  // fogWidgets so its 10Hz fog pass doesn't fight the tint; a tree that leaves the set
  // is no longer skipped, so fogWidgets restores it on its next pass.
  private aoeTreeInsts = new Set<object>();
  private updateAoeTreeHighlight(points: Array<{ x: number; y: number }>): void {
    const map = this.viewer.map;
    const next = new Set<object>();
    if (map && points.length) {
      for (const p of points) {
        const inst = this.nearestDoodad(p.x, p.y, map.doodads);
        if (inst) {
          next.add(inst as object);
          inst.setVertexColor(AOE_TREE_TINT);
        }
      }
    }
    this.aoeTreeInsts = next;
  }

  private armedAbilityArea(code: string): number {
    const su = this.rts?.selectedSimUnit();
    const ab = su?.abilities.find((a) => a.code === code && a.level >= 1);
    const def = ab ? this.abilities.get(ab.id) : undefined;
    return def ? def.levelData[Math.min(ab!.level, def.levelData.length) - 1].area || 0 : 0;
  }

  /** Time the harvest-/attack-order flashes (terrain-conforming ground rings, blinking
   *  twice): yellow for a harvest target, red for an attack target (colour per request).
   *  A flash is painted into ringSplats each frame it's "on"; `live` collects its key so
   *  the frame's prune keeps it, and simply not adding it on an "off" frame hides it. */
  private tickFlashCircles(dt: number, live: Set<string>): void {
    for (const req of this.rts?.drainFlashes() ?? []) {
      this.flashRings.push({ id: this.flashSeq++, t: 0.7, x: req.x, y: req.y, radius: req.radius, color: req.color, sizeToRadius: req.sizeToRadius });
    }
    for (let i = this.flashRings.length - 1; i >= 0; i--) {
      const f = this.flashRings[i];
      f.t -= dt;
      if (f.t <= 0) {
        this.flashRings.splice(i, 1);
        continue;
      }
      // Two on/off blinks over 0.7s — paint the ring only on the "on" phase.
      const on = (f.t % 0.35) > 0.12;
      // A flash carries its OWN colour (the order it confirms picked it), so its allegiance
      // is never consulted — it is stated only because every ring record carries one.
      if (on) this.addRing(`flash-${f.id}`, { x: f.x, y: f.y, z: 0, radius: f.radius, owner: -2, team: -2, allegiance: "neutral" }, f.color, false, live);
    }
  }

  // --- projectiles (missile models) -----------------------------------------

  // Rings size to each unit's selRadius (see addRing) so they match the click collider;
  // the ringSplats overlay lifts them a hair off the terrain to avoid z-fight.
  // Colour tints for the alliance selection/hover rings. The tint MULTIPLIES the (white)
  // ring texture, so zeroing the off-channels forces each ring to its pure primary —
  // extreme, unambiguous colours at a glance (green = 0,1,0; red = 1,0,0; yellow = 1,1,0).
  // Hover rings scale these down (HOVER_RING_DIM) to stay discrete next to a selection.
  private static readonly FRIENDLY_RING_TINT = [0, 1, 0]; // your/allied units — pure green
  private static readonly ENEMY_RING_TINT = [1, 0, 0]; // hostiles + creeps — pure red
  private static readonly NEUTRAL_RING_TINT = [1, 1, 0]; // neutral-passive (mines/shops) — pure yellow
  // Brightness scale for HOVER rings (all colours) so a merely-hovered unit reads
  // as slightly fainter than a committed selection ring — but still bold, with a ring
  // border about as thick as an order/click flash. The rings blend additively, so this
  // RGB scale drives how wide/bright the glow reads; kept high so hover borders don't
  // thin out to a faint hairline.
  private static readonly HOVER_RING_DIM = 0.78;
  // Camera zoom limits (world units of camera distance). A distance means what it means in the
  // real game only because the lens does too (GAME_FOV, measured) — the two are one knob: what
  // you see is distance × tan(fov/2). A match opens on WC3's own default distance, 1650
  // (bj_CAMERA_DEFAULT_DISTANCE), which through the 32° lens IS the real client's opening view;
  // the wheel then runs from a close 1250 out to 2400. (WC3's own wheel stops are not documented
  // anywhere we trust, so the range is ours; the DEFAULT it opens on is not.)
  private static readonly ZOOM_MIN = 1250;
  private static readonly ZOOM_MAX = 2400;
  private static readonly MELEE_START = CAMERA.DEFAULT_DISTANCE;
  // The wheel moves in STOPS, not continuously: WC3's zoom is a fixed ladder of camera
  // distances and one notch is one rung. The rungs are geometric (each is the same RATIO
  // closer than the last), because what a distance is worth on screen is a ratio — the same
  // 150 units is a whole step zoomed in and barely a nudge zoomed out. Seven rungs across
  // 2400 → 1250 puts the default the match opens on (1650) almost exactly on rung 4, so the
  // player starts on a stop rather than between two.
  private static readonly ZOOM_STEPS = 7;
  /** Seconds a single notch takes to settle. Every camera move in WC3 is interpolated; a notch
   *  eases OUT (fast off the mark, gliding into the stop), which is what makes a run of notches
   *  read as one continuous dolly instead of a stutter. */
  private static readonly ZOOM_EASE = 0.22;
  // --- the close-zoom tilt -------------------------------------------------------------------
  // On the last rung the camera does not only come closer, it drops: the angle of attack
  // shallows out of the default 56°-above-the-horizon overhead view toward a low, third-person
  // shot, which is what turns the view into the deep trapezoid you get zoomed all the way in.
  // 40° over the final notch alone, chosen off a sweep of 50/45/40/35/30 shot on Echo Isles:
  // 45 barely reads, 30 tips the treeline and the map's far edge into the top of the frame, and
  // spreading the drop over two rungs costs the ordinary mid-zoom view its stock 56°. Keeping it
  // to the last notch also keeps the moment — the last rung is where the view changes character.
  private static readonly TILT_FINAL_AOA_DEG = 40; // eye elevation above the focus, closest stop
  private static readonly TILT_STEPS = 1; // rungs the tilt is spread over, from the closest
  /** Camera distance at a zoom stop. 0 = fully out (ZOOM_MAX) … ZOOM_STEPS = fully in. */
  private static zoomStopDistance(step: number): number {
    const t = clamp(step, 0, MapViewerScene.ZOOM_STEPS) / MapViewerScene.ZOOM_STEPS;
    return MapViewerScene.ZOOM_MAX * Math.pow(MapViewerScene.ZOOM_MIN / MapViewerScene.ZOOM_MAX, t);
  }
  /** …and the inverse, as a fractional rung: which stop a raw distance is sitting on. Read off
   *  the CURRENT distance rather than a stored index so the ladder still makes sense after a
   *  map's script has parked the camera somewhere between two stops. */
  private static zoomStopOf(distance: number): number {
    const span = Math.log(MapViewerScene.ZOOM_MIN / MapViewerScene.ZOOM_MAX);
    return (Math.log(clamp(distance, MapViewerScene.ZOOM_MIN, MapViewerScene.ZOOM_MAX) / MapViewerScene.ZOOM_MAX) / span) * MapViewerScene.ZOOM_STEPS;
  }
  /** The pitch (eye elevation above the focus, radians) that belongs to a zoom stop: the
   *  default overhead angle everywhere except the closest TILT_STEPS rungs, easing down to
   *  TILT_FINAL_AOA_DEG at the bottom of the ladder. */
  private static pitchForZoomStep(step: number): number {
    const from = MapViewerScene.ZOOM_STEPS - MapViewerScene.TILT_STEPS;
    const t = clamp((step - from) / MapViewerScene.TILT_STEPS, 0, 1);
    return MapViewerScene.GAME_PITCH + ((MapViewerScene.TILT_FINAL_AOA_DEG * Math.PI) / 180 - MapViewerScene.GAME_PITCH) * t;
  }
  /** Move the player's zoom to a stop and start the ease toward it. `distance`/`pitch` are
   *  tweened from wherever the camera is NOW, so a notch mid-ease continues the same glide. */
  private setZoomStop(step: number): void {
    this.zoomFromDistance = this.distance;
    this.zoomFromPitch = this.pitch;
    this.playerDistance = MapViewerScene.zoomStopDistance(step);
    this.playerPitch = MapViewerScene.pitchForZoomStep(step);
    this.zoomT = 0;
  }
  private static readonly EDGE_MARGIN = 6; // px from a screen edge that triggers scrolling
  private pointerInWindow = false; // the cursor is on the page at all — gates edge-scroll
  // The game frame's box in VIEWPORT coords, refreshed once a frame. Mouse input arrives in
  // viewport coords while everything that touches the world (picking, the ghost, the AoE
  // circle) wants CANVAS coords, and once the frame is letterboxed those differ by the bar.
  // One cached rect converts between the two without a per-move layout read.
  private frame = { left: 0, top: 0, right: 0, bottom: 0 };

  /** Create missile instances for freshly-launched projectiles, move live ones
   *  to their current sim position each frame, and detach ones that landed. */
  private updateProjectiles(): void {
    const world = this.rts?.simWorld;
    const map = this.viewer.map;
    if (!world || !map) return;
    for (const p of world.drainSpawnedProjectiles()) {
      if (!p.art) continue; // no missile model (still deals delayed damage)
      this.sounds?.playMissile(p.art, "launch", { x: p.x, y: p.y, z: this.rts!.groundHeightAt(p.x, p.y) + p.z }); // fire/whoosh/gunshot as it launches
      this.projectileLoading.add(p.id);
      void this.loadProjectile(p.id, p.art);
    }
    // A hit plays the missile's impact (Death) clip at the point of impact; a
    // fizzle (target vanished mid-flight) just detaches.
    const impacts = new Map<number, { x: number; y: number; z: number }>();
    for (const im of world.drainProjectileImpacts()) impacts.set(im.id, im);
    for (const id of world.drainRemovedProjectiles()) {
      const im = impacts.get(id);
      if (im) this.impactProjectile(id, im.x, im.y, im.z);
      else this.detachProjectile(id);
    }
    // A frozen client's removals come from the APPLIER, not the sim's drains — and they
    // must be consumed HERE, before the record-gone sweep below. This drain used to live
    // in drainWorldSpawns, which runs AFTER this method in the frame: the sweep saw the
    // applier-deleted record first, detached the instance silently, and impactProjectile
    // then found nothing to play — every hit on a client vanished burstless (the water
    // elemental's splash, an arrow's shatter) while the host played them all.
    for (const im of this.rts?.drainSnapshotProjImpacts() ?? []) this.impactProjectile(im.id, im.x, im.y, im.z);
    for (const [id, inst] of this.projectileInsts) {
      const p = world.projectiles.get(id);
      if (!p) {
        this.detachProjectile(id); // landed before its model finished loading
        continue;
      }
      const t = world.units.get(p.targetId);
      this.loc3[0] = p.x;
      this.loc3[1] = p.y;
      this.loc3[2] = this.rts!.groundHeightAt(p.x, p.y) + p.z; // per-projectile launch→impact height
      inst.setLocation(this.loc3);
      // A WAVE has no target to point at — it IS a direction — and its model has a definite
      // forward axis: Shock Wave's wedge, Carrion Swarm's swarm, the Brewmaster's breath.
      // Facing it down the line it sweeps is what makes the art read as the spell; without
      // it every wave pointed at world +x, so a Breath of Fire cast southward laid its
      // flame out sideways across the caster and looked like no model at all.
      const ang = p.wave ? Math.atan2(p.wave.dirY, p.wave.dirX) : t ? Math.atan2(t.y - p.y, t.x - p.x) : 0;
      zQuat(this.mq, ang);
      inst.setRotation(this.mq);
    }
  }

  private detachProjectile(id: number): void {
    this.projectileLoading.delete(id);
    const inst = this.projectileInsts.get(id);
    if (inst) {
      inst.detach();
      this.projectileInsts.delete(id);
    }
  }

  /** A projectile hit: play the missile model's "Death" clip (the impact burst)
   *  once at the hit point, then detach it after a moment (reusing the timed
   *  one-shot effect list). Missiles without a Death clip just detach. */
  private impactProjectile(id: number, x: number, y: number, z: number): void {
    this.projectileLoading.delete(id);
    const inst = this.projectileInsts.get(id);
    if (!inst) return;
    this.projectileInsts.delete(id);
    const death = inst.model.sequences.findIndex((s) => /death/i.test(s.name));
    if (death < 0) {
      inst.detach();
      return;
    }
    this.loc3[0] = x;
    this.loc3[1] = y;
    this.loc3[2] = this.rts!.groundHeightAt(x, y) + z; // impact at the weapon's impactz height
    inst.setLocation(this.loc3);
    inst.setSequence(death);
    inst.setSequenceLoopMode(0); // play once, then the effects timer detaches it
    this.effects.push({ inst, t: 1.0 });
  }

  private async loadProjectile(id: number, art: string): Promise<void> {
    const map = this.viewer.map;
    if (!map) return;
    let model = this.projectileModels.get(art);
    if (model === undefined) {
      model = ((await this.viewer.load(art, this.solver)) as SpawnModel | undefined) ?? null;
      this.projectileModels.set(art, model);
    }
    // The projectile may have landed (id removed from `loading`) while it loaded.
    if (!model || !this.projectileLoading.has(id) || !this.viewer.map) return;
    this.projectileLoading.delete(id);
    const inst = model.addInstance();
    inst.setScene(map.worldScene);
    inst.setSequence(this.missileSequence(inst)); // the flight loop, NOT index 0 (see missileSequence)
    inst.setSequenceLoopMode(2);
    this.projectileInsts.set(id, inst);
  }

  /** Capture browser/OS shortcuts (Ctrl+number tab-switch, etc.) so game hotkeys
   *  win. The Keyboard Lock API only engages in fullscreen (browser policy), so we
   *  (un)lock as fullscreen toggles; outside fullscreen our keydown preventDefault
   *  handles what it can. No-op where the API is unavailable. */
  private setupKeyboardLock(): void {
    const kb = (navigator as unknown as { keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
    if (!kb?.lock) return;
    const sync = (): void => {
      if (document.fullscreenElement) void kb.lock!().catch(() => {});
      else kb.unlock?.();
    };
    this.on(document, "fullscreenchange", sync);
    sync();
  }

  /** Centre the camera on the current selection (control-group / hero jump). */
  private jumpToSelection(): void {
    const c = this.rts?.selectionCentroid();
    if (c) {
      this.target[0] = c[0];
      this.target[1] = c[1];
    }
  }

  /**
   * A hero key (F1/F2/F3) or a control-group digit HELD after its double-tap: the camera rides
   * that selection until the key comes back up (issue #114). It follows the group's CENTROID —
   * the same point the double-tap jumped to — so a group stays framed as it spreads out, rather
   * than the camera clinging to whichever member is primary.
   *
   * Two things keep it from juddering, and both are about the follow agreeing with the world
   * it is following rather than about filtering harder:
   *
   * 1. **It moves on the SIM's clock, not the render one.** Units are drawn straight from sim
   *    positions — there is no interpolation between steps (see SIM_HZ) — so on screen they
   *    advance in whole SIM_DT jumps at 60 Hz however fast the display runs. A focus eased on
   *    the frame's `dtMs` therefore covers a different distance than the unit did, every frame,
   *    and the unit slides back and forth against the middle of the screen. It is invisible
   *    while the display happens to BE 60 Hz and one step lands per frame; on anything faster
   *    (or with vsync off) frames outnumber steps and it is the whole of the jitter. Measured
   *    on a held hero on Echo Isles: with frames outrunning the sim the hero slid 3.8 px per
   *    frame, which is 0.5 px once the follow is fed `lastSimStep` — the game time the sim
   *    actually retired — and the camera and the world advance together. (This is also why
   *    the frame loop derives the camera AFTER `advanceSim` rather than before it: aiming at
   *    where the group was one frame ago puts the same error back.)
   * 2. **A critically damped spring, not a plain ease.** What is left is the odd frame that
   *    retires two steps or none. A first-order ease answers that within the one frame — a
   *    flick; a spring has velocity, so it spreads the correction over the next few frames and
   *    the eye never catches it. Closed form about the goal, so any frame length is stable:
   *    x(t) = (d + (v + ωd)t)·e^(-ωt), ω = 1/τ.
   *
   * The camera trails the group by `2·τ·speed` — ~24 units for a running hero, a fifth of a
   * terrain tile, which is why the hero still reads as centred.
   */
  private followHeld(): void {
    if (!this.groupFollow) return;
    const c = this.rts?.selectionCentroid();
    if (!c) {
      this.groupFollow = false; // everyone it was following is gone
      return;
    }
    const dt = this.lastSimStep / 1000; // seconds of GAME time, 0 while the sim is stopped
    if (dt <= 0) return; // a paused/held world doesn't move, so neither does the camera
    const w = 1000 / FOLLOW_TAU_MS;
    const decay = Math.exp(-w * dt);
    for (let i = 0; i < 2; i++) {
      const d = this.target[i] - c[i];
      const step = (this.followVel[i] + w * d) * dt;
      this.target[i] = c[i] + (d + step) * decay;
      this.followVel[i] = (this.followVel[i] - w * step) * decay;
    }
  }

  /** Command-card icon (BLP path) of the local race's worker, for the idle button. */
  private workerIcon(): string | null {
    const workerId = (STARTING_UNITS[this.localRace] ?? []).map((s) => s.id).find((id) => WORKERS[id]);
    return (workerId && this.registry.get(workerId)?.icon) || null;
  }


  /** Whether the building on the cursor may be founded here — the shared per-cell
   *  buildable test (see `footprintBuildable`), asked of the placement's own footprint
   *  against the grid PLUS the ground the player's own pending builds have already spoken
   *  for. A building with no pathTex reserves nothing and can go anywhere. */
  private placementValid(x: number, y: number, reserved: ReadonlySet<number>): boolean {
    const p = this.placement;
    if (!p || !this.grid || !p.fp) return true;
    // A building that stands ON a gold mine is valid exactly where a free mine is, and
    // nowhere else — the mine's own cells are stamped unbuildable, so the ordinary footprint
    // test would refuse the one site it belongs on. See SimWorld.hauntTarget.
    if (this.rts?.simWorld.hauntsMines(p.def.id)) return !!this.rts.simWorld.hauntTarget(p.def.id, x, y);
    return footprintBuildable(this.grid, p.fp, x, y, reserved) && this.groundSuitsBuilding(p.def, x, y);
  }

  /** Where a placement ghost actually sits: on the build grid, except for a building that
   *  stands on a gold mine, which snaps onto the mine itself (WC3's Haunted Gold Mine ghost
   *  jumps from mine to mine rather than sliding over the ground). */
  private snapPlacement(def: UnitDef, x: number, y: number, fp: Footprint | null): [number, number] {
    const mine = this.rts?.simWorld.hauntTarget(def.id, x, y);
    if (mine) return [mine.x, mine.y];
    return fp && this.grid ? this.grid.snapForBuildingRect(x, y, fp.w, fp.h) : [x, y];
  }

  /** The second half of "may this go here": not whether the ground is CLEAR, but whether it
   *  is the right KIND of ground — `UnitBalance.requirePlace`. See SimWorld.footprintBlighted
   *  for why that column is the whole Undead placement rule and why nothing here names an id.
   *
   *  Split from `footprintBuildable` because the two refusals are different sentences in the
   *  game's own voice: a blocked site says "Unable to build there." in the local race's
   *  worker's voice, while off-blight says "Must summon structures upon Blight." over an
   *  Acolyte's own AcolytePlacedOffBlight1.wav ([Errors] Cantplace / Offblight). */
  private groundSuitsBuilding(def: UnitDef, x: number, y: number): boolean {
    if (def.requirePlace !== "blighted") return true;
    const world = this.rts?.simWorld;
    if (!world) return true;
    const fp = def.pathTex ? this.footprintFor(def.pathTex) : null;
    return world.footprintBlighted(x, y, fp?.w ?? 0, fp?.h ?? 0);
  }

  /**
   * The cells the local player's own build orders have already spoken for: every worker's
   * active `buildPending` site and every `buildnew` shift-queued behind it — i.e. exactly the
   * dark-blue ghosts on the ground (updatePendingBuildGhosts).
   *
   * WC3 draws those ghosts so you can see where you have already committed to build, and a
   * second building placed over one is the same mistake as one placed over the finished
   * structure — it just doesn't fail until the worker walks over. Nothing on the pathing grid
   * says so (no structure exists yet), so the reservation is carried here and handed to
   * `footprintBuildable` as its `taken` set.
   *
   * `exclude` is the worker whose orders this placement would REPLACE: an unshifted build
   * clears its worker's whole queue (issueOrder → clearQueue) before adding itself, so those
   * sites are about to be refunded and must not refuse the click that retires them — which is
   * what moving a build you just ordered a cell to the left is.
   */
  private pendingBuildCells(exclude = 0): Set<number> {
    const cells = new Set<number>();
    const grid = this.grid;
    if (!this.rts || !grid) return cells;
    const add = (defId: string, x: number, y: number): void => {
      const def = this.registry.get(defId);
      const fp = def?.pathTex ? this.footprintFor(def.pathTex) : null;
      if (fp) footprintCellsAt(grid, fp, x, y, cells);
    };
    for (const u of this.rts.simView.units.values()) {
      if (u.owner !== this.localPlayer || u.id === exclude) continue;
      if (u.buildPending) add(u.buildPending.defId, u.buildPending.x, u.buildPending.y);
      for (const o of u.orderQueue) if (o.kind === "buildnew") add(o.defId, o.x, o.y);
    }
    return cells;
  }

  /** Whether a NEW building of `defId` can no longer be founded at (x, y) — the same test
   *  the placement ghost's green/red squares draw, asked of a build order that was authorised
   *  earlier and may since have been overtaken by whatever went up on the spot. Bound once as
   *  a field: `tickPendingBuild` hands it to the sim for every worker on every frame, and has
   *  no business minting a closure each time. */
  private readonly siteBlocked = (defId: string, x: number, y: number): boolean => {
    const def = this.registry.get(defId);
    if (!def) return false;
    // Blight is not a fixed property of the ground: a shift-queued Ziggurat can be authorised
    // on rot that a Human expansion scrubs away before the Acolyte walks over, so the
    // requirement is re-asked here with everything else rather than only at the click.
    if (!this.groundSuitsBuilding(def, x, y)) return true;
    // A mine-standing building's site is the mine, whose own cells are unbuildable; it is
    // blocked only if the mine has gone or somebody else got there first.
    if (this.rts?.simWorld.hauntsMines(defId)) return !this.rts.simWorld.hauntTarget(defId, x, y);
    const fp = def.pathTex ? this.footprintFor(def.pathTex) : null;
    return !!fp && !!this.grid && !footprintBuildable(this.grid, fp, x, y);
  };

  /** Update the build-placement ghost under the cursor: the finished-building
   *  silhouette positioned on the ground, plus a green/red per-cell footprint grid
   *  (rebuilt here, drawn in the frame loop) that mirrors the pathing-obstruction
   *  collider — green cells are clear, red cells are blocked and prevent the build. */
  private updateGhost(cssX: number, cssY: number): void {
    if (!this.placement || !this.rts || !this.grid) {
      if (this.ghost) this.ghost.hidden = true;
      this.buildGhost?.hide();
      this.placeCellVerts = 0;
      return;
    }
    if (this.ghost) this.ghost.hidden = true; // the 3D footprint grid replaces the old DOM box
    const hit = this.rts.groundPoint(cssX, cssY);
    if (!hit) {
      this.buildGhost?.hide();
      this.placeCellVerts = 0;
      return;
    }
    const fp = this.placement.fp;
    const [x, y] = this.snapPlacement(this.placement.def, hit[0], hit[1], fp);
    // What this player's own pending builds have already claimed, in the same view the CLICK
    // will take: an unshifted placement retires its worker's own orders, so those cells are
    // free to it and the squares must not be drawn red over them. Shift is read from the
    // held-key set so the grid re-colours the instant the player reaches for it.
    this.placeReserved = this.pendingBuildCells(this.keys.has("shift") ? 0 : this.placement.workerId);
    // Rebuild the green/red footprint collider grid under the ghost.
    this.rebuildPlacementFootprint(x, y);
    if (this.buildGhost) {
      // Position the finished-building silhouette on the ground. NO vertex-colour tint —
      // the tint (a translucent multiply) was mangling many models; show the real look
      // and signal "blocked" with the red footprint cells instead.
      this.buildGhost.show();
      if (this.ghostBirthFrame >= 0) this.buildGhost.frame = this.ghostBirthFrame; // keep it fully built
      this.loc3[0] = x;
      this.loc3[1] = y;
      // Seat the ghost on the tallest terrain its footprint spans, exactly like the real
      // building will once built (issue #15), so the preview never sinks into a slope.
      this.loc3[2] = this.ghostGroundZ(x, y);
      this.buildGhost.setLocation(this.loc3);
      this.buildGhost.setVertexColor([1, 1, 1, 1]);
    }
  }

  /** Ground Z for the placement ghost — the tallest terrain its footprint touches, so
   *  the preview seats where the real building will (issue #15). Centre sample when the
   *  building has no footprint texture. */
  private ghostGroundZ(x: number, y: number): number {
    const fp = this.placement?.fp;
    const def = this.placement?.def;
    if (fp && def && this.footMaxHeight) {
      const [w, h] = seatHalfExtents(def, fp);
      return this.footMaxHeight(x, y, w, h);
    }
    return this.rts?.groundHeightAt(x, y) ?? 0;
  }

  /**
   * Push the sim's blight onto the terrain.
   *
   * Blight is the one thing in the game that repaints the GROUND ITSELF: it is not a decal
   * laid over the grass (an ubersplat) and not a tint, it is the tileset's own
   * `TerrainArt\Blight\<Tileset>_Blight.blp` re-sorted into the tile's texture stack, which
   * is why it blends with the neighbouring grass the way any two tiles do instead of ending
   * at a hard circle. mdx-m3-viewer already loads that texture and already honours a
   * `corner.blight` flag; what it had no way to do was change one after load, so the patch
   * adds `setBlight`/`flushBlight` and this is the only caller.
   *
   * Driven off the sim's own lattice, which IS the terrain corner lattice (BlightGrid), so
   * there is no resampling step and nothing to drift. Cheap by construction: the sim hands
   * over only the corners that CHANGED, so a settled base costs one empty array a frame.
   */
  private syncBlight(map: W3xMap): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    const { all, cells } = world.drainBlightUpdates();
    if (all) {
      // The change list overflowed (a map script blighting a whole region). Re-ask the grid
      // for everything rather than trying to reconstruct what was dropped.
      const grid = world.blight;
      if (!grid) return;
      for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.columns; col++) map.setBlight(col, row, grid.atCorner(col, row));
      }
    } else {
      if (!cells.length) return;
      for (const [col, row, on] of cells) map.setBlight(col, row, on);
    }
    map.flushBlight();
  }

  /** Rebuild the placement footprint grid batch centred on world (x, y): one terrain-
   *  hugging quad per BUILD cell (64u — WC3's placement square, 2×2 pathing cells) of
   *  the building's full (blue) footprint, green where buildable and red where
   *  obstructed. A square is drawn if any of its pathing cells belongs to the reserved
   *  footprint and turns red if any of them is blocked, so it shows exactly what the
   *  per-cell `buildable` test in placementValid decides — at the resolution the
   *  original game draws it (the Altar of Kings, 10×10 pathing cells, reads as the 5×5
   *  square it is in WC3). Drawn by the frame loop. */
  private rebuildPlacementFootprint(x: number, y: number): void {
    const p = this.placement;
    const h = this.heightSampler;
    if (!p || !p.fp || !this.grid || !h) {
      this.placeCellVerts = 0;
      return;
    }
    const fp = p.fp;
    const [ox, oy] = this.grid.origin;
    // Ground the building needs to BE something (`requirePlace`) rather than merely be clear:
    // the Undead's blight. Read per build square below, on the same 64-unit lattice
    // SimWorld.footprintBlighted decides on, so the red squares are exactly the refusal.
    const needsBlight = p.def.requirePlace === "blighted" ? this.rts?.simWorld ?? null : null;
    // Low-corner cell of the footprint — same centring as placementValid / stampFootprint.
    // snapForBuildingRect keeps it even, so build squares tile the footprint exactly.
    const [bx, by] = this.grid.worldToCell(x - (fp.w * PATHING_CELL) / 2, y - (fp.h * PATHING_CELL) / 2);
    const n = BUILD_CELL_CELLS;
    const cells: number[] = [];
    for (let sy = 0; sy < fp.h; sy += n) {
      for (let sx = 0; sx < fp.w; sx += n) {
        let reserved = false;
        let blocked = false;
        for (let cy = sy; cy < Math.min(sy + n, fp.h); cy++) {
          for (let cx = sx; cx < Math.min(sx + n, fp.w); cx++) {
            if (!fp.buildBlocked[cy * fp.w + cx]) continue; // the full reserved footprint
            reserved = true;
            if (!this.grid.buildable(bx + cx, by + cy)) blocked = true;
            // …and the ground the player's own un-started builds have spoken for reads as
            // blocked too, since the click over it is refused (see placementValid).
            if (this.placeReserved.has((by + cy) * this.grid.width + (bx + cx))) blocked = true;
          }
        }
        if (!reserved) continue;
        const x0 = ox + (bx + sx) * PATHING_CELL, y0 = oy + (by + sy) * PATHING_CELL;
        if (needsBlight && !needsBlight.isBlighted(x0 + BUILD_CELL / 2, y0 + BUILD_CELL / 2)) blocked = true;
        const color = blocked ? COLLIDER_COLORS.unbuildable : COLLIDER_COLORS.buildable;
        pushColliderQuad(cells, x0, y0, x0 + BUILD_CELL, y0 + BUILD_CELL, h, color);
      }
    }
    this.placeCells = Float32Array.from(cells);
    this.placeCellVerts = cells.length / FLOATS_PER_VERT;
  }

  /** Build the in-game HUD (plan §10.1b) over the map view. */
  private mountHud(): void {
    this.hud?.dispose();
    const ui = document.getElementById("ui") ?? document.body;
    const driver: HudDriver = {
      resources: () => {
        const food = this.rts?.foodFor(this.localPlayer) ?? { used: 0, made: 0 };
        const stash = this.rts?.stashFor(this.localPlayer) ?? { gold: 0, lumber: 0 };
        this.noteUpkeep(food.used); // the one place the local player's food is already read
        return {
          gold: stash.gold,
          lumber: stash.lumber,
          foodUsed: food.used,
          foodMax: food.made,
        };
      },
      minimapPing: (wx, wy) => this.signalPing(this.localPlayer, wx, wy),
      selection: () => this.rts?.selectedInfo() ?? null,
      dots: () => this.rts?.dots() ?? [],
      creepCamps: () => this.rts?.creepCamps() ?? [],
      minimapIcons: () => this.rts?.minimapIcons() ?? [],
      mapBounds: () => {
        const map = this.viewer.map;
        if (!map) return [0, 0, 1, 1];
        const [cols, rows] = map.mapSize;
        const [ox, oy] = map.centerOffset;
        return [ox, oy, (cols - 1) * 128, (rows - 1) * 128];
      },
      fogAt: (wx, wy) => this.rts?.getVision().stateAt(wx, wy) ?? 2, // 2 = visible (no fog before a match)
      cameraRect: () => this.viewRect(),
      panTo: (wx, wy) => {
        this.target[0] = wx;
        this.target[1] = wy;
      },
      minimapClick: (wx, wy, right, queued) => {
        if (!this.userControl) return "ignored"; // a cinematic owns the mouse — no orders
        if (this.placement) {
          // Building placement can't be aimed at the minimap; a right-click cancels it
          // (as it does in the world), a left-click is simply not a command.
          if (!right) return "none";
          this.cancelPlacement();
          return "ordered";
        }
        return this.rts?.minimapClick(wx, wy, right, queued) ?? "none";
      },
      focusSelected: (lock) => {
        this.cameraLock = lock;
        const pos = this.rts?.selectedPosition();
        if (pos) {
          this.target[0] = pos[0];
          this.target[1] = pos[1];
        }
      },
      setOrderMode: (mode) => {
        if (this.rts) this.rts.orderMode = mode;
      },
      stopSelected: () => this.rts?.stopSelected(),
      icon: (kind) => this.resourceIcon(kind),
      commandIcon: (name) => this.blpIcon(`ReplaceableTextures\\CommandButtons\\${name}.blp`),
      blpUrl: (path) => this.blpIcon(path),
      blpCanvas: (path) => {
        const bytes = this.vfs.rawBytes(path);
        return bytes ? blpToCanvas(bytes) : null;
      },
      chatPrompt: (target) =>
        chatPrompt(target, this.multiplayerMatch, (p) => this.playerLabel(p), (k) => this.globalStrings?.strings.get(k)),
      sendChat: (text, target) => this.sendChat(text, target),
      setResources: (next) => this.consoleUi?.update(next),
      dayNight: () => this.rts?.timeOfDay() ?? { hour: MELEE.MELEE_STARTING_TOD, isDay: true },
      mountClock: (slot) => this.mountClock(slot),
      controlEnabled: () => this.userControl,
      selectionIcons: () => this.rts?.selectionIcons() ?? [],
      selectGridUnit: (simId) => this.rts?.selectGridUnit(simId),
      deselectUnit: (simId) => this.rts?.deselectUnit(simId),
      selectSingle: (simId) => this.rts?.selectSingle(simId),
      tryTargetArmedAt: (simId) => this.rts?.tryTargetArmedAt(simId) ?? false,
      cycleFocus: (reverse) => this.rts?.cycleFocus(reverse),
      cycleIdleWorker: () => {
        if (this.rts?.cycleIdleWorker()) {
          const pos = this.rts.selectedPosition();
          if (pos) {
            this.target[0] = pos[0];
            this.target[1] = pos[1];
          }
        }
      },
      idleWorkerCount: () => this.rts?.idleWorkerCount() ?? 0,
      workerIcon: () => this.workerIcon(),
      assignControlGroup: (key) => this.rts?.assignGroup(key),
      appendControlGroup: (key) => this.rts?.appendGroup(key),
      recallControlGroup: (key, jump) => {
        if (!this.rts?.recallGroup(key)) return false;
        if (jump) this.jumpToSelection();
        return true;
      },
      selectHero: (index, jump) => {
        if (!this.rts?.selectHero(index)) return false;
        if (jump) this.jumpToSelection();
        return true;
      },
      followSelection: (on) => {
        this.groupFollow = on;
        if (on) {
          this.cameraLock = false; // one follow at a time — this replaces the portrait's
          this.followVel[0] = this.followVel[1] = 0; // the double-tap already put us there, at rest
        }
      },
      heroBar: () => this.rts?.heroBar() ?? [],
      rallyToHero: (index) => this.rts?.rallyToHero(index) ?? false,
      dropItemOnHero: (index, slot) => {
        const gave = this.rts?.dropItemOnHero(index, slot) ?? false;
        if (gave) this.hud?.setArmed(false); // the picked-up item has left the cursor
        return gave;
      },
      commandCard: () => this.commandCard(),
      runCommand: (id) => this.runCommand(id),
      inventory: () =>
        (this.rts?.inventorySlots() ?? []).map((s) =>
          s ? { icon: s.icon ? this.blpIcon(s.icon) : null, name: s.name, desc: s.desc, charges: s.charges, cooldownLeft: s.cooldownLeft, cooldownFrac: s.cooldownFrac, usable: s.usable } : null,
        ),
      useInventory: (slot) => {
        this.rts?.useInventorySlot(slot);
        this.hud?.setArmed(!!this.rts?.orderMode); // armed if this began a point-use targeting
      },
      moveInventory: (slot) => {
        this.rts?.moveInventorySlot(slot);
        this.hud?.setArmed(!!this.rts?.orderMode); // enter "target to move" mode
      },
      minimapImage: () => this.minimap,
      consoleSkinned: () => this.consoleSkinned(),
      skinPath: (key) => this.skinPath(key),
      cheat: (kind) => this.rts?.cheat(kind) ?? false,
      cheatSelected: (kind) => this.rts?.cheatSelected(kind),
      toggleColliders: () => (this.showColliders = !this.showColliders),
      togglePathing: () => (this.showPathing = !this.showPathing),
      toggleRegions: () => {
        this.showRegions = !this.showRegions;
        if (!this.showRegions) this.hideRegionLabels();
        return this.showRegions;
      },
      heroList: () =>
        this.registry
          .all()
          .filter((d) => d.isHero)
          .map((d) => ({ id: d.id, name: d.name, race: d.race }))
          .sort((a, b) => a.race.localeCompare(b.race) || a.name.localeCompare(b.name)),
      spawnTestHero: (typeId) => void this.spawnTestHero(typeId),
    };
    this.consoleUi?.dispose();
    // Built BEFORE the HUD so the HUD's own layers (the day/night medallion that hangs in the
    // strip's gap, the message column) stack over the console chrome rather than under it.
    this.consoleUi = new ConsoleUi(ui, this.vfs, SKIN_SECTION[this.localRace], {
      openPanel: (panel) => this.togglePanel(panel),
      disabledPanels: () => this.deadPanels(),
      mountClock: (slot) => this.mountClock(slot),
    });
    this.hud = new GameHud(ui, driver);
    this.mountScriptUi(ui);
    this.gameMenu?.dispose();
    this.gameMenu = new EscMenu(ui, this.vfs, SKIN_SECTION[this.localRace], {
      onReturn: () => {
        this.gameMenu?.hide();
        this.paused = false;
      },
      onEndGame: () => {
        this.gameMenu?.hide();
        this.paused = false;
        this.onExit?.();
      },
      // "Pause Game" closes the menu and leaves the world stopped — the one button on the
      // panel that does NOT resume, which is the whole difference from Return to Game.
      onPause: () => {
        this.gameMenu?.hide();
        this.paused = true;
      },
    });
    this.allies?.dispose();
    this.allies = new AllianceDialogOverlay(ui, this.vfs, SKIN_SECTION[this.localRace], {
      localPlayer: this.localPlayer,
      colorOf: (p) => this.rts?.playerColor(p) ?? p,
      // Everyone but yourself, and only seated slots — the matrix has 16 rows (12 players
      // plus the two neutrals), and the dialog is about the ones in the game.
      peers: () => [...this.meleeTeams.keys()]
        .filter((id) => id !== this.localPlayer)
        .sort((a, b) => a - b)
        .map((id) => ({ id, name: this.playerNames.get(id) ?? `Player ${id + 1}` })),
      get: (other, type) => this.rts?.getPlayerAlliance(this.localPlayer, other, type) ?? false,
      set: (other, type, value) => this.rts?.setPlayerAlliance(this.localPlayer, other, type, value),
      stash: () => this.rts?.stashFor(this.localPlayer) ?? { gold: 0, lumber: 0 },
      trade: (other, gold, lumber) => this.giveResources(other, gold, lumber),
      // A LAN client cannot write: see AllianceModel.writable.
      writable: !(this.rts?.frozenClient ?? false),
    });
    this.questLog?.dispose();
    this.questLog = new QuestDialogOverlay(ui, this.vfs, SKIN_SECTION[this.localRace], {
      quests: () => this.mapScript?.interp.rt.quests ?? [],
      // The w3i name is routinely a TRIGSTR_ placeholder; the script's runtime holds the
      // table that resolves it (empty until a script loads one, which resolves to itself).
      mapName: () => this.mapScript?.interp.rt.resolveTrigStr(this.mapDisplayName) ?? this.mapDisplayName,
      revision: () => this.mapScript?.interp.rt.questsRevision ?? 0,
    });
    this.chatDialog?.dispose();
    this.chatDialog = new ChatDialogOverlay(ui, this.vfs, SKIN_SECTION[this.localRace], {
      history: () => this.chatHistory,
      peers: () => [...this.meleeTeams.keys()]
        .filter((id) => id !== this.localPlayer)
        .sort((a, b) => a - b)
        .map((id) => ({ id, name: this.playerLabel(id) })),
      target: () => this.hud?.chatTargetNow() ?? { scope: "all" },
      setTarget: (target) => this.hud?.setChatTarget(target),
      hasObservers: () => false, // the lobby seats players only
    });
  }

  /** How long a chat line sits in the on-screen message area. The same span an untimed
   *  DisplayTextToPlayer line gets (ui/hud.ts MSG_DEFAULT_SECS) — chat is not more urgent
   *  than the map's own text, and the F12 history keeps it after it fades. */
  private static readonly CHAT_MESSAGE_SECS = 12;
  /** Lines kept in the chat history the F12 dialog and the Message Log read. Matches the
   *  `TextAreaMaxLines 128` those two frames declare in ChatDialog.fdf / LogDialog.fdf —
   *  keeping more than the panel can show would be bookkeeping nobody reads. */
  private static readonly CHAT_HISTORY_MAX = 128;

  /**
   * Is there anybody to talk TO? Counted in HUMAN seats, not seats: a skirmish against a
   * computer is a single-player game however many slots it fills, and the game has a separate
   * prompt for exactly that case — `COLON_MESSAGE_SINGLEPLAYER` is the flat "Message:", with
   * no "To" and nobody to name, because an AI is not going to read it.
   */
  private get multiplayerMatch(): boolean {
    return this.humanPlayers > 1;
  }

  /** A player's display label — the lobby name, as the owner line and the Allies rows use. */
  private playerLabel(player: number): string {
    return this.playerNames.get(player) ?? `Player ${player + 1}`;
  }

  /** The world the chat model routes against (src/game/chat.ts). */
  private chatWorld(): ChatWorld {
    return {
      players: () => [...this.meleeTeams.keys()],
      coAllied: (a, b) => this.rts?.playersAreCoAllied(a, b) ?? a === b,
      // No observer slots yet — the lobby seats players only, so nobody is watching.
      isObserver: () => false,
    };
  }

  /**
   * A line the local player typed. Route it, then show it to whoever hears it — which on this
   * machine means the local player, if they are among the recipients (you always see your own
   * chat: it is the only confirmation the message went anywhere).
   */
  private sendChat(text: string, target: ChatTarget): void {
    const link = this.rts?.matchLinkHandle ?? null;
    // On a CLIENT nothing is shown yet: the host decides who hears this, ourselves included,
    // and its ruling comes straight back. Showing it optimistically would mean a message that
    // was routed to nobody still appeared to have been sent.
    if (link && this.rts?.frozenClient) {
      link.askToSay(text, target);
      return;
    }
    this.deliverChat({ from: this.localPlayer, text, target });
  }

  /**
   * Raise the line to the map's script — `TriggerRegisterPlayerChatEvent`, which is how every
   * map that takes typed commands takes them ("-ap", "-random", "-kick 3").
   *
   * Fired for what the player SAID, regardless of who heard it: a chat command is aimed at
   * the map, not at the other players, and typing "-ap" to your allies still starts All Pick.
   * It is also raised for the raw text rather than the rendered line — a script matching "-ap"
   * must not have to see through a colour code and a name.
   */
  private fireChatTriggers(line: ChatLine): void {
    this.mapScript?.interp.firePlayerChat(line.from, line.text);
  }

  /** Show a chat line if the local player is one of its recipients, and remember it for the
   *  message log. The routing is the model's; this is only the local end of it. */
  /**
   * The AUTHORITY's path: decide who hears a line, tell them, and raise it to the map script.
   *
   * All three are the authority's alone. Only it holds the alliance matrix everyone agreed on,
   * so only it can say who counts as an ally; and only it runs the authoritative script, so a
   * chat trigger firing here and again on each client would execute the map's own logic once
   * per machine. A client takes `showChat` instead and decides nothing.
   */
  private deliverChat(line: ChatLine): void {
    this.fireChatTriggers(line);
    const heard = chatRecipients(line, this.chatWorld());
    const link = this.rts?.matchLinkHandle ?? null;
    if (link) for (const player of heard) link.relaySaid(player, line);
    if (heard.includes(this.localPlayer)) this.showChat(line);
  }

  /** Put a line on screen and in the history. No routing, no triggers — either this machine
   *  is the authority and has already done both, or the authority has done them for us. */
  private showChat(line: ChatLine): void {
    const rendered = formatChatLine(
      line,
      this.multiplayerMatch,
      (p) => this.playerLabel(p),
      (p) => teamColorHex(this.vfs, this.rts?.playerColor(p) ?? p),
      (k) => this.globalStrings?.strings.get(k),
    );
    this.chatHistory.push(rendered);
    if (this.chatHistory.length > MapViewerScene.CHAT_HISTORY_MAX) this.chatHistory.shift();
    // Chat rides the same on-screen message area the trigger text does, and expires the same
    // way — WC3 keeps it there for a while and then lets it go.
    this.hud?.showMessage(rendered, MapViewerScene.CHAT_MESSAGE_SECS);
  }

  /**
   * Hand gold and lumber to an ally — the Allies dialog's two gift fields on Accept.
   *
   * Straight onto the sim's stashes, because this machine is the authority whenever the
   * dialog can be written at all (AllianceModel.writable gates a LAN client out entirely).
   * The amounts have already been clamped to what the treasury holds, so this can't overdraw.
   */
  private giveResources(other: number, gold: number, lumber: number): void {
    this.transferResources(this.localPlayer, other, gold, lumber);
  }

  /**
   * Move gold and lumber from one player's treasury to another's, and tell the RECIPIENT —
   * the only player for whom a gift is news ("Received %d gold from %s.").
   *
   * Public because the giver is not always us: an AI ally handing over its bank, and a remote
   * player's gift arriving over the wire, are the same transaction from the other end, and
   * they must announce identically.
   */
  transferResources(fromPlayer: number, toPlayer: number, gold: number, lumber: number): void {
    const sim = this.rts?.simWorld;
    if (!sim || fromPlayer === toPlayer) return;
    const from = sim.stashOf(fromPlayer);
    const to = sim.stashOf(toPlayer);
    const sentGold = Math.max(0, Math.min(gold, from.gold));
    const sentLumber = Math.max(0, Math.min(lumber, from.lumber));
    from.gold -= sentGold;
    from.lumber -= sentLumber;
    to.gold += sentGold;
    to.lumber += sentLumber;
    if (toPlayer === this.localPlayer) this.noteResourcesFrom(fromPlayer, sentGold, sentLumber);
  }

  /**
   * The engine's OTHER voice: the top-left message log, where a map's own
   * `DisplayTextToPlayer` lines land — the ones WarChasers opens with — rather than the
   * centred gold line a refusal or a warning uses.
   *
   * Which of the two an [Errors] row belongs to is decided by what the row IS. A warning
   * about something happening to you is shouted over the console, where it interrupts
   * ("Our town is under siege!"); a report of a transaction between players — resources
   * arriving, control changing hands — is a line of record, and it reads with the map's
   * own text and stays there to be read.
   */
  private announce(text: string): void {
    if (text) this.hud?.showMessage(text, -1); // -1: the log's own default dwell
  }

  /** "Received %d gold and %d lumber from %s." — one row per combination the gift can be,
   *  which is why the data carries all three. */
  private noteResourcesFrom(from: number, gold: number, lumber: number): void {
    const g = Math.floor(gold);
    const l = Math.floor(lumber);
    if (g <= 0 && l <= 0) return;
    const who = this.playerLabel(from);
    const key = g > 0 && l > 0 ? "Goldandlumberfromally" : g > 0 ? "Goldfromally" : "Lumberfromally";
    const args = g > 0 && l > 0 ? [g, l, who] : [g > 0 ? g : l, who];
    this.announce(fillSlots(this.strings.forRace(key, this.localRace), args));
  }

  /**
   * Mark a spot on the minimap for the team, and — when somebody else is the one marking —
   * say so ("%s has marked the way.").
   *
   * MINIMAL, and knowingly so. The ping is raised and shown locally; nothing carries it to
   * the other machines yet, so today only this player and a map script (`PingMinimapForPlayer`
   * lands here too) can raise one. The audience test and the line are the parts worth having
   * early — when the wire learns to carry a ping, it calls this with the sender's id and the
   * message is already right.
   */
  signalPing(player: number, x: number, y: number): void {
    const co = player === this.localPlayer || (this.rts?.playersAreCoAllied(player, this.localPlayer) ?? false);
    if (!co) return; // an enemy's marker is not ours to see
    // The pinging player's own colour, so two allies marking two places are told apart.
    const [r, g, b] = teamColorRgb(this.vfs, this.rts?.playerColor(player) ?? player);
    this.hud?.ping({ x, y, duration: 0, r, g, b, extraEffects: true });
    if (player !== this.localPlayer) {
      this.announce(fillSlots(this.strings.forRace("Allyminimapping", this.localRace), [this.playerLabel(player)]));
    }
  }

  /**
   * "Upkeep level %d." — the line the game keeps for crossing an upkeep bracket, raised on
   * the change rather than every frame.
   *
   * MINIMAL, and the honest reason is that the data stops short: `Upkeeplevel` is one of the
   * few [Errors] rows with no war3skins sound beside it and nothing anywhere says what its
   * `%d` counts, so the band index (0 none / 1 low / 2 high — hud.ts upkeepBand) is our
   * reading and not the file's. Printed to the message log with the other reports.
   */
  private noteUpkeep(foodUsed: number): void {
    const band = upkeepBand(foodUsed);
    if (band === this.upkeepBandNow) return;
    const first = this.upkeepBandNow < 0;
    this.upkeepBandNow = band;
    if (first) return; // the opening reading is the state, not a change
    this.announce(fillSlots(this.strings.forRace("Upkeeplevel", this.localRace), [band]));
  }
  /** The band the local player was last seen in; -1 until the first reading. */
  private upkeepBandNow = -1;

  /**
   * The match ended out from under us: the room is gone, which in v1 means the host left.
   *
   * Freeze the world and say so. Freezing is the point — a client whose authority has gone
   * would otherwise keep simulating a world nobody owns, drifting further from a truth that no
   * longer exists, and every order it issued would go into a socket with nothing at the other
   * end. The words are the GAME'S (`UI\FrameDef\GlobalStrings.fdf`), not ours, so a localized
   * install says what it says; the literals are the fallback for a table that never loaded.
   */
  showMatchOver(): void {
    // A match that ENDED does not also get disconnected. Once the victory/defeat screen is up
    // this machine hangs up on purpose (Phase G item 1), and on the host that closes the room —
    // so every client is about to be told `room-closed` for a game that finished properly. That
    // is news about a wire nobody needs any more, not about the match.
    if (this.matchEnded) return;
    if (this.matchOver) return; // already said; a second `room-closed` is not a second dialog
    this.paused = true;
    const s = (key: string, fallback: string): string => this.globalStrings?.strings.get(key) ?? fallback;
    // The same root the HUD and the F10 menu mount into (`mountHud`).
    const ui = document.getElementById("ui") ?? document.body;
    this.matchOver = new MatchOverDialog(
      ui,
      {
        title: s("GAMEOVER_GAME_OVER", "Game over."),
        message: s("GAMEOVER_DISCONNECTED", "You were disconnected."),
        // The colour codes in GAMEOVER_QUIT_GAME mark the accelerator letter; we render text,
        // so strip them rather than print "|CFFFFFFFFQ|Ruit Game".
        quit: s("GAMEOVER_QUIT_GAME", "Quit Game").replace(/\|[cC][0-9a-fA-F]{8}|\|[rR]/g, ""),
      },
      () => {
        this.matchOver?.dispose();
        this.matchOver = null;
        this.paused = false;
        this.onExit?.();
      },
    );
  }

  /** Give the HUD's clock slot the local race's real TimeIndicator model, on its own
   *  little canvas. We drive it from this scene's frame loop (see updateClock) rather
   *  than letting it play, because its animation IS the day/night clock. */
  private mountClock(slot: HTMLElement): boolean {
    this.clock?.dispose();
    this.clock = null;
    if (!this.vfs.exists(timeIndicatorPath(this.localRace))) return false;
    const canvas = document.createElement("canvas");
    canvas.className = "hud-clock-canvas";
    slot.appendChild(canvas);
    // The medallion is wider than it is tall; hold the model's own aspect so the
    // gargoyle frame is never stretched. A provisional 2:1 gives the canvas a width
    // to lay out with before the model has loaded and told us the real ratio.
    slot.style.aspectRatio = "2";
    const clock = new TimeIndicatorClock(canvas, this.vfs);
    void clock.load(this.localRace).then((ok) => {
      if (!ok) return;
      slot.style.aspectRatio = String(clock.aspect);
      this.clock = clock;
    });
    return true;
  }

  /** Scrub the clock widget to the sim's hour, and cry once when the clock crosses
   *  Dawn or Dusk. The widget's 60-second "Stand" clip spans a whole 24-hour day, so
   *  `hour` alone decides every dot, the orb's spin and the sunrise flare; `dt` only
   *  feeds the model's real-time glow pulse. */
  private updateClock(dt: number): void {
    const tod = this.rts?.timeOfDay();
    this.clock?.render(tod?.hour ?? MELEE.MELEE_STARTING_TOD, dt);
    if (!tod) {
      this.wasDay = null; // no match running; re-arm for the next one
      return;
    }
    if (this.wasDay !== null && this.wasDay !== tod.isDay) {
      this.sounds?.playAmbience(tod.isDay ? DAWN_SOUND : DUSK_SOUND);
    }
    this.wasDay = tod.isDay;
  }

  /** Sample the tileset's day/night light at the sim's current hour and hand it to the
   *  world scene, which the (patched) ground, cliff and model shaders read (issue #47).
   *  Before a match starts there is no sim clock, so the map previews at the melee
   *  opening hour, 08:00 (Blizzard.j bj_MELEE_STARTING_TOD). */
  private applyDayNight(scene: Scene): void {
    scene.distFog = this.mapFog ?? undefined; // the map's environment fog (w3i)
    if (!this.dayNight) {
      scene.dncEnabled = 0;
      return;
    }
    const { terrain, unit } = this.dayNight.sample(this.rts?.timeOfDay().hour ?? MELEE.MELEE_STARTING_TOD);
    scene.dncTerrain = terrain;
    scene.dncUnit = unit;
    scene.dncEnabled = 1;
  }

  /**
   * Is the console's real chrome on screen?
   *
   * The art itself is not this object's business any more — `ConsoleUi` mounts it straight
   * out of `ConsoleUI.fdf` (ui/consoleUi.ts). The HUD only needs the yes/no, because the two
   * layouts it can use are different: over the real console its widgets sit in the sockets
   * punched through that art, and with no install mounted it falls back to its own CSS strip.
   *
   * This used to hand the HUD a hand-cropped ATLAS — the four tiles concatenated, then cut at
   * a guessed row (`height * 0.352`) and drawn as a background. The file says where every one
   * of those slices goes and which part of it to use; guessing put the band at the wrong
   * height and the wrong aspect, and every widget rect was then fitted by eye to that guess.
   */
  private consoleSkinned(): boolean {
    if (this.consoleSkinCache !== undefined) return this.consoleSkinCache;
    // The same four files ConsoleUI.fdf's ConsoleTexture01…04 decorate to (war3skins.txt).
    // Present ⇒ the FDF screen will have chrome to draw; absent ⇒ it will not.
    this.consoleSkinCache = [1, 2, 3, 4].every((i) => this.vfs.exists(this.skinPath(`ConsoleTexture0${i}`)));
    return this.consoleSkinCache;
  }

  /** Resolve a `UI\war3skins.txt` skin key against the LOCAL player's race — the same lookup
   *  the FDF's `DecorateFileNames` does, but synchronous and without a whole `FdfLibrary`,
   *  because the HUD asks for these one at a time while it is being built. A key the table
   *  doesn't have passes through, exactly as `FdfLibrary.decorate` lets a literal path do; a
   *  value with no extension (the console tiles are stored that way) gets `.blp`. */
  private skinPath(key: string): string {
    if (!this.skins) {
      const bytes = this.vfs.rawBytes(WAR3SKINS);
      this.skins = bytes ? parseWar3Skins(new TextDecoder("latin1").decode(bytes)) : new Map();
    }
    const value = skinValue(this.skins, SKIN_SECTION[this.localRace], key) ?? key;
    return /\.[a-z]{3,4}$/i.test(value) ? value : `${value}.blp`;
  }

  /** Keep the portrait canvas showing the selected unit's animated bust. */
  private updatePortrait(): void {
    if (!this.hud || !this.rts) return;
    const sel = this.rts.selectedInfo();
    if (!sel) {
      if (this.portraitFor !== null) {
        this.portraitFor = null;
        this.portraitLabel = "";
        this.portraitViewer?.stop();
      }
      return;
    }
    if (sel.id === this.portraitFor || this.portraitLoading || !sel.model) return;
    // The sound-set of the unit now in the portrait — a voice line with this label
    // drives the bust's talk animation (see the onVoiceStart hook in the ctor).
    this.portraitLabel = this.registry.get(sel.typeId)?.soundSet ?? "";
    const canvas = this.hud.portraitCanvas();
    if (!this.portraitViewer) this.portraitViewer = new ModelViewerScene(canvas, this.vfs);
    // The bust wears the same wash the unit wears on the terrain, so the panel and the
    // battlefield agree about what you have selected. Set on EVERY selection, not once at
    // load: one viewer is reused for every unit, and an illusion shares the hero's model —
    // so selecting the real Blademaster right after one of his images would otherwise
    // inherit the blue and show the hero as a copy. (sel.isIllusion is viewpoint-gated:
    // an enemy's image reports false and its bust stays untinted. See docs/illusions.md.)
    this.portraitViewer.setTint(sel.isIllusion ? [ILLUSION_TINT[0], ILLUSION_TINT[1], ILLUSION_TINT[2], 1] : [1, 1, 1, 1]);
    // WC3 ships dedicated talking-head models alongside most units.
    const portraitPath = sel.model.replace(/\.mdx$/i, "_Portrait.mdx");
    const path = this.vfs.exists(portraitPath) ? portraitPath : sel.model;
    this.portraitLoading = true;
    const id = sel.id;
    // Team glow follows the owner's COLOUR, not their slot (see RtsController.playerColor) —
    // Rise of the Naga recolours Maiev's slot 0 to BLUE, and a bust keyed on the slot showed
    // her red in the console while the same model stood blue on the terrain. 12 is the
    // classic neutral (black) slot, for a unit with no owner at all.
    // The `portrait` flag makes the viewer loop the model's "Portrait" idle clip
    // instead of walk/stand (portrait models have no walk — a stray one on some
    // heroes was being picked, so the bust just froze).
    // The Paladin's authored portrait camera crops the right of his face — pan
    // the bust camera a bit left so the whole face shows.
    const panLeft = /paladin/i.test(sel.model) ? 0.14 : 0;
    this.portraitViewer
      .load(path, sel.owner >= 0 ? this.rts.playerColor(sel.owner) : 12, true, panLeft)
      .then(() => {
        this.portraitFor = id;
        this.portraitViewer!.start();
        // The selection voice ("What") likely started before this bust finished
        // loading — its onVoiceStart no-op'd because the instance wasn't ready yet.
        // If that line is this unit's and still playing, mouth the remaining span.
        const v = this.lastVoice;
        if (v && v.label === this.portraitLabel) {
          const remaining = v.until - performance.now();
          if (remaining > 0) this.portraitViewer!.playTalk(remaining / 1000);
        }
      })
      .catch(() => {})
      .finally(() => {
        this.portraitLoading = false;
      });
  }

  // --- cinematics (7.24) -------------------------------------------------------------

  /**
   * Open or close one of the four console panels: the Quest Log (F9), the Game Menu (F10),
   * the Allies dialog (F11) and the Chat dialog (F12).
   *
   * BOTH routes to them come through here — the console's own buttons and the F-keys — and
   * three rules live here because all three are about the panels as a GROUP:
   *
   *  • **Not during a cinematic.** WC3 takes the whole interface away for the length of one
   *    (`ShowInterface(false)` IS the letterbox), and these panels are interface: the key does
   *    nothing while the bars are down, and one that was already open goes with the console
   *    rather than floating over the film (see syncHudVisible). Keyed on the letterbox alone,
   *    like the cursor and like ESC-skips-the-cinematic: `EnableUserUI(false)` is the momentary
   *    blackout blizzard.j flicks around each cinematic FADE, and a panel must not blink for it.
   *  • **One at a time.** They are all modal (each mounts its own scrim), so two at once is two
   *    scrims and a panel buried under a panel. Opening any of them shuts the rest.
   *  • **Some are dead in a campaign** (see panelDead).
   */
  private togglePanel(panel: ConsolePanel): void {
    if (!this.interfaceShown || this.panelDead(panel)) return;
    const wasOpen = this.panelOpen(panel);
    this.closePanels(); // one at a time — and this is also how a toggle CLOSES its own panel
    if (!wasOpen) {
      if (panel === "quests") this.questLog?.show();
      else if (panel === "menu") this.gameMenu?.show();
      else if (panel === "allies") this.allies?.show();
      else this.chatDialog?.show();
    }
    this.syncPanelPause();
  }

  /** Is this panel on screen right now? */
  private panelOpen(panel: ConsolePanel): boolean {
    if (panel === "quests") return this.questLog?.visible === true;
    if (panel === "menu") return this.gameMenu?.visible === true;
    if (panel === "allies") return this.allies?.visible === true;
    return this.chatDialog?.visible === true;
  }

  /** Panels this match has no use for: a CAMPAIGN chapter is single-player against the map's
   *  own AI, so there is nobody to ally with and nobody to talk to — WC3 leaves the Allies and
   *  Chat buttons dead through a mission, and the F-keys with them. The console greys the same
   *  two from the same answer (ConsoleUiActions.disabledPanels). */
  private panelDead(panel: ConsolePanel): boolean {
    return this.campaign && (panel === "allies" || panel === "chat");
  }

  /** The panels a campaign kills — the console's own copy of `panelDead`. */
  private deadPanels(): ReadonlySet<ConsolePanel> {
    return this.campaign ? MapViewerScene.CAMPAIGN_DEAD_PANELS : MapViewerScene.NO_DEAD_PANELS;
  }
  private static readonly CAMPAIGN_DEAD_PANELS: ReadonlySet<ConsolePanel> = new Set(["allies", "chat"] as const);
  private static readonly NO_DEAD_PANELS: ReadonlySet<ConsolePanel> = new Set();

  /** Shut every console panel. Idempotent — each panel's own `hide` is. */
  private closePanels(): void {
    this.gameMenu?.hide();
    this.questLog?.hide();
    this.allies?.hide();
    this.chatDialog?.hide();
    this.syncPanelPause();
  }

  /**
   * Hold the world at the gate, for as long as the loading screen is up (see `startGame` in
   * src/main.ts).
   *
   * The map is built and its script's init has run by then, but nothing may MOVE yet — and
   * that is every game, not just a campaign chapter waiting on a keypress. The match used to
   * begin the moment its setup returned, which is several seconds before the screen came
   * down: the soundtrack played, creeps wandered and the melee clock ran to a picture that
   * said "L O A D I N G". The world now stands built and still behind the screen and starts
   * when the player sees it.
   *
   * A flag of its own rather than `paused`, because the map's own `PauseGame` writes that one
   * and the two must not clobber each other — a chapter that pauses itself in init (they do,
   * for their opening scenes) would otherwise be un-paused by our release.
   */
  holdAtStart(on: boolean): void {
    this.startHeld = on;
    // The clock is not owed the held time: `advanceSim` re-stamps `simLast` every pass while
    // held, so releasing steps forward from now rather than replaying the whole wait at once.
  }

  /** **The Quest Log stops the world, exactly as the Game Menu does.** Single-player WC3
   *  pauses behind both — they are the two panels you READ, and the mission is not allowed to
   *  move on while you do. The Allies and Chat dialogs do not pause: those are things you do
   *  while the match runs. Recomputed from what is actually open rather than tracked per
   *  keypress, so the "one at a time" rule above can't leave the world stopped behind a panel
   *  that is no longer there. */
  private syncPanelPause(): void {
    this.paused = this.gameMenu?.visible === true || this.questLog?.visible === true;
  }

  /** The HUD is on screen only when the interface (ShowInterface) AND the UI (EnableUserUI)
   *  are both on. Two natives, two different jobs — the letterbox hides the console for the
   *  duration of a cinematic; EnableUserUI hides everything for the duration of a fade. */
  private syncHudVisible(): void {
    const on = this.interfaceShown && this.userUi;
    if (on) this.hud?.show();
    else this.hud?.hide();
    // **And the console CHROME, which is a different element.** `GameHud` owns what sits IN
    // the console's sockets — the minimap picture, the portrait, the command card, the
    // hero bar; the console art itself (the bottom band AND the top strip carrying the
    // resource readout and the Quests/Menu/Allies/Chat buttons) is `ConsoleUI.fdf`, drawn
    // under it by ui/consoleUi.ts. Hiding only the HUD left every cinematic playing behind
    // the full frame with empty holes in it, which is the opposite of a letterbox.
    this.consoleUi?.setVisible(on);
    // …and the WORLD-layer half of the interface: the floating health/mana bars and the hero
    // level badge, which are drawn over the terrain but belong to the UI (see
    // RtsController.updateHealthBars).
    this.rts?.setInterfaceShown(on);
    // The MOUSE is part of the interface too. `ShowInterface(false)` is the letterbox, and
    // WC3 draws no cursor at all under one: the console is gone and the pointer goes with it,
    // because there is nothing left on screen to point AT. (Keyed on the letterbox alone —
    // `EnableUserUI(false)`, which blizzard.j flicks around each cinematic fade, is a
    // momentary blackout of the same screen and must not make the cursor blink back.)
    document.body.classList.toggle("cine-on", !this.interfaceShown);
    // A panel that was already open when the bars came down goes with the console. Leaving
    // it up would float the Quest Log over the film — and the Game Menu holds the sim
    // PAUSED, which would stop the cinematic the player is watching dead.
    if (!this.interfaceShown) this.closePanels();
  }

  /** Put a dialog on screen — or take it down — and with it the MOUSE (issue #104).
   *
   *  A cinematic hides the cursor (`cine-on`, above), but a dialog is the one thing that
   *  outranks the letterbox: it is BUTTONS, and buttons you cannot see the pointer over are
   *  buttons you cannot click. WC3 does exactly this — a `DialogDisplay` during cinematic
   *  mode brings the cursor back for as long as the dialog is up, and hides it again when the
   *  dialog is dismissed. That is the ENGINE's doing, not the script's: no native shows the
   *  cursor, and blizzard.j's own cinematic path (CinematicModeExBJ) never mentions it.
   *  The rule is body-wide, as the cursor itself is — once the engine draws it, it is drawn
   *  over the whole screen, not clipped to the panel. */
  private showDialog(d: DialogObj | null): void {
    this.dialog?.update(d);
    document.body.classList.toggle("dialog-on", !!d);
  }

  /** The speaker's animated bust, on the cinematic panel's own canvas. Same machinery as the
   *  HUD's portrait (a `_Portrait.mdx` looping its Portrait clip) but a SEPARATE viewer —
   *  the two are on screen at once during a transmission in ordinary play, and one would
   *  otherwise steal the other's canvas.
   *
   *  `typeId` is a unit TYPE, not a unit: a transmission shows the portrait of whatever the
   *  speaker IS (SetCinematicScene takes a unit-type rawcode), so a Footman speaking always
   *  shows the Footman bust. `color` is that native's `playercolor` — the bust is the one
   *  team-colourable thing on the panel (the FDF paints the text itself), which is what the
   *  parameter is for; it used to be hardcoded to 12, the neutral BLACK slot, so every
   *  speaker's armour came up the wrong colour.
   *
   *  **Loading is async and transmissions are not spaced out**, so this is written as a pump
   *  rather than a fire-and-forget: `want` is the last portrait asked for, and the loop keeps
   *  going until what is on the canvas is what is wanted. Without it a stale load simply won
   *  by finishing last — two transmissions in one tick left the second speaker wearing the
   *  first one's face, and every transmission after that inherited the mismatch. */
  private async loadCinematicPortrait(typeId: string, color: number, talkSeconds = 0): Promise<void> {
    // Key on type AND colour: the same unit type speaking for two different players is two
    // different busts. Re-loading is cheap — ModelViewerScene caches the parsed model.
    this.cinePortraitWant = typeId ? `${typeId}|${color}` : "";
    // **And the mouth moves.** A transmission's whole point is a talking head, and every
    // WC3 portrait model carries a "Portrait Talk" clip beside its resting "Portrait" one.
    // `SetCinematicScene`'s LAST parameter is how long the voice line runs
    // (`DoTransmissionBasicsXYBJ` passes the sound's own duration), so it is exactly the
    // window to hold that clip for. The HUD's bust has done this since the selection sounds
    // landed; the cinematic panel's — the one the player actually watches — never did.
    this.cinePortraitTalk = Math.max(0, talkSeconds);
    const panel = this.cinematic;
    if (!panel || !typeId) return;
    const canvas = panel.portraitCanvas();
    this.cinePortraitViewer ??= new ModelViewerScene(canvas, this.vfs);
    if (this.cinePortraitLoading) return; // the running pump will pick the newer want up
    this.cinePortraitLoading = true;
    try {
      while (this.cinePortraitWant && this.cinePortraitWant !== this.cinePortraitFor) {
        const want = this.cinePortraitWant;
        const [wantType, wantColor] = want.split("|");
        const def = this.registry.get(wantType);
        if (!def?.model) {
          this.cinePortraitFor = want; // nothing to show for this type; stop asking
          continue;
        }
        const portraitPath = def.model.replace(/\.mdx$/i, "_Portrait.mdx");
        const path = this.vfs.exists(portraitPath) ? portraitPath : def.model;
        try {
          await this.cinePortraitViewer.load(path, Number(wantColor), true, 0);
          this.cinePortraitFor = want;
          this.cinePortraitViewer.start();
        } catch {
          this.cinePortraitFor = want; // no bust for this type — an empty pane, but stop retrying
        }
      }
      // Started AFTER the load, because `load` resets the talk clock (it rebuilds the
      // instance and re-resolves the sequence indices). Asking before the bust exists is
      // the same no-op the HUD's portrait has to work around.
      if (this.cinePortraitTalk > 0) this.cinePortraitViewer.playTalk(this.cinePortraitTalk);
    } finally {
      this.cinePortraitLoading = false;
    }
  }

  /** Seconds of "Portrait Talk" the current transmission asked for (see above). */
  private cinePortraitTalk = 0;

  /** Portrait busts are loaded lazily on the first selection of each unit type:
   *  the MDX parse + texture upload stalls a frame (measured 100–280ms), and the
   *  very first portrait additionally builds the bust viewer + compiles its
   *  shaders. Warm them in the background instead — preload the portrait model for
   *  every type the player is likely to click (units on the map now, plus the
   *  local race's producible roster) during idle, so the click just reuses a
   *  cached model. Re-scanned periodically so freshly trained/scouted types warm
   *  before they're clicked; the lazy load() in updatePortrait() stays the
   *  fallback for anything selected before warming reaches it. */
  private warmPortraits(): void {
    if (!this.hud || !this.rts) return;
    const consider = (typeId: string) => {
      const def = this.registry.get(typeId);
      if (!def?.model) return;
      const portraitPath = def.model.replace(/\.mdx$/i, "_Portrait.mdx");
      const path = this.vfs.exists(portraitPath) ? portraitPath : def.model; // mirror updatePortrait()
      if (this.warmedPortraits.has(path)) return;
      this.warmedPortraits.add(path);
      this.portraitWarmQueue.push(path);
    };
    for (const u of this.rts.simView.units.values()) consider(u.typeId);
    // …plus everything the local player is likely to make (see producibleRoster), whose
    // models the start preload has already pulled in — this is their busts.
    for (const id of this.producibleRoster()) consider(id);
    this.schedulePortraitWarm();
  }

  /** Drain the portrait-warm queue one model per idle slice — a parse + GPU
   *  upload is heavy (up to ~90ms for a big building), so one at a time keeps each
   *  slice short. Creating the viewer on the first slice moves the one-time shader
   *  compile off the click too. Yields to any in-flight on-click load so warming
   *  never contends for the viewer's single instance slot. */
  private schedulePortraitWarm(): void {
    if (this.portraitWarmScheduled || !this.portraitWarmQueue.length) return;
    this.portraitWarmScheduled = true;
    const run = () => {
      this.portraitWarmScheduled = false;
      if (!this.hud) return; // match torn down
      if (!this.portraitViewer) this.portraitViewer = new ModelViewerScene(this.hud.portraitCanvas(), this.vfs);
      if (this.portraitLoading) { this.schedulePortraitWarm(); return; } // let the real selection win
      const path = this.portraitWarmQueue.shift();
      if (!path) return;
      this.portraitViewer
        .preload(path)
        .catch(() => {})
        .finally(() => this.schedulePortraitWarm());
    };
    const ric = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback.bind(window) : null;
    if (ric) ric(run, { timeout: 2000 });
    else setTimeout(run, 50);
  }

  // --- command card ---------------------------------------------------------

  /** The one place a command button is made — so it is also the one place that can promise a
   *  button never shows a raw `<AIlf,DataA1>` placeholder. Callers that know the ability and
   *  rank resolve first (with that rank); this is the backstop for everything else, and for
   *  whatever button gets added next. Resolving twice is free: the second pass sees no `<`. */
  private cmd(over: Partial<CommandButton>): CommandButton {
    const b: CommandButton = { id: "", icon: null, name: "", hotkey: "", desc: "", gold: 0, lumber: 0, food: 0, mana: 0, col: 0, row: 0, disabled: false, cantAfford: false, active: false, ...over };
    b.desc = this.tipText(b.desc);
    if (b.tip) b.tip = this.tipText(b.tip);
    // Unavailable is a texture swap in the original, not a tint (see disabledArt), so the
    // one place a button is made is also the one place that finds its greyed twin. Only
    // for `disabled`: a button you merely can't PAY for is still a live button — it takes
    // the click that earns "Not enough gold.", and it keeps its frame to say so. And only
    // when it is actually greyed, because the twins of live buttons would double every
    // card's decode for art nobody sees.
    if (b.icon && b.disabled) b.disabledIcon = this.disabledArt(b.icon);
    return b;
  }

  /** Hero types the local player already has or is producing — owned hero units,
   *  plus heroes queued in the player's own buildings (altars) or in a neutral shop
   *  (tavern). WC3 heroes are unique per player and capped at MAX_HEROES, so these
   *  are removed from / disabled on the altar & tavern cards. */
  private heroTypesInProduction(player: number): Set<string> {
    const set = new Set<string>();
    const world = this.rts?.simWorld;
    if (!world) return set;
    for (const u of world.units.values()) {
      if (u.owner === player && this.registry.get(u.typeId)?.isHero) set.add(u.typeId);
      // Altars the player owns + neutral shops (taverns) they hire from — and at a shop,
      // only the jobs they are PAYING for (see Authority.heroTypesInProduction, which
      // gates the training itself on the same rule).
      if (u.building && (u.owner === player || u.neutralPassive)) {
        for (const job of u.building.queue) {
          if (job.kind !== "unit" || !this.registry.get(job.unitId)?.isHero) continue;
          if (u.neutralPassive && u.owner !== player && job.buyer !== player) continue;
          set.add(job.unitId);
        }
      }
    }
    // …and the ones finished but not yet born (SimWorld.pendingTrained). A hire never enters a
    // queue, so this is the only thing keeping a just-bought Tavern hero on her own card for
    // the tick before she exists.
    for (const t of world.pendingTrained()) {
      if (t.owner === player && this.registry.get(t.unitId)?.isHero) set.add(t.unitId);
    }
    return set;
  }

  /** Units this building trains (`Trains`) or SELLS (`Sellunits` — a Tavern's heroes, a
   *  Mercenary Camp's creeps). Both end up in the same production queue; the difference is
   *  that a sold unit comes off the shop's stock and shouts to the creeps around it. */
  private pushTrainButtons(sel: SelectionInfo, out: CommandButton[], reserved: string[] = []): void {
    const world = this.rts!.simWorld;
    const t = this.tech.get(sel.typeId);
    const sold = new Set(t.sellunits);
    const list = [...t.trains, ...t.sellunits];
    if (!list.length) return;
    const food = this.rts!.foodFor(this.localPlayer);
    const stash = this.rts!.stashFor(this.localPlayer);
    // WC3 hero rules (shared by altars + taverns): a hero already owned or in production is
    // removed from the card; once the player has MAX_HEROES the rest are disabled.
    const heroesInProduction = this.heroTypesInProduction(this.localPlayer);
    const atHeroCap = heroesInProduction.size >= MAX_HEROES;
    // Some races share a buttonpos between two VISIBLE trainees (Orc's Grunt & Demolisher are
    // both 0,0; Shaman & Spirit Walker collide too), so when a slot is already taken the button
    // flows to the next free cell (WC3 packs them left-to-right). rtma-replaced units
    // (Headhunter↔Berserker) never both show, so those don't count as collisions.
    //
    // `reserved` is the cells the CALLER will occupy this frame — Rally (3,1) and Cancel
    // (3,2), which the game itself pins there (CommandFunc.txt [CmdRally] Buttonpos=3,1,
    // [CmdCancelTrain] 3,2). Reserving them unconditionally, as this used to, wrecked the
    // Tavern: its eight heroes fill rows 1 and 2 exactly (`[Nfir] Buttonpos=3,1`,
    // `[Nalc] Buttonpos=3,2`), so the Firelord and the Alchemist were shoved up into the
    // empty top row and the card came out in the wrong order — for a neutral shop that is
    // yours to neither rally nor, until you queue something, cancel.
    const used = new Set<string>(reserved);
    const place = (bx: number, by: number): [number, number] => {
      if (!used.has(`${bx},${by}`)) return [bx, by];
      for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 4; rx++) if (!used.has(`${rx},${ry}`)) return [rx, ry];
      return [bx, by];
    };
    for (const uid of list) {
      const d = this.registry.get(uid);
      if (!d) continue;
      if (d.isHero && heroesInProduction.has(uid)) continue; // already have/queued this hero
      // An `rtma` upgrade can make a unit unavailable outright — the plain Siege Engine
      // vanishes from the Workshop card the moment Barrage is researched, replaced by the
      // Barrage-equipped one. That's a hide, not a grey-out.
      if (world.tech && world.tech.maxAllowed(this.localPlayer, uid) === 0) continue;

      const owned = this.trainTier(uid, heroesInProduction.size);
      const freeHero = d.isHero && this.rts!.hasFreeHero(this.localPlayer); // first hero is free
      const gold = freeHero ? 0 : d.goldCost;
      const lumber = freeHero ? 0 : d.lumberCost;
      // A SOLD unit is on a shelf, and an empty shelf is a COOLDOWN, not a "no": a Tavern's
      // heroes are only stocked 135 seconds into the game (`stockStart`, UnitBalance.slk), and
      // the button has to say so with the clockwise sweep and the countdown an ability wears
      // — same as the item wares in pushShopButtons, which is where this was already right.
      const st = sold.has(uid) ? world.shopStockInfo(sel.id, uid) : null;
      const stock = st?.count ?? -1;
      const restocking = !!st && st.count <= 0 && Number.isFinite(st.timer) && st.period > 0;
      // The badge counts a shelf DOWN. An `unlimited` ware (`stockRegen` 0 — a Tavern's heroes,
      // and every unit WTii's Unit Tester sells) has no level to report: it is back the instant
      // it is taken, so a permanent "1" in the corner would be stating the opposite of the truth.
      const badge = stock > 0 && !st?.unlimited ? stock : undefined;
      // A unit the shop SELLS asks nothing of you unless it is a hero — being in stock is the
      // gate (SimWorld.soldUnitNeedsTech). The greying and the red "Requires:" line have to say
      // the same thing, so both come off the one answer, exactly as the item wares do.
      const gated = !sold.has(uid) || world.soldUnitNeedsTech(uid);
      const metTech = gated
        ? world.canMake(this.localPlayer, uid, owned)
        : world.tech?.maxAllowed(this.localPlayer, uid) !== 0;
      const afford = stash.gold >= gold && stash.lumber >= lumber && food.used + d.foodUsed <= food.made;
      const inStock = stock !== 0; // -1 = not stock-limited, 0 = sold out
      const [col, row] = place(d.buttonX, d.buttonY);
      used.add(`${col},${row}`);
      out.push(this.cmd({
        id: `train:${uid}`, icon: this.blpIcon(d.icon), name: d.name, hotkey: d.hotkey || (d.name[0]?.toUpperCase() ?? ""),
        tip: d.tip, // "Train |cffffcc00P|reasant" — the game's own tooltip title
        desc: this.tipText(d.description || `Trains a ${d.name}.`) + this.requirementLine(uid, owned, gated ? undefined : []),
        gold, lumber, food: d.foodUsed,
        count: badge, // the shop's stock badge
        cooldownLeft: restocking ? st.timer : 0,
        cooldownFrac: restocking ? Math.max(0, Math.min(1, st.timer / st.period)) : 0,
        col, row,
        // Unavailable vs unaffordable, and the split matters (issue #98): a missing
        // requirement (or a fourth Hero) is a hard NO with no line to say it, so the
        // button goes inert; a price or an empty shelf keeps the button live so
        // trainUnit can answer the click with "Not enough gold." / "Out of stock".
        disabled: !metTech || (d.isHero && atHeroCap),
        cantAfford: !afford || !inStock,
      }));
    }
  }

  /** Upgrades this building can research (`Researches`). The button shows the NEXT level:
   *  a Blacksmith that has Iron Forged Swords offers Steel, with its own name, icon, cost
   *  and prerequisite (a Keep). Once every level is in, the button drops off the card. */
  private pushResearchButtons(sel: SelectionInfo, out: CommandButton[]): void {
    if (sel.owner !== this.localPlayer) return; // you don't research at someone else's shop
    const world = this.rts!.simWorld;
    const state = world.tech;
    const stash = this.rts!.stashFor(this.localPlayer);
    for (const upId of this.tech.researches(sel.typeId)) {
      const d = this.upgrades.get(upId);
      if (!d) continue;
      const have = state?.researchLevel(this.localPlayer, upId) ?? 0;
      // Something already in this building's queue counts as done for the card's purposes,
      // so you can't queue Steel Forged Swords twice.
      const queued = world.researchingLevel(sel.id, upId);
      const next = Math.max(have, queued) + 1;
      if (next > d.maxLevel) continue; // fully researched — the button is gone, as in WC3
      const cost = this.upgrades.cost(upId, next);
      const tier = next - 1; // requirement tier is 0-based on the LEVEL for an upgrade
      const metTech = !state || state.meets(this.localPlayer, upId, tier);
      const afford = stash.gold >= cost.gold && stash.lumber >= cost.lumber;
      out.push(this.cmd({
        id: `research:${upId}`,
        icon: this.blpIcon(this.upgrades.icon(upId, next)),
        name: this.upgrades.name(upId, next),
        hotkey: this.upgrades.hotkey(upId, next),
        tip: this.upgrades.tip(upId, next), // "Upgrade to Iron Forged |cffffcc00S|rwords"
        desc: this.tipText(this.upgrades.uberTip(upId, next)) + this.requirementLine(upId, tier),
        gold: cost.gold, lumber: cost.lumber, food: 0,
        ...this.researchSlot(upId, d),
        disabled: !metTech, // no Keep yet → inert, the way WC3 greys it out
        cantAfford: !afford, // affordable-later → still clickable, still answered
      }));
    }
  }

  /** The command-card slot for a research button. Normally the upgrade's own buttonpos, but a
   *  few carry a slot that doesn't match the reference client — the Orc Barracks shows the
   *  Berserker Upgrade above Troll Regeneration, the reverse of their raw Animprops buttonpos —
   *  so those are corrected here. */
  private researchSlot(upId: string, d: { buttonX: number; buttonY: number }): { col: number; row: number } {
    const swap: Record<string, [number, number]> = {
      Robk: [1, 1], // Berserker Upgrade — above Troll Regeneration
      Rotr: [1, 2], // Troll Regeneration — below the Berserker Upgrade
    };
    const [col, row] = swap[upId] ?? [d.buttonX, d.buttonY];
    return { col, row };
  }

  /** What this building can BECOME (`Upgrade`) — Town Hall → Keep → Castle, and the Scout
   *  Tower's three-way fan-out into Guard / Cannon / Arcane Tower. The cost and time are the
   *  TARGET's own (a Keep is 705g/415l/140s), and each option carries its own requirements
   *  (a Cannon Tower needs a Workshop). */
  private pushBuildingUpgradeButtons(sel: SelectionInfo, out: CommandButton[]): void {
    if (sel.owner !== this.localPlayer) return;
    const world = this.rts!.simWorld;
    if (world.isUpgrading(sel.id)) return; // already becoming something — one transformation at a time
    const stash = this.rts!.stashFor(this.localPlayer);
    for (const toId of this.tech.upgradesTo(sel.typeId)) {
      const d = this.registry.get(toId);
      if (!d) continue;
      const metTech = world.canMake(this.localPlayer, toId, 0);
      const [gold, lumber] = this.upgradeCost(sel.typeId, d); // the DIFFERENCE, not the full price
      const afford = stash.gold >= gold && stash.lumber >= lumber;
      out.push(this.cmd({
        id: `upgrade:${toId}`, icon: this.blpIcon(d.icon), name: d.name,
        hotkey: d.hotkey || (d.name[0]?.toUpperCase() ?? ""),
        tip: d.tip, // "Upgrade to |cffffcc00K|reep"
        desc: this.tipText(d.description || `Upgrades to a ${d.name}.`) + this.requirementLine(toId),
        gold, lumber, food: 0,
        col: d.buttonX, row: d.buttonY,
        disabled: !metTech,
        cantAfford: !afford,
      }));
    }
  }

  /** A building tier upgrade costs the DIFFERENCE between the new building and the one it
   *  replaces (WC3), never less than zero. */
  private upgradeCost(fromTypeId: string | undefined, to: UnitDef): [number, number] {
    const from = fromTypeId ? this.registry.get(fromTypeId) : undefined;
    return [Math.max(0, to.goldCost - (from?.goldCost ?? 0)), Math.max(0, to.lumberCost - (from?.lumberCost ?? 0))];
  }

  /** Items a shop sells. The Arcane Vault uses `Makeitems`, the neutral shops `Sellitems` —
   *  same card either way. Each item carries its own tech gate (a Potion of Healing needs a
   *  Keep, via the TWN2 pseudo-tech) and its own stock, shown as the button's count badge.
   *  Buying needs a "valid patron" — a hero standing within the shop's activation radius —
   *  which is checked in the sim; here it only decides the greying. */
  /** WC3's "Select Hero" / "Select Unit" toggle on a shop that delivers to a unit. Clicking
   *  it arms a target mode; the next click on one of your units makes that unit the shop's
   *  purchaser (the sim's setShopBuyer) and moves the overhead arrow onto it.
   *
   *  What the shop CARRIES decides whether the button exists (Aneu/Aall yes, Ane2 no), but
   *  everything the button SHOWS comes from `[Anei]` — "Select User", hotkey U, at Buttonpos
   *  3,2, with `BTNSelectUnit.blp`. `Anei` is a UI-only button definition, not an ability
   *  (see UI_BUTTON_IDS): it has no AbilityData.slk row because nothing casts it.
   *
   *  None of that can be taken from the shop's own ability. `Aneu`/`Ane2` are RoC-era and
   *  say "Select Hero"/"Select Unit" with an `Art` — `BTNSelectHeroOn.blp` — that is a red
   *  "?" PLACEHOLDER in War3.mpq with nothing overriding it. `Aall` is worse: its only
   *  string is the internal designer label "Shop Sharing, Allied Bldg." and it has no hotkey
   *  at all. `Anei` is what TFT added to label this button properly. */
  private pushSelectUserButton(sel: SelectionInfo, out: CommandButton[]): void {
    const world = this.rts!.simWorld;
    if (!world.shopSelectsUser(sel.id)) return;
    const def = this.abilities.get("Anei");
    if (!def) return;
    // No `active` state: arming this collapses the card to a lone Cancel (isTargeting),
    // exactly as arming a spell does, so the button is never on screen while it is armed.
    const buyer = world.shopBuyer(sel.id, this.localPlayer);
    out.push(this.cmd({
      id: `selectuser:${sel.id}`,
      icon: this.blpIcon(def.icon),
      name: def.name,
      hotkey: def.hotkey,
      tip: def.tips[0],
      desc: this.tipText(def.uberTips[0] ?? ""),
      // 3,2 — the bottom-right corner, and it is Anei's own Buttonpos. That corner is
      // Cancel's on most cards, but a shop only shows Cancel with a production queue.
      col: def.buttonX,
      row: def.buttonY,
      // Nothing to nominate: no unit of yours with an inventory is standing close enough.
      disabled: !buyer,
    }));
  }

  private pushShopButtons(sel: SelectionInfo, out: CommandButton[]): void {
    const world = this.rts!.simWorld;
    // Built from the BUILDING, not the unit type: a Marketplace declares no wares at all and
    // carries only what Blizzard.j's stock timer has put on its shelves (issue #57).
    const wares = world.shopWaresOf(sel.id);
    this.pushSelectUserButton(sel, out);
    if (!wares.items.length) return;
    const stash = this.rts!.stashFor(this.localPlayer);
    const hasPatron = world.shopPatrons(sel.id, this.localPlayer).length > 0;
    // Slot assignment, and it is NOT simply "read Buttonpos". Three of the Goblin Merchant's
    // eleven wares — Boots of Speed, Scroll of Protection, Potion of Invisibility — declare NO
    // Buttonpos at all in ItemFunc.txt, and its other eight leave exactly three gaps on the
    // 4×3 card (Cancel owns the last slot). So WC3 pins the wares that name a slot and lets
    // the rest fill the holes; treating "no Buttonpos" as 0,0 stacked all three under the
    // Circlet, which really is at 0,0, and they simply vanished from the shop.
    //
    // The same pass carries the Marketplace, whose stock is RANDOM: two rolled items can want
    // the same slot, and the loser takes the next free one rather than disappearing.
    const taken = new Set<number>([3 + 2 * 4]); // (3,2) — Cancel
    const slots = new Map<string, number>();
    const claim = (id: string, want: number): void => {
      let s = want;
      if (s < 0 || s > 11 || taken.has(s)) {
        s = 0;
        while (s < 12 && taken.has(s)) s++;
      }
      if (s > 11) return; // card full — nothing left to put it in
      taken.add(s);
      slots.set(id, s);
    };
    const wants = (id: string): number => {
      const d = this.items.get(id);
      return d && d.buttonX >= 0 && d.buttonY >= 0 ? d.buttonX + d.buttonY * 4 : -1;
    };
    for (const id of wares.items) if (wants(id) >= 0) claim(id, wants(id)); // pinned first…
    for (const id of wares.items) if (!slots.has(id)) claim(id, -1); // …then the rest fill the gaps
    for (const itemId of wares.items) {
      const d = this.items.get(itemId);
      const slot = slots.get(itemId);
      if (!d || slot === undefined) continue;
      // What this SHOP asks of this buyer — not what the item asks in the abstract. A NEUTRAL
      // shop asks nothing at all; see SimWorld.missingForShop.
      const missing = world.missingForShop(sel.id, itemId, this.localPlayer);
      const afford = stash.gold >= d.gold && stash.lumber >= d.lumber;
      // Out of stock is a COOLDOWN, not a "no": the ware is coming back, and the button says
      // when with the same clockwise sweep an ability wears (`stockRegen` seconds, or the
      // longer `stockStart` wait before its first ever arrival).
      const st = world.shopStockInfo(sel.id, itemId);
      const stock = st?.count ?? -1;
      const restocking = !!st && st.count <= 0 && Number.isFinite(st.timer) && st.period > 0;
      out.push(this.cmd({
        id: `buy:${itemId}`, icon: this.blpIcon(d.icon), name: d.name,
        hotkey: d.hotkey, tip: d.tip,
        desc: this.tipText(d.description) + (hasPatron ? "" : "|n|cffff0000A valid patron must be nearby.|r") + this.requirementLine(itemId, 0, missing),
        gold: d.gold, lumber: d.lumber, food: 0,
        count: stock > 0 ? stock : undefined,
        cooldownLeft: restocking ? st.timer : 0,
        cooldownFrac: restocking ? Math.max(0, Math.min(1, st.timer / st.period)) : 0,
        col: slot % 4,
        row: Math.floor(slot / 4),
        // Only the tech gate makes the ware inert — and unavailable is the only thing the
        // card draws. Everything else here has an [Errors] line of its own — "Not enough
        // gold.", "Out of stock", "A valid patron must be nearby." — which buyItem speaks
        // when the click arrives, so the ware sits there at full brightness looking exactly
        // as buyable as it is (an empty shelf also carries the restock sweep, below).
        disabled: missing.length > 0,
        cantAfford: !afford || stock <= 0 || !hasPatron,
      }));
    }
  }

  /** The tech ids the local player is missing for `id`, rendered as the game's own red
   *  "Requires:" tooltip line. WC3 names the requirement by its display name — and the
   *  pseudo-techs have names of their own ("Keep or Stronghold or Tree of Ages or Halls of
   *  the Dead" for TWN2), which is why they live in the data rather than being spelled out. */
  private requirementLine(id: string, tier = 0, override?: string[]): string {
    const state = this.rts?.simView.tech;
    if (!state) return "";
    // `override` lets a caller narrow the list — a neutral shop asks less of a buyer than the
    // item's raw data does (SimWorld.missingForShop), and the red line must say the same thing
    // the greying does.
    const missing = override ?? state.missing(this.localPlayer, id, tier);
    if (!missing.length) return "";
    const names = missing.map((t) => this.techName(t));
    return `|n|cffff0000Requires: ${names.join(", ")}|r`;
  }

  /** A requirement's display name for the LOCAL player. Most ids just carry their own name,
   *  but the pseudo-techs are OR-groups over the four races (`[TWN2] DependencyOr=hkee,ostr,
   *  etoa,unp1` in ItemFunc.txt) and their name spells out every branch — "Keep or Stronghold
   *  or Tree of Ages or Halls of the Dead". The game names only YOUR branch ("Requires:
   *  Stronghold" for an Orc), so resolve the group to whichever member is the local race's,
   *  and fall back to the group's own name if none is (a neutral player, a modded group). */
  private techName(id: string): string {
    const own = this.registry.get(id);
    if (own?.name) return own.name;
    // …an UPGRADE requirement (`[Acan] Requires=Ruac`, Cannibalize) is in neither the unit
    // registry nor, necessarily, the tech graph: `loadTechRegistry` keeps only rows that say
    // something about the tree, and an upgrade with no prerequisites of its OWN says nothing —
    // so `Ruwb` (which needs a Crypt) is in it and `Ruac` (which needs nothing) is not, and the
    // red line read "Requires: Ruac". Its name has always been there in
    // <Race>UpgradeStrings.txt, which the upgrade registry reads; ask that before falling back.
    if (this.upgrades.get(id)) return this.upgrades.name(id, 1);
    const def = this.tech.get(id);
    for (const alt of def.dependencyOr) {
      const d = this.registry.get(alt);
      if (d?.race === this.localRace) return d.name;
    }
    return def.name || id;
  }

  /** The requirement TIER a train button indexes with. A unit indexes by how many copies the
   *  player owns — but a HERO indexes by how many HEROES they have, of any type. Heroes are
   *  unique per player, so a hero's own copy count never leaves 0, and gating on it would mean
   *  the Nth-hero requirement never fires: an altar's `[Hpal] Requires1=hkee` and a tavern's
   *  `[Nbrn] Requires1=TWN2,TALT` are both "your SECOND hero needs a tier-2 hall", not "your
   *  second Paladin". */
  private trainTier(uid: string, heroCount: number): number {
    return this.registry.get(uid)?.isHero ? heroCount : this.rts!.countOwned(this.localPlayer, uid);
  }

  /** Are we AIMING — an armed order (or a building ghost) waiting on the click that
   *  targets it? This is the state the reticle cursor is up for, and the state whose
   *  command card is nothing but Cancel.
   *
   *  Carrying an inventory item between slots is deliberately NOT aiming: it arms
   *  `orderMode` the same way, but it's a drag inside the console, not an order the
   *  unit is about to take — so the card stays put under it (same carve-out the
   *  reticle makes in updateReticle). */
  private isTargeting(): boolean {
    if (this.placement) return true; // a building ghost following the cursor
    const mode = this.rts?.orderMode ?? null;
    if (!mode) return false;
    return !(mode === "item" && this.rts?.armedItem?.mode === "move");
  }

  /** The command card for the current selection, with every button's grid slot resolved
   *  (see `layoutCard` — two buttons may WANT the same cell). */
  private commandCard(): CommandButton[] {
    return this.layoutCard(this.buildCommandCard());
  }

  /**
   * Seat every button in the 4×3 grid, honouring `col`/`row` as a PREFERENCE rather than an
   * address. Two abilities on one unit routinely want the same cell: `buttonpos` is authored
   * per RACE, so each hero's four skills are laid out 0,2 / 1,2 / 2,2 / 3,2 independently and
   * a custom map that mixes skill sets collides immediately. WarChasers' Skeletorus takes the
   * Far Seer's Chain Lightning (`AOcl`, `Researchbuttonpos=0,0`) and the Demon Hunter's Mana
   * Burn (`AEmb`, also `0,0`); Blizzard's own melee data collides 45 times over (the Destroyer
   * asks for `0,2` twice, for Devour Magic and Absorb Mana). The HUD writes buttons into
   * `row * 4 + col`, so the loser used to be silently overwritten — the reported bug.
   *
   * MEASURED off the real 1.27a client (WarChasers, Skeletorus' learn page): the engine shows
   * FOUR buttons — Chain Lightning keeps slot 0, Brilliance Aura and Death And Decay keep the
   * 2 and 3 their data asks for, and Mana Burn is pushed to the free slot 1. So a collision
   * falls FORWARD into the next free cell; nothing is ever dropped.
   *
   * Two passes, because the fall-forward must not evict a button that legitimately owns the
   * cell it lands on: everyone who CAN have their preference gets it first, then the displaced
   * are seated in emission order, each scanning forward (wrapping) from the cell it asked for
   * — which is what keeps a bumped hero spell in the bottom row next to its siblings instead
   * of stranding it up among the orders.
   */
  private layoutCard(cards: CommandButton[]): CommandButton[] {
    const SLOTS = 12;
    const taken: (CommandButton | undefined)[] = new Array(SLOTS).fill(undefined);
    const wanted = (c: CommandButton) => c.row * 4 + c.col;
    const displaced: CommandButton[] = [];
    for (const c of cards) {
      const i = wanted(c);
      if (i >= 0 && i < SLOTS && !taken[i]) taken[i] = c;
      else displaced.push(c);
    }
    for (const c of displaced) {
      const start = Math.max(0, Math.min(SLOTS - 1, wanted(c)));
      for (let n = 1; n <= SLOTS; n++) {
        const i = (start + n) % SLOTS;
        if (taken[i]) continue;
        taken[i] = c;
        c.col = i % 4;
        c.row = Math.floor(i / 4);
        break;
      }
    }
    // A card with more than twelve buttons has nowhere left to put the rest; they stay out
    // rather than overwriting a seated one (only reachable on absurd custom data).
    return taken.filter((c): c is CommandButton => !!c);
  }

  /** Build the command card for the current selection. */
  private buildCommandCard(): CommandButton[] {
    const sel = this.rts?.selectedInfo();
    if (!sel) return [];
    const world = this.rts!.simWorld;
    // A shop the local player may buy from shows its purchase card even though they don't own
    // it (a Tavern, a Goblin Merchant — all Neutral Passive). Anything else must be theirs.
    const foreignShop = sel.isBuilding && sel.owner !== this.localPlayer && world.isShopUnit(sel.id);
    if (sel.owner !== this.localPlayer && !foreignShop) return [];
    const btnIcon = (n: string) => this.blpIcon(`ReplaceableTextures\\CommandButtons\\${n}.blp`);
    const out: CommandButton[] = [];

    // TARGET MODE — an order is armed and waiting for the click that aims it (Attack,
    // Move, Patrol, Set Rally Point, Repair, a spell picking its target) or a building
    // is being placed. WC3 empties the card down to a single Cancel in the bottom-right
    // corner: while you're aiming, the un-issued order is the only thing in flight, and
    // dropping it is the only other thing you can do. Its own strings say exactly that —
    // Units\commandstrings.txt [CmdCancel] "Drops the current un-issued order and allows
    // you to select a different order." Escape runs it, as does a right-click on the map.
    if (this.isTargeting()) {
      const text = this.strings.command("CmdCancel");
      out.push(this.cmd({
        id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape",
        tip: text.tip || "Cancel (|cffffcc00ESC|r)",
        desc: text.ubertip || "Drops the current un-issued order and allows you to select a different order.",
        col: 3, row: 2,
      }));
      return out;
    }

    if (sel.underConstruction) {
      out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Cancel construction.", col: 3, row: 2 }));
      return out;
    }
    // …and for the 2.5 seconds of `Aroo`'s own transition (`Dur1`), an Ancient is NEITHER
    // thing: it is hauling its roots up or settling them back down, and the card is EMPTY.
    // Not greyed — gone. The stance flips on the tick the button is pressed (see
    // SimUnit.morphT) so that everything derived from `uprooted` stays consistent, which
    // would otherwise hand a tree that is still visibly a building the walking card, and a
    // tree still visibly walking the structure card, for the whole length of the animation.
    // The sim is already of the same mind — `castLocked` refuses every order while `morphT`
    // runs — so an empty card is simply the honest picture of a unit that can be told
    // nothing.
    //
    // The ROOT transition and nothing else, which is why it asks whether this unit can root.
    // Every other form toggle sets `morphT` too now (a Crypt Fiend takes `[Abur] Dur1` = 1.45s
    // to get underground), and for those the card is the SAME card on both sides of the
    // change — one Burrow button that becomes one Unburrow button — so blanking it would be
    // a flicker rather than a picture. Those grey instead; see `morphing` in
    // pushAbilityButtons. The Ancient is the case where the two cards are genuinely different
    // objects, and that is what makes emptying it the right answer there.
    const morphingUnit = world.units.get(sel.id);
    if ((morphingUnit?.morphT ?? 0) > 0 && morphingUnit!.abilities.some((a) => a.code === "Aroo")) return [];
    // An UPROOTED Ancient is a building that is currently a unit, and its card says so: WC3
    // gives it the mobile order set and takes the whole structure card away. That is not a
    // cosmetic swap — everything the building card offers is something a walking Ancient
    // genuinely cannot do (its queue is HALTED while it walks, it has no rally point to
    // place, and Entangle Gold Mine wants roots in the ground). Falling through to the
    // movable-unit branch below is the whole implementation; the rooted-only abilities are
    // filtered inside pushAbilityButtons, which both branches share.
    if (sel.isBuilding && !world.units.get(sel.id)?.uprooted) {
      // Which of the two pinned corners are actually spoken for THIS frame — the trainee grid
      // flows around them, and a Tavern (no rally, nothing queued) has both cells free for
      // the Firelord and the Alchemist the data puts there. Kept in step with the two pushes
      // at the bottom of this branch.
      const wantsRally = !foreignShop && !!world.units.get(sel.id)?.building?.producesUnits;
      const reserved = [...(wantsRally ? ["3,1"] : []), ...(sel.queueLength ? ["3,2"] : [])];
      this.pushShopButtons(sel, out); // items a shop sells (Arcane Vault, Goblin Merchant)
      this.pushTrainButtons(sel, out, reserved); // units it trains / sells (Barracks, Tavern, Merc Camp)
      this.pushResearchButtons(sel, out); // upgrades it researches (Blacksmith, Lumber Mill…)
      this.pushBuildingUpgradeButtons(sel, out); // what it can become (Town Hall → Keep)

      const su = world.units.get(sel.id);
      // The ATTACK command. An armed building is told what to shoot exactly as a unit is —
      // that is how you point a Guard Tower at the Ziggurat instead of at the Ghoul in front
      // of it — and which armed buildings get the button is the data's own call: UnitWeapons
      // `showUI`. Every tower and the Orc Burrow ship showUI1=1; the fourteen rows that ship 0
      // are the Undead halls (Necropolis / Halls of the Dead / Black Citadel) and the Night
      // Elf Ancients, whose attack is not yours to aim. An EMPTY Orc Burrow has no button at
      // all, because it has no attack: recomputeStats switches its arrow slot off until a peon
      // is inside it. Not for a shop you merely trade with — that is not your building.
      // A tower cannot walk, so an out-of-range target is refused at the click with the game's
      // own "Target is outside range." (SimWorld.issueAttack → [Errors] Notinrange).
      // …and STOP beside it, in the same cell a mobile unit's Stop owns (1,0). A building you
      // may aim can be given an order, so it needs the one command that takes an order back:
      // without it a tower told to shoot a particular target had no way to be told to stop,
      // and the only way off the order was to kill the thing. Same button, same hotkey and
      // the same resting-state highlight as everywhere else — a building doing nothing is
      // stopped, which is what activeCommandId already reports.
      if (!foreignShop && su?.weapons.some((w) => w.enabled && w.showUI)) {
        const active = this.activeCommandId();
        out.push(this.cmd({
          id: "attack", icon: btnIcon("BTNAttack"), name: "Attack", hotkey: "A",
          desc: "Attacks a target unit.", col: 3, row: 0, active: active === "attack",
        }));
        out.push(this.cmd({
          id: "stop", icon: btnIcon("BTNStop"), name: "Stop", hotkey: "S",
          desc: "Halts the unit's current order.", col: 1, row: 0, active: active === "stop",
        }));
      }
      // Orc Burrow garrison (UnitAbilities.slk otrb: Abtl Battle Stations + Astd Stand Down).
      // Battle Stations pulls nearby peons in; Stand Down (shown once occupied) sends them
      // back to work. Icons/hotkeys/slots are the ability data's own (OrcAbilityFunc/Strings).
      if (su && su.garrisonCap > 0 && (!su.building || su.building.constructionLeft <= 0)) {
        // The Entangled Gold Mine has the same kind of hold and a different card. Its crew is
        // in there to WORK, not to shoot, so there is no Battle Stations to pull them in and
        // no Stand Down to send them back — just `Aenc`'s own Unload All, with that row's art
        // and slot (NightElfAbilityFunc [Aenc] Unart=BTNUnload, Unbuttonpos=0,2; hotkey U).
        // Loading is a right-click: you send a wisp at the mine, you don't fetch it from here.
        if (world.cargoHoldCode(su.typeId) === "Aenc") {
          // `Aenc`'s own two halves, at that row's own art and slots (NightElfAbilityFunc
          // [Aenc]: Art=BTNLoad Buttonpos=1,2, Unart=BTNUnload Unbuttonpos=0,2). Load arms a
          // pick — "Orders a Wisp to enter the gold mine" — and is greyed once the crew is
          // full, because there is nowhere left to put one.
          out.push(this.cmd({
            id: "load", icon: btnIcon("BTNLoad"), name: "Load", hotkey: "L",
            desc: "Orders a Wisp to enter the gold mine.", col: 1, row: 2,
            disabled: su.garrison.length >= su.garrisonCap,
          }));
          if (su.garrison.length > 0)
            out.push(this.cmd({ id: "standdown", icon: btnIcon("BTNUnload"), name: "Unload All", hotkey: "U", desc: "Removes all Wisps from the gold mine.", col: 0, row: 2 }));
        } else {
          out.push(this.cmd({ id: "battlestations", icon: btnIcon("BTNBattleStations"), name: "Battle Stations", hotkey: "B", desc: "Causes nearby Peons to run into the Burrow so that they can defend their base.", col: 0, row: 2 }));
          if (su.garrison.length > 0)
            out.push(this.cmd({ id: "standdown", icon: btnIcon("BTNBacktoWork"), name: "Stand Down", hotkey: "D", desc: "Causes Peons within the Burrow to return to work.", col: 1, row: 2 }));
        }
      }

      // Cancel always owns the bottom-right slot (3,2) — the canonical WC3 spot. Set Rally
      // Point sits one above it at (3,1), so it never shares the cancel slot. A neutral shop
      // isn't yours to rally.
      if (wantsRally) {
        const rallyIcon = { human: "BTNRallyPoint", orc: "BTNOrcRallyPoint", undead: "BTNRallyPointUndead", nightelf: "BTNRallyPointNightElf" }[this.localRace];
        // No active state: placing a rally point is an aim, not an order in flight,
        // and a building has no "current command" to keep it lit afterwards.
        out.push(this.cmd({ id: "rally", icon: btnIcon(rallyIcon), name: "Set Rally Point", hotkey: "Y", desc: "Sets where newly-trained units gather.", col: 3, row: 1 }));
      }
      if (sel.queueLength) out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Cancel the last item in the queue.", col: 3, row: 2 }));
      // …and the abilities the building's own UnitAbilities row gives it, at the slots their
      // `Buttonpos` asks for — which is where the Arcane Tower's Feedback (`Afbt`, 3,2) and
      // Magic Sentry (`Adts`, 2,1) live, and the Nerubian Tower's Frost Attack (`Afra`, 0,2).
      // Same call the mobile card makes, so an upgrade-gated one (`[Adts] Requires=Rhse`) only
      // appears once that research lands, exactly as it does on a unit.
      if (!foreignShop) this.pushAbilityButtons(sel, out);
      return out;
    }

    // Movable units. Build sub-page for workers, else the order set.
    if (this.cardPage === "build" && sel.isWorker) {
      const stash = this.rts!.stashFor(this.localPlayer);
      // The worker's OWN `Builds` list from its profile — `[hpea] Builds=htow,hhou,hbar,…`.
      // Structures whose prerequisites aren't met are greyed with a red "Requires:" line
      // rather than hidden, which is what WC3 does (you can see the Guard Tower is there and
      // that it wants a Lumber Mill).
      for (const bid of this.tech.builds(sel.typeId)) {
        const d = this.registry.get(bid);
        if (!d) continue;
        const afford = stash.gold >= d.goldCost && stash.lumber >= d.lumberCost;
        const metTech = world.canMake(this.localPlayer, bid, 0);
        out.push(this.cmd({
          id: `build:${bid}`, icon: this.blpIcon(d.icon), name: d.name, hotkey: d.hotkey || (d.name[0]?.toUpperCase() ?? ""),
          tip: d.tip, // "Build |cffffcc00F|rarm" — the verb is already in the game's Tip
          desc: this.tipText(d.description || `Builds ${d.name}.`) + this.requirementLine(bid),
          gold: d.goldCost, lumber: d.lumberCost, food: 0,
          col: d.buttonX, row: d.buttonY,
          // The issue-#98 case itself: a Guard Tower with no Lumber Mill is greyed AND
          // inert — clicking it must not hand the worker a ghost to place. Being short
          // of gold doesn't stop you picking the building up; placing it says why.
          disabled: !metTech,
          cantAfford: !afford,
        }));
      }
      out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Return to orders.", col: 3, row: 2 }));
      return out;
    }

    // Learn-skill sub-page (heroes): spend a skill point on a new/higher ability.
    // Cards fill the TOP row(s) left→right (developer request), each showing a "+"
    // affordance and the effect it grants at the next rank.
    if (this.cardPage === "learn" && sel.isHero) {
      const su = this.rts!.simView.units.get(sel.id);
      if (su) {
        for (const ab of su.abilities) {
          const def = this.abilities.get(ab.id);
          if (!def) continue;
          const col = def.learnX; // researchbuttonpos — the WC3 learn-page slot (row 0)
          const row = def.learnY;
          const maxed = ab.level >= def.levels;
          const nextRank = ab.level + 1;
          const need = requiredHeroLevel(def, nextRank);
          const canLearn = su.skillPoints > 0 && !maxed && su.level >= need;
          // The learn page has its own pair of strings in AbilityStrings: Researchtip
          // ("Learn Holy Ligh|cffffcc00t|r - [|cffffcc00Level %d|r]") and Researchubertip,
          // which spells out what every rank does. Use them, and add the game's own
          // "Hero level:" requirement line (GlobalStrings REQUIREDLEVELTOOLTIP) while
          // the hero is too low to take the next rank.
          const shown = Math.min(nextRank, def.levels);
          const tip = def.researchTip
            ? def.researchTip.replace(/%d/g, String(shown))
            : `Learn ${def.name} - [Level ${shown}]`;
          const body = def.researchUberTip
            ? this.tipText(def.researchUberTip, def, shown)
            : this.abilityDesc(def, shown);
          const desc = maxed || su.level >= need ? body : `${body}|n|n|cffffcc00Hero level: ${need}|r`;
          out.push(this.cmd({
            id: canLearn ? `learn:${ab.id}` : "noop",
            icon: this.blpIcon(def.icon),
            name: maxed ? `${def.name} (Max)` : `+ ${def.name} [${ab.level}/${def.levels}]`,
            hotkey: def.researchHotkey, // Researchhotkey — a passive has no cast Hotkey to borrow
            tip: maxed ? `${def.name} - [|cffffcc00Level ${def.levels}|r]` : tip,
            desc,
            col, row, disabled: !canLearn,
          }));
        }
        out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Return to orders.", col: 3, row: 2 }));
      }
      return out;
    }

    // WC3 layout (developer spec): top row = Move, Stop, Hold, Attack; Patrol at
    // (0,1); a worker's Build (or a hero's learn-skill) at (3,1); the bottom row
    // is reserved for learned skills/abilities.
    const active = this.activeCommandId();
    out.push(this.cmd({ id: "move", icon: btnIcon("BTNMove"), name: "Move", hotkey: "M", desc: "Moves the unit to a target point.", col: 0, row: 0, active: active === "move" }));
    out.push(this.cmd({ id: "stop", icon: btnIcon("BTNStop"), name: "Stop", hotkey: "S", desc: "Halts the unit's current order.", col: 1, row: 0, active: active === "stop" }));
    out.push(this.cmd({ id: "hold", icon: btnIcon("BTNHoldPosition"), name: "Hold Position", hotkey: "H", desc: "Holds the unit's position.", col: 2, row: 0, active: active === "hold" }));
    out.push(this.cmd({ id: "attack", icon: btnIcon("BTNAttack"), name: "Attack", hotkey: "A", desc: "Attacks a target unit, or attack-moves to a point.", col: 3, row: 0, active: active === "attack" }));
    out.push(this.cmd({ id: "patrol", icon: btnIcon("BTNPatrol"), name: "Patrol", hotkey: "P", desc: "Patrols between here and a target point.", col: 0, row: 1, active: active === "patrol" }));
    // Build sits at the bottom-left of a worker's card (developer spec) — but only on a worker
    // that HAS something to build. `Builds` is a per-unit column (`[hpea] Builds=htow,hhou,
    // hbar,…`) and the GHOUL's is empty: it gathers lumber and does nothing else, so WC3 gives
    // it no Build button, and behind the one it had was an empty page.
    //
    // REPAIR is gone from here entirely, for the same reason and with the same evidence.
    // Repairing is an ABILITY — `Ahrp` on the Peasant, `Arep` on the Peon, `Arst` on the
    // Acolyte, `Aren` on the Wisp — drawn by pushAbilityButtons off its own row's art, hotkey,
    // slot (`Buttonpos=1,1`) and autocast toggle. All four stock workers carry one, so this
    // generic fallback could only ever fire for a worker that carries NONE, i.e. the Ghoul —
    // and the sim refuses that unit anyway (`repairRefusal`: "no repair row on the type").
    // It was a button whose only possible press was a refusal.
    //
    // What a worker gets instead is its GATHER button, and that arrives through the ability
    // path too now (isHarvestCode) — one row, `Buttonpos=3,1`, showing Return Goods while
    // there is a load to carry home.
    if (sel.isWorker && this.tech.builds(sel.typeId).length) {
      out.push(this.cmd({ id: "build", icon: btnIcon("BTNHumanBuild"), name: "Build Structure", hotkey: "B", desc: "Brings up the list of structures you may build.", col: 0, row: 2, active: active === "build" }));
    }
    this.pushAbilityButtons(sel, out); // learned spells + a hero's Learn Skill button
    return out;
  }

  /** Which ONE command button is currently lit with the green active border — the
   *  thing the selected unit is doing right now. WC3 highlights exactly one at a
   *  time, so this is a single id rather than a flag per button.
   *
   *  Read from the SIM, never from the armed-order cursor: a command lights up once
   *  it has been *given*, not while it is still being aimed. Pressing A and hunting
   *  for a target leaves the card dark until the click lands and the attack-move is
   *  actually under way.
   *
   *  A unit with no order of its own is holding still, which is the Stop command —
   *  so Stop is the resting state of the card, not a blank one. Abilities come back
   *  as `ability:<code>` whether or not the button is an autocast one; the caller
   *  matches on the code, not the button id. */
  private activeCommandId(): string | null {
    const su = this.rts?.selectedSimUnit();
    if (!su || su.owner !== this.localPlayer) return null;
    // A worker's build job outlives its order: it walks to the site under `move`
    // (carrying `buildPending`) and hammers under `idle` (carrying `constructing`).
    // So the job — not the order — is what keeps Build Structure lit from the moment
    // the site is placed until the structure is up. Repair likewise.
    if (su.buildPending || su.constructing) return "build";
    // A worker with its own repair ROW lights that button instead of the generic one — the
    // two never both exist on a card (see the worker branch of buildCommandCard).
    const own = su.abilities.find((a) => isRepairCode(a.code));
    const repairButton = own ? `ability:${own.code}` : "repair";
    if (su.repair) return repairButton;
    // …and a worker at work lights its OWN Gather row, whichever way round the button is
    // showing: gathering and carrying home are one button and one job (isHarvestCode).
    const gather = su.abilities.find((a) => isHarvestCode(a.code));
    switch (su.order) {
      case "move": return "move";
      // Attack-move and a forced attack share the Attack button, as in the game.
      case "attackmove":
      case "attack": return "attack";
      case "patrol": return "patrol";
      case "hold": return "hold";
      case "repair": return repairButton;
      case "harvest":
      case "return": return gather ? `ability:${gather.code}` : "stop";
      case "cast": return su.pendingCast ? `ability:${su.pendingCast.code}` : null;
      // Idle, and every order with no button behind it (follow, walking to an item),
      // rest on Stop.
      default: return "stop";
    }
  }

  /** Fixed command-card slots for a hero's abilities: basics fill columns 0–2 of
   *  the bottom row in learn-list order, the ultimate takes column 3. Non-heroes
  /** Tooltip body for a spell button: the per-rank Ubertip, with its `<code,Field>`
   *  placeholders resolved to the real values. The mana cost rides the tooltip's cost
   *  row (with the game's own ToolTipManaIcon) rather than being prepended here —
   *  and cooldown is deliberately absent, because classic WC3 never shows it in a
   *  tooltip (GlobalStrings.fdf has no cooldown label; the radial sweep is the tell). */
  private abilityDesc(def: AbilityDef, rank: number): string {
    const raw = def.uberTips[Math.min(rank, def.uberTips.length) - 1] || def.uberTips[0] || "";
    return this.tipText(raw, def, rank);
  }

  /** Tooltip title for a spell button: the game's own per-rank `Tip` string, which
   *  already gilds the hotkey letter and appends " - [Level N]". */
  private abilityTip(def: AbilityDef, rank: number): string {
    return def.tips[Math.min(rank, def.tips.length) - 1] || def.tips[0] || def.name;
  }

  /** Fill a tooltip's `<ID,Field>` value references (src/data/tipRefs.ts). EVERY tooltip the
   *  card shows carries them — an item's "by <AIlf,DataA1>", a summon's "<hwat,realHP> hit
   *  points", an upgrade's "<Rhan,base1>" — so every `desc` on this card goes through here.
   *  `self`/`rank` are the ability being described, when the tooltip belongs to one. */
  private tipText(text: string, self?: AbilityDef, rank = 1): string {
    return resolveTipRefs(text, { abilities: this.abilities, items: this.items, units: this.registry, upgrades: this.upgrades }, { self, level: rank });
  }

  /** Is this toggle ability currently ON — i.e. should its button wear the `un` face and
   *  offer to switch it off? Four shapes, and each answers with the state it actually keeps:
   *    • Root/Uproot (`Aroo`) — the Ancient is planted.
   *    • Immolation (`AEim`) — the Demon Hunter is alight (`[AEim]` Art=BTNImmolationOn,
   *      Unart=BTNImmolationOff; the two icons are the whole feedback that it is burning).
   *    • Mana Shield (`ANms`) — the shield is up (Art=BTNNeutralManaShield /
   *      Unart=…ShieldOff).
   *    • Every FORM toggle — Burrow, Ethereal/Corporeal Form, Call to Arms, Robo-Goblin —
   *      is on when the unit IS its ability's alternate form unit, which is the same pair of
   *      columns morphToggle reads. That is generic on purpose: it needs no list, and an
   *      autocast row whose `UnitID1` names a summon (Black Arrow's `ndr1`) can never match
   *      the caster's own type, so it stays untouched.
   *
   *  Autocast toggles are NOT here: their on/off is the green autocast border, not a
   *  different icon, and both directions of those rows carry the same `Art`. */
  private toggleIsOn(su: SimUnit, code: string, def: AbilityDef): boolean {
    // GATHER's second face is not a toggle, it is a STATE: `Unart=BTNReturnGoods` is what the
    // one harvest row shows while the worker has something to carry home, because that is the
    // job the same button does next. A Wisp and an Acolyte never carry anything (their gold
    // and lumber are credited where they stand — docs/night-elf.md, docs/undead.md), so their
    // button simply never turns over, which is what the original shows too.
    if (isHarvestCode(code)) return (su.worker?.carryGold ?? 0) > 0 || (su.worker?.carryLumber ?? 0) > 0;
    if (code === "Aroo") return !su.uprooted;
    if (code === "AEim") return !!su.immolation;
    if (code === "ANms") return su.buffs.some((b) => b.kind === "manaShield");
    if (def.autocast) return false;
    const lvl = def.levelData[0];
    const alt = lvl ? lvl.summon || lvl.dataStr[1] || "" : "";
    return !!alt && su.typeId === alt;
  }

  /** Append a movable unit's learned/innate abilities (and a hero's Learn Skill
   *  button) to its command card. Auras show as passive (disabled) indicators;
   *  autocast abilities (Heal/Slow) toggle; the rest arm a target or fire. */
  private pushAbilityButtons(sel: { id: number; isHero: boolean }, out: CommandButton[]): void {
    if (!this.rts) return;
    const su = this.rts.simView.units.get(sel.id);
    if (!su || su.owner !== this.localPlayer) return;
    // A Mirror Image illusion copies the hero's abilities onto its sheet but can't use any
    // of them, so it doesn't get the buttons at all — a card full of spells that silently
    // refuse would read as a bug. (issueCast refuses them regardless.)
    if (su.isIllusion) return;
    const active = this.activeCommandId();
    const rootable = su.abilities.some((a) => a.code === "Aroo" && a.level >= 1); // an Ancient
    for (const ab of su.abilities) {
      if (ab.level < 1) continue; // unlearned hero abilities don't show as buttons
      // An ability can be gated by an upgrade — `[Adef] Requires=Rhde` (Defend), `[Acmg]
      // Requires=Rhss` (Control Magic), `[Aweb] Requires=Ruwb` (Web). It sits on the unit from
      // birth and the RESEARCH is what unlocks it, which is the whole job of the six Human
      // upgrades that grant no stat at all. Abilities with no requirement (every hero spell)
      // are always met and this costs them nothing.
      //
      // UNAVAILABLE, NOT ABSENT (developer spec). A gated ability keeps its slot and goes
      // inert wearing the DIS* art, with the game's own red "Requires:" line under its
      // tooltip — the same three things a Guard Tower with no Lumber Mill already does on a
      // worker's build page, a Knight with no Keep on an Altar's card and a Potion of
      // Greater Healing with no tier-2 hall in a shop. So the player can see that Web exists,
      // that the Crypt Fiend is the unit that gets it, and what to research for it, instead of
      // having to know the tech tree by heart. (`disabled` is where the greying lives, and
      // `cmd()` derives the DIS* twin from the icon — see disabledArt.)
      const techMet = this.rts.simView.techMeets(su.owner, ab.id);
      // …and an Ancient's card depends on which way up it is: one short list of what only a
      // walker can reach (Eat Tree, Entangle Gold Mine). The rest of the split is structural —
      // the building card itself is withheld while it walks, see buildCommandCard. Asked only
      // of a unit that can actually root, so a creep that happens to carry one of those rows
      // is not quietly stripped of it.
      if (rootable && !su.uprooted && UPROOTED_ONLY.has(ab.code)) continue;
      const def = this.abilities.get(ab.id);
      if (!def) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      // A toggle shows the face of what it can do NEXT: one row, two directions
      // (`[Aroo]` Order=root Art=BTNRoot "Root" / Unorder=unroot Unart=BTNUproot "Uproot"),
      // so a PLANTED Ancient wears the `un` half because pulling itself up is the move
      // available to it. See AbilityDef.unIcon and toggleIsOn for the other three shapes.
      const reversed = !!def.unIcon && this.toggleIsOn(su, ab.code, def);
      // …and a planted Ancient with anything in its queue cannot pull itself up at all: WC3
      // greys Uproot out for as long as it is training or researching, because the work would
      // have nowhere to go. The sim refuses it too (SimWorld.rootRefusal) — this is the half
      // that SHOWS it, so the button reads as unpressable instead of silently doing nothing.
      const rootBlocked = ab.code === "Aroo" && this.rts.simView.rootRefusal(su) !== null;
      // …and a unit halfway through CHANGING SHAPE presses nothing at all, because it is
      // neither form yet (SimUnit.morphT — `[Abur] Dur1` = 1.45s of Crypt Fiend going into
      // the ground). The sim refuses every cast for the duration (castLocked); this is the
      // half that lets the card say so, which is what stops Unburrow reading as available
      // the instant Burrow was pressed.
      const morphing = su.morphT > 0;
      const col = reversed ? def.unButtonX : def.buttonX; // the ability's real WC3 card slot
      const row = reversed ? def.unButtonY : def.buttonY;
      const passive = def.target === "passive";
      // A passive with no `Art` at all gets NO button — the engine has nothing to draw and
      // the row means it. The clear case is Frost Attack: `[Afra]` (Nerubian Tower) carries
      // `PASBTNFrost.blp` at Buttonpos 0,2 and shows, while `[Afrb]` (Frost Wyrm, the Blue
      // Dragons) carries neither art nor position and does not. Without this the Frost Wyrm
      // grew a blank button in the top-left corner, on top of whatever was already there.
      if (passive && !def.icon) continue;
      const onCd = ab.cooldownLeft > 0;
      const noMana = su.mana < lvl.cost;
      // Silenced (Silence, Soul Burn) or stunned: the unit cannot cast at all. This is the
      // one refusal WC3 ships no [Errors] line for, and SimWorld.castRefusal says why —
      // the engine GREYS THE BUTTON, so the click never happens and nothing needs saying.
      // A passive is untouched: Silence stops spellcasting, not Critical Strike.
      const muted = !passive && (su.silenced || su.stunned);
      out.push(this.cmd({
        // An autocastable ability answers to BOTH mouse buttons, as in the game: left casts
        // it here and now (Heal that wounded Footman), right flips whether the unit casts it
        // by itself. It used to answer only the toggle, which left Heal, Slow, Abolish Magic
        // and every other one of them with no way to be aimed at all (issue #106).
        //
        // …unless the button is a STANCE rather than an autocast, in which case the toggle IS
        // the only meaning it has and both buttons flip it.
        //
        // The data draws that line itself, and drawing it any other way gets it wrong. An
        // autocast row carries the PAIR `Orderon`/`Orderoff` beside its plain `Order`
        // (`[Arai] Order=raisedead / Orderon=raisedeadon / Orderoff=raisedeadoff`); a stance
        // carries `Unorder` instead (`[Adef] Order=defend / Unorder=undefend`) and has no
        // autocast at all — it rides `def.autocast` here only because on/off is the same
        // SHAPE. Asking "is it no-target?" instead lumped the two together and cost Raise Dead
        // and the Avatar's Spirit of Vengeance their manual cast: left-clicking Raise Dead
        // flipped the autocast rather than raising anything, which is not what either button
        // does in the original. `Amel` (the Meat Wagon's Get Corpse) carries neither pair and
        // stays a toggle, as it is in the game.
        id: passive ? "noop" : def.autocast && !def.orderOn ? `autocast:${ab.code}` : `ability:${ab.code}`,
        altId: passive || !def.autocast ? undefined : `autocast:${ab.code}`,
        icon: this.blpIcon(reversed ? def.unIcon : def.icon),
        // The reverse direction has no `Unname` of its own — the row carries one Name — so
        // the title comes from `Untip`, which is where WC3 keeps it ("Up|cffffcc00r|root").
        name: reversed ? wc3ToPlain(def.unTip) || def.name : def.levels > 1 ? `${def.name} (Level ${ab.level})` : def.name,
        hotkey: reversed ? def.unHotkey || def.hotkey : def.hotkey,
        tip: reversed ? def.unTip || this.abilityTip(def, ab.level) : this.abilityTip(def, ab.level),
        // …and the red line that says what to research for it, when it is not yours yet. Empty
        // for everything already unlocked, which is almost every button on almost every card.
        desc: (reversed ? def.unUberTip || this.abilityDesc(def, ab.level) : this.abilityDesc(def, ab.level)) + this.requirementLine(ab.id),
        mana: lvl.cost,
        col, row,
        // Mana is the ONE price WC3 draws: short of it, the icon goes deep blue (see
        // `noMana` on CommandButton). The button stays live and the click is still how you
        // hear "Not enough mana." — it just can't arm a target any more (issue #110).
        // Cooldown says itself, with the radial overlay. A PASSIVE is not "unavailable"
        // either — Critical Strike is working right now, and WC3 draws it in full colour
        // off its own PASBTN art ([AOcr] Art=…\PassiveButtons\PASBTNCriticalStrike.blp);
        // it just isn't a button you press (see `passive` below).
        noMana,
        // Unavailable: the button goes inert and wears the DIS* art with no frame, so it reads
        // as unpressable at a glance. Four things say so — a silenced or stunned caster, a
        // planted Ancient with a queue that cannot pull itself up, a unit mid-morph, and an
        // ability whose research is not in.
        disabled: muted || rootBlocked || morphing || !techMet,
        passive,
        // The green border marks the spell the unit is casting (or has armed) right
        // now — it is NOT the autocast toggle, which is a persistent setting and
        // gets its own indicator, so the two can never both claim the border.
        active: active === `ability:${ab.code}`,
        // …and no autocast sparkle on a button that is not yours yet. The `auto` column arms
        // the toggle from birth (`[ucry] auto = Aweb`) while the upgrade is what unlocks the
        // row, so an un-researched Web read as "on" for an ability that could not fire. The
        // sim agrees from the other side — tickAutocast skips it (and issueCast refuses it).
        modal: def.autocast && ab.autocastOn && techMet,
        cooldownLeft: onCd ? ab.cooldownLeft : 0,
        cooldownFrac: onCd && lvl.cooldown > 0 ? Math.max(0, Math.min(1, ab.cooldownLeft / lvl.cooldown)) : 0,
      }));
    }
    if (su.isHero && su.skillPoints > 0) {
      // Hero Abilities (learn-skill): opens the skill list to spend unspent points.
      // WC3's canonical learn-abilities "Skillz" book art, default hotkey O, and a
      // corner badge showing the points available. Take the CommandButtons copy, not
      // the CommandButtonsDisabled one — the button is live (there are points to
      // spend), and DISBTN* is just the desaturated art the engine swaps in when a
      // button is unavailable.
      out.push(this.cmd({
        id: "learnpage",
        icon: this.blpIcon("ReplaceableTextures\\CommandButtons\\BTNSkillz.blp"),
        name: "Hero Abilities",
        hotkey: "O",
        desc: "Opens the abilities menu and allows you to assign unused points to the Heroes' abilities.",
        // No `modal` sparkle here, deliberately: the button already says there are points to
        // spend — it only exists while there are, and it wears the count. The hero's PORTRAIT
        // up in the corner is where the model goes, because that is the one that has to catch
        // your eye while you are looking somewhere else entirely.
        col: 3, row: 1, count: su.skillPoints,
      }));
    }
  }

  private runCommand(id: string): void {
    if (!this.rts) return;
    if (id === "noop") return;
    this.sounds?.playUi("InterfaceClick"); // WC3 command-card button click
    this.sounds?.unlock(); // keyboard hotkeys are a gesture too
    if (id === "move" || id === "attack" || id === "patrol" || id === "rally" || id === "repair") {
      this.rts.orderMode = id;
      this.hud?.setArmed(true);
      return;
    }
    // --- spells ---
    if (id.startsWith("ability:")) {
      const code = id.slice(8);
      // Renew is drawn as an ability (it is one — `Aren`, with its own art, hotkey, slot and
      // autocast toggle) but ORDERED as a repair: the job outlives any one cast. Same arming
      // the generic Repair button does, so a wisp's click resolves through repairAt.
      if (isRepairCode(code)) {
        this.rts.orderMode = "repair";
        this.hud?.setArmed(true);
        return;
      }
      // GATHER is drawn as an ability (it is one — `Ahar`/`Ahrl`/`Aaha`/`Awha`, each with its
      // own art, hotkey and `Buttonpos=3,1`) but ORDERED against a RESOURCE NODE, which is not
      // a unit and so cannot go through the cast path at all. Same shape as repair above.
      //
      // Which of the row's two faces was pressed is read from the worker, not from the click:
      // carrying a load, the button is Return Goods and there is nothing to aim — the depot is
      // chosen when the order runs. Empty-handed it arms the cursor for a tree or a mine.
      if (isHarvestCode(code)) {
        if (this.rts.returnResourcesSelected()) return;
        this.rts.orderMode = "harvest";
        this.hud?.setArmed(true);
        return;
      }
      // Root / Unroot is one row and two very different gestures. UPROOT is instant: the
      // Ancient hauls itself up where it stands. ROOT is a PLACEMENT — WC3 hands you the
      // building's own silhouette over a green/red footprint grid and the click chooses the
      // site, exactly as a worker's Build button does — so the button arms the cursor here
      // and `placeBuilding` turns the click into a `rootat` order. Nothing is paid for; the
      // Ancient is the building.
      if (code === "Aroo") {
        const su = this.rts.selectedSimUnit();
        if (su?.uprooted) {
          const def = this.registry.get(su.typeId);
          if (!def) return;
          this.buildGhost?.hide(); // whatever was on the cursor before
          this.buildGhost = null;
          // The stamp it LIFTED when it uprooted is the one it will lay back down, so the
          // grid the player aims with is that one rather than a fresh read of the pathing
          // texture (they agree, and this cannot drift).
          const fp = su.rootedStamp ?? (def.pathTex ? this.footprintFor(def.pathTex) : null);
          this.placement = { def, fp, workerId: 0, rootUnitId: su.id };
          void this.showBuildGhost(def);
          return;
        }
        this.rts.castNoTarget(code); // planted → pull up, here and now
        return;
      }
      const target = KNOWN_ABILITIES[code]?.target;
      if (target === "none") {
        this.rts.castNoTarget(code); // Thunder Clap / Divine Shield / Avatar — fire now
      } else if (target === "unit" || target === "point") {
        // armCast can REFUSE the press — a spell with no mana behind it answers "Not enough
        // mana." here rather than arming a reticle for a cast that can't happen (issue #110).
        if (this.rts.armCast(code, target, target === "point" ? this.armedAbilityArea(code) : 0)) this.hud?.setArmed(true);
      }
      return;
    }
    if (id.startsWith("autocast:")) {
      const code = id.slice(9);
      this.rts.toggleAutocast(code); // toggle Heal/Slow autocast on the selection
      // Switching one ON has a second sound over the click every button makes: UISounds.slk
      // `AutoCastButtonClick` = Sound\Interface\AutoCastButtonClick1.wav. Read back off the
      // unit rather than predicted, because a multi-unit selection toggles each one to its
      // own new state and it is the primary's that the card is showing.
      const su = this.rts.selectedSimUnit();
      if (su?.abilities.some((a) => a.code === code && a.autocastOn)) this.sounds?.playUi("AutoCastButtonClick");
      return;
    }
    if (id === "learnpage") {
      this.cardPage = "learn";
      return;
    }
    if (id.startsWith("learn:")) {
      this.rts.learnSkill(id.slice(6));
      const su = this.rts.selectedSimUnit();
      if (!su || su.skillPoints <= 0) this.cardPage = "root"; // out of points → back to orders
      return;
    }
    if (id === "stop" || id === "hold") {
      if (id === "hold") this.rts.holdSelected();
      else this.rts.stopSelected();
      this.rts.orderMode = null;
      this.hud?.clearOrderMode();
      return;
    }
    if (id === "build") {
      this.cardPage = "build";
      return;
    }
    if (id === "cancel") {
      // In "target mode" (an armed order awaiting a click — e.g. Set Rally Point,
      // Attack, Repair), Escape cancels that order FIRST, before it would cancel a
      // building's training queue.
      if (this.rts.orderMode) {
        this.rts.orderMode = null;
        this.rts.armedCast = null; // disarm a pending spell target
        this.rts.armedLoad = null; // …and a pending Load pick
        this.hud?.clearOrderMode();
        return;
      }
      if (this.placement) {
        this.cancelPlacement();
      } else if (this.cardPage === "build" || this.cardPage === "learn") {
        this.cardPage = "root";
      } else {
        const sel = this.rts.selectedInfo();
        if (sel?.underConstruction) this.cancelConstruction(sel.id);
        else if (sel?.isBuilding) this.cancelTrainAt(sel.id, -1); // -1 = the last queued job
      }
      return;
    }
    if (id.startsWith("build:")) {
      const def = this.registry.get(id.slice(6));
      const workerId = this.rts.selectedId;
      if (def && workerId !== null) {
        // The price is answered HERE, at the button, not when the ghost is put down: WC3
        // never hands you a structure you can't pay for, so a greyed Town Hall says "Not
        // enough gold." and the build page stays where it is rather than arming an order
        // that is going to be refused anyway. placeBuilding checks again — the stash can
        // drain into a Peasant while the ghost is riding the cursor.
        if (!this.canAfford(def.goldCost, def.lumberCost)) return;
        this.buildGhost?.hide(); // switching buildings: drop the previously-armed ghost
        this.buildGhost = null;
        this.placement = { def, fp: def.pathTex ? this.footprintFor(def.pathTex) : null, workerId };
        void this.showBuildGhost(def);
      }
      return;
    }
    if (id === "battlestations") {
      const sel = this.rts.selectedInfo();
      if (sel) this.rts.execute(this.localPlayer, { c: "battlestations", buildingId: sel.id });
      return;
    }
    if (id === "standdown") {
      const sel = this.rts.selectedInfo();
      if (sel) this.rts.execute(this.localPlayer, { c: "standdown", buildingId: sel.id });
      return;
    }
    if (id === "load") {
      // The selection is the HOLD and the click picks its passenger — the same shape as the
      // shop's "Select a unit to purchase" pick, and the opposite way round from every other
      // order on the card. See RtsController.orderClickAt.
      const sel = this.rts.selectedInfo();
      if (sel && this.rts.armLoad(sel.id)) this.hud?.setArmed(true);
      return;
    }
    if (id.startsWith("train:")) {
      const sel = this.rts.selectedInfo();
      if (sel) this.trainUnit(sel.id, id.slice(6));
      return;
    }
    if (id.startsWith("research:")) {
      const sel = this.rts.selectedInfo();
      if (sel) this.startResearch(sel.id, id.slice(9));
      return;
    }
    if (id.startsWith("upgrade:")) {
      const sel = this.rts.selectedInfo();
      if (sel) this.startBuildingUpgrade(sel.id, id.slice(8));
      return;
    }
    if (id.startsWith("buy:")) {
      const sel = this.rts.selectedInfo();
      if (sel) this.buyItem(sel.id, id.slice(4));
      return;
    }
    if (id.startsWith("selectuser:")) {
      // Arm the pick. Clicking it again disarms, the way every other armed order toggles.
      const shopId = Number(id.slice(11));
      if (!Number.isInteger(shopId)) return;
      if (this.rts.orderMode === "selectuser" && this.rts.armedShopUser?.shopId === shopId) {
        this.rts.orderMode = null;
        this.rts.armedShopUser = null;
        return;
      }
      this.rts.orderMode = "selectuser";
      this.rts.armedShopUser = { shopId };
      return;
    }
    if (id.startsWith("cancelqueue:")) {
      // Clicking any icon in the production queue (including the one currently
      // training, index 0) cancels that item and refunds it in full.
      const idx = Number(id.slice(12));
      const sel = this.rts.selectedInfo();
      if (sel?.isBuilding && Number.isInteger(idx)) this.cancelTrainAt(sel.id, idx);
    }
  }

  /** Refuse a command the way the game does: the gold line above the console plus a sound,
   *  both named by a single commandstrings.txt [Errors] key. A handful of refusals have a
   *  race-specific line the worker SPEAKS (Nogold + Orc → NoGoldOrc →
   *  Sound\Interface\Warning\Orc\GruntNoGold1.wav, per UISounds.slk); everything else gets
   *  the generic interface error beep. An unknown/blank key still beeps — the sound is the
   *  feedback that the click was seen and rejected, and it must not depend on there being
   *  a sentence to go with it. */
  private refuse(errorKey: string): void {
    const voice = ERROR_VOICE[errorKey];
    this.hud?.showError(this.strings.forRace(errorKey, this.localRace));
    this.sounds?.playUi(voice ? `${voice}${UI_SOUND_RACE[this.localRace]}` : "InterfaceError");
  }

  /**
   * Say the game's own news out loud: the [Errors] rows nobody asked for (see SimWorld.Alert).
   *
   * Same gold line as a refusal, deliberately — these live in the same 216-row block as
   * "Not enough gold." and the engine hands them to the same one-line, replace-never-stack
   * display, so "Our town is under siege!" arrives exactly where "Spell is not ready yet."
   * does. Each is paired with its war3skins.txt sound, all of which are the local player's
   * own race speaking (`UnderAttackOrc` → Sound\Interface\Warning\Orc\GruntUnitAttack1.wav).
   *
   * The ALLY variants are why the sim doesn't do this itself: one blow, two audiences, and
   * a different row and a different WAV for each. An ally's gold mine is the exception with
   * no second row at all — the data offers nothing to say about it, so nothing is said.
   */
  private showAlert(a: Alert): void {
    const own = a.player === this.localPlayer;
    const ally = !own && (this.rts?.playersAreCoAllied(a.player, this.localPlayer) ?? false);
    if (!own && !ally) return; // an enemy's troubles are their own
    const name = (typeId: string | undefined, proper: string | undefined): string =>
      proper || this.registry.get(typeId ?? "")?.name || "";
    let key = "";
    let sound = "";
    const args: Array<string | number> = [];
    switch (a.kind) {
      case "attack":
      case "townattack": {
        const town = a.kind === "townattack";
        key = own ? (town ? "Townattack" : "Unitattack") : (town ? "Allytownattack" : "Allyunderattack");
        sound = own ? (town ? "TownAttack" : "UnderAttack") : (town ? "AllyTownUnderAttack" : "AllyUnderAttack");
        if (!own) args.push(this.playerLabel(a.player)); // "%s's city is under siege!" — the possessive names a PLAYER
        // …and the minimap flashes where the blow landed, which is how you find a raid you
        // cannot see. Observed behaviour rather than a data field: no table carries a colour
        // for it, so it takes the ping's own WC3 default duration and alarm red.
        this.hud?.ping({ x: a.x, y: a.y, duration: 0, r: 255, g: 0, b: 0, extraEffects: false });
        break;
      }
      case "herodeath":
        sound = own ? "HeroDies" : "AllyHeroDies";
        if (!own) {
          key = "Herodies"; // "%s has fallen in battle." — one slot, so it is the hero, not the class
          args.push(name(a.hero?.typeId, a.hero?.properName));
        } else if (a.killer) {
          key = "Herokilledhero"; // "%s was defeated by %s." — a hero taken by another hero is a duel
          args.push(name(a.hero?.typeId, a.hero?.properName), name(a.killer.typeId, a.killer.properName));
        } else {
          key = "Herodeath"; // "%s the %s (level %d) has fallen." — proper name, then TYPE name
          args.push(name(a.hero?.typeId, a.hero?.properName), this.registry.get(a.hero?.typeId ?? "")?.name ?? "", a.hero?.level ?? 0);
        }
        break;
      case "minelow":
      case "minedestroyed":
        if (!own) return; // no Ally* row exists for a mine — the data has nothing to say here
        key = a.kind === "minelow" ? "Goldminelow" : "Goldminedestroyed";
        sound = a.kind === "minelow" ? "GoldMineLow" : "GoldMineCollapse";
        break;
    }
    // forRace on every key: the four-way rows (Goldminelow, Goldminedestroyed, Herodeath)
    // are indexed by it and the rest come back whole, exactly as `refuse` relies on.
    this.hud?.showError(fillSlots(this.strings.forRace(key, this.localRace), args));
    this.sounds?.playUi(`${sound}${UI_SOUND_RACE[this.localRace]}`);
  }

  /** Can the local player afford this? Refuses (naming the resource they're short of)
   *  when not. WC3 reports gold first, so a player short of both hears "Not enough gold."
   *  Callers still do the deduction themselves — it happens later, once the order's own
   *  gates (tech, stock, queue) have passed. */
  private canAfford(gold: number, lumber: number): boolean {
    const stash = this.rts!.stashFor(this.localPlayer);
    if (stash.gold < gold) return this.refuse(ERR_NOGOLD), false;
    if (stash.lumber < lumber) return this.refuse(ERR_NOLUMBER), false;
    return true;
  }

  /** Ask to train (or hire) a unit. Every gate that decides whether this HAPPENS now lives in
   *  `execute` — cost, food, tech, hero cap, queue depth, shop stock. What stays here is the
   *  part `execute` cannot do: telling the player WHY it was refused, in the game's own voice.
   *  These are feedback pre-checks, deliberately duplicated, and nothing depends on them. */
  private trainUnit(buildingId: number, unitId: string): void {
    if (!this.rts) return;
    const d = this.registry.get(unitId);
    if (d) {
      const freeHero = d.isHero && this.rts.hasFreeHero(this.localPlayer);
      if (!this.canAfford(freeHero ? 0 : d.goldCost, freeHero ? 0 : d.lumberCost)) return;
      const food = this.rts.foodFor(this.localPlayer);
      if (food.used + d.foodUsed > food.made) {
        this.refuse(ERR_NOFOOD);
        return;
      }
      // A sold-out shelf has its own line ("That unit is not available") — worth keeping,
      // since a Tavern with no stock looks identical to one that just refused silently.
      if (this.rts.simView.shopStock(buildingId, unitId) === 0) {
        this.refuse(SHOP_ERROR.nostock);
        return;
      }
    }
    this.rts.execute(this.localPlayer, { c: "train", buildingId, unitId });
  }

  /** Start researching an upgrade at a building. Charges the level's own cost (Steel Forged
   *  Swords is dearer than Iron) and shares the building's ONE production queue with training,
   *  exactly as WC3 does. */
  private startResearch(buildingId: number, upgradeId: string): void {
    if (!this.rts) return;
    // Feedback only: work out the level the authority will pick so the refusal can name the
    // resource the player is short of. `execute` derives the level and the price again, and
    // its answer is the one that counts.
    const world = this.rts.simWorld;
    const state = world.tech;
    const d = this.upgrades.get(upgradeId);
    if (d && state) {
      const have = state.researchLevel(this.localPlayer, upgradeId);
      const next = Math.max(have, world.researchingLevel(buildingId, upgradeId)) + 1;
      if (next <= d.maxLevel) {
        const cost = this.upgrades.cost(upgradeId, next);
        if (!this.canAfford(cost.gold, cost.lumber)) return;
      }
    }
    this.rts.execute(this.localPlayer, { c: "research", buildingId, upgradeId });
  }

  /** Start a building's transformation (Town Hall → Keep, Scout Tower → Guard Tower). The
   *  cost and time are the TARGET's own; the structure keeps working while it upgrades. */
  private startBuildingUpgrade(buildingId: number, toTypeId: string): void {
    if (!this.rts) return;
    const d = this.registry.get(toTypeId);
    if (d) {
      // Feedback only — the same difference `execute` will compute, purely so a refusal can
      // say "Not enough gold" rather than nothing at all.
      const [gold, lumber] = this.upgradeCost(this.rts.simView.units.get(buildingId)?.typeId, d);
      if (!this.canAfford(gold, lumber)) return;
    }
    this.rts.execute(this.localPlayer, { c: "upgradebuilding", buildingId, toTypeId });
  }

  /** Buy an item from a shop. WC3 hands it to a "valid patron" — a nearby unit with an
   *  inventory — so pick the player's SELECTED hero when it happens to be in range (that's
   *  the one they mean), else the closest patron the shop can reach.
   *
   *  Everything that decides whether this HAPPENS lives in `execute` (the last purchase to
   *  join the funnel — called straight into the sim, a frozen client's shopping never
   *  reached the host). What stays here is feedback: the same pre-checks `purchaseItem`
   *  makes, re-asked of local state purely so a refusal speaks in the game's own voice. */
  private buyItem(shopId: number, itemId: string): void {
    if (!this.rts) return;
    const world = this.rts.simWorld;
    // The shop's nominated purchaser (Select User), falling back to the nearest patron —
    // one rule, in the sim, so the arrow overhead always points at whoever will actually
    // receive the item. This used to prefer the currently SELECTED unit, which meant the
    // arrow and the delivery could disagree the moment you clicked the shop itself.
    const buyer = world.shopBuyer(shopId, this.localPlayer);
    if (!buyer) {
      this.refuse(SHOP_ERROR.nopatron);
      return;
    }
    if (world.shopStock(shopId, itemId) === 0) {
      this.refuse(SHOP_ERROR.nostock);
      return;
    }
    if (buyer.inventory.indexOf(null) < 0) {
      this.refuse(SHOP_ERROR.full);
      return;
    }
    const def = this.items.get(itemId);
    if (def && !this.canAfford(def.gold, def.lumber)) return; // refuses with the resource's own line
    this.rts.execute(this.localPlayer, { c: "buyitem", shopId, itemId });
  }

  /** Cancel an under-construction building: refund **75%** of its cost (WC3
   *  cancelled-construction rate), free its pathing footprint, remove it, and
   *  play the race's dedicated **cancel explosion** (`<Race>CancelDeath.mdx` —
   *  distinct from the building's own Death collapse used for combat). */
  private cancelConstruction(buildingId: number): void {
    if (!this.rts) return;
    // Grab the building's position BEFORE the authority removes it, for the explosion. This
    // is a read; the refund and the removal both belong to `execute`.
    const b = this.rts.simView.units.get(buildingId);
    const fx = b ? { x: b.x, y: b.y, z: this.rts.groundHeightAt(b.x, b.y) } : null;
    if (!this.rts.execute(this.localPlayer, { c: "cancelbuild", buildingId })) return;
    if (fx) void this.spawnEffect(CANCEL_FX[this.localRace], fx.x, fx.y, fx.z);
  }

  /** Cancel a queue slot (0 = the job in progress, -1 = the last one queued) and refund it.
   *  Which slot is the only thing asked for; the rate and the payout are the authority's. */
  private cancelTrainAt(buildingId: number, index: number): void {
    this.rts?.execute(this.localPlayer, { c: "canceltrain", buildingId, index });
  }

  private cancelPlacement(): void {
    this.placement = null;
    if (this.ghost) this.ghost.hidden = true;
    this.buildGhost?.hide();
    this.buildGhost = null;
    this.placeCellVerts = 0; // stop drawing the footprint grid
  }

  /** Load (once per building type) and show the finished-building silhouette. */
  private async showBuildGhost(def: UnitDef): Promise<void> {
    const map = this.viewer.map;
    if (!map) return;
    let inst = this.buildGhosts.get(def.id);
    if (!inst) {
      const model = (await this.viewer.load(def.model, this.solver)) as SpawnModel | undefined;
      if (!model) return;
      inst = model.addInstance();
      inst.setScene(map.worldScene);
      inst.setUniformScale(def.modelScale || 1);
      inst.setTeamColor(this.rts?.playerColor(this.localPlayer) ?? this.localPlayer); // the team-coloured parts, in YOUR colour
      this.buildGhosts.set(def.id, inst);
    }
    // (Re)apply the finished-building pose every time it's shown.
    this.ghostBirthFrame = this.applyGhostPose(inst);
    if (this.placement?.def.id === def.id) {
      this.buildGhost = inst;
      inst.show();
    } else {
      inst.hide();
    }
  }

  /** Pose the ghost as a FULLY-BUILT building — face south and play "Stand",
   *  exactly like a completed structure renders (which looks correct). Pinning
   *  the end of the "Birth" clip instead left most models partly assembled:
   *  their final geometry only appears in "Stand", so scrubbing Birth showed
   *  just the construction geosets (only models whose Birth-end already matches
   *  Stand — e.g. the Altar — looked whole). Stand loops harmlessly. */
  private applyGhostPose(inst: SpawnInstance): number {
    zQuat(this.mq, (3 * Math.PI) / 2); // face south, like a placed building
    inst.setRotation(this.mq);
    const seqs = inst.model.sequences as Array<{ name: string; interval?: ArrayLike<number> }>;
    // Pose the ghost at the finished-building "Stand" clip, pinned to a fixed frame
    // (forcing the frame each render is what actually makes the model render its
    // built geometry — a cold setSequence sometimes showed the bind/scaffold pose).
    // Returns the frame to re-pin each render (-1 if the model has no pinnable Stand).
    const stand = standSequence(seqs);
    if (stand >= 0 && seqs[stand].interval) {
      inst.setSequence(stand);
      inst.setSequenceLoopMode(0);
      inst.frame = seqs[stand].interval![0];
      return seqs[stand].interval![0];
    } else if (stand >= 0) {
      inst.setSequence(stand);
      inst.setSequenceLoopMode(2);
    }
    return -1;
  }

  /** Show a dark-blue ghost of every building the owning player has queued but not yet
   *  begun: each worker's active `buildPending` site AND its shift-queued `buildnew`
   *  orders (issue #18). Rebuilt each frame from the live sim so a ghost appears the
   *  moment the order is given and vanishes the instant it clears (build starts, is
   *  canceled, or the worker is re-tasked). Only the owning player's sites are drawn.
   *
   *  A site that CANNOT be built is drawn dark RED instead, for either of the two reasons a
   *  queued building never rises:
   *
   *  • **Its ground has gone** — something went up on it, or an earlier ghost already holds it.
   *    A silhouette standing inside another silhouette is a building that is never going to
   *    rise, and saying so where the player is looking beats a refusal a minute later. First
   *    claim wins, so the ghost that turns red is the second one placed. (Placing one there is
   *    refused up front — see `placementValid` — so this is for the ones no click could catch:
   *    an order from another of your workers landing in the same tick, or ground taken by an
   *    ally after you queued.)
   *  • **It isn't paid for** — a shift-queued build is charged when the worker reaches it, not
   *    when it was queued, so the queue can hold more building than the player has gold for.
   *    The unpaid sites are priced IN ORDER against the live stash, each one spending what the
   *    ones ahead of it left, so a queue of five towers on three towers' gold reddens exactly
   *    the last two. This one is not a verdict, unlike the ground: it is re-asked every frame,
   *    so a red site goes back to dark blue the moment the mining catches up, and a blue one
   *    reddens the moment the gold behind it is spent on something else. It only becomes a
   *    verdict where it matters — a site still red when the worker STANDS on it is refused
   *    out loud and dropped (`tickPendingBuild` → `SimWorld.dropUnpaidBuilds`).
   */
  private updatePendingBuildGhosts(): void {
    if (!this.rts || !this.viewer.map) {
      this.clearPendingGhosts();
      return;
    }
    // Collect every desired build site (keyed by defId + snapped position, unique per
    // footprint) from the local player's workers, in order, each judged against the ground
    // and against the sites already claimed ahead of it.
    const desired = new Map<string, { defId: string; x: number; y: number; blocked: boolean }>();
    const claimed = new Set<number>();
    // What the still-unpaid sites have to come out of, drawn down as they are walked in order.
    const stash = this.rts.stashFor(this.localPlayer);
    let gold = stash.gold;
    let lumber = stash.lumber;
    const note = (defId: string, x: number, y: number, paid: boolean): void => {
      const key = this.pendingKey(defId, x, y);
      if (desired.has(key)) return; // one ghost per footprint, however many workers want it
      const def = this.registry.get(defId);
      const fp = def?.pathTex ? this.footprintFor(def.pathTex) : null;
      let blocked = this.siteBlocked(defId, x, y); // something has since gone up on it
      if (fp && this.grid) {
        const cells = new Set<number>();
        footprintCellsAt(this.grid, fp, x, y, cells);
        for (const c of cells) if (claimed.has(c)) { blocked = true; break; }
        // A site that isn't going to be built claims nothing — it must not redden a third.
        if (!blocked) for (const c of cells) claimed.add(c);
      }
      // A build already charged for owes the stash nothing and can never be the short one.
      if (!blocked && !paid && def) {
        if (gold < def.goldCost || lumber < def.lumberCost) blocked = true;
        else { gold -= def.goldCost; lumber -= def.lumberCost; }
      }
      desired.set(key, { defId, x, y, blocked });
    };
    for (const u of this.rts.simView.units.values()) {
      if (u.owner !== this.localPlayer) continue;
      if (u.buildPending) note(u.buildPending.defId, u.buildPending.x, u.buildPending.y, u.buildPending.paid);
      for (const o of u.orderQueue) if (o.kind === "buildnew") note(o.defId, o.x, o.y, o.paid);
    }
    // Drop ghosts whose site is no longer pending (order started/canceled/re-tasked).
    for (const [key, g] of this.pendingGhosts) {
      if (!desired.has(key)) {
        g.inst.detach();
        this.pendingGhosts.delete(key);
      }
    }
    // Add/position the ghosts for the sites that are still pending.
    for (const [key, site] of desired) {
      const g = this.pendingGhosts.get(key);
      if (g) {
        this.placePendingGhost(g, site.x, site.y, site.blocked);
        continue;
      }
      if (this.pendingGhostLoading.has(key)) continue; // model still loading
      const def = this.registry.get(site.defId);
      if (!def) continue;
      this.pendingGhostLoading.add(key);
      void this.spawnPendingGhost(key, def, site.x, site.y, site.blocked);
    }
  }

  /** Site key for a pending build: defId + snapped position (one ghost per footprint). */
  private pendingKey(defId: string, x: number, y: number): string {
    return `${defId}@${Math.round(x)},${Math.round(y)}`;
  }

  /** Load (async) and register a ghost for a pending build site, unless the order was
   *  canceled while the model streamed in. */
  private async spawnPendingGhost(key: string, def: UnitDef, x: number, y: number, blocked: boolean): Promise<void> {
    const map = this.viewer.map;
    const model = map ? ((await this.viewer.load(def.model, this.solver)) as SpawnModel | undefined) : undefined;
    this.pendingGhostLoading.delete(key);
    // Bail if the site was canceled (or the scene torn down) during the load.
    if (!model || !this.viewer.map || this.pendingGhosts.has(key)) return;
    const inst = model.addInstance();
    inst.setScene(this.viewer.map.worldScene);
    inst.setUniformScale(def.modelScale || 1);
    inst.setTeamColor(this.rts?.playerColor(this.localPlayer) ?? this.localPlayer);
    const g = { inst, defId: def.id, frame: this.applyGhostPose(inst) };
    this.pendingGhosts.set(key, g);
    this.placePendingGhost(g, x, y, blocked);
  }

  /** Position a pending-build ghost on its site — seated on the tallest terrain its
   *  footprint spans (like the real building, issue #15), pinned to the built pose, and
   *  tinted a hard dark blue so it reads clearly as "about to be built" — or dark RED when
   *  the site is no longer one, which is a silhouette announcing that it will never rise. */
  private placePendingGhost(g: { inst: SpawnInstance; defId: string; frame: number }, x: number, y: number, blocked = false): void {
    const def = this.registry.get(g.defId);
    const fp = def?.pathTex ? this.footprintFor(def.pathTex) : null;
    this.loc3[0] = x;
    this.loc3[1] = y;
    this.loc3[2] =
      fp && def && this.footMaxHeight ? this.footMaxHeight(x, y, ...seatHalfExtents(def, fp)) : (this.rts?.groundHeightAt(x, y) ?? 0);
    g.inst.setLocation(this.loc3);
    if (g.frame >= 0) g.inst.frame = g.frame; // keep it fully built, not mid-animation
    g.inst.setVertexColor(blocked ? PENDING_GHOST_BLOCKED_TINT : PENDING_GHOST_TINT);
    g.inst.show();
  }

  private clearPendingGhosts(): void {
    for (const g of this.pendingGhosts.values()) g.inst.detach();
    this.pendingGhosts.clear();
    this.pendingGhostLoading.clear();
  }

  private resourceIcon(kind: "gold" | "lumber" | "supply"): string | null {
    const paths = {
      gold: "UI\\Widgets\\ToolTips\\Human\\ToolTipGoldIcon.blp",
      lumber: "UI\\Widgets\\ToolTips\\Human\\ToolTipLumberIcon.blp",
      supply: "UI\\Widgets\\ToolTips\\Human\\ToolTipSupplyIcon.blp",
    };
    return this.blpIcon(paths[kind]);
  }

  /** Set the client's race cursor (the top-left pointer frame of the race
   *  cursor sprite sheet) as the in-game mouse cursor. */
  private applyRaceCursor(): void {
    const dirs: Record<PlayableRace, string> = { human: "Human", orc: "Orc", undead: "Undead", nightelf: "NightElf" };
    const bytes = this.vfs.rawBytes(`UI\\Cursor\\${dirs[this.localRace]}Cursor.blp`);
    const sheet = bytes ? blpToCanvas(bytes) : null;
    if (!sheet) return;
    this.cursorSheet = sheet; // reused to build the target reticle (row 2) + tinted hand
    this.reticleUrls.clear();
    this.handUrls.clear();
    // The sheet is a grid of animation frames; the top-left cell is the idle
    // pointer. Cells are one-eighth of the sheet width.
    const cell = Math.round(sheet.width / 8);
    const frame = document.createElement("canvas");
    frame.width = cell;
    frame.height = cell;
    frame.getContext("2d")!.drawImage(sheet, 0, 0);
    const url = frame.toDataURL();
    // Hotspot near the gauntlet's fingertip (top-left).
    const rule = `url(${url}) 3 3, auto`;
    document.body.style.cursor = rule;
    // Force the WC3 cursor over the ENTIRE in-game UI — buttons, the map, the
    // minimap, everything — overriding the default pointer/crosshair cursors so
    // only the original WC3 cursor is ever shown (per feedback).
    if (!this.cursorStyleEl) {
      this.cursorStyleEl = document.createElement("style");
      document.head.appendChild(this.cursorStyleEl);
    }
    // Normal = the WC3 arrow everywhere; whenever the DOM cursor overlay is shown,
    // hide the OS cursor underneath it so only ONE cursor is ever visible.
    //  - `reticle-on` (the recoloured hover HAND) only ever happens over the map, so
    //    it's scoped to the canvas and HUD buttons keep the plain arrow.
    //  - `armed-on` (an armed order's target reticle) is body-wide: in WC3 the reticle
    //    IS the cursor while an order is armed, over the console too. Scoping this one
    //    to #map was the bug — hovering the HUD showed the reticle AND the hand.
    //  - `cine-on` is the letterbox: WC3 draws no cursor at all while a cinematic is running,
    //    and it is the whole screen's rule — the console is gone, and the mouse with it.
    //    …UNLESS a dialog is up (`dialog-on`, issue #104). A dialog is buttons, and a
    //    cinematic that raises one has just asked the player to click something — so the
    //    cursor comes back for as long as it is on screen, and goes again with it.
    this.cursorStyleEl.textContent =
      `body.in-game, body.in-game * { cursor: ${rule} !important; }\n` +
      `body.in-game.reticle-on #map { cursor: none !important; }\n` +
      `body.in-game.armed-on, body.in-game.armed-on * { cursor: none !important; }\n` +
      `body.in-game.cine-on:not(.dialog-on), body.in-game.cine-on:not(.dialog-on) * { cursor: none !important; }`;
  }

  /** The real WC3 target reticle (row 2 of the race cursor sheet: a circle with
   *  four brackets + centre pip), recoloured to `colorKey` and cached. Replaces
   *  the old canvas-drawn brackets. Returns "" until the cursor sheet loads. */
  private reticleUrl(colorKey: "green" | "yellow" | "red"): string {
    const cached = this.reticleUrls.get(colorKey);
    if (cached !== undefined) return cached;
    const sheet = this.cursorSheet;
    if (!sheet) return "";
    const color = { green: [72, 255, 72], yellow: [255, 226, 58], red: [255, 26, 20] }[colorKey]; // harsher, purer red
    const cell = Math.round(sheet.width / 8);
    const c = document.createElement("canvas");
    c.width = cell;
    c.height = cell;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(sheet, 0, cell * 2, cell, cell, 0, 0, cell, cell); // reticle = row 2, col 0
    const img = ctx.getImageData(0, 0, cell, cell);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // Grayscale art → tint by intensity (with a floor so outlines keep colour).
      const inten = Math.max(d[i], d[i + 1], d[i + 2]) / 255;
      const f = Math.min(1, 0.45 + 0.75 * inten);
      d[i] = color[0] * f;
      d[i + 1] = color[1] * f;
      d[i + 2] = color[2] * f;
      // alpha (d[i+3]) preserved — defines the reticle shape
    }
    ctx.putImageData(img, 0, 0);
    const url = c.toDataURL();
    this.reticleUrls.set(colorKey, url);
    return url;
  }

  /** The race hand cursor (row 0, col 0 of the sheet) multiply-tinted to
   *  `colorKey` and cached — shown (pulsing) while hovering a unit so the cursor
   *  "stays the same but pulsates green/yellow/red". Returns "" until it loads. */
  private handCursorUrl(colorKey: "green" | "yellow" | "red"): string {
    const cached = this.handUrls.get(colorKey);
    if (cached !== undefined) return cached;
    const sheet = this.cursorSheet;
    if (!sheet) return "";
    const color = { green: [130, 255, 130], yellow: [255, 235, 110], red: [255, 48, 40] }[colorKey]; // harsh red, not pink
    const cell = Math.round(sheet.width / 8);
    const c = document.createElement("canvas");
    c.width = cell;
    c.height = cell;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(sheet, 0, 0, cell, cell, 0, 0, cell, cell); // hand pointer = row 0, col 0
    const img = ctx.getImageData(0, 0, cell, cell);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // Multiply-tint keeps the gauntlet's shape/shading, just recoloured.
      d[i] = (d[i] * color[0]) / 255;
      d[i + 1] = (d[i + 1] * color[1]) / 255;
      d[i + 2] = (d[i + 2] * color[2]) / 255;
    }
    ctx.putImageData(img, 0, 0);
    const url = c.toDataURL();
    this.handUrls.set(colorKey, url);
    return url;
  }

  /** Decode a BLP to a cached data URL for DOM use (icons). */
  private blpIcon(path: string): string | null {
    let url = this.iconCache.get(path);
    if (url === undefined) {
      const bytes = this.vfs.rawBytes(path);
      url = bytes ? blpToDataUrl(bytes) : null;
      this.iconCache.set(path, url);
      if (url) this.iconSource.set(url, path);
    }
    return url;
  }

  /** Where the greyed twin of an icon lives. Both button folders answer to the same rule:
   *  `CommandButtons\BTNFoo.blp` → `CommandButtonsDisabled\DISBTNFoo.blp`, and a passive's
   *  `PassiveButtons\PASBTNFoo.blp` → `CommandButtonsDisabled\DISPASBTNFoo.blp` (verified
   *  against the 1.30.4 store: 1,086 DISBTN + 59 DISPASBTN cover all but six icons). */
  private static disabledIconPath(path: string): string | null {
    const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    if (cut < 0) return null;
    return `ReplaceableTextures\\CommandButtonsDisabled\\DIS${path.slice(cut + 1)}`;
  }

  /** The art WC3 draws for an unavailable command button. It is NOT the live icon tinted —
   *  the engine swaps in a second texture, and that texture differs in two ways: it is
   *  desaturated, and the gold button frame is GONE (the DIS* art fills the tile edge to
   *  edge where the BTN art spends its outer pixels on the frame). Wearing the frame is
   *  what makes a button look pressable, so a greyed one must not.
   *
   *  Null for the six icons in 1.30.4 that ship no twin — the caller falls back to
   *  desaturating the live art, which is the closest we can get without one. */
  private disabledArt(iconUrl: string): string | null {
    const path = this.iconSource.get(iconUrl);
    if (!path) return null;
    const dis = MapViewerScene.disabledIconPath(path);
    return dis ? this.blpIcon(dis) : null;
  }

  /** Pre-decode every command-card icon in the background so none is ever decoded
   *  inside a render frame. blpIcon() is synchronous (BLP → canvas → PNG data URL):
   *  cheap for one icon, but a whole card's worth decoding at once on the FIRST
   *  selection of a unit/building type stalls a frame — the visible "first select"
   *  FPS spike. The unit/ability registries are fixed for the session, so we warm
   *  the cache once during idle time; blpIcon()'s lazy decode stays as the fallback
   *  for anything selected before warming reaches it. */
  private warmIconCache(): void {
    const paths = new Set<string>();
    for (const n of FIXED_CARD_ICONS) paths.add(`ReplaceableTextures\\CommandButtons\\${n}.blp`);
    // The hero "Hero Abilities" learn-skill book uses the Skillz art (see
    // pushAbilityButtons) — not a registry icon, so warm it explicitly.
    paths.add("ReplaceableTextures\\CommandButtons\\BTNSkillz.blp");
    for (const d of this.registry.all()) if (d.icon) paths.add(d.icon);
    for (const a of this.abilities.all()) if (a.icon) paths.add(a.icon);
    for (const it of this.items.all()) if (it.icon) paths.add(it.icon);
    // …and each icon's greyed twin, which a card reaches for the moment a building's
    // prerequisite is missing — i.e. on the FIRST worker selected, for most of the build
    // card. Queued strictly behind the live art: a twin nobody has greyed yet must never
    // delay the icon that is on screen right now.
    const queue = [...paths, ...[...paths].map(MapViewerScene.disabledIconPath).filter((p): p is string => !!p)].filter(
      (p) => !this.iconCache.has(p),
    );

    let i = 0;
    const ric = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback.bind(window) : null;
    const step = (deadline?: IdleDeadline) => {
      // The match may have been left while this was still draining. Every icon it decodes
      // mints a blob URL onto `blobUrls`, and dispose() has already revoked that list —
      // anything added after it would never be released.
      if (this.disposed) return;
      // With real idle time, drain until the budget runs low. When the browser
      // forced us in on the timeout (or there's no idle API) decode a small fixed
      // batch instead, so we make steady progress without stealing a whole frame.
      const hasIdle = !!deadline && !deadline.didTimeout;
      let n = 0;
      while (i < queue.length && (hasIdle ? deadline!.timeRemaining() > 1 : n < 6)) {
        this.blpIcon(queue[i++]); // decode + cache (a miss caches null, so no retry)
        n++;
      }
      if (i < queue.length) schedule();
    };
    const schedule = () => (ric ? ric(step, { timeout: 1000 }) : setTimeout(step, 32));
    schedule();
  }

  /** The decoded pathing footprint for `texPath`, turned to `angle` if one is given (a
   *  doodad's footprint rotates with it — see `quarterTurns`). Cached per turn count so
   *  the unstamp of a felled tree hands back exactly the cells its stamp took. */
  private footprintFor(texPath: string, angle?: number): Footprint | null {
    const turns = angle === undefined ? 0 : quarterTurns(angle);
    const key = turns === 0 ? texPath : `${texPath}|${turns}`;
    let fp = this.footprints.get(key);
    if (fp === undefined) {
      const base = turns === 0 ? null : this.footprintFor(texPath);
      if (turns === 0) {
        const bytes = this.vfs.rawBytes(texPath);
        fp = bytes ? decodePathTex(bytes) : null;
      } else {
        fp = base ? rotateFootprint(base, turns) : null;
      }
      this.footprints.set(key, fp);
    }
    return fp;
  }

  /** The drains that CREATE OR CHANGE world state, split from the render loop's cosmetic
   *  drains (docs/multiplayer.md Phase G item 4): the background pump must run these while
   *  the window is hidden, because a training that completes on a hidden host must still
   *  become a real unit — the sim owns no models, so the renderer's `spawnUnit` is what
   *  creates the record, and until it runs no snapshot can carry the unit. Likewise a
   *  felled tree must stop blocking line of sight, and a summon must exist to be seen.
   *  Every queue here is drain-once, so the frame and the pump can both call this and
   *  whichever runs first simply finds the work. Cosmetic drains (effect models, spell
   *  sounds, item art) stay in the frame: they dress a window nobody is looking at, and
   *  flushing them late on refocus is harmless where a missing UNIT is not. */
  private drainWorldSpawns(world: SimWorld): void {
    // Script spawns are drained FIRST and for EVERYONE, frozen client included: the sim
    // record already exists (JASS CreateUnit is synchronous, under ids the same script
    // allocates identically on every machine — the melee STARTING BASES arrive this way),
    // and this drain only gives it a body. Gating it off a frozen client was the bug that
    // made a client's own base invisible: records, vision, no models.
    for (const sp of this.rts?.drainScriptSpawns() ?? []) {
      const d = this.registry.get(sp.typeId);
      if (d) void this.spawnUnit(d, sp.x, sp.y, sp.player, sp.team, 0, sp.facing, sp.simId);
    }
    // Bodies owed to records the APPLIER created (item 2c — a client's trained peon, a
    // scouted enemy building coming back into view): the record already exists under the
    // HOST's id, so this is the script-spawn shape exactly — attach a model, mint nothing.
    // Empty everywhere but on a client, since only a frozen client ever applies.
    for (const s of this.rts?.drainSnapshotSpawns() ?? []) {
      const d = this.registry.get(s.typeId);
      if (!d) continue;
      void this.spawnUnit(d, s.x, s.y, s.owner, s.team, 0, s.facing, s.id).then(() => {
        // Mid-materialise on the authority (`spawning` is the host's birth lock, still
        // running): play the same birth clip the host's own summon path starts, or a
        // client's Water Elemental simply POPS into the world fully formed. The record's
        // own `spawning` keeps crossing with every payload, so the clip ends on the
        // host's clock like everything else.
        if (s.spawning > 0) this.rts?.beginSummonBirth(s.id);
      });
    }
    for (const it of this.rts?.drainSnapshotItemSpawns() ?? []) void this.spawnItemModel(it.id, it.itemId, it.x, it.y);
    // died=false: the applier removing an item means "no longer sent" (picked up, or eyes
    // left it) — there is no death burst to play.
    for (const id of this.rts?.drainSnapshotItemRemovals() ?? []) this.removeItemModel(id, false);
    // Missiles the payload carries (a frozen client's sim launches none of its own): a new
    // one gets its launch sound and streams its model in, exactly like the sim drain below;
    // a vanished one plays its impact burst where it last was — the payload does not say
    // impact from fizzle apart, and a burst on a fizzle is a smaller lie than silence on
    // every real hit.
    for (const p of this.rts?.drainSnapshotProjSpawns() ?? []) {
      if (!p.art) continue;
      this.sounds?.playMissile(p.art, "launch", { x: p.x, y: p.y, z: this.rts!.groundHeightAt(p.x, p.y) + p.z });
      this.projectileLoading.add(p.id);
      void this.loadProjectile(p.id, p.art);
    }
    // A vanished missile's impact burst is NOT drained here: it must beat updateProjectiles'
    // record-gone sweep to the instance, so it is consumed there, before that sweep.
    // A record the payload MORPHED in place (Scout Tower → Arcane Tower) is owed the other
    // model — the same swap the host's own drainMorphs runs, minus the upgrade chime (that
    // is the owner's, and remodelUnit's own localPlayer check keeps it so).
    for (const m of this.rts?.drainSnapshotMorphs() ?? []) void this.remodelUnit(m.id, m.to);
    // Everything below CREATES sim records with freshly-minted LOCAL ids — the collision
    // family option 2 removes — so a frozen client refuses it. Its trained/summon queues
    // never fill anyway (the sim does not step); new units arrive as snapshot records and
    // grow models through the drains just above.
    if (this.rts?.frozenClient) return;
    const map = this.viewer.map;
    if (map) {
      for (const tree of world.drainFelledTrees()) {
        this.fellTreeVisual(tree.id, tree.x, tree.y, map.doodads); // "death" fall + leave the stump
        this.rts?.onTreeFelled(tree.x, tree.y, tree.blockRadius); // stop blocking fog line-of-sight
      }
    }
    // Finished training: the unit exits from the building corner nearest its
    // rally point and rotates counterclockwise to the next clear spot if that
    // corner is crowded (WC3), then walks to the rally point. `claimed` holds
    // the spots handed out this call so a batch trained at once can't stack.
    const claimed: Array<[number, number]> = [];
    for (const t of world.drainTrained()) {
      const d = this.registry.get(t.unitId);
      if (!d) continue;
      const [sx, sy] = this.trainSpawnSpot(t.buildingId, t.x, t.y, t.rallyX, t.rallyY, d.collision || 16, claimed);
      const rally = { kind: t.rallyKind, targetId: t.rallyTargetId, x: t.rallyX, y: t.rallyY };
      // "unit ready" voice on completion — YOUR unit, like the research chime below: on a
      // LAN host this drain completes other players' trainings too (Phase G item 5).
      if (t.owner === this.localPlayer) this.sounds?.play(d.soundSet, "Ready");
      const buildingId = t.buildingId;
      // The unit belongs to whoever owned the TRAINER, never to this machine's player —
      // `localPlayer` here was playtest bug 4: every peon a client trained came out
      // host-owned, ate the host's food, and leaked the host vision in the client's base.
      const team = this.teamOf(t.owner);
      // It EXISTS NOW — the same two-step the script-spawn path uses (createScriptUnit:
      // sim unit first, body when the model has streamed). Awaiting the model here left a
      // window of one model-load (~100 ms, longer on a cold MPQ read) in which the unit was
      // off the building's queue and not yet in the sim, i.e. nowhere at all: "what am I
      // producing" answered as if it had never been trained. A hero hired at a Tavern is
      // hired INSTANTLY, so that window IS the whole hire — the fresh hero counted for
      // neither the hero bar nor the hero limit, and the Altar happily offered a second
      // "first" hero at tier 1. Food and the requirement tier had the same hole.
      const simId = this.rts!.addSimUnit(d, sx, sy, TRAINED_FACING, t.owner, team, 0, this.rts!.reserveUnitId());
      // …and walk it to the rally point, but ONLY if this building has one. A `Sellunits`
      // shop does not (see BuildingState.producesUnits): a hired mercenary appears beside the
      // camp and stands there. Sending it to the default point 200 south instead is not just
      // cosmetic — WTii's Unit Tester teleports every bought unit into an arena the moment it
      // enters the shop's region, and a unit still carrying a move order walked straight back
      // out of the arena and across the map to a rally flag it should never have had.
      if (world.acceptsRally(buildingId)) this.applyRally(simId, rally);
      // EVENT_(PLAYER_)UNIT_TRAIN_FINISH (7.17) — raised HERE, not in the sim: the trained
      // unit is born in the renderer (the sim owns no models), and GetTrainedUnit must hand
      // the script the real unit. It fires on completion now, not a model-load later.
      world.noteTrainFinish(buildingId, simId);
      void this.spawnUnit(d, sx, sy, t.owner, team, 0, TRAINED_FACING, simId);
    }
    this.raiseEntangledMines(world);
    const summonClaimed = new Set<string>(); // cells handed out this call (see summonSpot)
    for (const s of world.drainSummonRequests()) {
      const d = this.registry.get(s.unitId);
      if (!d) continue;
      const summonLeft = s.summonLeft;
      const [sx, sy] = this.summonSpot(s.x, s.y, s.facing, d.collision || 16, s.atPoint, summonClaimed);
      // The summon burst belongs on the SPOT the unit lands on, not on the caster —
      // three wolves fan out around the Far Seer, and each arrives in its own.
      if (s.summonArt) world.emitEffectAt(s.summonArt, sx, sy, true); // the model carries its own SND event
      // …and a summon whose ability names NO burst still announces itself, because in WC3
      // the sound of a ward going down is the WARD's own: every one of them (`[AOsw]` Serpent
      // Ward, `[Aeye]` Sentry Ward, `[Ahwd]` Healing Ward, `[Asta]` Stasis Trap) carries no
      // art field at all, and the SND event sits on the arriving unit's Birth clip. Without
      // this a Shadow Hunter planted his ward in total silence.
      else this.sounds?.playModelSound(d.model, { x: sx, y: sy, z: this.rts!.groundHeightAt(sx, sy) });
      void this.spawnUnit(d, sx, sy, s.owner, s.team).then((simId) => {
        if (simId === null) return;
        const su = world.units.get(simId);
        if (su) su.unsummonArt = s.unsummonArt; // how it leaves when its time is up
        if (su && summonLeft > 0) {
          su.summonLeft = summonLeft;
          su.summonMax = summonLeft;
          su.isSummon = true; // temporary summon — expires, leaves no corpse, ×0.5 XP
        }
        // A RAISED body is a shell, not the unit that fell: "the raised units keep their
        // attacks but lose all abilities and spells" (Animate Dead). It walks and swings and
        // nothing else — no autocast, no casting, no Web, no Burrow.
        //
        // Gated on `stripped`, which only the RAISE path sets. It used to be gated on
        // `summonLeft > 0`, i.e. on being temporary at all — and every summon in the game is
        // temporary. So the Phoenix arrived without Phoenix Fire, and the Avatar of Vengeance
        // (`espv`, `abilList = ACmi,Asp1,ACrk,Avng`) arrived with no Spell Immunity, no
        // Resistant Skin, and no way to raise a single Spirit: an empty command card on a
        // 180-second ultimate whose whole job is that autocast.
        if (su && s.stripped && su.abilities.length) su.abilities = [];
        // …and a BOUND summon goes when its summoner does (see SimUnit.summonerId).
        if (su && s.bound) su.summonerId = s.sourceId;
        // …and Animate Dead's raise cannot be hurt at all (`Hre2 "Raised Units Are
        // Invulnerable"`), which is why the ultimate is six bodies you can only wait out.
        if (su && s.invulnerable) {
          su.buffs.push({ kind: "invuln", group: "raised", timeLeft: summonLeft > 0 ? summonLeft : Infinity, sourceId: s.sourceId, value: 0, value2: 0, art: "", fx: [], buffId: "", delay: 0 });
        }
        // Turn the fresh copy into an illusion of its original. The sim owns this: the
        // level has to be applied and the stats rebuilt off it before hp/mana can be set
        // (see initIllusion), which is not something the renderer should be sequencing.
        if (su && s.illusion) world.initIllusion(su, s.sourceId, s.illusion);
        this.rts!.beginSummonBirth(simId); // materialize (birth clip + spawn lock)
      });
    }
  }

  /** Advance the simulation by however much real time has passed since it LAST advanced —
   *  from whichever driver is asking, the rAF frame or the background pump. The F10 game
   *  menu freezes it (units hold; rendering continues); paused time is not owed to the sim.
   *
   *  FIXED TIMESTEP. The sim advances in whole SIM_DT steps and never in a raw frame
   *  delta, so a match is a COUNT OF TICKS rather than a history of one machine's
   *  frame rate. Two things need that: replays, and multiplayer — the host's
   *  authoritative tick number is what a command attaches to and what a snapshot is
   *  stamped with (docs/multiplayer.md). src/sim/world.ts always claimed to be
   *  fixed-timestep; until now the claim was aspirational.
   *
   *  It also subsumes the old Math.min(dt, 50) clamp (issue #24: at low frame rates a
   *  single huge step made melee units overshoot and "shuffle"). Every step is now
   *  SIM_DT no matter how bad the frame was; a slow frame just runs more of them, and
   *  MAX_STEPS_PER_FRAME caps that so a long stall can't spiral into an ever-growing
   *  catch-up. Dropping the remainder there loses game time, which is the right thing
   *  to lose: the alternative is a death spiral. (With the background pump running, no
   *  hidden-window backlog builds in the first place — 50 ms of debt is at most 3 steps.) */
  private advanceSim(now: number): void {
    if (this.paused || this.startHeld) {
      this.simLast = now;
      this.lastSimStep = 0; // no game time passed, so a camera following a group holds too
      // A world held at the gate still ADOPTS: the loading screen's last stretch is the start
      // preload, and models the map's script spawned are still resolving through it. Seeding
      // is not simulation — it is how a delivered instance becomes a sim unit at all — so a
      // unit that lands while we are held must not have to wait for the release to exist
      // (the same split `holdWorld` draws: "adoption yes, simulation no").
      if (this.startHeld) this.rts?.seedPending();
      return;
    }
    // rAF timestamps and performance.now() share a clock, but a frame's vsync stamp can
    // land a hair BEFORE a pump step that already ran — clamp, never rewind.
    const dt = this.simLast ? Math.max(0, now - this.simLast) : 1000 / 60;
    this.simLast = now;
    this.simAccum += dt / 1000;
    let steps = 0;
    while (this.simAccum >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      // A frozen client must not start builds off its own records (option 2): the worker's
      // position is the HOST's answer arriving at 10 Hz, and the host runs the real
      // tickPendingBuild — a local start here would mint a local id, which is the
      // collision family this whole phase removes.
      if (!this.rts?.frozenClient) this.tickPendingBuild(SIM_DT); // seconds, matching the sim's clock
      this.rts?.tick(SIM_DT); // sim runs in seconds; advance + sync before render
      // Engine combat text ages on the SIM clock, like a script's text tags do inside the
      // interpreter — so the F10 menu freezes a crit number in place instead of running it
      // out while the game is stopped. Both machines do this: a frozen client is fed the
      // same events over the wire and owes them the same rise and fade.
      this.combatText.advance(SIM_DT);
      // A unit that came into existence THIS step exists for this step's triggers. The spawns
      // used to be drained during render, i.e. after the script had already been pumped, so a
      // trained unit was one whole frame old before any trigger could see it — and a map that
      // moves what you buy showed it standing at the shop for that frame before it vanished.
      // WTii's Unit Tester is the visible case (`Move Trained Units`: an enter-region trigger on
      // the rect the shops stand in, `SetUnitPositionLoc` to the arena), and the same gap
      // delayed every EVENT_PLAYER_UNIT_TRAIN_FINISH by a frame. Drain-once, so the render and
      // background-pump callers that also ask are harmless.
      const spawnWorld = this.rts?.simWorld;
      if (spawnWorld) this.drainWorldSpawns(spawnWorld);
      this.reapDestructibles(); // a gate the sim just broke opens the way a script-killed one does
      // A frozen client runs the script INIT (config/main — the melee starting bases are
      // born there, under ids every machine allocates identically) but never PUMPS it:
      // its world is an AoI subset the authority wrote, and a victory check read against
      // it sees an opponent with no units and ends the match on the spot (the 2e fork,
      // decided by that live failure). What the script would have shown arrives over the
      // wire instead — dialogs and the verdict are already relayed (items F7/G1).
      if (!this.rts?.frozenClient) this.pumpMapScript(SIM_DT); // Phase 7: the map's timers + enter/leave-region triggers
      this.simTick++;
      this.simAccum -= SIM_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.simAccum = 0;
    this.lastSimStep = steps * SIM_DT * 1000; // the clock the held-key camera follow runs on
    // How much GAME time this pass actually bought. The two clocks are not the same clock —
    // a slow frame steps at most MAX_STEPS_PER_FRAME and drops the rest — and anything the
    // SCRIPT timed has to be aged by this one (see the cinematic panel's update).
    this.simAdvanced += steps * SIM_DT;
  }

  /** Keep a LAN match simulating when Chrome stops the render loop (docs/multiplayer.md
   *  Phase G item 4 — playtest bug 2). Two windows on one machine means the HOST is
   *  usually the hidden/occluded one, and rAF stops entirely there: the authority
   *  freezes, every client stops receiving snapshots, and MAX_STEPS_PER_FRAME then drops
   *  the backlog on refocus, so the lost time is lost for good.
   *
   *  Page timers are clamped in background tabs (~1 Hz, worse under intensive
   *  throttling); a DEDICATED WORKER's timers are not, so the clock lives there and
   *  posts every 50 ms. The handler runs on the main thread like any message, so there
   *  is no concurrency with the frame — and it stands down while rAF is actually alive.
   *  `advanceSim`'s shared clock makes a stray overlap harmless anyway; the gate just
   *  keeps the steady state single-driver. `drainWorldSpawns` must ride along: a
   *  training that completes on a hidden host has to become a real unit (the sim owns no
   *  models — the renderer's spawnUnit is what creates the record) or no snapshot will
   *  ever carry it. */
  private startBackgroundPump(): void {
    if (this.bgPump) return;
    const src = "setInterval(() => postMessage(0), 50);";
    this.bgPump = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    this.bgPump.onmessage = () => {
      const now = performance.now();
      if (now - this.lastFrameAt < 200) return; // rAF is alive — it is the driver
      this.advanceSim(now);
      const world = this.rts?.simWorld;
      if (world) this.drainWorldSpawns(world);
    };
  }

  start(): void {
    if (this.raf) return;
    const frame = (t: number) => {
      const dt = this.last ? t - this.last : 1000 / 60;
      this.last = t;
      this.lastFrameAt = t;
      // A LAN match must keep simulating when this window is hidden or occluded — rAF
      // stops there, and on ONE machine with two windows the host is usually the covered
      // one (docs/multiplayer.md Phase G item 4). Single-player keeps the browser's
      // natural "hidden tab = paused game".
      if (!this.bgPump && this.rts?.networked) this.startBackgroundPump();
      // The sim steps FIRST, and the camera is derived from the world it just produced.
      //
      // The camera used to be updated at the top of the frame, off the world as it stood
      // BEFORE the frame's sim steps — which is fine for a camera the player is driving and
      // wrong for one that is riding a unit: `followHeld` would aim at where the group was
      // one frame ago, by a margin that changes with however many steps the frame went on to
      // retire. Deriving it here instead means the focus and the positions the frame is about
      // to DRAW come from the same instant of game time.
      this.advanceSim(t);
      this.updateCamera(dt);
      this.metrics.frame(dt, this.rts?.unitCount() ?? 0);
      this.hud?.frame(dt);
      this.updateClock(dt);
      this.updatePortrait();

      // Re-scan for new on-map unit types (trained units, scouted enemies) a couple
      // times a second and warm their portraits before they're clicked.
      this.portraitWarmAccum += dt;
      if (this.portraitWarmAccum > 2000) {
        this.portraitWarmAccum = 0;
        this.warmPortraits();
      }
      // The cinematic panel runs on the SIM's clock, not the render one.
      //
      // Everything it counts down was written by the map in the same seconds its
      // `TriggerSleepAction`s are written in: a scene's `sceneDuration` decides when a line of
      // subtitle comes off, and the script's own sleep decides when the next one arrives. Those
      // two clocks have to be the same clock, and the render one is not it — a frame that runs
      // long steps the sim at most MAX_STEPS_PER_FRAME and DROPS the remainder, so game time
      // falls behind wall time and never catches up. Aged on wall time, every subtitle then
      // expired early: at 3 fps (the swiftshader harness) a 9-second line of Maiev's was gone
      // in two, and even a brief dip mid-scene reads as lines being cut off.
      //
      // (`simAdvanced` is drained here, right after the sim was stepped, so a frame that
      // stepped nothing ages nothing — which is also what a paused game should do.)
      this.cinematic?.update(this.simAdvanced);
      this.simAdvanced = 0;
      // Map units load async — hide the start-location props as they stream in.
      // Re-scan whenever the unit count grows so `sloc` markers that finish
      // loading a frame or two after `unitsReady` are still hidden (see the
      // lastMarkerScanCount field), instead of rendering for the whole match.
      if (this.viewer.map?.unitsReady) {
        const n = this.viewer.map.units.length;
        if (n !== this.lastMarkerScanCount) {
          this.lastMarkerScanCount = n;
          this.hideStartLocations();
        }
      }
      this.updateSelectionCircles(dt / 1000);
      this.updateOrderArrows(dt / 1000);
      this.updateEffects(dt / 1000);
      this.updateSpellSplats(dt / 1000); // Thunder Clap's scorch fading in/out on the ground
      this.lightning?.update(dt / 1000); // age the live bolts; expired ones retire themselves
      this.updateMirrorMissiles(dt / 1000);
      this.updateAuraEffects();
      this.updateSpecialFx(dt / 1000); // script effects: age them, settle Birth→Stand, fog-gate
      this.updateDyingFx(dt / 1000); // buff art + script effects playing out their Death clip
      this.updateTreePulses(dt / 1000);
      this.updateTreeActors(dt / 1000); // per-chop "stand hit" wobble + off-camera clip catch-up
      this.updateProjectiles();
      this.updateBloodMageSpheres(dt / 1000); // Blood Mage orbiting spheres + thrown balls
      this.updatePendingBuildGhosts(); // dark-blue ghosts of queued-but-not-started builds
      if (this.placement) this.updateGhost(this.lastMouse.x, this.lastMouse.y); // show/position the ghost each frame (not only on mouse move)
      // lastMouse is CANVAS space (it unprojects into the world); the reticle is a body-fixed
      // overlay, so it rides the VIEWPORT cursor. Letterboxed, the two are a black bar apart.
      this.updateReticle(this.lastCursor.x, this.lastCursor.y);
      const world = this.rts?.simWorld;
      const map = this.viewer.map;
      if (world && map) {
        // The drains that CREATE OR CHANGE world state (trained units, summons, felled
        // trees) live in drainWorldSpawns so the background pump can run them while this
        // window is hidden; every queue is drain-once, so both callers are safe.
        this.drainWorldSpawns(world);
        for (const mine of world.drainDepletedMines()) {
          this.removeNodeVisual(mine.id, mine.x, mine.y, map.units as unknown as HideableWidget[]);
          this.splats?.remove(`m${mine.id}`); // drop the mine's ground texture
        }
        // The news the engine announces by itself — a raid, a hero lost, a mine running out
        // (see SimWorld.Alert). Drained before the completion cues so that if a Town Hall
        // finishes in the same frame its site is stormed, the player is told about the raid.
        for (const a of world.drainAlerts()) this.showAlert(a);
        // A building you were putting up is UP: the worker's "Job's done." (issue #111). The
        // THIRD completion cue, and a separate row from the two below — war3skins.txt gives
        // each race a `JobDoneSound`, and every one of them is that race's builder saying so
        // (JobDoneSoundOrc → Sound\Buildings\Orc\PeonJobDone.wav, JobDoneSoundNightElf →
        // HuntressBuildingComplete1.wav, since a Wisp has no voice to say it with).
        // A 2D interface cue like its neighbours (UISounds.slk Flags=0), so it is heard the
        // same wherever on the map the scaffolding came down.
        //
        // It also prints a LINE, which the real client does not: the three completion sounds
        // have no [Errors] row (see SimWorld.Alert), so in WC3 a finished building only
        // speaks. A deliberate departure, asked for because "Job's done." names no building
        // and a base putting up four things at once says it four identical times. The words
        // are still the game's own — `COLON_COMPLETED` ("Completed: ") out of
        // GlobalStrings.fdf — so a localized install says it in its own language, and it is
        // shown where the engine shows every one-line thing it has to tell you: the gold line
        // above the console that carries "Not enough gold." and "Our town is under siege!"
        // alike (`showAlert` puts the game's own news there for the same reason). Replaced,
        // never stacked — four buildings finishing together leave the last one's line up.
        for (const c of world.drainBuildCompletions()) {
          if (c.owner !== this.localPlayer) continue;
          this.sounds?.playUi(`JobDoneSound${UI_SOUND_RACE[this.localRace]}`);
          const name = this.registry.get(world.units.get(c.buildingId)?.typeId ?? "")?.name;
          if (name) this.hud?.showError(`${this.globalStrings?.strings.get("COLON_COMPLETED") ?? "Completed: "}${name}`);
        }
        // --- research + structure upgrades (issue #57) ---
        // WC3 keeps two DISTINCT completion cues, per race: ResearchComplete<Race> for an
        // upgrade you research (Forged Swords) and UpgradeComplete<Race> for a structure that
        // becomes another (Town Hall → Keep). Both are in UI\SoundInfo\UISounds.slk.
        // Nothing else to do for research: recomputeStats() re-derives every unit's stats from
        // the owner's researched levels each tick, so a Footman fighting on the far side of the
        // map gets his new sword the moment the Blacksmith finishes.
        for (const r of world.drainResearchCompletions()) {
          if (r.owner === this.localPlayer) this.sounds?.playUi(`ResearchComplete${UI_SOUND_RACE[this.localRace]}`);
        }
        // A building became something else: swap its model in place. The sim kept the SAME
        // entity — rally point, queue, selection and damage all carried over — so this only
        // has to re-skin it and re-read the food it supplies.
        // A unit that changed hands (Charm, a script's SetUnitOwner) wears its new owner's
        // colour from the next frame. The sim only records the handover — models are the
        // renderer's — so a Charmed Knight fighting for blue turns blue, and a creep taken
        // off the Neutral Hostile slot stops wearing creep red. Same lookup the spawner uses
        // (playerColor): a slot's colour is not its index.
        for (const c of world.drainOwnerChanges()) this.rts!.setUnitTeamColor(c.unitId, this.rts!.playerColor(c.owner));
        for (const m of world.drainMorphs()) {
          const u = world.units.get(m.unitId);
          // …and the chime, which belongs to the BUILDING half of this event only. `morphs`
          // carries every type swap there is, and the two kinds sound nothing alike in WC3: a
          // Town Hall finishing its Keep announces itself, an Alchemist entering Chemical Rage
          // (or a Crypt Fiend burrowing, or a Peasant taking up arms) does not — it played the
          // "upgrade complete" fanfare over every hero morph.
          if (u?.owner === this.localPlayer && u.building) this.sounds?.playUi(`UpgradeComplete${UI_SOUND_RACE[this.localRace]}`);
          void this.remodelUnit(m.unitId, m.to);
        }
        // --- spells / abilities ---
        // Effect models (Holy Light burst, Heal glow, Thunder Clap ring, …): follow
        // the target unit if one is given, else play at the point. These four drains read
        // the CONTROLLER's queues, not the sim's — same events where the sim steps, the
        // payload's events on a frozen client, one renderer path either way (item 9c-fx).
        for (const fx of this.rts!.drainFxEffects()) {
          const t = fx.targetId ? world.units.get(fx.targetId) : null;
          const x = t ? t.x : fx.x;
          const y = t ? t.y : fx.y;
          const z = this.rts!.groundHeightAt(x, y);
          void this.spawnEffect(fx.art, x, y, z + (fx.z || 0), fx.life ?? 2);
          // A wave field asked for its shard-fall sound (Blizzard): the WAV lives in
          // the effect model's own folder, so resolve it off the art like a cast sound.
          if (fx.sound) this.sounds?.playSpellSound([fx.art], undefined, { x, y, z });
          // …and the cue that names its WAV by LABEL instead, because the wav does not live
          // beside the art it plays with (a shop's `ReceiveGold` under the coin pile).
          if (fx.soundLabel) this.sounds?.playAbilitySound(fx.soundLabel, { x, y, z });
        }
        // Ground decals a spell painted this frame (Thunder Clap's scorch, THND).
        for (const s of this.rts!.drainFxSplats()) this.addSpellSplat(s.splatId, s.x, s.y);
        // Lightning bolts strung this frame (issue #97). Only the request crosses here —
        // both ends are re-read from the units every frame in the render pass below, so a
        // bolt stays attached to a target that walks out from under it.
        for (const l of this.rts!.drainFxLightnings()) {
          this.lightning?.add({ type: l.id, srcId: l.sourceId, dstId: l.targetId, sx: l.sx, sy: l.sy, sz: l.sz, tx: l.tx, ty: l.ty, tz: l.tz, life: l.life, delay: l.delay, tag: l.tag });
        }
        // …and bolts the sim cut short (an interrupted Drain's tether).
        for (const tag of this.rts!.drainFxLightningStops()) this.lightning?.stop(tag);
        // Sustain the looping bed under each running channelled field, and drop it the
        // frame the field ends — waves exhausted OR caster interrupted (world tears the
        // field down either way, so this needs no interrupt handling of its own).
        this.updateFieldLoops(world.activeSpellFields());
        // Cast animations (throw/slam/spell) begin at the wind-up.
        for (const c of this.rts!.drainFxCastStarts()) {
          this.rts!.playCastAnim(c.casterId, c.code, c.hold, c.loop);
          // A delayed-strike spell drops its "beware" art as the wind-up STARTS, and the
          // sound rides that model: FlameStrikeTarget.mdx fires its SND…AHFT event at frame
          // 0 of its birth clip, so Flame Strike's rising howl begins with the cast point's
          // timer — not 1.33s later at ignition (which sounds the pillar's own AHFS event).
          if (c.warnArt) this.sounds?.playModelSound(c.warnArt, { x: c.tx, y: c.ty, z: this.rts!.groundHeightAt(c.tx, c.ty) });
          const caster = world.units.get(c.casterId);
          // Blood Mage: hurl one orbiting sphere at Flame Strike / Banish targets (issue #37).
          if (MapViewerScene.SPHERE_THROW_CODES.has(c.code) && caster && this.hasSpheres(caster.typeId))
            this.throwSphere(c.casterId, c.tx, c.ty, c.targetId);
        }
        // ...but the cast/effect SOUND fires with the effect at the cast point (issue #23):
        // it lands with the visible clap/bolt, not 0.4s early at the wind-up, and an
        // interrupted wind-up (no fire) correctly stays silent.
        for (const c of this.rts!.drainFxCastFires()) {
          const def = this.abilities.get(c.abilityId);
          if (!def) continue;
          const caster = world.units.get(c.casterId);
          const at = caster ? { x: caster.x, y: caster.y, z: this.rts!.groundHeightAt(caster.x, caster.y) } : undefined;
          // Target → caster → special first (the effect the player is looking at), then the
          // three carriers a spell that names NO art of its own falls back on: its own
          // `Effectart` (Silence's SilenceAreaBirth → Silence1.wav), its effect object's
          // (Death and Decay, Tranquility, Earthquake — see AbilityDef.fxArt) and finally
          // its BUFF's worn model, which for Sleep is the only art in the whole chain
          // (`[BUsl] Targetart = …\Undead\Sleep\SleepTarget.mdl` → SleepBirth1.wav).
          // Without these three, those spells cast in silence.
          // FIRST, though: the ability's OWN event, wherever it is keyed. A cast sound is an
          // SND event named after the ability (`SNDXAEFK` = `[AEfk]`), and WC3 keys it into
          // whichever model plays the gesture — which for Fan of Knives is the WARDEN, not the
          // spell's art (see playModelAbilityEvent). Asking her model by code is exact; the
          // art chain below is the guess we fall back to.
          if (this.sounds?.playModelAbilityEvent(this.rts!.renderedModelPath(c.casterId), c.code, at)) continue;
          const arts = SPELL_SOUND_ART[c.code]?.(def) ?? [def.targetArt, def.casterArt, def.specialArt, def.effectArt, def.areaArt, def.fxArt, def.fxSpecialArt, def.buffArt];
          this.sounds?.playSpellSound(arts, SPELL_SOUND_FALLBACK[c.code], at);
        }
        // Floating COMBAT text: a Critical Strike's red "127!" over the unit it struck, the
        // "!" a deny leaves behind, and a "+N" wherever the engine pays somebody (see
        // CombatText). Read off the CONTROLLER's queue like the four drains above, so a
        // frozen client raises the same text off its payload.
        for (const t of this.rts!.drainFxCombatTexts()) {
          // …but only the text ADDRESSED to this machine. A crit and a deny are public facts
          // and carry -1; every CREDIT — the gold, the lumber, a creep's bounty, a hero's XP —
          // carries the player it paid, and belongs on nobody else's screen: not an opponent's,
          // and not the HOST's while it watches somebody else's hero sell an item (issue #120).
          // The host already keeps it out of the other payloads (MatchLink.tickHost); this is
          // the same rule applied to the one client that reads the queue directly.
          if (t.forPlayer >= 0 && t.forPlayer !== this.localPlayer) continue;
          // A credit is styled by its KIND, off the game's own row for it (CREDIT_TEXT). A
          // crit and a deny are not credits: a crit is red for everyone, and a deny wears the
          // colour of the player whose unit died — resolved HERE and not in the sim, because
          // `SetPlayerColor` can move a slot's colour mid-match and the palette is the
          // client's (the same one the minimap dots and a cinematic's speaker names use).
          const credit = t.kind === "crit" || t.kind === "deny" ? undefined : CREDIT_TEXT[t.kind];
          this.combatText.spawn({
            text: t.text,
            color:
              credit?.color ??
              (t.colorSlot >= 0
                ? argbOf(PLAYER_COLORS[this.rts!.playerColor(t.colorSlot) % PLAYER_COLORS.length])
                : CRIT_TEXT_COLOR),
            x: t.x,
            y: t.y,
            z: credit?.z ?? COMBAT_TEXT_Z,
            followUnit: t.unitId,
            // The credits are the kinds the game keeps a full spec for that we honour — their
            // own height, drift, lifetime and fade. A crit falls back to CRIT_TEXT_STYLE.
            style: credit?.style,
          });
        }
        // Hero level-up nova.
        for (const lu of world.drainLevelUps()) {
          const h = world.units.get(lu.unitId);
          if (h) void this.spawnEffect(LEVEL_UP_FX, h.x, h.y, this.rts!.groundHeightAt(h.x, h.y), 1.5);
        }
        // Summoned / raised units — create their models on the nearest free tile (in front
        // of the caster, or ON the targeted point for a ward — see summonSpot), play their
        // birth clip, then flag temporary summons (Water Elemental) so the sim expires them.
        for (const m of world.drainMirrorMissiles()) void this.spawnMirrorMissile(m);
        // --- items on the ground (dropped / creep-dropped) ---
        for (const it of world.drainItemSpawns()) void this.spawnItemModel(it.id, it.itemId, it.x, it.y);
        for (const r of world.drainItemRemovals()) this.removeItemModel(r.id, r.died);
        // A PowerUp was consumed: play the ability's own effect model on the unit that took
        // it, and sound it. The sound is the model's business first — a tome names no
        // Effectsound at all and carries an SND…AITM event inside AI?mTarget.mdx that
        // resolves (AnimLookups → AnimSounds "Tome") to Tomes.wav, which is exactly what
        // playSpellSound reaches for. The runes and glyphs instead name an Effectsound
        // LABEL (`PowerupSound`, the same Tomes.wav; `ReceiveGold`/`ReceiveLumber` for the
        // resource items), so that is the fallback — and the only source for the runes that
        // carry no art of their own. Verified 1.27a Units\ItemAbilityFunc.txt +
        // UI\SoundInfo\AbilitySounds.slk (row Y49) — see docs/wc3-data-formats.md.
        for (const p of world.drainPowerupPickups()) {
          const u = world.units.get(p.unitId);
          if (!u) continue;
          const at = { x: u.x, y: u.y, z: this.rts!.groundHeightAt(u.x, u.y) };
          // The tome effects are a single 900ms Birth clip with no Death, so they are
          // reaped on a timer rather than by a clip ending.
          if (p.art) void this.spawnEffect(p.art, at.x, at.y, at.z, 1.5);
          // BOTH sources sound, because in the engine they are independent: the SND event
          // is baked into the effect model's animation and fires by playing it at all,
          // while `Effectsound` is the ability's own. The Chest of Gold is the case that
          // proves it — its model carries a Rejuvenation sting AND the ability names
          // `ReceiveGold`, and the game's signature coin "cha-ching" is the latter, so
          // treating the model event as a short-circuit loses it.
          if (p.art) this.sounds?.playModelSound(p.art, at);
          if (p.soundLabel) this.sounds?.playAbilitySound(p.soundLabel, at);
        }
        this.updateItemAnims();
        this.updateItemFog();
      }
      // Reset the command page + placement when the selection changes.
      if (this.rts && this.rts.selectedId !== this.lastSelected) {
        this.lastSelected = this.rts.selectedId;
        this.cardPage = "root";
        if (this.placement) this.cancelPlacement();
      }
      // Advance animations by REAL elapsed time (fixes 2x speed on high-refresh
      // displays), replicating War3MapViewer.update() = super.update() + map.update().
      baseUpdate.call(this.viewer, dt);
      this.viewer.map?.update();
      // Re-pin under-construction buildings AFTER the animation advance so a
      // halted build's Birth animation truly freezes (and resumes with progress).
      this.rts?.repinConstructionFrames();
      // Fog of war: build it once the map is ready, resample a few times a second,
      // and draw it as our own pass over the freshly-rendered world.
      this.ensureFog();
      if (this.fog) {
        this.fogAccum += dt;
        if (this.fogAccum >= 100) {
          this.fogAccum = 0;
          this.updateFog();
        }
      }
      this.viewer.startFrame();
      const fogScene = map?.worldScene;
      if (fogScene) this.applyDayNight(fogScene);
      // Reconcile and fog-gate ubersplats before we draw them this frame. A building's ground
      // splat is part of its IMAGE: it shows exactly when the building's model does — live or
      // remembered — and is withheld with it. Splats used to answer to nothing but the fog
      // VEIL, which leaked a never-scouted building's foundation through explored fog (the
      // host reading a client's base off the ground) and left orphaned foundations on a
      // frozen client wherever the applier had removed a neutral building's record.
      if (this.splats && fogScene && this.rts) {
        const world = this.rts.simWorld;
        // Dynamic buildings (keyed by sim id): a record gone on the HOST is a destroyed
        // building — drop the decal. On a CLIENT the applier removes records for "you cannot
        // see it" too, but an unseen dynamic building's splat SHOULD be gone there as well:
        // its image never earned a memory (a remembered one keeps its record, so it stays).
        this.splats.reconcile(this.simBuildingSplats, (id) => world.units.has(id as number));
        for (const id of [...this.simBuildingSplats]) if (!this.splats.has(id)) this.simBuildingSplats.delete(id);
        for (const id of this.simBuildingSplats) this.splats.setVisible(id, this.rts.buildingImageShown(id));
        // An UPROOTED Ancient takes its foundation with it. The decal is the mark the roots
        // leave in the ground, so it belongs where the roots are: lifted while the Ancient
        // walks, and re-laid where it plants again — which is a NEW spot, because toggleRoot
        // snaps it onto the build grid wherever it stopped. It is the only building in the
        // game that moves, so this is the only place a splat is ever re-sited.
        for (const u of world.units.values()) {
          if (!u.ancient) continue;
          if (u.uprooted) {
            if (this.liftedSplats.has(u.id)) continue;
            this.liftedSplats.add(u.id);
            if (this.simBuildingSplats.delete(u.id)) this.splats.remove(u.id);
            // A map-PLACED Ancient's decal is keyed by its .doo index instead (see
            // stampMapPathing), so it has to be found by the sim id it was tracked against.
            for (const [key, s] of this.mapBuildingSplats) {
              if (s.simId !== u.id) continue;
              this.mapBuildingSplats.delete(key);
              this.splats.remove(key);
            }
          } else if (this.liftedSplats.delete(u.id)) {
            const def = this.registry.get(u.typeId);
            if (def?.uberSplat) {
              this.simBuildingSplats.add(u.id);
              // Where the FOOTPRINT went down, not where the unit is standing this frame: a
              // planting Ancient spends its root animation walking the last stretch onto the
              // site (SimUnit.rootSettle), so its position is still short of the spot the mark
              // its roots leave belongs on. The stamp is already on the site.
              const at = u.pathStamp ?? { x: u.x, y: u.y };
              this.addBuildingSplat(u.id, def, at.x, at.y);
            }
          }
        }
        // Pre-placed buildings (p<i>): their reserved sim id is known statically, so the old
        // 250 ms position-matching prune collapses into an exact per-frame id check.
        const frozen = this.rts.frozenClient;
        for (const [key, s] of this.mapBuildingSplats) {
          if (world.units.has(s.simId)) {
            s.seen = true;
            this.splats.setVisible(key, this.rts.buildingImageShown(s.simId));
          } else if (frozen) {
            // Absent on a client means "not sent" — out of sight, not destroyed. Withhold the
            // decal; scouting the spot re-creates the record and shows it again.
            this.splats.setVisible(key, false);
          } else if (s.seen) {
            // The host's records are the truth: existed once, gone now = destroyed (issue #40).
            this.splats.remove(key);
            this.mapBuildingSplats.delete(key);
          }
        }
      }
      // We replay the w3x map's own render sequence (ground → cliffs → opaque → water →
      // translucent) so the building ubersplat pass can slot in AFTER the opaque world
      // but BEFORE the translucent instances. That way selection/hover/AoE/flash rings —
      // which are flat MDX ground decals in the translucent pass — paint ON TOP of the
      // ubersplats instead of under them (issue #16), while the splats still sit on the
      // terrain. Splats draw before the fog so the veil dims them like the ground.
      // Rebuild the unit shadow batch from the visible units (cheap — see updateShadowBatch).
      if (this.shadows) this.updateShadowBatch();
      if (map && fogScene && map.anyReady) {
        fogScene.startFrame();
        this.syncBlight(map); // the Undead's rot, painted onto the ground before it is drawn
        map.renderGround();
        map.renderCliffs();
        // Unit shadows draw BEFORE the opaque units: the top-right cast falls north (away
        // from the camera), so it must be laid down first or the unit body would occlude it.
        // The map's baked shadow layer goes down FIRST, under everything: it is part of how
        // the ground looks, so a unit blob and a foundation decal both belong on top of it.
        if (this.terrainShadows) this.terrainShadows.render(fogScene.camera.viewProjectionMatrix);
        if (this.shadows) this.shadows.render(fogScene.camera.viewProjectionMatrix);
        fogScene.renderOpaque();
        map.renderWater();
        if (this.splats) this.splats.render(fogScene.camera.viewProjectionMatrix);
        // Building shadows draw AFTER the foundation decals so a building's shadow darkens
        // its own ubersplat, not just the grass around it (issue #58 f/u). The building
        // body (opaque, already drawn) still occludes it at the base via depth.
        if (this.buildingShadows) this.buildingShadows.render(fogScene.camera.viewProjectionMatrix);
        // Selection rings draw right after the shadows/splats (so a ring paints ON TOP of a
        // foundation decal — issue #16) and BEFORE the translucent units (so a unit body
        // draws over its own ring, which reads as sitting under it).
        if (this.ringSplats) this.ringSplats.render(fogScene.camera.viewProjectionMatrix);
        fogScene.renderTranslucent();
        // Lightning LAST of the world's own passes: a bolt is additive and depth-TESTS
        // (a cliff in front of it hides it) but writes no depth, so it must come after the
        // units it arcs between rather than punching a hole in them.
        this.renderLightning(fogScene.camera);
      } else {
        // Map not fully ready — fall back to the stock all-in-one path. Depth-test (depthMask
        // off) keeps units in front of both shadow passes even when drawn late.
        this.viewer.render();
        if (this.shadows && fogScene) this.shadows.render(fogScene.camera.viewProjectionMatrix);
        if (this.splats && fogScene) this.splats.render(fogScene.camera.viewProjectionMatrix);
        if (this.buildingShadows && fogScene) this.buildingShadows.render(fogScene.camera.viewProjectionMatrix);
        if (this.ringSplats && fogScene) this.ringSplats.render(fogScene.camera.viewProjectionMatrix);
        if (fogScene) this.renderLightning(fogScene.camera);
      }
      if (this.fog && fogScene) this.fog.render(fogScene.camera.viewProjectionMatrix);
      // Weather LAST of the world passes — after the fog-of-war veil, because rain and snow
      // fall between the eye and the world rather than being part of it: WC3 shows you the
      // storm over ground you have never explored. Not paused with the sim (the weather keeps
      // blowing while the game is paused, as it does in the real client) — it advances on the
      // RENDER clock.
      if (this.weather && fogScene) {
        const cam = fogScene.camera;
        // `dt` in this loop is MILLISECONDS (see portraitWarmAccum > 2000); the emitter's
        // lifespans/velocities come out of Weather.slk in SECONDS. Feeding it milliseconds
        // made every particle outlive its lifespan on its very first frame and respawn on
        // the spot — a field of age-0 particles, re-randomised each frame, that looked like
        // falling snow in a still screenshot and never actually moved.
        this.weather.update(dt / 1000, { targetX: this.target[0], targetY: this.target[1], distance: this.distance });
        this.weather.render(cam.viewProjectionMatrix, cam.location, cam.directionX, cam.directionY);
      }
      // Building-placement footprint grid (green = buildable, red = obstructed) — drawn
      // over the world while a build is being positioned so the player sees the pathing
      // collider and which cells block the site. Reuses the debug-collider overlay pass.
      if (this.placement && this.placeCellVerts > 0 && fogScene) {
        this.debug ??= new DebugColliders(this.viewer.gl);
        this.debug.render(fogScene.camera.viewProjectionMatrix, [{ data: this.placeCells, verts: this.placeCellVerts, mode: "tri" }]);
      }
      if (this.showColliders && fogScene) this.renderColliders(fogScene.camera.viewProjectionMatrix, dt);
      if (this.showPathing && fogScene) this.renderPathing(fogScene.camera.viewProjectionMatrix, dt);
      if (this.showRegions && fogScene) this.renderRegions(fogScene.camera.viewProjectionMatrix);
      // The script's on-screen output (7.19) — floating text projected onto this frame's
      // camera, plus the leaderboard/dialog panels. After the world is drawn: it's DOM.
      this.updateFloatingText();
      this.updateScriptUi();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
    this.bgPump?.terminate();
    this.bgPump = null;
    this.rts?.pause();
    this.metrics.hide();
    this.hud?.hide();
    this.portraitViewer?.stop();
    document.body.classList.remove("reticle-on", "armed-on"); // restore the OS/WC3 cursor
    this.hideCursorOverlay();
    this.updateCarriedItem(-1, 0, 0); // never leave an item stuck to the cursor
  }

  /** Leave the match: put back everything it touched, and release the viewer's blob URLs.
   *
   *  The rule this exists to enforce: **nothing a match put on the page may outlive it.** A
   *  MapViewerScene is thrown away on the way to the menu and a fresh one is built for the
   *  next game (main.ts `exitToMenu`), so its own fields take care of themselves — but the
   *  surfaces it wrote to do NOT belong to it. `document.body`'s classes, the `#ui` and
   *  `#map` elements, `window`'s listeners, the world layer, the shared SoundBoard: all of
   *  them are the page's, and all of them are still there when the main menu comes back.
   *
   *  What that looked like before this swept them: quitting mid-cinematic left the letterbox
   *  bars, the transmission panel and the fade filter painted over the main menu, with
   *  `cine-on` still on the body so the menu had no cursor. */
  dispose(): void {
    this.disposed = true;
    this.stop();
    // The listeners first: they are the only leak that would keep FIRING — every keydown
    // handler a dead match left on `window` still answers keys typed at the main menu.
    for (const off of this.detachers) off();
    this.detachers = [];
    this.rts?.dispose();
    this.rts = null;
    this.clock?.dispose();
    this.clock = null;
    this.splats?.dispose();
    this.splats = null;
    this.ringSplats?.dispose();
    this.ringSplats = null;
    this.ringKeys.clear();
    this.shadows?.dispose();
    this.shadows = null;
    this.buildingShadows?.dispose();
    this.buildingShadows = null;
    this.terrainShadows?.dispose();
    this.terrainShadows = null;
    this.simBuildingSplats.clear();
    this.liftedSplats.clear();
    this.mapBuildingSplats.clear();
    this.debug?.dispose();
    this.debug = null;
    this.pathGridLayer?.dispose();
    this.pathBlockedLayer?.dispose();
    this.pathRouteLayer?.dispose();
    this.pathGridLayer = this.pathBlockedLayer = this.pathRouteLayer = null;
    this.dbgGridFor = null;
    this.regionLayer?.dispose();
    this.regionFillLayer?.dispose();
    this.regionLayer = this.regionFillLayer = null;
    this.regionGeomFor = null;
    this.regionCache = [];
    this.regionLabelBox?.remove();
    this.regionLabelBox = null;
    this.regionLabelPool = [];
    this.metrics.dispose();
    this.hud?.dispose();
    this.hud = null;
    // The script's on-screen output (7.19) — its DOM outlives the canvas otherwise.
    this.textTags?.dispose();
    this.textTags = null;
    this.combatText.clear();
    this.leaderboard?.dispose();
    this.multiboard?.dispose();
    this.multiboard = null;
    this.weather?.dispose();
    this.weather = null;
    this.leaderboard = null;
    this.timerDialogs?.dispose();
    this.timerDialogs = null;
    this.dialog?.dispose();
    this.dialog = null;
    // The cinematic surface (7.24) — the one piece mountScriptUi tore down at the START of
    // the next match but nothing tore down at the END of this one, so a game quit mid-cutscene
    // handed the main menu a letterbox, a transmission panel and a fade to sit behind.
    this.cinematic?.dispose();
    this.cinematic = null;
    this.cinePortraitViewer?.dispose();
    this.cinePortraitViewer = null;
    this.portraitViewer?.dispose();
    this.portraitViewer = null;
    // …and the body classes the cinematic drove. `cine-on` hides the cursor outright, so
    // left standing it is not a cosmetic leak: the menu you land on has no mouse pointer.
    document.body.classList.remove("cine-on", "dialog-on");
    this.interfaceShown = true;
    this.userUi = true;
    this.userControl = true;
    this.mapScript = null;
    // The SoundBoard is shared with the menu, so this map's archive comes back off it with
    // everything else this map brought (see mountMap).
    this.sounds?.mountMap(null);
    this.registry.clearCustom(); // drop this map's custom object data
    this.abilities.clearCustom();
    this.items.clearCustom();
    this.gameMenu?.dispose();
    this.gameMenu = null;
    this.allies?.dispose();
    this.allies = null;
    this.chatDialog?.dispose();
    this.chatDialog = null;
    this.questLog?.dispose();
    this.questLog = null;
    this.consoleUi?.dispose();
    this.consoleUi = null;
    this.matchOver?.dispose();
    this.matchOver = null;
    this.paused = false;
    this.ghost?.remove();
    this.ghost = null;
    this.selectBoxEl?.remove();
    this.selectBoxEl = null;
    this.reticleEl?.remove();
    this.reticleEl = null;
    this.carryEl?.remove();
    this.carryEl = null;
    this.cursorStyleEl?.remove();
    this.cursorStyleEl = null;
    for (const g of this.buildGhosts.values()) g.hide();
    this.buildGhosts.clear();
    this.buildGhost = null;
    this.clearPendingGhosts();
    for (const a of this.orderArrows) a.inst.detach();
    this.orderArrows = [];
    for (const e of this.effects) e.inst.detach();
    this.effects = [];
    this.effectModels.clear();
    this.lightning?.clear(); // bolts hold unit ids the next match will reuse
    for (const inst of this.projectileInsts.values()) inst.detach();
    this.projectileInsts.clear();
    this.projectileLoading.clear();
    this.projectileModels.clear();
    for (const rig of this.bloodMageSpheres.values()) this.destroySphereRig(rig);
    this.bloodMageSpheres.clear();
    this.bloodMageSpheresLoading.clear();
    this.placement = null;
    this.buildSpawning.clear();
    this.buildWait.clear();
    this.cursorSheet = null;
    this.reticleUrls.clear();
    this.handUrls.clear();
    this.disposeFog(); // the veil mesh and its GL texture — loadMap dropped these, exit didn't
    document.body.classList.remove("reticle-on", "armed-on", "carrying-item");
    document.body.style.cursor = ""; // restore the default cursor off the map
    // The last three things the match wrote to the PAGE rather than to itself: the edge-scroll
    // arrow and the world-anchored overlay layer, both parented to `document.body`, and the
    // audio — the SoundBoard is the page's and survives, so the match's beds, voices, script
    // handles and map music have to be told to stop (see SoundBoard.endMatch).
    this.scrollArrow?.remove();
    this.scrollArrow = null;
    disposeWorldLayer();
    this.sounds?.endMatch();
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
  }

  /** Build the fog-of-war overlay once the map + sim exist, priming it from the
   *  starting vision so the first frame isn't a full-screen black flash. */
  private ensureFog(): void {
    if (this.fog || !this.rts || !this.viewer.map || !this.fogTerrain) return;
    // Build the fog mesh on the terrain's own corner grid so it's coplanar with the
    // rendered terrain (see FogOverlay) — the fix for fog dropping out on cliffs/slopes.
    this.fog = new FogOverlay(this.viewer.gl, this.fogTerrain);
    this.fog.update(this.rts.getVision());
    // Hand the fog mask to the viewer's patched cliff shader so cliff FACES dim with
    // the fog like the ground (our veil mesh can't cover their overhang). The texture
    // object + params are stable; its contents refresh in FogOverlay.update().
    const cliffFog = this.viewer.map as unknown as { fogTexture?: WebGLTexture; fogParams?: Float32Array };
    cliffFog.fogTexture = this.fog.fogTexture;
    cliffFog.fogParams = this.fog.fogParams;
  }

  /** Resample the fog mask and re-fog the map's widgets. */
  private updateFog(): void {
    if (!this.fog || !this.rts) return;
    const vision = this.rts.getVision();
    this.fog.update(vision);
    this.fogWidgets(vision);
    this.fogItems(vision);
  }

  /** Conceal ground items outside current sight. Unlike buildings (which persist in
   *  explored fog as greyed memory), WC3 hides dropped items whenever the area isn't
   *  currently visible and re-shows them the instant vision returns — so this is a hard
   *  show/hide on live visibility, not a tint. */
  private fogItems(vision: VisionMap): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    for (const [id, inst] of this.itemInstances) {
      const it = world.items.get(id);
      if (!it) continue;
      const visible = vision.revealed || vision.stateAt(it.x, it.y) === FogState.Visible;
      if (visible) inst.show();
      else inst.hide();
    }
  }

  // Explored (remembered-but-not-seen) props are shown at half brightness, matching
  // the ground veil's grey (EXPLORED_DARK 0.5 → 1 - 0.5). In sight = full colour.
  private static readonly FOG_EXPLORED_BRIGHT = 0.5;

  /** Fog-of-war for the map's DOODADS and static units (trees, props, structures,
   *  gold mines). The flat ground veil can't darken tall geometry — it pokes above the
   *  sheet — so we tint each model by the fog at its base: full colour in sight, dimmed
   *  grey once explored (terrain memory), hidden while unexplored. This also makes trees
   *  behind a treeline vanish (the treeline blocks their sight in the vision grid), the
   *  way WC3 hides forest interiors. Iterated in full each tick (a few thousand widgets,
   *  cheap) so props that stream in async are already fogged and re-brighten on sight. */
  // All shadow textures live here (unitUI.slk `unitShadow`/`buildingShadow` name the stem).
  private static readonly SHADOW_DIR = "ReplaceableTextures\\Shadows\\";

  /** Rebuild this frame's shadow batch: one soft decal per VISIBLE unit, painted on the
   *  terrain by ShadowOverlay. Mobile units use a blob sized/offset straight from their
   *  UnitDef shadow data (unitUI.slk `unitShadow` + shadowW/H/X/Y); BUILDINGS use their
   *  baked `buildingShadow` texture stretched over their pathing footprint (no size field
   *  exists, so the footprint is the size), centred and given the same top-right cast;
   *  ground ITEMS all share one global blob from MiscData (see below).
   *  Corpses and fogged/mined units are skipped — a fogged enemy's shadow must not reveal
   *  it. Cheap: a beginFrame + one small tessellation per unit, all drawn later in ~one
   *  call per shadow texture. */
  private updateShadowBatch(): void {
    const world = this.rts?.simWorld;
    if (!this.shadows || !this.buildingShadows || !world) return;
    this.shadows.beginFrame();
    this.buildingShadows.beginFrame();
    this.addItemShadows(world);
    for (const u of world.units.values()) {
      if (u.hp <= 0) continue; // corpses cast no shadow
      const def = this.registry.get(u.typeId);
      if (!def) continue;
      if (this.rts!.unitHidden(u.id)) continue; // fogged / in a gold mine — don't draw its shadow
      if (u.building) {
        // Building: baked shadow texture stretched over the footprint (≈ its ground size),
        // into the SEPARATE overlay that draws after the foundation decals.
        if (!def.buildingShadow || !def.pathTex) continue;
        const fp = this.footprintFor(def.pathTex);
        if (!fp) continue;
        // Centre the quad on the footprint (shadowX/Y = half-size) so only DIR_PUSH offsets
        // it; the texture's own baked shape carries the cast direction.
        const w = fp.w * PATHING_CELL * MapViewerScene.BUILDING_SHADOW_SCALE;
        const h = fp.h * PATHING_CELL * MapViewerScene.BUILDING_SHADOW_SCALE;
        this.buildingShadows.add(u.x, u.y, w, h, w / 2, h / 2, MapViewerScene.SHADOW_DIR + def.buildingShadow + ".blp");
        continue;
      }
      if (!def.unitShadow || def.shadowW <= 0 || def.shadowH <= 0) continue;
      this.shadows.add(u.x, u.y, def.shadowW, def.shadowH, def.shadowX, def.shadowY, MapViewerScene.SHADOW_DIR + def.unitShadow + ".blp");
    }
  }

  /** Ground items cast a shadow too (issue #60) — the chest/tome/rune sitting in the
   *  grass was the one widget class floating without one. An item has no shadow columns
   *  of its own (Units\ItemData.slk has none): the engine gives EVERY item the same blob
   *  from `Units\MiscData.txt` — `ItemShadowFile=Shadow`, `ItemShadowSize=120,120`,
   *  `ItemShadowOffset=50,50` — so they all batch into the unit overlay's one draw call.
   *  Fog-gated on LIVE sight exactly like the item's model (see fogItems): an item in the
   *  dark is hidden outright, and its shadow must not give it away. */
  private addItemShadows(world: SimWorld): void {
    if (!this.shadows || !world.items.size) return;
    const vision = this.rts?.getVision();
    const [w, h] = MISC_DATA.ItemShadowSize;
    const [ox, oy] = MISC_DATA.ItemShadowOffset;
    const texture = MapViewerScene.SHADOW_DIR + MISC_DATA.ItemShadowFile + ".blp";
    for (const it of world.items.values()) {
      if (vision && !vision.revealed && vision.stateAt(it.x, it.y) !== FogState.Visible) continue;
      this.shadows.add(it.x, it.y, w, h, ox, oy, texture);
    }
  }
  // Building shadows have no size field in the data (unlike units' shadowW/H), so we size
  // them from the pathing footprint and stretch a touch past the base — tuned live.
  private static readonly BUILDING_SHADOW_SCALE = 1.25;

  private fogWidgets(vision: VisionMap): void {
    const map = this.viewer.map;
    if (!map) return;
    // Trees mid harvest-blink own their colour this frame (see updateTreePulses) — the
    // blink runs every frame while our tint runs at ~10Hz, so skip them or we'd fight it.
    const pulsing = this.treePulses.length
      ? new Set(this.treePulses.map((p) => p.inst as unknown as HideableWidget["instance"]))
      : null;
    const tint = (w: HideableWidget): void => {
      const inst = w.instance;
      if (pulsing && pulsing.has(inst)) return;
      if (this.aoeTreeInsts.has(inst)) return; // green AoE-target tree owns its colour this frame
      const loc = inst.localLocation;
      // Light a prop from the BRIGHTEST cell of its footprint, not the one cell holding
      // its origin. A tree blocks sight on every cell it covers, so a 4×4 tree shadows
      // its own back half — and its origin sits exactly where its four cells meet, so
      // the floor() in worldToCell often landed on a self-shadowed one and drew a
      // front-line tree as explored-grey (#43). Props with no footprint use their cell.
      const state = vision.bestStateAt(loc[0], loc[1], this.treeFogRadius.get(fogKey(loc[0], loc[1])) ?? 0);
      if (state === FogState.Unexplored) {
        if (inst.rendered === false) return; // already dark — nothing to do
        inst.hide(); // never seen — don't even hint at what's there
        return;
      }
      const b = state === FogState.Visible ? 1 : MapViewerScene.FOG_EXPLORED_BRIGHT;
      const base = this.widgetBase(inst);
      const r = base[0] * b, g = base[1] * b, bl = base[2] * b, a = base[3];
      // Already wearing exactly this? Then leave it alone.
      //
      // A widget's fog state almost never changes from one pass to the next, and this pass
      // walks EVERY widget the map laid down — 4,345 doodads on Extreme Candy War — ten times
      // a second. Re-applying an identical tint is not free: `setVertexColor` dirties the
      // instance for the next batch update, and `show()` churns the scene's render flags with
      // it. Skipping the unchanged ones is what takes this pass off the frame budget.
      //
      // The test reads the instance's CURRENT colour rather than trusting a note of what we
      // last wrote, which makes it self-healing: a tree mid harvest-blink or lit green as a
      // spell's target has had its colour taken over by something else (both are skipped
      // above — but only while they are running), and it must be re-tinted when it comes back
      // rather than left wearing the effect's colour forever.
      const cur = inst.vertexColor;
      if (inst.rendered !== false && cur && cur[0] === r && cur[1] === g && cur[2] === bl && cur[3] === a) return;
      const s = this.tintScratch;
      s[0] = r; s[1] = g; s[2] = bl; s[3] = a;
      inst.setVertexColor?.(s);
      inst.show();
    };
    for (const w of map.doodads) {
      this.mapProps.add(w.instance); // …and claimed, so the sweep below leaves it to us
      // A doodad that has a STAND-IN is drawn by the stand-in, full stop.
      //
      // `removedWidgets` says the same thing for the ones we retired, and it is what this
      // used to ask alone — but it is bookkeeping, a Set that has to be kept in step with the
      // world, and the state a player caught it in says it can fall out of step: a destroyed
      // elven gate on Rise of the Naga, its stand-in correctly dead and holding the last frame
      // of `death`, and its STATIC doodad drawn over the top of it, door and all. I could not
      // reproduce that in a harness, so rather than guess which of the two ways it drifts,
      // this asks the thing that cannot drift. `doodadActors` HAS the widget precisely because
      // `doodadActor()` hid its static and put an animated copy in its place, so a member of
      // that map must never be shown again by this pass — whatever the Set thinks.
      if (this.removedWidgets.has(w) || this.doodadActors.has(w)) continue; // felled trees, open gates
      tint(w);
    }
    const units = map.units as unknown as Array<HideableWidget & { row?: unknown }>;
    for (const w of units) {
      this.mapProps.add(w.instance);
      if (this.removedWidgets.has(w)) continue; // mined-out gold mines stay gone
      if (!w.row) continue; // start-location markers (rowless) are hidden for good — see hideStartLocations
      if (this.rts?.managesViewerInstance(w.instance)) continue; // RTS fog-hides creeps/shops
      tint(w);
    }
    this.fogSpawnedInstances(vision);
  }

  /** Instances the two loops above have claimed — the map's own props and units. Everything
   *  else in the scene belongs to the sweep below. A WeakSet, so an instance the viewer drops
   *  takes its entry with it. */
  private readonly mapProps = new WeakSet<object>();
  /** Instances THIS pass hid, and the only ones it will ever show again (see the sweep). */
  private readonly fogHiddenInsts = new Set<HideableWidget["instance"]>();

  /**
   * **The catch-all: nothing we put in the world escapes the darkness.**
   *
   * The two loops above cover what the map file laid down. They are not the whole world — we
   * spawn scene instances of our own all over the place, and every one of them was drawing
   * through pitch-black unexplored ground: a felled tree's animated stand-in (doodadActor), a
   * gate swung open, a building's ubersplat FX, a buff's particles, a projectile mid-flight, a
   * spell's effect model. Rather than remember to fog each new one, this sweeps the scene
   * itself, so anything added later is covered by construction.
   *
   * Two rules keep it from fighting the code that owns those instances:
   *
   *  • **It only ever re-shows what it hid itself.** An instance its owner has already hidden
   *    (a finished effect, a worker inside a mine, a unit the RTS is fogging by its own
   *    stricter rule) is never recorded, so the sweep cannot hand it back. Without that, a
   *    unit the RTS had hidden would pop into view the moment its ground became explored and
   *    stay there — the RTS's own hide is edge-triggered and would not fire again.
   *  • **It hides, it does not tint.** The explored-grey dimming above multiplies a widget's
   *    remembered base colour; effects animate their own colour and a projectile has no
   *    business being dimmed. Unexplored is the bug; grey is a nicety.
   */
  private fogSpawnedInstances(vision: VisionMap): void {
    const scene = this.viewer.map?.worldScene as unknown as { grid?: { cells?: Array<{ instances?: HideableWidget["instance"][] }> } } | undefined;
    const cells = scene?.grid?.cells;
    if (!cells) return;
    for (const cell of cells) {
      for (const inst of cell.instances ?? []) {
        if (this.mapProps.has(inst)) continue; // the map's own — handled above, with its tint
        if (this.rts?.managesViewerInstance(inst)) continue; // adopted map unit: the RTS's rule
        const loc = inst.localLocation;
        if (!loc) continue;
        if (vision.bestStateAt(loc[0], loc[1], 0) === FogState.Unexplored) {
          // `rendered` is the viewer's own "is this drawn" flag (hide() clears it). Recording
          // only the ones we actually turned off is what makes the re-show safe.
          if (inst.rendered !== false) {
            inst.hide();
            this.fogHiddenInsts.add(inst);
          }
        } else if (this.fogHiddenInsts.delete(inst)) {
          inst.show();
        }
      }
    }
  }

  /** Each widget's ORIGINAL tint (unit/player colour, else white), captured the first
   *  time we fog it — so fog dimming multiplies the base instead of clobbering it. */
  private widgetBase(inst: HideableWidget["instance"]): Float32Array {
    let base = this.baseColors.get(inst);
    if (!base) {
      const c = inst.vertexColor;
      base = c ? new Float32Array([c[0], c[1], c[2], c[3]]) : new Float32Array([1, 1, 1, 1]);
      this.baseColors.set(inst, base);
    }
    return base;
  }

  /** Draw the debug collider overlay. Static geometry (pathing/vision cells + tree
   *  click-rings) is rebuilt a few times a second; the moving unit rings every frame. */
  private renderColliders(viewProj: Float32Array, dt: number): void {
    if (!this.debug) this.debug = new DebugColliders(this.viewer.gl);
    this.dbgStaticAccum += dt;
    if (this.dbgStaticAccum >= 250) {
      this.dbgStaticAccum = 0;
      this.rebuildStaticColliders();
    }
    this.rebuildUnitColliders();
    const batches: ColliderBatch[] = [
      { data: this.dbgCells, verts: this.dbgCellVerts, mode: "tri" },
      { data: this.dbgTreeRings, verts: this.dbgTreeVerts, mode: "line" },
      { data: this.dbgUnitRings, verts: this.dbgUnitVerts, mode: "line" },
    ];
    this.debug.render(viewProj, batches);
  }

  /** Rebuild pathing-blocked cells + LOS-blocker cells (filled quads) and tree
   *  click-rings (lines) — the parts that only change when buildings go up or trees fall. */
  private rebuildStaticColliders(): void {
    const h = this.heightSampler;
    if (!h) return;
    const cells: number[] = [];
    const grid = this.grid;
    if (grid) {
      const [ox, oy] = grid.origin;
      for (let cy = 0; cy < grid.height; cy++) {
        for (let cx = 0; cx < grid.width; cx++) {
          if (grid.walkable(cx, cy)) continue;
          // Draw only the BORDER of unwalkable regions (a cell touching walkable ground):
          // small object footprints (buildings, trees, mines) fill solid, but a huge
          // water/boundary region shows as a thin coastline instead of a red flood.
          if (grid.walkable(cx - 1, cy) || grid.walkable(cx + 1, cy) || grid.walkable(cx, cy - 1) || grid.walkable(cx, cy + 1)) {
            const x0 = ox + cx * PATHING_CELL, y0 = oy + cy * PATHING_CELL;
            pushColliderQuad(cells, x0, y0, x0 + PATHING_CELL, y0 + PATHING_CELL, h, COLLIDER_COLORS.pathing);
          }
        }
      }
    }
    const vis = this.rts?.getVision();
    if (vis) {
      for (let cy = 0; cy < vis.height; cy++) {
        for (let cx = 0; cx < vis.width; cx++) {
          if (!vis.isBlocker(cx, cy)) continue;
          const x0 = vis.originX + cx * VISION_CELL, y0 = vis.originY + cy * VISION_CELL;
          pushColliderQuad(cells, x0, y0, x0 + VISION_CELL, y0 + VISION_CELL, h, COLLIDER_COLORS.vision);
        }
      }
    }
    this.dbgCells = Float32Array.from(cells);
    this.dbgCellVerts = cells.length / FLOATS_PER_VERT;

    const rings: number[] = [];
    const world = this.rts?.simWorld;
    if (world) for (const tr of world.trees.values()) pushColliderRing(rings, tr.x, tr.y, h(tr.x, tr.y), TREE_CLICK_RADIUS, COLLIDER_COLORS.click, 8);
    this.dbgTreeRings = Float32Array.from(rings);
    this.dbgTreeVerts = rings.length / FLOATS_PER_VERT;
  }

  /** Rebuild the moving unit/building click rings (green) — every frame. */
  private rebuildUnitColliders(): void {
    const rings: number[] = [];
    for (const c of this.rts?.debugUnitColliders() ?? []) {
      pushColliderRing(rings, c.x, c.y, c.z, c.radius, COLLIDER_COLORS.click, c.building ? 24 : 16);
    }
    // Ground items expose a click/selection radius too — draw it green like a unit's so
    // it's clear how large (or small, vs a nearby gold mine) an item's pickable area is.
    for (const c of this.rts?.debugItemColliders() ?? []) {
      pushColliderRing(rings, c.x, c.y, c.z, c.radius, COLLIDER_COLORS.click, 16);
    }
    this.dbgUnitRings = Float32Array.from(rings);
    this.dbgUnitVerts = rings.length / FLOATS_PER_VERT;
  }

  /** Draw the "Show Pathing" overlay from persistent GPU buffers: the pathing-cell
   *  lattice (static, uploaded once per map), the unwalkable-cell outlines (uploaded
   *  only when trees fall / buildings change), and each moving unit's remaining route
   *  (the one small buffer that re-uploads per frame). No megabyte-per-frame streaming. */
  private renderPathing(viewProj: Float32Array, dt: number): void {
    if (!this.debug) this.debug = new DebugColliders(this.viewer.gl);
    const gl = this.viewer.gl;
    this.pathGridLayer ??= new OverlayLayer(gl, "line");
    this.pathBlockedLayer ??= new OverlayLayer(gl, "tri");
    this.pathRouteLayer ??= new OverlayLayer(gl, "line", true); // updates every frame
    if (this.dbgGridFor !== this.grid) this.rebuildPathGrid();
    this.dbgBlockAccum += dt;
    if (this.dbgBlockAccum >= 500) {
      this.dbgBlockAccum = 0;
      this.rebuildBlockedCells();
    }
    this.rebuildUnitPaths();
    // Order matters (depth test off): fills first, lattice over them, routes on top.
    this.debug.renderLayers(viewProj, [this.pathBlockedLayer, this.pathGridLayer, this.pathRouteLayer]);
  }

  /** Build the pathing-cell lattice (terrain-hugging boundary lines) into its
   *  persistent buffer. The grid is fixed for the life of a map, so this runs once
   *  (keyed on grid identity). Very large grids drop to a coarser step so the buffer
   *  (and its per-frame draw) stay bounded. */
  private rebuildPathGrid(): void {
    const h = this.heightSampler;
    const grid = this.grid;
    this.dbgGridFor = grid;
    if (!h || !grid || !this.pathGridLayer) {
      this.pathGridLayer?.set(EMPTY_VERTS, 0);
      return;
    }
    const [ox, oy] = grid.origin;
    const W = grid.width, H = grid.height;
    // Full cell resolution on all real maps (a 768² grid = 2.4M verts draws at ~140fps
    // from the persistent buffer); only an enormous custom grid coarsens, to cap the
    // buffer/draw. sqrt keeps the *linear* cell spacing roughly constant when it does.
    const step = Math.max(1, Math.round(Math.sqrt((W * H) / 1_200_000)));
    const c = COLLIDER_COLORS.grid;
    const v: number[] = [];
    const lift = COLLIDER_LIFT;
    for (let cy = 0; cy <= H; cy += step) {
      const y = oy + cy * PATHING_CELL;
      for (let cx = 0; cx < W; cx++) {
        const x0 = ox + cx * PATHING_CELL, x1 = x0 + PATHING_CELL;
        pushColliderVert(v, x0, y, h(x0, y) + lift, c);
        pushColliderVert(v, x1, y, h(x1, y) + lift, c);
      }
    }
    for (let cx = 0; cx <= W; cx += step) {
      const x = ox + cx * PATHING_CELL;
      for (let cy = 0; cy < H; cy++) {
        const y0 = oy + cy * PATHING_CELL, y1 = y0 + PATHING_CELL;
        pushColliderVert(v, x, y0, h(x, y0) + lift, c);
        pushColliderVert(v, x, y1, h(x, y1) + lift, c);
      }
    }
    this.pathGridLayer.set(Float32Array.from(v), v.length / FLOATS_PER_VERT);
  }

  /** Outline the unwalkable region(s) into the blocked layer's persistent buffer. Only
   *  cells on the BORDER (touching walkable ground) are drawn — a solid fill of a whole
   *  water/out-of-bounds region is hundreds of thousands of quads; the coastline is a
   *  few thousand, and the lattice already shows the interior cells. */
  private rebuildBlockedCells(): void {
    const h = this.heightSampler;
    const grid = this.grid;
    if (!h || !grid || !this.pathBlockedLayer) {
      this.pathBlockedLayer?.set(EMPTY_VERTS, 0);
      return;
    }
    const [ox, oy] = grid.origin;
    const cells: number[] = [];
    for (let cy = 0; cy < grid.height; cy++) {
      for (let cx = 0; cx < grid.width; cx++) {
        if (grid.walkable(cx, cy)) continue;
        if (!(grid.walkable(cx - 1, cy) || grid.walkable(cx + 1, cy) || grid.walkable(cx, cy - 1) || grid.walkable(cx, cy + 1))) continue;
        const x0 = ox + cx * PATHING_CELL, y0 = oy + cy * PATHING_CELL;
        pushColliderQuad(cells, x0, y0, x0 + PATHING_CELL, y0 + PATHING_CELL, h, COLLIDER_COLORS.blocked);
      }
    }
    this.pathBlockedLayer.set(Float32Array.from(cells), cells.length / FLOATS_PER_VERT);
  }

  /** Rebuild the moving-unit route polylines + waypoint markers into the route
   *  layer — every frame, but this is tiny (a handful of moving units). */
  private rebuildUnitPaths(): void {
    const h = this.heightSampler;
    const paths = this.rts?.debugUnitPaths();
    if (!h || !paths || !this.pathRouteLayer) {
      this.pathRouteLayer?.set(EMPTY_VERTS, 0);
      return;
    }
    const v: number[] = [];
    const c = COLLIDER_COLORS.path;
    for (const pts of paths) {
      pushPathPolyline(v, pts, h, c);
      // Ring each waypoint the unit still has to reach (pts[0] is its live position);
      // the final destination gets a bigger ring.
      for (let i = 1; i < pts.length; i++) {
        const last = i === pts.length - 1;
        pushColliderRing(v, pts[i][0], pts[i][1], h(pts[i][0], pts[i][1]), last ? 16 : 7, c, last ? 14 : 6);
      }
    }
    this.pathRouteLayer.set(Float32Array.from(v), v.length / FLOATS_PER_VERT);
  }

  /** Draw the "Show Regions" overlay: outline every named trigger region (gg_rct_*)
   *  on the terrain and float its name label inside it. The rects come from the
   *  running map script (CreateRegions ran in main() — Phase 7). Outlines are static
   *  GPU geometry rebuilt once per map; labels re-project each frame (camera moves). */
  private renderRegions(viewProj: Float32Array): void {
    if (!this.mapScript) return;
    const gl = this.viewer.gl;
    this.debug ??= new DebugColliders(this.viewer.gl);
    this.regionLayer ??= new OverlayLayer(gl, "line");
    this.regionFillLayer ??= new OverlayLayer(gl, "tri");
    if (this.regionGeomFor !== this.mapScript) this.rebuildRegions();
    this.debug.renderLayers(viewProj, [this.regionFillLayer, this.regionLayer]);
    this.updateRegionLabels(viewProj);
  }

  /** Collect the map's named regions from the interpreter (gg_rct_* → rect bounds),
   *  build the outline (line) + faint-fill (tri) geometry that hugs the terrain, and
   *  cache each region's centre for its label. Runs once per map (cache-keyed). */
  private rebuildRegions(): void {
    this.regionGeomFor = this.mapScript;
    this.regionCache = [];
    const h = this.heightSampler;
    const interp = this.mapScript?.interp;
    if (!h || !interp || !this.regionLayer || !this.regionFillLayer) {
      this.regionLayer?.set(EMPTY_VERTS, 0);
      this.regionFillLayer?.set(EMPTY_VERTS, 0);
      return;
    }
    const lines: number[] = [];
    const fills: number[] = [];
    const lift = COLLIDER_LIFT;
    const outline = REGION_COLORS.outline;
    const fill = REGION_COLORS.fill;
    for (const [name, val] of interp.rt.globals) {
      if (!name.startsWith("gg_rct_") || val.k !== "handle") continue;
      const r = interp.rt.handles.get(val.h) as RectObj | undefined;
      if (!r || typeof r.minx !== "number" || typeof r.maxx !== "number") continue;
      // Terrain-hugging outline: walk each edge in steps sampling ground height, so
      // the border follows slopes instead of clipping through a hill.
      const step = Math.max(64, Math.min(256, (r.maxx - r.minx) / 6 || 128));
      const seg = (x0: number, y0: number, x1: number, y1: number): void => {
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
        for (let i = 0; i < n; i++) {
          const ax = x0 + ((x1 - x0) * i) / n, ay = y0 + ((y1 - y0) * i) / n;
          const bx = x0 + ((x1 - x0) * (i + 1)) / n, by = y0 + ((y1 - y0) * (i + 1)) / n;
          pushColliderVert(lines, ax, ay, h(ax, ay) + lift, outline);
          pushColliderVert(lines, bx, by, h(bx, by) + lift, outline);
        }
      };
      seg(r.minx, r.miny, r.maxx, r.miny);
      seg(r.maxx, r.miny, r.maxx, r.maxy);
      seg(r.maxx, r.maxy, r.minx, r.maxy);
      seg(r.minx, r.maxy, r.minx, r.miny);
      pushColliderQuad(fills, r.minx, r.miny, r.maxx, r.maxy, h, fill);
      const cx = (r.minx + r.maxx) / 2, cy = (r.miny + r.maxy) / 2;
      this.regionCache.push({ name: name.slice("gg_rct_".length), cx, cy, cz: h(cx, cy) + lift });
    }
    this.regionLayer.set(Float32Array.from(lines), lines.length / FLOATS_PER_VERT);
    this.regionFillLayer.set(Float32Array.from(fills), fills.length / FLOATS_PER_VERT);
  }

  /** Position (or hide) a floating DOM label at each region's projected centre. A
   *  pooled `<div>` per region, reused frame-to-frame; labels behind the camera or
   *  off-screen are hidden. */
  private updateRegionLabels(viewProj: Float32Array): void {
    if (!this.regionLabelBox) {
      const box = document.createElement("div");
      box.className = "region-labels";
      (document.getElementById("ui") ?? document.body).appendChild(box);
      this.regionLabelBox = box;
    }
    const rect = this.canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    for (let i = 0; i < this.regionCache.length; i++) {
      const reg = this.regionCache[i];
      let el = this.regionLabelPool[i];
      if (!el) {
        el = document.createElement("div");
        el.className = "region-label";
        this.regionLabelBox.appendChild(el);
        this.regionLabelPool[i] = el;
      }
      const p = projectToScreen(viewProj, reg.cx, reg.cy, reg.cz, W, H);
      if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) {
        el.style.display = "none";
        continue;
      }
      if (el.textContent !== reg.name) el.textContent = reg.name;
      el.style.display = "";
      el.style.left = `${rect.left + p[0]}px`;
      el.style.top = `${rect.top + p[1]}px`;
    }
    // Hide any pooled labels beyond the current region count (map changed).
    for (let i = this.regionCache.length; i < this.regionLabelPool.length; i++) this.regionLabelPool[i].style.display = "none";
  }

  /** Hide every region label (overlay turned off / match torn down). */
  private hideRegionLabels(): void {
    for (const el of this.regionLabelPool) el.style.display = "none";
  }

  private disposeFog(): void {
    this.fog?.dispose();
    this.fog = null;
    this.fogTerrain = null;
    this.removedWidgets.clear();
    this.baseColors = new WeakMap();
    this.fogAccum = 0;
  }

  private updateCamera(dtMs = 1000 / 60): void {
    this.syncFrame(); // one layout read a frame — the pointer handlers convert against it
    const scene = this.viewer.map?.worldScene;
    if (!scene) return;

    // Portrait held: keep the camera locked onto the selected unit as it moves.
    if (this.cameraLock) {
      const pos = this.rts?.selectedPosition();
      if (pos) {
        this.target[0] = pos[0];
        this.target[1] = pos[1];
      } else {
        this.cameraLock = false;
      }
    }

    this.followHeld(); // a held hero key / group digit: ride the selection (issue #114)

    // Pan the ground target relative to view yaw. WASD only outside a match —
    // in-game the letters belong to command hotkeys (M/A/S), WC3 pans with
    // the arrow keys. Under EnableUserControl(false) — cinematic mode — the player has no
    // camera at all: the script owns it, and an arrow key must not fight the shot.
    const letters = !this.hud;
    const speed = this.distance * 0.9 * (1 / 60);
    const fwd: [number, number] = [Math.cos(this.yaw), Math.sin(this.yaw)];
    const right: [number, number] = [fwd[1], -fwd[0]];
    if (this.userControl) {
      if ((letters && this.keys.has("w")) || this.keys.has("arrowup")) this.pan(fwd, speed);
      if ((letters && this.keys.has("s")) || this.keys.has("arrowdown")) this.pan(fwd, -speed);
      if ((letters && this.keys.has("d")) || this.keys.has("arrowright")) this.pan(right, speed);
      if ((letters && this.keys.has("a")) || this.keys.has("arrowleft")) this.pan(right, -speed);
      this.updateEdgeScroll(fwd, right, speed); // pan when the cursor rests at a screen edge
    } else {
      this.showScrollArrow(0, 0);
    }

    // The wheel's ease and Insert/Delete's rotation — the two things the PLAYER can do to the
    // camera's shape. Before the script block, so a cinematic still wins.
    this.updatePlayerCamera(Math.min(dtMs, 100) / 1000);

    // The map's script drives the same camera (7.24) — a camera setup, a timed pan, a unit
    // to ride, a shake. It runs AFTER the player's input so a cinematic wins, and it lets go
    // of each field the moment that field's blend lands. `dtMs` is MILLISECONDS (the frame
    // loop's clock); every duration in a JASS camera call is SECONDS.
    if (this.scriptCam.active) {
      const cam = this.readCamera();
      this.scriptCam.update(Math.min(dtMs, 100) / 1000, cam, (id) => {
        const u = this.rts?.simView.units.get(id);
        return u ? { x: u.x, y: u.y } : null;
      });
      this.writeCamera(cam);
    }

    // Keep the WebGL backing buffer matched to the on-screen size EVERY frame so
    // the scene keeps its true aspect ratio when the window changes — F11
    // fullscreen, opening/closing devtools, browser zoom or a DPI change (issue
    // #1). The old guard compared the buffer size to the stored viewport (always
    // equal after the first sync), so it never fired on resize and CSS stretched
    // the stale buffer. syncCanvasSize now derives the wanted size from the CSS
    // size and only reallocates on an actual change, so calling it per-frame is
    // cheap.
    syncCanvasSize(this.canvas);
    if (scene.viewport[2] !== this.canvas.width || scene.viewport[3] !== this.canvas.height) {
      scene.viewport[2] = this.canvas.width;
      scene.viewport[3] = this.canvas.height;
    }

    this.clampTarget(); // keep the focus on the map, whatever moved it (pan/edge-scroll/minimap/follow)
    this.followGround(dtMs); // …and on the GROUND, so the view keeps its distance to the terrain
    const cp = Math.cos(this.pitch);
    const eye = new Float32Array([
      this.target[0] - Math.cos(this.yaw) * cp * this.distance,
      this.target[1] - Math.sin(this.yaw) * cp * this.distance,
      this.target[2] + Math.sin(this.pitch) * this.distance,
    ]);
    // CameraSetSourceNoise shakes the EYE without moving what it looks at (target noise, by
    // contrast, is already folded into this.target by scriptCam.update).
    if (this.scriptCam.active) {
      const [sx, sy, sz] = this.scriptCam.eyeShake();
      eye[0] += sx;
      eye[1] += sy;
      eye[2] += sz;
    }
    // FARZ 0 = "the game camera's own rule", which is 8× the focus distance.
    scene.camera.perspective(this.fov, this.aspect(), 16, this.farZ > 0 ? this.farZ : this.distance * 8);
    scene.camera.moveToAndFace(eye, this.target, this.upVector(eye));
    // Drive positional (WANT3D) audio: listener at the ground focus, facing the
    // camera's look direction so on-screen battles pan + attenuate around center.
    this.sounds?.setListener(this.target, eye);
  }

  /** The camera's up axis. World-up, unless CAMERA_FIELD_ROLL has tilted the shot — then it
   *  is world-up rotated about the view axis (Rodrigues, with forward as the axis). Roll is
   *  0 in every bundled map, but it is a real field and a setup that names it must work. */
  private readonly upTmp = new Float32Array([0, 0, 1]);
  private upVector(eye: Float32Array): Float32Array {
    if (!this.roll) return UP;
    const f = [this.target[0] - eye[0], this.target[1] - eye[1], this.target[2] - eye[2]];
    const len = Math.hypot(f[0], f[1], f[2]) || 1;
    f[0] /= len; f[1] /= len; f[2] /= len;
    const c = Math.cos(this.roll), s = Math.sin(this.roll);
    // u' = u·cos + (f × u)·sin + f·(f·u)·(1 − cos), with u = world up (0,0,1).
    const cross = [f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, f[0] * 0 - f[1] * 0];
    const dot = f[2];
    this.upTmp[0] = 0 * c + cross[0] * s + f[0] * dot * (1 - c);
    this.upTmp[1] = 0 * c + cross[1] * s + f[1] * dot * (1 - c);
    this.upTmp[2] = 1 * c + cross[2] * s + f[2] * dot * (1 - c);
    return this.upTmp;
  }

  /** A CAMERA_FIELD_FIELD_OF_VIEW value translated onto the lens we render with.
   *
   *  The field and the lens are different quantities (see GAME_FOV): WC3's default camera SAYS
   *  70 and RENDERS ~32. Every camera object the World Editor writes carries the full field set,
   *  so a map camera that means "an ordinary view" still says 70 — WarChasers' gg_cam_CamStart1
   *  is exactly bj_CAMERA_DEFAULT with the distance nudged, re-applied every 2 s. Honour the 70
   *  literally and that map is stuck zoomed miles out with no escape (the wheel moves the
   *  distance, not the lens).
   *
   *  The translation preserves the FRAMING RATIO — what a field of `f` frames at a given
   *  distance in WC3, ours frames too — so it is done in tan-space, not on the angle:
   *  tan(lens/2) = tan(f/2) · tan(32°/2)/tan(70°/2). The default (70) lands exactly on 32°, and
   *  a map that narrows to a telephoto narrows by the same factor it does in the real game. */
  private static readonly FOV_SCALE =
    Math.tan((MapViewerScene.LENS_FOV_DEG * Math.PI) / 360) / Math.tan((MapViewerScene.WC3_FOV_DEG * Math.PI) / 360);
  private static fovFromWc3(deg: number): number {
    return 2 * Math.atan(Math.tan((clamp(deg, 1, 170) * Math.PI) / 360) * MapViewerScene.FOV_SCALE);
  }

  /** The inverse: the lens reported back on the scale a script speaks, so GetCameraField reads
   *  70 on the default camera exactly as WC3 does, and a tween starts from the right place. */
  private static fovToWc3(rad: number): number {
    return (2 * Math.atan(Math.tan(rad / 2) / MapViewerScene.FOV_SCALE) * 180) / Math.PI;
  }

  /** The live camera in the units the JASS setters speak (degrees for the angles). This and
   *  writeCamera are the whole adapter between our orbit camera and WC3's field model. */
  private readCamera(): CameraState {
    const DEG = 180 / Math.PI;
    return {
      targetX: this.target[0],
      targetY: this.target[1],
      // The FIELD, not the focus's world z — the focus rides the terrain (followGround), and
      // WC3's ZOFFSET is how far above it the camera looks.
      zOffset: this.zOffset,
      distance: this.distance,
      rotationDeg: this.yaw * DEG,
      // WC3's ANGLE_OF_ATTACK is the VIEW direction's tilt (negative = looking down); our
      // pitch is the eye's elevation above the focus. Same angle, opposite sign.
      aoaDeg: -this.pitch * DEG,
      fovDeg: MapViewerScene.fovToWc3(this.fov),
      rollDeg: this.roll * DEG,
      farZ: this.farZ,
    };
  }

  private writeCamera(c: CameraState): void {
    const RAD = Math.PI / 180;
    this.target[0] = c.targetX;
    this.target[1] = c.targetY;
    this.zOffset = c.zOffset; // followGround adds the terrain under the focus back on
    this.distance = c.distance;
    this.yaw = c.rotationDeg * RAD;
    this.pitch = -c.aoaDeg * RAD;
    // A camera setup with a 0 or absurd FOV would render nothing at all; keep it sane.
    this.fov = clamp(MapViewerScene.fovFromWc3(c.fovDeg), 0.1, Math.PI * 0.9);
    this.roll = c.rollDeg * RAD;
    this.farZ = c.farZ;
    // The rotation this just wrote is absolute, so whatever Insert/Delete had added is gone
    // with it: forget the offset rather than unwinding it out of a yaw that no longer contains
    // it (which would leave the camera 90° off when the key came up).
    this.spin = 0;
  }

  // Edge-of-screen scrolling (WC3): pan when the cursor rests within EDGE_MARGIN of
  // a screen edge, and show a directional arrow cursor pointing the scroll way.
  private scrollArrow: HTMLDivElement | null = null;
  private updateEdgeScroll(fwd: [number, number], right: [number, number], speed: number): void {
    // Only in a live match, cursor on the page, nothing modal.
    const active =
      !!this.hud &&
      !this.paused &&
      !this.placement &&
      this.pointerInWindow &&
      !document.body.classList.contains("game-menu-open");
    let dx = 0;
    let dy = 0;
    if (active) {
      // The console does NOT shield the edge it sits on. In WC3 the HUD is painted over a
      // full-screen 3D view, so pushing the cursor into the bottom of the console still pans
      // down, and into the top bar still pans up. Ours is DOM, so gating this on "the pointer
      // is over the canvas" handed the top and bottom strips to the HUD, which swallowed the
      // move events — and vertical edge-scroll silently died while left/right (no HUD there)
      // kept working.
      //
      // The edges are the GAME FRAME's, not the window's: letterboxed, the window's edge is
      // out in the black bar where there is no map. The bar counts as PAST the edge, so the
      // frame's border is where the playable screen ends, bar or no bar.
      const m = this.lastCursor; // viewport coords, tracked wherever the pointer goes
      const f = this.frame;
      const margin = MapViewerScene.EDGE_MARGIN;
      if (m.x <= f.left + margin) dx = -1;
      else if (m.x >= f.right - margin) dx = 1;
      if (m.y <= f.top + margin) dy = -1;
      else if (m.y >= f.bottom - margin) dy = 1;
    }
    if (dx || dy) {
      if (dx) this.pan(right, dx * speed);
      if (dy) this.pan(fwd, -dy * speed); // top of screen (dy<0) pans the view forward
    }
    this.showScrollArrow(dx, dy);
  }

  /** The game frame's box in viewport coords. Read once a frame: the pointer handlers and the
   *  edge-scroll both need it, and `getBoundingClientRect` on every mouse move would force a
   *  layout against a HUD that mutates the DOM each frame. */
  private syncFrame(): void {
    const r = this.canvas.getBoundingClientRect();
    this.frame.left = r.left;
    this.frame.top = r.top;
    this.frame.right = r.right;
    this.frame.bottom = r.bottom;
  }

  private showScrollArrow(dx: number, dy: number): void {
    if (!dx && !dy) {
      if (this.scrollArrow) this.scrollArrow.hidden = true;
      return;
    }
    if (!this.scrollArrow) {
      this.scrollArrow = document.createElement("div");
      this.scrollArrow.className = "scroll-arrow";
      document.body.appendChild(this.scrollArrow);
    }
    // Directional glyph (8-way) placed at the cursor, pointing the scroll way. It is fixed to
    // the BODY, so it is placed in viewport coords — lastCursor, not the canvas-space lastMouse.
    const arrows: Record<string, string> = { "-1,-1": "↖", "0,-1": "↑", "1,-1": "↗", "-1,0": "←", "1,0": "→", "-1,1": "↙", "0,1": "↓", "1,1": "↘" };
    this.scrollArrow.textContent = arrows[`${dx},${dy}`] ?? "";
    this.scrollArrow.style.left = `${this.lastCursor.x}px`;
    this.scrollArrow.style.top = `${this.lastCursor.y}px`;
    this.scrollArrow.hidden = false;
  }

  private pan(dir: [number, number], amount: number): void {
    this.target[0] += dir[0] * amount;
    this.target[1] += dir[1] * amount;
  }

  /**
   * The ground the camera is currently looking at, as an axis-aligned world rect — what the
   * minimap's white camera box is drawn from (issue #112).
   *
   * The visible ground is not a rectangle: the lens is tilted 56° off vertical, so the four
   * screen corners land on a symmetric TRAPEZOID, much wider along its far edge than its near
   * one. WC3 draws its **bounding box** rather than that trapezoid — measured off the reference
   * shot on the issue, whose box is a clean axis-aligned rectangle (equal top and bottom edges,
   * to the pixel) 66 × 34 minimap px, i.e. 1.94 : 1. Run the frustum for the shot's ~1.98 : 1
   * frame at the default camera (distance 1650, AOA 304, 32° lens — docs/camera.md) and the
   * ground quad spans 2414 wide by 1185 deep: 2.04 : 1. The trapezoid itself is a third
   * narrower along its near edge (1630) and would not read as a rectangle at all.
   *
   * The corners are met against the plane through the camera's FOCUS, not z = 0 — the focus
   * rides the terrain (`followGround`), so that plane is the ground the middle of the screen is
   * actually looking at, and pinning the box at 0 would swell it by a fifth on a high plateau.
   */
  viewRect(): { x: number; y: number; w: number; h: number } {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // The camera basis the frame builds its eye from, minus roll (CAMERA_FIELD_ROLL is 0 in
    // every bundled map, and a rolled shot's bounding box is the same box a little larger).
    const fwd = [cy * cp, sy * cp, -sp];
    const right = [sy, -cy, 0];
    const up = [cy * sp, sy * sp, cp];
    const ty = Math.tan(this.fov / 2), tx = ty * this.aspect();
    const eye = [
      this.target[0] - cy * cp * this.distance,
      this.target[1] - sy * cp * this.distance,
      this.target[2] + sp * this.distance,
    ];
    const far = this.farZ > 0 ? this.farZ : this.distance * 8;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of [-1, 1]) {
      for (const v of [-1, 1]) {
        const dx = fwd[0] + v * ty * up[0] + s * tx * right[0];
        const dy = fwd[1] + v * ty * up[1] + s * tx * right[1];
        const dz = fwd[2] + v * ty * up[2];
        const len = Math.hypot(dx, dy, dz);
        // A corner ray that points at or above the horizon never meets the ground — a script
        // that tilted the camera up (AOA past the lens's half-angle) has one. Its "hit" is the
        // far plane, which is where the game stops drawing that direction anyway, so the box
        // stays finite instead of running to infinity.
        const nz = dz / len;
        const t = Math.min(nz < -1e-4 ? (this.target[2] - eye[2]) / nz : far, far);
        const x = eye[0] + (dx / len) * t, y = eye[1] + (dy / len) * t;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Middle-mouse drag-pan (WC3): the camera pans OPPOSITE the drag — drag the
   *  mouse up and the view scrolls down, drag left and it scrolls right — like
   *  pushing a joystick. `mx`/`my` are the pointer's per-move pixel deltas.
   *
   *  World units per screen pixel are derived from the perspective FOV (π/4) and
   *  the camera distance so the pan speed feels the same at every zoom level; the
   *  forward axis is divided by sin(pitch) because the tilted ground plane covers
   *  more world per vertical screen pixel. */
  private midPan(mx: number, my: number): void {
    const h = this.canvas.clientHeight || 720;
    // Off the LIVE lens, not a hard-coded one: the drag has to track the ground under the
    // cursor, and the world a screen pixel covers is set by the lens (and by a script's, if
    // one is driving the camera).
    const worldPerPx = (2 * this.distance * Math.tan(this.fov / 2)) / h;
    const fwd: [number, number] = [Math.cos(this.yaw), Math.sin(this.yaw)];
    const right: [number, number] = [fwd[1], -fwd[0]];
    // Inverted: +mx (drag right) → pan left; -my (drag up) → pan down/backward.
    this.pan(right, -mx * worldPerPx);
    this.pan(fwd, (my * worldPerPx) / Math.sin(this.pitch));
  }

  /** How far Insert/Delete swing the view, and how fast. The wiki states the angle: "Hold down
   *  Insert to rotate view 90 degrees left and hold Delete to rotate view 90 degrees right.
   *  Letting go of the key will snap the view back to center." The RATE is ours — WC3 documents
   *  no number — and unlike the wheel this one is LINEAR: it is a held control, so it has to
   *  turn at a constant speed for as long as you hold it and stop dead on the 90°, with no
   *  ease-out that would make the last few degrees crawl. The same rate unwinds it on release. */
  private static readonly SPIN_LIMIT = Math.PI / 2; // 90°
  private static readonly SPIN_RATE = (200 * Math.PI) / 180; // radians/second — 90° in ~0.45 s

  /** The player's own camera controls, per frame: the wheel's eased zoom (distance and, on the
   *  closest stops, pitch) and Insert/Delete's rotation. `dt` is SECONDS. */
  private updatePlayerCamera(dt: number): void {
    // A script driving the camera owns distance/rotation/AOA outright, so the ease parks where
    // it is and resumes when the shot lets go — writeCamera would only fight it frame by frame.
    if (!this.scriptCam.active) {
      if (this.zoomT < 1) {
        this.zoomT = Math.min(1, this.zoomT + dt / MapViewerScene.ZOOM_EASE);
        // Cubic ease-out: leaves the old stop immediately, settles into the new one.
        const k = 1 - Math.pow(1 - this.zoomT, 3);
        this.distance = this.zoomFromDistance + (this.playerDistance - this.zoomFromDistance) * k;
        this.pitch = this.zoomFromPitch + (this.playerPitch - this.zoomFromPitch) * k;
      }

      // Insert/Delete. Held = turn toward ±90°, released = turn back to 0; both at SPIN_RATE.
      // Only the delta goes onto `yaw`, so the spin composes with the camera's own rotation.
      const goal = this.userControl
        ? this.keys.has("insert")
          ? MapViewerScene.SPIN_LIMIT
          : this.keys.has("delete")
            ? -MapViewerScene.SPIN_LIMIT
            : 0
        : 0;
      if (this.spin !== goal) {
        const stepBy = MapViewerScene.SPIN_RATE * dt;
        const next = this.spin + clamp(goal - this.spin, -stepBy, stepBy);
        this.yaw += next - this.spin;
        this.spin = next;
      }
    }
  }

  /** Confine the camera focus to the terrain rect so it can't scroll into the void
   *  past the map edge (issue #5). Central choke point: every mover (keyboard/edge
   *  scroll, minimap click, follow-selection, panTo) writes this.target, so clamping
   *  once per frame before the eye is derived catches them all. */
  private clampTarget(): void {
    const b = this.mapBounds;
    if (!b) return;
    this.target[0] = clamp(this.target[0], b.minX, b.maxX);
    this.target[1] = clamp(this.target[1], b.minY, b.maxY);
  }

  /** Sit the camera's focus ON THE TERRAIN — WC3's camera keeps its distance to the GROUND
   *  under the middle of the screen, not to the z = 0 plane (issue #73).
   *
   *  The focus used to be pinned at z = 0, so every map paid for its own terrain: a start
   *  location perched two cliff levels up (layerHeight 4 ⇒ +256) put the ground 256 units
   *  nearer the eye than the camera thought, and one down pushed it away — the same 1650 framing
   *  a fifth tighter here and a fifth looser there. Melee maps mostly start on a flat, mid-height
   *  plateau and custom maps go wherever their author put them, which is exactly the "custom maps
   *  look different from melee maps" in the issue. Riding the terrain makes 1650 mean 1650
   *  everywhere.
   *
   *  Eased, not snapped: cresting a cliff would otherwise jolt the whole view by a full 128-unit
   *  layer in one frame. `groundSnap` is the escape hatch for a real teleport (map load, minimap
   *  jump, a script's camera apply), where there is no continuity to preserve. */
  // Seconds to close ~63% of the gap. The ease costs a steady-state lag of τ × dz/dt, so it is
  // kept short. Measured by walking the focus down Tirisfal Glades' steepest slope at full
  // edge-scroll speed: the follow trails the terrain by ~190 units crossing the cliff face itself
  // and by <10 once the ground levels, and is back on it a few frames after you stop — while the
  // rise still arrives over ~0.15 s rather than as a jolt.
  private static readonly GROUND_EASE = 0.05;
  private static readonly GROUND_TELEPORT = 512; // focus jumped ≥ 4 cells in a frame ⇒ no ease
  private lastFocus: [number, number] | null = null;
  private followGround(dtMs: number): void {
    const ground = this.rts?.groundHeightAt(this.target[0], this.target[1]) ?? 0;
    // Any jump — minimap click, panTo, focus-selection, a script's camera apply — lands on new
    // ground with nothing to ease from. Detected here, once, rather than at every call site.
    const moved = this.lastFocus
      ? Math.hypot(this.target[0] - this.lastFocus[0], this.target[1] - this.lastFocus[1])
      : Infinity;
    this.lastFocus = [this.target[0], this.target[1]];
    if (moved >= MapViewerScene.GROUND_TELEPORT) this.groundSnap = true;
    if (this.groundSnap) {
      this.groundZ = ground;
      this.groundSnap = false;
    } else {
      // Frame-rate independent exponential ease (1 - e^(-dt/τ)), so a slow frame catches up.
      const k = 1 - Math.exp(-Math.min(dtMs, 250) / 1000 / MapViewerScene.GROUND_EASE);
      this.groundZ += (ground - this.groundZ) * k;
    }
    this.target[2] = this.groundZ + this.zOffset;
  }

  /** Draw the drag-selection rectangle. `x`/`y` are CANVAS coords (offsetX/offsetY), so the
   *  box lives in the world layer, whose box is the canvas's — not on the body, which is the
   *  window's and would offset it by the letterbox. */
  private updateSelectBox(x: number, y: number): void {
    if (!this.selectBoxEl) {
      this.selectBoxEl = document.createElement("div");
      this.selectBoxEl.className = "select-box";
      worldLayer().appendChild(this.selectBoxEl);
    }
    const el = this.selectBoxEl;
    el.hidden = false;
    el.style.left = `${Math.min(this.downX, x)}px`;
    el.style.top = `${Math.min(this.downY, y)}px`;
    el.style.width = `${Math.abs(x - this.downX)}px`;
    el.style.height = `${Math.abs(y - this.downY)}px`;
    // Ring the units the box currently covers (green preview) as it's dragged.
    this.rts?.setPreviewBox(this.downX, this.downY, x, y);
  }

  private hideSelectBox(): void {
    if (this.selectBoxEl) this.selectBoxEl.hidden = true;
    this.rts?.clearPreviewBox(); // drop the marquee preview rings
  }

  /** Abort an in-progress drag-select without committing it (right-click, or a
   *  cancelled/stolen pointer) — resets all drag state and clears the marquee. */
  private cancelDrag(): void {
    this.dragging = false;
    this.moved = false;
    this.hideSelectBox();
  }

  /** Drive the cursor overlay at the mouse. While an order is ARMED (Move/Attack/
   *  Patrol/Rally/Repair) it shows the WC3 **target reticle**; while merely
   *  hovering a unit/mine it keeps the race **hand cursor** but recoloured. Both
   *  pulse (colour only, constant size) — green friendly / yellow neutral / red
   *  enemy — and hide the OS cursor over the map (via the `reticle-on` class).
   *
   *  `clientX`/`clientY` are VIEWPORT coords, because this overlay is fixed to the body — it
   *  has to be free to follow the cursor out over the HUD and the letterbox. Feeding it the
   *  canvas-space cursor instead is what made the game feel broken windowed: the reticle drew
   *  itself a whole letterbox bar away from the real pointer, while `reticle-on` hid the OS
   *  cursor — so you aimed with a cursor that was lying to you, and every click landed off. */
  private updateReticle(clientX: number, clientY: number): void {
    if (!this.rts) return this.hideCursorOverlay();
    const mode = this.rts.orderMode;
    // Carrying an item (right-clicked in the inventory to move it): the cursor stays
    // the plain WC3 hand — no reticle — and the item's icon rides along at half size,
    // as if the gauntlet were holding it. Handled before everything else so no hover
    // tint or armed-order reticle can steal the cursor while you're carrying.
    const carrySlot = mode === "item" && this.rts.armedItem?.mode === "move" ? this.rts.armedItem.slot : -1;
    this.updateCarriedItem(carrySlot, clientX, clientY);
    if (carrySlot >= 0) {
      document.body.classList.remove("reticle-on", "armed-on"); // let the OS hand cursor show through
      return this.hideCursorOverlay();
    }
    const hover = this.rts.hoverInfo();
    let kind: "reticle" | "hand" | null = null;
    let colorKey: "green" | "yellow" | "red" = "green";
    if (mode) {
      kind = "reticle";
      // The Attack order shows a RED reticle (WC3), the other armed orders green
      // (yellow while hovering a unit for a move-type order).
      if (mode === "attack") colorKey = "red";
      else colorKey = hover.has ? "yellow" : "green";
    } else if (hover.has) {
      kind = "hand";
      colorKey = hover.category === "friendly" ? "green" : hover.category === "enemy" ? "red" : "yellow";
    }
    const url = kind === "reticle" ? this.reticleUrl(colorKey) : kind === "hand" ? this.handCursorUrl(colorKey) : "";
    if (!kind || !url) {
      document.body.classList.remove("reticle-on", "armed-on");
      return this.hideCursorOverlay();
    }
    // The armed reticle owns the cursor screen-wide; the hover hand only over the map.
    document.body.classList.toggle("armed-on", kind === "reticle");
    document.body.classList.toggle("reticle-on", kind === "hand");
    if (!this.reticleEl) {
      this.reticleEl = document.createElement("div");
      document.body.appendChild(this.reticleEl);
    }
    const el = this.reticleEl;
    el.hidden = false;
    el.style.left = `${clientX}px`;
    el.style.top = `${clientY}px`;
    el.style.backgroundImage = `url(${url})`;
    el.className = `order-reticle ${kind} pulse`;
  }

  /** Show/hide the half-size item icon that follows the hand while an inventory item
   *  is armed for a move. `slot` < 0 hides it. It follows the cursor everywhere —
   *  over the map AND the console — because every one of those is a legal drop
   *  target (another slot, the ground, an allied hero); body-fixed like the reticle,
   *  so `clientX`/`clientY` are viewport coords. */
  private updateCarriedItem(slot: number, clientX: number, clientY: number): void {
    const icon = slot >= 0 ? this.rts?.inventorySlots()[slot]?.icon : "";
    const url = icon ? this.blpIcon(icon) : null;
    document.body.classList.toggle("carrying-item", slot >= 0);
    if (!url) {
      if (this.carryEl) this.carryEl.hidden = true;
      return;
    }
    if (!this.carryEl) {
      this.carryEl = document.createElement("div");
      this.carryEl.className = "carried-item";
      this.carryEl.hidden = true; // so the sizing below runs on this first show too
      document.body.appendChild(this.carryEl);
    }
    if (this.carryEl.hidden) {
      // Sized off the REAL inventory slot (the console scales with the window), a
      // touch smaller than the icon it was picked up from — so it reads as the same
      // item, held, rather than a second icon. Measured only on pick-up: reading
      // clientWidth every frame would force a layout.
      const slotPx = document.querySelector(".hud-inv-slot")?.clientWidth || 32;
      const px = Math.max(12, Math.round(slotPx * CARRIED_ITEM_SCALE));
      this.carryEl.style.width = `${px}px`;
      this.carryEl.style.height = `${px}px`;
    }
    this.carryEl.hidden = false;
    this.carryEl.style.left = `${clientX}px`;
    this.carryEl.style.top = `${clientY}px`;
    this.carryEl.style.backgroundImage = `url(${url})`;
  }

  private hideCursorOverlay(): void {
    if (this.reticleEl) this.reticleEl.hidden = true;
  }

  private aspect(): number {
    return this.canvas.width / this.canvas.height || 1;
  }

  /** WC3-style typed cheat codes. We don't have a chat box, so we watch the raw
   *  keystream: `iseedeadpeople` toggles full-map reveal (the fog of war). */
  private checkCheatCode(key: string): void {
    if (key.length !== 1 || !/[a-z]/i.test(key)) return;
    this.cheatBuf = (this.cheatBuf + key.toLowerCase()).slice(-16);
    if (this.cheatBuf.endsWith("iseedeadpeople")) {
      this.rts?.toggleRevealAll();
      this.cheatBuf = "";
    }
  }

  /** Register an input listener FOR THE LENGTH OF THE MATCH, remembering how to take it off.
   *
   *  Every surface these hang on outlives the match: `window`, `document`, and the `#map`
   *  canvas itself, which is a fixed element in index.html that each new MapViewerScene is
   *  built onto. So a listener added here and never removed is not a slow leak — it is the
   *  PREVIOUS match still reading the keyboard from the main menu, and a second copy of it
   *  after the game after that (see `dispose`).
   *
   *  `(e: never)` is what lets each call site annotate its own event type and have the body
   *  typed from that — a handler taking any event is assignable to one taking `never`. */
  private on(target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void {
    const listener = fn as EventListener;
    target.addEventListener(type, listener, opts);
    this.detachers.push(() => target.removeEventListener(type, listener, opts));
  }

  /** Undo list for `on` — run and emptied by `dispose`. */
  private detachers: Array<() => void> = [];

  /** Set by `dispose`. Background work that outlives the frame loop (the idle icon warm)
   *  checks it: the scene is gone and anything it produces now would never be freed. */
  private disposed = false;

  private attachControls(): void {
    const c = this.canvas;
    this.on(window, "keydown", (e: KeyboardEvent) => {
      // ESC during a cinematic SKIPS it — WC3 raises EVENT_PLAYER_END_CINEMATIC for the
      // local player and the map's own skip trigger takes it from there (see
      // Interpreter.firePlayerEvent for the NightElfX01 trigger this exists for).
      //
      // The gate is `ShowInterface(false)`, which is what CinematicModeBJ turns off and what
      // the letterbox is. Outside cinematic mode ESC keeps its ordinary job (the HUD's
      // "cancel" command) — and it still does here, because the HUD's own key handler stands
      // down while the console is hidden (`if (this.root.hidden) return`), so the two never
      // both answer the same press.
      //
      // Whether the press does anything is the MAP's call: chapter one creates its skip
      // trigger disabled and enables it only for the length of the intro, so an ESC before or
      // after that finds nothing registered and is silently dropped, exactly as in the game.
      if (e.key === "Escape" && !this.interfaceShown) {
        e.preventDefault();
        this.mapScript?.interp.firePlayerEvent(this.localPlayer, EVENT_PLAYER_END_CINEMATIC);
        return;
      }
      // The four console panels. Each `preventDefault` is about the BROWSER (F10 opens its
      // menu, F11 goes full-screen, F12 opens devtools) and stands whether or not the panel
      // itself answers — togglePanel is what decides that, and it refuses while a cinematic
      // is running.
      if (e.key === "F10") {
        e.preventDefault(); // F10 opens WC3's game menu, not the browser's
        this.togglePanel("menu");
        return;
      }
      // F9 is the Quest Log ("F9 - Toggle the Quest Log on/off"). No pause, as in the game.
      if (e.key === "F9") {
        e.preventDefault();
        this.togglePanel("quests");
        return;
      }
      // F11 is the Allies dialog (UI\HelpStrings.txt: "F11 - Toggle the Allies menu on/off").
      // Unlike F10 it does NOT pause: WC3 keeps the match running behind it.
      if (e.key === "F11") {
        e.preventDefault(); // and not the browser's full-screen toggle
        this.togglePanel("allies");
        return;
      }
      // F12 is the Messaging dialog ("F12 - Toggle the Chat menu on/off"). It picks who the
      // entry line talks to and shows the history; it does not pause either.
      if (e.key === "F12") {
        e.preventDefault(); // and not the browser's devtools
        this.togglePanel("chat");
        return;
      }
      // Same rule as the HUD's own hotkeys (ui/hud.ts isTyping): a keystroke aimed at a text
      // field is not a camera pan and not a cheat code. Without this, typing a gift amount
      // into the Allies dialog leaves the letters stuck in `keys` (the field swallows the
      // keyup) and the camera scrolls off on its own afterwards.
      if (isTyping(e.target)) return;
      this.keys.add(e.key.toLowerCase());
      this.checkCheatCode(e.key);
    });
    this.on(window, "keyup", (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    this.on(c, "contextmenu", (e: Event) => e.preventDefault());
    // Suppress the browser's middle-click autoscroll (it fires off mousedown, which
    // preventDefault on pointerdown doesn't reach) so button 1 is free to drag-pan.
    this.on(c, "mousedown", (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    });
    // Left-drag rotates the camera; a left-click (no drag) selects a unit;
    // right-click issues a move order for the selection.
    this.on(c, "pointerdown", (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId);
      this.sounds?.unlock(); // browsers gate audio until the first user gesture
      // EnableUserControl(false) — a cinematic owns the mouse (7.24). No selecting, no
      // orders, no drag-pan; the shot is the script's to compose.
      if (!this.userControl) return;
      if (e.button === 1) {
        // Middle mouse (scroll-wheel click) held: drag-pan the camera, WC3-style.
        // preventDefault suppresses the browser's middle-click autoscroll cursor.
        e.preventDefault();
        this.midPanning = true;
        return;
      }
      if (e.button === 2) {
        // A right-click while a left-drag box is in progress just cancels the box
        // (WC3) — it issues no move order. This also guards against the drag state
        // leaking (a stuck marquee) when left+right are clicked in quick succession.
        if (this.dragging) {
          this.cancelDrag();
          return;
        }
        // Right-click cancels build placement / an armed order, else moves
        // (Shift held → append to the unit's order queue instead of replacing).
        if (this.placement) this.cancelPlacement();
        else if (this.rts?.orderMode) {
          this.rts.orderMode = null;
          this.rts.armedCast = null; // disarm a pending spell target
          this.hud?.clearOrderMode();
        } else this.rts?.moveAt(e.offsetX, e.offsetY, e.shiftKey);
        return;
      }
      if (e.button === 0) {
        // WC3 commits a targeted order the instant the button goes DOWN — the
        // build placement, the attack-move point, the spell's aim click. Doing it
        // on pointerup instead (as we used to) meant a fast click that slid a few
        // pixels tripped the drag threshold and the order was silently dropped
        // (issue #44). Neither of these can drag, so they never start one.
        if (this.placement) {
          this.placeBuilding(e.offsetX, e.offsetY, e.shiftKey);
          return;
        }
        if (this.rts?.orderMode) {
          if (this.rts.orderClickAt(e.offsetX, e.offsetY, e.shiftKey)) this.hud?.clearOrderMode();
          return;
        }
        this.dragging = true;
        this.downX = e.offsetX;
        this.downY = e.offsetY;
        this.moved = false;
      }
    });
    // Belt-and-suspenders: if the browser cancels/steals the pointer mid-drag,
    // tear the drag state down so the marquee can't get stuck on screen.
    this.on(c, "pointercancel", () => {
      this.cancelDrag();
      this.midPanning = false;
    });
    this.on(c, "pointerup", (e: PointerEvent) => {
      // Release capture only once ALL buttons are up, so a second button's release
      // can't strand the primary button's pointerup off-target (stuck marquee).
      if (e.buttons === 0) c.releasePointerCapture(e.pointerId);
      if (e.button === 1) this.midPanning = false;
      if (e.button === 0) {
        const wasDragging = this.dragging;
        this.dragging = false;
        this.hideSelectBox();
        // A drag cancelled out from under us (e.g. by a right-click) consumes this
        // left-up without selecting anything.
        if (!this.rts || !wasDragging) return;
        // Box vs click is decided by where the button came UP, not by whether the
        // cursor ever twitched: a fast click that slides past the threshold and
        // back is still a click, and a drag that returns to its origin encloses
        // nothing worth boxing.
        if (Math.hypot(e.offsetX - this.downX, e.offsetY - this.downY) > DRAG_SLOP) {
          // A left-drag is a rectangle selection of the player's own units
          // (Shift held → add the boxed units to the current selection).
          this.rts.selectBox(this.downX, this.downY, e.offsetX, e.offsetY, e.shiftKey);
        } else {
          // Modifiers: Shift = add/remove from group; Ctrl or a double-click =
          // select all on-screen units of the same type.
          const t = performance.now();
          const dbl = t - this.lastClickAt < 350 && Math.hypot(e.offsetX - this.lastClickX, e.offsetY - this.lastClickY) < 8;
          this.lastClickAt = t;
          this.lastClickX = e.offsetX;
          this.lastClickY = e.offsetY;
          this.rts.selectAt(e.offsetX, e.offsetY, { additive: e.shiftKey, sameType: e.ctrlKey || e.metaKey || dbl });
        }
      }
    });
    this.on(c, "pointermove", (e: PointerEvent) => {
      this.lastMouse.x = e.offsetX;
      this.lastMouse.y = e.offsetY;
      if (this.midPanning) {
        // Self-heal: if the middle button isn't actually held any more, the ending
        // pointerup was lost — drop the pan so it can't stick to the cursor.
        if (!(e.buttons & 4)) this.midPanning = false;
        else this.midPan(e.movementX, e.movementY);
      }
      if (this.placement) this.updateGhost(e.offsetX, e.offsetY);
      // WC3 keeps a fixed camera angle — no free rotation. A left-drag draws a
      // selection rectangle (unless placing a building or holding an armed order).
      if (this.dragging) {
        // Self-heal: if the left button isn't actually held any more, the ending
        // pointerup was lost (a rapid left+right click can swallow it) — drop the
        // drag so the marquee can't stick to the cursor with no button pressed.
        if (!(e.buttons & 1)) this.cancelDrag();
        else {
          // `moved` only decides whether to *draw* the marquee; pointerup re-measures
          // the real distance to decide whether it selects a box or a point.
          if (Math.hypot(e.offsetX - this.downX, e.offsetY - this.downY) > DRAG_SLOP) this.moved = true;
          if (this.moved) this.updateSelectBox(e.offsetX, e.offsetY);
        }
      }
      // EnableUserControl(false) — a cinematic owns the mouse (7.24). It already owned the
      // CLICK; the hover is just as much an interaction, and leaving it live let the player
      // light units up and read their tooltips right through a cinematic.
      if (!this.dragging && this.userControl) this.rts?.hoverAt(e.offsetX, e.offsetY);
    });
    // Where the pointer is, in VIEWPORT coords, ALWAYS — over the map, over the HUD, out in
    // the letterbox. Everything drawn AT the cursor (the reticle, the carried item, the
    // scroll arrow) is fixed to the body and so is placed from this, and edge-scroll measures
    // it against the frame. `lastMouse` is the other space: the canvas, for what unprojects
    // into the world. Mixing them is invisible fullscreen (the frame IS the window there) and
    // breaks by exactly one black bar as soon as it isn't.
    const trackCursor = (e: PointerEvent | MouseEvent) => {
      this.lastCursor.x = e.clientX;
      this.lastCursor.y = e.clientY;
      this.pointerInWindow = true;
    };
    this.on(window, "pointermove", trackCursor, { capture: true });
    this.on(window, "pointerdown", trackCursor, { capture: true });
    this.on(window, "contextmenu", trackCursor, { capture: true });
    // Cursor left the page (or the window lost focus): stop edge-scrolling. Without this the
    // camera would keep panning off the last edge the cursor crossed on its way out.
    this.on(document, "pointerleave", () => (this.pointerInWindow = false));
    this.on(window, "blur", () => (this.pointerInWindow = false));
    this.on(window, "pointermove", (e: PointerEvent) => {
      // Self-heal a stuck drag even while the pointer is off the canvas (over the
      // HUD): still "dragging" with the left button not held means the pointerup
      // was lost, so cancel it here too — the canvas handler can't see these moves.
      if (this.dragging && !(e.buttons & 1)) this.cancelDrag();
      if (e.target !== this.canvas && !this.dragging) {
        this.rts?.clearHover();
        // While a spell/order is armed, keep aiming over the HUD too, so you can target
        // units in the console's group grid — and so a point spell's AoE circle keeps
        // tracking. The canvas isn't getting these moves, so convert into ITS space: the
        // canvas-relative offset the map's picking speaks. (This used to store the raw
        // viewport point, which the AoE unprojected as if it were a canvas one.)
        if (this.rts?.orderMode) {
          this.lastMouse.x = e.clientX - this.frame.left;
          this.lastMouse.y = e.clientY - this.frame.top;
        }
      }
    });
    this.on(
      c,
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        if (!this.userControl) return; // a cinematic owns the zoom too (7.24)
        const dir = Math.sign(e.deltaY); // wheel down (+) = zoom out = a rung further out
        if (!dir) return;
        // One notch = one rung of the ladder, read off the zoom the player is HEADED for (not
        // the eased distance mid-flight), so notching fast still advances one stop per notch.
        const step = clamp(Math.round(MapViewerScene.zoomStopOf(this.playerDistance)) - dir, 0, MapViewerScene.ZOOM_STEPS);
        this.setZoomStop(step); // …and this is the zoom a cinematic gives back
      },
      { passive: false },
    );
  }
}

// The game renders at a fixed 1080p, 16:9 (ui/stage.ts) — the frame Warcraft III itself
// draws, and the frame the lens is framed for. The CSS stage scales this buffer into the
// largest 16:9 box the window allows and letterboxes the rest, so the aspect can never drift
// with the window: 1:1 fullscreen on a 1080p display, cleanly scaled everywhere else. Sizing
// the buffer off the window instead is what let a tall window widen the view — the lens is
// vertical, so a wider box quietly hands the player more map than the real game gives.
function syncCanvasSize(canvas: HTMLCanvasElement): void {
  // Only assign when it changed: reassigning canvas.width/height even to the same value
  // reallocates and clears the GL drawing buffer.
  if (canvas.width !== GAME_WIDTH || canvas.height !== GAME_HEIGHT) {
    canvas.width = GAME_WIDTH;
    canvas.height = GAME_HEIGHT;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// The finished-building idle sequence: the plain "Stand" clip, skipping the
// "Birth" construction scaffold, "Death"/"Decay", and work variants. Falls back
// to the first non-birth/non-death sequence, then to 0.
function standSequence(seqs: Array<{ name: string }>): number {
  const plain = seqs.findIndex((s) => /^stand(\s|$|-)/i.test(s.name) && !/work|birth/i.test(s.name));
  if (plain >= 0) return plain;
  const anyStand = seqs.findIndex((s) => /^stand/i.test(s.name));
  if (anyStand >= 0) return anyStand;
  const nonBirth = seqs.findIndex((s) => !/birth|death|decay|dissipate/i.test(s.name));
  return nonBirth >= 0 ? nonBirth : seqs.length ? 0 : -1;
}

// Quaternion for a rotation `angle` about +Z (WC3 units are Z-up), into `out`.
/**
 * Position key for `treeFogRadius`. The sim tree and its rendered doodad are seeded
 * from the same war3map.doo record, so rounding to a whole world unit matches them
 * exactly while tolerating float round-tripping through the widget's localLocation.
 *
 * A NUMBER, not a `"x,y"` string. `fogWidgets` asks this for every widget on the map on
 * every pass — 4,345 doodads on Extreme Candy War, ten times a second — and building a
 * string for each one was ~45,000 throwaway strings a second before the Map had even been
 * consulted. The packing is exact: `y` is a whole number under 65,536/2 in magnitude, so
 * `x * 131072 + y` is unique, and the largest WC3 map reaches ±30,720 world units, which
 * keeps the product inside the integers a double represents exactly.
 */
function fogKey(x: number, y: number): number {
  return Math.round(x) * 131072 + Math.round(y);
}

function zQuat(out: Float32Array, angle: number): void {
  const half = angle / 2;
  out[0] = 0;
  out[1] = 0;
  out[2] = Math.sin(half);
  out[3] = Math.cos(half);
}

// --- Debug collider overlay geometry helpers (interleaved [x,y,z, r,g,b,a]) ---
// Hard dark-blue vertex tint for the "pending build" ghost (issue #18). setVertexColor
// multiplies the model's texture, so low red/green + strong blue reads as a dark-blue
// silhouette across any building. "Hard" dark blue is opaque, hence alpha 1.0 — a
// translucent alpha now genuinely fades the model (issue #66) rather than making it
// vanish, so this is a look, not a constraint.
const PENDING_GHOST_TINT = [0.12, 0.22, 0.85, 1.0] as const;
// …and its refusal twin: the same hard, opaque treatment swung to red, for a pending build
// standing where one can no longer go (see updatePendingBuildGhosts). Deliberately the same
// vocabulary as the placement grid's red squares — one colour means "not here" everywhere.
const PENDING_GHOST_BLOCKED_TINT = [0.85, 0.12, 0.12, 1.0] as const;
const COLLIDER_LIFT = 12; // raise shapes above the ground so they read clearly
// "Show Regions" overlay palette: cyan outline + a faint cyan wash inside each rect.
const REGION_COLORS = { outline: [0.2, 0.95, 1.0, 0.9] as const, fill: [0.2, 0.85, 1.0, 0.12] as const };

/** Project a world point through a column-major view-projection matrix to canvas
 *  pixels (origin top-left), or null if it's behind the camera. Used to anchor the
 *  region-name DOM labels over the 3D scene. */
/** An MDX sequence-name matcher for a clip a script asked for by name ("death alternate").
 *  Anchored so "death" can't select "death alternate" — a gate that shatters instead of
 *  swinging open is a different animation. */
function clipRe(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

function projectToScreen(m: Float32Array, x: number, y: number, z: number, w: number, h: number): [number, number] | null {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 1e-4) return null; // at/behind the camera plane
  return [((cx / cw) * 0.5 + 0.5) * w, (1 - ((cy / cw) * 0.5 + 0.5)) * h];
}
// Dead zone (CSS px) a left-press must leave before it counts as a drag-select
// rather than a click. Mice wobble a pixel or three during a fast click, so a
// tight zone turns clicks into empty one-pixel marquees (issue #44).
const DRAG_SLOP = 6;

const TREE_CLICK_RADIUS = 40; // approx harvest-click radius drawn for each tree
const PATH_LIFT = 18; // path lines sit above the grid/blocked overlay so they read on top
const EMPTY_VERTS = new Float32Array(0); // clears a persistent OverlayLayer (verts = 0)

/** Which tileset's DNC lights shade this map. The World Editor lets a map pick a light
 *  environment independent of its terrain (Scenario → Map Options → Light Environment);
 *  `war3map.w3i` stores NUL when it just follows the tileset, which most melee maps do
 *  (Terenas Stand is one that sets it). Falls back to the w3e tileset. */
function lightEnvironment(archive: DataSource, tileset: string): string {
  const bytes = archive.rawBytes("war3map.w3i");
  if (!bytes) return tileset;
  try {
    const info = new w3iParser.File();
    info.load(bytes);
    const letter = info.lightEnvironmentTileset;
    if (letter && letter !== "\0") return letter;
  } catch {
    // Pre-TFT w3i (version 18) has no such field — the tileset it is.
  }
  return tileset;
}

function pushColliderVert(a: number[], x: number, y: number, z: number, c: readonly number[]): void {
  a.push(x, y, z, c[0], c[1], c[2], c[3]);
}

/** Two triangles covering the world-space rect [x0,y0]–[x1,y1], each corner at terrain
 *  height + lift so the quad hugs the ground. */
function pushColliderQuad(a: number[], x0: number, y0: number, x1: number, y1: number, h: HeightSampler, c: readonly number[]): void {
  const z00 = h(x0, y0) + COLLIDER_LIFT, z10 = h(x1, y0) + COLLIDER_LIFT;
  const z01 = h(x0, y1) + COLLIDER_LIFT, z11 = h(x1, y1) + COLLIDER_LIFT;
  pushColliderVert(a, x0, y0, z00, c); pushColliderVert(a, x1, y0, z10, c); pushColliderVert(a, x0, y1, z01, c);
  pushColliderVert(a, x1, y0, z10, c); pushColliderVert(a, x1, y1, z11, c); pushColliderVert(a, x0, y1, z01, c);
}

/** A polyline through world points [x,y], each vertex lifted to terrain height.
 *  Long segments are subdivided per pathing cell so the line hugs hills instead
 *  of cutting straight through them. Emitted as GL line-segment pairs. */
function pushPathPolyline(a: number[], pts: Array<[number, number]>, h: HeightSampler, c: readonly number[]): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / PATHING_CELL));
    for (let s = 0; s < steps; s++) {
      const ax = x0 + ((x1 - x0) * s) / steps, ay = y0 + ((y1 - y0) * s) / steps;
      const bx = x0 + ((x1 - x0) * (s + 1)) / steps, by = y0 + ((y1 - y0) * (s + 1)) / steps;
      pushColliderVert(a, ax, ay, h(ax, ay) + PATH_LIFT, c);
      pushColliderVert(a, bx, by, h(bx, by) + PATH_LIFT, c);
    }
  }
}

/** A ring (as line segments) of radius `r` at (cx,cy), flat at height `z` + lift. */
function pushColliderRing(a: number[], cx: number, cy: number, z: number, r: number, c: readonly number[], segs: number): void {
  const zz = z + COLLIDER_LIFT;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    pushColliderVert(a, cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, zz, c);
    pushColliderVert(a, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, zz, c);
  }
}
