// The script's leaderboard (Phase 7.19 — issue #33; see docs/triggers.md).
//
// What every TD, AoS and minigame puts on screen: a titled board with a row per player
// ("Kills 14", "Lives 20"). The natives live in src/jass/natives/leaderboard.ts; this is
// the panel.
//
// The chrome is the GAME'S OWN — `UI\FrameDef\UI\LeaderBoard.fdf` declares the frame the
// engine builds (a tiled EscMenuEditBox backdrop, a centred MasterFont title, and an empty
// `LeaderboardListContainer` to hold the rows):
//
//     Frame "FRAME" "Leaderboard" {  Width 0.17f,  Height 0.2f,
//         Frame "BACKDROP" "LeaderboardBackdrop"      { … }
//         Frame "TEXT"     "LeaderboardTitle"         { … }
//         Frame "FRAME"    "LeaderboardListContainer" { … } }
//
// The ROWS aren't in the file — the engine generates them, which is why the container is
// empty — so we mount the FDF frame and inject rows into that container. Two things the
// FDF can't tell us and the game decides at runtime:
//   • WHERE it sits. The frame carries no SetPoint (CGameUI places it), so we anchor it
//     top-right under the resource bar, where WC3 puts it.
//   • HOW TALL it is. The board grows with its rows rather than sitting at the FDF's 0.2f.
//     (LeaderboardResizeBJ's own rule is "size = item count, minus one if there is no
//     label" — advisory, so we size to whichever of items/rows is larger.)
//
// A row's colour is the player's colour, sampled from the game's own team-colour texture
// (ReplaceableTextures\TeamColor\TeamColorNN.blp is a flat swatch) — no hard-coded palette.
// That colour is the row LABEL's, as in WC3: a board a script never colours still shows each
// player's name in their own colour. An explicit LeaderboardSetItemLabelColor still wins.

import { teamColorCss } from "../render/teamColor";
import type { LeaderboardObj } from "../jass/runtime";
import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame } from "./fdf/parser";
import { firstProp, numProp, type FdfLibrary } from "./fdf/library";
import { UI_HEIGHT } from "./fdf/layout";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { wc3ToHtml } from "./wc3Text";

const LEADERBOARD_FDF = "UI\\FrameDef\\UI\\LeaderBoard.fdf";

// All in the FDF's 0.8×0.6 world units. The title/backdrop geometry is the file's; these
// are the numbers the engine owns (row pitch, title band, and where the board hangs).
//
// The FONT is the file's, though, and it is the one number that must not be derived: a row's
// text is drawn at the same 0.011 `MasterFont` size the FDF gives LeaderboardTitle, whatever
// the board's size. Sizing it as a fraction of the row pitch instead — which is what this did
// — makes a one-row board's text twice the size of an eight-row board's, and neither is WC3's.
const FONT = 0.011; // LeaderboardTitle's "MasterFont", 0.011 — rows are set at the same size
const ROW_H = 0.0142; // one row's pitch: the 0.011 line, near enough its natural leading
const TITLE_LINE = 0.015; // the title's own line box
const TITLE_H = 0.032; // the title band: the FDF's 0.015 top inset + the line + its 0.002 gap
const ROW_INSET = 0.012; // a row's own left/right inset inside the backdrop
const PAD = 0.014; // backdrop inset below the last row (its border is 0.0125 of corner)
const MARGIN_X = 0.006; // gap from the right edge of the screen
const MARGIN_Y = 0.052; // gap from the top — clears the resource bar, as in WC3

const s = (v: string): Arg => ({ s: v, n: null, str: true });
const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });

export class LeaderboardOverlay {
  private screen: FdfScreen | null = null;
  private mounting = false;
  /** The (handle, revision, row-count) we last built for — rebuild only when it changes. */
  private builtFor = "";
  private lastHeight = 0;

  /** How much of the top-right corner the board is using, in FDF 0.8×0.6 units (0 when it
   *  isn't up). The timer-dialog stack hangs below it, so the two never overlap — as in WC3.
   *  MARGIN_Y is the shared top inset, so this is the board's own height. */
  occupiedHeight(): number {
    return this.screen ? this.lastHeight : 0;
  }

  /** `skin` is the war3skins.txt section the panel's chrome is decorated from — WC3 gives
   *  the in-game panels the local player's RACE ("Orc", "NightElf", …). */
  constructor(private container: HTMLElement, private vfs: DataSource, private skin: string) {}

  /** Poll: show/refresh the local player's board, or take it down. Called every frame —
   *  it does nothing at all unless the board actually changed (revision). */
  update(lb: LeaderboardObj | null): void {
    if (!lb) {
      this.teardown();
      return;
    }
    const key = `${lb.handleId}:${lb.revision}`;
    if (key === this.builtFor || this.mounting) return;
    this.builtFor = key;
    void this.build(lb);
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.builtFor = "";
  }

