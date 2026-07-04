// The fog-of-war terrain overlay — the black/grey mask drawn over the ground.
//
// mdx-m3-viewer renders the terrain internally with no shader hook we can reach, so
// we draw fog as our OWN GL pass after `viewer.render()`, sharing the viewer's canvas
// and camera. Each vertex carries a "darkness" (0 = in sight, 0.5 = explored grey veil,
// 1 = unexplored black) sampled from the VisionMap; the GPU interpolates it across the
// mesh so fog edges are soft.
//
// CRUCIAL: the fog mesh is built on the EXACT terrain corner grid — same 128-unit
// spacing, same corner heights (`cornerHeight`, matching the viewer's height texture),
// and the same per-cell diagonal (BR–TL, faces [BL,BR,TL, BR,TR,TL]) that the viewer's
// terrain uses (map.js: verts [0,0],[1,0],[0,1],[1,1], faces [0,1,2,1,3,2]). That makes
// the fog surface genuinely COPLANAR with the rendered terrain everywhere — flats,
// slopes, and cliffs alike. An earlier version sampled a bilinear height at an unaligned
// 96-unit spacing; on cliffs it diverged from the terrain's triangle-linear surface by
// tens of units and sank below it, so the fog lost the depth test and terrain showed
// through (the "no fog past your units at screen edges" bug). Coplanar + a slope-scaled
// glPolygonOffset now makes the fog reliably win LEQUAL against the terrain.
//
// Depth-tested (LEQUAL, no depth write) so the fog is correctly occluded behind hills
// and does NOT cover units (which stand above the ground sheet). Tall doodads/units in
// never-explored fog are hidden separately by the map viewer.

import { FogState, type VisionMap } from "../sim/vision";
import { CELL, cornerHeight, type TerrainData } from "../world/terrain";

const VERT_SRC = `
attribute vec3 aPos;
attribute float aDark;
uniform mat4 uViewProj;
varying float vDark;
void main() {
  vDark = aDark;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying float vDark;
void main() {
  // Black veil; alpha IS the darkness. Explored ~0.5 dims the terrain, unexplored
  // 1.0 hides it. Discard fully-clear fragments so visible ground stays untouched.
  if (vDark <= 0.01) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, vDark);
}`;

const EXPLORED_DARK = 0.5; // grey veil over remembered-but-not-seen terrain
// The fog mesh is now coplanar with the terrain (same corner grid + triangulation), so
// only a slope-scaled depth bias is needed to make it win LEQUAL against the terrain.
// glPolygonOffset biases depth in screen space, scaled by the surface's screen-space
// depth slope AND the local depth resolution — so it compensates MORE where precision
// is worse (far field), exactly where a fixed world lift failed.
const LIFT = 4; // tiny world lift as belt-and-suspenders for ramp/diagonal residue
const POLYGON_OFFSET_FACTOR = -2; // pull fog toward the camera in depth (slope-scaled)
const POLYGON_OFFSET_UNITS = -4;

type GL = WebGLRenderingContext;

export class FogOverlay {
  private gl: GL;
  private program: WebGLProgram;
  private posBuf: WebGLBuffer;
  private darkBuf: WebGLBuffer;
  private idxBuf: WebGLBuffer;
  private aPos: number;
  private aDark: number;
  private uViewProj: WebGLUniformLocation;
  private indexCount: number;
  private indexType: number; // UNSIGNED_SHORT or UNSIGNED_INT (large maps)
  private maxAttribs: number; // GL_MAX_VERTEX_ATTRIBS, cached for the per-frame attrib sweep
  private vx: Float32Array; // per-vertex world X (for sampling the vision map)
  private vy: Float32Array;
  private dark: Float32Array; // per-vertex darkness (uploaded each update)

