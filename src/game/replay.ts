// REPLAYS (issue #158) — the file, and the two halves that write and read it.
//
// A Warcraft III replay stores no video: it stores how the match began and every input the
// players gave it, and WATCHING one is re-simulating the match from those inputs. Ours is the
// same, and the engine was built for it long before this file existed (docs/multiplayer.md
// Phase A): the sim advances in whole 1/60 s steps counted in `simTick`, every roll comes off
// one seeded stream (`SimWorld.reseed`), entity ids come from the map rather than from load
// order, and every action any seat takes — a person's click, a LAN peer's command, a computer's
// decision — passes through ONE door, `Authority.execute`.
//
// WHAT AN INPUT IS. Anything that changes the match and does not come out of the match itself:
//
//   · a COMMAND at `Authority.execute` — the AIs' included, which is why a replay never runs an
//     AI: it is fed what the AI decided, so a change to Computer+ cannot break an old replay;
//   · a CHAT line (the map hears it — "-ap" — and the watcher reads it), a minimap PING;
//   · what the map's script hears from a PLAYER and from nobody else: a dialog button, a frame
//     event, a player event (leaving, ESC through a cinematic), a SELECTION (a hero picker);
//   · a CHEAT (single player only, and recorded so the replay is still the match that was played).
//
// What is NOT an input is everything the map's script does by itself — its triggers, timers
// and orders go through the authority's own methods and replay themselves — and everything that
// only decides how fast or how prettily the match is SHOWN: game speed, pause, the camera.
// The camera IS recorded, for the person's own view and as training material, but replaying it
// changes nothing.
//
// WHEN. Every input carries the step it landed in (`t`, the `simTick` count) and the PHASE of
// that step (`ph`), because the order of things inside one step is part of the match: a
// computer decides AFTER the inputs that arrived between frames and BEFORE the world steps.
//
// THE FILE. A magic, a format number, then tagged sections — `[tag:4][length:u32][bytes]` —
// each one gzip'd JSON. A reader skips a tag it does not know, so a newer recorder can add a
// section (the state track, the input track) without an older reader failing on it. Kept free
// of the DOM and the renderer: the headless round-trip test compiles it for Node.

import type { Command } from "./commands";
import type { MeleeConfig } from "../ui/lobby";
import type { ChatTarget } from "./chat";
import type { StateSample } from "./replayState";
import { MAX_TRACK_SAMPLES, type InputSample, type InputTrack } from "./inputTrack";

/** The format of the FILE, not of OpenWar3 — bumped when a reader of the old one could not read
 *  the new one. A new SECTION is not a bump; that is what the tags are for. */
export const REPLAY_FORMAT = 1;

/** "OW3R" — the first four bytes of every replay. */
const MAGIC = [0x4f, 0x57, 0x33, 0x52];

/** The file extension. Ours: WC3's is `.w3g`, which is a different format. */
export const REPLAY_EXT = ".o3r";

/** The phases of one sim step, in the order they run (MapViewerScene.advanceSim):
 *  BETWEEN steps (the frame's input handlers, a LAN peer's message), at the START of a step
 *  before the controller's tick, in the controller's AI block, and AFTER it. */
export const enum Phase {
  Between = 0,
  Pre = 1,
  Ai = 2,
  Post = 3,
}

/** What the match was, as it was set up — everything needed to set it up again. */
export interface ReplayHeader {
  format: number;
  /** OpenWar3's own version (`package.json`), so a replay from another build can be told apart
   *  and opened in the build that made it (issue #158, "Versions"). */
  version: string;
  /** The commit that build was cut from ("" when it had no repository around it). */
  commit?: string;
  /**
   * The SIM FINGERPRINT of the build that recorded it (tools/sim-fingerprint.mjs): a hash of
   * every source file that can change how a match plays out. Two builds with the same one play
   * each other's replays exactly, whatever their version numbers; a different one is what sends
   * a viewer to the recording version's own bundle. Absent on the first replays ever recorded.
   */
  fingerprint?: string;
  /** Which game files the match read: `casc-1.30.4.11274`, `casc-1.31.1.12164-downgraded` (a
   *  1.31 store put back to 1.30.4's values, src/vfs/downgrade.ts), or `mpq` for an MPQ-era
   *  folder. The same map on different data is a different match. */
  install?: string;
  /** When it was recorded (ISO). */
  recordedAt: string;
  /** The map: where it was found, what it is called, and a hash of its bytes — the same NAME is
   *  not the same map, and a replay on a different map is a different match. */
  map: { path: string; name: string; hash: string; size: number };
  /** The lobby's config, RESOLVED: the seed the match actually rolled with, and every Random
   *  race already rolled. Re-rolling either would be a different match. */
  config: MeleeConfig;
  /**
   * WHO played each seat — a person or a computer, and which computer — stated outright rather
   * than left to be read out of the lobby config, because it is the first thing anybody studying
   * a replay asks (an AI learning to play like a person learns from the `human` seats).
   */
  seats: ReplaySeat[];
  /** Whom the recording machine was (`localPlayer`). The map's `GetLocalPlayer` answers with it
   *  on playback, so a script's presentation branches go the way they went. */
  localPlayer: number;
  /** Was the recorder only watching (Observer Mode)? */
  observer: boolean;
  edition: "roc" | "tft";
  patch: string;
  /** Set when something the replay cannot carry was used (the dev drawer's spawn tools): the
   *  match is still recorded, and the viewer is told it may not play back the same. */
  tainted?: string;
}

