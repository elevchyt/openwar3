// The F9 Quest Log, built from the game's own `UI\FrameDef\UI\QuestDialog.fdf`.
//
// The file declares the dialog (headers, the details box, the Done button) and TWO top-level
// templates the engine stamps at runtime: `QuestListItem` — one quest's row (icon plate +
// state-coloured button + title) — and `QuestItemListItem`, one requirement line in the
// details box. The four row arts are the quest's STATE, and the shipped templates say which
// is which by what they are made of:
//
//     QuestButtonBackdropTemplate          QuestDialogNormalBackground     in progress
//     QuestButtonPushedBackdropTemplate    QuestDialogCompletedBackground  completed
//     QuestButtonDisabledBackdropTemplate  EscMenuEditBoxBackground        undiscovered
//     QuestButtonDisabledPushedBackdrop…   QuestDialogFailedBackground     failed
//
// An UNDISCOVERED quest still shows — as a dead grey row reading "Quest Not Yet Discovered"
// (GlobalStrings' QUESTNOTDISCOVERED; its details pane says QUESTNEEDTODISCOVER). Those two
// strings existing is how we know the engine lists undiscovered quests rather than hiding
// them. A quest `QuestSetEnabled(false)` is genuinely gone, though — that native is how a
// script RETIRES an entry.
//
// Every caption is the game's: QUESTS, QUESTSMAIN, QUESTSOPTIONAL, QUESTACCEPT ("Done"),
// QUESTCOMPLETED / QUESTFAILED / QUESTNOTCOMPLETED for the row's status line.
//
// The rows are rebuilt whenever `rt.questsRevision` moves (the overlay polls, as the
// leaderboard/multiboard do) — a quest completing while the log is open repaints in place.

import type { QuestObj } from "../jass/runtime";
import { blpToCanvas } from "../render/blputil";
import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame, FdfProp } from "./fdf/parser";
import { cloneNamespaced, strProp, type FdfLibrary } from "./fdf/library";
import { UI_HEIGHT } from "./fdf/layout";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { fitLine } from "./fdf/widgets";
import { wc3ToHtml } from "./wc3Text";

const QUEST_FDF = "UI\\FrameDef\\UI\\QuestDialog.fdf";

// In the FDF's 0.8×0.6 world units. The row template's own size is the file's
// (QuestListItem: 0.08 wide — a placeholder the engine stretches to its column — by 0.033
// tall); these are the numbers the ENGINE owns: each column's rows stack under its header
// down the container, at the row's height plus a hair.
const ROW_PITCH = 0.036;
const ROW_WIDTH = 0.21; // the containers' own width (QuestMainContainer declares 0.21)
/** The row title's type size — see the FrameFont override in `rootFrame`. */
const ROW_TITLE_FONT = 0.0115;
/** `QuestItemListItemTitle`'s own `FrameFont "MasterFont", 0.013` — the size the file sets
 *  a requirement line in. Without it the injected lines inherit the page's 16px default. */
const REQ_FONT = 0.013;
/**
 * `QuestDisplayBackdrop`'s own `BackdropCornerSize` — the thickness of its ornate border.
 *
 * The file drops `QuestItemListContainer` only 0.014 below that backdrop's top edge, so at
 * the file's own numbers the first requirement line lands ON the border with ~1px to spare.
 * That works in the engine, whose text is shrink-wrapped and inset by its own metrics; ours
 * needs the clearance spelled out. Used to pad the injected list, never to move the frame.
 */
const DETAILS_BORDER = 0.0125;
/** The same backdrop's `BackdropBackgroundInsets` — the file's own "how far in does content
 *  sit" number, and the one `QuestDisplay` re-states as its `TextAreaInset`. Clearing the
 *  border alone leaves the list sitting ON the frame; this is the breathing room. */
const DETAILS_INSET = 0.005;

const s = (v: string): Arg => ({ s: v, n: null, str: true });
const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const prop = (key: string, ...args: Arg[]): FdfProp => ({ key, args });

/** What the overlay reads each time it paints. Kept as callbacks — the quests live in the
 *  map script's runtime, which outlives any one open dialog. */
export interface QuestModel {
  /** Every live quest, in creation order. Empty when no script ran (melee). */
  quests(): readonly QuestObj[];
  /** The map's display name — the dialog's white subtitle line under "Quests". */
  mapName(): string;
  /** The revision counter; the open dialog repaints when it moves. */
  revision(): number;
}

/** The four visual states a row can be in, keyed to the FDF's own backdrop templates. */
type RowState = "normal" | "completed" | "undiscovered" | "failed";

