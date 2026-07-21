/**
 * What the RENDER path reads off a unit (docs/multiplayer.md Phase E item 10c-2b).
 *
 * A host draws its own `SimWorld`; a client draws the `WorldSnapshot` it was sent. Those are
 * two different structs, and the renderer must not care which one it was handed — so every
 * render consumer is typed against this readonly surface instead, and both `SimUnit` and
 * `UnitSnapshot` satisfy it structurally. `tools/render-unit-conformance.ts` is what makes
 * that a fact rather than an intention.
 *
 * **It carries only fields something is actually typed against today**, and it grows one
 * consumer at a time as 10c takes them. A speculative field here would be a field nobody has
 * checked either struct against, which is exactly the drift the conformance file exists to
 * catch. Item 5 chose `UnitSnapshot`'s members by reading these same consumers, so the two
 * lists are two views of one decision and are expected to converge.
 *
 * **Readonly throughout, and that is load-bearing.** Rendering never writes to the world — on
 * a client there is no world to write to, only a payload that the next snapshot replaces. A
 * `readonly` surface makes a render consumer that tried to mutate a compile error rather than
 * a bug that only shows up on the client build.
 *
 * This file imports nothing. It is a contract between two modules that must not import each
 * other, so it belongs to neither.
 */

/** The four numbers `attackAnimRate` recovers the attack-speed factor from. `SimWeapon` and
 *  `WeaponSnapshot` both carry them; the rest of each (damage dice, range, cooldown) is the
 *  HUD's business, not the animation's. */
export interface RenderWeapon {
  readonly damagePoint: number;
  readonly backswing: number;
  readonly baseDamagePoint: number;
  readonly baseBackswing: number;
}

/** The unit, as the render path reads it. */
export interface RenderUnit {
  /** Live move speed — the walk clip is re-rated against the model's authored gait. */
  readonly speed: number;
  /** `SimOrder` on the sim side and a plain string on the wire; the renderer only ever
   *  compares it, so the wider type is the honest one here. */
  readonly order: string;
  readonly working: boolean;
  /** Building id this worker is constructing (0 = none) — the renderer only asks truthiness. */
  readonly constructing: number;
  /** Which HALF of a two-form model is showing (a rooted Ancient, a burrowed Crypt Fiend). */
  readonly altModel: boolean;
  readonly repair: { readonly active: boolean } | null;
  readonly worker: { readonly carryGold: number; readonly carryLumber: number } | null;
  /** Present iff this is a structure. The renderer keys "is it a building" off that, and reads
   *  the queue only for whether it is non-empty (the "Stand Work" clip). */
  readonly building: { readonly queue: readonly unknown[] } | null;
  readonly weapon: RenderWeapon | null;
  readonly swingWeapon: RenderWeapon | null;
}
