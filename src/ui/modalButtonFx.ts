// `UI\Feedback\Autocast\UI-ModalButtonOn.mdx` — the sparkle WC3 lays over a button that is
// standing ON: an autocast toggled on, and a hero with a skill point waiting to be spent.
//
// war3skins.txt names it under the key the engine asks for by name:
//     CommandButtonAutocast=UI\Feedback\Autocast\UI-ModalButtonOn.mdl
// and it is the SAME model on the learn-skill button and on the hero bar's portraits, which
// is why one module serves all three.
//
// The model itself (2,216 bytes out of War3.mpq, read chunk by chunk):
//
//   SEQS  "Stand", 833 → 2500 ms (1.667 s)
//   TEXS  Textures\HeroLevel-Particle.blp   — 16×16, the hero level-up spark
//   PIVT  four points at the corners of a 0.0353-unit square (FDF UI units, the 0.8 × 0.6
//         space a command-card cell is ~0.0396 of — so the square sits just inside the icon)
//   PRE2  BlizParticle01…04 — ONE emitter per corner, each carrying a 3-key linear KGTR that
//         walks it along TWO edges of that square over the sequence (833 ms an edge):
//             01: TR → BR → BL     02: TL → TR → BR
//             03: BL → TL → TR     04: BR → BL → TL
//         all four clockwise. Per emitter: speed 0.02, latitude 0, gravity 0, lifespan 1 s,
//         emissionRate 50/s, filterMode 1 (Additive), headOrTail 2 (head + a 0.3 tail),
//         time 0.5, and three-segment ramps for colour, alpha and size:
//             colour  (1, .984, .6) → (.875, .796, .141) → (.769, .6, .149)
//             alpha    255 → 255 → 0
//             scaling  .005 → .0025 → .001
//
// **Why this is a 2D particle field and not an approximation of one.** `latitude` is 0, so
// the emission cone has no width at all and every particle flies straight out along its
// emitter's local +Z — perpendicular to the UI plane, i.e. at the camera. On screen it
// therefore never travels: the effect is a trail of gold sparks laid down along the path the
// emitter walks, each one shrinking and fading over its second of life. Reproducing that in
// a 2D canvas is not a stand-in for the model, it IS what the model draws.
//
// **Why the loop reads seamless.** Each emitter covers only HALF the square's perimeter and
// then snaps back to its corner when the sequence restarts — but the four of them are a
// quarter-perimeter apart, so at every restart the SET of four positions is unchanged and
// they simply swap identities. Four points chasing clockwise forever, one lap every 2 ×
// 1.667 s, is the same picture with no seam to hide, so that is how it is driven here.

/** Everything above, as numbers. Nothing here is a taste call — it is the chunk dump. */
const SEQ_MS = 1667; // SEQS "Stand": 2500 − 833
const LIFESPAN = 1; // seconds
const EMISSION_RATE = 50; // particles per second, per emitter
const MODEL_SIDE = 0.0353; // the emitter square's side (PIVT extent / KGTR leg length)
const SPARK_HALF = 0.005; // `scaling` segment 0 — the biggest a particle ever is
/** Colour / alpha / half-size at life fraction 0, `time` (0.5) and 1. */
const SEG_TIME = 0.5;
const SEG_COLOR = [
  [1.0, 0.984, 0.6],
  [0.875, 0.796, 0.141],
  [0.769, 0.6, 0.149],
] as const;
const SEG_ALPHA = [1, 1, 0] as const;
const SEG_SCALE = [0.005, 0.0025, 0.001] as const;

/** A command-card cell, in the same FDF UI units the model is authored in. Straight off the
 *  console art the card is fitted to (CONSOLE_ZONES.command): 0.1705 across 341 texels, four
 *  columns with 8-texel gutters between them, so a cell is (341 − 24) / 4 × 0.0005. The
 *  model's square is 89% of that, and a spark is a quarter of it wide — so the ring sits just
 *  inside the icon and its sparks hang a little way past the button's edge. */
const BUTTON_SIDE = 0.0396;
/** How far past the button's edge the effect reaches, as a fraction of the button. The overlay
 *  is inset by this much on all four sides so nothing is clipped off the corners. */
