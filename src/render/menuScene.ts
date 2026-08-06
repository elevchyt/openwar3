import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import type { DataSource } from "../vfs/types";
import { makeFog, type DistFog } from "./fog";

// The main-menu background + chrome (issue #54). WC3 composes the menu from three
// layers, all animated MDX glue models read from the user's install:
//   1. the 3D background scene (Icecrown ocean, frost wyrm, chains around the tower)
//   2. the screen-edge metal border + gears (TopLeft/TopRight sprite-layer panels)
//   3. the right-hand button panel with the rattling chains (in the TopRight panel)
// We render (1) in a perspective scene and (2)+(3) in a second orthographic scene
// composited over it (scene.alpha), in one mdx-m3-viewer on one canvas. The FDF menu
// (DOM) then overlays the buttons in the same 4:3 box the sprite panels map to, so
// the button widgets land inside the panel's slots — exactly as the original.

const TFT_MENU = "UI\\Glues\\MainMenu\\MainMenu3D_Exp\\MainMenu3D_Exp.mdx";
const ROC_MENU = "UI\\Glues\\MainMenu\\MainMenu3d\\MainMenu3d.mdx";
// The two screen-edge sprite layers. The right one carries the button frames and the
// hanging chains of every screen; the left one carries the left-hand chrome — the metal
// border and gears on the main menu, and on the skirmish screen the big Game Settings /
// Team Setup frames. Each is rendered into its own edge-anchored viewport.
const RIGHT_TFT = "UI\\Glues\\SpriteLayers\\Expansion\\TopRightPanel-Expansion.mdx";
const RIGHT_ROC = "UI\\Glues\\SpriteLayers\\TopRightPanel.mdx";
const LEFT_TFT = "UI\\Glues\\SpriteLayers\\Expansion\\TopLeftPanel-Expansion.mdx";
const LEFT_ROC = "UI\\Glues\\SpriteLayers\\TopLeftPanel.mdx";

// The sprite-layer panel model is not one panel with one idle clip: it carries the
// chrome of EVERY glue screen, and a screen's chrome is a sequence TRIPLE named after
// it — "<Screen> Birth" / "<Screen> Stand" / "<Screen> Death" (dumped from the real
// TopRightPanel.mdx: MainMenu, RealmSelection, SinglePlayer, SinglePlayerSkirmish,
// MainCancelPanel, Options, Battlenet*...). That is how the original animates between
// menus: the outgoing screen's chrome plays its Death, the incoming one its Birth, and
// then idles on its Stand. We drive exactly those clips, so the panel motion IS the
// game's own — no hand-authored slide (issue #61).
// Verified against the models themselves: all four panel models (left/right, RoC/TFT) carry
// a byte-identical 62-sequence table. There is NO LAN-specific chrome — nothing in it matches
// /lan|local|network/. The LAN screens wear the Battle.net custom-game chrome, and the FDF
// TOC confirms the pairing: LocalMultiplayerJoin/Create/Load.fdf parallel
// BattleNetCustomJoin/Create/LoadPanel.fdf — the same three panels, one set per transport.
// The game LOBBY has its own triple in that table — "MultiplayerPreGameChat" — and it is the
// only one whose name says what it is: the chat-room-shaped screen you sit in BEFORE the game
// (UI\FrameDef\Glue\GameChatroom.fdf, ui/fdfLanLobby.ts). Dumped from the real
// TopRightPanel-Expansion.mdx alongside the rest.
export type GlueChrome =
  | "MainMenu" | "SinglePlayer" | "SinglePlayerSkirmish" | "BattlenetCustom"
  | "MultiplayerPreGameChat" | "Options";

/** How long a screen's chrome takes to leave / arrive, in ms — read from the model's
 *  own sequence intervals, so the DOM panels can be animated over the same window. */
export interface ChromeTiming { death: number; birth: number }

/**
 * Live-tunable framing + fog for ONE campaign backdrop (issue #105), the backdrop-screen
 * counterpart of `MenuScene.tuning`. Kept per backdrop MODEL, because the four campaign
 * scenes are four different sets (Maiev's ruins, Theramore's docks…) and a nudge that
 * frames one says nothing about the next.
 *
 * The defaults are deliberately NEUTRAL — camera multipliers of 1 and no pan, so an
 * untouched entry renders the model's authored camera exactly as `showBackdrop` always
 * has, and the fog seeded straight from that campaign's own `BackgroundFog*` keys. The
 * `?menudebug` sliders move them from there; "Log values" prints them for baking.
 */
export interface BackdropTuning {
  /** Dolly the eye toward the model's camera target (<1 closer). */
  camZoom: number;
  /** Pan eye+target along the camera's screen right / up axes, in world units. */
  camPanX: number;
  camPanY: number;
  /** Multiplier on the aspect-corrected field of view. */
  camFov: number;
  /** Orbit the eye around the model's own camera target, in DEGREES off the authored angle —
   *  the game's own camera vocabulary (docs/camera.md): `rotation` about world Z, `angle of
   *  attack` about the camera's right axis (positive raises the eye), `roll` on the up vector. */
  camYaw: number;
  camPitch: number;
  camRoll: number;
  /** Distance fog, seeded from `BackgroundFogStart` / `End` / `Color`. */
  fogStart: number;
  fogEnd: number;
  fogR: number;
  fogG: number;
  fogB: number;
  /** Colour grade over the finished frame — the reference's campaign screens read much darker
   *  and warmer than our render of the same models, which no fog setting can fix (fog only
   *  tints what is FAR). 1/1/1/0 is untouched. */
  gradeBrightness: number;
  gradeContrast: number;
  gradeSaturation: number;
  gradeHue: number;
  /** Base ambient under the model's own lights — see `MenuScene.updateOmniLights`. NOT from
   *  the file: every glue model carries `AmbIntensity 0`, and with a light reach of 200 units
   *  that would leave a scene whose bounds run to ±3000 pitch black past the set, which the
   *  reference plainly is not. Tuned by eye against a capture of the real client. */
  lightAmbient: number;
}