const ROW_BACKDROP: Record<RowState, string> = {
  normal: "QuestButtonBackdropTemplate",
  completed: "QuestButtonPushedBackdropTemplate",
  undiscovered: "QuestButtonDisabledBackdropTemplate",
  failed: "QuestButtonDisabledPushedBackdropTemplate",
};

function rowState(q: QuestObj): RowState {
  if (!q.discovered) return "undiscovered";
  if (q.failed) return "failed";
  if (q.completed) return "completed";
  return "normal";
}

export class QuestDialogOverlay {
  private screen: FdfScreen | null = null;
  private scrim: HTMLElement | null = null;
  private shown = false;
  private mounting = false;
  private builtRevision = -1;
  /** The selected quest's handle — the one whose details the right pane shows. */
  private selected = 0;
  private onEscape: (e: KeyboardEvent) => void;

  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private model: QuestModel,
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
    // Open on the first quest worth reading: the first discovered one, else the first.
    const qs = this.model.quests();
    if (!qs.some((q) => q.handleId === this.selected)) {
      this.selected = (qs.find((q) => q.discovered) ?? qs[0])?.handleId ?? 0;
    }
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

  /** Poll (called each frame): repaint an open log whose quests changed under it. */
  update(): void {
    if (!this.shown || this.mounting) return;
    if (this.model.revision() !== this.builtRevision) void this.build();
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
    this.builtRevision = -1;
  }

