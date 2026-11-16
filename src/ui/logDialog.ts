// The F12 Message Log, built from the game's own `UI\FrameDef\UI\LogDialog.fdf`.
//
// In a CAMPAIGN chapter the console's fourth button is not Chat — there is nobody to talk to —
// but **Log**: same button, same key, a different caption (`KEY_LOG` = "Log (F12)", `LOG` for
// its greyed face) and a different panel behind it. `GlobalStrings.fdf` says what it is for in
// the button's own tooltip:
//
//     UPPER_BUTTON_LOG_TIP   "Message Log Dialog (F12)"
//     UPPER_BUTTON_LOG_UBER  "This dialog allows you to view any quest or hint messages that
//                             have previously been displayed to you."
//
// The panel is the smallest in the game: a title (`MESSAGE_LOG`), one TEXTAREA (`LogArea`,
// 128 lines — `TextAreaMaxLines`, which is why the model keeps no more than that) and OK.
// A chapter's messages scroll off the screen in seconds, and the tutorial chapters say most
// of what they have to say that way; this is where they can be read back.

import type { DataSource } from "../vfs/types";
import { mountFdfScreen, playFdfClick, type FdfScreen } from "./fdf/render";
import { ESC_TEMPLATES_OVERRIDE } from "../overrides";

const LOG_FDF = "UI\\FrameDef\\UI\\LogDialog.fdf";

/** `LogArea`'s own `TextAreaMaxLines`. */
export const LOG_MAX_LINES = 128;

export interface LogDialogModel {
  /** Every message shown to this player so far, oldest first, as WC3 markup. */
  lines(): readonly string[];
  /** The panel has gone — by OK or by Escape, the two doors the host never sees. */
  onClose?(): void;
}

export class LogDialogOverlay {
  private screen: FdfScreen | null = null;
  private scrim: HTMLElement | null = null;
  private shown = false;
  private mounting = false;
  private onEscape: (e: KeyboardEvent) => void;

  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private model: LogDialogModel,
  ) {
    this.onEscape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !this.shown) return;
      e.preventDefault();
      e.stopPropagation();
      playFdfClick();
      this.close();
    };
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    window.addEventListener("keydown", this.onEscape, true);
    void this.build();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    window.removeEventListener("keydown", this.onEscape, true);
    this.teardown();
  }

  dispose(): void {
    this.hide();
    this.teardown();
  }

  /** OK and Escape: shut, and tell the host (which is holding the world for us). */
  private close(): void {
    this.hide();
    this.model.onClose?.();
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.scrim?.remove();
    this.scrim = null;
  }

  private async build(): Promise<void> {
    if (this.mounting) return;
    this.mounting = true;
    try {
      // Scrim first, panel inside it — see ChatDialogOverlay.build / EscMenu.build.
      if (!this.scrim) {
        this.scrim = document.createElement("div");
        this.scrim.className = "fdf-dialog-scrim";
        this.container.appendChild(this.scrim);
      }
      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.scrim,
        vfs: this.vfs,
        fdfPath: LOG_FDF,
        rootFrame: "LogDialog",
        overlayClass: "fdf-ingame fdf-dialog",
        skin: this.skin,
        centerRoot: true,
        overrides: [ESC_TEMPLATES_OVERRIDE],
        handlers: {
          LogOkButton: () => this.close(),
        },
        onBuild: (built) => this.fill(built),
      });
      if (!this.shown) {
        screen.dispose();
        return;
      }
      prev?.dispose();
      this.screen = screen;
      // Again now that it is in the document: a detached scroll box has no height to scroll.
      screen.textArea("LogArea")?.scrollToBottom();
    } catch (err) {
      console.warn("[log] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /** Newest last and scrolled to it. Runs on every build, resize included. */
  private fill(screen: FdfScreen): void {
    const area = screen.textArea("LogArea");
    area?.setLines([...this.model.lines()]);
    area?.scrollToBottom();
  }
}
