// `UI\Feedback\QuestButton\UI-QuestButtonOn.mdx` — the sparks WC3 runs round the Quests button
// while the quest log holds something the player has not opened it to read.
//
// war3skins.txt names it under the key the engine asks for:
//     QuestChangedParticles=UI\Feedback\QuestButton\UI-QuestButtonOn.mdl
// and it is the sibling of the autocast sparkle (ui/modalButtonFx.ts): the same 16×16 spark
// texture, the same lifespan-1 / 50-a-second / latitude-0 emitters laying a trail where they
// walk — on a RECTANGULAR track this time, because the thing it rings is a 0.085 × 0.022 bar
// button and not a square command slot.
//
// The model (1,586 bytes, read chunk by chunk):
//
//   SEQS  "Stand", 833 → 2500 ms (1.667 s)
//   TEXS  Textures\HeroLevel-Particle.blp
//   PRE2  two emitters, each with a 5-key linear KGTR over the sequence:
//     BlizParticle02  pivot (0.0051, 0.0199) — the button's top-left
//         +0.0748 x over 1334 ms (the top edge), then round the corner and 0.0150 DOWN the
//         right edge in the last 333 ms, ending at (0.0801, 0.0050)
//         colour (.855,.855,.855) → (.651,.651,.651) → (.416,.416,.416), alpha 255 → 255 → 0,
//         scaling .005 → .002 → .001                                    — the WHITE one
//     BlizParticle04  pivot (0.0801, 0.0051) — the bottom-right, where 02 ends
//         −0.0752 x along the bottom, then UP the left edge to (0.0050, 0.0198), where 02 starts
//         colour (.792,.686,.271) → (.525,.431,.141) → (.294,.259,.149), alpha 255 → 128 → 0,
//         scaling .003 → .002 → .001                                    — the GOLD one
//
// (The colours are in the file's own channel order, which is what the renderer multiplies by;
// an .mdl dump of the same model prints them reversed and reads as teal.)
//
// So the two chase each other clockwise round the button, each covering HALF the perimeter and
// snapping back to its own corner when the sequence restarts — at which instant the other has
// just arrived there, so the loop has no seam. Unlike the autocast ring the two halves are NOT
// interchangeable (white rides the top and right, gold the bottom and left), so each emitter
// replays its own leg rather than the pair being one phase-shifted lap.
//
// The origin is the button's bottom-left corner with +y up — a SIMPLEBUTTON's sprite hangs
// off its own BOTTOMLEFT — which is the only reading under which the track is centred on the
// 0.085-wide button: its x runs 0.0027 … 0.0824, 0.0026 clear of either end.

const SEQ_MS = 1667; // SEQS "Stand": 2500 − 833
const LIFESPAN = 1; // seconds
const EMISSION_RATE = 50; // per second, per emitter
const SEG_TIME = 0.5;

/** UpperButtonBar.fdf `UpperButtonBarButtonTemplate`: Width 0.085, Height 0.022. */
const BUTTON_W = 0.085;
const BUTTON_H = 0.022;
/** How far past the button the canvas reaches on every side, so the biggest spark (0.005
 *  half-size, on a track 0.0027 inside the button's end) is never clipped. */
const MARGIN = 0.004;
/** Canvas pixels per FDF unit. The button is ~180 CSS px wide at 1080p. */
const UNIT = 3200;

interface Emitter {
  /** The emitter's path: [ms into the sequence, x, y] in button space (origin bottom-left). */
  path: ReadonlyArray<readonly [number, number, number]>;
  color: ReadonlyArray<readonly [number, number, number]>;
  alpha: readonly [number, number, number];
  scale: readonly [number, number, number];
}

const EMITTERS: readonly Emitter[] = [
  {
    path: [
      [0, 0.005101, 0.019925], [1334, 0.07994, 0.019925], [1400, 0.082365, 0.017709],
      [1600, 0.082365, 0.006435], [1667, 0.080135, 0.004967],
    ],
    color: [[0.854902, 0.854902, 0.854902], [0.650979, 0.650979, 0.650979], [0.415686, 0.415686, 0.415686]],
    alpha: [1, 1, 0],
    scale: [0.004999, 0.002, 0.001],
  },
  {
    path: [
      [0, 0.08006, 0.005101], [1334, 0.004858, 0.005101], [1400, 0.002714, 0.006206],
      [1600, 0.002714, 0.017962], [1667, 0.004949, 0.019788],
    ],
    color: [[0.792156, 0.686275, 0.270588], [0.525489, 0.431373, 0.141176], [0.294117, 0.258823, 0.14902]],
    alpha: [1, 128 / 255, 0],
    scale: [0.003, 0.002, 0.001],
  },
];

const RAMP_STEPS = 16;
const CAPACITY = EMISSION_RATE + 2; // per emitter: a second's worth, plus this frame's

function segment(ramp: readonly number[], f: number): number {
  return f < SEG_TIME
    ? ramp[0] + (ramp[1] - ramp[0]) * (f / SEG_TIME)
    : ramp[1] + (ramp[2] - ramp[1]) * ((f - SEG_TIME) / (1 - SEG_TIME));
}

/** Where an emitter is `ms` into the (looping) sequence, in canvas pixels. */
function along(path: Emitter["path"], ms: number, out: { x: number; y: number }): void {
  const t = ((ms % SEQ_MS) + SEQ_MS) % SEQ_MS;
  let i = 1;
  while (i < path.length - 1 && path[i][0] < t) i++;
  const a = path[i - 1], b = path[i];
  const u = (t - a[0]) / (b[0] - a[0]);
  const x = a[1] + (b[1] - a[1]) * u;
  const y = a[2] + (b[2] - a[2]) * u;
  out.x = (x + MARGIN) * UNIT;
  out.y = (BUTTON_H - y + MARGIN) * UNIT; // the model's +y is up; a canvas's is down
}

