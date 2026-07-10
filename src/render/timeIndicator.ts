import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import MdlxModel from "mdx-m3-viewer/dist/cjs/parsers/mdlx/model";
import type { DataSource } from "../vfs/types";
import type { PlayableRace } from "../data/races";
import { MISC_DATA } from "../data/gameplayConstants";

// The top-bar day/night clock (issue #47). WC3 doesn't draw this widget out of a
// texture — it is a little MDX scene, one per race, named by UI\war3skins.txt's
// `TimeOfDayIndicator` key: UI\Console\<Race>\<Race>UI-TimeIndicator.mdx.
//
// Inside are the frame ring, a sun/moon orb on a bone that spins (KGRT), a star
// that flares at sunrise/sunset, and — the "white dots that fill up as the day/night
// progresses" from the issue — eight additive glow quads on bones "1".."8". Each dot's
// geoset-animation alpha is a STEP track that flips it on 1.5 game-hours further into
// the half-cycle than the last, and all eight blank at Dawn and Dusk. So the whole
// widget is already authored; it only has to be scrubbed to the right frame.
//
// The trick is that its "Stand" sequence is 60 000 ms long and maps onto a full
// 24-game-hour day, exactly like the DNC lighting models (see dayNight.ts): its keys
// land on 15 000 ms and 45 000 ms, i.e. MiscData.txt's Dawn (6) and Dusk (18). So we
// never let the sequence play at its own speed — we drive `frame` from the sim clock.
//
// (The models also carry a "Stand Alternate" clip, a violet-tinted variant. Nothing
// in the melee game selects it, so we always play "Stand".)

type Solver = (src: unknown) => unknown;

interface Camera {
  ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): void;
  moveToAndFace(from: Float32Array, to: Float32Array, up: Float32Array): void;
}
interface Scene {
  alpha: boolean;
  viewport: Float32Array;
  camera: Camera;
}
interface Instance {
  frame: number;
  setScene(scene: unknown): void;
  setSequence(index: number): void;
  setSequenceLoopMode(mode: number): void;
}
interface Model {
  sequences: Array<{ name: string; interval: ArrayLike<number> }>;
  addInstance(): Instance;
}
interface Viewer {
  gl: WebGLRenderingContext;
  on(event: string, cb: (e: unknown) => void): void;
  addHandler(handler: unknown, ...args: unknown[]): boolean;
  addScene(): Scene;
  load(src: unknown, solver?: Solver): Promise<unknown>;
  whenAllLoaded(): Promise<unknown>;
  update(dtMs: number): void;
  render(): void;
}

const ViewerClass = ModelViewerCtor as unknown as {
  new (canvas: HTMLCanvasElement, options?: WebGLContextAttributes): Viewer;
};

const RACE_DIR: Record<PlayableRace, string> = {
  human: "Human",
  orc: "Orc",
  undead: "Undead",
  nightelf: "NightElf",
};

/** `UI\war3skins.txt` [<Race>] TimeOfDayIndicator — the widget model for a race. */
export function timeIndicatorPath(race: PlayableRace): string {
  return `UI\\Console\\${RACE_DIR[race]}\\${RACE_DIR[race]}UI-TimeIndicator.mdx`;
}

/** Model-space box of the frame ring geoset — what the ortho camera is framed on.
 *  Padded so the sunrise flare and the glow behind the orb aren't clipped. */
const FRAME_PAD = 1.12;

export class TimeIndicatorClock {
  private viewer: Viewer;
  private scene: Scene;
  private solver: Solver;
  private instance: Instance | null = null;
  private interval: [number, number] = [0, 60000];
  /** Frame-quad aspect (width / height) — the host sizes the canvas to match. */
  aspect = 2;

  constructor(private canvas: HTMLCanvasElement, private vfs: DataSource) {
    // The canvas must have a nonzero backing size before addScene(), which reads it
    // for the default viewport. (The slot may not be laid out yet; render() resizes.)
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
    // alpha:true so the console art behind the medallion shows through. The default
    // premultiplied compositing is what makes the model's ADDITIVE layers (the dots,
    // the glows) read correctly over the page: they raise rgb while leaving alpha 0,
    // which is exactly "add me to whatever is behind".
    const viewer = new ViewerClass(canvas, { alpha: true });
    viewer.on("error", (e) => console.error("[timeindicator]", e));
    // WC3 draws this widget straight into its own framebuffer, where the glow quads
    // simply add light to the console art behind them. We draw it onto a transparent
    // canvas instead, and mdx-m3-viewer's layers only ever call gl.blendFunc(src, dst)
    // — so an ADDITIVE layer accumulates alpha as well as colour, the compositor reads
    // that as coverage, and the near-black glow texture paints a dark box over the map.
    // Shadow blendFunc on THIS context so no blended layer can write alpha: coverage
    // then comes only from the ring and orb, which disable blending, and the glows add
    // over whatever is behind the canvas. (The model has no plain-alpha-blend layers,
    // whose translucency this would otherwise flatten.)
    const gl = viewer.gl;
    gl.blendFunc = (src: number, dst: number) => gl.blendFuncSeparate(src, dst, gl.ZERO, gl.ONE);
    this.solver = (src) => (typeof src === "string" ? this.vfs.read(src) : src);
    viewer.addHandler(mdxHandler, this.solver, false);
    viewer.addHandler(blpHandler);
    const scene = viewer.addScene();
    scene.alpha = true; // we clear it ourselves, to transparent
    this.viewer = viewer;
    this.scene = scene;
  }

