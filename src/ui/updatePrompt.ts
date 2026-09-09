import { showGlueDialog, type GlueDialog } from "./glueDialog";
import { downloadUpdate, installUpdate, onUpdateState, type UpdateState } from "../assets/nativeInstall";
import type { DataSource } from "../vfs/types";

// "A new version is out" — asked in the GAME's own message box (`UI\FrameDef\Glue\DialogWar3.fdf`)
// rather than the operating system's.
//
// The alternative was a native dialog, which is what the update check could put up the instant it
// finishes — seconds after launch, over a black window. This waits instead: the shell holds the
// answer (electron/updates.mjs) and the question is asked once the MENU is up, in the chrome
// every other question on that screen is asked in. A player who has just double-clicked the game
// is not yet the person to interrupt; a player looking at the main menu is.
//
// Both steps are the player's. Downloading is one question and restarting is another, because a
// game that replaced itself under somebody mid-match would be worse than one a version behind.
// Saying no to either leaves them playing the version they have, and the offer comes back next
// launch.

/** Only ever asked once per launch, however many times the state changes. */
let asked = false;

export function watchForUpdates(container: HTMLElement, vfs: DataSource): () => void {
  let dialog: GlueDialog | null = null;
  let alive = true;

  const show = async (text: string, buttons: "ok" | "yesno", onConfirm?: () => void): Promise<void> => {
    dialog?.close();
    dialog = null;
    if (!alive) return;
    dialog = await showGlueDialog({
      container, vfs, text, buttons,
      // Ours, not the game's: this is not a question about the main menu behind it, so the menu
      // goes back — the same rule the Join Server panel follows (src/style.css).
      dimmed: true,
      onConfirm: () => { dialog = null; onConfirm?.(); },
      onCancel: () => { dialog = null; },
    });
  };

  return onUpdateState((state: UpdateState) => {
    if (!alive) return;
    switch (state.phase) {
      case "available":
        if (asked) return;
        asked = true;
        void show(
          `A new version of OpenWar3 is available|n|n|cffffcc00Version ${state.version ?? "?"}|r|n|nDownload it now?`,
          "yesno",
          () => downloadUpdate(),
        );
        return;
      case "ready":
        // The second question, and the only one that ends the session. It is asked whether or
        // not they were watching the download: a finished update nobody is told about is one
        // that installs itself at some surprising later moment instead.
        void show(
          `OpenWar3 ${state.version ?? ""} is ready to install.|n|nRestart the game now?`,
          "yesno",
          () => installUpdate(),
        );
        return;
      case "error":
        // Not shown. Failing to REACH the releases page is not the player's problem to solve
        // mid-session, and a game that opens a box about it every launch on a machine with no
        // internet is a game with a bug in it. The console keeps the reason.
        console.warn("[OpenWar3] update check failed:", state.error);
        return;
      default:
        return; // idle / checking / none / downloading — nothing to say
    }
  }) && (() => { alive = false; dialog?.close(); });
}
