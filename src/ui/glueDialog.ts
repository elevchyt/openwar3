import type { DataSource } from "../vfs/types";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

// The menus' own message box — UI\FrameDef\Glue\DialogWar3.fdf (issue #80).
//
// The glue screens do not use the in-game `ScriptDialog` (ui/gameDialog.ts) for a question like
// "Are you sure you want to delete the single-player profile '%s'?"; they have their own, and it
// is the Battle.net dialogue chrome: a 0.35 × 0.2 box on `bnet-dialoguebox-background.blp`
// carrying THREE buttons declared side by side — `DialogButtonOK`, and a `DialogButtonYes` /
// `DialogButtonNo` pair. The engine shows the pair it needs and hides the other, which is why
// their SetPoints overlap: OK sits at BOTTOM -0.015, Yes at -0.114 and No at +0.04.
//
// So this takes which of the two shapes to put up and hides the rest. `DialogIcon` goes with
// them: it is a 0.05 square to the LEFT of the message for the dialogs that carry one, and
// nothing here does — left in, it draws a blank plate beside every line of text.

/** Which buttons a dialog carries — the two sets the FDF is built for. */
export type GlueDialogButtons = "ok" | "yesno";

export interface GlueDialogOptions {
  container: HTMLElement;
  vfs: DataSource;
  /** The message, in WC3 markup. */
  text: string;
  buttons: GlueDialogButtons;
  /** Yes / OK. */
  onConfirm?: () => void;
  /** No, and the Escape key. */
  onCancel?: () => void;
}

/** A dialog on screen; `close()` takes it and its scrim away. */
export interface GlueDialog {
  close(): void;
}

const DIALOG_FDF = "UI\\FrameDef\\Glue\\DialogWar3.fdf";

/** Frames each shape does NOT show. `DialogIcon` is hidden either way (see the header). */
const HIDDEN: Record<GlueDialogButtons, string[]> = {
  ok: ["DialogIcon", "DialogButtonYesBackdrop", "DialogButtonNoBackdrop"],
  yesno: ["DialogIcon", "DialogButtonOKBackdrop"],
};

/**
 * Put a message box up over the current glue screen. The scrim under it swallows clicks, so
 * the screen behind cannot be operated while the question is unanswered — which is the whole
 * point of asking.
 */
export async function showGlueDialog(opts: GlueDialogOptions): Promise<GlueDialog> {
  const scrim = document.createElement("div");
  scrim.className = "glue-dialog-scrim";
  opts.container.appendChild(scrim);

  let screen: FdfScreen | null = null;
  const close = (): void => {
    window.removeEventListener("keydown", onKey, true);
    screen?.dispose();
    scrim.remove();
  };
  const answer = (fn?: () => void): void => { close(); fn?.(); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    answer(opts.onCancel);
  };
  window.addEventListener("keydown", onKey, true);

  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: DIALOG_FDF,
      rootFrame: "DialogWar3",
      centerRoot: true, // the FDF gives the box its own 0.35 × 0.2 and nothing else
      hidden: HIDDEN[opts.buttons],
      textOverrides: { DialogText: opts.text },
      handlers: {
        DialogButtonOK: () => answer(opts.onConfirm),
        DialogButtonYes: () => answer(opts.onConfirm),
        DialogButtonNo: () => answer(opts.onCancel),
      },
    });
  } catch (err) {
    close();
    throw err;
  }
  return { close };
}
