import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";

// Unit voice lines & sound effects, sourced entirely from the real WC3 sound data
// (the safest source of truth). The mapping, verified against the 1.27 MPQs:
//
//   Units\UnitUI.slk  `unitSound`  → a sound-set LABEL (hfoo → "Footman")
//                     `weap1`      → a weapon-impact sound base ("MetalMediumSlice")
//                     `armor`      → the unit's material when HIT ("Metal"/"Flesh"/…)
//   UI\SoundInfo\UnitAckSounds.slk   row `<label><Category>`  (voice acknowledgements)
//   UI\SoundInfo\AnimSounds.slk      row `<label>Death`       (death cries)
//   UI\SoundInfo\UnitCombatSounds.slk row `<weap1><targetArmor>` (weapon impacts)
//
// Each row's `FileNames` is a comma-separated randomized list; the full path is
// `DirectoryBase` + one chosen filename. Files are plain PCM WAV, decoded directly.
//
// Channels:
//   VOICE  (What/Yes/YesAttack/Pissed/Warcry/Ready) — ONE exclusive channel: while a
//          line plays, further voice requests are DROPPED, never cut (per feedback).
//   Death, Impact — overlapping SFX pools, each concurrency-capped.

export type SoundCategory = "What" | "Yes" | "YesAttack" | "Pissed" | "Warcry" | "Ready" | "Death";

const ACK_TABLE = "UI\\SoundInfo\\UnitAckSounds.slk";
const ANIM_TABLE = "UI\\SoundInfo\\AnimSounds.slk";
const COMBAT_TABLE = "UI\\SoundInfo\\UnitCombatSounds.slk";

const VOICE_CATEGORIES: ReadonlySet<SoundCategory> = new Set<SoundCategory>(["What", "Yes", "YesAttack", "Pissed", "Warcry", "Ready"]);

const MAX_DEATHS = 4; // concurrent death cries
const MAX_IMPACTS = 5; // concurrent weapon-impact clangs

interface Clip {
  paths: string[]; // full MPQ paths of the randomized variants
  gain: number; // 0..1 (Volume / 127)
  pitch: number; // base playback rate
  pitchVar: number; // ± random jitter applied per play (0 = none)
}

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ack: MappedData | null = null;
  private anim: MappedData | null = null;
  private combat: MappedData | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private clips = new Map<string, Clip | null>(); // memoized row key → clip
  private voiceBusy = false; // an acknowledgement voice is currently playing
  private voiceSource: AudioBufferSourceNode | null = null;
  private deaths = 0;
  private impacts = 0;
  private muted = false;
  private volume = 0.85;

  /** Fired when an acknowledgement VOICE actually starts (label + clip seconds) —
   *  the host drives the 3D portrait's talk animation off this. */
  onVoiceStart: ((label: string, durationSec: number) => void) | null = null;

  constructor(private vfs: DataSource) {
    this.ack = this.loadTable(ACK_TABLE);
    this.anim = this.loadTable(ANIM_TABLE);
    this.combat = this.loadTable(COMBAT_TABLE);
  }

  private loadTable(path: string): MappedData | null {
    const bytes = this.vfs.rawBytes(path);
    if (!bytes) return null;
    const m = new MappedData();
    m.load(new TextDecoder("windows-1252").decode(bytes));
    return m;
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
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  /** Play a unit voice line (or death cry). Voice acknowledgements share one
   *  exclusive channel and are dropped while it's busy; deaths overlap (capped). */
  play(label: string, category: SoundCategory): void {
    if (!label) return;
    if (category === "Death") {
      this.playPool(this.resolve(this.anim, label + "Death"), "death");
    } else {
      this.playVoice(label, category);
    }
  }

  /** Play a weapon-impact clang: attacker's `weap1` + target's `armor` material
   *  (e.g. MetalMediumSlice + Flesh). No-op for weaponless/ranged (`weap1` "_"). */
  playImpact(weaponSound: string, targetArmor: string): void {
    if (!weaponSound || weaponSound === "_" || !targetArmor) return;
    this.playPool(this.resolve(this.combat, weaponSound + targetArmor), "impact");
  }

  private playVoice(label: string, category: SoundCategory): void {
    if (!VOICE_CATEGORIES.has(category)) return;
    if (this.voiceBusy) return; // never cut the line that's already playing
    const clip = this.resolve(this.ack, label + category);
    if (!clip || !clip.paths.length) return;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    this.voiceBusy = true; // reserve the channel synchronously so bursts don't stack
    const path = clip.paths[(Math.random() * clip.paths.length) | 0];
    void this.buffer(path).then((buf) => {
      if (!buf || !this.ctx || !this.master) {
        this.voiceBusy = false;
        return;
      }
      const src = this.source(buf, clip);
      src.connect(this.gain(clip.gain)).connect(this.master);
      this.voiceSource = src;
      src.onended = () => {
        this.voiceBusy = false;
        if (this.voiceSource === src) this.voiceSource = null;
      };
      src.start();
      this.onVoiceStart?.(label, buf.duration);
    });
  }

  /** Play a clip on an overlapping, concurrency-capped pool (deaths / impacts). */
  private playPool(clip: Clip | null, kind: "death" | "impact"): void {
    if (!clip || !clip.paths.length) return;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    const cap = kind === "death" ? MAX_DEATHS : MAX_IMPACTS;
    // Reserve a slot SYNCHRONOUSLY — an AoE can kill/hit many units in one tick,
    // and decode is async, so counting only after decode would slip the cap.
    if (kind === "death") {
      if (this.deaths >= cap) return;
      this.deaths++;
    } else {
      if (this.impacts >= cap) return;
      this.impacts++;
    }
    const release = () => {
      if (kind === "death") this.deaths--;
      else this.impacts--;
    };
    const path = clip.paths[(Math.random() * clip.paths.length) | 0];
    void this.buffer(path).then((buf) => {
      if (!buf || !this.ctx || !this.master) {
        release();
        return;
      }
      const src = this.source(buf, clip);
      src.connect(this.gain(clip.gain)).connect(this.master);
      src.onended = release;
      src.start();
    });
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

  /** Resolve a table row → clip metadata, memoized. */
  private resolve(table: MappedData | null, key: string): Clip | null {
    const hit = this.clips.get(key);
    if (hit !== undefined) return hit;
    const row = table?.getRow(key) as { string(k: string): string | undefined } | undefined;
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
        clip = {
          paths: files.map((f) => (dir + f).replace(/\//g, "\\")),
          gain: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol / 127)) : 1,
          pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : 1,
          pitchVar: Number.isFinite(pv) ? pv : 0,
        };
      }
    }
    this.clips.set(key, clip);
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
