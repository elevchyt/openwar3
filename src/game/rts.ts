import { SimWorld, type SimWeapon, type WorkerState, type SimUnit, type BuildingState } from "../sim/world";
import type { PathingGrid } from "../sim/pathing";
import type { HeightSampler } from "./heightmap";
import type { UnitRegistry, UnitDef } from "../data/units";
import { WORKERS, DEPOT_IDS } from "../data/races";
import { trainsFor } from "../data/techtree";

// Ties the headless SimWorld to the rendered map (plan §5 vertical slice):
// seeds movable units from the loaded map, syncs sim state → model instances
// each frame, and handles click-to-select / right-click-to-move picking.
// Keeps the sim authoritative; the instances just display it.

// Minimal shapes for the mdx-m3-viewer bits we drive.
interface Instance {
  localLocation: Float32Array;
  localRotation: Float32Array;
  frame: number;
  setLocation(v: ArrayLike<number>): unknown;
  setRotation(q: ArrayLike<number>): unknown;
  setSequence(i: number): unknown;
  setSequenceLoopMode(m: number): unknown;
  setUniformScale(s: number): unknown;
  hide(): void;
  show(): void;
  model: { sequences: Array<{ name: string; interval?: ArrayLike<number> }> };
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

export interface SelectionInfo {
  id: number;
  typeId: string;
  race: string;
  name: string;
  owner: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  armor: number;
  damageMin: number;
  damageMax: number;
  attackType: string; // normal/pierce/siege/magic/chaos/hero
  armorType: string; // small/medium/large/fort/hero/divine/none
  isHero: boolean;
  level: number;
  strength: number;
  agility: number;
  intelligence: number;
  primaryAttr: string; // "STR"/"AGI"/"INT" or ""
  model: string;
  isWorker: boolean;
  isBuilding: boolean;
  underConstruction: boolean;
  buildProgress: number; // 0..1 construction completion
  trainProgress: number; // 0..1 of the unit currently training (queue[0])
  queueLength: number;
  queue: Array<{ icon: string }>; // icons of the units queued for training
  icon: string; // the selected thing's own command-card icon (BLP path)
  carryGold: number;
  carryLumber: number;
  isMine: boolean; // a selected gold mine (resource, not a unit)
  goldRemaining: number; // gold left in the selected mine
}

// A ground selection/hover ring the renderer draws as a flat model.
export interface RingInfo {
  x: number;
  y: number;
  z: number;
  radius: number;
  owner: number;
  team: number;
  sizeToRadius?: boolean; // scale the ring to `radius` (buildings/mines) vs constant
  neutral?: boolean; // neutral-passive (yellow) ring, e.g. a gold mine
}

// Resolved animation-sequence indices for a unit. Worker carry/chop variants
// fall back to the base clip when a model lacks them.
interface AnimSet {
  stand: number;
  walk: number;
  attack: number;
  death: number;
  standGold: number;
  walkGold: number;
  standLumber: number;
  walkLumber: number;
  chopLumber: number; // "Attack Lumber" — the chopping swing
  build: number; // "Stand Work" — the hammering pose while constructing
}

function buildAnimSet(seqs: Array<{ name: string }>): AnimSet {
  const find = (re: RegExp): number => seqs.findIndex((s) => re.test(s.name));
  const stand = find(/^stand(\s|$|-)/i) >= 0 ? find(/^stand(\s|$|-)/i) : find(/^stand/i);
  const walk = find(/^walk\s*$/i) >= 0 ? find(/^walk\s*$/i) : find(/walk/i);
  const attack = find(/^attack\s*$/i) >= 0 ? find(/^attack\s*$/i) : find(/attack/i);
  const or = (a: number, b: number) => (a >= 0 ? a : b);
  return {
    stand,
    walk,
    attack,
    death: find(/^death/i),
    standGold: or(find(/stand gold/i), stand),
    walkGold: or(find(/walk gold/i), walk),
    standLumber: or(find(/stand lumber/i), stand),
    walkLumber: or(find(/walk lumber/i), walk),
    chopLumber: or(find(/attack lumber/i), attack),
    build: or(find(/stand work(?! gold| lumber)/i), or(find(/^stand work/i), attack)),
  };
}

interface Entry {
  simId: number;
  unit: MapUnit;
  anims: AnimSet;
  moveHeight: number;
  selRadius: number; // selection-ring radius in WORLD units (from selScale)
  typeId: string; // unit-type id (e.g. "hpea"); drives the command card
  race: string;
  name: string;
  foodUsed: number;
  foodMade: number;
  isHero: boolean;
  level: number;
  modelPath: string; // for the HUD portrait
  baseScale: number; // model scale at full size (buildings scale up while built)
  curScale: number; // last uniform scale applied (avoid redundant sets)
  birthSeq: number; // "Birth" sequence index (-1 = none → scale-up fallback)
  birthStart: number; // Birth animation frame interval, for scrubbing
  birthEnd: number;
  hidden: boolean; // instance hidden (worker inside a gold mine)
  curSeq: number; // sequence index currently playing (avoid redundant sets)
}

/** The "Birth" construction sequence + its frame interval, if the model has one. */
function findBirthFields(seqs: Array<{ name: string; interval?: ArrayLike<number> }>): {
  birthSeq: number;
  birthStart: number;
  birthEnd: number;
} {
  const birthSeq = seqs.findIndex((s) => /^birth$/i.test(s.name));
  const iv = birthSeq >= 0 ? seqs[birthSeq].interval : undefined;
  return { birthSeq, birthStart: iv ? iv[0] : 0, birthEnd: iv ? iv[1] : 0 };
}

const WALK = 1, IDLE = 0;
const CORPSE_TIME = 3; // seconds a corpse stays before being hidden
const LOOP_NEVER = 0, LOOP_ALWAYS = 2; // mdx-m3-viewer sequence loop modes
const AIR_EXTRA = 60; // extra world units of altitude on top of UnitData moveheight
// WC3's selection circle diameter ≈ 72 world units at selection scale 1.0.
const SEL_RADIUS_PER_SCALE = 36;
const MIN_RING_PX = 12; // don't let rings vanish when zoomed far out
// Order-confirmation arrow tints (Confirmation.mdx): green = move, red = a-move.
const MOVE_ARROW: [number, number, number] = [0.1, 1, 0.1];
const ATTACK_ARROW: [number, number, number] = [1, 0.15, 0.1];
// Max world distance from the click's ground point to a pickable unit. Gates out
// far/behind-camera units that screen-projection alone would wrongly match.
const PICK_WORLD_MAX = 700;
const MAX_SELECT = 24; // WC3 control-group / selection cap

/** One icon in the multi-selection grid. */
export interface SelIcon {
  simId: number;
  icon: string; // BLP command icon path
  hpFrac: number;
  focused: boolean; // part of the currently-focused sub-group
  owner: number;
}

// A floating status bar drawn above a unit: a hero level badge (left), an HP bar,
// and a mana bar below it (for units with mana). Pooled, one per visible unit, so
// bars are always on screen (WC3's "always show health bars").
interface HpBar {
  root: HTMLDivElement;
  bars: HTMLDivElement;
  level: HTMLDivElement;
  hp: HTMLDivElement;
  manaTrack: HTMLDivElement;
  mana: HTMLDivElement;
}

function makeHpBar(): HpBar {
  const root = document.createElement("div");
  root.className = "unit-hpbar";
  root.hidden = true;
  const level = document.createElement("div");
  level.className = "unit-hpbar-level";
  const bars = document.createElement("div");
  bars.className = "unit-hpbar-bars";
  const hpTrack = document.createElement("div");
  hpTrack.className = "unit-hpbar-track";
  const hp = document.createElement("div");
  hp.className = "unit-hpbar-fill";
  hpTrack.appendChild(hp);
  const manaTrack = document.createElement("div");
  manaTrack.className = "unit-hpbar-track unit-hpbar-manatrack";
  const mana = document.createElement("div");
  mana.className = "unit-hpbar-mana";
  manaTrack.appendChild(mana);
  bars.append(hpTrack, manaTrack);
  root.append(level, bars);
  document.body.appendChild(root);
  return { root, bars, level, hp, manaTrack, mana };
}

export class RtsController {
  private sim: SimWorld;
  private entries: Entry[] = [];
  private byId = new Map<number, Entry>();
  // Multi-unit selection: `selected` holds the whole group, `primary` is the
  // leader that drives the HUD (portrait, info panel, command card).
  private selected = new Set<number>();
  private primary: number | null = null;
  private focusedKey = ""; // sub-group (type, or hero id) currently focused
  private selectedMine: number | null = null; // a selected gold mine (resource)
  private localPlayer = 0; // owner whose units a drag-box selects
  private hovered: number | null = null;
  private seeded = false;
  private nextId = 1;
  private hpBars: HpBar[] = []; // pool, one shown per visible unit each frame
  private corpses: Array<{ instance: Instance; t: number }> = [];
  private flashRequests: Array<{ x: number; y: number; z: number; radius: number; color: [number, number, number] }> = [];
  private treePulses: Array<{ x: number; y: number }> = []; // trees to flash yellow on harvest
  // scratch buffers to avoid per-frame allocation
  private loc = new Float32Array(3);
  private quat = new Float32Array(4);
  private world = new Float32Array(3);
  private screen = new Float32Array(2);
  private world2 = new Float32Array(3);
  private screen2 = new Float32Array(2);
  private ray = new Float32Array(6);

