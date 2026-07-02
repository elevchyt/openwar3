import { SimWorld } from "../sim/world";
import type { PathingGrid } from "../sim/pathing";
import type { HeightSampler } from "./heightmap";
import type { UnitRegistry, UnitDef } from "../data/units";

// Ties the headless SimWorld to the rendered map (plan §5 vertical slice):
// seeds movable units from the loaded map, syncs sim state → model instances
// each frame, and handles click-to-select / right-click-to-move picking.
// Keeps the sim authoritative; the instances just display it.

// Minimal shapes for the mdx-m3-viewer bits we drive.
interface Instance {
  localLocation: Float32Array;
  localRotation: Float32Array;
  setLocation(v: ArrayLike<number>): unknown;
  setRotation(q: ArrayLike<number>): unknown;
  setSequence(i: number): unknown;
  setSequenceLoopMode(m: number): unknown;
  model: { sequences: Array<{ name: string }> };
}
interface MapUnit {
  instance: Instance;
  row?: { string(k: string): string | undefined; number(k: string): number };
  state: number; // WidgetState: IDLE=0, WALK=1
}
interface Camera {
  worldToScreen(out: Float32Array, v: Float32Array, viewport: Float32Array): Float32Array;
  screenToWorldRay(out: Float32Array, v: Float32Array, viewport: Float32Array): Float32Array;
}
export interface RtsHost {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  viewport(): Float32Array;
  units(): MapUnit[];
  unitsReady(): boolean;
}

interface Entry {
  simId: number;
  unit: MapUnit;
  walk: number;
  stand: number;
  moveHeight: number;
}

const WALK = 1, IDLE = 0;

export class RtsController {
  private sim: SimWorld;
  private entries: Entry[] = [];
  private byId = new Map<number, Entry>();
  private selected: number | null = null;
  private seeded = false;
  private nextId = 1;
  private marker: HTMLDivElement;
  // scratch buffers to avoid per-frame allocation
  private loc = new Float32Array(3);
  private quat = new Float32Array(4);
  private world = new Float32Array(3);
  private screen = new Float32Array(2);
  private ray = new Float32Array(6);

  constructor(
    grid: PathingGrid,
    private heightAt: HeightSampler,
    private host: RtsHost,
    private registry: UnitRegistry,
  ) {
    this.sim = new SimWorld(grid);
    this.marker = document.createElement("div");
    this.marker.className = "unit-select";
    this.marker.hidden = true;
    document.body.appendChild(this.marker);
  }

  dispose(): void {
    this.marker.remove();
  }

  /** Hide the selection ring (e.g. when the map view is not active). */
  pause(): void {
    this.marker.hidden = true;
  }

  /** Seed movable units from the map once its units have loaded. */
  private trySeed(): void {
    if (this.seeded || !this.host.unitsReady()) return;
    for (const unit of this.host.units()) {
      const movetp = unit.row?.string("movetp");
      if (!movetp || movetp === "_" || movetp === "none") continue; // buildings/immovable
      const seqs = unit.instance.model.sequences;
      const walk = seqs.findIndex((s) => /walk/i.test(s.name));
      if (walk < 0) continue; // no walk animation → treat as static
      const stand = seqs.findIndex((s) => /^stand/i.test(s.name));
      const loc = unit.instance.localLocation;
      const def = this.registry.get(unit.row?.string("unitid") ?? "");
      const simId = this.nextId++;
      this.sim.add({
        id: simId,
        x: loc[0],
        y: loc[1],
        facing: quatToZ(unit.instance.localRotation),
        speed: def?.speed || 270, // real movement speed from UnitBalance.slk
        turnRate: def?.turnRate ?? 0.5,
        radius: def?.collision || 16,
      });
      const entry: Entry = { simId, unit, walk, stand: stand < 0 ? walk : stand, moveHeight: def?.moveHeight ?? 0 };
      this.entries.push(entry);
      this.byId.set(simId, entry);
    }
    this.seeded = true;
  }

  /** Add a freshly-spawned unit (instance already attached to the scene) — used
   *  by melee init to place each race's starting units. Returns the sim id. */
  addUnit(instance: Instance, def: UnitDef, x: number, y: number, facing: number): number {
    const seqs = instance.model.sequences;
    const walk = seqs.findIndex((s) => /walk/i.test(s.name));
    const stand = seqs.findIndex((s) => /^stand/i.test(s.name));
    const simId = this.nextId++;
    this.sim.add({
      id: simId,
      x,
      y,
      facing,
      speed: def.speed,
      turnRate: def.turnRate,
      radius: def.collision || 16,
    });
    const entry: Entry = {
      simId,
      unit: { instance, state: IDLE },
      walk: walk < 0 ? 0 : walk,
      stand: stand < 0 ? (walk < 0 ? 0 : walk) : stand,
      moveHeight: def.moveHeight,
    };
    this.entries.push(entry);
    this.byId.set(simId, entry);
    if (seqs.length) {
      instance.setSequence(entry.stand);
      instance.setSequenceLoopMode(2);
    }
    return simId;
  }