  private async build(): Promise<void> {
    if (this.mounting) return;
    this.mounting = true;
    this.builtRevision = this.model.revision();
    try {
      const handlers: Record<string, () => void> = { QuestAcceptButton: () => this.hide() };
      for (const q of this.enabled()) {
        handlers[`QuestListItemButton${q.handleId}`] = () => {
          this.selected = q.handleId;
          void this.build(); // reselect = repaint the details pane
        };
      }
      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: QUEST_FDF,
        rootFrame: "QuestDialog",
        overlayClass: "fdf-ingame fdf-dialog",
        skin: this.skin,
        centerRoot: true,
        buildRoot: (lib) => this.rootFrame(lib),
        handlers,
        textOverrides: this.texts(),
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
      console.warn("[quests] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
      // The revision may have moved while we were building — catch up rather than stall.
      if (this.shown && this.model.revision() !== this.builtRevision) void this.build();
    }
  }

  /** The quests the log lists — everything still enabled. Undiscovered ones stay. */
  private enabled(): QuestObj[] {
    return this.model.quests().filter((q) => q.enabled);
  }

  private selectedQuest(): QuestObj | undefined {
    return this.enabled().find((q) => q.handleId === this.selected);
  }

  /**
   * The dialog with one `QuestListItem` clone per quest, stacked under its column's header
   * — required quests under "Main Quests", optional under "Optional Quests" — and each
   * row's backdrop swapped for the template its STATE names (see ROW_BACKDROP).
   */
  private rootFrame(lib: FdfLibrary): FdfFrame {
    const dialog = lib.resolveRoot("QuestDialog");
    const rowTemplate = lib.resolveRoot("QuestListItem");
    if (!dialog) throw new Error('FDF: frame "QuestDialog" not found');

    const children = dialog.children.slice();
    if (rowTemplate) {
      const stack = { main: 0, opt: 0 };
      for (const q of this.enabled()) {
        const column = q.required ? "QuestMainContainer" : "QuestOptionalContainer";
        const at = q.required ? stack.main++ : stack.opt++;
        const row = cloneNamespaced(rowTemplate, String(q.handleId));
        row.props = [
          ...row.props.filter((p) => p.key !== "SetPoint" && p.key !== "Width"),
          prop("Width", num(ROW_WIDTH)),
          prop("SetPoint", word("TOPLEFT"), s(column), word("TOPLEFT"), num(0), num(-at * ROW_PITCH)),
        ];
        this.applyRowState(lib, row, q);
        // A row's two labels are ONE LINE each, whatever the string: give each its box (the
        // room the row actually has — the caption's declared 0.06 fits "Not Completed" only
        // in the game's own narrower face) and one line of height, and `fitLine` (onBuild)
        // shrinks the type to fit, ellipsis past the floor. Never wrap: a wrapped title
        // spills out of a 0.033-tall row into the neighbours, which is exactly what it did.
        const oneLine = (name: string, width: number, height: number): void => {
          const f = row.children.find((ch) => ch.name.startsWith(name));
          if (!f) return;
          f.props = [
            ...f.props.filter((p) => p.key !== "Width" && p.key !== "Height"),
            prop("Width", num(width)),
            prop("Height", num(height)),
          ];
        };
        oneLine("QuestListItemTitle", 0.16, 0.014);
        oneLine("QuestListItemComplete", 0.09, 0.011);
        // The FDF anchors the title `LEFT` — vertically centred — which assumes the engine's
        // shrink-wrapped text. At a full line of OUR height it collides with the caption
        // anchored to the row's bottom, so pin it to the TOP instead: title over status is
        // how the real log draws a row.
        //
        // The X stays the FILE'S 0.002, and that is the whole trick to the two lines lining
        // up: the title carries `FontJustificationOffset 0.01` and the caption carries none,
        // so 0.002 + 0.01 is exactly the caption's own 0.012 anchor. Nudging this to 0.004
        // (as it briefly was) reads as a 2px stagger, because it is one.
        const title = row.children.find((ch) => ch.name.startsWith("QuestListItemTitle"));
        const btn = row.children.find((ch) => ch.name.startsWith("QuestListItemButton"));
        if (title && btn) {
          title.props = [
            ...title.props.filter((p) => p.key !== "SetPoint" && p.key !== "FrameFont"),
            prop("SetPoint", word("TOPLEFT"), s(btn.name), word("TOPLEFT"), num(0.002), num(-0.0025)),
            // A notch below the 0.013 EscMenuButtonTextTemplate hands it. That size is meant
            // for a BUTTON's caption filling its whole face; here it shares a 0.033 row with
            // a status line, and our face sets wider than the game's besides.
            prop("FrameFont", s("MasterFont"), num(ROW_TITLE_FONT), s("")),
          ];
        }
        children.push(row);
      }
    }
    return { ...dialog, children };
  }

  /** Swap the row button's face for the state's own template, straight from the file. */
  private applyRowState(lib: FdfLibrary, row: FdfFrame, q: QuestObj): void {
    const button = row.children.find((c) => c.name.startsWith("QuestListItemButton"));
    const backdropName = button ? strProp(button, "ControlBackdrop") : undefined;
    const backdrop = button && backdropName ? button.children.find((c) => c.name === backdropName) : undefined;
    const state = lib.resolveRoot(ROW_BACKDROP[rowState(q)]);
    if (backdrop && state) backdrop.props = state.props.map((p) => ({ key: p.key, args: p.args.slice() }));
  }

  /** Every TEXT the log fills in — the engine's half of the file's "filled in by game code". */
  private texts(): Record<string, string> {
    // The two headline lines the FDF leaves to the engine: the gold QUESTS caption, and
    // under it the white line naming what these quests belong to — the map.
    const out: Record<string, string> = {
      QuestTitleValue: this.string("QUESTS"),
      QuestSubtitleValue: this.model.mapName(),
    };
    for (const q of this.enabled()) {
      out[`QuestListItemTitle${q.handleId}`] = q.discovered ? q.title : this.string("QUESTNOTDISCOVERED");
      out[`QuestListItemComplete${q.handleId}`] = !q.discovered ? ""
        : q.failed ? this.string("QUESTFAILED")
        : q.completed ? this.string("QUESTCOMPLETED")
        : this.string("QUESTNOTCOMPLETED");
    }
    const sel = this.selectedQuest();
    if (sel) out.QuestDetailsTitle = sel.discovered ? sel.title : this.string("QUESTNOTDISCOVERED");
    return out;
  }

  /** Fill what textOverrides can't: the icons, the requirement list and the description
   *  TEXTAREA. Runs on every build, resize included. */
  private onBuild(screen: FdfScreen): void {
    for (const q of this.enabled()) {
      this.paintIcon(screen, q);
      // One line each, whatever the string: shrink to fit, ellipsis past the floor.
      for (const part of ["QuestListItemTitle", "QuestListItemComplete"]) {
        const el = screen.frame(`${part}${q.handleId}`);
        if (el) fitLine(el);
      }
    }

    const sel = this.selectedQuest();
    const host = screen.frame("QuestItemListContainer");
    if (host) {
      host.textContent = "";
      // Clear only the padding a previous paint derived — NOT the whole style attribute,
      // which is where the renderer keeps this frame's position/size. Wiping it dropped the
      // container out of absolute layout, and it collapsed onto its own content.
      host.style.padding = "";
      if (sel?.discovered) this.paintRequirements(screen, host, sel);
    }
    screen.textArea("QuestDisplay")?.setLines(
      sel ? [sel.discovered ? sel.description : this.string("QUESTNEEDTODISCOVER")] : [],
    );
    // The selected row keeps its mouse-over glow on, the way the game marks the selection
    // (QuestListItemSelectedHighlight is the same art as the hover highlight).
    for (const q of this.enabled()) {
      screen.frame(`QuestListItemButton${q.handleId}`)
        ?.classList.toggle("quest-row-selected", q.handleId === this.selected);
    }
  }

  /** The row's icon — the real BLP the script named (QuestSetIconPath), inset in its plate. */
  private paintIcon(screen: FdfScreen, q: QuestObj): void {
    const plate = screen.frame(`QuestListItemIconContainer${q.handleId}`);
    if (!plate || !q.iconPath || !q.discovered) return;
    const bytes = this.vfs.rawBytes(q.iconPath);
    const canvas = bytes ? blpToCanvas(bytes) : null;
    if (!canvas) return;
    const img = document.createElement("img");
    img.className = "quest-row-icon";
    img.src = canvas.toDataURL();
    plate.appendChild(img);
  }

  /** The requirement lines: "- Slay the bandit lord", each greyed once done. The dash is
   *  ours-by-necessity — the shipped campaign maps put it in the item text itself, but the
   *  string a script sets is bare, and the log always lists items dashed. */
  private paintRequirements(screen: FdfScreen, host: HTMLElement, q: QuestObj): void {
    host.classList.add("quest-reqs");
    const box = host.getBoundingClientRect();

    // Keep the list off the backdrop's ornate border (DETAILS_BORDER), and start it at the
    // same X as the description below — that TEXTAREA's own `TextAreaInset` has already
    // solved "how far in does text sit in this box", so borrowing its answer is what makes
    // the two blocks read as one column instead of two.
    const backdrop = screen.frame("QuestDisplayBackdrop")?.getBoundingClientRect();
    const desc = screen.element.querySelector<HTMLElement>('[data-frame="QuestDisplay"] .fdf-textarea-lines');
    const scale = (screen.element.clientHeight || box.height) / UI_HEIGHT;
    const inset = DETAILS_INSET * scale;
    const padTop = backdrop
      ? Math.max(inset, backdrop.top + (DETAILS_BORDER + DETAILS_INSET) * scale - box.top)
      : inset;
    const padLeft = desc ? Math.max(0, desc.getBoundingClientRect().left - box.left) : 0;
    host.style.paddingTop = `${padTop}px`;
    host.style.paddingLeft = `${padLeft}px`;
    // The list has the room the file gave it and no more; a quest with more requirements
    // than fit scrolls rather than spilling over the description below it.
    host.style.paddingRight = `${padLeft}px`;

    // The file sizes these lines itself: `QuestItemListItem`'s own title declares
    // MasterFont 0.013 (see REQ_FONT). The line BOX is a touch taller than the type so
    // descenders clear — the template's 0.012 height would slice them in our face.
    const font = Math.max(9, REQ_FONT * scale);
    for (const it of q.items) {
      const el = document.createElement("div");
      el.className = it.completed ? "quest-req quest-req-done" : "quest-req";
      el.style.fontSize = `${font}px`;
      el.style.height = `${Math.round(font * 1.3)}px`;
      el.innerHTML = `-&nbsp;${wc3ToHtml(it.description)}`;
      host.appendChild(el);
    }
  }

  /** GlobalStrings lookup through the mounted screen's own library is not exposed, so the
   *  overlay keeps the handful it needs. Filled on first build from the FDF library. */
  private string(key: string): string {
    return QUEST_STRINGS[key] ?? key;
  }
}

/** The GlobalStrings the log speaks with, seeded with the shipped English as fallback —
 *  `primeQuestStrings` overwrites them from the player's own (possibly localized) table. */
const QUEST_STRINGS: Record<string, string> = {
  QUESTS: "Quests",
  QUESTCOMPLETED: "Completed",
  QUESTFAILED: "Failed",
  QUESTNOTCOMPLETED: "Not Completed",
  QUESTNOTDISCOVERED: "Quest Not Yet Discovered",
  QUESTNEEDTODISCOVER: "Need to discover quest",
};

/** Hand the overlay the real string table (the FdfLibrary the host already loaded). */
export function primeQuestStrings(strings: Map<string, string>): void {
  for (const key of Object.keys(QUEST_STRINGS)) {
    const v = strings.get(key);
    if (v !== undefined) QUEST_STRINGS[key] = v;
  }
}
