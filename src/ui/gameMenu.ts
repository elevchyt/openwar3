// WC3 F10 "Game Menu": a centred modal that pauses the match. Save/Load/Options/
// Help/Tips are placeholders (disabled) until those systems exist; End Game and
// Return to Game are wired. Mirrors the original console layout.

export interface GameMenuActions {
  onReturn: () => void; // close + unpause
  onEndGame: () => void; // leave the match → main menu
}

export class GameMenu {
  private overlay: HTMLDivElement;
  private onEscape: (e: KeyboardEvent) => void;

  constructor(parent: HTMLElement, actions: GameMenuActions) {
    this.overlay = document.createElement("div");
    this.overlay.className = "game-menu-overlay";
    this.overlay.hidden = true;

    const panel = document.createElement("div");
    panel.className = "game-menu";
    const title = document.createElement("div");
    title.className = "game-menu-title";
    title.textContent = "Game Menu";
    panel.appendChild(title);

    const btn = (label: string, onClick: (() => void) | null): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "game-menu-btn";
      b.textContent = label;
      if (onClick) b.onclick = onClick;
      else {
        b.disabled = true;
        b.title = "Not available yet";
      }
      return b;
    };

    panel.append(btn("Save Game", null), btn("Load Game", null), btn("Options", null));
    const row = document.createElement("div");
    row.className = "game-menu-row";
    row.append(btn("Help", null), btn("Tips", null));
    panel.appendChild(row);
    const end = btn("End Game", actions.onEndGame);
    end.classList.add("danger");
    const ret = btn("Return to Game", actions.onReturn);
    ret.classList.add("return");
    panel.append(end, ret);

    this.overlay.appendChild(panel);
    parent.appendChild(this.overlay);

    // Escape closes the menu (captured before the HUD's own Escape handler).
    this.onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        actions.onReturn();
      }
    };
  }

  get visible(): boolean {
    return !this.overlay.hidden;
  }

  show(): void {
    if (this.visible) return;
    this.overlay.hidden = false;
    document.body.classList.add("game-menu-open"); // HUD hotkeys check this and stand down
    window.addEventListener("keydown", this.onEscape, true);
  }

  hide(): void {
    if (!this.visible) return;
    this.overlay.hidden = true;
    document.body.classList.remove("game-menu-open");
    window.removeEventListener("keydown", this.onEscape, true);
  }

  /** Flip visibility; returns the new visible state. */
  toggle(): boolean {
    if (this.visible) this.hide();
    else this.show();
    return this.visible;
  }

  dispose(): void {
    this.hide();
    this.overlay.remove();
  }
}
