import { SimWorld, type SimWeapon } from "../sim/world";
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
  hide(): void;
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

type Anim = "stand" | "walk" | "attack";

interface Entry {
  simId: number;
  unit: MapUnit;
  walk: number;
  stand: number;
  attack: number; // -1 = no attack animation
  death: number; // -1 = no death animation
  moveHeight: number;
  anim: Anim;
}

const WALK = 1, IDLE = 0;
const CORPSE_TIME = 3; // seconds a corpse stays before being hidden
const LOOP_NEVER = 0, LOOP_ALWAYS = 2; // mdx-m3-viewer sequence loop modes
const AIR_EXTRA = 60; // extra world units of altitude on top of UnitData moveheight
const PICK_Z = 60; // aim picking/markers near the unit's body, not its feet

interface Marker {
  root: HTMLDivElement;
  fill: HTMLDivElement;
}

function makeMarker(extraClass: string): Marker {
  const root = document.createElement("div");
  root.className = `unit-select ${extraClass}`;
  root.hidden = true;
  const track = document.createElement("div");
  track.className = "unit-hp";
  const fill = document.createElement("div");
  fill.className = "unit-hp-fill";
  track.appendChild(fill);
  root.appendChild(track);
  document.body.appendChild(root);
  return { root, fill };
}

