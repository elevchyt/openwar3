// Lightning effects — the ribbons WC3 strings between two units (issue #97).
//
// Chain Lightning, Healing Wave, Finger of Death, Forked Lightning, Mana Burn, Spirit Link
// and the Drains have no effect MODEL: the engine draws a camera-facing textured ribbon
// from a source point to a target point and keeps it stretched between them, following both
// while it lives. That is why these spells landed with no art at all — there was no .mdx to
// play, and nothing in the ability's Target/Caster/Special art fields to find.
//
// Everything about the look comes out of `Splats\LightningData.slk` (src/data/lightning.ts):
// the texture, the ribbon width, the tint, how far it frays, and how fast the texture
// crawls along it. The texture is a 256×64 horizontal STRIP with the bolt drawn into it on
// black — authored for ADDITIVE blending and for tiling along U, which is why the geometry
// here is a nearly straight ribbon rather than a hand-drawn zig-zag: the jaggedness is
// painted, and `NoiseScale` only frays the ribbon's spine over long spans.
//
// Drawn as our OWN GL pass after the world's translucent instances and BEFORE the fog, like
// UberSplatOverlay/WeatherOverlay — mdx-m3-viewer offers no hook for geometry of our own.
// Same GL discipline as those: the viewer caches WebGL state on the JS side, so every bit of
// state this touches is snapshotted and restored.

import type { LightningDef, LightningRegistry } from "../data/lightning";

const VERT_SRC = `
attribute vec3 aPos;
attribute vec2 aUv;
attribute vec4 aColor;
uniform mat4 uViewProj;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = aUv;
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 c = texture2D(uTex, vUv) * vColor;
  if (c.a < 0.004) discard;
  gl_FragColor = c;
}`;

/** How fast the texture crawls along a bolt, in texture spans per second, BEFORE the row's
 *  `TexCoordScale` divides it ("higher values => very slow, low values => very fast" —
 *  Hive thread 203171). The table gives a relative scale, never an absolute rate, so this
 *  is the one number here that is ours: 1.0 makes CLPB (0.5) cycle twice a second, which
 *  reads as crackling electricity, and the drains (-0.8) crawl backwards toward the caster
 *  at 1.25/s. Tune this and every bolt keeps its RELATIVE speed. */
const SCROLL_SPANS_PER_SEC = 1;

/** How often the fray is re-rolled, per second. WC3's bolts crackle rather than undulate,
 *  so the noise is stepped, not interpolated — a rope that waves smoothly reads as a rope. */
const NOISE_HZ = 14;

/** Cap on a bolt's geometry segments. `AvgSegLen` is 50–100 world units and a bolt is a
 *  cast range at most, so this is a backstop against a custom row with a tiny value, not a
 *  budget anything real runs into. */
const MAX_SEGMENTS = 48;

type GL = WebGLRenderingContext;

/** Decode a BLP path to a canvas (or null if absent) — the scene's loader. */
export type TextureLoader = (path: string) => HTMLCanvasElement | null;

/** Where a bolt's two ends are RIGHT NOW, in world space (z includes the terrain). The
 *  scene answers this every frame, because both ends may be walking: returning null retires
 *  the bolt, and `visible: false` withholds it for a frame (both ends in the fog). */
export interface BoltEnds {
  sx: number;
  sy: number;
  sz: number;
  tx: number;
  ty: number;
  tz: number;
  visible: boolean;
}

/** One live bolt. `srcId`/`dstId` are sim unit ids (0 = a fixed point); the resolver turns
 *  them into positions each frame. */
export interface BoltRequest {
  type: string; // LightningData row id
  srcId: number;
  dstId: number;
  sx: number;
  sy: number;
  sz: number; // height ABOVE GROUND
  tx: number;
  ty: number;
  tz: number;
  life: number; // 0 = use the row's own fade duration
  delay: number;
}

interface Bolt {
  def: LightningDef;
  req: BoltRequest;
  t: number; // seconds since it was requested (the delay is inside this)
  life: number; // resolved lifetime
  seed: number;
}

interface Batch {
  pos: Float32Array;
  uv: Float32Array;
  color: Float32Array;
  count: number; // vertices written
  cap: number; // vertices the arrays hold
  posBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  colorBuf: WebGLBuffer;
  glCap: number;
}

interface CachedTexture {
  canvas: HTMLCanvasElement | null;
  tex: WebGLTexture | null;
}

export class LightningOverlay {
  private gl: GL;
  private loader: TextureLoader;
  private defs: LightningRegistry;
  private program: WebGLProgram;
  private aPos: number;
  private aUv: number;
  private aColor: number;
  private uViewProj: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private maxAttribs: number;
  private bolts: Bolt[] = [];
  private batches = new Map<string, Batch>();
  private textures = new Map<string, CachedTexture>();
  private clock = 0; // seconds since the overlay was created (scroll + noise phase)
  private nextSeed = 1;

