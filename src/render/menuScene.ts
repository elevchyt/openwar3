import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import type { DataSource } from "../vfs/types";

// The main-menu 3D background (issue #54 follow-up). WC3's menu is not a flat image
// but an animated MDX glue scene rendered behind the UI frames, with its own camera
// and looping "Stand" animation — for TFT that's the Icecrown ocean + frost wyrm +
// the rattling silver chains. We render the real model with mdx-m3-viewer (same
// approach as ModelViewerScene), using the model's authored camera so the framing
// matches the original. Nothing is shipped: the MDX + textures stream from the
// user's mounted install.
//
//   UI\Glues\MainMenu\MainMenu3D_Exp\MainMenu3D_Exp.mdx  — TFT (camera "Camera02good")
//   UI\Glues\MainMenu\MainMenu3d\MainMenu3d.mdx          — RoC (fallback)

const TFT_MENU = "UI\\Glues\\MainMenu\\MainMenu3D_Exp\\MainMenu3D_Exp.mdx";
const ROC_MENU = "UI\\Glues\\MainMenu\\MainMenu3d\\MainMenu3d.mdx";

// Dolly the eye this fraction of the way toward the target (<1 = closer), to keep
// the 4:3-authored scene filling a widescreen frame. Tuned against the live render.
const MENU_CAM_ZOOM = 0.82;

type Solver = (src: unknown) => unknown;
interface Camera {
  perspective(fov: number, aspect: number, near: number, far: number): void;
  moveToAndFace(from: Float32Array, to: Float32Array, up: Float32Array): void;
}
interface Scene {
  color: Float32Array;
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
  private scene: Scene;
  private solver: Solver;
  private model: MdxModel | null = null;
  private instance: MdxInstance | null = null;
  private raf = 0;
  private last = 0;

  constructor(private canvas: HTMLCanvasElement, private vfs: DataSource) {
    this.syncCanvasSize();
    const viewer = new ViewerClass(canvas);
    viewer.on("error", (e) => console.error("[menuscene]", e));
    this.solver = (src) => (typeof src === "string" ? this.vfs.read(src) : src);
    viewer.addHandler(mdxHandler, this.solver, false);
    viewer.addHandler(blpHandler);
    const scene = viewer.addScene();
    scene.color.set([0, 0, 0]); // icy scene sits over black, like the game's letterbox
    this.viewer = viewer;
    this.scene = scene;
  }

  /** Load the TFT menu scene (falling back to RoC), attach it, and loop "Stand". */
  async load(): Promise<void> {
    const path = this.vfs.exists(TFT_MENU) ? TFT_MENU : ROC_MENU;
    const bytes = await this.vfs.read(path);
    const model = (await this.viewer.load(bytes, this.solver)) as MdxModel | undefined;
    if (!model) throw new Error(`failed to load menu scene: ${path}`);
    this.model = model;

    const instance = model.addInstance();
    instance.setScene(this.scene);
    instance.setSequenceLoopMode(2); // always loop
    this.instance = instance;
    // "Stand" is the idle loop that animates the ocean, frost wyrm and chains.
    const stand = model.sequences.findIndex((s) => /^stand$/i.test(s.name));
    instance.setSequence(stand >= 0 ? stand : 0);

    this.frameCamera();
    await this.viewer.whenAllLoaded();
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
    if (this.instance) this.scene.removeInstance(this.instance);
    this.instance = null;
    this.model = null;
  }

  /** Frame with the model's own camera so the scene matches the original menu. The
   *  authored camera is composed for the game's 4:3 viewport; on a wider canvas the
   *  same vertical field would reveal empty space below the ocean, so we dolly the
   *  eye toward the target a touch to keep the icy scene filling the frame. */
  private frameCamera(): void {
    const cam = this.model?.cameras?.[0];
    if (!cam) return;
    this.scene.camera.perspective(cam.fieldOfView, this.aspect(), cam.nearClippingPlane || 1, cam.farClippingPlane || 100000);
    const tgt = new Float32Array(cam.targetPosition as ArrayLike<number>);
    const zoom = MENU_CAM_ZOOM;
    const eye = new Float32Array([
      tgt[0] + (cam.position[0] - tgt[0]) * zoom,
      tgt[1] + (cam.position[1] - tgt[1]) * zoom,
      tgt[2] + (cam.position[2] - tgt[2]) * zoom,
    ]);
    this.scene.camera.moveToAndFace(eye, tgt, new Float32Array([0, 0, 1])); // Z up
  }

  private aspect(): number {
    return this.canvas.clientHeight ? this.canvas.clientWidth / this.canvas.clientHeight : 16 / 9;
  }

  private syncCanvasSize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.frameCamera(); // aspect changed
    }
  }
}