export const MODAL_FX_OVERHANG = (MODEL_SIDE / 2 + SPARK_HALF) / BUTTON_SIDE - 0.5;

/** The shared frame's resolution. A command button is ~68 CSS px, so this is generous enough
 *  to hold up on a hi-dpi screen and small enough that ~200 additive blits cost nothing. */
const FX_SIZE = 128;
/** Where the emitter square sits inside that frame, in frame pixels. */
const SQUARE = (FX_SIZE * MODEL_SIDE) / (BUTTON_SIDE * (1 + 2 * MODAL_FX_OVERHANG));
const SQUARE_X = (FX_SIZE - SQUARE) / 2;
/** Model units → frame pixels (the emitter square is the ruler both are measured against). */
const UNIT = SQUARE / MODEL_SIDE;

/** Distinct tinted copies of the spark cut across the colour ramp. The ramp is a smooth
 *  gradient over one second; sixteen steps of it are indistinguishable from continuous and
 *  they let every particle be a plain `drawImage`. */
const RAMP_STEPS = 16;

/** Four emitters, a quarter-perimeter apart, one lap every two sequences. */
const EMITTERS = 4;
const LAP_MS = SEQ_MS * 2;

/** Room for every particle that can be in the air at once: each emitter holds a second's
 *  worth (50) plus the one it is laying this frame. */
const CAPACITY = EMITTERS * (EMISSION_RATE + 2);

/** Linear interpolation across a WC3 three-segment ramp (`time` splits the two halves). */
function segment(ramp: readonly number[], f: number): number {
  return f < SEG_TIME
    ? ramp[0] + (ramp[1] - ramp[0]) * (f / SEG_TIME)
    : ramp[1] + (ramp[2] - ramp[1]) * ((f - SEG_TIME) / (1 - SEG_TIME));
}

/** A point on the emitter square's perimeter, clockwise from its top-left corner, in frame
 *  pixels. `s` wraps, so an emitter is just a phase offset (see the header's "seamless"). */
function perimeter(s: number, out: { x: number; y: number }): void {
  const t = ((s % 1) + 1) % 1;
  const leg = t * 4;
  const i = Math.floor(leg); // 0 top, 1 right, 2 bottom, 3 left
  const u = leg - i;
  const lo = SQUARE_X;
  const hi = SQUARE_X + SQUARE;
  if (i === 0) { out.x = lo + SQUARE * u; out.y = lo; }
  else if (i === 1) { out.x = hi; out.y = lo + SQUARE * u; }
  else if (i === 2) { out.x = hi - SQUARE * u; out.y = hi; }
  else { out.x = lo; out.y = hi - SQUARE * u; }
}

/**
 * The effect, simulated ONCE and blitted onto every button wearing it.
 *
 * WC3 gives each lit button its own model instance; ours share a frame, which costs the
 * indicators their independent start times and buys back nineteen particle systems' worth of
 * work (twelve command slots and seven hero portraits can all be lit at once). Nothing on
 * screen can tell: the effect has no beginning to be caught out of step, only a lap.
 */
