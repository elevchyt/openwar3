import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";

// Unit voice lines & sound effects, sourced entirely from the real WC3 sound data
// (the safest source of truth). The mapping, verified against the 1.27 MPQs:
//
//   Units\UnitUI.slk          `unitSound`  → a sound-set LABEL (e.g. hfoo → "Footman")
//   UI\SoundInfo\UnitAckSounds.slk  row `<label><Category>` (FootmanWhat, GruntPissed…)
//   UI\SoundInfo\AnimSounds.slk     row `<label>Death`      (death cries)
//
// Each row's `FileNames` is a comma-separated randomized list; the full path is
// `DirectoryBase` + one chosen filename. Files are plain PCM WAV (mono/22050/16),
// decoded directly by Web Audio. `Volume` is 0–127.
//
// WC3 categories → our events:
//   What      selection click            Yes        move order ack
//   YesAttack attack order ack           Pissed     repeated-click annoyance
//   Warcry    attack/charge              Ready      just-trained
//   Death     unit killed

export type SoundCategory = "What" | "Yes" | "YesAttack" | "Pissed" | "Warcry" | "Ready" | "Death";

const ACK_TABLE = "UI\\SoundInfo\\UnitAckSounds.slk";
const ANIM_TABLE = "UI\\SoundInfo\\AnimSounds.slk";

interface Clip {
  paths: string[]; // full MPQ paths of the randomized variants
  gain: number; // 0..1 (Volume / 127)
  pitch: number; // base playback rate
  pitchVar: number; // ± random jitter applied per play (0 = none)
}

// One shared "voice" channel: a new acknowledgement preempts the currently
// playing one (WC3's CHANNELFULLPREEMPT), so rapid clicks never pile up echoes.
// Deaths play on a separate, overlap-capped pool (battlefield ambience).
const MAX_DEATHS = 4;

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ack: MappedData | null = null;
  private anim: MappedData | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private clips = new Map<string, Clip | null>(); // memoized (label|category) → clip
  private voice: AudioBufferSourceNode | null = null; // current acknowledgement voice
  private deaths = 0;
  private muted = false;
  private volume = 0.85;

  constructor(private vfs: DataSource) {
    this.ack = this.load(ACK_TABLE);
    this.anim = this.load(ANIM_TABLE);
  }

  private load(path: string): MappedData | null {
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

  /** Play one random voice clip for a unit's sound-set label. Acknowledgements
   *  (everything but Death) share one preempting channel; deaths overlap. No-op
   *  when the label/category has no data or audio is still locked. */
  play(label: string, category: SoundCategory): void {
    if (!label) return;
    const clip = this.resolve(label, category);
    if (!clip || !clip.paths.length) return;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    const path = clip.paths[(Math.random() * clip.paths.length) | 0];
    const death = category === "Death";
    // Reserve a death slot SYNCHRONOUSLY: an AoE can kill many units in one tick,
    // and decode is async, so counting only after decode would let the whole burst
    // slip past the cap. Release the slot if the clip never actually starts.
    if (death) {
      if (this.deaths >= MAX_DEATHS) return; // cap the death chorus
      this.deaths++;
    }
    void this.buffer(path).then((buf) => {
      if (!buf || !this.ctx || !this.master) {
        if (death) this.deaths--;
        return;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      if (clip.pitchVar) src.playbackRate.value = clip.pitch + (Math.random() * 2 - 1) * clip.pitchVar;
      else if (clip.pitch !== 1) src.playbackRate.value = clip.pitch;
      const g = this.ctx.createGain();
      g.gain.value = clip.gain;
      src.connect(g).connect(this.master);
      if (death) {
        src.onended = () => { this.deaths--; };
      } else {
        // Preempt the previous acknowledgement voice (one channel).
        try { this.voice?.stop(); } catch { /* already ended */ }
        this.voice = src;
        src.onended = () => { if (this.voice === src) this.voice = null; };
      }
      src.start();
    });
  }

  /** Resolve (label, category) → clip metadata, memoized. */
  private resolve(label: string, category: SoundCategory): Clip | null {
    const key = `${label}|${category}`;
    const hit = this.clips.get(key);
    if (hit !== undefined) return hit;
    const table = category === "Death" ? this.anim : this.ack;
    const row = table?.getRow(label + category) as { string(k: string): string | undefined } | undefined;
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
