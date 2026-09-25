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
// Save / Load / Restart are DISABLED, not hidden: WC3 greys them when they can't be used and
// the FDF ships the greyed face for exactly that (ControlDisabledBackdrop). We have no save
// system.
//
// OPTIONS is four more panels on the same stack, and they are in another file — the game's own
// `UI\FrameDef\UI\EscMenuOptionsPanel.fdf`, loaded into this screen's library beside the main
// one (`includeFdf`) exactly as the engine has both in scope at once. Its panels anchor to a
// root called `EscMenuOptionsPanel` rather than to `EscMenuMainPanel`, so the root this file
// synthesizes takes the name the active panel expects. What those panels' controls DO is
// ui/escOptions.ts's; the stack, the chrome and the buttons are here.

import { loadHelpText, loadTips } from "../data/uiStrings";
import type { DataSource } from "../vfs/types";
import type { SoundBoard } from "../audio/sounds";
import type { Arg, FdfFrame, FdfProp } from "./fdf/parser";
import { numProp, type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, playFdfClick, type FdfScreen } from "./fdf/render";
import { ESC_OPTIONS_OVERRIDE, OW3_STRINGS } from "../overrides";
import { EscOptions } from "./escOptions";
import { gamepadButtonPressed } from "./gamepad";

const ESC_MENU_FDF = "UI\\FrameDef\\UI\\EscMenuMainPanel.fdf";
const ESC_OPTIONS_FDF = "UI\\FrameDef\\UI\\EscMenuOptionsPanel.fdf";

/** Which of the two files' nine panels is up. */
type PanelId = "main" | "endgame" | "confirmquit" | "help" | "tips" | "options" | "optgameplay" | "optvideo" | "optsound";

const PANEL_FRAME: Record<PanelId, string> = {
  main: "MainPanel",
  endgame: "EndGamePanel",
  confirmquit: "ConfirmQuitPanel",
  help: "HelpPanel",
  tips: "TipsPanel",
  options: "OptionsPanel",
  optgameplay: "GameplayPanel",
  optvideo: "VideoPanel",
  optsound: "SoundPanel",
};

/** The four panels that come out of `EscMenuOptionsPanel.fdf`, and which of the three settings
 *  panels each of the last three is (ui/escOptions.ts binds by that). */
const OPTIONS_PANELS: Partial<Record<PanelId, "gameplay" | "video" | "sound" | null>> = {
  options: null,
  optgameplay: "gameplay",
  optvideo: "video",
  optsound: "sound",
};

/**
 * The size of the Options panel — the ONE thing about it that is not in the file.
 *
 * `EscMenuMainPanel.fdf` gives each of its five panels a Width and a Height; the options file
 * gives its four none at all, because in the engine they are laid inside a frame the game sizes
 * for them. The file still says what that size is, twice over: the OK/Cancel row is inset
 * 0.028125 from the left and is 0.112 + 0.00625 + 0.112 wide, which comes to 0.286625 plus the
 * same inset on the right — and `EscMenuBackdrop`, the shared stone frame, declares exactly the
 * 0.288 x 0.384 that MainPanel does. The tallest of the four (Gameplay) ends 0.007 above the OK
 * button at that height, so it is the size the panels were authored against.
 */
const OPTIONS_PANEL_SIZE = { width: 0.288, height: 0.384 };

const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const prop = (key: string, ...args: Arg[]): FdfProp => ({ key, args });

export interface EscMenuActions {
  /** Close the menu and resume (the Return to Game button, and Escape). */
  onReturn(): void;
  /** Leave the match for the main menu — Quit Mission, and the End Game button's point. */
  onEndGame(): void;
  /** Exit Program, once confirmed: close the GAME, not just the match. Absent falls back to
   *  `onEndGame`, which is also what a page that cannot close itself should do. */
  onExitProgram?(): void;
  /** Pause Game / Resume Game: close the menu and TOGGLE the match's own pause — the one
   *  button on the panel that does not simply put the world back the way it found it. */
  onPause?(): void;
  /** Is the match stopped by a PLAYER right now (as opposed to merely by this menu being
   *  open)? Decides which of the file's two captions the button wears. Absent reads as
   *  "never paused", which is what a screen with no pause to offer wants. */
  isPaused?(): boolean;
  /** The live SoundBoard, so the Options screen's Sound panel is audible as it is dragged. */
  sounds?(): SoundBoard | null;
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
  private lib: FdfLibrary | null = null;
  private readonly options: EscOptions;
  private onEscape: (e: KeyboardEvent) => void;