  constructor(
    grid: PathingGrid,
    private heightAt: HeightSampler,
    private host: RtsHost,
    private registry: UnitRegistry,
  ) {
    this.sim = new SimWorld(grid);
  }

  dispose(): void {
    for (const b of this.hpBars) b.root.remove();
    this.hpBars = [];
  }

  /** Which player's units a drag-box selects (set at melee start). */
  setLocalPlayer(id: number): void {
    this.localPlayer = id;
  }

  /** Remove a unit from the selection (keeping the primary consistent). */
  private deselect(id: number): void {
    this.selected.delete(id);
    if (this.primary === id) this.refocus(this.focusedKey);
  }

  // --- sub-group focus (multi-unit selection) -------------------------------

  /** Grouping key: units group by type; each hero is its own group. */
  private groupKeyOf(id: number): string {
    const e = this.byId.get(id);
    if (!e) return "";
    return this.registry.get(e.typeId)?.isHero ? `h${id}` : e.typeId;
  }

  /** Distinct group keys in selection order (stable). */
  private orderedGroups(): string[] {
    const keys: string[] = [];
    for (const id of this.selected) {
      const k = this.groupKeyOf(id);
      if (k && !keys.includes(k)) keys.push(k);
    }
    return keys;
  }

  private firstOfGroup(key: string): number | null {
    for (const id of this.selected) if (this.groupKeyOf(id) === key) return id;
    return null;
  }

  /** Recompute the focused group + primary from the current selection, keeping
   *  `preferKey` focused if it still exists. */
  private refocus(preferKey = ""): void {
    const groups = this.orderedGroups();
    this.focusedKey = preferKey && groups.includes(preferKey) ? preferKey : groups[0] ?? "";
    this.primary = this.firstOfGroup(this.focusedKey);
  }

