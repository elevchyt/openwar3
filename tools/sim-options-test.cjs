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
  OPTION_DEFS, defaultOptions, loadOptions, saveOptions, applyAudioOptions, sliderGain,
  LOWEST_VIDEO, LOW_RESOLUTION, withLowestVideo,
} = require(join(REPO, ".sim-build", "src", "data", "options.js"));
const {
  applyVideoOptions, videoSettings, animStride, maxOmniLights, renderSize, renderScale, antialiasing,
} = require(join(REPO, ".sim-build", "src", "render", "videoQuality.js"));
const {
  applyHealthBarOptions, healthBarsAlways, healthBarStyle,
} = require(join(REPO, ".sim-build", "src", "render", "worldOverlays.js"));
const { SOUND_GROUP } = require(join(REPO, ".sim-build", "src", "audio", "sounds.js"));

console.log("defaults cover every option in the table");
{
  const d = defaultOptions();
  check("one default per def", Object.keys(d).length, OPTION_DEFS.length);
  check("a known default is right", d.musicVolume, 50);
  check("a bool default is a bool", typeof d.soundEnabled, "boolean");
}

console.log("\nload with nothing stored yields the defaults");
{
  store.clear();
  check("music volume is the default", loadOptions().musicVolume, 50);
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
  check("an untouched value keeps its default", back.soundVolume, 50);
}

