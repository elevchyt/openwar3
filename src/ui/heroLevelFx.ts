// `UI\Buttons\HeroLevel\HeroLevel.mdx` — the model WC3 lays over a hero-bar portrait whose
// hero has an unspent skill point waiting.
//
// war3skins.txt names it under the key the engine asks for by name, right below the one the
// command card's autocast sparkle uses:
//     CommandButtonAutocast=UI\Feedback\Autocast\UI-ModalButtonOn.mdl   (ui/modalButtonFx.ts)
//     HeroBarPointModel=UI\Buttons\HeroLevel\HeroLevel.mdl
// so the two are DIFFERENT models for two different jobs, and this module is the second one.
//
// The model itself (3,360 bytes out of War3.mpq, chunk by chunk):
//
//   SEQS  "Cast", 0 → 2000 ms, looping
//   GLBS  one global sequence, 2000 ms
//   TEXS  Textures\HeroLevel-Particle.blp             16×16, a six-armed star sparkle
//         UI\Buttons\HeroLevel\HeroLevel-Border.blp   64×64, a soft white rounded-square RING
//                                                     on black (no alpha channel — it is an
//                                                     additive texture, so black IS nothing)
//   GEOS  ONE double-sided quad (8 verts / 12 indices, two windings), (0,0) → (0.0401,
//         0.0397) in FDF UI units, flat at z = 0.008
//   MTLS  one layer: filterMode 3 (Additive), Unshaded, texture 1 (the ring), and a KMTA on
//         the 2000 ms GLOBAL sequence — alpha 0.25 → 1.0 at 1 s → 0.25, Hermite. The ring
//         PULSES, on a clock of its own that the sequence never touches.
//   GEOA  flags 2 (Color), colour 0.1412, 0.5569, 0.9529 — MDX stores colours **BGR**, so
//         that is rgb(243, 142, 36), the hero-level gold.
//   PRE2  BlizParticle01/03/04/05 — FOUR emitters, one per EDGE of that quad. Each is a strip
//         (length 0.039 × width 0.001) laid along one edge by its pivot and its KGRT:
//             01  pivot (0.0188, 0.0381)  rot −90° about Z → the strip runs along X  = TOP
//             03  pivot (0.0188, 0.0007)  rot −90° about Z → along X                = BOTTOM
//             04  pivot (0.0007, 0.0189)  rot 180° about Z → along Y                = LEFT
//             05  pivot (0.0383, 0.0189)  rot 180° about Z → along Y                = RIGHT
//         Per emitter: speed 0.02, latitude 0, gravity 0, lifespan 1 s, emissionRate 20/s,
//         filterMode 1 (Additive), headOrTail 2, time 0.5, and three-segment ramps:
//             colour  (BGR→RGB) (.843,.239,0) → (.867,.431,.141) → (.914,.651,.416)
//             alpha    255 → 255 → 0
//             scaling  .0025 → .005 → .01     — it GROWS as it dies
//
// **Why this is a 2D field and not an approximation of one.** Same reason the autocast
// sparkle is: `latitude` is 0, so the emission cone has no width and every particle flies
// straight out along its emitter's local +Z — perpendicular to the UI plane, at the camera.
// On screen a spark therefore never travels. It is laid down where it was born, on the line
// of one edge, and spends its second growing four times as wide and fading out. That
// outward-growing halo along all four edges is the "spill" the effect reads as.
//
// **Where it sits.** The quad is 0.0401 × 0.0397 against a hero-bar button of 68 px at 1080p
// (= 0.03778 UI units; see HERO_BAR in ui/hud.ts, measured off the real client) — 6% larger
// than the button, so the ring lands just past the portrait's own frame, and a dying spark
// reaches 0.01 UI units (26% of the button) beyond that. Drawn ADDITIVELY over the portrait,
// which is what filterMode 3 / 1 do and is why the art underneath is never hidden by it.

