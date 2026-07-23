// Headless check of the never-stack rule (issue #84): one copy of a WAV in the air at a
// time, per client, and the copy that keeps it is the one the player can actually HEAR.
//
// Audio is the one subsystem a screenshot can't review and a listener can't be precise
// about — "did that clang double?" is exactly the kind of question that gets answered by
// vibes. So the rule is pinned here instead: a fake AudioContext records which files are
// really started and stopped, and the test asks the SoundBoard the awkward questions —
// two units landing the same blow on the same frame, a clip whose variants are all up,
// and a copy that was in earshot when it started but isn't any more because the camera
// moved. That last one is the whole point of the issue: an inaudible copy must not
// silence the same sound landing next to the listener.
//
// Distances come from the real 1.27a UnitCombatSounds.slk row shape (MinDistance 600,
// MaxDistance 10000, DistanceCutoff 2100, WANT3D — verified against the extracted MPQ).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// ---- a fake Web Audio context that remembers what actually played ------------------

const started = []; // every source ever started, in order
class Node {
  connect(next) {
    return next;
  }
}
class Gain extends Node {
  constructor() {
    super();
    this.gain = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} };
  }
}
class Panner extends Node {
  constructor() {
    super();
    for (const p of ["positionX", "positionY", "positionZ", "orientationX", "orientationY", "orientationZ"]) this[p] = { value: 0 };
  }
}
class Source extends Node {
  constructor() {
    super();
    this.buffer = null;
    this.loop = false;
    this.playbackRate = { value: 1 };
    this.onended = null;
    this.live = false;
  }
  start() {
    this.live = true;
    started.push(this);
  }
  stop() {
    if (!this.live) throw new Error("not started / already stopped");
    this.live = false;
    setImmediate(() => this.onended && this.onended());
  }
}
class Ctx {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = new Node();
    this.listener = {};
    for (const p of ["positionX", "positionY", "positionZ", "forwardX", "forwardY", "forwardZ", "upX", "upY", "upZ"]) this.listener[p] = { value: 0 };
  }
  createGain() {
    return new Gain();
  }
  createPanner() {
    return new Panner();
  }
  createBufferSource() {
    return new Source();
  }
  // The "decoded" buffer carries its own path, so the test can name what is playing.
  async decodeAudioData(ab) {
    return { duration: 1, path: new TextDecoder().decode(ab) };
  }
  async resume() {}
}
global.window = { AudioContext: Ctx };

/** Files currently sounding, sorted (a set, since the rule says at most one copy each). */
const sounding = () => started.filter((s) => s.live).map((s) => s.buffer.path).sort();
/** Let the decode promises + onended callbacks settle. */
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// ---- the sound data: one single-variant clang, one with three variants -------------
// MappedData falls back to INI parsing for anything not starting with "ID;", so the
// SoundInfo rows can be written as sections rather than hand-rolled SLK.

const DIR = "Sound\\Units\\Combat\\";
const COMBAT = `
[SwordLoneFlesh]
FileNames=Lone.wav
DirectoryBase=${DIR}
Volume=127
Pitch=1
Channel=5
Flags=WANT3D
MinDistance=600
MaxDistance=10000
DistanceCutoff=2100

[SwordManyFlesh]
FileNames=Many1.wav,Many2.wav,Many3.wav
DirectoryBase=${DIR}
Volume=127
Pitch=1
Channel=5
Flags=WANT3D
MinDistance=600
MaxDistance=10000
DistanceCutoff=2100
`;
const UI = `
[InterfaceClick]
FileNames=MouseClick1.wav
DirectoryBase=Sound\\Interface\\
Volume=127
Pitch=1
Channel=8
Flags=0
`;
const TABLES = {
  "UI\\SoundInfo\\UnitCombatSounds.slk": COMBAT,
  "UI\\SoundInfo\\UISounds.slk": UI,
};
// mdx-m3-viewer's INI parser splits on CRLF only (the archives are DOS text).
const bytes = (s) => Uint8Array.from([...s.replace(/\r?\n/g, "\r\n")].map((c) => c.charCodeAt(0) & 0xff));
const vfs = {
  rawBytes: (p) => (TABLES[p] ? bytes(TABLES[p]) : undefined),
  read: async (p) => new TextEncoder().encode(p),
  exists: () => true,
  list: () => [],
};

const { SoundBoard } = require(join(REPO, ".sim-build", "src", "audio", "sounds.js"));

