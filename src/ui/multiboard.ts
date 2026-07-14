// The script's multiboard (7.22 — issue #33; see docs/triggers.md).
//
// The grid scoreboard: a title, then rows × columns of string cells, each optionally with
// an icon. The natives live in src/jass/natives/multiboard.ts; this is the panel.
//
// The chrome is the GAME'S OWN — `UI\FrameDef\UI\MultiBoard.fdf`, mounted the same way the
// leaderboard (7.19) and timer dialogs (7.21) are, and shaped the same way: the cells are
// NOT in the file, so the engine generates them, which is why `MultiboardListContainer` is
// declared empty:
//
//     Frame "FRAME" "Multiboard" {  Height 0.024,  Width 0.024,
//         Frame "GLUETEXTBUTTON" "MultiboardMinimizeButton" { … }
//         Frame "BACKDROP"       "MultiboardTitleBackdrop"  { Width 0.2f, … }
//         Frame "TEXT"           "MultiboardTitle"          { … }
//         Frame "BACKDROP"       "MultiboardBackdrop"       { … }
//         Frame "FRAME"          "MultiboardListContainer"  { }        ← we fill this
//     }
//
// Note the root's 0.024×0.024: that is the MINIMIZE BUTTON's size, not the board's — the
// title backdrop hangs off the button's left edge and the body off its bottom, so the frame
// grows from that one square. So, exactly as with the leaderboard, the size and the position
// are the engine's to decide and not the file's: we set a width from the column count, a
// height from the row count, and hang it top-right below whatever the leaderboard is using.

import type { MultiboardObj } from "../jass/runtime";
import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame } from "./fdf/parser";
import { type FdfLibrary } from "./fdf/library";
import { UI_HEIGHT } from "./fdf/layout";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { wc3ToHtml } from "./wc3Text";
import { blpToCanvas } from "../render/blputil";

const MULTIBOARD_FDF = "UI\\FrameDef\\UI\\MultiBoard.fdf";

// FDF 0.8×0.6 world units. The title band and the button square are the file's; the row
// pitch and the default column width are the engine's.
const FONT = 0.010; // a cell's text — a notch under MultiboardTitle's 0.011f, as in WC3
const ROW_H = 0.0135; // one row's pitch — sized off MultiboardTitle's 0.011f font
const TITLE_H = 0.0235; // the title band (the FDF's 0.024 minimize button, near enough)
const COL_W = 0.055; // a column's default width when the script sets none
const PAD = 0.008; // the body backdrop's inset below the last row
const MARGIN_X = 0.006;
const MARGIN_Y = 0.052; // clears the resource bar — the same top inset the leaderboard uses

const s = (v: string): Arg => ({ s: v, n: null, str: true });
const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });

export class MultiboardOverlay {
  private screen: FdfScreen | null = null;
  private mounting = false;
  private builtFor = "";
  private lastHeight = 0;
  private lastTop = 0;

  constructor(private container: HTMLElement, private vfs: DataSource, private skin: string) {}

  /** How much of the top-right corner this board occupies (0 when it isn't up), so the
   *  timer-dialog stack can hang below it — the same contract the leaderboard has. */
  occupiedHeight(): number {
    return this.screen ? this.lastTop + this.lastHeight - MARGIN_Y : 0;
  }

  /** Poll each frame. `topOffset` is how far down the panel hangs (below the leaderboard).
   *  A minimized board still shows its title bar, as in WC3 — that's what the minimize
   *  button is for — so `minimized` shrinks it rather than taking it down. */
  update(boards: readonly MultiboardObj[], suppressed: boolean, topOffset: number): void {
    // WC3 shows one multiboard at a time; a script that displays a second replaces the
    // first on screen. So take the last DISPLAYED one.
    const mb = suppressed ? null : [...boards].reverse().find((b) => b.displayed) ?? null;
    if (!mb) {
      this.teardown();
      return;
    }
    const key = `${mb.handleId}:${mb.revision}:${topOffset.toFixed(4)}`;
    if (key === this.builtFor || this.mounting) return;
    this.builtFor = key;
    void this.build(mb, topOffset);
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.builtFor = "";
    this.lastHeight = 0;
  }

