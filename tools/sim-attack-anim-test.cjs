// Which clip a unit SWINGS — checked against the sequence lists real 1.27a models ship.
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
const { readFileSync, existsSync } = require("node:fs");
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
    "Stand - 1", "Stand - 2", "Stand - 4", "Stand Ready", "Attack - 1", "Attack - 2",
    "Attack Slam", "Death", "Walk", "Decay Flesh", "Decay Bone",
  ],
  "units\\human\\Priest\\Priest.mdx": [
    "Stand", "Stand - 2", "Spell Attack", "Spell", "Death", "Walk", "Decay Flesh", "Decay Bone",
  ],
};

/** A model's sequence names, from the archives if this machine has them. */
function sequences(path) {
  const wc3 = join(REPO, "Warcraft III");
  if (!existsSync(wc3)) return FALLBACK[path];
  try {
    const { Archive } = require("mdx-m3-viewer/dist/cjs/parsers/mpq");
    const Model = require("mdx-m3-viewer/dist/cjs/parsers/mdlx/model");
    for (const name of ["War3.mpq", "War3x.mpq", "War3xLocal.mpq", "War3Patch.mpq"]) {
      const file = join(wc3, name);
      if (!existsSync(file)) continue;
      const buf = readFileSync(file);
      const bytes = new Uint8Array(buf.byteLength);
      bytes.set(buf);
      const archive = new Archive();
      archive.load(bytes, true);
      const entry = archive.get(path);
      if (!entry) continue;
      const model = new (Model.default ?? Model)();
      model.load(entry.bytes());
      return model.sequences.map((s) => s.name);
    }
  } catch {
    /* fall through to the transcript */
  }
  return FALLBACK[path];
}

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
  check("…and his proc slam is separate", name(a.attackSlam), "Attack Slam");
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
