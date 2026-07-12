// Weather — the map's atmosphere (7.23; issue #33, see docs/triggers.md).
//
// Rain, snow, fog, light-rays and wind, all from ONE data-driven particle emitter whose
// every parameter comes out of `TerrainArt\Weather.slk` (src/data/weather.ts). Nothing here
// is invented: emission height, speed, tilt, lifespan, the streak length, the sprite atlas
// and the three-key colour/alpha/scale ramps are all columns of that table.
//
// A particle is drawn one of two ways, and the table says which (`head` / `tail`):
//   • HEAD — a camera-facing billboard (a snowflake, a fog puff, a wind-blown cloud).
//   • TAIL — a quad STRETCHED along the particle's velocity (a rain streak, a shaft of
//     light). Its length is `|veloc| × taillen` world units — which is why rain (1200 ×
//     0.1) draws a 120-unit streak and moonlight (300 × 10) draws a 3000-unit shaft.
//
// ### The emitter follows the CAMERA, inside the rect
//
// `AddWeatherEffect` bounds an effect to a rect, and most maps hand it the whole playable
// map. The table's particle budget (1800 for heavy rain) is a SCREEN-full, not a map-full —
// spread 1800 raindrops over a 100 000-unit map and you would see one every few minutes. So
// particles are emitted over the rect ∩ the ground the camera can actually see, which keeps
// on-screen density constant no matter how big the rect is. Once born they live in world
// space and fall where they fall, so panning doesn't drag them along.
//
// GL discipline mirrors ShadowOverlay/UberSplatOverlay: mdx-m3-viewer wraps WebGL in a
// JS-side state cache, so we snapshot and restore everything we touch.

