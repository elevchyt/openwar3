import { WidgetState } from "mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/widget";
import { SimWorld, weaponsFromDef, isOffField, ANIM_FOR_DURATION, HERO_FADE_TIME, HERO_DISSIPATE_TIME, type WorkerState, type SimUnit, type SimMine, type SimItem, type BuildingState, type QueuedOrder, type RallyKind, type SimAbility, type HeroInit, type SimLightning, type CombatText, type FallenHero, type EffectAnim } from "../sim/world";
import { KNOWN_ABILITIES, NO_AOE_CURSOR } from "../data/abilities";
import type { Command } from "./commands";
import { PATHING_CELL, footprintCells, type PathingGrid } from "../sim/pathing";
import type { PlacedFootprint, Footprint } from "../sim/destructibles";
import { PlacedIndex, type PlacedRef } from "./placement";
import { Authority } from "./authority";
import { simHooks, authorityHooks, visionHooks, rosterHooks, mineForScript } from "./jassHooks";
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
import type { ChatLine } from "./chat";
import { applyWorldSnapshot } from "./snapshotApply";
import { perfLog } from "../dev/perfLog";
import type { WorldSnapshot, UnitSnapshot, GroundItemSnapshot, ProjectileSnapshot, FxSnapshot } from "./snapshot";
import { CommandRouter, accepted } from "../net/commandLink";
import { CreepCamps, hiddenFor, minimapDots, minimapIcons, dotsFromSnapshot } from "./minimapView";
import type { RenderBuildJob, RenderUnit } from "./renderUnit";
import { SnapshotIndex } from "./renderView";
import type { FogArea, FogModifier } from "./fog";
import { AllianceTable, AllianceType } from "../sim/alliances";
import type { HeightSampler, FootprintMaxSampler } from "./heightmap";
import type { UnitRegistry, UnitDef } from "../data/units";
import { ArmorType, AttackType, MoveType, PlayerSlot, PrimaryAttribute } from "../data/enums";
import { MELEE, MISC_GAME, xpToReachLevel } from "../data/gameplayConstants";
import { type AbilityRegistry, type AbilityDef } from "../data/abilities";
import { resolveTipRefs } from "../data/tipRefs";
import { disabledIconPath } from "../data/commandStrings";
import { type ItemRegistry } from "../data/items";
import { workerProfileFor, depotRoleFor, type PlayableRace } from "../data/races";
import { MeleeAi, AI_SCRIPT_RACES } from "../ai";
import { ComputerPlusAi, type PlusHost } from "../ai/plus";
import { type TechRegistry } from "../data/techtree";
import { type UpgradeRegistry } from "../data/upgrades";
import type { SoundBoard, SoundCategory } from "../audio/sounds";
import { WorldOverlays, type HoverLine, type BarSpec } from "../render/worldOverlays";
import { INSANE_HARVEST_FACTOR, MELEE_INSANE } from "../ai/ids";

// Ties the headless SimWorld to the rendered map (plan §5 vertical slice):
// seeds movable units from the loaded map, syncs sim state → model instances
// each frame, and handles click-to-select / right-click-to-move picking.
// Keeps the sim authoritative; the instances just display it.


// Minimal shapes for the mdx-m3-viewer bits we drive.
export interface Instance {
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
  attackUpgrade: number; // level of the owner's melee/ranged research, printed IN the icon; -1 = none reaches this type
  armorUpgrade: number; // level of the owner's armour research, printed IN the icon; -1 = none reaches this type
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
  /** The worker HIDDEN inside this structure while it goes up — an Orc peon, and only an Orc
   *  peon (`buildsFromInside`): every other race's builder is still standing on the terrain
   *  where you can click it. 0 when there is none. The construction panel puts its icon under
   *  the building's so the peon can be had back without cancelling the build. */
  builderId: number;
  builderIcon: string; // that worker's command-card icon (BLP path), "" when builderId is 0
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
  /** Active auras/buffs/debuffs, as the info panel's Status row shows them: the BUFF's
   *  own icon, name and tooltip body (`Buffart`/`Bufftip`/`Buffubertip`). */
  buffs: Array<{ icon: string; name: string; tip: string }>;
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
  /**
   * Which of the THREE colours `UI\MiscData.txt`'s `[SelectionCircle]` block defines this ring
   * wears — `ColorFriend=255,0,255,0`, `ColorNeutral=255,255,255,0`, `ColorEnemy=255,255,0,0`,
   * i.e. green / yellow / red, and there is no fourth. Green is what YOU own; an ally is not
   * you, and rings the neutral yellow along with the shops, the critters, the gold mines and
   * every player the map plays as neutral. Resolved here, where the alliance table is.
   */
  allegiance: "own" | "neutral" | "enemy";
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
  /**
   * **This body is BORROWED — the RTS may read it, but never decide what is drawn there.**
   *
   * A destructible has no model of its own: `attachDestructibleBody` hands us the viewer's
   * OWN placed doodad, the one war3map.doo laid down (see its note on instance reuse). And
   * the renderer swaps that doodad out from under us whenever it has to MOVE — a gate under
   * an axe, or swinging open — because a placed doodad's animation never advances, so
   * mapViewer hides the static and puts an animated stand-in in its place (`doodadActor`).
   *
   * So the instance we hold may already be retired, and we have no way to know. Every draw
   * decision here — fog show/hide, the death clip, corpse adoption — has to be skipped and
   * left to mapViewer's own doodad fog pass, which owns the whole `map.doodads` array and is
   * the only side that knows about the stand-in. `hidden` is still tracked (the health bar,
   * the hover slab and the selection all read it); only the instance is left alone.
   *
   * A destroyed elven gate on Rise of the Naga is what it looks like when we forget: the RTS
   * adopted the gate's static doodad as a CORPSE, `fogCorpse` re-showed it every frame, and
   * mdx-m3-viewer's `Widget.update` stood it back up on its looping `stand` clip — the intact
   * door, drawn over the rubble the stand-in was correctly holding.
   */
  borrowedBody?: true;
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
  /** The held clip outlives the CAST: it neither ends with the order nor breaks on movement
   *  (Bladestorm — see ANIM_FOR_DURATION). Cleared when castAnimT runs out. */
  castAnimSticky: boolean;
  /** Hold the clip for as long as the unit STANDS STILL, whatever its order says — and drop
   *  it the moment it walks. This is the softer half of `castAnimSticky`, and the difference
   *  is what `Animnames` draws: `spell,looping` (Healing Spray) is a caster who keeps
   *  performing and stops the moment he walks off, where Bladestorm's spin IS the ability and
   *  holds through anything. It is a rule about the HOLD, not about the loop mode — the same
   *  rule a one-shot gesture that must play out needs (the Acolyte's summon, see
   *  playWorkAnimOnce), which is set to ModelDefined and held by this all the same.
   *  Cleared when castAnimT runs out. */
  castAnimHeld: boolean;
  /** The TARGET tier's Birth clip while this building is upgrading into it (Scout Tower →
   *  Guard Tower). Resolved once per target and cached here because it costs a sequence-name
   *  pass; `seq` -1 means "this pair has no upgrade clip to play". See upgradeBirthFor. */
  upgradeBirth?: { toTypeId: string; seq: number; start: number; end: number };
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
const CAST_ERROR_RANK = [SimWorld.SILENT_REFUSAL, "Notthisunit", "Targetunit", "Canttargetloc", "Cooldown", "Nomana", "Outofbounds"];
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
/** Where a body is in its run off the field. The first three are an ordinary corpse rotting;
 *  the last two are a HERO dissipating instead (issue #126). */
type CorpsePhase = "death" | "flesh" | "bone" | "dissipate" | "fade";
/** The tint a body fades from when its instance carries none of its own. */
const WHITE_TINT = new Float32Array([1, 1, 1, 1]);
const DEATH_CLIP_FALLBACK = 1.6; // seconds to hold a Death clip of unknown length
const DECAY_CLIP_FALLBACK = 3; // seconds to hold a Decay Flesh clip of unknown length
const CAST_ANIM_HOLD = 0.8; // seconds a cast animation is held from the picker
/** Tokens in an `Animnames` list that name no clip: they say how the picked one PLAYS
 *  ("looping") rather than which one it is. Kept out of the name match, so `spell,looping`
 *  (Healing Spray, Stampede, Earthquake, Starfall) resolves to "Spell" and not to nothing. */
const ANIM_MODIFIERS = new Set(["looping"]);
/** Casters whose AbilityFunc row names no `Animnames` at all, but whose MODEL carries a clip
 *  meant for exactly that ability. Only Bladestorm needs it in 1.30: `[AOww]` is bare, the
 *  Blademaster has no "Spell" sequence to fall back to, and "Attack Walk Stand Spin" is the
 *  whirlwind itself — without this the ultimate played with him standing there. */
const CAST_ANIM_FALLBACK: Record<string, RegExp> = {
  AOww: /\bspin\b/i,
};
/** The engine's OWN buff rows, for the states no ability defines a buff for.
 *
 *  A stun is the case that matters: Storm Bolt, Firebolt and the Mountain King's Bash carry
 *  no `BuffID` at all, yet a stunned unit shows the "Stunned" icon in every game — because the
 *  engine hangs `BPSE` on anything it pauses. The row says as much itself: Bufftip "Stunned",
 *  Buffubertip "This unit will not move.", `EditorSuffix= (Pause)`, art BTNStun
 *  (Units\CommonAbilityFunc.txt / CommonAbilityStrings.txt). `Bvul` is the same thing for
 *  invulnerability. Only consulted when the buff named no row of its own. */
const KIND_BUFF_ROW: Record<string, string> = { stun: "BPSE", invuln: "Bvul" };
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
/** How far a rally flag is lifted when it is planted ON a building or a gold mine. Flat on
 *  the terrain the flag stands inside the model and is invisible from most camera angles;
 *  this clears the base without turning the flag into a landmark of its own. */
const RALLY_TARGET_LIFT = 110;
const TREE_COLLIDER_HEIGHT = 110; // pick trees against a raised plane so clicking up the trunk/canopy still selects them
// Max world distance from the click's ground point to a pickable unit. Gates out
// far/behind-camera units that screen-projection alone would wrongly match.
const PICK_WORLD_MAX = 700;
// NOTE: there is deliberately NO selection cap here any more. WC3 stops a selection at 12 units
// (we long stopped at 24), but OpenWar3 lifts it (issue #109): a box-select, a same-type grab or
// a control group holds as many units as you put in it. The HUD absorbs the size instead of the
// sim — `showSelectionGrid` steps the icon grid down a tier every 12 units and folds whatever is
// past the last tier into a "+N" badge on the final icon.
// Neutral Passive (WC3 player 15): shops, taverns, labs, merchants, fountains,
// critters. Owner < 0 (grey minimap, never a player), a distinct team, and the
// sim's `neutralPassive` flag makes them non-hostile with a yellow ring.
const NEUTRAL_PASSIVE_OWNER = -1;
const NEUTRAL_PASSIVE_TEAM = -2;
/** Neutral Hostile (WC3 player 12) — the CREEP player. Owner -1 / team -1 is the same pair
 *  every map-placed creep already gets (see trySeed), so a creep the SCRIPT makes and one the
 *  editor placed are the same thing to the sim: hostile to every player team, hostile to
 *  nobody on its own, grey on the minimap, and never counted as a player's unit. */
const NEUTRAL_HOSTILE_OWNER = -1;
const NEUTRAL_HOSTILE_TEAM = -1;

/** One icon in the multi-selection grid. */
export interface SelIcon {
  simId: number;
  icon: string; // BLP command icon path
  hpFrac: number;
  manaFrac: number; // -1 when the unit has no mana pool (no bar drawn), like the hero bar
  focused: boolean; // part of the currently-focused sub-group
  owner: number;
}

/** One button of the hero bar in the screen's top-left corner (issue #95). */
export interface HeroBarEntry {
  simId: number;
  icon: string; // BLP command icon path
  hpFrac: number;
  manaFrac: number; // -1 when the hero has no mana pool (no bar drawn)
  skillPoints: number; // unspent skill points — >0 lights the button's glow
  /**
   * This hero is DEAD and waiting on an altar.
   *
   * It keeps its slot rather than leaving the bar, because the bar is your roster and the
   * roster is what "your second hero" counts down — the same order the altar seats its revive
   * buttons in. The button draws the icon's own `CommandButtonsDisabled\DIS*` twin while it
   * is set (see `disabledIcon`), which is the original's way of saying "you can't press this":
   * the twin is desaturated AND drawn without the gold frame, and the missing frame is most
   * of what reads as unavailable.
   */
  dead: boolean;
  /** The BLP path of the greyed art for `dead` — the icon's `CommandButtonsDisabled\\DIS*`
   *  twin. A PATH, not a decoded URL: the HUD resolves every other icon it draws through its
   *  own `blpUrl`, and this is one more of them. Null when the icon has no directory to
   *  strip; the HUD then falls back to the live art. */
  disabledIcon: string | null;
  /** Seconds until it stands back up, and how far along that is (0..1) — the countdown the
   *  original prints over a reviving hero's portrait. Both 0 while it merely lies dead with
   *  nobody paying for it. */
  reviveSecondsLeft: number;
  reviveFrac: number;
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

/** One change to a player's SELECTION, for the trigger engine's selection events
 *  (`EVENT_PLAYER_UNIT_SELECTED` / `_DESELECTED`). Raised here rather than by the sim
 *  because a selection is not world state — it belongs to whoever is looking at the
 *  world. See RtsController.drainSelectionEvents. */
export interface SelectionEvent {
  unitId: number;
  /** The player who selected it — `GetTriggerPlayer()`, and NOT the unit's owner: the
   *  hero a picker clicks belongs to a slot nobody is playing. */
  player: number;
  selected: boolean;
}

export class RtsController {
  private sim: SimWorld;
  private entries: Entry[] = [];
  private byId = new Map<number, Entry>();
  /**
   * Defs for the sim units the unit REGISTRY does not hold: the map's destructibles, whose
   * type codes come out of `DestructableData.slk` rather than `UnitData.slk`. Combat reads a
   * def for the same thing here as anywhere — the armour MATERIAL that picks the impact
   * sound — and without this a gate under an axe was struck in total silence.
   *
   * Keyed by SIM ID, not by type id, because a destructible's render body is optional: the
   * doodad pass already drew the gate, so `attachDestructibleBody` only ever lands if a
   * widget is found for it, and the `byId` entry that carries a type id may simply not
   * exist. The sim id is what a hit event actually carries.
   */
  private destructibleDefs = new Map<number, UnitDef>();
  // Multi-unit selection: `selected` holds the whole group, `primary` is the
  // leader that drives the HUD (portrait, info panel, command card).
  private selected = new Set<number>();
  /** What `selected` held the last time the trigger engine was told about it, so the next
   *  drain can say what entered and what left (see drainSelectionEvents). */
  private selectionSeen = new Set<number>();
  /** Units this frame's click RE-ISSUED into the selection although they were already in
   *  it — WC3's double-click/Ctrl-click rebuilds the selection rather than leaving it
   *  alone, so the unit is deselected and selected again. See drainSelectionEvents. */
  private reselected: number[] = [];
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
  //
  // A HERO's body is the same list and a different ending (issue #126): Death → Dissipate,
  // whose last second fades the body away → gone. It never has a `corpseId`, because a hero
  // leaves no remains for anything to raise, eat or carry — see SimWorld.spawnCorpse.
  private corpses: Array<{ instance: Instance; corpseId: number; anims: AnimSet; phaseT: number; phase: CorpsePhase; hero?: boolean; held?: boolean; fadeFrom?: Float32Array }> = [];
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
    // …and whether one will SHOOT the other is the attacker's own PASSIVE grant, which is a
    // different question with a different answer: the matrix is directed, and a campaign that
    // wants one side to hold its fire writes one direction only. See SimWorld.hostile.
    this.sim.passivePlayers = (a, b) => this.alliances.get(a, b, AllianceType.Passive);
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

  /** Player display names for the hover tooltip's owner line (set at match start from the
   *  lobby seating: an AI slot reads the label of its own difficulty, "Computer (Easy)" /
   *  "(Normal)" / "(Insane)"). */
  setPlayerNames(names: Map<number, string>): void {
    this.playerNames = names;
  }

  /** Which slots the lobby seated as COMPUTERS. Their map-placed units hold their ground
   *  (see SimUnit.guarding); a human's do not. */
  private aiPlayers = new Set<number>();

  /**
   * `SetPlayerController(p, MAP_CONTROL_NEUTRAL | _RESCUABLE)` — this slot is PLAYED as a
   * neutral, and **that is an alliance, not a shield**.
   *
   * It was a permanent flag: while a player was neutral-controlled, `hostile()` answered false
   * for every pair it was in and nothing could ever fight it. That stops Illidan attacking the
   * Fishing Village, which is what it was written for — and it also makes a scene the same map
   * stages impossible. The Wildkin cinematic sets the Trackers (a neutral-controlled player)
   * and the Wildkin at each other on purpose:
   *
   *     call SetPlayerAllianceStateBJ( udg_AP2_Trackers, udg_AP6_Wildkin, bj_ALLIANCE_UNALLIED )
   *     call SetPlayerAllianceStateBJ( udg_AP6_Wildkin, udg_AP2_Trackers, bj_ALLIANCE_UNALLIED )
   *
   * — both ways, deliberately, so a Berserk Wildkin can maul an Archer on camera; the scene
   * then writes bj_ALLIANCE_NEUTRAL back to stop it. Against a flag those lines are inert and
   * the fight the shot is OF never happens.
   *
   * So it is granted the way the game grants it: `bj_ALLIANCE_NEUTRAL` is exactly "clear the
   * ally settings, then set ALLIANCE_PASSIVE" (Blizzard.j's SetPlayerAllianceStateBJ), and a
   * neutral controller is that, mutually, with every other slot. Illidan still ignores the
   * village — he is passive toward it from config() onward — and the map's own later alliance
   * calls override it for the pairs they name, because they write the same setting.
   */
  setPlayerNeutral(player: number, neutral: boolean): void {
    if (neutral) this.sim.neutralPlayers.add(player);
    else this.sim.neutralPlayers.delete(player);
    if (!neutral) return;
    // Slots 0–11 and the two engine players a map talks to by name: 12 Neutral Hostile (whose
    // creeps would otherwise maul the village) and 15 Neutral Passive.
    for (const other of [...Array(12).keys(), 12, 15]) {
      if (other === player) continue;
      this.alliances.set(player, other, AllianceType.Passive, true);
      this.alliances.set(other, player, AllianceType.Passive, true);
    }
  }

  setAiPlayers(players: Iterable<number>): void {
    this.aiPlayers = new Set(players);
  }

  /**
   * ARM Blizzard's own melee AI with the lobby's computer seats (issue #119; src/ai/).
   *
   * Arm, not start. `MeleeStartingAI` is what actually seats a computer in the real game — the
   * map's own Melee Initialization trigger calls it, and the engine loads `Scripts\<race>.ai`
   * for each slot that is PLAYING and MAP_CONTROL_COMPUTER — and that call now reaches us, one
   * player at a time, as `StartMeleeAI` (→ `startMeleeAIFor`). So this only records what the
   * LOBBY knows and the script does not: which seat sits where, at what difficulty, off which
   * match seed. A map whose init trigger omits "Run melee AI scripts", and every custom map
   * (which runs none of the melee library), gets no computer opponents at all — which is what
   * the real game does with them, and used to be something we did anyway.
   *
   * AUTHORITY-SIDE ONLY, by construction: `tick` drives it inside the branch a frozen client
   * never enters, and every decision leaves through `execute`, which is the same door and the
   * same judgement a human player's click gets. A computer cannot cheat here because there is
   * no route by which it could.
   */
  prepareMeleeAI(
    slots: ReadonlyArray<{ player: number; race: PlayableRace; startX: number; startY: number; difficulty: number; plus?: boolean }>,
    seed: number,
    starts: ReadonlyArray<{ player: number; x: number; y: number }> = slots.map((s) => ({ player: s.player, x: s.startX, y: s.startY })),
  ): void {
    this.meleeSeats = new Map(slots.map((s) => [s.player, s]));
    // EVERY playing seat's start location, computers and people alike — what a Computer+ scout
    // walks its tour round (src/ai/plus/, `PlusHost.startLocations`). `slots` is only the
    // computers, so this is a second list rather than a projection of that one; it defaults to
    // the computers' own so an older caller still names something real.
    this.meleeStarts = starts;
    this.meleeSeed = seed;
    // Built here rather than as a field: `this.sim` is assigned in the constructor BODY, so a
    // field initializer that reached for it would capture `undefined`.
    const host: PlusHost = {
      world: this.sim,
      registry: this.registry,
      abilities: this.abilities,
      items: this.items,
      tech: this.tech,
      upgrades: this.upgrades,
      execute: (player, cmd) => this.execute(player, cmd),
      footprintOf: (tex) => this.footprintOf(tex),
      coAllied: (a, b) => this.alliances.coAllied(a, b),
      creepCamps: () => this.creepCampView.all(),
      // The computer's OWN eyes, not the local player's — every seat has a viewpoint from
      // tick 0 (VisionSet.seat), so this is the same grid its units acquire through.
      visible: (player, x, y) => this.viewpoints.viewpointFor(player).vision.stateAt(x, y) === FogState.Visible,
      // The two things only Computer+ asks for (src/ai/plus/). Both leave through the SAME
      // doors a person's would: a line of chat is routed and relayed exactly as a typed one,
      // and "I have lost, I am leaving" is the ordinary player-left event the map's own melee
      // script is already listening for.
      say: (player, text, scope) => this.onChatSaid?.({ from: player, text, target: { scope: scope ?? "all" } }),
      leave: (player) => this.onPlayerLeft?.(player),
      startLocations: () => this.meleeStarts,
    };
    this.meleeAi = new MeleeAi(host);
    this.computerPlus = new ComputerPlusAi(host);
  }

  /** The lobby's answer for each computer seat — where it starts, how hard it plays, and which
   *  of the two AIs plays it — held until the map's script asks for it. Empty outside a match. */
  private meleeSeats = new Map<number, { player: number; race: PlayableRace; startX: number; startY: number; difficulty: number; plus?: boolean }>();
  /** Where every PLAYING seat starts — the lobby's own list, held for the Computer+ scout. */
  private meleeStarts: ReadonlyArray<{ player: number; x: number; y: number }> = [];
  private meleeSeed = 1;

  /**
   * `StartMeleeAI(p, "orc.ai")` — put ONE computer behind Blizzard's melee AI.
   *
   * Called from the map's own script (Blizzard.j MeleeStartingAI → PickMeleeAI), which is the
   * only thing in the game that seats a melee computer. The RACE comes from the script's
   * filename, exactly as it does in the original, so a map that asks for "orc.ai" gets an orc
   * player whatever the lobby said; a name we don't recognise falls back to the seat's own race.
   *
   * The seat itself (start location, difficulty, the match seed) is the LOBBY's and was armed
   * by `prepareMeleeAI` before a line of the script ran — the script names who plays, not
   * where they sit.
   */
  startMeleeAIFor(player: number, script: string): void {
    const seat = this.meleeSeats.get(player);
    if (!this.meleeAi || !seat) return;
    const race = AI_SCRIPT_RACES[script.toLowerCase()] ?? seat.race;
    // COMPUTER+ (issue #124) — the lobby's Advanced Options switch, arriving here as the seat's
    // own flag. It is the same seam, the same moment and the same arguments: the map's melee
    // script still decides WHO plays and as what, and only which of the two AI objects the seat
    // lands in changes. The two share no state, so a match may hold both.
    if (seat.plus) {
      this.computerPlus?.add(player, race, seat.difficulty, seat.startX, seat.startY, this.meleeSeed);
      // …and no harvest bonus, at any difficulty. Computer+ does not cheat — see
      // docs/computer-plus.md and `AiPlayer.bypassFog`, which it also switches off.
      return;
    }
    this.meleeAi.add(player, race, seat.difficulty, seat.startX, seat.startY, this.meleeSeed);
    // The one thing an INSANE computer gets that is the engine's rather than the script's:
    // it is credited TWICE what its workers actually carried home. common.ai never mentions
    // MELEE_INSANE — the difficulty is not in the strategy, it is in the till.
    //
    // "On insane difficulty in Warcraft III skirmishes, the AI receives twice the amount of
    // gold and lumber as the player than what it actually harvested, whereas on easy and
    // normal difficulty it only receives the normal amount" (TV Tropes, Not Playing Fair
    // With Resources; the same doubling is described on the Hive thread "How to double
    // resources workers harvest?" as the Insane AI banking +20 for a +10 load).
    //
    // Applied to the CREDIT and not to the load, which is why the multiplier lives on the
    // stash rather than on the Harvest ability's gold capacity: the mine still gives up ten
    // gold a trip and runs dry on the same schedule as everybody's. An insane computer is
    // paid double for the same digging, not digging twice as fast.
    if (seat.difficulty === MELEE_INSANE) this.sim.setHarvestBonus(player, INSANE_HARVEST_FACTOR);
  }

