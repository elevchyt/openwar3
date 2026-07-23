// The F10 Game Menu, built from the game's own `UI\FrameDef\UI\EscMenuMainPanel.fdf`.
//
// The file is not one screen but FIVE, stacked at the same place and shown one at a time —
// which is why every one of them anchors its contents to `EscMenuMainPanel` (the dialog
// area) rather than to itself:
//
//     Frame "FRAME" "EscMenuMainPanel" {  SetAllPoints,
//         Frame "FRAME" "MainPanel"        { Width 0.288, Height 0.384, … }
//         Frame "FRAME" "EndGamePanel"     { Width 0.288, Height 0.384, … }
//         Frame "FRAME" "ConfirmQuitPanel" { Width 0.336, Height 0.192, … }
//         Frame "FRAME" "HelpPanel"        { Width 0.432, Height 0.384, … }
//         Frame "FRAME" "TipsPanel"        { Width 0.432, Height 0.284, … } }
//
// and why the stone frame behind them is declared OUTSIDE all five, with a comment in the
// shipped file saying so ("the following frames are created within the escmenu itself"):
// there is one backdrop and it is resized to whichever panel is up. So we synthesize the
// root the engine builds — a frame named `EscMenuMainPanel`, sized to the ACTIVE panel,
// holding `EscMenuBackdrop` stretched over it plus that panel's own children — and rebuild
// it when the panel changes. Every button, offset, font, hotkey and caption below is the
// file's; the only thing this module adds is which button does what.
//
// The captions are `GlobalStrings.fdf` keys, so a localized install says what it says, and
// the hotkey letters come with them ("Pause Ga|Cffffffffm|Re" — the M is the accelerator,
// and `ControlShortcutKey "M"` in the FDF is what binds it).
//
// Save / Load / Options / Restart are DISABLED, not hidden: WC3 greys them when they can't
// be used and the FDF ships the greyed face for exactly that (ControlDisabledBackdrop). We
// have no save system, and the Options panel is a separate 750-line file (EscMenuOptionsPanel.fdf).

