// In-game HUD (plan §10.1b — reference screenshot 2026-07-02). Structurally
// faithful DOM shell: top bar (menu buttons, clock, resources + upkeep) and the
// bottom console (minimap, portrait/info, inventory, command card). Skinned
// with CSS placeholders; real BLP icons and the map's own minimap image are
// used when available (asset-resolver philosophy: authentic when present).

export type OrderMode = "move" | "attack" | null;

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
  carryGold: number;
  carryLumber: number;
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
  /** Data URL for a resource icon, or null to use the text fallback. */
  icon(kind: "gold" | "lumber" | "supply"): string | null;
  /** Data URL for a command button icon (e.g. "BTNMove"), or null. */
  commandIcon(name: string): string | null;
  /** The map's own minimap image (war3mapMap.blp), if decodable. */
  minimapImage(): HTMLCanvasElement | null;
  /** Race console atlas crops (UI\Console\<Race>UITile01–04) or null. */
  consoleSkin(): { consoleUrl: string; consoleAspect: number; clockUrl: string; clockAspect: number } | null;
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
  private selStats!: HTMLDivElement;
  private selHpText!: HTMLDivElement;
  private selMpText!: HTMLDivElement;
  private selCarry!: HTMLDivElement;
  private portrait!: HTMLDivElement;
  private portraitCanvasEl!: HTMLCanvasElement;
  private dotsCanvas!: HTMLCanvasElement;
  private modeButtons = new Map<string, HTMLButtonElement>();
  private cmdTooltip!: HTMLDivElement;
  private dotsT = 0;
  private textT = TEXT_PERIOD; // render immediately on first frame

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
    this.setMode(null);
  }

  frame(dtMs: number): void {
    if (this.root.hidden) return;
    this.dotsT += dtMs;
    this.textT += dtMs;
    if (this.textT >= TEXT_PERIOD) {
      this.textT = 0;
      this.updateTexts();
    }
    if (this.dotsT >= DOTS_PERIOD) {
      this.dotsT = 0;
      this.drawDots();
    }
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.root.hidden) return;
    if (e.key === "Escape") this.setMode(null);
    else if (e.key === "m" || e.key === "M") this.setMode("move");
    else if (e.key === "a" || e.key === "A") this.setMode("attack");
    else if (e.key === "s" || e.key === "S") this.driver.stopSelected();
  };

  private setMode(mode: OrderMode): void {
    this.driver.setOrderMode(mode);
    for (const [key, btn] of this.modeButtons) btn.classList.toggle("armed", key === mode);
    document.body.classList.toggle("order-armed", mode !== null);
  }

  // --- construction ---------------------------------------------------------

  private buildTopBar(skin: { clockUrl: string; clockAspect: number } | null): HTMLDivElement {
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

    // Day/night clock — the real circular medallion (its own atlas crop so it
    // isn't cut off), or a plain CSS orb without an install.
    const clock = document.createElement("div");
    clock.className = "hud-clock";
    clock.title = "Day/night cycle (not simulated yet)";
    if (skin) {
      clock.classList.add("hud-clock-skinned");
      clock.style.backgroundImage = `url(${skin.clockUrl})`;
      clock.style.aspectRatio = String(skin.clockAspect);
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
    const console_ = document.createElement("div");
    console_.className = "hud-console";
    const minimap = this.buildMinimap();
    const { portraitWrap, infoText } = this.buildInfoPanel();
    const inventory = this.buildInventory(!!skin);
    const command = this.buildCommandCard();
    console_.append(minimap, portraitWrap, infoText, inventory, command);
    if (skin) {
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
    return console_;
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
    this.selStats = document.createElement("div");
    this.selStats.className = "hud-sel-stats";
    this.selCarry = document.createElement("div");
    this.selCarry.className = "hud-sel-carry";
    infoText.append(this.selName, this.selStats, this.selCarry);
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
    // Tooltip shown above the card on hover (name + hotkey + description).
    this.cmdTooltip = document.createElement("div");
    this.cmdTooltip.className = "hud-tooltip";
    this.cmdTooltip.hidden = true;
    card.appendChild(this.cmdTooltip);

    interface Cmd {
      label: string;
      hotkey: string;
      icon: string;
      desc: string;
      run: () => void;
      mode?: OrderMode;
    }
    const commands: Cmd[] = [
      { label: "Move", hotkey: "M", icon: "BTNMove", desc: "Orders the unit to move to a target point.", run: () => this.setMode("move"), mode: "move" },
      { label: "Stop", hotkey: "S", icon: "BTNStop", desc: "Halts the unit's current order.", run: () => { this.driver.stopSelected(); this.setMode(null); } },
      { label: "Attack", hotkey: "A", icon: "BTNAttack", desc: "Orders the unit to attack a target.", run: () => this.setMode("attack"), mode: "attack" },
    ];
    for (let i = 0; i < 12; i++) {
      const cmd = commands[i];
      const btn = document.createElement("button");
      btn.className = "hud-slot hud-cmd";
      if (cmd) {
        const url = this.driver.commandIcon(cmd.icon);
        if (url) {
          btn.style.backgroundImage = `url(${url})`;
        } else {
          btn.textContent = cmd.label;
        }
        btn.onclick = cmd.run;
        const hk = cmd.hotkey;
        const label = cmd.label.replace(hk, `<b>${hk}</b>`);
        btn.addEventListener("pointerenter", () => this.showTooltip(`${label} (${hk})`, cmd.desc));
        btn.addEventListener("pointerleave", () => (this.cmdTooltip.hidden = true));
        if (cmd.mode) this.modeButtons.set(cmd.mode, btn);
      } else {
        btn.disabled = true;
      }
      card.appendChild(btn);
    }
    return card;
  }

  private showTooltip(titleHtml: string, desc: string): void {
    this.cmdTooltip.innerHTML = `<div class="hud-tooltip-title">${titleHtml}</div><div class="hud-tooltip-desc">${desc}</div>`;
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
      this.selHpText.textContent = `${Math.ceil(sel.hp)} / ${sel.maxHp}`;
      this.selMpText.textContent = sel.maxMana > 0 ? `${Math.floor(sel.mana)} / ${sel.maxMana}` : "";
      const dmg = sel.damageMax > 0 ? `Damage: ${sel.damageMin} - ${sel.damageMax}` : "";
      this.selStats.textContent = `${dmg}${dmg ? "\n" : ""}Armor: ${sel.armor}`;
      this.selCarry.textContent =
        sel.carryGold > 0 ? `Carrying ${sel.carryGold} gold` : sel.carryLumber > 0 ? `Carrying ${sel.carryLumber} lumber` : "";
    } else {
      this.selName.textContent = "";
      this.selHpText.textContent = "";
      this.selMpText.textContent = "";
      this.selStats.textContent = "";
      this.selCarry.textContent = "";
    }
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