  constructor(gl: GL, loader: TextureLoader, defs: LightningRegistry) {
    this.gl = gl;
    this.loader = loader;
    this.defs = defs;
    this.maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
    this.program = compileProgram(gl, VERT_SRC, FRAG_SRC);
    this.aPos = gl.getAttribLocation(this.program, "aPos");
    this.aUv = gl.getAttribLocation(this.program, "aUv");
    this.aColor = gl.getAttribLocation(this.program, "aColor");
    this.uViewProj = gl.getUniformLocation(this.program, "uViewProj")!;
    this.uTex = gl.getUniformLocation(this.program, "uTex")!;
  }

  get count(): number {
    return this.bolts.length;
  }

  /** Start a bolt. Unknown row ids are dropped silently — a custom map may name one that
   *  its own LightningData.slk defines and we never loaded. */
  add(req: BoltRequest): void {
    const def = this.defs.get(req.type);
    if (!def) return;
    this.bolts.push({ def, req, t: 0, life: req.life > 0 ? req.life : def.duration, seed: this.nextSeed++ });
    if (!this.textures.has(def.texture)) this.textures.set(def.texture, { canvas: this.loader(def.texture), tex: null });
  }

  /** Advance every bolt's clock and retire the finished ones. Separate from render() so the
   *  bolts age on the sim's paused/unpaused clock rather than the frame's. */
  update(dt: number): void {
    this.clock += dt;
    let w = 0;
    for (const b of this.bolts) {
      b.t += dt;
      if (b.t - b.req.delay <= b.life) this.bolts[w++] = b;
    }
    this.bolts.length = w;
  }

  /** Drop every live bolt (map teardown, a fresh match). */
  clear(): void {
    this.bolts.length = 0;
  }

