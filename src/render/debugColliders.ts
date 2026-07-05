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
};

export const FLOATS_PER_VERT = 7; // x,y,z, r,g,b,a

/** One draw batch: interleaved [x,y,z,r,g,b,a] verts drawn as triangles or lines. */
export interface ColliderBatch {
  data: Float32Array;
  verts: number;
  mode: "tri" | "line";
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
   *  state save/restore. Called every frame while the overlay is on. */
  render(viewProj: Float32Array | Iterable<number>, batches: ColliderBatch[]): void {
    if (batches.every((b) => b.verts === 0)) return;
    const gl = this.gl;
    // --- snapshot GL state we touch (mirror FogOverlay) ---
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const prevArrayBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
    const prevCull = gl.isEnabled(gl.CULL_FACE);
    const prevBlendSrcRGB = gl.getParameter(gl.BLEND_SRC_RGB) as number;
    const prevBlendDstRGB = gl.getParameter(gl.BLEND_DST_RGB) as number;
    const prevBlendSrcA = gl.getParameter(gl.BLEND_SRC_ALPHA) as number;
    const prevBlendDstA = gl.getParameter(gl.BLEND_DST_ALPHA) as number;
    const prevAttribEnabled: boolean[] = [];
    for (let i = 0; i < this.maxAttribs; i++) {
      prevAttribEnabled[i] = gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean;
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
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = FLOATS_PER_VERT * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 3 * 4);

    for (const b of batches) {
      if (b.verts === 0) continue;
      gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.verts * FLOATS_PER_VERT), gl.DYNAMIC_DRAW);
      gl.drawArrays(b.mode === "tri" ? gl.TRIANGLES : gl.LINES, 0, b.verts);
    }

    // --- restore ---
    gl.useProgram(prevProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuf);
    setEnabled(gl, gl.BLEND, prevBlend);
    setEnabled(gl, gl.DEPTH_TEST, prevDepthTest);
    setEnabled(gl, gl.CULL_FACE, prevCull);
    gl.blendFuncSeparate(prevBlendSrcRGB, prevBlendDstRGB, prevBlendSrcA, prevBlendDstA);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (prevAttribEnabled[i]) gl.enableVertexAttribArray(i);
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
