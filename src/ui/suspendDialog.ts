// "Waiting for players..." — the panel a match stops behind while a player's connection is down
// (docs/multiplayer.md "A player who drops").
//
// The chrome is the game's own `UI\FrameDef\UI\SuspendDialog.fdf`:
//
//     Frame "DIALOG" "SuspendDialog"      { Width 0.336, Height 0.432, … }
//         "SuspendTitleText"              Text "WAITING_FOR_PLAYERS"   ("Waiting for players...")
//         "SuspendDropPlayersButton"      Text "DROP_PLAYERS"          ("Drop players")
//         "SuspendTimerText"              the countdown, over the button
//     Frame "FRAME" "SuspendPlayerSlot"   { Width 0.219375, Height 0.02, … }  one per player waited for
//         "SuspendPlayerSlotColorBackdrop"   the player's colour swatch
//         "SuspendPlayerSlotPlayerNameLabel" the player's name
//
// Like ScriptDialog's button, the slot is a SEPARATE top-level template the engine stamps out
// once per row; we clone it per player waited for, renamed so the layout solver can tell the
// clones apart.
//
// One departure, the developer's: there is NO "Drop players" button. The countdown is short
// (`MapViewerScene.WAIT_FOR_DROPPED_S`) and lets the player go by itself when it reaches zero,
// so nobody has to decide anything — the button is taken out of the frame and the countdown
// moves down into the room it leaves.

import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { formatTimerValue } from "./timerDialog";

const SUSPEND_FDF = "UI\\FrameDef\\UI\\SuspendDialog.fdf";

// Where the rows start under the title and how far apart they sit — ours, measured off the
// reference screenshot (the first row a title's height below "Waiting for players...", rows
// stacked a little more than their own 0.02 apart).
const FIRST_ROW_Y = 0.062;
const ROW_STEP = 0.025;
// The countdown's foot, from the dialog's bottom edge. The FDF hangs it 0.00625 over a button
// whose foot is 0.03 up; with the button gone it sits in that band instead.
const TIMER_Y = 0.045;

const s = (v: string): Arg => ({ s: v, n: null, str: true });
const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });

/** One player the match is waiting for. `color` is a CSS colour, null while the swatch's
 *  texture has not loaded (the frame's own border still draws). */
export interface SuspendRow {
  name: string;
  color: string | null;
}

export class SuspendDialogOverlay {
  private screen: FdfScreen | null = null;
  private scrim: HTMLElement | null = null;
  private mounting = false;
  /** What we last built for: the rows and the title. */
  private builtFor = "";
  private timerEl: HTMLElement | null = null;

  /** `skin` is the war3skins.txt section the chrome is decorated from — the local player's
   *  race, as with every other in-game panel. */
  constructor(private container: HTMLElement, private vfs: DataSource, private skin: string) {}

  /**
   * Poll, every frame. `rows` null takes the panel down. `title` is a GlobalStrings key —
   * `WAITING_FOR_PLAYERS`, the FDF's own, unless the caller has a better one. `seconds` is
   * what the countdown reads.
   */
  update(rows: SuspendRow[] | null, seconds: number, title = "WAITING_FOR_PLAYERS"): void {
    if (!rows) {
      this.teardown();
      return;
    }
    const key = `${title}|${rows.map((r) => `${r.name}:${r.color ?? ""}`).join("|")}`;
    if (key !== this.builtFor && !this.mounting) {
      this.builtFor = key;
      void this.build(rows, title, seconds);
    }
    const text = formatTimerValue(seconds);
    if (this.timerEl && this.timerEl.textContent !== text) this.timerEl.textContent = text;
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.scrim?.remove();
    this.scrim = null;
    this.timerEl = null;
    this.builtFor = "";
  }

