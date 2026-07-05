import { SimWorld, xpForLevel, type SimWeapon, type WorkerState, type SimUnit, type BuildingState, type QueuedOrder, type RallyKind, type SimAbility, type HeroInit } from "../sim/world";
import { KNOWN_ABILITIES } from "../data/abilities";
import { footprintCells, PATHING_CELL, type PathingGrid } from "../sim/pathing";
import { VisionMap, FogState } from "../sim/vision";
import type { HeightSampler } from "./heightmap";
import type { UnitRegistry, UnitDef } from "../data/units";
import { type AbilityRegistry, type AbilityDef } from "../data/abilities";
import { WORKERS, DEPOT_IDS } from "../data/races";
import { trainsFor } from "../data/techtree";
import type { SoundBoard, SoundCategory } from "../audio/sounds";

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
  vertexColor?: Float32Array; // MDX tint; multiplied by fog brightness to dim in fog
  setVertexColor?(c: ArrayLike<number>): unknown;
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
  armor: number; // BASE armour (level/agility, without buff bonuses)
  armorBonus: number; // green "+N" armour from buffs/auras
  damageMin: number; // BASE damage range (without buff bonuses)
  damageMax: number;
  damageBonus: number; // green "+N" attack damage from buffs/auras
  attackType: string; // normal/pierce/siege/magic/chaos/hero
  armorType: string; // small/medium/large/fort/hero/divine/none
  isHero: boolean;
  level: number;
  xp: number; // hero current experience
  xpThis: number; // XP threshold for the current level
  xpNext: number; // XP threshold for the next level (== xpThis at max level)
  skillPoints: number; // unspent hero skill points
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
  secondsLeft: number; // seconds remaining on the active construction/training job
  queueLength: number;
  queue: Array<{ icon: string }>; // icons of the units queued for training
  icon: string; // the selected thing's own command-card icon (BLP path)
  carryGold: number;
  carryLumber: number;
  isMine: boolean; // a selected gold mine (resource, not a unit)
  goldRemaining: number; // gold left in the selected mine
  isSummon: boolean; // a temporary summoned unit (shows the "Summoned Unit" timer bar)
  summonSecondsLeft: number; // seconds until the summon expires
  summonFrac: number; // remaining fraction of its lifetime (bar fill)
  buffs: Array<{ icon: string; name: string; harmful: boolean }>; // active auras/buffs/debuffs
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
  attackVariants: number[]; // all combat-attack clips; a random one plays per swing
  death: number;
  standGold: number;
  walkGold: number;
  standLumber: number;
  walkLumber: number;
  chopLumber: number; // "Attack Lumber" — the chopping swing
  build: number; // "Stand Work" — the hammering pose while constructing
  decayFlesh: number; // corpse decay — flesh rots (heroes lack this)
  decayBone: number; // corpse decay — bones linger, then vanish
  seqNames: string[]; // raw sequence names (for cast-animation tag matching)
}

