import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import { LOAD_BAR_MODEL } from "../data/loadingScreens";
import { UI_HEIGHT, UI_WIDTH } from "../ui/fdf/layout";
import type { DataSource } from "../vfs/types";

// The loading screen's ART (issue #78) — the background and the load bar, both of them real
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
interface MdxInstance {
  /** The animation's playhead, in the model's own frame times. Writable — which is the whole
   *  of `LoadingScene.setProgress`; see there. */
  frame: number;
  setScene(scene: unknown): void;
  setSequence(index: number): void;
  setSequenceLoopMode(mode: number): void;
}
interface MdxModel {
  sequences: Array<{ name: string; interval: Int32Array | number[] }>;
  addInstance(): MdxInstance;
}

const ViewerClass = ModelViewerCtor as unknown as { new(canvas: HTMLCanvasElement): Viewer };

/** `setSequenceLoopMode(1)` — hold the last frame instead of wrapping. The load bar's clip must
 *  not restart from empty when the playhead reaches the end (mode 0 and 2 both wrap it). */
const HOLD_AT_END = 1;

export class LoadingScene {
  private viewer: Viewer;
  private scene: Scene;
  private solver: Solver;
  private instances: MdxInstance[] = [];
  /** The load bar, and the frame range of the clip that fills it — see `setProgress`. */
  private bar: { instance: MdxInstance; start: number; end: number } | null = null;
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
    const birth = barModel?.sequences.findIndex((s) => /^birth$/i.test(s.name)) ?? -1;
    if (barModel && birth >= 0) {
      const instance = this.add(barModel, birth, HOLD_AT_END);
      const seq = barModel.sequences[birth];
      this.bar = { instance, start: seq.interval[0], end: seq.interval[1] };
      this.setProgress(0);
    }

    this.frameCamera();
    await this.viewer.whenAllLoaded();
  }

  /**
   * How full the bar is, 0…1.
   *
   * **The progress IS the animation's playhead.** `LoadBar.mdx` fills itself: its
   * `Loading Bar Fill` and `Loading Bar Glow` bones each carry one `KGSC` scaling track with
   * exactly two keys — x 0.012 at frame 3333 and x 1.0 at frame 26800, linearly interpolated —
   * and those two frames are precisely the bounds of its "Birth" sequence. Both bones pivot at
   * x ≈ 0.1992, the fill quad's left edge, so the clip grows the bar rightwards from empty to
   * full and the engine's only job is to seek it.
   *
   * So we seek it rather than driving the bones ourselves. Poking `localScale` instead is
   * overwritten on the next update by the very track it was imitating, which showed as a bar
   * that ignored `setProgress` entirely and crept up over the clip's own 23.5 seconds.
   */
  setProgress(p: number): void {
    this.progress = Math.max(0, Math.min(1, p));
    this.seekBar();
  }

  /** Park the bar's playhead where the progress says. Re-applied every frame because
   *  `updateAnimations` advances it on its own, and a bar that crept would be lying. */
  private seekBar(): void {
    if (!this.bar) return;
    this.bar.instance.frame = this.bar.start + this.progress * (this.bar.end - this.bar.start);
  }

  start(): void {
    if (this.raf) return;
    const frame = (t: number): void => {
      const dt = this.last ? t - this.last : 1000 / 60;
      this.last = t;
      this.syncCanvasSize();
      this.seekBar();
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

  private add(model: MdxModel, sequence: number, loopMode = 2): MdxInstance {
    const instance = model.addInstance();
    instance.setScene(this.scene);
    // Backgrounds loop (a load can outlast any of these clips, and a campaign background's
    // location marker is keyed to its own); the bar holds, because it is seeked, not played.
    instance.setSequenceLoopMode(loopMode);
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
