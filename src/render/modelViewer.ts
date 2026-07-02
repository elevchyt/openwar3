import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import type { DataSource } from "../vfs/types";

// Phase 3: render real animated MDX (v800) models using mdx-m3-viewer's own
// WebGL renderer (plan §1.1 — borrow the renderer behind a thin interface). The
// viewer owns its own WebGL1 context, so this uses a dedicated canvas separate
// from the Phase 2 terrain scene. Textures + team color resolve through our VFS.
//
// mdx-m3-viewer's exported types drag in their own gl-matrix identity, so we type
// only the small surface we touch locally and cast the imports.

type Solver = (src: unknown) => unknown;

interface Camera {
  perspective(fov: number, aspect: number, near: number, far: number): void;
  moveToAndFace(from: Float32Array, to: Float32Array, up: Float32Array): void;
}
interface Scene {
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
interface MdxSequence { name: string; }
interface MdxInstance {
  setScene(scene: unknown): void;
  setSequence(index: number): void;
  setSequenceLoopMode(mode: number): void;
  setTeamColor(id: number): void;
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
  bounds: { x: number; y: number; z: number; r: number };
  addInstance(): MdxInstance;
}

const ViewerClass = ModelViewerCtor as unknown as { new (canvas: HTMLCanvasElement): Viewer };

export interface SequenceInfo {
  index: number;
  name: string;
}

export class ModelViewerScene {
  private viewer: Viewer;
  private scene: Scene;
  private solver: Solver;
  private model: MdxModel | null = null;
  private instance: MdxInstance | null = null;
  private raf = 0;
  private last = 0;
  private camZoom = 1; // <1 dollies the model camera closer (portraits zoom in)

  constructor(private canvas: HTMLCanvasElement, private vfs: DataSource) {
    // Canvas must have a nonzero size before addScene() (viewport/aspect read here).
    this.syncCanvasSize();

    const viewer = new ViewerClass(canvas);
    viewer.on("error", (e) => console.error("[modelviewer]", e));

    // pathSolver: bytes pass through; string (backslash WC3) paths resolve from
    // the VFS. A Promise return is supported; a miss rejects and the viewer drops
    // that texture (fire-and-forget) without aborting the model.
    this.solver = (src) => (typeof src === "string" ? this.vfs.read(src) : src);

    viewer.addHandler(mdxHandler, this.solver, false); // also loads team-color textures
    viewer.addHandler(blpHandler);

    const scene = viewer.addScene();
    scene.color.set([0.1, 0.11, 0.14]);

    this.viewer = viewer;
    this.scene = scene;
  }

  /** Load an MDX by VFS path, attach an instance, and play idle/walk (or the
   *  "Portrait" idle clip when `portrait` is set — portrait busts have no
   *  walk/stand, and a stray Walk clip on some models otherwise wins). */
  async load(path: string, teamColor = 0, portrait = false): Promise<SequenceInfo[]> {
    // Portraits dolly the bust camera in a bit for a tighter close-up.
    this.camZoom = portrait ? 0.78 : 1;
    const bytes = await this.vfs.read(path);

    if (this.instance) {
      this.scene.removeInstance(this.instance);
      this.instance = null;
    }

    const model = (await this.viewer.load(bytes, this.solver)) as MdxModel | undefined;
    if (!model) throw new Error(`failed to load model: ${path}`);
    this.model = model;

    const instance = model.addInstance();
    instance.setScene(this.scene);
    instance.setSequenceLoopMode(2); // always loop
    instance.setTeamColor(teamColor);
    this.instance = instance;

    const sequences = this.sequences();
    const preferred = portrait
      ? sequences.find((s) => /^portrait/i.test(s.name) && !/talk/i.test(s.name)) ??
        sequences.find((s) => /portrait/i.test(s.name)) ??
        sequences[0]
      : sequences.find((s) => /walk/i.test(s.name)) ??
        sequences.find((s) => /stand/i.test(s.name)) ??
        sequences[0];
    if (preferred) instance.setSequence(preferred.index);

    this.frameCamera();
    await this.viewer.whenAllLoaded(); // wait for textures so it isn't untextured
    return sequences;
  }

  sequences(): SequenceInfo[] {
    return (this.model?.sequences ?? []).map((s, index) => ({ index, name: s.name }));
  }

  setSequence(index: number): void {
    this.instance?.setSequence(index);
  }

  start(): void {
    if (this.raf) return; // idempotent — never run two loops
    const frame = (t: number) => {
      const dt = this.last ? t - this.last : 1000 / 60;
      this.last = t;
      this.syncCanvasSize();
      this.viewer.updateAndRender(dt); // dt in milliseconds
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0; // fresh dt on resume
  }

  private frameCamera(): void {
    if (!this.model) return;
    // Portrait (and many unit) models ship their own camera aimed at the face —
    // using it gives the authentic close-up instead of a distant bounds view.
    const cam = this.model.cameras?.[0];
    if (cam) {
      this.scene.camera.perspective(cam.fieldOfView, this.aspect(), cam.nearClippingPlane || 1, cam.farClippingPlane || 10000);
      // Dolly the eye toward the target by camZoom (<1 = closer) for the portrait
      // close-up, keeping the model's authored framing/angle.
      const tgt = cam.targetPosition;
      const eye = new Float32Array([
        tgt[0] + (cam.position[0] - tgt[0]) * this.camZoom,
        tgt[1] + (cam.position[1] - tgt[1]) * this.camZoom,
        tgt[2] + (cam.position[2] - tgt[2]) * this.camZoom,
      ]);
      this.scene.camera.moveToAndFace(eye, tgt, new Float32Array([0, 0, 1]));
      return;
    }
    const b = this.model.bounds;
    const r = Math.max(b.r, 1);
    const to = new Float32Array([b.x, b.y, b.z]);
    const from = new Float32Array([b.x + r * 2.5, b.y - r * 2.5, b.z + r * 1.5]);
    this.scene.camera.perspective(Math.PI / 4, this.aspect(), 1, r * 20);
    this.scene.camera.moveToAndFace(from, to, new Float32Array([0, 0, 1])); // WC3 is Z-up
  }

  private aspect(): number {
    return this.canvas.width / this.canvas.height || 1;
  }

  private syncCanvasSize(): void {
    const w = Math.floor(this.canvas.clientWidth * devicePixelRatio) || 800;
    const h = Math.floor(this.canvas.clientHeight * devicePixelRatio) || 600;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      if (this.scene) {
        this.scene.viewport[2] = w;
        this.scene.viewport[3] = h;
        this.frameCamera();
      }
    }
  }
}
