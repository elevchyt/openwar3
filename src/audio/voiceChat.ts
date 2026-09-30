// Voice chat's two ends of the audio: the microphone (push-to-talk) and the speakers.
//
// Everything decidable without a browser — the wire format, who hears whom — lives in
// game/voice.ts; this file is the part that needs WebAudio and a microphone, so it is the part
// that can fail (no device, permission refused, an insecure page) and it says so through
// `onError` rather than throwing into the key handler.

import { VOICE_RATE, decodeVoice, encodeVoice } from "../game/voice";

/** Seconds of speech a speaker's buffer is kept ahead of the playhead — the jitter cushion. */
const LEAD_SECS = 0.12;

export class VoiceChat {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: ScriptProcessorNode | null = null;
  private transmitting = false;
  private opening: Promise<boolean> | null = null;
  /** Where each speaker's next slice starts, on the context's clock. */
  private readonly playhead = new Map<number, number>();

  /** A slice of the local microphone, already encoded. Set by the owner. */
  onFrame: (bytes: Uint8Array) => void = () => {};
  onError: (message: string) => void = () => {};

  get talking(): boolean {
    return this.transmitting;
  }

  /** Start sending. Opens the microphone the first time (which is when the browser asks). */
  async start(): Promise<void> {
    this.transmitting = true;
    if (!(await this.open()) || !this.transmitting) return;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = true));
  }

  /** Stop sending. The microphone stays open but muted, so the next press has no delay. */
  stop(): void {
    this.transmitting = false;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = false));
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
      this.onError("Voice chat needs a microphone and a secure page (localhost or https).");
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.onError("Voice chat: microphone unavailable or permission refused.");
      return false;
    }
    this.stream.getAudioTracks().forEach((t) => (t.enabled = this.transmitting));
    this.source = ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but is the one tap every Chromium the game ships in
    // (including the 32-bit Electron 18 build) has, and needs no module file to load.
    this.tap = ctx.createScriptProcessor(2048, 1, 1);
    this.tap.onaudioprocess = (e) => {
      if (!this.transmitting) return;
      const bytes = encodeVoice(e.inputBuffer.getChannelData(0), ctx.sampleRate);
      if (bytes.length) this.onFrame(bytes);
    };
    // A ScriptProcessor only runs while it reaches the destination; its own output is silent.
    this.source.connect(this.tap);
    this.tap.connect(ctx.destination);
    return true;
  }
}
