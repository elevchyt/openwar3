// Which clip `BlzPlaySpecialEffect` plays (docs/map-compatibility.md pass 10).
//
// The native names an ANIMATION ("stand", "birth" — ANIM_TYPE_*) and the effect carries a set of
// SUB-ANIMATION tags ("second", "upgrade" — SUBANIM_TYPE_*, added with
// BlzSpecialEffectAddSubAnimation). jassbot's own example of the pair is "if you play anim attack
// it becomes attack slam". A model has no table of these: the only place they exist is its
// sequence NAMES — "Stand Second", "Stand Upgrade Second", "Attack Slam", "Stand - 2".
//
// So the pick is a name match, the same kind render/unitAnims.ts does for a unit's clips:
//   * the clip's FIRST word is the animation (a sequence is named for its action first —
//     "Stand Ready Attack" is a stand);
//   * among those, the one carrying the MOST of the effect's tags wins, and a tag the model has
//     no clip for is simply not decisive — a unit told to "attack slam" with no "Attack Slam"
//     still attacks;
//   * then the one with the FEWEST words beyond them, so plain "Stand" beats "Stand Alternate"
//     when no tag asked for the alternate, and the numbered variants ("Stand - 2") tie with the
//     unnumbered one and lose to it on order.
// No clip starting with the animation word at all → -1, and the native does nothing (a model
// with no such clip is left as it is, as `SetUnitAnimation` does).

/** Split a sequence name into lower-case words, dropping the variant NUMBER ("Stand - 2"). */
function words(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((w) => w && !/^\d+$/.test(w));
}

export function pickEffectSequence(names: readonly string[], anim: string, tags: readonly string[]): number {
  const want = anim.toLowerCase();
  let best = -1;
  let bestHit = -1;
  let bestExtra = Infinity;
  names.forEach((name, i) => {
    const w = words(name);
    if (w[0] !== want) return;
    const rest = w.slice(1);
    const hit = tags.filter((t) => rest.includes(t)).length;
    const extra = rest.filter((x) => !tags.includes(x)).length;
    if (hit > bestHit || (hit === bestHit && extra < bestExtra)) {
      best = i;
      bestHit = hit;
      bestExtra = extra;
    }
  });
  return best;
}

/** The quaternion (x, y, z, w) for an effect's yaw/pitch/roll, in RADIANS: "yaw — rotation
 *  around Z-axis, like a unit; pitch — rotation around Y-axis; roll — rotation around X-axis"
 *  (jassbot, BlzSetSpecialEffectOrientation). Composed yaw · pitch · roll, so the roll and the
 *  pitch act in the effect's own frame and the yaw turns the result, as a unit's facing does.
 *  Each is a plain right-handed turn about its axis: nothing documents the sign any further. */
export function yawPitchRollQuat(yaw: number, pitch: number, roll: number): [number, number, number, number] {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  return [
    cy * cp * sr - sy * sp * cr,
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * cr + sy * sp * sr,
  ];
}