/**
 * The model's own lights, evaluated for one frame in the shape the patched SD shader reads
 * (`scene.omniLights`, see patches/mdx-m3-viewer@5.12.0.patch).
 *
 * Every glue model carries them in its MDX **LITE** chunk and we used to ignore all of them,
 * which is why these scenes read flat: with no light on the scene the SD shader falls through
 * to mdx-m3-viewer's stock `clamp(N·L + 0.7)` — a 0.7…1.0 wash with no real falloff anywhere.
 *
 * Dumped from the real models, and the numbers only make sense together:
 *   NightElf_Exp   4 omni, attenuation 80→200, colour (0.82, 1.00, 1.00), intensity 6/250/15/7
 *   Orc_Exp        4 omni, same window, intensity 80/75/80/35
 *   MainMenu3D_Exp 5 omni, same window, intensity 170…280
 * An 80→200 unit reach sounds far too small for a scene whose bounds run to ±3000 — until you
 * read the model's own camera: it sits 340 units from its target. These are **dioramas**, a
 * small lit set close to the eye with a big painted backdrop far behind it, and the lights are
 * sized for the set. The far scenery is what the campaign's own `BackgroundFog*` is for.
 *
 * Every light in all three is `type 0` (omnidirectional) and every one carries
 * `AmbIntensity 0` — the scene's whole illumination is these point lights.
 */
export interface OmniLights {
  /** How many slots are filled; 0 means "no lights", and the shader skips the loop. */
  count: number;
  /** Σ (AmbColor × AmbIntensity) over the model's lights. */
  ambient: Float32Array;
  positions: Float32Array; // MAX_OMNI × 3, world space
  colors: Float32Array; // MAX_OMNI × 3, Color × Intensity
  attenuations: Float32Array; // MAX_OMNI × 2, (start, end)
}

/** Must match `MAX_OMNI` in the patched sd.frag. */
const MAX_OMNI = 8;

/** The largest step the scene's animation clock will take in one frame (see `start`). Two
 *  dropped frames' worth — enough that ordinary jitter passes through untouched, small enough
 *  that a screen build cannot swallow a whole clip. */
const MAX_FRAME_MS = 33;

type Solver = (src: unknown) => unknown;
interface Camera {
  perspective(fov: number, aspect: number, near: number, far: number): void;
  ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): void;
  moveToAndFace(from: Float32Array, to: Float32Array, up: Float32Array): void;
}
interface Scene {
  alpha: boolean;
  color: Float32Array;
  viewport: Float32Array;
  camera: Camera;
  distFog?: DistFog; // OpenWar3: read by the patched SD shaders
  omniLights?: OmniLights | null; // …as is this (the model's own LITE lights)
  removeInstance(instance: unknown): void;
}
interface Viewer {
  on(event: string, cb: (e: unknown) => void): void;
  addHandler(handler: unknown, ...args: unknown[]): boolean;
  addScene(): Scene;
  load(src: unknown, solver?: Solver): Promise<unknown>;
  whenAllLoaded(): Promise<unknown>;
  update(dt: number): void;
  render(): void;
}
interface MdxSequence { name: string; interval: Int32Array | number[] }
/** An MDX event object as the viewer exposes it: `type` is the 3-char kind ("SND", "SPN"),
 *  `id` the 4-char code after it ("SNDXARPD" → "ARPD"), `tracks` the frame times it fires at. */
interface MdxEventObject { type: string; id: string; tracks: ArrayLike<number> }
interface MdxInstance {
  setScene(scene: unknown): void;
  setSequence(index: number): void;
  setSequenceLoopMode(mode: number): void;
  /** The instance's own nodes, laid out bones-then-lights-then-helpers (mdx/modelinstance.js),
   *  so light i is at `model.bones.length + i` and carries that light's animated world position. */
  nodes: Array<{ worldLocation: Float32Array }>;
  /** Where the instance is in its clip — what the lights' animated tracks are sampled at. */
  sequence: number;
  frame: number;
  counter: number;
}

/** An MDX light as the viewer exposes it. Each getter writes the sampled value into `out`
 *  (out[0] for the scalars) and falls back to the model's static value off-sequence. */
interface MdxLight {
  getAttenuationStart(out: Float32Array, sequence: number, frame: number, counter: number): number;
  getAttenuationEnd(out: Float32Array, sequence: number, frame: number, counter: number): number;
  getColor(out: Float32Array, sequence: number, frame: number, counter: number): number;
  getIntensity(out: Float32Array, sequence: number, frame: number, counter: number): number;
  getAmbientColor(out: Float32Array, sequence: number, frame: number, counter: number): number;
  getAmbientIntensity(out: Float32Array, sequence: number, frame: number, counter: number): number;
}
interface MdxCamera {
  position: Float32Array;
  targetPosition: Float32Array;
  fieldOfView: number;
  nearClippingPlane: number;
  farClippingPlane: number;
  /** A glue model's camera is ANIMATED — see `frameCameras`. KCTR moves the eye, KTTR the
   *  target, KCRL rolls it; each getter writes into `out` and falls back to no offset at all
   *  off-sequence, so a model with no tracks samples to the static pose. */
  getTranslation(out: Float32Array, sequence: number, frame: number, counter: number): number;
  getTargetTranslation(out: Float32Array, sequence: number, frame: number, counter: number): number;
  getRotation(out: Float32Array, sequence: number, frame: number, counter: number): number;
}
interface MdxModel {
  sequences: MdxSequence[];
  cameras: MdxCamera[];
  eventObjects: MdxEventObject[];
  lights: MdxLight[];
  bones: unknown[];
  addInstance(): MdxInstance;
}

const ViewerClass = ModelViewerCtor as unknown as { new(canvas: HTMLCanvasElement): Viewer };

