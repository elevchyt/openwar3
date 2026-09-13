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

/** How far apart the edge crops in `cursorImageValue` are cut. */
const EDGE_CROP_STEP = 8;

/**
 * A `cursor:` value for ANY enlarged cursor image that is not a plain cell of the sheet: the
 * tinted hover hand, the target reticle and the carried item. `hotX`/`hotY` are in `img`'s own
 * pixels.
 *
 * The list is `cursorValue`'s (the image, a ≤32 px twin, `default`) with EDGE CROPS between the
 * image and the twin. Chromium refuses any entry over 32 px whose rect would reach outside the
 * viewport (see `cursorValue`), and the twin is a SHRUNKEN picture — a 40-px reticle drops to 32,
 * but the carried item is 62×53 and halves, and the bottom inventory row it is dropped on sits a
 * few pixels off the bottom edge. So each side the image reaches past the hotspot is also offered
 * cut back EDGE_CROP_STEP px at a time. Near an edge the first crop that fits is the one drawn —
 * which looks like the screen edge clipping the cursor, as an OS clips its own, instead of the
 * cursor changing size. Entries are tried in order and a position near one edge can satisfy only
 * that edge's crops, so each side's run goes from least cut to most; a corner falls through to
 * the twin.
 */
export function cursorImageValue(img: HTMLCanvasElement, hotX: number, hotY: number): string {
  const hx = Math.round(hotX);
  const hy = Math.round(hotY);
  const w = img.width;
  const h = img.height;
  const fits = (cw: number, ch: number): boolean => cw <= MAX_UNCLIPPED_CURSOR && ch <= MAX_UNCLIPPED_CURSOR;
  if (fits(w, h)) return `url(${img.toDataURL()}) ${hx} ${hy}, default`;

  const entries = [`url(${img.toDataURL()}) ${hx} ${hy}`];
  /** `img` cut to (sx, sy, cw, ch), with the hotspot moved along with the cut. */
  const crop = (sx: number, sy: number, cw: number, ch: number): string => {
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    c.getContext("2d")!.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);
    return `url(${c.toDataURL()}) ${hx - sx} ${hy - sy}`;
  };
  // Each side: how many pixels the image reaches past the hotspot's own row/column, and the cut
  // that keeps `e` of them. A cut that brings the image to ≤32 px is never refused, so nothing
  // cut further on that side could ever be reached.
  const sides: Array<[number, (e: number) => [number, number, number, number]]> = [
    [h - hy - 1, (e) => [0, 0, w, hy + 1 + e]], // bottom
    [w - hx - 1, (e) => [0, 0, hx + 1 + e, h]], // right
    [hy, (e) => [0, hy - e, w, h - (hy - e)]], // top
    [hx, (e) => [hx - e, 0, w - (hx - e), h]], // left
  ];
  for (const [reach, cut] of sides) {
    for (let e = reach - EDGE_CROP_STEP; e >= 0; e -= EDGE_CROP_STEP) {
      const [sx, sy, cw, ch] = cut(e);
      entries.push(crop(sx, sy, cw, ch));
      if (fits(cw, ch)) break;
    }
  }

  const k = MAX_UNCLIPPED_CURSOR / Math.max(w, h);
  const c = document.createElement("canvas");
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true; // bilinear, like every other cut (see CURSOR_SCALE)
  ctx.drawImage(img, 0, 0, c.width, c.height);
  entries.push(`url(${c.toDataURL()}) ${Math.round(hx * k)} ${Math.round(hy * k)}`);
  return `${entries.join(", ")}, default`;
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
