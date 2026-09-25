// Headless check of what a SCRIPT does to a special effect's model (src/render/effectAnim.ts —
// docs/map-compatibility.md pass 10): which clip `BlzPlaySpecialEffect` plays for an animation
// and a set of sub-animation tags, and the rotation `BlzSetSpecialEffectOrientation` builds.
//
// The clip names are real ones from the install's models, as render/unitAnims.ts quotes them —
// reordered tokens, numbered variants and all — because the pick is a NAME match and made-up
// names would only test the made-up spelling.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { pickEffectSequence, yawPitchRollQuat } = require(join(REPO, ".sim-build", "src", "render", "effectAnim.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

console.log("which clip an animation and its tags name");
{
  // TreeofLife.mdx's own stands, beside a plain Birth and Death.
  const tree = ["Birth", "Stand Upgrade First Second", "Stand Alternate Upgrade First Second", "Stand", "Stand - 2", "Death"];
  check("no tags: the plain Stand, not a variant and not a tagged one", pickEffectSequence(tree, "stand", []), 3);
  check("upgrade + second: the clip carrying both", pickEffectSequence(tree, "stand", ["second", "upgrade"]), 1);
  check("…and adding alternate picks the planted one", pickEffectSequence(tree, "stand", ["second", "upgrade", "alternate"]), 2);
  check("a tag the model has no clip for is not decisive", pickEffectSequence(tree, "death", ["slam"]), 5);
  check("an animation the model does not have is -1", pickEffectSequence(tree, "attack", []), -1);
  check("case and the variant number do not matter", pickEffectSequence(["stand - 1", "BIRTH"], "birth", []), 1);
  // "if you play anim attack it becomes attack slam" (jassbot, BlzSpecialEffectClearSubAnimations)
  const swings = ["Attack - 1", "Attack - 2", "Attack Slam", "Stand"];
  check("attack with the slam tag becomes Attack Slam", pickEffectSequence(swings, "attack", ["slam"]), 2);
  check("…and without it, the first plain Attack", pickEffectSequence(swings, "attack", []), 0);
  // HumanTower.mdx: the ACTION is the first word — "Stand Ready Attack" is a stand.
  check("the first word is the animation", pickEffectSequence(["Stand Ready Attack", "Attack Stand Ready Upgrade Second"], "attack", []), 1);
}

console.log("\nthe rotation a yaw, pitch and roll make");
{
  // Rotate a vector by a quaternion (x, y, z, w).
  const rot = ([x, y, z, w], [vx, vy, vz]) => {
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)].map((n) => Math.round(n * 1000) / 1000 + 0);
  };
  check("no rotation is the identity", yawPitchRollQuat(0, 0, 0), [0, 0, 0, 1]);
  check("yaw a quarter turn: facing east becomes facing north, like a unit", rot(yawPitchRollQuat(Math.PI / 2, 0, 0), [1, 0, 0]), [0, 1, 0]);
  check("pitch turns about Y", rot(yawPitchRollQuat(0, Math.PI / 2, 0), [1, 0, 0]), [0, 0, -1]);
  check("roll turns about X", rot(yawPitchRollQuat(0, 0, Math.PI / 2), [0, 1, 0]), [0, 0, 1]);
  check("yaw turns the PITCHED model, not the other way round", rot(yawPitchRollQuat(Math.PI / 2, Math.PI / 2, 0), [1, 0, 0]), [0, 0, -1]);
  check("…so a pitched model then yawed points its side the new way", rot(yawPitchRollQuat(Math.PI / 2, Math.PI / 2, 0), [0, 1, 0]), [-1, 0, 0]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall effect-animation checks passed");
process.exit(failed ? 1 : 0);
