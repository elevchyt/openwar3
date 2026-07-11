// In-game HUD (plan §10.1b — reference screenshot 2026-07-02). Structurally
// faithful DOM shell: top bar (menu buttons, clock, resources + upkeep) and the
// bottom console (minimap, portrait/info, inventory, command card). Skinned
// with CSS placeholders; real BLP icons and the map's own minimap image are
// used when available (asset-resolver philosophy: authentic when present).

import { ArmorType, AttackType, PrimaryAttribute } from "../data/enums";
import { campMarker, NEUTRAL_DOT_COLOR } from "../data/gameplayConstants";
import { escapeHtml, wc3ToHtml } from "./wc3Text";

export type OrderMode = "move" | "attack" | null;

/** One command-card button (order, build, or train). */
export interface CommandButton {
  id: string; // "move" | "stop" | "attack" | "build" | "cancel" | "build:htow" | "train:hfoo"
  icon: string | null; // data URL
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
  disabled: boolean;
  /** THE current command of the selected unit — the one button wearing the green
   *  active border. At most one button in a card ever has this set. */
  active: boolean;
  autocast?: boolean; // autocast toggled on: a persistent setting, not the current order
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
  isHero: boolean;
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
  isMine: boolean; // selected gold mine
  goldRemaining: number; // gold left in the selected mine
  isItem: boolean; // selected ground item (show name + description instead of stats)
  description: string; // item description (shown when isItem)
  isSummon: boolean; // temporary summon — show the "Summoned Unit" timer bar
  summonSecondsLeft: number; // seconds until it expires
  summonFrac: number; // remaining fraction of its lifetime (bar fill)
  buffs: Array<{ icon: string; name: string; harmful: boolean }>; // active auras/buffs/debuffs
}

export interface HudDriver {
  resources(): { gold: number; lumber: number; foodUsed: number; foodMax: number };
  selection(): HudSelection | null;
  /** Minimap dots: world positions + owning player (for color). */
  dots(): Array<{ x: number; y: number; owner: number }>;
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
  panTo(wx: number, wy: number): void;
  /** Portrait clicked: snap the camera to the selected unit; `lock` follows it. */
  focusSelected(lock: boolean): void;
  setOrderMode(mode: OrderMode): void;
  stopSelected(): void;
  /** Icons for a multi-unit selection grid (empty for a single unit / mine). */
  selectionIcons(): Array<{ simId: number; icon: string; hpFrac: number; focused: boolean; owner: number }>;
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
  /** N — recall control group N; `jump` (double-tap) also centres the camera. */
  recallControlGroup(key: string, jump: boolean): void;
  /** F1/F2/F3 — select hero `index`; `jump` (double-tap) also centres the camera. */
  selectHero(index: number, jump: boolean): void;
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
  dayNight(): { hour: number; isDay: boolean };
  /** Take over the top-bar clock slot with the race's real TimeIndicator model, sizing
   *  and driving it from the host's own render loop. False → use the atlas fallback. */
  mountClock(slot: HTMLElement): boolean;
  /** The map's own minimap image (war3mapMap.blp), if decodable. */
  minimapImage(): HTMLCanvasElement | null;
  /** Race console atlas crops (UI\Console\<Race>UITile01–04) or null. */
  consoleSkin(): { consoleUrl: string; consoleAspect: number; clockUrl: string; clockAspect: number; timeUrl: string | null } | null;
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
}

// Zone rectangles measured from the rendered console atlas (fractions of the
// cropped console art, 1600×352): minimap frame, portrait arch, info area,
// inventory, command card. FDF parsing will make this exact later.
const ZONES = {
  minimap: [1.1, 16.5, 17.4, 82.0],
  portrait: [26.9, 30.5, 9.9, 68.0],
  info: [38.4, 34.0, 24.5, 60.0],
  inventory: [64.1, 29.0, 9.9, 69.0],
  command: [76.4, 19.0, 22.4, 79.0],
} as const;

function place(el: HTMLElement, zone: readonly [number, number, number, number]): void {
  el.classList.add("hud-zone");
  // Inline position so it wins over any component rule (e.g. .hud-command's
  // position:relative, which otherwise knocked the command card out of its zone).
  el.style.position = "absolute";
  el.style.left = `${zone[0]}%`;
  el.style.top = `${zone[1]}%`;
  el.style.width = `${zone[2]}%`;
  el.style.height = `${zone[3]}%`;
}

