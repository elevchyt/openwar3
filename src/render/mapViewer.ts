import War3MapViewer from "mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/viewer";
import ModelViewer from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import type { DataSource } from "../vfs/types";
import w3iParser from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";
import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import { MpqDataSource } from "../vfs/mpq";
import { parseW3E } from "../world/terrain";
import { parseDoo } from "../world/doodads";
import { PathingGrid, parseWpm } from "../sim/pathing";
import { stampFootprints, stampFootprint, unstampFootprint, decodePathTex, type Footprint } from "../sim/destructibles";
import unitsdoo from "mdx-m3-viewer/dist/cjs/parsers/w3x/unitsdoo";
import { makeHeightSampler } from "../game/heightmap";
import { RtsController, type RtsHost } from "../game/rts";
import { loadUnitRegistry, type UnitRegistry, type UnitDef } from "../data/units";
import { STARTING_UNITS, resolveRace, type PlayableRace } from "../data/races";
import { ModelViewerScene } from "./modelViewer";
import type { MeleeConfig } from "../ui/lobby";
import { MetricsOverlay } from "../ui/metrics";
import { GameHud, type HudDriver, type CommandButton } from "../ui/hud";
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

// Minimal local typings (mdx-m3-viewer's exports drag in their own gl-matrix).
// The viewer calls the solver as (src, solverParams) — params carry the map's
// tileset letter once war3map.w3i is parsed.
type Solver = (src: unknown, params?: { tileset?: string }) => unknown;
interface Camera {
  perspective(fov: number, aspect: number, near: number, far: number): void;
  moveToAndFace(from: Float32Array, to: Float32Array, up: Float32Array): void;
}
interface Scene {
  camera: Camera;
  viewport: Float32Array;
}
interface HideableWidget {
  instance: { localLocation: Float32Array; hide(): void };
}
interface W3xMap {
  worldScene: Scene;
  centerOffset: Float32Array;
  mapSize: Int32Array;
  update(): void;
  units: unknown[];
  doodads: HideableWidget[];
  unitsReady: boolean;
}
interface W3xViewer {
  loadedBaseFiles: boolean;
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
  hide(): void;
  show(): void;
  setSequence(i: number): void;
  setSequenceLoopMode(m: number): void;
  setLocation(v: ArrayLike<number>): unknown;
  setRotation(q: ArrayLike<number>): unknown;
  detach(): boolean; // remove from the scene (projectiles on impact)
  localLocation: Float32Array;
  localRotation: Float32Array;
  model: { sequences: Array<{ name: string }> };
}
interface SpawnModel {
  addInstance(): SpawnInstance;
}

const ViewerClass = War3MapViewer as unknown as {
  new (canvas: HTMLCanvasElement, solver: Solver, isReforged: boolean): W3xViewer;
};

