import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import { LOAD_BAR_MODEL } from "../data/loadingScreens";
import { UI_HEIGHT, UI_WIDTH } from "../ui/fdf/layout";
import type { DataSource } from "../vfs/types";

// The loading screen's ART (issue #110) — the background and the load bar, both of them real
// MDX read out of the player's install.
//
// This is NOT a 3D scene, and that is the whole reason it is not `MenuScene.showBackdrop`.
// Dumped from the archives, every loading model — the four multiplayer ones, the generic one,
// each campaign background, the load bar — is a handful of flat quads with **no camera**,
// authored directly in the FDF's own 0.8 × 0.6 UI coordinate space (`Load-Multiplayer-Orc.mdx`
// spans exactly x 0…0.8, y 0…0.59999). So there is nothing to frame: an orthographic window
// over that box IS the authored composition, and the screen's DOM (ui/loadingScreen.ts) lays
// itself out in the same coordinates and lands on the art by construction.
//
// The box is STRETCHED to the viewport rather than pillarboxed — the FDF's `Loading` frame is
// `SetAllPoints` and its background sprite with it, so on a wide screen the picture widens.
// Measured against the reference shot: the load bar's authored x 0.1985…0.6273 lands at 24.8%
// …78.4% of the screen width, which is where it sits in the real client at 16:10.

/** Which background to put up, and which of its clips to play. */
export interface LoadingBackground {
  /** The model's path in the archives. */
  path: string;
  /**
   * Which sequence to play. A CAMPAIGN background carries one clip per chapter (the number
   * comes out of `[LoadingScreens]`, see data/loadingScreens.ts); the multiplayer and generic
   * screens carry a single "Birth" and this is 0 for them.
   */
  sequence: number;
}

type Solver = (src: unknown) => unknown;
interface Camera {
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
/** The one piece of a SkeletalNode we touch — see `setProgress`. */
interface SkeletalNode {
  localScale: Float32Array;
  recalculateTransformation(instance: unknown): void;
}
interface MdxInstance {
  nodes: SkeletalNode[];
  setScene(scene: unknown): void;
  setSequence(index: number): void;
  setSequenceLoopMode(mode: number): void;
  updateBoneTexture(): void;
}
interface MdxModel {
  sequences: Array<{ name: string; interval: Int32Array | number[] }>;
  bones: Array<{ name: string }>;
  addInstance(): MdxInstance;
}

const ViewerClass = ModelViewerCtor as unknown as { new(canvas: HTMLCanvasElement): Viewer };

/** The two bones the ENGINE drives on `LoadBar.mdx`. Neither carries a single animation
 *  track in the file — the fill and its halo simply sit at full width in the bind pose — so
 *  the bar's whole behaviour is the engine scaling them, and that is what `setProgress` does.
 *  Both pivot at x ≈ 0.1992, the fill quad's LEFT edge, so an x scale of `p` fills the bar to
 *  `p` and grows rightwards exactly as the reference's does. */
const FILL_BONE = "Loading Bar Fill";
const GLOW_BONE = "Loading Bar Glow";

export class LoadingScene {
  private viewer: Viewer;
  private scene: Scene;
  private solver: Solver;
  private instances: MdxInstance[] = [];
  private bar: { model: MdxModel; instance: MdxInstance } | null = null;
  private raf = 0;
  private last = 0;
  private progress = 0;

  constructor(private canvas: HTMLCanvasElement, private vfs: DataSource) {
    canvas.width = canvas.clientWidth || window.innerWidth;
    canvas.height = canvas.clientHeight || window.innerHeight;
    const viewer = new ViewerClass(canvas);
    viewer.on("error", (e) => console.error("[loadingscene]", e));
    this.solver = (src) => (typeof src === "string" ? this.vfs.read(src) : src);
    viewer.addHandler(mdxHandler, this.solver, false);
    viewer.addHandler(blpHandler);

    const scene = viewer.addScene();
    scene.alpha = false; // the loading screen is the whole picture; nothing shows behind it
    scene.color.set([0, 0, 0]);
    this.viewer = viewer;
    this.scene = scene;
  }