/** A board with the camera looking down at `(x, y)` from above. */
function board(x = 0, y = 0) {
  started.length = 0;
  const b = new SoundBoard(vfs);
  b.setListener([x, y, 0], [x, y, 1000]);
  return b;
}
const look = (b, x, y) => b.setListener([x, y, 0], [x, y, 1000]);

(async () => {
  console.log("two sources land the SAME single-variant clang on the same frame");
  {
    const b = board();
    b.playImpact("SwordLone", "Flesh", { x: 0, y: 0 });
    b.playImpact("SwordLone", "Flesh", { x: 100, y: 0 }); // a second unit, a step away
    await settle();
    check("only one copy is in the air", sounding(), [DIR + "Lone.wav"]);
    check("the second was refused, not stacked", started.length, 1);
  }

  console.log("\nthree sources land a clang that ships three variants");
  {
    const b = board();
    for (const x of [0, 100, 200]) b.playImpact("SwordMany", "Flesh", { x, y: 0 });
    await settle();
    check("each took a different WAV", sounding(), [DIR + "Many1.wav", DIR + "Many2.wav", DIR + "Many3.wav"]);
    b.playImpact("SwordMany", "Flesh", { x: 300, y: 0 }); // …and a fourth, with none left
    await settle();
    check("the fourth is dropped (all variants up, none quieter)", started.length, 3);
  }

  console.log("\na copy that is no longer in earshot counts as not playing");
  {
    const b = board(0, 0);
    b.playImpact("SwordLone", "Flesh", { x: 0, y: 0 });
    await settle();
    check("it started next to the camera", sounding(), [DIR + "Lone.wav"]);
    look(b, 9000, 0); // the player scrolls away: the copy is now well past its 2100 cutoff
    b.playImpact("SwordLone", "Flesh", { x: 9000, y: 0 }); // a fight where the camera IS
    await settle();
    check("the audible blow took the file over", started.length, 2);
    check("and only it is sounding", sounding(), [DIR + "Lone.wav"]);
    check("the inaudible copy was cut", started[0].live, false);
  }

  console.log("\n…but an audible copy is not cut for a quieter one");
  {
    const b = board(0, 0);
    b.playImpact("SwordLone", "Flesh", { x: 0, y: 0 }); // right under the camera
    await settle();
    b.playImpact("SwordLone", "Flesh", { x: 2000, y: 0 }); // in range, but further off
    await settle();
    check("the distant blow is refused", started.length, 1);
    check("the near one plays on", started[0].live, true);
  }

  console.log("\nout of range on BOTH sides: nothing is disturbed");
  {
    const b = board(0, 0);
    b.playImpact("SwordLone", "Flesh", { x: 5000, y: 0 }); // past the cutoff — never played
    await settle();
    check("nothing started", started.length, 0);
  }

  console.log("\na 2D interface sound (the NODUPLICATES case)");
  {
    const b = board();
    b.playUi("InterfaceClick");
    b.playUi("InterfaceClick"); // a double-click, or a cancel button firing twice
    await settle();
    check("clicked twice, played once", started.length, 1);
    check("and it is still sounding", sounding(), ["Sound\\Interface\\MouseClick1.wav"]);
  }

  console.log("\nthe file is free again once its copy ends");
  {
    const b = board();
    b.playImpact("SwordLone", "Flesh", { x: 0, y: 0 });
    await settle();
    started[0].stop(); // the clip runs out
    await settle();
    b.playImpact("SwordLone", "Flesh", { x: 0, y: 0 });
    await settle();
    check("the next blow plays", started.length, 2);
    check("and it is the one sounding", sounding(), [DIR + "Lone.wav"]);
  }

  console.log("\ntwo channelled fields share one looping bed, and hand it over");
  {
    const b = board();
    const LOOP = "Abilities\\Spells\\Human\\Blizzard\\BlizzardLoop1.wav";
    b.setPathLoop("field-a", LOOP, true, { x: 0, y: 0 });
    b.setPathLoop("field-b", LOOP, true, { x: 500, y: 0 }); // a second Blizzard
    await settle();
    check("one howl, not two", sounding(), [LOOP]);
    b.setPathLoop("field-a", "", false); // the first field ends; the second is still up
    await settle();
    check("the bed carries on for the surviving field", sounding(), [LOOP]);
    check("…as a fresh source at its own spot", started.length, 2);
    b.setPathLoop("field-b", "", false);
    await settle();
    check("and stops when the last field does", sounding(), []);
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
