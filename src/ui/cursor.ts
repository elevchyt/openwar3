import { blpToCanvas } from "../render/blputil";
import type { DataSource } from "../vfs/types";

// The WC3 human hand cursor for the menus (issue #54 follow-up). WC3's cursor is an
// animated model (UI\Cursor\HumanCursor.mdl, per UI\war3skins.txt) whose art is the
// sprite sheet UI\Cursor\HumanCursor.blp — an 8-column grid whose top-left cell is
// the idle gauntlet pointer. We take that cell and set it as the CSS cursor while the
// menu is up. In-game, the race cursor system in mapViewer.ts (applyRaceCursor) owns
// the cursor instead, so this rule is scoped to :not(.in-game).

/** How much larger than its own art every cursor is drawn. The sheet's cell is 32 px — the
 *  size WC3 drew a pointer at on a 2003 display — which reads as a very small pointer on a
 *  modern one, so every cell we cut is blown up by this factor. It is ONE number because the
 *  cursor is several images that must agree: the `cursor:` rules here and in mapViewer, the
 *  DOM stand-ins that replace the pointer (the reticle, the hover hand, the edge-scroll
 *  chevron, the carried gauntlet) and the hotspot they all offset by. Everything derived
 *  from it is ROUNDED, since it need not be a whole number (1.25 puts the 32-px cell at 40)
 *  and neither a canvas nor a `cursor:` hotspot wants half a pixel.
 *
 *  The blow-up is BILINEAR (`imageSmoothingEnabled`, the canvas default, left on and said
 *  out loud at each of the five cuts) rather than nearest-neighbour: at a fractional scale
 *  nearest-neighbour doubles some rows of the gauntlet and not others, which reads as a
 *  ragged edge rather than as pixel art. */
export const CURSOR_SCALE = 1.25;

/** `n` cursor texels at the scale above, as whole pixels. */
export function cursorPx(n: number): number {
  return Math.round(n * CURSOR_SCALE);
}

/** The largest custom cursor Chromium will draw wherever the pointer is — see `cursorValue`. */
const MAX_UNCLIPPED_CURSOR = 32;

/** The sheet's cell at (`sx`, `sy`) drawn `size` px square, as a data URL. */
function cellUrl(sheet: CanvasImageSource, sx: number, sy: number, cell: number, size: number): string {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true; // bilinear — a fractional scale has no clean pixel step
  ctx.drawImage(sheet, sx, sy, cell, cell, 0, 0, size, size);
  return c.toDataURL();
}

/**
 * The `cursor:` value for the idle pointer (the sheet's top-left cell): the cell enlarged by
 * CURSOR_SCALE, then the SAME cell at no more than 32 px, then `default`.
 *
 * The second image is what keeps the pointer the game's everywhere. Chromium refuses a custom
 * cursor larger than 32 px whenever the image would reach outside the viewport — so a page cannot
 * draw over the browser's own UI (Blink `EventHandler::SelectCursor`,
 * `kMaximumCursorSizeWithoutFallback`) — and moves on to the NEXT entry in the list. At 1.25 the
 * cell is 40 px, so within ~36 px of the right or bottom edge the enlarged hand was dropped and
 * the old `auto` answered instead: the OS I-beam over the menu's bottom-right version line, the OS
 * hand over a link. A 32 px image is never refused, so near an edge the gauntlet only draws at its
 * own size for a moment; `default` is just the last word the syntax requires.
 */
export function cursorValue(sheet: CanvasImageSource, cell: number): string {
  const big = cursorPx(cell);
  const small = Math.min(cell, MAX_UNCLIPPED_CURSOR);
  const hot = cursorPx(3);
  const smallHot = Math.round((3 * small) / cell);
  return `url(${cellUrl(sheet, 0, 0, cell, big)}) ${hot} ${hot}, ` +
    `url(${cellUrl(sheet, 0, 0, cell, small)}) ${smallHot} ${smallHot}, default`;
}

let styleEl: HTMLStyleElement | null = null;

/** Apply a race's hand cursor across the (non-in-game) menu screens. Human everywhere except
 *  the Campaign screen, which wears the cursor its campaign names (`Cursor=3` → Night Elf —
 *  see data/campaigns.ts); the four sheets are the same 8-cell grid. */
export function applyMenuCursor(vfs: DataSource, race: "Human" | "Orc" | "Undead" | "NightElf" = "Human"): void {
  const bytes = vfs.rawBytes(`UI\\Cursor\\${race}Cursor.blp`) ?? vfs.rawBytes("UI\\Cursor\\HumanCursor.blp");
  const sheet = bytes ? blpToCanvas(bytes) : null;
  if (!sheet) return;
  const cell = Math.round(sheet.width / 8); // 8 cells wide; top-left = idle pointer
  if (!styleEl) {
    styleEl = document.createElement("style");
    document.head.appendChild(styleEl);
  }
  // Hotspot near the gauntlet's fingertip (top-left), matching applyRaceCursor — and scaled
  // with the art, since it is a texel INSIDE the image we just enlarged. Use !important so
  // the hand shows in every state (buttons, hovers, LINKS) — the reference menu never changes
  // the cursor, and neither may an anchor or a line of text. The in-game race cursor is also
  // !important and scoped to body.in-game, so it still wins during a match.
  styleEl.textContent = `body:not(.in-game), body:not(.in-game) * { cursor: ${cursorValue(sheet, cell)} !important; }`;
}
