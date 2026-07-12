// The script's dialogs — and with them, the melee VICTORY / DEFEAT screen
// (Phase 7.19 — issue #33; see docs/triggers.md).
//
// WC3 has no bespoke "Victory!" panel: it is a plain JASS `dialog`. MeleeVictoryDialogBJ
// (Scripts\Blizzard.j) sets the message to GetLocalizedString("GAMEOVER_VICTORY_MSG") —
// "Victory!" in UI\FrameDef\GlobalStrings.fdf — adds a "Continue Game" button and a quit
// button, and displays it. So rendering `dialog` faithfully IS rendering the end screen.
//
// The chrome is the game's own `UI\FrameDef\UI\ScriptDialog.fdf`:
//
//     Frame "DIALOG"        "ScriptDialog"       { Width 0.288f, Height 0.112f, … }
//     Frame "GLUETEXTBUTTON" "ScriptDialogButton" INHERITS WITHCHILDREN "EscMenuButtonTemplate"
//
// Note the button is a SEPARATE top-level template, not a child of the dialog — the engine
// stamps out one per DialogAddButton and stacks them inside. We do the same: clone the
// template per button (each clone renamed, so the layout solver and the click handlers can
// tell them apart), point it at the dialog, and grow the dialog to fit them.
//
// Two behaviours are the ENGINE's, not the script's, and blizzard.j quietly depends on it:
//   • any button click closes the dialog;
//   • a DialogAddQuitButton button ends the game — MeleeVictoryDialogBJ registers a trigger
//     on its quit button and never adds an action, because the quitting is the native's job.
// Both live here, because this is where the click is; the script's own dialog-button
// triggers then fire through Interpreter.fireDialogClick.

