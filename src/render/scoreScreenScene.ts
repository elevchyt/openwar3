import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import { UI_HEIGHT, UI_WIDTH } from "../ui/fdf/layout";
import type { DataSource } from "../vfs/types";

// The SCORE SCREEN's art (issue #199) — every piece of it a real MDX out of the player's install,
// named by `UI\FrameDef\Glue\ScoreScreen.fdf`'s own MODEL frames and by `UI\war3skins.txt`.
//
// It is the loading screen's kind of art (render/loadingScene.ts), not the menu's: dumped from the
// archives, every model here is a handful of flat quads with NO camera, authored directly in the
// FDF's 0.8 × 0.6 UI box, so an orthographic window over that box IS the composition —
//
//   ScoreScreen-Background   the parchment, x 0…0.8 × y 0…0.6, z 0, with the column-header strip
//                            (`scorescreen-background-sort4.blp`) at y 0.4907…0.5233, z 0.19.
//                            Two clips: `Scorescreen-5Button` and `Scorescreen-4Button` — the
//                            header boxes are PAINTED, and the clip picks which layout is painted.
//   ScoreScreen-Tabs         the four tab flaps across the top (z 0.2005), one clip per selected
//                            tab, `Tab1`…`Tab5`.
//   ScoreScreen-TopBar       ONE player's row, 0.7383 × 0.0373 at the origin (z 0.217…0.231): the
//                            name plate and the strip, tinted by a geoset COLOUR track that has one
//                            key per clip — `TeamColor00 Stand` … `TeamColor23 Stand` — so the clip
//                            IS the player colour. The FDF places the first at TOPLEFT −0.11; the
//                            engine stamps the rest below it.
//   the race art             `ScoreScreenVictory_V0/_V1` per race, `ScoreScreenDefeat`, one quad at
//                            x 0.337…0.737 × y 0.047…0.447, z 0.123 — UNDER the rows and the header.
//
// The z values are the models' own; with the camera looking down −z, they are what puts the
// strips over the picture and the picture over the parchment, with nothing to sort by hand.

type Solver = (src: unknown) => unknown;
interface Camera {
  ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): void;
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
interface MdxInstance {
  setScene(scene: unknown): void;
  setSequence(index: number): void;
  setSequenceLoopMode(mode: number): void;
  setLocation(location: Float32Array | number[]): void;
  hide(): void;
  show(): void;
}
interface MdxModel {
  sequences: Array<{ name: string }>;
  addInstance(): MdxInstance;
}

const ViewerClass = ModelViewerCtor as unknown as {
  new(canvas: HTMLCanvasElement, options?: WebGLContextAttributes): Viewer;
};

const BACKGROUND = "UI\\Glues\\ScoreScreen\\ScoreScreen-Background\\ScoreScreen-Background.mdl";
const TABS = "UI\\Glues\\ScoreScreen\\ScoreScreen-Tabs\\ScoreScreen-Tabs.mdl";
const TOP_BAR = "UI\\Glues\\ScoreScreen\\ScoreScreen-TopBar\\ScoreScreen-TopBar.mdl";

/** `setSequenceLoopMode(2)` — always loop. Every clip here is a still held for a third of a
 *  second; looping it is what keeps it on screen. */
const LOOP = 2;

/**
 * How far each row's bar is moved TOWARD the camera, in world units. The models' own z puts the
 * strips (0.217…) over the race art (0.123), but the viewer does not draw by vertex z: it sorts
 * INSTANCES by their location's distance to the near plane and draws translucent layers back to
 * front, and with every instance sitting at z 0 that is a tie — which the art won, painting the
 * victory picture over the coloured strips while the DOM figures stayed on top. Lifting the bars
 * breaks the tie in the authored order; under the orthographic camera it moves nothing on screen.
 */
const BAR_LIFT = 0.01;

/** One player row's place and colour. */
export interface ScoreBar {
  /** World y of the bar's BOTTOM edge, in the 0.8 × 0.6 box (y up). */
  y: number;
  /** Which `TeamColorNN Stand` clip — the player-colour index, 0…23. */
  color: number;
}

export class ScoreScreenScene {
  private viewer: Viewer;
  private scene: Scene;
  private solver: Solver;
  private raf = 0;
  private last = 0;
  private background: { model: MdxModel; instance: MdxInstance } | null = null;
  private tabs: { model: MdxModel; instance: MdxInstance } | null = null;
  private barModel: MdxModel | null = null;
  private bars: MdxInstance[] = [];
  private art: MdxInstance | null = null;