  private meleeAi: MeleeAi | null = null;
  /** The Computer+ seats (issue #124, src/ai/plus/). A separate object from `meleeAi` on
   *  purpose: the two AIs share no mutable state, and a seat is in exactly one of them. */
  private computerPlus: ComputerPlusAi | null = null;

  /**
   * A player has LEFT the game — raised for a Computer+ seat that has conceded.
   *
   * Wired by the presentation side to `EVENT_PLAYER_LEAVE` on the map's own script, because
   * that is where the meaning of leaving lives: Blizzard.j's `MeleeTriggerActionPlayerLeft`
   * hands the units to Neutral Passive and calls `MeleeDoLeave`, and the victory check that
   * follows is the map's. Nothing here decides any of it.
   */
  onPlayerLeft: ((player: number) => void) | null = null;

  /** The owner-line label for a player slot — the lobby name, or a generic
   *  "Player N" fallback so an un-seeded slot still reads sensibly. */
  private playerLabel(owner: number): string {
    return this.playerNames.get(owner) ?? `Player ${owner + 1}`;
  }

  /** `SetPlayerColor` — slot → the colour index its units, dots and name wear.
   *  Empty means "the slot's own index", which is WC3's default and what every melee map
   *  keeps; only an override lives here. */
  private playerColors = new Map<number, number>();

  /**
   * A player slot's COLOUR, which is not the same thing as the slot.
   *
   * The renderer used to hand `owner` straight to `setTeamColor` ("player slot doubles as
   * team color for now"), which holds for melee — every slot keeps its default colour — and
   * fails on any map that says otherwise. Rise of the Naga is the plain case: its config()
   * assigns the twelve defaults, then a trigger runs
   *
   *     call SetPlayerColorBJ( udg_AP1_Player, PLAYER_COLOR_BLUE, true )
   *
   * so Maiev's slot 0 is BLUE, not red. `changeExisting` recoloured the units standing there
   * at the time (that is a `ForGroup` of `SetUnitColor`, which we did honour), and everything
   * spawned afterwards came out red — half the player's army one colour, half the other.
   */
  playerColor(owner: number): number {
    return this.playerColors.get(owner) ?? owner;
  }

  /** `SetPlayerColor` — the player's colour from here on. Deliberately does NOT recolour the
   *  units already on the field: WC3 leaves that to `SetPlayerColorBJ`'s `changeExisting`
   *  loop over `SetUnitColor`, which is why that parameter exists at all. */
  setPlayerColor(owner: number, color: number): void {
    this.playerColors.set(owner, color);
  }

  /** Is the player's interface on screen — `ShowInterface` AND `EnableUserUI` (see
   *  MapViewerScene.syncHudVisible, which owns the pair and pushes their AND here). Read by
   *  the world-layer overlays, which belong to the interface even though they are drawn over
   *  the terrain: a cinematic shows no health bars. */
  private interfaceShown = true;

  setInterfaceShown(on: boolean): void {
    this.interfaceShown = on;
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
   *  `SetPlayerAlliance` calls land on top of it rather than under it. `grantsOf` carries a
   *  custom map's own force flags (see SimWorld's `seedFromTeams`). */
  seedAlliances(teamOf: (player: number) => number, grantsOf?: (team: number) => { allied: boolean; sharedVision: boolean } | undefined): void {
    this.alliances.seedFromTeams(teamOf, grantsOf);
  }

  /** Watch the alliance matrix for grants that actually change hands — what the "You have
   *  been granted control of %s's units." line is raised off (see AllianceTable.onChange). */
  set onAllianceChange(fn: (source: number, other: number, type: number, value: boolean) => void) {
    this.alliances.onChange = fn;
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

  /** Same answer for any unit, for the lightning pass (issue #97): a bolt is drawn while
   *  either of the units it links is on screen, and withheld when both are in the dark —
   *  otherwise a Chain Lightning cast out of sight lights up the fog it was cast into. */
  unitImageShown(id: number): boolean {
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
      // An Orc peon vanishing into its build KEEPS the selection (unlike a mine or a burrow,
      // which take the worker out of your hands): the peon is still yours to order, and the
      // orders you queue on it while it works are what it does the moment it steps back out.
      // Its ring goes with its position (selectionRings skips anything off the field), so all
      // that stays on screen is the panel.
      if (u.insideBuild && this.hovered === e.simId) this.hovered = null;
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
      // The flag is tracked for EVERY entry — the health bar, the hover slab and the
      // selection all read it — but a borrowed body's instance is not ours to toggle, and
      // this is the edge that used to put a destroyed gate's door back: mapViewer had hidden
      // the static doodad in favour of the stand-in, and the first re-reveal showed it again.
      e.hidden = hide;
      if (hide) {
        if (!e.borrowedBody) e.unit.instance.hide();
        if (this.hovered === e.simId) this.hovered = null;
      } else if (!e.borrowedBody) {
        e.unit.instance.show();
      }
    }
    if (!hide && !e.borrowedBody) this.applyFogTint(e, u); // borrowed: mapViewer's doodad pass tints it
  }

  /** Re-skin a unit that has changed FORM: rebuild its animation set for the new state and
   *  play the transition clip on the way.
   *
   *  The model never changes — one MDX carries both forms — so this is not a remodel, just a
   *  different reading of the same sequence list (see animPropsFor). The set is built for the
   *  state being moved TO, because that is the state the unit will be standing/working in
   *  when the transition ends.
   *
   *  The TRANSITION clip is the other way round: it comes from the state being moved FROM.
   *  A form's Morph clip is the one it plays to LEAVE that form, which is what its name says
   *  — "Morph Alternate" belongs to the alternate half, so it is the ROOTED Ancient pulling
   *  its roots up, and the plain "Morph" is the walking one settling back down. Read off the
   *  destination instead (which is what this did), each direction plays the other's clip and
   *  an Ancient visibly uproots itself while it plants.
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
    // The clip belongs to the form being LEFT, so it is read out of that form's set. One
    // extra buildAnimSet, only on a form change (twice in an Ancient's life, usually).
    const morph = buildAnimSet(seqs, animPropsFor(def, !alt)).morph;
    // Hold the morph clip for its own length: castAnimT keeps the ordinary stand/walk picker
    // off this unit until the Ancient has finished hauling itself up or settling down.
    //
    // STICKY, unlike a cast gesture. The ordinary hold is released the moment the unit stops
    // casting, which is right for a throw or a slam — WC3 animation-cancelling is instant —
    // but a shape change is not a gesture in front of an ability, it is the unit becoming the
    // other thing, and nothing cancels it. Chemical Rage only looked right without this by
    // accident: the Alchemist is still in his cast backswing on the way IN, so `order` was
    // "cast" and the hold survived, while the way OUT is a timer expiring with no order at
    // all — the picker took the ogre straight to an idle stand and the return morph never
    // played a frame.
    if (morph < 0) return; // model authors no transition — snap to the new set
    const inst = e.unit.instance;
    inst.setSequence(morph);
    inst.setSequenceLoopMode(SequenceLoopMode.ModelDefined);
    e.curSeq = morph;
    e.unit.state = WidgetState.WALK; // hold it against the idle picker, as a cast clip does
    e.castAnimT = seqDuration(inst, morph, CAST_ANIM_HOLD);
    e.castAnimSticky = true;
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

  /** The def behind a sim unit: the registry's, or — for the map's destructibles, which have
   *  no registry row — the one they were seeded with (see destructibleDefs). */
  private defOf(simId: number): UnitDef | undefined {
    return this.registry.get(this.byId.get(simId)?.typeId ?? "") ?? this.destructibleDefs.get(simId);
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
      const def = this.defOf(attackerId);
      const au = this.sim.units.get(attackerId);
      if (def?.model && au) this.sounds.playModelAttack(def.model, { x: au.x, y: au.y, z: this.heightAt(au.x, au.y) });
    }
    for (const h of this.sim.drainHits()) {
      const tgt = this.defOf(h.targetId);
      const tu = this.sim.units.get(h.targetId); // impact rings out at the struck unit
      const at = tu ? { x: tu.x, y: tu.y, z: this.heightAt(tu.x, tu.y) } : undefined;
      // The clang is the WEAPON THAT LANDED THE BLOW against the target's MATERIAL — taken
      // from the hit, not from the attacker's def, so nothing here has to know which of a
      // unit's two slots was swinging (an orb-woken air attack, a Flying Machine's bombs).
      // Nor is the attacker consulted at all when the blow names a weapon: it may have died
      // while its arrow was still in the air, and a dead shooter has no def to ask. Both
      // halves are normalised to "" when the row names none (units.ts soundBase), so absence
      // is falsy rather than the SLK's literal "_".
      if (h.weaponSound && tgt?.armorSound) {
        this.sounds.playImpact(h.weaponSound, tgt.armorSound, at); // melee: material clang
        continue;
      }
      // No weapon sound: a missile's own impact noise instead, which only the def records.
      const atk = this.defOf(h.attackerId);
      if (atk?.missileArt) this.sounds.playMissile(atk.missileArt, "impact", at); // ranged
    }
    for (const workerId of this.sim.drainChops()) {
      const def = this.defOf(workerId);
      const w = this.sim.units.get(workerId);
      // YOU DO NOT HEAR AN AXE YOU CANNOT SEE. Live sight of the worker, not a memory of the
      // ground it stands on: without this the whole map's lumber was audible from the first
      // minute — an opponent's Peons hacking away in unscouted fog, one clang per chop, which
      // is both a count of his lumber workers and a bearing on his base. The renderer's half
      // of the same rule is the wobble the tree gives (mapViewer.updateTreeActors).
      if (!w || this.local.fogBlocksAt(w)) continue;
      const at = { x: w.x, y: w.y, z: this.heightAt(w.x, w.y) };
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
    if (!def?.soundSet) return;
    // source = focused unit
    if (this.sounds.play(def.soundSet, attack ? "YesAttack" : "Yes", undefined, this.primary)) {
      // Being sent somewhere is the unit TALKING, and the annoyed escalation only builds on
      // uninterrupted re-clicking: a "Yes"/"YesAttack" in the middle of it restarts the count,
      // so the next click is a plain "What" again rather than resuming at "Pissed". Counted by
      // the line actually HEARD, exactly as announceSelection advances the streak.
      this.voiceStreak = 0;
    }
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
    // …and the same reader, in the shape the SIM asks its one question in: how far from a
    // site's centre its edge is, so a builder can be walked up to the EDGE rather than into
    // the middle of what it is about to raise (SimWorld.buildApproach). The wider axis, so
    // the stand-off clears an oblong footprint whichever way the worker comes at it.
    this.sim.buildHalfExtent = (defId) => {
      const tex = this.registry.get(defId)?.pathTex;
      const fp = tex ? read(tex) : null;
      return fp ? (Math.max(fp.w, fp.h) * PATHING_CELL) / 2 : 0;
    };
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
      // …in the medium the unit actually moves through. A transport ship is created ON the
      // sea (Rise of the Naga's harbour fills its docks with `CreateUnit(p, 'etrs', …)` at
      // water coordinates), and asked the GROUND question every one of those was "displaced"
      // onto the nearest beach — a fleet of boats standing on the sand.
      const domain = def.moveType === MoveType.Float ? "water" : "ground";
      const n = footprintCells(def.collision || 16);
      const [cx, cy] = grid.worldToCell(x, y);
      if (!grid.footprintFits(cx, cy, n, domain)) {
        const fit = grid.nearestFit(cx, cy, n, undefined, undefined, domain) ?? grid.nearestWalkable(cx, cy, undefined, domain);
        if (fit) [x, y] = grid.cellToWorld(fit[0], fit[1]);
      }
    }
    const facing = (facingDeg * Math.PI) / 180;
    // `Player(PLAYER_NEUTRAL_AGGRESSIVE)` is not a thirteenth PLAYER — it is the creep slot,
    // and a unit created on it must come out as a creep, not as a coloured player's unit on a
    // team of its own. This is how nearly every custom map makes its monsters: WTii's Unit
    // Tester answers a purchase at a "Creep - …" shop with a dozen
    // `CreateNUnitsAtLoc(…, Player(PLAYER_NEUTRAL_AGGRESSIVE), …)` calls, and the camp came up
    // owned by a live player — coloured, allied to nobody, and attacking no one. Mapped to the
    // same owner/team pair `trySeed` gives a map-PLACED creep, so both are one thing to the
    // sim; the guard AI that pair implies is applied in addSimUnit. Neutral Passive (15) is
    // the other half — shops, critters, fountains a script creates — and takes the passive
    // pair, which is what makes them non-hostile with a yellow ring.
    const creep = player === PlayerSlot.NeutralHostile;
    const passive = player >= PlayerSlot.NeutralVictim; // 13/14/15 — never a fighting slot
    const owner = creep ? NEUTRAL_HOSTILE_OWNER : passive ? NEUTRAL_PASSIVE_OWNER : player;
    const team = creep ? NEUTRAL_HOSTILE_TEAM : passive ? NEUTRAL_PASSIVE_TEAM : teamOf(player);
    const simId = this.reserveUnitId();
    this.addSimUnit(def, x, y, facing, owner, team, 0, simId); // exists NOW
    const su = this.sim.units.get(simId);
    if (su && creep) {
      // The same guard behaviour a map-placed creep gets: it holds the ground it was made on,
      // leashes back to it after a chase, and dozes at night if its type sleeps.
      su.isCreep = true;
      // The post is where it ACTUALLY STANDS, not where it was asked to stand: `SimWorld.add`
      // settles a new unit onto a clear spot, and every guard test measures from this point —
      // `atHome` (which is what lets it doze at night, CREEP_HOME_EPS 64), the leash, and camp
      // membership. Taking the requested position instead leaves a creep permanently "away
      // from its post" by however far it was nudged, which reads as a camp that never sleeps
      // and keeps trying to walk home.
      su.guardX = su.x;
      su.guardY = su.y;
      su.guardFacing = facing;
      su.aggroRange = su.weapon?.acquire ?? def.acquireRange ?? 0;
      su.canSleep = def.canSleep;
    } else if (su && passive) {
      su.neutralPassive = true;
    }
    this.scriptSpawns.push({ typeId, x, y, facing, player: owner, team, simId }); // …gets a body later
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

  /**
   * What has entered and left the local player's selection since the last drain —
   * `EVENT_PLAYER_UNIT_SELECTED` / `_DESELECTED` (common.j 24/25), which nothing raised
   * before and which a large family of custom maps is built on: a hero picker, a shop that
   * describes what you clicked, a "click the sign to vote" mode chooser. Extreme Candy War
   * 2004 is the plain case — `TriggerRegisterPlayerSelectionEventBJ` for every player, and
   * a `Pick Heroes` trigger that hands you the hero on the SECOND selection of the same
   * costume — so with no event at all its heroes could never be picked.
   *
   * Diffed rather than raised at each mutation site, because a selection changes down a
   * dozen routes (a click, a drag box, a control group, the hero bar, `SelectUnit` from the
   * script itself, a unit dying or walking into a mine) and every one of them must count.
   * The re-selection pulse — a deselect+select pair for a unit a double-click re-issued —
   * is the one thing a diff cannot see, so the click path records it (see selectAt).
   *
   * Only the local player has a selection here, so these are all his: the remote slots
   * aren't playing, and inventing selections for them would fire triggers that never fired.
   */
  drainSelectionEvents(): SelectionEvent[] {
    const out: SelectionEvent[] = [];
    // WC3's order within one change: what left, then what arrived.
    for (const id of this.reselected) {
      if (!this.selectionSeen.has(id) || !this.selected.has(id)) continue; // a real change; the diff has it
      out.push({ unitId: id, player: this.localPlayer, selected: false });
      out.push({ unitId: id, player: this.localPlayer, selected: true });
    }
    this.reselected.length = 0;
    for (const id of this.selectionSeen) if (!this.selected.has(id)) out.push({ unitId: id, player: this.localPlayer, selected: false });
    for (const id of this.selected) if (!this.selectionSeen.has(id)) out.push({ unitId: id, player: this.localPlayer, selected: true });
    if (out.length) this.selectionSeen = new Set(this.selected);
    return out;
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

  /**
   * The selection in the order WC3 displays it: unit priority (UnitData `prio`)
   * descending, so heroes lead, then by sim id ascending.
   *
   * The tie-break must NOT be the order the player happened to add the units. WC3's
   * selection is a property of WHO is selected, not of how you selected them — box-drag
   * two heroes and shift-click the same two in the opposite order and you get the same
   * command card. This used to fall out of `this.selected`'s insertion order, which
   * agreed with WC3 only for a box-drag (the entries it scans are in creation order);
   * shift-clicking the younger hero first put it ahead of the elder one. Sim ids are
   * handed out in creation order (`PlacedIndex`), so ordering by id IS "oldest first".
   */
  private orderedSelection(): number[] {
    return [...this.selected].sort((a, b) => this.priorityOf(b) - this.priorityOf(a) || a - b);
  }

  /** Distinct group keys, in that same order. Drives the icon grid, Tab cycle, primary. */
  private orderedGroups(): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const id of this.orderedSelection()) {
      const k = this.groupKeyOf(id);
      if (k && !seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
    return keys;
  }

  private firstOfGroup(key: string): number | null {
    for (const id of this.orderedSelection()) if (this.groupKeyOf(id) === key) return id;
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
    const ordered = this.orderedSelection();
    for (const key of this.orderedGroups()) {
      for (const id of ordered) {
        if (this.groupKeyOf(id) !== key) continue;
        const u = this.sim.units.get(id);
        const e = this.byId.get(id);
        if (!u || !e) continue;
        out.push({
          simId: id,
          icon: this.registry.get(e.typeId)?.icon ?? "",
          hpFrac: u.maxHp > 0 ? u.hp / u.maxHp : 1,
          manaFrac: u.maxMana > 0 ? u.mana / u.maxMana : -1, // -1: no pool, so no mana bar (issue #109)
          focused: key === this.focusedKey,
          owner: u.owner,
        });
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
    // A unit-target ITEM aims through the console too — clicking an ally's portrait in the
    // group grid is a legitimate way to point a Staff of Sanctuary at it.
    if (this.orderMode === "item" && this.armedItem?.mode === "useunit") {
      const armed = this.armedItem;
      const id = this.primary;
      if (id === null || !this.controls(id)) {
        this.orderMode = null;
        this.armedItem = null;
        return true;
      }
      const err = this.sim.itemUseError(id, armed.slot, simId);
      if (err !== null) return this.refuseOrder(err); // stays armed, exactly as on the map
      this.orderMode = null;
      this.armedItem = null;
      this.execute(this.localPlayer, { c: "useitem", unitId: id, slot: armed.slot, targetId: simId, x: 0, y: 0 });
      return true;
    }
    if (this.orderMode === "attack") {
      const t = this.sim.units.get(simId);
      if (t && simId !== this.primary) {
        let any = false;
        for (const id of this.selected) if (id !== simId && this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: simId, force: true, solo: this.soloOrder(simId) }, queued: false })) any = true;
        // Refused for everyone — a tower aimed past its range — says why and stays armed,
        // exactly as the same click on the MAP does (orderClickAt). The console is another
        // way to name a target, not another rule about what may be attacked.
        if (!any && this.refuseAttackTarget(simId, true)) return true;
        this.orderMode = null;
        if (any) this.ack(true);
        return true;
      }
      this.orderMode = null;
      return true;
    }
    return false;
  }

