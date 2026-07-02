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
import { GameHud, type HudDriver } from "../ui/hud";
import { blpToCanvas, blpToDataUrl } from "./blputil";

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
  hide(): void;
  show(): void;
  setSequence(i: number): void;
  setSequenceLoopMode(m: number): void;
  setLocation(v: ArrayLike<number>): unknown;
  setRotation(q: ArrayLike<number>): unknown;
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
  private consoleSkinCache: { url: string; aspect: number } | null | undefined;

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
    this.distance = Math.max(cols, rows) * 128 * 0.9;

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
    // Resolve "random" once per slot: roster and console skin must agree.
    const races = new Map(config.slots.map((s) => [s.id, resolveRace(s.race)]));
    this.localRace = races.get(this.localPlayer) ?? "human";
    for (const slot of config.slots) this.rts.simWorld.initStash(slot.id, 500, 150); // WC3 melee start
    this.mountHud();
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

  private async spawnUnit(def: UnitDef, x: number, y: number, owner: number, team: number): Promise<void> {
    const map = this.viewer.map;
    if (!map || !this.rts) return;
    // Buildings snap to the pathing grid so their stamped footprint lands on
    // whole cells (WC3 building placement is grid-aligned).
    const fp = def.isBuilding && def.pathTex && this.grid ? this.footprintFor(def.pathTex) : null;
    if (fp && this.grid) [x, y] = this.grid.snapForFootprintRect(x, y, fp.w, fp.h);

    const model = await this.viewer.load(def.model, this.solver);
    if (!model) return;
    const instance = model.addInstance();
    instance.setScene(map.worldScene);
    instance.setTeamColor(owner); // player slot doubles as team color for now
    this.rts.addUnit(instance, def, x, y, (3 * Math.PI) / 2, owner, team); // face south (WC3 default)

    // Buildings block pathing: stamp their footprint so units route around them.
    if (fp && this.grid) stampFootprint(this.grid, fp, x, y);
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
      setOrderMode: (mode) => {
        if (this.rts) this.rts.orderMode = mode;
      },
      stopSelected: () => this.rts?.stopSelected(),
      icon: (kind) => this.resourceIcon(kind),
      minimapImage: () => this.minimap,
      consoleSkin: () => this.consoleSkin(),
    };
    this.hud = new GameHud(ui, driver);
  }

  /** Stitch the race's console tiles into one background texture. */
  private consoleSkin(): { url: string; aspect: number } | null {
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
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    let x = 0;
    for (const tile of tiles) {
      ctx.drawImage(tile, x, 0);
      x += tile.width;
    }
    // The 512-tall tiles are mostly transparent sky above the stone chrome —
    // crop to the opaque part so the console doesn't cover half the screen.
    const data = ctx.getImageData(0, 0, width, height).data;
    let top = 0;
    scan: for (; top < height; top++) {
      for (let px = 3; px < width * 4; px += 64 * 4) {
        if (data[top * width * 4 + px] > 16) break scan;
      }
    }
    const cropped = document.createElement("canvas");
    cropped.width = width;
    cropped.height = height - top;
    cropped.getContext("2d")!.drawImage(canvas, 0, -top);
    this.consoleSkinCache = { url: cropped.toDataURL(), aspect: cropped.width / cropped.height };
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
    this.portraitViewer
      .load(path)
      .then(() => {
        this.portraitFor = id;
        this.portraitViewer!.start();
      })
      .catch(() => {})
      .finally(() => {
        this.portraitLoading = false;
      });
  }

  private resourceIcon(kind: "gold" | "lumber" | "supply"): string | null {
    const paths = {
      gold: "UI\\Widgets\\ToolTips\\Human\\ToolTipGoldIcon.blp",
      lumber: "UI\\Widgets\\ToolTips\\Human\\ToolTipLumberIcon.blp",
      supply: "UI\\Widgets\\ToolTips\\Human\\ToolTipSupplyIcon.blp",
    };
    const path = paths[kind];
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
      this.rts?.tick(dt / 1000); // sim runs in seconds; advance + sync before render
      const world = this.rts?.simWorld;
      const map = this.viewer.map;
      if (world && map) {
        for (const tree of world.drainFelledTrees()) this.removeNodeVisual(tree.id, tree.x, tree.y, map.doodads);
        for (const mine of world.drainDepletedMines()) {
          this.removeNodeVisual(mine.id, mine.x, mine.y, map.units as unknown as HideableWidget[]);
        }
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
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
  }

  private updateCamera(): void {
    const scene = this.viewer.map?.worldScene;
    if (!scene) return;

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
        this.rts?.moveAt(e.offsetX, e.offsetY);
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
        if (!this.moved && this.rts) {
          // An armed command-card order (Move/Attack) consumes the click.
          if (this.rts.orderMode) {
            if (this.rts.orderClickAt(e.offsetX, e.offsetY)) this.hud?.clearOrderMode();
          } else {
            this.rts.selectAt(e.offsetX, e.offsetY);
          }
        }
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.dragging) {
        this.rts?.hoverAt(e.offsetX, e.offsetY);
        return;
      }
      if (Math.hypot(e.offsetX - this.downX, e.offsetY - this.downY) > 4) this.moved = true;
      this.yaw += e.movementX * 0.005;
      this.pitch = clamp(this.pitch - e.movementY * 0.005, 0.2, 1.5);
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
