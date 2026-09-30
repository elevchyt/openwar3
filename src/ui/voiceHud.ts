// The voice HUD: one small plate per player who is talking (issue #133), stacked down the
// right edge over the console. The look is Source's voice list — a dark plate, the speaker's
// name — with what the developer asked to be told on top: the speaker's RACE (the symbol the
// campaign screens are stamped with), then the name, on a plate FILLED with the speaker's colour
// — what their body wears under the current Ally Color Mode (mapViewer.renderChat's `unitColor`),
// so the plate is also the team: blue you, teal ally, red enemy in mode 3. No separate dot.

/** What one plate shows. Colours are `RRGGBB` (no alpha), or null for the neutral default. */
export interface VoiceEntry {
  player: number;
  name: string;
  /** Race symbol — a data URL from the BLP decoder, or "" while unknown. */
  symbol: string | null;
  /** What the world would tint this player in the current Ally Color Mode: the plate. */
  tint: string | null;
}

export class VoiceHud {
  readonly el: HTMLDivElement;
  private shown = "";

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "hud-voice";
    this.el.hidden = true;
  }

  /** Redraw for the given talkers — cheap when nothing changed, because it runs on a timer. */
  update(entries: readonly VoiceEntry[]): void {
    const sig = entries.map((e) => `${e.player}|${e.name}|${e.symbol?.length ?? 0}|${e.tint}`).join("\n");
    if (sig === this.shown) return;
    this.shown = sig;
    this.el.hidden = entries.length === 0;
    this.el.replaceChildren(...entries.map((e) => this.plate(e)));
  }

  private plate(e: VoiceEntry): HTMLDivElement {
    const plate = document.createElement("div");
    plate.className = "hud-voice-plate";
    if (e.tint) plate.style.setProperty("--voice-tint", `#${e.tint}`);
    if (e.symbol) {
      const img = document.createElement("img");
      img.className = "hud-voice-race";
      img.src = e.symbol;
      img.alt = "";
      plate.append(img);
    }
    const name = document.createElement("span");
    name.className = "hud-voice-name";
    name.textContent = e.name;
    plate.append(name);
    return plate;
  }
}
