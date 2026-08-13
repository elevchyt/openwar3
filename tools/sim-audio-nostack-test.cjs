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

[SwordOnceFlesh]
FileNames=Once.wav
DirectoryBase=${DIR}
Volume=127
Pitch=1
Channel=5
Flags=WANT3D,NODUPLICATES
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

[GlueScreenClick]
FileNames=BigButtonClick.wav
DirectoryBase=Sound\\Interface\\
Volume=100
Pitch=1
Channel=8
Flags=NODUPLICATES

[PlaceBuildingDefault]
FileNames=BuildingPlacement.wav
DirectoryBase=Sound\\Buildings\\Shared\\
Volume=110
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
    // Equal audibility (both inside MinDistance), and UnitCombatSounds asks for
    // NODUPLICATES on none of its 59 rows, so the tie is the second blow's to win — but
    // it wins the file off a copy that has not STARTED yet (the decode is a microtask
    // away), so the loser is cancelled rather than cut and exactly one source is ever
    // built. Two blows on one frame sound like one blow either way; which of the two it
    // is only becomes observable once the first has really been in the air (below).
    check("one source, not two", started.length, 1);
  }

  console.log("\n…unless the row asks for NODUPLICATES, which refuses outright");
  {
    const b = board();
    b.playImpact("SwordOnce", "Flesh", { x: 0, y: 0 });
    b.playImpact("SwordOnce", "Flesh", { x: 100, y: 0 });
    await settle();
    check("the second was refused", started.length, 1);
    check("and the first plays on, uncut", started[0].live, true);
  }

  // The Warden (issue: "her attack sound stops working"). `WardenAttack` is a SINGLE
  // 1.358 s WAV, and her Base Attack Time — `cool1` 2.05 over 1 + AgiAttackSpeedBonus ×
  // agi — is 1.46 s at level 1 and 1.35 s by level 5. So from level 5 every swing asks
  // for the file while her own previous grunt still holds it, at exactly her own
  // audibility. Refusing that tie muted her completely; only the flag may do that.
  console.log("\na source repeating a single-variant clip faster than the clip is long");
  {
    const b = board();
    for (let i = 0; i < 3; i++) {
      b.playImpact("SwordLone", "Flesh", { x: 0, y: 0 }); // the same unit, standing still
      await settle();
    }
    check("every blow was heard", started.length, 3);
    check("but only ever one at a time", sounding(), [DIR + "Lone.wav"]);
    check("each cut the one before it", started.filter((s) => s.live).length, 1);
  }

  console.log("\nthree sources land a clang that ships three variants");
  {
    const b = board();
    for (const x of [0, 100, 200]) b.playImpact("SwordMany", "Flesh", { x, y: 0 });
    await settle();
    check("each took a different WAV", sounding(), [DIR + "Many1.wav", DIR + "Many2.wav", DIR + "Many3.wav"]);
    b.playImpact("SwordMany", "Flesh", { x: 300, y: 0 }); // …and a fourth, with none left
    await settle();
    // All four are inside MinDistance, so the falloff is flat and the fourth ties rather
    // than losing. The row does not ask for NODUPLICATES, so it takes the file off the
    // least audible copy — a tie, so the first — and is heard. WC3 would play all four;
    // this plays the newest, which is nearer that than dropping the blow on the floor.
    check("the fourth is heard, taking the file over", started.length, 4);
    check("…and the copy it took it from was cut", started.filter((s) => !s.live).length, 1);
    check("so there are still only three copies in the air", sounding(), [DIR + "Many1.wav", DIR + "Many2.wav", DIR + "Many3.wav"]);
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

  // Which of the two a UI row gets is the DATA's call, not the kind's: 69 of UISounds'
  // 133 rows carry NODUPLICATES and 64 do not, and the split is exactly the one the
  // GlueScreenClick comment column describes — the flag is there to stop ONE event
  // sounding twice (a cancel button firing on both press and release), not to mute a
  // second press.
  console.log("\na 2D interface sound that ASKS for NODUPLICATES (GlueScreenClick)");
  {
    const b = board();
    b.playUi("GlueScreenClick");
    b.playUi("GlueScreenClick"); // the cancel button firing twice off one press
    await settle();
    check("fired twice, played once", started.length, 1);
    check("and it is still sounding", sounding(), ["Sound\\Interface\\BigButtonClick.wav"]);
    b.playUi("GlueScreenClick"); // …and refused again while that copy is genuinely up
    await settle();
    check("a later press is refused too, while the copy is up", started.length, 1);
  }

  console.log("\na 2D interface sound that does NOT (Flags=0 — it sounds per press)");
  {
    const b = board();
    const WAV = "Sound\\Buildings\\Shared\\BuildingPlacement.wav";
    b.playUi("PlaceBuildingDefault");
    await settle(); // the first tower's confirm is genuinely in the air
    check("the first placement sounds", started.length, 1);
    b.playUi("PlaceBuildingDefault"); // the next tower of a shift-placed row
    await settle();
    check("…and so does the next one", started.length, 2);
    check("…which cut the first, so still only one copy is in the air", started[0].live, false);
    check("…and it is the new one", sounding(), [WAV]);
    b.playUi("InterfaceClick");
    await settle();
    b.playUi("InterfaceClick"); // a real double-click clicks twice
    await settle();
    check("a plain card click is the same deal", started.length, 4);
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
