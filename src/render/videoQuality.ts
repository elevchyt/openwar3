import type { Options } from "../data/options";
import { stageAspect } from "../ui/stage";

// The Video panel, wired to the engine (issue #81 follow-up).
//
// `src/data/options.ts` is the MODEL — the table of settings and their persistence. This is the
// APPLIER for the video half: it turns the stored strings into the handful of numbers the
// renderer and the vendored mdx-m3-viewer actually read, and it is the one place that says what
// each setting means here. The sound half's equivalent is `applyAudioOptions`.
//
// WHERE THE SETTINGS COME FROM. The screen is the game's own `UI\FrameDef\Glue\OptionsMenu.fdf`,
// so the list and the labels are not ours to choose: the FDF names each dropdown's MenuItems
// (`LOW_MODELS`/`MEDIUM_MODELS`/`HIGH_MODELS`, `LOW_ANIM`…, `LOW_TEXTURES`…, `LOW_PARTICLES`…,
// `LOW_LIGHTS`…, and plain `OFF`/`ON` for the two switches), and GlobalStrings.fdf gives each of
// those the same three words. Two rows of that panel are worth knowing about:
//
//   • `COLON_SHADOWS` is **"Unit Shadows:"**, not "Shadows:". It governs the shadows that belong
//     to MODELS — units and buildings — and not the baked `war3map.shd` layer, which is part of
//     how the ground looks and stays on at every setting (docs/lighting.md).
//   • The Spell Detail row is **commented out** in the shipped 1.30.4 FDF (OptionsMenu.fdf, the
//     `SpellFilterMenu` block), so the game has no such control and neither do we.
//
// WHAT IS THE GAME'S AND WHAT IS OURS. Nothing in the install describes what a quality rung DOES
// — these were engine settings, not data — with exactly one exception, noted at PARTICLE_SCALE.
// Every other number here is OURS, chosen for this renderer, and says so.

export type Quality = "low" | "medium" | "high";

/** Everything the Video panel decides, parsed out of the stored option values. */
export interface VideoSettings {
  /** The rung the world is drawn at, as its 16:9 size in device pixels. The HEIGHT is what is
   *  drawn; the width follows the stage's aspect (`renderSize`), so it is this only at 16:9. */
  renderWidth: number;
  renderHeight: number;
  modelDetail: Quality;
  animQuality: Quality;
  textureQuality: Quality;
  particles: Quality;
  lights: Quality;
  /** "Unit Shadows" — the model shadow decals (units AND buildings). */
  unitShadows: boolean;
  occlusion: boolean;
  /** 0–100, 50 = unchanged. */
  gamma: number;
  /** "Low Performance Mode" — every rung above is already the one this mode forces (see
   *  `LOW_PERF_FORCED`). Carried so the renderer can ask the MODE rather than infer it from a
   *  rung a player might equally have chosen by hand. */
  lowPerf: boolean;
}

/**
 * The two numbers the VENDORED VIEWER has to see, published on a global.
 *
 * mdx-m3-viewer is JavaScript we do not own and cannot import our modules into, and both of
 * these are read from deep inside it — one from the BLP texture handler as a texture is
 * uploaded, one from the particle emitter's per-frame emission step. A global is the whole of
 * the coupling, it is read defensively at both ends, and the two hunks that read it are in
 * `patches/mdx-m3-viewer@5.12.0.patch` under the same name as this interface.
 */
export interface VideoBridge {
  /** Emission-rate multiplier for MDX particle emitters. 1 = the viewer's stock rate. */
  particleScale: number;
  /** Mipmap levels to drop from the top of a BLP's chain as it is uploaded. 0 = full size. */
  textureMipDrop: number;
  /**
   * Low Performance Mode's animation path: may an MDX instance take a pose another instance of
   * the same model already sampled, at the same clip and the same 1/30 s of it?
   *
   * This is the largest thing the mode does, and the only one that is not a rung of the panel —
   * see `LOW_PERF_FORCED` for why it is here rather than there. Profiled at 257 units and 6x CPU
   * throttle, the MDX node walk is ~41% of all CPU against ~7% for the drawing, and 317 visible
   * instances were holding 60 distinct poses. The cache and the reasoning live at the top of
   * `viewer/handlers/mdx/modelinstance.js` in the patch; what it costs is animation time
   * quantized to 30 Hz, which is why it is off at full quality.
   */
  sharedPoses: boolean;
  /**
   * How coarse a shared pose bucket is, in ms of ANIMATION time. Default 1000/30, which is about
   * the rate an MDX's tracks are authored at and so the rate at which stepping stops being
   * visible. A knob rather than a constant because it is the one dial on the animation path with
   * two effects at once — fewer buckets means fewer poses SAMPLED and more instances sharing each
   * one — and its cost is purely how the clips read, which is a judgement to be measured and
   * looked at rather than argued (docs/perf-research.md).
   */
  poseBucket: number;
}

