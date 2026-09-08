// The HAMMER a worker swings while it builds or repairs — where the sound comes from, and
// where in the swing it lands.
//
// WC3 writes this one down in the MODEL, exactly as it writes a rifle's shot. Peasant.mdx and
// Peon.mdx each carry an `SNDXAREP` event object with ONE track parked inside each of their
// "Stand Work" clips, and the code resolves down the ordinary model-sound chain:
//
//   AnimLookups.slk  AREP    → SoundLabel "Repair"
//   AnimSounds.slk   Repair  → PeonRepair1-3.wav, DirectoryBase Abilities\Spells\Other\Repair\
//
// So nothing here is ours except the CLOCK: the clip's interval is the period and the event's
// own track is the phase, which is what `eventCycle` pairs up (rts.tickWorkBlow drives it off a
// timer rather than off the instance's frame, because mdx-m3-viewer only advances an instance
// the camera can see and the row's DistanceCutoff is 3000).
//
// Two workers carry no such event, and their silence is the authentic answer rather than a gap:
// the Acolyte summons and walks away, and the Wisp does not hit anything.
//
// The tracks and sequence lists are read out of the real models when this machine has an
// install, so the test breaks if the assumption about the ART breaks and not only if the code
// does. Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { buildAnimSet, eventCycle } = require(join(REPO, ".sim-build", "src", "render", "unitAnims.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// The models, as they are authored: every sequence's name and interval, plus the times each
// SND event fires at. Transcribed from the 1.30.4 art, and re-read from the install below when
// there is one. Only the clips this test asks about are listed.
const FALLBACK = {
  "units\\human\\Peasant\\Peasant.mdx": {
    sequences: [{ name: "Attack", interval: [23200, 24200] }, { name: "Stand Work", interval: [191333, 191933] }],
    events: { AREP: [191567, 192467, 193367] }, // one per work clip: plain, Gold, Lumber
  },
  "units\\orc\\Peon\\Peon.mdx": {
    sequences: [{ name: "Attack", interval: [7200, 8200] }, { name: "Stand Work", interval: [8300, 8867] }],
    events: { AREP: [8600, 10667, 13167] },
  },
  // No "Stand Work" at all — "Stand Work Gold" is the Acolyte's one working pose, and it fires
  // no sound event of any kind (docs/undead.md: it summons the building and walks away).
  "units\\undead\\Acolyte\\Acolyte.mdx": {
    sequences: [{ name: "Attack", interval: [15467, 16467] }, { name: "Stand Work Gold", interval: [16833, 19100] }],
    events: {},
  },
  "units\\nightelf\\Wisp\\Wisp.mdx": {
    sequences: [{ name: "Stand Work", interval: [7033, 8033] }, { name: "Stand Lumber", interval: [4567, 6600] }],
    events: {},
  },
};

/** The models as the install actually ships them — sequences and SND event tracks. */
async function readModels() {
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
      const events = {};
      for (const e of model.eventObjects) {
        if (e.name.substring(0, 3) !== "SND") continue;
        (events[e.name.substring(4).toUpperCase()] ??= []).push(...e.tracks);
      }
      out.set(path, { sequences: model.sequences.map((s) => ({ name: s.name, interval: [...s.interval] })), events });
    }
  } catch {
    /* fall through to the transcripts */
  }
  return out;
}

/** A CSV line, honouring the quoted fields the SoundInfo tables use for their WAV lists. */
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function soundRow(table, key) {
  const p = join(REPO, "Warcraft III", "ExtractedData", "merged", "UI", "SoundInfo", table);
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "latin1").split(/\r?\n/)) {
    const cols = splitCsv(line);
    if (cols[0]?.toLowerCase() === key.toLowerCase()) return cols;
  }
  return null;
}

main().catch((err) => { console.error(err); process.exit(1); });

async function main() {

const fromInstall = await readModels();
const model = (path) => fromInstall.get(path) ?? FALLBACK[path];
const cycleOf = (path) => {
  const m = model(path);
  const anims = buildAnimSet(m.sequences);
  return { anims, m, cycle: eventCycle({ model: { sequences: m.sequences } }, anims.build, m.events.AREP ?? []) };
};

console.log("the hammer is the model's own AREP event, in its work clip");
{
  const { anims, m, cycle } = cycleOf("units\\human\\Peasant\\Peasant.mdx");
  check("the Peasant hammers with its Stand Work", m.sequences[anims.build].name, "Stand Work");
  check("…one blow per turn of a 600 ms clip", cycle && Math.round(cycle.period * 1000), 600);
  check("…landing 234 ms in, not at the top of the loop", cycle && Math.round(cycle.phase * 1000), 234);
}
{
  const { anims, m, cycle } = cycleOf("units\\orc\\Peon\\Peon.mdx");
  check("the Peon hammers with its Stand Work", m.sequences[anims.build].name, "Stand Work");
  check("…567 ms round", cycle && Math.round(cycle.period * 1000), 567);
  check("…the blow 300 ms in", cycle && Math.round(cycle.phase * 1000), 300);
}

console.log("a worker that fires no such event stays silent");
{
  const acolyte = cycleOf("units\\undead\\Acolyte\\Acolyte.mdx");
  check("the Acolyte's only work pose is its kneel", acolyte.m.sequences[acolyte.anims.build].name, "Stand Work Gold");
  check("…and it carries no AREP at all", acolyte.cycle, null);
  const wisp = cycleOf("units\\nightelf\\Wisp\\Wisp.mdx");
  check("the Wisp authors a Stand Work", wisp.m.sequences[wisp.anims.build].name, "Stand Work");
  check("…but hits nothing, so it fires none either", wisp.cycle, null);
}

console.log("…and an event outside the clip is not this clip's blow");
{
  const seqs = [{ name: "Stand Work", interval: [1000, 1600] }];
  check("a track before the clip", eventCycle({ model: { sequences: seqs } }, 0, [900]), null);
  check("a track after it", eventCycle({ model: { sequences: seqs } }, 0, [1700]), null);
  check("the one inside wins", eventCycle({ model: { sequences: seqs } }, 0, [900, 1300, 1700]), { period: 0.6, phase: 0.3 });
  check("no clip, no cycle", eventCycle({ model: { sequences: seqs } }, -1, [1300]), null);
}

console.log("the sound the code resolves to (the game's own tables)");
{
  const lookup = soundRow("AnimLookups.csv", "AREP");
  const row = soundRow("AnimSounds.csv", "Repair");
  if (!lookup || !row) {
    console.log("  ..  no unpacked SoundInfo tables — run `pnpm data:extract` to check the chain");
  } else {
    check("AREP names the Repair label", lookup[1], "Repair");
    check("…whose WAVs are the peon's three", row[1], "PeonRepair1.wav,PeonRepair2.wav,PeonRepair3.wav");
    check("…in the shared repair folder", row[2], "Abilities\\Spells\\Other\\Repair\\");
    check("…on the anim-sounds channel, preempting when it is full", [row[7], /CHANNELFULLPREEMPT/.test(row[8])], ["11", true]);
    check("…and audible out to 3000", row[11], "3000");
  }
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);

}
