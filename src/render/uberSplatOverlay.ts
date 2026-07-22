// Building ground textures — WC3's "ubersplats": the dirt/foundation decals painted
// on the terrain under buildings and gold mines (issue #12). A building's `uberSplat`
// code (UnitUI.slk) resolves via UberSplatData.slk to a texture + half-width `scale`
// (see src/data/ubersplats.ts). We draw them as our OWN GL pass after viewer.render()
// and BEFORE the fog, exactly like FogOverlay — mdx-m3-viewer renders terrain with no
// shader hook we can reach.
//
// Each splat is a textured quad tessellated over the terrain's OWN corner grid (same
// 128-unit spacing, same corner heights via cornerHeight, same BR–TL diagonal as the
// viewer's terrain and the fog mesh), so the decal is genuinely COPLANAR with the
// ground on flats, slopes, and ramps — no z-fighting. Per-vertex UVs map the splat's
// [center ± scale] box to [0,1]; the fragment shader discards outside that box, so the
// decal is clipped to a clean square regardless of which whole cells we tessellated.
//
// CRUCIAL (same as FogOverlay): mdx-m3-viewer wraps WebGL with a JS-side state cache.
// We change GL state directly, so we snapshot and restore EVERYTHING we touch — else
// the viewer's cache goes stale and it draws the next frame's world with our shader.

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
uniform vec3 uTint;
uniform float uAlpha; // whole-splat opacity — a temporary spell splat's Birth/Pause/Decay fade
uniform float uMask;
uniform float uHalf; // ring outer radius in WORLD units (the splat half-width) — for mask mode
varying vec2 vUv;
void main() {
  // Clip to the splat's [0,1] box: cells we tessellated may spill past it.
  if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
  if (uMask > 0.5) {
    // Selection ring — drawn PROCEDURALLY, not from the BLP. WC3's SelectionCircle BLP is
    // a 2px hairline on an opaque black field, authored for additive blend; painted as a
    // terrain splat it washes out on bright grass (visible only over dark dirt) and dims
    // further with distance (issue #34 f/u). Drawing a clean, thick, fully-opaque uTint
    // band ourselves gives a crisp, high-contrast ring on ANY terrain at a controllable
    // width, while the tessellated geometry still makes it conform to slopes/ramps.
    vec2 p = (vUv - 0.5) * 2.0;                 // [-1,1] — a circle inscribed in the box
    float r = length(p) * uHalf;                // WORLD distance from the ring centre
    // Band width in WORLD units, not a fraction of the radius — otherwise a big building
    // ring (large half-width) looks many times thicker than a unit's. Capped so a huge
    // ring stays a thin border; small units keep their (already-good) proportional width.
    float thick = min(uHalf * 0.16, 8.0);
    float aa = 1.5;                             // soft edge, world units
    float a = smoothstep(uHalf - thick - aa, uHalf - thick + aa, r) * (1.0 - smoothstep(uHalf - aa, uHalf + aa, r));
    if (a < 0.02) discard;
    gl_FragColor = vec4(uTint, a * uAlpha);
    return;
  }
  // Foundation / AoE splats: the texture as-authored, recoloured by uTint (white = as-is).
  vec4 c = texture2D(uTex, vUv);
  if (c.a < 0.01) discard; // skip the fully-transparent margin of the splat texture
  gl_FragColor = vec4(c.rgb * uTint, c.a * uAlpha);
}`;

// A hair of world lift + a slope-scaled depth bias so the coplanar decal reliably wins
// LEQUAL against the terrain it sits on (mirrors FogOverlay's proven values).
const LIFT = 3;
const POLYGON_OFFSET_FACTOR = -2;
const POLYGON_OFFSET_UNITS = -4;

type GL = WebGLRenderingContext;

/** Loader the scene provides: decode a BLP path to a canvas (or null if absent). */
export type TextureLoader = (path: string) => HTMLCanvasElement | null;

interface SplatEntry {
  posBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  count: number; // vertex count (non-indexed triangles)
  texture: string; // BLP path (key into the texture cache)
  tint: [number, number, number]; // colour ([1,1,1] = texture unchanged; the ring's colour when `mask`)
  additive: boolean; // ADDITIVE blend vs alpha blend (default)
  mask: boolean; // draw a PROCEDURAL `tint` ring from UV, ignoring the texture (selection rings)
  half: number; // the splat half-width in world units (ring outer radius, for `mask`)
  alpha: number; // whole-splat opacity (1 = as-authored); driven by setAlpha for fading splats
  /** Withheld from the frame without forgetting the geometry — a building's splat is part of
   *  its IMAGE, so it shows exactly when the building's model does (live or remembered) and
   *  hides with it. Distinct from `remove`: a fogged building still exists; a dead one does
   *  not. Default false; driven per frame by the splat-visibility sync in mapViewer. */
  hidden: boolean;
}

/** Per-splat options. `tint` recolours the texture (default white), or is the ring
 *  colour when `mask`; `additive` switches to additive blending (default alpha blend);
 *  `mask` draws a procedural ring band from the UV (crisp on any terrain) instead of
 *  sampling the texture — the texture only has to exist so the entry is drawn. */
export interface SplatOptions {
  tint?: [number, number, number];
  additive?: boolean;
  mask?: boolean;
  alpha?: number;
}

interface CachedTexture {
  canvas: HTMLCanvasElement | null; // decoded once at add time
  tex: WebGLTexture | null; // GL texture, created lazily inside the render pass
}

export class UberSplatOverlay {
  private gl: GL;
  private terrain: TerrainData;
  private loader: TextureLoader;
  private program: WebGLProgram;
  private aPos: number;
  private aUv: number;
  private uViewProj: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private uTint: WebGLUniformLocation;
  private uAlpha: WebGLUniformLocation;
  private uMask: WebGLUniformLocation;
  private uHalf: WebGLUniformLocation;
  private maxAttribs: number;
  private entries = new Map<string, SplatEntry>();
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
    this.uTint = gl.getUniformLocation(this.program, "uTint")!;
    this.uAlpha = gl.getUniformLocation(this.program, "uAlpha")!;
    this.uMask = gl.getUniformLocation(this.program, "uMask")!;
    this.uHalf = gl.getUniformLocation(this.program, "uHalf")!;
  }

  has(id: string | number): boolean {
    return this.entries.has(String(id));
  }

  /** Add (or replace) a splat centred at world (x, y): a `2*scale`-wide square of
   *  `texture`, tessellated over the terrain cells it overlaps. Cheap — a building
   *  splat covers only a handful of cells. */
  add(id: string | number, x: number, y: number, scale: number, texture: string, opts?: SplatOptions): void {
    const key = String(id);
    this.remove(key); // drop any prior geometry for this id
    const { pos, uv, count } = this.buildGeometry(x, y, scale);
    if (count === 0) return;
    const gl = this.gl;
    const posBuf = createBuffer(gl, gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const uvBuf = createBuffer(gl, gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    this.entries.set(key, { posBuf, uvBuf, count, texture, tint: opts?.tint ?? [1, 1, 1], additive: opts?.additive ?? false, mask: opts?.mask ?? false, half: scale, alpha: opts?.alpha ?? 1, hidden: false });
    // Decode the BLP once (synchronous); the GL texture is uploaded lazily in render().
    if (!this.textures.has(texture)) {
      this.textures.set(texture, { canvas: this.loader(texture), tex: null });
    }
  }

  /** Re-fade an existing splat without rebuilding its geometry (a spell splat's
   *  Birth/Pause/Decay envelope, ticked per frame). */
  setAlpha(id: string | number, alpha: number): void {
    const e = this.entries.get(String(id));
    if (e) e.alpha = alpha;
  }

  /** Show or withhold a splat without forgetting it (see `SplatEntry.hidden`). Idempotent
   *  and cheap — a flag flip, no geometry work — so a per-frame visibility sync may call it
   *  for every building splat every frame. */
  setVisible(id: string | number, visible: boolean): void {
    const e = this.entries.get(String(id));
    if (e) e.hidden = !visible;
  }

  remove(id: string | number): void {
    const key = String(id);
    const e = this.entries.get(key);
    if (!e) return;
    this.gl.deleteBuffer(e.posBuf);
    this.gl.deleteBuffer(e.uvBuf);
    this.entries.delete(key);
  }

  /** Prune splats whose id no longer passes `alive` (a destroyed sim building).
   *  Only the caller's tracked ids should be passed as `managed`. */
  reconcile(managed: Iterable<string | number>, alive: (id: string | number) => boolean): void {
    for (const id of managed) {
      if (this.entries.has(String(id)) && !alive(id)) this.remove(id);
    }
  }

  /** Tessellate a splat's square over the terrain corner grid it covers. Each corner
   *  sits at the terrain's own height (cornerHeight·CELL) so the decal is coplanar
   *  with the ground; UVs map the [center ± scale] box to [0,1]. Non-indexed tris,
   *  BR–TL diagonal to match the viewer's terrain + the fog mesh. */
  private buildGeometry(cx: number, cy: number, scale: number): { pos: Float32Array; uv: Float32Array; count: number } {
    const { width, height, centerOffset, corners } = this.terrain;
    const ox = centerOffset[0];
    const oy = centerOffset[1];
    const minX = cx - scale;
    const minY = cy - scale;
    const span = 2 * scale;
    // Corner-grid cell range overlapping the box (clamped to the map).
    const gx0 = clamp(Math.floor((minX - ox) / CELL), 0, width - 2);
    const gx1 = clamp(Math.ceil((cx + scale - ox) / CELL), gx0 + 1, width - 1);
    const gy0 = clamp(Math.floor((minY - oy) / CELL), 0, height - 2);
    const gy1 = clamp(Math.ceil((cy + scale - oy) / CELL), gy0 + 1, height - 1);

    const cellsX = gx1 - gx0;
    const cellsY = gy1 - gy0;
    const pos = new Float32Array(cellsX * cellsY * 6 * 3);
    const uv = new Float32Array(cellsX * cellsY * 6 * 2);
    let pi = 0;
    let ui = 0;
    const cw = (gxi: number, gyi: number): number => cornerHeight(corners[gyi * width + gxi]) * CELL + LIFT;
    const emit = (gxi: number, gyi: number): void => {
      const wx = ox + gxi * CELL;
      const wy = oy + gyi * CELL;
      pos[pi++] = wx;
      pos[pi++] = wy;
      pos[pi++] = cw(gxi, gyi);
      uv[ui++] = (wx - minX) / span;
      uv[ui++] = (wy - minY) / span;
    };
    for (let gy = gy0; gy < gy1; gy++) {
      for (let gx = gx0; gx < gx1; gx++) {
        // faces [BL, BR, TL, BR, TR, TL] — same split as terrain.ts / fogOverlay.
        emit(gx, gy); emit(gx + 1, gy); emit(gx, gy + 1);
        emit(gx + 1, gy); emit(gx + 1, gy + 1); emit(gx, gy + 1);
      }
    }
    return { pos, uv, count: cellsX * cellsY * 6 };
  }

  /** Draw all splats. Call every frame AFTER the viewer renders the world and BEFORE
   *  the fog (so the fog veil dims the decals like the ground). No-op if empty. */
  render(viewProj: Float32Array | Iterable<number>): void {
    if (this.entries.size === 0) return;
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
    // Snapshot every vertex-attrib array's enabled flag — the viewer leaves strays
    // enabled with no buffer bound, which trips INVALID_OPERATION on our draw (see
    // FogOverlay). Disable all but ours, then restore exactly.
    const prevAttribEnabled: boolean[] = [];
    for (let i = 0; i < this.maxAttribs; i++) {
      prevAttribEnabled[i] = gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean;
    }

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
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
    gl.enableVertexAttribArray(this.aPos);
    gl.enableVertexAttribArray(this.aUv);

    for (const e of this.entries.values()) {
      if (e.hidden || e.alpha <= 0) continue; // fog-withheld, or fully faded out
      const tex = this.resolveTexture(e.texture);
      if (!tex) continue; // texture missing/undecodable — skip
      // Per-entry blend: additive for glowing selection rings, alpha for foundation
      // decals. SRC_ALPHA on both so the texture's alpha still shapes the mark.
      if (e.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform3fv(this.uTint, e.tint);
      gl.uniform1f(this.uAlpha, e.alpha);
      gl.uniform1f(this.uMask, e.mask ? 1 : 0);
      gl.uniform1f(this.uHalf, e.half);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindBuffer(gl.ARRAY_BUFFER, e.posBuf);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, e.uvBuf);
      gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, e.count);
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
    // Mipmap only power-of-two textures — WebGL1 rejects generateMipmap on NPOT.
    // WC3 splat BLPs are POT (e.g. 256²), but guard so an odd one still renders.
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
    for (const e of this.entries.values()) {
      gl.deleteBuffer(e.posBuf);
      gl.deleteBuffer(e.uvBuf);
    }
    this.entries.clear();
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
    throw new Error(`UberSplat shader compile failed: ${log}`);
  }
  return sh;
}

function compileProgram(gl: GL, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`UberSplat program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function createBuffer(gl: GL, target: number, data: ArrayBufferView, usage: number): WebGLBuffer {
  const buf = gl.createBuffer()!;
  gl.bindBuffer(target, buf);
  gl.bufferData(target, data, usage);
  return buf;
}
