import War3MapViewer from "mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/viewer";
import ModelViewer from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import type { DataSource } from "../vfs/types";
import w3iParser from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";
import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import { MpqDataSource } from "../vfs/mpq";
import { parseW3E, type TerrainData } from "../world/terrain";
import { parseDoo } from "../world/doodads";
import { PathingGrid, parseWpm, footprintCells, PATHING_CELL } from "../sim/pathing";
import type { QueuedOrder, RallyKind, SimUnit } from "../sim/world";
import { stampFootprints, stampFootprint, unstampFootprint, decodePathTex, footprintRadius, type Footprint } from "../sim/destructibles";
import { parseMapUnits, GOLD_MINE_ID } from "../world/mapUnits";
import { makeHeightSampler, makeCliffLevelSampler, makeFootprintMaxSampler, type HeightSampler, type FootprintMaxSampler } from "../game/heightmap";
import { FogOverlay } from "./fogOverlay";
import { UberSplatOverlay } from "./uberSplatOverlay";
import { DebugColliders, OverlayLayer, COLLIDER_COLORS, FLOATS_PER_VERT, type ColliderBatch } from "./debugColliders";
import { FogState, VISION_CELL, type VisionMap } from "../sim/vision";
import { RtsController, type RtsHost } from "../game/rts";
import { SoundBoard } from "../audio/sounds";
import { loadUnitRegistry, type UnitRegistry, type UnitDef } from "../data/units";
import { loadUberSplatRegistry, type UberSplatRegistry } from "../data/ubersplats";
import { loadAbilityRegistry, type AbilityRegistry, type AbilityDef, KNOWN_ABILITIES, requiredHeroLevel, tipFieldValue } from "../data/abilities";
import { loadItemRegistry, type ItemRegistry } from "../data/items";
import { MELEE, MISC_GAME } from "../data/gameplayConstants";
import { DayNightCycle, type DayNightLight } from "./dayNight";
import { TimeIndicatorClock, timeIndicatorPath } from "./timeIndicator";

/** Per-creep seed data collected from the map (guard post + drop table). */
interface CreepSeed {
  x: number;
  y: number;
  aggro: number;
  drops: Array<{ items: Array<{ id: string; chance: number }> }>;
}
import { STARTING_UNITS, WORKERS, MELEE_UNIT_SPACING, MELEE_WORKER_CLUSTERS, resolveRace, type PlayableRace, type WorkerCluster } from "../data/races";
import { ModelViewerScene } from "./modelViewer";
import type { MeleeConfig } from "../ui/lobby";
import { MetricsOverlay } from "../ui/metrics";
import { GameHud, type HudDriver, type CommandButton } from "../ui/hud";
import { GameMenu } from "../ui/gameMenu";
import { blpToCanvas, blpToDataUrl } from "./blputil";
import { buildsFor, trainsFor } from "../data/techtree";

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

const UP = new Float32Array([0, 0, 1]); // WC3 world space is Z-up
const LEVEL_UP_FX = "Abilities\\Spells\\Other\\Levelup\\Levelupcaster.mdx"; // hero level-up nova
// Cast sounds for spells whose effect model doesn't sit next to a folder WAV
// (e.g. Divine Shield has no target/caster art), by base ability code.
const SPELL_SOUND_FALLBACK: Record<string, string> = {
  AHds: "Abilities\\Spells\\Human\\DivineShield\\DivineShield.wav",
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
  sequenceEnded: boolean; // mdx-m3-viewer: true once a non-looping clip finishes
  hide(): void;
  show(): void;
  setSequence(i: number): void;
  setSequenceLoopMode(m: number): void;
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
  model: {
    sequences: Array<{ name: string; interval?: ArrayLike<number> }>;
    attachments?: Array<{ name: string }>; // "Sprite First Ref", "Hand Right Ref", …
  };
}
interface SpawnModel {
  addInstance(): SpawnInstance;
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
  // Orbit camera state.
  private target = new Float32Array([0, 0, 0]);
  // Terrain extent the camera focus is kept inside so it can't scroll off into the
  // black void (issue #5). Set on map load from centerOffset + mapSize; null = no map.
  private mapBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  private distance = 4000;
  // Look from the south toward +Y (north up), matching WC3's default camera so
  // units/buildings (which default to facing 270° = south) face the viewer.
  private yaw = Math.PI / 2;
  private pitch = 0.95;
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
  private fogAccum = 0; // ms since the last fog resample (throttle)
  private removedWidgets = new Set<HideableWidget>(); // felled trees / mined-out mines — stay gone, never re-fogged
  private baseColors = new WeakMap<object, Float32Array>(); // each widget's tint before fog dimming
  private tintScratch = new Float32Array(4); // reused fog tint, avoids per-widget allocation
  private cheatBuf = ""; // rolling buffer of typed letters, for WC3 chat cheat codes
  private footprints = new Map<string, Footprint | null>();
  private metrics = new MetricsOverlay();
  private hud: GameHud | null = null;
  private gameMenu: GameMenu | null = null;
  private paused = false; // F10 game menu freezes the sim (rendering continues)
  /** Called when the player picks "End Game" — host tears the match down. */
  onExit: (() => void) | null = null;
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
  // Stamped footprints of spawned buildings, for unstamping when cancelled.
  private buildingFootprints = new Map<number, { fp: Footprint; x: number; y: number }>();
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

