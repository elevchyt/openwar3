/**
 * A canvas's backing-store size, WITHOUT asking the layout engine for it every frame.
 *
 * `canvas.clientWidth` is a layout read. Inside the render loop that is not a cheap property
 * fetch: the frame has already written to the DOM by the time it runs — the HP bars over every
 * unit, the resource readouts, and on a selection change a whole new command card — and the
 * read has to flush all of it and lay the page out again, synchronously, to answer. Every
 * frame, for a number that only moves when the window does.
 *
 * That cost is invisible while the page is quiet and grows with whatever else the frame
 * touched, which is exactly the shape of "the game stutters while I click between two
 * buildings": measured on Extreme Candy War, the first layout read of the frame cost 0.18 ms
 * with nothing selected and 0.56 ms while clicking back and forth between two shops.
 *
 * So the size is OBSERVED instead. A `ResizeObserver` reports the element's CSS box out of
 * band, and the frame just multiplies the last report by the current `devicePixelRatio` — a
 * plain property read that lays nothing out. (Multiplying at read time rather than storing the
 * device pixels is what keeps a monitor DPI change correct without an observer for it.)
 *
 * The first measurement is taken eagerly at construction, so the very first frame already has
 * a size; `ResizeObserver` also fires once on `observe`, which keeps it honest from then on.
 * Where the API is missing entirely, this degrades to measuring per read — the old behaviour,
 * which is the right fallback for an environment that cannot do better.
 */
export class CanvasSize {
  private cssW = 0;
  private cssH = 0;
  private observer: ResizeObserver | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.measure();
    if (typeof ResizeObserver === "undefined") return;
    this.observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (!box) return;
      this.cssW = box.width;
      this.cssH = box.height;
    });
    this.observer.observe(canvas);
  }

  /** The canvas's CSS width in pixels (unscaled). */
  get clientWidth(): number {
    if (!this.observer) this.measure();
    return this.cssW;
  }

  /** The canvas's CSS height in pixels (unscaled). */
  get clientHeight(): number {
    if (!this.observer) this.measure();
    return this.cssH;
  }

  /** Backing-store width: the CSS box at the display's current pixel ratio, at least 1. */
  get width(): number {
    return Math.max(1, Math.floor(this.clientWidth * devicePixelRatio));
  }

  /** Backing-store height: the CSS box at the display's current pixel ratio, at least 1. */
  get height(): number {
    return Math.max(1, Math.floor(this.clientHeight * devicePixelRatio));
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private measure(): void {
    this.cssW = this.canvas.clientWidth;
    this.cssH = this.canvas.clientHeight;
  }
}