// WC3 player colors by slot.
const PLAYER_COLORS = [
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

// The tooltip border strip is 8 square tiles laid out left-to-right, in the order
// the engine's BACKDROP frames name them (UI\FrameDef\Glue\BattleNetChatActionMenu.fdf
// draws the identical bnet-tooltip-border with BackdropCornerFlags "UL|UR|BL|BR|T|L|B|R"):
// left, right, top, bottom, then the four corners. The two horizontal edges are
// stored as VERTICAL bars and the engine rotates them a quarter-turn clockwise —
// re-slice the strip into a 3×3 nine-patch CSS can drive with `border-image`.
// On-screen message log tuning.
const MSG_MAX = 16; // max lines kept on screen at once (WC3 scrolls the oldest off)
const MSG_DEFAULT_SECS = 12; // how long an untimed DisplayTextToPlayer line lingers

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

const MINIMAP_SIZE = 168; // px along the minimap canvas's LONGEST side
const DOTS_PERIOD = 100; // ms between minimap dot redraws
const TEXT_PERIOD = 250; // ms between resource/info text refreshes

export class GameHud {
  private root: HTMLDivElement;
  private gold!: HTMLSpanElement;
  private lumber!: HTMLSpanElement;
  private food!: HTMLSpanElement;
  private upkeep!: HTMLSpanElement;
  private selName!: HTMLDivElement;
  private selSub!: HTMLDivElement; // "Level N" (heroes)
  private xpBar!: HTMLDivElement; // hero XP / summon-timer track
  private xpFill!: HTMLDivElement;
  private xpText!: HTMLDivElement; // "Level N  into/span" or "Summoned Unit (Ns)" — inside the bar
  private selStats!: HTMLDivElement;
  private attackStat!: StatBlock;
  private armorStat!: StatBlock;
  private invulnLine!: HTMLDivElement; // red "Invulnerable" under the armour value (issue #26)
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
  // Construction / training progress display.
  private progressWrap!: HTMLDivElement;
  private statusIcon!: HTMLDivElement;
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
  private idleWorkerBadge!: HTMLButtonElement;
  private idleWorkerCount!: HTMLSpanElement;
  private idleIconSet = false; // worker icon lazily applied once
  private cmdTooltip!: HTMLDivElement; // the ONE tooltip slab, above the command card
  private invHover = -1; // inventory slot under the cursor (-1 = none), so its tooltip can refresh
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
  private clockFace?: HTMLDivElement;
  private dotsT = 0;
  private textT = TEXT_PERIOD; // render immediately on first frame
  private lastSelId: number | null = null; // force a text refresh when selection changes
  // On-screen message area (the "Game - Display text" trigger action target) — a
  // stack of chat/quest lines in the upper-left, oldest scrolling off the top.
  private msgLog!: HTMLDivElement;
  private msgTimers = new Set<number>(); // pending auto-remove timeouts, cleared on dispose

  constructor(parent: HTMLElement, private driver: HudDriver) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    const skin = driver.consoleSkin();
    this.root.append(this.buildTopBar(skin), this.buildConsole(skin), this.buildCheatPanel(), this.buildMessageLog());
    parent.appendChild(this.root);
    this.applyWidgetSkin();
    window.addEventListener("keydown", this.onKey);
  }

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
      this.root.style.setProperty("--hud-tooltip-border", `url(${border})`);
      this.root.style.setProperty("--hud-tooltip-fill", fill);
      this.cmdTooltip.classList.add("skinned");
    }
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
    this.minimapResize?.disconnect();
    for (const id of this.msgTimers) clearTimeout(id);
    this.msgTimers.clear();
    this.root.remove();
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
    if (this.dotsT >= DOTS_PERIOD) {
      this.dotsT = 0;
      this.drawDots();
    }
    this.updateClock();
    this.refreshCommandCard();
    this.refreshInventory();
    this.updateIdleWorkers();
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
  }

  /** Show/hide the idle-worker button and update its count; apply the race worker
   *  icon once it's known. */
  private updateIdleWorkers(): void {
    const n = this.driver.idleWorkerCount();
    this.idleWorkerBadge.hidden = n === 0;
    if (n === 0) return;
    this.idleWorkerCount.textContent = String(n);
    if (!this.idleIconSet) {
      const path = this.driver.workerIcon();
      const url = path ? this.driver.blpUrl(path) : null;
      if (url) {
        this.idleWorkerBadge.style.backgroundImage = `url(${url})`;
        this.idleIconSet = true;
      }
    }
  }

  /** Sun/moon disc: the indicator texture is sun–moon–sun across its width, so
   *  showing its left edge reveals the sun (day) and its centre the moon
   *  (night); a CSS transition eases the dawn/dusk swap. */
  private updateClock(): void {
    if (!this.clockFace) return;
    this.clockFace.style.backgroundPositionX = this.driver.dayNight().isDay ? "0%" : "50%";
  }

  private lastTapKey = ""; // for double-tap detection (control-group / hero camera jump)
  private lastTapAt = 0;

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
    if (document.body.classList.contains("game-menu-open")) return; // F10 menu is modal
    // Held keys auto-repeat ~30×/s. None of the hotkeys below are hold-to-repeat
    // commands (camera panning reads its own key set), and letting them repeat
    // both spams selection voice lines and makes every held key look like a
    // double-tap, snapping the camera to the group.
    if (e.repeat) return;
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
    // Hero hotkeys F1/F2/F3: select the hero (double-tap centres the camera).
    if (e.key === "F1" || e.key === "F2" || e.key === "F3") {
      e.preventDefault();
      this.driver.selectHero(Number(e.key[1]) - 1, this.tapAgain(e.key));
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
      else this.driver.recallControlGroup(n, this.tapAgain(n));
      this.refreshSelectionNow();
      return;
    }
    // NumPad maps to the 2×3 inventory grid (INVENTORY_NUMPAD). Key off `e.code` so
    // NumLock-off symbols don't interfere.
    const numpad = /^Numpad([0-9])$/.exec(e.code);
    const slot = numpad ? INVENTORY_NUMPAD.indexOf(Number(numpad[1])) : -1;
    if (slot >= 0) {
      e.preventDefault();
      this.driver.useInventory(slot);
      return;
    }
    // Trigger the command whose hotkey matches the pressed key.
    const key = e.key.toUpperCase();
    const cmd = this.driver.commandCard().find((c) => c.hotkey === key && !c.disabled);
    if (cmd) this.driver.runCommand(cmd.id);
  };

  /** Reflect the armed order state on the body (crosshair cursor). */
  setArmed(armed: boolean): void {
    document.body.classList.toggle("order-armed", armed);
  }

  // --- construction ---------------------------------------------------------

  private buildTopBar(skin: { clockUrl: string; clockAspect: number; timeUrl: string | null } | null): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "hud-top";

    const menus = document.createElement("div");
    menus.className = "hud-menus";
    for (const [label, key] of [["Quests", "F9"], ["Menu", "F10"], ["Allies", "F11"], ["Chat", "F12"]]) {
      const b = document.createElement("button");
      b.className = "hud-menu-btn";
      b.textContent = `${label} (${key})`;
      b.disabled = true; // placeholders until those screens exist
      menus.appendChild(b);
    }

    // Day/night clock. WC3's real widget is a per-race MDX scene (war3skins.txt
    // `TimeOfDayIndicator`): a rotating sun/moon orb inside a frame ring, ringed by
    // eight dots that light one by one as the half-cycle runs down. The host mounts
    // and drives it (render/timeIndicator.ts). Without an install to render it from,
    // fall back to the console atlas' medallion crop and its sun/moon strip.
    const clock = document.createElement("div");
    clock.className = "hud-clock";
    clock.title = "Day/night cycle";
    if (this.driver.mountClock(clock)) {
      clock.classList.add("hud-clock-skinned");
    } else if (skin) {
      clock.classList.add("hud-clock-skinned");
      clock.style.aspectRatio = String(skin.clockAspect);
      if (skin.timeUrl) {
        this.clockFace = document.createElement("div");
        this.clockFace.className = "hud-clock-face";
        this.clockFace.style.backgroundImage = `url(${skin.timeUrl})`;
        clock.appendChild(this.clockFace);
      }
      const frame = document.createElement("div");
      frame.className = "hud-clock-frame";
      frame.style.backgroundImage = `url(${skin.clockUrl})`;
      clock.appendChild(frame);
    }

    const res = document.createElement("div");
    res.className = "hud-resources";
    this.gold = this.resourceEntry(res, "gold", "G");
    this.lumber = this.resourceEntry(res, "lumber", "L");
    this.food = this.resourceEntry(res, "supply", "F");
    this.upkeep = document.createElement("span");
    this.upkeep.className = "hud-upkeep";
    res.appendChild(this.upkeep);

    bar.append(menus, clock, res);
    return bar;
  }

  private resourceEntry(parent: HTMLElement, kind: "gold" | "lumber" | "supply", fallback: string): HTMLSpanElement {
    const wrap = document.createElement("span");
    wrap.className = "hud-res";
    const url = this.driver.icon(kind);
    if (url) {
      const img = document.createElement("img");
      img.className = "hud-res-icon";
      img.src = url;
      img.alt = kind;
      wrap.appendChild(img);
    } else {
      const tag = document.createElement("span");
      tag.className = `hud-res-tag hud-res-${kind}`;
      tag.textContent = fallback;
      wrap.appendChild(tag);
    }
    const value = document.createElement("span");
    value.className = "hud-res-value";
    wrap.appendChild(value);
    parent.appendChild(wrap);
    return value;
  }

  /** The canvas inside the portrait frame — the host renders the selected
   *  unit's animated portrait model into it. */
  portraitCanvas(): HTMLCanvasElement {
    return this.portraitCanvasEl;
  }

  private buildConsole(skin: { consoleUrl: string; consoleAspect: number } | null): HTMLDivElement {
    // Visual background rectangle that matches the console dimensions but
    // without the skinned art. It sits behind the real console element.
    const bg = document.createElement("div");
    bg.className = "hud-console-background";

    const console_ = document.createElement("div");
    console_.className = "hud-console";
    const minimap = this.buildMinimap();
    const { portraitWrap, infoText } = this.buildInfoPanel();
    const inventory = this.buildInventory(!!skin);
    const command = this.buildCommandCard();
    console_.append(minimap, portraitWrap, infoText, inventory, command);
    if (skin) {
      // The visible console uses the skinned art.
      console_.classList.add("hud-console-skinned");
      console_.style.backgroundImage = `url(${skin.consoleUrl})`;
      // Keep the console at its NATURAL aspect ratio, centred, and let the sides
      // letterbox on widescreen — never stretch it. Height is capped so a wide
      // monitor doesn't blow it up; width follows from the aspect.
      console_.style.setProperty("--console-aspect", String(skin.consoleAspect));

      place(minimap, ZONES.minimap);
      place(portraitWrap, ZONES.portrait);
      place(infoText, ZONES.info);
      place(inventory, ZONES.inventory);
      place(command, ZONES.command);
    }

    // Wrapper holds the background and the real console; DOM order ensures the
    // background sits behind the console element.
    const wrapper = document.createElement("div");
    wrapper.append(bg, console_);
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
    return panel;
  }

  /** The upper-left message stack that the map's "Game - Display text" trigger
   *  actions write into (via the JASS text natives → the engine `displayText` hook). */
  private buildMessageLog(): HTMLDivElement {
    this.msgLog = document.createElement("div");
    this.msgLog.className = "hud-msglog";
    return this.msgLog;
  }

  /** Show one on-screen message line (DisplayTextToPlayer & the timed variant).
   *  `duration` is seconds for the timed action, or < 0 for the untimed one — which
   *  in WC3 lingers, so we give it a generous default and let it scroll off. WC3
   *  colour codes (`|cAARRGGBB…|r`, `|n`) are honoured. Newest line sits at the
   *  bottom; we keep the last MSG_MAX so the stack can't grow without bound. */
  showMessage(text: string, duration: number): void {
    if (!text) return;
    const line = document.createElement("div");
    line.className = "hud-msgline";
    line.innerHTML = formatColorCodes(text);
    this.msgLog.append(line);
    while (this.msgLog.childElementCount > MSG_MAX) this.msgLog.firstElementChild?.remove();
    const secs = duration >= 0 ? duration : MSG_DEFAULT_SECS;
    const id = window.setTimeout(() => {
      line.remove();
      this.msgTimers.delete(id);
    }, Math.max(0.5, secs) * 1000);
    this.msgTimers.add(id);
  }

  /** Clear every on-screen message (the ClearTextMessages action). */
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

    // The frame is sized in percentages of the console art, so its pixel size moves
    // with the window; re-fit the view whenever it does.
    this.fitMinimap();
    this.minimapResize = new ResizeObserver(() => this.fitMinimap());
    this.minimapResize.observe(box);

    view.addEventListener("pointerdown", (e) => {
      const rect = view.getBoundingClientRect();
      const u = (e.clientX - rect.left) / rect.width;
      const v = (e.clientY - rect.top) / rect.height;
      const [ox, oy, w, h] = this.driver.mapBounds();
      this.driver.panTo(ox + u * w, oy + (1 - v) * h); // minimap is north-up
    });
    // Idle-worker button — a framed race-worker icon above the minimap (like the
    // WC3 console), with an idle count at the bottom-right. Click (or F8 / ~)
    // selects and cycles through workers doing nothing. Hidden when there are none.
    this.idleWorkerBadge = document.createElement("button");
    this.idleWorkerBadge.className = "hud-idle-worker";
    this.idleWorkerBadge.title = "Select idle worker (F8 / ~)";
    this.idleWorkerBadge.hidden = true;
    this.idleWorkerCount = document.createElement("span");
    this.idleWorkerCount.className = "hud-idle-count";
    this.idleWorkerBadge.appendChild(this.idleWorkerCount);
    this.idleWorkerBadge.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // don't also ping the minimap
      this.driver.cycleIdleWorker();
    });
    box.appendChild(this.idleWorkerBadge);
    return box;
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

  private buildInfoPanel(): { portraitWrap: HTMLDivElement; infoText: HTMLDivElement } {
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

    const values = document.createElement("div");
    values.className = "hud-portrait-values";
    this.selHpText = document.createElement("div");
    this.selHpText.className = "hud-hp-value";
    this.selMpText = document.createElement("div");
    this.selMpText.className = "hud-mp-value";
    values.append(this.selHpText, this.selMpText);

    const portraitWrap = document.createElement("div");
    portraitWrap.className = "hud-portrait-wrap";
    portraitWrap.append(this.portrait, values);

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
    this.statusLabel = document.createElement("div");
    this.statusLabel.className = "hud-status-label";
    statusLine.append(this.statusIcon, this.statusLabel);
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
    // Red "Invulnerable" line directly under the armour value, matching WC3's info
    // panel for immune units/buildings (goblin merchant, gold mine, …) (issue #26).
    this.invulnLine = document.createElement("div");
    this.invulnLine.className = "hud-stat-invuln";
    this.invulnLine.textContent = "Invulnerable";
    this.invulnLine.hidden = true;
    this.armorStat.value.after(this.invulnLine);
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
    // Buff / aura / debuff status icons, below the stats (WC3 reference).
    this.selStatus = document.createElement("div");
    this.selStatus.className = "hud-sel-status";
    this.selStatus.hidden = true;
    for (let i = 0; i < 8; i++) {
      const slot = document.createElement("div");
      slot.className = "hud-status-icon";
      slot.hidden = true;
      this.selStatusSlots.push(slot);
      this.selStatus.appendChild(slot);
    }
    this.selStats.append(this.selStatus);
    this.selCarry = document.createElement("div");
    this.selCarry.className = "hud-sel-carry";
    // Item description: shown (in place of the stat block) when a ground item is selected.
    this.selDesc = document.createElement("div");
    this.selDesc.className = "hud-sel-desc";
    this.selDesc.hidden = true;
    // Multi-selection grid: up to 24 unit icons (grouped by type), each with an
    // HP bar; the focused sub-group is highlighted. Clicking focuses that group.
    this.selGrid = document.createElement("div");
    this.selGrid.className = "hud-sel-grid";
    this.selGrid.hidden = true;
    for (let i = 0; i < 24; i++) {
      const slot = document.createElement("button");
      slot.className = "hud-sel-icon";
      const bar = document.createElement("div");
      bar.className = "hud-sel-icon-hp";
      slot.appendChild(bar);
      this.selGridSlots.push(slot);
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
      const count = document.createElement("span");
      count.className = "hud-cmd-count";
      btn.append(cd, count);
      onPress(btn, () => this.driver.useInventory(i));
      btn.oncontextmenu = (e) => {
        e.preventDefault();
        this.driver.moveInventory(i);
      };
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
    // Cooldown sweep every frame (cheap; the diff key ignores cooldown).
    for (let i = 0; i < this.invSlots.length; i++) {
      const s = inv[i] ?? null;
      const cd = this.invCdOverlay[i];
      if (s && s.cooldownLeft > 0) {
        cd.hidden = false;
        const elapsedDeg = (1 - s.cooldownFrac) * 360;
        cd.style.background = `conic-gradient(transparent 0deg ${elapsedDeg}deg, rgba(0,0,0,0.62) ${elapsedDeg}deg 360deg)`;
        this.invCdText[i].textContent = s.cooldownLeft >= 10 ? String(Math.ceil(s.cooldownLeft)) : s.cooldownLeft.toFixed(1);
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
        this.invCount[i].textContent = "";
        continue;
      }
      btn.classList.remove("empty");
      btn.style.backgroundImage = s.icon ? `url(${s.icon})` : "";
      this.invCount[i].textContent = s.charges > 0 ? String(s.charges) : "";
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
      // Corner count badge (e.g. a hero's unspent skill points) — a persistent
      // child so a card rebuild never wipes it, like the label/cooldown nodes.
      const count = document.createElement("span");
      count.className = "hud-cmd-count";
      btn.append(label, cd, count);
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
    const key = cmds.map((c) => `${c.id}:${c.disabled}:${c.active}:${c.autocast}:${c.count ?? 0}`).join("|");
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
      btn.classList.remove("armed", "autocast", "cant-afford");
      this.cmdLabels[i].textContent = "";
      this.cmdCount[i].textContent = "";
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
      btn.classList.toggle("autocast", !!c.autocast);
      btn.classList.toggle("cant-afford", c.disabled);
      if (c.icon) btn.style.backgroundImage = `url(${c.icon})`;
      else this.cmdLabels[idx].textContent = c.name.slice(0, 4);
      if (c.count && c.count > 0) this.cmdCount[idx].textContent = String(c.count);
      onPress(btn, () => this.driver.runCommand(c.id));
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
      this.cmdCdText[idx].textContent = c.cooldownLeft >= 10 ? String(Math.ceil(c.cooldownLeft)) : c.cooldownLeft.toFixed(1);
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
    this.gold.textContent = String(Math.floor(r.gold));
    this.lumber.textContent = String(Math.floor(r.lumber));
    this.food.textContent = `${r.foodUsed}/${r.foodMax}`;
    // WC3 upkeep brackets: 0–50 none, 51–80 low, 81+ high.
    const upkeep = r.foodUsed <= 50 ? "No Upkeep" : r.foodUsed <= 80 ? "Low Upkeep" : "High Upkeep";
    this.upkeep.textContent = upkeep;
    this.upkeep.dataset.level = upkeep[0];

    const sel = this.driver.selection();
    this.portrait.classList.toggle("empty", !sel);
    if (!sel || this.driver.selectionIcons().length > 0) this.xpBar.hidden = true; // no single hero shown
    if (sel) {
      this.selName.textContent = sel.name;
      this.selHpText.textContent = sel.maxHp > 0 ? `${Math.ceil(sel.hp)} / ${sel.maxHp}` : "";
      this.selMpText.textContent = sel.maxMana > 0 ? `${Math.floor(sel.mana)} / ${sel.maxMana}` : "";
      const icons = this.driver.selectionIcons();
      if (icons.length > 0) {
        this.showSelectionGrid(icons);
        return;
      }
      this.selGrid.hidden = true;
      this.selDesc.hidden = true; // only the item branch shows it
      this.xpBar.hidden = true; // only the hero-stats branch below re-shows it
      this.invulnLine.hidden = true; // only the unit/building stats branch re-shows it
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
        if (sel.isHero && sel.level > 0) {
          const span = sel.xpNext - sel.xpThis;
          const into = Math.max(0, Math.round(sel.xp - sel.xpThis));
          this.selSub.textContent = ""; // level + XP live inside the bar; no extra label
          this.xpBar.hidden = false;
          this.xpBar.classList.remove("summon");
          this.xpText.textContent = span > 0 ? `Level ${sel.level}   ${into} / ${span}` : `Level ${sel.level}  (max)`;
          this.xpFill.style.width = `${span > 0 ? Math.max(0, Math.min(1, into / span)) * 100 : 100}%`;
        } else if (sel.isSummon) {
          this.selSub.textContent = "";
          this.xpBar.hidden = false;
          this.xpBar.classList.add("summon");
          this.xpText.textContent = `Summoned Unit (${sel.summonSecondsLeft}s)`;
          this.xpFill.style.width = `${sel.summonFrac * 100}%`;
        } else {
          this.selSub.textContent = "";
          this.xpBar.hidden = true;
        }
        // Damage / Armor: base value + a green "+N" bonus from buffs/auras.
        if (sel.damageMax > 0) {
          this.attackStat.row.hidden = false;
          this.setIcon(this.attackStat.icon, infocard("attack", sel.attackType));
          this.attackStat.value.innerHTML = `${sel.damageMin} - ${sel.damageMax}${bonusHtml(sel.damageBonus)}`;
        } else {
          this.attackStat.row.hidden = true;
        }
        this.armorStat.row.hidden = false;
        this.setIcon(this.armorStat.icon, infocard("armor", sel.armorType));
        this.armorStat.value.innerHTML = `${sel.armor}${bonusHtml(sel.armorBonus)}`;
        this.invulnLine.hidden = !sel.invulnerable;
        // Hero attributes: ONE primary-attribute icon beside the three value lines.
        if (sel.isHero) {
          this.attrIconEl.hidden = false;
          this.attrLines.hidden = false;
          const prim = sel.primaryAttr === PrimaryAttribute.Agility ? "agi" : sel.primaryAttr === PrimaryAttribute.Intelligence ? "int" : "str";
          this.setIcon(this.attrIconEl, attrIcon(prim));
          this.strLine.innerHTML = attrLineHtml("Strength", sel.strength, sel.strengthBonus, sel.primaryAttr === PrimaryAttribute.Strength);
          this.agiLine.innerHTML = attrLineHtml("Agility", sel.agility, sel.agilityBonus, sel.primaryAttr === PrimaryAttribute.Agility);
          this.intLine.innerHTML = attrLineHtml("Intelligence", sel.intelligence, sel.intelligenceBonus, sel.primaryAttr === PrimaryAttribute.Intelligence);
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
    this.selGridSlots.forEach((slot, i) => {
      const ic = icons[i];
      if (!ic) {
        slot.hidden = true;
        onPress(slot, null);
        slot.ondblclick = null;
        return;
      }
      slot.hidden = false;
      const url = ic.icon ? this.driver.blpUrl(ic.icon) : null;
      slot.style.backgroundImage = url ? `url(${url})` : "";
      slot.classList.toggle("focused", ic.focused);
      const frac = Math.max(0, Math.min(1, ic.hpFrac));
      const bar = slot.firstElementChild as HTMLDivElement;
      bar.style.width = `${frac * 100}%`;
      bar.style.background = frac > 0.6 ? "#46e05a" : frac > 0.3 ? "#e0c146" : "#e05046";
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


  /** Render the active buff / aura / debuff status icons under the stats. */
  private renderStatus(buffs: Array<{ icon: string; name: string; harmful: boolean }>): void {
    this.selStatus.hidden = buffs.length === 0;
    for (let i = 0; i < this.selStatusSlots.length; i++) {
      const slot = this.selStatusSlots[i];
      const b = buffs[i];
      if (!b) {
        slot.hidden = true;
        slot.onpointerenter = null;
        slot.onpointerleave = null;
        continue;
      }
      slot.hidden = false;
      const url = b.icon ? this.driver.blpUrl(b.icon) : null;
      slot.style.backgroundImage = url ? `url(${url})` : "";
      if (!url) slot.textContent = b.name.slice(0, 3);
      else slot.textContent = "";
      slot.classList.toggle("harmful", b.harmful);
      slot.title = b.name;
    }
  }

  private fogImage: ImageData | null = null; // reused fog-of-war mask (mmW × mmH)
  private mapGlyphs = new Map<string, HTMLImageElement>(); // BLP path → lazy-loaded glyph

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
      ctx.fillStyle = dot.owner >= 0 ? PLAYER_COLORS[dot.owner % PLAYER_COLORS.length] : NEUTRAL_DOT_COLOR;
      ctx.fillRect(p[0] - d, p[1] - d, UNIT_DOT, UNIT_DOT);
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

interface StatBlock { row: HTMLDivElement; icon: HTMLDivElement; value: HTMLDivElement; }

/** A stat block: [icon] then "Label:" over the value line (WC3 info panel). */
function makeStatBlock(label: string): StatBlock {
  const row = document.createElement("div");
  row.className = "hud-stat-block";
  const icon = document.createElement("div");
  icon.className = "hud-stat-icon";
  const text = document.createElement("div");
  text.className = "hud-stat-text";
  const lab = document.createElement("div");
  lab.className = "hud-stat-label";
  lab.textContent = `${label}:`;
  const value = document.createElement("div");
  value.className = "hud-stat-value";
  text.append(lab, value);
  row.append(icon, text);
  return { row, icon, value };
}
// A bonus span from buffs/auras/items: green "+N" when positive, red "-N" when
// negative (WC3 shows debuffed stats in red), empty when there's none.
function bonusHtml(bonus: number): string {
  if (bonus > 0) return ` <span class="stat-bonus">+${bonus}</span>`;
  if (bonus < 0) return ` <span class="stat-penalty">${bonus}</span>`; // `bonus` already carries the minus
  return "";
}
// An attribute line: "Strength: 34 +9" — the label is yellow, the primary bold, and
// the item contribution shows as a green "+N" (red "-N" if the total is negative).
function attrLineHtml(label: string, value: number, bonus: number, primary: boolean): string {
  const cls = primary ? "hud-attr-line primary" : "hud-attr-line";
  return `<span class="${cls}"><span class="attr-name">${label}:</span> ${value}${bonusHtml(bonus)}</span>`;
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
function infocard(kind: "attack", type: AttackType): string;
function infocard(kind: "armor", type: ArmorType): string;
function infocard(kind: "attack" | "armor", type: AttackType | ArmorType): string {
  const suffix =
    kind === "attack"
      ? (ATTACK_ICON[type as AttackType] ?? "melee")
      : (ARMOR_ICON[type as ArmorType] ?? "unarmored");
  return `UI\\Widgets\\Console\\Human\\infocard-${kind}-${suffix}.blp`;
}
function attrIcon(kind: "str" | "agi" | "int"): string {
  return `UI\\Widgets\\Console\\Human\\infocard-heroattributes-${kind}.blp`;
}

/** Bind a console button to fire the moment it's PRESSED, the way WC3's command
 *  card does. A DOM `click` only lands if the press and the release both happen
 *  over the button, so a fast click that drifts a pixel onto the frame art beside
 *  it is swallowed — half of issue #44. preventDefault also keeps the press from
 *  focusing the button, so a later Space/Enter can't re-fire it. Pass null to
 *  unbind a slot. */
function onPress(el: HTMLElement, fn: ((e: PointerEvent) => void) | null): void {
  el.onpointerdown = fn
    ? (e) => {
        if (e.button !== 0) return; // right-click has its own (contextmenu) meaning
        e.preventDefault();
        fn(e);
      }
    : null;
}

// Highlight the hotkey letter (first occurrence, case-insensitive) in gold inside
// the title, e.g. "Build <b>A</b>ltar of Kings" — the WC3 tooltip convention. Only
// needed for the buttons with no game `Tip` string behind them; a real Tip already
// carries `|cffffcc00`…`|r` around the letter.
function highlightHotkey(name: string, hotkey: string): string {
  if (!hotkey || hotkey.length !== 1) return escapeHtml(name);
  const idx = name.toUpperCase().indexOf(hotkey.toUpperCase());
  if (idx < 0) return escapeHtml(name);
  return escapeHtml(name.slice(0, idx)) + `<b>${escapeHtml(name[idx])}</b>` + escapeHtml(name.slice(idx + 1));
}