/** What a WATCHER had set when a seek back restarted the replay (MapViewerScene.onReplayRewind):
 *  carried across the restart so going back in time changes nothing else. */
export interface ReplayView {
  x: number;
  y: number;
  distance: number;
  speed: number;
  fog: boolean;
  paused: boolean;
  autoCamera: boolean;
}

/** One seat of a recorded match. */
export interface ReplaySeat {
  player: number;
  /** As the match names it — the lobby name, or the map's for its own sides. */
  name: string;
  kind: "human" | "computer";
  /** A computer's AI: Blizzard's own melee AI, Computer+, or the map's own (a mission, a custom
   *  map whose triggers play the seat). Absent for a person. */
  ai?: "classic" | "plus" | "map";
  /** A computer's `MeleeDifficulty()` rung (1 Easy, 2 Normal, 3 Insane). */
  difficulty?: number;
  race: string;
  team: number;
  /** The seat's colour index (`playercolor`), as the match began. */
  color?: number;
  /** An ANONYMOUS id for the person in the seat (a random one per install,
   *  game/replayUpload.ts) — present only for a player who agreed to share their replays, so
   *  one player's matches can be told from another's without knowing who anybody is. */
  id?: string;
}

/** One input, stamped with the step and phase it landed in. */
export type ReplayEvent =
  /** `no`: the authority REFUSED it (recorded all the same — replayed, it is refused again). */
  | { k: "cmd"; t: number; ph: Phase; p: number; cmd: Command; no?: 1 }
  | { k: "chat"; t: number; ph: Phase; from: number; text: string; target: ChatTarget }
  | { k: "ping"; t: number; ph: Phase; p: number; x: number; y: number }
  | { k: "sel"; t: number; ph: Phase; p: number; unit: number; on: boolean }
  | { k: "dlg"; t: number; ph: Phase; p: number; button: number; dialog: number }
  | { k: "frame"; t: number; ph: Phase; p: number; frame: number; ev: number }
  /** `left`: raised by a LAN seat going (`seatLeft`), which also marks the slot LEFT. */
  | { k: "pev"; t: number; ph: Phase; p: number; ev: number; left?: boolean }
  | { k: "cheat"; t: number; ph: Phase; p: number; kind: string }
  | { k: "cheatsel"; t: number; ph: Phase; kind: string; ids: number[] }
  /** A summon's SPAWN LOCK, which the sim reads off its model when the body arrives — a fact
   *  from outside the sim, so an input (MapViewerScene.summonBirth). */
  | { k: "lock"; t: number; ph: Phase; unit: number; secs: number }
  /** The F11 Allies menu: one alliance setting a player changed, and a gift of resources. Both
   *  are written straight onto the match by the menu (never through `Authority.execute`), so
   *  both are inputs of their own. */
  | { k: "ally"; t: number; ph: Phase; p: number; other: number; type: number; on: boolean }
  | { k: "give"; t: number; ph: Phase; p: number; other: number; gold: number; lumber: number }
  /** NOTES, not inputs — nothing is done with them on playback, where the pace and the pause are
   *  the watcher's: a player paused or resumed the match, and the Game Speed (or the dev tools'
   *  Sim Speed `boost`) changed. Kept because how a match was PLAYED includes when it stood still. */
  | { k: "pause"; t: number; ph: Phase; p: number; on: boolean }
  | { k: "speed"; t: number; ph: Phase; speed: number; boost: number };

/** A STATE HASH at the end of step `t` — what playback compares against to know it is still
 *  the same match (a mismatch is a determinism bug, or a build that cannot play this file). */
export interface ReplayCheck {
  t: number;
  h: string;
}

/** How the match ended, as the score screen tells it. Optional: a crash writes no ending. */
export interface ReplayEnding {
  /** Steps the match ran. */
  ticks: number;
  /** Per seat: did it win, lose, or leave with no result. */
  results: Array<{ player: number; result: "won" | "lost" | "none" }>;
}