const bridge = (): VideoBridge => {
  const g = globalThis as { __OW3_VIDEO__?: VideoBridge };
  return (g.__OW3_VIDEO__ ??= { particleScale: 1, textureMipDrop: 0, sharedPoses: false, poseBucket: POSE_BUCKET_MS });
};

/**
 * The shared pose bucket, in ms of animation time — Low Performance Mode's one animation dial.
 *
 * OURS, and it is the trade the mode makes: clips step at this rate rather than per frame. 1000/30
 * is where it sits because MDX tracks are authored at about that, so the stepping is hard to see;
 * a coarser bucket samples fewer poses AND puts more instances in each one, so it pays twice.
 * Measured interleaved at 287 units and 6× throttle, 15 Hz was worth ~4% of the frame — see
 * docs/perf-research.md for why that was not enough to spend the smoothness on.
 */
const POSE_BUCKET_MS = 1000 / 30;

/** What OpenWar3 has always rendered at, and what `ui/stage.ts` calls the game frame. */
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

const DEFAULTS: VideoSettings = {
  renderWidth: DEFAULT_WIDTH,
  renderHeight: DEFAULT_HEIGHT,
  modelDetail: "high",
  animQuality: "high",
  textureQuality: "high",
  particles: "high",
  lights: "high",
  unitShadows: true,
  occlusion: true,
  gamma: 50,
  lowPerf: false,
};

let current: VideoSettings = { ...DEFAULTS };

/** The settings in force. Read this per frame — it is a plain object, not a lookup. */
export function videoSettings(): VideoSettings {
  return current;
}

// ---------------------------------------------------------------------------
// The ladders. One per setting that costs something, each with its reasoning.
// ---------------------------------------------------------------------------

/**
 * Mip levels dropped from the top of every BLP as it is uploaded — so "Low" is a quarter-width
 * texture and a SIXTEENTH of the memory. OURS: the rungs are a mip apiece because that is the
 * only free downscale a mipmapped BLP offers (the levels are already in the file; dropping one
 * costs nothing but the upload we skip). Textures with a single level, or non-power-of-two ones,
 * have no chain to climb and are uploaded whole at every setting.
 *
 * Applies as a texture is LOADED, so a change reaches the next map rather than the one on screen.
 */
const MIP_DROP: Record<Quality, number> = { high: 0, medium: 1, low: 2 };

/**
 * Particle emission multiplier, on top of the rate the MDX author wrote.
 *
 * THIS ONE IS THE GAME'S, at the top rung. mdx-m3-viewer's `geometryemitterfuncs.js` records the
 * observation in its own source — *"The game scales the emission rate of particle emitters
 * depending on the particles setting. High seems to double the emission"* — and ships
 * `SETTING_PARTICLES_HIGH = 2`, which every emitter object multiplies its authored rate by. So
 * the authored rate IS Warcraft III's Medium, and High is twice it. We keep that hard-wired 2
 * and scale it here, which makes `high` = 2× authored (what OpenWar3 has always drawn) and
 * `medium` = 1× authored (the game's own middle rung). `low` at a quarter is OURS: the game has
 * a third rung and nothing we have says what it is worth.
 */
const PARTICLE_SCALE: Record<Quality, number> = { high: 1, medium: 0.5, low: 0.25 };