/** Everything above, as numbers. Nothing here is a taste call — it is the chunk dump. */
const RING_MS = 2000; // GLBS: the global sequence the border's KMTA runs on
const LIFESPAN = 1; // seconds
const EMISSION_RATE = 20; // particles per second, per emitter
const MODEL_W = 0.0401; // the quad, in FDF UI units
const MODEL_H = 0.0397;
const STRIP_LEN = 0.039; // PRE2 `length` — how far along its edge an emitter spawns
const STRIP_WIDE = 0.001; // PRE2 `width` — and how far across it
const SPARK_MAX_HALF = 0.01; // `scaling` segment 2 — the biggest a particle ever is

/** The ring's KMTA, verbatim: frame → value, with the Hermite tangents the chunk carries. */
const RING_ALPHA = [
  { t: 0, v: 0.25, inTan: 0, outTan: 0.75 },
  { t: 1000, v: 1.0, inTan: 1, outTan: 1 },
  { t: 2000, v: 0.25, inTan: 0.75, outTan: 0 },
] as const;
/** GEOA colour, BGR→RGB. The ring texture is greyscale; this is what gilds it. */
const RING_COLOR = [0.952941, 0.556863, 0.141176] as const;

/** Colour / alpha / half-size at life fraction 0, `time` (0.5) and 1, all BGR→RGB. */
const SEG_TIME = 0.5;
const SEG_COLOR = [
  [0.843137, 0.239216, 0.0],
  [0.866667, 0.431373, 0.141176],
  [0.913726, 0.65098, 0.415686],
] as const;
const SEG_ALPHA = [1, 1, 0] as const;
const SEG_SCALE = [0.0025, 0.005, 0.01] as const;

/** The four emitters, resolved out of PIVT + KGRT: where the strip's centre is, and which
 *  way it runs. `horizontal` is the top/bottom pair (KGRT −90° about Z maps the emitter's
 *  local length axis onto world X); the left/right pair (180°) keeps it on world Y. */
const EMITTERS = [
  { x: 0.018832, y: 0.038126, horizontal: true }, // BlizParticle01 — top
  { x: 0.018832, y: 0.000698, horizontal: true }, // BlizParticle03 — bottom
  { x: 0.000705, y: 0.018856, horizontal: false }, // BlizParticle04 — left
  { x: 0.038256, y: 0.018856, horizontal: false }, // BlizParticle05 — right
] as const;

/** A hero-bar button, in the same FDF UI units the model is authored in: the 68 px the real
 *  client's button measures at 1080p, against the 0.6-tall UI space (HERO_BAR in ui/hud.ts).
 *  The model is 6% larger than this, which is the whole reason anything shows around the
 *  portrait's edge at all. */
const BUTTON_SIDE = (68 * 0.6) / 1080;

/** How far past the button's edge the effect reaches, as a fraction of the button — the
 *  model's half-extent plus the biggest a spark ever gets. The overlay is inset by this much
 *  on all four sides so nothing is clipped off the corners. */
export const HERO_LEVEL_FX_OVERHANG = (Math.max(MODEL_W, MODEL_H) / 2 + SPARK_MAX_HALF) / BUTTON_SIDE - 0.5;

/** The shared frame's resolution. A hero-bar button is ~76 CSS px, so this is generous
 *  enough to hold up on a hi-dpi screen and small enough that ~80 additive blits cost
 *  nothing. */
const FX_SIZE = 128;
/** The button's size inside that frame, in frame pixels, and model units → frame pixels. */
const BTN_PX = FX_SIZE / (1 + 2 * HERO_LEVEL_FX_OVERHANG);
const UNIT = BTN_PX / BUTTON_SIDE;
/** Where the model's quad sits inside the frame (its origin is its BOTTOM-left; MDX y is up
 *  and canvas y is down, so `point` flips it). */
