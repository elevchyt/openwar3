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
export type GlueChrome = "MainMenu" | "SinglePlayer" | "SinglePlayerSkirmish";

/** How long a screen's chrome takes to leave / arrive, in ms — read from the model's
 *  own sequence intervals, so the DOM panels can be animated over the same window. */
export interface ChromeTiming { death: number; birth: number }

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
  removeInstance(instance: unknown): void;
}
interface Viewer {
  on(event: string, cb: (e: unknown) => void): void;
  addHandler(handler: unknown, ...args: unknown[]): boolean;
  addScene(): Scene;
  load(src: unknown, solver?: Solver): Promise<unknown>;
  whenAllLoaded(): Promise<unknown>;
  updateAndRender(dt: number): void;
}
interface MdxSequence { name: string; interval: Int32Array | number[] }
interface MdxInstance {
  setScene(scene: unknown): void;
  setSequence(index: number): void;
  setSequenceLoopMode(mode: number): void;
}
interface MdxCamera {
  position: Float32Array;
  targetPosition: Float32Array;
  fieldOfView: number;
  nearClippingPlane: number;
  farClippingPlane: number;
}
interface MdxModel {
  sequences: MdxSequence[];
  cameras: MdxCamera[];
  addInstance(): MdxInstance;
}

const ViewerClass = ModelViewerCtor as unknown as { new(canvas: HTMLCanvasElement): Viewer };

export class MenuScene {
  private viewer: Viewer;
  private scene3d: Scene; // perspective background
  private scenePanel: Scene; // orthographic right-edge sprite layer, over the background
  private sceneLeft: Scene; // …and the left-edge one, in its own left-anchored viewport
  private solver: Solver;
  private bgModel: MdxModel | null = null;
  private instances: MdxInstance[] = [];
  /** The sprite-layer panels, kept with their model so we can look sequences up by name. */
  private panels: Array<{ model: MdxModel; instance: MdxInstance }> = [];
  private chrome: GlueChrome = "MainMenu";
  private chromeTimer = 0;
  private raf = 0;
  private last = 0;

  // Live-tunable framing (exposed for the on-screen debug controls; values baked from
  // in-browser tuning against the reference). The panel is posed by bone animation, so
  // its ortho window can't be derived from the bind pose — it's tuned by eye. panelHalfX
  // / panelHalfY are independent so the [0,1]²-authored (4:3) panel can be stretched to
  // frame the buttons on a 16:9 screen.
  readonly tuning = {
    camZoom: 0.88, // dolly the eye toward the target (<1 closer)
    camPanX: 0, // pan the eye+target screen-right (world units)
    camPanY: -140, // pan the eye+target screen-up (world units)
    camFov: 0.67, // field-of-view multiplier
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
    leftStretchX: 1.07,
    // Distance-fog haze on the icy background (world units from the eye; rgb 0..1).
    fogStart: 2700,
    fogEnd: 4200,
    fogR: 0.62,
    fogG: 0.63,
    fogB: 0.77,
  };

  /** Apply the current `tuning` values (called by the debug controls after a change). */
  applyTuning(): void { this.frameCameras(); this.updateFog(); }

  private updateFog(): void {
    const t = this.tuning;
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
    this.addInstance(bg, this.scene3d, /^stand$/i);

    // The screen-edge sprite layers: metal border, gears, the button frames and chains.
    await this.loadPanel(tft ? RIGHT_TFT : RIGHT_ROC, this.scenePanel);
    await this.loadPanel(tft ? LEFT_TFT : LEFT_ROC, this.sceneLeft);

    this.frameCameras();
    this.updateFog();
    await this.viewer.whenAllLoaded();
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
    const seq = model?.sequences.find((s) => s.name.toLowerCase() === name.toLowerCase());
    return seq ? seq.interval[1] - seq.interval[0] : 0;
  }

  /** How long `screen`'s chrome takes to leave and to arrive — the model's own timings. */
  chromeTiming(screen: GlueChrome): ChromeTiming {
    return { death: this.seqLength(`${screen} Death`), birth: this.seqLength(`${screen} Birth`) };
  }

  /** The chrome currently on screen. */
  get chromeScreen(): GlueChrome { return this.chrome; }

  /** Play one named clip on every panel instance; `loop` for the idle Stand clips. */
  private playClip(name: string, loop: boolean): void {
    for (const { model, instance } of this.panels) {
      const idx = model.sequences.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
      if (idx < 0) continue;
      instance.setSequenceLoopMode(loop ? 2 : 0);
      instance.setSequence(idx);
    }
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
      const dt = this.last ? t - this.last : 1000 / 60;
      this.last = t;
      this.syncCanvasSize();
      this.viewer.updateAndRender(dt);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  dispose(): void {
    this.stop();
    clearTimeout(this.chromeTimer);
    for (const inst of this.instances) {
      for (const scene of [this.scene3d, this.scenePanel, this.sceneLeft]) {
        try { scene.removeInstance(inst); } catch { /* not in this scene */ }
      }
    }
    this.instances = [];
    this.panels = [];
    this.bgModel = null;
  }

  /** Frame the background with its own camera and the panels with an ortho projection
   *  mapping their [0,1]² screen space onto the centred 4:3 box (shared with the FDF). */
  private frameCameras(): void {
    if (!this.scene3d || !this.scenePanel || !this.sceneLeft) return; // not constructed yet
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;

    const t = this.tuning;

    // Background: the model's authored camera, dollied in and panned to frame the scene.
    const cam = this.bgModel?.cameras?.[0];
    if (cam) {
      this.scene3d.camera.perspective(cam.fieldOfView * t.camFov, w / h, cam.nearClippingPlane || 1, cam.farClippingPlane || 100000);
      const tgt = [cam.targetPosition[0], cam.targetPosition[1], cam.targetPosition[2]];
      const eye = [
        tgt[0] + (cam.position[0] - tgt[0]) * t.camZoom,
        tgt[1] + (cam.position[1] - tgt[1]) * t.camZoom,
        tgt[2] + (cam.position[2] - tgt[2]) * t.camZoom,
      ];
      // Pan eye+target along the camera's screen axes (right, up) with Z as world up.
      const fwd = norm([tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]]);
      const right = norm(cross(fwd, [0, 0, 1]));
      const up = cross(right, fwd);
      for (let i = 0; i < 3; i++) {
        const d = right[i] * t.camPanX + up[i] * t.camPanY;
        eye[i] += d; tgt[i] += d;
      }
      this.scene3d.camera.moveToAndFace(new Float32Array(eye), new Float32Array(tgt), new Float32Array([0, 0, 1]));
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

type V3 = [number, number, number];
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
