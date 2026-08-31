// Ally Color Mode — the button right of the minimap, and Alt-A.
//
// The whole feature is stated by the game's own files, so nothing here is invented:
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
//   UI\MiscData.txt [FogOfWar]      FogColorPlayer=255,255,255,255   ← YOU, always
//                                   FogColorAlly=255,0,255,210
//                                   FogColorEnemy=255,255,0,0
//
// So the three modes ARE `SetAllyColorFilterState`'s own 0/1/2 — mode 1 is state 0 — and the
// script-facing native and the button are two handles on one number.
//
// **The two surfaces answer in different currencies, which is why this file has two
// functions rather than one with a `surface` argument.**
//
//  · The MINIMAP has its own palette, sitting in `[FogOfWar]` right beside the creep colour
//    our dots already come from: `FogColorAlly` (0,255,210) and `FogColorEnemy` (255,0,0)
//    ARE what modes 2 and 3 paint everyone else in. So a minimap dot is not a player-colour
//    slot at all — it is one of those tones, or the player's own colour when unfiltered.
//
//  · The WORLD can only be told a player-colour SLOT: a unit's team-coloured parts are a
//    replaceable texture, and `TeamColorNN.blp` is the whole vocabulary. Mode 3's blue/teal/
//    red are therefore slots 1/2/0 — which is what the tooltip's own markup approximates
//    (|CFF0000FF blue, |CFF00FFFF teal, |CFFFF0000 red).
//
// **You are WHITE on your own minimap in every mode, filter or no filter.** That is
// `FogColorPlayer`, it is not part of the filter, and it is why Blizzard's Mode 2 line can
// name only Allies and Enemies while Mode 3's names You as a *Gameworld* colour: on the
// minimap you were never in the filter's gift to begin with. Confirmed in the real client
// (developer) — and it holds for each player on their OWN screen only, which falls out of
// the filter being a local display setting (RtsController.colorSide).

/** `SetAllyColorFilterState`'s state: 0 off, 1 minimap, 2 minimap + game world. */
export type AllyColorMode = 0 | 1 | 2;

/** The three modes the button cycles through (Mode 1/2/3 in the tooltip = state 0/1/2). */
export const ALLY_COLOR_MODES = 3;

/** Who this player is to the one looking. `neutral` is "neither" — the creeps and the shops,
 *  which the filter leaves alone (see `worldFilterColor`). */
export type ColorSide = "self" | "ally" | "enemy" | "neutral";

/** Which of `[FogOfWar]`'s three friend-or-foe colours a minimap dot takes, or null for
 *  "paint it in the player's own colour". The HUD holds the colours themselves
 *  (SELF_DOT_COLOR / ALLY_DOT_COLOR / ENEMY_DOT_COLOR in data/gameplayConstants.ts). */
export type MinimapTone = "self" | "ally" | "enemy" | null;

/** Player-colour SLOTS the WORLD filter paints with: red 0, blue 1, teal 2 (the palette's
 *  own order, `PLAYER_COLORS` in ui/hud.ts and `TeamColor00/01/02.blp` in the archives). */
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
 * What a MINIMAP dot for this side is painted in.
 *
 * `self` comes back in every mode, mode 1 included: your own units are `FogColorPlayer`
 * white on your own minimap whatever the filter says (see the header). Everyone else is
 * filtered or not: teal/red from mode 2 up, their own player colour below it.
 *
 * The neutrals are never filtered. A creep and a shop reach us under the SAME owner (-1,
 * see rts.ts NEUTRAL_HOSTILE_OWNER / NEUTRAL_PASSIVE_OWNER), so "is this an enemy" cannot
 * be answered from the owner alone, and reddening every fountain and tavern is a worse
 * error than leaving a creep camp the grey `FogColorCreepNormal` the client gives it.
 */
export function minimapDotTone(mode: AllyColorMode, side: ColorSide): MinimapTone {
  if (side === "self") return "self";
  if (mode === 0 || side === "neutral") return null;
  return side; // "ally" | "enemy"
}

/**
 * The player-colour slot a unit's team-coloured parts wear in the WORLD, or null to leave it
 * wearing its own colour.
 *
 * Null — not "the player's colour" — because the caller is the one that knows what that is:
 * `SetPlayerColor` can move a slot's colour (RtsController.playerColor), and a unit may carry
 * a `SetUnitColor` of its own on top of that.
 *
 * Only mode 3 (state 2) reaches the world at all; mode 2 is the minimap alone, which is the
 * one difference between the two filtered modes.
 */
export function worldFilterColor(mode: AllyColorMode, side: ColorSide): number | null {
  if (mode < 2 || side === "neutral") return null;
  return ALLY_FILTER_COLOR[side];
}

/**
 * The `UI\war3skins.txt` key for the button's face.
 *
 * The table ships nine of them — `MiniMapAllyButton{Active,Inactive,Off}{Enabled,Pushed,
 * Disabled}` — one triple per mode, which is what says the button shows the mode it is IN
 * rather than the one it would switch to. Nothing in the install states which face belongs to
 * which mode; this is the mapping **confirmed against the real client** (developer), and it
 * is the one the state names already read as:
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
