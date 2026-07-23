import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import MdlxModel from "mdx-m3-viewer/dist/cjs/parsers/mdlx/model";
import { parseWar3Skins, skinValue, SKIN_VERSION_SUFFIX, WAR3SKINS } from "../data/war3skins";
import type { DataSource } from "../vfs/types";

// Unit voice lines & sound effects, sourced entirely from the real WC3 sound data
// (the safest source of truth). Mappings, verified against the 1.27 MPQs:
//
//   Units\UnitUI.slk  `unitSound`  → sound-set LABEL (hfoo → "Footman")
//                     `weap1`      → weapon-impact base ("MetalMediumSlice")
//                     `weap2`      → lumber/2nd weapon base ("AxeMediumChop")
//                     `armor`      → material struck ("Metal"/"Flesh"/"Wood"/…)
//   UI\SoundInfo\UnitAckSounds.slk    row `<label><Category>`   (voice acks)
//   UI\SoundInfo\AnimSounds.slk       row `<label>Death`        (death cries)
//   UI\SoundInfo\UnitCombatSounds.slk row `<weap><armor>`       (impacts + chops)
//   UI\SoundInfo\UISounds.slk         row `<name>`              (interface sounds)
//
// A unit's/missile's ATTACK sound is NOT in any of the above nor in the model's own
// folder — it's embedded in the MODEL as an `SND` event object (e.g. Rifleman.mdx
// carries "SNDXKRIF"). The 4-char code (KRIF) resolves via UI\SoundInfo\AnimLookups.slk
// (code → SoundLabel) then UI\SoundInfo\AnimSounds.slk (label → WAVs + 3D metadata).
// The leading letter categorises it: K = the unit's own fire sound (gunshot, mortar
// boom, dragon breath, tower fire), M = a missile's launch/impact whoosh, D = death.
// This is why the Rifleman's gunshot (Units\Human\Rifleman\RiflemanAttack1.wav) and
// the Frost Wyrm's missile sound (in the FireBallMissile folder!) can't be found by
// scanning the model's own folder — resolveModelSounds() walks this chain instead.
//
// Row keys are matched CASE-INSENSITIVELY: WC3's data is inconsistent (e.g. unit
// `halt` has unitSound "AltarofKings" but the ack row is "AltarOfKingsWhat"), and
// the engine looks them up case-insensitively — an exact match silently dropped
// the Altars, Tree of Life, Boneyard, Slaughterhouse voices.
//
// Channels:
//   VOICE  (What/Yes/YesAttack/Pissed/Warcry/Ready) — one exclusive channel PER
//          SOURCE (a unit/building instance), so different units/buildings overlap
//          freely, but while a given source's line plays its own further requests
//          are DROPPED (never cut) until it finishes. Source-less voices (e.g. a
//          just-trained unit's "Ready") each get a fresh key so they always overlap.
//          A global MAX_VOICES cap bounds a pathological burst.
//   Death / Impact / UI — overlapping one-shot pools (deaths & impacts capped).
//   Loops  — named looping sounds (building construction).
//
// Across ALL of them one rule holds: the same WAV is never in the air twice at once on a
// client (issue #84) — identical copies phase into a doubled smear rather than sounding
// louder. A clip's other variants are taken first, and when they're all up the copy that
// keeps the file is the one the player can actually HEAR: audibility is (re)measured from
// the current camera, so a clang out past its DistanceCutoff counts as not playing and
// yields to the same clang landing next to the listener. See pickVariant().

export type SoundCategory = "What" | "Yes" | "YesAttack" | "Pissed" | "Warcry" | "Ready" | "Death";

/** A world position for a positional (WANT3D) sound. z is optional (defaults to 0 —
 *  panning is driven by the XY azimuth to the listener, so height barely matters). */
export interface SoundPos {
  x: number;
  y: number;
  z?: number;
}

const ACK_TABLE = "UI\\SoundInfo\\UnitAckSounds.slk";
const ANIM_TABLE = "UI\\SoundInfo\\AnimSounds.slk";
const COMBAT_TABLE = "UI\\SoundInfo\\UnitCombatSounds.slk";
const UI_TABLE = "UI\\SoundInfo\\UISounds.slk";
const AMBIENCE_TABLE = "UI\\SoundInfo\\AmbienceSounds.slk"; // dawn/dusk cries, weather beds
const ANIMLOOKUPS_TABLE = "UI\\SoundInfo\\AnimLookups.slk"; // SND event code → SoundLabel
const ABILITY_TABLE = "UI\\SoundInfo\\AbilitySounds.slk"; // spell sounds, by label
const DIALOG_TABLE = "UI\\SoundInfo\\DialogSounds.slk"; // campaign dialogue lines
// (SoundLabel → WAVs + 3D metadata is AnimSounds.slk — already loaded under the "anim" tag.)

// A sound LABEL lives in ONE namespace spanning every SoundInfo table — a script's
// SetSoundParamsFromLabel(snd, "N03Tyrande01") means DialogSounds, and
// SetSoundParamsFromLabel(snd, "HeroDeathKnightPissed") means UnitAckSounds, with no
// hint at the call site which table to look in. So labelParams() searches them all.
// (EnvironmentSounds.slk is NOT in the list: despite the name it's the EAX reverb
// config — keyed by EnvironmentType, not by a sound label. MIDISounds.slk is the MIDI
// ambience beds, which we don't synthesize.)
const LABEL_TABLES = ["ui", "ack", "anim", "combat", "ability", "ambience", "dialog"] as const;

/** The playback parameters a SoundInfo row carries — what `SetSoundParamsFromLabel`
 *  copies onto a `sound` handle, and what `CreateSoundFromLabel` builds one from.
 *  `volume` is the raw SLK 0–127 scale, because that is JASS's scale too
 *  (`SetSoundVolumeBJ` = `PercentToInt(percent, 127)`). */
export interface SoundLabelParams {
  files: string[]; // full MPQ paths of the row's variants (FileNames × DirectoryBase)
  volume: number; // 0–127
  pitch: number;
  pitchVar: number;
  channel: number;
  threeD: boolean; // Flags contains WANT3D
  minDist: number;
  maxDist: number;
  cutoff: number;
}

/** A `sound` handle's playback spec, as the JASS natives configure it (see
 *  src/jass/natives/sound.ts). Purely a value object — the SoundBoard never sees a
 *  JASS handle, only an opaque `id` to key the playing voice by. */
export interface ScriptSoundSpec {
  file: string; // MPQ path of the WAV/MP3
  volume: number; // 0–127 (WC3 scale)
  pitch: number;
  looping: boolean;
  is3D: boolean;
  at: SoundPos | null; // SetSoundPosition / the attached unit's position
  minDist: number;
  maxDist: number;
  cutoff: number;
  coneInside: number; // degrees (0 = omnidirectional)
  coneOutside: number;
  coneOutsideVolume: number; // 0–127
  coneOrient: SoundPos | null; // the cone's facing vector
}

/** The eight `volumegroup`s of common.j (SOUND_VOLUMEGROUP_*), which
 *  `VolumeGroupSetVolume` scales. Our pools map onto them as follows; the mapping is
 *  read off blizzard.j's own `SetCineModeVolumeGroupsImmediateBJ`, which ducks
 *  UNITSOUNDS and UI to **0.00** while leaving MUSIC at 0.55 and AMBIENTSOUNDS at 1.00
 *  during a cinematic — i.e. exactly so the cinematic's own *dialogue* stays audible.
 *  That tells us a script-created `sound` belongs to NONE of these groups, so ours
 *  doesn't route through one either. UNITMOVEMENT (footsteps) and FIRE (doodad fire
 *  loops) have no pool here yet — their gains are recorded and simply have nothing to
 *  scale. */
// common.j's SOUND_VOLUMEGROUP_* indices (VolumeGroupSetVolume). Exported so the Options
// screen can scale the SFX groups off the sound sliders without re-typing the magic numbers.
export const SOUND_GROUP = {
  UNITMOVEMENT: 0,
  UNITSOUNDS: 1,
  COMBAT: 2,
  SPELLS: 3,
  UI: 4,
  MUSIC: 5,
  AMBIENT: 6,
  FIRE: 7,
} as const;
const VG_UNITSOUNDS = SOUND_GROUP.UNITSOUNDS;
const VG_COMBAT = SOUND_GROUP.COMBAT;
const VG_SPELLS = SOUND_GROUP.SPELLS;
const VG_UI = SOUND_GROUP.UI;
const VG_MUSIC = SOUND_GROUP.MUSIC;
const VG_AMBIENT = SOUND_GROUP.AMBIENT;
const VOLUME_GROUPS = 8;

/** Which volume group each one-shot pool answers to by default. A death cry is a unit
 *  sound; a weapon clang is combat. (`playAmbience` shares the uncapped "ui" pool but
 *  is an AMBIENTSOUNDS sound, so it overrides the group at the call site.) */
const POOL_GROUP: Record<"death" | "impact" | "ui" | "spell", number> = {
  death: VG_UNITSOUNDS,
  impact: VG_COMBAT,
  spell: VG_SPELLS,
  ui: VG_UI,
};