/**
 * How many frames apart the map's widgets are asked whether their stand animation has run out
 * (`Widget.update` — see the anim phase in mapViewer.ts). OURS.
 *
 * This is the honest reach of "Animation Quality" in this engine, and it is smaller than it
 * sounds it should be. The expensive half of animating a model — the skeleton walk and the
 * per-instance bone-texture upload — CANNOT be strided here, because the sim moves a unit by
 * writing its position onto the instance and the bone matrices are what carry that position to
 * the screen: an instance whose animation is skipped is an instance that stops moving. So what
 * is strided is the part that is purely idle bookkeeping — a scan over every doodad and every
 * map-placed unit, thousands of them on a big map, asking a question that is almost always "no".
 * At `low` a finished tree sway waits up to four frames for its next one, which is invisible;
 * decimating the skeletons themselves needs the moved-instance problem solved first.
 */
const ANIM_STRIDE: Record<Quality, number> = { high: 1, medium: 2, low: 4 };

/**
 * Point lights uploaded to the shader. OURS.
 *
 * The reach is narrow and worth stating: the only dynamic lights OpenWar3 has are the `LITE`
 * omni lights the GLUE screens' own backdrop models carry (docs/lighting.md — the menus are lit
 * by the diorama, the world is lit by its tileset's day/night pair). So this dials the main menu
 * and the screens behind it, where a weak machine is also asked to draw a 3D scene, and does
 * nothing to a match. `high` is the shader's own ceiling; `low` keeps the ambient term, which is
 * the screen's, and drops the points.
 */
const MAX_LIGHTS: Record<Quality, number> = { high: 8, medium: 4, low: 0 };

/**
 * What "Low Performance Mode" means (issue #161) — the Video panel's own rows, at the cheapest
 * rung each one has.
 *
 * It is ONE SWITCH over the settings this panel already has, not a second renderer: a machine
 * that needs it should not have to find seven dropdowns and know which way is cheaper. The
 * renderer work issue #161 also asks for — particles off rather than quartered, the fog and
 * shadow layers taking terrain-cull's runs, skinning off the main thread, single-pass terrain —
 * is behind this flag when it lands, which is why `VideoSettings.lowPerf` is carried separately
 * from the rungs it forces.
 *
 * TWO ROWS ARE DELIBERATELY NOT HERE.
 *
 *   · **Resolution.** It is the one rung that changes how many PIXELS are drawn and so the one a
 *     weak GPU cares most about (see `renderSize`) — which is exactly why it stays the player's:
 *     how sharp the world is against how smooth it runs is the trade only they can make. Issue
 *     #161 asks for it in as many words ("keep the one chosen by the player").
 *   · **Gamma.** A non-default gamma is a full-screen filter pass per frame, so there is a case
 *     for forcing it to 50 — but it is the BRIGHTNESS of the picture, not a cheaper drawing of
 *     the same one, and a player on a dim panel needs it wherever they set it. Left live.
 *
 * FORCED AT APPLY TIME, NEVER WRITTEN TO THE STORE. `applyVideoOptions` lays this over the
 * options it is handed; the player's own seven values sit untouched underneath, so unticking the
 * box gives every one of them back. The two Options screens grey these rows while the mode is on
 * and show the forced rung in them, so what the panel says and what the renderer does agree.
 */
export const LOW_PERF_FORCED: Readonly<Record<string, string>> = {
  modelDetail: "low",
  animQuality: "low",
  textureQuality: "low",
  particles: "low",
  lights: "low",
  shadows: "off",
  occlusion: "off",
};

/** True while the mode is on — used by both Options screens to grey the rows it forces. */
export function lowPerfMode(): boolean {
  return current.lowPerf;
}

const quality = (v: unknown, fallback: Quality): Quality =>
  v === "low" || v === "medium" || v === "high" ? v : fallback;

/** "1280x720" → [1280, 720]. Anything else — an older store, a hand-edited one — is the
 *  default, which is the size the game rendered at before this option existed. */
function resolution(v: unknown): [number, number] {
  const m = typeof v === "string" ? /^(\d{3,5})x(\d{3,5})$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2])] : [DEFAULT_WIDTH, DEFAULT_HEIGHT];
}

