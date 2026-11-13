import { withInputOverride } from "../ui/inputSource";
import type { Options } from "../data/options";
import { preloadVoiceModel, transcribe, voiceModelInstalled, WHISPER_RATE } from "./model";
import { describe, Lexicon, parse, type LexEntry, type VoiceIntent } from "./parser";

// Voice Control's PUSH-TO-TALK: hold ".", speak, let go (Options → Gameplay → "Voice Control").
//
// The key is "." by `e.code` ("Period"), the key beside voice chat's "/" (game/voice.ts) — the
// two are a pair, one for talking to people and one for talking to the game. It is read only
// while the option is ticked, and never while the player is typing.
//
// What happens between the press and the release:
//   1. the microphone's samples are KEPT — starting with the PRE-ROLL, the last 0.6 s from before
//      the key went down (people start speaking as they press, as voice chat's "/" knows). The
//      microphone is opened as soon as Voice Control is on, so even the first press has one;
//      while the key is up nothing but those 0.6 s is ever kept;
//   2. on release, a short tail is let through (people let go of a key as the last syllable
//      ends), the utterance is resampled to Whisper's 16 kHz and transcribed in a worker
//      (model.ts), PRIMED with the names the player is likely to say (`promptFor`);
//   3. the text is parsed (parser.ts) and the intents are handed to the match (`VoiceHost`),
//      which carries them out through the same paths a click and a hotkey take — or, on a menu,
//      to the menu reader (menu.ts).
//
// Nothing is sent anywhere: the samples go to a worker on this page.

/** What the match (or the menus) does for Voice Control (render/mapViewer.ts, voice/menu.ts). */
export interface VoiceHost {
  /** Whether it is taking commands right now (no menu up, not paused, not a cinematic) — the
   *  HUD's own `acceptsInput` gate. */
  acceptsInput(): boolean;
  /** Every name the player could mean right now: the card, the race's tech tree, what is on
   *  the map — what the parser matches against, and the first names in the recogniser's prompt. */
  lexicon(): LexEntry[];
  /** More names worth priming the recogniser with, after the lexicon's (every unit, ability and
   *  item name in the game; the menu's own words). Built once. */
  vocabulary(): readonly string[];
  /** Carry the intents out. */
  perform(intents: VoiceIntent[], heard: string): void;
  /** A host that understands sentences ITSELF (the menus, src/voice/menu.ts) takes the text
   *  whole instead of the match's intents. True if it did something with it. */
  handle?(text: string): boolean;
  /** Tell the player what is going on (listening, heard nothing, …). null clears it. */
  status(text: string | null): void;
  /** Tell the player something went wrong (no microphone, …). */
  error(text: string): void;
}

/** The push-to-talk key, by position (`e.code`). */
export const VOICE_CONTROL_KEY_CODE = "Period";

/** How long the microphone keeps feeding the utterance after the key comes up. */
const TAIL_MS = 250;

/**
 * Seconds of microphone kept, in memory only, while the key is UP — and put in front of the
 * utterance when it goes down. People start speaking as they press, and the key event and the
 * processor's buffer lag that, so without it the first syllable ("TRAIN three footmen") was cut
 * off. Voice chat's own pre-roll (audio/voiceChat.ts `PREROLL_SECS`, 0.4) is the same idea; this
 * one is a little longer, because a command's first word is the verb and losing it loses the
 * command.
 */
const PREROLL_SECS = 0.6;
/** Samples per processor callback: ~43 ms at 48 kHz, so the pre-roll is kept in fine slices. */
const TAP_SAMPLES = 2048;
/** The longest utterance kept: a command is a sentence, and Whisper hears 30 s at most. */
const MAX_SECS = 15;
/** Below this loudness (RMS) the press held nothing but room noise — Whisper would invent a
 *  sentence out of it ("Thank you."), so silence is answered as silence. */
const SILENCE_RMS = 0.004;

let enabled = false;
/** The match, while one is up. */
let host: VoiceHost | null = null;
/** The menus — every glue screen, and the in-game panels (F10, quests, allies) — registered
 *  once at boot. Asked only when the match is not taking commands. */
let menuHost: VoiceHost | null = null;

/** Who a press is for right now: the match if it is taking commands, else the menus. */
function active(): VoiceHost | null {
  if (host?.acceptsInput()) return host;
  if (menuHost?.acceptsInput()) return menuHost;
  return null;
}

/** The menus register themselves once (main.ts). */
export function setMenuVoiceHost(h: VoiceHost | null): void {
  menuHost = h;
  warm();
}