const VOICE_CATEGORIES: ReadonlySet<SoundCategory> = new Set<SoundCategory>(["What", "Yes", "YesAttack", "Pissed", "Warcry", "Ready"]);

const MAX_VOICES = 8; // concurrent voice lines across all sources (safety cap on overlap)

/** Concurrent voices allowed per SOUND CHANNEL — the grouping the game's own SoundInfo
 *  SLKs carry in their `Channel` column, read straight off the 1.27a archives:
 *    UnitCombatSounds → 5      every weapon-impact clang (all 60 rows)
 *    AnimSounds       → 11     a model's SND attack/fire/death events (591 of 592 rows)
 *    UnitAckSounds    → 1–4    voice lines        AbilitySounds → 13/14    UISounds → 8/12
 *  These are DIFFERENT channels to the engine and each holds its own voices. We used to
 *  run every weapon sound through ONE 5-slot "impact" pool, so a unit's own fire sound
 *  (channel 11) and the clang it lands (channel 5) competed with each other and with
 *  every other unit in the fight. Measured in a 4-Mountain-King creep fight: 112 sounds
 *  requested, 35 dropped — the Mountain King's hammer swing and its MetalHeavyBashFlesh
 *  clang among them, i.e. blows that dealt damage in silence. Budget per channel instead.
 *  The engine's own per-channel voice count isn't in any data file, so this size is ours:
 *  generous enough that a normal fight never drops, small enough to bound a mass battle. */
const CHANNEL_VOICES = 16;

/** A reserved slot on a channel. `src` is null until the clip's buffer finishes decoding
 *  (the reservation is taken synchronously, playback starts later); `dead` marks a voice
 *  preempted before it ever started, so the decode callback knows not to play it. */
interface PoolVoice {
  src: AudioBufferSourceNode | null;
  dead: boolean;
}

interface Clip {
  paths: string[]; // full MPQ paths of the randomized variants
  gain: number; // 0..1 (Volume / 127)
  pitch: number; // base playback rate
  pitchVar: number; // ± random jitter applied per play (0 = none)
  // Row provenance — present only on clips resolved from a SoundInfo SLK row (resolve()),
  // absent on the ones we synthesize for folder WAVs. `labelParams` hands both back to a
  // script, which reads volume on WC3's own 0–127 scale rather than our 0–1 gain.
  volume127?: number;
  channel?: number;
  // Positional-audio fields, straight from the SoundInfo SLK row (see resolve()).
  threeD: boolean; // Flags contains WANT3D → play through a positional PannerNode
  refDist: number; // MinDistance — full volume within this radius (world units)
  maxDist: number; // MaxDistance — attenuated to silence at this radius
  cutoff: number; // DistanceCutoff — WC3 doesn't play the sound at all beyond this
  // Flags contains CHANNELFULLPREEMPT (or CHANNELFULLPREEMPTOLDEST): when the sound's
  // channel is full the engine TAKES a slot from a voice already playing rather than
  // refusing the new one. 490 of AnimSounds' 592 rows carry it — a unit's attack sound is
  // meant to be heard even mid-brawl. The OLDEST variant names the victim outright, and
  // oldest-first is the only deterministic policy for the plain flag too, so both stop the
  // channel's longest-running voice. UnitCombatSounds carries NEITHER flag on any of its 60
  // rows, so a full combat channel really does refuse the clang — that part is authentic.
  preempt?: boolean;
}

/** One copy of a WAV that is currently in the air — what the never-stack rule (below)
 *  arbitrates over. `at` is where it is playing (null = a 2D sound, always at full
 *  audibility); `kill` cuts it short when a nearer source wins the file off it. */
interface ActiveFile {
  clip: Clip;
  at: SoundPos | null;
  kill: () => void;
}

/** Weapon/spell sounds embedded in a unit/missile/effect MODEL as SND event objects,
 *  resolved via AnimLookups (4-char code → label) → AnimSounds (label → clip). Categorised
 *  by the event code's leading letter: K = the unit's own attack/fire sound; M = a missile's
 *  launch/impact whoosh; A = an ability/effect sound. (D death is handled by the unit's
 *  sound-set label.) */
interface ModelSounds {
  attack: Clip[]; // K events — the unit's fire sound (played at the swing's damage point)
  launch: Clip[]; // M events whose label is a "…Launch"
  impact: Clip[]; // M events whose label is a "…Hit"/"…Impact" (or a single generic missile sound)
  ability: Clip[]; // A events — the sound the effect model itself plays when it appears
}

/** A live `sound` handle the script started (StartSound). The nodes arrive a tick late —
 *  the WAV decodes async — so the entry is inserted the moment StartSound commits and
 *  acts as the cancellation token: dropping it from the map is what a StopSound during
 *  the decode does. */
interface ScriptVoice {
  src: AudioBufferSourceNode | null;
  gain: GainNode | null;
  panner: PannerNode | null;
}

/** One music track on the music bus (its own gain, so SetMusicVolume is live). */
interface Track {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

/** StopSound(…, fadeOut) / a pre-empted music track ramp out over this. WC3's own
 *  fadeInRate/fadeOutRate (CreateSound's 5th/6th args) are in undocumented units — see
 *  stopScript — so we ramp over a fixed, short time rather than invent a curve. */
const FADE_SECONDS = 0.35;
const MUSIC_FADE_SECONDS = 1.5;

/** Point a positional sound's cone: SetSoundConeAngles(inside, outside, outsideVolume) +
 *  SetSoundConeOrientation(x, y, z) map 1:1 onto the Web Audio PannerNode's cone, with
 *  WC3's 0–127 outside volume scaled to the node's 0–1 outer gain. An inside angle of 0
 *  (the default, and what all but 3 of the bundled maps leave it at) means no cone at
 *  all — leave the node omnidirectional rather than collapse it to silence. */
function applyCone(p: PannerNode, s: ScriptSoundSpec): void {
  if (!s.coneInside || !s.coneOrient) return;
  p.coneInnerAngle = s.coneInside;
  p.coneOuterAngle = Math.max(s.coneInside, s.coneOutside);
  p.coneOuterGain = Math.max(0, Math.min(1, s.coneOutsideVolume / 127));
  const { x, y, z = 0 } = s.coneOrient;
  if (p.orientationX) {
    p.orientationX.value = x;
    p.orientationY.value = y;
    p.orientationZ.value = z;
  } else {
    p.setOrientation?.(x, y, z);
  }
}

/** The 3D listener frame, in WC3 world space (Z up). Position sits at the camera's
 *  ground focus; forward is the look direction (target←eye), up is world +Z. */
interface Listener {
  px: number;
  py: number;
  pz: number;
  fx: number;
  fy: number;
  fz: number;
}

// A parsed SLK plus a lowercase→actual row-name index for case-insensitive lookup.
interface Table {
  data: MappedData;
  index: Map<string, string>;
}

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private tables = new Map<string, Table | null>();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private decoded = new Map<string, number>(); // path → seconds, once decoded (GetSoundFileDuration)
  private clips = new Map<string, Clip | null>(); // memoized "table|key" → clip
  // Active voice lines keyed by SOURCE (unit/building instance id). One line per
  // source at a time — distinct sources overlap; a source re-requesting while its
  // own line still plays is dropped. Source-less voices use a fresh voiceSeq key.
  private voices = new Map<string, AudioBufferSourceNode>();
  private voiceSeq = 0;
  /** Live voices per sound channel, oldest first — the budget CHANNEL_VOICES bounds and
   *  the queue a CHANNELFULLPREEMPT clip steals its slot from (see playPool). */
  private channelVoices = new Map<number, PoolVoice[]>();
  private loops = new Map<string, AudioBufferSourceNode>(); // active looping sounds by name
  /** setPathLoop's side of the never-stack rule: which loop key OWNS each looping WAV,
   *  the keys queued behind it, and what file each key is on (an owner or a waiter) —
   *  the stop call is given only the key. */
  private loopOwner = new Map<string, string>();
  private loopQueue = new Map<string, Array<{ key: string; at?: SoundPos }>>();
  private loopFile = new Map<string, string>();
  /** Every WAV currently in the air, at most one copy each — the never-stack rule
   *  (see pickVariant). Keyed by file path, since that is what "the same sound" means. */
  private playing = new Map<string, ActiveFile>();
  /** Named loops asked for while the AudioContext was still gated (see startPendingLoops). */
  private pendingLoops = new Map<string, { tag: string; group?: number }>();
  private muted = false;
  private volume = 0.85;
  private listener: Listener | null = null; // last camera frame (for WANT3D panning)
  /** VolumeGroupSetVolume scales (0–1), one per SOUND_VOLUMEGROUP_* index. */
  private groups = new Array<number>(VOLUME_GROUPS).fill(1);
  /** Sounds a trigger script started (StartSound), keyed by its `sound` handle id, so
   *  StopSound / GetSoundIsPlaying / a moving attached sound can all find them again. */
  private scripts = new Map<number, ScriptVoice>();
  /** The map's music (SetMapMusic / PlayMusic) — one track at a time, advancing through
   *  the playlist as each finishes. `thematic` pre-empts it and restores it on End. */
  private music: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private musicList: string[] = [];
  private musicIndex = 0;
  private musicRandom = false;
  private musicVolume = 1; // SetMusicVolume, 0–1 (the native's 0–127 scaled)
  private musicPaused = false; // StopMusic — ResumeMusic restarts the list
  private musicCueing = false; // a track is decoding (see startPendingMusic)
  /** WC3 has exactly ONE music channel, and every music native (SetMapMusic / PlayMusic /
   *  PlayThematicMusic / StopMusic) is a bid to own it. Owning it has to be claimed
   *  SYNCHRONOUSLY, because our tracks are mp3s that decode asynchronously: between asking
   *  for a track and it starting there is a window in which `this.music` is still null, so
   *  a second start in that window stopped nothing and BOTH tracks reached src.start().
   *  Nothing then held the first one's node, so it played to the end, unstoppable, under
   *  the second. WarChasers opens exactly that way — main()'s `SetMapMusic("Music", true, 0)`
   *  cues the race playlist, and its init trigger's `PlayMusicBJ(gg_snd_Undead2)` cues
   *  Undead2 a millisecond later, while the first is still decoding. Hence a generation
   *  token: a start claims the channel the moment it is asked for, and a decode that lands
   *  against a stale token is discarded instead of played. */
  private musicGen = 0;
  private thematic: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private skins: Map<string, Map<string, string>> | null = null;
  /** Which war3skins.txt section the music playlists come from — the LOCAL player's
   *  race, which is how melee gives an Orc player orc music (set by the host). */
  musicSkin = "Default";