/**
 * The effect, on one canvas the console strip parks over its Quests button.
 *
 * The canvas outlives the strip's rebuilds (a resize rebuilds every frame from the FDF): the
 * strip asks for `element` on each build and re-parents it, and whether it is lit is the
 * HUD's (`GameHud.flashQuests`), so nothing is lost in between.
 */
export class QuestButtonFx {
  readonly element = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private ramps: HTMLCanvasElement[][];
  private px = EMITTERS.map(() => new Float32Array(CAPACITY));
  private py = EMITTERS.map(() => new Float32Array(CAPACITY));
  private born = EMITTERS.map(() => new Float32Array(CAPACITY));
  private head = 0;
  private live = 0;
  private clock = 0;
  private emitAccum = 0;
  private scratch = { x: 0, y: 0 };

  /** `spark` is Textures\HeroLevel-Particle.blp decoded, or null with no install mounted. */
  constructor(spark: HTMLCanvasElement | null) {
    const el = this.element;
    el.className = "console-quest-fx";
    el.width = Math.round((BUTTON_W + 2 * MARGIN) * UNIT);
    el.height = Math.round((BUTTON_H + 2 * MARGIN) * UNIT);
    // Laid over the button's own box and out past it by the margin, whatever size the strip
    // drew the button at — percentages of the button, so a resize needs nothing from us.
    el.style.left = `${(-MARGIN / BUTTON_W) * 100}%`;
    el.style.width = `${(1 + (2 * MARGIN) / BUTTON_W) * 100}%`;
    el.style.top = `${(-MARGIN / BUTTON_H) * 100}%`;
    el.style.height = `${(1 + (2 * MARGIN) / BUTTON_H) * 100}%`;
    el.hidden = true;
    this.ctx = el.getContext("2d")!;
    this.ramps = EMITTERS.map((e) => buildRamp(spark, e.color));
  }

  get on(): boolean {
    return !this.element.hidden;
  }

  /** Light it or put it out. Lighting starts from an empty border, as a fresh model does. */
  set(on: boolean): void {
    if (on === this.on) return;
    this.element.hidden = !on;
    this.live = 0;
    this.head = 0;
    this.clock = 0;
    this.emitAccum = 0;
    this.ctx.clearRect(0, 0, this.element.width, this.element.height);
  }

  tick(dtMs: number): void {
    if (!this.on || !this.element.isConnected) return;
    const dt = Math.min(dtMs, LIFESPAN * 1000) / 1000;
    const t0 = this.clock;
    this.clock += dt;
    const oldest = this.clock - LIFESPAN;
    while (this.live > 0 && this.born[0][(this.head - this.live + CAPACITY) % CAPACITY] <= oldest) this.live--;
    // Emit — fractional, and each particle where its emitter WAS when it was born
    // (ModalButtonFx.step has the why).
    this.emitAccum += dt * EMISSION_RATE;
    const n = Math.floor(this.emitAccum);
    this.emitAccum -= n;
    for (let k = 1; k <= n; k++) {
      const at = t0 + (dt * k) / n;
      for (let e = 0; e < EMITTERS.length; e++) {
        along(EMITTERS[e].path, at * 1000, this.scratch);
        this.px[e][this.head] = this.scratch.x;
        this.py[e][this.head] = this.scratch.y;
        this.born[e][this.head] = at;
      }
      this.head = (this.head + 1) % CAPACITY;
      if (this.live < CAPACITY) this.live++;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.element.width, this.element.height);
    ctx.globalCompositeOperation = "lighter"; // filterMode Additive
    for (let e = 0; e < EMITTERS.length; e++) {
      const em = EMITTERS[e];
      const ramp = this.ramps[e];
      if (!ramp.length) continue;
      for (let i = 0; i < this.live; i++) {
        const p = (this.head - 1 - i + CAPACITY * 2) % CAPACITY;
        const f = (this.clock - this.born[e][p]) / LIFESPAN;
        if (f < 0 || f >= 1) continue;
        const a = segment(em.alpha, f);
        if (a <= 0) continue;
        const half = segment(em.scale, f) * UNIT;
        ctx.globalAlpha = a;
        ctx.drawImage(ramp[Math.min(RAMP_STEPS - 1, (f * RAMP_STEPS) | 0)], this.px[e][p] - half, this.py[e][p] - half, half * 2, half * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

/** The spark, baked once per colour step of one emitter's ramp (RGB multiplied, the
 *  texture's own alpha — the glow's shape — left alone). */
function buildRamp(spark: HTMLCanvasElement | null, colors: Emitter["color"]): HTMLCanvasElement[] {
  const src = spark ?? placeholderSpark();
  const w = src.width, h = src.height;
  if (!w || !h) return [];
  let base: ImageData;
  try {
    base = src.getContext("2d")!.getImageData(0, 0, w, h);
  } catch {
    return [];
  }
  const out: HTMLCanvasElement[] = [];
  for (let s = 0; s < RAMP_STEPS; s++) {
    const f = (s + 0.5) / RAMP_STEPS;
    const r = segment(colors.map((c) => c[0]), f);
    const g = segment(colors.map((c) => c[1]), f);
    const b = segment(colors.map((c) => c[2]), f);
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

/** No install mounted: a soft round spark of our own (authentic when present, placeholder
 *  otherwise). */
function placeholderSpark(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 16);
  return c;
}
