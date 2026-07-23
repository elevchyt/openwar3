// A player's colour, read from the game's own art rather than from a palette we typed.
//
// `ReplaceableTextures\TeamColor\TeamColorNN.blp` is a flat swatch — every texel is that
// player's colour — so one pixel is the whole answer. Reading it is the same rule the rest of
// the renderer follows (use the real asset when the game ships one), and it means a mod that
// re-skins the player colours re-skins ours too.
//
// Shared because three surfaces need the same answer in two different encodings: the
// leaderboard and the Allies dialog want CSS, and chat wants the eight hex digits a WC3 `|c`
// markup code takes. One decode per player, cached — the swatches never change.

import { blpToCanvas } from "./blputil";
import type { DataSource } from "../vfs/types";

const TEAM_COLOR = (i: number) => `ReplaceableTextures\\TeamColor\\TeamColor${String(i).padStart(2, "0")}.blp`;

/** player → [r, g, b], or null when the archives are not mounted. */
const cache = new Map<number, [number, number, number] | null>();

function rgb(vfs: DataSource, player: number): [number, number, number] | null {
  const hit = cache.get(player);
  if (hit !== undefined) return hit;
  let out: [number, number, number] | null = null;
  const bytes = vfs.rawBytes(TEAM_COLOR(player));
  if (bytes) {
    const px = blpToCanvas(bytes)?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
    if (px) out = [px[0], px[1], px[2]];
  }
  cache.set(player, out);
  return out;
}

/** `rgb(r, g, b)` for a stylesheet, or null. */
export function teamColorCss(vfs: DataSource, player: number): string | null {
  const c = rgb(vfs, player);
  return c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : null;
}

/** `aarrggbb` for a WC3 `|c` markup code (opaque alpha, which the renderer ignores anyway). */
export function teamColorHex(vfs: DataSource, player: number): string | null {
  const c = rgb(vfs, player);
  if (!c) return null;
  const hex = (v: number): string => v.toString(16).padStart(2, "0");
  return `ff${hex(c[0])}${hex(c[1])}${hex(c[2])}`;
}
