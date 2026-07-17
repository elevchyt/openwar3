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
