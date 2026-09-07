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

/**
 * The swatch the NEUTRAL players wear — the creeps (PLAYER_NEUTRAL_AGGRESSIVE), the shops
 * and critters (PLAYER_NEUTRAL_PASSIVE), and the two slots between them.
 *
 * It is BLACK, and it is not a player colour: the swatch folder is the player palette followed
 * by one black swatch per neutral slot, so the neutral index is the palette's SIZE, which the
 * 1.29 patch changed. Decoded off the two tables (the centre texel of each `TeamColorNN.blp`):
 *
 *     2003 (bj_MAX_PLAYERS = 12)   TeamColor00..11 the twelve colours, TeamColor12 black
 *     1.30.4 (24 player colours)   TeamColor00..23 (11 brown 78,42,4 — 12 MAROON 155,0,0),
 *                                  TeamColor24..27 all 0,0,0
 *
 * So handing the viewer the 2003 neutral slot on a 1.30.4 install paints a creep MAROON —
 * player 13's colour — and handing it the owner (-1) binds no swatch at all, which the viewer
 * falls back from with an opaque WHITE texture. Both were live: white on the field, maroon in
 * the portrait. The engine seats twelve players either way (PlayerSlot in data/enums.ts), so
 * the table is asked of the ART rather than of the seat count: TeamColor24 exists only in the
 * wide table. hiveworkshop 265242 / 276448 (the "custom team colors" threads) say the same of
 * the 2003 table — "12 colors plus black for neutrals" — and the install's own swatches
 * confirm it for 1.30.4.
 */
export function neutralTeamColor(vfs: Pick<DataSource, "exists">): number {
  return vfs.exists(TEAM_COLOR(24)) ? 24 : 12;
}

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

/** The colour's three channels, for a caller that needs numbers rather than a string (a
 *  minimap ping is given r/g/b). Falls back to white when the install has no such swatch. */
export function teamColorRgb(vfs: DataSource, player: number): [number, number, number] {
  return rgb(vfs, player) ?? [255, 255, 255];
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
