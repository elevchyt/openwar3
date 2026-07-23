// The F12 Messaging dialog, built from the game's own `UI\FrameDef\UI\ChatDialog.fdf`.
//
// What it is, in WC3: not a place you type chat — that is the entry line Enter opens — but the
// place you choose WHO the entry line talks to, and read back what has been said. The file
// says so in its own frames:
//
//     Frame "GLUECHECKBOX" "ChatPlayerRadioButton"    …  Text "COLON_SEND_TO_PLAYER"
//     Frame "GLUECHECKBOX" "ChatAlliesRadioButton"    …  Text "SEND_TO_ALLIES"
//     Frame "GLUECHECKBOX" "ChatObserversRadioButton" …  Text "SEND_TO_OBSERVERS"
//     Frame "GLUECHECKBOX" "ChatEveryoneRadioButton"  …  Text "SEND_TO_EVERYONE"
//     Frame "POPUPMENU"    "ChatPlayerMenu"           …  (which player, for the first one)
//     Frame "TEXTAREA"     "ChatHistoryDisplay"       …  TextAreaMaxLines 128
//
// The four are GLUECHECKBOXes, not a radio widget — WC3 has no such frame type, and gives them
// no grouping either (see ui/fdf/widgets.ts). Only their ART is round. So the mutual exclusion
// is the SCREEN's, which is what `arm` below is: exactly one box ticked, and the rest cleared.
//
// `CHAT_INFO_TEXT` at the bottom is the game's own line about /squelch. It is shown as it
// ships even though we have no squelch: it is what the panel says, and quietly editing the
// game's copy to match our feature set would be a worse lie than an unimplemented command.

import type { ChatTarget } from "../game/chat";
import type { DataSource } from "../vfs/types";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

const CHAT_FDF = "UI\\FrameDef\\UI\\ChatDialog.fdf";

/** The four radio buttons, and the scope each arms. */
const RADIOS: Array<{ frame: string; scope: ChatTarget["scope"] }> = [
  { frame: "ChatPlayerRadioButton", scope: "private" },
  { frame: "ChatAlliesRadioButton", scope: "allies" },
  { frame: "ChatObserversRadioButton", scope: "observers" },
  { frame: "ChatEveryoneRadioButton", scope: "all" },
];

export interface ChatDialogModel {
  /** Every line this player has heard, already rendered as WC3 markup. */
  history(): readonly string[];
  /** The other players, for the Send to Player dropdown. */
  peers(): Array<{ id: number; name: string }>;
  /** The target the entry line currently talks to. */
  target(): ChatTarget;
  /** Point the entry line somewhere else — what OK commits. */
  setTarget(target: ChatTarget): void;
  /** Are there observers to send to? (No observer slots yet, so the option greys out.) */
  hasObservers(): boolean;
}

export class ChatDialogOverlay {
  private screen: FdfScreen | null = null;
  private scrim: HTMLElement | null = null;
  private shown = false;
  private mounting = false;
  /** The pending choice — committed by OK, dropped by Escape, as the panel's one button implies. */
  private pending: ChatTarget = { scope: "all" };
  private onEscape: (e: KeyboardEvent) => void;

  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private model: ChatDialogModel,
  ) {
    this.onEscape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !this.shown) return;
      e.preventDefault();
      e.stopPropagation();
      this.hide();
    };
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.pending = { ...this.model.target() };
    window.addEventListener("keydown", this.onEscape, true);
    void this.build();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    window.removeEventListener("keydown", this.onEscape, true);
    this.teardown();
  }

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

  private async build(): Promise<void> {
    if (this.mounting) return;
    this.mounting = true;
    try {
      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: CHAT_FDF,
        rootFrame: "ChatDialog",
        overlayClass: "fdf-ingame fdf-dialog",
        skin: this.skin,
        centerRoot: true,
        handlers: {
          ChatAcceptButton: () => this.accept(),
        },
        onBuild: (built) => this.onBuild(built),
      });
      prev?.dispose();
      this.screen = screen;
      if (!this.scrim) {
        this.scrim = document.createElement("div");
        this.scrim.className = "fdf-dialog-scrim";
        this.container.appendChild(this.scrim);
      }
      this.container.appendChild(screen.element);
    } catch (err) {
      console.warn("[chat] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /** Fill the panel. Runs on every build, resize included, so the pending choice survives one. */
  private onBuild(screen: FdfScreen): void {
    // The history, newest last and scrolled to it — a log you have to scroll to read the end
    // of is a log you will not read.
    const history = screen.textArea("ChatHistoryDisplay");
    history?.setLines([...this.model.history()]);
    history?.scrollToBottom();

    const peers = this.model.peers();
    const menu = screen.popup("ChatPlayerMenu");
    menu?.setOptions(peers.map((p) => ({ value: String(p.id), label: p.name })));
    if (menu && this.pending.scope === "private" && this.pending.player !== undefined) {
      menu.value = String(this.pending.player);
    }
    if (menu) {
      menu.onChange = (value) => {
        // Picking a name is also choosing to address them — it is the only reason to touch
        // this menu, and making the player then also click the radio would be ceremony.
        this.pending = { scope: "private", player: Number(value) };
        this.arm(screen);
      };
    }
    // Nobody to whisper to, and no observers to shout at: those two rows are dead.
    screen.setEnabled("ChatPlayerRadioButton", peers.length > 0);
    screen.setEnabled("ChatPlayerMenu", peers.length > 0);
    screen.setEnabled("ChatObserversRadioButton", this.model.hasObservers());

    for (const radio of RADIOS) {
      const box = screen.checkBox(radio.frame);
      if (!box) continue;
      box.onChange = () => {
        this.pending = radio.scope === "private"
          ? { scope: "private", player: Number(menu?.value ?? peers[0]?.id ?? 0) }
          : { scope: radio.scope };
        this.arm(screen);
      };
    }
    this.arm(screen);
  }

  /** Exactly one radio ticked — the grouping the engine supplies and the FDF does not. */
  private arm(screen: FdfScreen): void {
    for (const radio of RADIOS) {
      const box = screen.checkBox(radio.frame);
      if (box) box.checked = radio.scope === this.pending.scope;
    }
  }

  /** OK: point the entry line at the chosen audience and close. */
  private accept(): void {
    this.model.setTarget(this.pending);
    this.hide();
  }
}
