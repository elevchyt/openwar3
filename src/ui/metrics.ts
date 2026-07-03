// Discrete on-screen performance metrics (FPS, frame time, sim units, ping) plus
// a sound mute toggle. Bottom-left debug panel. Ping is a placeholder until the
// Phase 8 multiplayer server exists.

const UPDATE_PERIOD = 500; // ms between DOM updates (readable, not flickery)

export class MetricsOverlay {
  private el: HTMLDivElement;
  private text: HTMLSpanElement;
  private muteBtn: HTMLButtonElement;
  private muted = false;
  private frames = 0;
  private accMs = 0;

  /** Toggled when the mute button is clicked (new muted state). Host wires audio. */
  onToggleMute: ((muted: boolean) => void) | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "metrics";
    this.el.hidden = true;
    this.text = document.createElement("span");
    this.muteBtn = document.createElement("button");
    this.muteBtn.className = "metrics-mute";
    this.muteBtn.textContent = "🔊";
    this.muteBtn.title = "Mute all sound";
    this.muteBtn.onclick = () => {
      this.muted = !this.muted;
      this.muteBtn.textContent = this.muted ? "🔇" : "🔊";
      this.muteBtn.title = this.muted ? "Unmute sound" : "Mute all sound";
      this.onToggleMute?.(this.muted);
    };
    this.el.append(this.text, this.muteBtn);
    document.body.appendChild(this.el);
  }

  /** Call once per rendered frame with the frame delta in ms. */
  frame(dtMs: number, units: number): void {
    this.el.hidden = false;
    this.frames++;
    this.accMs += dtMs;
    if (this.accMs < UPDATE_PERIOD) return;
    const avg = this.accMs / this.frames;
    this.text.textContent = `${Math.round(1000 / avg)} fps · ${avg.toFixed(1)} ms · ${units} units · ping — `;
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