  /** Fired when an acknowledgement VOICE actually starts (label + clip seconds) —
   *  the host drives the 3D portrait's talk animation off this. */
  onVoiceStart: ((label: string, durationSec: number) => void) | null = null;

  constructor(private vfs: DataSource) {
    for (const [tag, path] of [["ack", ACK_TABLE], ["anim", ANIM_TABLE], ["combat", COMBAT_TABLE], ["ui", UI_TABLE], ["ambience", AMBIENCE_TABLE], ["animlookups", ANIMLOOKUPS_TABLE], ["ability", ABILITY_TABLE], ["dialog", DIALOG_TABLE]] as const) {
      this.tables.set(tag, this.loadTable(path));
    }
  }

  private loadTable(path: string): Table | null {
    const bytes = this.vfs.rawBytes(path);
    if (!bytes) return null;
    const m = new MappedData();
    m.load(new TextDecoder("windows-1252").decode(bytes));
    const index = new Map<string, string>();
    for (const k of Object.keys((m as unknown as { map: Record<string, unknown> }).map ?? {})) index.set(k.toLowerCase(), k);
    return { data: m, index };
  }

  /** Resume the AudioContext from a user gesture (browsers block autoplay until
   *  the first interaction). Safe to call repeatedly; creates the context lazily. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      this.applyListener(); // push the camera frame captured before the first gesture
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().then(() => this.startPending());
    else this.startPending();
  }

  /** Everything that was asked for while the autoplay gate was still shut. */
  private startPending(): void {
    this.startPendingMusic();
    this.startPendingLoops();
  }

  /** The map's music is cued from the script — `SetMapMusic` runs inside `main()`, long
   *  before the player has touched anything — so on a cold load the AudioContext is still
   *  suspended by the browser's autoplay gate and the track can't start. Without this the
   *  music was simply lost: the cue had already happened and nothing ever retried it.
   *  So the playlist survives the gate and starts on the first gesture instead. */
  private startPendingMusic(): void {
    if (this.ctx?.state !== "running") return;
    if (this.musicList.length && !this.music && !this.musicCueing && !this.thematic && !this.musicPaused) this.startMusicTrack();
  }

  /** Position the 3D audio listener at the camera's ground focus (`target`), facing
   *  the look direction (target←eye). Called every frame by the renderer; WANT3D
   *  clips (combat, deaths, spell casts) then pan + attenuate around it, while UI
   *  sounds and the commanded unit's voice stay centered (2D). */
  setListener(target: ArrayLike<number>, eye: ArrayLike<number>): void {
    let fx = target[0] - eye[0];
    let fy = target[1] - eye[1];
    let fz = target[2] - eye[2];
    const len = Math.hypot(fx, fy, fz) || 1;
    fx /= len;
    fy /= len;
    fz /= len;
    this.listener = { px: target[0], py: target[1], pz: target[2], fx, fy, fz };
    this.applyListener();
  }