  /** Icons for the multi-selection grid (empty for a single unit / mine). */
  selectionIcons(): SelIcon[] {
    if (this.selected.size <= 1) return [];
    const out: SelIcon[] = [];
    for (const key of this.orderedGroups()) {
      for (const id of this.selected) {
        if (this.groupKeyOf(id) !== key) continue;
        const u = this.sim.units.get(id);
        const e = this.byId.get(id);
        if (!u || !e) continue;
        out.push({ simId: id, icon: this.registry.get(e.typeId)?.icon ?? "", hpFrac: u.maxHp > 0 ? u.hp / u.maxHp : 1, focused: key === this.focusedKey, owner: u.owner });
      }
    }
    return out;
  }

  /** Focus the sub-group containing a unit (grid click). */
  focusUnit(simId: number): void {
    if (!this.selected.has(simId)) return;
    this.focusedKey = this.groupKeyOf(simId);
    this.primary = this.firstOfGroup(this.focusedKey);
  }

  /** Cycle focus to the next sub-group (Tab). */
  cycleFocus(): void {
    const groups = this.orderedGroups();
    if (groups.length <= 1) return;
    const i = groups.indexOf(this.focusedKey);
    this.focusedKey = groups[(i + 1) % groups.length];
    this.primary = this.firstOfGroup(this.focusedKey);
  }

  /** Drop dead units from the selection and repoint the primary if it died. */
  private pruneSelection(): void {
    let changed = false;
    for (const id of this.selected) if (!this.sim.units.has(id)) { this.selected.delete(id); changed = true; }
    if (changed || (this.primary !== null && !this.sim.units.has(this.primary))) this.refocus(this.focusedKey);
    if (this.selectedMine !== null && !this.sim.mines.has(this.selectedMine)) this.selectedMine = null;
  }

  /** Hide the floating health bars (e.g. when the map view is not active). */
  pause(): void {
    for (const b of this.hpBars) b.root.hidden = true;
  }