/** Options → Gameplay → "Voice Control", live. */
export function applyVoiceOptions(opts: Options): void {
  const on = opts.voiceControl === true;
  if (on === enabled) return;
  enabled = on;
  if (!on) closeMic();
  else warm();
  for (const fn of onOff) fn(on);
}

const onOff = new Set<(on: boolean) => void>();

/** Whether Voice Control is switched on (Options → Gameplay) — what the match's name tags and
 *  its hint box are shown by. */
export function voiceControlOn(): boolean {
  return enabled;
}

/** Be told when it is switched on or off. */
export function onVoiceControlChange(fn: (on: boolean) => void): () => void {
  onOff.add(fn);
  return () => onOff.delete(fn);
}

/**
 * Get ready to listen BEFORE the first press: with Voice Control on and a model installed, the
 * model is loaded into the worker (a cold load is seconds) and the microphone opened, so the
 * pre-roll is already filling when "." goes down. The menus listen too, so it is open whenever
 * the option is on; it is closed again when the option is turned off.
 */
function warm(): void {
  if (!enabled || (!host && !menuHost)) return;
  void voiceModelInstalled().then((installed) => {
    if (!installed || !enabled) return;
    preloadVoiceModel();
    void openMic();
  });
}

/** The match registers itself while it is up; null when it ends. */
export function setVoiceHost(h: VoiceHost | null): void {
  host = h;
  if (!h) cancelUtterance();
  warm();
}

// ---- the microphone --------------------------------------------------------------------

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let tap: ScriptProcessorNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let opening: Promise<boolean> | null = null;

function openMic(): Promise<boolean> {
  if (stream) return Promise.resolve(true);
  opening ??= (async () => {
    try {
      ctx ??= new AudioContext({ latencyHint: "interactive" });
      if (ctx.state === "suspended") await ctx.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      (host ?? menuHost)?.error("Voice Control: microphone unavailable or permission refused.");
      return false;
    }
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor, as voice chat's tap (audio/voiceChat.ts): the one tap every Chromium the
    // game ships in has, needing no module file.
    tap = ctx.createScriptProcessor(TAP_SAMPLES, 1, 1);
    tap.onaudioprocess = (e) => feed(e.inputBuffer.getChannelData(0));
    source.connect(tap);
    tap.connect(ctx.destination); // a ScriptProcessor only runs while it reaches the output
    return true;
  })().finally(() => (opening = null));
  return opening;
}

function closeMic(): void {
  preroll = [];
  tap?.disconnect();
  source?.disconnect();
  for (const t of stream?.getTracks() ?? []) t.stop();
  void ctx?.close();
  ctx = null;
  stream = null;
  tap = null;
  source = null;
}

// ---- one utterance ---------------------------------------------------------------------

interface Utterance {
  h: VoiceHost;
  lexicon: Lexicon;
  /** The samples, at the microphone's own rate, pre-roll first. */
  chunks: Float32Array[];
  rate: number;
  listening: boolean;
}

let current: Utterance | null = null;

/** The last `PREROLL_SECS` of microphone, oldest first, while no utterance is listening. */
let preroll: Float32Array[] = [];

function feed(samples: Float32Array): void {
  if (!ctx) return;
  const copy = new Float32Array(samples);
  const u = current;
  if (!u || !u.listening) {
    // Key up: keep the last moments, in memory, and nothing else.
    preroll.push(copy);
    const keep = Math.ceil((PREROLL_SECS * ctx.sampleRate) / TAP_SAMPLES);
    while (preroll.length > keep) preroll.shift();
    return;
  }
  if (u.chunks.length * TAP_SAMPLES < MAX_SECS * u.rate) u.chunks.push(copy);
}

/** Whether "." is held now — a press whose microphone was still opening may be over before it is. */
let keyHeld = false;

async function begin(h: VoiceHost): Promise<void> {
  if (current) return;
  if (!(await openMic()) || !ctx || current) return;
  // The utterance starts with the pre-roll — the audio from just BEFORE the key went down.
  current = { h, lexicon: new Lexicon(h.lexicon()), chunks: preroll, rate: ctx.sampleRate, listening: true };
  preroll = [];
  h.status("Listening…");
  if (!keyHeld) release(); // let go while the microphone was opening
}

function release(): void {
  const u = current;
  if (!u || !u.listening) return;
  setTimeout(() => {
    u.listening = false;
    void finish(u);
  }, TAIL_MS);
}

/** The utterance at Whisper's 16 kHz: a box average over each output sample's span, which is
 *  also the anti-aliasing a decimation needs (game/voice.ts `encodeVoice` does the same). */
function resample(chunks: Float32Array[], rate: number): Float32Array {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const all = new Float32Array(n);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  if (rate === WHISPER_RATE) return all;
  const ratio = rate / WHISPER_RATE;
  const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(n, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += all[j];
    out[i] = sum / (b - a);
  }
  return out;
}

