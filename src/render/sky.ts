// The SKY — `SetSkyModel` ("Environment - Set Sky", UI\TriggerData.txt), the one piece of the world
// a script picks that is drawn around the EYE rather than placed in the world.
//
// What the install says about it, and so what this does:
//
//   * There is no sky by default. The GUI action's default is `SkyModelNone` (a null string,
//     TriggerData.txt `_SetSkyModel_Defaults`) and no melee init sets one, so a map that never
//     calls the native shows what lies past the terrain as black — Test of Balance does.
//   * A sky is an ordinary MDX: the 14 the editor offers are `Environment\Sky\<Name>\<Name>.mdl`
//     (`SkyModelSky01`…`SkyModelSky14`), each a sphere 3–4 thousand units across with one looping
//     `Stand` clip, and most of its layers flagged "no depth test / no depth set"
//     (`BlizzardSky`: flags 209 = unshaded, two-sided, NoDepthTest, NoDepthSet). A sphere that
//     neither tests nor writes depth can only be drawn one way: FIRST, around the camera, with
//     the world drawn over it. That is what `renderBehind` does.
//   * `SkyLight.mdl` is the exception — its streak layers are plain additive layers that DO
//     write depth — which is why the depth buffer is cleared after the sky: a sphere around the
//     eye is nearer than the far terrain, and its depth would otherwise hide the ground behind it.
//
// Its own Scene, sharing the world's CAMERA and VIEWPORT, is what keeps it out of the world's
// passes (and out of the world's distance fog and day/night lighting, which a sky is not in).

interface SkyCamera {
  location: Float32Array;
}
interface SkyInstance {
  setScene(scene: SkyScene): void;
  setLocation(v: ArrayLike<number>): void;
  setSequence(i: number): void;
  setSequenceLoopMode(mode: number): void;
  detach(): void;
}
interface SkyModel {
  addInstance(): SkyInstance;
}
interface SkyScene {
  camera: unknown;
  viewport: unknown;
  alpha: boolean;
  startFrame(): void;
  renderOpaque(): void;
  renderTranslucent(): void;
}
export interface SkyViewer {
  gl: WebGLRenderingContext;
  scenes: unknown[];
  addScene(): SkyScene;
  removeScene(scene: unknown): boolean;
  load(src: unknown, solver: unknown): Promise<unknown>;
}

/** A sky path as a script (or the editor) spells it → the file the solver can load. The
 *  editor's list writes `.mdl`; every model in the install is `.mdx`. "" (or none) → no sky. */
export function skyModelPath(path: string): string {
  const p = path.trim();
  return p ? p.replace(/\//g, "\\").replace(/\.mdl$/i, ".mdx") : "";
}

export class SkyDome {
  private scene: SkyScene;
  private instance: SkyInstance | null = null;
  /** The path asked for last — a load that finishes after a newer request is dropped. */
  private want = "";

  constructor(private viewer: SkyViewer, private solver: unknown, world: { camera: unknown; viewport: unknown }) {
    this.scene = viewer.addScene();
    // FIRST in the viewer's list, so even the viewer's own all-in-one render (the frames before
    // the map is ready) would draw it behind the world rather than over it.
    const i = viewer.scenes.indexOf(this.scene);
    if (i > 0) {
      viewer.scenes.splice(i, 1);
      viewer.scenes.unshift(this.scene);
    }
    this.scene.alpha = true; // never clear: the world's own startFrame does that
    this.scene.camera = world.camera;
    this.scene.viewport = world.viewport;
  }

  /** SetSkyModel: this model around the eye from now on, or none for "". */
  async setModel(path: string): Promise<void> {
    const file = skyModelPath(path);
    this.want = file;
    this.instance?.detach();
    this.instance = null;
    if (!file) return;
    const model = (await this.viewer.load(file, this.solver).catch(() => undefined)) as SkyModel | undefined;
    if (!model || this.want !== file) return; // a missing sky is no sky; a stale load is dropped
    const inst = model.addInstance();
    inst.setScene(this.scene);
    inst.setSequence(0);
    inst.setSequenceLoopMode(2); // always loop the one Stand clip
    this.instance = inst;
  }

  /** Centre the sky on the eye — called after the camera moves and BEFORE the scene update, so
   *  the sphere is never a frame behind the eye it surrounds. */
  follow(camera: SkyCamera): void {
    this.instance?.setLocation(camera.location);
  }

  get active(): boolean {
    return this.instance !== null;
  }

  /** Draw it behind everything: after the world's startFrame has cleared the frame, before the
   *  ground. Clears depth afterwards (see the header). */
  renderBehind(): void {
    if (!this.instance) return;
    this.scene.startFrame(); // viewport + scissor; `alpha` keeps it from clearing
    this.scene.renderOpaque();
    this.scene.renderTranslucent();
    const gl = this.viewer.gl;
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  dispose(): void {
    this.instance?.detach();
    this.instance = null;
    this.viewer.removeScene(this.scene);
  }
}