function buildAnimSet(seqs: Array<{ name: string }>): AnimSet {
  const find = (re: RegExp): number => seqs.findIndex((s) => re.test(s.name));
  const stand = find(/^stand(\s|$|-)/i) >= 0 ? find(/^stand(\s|$|-)/i) : find(/^stand/i);
  const walk = find(/^walk\s*$/i) >= 0 ? find(/^walk\s*$/i) : find(/walk/i);
  const attack = find(/^attack\s*$/i) >= 0 ? find(/^attack\s*$/i) : find(/attack/i);
  // Every basic combat-attack clip (e.g. "Attack -1"/"Attack -2"), so a random
  // one can play per swing. Excludes the lumber chop, the Defend stance, hero
  // Alternate-form attacks, and "Attack Slam" — that clip is reserved for
  // ability casts (e.g. the Mountain King's bash), not the auto-attack rotation.
  const attackVariants = seqs
    .map((s, i) => ({ n: s.name, i }))
    .filter(({ n }) => /attack/i.test(n) && !/lumber|defend|alternate|slam/i.test(n))
    .map(({ i }) => i);
  const or = (a: number, b: number) => (a >= 0 ? a : b);
  return {
    stand,
    walk,
    attack,
    attackVariants: attackVariants.length ? attackVariants : attack >= 0 ? [attack] : [],
    death: find(/^death/i),
    standGold: or(find(/stand gold/i), stand),
    walkGold: or(find(/walk gold/i), walk),
    standLumber: or(find(/stand lumber/i), stand),
    walkLumber: or(find(/walk lumber/i), walk),
    chopLumber: or(find(/attack lumber/i), attack),
    build: or(find(/stand work(?! gold| lumber)/i), or(find(/^stand work/i), attack)),
    decayFlesh: find(/decay flesh/i),
    decayBone: find(/decay bone/i),
    seqNames: seqs.map((s) => s.name),
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
  hidden: boolean; // instance currently hidden (worker in a gold mine, OR fog of war)
  inMine: boolean; // worker is inside a gold mine (the hide cause that also deselects)
  curSeq: number; // sequence index currently playing (avoid redundant sets)
  lastSwingSeq: number; // last sim swingSeq the attack clip was re-triggered for
  lastChopSeq: number; // last sim chopSeq the chop clip was re-triggered for
  castAnimT: number; // >0 while a cast animation is held (skips the normal picker)
  moveEma: number; // smoothed actual/expected displacement — gates the walk clip
  baseColor?: Float32Array; // model's own tint, captured before any fog dimming
  fogTintB?: number; // last fog brightness applied (avoids redundant setVertexColor)
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
// Brightness of a remembered-but-not-seen building in fog — matches the ground veil's
// EXPLORED_DARK (0.5) so a greyed structure sits at the same dimness as its terrain.
const FOG_EXPLORED_BRIGHT = 0.5;
// A unit ordered to move but pinned in place by the crowd (actual displacement
// far below what its speed would cover) shouldn't run the walk clip — it just
// jogs on the spot, awkwardly. Below this share of expected displacement (EMA-
// smoothed to avoid flicker), fall back to the stand pose instead.
const MOVE_ANIM_MIN_RATIO = 0.2;
const MOVE_EMA_ALPHA = 0.25; // per-tick blend toward the current ratio
// Corpse lifecycle (WC3): a dead unit plays Death, then — if the model has them —
// Decay Flesh and Decay Bone, and the bones linger until the sim corpse fully
// decays (88s after death; see world.ts CORPSE_TOTAL_TIME). Units that leave no
// corpse (air/mechanical/buildings) simply vanish once the Death clip ends. Clip
// lengths come from the MDX intervals; these are the fallbacks when unknown.
const DEATH_CLIP_FALLBACK = 1.6; // seconds to hold a Death clip of unknown length
const DECAY_CLIP_FALLBACK = 3; // seconds to hold a Decay Flesh clip of unknown length
const CAST_ANIM_HOLD = 0.8; // seconds a cast animation is held from the picker
// Buff status-row display: map non-aura buff groups to their source ability code,
// and give the remaining buff kinds a generic icon + label.
const GROUP_TO_CODE: Record<string, string> = { innerfire: "Ainf", avatar: "AHav", slow: "Aslo" };
const BUFF_KIND_ICON: Record<string, string> = {
  stun: "ReplaceableTextures\\CommandButtons\\BTNStun.blp",
  invuln: "ReplaceableTextures\\CommandButtons\\BTNDivineIntervention.blp",
};
const BUFF_KIND_LABEL: Record<string, string> = {
  stun: "Stunned", slow: "Slowed", invuln: "Invulnerable", armor: "Bonus Armor", damage: "Bonus Damage",
  damagePct: "Bonus Damage", haste: "Haste", manaRegen: "Mana Regeneration", hpRegen: "Health Regeneration",
  lifesteal: "Life Steal", thorns: "Thorns", hot: "Healing", dot: "Damage",
};
const LOOP_NEVER = 0, LOOP_ALWAYS = 2; // mdx-m3-viewer sequence loop modes
const AIR_EXTRA = 60; // extra world units of altitude on top of UnitData moveheight
// WC3's selection circle diameter ≈ 72 world units at selection scale 1.0.
const SEL_RADIUS_PER_SCALE = 36;
// Re-clicking the same single unit this many extra times flips its selection
// voice from "What" to the annoyed "Pissed" set (WC3's easter-egg escalation).
const PISSED_AFTER = 3;
// The gold-mine ring is drawn a bit larger than the mine's collision radius (which
// drives worker entry) so it reads as a ring hugging the mine base, not its footprint.
const MINE_RING_SCALE = 1.4;
const MIN_RING_PX = 12; // don't let rings vanish when zoomed far out
// Extra world-unit gap added to the builder fan-out when several workers speed-
// build one structure, so they spread around the whole footprint instead of
// bunching up (a body-and-a-half wider than the tight gold-mine approach).
const SPEED_BUILD_SPREAD = 48;
const MINE_APPROACH_SPREAD = 16; // gentle widening of the gold-mine approach ring
// Edge gap between the leader's body and the innermost ring of a follow formation
// — a comfortable body's-length behind, so followers trail rather than crowd.
const FOLLOW_RING_GAP = 40;
// Order-confirmation arrow tints (Confirmation.mdx): green = move, red = a-move.
const MOVE_ARROW: [number, number, number] = [0.1, 1, 0.1];
const ATTACK_ARROW: [number, number, number] = [1, 0.15, 0.1];
// Target-circle flash tints (the twin-blink ring, like the gold mine): green for
// a friendly/own building, yellow for allied or neutral, red for a hostile one.
const FLASH_GREEN: [number, number, number] = [0.3, 1, 0.3];
const FLASH_YELLOW: [number, number, number] = [1, 0.88, 0.2];
const FLASH_RED: [number, number, number] = [1, 0.2, 0.16];
const TREE_FLAG_HEIGHT = 180; // lift a queue flag to a tree's canopy top
const TREE_COLLIDER_HEIGHT = 110; // pick trees against a raised plane so clicking up the trunk/canopy still selects them
// Max world distance from the click's ground point to a pickable unit. Gates out
// far/behind-camera units that screen-projection alone would wrongly match.
const PICK_WORLD_MAX = 700;
const MAX_SELECT = 24; // WC3 control-group / selection cap
// Neutral Passive (WC3 player 15): shops, taverns, labs, merchants, fountains,
// critters. Owner < 0 (grey minimap, never a player), a distinct team, and the
// sim's `neutralPassive` flag makes them non-hostile with a yellow ring.
const NEUTRAL_PASSIVE_OWNER = -1;
const NEUTRAL_PASSIVE_TEAM = -2;

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
  private sounds: SoundBoard | null = null; // unit voice lines (set by the host)
  private lastVoiceId: number | null = null; // last single unit that spoke (for What→Pissed escalation)
  private voiceStreak = 0; // consecutive re-clicks of that same unit
  private lastIdleWorker: number | null = null; // last idle worker selected via the badge/F8/~ cycle
  private groups = new Map<string, number[]>(); // control groups "0".."9" → ordered member sim ids
  private localPlayer = 0; // owner whose units a drag-box selects
  private localTeam = 0; // team whose combined sight reveals the fog of war
  // Viewer instances the RTS drives visibility for (seeded neutrals + creeps). The
  // map renderer skips these when it fog-hides the remaining static map widgets, so
  // the two systems never fight over the same instance. Populated once at seed time.
  private seededInstances = new Set<unknown>();
  private vision!: VisionMap; // per-team fog-of-war grid (built in the constructor)
  private visionAccum = 1; // seconds since the last vision rebuild (>interval → rebuild on first tick)
  private hovered: number | null = null;
  private hoveredMine: number | null = null; // a gold mine under the cursor (neutral)
  private previewIds: number[] = []; // units under the live drag-box (marquee preview rings)
  private neutralPositions: Array<{ x: number; y: number }> = []; // Neutral Passive sites (from the doo)
  private creepData: Array<{ x: number; y: number; aggro: number }> = []; // Neutral Hostile guard/aggro data (from the doo)
  private seeded = false;
  private nextId = 1;
  private hpBars: HpBar[] = []; // pool, one shown per visible unit each frame
  // Corpses adopt the dead unit's model instance and sequence it through Death →
  // Decay Flesh → Decay Bone in place, holding the bones until the sim corpse
  // decays (88s). `corpseId` links to the sim corpse so a spell that raises it
  // (Resurrection/Raise Dead) can remove the model at once; -1 = no corpse, so the
  // model just vanishes when its Death clip ends. `phaseT` = seconds in the phase.
  private corpses: Array<{ instance: Instance; corpseId: number; anims: AnimSet; phaseT: number; phase: "death" | "flesh" | "bone" }> = [];
  private flashRequests: Array<{ x: number; y: number; z: number; radius: number; color: [number, number, number]; sizeToRadius: boolean }> = [];
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
    private abilities: AbilityRegistry,
  ) {
    this.sim = new SimWorld(grid, 1, this.abilities); // the ability registry powers casting/learning/auras
    // Fog-of-war grid, aligned to the same world origin as the pathing grid and
    // spanning the whole map (pathing is 32-unit cells; span = cells × 32).
    const [vox, voy] = grid.origin;
    this.vision = new VisionMap(vox, voy, grid.width * PATHING_CELL, grid.height * PATHING_CELL);
  }

  dispose(): void {
    for (const b of this.hpBars) b.root.remove();
    this.hpBars = [];
  }

  /** Which player's units a drag-box selects (set at melee start). */
  setLocalPlayer(id: number): void {
    this.localPlayer = id;
  }

  /** Which team's combined sight lifts the fog of war (allies share vision). */
  setLocalTeam(team: number): void {
    this.localTeam = team;
  }

  /** The fog-of-war grid — read by the minimap (HUD) and the 3D fog overlay. */
  getVision(): VisionMap {
    return this.vision;
  }

  /** True if the RTS drives this viewer instance's fog visibility (seeded neutral
   *  shop or creep). The map renderer skips these when fog-hiding static widgets. */
  managesViewerInstance(inst: unknown): boolean {
    return this.seededInstances.has(inst);
  }

  /** `iseedeadpeople`: reveal the whole map (toggle). A pure override — turning it
   *  back off restores the real fog you'd actually explored. */
  setRevealAll(on: boolean): void {
    this.vision.setRevealAll(on);
  }

  /** Lobby "start explored": reveal the whole map as grey terrain memory, keeping
   *  live fog (current sight stays lit, enemy movement in the grey stays hidden). */
  exploreAll(): void {
    this.vision.exploreAll();
  }
  toggleRevealAll(): boolean {
    const on = !this.vision.revealed;
    this.vision.setRevealAll(on);
    return on;
  }

  /** Rebuild the "currently visible" fog layer from this team's live sight. Each
   *  friendly unit reveals a circle of its day- or night-sight radius; buildings
   *  and allies count too. Neutral shops grant no vision. Throttled (see tick). */
  private updateVision(): void {
    const day = this.sim.isDay;
    this.vision.beginFrame();
    for (const u of this.sim.units.values()) {
      if (u.neutralPassive) continue; // shops/critters don't scout for you
      if (u.team !== this.localTeam) continue; // only your team's units reveal
      const r = (day ? u.sightDay : u.sightNight) || u.sightDay || 800;
      this.vision.reveal(u.x, u.y, r, u.flying); // flyers see over terrain/trees
    }
  }

  /** Install the fog's line-of-sight height field + tree blockers, so vision is
   *  shadowed by high ground and treelines. Called once the map's trees are seeded.
   *  `cliffHeightAt` is the CLIFF-LEVEL sampler (makeCliffLevelSampler), not the full
   *  terrain height — only real cliff levels block WC3 sight, not rolling groundHeight
   *  (see hiveworkshop "About high ground advantage" #255594). */
  initVisionBlockers(cliffHeightAt: HeightSampler): void {
    this.vision.setHeightField((x, y) => cliffHeightAt(x, y));
    for (const tree of this.sim.trees.values()) this.vision.addTreeBlocker(tree.x, tree.y);
  }

  /** A tree was felled — it stops blocking sight (harvesting can open a sight line). */
  onTreeFelled(x: number, y: number): void {
    this.vision.removeTreeBlocker(x, y);
  }

  /** Should this unit's model be hidden by the fog of war right now? Your own team
   *  is always visible. Enemy/neutral STRUCTURES persist once explored (WC3 shows
   *  the last-seen building greyed in fog); mobile units and critters vanish unless
   *  currently in sight — "concealing enemy movements". */
  private fogHides(u: SimUnit): boolean {
    if (this.vision.revealed) return false;
    if (u.team === this.localTeam && !u.neutralPassive) return false;
    if (u.building != null) {
      const [cx, cy] = this.vision.worldToCell(u.x, u.y);
      return !this.vision.isExplored(cx, cy);
    }
    return this.vision.stateAt(u.x, u.y) !== FogState.Visible;
  }

  /** Apply the combined visibility decision (gold-mine + fog) to one render entry,
   *  toggling the instance and firing the mine-entry deselect side-effect once. */
  private applyVisibility(e: Entry, u: SimUnit): void {
    if (u.inMine !== e.inMine) {
      e.inMine = u.inMine;
      if (u.inMine) {
        this.deselect(e.simId); // a worker entering a mine drops out of the selection
        if (this.hovered === e.simId) this.hovered = null;
      }
    }
    const hide = u.inMine || this.fogHides(u);
    if (hide !== e.hidden) {
      e.hidden = hide;
      if (hide) {
        e.unit.instance.hide();
        if (this.hovered === e.simId) this.hovered = null;
      } else {
        e.unit.instance.show();
      }
    }
    if (!hide) this.applyFogTint(e, u);
  }

  /** Dim an enemy/neutral BUILDING that's shown from fog memory (last-seen, out of
   *  current sight) to the same grey as the ground veil — WC3 greys remembered
   *  structures. Own units and anything currently in sight stay full colour; mobile
   *  enemy units never reach here (fogHides already hides them out of sight). Tint
   *  multiplies the model's own base colour so a unit's team/UnitData tint survives. */
  private applyFogTint(e: Entry, u: SimUnit): void {
    const inst = e.unit.instance;
    if (!inst.setVertexColor) return;
    let b = 1;
    if (!this.vision.revealed && u.team !== this.localTeam && this.vision.stateAt(u.x, u.y) !== FogState.Visible) {
      b = FOG_EXPLORED_BRIGHT; // remembered-but-not-seen → half-bright grey
    }
    if (e.fogTintB === b) return; // unchanged since last tick
    e.fogTintB = b;
    if (!e.baseColor) {
      const c = inst.vertexColor;
      e.baseColor = c ? new Float32Array([c[0], c[1], c[2], c[3]]) : new Float32Array([1, 1, 1, 1]);
    }
    const base = e.baseColor;
    inst.setVertexColor([base[0] * b, base[1] * b, base[2] * b, base[3]]);
  }

  /** Wire the voice/sound board (owned by the host, which has the VFS). */
  setSoundBoard(sounds: SoundBoard | null): void {
    this.sounds = sounds;
  }

  /** Play the focused unit's selection voice — "What", escalating to "Pissed"
   *  after PISSED_AFTER consecutive re-clicks of the SAME single unit. Only your
   *  own units talk back (enemy/neutral clicks are silent, like WC3). */
  private announceSelection(): void {
    if (!this.sounds || this.primary === null) return;
    const e = this.byId.get(this.primary);
    const u = this.sim.units.get(this.primary);
    if (!e || !u || u.owner !== this.localPlayer) return;
    const def = this.registry.get(e.typeId);
    if (!def?.soundSet) return;
    const single = this.selected.size === 1;
    if (single && this.primary === this.lastVoiceId) {
      this.voiceStreak++;
    } else {
      this.voiceStreak = 0;
      this.lastVoiceId = single ? this.primary : null;
    }
    const cat: SoundCategory = single && this.voiceStreak >= PISSED_AFTER ? "Pissed" : "What";
    this.sounds.play(def.soundSet, cat);
  }

  /** Play weapon-impact SFX for every hit landed this tick (attacker's weapon
   *  material vs target's armour material) plus lumber-chop SFX (worker's 2nd-weapon
   *  material vs Wood) — all sourced from the game's combat sounds. */
  private playImpacts(): void {
    if (!this.sounds) return;
    for (const h of this.sim.drainHits()) {
      const atk = this.registry.get(this.byId.get(h.attackerId)?.typeId ?? "");
      const tgt = this.registry.get(this.byId.get(h.targetId)?.typeId ?? "");
      if (!atk) continue;
      const tu = this.sim.units.get(h.targetId); // impact rings out at the struck unit
      const at = tu ? { x: tu.x, y: tu.y, z: this.heightAt(tu.x, tu.y) } : undefined;
      if (atk.weaponSound && atk.weaponSound !== "_" && tgt?.armorSound) {
        this.sounds.playImpact(atk.weaponSound, tgt.armorSound, at); // melee: material clang
      } else if (atk.missileArt) {
        this.sounds.playMissile(atk.missileArt, "impact", at); // ranged: the missile's own impact sound
      }
    }
    for (const workerId of this.sim.drainChops()) {
      const def = this.registry.get(this.byId.get(workerId)?.typeId ?? "");
      const w = this.sim.units.get(workerId);
      const at = w ? { x: w.x, y: w.y, z: this.heightAt(w.x, w.y) } : undefined;
      if (def?.lumberSound) this.sounds.playImpact(def.lumberSound, "Wood", at); // trees are "Wood" armour
    }
  }

  /** Play the focused unit's order acknowledgement ("Yes" or "YesAttack"). */
  private ack(attack: boolean): void {
    if (!this.sounds || this.primary === null) return;
    const e = this.byId.get(this.primary);
    const u = this.sim.units.get(this.primary);
    if (!e || !u || u.owner !== this.localPlayer || u.building) return; // buildings don't voice orders
    const def = this.registry.get(e.typeId);
    if (def?.soundSet) this.sounds.play(def.soundSet, attack ? "YesAttack" : "Yes");
  }

  /** Register the world positions of Neutral Passive entities (from the map's
   *  war3mapUnits.doo, player 15). trySeed matches rendered units to these and
   *  seeds them as non-hostile, yellow-ringed selectables. */
  setNeutralPassive(positions: Array<{ x: number; y: number }>): void {
    this.neutralPositions = positions;
  }

  private isNeutralPassiveAt(x: number, y: number): boolean {
    for (const p of this.neutralPositions) if (Math.abs(p.x - x) < 48 && Math.abs(p.y - y) < 48) return true;
    return false;
  }

  /** Register the world positions + per-instance target-acquisition of Neutral
   *  Hostile creeps (from war3mapUnits.doo, player 12+). trySeed matches each
   *  rendered creep to this to set its guard post and aggro range. */
  setCreepData(data: Array<{ x: number; y: number; aggro: number }>): void {
    this.creepData = data;
  }

  /** The placed creep's editor target-acquisition at a position (-1 if none):
   *  -1 = use the unit's default acquisition, -2 = "Camp", >0 = a custom range. */
  private creepAggroAt(x: number, y: number): number {
    for (const p of this.creepData) if (Math.abs(p.x - x) < 48 && Math.abs(p.y - y) < 48) return p.aggro;
    return -1;
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

  /** A unit's selection priority (UnitData `prio`) — heroes 9, Footman 6, … 0. */
  private priorityOf(id: number): number {
    const e = this.byId.get(id);
    return e ? this.registry.get(e.typeId)?.priority ?? 0 : 0;
  }

  /** Distinct group keys, ordered the way WC3 orders selection sub-groups: by unit
   *  priority (UnitData `prio`) descending, so heroes lead, then stable by the
   *  order units were added for ties. Drives the icon grid, Tab cycle, and primary. */
  private orderedGroups(): string[] {
    const keys: string[] = [];
    const prio = new Map<string, number>();
    const seq = new Map<string, number>();
    let i = 0;
    for (const id of this.selected) {
      const k = this.groupKeyOf(id);
      if (k && !prio.has(k)) {
        prio.set(k, this.priorityOf(id));
        seq.set(k, i);
        keys.push(k);
      }
      i++;
    }
    return keys.sort((a, b) => (prio.get(b)! - prio.get(a)!) || (seq.get(a)! - seq.get(b)!));
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
    this.announceSelection();
  }

  /** Cycle focus to the next (Tab) or previous (Shift+Tab) sub-group. */
  cycleFocus(reverse = false): void {
    const groups = this.orderedGroups();
    if (groups.length <= 1) return;
    const n = groups.length;
    const i = groups.indexOf(this.focusedKey);
    this.focusedKey = groups[(((i + (reverse ? -1 : 1)) % n) + n) % n];
    this.primary = this.firstOfGroup(this.focusedKey);
    this.announceSelection();
  }

  /** Select ONLY this unit (double-clicking its icon in the multi-select grid). */
  selectSingle(simId: number): void {
    if (!this.sim.units.has(simId)) return;
    this.selected.clear();
    this.selectedMine = null;
    this.selected.add(simId);
    this.primary = simId;
    this.focusedKey = this.groupKeyOf(simId);
    this.voiceStreak = 0;
    this.announceSelection();
  }

  /** If a spell/attack is armed, apply it to a unit clicked in the HUD group grid
   *  (so skills can be targeted through the console). Returns true if consumed. */
  tryTargetArmedAt(simId: number): boolean {
    if (this.orderMode === "cast" && this.armedCast) {
      const cast = this.armedCast;
      this.orderMode = null;
      this.armedCast = null;
      if (cast.target === "unit") this.castFromSelection(cast.code, simId, 0, 0);
      return true; // point-target spells can't aim at a single icon — just disarm
    }
    if (this.orderMode === "attack") {
      this.orderMode = null;
      const t = this.sim.units.get(simId);
      if (t && simId !== this.primary) {
        for (const id of this.selected) if (id !== simId) this.order(id, { kind: "attack", targetId: simId, force: true }, false);
        this.ack(true);
      }
      return true;
    }
    return false;
  }

  /** A worker of the local player that's doing nothing (not gathering, building,
   *  moving, or constructing) — the ones the idle-worker button/F8/~ cycle. */
  private isIdleWorker(u: SimUnit | undefined): u is SimUnit {
    return !!u && u.owner === this.localPlayer && !!u.worker && u.order === "idle" && !u.buildPending && u.constructing === 0 && !u.inMine;
  }

  private idleWorkerIds(): number[] {
    const out: number[] = [];
    for (const e of this.entries) if (this.isIdleWorker(this.sim.units.get(e.simId))) out.push(e.simId);
    return out.sort((a, b) => a - b); // stable cycle order
  }

  /** Count of idle workers (drives the HUD idle-worker badge). */
  idleWorkerCount(): number {
    let n = 0;
    for (const e of this.entries) if (this.isIdleWorker(this.sim.units.get(e.simId))) n++;
    return n;
  }

  /** Select the NEXT idle worker (cycling), replacing the current selection.
   *  Returns true if one was selected (host then centres the camera on it). */
  cycleIdleWorker(): boolean {
    const idle = this.idleWorkerIds();
    if (!idle.length) return false;
    let idx = 0;
    if (this.lastIdleWorker !== null) {
      const cur = idle.indexOf(this.lastIdleWorker);
      idx = cur >= 0 ? (cur + 1) % idle.length : 0;
    }
    const id = idle[idx];
    this.lastIdleWorker = id;
    this.selected.clear();
    this.selected.add(id);
    this.selectedMine = null;
    this.refocus();
    this.announceSelection();
    return true;
  }

  // --- control groups (keys 1-0) --------------------------------------------

  /** Own selection members, partitioned units-vs-buildings; units WIN a mixed pick
   *  (WC3 exclusion rule: a group is units XOR buildings). Capped at MAX_SELECT. */
  private ownSelectionByKind(): { kind: "unit" | "building" | null; ids: number[] } {
    const units: number[] = [];
    const buildings: number[] = [];
    for (const id of this.selected) {
      const u = this.sim.units.get(id);
      if (!u || u.owner !== this.localPlayer) continue;
      (u.building ? buildings : units).push(id);
    }
    if (units.length) return { kind: "unit", ids: units.slice(0, MAX_SELECT) };
    if (buildings.length) return { kind: "building", ids: buildings.slice(0, MAX_SELECT) };
    return { kind: null, ids: [] };
  }

  /** Living members of a group, pruning any that died (lazy cleanup). */
  private livingGroup(key: string): number[] {
    const g = this.groups.get(key);
    if (!g) return [];
    const alive = g.filter((id) => this.sim.units.has(id));
    if (alive.length !== g.length) this.groups.set(key, alive);
    return alive;
  }

  /** Ctrl+N: bind the current own selection to control group N (overwrite). An
   *  empty selection leaves the existing group untouched (WC3). */
  assignGroup(key: string): void {
    const { ids } = this.ownSelectionByKind();
    if (ids.length) this.groups.set(key, ids);
  }

  /** Shift+N: append the current selection to group N, keeping the group's kind
   *  (units XOR buildings) and the MAX_SELECT cap, skipping duplicates. */
  appendGroup(key: string): void {
    const existing = this.livingGroup(key);
    const sel = this.ownSelectionByKind();
    const kind = existing.length ? (this.sim.units.get(existing[0])?.building ? "building" : "unit") : sel.kind;
    if (!kind) return;
    const merged = [...existing];
    const seen = new Set(existing);
    for (const id of this.selected) {
      if (merged.length >= MAX_SELECT) break;
      const u = this.sim.units.get(id);
      if (!u || u.owner !== this.localPlayer || seen.has(id)) continue;
      if ((u.building ? "building" : "unit") !== kind) continue;
      merged.push(id);
      seen.add(id);
    }
    if (merged.length) this.groups.set(key, merged);
  }

  /** N (tap): recall group N as the active selection. Returns false if empty. */
  recallGroup(key: string): boolean {
    const ids = this.livingGroup(key);
    if (!ids.length) return false;
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.selectedMine = null;
    this.refocus();
    this.announceSelection();
    return true;
  }

  /** F1/F2/F3: select the (index+1)-th of the local player's heroes (stable order),
   *  independent of the numbered control groups. Returns false if there's none. */
  selectHero(index: number): boolean {
    const heroes: number[] = [];
    for (const e of this.entries) {
      if (!e.isHero) continue;
      const u = this.sim.units.get(e.simId);
      if (u && u.owner === this.localPlayer) heroes.push(e.simId);
    }
    heroes.sort((a, b) => a - b);
    const id = heroes[index];
    if (id === undefined) return false;
    this.selected.clear();
    this.selected.add(id);
    this.selectedMine = null;
    this.refocus();
    this.announceSelection();
    return true;
  }

  /** Centre of the current selection (for the control-group double-tap camera jump). */
  selectionCentroid(): [number, number] | null {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const id of this.selected) {
      const u = this.sim.units.get(id);
      if (u) {
        sx += u.x;
        sy += u.y;
        n++;
      }
    }
    return n ? [sx / n, sy / n] : this.selectedPosition();
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
      const loc = unit.instance.localLocation;
      const def = this.registry.get(unit.row?.string("unitid") ?? "");
      // Neutral Passive (shops/taverns/labs/merchants/fountains/critters): seed
      // it as a static, non-hostile, yellow-ringed selectable — even though it's
      // a building with no walk clip.
      if (this.isNeutralPassiveAt(loc[0], loc[1])) {
        this.seedNeutral(unit, def, loc);
        continue;
      }
      const movetp = unit.row?.string("movetp");
      if (!movetp || movetp === "_" || movetp === "none") continue; // buildings/immovable
      const seqs = unit.instance.model.sequences;
      if (!seqs.some((s) => /walk/i.test(s.name))) continue; // no walk → treat as static
      const anims = buildAnimSet(seqs);
      const simId = this.nextId++;
      const su = this.sim.add(
        {
          id: simId,
          owner: -1, // map-placed units are neutral (creeps)
          team: -1,
          race: def?.race ?? "",
          typeId: def?.id ?? "",
          x: loc[0],
          y: loc[1],
          facing: quatToZ(unit.instance.localRotation),
          speed: def?.speed || 270, // real movement speed from UnitBalance.slk
          turnRate: def?.turnRate ?? 0.5,
          radius: def?.collision || 16,
          flying: def?.moveType === "fly",
          sightDay: def?.sightDay || 1400,
          sightNight: def?.sightNight || def?.sightDay || 800,
          hp: def?.hitPoints || 100,
          maxHp: def?.hitPoints || 100,
          mana: def?.mana ?? 0,
          maxMana: def?.mana ?? 0,
          armor: def?.armor ?? 0,
          armorType: def?.armorType ?? "",
          weapon: def ? weaponFor(def) : null,
          worker: null,
          depotGold: false,
          depotLumber: false,
        },
        null,
        { level: def?.level ?? 0, mechanical: def?.classification.includes("mechanical") ?? false },
      );
      // Map-placed movable units are Neutral Hostile creeps: give them guard AI —
      // home post at the spawn, an aggro range from the map's per-creep target-
      // acquisition (falling back to the unit's own acquire range), and the
      // night-sleep flag from unit data. This is what makes them leash back home
      // after a chase and doze at night instead of chasing forever.
      su.isCreep = true;
      su.guardX = loc[0];
      su.guardY = loc[1];
      su.guardFacing = su.facing;
      const aggro = this.creepAggroAt(loc[0], loc[1]);
      su.aggroRange = aggro > 0 ? aggro : su.weapon?.acquire ?? def?.acquireRange ?? 0;
      su.canSleep = def?.canSleep ?? false;
      this.seededInstances.add(unit.instance); // RTS drives this creep's fog visibility
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
        inMine: false,
        curSeq: -1,
        lastSwingSeq: -1,
        lastChopSeq: -1,
        castAnimT: 0,
        moveEma: 1,
      };
      this.entries.push(entry);
      this.byId.set(simId, entry);
    }
    this.seeded = true;
  }

  /** Seed a Neutral Passive entity (shop/tavern/lab/merchant/fountain/critter):
   *  a static, non-hostile sim unit with the yellow ring. We don't drive its
   *  instance in tick() (the map viewer already renders it) — this record just
   *  makes it hoverable/selectable and rings it. */
  private seedNeutral(unit: MapUnit, def: UnitDef | undefined, loc: Float32Array): void {
    const simId = this.nextId++;
    this.seededInstances.add(unit.instance); // RTS drives this shop/critter's fog visibility
    const isBuilding = def?.isBuilding ?? false;
    // Buildings get a (complete) building state so pickAt/rings treat them as
    // structures (footprint-sized ring, lowered collider); their footprint is
    // already stamped by the map loader, so speed 0 → no cell reservation here.
    const building: BuildingState | null = isBuilding
      ? { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: loc[0], rallyY: loc[1], rallyKind: "point", rallyTargetId: 0, producesUnits: false }
      : null;
    const u = this.sim.add(
      {
        id: simId,
        owner: NEUTRAL_PASSIVE_OWNER,
        team: NEUTRAL_PASSIVE_TEAM,
        race: def?.race ?? "",
        typeId: def?.id ?? "",
        x: loc[0],
        y: loc[1],
        facing: quatToZ(unit.instance.localRotation),
        speed: 0, // static (never wanders in our sim)
        turnRate: def?.turnRate ?? 0.5,
        radius: def?.collision || 16,
        flying: false,
        sightDay: def?.sightDay || 1400,
        sightNight: def?.sightNight || def?.sightDay || 800,
        hp: def?.hitPoints || 100,
        maxHp: def?.hitPoints || 100,
        mana: 0,
        maxMana: 0,
        armor: def?.armor ?? 0,
        armorType: def?.armorType ?? "",
        weapon: null,
        worker: null,
        depotGold: false,
        depotLumber: false,
      },
      building,
    );
    u.neutralPassive = true;
    const entry: Entry = {
      simId,
      unit,
      anims: buildAnimSet(unit.instance.model.sequences),
      moveHeight: 0,
      selRadius: (def?.selScale || 1) * SEL_RADIUS_PER_SCALE,
      typeId: def?.id ?? unit.row?.string("unitid") ?? "",
      race: def?.race ?? "",
      name: def?.name ?? unit.row?.string("unitid") ?? "Neutral",
      foodUsed: 0,
      foodMade: 0,
      isHero: false,
      level: 0,
      modelPath: def?.model ?? "",
      baseScale: def?.modelScale || 1,
      curScale: def?.modelScale || 1,
      ...findBirthFields(unit.instance.model.sequences),
      hidden: false,
      inMine: false,
      curSeq: -1,
      lastSwingSeq: -1,
      lastChopSeq: -1,
      castAnimT: 0,
      moveEma: 1,
    };
    this.entries.push(entry);
    this.byId.set(simId, entry);
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
      ? { constructionLeft: constructionTime, buildTimeTotal: constructionTime || 1, builderIds: [], goldCost: def.goldCost, lumberCost: def.lumberCost, queue: [], rallyX: x, rallyY: y - 200, rallyKind: "point", rallyTargetId: 0, producesUnits: trainsFor(def.id).length > 0 }
      : null;
    const hero: HeroInit | undefined = def.isHero
      ? { level: Math.max(1, def.level), str: def.strength, agi: def.agility, int: def.intelligence, strPerLevel: def.strPerLevel, agiPerLevel: def.agiPerLevel, intPerLevel: def.intPerLevel, primaryAttr: (def.primaryAttr as "STR" | "AGI" | "INT") || "" }
      : undefined;
    this.sim.add(
      {
        id: simId,
        owner,
        team,
        race: def.race,
        typeId: def.id,
        x,
        y,
        facing,
        speed: def.speed,
        turnRate: def.turnRate,
        radius: def.collision || 16,
        flying: def.moveType === "fly",
        sightDay: def.sightDay || 1400,
        sightNight: def.sightNight || def.sightDay || 800,
        hp: constructionTime > 0 ? (def.hitPoints || 100) * 0.1 : def.hitPoints || 100,
        maxHp: def.hitPoints || 100,
        mana: def.mana,
        maxMana: def.mana,
        armor: def.armor,
        armorType: def.armorType,
        weapon: weaponFor(def),
        worker,
        depotGold: DEPOT_IDS.has(def.id) && def.id !== "hlum", // lumber mill: lumber only
        depotLumber: DEPOT_IDS.has(def.id),
      },
      building,
      { hero, abilities: this.buildInitialAbilities(def), mechanical: def.classification.includes("mechanical"), level: def.level },
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
      inMine: false,
      curSeq: -1,
      lastSwingSeq: -1,
      lastChopSeq: -1,
      castAnimT: 0,
      moveEma: 1,
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

  /** The ability list a unit spawns with. Innate abilities we implement (Priest
   *  Heal, Sorceress Slow, …) start at rank 1; a hero's learnable abilities are
   *  present at rank 0 (spent up with skill points as it levels). Abilities whose
   *  base `code` we don't handle are dropped so they never make a dead button. */
  private buildInitialAbilities(def: UnitDef): SimAbility[] {
    const out: SimAbility[] = [];
    for (const id of def.abilities) {
      const a = this.abilities.get(id);
      if (!a || !KNOWN_ABILITIES[a.code]) continue; // skip inventory/other passives
      out.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: def.autoAbility === id });
    }
    for (const id of def.heroAbilities) {
      const a = this.abilities.get(id);
      if (!a || !KNOWN_ABILITIES[a.code]) continue; // only slots we can actually cast/apply
      out.push({ id, code: a.code, level: 0, cooldownLeft: 0, autocastOn: false });
    }
    return out;
  }

  tick(dt: number): void {
    this.trySeed();
    this.sim.tick(dt);
    this.playImpacts(); // BEFORE deaths — a killed target's entry is still around to read its armour
    for (const id of this.sim.drainDeaths()) this.onDeath(id);
    for (const id of this.sim.drainRemovals()) this.onRemove(id);
    this.tickCorpses(dt);
    if (this.hovered !== null && !this.byId.has(this.hovered)) this.hovered = null;
    if (this.hoveredMine !== null && !this.sim.mines.has(this.hoveredMine)) this.hoveredMine = null;
    // Fog of war: rebuild the "currently visible" layer a few times a second — WC3
    // refreshes fog periodically, not every frame, and this keeps circle-stamping
    // cheap. The initial accumulator > interval forces a rebuild on the first tick.
    this.visionAccum += dt;
    if (this.visionAccum >= 0.1) {
      this.visionAccum = 0;
      this.updateVision();
    }
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId)!;
      if (u.neutralPassive) {
        this.applyVisibility(e, u); // static & viewer-rendered, but fog still hides/reveals it
        continue;
      }
      this.loc[0] = u.x;
      this.loc[1] = u.y;
      this.loc[2] = this.heightAt(u.x, u.y) + e.moveHeight; // fly height for air units
      e.unit.instance.setLocation(this.loc);
      setZQuat(this.quat, u.facing);
      e.unit.instance.setRotation(this.quat);
      // Workers inside a gold mine vanish; enemy units vanish in the fog of war.
      this.applyVisibility(e, u);
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
      // A materializing summon holds its birth clip (sim `spawning`) — don't let
      // the picker override it until it can act.
      if (u.spawning > 0) continue;
      // Hold a cast animation for its brief window so the throw/slam/spell gesture
      // plays out instead of being overwritten by the stand/attack picker.
      if (e.castAnimT > 0) {
        e.castAnimT -= dt;
        continue;
      }
      // Attacking is swing-driven: play a (random) attack clip ONCE per swing so
      // the strike gesture matches the damage-point-timed hit/projectile, and
      // units with several attack animations vary them shot to shot. Between
      // swings the LOOP_NEVER clip holds; everything else loops normally.
      const attacking = u.inCombat && !u.moving && e.anims.attack >= 0;
      // Chopping is chop-driven, like the attack swing: re-trigger the "Attack
      // Lumber" clip ONCE per chop so the swing stays in phase with the chop SFX
      // (a free-running loop drifted out of sync with the sound).
      const chopping = u.working && u.order === "harvest" && !u.moving && e.anims.chopLumber >= 0;
      if (chopping) {
        if (u.chopSeq !== e.lastChopSeq || e.curSeq !== e.anims.chopLumber) {
          e.lastChopSeq = u.chopSeq;
          e.curSeq = e.anims.chopLumber;
          e.unit.state = WALK;
          e.unit.instance.setSequence(e.anims.chopLumber);
          e.unit.instance.setSequenceLoopMode(LOOP_NEVER);
        }
      } else if (attacking) {
        if (u.swingSeq !== e.lastSwingSeq || !e.anims.attackVariants.includes(e.curSeq)) {
          e.lastSwingSeq = u.swingSeq;
          const vs = e.anims.attackVariants;
          const pick = vs.length > 1 ? vs[(Math.random() * vs.length) | 0] : e.anims.attack;
          e.curSeq = pick;
          e.unit.state = WALK; // non-stand state prevents mdx-m3-viewer's auto-stand
          e.unit.instance.setSequence(pick);
          e.unit.instance.setSequenceLoopMode(LOOP_NEVER);
        }
      } else {
        // Smooth the actual/expected displacement so the walk clip only plays
        // when the unit is really making progress — a unit wedged in a crowd
        // (moving ordered, but barely inching) stands instead of jogging in place.
        const expected = u.speed * dt;
        const ratio = expected > 1e-3 ? Math.hypot(u.x - u.prevX, u.y - u.prevY) / expected : 1;
        e.moveEma += (Math.min(ratio, 1) - e.moveEma) * MOVE_EMA_ALPHA;
        const effMoving = u.moving && e.moveEma >= MOVE_ANIM_MIN_RATIO;
        const seq = this.pickSequence(e.anims, u, effMoving);
        if (seq !== e.curSeq && seq >= 0) {
          e.curSeq = seq;
          e.unit.state = seq === e.anims.stand ? IDLE : WALK;
          e.unit.instance.setSequence(seq);
          e.unit.instance.setSequenceLoopMode(LOOP_ALWAYS);
        }
      }
    }
    this.updateHealthBars();
  }

  /** The sim removed this unit: play its death animation, then decay the corpse
   *  (flesh → bone) in place until it's fully removed (see tickCorpses). */
  private onDeath(simId: number): void {
    const e = this.byId.get(simId);
    if (!e) return;
    // Death cry (all units, friend or foe — you hear the battlefield). Buildings
    // have no Death sound-set → resolves to nothing.
    const def = this.registry.get(e.typeId);
    // Death cry rings out from where the unit fell (its model's last location).
    const loc = e.unit.instance.localLocation;
    if (def?.soundSet) this.sounds?.play(def.soundSet, "Death", { x: loc[0], y: loc[1], z: loc[2] });
    this.byId.delete(simId);
    this.entries.splice(this.entries.indexOf(e), 1);
    this.deselect(simId);
    e.unit.state = WALK; // keep mdx-m3-viewer from overriding the death sequence
    if (e.anims.death >= 0) {
      e.unit.instance.setSequence(e.anims.death);
      e.unit.instance.setSequenceLoopMode(LOOP_NEVER);
      // Adopt the model as the corpse and decay it in place (see tickCorpses).
      // Link to the sim corpse this death created (if any) so a raise spell can
      // hide the model immediately and so the sim's 88s timer drives its removal.
      const corpse = [...this.sim.corpses.values()].find((c) => c.deadId === simId);
      this.corpses.push({ instance: e.unit.instance, corpseId: corpse?.id ?? -1, anims: e.anims, phaseT: 0, phase: "death" });
    } else {
      e.unit.instance.hide();
    }
  }

  /** The sim removed this unit WITHOUT a death (a cancelled building): drop it
   *  and hide its instance immediately — no death animation, no corpse. The
   *  renderer plays the cancel-explosion effect over the spot instead. */
  private onRemove(simId: number): void {
    const e = this.byId.get(simId);
    if (!e) return;
    this.byId.delete(simId);
    this.entries.splice(this.entries.indexOf(e), 1);
    this.deselect(simId);
    if (this.hovered === simId) this.hovered = null;
    e.unit.instance.hide();
  }

  /** Choose the animation sequence for a unit's current state, using the
   *  worker's carried resource so peasants walk/stand/chop with the right
   *  gold- and lumber-carrying clips. */
  private pickSequence(a: AnimSet, u: SimUnit, moving: boolean): number {
    const carry = u.worker
      ? u.worker.carryGold > 0
        ? "gold"
        : u.worker.carryLumber > 0
          ? "lumber"
          : null
      : null;
    // Movement wins over everything: a worker ordered to move mid-harvest walks
    // (with the right carry clip) instead of staying stuck in the chop pose.
    // `moving` is the *effective* move flag — a unit inching along in a crowd
    // reads as standing so it doesn't run in place (see the tick loop).
    if (moving) return carry === "gold" ? a.walkGold : carry === "lumber" ? a.walkLumber : a.walk;
    if (u.constructing || u.repair?.active) return a.build; // hammering (build/repair)
    // A building actively producing (a unit in its queue) runs its "Stand Work"
    // clip — the blacksmith hammers, the barracks stirs, etc. `build` resolves to
    // that clip for structures (and is -1 → no-op for ones that lack it).
    if (u.building && u.building.queue.length > 0) return a.build;
    // Only the ACTIVE chop plays the harvest swing — a worker merely holding
    // lumber while standing (its tree fell and it's about to return, so `working`
    // isn't cleared yet) shows the Stand Lumber pose, not the chop.
    if (u.working && u.order === "harvest") return a.chopLumber;
    if (u.inCombat) return a.attack;
    return carry === "gold" ? a.standGold : carry === "lumber" ? a.standLumber : a.stand;
  }

  private tickCorpses(dt: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      // Organic corpses are tracked in the sim so raise/consume spells can target
      // them; the sim removes the corpse 88s after death (or a spell raises it).
      // Once it's gone, drop the model too — the bones have decayed.
      const leavesCorpse = c.corpseId >= 0;
      const sc = leavesCorpse ? this.sim.corpses.get(c.corpseId) : undefined;
      if (leavesCorpse && (!sc || sc.raised)) {
        c.instance.hide();
        this.corpses.splice(i, 1);
        continue;
      }
      c.phaseT += dt;
      if (c.phase === "death") {
        // Wait out the death animation, then either vanish (no corpse) or begin
        // the flesh-decay stage.
        if (c.phaseT < this.seqDuration(c.instance, c.anims.death, DEATH_CLIP_FALLBACK)) continue;
        if (!leavesCorpse) {
          c.instance.hide();
          this.corpses.splice(i, 1);
          continue;
        }
        this.enterDecay(c, "flesh");
      } else if (c.phase === "flesh") {
        // Play the flesh-rot clip at 2x: nudge the instance an extra frame-step
        // (the viewer's baseUpdate advances it once more the same frame → double
        // rate), and end the phase at HALF the clip length so the bones follow the
        // moment the sped-up rot visually finishes. dt is seconds; `frame` is in
        // MDX ms, so dt*1000 exactly matches the viewer's own per-frame step.
        c.instance.frame += dt * 1000;
        if (c.phaseT >= this.seqDuration(c.instance, c.anims.decayFlesh, DECAY_CLIP_FALLBACK) / 2) {
          this.enterDecay(c, "bone");
        }
      }
      // "bone": the settled bones hold their final frame until the sim corpse
      // decays (removed at the top of the loop) — nothing to do per frame.
    }
  }

  /** Move a corpse into its flesh/bone decay stage, playing the matching clip if
   *  the model has one. A model missing the flesh clip skips straight to bone; a
   *  model missing both just holds whatever frame it ended on. */
  private enterDecay(c: { instance: Instance; anims: AnimSet; phase: "death" | "flesh" | "bone"; phaseT: number }, stage: "flesh" | "bone"): void {
    const seq = stage === "flesh" ? c.anims.decayFlesh : c.anims.decayBone;
    if (seq >= 0) {
      c.instance.setSequence(seq);
      c.instance.setSequenceLoopMode(LOOP_NEVER); // play once, then hold the pose
      c.phase = stage;
      c.phaseT = 0;
    } else if (stage === "flesh") {
      this.enterDecay(c, "bone"); // no flesh clip → straight to bones
    } else {
      c.phase = "bone"; // no bone clip either → hold the current frame as "bones"
      c.phaseT = 0;
    }
  }

  /** A sequence's play length in seconds (from its MDX interval, in ms), or
   *  `fallback` when the clip is absent (index < 0) or carries no interval. */
  private seqDuration(inst: Instance, idx: number, fallback: number): number {
    if (idx < 0) return fallback;
    const iv = inst.model.sequences[idx]?.interval;
    if (!iv || iv.length < 2) return fallback;
    const dur = (iv[1] - iv[0]) / 1000;
    return dur > 0 ? dur : fallback;
  }

  /** Play a caster's spell animation once (matched to the ability's anim tags,
   *  e.g. Storm Bolt "throw", Thunder Clap "slam", else "Spell"/"Attack"). */
  playCastAnim(casterId: number, code: string): void {
    const e = this.byId.get(casterId);
    if (!e) return;
    const def = this.abilityDefByCode(code);
    const tags = def?.animNames ?? [];
    const names = e.anims.seqNames;
    const pick = (re: RegExp) => names.findIndex((n) => re.test(n));
    let seq = -1;
    // Prefer the more specific tag (throw/slam/channel) over the generic "spell".
    for (const tag of [...tags].reverse()) {
      if (tag === "spell") continue;
      seq = pick(new RegExp(`\\b${tag}\\b`, "i"));
      if (seq >= 0) break;
    }
    if (seq < 0) seq = pick(/spell/i);
    if (seq < 0) seq = e.anims.attack;
    if (seq < 0) return;
    e.unit.instance.setSequence(seq);
    e.unit.instance.setSequenceLoopMode(LOOP_NEVER);
    e.curSeq = seq;
    e.unit.state = WALK; // don't let the idle picker immediately override the cast
    e.castAnimT = CAST_ANIM_HOLD; // hold the clip for its brief window
  }

  private abilityDefByCode(code: string): AbilityDef | undefined {
    for (const a of this.abilities.all()) if (a.code === code) return a;
    return undefined;
  }

  /** A summoned/raised unit materializes: play its birth clip and lock it out of
   *  acting (sim `spawning`) until the clip finishes. No birth clip → acts at once. */
  beginSummonBirth(simId: number): void {
    const e = this.byId.get(simId);
    const u = this.sim.units.get(simId);
    if (!e || !u || e.birthSeq < 0) return;
    const durMs = e.birthEnd - e.birthStart;
    u.spawning = durMs > 0 ? durMs / 1000 : 1;
    e.unit.instance.setSequence(e.birthSeq);
    e.unit.instance.setSequenceLoopMode(LOOP_NEVER);
    e.unit.state = WALK; // keep the picker from auto-standing over the birth clip
    e.curSeq = e.birthSeq;
  }

  /** Left-click a unit selects it. Clicking empty ground does NOT deselect (WC3
   *  has no click-to-deselect — you keep your selection until you pick another).
   *  Modifiers (WC3): `additive` (Shift) adds the unit to the current selection
   *  (toggling it back out if it's already in); `sameType` (Ctrl / double-click)
   *  grabs every on-screen own unit of that type. */
  selectAt(cssX: number, cssY: number, mods: { additive?: boolean; sameType?: boolean } = {}): void {
    const id = this.pickAt(cssX, cssY);
    if (id !== null) {
      const u = this.sim.units.get(id);
      const e = this.byId.get(id);
      const ownMobile = !!u && !!e && u.owner === this.localPlayer && !u.building;
      // Shift + same-type (shift+ctrl-click or shift+double-click) ADDS the whole
      // on-screen type group to the current selection, mirroring WC3.
      if (mods.additive && mods.sameType && ownMobile) {
        this.selectByType(e!.typeId, true);
        return;
      }
      if (mods.additive) {
        // Already in the group → toggle it out. Otherwise add own mobile units
        // (up to the cap). A shift-click on anything else (enemy/neutral/building)
        // is ignored so a stray click never wipes the current selection.
        if (this.selected.has(id)) this.deselect(id);
        else if (ownMobile && this.selected.size < MAX_SELECT) {
          this.selected.add(id);
          this.selectedMine = null;
          this.refocus(this.focusedKey);
          this.announceSelection();
        }
        return;
      }
      if (mods.sameType && ownMobile) {
        this.selectByType(e!.typeId);
        return;
      }
      this.selected.clear();
      this.selected.add(id);
      this.selectedMine = null;
      this.refocus();
      this.announceSelection();
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

  /** Select every on-screen own mobile unit of a given type (Ctrl-click / double-
   *  click). WC3 limits this to what's visible, so off-screen kin are left out.
   *  `additive` (shift held) unions them into the current selection instead of
   *  replacing it. */
  private selectByType(typeId: string, additive = false): void {
    const picked: number[] = [];
    for (const e of this.entries) {
      if (e.typeId !== typeId || e.hidden) continue;
      const u = this.sim.units.get(e.simId);
      if (!u || u.owner !== this.localPlayer || u.building) continue;
      if (this.onScreen(u, e)) picked.push(e.simId);
    }
    if (!picked.length) return;
    if (!additive) this.selected.clear();
    for (const sid of picked) {
      if (this.selected.size >= MAX_SELECT) break;
      this.selected.add(sid);
    }
    this.selectedMine = null;
    this.refocus(additive ? this.focusedKey : "");
    this.announceSelection();
  }

  /** True if a unit currently projects inside the viewport (for same-type select). */
  private onScreen(u: SimUnit, e: Entry): boolean {
    const viewport = this.host.viewport();
    const dpr = this.dpr();
    const h = this.host.canvas.height;
    this.world[0] = u.x;
    this.world[1] = u.y;
    this.world[2] = this.heightAt(u.x, u.y) + e.moveHeight;
    this.host.camera.worldToScreen(this.screen, this.world, viewport);
    const sx = this.screen[0] / dpr;
    const sy = (h - this.screen[1]) / dpr;
    return sx >= 0 && sy >= 0 && sx <= this.host.canvas.clientWidth && sy <= this.host.canvas.clientHeight;
  }

  /** Drag-box: select all of the local player's mobile units whose on-screen
   *  position falls inside the rectangle (CSS px). Empty box keeps the group.
   *  `additive` (shift held) unions the boxed units into the current selection
   *  instead of replacing it — matching WC3's shift-drag. */
  /** Own entities whose screen position falls inside the CSS-space drag box, with
   *  WC3's box priority applied: mobile units win, so a building is only box-picked
   *  when the box catches NO units at all (drag a box over a unit + your town hall →
   *  just the unit). Shared by the live marquee preview and the commit on mouse-up
   *  so both agree exactly on what the box covers. */
  private unitsInBox(x0: number, y0: number, x1: number, y1: number): number[] {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const viewport = this.host.viewport();
    const dpr = this.dpr();
    const h = this.host.canvas.height;
    const units: number[] = [];
    const buildings: number[] = [];
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (!u || e.hidden) continue;
      if (u.owner !== this.localPlayer) continue; // own entities only
      this.world[0] = u.x;
      this.world[1] = u.y;
      this.world[2] = this.heightAt(u.x, u.y) + e.moveHeight;
      this.host.camera.worldToScreen(this.screen, this.world, viewport);
      const sx = this.screen[0] / dpr;
      const sy = (h - this.screen[1]) / dpr; // gl y-up → css y-down
      // Screen-space radius of the unit's selection circle (CSS px): project a
      // point offset by its radius and measure the pixel gap. The box then tests
      // against the unit's CIRCLE, not just its centre — so a tiny rectangle drawn
      // over a unit, or the box's border merely grazing one, still selects it
      // (before, the centre had to be strictly inside, so small boxes caught nothing).
      this.world2.set(this.world);
      this.world2[0] = u.x + Math.max(u.radius, e.selRadius);
      this.host.camera.worldToScreen(this.screen2, this.world2, viewport);
      const rCss = Math.hypot(this.screen2[0] - this.screen[0], this.screen2[1] - this.screen[1]) / dpr;
      // Circle-vs-rect: distance from the centre to the nearest point inside the box.
      const nx = sx < minX ? minX : sx > maxX ? maxX : sx;
      const ny = sy < minY ? minY : sy > maxY ? maxY : sy;
      if (Math.hypot(sx - nx, sy - ny) <= rCss) (u.building ? buildings : units).push(e.simId);
    }
    // Units take priority — buildings only when the box caught no units at all.
    return units.length ? units : buildings;
  }

  selectBox(x0: number, y0: number, x1: number, y1: number, additive = false): void {
    const picked = this.unitsInBox(x0, y0, x1, y1);
    if (picked.length === 0) return; // empty box: keep the current selection
    if (!additive) this.selected.clear();
    for (const id of picked) {
      if (this.selected.size >= MAX_SELECT) break; // WC3 cap
      this.selected.add(id);
    }
    this.selectedMine = null;
    this.refocus(additive ? this.focusedKey : "");
    this.announceSelection();
  }

  /** Update the live marquee preview: the units the drag-box currently covers get
   *  a green ring (via previewRings) so the player sees exactly who will be picked
   *  before releasing. Already-selected units are skipped — they keep their own
   *  selection ring, so an additive (Shift) drag shows the union without stacking. */
  setPreviewBox(x0: number, y0: number, x1: number, y1: number): void {
    this.previewIds = this.unitsInBox(x0, y0, x1, y1).filter((id) => !this.selected.has(id));
  }

  clearPreviewBox(): void {
    if (this.previewIds.length) this.previewIds = [];
  }

  /** Pointer move: show the ring + HP bar under the unit (or gold mine) being
   *  hovered. Gold mines aren't sim units, so they're picked from the ground
   *  point — this is what gives a neutral mine its yellow ring on hover. */
  hoverAt(cssX: number, cssY: number): void {
    this.hovered = this.pickAt(cssX, cssY);
    this.hoveredMine = null;
    if (this.hovered === null) {
      const g = this.groundPoint(cssX, cssY);
      if (g) {
        const m = this.sim.nearestMine(g[0], g[1], 300);
        this.hoveredMine = m ? m.id : null;
      }
    }
  }

  /** Clear the hover state (pointer left the map, e.g. onto the HUD) so the
   *  targeting reticle hides and the normal cursor returns. */
  clearHover(): void {
    this.hovered = null;
    this.hoveredMine = null;
  }

  /** What the cursor is over, for the targeting reticle: whether something is
   *  under it and its allegiance (own/ally = friendly, gold mine / neutral
   *  passive = neutral, everyone else = enemy). */
  hoverInfo(): { has: boolean; category: "friendly" | "neutral" | "enemy" } {
    if (this.hoveredMine !== null) return { has: true, category: "neutral" };
    if (this.hovered === null) return { has: false, category: "neutral" };
    const u = this.sim.units.get(this.hovered);
    if (!u) return { has: false, category: "neutral" };
    if (u.neutralPassive) return { has: true, category: "neutral" }; // shops, critters
    if (u.owner === this.localPlayer) return { has: true, category: "friendly" };
    const prim = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
    const hostile = prim ? this.sim.hostile(prim, u) : u.owner !== this.localPlayer;
    return { has: true, category: hostile ? "enemy" : "friendly" };
  }

  /** Live units, for the metrics overlay. */
  unitCount(): number {
    return this.entries.length;
  }

  // --- HUD driver surface ---------------------------------------------------

  /** Armed command-card order; the next left-click executes it instead of
   *  selecting. "rally" sets a building's rally point; "repair" targets a
   *  damaged friendly building; "cast" targets a spell (see armedCast). */
  orderMode: "move" | "attack" | "patrol" | "rally" | "repair" | "cast" | null = null;
  /** The spell armed for targeting when orderMode === "cast". `area` (>0) shows an
   *  AoE cast circle at the cursor for point-target area spells. */
  armedCast: { code: string; target: "unit" | "point"; area?: number } | null = null;

  /** Execute the armed order at a screen point. Returns true when consumed
   *  (the caller should then clear the HUD's armed state). */
  orderClickAt(cssX: number, cssY: number, queued = false): boolean {
    if (!this.orderMode || this.selected.size === 0 || !this.hasControllable()) {
      this.orderMode = null;
      return false;
    }
    const mode = this.orderMode;
    this.orderMode = null;
    if (mode === "cast") {
      const cast = this.armedCast;
      this.armedCast = null;
      if (!cast) return true;
      if (cast.target === "unit") {
        const picked = this.pickAt(cssX, cssY);
        if (picked !== null) this.castFromSelection(cast.code, picked, 0, 0);
        return true;
      }
      const hit = this.groundHitAt(cssX, cssY); // point-target spell
      if (hit) this.castFromSelection(cast.code, 0, hit[0], hit[1]);
      return true;
    }
    if (mode !== "rally") this.ack(mode === "attack"); // rally is a building order — no unit voice
    if (mode === "rally") {
      const r = this.resolveRally(cssX, cssY);
      if (r) {
        for (const id of this.selected) {
          if (this.controls(id) && this.sim.units.get(id)?.building?.producesUnits) this.sim.setRally(id, r.x, r.y, r.kind, r.targetId);
        }
        this.rallyFeedback(r);
        this.sounds?.playUi("RallyPointPlace");
      }
      return true;
    }
    if (mode === "repair") {
      this.repairAt(this.pickAt(cssX, cssY), queued);
      return true;
    }
    if (mode === "attack") {
      const picked = this.pickAt(cssX, cssY);
      const prim = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
      if (picked !== null && prim) {
        const target = this.sim.units.get(picked);
        // The Attack command FORCE-attacks whatever is under the cursor — including
        // friendly/own units and buildings (WC3 force attack).
        if (target && target.id !== this.primary) {
          let any = false;
          for (const id of this.selected) if (id !== picked && this.order(id, { kind: "attack", targetId: picked, force: true }, queued)) any = true;
          if (any) {
            this.flashAttack(target.x, target.y, this.byId.get(picked)?.selRadius ?? target.radius);
            return true;
          }
        }
      }
      // Nothing under the cursor: attack-MOVE to the ground point (below).
    }
    const dpr = this.dpr();
    this.screen[0] = cssX * dpr;
    this.screen[1] = cssY * dpr;
    this.host.camera.screenToWorldRay(this.ray, this.screen, this.host.viewport());
    const hit = this.groundHit();
    if (!hit) return true;
    if (mode === "patrol") {
      for (const id of this.selected) this.order(id, { kind: "patrol", x: hit[0], y: hit[1] }, queued);
      this.queueArrow(hit[0], hit[1], MOVE_ARROW);
    } else if (mode === "attack") {
      for (const id of this.selected) this.order(id, { kind: "attackmove", x: hit[0], y: hit[1] }, queued);
      this.queueArrow(hit[0], hit[1], ATTACK_ARROW); // red a-move feedback
    } else {
      this.groupMove(hit[0], hit[1], queued); // spread the group into a formation
      this.queueArrow(hit[0], hit[1], MOVE_ARROW);
    }
    return true;
  }

  // --- spellcasting ---------------------------------------------------------

  /** Ground-point pick for a screen coordinate (point-target spells, move, …). */
  private groundHitAt(cssX: number, cssY: number): [number, number] | null {
    const dpr = this.dpr();
    this.screen[0] = cssX * dpr;
    this.screen[1] = cssY * dpr;
    this.host.camera.screenToWorldRay(this.ray, this.screen, this.host.viewport());
    return this.groundHit();
  }

  /** Cast an ability from every selected own unit that knows it (WC3 casts from
   *  the whole selection — e.g. two priests both Dispel). */
  private castFromSelection(code: string, targetId: number, x: number, y: number): void {
    let any = false;
    for (const id of this.selected) {
      if (this.sim.units.get(id)?.owner !== this.localPlayer) continue;
      if (this.sim.issueCast(id, code, targetId, x, y)) any = true;
    }
    if (any) this.ack(false);
  }

  /** Cast a no-target ability (Thunder Clap, Divine Shield, Avatar) immediately. */
  castNoTarget(code: string): void {
    this.castFromSelection(code, 0, 0, 0);
  }

  /** Learn (or rank up) a hero ability on the primary-selected hero (own only). */
  learnSkill(abilityId: string): boolean {
    return this.primary !== null && this.controls(this.primary) && this.sim.learnAbility(this.primary, abilityId);
  }

  /** Toggle an autocast ability (Heal, Slow, …) on the whole own selection. */
  toggleAutocast(code: string): void {
    let state: boolean | null = null;
    for (const id of this.selected) {
      if (this.sim.units.get(id)?.owner !== this.localPlayer) continue;
      const s = this.sim.toggleAutocast(id, code);
      if (state === null) state = s;
    }
  }

  /** The primary-selected unit's live sim state (for the command card + HUD). */
  selectedSimUnit(): SimUnit | null {
    return this.primary !== null ? (this.sim.units.get(this.primary) ?? null) : null;
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

  /** Stop halts the selection AND clears their shift-queues (WC3: Stop wipes the
   *  action queue), so a stopped unit doesn't resume a queued order. */
  stopSelected(): void {
    for (const id of this.selected) {
      if (!this.controls(id)) continue; // only your own units obey Stop
      this.sim.clearQueue(id);
      this.sim.stop(id);
    }
  }

  /** Order the selected workers to repair a damaged friendly building. WC3
   *  rates: 35% of the build cost and 150% of the build time to go 1 HP→full. */
  private repairAt(picked: number | null, queued = false): boolean {
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
      if (w?.worker && this.order(id, { kind: "repair", buildingId: picked, hpPerSec, goldPerHp, lumberPerHp }, queued)) any = true;
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
      hp: 0, maxHp: 0, mana: 0, maxMana: 0, armor: 0, armorBonus: 0, damageMin: 0, damageMax: 0, damageBonus: 0,
      attackType: "", armorType: "", isHero: false, level: 0, xp: 0, xpThis: 0, xpNext: 0, skillPoints: 0, strength: 0,
      agility: 0, intelligence: 0, primaryAttr: "",
      model: def?.model ?? "", isWorker: false, isBuilding: false,
      underConstruction: false, buildProgress: 0, trainProgress: 0, secondsLeft: 0, queueLength: 0,
      queue: [], icon: def?.icon ?? "", carryGold: 0, carryLumber: 0,
      isMine: true, goldRemaining: m.gold,
      isSummon: false, summonSecondsLeft: 0, summonFrac: 0, buffs: [],
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
      // Split base vs the green buff/aura "+N" (WC3 stat display). Base damage
      // range = the weapon roll minus the buff portion.
      armor: Math.round(u.armor - u.bonusArmor),
      armorBonus: Math.round(u.bonusArmor),
      damageMin: w ? Math.round(w.damage - u.bonusDamage) + w.dice : 0,
      damageMax: w ? Math.round(w.damage - u.bonusDamage) + w.dice * w.sides : 0,
      damageBonus: Math.round(u.bonusDamage),
      attackType: def?.attackType ?? "",
      armorType: def?.armorType ?? "",
      isHero: u.isHero,
      // Heroes carry their LIVE level/attributes on the sim unit (they grow with
      // XP); non-heroes fall back to the data-def values.
      level: u.isHero ? u.level : (def?.level ?? 0),
      xp: u.xp,
      xpThis: u.isHero ? xpForLevel(u.level) : 0,
      xpNext: u.isHero ? xpForLevel(u.level + 1) : 0,
      skillPoints: u.skillPoints,
      strength: u.isHero ? u.str : (def?.strength ?? 0),
      agility: u.isHero ? u.agi : (def?.agility ?? 0),
      intelligence: u.isHero ? u.int : (def?.intelligence ?? 0),
      primaryAttr: def?.primaryAttr ?? "",
      model: e.modelPath,
      isWorker: !!u.worker,
      isBuilding: !!b,
      underConstruction: !!b && b.constructionLeft > 0,
      buildProgress: b && b.buildTimeTotal > 0 ? 1 - b.constructionLeft / b.buildTimeTotal : 1,
      trainProgress: q.length && q[0].buildTime > 0 ? 1 - q[0].timeLeft / q[0].buildTime : 0,
      secondsLeft: b && b.constructionLeft > 0 ? b.constructionLeft : q.length ? q[0].timeLeft : 0,
      queueLength: q.length,
      queue: q.map((j) => ({ icon: this.registry.get(j.unitId)?.icon ?? "" })),
      icon: this.registry.get(e.typeId)?.icon ?? "",
      carryGold: u.worker?.carryGold ?? 0,
      carryLumber: u.worker?.carryLumber ?? 0,
      isMine: false,
      goldRemaining: 0,
      isSummon: u.isSummon && u.summonLeft > 0,
      summonSecondsLeft: Math.max(0, Math.ceil(u.summonLeft)),
      summonFrac: u.summonMax > 0 ? Math.max(0, Math.min(1, u.summonLeft / u.summonMax)) : 0,
      buffs: this.statusBuffsFor(u),
    };
  }

  /** Active buffs/auras/debuffs on a unit, de-duped by source, resolved to an icon
   *  + name for the HUD status row. Aura buffs carry their base code in `group`. */
  private statusBuffsFor(u: SimUnit): Array<{ icon: string; name: string; harmful: boolean }> {
    if (!u.buffs.length) return [];
    const out: Array<{ icon: string; name: string; harmful: boolean }> = [];
    const seen = new Set<string>();
    for (const b of u.buffs) {
      const code = b.group.includes(":") ? b.group.split(":")[0] : (GROUP_TO_CODE[b.group] ?? "");
      const key = code || b.kind;
      if (seen.has(key)) continue;
      seen.add(key);
      const def = code ? this.abilityDefByCode(code) : undefined;
      const harmful = b.kind === "stun" || b.kind === "slow" || b.kind === "dot";
      out.push({ icon: def?.icon ?? BUFF_KIND_ICON[b.kind] ?? "", name: def?.name ?? BUFF_KIND_LABEL[b.kind] ?? b.kind, harmful });
    }
    return out;
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

  /** CLICK/selection colliders for EVERY live unit (position, ground height, and
   *  selection radius) — for the debug collider overlay. Pathing & LOS obstruction are
   *  read straight off the grid/vision map by the renderer. */
  debugUnitColliders(): Array<{ x: number; y: number; z: number; radius: number; building: boolean }> {
    const out: Array<{ x: number; y: number; z: number; radius: number; building: boolean }> = [];
    for (const [id, u] of this.sim.units) {
      const e = this.byId.get(id);
      if (!e) continue;
      out.push({ x: u.x, y: u.y, z: this.heightAt(u.x, u.y), radius: e.selRadius, building: u.building != null });
    }
    return out;
  }

  /** Ground-circle info for every selected unit (the renderer draws each ring as
   *  a flat model on the terrain so geometry occludes it). */
  selectionRings(): RingInfo[] {
    const out: RingInfo[] = [];
    for (const id of this.selected) {
      const u = this.sim.units.get(id);
      const e = this.byId.get(id);
      // Buildings get a ring sized to their footprint (a constant tiny ring is
      // hidden under the model); units keep the constant ring. Neutral Passive
      // entities ring yellow.
      if (u && e) out.push({ x: u.x, y: u.y, z: this.heightAt(u.x, u.y), radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building, neutral: u.neutralPassive });
    }
    if (this.selectedMine !== null) {
      const m = this.sim.mines.get(this.selectedMine);
      // A gold mine is Neutral PASSIVE (yellow ring), not hostile (red).
      if (m) out.push({ x: m.x, y: m.y, z: this.heightAt(m.x, m.y), radius: m.radius * MINE_RING_SCALE, owner: -1, team: -2, sizeToRadius: true, neutral: true });
    }
    return out;
  }

  /** Ground-circles for the units currently inside the live drag-box — drawn in
   *  full selection green so the player previews the pick before releasing. */
  previewRings(): RingInfo[] {
    const out: RingInfo[] = [];
    for (const id of this.previewIds) {
      const u = this.sim.units.get(id);
      const e = this.byId.get(id);
      if (u && e) out.push({ x: u.x, y: u.y, z: this.heightAt(u.x, u.y), radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building, neutral: u.neutralPassive });
    }
    return out;
  }

  /** Ground-circle for the hovered unit or gold mine (skipped if it's already
   *  selected). A hovered mine gets a neutral (yellow) ring, exactly like a
   *  selected one. */
  hoverRing(): RingInfo | null {
    if (this.hovered !== null && !this.selected.has(this.hovered)) {
      const u = this.sim.units.get(this.hovered);
      const e = this.byId.get(this.hovered);
      if (u && e) return { x: u.x, y: u.y, z: this.heightAt(u.x, u.y), radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building, neutral: u.neutralPassive };
    }
    if (this.hoveredMine !== null && this.hoveredMine !== this.selectedMine) {
      const m = this.sim.mines.get(this.hoveredMine);
      if (m) return { x: m.x, y: m.y, z: this.heightAt(m.x, m.y), radius: m.radius * MINE_RING_SCALE, owner: -1, team: -2, sizeToRadius: true, neutral: true };
    }
    return null;
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
    if (!b || !b.producesUnits) return null;
    // For a mine/tree/unit rally, put the flag on the live target (a followed
    // unit may have moved); fall back to the stored point if it's gone.
    let x = b.rallyX;
    let y = b.rallyY;
    if (b.rallyKind === "unit") {
      const t = this.sim.units.get(b.rallyTargetId);
      if (t) { x = t.x; y = t.y; }
    } else if (b.rallyKind === "tree") {
      const t = this.sim.trees.get(b.rallyTargetId);
      if (t) { x = t.x; y = t.y; }
    } else if (b.rallyKind === "mine") {
      const m = this.sim.mines.get(b.rallyTargetId);
      if (m) { x = m.x; y = m.y; }
    }
    return { x, y, z: this.heightAt(x, y) };
  }

  /** World positions of every SELECTED unit's shift-queued orders, for the small
   *  queue flags (rendered only while the owner is selected). A queued lumber
   *  harvest flags the tree top; other orders flag the ground point/target. */
  queueMarkers(): Array<{ x: number; y: number; z: number }> {
    const out: Array<{ x: number; y: number; z: number }> = [];
    for (const id of this.selected) {
      const u = this.sim.units.get(id);
      if (!u) continue;
      for (const o of u.orderQueue) {
        const m = this.markerFor(o);
        if (m) out.push(m);
      }
    }
    return out;
  }

  /** World position (with height) of a queued order's target, or null if its
   *  target has since vanished. Lumber harvests sit atop the tree. */
  private markerFor(o: QueuedOrder): { x: number; y: number; z: number } | null {
    switch (o.kind) {
      case "move":
      case "attackmove":
      case "patrol":
      case "buildnew":
        return { x: o.x, y: o.y, z: this.heightAt(o.x, o.y) };
      case "attack":
      case "follow": {
        const t = this.sim.units.get(o.targetId);
        return t ? { x: t.x, y: t.y, z: this.heightAt(t.x, t.y) } : null;
      }
      case "buildresume":
      case "repair": {
        const b = this.sim.units.get(o.buildingId);
        return b ? { x: b.x, y: b.y, z: this.heightAt(b.x, b.y) } : null;
      }
      case "harvest": {
        if (o.res === "lumber") {
          const t = this.sim.trees.get(o.nodeId);
          return t ? { x: t.x, y: t.y, z: this.heightAt(t.x, t.y) + TREE_FLAG_HEIGHT } : null;
        }
        const m = this.sim.mines.get(o.nodeId);
        return m ? { x: m.x, y: m.y, z: this.heightAt(m.x, m.y) } : null;
      }
    }
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

  /** Food used/made by a player's units — including food RESERVED for units still
   *  in training (WC3 takes food when training begins, like gold/lumber). A queued
   *  unit's food moves seamlessly to the live count when it spawns (no double-up). */
  foodFor(owner: number): { used: number; made: number } {
    let used = 0;
    let made = 0;
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (u && u.owner === owner) {
        used += e.foodUsed;
        made += e.foodMade;
        if (u.building) for (const job of u.building.queue) used += this.registry.get(job.unitId)?.foodUsed ?? 0;
      }
    }
    made += this.cheatFoodBonus.get(owner) ?? 0; // debug "add food" cheat
    return { used, made };
  }

  private cheatFoodBonus = new Map<number, number>(); // debug: extra supply cap per player

  /** Debug cheats (the bottom-right buttons): top up the local player's economy. */
  cheat(kind: "gold" | "lumber" | "food" | "fastbuild"): boolean {
    if (kind === "fastbuild") {
      this.sim.fastBuild = !this.sim.fastBuild; // builds/trains complete in ~1s
      return this.sim.fastBuild;
    }
    if (kind === "food") {
      this.cheatFoodBonus.set(this.localPlayer, (this.cheatFoodBonus.get(this.localPlayer) ?? 0) + 100);
    } else {
      const stash = this.sim.stashOf(this.localPlayer);
      if (kind === "gold") stash.gold += 500;
      else stash.lumber += 500;
    }
    return false;
  }

  /** Minimap dots: world positions + owners of living units the local team can
   *  see. Your own units always show; fogged enemies/neutrals are dropped so the
   *  minimap hides enemy movements exactly like the main view. Creep camps and
   *  neutral buildings are pulled out here — they get their own persistent camp
   *  circles / house icons (creepCamps / neutralBuildings) instead of unit dots. */
  dots(): Array<{ x: number; y: number; owner: number }> {
    const out: Array<{ x: number; y: number; owner: number }> = [];
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (!u) continue;
      if (u.isCreep) continue; // shown as a camp difficulty circle
      if (u.neutralPassive && u.building != null) continue; // shown as a house icon
      if (!e.hidden || (u.team === this.localTeam && !u.neutralPassive)) {
        out.push({ x: u.x, y: u.y, owner: u.owner });
      }
    }
    return out;
  }

  // Creep-camp minimap markers. WC3 groups a map's Neutral Hostile creeps into
  // camps and marks each on the minimap with a difficulty dot coloured by the
  // camp's COMBINED creep level — green 1–9, yellow 10–19, red 20+ (Liquipedia
  // "Creeps"). The level is fixed map data: computed once from the placed creeps
  // and never recomputed, so the colour never drifts as the camp is whittled
  // down. Camps are clustered by guard-post proximity using the same "acts as one
  // camp" radius the guard AI already uses (MiscGame CreepCallForHelp).
  private static readonly CAMP_LINK = 600; // world units — CreepCallForHelp; matches world.ts sameCamp
  private creepCampData: Array<{ x: number; y: number; level: number; members: number[] }> | null = null;

  /** Cluster the seeded creeps into camps once (guard posts are fixed, so this is
   *  stable). Each camp keeps its centre, its fixed total level, and its member
   *  sim ids so the marker can vanish once the whole camp is dead. */
  private buildCreepCamps(): Array<{ x: number; y: number; level: number; members: number[] }> {
    const creeps: Array<{ id: number; gx: number; gy: number; level: number }> = [];
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (!u || !u.isCreep) continue;
      creeps.push({ id: e.simId, gx: u.guardX, gy: u.guardY, level: e.level });
    }
    // Union-find connected components over the "same camp" (guard posts within
    // CAMP_LINK of each other) relation.
    const parent = creeps.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    const link2 = RtsController.CAMP_LINK * RtsController.CAMP_LINK;
    for (let i = 0; i < creeps.length; i++) {
      for (let j = i + 1; j < creeps.length; j++) {
        const dx = creeps[i].gx - creeps[j].gx, dy = creeps[i].gy - creeps[j].gy;
        if (dx * dx + dy * dy <= link2) parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, { sx: number; sy: number; level: number; members: number[] }>();
    for (let i = 0; i < creeps.length; i++) {
      const r = find(i);
      const g = groups.get(r) ?? { sx: 0, sy: 0, level: 0, members: [] };
      g.sx += creeps[i].gx; g.sy += creeps[i].gy; g.level += creeps[i].level; g.members.push(creeps[i].id);
      groups.set(r, g);
    }
    return [...groups.values()].map((g) => ({
      x: g.sx / g.members.length, y: g.sy / g.members.length, level: g.level, members: g.members,
    }));
  }

  /** Creep-camp difficulty markers for the minimap: camp centre + fixed combined
   *  level. A camp shows once its location has been explored and disappears once
   *  every creep in it is dead (WC3 clears the marker when the camp is wiped). */
  creepCamps(): Array<{ x: number; y: number; level: number }> {
    if (!this.seeded) return [];
    if (this.creepCampData === null) this.creepCampData = this.buildCreepCamps();
    const out: Array<{ x: number; y: number; level: number }> = [];
    for (const camp of this.creepCampData) {
      if (!camp.members.some((id) => this.sim.units.has(id))) continue; // camp cleared
      if (!this.pointExplored(camp.x, camp.y)) continue;
      out.push({ x: camp.x, y: camp.y, level: camp.level });
    }
    return out;
  }

  /** Neutral-passive BUILDINGS (taverns, goblin merchant/lab, mercenary camps,
   *  fountains…) for the minimap house icon. Critters (non-buildings) are left as
   *  plain neutral dots. Shown once the building's location has been explored. */
  neutralBuildings(): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (!u || !u.neutralPassive || u.building == null) continue;
      if (!this.pointExplored(u.x, u.y)) continue;
      out.push({ x: u.x, y: u.y });
    }
    return out;
  }

  /** Has this world point ever been seen? Camp circles + neutral-building icons
   *  persist on the minimap once explored, even after the area falls back to fog
   *  (like WC3's last-seen building memory). */
  private pointExplored(wx: number, wy: number): boolean {
    return this.vision.stateAt(wx, wy) !== FogState.Unexplored;
  }

  /** True if this unit belongs to the local player (the only units they may
   *  command). Enemy/neutral/creep units can be single-selected to inspect, but
   *  never take orders — WC3 only lets you control your own. */
  private controls(id: number): boolean {
    return this.sim.units.get(id)?.owner === this.localPlayer;
  }

  /** True if the selection holds at least one unit the local player controls. */
  private hasControllable(): boolean {
    for (const id of this.selected) if (this.controls(id)) return true;
    return false;
  }

  /** Route an order to a unit: either append it to the unit's shift-queue, or
   *  execute it immediately (replacing its current order + queue). Silently
   *  ignores units the local player doesn't own — the single choke point that
   *  keeps enemy/neutral/creep units uncommandable. */
  private order(id: number, o: QueuedOrder, queued: boolean): boolean {
    if (!this.controls(id)) return false;
    if (queued) {
      this.sim.queueOrder(id, o);
      return true;
    }
    return this.sim.issueOrder(id, o);
  }

  /** Right-click: order the whole selection. Attack a hostile under the cursor;
   *  workers resume a friendly build or harvest a resource; else move to ground.
   *  `queued` (Shift held) appends to each unit's order queue instead of replacing. */
  moveAt(cssX: number, cssY: number, queued = false): void {
    if (this.selected.size === 0 || !this.hasControllable()) return; // can't command enemy/neutral units
    const prim = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
    // A selected unit-producing building: right-click sets its (smart) rally point.
    if (prim?.building?.producesUnits) {
      const r = this.resolveRally(cssX, cssY);
      if (r) {
        for (const id of this.selected) {
          if (this.controls(id) && this.sim.units.get(id)?.building?.producesUnits) this.sim.setRally(id, r.x, r.y, r.kind, r.targetId);
        }
        this.rallyFeedback(r);
        this.sounds?.playUi("RallyPointPlace");
      }
      return;
    }
    const picked = this.pickAt(cssX, cssY);
    // Acknowledge the order with the focused unit's voice — attack quote if it
    // targets a hostile unit, otherwise the move quote.
    {
      const t = picked !== null ? this.sim.units.get(picked) : undefined;
      this.ack(!!(t && prim && !t.building && this.sim.hostile(prim, t)));
    }
    if (picked !== null && !this.selected.has(picked)) {
      const target = this.sim.units.get(picked);
      if (target) {
        const selR = this.byId.get(picked)?.selRadius ?? target.radius;
        const enemy = prim ? this.sim.hostile(prim, target) : false;
        if (enemy && !target.building) {
          // Hostile UNIT: attack + red flash (constant ring, matching its hover).
          let any = false;
          for (const id of this.selected) if (this.order(id, { kind: "attack", targetId: picked }, queued)) any = true;
          if (any) {
            this.flashRing(target.x, target.y, selR, FLASH_RED, false);
            return;
          }
        } else if (target.building) {
          // ANY building: flash its footprint circle instead of a ground arrow —
          // red for hostile, green for own, yellow for allied/neutral — and issue
          // the fitting order (attack / resume construction / repair / move).
          this.orderOnBuilding(target, picked, enemy, selR, queued);
          return;
        } else {
          // Friendly / neutral UNIT: FOLLOW it (move-follow, no auto-acquire) — for
          // marshalling large forces or scouting a unit you can't attack (WC3). Fan
          // the group into distinct slots around the leader (formation offsets) so
          // they hold a spread instead of stacking on its centre and shoving.
          const followers = [...this.selected].filter((id) => id !== picked);
          const offs = this.followOffsets(followers, target);
          let any = false;
          for (const id of followers) {
            const o = offs.get(id);
            if (this.order(id, { kind: "follow", targetId: picked, offX: o?.[0], offY: o?.[1] }, queued)) any = true;
          }
          if (any) {
            this.flashRing(target.x, target.y, selR, FLASH_GREEN, false); // green follow confirm
            return;
          }
        }
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
      // Fan the group around the mine's rim (distinct approach points) so they
      // don't all path to the one entry point and pile up while they wait their
      // turn — a mine takes one worker at a time. Nearest-slot keeps each worker
      // on the side it walked up from; after the first trip the sim re-forms the
      // usual mine→hall line (mineApproach), so this only cleans up the approach.
      const workers = [...this.selected].filter((id) => !!this.sim.units.get(id)?.worker?.gold);
      // A little extra breathing room on the approach ring so they don't bunch on
      // one side of the mine (kept modest — miners must still land within entry reach).
      const spread = this.ringTargets(workers, mine.x, mine.y, mine.radius, MINE_APPROACH_SPREAD);
      let any = false;
      for (const id of workers) {
        const p = spread.get(id);
        if (this.order(id, { kind: "harvest", res: "gold", nodeId: mine.id, ax: p?.[0], ay: p?.[1] }, queued)) any = true;
      }
      if (any) {
        this.flashTarget(mine.x, mine.y, mine.radius * MINE_RING_SCALE); // match the mine's hover/selection ring
        return;
      }
    }
    const treeHit = this.treePickPoint() ?? hit; // raised plane → clicking up the tree still hits
    const tree = this.sim.nearestTree(treeHit[0], treeHit[1], 140);
    if (tree) {
      // Spread the group across nearby trees so they don't all crowd the one
      // clicked trunk and shove each other. Gather the lumber workers, pull the
      // N nearest trees to the click (N = worker count), then hand each worker
      // the least-crowded candidate, breaking ties by which is closest to it.
      const workers: number[] = [];
      for (const id of this.selected) {
        if (this.sim.units.get(id)?.worker?.lumber) workers.push(id);
      }
      if (workers.length) {
        const trees = this.sim.nearestTrees(tree.x, tree.y, 220, workers.length);
        const load = new Map<number, number>(trees.map((t) => [t.id, 0]));
        let any = false;
        const targeted = new Set<number>();
        for (const id of workers) {
          const w = this.sim.units.get(id)!;
          // fill each tree once (load dominates) before doubling up; nearest wins ties.
          let best = trees[0];
          let bestScore = Infinity;
          for (const t of trees) {
            const score = load.get(t.id)! * 1e6 + Math.hypot(t.x - w.x, t.y - w.y);
            if (score < bestScore) {
              bestScore = score;
              best = t;
            }
          }
          if (this.order(id, { kind: "harvest", res: "lumber", nodeId: best.id }, queued)) {
            load.set(best.id, load.get(best.id)! + 1);
            targeted.add(best.id);
            any = true;
          }
        }
        if (any) {
          this.flashTarget(tree.x, tree.y, 76); // a bigger ring around the clicked tree
          for (const t of trees) if (targeted.has(t.id)) this.treePulses.push({ x: t.x, y: t.y });
          return;
        }
      }
    }
    this.groupMove(hit[0], hit[1], queued); // spread the group into a formation
    this.queueArrow(hit[0], hit[1], MOVE_ARROW); // green move-order feedback
  }

  /** Resolve where a rally right-click points: a unit under the cursor (follow),
   *  a gold mine or tree (produced workers harvest it), else a ground point. */
  private resolveRally(cssX: number, cssY: number): { x: number; y: number; kind: RallyKind; targetId: number } | null {
    const picked = this.pickAt(cssX, cssY);
    if (picked !== null) {
      const t = this.sim.units.get(picked);
      if (t && !t.building) return { x: t.x, y: t.y, kind: "unit", targetId: picked };
    }
    const hit = this.groundPoint(cssX, cssY);
    if (!hit) return null;
    const mine = this.sim.nearestMine(hit[0], hit[1], 320);
    if (mine) return { x: mine.x, y: mine.y, kind: "mine", targetId: mine.id };
    const treeHit = this.treePickPoint() ?? hit; // raised plane → clicking up the tree still hits
    const tree = this.sim.nearestTree(treeHit[0], treeHit[1], 140);
    if (tree) return { x: tree.x, y: tree.y, kind: "tree", targetId: tree.id };
    return { x: hit[0], y: hit[1], kind: "point", targetId: 0 };
  }

  /** Feedback for a rally point: a tree/mine rally flashes the same yellow ring
   *  (and, for a tree, the yellow colorize pulse) as sending a worker to gather
   *  it; a plain point/unit rally shows the green move arrow. */
  private rallyFeedback(r: { x: number; y: number; kind: RallyKind; targetId: number }): void {
    if (r.kind === "tree") {
      this.flashTarget(r.x, r.y, 76);
      this.treePulses.push({ x: r.x, y: r.y });
    } else if (r.kind === "mine") {
      const mine = this.sim.mines.get(r.targetId);
      this.flashTarget(r.x, r.y, mine ? mine.radius * MINE_RING_SCALE : 76);
    } else {
      this.queueArrow(r.x, r.y, MOVE_ARROW);
    }
  }

  /** Right-clicked a building: issue the fitting order and flash its footprint
   *  circle (no ground arrow). Hostile → attack + red; own → resume/repair (if a
   *  worker) else move, green; allied/neutral → move, yellow. */
  private orderOnBuilding(target: SimUnit, picked: number, enemy: boolean, selR: number, queued: boolean): void {
    if (enemy) {
      for (const id of this.selected) this.order(id, { kind: "attack", targetId: picked }, queued);
      this.flashRing(target.x, target.y, selR, FLASH_RED);
      return;
    }
    const own = this.primary !== null ? target.owner === this.sim.units.get(this.primary)?.owner : false;
    let handled = false;
    if (own && target.building && target.building.constructionLeft > 0) {
      // Own building still going up: workers resume/assist it. Fan the group
      // around the footprint (distinct approach points) so they don't all walk
      // onto the one centre point and shove — WC3 builders spread over a structure.
      const workers = [...this.selected].filter((id) => !!this.sim.units.get(id)?.worker);
      // Speed-build: fan the builders WIDE around the structure (extra spacing) so
      // they ring the whole footprint instead of bunching on the near edge and
      // shoving. A gold-mine approach stays tight; this doesn't need to.
      const spread = this.ringTargets(workers, target.x, target.y, target.radius, SPEED_BUILD_SPREAD);
      for (const id of workers) {
        const p = spread.get(id);
        this.order(id, { kind: "buildresume", buildingId: picked, ax: p?.[0], ay: p?.[1] }, queued);
      }
      handled = workers.length > 0;
    } else if (own && target.hp < target.maxHp) {
      handled = this.repairAt(picked, queued); // own damaged building: workers repair
    }
    if (!handled) this.groupMove(target.x, target.y, queued); // move toward it (no arrow)
    this.flashRing(target.x, target.y, selR, own ? FLASH_GREEN : FLASH_YELLOW);
  }

  /** Give each unit in the group its OWN destination tile so they don't pile onto
   *  one spot — a COMPACT concentric-ring formation centred on the clicked point,
   *  spaced just enough that collision hulls don't overlap (so the group converges
   *  on the target rather than fanning out wide). Every slot is a distinct spot the
   *  unit's footprint fits on; nearest unit takes the nearest slot to minimise crossing. */
  private groupTargets(ids: number[], tx: number, ty: number): Map<number, [number, number]> {
    const out = new Map<number, [number, number]>();
    const list = ids
      .map((id) => ({ id, u: this.sim.units.get(id) }))
      .filter((x): x is { id: number; u: SimUnit } => !!x.u);
    if (list.length <= 1) {
      for (const { id } of list) out.set(id, [tx, ty]);
      return out;
    }
    const grid = this.sim.grid;
    // A gap on top of the collision diameter: tight formation, but with a little
    // breathing room so units aren't shoulder-to-shoulder.
    let radius = 16;
    for (const { u } of list) radius = Math.max(radius, u.radius);
    const spacing = radius * 2 + 36;
    // Slots are sized/claimed for the group's LARGEST footprint so big units
    // (Knights, Tauren) reliably get a spot their whole body fits — claiming only
    // a single cell used to hand them a slot clipping terrain, which path-failed
    // and collapsed them back onto the centre.
    const fp = Math.max(1, footprintCells(radius));

    // Claim a distinct spot whose full fp×fp footprint is walkable and unclaimed
    // (spiral out from the desired point); reserve exactly the cells the unit will
    // settle on, using the sim's own snap math so the target is a valid stance.
    const used = new Set<number>();
    const claim = (wx: number, wy: number): [number, number] => {
      const [c0x, c0y] = grid.worldToCell(wx, wy);
      for (let r = 0; r <= 12; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
            const [cwx, cwy] = grid.cellToWorld(c0x + dx, c0y + dy);
            const [sx, sy] = grid.snapForFootprint(cwx, cwy, fp);
            const [ox, oy] = grid.footprintOrigin(sx, sy, fp);
            let ok = true;
            for (let yy = 0; yy < fp && ok; yy++) {
              for (let xx = 0; xx < fp; xx++) {
                const key = (oy + yy) * grid.width + (ox + xx);
                if (used.has(key) || !grid.walkable(ox + xx, oy + yy)) { ok = false; break; }
              }
            }
            if (!ok) continue;
            for (let yy = 0; yy < fp; yy++) for (let xx = 0; xx < fp; xx++) used.add((oy + yy) * grid.width + (ox + xx));
            return [sx, sy];
          }
        }
      }
      return [wx, wy];
    };

    // Concentric hex rings around the target (centre-out), just big enough.
    const slots: Array<[number, number]> = [];
    for (let ring = 0; slots.length < list.length && ring < 24; ring++) {
      if (ring === 0) { slots.push([tx, ty]); continue; }
      const n = ring * 6;
      for (let i = 0; i < n && slots.length < list.length; i++) {
        const a = (i / n) * Math.PI * 2;
        slots.push([tx + Math.cos(a) * ring * spacing, ty + Math.sin(a) * ring * spacing]);
      }
    }
    // Nearest unit → nearest slot (centre-out), each on its own claimed cell.
    const remaining = new Set(list.map((x) => x.id));
    for (const slot of slots) {
      if (!remaining.size) break;
      let best: number | null = null;
      let bestD = Infinity;
      for (const id of remaining) {
        const u = this.sim.units.get(id)!;
        const d = Math.hypot(u.x - slot[0], u.y - slot[1]);
        if (d < bestD) { bestD = d; best = id; }
      }
      if (best !== null) { out.set(best, claim(slot[0], slot[1])); remaining.delete(best); }
    }
    for (const id of remaining) out.set(id, claim(tx, ty));
    return out;
  }

  /** Distinct approach points fanned around a circular target (a building being
   *  raised, or a gold mine) so a group ordered together spreads over its rim
   *  instead of all pathing to the one centre point and shoving. Concentric rings
   *  start just outside `radius`; nearest worker claims the nearest free walkable
   *  slot (centre-out, like groupTargets — but ringed around an obstacle rather
   *  than filling a point). A single unit gets the plain centre, so the spread
   *  only kicks in when several are commanded at once. */
  private ringTargets(ids: number[], cx: number, cy: number, radius: number, extraSpacing = 0): Map<number, [number, number]> {
    const out = new Map<number, [number, number]>();
    const list = ids
      .map((id) => ({ id, u: this.sim.units.get(id) }))
      .filter((x): x is { id: number; u: SimUnit } => !!x.u);
    if (list.length <= 1) {
      for (const { id } of list) out.set(id, [cx, cy]);
      return out;
    }
    const grid = this.sim.grid;
    let wr = 16;
    for (const { u } of list) wr = Math.max(wr, u.radius);
    // Neighbour gap along a ring / between rings. `extraSpacing` widens the fan
    // for callers that want the group spread further apart (speed-build) rather
    // than hugging the target tightly (a gold miner must land within entry reach).
    const spacing = wr * 2 + 24 + extraSpacing;

    // Claim a distinct, walkable cell near a world point (spiral out from it).
    const used = new Set<number>();
    const claim = (wx: number, wy: number): [number, number] => {
      const [c0x, c0y] = grid.worldToCell(wx, wy);
      for (let r = 0; r <= 12; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
            const gx = c0x + dx, gy = c0y + dy;
            const key = gy * grid.width + gx;
            if (used.has(key) || !grid.walkable(gx, gy)) continue;
            used.add(key);
            return grid.cellToWorld(gx, gy);
          }
        }
      }
      return [wx, wy];
    };

    // Ring 0 hugs the footprint edge (radius + a body + slack, so a gold miner
    // lands within its entry reach); outer rings step out by `spacing`. Each ring
    // holds as many evenly-spaced points as fit, staggered so rings interleave.
    const slots: Array<[number, number]> = [];
    for (let ring = 0; slots.length < list.length && ring < 24; ring++) {
      const rr = radius + wr + 8 + extraSpacing + ring * spacing;
      const n = Math.max(1, Math.floor((2 * Math.PI * rr) / spacing));
      for (let i = 0; i < n && slots.length < list.length; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.618; // golden-ish stagger between rings
        slots.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
      }
    }
    // Nearest unit → nearest slot (so each takes the side it approaches from),
    // each on its own claimed walkable cell.
    const remaining = new Set(list.map((x) => x.id));
    for (const slot of slots) {
      if (!remaining.size) break;
      let best: number | null = null;
      let bestD = Infinity;
      for (const id of remaining) {
        const u = this.sim.units.get(id)!;
        const d = Math.hypot(u.x - slot[0], u.y - slot[1]);
        if (d < bestD) { bestD = d; best = id; }
      }
      if (best !== null) { out.set(best, claim(slot[0], slot[1])); remaining.delete(best); }
    }
    for (const id of remaining) out.set(id, claim(cx, cy));
    return out;
  }

  /** Formation offsets for a group told to FOLLOW one leader: each follower gets a
   *  distinct slot around the leader (returned as a world-space offset from its
   *  centre, since the leader moves) so the group holds a spread instead of all
   *  homing on the centre point and shoving. Concentric rings start a body behind
   *  the leader; nearest follower claims the nearest slot (least crossing). A lone
   *  follower gets (0,0) and simply trails — matching WC3's plain follow. */
  private followOffsets(ids: number[], leader: SimUnit): Map<number, [number, number]> {
    const out = new Map<number, [number, number]>();
    const list = ids
      .map((id) => ({ id, u: this.sim.units.get(id) }))
      .filter((x): x is { id: number; u: SimUnit } => !!x.u);
    if (list.length <= 1) {
      for (const { id } of list) out.set(id, [0, 0]);
      return out;
    }
    let wr = 16;
    for (const { u } of list) wr = Math.max(wr, u.radius);
    const spacing = wr * 2 + 24; // neighbour gap so collision hulls don't overlap
    const ring0 = leader.radius + wr + FOLLOW_RING_GAP; // innermost ring, a body behind the leader

    // Concentric rings around the leader; each holds as many evenly-spaced slots
    // as fit, staggered so rings interleave rather than line up radially.
    const slots: Array<[number, number]> = [];
    for (let ring = 0; slots.length < list.length && ring < 24; ring++) {
      const rr = ring0 + ring * spacing;
      const n = Math.max(1, Math.floor((2 * Math.PI * rr) / spacing));
      for (let i = 0; i < n && slots.length < list.length; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.618; // golden-ish stagger between rings
        slots.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
    }
    // Nearest follower → nearest slot, so each takes the side it already approaches
    // from and paths cross as little as possible.
    const remaining = new Set(list.map((x) => x.id));
    for (const slot of slots) {
      if (!remaining.size) break;
      let best: number | null = null;
      let bestD = Infinity;
      for (const id of remaining) {
        const u = this.sim.units.get(id)!;
        const d = Math.hypot(u.x - (leader.x + slot[0]), u.y - (leader.y + slot[1]));
        if (d < bestD) { bestD = d; best = id; }
      }
      if (best !== null) { out.set(best, slot); remaining.delete(best); }
    }
    for (const id of remaining) out.set(id, [0, 0]);
    return out;
  }

  /** Issue a formation move for the whole selection to a ground point (or queue
   *  each unit's slot move when Shift is held). */
  private groupMove(tx: number, ty: number, queued = false): void {
    const targets = this.groupTargets([...this.selected], tx, ty);
    for (const [id, [x, y]] of targets) this.order(id, { kind: "move", x, y }, queued);
  }

  /** Queue a target-circle flash — the renderer draws it as a flat ground circle
   *  (a twin-blink, like the selection ring / gold-mine flash), tinted per the
   *  caller. `big` MUST match how the target's hover/selection ring is sized so the
   *  order flash is the SAME size as hovering it: units use the constant ring
   *  (big=false), buildings/mines/trees size to their footprint radius (big=true). */
  private flashRing(x: number, y: number, radius: number, color: [number, number, number], big = true): void {
    this.flashRequests.push({ x, y, z: this.heightAt(x, y), radius, color, sizeToRadius: big });
  }
  private flashTarget(x: number, y: number, radius: number): void {
    this.flashRing(x, y, radius, FLASH_YELLOW); // yellow harvest-target flash (mine/tree → sized)
  }
  private flashAttack(x: number, y: number, radius: number): void {
    this.flashRing(x, y, radius, FLASH_RED, false); // red attack-target flash on a unit → constant ring
  }

  /** Trees to pulse yellow since the last drain (renderer tints the doodad). */
  drainTreePulses(): Array<{ x: number; y: number }> {
    if (!this.treePulses.length) return this.treePulses;
    const out = this.treePulses;
    this.treePulses = [];
    return out;
  }

  /** Harvest-flash requests since the last drain (renderer renders + times them). */
  drainFlashes(): Array<{ x: number; y: number; z: number; radius: number; color: [number, number, number]; sizeToRadius: boolean }> {
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
      // Project the unit's mid-body (base + ~half its height) to screen. Buildings
      // sit lower (nearer their base) so their clickable area hugs the footprint
      // on the ground rather than floating up the tall silhouette.
      this.world[0] = u.x;
      this.world[1] = u.y;
      this.world[2] = baseZ + (u.building ? Math.max(e.selRadius * 0.45, 24) : Math.max(e.selRadius * 1.2, 60));
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

  /** Pick point for TREES: where the click ray crosses a horizontal plane raised
   *  TREE_COLLIDER_HEIGHT above the terrain, instead of the terrain itself. A tree
   *  is tall, so clicking up its trunk/canopy sends the ground ray well behind the
   *  trunk; sampling the ray higher lands it back near the trunk's XY, giving trees
   *  a taller click collider. Falls back to the ground hit if the ray is level. */
  private treePickPoint(): [number, number] | null {
    const g = this.groundHit();
    if (!g) return null;
    const r = this.ray;
    const dz = r[5] - r[2];
    if (Math.abs(dz) < 1e-6) return g; // level ray → no useful raise
    const planeZ = this.heightAt(g[0], g[1]) + TREE_COLLIDER_HEIGHT;
    const t = (planeZ - r[2]) / dz;
    return [r[0] + (r[3] - r[0]) * t, r[1] + (r[4] - r[1]) * t];
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
      if (!u || e.hidden || u.neutralPassive) continue; // mine-worker / neutral structures: no floating bar
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
      // Heroes get a wider bar (and a higher floor/ceiling) so their HP + mana
      // read clearly and stand out from regular units.
      const barW = e.isHero
        ? Math.max(46, Math.min(210, ry * 3))
        : Math.max(30, Math.min(170, ry * 2.4));
      bar.bars.style.width = `${barW}px`;
      bar.root.style.left = `${sx / dpr}px`;
      bar.root.style.top = `${(h - sy) / dpr - (ry + 24)}px`; // gl y-up → css y-down (floats above the unit)
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
    damagePoint: def.attackDamagePoint,
    range: def.attackRange,
    acquire: def.acquireRange,
    ranged,
    missileArt: def.missileArt,
    missileSpeed: def.missileSpeed,
    attackType: def.attackType,
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
