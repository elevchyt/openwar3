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
/** True for the length of a match on a map that is played by LETTER (`wantsClassicKeys`):
 *  Grid stands down to Legacy there whatever the Gameplay row says. Match-scoped and never
 *  written into the options — the player's choice comes back on the next map. */
let classicForMap = false;
/** Options → Gameplay → "Show hotkeys on command buttons". */
let printed = true;

/** Push the Gameplay panel's "Hotkeys:" row onto the live binding — the same shape
 *  `applyHealthBarOptions` (render/worldOverlays.ts) has, and called from the same two places. */
export function applyHotkeyOptions(opts: Options): void {
  const v = opts.hotkeys;
  mode = v === "grid" || v === "custom" ? v : "legacy";
  printed = opts.showHotkeys !== false;
}

/** True while the command card prints each button's key in its top-left corner. */
export function hotkeysOnButtons(): boolean {
  return printed;
}

/** Which scheme the keyboard is on right now — the option, unless the map overrides it. */
export function hotkeyMode(): HotkeyMode {
  return classicForMap && mode === "grid" ? "legacy" : mode;
}

/**
 * The scripts that are played by LETTER rather than by card slot, so Grid would break them.
 *
 * Blizzard's own Azeroth Grand Prix ("(8)AzerothGrandPrix.w3x", Maps\FrozenThrone\Scenario)
 * prints its controls in its own words — `GetGameTip` in its war3map.j: "Arrow keys - Drive your
 * cart", "'A' 'S' 'D' 'F' - Use items", "'W' - Fire machine gun", "'Q' - Honk" — and those
 * letters are the `Hotkey` columns of the cart's abilities, not their places on the card. Under
 * Grid the W key pressed whatever sat in the card's second slot, and the cart could not be driven
 * as the map tells you to. Asked of the script's GLOBALS rather than the file name, the same way
 * Extreme Candy War and WarChasers are recognised (ai/plus/candy/map.ts `isCandyWarScript`): these
 * four triggers are the map's cart picker and its driving, and a script with all of them is this one.
 */
export const CLASSIC_KEY_SCRIPTS: ReadonlyArray<readonly string[]> = [
  ["gg_trg_Pick_Cart", "gg_trg_Move_Cart", "gg_trg_Turning_Left", "gg_trg_Acceleration"],
];

/** Is the running script one of `CLASSIC_KEY_SCRIPTS`? */
export function wantsClassicKeys(globals: { has(name: string): boolean }): boolean {
  return CLASSIC_KEY_SCRIPTS.some((markers) => markers.every((g) => globals.has(g)));
}

/** Set (or clear) the map's Classic-keys override — cleared at every match start, set by
 *  `startCustom` once the script has shown which map it is. The Custom rung is untouched: it
 *  already presses buttons by the letter written on them. */
export function setClassicKeysForMap(on: boolean): void {
  classicForMap = on;
}

/** True while the card is keyed by PLACE. `custom` answers FALSE on purpose: it presses buttons
 *  by the letter written on them like `legacy` does — the player's file changed which letter
 *  that is, not how the key is found (customKeys.ts). */
export function gridHotkeys(): boolean {
  return hotkeyMode() === "grid";
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
