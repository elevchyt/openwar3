// Ally Color Mode — the button right of the minimap, and Alt-A.
//
// The whole feature is stated by the game's own strings, so nothing here is invented:
//
//   UI\FrameDef\GlobalStrings.fdf
//     MINIMAPALLYCOLORTOOLTIP       "Set Ally Color Mode (|Cfffed312Alt-A|R)"
//     MINIMAPALLYCOLORTOOLTIP_UBER  "This option cycles through three different unit color
//                                    modes.|N|N|Cfffed312Mode 1:|R All units use Player
//                                    Colors. |N|Cfffed312Mode 2:|R Minimap colors display
//                                    |CFF00FFFFAllies|R and |CFFFF0000Enemies|R.
//                                    |N|Cfffed312Mode 3:|R As Mode 2 and Gameworld colors
//                                    display |CFF0000FFYou|R, |CFF00FFFFAllies|R and
//                                    |CFFFF0000Enemies|R."
//   UI\TipStrings.txt Tip12         "You can toggle team color identification to ally/enemy
//                                    color identification on the minimap by clicking the
//                                    Toggle Minimap Ally Colors button to the right of the
//                                    minimap."
//   UI\TriggerStrings.txt           SetAllyColorFilterStateHint: "A value of 0 disables
//                                    filtering. A value of 1 enables filtering for the
//                                    minimap. A value of 2 enables filtering for the minimap
//                                    and the game view."  (_Defaults=0, _Limits=0,2)
//
// So the three modes ARE `SetAllyColorFilterState`'s own 0/1/2 — mode 1 is state 0 — and the
// script-facing native and the button are two handles on one number.
//
// **Which surfaces get which colours is read literally off the tooltip**, because Blizzard's
// two lines are deliberately different lengths: mode 2 names TWO colours (Allies, Enemies)
// and mode 3 names THREE (You, Allies, Enemies) for the *gameworld*, over a minimap that is
// still "As Mode 2". So the minimap paints allies and yourself alike — one teal for your
// whole side — and only the game world, in mode 3, separates YOU out in blue. (That is also
// what the reddit thread the feature is usually found through asks for: "how to have all
// allied units same color".)
//
// The three colours are the game's own player colours 0/1/2 — red, blue, teal — which is
// what the tooltip's own markup approximates (|CFFFF0000 red, |CFF0000FF blue, |CFF00FFFF
// teal). Naming the SLOT rather than a hex triple means the swatch comes from
// `ReplaceableTextures\TeamColor\TeamColorNN.blp` like every other player colour we paint
// (render/teamColor.ts), so a mod that reskins the palette reskins this too.

/** `SetAllyColorFilterState`'s state: 0 off, 1 minimap, 2 minimap + game world. */
export type AllyColorMode = 0 | 1 | 2;

/** The three modes the button cycles through (Mode 1/2/3 in the tooltip = state 0/1/2). */
export const ALLY_COLOR_MODES = 3;

/** Where a colour is being asked for. The two differ in mode 2, which is the whole point. */
export type ColorSurface = "minimap" | "world";

/** Who this player is to the one looking. `neutral` is "neither" — the creeps and the shops,
 *  which the filter leaves alone (see `allyFilterColor`). */
export type ColorSide = "self" | "ally" | "enemy" | "neutral";

/** Player-colour SLOTS the filter paints with: red 0, blue 1, teal 2 (the palette's own
 *  order, `PLAYER_COLORS` in ui/hud.ts and `TeamColor00/01/02.blp` in the archives). */
export const ALLY_FILTER_COLOR = { self: 1, ally: 2, enemy: 0 } as const;

/** Alt-A / a click: the next mode round the ring of three. */
export function nextAllyColorMode(mode: AllyColorMode): AllyColorMode {
  return (((mode + 1) % ALLY_COLOR_MODES) as AllyColorMode);
}

/** Clamp an arbitrary integer (a script's `SetAllyColorFilterState`) to a real state.
 *  TriggerData's own `_SetAllyColorFilterState_Limits=0,2` is the range. */
export function toAllyColorMode(state: number): AllyColorMode {
  return (Math.max(0, Math.min(ALLY_COLOR_MODES - 1, Math.trunc(state))) as AllyColorMode);
}

/**
 * The colour slot this side should be painted on this surface, or null to leave it wearing
 * its own player colour.
 *
 * Null — not "the player's colour" — because the caller is the one that knows what that is:
 * `SetPlayerColor` can move a slot's colour (RtsController.playerColor), and a unit may carry
 * a `SetUnitColor` of its own on top of that.
 *
 * `neutral` is never filtered. A creep and a shop reach us under the SAME owner (-1, see
 * rts.ts NEUTRAL_HOSTILE_OWNER / NEUTRAL_PASSIVE_OWNER), so "is this an enemy" cannot be
 * answered from the owner alone here, and reddening every fountain and tavern is a worse
 * error than leaving a creep camp its own grey.
 */
export function allyFilterColor(mode: AllyColorMode, surface: ColorSurface, side: ColorSide): number | null {
  if (mode === 0 || side === "neutral") return null;
  if (surface === "world" && mode < 2) return null; // mode 2 is the minimap only
  // The minimap is "As Mode 2" in BOTH filtered modes: your own side is one teal on it, and
  // only the world separates YOU out (see the header).
  if (side === "self") return surface === "world" ? ALLY_FILTER_COLOR.self : ALLY_FILTER_COLOR.ally;
  return ALLY_FILTER_COLOR[side];
}

/**
 * The `UI\war3skins.txt` key for the button's face.
 *
 * The table ships nine of them — `MiniMapAllyButton{Active,Inactive,Off}{Enabled,Pushed,
 * Disabled}` — one triple per mode, which is what says the button shows the mode it is IN
 * rather than the one it would switch to. Nothing in the install states which face belongs to
 * which mode; this is the mapping **confirmed against the real client** (developer, issue
 * thread), and it is the one the state names already read as:
 *
 *     mode 1 (state 0)  every player their own colour, map and world   `…Off`       crossed axes
 *     mode 2 (state 1)  the MINIMAP shows allies teal, enemies red     `…Inactive`  a pauldron
 *     mode 3 (state 2)  …and the world shows you blue with them        `…Active`    + its lens
 *
 * `Pushed` is the `-down` twin of whichever of the three is up — the art the button wears
 * while it is held — and `Disabled` the greyed one for a button the map has taken away.
 *
 * The nine keys live in war3skins' **[Default]** section rather than in a race's: Blizzard
 * only ever drew the Human widget (there is no `orc-minimap-ally-*.blp` in the archives), so
 * every race's console shows this same button — the same way the tooltip slab and the
 * command-button glow are Human-only art that all four races draw. Asking by KEY is still
 * what makes that true rather than assumed: `skinPath` resolves the race's own section first
 * and falls through to [Default], so a mod that DOES draw one gets it for nothing.
 */
export function allyButtonSkin(mode: AllyColorMode, press: "Enabled" | "Pushed" | "Disabled"): string {
  const state = mode === 0 ? "Off" : mode === 1 ? "Inactive" : "Active";
  return `MiniMapAllyButton${state}${press}`;
}