  /** Load the race's indicator model. Resolves false if the install can't supply it. */
  async load(race: PlayableRace): Promise<boolean> {
    const path = timeIndicatorPath(race);
    if (!this.vfs.exists(path)) return false;
    const bytes = await this.vfs.read(path);
    // The viewer's Geoset keeps only GL buffer offsets, so parse the MDX a second
    // time to measure the ring the camera frames on. It's a 30 KB widget.
    const mdlx = new MdlxModel();
    mdlx.load(bytes);
    const model = (await this.viewer.load(bytes, this.solver)) as Model | undefined;
    if (!model) return false;
    const stand = model.sequences.findIndex((s) => /^stand$/i.test(s.name));
    if (stand < 0) return false;
    const seq = model.sequences[stand];
    this.interval = [seq.interval[0], seq.interval[1]];

    const instance = model.addInstance();
    instance.setScene(this.scene);
    instance.setSequenceLoopMode(2);
    instance.setSequence(stand);
    this.instance = instance;
    this.frameCamera(mdlx);
    await this.viewer.whenAllLoaded();
    return true;
  }

  /** Draw the widget showing `hour` (game hours, [0, 24)). `dtMs` only advances the
   *  model's global sequences — the little glow pulse behind the orb, which runs in
   *  real time — while `frame` is pinned to the sim clock rather than played. */
  render(hour: number, dtMs: number): void {
    if (!this.instance) return;
    this.syncCanvasSize();
    const [start, end] = this.interval;
    const target = start + (hour / MISC_DATA.DayHours) * (end - start);
    // updateAnimations() adds dt to `frame` before it samples; pre-subtract so we
    // land exactly on `target` and never trip the loop-around at the interval end.
    this.instance.frame = target - dtMs;
    const gl = this.viewer.gl;
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.viewer.update(dtMs); // ModelViewer.update() takes milliseconds
    this.viewer.render();
  }

  /** Straight-on orthographic view of the widget: it is a flat billboard authored in
   *  the XY plane (frame ring at one depth, orb behind it, dots in front), so we look
   *  down -Z with +Y up rather than using a bounds-derived perspective camera. */
  private frameCamera(mdlx: MdlxModel): void {
    const frame = frameQuadExtent(mdlx);
    const cx = (frame.minX + frame.maxX) / 2;
    const cy = (frame.minY + frame.maxY) / 2;
    const halfW = ((frame.maxX - frame.minX) / 2) * FRAME_PAD;
    const halfH = ((frame.maxY - frame.minY) / 2) * FRAME_PAD;
    this.aspect = halfW / halfH;
    // The model spans well under one world unit; a generous near/far costs nothing.
    this.scene.camera.ortho(-halfW, halfW, -halfH, halfH, -100, 100);
    this.scene.camera.moveToAndFace(
      new Float32Array([cx, cy, 10]),
      new Float32Array([cx, cy, 0]),
      new Float32Array([0, 1, 0]),
    );
  }

  /** Release the widget's own WebGL context — browsers cap how many may be live,
   *  and a new HUD (and clock) is built for every map. */
  dispose(): void {
    this.instance = null;
    (this.viewer.gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
  }

  private syncCanvasSize(): void {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.scene.viewport[2] = w;
      this.scene.viewport[3] = h;
    }
  }
}

/** The XY box of the ring geoset — the widest flat quad in the model, which is the
 *  medallion frame the artist drew the console socket around. */
function frameQuadExtent(mdlx: MdlxModel): { minX: number; maxX: number; minY: number; maxY: number } {
  let best = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  let bestWidth = -1;
  for (const geoset of mdlx.geosets) {
    const v = geoset.vertices;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      minX = Math.min(minX, v[i]);
      maxX = Math.max(maxX, v[i]);
      minY = Math.min(minY, v[i + 1]);
      maxY = Math.max(maxY, v[i + 1]);
    }
    if (maxX - minX > bestWidth) {
      bestWidth = maxX - minX;
      best = { minX, maxX, minY, maxY };
    }
  }
  return best;
}