export interface Replay {
  header: ReplayHeader;
  events: ReplayEvent[];
  checks: ReplayCheck[];
  /** One input track per PERSON who agreed to it — camera, selection, control groups, where
   *  each command came from, the cursor (game/inputTrack.ts). Not an input to the match. */
  inputs: InputTrack[];
  ending: ReplayEnding | null;
  /** The state track — once a game second, what the match looked like (game/replayState.ts).
   *  Not needed to WATCH: kept for reading a match without re-simulating it. */
  states: StateSample[];
  /** DEV builds only: the full state behind each check (game/replayHash.ts `stateDump`), so a
   *  playback that parts from the recording can say WHAT parted rather than only when. */
  dumps?: Record<number, unknown>;
}

/** How often a state hash is taken: every ten game seconds (600 steps at 60 Hz). Ours. */
export const CHECK_EVERY = 600;

// --- the file -----------------------------------------------------------------------------

/** gzip, through the platform's own stream (the page and Node 18+ both have it). */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** JSON that survives a non-finite number (an aura's `Infinity` would arrive as `null`). */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? { $n: String(v) } : v));
}

function fromJson(text: string): unknown {
  return JSON.parse(text, (_k, v) => (v && typeof v === "object" && typeof (v as { $n?: unknown }).$n === "string" && Object.keys(v).length === 1 ? Number((v as { $n: string }).$n) : v));
}