console.log("\na stored value of the wrong shape is ignored (defaults stand)");
{
  store.clear();
  // A hand-edited / stale store puts a string where a number belongs, and a stray key.
  store.set("openwar3.options", JSON.stringify({ musicVolume: "loud", bogus: 1, soundVolume: 55 }));
  const back = loadOptions();
  check("bad-typed value rejected", back.musicVolume, 50);
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
  const calls = { groups: {}, music: null, script: null };
  const fake = {
    setUserVolumes: (g, m, s) => { calls.groups = g; calls.music = m; calls.script = s; },
  };
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const o = defaultOptions(); // sound on, sfx 50, music on, music 50, all categories on
  applyAudioOptions(fake, o);
  const half = sliderGain(50);
  check("the 50% default is −18 dB, not half amplitude", near(half, Math.pow(10, -18 / 20)), true);
  check("SFX groups at the default", [calls.groups[SOUND_GROUP.COMBAT], calls.groups[SOUND_GROUP.SPELLS], calls.groups[SOUND_GROUP.UI]], [half, half, half]);
  check("script sounds (campaign dialogue) follow the SFX slider", calls.script, half);
  check("music at its default", calls.music, half);

  // The taper: full is full, 0 is silence, and every notch is the same number of dB.
  check("100% is unity", sliderGain(100), 1);
  check("0% is silence", sliderGain(0), 0);
  check("equal steps are equal ratios", near(sliderGain(75) / sliderGain(50), sliderGain(50) / sliderGain(25)), true);
  check("1% still makes a sound", sliderGain(1) > 0, true);
  let rising = true;
  for (let p = 1; p <= 100; p++) if (!(sliderGain(p) > sliderGain(p - 1))) rising = false;
  check("strictly rising", rising, true);

  // The SFX slider scales the effects and the script sounds but not the music.
  applyAudioOptions(fake, { ...o, soundVolume: 100 });
  check("effect groups at full", calls.groups[SOUND_GROUP.COMBAT], 1);
  check("script sounds at full", calls.script, 1);
  check("music untouched by the SFX slider", calls.music, half);

  // A per-category checkbox multiplies its own group only.
  applyAudioOptions(fake, { ...o, unitSounds: false, ambientSounds: false });
  check("unit sounds off zeroes UNITSOUNDS", calls.groups[SOUND_GROUP.UNITSOUNDS], 0);
  check("ambient off zeroes AMBIENT", calls.groups[SOUND_GROUP.AMBIENT], 0);
  check("combat unaffected by those", calls.groups[SOUND_GROUP.COMBAT], half);
  check("dialogue unaffected by Unit Sounds", calls.script, half);

  // The master Sound switch zeroes every effect group and the dialogue; Music has its own switch.
  applyAudioOptions(fake, { ...o, soundEnabled: false });
  check("sound off zeroes UI too", calls.groups[SOUND_GROUP.UI], 0);
  check("sound off zeroes dialogue", calls.script, 0);
  check("…but music still plays", calls.music, half);
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
  // Every rung takes the shared-skeleton path (`sharedPoses`); what a rung picks is how often a
  // pose is sampled (`poseBucket`): 1/30 s on Low, 1/60 on Medium, and finer than any display
  // draws on High (1/240 s), so High reads as exact.
  check("low anim samples at 30 Hz", [bridge().sharedPoses, bridge().poseBucket], [true, 1000 / 30]);
  applyVideoOptions({ ...defaultOptions(), animQuality: "medium" });
  check("medium anim samples at 60 Hz", [bridge().sharedPoses, bridge().poseBucket], [true, 1000 / 60]);
  applyVideoOptions(defaultOptions());
  check("high, the default, samples at 240 Hz", [bridge().sharedPoses, bridge().poseBucket], [true, 1000 / 240]);

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

  // On any stage but 16:9 the rung keeps its height and takes the stage's width (issue #151): the
  // stage follows the window from 4:3 up — past 16:9 too (PR #326, an ultrawide screen is filled)
  // — and a buffer of any other shape is drawn stretched into it. Below 4:3 the stage stops.
  applyVideoOptions(defaultOptions());
  // At devicePixelRatio 2, so the stage is taller than the rung and the ceiling below stays out
  // of it: these four are about the SHAPE of the buffer, not its height.
  const windowAt = (innerWidth, innerHeight, devicePixelRatio = 2) => {
    globalThis.window = { innerWidth, innerHeight, devicePixelRatio };
  };
  windowAt(1024, 768);
  check("a 4:3 window draws the rung's height at 4:3", renderSize(), { width: 1440, height: 1080 });
  windowAt(1440, 900);
  check("…a 16:10 one at 16:10", renderSize(), { width: 1728, height: 1080 });
  windowAt(1280, 1024);
  check("…a 5:4 one is held at 4:3", renderSize(), { width: 1440, height: 1080 });
  windowAt(2560, 1080);
  check("…and an ultrawide one at its own 21:9", renderSize(), { width: 2560, height: 1080 });

  // The rung is a CEILING: never more lines than the screen shows. A 1366x768 laptop drew the
  // default 1080 lines and threw half of them away in the downscale. (1366x768 is a hair wider
  // than 16:9, and the stage fills it, so the width is the window's own.)
  windowAt(1366, 768, 1);
  check("a 768-line screen draws 768 lines at the default rung", renderSize(), { width: 1366, height: 768 });
  applyVideoOptions({ ...defaultOptions(), resolution: "1280x720" });
  check("…and a rung under the screen is drawn as chosen", renderSize(), { width: 1281, height: 720 });
  applyVideoOptions(defaultOptions());
  windowAt(1280, 720, 1.5);
  check("…a 150% scaled laptop counts DEVICE pixels", renderSize(), { width: 1920, height: 1080 });
  delete globalThis.window;

  // EVERY rung is NAMED at 16:9 — the stage where the rung is exactly the buffer — so
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

console.log("\nthe lowest-settings preset: the weak-GPU prompt, ?lowperf, and an old Low Performance store");
{
  const bridge = () => globalThis.__OW3_VIDEO__;

  // Antialiasing is the player's box and ON by default — what WebGL always drew with.
  applyVideoOptions(defaultOptions());
  check("antialiasing is on by default", antialiasing(), true);
  applyVideoOptions({ ...defaultOptions(), antialias: false });
  check("…and the box turns it off", antialiasing(), false);

  // The preset is every costly row at its cheapest, as ordinary values the rows then show.
  const lowest = withLowestVideo(defaultOptions());
  applyVideoOptions(lowest);
  const v = videoSettings();
  check("every quality rung is low", [v.modelDetail, v.animQuality, v.textureQuality, v.particles, v.lights],
    ["low", "low", "low", "low", "low"]);
  check("unit shadows and occlusion off", [v.unitShadows, v.occlusion], [false, false]);
  check("antialiasing off", antialiasing(), false);
  check("the viewer sees the low rungs", [bridge().particleScale, bridge().textureMipDrop, bridge().sharedPoses], [0.25, 2, true]);
  check("…and so do the two ladders", [animStride(), maxOmniLights()], [4, 0]);
  check("resolution is LOWERED to 1280x720", lowest.resolution, LOW_RESOLUTION);
  check("…never raised past a smaller pick", withLowestVideo({ ...defaultOptions(), resolution: "800x450" }).resolution, "800x450");
  check("gamma, vsync and 4:3 menus are the player's", [lowest.gamma, lowest.vsync, lowest.menus43], [46, true, false]);
  check("the options handed in are not mutated", defaultOptions().particles, "high");

  // Every key the preset names has to BE a video row, holding a value that row OFFERS — or the
  // panel would show a rung it has no entry for and the applier would quietly fall back.
  const offers = (k, val) => {
    const d = OPTION_DEFS.find((o) => o.key === k);
    if (!d || d.panel !== "video") return false;
    return d.kind === "bool" ? typeof val === "boolean" : (d.choices ?? []).some((c) => c.value === val);
  };
  check("every preset value is one its row offers", Object.entries(LOWEST_VIDEO).filter(([k, val]) => !offers(k, val)).map(([k]) => k), []);
  check("there is no Low Performance row any more", OPTION_DEFS.some((d) => d.key === "lowPerf"), false);

  // The LAUNCH FLAG, at both doors: an empty store and a full one. `?lowperf` reaching only the
  // second is the bug this pins — a fresh profile has no stored options, which is exactly the
  // machine the flag is for.
  const withSearch = (search, fn) => {
    const had = Object.prototype.hasOwnProperty.call(global, "location");
    const prev = global.location;
    global.location = { search };
    try { return fn(); } finally { if (had) global.location = prev; else delete global.location; }
  };
  const pick = (o) => [o.animQuality, o.antialias, o.resolution];
  store.clear();
  check("the flag reaches an EMPTY store", withSearch("?dev&lowperf", () => pick(loadOptions())), ["low", false, LOW_RESOLUTION]);
  saveOptions(defaultOptions());
  check("…and a stored one", withSearch("?lowperf", () => pick(loadOptions())), ["low", false, LOW_RESOLUTION]);
  check("…and without it the store stands", withSearch("?dev", () => pick(loadOptions())), ["high", true, "1920x1080"]);

  // A store from when "Low Performance Mode" was a checkbox: it FORCED the rows at apply time and
  // left the stored ones High, so read plainly it would hand that player back the full picture.
  // It is migrated ONCE into the values it was drawing — resolution untouched, as the mode left it.
  store.clear();
  store.set("openwar3.options", JSON.stringify({ ...defaultOptions(), lowPerf: true, resolution: "1600x900" }));
  const migrated = loadOptions();
  check("an old ticked box becomes the lowest rows", [migrated.particles, migrated.shadows, migrated.animQuality, migrated.antialias],
    ["low", "off", "low", false]);
  check("…keeping the player's resolution", migrated.resolution, "1600x900");
  check("…and the dead key is gone from the store", JSON.parse(store.get("openwar3.options")).lowPerf, undefined);
  check("…so raising a row afterwards sticks", (() => {
    saveOptions({ ...loadOptions(), particles: "high" });
    return loadOptions().particles;
  })(), "high");
  store.clear();
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