/**
 * What EVERY campaign backdrop starts at.
 *
 * The camera half is the model's own, untouched — multipliers of 1, no pan, no orbit — because
 * framing is per-diorama and a nudge that frames Maiev's ruins says nothing about Durotar.
 *
 * The LOOK half is shared, because it is not per-scene: the grade and the base ambient describe
 * how the campaign screen is lit and printed, and the four campaigns are the same screen. Both
 * were tuned in-browser against a capture of the real client on the Sentinels backdrop
 * (issue #105); the grade is why an untouched backdrop no longer renders at raw texture
 * brightness, and lightAmbient is the base the models themselves do not carry
 * (see `updateOmniLights`).
 */
const NEUTRAL_BACKDROP = {
  camZoom: 1, camPanX: 0, camPanY: 0, camFov: 1, camYaw: 0, camPitch: 0, camRoll: 0,
  gradeBrightness: 0.67, gradeContrast: 1, gradeSaturation: 0.97, gradeHue: 0,
  lightAmbient: 0.5,
} as const;

/**
 * Framing/fog/grade baked per backdrop MODEL, tuned in-browser against a capture of the real
 * client (issue #105). A backdrop with no entry here keeps the authored camera and the fog its
 * campaign's own `BackgroundFog*` keys ask for, so this table is an override list, not a
 * replacement for the data.
 *
 * The fog on a tuned entry deliberately does NOT match `CampaignStrings_exp.txt`: the file's
 * numbers describe the game's own fog (a STYLE and a DENSITY, `BackgroundFogStyle=0`,
 * `Density=0.5`) driving a renderer that is not ours, and feeding its start/end straight into
 * our linear distance fog buries the scene in haze at the depth Blizzard wanted a tint. The
 * values here are the ones that reproduce what the reference SHOWS — which is what
 * "match the original" means when the two disagree (CLAUDE.md).
 */
const BACKDROP_DEFAULTS: Record<string, Partial<BackdropTuning>> = {
  // Sentinels / Terror of the Tides (and every campaign on the night-elf backdrop). The grade
  // and ambient this was tuned alongside are in NEUTRAL_BACKDROP, since they are the screen's
  // look rather than this set's framing.
  "ui\\glues\\singleplayer\\nightelf_exp\\nightelf_exp.mdx": {
    camZoom: 1.05, camPanX: 90, camPanY: -15, camFov: 0.76, camYaw: 10, camPitch: 6, camRoll: 0,
    fogStart: 0, fogEnd: 13300, fogR: 0.79, fogG: 0.34, fogB: 0.26,
  },
  // Bonus / The Founding of Durotar. Its camera sits ~990 units from its subject while the
  // model's lights only reach 200, so this set is mostly ambient-lit — hence the dolly in and
  // the ambient a notch above the shared default. Its fog is the campaign's own colour with a
  // start pushed way out, so the haze lands on the far mesas rather than on Rexxar.
  "ui\\glues\\singleplayer\\orc_exp\\orc_exp.mdx": {
    camZoom: 1.03, camFov: 0.68,
    fogStart: 8600, fogEnd: 19600, fogR: 0.298, fogG: 0.298, fogB: 0.4,
    lightAmbient: 0.53, // the grade stays the shared one (NEUTRAL_BACKDROP)
  },
};

export class MenuScene {
  private viewer: Viewer;
  private scene3d: Scene; // perspective background
  private scenePanel: Scene; // orthographic right-edge sprite layer, over the background
  private sceneLeft: Scene; // …and the left-edge one, in its own left-anchored viewport
  private solver: Solver;
  private bgModel: MdxModel | null = null;
  /** The main menu's own background instance, kept so a campaign backdrop can take its place
   *  in the scene and hand it back afterwards. */
  private menuInstance: MdxInstance | null = null;
  /** Campaign backdrops, cached by path — four models the player switches between. */
  private backdrops = new Map<string, MdxModel>();
  private backdropModel: MdxModel | null = null;
  private backdropInstance: MdxInstance | null = null;
  /** The frame the current backdrop's Birth ends on, or null once it has settled (see
   *  showBackdrop). Watched by the frame loop rather than timed off a wall clock. */
  private backdropBirthEnd: number | null = null;
  /** Per-backdrop framing/fog tuning (issue #105) and which one is currently up. */
  private backdropTunings = new Map<string, BackdropTuning>();
  private backdropShown: string | null = null;
  /** True while a campaign backdrop is up: the screen-edge sprite layers draw nothing. */
  private panelsHidden = false;
  private instances: MdxInstance[] = [];
  /** The sprite-layer panels, kept with their model so we can look sequences up by name. */
  private panels: Array<{ model: MdxModel; instance: MdxInstance }> = [];
  private chrome: GlueChrome = "MainMenu";
  private chromeTimer = 0;
  private soundTimers: number[] = [];
  private raf = 0;
  private last = 0;
  /** This frame's evaluation of the scene model's own lights, rebuilt in place each frame. */
  private omni: OmniLights = {
    count: 0,
    ambient: new Float32Array(3),
    positions: new Float32Array(MAX_OMNI * 3),
    colors: new Float32Array(MAX_OMNI * 3),
    attenuations: new Float32Array(MAX_OMNI * 2),
  };
  private lightVec = new Float32Array(3);
  private lightScalar = new Float32Array(1);
  private camVec = new Float32Array(3);
  private camScalar = new Float32Array(1);

  /** Fired when one of the panel chrome's own SND event objects comes due in a clip we are
   *  playing, with its 4-char AnimLookups code ("ARPD"). The host hands it to the SoundBoard,
   *  which resolves it exactly as it resolves a unit's — AnimLookups → AnimSounds. This is
   *  how the menu gets its whooshes: they are not sounds we chose, they are events Blizzard
   *  keyed into the panel model's animation, and we simply honour them. */
  onSound: ((code: string) => void) | null = null;

