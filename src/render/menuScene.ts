import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import type { DataSource } from "../vfs/types";

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
// Only the right panel — it carries the button frame + the hanging chains. The
// left panel is a screen-edge border/gear strip meant to hug the left edge; under
// our centred 4:3 mapping it floats mid-screen, so we leave it out.
const PANELS_TFT = ["UI\\Glues\\SpriteLayers\\Expansion\\TopRightPanel-Expansion.mdx"];
const PANELS_ROC = ["UI\\Glues\\SpriteLayers\\TopRightPanel.mdx"];

// The UI's design space is 0.8×0.6 (4:3). Both the sprite panels (mapped from their
// [0,1]² screen space) and the FDF menu letterbox to this centred box, so they align.
const UI_W = 0.8;
const UI_H = 0.6;

// Dolly the background eye this fraction toward its target (<1 = closer), tuned so the
// 4:3-authored icy scene frames like the original (tower size, ocean fills the base)
// while still filling a widescreen frame.
const MENU_CAM_ZOOM = 0.88;

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
interface MdxSequence { name: string }
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

const ViewerClass = ModelViewerCtor as unknown as { new (canvas: HTMLCanvasElement): Viewer };

export class MenuScene {
  private viewer: Viewer;
  private scene3d: Scene; // perspective background
  private scenePanel: Scene; // orthographic UI panels, composited over the background
  private solver: Solver;
  private bgModel: MdxModel | null = null;
  private instances: MdxInstance[] = [];
  private raf = 0;
  private last = 0;
  // Panel ortho tuning (window centre + half-size in the panel's [0,1] space); baked
  // after aligning the sprite panel's button slots to the FDF buttons in-browser (the
  // panel is posed by bone animation, so this can't be derived from its bind pose).
  panelCx = -0.1;
  panelCy = -0.185;
  panelHalf = 0.42;

  bgZoom = MENU_CAM_ZOOM;

  /** Live-tuning hooks: shift/scale the panel ortho or the background dolly, reframe. */
  tunePanel(cx: number, cy: number, half: number): void {
    this.panelCx = cx; this.panelCy = cy; this.panelHalf = half;
    this.frameCameras();
  }
  tuneBg(zoom: number): void { this.bgZoom = zoom; this.frameCameras(); }

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

    this.viewer = viewer;
    this.scene3d = scene3d;
    this.scenePanel = scenePanel;
  }

  /** Load the background scene + the sprite-layer panels and loop their idle clips. */
  async load(): Promise<void> {
    const tft = this.vfs.exists(TFT_MENU);
    const bgPath = tft ? TFT_MENU : ROC_MENU;
    const panelPaths = tft ? PANELS_TFT : PANELS_ROC;

    const bytes = await this.vfs.read(bgPath);
    const bg = (await this.viewer.load(bytes, this.solver)) as MdxModel | undefined;
    if (!bg) throw new Error(`failed to load menu scene: ${bgPath}`);
    this.bgModel = bg;
    this.addInstance(bg, this.scene3d, /^stand$/i);

    // The right/left panels: metal border, gears, the button panel and its chains.
    for (const path of panelPaths) {
      if (!this.vfs.exists(path)) continue;
      const model = (await this.viewer.load(await this.vfs.read(path), this.solver)) as MdxModel | undefined;
      if (model) this.addInstance(model, this.scenePanel, /^mainmenu stand$/i);
    }

    this.frameCameras();
    await this.viewer.whenAllLoaded();
  }

  private addInstance(model: MdxModel, scene: Scene, prefer: RegExp): void {
    const instance = model.addInstance();
    instance.setScene(scene);
    instance.setSequenceLoopMode(2); // always loop
    const idx = model.sequences.findIndex((s) => prefer.test(s.name));
    instance.setSequence(idx >= 0 ? idx : 0);
    this.instances.push(instance);
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
    for (const inst of this.instances) { try { this.scene3d.removeInstance(inst); this.scenePanel.removeInstance(inst); } catch { /* ignore */ } }
    this.instances = [];
    this.bgModel = null;
  }

  /** Frame the background with its own camera and the panels with an ortho projection
   *  mapping their [0,1]² screen space onto the centred 4:3 box (shared with the FDF). */
  private frameCameras(): void {
    if (!this.scene3d || !this.scenePanel) return; // not constructed yet
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;

    // Background: the model's authored camera, dollied in to fill a widescreen frame.
    const cam = this.bgModel?.cameras?.[0];
    if (cam) {
      this.scene3d.camera.perspective(cam.fieldOfView, w / h, cam.nearClippingPlane || 1, cam.farClippingPlane || 100000);
      const tgt = new Float32Array(cam.targetPosition as ArrayLike<number>);
      const z = this.bgZoom;
      const eye = new Float32Array([
        tgt[0] + (cam.position[0] - tgt[0]) * z,
        tgt[1] + (cam.position[1] - tgt[1]) * z,
        tgt[2] + (cam.position[2] - tgt[2]) * z,
      ]);
      this.scene3d.camera.moveToAndFace(eye, tgt, new Float32Array([0, 0, 1])); // Z up
    }
    this.scene3d.viewport.set([0, 0, w, h]);

    // Panels: ortho over [0,1]², rendered into the centred 4:3 sub-rect so the panel
    // slots line up with the FDF buttons (which letterbox to the same box).
    const scale = Math.min(w / UI_W, h / UI_H);
    const boxW = UI_W * scale;
    const boxH = UI_H * scale;
    const offX = (w - boxW) / 2;
    const offY = (h - boxH) / 2; // GL viewport y is from the bottom; the box is centred
    // Ortho window over the panel's [0,1] space; panelCx/Cy/Half align the animated
    // panel to the FDF buttons (the sprite panel is posed by bones, not its bind pose).
    const c = this.panelCx, cy = this.panelCy, hw = this.panelHalf;
    this.scenePanel.camera.ortho(c - hw, c + hw, cy - hw, cy + hw, 1, 2000);
    this.scenePanel.camera.moveToAndFace(
      new Float32Array([0.5, 0.5, 1000]),
      new Float32Array([0.5, 0.5, 0]),
      new Float32Array([0, 1, 0]),
    );
    this.scenePanel.viewport.set([offX, offY, boxW, boxH]);
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
