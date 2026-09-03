// Which clip a unit SWINGS — checked against the sequence lists real models ship.
//
// A model that authors a plain "Attack" (or "Attack - 2", …) is the easy majority. 102 of the
// 835 unit models author none, and for them the picker used to take "the first sequence whose
// name merely CONTAINS attack". For the biggest group of those that is the wrong clip:
//
//     Owlbear.mdx  →  "Attack Spell Slam" | "Attack Slam" | "Attack Slam -2"
//
// — the War Stomp comes first, so the Wildkin (nowb), the Enraged (nowe) and the Berserk (nowk)
// played a ground pound at every blow and never once used either of their two real slams. Rise
// of the Naga stages a Berserk Wildkin swinging at a Watcher in a cinematic, which is where a
// creep's melee animation is actually looked at.
//
// The sequence names below are read straight out of the models (mdlx parser) rather than typed
// in, so this test breaks if the assumption about the ART breaks, not just if the code changes.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { buildAnimSet } = require(join(REPO, ".sim-build", "src", "render", "unitAnims.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}
const named = (set, seqs) => (i) => (i >= 0 && i < seqs.length ? seqs[i].name : null);

// The models this is about, as they are authored. Read from the install when it is there (the
// developer's own copy — never committed), else from these transcripts of the same lists.
const FALLBACK = {
  "units\\creeps\\Owlbear\\Owlbear.mdx": [
    "Stand", "Stand -2", "Attack Spell Slam", "Stand -4", "Stand Ready",
    "Attack Slam", "Attack Slam -2", "Death", "Walk", "Decay Flesh", "Decay Bone",
  ],
  "units\\human\\Footman\\Footman.mdx": [
    "Stand - 1", "Stand - 2", "Stand Victory", "Stand - 4", "Attack - 1", "Attack - 2",
    "Walk", "Stand Defend", "Walk Defend", "Death", "Decay Flesh", "Attack Defend", "Decay Bone",
  ],
  // The proc slam lives here rather than on the Footman: 1.30.4 re-exported Footman.mdx with
  // Defend clips in place of its slam, and the Blademaster's is the better example anyway —
  // "Attack Slam" IS his Critical Strike, a clip the picker must keep OUT of the ordinary
  // swing rotation and still be able to reach by name when the proc fires.
  "units\\orc\\HeroBladeMaster\\HeroBladeMaster.mdx": [
    "Stand - 2", "Stand cinematic", "Attack", "Attack Slam", "Stand - 4", "Death", "Walk",
    "Stand", "Attack 2", "Stand Ready", "Stand Victory", "Dissipate", "Portrait 1",
    "Attack Walk Stand Spin",
  ],
  "units\\human\\Priest\\Priest.mdx": [
    "Stand", "Stand - 2", "Spell Attack", "Spell", "Death", "Walk", "Decay Flesh", "Decay Bone",
  ],
};

/** A model's sequence names, read from the install when this machine has one — either
 *  storage, since the mount is the engine's own (tools/install.cjs). */
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

console.log("the Berserk Wildkin swings, it does not stomp");
{
  const names = sequences("units\\creeps\\Owlbear\\Owlbear.mdx");
  const seqs = names.map((name) => ({ name }));
  check("the model still authors no plain Attack", names.filter((n) => /^attack(\s*-?\s*\d+)?\s*$/i.test(n)), []);
  check("…and its first attack-ish clip is still the War Stomp", names.find((n) => /attack/i.test(n)), "Attack Spell Slam");
  const a = buildAnimSet(seqs);
  const name = named(a, seqs);
  check("the swing is a slam", name(a.attack), "Attack Slam");
  check("…and BOTH slams are in the rotation", a.attackVariants.map(name), ["Attack Slam", "Attack Slam -2"]);
  check("the cast clip is not among them", a.attackVariants.map(name).includes("Attack Spell Slam"), false);
  check("…but the caster can still find it by name", a.seqNames.includes("Attack Spell Slam"), true);
}

console.log("a model with a plain Attack is untouched");
{
  const names = sequences("units\\human\\Footman\\Footman.mdx");
  const seqs = names.map((name) => ({ name }));
  const a = buildAnimSet(seqs);
  const name = named(a, seqs);
  check("the Footman swings his first plain attack", name(a.attack), "Attack - 1");
  check("…with every plain variant in the rotation", a.attackVariants.map(name), ["Attack - 1", "Attack - 2"]);
}

console.log("a proc slam is kept out of the ordinary rotation");
{
  const names = sequences("units\\orc\\HeroBladeMaster\\HeroBladeMaster.mdx");
  const seqs = names.map((name) => ({ name }));
  const a = buildAnimSet(seqs);
  const name = named(a, seqs);
  check("the Blademaster swings his plain attack", name(a.attack), "Attack");
  check("…with both plain variants in the rotation", a.attackVariants.map(name), ["Attack", "Attack 2"]);
  check("…and his Critical Strike slam is separate", name(a.attackSlam), "Attack Slam");
}

console.log("a caster whose ONLY attack is a spell keeps it");
{
  const names = sequences("units\\human\\Priest\\Priest.mdx");
  const seqs = names.map((name) => ({ name }));
  const a = buildAnimSet(seqs);
  check("the Priest still has a swing to play", named(a, seqs)(a.attack), "Spell Attack");
}

console.log(failed === 0 ? "\nattack animations: all checks passed" : `\nattack animations: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

}