  // Live-tunable framing (exposed for the on-screen debug controls; values baked from
  // in-browser tuning against the reference). The panel is posed by bone animation, so
  // its ortho window can't be derived from the bind pose — it's tuned by eye. panelHalfX
  // / panelHalfY are independent so the [0,1]²-authored (4:3) panel can be stretched to
  // frame the buttons on a 16:9 screen.
  readonly tuning = {
    camZoom: 0.82, // dolly the eye toward the target (<1 closer)
    camPanX: 0, // pan the eye+target screen-right (world units)
    camPanY: 10, // pan the eye+target screen-up (world units)
    camFov: 0.72, // field-of-view multiplier
    // Orbit off the model's authored angle, in degrees — WC3's own camera fields
    // (docs/camera.md). Zero here: the Icecrown scene is framed by the dolly/pan above.
    camYaw: 0, // rotation about world Z
    camPitch: 0, // angle of attack (positive raises the eye)
    camRoll: 0, // roll on the up vector
    lightAmbient: 0.42, // base ambient under the model's own omni lights (see BackdropTuning)
    panelCx: -0.31, // panel ortho window centre (panel [0,1] space)
    panelCy: -0.2,
    panelHalfX: 0.61, // panel ortho half-width
    panelHalfY: 0.3, // panel ortho half-height (smaller = taller/zoomed panel)
    panelStretchX: 1.32, // widen the container horizontally beyond its natural aspect
    // The left-edge sprite layer, framed by the same rules in a LEFT-anchored viewport.
    // It carries the skirmish screen's Game Settings / Team Setup frames (and nothing at
    // all on the main menu — its "MainMenu Stand" clip hides them), so its window is
    // tuned so those frames land under the FDF containers Skirmish.fdf anchors there.
    leftCx: -0.205, // the screen-edge strip hugs x=0, as it does in the reference
    leftCy: -0.2,
    leftHalfX: 0.295,
    leftHalfY: 0.29,
    leftStretchX: 1.23,
    // Distance-fog haze on the icy background (world units from the eye; rgb 0..1).
    fogStart: 1300,
    fogEnd: 3500,
    fogR: 0.62,
    fogG: 0.63,
    fogB: 0.69,
  };

  /** The campaign backdrop currently up (its model path), or null on the menu's own scene. */
  get backdropPath(): string | null { return this.backdropShown; }

  /** The tuning block the debug controls should be driving: the backdrop's while one is up,
   *  else the menu's own. Null when a backdrop is up that failed to load. */
  get backdropTuning(): BackdropTuning | null {
    return this.backdropShown ? this.backdropTunings.get(this.backdropShown) ?? null : null;
  }

  /** Every backdrop tuned this session, for the debug controls' "Log values". */
  get tunedBackdrops(): ReadonlyMap<string, BackdropTuning> { return this.backdropTunings; }

  /** Fired when the backdrop changes (a campaign swap, or leaving the campaign screen), so
   *  the on-screen controls can re-bind to the block they are now driving. */
  onBackdropChange: (() => void) | null = null;

  /** Apply the current tuning values (called by the debug controls after a change). */
  applyTuning(): void { this.frameCameras(); this.updateFog(); this.updateGrade(); }

  /**
   * The campaign backdrop's colour grade, as a CSS filter on the canvas.
   *
   * The reference's campaign screens are markedly darker and warmer than our render of the same
   * models, and fog cannot close that gap — fog only tints what is FAR, while the whole frame
   * (Maiev included, a few hundred units from the eye) needs to come down. Grading the finished
   * frame is what actually matches, and on a canvas that costs one CSS property rather than a
   * post-process pass through mdx-m3-viewer's render loop.
   *
   * Only a BACKDROP is graded. The same canvas carries the menu's sprite-layer chrome, and
   * dimming the metal panels and their chains along with the seascape is not what any of this
   * is for; a campaign screen has no chrome on the canvas at all (its viewports are zeroed),
   * so there the filter reaches only the 3D scene. The DOM text over it is untouched either
   * way, which is also how the reference reads: bright text on a dark scene.
   */
  private updateGrade(): void {
    const t = this.backdropTuning;
    if (!t) { this.canvas.style.filter = ""; return; }
    const parts: string[] = [];
    if (t.gradeBrightness !== 1) parts.push(`brightness(${t.gradeBrightness})`);
    if (t.gradeContrast !== 1) parts.push(`contrast(${t.gradeContrast})`);
    if (t.gradeSaturation !== 1) parts.push(`saturate(${t.gradeSaturation})`);
    if (t.gradeHue !== 0) parts.push(`hue-rotate(${t.gradeHue}deg)`);
    this.canvas.style.filter = parts.join(" ");
  }

  private updateFog(): void {
    // A backdrop's fog is the campaign's (seeded into its tuning block); the menu's is its own.
    const t = this.backdropTuning ?? this.tuning;
    this.scene3d.distFog = makeFog(t.fogStart, t.fogEnd, t.fogR, t.fogG, t.fogB);
  }

  constructor(private canvas: HTMLCanvasElement, private vfs: DataSource) {
    // Size the drawing buffer before the viewer reads it — directly, not via
    // syncCanvasSize(), which would reframe cameras that don't exist yet.
    canvas.width = canvas.clientWidth || window.innerWidth;
    canvas.height = canvas.clientHeight || window.innerHeight;
    const viewer = new ViewerClass(canvas);
    viewer.on("error", (e) => console.error("[menuscene]", e));
    this.solver = (src) => (typeof src === "string" ? this.vfs.read(src) : src);
    viewer.addHandler(mdxHandler, this.solver, false);
    viewer.addHandler(blpHandler);

    const scene3d = viewer.addScene();
    scene3d.alpha = false; // clears to black behind the icy scene
    scene3d.color.set([0, 0, 0]);

    const scenePanel = viewer.addScene();
    scenePanel.alpha = true; // composite the panels over the background, don't clear it

    const sceneLeft = viewer.addScene();
    sceneLeft.alpha = true;

    this.viewer = viewer;
    this.scene3d = scene3d;
    this.scenePanel = scenePanel;
    this.sceneLeft = sceneLeft;
  }

