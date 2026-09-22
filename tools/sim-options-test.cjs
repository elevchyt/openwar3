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
const {
  applyVideoOptions, videoSettings, animStride, maxOmniLights, renderSize, renderScale,
  lowPerfMode, LOW_PERF_FORCED,
} = require(join(REPO, ".sim-build", "src", "render", "videoQuality.js"));
const {
  applyHealthBarOptions, healthBarsAlways, healthBarStyle,
} = require(join(REPO, ".sim-build", "src", "render", "worldOverlays.js"));
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

console.log("\na store from before issue #141 does not turn the health bars off");
{
  store.clear();
  // What every pre-#141 OK button wrote: the checkbox's own default, which nothing read, and
  // no `healthBarStyle` beside it because that row did not exist yet.
  store.set("openwar3.options", JSON.stringify({ healthBars: false, musicVolume: 20 }));
  check("the unchosen value is dropped", loadOptions().healthBars, true);
  check("…and the rest of the store is kept", loadOptions().musicVolume, 20);

  // Once the player has committed the new row, an off IS a choice and is honoured.
  store.set("openwar3.options", JSON.stringify({ healthBars: false, healthBarStyle: "team" }));
  check("a deliberate off survives", loadOptions().healthBars, false);
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

console.log("\nthe video applier turns the panel's words into the renderer's numbers");
{
  // The bridge the vendored viewer reads (patches/mdx-m3-viewer@5.12.0.patch). It is a global
  // precisely because those two call sites cannot import us, so the test asserts on the global.
  const bridge = () => globalThis.__OW3_VIDEO__;

  applyVideoOptions(defaultOptions());
  check("defaults are the top rung", [videoSettings().particles, videoSettings().textureQuality], ["high", "high"]);
  // High is what OpenWar3 has always drawn: the emitter object's own SETTING_PARTICLES_HIGH = 2,
  // unscaled. Medium is therefore the rate the MDX author actually wrote.
  check("high leaves the viewer's rate alone", bridge().particleScale, 1);
  check("high uploads the full mip chain", bridge().textureMipDrop, 0);

  applyVideoOptions({ ...defaultOptions(), particles: "medium", textureQuality: "medium" });
  check("medium halves emission", bridge().particleScale, 0.5);
  check("medium drops one mip", bridge().textureMipDrop, 1);

  applyVideoOptions({ ...defaultOptions(), particles: "low", textureQuality: "low" });
  check("low quarters emission", bridge().particleScale, 0.25);
  check("low drops two mips", bridge().textureMipDrop, 2);

  // "Unit Shadows" is a switch, and the ONLY value that turns it off is the FDF's own "off".
  check("shadows default on", videoSettings().unitShadows, true);
  applyVideoOptions({ ...defaultOptions(), shadows: "off" });
  check("shadows off", videoSettings().unitShadows, false);

  applyVideoOptions({ ...defaultOptions(), animQuality: "low", lights: "low" });
  check("low anim scans a quarter as often", animStride(), 4);
  check("low lights uploads no points", maxOmniLights(), 0);

  // A store written by an older build, or edited by hand, must not put a junk string into a
  // renderer ladder — every rung is looked up by key and an unknown one is not a rung.
  applyVideoOptions({ ...defaultOptions(), particles: "ultra", animQuality: 7 });
  check("an unknown rung falls back to the default", [bridge().particleScale, animStride()], [1, 1]);
}

console.log("\nResolution picks the size of the buffer the world is drawn into");
{
  // The default has to be what the game rendered at before the option existed, or a player who
  // never opens this screen would have their picture change under them.
  applyVideoOptions(defaultOptions());
  check("the default is the game frame", renderSize(), { width: 1920, height: 1080 });
  check("…and its factor is 1 for the canvases sized by their own box", renderScale(), 1);

  applyVideoOptions({ ...defaultOptions(), resolution: "1280x720" });
  check("a chosen rung is the buffer size", renderSize(), { width: 1280, height: 720 });
  check("…and the same rung as a factor", +renderScale().toFixed(4), +(720 / 1080).toFixed(4));

  // On a NARROWER stage the rung keeps its height and takes the stage's width (issue #151): the
  // stage follows the window between 4:3 and 16:9, and a buffer of any other shape is drawn
  // stretched into it. Past either end the stage stops, and so does the buffer.
  applyVideoOptions(defaultOptions());
  const windowAt = (innerWidth, innerHeight) => { globalThis.window = { innerWidth, innerHeight }; };
  windowAt(1024, 768);
  check("a 4:3 window draws the rung's height at 4:3", renderSize(), { width: 1440, height: 1080 });
  windowAt(1440, 900);
  check("…a 16:10 one at 16:10", renderSize(), { width: 1728, height: 1080 });
  windowAt(1280, 1024);
  check("…a 5:4 one is held at 4:3", renderSize(), { width: 1440, height: 1080 });
  windowAt(2560, 1080);
  check("…and an ultrawide one at 16:9", renderSize(), { width: 1920, height: 1080 });
  delete globalThis.window;

  // EVERY rung is NAMED at 16:9 — the widest stage, where the rung is exactly the buffer — so
  // the label says what is drawn on a 16:9 screen and the height on every other one.
  const res = OPTION_DEFS.find((d) => d.key === "resolution");
  const offRatio = (res.choices ?? []).filter((c) => {
    const [w, h] = c.value.split("x").map(Number);
    return w * 9 !== h * 16;
  });
  check("every rung offered is exactly 16:9", offRatio.map((c) => c.value), []);

  // A store from before this option, or one somebody edited, must not size a canvas to NaN.
  applyVideoOptions({ ...defaultOptions(), resolution: "native" });
  check("a junk resolution falls back to the game frame", renderSize(), { width: 1920, height: 1080 });
  const stale = { ...defaultOptions() };
  delete stale.resolution;
  applyVideoOptions(stale);
  check("…and so does a store that predates it", renderSize(), { width: 1920, height: 1080 });
}

console.log("\nLow Performance Mode forces every rung but the pixels and the brightness (issue #161)");
{
  const bridge = () => globalThis.__OW3_VIDEO__;

  // Off by default — nobody's current picture changes.
  applyVideoOptions(defaultOptions());
  check("off by default", [defaultOptions().lowPerf, lowPerfMode()], [false, false]);

  // …and ON it is every rung at its cheapest, whatever the seven stored values say. The store
  // here is the OPPOSITE of what the mode wants, so anything that reached the renderer unforced
  // would show up.
  const maxed = {
    ...defaultOptions(),
    lowPerf: true,
    modelDetail: "high", animQuality: "high", textureQuality: "high",
    particles: "high", lights: "high", shadows: "on", occlusion: "on",
  };
  applyVideoOptions(maxed);
  const v = videoSettings();
  check("the mode is carried, not just its rungs", lowPerfMode(), true);
  check("every quality rung is low", [v.modelDetail, v.animQuality, v.textureQuality, v.particles, v.lights],
    ["low", "low", "low", "low", "low"]);
  check("unit shadows off", v.unitShadows, false);
  check("occlusion off", v.occlusion, false);
  check("the viewer sees the low rungs too", [bridge().particleScale, bridge().textureMipDrop], [0.25, 2]);
  check("…and so do the two ladders", [animStride(), maxOmniLights()], [4, 0]);

  // The two rows NOT in the table. Resolution is the one rung that changes how many pixels are
  // drawn and is the player's to trade; gamma is the brightness of the picture, not a cheaper
  // drawing of it (render/videoQuality.ts LOW_PERF_FORCED says so at length).
  applyVideoOptions({ ...maxed, resolution: "2560x1440", gamma: 80 });
  check("resolution is untouched by the mode", renderSize(), { width: 2560, height: 1440 });
  check("…and so is gamma", videoSettings().gamma, 80);
  check("neither is in the forced table", [LOW_PERF_FORCED.resolution, LOW_PERF_FORCED.gamma], [undefined, undefined]);

  // THE POINT OF FORCING AT APPLY TIME: the store is never rewritten, so unticking the box gives
  // the player back the seven values they chose. A mode that wrote its rungs into the options
  // would have eaten them.
  check("the options handed in are not mutated", [maxed.particles, maxed.shadows], ["high", "on"]);
  applyVideoOptions({ ...maxed, lowPerf: false });
  const back = videoSettings();
  check("unticking restores every stored rung", [back.particles, back.lights, back.unitShadows, back.occlusion],
    ["high", "high", true, true]);
  check("…and the mode is off again", lowPerfMode(), false);

  // Every key the table names has to BE a video row, or the Options screens would grey a row that
  // does not exist and the applier would force a setting nothing reads.
  const videoKeys = OPTION_DEFS.filter((d) => d.panel === "video").map((d) => d.key);
  check("every forced key is a video row", Object.keys(LOW_PERF_FORCED).filter((k) => !videoKeys.includes(k)), []);
  // …and each forced value has to be one that row OFFERS, or the greyed pulldown would show a
  // rung it has no entry for and the applier's own fallback would quietly ignore it.
  const notOffered = Object.entries(LOW_PERF_FORCED).filter(([k, val]) => {
    const def = OPTION_DEFS.find((d) => d.key === k);
    return !(def?.choices ?? []).some((c) => c.value === val);
  });
  check("every forced value is one the row offers", notOffered.map(([k]) => k), []);
}

console.log("\nthe Gameplay panel's two health-bar rows (issue #141)");
{
  // Both are ON-by-default questions, and the checkbox's default is the one a player who never
  // opens this screen lives with: WC3 ships it off, OpenWar3 ships it ON.
  applyHealthBarOptions(defaultOptions());
  check("bars are shown by default", healthBarsAlways(), true);
  check("…in the game's own colouring", healthBarStyle(), "default");

  applyHealthBarOptions({ ...defaultOptions(), healthBars: false, healthBarStyle: "team" });
  check("the checkbox reaches the overlays", healthBarsAlways(), false);
  check("so does the pulldown", healthBarStyle(), "team");

  // A store written before either option existed, or edited by hand: the bars must not vanish
  // and the style must not become a junk string the stylesheet has no rule for.
  const stale = { ...defaultOptions() };
  delete stale.healthBars;
  delete stale.healthBarStyle;
  applyHealthBarOptions(stale);
  check("a store that predates them keeps the bars", healthBarsAlways(), true);
  check("…and the game's colouring", healthBarStyle(), "default");
  applyHealthBarOptions({ ...defaultOptions(), healthBarStyle: "rainbow" });
  check("an unknown style is the default one", healthBarStyle(), "default");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