/**
 * The words that PRIME Whisper's spelling: the lexicon first (the card, our tech tree, our units'
 * spells, what is on screen — the names most likely said), then the host's wider vocabulary,
 * each once, as a comma list after a line saying what is coming. Whisper takes a prompt of a
 * couple of hundred tokens; the worker keeps the END of it, so the most likely names go LAST.
 */
function promptFor(h: VoiceHost, lexicon: Lexicon): string {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (p: string): void => {
    const k = p.toLowerCase();
    if (!p || seen.has(k)) return;
    seen.add(k);
    names.push(p);
  };
  for (const { entry } of lexicon.entries) if (!entry.misheard) add(entry.phrase);
  const said = names.join(" ").toLowerCase();
  for (const w of h.vocabulary()) add(w);
  // The names this match is likeliest to hear — the card first, then the tech tree and what is
  // on screen — LAST, where the prompt weighs most; as many as fit their share of the budget.
  const likely = take(names, PROMPT_NAMES_CHARS).reverse();
  // The words the developer has heard it get wrong, those this match can use first (a word of
  // one of its own names), and none already among the names.
  const bias = PROMPT_BIAS.filter((w) => !likely.some((n) => n.toLowerCase().includes(w)));
  bias.sort((a, b) => Number(said.includes(b)) - Number(said.includes(a)));
  const room = PROMPT_CHARS - COMMAND_EXAMPLES.length - likely.join(", ").length;
  const words = take(bias, Math.max(0, room)).reverse();
  return `Warcraft III: ${words.join(", ")}. ${COMMAND_EXAMPLES} ${likely.join(", ")}.`;
}

/** The first of `list` that fit in `chars` characters, comma-joined. */
function take(list: readonly string[], chars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const w of list) {
    if (used + w.length + 2 > chars) break;
    out.push(w);
    used += w.length + 2;
  }
  return out;
}

/**
 * The prompt's size. Whisper takes at most ~224 tokens of prompt and the worker keeps the END of
 * a longer one (whisperWorker.ts); English runs about four characters a token, so ~850
 * characters is what is actually heard — beyond it the FRONT is dropped, which is why the least
 * likely words go first. The names get a fixed share of it so the examples cannot crowd them out.
 */
const PROMPT_CHARS = 850;
const PROMPT_NAMES_CHARS = 240;

/** Example commands for the prompt (see `promptFor`): the sentences a player SAYS, beside the
 *  names — Whisper is primed by context, and "pan", "camp", "fall back", "tp" are spelled right
 *  far more often after an example of them than after a list of names. The developer's list of
 *  words it must hear right, in as few sentences as hold them. */
const COMMAND_EXAMPLES =
  "Fall back. Go back. TP out. Select army, worker, my main building, the altar. Attack move to a green camp. " +
  "Pan the camera to the red camp, the goblin merchant, the tavern. Build a ziggurat, an orc burrow, a moon well, " +
  "a farm here. Send two acolytes to gold. Move up. Follow the archmage. Select fiend 4.";

/** The words the developer has heard the recogniser miss (lower case, as said), offered to it in
 *  the prompt when there is room (`promptFor`). */
const PROMPT_BIAS = [
  "blood mage", "troll", "headhunter", "shaman", "tauren", "spirit walker", "obsidian statue", "arcane",
  "mortar", "siege", "demolisher", "ballista", "glaive", "huntress", "warden", "grove", "entangle",
  "spirit", "slaughterhouse", "shop", "altar", "salve", "potion", "clarity", "scroll", "speed",
  "berserk", "brute", "grunt", "rifleman", "knight", "gryphon", "hippogryph", "faerie fire", "dragon",
  "claws", "roar", "rejuvenation", "bear", "dispel", "abolish magic", "heal", "restore", "necromancer",
  "banshee", "necromancy", "rod", "dagger", "ritual", "lich", "dreadlord", "crypt lord", "beetle",
  "swarm", "carrion", "shockwave", "stomp", "clap", "storm bolt", "bash", "avatar", "fan of knives",
  "blink", "poison", "vengeance", "water elemental", "brilliance", "blizzard", "lava spawn", "curse",
  "divine shield", "holy light", "regeneration", "priestess of the moon", "acolyte", "wisp",
];

