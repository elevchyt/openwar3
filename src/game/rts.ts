import { WidgetState } from "mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/widget";
import { SimWorld, weaponsFromDef, type WorkerState, type SimUnit, type SimMine, type BuildingState, type QueuedOrder, type RallyKind, type SimAbility, type HeroInit } from "../sim/world";
import { KNOWN_ABILITIES } from "../data/abilities";
import { ORDER_IDS, orderIdToString } from "../jass/orders";
import { footprintCells, PATHING_CELL, type PathingGrid } from "../sim/pathing";
import { VisionMap, FogState, fogStateOf } from "../sim/vision";
import { AllianceTable } from "../sim/alliances";
import type { HeightSampler, FootprintMaxSampler } from "./heightmap";
import type { UnitRegistry, UnitDef } from "../data/units";
import { ArmorType, AttackType, MoveType, PrimaryAttribute } from "../data/enums";
import { MELEE, xpToReachLevel } from "../data/gameplayConstants";
import { type AbilityRegistry, type AbilityDef } from "../data/abilities";
import { resolveTipRefs } from "../data/tipRefs";
import { type ItemRegistry } from "../data/items";
import { WORKERS, DEPOT_IDS } from "../data/races";
import { type TechRegistry } from "../data/techtree";
import { type UpgradeRegistry } from "../data/upgrades";
import type { SoundBoard, SoundCategory } from "../audio/sounds";
import { worldLayer } from "../ui/stage";

// Ties the headless SimWorld to the rendered map (plan §5 vertical slice):
// seeds movable units from the loaded map, syncs sim state → model instances
// each frame, and handles click-to-select / right-click-to-move picking.
// Keeps the sim authoritative; the instances just display it.

// Minimal shapes for the mdx-m3-viewer bits we drive.
interface Instance {
  localLocation: Float32Array;
  localRotation: Float32Array;
  frame: number;
  sequenceEnded: boolean; // mdx-m3-viewer: true once a non-looping clip finishes (drives the idle fidget re-roll)
  setLocation(v: ArrayLike<number>): unknown;
  setRotation(q: ArrayLike<number>): unknown;
  setSequence(i: number): unknown;
  setSequenceLoopMode(m: number): unknown;
  setUniformScale(s: number): unknown;
  setTeamColor?(id: number): unknown; // re-tint team-coloured parts (SetUnitColor/SetUnitOwner)
  setBlendTime?(seconds: number): unknown; // per-unit animation cross-fade (UnitUI `blend`)
  hide(): void;
  show(): void;
  vertexColor?: Float32Array; // MDX tint; multiplied by fog brightness to dim in fog
  setVertexColor?(c: ArrayLike<number>): unknown;
  model: { sequences: Array<{ name: string; interval?: ArrayLike<number> }> };
}
interface MapUnit {
  instance: Instance;
  row?: { string(k: string): string | undefined; number(k: string): number };
  // mdx-m3-viewer's Widget.update() auto-plays a Stand clip whenever state is IDLE,
  // so anything we drive ourselves (walk, attack, death, cast) must sit in WALK.
  state: WidgetState;
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
  invulnerable: boolean; // immune to damage — red "Invulnerable" line in the HUD (issue #26)
  damageMin: number; // BASE damage range (without buff bonuses)
  damageMax: number;
  damageBonus: number; // green "+N" attack damage from buffs/auras
  attackType: AttackType; // → the damage-table row (info-card icon)
  armorType: ArmorType; // → the damage-table column (info-card icon)
  isHero: boolean;
  properName: string; // hero's given name ("Painkiller"); "" for non-heroes
  level: number;
  xp: number; // hero current experience
  xpThis: number; // XP threshold for the current level
  xpNext: number; // XP threshold for the next level (== xpThis at max level)
  skillPoints: number; // unspent hero skill points
  strength: number; // base attribute (item bonus excluded)
  agility: number;
  intelligence: number;
  strengthBonus: number; // item contribution (green "+N" / red "-N")
  agilityBonus: number;
  intelligenceBonus: number;
  primaryAttr: PrimaryAttribute; // None for non-heroes
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
  isItem: boolean; // a selected ground item (show name + description instead of stats)
  description: string; // item description (Ubertip), shown when isItem
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
  isBuilding?: boolean; // draw the square bracket ring (SelectionCircleBuilding) vs the round one
}

