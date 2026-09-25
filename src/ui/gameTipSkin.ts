// The DRESS the game-tip slab wears outside a match (issue #156), apart from the slab itself so
// that the gamepad's on-screen keyboard (ui/padKeyboard.ts) can wear it too: gameTip.ts imports
// gamepad.ts (a pad cursor hovers as well as a mouse), which imports padKeyboard.ts, so the
// keyboard asking gameTip.ts for its dress closed an import cycle. This module imports nothing.

/** The slab's dress when no HUD has put it on `:root` — see `setGameTipSkin`. */
let menuSkin: Record<string, string> | null = null;
/** Re-dress what is already on screen (gameTip.ts's slab) when the skin changes. */
let onChange: (() => void) | null = null;

/**
 * Dress the slab in the game's tooltip art outside a match. In a match the HUD lifts the art to
 * `:root` and `body.hud-tooltip-skinned` does this; the menus have no HUD, so the properties
 * (ui/hud.ts `tooltipSkinVars`) go on the slab itself, under `.skinned`.
 */
export function setGameTipSkin(vars: Record<string, string> | null): void {
  menuSkin = vars;
  onChange?.();
}

/** Put the dress on one of our own slabs (the hover hint, the gamepad's on-screen keyboard):
 *  `.skinned` and the art's properties outside a match, nothing in one — there
 *  `body.hud-tooltip-skinned` already carries it. */
export function dressAsGameTip(el: HTMLElement): void {
  el.classList.toggle("skinned", !!menuSkin);
  for (const [k, v] of Object.entries(menuSkin ?? {})) el.style.setProperty(k, v);
}

/** gameTip.ts's hook for re-dressing its slab when `setGameTipSkin` is called. */
export function onGameTipSkinChange(fn: () => void): void {
  onChange = fn;
}