async function finish(u: Utterance): Promise<void> {
  if (current !== u) return;
  const audio = resample(u.chunks, u.rate);
  let sq = 0;
  for (let i = 0; i < audio.length; i++) sq += audio[i] * audio[i];
  if (audio.length < WHISPER_RATE * 0.2 || Math.sqrt(sq / Math.max(1, audio.length)) < SILENCE_RMS) {
    current = null;
    u.h.status(null);
    u.h.error("Voice Control: didn't catch that.");
    return;
  }
  u.h.status("…");
  let text: string;
  try {
    text = await transcribe(audio, promptFor(u.h, u.lexicon));
  } catch (err) {
    if (current === u) current = null;
    u.h.status(null);
    if (!(err instanceof Error && err.message === "cancelled")) u.h.error("Voice Control: the speech model could not run.");
    return;
  }
  if (current !== u) return;
  current = null;
  run(u.h, clean(text), u.lexicon);
}

/** Whisper's sentence as a command: no trailing full stop, no "[BLANK_AUDIO]"-style tags. */
const clean = (text: string): string => text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

/** One sentence, to whichever host it was spoken at. */
function run(h: VoiceHost, heard: string, lexicon: Lexicon): string[] {
  h.status(null);
  if (!heard || /^[\s.,!?-]*$/.test(heard)) {
    h.error("Voice Control: didn't catch that.");
    return [];
  }
  // A match is up but not taking commands — paused, or a panel is open. Its CONSOLE lines still
  // belong to it: "unpause", "open the quest log", "say gg to all" are not on any panel's face.
  if (h === menuHost && host) {
    const intents = parse(heard, { lexicon: new Lexicon([]) });
    if (intents.length && intents.every((i) => i.kind === "pause" || i.kind === "chat" || (i.kind === "panel" && i.open === true))) {
      console.info("[voice]", JSON.stringify(heard), "→", intents.map(describe).join(" · "));
      withInputOverride("voice", () => host!.perform(intents, heard));
      return intents.map(describe);
    }
  }
  if (h.handle) {
    console.info("[voice:menu]", JSON.stringify(heard));
    h.handle(heard);
    return [heard];
  }
  const intents = parse(heard, { lexicon });
  if (!intents.length) {
    h.error(`Voice Control: “${heard}” is not a command.`);
    return [];
  }
  console.info("[voice]", JSON.stringify(heard), "→", intents.map(describe).join(" · "));
  withInputOverride("voice", () => h.perform(intents, heard));
  return intents.map(describe);
}

/**
 * Run a sentence through the same path an utterance takes, with no microphone —
 * `window.openwar3.voiceSay("train three footmen")`, the console probe for testing the mapping
 * in a live match or on a menu (and for a player to see what a phrase would do).
 */
export function voiceSay(text: string): string[] {
  const h = active() ?? host ?? menuHost;
  if (!h) return [];
  return run(h, text, new Lexicon(h.lexicon()));
}

/**
 * Transcribe 16 kHz samples and run the result — the console probe for the
 * RECOGNISER (`window.openwar3.voiceHear(samples)`), for testing it with recorded speech.
 */
export async function voiceHear(audio: Float32Array): Promise<{ heard: string; did: string[] }> {
  const h = active() ?? host ?? menuHost;
  if (!h) return { heard: "", did: [] };
  const lexicon = new Lexicon(h.lexicon());
  const heard = clean(await transcribe(audio, promptFor(h, lexicon)));
  return { heard, did: run(h, heard, lexicon) };
}

/** Whether the microphone is open and how many seconds of pre-roll it holds — a console probe
 *  (`window.openwar3.voicePreroll()`) for checking the pre-roll in a live match. */
export function voicePrerollState(): { micOpen: boolean; seconds: number } {
  const n = preroll.reduce((sum, p) => sum + p.length, 0);
  return { micOpen: !!stream, seconds: ctx ? n / ctx.sampleRate : 0 };
}

function cancelUtterance(): void {
  current = null;
}

// ---- the key ---------------------------------------------------------------------------

/** INPUT, TEXTAREA or contenteditable — the chat line above all. */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

window.addEventListener("keydown", (e) => {
  if (e.code !== VOICE_CONTROL_KEY_CODE || !enabled || e.ctrlKey || e.altKey || e.metaKey || typing(e.target)) return;
  const h = active();
  if (!h) return;
  e.preventDefault();
  // Swallowed before anything else hears it: on a menu, "." is nobody's key, and in a match the
  // HUD's handler must not see it either.
  e.stopImmediatePropagation();
  if (e.repeat) return;
  keyHeld = true;
  void begin(h);
});
window.addEventListener("keyup", (e) => {
  if (e.code !== VOICE_CONTROL_KEY_CODE) return;
  keyHeld = false;
  release();
});
// A key released in another window is never seen: let go of the utterance with the focus.
window.addEventListener("blur", () => {
  keyHeld = false;
  release();
});
