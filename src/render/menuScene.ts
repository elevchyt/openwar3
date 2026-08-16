import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import type { DataSource } from "../vfs/types";
import { makeFog, type DistFog } from "./fog";
import { animTimeout, onAnimFrame, type AnimTimer } from "./animClock";

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
// The game's own logo, top-left of the main menu (issue #107). Like the chrome it is a MODEL
// rather than a texture we blit: one flat quad in the FDF's own units (extent x ±0.112,
// y ±0.058, z 0 — the same 0.8×0.6 screen space ui/fdf/layout.ts lays the buttons out in),
// carrying `ReplaceableTextures\WorldEditUI\WarcraftIIIFTLogo.blp` on the expansion and
// `Textures\WarcraftIII-logo-alpha.blp` on RoC, with a Birth/Stand/Death triple of its own.
// Its layer is `filterMode 2, flags 65` — blended and UNSHADED, so it takes neither the
// scene's lights nor its fog; it is UI printed over the seascape, not part of it.
const LOGO_TFT = "UI\\Glues\\MainMenu\\WarCraftIIILogo_exp\\WarCraftIIILogo_exp.mdx";
const LOGO_ROC = "UI\\Glues\\MainMenu\\WarCraftIIILogo\\WarCraftIIILogo.mdx";

/**
 * Half-width of the logo's ortho window, in the model's OWN units.
 *
 * The quad only runs to ±0.112 × ±0.058, so this is a square box with room to spare around it
 * — the window is square and the viewport is square, which is what keeps the scale uniform and
 * the logo un-stretched at any screen aspect. Anything the model does not fill is transparent.
 */
const LOGO_HALF = 0.16;

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
  | "BattlenetCustomCreate" | "MultiplayerPreGameChat" | "Options";

/** Which of the two sprite layers a panel instance is. */
export type PanelSide = "left" | "right";

/** The three clips a screen's chrome plays, in the order it plays them. */
export interface ChromeClips { birth: string; stand: string; death: string }

/** One sprite-layer panel: its model, the instance in the scene, and which side it is. */
interface Panel { model: MdxModel; instance: MdxInstance; side: PanelSide }

/**
 * The screens whose two panels do NOT play the same clip.
 *
 * A screen's chrome is normally one triple played on both sprite layers at once, and each
 * model animates whatever it owns of that screen (the skirmish screen's big left-hand frames
 * live in "SinglePlayerSkirmish Stand" on the LEFT model, its button panels in the same clip
 * on the RIGHT one). **Options is the exception**, and the model says so: on the LEFT panel
 * "Options Stand" draws nothing but the screen-edge post, and the big settings frame the
 * gameplay/video/sound controls sit on is in "Options Stand **Alternate**" — reached by
 * "Options Morph" and left by "Options Morph Alternate".
 *
 * That the two are meant to play TOGETHER is in the intervals: dumped from the real
 * TopRightPanel-Expansion.mdx / TopLeftPanel-Expansion.mdx, Birth and Morph are both 1000 ms
 * and Death and Morph Alternate are both 667 ms. They are the two halves of one transition,
 * one per side — so the left panel's settings frame swings in on exactly the beat the right
 * panel's buttons drop, and lifts away on exactly the beat they leave.
 */