// Resolved animation-sequence indices for a unit. Worker carry/chop variants
// fall back to the base clip when a model lacks them.
interface AnimSet {
  stand: number;
  standVariants: number[]; // all plain idle stands ("Stand"/"Stand - N"); the idle fidget cycles them
  walk: number;
  attack: number;
  attackVariants: number[]; // empty-handed combat-attack clips; a random one plays per swing
  attackGold: number[]; // "Attack Gold" — the swing while carrying gold (fallback: base attack)
  attackLumber: number[]; // "Attack Lumber" — the swing while carrying lumber (fallback: base attack)
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

// The `Animprops` tokens that select a tiered building's LOOK. A tiered structure is a single
// model carrying every tier as sequences — TownHall.mdx holds "Stand" (Town Hall), "Stand
// Upgrade First" (Keep) and "Stand Upgrade Second" (Castle); HumanTower.mdx holds the Scout,
// Guard, Cannon and Arcane towers the same way — and the unit's Animprops name its own set.
// This is the whole closed vocabulary used for tiers across the 1.27a data.
//
// `alternate`/`alternateex` (alternate forms) and `swim` are also Animprops, but they are
// STATE, not identity: a unit plays them only while transformed or in water, so they are not
// handled here (the sequence pickers below already exclude swim clips outright — issue #38).
const TIER_PROPS = new Set(["upgrade", "first", "second", "third", "fourth", "fifth"]);

/** Rewrite the sequence names a unit is ALLOWED to see, so every lookup below can stay
 *  tier-blind: a tiered unit's own clips are renamed to their base action ("Stand Upgrade
 *  First" simply becomes the Keep's "Stand"), and clips belonging to other tiers are blanked
 *  so nothing can match them. Indices are preserved throughout — they index the live model's
 *  sequence array — and an untiered unit gets its list back untouched.
 *
 *  Three things about real WC3 sequence names make this fiddlier than it sounds, all of them
 *  visible in HumanTower.mdx (the Scout/Guard/Cannon/Arcane towers are one model):
 *
 *    "Stand Ready Attack"                 the Scout Tower — no tier tokens at all
 *    "Stand Upgrade First Ready Attack"   the Guard Tower
 *    "Attack Stand  Ready Upgrade Second" the Cannon Tower — tokens REORDERED, double space
 *    "Stand Upgrade Third Attack Ready"   the Arcane Tower — reordered again
 *    "Birth Upgrade First Second third"   ONE birth clip SHARED by all three upgraded tiers
 *
 *  So: (1) a clip is mine when my tier tokens are all present in it — a superset test, which is
 *  what lets the shared "First Second third" birth serve the Guard, Cannon and Arcane towers
 *  alike; (2) a clip with no tier tokens stays available as a fallback (Death and Decay have no
 *  per-tier variant, so every tier shares them); and (3) that fallback is blanked only when my
 *  tier has its own version of the same action — compared as an unordered SET of base tokens,
 *  because "Stand Ready Attack" and "Stand Upgrade Third Attack Ready" name the same action in
 *  a different word order, and an order-sensitive test leaves the Arcane Tower wearing the
 *  Scout Tower's model. */
function applyAnimProps(seqs: Array<{ name: string }>, animProps: string[] = []): Array<{ name: string }> {
  const tier = animProps.filter((p) => TIER_PROPS.has(p));
  if (!tier.length) return seqs;
  const BLANK = "(none)"; // matches none of the sequence patterns below
  const tokens = (n: string) => n.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
  const propsOf = (n: string) => tokens(n).filter((t) => TIER_PROPS.has(t));
  const baseOf = (n: string) => tokens(n).filter((t) => !TIER_PROPS.has(t)); // original order kept
  const baseKey = (n: string) => [...baseOf(n)].sort().join(" "); // ...but compared unordered
  const isMine = (n: string) => {
    const p = propsOf(n);
    return p.length > 0 && tier.every((t) => p.includes(t));
  };
  return seqs.map((s) => {
    if (isMine(s.name)) return { name: baseOf(s.name).join(" ") };
    if (propsOf(s.name).length) return { name: BLANK }; // some other tier's clip
    // A tier-less clip: shared (Death/Decay) unless my tier overrides this same action.
    const overridden = seqs.some((o) => isMine(o.name) && baseKey(o.name) === baseKey(s.name));
    return overridden ? { name: BLANK } : s;
  });
}

function buildAnimSet(raw: Array<{ name: string }>, animProps: string[] = []): AnimSet {
  const seqs = applyAnimProps(raw, animProps);
  const find = (re: RegExp): number => seqs.findIndex((s) => re.test(s.name));
  const indices = (re: RegExp): number[] =>
    seqs.map((s, i) => ({ n: s.name, i })).filter(({ n }) => re.test(n)).map(({ i }) => i);
  // The "plain" idle-stand / auto-attack clips: the base name or a numbered variant
  // ("Stand", "Stand - 2", "Attack -1"), with NO trailing word. Everything with a WORD
  // after it is a context/state clip and is deliberately excluded: "* Swim" (only while
  // swimming — which never happens here, water is unwalkable; a land unit playing its swim
  // swing/idle is the bug in issue #38), "* Gold"/"* Lumber" (carry pose, chosen by carry
  // state), "Stand Ready"/"Stand Victory"/"Stand Defend"/"Stand Work" and "Attack Defend"
  // /"Attack Alternate"/"Attack Slam" (ability/stance clips, not the idle/attack loop).
  // `standVariants` is the full plain-stand set; the idle fidget cycles through it (we drive
  // that ourselves — our units are raw MdxComplexInstances, NOT mdx-m3-viewer Widgets, so its
  // Widget.update → randomStandSequence never runs). `stand` is the FIRST plain stand, the
  // canonical idle (never a swim/carry clip). Attack swings ARE randomized here (swing-driven,
  // below). Verified against real 1.27a models — Footman "Stand - 1/2/4", Peasant
  // "Stand/-2/-3/-4", Naga "Stand"+"Stand - 2" alongside its Swim/Ready variants (issue #38).
  const PLAIN_STAND = /^stand(\s*-?\s*\d+)?\s*$/i;
  const PLAIN_ATTACK = /^attack(\s*-?\s*\d+)?\s*$/i;
  const standVariants = indices(PLAIN_STAND);
  const attackVariants = indices(PLAIN_ATTACK);
  const stand = standVariants.length
    ? standVariants[0]
    : find(/^stand(\s|$|-)/i) >= 0
      ? find(/^stand(\s|$|-)/i)
      : find(/^stand/i);
  const walk = find(/^walk\s*$/i) >= 0 ? find(/^walk\s*$/i) : find(/walk/i);
  const attack = attackVariants.length
    ? attackVariants[0]
    : find(/^attack\s*$/i) >= 0
      ? find(/^attack\s*$/i)
      : find(/attack/i);
  // Carry-attack swings, chosen by the worker's carried resource (issue #35). "* Swim"
  // is excluded here too so a laden worker never swings a swim clip.
  const carryAttack = seqs
    .map((s, i) => ({ n: s.name, i }))
    .filter(({ n }) => /attack/i.test(n) && !/defend|alternate|slam|swim/i.test(n));
  const attackGold = carryAttack.filter(({ n }) => /gold/i.test(n)).map(({ i }) => i);
  const attackLumber = carryAttack.filter(({ n }) => /lumber/i.test(n)).map(({ i }) => i);
  const or = (a: number, b: number) => (a >= 0 ? a : b);
  return {
    stand,
    standVariants: standVariants.length ? standVariants : stand >= 0 ? [stand] : [],
    walk,
    attack,
    attackVariants: attackVariants.length ? attackVariants : attack >= 0 ? [attack] : [],
    attackGold,
    attackLumber,
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
  // Building footprint half-extents in WORLD units (0 for mobile units). When set, the
  // render Z seats the structure on the tallest terrain its footprint spans (issue #15).
  footHalfW: number;
  footHalfH: number;
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
  aoeHi?: boolean; // last AoE-target green-tint state applied (avoids redundant setVertexColor)
}

// Green multiply-tint on a unit's whole mesh while it's a valid target of an armed
// AoE spell (issue #20) — the same idea as the dark-blue "about to be built" ghost
// (PENDING_GHOST_TINT), so a caught unit reads clearly as "this will be hit".
const AOE_TARGET_TINT = [0.25, 1.0, 0.25] as const;

/** The "Birth" construction sequence + its frame interval, if the model has one. */
function findBirthFields(
  seqs: Array<{ name: string; interval?: ArrayLike<number> }>,
  animProps: string[] = [],
): {
  birthSeq: number;
  birthStart: number;
  birthEnd: number;
} {
  // A tiered building has its OWN birth clip ("Birth Upgrade First" is the Keep rising out of
  // the Town Hall), so the construction animation has to be picked per tier too.
  const named = applyAnimProps(seqs, animProps);
  const birthSeq = named.findIndex((s) => /^birth$/i.test(s.name));
  const iv = birthSeq >= 0 ? seqs[birthSeq].interval : undefined;
  return { birthSeq, birthStart: iv ? iv[0] : 0, birthEnd: iv ? iv[1] : 0 };
}

// Brightness of a remembered-but-not-seen building in fog — matches the ground veil's
// EXPLORED_DARK (0.5) so a greyed structure sits at the same dimness as its terrain.
const FOG_EXPLORED_BRIGHT = 0.5;

/** Where a fog modifier applies (7.22). common.j offers both shapes and they are not
 *  interchangeable: `CreateFogModifierRect` takes a rect, `CreateFogModifierRadius[Loc]`
 *  a centre + radius. */
export type FogArea =
  | { kind: "rect"; minX: number; minY: number; maxX: number; maxY: number }
  | { kind: "circle"; x: number; y: number; radius: number };

/** A script-placed fog-of-war modifier: hold `area` at `state` for `player`, while
 *  `running`. `state` is the raw common.j fogstate (1 MASKED / 2 FOGGED / 4 VISIBLE). */
export interface FogModifier {
  player: number;
  state: number;
  area: FogArea;
  running: boolean;
}
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
// mdx-m3-viewer sequence loop modes, named from its ModelInstance code (its own doc
// comment is stale). The mode is not "how many times to play" — it decides who wins
// when the clip ends: the model's own MDX looping flag, or us.
enum SequenceLoopMode {
  /** Obey the clip's MDX `nonLooping` flag — Stands loop, Attack/Death clips play once. */
  ModelDefined = 0,
  /** Never loop: play once, hold the final frame, raise `sequenceEnded`. Forces a
   *  normally-looping clip (a Stand) to END so we can re-roll the next idle-stand
   *  variant when it finishes — the fidget cycle, issue #38. */
  PlayOnce = 1,
  /** Always loop, even a clip the model marks non-looping. */
  Loop = 2,
}
// WC3's selection circle diameter ≈ 72 world units at selection scale 1.0.
const SEL_RADIUS_PER_SCALE = 36;
// Re-clicking the same single unit this many extra times flips its selection
// voice from "What" to the annoyed "Pissed" set (WC3's easter-egg escalation).
const PISSED_AFTER = 3;
// The gold-mine ring is drawn a bit larger than the mine's collision radius (which
// drives worker entry) so it reads as a ring hugging the mine base, not its footprint.
const MINE_RING_SCALE = 1.4;
const ITEM_PICK_RADIUS = 72; // click/hover pick radius around a ground item
const ITEM_RING_RADIUS = 40; // yellow selection/hover ring radius under a ground item
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
// Harsh, saturated red (green/blue near zero) so an attack/hostile click flash reads
// as aggressively red — matches the accentuated enemy hover/selection ring tint.
const FLASH_RED: [number, number, number] = [1, 0.08, 0.05];
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
// bars are always on screen (WC3's "always show health bars"). The bars are single
// solid fills — WC3's floating bars read as one continuous bar, not visible slices.
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
  // Into the world layer, whose box IS the canvas's — the bar's position is computed in
  // canvas CSS pixels, so parenting it to the window instead offsets every bar by the
  // letterbox (see ui/stage.ts).
  worldLayer().appendChild(root);
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
  private selectedItem: number | null = null; // a selected ground item (shows its info on the HUD)
  private aoeHighlight = new Set<number>(); // sim ids of units an armed AoE spell would hit (green-tinted)
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
  // Who is allied with whom (7.22). Seeded from the lobby's teams, then mutable by the
  // script (SetPlayerAlliance) — so "Player - Make X treat Y as an Ally" and shared
  // vision are real. The sim reads it through SimWorld.alliedPlayers (installed below).
  private alliances = new AllianceTable();
  // Players whose units are REVEALED to the local player — blizzard.j's `CripplePlayer`
  // (what MeleeExposePlayer does to a player whose crippled timer ran out: their units
  // show through the fog to every opponent). Keyed by player slot.
  private exposed = new Set<number>();
  // Script-placed fog modifiers (CreateFogModifierRect/Radius). A modifier holds an area
  // at a fogstate FOR ONE PLAYER; only those belonging to a player whose sight we render
  // (the local player, or a team-mate) touch our grid. Created STOPPED — FogModifierStart
  // is what runs one (the same "the BJ shows it, the native doesn't" shape as timer
  // dialogs), so `running` is not a formality.
  private fogModifiers = new Map<number, FogModifier>();
  private nextFogModifier = 1;
  private hovered: number | null = null;
  private hoveredMine: number | null = null; // a gold mine under the cursor (neutral)
  private hoveredItem: number | null = null; // a ground item under the cursor (yellow hover ring)
  private previewIds: number[] = []; // units under the live drag-box (marquee preview rings)
  private neutralPositions: Array<{ x: number; y: number }> = []; // Neutral Passive sites (from the doo)
  private creepData: Array<{ x: number; y: number; aggro: number; drops?: Array<{ items: Array<{ id: string; chance: number }> }> }> = []; // Neutral Hostile guard/aggro/drop data (from the doo)
  // Custom-map pre-placed PLAYER units (war3mapUnits.doo, owner slots 0–11). Unlike
  // creeps (owner -1) these are seeded OWNED + simulated, so the local player's own
  // units lift the fog of war (issue #33) and are selectable/commandable. Empty on
  // melee maps (which pre-place no player units — WC3 spawns those at runtime).
  private playerSeeds: Array<{ x: number; y: number; owner: number; team: number }> = [];
  private seedingEnabled = false; // gate: don't adopt map units until start setup (teams/local player) is ready
  private seeded = false; // true once trySeed has run at least one scan (creepCamps gate)
  // Melee start-location clear zones (blizzard.j MeleeClearExcessUnits): each USED
  // start location clears the map's Neutral Hostile creeps (and non-structure
  // Neutral Passive critters) within bj_MELEE_CLEAR_UNITS_RADIUS, so a player's
  // base spawns on clean ground. Unused start locations keep their creep camp
  // (that's how a 4-player map played by 2 leaves the empty corners creeped).
  // Set at melee start; empty on custom maps (they run their own triggers).
  private startClearZones: Array<{ x: number; y: number; r2: number }> = [];
  // Instances trySeed cleared as excess (never seeded, hidden for good). The fog
  // pass must skip these too, so managesViewerInstance covers them as well.
  private clearedInstances = new Set<unknown>();
  // Map-placed unit instances trySeed has already handled (seeded OR deliberately
  // skipped). The viewer pushes each Unit into map.units only AFTER its model
  // finishes loading (async), so we adopt them progressively rather than in a
  // single racing pass — see trySeed.
  private processedInstances = new Set<object>();
  private lastSeenUnitCount = -1; // map.units length at the last scan (grows as models stream in)
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
    private items: ItemRegistry,
    private tech: TechRegistry,
    private upgrades: UpgradeRegistry,
    // Highest terrain height across a building's footprint — used to seat structures
    // on the tallest level they touch instead of the (often lower) centre (issue #15).
    private footMaxHeight: FootprintMaxSampler,
  ) {
    // Registries power casting/learning/auras + items, and (issue #57) the tech tree:
    // requirements, research effects and shop stock.
    this.sim = new SimWorld(grid, 1, this.abilities, this.items, this.registry, this.tech, this.upgrades);
    // Fog-of-war grid, aligned to the same world origin as the pathing grid and
    // spanning the whole map (pathing is 32-unit cells; span = cells × 32).
    const [vox, voy] = grid.origin;
    this.vision = new VisionMap(vox, voy, grid.width * PATHING_CELL, grid.height * PATHING_CELL);
    // Gate the sim's auto-acquisition on the fog of war (issue #17): idle units only
    // aggro enemies their team can actually SEE. Only the local team's sight is
    // modelled, so other teams pass through as visible (unchanged behaviour).
    this.sim.visibleToTeam = (team, x, y) =>
      team !== this.localTeam || this.vision.stateAt(x, y) === FogState.Visible;
    // …and on terrain: a treeline or cliff between watcher and target blinds the watcher,
    // whatever team it's on. This is what stops ranged creeps shooting a hero standing on
    // the far side of a forest they cannot see through.
    this.sim.lineOfSight = (x1, y1, x2, y2, flying) => this.vision.hasLineOfSight(x1, y1, x2, y2, flying);
    // Allegiance between two PLAYER slots comes from the alliance matrix, not the team
    // (7.22) — so a script that allies two players actually stops them fighting. Creeps
    // (owner < 0) are excluded by SimWorld.playerAllegiance and keep the team rule.
    this.sim.alliedPlayers = (a, b) => this.alliances.coAllied(a, b);
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

  /** Seed the alliance matrix from the lobby's teams (7.22). Called once start setup
   *  knows who is on which team, BEFORE the map script runs — so the script's own
   *  `SetPlayerAlliance` calls land on top of it rather than under it. */
  seedAlliances(teamOf: (player: number) => number): void {
    this.alliances.seedFromTeams(teamOf);
  }

  /** JASS SetPlayerAlliance / GetPlayerAlliance. */
  setPlayerAlliance(source: number, other: number, type: number, value: boolean): void {
    this.alliances.set(source, other, type, value);
  }
  getPlayerAlliance(source: number, other: number, type: number): boolean {
    return this.alliances.get(source, other, type);
  }
  /** blizzard.j's PlayersAreCoAllied — what IsPlayerAlly and every ally count read. */
  playersAreCoAllied(a: number, b: number): boolean {
    return this.alliances.coAllied(a, b);
  }

  /** JASS `CripplePlayer(whichPlayer, toWhichPlayers, flag)` — reveal (or re-hide) a
   *  player's units to a set of players. This is NOT shared vision: shared vision lends
   *  you a player's SIGHT (you see through their units' eyes), whereas a cripple/expose
   *  reveals that player's own units *to* you, wherever they stand. It is what melee
   *  does to a player whose "Build Town Hall" timer runs out (blizzard.j
   *  MeleeExposePlayer → CripplePlayer(p, everyoneNotCoAllied, true)).
   *
   *  We render one viewpoint, so only the local player's membership of the force matters. */
  cripplePlayer(player: number, toPlayers: readonly number[], flag: boolean): void {
    if (!toPlayers.includes(this.localPlayer)) return;
    if (flag) this.exposed.add(player);
    else this.exposed.delete(player);
  }

  /** CreateFogModifierRect / CreateFogModifierRadius[Loc] — created STOPPED (the native
   *  does not start it; FogModifierStart does). Returns the modifier's id. */
  createFogModifier(m: Omit<FogModifier, "running">): number {
    const id = this.nextFogModifier++;
    this.fogModifiers.set(id, { ...m, running: false });
    return id;
  }
  fogModifierStart(id: number): void {
    const m = this.fogModifiers.get(id);
    if (m) m.running = true;
  }
  fogModifierStop(id: number): void {
    const m = this.fogModifiers.get(id);
    if (m) m.running = false;
  }
  destroyFogModifier(id: number): void {
    this.fogModifiers.delete(id);
  }

  /** SetFogStateRect / SetFogStateRadius[Loc] — a ONE-SHOT stamp, not a standing
   *  modifier: it changes the fog where it lands and then lets the grid carry on. On our
   *  rebuilt-every-tick `visible` layer a one-shot VISIBLE therefore only *lights* the
   *  area for an instant — but `explored` is sticky, so the lasting effect is that the
   *  area is discovered (grey), and a one-shot MASKED un-discovers it. That is what the
   *  native is used for in practice; a script that wants an area held open uses a
   *  modifier, which is exactly the distinction the two APIs exist to draw. */
  setFogState(player: number, state: number, area: FogArea): void {
    if (!this.seesFor(player)) return;
    this.stampFogArea(area, fogStateOf(state));
  }

  /** FogEnable / FogMaskEnable — the grey veil and the black mask, switched globally,
   *  and the IsFog*Enabled getters a cinematic saves and restores them through (7.24). */
  setFogEnabled(on: boolean): void {
    this.vision.setFogEnabled(on);
  }
  setFogMaskEnabled(on: boolean): void {
    this.vision.setMaskEnabled(on);
  }
  isFogEnabled(): boolean {
    return this.vision.isFogEnabled();
  }
  isFogMaskEnabled(): boolean {
    return this.vision.isMaskEnabled();
  }

  /** Does the local viewpoint render `player`'s fog? True for the local player and any
   *  team-mate — the grid is per-TEAM, so a modifier placed on an ally's fog shows up in
   *  ours, and one placed on an opponent's is invisible here (correctly: it is their fog,
   *  not ours). */
  private seesFor(player: number): boolean {
    return player === this.localPlayer || this.teamOfPlayer(player) === this.localTeam;
  }

  /** The team a player slot is on, as the sim knows it (any unit they own carries it).
   *  Falls back to the slot number, matching mapViewer.teamOf's own default. */
  private teamOfPlayer(player: number): number {
    for (const u of this.sim.units.values()) if (u.owner === player) return u.team;
    return player;
  }

  private stampFogArea(area: FogArea, state: FogState): void {
    if (area.kind === "rect") this.vision.stampRect(area.minX, area.minY, area.maxX, area.maxY, state);
    else this.vision.stampCircle(area.x, area.y, area.radius, state);
  }

  /** The fog-of-war grid — read by the minimap (HUD) and the 3D fog overlay. */
  getVision(): VisionMap {
    return this.vision;
  }

  /** True if the RTS drives this viewer instance's fog visibility (seeded neutral
   *  shop or creep). The map renderer skips these when fog-hiding static widgets. */
  managesViewerInstance(inst: unknown): boolean {
    return this.seededInstances.has(inst) || this.clearedInstances.has(inst);
  }

  /** Melee-only: register the USED start locations so trySeed clears the creep
   *  camps (and non-structure critters) the map placed on them, matching
   *  blizzard.j MeleeClearExcessUnits. Call before the seeding scans run; unused
   *  start locations are simply omitted, so their camps survive. */
  setStartLocationClearZones(centers: Array<{ x: number; y: number }>, radius = MELEE.MELEE_CLEAR_UNITS_RADIUS): void {
    const r2 = radius * radius;
    this.startClearZones = centers.map((c) => ({ x: c.x, y: c.y, r2 }));
  }

  /** True when (x,y) is within a used start location's melee clear radius. */
  private inStartClearZone(x: number, y: number): boolean {
    for (const z of this.startClearZones) {
      const dx = x - z.x;
      const dy = y - z.y;
      if (dx * dx + dy * dy <= z.r2) return true;
    }
    return false;
  }

  /** Remove a map-placed unit's viewer instance as melee "excess" (a creep camp or
   *  critter sitting on a used start location): hide it for good and take over its
   *  visibility so the fog pass never shows it again. It is never seeded, so it has
   *  no sim presence — exactly the effect of blizzard.j RemoveUnit. */
  private clearExcessInstance(inst: { hide(): void }): void {
    inst.hide();
    this.clearedInstances.add(inst);
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
      if (!this.revealsForLocal(u)) continue;
      const r = (day ? u.sightDay : u.sightNight) || u.sightDay || 800;
      this.vision.reveal(u.x, u.y, r, u.flying); // flyers see over terrain/trees
    }
    // An enemy that shot at us out of the fog gives its position away for a second
    // (MiscData FoggedAttackRevealRadius) — so you see what is hitting you, and it
    // fades again if it stops. `flying` reveals over the treeline it fired through.
    for (const r of this.sim.activeAttackReveals()) {
      if (r.team !== this.localTeam) continue; // only OUR side learns where it came from
      this.vision.reveal(r.x, r.y, r.radius, r.flying);
    }
    // Script-placed fog modifiers are stamped LAST, over everything the units revealed —
    // that's what lets a running FOG_OF_WAR_VISIBLE modifier light ground nobody stands
    // near (a TD showing you its whole maze) and a FOG_OF_WAR_MASKED one black out ground
    // you are standing in (a cinematic area). Re-applied every rebuild, since the
    // `visible` layer is cleared and recomputed each time.
    for (const m of this.fogModifiers.values()) {
      if (!m.running || !this.seesFor(m.player)) continue;
      this.stampFogArea(m.area, fogStateOf(m.state));
    }
    this.pruneFogged(); // whatever the new fog swallowed leaves the selection (issue #62)
  }

