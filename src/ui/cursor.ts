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
 *  modern one, so every cell we cut is blown up by this factor with smoothing OFF, keeping
 *  the art's own pixels rather than blurring them. It is ONE number because the cursor is
 *  several images that must agree: the `cursor:` rules here and in mapViewer, the DOM
 *  stand-ins that replace the pointer (the reticle, the hover hand, the edge-scroll chevron,
 *  the carried gauntlet) and the hotspot they all offset by. Everything derived from it is
 *  ROUNDED, since it need not be a whole number (1.5 puts the 32-px cell at 48) and neither
 *  a canvas nor a `cursor:` hotspot wants half a pixel. */
export const CURSOR_SCALE = 1.5;

/** `n` cursor texels at the scale above, as whole pixels. */
export function cursorPx(n: number): number {
  return Math.round(n * CURSOR_SCALE);
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
  const size = cursorPx(cell);
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false; // nearest-neighbour: the gauntlet's pixels, just bigger
  ctx.drawImage(sheet, 0, 0, cell, cell, 0, 0, size, size);
  const url = c.toDataURL();
  if (!styleEl) {
    styleEl = document.createElement("style");
    document.head.appendChild(styleEl);
  }
  // Hotspot near the gauntlet's fingertip (top-left), matching applyRaceCursor — and scaled
  // with the art, since it is a texel INSIDE the image we just enlarged. Use !important so
  // the hand shows in every state (buttons, hovers) — the reference menu never changes the
  // cursor. The in-game race cursor is also !important and scoped to body.in-game, so it
  // still wins during a match.
  const hot = cursorPx(3);
  styleEl.textContent = `body:not(.in-game), body:not(.in-game) * { cursor: url(${url}) ${hot} ${hot}, auto !important; }`;
}
