// The modal for a match that ended out from under you — the one hand-built panel left in
// this file. The F10 Game Menu that used to live here is now built from the game's own
// `UI\FrameDef\UI\EscMenuMainPanel.fdf` (src/ui/escMenu.ts); this dialog keeps that panel's
// CSS look because the FDF has no frame for it — a host that quit is not a Warcraft III
// event, so the game ships no screen of its own to copy.
//
// In v1 "ended out from under you" means the HOST left, since there is no host migration
// (docs/multiplayer.md Phase F item 6).
//
// WC3 has the WORDS for it even though it has no panel: `UI\FrameDef\GlobalStrings.fdf`
// carries `GAMEOVER_DISCONNECTED` ("You were disconnected."), `GAMEOVER_GAME_OVER` ("Game
// over.") and `GAMEOVER_QUIT_GAME` ("Quit Game"). They are passed in rather than hardcoded
// here, because the renderer holds the loaded string table and a localized install must say
// what it says — the literals at the call site are only the fallback for a table that has
// not loaded yet.
//
// It is deliberately NOT the F10 menu with a different title: there is nothing to return to.
// A single button, and it leaves.

/** The three GlobalStrings this dialog speaks with. */
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
    // Modal, and it borrows the Esc menu's flag so every HUD hotkey stands down — the match
    // is over, and a player hammering keys at a dead world should not be able to issue orders.
    document.body.classList.add("game-menu-open");
    quit.focus();
  }

  dispose(): void {
    document.body.classList.remove("game-menu-open");
    this.overlay.remove();
  }
}