  /** Does this unit's sight lift OUR fog? Your own team always does. Beyond that, a
   *  player who grants the local player ALLIANCE_SHARED_VISION lends us their units'
   *  eyes — which is the whole point of the setting, and what the GUI's "Player - Make X
   *  treat Y as an Ally (with shared vision)" turns on. */
  private revealsForLocal(u: SimUnit): boolean {
    if (u.team === this.localTeam) return true;
    return u.owner >= 0 && this.alliances.sharesVisionWith(u.owner, this.localPlayer);
  }

  /** Install the fog's line-of-sight height field + tree blockers, so vision is
   *  shadowed by high ground and treelines. Called once the map's trees are seeded.
   *  `cliffHeightAt` is the CLIFF-LEVEL sampler (makeCliffLevelSampler), not the full
   *  terrain height — only real cliff levels block WC3 sight, not rolling groundHeight
   *  (see hiveworkshop "About high ground advantage" #255594). */
  initVisionBlockers(cliffHeightAt: HeightSampler): void {
    this.vision.setHeightField((x, y) => cliffHeightAt(x, y));
    for (const tree of this.sim.trees.values()) this.vision.addTreeBlocker(tree.x, tree.y, tree.blockRadius);
  }

  /** A tree was felled — it stops blocking sight (harvesting can open a sight line).
   *  `radius` must match the one it was stamped with, so it releases its own cells. */
  onTreeFelled(x: number, y: number, radius: number): void {
    this.vision.removeTreeBlocker(x, y, radius);
  }

  /** Should this unit's model be hidden by the fog of war right now? Your own team
   *  is always visible. Enemy/neutral STRUCTURES persist once explored (WC3 shows
   *  the last-seen building greyed in fog); mobile units and critters vanish unless
   *  currently in sight — "concealing enemy movements". */
  private fogHides(u: SimUnit): boolean {
    if (this.vision.revealed) return false;
    if (u.team === this.localTeam && !u.neutralPassive) return false;
    // An EXPOSED player (blizzard.j CripplePlayer — the melee cripple timer ran out) has
    // every unit revealed to us wherever it stands, fog or no fog. That is the punishment
    // itself, and it is the one thing that can show an enemy unit through black fog.
    if (u.owner >= 0 && this.exposed.has(u.owner)) return false;
    if (u.building != null) {
      const [cx, cy] = this.vision.worldToCell(u.x, u.y);
      return !this.vision.isExplored(cx, cy);
    }
    return this.vision.stateAt(u.x, u.y) !== FogState.Visible;
  }

  /** May the local player CLICK this unit right now — select it, hover it, aim an order at
   *  it? A different question from whether its model is drawn (fogHides), and the difference
   *  is the whole of issue #62: a structure you have explored KEEPS its image in the fog,
   *  because WC3 leaves the last thing you saw standing there, but the image is a MEMORY, not
   *  eyes on the building. You can see the Goblin Merchant across the map; you cannot shop at
   *  it, select it, or send a unit to attack it, until something of yours is actually looking.
   *  So: your own units always; an EXPOSED player's units (the melee cripple penalty reveals
   *  them wherever they stand); and otherwise only what your team currently sees. */
  private fogBlocksClick(u: SimUnit): boolean {
    if (this.vision.revealed) return false;
    if (u.team === this.localTeam && !u.neutralPassive) return false;
    if (u.owner >= 0 && this.exposed.has(u.owner)) return false;
    return this.vision.stateAt(u.x, u.y) !== FogState.Visible;
  }

  /** The same test for a GOLD MINE, which is not a sim unit and so has its own pick path (it is
   *  found from the ground point, not from the unit entries — see mineAt). A mine is a building
   *  like any other: the fog keeps its image once you have explored it, but the image is not the
   *  mine. You cannot select it, hover it, send a worker into it or rally to it until something
   *  of yours is looking at it. */
  private fogBlocksMine(m: { x: number; y: number }): boolean {
    if (this.vision.revealed) return false;
    return this.vision.stateAt(m.x, m.y) !== FogState.Visible;
  }

  /** The gold mine at a ground point — the ONLY way a mine is picked, so that the fog gate holds
   *  for every click that can land on one (select, hover, right-click harvest, rally). */
  private mineAt(x: number, y: number, radius: number): SimMine | null {
    const m = this.sim.nearestMine(x, y, radius);
    return m && !this.fogBlocksMine(m) ? m : null;
  }

  /** Anything that has slipped into the fog leaves the selection and the hover (issue #62).
   *  WC3 never lets you keep watching through the fog: the moment your last eye on a unit
   *  closes it drops out of your selection — and a remembered building drops with it, even
   *  though its image stays standing on the terrain. Run off the vision rebuild, so it costs
   *  one pass over a ≤12-unit selection every 0.1s. */
  private pruneFogged(): void {
    for (const id of [...this.selected]) {
      const u = this.sim.units.get(id);
      if (u && this.fogBlocksClick(u)) this.deselect(id);
    }
    if (this.hovered !== null) {
      const u = this.sim.units.get(this.hovered);
      if (u && this.fogBlocksClick(u)) this.hovered = null;
    }
    // A selected gold mine drops out the same way the moment its last watcher leaves.
    const sm = this.selectedMine !== null ? this.sim.mines.get(this.selectedMine) : null;
    if (sm && this.fogBlocksMine(sm)) this.selectedMine = null;
    const hm = this.hoveredMine !== null ? this.sim.mines.get(this.hoveredMine) : null;
    if (hm && this.fogBlocksMine(hm)) this.hoveredMine = null;
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
    const exposed = u.owner >= 0 && this.exposed.has(u.owner); // CripplePlayer: shown, not remembered
    if (!this.vision.revealed && !exposed && u.team !== this.localTeam && this.vision.stateAt(u.x, u.y) !== FogState.Visible) {
      b = FOG_EXPLORED_BRIGHT; // remembered-but-not-seen → half-bright grey
    }
    // Green whole-mesh tint while this unit is a valid target of an armed AoE spell.
    const hi = this.aoeHighlight.has(e.simId);
    if (e.fogTintB === b && e.aoeHi === hi) return; // unchanged since last tick
    e.fogTintB = b;
    e.aoeHi = hi;
    if (!e.baseColor) {
      const c = inst.vertexColor;
      e.baseColor = c ? new Float32Array([c[0], c[1], c[2], c[3]]) : new Float32Array([1, 1, 1, 1]);
    }
    const base = e.baseColor;
    const g = hi ? AOE_TARGET_TINT : ([1, 1, 1] as const);
    inst.setVertexColor([base[0] * b * g[0], base[1] * b * g[1], base[2] * b * g[2], base[3]]);
  }

  /** Wire the voice/sound board (owned by the host, which has the VFS). */
  setSoundBoard(sounds: SoundBoard | null): void {
    this.sounds = sounds;
  }

  /** Play the focused unit's selection voice — "What", escalating to "Pissed"
   *  after PISSED_AFTER consecutive re-clicks of the SAME single unit. Only your
   *  own units talk back (enemy/neutral clicks are silent, like WC3). */
  private announceSelection(): void {
    const e = this.primary !== null ? this.byId.get(this.primary) : undefined;
    const u = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
    const own = !!e && !!u && u.owner === this.localPlayer;
    const single = own && this.selected.size === 1;
    // Escalation counter is per single own unit. Selecting anything else — a different
    // unit, an enemy/neutral, a group, or nothing selectable — resets it, so the next
    // re-click restarts at "What" (matches WC3's annoyed easter-egg). Staying on the
    // SAME single unit preserves the streak (advanced below, per line actually played).
    if (!single || this.primary !== this.lastVoiceId) {
      this.voiceStreak = 0;
      this.lastVoiceId = single ? this.primary : null;
    }
    if (!this.sounds || !own || !e) return; // enemy/neutral/empty: state reset above, no voice
    const def = this.registry.get(e.typeId);
    if (!def?.soundSet) return;
    const cat: SoundCategory = single && this.voiceStreak >= PISSED_AFTER ? "Pissed" : "What";
    // Count the streak by voice lines actually HEARD, not clicks: re-clicking while the
    // unit is still talking drops the line (play returns false), so it must not advance
    // the counter — otherwise click-spam races to "Pissed" without the intervening
    // "What"s ever playing. source = this unit → overlaps other units' lines.
    if (this.sounds.play(def.soundSet, cat, undefined, this.primary!) && single) this.voiceStreak++;
  }

