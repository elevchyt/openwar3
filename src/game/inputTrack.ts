// The PLAYER INPUT TRACK of a replay (issue #158) — what a person did with their hands and
// eyes, which the command stream does not say: where they were LOOKING, what they had selected
// and how they selected it, their control groups, whether a command came off a hotkey or a
// click, and where the cursor was. None of it is an input to the match (replaying it changes
// nothing); it is what makes a recorded player read as a player, and what an AI that is meant to
// play like one learns pacing, attention and habit from.
//
// One track per PERSON, taken on that person's own machine — nobody else knows where their
// camera is. In a LAN game each client sends its track to the host in small batches (MatchLink
// `inputs`), and the host, which is the one recording, files it under the seat the relay says
// the batch came from. Taken only with the player's consent (data/options.ts `shareReplays`):
// a replay goes to everybody who played, and with sharing on, to the collection.
//
// Samples are small arrays, the first element saying which:
//
//   ["c", t, x, y, distance, yaw°]        the camera: its target, zoom and rotation
//   ["s", t, how, unitIds, subgroupType]  the selection changed, and how it was made
//   ["g", t, op, key, unitIds]            a control group: "set", "add" or "recall"
//   ["o", t, command, source]             a command, and where it came from
//   ["m", t, x‰, y‰]                      the cursor, in thousandths of the window
//
// `t` is the match step (game/replay.ts). A LAN client has no step count of its own — its world
// is the host's, a few times a second — so it stamps the host's own game clock and the step is
// that clock at 60 a second.

import type { CommandSource, SelectionSource } from "../ui/inputSource";

export type InputSample =
  | ["c", number, number, number, number, number]
  | ["s", number, SelectionSource, number[], string]
  | ["g", number, "set" | "add" | "recall", string, number[]]
  | ["o", number, string, CommandSource]
  | ["m", number, number, number];

export interface InputTrack {
  player: number;
  /** The keyboard scheme the player was on: Options → Gameplay → "Hotkeys:" (data/hotkeys.ts). */
  scheme: string;
  samples: InputSample[];
}

/** Steps between two camera samples (six a second) and two cursor samples (ten a second). Ours. */
export const CAMERA_EVERY = 10;
export const CURSOR_EVERY = 6;

/** The most samples one player's track may hold — about an hour of a busy player. A LAN client
 *  is somebody else's machine, and what it sends is appended to the host's file. Ours. */
export const MAX_TRACK_SAMPLES = 400_000;

/** Is this a well-formed sample? What the host asks of every one a client sends. */
export function isInputSample(v: unknown): v is InputSample {
  if (!Array.isArray(v) || v.length < 4 || v.length > 6 || typeof v[1] !== "number" || !Number.isFinite(v[1])) return false;
  const num = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x);
  const ids = (x: unknown): boolean => Array.isArray(x) && x.length <= 400 && x.every(num);
  const str = (x: unknown, max = 32): boolean => typeof x === "string" && x.length <= max;
  switch (v[0]) {
    case "c": return v.length === 6 && v.slice(2).every(num);
    case "s": return v.length === 5 && str(v[2]) && ids(v[3]) && str(v[4]);
    case "g": return v.length === 5 && str(v[2]) && str(v[3]) && ids(v[4]);
    case "o": return v.length === 4 && str(v[2]) && str(v[3]);
    case "m": return v.length === 4 && num(v[2]) && num(v[3]);
    default: return false;
  }
}

/** Takes one player's samples, on their own machine. */
export class InputTracker {
  readonly samples: InputSample[] = [];
  private cam = "";
  private camAt = -Infinity;
  private cur = "";
  private curAt = -Infinity;
  private sel = "|"; // nothing selected: where every match starts, so it is not news

  /** `clock`: the match step now. */
  constructor(private readonly clock: () => number) {}

  /** Once a step (or a frame): the camera and the cursor, each at its own rate and only when it
   *  has moved — a camera standing still says so once. */
  tick(camera: { x: number; y: number; distance: number; yaw: number }, cursor: [number, number]): void {
    const t = this.clock();
    if (t - this.camAt >= CAMERA_EVERY) {
      const row: InputSample = ["c", t, Math.round(camera.x), Math.round(camera.y), Math.round(camera.distance), Math.round((camera.yaw * 180) / Math.PI)];
      const key = row.slice(2).join();
      if (key !== this.cam) {
        this.cam = key;
        this.camAt = t;
        this.samples.push(row);
      }
    }
    if (t - this.curAt >= CURSOR_EVERY) {
      const key = cursor.join();
      if (key !== this.cur) {
        this.cur = key;
        this.curAt = t;
        this.samples.push(["m", t, cursor[0], cursor[1]]);
      }
    }
  }

  /** The selection as it stands; recorded when it differs from the last one seen. */
  selection(ids: readonly number[], subgroup: string, how: () => SelectionSource): void {
    const key = `${ids.join()}|${subgroup}`;
    if (key === this.sel) return;
    this.sel = key;
    this.samples.push(["s", this.clock(), how(), [...ids], subgroup]);
  }

  group(op: "set" | "add" | "recall", key: string, ids: readonly number[]): void {
    this.samples.push(["g", this.clock(), op, key, [...ids]]);
  }

  command(kind: string, source: CommandSource): void {
    this.samples.push(["o", this.clock(), kind, source]);
  }

  /** Hand over what has been taken since the last call (a LAN client's batch to the host). */
  drain(): InputSample[] {
    return this.samples.splice(0);
  }
}
