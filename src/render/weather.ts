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
import { pipelineState } from "./glPipelineState";

// ### The particle lives in the VERTEX SHADER
//
// A weather particle is decided entirely at its birth: where it starts, which way it goes, when
// it was born and how long it lives. Everything after that — where it is now, its colour, its
// size, its atlas frame, the quad turned to the camera — is a function of those and the clock,
// so it is computed where the vertex is drawn. The CPU's whole job per frame is to notice which
// particles have died and write a new birth into their slot; a frame used to integrate every
// particle and rebuild every quad (3200 of them on Angel Arena Allstars' two rains: 5% of the
// frame), to re-upload geometry that had only moved by `velocity × dt`.
//
// `accel` is integrated in closed form (`½·a·t²`), which is what the per-frame Euler step
// converged on; it is 0 in every shipped row of Weather.slk.
const VERT_SRC = `
attribute vec3 aBirth;   // where the particle was born
attribute vec3 aVel;     // its velocity at birth
attribute vec2 aTime;    // x = when it was born (weather clock, seconds), y = its lifespan
attribute vec2 aCorner;  // x = side (-1/+1), y = along (-1/+1)
uniform mat4 uViewProj;
uniform float uNow;
uniform float uAccel;
uniform float uMid;      // when the mid key of every ramp lands, as a fraction of the life
uniform vec3 uColor0;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uAlpha;     // start, mid, end — already 0..1
uniform vec3 uScale;     // start, mid, end — world units, the size knob folded in
uniform vec3 uFrame;     // atlas frame index: start, mid, end
uniform vec2 uAtlas;     // columns, rows
uniform float uTail;     // 1 = a streak along the velocity, 0 = a camera-facing billboard
uniform float uTailLen;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
varying vec2 vUv;
varying vec4 vColor;

// The SLK's three-key ramps: start -> mid (at uMid of the life) -> end.
float ramp(vec3 k, float t) {
  if (t <= uMid) return k.x + (k.y - k.x) * (uMid > 0.0 ? t / uMid : 1.0);
  return k.y + (k.z - k.y) * (uMid < 1.0 ? (t - uMid) / (1.0 - uMid) : 1.0);
}

void main() {
  float age = uNow - aTime.x;
  float t = age / aTime.y;
  float alpha = ramp(uAlpha, t);
  float scale = ramp(uScale, t);
  // Dead, not yet born, or too faint or small to draw: every corner onto one point outside the
  // clip volume, so the triangle has no area.
  if (age < 0.0 || age >= aTime.y || alpha <= 0.002 || scale <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0);
    vColor = vec4(0.0);
    return;
  }
  vec3 vel = aVel + vec3(0.0, 0.0, uAccel * age);
  vec3 c = aBirth + aVel * age + vec3(0.0, 0.0, 0.5 * uAccel * age * age);
  vec3 along;
  vec3 side;
  if (uTail > 0.5) {
    // A quad stretched BACK along the velocity (the streak trails the drop), turned about that
    // axis to face the camera: side = normalize(dir x view).
    float sp = length(vel);
    vec3 dir = sp > 0.0 ? vel / sp : vec3(0.0);
    along = dir * (uTailLen * 0.5);
    c -= along;
    vec3 n = cross(dir, c - uCamPos);
    float nl = length(n);
    side = (nl > 0.0 ? n / nl : n) * scale;
  } else {
    along = uCamUp * scale;
    side = uCamRight * scale;
  }
  // The sprite-atlas frame, animated over the life (1x1 for everything but the cloud sheet).
  vec2 cell = vec2(1.0) / uAtlas;
  float frames = uAtlas.x * uAtlas.y;
  float f = frames > 1.0 ? clamp(floor(ramp(uFrame, t) + 0.5), 0.0, frames - 1.0) : 0.0;
  vec2 origin = vec2(mod(f, uAtlas.x), floor(f / uAtlas.x)) * cell;
  vUv = origin + cell * vec2(aCorner.x * 0.5 + 0.5, 0.5 - aCorner.y * 0.5);
  vColor = vec4(vec3(ramp(vec3(uColor0.r, uColor1.r, uColor2.r), t), ramp(vec3(uColor0.g, uColor1.g, uColor2.g), t), ramp(vec3(uColor0.b, uColor1.b, uColor2.b), t)), alpha);
  gl_Position = uViewProj * vec4(c + side * aCorner.x + along * aCorner.y, 1.0);
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

/** Floats per vertex in an effect's buffer: birth xyz, velocity xyz, birth time, lifespan. */
const STRIDE = 8;
/** Vertices per particle — two triangles, written out (no index buffer, no instancing: one
 *  fewer piece of GL state for the viewer's own cache to trip over). */
const VERTS = 6;
/** The weather clock is rebased when it passes this many seconds, so a birth time handed to
 *  the shader as a float32 never loses the millisecond (WeatherOverlay.rebase). */
const CLOCK_WRAP = 2048;
/** The six corners of a particle's quad as (side, along): 0 1 2 and 0 2 3 of
 *  (-s,-a) (+s,-a) (+s,+a) (-s,+a). */
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];

interface Effect {
  id: number;
  def: WeatherDef;
  area: WeatherArea;
  enabled: boolean;
  /** Live particles: slots 0..count-1 of everything below. */
  count: number;
  cap: number;
  /** When each was born, on the weather clock, and how long it lives — all the CPU keeps. */
  birth: Float64Array;
  life: Float32Array;
  /** The vertex data as uploaded: STRIDE floats x VERTS vertices per particle. */
  data: Float32Array;
  buf: WebGLBuffer;
  glCap: number; // particles the GL buffer has room for
  /** The slots written since the last upload, or lo > hi for none. */
  dirtyLo: number;
  dirtyHi: number;
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
  private aBirth: number;
  private aVel: number;
  private aTime: number;
  private aCorner: number;
  private u: Record<string, WebGLUniformLocation>;
  private maxAttribs: number;
  private effects = new Map<number, Effect>();
  private textures = new Map<string, CachedTexture>();
  /** The quad corners, the same six for every particle of every effect. */
  private cornerBuf: WebGLBuffer;
  private cornerCap = 0; // particles it covers
  private nextId = 1;
  private live = 0; // live particles across all effects (against MAX_PARTICLES)
  private warnedDt = false;
  /** Weather time, in seconds — what a particle's age is measured on. It only advances in
   *  `update`, so a paused world holds every drop where it hangs. */
  private clock = 0;
  /** Live-tunable knobs (A/B in the browser without a rebuild). */
  sizeScale = SIZE_SCALE;
  spanPerDistance = SPAN_PER_DISTANCE;

  constructor(gl: GL, loader: TextureLoader, heightAt: (x: number, y: number) => number) {
    this.gl = gl;
    this.loader = loader;
    this.heightAt = heightAt;
    this.maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
    this.program = compileProgram(gl, VERT_SRC, FRAG_SRC);
    this.aBirth = gl.getAttribLocation(this.program, "aBirth");
    this.aVel = gl.getAttribLocation(this.program, "aVel");
    this.aTime = gl.getAttribLocation(this.program, "aTime");
    this.aCorner = gl.getAttribLocation(this.program, "aCorner");
    this.u = {};
    for (const name of ["uViewProj", "uTex", "uNow", "uAccel", "uMid", "uColor0", "uColor1", "uColor2", "uAlpha", "uScale", "uFrame", "uAtlas", "uTail", "uTailLen", "uCamPos", "uCamRight", "uCamUp"]) {
      this.u[name] = gl.getUniformLocation(this.program, name)!;
    }
    this.cornerBuf = gl.createBuffer()!;
  }

  private newEffect(id: number, def: WeatherDef, area: WeatherArea, enabled: boolean): Effect {
    const cap = 256;
    return {
      id, def, area, enabled, count: 0, cap,
      birth: new Float64Array(cap), life: new Float32Array(cap), data: new Float32Array(cap * VERTS * STRIDE),
      buf: this.gl.createBuffer()!, glCap: 0, dirtyLo: cap, dirtyHi: -1,
    };
  }

  /** JASS `AddWeatherEffect(where, effectID)` — created DISABLED, exactly as the native
   *  leaves it: the editor always emits `EnableWeatherEffect(we, true)` on the next line,
   *  which would be pointless if the native started it. Returns the effect's id. */
  add(def: WeatherDef, area: WeatherArea): number {
    const id = this.nextId++;
    this.effects.set(id, this.newEffect(id, def, area, false));
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
    this.live -= e.count;
    this.gl.deleteBuffer(e.buf);
    this.effects.delete(id);
  }

  has(id: number): boolean {
    return this.effects.has(id);
  }

  /** A saved game's view of the weather (docs/save-games.md): every effect by the id its JASS
   *  handle holds, its type and its area. The particles are not kept — they are born again. */
  snapshot(): { effects: Array<{ id: number; def: string; area: WeatherArea; enabled: boolean }>; nextId: number } {
    return { effects: [...this.effects.values()].map((e) => ({ id: e.id, def: e.def.id, area: e.area, enabled: e.enabled })), nextId: this.nextId };
  }

  /** …and put back, under the same ids. */
  restore(s: ReturnType<WeatherOverlay["snapshot"]>, defOf: (id: string) => WeatherDef | undefined): void {
    for (const e of s.effects) {
      const def = defOf(e.def);
      if (!def) continue;
      const old = this.effects.get(e.id);
      if (old) {
        this.live -= old.count;
        this.gl.deleteBuffer(old.buf);
      }
      this.effects.set(e.id, this.newEffect(e.id, def, e.area, e.enabled));
      if (!this.textures.has(def.texture)) this.textures.set(def.texture, { canvas: this.loader(def.texture), tex: null });
    }
    this.nextId = Math.max(this.nextId, s.nextId);
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
    this.clock += dt;
    if (this.clock > CLOCK_WRAP) this.rebase();
    const now = this.clock;
    const span = Math.max(MIN_SPAN, view.distance * this.spanPerDistance);
    for (const e of this.effects.values()) {
      const def = e.def;
      // The box we may spawn into: the rect, clipped to the ground the camera can see.
      const minX = Math.max(e.area.minX, view.targetX - span / 2);
      const maxX = Math.min(e.area.maxX, view.targetX + span / 2);
      const minY = Math.max(e.area.minY, view.targetY - span / 2);
      const maxY = Math.min(e.area.maxY, view.targetY + span / 2);
      const canSpawn = e.enabled && maxX > minX && maxY > minY;

      // Recycle whatever died. This is ALL a living particle costs the CPU: one subtraction
      // and one compare — where it is and what it looks like is the shader's business. A dead
      // one is reborn in its own slot, so the pool holds a steady `particles` with no
      // allocation once it has warmed up.
      for (let i = e.count - 1; i >= 0; i--) {
        if (now - e.birth[i] < e.life[i]) continue;
        if (canSpawn) {
          this.spawn(e, i, now, minX, maxX, minY, maxY);
          continue;
        }
        // Effect switched off (or the camera left the rect) — let the pool drain: the last
        // particle moves into the hole (it has been looked at already; we walk downwards).
        const last = --e.count;
        this.live--;
        if (i !== last) {
          e.birth[i] = e.birth[last];
          e.life[i] = e.life[last];
          const n = VERTS * STRIDE;
          e.data.copyWithin(i * n, last * n, last * n + n);
          this.touch(e, i);
        }
      }

      // Grow toward the table's budget. `particles` IS the steady-state population (it is
      // exactly emrate × lifespan × 20 in every row — see src/data/weather.ts), so we fill
      // the pool over one lifespan rather than all at once: a storm rolls in, it doesn't
      // blink into existence.
      if (!canSpawn) continue;
      const want = Math.min(def.particles, MAX_PARTICLES - (this.live - e.count));
      const perSecond = def.particles / def.lifespan;
      const budget = Math.min(want - e.count, Math.ceil(perSecond * dt) + 1);
      for (let k = 0; k < budget; k++) {
        if (e.count === e.cap) this.grow(e);
        // A fresh pool would otherwise all be born at the same height and fall as one sheet;
        // dating each new particle's birth randomly into the past scatters them through the
        // column at once (the shader carries it down the part of the fall it has "already" done).
        this.spawn(e, e.count, now - Math.random() * def.lifespan, minX, maxX, minY, maxY);
        e.count++;
        this.live++;
      }
    }
  }

  /** (Re)birth the particle in slot `i` at the top of the column, with the table's tilt and
   *  scatter, born at `birth` on the weather clock. */
  private spawn(e: Effect, i: number, birth: number, minX: number, maxX: number, minY: number, maxY: number): void {
    const def = e.def;
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    const z = this.heightAt(x, y) + def.height;

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
    const vz = sign * speed;

    e.birth[i] = birth;
    e.life[i] = def.lifespan;
    const d = e.data;
    for (let v = 0, o = i * VERTS * STRIDE; v < VERTS; v++, o += STRIDE) {
      d[o] = x; d[o + 1] = y; d[o + 2] = z;
      d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
      d[o + 6] = birth; d[o + 7] = def.lifespan;
    }
    this.touch(e, i);
  }

  /** Slot `i` has new vertex data to upload. */
  private touch(e: Effect, i: number): void {
    if (i < e.dirtyLo) e.dirtyLo = i;
    if (i > e.dirtyHi) e.dirtyHi = i;
  }

  private grow(e: Effect): void {
    const cap = e.cap * 2;
    const birth = new Float64Array(cap);
    const life = new Float32Array(cap);
    const data = new Float32Array(cap * VERTS * STRIDE);
    birth.set(e.birth);
    life.set(e.life);
    data.set(e.data);
    e.birth = birth;
    e.life = life;
    e.data = data;
    e.cap = cap;
  }

  /** Pull the clock, and every birth measured on it, back toward zero. A birth time reaches
   *  the shader as a float32: at an hour it would be good to a quarter of a millisecond, at a
   *  day to eight, and a rain streak falls 1200 units a second. */
  private rebase(): void {
    const by = this.clock - 16; // nothing lives 16 seconds (the longest lifespan in the table is 6)
    this.clock -= by;
    for (const e of this.effects.values()) {
      for (let i = 0; i < e.count; i++) {
        const b = (e.birth[i] -= by);
        for (let v = 0, o = i * VERTS * STRIDE + 6; v < VERTS; v++, o += STRIDE) e.data[o] = b;
      }
      if (e.count) {
        e.dirtyLo = 0;
        e.dirtyHi = e.count - 1;
      }
    }
  }

  /** Draw every effect. Call after the world is rendered. */
  render(viewProj: Float32Array | Iterable<number>, camPos: ArrayLike<number>, camRight: ArrayLike<number>, camUp: ArrayLike<number>): void {
    let most = 0;
    for (const e of this.effects.values()) if (e.count > most) most = e.count;
    if (!most) return;

    const gl = this.gl;
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const prevArrayBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
    const prevCull = gl.isEnabled(gl.CULL_FACE);
    // The scalar pipeline state, from our own shadow of it — reading these eight off the
    // driver is a blocking round-trip to the GPU process and was ~1.1 ms a frame across the
    // overlays. See render/glPipelineState.ts.
    const pipeline = pipelineState(gl);
    const prevPipeline = pipeline.save();
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
    const mine = [this.aBirth, this.aVel, this.aTime, this.aCorner];
    for (let i = 0; i < this.maxAttribs; i++) {
      if (!mine.includes(i)) gl.disableVertexAttribArray(i);
    }
    for (const a of mine) gl.enableVertexAttribArray(a);
    const u = this.u;
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj as Float32Array);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1f(u.uNow, this.clock);
    gl.uniform3f(u.uCamPos, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(u.uCamRight, camRight[0], camRight[1], camRight[2]);
    gl.uniform3f(u.uCamUp, camUp[0], camUp[1], camUp[2]);

    // The corners: static, and long enough for the fullest effect.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    if (most > this.cornerCap) {
      let cap = Math.max(256, this.cornerCap);
      while (cap < most) cap *= 2;
      const corners = new Float32Array(cap * CORNERS.length);
      for (let i = 0; i < cap; i++) corners.set(CORNERS, i * CORNERS.length);
      gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
      this.cornerCap = cap;
    }
    gl.vertexAttribPointer(this.aCorner, 2, gl.FLOAT, false, 0, 0);

    for (const e of this.effects.values()) {
      if (!e.count) continue;
      const def = e.def;
      const tex = this.resolveTexture(def.texture);
      if (!tex) continue;
      // `alphaMode` picks the blend: 0 = ordinary alpha (snow — solid little flakes),
      // 1 = ADDITIVE (rain, fog, light rays, cloud), which is what makes them glow against
      // the terrain rather than smear it.
      if (def.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(u.uAccel, def.accel);
      gl.uniform1f(u.uMid, def.midTime);
      gl.uniform3f(u.uColor0, def.colorStart[0] / 255, def.colorStart[1] / 255, def.colorStart[2] / 255);
      gl.uniform3f(u.uColor1, def.colorMid[0] / 255, def.colorMid[1] / 255, def.colorMid[2] / 255);
      gl.uniform3f(u.uColor2, def.colorEnd[0] / 255, def.colorEnd[1] / 255, def.colorEnd[2] / 255);
      gl.uniform3f(u.uAlpha, def.alphaStart / 255, def.alphaMid / 255, def.alphaEnd / 255);
      gl.uniform3f(u.uScale, def.scaleStart * this.sizeScale, def.scaleMid * this.sizeScale, def.scaleEnd * this.sizeScale);
      gl.uniform3f(u.uFrame, def.uvStart, def.uvMid, def.uvEnd);
      gl.uniform2f(u.uAtlas, def.texCols, def.texRows);
      gl.uniform1f(u.uTail, def.tail ? 1 : 0);
      gl.uniform1f(u.uTailLen, Math.abs(def.veloc) * def.taillen); // the streak's world length
      this.upload(e);
      const stride = STRIDE * 4;
      gl.vertexAttribPointer(this.aBirth, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(this.aVel, 3, gl.FLOAT, false, stride, 12);
      gl.vertexAttribPointer(this.aTime, 2, gl.FLOAT, false, stride, 24);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawArrays(gl.TRIANGLES, 0, e.count * VERTS);
    }

    gl.bindTexture(gl.TEXTURE_2D, prevTex0);
    gl.activeTexture(prevActiveTex);
    gl.useProgram(prevProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuf);
    setEnabled(gl, gl.BLEND, prevBlend);
    setEnabled(gl, gl.DEPTH_TEST, prevDepthTest);
    setEnabled(gl, gl.CULL_FACE, prevCull);
    pipeline.restore(prevPipeline);
    for (let i = 0; i < this.maxAttribs; i++) {
      if (prevAttribEnabled[i]) gl.enableVertexAttribArray(i);
      else gl.disableVertexAttribArray(i);
    }
  }

  /** Bind an effect's buffer and send it the slots written since the last frame — the births
   *  of this frame's reborn particles, a few dozen of a few thousand. */
  private upload(e: Effect): void {
    const gl = this.gl;
    const n = VERTS * STRIDE;
    gl.bindBuffer(gl.ARRAY_BUFFER, e.buf);
    if (e.glCap < e.cap) {
      gl.bufferData(gl.ARRAY_BUFFER, e.data, gl.DYNAMIC_DRAW); // grown: the whole thing, once
      e.glCap = e.cap;
    } else if (e.dirtyHi >= e.dirtyLo) {
      gl.bufferSubData(gl.ARRAY_BUFFER, e.dirtyLo * n * 4, e.data.subarray(e.dirtyLo * n, (e.dirtyHi + 1) * n));
    }
    e.dirtyLo = e.cap;
    e.dirtyHi = -1;
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
    for (const e of this.effects.values()) gl.deleteBuffer(e.buf);
    gl.deleteBuffer(this.cornerBuf);
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