  constructor(private canvas: HTMLCanvasElement, private vfs: DataSource) {
    canvas.width = canvas.clientWidth || window.innerWidth;
    canvas.height = canvas.clientHeight || window.innerHeight;
    const viewer = new ViewerClass(canvas);
    viewer.on("error", (e) => console.error("[scorescreen]", e));
    this.solver = (src) => (typeof src === "string" ? this.vfs.read(src) : src);
    viewer.addHandler(mdxHandler, this.solver, false);
    viewer.addHandler(blpHandler);
    const scene = viewer.addScene();
    scene.color.set([0, 0, 0]);
    this.viewer = viewer;
    this.scene = scene;
  }

  /** Put the parchment, the tabs and the race art up. Resolves once all of it is decoded, so the
   *  screen arrives as a finished picture rather than filling in over a black frame. */
  async load(raceArt: string | null): Promise<void> {
    const bg = await this.model(BACKGROUND);
    if (bg) this.background = { model: bg, instance: this.add(bg, 0) };
    const tabs = await this.model(TABS);
    if (tabs) this.tabs = { model: tabs, instance: this.add(tabs, 0) };
    this.barModel = await this.model(TOP_BAR);
    const art = raceArt ? await this.model(raceArt) : null;
    if (art) this.art = this.add(art, 0);
    this.frameCamera();
    await this.viewer.whenAllLoaded();
  }

  /**
   * Which tab is up (0…3) and whether its header strip is the four- or the five-box one. The
   * tabs model's clips are `Tab1`… by NAME, and so are the background's; asked by name so a
   * reordered model still lands on the right one.
   */
  setTab(tab: number, columns: 4 | 5): void {
    if (this.tabs) this.play(this.tabs, new RegExp(`^tab${tab + 1}$`, "i"));
    if (this.background) this.play(this.background, new RegExp(`${columns}button`, "i"));
  }

  /** One `ScoreScreen-TopBar` per row, each moved down to its place and playing its colour. */
  setBars(bars: readonly ScoreBar[]): void {
    for (const inst of this.bars) {
      try { this.scene.removeInstance(inst); } catch { /* already gone */ }
    }
    this.bars = [];
    const model = this.barModel;
    if (!model) return;
    for (const bar of bars) {
      const inst = this.add(model, 0);
      // The clips are named `TeamColor00 Stand`…, and colour 13 is the one sitting at 7000 rather
      // than 6500 — the indices are by NAME, never by the clip's position in the list.
      const want = `teamcolor${String(bar.color).padStart(2, "0")}`;
      const seq = model.sequences.findIndex((s) => s.name.toLowerCase().startsWith(want));
      inst.setSequence(Math.max(0, seq));
      inst.setLocation([0, bar.y, BAR_LIFT]);
      this.bars.push(inst);
    }
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
    const all = [this.background?.instance, this.tabs?.instance, this.art, ...this.bars];
    for (const inst of all) {
      if (!inst) continue;
      try { this.scene.removeInstance(inst); } catch { /* already gone */ }
    }
    this.background = this.tabs = null;
    this.art = null;
    this.bars = [];
  }

  private play(entry: { model: MdxModel; instance: MdxInstance }, name: RegExp): void {
    const seq = entry.model.sequences.findIndex((s) => name.test(s.name));
    if (seq >= 0) entry.instance.setSequence(seq);
  }

  private async model(path: string): Promise<MdxModel | null> {
    // The FDF and war3skins name `.mdl`; the archives hold the binary `.mdx` twin.
    const mdx = path.replace(/\.mdl$/i, ".mdx");
    if (!this.vfs.exists(mdx)) return null;
    try {
      return (await this.viewer.load(await this.vfs.read(mdx), this.solver)) as MdxModel ?? null;
    } catch (err) {
      console.warn(`[OpenWar3] score screen art unavailable: ${mdx}`, err);
      return null;
    }
  }

  private add(model: MdxModel, sequence: number): MdxInstance {
    const instance = model.addInstance();
    instance.setScene(this.scene);
    instance.setSequenceLoopMode(LOOP);
    instance.setSequence(sequence);
    return instance;
  }

  /** The authored 0.8 × 0.6 box, stretched over the whole canvas — the FDF's root and every
   *  model in it are `SetAllPoints`, exactly as the loading screen's are. */
  private frameCamera(): void {
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;
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