/**
 * The size the world's canvas should be, in device pixels — Options → Video → Resolution.
 *
 * THIS IS THE ONE VIDEO SETTING A WEAK GPU CARES MOST ABOUT, and the reason is that it is the
 * only one that changes how many PIXELS are drawn. Every other rung on the panel takes work off
 * the CPU or off the vertex path; this one divides the fill rate, the overdraw of every
 * translucent pass over the world, and the fog veil and weather that cover the screen. 1280×720
 * is 2.25× fewer pixels than 1080p and 800×450 is 5.8× fewer.
 *
 * It costs no framing at all, which is why it can be a plain number rather than a compromise:
 * the buffer is scaled into the stage by CSS, so the camera sees exactly the same world however
 * small this is (ui/stage.ts). The HUD is DOM and is not in this buffer, so it stays sharp at
 * every rung.
 *
 * A rung is named by its 16:9 size, and what it really fixes is the HEIGHT: the stage takes the
 * window's aspect between 4:3 and 16:9 (issue #151), and the buffer has to take the same one or
 * the world is drawn stretched — so "1920 x 1080" on a 4:3 screen draws 1440 × 1080. The lens is
 * vertical, so the height is the dimension that decides how sharp the world is.
 *
 * AND IT REACHES THE WORLD ONLY. There was a prototype here that pushed the same factor onto
 * the DOM interface — laying `#ui` out at `f` of its box and scaling it back up by `1/f`, so
 * the console coarsened with the terrain the way it did in 2003, when the whole frame went
 * through one back buffer. It is gone: the HUD already sizes itself off the viewport (every
 * length in it is `calc(var(--stage-h) * k)` — ui/hud.ts `uiPx`), so it holds its shape on a
 * small screen without being told to, and a second scale on top of that was one authority too
 * many over the same lengths. A rung here changes how many pixels the WORLD is drawn into,
 * and nothing else.
 */
export function renderSize(): { width: number; height: number } {
  const height = current.renderHeight;
  return { width: Math.round(height * stageAspect()), height };
}

/**
 * The same setting as a FACTOR, for the canvases that are sized by their own CSS box rather
 * than to the game frame — the glue screens' 3D scene, which fills the window at whatever shape
 * the window is. 1080p is 1, so the default changes nothing there either.
 */
export function renderScale(): number {
  return current.renderHeight / DEFAULT_HEIGHT;
}

/** Frames between stand-sequence scans of the map's widgets — see ANIM_STRIDE. */
export function animStride(): number {
  return ANIM_STRIDE[current.animQuality];
}

/** The cap the glue scene fills its omni-light slots up to — see MAX_LIGHTS. */
export function maxOmniLights(): number {
  return MAX_LIGHTS[current.lights];
}

/**
 * Push the Video-panel options onto the renderer. Called at boot with the committed options,
 * and again by the Options screen on every change so the panel previews itself.
 *
 * Three of the five reach their destination through this call; `textureQuality` is read by the
 * loader as textures arrive, and `particles` by the emitters as they emit.
 */
export function applyVideoOptions(options: Options): void {
  // Low Performance Mode lays its rungs OVER the stored ones (LOW_PERF_FORCED) — the store keeps
  // the player's own choices, so unticking the box restores them without anything having to be
  // remembered. Resolution and gamma are read from `options` either way: they are not in the table.
  const lowPerf = options.lowPerf === true;
  const opts = lowPerf ? { ...options, ...LOW_PERF_FORCED } : options;
  const [renderWidth, renderHeight] = resolution(opts.resolution);
  current = {
    renderWidth,
    renderHeight,
    modelDetail: quality(opts.modelDetail, DEFAULTS.modelDetail),
    animQuality: quality(opts.animQuality, DEFAULTS.animQuality),
    textureQuality: quality(opts.textureQuality, DEFAULTS.textureQuality),
    particles: quality(opts.particles, DEFAULTS.particles),
    lights: quality(opts.lights, DEFAULTS.lights),
    unitShadows: opts.shadows !== "off",
    occlusion: opts.occlusion !== "off",
    gamma: typeof opts.gamma === "number" ? opts.gamma : DEFAULTS.gamma,
    lowPerf,
  };
  const b = bridge();
  b.particleScale = PARTICLE_SCALE[current.particles];
  b.textureMipDrop = MIP_DROP[current.textureQuality];
  // The mode's own switch rather than a rung's: the pose cache is what Low Performance Mode is
  // actually FOR (see `VideoBridge.sharedPoses`), and it is live — a tick takes effect on the
  // next frame, and unticking has every instance sampling for itself again.
  b.sharedPoses = current.lowPerf;
  b.poseBucket = POSE_BUCKET_MS;
  applyGamma(current.gamma);
}

