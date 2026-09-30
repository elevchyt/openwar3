// Voice chat's two ends of the audio: the microphone (push-to-talk) and the speakers.
//
// Everything decidable without a browser — the wire format, who hears whom — lives in
// game/voice.ts; this file is the part that needs WebAudio and a microphone, so it is the part
// that can fail (no device, permission refused, an insecure page) and it says so through
// `onError` rather than throwing into the key handler.

import { VOICE_RATE, decodeVoice, encodeVoice } from "../game/voice";

/** Seconds of microphone kept while NOT transmitting, and sent ahead of the first live slice
 *  when the key goes down — a talker starts speaking as they press, and the microphone, the
 *  processor's buffer and the key event all lag that by a few tens of milliseconds. */
const PREROLL_SECS = 0.4;

/** Samples per processor callback (at the context's rate): ~21 ms at 48 kHz. */
const TAP_SAMPLES = 1024;

/** Seconds of speech a speaker's buffer is kept ahead of the playhead — the jitter cushion. */
const LEAD_SECS = 0.12;

export class VoiceChat {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: ScriptProcessorNode | null = null;
  private transmitting = false;
  private opening: Promise<boolean> | null = null;
  /** Encoded slices heard while idle, newest last — the pre-roll. */
  private preroll: Uint8Array[] = [];
  /** Report an open failure to the player? Off for the silent warm-up at match start. */
  private loud = true;
  /** Where each speaker's next slice starts, on the context's clock. */
  private readonly playhead = new Map<number, number>();

  /** A slice of the local microphone, already encoded. Set by the owner. */
  onFrame: (bytes: Uint8Array) => void = () => {};
  onError: (message: string) => void = () => {};

  get talking(): boolean {
    return this.transmitting;
  }

  /**
   * Open the microphone ahead of the first press, quietly. Opening it is asynchronous (and the
   * first time a permission prompt), and speech begun during that wait was lost — so a match
   * with other people in it does it up front, and a refusal is not reported until the player
   * actually tries to talk.
   */
  async warm(): Promise<void> {
    this.loud = false;
    await this.open();
    this.loud = true;
  }

  /** Start sending, beginning with what was said just before the key went down. */
  async start(): Promise<void> {
    this.transmitting = true;
    if (this.stream) this.flushPreroll();
    if (!(await this.open()) || !this.transmitting) return;
    this.flushPreroll(); // the first open: whatever the tap caught while we waited
  }

  /** Stop sending. The microphone stays open, listening into the pre-roll, so the next press
   *  has neither a delay nor a clipped first word. */
  stop(): void {
    this.transmitting = false;
  }

  private flushPreroll(): void {
    const frames = this.preroll;
    this.preroll = [];
    for (const f of frames) this.onFrame(f);
  }

  /** Play a slice of somebody else's speech. */
  play(from: number, bytes: Uint8Array): void {
    const ctx = this.context();
    if (!ctx) return;
    const samples = decodeVoice(bytes);
    if (!samples.length) return;
    const buffer = ctx.createBuffer(1, samples.length, VOICE_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    // Slices are scheduled back to back; a talker who fell behind (or just began) is put
    // LEAD_SECS ahead of now so a late packet does not click.
    const now = ctx.currentTime;
    let at = this.playhead.get(from) ?? 0;
    if (at < now + 0.02) at = now + LEAD_SECS;
    node.start(at);
    this.playhead.set(from, at + buffer.duration);
  }

  dispose(): void {
    this.stop();
    this.tap?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.tap = null;
    this.opening = null;
    this.preroll = [];
    this.playhead.clear();
  }

  private context(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: "interactive" });
      } catch {
        return null;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private open(): Promise<boolean> {
    if (this.stream) return Promise.resolve(true);
    this.opening ??= this.acquire().finally(() => (this.opening = null));
    return this.opening;
  }

  private async acquire(): Promise<boolean> {
    const ctx = this.context();
    if (!ctx || !navigator.mediaDevices?.getUserMedia) {
      if (this.loud) this.onError("Voice chat needs a microphone and a secure page (localhost or https).");
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      if (this.loud) this.onError("Voice chat: microphone unavailable or permission refused.");
      return false;
    }
    this.source = ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but is the one tap every Chromium the game ships in
    // (including the 32-bit Electron 18 build) has, and needs no module file to load.
    this.tap = ctx.createScriptProcessor(TAP_SAMPLES, 1, 1);
    const keep = Math.ceil((PREROLL_SECS * ctx.sampleRate) / TAP_SAMPLES);
    this.tap.onaudioprocess = (e) => {
      const bytes = encodeVoice(e.inputBuffer.getChannelData(0), ctx.sampleRate);
      if (!bytes.length) return;
      // Sending, or listening into the pre-roll. Nothing leaves this machine unless the key is
      // down: an idle slice is only ever kept, in memory, for PREROLL_SECS.
      if (this.transmitting) this.onFrame(bytes);
      else {
        this.preroll.push(bytes);
        if (this.preroll.length > keep) this.preroll.shift();
      }
    };
    // A ScriptProcessor only runs while it reaches the destination; its own output is silent.
    this.source.connect(this.tap);
    this.tap.connect(ctx.destination);
    return true;
  }
}
