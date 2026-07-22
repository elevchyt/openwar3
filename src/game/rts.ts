import { WidgetState } from "mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/widget";
import { SimWorld, weaponsFromDef, type WorkerState, type SimUnit, type SimMine, type SimItem, type BuildingState, type QueuedOrder, type RallyKind, type SimAbility, type HeroInit } from "../sim/world";
import { KNOWN_ABILITIES } from "../data/abilities";
import type { Command } from "./commands";
import { PATHING_CELL, footprintCells, type PathingGrid } from "../sim/pathing";
import type { PlacedFootprint, Footprint } from "../sim/destructibles";
import { PlacedIndex, type PlacedRef } from "./placement";
import { Authority } from "./authority";
import { simHooks, authorityHooks, visionHooks, rosterHooks } from "./jassHooks";
import type { EngineHooks } from "../jass/runtime";
import type { SimView } from "./simView";
export type { PlacedRef };
import {
  type AnimSet,
  animPropsFor,
  buildAnimSet,
  findBirthFields,
  setAnimRate,
  attackAnimRate,
  walkAnim,
  pickSequence,
  seqDuration,
} from "../render/unitAnims";
import { groupTargets, ringTargets, followOffsets } from "./formations";
import { VisionMap, FogState, fogStateOf } from "../sim/vision";
import { Viewpoint, VisionSet } from "./viewpoint";
import { GhostMemory } from "./ghosts";
import { MatchLink, SNAPSHOT_INTERVAL, type DialogMessage, type MatchLinkSetup } from "./matchLink";
import { applyWorldSnapshot } from "./snapshotApply";
import type { WorldSnapshot, UnitSnapshot, GroundItemSnapshot } from "./snapshot";
import { CommandRouter, accepted } from "../net/commandLink";
import { CreepCamps, hiddenFor, minimapDots, minimapIcons, dotsFromSnapshot } from "./minimapView";
import type { RenderUnit } from "./renderUnit";
import { SnapshotIndex } from "./renderView";
import type { FogArea, FogModifier } from "./fog";
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
import { WorldOverlays, type HoverLine, type BarSpec } from "../render/worldOverlays";

// Ties the headless SimWorld to the rendered map (plan §5 vertical slice):
// seeds movable units from the loaded map, syncs sim state → model instances
// each frame, and handles click-to-select / right-click-to-move picking.
// Keeps the sim authoritative; the instances just display it.


// Minimal shapes for the mdx-m3-viewer bits we drive.
interface Instance {
  localLocation: Float32Array;
  localRotation: Float32Array;
  frame: number;
  /** Animation playback rate (mdx-m3-viewer multiplies dt by this before advancing the
   *  clip). WC3 re-rates the attack and walk clips through it — see animRate(). */
  timeScale: number;
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
/** One pre-placed unit, as war3mapUnits.doo lists it. Position + type is enough to match a
 *  rendered instance back to its row, and the row's INDEX is what fixes its sim id. */

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
  /** The local viewpoint sees this unit as an illusion (blue wash + summon timer). Gated by
   *  viewpoint exactly like isSummon: an ENEMY's illusion reports false, so nothing in the
   *  HUD gives it away. See docs/illusions.md. */
  isIllusion: boolean;
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
  insideBuild: boolean; // Orc peon inside the structure it is building (also deselects)
  inBurrow: boolean; // peon garrisoned inside an Orc Burrow (also deselects)
  devoured: boolean; // unit swallowed by a Kodo (also deselects)
  /** This building DIED while this client could not see it, so the authority is still sending
   *  us its last-seen image (item 6d). The model stays standing and the entry stays alive —
   *  it is now drawn from the ghost record, not from a unit. Only ever set on a client. */
  ghosted: boolean;
  curSeq: number; // sequence index currently playing (avoid redundant sets)
  // Art - Animation - Walk/Run Speed (unitUI): the movement speeds the model's "Walk"/"Walk
  // Fast" clips were authored for. The walk cycle is re-rated by speed/gait — see walkAnim().
  animWalkSpeed: number;
  animRunSpeed: number;
  timeScale: number; // JASS SetUnitTimeScale — an override MULTIPLIED onto the animation rate
  curRate: number; // last playback rate applied (avoid redundant sets)
  lastSwingSeq: number; // last sim swingSeq the attack clip was re-triggered for
  lastChopSeq: number; // last sim chopSeq the chop clip was re-triggered for
  castAnimT: number; // >0 while a cast animation is held (skips the normal picker)
  moveEma: number; // smoothed actual/expected displacement — gates the walk clip
  // The position this entry was DRAWN at last frame. The walk/stand picker needs "how far did
  // the drawn unit move this frame", and that is a render fact — the previous DRAWN position —
  // not a sim one. It used to read `SimUnit.prevX/prevY`, which coincides only because the sim
  // and the render tick 1:1 (Phase A). A client drawing 10 Hz snapshots at 60 fps has no such
  // coincidence, and this is the one field the entry sync read that a snapshot does not carry —
  // so tracking it here is what lets the sync be fed a snapshot at all (docs/multiplayer.md
  // item 10c-2). Seeded < 0 so the first frame reads "no previous" and the ratio defaults to 1.
  prevDrawnX: number; // NaN until the first frame draws it, then last frame's drawn x
  prevDrawnY: number;
  baseColor?: Float32Array; // model's own tint, captured before any fog dimming
  fogTintB?: number; // last fog brightness applied (avoids redundant setVertexColor)
  aoeHi?: boolean; // last AoE-target green-tint state applied (avoids redundant setVertexColor)
  illus?: boolean; // last Mirror-Image blue-wash state applied (owner/allies only)
  fade?: number; // last ghost fade applied (invisible/ethereal) — see INVIS_ALPHA
  /** Last alternate-model state this entry's animation set was built for (see animPropsFor).
   *  Undefined until a unit first shows it can be in two forms, which is what keeps the sync
   *  off the overwhelming majority of units that only ever have one. */
  altModel?: boolean;
}

// A unit that is invisible (Wind Walk) or ethereal (Banish, Spirit Walker form) renders
// half-faded — the ghosting WC3 gives both (issue #66). It is a hardcoded engine look
// there, not data: no ability carries a transparency field, and Wind Walk's [AOwk]/[BOwk]
// declare no art whatsoever, so there is nothing in the MPQs to read this from.
const INVIS_ALPHA = 0.5;

// The blue wash an illusion wears for its owner and their allies — the same "not the real
// thing" read a building has while it is being placed. Multiplies the mesh, so the unit's
// own colours still show through underneath. Nothing in the MPQs carries this (AOmi
// declares no tint field); like INVIS_ALPHA it is a hardcoded engine look.
// Exported so the HUD's 3D portrait bust wears the same wash as the unit on the terrain —
// see docs/illusions.md.
export const ILLUSION_TINT = [0.22, 0.42, 1.9] as const;

// Green multiply-tint on a unit's whole mesh while it's a valid target of an armed
// AoE spell (issue #20) — the same idea as the dark-blue "about to be built" ghost
// (PENDING_GHOST_TINT), so a caught unit reads clearly as "this will be hit".
const AOE_TARGET_TINT = [0.25, 1.0, 0.25] as const;

// With a mixed group selected, several units can refuse the same click for different
// reasons, and WC3 shows ONE line. Least to most specific: a unit that doesn't have the
// spell at all tells the player nothing; "not enough mana" tells them plenty. The
// target-rule keys (Targetenemy, Holybolttarget, …) aren't listed and outrank all of
// these — the player aimed at something specific, so naming what's wrong with it is
// always the most useful thing to say.
const CAST_ERROR_RANK = [SimWorld.SILENT_REFUSAL, "Notthisunit", "Targetunit", "Canttargetloc", "Cooldown", "Nomana"];
const castErrorRank = (key: string): number => {
  const i = CAST_ERROR_RANK.indexOf(key);
  return i < 0 ? CAST_ERROR_RANK.length : i;
};


// Brightness of a remembered-but-not-seen building in fog — matches the ground veil's
// EXPLORED_DARK (0.5) so a greyed structure sits at the same dimness as its terrain.
const FOG_EXPLORED_BRIGHT = 0.5;

export type { FogArea, FogModifier } from "./fog";
// A unit ordered to move but pinned in place by the crowd (actual displacement
// far below what its speed would cover) shouldn't run the walk clip — it just
// jogs on the spot, awkwardly. Below this share of expected displacement (EMA-
// smoothed to avoid flicker), fall back to the stand pose instead.
const MOVE_ANIM_MIN_RATIO = 0.2;
const MOVE_EMA_ALPHA = 0.25; // per-tick blend toward the current ratio

/** A payload-to-payload jump longer than this snaps instead of gliding (poseLerp). The
 *  fastest ground speed the game data allows is 522 (MiscData MaxUnitSpeed), so even a
 *  quad-length 0.4 s segment covers ~209 world units — anything past this is a teleport
 *  (Blink, a Zeppelin unload, a Town Portal), and a glide would smear it across the map. */
const POSE_SNAP_DIST = 400;
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
// Extra world-unit gap added to the builder fan-out when several workers speed-
// build one structure, so they spread around the whole footprint instead of
// bunching up (a body-and-a-half wider than the tight gold-mine approach).
const SPEED_BUILD_SPREAD = 48;
const MINE_APPROACH_SPREAD = 16; // gentle widening of the gold-mine approach ring
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

// The floating name slab WC3 draws above the unit under the cursor. Colours
// measured off the real 1.27a client's mouseover shots: the owner (player) line
// is red for an enemy, gold for an ally; the unit's own name and its level are
// white. Everything below the owner line is white regardless of allegiance.
const HOVER_OWNER_ENEMY = "#ff0303"; // WC3 red — a hostile player's name
const HOVER_OWNER_ALLY = "#ffcc00"; // WC3 gold — an allied player's name
const HOVER_TEXT = "#ffffff"; // unit name, "Level N", "Gold: N" — always white

/** A body owed to a script-created unit: the sim unit already exists at this resolved
 *  position, and the renderer attaches a model to it when one has loaded. */
export interface ScriptSpawn {
  typeId: string;
  x: number;
  y: number;
  facing: number;
  player: number;
  team: number;
  simId: number;
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
  // Every viewpoint in the match, created on demand (viewpoint.ts). Exactly ONE exists at
  // runtime — the local player's — because nothing asks for a second yet; Phase E's snapshots
  // are what start calling viewpointFor with somebody else's slot.
  private viewpoints!: VisionSet;
  /** Buildings each player still believes are standing (docs/multiplayer.md item 6b/6c). Fed
   *  from `drainDeadStructures` and cleared by sight. Nothing RENDERS these yet — the local
   *  player still loses a destroyed building off its own screen, which is item 6d — but the
   *  memory is now correct, which is what a snapshot needs. */
  private ghosts = new GhostMemory();
  /** The match's end of the wire, once a LAN game hands one over (item 10b). null in
   *  single-player, where the local sim is the only authority and there is nothing to send to
   *  or diff against. */
  private matchLink: MatchLink | null = null;
  /** The latest snapshot, id-indexed. Empty on the host and in single-player; on a client it
   *  is where the renderer's visibility answers come from (see `modelHidden`). */
  private readonly snapshot = new SnapshotIndex();
  /** Seconds since the match began — the authority's clock the snapshot is stamped with, so a
   *  client can drop one that arrived out of order. */
  private matchTime = 0;
  // …and this machine's own, cached because the render path asks it many times a frame.
  // Re-pointed by setLocalPlayer, which is the only thing that can change it.
  private local!: Viewpoint;
  // Who is allied with whom (7.22). Seeded from the lobby's teams, then mutable by the
  // script (SetPlayerAlliance) — so "Player - Make X treat Y as an Ally" and shared
  // vision are real. The sim reads it through SimWorld.alliedPlayers (installed below).
  private alliances = new AllianceTable();
  // Script-placed fog modifiers (CreateFogModifierRect/Radius). The REGISTRY stays here
  // rather than on the Viewpoint because modifier ids are one global handle space shared
  // with JASS; each rebuild is handed the running ones and picks out its own (Viewpoint
  // .rebuild). Created STOPPED — FogModifierStart is what runs one (the same "the BJ shows
  // it, the native doesn't" shape as timer dialogs), so `running` is not a formality.

