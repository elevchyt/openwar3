import type { Options } from "./options";

// The Hotkeys option (issue #142) — WHICH KEY presses which command button.
//
// Options → Gameplay → "Hotkeys:" offers three, and only the first two are bindings:
//
//   · `legacy` — the classic scheme, and the default. A button's key is a letter the DATA
//     carries: `Hotkey`/`Researchhotkey` on the ability, unit or upgrade row (docs/tooltips.md),
//     which is why it is gilded inside the button's own Tip string ("|cffffcc00M|rove"). Two
//     buttons on one card never share a letter, so the card is matched by letter alone — see
//     `GameHud`'s key handler.
//   · `grid` — the key is the button's PLACE on the card rather than anything about the button.
//     The command card is a 4×3 grid and so is the block of keys under the left hand, row for
//     row: QWER over the top row, ASDF over the middle, ZXCV over the bottom. The pockets move
//     with it — the 2×3 inventory takes the 2×3 block to the RIGHT of that hand (T/Y, G/H, B/N)
//     in place of the numpad, which stays live either way (the numpad is a PLACE too).
//   · `custom` — the player's own bindings, from the file `CustomKeys.txt` the retired "Custom
//     Keyboard Shortcuts" checkbox used to enable (CUSTOM_KEYS_INFO says as much: "custom
//     hotkey and tip data from the file CustomKeys.txt"). It is LEGACY with the data changed
//     underneath it rather than a scheme of its own: the file overrides the `Hotkey`, `Tip` and
//     `Buttonpos` columns the game's own tables carry, and the card then reads a letter off a
//     button exactly as it always did. Which is why the dispatch below knows nothing about it
//     and `gridHotkeys()` answers false — everything custom about it happened at the data
//     boundary, in [`customKeys.ts`](./customKeys.ts).
//
// Every key here is read off `KeyboardEvent.code` rather than `.key`, because grid is a claim
// about the SHAPE of the keyboard: the top-left three keys are the top row of the card whatever
// the layout prints on them. (Legacy is the opposite — a letter the data names — and reads
// `.key`.)

/** The three rows of the Hotkeys pulldown. */
export type HotkeyMode = "legacy" | "grid" | "custom";

/**
 * The command card's keys, in card order (`row * 4 + col`, the index the HUD lays its twelve
 * slots out by). QWER / ASDF / ZXCV — the 4×3 block the left hand rests on.
 */
export const GRID_CARD_CODES: readonly string[] = [
  "KeyQ", "KeyW", "KeyE", "KeyR",
  "KeyA", "KeyS", "KeyD", "KeyF",
  "KeyZ", "KeyX", "KeyC", "KeyV",
];

/**
 * The pockets' keys, in inventory-slot order — the 2×3 block immediately right of the card's:
 * T/Y over the top pair, G/H over the middle, B/N over the bottom. The same shape the numpad's
 * 7/8, 4/5, 1/2 has (INVENTORY_NUMPAD in ui/hud.ts), moved under the hand that is already on
 * the card.
 */
export const GRID_INVENTORY_CODES: readonly string[] = ["KeyT", "KeyY", "KeyG", "KeyH", "KeyB", "KeyN"];

/** What a grid key PRINTS — the tooltip's hint, and the only place the letter is spelled out.
 *  A code is `Key<letter>` for all eighteen of them, so the letter is its last character. */
const letterOf = (code: string): string => code.slice(-1);

let mode: HotkeyMode = "legacy";
/** Options → Gameplay → "Show hotkeys on action buttons". */
let printed = true;

/** Push the Gameplay panel's "Hotkeys:" row onto the live binding — the same shape
 *  `applyHealthBarOptions` (render/worldOverlays.ts) has, and called from the same two places. */
export function applyHotkeyOptions(opts: Options): void {
  const v = opts.hotkeys;
  mode = v === "grid" || v === "custom" ? v : "legacy";
  printed = opts.showHotkeys !== false;
}

/** True while the command card prints each button's key in its bottom-right corner box. */
export function hotkeysOnButtons(): boolean {
  return printed;
}

/** Which scheme the keyboard is on right now. */
export function hotkeyMode(): HotkeyMode {
  return mode;
}

/** True while the card is keyed by PLACE. `custom` answers FALSE on purpose: it presses buttons
 *  by the letter written on them like `legacy` does — the player's file changed which letter
 *  that is, not how the key is found (customKeys.ts). */
export function gridHotkeys(): boolean {
  return mode === "grid";
}

/** The card slot this physical key presses, or -1 for a key that is not one of the twelve. */
export function gridCommandSlot(code: string): number {
  return GRID_CARD_CODES.indexOf(code);
}

/** The inventory slot this physical key uses, or -1. */
export function gridInventorySlot(code: string): number {
  return GRID_INVENTORY_CODES.indexOf(code);
}

/** The letter printed for the card slot at (row, col) — "" for a slot off the card. */
export function gridCommandKey(row: number, col: number): string {
  const code = GRID_CARD_CODES[row * 4 + col];
  return code ? letterOf(code) : "";
}

/** The letter printed for an inventory slot — "" for a slot off the pockets. */
export function gridInventoryKey(slot: number): string {
  const code = GRID_INVENTORY_CODES[slot];
  return code ? letterOf(code) : "";
}
