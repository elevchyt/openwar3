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
const VG_UNITSOUNDS = 1;
const VG_COMBAT = 2;
const VG_SPELLS = 3;
const VG_UI = 4;
const VG_MUSIC = 5;
const VG_AMBIENT = 6;
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

const MAX_DEATHS = 4; // concurrent death cries
const MAX_IMPACTS = 5; // concurrent weapon-impact / chop clangs
const MAX_VOICES = 8; // concurrent voice lines across all sources (safety cap on overlap)

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
  // Flags contains NODUPLICATES: the engine refuses to start the sound while a copy of it
  // is already playing. UISounds.slk says why in its own comment column, on the very row
  // this matters for: GlueScreenClick, "Use NODUPLICATES flag to prevent douple playing of
  // this sound by cancel buttons." Absent on the clips we synthesize for folder WAVs.
  noDup?: boolean;
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
  private deaths = 0;
  private impacts = 0;
  private loops = new Map<string, AudioBufferSourceNode>(); // active looping sounds by name
  /** Files a NODUPLICATES clip currently has in the air (see playPool). */
  private playing = new Set<string>();
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
    if (paths.length) this.playPool({ paths, gain: 0.7, pitch: 1, pitchVar: 0.06, threeD: true, refDist: 600, maxDist: 10000, cutoff: 3000 }, "impact", at);
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
   *  WAVs have no SLK row at all. Idempotent, and keyed so each caster loops separately.
   *  The panner is placed once at `at` — a channelled field never moves. */
  setPathLoop(key: string, path: string, on: boolean, at?: SoundPos): void {
    if (on) {
      if (this.loops.has(key)) return;
      if (!path || !this.vfs.exists(path)) return;
      this.unlock();
      if (!this.ctx || !this.master || this.ctx.state !== "running") return;
      const placeholder = {} as AudioBufferSourceNode;
      this.loops.set(key, placeholder); // reserve synchronously so we don't double-start
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
      const src = this.loops.get(key);
      if (!src) return;
      this.loops.delete(key);
      try { src.stop(); } catch { /* not started yet / already stopped */ }
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
    const placeholder = {} as AudioBufferSourceNode; // reserve the key synchronously
    this.voices.set(key, placeholder);
    const path = clip.paths[(Math.random() * clip.paths.length) | 0];
    void this.buffer(path).then((buf) => {
      if (!buf || !this.ctx || !this.master || this.voices.get(key) !== placeholder) {
        if (this.voices.get(key) === placeholder) this.voices.delete(key);
        return;
      }
      const src = this.source(buf, clip);
      src.connect(this.gain(clip.gain, VG_UNITSOUNDS)).connect(this.master);
      this.voices.set(key, src);
      src.onended = () => {
        if (this.voices.get(key) === src) this.voices.delete(key);
      };
      src.start();
      this.onVoiceStart?.(label, buf.duration);
    });
    return true; // key reserved for this source — the line is committed (loads async)
  }

  /** Play a clip on an overlapping one-shot pool. deaths/impacts are concurrency-
   *  capped (reserved synchronously so an AoE burst can't slip the cap); ui and
   *  spell aren't — a player-initiated cast sound must never lose its slot to the
   *  weapon-clang cap mid-fight (issue #23). A WANT3D clip with a world position
   *  pans + attenuates around the listener regardless of kind. */
  private playPool(clip: Clip | null, kind: "death" | "impact" | "ui" | "spell", at?: SoundPos, group = POOL_GROUP[kind]): void {
    if (!clip || !clip.paths.length) return;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    const positional = clip.threeD && !!at && !!this.listener;
    // WC3 DistanceCutoff: a positional sound past its cutoff isn't played at all —
    // drop it before reserving a pool slot so far-off battles don't starve the cap.
    if (positional && clip.cutoff > 0 && this.distanceTo(at!) > clip.cutoff) return;
    const path = clip.paths[(Math.random() * clip.paths.length) | 0];
    // NODUPLICATES: a second copy of a sound already playing is refused, not stacked —
    // what keeps a double-clicked menu button from playing BigButtonClick twice over
    // itself. Keyed by FILE, since that is what "the same sound" means to the engine.
    if (clip.noDup && this.playing.has(path)) return;
    if (kind === "death") {
      if (this.deaths >= MAX_DEATHS) return;
      this.deaths++;
    } else if (kind === "impact") {
      if (this.impacts >= MAX_IMPACTS) return;
      this.impacts++;
    }
    if (clip.noDup) this.playing.add(path);
    const release = () => {
      if (kind === "death") this.deaths--;
      else if (kind === "impact") this.impacts--;
      if (clip.noDup) this.playing.delete(path);
    };
    void this.buffer(path).then((buf) => {
      if (!buf || !this.ctx || !this.master) {
        release();
        return;
      }
      const src = this.source(buf, clip);
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
          paths: files.map((f) => (dir + f).replace(/\//g, "\\")),
          gain: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol / 127)) : 1,
          volume127: Number.isFinite(vol) ? vol : 127,
          pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : 1,
          pitchVar: Number.isFinite(pv) ? pv : 0,
          channel: num("channel"),
          threeD: /WANT3D/i.test(flags),
          refDist: num("mindistance"),
          maxDist: num("maxdistance"),
          cutoff: num("distancecutoff"),
          noDup: /NODUPLICATES/i.test(flags),
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
