// Where a script `effect` is in its life (7.26 — issue #68).
//
// An effect runs on the GAME's clock, and this is the rule that says so. It is pure and
// lives apart from the renderer so the headless suite can drive it (tools/jass-corpus-test.cjs
// §7.26b) — the renderer only has to obey what it returns.
//
// Why it exists at all: an mdx instance advances its own `frame` ONLY on the frames the
// scene draws it (`ModelInstance.update` is gated on `rendered && isVisible(camera)`), so
// an effect the player isn't looking at freezes where it stands. Left to that clock, an
// effect created in the fog of war sat at frame 0 for as long as the player looked
// elsewhere and then played its Birth from the start, minutes late — the art queued up
// instead of happening. So the effect's AGE decides its phase, not the instance's frame.
//
// A WC3 effect model is a three-act clip — Birth, Stand, Death (verified on
// DivineShieldTarget/FrostArmorTarget and friends) — but most spawn flourishes ship only
// the Birth: AnimateDeadTarget.mdx, the one issue #68 reports, has exactly one sequence,
// `Birth [0, 2333]`. That difference is the whole of the rule below.

/** The clips a given effect model actually has. Read once, when the model loads. */
export interface SpecialFxClips {
  /** Does the model have a Birth clip at all? */
  hasBirth: boolean;
  /** The Birth clip's first model frame, and how many seconds it runs. */
  birthStart: number;
  birthSecs: number;
  /** Does it have a Stand to settle into — i.e. is it a PERSISTENT effect? */
  hasStand: boolean;
}

export type SpecialFxPhase =
  /** Playing its Birth. `frame` is the model frame the instance must sit on right now —
   *  driving it from age is what makes a frozen effect resume mid-flight rather than
   *  restart when the player finally looks at it. */
  | { kind: "birth"; frame: number }
  /** The steady state: looping its Stand until the script's DestroyEffect. A persistent
   *  effect the player only now lays eyes on is ALREADY here — WarChasers' Sun Key swirl
   *  is on the key when you arrive, it does not spawn itself at you. */
  | { kind: "stand" }
  /** Birth-only art whose clip has run out. Its whole life WAS that clip, so it is over —
   *  whether or not anyone saw it — and it is never drawn again. This is what keeps an
   *  effect that played out in the fog from turning up late. */
  | { kind: "spent" };

/** The effect's phase at `age` seconds old. Total: age alone decides it. */
export function specialFxPhaseAt(age: number, clips: SpecialFxClips): SpecialFxPhase {
  // No Birth clip: there is no flourish to play out and nothing to age past. The effect is
  // simply here, looping whatever single clip it has, for as long as the script keeps it.
  if (!clips.hasBirth) return { kind: "stand" };
  if (age < clips.birthSecs) return { kind: "birth", frame: clips.birthStart + age * 1000 };
  return clips.hasStand ? { kind: "stand" } : { kind: "spent" };
}

// --- BlzSetSpecialEffectTimeScale / BlzSetSpecialEffectTime (1.29) -----------------------------
//
// The SCALE is a multiplier: 1.0 is normal speed, 0.5 half, 2.0 double, 0 holds the frame.
// jassdoc's prose says otherwise ("if you see the animation speed at 100.0 it will go at 100%
// speed"), and that sentence is why these two natives sat unimplemented. Two things settle it the
// other way. Blizzard.j's own wrapper for the unit twin, SetUnitTimeScalePercent, hands its native
// `percentScale * 0.01` — a time-scale NATIVE takes a fraction, and "percent" is the GUI's word.
// And the maps that call this one are written for a fraction: 0.36, 0.5, 0.6, 0.7, 1, 2, 4 — and
// progress bars driven at `1 / timeRequired` over a one-second clip, which only works if 1.0 runs
// that clip in one second (codename-askellon, pqhuy98/Warcraft3, CrazySummoners on GitHub). Read
// at 100 = normal, every one of those effects would crawl at a hundredth of its speed.
//
// What jassdoc's note does say that holds either way: a NEGATIVE scale plays backwards and
// "resets towards the beginning", but cannot go below it — it stands still at the start.
//
// The TIME is a playhead, in SECONDS into the clip the effect is playing — the same maps set 0.2
// or 0.51 and then freeze with a scale of 0, or drive a bar with `percentage` on a one-second clip
// — and "can't be a negative value" (jassdoc). Past the end it holds the clip's last frame. That
// one is OURS — no source says — and it is the reading under which CrazySummoners' channel bar,
// which opens by setting 100, starts full rather than wherever 100 s would wrap to.

/** The effect's lifecycle age after `dt` real seconds at `timeScale`. The age is what drives the
 *  Birth (specialFxPhaseAt), so it runs at the effect's speed like the clip does; it never goes
 *  below 0. Once the effect has settled into its Stand, running backwards rewinds the CLIP, not
 *  the life — the Stand plays backwards to its start and holds there (clampToClip) — so the age
 *  does not move, or it would carry a standing effect back into a Birth it already played. */
export function ageAfter(age: number, dt: number, timeScale: number, standing: boolean): number {
  if (timeScale < 0 && standing) return age;
  return Math.max(0, age + dt * timeScale);
}

/** The model frame (ms) `secs` seconds into the clip spanning `interval`: never before its first
 *  frame, never past its last. */
export function seekFrame(interval: ArrayLike<number>, secs: number): number {
  return Math.min(interval[1], interval[0] + Math.max(0, secs) * 1000);
}

/** One step of a clip played BACKWARDS (`timeScale` < 0): `dt` real seconds back from `frame`,
 *  stopping at the clip's first frame. The viewer's own clock only wraps a clip's END, so it is
 *  never handed a negative scale — the renderer rewinds the frame with this instead. */
export function rewindFrame(frame: number, dt: number, timeScale: number, interval: ArrayLike<number>): number {
  return Math.max(interval[0], frame + dt * timeScale * 1000);
}