  /** Load the background scene + the sprite-layer panels and loop their idle clips. */
  async load(): Promise<void> {
    const tft = this.vfs.exists(TFT_MENU);
    const bgPath = tft ? TFT_MENU : ROC_MENU;

    const bytes = await this.vfs.read(bgPath);
    const bg = (await this.viewer.load(bytes, this.solver)) as MdxModel | undefined;
    if (!bg) throw new Error(`failed to load menu scene: ${bgPath}`);
    this.bgModel = bg;
    this.menuInstance = this.addInstance(bg, this.scene3d, /^stand$/i);

    // The screen-edge sprite layers: metal border, gears, the button frames and chains.
    await this.loadPanel(tft ? RIGHT_TFT : RIGHT_ROC, this.scenePanel);
    await this.loadPanel(tft ? LEFT_TFT : LEFT_ROC, this.sceneLeft);

    this.frameCameras();
    this.updateFog();
    await this.viewer.whenAllLoaded();
  }

  /**
   * Swap the 3D background for a CAMPAIGN backdrop (issue #101) — the model a campaign names
   * in `Background` (UI\Glues\SinglePlayer\NightElf_Exp\NightElf_Exp.mdl and friends), under
   * that campaign's own fog.
   *
   * The campaign screen is the one glue screen with NO chrome: the panel models carry a
   * Birth/Stand/Death triple for every other screen in the game (MainMenu, SinglePlayer,
   * SinglePlayerSkirmish, Options, the Battle.net set…) and none for this one, because the
   * reference hides the metal edges entirely and lets the 3D scene fill the screen. So the
   * two sprite layers are switched off while a backdrop is up, and the FDF text sits
   * straight on the scene.
   *
   * The backdrop model brings its own two clips — "Birth" then a looping "Stand" — and its
   * own camera, which is used AS AUTHORED: the main menu's zoom/pan tuning frames the
   * Icecrown scene against the button panel, and there is no panel here to frame against.
   * The per-backdrop `BackdropTuning` block layered on top of that starts neutral, so it
   * changes nothing until the `?menudebug` sliders move it (issue #105).
   *
   * **Asking for the backdrop already up is a no-op**, and that is the point rather than an
   * optimisation. The Campaign screen navigates to ITSELF constantly — Back from a chapter
   * list, picking the campaign you are already on, every re-mount of the two modes over one
   * FDF — and each of those went through here and started the model's Birth again, so the
   * whole scene lurched and re-assembled behind a screen the player never left. A Birth is
   * how a scene ARRIVES; if it is already standing there, it has arrived.
   */
  async showBackdrop(path: string, fog: { r: number; g: number; b: number; start: number; end: number }): Promise<void> {
    if (path === this.backdropShown && this.backdropInstance) return; // already standing
    if (!this.vfs.exists(path)) return;
    let model = this.backdrops.get(path);
    if (!model) {
      model = (await this.viewer.load(await this.vfs.read(path), this.solver)) as MdxModel | undefined;
      if (!model) return;
      this.backdrops.set(path, model);
    }
    this.clearBackdrop();
    this.backdropModel = model;
    this.backdropShown = path;
    // Seed this backdrop's tuning the first time it is shown: neutral camera, the campaign's
    // own fog. Coming back to a campaign keeps whatever the sliders left on it.
    if (!this.backdropTunings.has(path)) {
      this.backdropTunings.set(path, {
        ...NEUTRAL_BACKDROP,
        // The campaign's own BackgroundFog* — per-campaign data, so it seeds per campaign and
        // only a baked entry overrides it.
        fogStart: fog.start, fogEnd: fog.end, fogR: fog.r, fogG: fog.g, fogB: fog.b,
        ...BACKDROP_DEFAULTS[path.toLowerCase()],
      });
    }
    // Birth once, then settle into the looping Stand — the same two-step every glue model
    // arrives with (playChromeBirth does it for the panel chrome).
    const instance = this.addInstance(model, this.scene3d, /^birth$/i);
    instance.setSequenceLoopMode(0);
    this.backdropInstance = instance;
    // Settle onto the Stand when the BIRTH ITSELF finishes — watched on the animation clock in
    // `start`, not scheduled on a wall clock. The two are not the same thing: building the
    // screen and any hitch after it starve the render loop, whose step is clamped
    // (MAX_FRAME_MS), so the clip runs behind wall time by however long the stall was. A
    // setTimeout(birthLength) then cut the arrival short — on a cold entry it fired while the
    // camera was still a third of the way through its sweep, which is the same "no Birth
    // animation" symptom by a different route.
    const birthSeq = model.sequences.find((q) => /^birth$/i.test(q.name));
    this.backdropBirthEnd = birthSeq ? birthSeq.interval[1] : null;
    // The menu's own scene stops drawing behind it, as do the screen-edge sprite layers.
    if (this.menuInstance) this.scene3d.removeInstance(this.menuInstance);
    this.panelsHidden = true;
    this.updateFog();
    this.updateGrade();
    this.frameCameras();
    this.onBackdropChange?.();
  }

  /** Back to the menu's own background and its screen-edge chrome (leaving the campaign
   *  screen). The backdrop model stays loaded — the player usually comes right back. */
  restoreMenuBackground(): void {
    if (!this.backdropInstance) return;
    this.clearBackdrop();
    if (this.menuInstance) this.menuInstance.setScene(this.scene3d);
    this.panelsHidden = false;
    this.updateFog();
    this.updateGrade(); // the menu's own scene is never graded — see updateGrade
    this.frameCameras();
    this.onBackdropChange?.();
  }

  private clearBackdrop(): void {
    if (this.backdropInstance) {
      this.scene3d.removeInstance(this.backdropInstance);
      this.instances = this.instances.filter((i) => i !== this.backdropInstance);
    }
    this.backdropInstance = null;
    this.backdropModel = null;
    this.backdropShown = null;
    this.backdropBirthEnd = null;
  }