  /** Draw. `resolve` supplies both ends of each bolt in world space this frame; `camPos`
   *  faces the ribbons at the eye. Call AFTER the world's translucent pass and BEFORE the
   *  fog, so the veil dims a bolt cast at the edge of sight like everything else. */
  render(viewProj: Float32Array | Iterable<number>, camPos: ArrayLike<number>, resolve: (b: BoltRequest) => BoltEnds | null): void {
    for (const batch of this.batches.values()) batch.count = 0;
    let any = false;
    let w = 0;
    for (const b of this.bolts) {
      const ends = resolve(b.req);
      if (ends === null) continue; // an end went away for good — retire the bolt with it
      this.bolts[w++] = b;
      const age = b.t - b.req.delay;
      if (age < 0 || !ends.visible) continue; // not struck yet, or nobody can see it
      // Both ends keep following their units, so a bolt cast on a unit that then walks
      // away stays attached — and the anchor moves with it, which is what leaves the bolt
      // in a sensible place if that unit dies mid-strike.
      b.req.sx = ends.sx;
      b.req.sy = ends.sy;
      b.req.tx = ends.tx;
      b.req.ty = ends.ty;
      this.buildBolt(b, ends, camPos, age);
      any = true;
    }
    this.bolts.length = w;
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
    const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    gl.activeTexture(gl.TEXTURE0);
    const prevTex0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const prevAttribEnabled: boolean[] = [];
    for (let i = 0; i < this.maxAttribs; i++) {
      prevAttribEnabled[i] = gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_ENABLED) as boolean;
    }

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    // The strips are painted on black for ADDITIVE compositing — that is what makes a bolt
    // glow over the terrain instead of stamping a black box around itself.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false); // sit on the world's depth: a bolt behind a cliff is hidden by it
    gl.disable(gl.CULL_FACE); // the ribbon is two-sided
    for (let i = 0; i < this.maxAttribs; i++) {
      if (i !== this.aPos && i !== this.aUv && i !== this.aColor) gl.disableVertexAttribArray(i);
    }
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj as Float32Array);
    gl.uniform1i(this.uTex, 0);
    gl.enableVertexAttribArray(this.aPos);
    gl.enableVertexAttribArray(this.aUv);
    gl.enableVertexAttribArray(this.aColor);

    for (const [texture, batch] of this.batches) {
      if (batch.count === 0) continue;
      const tex = this.resolveTexture(texture);
      if (!tex) continue;
      this.uploadBatch(batch);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.posBuf);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.uvBuf);
      gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.colorBuf);
      gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, batch.count);
    }

    gl.bindTexture(gl.TEXTURE_2D, prevTex0);
    gl.activeTexture(prevActiveTex);
    gl.useProgram(prevProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuf);
    setEnabled(gl, gl.BLEND, prevBlend);
    setEnabled(gl, gl.DEPTH_TEST, prevDepthTest);
    setEnabled(gl, gl.CULL_FACE, prevCull);
    gl.depthFunc(prevDepthFunc);
    gl.depthMask(prevDepthMask);
    gl.blendFuncSeparate(prevBlendSrcRGB, prevBlendDstRGB, prevBlendSrcA, prevBlendDstA);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (prevAttribEnabled[i]) gl.enableVertexAttribArray(i);
      else gl.disableVertexAttribArray(i);
    }
  }

  /** Tessellate one bolt into its texture's batch: a chain of `AvgSegLen`-long segments from
   *  source to target, each joint frayed sideways, each quad turned to face the eye. */
  private buildBolt(b: Bolt, ends: BoltEnds, camPos: ArrayLike<number>, age: number): void {
    const def = b.def;
    const dx = ends.tx - ends.sx;
    const dy = ends.ty - ends.sy;
    const dz = ends.tz - ends.sz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1) return; // both ends on the same spot — nothing to string

    // The fade: the row's `Duration` is "how long it will take to naturally fade", so it is
    // the tail of the bolt's life, not its length. A bolt shorter-lived than its own fade
    // (Finger of Death's 1s against AFOD's 2s) simply fades across all of it.
    const fade = Math.min(def.duration, b.life);
    const alpha = def.alpha * (age > b.life - fade ? Math.max(0, (b.life - age) / fade) : 1);
    if (alpha <= 0) return;

    const segs = Math.max(1, Math.min(MAX_SEGMENTS, Math.round(len / Math.max(1, def.avgSegLen))));
    // `NoiseScale` frays proportionally to the SPAN — "how fuzzy the lightning will become
    // over long distances" — so a short bolt stays taut and a cross-map one crackles.
    const fray = def.noiseScale * len;
    // Two axes perpendicular to the bolt to fray along. `up` is world up unless the bolt is
    // near-vertical, in which case any horizontal axis will do.
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    let ax = -uy;
    let ay = ux;
    let az = 0;
    let aLen = Math.hypot(ax, ay, az);
    if (aLen < 1e-3) {
      ax = 1;
      ay = 0;
      az = 0;
      aLen = 1;
    }
    ax /= aLen;
    ay /= aLen;
    az /= aLen;
    const bx = uy * az - uz * ay;
    const by = uz * ax - ux * az;
    const bz = ux * ay - uy * ax;

    // Joint positions, frayed. Ends are pinned: a bolt must actually touch caster and target.
    const step = Math.floor(this.clock * NOISE_HZ); // stepped, so the fray crackles
    const px: number[] = [];
    const py: number[] = [];
    const pz: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const f = i / segs;
      let x = ends.sx + dx * f;
      let y = ends.sy + dy * f;
      let z = ends.sz + dz * f;
      if (i > 0 && i < segs) {
        // Taper the fray to nothing at both ends (sin) so the bolt leaves and lands straight.
        const taper = Math.sin(Math.PI * f) * fray;
        const n1 = noise(b.seed, i, step) * taper;
        const n2 = noise(b.seed, i + 977, step) * taper;
        x += ax * n1 + bx * n2;
        y += ay * n1 + by * n2;
        z += az * n1 + bz * n2;
      }
      px.push(x);
      py.push(y);
      pz.push(z);
    }

    // U across the whole bolt: `AvgSegLen` is also "the portion of the texture visible at
    // any instant (50 is half, 100 is full)", and the offset scrolls at 1/`TexCoordScale`
    // — negative on the drains, whose texture crawls back toward the caster.
    const span = def.avgSegLen / 100;
    const scroll = def.texCoordScale !== 0 ? (this.clock * SCROLL_SPANS_PER_SEC) / def.texCoordScale : 0;
    const half = def.width / 2;
    const batch = this.batchFor(def.texture, segs * 6);
    const [cr, cg, cb] = def.color;

    for (let i = 0; i < segs; i++) {
      // Face the quad at the eye: its width axis is perpendicular to both the segment and
      // the line of sight, so the ribbon stays edge-on-free from any camera angle.
      const sdx = px[i + 1] - px[i];
      const sdy = py[i + 1] - py[i];
      const sdz = pz[i + 1] - pz[i];
      const mx = (px[i] + px[i + 1]) / 2;
      const my = (py[i] + py[i + 1]) / 2;
      const mz = (pz[i] + pz[i + 1]) / 2;
      let ex = camPos[0] - mx;
      let ey = camPos[1] - my;
      let ez = camPos[2] - mz;
      let wx = sdy * ez - sdz * ey;
      let wy = sdz * ex - sdx * ez;
      let wz = sdx * ey - sdy * ex;
      const wl = Math.hypot(wx, wy, wz);
      if (wl < 1e-4) continue; // segment pointing straight at the eye — nothing to show
      wx = (wx / wl) * half;
      wy = (wy / wl) * half;
      wz = (wz / wl) * half;
      const u0 = scroll + span * (i / segs);
      const u1 = scroll + span * ((i + 1) / segs);
      // Two triangles: [a0 a1 b0] [a1 b1 b0] with a = this joint, b = the next.
      pushVert(batch, px[i] - wx, py[i] - wy, pz[i] - wz, u0, 0, cr, cg, cb, alpha);
      pushVert(batch, px[i] + wx, py[i] + wy, pz[i] + wz, u0, 1, cr, cg, cb, alpha);
      pushVert(batch, px[i + 1] - wx, py[i + 1] - wy, pz[i + 1] - wz, u1, 0, cr, cg, cb, alpha);
      pushVert(batch, px[i] + wx, py[i] + wy, pz[i] + wz, u0, 1, cr, cg, cb, alpha);
      pushVert(batch, px[i + 1] + wx, py[i + 1] + wy, pz[i + 1] + wz, u1, 1, cr, cg, cb, alpha);
      pushVert(batch, px[i + 1] - wx, py[i + 1] - wy, pz[i + 1] - wz, u1, 0, cr, cg, cb, alpha);
    }
  }

  /** The batch for a texture, grown to hold `need` more vertices. */
  private batchFor(texture: string, need: number): Batch {
    let batch = this.batches.get(texture);
    if (!batch) {
      const gl = this.gl;
      batch = {
        pos: new Float32Array(0),
        uv: new Float32Array(0),
        color: new Float32Array(0),
        count: 0,
        cap: 0,
        posBuf: gl.createBuffer()!,
        uvBuf: gl.createBuffer()!,
        colorBuf: gl.createBuffer()!,
        glCap: 0,
      };
      this.batches.set(texture, batch);
    }
    const want = batch.count + need;
    if (want > batch.cap) {
      const cap = Math.max(want, batch.cap * 2, 256);
      const pos = new Float32Array(cap * 3);
      const uv = new Float32Array(cap * 2);
      const color = new Float32Array(cap * 4);
      pos.set(batch.pos);
      uv.set(batch.uv);
      color.set(batch.color);
      batch.pos = pos;
      batch.uv = uv;
      batch.color = color;
      batch.cap = cap;
    }
    return batch;
  }

  private uploadBatch(batch: Batch): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.posBuf);
    if (batch.cap > batch.glCap) gl.bufferData(gl.ARRAY_BUFFER, batch.cap * 3 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.pos.subarray(0, batch.count * 3));
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.uvBuf);
    if (batch.cap > batch.glCap) gl.bufferData(gl.ARRAY_BUFFER, batch.cap * 2 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.uv.subarray(0, batch.count * 2));
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.colorBuf);
    if (batch.cap > batch.glCap) gl.bufferData(gl.ARRAY_BUFFER, batch.cap * 4 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.color.subarray(0, batch.count * 4));
    if (batch.cap > batch.glCap) batch.glCap = batch.cap;
  }

  /** Lazily upload a decoded BLP to a GL texture. WRAP_S is REPEAT, unlike every other
   *  overlay here: the strip is meant to tile along the bolt, and the scroll offset walks U
   *  past 1 within the first second. */
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
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    } else {
      // WebGL1 forbids REPEAT on a non-power-of-two texture; a custom row could ship one.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    cached.tex = tex;
    return tex;
  }

  dispose(): void {
    const gl = this.gl;
    for (const b of this.batches.values()) {
      gl.deleteBuffer(b.posBuf);
      gl.deleteBuffer(b.uvBuf);
      gl.deleteBuffer(b.colorBuf);
    }
    this.batches.clear();
    for (const t of this.textures.values()) if (t.tex) gl.deleteTexture(t.tex);
    this.textures.clear();
    this.bolts.length = 0;
    gl.deleteProgram(this.program);
  }
}

function pushVert(b: Batch, x: number, y: number, z: number, u: number, v: number, r: number, g: number, bl: number, a: number): void {
  const i = b.count;
  b.pos[i * 3] = x;
  b.pos[i * 3 + 1] = y;
  b.pos[i * 3 + 2] = z;
  b.uv[i * 2] = u;
  b.uv[i * 2 + 1] = v;
  b.color[i * 4] = r;
  b.color[i * 4 + 1] = g;
  b.color[i * 4 + 2] = bl;
  b.color[i * 4 + 3] = a;
  b.count = i + 1;
}

/** Deterministic pseudo-noise in [-1, 1] from (bolt, joint, time step). Deterministic so a
 *  bolt's fray is the same shape on every machine that draws it. */
function noise(seed: number, i: number, step: number): number {
  const s = Math.sin(seed * 127.1 + i * 311.7 + step * 74.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
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
    throw new Error(`Lightning shader compile failed: ${log}`);
  }
  return sh;
}

function compileProgram(gl: GL, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Lightning program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

/** Re-export so the scene can type a bolt without reaching into the data module. */
export type { LightningDef };
