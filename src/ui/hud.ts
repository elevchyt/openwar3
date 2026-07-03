// In-game HUD (plan §10.1b — reference screenshot 2026-07-02). Structurally
// faithful DOM shell: top bar (menu buttons, clock, resources + upkeep) and the
// bottom console (minimap, portrait/info, inventory, command card). Skinned
// with CSS placeholders; real BLP icons and the map's own minimap image are
// used when available (asset-resolver philosophy: authentic when present).

export type OrderMode = "move" | "attack" | null;

/** One command-card button (order, build, or train). */
export interface CommandButton {
  id: string; // "move" | "stop" | "attack" | "build" | "cancel" | "build:htow" | "train:hfoo"
  icon: string | null; // data URL
  name: string;
  hotkey: string;
  desc: string;
  gold: number;
  lumber: number;
  food: number;
  col: number; // 0–3
  row: number; // 0–2
  disabled: boolean;
  active: boolean; // armed (e.g. move/attack awaiting a target)
}

export interface HudSelection {
  id: number;
  name: string;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  armor: number;
  damageMin: number;
  damageMax: number;
  attackType: string;
  armorType: string;
  isHero: boolean;
  level: number;
  strength: number;
  agility: number;
  intelligence: number;
  primaryAttr: string;
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
}

export interface HudDriver {
  resources(): { gold: number; lumber: number; foodUsed: number; foodMax: number };
  selection(): HudSelection | null;
  /** Minimap dots: world positions + owning player (for color). */
  dots(): Array<{ x: number; y: number; owner: number }>;
  /** World rect covered by the map: [originX, originY, width, height]. */
  mapBounds(): [number, number, number, number];
  panTo(wx: number, wy: number): void;
  /** Portrait clicked: snap the camera to the selected unit; `lock` follows it. */
  focusSelected(lock: boolean): void;
  setOrderMode(mode: OrderMode): void;
  stopSelected(): void;
  /** Icons for a multi-unit selection grid (empty for a single unit / mine). */
  selectionIcons(): Array<{ simId: number; icon: string; hpFrac: number; focused: boolean; owner: number }>;
  /** Focus the sub-group containing a unit (grid icon click). */
  focusUnit(simId: number): void;
  /** Cycle focus to the next sub-group (Tab). */
  cycleFocus(): void;
  /** Command-card buttons for the current selection (empty = no card). */
  commandCard(): CommandButton[];
  /** Run a command-card button by id. */
  runCommand(id: string): void;
  /** Data URL for a resource icon, or null to use the text fallback. */
  icon(kind: "gold" | "lumber" | "supply"): string | null;
  /** Data URL for a command button icon (e.g. "BTNMove"), or null. */
  commandIcon(name: string): string | null;
  /** Data URL for an arbitrary BLP path (e.g. a unit's command icon), or null. */
  blpUrl(path: string): string | null;
  /** Current game time for the clock (hour 0–24, day/night flag). */
  dayNight(): { hour: number; isDay: boolean };
  /** The map's own minimap image (war3mapMap.blp), if decodable. */
  minimapImage(): HTMLCanvasElement | null;
  /** Race console atlas crops (UI\Console\<Race>UITile01–04) or null. */
  consoleSkin(): { consoleUrl: string; consoleAspect: number; clockUrl: string; clockAspect: number; timeUrl: string | null } | null;
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
const NEUTRAL_COLOR = "#b8b8b8";

const MINIMAP_SIZE = 168; // css px
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
  private selStats!: HTMLDivElement;
  private attackStat!: StatRow;
  private armorStat!: StatRow;
  private attrRow!: HTMLDivElement;
  private attrStr!: AttrItem;
  private attrAgi!: AttrItem;
  private attrInt!: AttrItem;
  private selHpText!: HTMLDivElement;
  private selMpText!: HTMLDivElement;
  private selCarry!: HTMLDivElement;
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
  private cmdTooltip!: HTMLDivElement;
  private cmdSlots: HTMLButtonElement[] = [];
  private cmdKey = "";
  private clockFace?: HTMLDivElement;
  private dotsT = 0;
  private textT = TEXT_PERIOD; // render immediately on first frame
  private lastSelId: number | null = null; // force a text refresh when selection changes

