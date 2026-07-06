// Debug collider overlay — a toggled GL pass that draws the game's invisible collision
// shapes so they can be eyeballed: unit CLICK/selection radii, PATHING obstruction cells
// (building/tree/mine footprints), and FOG-OF-WAR LOS-blocker cells (treelines). Driven
// from mapViewer, which rebuilds the geometry each frame from the live grid/vision/units.
//
// Like FogOverlay, this is our OWN GL pass drawn after viewer.render(), so it must save &
// restore every GL state it touches — mdx-m3-viewer caches GL state JS-side and will draw
// the next frame with our shader if we leave the program/attribs dirty (see FogOverlay).

const VERT_SRC = `
attribute vec3 aPos;
attribute vec4 aColor;
uniform mat4 uViewProj;
varying vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec4 vColor;
void main() { gl_FragColor = vColor; }`;

type GL = WebGLRenderingContext;

/** RGBA colours for each collider class (also drives the DOM legend). */
export const COLLIDER_COLORS = {
  click: [0.25, 1.0, 0.45, 0.9] as const, // green — selection / click radius
  pathing: [1.0, 0.28, 0.2, 0.32] as const, // red — pathing/movement obstruction
  vision: [0.3, 0.65, 1.0, 0.32] as const, // blue — fog-of-war LOS blocker
  // "Show Pathing" overlay palette.
  grid: [0.55, 0.62, 0.72, 0.35] as const, // faint grey — the pathing-cell lattice
  blocked: [1.0, 0.25, 0.2, 0.22] as const, // red — an unwalkable cell (filled)
  path: [1.0, 0.85, 0.2, 0.95] as const, // bright yellow — a unit's remaining route
  // Building-placement footprint grid (mirrors the pathing-obstruction collider).
  buildable: [0.25, 1.0, 0.4, 0.5] as const, // green — a footprint cell clear to build on
  unbuildable: [1.0, 0.2, 0.15, 0.6] as const, // red — a footprint cell obstructed by the grid
};

export const FLOATS_PER_VERT = 7; // x,y,z, r,g,b,a

/** One draw batch: interleaved [x,y,z,r,g,b,a] verts drawn as triangles or lines. */
export interface ColliderBatch {
  data: Float32Array;
  verts: number;
  mode: "tri" | "line";
}

/** A persistent GPU buffer for one overlay batch: upload its geometry ONCE (or only
 *  when it changes) with set(), then draw it many frames via DebugColliders.render-
 *  Layers WITHOUT re-uploading. This is the fix for large static overlays — the
 *  pathing grid lattice + blocked cells are >1M verts each and re-uploading them
 *  every frame (as ColliderBatch does) melts the framerate. */
export class OverlayLayer {
  private buf: WebGLBuffer;
  verts = 0;
  constructor(private gl: GL, readonly mode: "tri" | "line", private dynamic = false) {
    this.buf = gl.createBuffer()!;
  }
  /** Upload interleaved [x,y,z,r,g,b,a] verts. Call only when the geometry changes
   *  (static layers: once; the per-frame route layer: constructed with dynamic=true). */
  set(data: Float32Array, verts: number): void {
    this.verts = verts;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buf);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      data.subarray(0, verts * FLOATS_PER_VERT),
      this.dynamic ? this.gl.DYNAMIC_DRAW : this.gl.STATIC_DRAW,
    );
  }
  buffer(): WebGLBuffer {
    return this.buf;
  }
  dispose(): void {
    this.gl.deleteBuffer(this.buf);
  }
}

/** Snapshot of the GL state DebugColliders touches, so it can be restored (mdx-m3-
 *  viewer caches state JS-side and will draw the next frame with our program/attribs
 *  if we leave them dirty). */
interface SavedGLState {
  program: WebGLProgram | null;
  arrayBuf: WebGLBuffer | null;
  blend: boolean;
  depthTest: boolean;
  cull: boolean;
  blendSrcRGB: number;
  blendDstRGB: number;
  blendSrcA: number;
  blendDstA: number;
  attribs: boolean[];
}

export class DebugColliders {
  private gl: GL;
  private program: WebGLProgram;
  private buf: WebGLBuffer;
  private aPos: number;
  private aColor: number;
  private uViewProj: WebGLUniformLocation;
  private maxAttribs: number;

