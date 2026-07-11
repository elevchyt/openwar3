// Unit shadows (issue #58) — WC3's cheap "shadow system". Every mobile unit casts a
// soft, DIRECTIONAL blob shadow onto the terrain: a black decal painted like an
// ubersplat, so it MORPHS over slopes and ramps and always falls a hair toward the
// top-right (north-east), the fixed direction the game's sun casts. This is not a
// projected/depth shadow — it's a flat textured quad on the ground, which is exactly
// why it's cheap: no shadow map, no extra render pass over the whole scene.
//
// The art + geometry are the REAL game data (Units\UnitUI.slk, verified against
// War3.mpq): `unitShadow` names a texture in ReplaceableTextures\Shadows\ (Shadow.blp
// for ground units, ShadowFlyer.blp for air), which is a 64² sprite whose RGB is pure
// black and whose ALPHA carries the soft blob. The quad is shadowW×shadowH world units
// with its min corner at (unit − shadowX, unit − shadowY) — a Footman's 140² blob with a
// 50 offset centres at +20,+20, i.e. up-right. We reproduce the top-right cast for free
// straight from that offset (see UnitDef.shadowX/Y).
//
// PERFORMANCE (the whole point): all shadows sharing one texture are drawn in ONE call
// from ONE vertex buffer rebuilt each frame — no per-unit buffers, no per-unit draws.
// There are only ~2 shadow textures in play (Shadow + ShadowFlyer), so the entire pass
// is ~2 draw calls regardless of army size. The geometry is tessellated over the
// terrain's OWN corner grid (same 128-unit spacing, corner heights, and BR–TL diagonal
// as the viewer's terrain and the ubersplat/fog meshes), so a shadow is genuinely
// coplanar with the ground — but a unit blob only spans ~1 cell, so that's a handful of
// triangles each.
//
// GL discipline mirrors UberSplatOverlay/FogOverlay: mdx-m3-viewer wraps WebGL in a
// JS-side state cache, so we snapshot and restore everything we touch.

