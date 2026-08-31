// In-game HUD (plan §10.1b — reference screenshot 2026-07-02). Structurally
// faithful DOM shell: top bar (menu buttons, clock, resources + upkeep) and the
// bottom console (minimap, portrait/info, inventory, command card). Skinned
// with CSS placeholders; real BLP icons and the map's own minimap image are
// used when available (asset-resolver philosophy: authentic when present).

import { ArmorType, AttackType, PrimaryAttribute } from "../data/enums";
import { ALLY_DOT_COLOR, campMarker, ENEMY_DOT_COLOR, NEUTRAL_DOT_COLOR, SELF_DOT_COLOR } from "../data/gameplayConstants";
import type { MinimapPing } from "../jass/runtime";
import { escapeHtml, wc3StripMarkup, wc3ToHtml } from "./wc3Text";

import { CHAT_MAX_LENGTH, sanitizeChat, type ChatTarget } from "../game/chat";
import type { HeroBarEntry } from "../game/rts";
import { allyButtonSkin, type AllyColorMode } from "../game/allyColor";
import type { MinimapDot } from "../game/minimapView";
import { CONSOLE_BAND_H, type ConsoleResources } from "./consoleUi";
import { UI_HEIGHT, UI_WIDTH } from "./fdf/layout";
import { HERO_LEVEL_FX_OVERHANG, HeroLevelFx } from "./heroLevelFx";
import { MODAL_FX_OVERHANG, ModalButtonFx } from "./modalButtonFx";

/** WC3's upkeep bands, as the resource bar colours them. */
const UPKEEP_COLORS = { none: "#5be05a", low: "#e0c146", high: "#e05046" };

/** Which upkeep band a food count falls in: 0 none (0–50), 1 low (51–80), 2 high (81+).
 *  Shared with the message the game prints when a player crosses one (`Upkeeplevel`, see
 *  MapViewerScene.noteUpkeep) so the label and the line can never disagree. */
export function upkeepBand(foodUsed: number): 0 | 1 | 2 {
  return foodUsed <= 50 ? 0 : foodUsed <= 80 ? 1 : 2;
}

/** The band's label, as the resource bar prints it. */
export const UPKEEP_LABEL = ["No Upkeep", "Low Upkeep", "High Upkeep"] as const;

export type OrderMode = "move" | "attack" | null;

/** One command-card button (order, build, or train). */
export interface CommandButton {
  id: string; // "move" | "stop" | "attack" | "build" | "cancel" | "build:htow" | "train:hfoo"
  icon: string | null; // data URL
  /** The art to draw INSTEAD of `icon` while the button is `disabled` — the icon's own
   *  `CommandButtonsDisabled\DIS*` twin (see MapViewerScene.disabledArt). It is a different
   *  texture, not a filter: the twin is drawn desaturated AND with the gold button frame
   *  removed, which is how the original says "you can't press this". Only set when the
   *  button is unavailable, and null when the icon ships no twin — the button then falls
   *  back to desaturating the live art. */
  disabledIcon?: string | null;
  name: string;
  hotkey: string;
  /** The tooltip TITLE as the game itself writes it (UnitStrings/AbilityStrings
   *  `Tip`), WC3 markup intact: "Train |cffffcc00P|reasant". Absent for the
   *  hand-written orders (Move/Stop/…), which fall back to name + hotkey. */
  tip?: string;
  desc: string; // tooltip body (Ubertip), WC3 markup intact
  gold: number;
  lumber: number;
  food: number;
  mana?: number; // spell mana cost — shown on the cost row with the game's mana icon
  col: number; // 0–3
  row: number; // 0–2
  /** UNAVAILABLE the way WC3 means it: a prerequisite isn't there (no Barracks yet,
   *  three Heroes already, the Hero level the next rank wants), so the engine swaps
   *  in the icon's desaturated `DISBTN*` art and the button stops being a button —
   *  no click, no hotkey, no click sound. Nothing is said out loud either, because
   *  Units\commandstrings.txt [Errors] has no line for "requirements not met": the
   *  red "Requires: …" in the tooltip is the whole explanation.
   *
   *  A PRICE is deliberately NOT this — see `cantAfford`. */
  disabled: boolean;
  /** A FULL button you just can't pay for this second (gold, lumber, food, mana, an empty
   *  shelf, no patron in range). It looks exactly like one you can afford, because that is
   *  what it is: the thing is unlocked and the button is live. WC3 takes the click and
   *  answers it with the refusal every player knows — "Not enough gold." in the worker's
   *  own voice, which is an [Errors] line precisely BECAUSE the button stays live. The
   *  price is shown where a price belongs: the tooltip reddens the number you're short of.
   *
   *  So this draws nothing, and it must never eat the press. Grey art means UNAVAILABLE
   *  (`disabled`), and saying that about a Barracks you're 40 gold from is just wrong. */
  cantAfford?: boolean;
  /** The one price WC3 DOES draw: a spell whose mana cost is above the caster's current
   *  mana. The engine multiplies the icon by a deep blue (Warsmash reads the same tint off
   *  the original: `CommandCardIcon.setColor(0.3, 0.5, 1, 1)` when `mana < manaCost`), so
   *  the whole card tells you at a glance which spells are out of reach. It is a TINT on
   *  the art, not the greyed DIS* swap — the spell is learned and ready, it just isn't
   *  paid for.
   *
   *  The button stays live: the click still earns "Not enough mana." out loud. What it no
   *  longer does is arm a target (see RTS.armCast) — WC3 refuses at the press, so you
   *  never pick a target for a cast that can't happen (issue #110). */
  noMana?: boolean;
  /** A passive ability (Critical Strike, an aura): an INDICATOR that the unit has
   *  the thing, not an order. It shows in full colour — it is working right now —
   *  but it takes no press at all: no sink, no click sound, no hotkey. Learning one
   *  is a different button on the learn page, and that one is pressable. */
  passive?: boolean;
  /** THE current command of the selected unit — the one button wearing the green
   *  active border. At most one button in a card ever has this set. */
  active: boolean;
  /** The button is STANDING ON, and wears WC3's `UI-ModalButtonOn.mdx` sparkle to say so
   *  (see ui/modalButtonFx.ts). Two things say it in the original and they share the model:
   *  an autocast toggled on — a persistent setting, not the current order, which is why it
   *  can never be `active` — and a hero's learn-skill button with a point left to spend. */
  modal?: boolean;
  /** What a RIGHT-click on this button runs instead of `id`. An autocastable ability is the
   *  one button in WC3 that answers to both buttons: left casts it now, right flips whether
   *  the unit casts it by itself (issue #106). Absent on everything else. */
  altId?: string;
  cooldownLeft?: number; // seconds remaining on the ability's cooldown (0/undefined = ready)
  cooldownFrac?: number; // remaining fraction 0..1 (drives the radial sweep)
  count?: number; // corner badge (0/undefined = none) — e.g. a hero's unspent skill points
}

/** One hero inventory slot (null = empty). */
export interface HudInvSlot {
  icon: string | null; // data URL
  name: string;
  desc: string;
  charges: number; // remaining charges (0 = no badge)
  cooldownLeft: number; // seconds remaining (0 = ready)
  cooldownFrac: number; // remaining fraction 0..1 (radial sweep)
  usable: boolean; // has an active effect (potion/scroll) vs a passive stat item
}

export interface HudSelection {
  id: number;
  name: string;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  armor: number; // base armour
  armorBonus: number; // green "+N" from buffs/auras
  invulnerable: boolean; // immune to damage — shows red "Invulnerable" under the armour value (issue #26)
  damageMin: number; // base damage range
  damageMax: number;
  damageBonus: number; // green "+N" attack damage
  attackType: AttackType;
  armorType: ArmorType;
  attackUpgrade: number; // level of the owner's melee/ranged research; NEGATIVE = none reaches this unit
  armorUpgrade: number; // level of the owner's armour research; NEGATIVE = none reaches this unit
  isHero: boolean;
  properName: string; // hero's given name ("Painkiller"); "" for non-heroes
  level: number;
  xp: number; // hero current experience
  xpThis: number; // XP threshold for the current level
  xpNext: number; // XP threshold for the next level
  skillPoints: number; // unspent hero skill points
  strength: number; // base attribute (without item bonus)
  agility: number;
  intelligence: number;
  strengthBonus: number; // item contribution (green "+N" / red "-N")
  agilityBonus: number;
  intelligenceBonus: number;
  primaryAttr: PrimaryAttribute;
  carryGold: number;
  carryLumber: number;
  isBuilding: boolean;
  underConstruction: boolean;
  buildProgress: number; // 0..1
  trainProgress: number; // 0..1 (unit currently training)
  secondsLeft: number; // seconds left on the active job (for the progress label)
  queueLength: number;
  queue: Array<{ icon: string }>; // icons of queued training units
  icon: string; // the selected thing's own command icon (BLP path)
  builderId: number; // the worker hidden INSIDE this structure while it goes up (0 = none)
  builderIcon: string; // that worker's icon (BLP path) — the button under the building's icon
  isMine: boolean; // selected gold mine
  goldRemaining: number; // gold left in the selected mine
  isItem: boolean; // selected ground item (show name + description instead of stats)
  description: string; // item description (shown when isItem)
  isSummon: boolean; // temporary summon — show the "Summoned Unit" timer bar
  summonSecondsLeft: number; // seconds until it expires
  summonFrac: number; // remaining fraction of its lifetime (bar fill)
  /** Active auras/buffs/debuffs, as the info panel's Status row shows them: the BUFF's
   *  own icon, name and tooltip body (`Buffart`/`Bufftip`/`Buffubertip`). */
  buffs: Array<{ icon: string; name: string; tip: string }>;
}

export interface HudDriver {
  /** `EnableUserControl` — false while a cinematic owns the input (7.24). The console's own
   *  keys stand down with it: a control group recalled or a hero selected mid-cinematic is
   *  the same interaction as clicking one, and the script is composing the shot. */
  controlEnabled(): boolean;
  resources(): { gold: number; lumber: number; foodUsed: number; foodMax: number };
  selection(): HudSelection | null;
  /** Minimap dots: world positions + owning player (for colour), and the friend-or-foe
   *  `tone` that overrides that colour on the local player's own minimap — white for their
   *  own units in every mode, teal/red for allies and enemies once an Ally Color Mode is on
   *  (game/allyColor.ts). */
  dots(): MinimapDot[];
  /** Ally Color Mode — which of the three the local player is in (game/allyColor.ts). The
   *  button right of the minimap wears its face; Alt-A and a click cycle it. */
  allyColorMode(): AllyColorMode;
  /** Cycle it, and report where it landed (so the button can redress itself at once). */
  cycleAllyColorMode(): AllyColorMode;
  /** …unless the map has taken the button away (`EnableMinimapFilterButtons`), in which
   *  case it wears the greyed face and neither the click nor Alt-A answers. */
  allyColorButtonEnabled(): boolean;
  /** A `UI\FrameDef\GlobalStrings.fdf` string by key, with a literal to fall back on when
   *  no install is mounted. (The game writes the minimap buttons' tooltips in it.) */
  uiString(key: string, fallback: string): string;
  /** Creep-camp difficulty markers: camp centre + combined creep level (the HUD
   *  colours and sizes it per `UI\MiscData.txt` [Minimap]). Fixed map data. */
  creepCamps(): Array<{ x: number; y: number; level: number }>;
  /** Persistent map glyphs — gold mines and the neutral buildings that carry a
   *  minimap icon — as a world position and the BLP to stamp there. */
  minimapIcons(): Array<{ x: number; y: number; icon: string }>;
  /** World rect covered by the map: [originX, originY, width, height]. */
  mapBounds(): [number, number, number, number];
  /** Fog-of-war state at a world point: 0 unexplored, 1 explored, 2 visible. */
  fogAt(wx: number, wy: number): number;
  /** The ground the viewport is looking at, as a world rect: the minimap's white camera
   *  box (issue #112). Origin + size, so it shrinks as the view zooms in. */
  cameraRect(): { x: number; y: number; w: number; h: number };
  panTo(wx: number, wy: number): void;
  /** A click on the minimap, resolved to a world point (issue #64): a right-click moves
   *  the selection there (or cancels an armed order), and an armed attack-move / patrol /
   *  rally lands at that point on a left-click. A spell is never aimed at the minimap.
   *  "ordered" → it became a command (clear the armed highlight, do NOT pan); "ignored" →
   *  consumed, armed order still stands; "none" → not a command (left-click pans). */
  minimapClick(wx: number, wy: number, right: boolean, queued: boolean): "ordered" | "ignored" | "none";
  /** Alt-click on the minimap: mark a spot for your allies (`Allyminimapping`, "%s has
   *  marked the way."). The binding is ours — no data file names a key for it. */
  minimapPing(wx: number, wy: number): void;
  /** Portrait clicked: snap the camera to the selected unit; `lock` follows it. */
  focusSelected(lock: boolean): void;
  setOrderMode(mode: OrderMode): void;
  stopSelected(): void;
  /** Icons for a multi-unit selection grid (empty for a single unit / mine). */
  selectionIcons(): Array<{ simId: number; icon: string; hpFrac: number; manaFrac: number; focused: boolean; owner: number }>;
  /** Grid icon click: focus the unit's sub-group (like Tab), or (if that group is
   *  already focused) drill down to just this one unit. */
  selectGridUnit(simId: number): void;
  /** Shift-click a grid icon: remove just that unit from the current selection. */
  deselectUnit(simId: number): void;
  /** Select ONLY this unit (used internally once a focused sub-group is drilled into). */
  selectSingle(simId: number): void;
  /** If a spell/attack is armed, apply it to this grid unit; true if consumed. */
  tryTargetArmedAt(simId: number): boolean;
  /** Cycle focus to the next (or, reversed, previous) sub-group (Tab / Shift+Tab). */
  cycleFocus(reverse: boolean): void;
  /** Select + centre on the next idle worker (idle-worker badge / F8 / ~). */
  cycleIdleWorker(): void;
  /** How many local workers are currently idle (badge count). */
  idleWorkerCount(): number;
  /** Icon (BLP path) of the local player's worker, for the idle-worker button. */
  workerIcon(): string | null;
  /** Ctrl+N — bind the current selection to control group N ("0".."9"). */
  assignControlGroup(key: string): void;
  /** Shift+N — append the current selection to control group N. */
  appendControlGroup(key: string): void;
  /** N — recall control group N; `jump` (double-tap) also centres the camera. False when
   *  the group is empty: nothing was selected, so nothing may be followed either. */
  recallControlGroup(key: string, jump: boolean): boolean;
  /** F1/F2/F3 — select hero `index`; `jump` (double-tap) also centres the camera. False when
   *  the player has no such hero. */
  selectHero(index: number, jump: boolean): boolean;
  /** Hold the key down on that double-tap (a hero key or a control-group digit) and the
   *  camera RIDES the recalled selection until the key comes back up — WC3's hold-to-follow. */
  followSelection(on: boolean): void;
  /** The hero bar's buttons: the local player's living heroes in hire order, the order
   *  F1/F2/F3 also count in. */
  heroBar(): HeroBarEntry[];
  /** Right-click a hero's button with a unit-producing building selected: rally it onto that
   *  hero. False when the selection has nothing to rally (the click then means nothing). */
  rallyToHero(index: number): boolean;
  /** Give an inventory item to the hero behind button `index` — `slot` when the gesture was a
   *  drag out of the inventory grid, omitted to spend the item the player has already picked
   *  up with a right-click. False when there is nothing to give. */
  dropItemOnHero(index: number, slot?: number): boolean;
  /** Command-card buttons for the current selection (empty = no card). */
  commandCard(): CommandButton[];
  /** Run a command-card button by id. */
  runCommand(id: string): void;
  /** The primary selected hero's 6 inventory slots (null = empty; [] = no inventory). */
  inventory(): Array<HudInvSlot | null>;
  /** Left-click / numpad an inventory slot: use it (or arm its drop/give targeting). */
  useInventory(slot: number): void;
  /** Right-click an inventory slot: arm its drop/give targeting. */
  moveInventory(slot: number): void;
  /** Data URL for a resource icon, or null to use the text fallback. */
  icon(kind: "gold" | "lumber" | "supply"): string | null;
  /** Data URL for a command button icon (e.g. "BTNMove"), or null. */
  commandIcon(name: string): string | null;
  /** Data URL for an arbitrary BLP path (e.g. a unit's command icon), or null. */
  blpUrl(path: string): string | null;
  /** An arbitrary BLP decoded to a canvas, for chrome that needs pixel work — the
   *  tooltip border ships as an 8-tile strip that has to be re-sliced. Null if the
   *  file isn't in the mounted archives. */
  blpCanvas(path: string): HTMLCanvasElement | null;
  /** Current game time for the clock (hour 0–24, day/night flag). */
  /** The chat entry line's prompt for a target — the game's own `COLON_MESSAGE_*` string
   *  ("To All:", "To Allies:", or plain "Message:" in a single-player match). */
  chatPrompt(target: ChatTarget): string;

  /** A line the local player typed and sent. */
  sendChat(text: string, target: ChatTarget): void;

  /** Has the local player anyone to address as "Allies"? Decides whether the entry line has
   *  two modes to Tab between or only one (see `defaultChatTarget`). */
  chatHasAllies(): boolean;

  /** Push the resource readout to the FDF top bar (ui/consoleUi.ts), which owns that text now. */
  setResources(next: ConsoleResources): void;

  dayNight(): { hour: number; isDay: boolean };
  /** Take over the top-bar clock slot with the race's real TimeIndicator model, sizing
   *  and driving it from the host's own render loop. False → use the atlas fallback. */
  mountClock(slot: HTMLElement): boolean;
  /** The map's own minimap image (war3mapMap.blp), if decodable. */
  minimapImage(): HTMLCanvasElement | null;
  /** Is the console's real chrome on screen? True once an install is mounted, in which case
   *  ui/consoleUi.ts is drawing `ConsoleUI.fdf` and the HUD's widgets go in its sockets;
   *  false with no install, and the HUD draws its own placeholder strip instead. */
  consoleSkinned(): boolean;
  /** Resolve a `UI\war3skins.txt` skin KEY to its texture path, against the local player's
   *  race — the same lookup the FDF's `DecorateFileNames` does (ui/fdf/library.ts). The HUD
   *  names the console's widget art by key so that the four races' consoles differ where the
   *  game says they differ (the inventory cover) and share where it says they share (the
   *  queue border and the bars, which every race takes from `[Default]`). */
  skinPath(key: string): string;
  /** Debug cheat: top up gold/lumber/food, or toggle fast build/train. Returns
   *  the resulting on/off state (only meaningful for "fastbuild"). */
  cheat(kind: "gold" | "lumber" | "food" | "fastbuild"): boolean;
  /** Debug cheat on the current selection: refill HP/MP to full, or clear every
   *  ability + item cooldown, on each selected unit. */
  cheatSelected(kind: "hp" | "mp" | "cooldown"): void;
  /** Toggle the debug collider overlay (click/pathing/fog obstruction). Returns the
   *  resulting on/off state so the caller can show/hide the legend. */
  toggleColliders(): boolean;
  /** Toggle the "Show Pathing" overlay (pathing grid + moving units' routes).
   *  Returns the resulting on/off state so the caller can show/hide the legend. */
  togglePathing(): boolean;
  /** Toggle the "Show Regions" overlay (the map's named gg_rct_* trigger regions,
   *  outlined with a name label inside each). Returns the resulting on/off state. */
  toggleRegions(): boolean;
  /** Every hero unit type in the registry, for the "Spawn Hero" test dropdown:
   *  the raw type id (e.g. "Hpal"), its display name, and its race. */
  heroList(): Array<{ id: string; name: string; race: string }>;
  /** Debug: spawn `typeId` at the camera centre, maxed to level 6 with every skill at
   *  full rank and full mana — for casting a hero's whole kit on camera. */
  spawnTestHero(typeId: string): void;
}

/**
 * One socket of the minimap's BUTTON COLUMN — the small squares the console art punches to
 * the right of the minimap, counted from the top (0-based).
 *
 * Measured off `<Race>UITile01` with the same "transparent OR near-black" scan CONSOLE_ZONES
 * below was: four holes 42 texels wide (x 311…352) and 37 tall, on a 44-texel pitch (rows
 * 226, 270, 314, 358), with a ROUND socket under them at row 411 — five buttons in all, and
 * `UI\war3skins.txt` names exactly five: the signal (ping), terrain, ally-colour, creep-camp
 * and formation buttons. The circle is the ping's: its art is the only one of the five drawn
 * as a disc with a gold ring of its own.
 *
 * Times the tile's own 1 texel = 0.0005 world, y counted UP from row 512 — the same reading
 * every rect in CONSOLE_ZONES is (see its block comment for why the scan is not alpha alone).
 */
function minimapButtonSocket(index: number): { x: number; y: number; w: number; h: number } {
  const top = 226 + 44 * index; // first socket's top row, then the column's pitch
  return { x: 311 * 0.0005, y: (512 - (top + 37)) * 0.0005, w: 42 * 0.0005, h: 37 * 0.0005 };
}