// ---------------------------------------------------------------------------
// Gamma
// ---------------------------------------------------------------------------

/** The `<filter>` the world canvas points at, and the `<svg>` that has to hold it. */
const GAMMA_FILTER = "ow3-gamma";
const GAMMA_HOST = "ow3-gamma-host";

/**
 * The gamma slider, as far as a browser can honour it.
 *
 * Warcraft III's gamma is a HARDWARE ramp: the setting reprograms the display's transfer curve,
 * so it lifts everything on the screen at once and costs nothing to keep. A page has no such
 * knob. What it has is an SVG `feComponentTransfer` with `type="gamma"`, which is the same curve
 * exactly — `out = in^exponent` per channel — applied as a compositing pass over one element.
 *
 * So this is a DEVIATION and worth naming: the curve is the real one, the reach is not. It is
 * hung on the world canvas (`#map`, via a custom property so the canvas `freshMapCanvas`
 * swaps in inherits it) and not on the whole page, for two reasons. A `filter` on an ancestor
 * of the HUD would make that element the containing block for every fixed thing under it, which
 * is the trap `#ui`'s own transform already documents in ui/stage.ts; and the glue screens carry
 * an authored colour grade of their own on `#menubg` (menuScene.ts), which this would fight.
 * Brightening the world is what the slider is for — seeing into a dark corner of the map.
 *
 * The mapping is OURS, and doubles either way from the middle: 50 → 1.0 (untouched), 100 → 0.5
 * (brighter), 0 → 2.0 (darker). At exactly 50 nothing is installed at all — a full-screen filter
 * pass every frame is precisely what the machine this panel exists for cannot afford, so the
 * default must cost nothing.
 */
function applyGamma(v: number): void {
  if (typeof document === "undefined") return; // headless (the options test compiles this file)
  const root = document.documentElement;
  if (Math.round(v) === 50) {
    root.style.removeProperty("--ow3-gamma");
    document.getElementById(GAMMA_HOST)?.remove();
    return;
  }
  const exponent = Math.pow(2, (50 - v) / 50);
  gammaFilter().setAttribute("exponent", String(exponent));
  root.style.setProperty("--ow3-gamma", `url(#${GAMMA_FILTER})`);
}

/** The gamma `<filter>`, minted on first use. Its three channel functions share one element
 *  each, so the exponent is written once per channel and the node is reused thereafter. */
let gammaFuncs: SVGElement[] = [];
function gammaFilter(): { setAttribute(name: string, value: string): void } {
  if (!document.getElementById(GAMMA_HOST)) gammaFuncs = [];
  if (gammaFuncs.length) {
    return { setAttribute: (n, val) => gammaFuncs.forEach((f) => f.setAttribute(n, val)) };
  }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.id = GAMMA_HOST;
  // Out of the layout entirely — it exists only to be referenced by url(#…).
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  const filter = document.createElementNS(NS, "filter");
  filter.id = GAMMA_FILTER;
  // A display ramp acts on the values that go to the display. Left at the SVG default
  // (linearRGB) the browser would convert to linear, curve THAT, and convert back — a
  // different curve, and a noticeably wrong one at the ends of the slider.
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const transfer = document.createElementNS(NS, "feComponentTransfer");
  for (const ch of ["feFuncR", "feFuncG", "feFuncB"]) {
    const f = document.createElementNS(NS, ch);
    f.setAttribute("type", "gamma");
    f.setAttribute("amplitude", "1");
    f.setAttribute("offset", "0");
    transfer.appendChild(f);
    gammaFuncs.push(f);
  }
  filter.appendChild(transfer);
  svg.appendChild(filter);
  document.body.appendChild(svg);
  return { setAttribute: (n, val) => gammaFuncs.forEach((f) => f.setAttribute(n, val)) };
}