  constructor(gl: GL, terrain: TerrainData) {
    this.gl = gl;
    this.maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
    const { width, height, centerOffset, corners } = terrain; // corners = width×height grid
    const n = width * height;
    const pos = new Float32Array(n * 3);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.dark = new Float32Array(n).fill(1); // start fully unexplored (black)
    // One vertex per terrain corner, at the corner's exact world height (matching the
    // viewer's height texture: cornerHeight = groundHeight + layerHeight - 2 [+ramp]).
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        const i = cy * width + cx;
        const x = centerOffset[0] + cx * CELL;
        const y = centerOffset[1] + cy * CELL;
        this.vx[i] = x;
        this.vy[i] = y;
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = cornerHeight(corners[i]) * CELL + LIFT;
      }
    }
    // Two triangles per cell, split on the SAME diagonal as the viewer's terrain
    // (BR–TL): faces [BL,BR,TL, BR,TR,TL]. Large maps overflow Uint16 vertex indices
    // (257² = 66049 > 65535) → use OES_element_index_uint when available.
    const cells = (width - 1) * (height - 1);
    const useUint32 = n > 65535 && !!gl.getExtension("OES_element_index_uint");
    const idx = useUint32 ? new Uint32Array(cells * 6) : new Uint16Array(cells * 6);
    this.indexType = useUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    let k = 0;
    for (let cy = 0; cy < height - 1; cy++) {
      for (let cx = 0; cx < width - 1; cx++) {
        const bl = cy * width + cx;
        const br = bl + 1;
        const tl = bl + width;
        const tr = tl + 1;
        idx[k++] = bl; idx[k++] = br; idx[k++] = tl;
        idx[k++] = br; idx[k++] = tr; idx[k++] = tl;
      }
    }
    // If the map is too big for Uint16 and the uint-index extension is missing, the
    // buffer was clamped to Uint16 above — clamp the count so we never read past it.
    this.indexCount = this.indexType === gl.UNSIGNED_SHORT && n > 65535 ? 0 : idx.length;

    this.program = compileProgram(gl, VERT_SRC, FRAG_SRC);
    this.aPos = gl.getAttribLocation(this.program, "aPos");
    this.aDark = gl.getAttribLocation(this.program, "aDark");
    this.uViewProj = gl.getUniformLocation(this.program, "uViewProj")!;
    this.posBuf = createBuffer(gl, gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    this.darkBuf = createBuffer(gl, gl.ARRAY_BUFFER, this.dark, gl.DYNAMIC_DRAW);
    this.idxBuf = createBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  /** Re-sample the vision map into the per-vertex darkness and upload it. Throttle
   *  the caller — the vision itself only changes a few times a second. */
  update(vision: VisionMap): void {
    for (let i = 0; i < this.dark.length; i++) {
      const state = vision.stateAt(this.vx[i], this.vy[i]);
      this.dark[i] = state === FogState.Visible ? 0 : state === FogState.Explored ? EXPLORED_DARK : 1;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.darkBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dark);
  }

  /** Draw the fog. Call every frame, AFTER the viewer has rendered the world.
   *
   *  CRITICAL: mdx-m3-viewer wraps WebGL with a JS-side state cache — it only calls
   *  gl.useProgram/enables when its cached value differs. We change GL state directly
   *  (bypassing that cache), so we must save EVERYTHING we touch and restore it, or
   *  the viewer's cache goes stale and it draws the next frame's whole world with our
   *  fog shader (→ black screen). Every state set below has a matching restore. */
  render(viewProj: Float32Array | Iterable<number>): void {
    if (this.indexCount === 0) return; // map too big for Uint16 and no uint-index ext
    const gl = this.gl;
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const prevArrayBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const prevElemBuf = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
    const prevCull = gl.isEnabled(gl.CULL_FACE);
    const prevDepthFunc = gl.getParameter(gl.DEPTH_FUNC) as number;
    const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;
    const prevBlendSrcRGB = gl.getParameter(gl.BLEND_SRC_RGB) as number;
    const prevBlendDstRGB = gl.getParameter(gl.BLEND_DST_RGB) as number;
    const prevBlendSrcA = gl.getParameter(gl.BLEND_SRC_ALPHA) as number;
    const prevBlendDstA = gl.getParameter(gl.BLEND_DST_ALPHA) as number;
    const prevPolyOffset = gl.isEnabled(gl.POLYGON_OFFSET_FILL);
    const prevPolyFactor = gl.getParameter(gl.POLYGON_OFFSET_FACTOR) as number;
    const prevPolyUnits = gl.getParameter(gl.POLYGON_OFFSET_UNITS) as number;
    // Snapshot EVERY vertex-attrib array's enabled flag. mdx-m3-viewer's terrain/unit
    // passes leave several arrays enabled with NO buffer bound (e.g. slots 5–8). WebGL
    // rejects a drawElements when ANY enabled array lacks a buffer — even arrays our
    // shader never reads — with INVALID_OPERATION, so our fog draw silently failed and
    // NO veil ever painted. We must disable those strays before drawing, then restore
    // the exact enabled state so the viewer's own state cache stays consistent.
    const prevAttribEnabled: boolean[] = [];
    for (let i = 0; i < this.maxAttribs; i++) {
      prevAttribEnabled[i] = gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean;
    }

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false); // read the world's depth, don't overwrite it
    gl.disable(gl.CULL_FACE);
    // Slope-scaled depth bias so the near-coplanar fog reliably wins LEQUAL vs terrain.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(POLYGON_OFFSET_FACTOR, POLYGON_OFFSET_UNITS);
    // Disable every array except the two our shader binds, so no enabled-but-bufferless
    // array left by the viewer trips INVALID_OPERATION on drawElements (see above).
    for (let i = 0; i < this.maxAttribs; i++) {
      if (i !== this.aPos && i !== this.aDark) gl.disableVertexAttribArray(i);
    }
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj as Float32Array);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.darkBuf);
    gl.enableVertexAttribArray(this.aDark);
    gl.vertexAttribPointer(this.aDark, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);

    // Restore every touched state so the viewer's cached GL state stays valid.
    gl.useProgram(prevProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, prevElemBuf);
    setEnabled(gl, gl.BLEND, prevBlend);
    setEnabled(gl, gl.DEPTH_TEST, prevDepthTest);
    setEnabled(gl, gl.CULL_FACE, prevCull);
    setEnabled(gl, gl.POLYGON_OFFSET_FILL, prevPolyOffset);
    gl.polygonOffset(prevPolyFactor, prevPolyUnits);
    gl.depthFunc(prevDepthFunc);
    gl.depthMask(prevDepthMask);
    gl.blendFuncSeparate(prevBlendSrcRGB, prevBlendDstRGB, prevBlendSrcA, prevBlendDstA);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (prevAttribEnabled[i]) gl.enableVertexAttribArray(i);
      else gl.disableVertexAttribArray(i);
    }
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.posBuf);
    gl.deleteBuffer(this.darkBuf);
    gl.deleteBuffer(this.idxBuf);
    gl.deleteProgram(this.program);
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
    throw new Error(`Fog shader compile failed: ${log}`);
  }
  return sh;
}

function compileProgram(gl: GL, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Fog program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function createBuffer(gl: GL, target: number, data: ArrayBufferView, usage: number): WebGLBuffer {
  const buf = gl.createBuffer()!;
  gl.bindBuffer(target, buf);
  gl.bufferData(target, data, usage);
  return buf;
}
