import War3MapViewer from "mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/viewer";
import ModelViewer from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import type { DataSource } from "../vfs/types";
import w3iParser from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";
import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import { MpqDataSource } from "../vfs/mpq";
import { parseW3E, type TerrainData } from "../world/terrain";
import { parseDoo } from "../world/doodads";
import { PathingGrid, parseWpm, footprintCells, PATHING_CELL, BUILD_CELL, BUILD_CELL_CELLS } from "../sim/pathing";
import { jassOwnerOf, type BuildJob, type QueuedOrder, type RallyKind, type ShopResult, type SimMine, type SimUnit, type SimWorld } from "../sim/world";
import { stampFootprints, stampFootprint, unstampFootprint, decodePathTex, footprintRadius, type Footprint, type PlacedFootprint } from "../sim/destructibles";
import { parseMapUnits, GOLD_MINE_ID, START_LOCATION_ID } from "../world/mapUnits";
import { loadMapScript, type MapScriptEngine } from "../jass/index";
import { MAP_CONTROL, type EngineHooks, type RectObj, type Runtime } from "../jass/runtime";
import type { UnitSnapshot } from "../jass/interpreter";
import { makeHeightSampler, makeCliffLevelSampler, makeFootprintMaxSampler, type HeightSampler, type FootprintMaxSampler } from "../game/heightmap";
import { FogOverlay } from "./fogOverlay";
import { UberSplatOverlay } from "./uberSplatOverlay";
import { ShadowOverlay } from "./shadowOverlay";
import { WeatherOverlay } from "./weather";
import { loadWeatherRegistry, type WeatherRegistry } from "../data/weather";
import { DebugColliders, OverlayLayer, COLLIDER_COLORS, FLOATS_PER_VERT, type ColliderBatch } from "./debugColliders";
import { FogState, VISION_CELL, type VisionMap } from "../sim/vision";
import { RtsController, ILLUSION_TINT, type RtsHost, type SelectionInfo } from "../game/rts";
import { SoundBoard } from "../audio/sounds";
import { loadUnitRegistry, type UnitRegistry, type UnitDef } from "../data/units";
import { applyMapUnitData, applyMapAbilityData, applyMapItemData, applyMapUpgradeData } from "../data/objectData";
import { loadUberSplatRegistry, type UberSplatRegistry } from "../data/ubersplats";
import { specialFxPhaseAt, type SpecialFxClips } from "./specialFxClock";
import { loadAbilityRegistry, mdlPath, type AbilityRegistry, type AbilityDef, type BuffFx, KNOWN_ABILITIES, requiredHeroLevel } from "../data/abilities";
import { loadCommandStrings, type CommandStrings } from "../data/commandStrings";
import { resolveTipRefs } from "../data/tipRefs";
import { loadItemRegistry, type ItemRegistry } from "../data/items";
import { CAMERA, MELEE, MISC_DATA, MISC_GAME } from "../data/gameplayConstants";
import { DayNightCycle, type DayNightLight } from "./dayNight";
import { makeFog, type DistFog } from "./fog";
import { TimeIndicatorClock, timeIndicatorPath } from "./timeIndicator";

/** Per-creep seed data collected from the map (guard post + drop table). */
interface CreepSeed {
  x: number;
  y: number;
  aggro: number;
  drops: Array<{ items: Array<{ id: string; chance: number }> }>;
}
import { MAIN_HALL_CHAINS, RACE_INDEX, STARTING_UNITS, WORKERS, MELEE_UNIT_SPACING, MELEE_WORKER_CLUSTERS, resolveRace, type PlayableRace, type WorkerCluster } from "../data/races";
import { MoveType } from "../data/enums";
import { ModelViewerScene } from "./modelViewer";
import type { MeleeConfig, SlotConfig } from "../ui/lobby";
import { MetricsOverlay } from "../ui/metrics";
import { GameHud, type HudDriver, type CommandButton } from "../ui/hud";
import { GAME_WIDTH, GAME_HEIGHT, worldLayer } from "../ui/stage";
import { UI_HEIGHT } from "../ui/fdf/layout";
import { GameMenu } from "../ui/gameMenu";
import { GameDialogOverlay } from "../ui/gameDialog";
import { LeaderboardOverlay } from "../ui/leaderboard";
import { MultiboardOverlay } from "../ui/multiboard";
import { TimerDialogOverlay } from "../ui/timerDialog";
import { CinematicPanelOverlay } from "../ui/cinematicPanel";
import { ScriptCamera, type CameraState } from "./scriptCamera";
import { TextTagOverlay, type TextTagContext } from "./textTags";
import { FdfLibrary } from "../ui/fdf/library";
import { blpToCanvas, blpToDataUrl } from "./blputil";
import { loadTechRegistry, type TechRegistry } from "../data/techtree";
import { loadUpgradeRegistry, type UpgradeRegistry } from "../data/upgrades";

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

/** A match seed for a game nobody specified one for (single player). Math.random is fine
 *  HERE and nowhere near the sim: this picks the seed, it doesn't roll off it. The Park-
 *  Miller LCG the sim uses wants a positive int below 2^31-1. */
function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 2147483645);
}

const UP = new Float32Array([0, 0, 1]); // WC3 world space is Z-up
const LEVEL_UP_FX = "Abilities\\Spells\\Other\\Levelup\\Levelupcaster.mdx"; // hero level-up nova
/** The shop indicator: the team-coloured arrow over whoever will receive the next purchase.
 *  `Targetattach=overhead` in the ability data, hence the attach token. See collectShopArrows
 *  for why this is AneuTarget and not the AneuCaster the data names first. */
const SHOP_ARROW_FX: BuffFx = { path: "Abilities\\Spells\\Other\\Aneu\\AneuTarget.mdx", attach: ["overhead"] };
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
const SPELL_SOUND_ART: Record<string, (d: AbilityDef) => string[]> = {
  AOmi: (d) => [d.specialArt],
};
// The looping bed a channelled area field lays down for as long as it runs. WC3 ships
// these WAVs beside the effect model but references them from no data field (MPQ
// HumanAbilityFunc.txt [AHbz] has no sound entry at all), so they're named here.
const FIELD_LOOP_SOUND: Record<string, string> = {
  AHbz: "Abilities\\Spells\\Human\\Blizzard\\BlizzardLoop1.wav", // 4s wind, looped for the 6s channel
  ANrf: "Abilities\\Spells\\Demon\\RainOfFire\\RainOfFireLoop1.wav", // the roar under the Pit Lord's waves
};
const CANCEL_BUILDING_REFUND = MISC_GAME.ConstructionRefundRate;
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
const DAWN_SOUND = "RoosterSound";
const DUSK_SOUND = "WolfSound";
const MAX_HEROES = MELEE.MELEE_HERO_LIMIT; // altars + tavern combined
const TAVERN_HIRE_TIME = 0; // tavern heroes are HIRED instantly — no build time, the hero just spawns (pops next tick)

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

export class MapViewerScene {
  // The game camera's shape — what the view opens at and what ResetToGameCamera returns to
  // (7.24).
  //
  // The LENS is the FOV field: 70° vertical (Scripts\Blizzard.j bj_CAMERA_DEFAULT_FOV), and a
  // camera setup's CAMERA_FIELD_FIELD_OF_VIEW is that same angle, applied literally.
  //
  // An earlier pass claimed the field (70) and the rendered lens (45°) were different quantities.
  // They aren't, and rendering at 45° is what made the game feel welded to the ground. Measured
  // against a real-client melee opening frame at 1920x1080 (the reference screenshot "human hud
  // and workers starting position"), where the camera is WC3's own default (distance 1650, AOA
  // -56°) and nothing is in doubt: the town hall's wall ring spans 320 px there. Through a 45°
  // lens it would span 480 — half again too big. The solve's own minimum is ~67°, and 70° puts
  // it at 308: within the error of picking a model's edges by eye. See docs/camera.md.
  //
  // A wrong lens does not announce itself as a wrong lens. Framing is distance × tan(fov/2), so
  // it announces itself as every distance in the game meaning the wrong thing — and as an urge
  // to keep "fixing" the zoom constants to compensate. Don't; fix the lens.
  private static readonly WC3_FOV_DEG = CAMERA.DEFAULT_FOV; // the field AND the lens
  private static readonly GAME_FOV = (MapViewerScene.WC3_FOV_DEG * Math.PI) / 180;
  private static readonly GAME_PITCH = 0.95; // ≈ 54.4° above the focus; WC3's AOA 304 is -56°

