import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import MdlxModel from "mdx-m3-viewer/dist/cjs/parsers/mdlx/model";
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
const ANIMLOOKUPS_TABLE = "UI\\SoundInfo\\AnimLookups.slk"; // SND event code → SoundLabel
// (SoundLabel → WAVs + 3D metadata is AnimSounds.slk — already loaded under the "anim" tag.)

const VOICE_CATEGORIES: ReadonlySet<SoundCategory> = new Set<SoundCategory>(["What", "Yes", "YesAttack", "Pissed", "Warcry", "Ready"]);

const MAX_DEATHS = 4; // concurrent death cries
const MAX_IMPACTS = 5; // concurrent weapon-impact / chop clangs
const MAX_VOICES = 8; // concurrent voice lines across all sources (safety cap on overlap)

interface Clip {
  paths: string[]; // full MPQ paths of the randomized variants
  gain: number; // 0..1 (Volume / 127)
  pitch: number; // base playback rate
  pitchVar: number; // ± random jitter applied per play (0 = none)
  // Positional-audio fields, straight from the SoundInfo SLK row (see resolve()).
  threeD: boolean; // Flags contains WANT3D → play through a positional PannerNode
  refDist: number; // MinDistance — full volume within this radius (world units)
  maxDist: number; // MaxDistance — attenuated to silence at this radius
  cutoff: number; // DistanceCutoff — WC3 doesn't play the sound at all beyond this
}

/** Weapon sounds embedded in a unit/missile MODEL as SND event objects, resolved via
 *  AnimLookups (4-char code → label) → AnimSounds (label → clip). Categorised by the
 *  event code's leading letter: K = the unit's own attack/fire sound; M = a missile's
 *  launch/impact whoosh. (D death / A ability events are handled by other channels.) */
interface ModelSounds {
  attack: Clip[]; // K events — the unit's fire sound (played at the swing's damage point)
  launch: Clip[]; // M events whose label is a "…Launch"
  impact: Clip[]; // M events whose label is a "…Hit"/"…Impact" (or a single generic missile sound)
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
  private clips = new Map<string, Clip | null>(); // memoized "table|key" → clip
  // Active voice lines keyed by SOURCE (unit/building instance id). One line per
  // source at a time — distinct sources overlap; a source re-requesting while its
  // own line still plays is dropped. Source-less voices use a fresh voiceSeq key.
  private voices = new Map<string, AudioBufferSourceNode>();
  private voiceSeq = 0;
  private deaths = 0;
  private impacts = 0;
  private loops = new Map<string, AudioBufferSourceNode>(); // active looping sounds by name
  private muted = false;
  private volume = 0.85;
  private listener: Listener | null = null; // last camera frame (for WANT3D panning)

  /** Fired when an acknowledgement VOICE actually starts (label + clip seconds) —
   *  the host drives the 3D portrait's talk animation off this. */
  onVoiceStart: ((label: string, durationSec: number) => void) | null = null;

