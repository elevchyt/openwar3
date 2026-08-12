// Which clips an ANCIENT plays, planted and walking.
//
// A night elf Ancient is one model carrying two units: a building that trains and blocks cells,
// and a slow angry tree that walks and swings. Which half is showing is `SimUnit.altModel`, and
// the mapping is the reverse of the obvious guess — the PLAIN clips are the walking form (only
// an uprooted Ancient walks, and "Walk" has no alternate twin) and the `* Alternate` ones are
// the planted tree. The training pose being "Stand Work Alternate" is the proof: an Ancient
// trains only while planted.
//
// Three things that go wrong here are all invisible to a headless sim and obvious on screen:
//
//   • a rooted Ancient standing in its WALKER's pose. AncientOfWar.mdx renames cleanly, but
//     AncientProtector.mdx authors its planted stand as "Stand Walk Alternate" — a name no
//     plain-stand pattern matches and whose tokens match none of the four mobile "Stand"/
//     "Stand 2-4" clips, so those used to win and a planted tower stood like a walker.
//   • an UPROOTED Ancient in the planted tree's working pose: WC3 halts a walking Ancient's
//     production queue rather than cancelling it, and an unanchored "stand work" match finds
//     "Stand Work Alternate" with the alternate props off.
//   • the morph pair played backwards. A form's Morph is the clip it plays to LEAVE that form,
//     so "Morph Alternate" is the planted tree hauling its roots up and the plain "Morph" is
//     the walker settling down.
//
// The sequence names below are read straight out of the models when this machine has an
// install, so this breaks if the assumption about the ART breaks, not just if the code changes.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { buildAnimSet, animPropsFor } = require(join(REPO, ".sim-build", "src", "render", "unitAnims.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// Transcribed off the real 1.30.4 models (read back through the running game), preserving the
// models' own inconsistent casing — the pickers are case-insensitive and must stay so.
const FALLBACK = {
  "buildings\\nightelf\\AncientOfWar\\AncientOfWar.mdx": [
    "", "Stand - 1", "Stand- 2", "Walk", "Attack - 1", "Attack - 2", "Spell Eattree", "Morph",
    "stand alternate", "Morph Alternate", "death", "stand work alternate", "Birth",
    "death alternate", "decay alternate", "decay", "Attack Alternate",
  ],
  "buildings\\nightelf\\AncientOfLore\\AncientOfLore.mdx": [
    "stand", "walk", "Attack", "stand - 2", "Morph", "stand alternate", "Stand Work Alternate",
    "Death", "morph alternate", "Birth", "Death Alternate", "Decay Alternate", "Stand - 3",
    "Attack - 2", "Decay", "Spell EatTree", "alternate attack",
  ],
  "buildings\\nightelf\\AncientProtector\\AncientProtector.mdx": [
    "Stand", "Stand 2", "Stand 3", "Stand 4", "Stand Ready", "Attack", "Attack 2", "Death",
    "Walk", "Spell EatTree", "Morph", "Stand Walk Alternate", "Attack Alternate",
    "Morph Alternate", "Birth", "Death Alternate",
  ],
  // A night elf building that is NOT an Ancient: no alternate half at all, and its production
  // pose is the plain "Stand Work" every other race's buildings use.
  "buildings\\nightelf\\ChimaeraRoost\\ChimaeraRoost.mdx": ["Birth", "stand", "Stand Work", "Portrait", "Death"],
};

/** A model's sequence names, read from the install when this machine has one. */
async function readSequences() {
  const out = new Map();
  const wc3 = join(REPO, "Warcraft III");
  if (!existsSync(wc3)) return out;
  try {
    const { openInstall } = require("./install.cjs");
    const Model = require("mdx-m3-viewer/dist/cjs/parsers/mdlx/model");
    const { vfs } = await openInstall(wc3);
    for (const path of Object.keys(FALLBACK)) {
      const bytes = vfs.rawBytes(path);
      if (!bytes) continue;
      const model = new (Model.default ?? Model)();
      model.load(bytes);
      out.set(path, model.sequences.map((s) => s.name));
    }
  } catch {
    /* fall through to the transcripts */
  }
  return out;
}

main().catch((err) => { console.error(err); process.exit(1); });