  private async loadPanel(path: string, scene: Scene): Promise<void> {
    if (!this.vfs.exists(path)) return;
    const model = (await this.viewer.load(await this.vfs.read(path), this.solver)) as MdxModel | undefined;
    if (!model) return;
    const instance = this.addInstance(model, scene, /^mainmenu stand$/i);
    this.panels.push({ model, instance });
  }

  private addInstance(model: MdxModel, scene: Scene, prefer: RegExp): MdxInstance {
    const instance = model.addInstance();
    instance.setScene(scene);
    instance.setSequenceLoopMode(2); // always loop
    const idx = model.sequences.findIndex((s) => prefer.test(s.name));
    instance.setSequence(idx >= 0 ? idx : 0);
    this.instances.push(instance);
    return instance;
  }

  /** Duration (ms) of a named sequence on the panel model, or 0 if it has none. */
  private seqLength(name: string): number {
    const model = this.panels[0]?.model;
    return model ? seqLengthOf(model, name) : 0;
  }

  /** How long `screen`'s chrome takes to leave and to arrive — the model's own timings. */
  chromeTiming(screen: GlueChrome): ChromeTiming {
    return { death: this.seqLength(`${screen} Death`), birth: this.seqLength(`${screen} Birth`) };
  }

  /** The chrome currently on screen. */
  get chromeScreen(): GlueChrome { return this.chrome; }

  /** Play one named clip on every panel instance; `loop` for the idle Stand clips. */
  private playClip(name: string, loop: boolean): void {
    this.clearSoundTimers();
    for (const { model, instance } of this.panels) {
      const idx = model.sequences.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
      if (idx < 0) continue;
      instance.setSequenceLoopMode(loop ? 2 : 0);
      instance.setSequence(idx);
      this.scheduleClipSounds(model, model.sequences[idx]);
    }
  }

  /**
   * Cue the SND event objects the panel model keys into `seq`. The menu's whooshes live in
   * the model, not in any table we could have guessed at: TopRightPanel-Expansion.mdx fires
   * SNDXARPD (→ "RightGlueScreenPopDown") at frame 2500 and SNDXARPU (→ "…PopUp") at 4833,
   * which are the first frames of "MainMenu Birth" and "MainMenu Death" — one event per
   * screen, on every Birth/Death/Morph clip in the file. The LEFT panel carries its own
   * (ALPD/ALPU) and the skirmish/battle.net screens, where both panels move, carry ABPD/ABPU
   * ("LeftAndRightGlueScreenPop*.wav") instead. So the right sound for a transition is
   * whatever the models say, per panel — never a choice of ours.
   *
   * mdx-m3-viewer doesn't play these itself (its audio path is off and resolves paths its own
   * way), so we run them on the animation's clock: a frame time is ms, and every event we've
   * dumped sits on the clip's first frame, so in practice these fire immediately.
   */
  private scheduleClipSounds(model: MdxModel, seq: MdxSequence): void {
    const [start, end] = [seq.interval[0], seq.interval[1]];
    for (const evt of model.eventObjects ?? []) {
      if (evt.type !== "SND") continue;
      for (let i = 0; i < evt.tracks.length; i++) {
        const at = evt.tracks[i];
        if (at < start || at > end) continue; // belongs to a different screen's clip
        const delay = at - start;
        if (delay <= 0) this.onSound?.(evt.id);
        else this.soundTimers.push(window.setTimeout(() => this.onSound?.(evt.id), delay));
      }
    }
  }

  /** Drop any event still pending — the clip that scheduled it is no longer playing. */
  private clearSoundTimers(): void {
    for (const t of this.soundTimers) clearTimeout(t);
    this.soundTimers = [];
  }

  /** Send the current screen's chrome away: play "<screen> Death" once. */
  playChromeDeath(): number {
    clearTimeout(this.chromeTimer);
    this.playClip(`${this.chrome} Death`, false);
    return this.seqLength(`${this.chrome} Death`);
  }

  /** Bring `screen`'s chrome in: "<screen> Birth" once, then settle on its looping Stand. */
  playChromeBirth(screen: GlueChrome): number {
    clearTimeout(this.chromeTimer);
    this.chrome = screen;
    this.playClip(`${screen} Birth`, false);
    const birth = this.seqLength(`${screen} Birth`);
    this.chromeTimer = window.setTimeout(() => this.playClip(`${screen} Stand`, true), birth);
    return birth;
  }