  constructor(private vfs: DataSource) {
    for (const [tag, path] of [["ack", ACK_TABLE], ["anim", ANIM_TABLE], ["combat", COMBAT_TABLE], ["ui", UI_TABLE], ["animlookups", ANIMLOOKUPS_TABLE]] as const) {
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
    if (this.ctx.state === "suspended") void this.ctx.resume();
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

  /** Play a spell's cast/effect sound — a WAV that ships in the effect model's own
   *  folder (HolyBoltSpecialArt.mdx → HolyBolt.wav, HealTarget.mdx → HealTarget.wav,
   *  AvatarCaster.mdx → Avatar.wav, …). Tries each art path, then a curated fallback. */
  playSpellSound(arts: string[], fallback?: string, at?: SoundPos): void {
    // As with missiles, effect-folder WAVs have no SLK row — treat them as WANT3D
    // world sounds so a spell cast pans + attenuates from where it's cast.
    const meta = { gain: 0.8, pitch: 1, pitchVar: 0.03, threeD: true, refDist: 800, maxDist: 10000, cutoff: 3500 };
    for (const art of arts) {
      if (!art) continue;
      const paths = this.folderSounds("cast", art, ["", "1", "Cast", "Target", "Caster", "Death"]);
      if (paths.length) {
        this.playPool({ paths, ...meta }, "impact", at);
        return;
      }
    }
    if (fallback && this.vfs.exists(fallback)) this.playPool({ paths: [fallback], ...meta }, "impact", at);
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
  /** Resolve a unit/missile model's embedded weapon sounds — the SND event objects
   *  WC3 fires during the attack/flight animation. The 4-char event code (e.g. "KRIF")
   *  maps through AnimLookups (→ SoundLabel) then AnimSounds (→ WAVs + 3D metadata).
   *  Cached per model path — the MDX is parsed once, lazily on first use. We only
   *  care about K (the unit's fire sound) and M (a missile's launch/impact) events;
   *  D (death) is played via the unit's sound-set label, A (ability) by the spell code. */
  private resolveModelSounds(modelArt: string): ModelSounds {
    const key = modelArt.toLowerCase();
    const cached = this.modelSounds.get(key);
    if (cached) return cached;
    const out: ModelSounds = { attack: [], launch: [], impact: [] };
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
    const lookups = this.tables.get("animlookups") ?? null;
    for (const evt of model.eventObjects) {
      // Event-object names are "SND" + a 1-char separator + a 4-char code ("SNDXKRIF").
      if (evt.name.substring(0, 3) !== "SND") continue;
      const id = evt.name.substring(4);
      const cat = id[0]; // K = attack, M = missile, D = death, A = ability
      if (cat !== "K" && cat !== "M") continue;
      const actual = lookups?.index.get(id.toLowerCase()) ?? id;
      const lrow = lookups?.data.getRow(actual) as { string(k: string): string | undefined } | undefined;
      const label = lrow?.string("SoundLabel");
      if (!label) continue;
      const clip = this.resolve("anim", label); // AnimSounds row → clip (vol/pitch/3D/dist)
      if (!clip) continue;
      if (cat === "K") out.attack.push(clip);
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

  /** Start/stop a named looping sound (e.g. building construction). Idempotent. */
  setLoop(name: string, on: boolean): void {
    if (on) {
      if (this.loops.has(name)) return;
      const clip = this.resolve("ui", name);
      if (!clip || !clip.paths.length) return;
      this.unlock();
      if (!this.ctx || !this.master || this.ctx.state !== "running") return;
      const placeholder = {} as AudioBufferSourceNode;
      this.loops.set(name, placeholder); // reserve synchronously so we don't double-start
      const path = clip.paths[(Math.random() * clip.paths.length) | 0];
      void this.buffer(path).then((buf) => {
        if (!buf || !this.ctx || !this.master || this.loops.get(name) !== placeholder) return;
        const src = this.source(buf, clip);
        src.loop = true;
        src.connect(this.gain(clip.gain)).connect(this.master);
        this.loops.set(name, src);
        src.start();
      });
    } else {
      const src = this.loops.get(name);
      if (!src) return;
      this.loops.delete(name);
      try { src.stop(); } catch { /* not started yet / already stopped */ }
    }
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
      src.connect(this.gain(clip.gain)).connect(this.master);
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
   *  capped (reserved synchronously so an AoE burst can't slip the cap); ui isn't.
   *  A WANT3D clip with a world position pans + attenuates around the listener. */
  private playPool(clip: Clip | null, kind: "death" | "impact" | "ui", at?: SoundPos): void {
    if (!clip || !clip.paths.length) return;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    const positional = clip.threeD && !!at && !!this.listener;
    // WC3 DistanceCutoff: a positional sound past its cutoff isn't played at all —
    // drop it before reserving a pool slot so far-off battles don't starve the cap.
    if (positional && clip.cutoff > 0 && this.distanceTo(at!) > clip.cutoff) return;
    if (kind === "death") {
      if (this.deaths >= MAX_DEATHS) return;
      this.deaths++;
    } else if (kind === "impact") {
      if (this.impacts >= MAX_IMPACTS) return;
      this.impacts++;
    }
    const release = () => {
      if (kind === "death") this.deaths--;
      else if (kind === "impact") this.impacts--;
    };
    const path = clip.paths[(Math.random() * clip.paths.length) | 0];
    void this.buffer(path).then((buf) => {
      if (!buf || !this.ctx || !this.master) {
        release();
        return;
      }
      const src = this.source(buf, clip);
      const g = src.connect(this.gain(clip.gain));
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

  private gain(value: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = value;
    return g;
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
          pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : 1,
          pitchVar: Number.isFinite(pv) ? pv : 0,
          threeD: /WANT3D/i.test(flags),
          refDist: num("mindistance"),
          maxDist: num("maxdistance"),
          cutoff: num("distancecutoff"),
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
      return await this.ctx.decodeAudioData(ab);
    } catch {
      return null;
    }
  }
}