  private async build(rows: SuspendRow[], title: string, seconds: number): Promise<void> {
    this.mounting = true;
    try {
      const textOverrides: Record<string, string> = { SuspendTimerText: formatTimerValue(seconds) };
      rows.forEach((r, i) => (textOverrides[`SuspendPlayerSlotPlayerNameLabel${i}`] = r.name));
      // Modal, as `GameDialogOverlay` is and for the same reason: the world behind it is
      // stopped, and a click that reached it would give an order nobody can carry out. The
      // panel goes INSIDE its scrim — see that class on `modalOver`.
      if (!this.scrim) {
        this.scrim = document.createElement("div");
        this.scrim.className = "fdf-dialog-scrim";
        this.container.appendChild(this.scrim);
      }
      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.scrim,
        vfs: this.vfs,
        fdfPath: SUSPEND_FDF,
        rootFrame: "SuspendDialog",
        overlayClass: "fdf-ingame fdf-dialog",
        skin: this.skin,
        centerRoot: true,
        buildRoot: (lib) => this.rootFrame(lib, rows.length, title),
        textOverrides,
      });
      prev?.dispose();
      // Taken down while it was mounting: the panel is not wanted any more.
      if (!this.scrim) {
        screen.dispose();
        return;
      }
      this.screen = screen;
      this.timerEl = screen.element.querySelector<HTMLElement>('[data-frame="SuspendTimerText"]');
      // The swatch is a BACKDROP the FDF leaves empty: the engine paints the player's colour
      // into it. So do we — the game's own flat TeamColorNN swatch, read as a colour.
      rows.forEach((r, i) => {
        const el = screen.element.querySelector<HTMLElement>(`[data-frame="SuspendPlayerSlotColorBackdrop${i}"]`);
        if (el && r.color) el.style.background = r.color;
      });
    } catch (err) {
      console.warn("[suspend] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /** The game's SuspendDialog without its button, with one clone of SuspendPlayerSlot per row. */
  private rootFrame(lib: FdfLibrary, n: number, title: string): FdfFrame {
    const base = lib.resolveRoot("SuspendDialog");
    const slot = lib.resolveRoot("SuspendPlayerSlot");
    if (!base) throw new Error("FDF: frame \"SuspendDialog\" not found");
    const children = base.children
      .filter((c) => c.name !== "SuspendDropPlayersButton")
      .map((c) => {
        if (c.name === "SuspendTimerText") {
          return { ...c, props: [...c.props.filter((p) => p.key !== "SetPoint"), { key: "SetPoint", args: [word("BOTTOM"), s("SuspendDialog"), word("BOTTOM"), num(0), num(TIMER_Y)] }] };
        }
        if (c.name === "SuspendTitleText" && title !== "WAITING_FOR_PLAYERS") {
          return { ...c, props: [...c.props.filter((p) => p.key !== "Text"), { key: "Text", args: [s(title)] }] };
        }
        return c;
      });
    for (let i = 0; slot && i < n; i++) {
      const clone = renameFrame(slot, i);
      clone.props = [
        ...clone.props.filter((p) => p.key !== "SetPoint"),
        { key: "SetPoint", args: [word("TOP"), s("SuspendDialog"), word("TOP"), num(0), num(-(FIRST_ROW_Y + i * ROW_STEP))] },
      ];
      children.push(clone);
    }
    return { ...base, children };
  }

  dispose(): void {
    this.teardown();
  }
}

/** Clone a template under a per-index name. Every named frame in the subtree is suffixed, and
 *  so is every string argument that names one of them — the slot's children anchor to each
 *  other BY NAME (`SetPoint LEFT, "SuspendPlayerSlotColorBackdrop", RIGHT, …`), and a clone
 *  still pointing at the template's names would hang every row off the first. */
function renameFrame(f: FdfFrame, i: number): FdfFrame {
  const names = new Set<string>();
  const collect = (src: FdfFrame): void => {
    if (src.name) names.add(src.name);
    src.children.forEach(collect);
  };
  collect(f);
  const walk = (src: FdfFrame): FdfFrame => ({
    ...src,
    name: src.name ? `${src.name}${i}` : src.name,
    props: src.props.map((p) => ({ key: p.key, args: p.args.map((a) => (a.str && names.has(a.s) ? s(`${a.s}${i}`) : a)) })),
    children: src.children.map(walk),
  });
  return walk(f);
}
