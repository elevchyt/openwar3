import { blpToCanvas } from "../render/blputil";
import type { DataSource } from "../vfs/types";

// The WC3 human hand cursor for the menus (issue #54 follow-up). WC3's cursor is an
// animated model (UI\Cursor\HumanCursor.mdl, per UI\war3skins.txt) whose art is the
// sprite sheet UI\Cursor\HumanCursor.blp — an 8-column grid whose top-left cell is
// the idle gauntlet pointer. We take that cell and set it as the CSS cursor while the
// menu is up. In-game, the race cursor system in mapViewer.ts (applyRaceCursor) owns
// the cursor instead, so this rule is scoped to :not(.in-game).

let styleEl: HTMLStyleElement | null = null;

/** Apply the human hand cursor across the (non-in-game) menu screens. */
export function applyMenuCursor(vfs: DataSource): void {
  const bytes = vfs.rawBytes("UI\\Cursor\\HumanCursor.blp");
  const sheet = bytes ? blpToCanvas(bytes) : null;
  if (!sheet) return;
  const cell = Math.round(sheet.width / 8); // 8 cells wide; top-left = idle pointer
  const c = document.createElement("canvas");
  c.width = cell;
  c.height = cell;
  c.getContext("2d")!.drawImage(sheet, 0, 0, cell, cell, 0, 0, cell, cell);
  const url = c.toDataURL();
  if (!styleEl) {
    styleEl = document.createElement("style");
    document.head.appendChild(styleEl);
  }
  // Hotspot near the gauntlet's fingertip (top-left), matching applyRaceCursor. The
  // in-game race cursor uses !important, so it still wins during a match.
  styleEl.textContent = `body:not(.in-game), body:not(.in-game) * { cursor: url(${url}) 3 3, auto; }`;
}
