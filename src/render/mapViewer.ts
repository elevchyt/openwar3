import War3MapViewer from "mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/viewer";
import ModelViewer from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import type { DataSource } from "../vfs/types";
import w3iParser from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i";
import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import { MpqDataSource } from "../vfs/mpq";
import { parseW3E } from "../world/terrain";
import { parseDoo } from "../world/doodads";
import { PathingGrid, parseWpm } from "../sim/pathing";
import { stampFootprints, stampFootprint, decodePathTex, type Footprint } from "../sim/destructibles";
import unitsdoo from "mdx-m3-viewer/dist/cjs/parsers/w3x/unitsdoo";
import { makeHeightSampler } from "../game/heightmap";
import { RtsController, type RtsHost } from "../game/rts";
import { loadUnitRegistry, type UnitRegistry, type UnitDef } from "../data/units";
import { STARTING_UNITS, resolveRace } from "../data/races";
import type { MeleeConfig } from "../ui/lobby";

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
type Solver = (src: unknown) => unknown;
interface Camera {
  perspective(fov: number, aspect: number, near: number, far: number): void;
  moveToAndFace(from: Float32Array, to: Float32Array, up: Float32Array): void;
}
interface Scene {
  camera: Camera;
  viewport: Float32Array;
}
interface W3xMap {
  worldScene: Scene;
  centerOffset: Float32Array;
  mapSize: Int32Array;
  update(): void;
  units: unknown[];
  unitsReady: boolean;
}
interface W3xViewer {
  loadedBaseFiles: boolean;
  map: W3xMap | null;
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
    const solver: Solver = (src) => {
      if (typeof src !== "string") return src; // in-memory loads pass through
      const path = src.replace(/\//g, "\\");
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
    const w3e = archive.rawBytes("war3map.w3e");
    const wpm = archive.rawBytes("war3map.wpm");
    if (w3e && wpm) {
      const terrain = parseW3E(w3e);
      const grid = new PathingGrid(parseWpm(wpm), terrain.centerOffset);
      this.grid = grid;
      this.stampMapPathing(grid, archive);
      const host: RtsHost = {
        canvas: this.canvas,
        camera: map.worldScene.camera as unknown as RtsHost["camera"],
        viewport: () => map.worldScene.viewport,
        units: () => map.units as ReturnType<RtsHost["units"]>,
        unitsReady: () => map.unitsReady,
      };
      this.rts = new RtsController(grid, makeHeightSampler(terrain), host, this.registry);
    }
  }

  /** Stamp destructible (tree) AND building footprints onto the terrain grid so
   *  units path around them (war3map.wpm is terrain-only). */
  private stampMapPathing(grid: PathingGrid, archive: MpqDataSource): void {
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
    }

    // Pre-placed building units (gold mines, neutral buildings) from war3mapUnits.doo.
    const unitBytes = archive.rawBytes("war3mapUnits.doo");
    if (unitBytes) {
      const units = new unitsdoo.File();
      try {
        units.load(unitBytes, buildVersion);
      } catch {
        return;
      }
      const buildings = units.units
        .filter((u) => this.registry.get(u.id)?.isBuilding)
        .map((u) => ({ id: u.id, x: u.location[0], y: u.location[1] }));
      stampFootprints(grid, buildings, (id) => this.registry.get(id)?.pathTex || undefined, readBytes);
    }
  }

  private slkText(path: string): string {
    const bytes = this.vfs.rawBytes(path);
    return bytes ? new TextDecoder("windows-1252").decode(bytes) : "";
  }

  /** Spawn each player's starting units at their start location (plan Phase 5.5). */
  async startMelee(config: MeleeConfig): Promise<void> {
    if (!this.rts || !this.viewer.map) return;
    for (const slot of config.slots) {
      const roster = STARTING_UNITS[resolveRace(slot.race)];
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
          await this.spawnUnit(def, x, y, slot.id);
        }
      }
    }
  }

  private async spawnUnit(def: UnitDef, x: number, y: number, color: number): Promise<void> {
    const map = this.viewer.map;
    if (!map || !this.rts) return;
    const model = await this.viewer.load(def.model, this.solver);
    if (!model) return;
    const instance = model.addInstance();
    instance.setScene(map.worldScene);
    instance.setTeamColor(color);
    this.rts.addUnit(instance, def, x, y, (3 * Math.PI) / 2); // face south (WC3 default)

    // Buildings block pathing: stamp their footprint so units route around them.
    if (def.isBuilding && def.pathTex && this.grid) {
      const fp = this.footprintFor(def.pathTex);
      if (fp) stampFootprint(this.grid, fp, x, y);
    }
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
      this.rts?.tick(dt / 1000); // sim runs in seconds; advance + sync before render
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
  }

  /** Release the viewer's blob URLs (call when discarding the scene). */
  dispose(): void {
    this.stop();
    this.rts?.dispose();
    this.rts = null;
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
  }

  private updateCamera(): void {
    const scene = this.viewer.map?.worldScene;
    if (!scene) return;

    // Pan the ground target with WASD, relative to view yaw.
    const speed = this.distance * 0.9 * (1 / 60);
    const fwd: [number, number] = [Math.cos(this.yaw), Math.sin(this.yaw)];
    const right: [number, number] = [fwd[1], -fwd[0]];
    if (this.keys.has("w") || this.keys.has("arrowup")) this.pan(fwd, speed);
    if (this.keys.has("s") || this.keys.has("arrowdown")) this.pan(fwd, -speed);
    if (this.keys.has("d") || this.keys.has("arrowright")) this.pan(right, speed);
    if (this.keys.has("a") || this.keys.has("arrowleft")) this.pan(right, -speed);

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
        if (!this.moved) this.rts?.selectAt(e.offsetX, e.offsetY);
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
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