  /** A worker of the local player that's doing nothing (not gathering, building,
   *  moving, or constructing) — the ones the idle-worker button/F8/~ cycle.
   *
   *  A WORKER is the `peon` classification, not "can harvest", and the Ghoul is the whole
   *  reason to say so: it chops lumber, but `UnitBalance.slk`'s `type` column reads `Peon` on
   *  the Peasant, the Peon, the Wisp and the Acolyte (`Peon,undead`) and plain `undead` on the
   *  Ghoul. A Ghoul standing around is a soldier standing around — it is army, not economy,
   *  and an army idles by design. Counted, it kept the badge lit through every fight and sent
   *  F8 to a unit nobody wants to send back to work. `SimUnit.isPeon` already keys the other
   *  half of the same fact (workers never auto-acquire; a Ghoul fights like any soldier).
   *
   *  A worker walking to a job is not idle: `order` is `garrison`/`harvest`/`build` for the
   *  whole walk, so a wisp on its way into an Entangled Gold Mine — including one standing at
   *  the door of one that is still closing its roots, which is a wait, not an idleness — is
   *  never counted here.
   *
   *  And neither is one that is OFF THE FIELD. `enterHost` parks a passenger on `idle`,
   *  because inside a hold there is no order to have; a Wisp in an entangled mine is
   *  nevertheless mining and a peon in a burrow is manning it, and the badge that offers to
   *  fly the camera to them is offering to select a unit that is not on the map. `inMine` was
   *  the only off-field state tested for; `isOffField` is all of them. */
  private isIdleWorker(u: SimUnit | undefined): u is SimUnit {
    return !!u && u.owner === this.localPlayer && u.isPeon && u.order === "idle" && !u.buildPending && u.constructing === 0 && !isOffField(u);
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
   *  (WC3 exclusion rule: a group is units XOR buildings). Uncapped (issue #109). */
  private ownSelectionByKind(): { kind: "unit" | "building" | null; ids: number[] } {
    const units: number[] = [];
    const buildings: number[] = [];
    for (const id of this.selected) {
      const u = this.sim.units.get(id);
      if (!u || u.owner !== this.localPlayer) continue;
      (u.building ? buildings : units).push(id);
    }
    if (units.length) return { kind: "unit", ids: units };
    if (buildings.length) return { kind: "building", ids: buildings };
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
   *  (units XOR buildings), skipping duplicates. No size cap (issue #109). */
  appendGroup(key: string): void {
    const existing = this.livingGroup(key);
    const sel = this.ownSelectionByKind();
    const kind = existing.length ? (this.sim.units.get(existing[0])?.building ? "building" : "unit") : sel.kind;
    if (!kind) return;
    const merged = [...existing];
    const seen = new Set(existing);
    for (const id of this.selected) {
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

  /**
   * The local player's living heroes, in the order the hero bar (and F1/F2/F3) uses.
   *
   * WC3 locks that order to the sequence the heroes were hired/spawned in and never lets the
   * player re-arrange it, so sim id — which only ever counts up as units are created — IS the
   * order. Illusions are excluded: a Mirror Image is a hero by unit type, but it is a copy on
   * a timer, not one of your heroes (see docs/illusions.md).
   *
   * Read off the SIM, not off the render entries: "which heroes are mine" is a question about
   * the world, and a hero is yours from the instant it is trained — not from the instant its
   * model finishes streaming. Walking `entries` meant a freshly hired Tavern hero (hiring is
   * instant) was missing from the bar and from F1/F2/F3 for as long as its MDX took to load.
   */
  private localHeroes(): number[] {
    const heroes: number[] = [];
    for (const u of this.sim.units.values()) {
      if (u.owner !== this.localPlayer || u.isIllusion || u.hp <= 0) continue;
      if (this.registry.get(u.typeId)?.isHero) heroes.push(u.id);
    }
    return heroes.sort((a, b) => a - b);
  }

  /** The hero bar's ROSTER: living heroes and fallen ones together, in hire order (a sim id
   *  ascends with it, and a fallen hero keeps the id it died under). A dead hero holding its
   *  place is the whole point — the bar is what "your second hero" counts, and the altar
   *  seats its revive buttons off the same order. */
  private localHeroRoster(): Array<{ id: number; fallen: FallenHero | null }> {
    const out = this.localHeroes().map((id) => ({ id, fallen: null as FallenHero | null }));
    for (const f of this.sim.fallen.values()) if (f.owner === this.localPlayer) out.push({ id: f.id, fallen: f });
    return out.sort((a, b) => a.id - b.id);
  }

  /** The hero-bar buttons (issue #95): one per living local hero, in hire order, with the
   *  two bars the button carries and the unspent skill points its glow is gated on. */
  heroBar(): HeroBarEntry[] {
    const out: HeroBarEntry[] = [];
    for (const { id, fallen } of this.localHeroRoster()) {
      if (fallen) {
        const icon = this.registry.get(fallen.typeId)?.icon ?? "";
        // The job bringing it back, if any — read off the building that is paying, since the
        // roster entry only records WHICH building (one at a time; see FallenHero.revivingAt).
        const job = this.reviveJobFor(fallen);
        out.push({
          simId: id, icon,
          hpFrac: 0, manaFrac: -1, skillPoints: 0,
          dead: true,
          disabledIcon: icon ? disabledIconPath(icon) : null,
          reviveSecondsLeft: job ? Math.max(0, Math.ceil(job.timeLeft)) : 0,
          reviveFrac: job && job.buildTime > 0 ? 1 - job.timeLeft / job.buildTime : 0,
        });
        continue;
      }
      const u = this.sim.units.get(id);
      if (!u) continue;
      out.push({
        simId: id,
        icon: this.registry.get(u.typeId)?.icon ?? "",
        hpFrac: u.maxHp > 0 ? u.hp / u.maxHp : 1,
        manaFrac: u.maxMana > 0 ? u.mana / u.maxMana : -1, // -1: no pool, so no mana bar
        skillPoints: u.skillPoints,
        dead: false, disabledIcon: null, reviveSecondsLeft: 0, reviveFrac: 0,
      });
    }
    return out;
  }

  /**
   * The LIVING hero behind hero-bar button `index`, or undefined.
   *
   * Indexed against the ROSTER (`localHeroRoster`), which is what the bar draws — a dead hero
   * holds its slot, so counting the living alone would slide every button after it onto the
   * wrong hero. A dead slot answers undefined, and each of the three gestures the bar
   * supports (select, rally onto, hand an item to) then simply does nothing: none of them
   * means anything aimed at a corpse.
   */
  private heroBarUnit(index: number): SimUnit | undefined {
    const entry = this.localHeroRoster()[index];
    if (!entry || entry.fallen) return undefined;
    return this.sim.units.get(entry.id);
  }

  /** The queued revival that is bringing this fallen hero back, or null while it lies dead. */
  private reviveJobFor(f: FallenHero): { timeLeft: number; buildTime: number } | null {
    if (!f.revivingAt) return null;
    const b = this.sim.units.get(f.revivingAt)?.building;
    for (const j of b?.queue ?? []) if (j.kind === "revive" && j.heroId === f.id) return j;
    return null;
  }

  /** Every fallen hero of a player, in roster order — the altar card reads this. */
  fallenHeroesOf(player: number): FallenHero[] {
    return this.sim.fallenHeroesOf(player);
  }

  /**
   * Right-click on the (index+1)-th hero's button in the top-left hero bar, with a
   * unit-producing building selected: rally that building onto the hero.
   *
   * The hero bar's buttons stand in for the heroes themselves — that is why clicking one
   * selects it and double-clicking jumps the camera to it — so the orders you can aim at a
   * hero in the world can be aimed at its button too, without hunting for it on the map. This
   * is the rally half; `dropItemOnHero` is the other.
   *
   * Deliberately the SAME command the world right-click issues (`kind: "unit"`), so a rallied
   * building's new units follow the hero as it moves, and the rally flag rides on it.
   * Returns false when the selection has nothing to rally, so the caller can fall back.
   */
  rallyToHero(index: number): boolean {
    const hero = this.heroBarUnit(index);
    const heroId = hero?.id;
    if (!hero) return false;
    if (this.primary === null || !this.sim.acceptsRally(this.primary)) return false;
    let any = false;
    for (const id of this.selected) {
      if (this.execute(this.localPlayer, { c: "rally", unitId: id, x: hero.x, y: hero.y, kind: "unit", targetId: heroId! })) any = true;
    }
    if (!any) return false;
    this.rallyFeedback({ x: hero.x, y: hero.y, kind: "unit", targetId: heroId! });
    this.sounds?.playUi("RallyPointPlace");
    return true;
  }

  /**
   * Drop an inventory item onto the (index+1)-th hero's button: hand it over.
   *
   * `slot` names the item when the gesture was a DRAG out of the inventory grid; without it
   * the armed item is used, which is the click-then-click half of the same thing (right-click
   * an item to pick it up, then click the hero you want it to go to — the world gesture,
   * answered by a portrait instead of by a body on the map).
   *
   * The command is the ordinary `giveitem`, so everything downstream is unchanged: the giver
   * walks into range, a full inventory refuses, and a hero out of reach is walked to.
   * Returns false if there was nothing to give or nobody to give it to.
   */
  dropItemOnHero(index: number, slot?: number): boolean {
    const from = this.primary;
    const heroId = this.heroBarUnit(index)?.id;
    if (from === null || heroId === undefined || heroId === from || !this.controls(from)) return false;
    const armed = slot === undefined ? (this.orderMode === "item" && this.armedItem?.mode === "move" ? this.armedItem.slot : undefined) : slot;
    if (armed === undefined || !this.sim.units.get(from)?.inventory[armed]) return false;
    const to = this.sim.units.get(heroId);
    if (!to?.inventory.length) return false;
    this.armedItem = null; // whichever way it was aimed, the gesture is spent
    this.orderMode = null;
    return this.execute(this.localPlayer, { c: "giveitem", unitId: from, slot: armed, targetId: heroId });
  }

  /** F1/F2/F3: select the (index+1)-th of the local player's heroes (stable order),
   *  independent of the numbered control groups. Returns false if there's none — which
   *  includes a hero that is DEAD: it keeps its place in the roster (and its greyed portrait
   *  in the bar) but there is nothing on the map to select. */
  selectHero(index: number): boolean {
    const id = this.heroBarUnit(index)?.id;
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
      //
      // The COLUMN, not the registry, is what makes this an item: the two identity columns are
      // mutually exclusive across every stock row, so carrying `itemid` at all settles it. Asking
      // the ItemRegistry instead used to work only because a map's custom item reported its BASE
      // item's id (see mapViewer.repairCustomRowIds) — now that a custom row names itself, a
      // registry that hadn't been handed this map's .w3t overlay would call it "not an item" and
      // fall through to the unit path.
      if (unit.row?.string("itemid") !== undefined) {
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
        { level: def?.level ?? 0, mechanical: def?.classification.includes("mechanical") ?? false, isPeon: def?.classification.includes("peon") ?? false, ward: def?.classification.includes("ward") ?? false },
      );
      // Map-placed movable units are Neutral Hostile creeps: give them guard AI —
      // home post at the spawn, an aggro range from the map's per-creep target-
      // acquisition (falling back to the unit's own acquire range), and the
      // night-sleep flag from unit data. This is what makes them leash back home
      // after a chase and doze at night instead of chasing forever.
      su.isCreep = true;
      // …where it ACTUALLY STANDS — see createScriptUnit for why the settled position and not
      // the .doo's.
      su.guardX = su.x;
      su.guardY = su.y;
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
        // The form baseline, stated (see spawnUnit): `undefined` means "not baselined yet" to
        // applyFormAnims, which then swallows a unit's FIRST form change as a baseline and
        // plays no transition — so a map-placed Crypt Fiend or Gargoyle popped into its other
        // half the first time it changed and only shuffled from the second time on. Everything
        // seeded here is drawn in its plain half, which is what `anims` above already assumes.
        altModel: false,
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
        castAnimSticky: false,
        castAnimHeld: false,
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

  /**
   * Seed a Neutral Passive entity (shop/tavern/lab/merchant/fountain/critter): a non-hostile
   * sim unit with the yellow ring, so it is hoverable, selectable and ringed.
   *
   * "Neutral Passive" is a SLOT, not a promise to stand still, and treating the two as the
   * same thing is what froze Extreme Candy War's opening. Its whole intro cast — the bats
   * over the graveyard, the villagers who scatter, the abominations lumbering after them —
   * is pre-placed on Neutral Passive and moved by `IssuePointOrderLocBJ` from the cinematic
   * trigger. We gave every neutral-passive unit `speed: 0`, so those orders were accepted
   * and then obeyed by standing perfectly still, and the intro played out as a group photo.
   *
   * So the split is BUILDING vs MOBILE, which is what it always meant: a shop, a fountain or
   * a tavern is static and keeps the Z the map placed it at (the viewer draws it, tick()
   * doesn't), while a critter or a cinematic extra gets its real movement from unit data and
   * is driven like any other unit. Weapons stay empty either way — a neutral-passive unit
   * never fights, which is the part of "passive" that IS a promise.
   */
  private seedNeutral(unit: MapUnit, def: UnitDef | undefined, loc: Float32Array): void {
    const simId = this.placed.reserveIdAt(loc[0], loc[1], def?.id ?? "");
    this.seededInstances.add(unit.instance); // RTS drives this shop/critter's fog visibility
    const isBuilding = def?.isBuilding ?? false;
    const flying = !isBuilding && def?.moveType === MoveType.Fly;
    // Buildings get a (complete) building state so pickAt/rings treat them as
    // structures (footprint-sized ring, lowered collider); their footprint is
    // already stamped by the map loader, so speed 0 → no cell reservation here.
    const building: BuildingState | null = isBuilding
      ? { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: loc[0], rallyY: loc[1], rallyKind: "none", rallyTargetId: 0, producesUnits: false }
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
        // A structure never moves (and its footprint is already stamped by the map loader, so
        // speed 0 also means no cell reservation here); anything else moves at its own pace,
        // because a script can order it to.
        speed: isBuilding ? 0 : def?.speed ?? 0,
        turnRate: def?.turnRate ?? 0.5,
        radius: def?.collision || 16,
        flying,
        // A static neutral keeps the Z the map placed it at; a mobile one rides the ground
        // plus its own flight height, the same lift its Entry gets.
        flyHeight: flying ? lift(def?.moveHeight ?? 0) : 0,
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
      {
        // Neutral shops/labs/merchants/taverns carry "Invulnerable (Neutral)" (Avul) in
        // their abilList — permanently immune + untargetable (issue #26).
        baseInvulnerable: !!def?.abilities.includes("Avul"),
        // …and the rest of that abilList is what a fountain IS. `Avul` was the only entry
        // ever read here, so a Fountain of Health arrived with an empty ability list and
        // stood there as scenery: its `ACnr` (and the Fountain of Mana's `ANre`) are plain
        // regeneration auras — `Units\UnitAbilities.slk` gives it `Avul,ACnr` and nothing
        // else — and an aura a unit does not carry is an aura nothing applies. Same builder
        // every other unit's abilities come from, so a neutral building is no longer the one
        // seeding path that silently drops them.
        abilities: def ? this.buildInitialAbilities(def) : [],
      },
    );
    u.neutralPassive = true;
    if (isBuilding) this.adoptPlacedFootprint(simId, loc[0], loc[1]); // its collision dies with it
    const entry: Entry = {
      simId,
      unit,
      anims: buildAnimSet(unit.instance.model.sequences, def?.animProps),
      altModel: false, // the form baseline, stated — see the note on the creep seed above
      // A static neutral keeps its map-placed Z (tick() does not drive it); a mobile one is
      // drawn like any unit, so it needs the same flight lift its sim unit carries.
      moveHeight: isBuilding ? 0 : lift(def?.moveHeight ?? 0),
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
        castAnimSticky: false,
        castAnimHeld: false,
      moveEma: 1,
      prevDrawnX: NaN,
      prevDrawnY: NaN,
    };
    this.entries.push(entry);
    this.byId.set(simId, entry);
  }

  /**
   * The placed units the RENDERER will never deliver, seeded straight from the .doo.
   *
   * `trySeed` adopts what the viewer hands it, and the viewer only builds a widget for a unit
   * whose MODEL loaded (`loadUnitsAndItems`: `this.load(path).then(model => { if (model) … })`).
   * A type with no model therefore never arrives — and that is not an edge case, it is WC3's
   * DUMMY UNIT: clear "Art - Model File" in the object editor and you get an invisible unit
   * that still holds its ground, its sight and its abilities (see `normModel`). Extreme Candy
   * War's opening cinematic is built on exactly two of them, `hrdh` "Dummy Cinematic Vision
   * Horde" and `njks` "Dummy Cinematic Vision Alliance" — one placed in the shot per team, and
   * removed the moment the cinematic ends. They are the ONLY thing lifting the fog there (the
   * map's script reveals nothing, and re-MASKS the area afterwards, which is the proof it was
   * uncovered), so without them the whole intro played black.
   *
   * Only a type with no model at all qualifies. Art we merely failed to find is a broken asset
   * and stays dropped, so it still looks broken instead of quietly becoming an invisible unit.
   *
   * Called once adoption has settled (`waitForMapUnits`) — before then, "unclaimed" only means
   * "still streaming".
   */
  seedModellessPlaced(): number {
    let seeded = 0;
    for (const p of this.placed.unclaimedPlaced()) {
      const def = this.registry.get(p.typeId);
      if (!def || def.model) continue;
      // Owner by the same three-way split trySeed uses; a dummy has no aggro post, no drop
      // table and no footprint to inherit, so `addSimUnit` alone is the whole seed.
      const seed = this.placed.playerSeedAt(p.x, p.y);
      const owner = seed ? seed.owner : this.placed.isNeutralPassiveAt(p.x, p.y) ? NEUTRAL_PASSIVE_OWNER : -1;
      const team = seed ? seed.team : this.placed.isNeutralPassiveAt(p.x, p.y) ? NEUTRAL_PASSIVE_TEAM : -1;
      this.addSimUnit(def, p.x, p.y, p.facing, owner, team, 0, this.placed.reserveIdAt(p.x, p.y, def.id));
      seeded++;
    }
    return seeded;
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
    // A COMPUTER player's unit holds the ground it is put on until something commands it —
    // the leash half of the guard behaviour (SimUnit.guarding). Applied HERE rather than at
    // the .doo adoption, because a campaign map does not place its cast in war3mapUnits.doo:
    // it writes `CreateUnit` calls into `CreateAllUnits()`, so Illidan and every one of his
    // Naga arrive through the script path. A human's units never get it — yours go where you
    // send them and stay there — and the flag is cleared the moment anything orders the unit.
    const guarding = this.aiPlayers.has(owner) && !def.isBuilding;
    // The type's innate abilities as the two data-driven rules below want them: the BASE code
    // (a map's `A000` cloned from `Ahar` is still `Ahar`) plus the rank-1 Data columns.
    const innate = def.abilities.map((id) => {
      const a = this.abilities.get(id);
      return { code: a?.code ?? id, data: a?.levelData[0]?.data ?? [] };
    });
    // A worker is whatever CARRIES a harvest ability, not one of five known ids — see
    // workerProfileFor. The map's own builder is a Peasant with `Ahar` and a custom `Builds`
    // list, and without this it had no worker state, so no Build button and no gathering.
    const profile = workerProfileFor(def.id, innate.map((a) => a.code));
    // …and a depot is whatever carries `Artn` ("Return Resources"), whose two Data columns ARE
    // these two flags — so a custom map's own Town Hall takes gold, and the War Mill and the
    // Graveyard take lumber. See depotRoleFor.
    const depot = depotRoleFor(def.classification, innate);
    // baseLumberCapacity is the pre-upgrade load; Improved Lumber Harvesting raises the live
    // `lumberCapacity` off it each tick (recomputeStats), so the profile stays the baseline.
    const worker: WorkerState | null = profile ? { ...profile, baseLumberCapacity: profile.lumberCapacity, carryGold: 0, carryLumber: 0 } : null;
    // Structures get building state (construction + a training queue); rally
    // point defaults to just south of the building.
    const building: BuildingState | null = def.isBuilding
      ? { constructionLeft: constructionTime, buildTimeTotal: constructionTime || 1, builderIds: [], goldCost: def.goldCost, lumberCost: def.lumberCost, queue: [], rallyX: x, rallyY: y - 200, rallyKind: "none", rallyTargetId: 0, producesUnits: this.tech.producesUnits(def.id) }
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
        // Mana it is BORN with, not its pool: UnitBalance's `mana0`, which is short of `manaN`
        // for every caster you have to wait on (a Priest at 75/200, a Moon Well at 100/300).
        // A structure still going up has NONE — the bar itself is withheld until it is
        // finished (recomputeStats), and finishConstruction is where it is filled to `mana0`.
        mana: constructionTime > 0 ? 0 : def.manaStart || def.mana,
        maxMana: def.mana,
        armor: def.armor,
        armorType: def.armorType,
        weapons: weaponsFromDef(def),
        castPoint: def.castPoint,
        castBackswing: def.castBackswing,
        worker,
        depotGold: depot.gold,
        depotLumber: depot.lumber,
      },
      building,
      // "Invulnerable (Neutral)" (Avul): neutral buildings — goblin merchant, goblin
      // laboratory, mercenary camp, tavern, gold mine, marketplace — carry it in their
      // abilList by default and are permanently immune/untargetable (issue #26).
      // "Peon" classification = a worker: it never auto-acquires a target, so it won't
      // join a fight it wasn't explicitly ordered into (issue #41). Note the Ghoul
      // harvests lumber but is NOT Peon-classified — it fights like any other unit.
      // "Ward" classification = a planted gadget (Serpent/Healing/Sentry Ward, Stasis Trap,
      // …): like a worker, it is the last thing a creep camp turns on (SimUnit.ward).
      { hero, abilities: this.buildInitialAbilities(def), mechanical: def.classification.includes("mechanical"), isPeon: def.classification.includes("peon"), ward: def.classification.includes("ward"), ancient: def.classification.includes("ancient"), level: def.level, baseInvulnerable: def.abilities.includes("Avul") },
    );
    // A structure spawned WITH a build time is a foundation just laid — that's the
    // moment EVENT_(PLAYER_)UNIT_CONSTRUCT_START fires (7.17). A pre-placed/instant
    // building (constructionTime 0) was never "constructed", so it raises nothing.
    if (constructionTime > 0) this.sim.noteConstruct(simId, "start");
    if (guarding) {
      const su = this.sim.units.get(simId);
      if (su) su.guarding = true;
    }
    return simId;
  }

  /**
 * Make an attackable DESTRUCTIBLE a real sim unit — the gate you have to break to get on
 * with the mission.
 *
 * Everything a destructible needs in a fight, a unit already has: a body to stand next to,
 * life to spend, a damage point, a backswing, a death. WC3 agrees at the class level (a
 * destructable and a unit are both CWidgets — docs/reverse-engineering/tinkerworx-repos.md),
 * so this reuses the unit path rather than growing a second combat loop beside it. Three
 * lines are what make it a destructible and not a unit:
 *
 *   • **neutralPassive**, which is exactly WC3's own rule. hostile() is false for a
 *     neutral-passive unit in BOTH directions, so nothing ever AUTO-acquires a gate — units
 *     walk past crates and barricades until you point at one, which is the behaviour — and
 *     it keeps destructibles off the minimap for free.
 *   • **targetKey**, its targType, so a weapon matches it as debris/wall and not as a
 *     structure. Every melee unit in the game already lists debris in Targets Allowed.
 *   • **no body of our own.** The doodad pass already drew it, so the instance handed in is
 *     that same widget, reused exactly as a pre-placed unit's is (see seedPlayerUnit) —
 *     the entry the HUD selects through points at what the viewer is really drawing.
 *
 * The map loader has already stamped its footprint and nothing is stamped here, because the
 * footprint OUTLIVES the sim unit: a dead gate keeps its posts (pathTexDeath). Swapping it
 * is the renderer's job, through the killDestructible path it already had.
 */
  addDestructible(def: UnitDef, x: number, y: number, facing: number, life: number): number {
    const simId = this.addSimUnit(def, x, y, facing, NEUTRAL_PASSIVE_OWNER, NEUTRAL_PASSIVE_TEAM);
    this.destructibleDefs.set(simId, def);
    const u = this.sim.units.get(simId);
    if (u) {
      u.neutralPassive = true;
      u.targetKey = destructibleTargetKey(def);
      // A record the editor placed part-damaged keeps the life it was placed with.
      u.hp = Math.max(1, Math.min(life || u.maxHp, u.maxHp));
    }
    return simId;
  }

  /** Give a destructible its body once the doodad pass has actually built one.
   *
   *  Same late-attach a script-spawned unit gets, and for the same reason: the sim unit has
   *  to exist before the model does. Without a body there is no Entry, and without an Entry
   *  the cursor cannot find it — a gate you can order units onto but cannot CLICK. Ignored
   *  if it already has one. */
  attachDestructibleBody(simId: number, def: UnitDef, instance: Instance): void {
    if (this.byId.has(simId) || !this.sim.units.has(simId)) return;
    this.attachInstance(simId, instance, def);
    // …on LOAN. The instance is the map's own doodad and mapViewer may retire it at any
    // moment — see Entry.borrowedBody, which is what keeps us from drawing over the swap.
    const e = this.byId.get(simId);
    if (e) e.borrowedBody = true;
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
      // A real boolean, not `undefined`: `undefined` means "no baseline yet" to
      // applyFormAnims, which then SWALLOWS the first form change as a baseline — and for
      // everything but an Ancient (built rooted) the first form change is the morph the
      // player just paid for. Stating it here is what lets the transition clip play.
      altModel: alt,
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
      // The TYPE's own "Art - Tinting Color" (UnitUI red/green/blue) as the model's base
      // colour, which fog dimming then multiplies — the same channel JASS SetUnitVertexColor
      // writes, so a trigger recolouring the unit later simply replaces this. Stated here
      // rather than left for applyFogTint to sample off the instance, because that samples
      // only ONCE and would bake in whatever the model happened to be wearing.
      baseColor: tintColor(def),
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
        castAnimSticky: false,
        castAnimHeld: false,
      moveEma: 1,
      prevDrawnX: NaN,
      prevDrawnY: NaN,
    };
    this.entries.push(entry);
    this.byId.set(simId, entry);
    if (entry.baseColor) instance.setVertexColor?.(entry.baseColor); // a tinted type, worn now
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

  /**
   * Re-read every render fact a unit's TYPE decides, on the body it is already wearing.
   *
   * This is the whole of a morph between two types that share ONE model, which is how WC3
   * writes most form pairs: `Nalc`/`Nalm`/`Nal2`/`Nal3` are four unit ids over one
   * HeroGoblinAlchemist.mdx, `ucry`/`ucrm` two over one CryptFiend.mdx. Handing those a new
   * instance (which is what remodel does, and what this used to be part of) throws away the
   * pose mid-play — including the "Morph" transition applyFormAnims has just started — so
   * the Alchemist popped into his ogre with no shuffle between the two.
   *
   * It deliberately leaves the POSE alone (`curSeq`, the swing/chop latches, `altModel`):
   * that is the body's state, not the type's, and the body has not changed.
   */
  retype(simId: number, def: UnitDef): boolean {
    const entry = this.byId.get(simId);
    if (!entry) return false;
    // A morph is how a unit ENTERS its alternate form (a Crypt Fiend burrowing), so the
    // sequence list has to be read with that form's props or it arrives wearing the plain
    // half — the burrowed Fiend standing above ground.
    const props = animPropsFor(def, this.sim.units.get(simId)?.altModel ?? false);
    const seqs = entry.unit.instance.model.sequences;
    entry.anims = buildAnimSet(seqs, props);
    Object.assign(entry, findBirthFields(seqs, props));
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
    // The new type's tint, STATED rather than left undefined — a morph between two types that
    // share one model (Nalc→Nalm) keeps its instance, so an untinted new type would otherwise
    // fall through to applyFogTint sampling the body, and sample the OLD type's colour (already
    // fog-dimmed) as its base. A retype always knows the answer, so it gives it.
    entry.baseColor = tintColor(def) ?? new Float32Array([1, 1, 1, 1]);
    entry.fogTintB = NaN; // …and force the next fog pass to re-emit from it
    entry.unit.instance.setVertexColor?.(entry.baseColor);
    return true;
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
    if (!this.retype(simId, def)) return false;
    entry.altModel = this.sim.units.get(simId)?.altModel ?? false;
    entry.curSeq = -1;
    entry.lastSwingSeq = -1;
    entry.lastChopSeq = -1;
    entry.upgradeBirth = undefined; // resolved against the OLD body's sequence list
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
      e.castAnimSticky = false;
      e.castAnimHeld = false;
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
    e.castAnimSticky = false;
    e.castAnimHeld = false;
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

  /**
   * The world does not MOVE until the map has finished setting itself up.
   *
   * WC3 runs `main()` — CreateAllUnits, InitCustomTriggers, RunInitializationTriggers —
   * to completion before a single frame of play. Ours could not: a custom map has to wait
   * for every pre-placed unit's model to stream in before the script may run (see
   * startCustom), and the sim was stepping the whole time. So for a second or two the map
   * ran with none of its own initialisation applied, and Rise of the Naga lost its mission
   * in that window: its Naga stand over the fishing village's ships all mission and are
   * held off them by one line of init
   *
   *     call SetPlayerAllianceStateBJ( udg_AP4_Naga, udg_AP3_FishingVillage, bj_ALLIANCE_NEUTRAL )
   *
   * which had not run yet. They auto-acquired the ships in the opening ticks, and two ship
   * deaths is a scripted defeat — so the chapter was unwinnable before the player had
   * moved. Seeding still runs (that is what the wait is FOR); only the step is held.
   */
  private worldHeld = false;

  /** Hold the world still (match setup), and let it go once the script has initialised.
   *
   *  Releasing it is also the moment every AI unit's POST is fixed: wherever the map left it
   *  standing, unordered, is the ground it holds (see SimUnit.guarding). Done as one sweep
   *  here rather than per-spawn, because a map has several ways to put a unit down — the
   *  `.doo` adoption, a `CreateUnit` in `CreateAllUnits`, a `CreateNUnitsAtLoc` in its init —
   *  and "standing still with no orders when the map finished setting up" is the one
   *  description that covers all of them.
   *
   *  A unit the init already ORDERED is armed too, and that is deliberate rather than sloppy:
   *  the leash only ever acts on an attack the unit picked out for ITSELF (`tickGuardLeash`),
   *  so a commanded move, a scripted attack wave and a patrol are all untouched by it — and
   *  the first thing any of those does when it lands is clear the post anyway. Requiring
   *  "idle" here instead meant the one unit that mattered — Illidan, who the map has doing
   *  something the instant the world starts — was the one unit left off the leash. */
  holdWorld(held: boolean): void {
    this.worldHeld = held;
    if (held) return;
    for (const u of this.sim.units.values()) {
      if (u.guarding || u.isCreep || u.building || u.neutralPassive || u.owner < 0) continue;
      if (!this.aiPlayers.has(u.owner)) continue;
      u.guarding = true;
      u.guardX = u.x;
      u.guardY = u.y;
      u.guardFacing = u.facing;
    }
  }

  /** Adopt whatever the renderer has delivered since the last look, WITHOUT stepping the
   *  world — what a world held at the start gate still needs, since the sim never ticks there
   *  and `trySeed` is the only way a delivered instance becomes a unit
   *  (see MapViewerScene.holdAtStart). */
  seedPending(): void {
    this.trySeed();
  }

  tick(dt: number): void {
    this.trySeed();
    if (this.worldHeld) return; // adoption yes, simulation no — see holdWorld
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
      this.tickClientProjectiles(dt);
    } else {
      // The computer players think BEFORE the step, so an order given this tick is acted on
      // in it rather than a frame late. Only here: this branch is the authority's, and a
      // frozen client must never run a second, divergent copy of the AI (docs/multiplayer.md).
      // Gated on seeding, because until the .doo has settled there are no units to command
      // and no gold mine for `MeleeFindNearestMine` to have found.
      // Sub-phases of `sim`, for the session log (src/dev/perfLog.ts). Dotted, so they are a
      // breakdown of the span they sit inside rather than siblings of it.
      perfLog.begin("sim.ai");
      if (this.meleeAi?.active && this.seeded) this.meleeAi.tick(dt);
      if (this.computerPlus?.active && this.seeded) this.computerPlus.tick(dt);
      perfLog.end("sim.ai");
      perfLog.begin("sim.world");
      this.sim.tick(dt);
      perfLog.end("sim.world");
      perfLog.begin("sim.fx");
      // The spell/ability PRESENTATION drains — ONE consumer of the sim's queues (this),
      // two audiences: this machine's own renderer (via the drainFx* methods the renderer
      // now reads instead of the sim's), and, when hosting a wire, the recipients' payloads
      // (`takeWireFx` → MatchLink's buffer). Splitting here is what lets both see each event
      // exactly once; a frozen client fills the same renderer queues from its payload.
      const fxE = this.sim.drainSpellEffects();
      const fxS = this.sim.drainSpellSplats();
      const fxL = this.sim.drainSpellLightnings();
      const fxLs = this.sim.drainLightningStops();
      const fxCs = this.sim.drainCastStarts();
      const fxCf = this.sim.drainCastFires();
      const fxT = this.sim.drainCombatTexts();
      if (fxE.length) this.fxEffects.push(...fxE);
      if (fxS.length) this.fxSplats.push(...fxS);
      if (fxL.length) this.fxLightnings.push(...fxL);
      if (fxLs.length) this.fxLightningStops.push(...fxLs);
      if (fxCs.length) this.fxCastStarts.push(...fxCs);
      if (fxCf.length) this.fxCastFires.push(...fxCf);
      if (fxT.length) this.fxCombatTexts.push(...fxT);
      if (this.matchLinkIsHost && this.matchLink && (fxE.length || fxS.length || fxL.length || fxLs.length || fxCs.length || fxCf.length || fxT.length)) {
        this.wireFx.effects.push(...fxE);
        this.wireFx.splats.push(...fxS);
        this.wireFx.lightnings.push(...fxL);
        this.wireFx.lightningStops.push(...fxLs);
        // Combat text needs no enrichment on the way out: the sim already stamped each one
        // with where it happened, which is both the anchor and the recipients' AoI test.
        this.wireFx.texts.push(...fxT);
        // The wire copy of a cast carries the CASTER's position — the AoI test each
        // recipient's filter runs; the sim's event names only the caster.
        for (const c of fxCs) {
          const u = this.sim.units.get(c.casterId);
          this.wireFx.castStarts.push({ ...c, x: u?.x ?? c.tx, y: u?.y ?? c.ty });
        }
        for (const c of fxCf) {
          const u = this.sim.units.get(c.casterId);
          this.wireFx.castFires.push({ ...c, x: u?.x ?? 0, y: u?.y ?? 0 });
        }
      }
      perfLog.end("sim.fx");
    }
    perfLog.begin("sim.deaths");
    this.playImpacts(); // BEFORE deaths — a killed target's entry is still around to read its armour
    for (const id of this.sim.drainDeaths()) {
      // Hosting a wire: the recipients must be TOLD a unit died — its absence from the next
      // payload alone reads exactly like fog, and fog plays no collapse. Position from the
      // entry's drawn spot (the corpse falls where the model stood); each recipient's filter
      // needs it for the eyes-on-the-spot test.
      if (this.matchLinkIsHost && this.matchLink) {
        const loc = this.byId.get(id)?.unit.instance.localLocation;
        const su = this.sim.units.get(id);
        this.wireDeaths.push({ id, x: loc?.[0] ?? su?.x ?? 0, y: loc?.[1] ?? su?.y ?? 0 });
      }
      this.onDeath(id);
    }
    for (const id of this.sim.drainRemovals()) {
      // A frozen client's applier removes records for two different reasons and says which:
      // a payload-declared DEATH plays the collapse and leaves the corpse; plain absence is
      // fog and retires the model silently. The set is per-payload and idempotent — an id
      // the drain never surfaces (a death in fog we never had a record for) just expires.
      if (this.pendingWireDeaths.delete(id)) this.onDeath(id);
      else this.onRemove(id);
    }
    // Offer every dead structure to the ghost memory BEFORE the fog rebuilds below, so each
    // viewpoint is judged on the sight it had when the building fell rather than on sight it
    // gains this tick. A viewpoint that was watching keeps no image — it saw the collapse.
    for (const u of this.sim.drainDeadStructures()) this.ghosts.noteDestroyed(u, this.viewpoints.viewerSeats());
    this.tickCorpses(dt);
    perfLog.end("sim.deaths");
    if (this.hovered !== null && !this.byId.has(this.hovered)) this.hovered = null;
    if (this.hoveredMine !== null && !this.sim.mines.has(this.hoveredMine)) this.hoveredMine = null;
    if (this.hoveredItem !== null && !this.sim.items.has(this.hoveredItem)) this.hoveredItem = null;
    // Fog of war: rebuild the "currently visible" layer a few times a second — WC3
    // refreshes fog periodically, not every frame, and this keeps circle-stamping
    // cheap. The initial accumulator > interval forces a rebuild on the first tick.
    // Every viewpoint keeps its own 10 Hz clock. Only the LOCAL one's rebuild re-prunes the
    // selection, because the selection is this machine's, not the match's.
    perfLog.begin("sim.fog");
    const rebuilt = this.viewpoints.tick(dt);
    // A ghost is forgotten by SIGHT, not by a clock (measured against the real 1.27a client),
    // and the moment a viewpoint's sight changes is exactly when it rebuilt.
    for (const vp of rebuilt) this.ghosts.forgetSeen(vp.player, vp);
    if (rebuilt.includes(this.local)) {
      this.pruneFogged(); // whatever the new fog swallowed leaves the selection (issue #62)
    }
    perfLog.end("sim.fog");
    perfLog.begin("sim.link");
    this.driveMatchLink(dt);
    // Adopt the newest payload once per tick. On a client this is where "what may I see" stops
    // being a question we answer and becomes one we were answered (`modelHidden`).
    this.snapshot.update(this.matchLink?.latest() ?? null);
    perfLog.end("sim.link");
    perfLog.begin("sim.entries");
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
      // A neutral-passive STRUCTURE (shop, tavern, fountain) is drawn where the map put it —
      // the viewer already placed that widget and we only own its fog visibility. So is a
      // DESTRUCTIBLE, whose body is borrowed outright from the doodad pass (Entry.borrowedBody)
      // and whose Z is the doodad's, not the terrain's — drive one from the sim and the crate
      // floats. A mobile neutral is neither: a critter, or a cinematic extra a trigger orders
      // across the graveyard, is drawn from the sim like any other unit (see seedNeutral).
      if (u.neutralPassive && (u.building || e.borrowedBody)) {
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
      // A finished building UPGRADING into its next tier plays the TARGET tier's "Birth"
      // clip, scrubbed to the upgrade timer — the same treatment construction gets, because
      // it is the same thing: that clip exists for no other reason. HumanTower.mdx's is
      // "Birth Upgrade First Second third" — ONE clip shared by the Guard, Cannon and Arcane
      // towers, none of which can be built directly, so an upgrade is the only way to reach
      // it. Ziggurat → Spirit Tower and Town Hall → Keep are the same shape.
      //
      // Without this an upgrading building just ran `pickSequence`'s "queue is busy" branch
      // and stood on "Stand Work" — and a tower has no work clip, so that fell all the way
      // back to its ATTACK swing (see buildAnimSet's `build`).
      const upJob = u.building && u.building.queue[0]?.kind === "upgrade" ? u.building.queue[0] : null;
      if (upJob) {
        const b = this.upgradeBirthFor(e, upJob.unitId);
        if (b.seq >= 0) {
          setAnimRate(e, 1); // scrubbed by progress, not played at a rate
          if (e.curSeq !== b.seq) {
            e.curSeq = b.seq;
            e.unit.state = WidgetState.WALK; // keep mdx-m3-viewer from auto-standing
            e.unit.instance.setSequence(b.seq);
            e.unit.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined);
          }
          e.unit.instance.frame = b.start + upgradeProgress(upJob) * (b.end - b.start);
          continue; // don't run the normal animation picker while it rises
        }
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
        // …except a spin-for-the-duration clip, which is the ability itself rather than a
        // gesture in front of it: Bladestorm's cast ENDS the instant it starts (it is not a
        // channel — the Blademaster keeps walking and killing), and its clip is authored for
        // exactly that ("Attack Walk Stand Spin"). Answering to `order === "cast"` dropped
        // the spin a frame after it began. See SimWorld.ANIM_FOR_DURATION.
        // `castAnimHeld` is the same test one notch softer: hold while the unit stands
        // there, whatever the order says. A looping gesture is sized to its EFFECT rather
        // than to the cast (Healing Spray keeps spraying after the order is done), so
        // answering only to `order === "cast"` cut it off at the backswing — and an Acolyte's
        // summon is not a cast at all, so it has no other way to be held.
        if (e.castAnimSticky || ((u.order === "cast" || e.castAnimHeld) && !u.moving)) {
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
      // …and a worker in a Haunted Gold Mine's RING is not chopping anything. It is kneeling
      // at a mine, and `chopLumber` falls back to the plain attack swing for a model that
      // authors no "Attack Lumber" — which the Acolyte does not — so this branch had it
      // hacking at the rock on the chop clock instead of holding its "Stand Work Gold"
      // (pickSequence's ring branch, which it never reached). `ringSlot` is the flag that
      // says which of the two jobs the harvest order is.
      const chopping = u.working && u.order === "harvest" && !u.moving && !u.ringSlot && e.anims.chopLumber >= 0;
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
        // A model whose "attack" IS its stand clip: the Human towers author ONE sequence
        // apiece that covers both ("Stand Ready Attack", "Stand Upgrade Third Attack Ready"),
        // so `anims.attack` and `anims.stand` land on the same index. Re-triggering that per
        // swing plays it once under ModelDefined and holds the last frame — the Arcane Tower
        // freezing mid-attack. There is no swing gesture to keep in phase here, so the clip
        // simply keeps looping the way it does when the tower is idle.
        const standAttack = vs.length === 1 && e.anims.standVariants.includes(vs[0]);
        if (standAttack) {
          if (e.curSeq !== vs[0]) {
            e.curSeq = vs[0];
            e.unit.state = WidgetState.WALK;
            e.unit.instance.setSequence(vs[0]);
            e.unit.instance.setSequenceLoopMode(SequenceLoopMode.Loop);
          }
        } else if (u.swingSeq !== e.lastSwingSeq || !vs.includes(e.curSeq)) {
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
        // "Walk Fast" gait); every other pose plays at its authored rate — including the
        // STAND a model with no walk clip travels in (a Wisp hovers), which has no stride to
        // match to a speed and would only shimmer if it were scaled with one.
        if (effMoving && seq !== e.anims.stand) {
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
    perfLog.end("sim.entries");
    perfLog.begin("sim.overlays");
    this.updateHealthBars();
    this.overlays.syncHoverTip(this.computeHoverTip());
    perfLog.end("sim.overlays");
  }

  /** The sim removed this unit: play its death animation, then decay the corpse
   *  (flesh → bone) in place until it's fully removed (see tickCorpses). */
  private onDeath(simId: number): void {
    const e = this.byId.get(simId);
    if (!e) return;
    // A destructible does not die like a unit, and its body is not ours to bury (see
    // Entry.borrowedBody). mapViewer's `killDestructible` is already playing the model's own
    // `death` clip on the stand-in and holding the last frame — that held pose IS the
    // wreckage, the collider has already dropped to whatever `pathTexDeath` keeps, and the
    // widget's death event has been queued for the map's triggers. Retire the entry and touch
    // nothing else: adopting the gate's placed doodad as a corpse is what drew the intact door
    // back over its own rubble on Rise of the Naga.
    if (e.borrowedBody) {
      this.dropEntry(e);
      return;
    }
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
      // A hero has no sim corpse to find (spawnCorpse declines one) and does not want the
      // "no corpse → blink out when the Death clip ends" ending either: it dissipates and
      // fades. See tickCorpses.
      this.corpses.push({ instance: e.unit.instance, corpseId: corpse?.id ?? -1, anims: e.anims, phaseT: 0, phase: "death", hero: def?.isHero });
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
    if (!e.borrowedBody) e.unit.instance.hide(); // borrowed: mapViewer decides what stands there
  }

  /** Ghost entries whose image the host has just dropped, collected during the entry sync and
   *  retired after it. Deferred because `dropEntry` splices `this.entries`, and splicing the
   *  array a `for…of` is walking silently skips the next element. */
  private readonly forgotten: Entry[] = [];

  /**
   * Fog a CORPSE. A corpse outlives its render Entry — the model is adopted into `corpses` and
   * sequenced through Death → Decay Flesh → Decay Bone in place — and the visibility rule that
   * governed it went with the Entry, so an archer cut down in ground nobody has scouted lay
   * there in plain sight through the black. This is that rule, applied where the bones live.
   *
   * A corpse follows the UNIT rule, not the building one: units are not remembered in WC3, so
   * it is drawn only while its spot is actually in sight and goes when the sight does. That is
   * `fogBlocksAt` — the same "no eyes on this spot" the gold mines and the ground items use,
   * and the one that answers correctly under reveal-all. Nothing else touches these instances'
   * visibility, so a plain toggle is safe.
   */
  private fogCorpse(c: { instance: Instance }): void {
    const loc = c.instance.localLocation;
    if (this.local.fogBlocksAt({ x: loc[0], y: loc[1] })) c.instance.hide();
    else c.instance.show();
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
      // LOADED into a Meat Wagon: off the ground, but not gone. The body is still a corpse in
      // every sense — it can be raised out of the wagon where it stands — so the model is only
      // hidden, and the entry is kept so that dropping it puts it back down. Decay carries on
      // underneath, which is what stops a wagon hoarding bodies forever.
      if (sc && sc.heldBy) {
        if (!c.held) {
          c.instance.hide();
          c.held = true;
        }
        continue;
      }
      if (c.held) {
        // Dropped: it lands where the wagon was standing, so the model has to be moved before
        // it is shown again — it has not been where it fell for some time.
        c.held = false;
        this.loc[0] = sc ? sc.x : 0;
        this.loc[1] = sc ? sc.y : 0;
        this.loc[2] = this.groundHeightAt(this.loc[0], this.loc[1]);
        c.instance.setLocation(this.loc);
        c.instance.show();
      }
      this.fogCorpse(c);
      c.phaseT += dt;
      if (c.phase === "death") {
        // Wait out the death animation, then either dissipate (a hero), vanish (no corpse)
        // or begin the flesh-decay stage.
        if (c.phaseT < seqDuration(c.instance, c.anims.death, DEATH_CLIP_FALLBACK)) continue;
        if (c.hero) {
          // "Because they leave no physical remains, abilities that rely on corpses cannot
          // target a fallen Hero" — the body goes rather than rots. Every hero model authors
          // a Dissipate clip and no decay clips at all, so the art already says this.
          this.enterCorpsePhase(c, "dissipate");
          continue;
        }
        if (!leavesCorpse) {
          c.instance.hide();
          this.corpses.splice(i, 1);
          continue;
        }
        this.enterDecay(c, "flesh");
      } else if (c.phase === "dissipate") {
        // The clip plays at its own rate and then holds; what times this is MiscData's
        // DissipateTime, which is the game's own choice of clock — the constant sits under
        // "death and decay impact gameplay, so duration is specified", and it is the same
        // number the sim gates the altar's revive button on (FallenHero.bodyLeft). One clock
        // for the body and the button is the whole point: they have to end together.
        //
        // The fade is the LAST HERO_FADE_TIME of that window, not an extra phase after it —
        // see the constants' own note. HeroPaladin's Dissipate is 2.0s and the window is 3, so
        // for it the two line up exactly: the clip ends, the second of fade begins.
        if (c.phaseT < HERO_DISSIPATE_TIME - HERO_FADE_TIME) continue;
        this.enterCorpsePhase(c, "fade");
      } else if (c.phase === "fade") {
        // …and out. A plain alpha ramp on the instance's tint — nothing else writes a corpse's
        // colour (fogCorpse only shows and hides), so this can own it outright.
        const k = Math.min(1, c.phaseT / HERO_FADE_TIME);
        const base = c.fadeFrom ?? WHITE_TINT;
        c.instance.setVertexColor?.([base[0], base[1], base[2], base[3] * (1 - k)]);
        if (k >= 1) {
          // Put the colour back before letting go of it. The instance outlives this entry, and
          // an instance handed on still wearing alpha 0 would be adopted as an invisible unit —
          // `applyFogTint` caches whatever colour it finds as the model's own `baseColor`.
          c.instance.setVertexColor?.(base);
          c.instance.hide();
          this.corpses.splice(i, 1);
        }
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

  /**
   * Move a HERO's body into its dissipate or fade stage (issue #126).
   *
   * `dissipate` plays the model's own clip once and holds the last frame; a model that
   * authors none simply keeps the pose it died in for the same window, which is what the fade
   * then takes away — the timing is the sim's, so it must not depend on the art.
   *
   * `fade` snapshots the colour the body is wearing right now (its team tint, dimmed by
   * whatever the fog pass last applied) so the ramp multiplies that rather than replacing it
   * with white.
   */
  private enterCorpsePhase(c: { instance: Instance; anims: AnimSet; phase: CorpsePhase; phaseT: number; fadeFrom?: Float32Array }, phase: "dissipate" | "fade"): void {
    c.phase = phase;
    c.phaseT = 0;
    if (phase === "dissipate") {
      if (c.anims.dissipate < 0) return;
      c.instance.setSequence(c.anims.dissipate);
      c.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined); // play once, then hold
      return;
    }
    const cur = c.instance.vertexColor;
    c.fadeFrom = cur ? new Float32Array([cur[0], cur[1], cur[2], cur[3]]) : new Float32Array(WHITE_TINT);
  }

  /** Move a corpse into its flesh/bone decay stage, playing the matching clip if
   *  the model has one. A model missing the flesh clip skips straight to bone; a
   *  model missing both just holds whatever frame it ended on. */
  private enterDecay(c: { instance: Instance; anims: AnimSet; phase: CorpsePhase; phaseT: number }, stage: "flesh" | "bone"): void {
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
    // `Animnames` is a list of NAME TOKENS that together pick one clip, not a list of
    // alternatives: `spell,slam` means the sequence called "Spell Slam", `spell,throw`
    // "Spell Throw", `spell,two` "Spell Two". Matching on the last token alone — which is
    // what this did — hands `spell,slam` the Warden's "Attack Slam" instead, so Fan of
    // Knives made her swing her glaives. So: require EVERY token, then fall back by
    // dropping tokens from the right, then to a plain "Spell".
    //
    // Dropping from the RIGHT is the engine's own rule, not a guess — and the Dreadlord is
    // the witness, because he is the case where it costs something. `[AUcs] Animnames =
    // attack,slam` and HeroDreadLord.mdx authors
    //
    //     Stand · Stand Ready · Stand - 2 · Stand - 3 · Spell · Walk
    //     Spell Slam · Death · Dissipate · Attack - 1 · Attack - 2
    //
    // — no "Attack Slam" anywhere, but a "Spell Slam" sitting right there that keeps the
    // `slam` and looks far more like a spell. The real client plays "Attack - 1" (observed
    // 2026-08-24). So the engine narrows the list left-to-right and takes what survives; it
    // does NOT score the tokens across the whole set and let a later word outvote the first.
    // That settles the whole family of rows whose caster has no clip for their full list —
    // Shock Wave on the Naga heroes, Death and Decay's `stand,channel`, and ~60 others.
    const tags = (def?.animNames ?? []).filter((t) => !ANIM_MODIFIERS.has(t));
    const names = e.anims.seqNames;
    const pick = (re: RegExp) => names.findIndex((n) => re.test(n));
    // `looping` in an Animnames list is the OTHER half of the same fact the sim's `loop` flag
    // carries: the gesture is held and repeated for the cast rather than played once. Healing
    // Spray is the row that needs it said here — `[ANhs] Animnames = spell,looping` while the
    // ability is not a channel (the Alchemist is free to walk off mid-spray, so it is not in
    // CHANNELED and the sim sends `loop = false`), and HeroGoblinAlchemist.mdx authors that
    // held pose as "Spell Channel", 2.0s and flagged looping, alongside a one-shot "Attack two
    // Spell - New" for his throws. Matching on the tag alone found the throw.
    const loops = loop || (def?.animNames ?? []).includes("looping");
    // What LOOPING looks like was confirmed in the original game (observed 2026-08-24): the
    // clip simply repeats for as long as the channel runs. There is no special "wind up, hold,
    // release" structure to model — one clip, looped, for the duration, which is what `hold`
    // (wind-up + channel, sized by the sim) and SequenceLoopMode.Loop below already do.
    //
    // Which clip depends on whether the caster's model author wrote one for it, and the data
    // splits cleanly down that line across all 47 looping/channelled caster pairs:
    //   • a dedicated channel clip, where one exists — the Archmage and Antonidas hold "Stand
    //     Channel" through Blizzard, the Lich through Death and Decay, the Shadow Hunter
    //     through Big Bad Voodoo, the Alchemist and Blood Mage "Spell Channel";
    //   • else the plain "Spell", looped — the Far Seer and Thrall through Earthquake, the
    //     Beastmaster through Stampede, the Priestess through Starfall, Varimathras through
    //     Rain of Fire. These are the rows the best-match rule rescued: "Spell Chain
    //     Lightning" and "Spell Slam" also contain the word `spell` and were being taken first.
    /**
     * The clip that BEST matches a token list: every requested token present, and among
     * those the one carrying the fewest EXTRA words.
     *
     * Best, not first — that is the whole point, and matching on "does the name contain
     * these words" and taking the first hit is what went wrong twice over. HeroWarden.mdx
     * lists "Spell Slam" (6) before "Spell" (7), so a request narrowed to `spell` took the
     * Fan of Knives slam; the Far Seer's Earthquake (`spell,looping`) took "Spell Chain
     * Lightning"; the Beastmaster's Stampede took "Spell Slam". Scoring by the leftovers
     * gives all three the plain "Spell" they asked for, and leaves an exact request alone —
     * `spell,slam` still finds "Spell Slam" whatever else the model authors.
     *
     * A trailing numeric variant is not an extra word: WC3 writes the alternates of ONE clip
     * as "Attack - 1" / "Spell - 2", and the number is which take, not a different gesture.
     *
     * Two whole classes of clip are never a legitimate answer unless they were asked for by
     * name. A `swim` clip is a state we never enter (water is unwalkable — the rest of the
     * animation code excludes them outright, see unitAnims; only playCastAnim did not, so a
     * Sea Giant's Carrion Swarm swung an "Attack Swim"). And a `channel` clip belongs to a
     * cast that is HELD: `loops` already reaches for one first when the ability is one, so
     * for anything else it is the wrong pose by construction.
     */
    const words = (n: string) => n.toLowerCase().split(/[\s\-_]+/).filter((t) => t && !/^\d+$/.test(t));
    const wordLists = names.map(words);
    const best = (want: string[]): number => {
      if (!want.length) return -1;
      let bestIdx = -1;
      let fewest = Infinity;
      for (let i = 0; i < wordLists.length; i++) {
        const w = wordLists[i];
        if (!want.every((t) => w.includes(t))) continue;
        if (w.includes("swim") && !want.includes("swim")) continue;
        if (!loops && w.includes("channel") && !want.includes("channel")) continue;
        const extra = w.length - want.length;
        if (extra < fewest) {
          fewest = extra;
          bestIdx = i;
        }
      }
      return bestIdx;
    };
    let seq = -1;
    // A looping/channelled cast prefers a dedicated "channel" clip (Blizzard, Starfall,
    // Healing Spray). Under the alternate half of a two-form model the lookup needs no help:
    // applyAnimProps has already renamed "Spell Channel Alternate" to a plain "spell channel"
    // and blanked the walking form's, so a raging Alchemist sprays from his ogre body.
    if (loops) seq = pick(/channel/i);
    for (let n = tags.length; seq < 0 && n > 0; n--) seq = best(tags.slice(0, n));
    // …else the plain "Spell" clip, which is what a row with NO `Animnames` means — Shadow
    // Strike and Vengeance are both bare rows in NightElfAbilityFunc.txt. Asked for as a
    // token so the same best-match rule applies: the Warden has a clip called exactly
    // "Spell" and that is the one she should cast with.
    if (seq < 0) seq = best(["spell"]);
    // …and only then loosely, for a model whose spell clips are ALL compound and so match no
    // token cleanly — the Priest's "Spell Attack", the Spirit Walker's "Spell Morph", the
    // Sea Elemental's "blaSpell".
    if (seq < 0) seq = pick(/spell/i);
    // …and last, the ability's own named clip for the handful whose AbilityFunc row carries
    // no Animnames at all yet whose caster has a dedicated animation waiting (see
    // CAST_ANIM_FALLBACK). Bladestorm is the one that matters: `[AOww]` names nothing, the
    // Blademaster's model has no "Spell" clip either (Stand*/Attack/Attack Slam/Walk/Death/
    // Dissipate/**Attack Walk Stand Spin**), so the whole ultimate used to play standing
    // still — the spin IS the ability.
    if (seq < 0 && CAST_ANIM_FALLBACK[code]) seq = pick(CAST_ANIM_FALLBACK[code]);
    // No Animnames and no Spell clip on the model → the caster simply stands. This used to
    // fall back to the ATTACK animation, which is not something WC3 does: the engine plays
    // the clip Animnames asks for, else "Spell", else nothing. The Blademaster has no Spell
    // clip at all (Stand/Attack/Walk/Death/Dissipate), so Mirror Image — which declares no
    // Animnames either — had him swing his sword to conjure his images.
    if (seq < 0) return;
    e.unit.instance.setSequence(seq);
    e.unit.instance.setSequenceLoopMode(loops ? SequenceLoopMode.Loop : SequenceLoopMode.ModelDefined);
    e.curSeq = seq;
    e.unit.state = WidgetState.WALK; // don't let the idle picker immediately override the cast
    e.castAnimT = hold > 0 ? hold : CAST_ANIM_HOLD; // hold the clip for the whole cast
    e.castAnimSticky = ANIM_FOR_DURATION.has(code); // …and Bladestorm keeps it past the cast
    // A LOOPING gesture keeps it past the cast too, but yields to a walk. The sim has already
    // sized `hold` to the effect it accompanies — Healing Spray's 3/4/5 seconds of falling
    // bottles — so the Alchemist sprays for the whole spray instead of a third of one clip.
    e.castAnimHeld = loops;
  }

  private abilityDefByCode(code: string): AbilityDef | undefined {
    for (const a of this.abilities.all()) if (a.code === code) return a;
    return undefined;
  }

  /** The model file a unit is currently DRAWN with. A morph that lands on the same file
   *  wants `retype`, not `remodel` — see the note on retype. */
  renderedModelPath(simId: number): string {
    return this.byId.get(simId)?.modelPath ?? "";
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

  /**
   * The Acolyte's SUMMONING gesture: its one work pose, played once over the structure it has
   * just laid down, and then done with.
   *
   * Once, not looped, and that is the shape of the whole race. Every other worker STAYS —
   * a Peasant hammers, a Peon is inside — so its work clip runs for as long as the job does
   * and the ordinary picker can drive it off `constructing`. An Acolyte hands the structure
   * its own clock and walks away the same instant (SimWorld.assignBuilder, `selfBuilds`), so
   * by the time the picker is next asked there is no job left to read: the gesture has to be
   * fired here, at the moment it happens, and sized to the clip rather than to a job.
   *
   * `Acolyte.mdx` authors no "Stand Work" — "Stand Work Gold" is its only working pose, and
   * WC3 plays that same kneel for all three of the things an Acolyte does with its hands
   * (mine, repair, summon). Held by `castAnimHeld`, so it plays out where the Acolyte stands
   * and breaks the instant the player walks it off, which is what the original shows.
   */
  playWorkAnimOnce(simId: number): void {
    const e = this.byId.get(simId);
    const seq = e?.anims.standWorkGold ?? -1;
    if (!e || seq < 0) return;
    e.curSeq = seq;
    e.unit.state = WidgetState.WALK; // keep the idle picker off it
    e.unit.instance.setSequence(seq);
    e.unit.instance.setSequenceLoopMode(SequenceLoopMode.ModelDefined); // play once, hold the last frame
    e.castAnimT = seqDuration(e.unit.instance, seq, CAST_ANIM_HOLD);
    e.castAnimSticky = false;
    e.castAnimHeld = true; // hold while it stands there; a walk order drops it at once
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
        // Already in the group → toggle it out. Otherwise add own mobile units.
        // A shift-click on anything else (enemy/neutral/building) is ignored so a
        // stray click never wipes the current selection.
        if (this.selected.has(id)) this.deselect(id);
        else if (ownMobile) {
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
      // A double-click (or a Ctrl-click) REBUILDS the selection — WC3 clears it and selects
      // the type group afresh, even when that group is the one unit you were already
      // holding. That rebuild is what raises a second EVENT_PLAYER_UNIT_SELECTED on a unit
      // already selected, and a whole genre of custom map is written on it: Extreme Candy
      // War's hero picker shows the costume's description on the first click and hands you
      // the hero on the second (`Pick Heroes`, war3map.j — the two clicks are two selection
      // events on the same unit). A plain re-click is NOT a rebuild and raises nothing.
      if (mods.sameType && this.selected.has(id)) this.reselected.push(id);
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
    // A same-type grab REPLACES the selection, so a unit that was in it and is in it again
    // has been deselected and reselected — the second selection event a double-click owes
    // the script (see selectAt).
    if (!additive) {
      for (const sid of picked) if (this.selected.has(sid)) this.reselected.push(sid);
      this.selected.clear();
    }
    for (const sid of picked) this.selected.add(sid);
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
    for (const id of picked) this.selected.add(id); // no cap (issue #109)
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
  orderMode: "move" | "attack" | "patrol" | "rally" | "repair" | "harvest" | "cast" | "item" | "selectuser" | "load" | null = null;
  /** The shop awaiting a purchaser pick when orderMode === "selectuser" (WC3's "Select
   *  Hero"/"Select Unit"). Unlike every other armed order this one belongs to a building
   *  the player may not even own — a neutral Goblin Merchant — so it carries the shop's id
   *  rather than acting on the selection. */
  armedShopUser: { shopId: number } | null = null;
  /** The cargo hold awaiting a passenger pick when orderMode === "load" — the Entangled Gold
   *  Mine's `Aenc` Load button. Like the shop pick above and unlike every other armed order,
   *  the SELECTION is the thing being ordered TO and the click names the unit that acts. */
  armedLoad: { hostId: number } | null = null;
  /** The spell armed for targeting when orderMode === "cast". `area` (>0) shows an
   *  AoE cast circle at the cursor for point-target area spells. */
  armedCast: { code: string; target: "unit" | "point"; area?: number } | null = null;
  /** The inventory item armed for targeting when orderMode === "item": a point-use
   *  item (blink) awaiting a ground click, a unit-use item (the staves) awaiting a unit,
   *  or a passive item awaiting a drop/give target (ground → drop, allied hero → give). */
  armedItem: { slot: number; mode: "usepoint" | "useunit" | "move" } | null = null;

  /** Called when an order is refused, with a commandstrings.txt [Errors] key — the host
   *  (render/mapViewer.ts) turns it into the gold line above the console and the error
   *  sound. Set by the host; the sim itself has no UI. */
  onRefuse?: (errorKey: string) => void;

  /** Execute the armed order at a screen point. Returns true when consumed
   *  (the caller should then clear the HUD's armed state); false leaves it armed —
   *  either nothing was armed, or the order was REFUSED and the player gets to
   *  click again without re-arming the spell. */
  /** Arm the Entangled Gold Mine's Load pick. False if the hold is gone or already full,
   *  which is the button's own greying-out asked again at the press. */
  armLoad(hostId: number): boolean {
    const b = this.sim.units.get(hostId);
    if (!b || b.garrisonCap === 0 || b.garrison.length >= b.garrisonCap) return false;
    if (!this.controls(hostId)) return false;
    this.orderMode = "load";
    this.armedLoad = { hostId };
    return true;
  }

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
    // Loading a cargo hold reads the same way round as the shop pick above — the SELECTION is
    // the mine and the click names the wisp — so it is answered before the "do I control the
    // selection" gate, and a refused pick keeps the order armed for another click.
    if (this.orderMode === "load") {
      const hostId = this.armedLoad?.hostId;
      if (hostId === undefined) {
        this.orderMode = null;
        return true;
      }
      const picked = this.pickAt(cssX, cssY);
      const p = picked === null ? undefined : this.sim.units.get(picked);
      // "Must target a Peon." — commandstrings.txt [Errors] Targetbunkerunit, which is the
      // line the Orc Burrow's own Load already refuses with. Same hold, same answer.
      if (!p || picked === null || !this.controls(picked) || !p.worker) return this.refuseOrder("Targetbunkerunit");
      if (!this.execute(this.localPlayer, { c: "garrison", unitId: picked, buildingId: hostId })) return this.refuseOrder("Targetbunkerunit");
      this.orderMode = null;
      this.armedLoad = null;
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
        this.castFromSelection(cast.code, picked!, 0, 0, queued);
        return true;
      }
      const hit = this.groundHitAt(cssX, cssY); // point-target spell
      if (!hit) return this.refuseOrder("Canttargetloc"); // "Unable to target there."
      // The POINT goes with the question: a refusal can depend on what is at the spot you
      // clicked, not just on the caster (an Ancestral Spirit aimed where nobody fell answers
      // "There are no corpses of friendly units nearby."). Every other point spell ignores it.
      const err = this.castRefusal(cast.code, 0, hit[0], hit[1]);
      if (err !== null) return this.refuseOrder(err);
      this.orderMode = null;
      this.armedCast = null;
      this.castFromSelection(cast.code, 0, hit[0], hit[1], queued);
      return true;
    }
    // An aimed ITEM refuses like a cast: a staff pointed at the wrong thing leaves the order
    // armed and says why, rather than eating the click. Checked before orderMode is torn
    // down, for the same reason the cast branch above is — a refusal must leave the reticle
    // exactly where it was, and the reticle is derived from these two fields each frame.
    //
    // Arming already refused a cooling-down item, but a SHARED cooldown group can start one
    // in between (drinking a potion cools every potion), so both aimed modes re-check here.
    const aimedItem = mode === "item" && this.armedItem?.mode !== "move" ? this.armedItem : null;
    if (aimedItem) {
      const id = this.primary;
      if (id === null || !this.controls(id)) {
        this.orderMode = null;
        this.armedItem = null;
        return true;
      }
      const point = aimedItem.mode === "usepoint";
      const picked = point ? null : this.pickAt(cssX, cssY);
      const err = point
        ? this.sim.itemReadyError(id, aimedItem.slot)
        : this.sim.itemUseError(id, aimedItem.slot, picked ?? 0);
      if (err !== null) return this.refuseOrder(err);
      const hit = point ? this.groundHitAt(cssX, cssY) : null;
      if (point && !hit) return this.refuseOrder("Canttargetloc"); // "Unable to target there."
      // …and the unplayable black is a spot the ray CAN hit and the map still has no room in
      // (issue #117). Same line the spells get — a Dagger of Escape aimed past the edge is
      // "Targeted location is outside of the map boundary.", and keeps its charge.
      if (hit && !this.sim.inPlayableArea(hit[0], hit[1])) return this.refuseOrder("Outofbounds");
      this.orderMode = null;
      this.armedItem = null;
      this.execute(this.localPlayer, {
        c: "useitem", unitId: id, slot: aimedItem.slot, targetId: picked ?? 0,
        x: hit?.[0] ?? 0, y: hit?.[1] ?? 0,
      });
      return true;
    }
    // An aimed ATTACK at a THING refuses like a cast, and for the same reason: a tower cannot
    // walk to what you point it at, so a target outside its weapon range is an order it can
    // never carry out. WC3 answers with [Errors] `Notinrange` — "Target is outside range." —
    // and does NOT spend the click: nothing is ordered, no acknowledgement is voiced, and the
    // reticle stays up for another try (the reticle is derived from `orderMode` each frame,
    // which is why this has to run BEFORE the teardown and the ack below).
    //
    // Only when NOBODY took it. A mixed selection that got the order away — the Footmen in it
    // can walk — is an order given, and the tower that couldn't is not worth a line.
    if (mode === "attack") {
      const picked = this.pickAt(cssX, cssY);
      const prim = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
      const target = picked !== null && picked !== this.primary ? this.sim.units.get(picked) : undefined;
      if (target && prim && picked !== null) {
        // The Attack command FORCE-attacks whatever is under the cursor — including
        // friendly/own units and buildings (WC3 force attack).
        let any = false;
        for (const id of this.selected) if (id !== picked && this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: picked, force: true, solo: this.soloOrder(picked) }, queued: queued })) any = true;
        if (any) {
          this.orderMode = null;
          this.ack(true);
          this.flashAttack(target.x, target.y, this.byId.get(picked)?.selRadius ?? target.radius, this.byId.get(picked)?.moveHeight ?? 0);
          return true;
        }
        if (this.refuseAttackTarget(picked, true)) return false; // a tower pointed past its range, or an invulnerable target
      }
      // Nothing under the cursor: fall through to the attack-MOVE on the ground point below.
    }
    this.orderMode = null;
    if (mode === "item") {
      const armed = this.armedItem;
      this.armedItem = null;
      const id = this.primary;
      if (!armed || id === null || !this.controls(id)) return true;
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
    if (mode === "harvest") {
      this.harvestAt(cssX, cssY, queued);
      return true;
    }
    if (mode === "move") {
      // A Move command AIMED AT A UNIT OR BUILDING means "go to THAT thing", so its
      // destination is the target's CENTRE — not wherever the click ray happens to meet the
      // terrain. Those two are not the same point: a model is drawn standing up the screen
      // from the ground it occupies, so clicking a barracks near its roof puts the ground
      // hit a couple of hundred units BEHIND it while clicking near its doorstep puts it in
      // front. The group was being sent to a different place depending on which part of the
      // same building was clicked. Aiming at the centre also gets the whole formation
      // packing in around the target, which is what a surround is.
      //
      // And no ground arrow: the arrow marks a spot on the terrain, and this order does not
      // name one. Feedback is the target's own ring flashing, exactly as a right-click on it
      // gives — green for our own, yellow for anyone else's (the colours the ring already
      // uses), sized to the footprint for a building and to the constant unit ring
      // otherwise, and lifted to a flyer's altitude so it hugs the model.
      const picked = this.pickAt(cssX, cssY);
      const target = picked !== null ? this.sim.units.get(picked) : undefined;
      if (target && picked !== null) {
        const e = this.byId.get(picked);
        const prim = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
        const own = !!prim && target.owner === prim.owner;
        this.groupMoveTo(target, picked, queued);
        this.flashRing(target.x, target.y, e?.selRadius ?? target.radius, own ? FLASH_GREEN : FLASH_YELLOW, !!target.building, e?.moveHeight ?? 0);
        return true;
      }
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
    // Every arrow here is gated on the order having been TAKEN by somebody. A ground marker is
    // a promise that something is on its way to that spot, and a selection with nothing in it
    // that can walk — a tower, a rooted Ancient — must not leave one behind (issueMove /
    // issueAttackMove / issuePatrol all refuse outright for a unit that cannot pursue).
    if (mode === "patrol") {
      let any = false;
      for (const id of this.selected) if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "patrol", x: wx, y: wy }, queued: queued })) any = true;
      if (any) this.queueArrow(wx, wy, MOVE_ARROW);
    } else if (mode === "attack") {
      // distinct formation slot per unit (like move)
      if (this.groupAttackMove(wx, wy, queued)) this.queueArrow(wx, wy, ATTACK_ARROW); // red a-move feedback
    } else {
      if (this.groupMove(wx, wy, queued)) this.queueArrow(wx, wy, MOVE_ARROW); // spread the group into a formation
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
      this.armedLoad = null;
      return "ordered";
    }
    if (!this.selected.size || !this.hasControllable()) {
      if (mode) {
        this.orderMode = null;
        this.armedCast = null;
        this.armedItem = null;
        this.armedLoad = null;
        return "ordered";
      }
      return "none";
    }
    // A spell, an item, a repair, a GATHER or a shop's purchaser pick is aimed at a thing in
    // the WORLD, never at the minimap — swallow the click and leave it armed (right-click,
    // above, is how you back out of one). A tree or a mine on the minimap is a pixel, not a
    // node, and there is no picking either of them out of it.
    if (mode === "cast" || mode === "item" || mode === "repair" || mode === "harvest" || mode === "selectuser" || mode === "load") return "ignored";
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
    if (this.groupMove(wx, wy, queued)) this.queueArrow(wx, wy, MOVE_ARROW);
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
   *  the whole selection — e.g. two priests both Dispel). `queued` (Shift held) appends the
   *  cast to each unit's order queue instead of interrupting what it is doing. */
  private castFromSelection(code: string, targetId: number, x: number, y: number, queued = false): void {
    let any = false;
    for (const id of this.selected) {
      if (this.execute(this.localPlayer, { c: "cast", unitId: id, code, targetId, x, y, queued })) any = true;
    }
    if (any) this.ack(false);
  }

  /** Can ANY unit in the selection cast this at that target? Returns null when one can,
   *  else why the best-placed one can't — with a whole group selected WC3 reports a single
   *  reason, and the one that gets furthest through the checks is the informative one
   *  ("Not enough mana." beats "Must target an enemy unit." from a unit that lacks the
   *  spell entirely). CAST_ERROR_RANK orders them; the last is the most specific. */
  private castRefusal(code: string, targetId: number, x = 0, y = 0): string | null {
    return this.bestRefusal((id) => this.sim.castError(id, code, targetId, x, y));
  }

  /** The same question one step earlier: can ANY unit in the selection USE this ability at
   *  all — spell known, not silenced, off cooldown, mana paid — with no target chosen yet
   *  (SimWorld.castUseError). */
  private castUseRefusal(code: string): string | null {
    return this.bestRefusal((id) => this.sim.castUseError(id, code));
  }

  /** Reduce a per-unit refusal over the selection to the ONE reason to say out loud. */
  private bestRefusal(errorOf: (unitId: number) => string | null): string | null {
    let worst: string | null = null;
    let worstRank = -1;
    for (const id of this.selected) {
      if (this.sim.units.get(id)?.owner !== this.localPlayer) continue;
      const err = errorOf(id);
      if (err === null) return null; // someone can cast — the order stands
      const rank = castErrorRank(err);
      if (rank >= worstRank) {
        worstRank = rank;
        worst = err;
      }
    }
    return worst;
  }

  /** Arm a target-taking spell: the reticle goes up and the NEXT click aims it.
   *
   *  Unless the press itself is refusable. WC3 does not hand you a reticle for a spell the
   *  caster can't cast — press Storm Bolt with no mana and you get "Not enough mana." right
   *  there, with the cursor left alone; you never get to pick a target for a cast that was
   *  never going to leave the ground (issue #110). Warsmash keeps the same gate at the same
   *  place (`MeleeUI.onClick` enters targeting mode only `if (isUseOk())`).
   *
   *  Returns true when the spell is armed and the HUD should show it. */
  armCast(code: string, target: "unit" | "point", area = 0): boolean {
    const err = this.castUseRefusal(code);
    if (err !== null) {
      this.refuseOrder(err);
      return false;
    }
    // Some point spells arm with NO aiming area at all: a directional wave's `Area` is its
    // width at the caster rather than a circle at the cursor, and Far Sight's is a radius of
    // REVEALED MAP that catches no units (NO_AOE_CURSOR says which, and why). Zeroing it
    // here is the single gate for every piece of AoE aiming feedback — the SpellAreaOfEffect
    // splat, the green target tint and the tree highlight all key off `armedCast.area` — and
    // matches the real client, which shows a bare cursor for these.
    this.armedCast = { code, target, area: NO_AOE_CURSOR.has(code) ? 0 : area };
    this.orderMode = "cast";
    return true;
  }

  /** Refuse the armed order: tell the player why and LEAVE IT ARMED. WC3 doesn't spend
   *  your click on a target it won't accept — the reticle stays up so the next click can
   *  aim properly, and only Escape/right-click disarms. */
  private refuseOrder(errorKey: string): boolean {
    this.onRefuse?.(errorKey);
    return false;
  }

  /** Say why an attack order nobody took was refused, when the sim has a line for it. Two
   *  exist: the TOWER's — it cannot walk to what you pointed at, so a target outside its range
   *  answers "Target is outside range." rather than eating the click — and the INVULNERABLE
   *  target's, which only a deliberate Attack command hears (`commanded`; see attackRefusal).
   *  Only consulted once the order has already failed for everyone, so a mixed selection that
   *  DID attack never hears it. Returns whether something was said. */
  private refuseAttackTarget(targetId: number, commanded = false): boolean {
    for (const id of this.selected) {
      const err = this.sim.attackRefusal(id, targetId, commanded);
      if (err) {
        this.refuseOrder(err);
        return true;
      }
    }
    return false;
  }

  /** Cast a no-target ability (Thunder Clap, Divine Shield, Avatar) immediately.
   *
   *  There is no target click coming, so THIS click is the cast and the refusal belongs
   *  here — the armed path already asks `castRefusal` before it spends the click, and this
   *  one never did: a Chemical Rage with no mana was silently eaten. The command card
   *  greys such a button rather than disabling it precisely because WC3 answers the press
   *  with "Not enough mana." (issue #98), so the answer has to actually arrive. */
  castNoTarget(code: string): void {
    const err = this.castRefusal(code, 0);
    if (err !== null) {
      this.refuseOrder(err);
      return;
    }
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
    // A cooling-down item is answered ON THE PRESS — both from the button and from its numpad
    // key, which funnel through here — with the game's own "This item is cooling down." and
    // the error sound. Nothing is armed: WC3 does not let you walk a targeting cursor around
    // for an item that was never going to fire, and the click you eventually spend on it
    // would only be thrown away.
    const notReady = this.sim.itemReadyError(id, slot);
    if (notReady !== null) {
      this.refuseOrder(notReady);
      return;
    }
    // How the item is AIMED is its ability's own `target` (KNOWN_ABILITIES): a point for
    // Kelen's Dagger, a unit for the staves, nothing at all for a potion — which is the
    // overwhelming majority and fires on this very click.
    const aim = def.abilities.map((aid) => this.abilities.get(aid)?.target).find((t) => t === "point" || t === "unit");
    // DOUBLE-CLICK — a second press of an item that is already armed fires it on the user
    // rather than waiting for a target. Reached from the button and from the numpad hotkey
    // alike, because both funnel through here, which is what makes it "double click OR press
    // the hotkey twice".
    //
    // The Scroll of Town Portal is what this is for, and Blizzard's own page says what it does:
    // *"You can also double click on the Town Portal Scroll which will automatically select the
    // highest (allied) Town Hall as a transport destination"* — and, more plainly, *"Don't
    // double click on your Town Portal unless you want to go back to your Hall."*
    // (classic.battle.net/war3/basics/townportalscrolls.shtml). `itemTownPortal` resolves to the
    // hall nearest the clicked point, so clicking the hero IS "your own nearest hall".
    //
    // A UNIT-aimed item self-casts instead, which is the same gesture doing the same thing; if
    // the item may not be aimed at its own bearer the sim says so and the cursor stays armed,
    // so nothing is spent on a click that was never going to fire.
    if (this.orderMode === "item" && this.armedItem?.slot === slot &&
        (this.armedItem.mode === "usepoint" || this.armedItem.mode === "useunit")) {
      const selfTarget = this.armedItem.mode === "useunit" ? id : 0;
      const err = this.sim.itemUseError(id, slot, selfTarget);
      if (err !== null) {
        this.refuseOrder(err);
        return;
      }
      this.armedItem = null;
      this.orderMode = null;
      this.execute(this.localPlayer, { c: "useitem", unitId: id, slot, targetId: selfTarget, x: u.x, y: u.y });
      return;
    }
    if (aim) {
      this.armedItem = { slot, mode: aim === "point" ? "usepoint" : "useunit" };
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
      attackType: AttackType.None, armorType: ArmorType.Unknown, attackUpgrade: -1, armorUpgrade: -1, isHero: false, isIllusion: false, properName: "", level: 0, xp: 0, xpThis: 0, xpNext: 0, skillPoints: 0, strength: 0,
      agility: 0, intelligence: 0, strengthBonus: 0, agilityBonus: 0, intelligenceBonus: 0, primaryAttr: PrimaryAttribute.None,
      model: def?.model ?? "", isWorker: false, isBuilding: false,
      underConstruction: false, buildProgress: 0, trainProgress: 0, secondsLeft: 0, queueLength: 0,
      queue: [], icon: def?.icon ?? "", builderId: 0, builderIcon: "", carryGold: 0, carryLumber: 0,
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
      attackType: AttackType.None, armorType: ArmorType.Unknown, attackUpgrade: -1, armorUpgrade: -1, isHero: false, isIllusion: false, properName: "", level: 0, xp: 0, xpThis: 0, xpNext: 0, skillPoints: 0, strength: 0,
      agility: 0, intelligence: 0, strengthBonus: 0, agilityBonus: 0, intelligenceBonus: 0, primaryAttr: PrimaryAttribute.None,
      model: def?.model ?? "", isWorker: false, isBuilding: false,
      underConstruction: false, buildProgress: 0, trainProgress: 0, secondsLeft: 0, queueLength: 0,
      queue: [], icon: def?.icon ?? "", builderId: 0, builderIcon: "", carryGold: 0, carryLumber: 0,
      isMine: true, goldRemaining: m.gold,
      isItem: false, description: "",
      isSummon: false, summonSecondsLeft: 0, summonFrac: 0, buffs: [],
    };
  }

  /**
   * The worker hidden INSIDE a structure that is going up, or 0.
   *
   * Only an Orc peon is ever in there — `buildsFromInside` in the sim is the race test, and
   * the point of asking here is exactly that: a peasant hammering away outside can be clicked
   * on the terrain, and a peon in the wall cannot be reached at all until the build ends. So
   * the panel of the thing it is inside carries its button.
   *
   * Read off the RENDER records rather than the building's `builderIds`, because a client is
   * drawing a snapshot and the snapshot carries the worker (its owner is still told about its
   * own off-field units) but not the site's builder list. Only ever asked for one selected
   * structure that is still under construction, so the walk is over entries once a frame.
   */
  private builderInside(buildingId: number): number {
    for (const e of this.entries) {
      const u = this.frameUnit(e.simId);
      // YOUR peon only. You may click an enemy's half-built structure, and the worker sealed
      // inside it is one of the things the fog is hiding — a button naming it would be telling
      // you a peon is in there and handing you a click on an off-field unit. (A client is
      // never sent it in the first place; the host has to refuse it here.)
      if (u?.insideBuild && u.constructing === buildingId && u.owner === this.localPlayer) return e.simId;
    }
    return 0;
  }

  /** Which of the info panel's two icons this unit TYPE carries an upgrade readout for — the
   *  corner box in the art and the 0/1/2/3 printed in it.
   *
   *  A box belongs to a unit that some `class = melee|ranged` (damage) or `class = armor`
   *  (armour) research REACHES, which in the stock game means a race's own trained units. It
   *  is read straight off the type's `upgrades` column in UnitBalance.slk: a Footman lists
   *  Rhme and Rhar and carries both boxes, a Guard Tower lists only Masonry and carries the
   *  armour box alone, and a Peasant (Rhlh, Rguv), a Wisp (Reuv), a hero (Archmage: none), a
   *  creep and a gold mine list none of the three and carry neither.
   *
   *  A BUILDING has neither, even though Masonry (`Rhac`, class `armor`) reaches it and does
   *  raise its armour. The readout is a feature of the UNIT panel and of no other: the game
   *  draws a building with `InfoPanelBuildingDetail.fdf`, whose whole contents are a name, a
   *  description, an armour label/value, supply, the build timer and the queue backdrop —
   *  there is not one `IconBackdrop`/`IconValue` pair in the file, while `InfoPanelUnitDetail`
   *  has four. A building's armour icon is ours to begin with; the corner number is not.
   *
   *  Answered here rather than sent per-unit in the snapshot because it is unit-TYPE data that
   *  both sides already hold — unlike the LEVEL, which is the owner's research and rides on
   *  the unit so that clicking an enemy still scouts it. Cached: fixed per type, asked every
   *  frame the panel draws. */
  private upgradeBoxCache = new Map<string, { attack: boolean; armor: boolean }>();
  private upgradeBoxes(typeId: string): { attack: boolean; armor: boolean } {
    const hit = this.upgradeBoxCache.get(typeId);
    if (hit) return hit;
    const boxes = { attack: false, armor: false };
    const def = this.registry.get(typeId);
    if (def?.isBuilding) {
      this.upgradeBoxCache.set(typeId, boxes);
      return boxes;
    }
    for (const upId of def?.upgradesUsed ?? []) {
      const cls = this.upgrades.get(upId)?.className;
      if (cls === "melee" || cls === "ranged") boxes.attack = true;
      else if (cls === "armor") boxes.armor = true;
    }
    this.upgradeBoxCache.set(typeId, boxes);
    return boxes;
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
    const upgradeBoxes = this.upgradeBoxes(e.typeId);
    const builderId = b && b.constructionLeft > 0 ? this.builderInside(e.simId) : 0;
    /**
     * May this viewer read the building's STATUS — what it is making, and how many seconds
     * are left on it?
     *
     * `Units\MiscGame.txt` answers it and names it: **`DisplayBuildingStatus=0`**, sitting
     * next to `DisplayEnemyInventory=1`, which is the same question about a hero's items
     * answered the other way. So an enemy's queue and its construction timer are not merely
     * something we forgot to hide — the game has a switch for them and it is off.
     *
     * Masked HERE, at the panel, rather than redacted on the wire, and the reason is that the
     * two facts are not equally secret: the SCAFFOLDING is public (you can see a half-built
     * Barracks from across the map, and the renderer drives that animation off the very same
     * `constructionLeft`), while the NUMBER under it is the owner's. Redacting the field would
     * take the visual with it. This is the one place either becomes a readout.
     *
     * `seesFor` is the ally gate rather than plain ownership: a team-mate's Barracks shows you
     * what it is training, which is what shared vision is for.
     */
    // (Widened: the constant is `as const` 0, so TypeScript would call the comparison dead.
    //  It is read rather than folded away because it is the game's switch, not our policy —
    //  a mod that turns it on turns this on.)
    const status = (MISC_GAME.DisplayBuildingStatus as number) !== 0 || this.seesFor(u.owner);
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
      // -1 = this type has no research of that class at all, so the panel draws the boxless
      // icon and prints nothing (see upgradeBoxes). A 0 means "researchable, not yet".
      attackUpgrade: upgradeBoxes.attack ? u.attackUpgrade : -1,
      armorUpgrade: upgradeBoxes.armor ? u.armorUpgrade : -1,
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
      underConstruction: status && !!b && b.constructionLeft > 0,
      buildProgress: status && b && b.buildTimeTotal > 0 ? 1 - b.constructionLeft / b.buildTimeTotal : 1,
      trainProgress: status && q.length && q[0].buildTime > 0 ? 1 - q[0].timeLeft / q[0].buildTime : 0,
      secondsLeft: !status ? 0 : b && b.constructionLeft > 0 ? b.constructionLeft : q.length ? q[0].timeLeft : 0,
      queueLength: status ? q.length : 0,
      // A queue slot may hold a unit, a research or a structure upgrade — pull each one's icon
      // from the registry that owns it. Research uses the icon of the LEVEL being researched
      // (Steel Forged Swords has its own art), which is why the level rides on the job.
      queue: (status ? q : []).map((j) => ({
        // `level` is optional on `RenderBuildJob` because only a research slot carries one;
        // the `?? 0` is unreachable for `kind === "research"` and is here so the flattened
        // shape needs no cast back to the union it came from.
        icon: (j.kind === "research" ? this.upgrades.icon(j.unitId, j.level ?? 0) : this.registry.get(j.unitId)?.icon) ?? "",
      })),
      icon: this.registry.get(e.typeId)?.icon ?? "",
      builderId,
      builderIcon: builderId ? (this.registry.get(this.byId.get(builderId)?.typeId ?? "")?.icon ?? "") : "",
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

  /** Active buffs/auras/debuffs on a unit, resolved to the icon + name + tooltip the info
   *  panel's **Status** line shows, in the order they landed.
   *
   *  One rule, and it is the data's: **a Status entry is a BUFF ROW with art.** The row is the
   *  buff's own, never the ability's — `Bfro` is what Slow, Frost Attack and every orb of frost
   *  hang, and its Bufftip is "Slowed", the state the unit is in, where the ability is called
   *  "Slow". Everything that applies a buff names its row (`SimBuff.buffId`, filled in by
   *  World.applySpellEffect for any handler that doesn't say otherwise), and the few states the
   *  engine itself owns rather than an ability fall back to its rows (KIND_BUFF_ROW).
   *
   *  A row with no `Buffart` is one the game does not put on the info card, and the data says
   *  so out loud — the drain's six caster/target rows are written `//Buffart=` under the
   *  comment "This buff isn't ever visible on the info card" (Units\HumanAbilityFunc.txt), and
   *  22 of the 188 rows are like that. Those are skipped, as are the buffs of abilities that
   *  define none at all (Avatar, Robo-Goblin: a morph is not a buff). Nothing else is invented
   *  to fill the gap — a row of icons with a placeholder in it is not a row of icons.
   *
   *  One WC3 buff is often several of ours — an Inner Fire is an armour buff AND a damage buff,
   *  a Slow Poison a dot AND a slow — so entries de-dupe on the row: one state, one icon. */
  private statusBuffsFor(u: RenderUnit): Array<{ icon: string; name: string; tip: string }> {
    if (!u.buffs.length) return [];
    const out: Array<{ icon: string; name: string; tip: string }> = [];
    const seen = new Set<string>();
    for (const b of u.buffs) {
      const row = this.abilities.buff(b.buffId || KIND_BUFF_ROW[b.kind] || "");
      if (!row?.icon || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ icon: row.icon, name: row.name, tip: this.tipText(row.tip) });
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

  /**
   * Which of the three selection-circle colours a unit wears, from the LOCAL player's seat —
   * see RingInfo.allegiance for the data. Green is what you OWN and nothing else: an ally's
   * unit is somebody else's, and WC3 rings it the same neutral yellow it rings a shop, a
   * critter or a gold mine with. (Everything hostile, creeps included, is red.)
   *
   * This was `owner === local || team === teamOf(local)` — green for the whole team, which is
   * indistinguishable from correct in a melee game you are playing alone and wrong the moment
   * anyone is allied to you. A campaign is the plain case: Terror of the Tides' chapter one
   * puts the Watchers, the Villagers and the Prisoners on your force, and every one of them
   * lit up green as though you had built it.
   */
  private ringAllegiance(u: { owner: number; neutralPassive: boolean }): RingInfo["allegiance"] {
    if (u.owner === this.localPlayer) return "own";
    if (u.neutralPassive || this.sim.neutralPlayers.has(u.owner)) return "neutral";
    if (u.owner >= 0 && this.alliances.coAllied(u.owner, this.localPlayer)) return "neutral";
    return "enemy";
  }

  /** Ground-circle info for every selected unit (the renderer draws each ring as
   *  a flat model on the terrain so geometry occludes it). */
  selectionRings(): RingInfo[] {
    const out: RingInfo[] = [];
    for (const id of this.selected) {
      const u = this.frameUnit(id); // the ring sits under the MODEL, so it reads the model's record
      const e = this.byId.get(id);
      // Nothing to ring for a unit that is off the field — an Orc peon inside the structure it
      // is raising stays SELECTED (applyVisibility), and its parked-at-the-centre coordinates
      // are not a place it can be said to be standing.
      if (u && isOffField(u)) continue;
      // Buildings get a ring sized to their footprint (a constant tiny ring is
      // hidden under the model); units keep the constant ring. Neutral Passive
      // entities ring yellow.
      // Air units' ring floats at their flight altitude (e.moveHeight matches the
      // model's drawn base), so it hugs the unit instead of sitting on the ground.
      if (u && e) out.push({ x: u.x, y: u.y, z: this.heightAt(u.x, u.y) + e.moveHeight, radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building, allegiance: this.ringAllegiance(u), isBuilding: !!u.building });
    }
    if (this.selectedMine !== null) {
      const m = this.sim.mines.get(this.selectedMine);
      // A gold mine is Neutral PASSIVE (yellow ring), not hostile (red).
      if (m) out.push({ x: m.x, y: m.y, z: this.heightAt(m.x, m.y), radius: m.radius * MINE_RING_SCALE, owner: -1, team: -2, sizeToRadius: true, allegiance: "neutral" });
    }
    if (this.selectedItem !== null) {
      const it = this.sim.items.get(this.selectedItem);
      // A ground item rings yellow (neutral), like a mine — sized to the item.
      if (it) out.push({ x: it.x, y: it.y, z: this.heightAt(it.x, it.y), radius: ITEM_RING_RADIUS, owner: -1, team: -2, sizeToRadius: true, allegiance: "neutral" });
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
      if (u && e) out.push({ x: u.x, y: u.y, z: this.heightAt(u.x, u.y) + e.moveHeight, radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building, allegiance: this.ringAllegiance(u), isBuilding: !!u.building });
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
      if (u && e) return { x: u.x, y: u.y, z: this.heightAt(u.x, u.y) + e.moveHeight, radius: e.selRadius, owner: u.owner, team: u.team, sizeToRadius: !!u.building, allegiance: this.ringAllegiance(u), isBuilding: !!u.building };
    }
    if (this.hoveredMine !== null && this.hoveredMine !== this.selectedMine) {
      const m = this.sim.mines.get(this.hoveredMine);
      if (m) return { x: m.x, y: m.y, z: this.heightAt(m.x, m.y), radius: m.radius * MINE_RING_SCALE, owner: -1, team: -2, sizeToRadius: true, allegiance: "neutral" };
    }
    if (this.hoveredItem !== null && this.hoveredItem !== this.selectedItem) {
      const it = this.sim.items.get(this.hoveredItem);
      if (it) return { x: it.x, y: it.y, z: this.heightAt(it.x, it.y), radius: ITEM_RING_RADIUS, owner: -1, team: -2, sizeToRadius: true, allegiance: "neutral" };
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

  /**
   * The Birth clip of the tier this building is upgrading INTO, resolved against the body
   * already standing here.
   *
   * A tiered building is one model carrying every tier as sequences (HumanTower.mdx is the
   * Scout, Guard, Cannon AND Arcane towers; uzg1/uzg2 share the Ziggurat's), and which clips
   * a tier may see is decided by its `Animprops` — so the target's birth is a clip this
   * instance already has, just named with the target's tier tokens ("Birth Upgrade First").
   * Reading it through findBirthFields with the TARGET's props is the whole trick.
   *
   * A pair that genuinely changes model file has nothing here to play, and says so with -1:
   * there is no new body until the morph lands, so it keeps the old "queue is busy" pose.
   */
  private upgradeBirthFor(e: Entry, toTypeId: string): { seq: number; start: number; end: number } {
    if (e.upgradeBirth?.toTypeId === toTypeId) return e.upgradeBirth;
    const def = this.registry.get(toTypeId);
    const f =
      def && def.model === e.modelPath
        ? findBirthFields(e.unit.instance.model.sequences, def.animProps)
        : { birthSeq: -1, birthStart: 0, birthEnd: 0 };
    e.upgradeBirth = { toTypeId, seq: f.birthSeq, start: f.birthStart, end: f.birthEnd };
    return e.upgradeBirth;
  }

  /** Re-pin under-construction buildings' Birth frame to construction progress
   *  AFTER the renderer's animation update — otherwise mdx-m3-viewer's per-frame
   *  frame advance creeps the birth forward, so a HALTED construction still
   *  looked like it was building. Called each frame post-update; this makes the
   *  birth freeze when paused and resume exactly with progress. A tier upgrade is
   *  scrubbed the same way, and creeps the same way if it isn't re-pinned here. */
  repinConstructionFrames(): void {
    for (const e of this.entries) {
      // The SAME record the entry sync scrubbed this frame (item 10c-2c-4). Reading the sim
      // here while the sync read the snapshot would set the birth frame twice per frame from
      // two different progresses — a building that visibly stutters between two states of
      // construction on a client, and only on a client.
      const u = this.frameUnit(e.simId);
      if (!u?.building) continue;
      if (u.building.constructionLeft > 0) {
        if (e.birthSeq < 0) continue;
        const prog = 1 - u.building.constructionLeft / u.building.buildTimeTotal;
        e.unit.instance.frame = e.birthStart + prog * (e.birthEnd - e.birthStart);
        continue;
      }
      const job = u.building.queue[0];
      if (job?.kind !== "upgrade") continue;
      const b = this.upgradeBirthFor(e, job.unitId);
      if (b.seq >= 0) e.unit.instance.frame = b.start + upgradeProgress(job) * (b.end - b.start);
    }
  }

  /** Rally point of the primary selected UNIT-PRODUCING building (for the rally
   *  flag), or null. Towers/farms/etc. don't produce units, so no rally. */
  selectedRally(): { x: number; y: number; z: number; owner: number } | null {
    if (this.primary === null) return null;
    const bu = this.sim.units.get(this.primary);
    if (!bu) return null;
    const b = bu.building;
    if (!b || !this.sim.acceptsRally(this.primary)) return null; // …and an uprooted Ancient has none
    if (b.rallyKind === "none") return null; // nothing planted yet — WC3 shows no flag until you set one
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
    // The flag carries a team-colour slot (the rally-flag models' texture replaceableId 1 —
    // human, orc and night elf; the undead banner is bone and has none), so it must be
    // tinted with the OWNING player's colour — not left on the default slot 0, which is
    // red (issue #86).
    //
    // …and it is LIFTED when it is planted ON something. A flag stands on the ground, which
    // is the right answer for a point rally and the wrong one for a target: on a tree it is
    // inside the trunk, on a building inside the wall, and from most camera angles it is not
    // there at all. See rallyLift for how far — enough to clear the base, not enough to
    // become a landmark of its own.
    return { x, y, z: this.heightAt(x, y) + this.rallyLift(b.rallyKind, b.rallyTargetId), owner: bu.owner };
  }

  /** How far a rally flag stands off the ground, by what it was planted on. A plain point
   *  rally is flat on the terrain, as it should be; everything else is a flag ON a thing.
   *  A tree gets the canopy lift its queue flag already uses, so the two agree; a mine or a
   *  building gets a shorter one that clears the base without floating. */
  private rallyLift(kind: RallyKind, targetId: number): number {
    if (kind === "tree") return TREE_FLAG_HEIGHT;
    if (kind === "mine") return RALLY_TARGET_LIFT;
    if (kind !== "unit") return 0;
    const t = this.sim.units.get(targetId);
    if (!t) return 0;
    // A rally on a flying unit rides at its altitude — the flag marks where the thing IS.
    if (!t.building) return this.byId.get(targetId)?.moveHeight ?? 0;
    return RALLY_TARGET_LIFT;
  }

  /** World positions of every SELECTED unit's shift-queued orders, for the small
   *  queue flags (rendered only while the owner is selected). A queued lumber
   *  harvest flags the tree top; other orders flag the ground point/target. */
  queueMarkers(): Array<{ x: number; y: number; z: number; owner: number }> {
    const out: Array<{ x: number; y: number; z: number; owner: number }> = [];
    for (const id of this.selected) {
      const u = this.sim.units.get(id);
      if (!u) continue;
      for (const o of u.orderQueue) {
        const m = this.markerFor(o);
        // Same flag model as the rally point, so the same team-colour rule applies:
        // it belongs to the unit that queued the order (issue #86).
        if (m) out.push({ ...m, owner: u.owner });
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
      case "returnresources":
        return null; // none of these has a destination/target to draw a marker for — the
        // depot a Return Goods walks to is picked at the moment it runs, not at the click
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
      case "drink": {
        const w = this.sim.units.get(o.wellId);
        return w ? { x: w.x, y: w.y, z: this.heightAt(w.x, w.y) } : null;
      }
      case "cast": {
        // Where the spell is aimed: the target's own position for a unit-target one, the point
        // for the rest. A self cast (no target, no point) marks nothing — there is nowhere to
        // put a flag for "and then Avatar".
        const t = o.targetId ? this.sim.units.get(o.targetId) : undefined;
        if (t) return { x: t.x, y: t.y, z: this.heightAt(t.x, t.y) };
        return o.x || o.y ? { x: o.x, y: o.y, z: this.heightAt(o.x, o.y) } : null;
      }
      case "rootat":
        return { x: o.x, y: o.y, z: this.heightAt(o.x, o.y) };
      case "entangleat": {
        const m = this.sim.mines.get(o.mineId);
        return m ? { x: m.x, y: m.y, z: this.heightAt(m.x, m.y) } : null;
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
    // Chat, both directions: on the host a client's request, already stamped with a real
    // sender; on a client the host's ruling that we were meant to hear this. Both end up at
    // the same renderer callback, which routes (host) or just shows it (client).
    link.onChatSaid = (line) => this.onChatSaid?.(line);
    // The pause, both ways round: on the host a player's request to judge, on a client the
    // ruling to obey. Neither is state this controller keeps — the pause belongs to the
    // renderer, which owns the world's clock — so both are passed straight through.
    link.onPauseAsked = (player, on) => this.onPauseAsked?.(player, on);
    link.onPauseRuled = (msg) => this.onPauseRuled?.(msg.on, msg.by, msg.left, msg.denied === true);
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
        // A refused remote command used to be invisible from the client's chair — its local
        // charge undone by the next snapshot, the queued job never echoing back: a silent
        // cancel with no voice ("training instantly canceled", twice reported). The client is
        // now TOLD, with the coarse cause the host can re-derive, and its HUD refuses in the
        // game's own words. The dev console still names the exact command for a bug report.
        if (!ok) {
          link.sendRefusal(from, this.refusalReason(judged.player, judged.cmd));
          if (import.meta.env.DEV) console.info(`[sync] host REFUSED p${judged.player} ${JSON.stringify(judged.cmd)}`);
        } else {
          // Owe the commanding client a snapshot NOW (item 9d): the cadence wait is half of
          // its order-to-motion latency, and the payload that carries the command's first
          // consequences is the one worth not sitting on.
          link.expedite(from);
        }
      };
    } else {
      // Client: the authority refused one of our commands — surface it through the same
      // refuse pathway a local refusal uses (the gold line + error sound).
      link.onRefusal = (msg) => this.onRefuse?.(msg.key);
    }
  }
  private matchLinkIsHost = false;

  /** A chat line arrived over the wire. The renderer fills this in; see mapViewer.deliverChat. */
  onChatSaid: ((line: ChatLine) => void) | null = null;

  /**
   * A line was said, and these are the players who HEARD it — the routing
   * `MapViewerScene.deliverChat` has already done, handed straight on rather than re-derived.
   *
   * The one way a computer takes anything in from outside its own eyes, and the recipient list
   * is what keeps that honest: a Computer+ player reads exactly the lines `chatRecipients`
   * addressed to it and nothing else, so "help" typed to your OTHER ally is a message this one
   * never saw (src/ai/plus/teamchat.ts). Authority-side only, like everything else the AI runs
   * on — `deliverChat` is not reached on a frozen client.
   */
  heardChat(line: ChatLine, heard: readonly number[]): void {
    this.computerPlus?.heard(line, heard);
  }

  /** HOST: a client asked for the match to stop or start again (already stamped with a real
   *  sender). The renderer rules on it — see mapViewer.rulePause. */
  onPauseAsked: ((player: number, on: boolean) => void) | null = null;

  /** CLIENT: the host ruled. See mapViewer.takePauseRuling. */
  onPauseRuled: ((on: boolean, by: number, left: number, denied: boolean) => void) | null = null;

  /** Is a LAN match's wire attached? The renderer's background pump keys on this: a
   *  networked match must keep simulating when its window is hidden (the authority owes
   *  the room snapshots), where single-player keeps the browser's natural pause. */
  get networked(): boolean {
    return this.matchLink !== null;
  }

  /** The wire itself, for traffic that is neither a command nor a snapshot — chat is the
   *  first of those (`askToSay`/`relaySaid`). Null in a single-player match, which is why
   *  every caller has to cope with there being no wire at all. */
  get matchLinkHandle(): MatchLink | null {
    return this.matchLink;
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
    this.snapshotProjSpawns.push(...res.createdProjectiles);
    this.snapshotProjImpacts.push(...res.removedProjectiles);
    // Impacts are drained by the FRAME only (updateProjectiles — a hidden window plays no
    // bursts), so cap what a long-hidden client can accumulate before refocus flushes it.
    if (this.snapshotProjImpacts.length > 256) this.snapshotProjImpacts.splice(0, this.snapshotProjImpacts.length - 256);
    // Each missile's aim fallback: the target's position when the payload was built, for
    // flights whose target is not in OUR payload (ducked into fog, died). Rebuilt per apply —
    // the set is tiny and the previous aims are stale by definition.
    this.projAim.clear();
    // Guarded like `fx` below: a payload without the field (an older host, a hand-fed
    // harness snapshot) must degrade to "no missiles", not wedge every tick from here on —
    // applySnapshot throwing before `lastApplied` is set re-throws on the SAME payload
    // forever, and the client freezes with a live wire.
    for (const p of snap.projectiles ?? []) this.projAim.set(p.id, { x: p.tx, y: p.ty });
    // The interval's spell/ability presentation, into the SAME renderer queues the sim's
    // drains fill where the sim steps — the renderer never learns which world it is in.
    // Taken from the LINK's accumulator rather than off `snap`: events ride exactly one
    // payload each, and a client frame slower than the 60 Hz wire skips payloads — the
    // accumulator collected from every payload RECEIVED, this applied one included.
    const fx = this.matchLink?.takeFx();
    if (fx) {
      this.fxEffects.push(...fx.effects);
      this.fxSplats.push(...fx.splats);
      this.fxLightnings.push(...(fx.lightnings ?? []));
      this.fxLightningStops.push(...(fx.lightningStops ?? []));
      this.fxCastStarts.push(...fx.castStarts);
      this.fxCastFires.push(...fx.castFires);
      this.fxCombatTexts.push(...(fx.texts ?? []));
    }
    // Which absences are DEATHS: consumed by the removal drain this same tick (`tick`),
    // which routes them through `onDeath` — collapse animation, death cry, corpse —
    // instead of the silent fog retire. Accumulated like fx (a skipped payload's death
    // must still collapse), and the clear() stays safe: a dead unit is absent from every
    // LATER payload too, so an accumulated death's removal lands with this very apply and
    // the drain consumes the id before the next one could clear it.
    this.pendingWireDeaths.clear();
    for (const d of this.matchLink?.takeDeaths() ?? []) this.pendingWireDeaths.add(d.id);
    // Records whose type changed in place (Scout Tower → Arcane Tower): the renderer owes
    // each the other model, exactly the host's own morph drain shape.
    this.snapshotMorphs.push(...res.morphed);
  }

  /** Payload-declared deaths awaiting this tick's removal drain (client), and the death
   *  positions the wire owes recipients (host). */
  private readonly pendingWireDeaths = new Set<number>();
  private wireDeaths: Array<{ id: number; x: number; y: number }> = [];
  private takeWireDeaths(): Array<{ id: number; x: number; y: number }> {
    if (!this.wireDeaths.length) return this.wireDeaths;
    const out = this.wireDeaths;
    this.wireDeaths = [];
    return out;
  }

  /** Applier-detected in-place type swaps, for the renderer's `remodelUnit`. */
  private snapshotMorphs: Array<{ id: number; to: string }> = [];
  drainSnapshotMorphs(): Array<{ id: number; to: string }> {
    if (!this.snapshotMorphs.length) return this.snapshotMorphs;
    const out = this.snapshotMorphs;
    this.snapshotMorphs = [];
    return out;
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

  /** Missiles the applier created/removed — the renderer plays the launch sound and streams
   *  the model for a spawn, and plays the impact burst where a vanished one last was. */
  private snapshotProjSpawns: ProjectileSnapshot[] = [];
  private snapshotProjImpacts: Array<{ id: number; x: number; y: number; z: number }> = [];
  private readonly projAim = new Map<number, { x: number; y: number }>();
  drainSnapshotProjSpawns(): ProjectileSnapshot[] {
    if (!this.snapshotProjSpawns.length) return this.snapshotProjSpawns;
    const out = this.snapshotProjSpawns;
    this.snapshotProjSpawns = [];
    return out;
  }
  drainSnapshotProjImpacts(): Array<{ id: number; x: number; y: number; z: number }> {
    if (!this.snapshotProjImpacts.length) return this.snapshotProjImpacts;
    const out = this.snapshotProjImpacts;
    this.snapshotProjImpacts = [];
    return out;
  }

  /** The renderer-facing spell/ability presentation queues (see the fork in `tick`): filled
   *  from the sim's drains where the sim steps, from the payload's `fx` on a frozen client.
   *  Capped so a hidden window (rAF stopped, pump stepping the sim) cannot grow them without
   *  bound — flushing stale bursts on refocus would be worse than dropping them. */
  private fxEffects: Array<{ art: string; x: number; y: number; targetId: number; z: number; life?: number; sound?: boolean; soundLabel?: string; anim?: EffectAnim }> = [];
  private fxSplats: Array<{ splatId: string; x: number; y: number }> = [];
  private fxLightnings: SimLightning[] = [];
  private fxLightningStops: string[] = [];
  private fxCastStarts: Array<{ casterId: number; code: string; abilityId: string; hold: number; loop: boolean; tx: number; ty: number; targetId: number; warnArt: string }> = [];
  private fxCastFires: Array<{ casterId: number; code: string; abilityId: string }> = [];
  private fxCombatTexts: CombatText[] = [];
  private wireFx: FxSnapshot = { effects: [], splats: [], lightnings: [], lightningStops: [], castStarts: [], castFires: [], texts: [] };
  drainFxEffects(): typeof this.fxEffects {
    if (this.fxEffects.length > 400) this.fxEffects.splice(0, this.fxEffects.length - 400);
    if (!this.fxEffects.length) return this.fxEffects;
    const out = this.fxEffects;
    this.fxEffects = [];
    return out;
  }
  drainFxSplats(): typeof this.fxSplats {
    if (!this.fxSplats.length) return this.fxSplats;
    const out = this.fxSplats;
    this.fxSplats = [];
    return out;
  }
  drainFxLightnings(): SimLightning[] {
    if (this.fxLightnings.length > 400) this.fxLightnings.splice(0, this.fxLightnings.length - 400);
    if (!this.fxLightnings.length) return this.fxLightnings;
    const out = this.fxLightnings;
    this.fxLightnings = [];
    return out;
  }
  drainFxLightningStops(): string[] {
    if (!this.fxLightningStops.length) return this.fxLightningStops;
    const out = this.fxLightningStops;
    this.fxLightningStops = [];
    return out;
  }
  drainFxCastStarts(): typeof this.fxCastStarts {
    if (!this.fxCastStarts.length) return this.fxCastStarts;
    const out = this.fxCastStarts;
    this.fxCastStarts = [];
    return out;
  }
  drainFxCastFires(): typeof this.fxCastFires {
    if (!this.fxCastFires.length) return this.fxCastFires;
    const out = this.fxCastFires;
    this.fxCastFires = [];
    return out;
  }
  drainFxCombatTexts(): CombatText[] {
    if (this.fxCombatTexts.length > 200) this.fxCombatTexts.splice(0, this.fxCombatTexts.length - 200);
    if (!this.fxCombatTexts.length) return this.fxCombatTexts;
    const out = this.fxCombatTexts;
    this.fxCombatTexts = [];
    return out;
  }
  /** Hand the wire its buffered presentation events (`HostSources.drainFx`). Swap-and-return
   *  so the ~60 Hz caller allocates only when something actually happened. */
  private takeWireFx(): FxSnapshot {
    const out = this.wireFx;
    if (!out.effects.length && !out.splats.length && !out.lightnings.length && !out.lightningStops.length && !out.castStarts.length && !out.castFires.length && !out.texts.length) return out;
    this.wireFx = { effects: [], splats: [], lightnings: [], lightningStops: [], castStarts: [], castFires: [], texts: [] };
    return out;
  }

  /** Advance a frozen client's missiles between payloads with the sim's own homing step
   *  (`tickProjectiles`, minus everything that deals damage): straight at the target's
   *  record — or the payload's aim fallback when the target was not sent — height lerping
   *  launch→impact by horizontal progress. The next payload overwrites with the host's
   *  truth, so this is display, not simulation: it exists so an arrow flies at the frame
   *  rate instead of hopping at the wire's cadence. Holds at the aim point when it gets
   *  there early — the payload, never the client, says when a missile is done. */
  private tickClientProjectiles(dt: number): void {
    for (const p of this.sim.projectiles.values()) {
      const t = this.sim.units.get(p.targetId) ?? this.projAim.get(p.id);
      if (!t) continue;
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      const dist = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (dist <= step) continue; // arrived (as far as we know) — hold for the payload's verdict
      p.x += (dx / dist) * step;
      p.y += (dy / dist) * step;
      const prog = p.startDist > 1 ? Math.max(0, Math.min(1, (p.startDist - dist) / p.startDist)) : 1;
      p.z = p.startZ + (p.impactZ - p.startZ) * prog;
    }
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

  /**
   * The coarse `commandstrings.txt [Errors]` voice for a purchase the authority just refused —
   * what a remote player is TOLD (item 9c). Re-derived rather than threaded out of
   * `Authority.execute` (which answers only yes/no) because the three causes a player can act
   * on — gold, lumber, food — are cheap reads, and everything subtler ("does this building
   * even train that?") is a modified client's problem, not a message. Empty string = the
   * interface error beep alone, which is still an answer.
   */
  private refusalReason(player: number, cmd: Command): string {
    let def: UnitDef | undefined;
    let food = false;
    switch (cmd.c) {
      case "train":
        def = this.registry.get(cmd.unitId);
        food = true;
        break;
      case "build":
        def = this.registry.get(cmd.defId);
        break;
      case "upgradebuilding":
        def = this.registry.get(cmd.toTypeId);
        break;
      default:
        return "";
    }
    if (!def) return "";
    const stash = this.authority.stashFor(player);
    if (stash.gold < def.goldCost) return "Nogold";
    if (stash.lumber < def.lumberCost) return "Nolumber";
    if (food) {
      const f = this.authority.foodFor(player);
      if (f.used + def.foodUsed > f.made) return "Nofood";
    }
    return "";
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
        creepCampsFor: (p) => this.creepCamps(this.viewpoints.viewpointFor(p)),
        drainFx: () => this.takeWireFx(),
        drainDeaths: () => this.takeWireDeaths(),
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
        // PLAYER_STATE_RESOURCE_FOOD_CAP / _FOOD_CAP_CEILING — a custom map states its own
        // supply cap the same way it states its gold (issue #127). See Authority.foodCapAdjust.
        setFoodCap: (p, v) => this.authority.setFoodCap(p, v),
        setFoodCapCeiling: (p, v) => this.authority.setFoodCapCeiling(p, v),
        foodCapCeilingOf: (p) => this.authority.foodCapCeilingOf(p),
        // PLAYER_STATE_RESOURCE_HERO_TOKENS — the free-hero allowance, which the melee opening
        // grants through SetPlayerState like any other starting resource.
        heroTokensFor: (p) => this.authority.heroTokensFor(p),
        setHeroTokens: (p, v) => this.authority.setHeroTokens(p, v),
        currentOrderId: (id) => this.authority.currentOrderId(id),
        issueUnitOrder: (id, oid, o, k, x, y, t) => this.authority.issueUnitOrder(id, oid, o, k, x, y, t),
        // The mine handle is a JASS fiction (MINE_ID_BASE), so it is resolved here, on the
        // side of the seam that holds both the world and the fiction's own decoder.
        entangleInstant: (id, mineHandle) => {
          const mine = mineHandle ? mineForScript(this.sim, mineHandle) : undefined;
          return this.sim.issueEntangleInstant(id, mine?.id ?? 0);
        },
        // CreateUnit needs the CONTROLLER, not the authority object: resolving placement reads
        // the pathing grid and the footprint reader, and attaching a body needs the spawn queue.
        createScriptUnit: (p, t, x, y, f) => this.createScriptUnit(p, t, x, y, f, teamOf),
      }),
      ...visionHooks(this.viewpoints, this.alliances),
      ...rosterHooks(this.sim, this.registry, teamOf),
      // `StartMeleeAI` — the map's Melee Initialization trigger seating a computer player.
      // Here rather than in a sub-module because the brains are the CONTROLLER's: they issue
      // their orders through `execute`, the same door a click goes through.
      startMeleeAI: (player, script) => this.startMeleeAIFor(player, script),
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

  /** @see Authority.setMapFoodCeiling — the map's own `war3mapMisc.txt` `[Misc] FoodCeiling`. */
  setMapFoodCeiling(value: number | null): void {
    this.authority.setMapFoodCeiling(value);
  }

  /** @see Authority.heroCensus — the command card draws the hero buttons from the same roster
   *  the authority gates them on, so there is one answer to "have I got this hero already". */
  heroCensus(player: number): Map<string, number> {
    return this.authority.heroCensus(player);
  }

  /** @see Authority.setHeroTokens — the melee opening's free-hero grant, which on the scripted
   *  path arrives as `SetPlayerState(…, PLAYER_STATE_RESOURCE_HERO_TOKENS, …)` instead. */
  setHeroTokens(player: number, value: number): void {
    this.authority.setHeroTokens(player, value);
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
    // `owner` on a dot is read for one thing only — what COLOUR to paint it — so it carries
    // the player's colour rather than its slot (see playerColor).
    const dots = this.snapshot.active ? dotsFromSnapshot(this.snapshot.units) : minimapDots(this.sim, vp);
    if (this.playerColors.size) for (const d of dots) d.owner = this.playerColor(d.owner);
    return dots;
  }

  /** The creep-camp clustering + markers, cached. @see minimapView.CreepCamps — it reads
   *  `sim.units`, so it answers for a viewpoint whose client rendered nothing. */
  private readonly creepCampView: CreepCamps;

  /** Creep-camp difficulty markers for the minimap: camp centre + fixed combined
   *  level. Only a viewpoint the MATCH handed the whole map to gets any (issue #71 —
   *  the lobby's `explored`/`revealall` modes); under normal fog a camp is worth no
   *  dot, discovered or not. The marker is a stand-in for creeps you cannot see, so
   *  it yields the moment any of them is: exactly then `dots()` starts drawing that
   *  creep, and the two must never show at once. Gone for good once every creep in
   *  the camp is dead. @see minimapView.CreepCamps.markers */
  creepCamps(vp: Viewpoint = this.local): Array<{ x: number; y: number; level: number }> {
    // A frozen client paints the AUTHORITY's markers: its record store holds only the creeps
    // it was sent, so clustering it would report every unscouted camp as cleared — which is
    // exactly what the July playtest saw (no camp dots but the gold mines).
    if (this.frozenClient) return this.lastApplied?.creepCamps ?? [];
    if (!this.seeded) return []; // seeding is the client's; nothing to cluster yet
    return this.creepCampView.markers(vp);
  }

  /** Persistent minimap glyphs (gold mines, icon-bearing neutral buildings). EXPLORED-gated:
   *  a glyph appears when the black mask lifts off its tile and stays for good after (issue
   *  #71), off the same grid the minimap veils itself with — on a client, that client's own.
   *  @see minimapView.minimapIcons. */
  minimapIcons(vp: Viewpoint = this.local): Array<{ x: number; y: number; icon: string }> {
    return minimapIcons(this.sim, this.registry, vp);
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
    // A selected unit-producing building: right-click sets its (smart) rally point. An UPROOTED
    // Ancient is deliberately not one — it is a unit while it walks, so a right-click has to
    // reach the ordinary move below (see SimWorld.acceptsRally).
    if (this.primary !== null && this.sim.acceptsRally(this.primary)) {
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
    // A PLANTED BUILDING with no rally point to set has almost nothing a right-click can mean,
    // and the one thing it does mean is an attack — for the buildings the data gave a weapon
    // you are allowed to aim (UnitWeapons `showUI`: every tower, the Orc Burrow, the Ancient
    // Protector), pointing it at a target is exactly the Attack button without the button.
    // Everything else is NOTHING: a building goes nowhere, so a click on the terrain is not a
    // quiet move order, not a facing change and not a green ground arrow.
    //
    // The Ancient Protector is what made this visible — it is the one "tower" that carries a
    // walker's speed while it is rooted (SimWorld.canPursue), and it pivoted to face every
    // click on the ground. An UPROOTED Ancient is not planted and falls through to the
    // ordinary unit orders below, which is the whole point of having pulled itself up.
    if (this.selectionIsPlanted()) {
      this.buildingRightClick(picked, queued);
      return;
    }
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
          for (const id of this.selected) if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: picked, solo: this.soloOrder() }, queued: queued })) any = true;
          if (any) {
            this.flashRing(target.x, target.y, selR, FLASH_RED, false, lift);
            return;
          }
          if (this.refuseAttackTarget(picked)) return; // a tower, pointed past its range
        } else if (target.targetKey) {
          // A DESTRUCTIBLE: right-clicking a gate or a crate attacks it. It is never hostile
          // (neutral-passive is what keeps anything from auto-acquiring it), so the order is
          // FORCED — the same "attack that anyway" a force-attack command issues. Red flash,
          // because breaking it is what the click means.
          let any = false;
          for (const id of this.selected) if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: picked, force: true, solo: this.soloOrder() }, queued: queued })) any = true;
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
      // An UPROOTED Tree of Life right-clicked onto a free mine goes and TAKES it — the night
      // elf expansion in one click. It is not a harvest and no wisp is involved: the tree
      // walks to a spot from which Entangle reaches the mine and throws its roots out as it
      // plants (SimWorld.issueEntangleAt). Asked first, because a Tree of Life is not a worker
      // and would otherwise fall straight through to a plain move and stand beside the rock.
      // Uprooted only, like the button itself (UPROOTED_ONLY) — a planted one is a building,
      // and its right-click is the rally point it never got past `acceptsRally` anyway.
      const trees = [...this.selected].filter((id) => {
        const t = this.sim.units.get(id);
        return !!t?.uprooted && t.abilities.some((a) => a.code === "Aent" && a.level >= 1);
      });
      if (trees.length) {
        let any = false;
        for (const id of trees) if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "entangleat", mineId: mine.id }, queued })) any = true;
        if (any) {
          this.flashTarget(mine.x, mine.y, mine.radius * MINE_RING_SCALE);
          return;
        }
      }
      if (this.sendToMine(mine, prim, queued)) return;
    }
    const treeHit = this.treePickPoint() ?? hit; // raised plane → clicking up the tree still hits
    const tree = this.sim.nearestTree(treeHit[0], treeHit[1], 140);
    if (tree) {
      // An UPROOTED Ancient right-clicked onto a tree EATS it. `Aeat` is the walking card's
      // button and nothing else's (UPROOTED_ONLY in mapViewer.ts — a planted Ancient's bottom
      // row belongs to its upgrades), and it is used by walking up to a tree, so the trunk
      // under the cursor is the whole order. Aimed at a POINT, because a tree is not a unit in
      // this sim: the cast fells the nearest one the Ancient can reach to the spot it names
      // (spells.ts `Aeat`), and `Rng1` = 32 means the tree it is touching — so the cast order
      // walks it over there first (tickCast), exactly as any other out-of-range spell does.
      //
      // Asked before the harvest below because an Ancient is not a worker and would otherwise
      // fall through to a plain move and stand beside the trunk doing nothing — the same shape
      // of bug the Tree of Life's right-click on a gold mine had.
      const eaters = [...this.selected].filter((id) => {
        const a = this.sim.units.get(id);
        return !!a?.uprooted && a.abilities.some((ab) => ab.code === "Aeat" && ab.level >= 1);
      });
      if (eaters.length) {
        // Aimed at the TRUNK, and shift-queueable like any other order — four shift-clicks are
        // four trees, eaten in the order they were clicked. (The standing-off distance a tree's
        // own pathing block forces is the sim's business: SimWorld.aimedBlockRadius.)
        let any = false;
        for (const id of eaters) {
          if (this.execute(this.localPlayer, { c: "cast", unitId: id, code: "Aeat", targetId: 0, x: tree.x, y: tree.y, queued })) any = true;
        }
        if (any) {
          this.flashTarget(tree.x, tree.y, 76); // the same ring a harvest click on a trunk flashes
          this.treePulses.push({ x: tree.x, y: tree.y });
          return;
        }
      }
      if (this.sendToTrees(tree, queued)) return;
    }
    // …and the arrow only if somebody is actually going: `groupMove` reports whether any unit
    // took the order, and a selection that can't walk must not stamp a destination it will
    // never reach on the ground (see queueArrow).
    if (this.groupMove(hit[0], hit[1], queued)) this.queueArrow(hit[0], hit[1], MOVE_ARROW); // green move-order feedback
  }