const LEFT_PANEL_CLIPS: Partial<Record<GlueChrome, ChromeClips>> = {
  Options: {
    birth: "Options Morph",
    stand: "Options Stand Alternate",
    death: "Options Morph Alternate",
  },
};

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
 *   Undead3D_Exp   4 omni, same window, intensity 120/111/222/40
 *   Alliance_Exp   4 omni, same window, intensity 400/1000/1000/800 — plus one DIRECTIONAL
 * An 80→200 unit reach sounds far too small for a scene whose bounds run to ±3000 — until you
 * read the model's own camera: it sits 340 units from its target. These are **dioramas**, a
 * small lit set close to the eye with a big painted backdrop far behind it, and the lights are
 * sized for the set. The far scenery is what the campaign's own `BackgroundFog*` is for.
 *
 * Every one of them carries `AmbIntensity 0`, so a glue scene's whole illumination is its
 * point lights and the base ambient `BackdropTuning.lightAmbient` supplies.
 *
 * **`Type` is not always 0.** Four of the five glue models carry nothing but omnis, and
 * Alliance_Exp carries `FDirect01`, `Type 1` — a DIRECTIONAL light, which has a direction
 * instead of a position and no attenuation at all. Read as an omni it was a point light at the
 * node's pivot with an 80→200 window, 6102 units from that model's own camera target, so it
 * contributed exactly nothing while occupying a slot and making the loop's arithmetic a lie.
 * It is filtered out rather than approximated: the MDX gives it no orientation to use (identity
 * rotation, no parent, `Intensity 0.1`), and inventing one would be guessing at what the
 * reference shows. See docs/lighting.md.
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
  /** The LITE chunk's own `Type`: 0 omnidirectional, 1 directional, 2 ambient. Only 0 is a
   *  point light, and only 0 is what `updateOmniLights` uploads — see the filter there. */
  type: number;
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
    camZoom: 1, camPanX: 0, camPanY: -15, camFov: 0.66, camYaw: 10, camPitch: 6, camRoll: 0,
    fogStart: 0, fogEnd: 13300, fogR: 0.79, fogG: 0.34, fogB: 0.26,
  },
  // Alliance / Curse of the Blood Elves. Kael stands in the middle of his own set with the
  // Outland skerries floating well behind him, so this one is framed by widening the lens and
  // sliding the subject off-centre rather than by orbiting — the authored camera already looks
  // at him from the right angle. Its fog is the campaign's red at a start of 0, which is what
  // paints the whole sky; the ambient is up because Kael's own lights are few and dim against
  // a set that reads lit from everywhere in the reference.
  "ui\\glues\\singleplayer\\alliance_exp\\alliance_exp.mdx": {
    camZoom: 0.91, camPanX: 15, camFov: 0.79,
    fogStart: 0, fogEnd: 12200, fogR: 0.7, fogG: 0.2, fogB: 0.2,
    lightAmbient: 0.83, // the grade stays the shared one (NEUTRAL_BACKDROP)
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
  private sceneLogo: Scene; // …and the WarCraft III logo, in a square top-left viewport
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
  /** The sprite-layer panels, kept with their model so we can look sequences up by name, and
   *  with which SIDE they are — a screen may drive the two differently (LEFT_PANEL_CLIPS). */
  private panels: Panel[] = [];
  /** The WarCraft III logo, kept with its model so its own Birth/Stand/Death can be driven
   *  alongside the chrome's (see `playLogo`). Null on an install that has no logo model. */
  private logo: { model: MdxModel; instance: MdxInstance } | null = null;
  /** Pending hand-offs from a `replayPanel` — its Death→Birth→Stand chain. */
  private panelTimers: AnimTimer[] = [];
  /** Sides currently wearing clips of their OWN rather than the screen's (see `sidePanel`).
   *  Cleared whenever a screen arrives — a new screen owns both panels. */
  private sideClips = new Map<PanelSide, ChromeClips>();
  private chrome: GlueChrome = "MainMenu";
  /**
   * The chrome's Birth→Stand hand-off — and every timer below it — on the ANIMATION clock
   * (animClock.ts), never on `window.setTimeout`.
   *
   * What these wait for is a CLIP to finish, and a clip only moves on frames the browser serves.
   * A wall-clock timer kept counting through a hidden tab and through any stall, so it fired
   * while the Birth it was timing was still parked on the frame it froze at and snapped the
   * panel onto its Stand from mid-air — the same failure `showBackdrop` documents, arrived at
   * from the other side.
   */
  private chromeTimer: AnimTimer | null = null;
  /** The logo's own Birth→Stand hand-off, on the same pattern as `chromeTimer`. */
  private logoTimer: AnimTimer | null = null;
  private soundTimers: AnimTimer[] = [];
  /** Unsubscribe from the shared animation clock while this scene is running (see `start`). */
  private offFrame: (() => void) | null = null;
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
    // Base ambient under the model's own omni lights (see BackdropTuning). This and the fog
    // below are ONE setting, not two: the Icecrown set is lit almost entirely by ambient (its
    // five omnis reach 200 units into a scene whose bounds run to ±3000), so ambient decides
    // how much of the island there is to see and the fog decides how much of it the haze takes
    // back. Tuned together against the reference in issue #107 — at the old 0.42/1300-3500 the
    // set was a milk bath: the shipwreck beam, the rock ledges and the teal ice all dissolved
    // into haze that starts in front of the water, which the reference plainly does not do.
    //
    // These two are the ONLY knobs for how much of the set reads. If our scene still looks
    // crisper than a screenshot of the real client, reach for these rather than for the texture
    // path: the reference frames are ~0.6 px soft from video compression, and once the chrome
    // (which we render identically) is blurred to match, the ice and the ocean match too. The
    // measurement, and the three plausible renderer causes it rules out, are in docs/REFERENCES.md.
    lightAmbient: 0.65,
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
    // The WarCraft III logo, placed in the FDF's own screen space (ui/fdf/layout.ts: 0.8×0.6,
    // origin BOTTOM-LEFT, +y up, x=0 at the screen's left edge) — the space the model's quad
    // is authored in, so `logoScale` 1 is the size Blizzard drew it at.
    //
    // The position is measured off the reference rather than read out of MainMenu.fdf, because
    // the file does not carry one: its `Frame "SPRITE" "WarCraftIIILogo"` has its
    // `BackgroundArt` line COMMENTED OUT, so the frame draws nothing and the engine hangs the
    // model somewhere of its own choosing. Its `SetPoint TOPLEFT, "MainMenuFrame", TOPLEFT,
    // 0.13, 0.04` cannot be that place under any reading — +0.04 is ABOVE the top of a 0.6-tall
    // screen, and 0.13 from the left is past where the logo plainly starts.
    logoX: 0.17, // world x of the model's ORIGIN (the quad's centre)
    logoY: 0.529, // …and its world y, up from the screen's bottom
    logoScale: 1, // multiplier on the model's authored size
    // …and how much WIDER than its authored aspect it is drawn. The reference is 16:9 and its
    // logo measures 257 px across the gold "WarCraft" against the 198 px the authored quad
    // gives at the same height — the 4:3 → 16:9 widening the chrome already wears
    // (`panelStretchX` 1.32, `leftStretchX` 1.23). 1 draws it at true aspect instead.
    logoStretchX: 1.3,
    // Distance-fog haze on the icy background (world units from the eye; rgb 0..1). The colour
    // is the reference's, which is a cold LAVENDER rather than the neutral grey this used to
    // carry — measured off it patch by patch, where every one of them wanted 13-35 more blue
    // than we were giving. The start sits PAST the near water, which is why the water reads as
    // deep blue there and as grey here at 1300.
    fogStart: 1800,
    fogEnd: 4800,
    fogR: 0.67,
    fogG: 0.7,
    fogB: 0.83,
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

    const sceneLogo = viewer.addScene();
    sceneLogo.alpha = true;

    this.viewer = viewer;
    this.scene3d = scene3d;
    this.scenePanel = scenePanel;
    this.sceneLeft = sceneLeft;
    this.sceneLogo = sceneLogo;
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
    await this.loadPanel(tft ? RIGHT_TFT : RIGHT_ROC, this.scenePanel, "right");
    await this.loadPanel(tft ? LEFT_TFT : LEFT_ROC, this.sceneLeft, "left");
    await this.loadLogo(tft ? LOGO_TFT : LOGO_ROC);

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
    // (MAX_STEP_MS), so the clip runs behind wall time by however long the stall was. A
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

  private async loadPanel(path: string, scene: Scene, side: PanelSide): Promise<void> {
    if (!this.vfs.exists(path)) return;
    const model = (await this.viewer.load(await this.vfs.read(path), this.solver)) as MdxModel | undefined;
    if (!model) return;
    const instance = this.addInstance(model, scene, /^mainmenu stand$/i);
    this.panels.push({ model, instance, side });
  }

  /**
   * The WarCraft III logo (issue #107). It arrives on its own "Birth" and settles on the
   * looping "Stand", exactly as the chrome does — and it is a separate model rather than part
   * of the left sprite layer because the game keeps it separate: `MainMenu.fdf` gives it its
   * own `Frame "SPRITE" "WarCraftIIILogo"`, and the campaign screen has a THIRD copy of it
   * (`UI\Glues\SinglePlayer\CampaignWarCraftIIILogo\…`, anchored TOPRIGHT there — not wired up
   * here, since this issue is the main menu's).
   */
  private async loadLogo(path: string): Promise<void> {
    if (!this.vfs.exists(path)) return;
    const model = (await this.viewer.load(await this.vfs.read(path), this.solver)) as MdxModel | undefined;
    if (!model) return;
    const instance = this.addInstance(model, this.sceneLogo, /^birth$/i);
    instance.setSequenceLoopMode(0);
    this.logo = { model, instance };
    this.logoTimer = animTimeout(() => this.playLogo("stand", true), seqLengthOf(model, "Birth"));
  }

  /** Play one of the logo's own clips. It shares the chrome's Birth/Stand/Death vocabulary, so
   *  a screen change drives it on the same beats the panels move on (`playPhase`). */
  private playLogo(phase: keyof ChromeClips, loop: boolean): void {
    if (!this.logo) return;
    this.logoTimer?.cancel();
    const name = phase === "birth" ? "Birth" : phase === "death" ? "Death" : "Stand";
    const idx = this.logo.model.sequences.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) return;
    this.logo.instance.setSequenceLoopMode(loop ? 2 : 0);
    this.logo.instance.setSequence(idx);
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

  /** Duration (ms) of a named sequence on the panel model, or 0 if it has none. Read off the
   *  RIGHT panel, which is every screen's own triple — the left panel's alternate clips are
   *  the same lengths by construction (see LEFT_PANEL_CLIPS). */
  private seqLength(name: string): number {
    const model = this.panels[0]?.model;
    return model ? seqLengthOf(model, name) : 0;
  }

  /** The clip `side` plays for `screen`'s `phase` — clips of its own if `sidePanel` gave it
   *  some, else its own triple unless the screen splits the two panels (LEFT_PANEL_CLIPS). */
  private clipFor(screen: GlueChrome, phase: keyof ChromeClips, side: PanelSide): string {
    const own = this.sideClips.get(side);
    if (own) return own[phase];
    const split = side === "left" ? LEFT_PANEL_CLIPS[screen] : undefined;
    if (split) return split[phase];
    return `${screen} ${phase === "birth" ? "Birth" : phase === "death" ? "Death" : "Stand"}`;
  }

  /** The longest `phase` clip across both panels, so the DOM's window covers whichever side
   *  is slowest. They only differ when `sidePanel` has split the two (issue #80). */
  private longestPhase(phase: keyof ChromeClips): number {
    let ms = 0;
    for (const p of this.panels) ms = Math.max(ms, seqLengthOf(p.model, this.clipFor(this.chrome, phase, p.side)));
    return ms;
  }

  /** How long `screen`'s chrome takes to leave and to arrive — the model's own timings. */
  chromeTiming(screen: GlueChrome): ChromeTiming {
    return { death: this.seqLength(`${screen} Death`), birth: this.seqLength(`${screen} Birth`) };
  }

  /** The chrome currently on screen. */
  get chromeScreen(): GlueChrome { return this.chrome; }

  /** Play one phase of the CURRENT screen's chrome on both panels — each on the clip its own
   *  side owns (clipFor); `loop` for the idle Stand clips. */
  private playPhase(phase: keyof ChromeClips, loop: boolean): void {
    this.clearSoundTimers();
    this.clearPanelTimers();
    for (const panel of this.panels) this.playOn(panel, phase, loop);
  }

  /** One panel, one phase — the clip that side owns, plus whatever the clip whooshes. */
  private playOn(panel: Panel, phase: keyof ChromeClips, loop: boolean): void {
    const { model, instance, side } = panel;
    const name = this.clipFor(this.chrome, phase, side);
    const idx = model.sequences.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) return;
    instance.setSequenceLoopMode(loop ? 2 : 0);
    instance.setSequence(idx);
    this.scheduleClipSounds(model, model.sequences[idx]);
  }

  /**
   * Send ONE panel away and bring it straight back, on the same two clips a screen change
   * uses — Death, then Birth, then back to its looping Stand. Returns their lengths so the
   * DOM that panel carries can fade out and in on the same beats.
   *
   * The Options screen is what this is for. Its three settings panels are three different
   * heights, and the left-hand frame that carries them is a fixed piece of art — so the
   * reference does not resize it under the player, it swings the frame away and swings it
   * back around the new contents. On that screen those two clips ARE the Morph pair
   * (LEFT_PANEL_CLIPS), which is the transition the model was given for exactly this.
   */
  replayPanel(side: PanelSide): ChromeTiming {
    const panel = this.panels.find((p) => p.side === side);
    if (!panel) return { death: 0, birth: 0 };
    this.clearPanelTimers();
    const death = seqLengthOf(panel.model, this.clipFor(this.chrome, "death", side));
    const birth = seqLengthOf(panel.model, this.clipFor(this.chrome, "birth", side));
    this.playOn(panel, "death", false);
    this.panelTimers.push(animTimeout(() => {
      this.playOn(panel, "birth", false);
      this.panelTimers.push(animTimeout(() => this.playOn(panel, "stand", true), birth));
    }, death));
    return { death, birth };
  }

  /**
   * Move ONE panel on a clip of its own, and leave it wearing `wearing` until the screen
   * changes (issue #80). Returns that clip's length so the DOM it carries can fade on the
   * same beat.
   *
   * `replayPanel` above is the case where a panel leaves and comes straight back on the
   * SCREEN's own clips. This is the other case: a screen whose halves are separate entries in
   * the model's sequence table and come and go independently of each other. The Single Player
   * screen is the one that needs it — see ui/fdfSinglePlayerMenu.ts for the clip table and
   * how it was measured off the two models.
   *
   * `wearing` is what that side is on once `play` finishes: it settles on that triple's Stand,
   * and — the point of remembering it — LEAVING the screen later sends this panel away on that
   * triple's Death rather than the screen's, so a panel the screen never had cannot slide out
   * on a clip that would pop it back in first. `null` hands the side back to the screen's own
   * chrome.
   */
  sidePanel(side: PanelSide, play: string, wearing: ChromeClips | null): number {
    const panel = this.panels.find((p) => p.side === side);
    if (!panel) return 0;
    const idx = panel.model.sequences.findIndex((s) => s.name.toLowerCase() === play.toLowerCase());
    if (idx < 0) return 0;
    this.clearPanelTimers();
    if (wearing) this.sideClips.set(side, wearing);
    else this.sideClips.delete(side);

    panel.instance.setSequenceLoopMode(0);
    panel.instance.setSequence(idx);
    this.scheduleClipSounds(panel.model, panel.model.sequences[idx]);
    const length = seqLengthOf(panel.model, play);
    // Settle onto whatever this side now wears — its own Stand, or the screen's.
    this.panelTimers.push(animTimeout(() => this.playOn(panel, "stand", true), length));
    return length;
  }

  /** Drop a pending `replayPanel` hand-off — a screen change owns the panels now. */
  private clearPanelTimers(): void {
    for (const t of this.panelTimers) t.cancel();
    this.panelTimers = [];
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
        else this.soundTimers.push(animTimeout(() => this.onSound?.(evt.id), delay));
      }
    }
  }

  /** Drop any event still pending — the clip that scheduled it is no longer playing. */
  private clearSoundTimers(): void {
    for (const t of this.soundTimers) t.cancel();
    this.soundTimers = [];
  }

  /** Send the current screen's chrome away: play "<screen> Death" once — or, for a side that
   *  `sidePanel` put on clips of its own, that triple's Death. */
  playChromeDeath(): number {
    this.chromeTimer?.cancel();
    const death = this.longestPhase("death");
    this.playPhase("death", false);
    // The logo only ever stands on the MAIN MENU — MainMenu.fdf is the one glue file that
    // carries the sprite (the campaign screen has its own copy of the model). So it leaves
    // with the main menu's chrome, on the model's own Death, rather than being cut.
    if (this.chrome === "MainMenu") this.playLogo("death", false);
    return death;
  }

  /**
   * Bring `screen`'s chrome in: "<screen> Birth" once, then settle on its looping Stand.
   *
   * `sides` gives a panel clips of its OWN for this screen — the Single Player screen arrives
   * with its profile half on one triple and its button column on another (see `sidePanel`).
   * It is taken HERE rather than set afterwards so each panel plays exactly one birth, and so
   * fires exactly one of the whooshes its clip keys (scheduleClipSounds).
   */
  playChromeBirth(screen: GlueChrome, sides?: Partial<Record<PanelSide, ChromeClips>>): number {
    this.chromeTimer?.cancel();
    this.chrome = screen;
    this.sideClips.clear(); // an arriving screen owns both panels again
    for (const side of ["left", "right"] as const) {
      const clips = sides?.[side];
      if (clips) this.sideClips.set(side, clips);
    }
    this.playPhase("birth", false);
    const birth = this.longestPhase("birth");
    this.chromeTimer = animTimeout(() => this.playPhase("stand", true), birth);
    if (screen === "MainMenu") {
      this.playLogo("birth", false);
      this.logoTimer = animTimeout(() => this.playLogo("stand", true), this.logoLength("Birth"));
    }
    this.frameCameras(); // the logo's viewport is per-screen (see frameCameras)
    return birth;
  }

  /** Duration (ms) of one of the logo model's clips, or 0 if there is no logo. */
  private logoLength(name: string): number {
    return this.logo ? seqLengthOf(this.logo.model, name) : 0;
  }

  start(): void {
    if (this.offFrame) return;
    // On the SHARED animation clock (animClock.ts), which is where the step and its clamp now
    // come from — the same step the DOM fades and the clip hand-offs read, so a screen and the
    // chrome carrying it cannot come apart, and a hidden tab advances all of them or none.
    this.offFrame = onAnimFrame((dt: number): void => {
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
      // The clock keeps stepping while the tab is hidden so the clips finish (animClock.ts) —
      // but a hidden tab composites nothing, so there is no picture to draw for. Advance; don't
      // paint. The first step back paints the pose the animation has meanwhile reached.
      if (!document.hidden) this.viewer.render();
      // `whileHidden: false`: the menu's idle Stand clips are not a reason to keep an unwatched
      // tab ticking. While a transition is running they still get every step the clock takes,
      // because what that transition is waiting on holds the clock open (animClock.ts).
    }, { whileHidden: false });
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
    let n = 0; // slots FILLED — not the light's index, since a non-omni is skipped
    for (let i = 0; i < lights.length && n < MAX_OMNI; i++) {
      const light = lights[i];
      // Only `Type 0` is a point light, and everything below it — a world position, a distance
      // and a linear attenuation window — is a point light's arithmetic. Alliance_Exp carries
      // the one exception in the glue set (`FDirect01`, type 1); see OmniLights.
      if (light.type !== 0) continue;
      // Light i's node sits right after the bones — mdx/modelinstance.js builds them in that
      // order — and carries the light's animated position in world space. Indexed by `i`, the
      // light's own index, while the uploaded slot is `n`.
      const node = instance.nodes[(model.bones.length as number) + i];
      if (node) o.positions.set(node.worldLocation.subarray(0, 3), n * 3);

      light.getColor(v, sequence, frame, counter);
      light.getIntensity(s, sequence, frame, counter);
      for (let c = 0; c < 3; c++) o.colors[n * 3 + c] = v[2 - c] * s[0]; // BGR → RGB

      light.getAttenuationStart(s, sequence, frame, counter);
      const start = s[0];
      light.getAttenuationEnd(s, sequence, frame, counter);
      o.attenuations[n * 2] = start;
      o.attenuations[n * 2 + 1] = Math.max(s[0], start + 1); // never a zero-width window

      light.getAmbientColor(v, sequence, frame, counter);
      light.getAmbientIntensity(s, sequence, frame, counter);
      for (let c = 0; c < 3; c++) o.ambient[c] += v[2 - c] * s[0];
      n++;
    }

    // …plus the base ambient the models do NOT carry (see BackdropTuning.lightAmbient).
    const base = (this.backdropTuning ?? this.tuning).lightAmbient;
    for (let c = 0; c < 3; c++) o.ambient[c] += base;

    // Uploaded even if the filter left `n` at 0: the base ambient is still this screen's, and
    // the shader's unused slots are black, so a model of nothing but directional lights is lit
    // by the ambient rather than dropped back onto the stock 0.7 wash.
    o.count = n;
    this.scene3d.omniLights = o;
  }

  stop(): void {
    this.offFrame?.();
    this.offFrame = null;
  }

  dispose(): void {
    this.stop();
    this.canvas.style.filter = ""; // the grade is ours; don't leave it on the element
    this.chromeTimer?.cancel();
    this.logoTimer?.cancel();
    this.clearSoundTimers();
    this.clearPanelTimers();
    for (const inst of this.instances) {
      for (const scene of [this.scene3d, this.scenePanel, this.sceneLeft, this.sceneLogo]) {
        try { scene.removeInstance(inst); } catch { /* not in this scene */ }
      }
    }
    this.instances = [];
    this.panels = [];
    this.logo = null;
    this.bgModel = null;
    this.menuInstance = null;
    this.backdropInstance = null;
    this.backdropModel = null;
    this.backdrops.clear();
  }

  /** Frame the background with its own camera and the panels with an ortho projection
   *  mapping their [0,1]² screen space onto the centred 4:3 box (shared with the FDF). */
  private frameCameras(): void {
    if (!this.scene3d || !this.scenePanel || !this.sceneLeft || !this.sceneLogo) return; // not constructed yet
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
    // The logo, laid out in the FDF's own screen space rather than in a tuned ortho window like
    // the panels: it IS a UI sprite (MainMenu.fdf frames it), and its quad is authored in those
    // very units, so mapping them 1:1 is what makes `logoScale` 1 mean "the size it was drawn".
    // `fitBox` (ui/fdf/layout.ts) is the same mapping the buttons get — height-based, x=0 at
    // the screen's left edge — so the logo and the DOM over it move together at any aspect.
    // A SQUARE viewport around a SQUARE ortho window keeps the scale uniform on both axes.
    // Off on every screen but the main menu, and off entirely behind a campaign backdrop.
    if (this.logo && this.chrome === "MainMenu" && !this.panelsHidden) {
      const px = h / 0.6; // world units → pixels (UI_HEIGHT; see ui/fdf/layout.ts fitBox)
      const halfY = LOGO_HALF * t.logoScale * px;
      const halfX = halfY * t.logoStretchX; // …the widescreen widening (see `logoStretchX`)
      this.sceneLogo.camera.ortho(-LOGO_HALF, LOGO_HALF, -LOGO_HALF, LOGO_HALF, 1, 2000);
      this.sceneLogo.camera.moveToAndFace(
        new Float32Array([0, 0, 1000]),
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
      );
      // GL viewports count y from the BOTTOM, which is also how the FDF space runs — so this
      // is the one place in the file where no flip is needed. A wider viewport over the same
      // square ortho window is what stretches the quad.
      this.sceneLogo.viewport.set([t.logoX * px - halfX, t.logoY * px - halfY, 2 * halfX, 2 * halfY]);
    } else {
      this.sceneLogo.viewport.set([0, 0, 0, 0]);
    }

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