import type { WeatherDef } from "../data/weather";

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
  vec4 t = texture2D(uTex, vUv);
  vec4 c = t * vColor;
  if (c.a < 0.004) discard;
  gl_FragColor = c;
}`;

/** Total live particles across every effect. Heavy rain alone asks for 1800; this is a
 *  backstop so a map that stacks several effects can't melt the frame. */
const MAX_PARTICLES = 24000;

/** How much ground the emitter covers, as a multiple of the camera's distance. The spawn
 *  box is this square (centred on the view) intersected with the effect's rect — big enough
 *  that particles are already falling before they enter shot, without wasting any far
 *  off-screen. Tunable live. */
const SPAN_PER_DISTANCE = 2.6;
const MIN_SPAN = 2500;

/** Longest step the emitter will integrate in one go (seconds). A dropped frame or an
 *  alt-tab must resume the storm, not teleport every particle through its whole life. */
const MAX_STEP = 0.1;

/** Overall particle size multiplier on the SLK's `scale*` columns. The table's scales are in
 *  world units (a fog puff at 100 is ~1.5 terrain tiles across, a rain streak 1 unit wide) —
 *  1.0 means "take the table at its word". Kept as a knob because it is the one number the
 *  data does not pin down beyond doubt, and it is the first thing to A/B in the browser. */
const SIZE_SCALE = 1;

type GL = WebGLRenderingContext;

export type TextureLoader = (path: string) => HTMLCanvasElement | null;

/** The rect an effect is bounded to (AddWeatherEffect's `where`). */
export interface WeatherArea {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Where the camera is looking, so the emitter can follow it. */
export interface WeatherView {
  targetX: number;
  targetY: number;
  distance: number;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
}

interface Effect {
  id: number;
  def: WeatherDef;
  area: WeatherArea;
  enabled: boolean;
  particles: Particle[];
}

interface Batch {
  pos: Float32Array;
  uv: Float32Array;
  color: Float32Array;
  cap: number; // vertex capacity
  count: number; // verts filled this frame
  posBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  colorBuf: WebGLBuffer;
  glCap: number;
  additive: boolean;
}

interface CachedTexture {
  canvas: HTMLCanvasElement | null;
  tex: WebGLTexture | null;
}

export class WeatherOverlay {
  private gl: GL;
  private loader: TextureLoader;
  private heightAt: (x: number, y: number) => number;
  private program: WebGLProgram;
  private aPos: number;
  private aUv: number;
  private aColor: number;
  private uViewProj: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private maxAttribs: number;
  private effects = new Map<number, Effect>();
  private batches = new Map<string, Batch>(); // key = `${texture}|${additive}`
  private textures = new Map<string, CachedTexture>();
  private nextId = 1;
  private live = 0; // live particles across all effects (against MAX_PARTICLES)
  private warnedDt = false;
  /** Live-tunable knobs (A/B in the browser without a rebuild). */
  sizeScale = SIZE_SCALE;
  spanPerDistance = SPAN_PER_DISTANCE;

  constructor(gl: GL, loader: TextureLoader, heightAt: (x: number, y: number) => number) {
    this.gl = gl;
    this.loader = loader;
    this.heightAt = heightAt;
    this.maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
    this.program = compileProgram(gl, VERT_SRC, FRAG_SRC);
    this.aPos = gl.getAttribLocation(this.program, "aPos");
    this.aUv = gl.getAttribLocation(this.program, "aUv");
    this.aColor = gl.getAttribLocation(this.program, "aColor");
    this.uViewProj = gl.getUniformLocation(this.program, "uViewProj")!;
    this.uTex = gl.getUniformLocation(this.program, "uTex")!;
  }

  /** JASS `AddWeatherEffect(where, effectID)` — created DISABLED, exactly as the native
   *  leaves it: the editor always emits `EnableWeatherEffect(we, true)` on the next line,
   *  which would be pointless if the native started it. Returns the effect's id. */
  add(def: WeatherDef, area: WeatherArea): number {
    const id = this.nextId++;
    this.effects.set(id, { id, def, area, enabled: false, particles: [] });
    if (!this.textures.has(def.texture)) {
      this.textures.set(def.texture, { canvas: this.loader(def.texture), tex: null });
    }
    return id;
  }

  /** JASS `EnableWeatherEffect(we, flag)`. Disabling keeps the effect (and its particles
   *  die off naturally) so it can be switched back on — a map toggles a storm on and off. */
  enable(id: number, on: boolean): void {
    const e = this.effects.get(id);
    if (e) e.enabled = on;
  }

  /** JASS `RemoveWeatherEffect(we)` — gone, particles and all. */
  remove(id: number): void {
    const e = this.effects.get(id);
    if (!e) return;
    this.live -= e.particles.length;
    this.effects.delete(id);
  }

  has(id: number): boolean {
    return this.effects.has(id);
  }

  /** For the live checks: how many particles are actually in flight. */
  get particleCount(): number {
    return this.live;
  }

  /** Advance every enabled effect. `view` is where the camera is looking, so the emitter can
   *  keep the on-screen density right whatever the rect's size. */
  update(dt: number, view: WeatherView): void {
    if (dt <= 0) return;
    // `dt` is SECONDS. Say so loudly, because getting it wrong is invisible: fed the frame
    // loop's milliseconds, every particle outlived its (1–6 second) lifespan on its first
    // frame and respawned on the spot, so the emitter rendered a field of age-0 particles
    // re-randomised each frame — which in a still screenshot is indistinguishable from
    // falling snow, and never moves. Cost an hour. The clamp is also the right thing for a
    // real stall (alt-tab): resume the storm, don't teleport it.
    if (dt > 1) {
      if (!this.warnedDt) {
        this.warnedDt = true;
        console.warn(`[weather] update() got dt=${dt} — it takes SECONDS, not milliseconds.`);
      }
      dt = MAX_STEP;
    }
    dt = Math.min(dt, MAX_STEP);
    const span = Math.max(MIN_SPAN, view.distance * this.spanPerDistance);
    for (const e of this.effects.values()) {
      const def = e.def;
      // The box we may spawn into: the rect, clipped to the ground the camera can see.
      const minX = Math.max(e.area.minX, view.targetX - span / 2);
      const maxX = Math.min(e.area.maxX, view.targetX + span / 2);
      const minY = Math.max(e.area.minY, view.targetY - span / 2);
      const maxY = Math.min(e.area.maxY, view.targetY + span / 2);
      const canSpawn = e.enabled && maxX > minX && maxY > minY;

      // Integrate, and recycle whatever died. A dead particle is respawned in place rather
      // than churning the array — this keeps the pool at a steady `particles` with no
      // allocation once it has warmed up.
      for (let i = e.particles.length - 1; i >= 0; i--) {
        const p = e.particles[i];
        p.age += dt;
        if (p.age >= p.life) {
          if (!canSpawn) {
            // Effect switched off (or the camera left the rect) — let the pool drain.
            e.particles.splice(i, 1);
            this.live--;
            continue;
          }
          this.spawn(p, def, minX, maxX, minY, maxY);
          continue;
        }
        p.vz += def.accel * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
      }

      // Grow toward the table's budget. `particles` IS the steady-state population (it is
      // exactly emrate × lifespan × 20 in every row — see src/data/weather.ts), so we fill
      // the pool over one lifespan rather than all at once: a storm rolls in, it doesn't
      // blink into existence.
      if (!canSpawn) continue;
      const want = Math.min(def.particles, MAX_PARTICLES - (this.live - e.particles.length));
      const perSecond = def.particles / def.lifespan;
      const budget = Math.min(want - e.particles.length, Math.ceil(perSecond * dt) + 1);
      for (let i = 0; i < budget; i++) {
        const p: Particle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: def.lifespan };
        this.spawn(p, def, minX, maxX, minY, maxY);
        // A fresh pool would otherwise all be born at the same height and fall as one sheet;
        // ageing each new particle randomly scatters them through the column at once.
        p.age = Math.random() * def.lifespan;
        p.x += p.vx * p.age;
        p.y += p.vy * p.age;
        p.z += p.vz * p.age;
        e.particles.push(p);
        this.live++;
      }
    }
  }

  /** (Re)birth a particle at the top of the column, with the table's tilt and scatter. */
  private spawn(p: Particle, def: WeatherDef, minX: number, maxX: number, minY: number, maxY: number): void {
    p.x = minX + Math.random() * (maxX - minX);
    p.y = minY + Math.random() * (maxY - minY);
    p.z = this.heightAt(p.x, p.y) + def.height;
    p.age = 0;
    p.life = def.lifespan;

    // `veloc` is the speed along the emission axis — NEGATIVE means falling. `var` jitters
    // it, so a snowfield doesn't descend in lock-step.
    const speed = Math.abs(def.veloc) * (1 + (Math.random() * 2 - 1) * def.variance);
    const sign = def.veloc < 0 ? -1 : 1;
    // `angx`/`angy` tilt the axis off vertical, in degrees — a 5° lean is what slants the
    // rain, and Outland's -50°/+50° is what makes its wind blow the clouds sideways.
    let vx = speed * Math.tan((def.angx * Math.PI) / 180);
    let vy = speed * Math.tan((def.angy * Math.PI) / 180);
    // `lati` scatters each particle within a cone of that half-angle about the axis.
    if (def.lati > 0) {
      const t = Math.random() * ((def.lati * Math.PI) / 180);
      const a = Math.random() * Math.PI * 2;
      vx += speed * Math.tan(t) * Math.cos(a);
      vy += speed * Math.tan(t) * Math.sin(a);
    }
    p.vx = vx;
    p.vy = vy;
    p.vz = sign * speed;
  }

  /** Build this frame's geometry and draw it. Call after the world is rendered. */
  render(viewProj: Float32Array | Iterable<number>, camPos: ArrayLike<number>, camRight: ArrayLike<number>, camUp: ArrayLike<number>): void {
    for (const b of this.batches.values()) b.count = 0;
    let any = false;
    for (const e of this.effects.values()) {
      if (!e.particles.length) continue;
      this.buildBatch(e, camPos, camRight, camUp);
      any = true;
    }
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
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // Particles are transparent and unordered — they must NOT write depth, or the ones drawn
    // first would punch holes in the ones behind them. They still TEST, so a raindrop behind
    // a cliff is correctly hidden by it.
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (i !== this.aPos && i !== this.aUv && i !== this.aColor) gl.disableVertexAttribArray(i);
    }
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj as Float32Array);
    gl.uniform1i(this.uTex, 0);
    gl.enableVertexAttribArray(this.aPos);
    gl.enableVertexAttribArray(this.aUv);
    gl.enableVertexAttribArray(this.aColor);

    for (const [key, batch] of this.batches) {
      if (batch.count === 0) continue;
      const tex = this.resolveTexture(key.slice(0, key.lastIndexOf("|")));
      if (!tex) continue;
      // `alphaMode` picks the blend: 0 = ordinary alpha (snow — solid little flakes),
      // 1 = ADDITIVE (rain, fog, light rays, cloud), which is what makes them glow against
      // the terrain rather than smear it.
      if (batch.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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

  /** Turn one effect's live particles into two triangles each, in its texture's batch. */
  private buildBatch(e: Effect, camPos: ArrayLike<number>, camRight: ArrayLike<number>, camUp: ArrayLike<number>): void {
    const def = e.def;
    const batch = this.batchFor(def);
    this.ensureCapacity(batch, batch.count + e.particles.length * 6);
    const { pos, uv, color } = batch;
    const frames = def.texRows * def.texCols;

    for (const p of e.particles) {
      const t = p.age / p.life;
      const [r, g, b] = this.ramp3(def.colorStart, def.colorMid, def.colorEnd, t, def.midTime);
      const a = this.ramp(def.alphaStart, def.alphaMid, def.alphaEnd, t, def.midTime) / 255;
      if (a <= 0.002) continue;
      const scale = this.ramp(def.scaleStart, def.scaleMid, def.scaleEnd, t, def.midTime) * this.sizeScale;
      if (scale <= 0) continue;

      // The sprite-atlas frame (`texr`×`texc`), animated over the particle's life by the
      // hUV ramp — 1×1 for everything but the 8×8 cloud sheet, where 0→32→63 walks the sheet.
      let u0 = 0, v0 = 0, uw = 1, vh = 1;
      if (frames > 1) {
        const f = Math.min(frames - 1, Math.max(0, Math.round(this.ramp(def.uvStart, def.uvMid, def.uvEnd, t, def.midTime))));
        uw = 1 / def.texCols;
        vh = 1 / def.texRows;
        u0 = (f % def.texCols) * uw;
        v0 = Math.floor(f / def.texCols) * vh;
      }

      // Two corner axes. A HEAD particle is a camera-facing billboard; a TAIL particle is a
      // quad stretched back along its own velocity (the rain streak), rotated about that
      // axis to face the camera.
      let ax: number, ay: number, az: number; // "along" (half-length)
      let sx: number, sy: number, sz: number; // "side"  (half-width)
      let cx = p.x, cy = p.y, cz = p.z;
      if (def.tail) {
        const sp = Math.hypot(p.vx, p.vy, p.vz) || 1;
        const dx = p.vx / sp, dy = p.vy / sp, dz = p.vz / sp;
        const len = Math.abs(def.veloc) * def.taillen; // the streak's world length
        // The quad runs from the particle's head BACK along the velocity, so the streak
        // trails behind the drop rather than straddling it.
        cx -= (dx * len) / 2;
        cy -= (dy * len) / 2;
        cz -= (dz * len) / 2;
        ax = (dx * len) / 2;
        ay = (dy * len) / 2;
        az = (dz * len) / 2;
        // side = normalize(dir × view) — keeps the flat streak turned toward the camera.
        const vx = cx - camPos[0], vy = cy - camPos[1], vz = cz - camPos[2];
        let nx = dy * vz - dz * vy;
        let ny = dz * vx - dx * vz;
        let nz = dx * vy - dy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        sx = nx * scale; sy = ny * scale; sz = nz * scale;
      } else {
        ax = camUp[0] * scale; ay = camUp[1] * scale; az = camUp[2] * scale;
        sx = camRight[0] * scale; sy = camRight[1] * scale; sz = camRight[2] * scale;
      }

      // corners: (-s,-a) (+s,-a) (+s,+a) (-s,+a) → two triangles
      const px = [cx - sx - ax, cx + sx - ax, cx + sx + ax, cx - sx + ax];
      const py = [cy - sy - ay, cy + sy - ay, cy + sy + ay, cy - sy + ay];
      const pz = [cz - sz - az, cz + sz - az, cz + sz + az, cz - sz + az];
      const qu = [u0, u0 + uw, u0 + uw, u0];
      const qv = [v0 + vh, v0 + vh, v0, v0];
      const order = [0, 1, 2, 0, 2, 3];
      for (const i of order) {
        const o3 = batch.count * 3;
        const o2 = batch.count * 2;
        const o4 = batch.count * 4;
        pos[o3] = px[i]; pos[o3 + 1] = py[i]; pos[o3 + 2] = pz[i];
        uv[o2] = qu[i]; uv[o2 + 1] = qv[i];
        color[o4] = r; color[o4 + 1] = g; color[o4 + 2] = b; color[o4 + 3] = a;
        batch.count++;
      }
    }
  }

  /** The SLK's three-key ramps: start → mid (at `midTime` of the life) → end. */
  private ramp(s: number, m: number, e: number, t: number, midTime: number): number {
    if (t <= midTime) return s + ((m - s) * (midTime > 0 ? t / midTime : 1));
    const k = midTime < 1 ? (t - midTime) / (1 - midTime) : 1;
    return m + (e - m) * k;
  }

  private ramp3(s: [number, number, number], m: [number, number, number], e: [number, number, number], t: number, midTime: number): [number, number, number] {
    return [
      this.ramp(s[0], m[0], e[0], t, midTime) / 255,
      this.ramp(s[1], m[1], e[1], t, midTime) / 255,
      this.ramp(s[2], m[2], e[2], t, midTime) / 255,
    ];
  }

  private batchFor(def: WeatherDef): Batch {
    const key = `${def.texture}|${def.additive}`;
    let b = this.batches.get(key);
    if (!b) {
      const gl = this.gl;
      const cap = 2048 * 6;
      b = {
        pos: new Float32Array(cap * 3),
        uv: new Float32Array(cap * 2),
        color: new Float32Array(cap * 4),
        cap,
        count: 0,
        posBuf: gl.createBuffer()!,
        uvBuf: gl.createBuffer()!,
        colorBuf: gl.createBuffer()!,
        glCap: 0,
        additive: def.additive,
      };
      this.batches.set(key, b);
    }
    return b;
  }

  private ensureCapacity(batch: Batch, verts: number): void {
    if (verts <= batch.cap) return;
    let cap = batch.cap;
    while (cap < verts) cap *= 2;
    const pos = new Float32Array(cap * 3);
    const uv = new Float32Array(cap * 2);
    const color = new Float32Array(cap * 4);
    pos.set(batch.pos.subarray(0, batch.count * 3));
    uv.set(batch.uv.subarray(0, batch.count * 2));
    color.set(batch.color.subarray(0, batch.count * 4));
    batch.pos = pos;
    batch.uv = uv;
    batch.color = color;
    batch.cap = cap;
  }

  private uploadBatch(batch: Batch): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.posBuf);
    if (batch.count > batch.glCap) gl.bufferData(gl.ARRAY_BUFFER, batch.cap * 3 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.pos.subarray(0, batch.count * 3));
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.uvBuf);
    if (batch.count > batch.glCap) gl.bufferData(gl.ARRAY_BUFFER, batch.cap * 2 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.uv.subarray(0, batch.count * 2));
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.colorBuf);
    if (batch.count > batch.glCap) gl.bufferData(gl.ARRAY_BUFFER, batch.cap * 4 * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.color.subarray(0, batch.count * 4));
    if (batch.count > batch.glCap) batch.glCap = batch.cap;
  }

  private resolveTexture(path: string): WebGLTexture | null {
    const cached = this.textures.get(path);
    if (!cached || !cached.canvas) return null;
    if (cached.tex) return cached.tex;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cached.canvas);
    // NO MIPMAPS — and this is the difference between snow you can see and snow you cannot.
    // A snowflake is a 4-world-unit quad, which at gameplay zoom is about TWO PIXELS. Ask for
    // a mipmap and the GPU picks a deep level where the flake — which fills 94 % of its 32²
    // sprite — has been averaged down to a smear of low alpha, and the whole snowfall renders
    // as an almost invisible haze. (It was drawing all along: 24 000 verts a frame, texture
    // bound, blend on, and nothing on screen.) Sampling the full-res sprite instead is both
    // brighter and correct: a particle is a screen-space sprite, not a surface seen at
    // distance, so there is no minification to prefilter. Found by A/B-ing it in the browser.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // CLAMP, not REPEAT: an atlas frame must not bleed into its neighbour across the sheet.
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
      gl.deleteBuffer(b.colorBuf);
    }
    this.batches.clear();
    for (const t of this.textures.values()) if (t.tex) gl.deleteTexture(t.tex);
    this.textures.clear();
    this.effects.clear();
    this.live = 0;
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
    throw new Error(`Weather shader compile failed: ${log}`);
  }
  return sh;
}

function compileProgram(gl: GL, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Weather program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}