const QUAD_W = MODEL_W * UNIT;
const QUAD_H = MODEL_H * UNIT;
const QUAD_X = (FX_SIZE - QUAD_W) / 2;
const QUAD_Y = (FX_SIZE - QUAD_H) / 2;

/** Distinct tinted copies of the spark cut across the colour ramp — sixteen steps of a
 *  one-second gradient are indistinguishable from continuous, and they let every particle be
 *  a plain `drawImage`. */
const RAMP_STEPS = 16;

/** Room for every particle that can be in the air at once: each emitter holds a second's
 *  worth (20) plus the one it is laying this frame. */
const CAPACITY = EMITTERS.length * (EMISSION_RATE + 2);

/** Linear interpolation across a WC3 three-segment ramp (`time` splits the two halves). */
function segment(ramp: readonly number[], f: number): number {
  return f < SEG_TIME
    ? ramp[0] + (ramp[1] - ramp[0]) * (f / SEG_TIME)
    : ramp[1] + (ramp[2] - ramp[1]) * ((f - SEG_TIME) / (1 - SEG_TIME));
}

/** The ring's alpha at `ms` into the 2 s global sequence — Hermite, which is what the KMTA's
 *  interpolationType 3 asks for, over the tangents the chunk carries. */
function ringAlpha(ms: number): number {
  const t = ((ms % RING_MS) + RING_MS) % RING_MS;
  const i = t < RING_ALPHA[1].t ? 0 : 1;
  const a = RING_ALPHA[i];
  const b = RING_ALPHA[i + 1];
  const u = (t - a.t) / (b.t - a.t);
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    a.v * (2 * u3 - 3 * u2 + 1) + a.outTan * (u3 - 2 * u2 + u) + b.v * (-2 * u3 + 3 * u2) + b.inTan * (u3 - u2)
  );
}

/**
 * The effect, simulated ONCE and blitted onto every portrait wearing it.
 *
 * WC3 gives each lit button its own model instance; ours share a frame, which costs the
 * indicators their independent start times and buys back seven particle systems' worth of
 * work (the hero bar holds seven, and every one of them can be lit at once). Nothing on
 * screen can tell: the effect has no beginning to be caught out of step, only a loop.
 */