  /**
   * Send the selection's gold workers at a mine — the shared body of a right-click on the
   * rock and of an armed Gather click on it. Returns whether anybody took the order.
   *
   * Fan the group around the mine's rim (distinct approach points) so they don't all path to
   * the one entry point and pile up while they wait their turn — a mine takes one worker at a
   * time. Nearest-slot keeps each worker on the side it walked up from; after the first trip
   * the sim re-forms the usual mine→hall line (mineApproach), so this only cleans up the
   * approach, with a little extra breathing room so they don't bunch on one side (kept
   * modest — miners must still land within entry reach).
   *
   * A mine wrapped in ROOTS is not mined, it is MANNED — there is no shaft to walk into and a
   * wisp has no pick — so the click means the crew, and it means it while the roots are still
   * closing (patch 1.10). A HAUNTED one needs nothing extra: the order is the same harvest
   * order, and it is the mine's own state that decides whether the worker walks into a shaft
   * or kneels outside it.
   */
  private sendToMine(mine: SimMine, prim: SimUnit | undefined, queued: boolean): boolean {
    const host = mine.entangledBy > 0 ? this.sim.units.get(mine.entangledBy) : undefined;
    if (host && host.garrisonCap > 0 && prim && !this.sim.hostile(prim, host)) {
      if (this.manHold(host, host.id)) {
        this.flashRing(host.x, host.y, this.byId.get(host.id)?.selRadius ?? host.radius, FLASH_GREEN);
        return true;
      }
    }
    const workers = [...this.selected].filter((id) => !!this.sim.units.get(id)?.worker?.gold);
    const spread = ringTargets(this.sim, workers, mine.x, mine.y, mine.radius, MINE_APPROACH_SPREAD);
    let any = false;
    for (const id of workers) {
      const p = spread.get(id);
      if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "harvest", res: "gold", nodeId: mine.id, ax: p?.[0], ay: p?.[1] }, queued })) any = true;
    }
    if (any) this.flashTarget(mine.x, mine.y, mine.radius * MINE_RING_SCALE); // match the mine's hover/selection ring
    return any;
  }

  /**
   * Send the selection's lumber workers at a trunk — the shared body of a right-click on a
   * tree and of an armed Gather click on one. Returns whether anybody took the order.
   *
   * Spread the group across nearby trees so they don't all crowd the one clicked trunk and
   * shove each other: pull the N nearest trees to the click (N = worker count), then hand each
   * worker the least-crowded candidate, breaking ties by which is closest to it.
   */
  private sendToTrees(tree: { id: number; x: number; y: number }, queued: boolean): boolean {
    const workers: number[] = [];
    for (const id of this.selected) {
      if (this.sim.units.get(id)?.worker?.lumber) workers.push(id);
    }
    if (!workers.length) return false;
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
      if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "harvest", res: "lumber", nodeId: best.id }, queued })) {
        load.set(best.id, load.get(best.id)! + 1);
        targeted.add(best.id);
        any = true;
      }
    }
    if (any) {
      this.flashTarget(tree.x, tree.y, 76); // a bigger ring around the clicked tree
      for (const t of trees) if (targeted.has(t.id)) this.treePulses.push({ x: t.x, y: t.y });
    }
    return any;
  }

  /**
   * The armed GATHER cursor's click (the harvest row's `Art` face — see isHarvestCode).
   *
   * The same two nodes a right-click would find, and NOTHING else: a Gather aimed at an enemy
   * is not an attack and a Gather aimed at bare ground is not a move. Clicking a mine's
   * BUILDING is clicking the mine, because the building covers the rock — that is the same
   * redirection `orderOnBuilding` makes for a right-click on a Haunted Gold Mine.
   */
  private harvestAt(cssX: number, cssY: number, queued: boolean): void {
    const prim = this.primary !== null ? this.sim.units.get(this.primary) ?? undefined : undefined;
    const picked = this.pickAt(cssX, cssY);
    const target = picked !== null ? this.sim.units.get(picked) : undefined;
    let mine = target?.mineId ? this.sim.mines.get(target.mineId) ?? null : null;
    const hit = this.groundPoint(cssX, cssY);
    if (!mine && hit) mine = this.mineAt(hit[0], hit[1], 320); // …and you cannot mine what you cannot see
    if (mine && this.sendToMine(mine, prim, queued)) { this.ack(false); return; }
    const treeHit = this.treePickPoint() ?? hit; // raised plane → clicking up the tree still hits
    const tree = treeHit ? this.sim.nearestTree(treeHit[0], treeHit[1], 140) : null;
    if (tree && this.sendToTrees(tree, queued)) this.ack(false);
  }

  /** The Gather row's OTHER face: take what the selection is carrying to the nearest depot.
   *  Returns whether anybody had a load to carry, so the caller can fall back to arming the
   *  gather cursor for the workers that are empty-handed. */
  returnResourcesSelected(): boolean {
    let any = false;
    for (const id of this.selected) {
      if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "returnresources" }, queued: false })) any = true;
    }
    if (any) this.ack(false);
    return any;
  }

  /** Is every unit in the selection a PLANTED building — nothing in it that could take a
   *  ground order if we gave it one? Asked of the whole selection rather than of the focused
   *  unit alone, so a tower swept up with a group of soldiers doesn't silence the group's
   *  right-click: the soldiers still walk, and the tower still ignores it. */
  private selectionIsPlanted(): boolean {
    for (const id of this.selected) {
      const u = this.sim.units.get(id);
      if (u && (!u.building || u.uprooted)) return false;
    }
    return true;
  }

  /** The whole of a planted building's right-click: shoot whatever is under the cursor when
   *  that is something it may be aimed at, and otherwise do nothing at all.
   *
   *  A hostile unit or building is attacked. A DESTRUCTIBLE is FORCE-attacked, the same "break
   *  that anyway" a right-click on a gate means for a unit — it is neutral-passive, so nothing
   *  would ever auto-acquire it. Anything friendly is not an order at all. Out of range is the
   *  one refusal the player is told about ([Errors] `Notinrange`), because a tower cannot go
   *  and close the distance itself — which is the same answer the Attack button gives. */
  private buildingRightClick(picked: number | null, queued: boolean): void {
    if (picked === null || this.selected.has(picked)) return;
    const target = this.sim.units.get(picked);
    const prim = this.primary !== null ? this.sim.units.get(this.primary) : undefined;
    if (!target || !prim) return;
    const destructible = !!target.targetKey;
    if (!destructible && !this.sim.hostile(prim, target)) return;
    let any = false;
    for (const id of this.selected) if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: picked, force: destructible, solo: this.soloOrder() }, queued })) any = true;
    if (any) {
      const e = this.byId.get(picked);
      this.flashRing(target.x, target.y, e?.selRadius ?? target.radius, FLASH_RED, !!target.building, e?.moveHeight ?? 0);
      return;
    }
    this.refuseAttackTarget(picked); // "Target is outside range." — the tower cannot come to it
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
    if (mine && this.rallyCanHarvest("gold")) return { x: mine.x, y: mine.y, kind: "mine", targetId: mine.id };
    const treeHit = this.treePickPoint() ?? hit; // raised plane → clicking up the tree still hits
    const tree = this.sim.nearestTree(treeHit[0], treeHit[1], 140);
    if (tree && this.rallyCanHarvest("lumber")) return { x: tree.x, y: tree.y, kind: "tree", targetId: tree.id };
    return { x: hit[0], y: hit[1], kind: "point", targetId: 0 };
  }

  /**
   * May the building whose rally point is being set aim it at a RESOURCE — a tree, a gold
   * mine — at all?
   *
   * Only if something it trains could work one. A smart rally is a standing harvest order
   * handed to whoever comes out (applyRally), so a building that produces nobody who can
   * take it has no business accepting the click: the flag would sit on a tree promising
   * something, and every unit trained under it would walk over and stand there.
   *
   * The undead are what make it obvious, because the race splits the two resources between
   * two units and two buildings. `[unpl] Trains=uaco` — an Acolyte has `Aaha`, which is gold
   * and nothing else (docs/undead.md §4) — so a Necropolis may be rallied to a mine and not
   * to a tree, while `[usep] Trains=ugho,…` gives the Crypt the Ghoul and its `Ahrl`, so the
   * Crypt is the undead building that may. Every altar, barracks and workshop in the game
   * fails both halves, which is the same answer for all four races.
   *
   * Read off the `Trains` list and the harvest ABILITY each trainee carries rather than off a
   * list of building ids (workerProfileFor, data/races.ts) — the same rule that decides what
   * a worker IS, so a custom map's own builder is covered by it too.
   */
  private rallyCanHarvest(kind: "gold" | "lumber"): boolean {
    if (this.primary === null) return false;
    const typeId = this.byId.get(this.primary)?.typeId;
    if (!typeId) return false;
    for (const uid of this.tech.trains(typeId)) {
      const d = this.registry.get(uid);
      if (!d) continue;
      const p = workerProfileFor(uid, d.abilities.map((id) => this.abilities.get(id)?.code ?? id));
      if (p && (kind === "gold" ? p.gold : p.lumber)) return true;
    }
    return false;
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

  /** Is this click an order to ONE unit — the player had it solo-selected — rather than an
   *  order handed to a group? It rides along on the attack orders below because a caster
   *  obeys a solo order that a group order lets its autocast override (see
   *  SimUnit.attackSolo). `except` is the unit under the cursor at a force-attack site: the
   *  loops there skip it, so it is not one of the recipients being counted. */
  private soloOrder(except?: number): boolean {
    let n = 0;
    for (const id of this.selected) if (id !== except) n++;
    return n === 1;
  }

  /** Right-clicked a building: issue the fitting order and flash its footprint
   *  circle (no ground arrow). Hostile → attack + red; own → resume/repair (if a
   *  worker) else move, green; allied/neutral → move, yellow. */
  private orderOnBuilding(target: SimUnit, picked: number, enemy: boolean, selR: number, queued: boolean): void {
    if (enemy) {
      for (const id of this.selected) this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attack", targetId: picked, solo: this.soloOrder() }, queued: queued });
      this.flashRing(target.x, target.y, selR, FLASH_RED);
      return;
    }
    const own = this.primary !== null ? target.owner === this.sim.units.get(this.primary)?.owner : false;
    // A Moon Well is the one friendly building you right-click to USE. Every selected unit
    // that a well can do something for is sent to drink from it — its own or an ALLY'S, which
    // is the point of the ability's `friend` targeting and of night elf team play. Units the
    // well cannot serve (a Glaive Thrower — `targs1` says `organic`) and units with nothing
    // to gain simply keep their orders, and if that leaves nobody the click falls through to
    // the ordinary walk-up below.
    if (this.sim.isReplenisher(picked)) {
      // …except a WORKER sent at a damaged one, which is mending it. That is what a right-click
      // on a hurt own building has always meant, and a wisp is organic enough to drink, so the
      // two orders would otherwise collide on exactly the case that matters (a well taking
      // fire). Both can happen at once in a mixed selection: the workers repair, the rest drink.
      const mending = own && target.hp < target.maxHp;
      let any = false;
      for (const id of this.selected) {
        if (mending && this.sim.units.get(id)?.worker) continue;
        if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "drink", wellId: picked }, queued })) any = true;
      }
      if (mending && this.repairAt(picked, queued)) any = true; // issueRepair refuses non-workers
      if (any) {
        this.ack(false); // the drinkers answer, as they do for any move order
        this.flashRing(target.x, target.y, selR, FLASH_GREEN);
        return;
      }
    }
    // Own (or an ally's) HAUNTED GOLD MINE: the building covers the rock, so a right-click
    // meaning "go and mine" lands on it rather than on the mine. Aim the order at the mine
    // UNDERNEATH — that is what an Acolyte harvests (SimWorld.tickRingHarvest) — and let
    // anything that is not a ring miner fall through to the ordinary walk-up. Mirrors the
    // Entangled Gold Mine's branch below, where the same click means the crew instead.
    if (!enemy && target.mineId && this.sim.hauntedMine(target.mineId)) {
      let any = false;
      for (const id of this.selected) {
        if (!this.sim.units.get(id)?.worker?.minesInRing) continue;
        if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "harvest", res: "gold", nodeId: target.mineId }, queued })) any = true;
      }
      if (any) {
        this.flashRing(target.x, target.y, selR, FLASH_GREEN);
        return;
      }
    }
    // Own Orc Burrow (built, with room): peons in the selection climb inside to man it.
    // Only send as many as can fit; the rest keep their orders.
    //
    // An Entangled Gold Mine still closing its roots counts as open for this: nobody can
    // BUILD it (it raises itself, see BuildingState.selfBuilds), so a right-click on it with
    // wisps can only mean the crew. They walk over and stand at the door — patch 1.10,
    // "Wisps rallied to an incomplete Entangled Gold Mine will automatically begin to mine
    // once the structure is completed" (tickGarrison). Every other half-built structure falls
    // through to the resume/assist branch below, which is what a right-click on one means.
    const entangling = !!target.building?.selfBuilds;
    if (own && target.garrisonCap > 0 && (!target.building || target.building.constructionLeft <= 0 || entangling)) {
      if (this.manHold(target, picked)) {
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
    if (!handled) this.groupMoveTo(target, picked, queued); // walk up to it (no arrow)
    this.flashRing(target.x, target.y, selR, own ? FLASH_GREEN : FLASH_YELLOW);
  }

  /**
   * Send the selection's workers into a cargo hold — an Orc Burrow's peons, an Entangled Gold
   * Mine's crew — and no more of them than it has room for.
   *
   * The cap is the point. `Aenc` `Car1` = 5 and a burrow's `Abun` is 4, so a right-click with
   * eight wisps selected must put five to work and leave the other three doing what they were
   * doing: ordered in regardless they would all walk over, wait out the mine's 60 seconds of
   * roots, and then be turned away at the door by the three who got there first (tickGarrison
   * stands a passenger down when the hold fills while it walks). Whoever is already inside is
   * counted, so topping a half-crewed mine up sends exactly the missing wisps.
   *
   * Returns whether anybody took the order, so the caller can fall through to the ordinary
   * walk-up when the hold is full.
   */
  private manHold(host: SimUnit, hostId: number): boolean {
    const room = host.garrisonCap - host.garrison.length;
    if (room <= 0) return false;
    const workers = [...this.selected].filter((id) => !!this.sim.units.get(id)?.worker).slice(0, room);
    let any = false;
    for (const id of workers) if (this.execute(this.localPlayer, { c: "garrison", unitId: id, buildingId: hostId })) any = true;
    return any;
  }

  /** Issue a formation move for the whole selection to a ground point (or queue
   *  each unit's slot move when Shift is held). */
  private groupMove(tx: number, ty: number, queued = false): boolean {
    const targets = groupTargets(this.sim, [...this.selected], tx, ty);
    let any = false;
    for (const [id, [x, y]] of targets) if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "move", x, y }, queued: queued })) any = true;
    return any; // …did anyone actually take it? The ground arrow hangs off this
  }

  /** Move the whole selection AT a unit or building: everyone is given the target itself,
   *  and each walks up to it and stops as close as it can get, by the fastest route.
   *
   *  Deliberately NOT groupMove: a formation fan spreads distinct slots evenly AROUND the
   *  destination, which is right for a patch of ground and wrong for a thing — it hands
   *  some of the group a slot on the far side and they hike round the building to reach a
   *  spot no better than the one they were standing next to. Aimed at the target itself,
   *  each unit stops on the side it approached from and the group packs in from there. */
  private groupMoveTo(target: SimUnit, targetId: number, queued = false): void {
    for (const id of this.selected) {
      this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "move", x: target.x, y: target.y, targetId }, queued: queued });
    }
  }

  /** Attack-move the whole selection to a ground point. Same destination logic as
   *  groupMove — each unit gets a DISTINCT formation slot around the point so they
   *  spread out there instead of cramming on one tile — but issued as attack-move, so
   *  each unit fights the nearest enemy in its path and resumes to its slot afterwards. */
  private groupAttackMove(tx: number, ty: number, queued = false): boolean {
    const targets = groupTargets(this.sim, [...this.selected], tx, ty);
    let any = false;
    for (const [id, [x, y]] of targets) if (this.execute(this.localPlayer, { c: "order", unitId: id, order: { kind: "attackmove", x, y }, queued: queued })) any = true;
    return any;
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
    // A cinematic takes the WHOLE interface, not just the console. `ShowInterface(false)` is
    // the letterbox, and what it hides is everything the player normally reads off the
    // screen — the floating health and mana bars and the hero level badge included. They are
    // drawn in the world layer rather than in the HUD, so hiding the HUD left them stranded
    // over a scene that is meant to look like a film: bars over every Watcher through
    // Maiev's opening lines. Same switch, honoured in the one place that builds them.
    if (!this.interfaceShown) {
      this.overlays.syncBars(specs);
      return;
    }
    for (const e of this.entries) {
      // Same source as the model this bar floats over — that is the whole of item 10c-2c-2's
      // atomicity requirement. A bar drawn at the sim's position over a model drawn at the
      // snapshot's would track a unit it is not attached to.
      const u = this.frameUnit(e.simId);
      if (!u || e.hidden) continue; // no model on screen (worker in a mine, unexplored fog)
      // Critters (Sheep, Pig, Raccoon, Rabbit — 15 hp of neutral-passive wildlife) DO carry a
      // bar in WC3, like every other unit on the field (issue #100). Skipping everything
      // neutral-passive-and-not-a-building was a guess, and nothing in the unit tables backs
      // it: UnitMetaData's only "hide a bar" field is `uhhb` hideHeroBar, which is about the
      // HERO interface icon, not the floating status bar. So no unit type opts out here.
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
        // Who is INSIDE it — the Orc Burrow's peons and the Entangled Gold Mine's wisps. WC3
        // shows the hold as a row of slots under the health bar, and only while something is
        // in there: an empty burrow floats an ordinary bar like any other building. The slot
        // count is the hold's own capacity (`Abun`/`Aenc` Data — SimUnit.garrisonCap), so the
        // mine gets five and a burrow gets what its row says.
        garrison: u.garrisonCap > 0 && u.garrison.length > 0
          ? { filled: u.garrison.length, slots: u.garrisonCap }
          : null,
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

/**
 * A unit type's "Art - Tinting Color" (UnitUI red/green/blue) as an RGBA base colour, or
 * `undefined` for an untinted type.
 *
 * `undefined` is not the same as white here: an Entry with no `baseColor` makes applyFogTint
 * sample the instance's own colour the first time it fogs it, which is the behaviour every
 * untinted unit has always had. Only a type that actually states a tint states one.
 */
function tintColor(def: UnitDef): Float32Array | undefined {
  const [r, g, b] = def.tint;
  return r === 1 && g === 1 && b === 1 ? undefined : new Float32Array([r, g, b, 1]);
}

// How far along a tier upgrade is, 0..1 — the playhead of the target's Birth clip while the
// building rises into its next form. A job with no recorded build time (a debug fast-build,
// a job restored without one) reads as finished rather than NaN.
function upgradeProgress(job: RenderBuildJob): number {
  if (!(job.buildTime > 0)) return 1;
  return Math.min(1, Math.max(0, 1 - job.timeLeft / job.buildTime));
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

/** The weapon-target class a destructible def carries (see destructibleUnitDef): the
 *  `targ:<targType>` marker it stores in `classification`, which is the one field a UnitDef has
 *  spare for something no unit SLK column describes. "" for an ordinary unit. */
function destructibleTargetKey(def: UnitDef): string {
  const tag = def.classification.find((c) => c.startsWith("targ:"));
  return tag ? tag.slice(5) : "";
}