export class ModalButtonFx {
  /** The colour ramp, baked: RAMP_STEPS copies of the spark, each multiplied by the colour
   *  its slice of the particle's life calls for. Empty when no install is mounted. */
  private ramp: HTMLCanvasElement[] = [];
  private frame = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  /** Every overlay this has handed out, with its context — `hidden` is what says whether the
   *  button is standing on, so a lit/unlit flip is one property and no bookkeeping. */
  private overlays: Array<{ el: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> = [];

  // The particle field: a ring, which is all it needs to be — every particle lives exactly
  // one second, so they die in the order they were born.
  private px = new Float32Array(CAPACITY);
  private py = new Float32Array(CAPACITY);
  private born = new Float32Array(CAPACITY);
  private head = 0; // next slot to write
  private live = 0;
  private clock = 0; // seconds since this effect started running
  private emitAccum = 0; // fractional particles owed from the last step
  private scratch = { x: 0, y: 0 };

  /** `spark` is Textures\HeroLevel-Particle.blp decoded (HudDriver.blpCanvas). Without an
   *  install there is none, and the effect draws a soft round spark of its own instead — the
   *  same rule the rest of the console follows: authentic when present, placeholder otherwise. */
  constructor(spark: HTMLCanvasElement | null) {
    this.frame.width = FX_SIZE;
    this.frame.height = FX_SIZE;
    this.ctx = this.frame.getContext("2d")!;
    this.ramp = buildRamp(spark);
  }

  /** A fresh overlay canvas to park over one square button. Starts hidden; show it by
   *  clearing `hidden`. The caller owns where it sits — see `.hud-modal-fx`. */
  makeOverlay(): HTMLCanvasElement {
    const el = document.createElement("canvas");
    el.className = "hud-modal-fx";
    el.width = FX_SIZE;
    el.height = FX_SIZE;
    el.hidden = true;
    this.overlays.push({ el, ctx: el.getContext("2d")! });
    return el;
  }

  /** Advance the shared frame and blit it onto every overlay that is showing. Costs nothing
   *  while none is — a card with no autocast on it never runs the particle field at all. */
  tick(dtMs: number): void {
    let showing = 0;
    for (const o of this.overlays) if (!o.el.hidden) showing++;
    if (showing === 0) {
      this.live = 0; // next button to light up starts from an empty border, as its model does
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
    const t0 = this.clock;
    this.clock += dt;

    // Retire from the tail: born-in-order means dead-in-order.
    const oldest = this.clock - LIFESPAN;
    while (this.live > 0 && this.born[(this.head - this.live + CAPACITY) % CAPACITY] <= oldest) this.live--;

    // Emit. The count is carried as a fraction so 50/s survives a 60 Hz step, and each
    // particle is laid where its emitter WAS at the instant it was born rather than all of
    // them at the frame's end — a 0.83-particles-per-frame trail is otherwise visibly clumpy.
    this.emitAccum += dt * EMISSION_RATE;
    const n = Math.floor(this.emitAccum);
    this.emitAccum -= n;
    for (let k = 1; k <= n; k++) {
      const at = t0 + (dt * k) / n;
      for (let e = 0; e < EMITTERS; e++) {
        perimeter((at * 1000) / LAP_MS + e / EMITTERS, this.scratch);
        this.px[this.head] = this.scratch.x;
        this.py[this.head] = this.scratch.y;
        this.born[this.head] = at;
        this.head = (this.head + 1) % CAPACITY;
        if (this.live < CAPACITY) this.live++;
      }
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, FX_SIZE, FX_SIZE);
    if (!this.ramp.length) return;
    // filterMode 1 = Additive: sparks pile onto each other rather than hiding one another,
    // which is what makes the dense head of a trail read as a bright point.
    ctx.globalCompositeOperation = "lighter";
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
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

/** Bake the spark once per colour step. The texture's own alpha is left alone — it is the
 *  glow's shape — and only its RGB is multiplied, which is what an MDX segment colour does. */
function buildRamp(spark: HTMLCanvasElement | null): HTMLCanvasElement[] {
  const src = spark ?? placeholderSpark();
  const w = src.width, h = src.height;
  if (!w || !h) return [];
  let base: ImageData;
  try {
    base = src.getContext("2d")!.getImageData(0, 0, w, h);
  } catch {
    return []; // a tainted canvas (never ours, but a getImageData that throws must not kill the HUD)
  }
  const out: HTMLCanvasElement[] = [];
  for (let s = 0; s < RAMP_STEPS; s++) {
    const f = (s + 0.5) / RAMP_STEPS;
    const r = segment(SEG_COLOR.map((c) => c[0]), f);
    const g = segment(SEG_COLOR.map((c) => c[1]), f);
    const b = segment(SEG_COLOR.map((c) => c[2]), f);
    const tinted = new ImageData(w, h);
    for (let i = 0; i < base.data.length; i += 4) {
      tinted.data[i] = base.data[i] * r;
      tinted.data[i + 1] = base.data[i + 1] * g;
      tinted.data[i + 2] = base.data[i + 2] * b;
      tinted.data[i + 3] = base.data[i + 3];
    }
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.putImageData(tinted, 0, 0);
    out.push(c);
  }
  return out;
}

/** The stand-in when no install is mounted: a round white spark with the same soft falloff
 *  HeroLevel-Particle.blp has, at the same 16×16 the real one is. */
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