  private async build(lb: LeaderboardObj): Promise<void> {
    // A rebuild replaces the whole panel: it is a handful of divs, and the alternative
    // (diffing rows against the FDF-built DOM) buys nothing at this size.
    this.mounting = true;
    try {
      const prev = this.screen;
      this.screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: LEADERBOARD_FDF,
        rootFrame: "Leaderboard",
        overlayClass: "fdf-ingame",
        skin: this.skin,
        buildRoot: (lib) => this.rootFrame(lib, lb),
        textOverrides: { LeaderboardTitle: lb.showLabel ? lb.label : "" },
        // The rows aren't part of the FDF tree, so every rebuild of the panel — and a RESIZE
        // is a rebuild — throws them away. This is the hook that puts them back, and it is the
        // only correct place for it: a `resize` listener of our own could only ever run before
        // the screen's (ours is registered first), i.e. it would paint rows into the DOM that
        // is about to be discarded, and the board would then sit there rowless until the next
        // kill bumped its revision. That was the "the label vanishes when I hit F11" bug.
        onBuild: (screen) => this.paintRows(screen, lb),
      });
      prev?.dispose(); // swap only once the new one is up, so the board never blinks
    } catch (err) {
      console.warn("[leaderboard] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /** Wrap the game's `Leaderboard` frame in a full-screen parent and pin it top-right, at
   *  the height its row count asks for. The FDF's own Width is kept. */
  private rootFrame(lib: FdfLibrary, lb: LeaderboardObj): FdfFrame {
    const board = lib.resolveRoot("Leaderboard");
    if (!board) throw new Error("FDF: frame \"Leaderboard\" not found");
    // WC3 sizes the board by ITEM COUNT, not by the rows the script asked room for —
    // LeaderboardSetSizeByItemCount is advisory and a board with more rows than items
    // would draw a stretch of empty backdrop. Honour whichever is larger, so a script
    // that reserved space gets it.
    const rows = Math.max(lb.items.length, lb.rows, 1);
    const height = (lb.showLabel && lb.label ? TITLE_H : PAD) + rows * ROW_H + PAD;
    this.lastHeight = height;

    const props = board.props.filter((p) => p.key !== "Height" && p.key !== "SetPoint");
    props.push({ key: "Height", args: [num(height)] });
    props.push({ key: "SetPoint", args: [word("TOPRIGHT"), s("LeaderboardRoot"), word("TOPRIGHT"), num(-MARGIN_X), num(-MARGIN_Y)] });

    // The title is a TEXT frame with neither Width nor Height of its own. In WC3 a text
    // frame is one line tall and sized to its box; our layout solver falls back to the
    // PARENT's size for an unsized frame, which (a) made the title swallow the whole board
    // and squeeze the row list — it hangs off the title's BOTTOMLEFT — to zero height, and
    // (b) left it a full board wide while inset 0.02 from the left, so its JUSTIFYCENTER
    // text centred 0.02 to the right of the board. Give it both dimensions: one line tall,
    // and inset symmetrically so "centred" means centred.
    const width = numProp(board, "Width") ?? 0.17;
    const inset = firstProp(board.children.find((c) => c.name === "LeaderboardTitle") ?? board, "SetPoint")?.args[3]?.n ?? 0.02;
    const children = board.children.map((c) =>
      c.name === "LeaderboardTitle"
        ? {
            ...c,
            props: [
              ...c.props.filter((p) => p.key !== "Height" && p.key !== "Width"),
              { key: "Height", args: [num(TITLE_LINE)] },
              { key: "Width", args: [num(Math.max(0.02, width - 2 * inset))] },
            ],
          }
        : c,
    );

    return {
      type: "FRAME",
      name: "LeaderboardRoot",
      inherits: null,
      withChildren: false,
      props: [],
      children: [{ ...board, props, children, name: "Leaderboard" }],
    };
  }

  /** Inject the rows into the FDF's own (empty) LeaderboardListContainer. */
  private paintRows(screen: FdfScreen, lb: LeaderboardObj): void {
    const host = screen.element.querySelector<HTMLElement>('[data-frame="LeaderboardListContainer"]');
    if (!host) return;
    host.textContent = ""; // idempotent: a repaint replaces the rows, it doesn't stack them
    const box = host.getBoundingClientRect();
    if (box.height <= 0) return;
    // The same world→pixel factor the FDF renderer lays the panel out with, so the row text is
    // the FDF's 0.011 and not a fraction of the box it happens to sit in.
    const scale = (screen.element.clientHeight || box.height) / UI_HEIGHT;
    // Rows sit at the FIXED ROW_H pitch, they don't divide the container between them: the
    // container is as tall as the backdrop the board was sized to, so sharing it out would
    // eat the bottom padding and push the last row onto the border.
    const rowPx = ROW_H * scale;
    const fontPx = Math.max(8, Math.min(FONT * scale, rowPx));
    const inset = ROW_INSET * scale;

    lb.items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "leaderboard-row";
      row.style.top = `${i * rowPx}px`;
      row.style.left = `${inset}px`;
      row.style.right = `${inset}px`;
      row.style.height = `${rowPx}px`;
      row.style.fontSize = `${fontPx}px`;

      if (lb.showNames && it.showLabel) {
        const label = document.createElement("span");
        label.className = "leaderboard-label";
        label.innerHTML = wc3ToHtml(it.label);
        // No explicit colour → the player's own, as WC3 draws it. (LeaderboardSetItemLabelColor
        // leaves `labelColor` non-null, and that wins; so does the board-wide one.)
        label.style.color = it.labelColor !== null ? css(it.labelColor)
          : this.teamColor(it.player) ?? css(lb.labelColor);
        row.appendChild(label);
      }
      if (lb.showValues && it.showValue) {
        const value = document.createElement("span");
        value.className = "leaderboard-value";
        value.textContent = String(it.value);
        value.style.color = css(it.valueColor ?? lb.valueColor);
        row.appendChild(value);
      }
      host.appendChild(row);
    });
  }

  /** The player's colour, read from the game's own flat TeamColorNN.blp swatch. */
  private teamColor(player: number): string | null {
    return teamColorCss(this.vfs, player);
  }

  dispose(): void {
    this.teardown();
  }
}

/** 0xAARRGGBB → CSS rgba. */
function css(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255;
  return `rgba(${(argb >>> 16) & 0xff}, ${(argb >>> 8) & 0xff}, ${argb & 0xff}, ${a})`;
}