export class MapViewerScene {
  // Orbit camera state.
  private target = new Float32Array([0, 0, 0]);
  private distance = 4000;
  // Look from the south toward +Y (north up), matching WC3's default camera so
  // units/buildings (which default to facing 270° = south) face the viewer.
  private yaw = Math.PI / 2;
  private pitch = 0.95;
  private keys = new Set<string>();
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private moved = false;
  private raf = 0;
  private last = 0;
  private rts: RtsController | null = null;
  private grid: PathingGrid | null = null;
  private footprints = new Map<string, Footprint | null>();
  private metrics = new MetricsOverlay();
  private hud: GameHud | null = null;
  private minimap: HTMLCanvasElement | null = null;
  private iconCache = new Map<string, string | null>();
  private localPlayer = 0;
  private localRace: PlayableRace = "human";
  // Footprints of registered resource nodes, for unstamping on removal.
  private nodeFootprints = new Map<number, { fp: Footprint; x: number; y: number }>();
  // Animated portrait of the selected unit (own small viewer + canvas).
  private portraitViewer: ModelViewerScene | null = null;
  private portraitFor: number | null = null;
  private portraitLoading = false;
  private cameraLock = false; // portrait held → camera follows the selected unit
  private cardPage: "root" | "build" = "root";
  private lastSelected: number | null = null;
  private placement: { def: UnitDef; fp: Footprint | null; workerId: number } | null = null;
  private ghost: HTMLDivElement | null = null;
  // Translucent building-silhouette ghost that follows the cursor while placing.
  private buildGhosts = new Map<string, SpawnInstance>();
  private buildGhost: SpawnInstance | null = null;
  private pendingBuilds: Array<{ workerId: number; def: UnitDef; x: number; y: number }> = [];
  private meleeTeams = new Map<number, number>(); // owner slot → team
  // Flat selection-circle model instances, rendered on the terrain so geometry
  // occludes the far side (unlike a DOM overlay drawn on top).
  private selCircles: Array<SpawnInstance | null> = []; // pool, one per selected unit
  private hoverCircle: SpawnInstance | null = null;
  private circleModel: SpawnModel | null = null;
  private selectBoxEl: HTMLDivElement | null = null;
  private circleSeq = { friendly: 0, enemy: 1, neutral: 2 };
  private flashCircles: Array<{ inst: SpawnInstance; t: number }> = [];
  // Projectile (missile) instances, keyed by the sim projectile id.
  private projectileModels = new Map<string, SpawnModel | null>();
  private projectileInsts = new Map<number, SpawnInstance>();
  private projectileLoading = new Set<number>();
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
    private solver: Solver,
  ) {
    this.attachControls();
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

    // Cliff models are loaded via loadBaseFile() → fetch(), so — like the base
    // SLKs — they need a STRING url, not a Promise. Everything else goes through
    // viewer.load(), which takes bytes. Generated cliff-model blob URLs are cached
    // and tracked in `created` for revocation on dispose.
    const cliffUrls = new Map<string, string | null>();
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
      if (/^doodads\\terrain\\.*\.mdx$/i.test(path)) {
        let url = cliffUrls.get(path);
        if (url === undefined) {
          const bytes = vfs.rawBytes(path);
          url = bytes ? URL.createObjectURL(new Blob([bytes as BlobPart])) : null;
          cliffUrls.set(path, url);
          if (url) created.push(url);
        }
        return url ?? src;
      }
      return vfs.read(path); // models/textures: Promise<Uint8Array>
    };

    const viewer = new ViewerClass(canvas, solver, false);
    viewer.terrainModelExists = (path) => vfs.exists(path);
    viewer.on("error", (e) => console.error("[mapviewer]", e));

    await new Promise<void>((resolve) => {
      if (viewer.loadedBaseFiles) resolve();
      else viewer.once("loadedbasefiles", resolve);
    });

    return new MapViewerScene(canvas, viewer, created, vfs, loadUnitRegistry(vfs), solver);
  }

  /** Load a .w3x/.w3m (raw archive bytes) and frame the camera on the whole map. */
  loadMap(bytes: Uint8Array): void {
    syncCanvasSize(this.canvas);
    // Drop the previous map's scene so reloading doesn't stack renders.
    const prev = this.viewer.map?.worldScene;
    if (prev) this.viewer.removeScene(prev);
    this.rts?.dispose();
    this.rts = null;

    this.viewer.loadMap(bytes);
    const map = this.viewer.map;
    if (!map) return;

    const [cols, rows] = map.mapSize;
    const [ox, oy] = map.centerOffset;
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
      this.rts = new RtsController(grid, makeHeightSampler(terrain), host, this.registry);
      this.registerResourceNodes(nodes);
    }
  }

  /** Feed harvestable trees and gold mines into the headless sim, remembering
   *  each node's stamped footprint so it can be unstamped on removal. */
  private registerResourceNodes(nodes: { trees: Array<{ x: number; y: number; pathTex: string }>; mines: Array<{ x: number; y: number; gold: number }> }): void {
    const world = this.rts?.simWorld;
    if (!world) return;
    this.nodeFootprints.clear();
    for (const t of nodes.trees) {
      const tree = world.addTree(t.x, t.y);
      const fp = this.footprintFor(t.pathTex);
      if (fp) this.nodeFootprints.set(tree.id, { fp, x: t.x, y: t.y });
    }
    const minePathTex = this.registry.get("ngol")?.pathTex || "";
    const mineFp = minePathTex ? this.footprintFor(minePathTex) : null;
    for (const m of nodes.mines) {
      const radius = mineFp ? (Math.max(mineFp.w, mineFp.h) * 32) / 2 : 96;
      const mine = world.addMine(m.x, m.y, m.gold, radius);
      if (mineFp) this.nodeFootprints.set(mine.id, { fp: mineFp, x: m.x, y: m.y });
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
    best?.instance.hide();
  }

  /** Stamp destructible (tree) AND building footprints onto the terrain grid so
   *  units path around them (war3map.wpm is terrain-only). Also collects the
   *  harvestable resource nodes (trees + gold mines) for the sim. */
  private stampMapPathing(
    grid: PathingGrid,
    archive: MpqDataSource,
  ): { trees: Array<{ x: number; y: number; pathTex: string }>; mines: Array<{ x: number; y: number; gold: number }> } {
    const trees: Array<{ x: number; y: number; pathTex: string }> = [];
    const mines: Array<{ x: number; y: number; gold: number }> = [];
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

    // Pre-placed building units (gold mines, neutral buildings) from war3mapUnits.doo.
    const unitBytes = archive.rawBytes("war3mapUnits.doo");
    if (unitBytes) {
      const units = new unitsdoo.File();
      try {
        units.load(unitBytes, buildVersion);
      } catch {
        return { trees, mines };
      }
      const buildings = units.units
        .filter((u) => this.registry.get(u.id)?.isBuilding)
        .map((u) => ({ id: u.id, x: u.location[0], y: u.location[1] }));
      stampFootprints(grid, buildings, (id) => this.registry.get(id)?.pathTex || undefined, readBytes);
      for (const u of units.units) {
        if (u.id === "ngol") {
          mines.push({ x: u.location[0], y: u.location[1], gold: (u as { goldAmount?: number }).goldAmount ?? 12500 });
        }
      }
    }
    return { trees, mines };
  }

  private slkText(path: string): string {
    const bytes = this.vfs.rawBytes(path);
    return bytes ? new TextDecoder("windows-1252").decode(bytes) : "";
  }

  /** Spawn each player's starting units at their start location (plan Phase 5.5). */
  async startMelee(config: MeleeConfig): Promise<void> {
    if (!this.rts || !this.viewer.map) return;
    this.localPlayer = config.slots.find((s) => s.controller === "user")?.id ?? config.slots[0]?.id ?? 0;
    this.rts.setLocalPlayer(this.localPlayer); // drag-box selects this player's units
    // Open on the local player's base at gameplay zoom.
    const home = config.slots.find((s) => s.id === this.localPlayer);
    if (home) {
      this.target[0] = home.startX;
      this.target[1] = home.startY;
      this.distance = 1750;
    }
    // Resolve "random" once per slot: roster and console skin must agree.
    const races = new Map(config.slots.map((s) => [s.id, resolveRace(s.race)]));
    this.localRace = races.get(this.localPlayer) ?? "human";
    this.meleeTeams = new Map(config.slots.map((s) => [s.id, s.team]));
    this.applyRaceCursor();
    for (const slot of config.slots) this.rts.simWorld.initStash(slot.id, 500, 150); // WC3 melee start
    this.mountHud();
    void this.loadSelectionCircles();
    for (const slot of config.slots) {
      const roster = STARTING_UNITS[races.get(slot.id) ?? "human"];
      const workerTotal = roster
        .filter((r) => !this.registry.get(r.id)?.isBuilding)
        .reduce((n, r) => n + r.count, 0);
      let placed = 0;
      for (const { id, count } of roster) {
        const def = this.registry.get(id);
        if (!def) continue;
        for (let i = 0; i < count; i++) {
          let x = slot.startX;
          let y = slot.startY;
          if (!def.isBuilding) {
            // Ring the workers around the start location (in front of the hall).
            const a = (placed++ / Math.max(1, workerTotal)) * Math.PI * 2;
            x += Math.cos(a) * 300;
            y += Math.sin(a) * 300;
          }
          await this.spawnUnit(def, x, y, slot.id, slot.team);
        }
      }
    }
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
    if (fp && this.grid) stampFootprint(this.grid, fp, x, y);
    return simId;
  }

  /** Place the building being positioned at the cursor, if valid and affordable.
   *  The structure is NOT spawned yet — the worker walks to the site and the
   *  building rises only once it arrives (see tickPendingBuild). */
  private placeBuilding(cssX: number, cssY: number): void {
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
    this.rts.moveSelectedTo(x, y); // send the worker to the site
    this.pendingBuilds.push({ workerId: p.workerId, def: p.def, x, y });
    this.cardPage = "root";
    this.cancelPlacement();
  }

  /** When a pending-build worker reaches its site, raise the building (under
   *  construction) and attach the worker as its builder. */
  private tickPendingBuild(): void {
    if (!this.rts || !this.pendingBuilds.length) return;
    const world = this.rts.simWorld;
    for (let i = this.pendingBuilds.length - 1; i >= 0; i--) {
      const pb = this.pendingBuilds[i];
      const w = world.units.get(pb.workerId);
      if (!w) {
        this.pendingBuilds.splice(i, 1); // worker died en route
        continue;
      }
      const near = Math.hypot(w.x - pb.x, w.y - pb.y) < 160 && !w.moving;
      if (!near) continue;
      this.pendingBuilds.splice(i, 1);
      void this.spawnUnit(pb.def, pb.x, pb.y, this.localPlayer, this.teamOf(this.localPlayer), pb.def.buildTime || 60).then((simId) => {
        if (simId !== null) world.assignBuilder(pb.workerId, simId);
      });
    }
  }

  private teamOf(owner: number): number {
    return this.meleeTeams.get(owner) ?? owner;
  }

  // --- selection circles (flat ground models) -------------------------------

  private async loadSelectionCircles(): Promise<void> {
    const map = this.viewer.map;
    if (!map) return;
    const model = (await this.viewer.load("UI\\Feedback\\selectioncircle\\selectioncircle.mdx", this.solver)) as SpawnModel | undefined;
    if (!model) return;
    this.circleModel = model;
    const seqs = (model as unknown as { sequences?: Array<{ name: string }> }).sequences ?? [];
    const idx = (re: RegExp) => Math.max(0, seqs.findIndex((s) => re.test(s.name)));
    this.circleSeq = { friendly: idx(/^friendly$/i), enemy: idx(/^enemy$/i), neutral: idx(/^neutral$/i) };
    this.hoverCircle = this.newCircle();
  }

  private newCircle(): SpawnInstance | null {
    const map = this.viewer.map;
    if (!this.circleModel || !map) return null;
    const inst = this.circleModel.addInstance();
    inst.setScene(map.worldScene);
    inst.setSequenceLoopMode(2);
    inst.hide();
    return inst;
  }

  /** Position/scale/colour the flat selection + hover rings each frame, plus
   *  the transient yellow harvest-order flashes. */
  private updateSelectionCircles(dt: number): void {
    const rings = this.rts?.selectionRings() ?? [];
    for (let i = 0; i < rings.length; i++) {
      // Retry while null (the circle model may not have loaded yet); newCircle
      // is a no-op returning null until then, so this doesn't leak.
      if (!this.selCircles[i]) this.selCircles[i] = this.newCircle();
      this.placeCircle(this.selCircles[i], rings[i], null);
    }
    for (let i = rings.length; i < this.selCircles.length; i++) this.selCircles[i]?.hide();
    // hoverRing() already returns null when the hovered unit is selected.
    this.placeCircle(this.hoverCircle, this.rts?.hoverRing() ?? null, null);
    this.tickFlashCircles(dt);
  }

  /** Draw + time the harvest-/attack-order flashes (flat ground rings, twice):
   *  yellow for a harvest target, red for an attack target (colour per request). */
  private tickFlashCircles(dt: number): void {
    for (const req of this.rts?.drainFlashes() ?? []) {
      const inst = this.newCircle();
      if (!inst) break;
      this.flashCircles.push({ inst, t: 0.7 });
      this.placeCircle(inst, { x: req.x, y: req.y, z: req.z, radius: req.radius, owner: -2, team: -2 }, req.color);
    }
    for (let i = this.flashCircles.length - 1; i >= 0; i--) {
      const f = this.flashCircles[i];
      f.t -= dt;
      // Two on/off blinks over 0.7s.
      const on = f.t > 0 && (f.t % 0.35) > 0.12;
      if (on) f.inst.show();
      else f.inst.hide();
      if (f.t <= 0) {
        f.inst.hide();
        this.flashCircles.splice(i, 1);
      }
    }
  }

  // --- projectiles (missile models) -----------------------------------------

  private static readonly MISSILE_HEIGHT = 60; // launch/flight height above ground

  /** Create missile instances for freshly-launched projectiles, move live ones
   *  to their current sim position each frame, and detach ones that landed. */
  private updateProjectiles(): void {
    const world = this.rts?.simWorld;
    const map = this.viewer.map;
    if (!world || !map) return;
    for (const p of world.drainSpawnedProjectiles()) {
      if (!p.art) continue; // no missile model (still deals delayed damage)
      this.projectileLoading.add(p.id);
      void this.loadProjectile(p.id, p.art);
    }
    for (const id of world.drainRemovedProjectiles()) this.detachProjectile(id);
    for (const [id, inst] of this.projectileInsts) {
      const p = world.projectiles.get(id);
      if (!p) {
        this.detachProjectile(id); // landed before its model finished loading
        continue;
      }
      const t = world.units.get(p.targetId);
      this.loc3[0] = p.x;
      this.loc3[1] = p.y;
      this.loc3[2] = this.rts!.groundHeightAt(p.x, p.y) + MapViewerScene.MISSILE_HEIGHT;
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

  private placeCircle(
    inst: SpawnInstance | null,
    info: { x: number; y: number; z: number; radius: number; owner: number; team: number } | null,
    tint: number[] | null,
  ): void {
    if (!inst) return;
    if (!info) {
      inst.hide();
      return;
    }
    inst.show();
    this.loc3[0] = info.x;
    this.loc3[1] = info.y;
    const scale = info.radius / 38; // model ring radius ≈ 38 world units
    // The ring model's geometry sits ~14 units up in model space, and that
    // offset is multiplied by the uniform scale — so a big (mine-sized) ring
    // floated well above the terrain. Drop it by the *scaled* offset so every
    // ring hugs the ground regardless of size (sampled fresh each frame).
    this.loc3[2] = info.z - 14 * scale;
    inst.setLocation(this.loc3);
    inst.setUniformScale(scale);
    inst.setVertexColor(tint ?? [1, 1, 1]);
    // Flashes (tinted) use the neutral (white) base so the tint carries the
    // colour cleanly. Real selection/hover rings colour by alliance: your own
    // and allied (same-team) units are green, everyone else — including
    // neutral-hostile creeps — is red.
    let seq: number;
    if (tint) seq = this.circleSeq.neutral;
    else {
      const friendly = info.owner === this.localPlayer || info.team === this.teamOf(this.localPlayer);
      seq = friendly ? this.circleSeq.friendly : this.circleSeq.enemy;
    }
    inst.setSequence(seq);
    inst.setSequenceLoopMode(2);
  }

  /** All of the building footprint's cells must be walkable and unreserved. */
  private placementValid(x: number, y: number): boolean {
    const p = this.placement;
    if (!p || !this.grid || !p.fp) return true;
    const [bx, by] = this.grid.worldToCell(x - (p.fp.w * 32) / 2, y - (p.fp.h * 32) / 2);
    for (let cy = 0; cy < p.fp.h; cy++) {
      for (let cx = 0; cx < p.fp.w; cx++) {
        if (!p.fp.blocked[cy * p.fp.w + cx]) continue;
        if (!this.grid.walkable(bx + cx, by + cy) || this.grid.isReserved(bx + cx, by + cy)) return false;
      }
    }
    return true;
  }

  /** Update the build-placement ghost under the cursor: the translucent
   *  building silhouette (blue = valid, red = blocked) positioned on the ground.
   *  Falls back to a green/red cursor box until the model has loaded. */
  private updateGhost(cssX: number, cssY: number): void {
    if (!this.placement || !this.rts || !this.grid) {
      if (this.ghost) this.ghost.hidden = true;
      this.buildGhost?.hide();
      return;
    }
    const hit = this.rts.groundPoint(cssX, cssY);
    let x = 0;
    let y = 0;
    let valid = false;
    if (hit) {
      [x, y] = hit;
      const fp = this.placement.fp;
      if (fp) [x, y] = this.grid.snapForFootprintRect(x, y, fp.w, fp.h);
      valid = this.placementValid(x, y);
    }
    if (this.buildGhost && hit) {
      // Position the silhouette on the ground and tint it blue/red.
      this.buildGhost.show();
      this.loc3[0] = x;
      this.loc3[1] = y;
      this.loc3[2] = this.rts.groundHeightAt(x, y);
      this.buildGhost.setLocation(this.loc3);
      this.buildGhost.setVertexColor(valid ? [0.35, 0.55, 1, 0.55] : [1, 0.35, 0.3, 0.55]);
      if (this.ghost) this.ghost.hidden = true;
      return;
    }
    // Fallback cursor box (until the ghost model loads).
    if (!this.ghost) {
      this.ghost = document.createElement("div");
      this.ghost.className = "build-ghost";
      document.body.appendChild(this.ghost);
    }
    const cells = this.placement.fp ? Math.max(this.placement.fp.w, this.placement.fp.h) : 4;
    const size = cells * 14;
    this.ghost.hidden = false;
    this.ghost.classList.toggle("invalid", !valid);
    this.ghost.style.width = `${size}px`;
    this.ghost.style.height = `${size}px`;
    this.ghost.style.left = `${cssX}px`;
    this.ghost.style.top = `${cssY}px`;
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
      mapBounds: () => {
        const map = this.viewer.map;
        if (!map) return [0, 0, 1, 1];
        const [cols, rows] = map.mapSize;
        const [ox, oy] = map.centerOffset;
        return [ox, oy, (cols - 1) * 128, (rows - 1) * 128];
      },
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
      dayNight: () => this.rts?.timeOfDay() ?? { hour: 8, isDay: true },
      commandCard: () => this.commandCard(),
      runCommand: (id) => this.runCommand(id),
      minimapImage: () => this.minimap,
      consoleSkin: () => this.consoleSkin(),
    };
    this.hud = new GameHud(ui, driver);
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
        this.portraitViewer?.stop();
      }
      return;
    }
    if (sel.id === this.portraitFor || this.portraitLoading || !sel.model) return;
    const canvas = this.hud.portraitCanvas();
    if (!this.portraitViewer) this.portraitViewer = new ModelViewerScene(canvas, this.vfs);
    // WC3 ships dedicated talking-head models alongside most units.
    const portraitPath = sel.model.replace(/\.mdx$/i, "_Portrait.mdx");
    const path = this.vfs.exists(portraitPath) ? portraitPath : sel.model;
    this.portraitLoading = true;
    const id = sel.id;
    // Team glow follows the owner; 12 is the classic neutral (black) slot.
    this.portraitViewer
      .load(path, sel.owner >= 0 ? sel.owner : 12)
      .then(() => {
        this.portraitFor = id;
        this.portraitViewer!.start();
      })
      .catch(() => {})
      .finally(() => {
        this.portraitLoading = false;
      });
  }

  // --- command card ---------------------------------------------------------

  private cmd(over: Partial<CommandButton>): CommandButton {
    return { id: "", icon: null, name: "", hotkey: "", desc: "", gold: 0, lumber: 0, food: 0, col: 0, row: 0, disabled: false, active: false, ...over };
  }

  /** Build the command card for the current own-unit selection. */
  private commandCard(): CommandButton[] {
    const sel = this.rts?.selectedInfo();
    if (!sel || sel.owner !== this.localPlayer) return [];
    const btnIcon = (n: string) => this.blpIcon(`ReplaceableTextures\\CommandButtons\\${n}.blp`);
    const out: CommandButton[] = [];

    if (sel.underConstruction) {
      out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Cancel construction.", col: 3, row: 2 }));
      return out;
    }
    if (sel.isBuilding) {
      for (const uid of trainsFor(sel.typeId)) {
        const d = this.registry.get(uid);
        if (!d) continue;
        const stash = this.rts!.stashFor(this.localPlayer);
        const afford = stash.gold >= d.goldCost && stash.lumber >= d.lumberCost;
        out.push(this.cmd({
          id: `train:${uid}`, icon: this.blpIcon(d.icon), name: d.name, hotkey: d.name[0]?.toUpperCase() ?? "",
          desc: `Trains a ${d.name}.`, gold: d.goldCost, lumber: d.lumberCost, food: d.foodUsed,
          col: d.buttonX, row: d.buttonY, disabled: !afford,
        }));
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
          id: `build:${bid}`, icon: this.blpIcon(d.icon), name: d.name, hotkey: d.name[0]?.toUpperCase() ?? "",
          desc: `Builds ${d.name}.`, gold: d.goldCost, lumber: d.lumberCost, food: 0,
          col: d.buttonX, row: d.buttonY, disabled: !afford,
        }));
      }
      out.push(this.cmd({ id: "cancel", icon: btnIcon("BTNCancel"), name: "Cancel", hotkey: "Escape", desc: "Return to orders.", col: 3, row: 2 }));
      return out;
    }

    const armed = this.rts?.orderMode ?? null;
    out.push(this.cmd({ id: "move", icon: btnIcon("BTNMove"), name: "Move", hotkey: "M", desc: "Moves the unit to a target point.", col: 0, row: 0, active: armed === "move" }));
    out.push(this.cmd({ id: "stop", icon: btnIcon("BTNStop"), name: "Stop", hotkey: "S", desc: "Halts the unit's current order.", col: 1, row: 0 }));
    out.push(this.cmd({ id: "hold", icon: btnIcon("BTNHoldPosition"), name: "Hold Position", hotkey: "H", desc: "Holds the unit's position.", col: 2, row: 0 }));
    out.push(this.cmd({ id: "attack", icon: btnIcon("BTNAttack"), name: "Attack", hotkey: "A", desc: "Attacks a target unit or point.", col: 3, row: 0, active: armed === "attack" }));
    if (sel.isWorker) {
      out.push(this.cmd({ id: "build", icon: btnIcon("BTNHumanBuild"), name: "Build Structure", hotkey: "B", desc: "Brings up the list of structures you may build.", col: 0, row: 2 }));
    }
    return out;
  }

  private runCommand(id: string): void {
    if (!this.rts) return;
    if (id === "move" || id === "attack") {
      this.rts.orderMode = id;
      this.hud?.setArmed(true);
      return;
    }
    if (id === "stop" || id === "hold") {
      this.rts.stopSelected();
      this.rts.orderMode = null;
      this.hud?.clearOrderMode();
      return;
    }
    if (id === "build") {
      this.cardPage = "build";
      return;
    }
    if (id === "cancel") {
      if (this.placement) {
        this.cancelPlacement();
      } else if (this.cardPage === "build") {
        this.cardPage = "root";
      } else {
        // Building: refund the last queued unit.
        const sel = this.rts.selectedInfo();
        if (sel?.isBuilding) this.cancelTrain(sel.id);
      }
      return;
    }
    if (id.startsWith("build:")) {
      const def = this.registry.get(id.slice(6));
      const workerId = this.rts.selectedId;
      if (def && workerId !== null) {
        this.placement = { def, fp: def.pathTex ? this.footprintFor(def.pathTex) : null, workerId };
        void this.showBuildGhost(def);
      }
      return;
    }
    if (id.startsWith("train:")) {
      const sel = this.rts.selectedInfo();
      if (sel) this.trainUnit(sel.id, id.slice(6));
    }
  }

  private trainUnit(buildingId: number, unitId: string): void {
    const d = this.registry.get(unitId);
    if (!d || !this.rts) return;
    const stash = this.rts.stashFor(this.localPlayer);
    if (stash.gold < d.goldCost || stash.lumber < d.lumberCost) return;
    stash.gold -= d.goldCost;
    stash.lumber -= d.lumberCost;
    this.rts.simWorld.enqueueTrain(buildingId, unitId, d.buildTime || 15);
  }

  private cancelTrain(buildingId: number): void {
    const uid = this.rts?.simWorld.cancelLastTrain(buildingId);
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
  }

  /** Load (once per building type) and show the translucent silhouette ghost. */
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
      // Face south (3π/2) like a placed building — the model defaults to facing
      // east, which is the "wrong rotation" seen on the ghost.
      zQuat(this.mq, (3 * Math.PI) / 2);
      inst.setRotation(this.mq);
      // Show the FINISHED building: play its idle "Stand" clip, not the default
      // first sequence (often "Birth", the construction scaffold — that's why the
      // ghost looked like an unfinished preview).
      const stand = standSequence(inst.model.sequences);
      if (stand >= 0) {
        inst.setSequence(stand);
        inst.setSequenceLoopMode(2);
      }
      this.buildGhosts.set(def.id, inst);
    }
    // Only show it if this is still the active placement.
    if (this.placement?.def.id === def.id) {
      this.buildGhost = inst;
      inst.show();
    } else {
      inst.hide();
    }
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
    // The sheet is a grid of animation frames; the top-left cell is the idle
    // pointer. Cells are one-eighth of the sheet width.
    const cell = Math.round(sheet.width / 8);
    const frame = document.createElement("canvas");
    frame.width = cell;
    frame.height = cell;
    frame.getContext("2d")!.drawImage(sheet, 0, 0);
    const url = frame.toDataURL();
    // Hotspot near the gauntlet's fingertip (top-left).
    document.body.style.cursor = `url(${url}) 3 3, auto`;
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
      this.updatePortrait();
      this.tickPendingBuild();
      this.rts?.tick(dt / 1000); // sim runs in seconds; advance + sync before render
      this.updateSelectionCircles(dt / 1000);
      this.updateProjectiles();
      const world = this.rts?.simWorld;
      const map = this.viewer.map;
      if (world && map) {
        for (const tree of world.drainFelledTrees()) this.removeNodeVisual(tree.id, tree.x, tree.y, map.doodads);
        for (const mine of world.drainDepletedMines()) {
          this.removeNodeVisual(mine.id, mine.x, mine.y, map.units as unknown as HideableWidget[]);
        }
        // Spawn units that finished training, at their building's rally point.
        for (const t of world.drainTrained()) {
          const d = this.registry.get(t.unitId);
          if (d) void this.spawnUnit(d, t.rallyX, t.rallyY, this.localPlayer, this.teamOf(this.localPlayer));
        }
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
      this.viewer.startFrame();
      this.viewer.render();
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
  }

  /** Release the viewer's blob URLs (call when discarding the scene). */
  dispose(): void {
    this.stop();
    this.rts?.dispose();
    this.rts = null;
    this.metrics.dispose();
    this.hud?.dispose();
    this.hud = null;
    this.ghost?.remove();
    this.ghost = null;
    this.selectBoxEl?.remove();
    this.selectBoxEl = null;
    for (const g of this.buildGhosts.values()) g.hide();
    this.buildGhosts.clear();
    this.buildGhost = null;
    for (const inst of this.projectileInsts.values()) inst.detach();
    this.projectileInsts.clear();
    this.projectileLoading.clear();
    this.projectileModels.clear();
    this.placement = null;
    this.pendingBuilds = [];
    document.body.style.cursor = ""; // restore the default cursor off the map
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
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

    if (this.canvas.width !== scene.viewport[2] || this.canvas.height !== scene.viewport[3]) {
      syncCanvasSize(this.canvas);
      scene.viewport[2] = this.canvas.width;
      scene.viewport[3] = this.canvas.height;
    }

    const cp = Math.cos(this.pitch);
    const eye = new Float32Array([
      this.target[0] - Math.cos(this.yaw) * cp * this.distance,
      this.target[1] - Math.sin(this.yaw) * cp * this.distance,
      this.target[2] + Math.sin(this.pitch) * this.distance,
    ]);
    scene.camera.perspective(Math.PI / 4, this.aspect(), 16, this.distance * 8);
    scene.camera.moveToAndFace(eye, this.target, UP);
  }

  private pan(dir: [number, number], amount: number): void {
    this.target[0] += dir[0] * amount;
    this.target[1] += dir[1] * amount;
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
  }

  private hideSelectBox(): void {
    if (this.selectBoxEl) this.selectBoxEl.hidden = true;
  }

  private aspect(): number {
    return this.canvas.width / this.canvas.height || 1;
  }

  private attachControls(): void {
    const c = this.canvas;
    window.addEventListener("keydown", (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    // Left-drag rotates the camera; a left-click (no drag) selects a unit;
    // right-click issues a move order for the selection.
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      if (e.button === 2) {
        // Right-click cancels build placement / an armed order, else moves.
        if (this.placement) this.cancelPlacement();
        else if (this.rts?.orderMode) {
          this.rts.orderMode = null;
          this.hud?.clearOrderMode();
        } else this.rts?.moveAt(e.offsetX, e.offsetY);
        return;
      }
      if (e.button === 0) {
        this.dragging = true;
        this.downX = e.offsetX;
        this.downY = e.offsetY;
        this.moved = false;
      }
    });
    c.addEventListener("pointerup", (e) => {
      c.releasePointerCapture(e.pointerId);
      if (e.button === 0) {
        this.dragging = false;
        this.hideSelectBox();
        if (!this.rts) return;
        if (this.placement) {
          if (!this.moved) this.placeBuilding(e.offsetX, e.offsetY);
        } else if (this.rts.orderMode) {
          // An armed command-card order (Move/Attack) consumes the click.
          if (!this.moved && this.rts.orderClickAt(e.offsetX, e.offsetY)) this.hud?.clearOrderMode();
        } else if (this.moved) {
          // A left-drag is a rectangle selection of the player's own units.
          this.rts.selectBox(this.downX, this.downY, e.offsetX, e.offsetY);
        } else {
          this.rts.selectAt(e.offsetX, e.offsetY);
        }
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (this.placement) this.updateGhost(e.offsetX, e.offsetY);
      // WC3 keeps a fixed camera angle — no free rotation. A left-drag draws a
      // selection rectangle (unless placing a building or holding an armed order).
      if (this.dragging) {
        if (Math.hypot(e.offsetX - this.downX, e.offsetY - this.downY) > 4) this.moved = true;
        if (this.moved && !this.placement && !this.rts?.orderMode) this.updateSelectBox(e.offsetX, e.offsetY);
      }
      if (!this.dragging) this.rts?.hoverAt(e.offsetX, e.offsetY);
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.distance = clamp(this.distance * (1 + Math.sign(e.deltaY) * 0.1), 500, 40000);
      },
      { passive: false },
    );
  }
}

function syncCanvasSize(canvas: HTMLCanvasElement): void {
  canvas.width = Math.floor(canvas.clientWidth * devicePixelRatio) || 1280;
  canvas.height = Math.floor(canvas.clientHeight * devicePixelRatio) || 720;
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
function zQuat(out: Float32Array, angle: number): void {
  const half = angle / 2;
  out[0] = 0;
  out[1] = 0;
  out[2] = Math.sin(half);
  out[3] = Math.cos(half);
}