/**
 * Where each widget goes in the console — the sockets the art leaves for it.
 *
 * These are the FDF's own coordinates, in the 0.8 × 0.6 space `ConsoleUI.fdf` is written in:
 * `x`/`w` measured from the console's left edge, `y`/`h` measured UP from the bottom of the
 * screen, the way every SetPoint in the file is. They are not guesses and not tuned by eye —
 * each rect is read straight off the decoded `<Race>UITile0*.blp` tiles, and they come out the
 * same for all four races because the four tile sets are drawn to one template.
 *
 * The tiles map to the band at exactly **1 texel = 0.0005 world** (tile 01/03/04 draw v
 * 0.3125…1 — texel rows 160…511 — into 0.176; tile 02 draws v 0.4140625…1 into 0.15; both are
 * 2000 texels per world unit, and the widths are 512 texels into 0.256). So a socket's rect
 * is `texel × 0.0005`, with y counted up from row 512.
 *
 * **A socket's window is NOT its transparent run.** The art punches its holes through as
 * `ALPHAKEY` transparency, but the TOP of several of them is painted opaque BLACK instead —
 * the minimap's window is transparent only from row 276 while the black it sits in starts at
 * row 220, and the command card's first cell row is black from row 245 and only turns
 * transparent at 276. Both read as one unbroken black window on screen, because the flat
 * black laid in behind the console (ui/consoleUi.ts `backing`) is the same colour as the
 * paint. Scanning for alpha alone undershoots the minimap by a third of its height and eats
 * the command card's whole first row (issues #90, #91); the scan that gives these numbers is
 * "transparent OR near-black", which is what actually reads as a hole.
 *
 *   minimap    texels x 19…296, rows 220…497 — a SQUARE window (0.139 × 0.139). A map whose
 *              playable area is not square letterboxes inside it, exactly as Blizzard's own
 *              `war3mapMap.blp` is a 256 × 256 square with the map letterboxed into it.
 *   portrait   the arch, x 431(tile01)…68(tile02), rows 289…448 — and BELOW it two more
 *              sections of the same socket, cut off by the art's own gold dividers at rows
 *              449…455 and 479…484. Those two are the HP and mana readouts (issue #92).
 *   command    texels x 209…549 (running on into tile 04), rows 245…499: four columns of 80
 *              and three rows of 81, on a pitch of 87 × 87 — square cells, which is the whole
 *              reason the console is held at 4:3 (ui/consoleUi.ts).
 *
 * The one thing the art cannot tell us is the inventory, whose six slots are painted dark
 * rather than cut out — but it DOES paint a gold frame around each pocket, and those frames
 * are as good as a cut socket: the block below is the box their gold centres bound (measured
 * on a 2560-wide window, where the frames sit on a 90 × 87-px pitch with each cell 77.5 px
 * square, so the six of them span 167.5 × 251.5). The gutters are INVENTORY_GAP.
 *
 * The `info` socket is the one place we are on our own: it is a single wide hole with no
 * internal divisions, so what goes IN it — the name, the XP bar, the stat lines, the build
 * queue — is laid out from `SimpleInfoPanel.fdf`'s relative anchors rather than from any
 * rect the art could give us. (The other deviation, holding the whole console at 4:3, is
 * `CONSOLE_OVERRIDES` in ui/consoleUi.ts.)
 */
const CONSOLE_ZONES = {
  minimap: { x: 0.0095, y: 0.0070, w: 0.1390, h: 0.1390 },
  /** The Ally Color Mode button, in the THIRD socket of the minimap's button column
   *  (`UI\TipStrings.txt` Tip12: "…the Toggle Minimap Ally Colors button to the right of
   *  the minimap"). See `minimapButtonSocket`. */
  allyColor: minimapButtonSocket(2),
  portrait: { x: 0.2157, y: 0.0320, w: 0.0747, h: 0.0795 },
  /** The first strip under the arch — the unit's hit points. */
  portraitHp: { x: 0.2157, y: 0.0165, w: 0.0747, h: 0.0115 },
  /** The second strip — mana. Left empty by the art when the unit has none. */
  portraitMana: { x: 0.2157, y: 0.0020, w: 0.0747, h: 0.0115 },
  info: { x: 0.3022, y: 0.0000, w: 0.2017, h: 0.1150 },
  inventory: { x: 0.5133, y: 0.0033, w: 0.0743, h: 0.1116 },
  command: { x: 0.6165, y: 0.0060, w: 0.1705, h: 0.1275 },
} as const;

/** The command card's gaps, as fractions of the card — the art's own 8-texel column gutters
 *  in 341 and 6-texel row gutters in 255. Expressed here rather than in CSS so the grid and
 *  the rect it fills come from one measurement. */
const COMMAND_GAP = { col: 8 / 341, row: 6 / 255 } as const;

/** The inventory's gutters, the same way: what the art leaves BETWEEN its six painted frames,
 *  as a fraction of the block they span (12.5 of 167.5 across, 9.5 of 251.5 down — the two
 *  differ because the art's own do). Cells then come out square without being told to, which
 *  is the check that the block above was measured right. */
const INVENTORY_GAP = { col: 12.5 / 167.5, row: 9.5 / 251.5 } as const;

/**
 * Where the inventory COVER goes — the crest the console wears in place of the six slots
 * when the selection has no inventory at all.
 *
 * Not a socket, so it is not one of the zones above: the cover is a whole texture, most of it
 * transparent, laid over that corner of the console. Its rect was solved by matching the blue
 * emblem inside the texture (u 0.3633…0.8438, v 0.5723…0.9160 of `<Race>UITile-InventoryCover`)
 * against the same emblem in a real 1.27a frame (x 0.5191…0.5798, y 0.0217…0.1092). The solve
 * lands on 0.1263 × 0.2545 — a ratio of 0.496 against the texture's own 256 × 512 — so the
 * game draws it UNSTRETCHED, which is the check that the fit is a real one and not two
 * measurements that happened to meet. It stands taller than the band; the overhang is the
 * texture's transparent top third.
 */
const CONSOLE_INVENTORY_COVER = { x: 0.4732, y: 0, w: 0.1263, h: 0.2545 } as const;

/** Is the keystroke going into a text field rather than at the game? */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** An FDF console rect → a percentage box of the console element, which is itself exactly the
 *  file's 0.8 × `CONSOLE_BAND_H`. The y flip is the FDF's bottom-up axis becoming CSS's
 *  top-down one; nothing else changes, so a percentage here IS an FDF coordinate. */
function place(el: HTMLElement, zone: { x: number; y: number; w: number; h: number }): void {
  el.classList.add("hud-zone");
  // Inline position so it wins over any component rule (e.g. .hud-command's
  // position:relative, which otherwise knocked the command card out of its zone).
  el.style.position = "absolute";
  el.style.left = `${(zone.x / UI_WIDTH) * 100}%`;
  el.style.top = `${((CONSOLE_BAND_H - (zone.y + zone.h)) / CONSOLE_BAND_H) * 100}%`;
  el.style.width = `${(zone.w / UI_WIDTH) * 100}%`;
  el.style.height = `${(zone.h / CONSOLE_BAND_H) * 100}%`;
}

// WC3 player colors by slot. Exported: a cinematic's speaker name is drawn in the colour of
// the player who owns the speaking unit (SetCinematicScene takes a playercolor), and that has
// to be the same palette the minimap dots use.
export const PLAYER_COLORS = [
  "#ff0303", "#0042ff", "#1ce6b9", "#540081", "#fffc01", "#fe8a0e",
  "#20c000", "#e55bb0", "#959697", "#7ebff1", "#106246", "#4e2a04",
];

// Marker sizes, as a fraction of the minimap widget's side. Measured off the real
// 1.27a client (its minimap is ~249px wide): a weak camp's dot spans ~3.2% of that,
// a gold-mine or house glyph ~4.5%. Ours draw ~1.4× those fractions — the client
// paints at native resolution, while this canvas is only MINIMAP_SIZE across and is
// then scaled up into the console frame, so the client's fractions come out mushy.
const CAMP_DOT = 0.045; // weak-camp diameter (× MinimapMiddleCampScale from level 10)
const MAP_GLYPH = 0.065; // gold-mine / neutral-building glyph side
const UNIT_DOT = 5; // unit dot, in dots-canvas pixels

// Console + tooltip chrome, straight out of the archives. Blizzard only ships the
// "Human" variant of these widget textures — every race's console draws them (same
// as the infocard-* icons below), so the path is not race-qualified.
//
//  · human-activebutton.blp   the green glow border a command button wears while it
//                             is highlighted or armed (issue #50). Solid black in the
//                             middle, so it composites additively (`screen`) over the
//                             icon and only the rim lights up.
//  · human-tooltip-*.blp      the tooltip slab: a flat translucent slate fill and a
//                             gold border shipped as an 8-tile 128×16 strip.
//  · ToolTip*Icon.blp         the cost-row icons (this is why they exist — they are
//                             NOT the top-bar resource icons).
const ACTIVE_BUTTON = "UI\\Widgets\\Console\\Human\\CommandButton\\human-activebutton.blp";
const TOOLTIP_BORDER = "UI\\Widgets\\ToolTips\\Human\\human-tooltip-border.blp";
const TOOLTIP_BACKGROUND = "UI\\Widgets\\ToolTips\\Human\\human-tooltip-background.blp";
const TOOLTIP_COST_ICON = {
  gold: "UI\\Widgets\\ToolTips\\Human\\ToolTipGoldIcon.blp",
  lumber: "UI\\Widgets\\ToolTips\\Human\\ToolTipLumberIcon.blp",
  supply: "UI\\Widgets\\ToolTips\\Human\\ToolTipSupplyIcon.blp",
  mana: "UI\\Widgets\\ToolTips\\Human\\ToolTipManaIcon.blp",
} as const;

// The floating status bar over a unit (issue #79). It is NOT the HPBarConsoleSmall model
// its folder name suggests — that pill-shaped thing is never drawn over a unit. The bar is
// a SIMPLESTATUSBAR frame, and war3skins.txt names its one texture: `SimpleHpBarConsole` (and
// `SimpleManaBarConsole`, same file) = UI\Feedback\HpBarConsole\human-healthbar-fill.blp.
//
// That texture is a 128×16 grey slab — a bright top row over a flat body over a darker
// bottom, with a faint barrel shade across its width. The engine multiplies it by the bar's
// colour and drops it inside a plain black frame; everything else is that frame showing
// through. Measured off the real 1.27a client (Warcraft III/Screenshots, 1424×720): a
// peasant's bar is 5 rows of fill inside a 1px top/bottom, 2px left/right black border, and
// its pixels come back 0,255,0 / 0,151,0 / … — the texture's own 255 / 151 / … rows times a
// PURE green. Hence the tints below.
const STATBAR_FILL = "UI\\Feedback\\HPBarConsole\\human-healthbar-fill.blp";

/**
 * The hero bar in the screen's top-left corner (issue #95) — one button per hero you own,
 * stacked downward in hire order, each with an HP and a mana bar under it.
 *
 * **It has no FDF.** `CGameUI` builds and places it in code: there is no HeroBar frame in any
 * `UI\FrameDef\` file, which is also what the community finds when it tries to move the
 * buttons (hiveworkshop "How to move top left hero buttons (ORIGIN_FRAME_HERO_BUTTON)" —
 * they stick to the left of the bar and distribute down it, and 7 is the most it holds).
 * So the geometry below is measured off a screenshot of the real client rather than read
 * out of a file: the reference image on issue #95, whose one button comes out
 *
 *     button   69 × 68 px, 3 px in from the screen's left edge
 *     bars     72 × 17 px starting 1 px under it — 1 px black frame, a 6 px HP bar,
 *              a 2 px gap, a 6 px mana bar
 *
 * Those are pixels at **1080p**, which is what the shot has to be: the vertical pitch they
 * imply (85 px) has to fit the bar's seven slots between the top strip and the middle of the
 * screen, and only a 1080-tall capture does (595 px = 55% of the height; at 720 the seventh
 * hero would be down in the console). Expressed here as a fraction of the 0.6-tall UI space
 * so the bar scales with the window like the rest of the console.
 *
 * The one number NOT in that shot is the gap between two buttons — it holds a single hero.
 * The stack gap below is eyeballed to keep the stack reading as separate buttons.
 *
 * **One slot, one number.** The icon and the bars under it are the SAME width — they share
 * the slot, so their edges line up — and every other length in the widget (bar heights, the
 * frame bevel, the stack pitch) is a fraction of that one width, written out in `style.css`
 * against the measured 72 px. So `HERO_BAR.slot` is the only knob: change it and the whole
 * hero bar scales as a piece. The reference bars are 72 px wide and its button 68; we draw
 * the slot at 76 so the portrait reads a little bigger than the real client's (a deliberate,
 * developer-asked deviation — the one place this widget departs from the shot).
 */
const HERO_PX = UI_HEIGHT / 1080; // one screen pixel of the reference capture, in world units
const HERO_BAR = {
  left: 3 * HERO_PX,
  top: 0.032 + 2 * HERO_PX, // clear of the upper button bar's strip (ConsoleUI.fdf: 0.032 tall)
  slot: 76 * HERO_PX, // icon width = bars width = the slot; everything else scales off it
  max: 7, // the most buttons the real bar holds
} as const;

/** The one texture `UI\Feedback\Autocast\UI-ModalButtonOn.mdx` draws — the spark its four
 *  corner emitters chase around a button that is standing ON. See ui/modalButtonFx.ts, which
 *  is where the rest of that model lives. */
const MODAL_SPARK = "Textures\\HeroLevel-Particle.blp";

/** The second texture `UI\Buttons\HeroLevel\HeroLevel.mdx` draws — the soft ring its one
 *  quad wears around a portrait whose hero has a skill point waiting. The model's OTHER
 *  texture is the spark above, the same file both models emit. See ui/heroLevelFx.ts. */
const HERO_LEVEL_RING = "UI\\Buttons\\HeroLevel\\HeroLevel-Border.blp";

// The console's own widget art, named by `UI\war3skins.txt` KEY rather than by path so the
// per-race entries take effect (the inventory cover is the one the four races differ on).
// These are the keys the engine's SIMPLESTATUSBAR / backdrop frames use, out of the same
// table `DecorateFileNames` reads:
//
//   BuildQueueBackdrop            human-unitqueue-border.blp    the whole training-queue
//                                                               widget: one big slot for the
//                                                               unit in progress and six
//                                                               numbered ones for the queue
//   SimpleXpBarBorder / …Console  human-xpbar-border.blp        the hero XP bar — a gold
//                                 human-bigbar-fill.blp         frame over a grey fill the
//                                                               engine tints
//   SimpleProgressBar*            the SAME two files            the timed-life / summon bar
//   SimpleBuildTimeIndicator(Border)                            the build/train progress bar;
//                                 human-buildprogressbar-*.blp  its fill ships already gold
//   ConsoleInventoryCoverTexture  <Race>UITile-InventoryCover   the crest over the 2×3 when
//                                                               the selection has no inventory
//   CommandButtonNumberOverlay    human-button-lvls-overlay.blp the boxed number in an
//                                                               icon's corner — see countBadge
const CONSOLE_ART = {
  queueBorder: "BuildQueueBackdrop",
  bigBarBorder: "SimpleXpBarBorder",
  bigBarFill: "SimpleXpBarConsole",
  buildBarBorder: "SimpleBuildTimeIndicatorBorder",
  buildBarFill: "SimpleBuildTimeIndicator",
  inventoryCover: "ConsoleInventoryCoverTexture",
  numberOverlay: "CommandButtonNumberOverlay",
} as const;

/** What the engine tints `human-bigbar-fill.blp` with, read off the models that draw the
 *  same bars in 3D: `XpBarConsole.mdx`'s geoset colour for the hero XP bar, `TimerBar.mdx`'s
 *  for the timed-life one a summon counts down on. (The build bar needs no entry — its own
 *  fill texture ships gold rather than grey.) */
const BIGBAR_TINT = {
  xp: [139, 0, 131],
  timer: [65, 130, 210],
} as const;

/** The colour each bar multiplies the fill texture by. Green is measured (see above), so
 *  yellow and red are the engine's matching primaries. 1.27a floats no mana bar at all, so
 *  its blue has no measurement to match — this is the value the game's own mana art carries,
 *  ManaBarConsoleSmall.mdx's geoset colour (0.0627, 0, 0.9020). */
const STATBAR_TINT = {
  green: [0, 255, 0],
  yellow: [255, 255, 0],
  red: [255, 0, 0],
  mana: [16, 0, 230],
} as const;

/** Multi-selection grid tiers (issue #109). WC3's own selection stops at 12 units and draws
 *  them as one row of large icons; OpenWar3 lifts the cap, so instead of refusing units the
 *  grid steps down a tier every 12: the columns go up, the icons and their bars shrink, and the
 *  same panel space holds four times as many. Past the last tier the final visible slot carries
 *  a "+N" badge counting the units that aren't drawn. `cols` is what the CSS grid uses; `bar` is
 *  the FILL height (px) of one of the two stat bars under an icon, which has to come down with
 *  the icon or a 12-column icon would be more bar than art. The largest tier's 5 is STATBAR_ROWS
 *  — the number of fill rows the client shows in a bar floating over a unit — so a big group
 *  icon's bar is the same art at the same size as the one over that unit's head. */
const SEL_GRID_TIERS = [
  { max: 12, cols: 6, bar: 5, gap: 4 },
  { max: 24, cols: 8, bar: 4, gap: 3 },
  { max: 36, cols: 10, bar: 3, gap: 2 },
  { max: 48, cols: 12, bar: 2, gap: 2 },
] as const;
/** How many icons the grid can ever draw — the largest tier. Everything past this is a "+N". */
const SEL_GRID_MAX = SEL_GRID_TIERS[SEL_GRID_TIERS.length - 1].max;

// The tooltip border strip is 8 square tiles laid out left-to-right, in the order
// the engine's BACKDROP frames name them (UI\FrameDef\Glue\BattleNetChatActionMenu.fdf
// draws the identical bnet-tooltip-border with BackdropCornerFlags "UL|UR|BL|BR|T|L|B|R"):
// left, right, top, bottom, then the four corners. The two horizontal edges are
// stored as VERTICAL bars and the engine rotates them a quarter-turn clockwise —
// re-slice the strip into a 3×3 nine-patch CSS can drive with `border-image`.
/**
 * The on-screen message area — the engine's **WorldFrameUnitMessage**, which `UI\MiscUI.txt`
 * [FontHeights] describes in its own words as "small text that is used for in-game trigger
 * based dialog": what `DisplayTextToPlayer` / `DisplayTimedTextToPlayer` write, and what
 * `ClearTextMessages` wipes. It is NOT the upper-left corner — that was our guess, and it is
 * wrong; every number below is either the game's own or measured off a shot of the real
 * client (Azure Glade Tower Defense's welcome message, 16:9), and all of them are fractions
 * of the 0.6-tall UI space so the block scales with the frame like the console does.
 *
 * Three of the four `WorldFrame*Message` frames are separate things; keep them straight:
 * `WorldFrameMessage` is the one gold line above the console (`showError`), `WorldFrameTop-
 * Message` is the big upkeep text under the clock, and this one is the trigger dialog.
 *
 * `left` is measured from the left edge of the file's 0.8-wide box, not from the screen —
 * in the 16:9 shot the text sits 0.184 of a UI space in from the screen's edge, which is
 * 0.05 in from where the centred 0.8 box begins (the same box the console is held in).
 *
 * `bottom` is the bottom of the BLOCK, not of the first line: the stack is pinned there and
 * grows UPWARD, newest line at the bottom. That is what keeps the chat entry line at one
 * fixed spot in the real game no matter how much has been said, which it plainly does.
 */
const MSG_AREA = {
  left: 0.05, // from the 0.8 box's left edge
  bottom: 0.255, // above the bottom of the frame
  width: 0.5, // where a long line wraps (the shot wraps between 0.491 and 0.517)
} as const;

/**
 * The in-game CHAT display — a **different frame from the message area above**, and that is
 * the whole point of this block.
 *
 * The engine says so twice over. `Game.dll` has `.\CChatDisplay.cpp` sitting next to
 * `.\CMessageFrame.cpp` (docs/reverse-engineering/game-dll-thread.md), and the frame natives
 * expose the two separately: `ORIGIN_FRAME_CHAT_MSG` is what a map hides to silence player
 * chat while trigger text keeps coming (hiveworkshop "Hiding ingame chat", thread 321746),
 * and `ORIGIN_FRAME_UNIT_MSG` is the trigger dialog. We had chat and trigger text sharing one
 * DOM column, so a line of chat SHOVED the map's own messages up the screen — which the real
 * client never does, because the two stacks do not know about each other.
 *
 * Where it goes: down the game frame's LEFT edge, resting just above the idle-worker button,
 * and — like the message area — pinned by its BOTTOM so the stack grows upward and the newest
 * line stays at one fixed spot. No file states this position: like the hero bar and the chat
 * entry line, the chat display is one of `CGameUI`'s programmatic frames and no .fdf declares
 * it. So this is the developer's call rather than a measurement, written here as two numbers
 * so it can be moved in one place if a capture of the real client ever settles it.
 *
 * It may well overlap the message area once both stacks are deep, and that is fine — they are
 * two frames drawn over the same world, not two halves of one column. What must never happen
 * again is one of them MOVING the other.
 *
 * `left` is measured from the SCREEN's left edge (not the 0.8 box's), because hard left is the
 * point of it. It is far enough left to run down the hero bar's own column (which ends at
 * `HERO_BAR.left + HERO_BAR.slot` ≈ 0.044) — asked for, and the same trade as the overlap
 * with the message area: a hero's portrait may end up behind a line of chat.
 */
const CHAT_AREA = {
  left: 0.022, // hard against the frame's edge, hero bar or no hero bar
  /** Clear of the idle-worker button — the one thing standing in this strip. `style.css` hangs
   *  it 42 px above the minimap socket and draws it 68 px tall (1080p pixels, the same unit the
   *  hero bar is stated in), and the socket's own top is where `ConsoleUI.fdf` puts it; the
   *  90 px on top of that is how far above the button the lowest line of chat rides. */
  bottom: CONSOLE_ZONES.minimap.y + CONSOLE_ZONES.minimap.h + (42 + 68 + 90) * HERO_PX,
  width: 0.42, // where a long line wraps
} as const;

/**
 * `UI\MiscUI.txt` **[FontHeights]**, by its own keys — the sizes for the frames the engine
 * builds in code rather than out of a .fdf, which is why they are in a text file at all
 * ("To change the font height of a frame created in the FrameDef files, you will need to
 * look in the appropriate .fdf file"). All four are fractions of the 0.6-tall UI space, so
 * each becomes a length off --stage-h and none of them is a pixel count.
 */
const FONT_HEIGHTS = {
  /** "single line of error text that appears above the console" — the gold refusal line. */
  WorldFrameMessage: 0.015,
  /** "small text that is used for in-game trigger based dialog" — the message area. */
  WorldFrameUnitMessage: 0.015,
  /** "in-game chat text" — what a received chat line is drawn at, in that same area. */
  WorldFrameChatMessage: 0.013,
  /** "chat edit bar text" — the line being typed. */
  ChatEditBar: 0.013,
} as const;

/** A length stated in the game's 0.6-tall UI space, as CSS that scales with the game frame
 *  (--stage-h IS that 0.6) rather than a pixel count that only holds on one monitor. */
const uiPx = (v: number): string => `calc(var(--stage-h) * ${v / UI_HEIGHT})`;