import { CELL, cornerHeight, type TerrainData } from "../world/terrain";

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
uniform float uStrength; // overall shadow darkness scale (0..1)
varying vec2 vUv;
void main() {
  // Cells we tessellated may spill past the shadow's [0,1] box — clip to it.
  if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
  // The shadow BLP is black RGB + an alpha blob; alpha is the coverage.
  float a = texture2D(uTex, vUv).a * uStrength;
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

// Match UberSplatOverlay's proven coplanar-decal biases so the shadow reliably wins
// LEQUAL against the terrain it sits on without z-fighting.
const LIFT = 2;
const POLYGON_OFFSET_FACTOR = -2;
const POLYGON_OFFSET_UNITS = -4;

// Extra world-space shove toward the top-right (+X north-east, +Y up on WC3's fixed
// north-up camera) on TOP of each shadow's authentic shadowX/Y centring. The game's own
// offset is only ~10-20u, which reads as "under the unit"; the developer wanted the cast
// to sit more clearly up-right (issue #58 f/u), so we push a bit further. Tuned live.
const DIR_PUSH = 36;

// Overall darkness. WC3 shadow blobs top out near 0.75 alpha in the texture, so this
// scale gives ~0.55 peak — a soft, clearly-read contact shadow like the game's, not a
// hard black splotch. Tuned live against the real client's shadows (issue #58).
const DEFAULT_STRENGTH = 0.75;

type GL = WebGLRenderingContext;

/** Loader the scene provides: decode a BLP path to a canvas (or null if absent). */
export type TextureLoader = (path: string) => HTMLCanvasElement | null;

// A per-texture batch: one growable CPU vertex pool, uploaded to one GL buffer and
// drawn in one call. Rebuilt from empty every frame (beginFrame → add… → render).
interface Batch {
  pos: Float32Array; // xyz per vertex, capacity `cap` verts
  uv: Float32Array; //  uv  per vertex
  cap: number; // vertex capacity of the CPU pools
  count: number; // verts filled this frame
  posBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  glCap: number; // vertex capacity currently allocated on the GPU buffers
}

interface CachedTexture {
  canvas: HTMLCanvasElement | null; // decoded once on first sight
  tex: WebGLTexture | null; // GL texture, uploaded lazily inside the render pass
}

export class ShadowOverlay {
  private gl: GL;
  private terrain: TerrainData;
  private loader: TextureLoader;
  private program: WebGLProgram;
  private aPos: number;
  private aUv: number;
  private uViewProj: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private uStrength: WebGLUniformLocation;
  private maxAttribs: number;
  private strength = DEFAULT_STRENGTH;
  private batches = new Map<string, Batch>(); // key = texture path
  private textures = new Map<string, CachedTexture>();

  constructor(gl: GL, terrain: TerrainData, loader: TextureLoader) {
    this.gl = gl;
    this.terrain = terrain;
    this.loader = loader;
    this.maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
    this.program = compileProgram(gl, VERT_SRC, FRAG_SRC);
    this.aPos = gl.getAttribLocation(this.program, "aPos");
    this.aUv = gl.getAttribLocation(this.program, "aUv");
    this.uViewProj = gl.getUniformLocation(this.program, "uViewProj")!;
    this.uTex = gl.getUniformLocation(this.program, "uTex")!;
    this.uStrength = gl.getUniformLocation(this.program, "uStrength")!;
  }

  /** Start a fresh frame: drop last frame's geometry (the GPU buffers/textures are
   *  kept and reused). Call once, then add() every visible unit's shadow. */
  beginFrame(): void {
    for (const b of this.batches.values()) b.count = 0;
  }

  /** Append one unit's shadow, centred so its box spans [x − shadowX, x − shadowX + w]
   *  × [y − shadowY, y − shadowY + h] (the game's own directional offset). Tessellated
   *  over the terrain cells it overlaps so it hugs slopes. `texture` is the shadow BLP
   *  path — shadows sharing a texture batch into one draw. Cheap: a blob spans ~1 cell. */
  add(x: number, y: number, w: number, h: number, shadowX: number, shadowY: number, texture: string): void {
    if (w <= 0 || h <= 0 || !texture) return;
    const batch = this.batchFor(texture);
    // Box min corner = (unit − shadowX, unit − shadowY), then DIR_PUSH shoves the whole
    // box toward the top-right so the cast reads clearly up-right (see DIR_PUSH).
    this.tessellate(batch, x - shadowX + DIR_PUSH, y - shadowY + DIR_PUSH, w, h);
    if (!this.textures.has(texture)) {
      this.textures.set(texture, { canvas: this.loader(texture), tex: null });
    }
  }

  /** Draw all shadow batches. Call every frame AFTER the terrain is drawn and BEFORE the
   *  units (so unit bodies paint over their own shadow) and BEFORE the fog (so the veil
   *  dims shadows like the ground). No-op when nothing was added. */
  render(viewProj: Float32Array | Iterable<number>): void {
    let any = false;
    for (const b of this.batches.values()) if (b.count > 0) { any = true; break; }
    if (!any) return;
    const gl = this.gl;
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const prevArrayBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
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
    const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    gl.activeTexture(gl.TEXTURE0);
    const prevTex0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const prevAttribEnabled: boolean[] = [];
    for (let i = 0; i < this.maxAttribs; i++) {
      prevAttribEnabled[i] = gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean;
    }

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); // darken the ground
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false); // sit on the world's depth, don't overwrite it (units stay in front)
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(POLYGON_OFFSET_FACTOR, POLYGON_OFFSET_UNITS);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (i !== this.aPos && i !== this.aUv) gl.disableVertexAttribArray(i);
    }
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj as Float32Array);
    gl.uniform1i(this.uTex, 0);
    gl.uniform1f(this.uStrength, this.strength);
    gl.enableVertexAttribArray(this.aPos);
    gl.enableVertexAttribArray(this.aUv);

    for (const [path, batch] of this.batches) {
      if (batch.count === 0) continue;
      const tex = this.resolveTexture(path);
      if (!tex) continue; // texture missing/undecodable — skip
      // Upload this frame's geometry. Grow the GPU buffers when an army got bigger,
      // else overwrite in place (orphan + subdata) so no realloc churn per frame.
      this.uploadBatch(batch);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.posBuf);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.uvBuf);
      gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, batch.count);
    }

    // Restore everything we touched so the viewer's cached GL state stays valid.
    gl.bindTexture(gl.TEXTURE_2D, prevTex0);
    gl.activeTexture(prevActiveTex);
    gl.useProgram(prevProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuf);
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

  /** Tessellate a shadow box (min corner minX,minY; size w×h) over the terrain corner
   *  grid it overlaps, appending non-indexed triangles into `batch`. Same BR–TL split,
   *  cornerHeight seating, and [0,1] UV mapping as UberSplatOverlay — so the decal is
   *  coplanar with the ground and the fragment shader can clip to the box. */
  private tessellate(batch: Batch, minX: number, minY: number, w: number, h: number): void {
    const { width, height, centerOffset, corners } = this.terrain;
    const ox = centerOffset[0];
    const oy = centerOffset[1];
    const gx0 = clamp(Math.floor((minX - ox) / CELL), 0, width - 2);
    const gx1 = clamp(Math.ceil((minX + w - ox) / CELL), gx0 + 1, width - 1);
    const gy0 = clamp(Math.floor((minY - oy) / CELL), 0, height - 2);
    const gy1 = clamp(Math.ceil((minY + h - oy) / CELL), gy0 + 1, height - 1);
    const cells = (gx1 - gx0) * (gy1 - gy0);
    if (cells <= 0) return;
    this.ensureCapacity(batch, batch.count + cells * 6);
    const pos = batch.pos;
    const uv = batch.uv;
    let pi = batch.count * 3;
    let ui = batch.count * 2;
    const cw = (gxi: number, gyi: number): number => cornerHeight(corners[gyi * width + gxi]) * CELL + LIFT;
    const emit = (gxi: number, gyi: number): void => {
      const wx = ox + gxi * CELL;
      const wy = oy + gyi * CELL;
      pos[pi++] = wx;
      pos[pi++] = wy;
      pos[pi++] = cw(gxi, gyi);
      uv[ui++] = (wx - minX) / w;
      uv[ui++] = (wy - minY) / h;
    };
    for (let gy = gy0; gy < gy1; gy++) {
      for (let gx = gx0; gx < gx1; gx++) {
        // faces [BL, BR, TL, BR, TR, TL] — same split as terrain.ts / uberSplatOverlay.
        emit(gx, gy); emit(gx + 1, gy); emit(gx, gy + 1);
        emit(gx + 1, gy); emit(gx + 1, gy + 1); emit(gx, gy + 1);
      }
    }
    batch.count += cells * 6;
  }

  private batchFor(texture: string): Batch {
    let b = this.batches.get(texture);
    if (!b) {
      const gl = this.gl;
      const cap = 512 * 6; // room for ~512 shadow cells before the first grow
      b = {
        pos: new Float32Array(cap * 3),
        uv: new Float32Array(cap * 2),
        cap,
        count: 0,
        posBuf: gl.createBuffer()!,
        uvBuf: gl.createBuffer()!,
        glCap: 0,
      };
      this.batches.set(texture, b);
    }
    return b;
  }

  /** Grow a batch's CPU pools to hold at least `verts` vertices (doubling, copy-forward).
   *  Counts stabilise with the army size, so this stops firing after warmup. */
  private ensureCapacity(batch: Batch, verts: number): void {
    if (verts <= batch.cap) return;
    let cap = batch.cap;
    while (cap < verts) cap *= 2;
    const pos = new Float32Array(cap * 3);
    const uv = new Float32Array(cap * 2);
    pos.set(batch.pos.subarray(0, batch.count * 3));
    uv.set(batch.uv.subarray(0, batch.count * 2));
    batch.pos = pos;
    batch.uv = uv;
    batch.cap = cap;
  }

  /** Push a batch's filled CPU verts to its GPU buffers. Reallocates the GPU buffer only
   *  when it needs to be bigger; otherwise orphans and re-fills it (no size churn). */
  private uploadBatch(batch: Batch): void {
    const gl = this.gl;
    const posView = batch.pos.subarray(0, batch.count * 3);
    const uvView = batch.uv.subarray(0, batch.count * 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.posBuf);
    if (batch.count > batch.glCap) gl.bufferData(gl.ARRAY_BUFFER, batch.cap * 3 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, posView);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.uvBuf);
    if (batch.count > batch.glCap) gl.bufferData(gl.ARRAY_BUFFER, batch.cap * 2 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, uvView);
    if (batch.count > batch.glCap) batch.glCap = batch.cap;
  }

  /** Lazily upload a decoded BLP canvas to a GL texture (inside render's saved state).
   *  Returns null if the BLP was absent/undecodable. */
  private resolveTexture(path: string): WebGLTexture | null {
    const cached = this.textures.get(path);
    if (!cached || !cached.canvas) return null;
    if (cached.tex) return cached.tex;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cached.canvas);
    const pot = isPow2(cached.canvas.width) && isPow2(cached.canvas.height);
    if (pot) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    cached.tex = tex;
    return tex;
  }

  dispose(): void {
    const gl = this.gl;
    for (const b of this.batches.values()) {
      gl.deleteBuffer(b.posBuf);
      gl.deleteBuffer(b.uvBuf);
    }
    this.batches.clear();
    for (const t of this.textures.values()) if (t.tex) gl.deleteTexture(t.tex);
    this.textures.clear();
    gl.deleteProgram(this.program);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isPow2(n: number): boolean {
  return (n & (n - 1)) === 0;
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
    throw new Error(`Shadow shader compile failed: ${log}`);
  }
  return sh;
}

function compileProgram(gl: GL, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Shadow program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}