import type { DialogButtonObj, DialogObj } from "../jass/runtime";
import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame, FdfProp } from "./fdf/parser";
import { numProp, type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

const SCRIPT_DIALOG_FDF = "UI\\FrameDef\\UI\\ScriptDialog.fdf";

// The FDF's own numbers, in its 0.8×0.6 world units: ScriptDialog is 0.288 × 0.112 and
// EscMenuButtonTemplate (which ScriptDialogButton inherits) is 0.228 × 0.035. The dialog
// has to grow to hold the buttons the script added, so the height is ours to compute.
const BUTTON_H = 0.035;
const BUTTON_GAP = 0.008;
const MESSAGE_H = 0.062; // room for the message band above the button stack
const MESSAGE_LINE = 0.022; // the message's own line height (see the auto-size note below)
const SIDE_PAD = 0.02; // keep the message clear of the backdrop's ornate border
const BOTTOM_PAD = 0.014;

const s = (v: string): Arg => ({ s: v, n: null, str: true });
const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const prop = (key: string, ...args: Arg[]): FdfProp => ({ key, args });

/** A dialog on screen. `onClick` is raised with the clicked button. */
export interface GameDialogHandlers {
  onClick(button: DialogButtonObj): void;
}

export class GameDialogOverlay {
  private screen: FdfScreen | null = null;
  private scrim: HTMLElement | null = null;
  private mounting = false;
  private builtFor = ""; // handle:revision of the dialog currently on screen

  /** `skin` is the war3skins.txt section the dialog's chrome is decorated from — WC3
   *  gives the in-game panels the local player's RACE ("Orc", "NightElf", …). */
  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private handlers: GameDialogHandlers,
  ) {}

  /** Poll: put the dialog up (or take it down). Called each frame; a no-op unless the
   *  dialog, or its contents, actually changed. */
  update(dialog: DialogObj | null): void {
    if (!dialog) {
      this.teardown();
      return;
    }
    const key = `${dialog.handleId}:${dialog.revision}`;
    if (key === this.builtFor || this.mounting) return;
    this.builtFor = key;
    void this.build(dialog);
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.scrim?.remove();
    this.scrim = null;
    this.builtFor = "";
  }

  private async build(d: DialogObj): Promise<void> {
    this.mounting = true;
    try {
      const handlers: Record<string, () => void> = {};
      d.buttons.forEach((b, i) => {
        handlers[buttonName(i)] = () => this.handlers.onClick(b);
      });
      const textOverrides: Record<string, string> = { ScriptDialogText: d.message };
      d.buttons.forEach((b, i) => (textOverrides[textName(i)] = b.text));

      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: SCRIPT_DIALOG_FDF,
        rootFrame: "ScriptDialog",
        overlayClass: "fdf-ingame fdf-dialog",
        skin: this.skin,
        centerRoot: true,
        buildRoot: (lib) => this.rootFrame(lib, d),
        handlers,
        textOverrides,
      });
      prev?.dispose();
      this.screen = screen;
      // A dialog is modal: WC3 stops the world behind it taking the click that dismissed
      // it. The scrim is invisible — the game does not dim the map under a script dialog.
      if (!this.scrim) {
        this.scrim = document.createElement("div");
        this.scrim.className = "fdf-dialog-scrim";
        this.container.appendChild(this.scrim);
      }
      // The scrim must sit under the dialog itself, and both over everything else.
      this.container.appendChild(screen.element);
    } catch (err) {
      console.warn("[dialog] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /** Build the composite: the game's ScriptDialog frame, grown to fit N clones of its
   *  ScriptDialogButton template, each anchored below the message. */
  private rootFrame(lib: FdfLibrary, d: DialogObj): FdfFrame {
    const base = lib.resolveRoot("ScriptDialog");
    const button = lib.resolveRoot("ScriptDialogButton");
    if (!base) throw new Error("FDF: frame \"ScriptDialog\" not found");

    const n = button ? d.buttons.length : 0;
    const height = MESSAGE_H + n * (BUTTON_H + BUTTON_GAP) + BOTTOM_PAD;
    const width = numProp(base, "Width") ?? 0.288;

    // The message is a TEXT frame with no Width/Height. In WC3 a text frame AUTO-SIZES to
    // its content — which is why the FDF anchors it `SetPoint TOP, "ScriptDialog", TOP` and
    // bothers with no justification: a content-sized box hung from its own TOP point is
    // centred by construction. Our layout solver instead falls back to the PARENT's box for
    // an unsized frame, so the message became a dialog-sized box and its inherited
    // JUSTIFYLEFT/JUSTIFYMIDDLE dumped "Victory!" against the left edge, halfway down,
    // behind the buttons. Size it to one line across the dialog and centre it — the same
    // result the engine's auto-size gives.
    const children = base.children.map((c) =>
      c.name === "ScriptDialogText"
        ? {
            ...c,
            props: [
              ...c.props.filter((p) => p.key !== "Width" && p.key !== "Height" && p.key !== "FontJustificationH"),
              prop("Width", num(width - 2 * SIDE_PAD)),
              prop("Height", num(MESSAGE_LINE)),
              prop("FontJustificationH", word("JUSTIFYCENTER")),
            ],
          }
        : c,
    );
    for (let i = 0; i < n; i++) {
      const clone = renameFrame(button!, i);
      // Stack downward from under the message, centred on the dialog. FDF y is UP, so the
      // offsets are negative: the first button sits MESSAGE_H below the dialog's top.
      const dy = -(MESSAGE_H + i * (BUTTON_H + BUTTON_GAP));
      clone.props = [
        ...clone.props.filter((p) => p.key !== "SetPoint"),
        prop("SetPoint", word("TOP"), s("ScriptDialog"), word("TOP"), num(0), num(dy)),
      ];
      children.push(clone);
    }

    return {
      ...base,
      props: [...base.props.filter((p) => p.key !== "Height"), prop("Height", num(height))],
      children,
    };
  }

  dispose(): void {
    this.teardown();
  }
}

const buttonName = (i: number): string => `ScriptDialogButton${i}`;
const textName = (i: number): string => `ScriptDialogButtonText${i}`;

/** Clone a button template under a per-index name. Every named frame in the subtree is
 *  suffixed — the layout solver indexes frames by name across the WHOLE screen, so two
 *  buttons sharing a child name ("ScriptDialogButtonText") would collide and the second
 *  would silently steal the first's label. The props that REFER to those children by name
 *  (ButtonText, ControlBackdrop, ControlPushedBackdrop, …) are rewritten to match. */
function renameFrame(f: FdfFrame, i: number): FdfFrame {
  const REFS = new Set([
    "ButtonText", "ControlBackdrop", "ControlPushedBackdrop", "ControlDisabledBackdrop",
    "ControlDisabledPushedBackdrop", "ControlMouseOverHighlight", "ControlFocusHighlight",
  ]);
  const rename = (name: string): string => (name ? `${name}${i}` : name);
  const walk = (src: FdfFrame): FdfFrame => ({
    ...src,
    name: rename(src.name),
    props: src.props.map((p) =>
      REFS.has(p.key) && p.args[0]?.str ? { key: p.key, args: [s(rename(p.args[0].s))] } : { key: p.key, args: p.args.slice() },
    ),
    children: src.children.map(walk),
  });
  return walk(f);
}