export class HeroLevelFx {
  /** The colour ramp, baked: RAMP_STEPS copies of the spark, each multiplied by the colour
   *  its slice of the particle's life calls for. Empty when no install is mounted. */
  private ramp: HTMLCanvasElement[] = [];
  /** The ring, baked once: HeroLevel-Border.blp gilded by the GEOA colour, with its own
   *  LUMINANCE moved into the alpha channel. The texture ships opaque with a black
   *  background because it is drawn additively, and `lighter` on a canvas adds alpha too —
   *  so a straight blit would lay an opaque black square over the portrait. Alpha =
   *  luminance is the same picture an additive draw of the original produces. */
  private ring: HTMLCanvasElement | null = null;
  private frame = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  /** Every overlay this has handed out, with its context — `hidden` is what says whether the
   *  hero has a point waiting, so a lit/unlit flip is one property and no bookkeeping. */
  private overlays: Array<{ el: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> = [];

  // The particle field: a ring buffer, which is all it needs to be — every particle lives
  // exactly one second, so they die in the order they were born.
  private px = new Float32Array(CAPACITY);
  private py = new Float32Array(CAPACITY);
  private born = new Float32Array(CAPACITY);
  private head = 0; // next slot to write
  private live = 0;
  private clock = 0; // seconds since this effect started running
  private emitAccum = 0; // fractional particles owed from the last step

  /** `spark` is Textures\HeroLevel-Particle.blp and `border` is
   *  UI\Buttons\HeroLevel\HeroLevel-Border.blp, both decoded (HudDriver.blpCanvas). Without
   *  an install there is neither, and the effect draws stand-ins of its own instead — the
   *  same rule the rest of the console follows: authentic when present, placeholder
   *  otherwise. */
  constructor(spark: HTMLCanvasElement | null, border: HTMLCanvasElement | null) {
    this.frame.width = FX_SIZE;
    this.frame.height = FX_SIZE;
    this.ctx = this.frame.getContext("2d")!;
    this.ramp = buildRamp(spark);
    this.ring = buildRing(border);
  }

  /** A fresh overlay canvas to park over one hero portrait. Starts hidden; show it by
   *  clearing `hidden`. The caller owns where it sits — see `.hud-herolevel-fx`. */
  makeOverlay(): HTMLCanvasElement {
    const el = document.createElement("canvas");
    el.className = "hud-herolevel-fx";
    el.width = FX_SIZE;
    el.height = FX_SIZE;
    el.hidden = true;
    this.overlays.push({ el, ctx: el.getContext("2d")! });
    return el;
  }

  /** Advance the shared frame and blit it onto every overlay that is showing. Costs nothing
   *  while none is — a bar with no unspent point on it never runs the particle field. */
  tick(dtMs: number): void {
    let showing = 0;
    for (const o of this.overlays) if (!o.el.hidden) showing++;
    if (showing === 0) {
      this.live = 0; // the next hero to level starts from a bare edge, as its model does
      this.emitAccum = 0;
      return;
    }
    // A long stall (a loading screen, a backgrounded tab) must not spend the whole gap
    // emitting: past a particle's lifetime the field would only be rebuilt anyway.
    this.step(Math.min(dtMs, LIFESPAN * 1000) / 1000);
    for (const o of this.overlays) {
      if (o.el.hidden) continue;
      o.ctx.clearRect(0, 0, FX_SIZE, FX_SIZE);
      o.ctx.drawImage(this.frame, 0, 0);
    }
  }

  /** One step of the particle field, then redraw the shared frame. */
  private step(dt: number): void {
    this.clock += dt;

    // Retire from the tail: born-in-order means dead-in-order.
    const oldest = this.clock - LIFESPAN;
    while (this.live > 0 && this.born[(this.head - this.live + CAPACITY) % CAPACITY] <= oldest) this.live--;

    // Emit. The count is carried as a fraction so 20/s survives a 60 Hz step. Unlike the
    // autocast sparkle — whose emitters walk a fixed path, so its field is derived rather
    // than random — a PRE2 strip picks a fresh point along its edge for every particle, so
    // this one really is a die roll. Nothing downstream of the HUD sees it.
    this.emitAccum += dt * EMISSION_RATE;
    const n = Math.floor(this.emitAccum);
    this.emitAccum -= n;
    for (let k = 0; k < n; k++) {
      for (const e of EMITTERS) {
        const along = (Math.random() - 0.5) * STRIP_LEN;
        const across = (Math.random() - 0.5) * STRIP_WIDE;
        const mx = e.x + (e.horizontal ? along : across);
        const my = e.y + (e.horizontal ? across : along);
        this.px[this.head] = QUAD_X + mx * UNIT;
        this.py[this.head] = QUAD_Y + (MODEL_H - my) * UNIT; // MDX y is up, canvas y is down
        this.born[this.head] = this.clock;
        this.head = (this.head + 1) % CAPACITY;
        if (this.live < CAPACITY) this.live++;
      }
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, FX_SIZE, FX_SIZE);
    // Additive, the way filterMode 1 and 3 composite in the game: the ring and the sparks
    // pile onto each other rather than hiding one another.
    ctx.globalCompositeOperation = "lighter";
    if (this.ring) {
      ctx.globalAlpha = Math.max(0, Math.min(1, ringAlpha(this.clock * 1000)));
      ctx.drawImage(this.ring, QUAD_X, QUAD_Y, QUAD_W, QUAD_H);
    }
    if (this.ramp.length) {
      for (let i = 0; i < this.live; i++) {
        const p = (this.head - 1 - i + CAPACITY * 2) % CAPACITY;
        const f = (this.clock - this.born[p]) / LIFESPAN;
        if (f < 0 || f >= 1) continue;
        const a = segment(SEG_ALPHA, f);
        if (a <= 0) continue;
        const half = segment(SEG_SCALE, f) * UNIT;
        ctx.globalAlpha = a;
        ctx.drawImage(this.ramp[Math.min(RAMP_STEPS - 1, (f * RAMP_STEPS) | 0)], this.px[p] - half, this.py[p] - half, half * 2, half * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

/** Bake the spark once per colour step. The texture's own alpha is left alone — it is the
 *  star's shape — and only its RGB is multiplied, which is what an MDX segment colour does. */
function buildRamp(spark: HTMLCanvasElement | null): HTMLCanvasElement[] {
  const src = spark ?? placeholderSpark();
  const base = pixels(src);
  if (!base) return [];
  const out: HTMLCanvasElement[] = [];
  for (let s = 0; s < RAMP_STEPS; s++) {
    const f = (s + 0.5) / RAMP_STEPS;
    const r = segment(SEG_COLOR.map((c) => c[0]), f);
    const g = segment(SEG_COLOR.map((c) => c[1]), f);
    const b = segment(SEG_COLOR.map((c) => c[2]), f);
    const tinted = new ImageData(base.width, base.height);
    for (let i = 0; i < base.data.length; i += 4) {
      tinted.data[i] = base.data[i] * r;
      tinted.data[i + 1] = base.data[i + 1] * g;
      tinted.data[i + 2] = base.data[i + 2] * b;
      tinted.data[i + 3] = base.data[i + 3];
    }
    out.push(toCanvas(tinted));
  }
  return out;
}

/** Bake the ring: gild it with the GEOA colour and move its luminance into alpha (see
 *  `HeroLevelFx.ring` for why the alpha channel has to be synthesised). */
function buildRing(border: HTMLCanvasElement | null): HTMLCanvasElement | null {
  const src = border ?? placeholderRing();
  const base = pixels(src);
  if (!base) return null;
  const out = new ImageData(base.width, base.height);
  for (let i = 0; i < base.data.length; i += 4) {
    // Rec. 601 luma — the texture is greyscale, so any sane weighting lands on the same
    // number; this is only here so a non-grey texel cannot come out brighter than white.
    const lum = (0.299 * base.data[i] + 0.587 * base.data[i + 1] + 0.114 * base.data[i + 2]) / 255;
    out.data[i] = 255 * RING_COLOR[0];
    out.data[i + 1] = 255 * RING_COLOR[1];
    out.data[i + 2] = 255 * RING_COLOR[2];
    out.data[i + 3] = 255 * lum * (base.data[i + 3] / 255);
  }
  return toCanvas(out);
}

/** A canvas's pixels, or null if it is empty or tainted (never ours, but a `getImageData`
 *  that throws must not take the HUD down with it). */
function pixels(src: HTMLCanvasElement): ImageData | null {
  if (!src.width || !src.height) return null;
  try {
    return src.getContext("2d")!.getImageData(0, 0, src.width, src.height);
  } catch {
    return null;
  }
}

function toCanvas(data: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = data.width;
  c.height = data.height;
  c.getContext("2d")!.putImageData(data, 0, 0);
  return c;
}

/** The stand-in when no install is mounted: a round white spark with a soft falloff, at the
 *  same 16×16 HeroLevel-Particle.blp is. */
function placeholderSpark(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 16);
  return c;
}

/** …and for the ring: a soft white rounded-square band on black, at HeroLevel-Border.blp's
 *  own 64×64 and with its band in roughly the same place. Black is nothing here, exactly as
 *  it is in the real texture. */
function placeholderRing(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 5;
  ctx.filter = "blur(2px)";
  ctx.beginPath();
  ctx.roundRect(6, 6, 52, 52, 10);
  ctx.stroke();
  return c;
}