  tick(dt: number): void {
    this.trySeed();
    this.sim.tick(dt);
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId)!;
      this.loc[0] = u.x;
      this.loc[1] = u.y;
      this.loc[2] = this.heightAt(u.x, u.y) + e.moveHeight; // fly height for air units
      e.unit.instance.setLocation(this.loc);
      setZQuat(this.quat, u.facing);
      e.unit.instance.setRotation(this.quat);
      if (u.moving && e.unit.state !== WALK) {
        e.unit.state = WALK; // prevents mdx-m3-viewer's auto-stand override
        e.unit.instance.setSequence(e.walk);
        e.unit.instance.setSequenceLoopMode(2);
      } else if (!u.moving && e.unit.state !== IDLE) {
        e.unit.state = IDLE;
        e.unit.instance.setSequence(e.stand);
        e.unit.instance.setSequenceLoopMode(2);
      }
    }
    this.updateMarker();
  }

  /** Left-click: select the nearest movable unit within a pixel radius. */
  selectAt(cssX: number, cssY: number): void {
    const [gx, gy] = this.toGl(cssX, cssY);
    const viewport = this.host.viewport();
    let best: number | null = null;
    let bestDist = 42 * this.dpr(); // pick radius in backing px
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId)!;
      this.world[0] = u.x;
      this.world[1] = u.y;
      this.world[2] = this.heightAt(u.x, u.y) + 60; // aim near the unit's body
      this.host.camera.worldToScreen(this.screen, this.world, viewport);
      const d = Math.hypot(this.screen[0] - gx, this.screen[1] - gy);
      if (d < bestDist) {
        bestDist = d;
        best = e.simId;
      }
    }
    this.selected = best;
    this.updateMarker();
  }

  /** Right-click: order the selected unit to the ground point under the cursor. */
  moveAt(cssX: number, cssY: number): void {
    if (this.selected === null) return;
    // screenToWorldRay/unproject expects window coords with a TOP-LEFT origin
    // (Y-down) — the opposite of worldToScreen (Y-up) used by selection.
    const dpr = this.dpr();
    this.screen[0] = cssX * dpr;
    this.screen[1] = cssY * dpr;
    this.host.camera.screenToWorldRay(this.ray, this.screen, this.host.viewport());
    const hit = this.groundHit();
    if (hit) this.sim.issueMove(this.selected, hit[0], hit[1]);
  }

  private groundHit(): [number, number] | null {
    const r = this.ray;
    const nx = r[0], ny = r[1], nz = r[2];
    const dx = r[3] - nx, dy = r[4] - ny, dz = r[5] - nz;
    const at = (t: number): number =>
      nz + dz * t - this.heightAt(nx + dx * t, ny + dy * t);
    const steps = 256;
    let prev = at(0);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const cur = at(t);
      if (prev > 0 && cur <= 0) {
        let lo = (i - 1) / steps;
        let hi = t;
        for (let k = 0; k < 16; k++) {
          const mid = (lo + hi) / 2;
          if (at(mid) > 0) lo = mid;
          else hi = mid;
        }
        const t2 = (lo + hi) / 2;
        return [nx + dx * t2, ny + dy * t2];
      }
      prev = cur;
    }
    return null;
  }

  private updateMarker(): void {
    if (this.selected === null) {
      this.marker.hidden = true;
      return;
    }
    const u = this.sim.units.get(this.selected)!;
    this.world[0] = u.x;
    this.world[1] = u.y;
    this.world[2] = this.heightAt(u.x, u.y);
    this.host.camera.worldToScreen(this.screen, this.world, this.host.viewport());
    const [w, h] = [this.host.canvas.width, this.host.canvas.height];
    if (this.screen[0] < 0 || this.screen[0] > w || this.screen[1] < 0 || this.screen[1] > h) {
      this.marker.hidden = true;
      return;
    }
    const dpr = this.dpr();
    this.marker.hidden = false;
    this.marker.style.left = `${this.screen[0] / dpr}px`;
    this.marker.style.top = `${(h - this.screen[1]) / dpr}px`; // gl y-up → css y-down
  }

  private toGl(cssX: number, cssY: number): [number, number] {
    const dpr = this.dpr();
    return [cssX * dpr, this.host.canvas.height - cssY * dpr];
  }

  private dpr(): number {
    return this.host.canvas.width / this.host.canvas.clientWidth || 1;
  }
}

// Quaternion for a rotation `angle` about +Z, written into `out`.
function setZQuat(out: Float32Array, angle: number): void {
  const half = angle / 2;
  out[0] = 0;
  out[1] = 0;
  out[2] = Math.sin(half);
  out[3] = Math.cos(half);
}

// Extract the Z-rotation angle from a (near-Z) quaternion.
function quatToZ(q: Float32Array): number {
  return 2 * Math.atan2(q[2], q[3]);
}