  private hovered: number | null = null;
  private hoveredMine: number | null = null; // a gold mine under the cursor (neutral)
  private hoveredItem: number | null = null; // a ground item under the cursor (yellow hover ring)
  private previewIds: number[] = []; // units under the live drag-box (marquee preview rings)
  // Custom-map pre-placed PLAYER units (war3mapUnits.doo, owner slots 0–11). Unlike
  // creeps (owner -1) these are seeded OWNED + simulated, so the local player's own
  // units lift the fog of war (issue #33) and are selectable/commandable. Empty on
  // melee maps (which pre-place no player units — WC3 spawns those at runtime).
  // The pathing footprint stamped for each pre-placed building, by position. Handed to
  // the building's sim unit as it seeds so its death frees the ground it stood on.
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
  /** The authority half — ownership, economy, supply, hero rules, order plumbing.
   *  See game/authority.ts; it imports no renderer, no DOM and no transport. */
  private authority: Authority;
  private overlays: WorldOverlays; // floating HP bars + the hover slab (DOM, client-only)
  // The single floating name/owner slab shown above the unit (or gold mine / ground
  // item) under the cursor. Built lazily into the world layer so it tracks its target
  // Display names for the owner line ("Computer (Normal)", a human's account name).
  // Seeded from the lobby at match start; a player with no entry falls back to "Player N".
  private playerNames = new Map<number, string>();
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
    // Seed 1 is a placeholder: the real match seed isn't known until the lobby settles,
    // and arrives via setSeed() at beginMatch — before anything rolls. See setSeed.
    this.sim = new SimWorld(grid, 1, this.abilities, this.items, this.registry, this.tech, this.upgrades);
    this.creepCampView = new CreepCamps(this.sim); // minimap camp clustering, cached off sim.units
    // Fog-of-war grid, aligned to the same world origin as the pathing grid and
    // spanning the whole map (pathing is 32-unit cells; span = cells × 32).
    const [vox, voy] = grid.origin;
    this.viewpoints = new VisionSet(
      this.sim,
      this.alliances,
      () => this.sim.trees.values(),
      vox,
      voy,
      grid.width * PATHING_CELL,
      grid.height * PATHING_CELL,
    );
    this.local = this.viewpoints.viewpointFor(0); // re-pointed once the lobby says who we are
    // Gate the sim's auto-acquisition on the fog of war (issue #17): idle units only
    // aggro enemies their team can actually SEE. Only the local team's sight is
    // modelled, so other teams pass through as visible (unchanged behaviour).
    // Every team is asked of its OWN grid now. This used to short-circuit every non-local
    // team to "sees everything", because no grid existed for them — harmless while one client
    // rendered one viewpoint, and wrong the moment a host simulates somebody else's army.
    // viewpointForTeam prefers an existing player viewpoint, so the local team keeps being
    // answered by the very grid it always was.
    this.sim.visibleToTeam = (team, x, y) =>
      this.viewpoints.viewpointForTeam(team).vision.stateAt(x, y) === FogState.Visible;
    // …and on terrain: a treeline or cliff between watcher and target blinds the watcher,
    // whatever team it's on. This is what stops ranged creeps shooting a hero standing on
    // the far side of a forest they cannot see through.
    this.sim.lineOfSight = (x1, y1, x2, y2, flying) => this.local.vision.hasLineOfSight(x1, y1, x2, y2, flying);
    // Allegiance between two PLAYER slots comes from the alliance matrix, not the team
    // (7.22) — so a script that allies two players actually stops them fighting. Creeps
    // (owner < 0) are excluded by SimWorld.playerAllegiance and keep the team rule.
    this.sim.alliedPlayers = (a, b) => this.alliances.coAllied(a, b);
    this.authority = new Authority(this.sim, registry, abilities, tech, upgrades);
    this.overlays = new WorldOverlays(host);
  }

  dispose(): void {
    this.overlays.dispose();
  }

  /** Which player's units a drag-box selects (set at melee start). */
  setLocalPlayer(id: number): void {
    this.localPlayer = id;
    // Ask the SET rather than renaming the viewpoint we happen to hold: the set catches a new
    // one up on the height field, the tree blockers and the lobby's fog mode, all of which are
    // installed before this is called (mapViewer runs initVisionBlockers while the terrain
    // loads, a good half-second earlier).
    this.local = this.viewpoints.viewpointFor(id);
    this.local.setTeam(this.localTeam);
  }

  /** Start the match's RNG from the lobby's seed. Called at beginMatch, which is after the
   *  world exists but before any unit is seeded — i.e. before a single roll. In a LAN game
   *  every client is handed the HOST's seed, so a damage die that comes up 3 on the host
   *  comes up 3 everywhere (docs/multiplayer.md). */
  setSeed(seed: number): void {
    this.sim.reseed(seed);
  }

  /** Player display names for the hover tooltip's owner line (set at match start
   *  from the lobby seating: AI slots read "Computer (Normal)"). */
  setPlayerNames(names: Map<number, string>): void {
    this.playerNames = names;
  }

  /** The owner-line label for a player slot — the lobby name, or a generic
   *  "Player N" fallback so an un-seeded slot still reads sensibly. */
  private playerLabel(owner: number): string {
    return this.playerNames.get(owner) ?? `Player ${owner + 1}`;
  }

  /** Which team's combined sight lifts the fog of war (allies share vision). */
  setLocalTeam(team: number): void {
    this.localTeam = team;
    this.local.setTeam(team);
  }

  /**
   * Give every lobby seat its own viewpoint, at match start (docs/multiplayer.md Phase E
   * item 2). Call once the slots are known and before the map script runs.
   *
   * This is the point where the authority stops being able to see only through the eyes it
   * happens to be rendering. Until now a non-local player's grid was minted lazily — by
   * `viewpointForTeam` when the sim asked whether that team could acquire something — and it
   * had to GUESS the team by scanning units, because nothing ever told it. Seating states the
   * lobby's answer instead.
   *
   * Seat computer slots too. A host simulates them, so they need their own fog for the
   * acquisition gate exactly as a human does; leaving them out would gate an AI's army on
   * nothing at all.
   */
  seatPlayers(seats: Iterable<{ player: number; team: number }>): void {
    this.viewpoints.seat(seats);
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
    // Every recipient in the force, not just this machine's player. The old early-out was
    // client-by-construction: correct while one viewpoint was rendered, and silently wrong
    // the moment the authority has to answer for somebody else.
    for (const recipient of toPlayers) this.viewpoints.setExposed(recipient, player, flag);
  }

  /** CreateFogModifierRect / CreateFogModifierRadius[Loc] — created STOPPED (the native
   *  does not start it; FogModifierStart does). Returns the modifier's id. */
  createFogModifier(m: Omit<FogModifier, "running">): number {
    return this.viewpoints.createFogModifier(m);
  }
  fogModifierStart(id: number): void {
    this.viewpoints.fogModifierStart(id);
  }
  fogModifierStop(id: number): void {
    this.viewpoints.fogModifierStop(id);
  }
  destroyFogModifier(id: number): void {
    this.viewpoints.destroyFogModifier(id);
  }

  /** SetFogStateRect / SetFogStateRadius[Loc] — a ONE-SHOT stamp, not a standing
   *  modifier: it changes the fog where it lands and then lets the grid carry on. On our
   *  rebuilt-every-tick `visible` layer a one-shot VISIBLE therefore only *lights* the
   *  area for an instant — but `explored` is sticky, so the lasting effect is that the
   *  area is discovered (grey), and a one-shot MASKED un-discovers it. That is what the
   *  native is used for in practice; a script that wants an area held open uses a
   *  modifier, which is exactly the distinction the two APIs exist to draw. */
  setFogState(player: number, state: number, area: FogArea): void {
    this.viewpoints.stampFor(player, area, fogStateOf(state));
  }

  /** FogEnable / FogMaskEnable — the grey veil and the black mask, switched globally,
   *  and the IsFog*Enabled getters a cinematic saves and restores them through (7.24). */
  setFogEnabled(on: boolean): void {
    this.viewpoints.setFogEnabled(on);
  }
  setFogMaskEnabled(on: boolean): void {
    this.viewpoints.setFogMaskEnabled(on);
  }
  isFogEnabled(): boolean {
    return this.viewpoints.isFogEnabled();
  }
  isFogMaskEnabled(): boolean {
    return this.viewpoints.isFogMaskEnabled();
  }

  /** Does the local viewpoint render `player`'s fog? True for the local player and any
   *  team-mate — the grid is per-TEAM, so a modifier placed on an ally's fog shows up in
   *  ours, and one placed on an opponent's is invisible here (correctly: it is their fog,
   *  not ours). */
  private seesFor(player: number): boolean {
    return this.local.seesFor(player);
  }

  /** The fog-of-war grid — read by the minimap (HUD) and the 3D fog overlay. */
  getVision(): VisionMap {
    return this.local.vision;
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
    this.viewpoints.setStartFog(on ? "revealall" : null);
  }

  /** Lobby "start explored": reveal the whole map as grey terrain memory, keeping
   *  live fog (current sight stays lit, enemy movement in the grey stays hidden). */
  exploreAll(): void {
    this.viewpoints.setStartFog("explored");
  }
  toggleRevealAll(): boolean {
    const on = !this.local.revealed;
    this.local.setRevealAll(on);
    return on;
  }

  /** Install the fog's line-of-sight height field + tree blockers, so vision is
   *  shadowed by high ground and treelines. Called once the map's trees are seeded.
   *  `cliffHeightAt` is the CLIFF-LEVEL sampler (makeCliffLevelSampler), not the full
   *  terrain height — only real cliff levels block WC3 sight, not rolling groundHeight
   *  (see hiveworkshop "About high ground advantage" #255594). */
  initVisionBlockers(cliffHeightAt: HeightSampler): void {
    this.viewpoints.initBlockers(cliffHeightAt);
  }

  /** A tree was felled — it stops blocking sight (harvesting can open a sight line).
   *  `radius` must match the one it was stamped with, so it releases its own cells. */
  onTreeFelled(x: number, y: number, radius: number): void {
    this.viewpoints.onTreeFelled(x, y, radius);
  }

  /** Is this unit off screen for `vp` — for ANY reason, not just fog?
   *
   *  Two kinds of reason, and keeping them apart is the point. A unit inside a gold mine, in
   *  a burrow, swallowed by a Kodo or removed outright is off screen for EVERYONE; fog and
   *  invisibility are answers that depend on who is looking. The minimap used to read
   *  `Entry.hidden` for this, which is the same sum computed once for the local viewpoint —
   *  fine for the one client rendering it, useless for asking about anybody else. */
  /** @see minimapView.hiddenFor — the viewpoint-independent reasons, then fog and invisibility. */
  private hiddenFor(vp: Viewpoint, u: SimUnit): boolean {
    return hiddenFor(vp, u);
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
    return this.local.fogBlocksClick(u);
  }

  /** The same test for a GOLD MINE, which is not a sim unit and so has its own pick path (it is
   *  found from the ground point, not from the unit entries — see mineAt). A mine is a building
   *  like any other: the fog keeps its image once you have explored it, but the image is not the
   *  mine. You cannot select it, hover it, send a worker into it or rally to it until something
   *  of yours is looking at it. */
  private fogBlocksMine(m: { x: number; y: number }): boolean {
    return this.local.fogBlocksAt(m);
  }

  /** The gold mine at a ground point — the ONLY way a mine is picked, so that the fog gate holds
   *  for every click that can land on one (select, hover, right-click harvest, rally). */
  private mineAt(x: number, y: number, radius: number): SimMine | null {
    const m = this.sim.nearestMine(x, y, radius);
    return m && !this.fogBlocksMine(m) ? m : null;
  }

  /** The ground item at a point — the ONLY way an item is picked, so the fog gate holds for
   *  hover, select and right-click-to-pick-up alike (the same deal mineAt gives a mine).
   *
   *  An item is NOT remembered under fog the way a building is: a building you have seen
   *  keeps standing on the terrain as an image, but an item is a live widget and vanishes
   *  with the eyes on it. Without this gate the cursor read straight through pitch-black
   *  unexplored ground and named every tome on the map. */
  private itemAt(x: number, y: number, radius: number): SimItem | null {
    const it = this.sim.itemAt(x, y, radius);
    return it && !this.fogBlocksItem(it) ? it : null;
  }

  /** Whether a ground item's model should be drawn — the renderer's half of the same fog
   *  rule the pick above enforces, so what you can name is exactly what you can see. */
  itemVisible(id: number): boolean {
    const it = this.sim.items.get(id);
    return !!it && !this.fogBlocksItem(it);
  }

  /** No eyes on this spot right now → the item under it is neither drawn nor pickable. */
  private fogBlocksItem(it: { x: number; y: number }): boolean {
    return this.local.fogBlocksAt(it);
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

  /**
   * The record the FRAME is drawn from (docs/multiplayer.md item 10c-2c-2).
   *
   * On the host and in single-player this is the live sim unit. On a client that has been sent
   * a snapshot it is the payload's record — the authority's answer rather than the client's own
   * prediction of it. Every position-anchored draw goes through here and nothing else, which is
   * what makes the switch ATOMIC: the model, its health bar, its selection ring and its hover
   * slab cannot end up reading different worlds, because there is only one place to read from.
   *
   * `undefined` means "no record" and has two different causes that want the same handling: the
   * unit is gone from the sim (a race between a death and this frame), or the client was not
   * SENT it. Both mean "do not draw", and `modelHidden` already says so.
   *
   * Panel readouts (`infoFor`, the command card) deliberately do NOT come through here yet.
   * They are drawn at a fixed place in the HUD rather than over the terrain, so a frame's
   * disagreement there is invisible rather than a Frankenstein — see item 10c-2c-3.
   */
  private frameUnit(id: number): RenderUnit | undefined {
    // ONE source now, even on a client — the record store. Under option 2 the applier makes
    // the records ≡ the payload (create/update/REMOVE, so "absent → undefined → hide" is the
    // same maphack-safe answer the SnapshotIndex gave), and the records are what `poseLerp`
    // glides between payloads. Drawing the raw payload here was the July playtest's
    // "incredibly choppy" client: the interpolation wrote smooth poses into records nobody's
    // frame ever read, while every model jumped at the wire's 10 Hz.
    return this.sim.units.get(id);
  }

  /** Should this unit's model be on screen at all?
   *
   *  Two answers to one question, and which one is asked is the whole of item 10c-2c. The host
   *  and single-player consult the LOCAL fog grid, because they hold the world. A client that
   *  has been sent a snapshot reads the answer OUT of the payload instead — it arrived
   *  AoI-filtered, so asking our own grid again would be re-deriving a decision the authority
   *  already made, and a client that re-derives it is a client that can decide differently
   *  (the maphack `dotsFromSnapshot` refuses to ship). Pinned equal to `hiddenFor` in
   *  `tools/sim-minimap-test.cjs`, so the switch cannot change what is drawn. */
  private modelHidden(id: number): boolean {
    if (this.snapshot.active) return this.snapshot.hidden(id);
    const u = this.sim.units.get(id);
    return u === undefined || this.hiddenFor(this.local, u);
  }

  /** `modelHidden`, inverted, for the renderer's ubersplat pass: a building's ground splat is
   *  part of its IMAGE, so it shows exactly when the model does — live or remembered — and is
   *  withheld with it. Splats used to bypass this entirely and answer to nothing but the fog
   *  VEIL, which leaked a never-scouted building's foundation through explored fog (the host
   *  reading a client's base off the ground), and left orphaned foundations where a frozen
   *  client's applier had removed the building's record. */
  buildingImageShown(id: number): boolean {
    return !this.modelHidden(id);
  }

  /**
   * Is this unit's live state something the viewer actually KNOWS right now — or is it an
   * image left standing in the fog?
   *
   * The health bar and the hover slab both hang on this: WC3 leaves a scouted building's model
   * on the terrain but takes its health bar away, because a bar is a live reading and a memory
   * is not (issue #62). On a client the payload has already answered — a `remembered` record
   * arrives with its hp, its queue and its construction timer redacted to zero, so reading the
   * bit is reading the authority's decision rather than re-deriving it from a grid the client
   * should not be consulting.
   */
  private drawnFromMemory(id: number): boolean {
    // `u` is the RECORD now (frameUnit), and a SimUnit must not grow a `remembered` field
    // (renderUnit.ts says why) — so the memory bit is read off the payload INDEX, which still
    // tracks the newest snapshot for exactly these per-recipient facts.
    if (this.snapshot.active) return this.snapshot.unit(id)?.remembered === true;
    const su = this.sim.units.get(id);
    return su !== undefined && this.fogBlocksClick(su);
  }

  /** Apply the combined visibility decision (gold-mine + fog) to one render entry,
   *  toggling the instance and firing the mine-entry deselect side-effect once.
   *
   *  `hide` is decided by the caller (`modelHidden`) rather than here: on a client it is the
   *  payload's answer, and this method has no business knowing which of the two it got. */
  private applyVisibility(e: Entry, u: RenderUnit, hide: boolean): void {
    if (u.inMine !== e.inMine) {
      e.inMine = u.inMine;
      if (u.inMine) {
        this.deselect(e.simId); // a worker entering a mine drops out of the selection
        if (this.hovered === e.simId) this.hovered = null;
      }
    }
    if (u.insideBuild !== e.insideBuild) {
      e.insideBuild = u.insideBuild;
      if (u.insideBuild) {
        this.deselect(e.simId); // an Orc peon vanishing into its build drops out of the selection
        if (this.hovered === e.simId) this.hovered = null;
      }
    }
    if (u.inBurrow !== e.inBurrow) {
      e.inBurrow = u.inBurrow;
      if (u.inBurrow) {
        this.deselect(e.simId); // a peon climbing into a burrow drops out of the selection
        if (this.hovered === e.simId) this.hovered = null;
      }
    }
    const devoured = u.devouredBy > 0;
    if (devoured !== e.devoured) {
      e.devoured = devoured;
      if (devoured) {
        this.deselect(e.simId); // a unit swallowed by a Kodo drops out of the selection
        if (this.hovered === e.simId) this.hovered = null;
      }
    }
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

  /** Re-skin a unit that has changed FORM: rebuild its animation set for the new state and
   *  play the transition clip on the way.
   *
   *  The model never changes — one MDX carries both forms — so this is not a remodel, just a
   *  different reading of the same sequence list (see animPropsFor). The set is built for the
   *  state being moved TO, which is also what makes `morph` land on the correct half of the
   *  Morph/Morph Alternate pair without either direction being named here.
   *
   *  Two abilities arrive here and neither is named: an Ancient rooting (`Aroo`, where the
   *  planted pose is the alternate one) and a Crypt Fiend burrowing (`Abur`, where the
   *  underground pose is). CryptFiend.mdx and AncientOfWar.mdx are built the same way —
   *  "Stand"/"Stand Alternate" with a Morph pair between — so both need exactly this and the
   *  sim tells them apart, not the renderer.
   *
   *  The first call for a unit sets the baseline without playing anything: a freshly built
   *  Ancient is already rooted and should simply BE planted, not animate itself into it. */
  private applyFormAnims(e: Entry, u: RenderUnit, def: UnitDef | undefined): void {
    const alt = u.altModel;
    if (e.altModel === alt) return;
    const first = e.altModel === undefined;
    e.altModel = alt;
    const seqs = e.unit.instance.model?.sequences;
    if (!seqs) return;
    e.anims = buildAnimSet(seqs, animPropsFor(def, alt));
    if (first) return; // baseline only — no transition to play
    // Hold the morph clip for its own length: castAnimT keeps the ordinary stand/walk picker
    // off this unit until the Ancient has finished hauling itself up or settling down.
    if (e.anims.morph < 0) return; // model authors no transition — snap to the new set
    const inst = e.unit.instance;
    inst.setSequence(e.anims.morph);
    inst.setSequenceLoopMode(SequenceLoopMode.ModelDefined);
    e.curSeq = e.anims.morph;
    e.unit.state = WidgetState.WALK; // hold it against the idle picker, as a cast clip does
    e.castAnimT = seqDuration(inst, e.anims.morph, CAST_ANIM_HOLD);
  }

  /** Dim an enemy/neutral BUILDING that's shown from fog memory (last-seen, out of
   *  current sight) to the same grey as the ground veil — WC3 greys remembered
   *  structures. Own units and anything currently in sight stay full colour; mobile
   *  enemy units never reach here (fogHides already hides them out of sight). Tint
   *  multiplies the model's own base colour so a unit's team/UnitData tint survives. */
  private applyFogTint(e: Entry, u: RenderUnit): void {
    const inst = e.unit.instance;
    if (!inst.setVertexColor) return;
    let b = 1;
    // On a client this is `u.remembered` — the SAME fact, decided by the authority and carried
    // in the payload, rather than the client re-running a fog rule of its own (item 10c-2c-2).
    if (this.drawnFromMemory(e.simId)) {
      b = FOG_EXPLORED_BRIGHT; // remembered-but-not-seen → half-bright grey
    }
    // Green whole-mesh tint while this unit is a valid target of an armed AoE spell.
    const hi = this.aoeHighlight.has(e.simId);
    // A Mirror Image illusion wears a blue wash — and ONLY its owner and their allies see
    // it. That asymmetry is the ability: you must be able to pick your images apart from
    // your hero, while the enemy sees N identical Blademasters and has to guess. So it
    // keys off the LOCAL viewpoint (seesFor), not off the unit itself.
    // On the wire the bit is ALREADY viewpoint-resolved: item 5 masks it at the source, so an
    // enemy's snapshot simply says `false` and no `seesFor` is needed (nor available — a client
    // rendering someone else's answer has no business re-deciding it). On the sim path the
    // local viewpoint is still what knows.
    const illus = u.isIllusion && (this.snapshot.active || this.seesFor(u.owner));
    // Half-fade the ghosted states (issue #66). This has to compose with the tint here
    // rather than be written straight to the instance: baseColor caches the model's own
    // colour and this method re-emits from it every time the fog brightness changes, so
    // an alpha written anywhere else would be clobbered on the next re-emit.
    const fade = u.ethereal || u.invisible ? INVIS_ALPHA : 1;
    if (e.fogTintB === b && e.aoeHi === hi && e.fade === fade && e.illus === illus) return; // unchanged since last tick
    e.fogTintB = b;
    e.aoeHi = hi;
    e.illus = illus;
    e.fade = fade;
    if (!e.baseColor) {
      const c = inst.vertexColor;
      e.baseColor = c ? new Float32Array([c[0], c[1], c[2], c[3]]) : new Float32Array([1, 1, 1, 1]);
    }
    const base = e.baseColor;
    const g = hi ? AOE_TARGET_TINT : ([1, 1, 1] as const);
    const m = illus ? ILLUSION_TINT : ([1, 1, 1] as const);
    inst.setVertexColor([base[0] * b * g[0] * m[0], base[1] * b * g[1] * m[1], base[2] * b * g[2] * m[2], base[3] * fade]);
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

  /** What war3mapUnits.doo declares about every placed entity, and the id it reserved
   *  for each. See game/placement.ts — the renderer still hands this data in through the
   *  setters below, which are the same public surface it always called. */
  private placed = new PlacedIndex();

  setNeutralPassive(positions: Array<{ x: number; y: number }>): void {
    this.placed.setNeutralPassive(positions);
  }

  setPlacedOrder(order: PlacedRef[]): void {
    this.placed.setPlacedOrder(order);
  }

  setCreepData(data: Array<{ x: number; y: number; aggro: number; drops?: Array<{ items: Array<{ id: string; chance: number }> }> }>): void {
    this.placed.setCreepData(data);
  }

  setPlayerUnitSeeds(seeds: Array<{ x: number; y: number; owner: number; team: number }>): void {
    this.placed.setPlayerUnitSeeds(seeds);
  }

  setPlacedFootprints(stamps: PlacedFootprint[]): void {
    this.placed.setPlacedFootprints(stamps);
  }

  /**
   * How to read a building's pathing footprint out of its `pathTex`. Injected because decoding
   * one is a VFS read and this half must not import an archive — the renderer already caches
   * them, a headless host would read its own install.
   */
  setFootprintReader(read: (texPath: string) => Footprint | null): void {
    this.footprintOf = read;
  }
  private footprintOf: (texPath: string) => Footprint | null = () => null;

  /**
   * JASS `CreateUnit` — the AUTHORITY half (docs/multiplayer.md Phase E item 1h).
   *
   * `CreateUnit` is SYNCHRONOUS: the very next statement may add an ability, set the hero's
   * level, or order the unit somewhere. So the sim unit is created right here and its id returned
   * at once; the BODY is queued and attached a few frames later, when its model has loaded.
   *
   * This is why the dual-writer trick from item 1c does not fit `createUnit` and the list was
   * wrong to predict it: the placement is RESOLVED here — a building snaps to the build grid, a
   * ground unit created on a blocked cell is displaced to the nearest fit — and
   * `createUnit(): number` can only carry an id back, not the resolved position the renderer needs
   * to put a model at. A queue carries both.
   */
  createScriptUnit(player: number, typeId: string, x: number, y: number, facingDeg: number, teamOf: (p: number) => number): number {
    const def = this.registry.get(typeId);
    if (!def) return -1;
    const grid = this.sim.grid;
    const fp = def.isBuilding && def.pathTex ? this.footprintOf(def.pathTex) : null;
    if (fp) [x, y] = grid.snapForBuildingRect(x, y, fp.w, fp.h);
    // A ground unit created ON a blocked cell — the classic "spawn a creep out of a building"
    // trigger passes the building's own centre — is displaced by WC3 to the nearest free spot,
    // so it emerges beside the structure rather than stuck inside it. Snap it to the nearest
    // cell its footprint fits, exactly as a freshly-trained unit leaves its factory. Flyers and
    // buildings are exempt (buildings snap above).
    if (!def.isBuilding && def.moveType !== MoveType.Fly) {
      const n = footprintCells(def.collision || 16);
      const [cx, cy] = grid.worldToCell(x, y);
      if (!grid.footprintFits(cx, cy, n)) {
        const fit = grid.nearestFit(cx, cy, n) ?? grid.nearestWalkable(cx, cy);
        if (fit) [x, y] = grid.cellToWorld(fit[0], fit[1]);
      }
    }
    const facing = (facingDeg * Math.PI) / 180;
    const team = teamOf(player);
    const simId = this.reserveUnitId();
    this.addSimUnit(def, x, y, facing, player, team, 0, simId); // exists NOW
    this.scriptSpawns.push({ typeId, x, y, facing, player, team, simId }); // …gets a body later
    return simId;
  }

  private scriptSpawns: ScriptSpawn[] = [];

  /** Bodies owed to script-created units since the last drain. The renderer loads each model
   *  and attaches it to the sim unit that already exists — the same shape as
   *  `drainSummonRequests`, and for the same reason. A headless host simply never drains. */
  drainScriptSpawns(): ScriptSpawn[] {
    if (!this.scriptSpawns.length) return this.scriptSpawns;
    const out = this.scriptSpawns;
    this.scriptSpawns = [];
    return out;
  }

  /** Attach the map-stamped footprint at this position (if any) to a freshly-seeded
   *  building, so it owns its collision and takes it away when it dies. */
  private adoptPlacedFootprint(simId: number, x: number, y: number): void {
    const p = this.placed.claimFootprintAt(x, y);
    if (p) this.sim.setPathStamp(simId, p.fp, p.x, p.y);
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
      // A point-target spell can't aim at a single icon — nothing to refuse, just disarm.
      if (cast.target !== "unit") {
        this.orderMode = null;
        this.armedCast = null;
        return true;
      }
      const err = this.castRefusal(cast.code, simId);
      if (err !== null) return this.refuseOrder(err); // stays armed, exactly as on the map
      this.orderMode = null;
      this.armedCast = null;
      this.castFromSelection(cast.code, simId, 0, 0);
      return true;
    }
    if (this.orderMode === "attack") {
      this.orderMode = null;
      const t = this.sim.units.get(simId);
      if (t && simId !== this.primary) {
        for (const id of this.selected) if (id !== simId) this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: simId, force: true }, queued: false });
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
    this.overlays.hideBars();
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
      const seed = def ? this.placed.playerSeedAt(loc[0], loc[1]) : null;
      if (seed) {
        this.seedPlayerUnit(unit, def!, loc, seed.owner, seed.team);
        continue;
      }
      // Neutral Passive (shops/taverns/labs/merchants/fountains/critters): seed
      // it as a static, non-hostile, yellow-ringed selectable — even though it's
      // a building with no walk clip.
      if (this.placed.isNeutralPassiveAt(loc[0], loc[1])) {
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
      // The id this creep's .doo row reserved — NOT the order its model happened to load in.
      const simId = this.placed.reserveIdAt(loc[0], loc[1], def?.id ?? "");
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
      const aggro = this.placed.creepAggroAt(loc[0], loc[1]);
      su.aggroRange = aggro > 0 ? aggro : su.weapon?.acquire ?? def?.acquireRange ?? 0;
      // Normal (-1) vs Camp (-2) — the World Editor's two-way "Target Acquisition Range"
      // radio (WorldEditStrings WESTRING_UPROPS_AR_NORMAL / _AR_CAMP). Melee mapmakers put
      // Normal on the gold-mine guards and Camp on everything else; a Camp creep ignores
      // the building-placement notification, so you can build beside it in peace.
      su.campGuard = aggro === -2;
      su.canSleep = def?.canSleep ?? false;
      this.sim.setUnitDrops(simId, this.placed.creepDropsAt(loc[0], loc[1])); // scatter loot on death
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
        insideBuild: false,
        inBurrow: false,
        devoured: false,
      ghosted: false,
        curSeq: -1,
        animWalkSpeed: def?.animWalkSpeed ?? 0,
        animRunSpeed: def?.animRunSpeed ?? 0,
        timeScale: 1,
        curRate: 1,
        lastSwingSeq: -1,
        lastChopSeq: -1,
        castAnimT: 0,
        moveEma: 1,
        prevDrawnX: NaN,
        prevDrawnY: NaN,
      };
      this.entries.push(entry);
      this.byId.set(simId, entry);
      this.creepCampView.reset(); // a creep arrived — re-cluster camps lazily
    }
    this.seeded = true;
  }

  /** Seed a Neutral Passive entity (shop/tavern/lab/merchant/fountain/critter):
   *  a static, non-hostile sim unit with the yellow ring. We don't drive its
   *  instance in tick() (the map viewer already renders it) — this record just
   *  makes it hoverable/selectable and rings it. */
  private seedNeutral(unit: MapUnit, def: UnitDef | undefined, loc: Float32Array): void {
    const simId = this.placed.reserveIdAt(loc[0], loc[1], def?.id ?? "");
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
    if (isBuilding) this.adoptPlacedFootprint(simId, loc[0], loc[1]); // its collision dies with it
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
      insideBuild: false,
      inBurrow: false,
      devoured: false,
      ghosted: false,
      curSeq: -1,
      animWalkSpeed: def?.animWalkSpeed ?? 0,
      animRunSpeed: def?.animRunSpeed ?? 0,
      timeScale: 1,
      curRate: 1,
      lastSwingSeq: -1,
      lastChopSeq: -1,
      castAnimT: 0,
      moveEma: 1,
      prevDrawnX: NaN,
      prevDrawnY: NaN,
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
    // addSimUnit + attachInstance rather than addUnit, because addUnit's `reservedId` means
    // "the sim unit already exists, just give it a body" (the JASS CreateUnit path) and
    // returns -1 when it doesn't. A pre-placed unit needs its reserved id at CREATION.
    const simId = this.addSimUnit(def, loc[0], loc[1], facing, owner, team, 0, this.placed.reserveIdAt(loc[0], loc[1], def.id));
    this.attachInstance(simId, unit.instance, def);
    // A pre-placed BUILDING takes ownership of the footprint the map loader stamped for
    // it, so levelling it reopens the ground — WarChasers' gnoll huts are exactly this.
    if (def.isBuilding) this.adoptPlacedFootprint(simId, loc[0], loc[1]);
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
    return this.placed.nextUnitId();
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
    const simId = reservedId ?? this.placed.nextUnitId();
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
      // The draw comes off the SIM's seeded stream, not Math.random: properName is written
      // into sim state and shown to every player, so two machines watching the same match
      // must name the hero the same thing.
      ? { properName: def.properNames.length ? def.properNames[Math.floor(this.sim.random() * def.properNames.length)] : "", level: Math.max(1, def.level), str: def.strength, agi: def.agility, int: def.intelligence, strPerLevel: def.strPerLevel, agiPerLevel: def.agiPerLevel, intPerLevel: def.intPerLevel, primaryAttr: def.primaryAttr }
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
    // An Ancient is BUILT rooted, so it starts on the alternate (planted) half of its model.
    // Everything else starts on the plain half and only the sim can move it off (a Crypt
    // Fiend that burrows). See animPropsFor / applyFormAnims.
    const alt = this.sim.units.get(simId)?.altModel ?? false;
    const anims = buildAnimSet(instance.model.sequences, animPropsFor(def, alt));
    // Per-unit animation blending: cross-fade between sequences over this unit's
    // own UnitUI `blend` time (0.15s for most WC3 units) so walk↔stand↔attack
    // transitions ease instead of hard-cutting (issue #8).
    instance.setBlendTime?.(def.animBlend);
    const entry: Entry = {
      simId,
      unit: { instance, state: WidgetState.IDLE },
      anims,
      altModel: alt ? true : undefined,
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
      insideBuild: false,
      inBurrow: false,
      devoured: false,
      ghosted: false,
      curSeq: -1,
      animWalkSpeed: def?.animWalkSpeed ?? 0,
      animRunSpeed: def?.animRunSpeed ?? 0,
      timeScale: 1,
      curRate: 1,
      lastSwingSeq: -1,
      lastChopSeq: -1,
      castAnimT: 0,
      moveEma: 1,
      prevDrawnX: NaN,
      prevDrawnY: NaN,
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
    // A morph is how a unit ENTERS its alternate form (a Crypt Fiend burrowing), so the new
    // body has to be read with that form's props or it arrives wearing the plain half — the
    // burrowed Fiend standing above ground. Re-baselining `altModel` also lets applyFormAnims
    // play the transition, which it otherwise skips: the flag already matches.
    const alt = this.sim.units.get(simId)?.altModel ?? false;
    const props = animPropsFor(def, alt);
    entry.anims = buildAnimSet(instance.model.sequences, props);
    entry.altModel = alt ? true : undefined;
    Object.assign(entry, findBirthFields(instance.model.sequences, props));
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
  /** JASS SetUnitTimeScale — a trigger override on the model's animation playback rate.
   *  It does not replace the engine's own attack/walk re-rating but multiplies on top of
   *  it (UI\TriggerStrings "Change Unit Animation Speed"), so a unit scaled to 2x still
   *  speeds its walk cycle up with a Bloodlust. Applied by setAnimRate. */
  setUnitTimeScale(simId: number, scale: number): void {
    const e = this.byId.get(simId);
    if (!e) return;
    e.timeScale = scale;
    e.curRate = NaN; // force setAnimRate to re-apply against the new override next tick
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
    e.castAnimT = seqDuration(e.unit.instance, seq, CAST_ANIM_HOLD);
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
    if (this.frozenClient) {
      // Option 2 (docs/multiplayer.md, decided): a client's sim never steps. The record
      // store is written by the payload instead — create, update, and REMOVE, absence
      // being "you cannot see it", which is what finally takes the enemy's base out of
      // this process's memory rather than merely off its screen. Everything below the
      // step — the event drains, corpse bookkeeping, vision, the entry sync — runs
      // unchanged against the written records; the drains simply find empty queues.
      const latest = this.matchLink?.latest();
      if (latest && latest !== this.lastApplied) {
        this.applySnapshot(latest); // reads lastApplied for the segment duration — order matters
        this.lastApplied = latest;
        // Derived state the sim would have ticked into existence: shop patrons. Without
        // this the local authority refused every buyitem (no patron was ever adopted) and
        // the shop's overhead arrow never appeared on a client.
        this.sim.adoptShopBuyers();
      }
      // Glide the records between payloads (see poseLerp) — the payload wrote where every
      // unit IS, this writes where the frame should DRAW it, one interval behind.
      this.tickPoseLerp(dt);
    } else {
      this.sim.tick(dt);
    }
    this.playImpacts(); // BEFORE deaths — a killed target's entry is still around to read its armour
    for (const id of this.sim.drainDeaths()) this.onDeath(id);
    for (const id of this.sim.drainRemovals()) this.onRemove(id);
    // Offer every dead structure to the ghost memory BEFORE the fog rebuilds below, so each
    // viewpoint is judged on the sight it had when the building fell rather than on sight it
    // gains this tick. A viewpoint that was watching keeps no image — it saw the collapse.
    for (const u of this.sim.drainDeadStructures()) this.ghosts.noteDestroyed(u, this.viewpoints.viewerSeats());
    this.tickCorpses(dt);
    if (this.hovered !== null && !this.byId.has(this.hovered)) this.hovered = null;
    if (this.hoveredMine !== null && !this.sim.mines.has(this.hoveredMine)) this.hoveredMine = null;
    if (this.hoveredItem !== null && !this.sim.items.has(this.hoveredItem)) this.hoveredItem = null;
    // Fog of war: rebuild the "currently visible" layer a few times a second — WC3
    // refreshes fog periodically, not every frame, and this keeps circle-stamping
    // cheap. The initial accumulator > interval forces a rebuild on the first tick.
    // Every viewpoint keeps its own 10 Hz clock. Only the LOCAL one's rebuild re-prunes the
    // selection, because the selection is this machine's, not the match's.
    const rebuilt = this.viewpoints.tick(dt);
    // A ghost is forgotten by SIGHT, not by a clock (measured against the real 1.27a client),
    // and the moment a viewpoint's sight changes is exactly when it rebuilt.
    for (const vp of rebuilt) this.ghosts.forgetSeen(vp.player, vp);
    if (rebuilt.includes(this.local)) {
      this.pruneFogged(); // whatever the new fog swallowed leaves the selection (issue #62)
    }
    this.driveMatchLink(dt);
    // Adopt the newest payload once per tick. On a client this is where "what may I see" stops
    // being a question we answer and becomes one we were answered (`modelHidden`).
    this.snapshot.update(this.matchLink?.latest() ?? null);
    for (const e of this.entries) {
      // The FRAME's record: the local sim on the host and in single-player, the received
      // snapshot on a client (item 10c-2c-2). `undefined` means there is nothing to draw —
      // either the sim dropped the unit between ticks, or this client was never sent it — and
      // both want the same handling: hide the model and leave everything else alone.
      const u = this.frameUnit(e.simId);
      if (u === undefined) {
        // The ghost was FORGOTTEN — this client re-scouted the spot and found empty ground, so
        // the host dropped the image (`forgetSeen`, 6b). The entry outlived its unit only to
        // carry that image, so it goes now. WC3 shows rubble, not a replayed collapse: the
        // player walks back and the building is simply not there.
        if (e.ghosted) {
          this.forgotten.push(e); // retired after the loop — see `forgotten`
          continue;
        }
        if (!e.hidden) {
          e.hidden = true;
          e.unit.instance.hide();
          if (this.hovered === e.simId) this.hovered = null;
        }
        continue;
      }
      // How far this unit moved SINCE IT WAS LAST DRAWN — a render fact the walk/stand picker
      // needs (see `prevDrawnX`). Captured before anything can `continue`, then advanced to the
      // position about to be drawn, so every entry's previous stays current whatever branch it
      // takes. NaN on the first frame means "no previous": read the current position so the
      // delta is zero and a freshly spawned unit stands rather than false-triggering a walk.
      const prevX = Number.isNaN(e.prevDrawnX) ? u.x : e.prevDrawnX;
      const prevY = Number.isNaN(e.prevDrawnY) ? u.y : e.prevDrawnY;
      e.prevDrawnX = u.x;
      e.prevDrawnY = u.y;
      if (u.neutralPassive) {
        this.applyVisibility(e, u, this.modelHidden(e.simId)); // static & viewer-rendered, but fog still hides/reveals it
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
      this.applyVisibility(e, u, this.modelHidden(e.simId));
      // A unit that has changed FORM wears the other half of its model — a rooted Ancient, a
      // burrowed Crypt Fiend. Skipped entirely for the vast majority, which have only one.
      if (u.altModel || e.altModel !== undefined) this.applyFormAnims(e, u, this.registry.get(e.typeId));
      // A building under construction: play its own "Birth" animation, scrubbed
      // to the construction progress so it assembles in sync with the timer.
      // Models without a Birth clip fall back to scaling up from ~40% to full.
      if (u.building && u.building.constructionLeft > 0) {
        setAnimRate(e, 1); // the Birth clip is scrubbed by progress, not played at a rate
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
      if (u.spawning > 0) {
        setAnimRate(e, 1);
        continue;
      }
      // Hold a cast animation so the throw/slam/spell gesture (or a looped channel)
      // plays out instead of being overwritten by the stand/attack picker. But drop
      // the hold the instant the unit is interrupted — a new order, or it starts
      // moving (a canceled cast backswing / channel) — so the picker takes over at
      // once and WC3 "animation canceling" looks instantaneous.
      if (e.castAnimT > 0) {
        e.castAnimT -= dt;
        if (u.order === "cast" && !u.moving) {
          setAnimRate(e, 1); // a cast gesture plays at its authored rate, unhasted
          continue;
        }
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
        setAnimRate(e, 1);
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
        // A proc'd swing (a Critical Strike, or the blow that breaks Wind Walk — see
        // SimUnit.swingSlam) shows the model's "Attack Slam" instead of a random plain
        // swing: that clip is authored for exactly this and is why the Blademaster and
        // the Mountain King have one. Models without it just swing normally.
        const vs =
          u.swingSlam && e.anims.attackSlam >= 0
            ? [e.anims.attackSlam]
            : w && w.carryGold > 0 && e.anims.attackGold.length
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
        // Re-rate every tick, not just on the swing: attack speed can change mid-swing
        // (a Bloodlust lands, a Slow wears off) and the clip must follow it at once.
        setAnimRate(e, attackAnimRate(u));
      } else {
        // Smooth the actual/expected displacement so the walk clip only plays
        // when the unit is really making progress — a unit wedged in a crowd
        // (moving ordered, but barely inching) stands instead of jogging in place.
        const expected = u.speed * dt;
        const ratio = expected > 1e-3 ? Math.hypot(u.x - prevX, u.y - prevY) / expected : 1;
        e.moveEma += (Math.min(ratio, 1) - e.moveEma) * MOVE_EMA_ALPHA;
        const effMoving = u.moving && e.moveEma >= MOVE_ANIM_MIN_RATIO;
        let seq = pickSequence(e.anims, u, effMoving);
        // Walking re-rates the cycle to the unit's live move speed (and may swap in a
        // "Walk Fast" gait); every other pose plays at its authored rate.
        if (effMoving) {
          const w = walkAnim(e, u, seq);
          seq = w.seq;
          setAnimRate(e, w.rate);
        } else {
          setAnimRate(e, 1);
        }
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
    if (this.forgotten.length) {
      for (const e of this.forgotten) this.dropEntry(e);
      this.forgotten.length = 0;
    }
    this.updateHealthBars();
    this.overlays.syncHoverTip(this.computeHoverTip());
  }

  /** The sim removed this unit: play its death animation, then decay the corpse
   *  (flesh → bone) in place until it's fully removed (see tickCorpses). */
  private onDeath(simId: number): void {
    const e = this.byId.get(simId);
    if (!e) return;
    // **A death you did not witness is not a death you may animate** (item 6d). The authority
    // decides that, and it says so by continuing to send the building: `GhostMemory` mints an
    // image only for a viewer who was NOT watching when it fell (6b), so a `remembered` record
    // still in our payload IS the host telling us "you have no way to know this happened".
    // Collapsing the model here would be the client volunteering intelligence its own sim
    // happens to hold — the same class of mistake as re-deriving fog, arriving through the
    // death event instead of through the grid.
    //
    // The local sim's death is still the TRIGGER, and deliberately: sequencing B means the
    // client simulates the same match, so it learns of the death at the right moment. What it
    // must not do is act on it. The payload is only consulted for permission.
    const image = this.snapshot.active ? this.snapshot.unit(simId) : undefined;
    if (image?.remembered) {
      e.ghosted = true; // stands frozen, dimmed by `drawnFromMemory`, until the ghost is forgotten
      return;
    }
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
    // Drop any attack/walk re-rating: the model outlives its Entry as a corpse, and a unit
    // cut down mid-stride would otherwise play its Death and decay clips at its walk rate.
    e.unit.instance.timeScale = 1;
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
    this.dropEntry(e);
  }

  /** Retire one render entry: off the roster, out of the selection and the hover, model
   *  hidden. No death clip and no corpse — this is the path for a model that simply stops
   *  existing (a cancelled build, a forgotten ghost), not for one that dies on screen. */
  private dropEntry(e: Entry): void {
    this.byId.delete(e.simId);
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
    this.deselect(e.simId);
    if (this.hovered === e.simId) this.hovered = null;
    e.unit.instance.hide();
  }

  /** Ghost entries whose image the host has just dropped, collected during the entry sync and
   *  retired after it. Deferred because `dropEntry` splices `this.entries`, and splicing the
   *  array a `for…of` is walking silently skips the next element. */
  private readonly forgotten: Entry[] = [];

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
        if (c.phaseT < seqDuration(c.instance, c.anims.death, DEATH_CLIP_FALLBACK)) continue;
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
        if (c.phaseT >= seqDuration(c.instance, c.anims.decayFlesh, DECAY_CLIP_FALLBACK) / 2) {
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
    // No Animnames and no Spell clip on the model → the caster simply stands. This used to
    // fall back to the ATTACK animation, which is not something WC3 does: the engine plays
    // the clip Animnames asks for, else "Spell", else nothing. The Blademaster has no Spell
    // clip at all (Stand/Attack/Walk/Death/Dissipate), so Mirror Image — which declares no
    // Animnames either — had him swing his sword to conjure his images.
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
      const it = this.itemAt(g[0], g[1], ITEM_PICK_RADIUS);
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
      const u = this.frameUnit(e.simId); // "on screen" is a question about the DRAWN position
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
  private onScreen(u: RenderUnit, e: Entry): boolean {
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
      // Projected to screen and compared against the drag box, so it must be the position the
      // model was DRAWN at — box-selecting off the sim while drawing off the snapshot would
      // catch units the player can see just outside the box and miss ones inside it.
      const u = this.frameUnit(e.simId);
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
        const it = this.itemAt(g[0], g[1], ITEM_PICK_RADIUS);
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
  orderMode: "move" | "attack" | "patrol" | "rally" | "repair" | "cast" | "item" | "selectuser" | null = null;
  /** The shop awaiting a purchaser pick when orderMode === "selectuser" (WC3's "Select
   *  Hero"/"Select Unit"). Unlike every other armed order this one belongs to a building
   *  the player may not even own — a neutral Goblin Merchant — so it carries the shop's id
   *  rather than acting on the selection. */
  armedShopUser: { shopId: number } | null = null;
  /** The spell armed for targeting when orderMode === "cast". `area` (>0) shows an
   *  AoE cast circle at the cursor for point-target area spells. */
  armedCast: { code: string; target: "unit" | "point"; area?: number } | null = null;
  /** The inventory item armed for targeting when orderMode === "item": a point-use
   *  item (blink) awaiting a ground click, or a passive item awaiting a drop/give
   *  target (ground → drop, allied hero → give). */
  armedItem: { slot: number; mode: "usepoint" | "move" } | null = null;

  /** Called when an order is refused, with a commandstrings.txt [Errors] key — the host
   *  (render/mapViewer.ts) turns it into the gold line above the console and the error
   *  sound. Set by the host; the sim itself has no UI. */
  onRefuse?: (errorKey: string) => void;

  /** Execute the armed order at a screen point. Returns true when consumed
   *  (the caller should then clear the HUD's armed state); false leaves it armed —
   *  either nothing was armed, or the order was REFUSED and the player gets to
   *  click again without re-arming the spell. */
  orderClickAt(cssX: number, cssY: number, queued = false): boolean {
    // Nominating a shop's purchaser is checked BEFORE the "do I control the selection"
    // gate: the selection here is the SHOP, and the whole point of a neutral Goblin
    // Merchant is that nobody controls it. What must be controllable is the unit picked.
    if (this.orderMode === "selectuser") {
      const shopId = this.armedShopUser?.shopId;
      const picked = this.pickAt(cssX, cssY);
      if (shopId === undefined) {
        this.orderMode = null;
        this.armedShopUser = null;
        return true;
      }
      // A refused pick keeps the order armed so the player can click again, exactly as a
      // refused cast does — you aimed at the wrong thing, you did not cancel the command.
      // The two refusals are the game's own, and it has a string for precisely this
      // ability: "Select a unit with an inventory." (commandstrings.txt Inventoryinteract).
      const target = picked === null ? undefined : this.sim.units.get(picked);
      if (!target || !this.controls(picked!) || !target.inventory.length) return this.refuseOrder("Inventoryinteract");
      if (!this.execute(this.localPlayer, { c: "shopbuyer", shopId, unitId: picked! })) return this.refuseOrder("Neednearbypatron");
      this.orderMode = null;
      this.armedShopUser = null;
      return true;
    }
    if (!this.orderMode || this.selected.size === 0 || !this.hasControllable()) {
      this.orderMode = null;
      return false;
    }
    const mode = this.orderMode;
    // A cast is the one order that can be REFUSED, so it validates before anything is
    // torn down: an invalid target must leave orderMode/armedCast exactly as they were
    // (the reticle is derived from them each frame, so that alone keeps it on screen).
    // Every other mode is unconditionally consumed, as before.
    if (mode === "cast") {
      const cast = this.armedCast;
      if (!cast) {
        this.orderMode = null;
        return true;
      }
      if (cast.target === "unit") {
        const picked = this.pickAt(cssX, cssY);
        const err = this.castRefusal(cast.code, picked ?? 0);
        if (err !== null) return this.refuseOrder(err);
        this.orderMode = null;
        this.armedCast = null;
        this.castFromSelection(cast.code, picked!, 0, 0);
        return true;
      }
      const hit = this.groundHitAt(cssX, cssY); // point-target spell
      if (!hit) return this.refuseOrder("Canttargetloc"); // "Unable to target there."
      const err = this.castRefusal(cast.code, 0);
      if (err !== null) return this.refuseOrder(err);
      this.orderMode = null;
      this.armedCast = null;
      this.castFromSelection(cast.code, 0, hit[0], hit[1]);
      return true;
    }
    this.orderMode = null;
    if (mode === "item") {
      const armed = this.armedItem;
      this.armedItem = null;
      const id = this.primary;
      if (!armed || id === null || !this.controls(id)) return true;
      if (armed.mode === "usepoint") {
        const hit = this.groundHitAt(cssX, cssY);
        if (hit) this.execute(this.localPlayer, { c: "useitem", unitId: id, slot: armed.slot, targetId: 0, x: hit[0], y: hit[1] });
        return true;
      }
      // "move": the carried item goes to whatever was clicked — a SHOP buys it back (WC3 sells
      // by exactly this gesture: right-click the item, then click the Goblin Merchant / Arcane
      // Vault / Marketplace), an allied hero is handed it, and bare ground gets it dropped.
      const picked = this.pickAt(cssX, cssY);
      const to = picked !== null ? this.sim.units.get(picked) : undefined;
      if (to && picked !== null && picked !== id && this.sim.canPawnAt(to)) {
        this.execute(this.localPlayer, { c: "sellitem", unitId: id, slot: armed.slot, shopId: picked });
      } else if (to && picked !== null && picked !== id && this.controls(picked) && to.inventory.length) {
        this.execute(this.localPlayer, { c: "giveitem", unitId: id, slot: armed.slot, targetId: picked });
      } else {
        const hit = this.groundHitAt(cssX, cssY);
        if (hit) {
          this.execute(this.localPlayer, { c: "dropitem", unitId: id, slot: armed.slot, x: hit[0], y: hit[1] });
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
          this.execute(this.localPlayer, { c: "rally", unitId: id, x: r.x, y: r.y, kind: r.kind, targetId: r.targetId });
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
          for (const id of this.selected) if (id !== picked && this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: picked, force: true }, queued: queued })) any = true;
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
    this.groundOrder(mode, hit[0], hit[1], queued);
    return true;
  }

  /** The ground-point form of an armed order: patrol / attack-move / move to a world
   *  point. Shared by a click in the world (orderClickAt, once the ray has hit the
   *  terrain) and a click on the MINIMAP, which resolves straight to a world point. */
  private groundOrder(mode: "move" | "attack" | "patrol", wx: number, wy: number, queued: boolean): void {
    if (mode === "patrol") {
      for (const id of this.selected) this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "patrol", x: wx, y: wy }, queued: queued });
      this.queueArrow(wx, wy, MOVE_ARROW);
    } else if (mode === "attack") {
      this.groupAttackMove(wx, wy, queued); // distinct formation slot per unit (like move)
      this.queueArrow(wx, wy, ATTACK_ARROW); // red a-move feedback
    } else {
      this.groupMove(wx, wy, queued); // spread the group into a formation
      this.queueArrow(wx, wy, MOVE_ARROW);
    }
  }

  /** A click on the MINIMAP, already resolved to a world point (issue #64). The minimap
   *  can only name a POINT — it has no unit picking — so the orders it carries are the
   *  ground-point ones: right-click moves, and an armed A-move / patrol / rally lands at
   *  the point, exactly as a click on the terrain would. Right-click also cancels an armed
   *  order (WC3), like right-clicking the world.
   *
   *  A SPELL (or an item) is never aimed at the minimap — the real game won't let you fire
   *  one blind at a map pixel, and neither do we: the click is swallowed and the spell stays
   *  armed, waiting for a real target in the world.
   *
   *  "ordered" → the click became a command (the HUD clears its armed highlight and must
   *  NOT pan); "ignored" → consumed, and whatever is armed stays armed (the click does
   *  nothing rather than mis-firing or panning out from under the player mid-aim);
   *  "none" → not a command at all (a plain left-click, which pans the camera). */
  minimapClick(wx: number, wy: number, right: boolean, queued: boolean): "ordered" | "ignored" | "none" {
    const mode = this.orderMode;
    if (right && mode) {
      this.orderMode = null; // right-click disarms a pending target (WC3), never orders
      this.armedCast = null;
      this.armedItem = null;
      return "ordered";
    }
    if (!this.selected.size || !this.hasControllable()) {
      if (mode) {
        this.orderMode = null;
        this.armedCast = null;
        this.armedItem = null;
        return "ordered";
      }
      return "none";
    }
    // A spell, an item, a repair or a shop's purchaser pick is aimed at a thing in the
    // WORLD, never at the minimap — swallow the click and leave it armed (right-click,
    // above, is how you back out of one).
    if (mode === "cast" || mode === "item" || mode === "repair" || mode === "selectuser") return "ignored";
    if (mode === "rally") {
      this.orderMode = null;
      for (const id of this.selected) {
        this.execute(this.localPlayer, { c: "rally", unitId: id, x: wx, y: wy, kind: "point", targetId: 0 });
      }
      this.rallyFeedback({ x: wx, y: wy, kind: "point", targetId: 0 });
      this.sounds?.playUi("RallyPointPlace");
      return "ordered";
    }
    if (mode) {
      this.orderMode = null;
      this.ack(mode === "attack");
      this.groundOrder(mode, wx, wy, queued);
      return "ordered";
    }
    if (!right) return "none"; // plain left-click: the HUD pans the camera
    // Right-click with no armed order — the minimap's default (smart) command. With no unit
    // to pick, the only sensible reading of a bare point is "go there" (WC3).
    this.ack(false);
    this.groupMove(wx, wy, queued);
    this.queueArrow(wx, wy, MOVE_ARROW);
    return "ordered";
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
      if (this.execute(this.localPlayer, { c: "cast", unitId: id, code, targetId, x, y })) any = true;
    }
    if (any) this.ack(false);
  }

  /** Can ANY unit in the selection cast this at that target? Returns null when one can,
   *  else why the best-placed one can't — with a whole group selected WC3 reports a single
   *  reason, and the one that gets furthest through the checks is the informative one
   *  ("Not enough mana." beats "Must target an enemy unit." from a unit that lacks the
   *  spell entirely). CAST_ERROR_RANK orders them; the last is the most specific. */
  private castRefusal(code: string, targetId: number): string | null {
    let worst: string | null = null;
    let worstRank = -1;
    for (const id of this.selected) {
      if (this.sim.units.get(id)?.owner !== this.localPlayer) continue;
      const err = this.sim.castError(id, code, targetId);
      if (err === null) return null; // someone can cast — the order stands
      const rank = castErrorRank(err);
      if (rank >= worstRank) {
        worstRank = rank;
        worst = err;
      }
    }
    return worst;
  }

  /** Refuse the armed order: tell the player why and LEAVE IT ARMED. WC3 doesn't spend
   *  your click on a target it won't accept — the reticle stays up so the next click can
   *  aim properly, and only Escape/right-click disarms. */
  private refuseOrder(errorKey: string): boolean {
    this.onRefuse?.(errorKey);
    return false;
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
      if (from !== slot) this.execute(this.localPlayer, { c: "swapitem", unitId: id, from, to: slot });
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
    // self/instant consumable — fire immediately
    this.execute(this.localPlayer, { c: "useitem", unitId: id, slot, targetId: 0, x: u.x, y: u.y });
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
    return this.primary !== null && this.execute(this.localPlayer, { c: "learnskill", unitId: this.primary, abilityId });
  }

  /** Toggle an autocast ability (Heal, Slow, …) on the whole own selection. */
  toggleAutocast(code: string): void {
    for (const id of this.selected) this.execute(this.localPlayer, { c: "autocast", unitId: id, code });
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
   *  action queue), so a stopped unit doesn't resume a queued order.
   *
   *  Through `order()` like Hold, for the same Phase C reason (docs/multiplayer.md).
   *  `issueOrder` does the queue-clearing itself, and exempts stop from the cast-lock guard
   *  so it keeps its one special power: aborting a wind-up that has started but not fired. */
  stopSelected(): void {
    for (const id of this.selected) this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "stop" }, queued: false });
  }

  /** Hold Position on the selection: each unit plants where it stands and attacks
   *  only enemies that walk into its weapon range, never chasing (WC3 Hold). Like
   *  Stop, it wipes the shift-queue so the unit doesn't resume a queued order.
   *
   *  Goes through `order()` like every other player order (Phase C, docs/multiplayer.md):
   *  hold was the one order already expressible as a `QueuedOrder` that still reached the
   *  sim by hand, which would have made it silently host-only once commands go on the wire.
   *  `issueOrder` clears the queue itself, so the only thing lost is the hand-rolled
   *  `clearQueue` — and losing it fixes a bug: it used to drop a channeling unit's queue
   *  for a Hold that `issueHold`'s own castLocked guard then refused ("don't even drop the
   *  queue for an ignored order", world.ts). */
  holdSelected(): void {
    for (const id of this.selected) this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "hold" }, queued: false });
  }

  /** Order the selected workers to repair a damaged friendly building. WC3
   *  rates: 35% of the build cost and 150% of the build time to go 1 HP→full. */
  private repairAt(picked: number | null, queued = false): boolean {
    if (picked === null) return false;
    let any = false;
    for (const id of this.selected) {
      if (this.execute(this.localPlayer, { c: "repair", unitId: id, buildingId: picked, queued })) any = true;
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
      attackType: AttackType.None, armorType: ArmorType.Unknown, isHero: false, isIllusion: false, properName: "", level: 0, xp: 0, xpThis: 0, xpNext: 0, skillPoints: 0, strength: 0,
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
      attackType: AttackType.None, armorType: ArmorType.Unknown, isHero: false, isIllusion: false, properName: "", level: 0, xp: 0, xpThis: 0, xpNext: 0, skillPoints: 0, strength: 0,
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
    // The authority's numbers, not our own prediction of them (item 10c-2c-3). A panel is
    // drawn at a fixed place in the HUD rather than over the terrain, so this could wait for
    // its own slice — but "how much health does my hero actually have" is exactly the question
    // a client must not answer for itself, and now it does not. The panel steps at the
    // snapshot's 10 Hz rather than the frame's 60; that IS the rate at which the host knows.
    const u = this.frameUnit(id);
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
        // `level` is optional on `RenderBuildJob` because only a research slot carries one;
        // the `?? 0` is unreachable for `kind === "research"` and is here so the flattened
        // shape needs no cast back to the union it came from.
        icon: (j.kind === "research" ? this.upgrades.icon(j.unitId, j.level ?? 0) : this.registry.get(j.unitId)?.icon) ?? "",
      })),
      icon: this.registry.get(e.typeId)?.icon ?? "",
      carryGold: u.worker?.carryGold ?? 0,
      carryLumber: u.worker?.carryLumber ?? 0,
      isMine: false,
      goldRemaining: 0,
      isItem: false,
      description: "",
      // The "Summoned Unit" timer bar. A Mirror Image illusion is a summon and shows one —
      // but only to the side that owns it and their allies. Click an enemy's image and it
      // must look like an ordinary Blademaster: a timer bar over one of four identical
      // heroes would hand the opponent the answer the ability exists to hide.
      // Already viewpoint-resolved on the wire — item 5 masks the illusion bit AND the whole
      // summon triple with it, so an enemy's payload reports an ordinary hero with no expiry.
      // A client re-applying `seesFor` here would be a client deciding for itself which units
      // are illusions; on the sim path the local viewpoint is still what knows.
      isSummon: u.isSummon && u.summonLeft > 0 && (!u.isIllusion || this.snapshot.active || this.seesFor(u.owner)),
      isIllusion: u.isIllusion && (this.snapshot.active || this.seesFor(u.owner)), // same viewpoint rule as the tint

      summonSecondsLeft: Math.max(0, Math.ceil(u.summonLeft)),
      summonFrac: u.summonMax > 0 ? Math.max(0, Math.min(1, u.summonLeft / u.summonMax)) : 0,
      buffs: this.statusBuffsFor(u),
    };
  }

  /** Active buffs/auras/debuffs on a unit, de-duped by source, resolved to an icon
   *  + name for the HUD status row. Aura buffs carry their base code in `group`. */
  private statusBuffsFor(u: RenderUnit): Array<{ icon: string; name: string; harmful: boolean }> {
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
      const u = this.frameUnit(id); // the ring sits under the MODEL, so it reads the model's record
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
      const u = this.frameUnit(id);
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
      const u = this.frameUnit(this.hovered);
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
      // The SAME record the entry sync scrubbed this frame (item 10c-2c-4). Reading the sim
      // here while the sync read the snapshot would set the birth frame twice per frame from
      // two different progresses — a building that visibly stutters between two states of
      // construction on a client, and only on a client.
      const u = this.frameUnit(e.simId);
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
      case "stop":
        return null; // neither has a destination/target to draw a marker for
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
  /**
   * READ-ONLY view of the world, for everything the renderer needs in order to draw.
   * `SimWorld` satisfies it structurally; the maps are `ReadonlyMap`, so a consumer that
   * tries to edit the authoritative world stops compiling. See game/simView.ts.
   */
  get simView(): SimView {
    return this.sim;
  }

  /**
   * Attach a LAN match's end of the wire (docs/multiplayer.md Phase E item 10b/10b-note).
   *
   * Called once, after `startMelee`/`startCustom`, so the world it will snapshot already
   * exists. In single-player this is never called and `driveMatchLink` is a no-op — the local
   * player's behaviour is unchanged either way, which is the whole of sequencing B: the client
   * keeps simulating, and the link only sends (host) or compares-and-logs (client) alongside.
   */
  attachMatchLink(setup: MatchLinkSetup): void {
    const link = new MatchLink(setup.channel, setup.localPlayer, setup.seats, setup.hostPeer);
    this.matchLink = link;
    this.matchLinkIsHost = setup.isHost;
    link.onDialog = this.remoteDialog; // set before the link existed, in either order
    if (setup.isHost) {
      // The host is the only party that judges an arriving command. `CommandRouter` resolves
      // the relay's `from` stamp — which no client can forge — to a slot, and a command whose
      // sender holds no seat is dropped (item 9). Then the SAME `Authority.execute` a local
      // action goes through, so a peer's order is judged by exactly the rule the host's own is.
      const router = new CommandRouter(setup.seats);
      link.onCommand = (from, msg) => {
        const judged = router.receive(from, msg);
        if (!accepted(judged)) {
          if (import.meta.env.DEV) console.info(`[sync] host dropped a command from peer ${from}: ${judged}`);
          return;
        }
        const ok = this.authority.execute(judged.player, judged.cmd);
        // A refused remote command is invisible from the client's chair — its local charge is
        // undone by the next snapshot and the queued job never echoes back, which reads as a
        // silent cancel. Name it on the host so a playtest report comes with its reason.
        if (!ok && import.meta.env.DEV) console.info(`[sync] host REFUSED p${judged.player} ${JSON.stringify(judged.cmd)}`);
      };
    }
  }
  private matchLinkIsHost = false;

  /** Is a LAN match's wire attached? The renderer's background pump keys on this: a
   *  networked match must keep simulating when its window is hidden (the authority owes
   *  the room snapshots), where single-player keeps the browser's natural pause. */
  get networked(): boolean {
    return this.matchLink !== null;
  }

  /** Option 2 (docs/multiplayer.md): is this machine a client whose `SimWorld` is a record
   *  store the snapshot writes? True from the moment the wire attaches — the local sim
   *  never steps again; until the first payload lands the records simply hold what the
   *  map-script init seeded, which the first application then corrects. */
  get frozenClient(): boolean {
    return this.matchLink !== null && !this.matchLinkIsHost;
  }

  /** The payload object last written into the records, so a payload is applied exactly once
   *  (`MatchLink.latest()` hands back the same object until a new one lands). */
  private lastApplied: WorldSnapshot | null = null;

  /** Write one payload into the record store (see `snapshotApply.ts` for the semantics).
   *  Creation goes through `addSimUnit` under the HOST's id — the def seeds the ~90
   *  sim-internal fields the wire does not carry, and the reserved id is the whole point:
   *  a client allocates no ids of its own, so none can collide (playtest bugs 5/6). */
  private applySnapshot(snap: WorldSnapshot): void {
    // Interpolation start poses are captured BEFORE the applier overwrites the records: a
    // record's pose right now is the pose the last frame DREW (tickPoseLerp wrote it), which
    // is exactly where this segment must depart from or every arrival visibly snaps.
    this.poseLerp.clear();
    const starts = this.poseStarts;
    starts.clear();
    for (const s of snap.units) {
      const u = this.sim.units.get(s.id);
      if (u && !s.remembered) starts.set(s.id, { x: u.x, y: u.y, f: u.facing, h: u.flyHeight });
    }
    const res = applyWorldSnapshot(this.sim, snap, (s) => {
      const def = this.registry.get(s.typeId);
      if (!def) return null;
      this.addSimUnit(def, s.x, s.y, s.facing, s.owner, s.team, 0, s.id);
      return this.sim.units.get(s.id) ?? null;
    });
    // Build this interval's pose segments: from the drawn pose to the payload's. A unit the
    // payload CREATED has no start and simply appears at its position; one that jumped a
    // teleport's distance snaps rather than glides (a Blink must not smear across the map).
    for (const s of snap.units) {
      if (s.remembered) continue;
      const from = starts.get(s.id);
      if (!from) continue;
      const dx = s.x - from.x;
      const dy = s.y - from.y;
      const df = s.facing - from.f;
      const dh = s.flyHeight - from.h;
      if (dx === 0 && dy === 0 && df === 0 && dh === 0) continue; // parked — nothing to glide
      if (Math.hypot(dx, dy) > POSE_SNAP_DIST) continue;
      this.poseLerp.set(s.id, { x0: from.x, y0: from.y, f0: from.f, h0: from.h, x1: s.x, y1: s.y, f1: s.facing, h1: s.flyHeight });
    }
    // The segment plays out over the HOST-TIME gap between this payload and the last one, so
    // a dropped snapshot yields one double-length segment at the unit's true speed instead of
    // a half-speed crawl followed by a jump. Clamped: the first payload has no predecessor,
    // and a rejoin's catch-up gap is minutes nobody should spend gliding.
    const prevTime = this.lastApplied?.time ?? snap.time;
    this.poseLerpDur = Math.min(Math.max(snap.time - prevTime, SNAPSHOT_INTERVAL), 4 * SNAPSHOT_INTERVAL);
    this.poseLerpT = 0;
    // Bodies owed (item 2c): entries for `removed` retire through the ordinary removal
    // drain (`removeUnit` queued them); entries for `created` are owed to the renderer,
    // which grows a model over the existing record exactly like a script spawn.
    this.snapshotSpawns.push(...res.created);
    this.snapshotItemSpawns.push(...res.createdItems);
    this.snapshotItemRemovals.push(...res.removedItems);
  }

  /** This interval's pose segments (docs/multiplayer.md item 2c-interp): what the applier
   *  wrote is the unit's pose AT THE SNAPSHOT, and drawing it verbatim renders the match at
   *  10 Hz — every unit hops a tenth-second of travel each payload, and the walk-clip gate
   *  (which smooths drawn displacement against `speed * dt`) reads the hops as standing.
   *  So on a frozen client the RECORD pose is re-written every frame, gliding from where the
   *  last frame drew to where the payload said, one snapshot interval behind the authority —
   *  and every consumer (models, bars, minimap dots, picking, the walk gate) inherits the
   *  60 fps motion because they all read the same records. */
  private poseLerp = new Map<number, { x0: number; y0: number; f0: number; h0: number; x1: number; y1: number; f1: number; h1: number }>();
  private poseStarts = new Map<number, { x: number; y: number; f: number; h: number }>();
  private poseLerpT = 0;
  private poseLerpDur = SNAPSHOT_INTERVAL;

  /** Advance the glide and write the interpolated pose into the records. Runs only on a
   *  frozen client, from `tick`, after any fresh payload has (re)built the segments. */
  private tickPoseLerp(dt: number): void {
    if (!this.poseLerp.size) return;
    this.poseLerpT += dt;
    const f = Math.min(1, this.poseLerpT / this.poseLerpDur);
    for (const [id, p] of this.poseLerp) {
      const u = this.sim.units.get(id);
      if (!u) {
        this.poseLerp.delete(id);
        continue;
      }
      u.x = p.x0 + (p.x1 - p.x0) * f;
      u.y = p.y0 + (p.y1 - p.y0) * f;
      u.flyHeight = p.h0 + (p.h1 - p.h0) * f;
      // Shortest arc, so a unit crossing the ±π seam turns a few degrees rather than a lap.
      let df = (p.f1 - p.f0) % (2 * Math.PI);
      if (df > Math.PI) df -= 2 * Math.PI;
      else if (df < -Math.PI) df += 2 * Math.PI;
      u.facing = p.f0 + df * f;
    }
    // Hold at the payload's pose once the segment is spent (a late snapshot pauses units
    // where the authority last put them — never extrapolate past what the host said).
    if (f >= 1) this.poseLerp.clear();
  }

  /** Records the applier created since the last drain — a client's trained peon, a
   *  scouted enemy building coming back into view. The renderer gives each a body
   *  (item 2c); the record already exists under the HOST's id. */
  private snapshotSpawns: UnitSnapshot[] = [];
  drainSnapshotSpawns(): UnitSnapshot[] {
    if (!this.snapshotSpawns.length) return this.snapshotSpawns;
    const out = this.snapshotSpawns;
    this.snapshotSpawns = [];
    return out;
  }

  /** Ground items the applier created/removed — same 2c contract, for item models. */
  private snapshotItemSpawns: GroundItemSnapshot[] = [];
  private snapshotItemRemovals: number[] = [];
  drainSnapshotItemSpawns(): GroundItemSnapshot[] {
    if (!this.snapshotItemSpawns.length) return this.snapshotItemSpawns;
    const out = this.snapshotItemSpawns;
    this.snapshotItemSpawns = [];
    return out;
  }
  drainSnapshotItemRemovals(): number[] {
    if (!this.snapshotItemRemovals.length) return this.snapshotItemRemovals;
    const out = this.snapshotItemRemovals;
    this.snapshotItemRemovals = [];
    return out;
  }

  /**
   * Host: hand a remote player the dialog its own script will never raise (item F7).
   *
   * Returns whether it went anywhere, so the caller can tell "relayed" from "that player is
   * the host, or a computer" and not bookkeep a send that never happened. A no-op in single
   * player and on a client, where `matchLink` is null or we are not the authority.
   */
  relayDialog(player: number, msg: DialogMessage): boolean {
    if (!this.matchLink || !this.matchLinkIsHost) return false;
    return this.matchLink.sendDialog(player, msg);
  }

  /** The match is over on this machine — end the wire (Phase G item 1). Safe to call twice. */
  endMatchWire(): void {
    this.matchLink?.endMatch();
  }

  /** Client: the authority raised a dialog for us. Set by whoever owns the dialog UI. */
  set onRemoteDialog(fn: (msg: DialogMessage) => void) {
    this.remoteDialog = fn;
    if (this.matchLink) this.matchLink.onDialog = fn;
  }
  private remoteDialog: (msg: DialogMessage) => void = () => {};

  /** Once a tick: the host emits a snapshot per recipient; a client diffs the newest arrival
   *  against what it simulated and logs where they disagree. Nothing here changes what is
   *  DRAWN — that is item 10c. */
  private driveMatchLink(dt: number): void {
    const link = this.matchLink;
    if (!link) return;
    this.matchTime += dt;
    let drift = 0;
    if (this.matchLinkIsHost) {
      link.tickHost(dt, this.sim, {
        // `Viewpoint` satisfies `SnapshotViewer` (pinned by snapshot-viewer-conformance.ts),
        // and `viewerSeats` already pairs each with its player.
        viewers: () => this.viewpoints.viewerSeats(),
        ghostsFor: (p) => this.ghosts.ghostsFor(p),
        commandsApplied: () => this.authority.applied,
      }, this.matchTime);
    } else if (link.latest()) {
      // Client: compare the authority's newest view against our own, for OUR seat — while that
      // still means anything. `compare` refuses once a command has landed on either side (F5):
      // the local sim is a prediction fed only OUR input, so from then on a difference reports
      // the missing inputs, not a bug.
      const findings = link.compare(this.sim, this.local, this.ghosts.ghostsFor(this.localPlayer), this.authority.applied);
      drift = findings.length;
      if (drift) {
        // A drift log, not an error: sequencing B expects disagreement and wants it named. One
        // grouped line per tick, so a desynced match does not scroll the console to uselessness.
        console.warn(`[sync] ${drift} divergence(s):`, link.describe().join(" | "));
      } else if (link.comparisonStopped && !this.saidComparisonStopped) {
        // Said ONCE, and said at all: a detector that just went quiet reads as a detector that
        // is finding nothing, which is the comfortable reading and the wrong one.
        this.saidComparisonStopped = true;
        console.info("[sync] divergence checking stopped: a command has been applied, so the local sim and the authority are no longer running the same inputs (docs/multiplayer.md F5).");
      }
    }
    this.matchLinkHeartbeat(link, drift);
  }

  /** The one-time notice that the drift comparison has ended (item F5) has been printed. */
  private saidComparisonStopped = false;
  private hbAccum = 0;
  /** A once-a-second dev line proving the pipe is alive — sent/received counts and current
   *  drift. Dev-only (`import.meta.env.DEV` is folded to false in a build, so this whole method
   *  and the counters it reads drop out), because it exists to make the two-client LAN harness
   *  WATCHABLE (docs/multiplayer.md item 10b-harness); a silent [sync] is indistinguishable
   *  from a dead one. */
  private matchLinkHeartbeat(link: MatchLink, drift: number): void {
    if (!import.meta.env.DEV) return;
    this.hbAccum += 1;
    if (this.hbAccum < 60) return; // ~1 s at 60 Hz
    this.hbAccum = 0;
    const role = this.matchLinkIsHost ? "host" : "client";
    console.info(`[sync] ${role}: sent ${link.sent}, received ${link.received}, stale ${link.stale}, drift ${drift}`);
  }

  /**
   * The whole authoritative world. What remains of this escape hatch is the JASS
   * `EngineHooks` — natives that MUTATE the world (`SetUnitOwner`, `AddHeroXP`,
   * `CreateItem`), which are authority-side work that happens to be wired up inside the
   * renderer — plus a handful of setup calls. Every plain lookup now goes through
   * `simView` instead. Narrowing the rest means moving those hooks onto `Authority`,
   * which is the remaining half of Phase B item 7.
   */
  get simWorld(): SimWorld {
    return this.sim;
  }

  /**
   * The non-presentation half of the JASS `EngineHooks` table (docs/multiplayer.md Phase E
   * item 1/1b) — every native whose answer comes from the world or the authority.
   *
   * This exists so the renderer does not have to reach for `simWorld` or for `authority` to
   * build a hook table. `authority` is PRIVATE and stays private: handing it out would open
   * exactly the escape hatch `simWorld` already is, one layer up, and `execute()` would stop
   * being the only door. Composing here is what lets both stay shut — the controller holds
   * both halves already, so it is the one place that can hand over a finished table without
   * handing over the pieces.
   *
   * A headless host builds the same two factories directly and injects its own presentation
   * entries (or none), which is the whole point of the split.
   *
   * `teamOf` is passed in rather than read here because the slot→team seating is the LOBBY's and
   * this controller does not hold it — see `simHooks`. The two dual-writer natives it feeds
   * (`SetUnitOwner`, `SetUnitFlyHeight`) come back with their WORLD half only; a caller that also
   * has models re-declares them over this table and calls back into these entries.
   */
  worldHooks(teamOf: (player: number) => number): Partial<EngineHooks> {
    return {
      ...simHooks(this.sim, teamOf),
      ...authorityHooks({
        stashFor: (o) => this.authority.stashFor(o),
        foodFor: (o) => this.authority.foodFor(o),
        setPlayerResource: (p, r, v) => this.authority.setPlayerResource(p, r, v),
        currentOrderId: (id) => this.authority.currentOrderId(id),
        issueUnitOrder: (id, oid, o, k, x, y, t) => this.authority.issueUnitOrder(id, oid, o, k, x, y, t),
        // CreateUnit needs the CONTROLLER, not the authority object: resolving placement reads
        // the pathing grid and the footprint reader, and attaching a body needs the spawn queue.
        createScriptUnit: (p, t, x, y, f) => this.createScriptUnit(p, t, x, y, f, teamOf),
      }),
      ...visionHooks(this.viewpoints, this.alliances),
      ...rosterHooks(this.sim, this.registry, teamOf),
    };
  }

  /**
   * Apply a player command. THE choke point (docs/multiplayer.md Phase C).
   *
   * The rule itself now lives in `Authority.execute` — this is the client's door to it, and
   * the only reason it is still here is that 37 call sites in this file and in the renderer
   * emit commands through the controller they already hold. When the wire exists, a peer's
   * command reaches the same `Authority.execute` without passing through this object at all,
   * which is the point of having moved it.
   */
  execute(player: number, cmd: Command): boolean {
    const applied = this.authority.execute(player, cmd);
    // On a CLIENT, forward the local player's accepted commands to the host's authoritative
    // sim (item 9b). We still applied it locally just above — sequencing B keeps the client
    // simulating as a prediction — but the host is where it counts, and its snapshot carries
    // the result back. The host itself sends nothing: it IS the authority, and its own
    // `execute` above already reached the real sim. Gated on the local player because triggers
    // and the renderer emit commands too, and only a human's own input crosses the wire.
    if (applied && this.matchLink && !this.matchLinkIsHost && player === this.localPlayer) {
      this.matchLink.sendCommand(cmd);
    }
    return applied;
  }

  /** @see Authority.stashFor — a frozen copy; the renderer may read, never spend. */
  stashFor(owner: number): Readonly<{ gold: number; lumber: number }> {
    return this.authority.stashFor(owner);
  }

  /** @see Authority.countOwned */
  countOwned(owner: number, typeId: string): number {
    return this.authority.countOwned(owner, typeId);
  }

  /** @see Authority.foodFor */
  foodFor(owner: number): { used: number; made: number } {
    return this.authority.foodFor(owner);
  }

  /** @see Authority.hasFreeHero */
  hasFreeHero(player: number): boolean {
    return this.authority.hasFreeHero(player);
  }


  /** Debug cheats (the bottom-right buttons): top up the local player's economy. */
  cheat(kind: "gold" | "lumber" | "food" | "fastbuild"): boolean {
    if (kind === "fastbuild") {
      this.sim.fastBuild = !this.sim.fastBuild; // builds/trains complete in ~1s
      return this.sim.fastBuild;
    }
    if (kind === "food") {
      this.authority.addFoodBonus(this.localPlayer, 100);
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
  dots(vp: Viewpoint = this.local): Array<{ x: number; y: number; owner: number }> {
    // On a CLIENT, draw the authority's answer, not our own prediction (item 10c). A received
    // snapshot is already AoI-filtered for this seat, so `dotsFromSnapshot` re-applies no fog —
    // it draws what it was sent. Through the SAME `SnapshotIndex` the frame reads (item
    // 10c-2c-3): two independent readers of "have I been sent a world?" is how the minimap and
    // the models end up disagreeing about which tick they are drawing.
    if (this.snapshot.active) return dotsFromSnapshot(this.snapshot.units);
    return minimapDots(this.sim, vp);
  }

  /** The creep-camp clustering + markers, cached. @see minimapView.CreepCamps — it reads
   *  `sim.units`, so it answers for a viewpoint whose client rendered nothing. */
  private readonly creepCampView: CreepCamps;

  /** Creep-camp difficulty markers for the minimap: camp centre + fixed combined
   *  level. Fog does NOT gate them — a fresh melee game in the real 1.27a client
   *  paints every camp's dot before a single tile has been explored (that is how
   *  you scout expansions from the lobby). The marker is a stand-in for creeps you
   *  cannot see, so it yields the moment any of them is: exactly then `dots()`
   *  starts drawing that creep, and the two must never show at once. Gone for good
   *  once every creep in the camp is dead. */
  creepCamps(vp: Viewpoint = this.local): Array<{ x: number; y: number; level: number }> {
    if (!this.seeded) return []; // seeding is the client's; nothing to cluster yet
    return this.creepCampView.markers(vp);
  }

  /** Persistent minimap glyphs (gold mines, icon-bearing neutral buildings). Deliberately NOT
   *  fog-gated — verified against the real 1.27a client. @see minimapView.minimapIcons. */
  minimapIcons(): Array<{ x: number; y: number; icon: string }> {
    return minimapIcons(this.sim, this.registry);
  }

  /** True if this unit belongs to the local player (the only units they may
   *  command). Enemy/neutral/creep units can be single-selected to inspect, but
   *  never take orders — WC3 only lets you control your own. */
  private controls(id: number): boolean {
    return this.authority.ownedBy(this.localPlayer, id);
  }

  /** True if the selection holds at least one unit the local player controls. */
  private hasControllable(): boolean {
    for (const id of this.selected) if (this.controls(id)) return true;
    return false;
  }

  /** Players who have already had their free first hero. Authority-side state: the melee
   *  freebie is worth a hero's full price, so who has spent it is not the client's to say. */
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
          this.execute(this.localPlayer, { c: "rally", unitId: id, x: r.x, y: r.y, kind: r.kind, targetId: r.targetId });
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
      const gitem = g ? this.itemAt(g[0], g[1], ITEM_PICK_RADIUS) : null;
      if (gitem) {
        let any = false;
        for (const id of this.selected) {
          const u = this.sim.units.get(id);
          if (this.controls(id) && u?.inventory.length) {
            if (this.execute(this.localPlayer, { c: "getitem", unitId: id, itemId: gitem.id })) any = true;
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
          for (const id of this.selected) if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: picked }, queued: queued })) any = true;
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
          const offs = followOffsets(this.sim, followers, target);
          let any = false;
          for (const id of followers) {
            const o = offs.get(id);
            if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "follow", targetId: picked, offX: o?.[0], offY: o?.[1] }, queued: queued })) any = true;
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
      const spread = ringTargets(this.sim, workers, mine.x, mine.y, mine.radius, MINE_APPROACH_SPREAD);
      let any = false;
      for (const id of workers) {
        const p = spread.get(id);
        if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "harvest", res: "gold", nodeId: mine.id, ax: p?.[0], ay: p?.[1] }, queued: queued })) any = true;
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
          if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "harvest", res: "lumber", nodeId: best.id }, queued: queued })) {
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
      for (const id of this.selected) this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: picked }, queued: queued });
      this.flashRing(target.x, target.y, selR, FLASH_RED);
      return;
    }
    const own = this.primary !== null ? target.owner === this.sim.units.get(this.primary)?.owner : false;
    // Own Orc Burrow (built, with room): peons in the selection climb inside to man it.
    // Only send as many as can fit; the rest keep their orders.
    if (own && target.garrisonCap > 0 && (!target.building || target.building.constructionLeft <= 0)) {
      const room = target.garrisonCap - target.garrison.length;
      const workers = room > 0 ? [...this.selected].filter((id) => !!this.sim.units.get(id)?.worker).slice(0, room) : [];
      let any = false;
      for (const id of workers) if (this.execute(this.localPlayer, { c: "garrison", unitId: id, buildingId: picked })) any = true;
      if (any) {
        this.flashRing(target.x, target.y, selR, FLASH_GREEN);
        return;
      }
    }
    let handled = false;
    if (own && target.building && target.building.constructionLeft > 0) {
      // Own building still going up: workers resume/assist it. Fan the group
      // around the footprint (distinct approach points) so they don't all walk
      // onto the one centre point and shove — WC3 builders spread over a structure.
      const workers = [...this.selected].filter((id) => !!this.sim.units.get(id)?.worker);
      // Speed-build: fan the builders WIDE around the structure (extra spacing) so
      // they ring the whole footprint instead of bunching on the near edge and
      // shoving. A gold-mine approach stays tight; this doesn't need to.
      const spread = ringTargets(this.sim, workers, target.x, target.y, target.radius, SPEED_BUILD_SPREAD);
      for (const id of workers) {
        const p = spread.get(id);
        this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "buildresume", buildingId: picked, ax: p?.[0], ay: p?.[1] }, queued: queued });
      }
      handled = workers.length > 0;
    } else if (own && target.hp < target.maxHp) {
      handled = this.repairAt(picked, queued); // own damaged building: workers repair
    }
    if (!handled) this.groupMove(target.x, target.y, queued); // move toward it (no arrow)
    this.flashRing(target.x, target.y, selR, own ? FLASH_GREEN : FLASH_YELLOW);
  }

  /** Issue a formation move for the whole selection to a ground point (or queue
   *  each unit's slot move when Shift is held). */
  private groupMove(tx: number, ty: number, queued = false): void {
    const targets = groupTargets(this.sim, [...this.selected], tx, ty);
    for (const [id, [x, y]] of targets) this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "move", x, y }, queued: queued });
  }

  /** Attack-move the whole selection to a ground point. Same destination logic as
   *  groupMove — each unit gets a DISTINCT formation slot around the point so they
   *  spread out there instead of cramming on one tile — but issued as attack-move, so
   *  each unit fights the nearest enemy in its path and resumes to its slot afterwards. */
  private groupAttackMove(tx: number, ty: number, queued = false): void {
    const targets = groupTargets(this.sim, [...this.selected], tx, ty);
    for (const [id, [x, y]] of targets) this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attackmove", x, y }, queued: queued });
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
      // The cursor must hit the unit WHERE IT IS DRAWN. This projects the unit's mid-body to
      // screen and measures the click against it, so reading the sim while the model came from
      // the snapshot would put the clickable disc somewhere the player cannot see it — the
      // cursor lying is worse than the model being a frame stale (item 10c-2c-4).
      const u = this.frameUnit(e.simId);
      if (u === undefined) continue; // gone from the sim, or never sent to this client
      // `hidden` is "no model on screen"; the memory test is "no eyes on it" — and an explored
      // enemy BUILDING is drawn but unseen, so the second one is what keeps the cursor from
      // grabbing a shop across the map (issue #62). Every click, hover, order and spell target
      // comes through here, so gating the pick gates all of them at once.
      if (e.hidden || this.drawnFromMemory(e.simId)) continue;
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
  /**
   * Which units get a floating status bar this frame, and what it reads. The DOM and
   * the projection belong to `WorldOverlays`; what is on the map, and whether this
   * viewer may see it, is this object's question — so the filtering stays here and
   * the answer crosses as plain data.
   */
  private updateHealthBars(): void {
    this.pruneSelection();
    const specs: BarSpec[] = [];
    for (const e of this.entries) {
      // Same source as the model this bar floats over — that is the whole of item 10c-2c-2's
      // atomicity requirement. A bar drawn at the sim's position over a model drawn at the
      // snapshot's would track a unit it is not attached to.
      const u = this.frameUnit(e.simId);
      if (!u || e.hidden) continue; // no model on screen (worker in a mine, unexplored fog)
      if (u.neutralPassive && !u.building) continue; // critters and other neutral-passive props: no bar
      // A bar is a LIVE reading, so it needs live eyes: a structure the fog has swallowed keeps
      // its image (fogHides leaves the last thing you saw standing there) but loses its bar,
      // exactly as WC3 does — otherwise you could watch an enemy tower's health from across the
      // map without ever scouting it. Same test the cursor uses (issue #62). On a client the
      // payload already said so — `remembered` — and its hp is redacted to 0 anyway, so drawing
      // one would show a full-empty bar over every scouted building.
      if (this.drawnFromMemory(e.simId)) continue;
      specs.push({
        x: u.x,
        y: u.y,
        // Bar floats at the unit's drawn base — for air units, their altitude.
        z: this.heightAt(u.x, u.y) + e.moveHeight,
        selRadius: e.selRadius,
        hpFrac: u.maxHp > 0 ? Math.max(0, Math.min(1, u.hp / u.maxHp)) : 0,
        manaFrac: u.maxMana > 0 ? Math.max(0, Math.min(1, u.mana / u.maxMana)) : null,
        // Read the LIVE level from the sim unit (u.level) — e.level is the spawn-time
        // level and doesn't track level-ups.
        level: e.isHero && u.level > 0 ? u.level : null,
        isHero: e.isHero,
      });
    }
    this.overlays.syncBars(specs);
  }

  /** What the hover slab should say for whatever the cursor is over — the ordered,
   *  coloured lines plus the world point to float them above — or null when nothing
   *  hovered warrants a tooltip. The WC3 rules (verified against the real client's
   *  mouseover shots):
   *    • another player's unit → the owner's name (red enemy / gold ally); a hero
   *      adds its given name + "Level N".
   *    • your own unit → nothing, UNLESS it's a hero (its name + "Level N").
   *    • a neutral-hostile creep → its name + "Level N".
   *    • a neutral-passive prop (shop, critter, neutral building) → its name only.
   *    • a gold mine → "Gold Mine" + "Gold: N"; a ground item → its name. */
  private computeHoverTip(): { x: number; y: number; z: number; radius: number; lines: HoverLine[] } | null {
    if (this.hovered !== null) {
      // The slab floats over the unit, so it reads the same record the model does.
      const u = this.frameUnit(this.hovered);
      const e = this.byId.get(this.hovered);
      if (!u || !e || e.hidden || this.drawnFromMemory(this.hovered)) return null;
      const lines: HoverLine[] = [];
      if (u.owner < 0) {
        // Neutral. A passive prop is name only; a hostile creep also shows its level.
        lines.push({ text: e.name, color: HOVER_TEXT });
        if (!u.neutralPassive) {
          const lvl = u.isHero ? u.level : (this.registry.get(e.typeId)?.level ?? 0);
          if (lvl > 0) lines.push({ text: `Level ${lvl}`, color: HOVER_TEXT });
        }
      } else if (u.owner === this.localPlayer) {
        // Your own units wear no owner line; only a hero is worth a slab (name + level).
        if (!u.isHero) return null;
        lines.push({ text: u.properName || e.name, color: HOVER_TEXT });
        lines.push({ text: `Level ${u.level}`, color: HOVER_TEXT });
      } else {
        // Another player's unit: the owner's name, coloured by diplomacy to us.
        const ally = this.alliances.coAllied(u.owner, this.localPlayer);
        lines.push({ text: this.playerLabel(u.owner), color: ally ? HOVER_OWNER_ALLY : HOVER_OWNER_ENEMY });
        if (u.isHero) {
          lines.push({ text: u.properName || e.name, color: HOVER_TEXT });
          lines.push({ text: `Level ${u.level}`, color: HOVER_TEXT });
        }
      }
      return { x: u.x, y: u.y, z: this.heightAt(u.x, u.y) + e.moveHeight, radius: e.selRadius, lines };
    }
    if (this.hoveredMine !== null) {
      const m = this.sim.mines.get(this.hoveredMine);
      if (!m || this.fogBlocksMine(m)) return null;
      const name = this.registry.get("ngol")?.name || "Gold Mine";
      return {
        x: m.x, y: m.y, z: this.heightAt(m.x, m.y), radius: 64,
        lines: [{ text: name, color: HOVER_TEXT }, { text: `Gold: ${m.gold}`, color: HOVER_TEXT }],
      };
    }
    if (this.hoveredItem !== null) {
      const it = this.sim.items.get(this.hoveredItem);
      if (!it || this.fogBlocksItem(it)) return null;
      const name = this.items.get(it.itemId)?.name || it.itemId;
      return { x: it.x, y: it.y, z: this.heightAt(it.x, it.y), radius: 32, lines: [{ text: name, color: HOVER_TEXT }] };
    }
    return null;
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