  /** Play weapon-impact SFX for every hit landed this tick (attacker's weapon
   *  material vs target's armour material) plus lumber-chop SFX (worker's 2nd-weapon
   *  material vs Wood) — all sourced from the game's combat sounds. */
  private playImpacts(): void {
    if (!this.sounds) return;
    // A unit's own attack/fire sound (rifleman gunshot, mortar boom, dragon breath,
    // tower fire) lives on its MODEL as an SND "K" event — play it when the swing
    // fires. Melee units without such an event are silent here; their audible attack
    // is the weapon-impact clang below. Resolved authentically (AnimLookups→AnimSounds).
    for (const attackerId of this.sim.drainAttackSwings()) {
      const def = this.registry.get(this.byId.get(attackerId)?.typeId ?? "");
      const au = this.sim.units.get(attackerId);
      if (def?.model && au) this.sounds.playModelAttack(def.model, { x: au.x, y: au.y, z: this.heightAt(au.x, au.y) });
    }
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
    if (def?.soundSet) this.sounds.play(def.soundSet, attack ? "YesAttack" : "Yes", undefined, this.primary); // source = focused unit
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
  setCreepData(data: Array<{ x: number; y: number; aggro: number; drops?: Array<{ items: Array<{ id: string; chance: number }> }> }>): void {
    this.creepData = data;
  }

  /** The placed creep's editor target-acquisition at a position (-1 if none):
   *  -1 = use the unit's default acquisition, -2 = "Camp", >0 = a custom range. */
  private creepAggroAt(x: number, y: number): number {
    for (const p of this.creepData) if (Math.abs(p.x - x) < 48 && Math.abs(p.y - y) < 48) return p.aggro;
    return -1;
  }

  /** The placed creep's dropped-item table at a position (empty if none). */
  private creepDropsAt(x: number, y: number): Array<{ items: Array<{ id: string; chance: number }> }> {
    for (const p of this.creepData) if (Math.abs(p.x - x) < 48 && Math.abs(p.y - y) < 48) return p.drops ?? [];
    return [];
  }

  /** Register the world positions + owner/team of pre-placed PLAYER units (custom
   *  maps, war3mapUnits.doo owner 0–11). trySeed matches each rendered unit to this
   *  and adopts it as an OWNED sim unit (see seedPlayerUnit / issue #33). */
  setPlayerUnitSeeds(seeds: Array<{ x: number; y: number; owner: number; team: number }>): void {
    this.playerSeeds = seeds;
  }

  /** The owner/team of a pre-placed player unit at a position, or null. */
  private playerSeedAt(x: number, y: number): { owner: number; team: number } | null {
    for (const p of this.playerSeeds) if (Math.abs(p.x - x) < 48 && Math.abs(p.y - y) < 48) return { owner: p.owner, team: p.team };
    return null;
  }

  /** Open the seeding gate. Called once start setup (start locations / teams / local
   *  player / player seeds) is fully configured, so trySeed never adopts a map unit
   *  with stale owner/team data. Both startMelee and startCustom call this. */
  enableSeeding(): void {
    this.seedingEnabled = true;
  }

  /** The local player's current selection, as sim ids (JASS GroupEnumUnitsSelected). */
  selectedUnitIds(): number[] {
    return [...this.selected];
  }

  /** Drop the whole selection. JASS `ClearSelection`, and what cinematic mode does on the
   *  way in — a cinematic plays with nothing selected, so no selection ring or command card
   *  survives into the shot (7.24). */
  clearSelection(): void {
    this.selected.clear();
    this.selectedMine = null;
    this.selectedItem = null;
    this.primary = null;
    this.focusedKey = "";
  }

  /** JASS `SelectUnit(u, flag)` — add the unit to (or drop it from) the selection. WC3 ADDS,
   *  it does not replace: a script that wants a fresh selection calls ClearSelection first. */
  scriptSelect(simId: number, select: boolean): void {
    if (!select) {
      this.deselect(simId);
      return;
    }
    if (!this.sim.units.has(simId) || this.selected.has(simId)) return;
    this.selected.add(simId);
    if (this.primary === null) {
      this.primary = simId;
      this.focusedKey = this.groupKeyOf(simId);
    }
    this.announceSelection();
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

  /** Single-click a unit's icon in the multi-select grid. If the clicked unit's
   *  sub-group is NOT the focused one, just move focus onto it — like Tab — keeping the
   *  whole selection intact (no isolation, no voice). If it IS already focused, drill
   *  down to select only that one specific unit (leaving group mode). */
  selectGridUnit(simId: number): void {
    if (!this.selected.has(simId)) return;
    if (this.groupKeyOf(simId) === this.focusedKey) {
      this.selectSingle(simId); // already-focused group → isolate to just this unit
      return;
    }
    // A different sub-group: focus it (keep the full selection), staying silent since
    // focusing isn't a fresh selection — same as cycleFocus/Tab.
    this.focusedKey = this.groupKeyOf(simId);
    this.primary = this.firstOfGroup(this.focusedKey);
  }

  /** Shift-click a unit's grid icon: remove just that one unit from the CURRENT
   *  selection (this moment's group, not a saved control group). No-op when it isn't
   *  selected or is the last unit left (the grid only shows for a multi-selection). */
  deselectUnit(simId: number): void {
    if (!this.selected.has(simId) || this.selected.size <= 1) return;
    this.deselect(simId); // removes it + refocuses the primary if it was the one removed
  }

  /** Cycle focus to the next (Tab) or previous (Shift+Tab) sub-group. Tab only
   *  MOVES the focus within the existing selection — it is not a fresh selection, so
   *  the newly-focused units stay SILENT (no "What"), matching WC3. */
  cycleFocus(reverse = false): void {
    const groups = this.orderedGroups();
    if (groups.length <= 1) return;
    const n = groups.length;
    const i = groups.indexOf(this.focusedKey);
    this.focusedKey = groups[(((i + (reverse ? -1 : 1)) % n) + n) % n];
    this.primary = this.firstOfGroup(this.focusedKey);
  }

  /** Select ONLY this unit (double-clicking its icon in the multi-select grid). */
  selectSingle(simId: number): void {
    if (!this.sim.units.has(simId)) return;
    this.selected.clear();
    this.selectedMine = null;
    this.selectedItem = null;
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
    this.selectedItem = null;
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
    this.selectedItem = null;
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
    this.selectedItem = null;
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
    if (this.selectedItem !== null && !this.sim.items.has(this.selectedItem)) this.selectedItem = null;
  }

  /** Hide the floating health bars (e.g. when the map view is not active). */
  pause(): void {
    for (const b of this.hpBars) b.root.hidden = true;
  }

  /** Seed movable units (creeps) and neutral-passive sites from the map.
   *
   *  The viewer sets `unitsReady` synchronously but pushes each Unit into
   *  `map.units` only once its model has finished loading ASYNCHRONOUSLY. A
   *  one-shot pass therefore races the model loads and silently drops any
   *  creep/neutral whose model hasn't arrived yet — which is exactly what broke
   *  when map models moved to blob-url loading (issue #14): those loads resolve a
   *  frame or two later than the old in-memory promises, so the single seed pass
   *  saw an empty list. Instead we re-scan whenever the count grows and adopt each
   *  instance exactly once, so late-loading units are still picked up. */
  private trySeed(): void {
    if (!this.seedingEnabled) return; // wait until start setup configured teams/owners
    if (!this.host.unitsReady()) return;
    const units = this.host.units();
    if (units.length === this.lastSeenUnitCount) return; // no new instances since the last scan
    this.lastSeenUnitCount = units.length;
    for (const unit of units) {
      if (this.processedInstances.has(unit.instance)) continue; // already seeded/skipped
      this.processedInstances.add(unit.instance);
      const loc = unit.instance.localLocation;
      // A pre-placed ITEM (war3mapUnits.doo carries items alongside units — an item row has
      // `itemid` where a unit row has `unitid`, and the viewer renders both because its
      // unit table is UnitData + UnitUI + **ItemData**). Hide it: the map's OWN script
      // creates the real one (main() → CreateAllItems() → CreateItem), which spawns a live,
      // pickable sim item with its own model (7.18) — so the viewer's widget is a duplicate,
      // and a decorative one at that (it can't be picked up). Verified over the whole
      // bundled corpus: every map with .doo item entries also ships CreateAllItems(), so
      // deferring to the script never loses an item.
      const itemId = unit.row?.string("itemid");
      if (itemId && this.items.has(itemId)) {
        this.clearExcessInstance(unit.instance);
        continue;
      }
      const def = this.registry.get(unit.row?.string("unitid") ?? "");
      // Pre-placed PLAYER unit (custom map, owner 0–11): adopt it as an OWNED,
      // simulated unit (issue #33) — this is what gives the local player vision of
      // and control over their own units. Checked before the neutral/creep branches
      // (owners are disjoint) and before the movetp gate (so owned buildings seed too).
      const seed = def ? this.playerSeedAt(loc[0], loc[1]) : null;
      if (seed) {
        this.seedPlayerUnit(unit, def!, loc, seed.owner, seed.team);
        continue;
      }
      // Neutral Passive (shops/taverns/labs/merchants/fountains/critters): seed
      // it as a static, non-hostile, yellow-ringed selectable — even though it's
      // a building with no walk clip.
      if (this.isNeutralPassiveAt(loc[0], loc[1])) {
        // MeleeClearExcessUnit clears NON-structure Neutral Passive units (loose
        // critters) from a used start location, but leaves the structures (shops,
        // fountains, gold mines) standing. Match that: drop critters, keep buildings.
        if (!(def?.isBuilding ?? false) && this.inStartClearZone(loc[0], loc[1])) {
          this.clearExcessInstance(unit.instance);
          continue;
        }
        this.seedNeutral(unit, def, loc);
        continue;
      }
      const movetp = unit.row?.string("movetp");
      if (!movetp || movetp === "_" || movetp === "none") continue; // buildings/immovable
      const seqs = unit.instance.model.sequences;
      if (!seqs.some((s) => /walk/i.test(s.name))) continue; // no walk → treat as static
      // Neutral Hostile creep sitting on a USED start location: removed so the
      // player's base spawns clean (blizzard.j MeleeClearExcessUnits). Unused
      // start locations aren't zones, so their camps survive to guard the corner.
      if (this.inStartClearZone(loc[0], loc[1])) {
        this.clearExcessInstance(unit.instance);
        continue;
      }
      const anims = buildAnimSet(seqs, def?.animProps);
      unit.instance.setBlendTime?.(def?.animBlend ?? 0.15); // per-unit anim cross-fade (issue #8)
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
          flying: def?.moveType === MoveType.Fly,
          flyHeight: lift(def?.moveHeight ?? 0), // same lift as the Entry, so missiles match the model's altitude
          sightDay: def?.sightDay || 1400,
          sightNight: def?.sightNight || def?.sightDay || 800,
          hp: def?.hitPoints || 100,
          maxHp: def?.hitPoints || 100,
          mana: def?.mana ?? 0,
          maxMana: def?.mana ?? 0,
          armor: def?.armor ?? 0,
          armorType: def?.armorType ?? ArmorType.Unknown,
          weapons: def ? weaponsFromDef(def) : [],
          castPoint: def?.castPoint ?? 0,
          castBackswing: def?.castBackswing ?? 0,
          worker: null,
          depotGold: false,
          depotLumber: false,
        },
        null,
        { level: def?.level ?? 0, mechanical: def?.classification.includes("mechanical") ?? false, isPeon: def?.classification.includes("peon") ?? false },
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
      // Normal (-1) vs Camp (-2) — the World Editor's two-way "Target Acquisition Range"
      // radio (WorldEditStrings WESTRING_UPROPS_AR_NORMAL / _AR_CAMP). Melee mapmakers put
      // Normal on the gold-mine guards and Camp on everything else; a Camp creep ignores
      // the building-placement notification, so you can build beside it in peace.
      su.campGuard = aggro === -2;
      su.canSleep = def?.canSleep ?? false;
      this.sim.setUnitDrops(simId, this.creepDropsAt(loc[0], loc[1])); // scatter loot on death
      this.seededInstances.add(unit.instance); // RTS drives this creep's fog visibility
      const entry: Entry = {
        simId,
        unit,
        anims,
        moveHeight: lift(def?.moveHeight ?? 0),
        footHalfW: 0, // creeps are mobile — centre-sampled ground, no footprint seat
        footHalfH: 0,
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
        ...findBirthFields(unit.instance.model.sequences, def?.animProps),
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
      this.creepCampData = null; // a creep arrived — rebuild camp clusters lazily
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
        flyHeight: 0, // neutral-passive entities keep their map-placed Z
        sightDay: def?.sightDay || 1400,
        sightNight: def?.sightNight || def?.sightDay || 800,
        hp: def?.hitPoints || 100,
        maxHp: def?.hitPoints || 100,
        mana: 0,
        maxMana: 0,
        armor: def?.armor ?? 0,
        armorType: def?.armorType ?? ArmorType.Unknown,
        weapons: [],
        castPoint: 0, // neutral-passive structures never cast
        castBackswing: 0,
        worker: null,
        depotGold: false,
        depotLumber: false,
      },
      building,
      // Neutral shops/labs/merchants/taverns carry "Invulnerable (Neutral)" (Avul) in
      // their abilList — permanently immune + untargetable (issue #26).
      { baseInvulnerable: !!def?.abilities.includes("Avul") },
    );
    u.neutralPassive = true;
    const entry: Entry = {
      simId,
      unit,
      anims: buildAnimSet(unit.instance.model.sequences, def?.animProps),
      moveHeight: 0,
      footHalfW: 0, // neutral-passive buildings keep their map-placed Z (not driven here)
      footHalfH: 0,
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
      ...findBirthFields(unit.instance.model.sequences, def?.animProps),
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

  /** Adopt a pre-placed PLAYER unit (custom map) as an OWNED, simulated unit by
   *  reusing the viewer's already-rendered .doo instance — the same instance-reuse
   *  trySeed does for creeps, but owned instead of neutral. This is what lifts the
   *  fog over the local player's own units and makes them selectable (issue #33).
   *  addUnit builds the full sim unit (buildings included) from the instance; we
   *  hand its fog visibility to the RTS so the static-widget pass doesn't fight it. */
  private seedPlayerUnit(unit: MapUnit, def: UnitDef, loc: Float32Array, owner: number, team: number): void {
    const facing = quatToZ(unit.instance.localRotation);
    const simId = this.addUnit(unit.instance, def, loc[0], loc[1], facing, owner, team);
    // The .doo instance is a viewer WIDGET (still in map.units), so mdx-m3-viewer's
    // Widget.update() keeps auto-playing its Stand clip. We suppress that by writing
    // `state = WidgetState.WALK` on the SAME widget object the viewer iterates — but
    // addUnit made a fresh {instance,state} wrapper, so the write landed on the wrong
    // object and walk/attack/death never stuck (the viewer re-stood it every frame).
    // Point the entry at the ORIGINAL map.units widget (exactly how the creep seed
    // works) so our state writes reach the viewer's copy. Without this, adopted units
    // are frozen in Stand and never loop their walk (regression from issue #33).
    const e = this.byId.get(simId);
    if (e) e.unit = unit;
    this.seededInstances.add(unit.instance); // RTS now drives this unit's fog visibility
  }

  /** Add a freshly-spawned unit (instance already attached to the scene) — used
   *  by melee init to place each race's starting units. Returns the sim id. */
  /** Reserve a sim id up front — for the async spawn path (a script CreateUnit must
   *  hand JASS a unit handle synchronously, but the render instance loads later). The
   *  reserved id is later passed to addUnit so both refer to the same unit. */
  reserveUnitId(): number {
    return this.nextId++;
  }

  addUnit(instance: Instance, def: UnitDef, x: number, y: number, facing: number, owner = 0, team = 0, constructionTime = 0, reservedId?: number): number {
    // A reserved id means the script-spawn path already created the SIM unit (JASS
    // CreateUnit is synchronous — the trigger may level/order/move the unit the very next
    // statement); we're only here to give it its body, now that the model has loaded. If
    // that unit is already GONE (a trigger that RemoveUnit'd it while the model was still
    // streaming), there is nothing to attach to — report -1 so the caller drops the model.
    if (reservedId !== undefined) {
      if (!this.sim.units.has(reservedId)) return -1;
      this.attachInstance(reservedId, instance, def);
      return reservedId;
    }
    const simId = this.addSimUnit(def, x, y, facing, owner, team, constructionTime);
    this.attachInstance(simId, instance, def);
    return simId;
  }

  /** Create the SIM unit alone — no model. The JASS `CreateUnit` path: the script needs a
   *  live unit *now* (it may immediately add abilities, set its level, or order it about),
   *  but the model streams in async. `attachInstance` gives it a body when it arrives; the
   *  render loop syncs its position from the sim, so it simply appears where it has got to. */
  addSimUnit(def: UnitDef, x: number, y: number, facing: number, owner = 0, team = 0, constructionTime = 0, reservedId?: number): number {
    const simId = reservedId ?? this.nextId++;
    const profile = WORKERS[def.id];
    // baseLumberCapacity is the pre-upgrade load; Improved Lumber Harvesting raises the live
    // `lumberCapacity` off it each tick (recomputeStats), so the profile stays the baseline.
    const worker: WorkerState | null = profile ? { ...profile, baseLumberCapacity: profile.lumberCapacity, carryGold: 0, carryLumber: 0 } : null;
    // Structures get building state (construction + a training queue); rally
    // point defaults to just south of the building.
    const building: BuildingState | null = def.isBuilding
      ? { constructionLeft: constructionTime, buildTimeTotal: constructionTime || 1, builderIds: [], goldCost: def.goldCost, lumberCost: def.lumberCost, queue: [], rallyX: x, rallyY: y - 200, rallyKind: "point", rallyTargetId: 0, producesUnits: this.tech.trains(def.id).length > 0 || this.tech.get(def.id).sellunits.length > 0 }
      : null;
    // A hero is born with a given name drawn from its `Propernames` list (the
    // Demon Hunter's "Painkiller", the Paladin's "Uther"-alikes) — the info panel
    // shows it above the XP bar, with "Level N Demon Hunter" inside the bar.
    const hero: HeroInit | undefined = def.isHero
      ? { properName: def.properNames.length ? def.properNames[Math.floor(Math.random() * def.properNames.length)] : "", level: Math.max(1, def.level), str: def.strength, agi: def.agility, int: def.intelligence, strPerLevel: def.strPerLevel, agiPerLevel: def.agiPerLevel, intPerLevel: def.intPerLevel, primaryAttr: def.primaryAttr }
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
        flying: def.moveType === MoveType.Fly,
        flyHeight: lift(def.moveHeight), // same lift as the Entry, so missiles match the model's altitude
        sightDay: def.sightDay || 1400,
        sightNight: def.sightNight || def.sightDay || 800,
        hp: constructionTime > 0 ? (def.hitPoints || 100) * 0.1 : def.hitPoints || 100,
        maxHp: def.hitPoints || 100,
        mana: def.mana,
        maxMana: def.mana,
        armor: def.armor,
        armorType: def.armorType,
        weapons: weaponsFromDef(def),
        castPoint: def.castPoint,
        castBackswing: def.castBackswing,
        worker,
        depotGold: DEPOT_IDS.has(def.id) && def.id !== "hlum", // lumber mill: lumber only
        depotLumber: DEPOT_IDS.has(def.id),
      },
      building,
      // "Invulnerable (Neutral)" (Avul): neutral buildings — goblin merchant, goblin
      // laboratory, mercenary camp, tavern, gold mine, marketplace — carry it in their
      // abilList by default and are permanently immune/untargetable (issue #26).
      // "Peon" classification = a worker: it never auto-acquires a target, so it won't
      // join a fight it wasn't explicitly ordered into (issue #41). Note the Ghoul
      // harvests lumber but is NOT Peon-classified — it fights like any other unit.
      { hero, abilities: this.buildInitialAbilities(def), mechanical: def.classification.includes("mechanical"), isPeon: def.classification.includes("peon"), level: def.level, baseInvulnerable: def.abilities.includes("Avul") },
    );
    // A structure spawned WITH a build time is a foundation just laid — that's the
    // moment EVENT_(PLAYER_)UNIT_CONSTRUCT_START fires (7.17). A pre-placed/instant
    // building (constructionTime 0) was never "constructed", so it raises nothing.
    if (constructionTime > 0) this.sim.noteConstruct(simId, "start");
    return simId;
  }

  /** Give a sim unit its rendered body: the model instance + everything derived from it
   *  (animation set, birth clip, scale). Called the moment the model is ready — the same
   *  frame for the melee/placement paths, a few frames later for a script-spawned unit
   *  (whose sim unit already exists). A second call for the same unit is ignored. */
  private attachInstance(simId: number, instance: Instance, def: UnitDef): void {
    if (this.byId.has(simId)) return;
    const anims = buildAnimSet(instance.model.sequences, def.animProps);
    // Per-unit animation blending: cross-fade between sequences over this unit's
    // own UnitUI `blend` time (0.15s for most WC3 units) so walk↔stand↔attack
    // transitions ease instead of hard-cutting (issue #8).
    instance.setBlendTime?.(def.animBlend);
    const entry: Entry = {
      simId,
      unit: { instance, state: WidgetState.IDLE },
      anims,
      moveHeight: lift(def.moveHeight),
      footHalfW: 0, // set by setBuildingFootprint() once the footprint is stamped
      footHalfH: 0,
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
      ...findBirthFields(instance.model.sequences, def.animProps),
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
      // Play an idle stand on spawn; leave curSeq unset (-1) so the first idle tick starts the
      // fidget cycle (pickSequence → the idle branch rolls the next variant). PlayOnce so a
      // model whose stand has >1 variant ends this clip and hands off; single-variant models get
      // pinned to Loop by that same idle branch.
      instance.setSequence(anims.stand);
      instance.setSequenceLoopMode(SequenceLoopMode.PlayOnce);
      entry.curSeq = -1;
    }
  }

  /** Swap a live unit's model + type-derived render facts, keeping the SAME entry — the
   *  Town Hall that just finished becoming a Keep (issue #57). The old instance is dropped
   *  and every field that came from the old UnitDef is re-read from the new one.
   *
   *  Selection survives: the entry (and its simId) is the thing the selection holds, and it
   *  is not replaced. Returns false if the unit vanished while the new model was streaming. */
  remodel(simId: number, instance: Instance, def: UnitDef): boolean {
    const entry = this.byId.get(simId);
    if (!entry) return false;
    entry.unit.instance.hide(); // drop the old body
    instance.setBlendTime?.(def.animBlend);
    entry.unit = { instance, state: WidgetState.IDLE };
    entry.anims = buildAnimSet(instance.model.sequences, def.animProps);
    Object.assign(entry, findBirthFields(instance.model.sequences, def.animProps));
    entry.typeId = def.id;
    entry.race = def.race;
    entry.name = def.name;
    entry.foodUsed = def.foodUsed;
    entry.foodMade = def.foodMade;
    entry.level = def.level;
    entry.modelPath = def.model;
    entry.baseScale = def.modelScale || 1;
    entry.curScale = def.modelScale || 1;
    entry.selRadius = (def.selScale || 1) * SEL_RADIUS_PER_SCALE;
    entry.moveHeight = lift(def.moveHeight);
    entry.curSeq = -1;
    entry.lastSwingSeq = -1;
    entry.lastChopSeq = -1;
    if (entry.anims.stand >= 0) {
      instance.setSequence(entry.anims.stand);
      instance.setSequenceLoopMode(SequenceLoopMode.PlayOnce);
    }
    return true;
  }

  /** Remove a unit outright (JASS RemoveUnit): no death/corpse. The render side drops
   *  it on the next tick's removal reconcile (onRemove hides the instance). */
  removeUnit(simId: number): void {
    this.sim.removeUnit(simId);
  }

  /** Kill a unit (JASS KillUnit): plays the death animation + leaves a corpse. */
  killUnit(simId: number): void {
    this.sim.killUnit(simId);
  }

  // --- JASS render-only unit effects (Phase 7 — issue #33) -------------------
  // Scale, vertex colour, fly-height lift and team colour are pure render state on
  // the Entry (the sim doesn't care), so the mutators live here, not in SimWorld.

  /** JASS SetUnitScale — the model's full-size scale (the render loop re-applies it,
   *  and building-birth scaling layers on top). WC3 uses scaleX uniformly. */
  setUnitScale(simId: number, scale: number): void {
    const e = this.byId.get(simId);
    if (e) e.baseScale = scale > 0 ? scale : 1;
  }
  /** JASS SetUnitVertexColor — the model's own tint (0–1), which fog dimming then
   *  multiplies. Reset fogTintB so applyFogTint re-emits with the new base. */
  setUnitVertexColor(simId: number, r: number, g: number, b: number, a: number): void {
    const e = this.byId.get(simId);
    if (!e) return;
    e.baseColor = new Float32Array([r, g, b, a]);
    e.fogTintB = NaN; // force applyFogTint to re-apply next frame
    e.unit.instance.setVertexColor?.([r, g, b, a]);
  }
  /** JASS SetUnitFlyHeight (render half) — the Z lift the render loop adds; the sim
   *  altitude is set alongside in SimWorld.setUnitFlyHeight. */
  setUnitFlyHeight(simId: number, height: number): void {
    const e = this.byId.get(simId);
    if (e) e.moveHeight = height > 0 ? height : 0;
  }
  /** JASS SetUnitTimeScale — the model animation playback rate. */
  setUnitTimeScale(simId: number, scale: number): void {
    const inst = this.byId.get(simId)?.unit.instance as { timeScale?: number } | undefined;
    if (inst) inst.timeScale = scale;
  }
  /** JASS SetUnitColor / SetUnitOwner's changeColor — re-tint the team-coloured
   *  model parts to a player-colour index (our slot doubles as the colour). */
  setUnitTeamColor(simId: number, colorIndex: number): void {
    this.byId.get(simId)?.unit.instance.setTeamColor?.(colorIndex);
  }
  /** JASS SetUnitAnimation / ResetUnitAnimation (7.17) — play the clip whose sequence
   *  name matches `animation` ("attack", "stand victory", "birth"; "" resets to the
   *  unit's stand). WC3 matches on the model's own sequence names, so this is a name
   *  test over `anims.seqNames`, not a fixed table. The clip is held like a cast
   *  animation so the idle picker doesn't stomp it on the next frame. */
  setUnitAnimation(simId: number, animation: string): void {
    const e = this.byId.get(simId);
    if (!e) return;
    if (!animation) {
      // Reset: back to the idle stand, released to the normal animation picker.
      e.castAnimT = 0;
      e.unit.state = WidgetState.IDLE;
      if (e.anims.stand >= 0) {
        e.unit.instance.setSequence(e.anims.stand);
        e.unit.instance.setSequenceLoopMode(SequenceLoopMode.Loop);
        e.curSeq = e.anims.stand;
      }
      return;
    }
    // A named clip may exist several times (Stand, Stand - 2): take the first match.
    const want = animation.toLowerCase();
    const seq = e.anims.seqNames.findIndex((n) => n.toLowerCase().startsWith(want));
    if (seq < 0) return; // this model has no such clip — leave it alone (WC3 no-ops too)
    e.unit.instance.setSequence(seq);
    e.unit.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined);
    e.curSeq = seq;
    e.unit.state = WidgetState.WALK; // hold it against the idle picker
    e.castAnimT = this.seqDuration(e.unit.instance, seq, CAST_ANIM_HOLD);
  }