  /** `skin` is the war3skins.txt section the chrome is decorated from — WC3 gives the
   *  in-game panels the LOCAL player's race, so an Orc player's menu is Orc-bordered. */
  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private actions: EscMenuActions,
  ) {
    this.options = new EscOptions({ sounds: () => this.actions.sounds?.() ?? null });
    // Escape closes the menu, captured ahead of the HUD's own Escape handler. From a
    // sub-panel it steps BACK one level instead — the same thing its Previous Menu /
    // Cancel button does, and what the reference does with the key.
    this.onEscape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !this.shown) return;
      e.preventDefault();
      e.stopPropagation();
      // Whichever button this key is standing in for — Return to Game on the main panel,
      // Previous Menu / Cancel on a sub-panel — it makes that button's sound.
      playFdfClick();
      if (this.panel === "main") this.actions.onReturn();
      else this.go(this.stepBack());
    };
  }

  /** Which panel a Previous Menu / Cancel — or the Escape key standing in for one — goes back
   *  to from here. One level up the stack, every time. */
  private stepBack(): PanelId {
    if (this.panel === "confirmquit") return "endgame";
    if (this.panel in OPTIONS_PANELS) {
      // Escape on a settings panel is its CANCEL button, so it undoes the visit exactly as the
      // button does — anything applied live along the way included.
      if (this.panel !== "options") {
        this.options.cancel();
        return "options";
      }
    }
    return "main";
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.panel = "main";
    // A setting changed from the glue Options screen since the last visit is what these panels
    // should show, so the store is re-read rather than remembered from last time.
    this.options.reload();
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

      // The SCRIM first, and the panel mounted INSIDE it — not beside it. `modalOver` (ui/modal.ts)
      // is the one answer to "is a modal over this screen", and what it asks is whether a scrim
      // CONTAINS the screen: a panel that is its scrim's sibling is read as having a modal over
      // itself and stands its own keyboard down, which is exactly what killed every accelerator on
      // this panel — Pause Game's M, Help's H, Quit Mission's Q (issue #147). Modal, as in the
      // game: the world behind must not take the click that missed a button. The scrim is
      // invisible — WC3 does not dim the map under the Esc menu.
      if (!this.scrim) {
        this.scrim = document.createElement("div");
        this.scrim.className = "fdf-dialog-scrim";
        this.container.appendChild(this.scrim);
      }
      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.scrim,
        vfs: this.vfs,
        fdfPath: ESC_MENU_FDF,
        // The Options panels are four more faces of this same screen, and they are in the
        // game's other in-game FrameDef file — so it is loaded into the same library, which is
        // also what puts `EscMenuTemplates.fdf` in scope for both.
        includeFdf: [ESC_OPTIONS_FDF],
        rootFrame: "EscMenuMainPanel",
        overlayClass: "fdf-ingame fdf-dialog",
        skin: this.skin,
        centerRoot: true,
        overrides: [OW3_STRINGS, ESC_OPTIONS_OVERRIDE],
        buildRoot: (lib) => this.rootFrame(lib),
        handlers: this.handlers(),
        onBuild: (built) => this.onBuild(built),
      });
      // Closed while we were mounting? Then this panel is already gone as far as everything
      // else is concerned, and showing it now would strand it on screen with nothing left to
      // close it. Mounting an FDF screen is ASYNC (it reads and decodes the panel's BLPs), so
      // the window is real: a cinematic that starts on the frame after the player hit F10
      // hides the menu, and the mount lands afterwards. (Same guard in the other three
      // panels — see mapViewer.closePanels.)
      if (!this.shown) {
        screen.dispose();
        return;
      }
      prev?.dispose();
      this.screen = screen;
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
    this.lib = lib; // captured so the Options panels' readouts resolve through GlobalStrings
    if (this.panel in OPTIONS_PANELS) return this.optionsRoot(lib);
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
    children.push(...panel.children.map((c) => this.captionPause(c)));

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

  /**
   * The same root, for the four panels of `EscMenuOptionsPanel.fdf`.
   *
   * Three things make it its own function rather than a branch of `rootFrame`. The root has to
   * be NAMED `EscMenuOptionsPanel`, because that is the frame every control in that file
   * anchors to. Its size is not in the file (see `OPTIONS_PANEL_SIZE`). And the panel frame is
   * kept as a CHILD, stretched over the root, rather than having its children hoisted the way
   * the main file's are: `GameplayPanel` is what our own override hangs its two extra rows
   * inside (`add: { into: "GameplayPanel" }`), so the container has to still be there when the
   * override edits the built tree.
   *
   * The three settings panels also take `BottomButtonPanel` — the file's OK / Cancel row, which
   * is declared outside all four panels because it belongs to whichever one is up, exactly as
   * the backdrop is.
   */
  private optionsRoot(lib: FdfLibrary): FdfFrame {
    const panel = lib.resolveRoot(PANEL_FRAME[this.panel]);
    const backdrop = lib.resolveRoot("EscMenuBackdrop");
    if (!panel) throw new Error(`FDF: frame "${PANEL_FRAME[this.panel]}" not found`);

    const stretch = (f: FdfFrame): FdfFrame => ({
      ...f,
      props: [...f.props.filter((p) => p.key !== "Width" && p.key !== "Height"), prop("SetAllPoints")],
    });

    const children: FdfFrame[] = [];
    if (backdrop) children.push(stretch(backdrop));
    children.push(stretch(panel));
    if (this.panel !== "options") {
      const buttons = lib.resolveRoot("BottomButtonPanel");
      if (buttons) children.push(stretch(buttons));
    }

    return {
      type: "FRAME",
      name: "EscMenuOptionsPanel",
      inherits: null,
      withChildren: false,
      props: [prop("Width", num(OPTIONS_PANEL_SIZE.width)), prop("Height", num(OPTIONS_PANEL_SIZE.height))],
      children,
    };
  }

  /**
   * **One button, two captions.** `PauseButton` ships `Text "KEY_PAUSE_GAME"`, and
   * `GlobalStrings.fdf` ships its twin right beside it:
   *
   *     KEY_PAUSE_GAME    "Pause Ga|Cffffffffm|Re"   KEY_PAUSE_GAME_SHORTCUT   "m"
   *     KEY_RESUME_GAME   "Resume Ga|Cffffffffm|Re"  KEY_RESUME_GAME_SHORTCUT  "m"
   *
   * Same accelerator, same slot on the panel, no second button anywhere in the FDF — which is
   * how we know the engine swaps the CAPTION rather than showing another control. So this
   * rewrites the key on the way through `rootFrame`, leaving the string table to localize it
   * exactly as it localizes the other one.
   *
   * Keyed on the PLAYER's pause, not on "is the world stopped": the menu being open stops it
   * too in single-player, and a panel whose pause button read "Resume Game" the moment it
   * appeared would offer to undo something nobody did.
   */
  private captionPause(f: FdfFrame): FdfFrame {
    if (!this.actions.isPaused?.()) return f;
    if (f.name === "PauseButtonText") {
      return { ...f, props: f.props.map((p) => (p.key === "Text" ? prop("Text", { s: "KEY_RESUME_GAME", n: null, str: true }) : p)) };
    }
    if (!f.children.length) return f;
    return { ...f, children: f.children.map((c) => this.captionPause(c)) };
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
      // the game, and then closes the program (`onExitProgram` — in a browser, which cannot
      // close a tab it did not open, the nearest honest thing is leaving the match).
      QuitButton: () => this.actions.onEndGame(),
      ExitButton: () => this.go("confirmquit"),
      PreviousButton: () => this.go("main"),
      // --- ConfirmQuitPanel
      ConfirmQuitQuitButton: () => (this.actions.onExitProgram ?? this.actions.onEndGame)(),
      ConfirmQuitCancelButton: () => this.go("endgame"),
      // --- OptionsPanel, and the three settings panels behind it (ui/escOptions.ts). Every
      // one of these buttons steps the same stack the panels above it do.
      OptionsButton: () => this.go("options"),
      GameplayButton: () => this.go("optgameplay"),
      VideoButton: () => this.go("optvideo"),
      SoundButton: () => this.go("optsound"),
      OptionsPreviousButton: () => this.go("main"),
      // OK and Cancel go back ONE level, to the category list they were opened from — the same
      // step Previous Menu and Cancel take everywhere else on this stack.
      OptionsOKButton: () => { this.options.ok(); this.go("options"); },
      GamepadButton: () => gamepadButtonPressed(), // detect / unpair, issue #162 — ui/gamepad.ts
      OptionsCancelButton: () => { this.options.cancel(); this.go("options"); },
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
    // No save system, and no way to restart a match from inside it.
    for (const name of ["SaveGameButton", "LoadGameButton", "RestartButton"]) {
      screen.setEnabled(name, false);
    }
    const settings = OPTIONS_PANELS[this.panel];
    if (settings) this.options.bind(screen, settings, this.lib);
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
