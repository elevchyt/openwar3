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
  setOrderMode(mode: OrderMode): void;
  stopSelected(): void;
  /** Data URL for a resource icon, or null to use the text fallback. */
  icon(kind: "gold" | "lumber" | "supply"): string | null;
  /** The map's own minimap image (war3mapMap.blp), if decodable. */
  minimapImage(): HTMLCanvasElement | null;
  /** Stitched race console texture (UI\Console\<Race>UITile01–04) or null. */
  consoleSkin(): { url: string; aspect: number } | null;
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
  private selHpText!: HTMLDivElement;
  private selHpFill!: HTMLDivElement;
  private selMpRow!: HTMLDivElement;
  private selMpText!: HTMLDivElement;
  private selMpFill!: HTMLDivElement;
  private selCarry!: HTMLDivElement;
  private portrait!: HTMLDivElement;
  private portraitCanvasEl!: HTMLCanvasElement;
  private dotsCanvas!: HTMLCanvasElement;
  private modeButtons = new Map<string, HTMLButtonElement>();
  private dotsT = 0;
  private textT = TEXT_PERIOD; // render immediately on first frame

  constructor(parent: HTMLElement, private driver: HudDriver) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.append(this.buildTopBar(), this.buildConsole());
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

  private buildTopBar(): HTMLDivElement {
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

    const clock = document.createElement("div");
    clock.className = "hud-clock";
    clock.title = "Day/night cycle (not simulated yet)";

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

  private buildConsole(): HTMLDivElement {
    const console_ = document.createElement("div");
    console_.className = "hud-console";
    const skin = this.driver.consoleSkin();
    if (skin) {
      console_.classList.add("hud-console-skinned");
      console_.style.backgroundImage = `url(${skin.url})`;
      console_.style.height = `calc(100vw / ${skin.aspect})`;
    }
    console_.append(this.buildMinimap(), this.buildInfoPanel(), this.buildInventory(), this.buildCommandCard());
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

  private buildInfoPanel(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "hud-info";
    // Portrait: an animated 3D bust (the _portrait.mdx model) with the HP and
    // mana readouts right under it, like the original console.
    this.portrait = document.createElement("div");
    this.portrait.className = "hud-portrait";
    this.portraitCanvasEl = document.createElement("canvas");
    this.portraitCanvasEl.className = "hud-portrait-canvas";
    this.portrait.appendChild(this.portraitCanvasEl);

    const bars = document.createElement("div");
    bars.className = "hud-portrait-bars";
    const hpRow = document.createElement("div");
    hpRow.className = "hud-bar-row";
    const hpTrack = document.createElement("div");
    hpTrack.className = "hud-sel-hp";
    this.selHpFill = document.createElement("div");
    this.selHpFill.className = "hud-sel-hp-fill";
    hpTrack.appendChild(this.selHpFill);
    this.selHpText = document.createElement("div");
    this.selHpText.className = "hud-bar-text";
    hpRow.append(hpTrack, this.selHpText);

    this.selMpRow = document.createElement("div");
    this.selMpRow.className = "hud-bar-row";
    const mpTrack = document.createElement("div");
    mpTrack.className = "hud-sel-hp hud-sel-mp";
    this.selMpFill = document.createElement("div");
    this.selMpFill.className = "hud-sel-hp-fill hud-sel-mp-fill";
    mpTrack.appendChild(this.selMpFill);
    this.selMpText = document.createElement("div");
    this.selMpText.className = "hud-bar-text";
    this.selMpRow.append(mpTrack, this.selMpText);
    bars.append(hpRow, this.selMpRow);

    const portraitWrap = document.createElement("div");
    portraitWrap.className = "hud-portrait-wrap";
    portraitWrap.append(this.portrait, bars);

    const text = document.createElement("div");
    text.className = "hud-info-text";
    this.selName = document.createElement("div");
    this.selName.className = "hud-sel-name";
    this.selCarry = document.createElement("div");
    this.selCarry.className = "hud-sel-carry";
    text.append(this.selName, this.selCarry);
    panel.append(portraitWrap, text);
    return panel;
  }

  private buildInventory(): HTMLDivElement {
    const inv = document.createElement("div");
    inv.className = "hud-inventory";
    const title = document.createElement("div");
    title.className = "hud-inv-title";
    title.textContent = "Inventory";
    inv.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "hud-inv-grid";
    for (let i = 0; i < 6; i++) grid.appendChild(document.createElement("div")).className = "hud-slot";
    inv.appendChild(grid);
    return inv;
  }

  private buildCommandCard(): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "hud-command";
    const commands: Array<[string, string, () => void] | null> = [
      ["Move", "M", () => this.setMode("move")],
      ["Stop", "S", () => { this.driver.stopSelected(); this.setMode(null); }],
      ["Attack", "A", () => this.setMode("attack")],
    ];
    for (let i = 0; i < 12; i++) {
      const cmd = commands[i] ?? null;
      const btn = document.createElement("button");
      btn.className = "hud-slot hud-cmd";
      if (cmd) {
        const [label, hotkey, action] = cmd;
        btn.textContent = label;
        btn.title = `${label} (${hotkey})`;
        btn.onclick = action;
        if (label === "Move") this.modeButtons.set("move", btn);
        if (label === "Attack") this.modeButtons.set("attack", btn);
      } else {
        btn.disabled = true;
      }
      card.appendChild(btn);
    }
    return card;
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
      const frac = Math.max(0, Math.min(1, sel.hp / sel.maxHp));
      this.selHpFill.style.width = `${frac * 100}%`;
      this.selHpFill.style.background = frac > 0.6 ? "#46e05a" : frac > 0.3 ? "#e0c146" : "#e05046";
      this.selHpText.textContent = `${Math.ceil(sel.hp)} / ${sel.maxHp}`;
      this.selMpRow.hidden = sel.maxMana <= 0;
      if (sel.maxMana > 0) {
        this.selMpFill.style.width = `${Math.max(0, Math.min(1, sel.mana / sel.maxMana)) * 100}%`;
        this.selMpText.textContent = `${Math.floor(sel.mana)} / ${sel.maxMana}`;
      }
      this.selCarry.textContent =
        sel.carryGold > 0 ? `Carrying ${sel.carryGold} gold` : sel.carryLumber > 0 ? `Carrying ${sel.carryLumber} lumber` : "";
    } else {
      this.selName.textContent = "";
      this.selHpFill.style.width = "0";
      this.selHpText.textContent = "";
      this.selMpRow.hidden = true;
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
