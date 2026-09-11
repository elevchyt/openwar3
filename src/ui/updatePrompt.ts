import { showGlueDialog, type GlueDialog } from "./glueDialog";
import { showUpdateOverlay, type UpdateOverlay } from "./updateOverlay";
import { setGameTip } from "./gameTip";
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
// ONE question, and then the game gets on with it. The player is asked whether to fetch the new
// build; saying no leaves them on the one they have and the offer comes back next launch. Saying
// yes puts up a screen they cannot leave (ui/updateOverlay.ts) and the game downloads, installs
// and restarts itself behind it — asking a second time, once the bytes are already on disk and
// the player has been watching a progress bar, is asking somebody to confirm the thing they just
// asked for.

/** Where the new build lives — the same GitHub releases the shell's check reads
 *  (electron/updates.mjs). The version line in the prompt is a link here, so a player who
 *  wants to read what changed before saying yes can, in their own browser: in the desktop app
 *  a `target="_blank"` link goes through `setWindowOpenHandler` to `shell.openExternal`
 *  (electron/main.mjs) and never opens a second game window. */
const RELEASES_URL = "https://github.com/elevchyt/openwar3/releases";

/**
 * Make the gold version line of the prompt a link to the releases page.
 *
 * The message is WC3 markup painted by the FDF renderer, which has no vocabulary for a link
 * — `|cffffcc00` is a colour, not an anchor — so the version's coloured span is found in the
 * painted frame and wrapped after the fact. It keeps its gold (the anchor inherits the span's
 * colour) and gains an underline, and takes the pointer back: the frame it sits in is
 * `pointer-events: none` like every FDF frame, so the anchor says otherwise for itself.
 *
 * The gold span is the one INSIDE the frame's span, never the frame's span itself: `paintText`
 * (ui/fdf/render.ts) writes the frame's FontColor inline on the outer span, so a bare
 * `span[style]` matches that first and the whole message — question and all — became the link.
 */
function linkVersionLine(dialog: GlueDialog): void {
  const text = dialog.frame("DialogText");
  const gold = text?.querySelector<HTMLElement>("span span[style]");
  if (!gold || gold.closest("a")) return;
  const a = document.createElement("a");
  a.className = "update-release-link";
  a.href = RELEASES_URL;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  setGameTip(a, RELEASES_URL);
  gold.replaceWith(a);
  a.appendChild(gold);
}

/** Only ever asked once per launch, however many times the state changes. */
let asked = false;
/** Set the moment Restart is pressed, so a late progress event cannot raise the overlay again
 *  over a game that is quitting. */
let installing = false;

export function watchForUpdates(container: HTMLElement, vfs: DataSource): () => void {
  let dialog: GlueDialog | null = null;
  /** Up from the moment the player says yes until the new build is on disk. Not dismissable —
   *  see ui/updateOverlay.ts for why. */
  let overlay: UpdateOverlay | null = null;
  let alive = true;

  const show = async (text: string, buttons: "ok" | "yesno", onConfirm?: () => void): Promise<GlueDialog | null> => {
    dialog?.close();
    dialog = null;
    if (!alive) return null;
    dialog = await showGlueDialog({
      container, vfs, text, buttons,
      // Ours, not the game's: this is not a question about the main menu behind it, so the menu
      // goes back — the same rule the Join Server panel follows (src/style.css).
      dimmed: true,
      onConfirm: () => { dialog = null; onConfirm?.(); },
      onCancel: () => { dialog = null; },
    });
    return dialog;
  };

  return onUpdateState((state: UpdateState) => {
    if (!alive) return;
    switch (state.phase) {
      case "available":
        if (asked) return;
        asked = true;
        void show(
          // The gold line names the build the way the overlay's caption does ("Downloading
          // OpenWar3 0.2.4…"), and it is the ONLY part of the message that is a link.
          `A new version of OpenWar3 is available|n|n|cffffcc00OpenWar3 ${state.version ?? "?"}|r|n|nDownload it now?`,
          "yesno",
          () => {
            downloadUpdate();
            // The overlay goes up on the DECISION, not on the first progress event: a download
            // that is slow to start would otherwise leave the player on a live menu wondering
            // whether their Yes did anything.
            void showUpdateOverlay(container, vfs, state.version).then((o) => {
              if (alive && !installing) overlay = o;
              else o.dispose();
            });
          },
        ).then((d) => { if (d) linkVersionLine(d); });
        return;
      case "downloading":
        overlay?.setProgress((state.percent ?? 0) / 100);
        return;
      case "ready":
        // No second question: the download is done, so the game restarts into it. The overlay
        // stays up through the swap — it is the last thing on screen before the window goes, and
        // it says what is happening rather than vanishing without a word.
        if (installing) return;
        installing = true;
        overlay?.setProgress(1);
        overlay?.setCaption(`Restarting into OpenWar3 ${state.version ?? ""}…`);
        installUpdate();
        return;
      case "error":
        overlay?.dispose();
        overlay = null;
        // Not shown. Failing to REACH the releases page is not the player's problem to solve
        // mid-session, and a game that opens a box about it every launch on a machine with no
        // internet is a game with a bug in it. The console keeps the reason.
        console.warn("[OpenWar3] update check failed:", state.error);
        return;
      default:
        return; // idle / checking / none / downloading — nothing to say
    }
  }) && (() => { alive = false; dialog?.close(); overlay?.dispose(); });
}