  /** Record a building's footprint half-extents (WORLD units) so the render loop seats
   *  it on the tallest terrain its footprint touches rather than its centre height —
   *  otherwise a structure on a small hill/slope clips into the ground (issue #15).
   *  Called by the spawner once the footprint is known. */
  setBuildingFootprint(simId: number, halfW: number, halfH: number): void {
    const e = this.byId.get(simId);
    if (!e) return;
    e.footHalfW = halfW;
    e.footHalfH = halfH;
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
    if (this.hoveredItem !== null && !this.sim.items.has(this.hoveredItem)) this.hoveredItem = null;
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
      // Buildings seat on the tallest terrain their footprint spans (issue #15); mobile
      // units (footHalfW 0) ride the centre-sampled ground + their fly height.
      this.loc[2] =
        (e.footHalfW > 0 ? this.footMaxHeight(u.x, u.y, e.footHalfW, e.footHalfH) : this.heightAt(u.x, u.y)) + e.moveHeight;
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
            e.unit.state = WidgetState.WALK; // keep mdx-m3-viewer from auto-standing
            e.unit.instance.setSequence(e.birthSeq);
            e.unit.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined);
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
      // Hold a cast animation so the throw/slam/spell gesture (or a looped channel)
      // plays out instead of being overwritten by the stand/attack picker. But drop
      // the hold the instant the unit is interrupted — a new order, or it starts
      // moving (a canceled cast backswing / channel) — so the picker takes over at
      // once and WC3 "animation canceling" looks instantaneous.
      if (e.castAnimT > 0) {
        e.castAnimT -= dt;
        if (u.order === "cast" && !u.moving) continue;
        e.castAnimT = 0;
      }
      // Attacking is swing-driven: play a (random) attack clip ONCE per swing so
      // the strike gesture matches the damage-point-timed hit/projectile, and
      // units with several attack animations vary them shot to shot. Between swings
      // the non-looping attack clip holds its last frame; everything else loops. A unit that walked
      // after firing (`swingBroken` — its backswing was move-canceled) does NOT show
      // the attack clip: it stands out the recovery until its next real swing.
      const attacking = u.inCombat && !u.moving && !u.swingBroken && e.anims.attack >= 0;
      // Chopping is chop-driven, like the attack swing: re-trigger the "Attack
      // Lumber" clip ONCE per chop so the swing stays in phase with the chop SFX
      // (a free-running loop drifted out of sync with the sound).
      const chopping = u.working && u.order === "harvest" && !u.moving && e.anims.chopLumber >= 0;
      if (chopping) {
        if (u.chopSeq !== e.lastChopSeq || e.curSeq !== e.anims.chopLumber) {
          e.lastChopSeq = u.chopSeq;
          e.curSeq = e.anims.chopLumber;
          e.unit.state = WidgetState.WALK;
          e.unit.instance.setSequence(e.anims.chopLumber);
          e.unit.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined);
        }
      } else if (attacking) {
        // Pick the swing pool matching the worker's carry state so a laden worker
        // swings its "Attack Gold"/"Attack Lumber" clip and an empty-handed one its
        // plain attack — never a random mix (issue #35). Carry pools fall back to the
        // empty-handed variants when a model lacks a carry-attack clip.
        const w = u.worker;
        const vs =
          w && w.carryGold > 0 && e.anims.attackGold.length
            ? e.anims.attackGold
            : w && w.carryLumber > 0 && e.anims.attackLumber.length
              ? e.anims.attackLumber
              : e.anims.attackVariants;
        if (u.swingSeq !== e.lastSwingSeq || !vs.includes(e.curSeq)) {
          e.lastSwingSeq = u.swingSeq;
          const pick = vs.length > 1 ? vs[(Math.random() * vs.length) | 0] : (vs[0] ?? e.anims.attack);
          e.curSeq = pick;
          e.unit.state = WidgetState.WALK; // non-stand state prevents mdx-m3-viewer's auto-stand
          e.unit.instance.setSequence(pick);
          e.unit.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined);
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
        if (seq === e.anims.stand) {
          // Plain empty-handed idle: fidget through the model's stand variants (WC3's varied
          // idle). We drive it ourselves — our units are raw MdxComplexInstances, not the
          // viewer's Widget, so its auto-stand never runs. With >1 variant, play each ONCE and
          // roll a *different* next one when it ends (setSequence to the same clip wouldn't
          // restart it, so we'd freeze). With a single variant, just loop it (classic).
          const inst = e.unit.instance;
          const vs = e.anims.standVariants;
          if (vs.length > 1) {
            const onStand = vs.includes(e.curSeq);
            if (!onStand || inst.sequenceEnded) {
              let pick = vs[(Math.random() * vs.length) | 0];
              if (pick === e.curSeq) pick = vs[(vs.indexOf(pick) + 1) % vs.length];
              e.curSeq = pick;
              e.unit.state = WidgetState.IDLE;
              inst.setSequence(pick);
              inst.setSequenceLoopMode(SequenceLoopMode.PlayOnce);
            }
          } else if (e.curSeq !== e.anims.stand) {
            e.curSeq = e.anims.stand;
            e.unit.state = WidgetState.IDLE;
            inst.setSequence(e.anims.stand);
            inst.setSequenceLoopMode(SequenceLoopMode.Loop);
          }
        } else if (seq !== e.curSeq && seq >= 0) {
          // Walk / carry-stand: a single looping clip (state WALK keeps the viewer from
          // overriding a pinned "Stand Gold"/"Stand Lumber" carry pose with a plain stand).
          e.curSeq = seq;
          e.unit.state = WidgetState.WALK;
          e.unit.instance.setSequence(seq);
          e.unit.instance.setSequenceLoopMode(SequenceLoopMode.Loop);
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
    e.unit.state = WidgetState.WALK; // keep mdx-m3-viewer from overriding the death sequence
    if (e.anims.death >= 0) {
      e.unit.instance.setSequence(e.anims.death);
      e.unit.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined);
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
    // NOTE: no `inCombat → attack` here. The attack clip is owned entirely by the
    // swing-driven block above (triggered per swing). Reaching pickSequence while in
    // combat means the swing was broken by walking (backswing move-canceled), so the
    // unit stands out the recovery until its next real swing — it does not attack.
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
      c.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined); // play once, then hold the pose
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

  /** Play a caster's spell animation (matched to the ability's anim tags, e.g. Storm
   *  Bolt "throw", Thunder Clap "slam", else "Spell"/"Attack") and hold it for `hold`
   *  seconds — the whole cast (wind-up + backswing, or wind-up + channel). A channel
   *  (`loop`) prefers a "channel" clip and loops it for the duration; a one-shot cast
   *  plays its gesture once. The sim drops the hold early on interruption. */
  playCastAnim(casterId: number, code: string, hold: number, loop: boolean): void {
    const e = this.byId.get(casterId);
    if (!e) return;
    const def = this.abilityDefByCode(code);
    const tags = def?.animNames ?? [];
    const names = e.anims.seqNames;
    const pick = (re: RegExp) => names.findIndex((n) => re.test(n));
    let seq = -1;
    // A channelled spell prefers a dedicated "channel" clip (Blizzard, Starfall).
    if (loop) seq = pick(/channel/i);
    // Otherwise prefer the more specific tag (throw/slam) over the generic "spell".
    if (seq < 0)
      for (const tag of [...tags].reverse()) {
        if (tag === "spell") continue;
        seq = pick(new RegExp(`\\b${tag}\\b`, "i"));
        if (seq >= 0) break;
      }
    if (seq < 0) seq = pick(/spell/i);
    if (seq < 0) seq = e.anims.attack;
    if (seq < 0) return;
    e.unit.instance.setSequence(seq);
    e.unit.instance.setSequenceLoopMode(loop ? SequenceLoopMode.Loop : SequenceLoopMode.ModelDefined);
    e.curSeq = seq;
    e.unit.state = WidgetState.WALK; // don't let the idle picker immediately override the cast
    e.castAnimT = hold > 0 ? hold : CAST_ANIM_HOLD; // hold the clip for the whole cast
  }

  private abilityDefByCode(code: string): AbilityDef | undefined {
    for (const a of this.abilities.all()) if (a.code === code) return a;
    return undefined;
  }

  /** The rendered model instance for a unit — for effects that ride the model's
   *  attachment points (e.g. the Blood Mage's orbiting spheres, issue #37). */
  unitInstance(simId: number): Instance | undefined {
    return this.byId.get(simId)?.unit.instance;
  }

  /** Whether a unit's model is currently hidden (fog of war, or a worker inside a
   *  gold mine) — so attached effects can hide/show along with it. */
  unitHidden(simId: number): boolean {
    return this.byId.get(simId)?.hidden ?? true;
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
    e.unit.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined);
    e.unit.state = WidgetState.WALK; // keep the picker from auto-standing over the birth clip
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
          this.selectedItem = null;
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
      this.selectedItem = null;
      this.refocus();
      this.announceSelection();
      return;
    }
    // No unit under the cursor — a gold mine or a ground item is clickable too.
    const g = this.groundPoint(cssX, cssY);
    if (g) {
      // A ground item is checked FIRST: its pick radius is tight (ITEM_PICK_RADIUS),
      // while a mine's is broad (300), so an item dropped near a mine would otherwise be
      // unclickable — the mine under the same click would always win. Directly clicking
      // the item selects it; clicking the mine elsewhere still selects the mine.
      const it = this.sim.itemAt(g[0], g[1], ITEM_PICK_RADIUS);
      if (it) {
        this.selected.clear();
        this.primary = null;
        this.selectedMine = null;
        this.selectedItem = it.id;
        this.voiceStreak = 0;
        this.lastVoiceId = null;
        return;
      }
      const m = this.mineAt(g[0], g[1], 300); // fogged mines are images, not click targets
      if (m) {
        this.selected.clear();
        this.primary = null;
        this.selectedMine = m.id;
        this.selectedItem = null;
        this.voiceStreak = 0; // selecting a mine breaks a unit's re-click streak
        this.lastVoiceId = null;
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
    this.selectedItem = null;
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
    this.selectedItem = null;
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
    this.hoveredItem = null;
    if (this.hovered === null) {
      const g = this.groundPoint(cssX, cssY);
      if (g) {
        // Mirror selectAt's priority: a ground item (tight radius) wins over a mine
        // (broad radius) so an item near a mine gets its own hover ring, not the mine's.
        const it = this.sim.itemAt(g[0], g[1], ITEM_PICK_RADIUS);
        if (it) this.hoveredItem = it.id;
        else this.hoveredMine = this.mineAt(g[0], g[1], 300)?.id ?? null;
      }
    }
  }

  /** Clear the hover state (pointer left the map, e.g. onto the HUD) so the
   *  targeting reticle hides and the normal cursor returns. */
  clearHover(): void {
    this.hovered = null;
    this.hoveredMine = null;
    this.hoveredItem = null;
  }

  /** What the cursor is over, for the targeting reticle: whether something is
   *  under it and its allegiance (own/ally = friendly, gold mine / neutral
   *  passive = neutral, everyone else = enemy). */
  hoverInfo(): { has: boolean; category: "friendly" | "neutral" | "enemy" } {
    if (this.hoveredMine !== null || this.hoveredItem !== null) return { has: true, category: "neutral" };
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
  orderMode: "move" | "attack" | "patrol" | "rally" | "repair" | "cast" | "item" | null = null;
  /** The spell armed for targeting when orderMode === "cast". `area` (>0) shows an
   *  AoE cast circle at the cursor for point-target area spells. */
  armedCast: { code: string; target: "unit" | "point"; area?: number } | null = null;
  /** The inventory item armed for targeting when orderMode === "item": a point-use
   *  item (blink) awaiting a ground click, or a passive item awaiting a drop/give
   *  target (ground → drop, allied hero → give). */
  armedItem: { slot: number; mode: "usepoint" | "move" } | null = null;

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
    if (mode === "item") {
      const armed = this.armedItem;
      this.armedItem = null;
      const id = this.primary;
      if (!armed || id === null || !this.controls(id)) return true;
      if (armed.mode === "usepoint") {
        const hit = this.groundHitAt(cssX, cssY);
        if (hit) this.sim.useItem(id, armed.slot, 0, hit[0], hit[1]);
        return true;
      }
      // "move": the carried item goes to whatever was clicked — a SHOP buys it back (WC3 sells
      // by exactly this gesture: right-click the item, then click the Goblin Merchant / Arcane
      // Vault / Marketplace), an allied hero is handed it, and bare ground gets it dropped.
      const picked = this.pickAt(cssX, cssY);
      const to = picked !== null ? this.sim.units.get(picked) : undefined;
      if (to && picked !== null && picked !== id && this.sim.canPawnAt(to)) {
        this.sim.issueSellItem(id, armed.slot, picked);
      } else if (to && picked !== null && picked !== id && this.controls(picked) && to.inventory.length) {
        this.sim.issueGiveItem(id, armed.slot, picked);
      } else {
        const hit = this.groundHitAt(cssX, cssY);
        if (hit) {
          this.sim.dropItem(id, armed.slot, hit[0], hit[1]);
          this.queueArrow(hit[0], hit[1], MOVE_ARROW); // green move feedback — the hero walks over to drop
        }
      }
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
            this.flashAttack(target.x, target.y, this.byId.get(picked)?.selRadius ?? target.radius, this.byId.get(picked)?.moveHeight ?? 0);
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
      this.groupAttackMove(hit[0], hit[1], queued); // distinct formation slot per unit (like move)
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

  // --- inventory (hero items) ----------------------------------------------

  /** The primary selected hero's 6 inventory slots for the HUD (null = empty). An
   *  empty array means the selection has no inventory (not a hero). */
  inventorySlots(): Array<{ itemId: string; icon: string; name: string; desc: string; charges: number; cooldownLeft: number; cooldownFrac: number; usable: boolean } | null> {
    const id = this.primary;
    const u = id !== null ? this.sim.units.get(id) : undefined;
    if (!u || !u.inventory.length) return [];
    return u.inventory.map((held) => {
      if (!held) return null;
      const def = this.items.get(held.itemId);
      const total = def ? this.itemActiveCooldown(def) : 0;
      return {
        itemId: held.itemId,
        icon: def?.icon ?? "",
        name: def?.name ?? held.itemId,
        // The item's own Ubertip, with its <ID,Field> value references filled in — the
        // same text the HUD shows for the item lying on the ground.
        desc: def ? this.tipText(def.description) : "",
        charges: held.charges,
        cooldownLeft: held.cooldownLeft,
        cooldownFrac: total > 0 ? Math.max(0, Math.min(1, held.cooldownLeft / total)) : 0,
        usable: def?.usable ?? false,
      };
    });
  }

  /** The active-use cooldown of an item (its usable ability's cool1), for the HUD sweep. */
  private itemActiveCooldown(def: { abilities: string[] }): number {
    let cd = 0;
    for (const aid of def.abilities) {
      const ad = this.abilities.get(aid);
      if (ad) cd = Math.max(cd, ad.levelData[0]?.cooldown ?? 0);
    }
    return cd;
  }

  /** Left-click an inventory slot. If a move/drop is armed (right-click), this click
   *  completes it as a slot-to-slot move/swap. Otherwise it's a USE: fire a
   *  self-target consumable now, or arm a point-target one (blink) for a ground click.
   *  Left-click on a passive item does nothing (dropping/moving is right-click). */
  useInventorySlot(slot: number): void {
    const id = this.primary;
    if (id === null || !this.controls(id)) return;
    // Complete an armed move by dropping the carried item into this slot (swap).
    if (this.orderMode === "item" && this.armedItem?.mode === "move") {
      const from = this.armedItem.slot;
      this.armedItem = null;
      this.orderMode = null;
      if (from !== slot) this.sim.swapItems(id, from, slot);
      return;
    }
    const u = this.sim.units.get(id);
    const held = u?.inventory[slot];
    if (!u || !held) return;
    const def = this.items.get(held.itemId);
    if (!def?.usable) return; // passive item — left-click is a no-op (right-click to move/drop)
    const point = def.abilities.some((aid) => this.abilities.get(aid)?.target === "point");
    if (point) {
      this.armedItem = { slot, mode: "usepoint" };
      this.orderMode = "item";
      return;
    }
    this.sim.useItem(id, slot, 0, u.x, u.y); // self/instant consumable — fire immediately
  }

  /** Right-click an inventory slot: enter "target to move" mode. The next click
   *  resolves it — another inventory slot (move/swap), open ground (drop, walking
   *  into range first), or an allied hero (give). */
  moveInventorySlot(slot: number): void {
    const id = this.primary;
    if (id === null || !this.controls(id) || !this.sim.units.get(id)?.inventory[slot]) return;
    this.armedItem = { slot, mode: "move" };
    this.orderMode = "item";
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
      this.sim.noteOrder(id, ORDER_IDS.stop, "immediate", 0, 0, 0); // ISSUED_ORDER for the trigger engine
    }
  }

  /** Hold Position on the selection: each unit plants where it stands and attacks
   *  only enemies that walk into its weapon range, never chasing (WC3 Hold). Like
   *  Stop, it wipes the shift-queue so the unit doesn't resume a queued order. */
  holdSelected(): void {
    for (const id of this.selected) {
      if (!this.controls(id)) continue; // only your own units obey Hold
      this.sim.clearQueue(id);
      this.sim.issueHold(id);
      this.sim.noteOrder(id, ORDER_IDS.holdposition, "immediate", 0, 0, 0); // ISSUED_ORDER for the trigger engine
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
    if (this.selectedItem !== null) return this.itemInfo(this.selectedItem);
    if (this.primary === null) return null;
    return this.infoFor(this.primary);
  }

  /** Selection info for a ground item: its name + description + model (for the HUD
   *  portrait), with the combat/attribute stats blanked out. */
  private itemInfo(itemId: number): SelectionInfo | null {
    const it = this.sim.items.get(itemId);
    if (!it) return null;
    const def = this.items.get(it.itemId);
    return {
      id: -2000 - itemId, // synthetic, negative — never clashes with a unit/mine id
      typeId: it.itemId, race: "", name: def?.name || it.itemId, owner: -1,
      hp: 0, maxHp: 0, mana: 0, maxMana: 0, armor: 0, armorBonus: 0, invulnerable: false, damageMin: 0, damageMax: 0, damageBonus: 0,
      attackType: AttackType.None, armorType: ArmorType.Unknown, isHero: false, properName: "", level: 0, xp: 0, xpThis: 0, xpNext: 0, skillPoints: 0, strength: 0,
      agility: 0, intelligence: 0, strengthBonus: 0, agilityBonus: 0, intelligenceBonus: 0, primaryAttr: PrimaryAttribute.None,
      model: def?.model ?? "", isWorker: false, isBuilding: false,
      underConstruction: false, buildProgress: 0, trainProgress: 0, secondsLeft: 0, queueLength: 0,
      queue: [], icon: def?.icon ?? "", carryGold: 0, carryLumber: 0,
      isMine: false, goldRemaining: 0,
      isItem: true, description: def ? this.tipText(def.description) : "",
      isSummon: false, summonSecondsLeft: 0, summonFrac: 0, buffs: [],
    };
  }

  /** Fill an item tooltip's `<ID,Field>` value references — a Potion of Healing's "<AIh1,DataA1>"
   *  heal, Dust of Appearance's "<dust,uses>" charges. One resolver for every tooltip surface
   *  (src/data/tipRefs.ts); the shop card runs the same text through the same code. */
  private tipText(text: string): string {
    return resolveTipRefs(text, { abilities: this.abilities, items: this.items, units: this.registry, upgrades: this.upgrades });
  }

  /** Selection info for a gold mine (name + remaining gold + its model). */
  private mineInfo(mineId: number): SelectionInfo | null {
    const m = this.sim.mines.get(mineId);
    if (!m) return null;
    const def = this.registry.get("ngol");
    return {
      id: -1000 - mineId, // synthetic, negative — never clashes with a unit id
      typeId: "ngol", race: "", name: def?.name || "Gold Mine", owner: -1,
      hp: 0, maxHp: 0, mana: 0, maxMana: 0, armor: 0, armorBonus: 0, invulnerable: true, damageMin: 0, damageMax: 0, damageBonus: 0,
      attackType: AttackType.None, armorType: ArmorType.Unknown, isHero: false, properName: "", level: 0, xp: 0, xpThis: 0, xpNext: 0, skillPoints: 0, strength: 0,
      agility: 0, intelligence: 0, strengthBonus: 0, agilityBonus: 0, intelligenceBonus: 0, primaryAttr: PrimaryAttribute.None,
      model: def?.model ?? "", isWorker: false, isBuilding: false,
      underConstruction: false, buildProgress: 0, trainProgress: 0, secondsLeft: 0, queueLength: 0,
      queue: [], icon: def?.icon ?? "", carryGold: 0, carryLumber: 0,
      isMine: true, goldRemaining: m.gold,
      isItem: false, description: "",
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
      invulnerable: u.invulnerable, // red "Invulnerable" line under the armour value (issue #26)
      damageMin: w ? Math.round(w.damage - u.bonusDamage) + w.dice : 0,
      damageMax: w ? Math.round(w.damage - u.bonusDamage) + w.dice * w.sides : 0,
      damageBonus: Math.round(u.bonusDamage),
      attackType: def?.attackType ?? AttackType.None,
      armorType: def?.armorType ?? ArmorType.Unknown,
      isHero: u.isHero,
      properName: u.properName,
      // Heroes carry their LIVE level/attributes on the sim unit (they grow with
      // XP); non-heroes fall back to the data-def values.
      level: u.isHero ? u.level : (def?.level ?? 0),
      xp: u.xp,
      xpThis: u.isHero ? xpToReachLevel(u.level) : 0,
      xpNext: u.isHero ? xpToReachLevel(u.level + 1) : 0,
      skillPoints: u.skillPoints,
      // Split base attribute vs the item "+N": the shown number is the natural
      // attribute (growth), the bonus is the item contribution (green/red in the HUD).
      strength: u.isHero ? u.str - u.bonusStr : (def?.strength ?? 0),
      agility: u.isHero ? u.agi - u.bonusAgi : (def?.agility ?? 0),
      intelligence: u.isHero ? u.int - u.bonusInt : (def?.intelligence ?? 0),
      strengthBonus: u.isHero ? u.bonusStr : 0,
      agilityBonus: u.isHero ? u.bonusAgi : 0,
      intelligenceBonus: u.isHero ? u.bonusInt : 0,
      primaryAttr: def?.primaryAttr ?? PrimaryAttribute.None,
      model: e.modelPath,
      isWorker: !!u.worker,
      isBuilding: !!b,
      underConstruction: !!b && b.constructionLeft > 0,
      buildProgress: b && b.buildTimeTotal > 0 ? 1 - b.constructionLeft / b.buildTimeTotal : 1,
      trainProgress: q.length && q[0].buildTime > 0 ? 1 - q[0].timeLeft / q[0].buildTime : 0,
      secondsLeft: b && b.constructionLeft > 0 ? b.constructionLeft : q.length ? q[0].timeLeft : 0,
      queueLength: q.length,
      // A queue slot may hold a unit, a research or a structure upgrade — pull each one's icon
      // from the registry that owns it. Research uses the icon of the LEVEL being researched
      // (Steel Forged Swords has its own art), which is why the level rides on the job.
      queue: q.map((j) => ({
        icon: (j.kind === "research" ? this.upgrades.icon(j.unitId, j.level) : this.registry.get(j.unitId)?.icon) ?? "",
      })),
      icon: this.registry.get(e.typeId)?.icon ?? "",
      carryGold: u.worker?.carryGold ?? 0,
      carryLumber: u.worker?.carryLumber ?? 0,
      isMine: false,
      goldRemaining: 0,
      isItem: false,
      description: "",
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

  /** CLICK/selection colliders for every ground item — drawn (radius ITEM_PICK_RADIUS)
   *  by the debug overlay so the pickable area an item exposes is visible (it's why an
   *  item dropped by a gold mine can be hard to hit: its ring, not the mine's, must be
   *  clicked). Kept separate from unit colliders since items aren't sim units. */
  debugItemColliders(): Array<{ x: number; y: number; z: number; radius: number }> {
    const out: Array<{ x: number; y: number; z: number; radius: number }> = [];
    for (const it of this.sim.items.values()) {
      out.push({ x: it.x, y: it.y, z: this.heightAt(it.x, it.y), radius: ITEM_PICK_RADIUS });
    }
    return out;
  }

  /** Remaining route for every moving unit — current position followed by the
   *  waypoints it still has to reach — for the "Show Pathing" debug overlay. The
   *  path shrinks as the unit consumes waypoints and vanishes when it settles, so
   *  a line drawn from this traces the unit until it finishes moving. */
  debugUnitPaths(): Array<Array<[number, number]>> {
    const out: Array<Array<[number, number]>> = [];
    for (const [, u] of this.sim.units) {
      if (!u.moving || u.waypoint >= u.path.length) continue;
      const pts: Array<[number, number]> = [[u.x, u.y]];
      for (let i = u.waypoint; i < u.path.length; i++) pts.push([u.path[i][0], u.path[i][1]]);
      out.push(pts);
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
      // Air units' ring floats at their flight altitude (e.moveHeight matches the
      // model's drawn base), so it hugs the unit instead of sitting on the ground.
      if (u && e) out.push({ x: u.x, y: u.y, z: this.heightAt(u.x, u.y) + e.moveHeight, radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building, neutral: u.neutralPassive, isBuilding: !!u.building });
    }
    if (this.selectedMine !== null) {
      const m = this.sim.mines.get(this.selectedMine);
      // A gold mine is Neutral PASSIVE (yellow ring), not hostile (red).
      if (m) out.push({ x: m.x, y: m.y, z: this.heightAt(m.x, m.y), radius: m.radius * MINE_RING_SCALE, owner: -1, team: -2, sizeToRadius: true, neutral: true });
    }
    if (this.selectedItem !== null) {
      const it = this.sim.items.get(this.selectedItem);
      // A ground item rings yellow (neutral), like a mine — sized to the item.
      if (it) out.push({ x: it.x, y: it.y, z: this.heightAt(it.x, it.y), radius: ITEM_RING_RADIUS, owner: -1, team: -2, sizeToRadius: true, neutral: true });
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
      if (u && e) out.push({ x: u.x, y: u.y, z: this.heightAt(u.x, u.y) + e.moveHeight, radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building, neutral: u.neutralPassive, isBuilding: !!u.building });
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
      if (u && e) return { x: u.x, y: u.y, z: this.heightAt(u.x, u.y) + e.moveHeight, radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building, neutral: u.neutralPassive, isBuilding: !!u.building };
    }
    if (this.hoveredMine !== null && this.hoveredMine !== this.selectedMine) {
      const m = this.sim.mines.get(this.hoveredMine);
      if (m) return { x: m.x, y: m.y, z: this.heightAt(m.x, m.y), radius: m.radius * MINE_RING_SCALE, owner: -1, team: -2, sizeToRadius: true, neutral: true };
    }
    if (this.hoveredItem !== null && this.hoveredItem !== this.selectedItem) {
      const it = this.sim.items.get(this.hoveredItem);
      if (it) return { x: it.x, y: it.y, z: this.heightAt(it.x, it.y), radius: ITEM_RING_RADIUS, owner: -1, team: -2, sizeToRadius: true, neutral: true };
    }
    return null;
  }

  /** Ids of the units an armed point-AoE spell would affect if cast at world (wx,wy)
   *  — its valid targets, so the renderer can green-tint their meshes while aiming
   *  (issue #20). Delegates to the sim's own area-effect predicate (targs1), so the
   *  highlight matches who the cast actually hits, friendly fire included. Empty
   *  unless a point-target spell with an area is armed. */
  aoeTargetIds(wx: number, wy: number): number[] {
    const cast = this.armedCast;
    if (!cast || cast.target !== "point" || !cast.area) return [];
    const caster = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
    if (!caster) return [];
    const flags = this.abilityDefByCode(cast.code)?.targetFlags ?? [];
    return this.sim.areaEffectTargets(caster.id, caster.team, flags, wx, wy, cast.area);
  }

  /** Positions of the trees an armed AoE would destroy at (wx,wy) — drives the green
   *  tree highlight, mirroring aoeTargetIds for units. Non-empty only for a point AoE
   *  whose targs1 lists `tree` (Flame Strike), so trees light up green exactly when the
   *  cast would fell them. */
  aoeTreePoints(wx: number, wy: number): Array<{ x: number; y: number }> {
    const cast = this.armedCast;
    if (!cast || cast.target !== "point" || !cast.area) return [];
    const flags = this.abilityDefByCode(cast.code)?.targetFlags ?? [];
    if (!flags.includes("tree")) return [];
    return this.sim.treesInArea(wx, wy, cast.area).map((t) => ({ x: t.x, y: t.y }));
  }

  /** Set which units are highlighted as valid AoE-spell targets (green mesh tint,
   *  applied in applyFogTint). Called each frame while aiming; empty clears it. */
  setAoeHighlight(ids: Iterable<number>): void {
    this.aoeHighlight = new Set(ids);
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
      case "hold":
        return null; // Hold Position has no destination/target to draw a marker for
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

  /** How many of `typeId` a player owns or has in production. This picks the REQUIREMENT
   *  TIER for that unit: WC3 gates the Nth copy, not the type — hero #1 is free, #2 needs a
   *  Keep and #3 a Castle (`[Hpal] Requirescount=3, Requires1=hkee, Requires2=hcas`). Queued
   *  ones count, or you could queue three heroes at a Town Hall in one click. */
  countOwned(owner: number, typeId: string): number {
    let n = 0;
    for (const u of this.sim.units.values()) {
      if (u.hp <= 0) continue;
      if (u.owner === owner && u.typeId === typeId) n++;
      if (u.building && (u.owner === owner || u.neutralPassive)) {
        for (const job of u.building.queue) {
          if (job.kind !== "unit" || job.unitId !== typeId) continue;
          // A NEUTRAL shop's queue belongs to nobody by ownership — a Tavern is Neutral
          // Passive — so the job itself says who is buying. Without that, a hero one player is
          // hiring would count toward every other player's copy count, and so pick their
          // requirement tier for them (harmless in 1v1, wrong in an FFA).
          if (job.buyer !== undefined ? job.buyer === owner : u.owner === owner) n++;
        }
      }
    }
    return n;
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
      if (kind === "gold") stash.gold += 5000;
      else stash.lumber += 5000;
    }
    return false;
  }

  /** Debug cheats acting on the current selection: refill HP or MP to full, or
   *  clear every ability (and item) cooldown, on each selected living unit. */
  cheatSelected(kind: "hp" | "mp" | "cooldown"): void {
    for (const id of this.selected) {
      const u = this.sim.units.get(id);
      if (!u || u.hp <= 0) continue;
      if (kind === "hp") u.hp = u.maxHp;
      else if (kind === "mp") u.mana = u.maxMana;
      else {
        for (const ab of u.abilities) ab.cooldownLeft = 0;
        for (const it of u.inventory) if (it) it.cooldownLeft = 0;
      }
    }
  }

  /** Minimap dots: world positions + owners of living units the local team can
   *  see. Your own units always show; fogged enemies and creeps are dropped so the
   *  minimap hides their movements exactly like the main view.
   *
   *  Neutral PASSIVE units never dot the minimap. Critters, murloc huts and the
   *  shops alike are furniture: the ones worth finding already carry a glyph of
   *  their own (minimapIcons), and the rest would only speckle the map. Creeps do
   *  get a dot once visible — and their camp marker steps aside for it. */
  dots(): Array<{ x: number; y: number; owner: number }> {
    const out: Array<{ x: number; y: number; owner: number }> = [];
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (!u || u.neutralPassive) continue;
      if (!e.hidden || u.team === this.localTeam) {
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
   *  level. Fog does NOT gate them — a fresh melee game in the real 1.27a client
   *  paints every camp's dot before a single tile has been explored (that is how
   *  you scout expansions from the lobby). The marker is a stand-in for creeps you
   *  cannot see, so it yields the moment any of them is: exactly then `dots()`
   *  starts drawing that creep, and the two must never show at once. Gone for good
   *  once every creep in the camp is dead. */
  creepCamps(): Array<{ x: number; y: number; level: number }> {
    if (!this.seeded) return [];
    if (this.creepCampData === null) this.creepCampData = this.buildCreepCamps();
    const out: Array<{ x: number; y: number; level: number }> = [];
    for (const camp of this.creepCampData) {
      const alive = camp.members.filter((id) => this.sim.units.has(id));
      if (alive.length === 0) continue; // camp cleared
      if (alive.some((id) => !this.byId.get(id)?.hidden)) continue; // a creep is in sight — it speaks for itself
      out.push({ x: camp.x, y: camp.y, level: camp.level });
    }
    return out;
  }

  // Minimap glyphs the client paints over the map picture whatever the fog says —
  // both were plainly visible over unexplored ground in a fresh 1.27a melee game.
  //
  //  · Gold mines wear `MiniMap-Goldmine.mdx`'s texture. (The client swaps in
  //    `minimap-gold-haunted`/`-entangled` once a mine is claimed; we do not model
  //    the claimed-mine unit yet, so every mine draws the plain icon.)
  //  · A neutral building wears the house glyph only if its unitUI row sets
  //    `nbmmIcon` — the useful ones (tavern, shops, mercenary camp, fountains,
  //    goblin laboratory) do; the scenery ones (murloc/gnoll huts, city buildings)
  //    do not, and fall through to a plain neutral dot like any other unit.
  private static readonly ICON_GOLD_MINE = "UI\\MiniMap\\minimap-gold.blp";
  private static readonly ICON_NEUTRAL_BUILDING = "UI\\MiniMap\\MiniMap-NeutralBuilding.blp";

  /** Persistent minimap glyphs: each world position and the BLP to stamp there. */
  minimapIcons(): Array<{ x: number; y: number; icon: string }> {
    const out: Array<{ x: number; y: number; icon: string }> = [];
    for (const m of this.sim.mines.values()) {
      out.push({ x: m.x, y: m.y, icon: RtsController.ICON_GOLD_MINE });
    }
    for (const e of this.entries) {
      const u = this.sim.units.get(e.simId);
      if (!u || !u.neutralPassive || u.building == null) continue;
      if (!this.registry.get(e.typeId)?.minimapIcon) continue;
      out.push({ x: u.x, y: u.y, icon: RtsController.ICON_NEUTRAL_BUILDING });
    }
    return out;
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
    this.notePlayerOrder(id, o); // fire EVENT_..._ISSUED_ORDER for the trigger engine
    if (queued) {
      this.sim.queueOrder(id, o);
      return true;
    }
    return this.sim.issueOrder(id, o);
  }

  /** Record a player-issued group order (move / attack / attack-move / patrol / follow)
   *  for the trigger engine's ISSUED-order events. A no-op unless a script is listening
   *  (`sim.captureOrders`). Harvest/build/rally aren't mapped to a generic order id. */
  private notePlayerOrder(id: number, o: QueuedOrder): void {
    switch (o.kind) {
      case "move":
        this.sim.noteOrder(id, ORDER_IDS.move, "point", o.x, o.y, 0);
        break;
      case "attackmove":
        this.sim.noteOrder(id, ORDER_IDS.attack, "point", o.x, o.y, 0);
        break;
      case "patrol":
        this.sim.noteOrder(id, ORDER_IDS.patrol, "point", o.x, o.y, 0);
        break;
      case "attack":
        this.sim.noteOrder(id, ORDER_IDS.attack, "target", 0, 0, o.targetId);
        break;
      case "follow":
        this.sim.noteOrder(id, ORDER_IDS.smart, "target", 0, 0, o.targetId);
        break;
    }
  }

  /** JASS IssueXOrder → the sim (Phase 7 — issue #33). Maps a generic order id + target
   *  kind to the matching sim command so a trigger-issued unit actually marches/attacks/
   *  casts, then records the ISSUED-order event. Unlike the player `order()` path this
   *  does NOT gate on ownership — a trigger can command any unit. Returns whether the
   *  order took. `order` is the order string; an ABILITY order (the GUI's "Order <unit>
   *  to <ability>" → `IssueTargetOrder(u, "holybolt", t)`) is matched by name against the
   *  unit's own abilities — the engine's numeric ids for ability orders live in no data
   *  file, so the STRING is the reliable key (7.17). */
  issueUnitOrder(unitId: number, orderId: number, order: string, kind: "immediate" | "point" | "target", x: number, y: number, targetId: number): boolean {
    const s = order || orderIdToString(orderId);
    // Ability order? Find the ability on this unit whose Order/Orderon/Orderoff string
    // matches, and cast it (autocast toggles flip the autocast instead of casting).
    const cast = this.castOrder(unitId, s, targetId, x, y);
    if (cast !== null) {
      if (cast) this.sim.noteOrder(unitId, orderId, kind, x, y, targetId);
      return cast;
    }
    let ok = false;
    if (kind === "point") {
      if (s === "attack" || s === "attackground") ok = this.sim.issueAttackMove(unitId, x, y);
      else if (s === "patrol") ok = this.sim.issuePatrol(unitId, x, y);
      else ok = this.sim.issueMove(unitId, x, y); // move / smart / unknown-point → move
    } else if (kind === "target") {
      const u = this.sim.units.get(unitId);
      const t = this.sim.units.get(targetId);
      if (s === "attack") ok = this.sim.issueAttack(unitId, targetId, true);
      // smart on a unit: attack a hostile (incl. team -1 creeps), else follow (ally/neutral).
      else if (u && t) ok = this.sim.hostile(u, t) ? this.sim.issueAttack(unitId, targetId, false) : this.sim.issueFollow(unitId, targetId);
    } else {
      if (s === "stop") (this.sim.stop(unitId), (ok = true));
      else if (s === "holdposition") ok = this.sim.issueHold(unitId);
    }
    if (ok) this.sim.noteOrder(unitId, orderId, kind, x, y, targetId);
    return ok;
  }

  /** Is `order` one of this unit's ABILITY order strings? Then cast it (or toggle its
   *  autocast) and report whether it took. Returns **null** when it isn't an ability
   *  order at all, so the caller falls through to the generic move/attack/stop orders.
   *  Order strings come from the ability data (AbilityFunc `Order`/`Orderon`/`Orderoff`
   *  — e.g. Holy Light's "holybolt"). */
  private castOrder(unitId: number, order: string, targetId: number, x: number, y: number): boolean | null {
    if (!order || ORDER_IDS[order] !== undefined) return null; // a generic order
    const u = this.sim.units.get(unitId);
    if (!u) return null;
    for (const ab of u.abilities) {
      const def = this.abilities.get(ab.id);
      if (!def) continue;
      if (def.order === order) return this.sim.issueCast(unitId, ab.code, targetId, x, y);
      // "…on"/"…off" are the autocast toggles (Heal's "autocastoff"/"autocaston").
      if (def.orderOn === order || def.orderOff === order) {
        const want = def.orderOn === order;
        if (ab.autocastOn !== want) this.sim.toggleAutocast(unitId, ab.code);
        return true;
      }
    }
    return null; // no such ability on this unit — not an ability order we can serve
  }

  /** GetUnitCurrentOrder — the unit's active sim order as a generic order id (0 = none). */
  currentOrderId(unitId: number): number {
    const u = this.sim.units.get(unitId);
    if (!u) return 0;
    switch (u.order) {
      case "move":
      case "follow":
        return ORDER_IDS.move;
      case "attack":
      case "attackmove":
        return ORDER_IDS.attack;
      case "patrol":
        return ORDER_IDS.patrol;
      case "hold":
        return ORDER_IDS.holdposition;
      default:
        return 0; // idle / harvest / cast / repair / getitem / return → no generic id
    }
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
    // Right-click directly on a ground item → send the selected hero(es) to pick it
    // up. Checked BEFORE the unit-order logic (and with the same tight pick radius as
    // hover/selection) so a friendly unit standing near the item can't intercept the
    // click into a "follow" and leave the item on the ground — the intermittent
    // "sometimes doesn't get picked up". A hostile unit under the cursor still wins
    // (attacking through an item is the WC3 priority).
    {
      const pu = picked !== null ? this.sim.units.get(picked) : undefined;
      const hostilePick = !!(pu && prim && !pu.building && this.sim.hostile(prim, pu));
      const g = hostilePick ? null : this.groundPoint(cssX, cssY);
      const gitem = g ? this.sim.itemAt(g[0], g[1], ITEM_PICK_RADIUS) : null;
      if (gitem) {
        let any = false;
        for (const id of this.selected) {
          const u = this.sim.units.get(id);
          if (this.controls(id) && u?.inventory.length) {
            if (this.sim.issueGetItem(id, gitem.id)) any = true;
          }
        }
        if (any) {
          // Yellow (neutral) twin-blink at the item's own hover/selection ring size.
          this.flashRing(gitem.x, gitem.y, ITEM_RING_RADIUS, FLASH_YELLOW, true);
          return;
        }
      }
    }
    if (picked !== null && !this.selected.has(picked)) {
      const target = this.sim.units.get(picked);
      if (target) {
        const selR = this.byId.get(picked)?.selRadius ?? target.radius;
        const lift = this.byId.get(picked)?.moveHeight ?? 0; // air targets: flash at altitude
        const enemy = prim ? this.sim.hostile(prim, target) : false;
        if (enemy && !target.building) {
          // Hostile UNIT: attack + red flash (constant ring, matching its hover).
          let any = false;
          for (const id of this.selected) if (this.order(id, { kind: "attack", targetId: picked }, queued)) any = true;
          if (any) {
            this.flashRing(target.x, target.y, selR, FLASH_RED, false, lift);
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
            this.flashRing(target.x, target.y, selR, FLASH_GREEN, false, lift); // green follow confirm
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
    // (A ground item under the cursor was already handled up top, before unit orders.)
    // Workers in the selection right-clicking a resource start harvesting.
    // Generous pick radii: mines are 4×4 tiles, and clicking a tree canopy
    // lands the ground ray well behind the trunk.
    const mine = this.mineAt(hit[0], hit[1], 320); // …and you cannot mine what you cannot see
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
    const mine = this.mineAt(hit[0], hit[1], 320);
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

  /** Attack-move the whole selection to a ground point. Same destination logic as
   *  groupMove — each unit gets a DISTINCT formation slot around the point so they
   *  spread out there instead of cramming on one tile — but issued as attack-move, so
   *  each unit fights the nearest enemy in its path and resumes to its slot afterwards. */
  private groupAttackMove(tx: number, ty: number, queued = false): void {
    const targets = this.groupTargets([...this.selected], tx, ty);
    for (const [id, [x, y]] of targets) this.order(id, { kind: "attackmove", x, y }, queued);
  }

  /** Queue a target-circle flash — the renderer draws it as a flat ground circle
   *  (a twin-blink, like the selection ring / gold-mine flash), tinted per the
   *  caller. `big` MUST match how the target's hover/selection ring is sized so the
   *  order flash is the SAME size as hovering it: units use the constant ring
   *  (big=false), buildings/mines/trees size to their footprint radius (big=true). */
  private flashRing(x: number, y: number, radius: number, color: [number, number, number], big = true, lift = 0): void {
    // `lift` floats the flash to an air target's altitude so it hugs the flyer
    // instead of blinking on the ground beneath it (matches its selection ring).
    this.flashRequests.push({ x, y, z: this.heightAt(x, y) + lift, radius, color, sizeToRadius: big });
  }
  private flashTarget(x: number, y: number, radius: number): void {
    this.flashRing(x, y, radius, FLASH_YELLOW); // yellow harvest-target flash (mine/tree → sized)
  }
  private flashAttack(x: number, y: number, radius: number, lift = 0): void {
    this.flashRing(x, y, radius, FLASH_RED, false, lift); // red attack-target flash on a unit → constant ring
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
      // `hidden` is "no model on screen"; fogBlocksClick is "no eyes on it" — and an explored
      // enemy BUILDING is drawn but unseen, so the second test is the one that keeps the
      // cursor from grabbing a shop across the map (issue #62). Every click, hover, order and
      // spell target comes through here, so gating the pick gates all of them at once.
      if (e.hidden || this.fogBlocksClick(u)) continue;
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
      if (!u || e.hidden) continue; // no model on screen (worker in a mine, unexplored fog)
      if (u.neutralPassive && !u.building) continue; // critters and other neutral-passive props: no bar
      // A bar is a LIVE reading, so it needs live eyes: a structure the fog has swallowed keeps
      // its image (fogHides leaves the last thing you saw standing there) but loses its bar,
      // exactly as WC3 does — otherwise you could watch an enemy tower's health from across the
      // map without ever scouting it. Same test the cursor uses (issue #62).
      if (this.fogBlocksClick(u)) continue;
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
      const frac = u.maxHp > 0 ? Math.max(0, Math.min(1, u.hp / u.maxHp)) : 0;
      bar.hp.style.width = `${frac * 100}%`;
      // WC3 tints the bar green→yellow→red by HP fraction (own, ally, and enemy
      // alike — the floating bars aren't team-coloured). CSS adds the vertical sheen.
      bar.hp.style.backgroundColor = frac > 0.6 ? "#3fbf46" : frac > 0.3 ? "#d6b93b" : "#c8402f";
      // Mana bar (units/heroes with a mana pool).
      if (u.maxMana > 0) {
        bar.manaTrack.hidden = false;
        bar.mana.style.width = `${Math.max(0, Math.min(1, u.mana / u.maxMana)) * 100}%`;
      } else {
        bar.manaTrack.hidden = true;
      }
      // Hero level badge to the left of the bars. Read the LIVE level from the sim
      // unit (u.level) — e.level is the spawn-time level and doesn't track level-ups.
      if (e.isHero && u.level > 0) {
        bar.level.hidden = false;
        bar.level.textContent = String(u.level);
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

// Flight altitude = the unit's real UnitData `moveheight` (Movement - Height),
// verified against the 1.27 MPQ: 240 for most fliers, 280 (Gryphon/Chimaera),
// 325 (Dragons), 150 (Gargoyle); hover units (Abomination/Lich/Ghost) sit at
// 30–50. No fudge — this is the authentic Z the game floats each unit at.
function lift(moveHeight: number): number {
  return moveHeight > 0 ? moveHeight : 0;
}

// A unit's weapon from its registry stats; null when it can't attack.
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
