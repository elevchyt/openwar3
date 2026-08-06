import { CELL, cornerHeight, type TerrainData } from "../world/terrain";
import { pipelineState } from "./glPipelineState";

// WC3's STATIC shadow layer — `war3map.shd`, the other half of the game's shadow story.
//
// WC3 has no real-time shadows at all. What it has is two baked mechanisms, and we had only
// one of them: `ShadowOverlay` paints the soft blob decals that follow units and buildings
// (Units\UnitUI.slk), while everything that never moves — cliffs, doodads, trees, the map's
// own scenery — casts through a shadow mask the World Editor bakes into the map. Without it a
// forest is a set of trees standing on unshaded grass.
//
// **Format, verified against three real campaign maps** (the file has no header at all, so
// the only way to read it is to check its length against the map's own terrain):
//
//   | map           | cells   | war3map.shd | bytes/cell |
//   | NightElfX01   |  96×128 |     196 608 |         16 |
//   | NightElfX02   | 128×160 |     327 680 |         16 |
//   | OrcX01        | 192×192 |     589 824 |         16 |
//
// So it is **16 bytes per terrain CELL — a 4×4 sub-grid**, row-major, giving a mask of
// (cells_x × 4) by (cells_y × 4). Every byte in all three maps is either 0 or 255: it is a
// 1-bit mask, not a gradient. Coverage runs 13% (NightElfX01) to 34% (OrcX01), so this is a
// substantial part of how a WC3 map reads, not a subtle touch.
//
// We draw it the way this codebase draws every other ground decal (UberSplatOverlay,
// ShadowOverlay): one quad per cell, seated on the terrain's OWN corner heights with the same
// BR–TL split, so the layer is genuinely coplanar with the ground it darkens and morphs over
// slopes and ramps. One static buffer built once at map load and one draw call per frame —
// the mask never changes, so there is nothing to rebuild.
//
// Unshadowed cells are dropped from the mesh, which is most of them; a cell is kept if it or
// any of its eight neighbours carries a sample, so the bilinear filter still has real texels
// to blend toward at a shadow's edge instead of ending on a hard cell boundary.