async function main() {

const fromInstall = await readSequences();
const sequences = (path) => fromInstall.get(path) ?? FALLBACK[path];
// `def` is the UnitDef shape animPropsFor reads — the Ancients carry NO static Animprops, so
// the ability is what decides which half they wear, moment to moment.
const sets = (path) => {
  const seqs = sequences(path).map((name) => ({ name }));
  const of = (rooted) => {
    const a = buildAnimSet(seqs, animPropsFor({ animProps: [] }, rooted));
    return { a, name: (i) => (i >= 0 && i < seqs.length ? seqs[i].name : null) };
  };
  return { rooted: of(true), walking: of(false) };
};

console.log("the Ancient of War: planted is the ALTERNATE half");
{
  const { rooted, walking } = sets("buildings\\nightelf\\AncientOfWar\\AncientOfWar.mdx");
  check("planted, it stands in its alternate stand", rooted.name(rooted.a.stand), "stand alternate");
  check("…trains in \"Stand Work Alternate\"", rooted.name(rooted.a.standWork), "stand work alternate");
  check("…and dies its alternate death", rooted.name(rooted.a.death), "death alternate");
  check("walking, it stands in the plain one", walking.name(walking.a.stand), "Stand - 1");
  check("…walks", walking.name(walking.a.walk), "Walk");
  check("…dies the plain death", walking.name(walking.a.death), "death");
  // The one that put a walking Ancient in the planted tree's working pose: its queue is
  // HALTED, not cancelled, so pickSequence still asks for a work clip while it walks.
  check("…and has no work pose to borrow while it walks", walking.a.standWork, -1);
}

console.log("…and the Morph pair is the clip each form plays to LEAVE itself");
{
  const { rooted, walking } = sets("buildings\\nightelf\\AncientOfWar\\AncientOfWar.mdx");
  check("uprooting plays the planted half's Morph", rooted.name(rooted.a.morph), "Morph Alternate");
  check("planting plays the walker's", walking.name(walking.a.morph), "Morph");
}

console.log("the Ancient of Lore agrees, in its own casing");
{
  const { rooted, walking } = sets("buildings\\nightelf\\AncientOfLore\\AncientOfLore.mdx");
  check("planted stand", rooted.name(rooted.a.stand), "stand alternate");
  check("planted work pose", rooted.name(rooted.a.standWork), "Stand Work Alternate");
  check("planted morph (uprooting)", rooted.name(rooted.a.morph), "morph alternate");
  check("walking stand", walking.name(walking.a.stand), "stand");
}

console.log("the Ancient Protector, whose planted stand is named for a walk");
{
  const { rooted, walking } = sets("buildings\\nightelf\\AncientProtector\\AncientProtector.mdx");
  check("the model still authors no plain-looking alternate stand",
    sequences("buildings\\nightelf\\AncientProtector\\AncientProtector.mdx").filter((n) => /alternate/i.test(n) && /^stand/i.test(n)),
    ["Stand Walk Alternate"]);
  check("planted, it stands in its OWN half all the same", rooted.name(rooted.a.stand), "Stand Walk Alternate");
  check("…and not in one of the walker's four", rooted.a.standVariants.map(rooted.name), ["Stand Walk Alternate"]);
  check("…it swings its alternate attack", rooted.name(rooted.a.attack), "Attack Alternate");
  check("…dies its alternate death", rooted.name(rooted.a.death), "Death Alternate");
  check("…and trains nothing at all", rooted.a.standWork, -1);
  check("uprooted, the four mobile stands come back", walking.a.standVariants.map(walking.name), ["Stand", "Stand 2", "Stand 3", "Stand 4"]);
}

console.log("a night elf building that is NOT an Ancient has one half and one work pose");
{
  const seqs = sequences("buildings\\nightelf\\ChimaeraRoost\\ChimaeraRoost.mdx").map((name) => ({ name }));
  const a = buildAnimSet(seqs, animPropsFor({ animProps: [] }, false));
  const name = (i) => (i >= 0 && i < seqs.length ? seqs[i].name : null);
  check("it stands", name(a.stand).toLowerCase(), "stand"); // the model's own casing varies
  check("…and produces in the plain \"Stand Work\"", name(a.standWork), "Stand Work");
  check("…with no morph to play", a.morph, -1);
}

console.log(failed === 0 ? "\nancient animations: all checks passed" : `\nancient animations: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

}