  start(): void {
    if (this.raf) return;
    const frame = (t: number): void => {
      // CLAMP the step. Building a glue screen blocks the main thread — the campaign screen
      // parses CampaignMenu.fdf and decodes its textures — and the first frame after that
      // stall carries the whole stall as its dt. Fed to the animation clock straight, a 3.3 s
      // hitch advanced NightElf_Exp's 3.3 s "Birth" in ONE step: the model's camera arrived at
      // its final pose before a single frame of the sweep had been drawn, so the campaign
      // screen looked like it had no arrival animation at all. A dropped frame is time the
      // player did not see; it is not time the scene should skip.
      const dt = Math.min(this.last ? t - this.last : 1000 / 60, MAX_FRAME_MS);
      this.last = t;
      this.syncCanvasSize();
      // update() then render(), rather than updateAndRender(), so the lights are read from
      // nodes THIS frame's animation has already moved — a glue model's lights are keyframed
      // and parented into the scene's own hierarchy, so a frame's lag is a frame's lag.
      this.viewer.update(dt);
      this.updateOmniLights();
      this.settleBackdrop();
      // A backdrop's camera is keyframed (see frameCameras), so its framing is a per-frame
      // question while one is up — not something to settle once at showBackdrop.
      if (this.backdropInstance) this.frameCameras();
      this.viewer.render();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** Hand a backdrop from its Birth to its looping Stand the frame the Birth reaches its last
   *  keyframe — see showBackdrop for why this is watched rather than timed. */
  private settleBackdrop(): void {
    const end = this.backdropBirthEnd;
    const instance = this.backdropInstance;
    const model = this.backdropModel;
    if (end === null || !instance || !model || instance.frame < end) return;
    this.backdropBirthEnd = null;
    const stand = model.sequences.findIndex((q) => /^stand$/i.test(q.name));
    if (stand < 0) return;
    instance.setSequenceLoopMode(2);
    instance.setSequence(stand);
  }

  /**
   * Evaluate the scene model's own MDX lights for this frame (see OmniLights). Whatever is in
   * the 3D scene is what gets lit — a campaign backdrop, or the menu's own Icecrown model,
   * both of which ship with omni lights of their own.
   *
   * The colours come out of the file **BGR**, the same quirk `dayNight.ts` documents for the
   * day/night LITE lights: neither the parser nor Warsmash swizzles them, and reading them
   * straight gives every scene a mirror-image tint.
   */
  private updateOmniLights(): void {
    const model = this.backdropModel ?? this.bgModel;
    const instance = this.backdropInstance ?? this.menuInstance;
    const lights = model?.lights ?? [];
    if (!model || !instance || !lights.length) {
      this.omni.count = 0;
      this.scene3d.omniLights = null;
      return;
    }

    const o = this.omni;
    o.positions.fill(0);
    o.colors.fill(0);
    o.attenuations.fill(0);
    o.ambient.fill(0);

    const { sequence, frame, counter } = instance;
    const v = this.lightVec;
    const s = this.lightScalar;
    const count = Math.min(lights.length, MAX_OMNI);
    for (let i = 0; i < count; i++) {
      const light = lights[i];
      // Light i's node sits right after the bones — mdx/modelinstance.js builds them in that
      // order — and carries the light's animated position in world space.
      const node = instance.nodes[(model.bones.length as number) + i];
      if (node) o.positions.set(node.worldLocation.subarray(0, 3), i * 3);

      light.getColor(v, sequence, frame, counter);
      light.getIntensity(s, sequence, frame, counter);
      for (let c = 0; c < 3; c++) o.colors[i * 3 + c] = v[2 - c] * s[0]; // BGR → RGB

      light.getAttenuationStart(s, sequence, frame, counter);
      const start = s[0];
      light.getAttenuationEnd(s, sequence, frame, counter);
      o.attenuations[i * 2] = start;
      o.attenuations[i * 2 + 1] = Math.max(s[0], start + 1); // never a zero-width window

      light.getAmbientColor(v, sequence, frame, counter);
      light.getAmbientIntensity(s, sequence, frame, counter);
      for (let c = 0; c < 3; c++) o.ambient[c] += v[2 - c] * s[0];
    }

    // …plus the base ambient the models do NOT carry (see BackdropTuning.lightAmbient).
    const base = (this.backdropTuning ?? this.tuning).lightAmbient;
    for (let c = 0; c < 3; c++) o.ambient[c] += base;

    o.count = count;
    this.scene3d.omniLights = o;
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  dispose(): void {
    this.stop();
    this.canvas.style.filter = ""; // the grade is ours; don't leave it on the element
    clearTimeout(this.chromeTimer);
    this.clearSoundTimers();
    for (const inst of this.instances) {
      for (const scene of [this.scene3d, this.scenePanel, this.sceneLeft]) {
        try { scene.removeInstance(inst); } catch { /* not in this scene */ }
      }
    }
    this.instances = [];
    this.panels = [];
    this.bgModel = null;
    this.menuInstance = null;
    this.backdropInstance = null;
    this.backdropModel = null;
    this.backdrops.clear();
  }

  /** Frame the background with its own camera and the panels with an ortho projection
   *  mapping their [0,1]² screen space onto the centred 4:3 box (shared with the FDF). */
  private frameCameras(): void {
    if (!this.scene3d || !this.scenePanel || !this.sceneLeft) return; // not constructed yet
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;

    const t = this.tuning;

    // Background: the model's authored camera, dollied in and panned to frame the scene.
    // A CAMPAIGN backdrop starts from its own camera untouched (zoom 1, no pan, no FOV
    // multiplier): the `tuning` block exists to sit the Icecrown scene behind the main menu's
    // button panel, and a campaign screen has no panel to sit behind. Its own per-backdrop
    // block (issue #105) rides on top of the authored camera by the same rules, and is neutral
    // until the debug sliders move it.
    const bt = this.backdropTuning;
    const backdrop = this.backdropModel !== null;
    const cam = (this.backdropModel ?? this.bgModel)?.cameras?.[0];
    if (cam) {
      // Whichever block is driving this scene — both carry the same camera fields.
      const c = backdrop ? bt ?? NEUTRAL_BACKDROP : t;
      const zoom = c.camZoom;
      const [panX, panY] = [c.camPanX, c.camPanY];
      // A backdrop's camera is authored for the 4:3 screen WC3 shipped on, and it frames the
      // scene exactly — Maiev's ruins have nothing painted past their edges. Feed that vertical
      // FOV to a 16:9 viewport and the extra width is scene that was never built: a black void
      // down one side. So a WIDER screen keeps the authored HORIZONTAL extent and gives up
      // height for it (tan(v/2)·aspect held at the 4:3 value), which is the only crop that
      // cannot reveal a hole. The main menu needs none of this — its scene is an open seascape,
      // and its framing is the tuning above.
      const fov = backdrop
        ? 2 * Math.atan(Math.tan(cam.fieldOfView / 2) * Math.min(1, (4 / 3) / (w / h))) * (bt?.camFov ?? 1)
        : cam.fieldOfView * t.camFov;
      this.scene3d.camera.perspective(fov, w / h, cam.nearClippingPlane || 1, cam.farClippingPlane || 100000);

      // The model's camera is ANIMATED, and on a campaign backdrop that animation IS the
      // screen's arrival: NightElf_Exp keys KCTR/KTTR/KCRL across its "Birth" [6633..9933], so
      // the eye sweeps and rolls into place while Maiev turns to meet it. Reading only the
      // static pose — which is where the camera ENDS — threw the whole shot away and made a
      // model with a Birth look as though it had none.
      //
      // The tracks are offsets from the static pose, so a model with no camera animation (or an
      // instance off-sequence) samples to zero and lands exactly where it always did.
      const anim = backdrop ? this.backdropInstance : null;
      const camOff = this.camVec;
      let rollRad = 0;
      if (anim && typeof cam.getTranslation === "function") {
        cam.getTargetTranslation(camOff, anim.sequence, anim.frame, anim.counter);
      } else {
        camOff.fill(0);
      }
      const tgt = [
        cam.targetPosition[0] + camOff[0],
        cam.targetPosition[1] + camOff[1],
        cam.targetPosition[2] + camOff[2],
      ];
      if (anim && typeof cam.getTranslation === "function") {
        cam.getTranslation(camOff, anim.sequence, anim.frame, anim.counter);
        cam.getRotation(this.camScalar, anim.sequence, anim.frame, anim.counter);
        rollRad = this.camScalar[0];
      } else {
        camOff.fill(0);
      }
      // The eye as an OFFSET from the model's own camera target, dollied by zoom — rotating is
      // then just turning that offset, which is what the game's camera fields describe: an
      // angle about a target, not a free-flying eye (docs/camera.md).
      let off: V3 = [
        (cam.position[0] + camOff[0] - tgt[0]) * zoom,
        (cam.position[1] + camOff[1] - tgt[1]) * zoom,
        (cam.position[2] + camOff[2] - tgt[2]) * zoom,
      ];
      // ROTATION about world Z, then ANGLE OF ATTACK about the camera's own right axis after
      // that turn (so pitch stays "up/down on screen" at any yaw). Rotating the offset about
      // `right` by +θ drops the eye, so the sign is flipped: positive pitch raises it, as the
      // slider's label promises.
      if (c.camYaw) off = rotateAbout(off, [0, 0, 1], (c.camYaw * Math.PI) / 180);
      if (c.camPitch) {
        const axis = norm(cross(norm([-off[0], -off[1], -off[2]]), [0, 0, 1]));
        off = rotateAbout(off, axis, (-c.camPitch * Math.PI) / 180);
      }
      const eye = [tgt[0] + off[0], tgt[1] + off[1], tgt[2] + off[2]];
      // Pan eye+target along the camera's screen axes (right, up) with Z as world up.
      const fwd = norm([tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]]);
      const right = norm(cross(fwd, [0, 0, 1]));
      const up = cross(right, fwd);
      for (let i = 0; i < 3; i++) {
        const d = right[i] * panX + up[i] * panY;
        eye[i] += d; tgt[i] += d;
      }
      // ROLL is the up vector turned about the view direction — the image spins, the framing
      // does not move.
      // The model's own KCRL roll and the tuning's camRoll are the same axis; sum them.
      const roll = rollRad + (c.camRoll * Math.PI) / 180;
      const worldUp: V3 = roll ? rotateAbout([0, 0, 1], fwd, roll) : [0, 0, 1];
      this.scene3d.camera.moveToAndFace(new Float32Array(eye), new Float32Array(tgt), new Float32Array(worldUp));
    }
    this.scene3d.viewport.set([0, 0, w, h]);

    // Panel: rendered into a HEIGHT-BASED, RIGHT-ANCHORED viewport so it scales and
    // sits exactly like the FDF buttons (which also scale by height and anchor to the
    // screen's right edge) — the two stay locked together at any screen size/aspect,
    // instead of the panel stretching with the screen width. The viewport width tracks
    // the height via the tuned window aspect (panelHalfX/panelHalfY), so the panel keeps
    // its proportions; panelCx/Cy place the content within it.
    // width = natural (un-stretched) height-based width × an explicit horizontal
    // stretch, so the container can be widened without changing its height.
    // With a campaign backdrop up there is no chrome at all: both sprite layers get an empty
    // viewport, which is how a screen the panel models have no sequence for is rendered.
    if (this.panelsHidden) {
      this.scenePanel.viewport.set([0, 0, 0, 0]);
      this.sceneLeft.viewport.set([0, 0, 0, 0]);
      return;
    }

    const pVw = h * (t.panelHalfX / t.panelHalfY) * t.panelStretchX;
    this.scenePanel.camera.ortho(t.panelCx - t.panelHalfX, t.panelCx + t.panelHalfX, t.panelCy - t.panelHalfY, t.panelCy + t.panelHalfY, 1, 2000);
    this.scenePanel.camera.moveToAndFace(
      new Float32Array([0.5, 0.5, 1000]),
      new Float32Array([0.5, 0.5, 0]),
      new Float32Array([0, 1, 0]),
    );
    this.scenePanel.viewport.set([w - pVw, 0, pVw, h]);

    // The left-edge layer, by the same rules but anchored to the screen's LEFT edge.
    const lVw = h * (t.leftHalfX / t.leftHalfY) * t.leftStretchX;
    this.sceneLeft.camera.ortho(t.leftCx - t.leftHalfX, t.leftCx + t.leftHalfX, t.leftCy - t.leftHalfY, t.leftCy + t.leftHalfY, 1, 2000);
    this.sceneLeft.camera.moveToAndFace(
      new Float32Array([0.5, 0.5, 1000]),
      new Float32Array([0.5, 0.5, 0]),
      new Float32Array([0, 1, 0]),
    );
    this.sceneLeft.viewport.set([0, 0, lVw, h]);
  }

  private syncCanvasSize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.frameCameras(); // viewports + aspect follow the new size (fixes F11 black margins)
    }
  }
}

/** Duration (ms) of a named sequence on `model`, or 0 if it has none. */
function seqLengthOf(model: MdxModel, name: string): number {
  const seq = model.sequences.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return seq ? seq.interval[1] - seq.interval[0] : 0;
}

type V3 = [number, number, number];
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** Rotate `v` about the unit axis `k` by `rad` (Rodrigues). */
function rotateAbout(v: V3, k: V3, rad: number): V3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const kv = cross(k, v);
  const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}
