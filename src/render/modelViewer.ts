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

// How far to pedestal a portrait bust down, as a fraction of the eye→target
// distance. Small — just enough to seat the face lower in the console arch.
const PORTRAIT_PAN_DOWN = 0.08;

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
  private camPanLeft = 0; // >0 pans the portrait camera left (fraction of eye→target distance)
  private camPanDown = 0; // >0 pedestals the portrait camera down (fraction of eye→target distance)
  private idleSeq = -1; // the portrait's resting sequence (reverted to after talking)
  private talkSeq = -1; // the "Portrait Talk" sequence, or -1 if the model has none
  private talkRemaining = 0; // ms left playing the talk clip before reverting to idle

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
  async load(path: string, teamColor = 0, portrait = false, panLeft = 0): Promise<SequenceInfo[]> {
    // Portraits dolly the bust camera in a bit for a tighter close-up; panLeft
    // nudges it sideways for models whose authored camera crops the face.
    this.camZoom = portrait ? 0.78 : 1;
    this.camPanLeft = panLeft;
    // Nudge the bust down a touch so the face sits slightly lower in the frame
    // (the authored portrait cameras aim a hair high for our console arch).
    this.camPanDown = portrait ? PORTRAIT_PAN_DOWN : 0;
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
    // Remember the resting clip and the talking clip so a voice line can drive the
    // bust's mouth (names vary: "Portrait Talk", "Portrait Talk - 1", …).
    this.idleSeq = preferred?.index ?? -1;
    this.talkSeq = portrait ? sequences.find((s) => /portrait\s*talk/i.test(s.name))?.index ?? -1 : -1;
    this.talkRemaining = 0;

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

  /** Play the "Portrait Talk" clip for a voice line, then fall back to the resting
   *  clip after `durationSec`. Re-triggers cleanly if the unit speaks again while
   *  already talking (extends the window). No-op if the model has no talk clip. */
  playTalk(durationSec: number): void {
    if (this.talkSeq < 0 || !this.instance) return;
    if (this.talkRemaining <= 0) this.instance.setSequence(this.talkSeq);
    this.talkRemaining = Math.max(this.talkRemaining, durationSec * 1000);
  }

  start(): void {
    if (this.raf) return; // idempotent — never run two loops
    const frame = (t: number) => {
      const dt = this.last ? t - this.last : 1000 / 60;
      this.last = t;
      if (this.talkRemaining > 0) {
        this.talkRemaining -= dt;
        if (this.talkRemaining <= 0 && this.idleSeq >= 0) this.instance?.setSequence(this.idleSeq); // done talking → rest
      }
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
      const tgt = new Float32Array(cam.targetPosition as ArrayLike<number>);
      const eye = new Float32Array([
        tgt[0] + (cam.position[0] - tgt[0]) * this.camZoom,
        tgt[1] + (cam.position[1] - tgt[1]) * this.camZoom,
        tgt[2] + (cam.position[2] - tgt[2]) * this.camZoom,
      ]);
      // Pan the camera sideways (eye + target together) by a fraction of the
      // eye→target distance. "Left" is the horizontal axis perpendicular to the
      // view: for view dir (fx,fy) with Z up, left = (-fy, fx)·? → the +Z cross
      // of forward. Used to recentre a face the authored camera crops.
      if (this.camPanLeft) {
        const fx = tgt[0] - eye[0];
        const fy = tgt[1] - eye[1];
        const fz = tgt[2] - eye[2];
        const dist = Math.hypot(fx, fy, fz) || 1;
        // camera "left" = up × forward (up = +Z): (0,0,1)×(fx,fy,fz) = (-fy, fx, 0)
        const lx = -fy;
        const ly = fx;
        const ln = Math.hypot(lx, ly) || 1;
        const shift = this.camPanLeft * dist;
        const sx = (lx / ln) * shift;
        const sy = (ly / ln) * shift;
        eye[0] += sx; eye[1] += sy;
        tgt[0] += sx; tgt[1] += sy;
      }
      // Pedestal down: drop eye + target together along world -Z (WC3 up axis)
      // so the framing lowers without changing the view angle.
      if (this.camPanDown) {
        const dist = Math.hypot(tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]) || 1;
        const dz = this.camPanDown * dist;
        eye[2] -= dz;
        tgt[2] -= dz;
      }
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