/**
 * The chat ENTRY line — the box the player types into, prompted "Message:" / "To All:".
 *
 * It is not part of the message column, which is what we had assumed: in the real client it
 * is a box of its own, **centred** on the frame and sitting on the console's top edge, while
 * the messages stay over on the left. Measured off a shot of the real client (a single-player
 * match, so the prompt is `COLON_MESSAGE_SINGLEPLAYER`), scaled by the minimap socket the
 * console art punches (CONSOLE_ZONES.minimap, 0.139 wide) and expressed in the same 0.6-tall
 * UI space as everything else here:
 *
 *   • 0.4 wide — exactly half the console's 0.8 — with its edges landing on 0.201 and 0.603
 *     of that box, i.e. centred to within a measuring error.
 *   • its bottom edge at 0.142, which is where the console's MIDDLE slice stops being drawn
 *     (ConsoleUI.fdf gives that slice `Height 0.15`, and its top texels fade out) — so the
 *     box rests on the console rather than floating over it.
 *
 * The art is the tooltip backdrop: `war3skins.txt` has no chat-edit-box key at all, and the
 * frame is one of `CGameUI`'s programmatic ones (no .fdf declares it), so it borrows
 * `ToolTipBorder` + `ToolTipBackground` — `human-tooltip-border.blp` and its background twin.
 * Despite the name those are not per-race: both keys live in war3skins' **[Default]** section
 * and no race section overrides them, so every race types into the human frame.
 */
const CHAT_BAR = {
  width: 0.4,
  height: 0.029,
  bottom: 0.142,
  border: 0.004, // the gold frame's drawn thickness
  padX: 0.004, // the prompt's inset from the frame (measured: 6px of a 1532 px/unit shot)
} as const;

// On-screen message log tuning.
const MSG_MAX = 16; // max lines kept on screen at once (WC3 scrolls the oldest off)
// The chat display holds fewer: it starts low on the screen (CHAT_AREA) and grows up, so a
// deep stack climbs towards the top of the frame instead of scrolling off it.
const CHAT_MAX = 8;
const MSG_DEFAULT_SECS = 12; // how long an untimed DisplayTextToPlayer line lingers
const ERROR_SECS = 2.5; // how long the gold command-error line above the console holds

/** Escape HTML, then translate WC3 text colour codes to spans: `|cAARRGGBB…|r`
 *  wraps a coloured run (alpha ignored), `|n`/`|N` is a line break, `||` a literal
 *  pipe. Anything malformed is left as text. Any spans left open are closed. */
function formatColorCodes(text: string): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = "";
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "|" && i + 1 < text.length) {
      const n = text[i + 1];
      if (n === "|") { out += "|"; i += 1; continue; }
      if (n === "n" || n === "N") { out += "<br>"; i += 1; continue; }
      if (n === "r" || n === "R") { if (open > 0) { out += "</span>"; open--; } i += 1; continue; }
      if ((n === "c" || n === "C") && i + 9 < text.length) {
        const hex = text.slice(i + 2, i + 10);
        if (/^[0-9a-fA-F]{8}$/.test(hex)) {
          out += `<span style="color:#${hex.slice(2)}">`;
          open++;
          i += 9;
          continue;
        }
      }
    }
    out += esc(ch);
  }
  while (open-- > 0) out += "</span>";
  return out;
}

const BORDER_TILE = 16;
function sliceTooltipBorder(strip: HTMLCanvasElement): string | null {
  if (strip.width < BORDER_TILE * 8 || strip.height < BORDER_TILE) return null;
  const out = document.createElement("canvas");
  out.width = out.height = BORDER_TILE * 3;
  const ctx = out.getContext("2d")!;
  const tile = (index: number, dx: number, dy: number, rotate = false): void => {
    ctx.save();
    ctx.translate(dx, dy);
    if (rotate) {
      ctx.translate(BORDER_TILE, 0); // quarter-turn clockwise about the tile's centre
      ctx.rotate(Math.PI / 2);
    }
    ctx.drawImage(strip, index * BORDER_TILE, 0, BORDER_TILE, BORDER_TILE, 0, 0, BORDER_TILE, BORDER_TILE);
    ctx.restore();
  };
  tile(4, 0, 0); // upper-left        tile(2, top)        tile(5, upper-right)
  tile(2, BORDER_TILE, 0, true);
  tile(5, BORDER_TILE * 2, 0);
  tile(0, 0, BORDER_TILE); // left     (centre stays clear) tile(1, right)
  tile(1, BORDER_TILE * 2, BORDER_TILE);
  tile(6, 0, BORDER_TILE * 2); // bottom-left  tile(3, bottom)  tile(7, bottom-right)
  tile(3, BORDER_TILE, BORDER_TILE * 2, true);
  tile(7, BORDER_TILE * 2, BORDER_TILE * 2);
  return out.toDataURL();
}

/** The number on a cooldown sweep — an ability's, an item's, or a shop ware's restock. WC3
 *  counts them all down in WHOLE seconds, and rounds UP, so a fresh 20s cooldown reads "20"
 *  and the last tick reads "1" (never "0.4"). One rule for every sweep on the HUD. */
function cdSeconds(secondsLeft: number): string {
  return String(Math.ceil(secondsLeft));
}

/**
 * A count badge: the boxed number WC3 stamps into the bottom-right corner of an icon
 * whenever that icon stands for a QUANTITY of something — an item's charges, a shop's stock,
 * a mercenary camp's, the unspent skill points on the hero-bar portrait and on the
 * learn-skill button that opens the ability list.
 *
 * The box is the game's own art, and it is one art for all of them: `UI\war3skins.txt`
 *
 *     CommandButtonNumberOverlay=UI\Widgets\Console\Human\CommandButton\human-button-lvls-overlay.blp
 *
 * a 32×32 texture whose opaque part is a gold frame around a translucent black fill, inset
 * 3-4 texels from every edge — the frame's own padding is what holds it off the icon's
 * corner, so nothing here offsets it. Named by KEY rather than by path, like the rest of
 * `CONSOLE_ART`, so a skin's override applies.
 *
 * **Its size is a texel count, not a taste call.** The overlay is 32 texels square and the
 * command button it sits on is 64, so drawn at its own resolution the box is exactly HALF
 * the button — which is what `.hud-count-badge` is written as. Its opaque frame is then
 * 26/64 across and 24/64 tall, and its centre lands dead in the middle of the box, which is
 * why the numeral is simply centred in it.
 *
 * The inner span is what carries the number: the box has to be able to hide itself when
 * there is nothing to count (an empty gold frame is not something the game ever draws), and
 * a bare `textContent` write on the box would take its background with it. Use `setCount`.
 */
function countBadge(): HTMLSpanElement {
  const box = document.createElement("span");
  box.className = "hud-count-badge";
  box.hidden = true;
  box.appendChild(document.createElement("span"));
  return box;
}

/** Put `text` in a `countBadge`, hiding the whole box when there is nothing to say. */
function setCount(box: HTMLElement, text: string): void {
  box.firstElementChild!.textContent = text;
  box.hidden = text === "";
}

/** Past this, a pool prints as the CURRENT value alone. See `poolReadout`. */
const POOL_PAIR_MAX = 9999;

/**
 * One of the two numbers under the portrait — hit points, or mana.
 *
 * The strips the console art cuts out below the arch (issue #92) are only as wide as the arch
 * itself, which is about seven glyphs at the size the game draws them in. "current / max" fits
 * every melee pool there is (the deepest in the game is the Castle's 2200 HP), so that is the
 * form the readout wears. A custom map's 1500000-HP boss does not fit: the pair wrapped onto a
 * second line and spilled down over the mana strip (issue #99). Past four digits we drop the
 * "/ max" half and print the current value alone — the half that moves, and the half a player
 * is reading. Gated on `max`, not on `cur`, so a unit at full and the same unit at a sliver
 * read the same way instead of the label changing shape as it takes damage.
 *
 * `cur` comes in already rounded, because the two pools round opposite ways: HP ceils (a unit
 * with anything left alive never reads "0") and mana floors (a spell you cannot afford yet
 * never reads as affordable).
 */
function poolReadout(cur: number, max: number): string {
  if (max <= 0) return "";
  return max > POOL_PAIR_MAX ? String(cur) : `${cur} / ${max}`;
}

/** How many rows of fill the client shows inside the frame, and so how many the slab is
 *  point-sampled down to here. Its 16 rows are two of white over twelve of flat grey over
 *  two dark ones; squeezed into a 5px bar by a smooth resize, the white pair averages away
 *  and the bar loses the lit top edge the client has. Sampling instead of blending keeps it
 *  — 255 / 151 / 151 / 152 / 91, against the client's measured 255 / 151 / 151 / 151 / 142. */
const STATBAR_ROWS = 5;

/**
 * Multiply a grey bar-fill texture by one bar colour — the whole of what the engine does to
 * every bar it draws, from the slabs floating over units to the hero's XP bar.
 *
 * `rows` is how tall to bake it. Only the floating status bar needs it: its slab is squeezed
 * into five screen pixels, and a smooth resize there averages the white top pair away (see
 * STATBAR_ROWS). Everything else keeps the texture's own height.
 */
function bakeStatBarFill(fill: HTMLCanvasElement, tint: readonly number[], rows = fill.height): string {
  const w = fill.width;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = rows;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(fill, 0, 0, w, rows);
  const img = ctx.getImageData(0, 0, w, rows);
  for (let i = 0; i < img.data.length; i += 4) {
    for (let k = 0; k < 3; k++) img.data[i + k] = (img.data[i + k] * tint[k]) / 255;
  }
  ctx.putImageData(img, 0, 0);
  return out.toDataURL();
}

/** The tooltip fill is a flat colour stored as a 64×64 texture — read its one pixel
 *  rather than hardcoding it. (1.27a: rgba(24, 34, 49, 195).) */