  /** Seed movable units from the map once its units have loaded. */
  private trySeed(): void {
    if (this.seeded || !this.host.unitsReady()) return;
    for (const unit of this.host.units()) {
      const movetp = unit.row?.string("movetp");
      if (!movetp || movetp === "_" || movetp === "none") continue; // buildings/immovable
      const seqs = unit.instance.model.sequences;
      if (!seqs.some((s) => /walk/i.test(s.name))) continue; // no walk → treat as static
      const anims = buildAnimSet(seqs);
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
        mana: def?.mana ?? 0,
        maxMana: def?.mana ?? 0,
        armor: def?.armor ?? 0,
        weapon: def ? weaponFor(def) : null,
        worker: null,
        depotGold: false,
        depotLumber: false,
      });
      const entry: Entry = {
        simId,
        unit,
        anims,
        moveHeight: lift(def?.moveHeight ?? 0),
        selRadius: (def?.selScale || 1) * SEL_RADIUS_PER_SCALE,
        typeId: def?.id ?? unit.row?.string("unitid") ?? "",
        race: def?.race ?? "",
        name: def?.name ?? unit.row?.string("unitid") ?? "Unit",
        foodUsed: def?.foodUsed ?? 0,
        foodMade: def?.foodMade ?? 0,
        isHero: def?.isHero ?? false,
        level: def?.level ?? 0,
        modelPath: def?.model ?? "",
        baseScale: def?.modelScale || 1,
        curScale: def?.modelScale || 1,
        ...findBirthFields(unit.instance.model.sequences),
        hidden: false,
        curSeq: -1,
      };
      this.entries.push(entry);
      this.byId.set(simId, entry);
    }
    this.seeded = true;
  }

  /** Add a freshly-spawned unit (instance already attached to the scene) — used
   *  by melee init to place each race's starting units. Returns the sim id. */
  addUnit(instance: Instance, def: UnitDef, x: number, y: number, facing: number, owner = 0, team = 0, constructionTime = 0): number {
    const seqs = instance.model.sequences;
    const anims = buildAnimSet(seqs);
    const simId = this.nextId++;
    const profile = WORKERS[def.id];
    const worker: WorkerState | null = profile ? { ...profile, carryGold: 0, carryLumber: 0 } : null;
    // Structures get building state (construction + a training queue); rally
    // point defaults to just south of the building.
    const building: BuildingState | null = def.isBuilding
      ? { constructionLeft: constructionTime, buildTimeTotal: constructionTime || 1, builderId: 0, queue: [], rallyX: x, rallyY: y - 200, producesUnits: trainsFor(def.id).length > 0 }
      : null;
    this.sim.add(
      {
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
        hp: constructionTime > 0 ? (def.hitPoints || 100) * 0.1 : def.hitPoints || 100,
        maxHp: def.hitPoints || 100,
        mana: def.mana,
        maxMana: def.mana,
        armor: def.armor,
        weapon: weaponFor(def),
        worker,
        depotGold: DEPOT_IDS.has(def.id) && def.id !== "hlum", // lumber mill: lumber only
        depotLumber: DEPOT_IDS.has(def.id),
      },
      building,
    );
    const entry: Entry = {
      simId,
      unit: { instance, state: IDLE },
      anims,
      moveHeight: lift(def.moveHeight),
      selRadius: (def.selScale || 1) * SEL_RADIUS_PER_SCALE,
      typeId: def.id,
      race: def.race,
      name: def.name,
      foodUsed: def.foodUsed,
      foodMade: def.foodMade,
      isHero: def.isHero,
      level: def.level,
      modelPath: def.model,
      baseScale: def.modelScale || 1,
      curScale: def.modelScale || 1,
      ...findBirthFields(instance.model.sequences),
      hidden: false,
      curSeq: -1,
    };
    this.entries.push(entry);
    this.byId.set(simId, entry);
    if (anims.stand >= 0) {
      instance.setSequence(anims.stand);
      instance.setSequenceLoopMode(LOOP_ALWAYS);
      entry.curSeq = anims.stand;
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
      // Workers inside a gold mine vanish; chopping plays the attack swing.
      if (u.inMine !== e.hidden) {
        e.hidden = u.inMine;
        if (e.hidden) {
          e.unit.instance.hide();
          this.deselect(e.simId); // deselect on mine entry
          if (this.hovered === e.simId) this.hovered = null;
        } else {
          e.unit.instance.show();
        }
      }
      // A building under construction: play its own "Birth" animation, scrubbed
      // to the construction progress so it assembles in sync with the timer.
      // Models without a Birth clip fall back to scaling up from ~40% to full.
      if (u.building && u.building.constructionLeft > 0) {
        const prog = 1 - u.building.constructionLeft / u.building.buildTimeTotal;
        if (e.birthSeq >= 0) {
          if (e.curSeq !== e.birthSeq) {
            e.curSeq = e.birthSeq;
            e.unit.state = WALK; // keep mdx-m3-viewer from auto-standing
            e.unit.instance.setSequence(e.birthSeq);
            e.unit.instance.setSequenceLoopMode(LOOP_NEVER);
          }
          e.unit.instance.frame = e.birthStart + prog * (e.birthEnd - e.birthStart);
        } else {
          const s = e.baseScale * (0.4 + 0.6 * prog);
          if (Math.abs(s - e.curScale) > 0.005) {
            e.curScale = s;
            e.unit.instance.setUniformScale(s);
          }
        }
        continue; // don't run the normal animation picker while building
      }
      if (e.curScale !== e.baseScale) {
        e.curScale = e.baseScale;
        e.unit.instance.setUniformScale(e.baseScale);
      }
      const seq = this.pickSequence(e.anims, u);
      if (seq !== e.curSeq && seq >= 0) {
        e.curSeq = seq;
        // Non-stand state prevents mdx-m3-viewer's auto-stand override.
        e.unit.state = seq === e.anims.stand ? IDLE : WALK;
        e.unit.instance.setSequence(seq);
        e.unit.instance.setSequenceLoopMode(LOOP_ALWAYS);
      }
    }
    this.updateHealthBars();
  }

  /** The sim removed this unit: play its death animation, then keep the corpse
   *  briefly before hiding the instance. */
  private onDeath(simId: number): void {
    const e = this.byId.get(simId);
    if (!e) return;
    this.byId.delete(simId);
    this.entries.splice(this.entries.indexOf(e), 1);
    this.deselect(simId);
    e.unit.state = WALK; // keep mdx-m3-viewer from overriding the death sequence
    if (e.anims.death >= 0) {
      e.unit.instance.setSequence(e.anims.death);
      e.unit.instance.setSequenceLoopMode(LOOP_NEVER);
      this.corpses.push({ instance: e.unit.instance, t: CORPSE_TIME });
    } else {
      e.unit.instance.hide();
    }
  }

  /** Choose the animation sequence for a unit's current state, using the
   *  worker's carried resource so peasants walk/stand/chop with the right
   *  gold- and lumber-carrying clips. */
  private pickSequence(a: AnimSet, u: SimUnit): number {
    const carry = u.worker
      ? u.worker.carryGold > 0
        ? "gold"
        : u.worker.carryLumber > 0
          ? "lumber"
          : null
      : null;
    if ((u.constructing || u.repair?.active) && !u.moving) return a.build; // hammering (build/repair)
    if (u.working) return a.chopLumber; // chopping a tree
    if (u.moving) return carry === "gold" ? a.walkGold : carry === "lumber" ? a.walkLumber : a.walk;
    if (u.inCombat) return a.attack;
    return carry === "gold" ? a.standGold : carry === "lumber" ? a.standLumber : a.stand;
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

  /** Left-click a unit selects it. Clicking empty ground does NOT deselect (WC3
   *  has no click-to-deselect — you keep your selection until you pick another). */
  selectAt(cssX: number, cssY: number): void {
    const id = this.pickAt(cssX, cssY);
    if (id !== null) {
      this.selected.clear();
      this.selected.add(id);
      this.selectedMine = null;
      this.refocus();
      return;
    }
    // No unit under the cursor — a gold mine is clickable too (shows its gold).
    const g = this.groundPoint(cssX, cssY);
    if (g) {
      const m = this.sim.nearestMine(g[0], g[1], 300);
      if (m) {
        this.selected.clear();
        this.primary = null;
        this.selectedMine = m.id;
        return;
      }
    }
    // Empty ground: keep the current selection (no manual deselect).
  }

  /** Drag-box: select all of the local player's mobile units whose on-screen
   *  position falls inside the rectangle (CSS px). Empty box clears the group. */
  selectBox(x0: number, y0: number, x1: number, y1: number): void {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const viewport = this.host.viewport();
    const dpr = this.dpr();
    const h = this.host.canvas.height;
    const picked: number[] = [];
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (!u || e.hidden) continue;
      if (u.owner !== this.localPlayer || u.building) continue; // own mobile units only
      this.world[0] = u.x;
      this.world[1] = u.y;
      this.world[2] = this.heightAt(u.x, u.y) + e.moveHeight;
      this.host.camera.worldToScreen(this.screen, this.world, viewport);
      const sx = this.screen[0] / dpr;
      const sy = (h - this.screen[1]) / dpr; // gl y-up → css y-down
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) picked.push(e.simId);
    }
    if (picked.length === 0) return; // empty box: keep the current selection
    this.selected.clear();
    for (const id of picked.slice(0, MAX_SELECT)) this.selected.add(id); // WC3 cap
    this.selectedMine = null;
    this.refocus();
  }

  /** Pointer move: show the ring + HP bar under the unit being hovered. */
  hoverAt(cssX: number, cssY: number): void {
    this.hovered = this.pickAt(cssX, cssY);
  }

  /** Live units, for the metrics overlay. */
  unitCount(): number {
    return this.entries.length;
  }

  // --- HUD driver surface ---------------------------------------------------

  /** Armed command-card order; the next left-click executes it instead of
   *  selecting. "rally" sets a building's rally point; "repair" targets a
   *  damaged friendly building. */
  orderMode: "move" | "attack" | "patrol" | "rally" | "repair" | null = null;

  /** Execute the armed order at a screen point. Returns true when consumed
   *  (the caller should then clear the HUD's armed state). */
  orderClickAt(cssX: number, cssY: number): boolean {
    if (!this.orderMode || this.selected.size === 0) {
      this.orderMode = null;
      return false;
    }
    const mode = this.orderMode;
    this.orderMode = null;
    if (mode === "rally") {
      const hit = this.groundPoint(cssX, cssY);
      if (hit) {
        for (const id of this.selected) {
          if (this.sim.units.get(id)?.building?.producesUnits) this.sim.setRally(id, hit[0], hit[1]);
        }
        this.queueArrow(hit[0], hit[1], MOVE_ARROW);
      }
      return true;
    }
    if (mode === "repair") {
      this.repairAt(this.pickAt(cssX, cssY));
      return true;
    }
    if (mode === "attack") {
      const picked = this.pickAt(cssX, cssY);
      const prim = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
      if (picked !== null && prim) {
        const target = this.sim.units.get(picked);
        if (target && this.sim.hostile(prim, target)) {
          let any = false;
          for (const id of this.selected) if (id !== picked && this.sim.issueAttack(id, picked)) any = true;
          if (any) {
            this.flashAttack(target.x, target.y, this.byId.get(picked)?.selRadius ?? target.radius);
            return true;
          }
        }
      }
      // No hostile under the cursor: attack-MOVE to the ground point (below).
    }
    const dpr = this.dpr();
    this.screen[0] = cssX * dpr;
    this.screen[1] = cssY * dpr;
    this.host.camera.screenToWorldRay(this.ray, this.screen, this.host.viewport());
    const hit = this.groundHit();
    if (!hit) return true;
    if (mode === "patrol") {
      for (const id of this.selected) this.sim.issuePatrol(id, hit[0], hit[1]);
      this.queueArrow(hit[0], hit[1], MOVE_ARROW);
    } else if (mode === "attack") {
      for (const id of this.selected) this.sim.issueAttackMove(id, hit[0], hit[1]);
      this.queueArrow(hit[0], hit[1], ATTACK_ARROW); // red a-move feedback
    } else {
      for (const id of this.selected) this.sim.issueMove(id, hit[0], hit[1]);
      this.queueArrow(hit[0], hit[1], MOVE_ARROW);
    }
    return true;
  }

  /** Order-feedback arrows (Confirmation.mdx) at a destination: green for a
   *  move/patrol, red for an attack-move. Drained + rendered by the host. */
  private orderArrows: Array<{ x: number; y: number; z: number; color: [number, number, number] }> = [];
  private queueArrow(x: number, y: number, color: [number, number, number]): void {
    this.orderArrows.push({ x, y, z: this.heightAt(x, y), color });
  }
  drainOrderArrows(): Array<{ x: number; y: number; z: number; color: [number, number, number] }> {
    if (!this.orderArrows.length) return this.orderArrows;
    const out = this.orderArrows;
    this.orderArrows = [];
    return out;
  }

  stopSelected(): void {
    for (const id of this.selected) this.sim.stop(id);
  }

  /** Order the selected workers to repair a damaged friendly building. WC3
   *  rates: 35% of the build cost and 150% of the build time to go 1 HP→full. */
  private repairAt(picked: number | null): boolean {
    if (picked === null) return false;
    const target = this.sim.units.get(picked);
    if (!target?.building || target.building.constructionLeft > 0 || target.hp >= target.maxHp || target.owner !== this.localPlayer) return false;
    const def = this.registry.get(this.byId.get(picked)?.typeId ?? "");
    if (!def) return false;
    const maxHp = Math.max(1, target.maxHp);
    const hpPerSec = maxHp / Math.max(1, (def.buildTime || 60) * 1.5);
    const goldPerHp = (def.goldCost * 0.35) / maxHp;
    const lumberPerHp = (def.lumberCost * 0.35) / maxHp;
    let any = false;
    for (const id of this.selected) {
      const w = this.sim.units.get(id);
      if (w?.worker && this.sim.issueRepair(id, picked, hpPerSec, goldPerHp, lumberPerHp)) any = true;
    }
    return any;
  }

  selectedInfo(): SelectionInfo | null {
    if (this.selectedMine !== null) return this.mineInfo(this.selectedMine);
    if (this.primary === null) return null;
    return this.infoFor(this.primary);
  }

  /** Selection info for a gold mine (name + remaining gold + its model). */
  private mineInfo(mineId: number): SelectionInfo | null {
    const m = this.sim.mines.get(mineId);
    if (!m) return null;
    const def = this.registry.get("ngol");
    return {
      id: -1000 - mineId, // synthetic, negative — never clashes with a unit id
      typeId: "ngol", race: "", name: def?.name || "Gold Mine", owner: -1,
      hp: 0, maxHp: 0, mana: 0, maxMana: 0, armor: 0, damageMin: 0, damageMax: 0,
      attackType: "", armorType: "", isHero: false, level: 0, strength: 0,
      agility: 0, intelligence: 0, primaryAttr: "",
      model: def?.model ?? "", isWorker: false, isBuilding: false,
      underConstruction: false, buildProgress: 0, trainProgress: 0, queueLength: 0,
      queue: [], icon: def?.icon ?? "", carryGold: 0, carryLumber: 0,
      isMine: true, goldRemaining: m.gold,
    };
  }

  private infoFor(id: number): SelectionInfo | null {
    const u = this.sim.units.get(id);
    const e = this.byId.get(id);
    if (!u || !e) return null;
    const w = u.weapon;
    const b = u.building;
    const q = b?.queue ?? [];
    const def = this.registry.get(e.typeId);
    return {
      id: e.simId,
      typeId: e.typeId,
      race: e.race,
      name: e.name,
      owner: u.owner,
      hp: u.hp,
      maxHp: u.maxHp,
      mana: u.mana,
      maxMana: u.maxMana,
      armor: u.armor,
      // WC3 damage display: base + dice (min 1 each) … base + dice×sides.
      damageMin: w ? w.damage + w.dice : 0,
      damageMax: w ? w.damage + w.dice * w.sides : 0,
      attackType: def?.attackType ?? "",
      armorType: def?.armorType ?? "",
      isHero: def?.isHero ?? false,
      level: def?.level ?? 0,
      strength: def?.strength ?? 0,
      agility: def?.agility ?? 0,
      intelligence: def?.intelligence ?? 0,
      primaryAttr: def?.primaryAttr ?? "",
      model: e.modelPath,
      isWorker: !!u.worker,
      isBuilding: !!b,
      underConstruction: !!b && b.constructionLeft > 0,
      buildProgress: b && b.buildTimeTotal > 0 ? 1 - b.constructionLeft / b.buildTimeTotal : 1,
      trainProgress: q.length && q[0].buildTime > 0 ? 1 - q[0].timeLeft / q[0].buildTime : 0,
      queueLength: q.length,
      queue: q.map((j) => ({ icon: this.registry.get(j.unitId)?.icon ?? "" })),
      icon: this.registry.get(e.typeId)?.icon ?? "",
      carryGold: u.worker?.carryGold ?? 0,
      carryLumber: u.worker?.carryLumber ?? 0,
      isMine: false,
      goldRemaining: 0,
    };
  }

  /** Owner of the primary selected unit (for build/train ownership checks). */
  selectedOwner(): number | null {
    if (this.primary === null) return null;
    return this.sim.units.get(this.primary)?.owner ?? null;
  }

  /** The primary (leader) selected unit id — drives the HUD and build placement. */
  get selectedId(): number | null {
    return this.primary;
  }

  /** Order the primary worker to walk to a build site (only the builder goes). */
  moveSelectedTo(x: number, y: number): void {
    if (this.primary !== null) this.sim.issueMove(this.primary, x, y);
  }

  /** Terrain height at a world point (for placing ground-hugging ghosts). */
  groundHeightAt(x: number, y: number): number {
    return this.heightAt(x, y);
  }

  /** Convert a CSS click to a world ground point (for build placement). */
  groundPoint(cssX: number, cssY: number): [number, number] | null {
    const dpr = this.dpr();
    this.screen[0] = cssX * dpr;
    this.screen[1] = cssY * dpr;
    this.host.camera.screenToWorldRay(this.ray, this.screen, this.host.viewport());
    return this.groundHit();
  }

  /** Time of day for the HUD clock: game-hour + day/night flag. */
  timeOfDay(): { hour: number; isDay: boolean } {
    return { hour: this.sim.timeOfDay, isDay: this.sim.isDay };
  }

  /** Ground-circle info for every selected unit (the renderer draws each ring as
   *  a flat model on the terrain so geometry occludes it). */
  selectionRings(): RingInfo[] {
    const out: RingInfo[] = [];
    for (const id of this.selected) {
      const u = this.sim.units.get(id);
      const e = this.byId.get(id);
      // Buildings get a ring sized to their footprint (a constant tiny ring is
      // hidden under the model); units keep the constant ring.
      if (u && e) out.push({ x: u.x, y: u.y, z: this.heightAt(u.x, u.y), radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building });
    }
    if (this.selectedMine !== null) {
      const m = this.sim.mines.get(this.selectedMine);
      // A gold mine is Neutral PASSIVE (yellow ring), not hostile (red).
      if (m) out.push({ x: m.x, y: m.y, z: this.heightAt(m.x, m.y), radius: m.radius, owner: -1, team: -2, sizeToRadius: true, neutral: true });
    }
    return out;
  }

  /** Ground-circle for the hovered unit (skipped if it's already selected). */
  hoverRing(): RingInfo | null {
    if (this.hovered === null || this.selected.has(this.hovered)) return null;
    const u = this.sim.units.get(this.hovered);
    const e = this.byId.get(this.hovered);
    if (!u || !e) return null;
    return { x: u.x, y: u.y, z: this.heightAt(u.x, u.y), radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building };
  }

  /** Re-pin under-construction buildings' Birth frame to construction progress
   *  AFTER the renderer's animation update — otherwise mdx-m3-viewer's per-frame
   *  frame advance creeps the birth forward, so a HALTED construction still
   *  looked like it was building. Called each frame post-update; this makes the
   *  birth freeze when paused and resume exactly with progress. */
  repinConstructionFrames(): void {
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (!u?.building || u.building.constructionLeft <= 0 || e.birthSeq < 0) continue;
      const prog = 1 - u.building.constructionLeft / u.building.buildTimeTotal;
      e.unit.instance.frame = e.birthStart + prog * (e.birthEnd - e.birthStart);
    }
  }

  /** Rally point of the primary selected UNIT-PRODUCING building (for the rally
   *  flag), or null. Towers/farms/etc. don't produce units, so no rally. */
  selectedRally(): { x: number; y: number; z: number } | null {
    if (this.primary === null) return null;
    const b = this.sim.units.get(this.primary)?.building;
    return b && b.producesUnits ? { x: b.rallyX, y: b.rallyY, z: this.heightAt(b.rallyX, b.rallyY) } : null;
  }

  /** World position of the primary selected unit / mine (portrait-click focus). */
  selectedPosition(): [number, number] | null {
    if (this.selectedMine !== null) {
      const m = this.sim.mines.get(this.selectedMine);
      return m ? [m.x, m.y] : null;
    }
    if (this.primary === null) return null;
    const u = this.sim.units.get(this.primary);
    return u ? [u.x, u.y] : null;
  }

  /** Direct access to the headless sim (map wiring: trees/mines/stash). */
  get simWorld(): SimWorld {
    return this.sim;
  }

  stashFor(owner: number): { gold: number; lumber: number } {
    return this.sim.stashOf(owner);
  }

  /** Food used/made by a player's living units. */
  foodFor(owner: number): { used: number; made: number } {
    let used = 0;
    let made = 0;
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (u && u.owner === owner) {
        used += e.foodUsed;
        made += e.foodMade;
      }
    }
    return { used, made };
  }

  /** Minimap dots: world positions + owners of all living units. */
  dots(): Array<{ x: number; y: number; owner: number }> {
    const out: Array<{ x: number; y: number; owner: number }> = [];
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (u) out.push({ x: u.x, y: u.y, owner: u.owner });
    }
    return out;
  }

  /** Right-click: order the whole selection. Attack a hostile under the cursor;
   *  workers resume a friendly build or harvest a resource; else move to ground. */
  moveAt(cssX: number, cssY: number): void {
    if (this.selected.size === 0) return;
    const prim = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
    // A selected unit-producing building: right-click sets its rally point.
    if (prim?.building?.producesUnits) {
      const hit = this.groundPoint(cssX, cssY);
      if (hit) {
        for (const id of this.selected) {
          if (this.sim.units.get(id)?.building?.producesUnits) this.sim.setRally(id, hit[0], hit[1]);
        }
        this.queueArrow(hit[0], hit[1], MOVE_ARROW);
      }
      return;
    }
    const picked = this.pickAt(cssX, cssY);
    if (picked !== null && !this.selected.has(picked)) {
      const target = this.sim.units.get(picked);
      if (target && prim && this.sim.hostile(prim, target)) {
        let any = false;
        for (const id of this.selected) if (this.sim.issueAttack(id, picked)) any = true;
        if (any) {
          this.flashAttack(target.x, target.y, this.byId.get(picked)?.selRadius ?? target.radius);
          return;
        }
      }
      // Workers right-clicking a friendly under-construction building resume it.
      if (target && target.building && target.building.constructionLeft > 0) {
        let any = false;
        for (const id of this.selected) {
          const w = this.sim.units.get(id);
          if (w?.worker && target.owner === w.owner) {
            this.sim.assignBuilder(id, picked);
            any = true;
          }
        }
        if (any) return;
      }
      // Workers right-clicking a friendly DAMAGED (completed) building repair it.
      if (target && target.building && target.building.constructionLeft <= 0 && target.hp < target.maxHp) {
        if (this.repairAt(picked)) return;
      }
    }
    // screenToWorldRay/unproject expects window coords with a TOP-LEFT origin
    // (Y-down) — the opposite of worldToScreen (Y-up) used by selection.
    const dpr = this.dpr();
    this.screen[0] = cssX * dpr;
    this.screen[1] = cssY * dpr;
    this.host.camera.screenToWorldRay(this.ray, this.screen, this.host.viewport());
    const hit = this.groundHit();
    if (!hit) return;
    // Workers in the selection right-clicking a resource start harvesting.
    // Generous pick radii: mines are 4×4 tiles, and clicking a tree canopy
    // lands the ground ray well behind the trunk.
    const mine = this.sim.nearestMine(hit[0], hit[1], 320);
    if (mine) {
      let any = false;
      for (const id of this.selected) {
        const w = this.sim.units.get(id);
        if (w?.worker?.gold && this.sim.issueHarvest(id, "gold", mine.id)) any = true;
      }
      if (any) {
        this.flashTarget(mine.x, mine.y, mine.radius);
        return;
      }
    }
    const tree = this.sim.nearestTree(hit[0], hit[1], 140);
    if (tree) {
      let any = false;
      for (const id of this.selected) {
        const w = this.sim.units.get(id);
        if (w?.worker?.lumber && this.sim.issueHarvest(id, "lumber", tree.id)) any = true;
      }
      if (any) {
        this.flashTarget(tree.x, tree.y, 48); // trees ≈ 2×2 cells
        this.treePulses.push({ x: tree.x, y: tree.y }); // pulse the tree yellow too
        return;
      }
    }
    for (const id of this.selected) this.sim.issueMove(id, hit[0], hit[1]);
    this.queueArrow(hit[0], hit[1], MOVE_ARROW); // green move-order feedback
  }

  /** Queue a yellow harvest-target flash — the renderer draws it as a flat
   *  ground circle (twice) like the selection ring, sized to the node. */
  private flashTarget(x: number, y: number, radius: number): void {
    this.flashRequests.push({ x, y, z: this.heightAt(x, y), radius, color: [1, 0.88, 0.2] });
  }

  /** Queue a red attack-target flash at a hostile unit (same twin-blink as the
   *  harvest flash, but red) when it's ordered to be attacked. */
  private flashAttack(x: number, y: number, radius: number): void {
    this.flashRequests.push({ x, y, z: this.heightAt(x, y), radius, color: [1, 0.2, 0.16] });
  }

  /** Trees to pulse yellow since the last drain (renderer tints the doodad). */
  drainTreePulses(): Array<{ x: number; y: number }> {
    if (!this.treePulses.length) return this.treePulses;
    const out = this.treePulses;
    this.treePulses = [];
    return out;
  }

  /** Harvest-flash requests since the last drain (renderer renders + times them). */
  drainFlashes(): Array<{ x: number; y: number; z: number; radius: number; color: [number, number, number] }> {
    if (!this.flashRequests.length) return this.flashRequests;
    const out = this.flashRequests;
    this.flashRequests = [];
    return out;
  }

  /** Sim id of the unit whose footprint the cursor is over. Uses each unit's
   *  world-space collision radius projected to screen, so large units and
   *  buildings are selectable anywhere on their body (not just dead-centre).
   *  Ties break toward the smallest hit (a unit in front of a building wins). */
  private pickAt(cssX: number, cssY: number): number | null {
    // Hybrid pick: project each unit's mid-body to screen and test the cursor
    // against it (this handles TALL buildings — you click the body, whose base's
    // ground point sits well behind it), but GATE candidates by world distance
    // to the click's ground point. The gate kills the zoomed-out / behind-camera
    // false positives that pure screen-projection produced (distant creeps).
    const ground = this.groundPoint(cssX, cssY);
    const [glx, gly] = this.toGl(cssX, cssY);
    const viewport = this.host.viewport();
    const dpr = this.dpr();
    let bestUnit: number | null = null;
    let bestUnitScore = Infinity;
    let bestBldg: number | null = null;
    let bestBldgScore = Infinity;
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId)!;
      if (e.hidden) continue;
      if (ground && Math.hypot(u.x - ground[0], u.y - ground[1]) > PICK_WORLD_MAX) continue;
      const baseZ = this.heightAt(u.x, u.y) + e.moveHeight;
      // Project the unit's mid-body (base + ~half its height) to screen.
      this.world[0] = u.x;
      this.world[1] = u.y;
      this.world[2] = baseZ + Math.max(e.selRadius * 1.2, 60);
      this.host.camera.worldToScreen(this.screen, this.world, viewport);
      const cx = this.screen[0];
      const cy = this.screen[1];
      this.world2.set(this.world);
      this.world2[0] = u.x + Math.max(u.radius, e.selRadius, 64);
      this.host.camera.worldToScreen(this.screen2, this.world2, viewport);
      const rPx = Math.hypot(this.screen2[0] - cx, this.screen2[1] - cy) + 14 * dpr;
      const d = Math.hypot(glx - cx, gly - cy);
      if (d > rPx) continue;
      const score = d / rPx;
      if (u.building) {
        if (score < bestBldgScore) { bestBldgScore = score; bestBldg = e.simId; }
      } else if (score < bestUnitScore) {
        bestUnitScore = score;
        bestUnit = e.simId;
      }
    }
    return bestUnit ?? bestBldg;
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

  /** Draw a floating HP bar above every visible unit each frame (always-on),
   *  reusing a pool of DOM elements. Off-screen / hidden units release theirs. */
  private updateHealthBars(): void {
    this.pruneSelection();
    const viewport = this.host.viewport();
    const dpr = this.dpr();
    const w = this.host.canvas.width;
    const h = this.host.canvas.height;
    let n = 0;
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (!u || e.hidden) continue; // worker inside a mine, etc.
      this.world[0] = u.x;
      this.world[1] = u.y;
      // Bar floats at the unit's drawn base — for air units, their altitude.
      this.world[2] = this.heightAt(u.x, u.y) + e.moveHeight;
      this.host.camera.worldToScreen(this.screen, this.world, viewport);
      const sx = this.screen[0];
      const sy = this.screen[1];
      if (sx < 0 || sx > w || sy < 0 || sy > h) continue;
      // Foreshortened selection radius → how far above the base to float the bar
      // and how wide to draw it, so both track zoom.
      this.world2.set(this.world);
      this.world2[1] = u.y + e.selRadius;
      this.host.camera.worldToScreen(this.screen2, this.world2, viewport);
      const ry = Math.max(MIN_RING_PX / 2, Math.hypot(this.screen2[0] - sx, this.screen2[1] - sy) / dpr);
      const bar = this.hpBars[n] ?? (this.hpBars[n] = makeHpBar());
      n++;
      const frac = Math.max(0, Math.min(1, u.hp / u.maxHp));
      bar.hp.style.width = `${frac * 100}%`;
      bar.hp.style.background = frac > 0.6 ? "#46e05a" : frac > 0.3 ? "#e0c146" : "#e05046";
      // Mana bar (units/heroes with a mana pool).
      if (u.maxMana > 0) {
        bar.manaTrack.hidden = false;
        bar.mana.style.width = `${Math.max(0, Math.min(1, u.mana / u.maxMana)) * 100}%`;
      } else {
        bar.manaTrack.hidden = true;
      }
      // Hero level badge to the left of the bars.
      if (e.isHero && e.level > 0) {
        bar.level.hidden = false;
        bar.level.textContent = String(e.level);
      } else {
        bar.level.hidden = true;
      }
      bar.root.hidden = false;
      // Bar width tracks the unit/building on-screen size (≈ its footprint).
      bar.bars.style.width = `${Math.max(20, Math.min(140, ry * 2))}px`;
      bar.root.style.left = `${sx / dpr}px`;
      bar.root.style.top = `${(h - sy) / dpr - (ry + 14)}px`; // gl y-up → css y-down
    }
    for (let k = n; k < this.hpBars.length; k++) this.hpBars[k].root.hidden = true;
  }

  /** CSS px → GL px (device pixels, y-up) to match camera.worldToScreen. */
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

// Weapon types that fire a travelling projectile (vs. instant melee).
const RANGED_WEAPON_TYPES = new Set(["missile", "msplash", "mbounce", "artillery"]);

// A unit's weapon from its registry stats; null when it can't attack.
function weaponFor(def: UnitDef): SimWeapon | null {
  if (def.attackCooldown <= 0 || def.attackDamage + def.attackDice * def.attackSides <= 0) return null;
  const ranged = RANGED_WEAPON_TYPES.has(def.weaponType.toLowerCase()) || def.missileArt !== "";
  return {
    damage: def.attackDamage,
    dice: def.attackDice,
    sides: def.attackSides,
    cooldown: def.attackCooldown,
    range: def.attackRange,
    acquire: def.acquireRange,
    ranged,
    missileArt: def.missileArt,
    missileSpeed: def.missileSpeed,
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
