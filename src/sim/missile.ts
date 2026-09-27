/**
 * THE FLIGHT OF A MISSILE — its height and its nose, as a function of how far it has come.
 *
 * Every missile the sim flies (a homing arrow, an artillery shell thrown at the ground, one
 * that lost its target and is dying at a spot) moves in the PLANE at its `Missilespeed` and
 * takes its height from here, so a shot thrown high is not a slower shot: the Mortar Team's
 * shell covers 1150 units of map in the same time at any arc, and simply goes up and comes
 * down faster to do it. That is also why the plane step stays with each caller — how a
 * missile moves across the ground is a question with four answers (home, fly at a spot,
 * sweep a line), and how HIGH it is while doing so has only one.
 *
 * The height is the straight launch→impact line PLUS a parabola that is 0 at both ends and
 * peaks at the middle of the flight:
 *
 *     z(p) = startZ + (impactZ − startZ)·p + 4·h·p·(1 − p),   h = arc × startDist
 *
 * `arc` is the weapon's own `Missilearc` (UnitFunc.txt, a per-slot list like `Missileart`):
 * a FRACTION OF THE DISTANCE thrown, not a height, which is what makes a lob at the edge of a
 * Mortar Team's range tower over one thrown at a Footman 300 units away. The file states the
 * number and not the curve; the curve is the community's model of it (the parabola every
 * Hive missile system draws — `4·h·x·(d − x)/d²`, hiveworkshop 207854 / 275718 — with the peak
 * at `arc × distance`), and it is the one shape that is 0 at both ends, symmetric, and scales
 * with the throw. The stock values it is fed: 0.35 on the Mortar Team, the Demolisher and the
 * Cannon Tower, 0.3 on the Meat Wagon, 0.15 on every bow, 0.05 on the Glaive Thrower.
 *
 * `p` is progress over the HORIZONTAL distance, measured against `startDist` — the distance
 * at the loosing. A homing missile whose target walks AWAY therefore stalls at the top of its
 * arc rather than climbing forever (p is clamped to [0, 1]), and one whose target walks
 * towards it comes down early: it is still flying at the unit, not at the spot.
 */

/** The fields of a SimProjectile this module reads and writes — the whole of it, so a client's
 *  display copy (rts.tickClientProjectiles) steps with exactly the host's arithmetic. */
export interface MissileFlight {
  z: number;
  startZ: number;
  impactZ: number;
  startDist: number;
  /** `Missilearc` of the weapon that loosed it; absent/0 = the straight line it always was. */
  arc?: number;
  /** The nose's angle above the horizontal, in radians, for the renderer to tilt the model
   *  down the curve (an arrow comes down point first). Derived here, never simulated. */
  pitch?: number;
}

/** Set `p.z` (and `p.pitch`) for a missile with `remaining` horizontal distance still to go. */
export function flyHeight(p: MissileFlight, remaining: number): void {
  const d = p.startDist;
  const prog = d > 1 ? Math.max(0, Math.min(1, (d - remaining) / d)) : 1;
  const h = (p.arc ?? 0) * d; // the peak ABOVE the launch→impact line
  p.z = p.startZ + (p.impactZ - p.startZ) * prog + 4 * h * prog * (1 - prog);
  // dz/ds: the line's own slope plus the parabola's, which is +4·arc at the launch, 0 at the
  // top and −4·arc at the impact — a 0.35 shell leaves at ~54° and lands at the same angle.
  p.pitch = d > 1 ? Math.atan(((p.impactZ - p.startZ) + 4 * h * (1 - 2 * prog)) / d) : 0;
}