  constructor(parent: HTMLElement, private driver: HudDriver) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    const skin = driver.consoleSkin();
    this.root.append(this.buildTopBar(skin), this.buildConsole(skin));
    parent.appendChild(this.root);
    window.addEventListener("keydown", this.onKey);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey);
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
  }

  /** Sun/moon disc: the indicator texture is sun–moon–sun across its width, so
   *  showing its left edge reveals the sun (day) and its centre the moon
   *  (night); a CSS transition eases the dawn/dusk swap. */
  private updateClock(): void {
    if (!this.clockFace) return;
    this.clockFace.style.backgroundPositionX = this.driver.dayNight().isDay ? "0%" : "50%";
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.root.hidden) return;
    if (e.key === "Tab") {
      e.preventDefault(); // cycle the focused sub-group of a multi-selection
      this.driver.cycleFocus();
      return;
    }
    if (e.key === "Escape") {
      this.driver.runCommand("cancel");
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

    // Day/night clock — the circular medallion (its own atlas crop) with the
    // rotating sun/moon disc behind its transparent centre.
    const clock = document.createElement("div");
    clock.className = "hud-clock";
    clock.title = "Day/night cycle";
    if (skin) {
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

  private buildMinimap(): HTMLDivElement {
    const box = document.createElement("div");
    box.className = "hud-minimap";
    const image = this.driver.minimapImage();
    if (image) {
      image.className = "hud-minimap-img";
      box.appendChild(image);
    }
    this.dotsCanvas = document.createElement("canvas");
    this.dotsCanvas.className = "hud-minimap-dots";
    this.dotsCanvas.width = MINIMAP_SIZE;
    this.dotsCanvas.height = MINIMAP_SIZE;
    box.appendChild(this.dotsCanvas);
    box.addEventListener("pointerdown", (e) => {
      const rect = box.getBoundingClientRect();
      const u = (e.clientX - rect.left) / rect.width;
      const v = (e.clientY - rect.top) / rect.height;
      const [ox, oy, w, h] = this.driver.mapBounds();
      this.driver.panTo(ox + u * w, oy + (1 - v) * h); // minimap is north-up
    });
    return box;
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
    this.selStats = document.createElement("div");
    this.selStats.className = "hud-sel-stats";
    this.attackStat = makeStatRow();
    this.armorStat = makeStatRow();
    this.attrRow = document.createElement("div");
    this.attrRow.className = "hud-sel-attrs";
    this.attrStr = makeAttrItem();
    this.attrAgi = makeAttrItem();
    this.attrInt = makeAttrItem();
    this.attrRow.append(this.attrStr.wrap, this.attrAgi.wrap, this.attrInt.wrap);
    this.selStats.append(this.attackStat.row, this.armorStat.row, this.attrRow);
    this.selCarry = document.createElement("div");
    this.selCarry.className = "hud-sel-carry";
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
    infoText.append(this.selName, this.selSub, this.progressWrap, this.selStats, this.selCarry, this.selGrid);
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
    for (let i = 0; i < 6; i++) grid.appendChild(document.createElement("div")).className = "hud-slot";
    inv.appendChild(grid);
    return inv;
  }

  private buildCommandCard(): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "hud-command";
    // Tooltip shown above the card on hover (name + hotkey + cost + description).
    this.cmdTooltip = document.createElement("div");
    this.cmdTooltip.className = "hud-tooltip";
    this.cmdTooltip.hidden = true;
    card.appendChild(this.cmdTooltip);
    // 12 fixed slots (4×3); contents are filled per selection each frame.
    this.cmdSlots = [];
    for (let i = 0; i < 12; i++) {
      const btn = document.createElement("button");
      btn.className = "hud-slot hud-cmd";
      btn.disabled = true;
      card.appendChild(btn);
      this.cmdSlots.push(btn);
    }
    return card;
  }

  /** Rebuild the command-card buttons from the driver's current command list.
   *  Cheap enough to run each frame; skips work when nothing changed. */
  private refreshCommandCard(): void {
    const cmds = this.driver.commandCard();
    const key = cmds.map((c) => `${c.id}:${c.disabled}:${c.active}`).join("|");
    if (key === this.cmdKey) return;
    this.cmdKey = key;
    // The card changed (e.g. a building was cancelled and its buttons vanished):
    // hide any hover tooltip so it doesn't linger over the now-empty slot — a
    // removed button never fires pointerleave.
    this.cmdTooltip.hidden = true;
    for (const btn of this.cmdSlots) {
      btn.disabled = true;
      btn.style.backgroundImage = "";
      btn.classList.remove("armed");
      btn.textContent = "";
      btn.onclick = null;
      btn.onpointerenter = null;
      btn.onpointerleave = null;
    }
    for (const c of cmds) {
      const idx = c.row * 4 + c.col;
      const btn = this.cmdSlots[idx];
      if (!btn) continue;
      btn.disabled = false;
      btn.classList.toggle("armed", c.active);
      btn.classList.toggle("cant-afford", c.disabled);
      if (c.icon) btn.style.backgroundImage = `url(${c.icon})`;
      else btn.textContent = c.name.slice(0, 4);
      btn.onclick = () => this.driver.runCommand(c.id);
      btn.onpointerenter = () => this.showTooltip(c);
      btn.onpointerleave = () => (this.cmdTooltip.hidden = true);
    }
  }

  private showTooltip(c: CommandButton): void {
    // Title: "Build " prefix for build orders, with the hotkey letter picked out
    // in gold inside the name (like the WC3 tooltip).
    const prefix = c.id.startsWith("build:") ? "Build " : "";
    const title = highlightHotkey(prefix + c.name, c.hotkey);
    // Cost: the REAL gold/lumber/food icons (same as the top resource bar) + the
    // amount, not placeholder glyphs.
    const costItem = (kind: "gold" | "lumber" | "supply", value: number): string => {
      if (!value) return "";
      const url = this.driver.icon(kind);
      const icon = url ? `<img class="tt-cost-icon" src="${url}" alt="${kind}">` : "";
      return `<span class="tt-cost-item">${icon}${value}</span>`;
    };
    const costs = costItem("gold", c.gold) + costItem("lumber", c.lumber) + costItem("supply", c.food);
    const cost = costs ? `<div class="hud-tooltip-cost">${costs}</div>` : "";
    this.cmdTooltip.innerHTML =
      `<div class="hud-tooltip-title">${title}</div>${cost}<div class="hud-tooltip-desc">${escapeHtml(c.desc)}</div>`;
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
      const constructing = sel.underConstruction;
      const training = sel.isBuilding && !constructing && sel.queueLength > 0;
      this.queueTrainable = training; // reset every frame so a stale flag can't fire a cancel
      if (sel.isMine) {
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
        this.selSub.textContent = sel.isHero && sel.level > 0 ? `Level ${sel.level}` : "";
        if (sel.damageMax > 0) {
          this.attackStat.row.hidden = false;
          this.setIcon(this.attackStat.icon, infocard("attack", sel.attackType));
          this.attackStat.text.textContent = `Damage: ${sel.damageMin} - ${sel.damageMax}`;
        } else {
          this.attackStat.row.hidden = true;
        }
        this.armorStat.row.hidden = false;
        this.setIcon(this.armorStat.icon, infocard("armor", sel.armorType));
        this.armorStat.text.textContent = `Armor: ${sel.armor}`;
        if (sel.isHero) {
          this.attrRow.hidden = false;
          this.setAttr(this.attrStr, "str", sel.strength, sel.primaryAttr === "STR");
          this.setAttr(this.attrAgi, "agi", sel.agility, sel.primaryAttr === "AGI");
          this.setAttr(this.attrInt, "int", sel.intelligence, sel.primaryAttr === "INT");
        } else {
          this.attrRow.hidden = true;
        }
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
    }
  }

  /** Render the multi-selection grid; the focused sub-group is highlighted. */
  private showSelectionGrid(icons: ReturnType<HudDriver["selectionIcons"]>): void {
    this.selGrid.hidden = false;
    this.selStats.hidden = true;
    this.selSub.textContent = "";
    this.progressWrap.hidden = true;
    this.selCarry.hidden = true;
    this.selGridSlots.forEach((slot, i) => {
      const ic = icons[i];
      if (!ic) {
        slot.hidden = true;
        slot.onclick = null;
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
      slot.onclick = () => this.driver.focusUnit(ic.simId);
    });
  }

  private setIcon(el: HTMLDivElement, path: string): void {
    const url = this.driver.blpUrl(path);
    el.style.backgroundImage = url ? `url(${url})` : "";
  }

  private setAttr(item: AttrItem, kind: "str" | "agi" | "int", value: number, primary: boolean): void {
    this.setIcon(item.icon, attrIcon(kind));
    item.text.textContent = String(value);
    item.wrap.classList.toggle("primary", primary);
  }

  private drawDots(): void {
    const ctx = this.dotsCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    const [ox, oy, w, h] = this.driver.mapBounds();
    for (const dot of this.driver.dots()) {
      const u = (dot.x - ox) / w;
      const v = 1 - (dot.y - oy) / h;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      ctx.fillStyle = dot.owner >= 0 ? PLAYER_COLORS[dot.owner % PLAYER_COLORS.length] : NEUTRAL_COLOR;
      ctx.fillRect(u * MINIMAP_SIZE - 2, v * MINIMAP_SIZE - 2, 4, 4);
    }
  }
}

interface StatRow { row: HTMLDivElement; icon: HTMLDivElement; text: HTMLSpanElement; }
interface AttrItem { wrap: HTMLDivElement; icon: HTMLDivElement; text: HTMLSpanElement; }

function makeStatRow(): StatRow {
  const row = document.createElement("div");
  row.className = "hud-stat-row";
  const icon = document.createElement("div");
  icon.className = "hud-stat-icon";
  const text = document.createElement("span");
  row.append(icon, text);
  return { row, icon, text };
}
function makeAttrItem(): AttrItem {
  const wrap = document.createElement("div");
  wrap.className = "hud-attr";
  const icon = document.createElement("div");
  icon.className = "hud-attr-icon";
  const text = document.createElement("span");
  wrap.append(icon, text);
  return { wrap, icon, text };
}

// WC3 infocard type icons (real BLPs under UI\Widgets\Console\Human\). Attack/
// armor types map onto the melee/piercing/… and small/medium/… icon set.
const ATTACK_ICON: Record<string, string> = { normal: "melee", pierce: "piercing", siege: "siege", magic: "magic", chaos: "chaos", hero: "hero", spells: "magic" };
const ARMOR_ICON: Record<string, string> = { small: "small", medium: "medium", large: "large", fort: "fortified", hero: "hero", divine: "divine", none: "unarmored", unarmored: "unarmored" };
function infocard(kind: "attack" | "armor", type: string): string {
  const suffix = (kind === "attack" ? ATTACK_ICON[type] : ARMOR_ICON[type]) ?? (kind === "attack" ? "melee" : "unarmored");
  return `UI\\Widgets\\Console\\Human\\infocard-${kind}-${suffix}.blp`;
}
function attrIcon(kind: "str" | "agi" | "int"): string {
  return `UI\\Widgets\\Console\\Human\\infocard-heroattributes-${kind}.blp`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

// Highlight the hotkey letter (first occurrence, case-insensitive) in gold inside
// the title, e.g. "Build <b>A</b>ltar of Kings" — the WC3 tooltip convention.
function highlightHotkey(name: string, hotkey: string): string {
  if (!hotkey || hotkey.length !== 1) return escapeHtml(name);
  const idx = name.toUpperCase().indexOf(hotkey.toUpperCase());
  if (idx < 0) return escapeHtml(name);
  return escapeHtml(name.slice(0, idx)) + `<b>${escapeHtml(name[idx])}</b>` + escapeHtml(name.slice(idx + 1));
}