function tooltipFill(bg: HTMLCanvasElement): string | null {
  const p = bg.getContext("2d")!.getImageData(0, 0, 1, 1).data;
  return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${(p[3] / 255).toFixed(3)})`;
}

/** Crop war3mapMap.blp down to the map itself.
 *
 *  The World Editor always writes a SQUARE minimap image (256×256 in every 1.27a
 *  melee map) with the map contain-fitted into it and the leftover margins left
 *  fully transparent. Verified against the real maps: (2)BootyBay is 193×97 tiles
 *  (2:1), and its alpha goes solid at y=64 = (256 − 256/2) / 2; (2)PlunderIsle is
 *  97×129 (3:4) and goes solid at x=32 = (256 − 256·3/4) / 2. So the margins are
 *  exactly the letterbox, and cropping them leaves a canvas whose aspect equals
 *  the map's — which lets the dots canvas and the click→pan mapping share one
 *  rect with the picture. */
function cropMinimapLetterbox(src: HTMLCanvasElement, aspect: number): HTMLCanvasElement {
  const sw = aspect >= 1 ? src.width : Math.round(src.width * aspect);
  const sh = aspect >= 1 ? Math.round(src.height / aspect) : src.height;
  if (sw >= src.width && sh >= src.height) return src; // square map: no letterbox
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  const sx = (src.width - sw) / 2, sy = (src.height - sh) / 2;
  out.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

// WC3 maps the 2×3 inventory onto the numpad's matching 2×3 block: 7/8 top, 4/5
// middle, 1/2 bottom. Drives both the hotkeys and the tooltip's "(NumPad 7)" hint.
const INVENTORY_NUMPAD: readonly number[] = [7, 8, 4, 5, 1, 2];

/** The drag payload an inventory slot puts on the clipboard when it is dragged out of the
 *  pockets — the slot index, and nothing else; where it is DROPPED decides what happens. A
 *  custom MIME type rather than "text/plain" so a stray drag from elsewhere in the page (a
 *  chat selection) can never be mistaken for an item. */
const INV_DRAG_TYPE = "application/x-openwar3-item-slot";

const MINIMAP_SIZE = 168; // px along the minimap canvas's LONGEST side
const DOTS_PERIOD = 100; // ms between minimap dot redraws
const TEXT_PERIOD = 250; // ms between resource/info text refreshes

export class GameHud {
  private root: HTMLDivElement;
  private selName!: HTMLDivElement;
  private selSub!: HTMLDivElement; // "Level N" (heroes)
  private xpBar!: HTMLDivElement; // hero XP / summon-timer track
  private xpFill!: HTMLDivElement;
  private xpText!: HTMLDivElement; // "Level N  into/span" or "Summoned Unit (Ns)" — inside the bar
  private selStats!: HTMLDivElement;
  private attackStat!: StatBlock;
  private armorStat!: StatBlock;
  private attrIconEl!: HTMLDivElement; // single icon (the hero's primary attribute)
  private attrLines!: HTMLDivElement;
  private strLine!: HTMLDivElement;
  private agiLine!: HTMLDivElement;
  private intLine!: HTMLDivElement;
  private selStatus!: HTMLDivElement; // buff/aura/debuff status icons row
  private selStatusSlots: HTMLDivElement[] = [];
  private selHpText!: HTMLDivElement;
  private selMpText!: HTMLDivElement;
  private selCarry!: HTMLDivElement;
  private selDesc!: HTMLDivElement; // item description shown when a ground item is selected
  private selGrid!: HTMLDivElement; // multi-selection icon grid
  private selGridSlots: HTMLButtonElement[] = [];
  private selGridBars: Array<{
    art: HTMLDivElement;
    hp: HTMLDivElement;
    manaTrack: HTMLDivElement;
    mana: HTMLDivElement;
    more: HTMLSpanElement;
  }> = [];
  // Construction / training progress display.
  private progressWrap!: HTMLDivElement;
  private statusIcon!: HTMLDivElement;
  private builderBtn!: HTMLButtonElement; // the peon inside a structure under construction
  private statusLabel!: HTMLDivElement;
  private progressFill!: HTMLDivElement;
  private queueRow!: HTMLDivElement;
  private queueSlots: HTMLDivElement[] = [];
  private queueTrainable = false; // status icon shows a cancellable training job (not construction)
  private portrait!: HTMLDivElement;
  private portraitCanvasEl!: HTMLCanvasElement;
  private dotsCanvas!: HTMLCanvasElement;
  // Minimap frame (the console zone) and the map picture contain-fitted inside it.
  private minimapBox?: HTMLDivElement;
  private minimapView?: HTMLDivElement;
  private minimapResize?: ResizeObserver;
  private minimapAspect = 1; // map width / height
  private mmW = MINIMAP_SIZE; // dots-canvas backing store, sized to the map's aspect
  private mmH = MINIMAP_SIZE;
  private camRect?: HTMLDivElement; // the white camera box over the map picture (#112)
  private minimapDrag: number | null = null; // pointerId of a held left-press dragging the camera
  /** The Ally Color Mode button in the socket right of the minimap (buildAllyColorButton).
   *  Absent with no install mounted: the socket is part of the console ART. */
  private allyColorBtn?: HTMLButtonElement;
  private idleWorkerBadge!: HTMLButtonElement;
  private idleWorkerCount!: HTMLSpanElement;
  /** The hero bar's seven slots (issue #95), built once and shown per living hero. */
  private heroSlots: Array<{
    slot: HTMLDivElement;
    btn: HTMLButtonElement;
    fx: HTMLCanvasElement;
    points: HTMLSpanElement;
    bars: HTMLDivElement;
    hp: HTMLDivElement;
    mana: HTMLDivElement;
    hpFill: HTMLDivElement;
    manaFill: HTMLDivElement;
  }> = [];
  private idleIconSet = false; // worker icon lazily applied once
  private cmdTooltip!: HTMLDivElement; // the ONE tooltip slab, above the command card
  private invHover = -1; // inventory slot under the cursor (-1 = none), so its tooltip can refresh
  private buffHover = -1; // Status-line slot under the cursor, so an expiring buff drops its tooltip
  private cmdSlots: HTMLButtonElement[] = [];
  private cmdLabels: HTMLSpanElement[] = []; // per-slot fallback text (icon-less buttons)
  private cmdCdOverlay: HTMLDivElement[] = []; // per-slot radial cooldown sweep
  private cmdCdText: HTMLSpanElement[] = []; // per-slot cooldown seconds count
  private cmdCount: HTMLSpanElement[] = []; // per-slot corner count badge (skill points)
  private cmdKey = "";
  // Hero inventory: 6 slot buttons (2×3) with icon, charge badge, cooldown sweep.
  private invSlots: HTMLButtonElement[] = [];
  private invCount: HTMLSpanElement[] = []; // per-slot charge count badge
  private invCdOverlay: HTMLDivElement[] = []; // per-slot radial cooldown sweep
  private invCdText: HTMLSpanElement[] = []; // per-slot cooldown seconds count
  private invKey = "";
  /** The `UI-ModalButtonOn.mdx` sparkle, simulated once and blitted onto every lit button. */
  private modalFx!: ModalButtonFx;
  /** …and `HeroLevel.mdx`, the hero bar's own — a different model for a different job
   *  (war3skins `HeroBarPointModel` vs `CommandButtonAutocast`). See ui/heroLevelFx.ts. */
  private heroLevelFx!: HeroLevelFx;
  private cmdFx: HTMLCanvasElement[] = []; // per command slot, shown while the button is on
  /** The crest drawn over the six slots when the selection has no inventory. */
  private invCover!: HTMLDivElement;
  private dotsT = 0;
  private textT = TEXT_PERIOD; // render immediately on first frame
  private lastSelId: number | null = null; // force a text refresh when selection changes
  // On-screen message area (the "Game - Display text" trigger action target) — the map's own
  // lines, oldest scrolling off the top. Chat is NOT in here; see chatLog.
  private msgLog!: HTMLDivElement;
  // The in-game chat display (CChatDisplay / ORIGIN_FRAME_CHAT_MSG) — its own stack in its own
  // corner, so a line of chat never moves the map's messages. See CHAT_AREA.
  private chatLog!: HTMLDivElement;
  // The chat entry line under the message column (WC3 draws this one in engine code, not FDF).
  private chatBar!: HTMLDivElement;
  private chatPromptEl!: HTMLSpanElement;
  private chatInput!: HTMLInputElement;
  private chatTarget: ChatTarget = { scope: "all" };
  private questsBtn?: HTMLButtonElement; // glows on FlashQuestDialogButton until pressed
  /** Who plain Enter talks to, once somebody has SAID so — the F12 dialog (ui/chatDialog.ts),
   *  whose whole job is choosing this, or a Tab in the entry line. Null until then, which is
   *  not the same as "all": with nothing chosen the audience follows the alliances, and a
   *  player who has allies is addressing them by default (`defaultChatTarget`). */
  private chatDefault: ChatTarget | null = null;
  private msgTimers = new Set<number>(); // pending auto-remove timeouts, cleared on dispose
  private chatTimers = new Set<number>(); // the same, for the chat display's own lines
  // The gold error line just above the console (WC3's SimpleMessage frame).
  private errLine!: HTMLDivElement;
  private errTimer = 0;

  constructor(parent: HTMLElement, private driver: HudDriver) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    // The sparkle every "standing on" button wears — an autocast toggled on, a hero with a
    // skill point waiting. Built before the console and the hero bar because both hang their
    // overlays off it, and told once where its texture is.
    this.modalFx = new ModalButtonFx(driver.blpCanvas(MODAL_SPARK));
    // …and how far past a button's edge that effect reaches, so the stylesheet can inset the
    // overlay by the model's own geometry instead of a number typed twice.
    this.root.style.setProperty("--modal-fx-overhang", `${(MODAL_FX_OVERHANG * 100).toFixed(3)}%`);
    // The hero bar's indicator is a MODEL OF ITS OWN, not the same sparkle scaled: a pulsing
    // gold ring around the portrait with sparks spilling off all four of its edges. Same two
    // steps — build it with its textures, hand its overhang to the stylesheet.
    this.heroLevelFx = new HeroLevelFx(driver.blpCanvas(MODAL_SPARK), driver.blpCanvas(HERO_LEVEL_RING));
    // Unitless, not a percentage: the overlay is a SIBLING of the portrait rather than a child
    // of it (it draws behind), so it has no percentage box of its own to be inset from and the
    // stylesheet multiplies this by `--hero-btn` instead.
    this.root.style.setProperty("--herolevel-fx-overhang", HERO_LEVEL_FX_OVERHANG.toFixed(5));
    // The four font heights `UI\MiscUI.txt` states for the frames the engine builds in code,
    // handed to the stylesheet as lengths (FONT_HEIGHTS). On the ROOT because the frames that
    // read them are siblings, not one widget.
    for (const [key, height] of Object.entries(FONT_HEIGHTS)) {
      this.root.style.setProperty(`--font-${key}`, uiPx(height));
    }
    const skin = driver.consoleSkinned();
    this.root.append(
      this.buildConsole(skin),
      this.buildHeroBar(),
      this.buildCheatPanel(),
      this.buildMessageLog(),
      this.buildChatLog(),
      this.buildChatBar(),
      this.buildErrorLine(),
    );
    parent.appendChild(this.root);
    this.applyWidgetSkin();
    window.addEventListener("keydown", this.onKey);
    // Keyup and blur are NOT gated the way `onKey` is (hidden console, open dialog, typing):
    // whatever swallows the press, a hold that has already begun must always be released.
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.endFollow);
    this.unwatchPress = watchPress();
  }

  /** Takes the console's press watcher back off `window` — see `watchPress`. */
  private unwatchPress: () => void = () => {};

  /** Hand the real console/tooltip textures to the stylesheet as custom properties.
   *  Each is optional: without a mounted install the CSS keeps its own placeholder
   *  chrome, so the `.skinned` classes gate every rule that needs the art. */
  private applyWidgetSkin(): void {
    const active = this.driver.blpUrl(ACTIVE_BUTTON);
    if (active) {
      this.root.style.setProperty("--hud-activebutton", `url(${active})`);
      this.root.classList.add("hud-activebutton-skinned");
    }
    const strip = this.driver.blpCanvas(TOOLTIP_BORDER);
    const border = strip ? sliceTooltipBorder(strip) : null;
    const bg = this.driver.blpCanvas(TOOLTIP_BACKGROUND);
    const fill = bg ? tooltipFill(bg) : null;
    if (border && fill) {
      // Lift these to :root (not just the HUD root) so the world-space hover slab —
      // which lives in ui/stage.ts's world layer, a separate DOM subtree — is skinned
      // by the same nine-patch as the command-card tooltip. The body class gates the
      // hover slab's `.skinned` look purely in CSS, so rts.ts needn't know about art.
      document.documentElement.style.setProperty("--hud-tooltip-border", `url(${border})`);
      document.documentElement.style.setProperty("--hud-tooltip-fill", fill);
      document.body.classList.add("hud-tooltip-skinned");
      this.cmdTooltip.classList.add("skinned");
    }
    this.applyStatBarSkin();
    this.applyConsoleWidgetSkin();
  }

  /** Hand the console's widget art to the stylesheet: the training-queue border, the two
   *  progress-bar frames, the tinted big-bar fills and the inventory cover. All of it is
   *  named by war3skins KEY (`CONSOLE_ART`) so the race sections apply. */
  private applyConsoleWidgetSkin(): void {
    const url = (key: string): string | null => this.driver.blpUrl(this.driver.skinPath(key));
    const queue = url(CONSOLE_ART.queueBorder);
    const barBorder = url(CONSOLE_ART.bigBarBorder);
    const barFill = this.driver.blpCanvas(this.driver.skinPath(CONSOLE_ART.bigBarFill));
    if (!queue || !barBorder || !barFill) return; // no install: the CSS placeholders stand
    const root = document.documentElement.style;
    root.setProperty("--hud-queue-border", `url(${queue})`);
    root.setProperty("--hud-bigbar-border", `url(${barBorder})`);
    // The big-bar fill ships grey, for the engine to multiply by whichever bar is using it —
    // the same trick the floating status bars use, so it bakes the same way.
    for (const [name, tint] of Object.entries(BIGBAR_TINT)) {
      root.setProperty(`--hud-bigbar-${name}`, `url(${bakeStatBarFill(barFill, tint)})`);
    }
    const buildBorder = url(CONSOLE_ART.buildBarBorder);
    const buildFill = url(CONSOLE_ART.buildBarFill);
    if (buildBorder && buildFill) {
      root.setProperty("--hud-buildbar-border", `url(${buildBorder})`);
      root.setProperty("--hud-buildbar-fill", `url(${buildFill})`);
    }
    const cover = url(CONSOLE_ART.inventoryCover);
    if (cover) root.setProperty("--hud-inventory-cover", `url(${cover})`);
    // The boxed number an icon wears in its corner (see countBadge). On :root and gated by a
    // class of its own rather than by `hud-widget-skinned`, because the badge is worn by the
    // HERO BAR too — which is not in the console, and is on screen with no console at all
    // during a cinematic.
    const number = url(CONSOLE_ART.numberOverlay);
    if (number) {
      root.setProperty("--hud-number-overlay", `url(${number})`);
      document.body.classList.add("hud-number-skinned");
    }
    document.body.classList.add("hud-widget-skinned");
  }

  /** Tint the status-bar slab once per bar colour and hand the four to the stylesheet.
   *  Lifted to `:root` for the same reason the tooltip's art is: the bars live in the world
   *  layer (ui/stage.ts), a DOM subtree the HUD does not own, and render/worldOverlays.ts
   *  should not have to know about art. */
  private applyStatBarSkin(): void {
    const fill = this.driver.blpCanvas(STATBAR_FILL);
    if (!fill) return; // no install mounted: the CSS placeholder bar stands
    const root = document.documentElement.style;
    for (const [state, tint] of Object.entries(STATBAR_TINT)) {
      root.setProperty(`--statbar-${state}`, `url(${bakeStatBarFill(fill, tint, STATBAR_ROWS)})`);
    }
    document.body.classList.add("hud-statbar-skinned");
  }

  /** One cost-row entry: the game's own tooltip icon plus the amount, turning red
   *  when the player can't currently pay it (WC3 tints the number, not the icon). */
  private costItem(kind: keyof typeof TOOLTIP_COST_ICON, value: number, available: number): string {
    if (!value) return "";
    const url = this.driver.blpUrl(TOOLTIP_COST_ICON[kind]);
    const icon = url ? `<img class="tt-cost-icon" src="${url}" alt="${kind}">` : "";
    const short = value > available ? " short" : "";
    return `<span class="tt-cost-item${short}">${icon}${value}</span>`;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.endFollow);
    this.unwatchPress();
    this.minimapResize?.disconnect();
    for (const id of this.msgTimers) clearTimeout(id);
    this.msgTimers.clear();
    for (const id of this.chatTimers) clearTimeout(id);
    this.chatTimers.clear();
    clearTimeout(this.errTimer);
    this.root.remove();
    // Removing the root is not enough: the skin classes and the art behind them were written
    // to `document.body` / `:root` (see applyTooltipSkin and its neighbours), because the
    // pieces they style — the world-layer hover slab, the floating status bars — are not in
    // this subtree. Those two elements outlive the match, so the HUD has to un-skin them, and
    // the blob URLs the properties hold are revoked with the scene right after this.
    document.body.classList.remove(
      "hud-tooltip-skinned", "hud-widget-skinned", "hud-statbar-skinned", "order-armed",
    );
    const root = document.documentElement.style;
    for (const prop of [...root].filter((p) => p.startsWith("--hud-") || p.startsWith("--statbar-"))) {
      root.removeProperty(prop);
    }
  }

  hide(): void {
    this.root.hidden = true;
  }

  show(): void {
    this.root.hidden = false;
  }

  /** An armed order was executed (or cancelled) — release the button state. */
  clearOrderMode(): void {
    this.setArmed(false);
  }

  frame(dtMs: number): void {
    if (this.root.hidden) return;
    this.dotsT += dtMs;
    this.textT += dtMs;
    // Refresh the info panel immediately when the selection changes, so the
    // construction/training display never lingers from the previous selection.
    const selId = this.driver.selection()?.id ?? null;
    if (selId !== this.lastSelId) {
      this.lastSelId = selId;
      this.textT = TEXT_PERIOD;
    }
    if (this.textT >= TEXT_PERIOD) {
      this.textT = 0;
      this.updateTexts();
    }
    // A live ping PULSES, so while one is up the minimap redraws every frame instead of at
    // the 10 Hz the static dots are content with.
    if (this.agePings(dtMs / 1000)) this.dotsT = DOTS_PERIOD;
    if (this.dotsT >= DOTS_PERIOD) {
      this.dotsT = 0;
      this.drawDots();
    }
    this.updateCameraRect(); // every frame, unthrottled: the box IS the camera's motion
    this.refreshCommandCard();
    this.refreshInventory();
    this.refreshHeroBar();
    this.updateIdleWorkers();
    // Last: the two refreshes above are what say which buttons are lit, and the effect is
    // simulated once for all of them (see ModalButtonFx).
    this.modalFx.tick(dtMs);
    this.heroLevelFx.tick(dtMs);
  }

  /** Redraw the selection-dependent panels right now rather than on the next
   *  animation frame. A control-group or hero hotkey should read as instant: the
   *  selection changed inside this keydown, so the portrait, stats and command
   *  card can follow it in the same tick instead of trailing the sim by a frame.
   *  Priming `lastSelId` keeps frame() from redoing the work a moment later. */
  private refreshSelectionNow(): void {
    if (this.root.hidden) return;
    this.lastSelId = this.driver.selection()?.id ?? null;
    this.textT = 0;
    this.updateTexts();
    this.refreshCommandCard();
    this.refreshInventory();
    this.refreshHeroBar(); // a hero picked by hotkey shows its bars in the same tick as the card
  }

  /** Show/hide the idle-worker button and update its count; apply the race worker
   *  icon once it's known. */
  private updateIdleWorkers(): void {
    const n = this.driver.idleWorkerCount();
    this.idleWorkerBadge.hidden = n === 0;
    if (n === 0) return;
    setCount(this.idleWorkerCount, String(n));
    if (!this.idleIconSet) {
      const path = this.driver.workerIcon();
      const url = path ? this.driver.blpUrl(path) : null;
      if (url) {
        this.idleWorkerBadge.style.backgroundImage = `url(${url})`;
        this.idleIconSet = true;
      }
    }
  }

  private lastTapKey = ""; // for double-tap detection (control-group / hero camera jump)
  private lastTapAt = 0;

  /** The hero key / control-group digit currently HELD after its double-tap, whose
   *  camera-follow ends when it comes back up (see `holdFollow`). */
  private followKey: string | null = null;

  /** The identity a held hotkey is remembered by. Digits go by `code` (Digit1…) for the
   *  same reason the recall below does — with Shift down `key` is the shifted symbol, and
   *  the keyup for a key pressed unshifted can still arrive shifted. */
  private static followToken(e: KeyboardEvent): string {
    return e.code.startsWith("Digit") ? e.code : e.key;
  }

  /** Begin WC3's hold-to-follow: the double-tap already centred the camera on the group,
   *  and while the key stays down the camera rides it. */
  private holdFollow(token: string): void {
    this.followKey = token;
    this.driver.followSelection(true);
  }

  /** Let go of the followed group (keyup, or the window losing the keyboard mid-hold —
   *  no keyup ever arrives for that, and the camera would stay stuck to the group). */
  private endFollow = (): void => {
    if (this.followKey === null) return;
    this.followKey = null;
    this.driver.followSelection(false);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.followKey === GameHud.followToken(e)) this.endFollow();
  };

  /** True when `key` repeats the previous key within the double-tap window. */
  private tapAgain(key: string): boolean {
    const now = performance.now();
    const again = key === this.lastTapKey && now - this.lastTapAt < 350;
    this.lastTapKey = key;
    this.lastTapAt = now;
    return again;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.root.hidden) return;
    // A cinematic owns the keyboard too. The letterbox usually hides the console (so the line
    // above already caught it), but EnableUserControl(false) and ShowInterface(false) are
    // different natives — a transmission during ordinary play leaves the console up while the
    // script still holds control.
    if (!this.driver.controlEnabled()) return;
    if (document.body.classList.contains("game-menu-open")) return; // F10 menu is modal
    // …and a STOPPED match has no commands to give: control groups, the command card's
    // letters and the chat key all stand down until it is running again. Set by
    // mapViewer.syncPauseUi, and deliberately NOT set for a pause that is only a panel being
    // open — the scrim test below is what covers those.
    if (document.body.classList.contains("game-paused")) return;
    // So is every other in-game dialog — the Allies and Messaging panels, and a script's own.
    // The two flags above do not cover them (`game-menu-open` is the F10 panel's alone, and
    // `game-paused` is deliberately not set for a pause that is only a panel being open); what
    // they ALL put up is the modal scrim, and that is the thing to ask about. Without this,
    // Enter over an open Messaging panel opens a chat line behind it.
    if (document.querySelector(".fdf-dialog-scrim")) return;
    // Typing into an in-game field is TYPING, not commanding. The Allies dialog's gift
    // boxes are the first of these, and without this every
    // digit of "200" also recalls a control group and every letter fires a command-card
    // hotkey. The FDF screens' own accelerators already stand down the same way.
    if (isTyping(e.target)) return;
    // Held keys auto-repeat ~30×/s. None of the hotkeys below are hold-to-repeat
    // commands (camera panning reads its own key set), and letting them repeat
    // both spams selection voice lines and makes every held key look like a
    // double-tap, snapping the camera to the group.
    if (e.repeat) return;
    // Enter opens the chat entry line to everyone, Ctrl+Enter to your allies — the game's
    // own two send keys. Ctrl is read here rather than left to a modal picker because that
    // is the binding: there is no "switch target" step in the middle.
    if (e.key === "Enter") {
      e.preventDefault();
      this.openChat(e.ctrlKey ? { scope: "allies" } : this.defaultChatTarget());
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault(); // Tab cycles the focused sub-group; Shift+Tab reverses
      this.driver.cycleFocus(e.shiftKey);
      this.refreshSelectionNow();
      return;
    }
    if (e.key === "Escape") {
      this.driver.runCommand("cancel");
      return;
    }
    // F8 / ` (tilde) select and cycle through idle workers (WC3).
    if (e.key === "F8" || e.key === "`" || e.key === "~") {
      e.preventDefault();
      this.driver.cycleIdleWorker();
      this.refreshSelectionNow();
      return;
    }
    // Hero hotkeys F1/F2/F3: select the hero (double-tap centres the camera, and holding
    // that second tap down keeps the camera on him as he moves).
    if (e.key === "F1" || e.key === "F2" || e.key === "F3") {
      e.preventDefault();
      const again = this.tapAgain(e.key);
      // Only a hero who is actually THERE may be followed — F3 with two heroes selects
      // nothing, and must not leave the camera riding whatever was already selected.
      if (this.driver.selectHero(Number(e.key[1]) - 1, again) && again) this.holdFollow(GameHud.followToken(e));
      this.refreshSelectionNow();
      return;
    }
    // Control groups on the number row 1-0: Ctrl assigns, Shift appends, a plain
    // tap recalls, a double tap recalls + jumps the camera to the group. Key off
    // `e.code` (Digit1…) — with Shift held, `e.key` is the shifted symbol ("!"),
    // which is why Shift+N was silently doing nothing.
    const digit = /^Digit([0-9])$/.exec(e.code);
    if (digit) {
      e.preventDefault();
      const n = digit[1];
      if (e.ctrlKey || e.metaKey) this.driver.assignControlGroup(n);
      else if (e.shiftKey) this.driver.appendControlGroup(n);
      else {
        const again = this.tapAgain(n);
        // …and likewise an empty group recalls nothing, so there is nothing to ride.
        if (this.driver.recallControlGroup(n, again) && again) this.holdFollow(GameHud.followToken(e));
      }
      this.refreshSelectionNow();
      return;
    }
    // NumPad maps to the 2×3 inventory grid (INVENTORY_NUMPAD). Which PHYSICAL key that is
    // comes from `e.code` (Numpad7), so no layout can move it. Whether it is an item hotkey
    // at all comes from `e.key`: the game's own Tip50 (UI\TipStrings.txt) says the slots
    // answer the keypad "when |Cfffed312Num Lock|r is turned on", and with the lock ON the OS
    // sends the DIGIT while with it OFF it sends the arrow/Home/End the same key doubles as —
    // which is a camera pan (mapViewer reads "arrowup"/"arrowleft"/…), exactly as in WC3.
    // Read that off the keystroke rather than getModifierState("NumLock"), which a keyboard
    // with no numpad at all cannot answer meaningfully.
    const numpad = /^Numpad([0-9])$/.exec(e.code);
    const slot = numpad && e.key === numpad[1] ? INVENTORY_NUMPAD.indexOf(Number(numpad[1])) : -1;
    if (slot >= 0) {
      e.preventDefault();
      this.driver.useInventory(slot);
      return;
    }
    // Alt-A cycles the Ally Color Mode — the game's own binding, printed in the button's
    // tooltip ("Set Ally Color Mode (|Cfffed312Alt-A|R)", GlobalStrings.fdf). Read before the
    // command card's letters so a unit whose card has an "A" on it cannot eat it, and
    // `preventDefault` because Alt+letter is a menu accelerator in the browser.
    if (e.altKey && e.code === "KeyA") {
      e.preventDefault();
      if (this.driver.allyColorButtonEnabled()) {
        this.driver.cycleAllyColorMode();
        this.refreshAllyColorButton();
      }
      return;
    }
    // Trigger the command whose hotkey matches the pressed key. A passive isn't a
    // command, so its letter isn't taken — it can't shadow a real order sharing it.
    // Neither is an unavailable one (a greyed DISBTN button has no hotkey in WC3
    // either). One you merely can't afford DOES answer its key — and gets told why.
    const key = e.key.toUpperCase();
    const cmd = this.driver.commandCard().find((c) => c.hotkey === key && !c.disabled && !c.passive);
    if (cmd) this.driver.runCommand(cmd.id);
  };

  /** Reflect the armed order state on the body (crosshair cursor). */
  setArmed(armed: boolean): void {
    document.body.classList.toggle("order-armed", armed);
  }

  // --- construction ---------------------------------------------------------

  // The console's CHROME used to be built here. All of it is the game's own frames now — both
  // bands of the console art, the Quests/Menu/Allies/Chat buttons and the resource readout come
  // from ConsoleUI/UpperButtonBar/ResourceBar.fdf, and the day/night medallion hangs in the gap
  // between them. See ui/consoleUi.ts. What stays here is what goes IN the console's sockets.

  /** The canvas inside the portrait frame — the host renders the selected
   *  unit's animated portrait model into it. */
  portraitCanvas(): HTMLCanvasElement {
    return this.portraitCanvasEl;
  }

  private buildConsole(skinned: boolean): HTMLDivElement {
    // Visual background rectangle for the PLACEHOLDER console — the strip the HUD draws for
    // itself when there is no install. With one mounted, the black behind the console's
    // cut-outs is laid in under the art by ui/consoleUi.ts, which is the only place it can
    // go: the HUD stacks over that art and a rect here would cover it.
    const bg = document.createElement("div");
    bg.className = "hud-console-background";

    const console_ = document.createElement("div");
    console_.className = "hud-console";
    const minimap = this.buildMinimap();
    const { portraitWrap, infoText } = this.buildInfoPanel(skinned);
    const inventory = this.buildInventory(skinned);
    const command = this.buildCommandCard();
    console_.append(minimap, portraitWrap, infoText, inventory, command);
    // The minimap's button column is punched through the console ART, so the button only
    // exists when that art is on screen; the placeholder strip has nowhere to put it.
    if (skinned) console_.append(this.buildAllyColorButton());
    if (skinned) console_.append(this.selHpText, this.selMpText);
    // The crest that replaces the six slots when the selection carries nothing. LAST, so it
    // paints over them; only the console art's own version of this corner is under it.
    this.invCover = document.createElement("div");
    this.invCover.className = "hud-inventory-cover";
    this.invCover.hidden = true;
    if (skinned) console_.append(this.invCover);
    if (skinned) {
      // The chrome itself is ui/consoleUi.ts's FDF screen, drawn UNDER this element; all this
      // one does is give the widgets the same box to be a percentage of. That box is the
      // file's own: 0.8 wide × CONSOLE_BAND_H tall of the 0.6-tall UI space, held at 4:3 and
      // centred exactly as the FDF screen holds it (fdf/render.ts centreBox).
      //
      // The two sizes go on the HUD ROOT, not on the console: --console-h is what anything
      // that must sit clear of the console — the error line, the chat column — reads to know
      // where the console's top edge is. Set it here and only the console could see it.
      console_.classList.add("hud-console-skinned");
      this.root.style.setProperty("--console-h", `calc(var(--stage-h) * ${CONSOLE_BAND_H / UI_HEIGHT})`);
      this.root.style.setProperty("--console-w", `calc(var(--stage-h) * ${UI_WIDTH / UI_HEIGHT})`);
      this.root.classList.add("hud-skinned-console");

      place(minimap, CONSOLE_ZONES.minimap);
      if (this.allyColorBtn) place(this.allyColorBtn, CONSOLE_ZONES.allyColor);
      place(portraitWrap, CONSOLE_ZONES.portrait);
      place(this.selHpText, CONSOLE_ZONES.portraitHp);
      place(this.selMpText, CONSOLE_ZONES.portraitMana);
      place(infoText, CONSOLE_ZONES.info);
      place(inventory, CONSOLE_ZONES.inventory);
      place(command, CONSOLE_ZONES.command);
      // The card's cells are the art's own: four columns and three rows on a 87 × 87-texel
      // pitch, so the grid is 1fr each with the gutters the art leaves between them. In
      // percentages, so they hold at any window size.
      command.style.columnGap = `${COMMAND_GAP.col * 100}%`;
      command.style.rowGap = `${COMMAND_GAP.row * 100}%`;
      place(this.invCover, CONSOLE_INVENTORY_COVER);
      this.invCover.classList.remove("hud-zone"); // decoration: it must not eat the clicks
      this.invCover.style.pointerEvents = "none";
    }

    // Wrapper holds the background and the real console; DOM order ensures the
    // background sits behind the console element.
    const wrapper = document.createElement("div");
    wrapper.append(...(skinned ? [console_] : [bg, console_]));
    return wrapper as unknown as HTMLDivElement;
  }

  /** A small floating panel of debug cheats in the bottom-right corner: top up
   *  gold/lumber/food and a Fast Build toggle (builds + trains finish in ~1s). */
  private buildCheatPanel(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "hud-cheats";
    const mk = (label: string, kind: "gold" | "lumber" | "food" | "fastbuild") => {
      const b = document.createElement("button");
      b.className = "hud-cheat-btn";
      b.textContent = label;
      b.onclick = () => {
        const on = this.driver.cheat(kind);
        if (kind === "fastbuild") b.classList.toggle("active", on);
      };
      return b;
    };
    panel.append(mk("+5000 Gold", "gold"), mk("+5000 Lumber", "lumber"), mk("+Food", "food"), mk("Fast Build", "fastbuild"));

    // Selection cheats: refill the selected unit(s)' HP/MP or wipe their cooldowns.
    const mkSel = (label: string, kind: "hp" | "mp" | "cooldown") => {
      const b = document.createElement("button");
      b.className = "hud-cheat-btn";
      b.textContent = label;
      b.onclick = () => this.driver.cheatSelected(kind);
      return b;
    };
    panel.append(mkSel("Full HP", "hp"), mkSel("Full MP", "mp"), mkSel("Reset Cooldown", "cooldown"));

    // Collider debug overlay toggle + a colour legend (hidden until turned on).
    const legend = document.createElement("div");
    legend.className = "hud-collider-legend";
    legend.hidden = true;
    const swatch = (color: string, label: string) => {
      const row = document.createElement("div");
      row.className = "hud-legend-row";
      const box = document.createElement("span");
      box.className = "hud-legend-swatch";
      box.style.background = color;
      const text = document.createElement("span");
      text.textContent = label;
      row.append(box, text);
      return row;
    };
    legend.append(
      swatch("rgb(64,255,115)", "Click / selection"),
      swatch("rgb(255,72,51)", "Pathing obstruction"),
      swatch("rgb(77,166,255)", "Fog-of-war (line-of-sight) blocker"),
    );
    const colliderBtn = document.createElement("button");
    colliderBtn.className = "hud-cheat-btn";
    colliderBtn.textContent = "Show Colliders";
    colliderBtn.onclick = () => {
      const on = this.driver.toggleColliders();
      colliderBtn.classList.toggle("active", on);
      legend.hidden = !on;
    };
    panel.append(colliderBtn, legend);

    // Pathing debug overlay toggle: the pathing grid + moving units' routes.
    const pathLegend = document.createElement("div");
    pathLegend.className = "hud-collider-legend";
    pathLegend.hidden = true;
    pathLegend.append(
      swatch("rgb(140,158,184)", "Pathing grid"),
      swatch("rgb(255,64,51)", "Blocked cell"),
      swatch("rgb(255,217,51)", "Unit path"),
    );
    const pathBtn = document.createElement("button");
    pathBtn.className = "hud-cheat-btn";
    pathBtn.textContent = "Show Pathing";
    pathBtn.onclick = () => {
      const on = this.driver.togglePathing();
      pathBtn.classList.toggle("active", on);
      pathLegend.hidden = !on;
    };
    panel.append(pathBtn, pathLegend);

    // "Show Regions": outline the map's named trigger regions (gg_rct_*) with their
    // name inside each — for testing enter/leave-region triggers (Phase 7).
    const regionBtn = document.createElement("button");
    regionBtn.className = "hud-cheat-btn";
    regionBtn.textContent = "Show Regions";
    regionBtn.onclick = () => regionBtn.classList.toggle("active", this.driver.toggleRegions());
    panel.append(regionBtn);

    // "Spawn Hero": a maxed level-6 hero at the camera centre, for casting a whole kit
    // on camera. A race-grouped dropdown of every hero unit type + a Spawn button.
    const heroSel = document.createElement("select");
    heroSel.className = "hud-cheat-select";
    const heroes = this.driver.heroList();
    let lastRace = "";
    let group: HTMLOptGroupElement | null = null;
    for (const h of heroes) {
      if (h.race !== lastRace) {
        group = document.createElement("optgroup");
        group.label = h.race || "neutral";
        heroSel.append(group);
        lastRace = h.race;
      }
      const opt = document.createElement("option");
      opt.value = h.id;
      opt.textContent = wc3StripMarkup(h.name); // an <option> can carry no markup
      (group ?? heroSel).append(opt);
    }
    const spawnBtn = document.createElement("button");
    spawnBtn.className = "hud-cheat-btn";
    spawnBtn.textContent = "Spawn Hero";
    spawnBtn.onclick = () => {
      if (heroSel.value) this.driver.spawnTestHero(heroSel.value);
    };
    if (heroes.length) panel.append(heroSel, spawnBtn);
    return panel;
  }

  /**
   * The message column (`WorldFrameUnitMessage`, see MSG_AREA for where it sits and why):
   * the lines the MAP has shown — trigger dialog, quest updates, the engine's own reports.
   * Player chat is not in here: it has a display of its own (buildChatLog / CHAT_AREA).
   */
  private buildMessageLog(): HTMLDivElement {
    const column = document.createElement("div");
    column.className = "hud-msgcol";
    // Every length the block uses, as a fraction of the game's 0.6-tall UI space mapped onto
    // --stage-h — so the text is the size the engine's font height asks for at any window
    // size, rather than a pixel count that is right on one monitor. `left` is measured from
    // the centre because the 0.8 box is what it is anchored to (MSG_AREA).
    column.style.left = `calc(50% - ${uiPx(UI_WIDTH / 2 - MSG_AREA.left)})`;
    column.style.bottom = uiPx(MSG_AREA.bottom);
    column.style.width = uiPx(MSG_AREA.width);

    this.msgLog = document.createElement("div");
    this.msgLog.className = "hud-msglog";
    column.append(this.msgLog);
    return column;
  }

  /**
   * The chat display (`ORIGIN_FRAME_CHAT_MSG` / `CChatDisplay`, see CHAT_AREA): what players
   * say, in its own column down the frame's left edge. Its independence from the message
   * column is the feature — neither stack can push the other around.
   */
  private buildChatLog(): HTMLDivElement {
    const column = document.createElement("div");
    column.className = "hud-chatcol";
    // Anchored to the frame's own left edge — this column is the one thing on screen measured
    // from there rather than from the centred 0.8 box, because hard left is what it is. Pinned
    // by its bottom, like the message column: the stack grows upward, newest line last.
    column.style.left = uiPx(CHAT_AREA.left);
    column.style.bottom = uiPx(CHAT_AREA.bottom);
    column.style.width = uiPx(CHAT_AREA.width);

    this.chatLog = document.createElement("div");
    this.chatLog.className = "hud-chatlog";
    column.append(this.chatLog);
    return column;
  }

  /**
   * The chat ENTRY line: the box the player types into, centred on the console's top edge
   * (CHAT_BAR). It is NOT in any .fdf — WC3 draws it from `Game.dll` (CGameUI) like the
   * command card and the minimap, so there is no frame to mount, and its backdrop is the
   * tooltip's. Its WORDS are the game's, though: `chatPrompt` resolves the `COLON_MESSAGE_*`
   * GlobalStrings for whichever target is armed.
   */
  private buildChatBar(): HTMLDivElement {
    this.chatBar = document.createElement("div");
    this.chatBar.className = "hud-chatbar";
    this.chatBar.hidden = true;
    this.chatBar.style.width = uiPx(CHAT_BAR.width);
    this.chatBar.style.height = uiPx(CHAT_BAR.height);
    this.chatBar.style.bottom = uiPx(CHAT_BAR.bottom);
    this.chatBar.style.setProperty("--chat-border", uiPx(CHAT_BAR.border));
    this.chatBar.style.setProperty("--chat-pad", uiPx(CHAT_BAR.padX));
    this.chatPromptEl = document.createElement("span");
    this.chatPromptEl.className = "hud-chat-prompt";
    this.chatInput = document.createElement("input");
    this.chatInput.type = "text";
    this.chatInput.className = "hud-chat-input";
    this.chatInput.maxLength = CHAT_MAX_LENGTH;
    this.chatInput.autocomplete = "off";
    this.chatInput.spellcheck = false;
    this.chatBar.append(this.chatPromptEl, this.chatInput);

    // The entry line answers its own keys. It has to: the HUD's hotkeys stand down while a
    // field has focus (isTyping), which is the whole point — otherwise every letter typed
    // would also fire a command-card hotkey.
    this.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.sendChat();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeChat();
      } else if (e.key === "Tab") {
        // Tab belongs to the entry line while the entry line is up: it switches audience.
        // Outside it, the same key cycles the selection's sub-group — hence stopPropagation,
        // and preventDefault so the browser doesn't walk focus to the next element instead.
        e.preventDefault();
        e.stopPropagation();
        this.toggleChatTarget();
      }
    });
    // An open entry line CANNOT be unfocused. Clicking the map, a command button or anything
    // else does not abandon what was typed — only Escape (throw it away) and Enter (send it)
    // close the line, so a stray click mid-sentence costs nothing. The focus is taken back
    // after the blur has finished dispatching, which is the point a browser will accept it.
    this.chatInput.addEventListener("blur", () => {
      if (this.chatBar.hidden) return; // closeChat() hides FIRST, so its own blur lands here
      setTimeout(() => {
        if (!this.chatBar.hidden) this.chatInput.focus();
      }, 0);
    });
    return this.chatBar;
  }

  /**
   * Who plain Enter talks to right now.
   *
   * Nobody having chosen, the alliances choose: a player WITH allies is talking to them —
   * that is who you are playing with, and it is the audience you want by default — and a
   * player with none has only one audience there is to have. An explicit choice (F12, or a
   * Tab in the entry line) stands, but is still clamped: an allied target you were left
   * holding when the last ally dropped is no target at all.
   */
  private defaultChatTarget(): ChatTarget {
    return this.clampChatTarget(this.chatDefault ?? { scope: this.driver.chatHasAllies() ? "allies" : "all" });
  }

  /** "To Allies" with nobody allied is not a thing the entry line can be — fall back to All. */
  private clampChatTarget(target: ChatTarget): ChatTarget {
    return target.scope === "allies" && !this.driver.chatHasAllies() ? { scope: "all" } : target;
  }

  /** Open the chat entry line addressed at `target` (Enter → the default, Ctrl+Enter → allies). */
  openChat(target: ChatTarget): void {
    this.chatTarget = this.clampChatTarget(target);
    this.chatPromptEl.textContent = this.driver.chatPrompt(this.chatTarget);
    this.chatBar.hidden = false;
    this.chatInput.value = "";
    this.chatInput.focus();
  }

  get chatOpen(): boolean {
    return !this.chatBar.hidden;
  }

  /** The Quests button's flash (FlashQuestDialogButton): on when the script announced
   *  something, off the moment the log is opened — as in the game. */
  flashQuests(on: boolean): void {
    this.questsBtn?.classList.toggle("hud-quests-flash", on);
  }

  /** Point plain Enter at a different audience — what the F12 dialog's OK commits. */
  setChatTarget(target: ChatTarget): void {
    this.chatDefault = target;
  }

  /** Who plain Enter currently talks to, so the F12 dialog can open showing it. */
  chatTargetNow(): ChatTarget {
    return this.defaultChatTarget();
  }

  /**
   * Tab, while typing: switch the line between the two audiences everyone always has — the
   * game's own pair, "To All:" and "To Allies:". With no allies there is no second mode, so
   * Tab is nothing and the line stays where it is.
   *
   * The switch STICKS: it is the mode you are now in, so the next Enter opens there too,
   * exactly as if the F12 dialog had been used. What was typed is kept — you are changing
   * who hears the sentence, not abandoning it.
   */
  private toggleChatTarget(): void {
    if (!this.driver.chatHasAllies()) return;
    this.chatTarget = { scope: this.chatTarget.scope === "allies" ? "all" : "allies" };
    this.chatDefault = this.chatTarget;
    this.chatPromptEl.textContent = this.driver.chatPrompt(this.chatTarget);
  }

  private closeChat(): void {
    if (this.chatBar.hidden) return;
    this.chatBar.hidden = true;
    this.chatInput.value = "";
    this.chatInput.blur();
  }

  /** Send what was typed and close. An empty line is not a message — it just closes, which
   *  is how the game treats Enter-Enter with nothing in between. */
  private sendChat(): void {
    const text = sanitizeChat(this.chatInput.value);
    const target = this.chatTarget;
    this.closeChat();
    if (text) this.driver.sendChat(text, target);
  }

  /** Show one on-screen message line (DisplayTextToPlayer & the timed variant).
   *  `duration` is seconds for the timed action, or < 0 for the untimed one — which
   *  in WC3 lingers, so we give it a generous default and let it scroll off. WC3
   *  colour codes (`|cAARRGGBB…|r`, `|n`) are honoured. Newest line sits at the
   *  bottom; we keep the last MSG_MAX so the stack can't grow without bound. */
  showMessage(text: string, duration: number): void {
    this.pushLine(this.msgLog, this.msgTimers, "hud-msgline", MSG_MAX, text, duration);
  }

  /** Show one line of player chat. It goes to the CHAT display, never to the message area —
   *  two frames in the engine (CChatDisplay vs CMessageFrame, ORIGIN_FRAME_CHAT_MSG vs
   *  ORIGIN_FRAME_UNIT_MSG), so what a player says cannot shove the map's own text around.
   *  MiscUI sizes them apart too: WorldFrameChatMessage (0.013) against the message area's
   *  WorldFrameUnitMessage (0.015). */
  showChatMessage(text: string, duration: number): void {
    this.pushLine(this.chatLog, this.chatTimers, "hud-chatline", CHAT_MAX, text, duration);
  }

  /** One line into one of the two stacks: newest at the bottom, oldest scrolled off past
   *  `max`, and removed again on its own timer. WC3 colour codes are honoured. */
  private pushLine(
    log: HTMLDivElement,
    timers: Set<number>,
    cls: string,
    max: number,
    text: string,
    duration: number,
  ): void {
    if (!text) return;
    const line = document.createElement("div");
    line.className = cls;
    line.innerHTML = formatColorCodes(text);
    log.append(line);
    while (log.childElementCount > max) log.firstElementChild?.remove();
    const secs = duration >= 0 ? duration : MSG_DEFAULT_SECS;
    const id = window.setTimeout(() => {
      line.remove();
      timers.delete(id);
    }, Math.max(0.5, secs) * 1000);
    timers.add(id);
  }

  /** The single gold line the engine flashes above the console when a command is
   *  refused ("Not enough gold.", "Build more Farms…"). It is NOT the message log:
   *  WC3 keeps one centred line here, replaced — never stacked — by the next error. */
  private buildErrorLine(): HTMLDivElement {
    this.errLine = document.createElement("div");
    this.errLine.className = "hud-error";
    return this.errLine;
  }

  /** Show one command error. Re-showing restarts the timer and replaces the text,
   *  so mashing an unaffordable button holds one steady line rather than a stack. */
  showError(text: string): void {
    if (!text) return;
    clearTimeout(this.errTimer);
    this.errLine.textContent = text;
    this.errLine.classList.remove("hud-error-on");
    void this.errLine.offsetWidth; // restart the fade-in animation on a repeat error
    this.errLine.classList.add("hud-error-on");
    this.errTimer = window.setTimeout(() => this.errLine.classList.remove("hud-error-on"), ERROR_SECS * 1000);
  }

  /** Clear every on-screen message (the ClearTextMessages action). The chat display is left
   *  alone: it is a separate frame the action does not name, and a map wiping its own text
   *  has no business deleting what the players said to each other. */
  clearMessages(): void {
    for (const id of this.msgTimers) clearTimeout(id);
    this.msgTimers.clear();
    this.msgLog.replaceChildren();
  }

  private buildMinimap(): HTMLDivElement {
    const box = document.createElement("div");
    box.className = "hud-minimap";
    this.minimapBox = box;

    // The map's aspect drives everything below: the picture, the dots canvas and
    // the click→pan mapping all live on one rect — the map contain-fitted into the
    // frame and centred, so a square map fills the frame and a 3:4 map pillarboxes
    // rather than stretching (issue #42).
    const [, , mapW, mapH] = this.driver.mapBounds();
    const aspect = mapW > 0 && mapH > 0 ? mapW / mapH : 1;
    this.minimapAspect = aspect;
    this.mmW = aspect >= 1 ? MINIMAP_SIZE : Math.round(MINIMAP_SIZE * aspect);
    this.mmH = aspect >= 1 ? Math.round(MINIMAP_SIZE / aspect) : MINIMAP_SIZE;

    const view = document.createElement("div");
    view.className = "hud-minimap-view";
    this.minimapView = view;
    box.appendChild(view);

    const image = this.driver.minimapImage();
    if (image) {
      const cropped = cropMinimapLetterbox(image, aspect);
      cropped.className = "hud-minimap-img";
      view.appendChild(cropped);
    }
    this.dotsCanvas = document.createElement("canvas");
    this.dotsCanvas.className = "hud-minimap-dots";
    this.dotsCanvas.width = this.mmW;
    this.dotsCanvas.height = this.mmH;
    view.appendChild(this.dotsCanvas);

    // The camera box (issue #112): a white hairline rectangle over the map picture marking the
    // ground the viewport is looking at. A DOM box rather than another figure on the dots canvas
    // — that canvas redraws at DOTS_PERIOD (10 Hz), and a box that lags the view by up to a
    // tenth of a second while you drag it is the one thing this widget must not do. Sized in
    // PERCENTAGES of the map picture, so it is proportional to the map (a rect covering a fifth
    // of a 96×96 map covers a tenth of a 192×192 one) and needs no re-fit when the frame resizes.
    // Its own wrapper clips it: near a map edge the view spills past the terrain, and the
    // overhang must stop at the picture rather than run out over the console art.
    const camClip = document.createElement("div");
    camClip.className = "hud-minimap-camclip";
    this.camRect = document.createElement("div");
    this.camRect.className = "hud-minimap-cam";
    camClip.appendChild(this.camRect);
    view.appendChild(camClip);

    // The frame is sized in percentages of the console art, so its pixel size moves
    // with the window; re-fit the view whenever it does.
    this.fitMinimap();
    this.minimapResize = new ResizeObserver(() => this.fitMinimap());
    this.minimapResize.observe(box);

    // Pointer → world point on the map picture. Clamped to the map, because a drag holds the
    // pointer captured and it may well leave the minimap while the button is still down.
    const worldAt = (e: PointerEvent): [number, number] => {
      const rect = view.getBoundingClientRect();
      const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const v = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const [ox, oy, w, h] = this.driver.mapBounds();
      return [ox + u * w, oy + (1 - v) * h]; // minimap is north-up
    };
    view.addEventListener("pointerdown", (e) => {
      if (e.button === 1) return; // middle button: nothing on the minimap
      const [wx, wy] = worldAt(e);
      // Alt-click marks the spot for the team before anything else looks at the click — a
      // ping is not an order, and must not be read as one.
      if (e.altKey && e.button === 0) {
        this.driver.minimapPing(wx, wy);
        return;
      }
      // The minimap takes orders too (issue #64): right-click moves, an armed order aims.
      const r = this.driver.minimapClick(wx, wy, e.button === 2, e.shiftKey);
      if (r === "ordered") this.clearOrderMode();
      if (r !== "none") return;
      this.driver.panTo(wx, wy); // plain left-click: jump the camera there
      // …and it can be HELD: the camera keeps following the pointer until the button comes up
      // (issue #112), which is how WC3 sweeps the view across a map. Only the plain left-press
      // drags — a ping, an order and a right-click have all returned above, and each of those
      // is a one-shot gesture in the real game too.
      this.minimapDrag = e.pointerId;
      view.setPointerCapture(e.pointerId);
    });
    view.addEventListener("pointermove", (e) => {
      if (this.minimapDrag !== e.pointerId) return;
      const [wx, wy] = worldAt(e);
      this.driver.panTo(wx, wy);
    });
    const endDrag = (e: PointerEvent): void => {
      if (this.minimapDrag !== e.pointerId) return;
      this.minimapDrag = null;
      if (view.hasPointerCapture(e.pointerId)) view.releasePointerCapture(e.pointerId);
    };
    view.addEventListener("pointerup", endDrag);
    view.addEventListener("pointercancel", endDrag);
    // Idle-worker button — the race's own worker button above the minimap, with an idle count
    // at the bottom-right. Click (or F8 / ~) selects and cycles through workers doing nothing.
    // Hidden when there are none.
    //
    // The art is the worker's `BTN*.blp` and nothing else: a command button in WC3 carries its
    // gold frame IN the texture, so a border of our own around it is a second frame. It sinks
    // under the press exactly as a hero-bar button does — same `onPress`, same `.pressed`.
    this.idleWorkerBadge = document.createElement("button");
    this.idleWorkerBadge.className = "hud-idle-worker hud-iconbtn";
    this.idleWorkerBadge.title = "Select idle worker (F8 / ~)";
    this.idleWorkerBadge.hidden = true;
    // Its count wears the same boxed badge every other count in the game does (countBadge).
    // This button is OpenWar3's own — 1.30 has no idle-worker button to copy — so there is no
    // original to match here; matching the rest of our own console is the whole argument.
    this.idleWorkerCount = countBadge();
    this.idleWorkerCount.classList.add("hud-idle-count");
    this.idleWorkerBadge.appendChild(this.idleWorkerCount);
    this.idleWorkerBadge.addEventListener("pointerdown", (e) => e.stopPropagation()); // never a minimap ping
    onPress(this.idleWorkerBadge, () => this.driver.cycleIdleWorker());
    box.appendChild(this.idleWorkerBadge);
    return box;
  }

  /**
   * The Ally Color Mode button — the third socket in the column right of the minimap.
   *
   * One button, three faces: it shows the mode it is IN — the crossed axes for player colours
   * (mode 1), the pauldron for the filtered minimap (mode 2), the pauldron and its lens for
   * the filtered world too (mode 3) — and a click steps to the next one, exactly as Alt-A
   * does. Held down it wears that same face's `-down` twin, which is what the art ships a
   * TRIPLE per mode for (`MiniMapAllyButton{Off,Inactive,Active}{Enabled,Pushed,Disabled}` in
   * `UI\war3skins.txt`). See game/allyColor.ts for the whole table.
   *
   * The art is the game's own and carries its whole look — the gold rim included — so there
   * is no border of ours around it, the same rule every command button follows. Named by
   * war3skins KEY rather than by path, which is also what lets the four races share one
   * button honestly: the keys sit in the file's [Default] section because Blizzard only ever
   * drew the Human one.
   */
  private buildAllyColorButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "hud-minimap-ally hud-iconbtn";
    this.allyColorBtn = btn;
    // The press: `onPress` gives it the same sink-and-release every other console button has.
    // A button the map has taken away (EnableMinimapFilterButtons) is bound all the same and
    // simply does nothing — the same discipline the upper button bar follows, so a button that
    // comes back does not need re-binding.
    onPress(btn, () => {
      if (!this.driver.allyColorButtonEnabled()) return;
      this.driver.cycleAllyColorMode();
      this.refreshAllyColorButton(); // the face IS the mode, so it changes under the cursor
    });
    btn.oncontextmenu = (e) => e.preventDefault();
    // The game's own pushed face while it is held, over the top of the pressed transform.
    btn.addEventListener("pointerdown", (e) => {
      if (e.button === 0 && this.driver.allyColorButtonEnabled()) this.paintAllyColorButton("Pushed");
    });
    btn.addEventListener("pointerup", () => this.refreshAllyColorButton());
    btn.onpointerenter = () => this.showAllyColorTooltip();
    btn.onpointerleave = () => {
      this.cmdTooltip.hidden = true;
      this.refreshAllyColorButton(); // a press dragged off the button never got its pointerup
    };
    this.refreshAllyColorButton();
    return btn;
  }

  /** Redress the button for the mode it is now in — after a click, Alt-A, or a script's
   *  `SetAllyColorFilterState` / `EnableMinimapFilterButtons`. Public because the mode can
   *  change from outside the HUD entirely (mapViewer wires both). */
  refreshAllyColorButton(): void {
    this.paintAllyColorButton(this.driver.allyColorButtonEnabled() ? "Enabled" : "Disabled");
  }

  private paintAllyColorButton(press: "Enabled" | "Pushed" | "Disabled"): void {
    if (!this.allyColorBtn) return;
    const url = this.driver.blpUrl(this.driver.skinPath(allyButtonSkin(this.driver.allyColorMode(), press)));
    this.allyColorBtn.style.backgroundImage = url ? `url(${url})` : "";
    this.allyColorBtn.classList.toggle("disabled", press === "Disabled");
  }

  /** The button's tooltip, in the same slab above the command card every other HUD tooltip
   *  uses — and in the game's own words: `MINIMAPALLYCOLORTOOLTIP` over its `_UBER` body,
   *  whose `|Cff…` runs are what paints "Allies" teal and "Enemies" red in the text. */
  private showAllyColorTooltip(): void {
    const title = this.driver.uiString("MINIMAPALLYCOLORTOOLTIP", "Set Ally Color Mode (|Cfffed312Alt-A|R)");
    const body = this.driver.uiString(
      "MINIMAPALLYCOLORTOOLTIP_UBER",
      "This option cycles through three different unit color modes.",
    );
    this.cmdTooltip.innerHTML =
      `<div class="hud-tooltip-title">${wc3ToHtml(title)}</div><div class="hud-tooltip-desc">${wc3ToHtml(body)}</div>`;
    this.cmdTooltip.hidden = false;
  }

  /**
   * The hero bar: up to seven buttons hanging down the screen's top-left corner.
   *
   * Built once, at full count, and shown/hidden per hero — the bar is a fixed ladder of slots
   * in the real game (the buttons distribute down it and never re-arrange), so nothing here
   * is re-created as heroes are hired or die.
   */
  private buildHeroBar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "hud-herobar";
    // Every size the bar uses, handed to the stylesheet as a length so the whole thing scales
    // with the game's box (the 0.6-tall UI space maps to --stage-h) instead of the window.
    bar.style.setProperty("--hero-left", uiPx(HERO_BAR.left));
    bar.style.setProperty("--hero-top", uiPx(HERO_BAR.top));
    bar.style.setProperty("--hero-slot", uiPx(HERO_BAR.slot)); // the widget's ONE size (see HERO_BAR)
    for (let i = 0; i < HERO_BAR.max; i++) {
      const slot = document.createElement("div");
      slot.className = "hud-hero-slot";
      slot.hidden = true;
      const btn = document.createElement("button");
      btn.className = "hud-hero-btn";
      // Unspent skill points: `HeroLevel.mdx` over the portrait of the hero that has one
      // waiting (ui/heroLevelFx.ts — war3skins names it `HeroBarPointModel`, which is this
      // button and nothing else), plus the count itself in the bottom-right corner, which is
      // what issue #95 asks for.
      const fx = this.heroLevelFx.makeOverlay();
      const points = countBadge(); // unspent skill points, bottom-right
      btn.append(points);
      const bars = document.createElement("div");
      bars.className = "hud-hero-bars";
      const hp = document.createElement("div");
      hp.className = "hud-hero-bar";
      const hpFill = document.createElement("div");
      hpFill.className = "hud-hero-fill";
      hp.appendChild(hpFill);
      const mana = document.createElement("div");
      mana.className = "hud-hero-bar";
      const manaFill = document.createElement("div");
      manaFill.className = "hud-hero-fill mana";
      mana.appendChild(manaFill);
      bars.append(hp, mana);
      // The effect goes in BEFORE the portrait and outside it, so it draws BEHIND: the button
      // paints an opaque icon over its own box, and what is left of the model is the part that
      // reaches past the portrait's edge — which is the whole of what the model is for. Two
      // positioned siblings with no z-index paint in tree order, so the order of this one line
      // is the entire mechanism.
      slot.append(fx, btn, bars);
      bar.appendChild(slot);
      this.heroSlots.push({ slot, btn, fx, points, bars, hp, mana, hpFill, manaFill });
      // A click selects that hero, a double-click also jumps the camera to it — the mouse
      // half of F1/F2/F3, which count in this same order. Bound through `onPress` so the
      // button sinks under the press exactly as a command-card button does.
      //
      // …unless an ITEM is in hand. Right-clicking an inventory slot picks the item up and
      // the next click spends it, and a hero's button stands in for the hero: clicking one
      // hands the item over, exactly as clicking that hero's body on the map does. The give
      // is tried first and only a refusal falls through to selecting.
      onPress(btn, () => {
        if (this.driver.dropItemOnHero(i)) {
          this.setArmed(false);
          this.refreshSelectionNow();
          return;
        }
        this.driver.selectHero(i, false);
        this.refreshSelectionNow();
      });
      btn.addEventListener("dblclick", () => this.driver.selectHero(i, true));
      // Right-click: rally a selected production building onto this hero — the same order a
      // right-click on its body in the world gives, without having to find the body.
      btn.oncontextmenu = (e) => {
        e.preventDefault();
        this.driver.rallyToHero(i);
      };
      // …and the drag half of handing an item over: drop an inventory icon on the portrait.
      // preventDefault on dragover is what marks the button as a drop target at all.
      btn.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types.includes(INV_DRAG_TYPE)) e.preventDefault();
      });
      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        const raw = e.dataTransfer?.getData(INV_DRAG_TYPE) ?? "";
        const slot = Number(raw);
        if (raw === "" || !Number.isInteger(slot)) return; // not one of ours — `Number("")` is 0
        this.driver.dropItemOnHero(i, slot);
        this.refreshSelectionNow();
      });
    }
    return bar;
  }

  /** Push the current heroes onto the bar's slots. Called every frame: seven slots of
   *  bar widths is cheaper than working out whether anything moved. */
  private refreshHeroBar(): void {
    const heroes = this.driver.heroBar();
    for (let i = 0; i < this.heroSlots.length; i++) {
      const s = this.heroSlots[i];
      const h: HeroBarEntry | undefined = heroes[i];
      if (!h) {
        s.slot.hidden = true;
        continue;
      }
      s.slot.hidden = false;
      // A DEAD hero keeps its slot and wears the icon's own greyed twin — the same texture
      // swap a command button makes, and for the same reason (see disabledIconPath): the twin
      // is desaturated AND frameless, and losing the gold frame is most of what reads as
      // "you can't press this". Falls back to the live art for the icons that ship no twin.
      const art = h.dead ? (h.disabledIcon ?? h.icon) : h.icon;
      const url = art ? this.driver.blpUrl(art) : null;
      s.btn.style.backgroundImage = url ? `url(${url})` : "";
      s.slot.dataset.dead = h.dead ? "1" : "";
      // Its bars are gone with it — the whole CONTAINER, not the two bars inside it. A corpse
      // has no health to report (a bar sitting at zero reads as a hero about to die rather
      // than one already dead), and the frame the bars sit in is painted, so hiding only its
      // contents leaves an empty black box hanging under the portrait.
      s.bars.hidden = h.dead;
      s.hp.hidden = h.dead;
      s.mana.hidden = h.dead || h.manaFrac < 0; // a hero with no pool shows no mana bar
      if (!h.dead) {
        const hpFrac = Math.max(0, Math.min(1, h.hpFrac));
        s.hpFill.style.width = `${hpFrac * 100}%`;
        // WC3 tints every status bar green→yellow→red by fraction, the hero bar's included.
        s.hpFill.dataset.state = hpFrac > 0.6 ? "green" : hpFrac > 0.3 ? "yellow" : "red";
        s.manaFill.style.width = `${Math.max(0, Math.min(1, h.manaFrac)) * 100}%`;
      }
      // The revival countdown stands where the skill-point badge does — they cannot both be
      // true (a dead hero spends nothing), so one element says whichever is.
      const reviving = h.dead && h.reviveSecondsLeft > 0;
      s.fx.hidden = h.skillPoints <= 0;
      // …and only ONE of them wears the box. The count badge means "this many of a thing you
      // have" (see countBadge); a revival is a clock, and WC3 boxes no clock, so the
      // countdown keeps the bare numeral this slot used to draw for both.
      s.points.classList.toggle("plain", reviving);
      setCount(s.points, reviving ? String(h.reviveSecondsLeft) : h.skillPoints > 0 ? String(h.skillPoints) : "");
    }
  }

  /** Park the camera box over the ground the viewport is looking at (issue #112).
   *
   *  Everything is a percentage of the map picture, which is what makes the box carry both of
   *  the things it has to say without a single constant: it is proportional to the MAP (the
   *  same view is a small box on a big map) and it shrinks as the view ZOOMS IN, because the
   *  world rect the driver hands back is smaller. North-up, like everything else here, so the
   *  rect's TOP edge is its maximum world y. */
  private updateCameraRect(): void {
    const el = this.camRect;
    if (!el) return;
    const [ox, oy, w, h] = this.driver.mapBounds();
    const r = this.driver.cameraRect();
    if (w <= 0 || h <= 0 || !(r.w > 0) || !(r.h > 0)) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.left = `${((r.x - ox) / w) * 100}%`;
    el.style.top = `${(1 - (r.y + r.h - oy) / h) * 100}%`;
    el.style.width = `${(r.w / w) * 100}%`;
    el.style.height = `${(r.h / h) * 100}%`;
  }

  /** Contain-fit the map picture inside the minimap frame and centre it: scale it up
   *  until one axis touches the frame, never stretching the other past its aspect.
   *  CSS can't express this (`aspect-ratio` loses to an explicit width/height once
   *  max-width/max-height clamp), so the rect is measured here. */
  private fitMinimap(): void {
    const box = this.minimapBox, view = this.minimapView;
    if (!box || !view) return;
    const bw = box.clientWidth, bh = box.clientHeight;
    if (bw <= 0 || bh <= 0) return; // frame not laid out yet (e.g. HUD hidden)
    let w = bw, h = bw / this.minimapAspect;
    if (h > bh) { h = bh; w = bh * this.minimapAspect; }
    view.style.width = `${w}px`;
    view.style.height = `${h}px`;
  }

  private buildInfoPanel(skinned: boolean): { portraitWrap: HTMLDivElement; infoText: HTMLDivElement } {
    // Portrait: an animated 3D bust (the _portrait.mdx model) with the HP and
    // mana values as plain coloured numbers beneath it — exactly like the
    // original console (no bars under the portrait).
    this.portrait = document.createElement("div");
    this.portrait.className = "hud-portrait";
    this.portraitCanvasEl = document.createElement("canvas");
    this.portraitCanvasEl.className = "hud-portrait-canvas";
    this.portrait.appendChild(this.portraitCanvasEl);
    // Clicking the portrait snaps the camera to the unit; holding locks onto it.
    this.portrait.addEventListener("pointerdown", (e) => {
      this.portrait.setPointerCapture(e.pointerId);
      this.driver.focusSelected(true);
    });
    this.portrait.addEventListener("pointerup", () => this.driver.focusSelected(false));

    this.selHpText = document.createElement("div");
    this.selHpText.className = "hud-hp-value";
    this.selMpText = document.createElement("div");
    this.selMpText.className = "hud-mp-value";

    const portraitWrap = document.createElement("div");
    portraitWrap.className = "hud-portrait-wrap";
    portraitWrap.append(this.portrait);
    // With the console art up, the two numbers are NOT the portrait's neighbours — they are
    // the two strips the art cuts out of the SAME socket, under the arch and under each
    // other, each behind its own gold divider (issue #92). They get their own zones, placed
    // by buildConsole. Without an install there is no art to line up with, so the placeholder
    // console keeps them stacked on a plate under the bust.
    if (!skinned) {
      const values = document.createElement("div");
      values.className = "hud-portrait-values";
      values.append(this.selHpText, this.selMpText);
      portraitWrap.append(values);
    }

    // Info panel: dark rounded backdrop with the unit's name and its
    // damage / armor stats, like the original console detail area.
    const infoText = document.createElement("div");
    infoText.className = "hud-info-text";
    this.selName = document.createElement("div");
    this.selName.className = "hud-sel-name";

    // Construction / training progress: an icon of what's being made, a gold
    // status label, a progress bar, and the training queue slots (WC3 layout).
    this.progressWrap = document.createElement("div");
    this.progressWrap.className = "hud-progress-wrap";
    this.progressWrap.hidden = true;
    const statusLine = document.createElement("div");
    statusLine.className = "hud-status-line";
    this.statusIcon = document.createElement("div");
    this.statusIcon.className = "hud-status-icon";
    this.statusIcon.title = "Cancel";
    // Clicking the in-progress icon cancels the unit currently training (queue
    // slot 0) — only when it's a training job, never a building under construction.
    this.statusIcon.onclick = () => {
      if (this.queueTrainable) this.driver.runCommand("cancelqueue:0");
    };
    // The builder's button, under the building's own icon. An Orc peon builds from INSIDE the
    // structure, so while it is up there is no peon on the terrain to click — this is how you
    // get it back (and queue orders on it) without cancelling the build. `InfoPanelBuildingDetail.fdf`
    // defines no such frame — the panel there is name/description/armour/supply, the build
    // timer and the queue backdrop — so this button is ours rather than the original's.
    this.builderBtn = document.createElement("button");
    this.builderBtn.className = "hud-status-builder hud-iconbtn";
    this.builderBtn.title = "Select the worker building this";
    this.builderBtn.hidden = true;
    onPress(this.builderBtn, () => {
      const id = this.driver.selection()?.builderId ?? 0;
      if (!id) return;
      this.driver.selectSingle(id);
      this.refreshSelectionNow();
    });
    // Both icons live in one column so the placeholder console stacks them; with the console
    // art up they are each placed against the queue widget's own slots instead (style.css).
    const iconCol = document.createElement("div");
    iconCol.className = "hud-status-icons";
    iconCol.append(this.statusIcon, this.builderBtn);
    this.statusLabel = document.createElement("div");
    this.statusLabel.className = "hud-status-label";
    statusLine.append(iconCol, this.statusLabel);
    const track = document.createElement("div");
    track.className = "hud-progress";
    this.progressFill = document.createElement("div");
    this.progressFill.className = "hud-progress-fill";
    track.appendChild(this.progressFill);
    this.queueRow = document.createElement("div");
    this.queueRow.className = "hud-queue";
    for (let i = 0; i < 6; i++) {
      const slot = document.createElement("div");
      slot.className = "hud-queue-slot";
      // Queue slots hold positions 2..7 → queue indices 1..6. Clicking a filled
      // slot cancels that unit and refunds it.
      slot.onclick = () => {
        if (slot.classList.contains("filled")) this.driver.runCommand(`cancelqueue:${i + 1}`);
      };
      this.queueSlots.push(slot);
      this.queueRow.appendChild(slot);
    }
    this.progressWrap.append(statusLine, track, this.queueRow);

    // Sub-line (hero level) and the stat rows: attack/armor with their type
    // icons, and hero STR/AGI/INT with attribute icons — all real WC3 infocard
    // BLPs from the game data.
    this.selSub = document.createElement("div");
    this.selSub.className = "hud-sel-sub";
    // Hero XP / summon-timer bar with the label INSIDE it (level + experience, or
    // "Summoned Unit (Ns)"). Fill sits behind the centred text.
    this.xpBar = document.createElement("div");
    this.xpBar.className = "hud-xpbar";
    this.xpBar.hidden = true;
    this.xpFill = document.createElement("div");
    this.xpFill.className = "hud-xpbar-fill";
    this.xpText = document.createElement("div");
    this.xpText.className = "hud-xpbar-text";
    this.xpBar.append(this.xpFill, this.xpText);
    this.selStats = document.createElement("div");
    this.selStats.className = "hud-sel-stats";
    // Left column: Damage + Armor blocks (icon + "Label:" over the value). Right
    // column: ONE primary-attribute icon beside the three attribute value lines.
    this.attackStat = makeStatBlock("Damage");
    this.armorStat = makeStatBlock("Armor");
    const leftCol = document.createElement("div");
    leftCol.className = "hud-stat-col";
    leftCol.append(this.attackStat.row, this.armorStat.row);
    this.attrIconEl = document.createElement("div");
    this.attrIconEl.className = "hud-stat-icon hud-attr-primary-icon";
    this.attrLines = document.createElement("div");
    this.attrLines.className = "hud-attr-lines";
    this.strLine = document.createElement("div");
    this.agiLine = document.createElement("div");
    this.intLine = document.createElement("div");
    this.attrLines.append(this.strLine, this.agiLine, this.intLine);
    const rightCol = document.createElement("div");
    rightCol.className = "hud-attr-col";
    rightCol.append(this.attrIconEl, this.attrLines);
    const cols = document.createElement("div");
    cols.className = "hud-stat-cols";
    cols.append(leftCol, rightCol);
    this.selStats.append(cols);
    // Buff / aura / debuff icons, on their own line under the stat blocks and led by the
    // game's own label — `UI\FrameDef\InfoPanelStrings.fdf` COLON_STATUS "Status:", written
    // in the gold the other info-panel labels use (SimpleInfoPanelLabelTextTemplate,
    // FontColor 0.99 0.827 0.0705). The icons are the buffs' own `Buffart` BLPs and sit at
    // roughly two thirds the size of a Damage/Armor icon, as they do in the real console.
    this.selStatus = document.createElement("div");
    this.selStatus.className = "hud-sel-status";
    this.selStatus.hidden = true;
    const statusLabel = document.createElement("div");
    statusLabel.className = "hud-buff-label";
    statusLabel.textContent = "Status:";
    const statusIcons = document.createElement("div");
    statusIcons.className = "hud-buff-icons";
    for (let i = 0; i < 8; i++) {
      const slot = document.createElement("div");
      slot.className = "hud-buff-icon";
      slot.hidden = true;
      this.selStatusSlots.push(slot);
      statusIcons.appendChild(slot);
    }
    this.selStatus.append(statusLabel, statusIcons);
    this.selStats.append(this.selStatus);
    this.selCarry = document.createElement("div");
    this.selCarry.className = "hud-sel-carry";
    // Item description: shown (in place of the stat block) when a ground item is selected.
    this.selDesc = document.createElement("div");
    this.selDesc.className = "hud-sel-desc";
    this.selDesc.hidden = true;
    // Multi-selection grid: unit icons (grouped by type), each with an HP bar and — when
    // the unit has a pool — a mana bar under it; the focused sub-group is highlighted.
    // Clicking focuses that group. The selection itself is uncapped (issue #109), so the
    // grid steps down a tier every 12 units and the last slot carries a "+N" badge for
    // whatever doesn't fit.
    this.selGrid = document.createElement("div");
    this.selGrid.className = "hud-sel-grid";
    this.selGrid.hidden = true;
    for (let i = 0; i < SEL_GRID_MAX; i++) {
      const slot = document.createElement("button");
      slot.className = "hud-sel-icon";
      // Art on top, then the bars UNDER it — HP first, mana below it — rather than laid
      // over the picture. Each bar is the same thing the world draws over a unit: the black
      // frame with the game's own `human-healthbar-fill.blp` slab inside it (see
      // STATBAR_FILL / applyStatBarSkin), so a group icon and the unit it stands for wear
      // the same art.
      const art = document.createElement("div");
      art.className = "hud-sel-icon-art";
      const more = document.createElement("span");
      more.className = "hud-sel-icon-more";
      more.hidden = true;
      art.appendChild(more);
      const hpTrack = document.createElement("div");
      hpTrack.className = "hud-sel-icon-track";
      const hp = document.createElement("div");
      hp.className = "hud-sel-icon-fill";
      hpTrack.appendChild(hp);
      const manaTrack = document.createElement("div");
      manaTrack.className = "hud-sel-icon-track";
      manaTrack.hidden = true; // no pool, no bar — the icon is just that much shorter
      const mana = document.createElement("div");
      mana.className = "hud-sel-icon-fill mana";
      manaTrack.appendChild(mana);
      slot.append(art, hpTrack, manaTrack);
      this.selGridSlots.push(slot);
      this.selGridBars.push({ art, hp, manaTrack, mana, more });
      this.selGrid.appendChild(slot);
    }
    infoText.append(this.selName, this.selSub, this.xpBar, this.progressWrap, this.selStats, this.selDesc, this.selCarry, this.selGrid);
    return { portraitWrap, infoText };
  }

  private buildInventory(skinned: boolean): HTMLDivElement {
    const inv = document.createElement("div");
    inv.className = "hud-inventory";
    if (!skinned) {
      // The console art draws its own inventory title.
      const title = document.createElement("div");
      title.className = "hud-inv-title";
      title.textContent = "Inventory";
      inv.appendChild(title);
    }
    const grid = document.createElement("div");
    grid.className = "hud-inv-grid";
    if (skinned) {
      // The six pockets are the art's six painted frames, divided the way its gutters do —
      // the same rule the command card lives under, and for the same reason: an icon that
      // does not sit ON its frame reads as a misprint. (This grid used to be a flat 4px gap
      // on a pitch of its own, which walked every slot but the middle row off the art.)
      grid.style.columnGap = `${INVENTORY_GAP.col * 100}%`;
      grid.style.rowGap = `${INVENTORY_GAP.row * 100}%`;
    }
    // 6 inventory slot buttons (2×3), each with a persistent icon background, a
    // charge-count badge and a radial cooldown overlay (kept as children so a
    // per-frame refresh never wipes them). Left-click uses/arms; right-click drops.
    this.invSlots = [];
    this.invCount = [];
    this.invCdOverlay = [];
    this.invCdText = [];
    for (let i = 0; i < 6; i++) {
      const btn = document.createElement("button");
      btn.className = "hud-slot hud-inv-slot empty";
      // NOT `disabled` — an empty slot must still take a click, because that's how
      // you move a carried item INTO it. `.empty` styles it as inert instead.
      const cd = document.createElement("div");
      cd.className = "hud-cmd-cd";
      cd.hidden = true;
      const cdText = document.createElement("span");
      cdText.className = "hud-cmd-cd-text";
      cd.appendChild(cdText);
      const count = countBadge();
      btn.append(cd, count);
      onPress(btn, () => this.driver.useInventory(i));
      btn.oncontextmenu = (e) => {
        e.preventDefault();
        this.driver.moveInventory(i);
      };
      // Drag an item OUT of the pocket and onto another hero's button in the top-left bar to
      // hand it over. The slot index is the whole payload; where it lands decides what
      // happens (see the hero bar's `drop`). Only a slot holding something can be dragged —
      // `refreshInventory` sets `draggable` per slot as items come and go.
      btn.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData(INV_DRAG_TYPE, String(i));
        e.dataTransfer.effectAllowed = "move";
      });
      // A slot with no item shows nothing (WC3 doesn't tooltip an empty pocket).
      btn.onpointerenter = () => this.showItemTooltip(i);
      btn.onpointerleave = () => {
        this.invHover = -1;
        this.cmdTooltip.hidden = true;
      };
      grid.appendChild(btn);
      this.invSlots.push(btn);
      this.invCount.push(count);
      this.invCdOverlay.push(cd);
      this.invCdText.push(cdText);
    }
    inv.appendChild(grid);
    return inv;
  }

  /** Item tooltip for inventory slot `i`. Every HUD tooltip — ability, order,
   *  build, item — is the SAME slab in the SAME place, above the command card, so
   *  the eye never has to hunt for it. An empty slot shows nothing.
   *
   *  Title and footer follow the game's own format strings (UI\FrameDef\GlobalStrings.fdf):
   *  ITEM_NAME_HOTKEY "%s (|cfffed312NumPad %u|r)" and, for anything with an active
   *  effect, ITEM_USE_TOOLTIP "|CFFFED312Left-Click to Use|R". The remaining charges
   *  live on the slot's corner badge, as in WC3 — not in the name. */
  private showItemTooltip(i: number): void {
    this.invHover = i;
    const s = this.driver.inventory()[i] ?? null;
    if (!s) {
      this.cmdTooltip.hidden = true;
      return;
    }
    const title = wc3ToHtml(`${s.name} (|cfffed312NumPad ${INVENTORY_NUMPAD[i]}|r)`);
    const desc = s.desc ? `<div class="hud-tooltip-desc">${wc3ToHtml(s.desc)}</div>` : "";
    const use = s.usable ? `<div class="hud-tooltip-desc">${wc3ToHtml("|cfffed312Left-Click to Use|r")}</div>` : "";
    this.cmdTooltip.innerHTML = `<div class="hud-tooltip-title">${title}</div>${desc}${use}`;
    this.cmdTooltip.hidden = false;
  }

  /** Rebuild the hero inventory slots from the driver's current inventory. Cheap
   *  enough to run each frame; only touches the DOM when a slot changed. */
  private refreshInventory(): void {
    const inv = this.driver.inventory();
    // No inventory at all (rts.inventorySlots() returns nothing for a unit that has no
    // pockets, which in melee means everything but a hero) — the console wears its crest
    // instead, exactly as the real client does.
    this.invCover.hidden = inv.length > 0;
    // Cooldown sweep every frame (cheap; the diff key ignores cooldown).
    for (let i = 0; i < this.invSlots.length; i++) {
      const s = inv[i] ?? null;
      const cd = this.invCdOverlay[i];
      if (s && s.cooldownLeft > 0) {
        cd.hidden = false;
        const elapsedDeg = (1 - s.cooldownFrac) * 360;
        cd.style.background = `conic-gradient(transparent 0deg ${elapsedDeg}deg, rgba(0,0,0,0.62) ${elapsedDeg}deg 360deg)`;
        this.invCdText[i].textContent = cdSeconds(s.cooldownLeft);
      } else {
        cd.hidden = true;
      }
    }
    const key = inv.map((s) => (s ? `${s.icon ? 1 : 0}:${s.name}:${s.charges}` : "-")).join("|");
    if (key === this.invKey) return;
    this.invKey = key;
    for (let i = 0; i < this.invSlots.length; i++) {
      const btn = this.invSlots[i];
      const s = inv[i] ?? null;
      if (!s) {
        btn.classList.add("empty");
        btn.style.backgroundImage = "";
        btn.draggable = false; // nothing in the pocket to drag onto a hero's portrait
        setCount(this.invCount[i], "");
        continue;
      }
      btn.classList.remove("empty");
      btn.style.backgroundImage = s.icon ? `url(${s.icon})` : "";
      btn.draggable = true;
      setCount(this.invCount[i], s.charges > 0 ? String(s.charges) : "");
    }
    // The slot under the cursor just changed (a charge spent, the item swapped or
    // used up) — re-render its tooltip in place rather than leave a stale one.
    if (this.invHover >= 0) this.showItemTooltip(this.invHover);
  }

  private buildCommandCard(): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "hud-command";
    // Tooltip shown above the card on hover (name + hotkey + cost + description).
    this.cmdTooltip = document.createElement("div");
    this.cmdTooltip.className = "hud-tooltip";
    this.cmdTooltip.hidden = true;
    card.appendChild(this.cmdTooltip);
    // 12 fixed slots (4×3); contents are filled per selection each frame. Each
    // slot carries a persistent fallback-text label + a radial cooldown overlay
    // (kept as children so a card rebuild never wipes them).
    this.cmdSlots = [];
    this.cmdLabels = [];
    this.cmdCdOverlay = [];
    this.cmdCdText = [];
    this.cmdCount = [];
    this.cmdFx = [];
    for (let i = 0; i < 12; i++) {
      const btn = document.createElement("button");
      btn.className = "hud-slot hud-cmd";
      btn.disabled = true;
      const label = document.createElement("span");
      label.className = "hud-cmd-label";
      const cd = document.createElement("div");
      cd.className = "hud-cmd-cd";
      cd.hidden = true;
      const cdText = document.createElement("span");
      cdText.className = "hud-cmd-cd-text";
      cd.appendChild(cdText);
      // Corner count badge — the shop's stock, the mercenary camp's, the learn-skill
      // button's unspent points. A persistent child so a card rebuild never wipes it, like
      // the label/cooldown nodes.
      const count = countBadge();
      // …and the "standing on" sparkle, likewise persistent. Last child so it draws over the
      // icon and the cooldown sweep, exactly as the model does over the button in the game.
      const fx = this.modalFx.makeOverlay();
      btn.append(label, cd, count, fx);
      this.cmdFx.push(fx);
      card.appendChild(btn);
      this.cmdSlots.push(btn);
      this.cmdLabels.push(label);
      this.cmdCdOverlay.push(cd);
      this.cmdCdText.push(cdText);
      this.cmdCount.push(count);
    }
    return card;
  }

  /** Rebuild the command-card buttons from the driver's current command list.
   *  Cheap enough to run each frame; skips work when nothing changed. */
  private refreshCommandCard(): void {
    const cmds = this.driver.commandCard();
    this.updateCooldownOverlays(cmds); // every frame (cheap) — cmdKey ignores cooldown
    // `desc` is part of the key: a button can keep every other property and still have new
    // TEXT — a tavern hero stays greyed while its red "Requires:" line goes from "Altar of
    // Storms, Stronghold" to "Stronghold" the moment the altar goes up. Leave it out and the
    // tooltip keeps showing the requirement the player has just met.
    const key = cmds.map((c) => `${c.id}:${c.disabled}:${!!c.cantAfford}:${!!c.noMana}:${c.active}:${c.modal}:${c.count ?? 0}:${c.desc}`).join("|");
    if (key === this.cmdKey) return;
    this.cmdKey = key;
    // The card changed (e.g. a building was cancelled and its buttons vanished):
    // hide any hover tooltip so it doesn't linger over the now-empty slot — a
    // removed button never fires pointerleave. An inventory hover owns the same
    // slab and its slot didn't go anywhere, so leave that one alone.
    if (this.invHover < 0) this.cmdTooltip.hidden = true;
    for (let i = 0; i < this.cmdSlots.length; i++) {
      const btn = this.cmdSlots[i];
      btn.disabled = true;
      btn.style.backgroundImage = "";
      btn.classList.remove("armed", "modal", "dis-art", "unavailable", "passive", "no-mana");
      this.cmdFx[i].hidden = true;
      this.cmdLabels[i].textContent = "";
      setCount(this.cmdCount[i], "");
      onPress(btn, null);
      btn.onpointerenter = null;
      btn.onpointerleave = null;
    }
    for (const c of cmds) {
      const idx = c.row * 4 + c.col;
      const btn = this.cmdSlots[idx];
      if (!btn) continue;
      btn.disabled = false;
      btn.classList.toggle("armed", c.active);
      // The sparkle reaches a little past the icon (the model's emitters walk the button's own
      // edge), so a lit slot stops clipping its children for as long as it is lit.
      btn.classList.toggle("modal", !!c.modal);
      this.cmdFx[idx].hidden = !c.modal;
      // Only ONE of the two unavailable states shows at all. `disabled` — a prerequisite
      // is missing — is a texture swap in the original, not a tint: the engine draws the
      // icon's `CommandButtonsDisabled\DIS*` twin, desaturated and with no gold button
      // frame. `.dis-art` says that art is on screen so the CSS leaves it alone; without a
      // twin the stylesheet desaturates the live art instead, off `.unavailable`.
      //
      // `cantAfford` draws NOTHING. A price is not a lock: the thing is unlocked, the
      // button takes the click, and the click is what earns "Not enough gold." — which is
      // the answer, said out loud. The only mark WC3 puts on the screen for it is the
      // reddened cost number in the tooltip (showTooltip's `short`).
      //
      // MANA is the exception, and it is a third state rather than either of these: the
      // icon is multiplied by a deep blue (`.no-mana`) while the button stays live. Only
      // the ART is tinted, so it rides with `dis-art`/`unavailable` rather than replacing
      // them — a DIS* swap already means something else and wins the tile.
      const disArt = c.disabled ? c.disabledIcon ?? null : null;
      btn.classList.toggle("dis-art", !!disArt);
      btn.classList.toggle("unavailable", c.disabled);
      btn.classList.toggle("passive", !!c.passive);
      // The tint is a multiply over the ICON, so it needs one there: a button falling back
      // to its 4-letter name has no art to darken and would just turn into a blue tile.
      btn.classList.toggle("no-mana", !!c.noMana && !c.disabled && !!c.icon);
      if (disArt || c.icon) btn.style.backgroundImage = `url(${disArt ?? c.icon})`;
      else this.cmdLabels[idx].textContent = wc3StripMarkup(c.name).slice(0, 4); // 4 chars of NAME, not of "|cff…"

      if (c.count && c.count > 0) setCount(this.cmdCount[idx], String(c.count));
      // A passive takes no press — it's an indicator, so it never sinks and never
      // fires. Nor does an UNAVAILABLE button: WC3's greyed DISBTN state is inert,
      // and letting the click through is how a Barracks you have no Great Hall for
      // still got built (issue #98). Both keep their tooltip: reading what Critical
      // Strike does, or which building the Guard Tower is waiting on, is the whole
      // reason the button is on the card at all. A `cantAfford` button is NOT inert —
      // its click is what earns the "Not enough gold." line.
      //
      // The RIGHT button is bound through the same call, because on the one kind of button
      // that has a second meaning it is the same kind of gesture: an autocast toggle sinks
      // under the press and flips when you let go (issue #106). `contextmenu` still fires on
      // a right-press and still has to be swallowed, or the browser's menu opens over the
      // card and eats the release that was going to confirm it.
      const inert = c.passive || c.disabled;
      onPress(
        btn,
        inert ? null : () => this.driver.runCommand(c.id),
        inert || !c.altId ? null : () => this.driver.runCommand(c.altId!),
      );
      btn.oncontextmenu = (e) => e.preventDefault();
      btn.onpointerenter = () => this.showTooltip(c);
      btn.onpointerleave = () => (this.cmdTooltip.hidden = true);
    }
  }

  /** Per-frame: draw a clockwise dark radial sweep + a seconds count over any
   *  ability button that's on cooldown (WC3-style). */
  private updateCooldownOverlays(cmds: CommandButton[]): void {
    for (const cd of this.cmdCdOverlay) cd.hidden = true;
    for (const c of cmds) {
      if (!c.cooldownLeft || c.cooldownLeft <= 0) continue;
      const idx = c.row * 4 + c.col;
      const cd = this.cmdCdOverlay[idx];
      if (!cd) continue;
      cd.hidden = false;
      // The revealed (elapsed) wedge grows clockwise from the top; the dark part
      // is what's still on cooldown.
      const elapsedDeg = (1 - (c.cooldownFrac ?? 0)) * 360;
      cd.style.background = `conic-gradient(transparent 0deg ${elapsedDeg}deg, rgba(0,0,0,0.62) ${elapsedDeg}deg 360deg)`;
      this.cmdCdText[idx].textContent = cdSeconds(c.cooldownLeft);
    }
  }

  /** A command tooltip, built the way the game builds it: the `Tip` string as the
   *  title (its markup already gilds the hotkey letter and prefixes "Train"/"Build"),
   *  then a cost row of ToolTip*Icon glyphs, then the `Ubertip` body with its colour
   *  runs and `|n` breaks intact. Where a button has no game string behind it (the
   *  hand-written Move/Stop/… orders) the name + hotkey stand in. */
  private showTooltip(c: CommandButton): void {
    const title = c.tip ? wc3ToHtml(c.tip) : highlightHotkey(c.id.startsWith("build:") ? `Build ${c.name}` : c.name, c.hotkey);
    const r = this.driver.resources();
    const sel = this.driver.selection();
    const costs =
      this.costItem("gold", c.gold, r.gold) +
      this.costItem("lumber", c.lumber, r.lumber) +
      this.costItem("supply", c.food, r.foodMax - r.foodUsed) +
      this.costItem("mana", c.mana ?? 0, sel?.mana ?? 0);
    const cost = costs ? `<div class="hud-tooltip-cost">${costs}</div>` : "";
    this.cmdTooltip.innerHTML =
      `<div class="hud-tooltip-title">${title}</div>${cost}<div class="hud-tooltip-desc">${wc3ToHtml(c.desc)}</div>`;
    this.cmdTooltip.hidden = false;
  }

  // --- per-frame updates ----------------------------------------------------

  private updateTexts(): void {
    const r = this.driver.resources();
    // WC3 upkeep brackets: 0–50 none, 51–80 low, 81+ high (upkeepBand).
    const band = upkeepBand(r.foodUsed);
    this.driver.setResources({
      gold: String(Math.floor(r.gold)),
      lumber: String(Math.floor(r.lumber)),
      supply: `${r.foodUsed}/${r.foodMax}`,
      upkeep: UPKEEP_LABEL[band],
      upkeepColor: [UPKEEP_COLORS.none, UPKEEP_COLORS.low, UPKEEP_COLORS.high][band],
    });

    const sel = this.driver.selection();
    this.portrait.classList.toggle("empty", !sel);
    if (!sel || this.driver.selectionIcons().length > 0) this.xpBar.hidden = true; // no single hero shown
    if (sel) {
      // A hero is titled by its GIVEN name ("Painkiller"); its class ("Demon Hunter")
      // is what the XP bar spells out below, as "Level 1 Demon Hunter".
      // The NAME carries WC3's own markup and the game draws it: a custom map colours its
      // unit names in the object editor (Candy War's "|cffffaa00Boogie Kid"), and printing the
      // raw string put the code on screen instead of the colour on the name.
      this.selName.innerHTML = wc3ToHtml(sel.isHero && sel.properName ? sel.properName : sel.name);
      this.selHpText.textContent = poolReadout(Math.ceil(sel.hp), sel.maxHp);
      this.selMpText.textContent = poolReadout(Math.floor(sel.mana), sel.maxMana);
      const icons = this.driver.selectionIcons();
      if (icons.length > 0) {
        this.showSelectionGrid(icons);
        return;
      }
      this.selGrid.hidden = true;
      this.selDesc.hidden = true; // only the item branch shows it
      this.xpBar.hidden = true; // only the hero-stats branch below re-shows it
      const constructing = sel.underConstruction;
      const training = sel.isBuilding && !constructing && sel.queueLength > 0;
      this.queueTrainable = training; // reset every frame so a stale flag can't fire a cancel
      if (sel.isItem) {
        // Ground item: show its name (set above) + description instead of any stats.
        this.progressWrap.hidden = true;
        this.selStats.hidden = true;
        this.selSub.textContent = "";
        this.selCarry.hidden = true;
        this.selDesc.hidden = false;
        this.selDesc.innerHTML = wc3ToHtml(sel.description); // Ubertip markup, as in-game
        this.attrIconEl.hidden = true;
        this.attrLines.hidden = true;
      } else if (sel.isMine) {
        // Gold mine: show its remaining gold, no progress/combat stats.
        this.progressWrap.hidden = true;
        this.selStats.hidden = true;
        this.selSub.textContent = "";
        this.selCarry.hidden = false;
        this.selCarry.textContent = `Gold: ${sel.goldRemaining}`;
      } else if (constructing || training) {
        // Progress display replaces the stat lines.
        this.progressWrap.hidden = false;
        // A structure going up trains nothing, so the queue widget's six numbered slots are
        // six lies — and the peon's button sits in the first of them. The backdrop art comes
        // off entirely while it is under construction; what stays is the building's icon, the
        // builder's button under it, and the bar (all three carry their own art).
        this.progressWrap.classList.toggle("constructing", constructing);
        this.selStats.hidden = true;
        this.selSub.textContent = "";
        this.selCarry.hidden = true;
        // Label the job and the seconds left on it, e.g. "Training (12s)".
        const secs = Math.max(0, Math.ceil(sel.secondsLeft));
        this.statusLabel.textContent = `${constructing ? "Constructing" : "Training"} (${secs}s)`;
        const frac = Math.max(0, Math.min(1, constructing ? sel.buildProgress : sel.trainProgress));
        this.progressFill.style.width = `${frac * 100}%`;
        // Status icon: the building (constructing) or the unit being trained.
        // Only a training job's icon is click-to-cancel (construction has its own
        // Cancel button) — queueTrainable (set above) gates the click handler.
        const iconPath = constructing ? sel.icon : sel.queue[0]?.icon ?? sel.icon;
        const url = iconPath ? this.driver.blpUrl(iconPath) : null;
        this.statusIcon.style.backgroundImage = url ? `url(${url})` : "";
        this.statusIcon.style.visibility = url ? "visible" : "hidden";
        this.statusIcon.classList.toggle("clickable", training);
        // The peon walled into the site (Orc only — nothing else builds from inside), as a
        // button that selects it. Its art is the icon's own, frame included, so there is no
        // border of ours around it.
        const bUrl = sel.builderId && sel.builderIcon ? this.driver.blpUrl(sel.builderIcon) : null;
        this.builderBtn.hidden = !bUrl;
        this.builderBtn.style.backgroundImage = bUrl ? `url(${bUrl})` : "";
        // Queue slots hold positions 2..7 (the current unit is above the bar).
        this.queueRow.hidden = !training;
        if (training) {
          const rest = sel.queue.slice(1);
          this.queueSlots.forEach((slot, i) => {
            const q = rest[i];
            const qUrl = q?.icon ? this.driver.blpUrl(q.icon) : null;
            if (qUrl) {
              slot.style.backgroundImage = `url(${qUrl})`;
              slot.textContent = "";
              slot.classList.add("filled");
            } else {
              slot.style.backgroundImage = "";
              slot.textContent = String(i + 2);
              slot.classList.remove("filled");
            }
          });
        }
      } else {
        // Unit / hero: attack + armor rows with their real WC3 type icons, and
        // STR/AGI/INT with attribute icons for heroes.
        this.progressWrap.hidden = true;
        this.selStats.hidden = false;
        this.selCarry.hidden = false;
        // Hero: level + experience shown INSIDE the purple XP bar; a summon shows
        // a green "Summoned Unit (Ns)" timer bar. The sub-line carries a skill-
        // point nudge for heroes.
        // A summon wins over the hero bar: a Mirror Image illusion IS a hero (it copies the
        // Blademaster exactly), but to its owner it must read as what it is — a temporary
        // copy on a 60s clock — not carry a hero's XP bar. To an ENEMY the same illusion
        // reports isSummon=false (rts.selectedInfo), so it keeps the XP bar and stays
        // indistinguishable from the real thing.
        if (sel.isHero && sel.level > 0 && !sel.isSummon) {
          const span = sel.xpNext - sel.xpThis;
          const into = Math.max(0, Math.round(sel.xp - sel.xpThis));
          this.selSub.textContent = ""; // level + XP live inside the bar; no extra label
          this.xpBar.hidden = false;
          this.xpBar.classList.remove("summon");
          // The bar reads "Level 1 Demon Hunter", as the game writes it; the raw XP
          // numbers are the bar's hover tooltip, not its label.
          this.xpText.innerHTML = `Level ${sel.level} ${wc3ToHtml(sel.name)}`;
          this.xpBar.title = span > 0 ? `Experience: ${into} / ${span}` : "Experience: (max level)";
          this.xpFill.style.width = `${span > 0 ? Math.max(0, Math.min(1, into / span)) * 100 : 100}%`;
        } else if (sel.isSummon) {
          this.selSub.textContent = "";
          this.xpBar.hidden = false;
          this.xpBar.classList.add("summon");
          this.xpBar.title = "";
          this.xpText.textContent = `Summoned Unit (${sel.summonSecondsLeft}s)`;
          this.xpFill.style.width = `${sel.summonFrac * 100}%`;
        } else {
          this.selSub.textContent = "";
          this.xpBar.hidden = true;
        }
        // Damage / Armor: base value + a green "+N" bonus from buffs/auras, and the owner's
        // upgrade LEVEL in the icon's corner box — 0 until the first research, then 1/2/3
        // (issue #113). A NEGATIVE level means no research of that class reaches this unit at
        // all (rts.upgradeBoxes): a hero, a worker, a creep, a gold mine. Those get the
        // BOXLESS art and print nothing, rather than an empty recess or a 0 that could never
        // become a 1. Blizzard drew that case rather than leaving it to us —
        // `infocard-armor-hero.blp`, the icon every hero's armour row uses, is the one armour
        // icon with no corner box, and the one with no `neutral-` twin because it needs none.
        const attackBox = sel.attackUpgrade >= 0;
        const armorBox = sel.armorUpgrade >= 0;
        if (sel.damageMax > 0) {
          this.attackStat.row.hidden = false;
          this.setIcon(this.attackStat.icon, infocard("attack", sel.attackType, !attackBox));
          this.attackStat.level.textContent = attackBox ? String(sel.attackUpgrade) : "";
          this.attackStat.value.innerHTML = `${sel.damageMin} - ${sel.damageMax}${bonusHtml(sel.damageBonus)}`;
        } else {
          this.attackStat.row.hidden = true;
        }
        this.armorStat.row.hidden = false;
        this.setIcon(this.armorStat.icon, infocard("armor", sel.armorType, !armorBox));
        this.armorStat.level.textContent = armorBox ? String(sel.armorUpgrade) : "";
        // Invulnerable REPLACES the armour value rather than sitting under it (issue #26 got
        // this half right). The game keeps it in the same string table as the panel's other
        // values — `UI\FrameDef\InfoPanelStrings.fdf` INVULNERABLE, "|Cffff0000Invulnerable|R"
        // — a value-shaped string carrying its own colour, which is what a field gets
        // substituted with. A number is also the wrong thing to print: an immune unit's armour
        // does not reduce anything, because nothing is being reduced.
        this.armorStat.value.innerHTML = sel.invulnerable
          ? `<span class="hud-stat-invuln">Invulnerable</span>`
          : `${sel.armor}${bonusHtml(sel.armorBonus)}`;
        // Hero attributes: ONE primary-attribute icon beside the three value lines.
        if (sel.isHero) {
          this.attrIconEl.hidden = false;
          this.attrLines.hidden = false;
          const prim = sel.primaryAttr === PrimaryAttribute.Agility ? "agi" : sel.primaryAttr === PrimaryAttribute.Intelligence ? "int" : "str";
          this.setIcon(this.attrIconEl, attrIcon(prim));
          this.strLine.innerHTML = attrLineHtml("Strength", sel.strength, sel.strengthBonus);
          this.agiLine.innerHTML = attrLineHtml("Agility", sel.agility, sel.agilityBonus);
          this.intLine.innerHTML = attrLineHtml("Intelligence", sel.intelligence, sel.intelligenceBonus);
        } else {
          this.attrIconEl.hidden = true;
          this.attrLines.hidden = true;
        }
        this.renderStatus(sel.buffs);
        this.selCarry.textContent =
          sel.carryGold > 0 ? `Carrying ${sel.carryGold} gold` : sel.carryLumber > 0 ? `Carrying ${sel.carryLumber} lumber` : "";
      }
    } else {
      this.selName.textContent = "";
      this.selSub.textContent = "";
      this.selHpText.textContent = "";
      this.selMpText.textContent = "";
      this.selStats.hidden = true;
      this.selCarry.textContent = "";
      this.progressWrap.hidden = true;
      this.selGrid.hidden = true;
      this.selDesc.hidden = true; // clearing the selection also clears a shown item description
    }
  }

  /** Render the multi-selection grid; the focused sub-group is highlighted. */
  private showSelectionGrid(icons: ReturnType<HudDriver["selectionIcons"]>): void {
    this.selGrid.hidden = false;
    this.selStats.hidden = true;
    this.selSub.textContent = "";
    this.progressWrap.hidden = true;
    this.selCarry.hidden = true;
    this.selDesc.hidden = true; // a multi-unit recall (e.g. a control group) replaces a selected item
    // Pick the tier the selection's size falls in and hand the CSS its two numbers; a
    // selection past the last tier stays on it and spends its final slot on the "+N".
    const tier = SEL_GRID_TIERS.find((t) => icons.length <= t.max) ?? SEL_GRID_TIERS[SEL_GRID_TIERS.length - 1];
    this.selGrid.style.setProperty("--sel-cols", String(tier.cols));
    this.selGrid.style.setProperty("--sel-bar", `${tier.bar}px`);
    this.selGrid.style.setProperty("--sel-gap", `${tier.gap}px`);
    const overflow = Math.max(0, icons.length - SEL_GRID_MAX);
    this.selGridSlots.forEach((slot, i) => {
      const ic = icons[i];
      const bars = this.selGridBars[i];
      if (!ic || i >= tier.max) {
        slot.hidden = true;
        onPress(slot, null);
        slot.ondblclick = null;
        return;
      }
      slot.hidden = false;
      const url = ic.icon ? this.driver.blpUrl(ic.icon) : null;
      bars.art.style.backgroundImage = url ? `url(${url})` : "";
      slot.classList.toggle("focused", ic.focused);
      const frac = Math.max(0, Math.min(1, ic.hpFrac));
      // The slab is drawn across the WHOLE track and CLIPPED to the fraction — the same rule
      // the floating bars follow, so the art's shading stays put as the bar drains instead of
      // squashing with it. Clip rather than width because the grid's tracks have no fixed
      // pixel width to bake a background-size from.
      bars.hp.style.clipPath = `inset(0 ${(1 - frac) * 100}% 0 0)`;
      // Green→yellow→red by HP fraction, at WC3's thresholds (render/worldOverlays.ts). The
      // tint is baked into the fill art, so the state picks an image rather than a colour.
      bars.hp.dataset.state = frac > 0.6 ? "green" : frac > 0.3 ? "yellow" : "red";
      // Mana, under the HP bar, only for a unit that has a pool (issue #109) — the same
      // -1 = "no pool" contract the hero bar uses.
      bars.manaTrack.hidden = ic.manaFrac < 0;
      bars.mana.style.clipPath = `inset(0 ${(1 - Math.max(0, Math.min(1, ic.manaFrac))) * 100}% 0 0)`;
      // Only the very last drawn icon can carry the overflow count.
      const showMore = overflow > 0 && i === SEL_GRID_MAX - 1;
      bars.more.hidden = !showMore;
      if (showMore) bars.more.textContent = `+${overflow}`;
      // A click with a spell/attack armed targets this unit through the console;
      // Shift+click removes just this unit from the selection; otherwise a plain click
      // focuses this unit's sub-group (like Tab), and clicking again (group now focused)
      // drills down to just this unit.
      onPress(slot, (e) => {
        if (this.driver.tryTargetArmedAt(ic.simId)) {
          this.clearOrderMode();
          return;
        }
        if (e.shiftKey) {
          this.driver.deselectUnit(ic.simId);
          return;
        }
        this.driver.selectGridUnit(ic.simId);
        this.refreshSelectionNow();
      });
      slot.ondblclick = null;
    });
  }

  private setIcon(el: HTMLDivElement, path: string): void {
    const url = this.driver.blpUrl(path);
    el.style.backgroundImage = url ? `url(${url})` : "";
  }


  /** Render the active buff / aura / debuff icons on the Status line.
   *
   *  Hovering one tooltips it exactly as the game does — the buff's `Bufftip` as the title
   *  over its `Buffubertip` ("This unit has Bloodlust; its attack rate and movement speed are
   *  increased.") — in the same slab above the command card every other HUD tooltip uses. */
  private renderStatus(buffs: Array<{ icon: string; name: string; tip: string }>): void {
    this.selStatus.hidden = buffs.length === 0;
    for (let i = 0; i < this.selStatusSlots.length; i++) {
      const slot = this.selStatusSlots[i];
      const b = buffs[i];
      if (!b) {
        // A buff that expires under the cursor takes its tooltip with it — the slot is
        // hidden from under the pointer, so no pointerleave is guaranteed to arrive.
        if (this.buffHover === i) {
          this.buffHover = -1;
          this.cmdTooltip.hidden = true;
        }
        slot.hidden = true;
        slot.onpointerenter = null;
        slot.onpointerleave = null;
        continue;
      }
      slot.hidden = false;
      // Always art: a buff the panel has no icon for never reaches this row (rts.ts
      // statusBuffsFor drops it, following the data's own "not visible on the info card").
      const url = this.driver.blpUrl(b.icon);
      slot.style.backgroundImage = url ? `url(${url})` : "";
      slot.title = ""; // the slab below replaces the browser's own tooltip
      slot.onpointerenter = () => {
        this.buffHover = i;
        const desc = b.tip ? `<div class="hud-tooltip-desc">${wc3ToHtml(b.tip)}</div>` : "";
        this.cmdTooltip.innerHTML = `<div class="hud-tooltip-title">${wc3ToHtml(b.name)}</div>${desc}`;
        this.cmdTooltip.hidden = false;
      };
      slot.onpointerleave = () => {
        this.buffHover = -1;
        this.cmdTooltip.hidden = true;
      };
    }
  }

  private fogImage: ImageData | null = null; // reused fog-of-war mask (mmW × mmH)
  private mapGlyphs = new Map<string, HTMLImageElement>(); // BLP path → lazy-loaded glyph

  // --- minimap pings (7.24) --------------------------------------------------------
  // PingMinimap / PingMinimapEx: a marker that flashes at a world point for `duration`
  // seconds. WC3 uses one to point at a transmission's speaker (DoTransmissionBasicsXYBJ
  // pings for bj_TRANSMISSION_PING_TIME = 1 s) and every "look here!" a map wants.
  private pings: Array<MinimapPing & { age: number }> = [];

  /** Start a ping. `duration` ≤ 0 is WC3's "use the default", which is 5 seconds. */
  ping(p: MinimapPing): void {
    this.pings.push({ ...p, duration: p.duration > 0 ? p.duration : 5, age: 0 });
  }

  /** Age the live pings; true if any is still up (which forces a minimap redraw). */
  private agePings(dt: number): boolean {
    if (!this.pings.length) return false;
    for (const p of this.pings) p.age += dt;
    this.pings = this.pings.filter((p) => p.age < p.duration);
    return true;
  }

  private drawDots(): void {
    const ctx = this.dotsCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, this.mmW, this.mmH);
    const [ox, oy, w, h] = this.driver.mapBounds();
    this.paintFog(ctx, ox, oy, w, h); // black/grey fog under the markers (own units always shown)
    // Camp dots and map glyphs ride ON TOP of the fog veil, at full brightness and
    // whatever the fog says — the real client paints them from the opening frame.
    this.drawCreepCamps(ctx, ox, oy, w, h);
    this.drawMapGlyphs(ctx, ox, oy, w, h);
    // Unit dots last, so a creep's dot sits over whatever it is standing on. Neutral
    // passives are absent from dots() — a glyph, or nothing, marks those.
    const d = UNIT_DOT / 2;
    for (const dot of this.driver.dots()) {
      const p = this.toMini(dot.x, dot.y, ox, oy, w, h);
      if (!p) continue;
      // The friend-or-foe tone wins over the player colour when there is one: your own units
      // are `FogColorPlayer` white on your own minimap in EVERY mode, and an ally/enemy takes
      // the minimap's own teal/red from mode 2 up. All three are the game's own [FogOfWar]
      // palette, the same section the neutral dot below already comes from.
      ctx.fillStyle =
        dot.tone === "self"
          ? SELF_DOT_COLOR
          : dot.tone === "ally"
            ? ALLY_DOT_COLOR
            : dot.tone === "enemy"
              ? ENEMY_DOT_COLOR
              : dot.owner >= 0
                ? PLAYER_COLORS[dot.owner % PLAYER_COLORS.length]
                : NEUTRAL_DOT_COLOR;
      ctx.fillRect(p[0] - d, p[1] - d, UNIT_DOT, UNIT_DOT);
    }
    this.drawPings(ctx, ox, oy, w, h); // over everything: a ping is meant to be seen
  }

  /** A ping is a ring that expands and fades, once per PING_PULSE, for its duration. The
   *  "flashy" flag (PingMinimapEx's extraEffects) is WC3's louder ping — here, a second ring
   *  half a pulse out of phase, so it reads as a double blip against a busy minimap. */
  private drawPings(ctx: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number): void {
    const PING_PULSE = 0.5; // seconds per expand-and-fade cycle
    const PING_R = 0.06 * MINIMAP_SIZE; // the ring's full radius, in dots-canvas pixels
    for (const p of this.pings) {
      const c = this.toMini(p.x, p.y, ox, oy, w, h);
      if (!c) continue;
      const ring = (phase: number): void => {
        const t = ((p.age / PING_PULSE + phase) % 1 + 1) % 1;
        ctx.beginPath();
        ctx.arc(c[0], c[1], PING_R * t, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${p.r}, ${p.g}, ${p.b}, ${1 - t})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      };
      ring(0);
      if (p.extraEffects) ring(0.5);
      ctx.beginPath();
      ctx.arc(c[0], c[1], 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${p.r}, ${p.g}, ${p.b})`;
      ctx.fill();
    }
  }

  /** World point → minimap canvas pixel (north-up), or null if off-map. */
  private toMini(x: number, y: number, ox: number, oy: number, w: number, h: number): [number, number] | null {
    const u = (x - ox) / w, v = 1 - (y - oy) / h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return [u * this.mmW, v * this.mmH];
  }

  /** Creep-camp difficulty dots: a flat ellipse per camp, coloured and sized by the
   *  camp's combined level exactly as `UI\MiscData.txt` [Minimap] prescribes —
   *  green below level 10, orange to 19, red beyond, and 1.3× wide from 10 up. */
  private drawCreepCamps(ctx: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number): void {
    for (const camp of this.driver.creepCamps()) {
      const p = this.toMini(camp.x, camp.y, ox, oy, w, h);
      if (!p) continue;
      const { color, scale } = campMarker(camp.level);
      ctx.beginPath();
      ctx.arc(p[0], p[1], (CAMP_DOT * MINIMAP_SIZE * scale) / 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  /** Gold-mine and neutral-building glyphs (the real WC3 minimap art, once loaded). */
  private drawMapGlyphs(ctx: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number): void {
    const s = MAP_GLYPH * MINIMAP_SIZE; // glyph side in the dots canvas's pixel space
    for (const g of this.driver.minimapIcons()) {
      const img = this.mapGlyph(g.icon);
      if (!img?.complete || img.naturalWidth === 0) continue;
      const p = this.toMini(g.x, g.y, ox, oy, w, h);
      if (!p) continue;
      ctx.drawImage(img, p[0] - s / 2, p[1] - s / 2, s, s);
    }
  }

  /** Lazily fetch + cache a minimap glyph as a drawable image. */
  private mapGlyph(path: string): HTMLImageElement | null {
    const cached = this.mapGlyphs.get(path);
    if (cached) return cached;
    const url = this.driver.blpUrl(path);
    if (!url) return null; // asset missing — retry next frame, the archive may still be mounting
    const img = new Image();
    img.src = url;
    this.mapGlyphs.set(path, img);
    return img;
  }

  /** Paint the fog-of-war mask onto the minimap: unexplored is opaque black (hiding
   *  the terrain image behind), explored is a translucent grey veil (terrain shown,
   *  dimmed), and currently-visible is left clear. Written straight into an ImageData
   *  so it costs one putImageData per redraw (throttled to DOTS_PERIOD). */
  private paintFog(ctx: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number): void {
    const img = (this.fogImage ??= ctx.createImageData(this.mmW, this.mmH));
    const px = img.data;
    for (let py = 0; py < this.mmH; py++) {
      const wy = oy + (1 - py / this.mmH) * h; // minimap is north-up (v inverted)
      for (let x = 0; x < this.mmW; x++) {
        const wx = ox + (x / this.mmW) * w;
        const state = this.driver.fogAt(wx, wy);
        const a = state === 0 ? 255 : state === 1 ? 140 : 0; // black / grey veil / clear
        px[(py * this.mmW + x) * 4 + 3] = a; // RGB stay 0 → the veil is black
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

interface StatBlock { row: HTMLDivElement; icon: HTMLDivElement; level: HTMLDivElement; value: HTMLDivElement; }

/** A stat block: [icon] then "Label:" over the value line (WC3 info panel). */
function makeStatBlock(label: string): StatBlock {
  const row = document.createElement("div");
  row.className = "hud-stat-block";
  const icon = document.createElement("div");
  icon.className = "hud-stat-icon";
  // The upgrade level, printed INSIDE the icon's own bottom-right box — the art carries an
  // empty recess there and the game fills it with a number (`IconValue1..4`, anchored CENTER
  // on the icon's BOTTOMRIGHT in `InfoPanelUnitDetail.fdf`, white and centred per
  // InfoPanelAttributeTextTemplate). It is a child of the icon so it rides any resize of it.
  const level = document.createElement("div");
  level.className = "hud-stat-level";
  icon.appendChild(level);
  const text = document.createElement("div");
  text.className = "hud-stat-text";
  const lab = document.createElement("div");
  lab.className = "hud-stat-label";
  lab.textContent = `${label}:`;
  const value = document.createElement("div");
  value.className = "hud-stat-value";
  text.append(lab, value);
  row.append(icon, text);
  return { row, icon, level, value };
}
// A bonus span from buffs/auras/items: green "+N" when positive, red "-N" when
// negative (WC3 shows debuffed stats in red), empty when there's none.
function bonusHtml(bonus: number): string {
  if (bonus > 0) return ` <span class="stat-bonus">+${bonus}</span>`;
  if (bonus < 0) return ` <span class="stat-penalty">${bonus}</span>`; // `bonus` already carries the minus
  return "";
}
// An attribute block: a gold "Strength:" with the white value "34 +9" UNDER it, the item
// contribution as a green "+N" (red "-N" if the total is negative). Label over value is the
// same shape the Damage and Armor blocks use, so the panel's two columns read alike rather
// than one running its label and value together on a line. All three are identical; the
// primary attribute is named by the ICON beside them, not by the text.
function attrLineHtml(label: string, value: number, bonus: number): string {
  return `<span class="hud-attr-line"><span class="attr-name">${label}:</span><span class="attr-value">${value}${bonusHtml(bonus)}</span></span>`;
}

// WC3 infocard type icons (real BLPs under UI\Widgets\Console\Human\). Attack/
// armor types map onto the melee/piercing/… and small/medium/… icon set.
// Info-card art suffixes for each attack/armor type. WC3 ships one icon fewer than
// there are types on each side (UI\Widgets\Console\Human): the Spells attack reuses
// the Magic art, and Normal armour has no icon at all — no stock unit carries it. A
// weaponless unit, or one with no defType, falls back to melee / unarmored.
const ATTACK_ICON: Partial<Record<AttackType, string>> = {
  [AttackType.Normal]: "melee",
  [AttackType.Pierce]: "piercing",
  [AttackType.Siege]: "siege",
  [AttackType.Magic]: "magic",
  [AttackType.Chaos]: "chaos",
  [AttackType.Hero]: "hero",
  [AttackType.Spells]: "magic",
};
const ARMOR_ICON: Partial<Record<ArmorType, string>> = {
  [ArmorType.Small]: "small",
  [ArmorType.Medium]: "medium",
  [ArmorType.Large]: "large",
  [ArmorType.Fort]: "fortified",
  [ArmorType.Hero]: "hero",
  [ArmorType.Divine]: "divine",
  [ArmorType.None]: "unarmored",
};
/** The armour icons that have no `neutral-` twin in the archive.
 *
 *  `hero` needs none: it is the ONE armour icon Blizzard drew without a corner box in the
 *  first place, which is the art itself saying that a hero's armour has no upgrade level to
 *  print — a hero is touched by no `class = armor` research. That absence is the reason the
 *  boxless-twin argument holds; every other armour icon carries the box AND ships a twin.
 *  `divine` carries a box and has no twin, so it falls back to its own art rather than to a
 *  file that is not in the archive. */
const NO_BOXLESS_ARMOR_TWIN = new Set(["hero", "divine"]);

/** An info-card icon path.
 *
 *  `boxless` picks the art with no corner recess — the parallel `infocard-neutral-*` set,
 *  which is pixel-for-pixel the same icon minus the box the upgrade level is printed in. WC3
 *  ships it for the case where there is no level to report, exactly as it ships a `DIS*` twin
 *  rather than desaturating a live icon. Ask for it whenever nothing will be written in the
 *  box, or the panel shows an empty recess where a number ought to be. */
function infocard(kind: "attack", type: AttackType, boxless?: boolean): string;
function infocard(kind: "armor", type: ArmorType, boxless?: boolean): string;
function infocard(kind: "attack" | "armor", type: AttackType | ArmorType, boxless = false): string {
  const suffix =
    kind === "attack"
      ? (ATTACK_ICON[type as AttackType] ?? "melee")
      : (ARMOR_ICON[type as ArmorType] ?? "unarmored");
  const twin = boxless && !(kind === "armor" && NO_BOXLESS_ARMOR_TWIN.has(suffix));
  return `UI\\Widgets\\Console\\Human\\infocard-${twin ? "neutral-" : ""}${kind}-${suffix}.blp`;
}
function attrIcon(kind: "str" | "agi" | "int"): string {
  return `UI\\Widgets\\Console\\Human\\infocard-heroattributes-${kind}.blp`;
}

/** The console button currently held down, if any. Kept here rather than as per-element
 *  state so that a card rebuild mid-hold (onPress is re-bound every time the command list
 *  changes) can't lose track of the press. */
let pressedEl: HTMLElement | null = null;
/** Which mouse button began that press — 0 (left) or 2 (right). Only the button that started
 *  it can finish it: with both down, letting go of one must not fire the other's meaning. */
let pressedButton = 0;

/** Watch for the release that ENDS a console-button press, for the length of one console.
 *
 *  A release (or a cancelled pointer — a touch turning into a scroll, the window losing
 *  focus) that didn't land on the held button drops the press. The button's own handler runs
 *  first, at the target, so by the time these fire a confirmed press has already cleared
 *  itself. They hang on `window`, which outlives the match, so this hands back the detacher
 *  rather than registering once and forever: a dead console must not still be reading the
 *  page's pointer events, and `pressedEl` must not keep a button of it alive. */
function watchPress(): () => void {
  const drop = (): void => setPressed(null);
  window.addEventListener("pointerup", drop);
  window.addEventListener("pointercancel", drop);
  return () => {
    window.removeEventListener("pointerup", drop);
    window.removeEventListener("pointercancel", drop);
    setPressed(null);
  };
}

function setPressed(el: HTMLElement | null): void {
  if (pressedEl === el) return;
  pressedEl?.classList.remove("pressed");
  pressedEl = el;
  pressedEl?.classList.add("pressed");
}

/** Bind a console button to fire on RELEASE over the button, with the press itself
 *  only sinking the icon (see `.pressed` in style.css). We don't use a DOM `click`:
 *  that needs the press AND the release on the same element, so a fast click that
 *  drifts a pixel onto the frame art beside the button is swallowed — half of issue
 *  #44 — whereas here the press is ours the moment it lands and only the release
 *  point is checked. Let go anywhere else and the press is abandoned (the standard
 *  way to back out of a misclick), which `watchPress` above handles.
 *  preventDefault keeps the press from focusing the button, so a later Space/Enter
 *  can't re-fire it. Pass null to unbind a slot.
 *
 *  `alt` is the RIGHT button's meaning, and it is a press in exactly the same sense: an
 *  autocast button sinks under a right-press and flips on the release, so the toggle can be
 *  backed out of by sliding off it, just like an order. It used to hang off `contextmenu`
 *  instead, which is neither — the browser fires that at the press (and on some platforms at
 *  the release), so the flip happened at whichever end of the click the platform chose and
 *  the button never moved. The menu itself is still suppressed at the call site; that is all
 *  `contextmenu` is for. */
function onPress(
  el: HTMLElement,
  fn: ((e: PointerEvent) => void) | null,
  alt: ((e: PointerEvent) => void) | null = null,
): void {
  if (!fn && !alt) {
    el.onpointerdown = null;
    el.onpointerup = null;
    if (pressedEl === el) setPressed(null); // the slot's command went away mid-hold
    return;
  }
  const forButton = (b: number): ((e: PointerEvent) => void) | null => (b === 0 ? fn : b === 2 ? alt : null);
  el.onpointerdown = (e) => {
    if (!forButton(e.button)) return; // a button with no meaning here takes no press
    e.preventDefault();
    pressedButton = e.button;
    setPressed(el);
  };
  el.onpointerup = (e) => {
    // Released on a button we never pressed, or with the other mouse button.
    if (pressedEl !== el || e.button !== pressedButton) return;
    e.preventDefault();
    setPressed(null);
    forButton(e.button)?.(e);
  };
}

// Highlight the hotkey letter (first occurrence, case-insensitive) in gold inside
// the title, e.g. "Build <b>A</b>ltar of Kings" — the WC3 tooltip convention. Only
// needed for the buttons with no game `Tip` string behind them; a real Tip already
// carries `|cffffcc00`…`|r` around the letter.
function highlightHotkey(name: string, hotkey: string): string {
  // A name that carries its own markup is drawn AS the map wrote it — its colour is the
  // stronger signal than our hotkey bolding, and the two cannot be composed without mapping
  // offsets through the codes.
  if (/\|[cCrRnN]/.test(name)) return wc3ToHtml(name);
  if (!hotkey || hotkey.length !== 1) return escapeHtml(name);
  const idx = name.toUpperCase().indexOf(hotkey.toUpperCase());
  if (idx < 0) return escapeHtml(name);
  return escapeHtml(name.slice(0, idx)) + `<b>${escapeHtml(name[idx])}</b>` + escapeHtml(name.slice(idx + 1));
}