  private applyListener(): void {
    const L = this.ctx?.listener;
    const f = this.listener;
    if (!L || !f) return;
    // Modern API sets AudioParams; older Safari uses the deprecated setter pair.
    if (L.positionX) {
      L.positionX.value = f.px;
      L.positionY.value = f.py;
      L.positionZ.value = f.pz;
      L.forwardX.value = f.fx;
      L.forwardY.value = f.fy;
      L.forwardZ.value = f.fz;
      L.upX.value = 0;
      L.upY.value = 0;
      L.upZ.value = 1; // WC3 world space is Z-up
    } else {
      L.setPosition?.(f.px, f.py, f.pz);
      L.setOrientation?.(f.fx, f.fy, f.fz, 0, 0, 1);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  /** Play a unit voice line (or death cry). Voice acknowledgements are exclusive
   *  PER SOURCE (a unit/building instance): a given `source`'s line is dropped
   *  while its own previous line still plays, but different sources overlap. Pass
   *  the emitting unit's instance id as `source`; omit it for a fire-and-forget
   *  line (e.g. a just-trained unit's "Ready") that should always overlap. Deaths
   *  go through the overlapping death pool (capped).
   *  @returns whether a NEW voice line actually started — false if it was dropped
   *  because the source is still talking (or is unready/has no such clip). Callers use
   *  this to advance the What→Pissed streak by lines *heard*, not clicks. Death always
   *  returns false (it's a pooled cry, not a per-source voice). */
  play(label: string, category: SoundCategory, at?: SoundPos, source?: string | number): boolean {
    if (!label) return false;
    if (category === "Death") {
      this.playPool(this.resolve("anim", label + "Death"), "death", at);
      return false;
    }
    return this.playVoice(label, category, source);
  }

  /** Play a weapon-impact / chop clang: `<weapon><material>` (MetalMediumSlice+Flesh,
   *  AxeMediumChop+Wood, …). No-op for weaponless entries (`weap` empty/"_"). */
  playImpact(weaponSound: string, targetArmor: string, at?: SoundPos): void {
    if (!weaponSound || weaponSound === "_" || !targetArmor) return;
    this.playPool(this.resolve("combat", weaponSound + targetArmor), "impact", at);
  }

  /** Play a missile's launch/impact whoosh. Authentic source: the missile model's own
   *  SND "M" event objects (AnimLookups→AnimSounds), which frequently point at a WAV in
   *  a DIFFERENT folder than the model — e.g. FrostWyrmMissile.mdx's sound lives in the
   *  FireBallMissile folder, so a scan of the model's own folder finds nothing. Falls
   *  back to a keyword folder scan for the rare missile that carries no SND event but
   *  does ship a launch/impact WAV alongside its model. */
  playMissile(missileArt: string, kind: "launch" | "impact", at?: SoundPos): void {
    if (!missileArt) return;
    const ms = this.resolveModelSounds(missileArt);
    const clips = kind === "launch" ? ms.launch : ms.impact;
    if (clips.length) {
      this.playPool(clips[(Math.random() * clips.length) | 0], "impact", at);
      return;
    }
    // Fallback: no SND event on the model — scan its folder for a matching WAV.
    const suffixes =
      kind === "impact"
        ? ["Death", "Impact", "MissileDeath", "MissileImpact", "Hit1", "Hit2", "Hit3", "Hit", "Target1", "MissileHit1", "1", "2", "3", ""]
        : ["Launch1", "Launch2", "Launch3", "Launch", "MissileLaunch1", "Attack1", "Attack2", "Attack", "1", "2", "3", ""];
    const paths = this.folderSounds(kind, missileArt, suffixes);
    // Folder WAVs carry no SLK metadata, so mark them WANT3D with WC3's typical
    // combat distances (min 600 / max 10000) — a missile whoosh is a world sound.
    // This clip stands in for the SND "M" event the model didn't carry, so budget it on
    // the channel that event would have resolved to (AnimSounds = 11) and let it preempt
    // the way all but a handful of that table's rows do.
    if (paths.length) this.playPool({ paths, gain: 0.7, pitch: 1, pitchVar: 0.06, threeD: true, refDist: 600, maxDist: 10000, cutoff: 3000, channel: 11, preempt: true }, "impact", at);
  }

  /** Play a unit's own attack/fire sound — the SND "K" event embedded in its model
   *  (Rifleman gunshot, Mortar boom, dragon breath, tower fire), fired at the swing's
   *  damage point. No-op for melee units whose model carries no such event: their
   *  audible attack is the weapon-impact clang (playImpact), not a fire sound. */
  playModelAttack(modelArt: string, at?: SoundPos): void {
    if (!modelArt) return;
    const clips = this.resolveModelSounds(modelArt).attack;
    if (clips.length) this.playPool(clips[(Math.random() * clips.length) | 0], "impact", at);
  }

  /** Play the sound an EFFECT MODEL carries itself — an SND "A" event object, fired by
   *  WC3 at the moment that model's clip plays. This is the authentic chain and beats any
   *  folder guess: Flame Strike's warning vortex (FlameStrikeTarget.mdx) holds SND…AHFT →
   *  AnimLookups → AnimSounds "FlameStrikeTarget" → FlameStrikeTargetWaveNonLoop1.wav,
   *  while its pillar (FlameStrike1.mdx) holds SND…AHFS → FlameStrikeBirth1.wav. Both WAVs
   *  sit in the same folder, so a folder scan can only guess between them.
   *  @returns whether the model carried such an event (and the clip was cued). */
  playModelSound(art: string, at?: SoundPos): boolean {
    if (!art) return false;
    const clips = this.resolveModelSounds(art).ability;
    if (!clips.length) return false;
    this.playPool(clips[(Math.random() * clips.length) | 0], "spell", at);
    return true;
  }

  /** Play a spell's cast/effect sound. Prefers the effect model's own embedded SND "A"
   *  event (see playModelSound), and only then falls back to a WAV that ships in the
   *  effect model's folder (HolyBoltSpecialArt.mdx → HolyBolt.wav, HealTarget.mdx →
   *  HealTarget.wav, AvatarCaster.mdx → Avatar.wav, …), then a curated fallback path. */
  playSpellSound(arts: string[], fallback?: string, at?: SoundPos): void {
    for (const art of arts) if (art && this.playModelSound(art, at)) return;
    // As with missiles, effect-folder WAVs have no SLK row — treat them as WANT3D
    // world sounds so a spell cast pans + attenuates from where it's cast.
    const meta = { gain: 0.8, pitch: 1, pitchVar: 0.03, threeD: true, refDist: 800, maxDist: 10000, cutoff: 3500 };
    // A cast sound is player-initiated and one-per-cast — route it through the
    // uncapped "spell" channel, NOT the shared weapon-impact pool. That pool sits
    // at its MAX_IMPACTS cap all through a fight, so casting a spell mid-combat
    // (Thunder Clap, etc.) used to be silently dropped after the first time the
    // slots filled — "plays once, then never again" (issue #23). WC3 always plays them.
    for (const art of arts) {
      if (!art) continue;
      // "2"/"3" pick up the numbered variants WC3 ships for a repeated effect sound
      // (BlizzardTarget1/2/3.wav) — playPool then picks one at random per cast/wave.
      const paths = this.folderSounds("cast", art, ["", "1", "2", "3", "Cast", "Target", "Caster", "Death"]);
      if (paths.length) {
        this.playPool({ paths, ...meta }, "spell", at);
        return;
      }
    }
    if (fallback && this.vfs.exists(fallback)) this.playPool({ paths: [fallback], ...meta }, "spell", at);
  }

  private soundCache = new Map<string, string[]>();
  /** Resolve WAV variants living in a model's own folder, keyed off the model base
   *  and the folder name (WC3 naming isn't consistent — ArrowMissile.mdx →
   *  ArrowImpact.wav uses the folder name, HealTarget.mdx → HealTarget.wav the base). */
  private folderSounds(kind: string, art: string, suffixes: string[]): string[] {
    const cacheKey = `${kind}|${art}`;
    const cached = this.soundCache.get(cacheKey);
    if (cached) return cached;
    const out: string[] = [];
    const m = /^(.*[\\/])([^\\/]+)\.mdx$/i.exec(art);
    if (m) {
      const folder = m[1];
      const base = m[2];
      const folderName = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? base;
      for (const b of base === folderName ? [base] : [base, folderName]) {
        for (const s of suffixes) {
          const p = `${folder}${b}${s}.wav`;
          if (this.vfs.exists(p)) out.push(p);
        }
        if (out.length) break;
      }
      // Fallback: many missile folders name their WAVs after the HERO, not the
      // model — BloodElfMissile\BloodMageRangedAttack.wav, KeeperGroveMissile\
      // KeeperOfTheGroveMissileLaunch1.wav, ShadowHunterMissile\HeroShadow…Hit1.wav.
      // The exact base is undiscoverable, so scan the folder (from the MPQ listfile)
      // for any .wav whose name matches this launch/impact/cast phase by keyword.
      if (!out.length) out.push(...this.scanFolderWavs(folder, kind));
    }
    this.soundCache.set(cacheKey, out);
    return out;
  }

  private modelSounds = new Map<string, ModelSounds>();
  /** Resolve a model's embedded sounds — the SND event objects WC3 fires during the
   *  attack/flight/effect animation. The 4-char event code (e.g. "KRIF") maps through
   *  AnimLookups (→ SoundLabel) then AnimSounds (→ WAVs + 3D metadata). Cached per model
   *  path — the MDX is parsed once, lazily on first use. We take K (a unit's fire sound),
   *  M (a missile's launch/impact) and A (an effect model's own spell sound); D (death) is
   *  played via the unit's sound-set label instead. */
  private resolveModelSounds(modelArt: string): ModelSounds {
    const key = modelArt.toLowerCase();
    const cached = this.modelSounds.get(key);
    if (cached) return cached;
    const out: ModelSounds = { attack: [], launch: [], impact: [], ability: [] };
    this.modelSounds.set(key, out); // memoize up-front so a missing/broken model isn't re-parsed
    const bytes = this.vfs.rawBytes(modelArt);
    if (!bytes) return out;
    let model: MdlxModel;
    try {
      model = new MdlxModel();
      model.load(bytes);
    } catch {
      return out; // unparseable model — stay silent rather than throw mid-combat
    }
    for (const evt of model.eventObjects) {
      // Event-object names are "SND" + a 1-char separator + a 4-char code ("SNDXKRIF").
      if (evt.name.substring(0, 3) !== "SND") continue;
      const id = evt.name.substring(4);
      const cat = id[0]; // K = attack, M = missile, D = death, A = ability
      if (cat !== "K" && cat !== "M" && cat !== "A") continue;
      const label = this.animLabel(id);
      if (!label) continue;
      const clip = this.resolve("anim", label); // AnimSounds row → clip (vol/pitch/3D/dist)
      if (!clip) continue;
      if (cat === "K") out.attack.push(clip);
      else if (cat === "A") out.ability.push(clip);
      else if (/launch/i.test(label)) out.launch.push(clip);
      else out.impact.push(clip); // "…Hit"/"…Impact", or a single generic missile sound
    }
    return out;
  }

  // Lazy index: lowercased folder path → the .wav files the listfile knows it holds.
  private wavFolders: Map<string, string[]> | null = null;
  private wavIndex(): Map<string, string[]> {
    if (this.wavFolders) return this.wavFolders;
    const idx = new Map<string, string[]>();
    for (const name of this.vfs.list()) {
      if (!/\.wav$/i.test(name)) continue;
      const p = name.replace(/\//g, "\\");
      const slash = p.lastIndexOf("\\");
      if (slash < 0) continue;
      const folder = p.slice(0, slash + 1).toLowerCase();
      (idx.get(folder) ?? idx.set(folder, []).get(folder)!).push(p);
    }
    this.wavFolders = idx;
    return idx;
  }

  /** Any .wav in `folder` whose name matches the given sound phase by keyword —
   *  used when the WAV isn't named after its model (hero-named missile sounds). */
  private scanFolderWavs(folder: string, kind: string): string[] {
    const files = this.wavIndex().get(folder.toLowerCase());
    if (!files) return [];
    const want =
      kind === "impact"
        ? /(hit|death|impact|target)/i
        : kind === "launch"
          ? /(launch|attack|throw|birth|ranged)/i
          : /./; // cast: any wav in the effect folder
    const matched = files.filter((f) => want.test(f.split("\\").pop() ?? ""));
    return matched.length ? matched : kind === "launch" || kind === "impact" ? [] : files;
  }

  /** Play a named interface sound from UISounds.slk (button click, place building,
   *  rally point, error, …) as a fire-and-forget one-shot. */
  playUi(name: string): void {
    this.playPool(this.resolve("ui", name), "ui");
  }

  /** Play a sound an ability names in its `Effectsound` field, by its AbilitySounds.slk
   *  label (`PowerupSound` → Abilities\Spells\Items\AIam\Tomes.wav, `ReceiveGold`,
   *  `ReceiveLumber`). A LABEL, not a path: the row carries the WAV name, its folder and
   *  the 3D metadata, so unlike a folder-scanned effect WAV this one needs no synthesized
   *  distances. Positional — a rune popped across the map should sound like it. Routed to
   *  the uncapped "spell" channel for the same reason cast sounds are (issue #23): the
   *  shared impact pool sits at its cap through a fight and would silently drop it. */
  playAbilitySound(label: string, at?: SoundPos): void {
    if (label) this.playPool(this.resolve("ability", label), "spell", at);
  }

  /** Play the sound an MDX SND event object names, by its 4-char code — the same
   *  AnimLookups → AnimSounds chain resolveModelSounds walks, but fired by a caller that
   *  is driving the animation ITSELF rather than letting the model's category decide. The
   *  glue menus are that caller: the panel chrome's whooshes are SND events sitting on the
   *  first frame of each screen's Birth/Death clip (TopRightPanel-Expansion.mdx fires
   *  SNDXARPD at frame 2500, where "MainMenu Birth" begins → "RightGlueScreenPopDown" →
   *  Sound\Interface\RightGlueScreenPopDown.wav), and we play those clips ourselves. */
  playAnimEvent(code: string): void {
    const label = this.animLabel(code);
    if (label) this.playPool(this.resolve("anim", label), "ui");
  }

  /** AnimLookups.slk: a 4-char SND event code ("KRIF", "ARPD") → its SoundLabel. */
  private animLabel(code: string): string | null {
    const lookups = this.tables.get("animlookups") ?? null;
    const actual = lookups?.index.get(code.toLowerCase()) ?? code;
    const row = lookups?.data.getRow(actual) as { string(k: string): string | undefined } | undefined;
    return row?.string("SoundLabel") ?? null;
  }

  /** Play a named ambience sound from AmbienceSounds.slk. Blizzard.j's InitDNCSounds
   *  uses two of these: "RoosterSound" at dawn, "WolfSound" at dusk. Not positional
   *  (the rows carry no WANT3D flag) — the whole map hears them. */
  playAmbience(name: string): void {
    this.playPool(this.resolve("ambience", name), "ui", undefined, VG_AMBIENT);
  }

  /** Start/stop a named looping sound from UISounds.slk (e.g. building construction).
   *  Idempotent. */
  setLoop(name: string, on: boolean): void {
    this.namedLoop(name, on, "ui");
  }

  /** Start/stop a named looping sound from AmbienceSounds.slk. The rows that carry the
   *  LOOPING flag are the sustained beds: a waterfall, a brazier — and the glue screen's
   *  own wind ("ExpansionGlueScreenWind" → Sound\Ambient\War3XMainGlueScreen.wav), which
   *  is the bed under the main menu. An AMBIENTSOUNDS volume-group sound, not a UI one. */
  setAmbienceLoop(name: string, on: boolean): void {
    this.namedLoop(name, on, "ambience", VG_AMBIENT);
  }

  private namedLoop(name: string, on: boolean, tag: string, group?: number): void {
    if (!on) {
      this.pendingLoops.delete(name);
      const src = this.loops.get(name);
      if (!src) return;
      this.loops.delete(name);
      try { src.stop(); } catch { /* not started yet / already stopped */ }
      return;
    }
    if (this.loops.has(name)) return;
    const clip = this.resolve(tag, name);
    if (!clip || !clip.paths.length) return;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") {
      // The browser's autoplay gate hasn't opened yet. A one-shot would simply be missed,
      // but a LOOP is a standing request — the menu's wind is meant to be there from the
      // moment the menu is. Remember it and start it when the context comes up, exactly as
      // startPendingMusic does for a playlist cued before the first gesture.
      this.pendingLoops.set(name, { tag, group });
      return;
    }
    this.pendingLoops.delete(name);
    this.startNamedLoop(name, clip, group);
  }

  /** Cue a resolved loop on a context that is known to be running. Deliberately does NOT
   *  call unlock(): unlock() is what drains the pending list, so a loop that asked for the
   *  unlock would be re-entered from inside its own call and recurse until the stack blew. */
  private startNamedLoop(name: string, clip: Clip, group?: number): void {
    const placeholder = {} as AudioBufferSourceNode;
    this.loops.set(name, placeholder); // reserve synchronously so we don't double-start
    const path = clip.paths[(Math.random() * clip.paths.length) | 0];
    void this.buffer(path).then((buf) => {
      if (!buf || !this.ctx || !this.master || this.loops.get(name) !== placeholder) return;
      const src = this.source(buf, clip);
      src.loop = true;
      src.connect(this.gain(clip.gain, group)).connect(this.master);
      this.loops.set(name, src);
      src.start();
    });
  }

  private startPendingLoops(): void {
    if (this.ctx?.state !== "running") return;
    for (const [name, { tag, group }] of [...this.pendingLoops]) {
      this.pendingLoops.delete(name);
      if (this.loops.has(name)) continue;
      const clip = this.resolve(tag, name);
      if (clip?.paths.length) this.startNamedLoop(name, clip, group);
    }
  }

  /** Start/stop a looping WAV given straight by PATH, positioned in the world — the
   *  sustained bed under a channelled spell (Blizzard's BlizzardLoop1.wav). Distinct
   *  from `setLoop`, which resolves a named row out of UISounds.slk; these effect-folder
   *  WAVs have no SLK row at all. Idempotent, and keyed per caster.
   *  The panner is placed once at `at` — a channelled field never moves.
   *
   *  The never-stack rule reaches a sustained bed too, and it is where WC3 states it
   *  outright: the looping construction/movement rows of AmbienceSounds.slk are exactly
   *  the ones flagged NODUPLICATES (see pickVariant). So two Blizzards cast at once are
   *  two fields but ONE howl — the second caster queues behind the first instead of
   *  laying an identical loop over it, and inherits the bed if its own field outlives
   *  the owner's. */
  setPathLoop(key: string, path: string, on: boolean, at?: SoundPos): void {
    if (on) {
      if (this.loops.has(key) || this.loopFile.get(key) === path) return;
      if (!path || !this.vfs.exists(path)) return;
      const owner = this.loopOwner.get(path);
      if (owner !== undefined && owner !== key) {
        const queue = this.loopQueue.get(path) ?? this.loopQueue.set(path, []).get(path)!;
        queue.push({ key, at });
        this.loopFile.set(key, path);
        return;
      }
      this.unlock();
      if (!this.ctx || !this.master || this.ctx.state !== "running") return;
      const placeholder = {} as AudioBufferSourceNode;
      this.loops.set(key, placeholder); // reserve synchronously so we don't double-start
      this.loopOwner.set(path, key);
      this.loopFile.set(key, path);
      const clip: Clip = { paths: [path], gain: 0.6, pitch: 1, pitchVar: 0, threeD: true, refDist: 800, maxDist: 10000, cutoff: 0 };
      void this.buffer(path).then((buf) => {
        // Bail if the loop was stopped (or restarted) while the WAV was decoding —
        // otherwise a Blizzard cancelled mid-load leaves its wind howling forever.
        if (!buf || !this.ctx || !this.master || this.loops.get(key) !== placeholder) return;
        const src = this.source(buf, clip);
        src.loop = true;
        const g = src.connect(this.gain(clip.gain));
        if (at && this.listener) g.connect(this.panner(clip, at)).connect(this.master);
        else g.connect(this.master);
        this.loops.set(key, src);
        src.start();
      });
    } else {
      // `path` is empty on the stop call (the caller only kept the key), so the file this
      // key was playing — or waiting for — is looked up rather than passed in.
      const file = this.loopFile.get(key);
      this.loopFile.delete(key);
      const src = this.loops.get(key);
      if (src) {
        this.loops.delete(key);
        try { src.stop(); } catch { /* not started yet / already stopped */ }
      }
      if (!file) return;
      const queue = this.loopQueue.get(file);
      if (this.loopOwner.get(file) !== key) {
        // A field that ended while still queued behind another caster's bed.
        const i = queue?.findIndex((w) => w.key === key) ?? -1;
        if (i >= 0) queue!.splice(i, 1);
        return;
      }
      this.loopOwner.delete(file);
      const next = queue?.shift();
      if (next) {
        this.loopFile.delete(next.key); // it's no longer waiting — let the start path run
        this.setPathLoop(next.key, file, true, next.at); // the bed carries on at their spot
      }
    }
  }

  // ===== The trigger script's sounds + music (7.20) ==================================
  // Everything above is the ENGINE's own audio (a unit's voice, a weapon clang, a spell).
  // What follows is the MAP SCRIPT's: the `sound` handle family and the music interface.
  //
  // The crucial difference is that a JASS `sound` is a **configured playback object**, not
  // a fire-and-forget clip. A map builds each one once, in InitSounds():
  //
  //     set gg_snd_N03Tyrande01 = CreateSound("Sound\Dialogue\…\N03Tyrande01.mp3", …)
  //     call SetSoundParamsFromLabel(gg_snd_N03Tyrande01, "N03Tyrande01")
  //     call SetSoundDuration(gg_snd_N03Tyrande01, 14158)
  //
  // …and then Starts / Stops / repositions **that same handle** for the rest of the game.
  // So these methods are keyed by the handle's id, where the pools above are anonymous.

  /** Resolve a sound LABEL to its row's playback parameters, searching every SoundInfo
   *  table (one label namespace spans them — see LABEL_TABLES). This is what
   *  `SetSoundParamsFromLabel` copies onto a handle and what `CreateSoundFromLabel`
   *  builds one from.
   *
   *  Note what it does NOT do: it never changes the handle's FILE. `CreateSound` was
   *  given an exact path, and a label's row usually lists several variants — a map that
   *  says CreateSound("…\DeathKnightPissed6.wav") + SetSoundParamsFromLabel("HeroDeathKnight
   *  Pissed") wants *that* line with the sound-set's volume/3D metadata, not a random one
   *  of the six. Only CreateSoundFromLabel (which is given no file) takes `files` from here. */
  labelParams(label: string): SoundLabelParams | null {
    if (!label) return null;
    for (const tag of LABEL_TABLES) {
      const clip = this.resolve(tag, label);
      if (!clip) continue;
      return {
        files: clip.paths,
        volume: clip.volume127 ?? 127,
        pitch: clip.pitch,
        pitchVar: clip.pitchVar,
        channel: clip.channel ?? 0,
        threeD: clip.threeD,
        minDist: clip.refDist,
        maxDist: clip.maxDist,
        cutoff: clip.cutoff,
      };
    }
    return null;
  }

  /** StartSound — play (or restart) the sound handle `id` with the spec the script has
   *  configured on it. A 3D sound past its DistanceCutoff isn't played at all, exactly as
   *  in the engine-side pools. Returns whether playback was actually committed (the file
   *  resolved and the context is live) — the caller reports that as GetSoundIsPlaying. */
  playScript(id: number, s: ScriptSoundSpec): boolean {
    this.stopScript(id, false); // StartSound on a live handle restarts it
    if (!s.file || !this.vfs.exists(s.file)) return false;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return false;
    const positional = s.is3D && !!s.at && !!this.listener;
    if (positional && s.cutoff > 0 && this.distanceTo(s.at!) > s.cutoff) return false;
    // Reserve the slot synchronously: the WAV decodes async, and a script that calls
    // StartSound then StopSound in the same tick (or asks GetSoundIsPlaying) must see it.
    const token: ScriptVoice = { src: null, gain: null, panner: null };
    this.scripts.set(id, token);
    void this.buffer(s.file).then((buf) => {
      if (!buf || !this.ctx || !this.master || this.scripts.get(id) !== token) return;
      const clip: Clip = {
        paths: [s.file],
        gain: Math.max(0, Math.min(1, s.volume / 127)),
        pitch: s.pitch > 0 ? s.pitch : 1,
        pitchVar: 0, // a script sets an exact pitch; the SLK's RANDOMPITCH jitter is the engine's
        threeD: s.is3D,
        refDist: s.minDist,
        maxDist: s.maxDist,
        cutoff: s.cutoff,
      };
      const src = this.source(buf, clip);
      src.loop = s.looping;
      const gain = this.gain(clip.gain);
      const out: AudioNode = src.connect(gain);
      if (positional) {
        const panner = this.panner(clip, s.at!);
        applyCone(panner, s);
        out.connect(panner).connect(this.master);
        token.panner = panner;
      } else {
        out.connect(this.master);
      }
      token.src = src;
      token.gain = gain;
      src.onended = () => {
        if (this.scripts.get(id) === token) this.scripts.delete(id);
      };
      src.start();
    });
    return true;
  }

  /** StopSound(snd, killWhenDone, fadeOut). WC3's fade rates (CreateSound's fadeInRate /
   *  fadeOutRate — 10 in every World-Editor-emitted sound, 12700 in blizzard.j's PlaySound)
   *  are in units no file we have documents, so rather than invent a rate→seconds curve we
   *  ramp over a short fixed FADE_SECONDS and say so. Everything else here is exact. */
  stopScript(id: number, fadeOut: boolean): void {
    const v = this.scripts.get(id);
    if (!v) return;
    this.scripts.delete(id);
    const src = v.src;
    if (!src) return; // still decoding — dropping the token above is what cancels it
    if (fadeOut && v.gain && this.ctx) {
      const now = this.ctx.currentTime;
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
      try { src.stop(now + FADE_SECONDS); } catch { /* already stopped */ }
    } else {
      try { src.stop(); } catch { /* not started yet / already stopped */ }
    }
  }

  /** GetSoundIsPlaying. True from the moment StartSound commits (through the decode) until
   *  the clip ends or is stopped. */
  isScriptPlaying(id: number): boolean {
    return this.scripts.has(id);
  }

  /** Re-place a playing 3D sound — SetSoundPosition on a live handle, and the per-frame
   *  update for one AttachSoundToUnit'd to a unit that is walking. */
  moveScript(id: number, at: SoundPos): void {
    const p = this.scripts.get(id)?.panner;
    if (!p) return;
    const z = at.z ?? 0;
    if (p.positionX) {
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = z;
    } else {
      p.setPosition?.(at.x, at.y, z);
    }
  }

  // --- music (SetMapMusic / PlayMusic / PlayThematicMusic) ---------------------------

  /** SetMapMusic(musicName, random, index) — and it starts playing: every one of the 165
   *  bundled maps calls it in main() and only one ever calls PlayMusic, yet every melee
   *  game has music. `musicName` is usually not a file but a PLAYLIST KEY resolved through
   *  UI\war3skins.txt against the local player's race — `SetMapMusic("Music", true, 0)`
   *  gives an Orc player the orc list and a Human player the human one. */
  setMapMusic(musicName: string, random: boolean, index: number): void {
    const list = this.musicPaths(musicName);
    if (!list.length) return;
    this.musicList = list;
    this.musicRandom = random;
    this.musicIndex = random ? Math.floor(Math.random() * list.length) : Math.max(0, Math.min(list.length - 1, index));
    this.musicPaused = false;
    this.startMusicTrack();
  }

  /** ClearMapMusic — the list is dropped; whatever is playing plays out. */
  clearMapMusic(): void {
    this.musicList = [];
  }

  /** PlayMusic / PlayMusicEx — play one track now (a file, or a playlist key: the engine
   *  accepts either, and PlayMusic on a list plays the list). */
  playMusic(musicName: string, fromMs = 0, _fadeInMs = 0): void {
    const list = this.musicPaths(musicName);
    if (!list.length) return;
    this.musicList = list;
    this.musicIndex = 0;
    this.musicPaused = false;
    this.startMusicTrack(fromMs / 1000);
  }

  stopMusic(fadeOut: boolean): void {
    this.musicPaused = true;
    this.fadeOutTrack(this.music, fadeOut);
    this.music = null;
    this.musicGen++; // a track still decoding must not start up after a StopMusic
    this.musicCueing = false;
  }

  /** ResumeMusic — pick the list back up where StopMusic left it. */
  resumeMusic(): void {
    if (!this.musicPaused || !this.musicList.length) return;
    this.musicPaused = false;
    this.startMusicTrack();
  }

  /** SetMusicVolume(0–127). Applied live — the music bus holds its own gain node. */
  setMusicVolume(volume127: number): void {
    this.musicVolume = Math.max(0, Math.min(1, volume127 / 127));
    this.applyMusicGain();
  }

  /** PlayThematicMusic — a one-off track that PRE-EMPTS the map music (a cinematic's
   *  theme). EndThematicMusic brings the map music back. */
  playThematicMusic(file: string, fromMs = 0): void {
    const paths = this.musicPaths(file);
    if (!paths.length) return;
    this.fadeOutTrack(this.thematic, true); // only one thematic track at a time
    this.thematic = null;
    // A thematic pre-empts the map music, but it is the SAME one channel — so it claims it
    // the same way, and a map-music track still decoding towards it is dropped rather than
    // allowed to start up underneath.
    const gen = this.claimMusicChannel();
    this.musicCueing = false;
    void this.startTrack(paths[0], fromMs / 1000).then((t) => {
      if (gen !== this.musicGen) {
        if (t) try { t.src.stop(); } catch { /* not started */ }
        return;
      }
      this.thematic = t;
      if (t) {
        t.src.onended = () => {
          if (this.thematic === t) {
            this.thematic = null;
            if (!this.musicPaused) this.startMusicTrack(); // the map music returns on its own
          }
        };
      }
    });
  }

  endThematicMusic(): void {
    if (!this.thematic) return;
    this.fadeOutTrack(this.thematic, true);
    this.thematic = null;
    if (!this.musicPaused) this.startMusicTrack();
  }

  /** Resolve a music name to real, existing files. A name with a path separator (or an
   *  audio extension) is a literal file; anything else is a war3skins.txt playlist key,
   *  looked up with the engine's version suffix (`Music` → `Music_V1` in TFT) in the
   *  local player's race section, falling back to `[Default]`. */
  private musicPaths(name: string): string[] {
    if (!name) return [];
    let candidates: string[];
    if (/[\\/]/.test(name) || /\.(mp3|wav)$/i.test(name)) {
      candidates = [name];
    } else {
      const skins = this.loadSkins();
      const list = skinValue(skins, this.musicSkin, name + SKIN_VERSION_SUFFIX) ?? skinValue(skins, this.musicSkin, name) ?? "";
      candidates = list.split(";");
    }
    return candidates.map((p) => p.trim().replace(/\//g, "\\")).filter((p) => p && this.vfs.exists(p));
  }

  private loadSkins(): Map<string, Map<string, string>> {
    if (!this.skins) {
      const bytes = this.vfs.rawBytes(WAR3SKINS);
      this.skins = bytes ? parseWar3Skins(new TextDecoder("latin1").decode(bytes)) : new Map();
    }
    return this.skins;
  }

  /** Cue the current playlist entry; when it ends, advance to the next (WC3's map music
   *  plays the list through, looping — `random` reshuffles instead of stepping). */
  private startMusicTrack(offsetSec = 0): void {
    const path = this.musicList[this.musicIndex];
    if (!path || this.thematic) return;
    const gen = this.claimMusicChannel(); // …before the decode, not after it (see musicGen)
    this.musicCueing = true; // the track decodes async — don't let the gate retry double-start it
    void this.startTrack(path, offsetSec).then((t) => {
      // Someone else asked for the channel while this mp3 was decoding: they own it now, and
      // this track must never be heard. (Without this it would src.start() into the mix and
      // nothing would hold its node to stop it again.)
      if (gen !== this.musicGen) {
        if (t) try { t.src.stop(); } catch { /* not started */ }
        return;
      }
      this.musicCueing = false;
      if (!t || this.musicPaused || this.thematic) {
        if (t) try { t.src.stop(); } catch { /* not started */ }
        return;
      }
      this.music = t;
      t.src.onended = () => {
        if (this.music !== t) return; // superseded — the new track owns the bus
        this.music = null;
        this.musicIndex = this.musicRandom
          ? Math.floor(Math.random() * this.musicList.length)
          : (this.musicIndex + 1) % Math.max(1, this.musicList.length);
        if (!this.musicPaused) this.startMusicTrack();
      };
    });
  }

  /** Take ownership of the one music channel: silence whatever holds it and invalidate any
   *  track still decoding towards it. Returns the caller's generation token — the caller is
   *  the owner only for as long as `musicGen` still equals it. */
  private claimMusicChannel(): number {
    this.fadeOutTrack(this.music, false);
    this.music = null;
    return ++this.musicGen;
  }

  /** Decode + start one music track on the music bus. Resolves to null if the context
   *  isn't running yet (autoplay gate) or the file won't decode. */
  private async startTrack(path: string, offsetSec: number): Promise<Track | null> {
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return null;
    const buf = await this.buffer(path);
    if (!buf || !this.ctx || !this.master) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = this.musicVolume * (this.groups[VG_MUSIC] ?? 1);
    src.connect(gain).connect(this.master);
    src.start(0, Math.max(0, offsetSec));
    return { src, gain };
  }

  private fadeOutTrack(t: Track | null, fade: boolean): void {
    if (!t) return;
    t.src.onended = null; // the list must not advance off a track WE stopped
    if (fade && this.ctx) {
      const now = this.ctx.currentTime;
      t.gain.gain.setValueAtTime(t.gain.gain.value, now);
      t.gain.gain.linearRampToValueAtTime(0, now + MUSIC_FADE_SECONDS);
      try { t.src.stop(now + MUSIC_FADE_SECONDS); } catch { /* already stopped */ }
    } else {
      try { t.src.stop(); } catch { /* already stopped */ }
    }
  }

  private applyMusicGain(): void {
    const v = this.musicVolume * (this.groups[VG_MUSIC] ?? 1);
    if (this.music) this.music.gain.gain.value = v;
    if (this.thematic) this.thematic.gain.gain.value = v;
  }

  /** GetSoundFileDuration(file) in ms. Decoding is async and the native is not, so this
   *  answers from the decoded-buffer cache and kicks off a decode when it misses (0 until
   *  then). In practice maps don't need it: the World Editor bakes the real length into
   *  the script as `SetSoundDuration(snd, 14158)`, which is what GetSoundDuration reads. */
  fileDurationMs(path: string): number {
    const cached = this.decoded.get(path);
    if (cached !== undefined) return Math.round(cached * 1000);
    if (this.vfs.exists(path)) void this.buffer(path);
    return 0;
  }

  /** @returns true once a new line is committed to `source` (loads/plays async); false
   *  if the request was dropped (source still talking, unready context, cap, no clip). */
  private playVoice(label: string, category: SoundCategory, source?: string | number): boolean {
    if (!VOICE_CATEGORIES.has(category)) return false;
    // A specific source gets one voice at a time; a source-less line gets a unique
    // key so it always overlaps rather than clashing on a shared channel.
    const key = source != null ? `s:${source}` : `anon:${this.voiceSeq++}`;
    if (this.voices.has(key)) return false; // this source is still talking — don't stack or cut it
    const clip = this.resolve("ack", label + category);
    if (!clip || !clip.paths.length) return false;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return false;
    if (this.voices.size >= MAX_VOICES) return false; // bound a pathological overlap burst
    // Never stack the same clip (pickVariant): a line still in the air isn't said a second
    // time even by a DIFFERENT unit — two Footmen answering with the same WAV on the same
    // frame is the doubling the rule exists to stop. A sound-set ships several variants, so
    // the second unit normally just takes another one; only when they're all up is it
    // dropped. Voices play 2D, so every copy ties on audibility and none is ever cut short.
    const choice = this.pickVariant(clip, null);
    if (!choice) return false;
    const path = choice.path;
    choice.taken?.kill();
    const placeholder = {} as AudioBufferSourceNode; // reserve the key synchronously
    this.voices.set(key, placeholder);
    const release = () => {
      if (this.playing.get(path) === active) this.playing.delete(path);
    };
    const active: ActiveFile = {
      clip,
      at: null,
      kill: () => {
        const cur = this.voices.get(key);
        if (cur) {
          this.voices.delete(key); // === placeholder: still decoding, and this cancels it
          if (cur !== placeholder) try { cur.stop(); } catch { /* already ended */ }
        }
        release();
      },
    };
    this.playing.set(path, active);
    void this.buffer(path).then((buf) => {
      if (!buf || !this.ctx || !this.master || this.voices.get(key) !== placeholder) {
        if (this.voices.get(key) === placeholder) this.voices.delete(key);
        release();
        return;
      }
      const src = this.source(buf, clip);
      src.connect(this.gain(clip.gain, VG_UNITSOUNDS)).connect(this.master);
      this.voices.set(key, src);
      src.onended = () => {
        if (this.voices.get(key) === src) this.voices.delete(key);
        release();
      };
      src.start();
      this.onVoiceStart?.(label, buf.duration);
    });
    return true; // key reserved for this source — the line is committed (loads async)
  }

  /** Play a clip on an overlapping one-shot pool. deaths/impacts are budgeted per SOUND
   *  CHANNEL — the clip's own `Channel` column, so a unit's fire sound (AnimSounds, 11)
   *  and the clang it lands (UnitCombatSounds, 5) never compete for one budget; a full
   *  channel preempts or refuses as the row's flags say (CHANNEL_VOICES). ui and spell
   *  aren't budgeted at all — a player-initiated cast sound must never lose its slot to
   *  the weapon-clang cap mid-fight (issue #23). A WANT3D clip with a world position
   *  pans + attenuates around the listener regardless of kind. */
  private playPool(clip: Clip | null, kind: "death" | "impact" | "ui" | "spell", at?: SoundPos, group = POOL_GROUP[kind]): void {
    if (!clip || !clip.paths.length) return;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    const positional = clip.threeD && !!at && !!this.listener;
    // WC3 DistanceCutoff: a positional sound past its cutoff isn't played at all —
    // drop it before reserving a pool slot so far-off battles don't starve the cap.
    if (positional && clip.cutoff > 0 && this.distanceTo(at!) > clip.cutoff) return;
    const where = positional ? at! : null;
    // Never stack the same clip: take a variant nobody is playing, or win one off the
    // least audible copy of it — and if we're the quiet one, stay silent (see pickVariant).
    const choice = this.pickVariant(clip, where);
    if (!choice) return;
    const path = choice.path;
    // Concurrency is budgeted per SOUND CHANNEL (see CHANNEL_VOICES). Reserve the slot
    // synchronously — the buffer loads async, so an AoE burst would otherwise slip the cap.
    let voices: PoolVoice[] | null = null;
    if (kind === "impact" || kind === "death") {
      const channel = clip.channel ?? 0;
      voices = this.channelVoices.get(channel) ?? this.channelVoices.set(channel, []).get(channel)!;
      // No preempt flag (UnitCombatSounds) — a full channel refuses the sound. Checked
      // BEFORE anything is cut, so a refusal here never costs a copy we were going to
      // take over: the channel is full either way and we'd have silenced one for nothing.
      if (voices.length >= CHANNEL_VOICES && !clip.preempt) return;
    }
    choice.taken?.kill(); // the copy this one wins the file off (null if the variant was free)
    const voice: PoolVoice = { src: null, dead: false };
    if (voices && voices.length >= CHANNEL_VOICES) {
      const victim = voices.shift(); // …CHANNELFULLPREEMPT: steal the channel's longest-running voice
      if (victim) {
        victim.dead = true;
        try {
          victim.src?.stop();
        } catch {
          /* already ended */
        }
      }
    }
    voices?.push(voice);
    const release = () => {
      if (voices) {
        const i = voices.indexOf(voice); // -1 once preempted: already shifted off
        if (i >= 0) voices.splice(i, 1);
      }
      // Identity-checked: a nearer copy may already own the file (it killed us and put
      // ITSELF in the map), and our late onended must not evict the live one.
      if (this.playing.get(path) === active) this.playing.delete(path);
    };
    const active: ActiveFile = {
      clip,
      at: where,
      kill: () => {
        voice.dead = true;
        try {
          voice.src?.stop();
        } catch {
          /* not started yet / already ended */
        }
        release();
      },
    };
    this.playing.set(path, active);
    void this.buffer(path).then((buf) => {
      // `voice.dead`: preempted while its buffer was still decoding — don't start it.
      if (!buf || !this.ctx || !this.master || voice.dead) {
        release();
        return;
      }
      const src = this.source(buf, clip);
      voice.src = src;
      const g = src.connect(this.gain(clip.gain, group));
      if (positional) g.connect(this.panner(clip, at!)).connect(this.master);
      else g.connect(this.master);
      src.onended = release;
      src.start();
    });
  }

  /** Distance from the listener to a world point (0 if no listener frame yet). */
  private distanceTo(at: SoundPos): number {
    const f = this.listener;
    if (!f) return 0;
    return Math.hypot(at.x - f.px, at.y - f.py, (at.z ?? 0) - f.pz);
  }

  /** How loudly a copy of a clip lands at the listener RIGHT NOW, 0..1: its own gain
   *  times the same linear MinDistance→MaxDistance falloff the PannerNode applies, and
   *  0 once past the row's DistanceCutoff — out there WC3 doesn't play the sound at all,
   *  so a copy that far away is, to this client, not playing. A 2D clip (no WANT3D, or
   *  no listener frame yet) is always at full audibility. */
  private audibility(clip: Clip, at: SoundPos | null): number {
    if (!at || !clip.threeD || !this.listener) return clip.gain;
    const d = this.distanceTo(at);
    if (clip.cutoff > 0 && d > clip.cutoff) return 0;
    const ref = Math.max(1, clip.refDist);
    const max = Math.max(ref + 1, clip.maxDist || ref + 1);
    return clip.gain * (1 - Math.max(0, Math.min(d, max) - ref) / (max - ref));
  }

  /** The never-stack rule (issue #84): a given WAV is only ever in the air ONCE per
   *  client — two sources landing the same clip at the same instant phase against each
   *  other into a doubled, metallic smear instead of one clean sound.
   *
   *  WC3 spells the policy out itself on the rows where this bites hardest: every
   *  unit-movement and building-construction row of AmbienceSounds.slk (89 of them)
   *  carries `NODUPLICATES,SCALEPRIORITY` — one copy only, and *which* source owns it is
   *  decided by DISTANCE. (UISounds.slk says the same thing in plain English on
   *  GlueScreenClick: "Use NODUPLICATES flag to prevent douple playing of this sound by
   *  cancel buttons.") So the rule here is that pair, applied to every one-shot:
   *
   *    1. Prefer a variant nobody is playing. A weapon clang ships 3–4 WAVs precisely so
   *       a melee can sound like a melee; two units landing blows should take different
   *       ones rather than one of them falling silent.
   *    2. Only when every variant is up, challenge the LEAST AUDIBLE copy. Audibility is
   *       recomputed at the moment of the challenge, not remembered from when the copy
   *       started — the camera moves, so a clang that began in earshot may be well out of
   *       it by now. An out-of-earshot copy scores 0 and therefore never blocks a sound
   *       the player can actually hear; a nearer source takes the file off it, a further
   *       one is refused (it would have been the quieter of the two anyway).
   *
   *  @returns the path to play plus the copy to cut for it, or null to refuse outright. */
  private pickVariant(clip: Clip, at: SoundPos | null): { path: string; taken: ActiveFile | null } | null {
    const free = clip.paths.filter((p) => !this.playing.has(p));
    if (free.length) return { path: free[(Math.random() * free.length) | 0], taken: null };
    let path = clip.paths[0];
    let taken = this.playing.get(path)!;
    let quietest = this.audibility(taken.clip, taken.at);
    for (const p of clip.paths) {
      const live = this.playing.get(p)!;
      const a = this.audibility(live.clip, live.at);
      if (a < quietest) {
        quietest = a;
        taken = live;
        path = p;
      }
    }
    return this.audibility(clip, at) > quietest ? { path, taken } : null;
  }

  /** Build a positional node for a WANT3D clip: equalpower stereo pan (WC3 isn't
   *  HRTF) with a linear MinDistance→MaxDistance falloff, placed at the source. */
  private panner(clip: Clip, at: SoundPos): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = "equalpower";
    p.distanceModel = "linear"; // full within MinDistance, silent by MaxDistance
    p.refDistance = Math.max(1, clip.refDist);
    p.maxDistance = Math.max(p.refDistance + 1, clip.maxDist || p.refDistance + 1);
    p.rolloffFactor = 1;
    const z = at.z ?? 0;
    if (p.positionX) {
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = z;
    } else {
      p.setPosition?.(at.x, at.y, z);
    }
    return p;
  }

  private source(buf: AudioBuffer, clip: Clip): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    if (clip.pitchVar) src.playbackRate.value = clip.pitch + (Math.random() * 2 - 1) * clip.pitchVar;
    else if (clip.pitch !== 1) src.playbackRate.value = clip.pitch;
    return src;
  }

  /** A gain node at `value`, scaled by its `volumegroup` (VolumeGroupSetVolume). The
   *  scale is applied at START, so a group change affects sounds cued after it — fine
   *  for the one-shot pools (they're a second long); the music bus holds a live gain. */
  private gain(value: number, group?: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = value * (group === undefined ? 1 : this.groups[group] ?? 1);
    return g;
  }

  /** VolumeGroupSetVolume(vgroup, scale) — 0–1, per SOUND_VOLUMEGROUP_* index. */
  setVolumeGroup(group: number, scale: number): void {
    if (group < 0 || group >= VOLUME_GROUPS) return;
    this.groups[group] = Math.max(0, Math.min(1, scale));
    if (group === VG_MUSIC) this.applyMusicGain();
  }

  /** VolumeGroupReset — back to full on every group. */
  resetVolumeGroups(): void {
    this.groups.fill(1);
    this.applyMusicGain();
  }

  /** Resolve a table row → clip metadata, memoized. Row lookup is case-insensitive. */
  private resolve(tag: string, key: string): Clip | null {
    const memo = `${tag}|${key.toLowerCase()}`;
    const hit = this.clips.get(memo);
    if (hit !== undefined) return hit;
    const table = this.tables.get(tag) ?? null;
    const actual = table?.index.get(key.toLowerCase()) ?? key;
    const row = table?.data.getRow(actual) as { string(k: string): string | undefined } | undefined;
    let clip: Clip | null = null;
    if (row) {
      const dir = row.string("directorybase") ?? "";
      const files = (row.string("filenames") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (files.length) {
        const vol = parseFloat(row.string("volume") ?? "127");
        const pitch = parseFloat(row.string("pitch") ?? "1");
        const flags = row.string("flags") ?? "";
        const pv = /RANDOMPITCH/i.test(flags) ? parseFloat(row.string("pitchvariance") ?? "0") : 0;
        // Positional-audio metadata (UnitCombatSounds/AnimSounds carry WANT3D + the
        // MinDistance/MaxDistance/DistanceCutoff triple; UISounds are Flags=0 → 2D).
        const num = (k: string) => {
          const n = parseFloat(row.string(k) ?? "0");
          return Number.isFinite(n) ? n : 0;
        };
        clip = {
          // Join with exactly one separator. The tables are NOT consistent about it:
          // AnimSounds carries a trailing backslash on DirectoryBase
          // ("Abilities\Spells\Items\AIam\") while AbilitySounds does not
          // ("Abilities\Spells\Items\AIam"), so plain concatenation silently yields
          // "…\AIamTomes.wav" for every AbilitySounds row — a path that resolves to
          // nothing. Only bit once something played those labels (a rune's Effectsound
          // is its ONLY sound source, so the whole table was mute).
          paths: files.map((f) => (dir ? dir.replace(/[\\/]+$/, "") + "\\" + f : f).replace(/\//g, "\\")),
          gain: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol / 127)) : 1,
          volume127: Number.isFinite(vol) ? vol : 127,
          pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : 1,
          pitchVar: Number.isFinite(pv) ? pv : 0,
          channel: num("channel"),
          threeD: /WANT3D/i.test(flags),
          refDist: num("mindistance"),
          maxDist: num("maxdistance"),
          cutoff: num("distancecutoff"),
          // (NODUPLICATES isn't read: never-stacking is now the rule for EVERY clip, not
          // the 160 rows that ask for it — see pickVariant.)
          preempt: /CHANNELFULLPREEMPT/i.test(flags), // also matches …PREEMPTOLDEST
        };
      }
    }
    this.clips.set(memo, clip);
    return clip;
  }

  /** Decode (and cache) a WAV file's AudioBuffer. */
  private buffer(path: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(path);
    if (!p) {
      p = this.decode(path);
      this.buffers.set(path, p);
    }
    return p;
  }

  private async decode(path: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    try {
      const bytes = await this.vfs.read(path);
      // Copy into a standalone ArrayBuffer — decodeAudioData detaches it, and the
      // Uint8Array may be a view onto a larger pooled buffer.
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const buf = await this.ctx.decodeAudioData(ab);
      this.decoded.set(path, buf.duration); // so GetSoundFileDuration can answer synchronously
      return buf;
    } catch {
      return null;
    }
  }
}
