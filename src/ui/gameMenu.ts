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

/**
 * The modal for a match that ended out from under you — in v1 that means the HOST left, since
 * there is no host migration (docs/multiplayer.md Phase F item 6).
 *
 * WC3 has this dialog and has the words for it: `UI\FrameDef\GlobalStrings.fdf` carries
 * `GAMEOVER_DISCONNECTED` ("You were disconnected."), `GAMEOVER_GAME_OVER` ("Game over.") and
 * `GAMEOVER_QUIT_GAME` ("Quit Game"). They are passed in rather than hardcoded here, because
 * the renderer holds the loaded string table and a localized install must say what it says —
 * the literals below are only the fallback for an install whose table has not loaded yet.
 *
 * It is deliberately NOT the F10 menu with a different title: there is nothing to return to.
 * A single button, and it leaves.
 */
export interface MatchOverStrings {
  /** GAMEOVER_GAME_OVER. */
  title: string;
  /** GAMEOVER_DISCONNECTED, or whatever the wire said. */
  message: string;
  /** GAMEOVER_QUIT_GAME. */
  quit: string;
}

export class MatchOverDialog {
  private overlay: HTMLDivElement;

  constructor(parent: HTMLElement, strings: MatchOverStrings, onQuit: () => void) {
    this.overlay = document.createElement("div");
    this.overlay.className = "game-menu-overlay";

    const panel = document.createElement("div");
    panel.className = "game-menu";
    const title = document.createElement("div");
    title.className = "game-menu-title";
    title.textContent = strings.title;
    const message = document.createElement("div");
    message.className = "game-menu-message";
    message.textContent = strings.message;
    const quit = document.createElement("button");
    quit.className = "game-menu-btn danger";
    quit.textContent = strings.quit;
    quit.onclick = onQuit;
    panel.append(title, message, quit);

    this.overlay.appendChild(panel);
    parent.appendChild(this.overlay);
    // Modal, and it borrows the F10 menu's flag so every HUD hotkey stands down — the match
    // is over, and a player hammering keys at a dead world should not be able to issue orders.
    document.body.classList.add("game-menu-open");
    quit.focus();
  }

  dispose(): void {
    document.body.classList.remove("game-menu-open");
    this.overlay.remove();
  }
}