const VERT_SRC = `
attribute vec3 aPos;
attribute vec2 aUv;
uniform mat4 uViewProj;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
uniform sampler2D uTex;
uniform float uStrength;
varying vec2 vUv;
void main() {
  float a = texture2D(uTex, vUv).a * uStrength;
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

// Same coplanar-decal biases as UberSplatOverlay/ShadowOverlay — proven to win LEQUAL
// against the terrain without z-fighting.
const LIFT = 2;
const POLYGON_OFFSET_FACTOR = -2;
const POLYGON_OFFSET_UNITS = -4;

/** How dark a fully-shadowed sample paints. The mask is 1-bit, so this alone decides the
 *  depth of every baked shadow on the map. Kept a field so it can be A/B'd live. */
const DEFAULT_STRENGTH = 0.45;

/** Sub-samples per terrain cell, per axis — the 16-bytes-per-cell finding above. */
const SUB = 4;

type GL = WebGLRenderingContext;

/** The parsed mask: `data[y * w + x]` is 0 or 255. */
export interface TerrainShadowMask {
  w: number;
  h: number;
  data: Uint8Array;
}

/**
 * Parse `war3map.shd` against the terrain it belongs to. Returns null when the map has no
 * shadow layer (plenty don't) or when the length does not match the cell grid — the file
 * carries no header, so that length check is the only validation there is, and a mismatch
 * means we would be reading someone else's grid.
 */
export function parseTerrainShadows(bytes: Uint8Array | null, terrain: TerrainData): TerrainShadowMask | null {
  if (!bytes || !bytes.length) return null;
  const cellsX = terrain.width - 1;
  const cellsY = terrain.height - 1;
  const w = cellsX * SUB;
  const h = cellsY * SUB;
  if (bytes.length !== w * h) {
    console.warn(`[terrain shadows] war3map.shd is ${bytes.length} bytes, expected ${w * h} for ${cellsX}×${cellsY} cells — ignoring`);
    return null;
  }
  return { w, h, data: new Uint8Array(bytes) };
}

export class TerrainShadowOverlay {
  private gl: GL;
  private program: WebGLProgram;
  private aPos: number;
  private aUv: number;
  private uViewProj: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private uStrength: WebGLUniformLocation;
  private maxAttribs: number;
  private posBuf: WebGLBuffer;
  private uvBuf: WebGLBuffer;
  private tex: WebGLTexture;
  private vertexCount = 0;
  strength = DEFAULT_STRENGTH;

  constructor(gl: GL, terrain: TerrainData, mask: TerrainShadowMask) {
    this.gl = gl;
    this.maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
    this.program = compileProgram(gl, VERT_SRC, FRAG_SRC);
    this.aPos = gl.getAttribLocation(this.program, "aPos");
    this.aUv = gl.getAttribLocation(this.program, "aUv");
    this.uViewProj = gl.getUniformLocation(this.program, "uViewProj")!;
    this.uTex = gl.getUniformLocation(this.program, "uTex")!;
    this.uStrength = gl.getUniformLocation(this.program, "uStrength")!;

    // The mask as an ALPHA texture — the fragment shader wants coverage, and the RGB is
    // black by definition. LINEAR so a 4-per-cell mask reads as a soft edge rather than as
    // the staircase its resolution would otherwise give.
    this.tex = gl.createTexture()!;
    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const prevAlign = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // rows are w bytes, not 4-aligned
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, mask.w, mask.h, 0, gl.ALPHA, gl.UNSIGNED_BYTE, mask.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);

    const { pos, uv, count } = buildMesh(terrain, mask);
    this.vertexCount = count;
    this.posBuf = gl.createBuffer()!;
    this.uvBuf = gl.createBuffer()!;
    const prevArrayBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos.subarray(0, count * 3), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv.subarray(0, count * 2), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuf);
  }

  /** Draw the layer. Same GL discipline as the sibling overlays: mdx-m3-viewer keeps a
   *  JS-side shadow of the pipeline state, so everything we touch is saved and restored. */
  render(viewProj: Float32Array | Iterable<number>): void {
    if (!this.vertexCount) return;
    const gl = this.gl;
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const prevArrayBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
    const prevCull = gl.isEnabled(gl.CULL_FACE);
    const pipeline = pipelineState(gl);
    const prevPipeline = pipeline.save();
    const prevPolyOffset = gl.isEnabled(gl.POLYGON_OFFSET_FILL);
    const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    gl.activeTexture(gl.TEXTURE0);
    const prevTex0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const prevAttribEnabled: boolean[] = [];
    for (let i = 0; i < this.maxAttribs; i++) {
      prevAttribEnabled[i] = gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean;
    }

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(POLYGON_OFFSET_FACTOR, POLYGON_OFFSET_UNITS);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (i !== this.aPos && i !== this.aUv) gl.disableVertexAttribArray(i);
    }
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj as Float32Array);
    gl.uniform1i(this.uTex, 0);
    gl.uniform1f(this.uStrength, this.strength);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.enableVertexAttribArray(this.aPos);
    gl.enableVertexAttribArray(this.aUv);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    gl.bindTexture(gl.TEXTURE_2D, prevTex0);
    gl.activeTexture(prevActiveTex);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (prevAttribEnabled[i]) gl.enableVertexAttribArray(i);
      else gl.disableVertexAttribArray(i);
    }
    if (!prevPolyOffset) gl.disable(gl.POLYGON_OFFSET_FILL);
    pipeline.restore(prevPipeline);
    if (!prevBlend) gl.disable(gl.BLEND);
    if (!prevDepthTest) gl.disable(gl.DEPTH_TEST);
    if (prevCull) gl.enable(gl.CULL_FACE);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuf);
    gl.useProgram(prevProgram);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.posBuf);
    gl.deleteBuffer(this.uvBuf);
    gl.deleteTexture(this.tex);
    gl.deleteProgram(this.program);
    this.vertexCount = 0;
  }
}

/** One quad per shadowed cell, seated on the terrain's own corners. */
function buildMesh(terrain: TerrainData, mask: TerrainShadowMask): { pos: Float32Array; uv: Float32Array; count: number } {
  const { width, height, centerOffset, corners } = terrain;
  const ox = centerOffset[0];
  const oy = centerOffset[1];
  const cellsX = width - 1;
  const cellsY = height - 1;

  // Which cells carry any shadow, dilated by one so the LINEAR filter has something to
  // blend toward at an edge (a kept cell next to a dropped one would otherwise cut hard).
  const lit = new Uint8Array(cellsX * cellsY);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      let any = 0;
      for (let sy = 0; sy < SUB && !any; sy++) {
        const row = (cy * SUB + sy) * mask.w + cx * SUB;
        for (let sx = 0; sx < SUB; sx++) if (mask.data[row + sx]) { any = 1; break; }
      }
      if (any) lit[cy * cellsX + cx] = 1;
    }
  }
  const keep = new Uint8Array(cellsX * cellsY);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      if (!lit[cy * cellsX + cx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < cellsX && ny < cellsY) keep[ny * cellsX + nx] = 1;
        }
      }
    }
  }

  let cells = 0;
  for (let i = 0; i < keep.length; i++) if (keep[i]) cells++;
  const pos = new Float32Array(cells * 6 * 3);
  const uv = new Float32Array(cells * 6 * 2);
  let pi = 0;
  let ui = 0;
  const cw = (gx: number, gy: number): number => cornerHeight(corners[gy * width + gx]) * CELL + LIFT;
  const emit = (gx: number, gy: number): void => {
    pos[pi++] = ox + gx * CELL;
    pos[pi++] = oy + gy * CELL;
    pos[pi++] = cw(gx, gy);
    // The mask spans the cell grid exactly, so a corner's UV is just its grid fraction.
    uv[ui++] = gx / cellsX;
    uv[ui++] = gy / cellsY;
  };
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      if (!keep[cy * cellsX + cx]) continue;
      // faces [BL, BR, TL, BR, TR, TL] — the same split as terrain.ts and the other overlays.
      emit(cx, cy); emit(cx + 1, cy); emit(cx, cy + 1);
      emit(cx + 1, cy); emit(cx + 1, cy + 1); emit(cx, cy + 1);
    }
  }
  return { pos, uv, count: cells * 6 };
}

function compileProgram(gl: GL, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`[terrain shadows] shader: ${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`[terrain shadows] link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}