  private async build(mb: MultiboardObj, topOffset: number): Promise<void> {
    this.mounting = true;
    try {
      const prev = this.screen;
      this.screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: MULTIBOARD_FDF,
        rootFrame: "Multiboard",
        overlayClass: "fdf-ingame",
        skin: this.skin,
        buildRoot: (lib) => this.rootFrame(lib, mb, topOffset),
        textOverrides: { MultiboardTitle: mb.title },
        // The cells aren't in the FDF tree, so every rebuild — a RESIZE is a rebuild — drops
        // them. Repaint from the renderer's own post-build hook; a `resize` listener of ours
        // would run BEFORE it and paint into DOM that is about to be thrown away (the same bug
        // the leaderboard had: the board goes blank until the next revision bump).
        onBuild: (screen) => this.paintCells(screen, mb),
      });
      prev?.dispose(); // swap only once the new one is up, so the board never blinks
    } catch (err) {
      console.warn("[multiboard] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /** Wrap the game's `Multiboard` frame in a full-screen parent, pin it top-right, and give
   *  it the size its grid asks for. The FDF's root is the minimize-button square, so both
   *  dimensions are ours to set. */
  private rootFrame(lib: FdfLibrary, mb: MultiboardObj, topOffset: number): FdfFrame {
    const board = lib.resolveRoot("Multiboard");
    if (!board) throw new Error('FDF: frame "Multiboard" not found');

    // Width: honour the per-column widths the script set (MultiboardSetItemWidth is a
    // FRACTION of the board), falling back to a sane default for any column that has none.
    let width = 0;
    for (let c = 0; c < mb.columns; c++) width += this.columnWidth(mb, c) || COL_W;
    width = Math.max(0.08, width);
    // A minimized board keeps its title bar and drops the body — that is what minimizing IS.
    const bodyH = mb.minimized ? 0 : mb.rows * ROW_H + PAD;
    const height = TITLE_H + bodyH;
    this.lastHeight = height;
    this.lastTop = MARGIN_Y + topOffset;

    const props = board.props.filter((p) => p.key !== "Height" && p.key !== "Width" && p.key !== "SetPoint");
    // The root frame IS the minimize button's square (the title hangs off its left, the body
    // off its bottom) — keep it square and let the children do the growing.
    props.push({ key: "Width", args: [num(0.024)] });
    props.push({ key: "Height", args: [num(0.024)] });
    props.push({ key: "SetPoint", args: [word("TOPRIGHT"), s("MultiboardRoot"), word("TOPRIGHT"), num(-MARGIN_X), num(-this.lastTop)] });

    const children = board.children.map((c) => {
      // The title backdrop carries `SetAllPoints` — AFTER its two SetPoints, and the parent
      // it would fill is the 0.024 minimize-button square. Left in, it collapses the title
      // band to that square and the title wraps inside a 24-thousandth-wide box. Strip it and
      // size the band to the grid instead: the two SetPoints (TOP/BOTTOMRIGHT → the button's
      // LEFT edge) already say where it hangs, they just never said how wide.
      if (c.name === "MultiboardTitleBackdrop") {
        return {
          ...c,
          props: [
            ...c.props.filter((p) => p.key !== "Width" && p.key !== "Height" && p.key !== "SetAllPoints"),
            { key: "Width", args: [num(width)] },
            { key: "Height", args: [num(TITLE_H)] },
          ],
        };
      }
      // The title TEXT is anchored by two opposing corners and declares no size of its own —
      // the same unsized-TEXT-frame trap the timer dialog hit in 7.21 (our layout solver
      // derives no width from opposing anchors, so the frame collapses to 0×0 and never
      // draws). Give it the band's own box.
      if (c.name === "MultiboardTitle") {
        return {
          ...c,
          props: [
            ...c.props.filter((p) => p.key !== "Width" && p.key !== "Height"),
            { key: "Width", args: [num(width)] },
            { key: "Height", args: [num(TITLE_H)] },
          ],
        };
      }
      // The body backdrop hangs off the title band's BOTTOMLEFT and the button's BOTTOMRIGHT
      // — again two anchors and no size. Give it one, or the cell container inside it is 0
      // tall and no cell draws.
      if (c.name === "MultiboardBackdrop") {
        return {
          ...c,
          props: [
            ...c.props.filter((p) => p.key !== "Height" && p.key !== "Width"),
            { key: "Height", args: [num(Math.max(0.001, bodyH))] },
            { key: "Width", args: [num(width + 0.024)] },
          ],
        };
      }
      return c;
    });

    return {
      type: "FRAME",
      name: "MultiboardRoot",
      inherits: null,
      withChildren: false,
      props: [],
      children: [{ ...board, props, children, name: "Multiboard" }],
    };
  }

  /** The width the script gave column `c` (the widest cell in it wins, since WC3 sets the
   *  width per cell but lays the board out per column). 0 = the script set none. */
  private columnWidth(mb: MultiboardObj, c: number): number {
    let w = 0;
    for (let r = 0; r < mb.rows; r++) w = Math.max(w, mb.items[r * mb.columns + c]?.width ?? 0);
    return w;
  }

  /** Inject the cells into the FDF's own (empty) MultiboardListContainer. */
  private paintCells(screen: FdfScreen, mb: MultiboardObj): void {
    const host = screen.element.querySelector<HTMLElement>('[data-frame="MultiboardListContainer"]');
    if (!host) return;
    host.textContent = ""; // idempotent: a repaint replaces the cells, it doesn't stack them
    if (mb.minimized) return;
    const box = host.getBoundingClientRect();
    if (box.height <= 0 || box.width <= 0) return;
    // Rows sit at the FIXED ROW_H pitch and the cell font is the FDF's — neither is a fraction
    // of the box. Dividing the container between the rows instead spread them over the padding
    // the board was sized with, and dropped the last row onto the backdrop's border.
    const scale = (screen.element.clientHeight || box.height) / UI_HEIGHT;
    const rowPx = ROW_H * scale;
    const fontPx = Math.max(8, Math.min(FONT * scale, rowPx));

    // Column x-offsets, from the same per-column widths the board was sized with.
    const widths: number[] = [];
    let total = 0;
    for (let c = 0; c < mb.columns; c++) {
      const w = this.columnWidth(mb, c) || COL_W;
      widths.push(w);
      total += w;
    }

    for (let r = 0; r < mb.rows; r++) {
      let xFrac = 0;
      for (let c = 0; c < mb.columns; c++) {
        const item = mb.items[r * mb.columns + c];
        const wFrac = widths[c] / (total || 1);
        const cell = document.createElement("div");
        cell.className = "multiboard-cell";
        cell.style.top = `${r * rowPx}px`;
        cell.style.left = `${xFrac * box.width}px`;
        cell.style.width = `${wFrac * box.width}px`;
        cell.style.height = `${rowPx}px`;
        cell.style.fontSize = `${fontPx}px`;
        xFrac += wFrac;
        if (!item) continue;

        if (item.showIcon && item.icon) {
          const icon = this.icon(item.icon);
          if (icon) {
            const img = document.createElement("span");
            img.className = "multiboard-icon";
            img.style.width = img.style.height = `${Math.round(fontPx * 0.95)}px`;
            img.style.backgroundImage = `url(${icon})`;
            cell.appendChild(img);
          }
        }
        if (item.showValue && item.value) {
          const text = document.createElement("span");
          text.className = "multiboard-value";
          text.innerHTML = wc3ToHtml(item.value);
          text.style.color = css(item.valueColor);
          cell.appendChild(text);
        }
        host.appendChild(cell);
      }
    }
  }

  /** A cell's icon, decoded from the install. WC3 scripts name .blp AND .tga paths for the
   *  same texture (the editor emits whichever the author typed) — the resolver only has the
   *  .blp, so retry with the extension swapped rather than dropping the icon. */
  private icon(path: string): string | null {
    const cached = iconCache.get(path);
    if (cached !== undefined) return cached;
    let out: string | null = null;
    const tries = [path, path.replace(/\.tga$/i, ".blp"), path.replace(/\.blp$/i, ".tga")];
    for (const p of tries) {
      const bytes = this.vfs.rawBytes(p);
      if (!bytes) continue;
      const canvas = blpToCanvas(bytes);
      if (canvas) {
        out = canvas.toDataURL();
        break;
      }
    }
    iconCache.set(path, out);
    return out;
  }

  dispose(): void {
    this.teardown();
  }
}

/** Icon path → data URL. Decoded once; a board repaints every time its revision changes. */
const iconCache = new Map<string, string | null>();

/** 0xAARRGGBB → CSS rgba. */
function css(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255;
  return `rgba(${(argb >>> 16) & 0xff}, ${(argb >>> 8) & 0xff}, ${argb & 0xff}, ${a})`;
}
