// Headless check of the game options model (issue #81): the persistence round-trip and the
// audio applier. The Options SCREEN is verified in the real browser (it's FDF chrome and a
// screenshot), but the logic behind it — what gets written to localStorage, and how the sound
// sliders/checkboxes turn into VolumeGroupSetVolume / SetMusicVolume calls — is exactly the kind
// of thing a screenshot can't see, so it's pinned here against a stub localStorage and a fake
// SoundBoard that records the calls.
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

// A minimal localStorage so loadOptions/saveOptions have something to talk to in Node.
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// options.js imports sounds.js, which reaches for `window` at module top only inside methods —
// but be safe and give it one.
global.window = global.window || {};

const {
  OPTION_DEFS, defaultOptions, loadOptions, saveOptions, applyAudioOptions,
} = require(join(REPO, ".sim-build", "src", "data", "options.js"));
const { SOUND_GROUP } = require(join(REPO, ".sim-build", "src", "audio", "sounds.js"));

console.log("defaults cover every option in the table");
{
  const d = defaultOptions();
  check("one default per def", Object.keys(d).length, OPTION_DEFS.length);
  check("a known default is right", d.musicVolume, 70);
  check("a bool default is a bool", typeof d.soundEnabled, "boolean");
}

console.log("\nload with nothing stored yields the defaults");
{
  store.clear();
  check("music volume is the default", loadOptions().musicVolume, 70);
}

console.log("\nsave then load round-trips a changed value");
{
  store.clear();
  const o = defaultOptions();
  o.musicVolume = 20;
  o.soundEnabled = false;
  o.modelDetail = "low";
  saveOptions(o);
  const back = loadOptions();
  check("range persisted", back.musicVolume, 20);
  check("bool persisted", back.soundEnabled, false);
  check("choice persisted", back.modelDetail, "low");
  check("an untouched value keeps its default", back.soundVolume, 100);
}

console.log("\na stored value of the wrong shape is ignored (defaults stand)");
{
  store.clear();
  // A hand-edited / stale store puts a string where a number belongs, and a stray key.
  store.set("openwar3.options", JSON.stringify({ musicVolume: "loud", bogus: 1, soundVolume: 55 }));
  const back = loadOptions();
  check("bad-typed value rejected", back.musicVolume, 70);
  check("well-typed value accepted", back.soundVolume, 55);
  check("unknown key dropped", back.bogus, undefined);
}

console.log("\nthe audio applier maps the sound options onto the SoundBoard");
{
  const calls = { groups: {}, music: null };
  const fake = {
    setVolumeGroup: (g, s) => { calls.groups[g] = s; },
    setMusicVolume: (v) => { calls.music = v; },
  };
  const o = defaultOptions(); // sound on, sfx 100, music on, music 70, all categories on
  applyAudioOptions(fake, o);
  check("SFX groups at full", [calls.groups[SOUND_GROUP.COMBAT], calls.groups[SOUND_GROUP.SPELLS], calls.groups[SOUND_GROUP.UI]], [1, 1, 1]);
  check("music at 70% → 0..127", calls.music, Math.round(0.7 * 127));

  // Half SFX volume scales the effect groups but not the music.
  applyAudioOptions(fake, { ...o, soundVolume: 50 });
  check("effect groups halved", calls.groups[SOUND_GROUP.COMBAT], 0.5);
  check("music untouched by the SFX slider", calls.music, Math.round(0.7 * 127));

  // A per-category checkbox multiplies its own group only.
  applyAudioOptions(fake, { ...o, unitSounds: false, ambientSounds: false });
  check("unit sounds off zeroes UNITSOUNDS", calls.groups[SOUND_GROUP.UNITSOUNDS], 0);
  check("ambient off zeroes AMBIENT", calls.groups[SOUND_GROUP.AMBIENT], 0);
  check("combat unaffected by those", calls.groups[SOUND_GROUP.COMBAT], 1);

  // The master Sound switch zeroes every effect group; Music has its own switch.
  applyAudioOptions(fake, { ...o, soundEnabled: false });
  check("sound off zeroes UI too", calls.groups[SOUND_GROUP.UI], 0);
  check("…but music still plays", calls.music, Math.round(0.7 * 127));
  applyAudioOptions(fake, { ...o, musicEnabled: false });
  check("music off zeroes the track", calls.music, 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