  /** Put `background` up, with the load bar over it. Resolves once both are decoded, so the
   *  caller can reveal the screen with its art already on it rather than on a black frame. */
  async load(background: LoadingBackground): Promise<void> {
    const bg = await this.model(background.path);
    // A campaign background's clip is chosen by NUMBER, not by name — one model serves a whole
    // campaign and `[LoadingScreens]` says which of its clips is this chapter's.
    if (bg) this.add(bg, Math.min(background.sequence, bg.sequences.length - 1));

    const barModel = await this.model(LOAD_BAR_MODEL);
    if (barModel) {
      // The bar arrives on its own "Birth" and settles into the looping "Stand" underneath —
      // the same two-step every glue model in the game arrives with. Both clips leave the fill
      // bone alone, so the progress we set below survives them.
      const instance = this.add(barModel, 0);
      this.bar = { model: barModel, instance };
      this.setProgress(0);
    }

    this.frameCamera();
    await this.viewer.whenAllLoaded();
  }

  /**
   * How full the bar is, 0…1.
   *
   * Poking a bone rather than playing a clip is not a shortcut — it is what the model asks
   * for. `LoadBar.mdx` has no keyframes anywhere (verified against the file), so the fill and
   * its glow are static geometry whose only motion can come from outside; the engine's own
   * loading bar works the same way. mdx-m3-viewer re-samples a node's local transform each
   * frame ONLY when the sequence has a track for it, so a bone with no tracks keeps whatever
   * we write here for as long as the instance lives.
   */
  setProgress(p: number): void {
    this.progress = Math.max(0, Math.min(1, p));
    const bar = this.bar;
    if (!bar) return;
    for (const name of [FILL_BONE, GLOW_BONE]) {
      // `instance.nodes` is indexed by `model.genericObjects`, and bones come first in that
      // list — so a bone's index IS its node's.
      const i = bar.model.bones.findIndex((b) => b.name === name);
      const node = i >= 0 ? bar.instance.nodes[i] : undefined;
      if (!node) continue;
      node.localScale[0] = this.progress;
      node.recalculateTransformation(bar.instance);
    }
    // …and push the new matrices at the GPU now. The next update won't: it only re-uploads
    // after re-sampling nodes, and these two have nothing to re-sample.
    bar.instance.updateBoneTexture();
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
    for (const inst of this.instances) {
      try { this.scene.removeInstance(inst); } catch { /* already gone */ }
    }
    this.instances = [];
    this.bar = null;
  }

  private async model(path: string): Promise<MdxModel | null> {
    if (!this.vfs.exists(path)) return null;
    try {
      return (await this.viewer.load(await this.vfs.read(path), this.solver)) as MdxModel ?? null;
    } catch (err) {
      console.warn(`[OpenWar3] loading screen art unavailable: ${path}`, err);
      return null;
    }
  }

  private add(model: MdxModel, sequence: number): MdxInstance {
    const instance = model.addInstance();
    instance.setScene(this.scene);
    instance.setSequenceLoopMode(2); // loop — a load can outlast any of these clips
    instance.setSequence(Math.max(0, sequence));
    this.instances.push(instance);
    return instance;
  }

  /** The authored 0.8 × 0.6 box, stretched over the whole canvas (see the file header). */
  private frameCamera(): void {
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;
    // The ortho window is the camera's OWN frustum — it is measured from where the eye is,
    // not in world coordinates — so it is the box's half-extents around a centred eye. Given
    // world bounds instead, the view lands one half-box up and to the right of the picture,
    // which shows as three quarters of a black screen and the art's top-right corner in the
    // bottom-left of it.
    this.scene.camera.ortho(-UI_WIDTH / 2, UI_WIDTH / 2, -UI_HEIGHT / 2, UI_HEIGHT / 2, 1, 2000);
    this.scene.camera.moveToAndFace(
      new Float32Array([UI_WIDTH / 2, UI_HEIGHT / 2, 1000]),
      new Float32Array([UI_WIDTH / 2, UI_HEIGHT / 2, 0]),
      new Float32Array([0, 1, 0]),
    );
    this.scene.viewport.set([0, 0, w, h]);
  }

  private syncCanvasSize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.frameCamera();
    }
  }
}