import { loadHelpText, loadTips } from "../data/uiStrings";
import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame, FdfProp } from "./fdf/parser";
import { numProp, type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

const ESC_MENU_FDF = "UI\\FrameDef\\UI\\EscMenuMainPanel.fdf";

/** Which of the file's five panels is up. */
type PanelId = "main" | "endgame" | "confirmquit" | "help" | "tips";

const PANEL_FRAME: Record<PanelId, string> = {
  main: "MainPanel",
  endgame: "EndGamePanel",
  confirmquit: "ConfirmQuitPanel",
  help: "HelpPanel",
  tips: "TipsPanel",
};

const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const prop = (key: string, ...args: Arg[]): FdfProp => ({ key, args });

export interface EscMenuActions {
  /** Close the menu and resume (the Return to Game button, and Escape). */
  onReturn(): void;
  /** Leave the match for the main menu — Quit Mission, and the End Game button's point. */
  onEndGame(): void;
  /** Pause Game: close the menu but leave the world stopped. */
  onPause?(): void;
}

export class EscMenu {
  private screen: FdfScreen | null = null;
  private scrim: HTMLElement | null = null;
  private panel: PanelId = "main";
  private shown = false;
  private mounting = false;
  private help: string[] = [];
  private tips: string[] = [];
  private tip = 0;
  private onEscape: (e: KeyboardEvent) => void;

  /** `skin` is the war3skins.txt section the chrome is decorated from — WC3 gives the
   *  in-game panels the LOCAL player's race, so an Orc player's menu is Orc-bordered. */
  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private actions: EscMenuActions,
  ) {
    // Escape closes the menu, captured ahead of the HUD's own Escape handler. From a
    // sub-panel it steps BACK one level instead — the same thing its Previous Menu /
    // Cancel button does, and what the reference does with the key.
    this.onEscape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !this.shown) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.panel === "main") this.actions.onReturn();
      else this.go(this.panel === "confirmquit" ? "endgame" : "main");
    };
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.panel = "main";
    document.body.classList.add("game-menu-open"); // HUD hotkeys check this and stand down
    window.addEventListener("keydown", this.onEscape, true);
    void this.build();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    document.body.classList.remove("game-menu-open");
    window.removeEventListener("keydown", this.onEscape, true);
    this.teardown();
  }

  /** Flip visibility; returns the new visible state. */
  toggle(): boolean {
    if (this.shown) this.hide();
    else this.show();
    return this.shown;
  }

  dispose(): void {
    this.hide();
    this.teardown();
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.scrim?.remove();
    this.scrim = null;
  }

  /** Switch panels — a full rebuild, because the backdrop is sized to the panel. */
  private go(panel: PanelId): void {
    this.panel = panel;
    void this.build();
  }

  private async build(): Promise<void> {
    if (this.mounting) return;
    this.mounting = true;
    try {
      // The prose pages are read once, on the first panel that needs them.
      if (this.panel === "help" && !this.help.length) this.help = await loadHelpText(this.vfs);
      if (this.panel === "tips" && !this.tips.length) this.tips = await loadTips(this.vfs);
      if (!this.shown) return; // closed while we were reading

      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: ESC_MENU_FDF,
        rootFrame: "EscMenuMainPanel",
        overlayClass: "fdf-ingame fdf-dialog",
        skin: this.skin,
        centerRoot: true,
        buildRoot: (lib) => this.rootFrame(lib),
        handlers: this.handlers(),
        onBuild: (built) => this.onBuild(built),
      });
      prev?.dispose();
      this.screen = screen;
      // Modal, as in the game: the world behind must not take the click that missed a
      // button. The scrim is invisible — WC3 does not dim the map under the Esc menu.
      if (!this.scrim) {
        this.scrim = document.createElement("div");
        this.scrim.className = "fdf-dialog-scrim";
        this.container.appendChild(this.scrim);
      }
      this.container.appendChild(screen.element); // scrim under the panel, both over the rest
    } catch (err) {
      console.warn("[escmenu] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /**
   * The root the engine builds: a frame named `EscMenuMainPanel` — the name every panel's
   * contents anchor to — sized to the ACTIVE panel, wearing the shared `EscMenuBackdrop`.
   *
   * The backdrop's own Width/Height are dropped: it declares MainPanel's 0.288 × 0.384, but
   * it is the frame that stretches to fit whichever panel is up (ConfirmQuit is wider and
   * half as tall), and SetAllPoints is how the engine does that.
   */
  private rootFrame(lib: FdfLibrary): FdfFrame {
    const panel = lib.resolveRoot(PANEL_FRAME[this.panel]);
    const backdrop = lib.resolveRoot("EscMenuBackdrop");
    if (!panel) throw new Error(`FDF: frame "${PANEL_FRAME[this.panel]}" not found`);

    const children: FdfFrame[] = [];
    if (backdrop) {
      children.push({
        ...backdrop,
        props: [
          ...backdrop.props.filter((p) => p.key !== "Width" && p.key !== "Height"),
          prop("SetAllPoints"),
        ],
      });
    }
    children.push(...panel.children);

    return {
      type: "FRAME",
      name: "EscMenuMainPanel",
      inherits: null,
      withChildren: false,
      props: [
        prop("Width", num(numProp(panel, "Width") ?? 0.288)),
        prop("Height", num(numProp(panel, "Height") ?? 0.384)),
      ],
      children,
    };
  }

  /** Every button on every panel. A name that isn't on the panel currently built simply
   *  never binds — the renderer only wires handlers for frames it actually drew. */
  private handlers(): Record<string, () => void> {
    return {
      // --- MainPanel
      PauseButton: () => (this.actions.onPause ?? this.actions.onReturn)(),
      HelpButton: () => this.go("help"),
      TipsButton: () => this.go("tips"),
      EndGameButton: () => this.go("endgame"),
      ReturnButton: () => this.actions.onReturn(),
      // --- EndGamePanel. "Quit Mission" leaves the match; "Exit Program" asks first, as in
      // the game — and in a browser the nearest honest thing to exiting is the same door.
      QuitButton: () => this.actions.onEndGame(),
      ExitButton: () => this.go("confirmquit"),
      PreviousButton: () => this.go("main"),
      // --- ConfirmQuitPanel
      ConfirmQuitQuitButton: () => this.actions.onEndGame(),
      ConfirmQuitCancelButton: () => this.go("endgame"),
      // --- HelpPanel / TipsPanel
      HelpOKButton: () => this.go("main"),
      TipsOKButton: () => this.go("main"),
      TipsBackButton: () => this.stepTip(-1),
      TipsNextButton: () => this.stepTip(1),
    };
  }

  /** Fill the panel's contents and grey what we can't do yet. Runs on every build —
   *  including the rebuild a RESIZE triggers, which is why it can't be done inline. */
  private onBuild(screen: FdfScreen): void {
    // No save system, and no Options panel yet (EscMenuOptionsPanel.fdf is its own screen).
    for (const name of ["SaveGameButton", "LoadGameButton", "OptionsButton", "RestartButton"]) {
      screen.setEnabled(name, false);
    }
    if (this.panel === "help") {
      screen.textArea("HelpTextArea")?.setLines(this.help);
    } else if (this.panel === "tips") {
      // One tip per page — that is what Back and Next are for. Its number is not in the
      // FDF (the panel's title is the flat "Warcraft III Tips"), so the page counter is ours.
      screen.textArea("TipsTextArea")?.setLines(this.tips.length ? [this.tips[this.tip]] : []);
      screen.setEnabled("TipsBackButton", this.tip > 0);
      screen.setEnabled("TipsNextButton", this.tip < this.tips.length - 1);
    }
  }

  private stepTip(by: number): void {
    const next = this.tip + by;
    if (next < 0 || next >= this.tips.length) return;
    this.tip = next;
    if (this.screen) this.onBuild(this.screen);
  }
}
