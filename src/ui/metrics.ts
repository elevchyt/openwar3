// Discrete on-screen performance metrics (FPS, frame time, sim units, ping).
// Ping is a placeholder until the Phase 8 multiplayer server exists.

const UPDATE_PERIOD = 500; // ms between DOM updates (readable, not flickery)

export class MetricsOverlay {
  private el: HTMLDivElement;
  private frames = 0;
  private accMs = 0;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "metrics";
    this.el.hidden = true;
    document.body.appendChild(this.el);
  }

  /** Call once per rendered frame with the frame delta in ms. */
  frame(dtMs: number, units: number): void {
    this.el.hidden = false;
    this.frames++;
    this.accMs += dtMs;
    if (this.accMs < UPDATE_PERIOD) return;
    const avg = this.accMs / this.frames;
    this.el.textContent = `${Math.round(1000 / avg)} fps · ${avg.toFixed(1)} ms · ${units} units · ping —`;
    this.frames = 0;
    this.accMs = 0;
  }

  hide(): void {
    this.el.hidden = true;
  }

  dispose(): void {
    this.el.remove();
  }
}