  private constructor(
    private canvas: HTMLCanvasElement,
    private viewer: W3xViewer,
    private blobUrls: string[],
    private vfs: DataSource,
    private registry: UnitRegistry,
    private abilities: AbilityRegistry,
    private items: ItemRegistry,
    private solver: Solver,
  ) {
    this.sounds = new SoundBoard(vfs);
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
  static async create(canvas: HTMLCanvasElement, vfs: DataSource): Promise<MapViewerScene> {
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

    return new MapViewerScene(canvas, viewer, created, vfs, loadUnitRegistry(vfs), loadAbilityRegistry(vfs), loadItemRegistry(vfs), solver);
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
    this.simBuildingSplats.clear();
    this.mapBuildingSplats.clear();
    this.rts?.dispose();
    this.rts = null;
    this.dayNight = null;
    this.lastMarkerScanCount = -1;
    this.buildingFootprints.clear();
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
    this.distance = 2600;

    // Stand up the simulation: terrain height + pathing from the map's own files.
    const archive = new MpqDataSource("map", bytes);
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
      this.rts = new RtsController(grid, this.heightSampler, host, this.registry, this.abilities, this.items, this.footMaxHeight);
      this.rts.setSoundBoard(this.sounds);
      this.registerResourceNodes(nodes);
      this.rts.initVisionBlockers(makeCliffLevelSampler(terrain)); // fog LOS: only cliff LEVELS + treelines block sight (not rolling groundHeight)
      this.rts.setNeutralPassive(nodes.neutral); // yellow ring for shops/taverns/etc.
      this.rts.setCreepData(nodes.creeps); // per-creep guard/aggro data (Neutral Hostile)
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
  ): { trees: Array<{ x: number; y: number; pathTex: string }>; mines: Array<{ x: number; y: number; gold: number }>; neutral: Array<{ x: number; y: number }>; creeps: CreepSeed[] } {
    const trees: Array<{ x: number; y: number; pathTex: string }> = [];
    const mines: Array<{ x: number; y: number; gold: number }> = [];
    const neutral: Array<{ x: number; y: number }> = []; // Neutral Passive (player 15) sites
    const creeps: CreepSeed[] = []; // Neutral Hostile (player 12+) guard + drop data
    let buildVersion = 0;
    const w3iBytes = archive.rawBytes("war3map.w3i");
    if (w3iBytes) {
      const info = new w3iParser.File();
      info.load(w3iBytes);
      buildVersion = info.getBuildVersion();
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
      stampFootprints(grid, doodads, pathTexOf, readBytes);
      for (const d of doodads) {
        const row = destr.getRow(d.id);
        if (row?.string("targType") === "tree") {
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
    stampFootprints(grid, buildings, (id) => this.registry.get(id)?.pathTex || undefined, readBytes);
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
      }
    }
    return { trees, mines, neutral, creeps };
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
    this.localPlayer = config.slots.find((s) => s.controller === "user")?.id ?? config.slots[0]?.id ?? 0;
    this.rts!.setLocalPlayer(this.localPlayer); // drag-box selects this player's units
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

  /** Standard-melee start (plan Phase 5.5): spawn each player's starting town
   *  hall + workers at their start location. Runs only on maps the World Editor
   *  flagged as melee (see MapInfo.isMelee / src/world/mapKind.ts). */
  async startMelee(config: MeleeConfig): Promise<void> {
    if (!this.rts || !this.viewer.map) return;
    // The Frozen Throne (_V1) start purse — Reign of Chaos gave 750/200 (_V0).
    const races = this.beginMatch(config, MELEE.MELEE_STARTING_GOLD_V1, MELEE.MELEE_STARTING_LUMBER_V1);
    // Clear the creep camps the map placed on each USED start location so bases
    // spawn on clean ground (blizzard.j MeleeClearExcessUnits). config.slots holds
    // only the playing slots (open/closed are filtered out in the lobby), so unused
    // start locations keep their camps — the seeding scans read these zones. Set
    // now, synchronously, before the first frame runs trySeed on any creep.
    this.rts.setStartLocationClearZones(config.slots.map((s) => ({ x: s.startX, y: s.startY })));
    for (const slot of config.slots) {
      const race = races.get(slot.id) ?? "human";
      // Nearest gold mine to the start location (blizzard.j MeleeFindNearestMine).
      // Workers cluster on the mine→hall line; the hall itself always sits on the
      // start location.
      const mine = this.nearestMine(slot.startX, slot.startY, MELEE.MELEE_MINE_SEARCH_RADIUS);
      // Main hall(s) at the start location.
      for (const { id, count } of STARTING_UNITS[race]) {
        const def = this.registry.get(id);
        if (!def?.isBuilding) continue; // workers are placed from the authentic clusters below
        for (let i = 0; i < count; i++) await this.spawnUnit(def, slot.startX, slot.startY, slot.id, slot.team);
      }
      // Workers in the authentic clump between the hall and the mine (blizzard.j
      // MeleeStartingUnits*) instead of ringed around the hall.
      const clusters = MELEE_WORKER_CLUSTERS[race];
      for (const cluster of clusters) {
        const def = this.registry.get(cluster.id);
        if (!def) continue;
        const [cx, cy] = this.meleeClusterCenter(slot.startX, slot.startY, mine, cluster);
        for (const [ox, oy] of cluster.offsets) {
          await this.spawnUnit(def, cx + ox * MELEE_UNIT_SPACING, cy + oy * MELEE_UNIT_SPACING, slot.id, slot.team);
        }
      }
      // Frame the local player on their starting workers, as WC3 does (blizzard.j
      // centres the camera on the initial peasants, not the town hall).
      if (slot.id === this.localPlayer && clusters[0]) {
        const [cx, cy] = this.meleeClusterCenter(slot.startX, slot.startY, mine, clusters[0]);
        this.target[0] = cx;
        this.target[1] = cy;
      }
    }
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

  /** Custom / scenario / game-mode start (maps NOT flagged melee). Such a map
   *  sets up its own game — starting units, heroes, resources, win conditions —
   *  from its triggers (war3map.j, read by src/world/triggers.ts). We don't run
   *  a JASS/Lua interpreter yet (plan Phase 7), so we deliberately do NOT inject
   *  the melee starting roster here: dropping town halls + workers on a scenario
   *  map (the old always-melee behaviour) is wrong. The map's own pre-placed
   *  units already render via War3MapViewer; making them controllable is part of
   *  the trigger work. For now we just bring up the camera/HUD over the map. */
  async startCustom(_config: MeleeConfig): Promise<void> {
    if (!this.rts || !this.viewer.map) return;
    // Custom maps get their starting resources from triggers we can't run yet,
    // so seed empty stashes rather than the melee 500/150 default.
    this.beginMatch(_config, 0, 0);
    console.info(
      "[openwar3] Custom map loaded — melee initialization skipped. " +
        "Trigger execution (war3map.j → our engine) is plan Phase 7 and not yet implemented.",
    );
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

  /** Where to place a summoned unit: the tile in front of its summoner, else the
   *  nearest free tile around it (WC3 summons appear ahead of the caster). */
  private summonSpot(casterX: number, casterY: number, facing: number, collision: number): [number, number] {
    const dist = 96;
    const fx = casterX + Math.cos(facing) * dist;
    const fy = casterY + Math.sin(facing) * dist;
    if (this.grid) {
      const n = footprintCells(collision);
      const [cx, cy] = this.grid.worldToCell(fx, fy);
      const spot = this.grid.nearestFit(cx, cy, n, 14) ?? this.grid.nearestWalkable(cx, cy, 14);
      if (spot) return this.grid.cellToWorld(spot[0], spot[1]);
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
    const meta = this.buildingFootprints.get(buildingId);
    const halfW = meta ? meta.fp.w * 16 : 48;
    const halfH = meta ? meta.fp.h * 16 : 48;
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

  private async spawnUnit(def: UnitDef, x: number, y: number, owner: number, team: number, constructionTime = 0): Promise<number | null> {
    const map = this.viewer.map;
    if (!map || !this.rts) return null;
    // Buildings snap to the pathing grid so their stamped footprint lands on
    // whole cells (WC3 building placement is grid-aligned).
    const fp = def.isBuilding && def.pathTex && this.grid ? this.footprintFor(def.pathTex) : null;
    if (fp && this.grid) [x, y] = this.grid.snapForFootprintRect(x, y, fp.w, fp.h);

    const model = await this.viewer.load(def.model, this.solver);
    if (!model) return null;
    const instance = model.addInstance();
    instance.setScene(map.worldScene);
    instance.setTeamColor(owner); // player slot doubles as team color for now
    const simId = this.rts.addUnit(instance, def, x, y, (3 * Math.PI) / 2, owner, team, constructionTime); // face south

    // Buildings block pathing: stamp their footprint so units route around them.
    if (fp && this.grid) {
      stampFootprint(this.grid, fp, x, y);
      this.buildingFootprints.set(simId, { fp, x, y }); // for unstamping on cancel
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
    if (p.fp) [x, y] = this.grid.snapForFootprintRect(x, y, p.fp.w, p.fp.h);
    if (!this.placementValid(x, y)) return; // invalid site — keep placing
    const stash = this.rts.stashFor(this.localPlayer);
    if (stash.gold < p.def.goldCost || stash.lumber < p.def.lumberCost) return;
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
    inst.show();
    this.itemInstances.set(itemId, inst);
  }

  private removeItemModel(itemId: number): void {
    const inst = this.itemInstances.get(itemId);
    if (inst) {
      inst.detach();
      this.itemInstances.delete(itemId);
    }
    const bi = this.itemBirthing.findIndex((b) => b.id === itemId);
    if (bi >= 0) this.itemBirthing.splice(bi, 1);
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

  // Persistent per-unit buff models: a looping effect worn by a unit for as long as
  // it carries a given buff. Pooled by a stable key so it's created once and detached
  // when the buff falls off. Two families feed this, both data-driven:
  //   • auras — WC3 shows TWO models: a BIG one under the aura's OWNER only (the
  //     ability's own TargetArt, e.g. DevotionAura) and a SMALL swirl under EVERY
  //     affected unit incl. the owner (the buff's TargetArt = GeneralAuraTarget).
  //   • single-target buffs that carry their own art (Banish's ethereal BanishTarget).
  private buffFx = new Map<string, SpawnInstance>();
  private buffFxLoading = new Set<string>();
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
        // Aura buffs are grouped "code:kind"; a plain single-target buff isn't.
        const auraCode = b.group.includes(":") ? b.group.split(":")[0] : "";
        if (auraCode) {
          if (seen.has("a:" + auraCode)) continue;
          seen.add("a:" + auraCode);
          const def = this.abilityDefByCode(auraCode);
          if (!def) continue;
          // Small swirl on every affected unit; big model on the owner only (its own
          // aura copy carries sourceId === its id — allies get the owner's id).
          this.trackBuffFx(active, `${u.id}|${auraCode}|s`, def.buffArt, u.id);
          if (b.sourceId === u.id) this.trackBuffFx(active, `${u.id}|${auraCode}|o`, def.targetArt, u.id);
        } else if (b.art) {
          if (seen.has("b:" + b.art)) continue;
          seen.add("b:" + b.art);
          this.trackBuffFx(active, `${u.id}|${b.art}`, b.art, u.id);
        }
      }
    }
    for (const [key, inst] of this.buffFx) {
      if (!active.has(key)) {
        inst.detach();
        this.buffFx.delete(key);
      }
    }
  }

  /** Mark a persistent buff model live this frame: (re)position an existing instance,
   *  or spawn it on demand. `path` "" is a no-op (aura with no small/big model). */
  private trackBuffFx(active: Set<string>, key: string, path: string, simId: number): void {
    if (!path) return;
    active.add(key);
    const inst = this.buffFx.get(key);
    if (inst) {
      const u = this.rts?.simWorld.units.get(simId);
      if (u) {
        this.loc3[0] = u.x;
        this.loc3[1] = u.y;
        this.loc3[2] = this.rts!.groundHeightAt(u.x, u.y);
        inst.setLocation(this.loc3);
      }
    } else if (!this.buffFxLoading.has(key)) {
      this.buffFxLoading.add(key);
      void this.spawnBuffFx(key, path, simId);
    }
  }

  private async spawnBuffFx(key: string, path: string, simId: number): Promise<void> {
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
    this.loc3[0] = u.x;
    this.loc3[1] = u.y;
    this.loc3[2] = this.rts!.groundHeightAt(u.x, u.y);
    inst.setLocation(this.loc3);
    inst.setSequence(this.effectSequence(inst));
    inst.setSequenceLoopMode(2); // loop the buff/aura effect for its lifetime
    inst.show();
    this.buffFx.set(key, inst);
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
  // Camera zoom limits (world units of camera distance), WC3-like — not the huge
  // free range we had. MELEE_START opens a touch more zoomed out than before.
  private static readonly ZOOM_MIN = 1500;
  private static readonly ZOOM_MAX = 3600;
  private static readonly MELEE_START = 2400;
  private static readonly EDGE_MARGIN = 6; // px from a screen edge that triggers scrolling
  private mouseOverCanvas = false; // cursor over the map (not the console) — gates edge-scroll

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
    inst.setSequence(0);
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
    if (fp) [x, y] = this.grid.snapForFootprintRect(x, y, fp.w, fp.h);
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
   *  hugging quad per cell of the building's full (blue) footprint, green where that
   *  cell is buildable and red where it's obstructed — the exact per-cell `buildable`
   *  test placementValid uses, so the grid shows the true reserved footprint (walkable
   *  border included), not just the unwalkable core. Drawn by the frame loop. */
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
    const [bx, by] = this.grid.worldToCell(x - (fp.w * PATHING_CELL) / 2, y - (fp.h * PATHING_CELL) / 2);
    const cells: number[] = [];
    for (let cy = 0; cy < fp.h; cy++) {
      for (let cx = 0; cx < fp.w; cx++) {
        if (!fp.buildBlocked[cy * fp.w + cx]) continue; // the full reserved footprint
        const gx = bx + cx, gy = by + cy;
        const color = this.grid.buildable(gx, gy) ? COLLIDER_COLORS.buildable : COLLIDER_COLORS.unbuildable;
        const x0 = ox + gx * PATHING_CELL, y0 = oy + gy * PATHING_CELL;
        pushColliderQuad(cells, x0, y0, x0 + PATHING_CELL, y0 + PATHING_CELL, h, color);
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
      neutralBuildings: () => this.rts?.neutralBuildings() ?? [],
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
    };
    this.hud = new GameHud(ui, driver);
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
    for (const bid of buildsFor(this.localRace)) {
      consider(bid);
      for (const uid of trainsFor(bid)) consider(uid); // units this building trains
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

  private cmd(over: Partial<CommandButton>): CommandButton {
    return { id: "", icon: null, name: "", hotkey: "", desc: "", gold: 0, lumber: 0, food: 0, mana: 0, col: 0, row: 0, disabled: false, active: false, ...over };
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
          if (this.registry.get(job.unitId)?.isHero) set.add(job.unitId);
        }
      }
    }
    return set;
  }

  /** Build the command card for the current selection. */
  private commandCard(): CommandButton[] {
    const sel = this.rts?.selectedInfo();
    if (!sel) return [];
    // A neutral shop/tavern the local player can hire from shows its purchase card
    // even though they don't own it; anything else must be the player's own unit.
    const isShop = sel.isBuilding && sel.owner !== this.localPlayer && trainsFor(sel.typeId).length > 0;
    if (sel.owner !== this.localPlayer && !isShop) return [];
    const btnIcon = (n: string) => this.blpIcon(`ReplaceableTextures\\CommandButtons\\${n}.blp`);
    const out: CommandButton[] = [];

    if (sel.underConstruction) {
      out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Cancel construction.", col: 3, row: 2 }));
      return out;
    }
    if (sel.isBuilding) {
      const food = this.rts!.foodFor(this.localPlayer);
      // WC3 hero rules (shared by altars + taverns): a hero already owned or in
      // production is removed from the card; once the player has MAX_HEROES the
      // remaining hero buttons are disabled ("hero limit reached").
      const heroesInProduction = this.heroTypesInProduction(this.localPlayer);
      const atHeroCap = heroesInProduction.size >= MAX_HEROES;
      for (const uid of trainsFor(sel.typeId)) {
        const d = this.registry.get(uid);
        if (!d) continue;
        if (d.isHero && heroesInProduction.has(uid)) continue; // already have/queued this hero
        const stash = this.rts!.stashFor(this.localPlayer);
        const freeHero = d.isHero && !this.freeHeroUsed.has(this.localPlayer); // first hero is free
        const gold = freeHero ? 0 : d.goldCost;
        const lumber = freeHero ? 0 : d.lumberCost;
        const afford = stash.gold >= gold && stash.lumber >= lumber && food.used + d.foodUsed <= food.made;
        out.push(this.cmd({
          id: `train:${uid}`, icon: this.blpIcon(d.icon), name: d.name, hotkey: d.hotkey || (d.name[0]?.toUpperCase() ?? ""),
          tip: d.tip, // "Train |cffffcc00P|reasant" — the game's own tooltip title
          desc: d.description || `Trains a ${d.name}.`, gold, lumber, food: d.foodUsed,
          col: d.buttonX, row: d.buttonY, disabled: !afford || (d.isHero && atHeroCap),
        }));
      }
      // Cancel always owns the bottom-right slot (3,2) — the canonical WC3 spot.
      // The Set Rally Point button sits one above it, at center-right (3,1), so it
      // never shares the cancel slot. Neither collides with a train/hero button.
      // A neutral tavern isn't yours to rally, so it gets no rally button.
      if (!isShop && trainsFor(sel.typeId).length) {
        const rallyIcon = { human: "BTNRallyPoint", orc: "BTNOrcRallyPoint", undead: "BTNRallyPointUndead", nightelf: "BTNRallyPointNightElf" }[this.localRace];
        out.push(this.cmd({ id: "rally", icon: btnIcon(rallyIcon), name: "Set Rally Point", hotkey: "Y", desc: "Sets where newly-trained units gather.", col: 3, row: 1, active: this.rts?.orderMode === "rally" }));
      }
      if (sel.queueLength) out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Cancel the last unit in the queue.", col: 3, row: 2 }));
      return out;
    }

    // Movable units. Build sub-page for workers, else the order set.
    if (this.cardPage === "build" && sel.isWorker) {
      const stash = this.rts!.stashFor(this.localPlayer);
      for (const bid of buildsFor(sel.race as "human")) {
        const d = this.registry.get(bid);
        if (!d) continue;
        const afford = stash.gold >= d.goldCost && stash.lumber >= d.lumberCost;
        out.push(this.cmd({
          id: `build:${bid}`, icon: this.blpIcon(d.icon), name: d.name, hotkey: d.hotkey || (d.name[0]?.toUpperCase() ?? ""),
          tip: d.tip, // "Build |cffffcc00F|rarm" — the verb is already in the game's Tip
          desc: d.description || `Builds ${d.name}.`, gold: d.goldCost, lumber: d.lumberCost, food: 0,
          col: d.buttonX, row: d.buttonY, disabled: !afford,
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
            ? this.resolveTip(def.researchUberTip, def, shown)
            : this.abilityDesc(def, shown);
          const desc = maxed || su.level >= need ? body : `${body}|n|n|cffffcc00Hero level: ${need}|r`;
          out.push(this.cmd({
            id: canLearn ? `learn:${ab.id}` : "noop",
            icon: this.blpIcon(def.icon),
            name: maxed ? `${def.name} (Max)` : `+ ${def.name} [${ab.level}/${def.levels}]`,
            hotkey: def.hotkey,
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
    const armed = this.rts?.orderMode ?? null;
    out.push(this.cmd({ id: "move", icon: btnIcon("BTNMove"), name: "Move", hotkey: "M", desc: "Moves the unit to a target point.", col: 0, row: 0, active: armed === "move" }));
    out.push(this.cmd({ id: "stop", icon: btnIcon("BTNStop"), name: "Stop", hotkey: "S", desc: "Halts the unit's current order.", col: 1, row: 0 }));
    out.push(this.cmd({ id: "hold", icon: btnIcon("BTNHoldPosition"), name: "Hold Position", hotkey: "H", desc: "Holds the unit's position.", col: 2, row: 0 }));
    out.push(this.cmd({ id: "attack", icon: btnIcon("BTNAttack"), name: "Attack", hotkey: "A", desc: "Attacks a target unit, or attack-moves to a point.", col: 3, row: 0, active: armed === "attack" }));
    out.push(this.cmd({ id: "patrol", icon: btnIcon("BTNPatrol"), name: "Patrol", hotkey: "P", desc: "Patrols between here and a target point.", col: 0, row: 1, active: armed === "patrol" }));
    if (sel.isWorker) {
      // Build sits at the bottom-left of a worker's card (developer spec); Repair
      // next to it. Repair = 35% of build cost / 150% of build time to full HP.
      out.push(this.cmd({ id: "build", icon: btnIcon("BTNHumanBuild"), name: "Build Structure", hotkey: "B", desc: "Brings up the list of structures you may build.", col: 0, row: 2 }));
      out.push(this.cmd({ id: "repair", icon: btnIcon("BTNRepair"), name: "Repair", hotkey: "R", desc: "Repairs a damaged building (costs 35% of its build cost).", col: 1, row: 2, active: armed === "repair" }));
    }
    this.pushAbilityButtons(sel, out); // learned spells + a hero's Learn Skill button
    return out;
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
    return this.resolveTip(raw, def, rank);
  }

  /** Tooltip title for a spell button: the game's own per-rank `Tip` string, which
   *  already gilds the hotkey letter and appends " - [Level N]". */
  private abilityTip(def: AbilityDef, rank: number): string {
    return def.tips[Math.min(rank, def.tips.length) - 1] || def.tips[0] || def.name;
  }

  /** Replace WC3 tooltip references `<AbilCode,Field>` (and `,%` variants) with the
   *  computed value — e.g. "heal for <AHhb,DataA1>" → "heal for 200". The field name
   *  names its own rank in its trailing digit (`DataA1`/`DataA2`/`DataA3`), and that
   *  digit wins: a Researchubertip lists every rank in one string ("Level 1 - <…A1>,
   *  Level 2 - <…A2>"), so resolving them all against the shown rank would print the
   *  same number three times. `rank` is only the fallback for an undigited field.
   *  Unknown refs collapse to empty rather than leaking angle-bracket tokens. */
  private resolveTip(text: string, def: AbilityDef, rank: number): string {
    if (!text.includes("<")) return text;
    return text.replace(/<([^,>]+),([^,>]+?)(,%)?>/g, (_m, code: string, field: string, pct?: string) => {
      const d = this.abilities.get(code.trim()) ?? def;
      const named = /(\d+)$/.exec(field.trim());
      const lv = named ? Number(named[1]) : rank;
      const lvl = d.levelData[Math.min(Math.max(lv, 1), d.levelData.length) - 1];
      const v = tipFieldValue(lvl, field.trim());
      if (v === null || Number.isNaN(v)) return "";
      const n = pct ? v * 100 : v;
      return String(Math.abs(n % 1) < 1e-6 ? Math.round(n) : Math.round(n * 100) / 100);
    });
  }

  /** Append a movable unit's learned/innate abilities (and a hero's Learn Skill
   *  button) to its command card. Auras show as passive (disabled) indicators;
   *  autocast abilities (Heal/Slow) toggle; the rest arm a target or fire. */
  private pushAbilityButtons(sel: { id: number; isHero: boolean }, out: CommandButton[]): void {
    if (!this.rts) return;
    const su = this.rts.simWorld.units.get(sel.id);
    if (!su || su.owner !== this.localPlayer) return;
    const armedCode = this.rts.armedCast?.code ?? null;
    for (const ab of su.abilities) {
      if (ab.level < 1) continue; // unlearned hero abilities don't show as buttons
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
        disabled: passive || noMana,
        active: armedCode === ab.code || (def.autocast && ab.autocastOn),
        cooldownLeft: onCd ? ab.cooldownLeft : 0,
        cooldownFrac: onCd && lvl.cooldown > 0 ? Math.max(0, Math.min(1, ab.cooldownLeft / lvl.cooldown)) : 0,
      }));
    }
    if (su.isHero && su.skillPoints > 0) {
      // Hero Abilities (learn-skill): opens the skill list to spend unspent points.
      // WC3's canonical learn-abilities "Skillz" book art (the disabled-folder BLP),
      // default hotkey O, and a corner badge showing the points available.
      out.push(this.cmd({
        id: "learnpage",
        icon: this.blpIcon("ReplaceableTextures\\CommandButtonsDisabled\\DISBTNSkillz.blp"),
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
    if (id.startsWith("train:")) {
      const sel = this.rts.selectedInfo();
      if (sel) this.trainUnit(sel.id, id.slice(6));
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

  private freeHeroUsed = new Set<number>(); // players who've had their free first hero
  private trainUnit(buildingId: number, unitId: string): void {
    const d = this.registry.get(unitId);
    if (!d || !this.rts) return;
    // WC3 hero rules, enforced here too (not just hidden on the card) so a hotkey
    // can't queue a duplicate hero or exceed the 3-hero cap.
    if (d.isHero) {
      const inProduction = this.heroTypesInProduction(this.localPlayer);
      if (inProduction.has(unitId) || inProduction.size >= MAX_HEROES) return;
    }
    const stash = this.rts.stashFor(this.localPlayer);
    const food = this.rts.foodFor(this.localPlayer);
    // WC3 melee: a player's FIRST hero is free of gold/lumber (only food).
    const freeHero = d.isHero && !this.freeHeroUsed.has(this.localPlayer);
    const gold = freeHero ? 0 : d.goldCost;
    const lumber = freeHero ? 0 : d.lumberCost;
    // Food (like gold/lumber) is committed when training begins; block if the
    // supply cap would be exceeded (WC3: "not enough food").
    if (stash.gold < gold || stash.lumber < lumber || food.used + d.foodUsed > food.made) return;
    stash.gold -= gold;
    stash.lumber -= lumber;
    if (freeHero) this.freeHeroUsed.add(this.localPlayer);
    // A neutral shop (tavern) hires heroes near-instantly; own buildings use the
    // unit's real build time (altar heroes ~55s).
    const shop = this.rts.simWorld.units.get(buildingId)?.neutralPassive;
    this.rts.simWorld.enqueueTrain(buildingId, unitId, shop ? TAVERN_HIRE_TIME : d.buildTime || 15);
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
    const meta = this.buildingFootprints.get(buildingId);
    if (meta && this.grid) {
      unstampFootprint(this.grid, meta.fp, meta.x, meta.y);
      this.buildingFootprints.delete(buildingId);
    }
    this.rts.simWorld.cancelBuilding(buildingId);
    if (fx) void this.spawnEffect(CANCEL_FX[this.localRace], fx.x, fx.y, fx.z);
  }

  private cancelTrain(buildingId: number): void {
    const uid = this.rts?.simWorld.cancelLastTrain(buildingId);
    this.refundTrain(uid);
  }

  /** Cancel a specific queue slot (0 = currently training) and refund it. */
  private cancelTrainAt(buildingId: number, index: number): void {
    const uid = this.rts?.simWorld.cancelTrainAt(buildingId, index);
    this.refundTrain(uid);
  }

  /** Refund a cancelled training unit's full cost to the local player. */
  private refundTrain(uid: string | null | undefined): void {
    if (!uid || !this.rts) return;
    const d = this.registry.get(uid);
    if (d) {
      const stash = this.rts.stashFor(this.localPlayer);
      stash.gold += d.goldCost;
      stash.lumber += d.lumberCost;
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
    // Normal = the WC3 arrow everywhere; whenever the DOM target reticle is shown
    // over the MAP (an armed order OR hovering a unit), hide the OS cursor there
    // and let the reticle follow the mouse. Scoped to the map canvas so the
    // arrow still shows over HUD buttons (whose hover can't reach the reticle).
    this.cursorStyleEl.textContent =
      `body.in-game, body.in-game * { cursor: ${rule} !important; }\n` +
      `body.in-game.reticle-on #map { cursor: none !important; }`;
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
    // The hero "Hero Abilities" learn-skill book uses the disabled-folder Skillz art
    // (see pushAbilityButtons) — not a registry icon, so warm it explicitly.
    paths.add("ReplaceableTextures\\CommandButtonsDisabled\\DISBTNSkillz.blp");
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
      this.updateCamera();
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
      // The F10 game menu freezes the simulation (units hold; rendering continues).
      if (!this.paused) {
        // Clamp the sim step (not the render/HUD dt). dt is the real inter-frame time, so
        // a GC hitch, tab-switch, or heavy frame would otherwise feed the sim one giant
        // step — units teleport and collision resolution overshoots and jitters (issue
        // #24: the worse the frame rate, the worse the melee "shuffle"). Capping at 50 ms
        // (≈20 fps) keeps every sim step inside the stable regime the movement/collision
        // code is tuned for; a slow frame just advances the world a little less.
        const simDt = Math.min(dt, 50) / 1000;
        this.tickPendingBuild(simDt); // seconds, matching the sim's clock
        this.rts?.tick(simDt); // sim runs in seconds; advance + sync before render
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
      this.updateAuraEffects();
      this.updateTreePulses(dt / 1000);
      this.updateTreeActors(); // per-chop "stand hit" wobble on felled/chopped trees' stand-ins
      this.updateProjectiles();
      this.updateBloodMageSpheres(dt / 1000); // Blood Mage orbiting spheres + thrown balls
      this.updatePendingBuildGhosts(); // dark-blue ghosts of queued-but-not-started builds
      if (this.placement) this.updateGhost(this.lastMouse.x, this.lastMouse.y); // show/position the ghost each frame (not only on mouse move)
      this.updateReticle(this.lastMouse.x, this.lastMouse.y);
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
          void this.spawnUnit(d, sx, sy, this.localPlayer, this.teamOf(this.localPlayer)).then((simId) => {
            if (simId !== null) this.applyRally(simId, rally);
          });
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
        // Sustain the looping bed under each running channelled field, and drop it the
        // frame the field ends — waves exhausted OR caster interrupted (world tears the
        // field down either way, so this needs no interrupt handling of its own).
        this.updateFieldLoops(world.activeSpellFields());
        // Cast animations (throw/slam/spell) begin at the wind-up.
        for (const c of world.drainCastStarts()) {
          this.rts!.playCastAnim(c.casterId, c.code, c.hold, c.loop);
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
          this.sounds?.playSpellSound([def.targetArt, def.casterArt, def.specialArt], SPELL_SOUND_FALLBACK[c.code], at);
        }
        // Hero level-up nova.
        for (const lu of world.drainLevelUps()) {
          const h = world.units.get(lu.unitId);
          if (h) void this.spawnEffect(LEVEL_UP_FX, h.x, h.y, this.rts!.groundHeightAt(h.x, h.y), 1.5);
        }
        // Summoned / raised units — create their models IN FRONT of the caster
        // (nearest free tile), play their birth clip, then flag temporary summons
        // (Water Elemental) so the sim expires them on schedule.
        for (const s of world.drainSummonRequests()) {
          const d = this.registry.get(s.unitId);
          if (!d) continue;
          const summonLeft = s.summonLeft;
          const [sx, sy] = this.summonSpot(s.x, s.y, s.facing, d.collision || 16);
          void this.spawnUnit(d, sx, sy, s.owner, s.team).then((simId) => {
            if (simId === null) return;
            const su = world.units.get(simId);
            if (su && summonLeft > 0) {
              su.summonLeft = summonLeft;
              su.summonMax = summonLeft;
              su.isSummon = true; // temporary summon — expires, leaves no corpse, ×0.5 XP
            }
            this.rts!.beginSummonBirth(simId); // materialize (birth clip + spawn lock)
          });
        }
        // --- items on the ground (dropped / creep-dropped) ---
        for (const it of world.drainItemSpawns()) void this.spawnItemModel(it.id, it.itemId, it.x, it.y);
        for (const id of world.drainItemRemovals()) this.removeItemModel(id);
        this.updateItemAnims();
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
      if (map && fogScene && map.anyReady) {
        fogScene.startFrame();
        map.renderGround();
        map.renderCliffs();
        fogScene.renderOpaque();
        map.renderWater();
        if (this.splats) this.splats.render(fogScene.camera.viewProjectionMatrix);
        // Selection rings draw right after the building splats (so a ring paints ON TOP
        // of a foundation decal — issue #16) and BEFORE the translucent units (so a unit
        // body draws over its own ring, which reads as sitting under it). Before the fog
        // so the veil dims it like the ground.
        if (this.ringSplats) this.ringSplats.render(fogScene.camera.viewProjectionMatrix);
        fogScene.renderTranslucent();
      } else {
        // Map not fully ready — fall back to the stock all-in-one path (splats after).
        this.viewer.render();
        if (this.splats && fogScene) this.splats.render(fogScene.camera.viewProjectionMatrix);
        if (this.ringSplats && fogScene) this.ringSplats.render(fogScene.camera.viewProjectionMatrix);
      }
      if (this.fog && fogScene) this.fog.render(fogScene.camera.viewProjectionMatrix);
      // Building-placement footprint grid (green = buildable, red = obstructed) — drawn
      // over the world while a build is being positioned so the player sees the pathing
      // collider and which cells block the site. Reuses the debug-collider overlay pass.
      if (this.placement && this.placeCellVerts > 0 && fogScene) {
        this.debug ??= new DebugColliders(this.viewer.gl);
        this.debug.render(fogScene.camera.viewProjectionMatrix, [{ data: this.placeCells, verts: this.placeCellVerts, mode: "tri" }]);
      }
      if (this.showColliders && fogScene) this.renderColliders(fogScene.camera.viewProjectionMatrix, dt);
      if (this.showPathing && fogScene) this.renderPathing(fogScene.camera.viewProjectionMatrix, dt);
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
    document.body.classList.remove("reticle-on"); // restore the OS/WC3 cursor
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
    this.simBuildingSplats.clear();
    this.mapBuildingSplats.clear();
    this.debug?.dispose();
    this.debug = null;
    this.pathGridLayer?.dispose();
    this.pathBlockedLayer?.dispose();
    this.pathRouteLayer?.dispose();
    this.pathGridLayer = this.pathBlockedLayer = this.pathRouteLayer = null;
    this.dbgGridFor = null;
    this.metrics.dispose();
    this.hud?.dispose();
    this.hud = null;
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
    document.body.classList.remove("reticle-on", "carrying-item");
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

  private disposeFog(): void {
    this.fog?.dispose();
    this.fog = null;
    this.fogTerrain = null;
    this.removedWidgets.clear();
    this.baseColors = new WeakMap();
    this.fogAccum = 0;
  }

  private updateCamera(): void {
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
    // the arrow keys.
    const letters = !this.hud;
    const speed = this.distance * 0.9 * (1 / 60);
    const fwd: [number, number] = [Math.cos(this.yaw), Math.sin(this.yaw)];
    const right: [number, number] = [fwd[1], -fwd[0]];
    if ((letters && this.keys.has("w")) || this.keys.has("arrowup")) this.pan(fwd, speed);
    if ((letters && this.keys.has("s")) || this.keys.has("arrowdown")) this.pan(fwd, -speed);
    if ((letters && this.keys.has("d")) || this.keys.has("arrowright")) this.pan(right, speed);
    if ((letters && this.keys.has("a")) || this.keys.has("arrowleft")) this.pan(right, -speed);
    this.updateEdgeScroll(fwd, right, speed); // pan when the cursor rests at a screen edge

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
    scene.camera.perspective(Math.PI / 4, this.aspect(), 16, this.distance * 8);
    scene.camera.moveToAndFace(eye, this.target, UP);
    // Drive positional (WANT3D) audio: listener at the ground focus, facing the
    // camera's look direction so on-screen battles pan + attenuate around center.
    this.sounds?.setListener(this.target, eye);
  }

  // Edge-of-screen scrolling (WC3): pan when the cursor rests within EDGE_MARGIN of
  // a screen edge, and show a directional arrow cursor pointing the scroll way.
  private scrollArrow: HTMLDivElement | null = null;
  private updateEdgeScroll(fwd: [number, number], right: [number, number], speed: number): void {
    // Only in a live match, cursor over the map (not the console), nothing modal.
    const active =
      !!this.hud &&
      !this.paused &&
      !this.placement &&
      this.mouseOverCanvas &&
      !document.body.classList.contains("game-menu-open");
    let dx = 0;
    let dy = 0;
    if (active) {
      const m = this.lastMouse;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const margin = MapViewerScene.EDGE_MARGIN;
      if (m.x <= margin) dx = -1;
      else if (m.x >= w - margin) dx = 1;
      if (m.y <= margin) dy = -1;
      else if (m.y >= h - margin) dy = 1;
    }
    if (dx || dy) {
      if (dx) this.pan(right, dx * speed);
      if (dy) this.pan(fwd, -dy * speed); // top of screen (dy<0) pans the view forward
    }
    this.showScrollArrow(dx, dy);
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
    // Directional glyph (8-way) placed at the cursor, pointing the scroll way.
    const arrows: Record<string, string> = { "-1,-1": "↖", "0,-1": "↑", "1,-1": "↗", "-1,0": "←", "1,0": "→", "-1,1": "↙", "0,1": "↓", "1,1": "↘" };
    this.scrollArrow.textContent = arrows[`${dx},${dy}`] ?? "";
    this.scrollArrow.style.left = `${this.lastMouse.x}px`;
    this.scrollArrow.style.top = `${this.lastMouse.y}px`;
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
    const worldPerPx = (2 * this.distance * Math.tan(Math.PI / 8)) / h; // fov = π/4
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

  /** Draw the drag-selection rectangle (canvas fills the page, so offset coords
   *  are page coords). */
  private updateSelectBox(x: number, y: number): void {
    if (!this.selectBoxEl) {
      this.selectBoxEl = document.createElement("div");
      this.selectBoxEl.className = "select-box";
      document.body.appendChild(this.selectBoxEl);
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
   *  enemy — and hide the OS cursor over the map (via the `reticle-on` class). */
  private updateReticle(cssX: number, cssY: number): void {
    if (!this.rts) return this.hideCursorOverlay();
    const mode = this.rts.orderMode;
    // Carrying an item (right-clicked in the inventory to move it): the cursor stays
    // the plain WC3 hand — no reticle — and the item's icon rides along at half size,
    // as if the gauntlet were holding it. Handled before everything else so no hover
    // tint or armed-order reticle can steal the cursor while you're carrying.
    const carrySlot = mode === "item" && this.rts.armedItem?.mode === "move" ? this.rts.armedItem.slot : -1;
    // Positioned off lastCursor, not the passed-in map coords: the move is armed by a
    // right-click on the HUD, where lastMouse hasn't been updated.
    this.updateCarriedItem(carrySlot, this.lastCursor.x, this.lastCursor.y);
    if (carrySlot >= 0) {
      document.body.classList.remove("reticle-on"); // let the OS hand cursor show through
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
      document.body.classList.remove("reticle-on");
      return this.hideCursorOverlay();
    }
    document.body.classList.add("reticle-on");
    if (!this.reticleEl) {
      this.reticleEl = document.createElement("div");
      document.body.appendChild(this.reticleEl);
    }
    const el = this.reticleEl;
    el.hidden = false;
    el.style.left = `${cssX}px`;
    el.style.top = `${cssY}px`;
    el.style.backgroundImage = `url(${url})`;
    el.className = `order-reticle ${kind} pulse`;
  }

  /** Show/hide the half-size item icon that follows the hand while an inventory item
   *  is armed for a move. `slot` < 0 hides it. It follows the cursor everywhere —
   *  over the map AND the console — because every one of those is a legal drop
   *  target (another slot, the ground, an allied hero). */
  private updateCarriedItem(slot: number, cssX: number, cssY: number): void {
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
    this.carryEl.style.left = `${cssX}px`;
    this.carryEl.style.top = `${cssY}px`;
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
      this.mouseOverCanvas = true;
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
    // Pointer over an interactive HUD element (which swallows the canvas move
    // events): clear the hover so the reticle hides and the normal cursor shows.
    // Where the pointer is, ALWAYS — unlike `lastMouse`, which only tracks the canvas
    // (and the HUD once an order is armed). A right-click that arms an item move
    // happens over the HUD with nothing armed yet, so lastMouse is stale there and the
    // carried icon would sit at the last map position until you moved the mouse.
    const trackCursor = (e: PointerEvent | MouseEvent) => {
      this.lastCursor.x = e.clientX;
      this.lastCursor.y = e.clientY;
    };
    window.addEventListener("pointermove", trackCursor, { capture: true });
    window.addEventListener("pointerdown", trackCursor, { capture: true });
    window.addEventListener("contextmenu", trackCursor, { capture: true });
    window.addEventListener("pointermove", (e) => {
      // Self-heal a stuck drag even while the pointer is off the canvas (over the
      // HUD): still "dragging" with the left button not held means the pointerup
      // was lost, so cancel it here too — the canvas handler can't see these moves.
      if (this.dragging && !(e.buttons & 1)) this.cancelDrag();
      if (e.target !== this.canvas && !this.dragging) {
        this.mouseOverCanvas = false; // over the HUD/chrome — suspend edge-scroll
        this.rts?.clearHover();
        // While a spell/order is armed, keep the reticle following the cursor over
        // the HUD too, so you can aim skills at units in the console's group grid.
        if (this.rts?.orderMode) {
          this.lastMouse.x = e.clientX;
          this.lastMouse.y = e.clientY;
        }
      }
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.distance = clamp(this.distance * (1 + Math.sign(e.deltaY) * 0.1), MapViewerScene.ZOOM_MIN, MapViewerScene.ZOOM_MAX);
      },
      { passive: false },
    );
  }
}

function syncCanvasSize(canvas: HTMLCanvasElement): void {
  // Match the WebGL backing buffer to the element's on-screen (CSS) size × DPR.
  // Derive the wanted size from clientWidth/Height (the actual on-screen size),
  // NOT from the current buffer — that's what lets a window resize (F11,
  // devtools, browser zoom / DPI change) re-sync instead of stretching a stale
  // buffer. Only assign when it changed: reassigning canvas.width/height even to
  // the same value reallocates and clears the GL drawing buffer.
  const w = Math.floor(canvas.clientWidth * devicePixelRatio) || 1280;
  const h = Math.floor(canvas.clientHeight * devicePixelRatio) || 720;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
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
// silhouette across any building. Alpha MUST stay 1.0 — a translucent (<1) vertex colour
// makes many building models vanish entirely (the same mdx-m3-viewer quirk the cursor
// ghost avoids by not tinting at all); "hard" dark blue is opaque anyway.
const PENDING_GHOST_TINT = [0.12, 0.22, 0.85, 1.0] as const;
const COLLIDER_LIFT = 12; // raise shapes above the ground so they read clearly
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
