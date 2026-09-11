// Discrete on-screen performance metrics plus a sound mute toggle — the bottom corner strip.
//
// Two dresses, decided once at build time:
//
//   · A DEV build (`pnpm dev`) prints the whole developer's readout — fps, frame time, the
//     sim's unit census, the ping — and carries the mute button, because the person reading it
//     is debugging.
//   · A PRODUCTION build — what the desktop app packages and what a release serves — prints
//     what a PLAYER reads: the fps, and in a multiplayer match the ping. Nothing else, and no
//     mute button (the Sound panel owns volume). Single player shows the fps alone: there is
//     no wire to measure, so a ping label there would only ever say "—".
//
// The ping is the slowest link this machine is on (game/matchLink.ts PingMessage): `undefined`
// means "no match link" (single player), `null` "linked, no echo home yet".

import { setGameTip } from "./gameTip";

const UPDATE_PERIOD = 500; // ms between DOM updates (readable, not flickery)

/** The full readout is the developer's; a shipped build shows the player's two numbers. */
const DEV_READOUT = import.meta.env.DEV;

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
    setGameTip(this.muteBtn, "Mute all sound");
    this.muteBtn.onclick = () => {
      this.muted = !this.muted;
      this.muteBtn.textContent = this.muted ? "🔇" : "🔊";
      setGameTip(this.muteBtn, this.muted ? "Unmute sound" : "Mute all sound");
      this.onToggleMute?.(this.muted);
    };
    this.muteBtn.hidden = !DEV_READOUT; // a player's strip carries no debug control
    this.el.append(this.text, this.muteBtn);
    document.body.appendChild(this.el);
  }

  /** Call once per rendered frame with the frame delta in ms. `ping` as `RtsController.pingMs`
   *  answers it: a number, null (linked, nothing measured yet) or undefined (single player). */
  frame(dtMs: number, units: number, ping: number | null | undefined): void {
    this.el.hidden = false;
    this.frames++;
    this.accMs += dtMs;
    if (this.accMs < UPDATE_PERIOD) return;
    const avg = this.accMs / this.frames;
    const fps = `${Math.round(1000 / avg)} fps`;
    const pingText = ping === undefined ? "" : ` · ping ${ping === null ? "—" : `${Math.round(ping)} ms`}`;
    this.text.textContent = DEV_READOUT ? `${fps} · ${avg.toFixed(1)} ms · ${units} units${pingText}` : `${fps}${pingText}`;
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