/** Write a replay file. */
export async function encodeReplay(r: Replay): Promise<Uint8Array> {
  const sections: Array<[string, unknown]> = [
    ["HEAD", r.header],
    ["EVTS", r.events],
    ["CHKS", r.checks],
    ["INPT", r.inputs],
    ["STAT", r.states],
  ];
  if (r.ending) sections.push(["ENDS", r.ending]);
  if (r.dumps) sections.push(["DUMP", r.dumps]);
  const parts: Uint8Array[] = [new Uint8Array([...MAGIC, REPLAY_FORMAT & 0xff, REPLAY_FORMAT >> 8])];
  const enc = new TextEncoder();
  for (const [tag, value] of sections) {
    const body = await gzip(enc.encode(toJson(value)));
    const head = new Uint8Array(8);
    for (let i = 0; i < 4; i++) head[i] = tag.charCodeAt(i);
    new DataView(head.buffer).setUint32(4, body.length, true);
    parts.push(head, body);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The sections of a file, by tag, inflated — all of them, or only those `want` names. A
 *  section this reader does not know is skipped, not refused: that is the point of tags. */
async function readSections(bytes: Uint8Array, want?: readonly string[]): Promise<Map<string, unknown>> {
  if (bytes.length < 6 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("not an OpenWar3 replay");
  const format = bytes[4] | (bytes[5] << 8);
  if (format > REPLAY_FORMAT) throw new Error(`replay format ${format} is newer than this build reads (${REPLAY_FORMAT})`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const found = new Map<string, unknown>();
  let at = 6;
  while (at + 8 <= bytes.length) {
    const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const len = view.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + len);
    at += 8 + len;
    if (!(want ?? SECTIONS).includes(tag)) continue;
    found.set(tag, fromJson(dec.decode(await gunzip(body))));
  }
  return found;
}
const SECTIONS = ["HEAD", "EVTS", "CHKS", "INPT", "STAT", "ENDS", "DUMP"];

/** Read a replay file. Throws on something that is not one, or a format this build cannot read. */
export async function decodeReplay(bytes: Uint8Array): Promise<Replay> {
  const found = await readSections(bytes);
  const header = found.get("HEAD") as ReplayHeader | undefined;
  if (!header) throw new Error("replay has no header");
  return {
    header,
    events: (found.get("EVTS") as ReplayEvent[] | undefined) ?? [],
    checks: (found.get("CHKS") as ReplayCheck[] | undefined) ?? [],
    inputs: (found.get("INPT") as InputTrack[] | undefined) ?? [],
    states: (found.get("STAT") as StateSample[] | undefined) ?? [],
    ending: (found.get("ENDS") as ReplayEnding | undefined) ?? null,
    dumps: found.get("DUMP") as Record<number, unknown> | undefined,
  };
}

/** Read only the header and the ending — what the View Replay list shows — without inflating
 *  the tracks, which are nearly all of a file. */
export async function readReplayHeader(bytes: Uint8Array): Promise<{ header: ReplayHeader; ending: ReplayEnding | null }> {
  const found = await readSections(bytes, ["HEAD", "ENDS"]);
  const header = found.get("HEAD") as ReplayHeader | undefined;
  if (!header) throw new Error("replay has no header");
  return { header, ending: (found.get("ENDS") as ReplayEnding | undefined) ?? null };
}

/** A short content hash (FNV-1a, 64-bit as two 32-bit halves) — for a map's bytes and for the
 *  state checks. Not cryptographic; it only has to tell two things apart. */
export function fnv64(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i], 0x01000193) ^ (h1 >>> 7);
    h2 >>>= 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// --- recording ----------------------------------------------------------------------------

/** Where in the match an input landed — asked of the scene at the moment it lands. */
export type ReplayClock = () => { t: number; ph: Phase };

/** Distributes `Omit` over a union, so `push` takes any one event shape without its stamp. */
type Unstamped<E> = E extends unknown ? Omit<E, "t" | "ph"> : never;

/**
 * Collects a match's inputs as they happen. Holds nothing but plain data — the scene taps the
 * doors and hands what passes through; `finish` turns it into a file.
 */
export class ReplayRecorder {
  private readonly events: ReplayEvent[] = [];
  private readonly checks: ReplayCheck[] = [];
  private readonly tracks: InputTrack[] = [];
  private readonly states: StateSample[] = [];
  private ending: ReplayEnding | null = null;
  private dumps: Record<number, unknown> | undefined;

  constructor(readonly header: ReplayHeader, private readonly clock: ReplayClock) {}

  /** Record one input, stamped now. The command is COPIED: dispatch may write to the order it
   *  was handed, and the file must hold what was asked, not what it became. */
  push(e: Unstamped<ReplayEvent>): ReplayEvent {
    const { t, ph } = this.clock();
    const copy = structuredClone(e) as ReplayEvent;
    copy.t = t;
    copy.ph = ph;
    this.events.push(copy);
    return copy;
  }

  check(t: number, h: string, dump?: unknown): void {
    this.checks.push({ t, h });
    if (dump !== undefined) (this.dumps ??= {})[t] = dump;
  }

  /**
   * A player's input track (game/inputTrack.ts) — samples appended to that seat's track, made on
   * first use. The recording player's own come straight from their tracker; a LAN client's
   * arrive in batches the host has already checked. Capped per player.
   */
  inputs(player: number, scheme: string, samples: readonly InputSample[]): void {
    let track = this.tracks.find((t) => t.player === player);
    if (!track) this.tracks.push((track = { player, scheme, samples: [] }));
    if (scheme) track.scheme = scheme;
    const room = MAX_TRACK_SAMPLES - track.samples.length;
    for (let i = 0; i < samples.length && i < room; i++) track.samples.push(samples[i]);
  }

  state(sample: StateSample): void {
    this.states.push(sample);
  }

  taint(why: string): void {
    this.header.tainted ??= why;
  }

  end(ending: ReplayEnding): void {
    this.ending = ending;
  }

  get eventCount(): number {
    return this.events.length;
  }

  snapshot(): Replay {
    return { header: this.header, events: this.events, checks: this.checks, inputs: this.tracks, states: this.states, ending: this.ending, dumps: this.dumps };
  }

  finish(): Promise<Uint8Array> {
    return encodeReplay(this.snapshot());
  }
}

// --- playback -----------------------------------------------------------------------------

/**
 * Hands a replay's inputs back to the match at the step and phase they were recorded in.
 *
 * `take(t, ph)` returns everything due at that point — and everything OVERDUE, because a phase
 * the scene did not reach (a step whose AI block was skipped) must not silently lose an input.
 */
export class ReplayPlayer {
  private next = 0;
  private nextCheck = 0;
  /** The first state check that did not match, if any. */
  divergedAt: number | null = null;

  constructor(readonly replay: Replay) {}

  take(t: number, ph: Phase): ReplayEvent[] {
    const ev = this.replay.events;
    const out: ReplayEvent[] = [];
    while (this.next < ev.length && (ev[this.next].t < t || (ev[this.next].t === t && ev[this.next].ph <= ph))) {
      out.push(ev[this.next++]);
    }
    return out;
  }

  /** Compare the state hash at the end of step `t` with the recorded one, when there is one. */
  verify(t: number, hash: () => string): boolean {
    const checks = this.replay.checks;
    while (this.nextCheck < checks.length && checks[this.nextCheck].t < t) this.nextCheck++;
    const c = checks[this.nextCheck];
    if (!c || c.t !== t) return true;
    this.nextCheck++;
    const ok = c.h === hash();
    if (!ok && this.divergedAt === null) this.divergedAt = t;
    return ok;
  }

  /** The step the match ended on, or the last input's, when the file has no ending. */
  get lastTick(): number {
    const ending = this.replay.ending?.ticks;
    if (ending !== undefined) return ending;
    const ev = this.replay.events;
    const lastCheck = this.replay.checks[this.replay.checks.length - 1]?.t ?? 0;
    return Math.max(ev[ev.length - 1]?.t ?? 0, lastCheck);
  }

  get done(): boolean {
    return this.next >= this.replay.events.length;
  }

}
