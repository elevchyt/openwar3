// Headless check of what a SCRIPT's animation tag does to a unit's clips
// (src/render/unitAnims.ts `scriptAnimTags`, behind AddUnitAnimationProperties).
//
// Test of Balance tags its Sacred Pillar "alternate" between rounds and "work" near the end,
// and its Obelisk.mdx has exactly three stands — "stand", "stand work", "stand alternate" — so
// the three states must pick three different clips. A tier/state word joins the unit's props;
// any other word makes the clip carrying it stand in for the same clip without it.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { scriptAnimTags, buildAnimSet } = require(join(REPO, ".sim-build", "src", "render", "unitAnims.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}
const set = (names, tags, props) => {
  const seqs = names.map((name) => ({ name }));
  const t = scriptAnimTags(seqs, tags);
  return { anims: buildAnimSet(t.seqs, [...(props ?? []), ...t.props]), t };
};

const OBELISK = ["stand", "stand work", "stand alternate", "portrait", "death"];
console.log("Test of Balance's Obelisk.mdx");
check("untagged it stands in its plain stand", set(OBELISK, []).anims.stand, 0);
check("tagged `alternate` it stands in its alternate stand", set(OBELISK, ["alternate"]).anims.stand, 2);
check("…because `alternate` is a PROP, handed on to the tier logic", set(OBELISK, ["alternate"]).t.props, ["alternate"]);
check("tagged `work` it stands in its work stand", set(OBELISK, ["work"]).anims.stand, 1);
check("…and the plain stand is out of the idle pool", set(OBELISK, ["work"]).anims.standVariants, [1]);
check("…with every index still the model's own (nothing removed)", set(OBELISK, ["work"]).t.seqs.length, OBELISK.length);
check("a tag the model has no clip for changes nothing", set(OBELISK, ["gold"]).anims.stand, 0);
check("death is untouched by a stand tag", set(OBELISK, ["work"]).anims.death, 4);

console.log("\nnumbered variants and word order");
const PEASANT = ["Stand", "Stand - 2", "Stand Work", "Stand Work - 2", "Walk", "Attack"];
check("`work` replaces BOTH plain stands, keeping both work variants", set(PEASANT, ["work"]).anims.standVariants, [2, 3]);
check("a multi-word tag is all of its words", set(["Stand", "Stand Upgrade First", "Stand Upgrade Second"], ["upgrade first"]).anims.stand, 1);
check("an Ancient's `work` + its own alternate (\"Stand Work Alternate\") composes", set(["Stand", "Stand Alternate", "Stand Work Alternate"], ["work"], ["alternate"]).anims.stand, 2);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall animation-tag checks passed");