  constructor(gl: GL) {
    this.gl = gl;
    this.maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
    this.program = compileProgram(gl, VERT_SRC, FRAG_SRC);
    this.aPos = gl.getAttribLocation(this.program, "aPos");
    this.aColor = gl.getAttribLocation(this.program, "aColor");
    this.uViewProj = gl.getUniformLocation(this.program, "uViewProj")!;
    this.buf = gl.createBuffer()!;
  }

  /** Draw a list of triangle/line batches (interleaved [x,y,z,r,g,b,a]) in one GL
   *  state save/restore, re-uploading each batch's data. For small, changes-every-
   *  frame geometry (the collider overlay's rings). Large static geometry should use
   *  a persistent OverlayLayer + renderLayers() instead. */
  render(viewProj: Float32Array | Iterable<number>, batches: ColliderBatch[]): void {
    if (batches.every((b) => b.verts === 0)) return;
    const gl = this.gl;
    const saved = this.begin(viewProj);
    const stride = FLOATS_PER_VERT * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 3 * 4);
    for (const b of batches) {
      if (b.verts === 0) continue;
      gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.verts * FLOATS_PER_VERT), gl.DYNAMIC_DRAW);
      gl.drawArrays(b.mode === "tri" ? gl.TRIANGLES : gl.LINES, 0, b.verts);
    }
    this.end(saved);
  }

  /** Draw persistent OverlayLayers whose VBOs already hold their geometry — NO per-
   *  frame upload. The big win for static overlays (pathing grid + blocked cells):
   *  bind each buffer and draw it, instead of re-streaming megabytes every frame. */
  renderLayers(viewProj: Float32Array | Iterable<number>, layers: OverlayLayer[]): void {
    if (layers.every((l) => l.verts === 0)) return;
    const gl = this.gl;
    const saved = this.begin(viewProj);
    const stride = FLOATS_PER_VERT * 4;
    for (const l of layers) {
      if (l.verts === 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, l.buffer());
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 3 * 4);
      gl.drawArrays(l.mode === "tri" ? gl.TRIANGLES : gl.LINES, 0, l.verts);
    }
    this.end(saved);
  }

  /** Snapshot the GL state we touch, then set up our program/blend/attribs. mdx-m3-
   *  viewer caches state JS-side, so end() must restore everything (see FogOverlay). */
  private begin(viewProj: Float32Array | Iterable<number>): SavedGLState {
    const gl = this.gl;
    const saved: SavedGLState = {
      program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
      arrayBuf: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
      blend: gl.isEnabled(gl.BLEND),
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
      cull: gl.isEnabled(gl.CULL_FACE),
      blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB) as number,
      blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB) as number,
      blendSrcA: gl.getParameter(gl.BLEND_SRC_ALPHA) as number,
      blendDstA: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
      attribs: [],
    };
    for (let i = 0; i < this.maxAttribs; i++) {
      saved.attribs[i] = gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean;
    }
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST); // debug overlay: always visible, on top of the world
    gl.disable(gl.CULL_FACE);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (i !== this.aPos && i !== this.aColor) gl.disableVertexAttribArray(i);
    }
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj as Float32Array);
    gl.enableVertexAttribArray(this.aPos);
    gl.enableVertexAttribArray(this.aColor);
    return saved;
  }

  private end(saved: SavedGLState): void {
    const gl = this.gl;
    gl.useProgram(saved.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, saved.arrayBuf);
    setEnabled(gl, gl.BLEND, saved.blend);
    setEnabled(gl, gl.DEPTH_TEST, saved.depthTest);
    setEnabled(gl, gl.CULL_FACE, saved.cull);
    gl.blendFuncSeparate(saved.blendSrcRGB, saved.blendDstRGB, saved.blendSrcA, saved.blendDstA);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (saved.attribs[i]) gl.enableVertexAttribArray(i);
      else gl.disableVertexAttribArray(i);
    }
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buf);
    this.gl.deleteProgram(this.program);
  }
}

function setEnabled(gl: GL, cap: number, on: boolean): void {
  if (on) gl.enable(cap);
  else gl.disable(cap);
}

function compileShader(gl: GL, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Debug-collider shader compile failed: ${log}`);
  }
  return sh;
}

function compileProgram(gl: GL, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Debug-collider program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}