export class RtsController {
  private sim: SimWorld;
  private entries: Entry[] = [];
  private byId = new Map<number, Entry>();
  private selected: number | null = null;
  private hovered: number | null = null;
  private seeded = false;
  private nextId = 1;
  private selectMarker: Marker;
  private hoverMarker: Marker;
  private corpses: Array<{ instance: Instance; t: number }> = [];
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
    this.selectMarker = makeMarker("unit-selected");
    this.hoverMarker = makeMarker("unit-hovered");
  }

  dispose(): void {
    this.selectMarker.root.remove();
    this.hoverMarker.root.remove();
  }

  /** Hide the selection/hover rings (e.g. when the map view is not active). */
  pause(): void {
    this.selectMarker.root.hidden = true;
    this.hoverMarker.root.hidden = true;
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
        owner: -1, // map-placed units are neutral (creeps)
        team: -1,
        x: loc[0],
        y: loc[1],
        facing: quatToZ(unit.instance.localRotation),
        speed: def?.speed || 270, // real movement speed from UnitBalance.slk
        turnRate: def?.turnRate ?? 0.5,
        radius: def?.collision || 16,
        flying: def?.moveType === "fly",
        hp: def?.hitPoints || 100,
        maxHp: def?.hitPoints || 100,
        armor: def?.armor ?? 0,
        weapon: def ? weaponFor(def) : null,
      });
      const entry: Entry = {
        simId,
        unit,
        walk,
        stand: stand < 0 ? walk : stand,
        attack: seqs.findIndex((s) => /attack/i.test(s.name)),
        death: seqs.findIndex((s) => /^death/i.test(s.name)),
        moveHeight: lift(def?.moveHeight ?? 0),
        anim: "stand",
      };
      this.entries.push(entry);
      this.byId.set(simId, entry);
    }
    this.seeded = true;
  }

  /** Add a freshly-spawned unit (instance already attached to the scene) — used
   *  by melee init to place each race's starting units. Returns the sim id. */
  addUnit(instance: Instance, def: UnitDef, x: number, y: number, facing: number, owner = 0, team = 0): number {
    const seqs = instance.model.sequences;
    const walk = seqs.findIndex((s) => /walk/i.test(s.name));
    const stand = seqs.findIndex((s) => /^stand/i.test(s.name));
    const simId = this.nextId++;
    this.sim.add({
      id: simId,
      owner,
      team,
      x,
      y,
      facing,
      speed: def.speed,
      turnRate: def.turnRate,
      radius: def.collision || 16,
      flying: def.moveType === "fly",
      hp: def.hitPoints || 100,
      maxHp: def.hitPoints || 100,
      armor: def.armor,
      weapon: weaponFor(def),
    });
    const entry: Entry = {
      simId,
      unit: { instance, state: IDLE },
      walk: walk < 0 ? 0 : walk,
      stand: stand < 0 ? (walk < 0 ? 0 : walk) : stand,
      attack: seqs.findIndex((s) => /attack/i.test(s.name)),
      death: seqs.findIndex((s) => /^death/i.test(s.name)),
      moveHeight: lift(def.moveHeight),
      anim: "stand",
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
    for (const id of this.sim.drainDeaths()) this.onDeath(id);
    this.tickCorpses(dt);
    if (this.hovered !== null && !this.byId.has(this.hovered)) this.hovered = null;
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId)!;
      this.loc[0] = u.x;
      this.loc[1] = u.y;
      this.loc[2] = this.heightAt(u.x, u.y) + e.moveHeight; // fly height for air units
      e.unit.instance.setLocation(this.loc);
      setZQuat(this.quat, u.facing);
      e.unit.instance.setRotation(this.quat);
      const anim: Anim = u.moving ? "walk" : u.inCombat && e.attack >= 0 ? "attack" : "stand";
      if (anim !== e.anim) {
        e.anim = anim;
        // Non-IDLE state prevents mdx-m3-viewer's auto-stand override.
        e.unit.state = anim === "stand" ? IDLE : WALK;
        e.unit.instance.setSequence(anim === "walk" ? e.walk : anim === "attack" ? e.attack : e.stand);
        e.unit.instance.setSequenceLoopMode(LOOP_ALWAYS);
      }
    }
    this.updateMarkers();
  }

  /** The sim removed this unit: play its death animation, then keep the corpse
   *  briefly before hiding the instance. */
  private onDeath(simId: number): void {
    const e = this.byId.get(simId);
    if (!e) return;
    this.byId.delete(simId);
    this.entries.splice(this.entries.indexOf(e), 1);
    if (this.selected === simId) this.selected = null;
    e.unit.state = WALK; // keep mdx-m3-viewer from overriding the death sequence
    if (e.death >= 0) {
      e.unit.instance.setSequence(e.death);
      e.unit.instance.setSequenceLoopMode(LOOP_NEVER);
      this.corpses.push({ instance: e.unit.instance, t: CORPSE_TIME });
    } else {
      e.unit.instance.hide();
    }
  }

  private tickCorpses(dt: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t -= dt;
      if (c.t <= 0) {
        c.instance.hide();
        this.corpses.splice(i, 1);
      }
    }
  }

  /** Left-click: select the nearest movable unit within a pixel radius. */
  selectAt(cssX: number, cssY: number): void {
    this.selected = this.pickAt(cssX, cssY);
    this.updateMarkers();
  }

  /** Pointer move: show the ring + HP bar under the unit being hovered. */
  hoverAt(cssX: number, cssY: number): void {
    this.hovered = this.pickAt(cssX, cssY);
  }

  /** Live units, for the metrics overlay. */
  unitCount(): number {
    return this.entries.length;
  }

  /** Right-click: attack a hostile unit under the cursor, else move to ground. */
  moveAt(cssX: number, cssY: number): void {
    if (this.selected === null) return;
    const sel = this.sim.units.get(this.selected);
    if (!sel) return;
    const picked = this.pickAt(cssX, cssY);
    if (picked !== null && picked !== this.selected) {
      const target = this.sim.units.get(picked);
      if (target && this.sim.hostile(sel, target) && this.sim.issueAttack(this.selected, picked)) return;
    }
    // screenToWorldRay/unproject expects window coords with a TOP-LEFT origin
    // (Y-down) — the opposite of worldToScreen (Y-up) used by selection.
    const dpr = this.dpr();
    this.screen[0] = cssX * dpr;
    this.screen[1] = cssY * dpr;
    this.host.camera.screenToWorldRay(this.ray, this.screen, this.host.viewport());
    const hit = this.groundHit();
    if (hit) this.sim.issueMove(this.selected, hit[0], hit[1]);
  }

  /** Sim id of the unit nearest the cursor within the pick radius, if any. */
  private pickAt(cssX: number, cssY: number): number | null {
    const [gx, gy] = this.toGl(cssX, cssY);
    const viewport = this.host.viewport();
    let best: number | null = null;
    let bestDist = 42 * this.dpr(); // pick radius in backing px
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId)!;
      this.world[0] = u.x;
      this.world[1] = u.y;
      // Aim near the unit's body — including fly height, so air units are
      // picked where they are drawn, not at their ground shadow.
      this.world[2] = this.heightAt(u.x, u.y) + e.moveHeight + PICK_Z;
      this.host.camera.worldToScreen(this.screen, this.world, viewport);
      const d = Math.hypot(this.screen[0] - gx, this.screen[1] - gy);
      if (d < bestDist) {
        bestDist = d;
        best = e.simId;
      }
    }
    return best;
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

  private updateMarkers(): void {
    if (this.selected !== null && !this.sim.units.has(this.selected)) this.selected = null;
    this.placeMarker(this.selectMarker, this.selected);
    // Don't double up both rings on the same unit.
    this.placeMarker(this.hoverMarker, this.hovered === this.selected ? null : this.hovered);
  }

  private placeMarker(marker: Marker, simId: number | null): void {
    const u = simId !== null ? this.sim.units.get(simId) : undefined;
    const e = simId !== null ? this.byId.get(simId) : undefined;
    if (!u || !e) {
      marker.root.hidden = true;
      return;
    }
    const frac = Math.max(0, Math.min(1, u.hp / u.maxHp));
    marker.fill.style.width = `${frac * 100}%`;
    marker.fill.style.background = frac > 0.6 ? "#46e05a" : frac > 0.3 ? "#e0c146" : "#e05046";
    this.world[0] = u.x;
    this.world[1] = u.y;
    // Ring sits at the unit's drawn base — for air units that's their altitude.
    this.world[2] = this.heightAt(u.x, u.y) + e.moveHeight;
    this.host.camera.worldToScreen(this.screen, this.world, this.host.viewport());
    const [w, h] = [this.host.canvas.width, this.host.canvas.height];
    if (this.screen[0] < 0 || this.screen[0] > w || this.screen[1] < 0 || this.screen[1] > h) {
      marker.root.hidden = true;
      return;
    }
    const dpr = this.dpr();
    marker.root.hidden = false;
    marker.root.style.left = `${this.screen[0] / dpr}px`;
    marker.root.style.top = `${(h - this.screen[1]) / dpr}px`; // gl y-up → css y-down
  }

  private toGl(cssX: number, cssY: number): [number, number] {
    const dpr = this.dpr();
    return [cssX * dpr, this.host.canvas.height - cssY * dpr];
  }

  private dpr(): number {
    return this.host.canvas.width / this.host.canvas.clientWidth || 1;
  }
}

// Air units ride a bit above their UnitData moveheight for a clearer silhouette.
function lift(moveHeight: number): number {
  return moveHeight > 0 ? moveHeight + AIR_EXTRA : 0;
}

// A unit's weapon from its registry stats; null when it can't attack.
function weaponFor(def: UnitDef): SimWeapon | null {
  if (def.attackCooldown <= 0 || def.attackDamage + def.attackDice * def.attackSides <= 0) return null;
  return {
    damage: def.attackDamage,
    dice: def.attackDice,
    sides: def.attackSides,
    cooldown: def.attackCooldown,
    range: def.attackRange,
    acquire: def.acquireRange,
  };
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
