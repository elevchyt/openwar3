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

import { blpToCanvas } from "../render/blputil";
import type { LeaderboardObj } from "../jass/runtime";
import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame } from "./fdf/parser";
import { firstProp, numProp, type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { wc3ToHtml } from "./wc3Text";

const LEADERBOARD_FDF = "UI\\FrameDef\\UI\\LeaderBoard.fdf";
const TEAM_COLOR = (i: number) => `ReplaceableTextures\\TeamColor\\TeamColor${String(i).padStart(2, "0")}.blp`;

// All in the FDF's 0.8×0.6 world units. The title/backdrop geometry is the file's; these
// are the numbers the engine owns (row pitch, title band, and where the board hangs).
const ROW_H = 0.0165; // one row's pitch — sized off LeaderboardTitle's 0.011f font
const TITLE_LINE = 0.016; // ...and the title's own line height (see titleHeight below)
const TITLE_H = 0.034; // the whole title band: the FDF's 0.015 top inset + one line
const PAD = 0.012; // backdrop inset below the last row
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

  /** mountFdfScreen re-lays the panel out on resize, which wipes the rows we injected —
   *  they aren't part of the FDF tree. Re-inject after it has rebuilt (our listener is
   *  registered later, so it runs later). */
  private readonly onResize = (): void => {
    if (this.screen && this.current) this.paintRows(this.current);
  };
  private current: LeaderboardObj | null = null;

  /** `skin` is the war3skins.txt section the panel's chrome is decorated from — WC3 gives
   *  the in-game panels the local player's RACE ("Orc", "NightElf", …). */
  constructor(private container: HTMLElement, private vfs: DataSource, private skin: string) {
    window.addEventListener("resize", this.onResize);
  }

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
    this.current = null;
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
      });
      prev?.dispose(); // swap only once the new one is up, so the board never blinks
      this.current = lb;
      this.paintRows(lb);
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
  private paintRows(lb: LeaderboardObj): void {
    const host = this.screen?.element.querySelector<HTMLElement>('[data-frame="LeaderboardListContainer"]');
    if (!host) return;
    const box = host.getBoundingClientRect();
    if (box.height <= 0) return;
    const rowPx = box.height / Math.max(lb.items.length, lb.rows, 1);
    const fontPx = Math.min(rowPx * 0.78, box.height);

    lb.items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "leaderboard-row";
      row.style.top = `${i * rowPx}px`;
      row.style.left = "0";
      row.style.right = "0";
      row.style.height = `${rowPx}px`;
      row.style.fontSize = `${fontPx}px`;

      // The icon is the player's colour swatch — WC3 shows a small colour chip per row.
      if (lb.showIcons && it.showIcon) {
        const swatch = this.teamColor(it.player);
        if (swatch) {
          const chip = document.createElement("span");
          chip.className = "leaderboard-icon";
          chip.style.width = chip.style.height = `${Math.round(fontPx * 0.72)}px`;
          chip.style.background = swatch;
          row.appendChild(chip);
        }
      }

      if (lb.showNames && it.showLabel) {
        const label = document.createElement("span");
        label.className = "leaderboard-label";
        label.innerHTML = wc3ToHtml(it.label);
        label.style.color = css(it.labelColor ?? lb.labelColor);
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
    const cached = teamColorCache.get(player);
    if (cached !== undefined) return cached;
    let out: string | null = null;
    const bytes = this.vfs.rawBytes(TEAM_COLOR(player));
    if (bytes) {
      const canvas = blpToCanvas(bytes);
      const px = canvas?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
      if (px) out = `rgb(${px[0]}, ${px[1]}, ${px[2]})`;
    }
    teamColorCache.set(player, out);
    return out;
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.teardown();
  }
}

/** Player index → CSS colour. The swatches never change, so one decode per colour. */
const teamColorCache = new Map<number, string | null>();

/** 0xAARRGGBB → CSS rgba. */
function css(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255;
  return `rgba(${(argb >>> 16) & 0xff}, ${(argb >>> 8) & 0xff}, ${argb & 0xff}, ${a})`;
}
