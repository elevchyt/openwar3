// Voice chat: who hears a talker, and how a slice of speech is put on the wire (issue #133).
//
// Kept pure — no DOM, no WebAudio, no wire — for the same reason game/chat.ts is: the two
// things worth being sure of are decidable from data alone.
//
//   • WHO HEARS IT. Voice rides the chat routing (`chatRecipients`) and nothing of its own: the
//     default channel is ALLIES, so a talker is heard by exactly the players who would read
//     their allied chat, and a watcher is heard by the other watchers only. The advanced
//     option **All Talk** (`AdvancedOptions.allTalk`) removes the channels — the audience
//     becomes "all" — except a WATCHER, whom `chatRecipients` keeps talking to the other watchers
//     either way (an observer sees the whole map, so what it says to a player is a scouting report).
//   • WHAT IS SENT. 16 kHz mono, 8-bit µ-law (G.711): 16 KB/s a talker, which a LAN relay eats
//     without noticing and which needs no codec the browser may not have. Nothing in Warcraft
//     III describes this — it has no voice chat — so the format is OURS.
//
// The sender is NEVER carried in a voice packet from a client; the host stamps it from the
// relay's own `deliver.from`, exactly as chat and the command stream do (matchLink.ts).

import { chatRecipients, type ChatWorld } from "./chat";

/** The push-to-talk key. `e.code`, not `.key`: "/" is a different key on other layouts and the
 *  developer asked for THE key, wherever it is. */
export const VOICE_KEY_CODE = "Slash";

/** Wire sample rate. Speech is intelligible from 8 kHz up; 16 keeps the "s" sounds. */
export const VOICE_RATE = 16000;

/** At most this many talkers are drawn at once (issue #133) — the rest are heard, not shown. */
export const VOICE_HUD_MAX = 4;

/** A talker whose last packet is older than this has stopped talking. A packet is ~43 ms of
 *  speech, so this is two-and-a-bit lost ones — long enough not to flicker through jitter. */
export const VOICE_HOLD_SECS = 0.35;

/** Who hears `from` talking: the chat audience — allies, or everybody under All Talk. */
export function voiceRecipients(from: number, allTalk: boolean, world: ChatWorld): number[] {
  return chatRecipients({ from, text: "", target: { scope: allTalk ? "all" : "allies" } }, world);
}

// ---- µ-law (G.711), the classic table-free form ---------------------------------------------

const MU_BIAS = 0x84;
const MU_CLIP = 32635;

/** One 16-bit linear sample → one µ-law byte. */
export function muLawEncode(sample: number): number {
  let s = sample | 0;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > MU_CLIP) s = MU_CLIP;
  s += MU_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One µ-law byte → one 16-bit linear sample. */
export function muLawDecode(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 7;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + MU_BIAS) << exponent) - MU_BIAS;
  return u & 0x80 ? -magnitude : magnitude;
}

/**
 * Float samples at `fromRate` → µ-law bytes at `VOICE_RATE`. The resample is a box average over
 * each output sample's span, which is also the anti-aliasing filter a decimation needs.
 */
export function encodeVoice(input: Float32Array, fromRate: number): Uint8Array {
  const ratio = fromRate / VOICE_RATE;
  const n = Math.max(0, Math.floor(input.length / ratio));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    const v = Math.max(-1, Math.min(1, sum / (b - a)));
    out[i] = muLawEncode(Math.round(v * 32767));
  }
  return out;
}

/** µ-law bytes → floats at `VOICE_RATE` (the audio context resamples on playback). */
export function decodeVoice(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = muLawDecode(bytes[i]) / 32768;
  return out;
}

// ---- base64 (the transport carries JSON) ------------------------------------------------------

export function voiceToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

export function voiceFromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- who is talking right now -------------------------------------------------------------------

/**
 * The set of players heard within `VOICE_HOLD_SECS`, in the order they started — which is the
 * order the HUD stacks them in, so a row never jumps because somebody else spoke.
 */
export class Talkers {
  private readonly last = new Map<number, number>();

  /** A packet from `player` arrived at `now` (seconds). */
  heard(player: number, now: number): void {
    // Re-inserting would move the player to the back of the Map; keep the original slot.
    this.last.set(player, now);
  }

  /** Forget everyone who has gone quiet, and answer who is left, oldest talker first. */
  active(now: number): number[] {
    for (const [p, t] of this.last) if (now - t > VOICE_HOLD_SECS) this.last.delete(p);
    return [...this.last.keys()];
  }

  clear(): void {
    this.last.clear();
  }
}