  // Orbit camera state.
  private target = new Float32Array([0, 0, 0]);
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
  // camera keeps our own defaults (45° FOV, no roll, far plane derived from the distance)
  // until a camera setup says otherwise, and ResetToGameCamera brings them back here.
  private fov = MapViewerScene.GAME_FOV;
  private roll = 0;
  private farZ = 0; // 0 = derive from the distance (the game camera's own rule)
  // The camera the map's SCRIPT drives: CameraSetupApply / PanCameraTo / SetCameraField all
  // blend the ONE camera above, over time (src/render/scriptCamera.ts).
  private scriptCam = new ScriptCamera(() => ({
    distance: MapViewerScene.MELEE_START,
    farZ: 0,
    aoaDeg: (-MapViewerScene.GAME_PITCH * 180) / Math.PI,
    // Degrees, the units a script speaks — and the units we render in (the field IS the lens).
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
  // Pre-placed map buildings paint their splat keyed by index (p<i>), not sim id, so the
  // sim-id reconcile can't prune them when destroyed. Track each with its world position
  // so we can reconcile it BY POSITION (issue #40): once a live sim building has been seen
  // at its spot, its later disappearance (the neutral shop/fountain was destroyed) removes
  // the decal. `seen` guards the progressive seed — the neutral unit loads a couple frames
  // after the splat is painted, so we must not remove it before it ever exists.
  private mapBuildingSplats = new Map<string, { x: number; y: number; seen: boolean }>();
  private mapSplatAccum = 0; // throttles the position reconcile (a few times/sec is plenty)
  private debug: DebugColliders | null = null; // debug collider overlay (lazy)
  private showColliders = false; // debug overlay toggle (bottom-right cheat button)
  private heightSampler: HeightSampler | null = null; // terrain height for the overlay
  private footMaxHeight: FootprintMaxSampler | null = null; // tallest terrain across a footprint (issue #15)
  // Building-placement footprint grid: rebuilt each frame while positioning a build and
  // drawn as its own colored-quad pass (reuses the debug-collider overlay). One quad per
  // blocked footprint cell — green where buildable, red where the pathing grid obstructs.
  private placeCells = new Float32Array(0);
  private placeCellVerts = 0;
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
  private gameMenu: GameMenu | null = null;
  private paused = false; // F10 game menu freezes the sim (rendering continues)
  private simAccum = 0; // unspent real time, in seconds, waiting to become whole sim steps
  /** Ticks elapsed since the match began. THE match clock — the number a multiplayer
   *  command is stamped with and a snapshot is taken at (docs/multiplayer.md). */
  private simTick = 0;
  /** Called when the player picks "End Game" — host tears the match down. */
  onExit: (() => void) | null = null;
  // --- the trigger's on-screen output (7.19) ---
  private textTags: TextTagOverlay | null = null; // CreateTextTag, drawn in the world
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
  // The speaker's animated bust during a transmission — its own bust viewer, on the FDF
  // panel's canvas, exactly like the HUD's portrait (which it must not steal).
  private cinePortraitViewer: ModelViewerScene | null = null;
  private cinePortraitFor = "";
  private dialog: GameDialogOverlay | null = null; // DialogCreate — and the melee end screen
  /** The game's own string table (UI\FrameDef\GlobalStrings.fdf) behind GetLocalizedString:
   *  blizzard.j writes the whole victory/defeat screen in its keys. Loaded once, lazily. */
  private globalStrings: FdfLibrary | null = null;
  private screen3 = new Float32Array(3); // scratch for the world→screen projection
  private world3 = new Float32Array(3);
  private minimap: HTMLCanvasElement | null = null;
  private iconCache = new Map<string, string | null>();
  private localPlayer = 0;
  private localRace: PlayableRace = "human";
  // Footprints of registered resource nodes, for unstamping on removal.
  private nodeFootprints = new Map<number, { fp: Footprint; x: number; y: number }>();
  // Fog footprint half-extent of each tree, keyed by its rounded world position — the
  // doodad widgets stream in async, so we can't hold instance refs here. Lets fogWidgets
  // light a tree from ANY cell it covers rather than one self-shadowed origin cell (#43).
  private treeFogRadius = new Map<string, number>();
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
  private cardPage: "root" | "build" | "learn" = "root";
  private lastSelected: number | null = null;
  private placement: { def: UnitDef; fp: Footprint | null; workerId: number } | null = null;
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
  // Custom maps only: the map's pre-placed player units (from war3mapUnits.doo) and
  // its own archive (to read war3map.j). startCustom seeds the units OWNED so the
  // local player has vision/control (issue #33) and runs the map's config() (Phase 7).
  private mapPlayerUnits: Array<{ x: number; y: number; owner: number }> = [];
  private mapArchive: MpqDataSource | null = null;
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
  private rallyFlag: SpawnInstance | null = null; // shown at the selected building's rally
  private rallyFlagModel: SpawnModel | null = null; // reused for the smaller queue flags
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
  private consoleSkinCache:
    | { consoleUrl: string; consoleAspect: number; clockUrl: string; clockAspect: number; timeUrl: string | null }
    | null
    | undefined;
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
    this.simBuildingSplats.clear();
    this.mapBuildingSplats.clear();
    this.rts?.dispose();
    this.rts = null;
    this.dayNight = null;
    this.lastMarkerScanCount = -1;
    this.rallyFlag = null;
    this.rallyFlagModel = null;
    this.queueFlags = [];

    this.viewer.loadMap(bytes);
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
    // Start near gameplay zoom rather than a whole-map overview — far better
    // draw performance and closer to WC3's default camera.
    this.distance = MapViewerScene.MELEE_START;

    // Stand up the simulation: terrain height + pathing from the map's own files.
    const archive = new MpqDataSource("map", bytes);
    this.mapArchive = archive; // kept so startCustom can read war3map.j (Phase 7 triggers)
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
      // Weather (7.23) — the map's rain/snow/fog particles. Its own pass, drawn last:
      // atmosphere sits between the eye and the world. Particles are born at
      // `height` above the GROUND, so it needs the same terrain sampler the sim uses.
      this.weatherSampler = makeHeightSampler(terrain);
      this.weather = new WeatherOverlay(this.viewer.gl, splatLoader, (x, y) => this.weatherSampler!(x, y));
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
      this.rts.setSoundBoard(this.sounds);
      this.rts.onRefuse = (key) => this.refuse(key); // refused orders → the gold line + error sound
      this.registerResourceNodes(nodes);
      this.rts.initVisionBlockers(makeCliffLevelSampler(terrain)); // fog LOS: only cliff LEVELS + treelines block sight (not rolling groundHeight)
      this.rts.setNeutralPassive(nodes.neutral); // yellow ring for shops/taverns/etc.
      this.rts.setPlacedFootprints(nodes.placedFootprints); // each map building's stamp → freed when it dies
      this.rts.setCreepData(nodes.creeps); // per-creep guard/aggro data (Neutral Hostile)
      this.mapPlayerUnits = nodes.players; // pre-placed player units → seeded owned in startCustom (issue #33)
    }
  }

  /** Feed harvestable trees and gold mines into the headless sim, remembering
   *  each node's stamped footprint so it can be unstamped on removal. */
  private registerResourceNodes(nodes: { trees: Array<{ x: number; y: number; pathTex: string }>; mines: Array<{ x: number; y: number; gold: number }> }): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    this.nodeFootprints.clear();
    this.treeFogRadius.clear();
    for (const t of nodes.trees) {
      // The tree's blocked extent doubles as its fog line-of-sight blocker, so a
      // 4x4Default tree shadows all four 64-unit vision cells it stands on (#43).
      const fp = this.footprintFor(t.pathTex);
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
  ): { trees: Array<{ x: number; y: number; pathTex: string }>; mines: Array<{ x: number; y: number; gold: number }>; neutral: Array<{ x: number; y: number }>; creeps: CreepSeed[]; players: Array<{ x: number; y: number; owner: number }>; placedFootprints: PlacedFootprint[] } {
    const placedFootprints: PlacedFootprint[] = []; // each map building's stamp, handed to its unit at seed time
    const trees: Array<{ x: number; y: number; pathTex: string }> = [];
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
        this.mapFog = makeFog(fi.fogHeight[0], fi.fogHeight[1], c[0] / 255, c[1] / 255, c[2] / 255);
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
      const pathTexOf = (id: string): string | undefined =>
        destr.getRow(id)?.string("pathTex") || dood.getRow(id)?.string("pathTex") || undefined;
      // Only SOLID doodads block: a mapmaker who unticks "Solid" (or places an open,
      // non-solid gate) means for units to walk through it, so its pathTex is not stamped.
      // WarChasers' gates and half its Force Walls are non-solid — stamping them anyway was
      // the phantom collider that isn't there in the World Editor.
      stampFootprints(grid, doodads.filter((d) => d.solid), pathTexOf, readBytes);
      for (const d of doodads) {
        const row = destr.getRow(d.id);
        // A harvestable tree still has to be solid to be a real tree — an invisible,
        // non-solid tree prop is deleted scenery, not something a wisp can chop.
        if (d.solid && row?.string("targType") === "tree") {
          trees.push({ x: d.x, y: d.y, pathTex: row.string("pathTex") || "" });
        }
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
          // Track it so the decal is pruned by position if the building is destroyed (issue #40).
          this.mapBuildingSplats.set(`p${i}`, { x: u.x, y: u.y, seen: false });
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
    return { trees, mines, neutral, creeps, players, placedFootprints };
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
    this.localPlayer = config.slots.find((s) => s.controller === "user")?.id ?? config.slots[0]?.id ?? 0;
    this.rts!.setLocalPlayer(this.localPlayer); // drag-box selects this player's units
    // Owner-line names for the hover tooltip: an AI slot reads "Computer (Normal)"
    // (the one difficulty we model, matching the Custom Game screen's label); a human
    // slot falls back to a generic "Player N" — the local player never shows an owner
    // line, so its own label is never seen.
    this.rts!.setPlayerNames(
      new Map(config.slots.map((s) => [s.id, s.controller === "computer" ? "Computer (Normal)" : `Player ${s.id + 1}`])),
    );
    // Open on the local player's base at gameplay zoom.
    const home = config.slots.find((s) => s.id === this.localPlayer);
    if (home) {
      this.target[0] = home.startX;
      this.target[1] = home.startY;
      this.distance = MapViewerScene.MELEE_START;
    }
    // Resolve "random" once per slot: roster and console skin must agree.
    const races = new Map(config.slots.map((s) => [s.id, resolveRace(s.race)]));
    this.localRace = races.get(this.localPlayer) ?? "human";
    this.meleeTeams = new Map(config.slots.map((s) => [s.id, s.team]));
    this.rts!.setLocalTeam(this.teamOf(this.localPlayer)); // whose combined sight lifts the fog
    // Seed the alliance matrix from those teams (7.22) BEFORE the map script runs, so the
    // script's own SetPlayerAlliance calls land on top of it rather than under it.
    this.rts!.seedAlliances((p) => this.teamOf(p));
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
  async startMelee(config: MeleeConfig): Promise<void> {
    if (!this.rts || !this.viewer.map) return;
    // Resources come from the script (MeleeStartingResources), so open empty.
    const races = this.beginMatch(config, 0, 0);
    this.rts.enableSeeding(); // owners/teams configured → trySeed may adopt the map's units
    await this.waitForMapUnits(); // …and the creeps/mines must all be in the sim before the script runs
    const engine = this.runMapScript({ melee: true, races, slots: config.slots });
    // No script (or it created nothing for the local player — a script that leans on
    // natives we haven't written yet): fall back to our own roster so the match still
    // starts, rather than dropping the player onto an empty map.
    const spawned = [...this.rts.simWorld.units.values()].some((u) => u.owner === this.localPlayer);
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
  private waitForMapUnits(timeoutMs = 30000): Promise<void> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      let settledFrames = 0;
      const poll = (): void => {
        const loaded = this.viewer.map?.unitsReady && this.viewer.promiseMap.size === 0;
        settledFrames = loaded ? settledFrames + 1 : 0;
        if (settledFrames >= 2 || performance.now() - t0 > timeoutMs) {
          if (settledFrames < 2) console.warn("[openwar3] map units still streaming after 30s — starting anyway.");
          resolve();
          return;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
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
    for (const m of this.rts?.simWorld.mines.values() ?? []) {
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
  async startCustom(config: MeleeConfig): Promise<void> {
    if (!this.rts || !this.viewer.map) return;
    // Custom maps get their starting resources from triggers (not the melee default),
    // so seed empty stashes; the map's own script grants gold/lumber where it wants.
    this.beginMatch(config, 0, 0);

    // Merge the map's custom object data (war3map.w3u units + war3map.w3a abilities)
    // into the registries so custom types (e.g. a Shandris-based hero) resolve for both
    // .doo adoption and trigger CreateUnit. Per-map overlay — cleared first.
    this.loadMapObjectData();

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
    this.rts.enableSeeding(); // owners/teams configured → trySeed may adopt the map's units
    await this.waitForMapUnits(); // …and every one of them must be adopted before the script runs

    // Run the map's own script (Phase 7). config() sets players/start-locations;
    // main() fires the map's initialization triggers, so its welcome text / quest
    // messages appear in the HUD message log.
    this.runMapScript({ melee: false, slots: config.slots });
    console.info(`[openwar3] Custom map: ${seeds.length} pre-placed player unit(s) seeded owned (issue #33).`);
  }

  /** The engine bridge the JASS interpreter calls into. A script `CreateUnit` inside
   *  CreateAllUnits only records its row (those units are already on the map, adopted from
   *  war3mapUnits.doo — the gate lives in the runtime now: Runtime.recordOnlySpawnFns);
   *  every other CreateUnit spawns for real. Only the LOCAL player's messages reach the
   *  HUD — the BJ force helpers already gate on GetLocalPlayer, so a per-player loop won't
   *  spam duplicates. */
  private textHooks(): EngineHooks {
    return {
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
      // --- the trigger's on-screen output (7.19) ---
      // GetLocalizedString → the game's own GlobalStrings.fdf table. Not cosmetic: the
      // melee victory/defeat dialog is written entirely in its keys, so without this the
      // player would be shown "GAMEOVER_VICTORY_MSG" instead of "Victory!".
      localizedString: (key) => this.globalStrings?.strings.get(key),
      // The quit button of the victory/defeat dialog. `doScoreScreen` asks for WC3's
      // post-game score screen (Glue\ScoreScreen.fdf) — we don't build one yet, so both
      // paths simply leave the match.
      endGame: () => {
        this.dialog?.update(null);
        this.paused = false;
        this.onExit?.();
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
      createUnit: (player, typeId, x, y, facing) => this.spawnScriptUnit(player, typeId, x, y, facing),
      // A gold mine isn't a sim unit for us, so RemoveUnit can't take it off the map —
      // and the only caller that tries is the Undead start's mine swap, which puts one
      // straight back (see CreateBlightedGoldmine). Leaving it standing IS the swap.
      removeUnit: (id) => {
        if (this.mineForScript(id)) return;
        this.rts?.removeUnit(id);
      },
      killUnit: (id) => this.rts?.killUnit(id),
      // Player resources: SetPlayerState/GetPlayerState → the sim stash. This is what
      // grants a custom map its starting gold/lumber (its init triggers set it). Food
      // is derived from units, so it's read-only. state: 1=gold 2=lumber 4=cap 5=used.
      setPlayerState: (p, state, value) => {
        const sw = this.rts?.simWorld;
        if (!sw) return;
        if (state === 1) sw.stashOf(p).gold = value;
        else if (state === 2) sw.stashOf(p).lumber = value;
      },
      getPlayerState: (p, state) => {
        if (!this.rts) return 0;
        if (state === 1) return Math.floor(this.rts.simWorld.stashOf(p).gold);
        if (state === 2) return Math.floor(this.rts.simWorld.stashOf(p).lumber);
        if (state === 4) return this.rts.foodFor(p).made; // FOOD_CAP
        if (state === 5) return this.rts.foodFor(p).used; // FOOD_USED
        return 0;
      },
      // Unit state: SetUnitState/GetUnitState → sim HP/mana. state: 0=life 1=maxlife 2=mana 3=maxmana.
      setUnitState: (id, state, value) => {
        const u = this.rts?.simWorld.units.get(id);
        if (!u) return;
        if (state === 0) u.hp = Math.max(0, Math.min(u.maxHp, value));
        else if (state === 1) u.maxHp = Math.max(1, value);
        else if (state === 2) u.mana = Math.max(0, Math.min(u.maxMana, value));
        else if (state === 3) u.maxMana = Math.max(0, value);
      },
      getUnitState: (id, state) => {
        const u = this.rts?.simWorld.units.get(id);
        if (!u) return 0;
        return state === 0 ? u.hp : state === 1 ? u.maxHp : state === 2 ? u.mana : state === 3 ? u.maxMana : 0;
      },
      // --- unit-mutation effects (7.7 cont.) — a trigger visibly moves/alters a unit ---
      setUnitPosition: (id, x, y) => this.rts?.simWorld.setUnitPosition(id, x, y),
      setUnitFacing: (id, rad, instant) => this.rts?.simWorld.setUnitFacing(id, rad, instant),
      // SetUnitOwner: reassign in the sim (team decides allegiance/vision), then re-tint
      // the team-coloured model parts to the new slot's colour if changeColor is set.
      setUnitOwner: (id, player, changeColor) => {
        if (!this.rts) return;
        this.rts.simWorld.setUnitOwner(id, player, this.teamOf(player));
        if (changeColor) this.rts.setUnitTeamColor(id, player);
      },
      setUnitColor: (id, color) => this.rts?.setUnitTeamColor(id, color),
      pauseUnit: (id, flag) => this.rts?.simWorld.pauseUnit(id, flag),
      isUnitPaused: (id) => this.rts?.simWorld.isUnitPaused(id) ?? false,
      setUnitScale: (id, scale) => this.rts?.setUnitScale(id, scale),
      setUnitVertexColor: (id, r, g, b, a) => this.rts?.setUnitVertexColor(id, r, g, b, a),
      // Fly height lives in two places: the sim (missile launch/land Z) and the render lift.
      setUnitFlyHeight: (id, height) => {
        this.rts?.simWorld.setUnitFlyHeight(id, height);
        this.rts?.setUnitFlyHeight(id, height);
      },
      getUnitFlyHeight: (id) => this.rts?.simWorld.getUnitFlyHeight(id),
      setUnitMoveSpeed: (id, speed) => this.rts?.simWorld.setUnitMoveSpeed(id, speed),
      getUnitMoveSpeed: (id) => this.rts?.simWorld.getUnitMoveSpeed(id),
      setUnitTurnSpeed: (id, turn) => this.rts?.simWorld.setUnitTurnSpeed(id, turn),
      setUnitTimeScale: (id, scale) => this.rts?.setUnitTimeScale(id, scale),
      // Position reads fall back to the mine table: to the script a gold mine IS a unit
      // (MeleeGetProjectedLoc measures the hall/worker clump off GetUnitLoc(nearestMine)).
      // `undefined` (not 0) when the unit is gone — the native then reads the handle's
      // last-known value instead of the map origin. See SimWorld.getUnitX.
      getUnitX: (id) => this.mineForScript(id)?.x ?? this.rts?.simWorld.getUnitX(id),
      getUnitY: (id) => this.mineForScript(id)?.y ?? this.rts?.simWorld.getUnitY(id),
      getUnitFacing: (id) => this.rts?.simWorld.getUnitFacing(id),
      // Orders (7.14): trigger issue → the sim; current order ← the sim.
      issueUnitOrder: (id, orderId, order, kind, x, y, targetId) => this.rts?.issueUnitOrder(id, orderId, order, kind, x, y, targetId) ?? false,
      getUnitCurrentOrder: (id) => this.rts?.currentOrderId(id) ?? 0,
      // Unit groups (7.16): every GroupEnumUnits* scan reads the live sim through here.
      // A dead unit is already out of SimWorld.units (it became a corpse), so an enum
      // only ever sees living units.
      enumUnits: () => this.unitSnapshots(),
      selectedUnits: (player) => (player === this.localPlayer ? this.rts?.selectedUnitIds() ?? [] : []),
      selectUnit: (id, select) => this.rts?.scriptSelect(id, select),
      clearSelection: () => this.rts?.clearSelection(),
      isUnitType: (id, t, typeId) => this.unitTypeIs(id, t, typeId),
      // IsUnitAlly/IsUnitEnemy: team-based, so neutral hostile (team -1) is nobody's ally.
      isUnitAlly: (id, player) => {
        const u = this.rts?.simWorld.units.get(id);
        return !!u && u.team >= 0 && u.team === this.teamOf(player);
      },
      // IsPlayerAlly/IsPlayerEnemy read the alliance matrix (7.22), not the raw lobby team
      // — a script that allies two players from different teams changes both.
      isPlayerAlly: (p, q) => this.rts?.playersAreCoAllied(p, q) ?? this.teamOf(p) === this.teamOf(q),
      // --- alliances + shared vision (7.22) ---
      setPlayerAlliance: (src, other, type, value) => this.rts?.setPlayerAlliance(src, other, type, value),
      getPlayerAlliance: (src, other, type) => this.rts?.getPlayerAlliance(src, other, type) ?? false,
      cripplePlayer: (player, toPlayers, flag) => this.rts?.cripplePlayer(player, toPlayers, flag),
      // --- fog of war: script-placed modifiers (7.22) ---
      createFogModifier: (player, state, area) => this.rts?.createFogModifier({ player, state, area }) ?? -1,
      fogModifierStart: (id) => this.rts?.fogModifierStart(id),
      fogModifierStop: (id) => this.rts?.fogModifierStop(id),
      destroyFogModifier: (id) => this.rts?.destroyFogModifier(id),
      setFogState: (player, state, area) => this.rts?.setFogState(player, state, area),
      fogEnable: (flag) => this.rts?.setFogEnabled(flag),
      fogMaskEnable: (flag) => this.rts?.setFogMaskEnabled(flag),
      // --- the atmospheric distance haze — a DIFFERENT system (7.22) ---
      // Replaces the map's w3i fog on `scene.distFog` (read fresh each frame, so this
      // lands next frame with no extra plumbing). Our shader is linear, which is all the
      // corpus asks for: every SetTerrainFogEx call in all 165 maps passes style 0.
      setTerrainFog: (_style, zstart, zend, _density, r, g, b) => {
        this.mapFog = makeFog(zstart, zend, r, g, b);
      },
      resetTerrainFog: () => {
        this.mapFog = this.w3iFog;
      },
      // --- way gates (7.22) ---
      waygateSetDestination: (id, x, y) => this.rts?.simWorld.setWaygateDestination(id, x, y),
      waygateActivate: (id, active) => this.rts?.simWorld.waygateActivate(id, active),
      waygateDestination: (id) => this.rts?.simWorld.waygateDestination(id) ?? null,
      waygateIsActive: (id) => this.rts?.simWorld.waygateIsActive(id) ?? false,
      // Bind a record-only CreateUnit row (inside CreateAllUnits) to the pre-placed unit
      // already standing there, so the script can keep configuring it (7.22).
      findPlacedUnit: (typeId, x, y) => this.findPlacedUnit(typeId, x, y),
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
      // Every camera MOVE is one call: the script names fields and (maybe) a destination,
      // and ScriptCamera blends the live camera there. The …ForPlayer BJs already gated on
      // GetLocalPlayer, so anything arriving here is for the human at this machine.
      // read → mutate → WRITE BACK. A zero-duration move lands NOW (see ScriptCamera.apply),
      // and the very next line of Monolith's trigger reads the camera straight back through
      // ResetToGameCamera — it must see the shot the line before it just applied.
      applyCamera: (move) => {
        const cam = this.readCamera();
        this.scriptCam.apply(move, cam);
        this.writeCamera(cam);
      },
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
      setCameraTargetUnit: (id, xOff, yOff) => {
        this.cameraLock = false; // the script's controller replaces the portrait's follow-lock
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
          this.hud?.clearOrderMode();
        }
      },
      setDawnDusk: (enable) => {
        if (this.rts) this.rts.simWorld.dawnDusk = enable;
      },
      isDawnDuskEnabled: () => this.rts?.simWorld.dawnDusk ?? true,
      // SetGameSpeed is RECORDED, not applied: WC3's five speeds are engine constants that
      // live in no data file we have, and guessing a multiplier would be exactly the kind of
      // invented number CLAUDE.md forbids. Recording it is still load-bearing — cinematic
      // mode saves GetGameSpeed on the way in and restores it on the way out, so a lying
      // getter would leave the map running at cinematic speed forever.
      setGameSpeed: (speed) => {
        this.gameSpeed = speed;
      },
      getGameSpeed: () => this.gameSpeed,
      isFogEnabled: () => this.rts?.isFogEnabled() ?? true,
      isFogMaskEnabled: () => this.rts?.isFogMaskEnabled() ?? true,
      displayCineFilter: (filter) => this.cinematic?.setFilter(filter),
      setCinematicScene: (scene) => {
        if (this.cinematic?.setScene(scene) && scene) void this.loadCinematicPortrait(scene.portraitUnitId);
      },
      pingMinimap: (ping) => this.hud?.ping(ping),
      // --- melee from the script (7.3) ---
      // MeleeStartingVisibility opens a melee game at 08:00 (bj_MELEE_STARTING_TOD).
      setTimeOfDay: (hour) => {
        if (this.rts) this.rts.simWorld.timeOfDay = hour;
      },
      getTimeOfDay: () => this.rts?.simWorld.timeOfDay ?? MELEE.MELEE_STARTING_TOD,
      // MeleeStartingUnits* frames the view on the starting WORKERS, not the hall.
      setCameraPosition: (x, y) => {
        this.target[0] = x;
        this.target[1] = y;
      },
      getResourceAmount: (id) => this.mineForScript(id)?.gold ?? 0,
      setResourceAmount: (id, amount) => {
        const mine = this.mineForScript(id);
        if (mine) mine.gold = amount;
      },
      // The Undead start's mine swap: our engine has no haunted mine, so hand back the
      // one still standing at (x, y) (RemoveUnit left it alone). Acolytes then clump
      // around a real mine instead of a null location.
      createBlightedGoldMine: (_player, x, y) => {
        const mine = this.nearestMineNode(x, y, MELEE.MELEE_MINE_SEARCH_RADIUS);
        return mine ? MapViewerScene.MINE_ID_BASE + mine.id : -1;
      },
      // Victory/defeat (MeleeInitVictoryDefeat): a melee player is beaten when their team
      // owns no structures, and "crippled" while they own no main hall.
      playerStructureCount: (player, includeIncomplete) => this.countUnits(player, includeIncomplete, (u) => !!u.building),
      playerUnitCount: (player, includeIncomplete) => this.countUnits(player, includeIncomplete, () => true),
      playerTypedUnitCount: (player, typeName, includeIncomplete, includeUpgrades) =>
        this.countUnits(player, includeIncomplete, (u) => this.unitIsTyped(u.typeId, typeName, includeUpgrades)),
      // --- the tech tree (issue #57) ---
      playerTechCount: (player, tech) => this.rts?.simWorld.tech?.count(player, tech) ?? 0,
      setPlayerTechResearched: (player, tech, level) => this.rts?.simWorld.tech?.setResearchLevel(player, tech, level),
      setPlayerTechMaxAllowed: (player, tech, max) => this.rts?.simWorld.tech?.setMaxAllowed(player, tech, max),
      // --- abilities + heroes (7.17): a trigger grants a spell / levels a hero ---
      unitAddAbility: (id, abilityId) => this.rts?.simWorld.addAbility(id, abilityId) ?? false,
      unitRemoveAbility: (id, abilityId) => this.rts?.simWorld.removeAbility(id, abilityId) ?? false,
      getUnitAbilityLevel: (id, abilityId) => this.rts?.simWorld.abilityLevelOf(id, abilityId) ?? 0,
      setUnitAbilityLevel: (id, abilityId, level) => this.rts?.simWorld.setAbilityLevel(id, abilityId, level) ?? 0,
      selectHeroSkill: (id, abilityId) => this.rts?.simWorld.learnAbility(id, abilityId) ?? false,
      resetUnitCooldown: (id) => this.rts?.simWorld.resetCooldowns(id),
      getUnitLevel: (id) => this.rts?.simWorld.units.get(id)?.level ?? 0,
      setHeroLevel: (id, level) => this.rts?.simWorld.setHeroLevel(id, level),
      getHeroXp: (id) => this.rts?.simWorld.units.get(id)?.xp ?? 0,
      setHeroXp: (id, xp) => this.rts?.simWorld.setHeroXp(id, xp),
      addHeroXp: (id, xp) => this.rts?.simWorld.addHeroXp(id, xp),
      getHeroSkillPoints: (id) => this.rts?.simWorld.units.get(id)?.skillPoints ?? 0,
      modifySkillPoints: (id, delta) => this.rts?.simWorld.modifySkillPoints(id, delta) ?? false,
      // --- per-unit flags + animation (7.17) ---
      setUnitInvulnerable: (id, flag) => this.rts?.simWorld.setInvulnerable(id, flag),
      setUnitPathing: (id, flag) => this.rts?.simWorld.setPathing(id, flag),
      setUnitAnimation: (id, animation) => this.rts?.setUnitAnimation(id, animation),
      // --- items (7.18): a trigger creates/gives/drops/uses an item ---
      // The sim already owns the item system (ground items, hero inventories, charges,
      // powerups, item abilities), so each of these is a one-line bridge into it. A
      // trigger-created item is spawned through the sim's normal ground-item queue, so the
      // renderer models it (drainItemSpawns) and a hero can walk over and pick it up.
      createItem: (typeId, x, y) => this.rts?.simWorld.createItem(typeId, x, y) ?? -1,
      removeItem: (id) => void this.rts?.simWorld.removeItemById(id),
      itemInfo: (id) => this.rts?.simWorld.itemSnapshot(id) ?? null,
      setItemCharges: (id, charges) => void this.rts?.simWorld.setItemCharges(id, charges),
      setItemPosition: (id, x, y) => void this.rts?.simWorld.setItemPosition(id, x, y),
      itemTypeInfo: (typeId) => {
        const d = this.items.get(typeId); // the ItemRegistry (custom .w3t overlay first)
        return d ? { name: d.name, level: d.level, classType: d.classType, powerup: d.powerup, sellable: d.sellable, pawnable: d.pawnable } : null;
      },
      // Neutral-building stock (issue #57): Blizzard.j stocks the Marketplace itself, off its
      // own 30s timer — these just hand its natives the shelves. See src/jass/natives/stock.ts.
      addToStock: (shopId, wareId, kind, count, max) => void this.rts?.simWorld.addToStock(shopId, wareId, kind, count, max),
      removeFromStock: (shopId, wareId) => void this.rts?.simWorld.removeFromStock(shopId, wareId),
      setTypeSlots: (shopId, kind, slots) => void this.rts?.simWorld.setTypeSlots(shopId, kind, slots),
      setAllTypeSlots: (kind, slots) => void this.rts?.simWorld.setAllTypeSlots(kind, slots),
      unitAddItem: (unitId, itemId, slot) => this.rts?.simWorld.unitAddItem(unitId, itemId, slot) ?? false,
      unitRemoveItem: (unitId, itemId) => this.rts?.simWorld.unitRemoveItem(unitId, itemId) ?? false,
      unitRemoveItemFromSlot: (unitId, slot) => this.rts?.simWorld.unitRemoveItemFromSlot(unitId, slot) ?? 0,
      unitDropItemPoint: (unitId, itemId, x, y) => this.rts?.simWorld.unitDropItemPoint(unitId, itemId, x, y) ?? false,
      unitDropItemSlot: (unitId, itemId, slot) => this.rts?.simWorld.unitDropItemSlot(unitId, itemId, slot) ?? false,
      unitDropItemTarget: (unitId, itemId, targetId) => this.rts?.simWorld.unitDropItemTarget(unitId, itemId, targetId) ?? false,
      unitUseItem: (unitId, itemId, targetId, x, y) => this.rts?.simWorld.unitUseItem(unitId, itemId, targetId, x, y) ?? false,
      unitInventorySize: (unitId) => this.rts?.simWorld.inventorySizeOf(unitId) ?? 0,
      unitItemInSlot: (unitId, slot) => this.rts?.simWorld.itemInSlot(unitId, slot) ?? 0,
      enumItems: () => this.rts?.simWorld.groundItems().map((it) => ({ id: it.id, typeId: it.itemId, charges: it.charges, x: it.x, y: it.y, holder: 0, slot: -1, owner: 15 })) ?? [],
      // ChooseRandomItem(Ex): draw from the registry's random-drop pool. The RNG is the
      // interpreter's seeded one, so the pick stays deterministic (replays / future MP).
      chooseRandomItem: (classType, level) => this.mapScript?.interp.rt.random
        ? this.items.chooseRandom(classType, level, this.mapScript.interp.rt.random)?.id ?? ""
        : "",
    };
  }

  /** The live sim units, as the interpreter's UnitSnapshot view (the region pump + group
   *  enumeration both scan this) — plus the gold mines, which are units to the script.
   *  Owners are translated to WC3's player slots (creeps are 12, neutrals 15 — see
   *  SimWorld.jassOwnerOf), because trigger code matches on exactly those. */
  private unitSnapshots(): UnitSnapshot[] {
    const snap: UnitSnapshot[] = [];
    if (!this.rts) return snap;
    for (const u of this.rts.simWorld.units.values()) {
      snap.push({ id: u.id, typeId: u.typeId, owner: jassOwnerOf(u), x: u.x, y: u.y, facing: u.facing });
    }
    for (const m of this.rts.simWorld.mines.values()) {
      snap.push({ id: MapViewerScene.MINE_ID_BASE + m.id, typeId: "ngol", owner: 15, x: m.x, y: m.y, facing: 0 });
    }
    return snap;
  }

  /** A gold mine, addressed the way the SCRIPT addresses it — as a unit. Our sim keeps
   *  mines in their own table (SimWorld.mines) with their own id counter, which would
   *  collide with unit ids, so the bridge offsets them into a range of their own. That
   *  fiction is what lets blizzard.j's MeleeFindNearestMine work: it enumerates units,
   *  keeps the nearest 'ngol', and clumps the starting workers 320 units off it. */
  private static readonly MINE_ID_BASE = 1_000_000;
  private mineForScript(unitId: number): SimMine | undefined {
    if (unitId < MapViewerScene.MINE_ID_BASE) return undefined;
    return this.rts?.simWorld.mines.get(unitId - MapViewerScene.MINE_ID_BASE);
  }
  /** Bind a PRE-PLACED `CreateUnit` row to the unit that is already standing there (7.22).
   *
   *  `CreateAllUnits()` is record-only for us — those units came in from war3mapUnits.doo
   *  and are adopted, not spawned (7.3) — but the script goes on configuring the handle it
   *  was just handed (`WaygateSetDestination`, `SetResourceAmount`, `SetUnitColor`), and
   *  until now that handle had no unit behind it, so every such call was silently dropped.
   *
   *  The match is by TYPE + POSITION: the script and the .doo carry the same coordinates
   *  for the same unit (they are two encodings of one placement), so the nearest unit of
   *  the right type within a tile is that unit. Searching the SNAPSHOT view rather than
   *  SimWorld.units means gold mines — which live in their own table and are only units to
   *  the script — are matched too, under the same MINE_ID_BASE id the rest of the bridge
   *  uses. -1 when nothing of that type stands there (a unit the .doo didn't carry). */
  private findPlacedUnit(typeId: string, x: number, y: number): number {
    let best = -1;
    let bestD = MapViewerScene.PLACED_MATCH_RADIUS ** 2;
    for (const u of this.unitSnapshots()) {
      if (u.typeId !== typeId) continue;
      const d = (u.x - x) ** 2 + (u.y - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = u.id;
      }
    }
    return best;
  }
  /** How far a pre-placed unit may sit from the coordinates its own script row names.
   *  They should agree exactly (same placement, two encodings) — a terrain tile of slack
   *  absorbs the sim's spawn re-settle without ever reaching the next unit over. */
  private static readonly PLACED_MATCH_RADIUS = 128;

  /** The SimMine nearest (x, y) within `radius` (the node, not our melee-roster helper). */
  private nearestMineNode(x: number, y: number, radius: number): SimMine | undefined {
    let best: SimMine | undefined;
    let bestD = radius * radius;
    for (const m of this.rts?.simWorld.mines.values() ?? []) {
      const d = (m.x - x) ** 2 + (m.y - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** GetPlayerStructureCount / GetPlayerUnitCount / GetPlayerTypedUnitCount (7.3) — how
   *  blizzard.j decides who has been defeated. `includeIncomplete` counts a building still
   *  under construction (WC3 does: a half-built town hall still keeps you in the game). */
  private countUnits(player: number, includeIncomplete: boolean, match: (u: SimUnit) => boolean): number {
    let n = 0;
    for (const u of this.rts?.simWorld.units.values() ?? []) {
      if (u.owner !== player || u.hp <= 0) continue;
      if (!includeIncomplete && u.building && u.building.constructionLeft > 0) continue;
      if (match(u)) n++;
    }
    return n;
  }

  /** Does this unit type answer to `typeName` (UnitUI.slk's `name`: "townhall", "footman")?
   *  With `includeUpgrades`, an upgraded building answers to its BASE type's name too —
   *  a Keep and a Castle are both "townhall", which is how MeleeGetAllyKeyStructureCount
   *  finds a player's main hall whatever tier it's at. */
  private unitIsTyped(typeId: string, typeName: string, includeUpgrades: boolean): boolean {
    const def = this.registry.get(typeId);
    if (!def) return false;
    if (def.typeName === typeName) return true;
    return includeUpgrades && (MAIN_HALL_CHAINS[typeName]?.includes(typeId) ?? false);
  }

  /** IsUnitType (7.16) — answer a unittype classification from the sim unit's flags.
   *  `t` is the common.j ConvertUnitType index. These are what a "matching unit" filter
   *  actually asks about ("is A structure", "is alive", "is A Hero", "is Summoned"); the
   *  classifications we hold no data for (ATTACKS_FLYING, GIANT, SAPPER, RESISTANT, …)
   *  read false rather than guess. Melee/ranged come from the weapon's `ranged` flag
   *  (UnitWeapons weapType: a missile weapon = a ranged attacker). */
  private unitTypeIs(id: number, t: number, typeId?: string): boolean {
    // A gold mine is a live Neutral Passive STRUCTURE, and it matters: MeleeClearExcessUnit
    // wipes the non-structure neutrals around a start location — so a mine that answered
    // "not a structure" (or "dead", the no-sim-unit default below) would be deleted.
    if (this.mineForScript(id)) return t === 2 || t === 4; // STRUCTURE, GROUND
    const u = this.rts?.simWorld.units.get(id);
    if (!u) return this.deadUnitTypeIs(t, typeId); // gone from the sim = a corpse — classify from its TYPE
    switch (t) {
      case 0: return u.isHero; // UNIT_TYPE_HERO
      case 1: return u.hp <= 0; // UNIT_TYPE_DEAD
      case 2: return !!u.building; // UNIT_TYPE_STRUCTURE
      case 3: return u.flying; // UNIT_TYPE_FLYING
      case 4: return !u.flying; // UNIT_TYPE_GROUND
      case 7: return !!u.weapon && !u.weapon.ranged; // UNIT_TYPE_MELEE_ATTACKER
      case 8: return !!u.weapon && u.weapon.ranged; // UNIT_TYPE_RANGED_ATTACKER
      case 10: return u.isSummon; // UNIT_TYPE_SUMMONED
      case 11: return u.stunned; // UNIT_TYPE_STUNNED
      case 14: return u.race === "undead"; // UNIT_TYPE_UNDEAD
      case 15: return u.mechanical; // UNIT_TYPE_MECHANICAL
      case 16: return u.isPeon; // UNIT_TYPE_PEON
      case 23: return u.asleep; // UNIT_TYPE_SLEEPING
      default: return false;
    }
  }

  /** IsUnitType for a unit the sim no longer has — it died and became a corpse. It is
   *  DEAD, and it is still whatever its TYPE says it is. This is not a nicety: the first
   *  thing blizzard.j does on a melee death is ask whether the dying unit was a STRUCTURE
   *  (MeleeTriggerActionUnitDeath), and answering "no, it's dead" meant a player who lost
   *  their last building was never defeated. Only the type-derived classifications can be
   *  answered here; the per-unit state ones (stunned, sleeping, summoned) are gone with it. */
  private deadUnitTypeIs(t: number, typeId?: string): boolean {
    if (t === 1) return true; // UNIT_TYPE_DEAD
    const def = typeId ? this.registry.get(typeId) : undefined;
    if (!def) return false;
    switch (t) {
      case 0: return def.isHero; // UNIT_TYPE_HERO
      case 2: return def.isBuilding; // UNIT_TYPE_STRUCTURE
      case 3: return def.moveType === MoveType.Fly; // UNIT_TYPE_FLYING
      case 4: return def.moveType !== MoveType.Fly; // UNIT_TYPE_GROUND
      case 14: return def.race === "undead"; // UNIT_TYPE_UNDEAD
      case 15: return def.classification.includes("mechanical"); // UNIT_TYPE_MECHANICAL
      case 16: return def.classification.includes("peon"); // UNIT_TYPE_PEON
      default: return false;
    }
  }

  /** Spawn a unit a trigger created via CreateUnit. JASS `CreateUnit` is SYNCHRONOUS —
   *  the very next statement may add an ability, set the hero's level, or order the unit
   *  somewhere — so the SIM unit is created right here, while the model (which loads
   *  async) attaches to it a few frames later (RtsController.addSimUnit/attachInstance).
   *  A script-created building is snapped to the build grid first, so its sim position
   *  matches the footprint the render path will stamp. JASS facing is in degrees; the sim
   *  wants radians. Returns -1 if the type id isn't in our data. */
  private spawnScriptUnit(player: number, typeId: string, x: number, y: number, facingDeg: number): number {
    const def = this.registry.get(typeId);
    if (!def || !this.rts) return -1;
    const fp = def.isBuilding && def.pathTex && this.grid ? this.footprintFor(def.pathTex) : null;
    if (fp && this.grid) [x, y] = this.grid.snapForBuildingRect(x, y, fp.w, fp.h);
    // A ground unit created ON a blocked cell — the classic "spawn a creep out of a
    // building" trigger passes the building's own centre — is displaced by WC3 to the
    // nearest free spot, so it emerges beside the structure rather than stuck inside it.
    // Snap it to the nearest cell its footprint fits, exactly as a freshly-trained unit
    // leaves its factory. Flyers and buildings are exempt (buildings snap above).
    if (!def.isBuilding && def.moveType !== MoveType.Fly && this.grid) {
      const n = footprintCells(def.collision || 16);
      const [cx, cy] = this.grid.worldToCell(x, y);
      if (!this.grid.footprintFits(cx, cy, n)) {
        const fit = this.grid.nearestFit(cx, cy, n) ?? this.grid.nearestWalkable(cx, cy);
        if (fit) [x, y] = this.grid.cellToWorld(fit[0], fit[1]);
      }
    }
    const facing = (facingDeg * Math.PI) / 180;
    const team = this.teamOf(player);
    const simId = this.rts.reserveUnitId();
    this.rts.addSimUnit(def, x, y, facing, player, team, 0, simId); // exists NOW
    void this.spawnUnit(def, x, y, player, team, 0, facing, simId); // …gets its body when the model lands
    return simId;
  }

  /** Merge the map's custom object data (war3map.w3u units + war3map.w3a abilities)
   *  into the registry overlays (Phase 7 — issue #33). Best-effort: a missing/bad file
   *  just means the map runs with base-game types only. Clears prior overlays first. */
  private loadMapObjectData(): void {
    this.registry.clearCustom();
    this.abilities.clearCustom();
    this.items.clearCustom();
    this.upgrades.clearCustom();
    if (!this.mapArchive) return;
    const wts = this.mapArchive.rawBytes("war3map.wts") ?? this.mapArchive.rawBytes("war3map\\wts") ?? undefined;
    try {
      const w3u = this.mapArchive.rawBytes("war3map.w3u") ?? this.mapArchive.rawBytes("war3map\\w3u");
      if (w3u) console.info(`[jass] custom object data: ${applyMapUnitData(this.registry, w3u, wts)} custom unit type(s) (war3map.w3u).`);
    } catch (err) {
      console.warn("[jass] custom unit data failed (non-fatal):", err);
    }
    try {
      const w3a = this.mapArchive.rawBytes("war3map.w3a") ?? this.mapArchive.rawBytes("war3map\\w3a");
      const meta = this.vfs.rawBytes("Units\\AbilityMetaData.slk");
      if (w3a && meta) console.info(`[jass] custom object data: ${applyMapAbilityData(this.abilities, w3a, meta, wts)} custom abilit(ies) (war3map.w3a).`);
    } catch (err) {
      console.warn("[jass] custom ability data failed (non-fatal):", err);
    }
    try {
      const w3t = this.mapArchive.rawBytes("war3map.w3t") ?? this.mapArchive.rawBytes("war3map\\w3t");
      if (w3t) console.info(`[jass] custom object data: ${applyMapItemData(this.items, w3t, wts)} custom item(s) (war3map.w3t).`);
    } catch (err) {
      console.warn("[jass] custom item data failed (non-fatal):", err);
    }
    try {
      const w3q = this.mapArchive.rawBytes("war3map.w3q") ?? this.mapArchive.rawBytes("war3map\\w3q");
      const meta = this.vfs.rawBytes("Units\\UpgradeMetaData.slk");
      if (w3q && meta) console.info(`[jass] custom object data: ${applyMapUpgradeData(this.upgrades, w3q, meta, wts)} custom upgrade(s) (war3map.w3q).`);
    } catch (err) {
      console.warn("[jass] custom upgrade data failed (non-fatal):", err);
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
          controller: s.controller === "computer" ? MAP_CONTROL.COMPUTER : MAP_CONTROL.USER,
          team: s.team,
          startLocation: -1, // config()'s SetPlayerStartLocation already placed each slot
        })),
        localPlayer: this.localPlayer,
      };
      const engine = loadMapScript(this.vfs, this.mapArchive, {
        melee: opts.melee,
        runMain: true,
        hooks: this.textHooks(),
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
      // Unit-state thresholds (EVENT_UNIT_STATE_LIMIT) are POLLED — nothing in the sim
      // raises "life dropped below 100", so the interpreter tests each watched unit itself.
      if (this.scriptWatchesUnitState) engine.interp.pumpUnitStates();
      // Enter/leave-region — only snapshot the world if some trigger watches a region.
      if (engine.interp.rt.triggerRegs.some((r) => r.kind === "enterRegion" || r.kind === "leaveRegion")) {
        engine.interp.pumpRegions(this.unitSnapshots());
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
        const x = this.rts.simWorld.getUnitX(s.attachUnit);
        const y = this.rts.simWorld.getUnitY(s.attachUnit);
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
    // A fresh match starts out of any cinematic the last one may have ended in.
    this.interfaceShown = true;
    this.userUi = true;
    this.userControl = true;
    this.gameSpeed = 2; // MAP_SPEED_NORMAL
    this.cinePortraitFor = "";
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
    this.leaderboard = new LeaderboardOverlay(ui, this.vfs, skin);
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
        this.dialog?.update(null);
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
      void lib.load("UI\\FrameDef\\UI\\LeaderBoard.fdf").then(() => (this.globalStrings = lib));
    }
  }

  /** Drive the script's on-screen output for this frame. Runs on the RENDER clock (a text
   *  tag must keep tracking its unit and the camera while the game is paused), while its
   *  ageing/drift/expiry run on the SIM tick inside the interpreter — so a paused game
   *  leaves the text hanging exactly where it was rather than freezing it off-screen. */
  private updateScriptUi(): void {
    const engine = this.mapScript;
    if (!engine || !this.rts) return;
    const rt = engine.interp.rt;

    if (this.textTags) {
      if (rt.textTags.length) this.textTags.update(rt.textTags, this.textTagContext());
      else this.textTags.clear();
    }
    this.leaderboard?.update(rt.leaderboardFor(this.localPlayer));
    // The three top-right panels stack, in the order WC3 stacks them: leaderboard, then
    // multiboard, then the countdown windows — each hangs below whatever the ones above it
    // are already using, so they never overlap.
    const underBoard = this.leaderboard?.occupiedHeight() ?? 0;
    this.multiboard?.update(rt.multiboards, rt.multiboardSuppressed, underBoard ? underBoard + TIMER_STACK_GAP : 0);
    // Countdown windows stack below both (7.21). Their TIME isn't pushed — it's read live
    // off each dialog's timer, so this runs every frame, not just when something changed.
    if (this.timerDialogs) {
      const below = underBoard + (this.multiboard?.occupiedHeight() ?? 0);
      this.timerDialogs.update(rt.timerDialogs, (td) => rt.timerDialogSeconds(td), below ? below + TIMER_STACK_GAP : 0);
    }
    this.dialog?.update(rt.dialogs.find((d) => d.visibleFor.has(this.localPlayer)) ?? null);
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
      uiScale: (this.canvas.clientHeight || GAME_HEIGHT) / UI_HEIGHT,
      groundHeight: (x, y) => rts.groundHeightAt(x, y),
      unitAt: (simId) => {
        const u = rts.simWorld.units.get(simId);
        return u ? { x: u.x, y: u.y, flyHeight: rts.simWorld.getUnitFlyHeight(simId) ?? 0 } : null;
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
    const fp = this.rts?.simWorld.units.get(buildingId)?.pathStamp?.fp;
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
    const su = this.rts.simWorld.units.get(simId);
    if (!su || su.hp <= 0) return; // died while the new model streamed in
    const model = await this.viewer.load(def.model, this.solver);
    if (!model) return;
    const instance = model.addInstance();
    instance.setScene(map.worldScene);
    instance.setTeamColor(su.owner);
    if (!this.rts.remodel(simId, instance, def)) {
      instance.hide(); // the unit went away while we were loading
      return;
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

    const model = await this.viewer.load(def.model, this.solver);
    if (!model) return null;
    const instance = model.addInstance();
    instance.setScene(map.worldScene);
    instance.setTeamColor(owner); // player slot doubles as team color for now
    const simId = this.rts.addUnit(instance, def, x, y, facing, owner, team, constructionTime, reservedId); // default: face south
    // -1: the sim unit this model was loading for is already gone (a trigger created and
    // then removed it while the model streamed). Drop the model rather than leave a ghost.
    if (simId < 0) {
      instance.hide();
      return null;
    }

    // Buildings block pathing: stamp their footprint so units route around them.
    if (fp && this.grid) {
      stampFootprint(this.grid, fp, x, y);
      // The sim owns the stamp from here: it frees those cells the moment the building
      // leaves the world (death, RemoveUnit, cancelled construction).
      this.rts.simWorld.setPathStamp(simId, fp, x, y);
      // Seat the structure on the tallest terrain its footprint spans so it never
      // clips into a small hill/slope (issue #15). Half-extents in world units:
      // footprint cells are PATHING_CELL (32u) wide, centred on (x, y).
      this.rts.setBuildingFootprint(simId, (fp.w * PATHING_CELL) / 2, (fp.h * PATHING_CELL) / 2);
    }
    // Paint the building's ground texture (ubersplat) on the terrain under it. Tracked
    // so it's removed when the building is destroyed (reconcile) or cancelled.
    if (def.isBuilding && def.uberSplat) {
      this.simBuildingSplats.add(simId);
      this.addBuildingSplat(simId, def, x, y);
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
    let [x, y] = hit;
    if (p.fp) [x, y] = this.grid.snapForBuildingRect(x, y, p.fp.w, p.fp.h);
    // A refused placement keeps the building on the cursor, exactly like a refused cast
    // keeps the reticle: the player gets told why and clicks again, without re-picking the
    // building off the card.
    if (!this.placementValid(x, y)) {
      this.refuse("Cantplace"); // "Unable to build there." — the worker says so out loud
      return;
    }
    if (!this.canAfford(p.def.goldCost, p.def.lumberCost)) return;
    const stash = this.rts.stashFor(this.localPlayer);
    stash.gold -= p.def.goldCost;
    stash.lumber -= p.def.lumberCost;
    // Carry the spent cost on the order so the sim can refund it if the build is
    // ever abandoned before construction begins (re-tasked, killed, timed out).
    const order: QueuedOrder = { kind: "buildnew", defId: p.def.id, x, y, gold: p.def.goldCost, lumber: p.def.lumberCost };
    if (queued) this.rts.simWorld.queueOrder(p.workerId, order);
    else this.rts.simWorld.issueOrder(p.workerId, order); // walk there now
    this.sounds?.playUi("PlaceBuildingDefault"); // WC3 building-placement confirm
    this.cardPage = "root";
    this.cancelPlacement();
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
      const pb = w.buildPending;
      if (!pb || w.owner !== this.localPlayer || this.buildSpawning.has(w.id)) continue;
      if (Math.hypot(w.x - pb.x, w.y - pb.y) >= 160 || w.moving) { this.buildWait.delete(w.id); continue; } // not there yet
      const def = this.registry.get(pb.defId);
      if (!def) { world.cancelPendingBuild(w.id); this.buildWait.delete(w.id); continue; }
      const fp = def.pathTex ? this.footprintFor(def.pathTex) : null;
      const occupants = fp ? this.footprintOccupants(fp, pb.x, pb.y, w.id) : [];
      if (occupants.length === 0) {
        // Site clear (only the builder was there) → raise the foundation.
        this.buildWait.delete(w.id);
        const workerId = w.id;
        this.buildSpawning.add(workerId);
        void this.spawnUnit(def, pb.x, pb.y, this.localPlayer, this.teamOf(this.localPlayer), def.buildTime || 60).then((simId) => {
          this.buildSpawning.delete(workerId);
          if (simId !== null) world.assignBuilder(workerId, simId); // clears buildPending
          else world.cancelPendingBuild(workerId); // model failed to load → refund
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
    const u = world.units.get(simId);
    if (!u) return;
    if (rally.kind === "mine" && u.worker?.gold && world.mines.has(rally.targetId)) {
      if (world.issueHarvest(simId, "gold", rally.targetId)) return;
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
    // Rally flag shown at a selected building's rally point.
    const flag = (await this.viewer.load("UI\\Feedback\\RallyPoint\\RallyPoint.mdx", this.solver)) as SpawnModel | undefined;
    if (flag && map) {
      this.rallyFlagModel = flag; // reused to spawn the small queue-flag pool
      this.rallyFlag = flag.addInstance();
      this.rallyFlag.setScene(map.worldScene);
      this.rallyFlag.setSequence(0); // play its waving clip so the flag animates
      this.rallyFlag.setSequenceLoopMode(2); // loop always
      this.rallyFlag.hide();
    }
  }

  /** Get (or lazily create) the i-th small queue flag — the rally-point model at
   *  a reduced scale, one per queued order of the current selection. */
  private queueFlag(i: number): SpawnInstance | null {
    const scene = this.viewer.map?.worldScene;
    if (!this.rallyFlagModel || !scene) return null;
    while (this.queueFlags.length <= i) {
      const inst = this.rallyFlagModel.addInstance();
      inst.setScene(scene);
      inst.setSequence(0);
      inst.setSequenceLoopMode(2); // loop the waving clip
      inst.setUniformScale(0.6); // smaller than the full rally flag
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

  /** Reconcile the looping bed of every running channelled field against last frame:
   *  start one for each new field, stop the ones whose field is gone. Keyed by code +
   *  position so two simultaneous Blizzards each howl at their own spot. */
  private updateFieldLoops(fields: Array<{ code: string; x: number; y: number }>): void {
    const live = new Set<string>();
    for (const f of fields) {
      const wav = FIELD_LOOP_SOUND[f.code];
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
    if (!model || !map || !this.rts?.simWorld.items.has(itemId) || this.itemInstances.has(itemId)) return;
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
    for (const [key, inst] of this.buffFx) {
      if (!active.has(key)) this.dropBuffFx(key, inst);
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
      this.trackBuffFx(active, key, SHOP_ARROW_FX, unitId, this.localPlayer);
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
  private trackBuffFx(active: Set<string>, key: string, fx: BuffFx, simId: number, teamColor?: number): void {
    if (!fx.path) return;
    active.add(key);
    const inst = this.buffFx.get(key);
    if (inst) {
      this.settleBuffFx(key, inst);
      if (this.buffFxParented.has(key)) return; // rides its attachment node
      const u = this.rts?.simWorld.units.get(simId);
      if (u) {
        this.loc3[0] = u.x;
        this.loc3[1] = u.y;
        this.loc3[2] = this.rts!.groundHeightAt(u.x, u.y);
        inst.setLocation(this.loc3);
      }
    } else if (!this.buffFxLoading.has(key)) {
      this.buffFxLoading.add(key);
      void this.spawnBuffFx(key, fx, simId, teamColor);
    }
  }

  private async spawnBuffFx(key: string, fx: BuffFx, simId: number, teamColor?: number): Promise<void> {
    const path = fx.path;
    let model = this.effectModels.get(path);
    if (model === undefined) {
      model = ((await this.viewer.load(path, this.solver)) as SpawnModel | undefined) ?? null;
      this.effectModels.set(path, model);
    }
    this.buffFxLoading.delete(key);
    const map = this.viewer.map;
    const u = this.rts?.simWorld.units.get(simId);
    if (!model || !map || !u || u.hp <= 0 || this.buffFx.has(key)) return;
    const inst = model.addInstance();
    inst.setScene(map.worldScene);
    // Team-coloured art (the shop arrow) resolves its `replaceableId 1` layer against the
    // owning player's slot, the same way a unit model does.
    if (teamColor !== undefined) inst.setTeamColor?.(teamColor);
    const host = this.rts?.unitInstance(simId) as unknown as SpawnInstance | undefined;
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
      inst.setSequence(this.effectSequence(inst));
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
    const u = this.rts?.simWorld.units.get(unitId);
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
    const u = fx.hostId >= 0 ? this.rts?.simWorld.units.get(fx.hostId) : undefined;
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
      if (fx.hostId >= 0 && !this.rts?.simWorld.units.has(fx.hostId)) {
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
    const u = this.rts?.simWorld.units.get(simId);
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

  // A tree that is being chopped or has been felled is drawn by a spawned, scene-animated
  // stand-in instance keyed by its (static) placed doodad — because War3MapViewer never
  // advances a placed doodad's animation and Widget.update resets any sequence we set on it,
  // so its "stand hit"/"death" clips can't play in place. The stand-in hides the static
  // doodad and plays the clips; a felled tree's stand-in holds the final "death" frame — the
  // cut stump WC3 leaves behind. `revertEnd` (>0) is the wobble's end frame, when we drop it
  // back to the looping "stand"; `dead` stumps are held forever.
  private treeActors = new Map<HideableWidget, { inst: SpawnInstance; dead: boolean; revertEnd: number }>();

  /** The scene-animated stand-in for a tree doodad, spawned (and the static doodad hidden)
   *  on first use. null if the doodad has no spawnable model. */
  private treeActor(widget: HideableWidget): { inst: SpawnInstance; dead: boolean; revertEnd: number } | null {
    let a = this.treeActors.get(widget);
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
    a = { inst, dead: false, revertEnd: 0 };
    this.treeActors.set(widget, a);
    return a;
  }

  /** Play each chopped tree's "stand hit" wobble once per chop (SimWorld.drainTreeHits),
   *  then settle it back to "stand". WC3 trees visibly shudder at every axe blow. */
  private updateTreeActors(): void {
    const map = this.viewer.map;
    const world = this.rts?.simWorld;
    if (!map || !world) return;
    for (const h of world.drainTreeHits()) {
      const w = this.nearestDoodadWidget(h.x, h.y, map.doodads);
      if (!w) continue;
      const a = this.treeActor(w);
      if (!a || a.dead) continue;
      const hit = this.seqByName(a.inst.model.sequences, /stand hit/i);
      if (hit < 0) continue;
      a.inst.setSequence(hit);
      a.inst.setSequenceLoopMode(0); // play the wobble once
      a.revertEnd = a.inst.model.sequences[hit].interval?.[1] ?? 0;
    }
    for (const a of this.treeActors.values()) {
      if (a.dead || a.revertEnd <= 0 || a.inst.frame < a.revertEnd) continue; // wobble still playing
      const stand = this.seqByName(a.inst.model.sequences, /^stand$/i);
      if (stand >= 0) {
        a.inst.setSequence(stand);
        a.inst.setSequenceLoopMode(2); // settle into the looping idle
      }
      a.revertEnd = 0;
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
    const a = this.treeActor(w);
    if (!a) {
      w.instance.hide(); // no spawnable model — just remove the tree
      this.removedWidgets.add(w);
      return;
    }
    const death = this.seqByName(a.inst.model.sequences, /death/i);
    if (death >= 0) {
      a.inst.setSequence(death);
      a.inst.setSequenceLoopMode(0); // play once; the last frame is the stump, held forever
    }
    a.dead = true;
    a.revertEnd = 0;
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
    info: { x: number; y: number; z: number; radius: number; owner: number; team: number; neutral?: boolean; isBuilding?: boolean } | null,
    tint: number[] | null,
    dim: boolean,
    live: Set<string>,
  ): void {
    if (!this.ringSplats || !info) return;
    // Ring colour — same rules as the old flat model: flashes carry their own tint off a
    // white base; real rings colour by alliance (own/allied green, else red; neutral-
    // passive yellow). The overlay MULTIPLIES this into the (white) ring texture.
    let vcolor: number[];
    if (tint) {
      vcolor = tint;
    } else if (info.neutral) {
      vcolor = MapViewerScene.NEUTRAL_RING_TINT;
    } else {
      const friendly = info.owner === this.localPlayer || info.team === this.teamOf(this.localPlayer);
      vcolor = friendly ? MapViewerScene.FRIENDLY_RING_TINT : MapViewerScene.ENEMY_RING_TINT;
    }
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
      if (on) this.addRing(`flash-${f.id}`, { x: f.x, y: f.y, z: 0, radius: f.radius, owner: -2, team: -2 }, f.color, false, live);
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
  // real game only because the lens does too (GAME_FOV = the 70° field) — the two are one knob:
  // what you see is distance × tan(fov/2). A match opens on WC3's own default distance, 1650
  // (bj_CAMERA_DEFAULT_DISTANCE), which through the 70° lens IS the real client's opening view;
  // the wheel then runs from a close 1250 out to 2400. (WC3's own wheel stops are not documented
  // anywhere we trust, so the range is ours; the DEFAULT it opens on is not.)
  private static readonly ZOOM_MIN = 1250;
  private static readonly ZOOM_MAX = 2400;
  private static readonly MELEE_START = CAMERA.DEFAULT_DISTANCE;
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
      const ang = t ? Math.atan2(t.y - p.y, t.x - p.x) : 0;
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
    document.addEventListener("fullscreenchange", sync);
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

  /** Command-card icon (BLP path) of the local race's worker, for the idle button. */
  private workerIcon(): string | null {
    const workerId = (STARTING_UNITS[this.localRace] ?? []).map((s) => s.id).find((id) => WORKERS[id]);
    return (workerId && this.registry.get(workerId)?.icon) || null;
  }


  /** Every cell of the building's full (blue) pathTex footprint must be buildable.
   *  We test the UNBUILDABLE footprint — not just the unwalkable red core — so a
   *  building's walkable border still reserves build space: that border is what
   *  keeps two production buildings' cores apart, leaving the corridor units pass
   *  through. Terrain (cliffs/water/unbuildable margins) and other buildings' blue
   *  footprints block; movable-unit reservations do NOT (they scatter on arrival). */
  private placementValid(x: number, y: number): boolean {
    const p = this.placement;
    if (!p || !this.grid || !p.fp) return true;
    const [bx, by] = this.grid.worldToCell(x - (p.fp.w * 32) / 2, y - (p.fp.h * 32) / 2);
    for (let cy = 0; cy < p.fp.h; cy++) {
      for (let cx = 0; cx < p.fp.w; cx++) {
        if (!p.fp.buildBlocked[cy * p.fp.w + cx]) continue;
        if (!this.grid.buildable(bx + cx, by + cy)) return false;
      }
    }
    return true;
  }

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
    let [x, y] = hit;
    const fp = this.placement.fp;
    if (fp) [x, y] = this.grid.snapForBuildingRect(x, y, fp.w, fp.h);
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
    if (fp && this.footMaxHeight) {
      return this.footMaxHeight(x, y, (fp.w * PATHING_CELL) / 2, (fp.h * PATHING_CELL) / 2);
    }
    return this.rts?.groundHeightAt(x, y) ?? 0;
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
          }
        }
        if (!reserved) continue;
        const color = blocked ? COLLIDER_COLORS.unbuildable : COLLIDER_COLORS.buildable;
        const x0 = ox + (bx + sx) * PATHING_CELL, y0 = oy + (by + sy) * PATHING_CELL;
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
        return {
          gold: stash.gold,
          lumber: stash.lumber,
          foodUsed: food.used,
          foodMax: food.made,
        };
      },
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
      dayNight: () => this.rts?.timeOfDay() ?? { hour: MELEE.MELEE_STARTING_TOD, isDay: true },
      mountClock: (slot) => this.mountClock(slot),
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
        if (this.rts?.recallGroup(key) && jump) this.jumpToSelection();
      },
      selectHero: (index, jump) => {
        if (this.rts?.selectHero(index) && jump) this.jumpToSelection();
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
      consoleSkin: () => this.consoleSkin(),
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
    this.hud = new GameHud(ui, driver);
    this.mountScriptUi(ui);
    this.gameMenu?.dispose();
    this.gameMenu = new GameMenu(ui, {
      onReturn: () => {
        this.gameMenu?.hide();
        this.paused = false;
      },
      onEndGame: () => {
        this.gameMenu?.hide();
        this.paused = false;
        this.onExit?.();
      },
    });
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

  /** The console tiles are a texture ATLAS (verified by rendering it out): the
   *  bottom band (y≈180–512) is the console proper (minimap frame, portrait
   *  arch, inventory, command card), and the day/night clock is a round
   *  medallion at the top-centre. Crop the console band (kept at its natural
   *  aspect — never stretched; letterboxed on widescreen) and the clock
   *  separately so the clock isn't cut off by the thin top bar. */
  private consoleSkin(): { consoleUrl: string; consoleAspect: number; clockUrl: string; clockAspect: number; timeUrl: string | null } | null {
    if (this.consoleSkinCache !== undefined) return this.consoleSkinCache;
    const dirs: Record<PlayableRace, string> = { human: "Human", orc: "Orc", undead: "Undead", nightelf: "NightElf" };
    const dir = dirs[this.localRace];
    const tiles: HTMLCanvasElement[] = [];
    for (let i = 1; i <= 4; i++) {
      const bytes = this.vfs.rawBytes(`UI\\Console\\${dir}\\${dir}UITile0${i}.blp`);
      const tile = bytes ? blpToCanvas(bytes) : null;
      if (!tile) {
        this.consoleSkinCache = null; // fall back to the CSS skin
        return null;
      }
      tiles.push(tile);
    }
    const width = tiles.reduce((sum, t) => sum + t.width, 0);
    const height = tiles[0].height;
    const atlas = document.createElement("canvas");
    atlas.width = width;
    atlas.height = height;
    const ctx = atlas.getContext("2d")!;
    let x = 0;
    for (const tile of tiles) {
      ctx.drawImage(tile, x, 0);
      x += tile.width;
    }
    // Crop a sub-rect of the atlas to its own data URL.
    const crop = (sx: number, sy: number, sw: number, sh: number): string => {
      const c = document.createElement("canvas");
      c.width = sw;
      c.height = sh;
      c.getContext("2d")!.drawImage(atlas, -sx, -sy);
      return c.toDataURL();
    };
    const consoleY = Math.round(height * 0.352); // ~180/512 — top of the console chrome
    const consoleH = height - consoleY;
    // Clock medallion: a SQUARE crop centred on the socket so the round frame
    // isn't distorted (the medallion is circular; a wide crop squished it).
    const clockSize = Math.round(height * 0.24);
    const clockX = Math.round(width * 0.5 - clockSize / 2);
    const clockW = clockSize;
    const clockH = clockSize;
    // The rotating sun/moon disc that sits inside the clock ring (Blizzard kept
    // the "Human" filename inside every race folder).
    const timeUrl = this.blpIcon(`UI\\Console\\${dir}\\HumanUITile-TimeIndicator.blp`);
    this.consoleSkinCache = {
      consoleUrl: crop(0, consoleY, width, consoleH),
      consoleAspect: width / consoleH,
      clockUrl: crop(clockX, 0, clockW, clockH),
      clockAspect: clockW / clockH,
      timeUrl,
    };
    return this.consoleSkinCache;
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
    // Team glow follows the owner; 12 is the classic neutral (black) slot. The
    // `portrait` flag makes the viewer loop the model's "Portrait" idle clip
    // instead of walk/stand (portrait models have no walk — a stray one on some
    // heroes was being picked, so the bust just froze).
    // The Paladin's authored portrait camera crops the right of his face — pan
    // the bust camera a bit left so the whole face shows.
    const panLeft = /paladin/i.test(sel.model) ? 0.14 : 0;
    this.portraitViewer
      .load(path, sel.owner >= 0 ? sel.owner : 12, true, panLeft)
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

  /** The HUD is on screen only when the interface (ShowInterface) AND the UI (EnableUserUI)
   *  are both on. Two natives, two different jobs — the letterbox hides the console for the
   *  duration of a cinematic; EnableUserUI hides everything for the duration of a fade. */
  private syncHudVisible(): void {
    if (this.interfaceShown && this.userUi) this.hud?.show();
    else this.hud?.hide();
  }

  /** The speaker's animated bust, on the cinematic panel's own canvas. Same machinery as the
   *  HUD's portrait (a `_Portrait.mdx` looping its Portrait clip) but a SEPARATE viewer —
   *  the two are on screen at once during a transmission in ordinary play, and one would
   *  otherwise steal the other's canvas.
   *
   *  `typeId` is a unit TYPE, not a unit: a transmission shows the portrait of whatever the
   *  speaker IS (SetCinematicScene takes a unit-type rawcode), so a Footman speaking always
   *  shows the Footman bust. */
  private async loadCinematicPortrait(typeId: string): Promise<void> {
    const panel = this.cinematic;
    if (!panel || !typeId) return;
    const def = this.registry.get(typeId);
    if (!def?.model) return;
    const canvas = panel.portraitCanvas();
    this.cinePortraitViewer ??= new ModelViewerScene(canvas, this.vfs);
    if (this.cinePortraitFor === typeId) {
      this.cinePortraitViewer.start(); // same speaker again — just wake the bust
      return;
    }
    const portraitPath = def.model.replace(/\.mdx$/i, "_Portrait.mdx");
    const path = this.vfs.exists(portraitPath) ? portraitPath : def.model;
    try {
      await this.cinePortraitViewer.load(path, 12, true, 0);
      this.cinePortraitFor = typeId;
      this.cinePortraitViewer.start();
    } catch {
      /* no bust for this type — the panel just shows an empty pane */
    }
  }

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
    for (const u of this.rts.simWorld.units.values()) consider(u.typeId);
    // Everything the local player is likely to make: what their worker builds, and what each
    // of those buildings trains or becomes.
    const workerId = (STARTING_UNITS[this.localRace] ?? []).map((s) => s.id).find((id) => WORKERS[id]);
    for (const bid of workerId ? this.tech.builds(workerId) : []) {
      consider(bid);
      for (const uid of this.tech.trains(bid)) consider(uid); // units this building trains
      for (const uid of this.tech.upgradesTo(bid)) consider(uid); // and what it upgrades into
    }
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
    const b: CommandButton = { id: "", icon: null, name: "", hotkey: "", desc: "", gold: 0, lumber: 0, food: 0, mana: 0, col: 0, row: 0, disabled: false, active: false, ...over };
    b.desc = this.tipText(b.desc);
    if (b.tip) b.tip = this.tipText(b.tip);
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
      // Altars the player owns + neutral shops (taverns) they hire from.
      if (u.building && (u.owner === player || u.neutralPassive)) {
        for (const job of u.building.queue) {
          if (job.kind === "unit" && this.registry.get(job.unitId)?.isHero) set.add(job.unitId);
        }
      }
    }
    return set;
  }

  /** Units this building trains (`Trains`) or SELLS (`Sellunits` — a Tavern's heroes, a
   *  Mercenary Camp's creeps). Both end up in the same production queue; the difference is
   *  that a sold unit comes off the shop's stock and shouts to the creeps around it. */
  private pushTrainButtons(sel: SelectionInfo, out: CommandButton[]): void {
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
    // flows to the next free cell (WC3 packs them left-to-right). The bottom-right corner is
    // kept clear for Rally (3,1) and Cancel (3,2). rtma-replaced units (Headhunter↔Berserker)
    // never both show, so those don't count as collisions.
    const used = new Set<string>(["3,1", "3,2"]);
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
      const freeHero = d.isHero && !this.freeHeroUsed.has(this.localPlayer); // first hero is free
      const gold = freeHero ? 0 : d.goldCost;
      const lumber = freeHero ? 0 : d.lumberCost;
      const stock = sold.has(uid) ? world.shopStock(sel.id, uid) : -1;
      const metTech = world.canMake(this.localPlayer, uid, owned);
      const afford = stash.gold >= gold && stash.lumber >= lumber && food.used + d.foodUsed <= food.made;
      const inStock = stock !== 0; // -1 = not stock-limited, 0 = sold out
      const [col, row] = place(d.buttonX, d.buttonY);
      used.add(`${col},${row}`);
      out.push(this.cmd({
        id: `train:${uid}`, icon: this.blpIcon(d.icon), name: d.name, hotkey: d.hotkey || (d.name[0]?.toUpperCase() ?? ""),
        tip: d.tip, // "Train |cffffcc00P|reasant" — the game's own tooltip title
        desc: this.tipText(d.description || `Trains a ${d.name}.`) + this.requirementLine(uid, owned),
        gold, lumber, food: d.foodUsed,
        count: stock > 0 ? stock : undefined, // the shop's stock badge
        col, row,
        disabled: !afford || !metTech || !inStock || (d.isHero && atHeroCap),
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
        disabled: !afford || !metTech,
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
        disabled: !afford || !metTech,
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
        disabled: !afford || missing.length > 0 || stock <= 0 || !hasPatron,
      }));
    }
  }

  /** The tech ids the local player is missing for `id`, rendered as the game's own red
   *  "Requires:" tooltip line. WC3 names the requirement by its display name — and the
   *  pseudo-techs have names of their own ("Keep or Stronghold or Tree of Ages or Halls of
   *  the Dead" for TWN2), which is why they live in the data rather than being spelled out. */
  private requirementLine(id: string, tier = 0, override?: string[]): string {
    const state = this.rts?.simWorld.tech;
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

  /** Build the command card for the current selection. */
  private commandCard(): CommandButton[] {
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
    if (sel.isBuilding) {
      this.pushShopButtons(sel, out); // items a shop sells (Arcane Vault, Goblin Merchant)
      this.pushTrainButtons(sel, out); // units it trains / sells (Barracks, Tavern, Merc Camp)
      this.pushResearchButtons(sel, out); // upgrades it researches (Blacksmith, Lumber Mill…)
      this.pushBuildingUpgradeButtons(sel, out); // what it can become (Town Hall → Keep)

      // Orc Burrow garrison (UnitAbilities.slk otrb: Abtl Battle Stations + Astd Stand Down).
      // Battle Stations pulls nearby peons in; Stand Down (shown once occupied) sends them
      // back to work. Icons/hotkeys/slots are the ability data's own (OrcAbilityFunc/Strings).
      const su = world.units.get(sel.id);
      if (su && su.garrisonCap > 0 && (!su.building || su.building.constructionLeft <= 0)) {
        out.push(this.cmd({ id: "battlestations", icon: btnIcon("BTNBattleStations"), name: "Battle Stations", hotkey: "B", desc: "Causes nearby Peons to run into the Burrow so that they can defend their base.", col: 0, row: 2 }));
        if (su.garrison.length > 0)
          out.push(this.cmd({ id: "standdown", icon: btnIcon("BTNBacktoWork"), name: "Stand Down", hotkey: "D", desc: "Causes Peons within the Burrow to return to work.", col: 1, row: 2 }));
      }

      // Cancel always owns the bottom-right slot (3,2) — the canonical WC3 spot. Set Rally
      // Point sits one above it at (3,1), so it never shares the cancel slot. A neutral shop
      // isn't yours to rally.
      if (!foreignShop && world.units.get(sel.id)?.building?.producesUnits) {
        const rallyIcon = { human: "BTNRallyPoint", orc: "BTNOrcRallyPoint", undead: "BTNRallyPointUndead", nightelf: "BTNRallyPointNightElf" }[this.localRace];
        // No active state: placing a rally point is an aim, not an order in flight,
        // and a building has no "current command" to keep it lit afterwards.
        out.push(this.cmd({ id: "rally", icon: btnIcon(rallyIcon), name: "Set Rally Point", hotkey: "Y", desc: "Sets where newly-trained units gather.", col: 3, row: 1 }));
      }
      if (sel.queueLength) out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Cancel the last item in the queue.", col: 3, row: 2 }));
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
          col: d.buttonX, row: d.buttonY, disabled: !afford || !metTech,
        }));
      }
      out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Return to orders.", col: 3, row: 2 }));
      return out;
    }

    // Learn-skill sub-page (heroes): spend a skill point on a new/higher ability.
    // Cards fill the TOP row(s) left→right (developer request), each showing a "+"
    // affordance and the effect it grants at the next rank.
    if (this.cardPage === "learn" && sel.isHero) {
      const su = this.rts!.simWorld.units.get(sel.id);
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
    if (sel.isWorker) {
      // Build sits at the bottom-left of a worker's card (developer spec); Repair
      // next to it. Repair = 35% of build cost / 150% of build time to full HP.
      out.push(this.cmd({ id: "build", icon: btnIcon("BTNHumanBuild"), name: "Build Structure", hotkey: "B", desc: "Brings up the list of structures you may build.", col: 0, row: 2, active: active === "build" }));
      out.push(this.cmd({ id: "repair", icon: btnIcon("BTNRepair"), name: "Repair", hotkey: "R", desc: "Repairs a damaged building (costs 35% of its build cost).", col: 1, row: 2, active: active === "repair" }));
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
    if (su.repair) return "repair";
    switch (su.order) {
      case "move": return "move";
      // Attack-move and a forced attack share the Attack button, as in the game.
      case "attackmove":
      case "attack": return "attack";
      case "patrol": return "patrol";
      case "hold": return "hold";
      case "repair": return "repair";
      case "cast": return su.pendingCast ? `ability:${su.pendingCast.code}` : null;
      // Idle, and every order with no button behind it (harvest, follow, walking to
      // an item), rest on Stop.
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

  /** Append a movable unit's learned/innate abilities (and a hero's Learn Skill
   *  button) to its command card. Auras show as passive (disabled) indicators;
   *  autocast abilities (Heal/Slow) toggle; the rest arm a target or fire. */
  private pushAbilityButtons(sel: { id: number; isHero: boolean }, out: CommandButton[]): void {
    if (!this.rts) return;
    const su = this.rts.simWorld.units.get(sel.id);
    if (!su || su.owner !== this.localPlayer) return;
    // A Mirror Image illusion copies the hero's abilities onto its sheet but can't use any
    // of them, so it doesn't get the buttons at all — a card full of spells that silently
    // refuse would read as a bug. (issueCast refuses them regardless.)
    if (su.isIllusion) return;
    const active = this.activeCommandId();
    for (const ab of su.abilities) {
      if (ab.level < 1) continue; // unlearned hero abilities don't show as buttons
      // An ability can be gated by an upgrade — `[Adef] Requires=Rhde` (Defend), `[Acmg]
      // Requires=Rhss` (Control Magic). It sits on the unit from birth and the RESEARCH is what
      // reveals it, which is the whole job of the six Human upgrades that grant no stat at all.
      // Abilities with no requirement (every hero spell) pass this untouched.
      if (!this.rts.simWorld.techMeets(su.owner, ab.id)) continue;
      const def = this.abilities.get(ab.id);
      if (!def) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      const col = def.buttonX; // the ability's real WC3 command-card slot
      const row = def.buttonY;
      const passive = def.target === "passive";
      const onCd = ab.cooldownLeft > 0;
      const noMana = su.mana < lvl.cost;
      out.push(this.cmd({
        id: passive ? "noop" : def.autocast ? `autocast:${ab.code}` : `ability:${ab.code}`,
        icon: this.blpIcon(def.icon),
        name: def.levels > 1 ? `${def.name} (Level ${ab.level})` : def.name,
        hotkey: def.hotkey,
        tip: this.abilityTip(def, ab.level),
        desc: this.abilityDesc(def, ab.level),
        mana: lvl.cost,
        col, row,
        // Cooldown is shown by the radial overlay, not the greyed "can't afford"
        // look (a click while on cooldown is harmlessly rejected by the sim).
        // A PASSIVE is not "unavailable" either — Critical Strike is working right
        // now, and WC3 draws it in full colour off its own PASBTN art ([AOcr]
        // Art=…\PassiveButtons\PASBTNCriticalStrike.blp). It just isn't a button
        // you press (see `passive` below), so only the mana check may grey it.
        disabled: noMana,
        passive,
        // The green border marks the spell the unit is casting (or has armed) right
        // now — it is NOT the autocast toggle, which is a persistent setting and
        // gets its own indicator, so the two can never both claim the border.
        active: active === `ability:${ab.code}`,
        autocast: def.autocast && ab.autocastOn,
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
      const target = KNOWN_ABILITIES[code]?.target;
      if (target === "none") {
        this.rts.castNoTarget(code); // Thunder Clap / Divine Shield / Avatar — fire now
      } else if (target === "unit" || target === "point") {
        this.rts.armedCast = { code, target, area: target === "point" ? this.armedAbilityArea(code) : 0 };
        this.rts.orderMode = "cast";
        this.hud?.setArmed(true);
      }
      return;
    }
    if (id.startsWith("autocast:")) {
      this.rts.toggleAutocast(id.slice(9)); // toggle Heal/Slow autocast on the selection
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
        this.hud?.clearOrderMode();
        return;
      }
      if (this.placement) {
        this.cancelPlacement();
      } else if (this.cardPage === "build" || this.cardPage === "learn") {
        this.cardPage = "root";
      } else {
        const sel = this.rts.selectedInfo();
        if (sel?.underConstruction) this.cancelConstruction(sel.id, sel.typeId);
        else if (sel?.isBuilding) this.cancelTrain(sel.id); // refund the last queued unit
      }
      return;
    }
    if (id.startsWith("build:")) {
      const def = this.registry.get(id.slice(6));
      const workerId = this.rts.selectedId;
      if (def && workerId !== null) {
        this.buildGhost?.hide(); // switching buildings: drop the previously-armed ghost
        this.buildGhost = null;
        this.placement = { def, fp: def.pathTex ? this.footprintFor(def.pathTex) : null, workerId };
        void this.showBuildGhost(def);
      }
      return;
    }
    if (id === "battlestations") {
      const sel = this.rts.selectedInfo();
      if (sel) this.rts.simWorld.battleStations(sel.id); // pull nearby peons into the burrow
      return;
    }
    if (id === "standdown") {
      const sel = this.rts.selectedInfo();
      if (sel) this.rts.simWorld.unloadBurrow(sel.id); // eject peons back to work
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

  private freeHeroUsed = new Set<number>(); // players who've had their free first hero
  private trainUnit(buildingId: number, unitId: string): void {
    const d = this.registry.get(unitId);
    if (!d || !this.rts) return;
    if (this.rts.simWorld.queueFull(buildingId)) return; // 7-deep queue — checked BEFORE charging
    // WC3 hero rules, enforced here too (not just hidden on the card) so a hotkey
    // can't queue a duplicate hero or exceed the 3-hero cap.
    let heroCount = 0;
    if (d.isHero) {
      const inProduction = this.heroTypesInProduction(this.localPlayer);
      if (inProduction.has(unitId) || inProduction.size >= MAX_HEROES) return;
      heroCount = inProduction.size;
    }
    const stash = this.rts.stashFor(this.localPlayer);
    const food = this.rts.foodFor(this.localPlayer);
    // WC3 melee: a player's FIRST hero is free of gold/lumber (only food).
    const freeHero = d.isHero && !this.freeHeroUsed.has(this.localPlayer);
    const gold = freeHero ? 0 : d.goldCost;
    const lumber = freeHero ? 0 : d.lumberCost;
    // Food (like gold/lumber) is committed when training begins; block if the
    // supply cap would be exceeded (WC3: "not enough food").
    if (!this.canAfford(gold, lumber)) return;
    if (food.used + d.foodUsed > food.made) {
      this.refuse(ERR_NOFOOD);
      return;
    }
    const world = this.rts.simWorld;
    // Tech gate, enforced here and not merely greyed on the card, so a hotkey can't bypass it.
    const owned = this.trainTier(unitId, heroCount);
    if (!world.canMake(this.localPlayer, unitId, owned)) return;
    // A unit the building SELLS (a Tavern hero, a Mercenary Camp creep) comes off its stock,
    // and hiring is loud — purchaseUnit both depletes the shelf and shouts to the creeps.
    const isSold = this.tech.get(this.rts.simWorld.units.get(buildingId)?.typeId ?? "").sellunits.includes(unitId);
    if (isSold) {
      const result = world.purchaseUnit(buildingId, unitId, this.localPlayer);
      if (result !== "ok") {
        if (SHOP_ERROR[result]) this.refuse(SHOP_ERROR[result]);
        return;
      }
    }

    stash.gold -= gold;
    stash.lumber -= lumber;
    if (freeHero) this.freeHeroUsed.add(this.localPlayer);
    // A neutral shop (tavern) hires heroes near-instantly; own buildings use the
    // unit's real build time (altar heroes ~55s).
    const shop = world.units.get(buildingId)?.neutralPassive;
    // Tag the job with its BUYER: a Tavern is Neutral Passive, so a hero queued in it belongs
    // to nobody by ownership, and countOwned (which picks the requirement tier) has no other
    // way to tell whose it is. See BuildJob.buyer.
    world.enqueueTrain(buildingId, unitId, shop ? TAVERN_HIRE_TIME : d.buildTime || 15, freeHero, this.localPlayer);
  }

  /** Start researching an upgrade at a building. Charges the level's own cost (Steel Forged
   *  Swords is dearer than Iron) and shares the building's ONE production queue with training,
   *  exactly as WC3 does. */
  private startResearch(buildingId: number, upgradeId: string): void {
    if (!this.rts) return;
    const world = this.rts.simWorld;
    const state = world.tech;
    const d = this.upgrades.get(upgradeId);
    if (!d || !state) return;
    if (world.queueFull(buildingId)) return; // before charging — see SimWorld.queueFull
    const have = state.researchLevel(this.localPlayer, upgradeId);
    const next = Math.max(have, world.researchingLevel(buildingId, upgradeId)) + 1;
    if (next > d.maxLevel) return;
    if (!state.meets(this.localPlayer, upgradeId, next - 1)) return;
    const cost = this.upgrades.cost(upgradeId, next);
    if (!this.canAfford(cost.gold, cost.lumber)) return;
    const stash = this.rts.stashFor(this.localPlayer);
    stash.gold -= cost.gold;
    stash.lumber -= cost.lumber;
    world.enqueueResearch(buildingId, upgradeId, next, cost.time || 1);
  }

  /** Start a building's transformation (Town Hall → Keep, Scout Tower → Guard Tower). The
   *  cost and time are the TARGET's own; the structure keeps working while it upgrades. */
  private startBuildingUpgrade(buildingId: number, toTypeId: string): void {
    if (!this.rts) return;
    const world = this.rts.simWorld;
    const d = this.registry.get(toTypeId);
    if (!d) return;
    if (world.queueFull(buildingId)) return; // before charging — see SimWorld.queueFull
    if (!this.tech.upgradesTo(world.units.get(buildingId)?.typeId ?? "").includes(toTypeId)) return;
    // Enforced here, not merely hidden on the card, so a hotkey can't queue it twice and pay
    // for the Keep twice over.
    if (world.isUpgrading(buildingId)) return;
    if (!world.canMake(this.localPlayer, toTypeId, 0)) return;
    // A tier upgrade costs the DIFFERENCE between the two buildings, not the full price of the
    // new one (WC3): a Stronghold (700/375) over a Great Hall (385/185) is 315/190, not 700/375.
    const [gold, lumber] = this.upgradeCost(world.units.get(buildingId)?.typeId, d);
    if (!this.canAfford(gold, lumber)) return;
    const stash = this.rts.stashFor(this.localPlayer);
    stash.gold -= gold;
    stash.lumber -= lumber;
    world.enqueueUpgrade(buildingId, toTypeId, d.buildTime || 1);
  }

  /** Buy an item from a shop. WC3 hands it to a "valid patron" — a nearby unit with an
   *  inventory — so pick the player's SELECTED hero when it happens to be in range (that's
   *  the one they mean), else the closest patron the shop can reach. */
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
    const result = world.purchaseItem(shopId, buyer.id, itemId, this.localPlayer);
    if (result !== "ok" && SHOP_ERROR[result]) this.refuse(SHOP_ERROR[result]);
  }

  /** Cancel an under-construction building: refund **75%** of its cost (WC3
   *  cancelled-construction rate), free its pathing footprint, remove it, and
   *  play the race's dedicated **cancel explosion** (`<Race>CancelDeath.mdx` —
   *  distinct from the building's own Death collapse used for combat). */
  private cancelConstruction(buildingId: number, typeId: string): void {
    if (!this.rts) return;
    const def = this.registry.get(typeId);
    if (def) {
      const stash = this.rts.stashFor(this.localPlayer);
      stash.gold += Math.round(def.goldCost * CANCEL_BUILDING_REFUND);
      stash.lumber += Math.round(def.lumberCost * CANCEL_BUILDING_REFUND);
    }
    // Grab the building's position before it's removed, for the explosion.
    const b = this.rts.simWorld.units.get(buildingId);
    const fx = b ? { x: b.x, y: b.y, z: this.rts.groundHeightAt(b.x, b.y) } : null;
    this.rts.simWorld.cancelBuilding(buildingId); // frees its footprint's cells too
    if (fx) void this.spawnEffect(CANCEL_FX[this.localRace], fx.x, fx.y, fx.z);
  }

  private cancelTrain(buildingId: number): void {
    const job = this.rts?.simWorld.cancelLastTrain(buildingId);
    this.refundJob(job);
  }

  /** Cancel a specific queue slot (0 = currently in progress) and refund it. */
  private cancelTrainAt(buildingId: number, index: number): void {
    const job = this.rts?.simWorld.cancelTrainAt(buildingId, index);
    this.refundJob(job);
  }

  /** Refund a cancelled queue job. Each kind has its own rate in MiscGame.txt: training and
   *  research come back in FULL (TrainRefundRate / ResearchRefundRate = 1.0) but a cancelled
   *  structure upgrade only pays back 75% (UpgradeRefundRate) — the same haircut as cancelling
   *  a building under construction. */
  private refundJob(job: BuildJob | null | undefined): void {
    if (!job || !this.rts) return;
    const stash = this.rts.stashFor(this.localPlayer);
    if (job.kind === "research") {
      const c = this.upgrades.cost(job.unitId, job.level);
      stash.gold += Math.round(c.gold * MISC_GAME.ResearchRefundRate);
      stash.lumber += Math.round(c.lumber * MISC_GAME.ResearchRefundRate);
      return;
    }
    // The melee free first hero cost nothing, so it refunds nothing — otherwise queueing and
    // cancelling one would simply mint 425 gold. Cancelling it also hands the freebie back.
    if (job.kind === "unit" && job.free) {
      this.freeHeroUsed.delete(this.localPlayer);
      return;
    }
    const d = this.registry.get(job.unitId);
    if (d) {
      const rate = job.kind === "upgrade" ? MISC_GAME.UpgradeRefundRate : MISC_GAME.TrainRefundRate;
      stash.gold += Math.round(d.goldCost * rate);
      stash.lumber += Math.round(d.lumberCost * rate);
    }
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
      inst.setTeamColor(this.localPlayer); // show the team-coloured parts
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
   *  canceled, or the worker is re-tasked). Only the owning player's sites are drawn. */
  private updatePendingBuildGhosts(): void {
    if (!this.rts || !this.viewer.map) {
      this.clearPendingGhosts();
      return;
    }
    // Collect every desired build site (keyed by defId + snapped position, unique per
    // footprint) from the local player's workers.
    const desired = new Map<string, { defId: string; x: number; y: number }>();
    for (const u of this.rts.simWorld.units.values()) {
      if (u.owner !== this.localPlayer) continue;
      if (u.buildPending) {
        const pb = u.buildPending;
        desired.set(this.pendingKey(pb.defId, pb.x, pb.y), { defId: pb.defId, x: pb.x, y: pb.y });
      }
      for (const o of u.orderQueue) {
        if (o.kind === "buildnew") desired.set(this.pendingKey(o.defId, o.x, o.y), { defId: o.defId, x: o.x, y: o.y });
      }
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
        this.placePendingGhost(g, site.x, site.y);
        continue;
      }
      if (this.pendingGhostLoading.has(key)) continue; // model still loading
      const def = this.registry.get(site.defId);
      if (!def) continue;
      this.pendingGhostLoading.add(key);
      void this.spawnPendingGhost(key, def, site.x, site.y);
    }
  }

  /** Site key for a pending build: defId + snapped position (one ghost per footprint). */
  private pendingKey(defId: string, x: number, y: number): string {
    return `${defId}@${Math.round(x)},${Math.round(y)}`;
  }

  /** Load (async) and register a dark-blue ghost for a pending build site, unless the
   *  order was canceled while the model streamed in. */
  private async spawnPendingGhost(key: string, def: UnitDef, x: number, y: number): Promise<void> {
    const map = this.viewer.map;
    const model = map ? ((await this.viewer.load(def.model, this.solver)) as SpawnModel | undefined) : undefined;
    this.pendingGhostLoading.delete(key);
    // Bail if the site was canceled (or the scene torn down) during the load.
    if (!model || !this.viewer.map || this.pendingGhosts.has(key)) return;
    const inst = model.addInstance();
    inst.setScene(this.viewer.map.worldScene);
    inst.setUniformScale(def.modelScale || 1);
    inst.setTeamColor(this.localPlayer);
    const g = { inst, defId: def.id, frame: this.applyGhostPose(inst) };
    this.pendingGhosts.set(key, g);
    this.placePendingGhost(g, x, y);
  }

  /** Position a pending-build ghost on its site — seated on the tallest terrain its
   *  footprint spans (like the real building, issue #15), pinned to the built pose, and
   *  tinted a hard dark blue so it reads clearly as "about to be built". */
  private placePendingGhost(g: { inst: SpawnInstance; defId: string; frame: number }, x: number, y: number): void {
    const def = this.registry.get(g.defId);
    const fp = def?.pathTex ? this.footprintFor(def.pathTex) : null;
    this.loc3[0] = x;
    this.loc3[1] = y;
    this.loc3[2] =
      fp && this.footMaxHeight ? this.footMaxHeight(x, y, (fp.w * PATHING_CELL) / 2, (fp.h * PATHING_CELL) / 2) : (this.rts?.groundHeightAt(x, y) ?? 0);
    g.inst.setLocation(this.loc3);
    if (g.frame >= 0) g.inst.frame = g.frame; // keep it fully built, not mid-animation
    g.inst.setVertexColor(PENDING_GHOST_TINT); // hard dark blue
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
    this.cursorStyleEl.textContent =
      `body.in-game, body.in-game * { cursor: ${rule} !important; }\n` +
      `body.in-game.reticle-on #map { cursor: none !important; }\n` +
      `body.in-game.armed-on, body.in-game.armed-on * { cursor: none !important; }`;
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
    }
    return url;
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
    const queue = [...paths].filter((p) => !this.iconCache.has(p));

    let i = 0;
    const ric = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback.bind(window) : null;
    const step = (deadline?: IdleDeadline) => {
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

  private footprintFor(texPath: string): Footprint | null {
    let fp = this.footprints.get(texPath);
    if (fp === undefined) {
      const bytes = this.vfs.rawBytes(texPath);
      fp = bytes ? decodePathTex(bytes) : null;
      this.footprints.set(texPath, fp);
    }
    return fp;
  }

  start(): void {
    if (this.raf) return;
    const frame = (t: number) => {
      const dt = this.last ? t - this.last : 1000 / 60;
      this.last = t;
      this.updateCamera(dt);
      this.metrics.frame(dt, this.rts?.unitCount() ?? 0);
      this.hud?.frame(dt);
      this.updateClock(dt);
      this.updatePortrait();
      // The cinematic panel runs on the RENDER clock, not the sim's: a fade must keep fading
      // and a subtitle must keep counting down while the game is paused under a dialog — and
      // `dt` here is MILLISECONDS, which is the mistake this subsystem is most prone to.
      this.cinematic?.update(dt / 1000);
      // Re-scan for new on-map unit types (trained units, scouted enemies) a couple
      // times a second and warm their portraits before they're clicked.
      this.portraitWarmAccum += dt;
      if (this.portraitWarmAccum > 2000) {
        this.portraitWarmAccum = 0;
        this.warmPortraits();
      }
      // The F10 game menu freezes the simulation (units hold; rendering continues).
      if (!this.paused) {
        // FIXED TIMESTEP. The sim advances in whole SIM_DT steps and never in a raw frame
        // delta, so a match is a COUNT OF TICKS rather than a history of one machine's
        // frame rate. Two things need that: replays, and multiplayer — the host's
        // authoritative tick number is what a command attaches to and what a snapshot is
        // stamped with (docs/multiplayer.md). src/sim/world.ts always claimed to be
        // fixed-timestep; until now the claim was aspirational.
        //
        // It also subsumes the old Math.min(dt, 50) clamp (issue #24: at low frame rates a
        // single huge step made melee units overshoot and "shuffle"). Every step is now
        // SIM_DT no matter how bad the frame was; a slow frame just runs more of them, and
        // MAX_STEPS_PER_FRAME caps that so a long stall can't spiral into an ever-growing
        // catch-up. Dropping the remainder there loses game time, which is the right thing
        // to lose: the alternative is a death spiral.
        this.simAccum += dt / 1000;
        let steps = 0;
        while (this.simAccum >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
          this.tickPendingBuild(SIM_DT); // seconds, matching the sim's clock
          this.rts?.tick(SIM_DT); // sim runs in seconds; advance + sync before render
          this.pumpMapScript(SIM_DT); // Phase 7: the map's timers + enter/leave-region triggers
          this.simTick++;
          this.simAccum -= SIM_DT;
          steps++;
        }
        if (steps === MAX_STEPS_PER_FRAME) this.simAccum = 0;
      }
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
      this.updateMirrorMissiles(dt / 1000);
      this.updateAuraEffects();
      this.updateSpecialFx(dt / 1000); // script effects: age them, settle Birth→Stand, fog-gate
      this.updateDyingFx(dt / 1000); // buff art + script effects playing out their Death clip
      this.updateTreePulses(dt / 1000);
      this.updateTreeActors(); // per-chop "stand hit" wobble on felled/chopped trees' stand-ins
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
        for (const tree of world.drainFelledTrees()) {
          this.fellTreeVisual(tree.id, tree.x, tree.y, map.doodads); // "death" fall + leave the stump
          this.rts?.onTreeFelled(tree.x, tree.y, tree.blockRadius); // stop blocking fog line-of-sight
        }
        for (const mine of world.drainDepletedMines()) {
          this.removeNodeVisual(mine.id, mine.x, mine.y, map.units as unknown as HideableWidget[]);
          this.splats?.remove(`m${mine.id}`); // drop the mine's ground texture
        }
        // Finished training: the unit exits from the building corner nearest its
        // rally point and rotates counterclockwise to the next clear spot if that
        // corner is crowded (WC3), then walks to the rally point. `claimed` holds
        // the spots handed out this frame so a batch trained at once can't stack.
        const claimed: Array<[number, number]> = [];
        for (const t of world.drainTrained()) {
          const d = this.registry.get(t.unitId);
          if (!d) continue;
          const [sx, sy] = this.trainSpawnSpot(t.buildingId, t.x, t.y, t.rallyX, t.rallyY, d.collision || 16, claimed);
          const rally = { kind: t.rallyKind, targetId: t.rallyTargetId, x: t.rallyX, y: t.rallyY };
          this.sounds?.play(d.soundSet, "Ready"); // "unit ready" voice on completion
          const buildingId = t.buildingId;
          void this.spawnUnit(d, sx, sy, this.localPlayer, this.teamOf(this.localPlayer)).then((simId) => {
            if (simId === null) return;
            this.applyRally(simId, rally);
            // EVENT_(PLAYER_)UNIT_TRAIN_FINISH (7.17) — raised HERE, not in the sim: the
            // trained unit is born in the renderer (the sim owns no models), and
            // GetTrainedUnit must hand the script the real unit.
            world.noteTrainFinish(buildingId, simId);
          });
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
        for (const m of world.drainMorphs()) {
          const owner = world.units.get(m.unitId)?.owner;
          if (owner === this.localPlayer) this.sounds?.playUi(`UpgradeComplete${UI_SOUND_RACE[this.localRace]}`);
          void this.remodelUnit(m.unitId, m.to);
        }
        // --- spells / abilities ---
        // Effect models (Holy Light burst, Heal glow, Thunder Clap ring, …): follow
        // the target unit if one is given, else play at the point.
        for (const fx of world.drainSpellEffects()) {
          const t = fx.targetId ? world.units.get(fx.targetId) : null;
          const x = t ? t.x : fx.x;
          const y = t ? t.y : fx.y;
          const z = this.rts!.groundHeightAt(x, y);
          void this.spawnEffect(fx.art, x, y, z + (fx.z || 0), fx.life ?? 2);
          // A wave field asked for its shard-fall sound (Blizzard): the WAV lives in
          // the effect model's own folder, so resolve it off the art like a cast sound.
          if (fx.sound) this.sounds?.playSpellSound([fx.art], undefined, { x, y, z });
        }
        // Ground decals a spell painted this frame (Thunder Clap's scorch, THND).
        for (const s of world.drainSpellSplats()) this.addSpellSplat(s.splatId, s.x, s.y);
        // Sustain the looping bed under each running channelled field, and drop it the
        // frame the field ends — waves exhausted OR caster interrupted (world tears the
        // field down either way, so this needs no interrupt handling of its own).
        this.updateFieldLoops(world.activeSpellFields());
        // Cast animations (throw/slam/spell) begin at the wind-up.
        for (const c of world.drainCastStarts()) {
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
        for (const c of world.drainCastFires()) {
          const def = this.abilities.get(c.abilityId);
          if (!def) continue;
          const caster = world.units.get(c.casterId);
          const at = caster ? { x: caster.x, y: caster.y, z: this.rts!.groundHeightAt(caster.x, caster.y) } : undefined;
          const arts = SPELL_SOUND_ART[c.code]?.(def) ?? [def.targetArt, def.casterArt, def.specialArt];
          this.sounds?.playSpellSound(arts, SPELL_SOUND_FALLBACK[c.code], at);
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
        const summonClaimed = new Set<string>(); // cells handed out this frame (see summonSpot)
        for (const s of world.drainSummonRequests()) {
          const d = this.registry.get(s.unitId);
          if (!d) continue;
          const summonLeft = s.summonLeft;
          const [sx, sy] = this.summonSpot(s.x, s.y, s.facing, d.collision || 16, s.atPoint, summonClaimed);
          // The summon burst belongs on the SPOT the unit lands on, not on the caster —
          // three wolves fan out around the Far Seer, and each arrives in its own.
          if (s.summonArt) world.emitEffectAt(s.summonArt, sx, sy, true); // the model carries its own SND event
          void this.spawnUnit(d, sx, sy, s.owner, s.team).then((simId) => {
            if (simId === null) return;
            const su = world.units.get(simId);
            if (su) su.unsummonArt = s.unsummonArt; // how it leaves when its time is up
            if (su && summonLeft > 0) {
              su.summonLeft = summonLeft;
              su.summonMax = summonLeft;
              su.isSummon = true; // temporary summon — expires, leaves no corpse, ×0.5 XP
            }
            // Turn the fresh copy into an illusion of its original. The sim owns this: the
            // level has to be applied and the stats rebuilt off it before hp/mana can be set
            // (see initIllusion), which is not something the renderer should be sequencing.
            if (su && s.illusion) world.initIllusion(su, s.sourceId, s.illusion);
            this.rts!.beginSummonBirth(simId); // materialize (birth clip + spawn lock)
          });
        }
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
      // Prune ubersplats whose building has died before we draw them this frame.
      if (this.splats && fogScene) {
        const world = this.rts?.simWorld;
        if (world) {
          this.splats.reconcile(this.simBuildingSplats, (id) => world.units.has(id as number));
          // Pre-placed map buildings (p<i>) are keyed by index, not sim id, so prune them
          // by POSITION: a neutral shop/fountain the player destroys must lose its ground
          // decal too (issue #40). A splat is removed only once a live building has been
          // SEEN at its spot (the neutral unit seeds a few frames after the splat is
          // painted) — after that, its absence means the building was destroyed.
          this.mapSplatAccum += dt;
          if (this.mapBuildingSplats.size && this.mapSplatAccum >= 250) {
            this.mapSplatAccum = 0;
            const liveBuildings: Array<{ x: number; y: number }> = [];
            for (const u of world.units.values()) if (u.building) liveBuildings.push({ x: u.x, y: u.y });
            // 48u matches rts.isNeutralPassiveAt — the proven tolerance for matching a
            // war3mapUnits.doo position (what the splat is keyed to) against the seeded
            // sim unit's localLocation; buildings sit far enough apart not to cross-match.
            const TOL2 = 48 * 48;
            for (const [key, s] of this.mapBuildingSplats) {
              const present = liveBuildings.some((b) => (b.x - s.x) ** 2 + (b.y - s.y) ** 2 <= TOL2);
              if (present) s.seen = true;
              else if (s.seen) { this.splats.remove(key); this.mapBuildingSplats.delete(key); }
            }
          }
        }
        for (const id of [...this.simBuildingSplats]) if (!this.splats.has(id)) this.simBuildingSplats.delete(id);
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
        map.renderGround();
        map.renderCliffs();
        // Unit shadows draw BEFORE the opaque units: the top-right cast falls north (away
        // from the camera), so it must be laid down first or the unit body would occlude it.
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
      } else {
        // Map not fully ready — fall back to the stock all-in-one path. Depth-test (depthMask
        // off) keeps units in front of both shadow passes even when drawn late.
        this.viewer.render();
        if (this.shadows && fogScene) this.shadows.render(fogScene.camera.viewProjectionMatrix);
        if (this.splats && fogScene) this.splats.render(fogScene.camera.viewProjectionMatrix);
        if (this.buildingShadows && fogScene) this.buildingShadows.render(fogScene.camera.viewProjectionMatrix);
        if (this.ringSplats && fogScene) this.ringSplats.render(fogScene.camera.viewProjectionMatrix);
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
      this.updateScriptUi();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
    this.rts?.pause();
    this.metrics.hide();
    this.hud?.hide();
    this.portraitViewer?.stop();
    document.body.classList.remove("reticle-on", "armed-on"); // restore the OS/WC3 cursor
    this.hideCursorOverlay();
    this.updateCarriedItem(-1, 0, 0); // never leave an item stuck to the cursor
  }

  /** Release the viewer's blob URLs (call when discarding the scene). */
  dispose(): void {
    this.stop();
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
    this.simBuildingSplats.clear();
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
    this.leaderboard?.dispose();
    this.multiboard?.dispose();
    this.weather?.dispose();
    this.weather = null;
    this.leaderboard = null;
    this.timerDialogs?.dispose();
    this.timerDialogs = null;
    this.dialog?.dispose();
    this.dialog = null;
    this.mapScript = null;
    this.registry.clearCustom(); // drop this map's custom object data
    this.abilities.clearCustom();
    this.items.clearCustom();
    this.gameMenu?.dispose();
    this.gameMenu = null;
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
    document.body.classList.remove("reticle-on", "armed-on", "carrying-item");
    document.body.style.cursor = ""; // restore the default cursor off the map
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
        inst.hide(); // never seen — don't even hint at what's there
        return;
      }
      const b = state === FogState.Visible ? 1 : MapViewerScene.FOG_EXPLORED_BRIGHT;
      const base = this.widgetBase(inst);
      const s = this.tintScratch;
      s[0] = base[0] * b; s[1] = base[1] * b; s[2] = base[2] * b; s[3] = base[3];
      inst.setVertexColor?.(s);
      inst.show();
    };
    for (const w of map.doodads) {
      if (!this.removedWidgets.has(w)) tint(w); // felled trees stay gone
    }
    const units = map.units as unknown as Array<HideableWidget & { row?: unknown }>;
    for (const w of units) {
      if (this.removedWidgets.has(w)) continue; // mined-out gold mines stay gone
      if (!w.row) continue; // start-location markers (rowless) are hidden for good — see hideStartLocations
      if (this.rts?.managesViewerInstance(w.instance)) continue; // RTS fog-hides creeps/shops
      tint(w);
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

    // The map's script drives the same camera (7.24) — a camera setup, a timed pan, a unit
    // to ride, a shake. It runs AFTER the player's input so a cinematic wins, and it lets go
    // of each field the moment that field's blend lands. `dtMs` is MILLISECONDS (the frame
    // loop's clock); every duration in a JASS camera call is SECONDS.
    if (this.scriptCam.active) {
      const cam = this.readCamera();
      this.scriptCam.update(Math.min(dtMs, 100) / 1000, cam, (id) => {
        const u = this.rts?.simWorld.units.get(id);
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

  /** A CAMERA_FIELD_FIELD_OF_VIEW value in our lens: the field IS the lens, in degrees.
   *
   *  This used to translate 70 onto a narrower rendered angle, on the theory that the field and
   *  the lens were different quantities. They are not — see GAME_FOV, where the reference frame
   *  of the real client says so. So a script's 70 is 70, and a map that narrows to a telephoto
   *  gets exactly the angle it asked for. */
  private static fovFromWc3(deg: number): number {
    return clamp(deg, 1, 170) * (Math.PI / 180);
  }

  /** The inverse: the lens reported back on the scale a script speaks, so GetCameraField reads
   *  70 on the default camera exactly as WC3 does, and a tween starts from the right place. */
  private static fovToWc3(rad: number): number {
    return (rad * 180) / Math.PI;
  }

  /** The live camera in the units the JASS setters speak (degrees for the angles). This and
   *  writeCamera are the whole adapter between our orbit camera and WC3's field model. */
  private readCamera(): CameraState {
    const DEG = 180 / Math.PI;
    return {
      targetX: this.target[0],
      targetY: this.target[1],
      zOffset: this.target[2],
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
    this.target[2] = c.zOffset;
    this.distance = c.distance;
    this.yaw = c.rotationDeg * RAD;
    this.pitch = -c.aoaDeg * RAD;
    // A camera setup with a 0 or absurd FOV would render nothing at all; keep it sane.
    this.fov = clamp(MapViewerScene.fovFromWc3(c.fovDeg), 0.1, Math.PI * 0.9);
    this.roll = c.rollDeg * RAD;
    this.farZ = c.farZ;
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

  private attachControls(): void {
    const c = this.canvas;
    window.addEventListener("keydown", (e) => {
      if (e.key === "F10") {
        e.preventDefault(); // F10 opens WC3's game menu, not the browser's
        this.paused = this.gameMenu?.toggle() ?? false;
        return;
      }
      this.keys.add(e.key.toLowerCase());
      this.checkCheatCode(e.key);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    // Suppress the browser's middle-click autoscroll (it fires off mousedown, which
    // preventDefault on pointerdown doesn't reach) so button 1 is free to drag-pan.
    c.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    // Left-drag rotates the camera; a left-click (no drag) selects a unit;
    // right-click issues a move order for the selection.
    c.addEventListener("pointerdown", (e) => {
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
    c.addEventListener("pointercancel", () => {
      this.cancelDrag();
      this.midPanning = false;
    });
    c.addEventListener("pointerup", (e) => {
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
    c.addEventListener("pointermove", (e) => {
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
      if (!this.dragging) this.rts?.hoverAt(e.offsetX, e.offsetY);
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
    window.addEventListener("pointermove", trackCursor, { capture: true });
    window.addEventListener("pointerdown", trackCursor, { capture: true });
    window.addEventListener("contextmenu", trackCursor, { capture: true });
    // Cursor left the page (or the window lost focus): stop edge-scrolling. Without this the
    // camera would keep panning off the last edge the cursor crossed on its way out.
    document.addEventListener("pointerleave", () => (this.pointerInWindow = false));
    window.addEventListener("blur", () => (this.pointerInWindow = false));
    window.addEventListener("pointermove", (e) => {
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
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (!this.userControl) return; // a cinematic owns the zoom too (7.24)
        this.distance = clamp(this.distance * (1 + Math.sign(e.deltaY) * 0.1), MapViewerScene.ZOOM_MIN, MapViewerScene.ZOOM_MAX);
      },
      { passive: false },
    );
  }
}

// The game renders at a fixed 1080p, 16:9 (ui/stage.ts) — the frame Warcraft III itself
// draws, and the frame the 70° lens is framed for. The CSS stage scales this buffer into the
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
/** Position key for `treeFogRadius`. The sim tree and its rendered doodad are seeded
 *  from the same war3map.doo record, so rounding to a whole world unit matches them
 *  exactly while tolerating float round-tripping through the widget's localLocation. */
function fogKey(x: number, y: number): string {
  return `${Math.round(x)},${Math.round(y)}`;
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
const COLLIDER_LIFT = 12; // raise shapes above the ground so they read clearly
// "Show Regions" overlay palette: cyan outline + a faint cyan wash inside each rect.
const REGION_COLORS = { outline: [0.2, 0.95, 1.0, 0.9] as const, fill: [0.2, 0.85, 1.0, 0.12] as const };

/** Project a world point through a column-major view-projection matrix to canvas
 *  pixels (origin top-left), or null if it's behind the camera. Used to anchor the
 *  region-name DOM labels over the 3D scene. */
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
