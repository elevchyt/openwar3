import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
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
// Row keys are matched CASE-INSENSITIVELY: WC3's data is inconsistent (e.g. unit
// `halt` has unitSound "AltarofKings" but the ack row is "AltarOfKingsWhat"), and
// the engine looks them up case-insensitively — an exact match silently dropped
// the Altars, Tree of Life, Boneyard, Slaughterhouse voices.
//
// Channels:
//   VOICE  (What/Yes/YesAttack/Pissed/Warcry/Ready) — ONE exclusive channel: while
//          a line plays, further voice requests are DROPPED, never cut.
//   Death / Impact / UI — overlapping one-shot pools (deaths & impacts capped).
//   Loops  — named looping sounds (building construction).

export type SoundCategory = "What" | "Yes" | "YesAttack" | "Pissed" | "Warcry" | "Ready" | "Death";

const ACK_TABLE = "UI\\SoundInfo\\UnitAckSounds.slk";
const ANIM_TABLE = "UI\\SoundInfo\\AnimSounds.slk";
const COMBAT_TABLE = "UI\\SoundInfo\\UnitCombatSounds.slk";
const UI_TABLE = "UI\\SoundInfo\\UISounds.slk";

const VOICE_CATEGORIES: ReadonlySet<SoundCategory> = new Set<SoundCategory>(["What", "Yes", "YesAttack", "Pissed", "Warcry", "Ready"]);

const MAX_DEATHS = 4; // concurrent death cries
const MAX_IMPACTS = 5; // concurrent weapon-impact / chop clangs

interface Clip {
  paths: string[]; // full MPQ paths of the randomized variants
  gain: number; // 0..1 (Volume / 127)
  pitch: number; // base playback rate
  pitchVar: number; // ± random jitter applied per play (0 = none)
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
  private voiceBusy = false; // an acknowledgement voice is currently playing
  private voiceSource: AudioBufferSourceNode | null = null;
  private deaths = 0;
  private impacts = 0;
  private loops = new Map<string, AudioBufferSourceNode>(); // active looping sounds by name
  private muted = false;
  private volume = 0.85;

  /** Fired when an acknowledgement VOICE actually starts (label + clip seconds) —
   *  the host drives the 3D portrait's talk animation off this. */
  onVoiceStart: ((label: string, durationSec: number) => void) | null = null;

  constructor(private vfs: DataSource) {
    for (const [tag, path] of [["ack", ACK_TABLE], ["anim", ANIM_TABLE], ["combat", COMBAT_TABLE], ["ui", UI_TABLE]] as const) {
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
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
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

  /** Play a unit voice line (or death cry). Voice acknowledgements share one
   *  exclusive channel and are dropped while it's busy; deaths overlap (capped). */
  play(label: string, category: SoundCategory): void {
    if (!label) return;
    if (category === "Death") this.playPool(this.resolve("anim", label + "Death"), "death");
    else this.playVoice(label, category);
  }

  /** Play a weapon-impact / chop clang: `<weapon><material>` (MetalMediumSlice+Flesh,
   *  AxeMediumChop+Wood, …). No-op for weaponless entries (`weap` empty/"_"). */
  playImpact(weaponSound: string, targetArmor: string): void {
    if (!weaponSound || weaponSound === "_" || !targetArmor) return;
    this.playPool(this.resolve("combat", weaponSound + targetArmor), "impact");
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

  private playVoice(label: string, category: SoundCategory): void {
    if (!VOICE_CATEGORIES.has(category)) return;
    if (this.voiceBusy) return; // never cut the line that's already playing
    const clip = this.resolve("ack", label + category);
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

  /** Play a clip on an overlapping one-shot pool. deaths/impacts are concurrency-
   *  capped (reserved synchronously so an AoE burst can't slip the cap); ui isn't. */
  private playPool(clip: Clip | null, kind: "death" | "impact" | "ui"): void {
    if (!clip || !clip.paths.length) return;
    this.unlock();
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
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
        clip = {
          paths: files.map((f) => (dir + f).replace(/\//g, "\\")),
          gain: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol / 127)) : 1,
          pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : 1,
          pitchVar: Number.isFinite(pv) ? pv : 0,
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
