// The OBSERVER's HUD (issue #168) — what a watcher sees in place of a player's console.
//
// A watcher has no base, no bank and no command card, so the player console is the wrong
// instrument: it filled the bottom of the screen with an empty card and read "0 / 0 / 0/0"
// across the top. The 1.30.4 install ships no observer HUD beyond `ObserverPanel.fdf`'s three
// controls (the vision pulldown and two checkboxes), so the LAYOUT here is the developer's,
// chosen off three mock-ups drawn over a live match ("B — Scoreboard"). What it is BUILT from
// is the game's: every panel is the tooltip frame (`ToolTipBorder` / `ToolTipBackground`,
// TOOLTIP_BOX in hud.ts), every pulldown and button the Esc menu's own backdrop
// (`EscMenuTemplates.fdf` EscMenuButtonBackdropTemplate), the race marks the score screen's
// (`UI\Glues\ScoreScreen\scorescreen-player-<race>.blp`) and every count the console's own
// number box.
//
//   · top left      Menu (F10) and Chat (F12), and under them the PRODUCTION panel — every
//                   player's work in hand, their army, or their upgrades, by its pulldown;
//   · top centre    the scoreboard: one table either side of the day/night clock (a team a
//                   side when there are two teams), gold, lumber, food and APM per player,
//                   and the match clock under the medallion;
//   · bottom        the minimap with its option buttons, the HERO panel (up to four players
//                   side by side, each column's pulldown picking whose three heroes it
//                   shows — portrait, level, bars, learned skills and the belt), and a
//                   minimal readout of whatever is selected, with Auto Camera above it.
//
// Every icon names itself on hover through the game's own tooltip slab (`setGameTip`), and a
// click on a hero, a building at work or a unit type puts the camera on it.

import type { HudDriver, HudSelection } from "./hud";
import type { ObserverHero, ObserverIcon, ObserverPlayerView } from "../game/observerView";
import { OBSERVER_MAX_HEROES } from "../game/observerView";
import { setGameTip } from "./gameTip";
import { wc3ToHtml, escapeHtml } from "./wc3Text";
import { UI_HEIGHT } from "./fdf/layout";

/** One seat as the observer HUD shows it: the world's reading plus who the seat is. */
export interface ObserverSeat extends ObserverPlayerView {
  name: string;
  color: string; // CSS colour of the seat's current player colour
  race: string; // human | orc | undead | nightelf | …
  team: number;
}

/** A length in the 0.6-tall UI space, as CSS. */
const uiPx = (v: number): string => `calc(var(--stage-h) * ${v / UI_HEIGHT})`;

/**
 * The layout, in the 0.6-tall UI space so it scales with the frame like the console does.
 * `pull` is the game's own: `ObserverPanel.fdf` ObserverVisionMenu is a 0.024-tall POPUPMENU
 * with `PopupButtonInset 0.01`, on `EscMenuButtonBackdropTemplate` with `BackdropCornerSize
 * 0.0125` and `BackdropBackgroundInsets 0.004`; its title and menu text are `EscMenuTextFont`
 * 0.011 and `MenuItemHeight 0.012`; the arrow `EscMenuPopupMenuArrowTemplate` is 0.011 square.
 * `label` is `ObserverPanelStringTemplate`'s MasterFont 0.008. Everything else is OURS — the
 * install has no observer HUD to measure — and was sized off the issue's 1280×720 reference.
 */
const OBS = {
  edge: 0.004, // clear of the screen's edge
  gap: 0.003, // between two panels
  pull: { h: 0.024, corner: 0.0125, inset: 0.004, button: 0.01, font: 0.011, item: 0.012, border: 0.01, arrow: 0.011 },
  label: 0.008,
  /** The Menu / Chat buttons — the pulldown's own backdrop and type, one row. */
  button: { w: 0.084 },
  /** The production panel: its pulldown's width and the icons under each player. */
  prod: { w: 0.1, icon: 0.022, perRow: 10, max: 20 },
  /** The scoreboard either side of the clock. `clockHalf` is half the stone bridge the
   *  medallion sits in (ConsoleUi.gapFiller — 0.116 wide at every aspect, since the console is
   *  held at 4:3 and centred). */
  score: { clockHalf: 0.061, row: 0.0165, font: 0.0095, icon: 0.012, name: 0.075 },
  /** The bottom row. `h` fits three hero rows under a pulldown, which is the most heroes a
   *  melee player may field; the minimap is a square as tall as the panel's inside. */
  bottom: { h: 0.156, pad: 0.004, mmButtons: 0.021, column: 0.118 },
  hero: { portrait: 0.031, skill: 0.0145, item: 0.0135, bar: 0.0026, row: 0.0385 },
  /** `h` has room for the Status row under the stats (0.016 over the 0.118 it was). */
  sel: { w: 0.2, h: 0.134, icon: 0.03, font: 0.0082 },
  /** Auto Camera: `ObserverPanel.fdf`'s 0.02 SIMPLECHECKBOX, parked above the selection. */
  autoCam: { lift: 0.006 },
  /** The match clock's top — just under the medallion's rim. */
  time: 0.041,
} as const;

/** The tooltip frame's band and fill inset (hud.ts TOOLTIP_BOX) — every panel wears it. */
const FRAME_INSET = 0.002;

/** What the production panel's pulldown switches between. "Units" is the game's own word
 *  (`SCORESCREEN_TAB1`); "Production" and "Upgrades" are ours — no string in the install
 *  names either. */
type ProdView = "production" | "army" | "upgrades";

const RACE_ICON = (race: string): string => `UI\\Glues\\ScoreScreen\\scorescreen-player-${race}.blp`;

/** "m:ss", or "h:mm:ss" past the hour — the match clock under the medallion. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
}

/**
 * An 8-tile backdrop strip — the engine's BackdropEdgeFile, left, right, top, bottom and then
 * the four corners, with the two horizontal edges stored as VERTICAL bars — re-sliced into the
 * 3×3 nine-patch CSS `border-image` drives. The same cut hud.ts makes of the tooltip's strip,
 * at whatever tile size the strip has (its height).
 */
function ninePatch(strip: HTMLCanvasElement | null): { url: string; tile: number } | null {
  if (!strip) return null;
  const t = strip.height;
  if (strip.width < t * 8) return null;
  const out = document.createElement("canvas");
  out.width = out.height = t * 3;
  const g = out.getContext("2d")!;
  const tile = (i: number, cx: number, cy: number, turn = false): void => {
    g.save();
    g.translate(cx * t + t / 2, cy * t + t / 2);
    if (turn) g.rotate(Math.PI / 2);
    g.drawImage(strip, i * t, 0, t, t, -t / 2, -t / 2, t, t);
    g.restore();
  };
  tile(0, 0, 1); tile(1, 2, 1); tile(2, 1, 0, true); tile(3, 1, 2, true);
  tile(4, 0, 0); tile(5, 2, 0); tile(6, 0, 2); tile(7, 2, 2);
  return { url: out.toDataURL(), tile: t };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
};

/**
 * A POPUPMENU in the Esc menu's dress: the title button, the arrow at `PopupButtonInset` from
 * its right edge, and the list it drops. The list opens DOWN from a pulldown at the top of the
 * screen and UP from one on the bottom panel, so it never runs off the frame.
 */
class Pulldown {
  /** The wrapper: the button and its list are SIBLINGS in it, so the gamepad's focus walk
   *  (ui/gamepad.ts FOCUSABLE, which skips a control nested inside another) reaches the rows. */
  readonly el: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private readonly title: HTMLSpanElement;
  private readonly menu: HTMLDivElement;
  private open = false;

  constructor(
    parent: HTMLElement,
    private readonly items: () => Array<{ value: string; html: string }>,
    private readonly pick: (value: string) => void,
    up: boolean,
  ) {
    this.el = el("div", "obs-pull-wrap", parent);
    this.button = el("button", "obs-pull obs-esc", this.el);
    this.title = el("span", "obs-pull-title", this.button);
    el("span", "obs-pull-arrow", this.button);
    this.menu = el("div", `obs-pull-menu obs-esc${up ? " up" : ""}`, this.el);
    this.menu.hidden = true;
    this.button.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (this.open) this.close();
      else this.show();
    });
    this.menu.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const row = (e.target as HTMLElement).closest<HTMLElement>(".obs-pull-item");
      if (!row) return;
      this.close();
      this.pick(row.dataset.value ?? "");
    });
  }

  setTitle(html: string): void {
    if (this.title.innerHTML !== html) this.title.innerHTML = html;
  }

  private show(): void {
    this.menu.replaceChildren(...this.items().map(({ value, html }) => {
      const row = el("button", "obs-pull-item");
      row.dataset.value = value;
      row.innerHTML = html;
      return row;
    }));
    this.menu.hidden = false;
    this.open = true;
    // Any press elsewhere closes it, as a click off a WC3 pulldown does.
    const away = (e: PointerEvent): void => {
      if (this.el.contains(e.target as Node)) return;
      this.close();
    };
    this.away = away;
    window.addEventListener("pointerdown", away, true);
  }

  private away: ((e: PointerEvent) => void) | null = null;
  close(): void {
    this.menu.hidden = true;
    this.open = false;
    if (this.away) window.removeEventListener("pointerdown", this.away, true);
    this.away = null;
  }
}

/** An icon with its hover name, re-used across refreshes (keyed by the reading's own key). */
class IconSlot {
  readonly el: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private readonly secs: HTMLSpanElement;
  private icon = "";
  simId = 0;

  constructor(private readonly driver: HudDriver, cls: string, onClick: (slot: IconSlot) => void) {
    this.el = el("div", `obs-icon ${cls}`);
    this.secs = el("span", "obs-secs", this.el);
    this.badge = el("span", "hud-count-badge obs-badge", this.el);
    this.badge.appendChild(document.createElement("span"));
    this.el.addEventListener("pointerdown", (e) => {
      if (e.button === 0 && this.simId) { e.preventDefault(); onClick(this); }
    });
  }

  /** `seconds` prints the job's time in the middle, the way a cooldown counts down; `count`
   *  goes in the console's number box in the corner. Either may be null. */
  set(icon: string, name: string, seconds: number | null, count: number | null, simId = 0): void {
    this.setUrl(icon, () => (icon ? this.driver.blpUrl(icon) : null), name, seconds, count, simId);
  }

  /** The same, for art that arrives already decoded (the inventory's data URLs). */
  setDecoded(url: string | null, name: string, count: number | null): void {
    this.setUrl(url ?? "", () => url, name, null, count, 0);
  }

  private setUrl(key: string, url: () => string | null, name: string, seconds: number | null, count: number | null, simId: number): void {
    if (key !== this.icon) {
      this.icon = key;
      const u = url();
      this.el.style.backgroundImage = u ? `url(${u})` : "";
    }
    this.simId = simId;
    this.el.classList.toggle("clickable", simId !== 0);
    const s = seconds === null ? "" : String(seconds);
    if (this.secs.textContent !== s) this.secs.textContent = s;
    const c = count === null ? "" : String(count);
    const span = this.badge.firstElementChild as HTMLElement;
    if (span.textContent !== c) span.textContent = c;
    this.badge.hidden = c === "";
    setGameTip(this.el, name);
  }
}

/** How many Status icons the selection panel's row holds — the console's own eight
 *  (hud.ts `selStatusSlots`). */
const STATUS_MAX = 8;

/** A buff's name without its `|cffRRGGBB … |r` colour codes — the hover hint is plain text. */
function stripColour(text: string): string {
  return text.replace(/\|c[0-9a-fA-F]{8}|\|r/g, "");
}

/** Keep `host` holding exactly `n` slots made by `make`, re-using the ones already there. */
function sync<T extends { el: HTMLElement }>(host: HTMLElement, pool: T[], n: number, make: () => T): T[] {
  while (pool.length < n) pool.push(make());
  for (let i = 0; i < pool.length; i++) {
    const want = i < n;
    if (want && pool[i].el.parentElement !== host) host.appendChild(pool[i].el);
    else if (!want && pool[i].el.parentElement === host) pool[i].el.remove();
  }
  return pool.slice(0, n);
}

/**
 * Keep `host` holding one slot per key, in the keys' order, re-using the slot a key already
 * had — so an element keeps its job (and its hover name) when the list re-sorts, rather than
 * the slot under the pointer being handed whichever job now sorts into its place.
 *
 * An element is MOVED only when it is out of place: re-appending one that was already where it
 * belongs is a remove-and-insert the pointer's hover has no reason to go through.
 */
function syncKeyed<T extends { el: HTMLElement }>(host: HTMLElement, pool: Map<string, T>, keys: string[], make: () => T): T[] {
  const out = keys.map((k) => {
    let slot = pool.get(k);
    if (!slot) pool.set(k, (slot = make()));
    return slot;
  });
  const want = new Set(out.map((t) => t.el));
  for (const [k, t] of pool) {
    if (want.has(t.el)) continue;
    t.el.remove();
    pool.delete(k);
  }
  out.forEach((t, i) => {
    const at = host.children[i] ?? null;
    if (at !== t.el) host.insertBefore(t.el, at);
  });
  return out;
}

/** One hero row in a player's column: portrait over its two bars, skills, belt. */
class HeroRow {
  readonly el: HTMLDivElement;
  private readonly portrait: IconSlot;
  private readonly hp: HTMLDivElement;
  private readonly mana: HTMLDivElement;
  private readonly manaTrack: HTMLDivElement;
  private readonly skills: HTMLDivElement;
  private readonly belt: HTMLDivElement;
  private skillPool: IconSlot[] = [];
  private beltPool: IconSlot[] = [];

  constructor(private readonly driver: HudDriver, focus: (slot: IconSlot) => void) {
    this.el = el("div", "obs-hero");
    const left = el("div", "obs-hero-left", this.el);
    this.portrait = new IconSlot(driver, "obs-portrait", focus);
    left.appendChild(this.portrait.el);
    const bars = el("div", "obs-bars", left);
    const hpTrack = el("div", "obs-bar", bars);
    this.hp = el("div", "obs-bar-fill", hpTrack);
    this.manaTrack = el("div", "obs-bar", bars);
    this.mana = el("div", "obs-bar-fill mana", this.manaTrack);
    this.skills = el("div", "obs-skills", this.el);
    this.belt = el("div", "obs-belt", this.el);
    for (let i = 0; i < 6; i++) {
      const slot = new IconSlot(driver, "obs-item", () => {});
      this.beltPool.push(slot);
      this.belt.appendChild(slot.el);
    }
  }

  show(h: ObserverHero, levelClass: (level: number, type: string) => string): void {
    const name = h.properName ? `${h.properName} — ${levelClass(h.level, h.typeName)}` : levelClass(h.level, h.typeName);
    const icon = h.dead ? (h.disabledIcon ?? h.icon) : h.icon;
    this.portrait.set(icon, name, h.dead && h.reviveSecondsLeft > 0 ? h.reviveSecondsLeft : null, h.level, h.simId);
    this.el.classList.toggle("dead", h.dead);
    this.hp.style.width = `${Math.max(0, Math.min(1, h.hpFrac)) * 100}%`;
    this.hp.dataset.state = h.hpFrac > 0.6 ? "green" : h.hpFrac > 0.3 ? "yellow" : "red";
    this.manaTrack.hidden = h.manaFrac < 0;
    this.mana.style.width = `${Math.max(0, h.manaFrac) * 100}%`;
    const skills = sync(this.skills, this.skillPool, h.skills.length, () => new IconSlot(this.driver, "obs-skill", () => {}));
    h.skills.forEach((s, i) => skills[i].set(s.icon, `${s.name} (${this.levelWord(s.value)})`, null, s.value));
    for (let i = 0; i < 6; i++) {
      const it = h.items[i] ?? null;
      const slot = this.beltPool[i];
      slot.el.classList.toggle("empty", !it);
      if (it) slot.set(it.icon, it.name, null, it.value > 1 ? it.value : null);
      else slot.set("", "", null, null);
    }
  }

  /** "Level N" — the info panel's own `INFOPANEL_LEVEL`. */
  levelWord: (n: number) => string = (n) => `Level ${n}`;
}

/** One player's column on the hero panel: its pulldown and up to three hero rows. */
class HeroColumn {
  readonly el: HTMLDivElement;
  readonly pull: Pulldown;
  private readonly rows: HTMLDivElement;
  private pool: HeroRow[] = [];
  private readonly empty: HTMLDivElement;

  constructor(private readonly driver: HudDriver, items: () => Array<{ value: string; html: string }>, pick: (v: string) => void, private readonly focus: (slot: IconSlot) => void, private readonly levelWord: (n: number) => string) {
    this.el = el("div", "obs-herocol");
    this.pull = new Pulldown(this.el, items, pick, true);
    this.rows = el("div", "obs-herorows", this.el);
    this.empty = el("div", "obs-none", this.rows);
  }

  show(seat: ObserverSeat | undefined, levelClass: (level: number, type: string) => string, noHeroes: string): void {
    this.pull.setTitle(seat ? seatHtml(seat) : "");
    const heroes = seat?.heroes.slice(0, OBSERVER_MAX_HEROES) ?? [];
    const rows = sync(this.rows, this.pool, heroes.length, () => {
      const r = new HeroRow(this.driver, this.focus);
      r.levelWord = this.levelWord;
      return r;
    });
    heroes.forEach((h, i) => rows[i].show(h, levelClass));
    this.empty.hidden = heroes.length > 0;
    if (!this.empty.hidden && this.empty.parentElement !== this.rows) this.rows.appendChild(this.empty);
    this.empty.textContent = noHeroes;
  }
}

/** A seat's swatch and name, as a pulldown row or title shows it. */
function seatHtml(seat: ObserverSeat): string {
  return `<span class="obs-swatch" style="background:${seat.color}"></span>${escapeHtml(seat.name)}`;
}

export class ObserverHud {
  private readonly root: HTMLDivElement;
  private readonly prodPull: Pulldown;
  private readonly prodList: HTMLDivElement;
  private prodView: ProdView = "production";
  private readonly prodBlocks = new Map<number, { el: HTMLDivElement; label: HTMLDivElement; icons: HTMLDivElement; pool: Map<string, IconSlot> }>();
  private readonly scoreLeft: HTMLDivElement;
  private readonly scoreRight: HTMLDivElement;
  private readonly time: HTMLDivElement;
  private readonly heroPanel: HTMLDivElement;
  private heroCols: HeroColumn[] = [];
  /** Which seat each hero column shows — the columns' own pulldowns change it. */
  private shown: number[] = [];
  private readonly sel: {
    panel: HTMLDivElement; name: HTMLDivElement; sub: HTMLDivElement;
    hp: HTMLDivElement; hpFill: HTMLDivElement; hpText: HTMLSpanElement;
    mp: HTMLDivElement; mpFill: HTMLDivElement; mpText: HTMLSpanElement;
    xp: HTMLDivElement; xpFill: HTMLDivElement; xpText: HTMLSpanElement;
    icon: IconSlot; lines: HTMLDivElement; belt: HTMLDivElement; beltPool: IconSlot[];
    job: HTMLDivElement; jobIcon: IconSlot; jobFill: HTMLDivElement; jobText: HTMLSpanElement;
    jobQueue: HTMLDivElement; jobPool: Map<string, IconSlot>;
    status: HTMLDivElement; statusIcons: HTMLDivElement; statusPool: IconSlot[];
  };
  private seats: ObserverSeat[] = [];
  private t = Infinity;

  constructor(parent: HTMLElement, private readonly driver: HudDriver, adopt: { minimap: HTMLElement; minimapButtons: HTMLElement[]; autoCamera: HTMLElement }) {
    this.root = el("div", "obs-hud", parent);
    // For the one piece of the screen outside the HUD that has to make room: the fps strip in
    // the bottom corner (ui/metrics.ts), which would otherwise sit on the minimap panel.
    document.body.classList.add("observer-hud");
    this.applySkin();
    const s = this.root.style;
    s.setProperty("--obs-edge", uiPx(OBS.edge));
    s.setProperty("--obs-gap", uiPx(OBS.gap));
    s.setProperty("--obs-frame-inset", uiPx(FRAME_INSET));
    s.setProperty("--obs-pull-h", uiPx(OBS.pull.h));
    s.setProperty("--obs-pull-corner", uiPx(OBS.pull.corner));
    s.setProperty("--obs-pull-inset", uiPx(OBS.pull.inset));
    s.setProperty("--obs-pull-button", uiPx(OBS.pull.button));
    s.setProperty("--obs-pull-font", uiPx(OBS.pull.font));
    s.setProperty("--obs-pull-item", uiPx(OBS.pull.item));
    s.setProperty("--obs-pull-border", uiPx(OBS.pull.border));
    s.setProperty("--obs-pull-arrow", uiPx(OBS.pull.arrow));
    s.setProperty("--obs-label", uiPx(OBS.label));
    s.setProperty("--obs-button-w", uiPx(OBS.button.w));
    s.setProperty("--obs-prod-w", uiPx(OBS.prod.w));
    s.setProperty("--obs-prod-icon", uiPx(OBS.prod.icon));
    s.setProperty("--obs-prod-row", uiPx(OBS.prod.perRow * (OBS.prod.icon + 0.002)));
    s.setProperty("--obs-score-clock", uiPx(OBS.score.clockHalf));
    s.setProperty("--obs-score-row", uiPx(OBS.score.row));
    s.setProperty("--obs-score-font", uiPx(OBS.score.font));
    s.setProperty("--obs-score-icon", uiPx(OBS.score.icon));
    s.setProperty("--obs-score-name", uiPx(OBS.score.name));
    s.setProperty("--obs-bottom-h", uiPx(OBS.bottom.h));
    s.setProperty("--obs-bottom-pad", uiPx(OBS.bottom.pad));
    s.setProperty("--obs-mm", uiPx(OBS.bottom.h - 2 * OBS.bottom.pad));
    s.setProperty("--obs-mm-buttons", uiPx(OBS.bottom.mmButtons));
    s.setProperty("--obs-column", uiPx(OBS.bottom.column));
    s.setProperty("--obs-portrait", uiPx(OBS.hero.portrait));
    s.setProperty("--obs-skill", uiPx(OBS.hero.skill));
    s.setProperty("--obs-item", uiPx(OBS.hero.item));
    s.setProperty("--obs-bar", uiPx(OBS.hero.bar));
    s.setProperty("--obs-hero-row", uiPx(OBS.hero.row));
    s.setProperty("--obs-sel-w", uiPx(OBS.sel.w));
    s.setProperty("--obs-sel-h", uiPx(OBS.sel.h));
    s.setProperty("--obs-sel-icon", uiPx(OBS.sel.icon));
    s.setProperty("--obs-sel-font", uiPx(OBS.sel.font));
    s.setProperty("--obs-autocam-lift", uiPx(OBS.autoCam.lift));
    s.setProperty("--obs-time-top", uiPx(OBS.time));
    // Where the bottom row's panels stand. Every panel is the tooltip frame, whose stroke hangs
    // FRAME_INSET outside the fill, so each edge and each gap between two panels allows for it.
    const b = OBS.bottom, e = OBS.edge + FRAME_INSET;
    const mmW = b.pad + b.h + b.mmButtons; // pad, square map, pad, buttons, pad
    const heroesLeft = e + mmW + OBS.gap + 2 * FRAME_INSET;
    s.setProperty("--obs-e", uiPx(e));
    s.setProperty("--obs-mm-w", uiPx(mmW));
    s.setProperty("--obs-heroes-left", uiPx(heroesLeft));
    s.setProperty("--obs-heroes-room", uiPx(heroesLeft + OBS.gap + 2 * FRAME_INSET + OBS.sel.w + e));

    // ── top left: Menu and Chat, then the production panel ──
    const buttons = el("div", "obs-buttons", this.root);
    this.buttons = buttons;
    for (const [panel, key, fallback] of [["menu", "KEY_MENU", "Menu (|Cfffed312F10|R)"], ["chat", "KEY_CHAT", "Chat (|Cfffed312F12|R)"]] as const) {
      const b = el("button", "obs-button obs-esc", buttons);
      b.innerHTML = `<span>${wc3ToHtml(driver.uiString(key, fallback))}</span>`;
      b.addEventListener("pointerdown", (e) => { if (e.button === 0) e.preventDefault(); });
      b.addEventListener("click", () => driver.openConsolePanel(panel));
    }
    const prod = el("div", "obs-prod", this.root);
    const views: Array<[ProdView, string]> = [
      ["production", "Production"],
      ["army", driver.uiString("SCORESCREEN_TAB1", "Units")],
      ["upgrades", "Upgrades"],
    ];
    this.prodPull = new Pulldown(prod, () => views.map(([value, label]) => ({ value, html: escapeHtml(label) })), (v) => {
      this.prodView = v as ProdView;
      this.t = Infinity;
    }, false);
    this.prodList = el("div", "obs-prod-list", prod);
    this.prodPull.setTitle(escapeHtml(views[0][1]));
    this.prodViews = views;

    // ── top centre: the scoreboard and the match clock ──
    this.scoreLeft = el("div", "obs-panel obs-score left", this.root);
    this.scoreRight = el("div", "obs-panel obs-score right", this.root);
    this.time = el("div", "obs-time", this.root);

    // ── bottom: minimap, heroes, selection ──
    const mm = el("div", "obs-panel obs-minimap", this.root);
    const mapSlot = el("div", "obs-minimap-map", mm);
    mapSlot.appendChild(adopt.minimap);
    const column = el("div", "obs-minimap-buttons", mm);
    for (const b of adopt.minimapButtons) column.appendChild(b);
    this.heroPanel = el("div", "obs-panel obs-heroes", this.root);
    const selPanel = el("div", "obs-panel obs-sel", this.root);
    const name = el("div", "obs-sel-name", selPanel);
    const sub = el("div", "obs-sel-sub", selPanel);
    const bar = (cls: string, parent: HTMLElement = selPanel): [HTMLDivElement, HTMLDivElement, HTMLSpanElement] => {
      const track = el("div", `obs-sel-bar ${cls}`, parent);
      const fill = el("div", `obs-bar-fill ${cls}`, track);
      const text = el("span", "obs-sel-bar-text", track);
      return [track, fill, text];
    };
    const [hp, hpFill, hpText] = bar("hp");
    const [mp, mpFill, mpText] = bar("mana");
    // A hero's experience, under its mana: the console's XP bar (`SimpleHeroLevelBar`, the
    // violet `XpBarConsole` tint — BIGBAR_TINT.xp in hud.ts) with its numbers ON it, since a
    // watcher has no time to hover for them.
    const [xp, xpFill, xpText] = bar("xp");
    const row = el("div", "obs-sel-row", selPanel);
    const icon = new IconSlot(driver, "obs-sel-icon", (slot) => driver.observerFocus(slot.simId));
    row.appendChild(icon.el);
    const lines = el("div", "obs-sel-lines", row);
    // A building at WORK: what it is making, the build bar with the seconds left on it, and the
    // jobs lined up behind — the info panel's training readout, so a watcher who clicks an
    // altar sees WHICH hero is coming (a unit's icon alone on the production strip does not
    // say whether it is a hire or a revival).
    const job = el("div", "obs-sel-job", row);
    const jobHead = el("div", "obs-sel-job-head", job);
    const jobIcon = new IconSlot(driver, "obs-sel-job-icon", () => {});
    jobHead.appendChild(jobIcon.el);
    const [, jobFill, jobText] = bar("progress", jobHead);
    const jobQueue = el("div", "obs-sel-job-queue", job);
    const belt = el("div", "obs-sel-belt", row);
    const beltPool: IconSlot[] = [];
    for (let i = 0; i < 6; i++) {
      const slot = new IconSlot(driver, "obs-item", () => {});
      beltPool.push(slot);
      belt.appendChild(slot.el);
    }
    // THE STATUS LINE, as the console's info panel draws it: the game's own label
    // (`InfoPanelStrings.fdf` COLON_STATUS "Status:", in the info panel's label gold) and then
    // the buffs' own `Buffart` icons on one row, each naming itself on hover (hud.ts
    // `renderStatus`, whose list this is — `HudSelection.buffs`).
    const status = el("div", "obs-sel-status", selPanel);
    const statusLabel = el("span", "obs-sel-key obs-sel-status-label", status);
    statusLabel.textContent = driver.uiString("COLON_STATUS", "Status:");
    const statusIcons = el("div", "obs-sel-status-icons", status);
    this.sel = {
      panel: selPanel, name, sub, hp, hpFill, hpText, mp, mpFill, mpText, xp, xpFill, xpText,
      icon, lines, belt, beltPool, job, jobIcon, jobFill, jobText, jobQueue, jobPool: new Map(),
      status, statusIcons, statusPool: [],
    };
    // Auto Camera stands ABOVE the selection, on no panel of its own (the replay panel it
    // belongs to is for replays, which OpenWar3 does not have yet).
    this.root.appendChild(adopt.autoCamera);
    adopt.autoCamera.classList.add("obs-autocam");
  }

  private readonly prodViews: Array<[ProdView, string]>;
  private readonly buttons: HTMLDivElement;

  dispose(): void {
    document.body.classList.remove("observer-hud");
    this.root.remove();
  }

  /** The Esc menu's backdrop and the pulldown arrow, handed to the stylesheet. The panels
   *  wear the tooltip frame hud.ts has already put on `:root`. */
  private applySkin(): void {
    const d = this.driver;
    const border = ninePatch(d.blpCanvas(d.skinPath("EscMenuButtonBorder")));
    const fill = d.blpUrl(d.skinPath("EscMenuButtonBackground"));
    const menuFill = d.blpUrl(d.skinPath("EscMenuEditBoxBackground"));
    const arrow = d.blpUrl(d.skinPath("EscMenuPopupMenuArrow"));
    const s = this.root.style;
    if (border) {
      s.setProperty("--obs-esc-border", `url(${border.url})`);
      s.setProperty("--obs-esc-slice", String(border.tile));
    }
    if (fill) s.setProperty("--obs-esc-fill", `url(${fill})`);
    if (menuFill) s.setProperty("--obs-esc-menu-fill", `url(${menuFill})`);
    if (arrow) s.setProperty("--obs-esc-arrow", `url(${arrow})`);
    this.root.classList.toggle("skinned", !!(border && fill));
  }

  /** At the info panel's rate: every reading here moves at the speed of a number, not a frame. */
  frame(dtMs: number): void {
    this.t += dtMs;
    const time = clock(this.driver.matchSeconds());
    if (this.time.textContent !== time) this.time.textContent = time;
    if (this.t < 250) return;
    this.t = 0;
    this.seats = this.driver.observerSeats();
    this.renderScore();
    this.renderProduction();
    this.renderHeroes();
    this.renderSelection();
  }

  private levelClass = (level: number, type: string): string =>
    this.driver.uiString("INFOPANEL_LEVEL_CLASS", "Level %u %s").replace("%u", String(level)).replace("%s", type);
  private levelWord = (n: number): string => this.driver.uiString("INFOPANEL_LEVEL", "Level %u").replace("%u", String(n));

  private focus = (slot: IconSlot): void => this.driver.observerFocus(slot.simId);

  /** Two teams: a team a side. Anything else (a free-for-all, three teams): the first half of
   *  the seats on the left, the rest on the right. */
  private sides(): [ObserverSeat[], ObserverSeat[]] {
    const teams = [...new Set(this.seats.map((s) => s.team))];
    if (teams.length === 2) return [this.seats.filter((s) => s.team === teams[0]), this.seats.filter((s) => s.team === teams[1])];
    const half = Math.ceil(this.seats.length / 2);
    return [this.seats.slice(0, half), this.seats.slice(half)];
  }

  private renderScore(): void {
    const [left, right] = this.sides();
    const d = this.driver;
    // The tooltip's cost icons (`ToolTipGoldIcon` & co.), which is what the HUD prints a price
    // with: the resource bar's own `ResourceGold.blp` has no alpha channel and drew a black
    // square on the panel's slate.
    const icon = (kind: "gold" | "lumber" | "supply"): string => {
      const url = d.icon(kind);
      return url ? `<img class="obs-score-img" src="${url}">` : "<span></span>";
    };
    const gold = icon("gold"), lumber = icon("lumber"), food = icon("supply");
    const rows = (list: ObserverSeat[]): string => list.map((s) => {
      // The score screen's race mark is a 2:1 framed portrait across the middle of a 64² texture.
      const race = d.blpUrl(RACE_ICON(s.race));
      return `<span class="obs-score-swatch" style="background:${s.color}"></span>`
        + `<span class="obs-score-race"${race ? ` style="background-image:url(${race})"` : ""}></span>`
        + `<span class="obs-score-name">${escapeHtml(s.name)}</span>`
        + `${gold}<span>${s.gold}</span>${lumber}<span>${s.lumber}</span>${food}<span>${s.foodUsed}/${s.foodMax}</span>`
        + `<span class="obs-score-apm">APM</span><span>${s.apm}</span>`;
    }).join("");
    for (const [host, list] of [[this.scoreLeft, left], [this.scoreRight, right]] as const) {
      const html = rows(list);
      if (host.dataset.html !== html) {
        host.dataset.html = html;
        host.innerHTML = html;
      }
      host.hidden = list.length === 0;
    }
    this.clearScoreboard();
  }

  /**
   * On a narrow screen the left table reaches the Menu and Chat buttons. At 16:9 there is room
   * for both, but at 4:3 (the stage keeps the window's aspect between the two, ui/stage.ts)
   * there is not. The top-left block then drops below the scoreboard instead of running under
   * it. This is measured rather than keyed on an aspect, because how wide a table is depends on
   * its names and figures.
   */
  private clearScoreboard(): void {
    const table = this.scoreLeft;
    if (table.hidden) { this.root.classList.remove("stacked"); return; }
    const root = this.root.getBoundingClientRect();
    const scale = this.root.offsetHeight > 0 ? root.height / this.root.offsetHeight : 1;
    const t = table.getBoundingClientRect();
    const b = this.buttons.getBoundingClientRect();
    // Compared as if unstacked: the buttons' right edge does not move when they drop.
    const collide = t.left < b.right + 4 * scale;
    this.root.classList.toggle("stacked", collide);
    if (collide) this.root.style.setProperty("--obs-score-bottom", `${(t.bottom - root.top) / scale}px`);
  }

  private renderProduction(): void {
    this.prodPull.setTitle(escapeHtml(this.prodViews.find(([v]) => v === this.prodView)![1]));
    const live = new Set<number>();
    for (const seat of this.seats) {
      live.add(seat.player);
      let b = this.prodBlocks.get(seat.player);
      if (!b) {
        const blockEl = el("div", "obs-prod-block");
        const label = el("div", "obs-prod-label", blockEl);
        const icons = el("div", "obs-prod-icons", blockEl);
        b = { el: blockEl, label, icons, pool: new Map() };
        this.prodBlocks.set(seat.player, b);
      }
      const label = seatHtml(seat);
      if (b.label.innerHTML !== label) b.label.innerHTML = label;
      const list: ObserverIcon[] = (this.prodView === "production" ? seat.production : this.prodView === "army" ? seat.army : seat.upgrades).slice(0, OBS.prod.max);
      // Keyed by the reading's own key and the VIEW, so switching the pulldown never hands one
      // view's slot (and its hover name) to another's.
      const slots = syncKeyed(b.icons, b.pool, list.map((it) => `${this.prodView}:${it.key}`), () => new IconSlot(this.driver, "obs-prod-icon", this.focus));
      list.forEach((it, i) => {
        if (this.prodView === "production") slots[i].set(it.icon, it.name, it.value, null, it.simId);
        else if (this.prodView === "army") slots[i].set(it.icon, it.name, null, it.value, it.simId);
        else slots[i].set(it.icon, `${it.name} (${this.levelWord(it.value)})`, null, it.value);
      });
      b.el.classList.toggle("idle", list.length === 0);
    }
    for (const [p, b] of this.prodBlocks) if (!live.has(p)) b.el.remove();
    // Keep the blocks in seat order — moving one only when it is out of place (see syncKeyed).
    this.seats.forEach((seat, i) => {
      const b = this.prodBlocks.get(seat.player)!;
      const at = this.prodList.children[i] ?? null;
      if (at !== b.el) this.prodList.insertBefore(b.el, at);
    });
  }

  private renderHeroes(): void {
    const n = Math.min(4, this.seats.length);
    const [left, right] = this.sides();
    const order = [...left, ...right].map((s) => s.player);
    // Keep each column on the seat it was showing; fill new or orphaned columns in order.
    const next: number[] = [];
    for (let i = 0; i < n; i++) {
      const was = this.shown[i];
      if (was !== undefined && order.includes(was) && !next.includes(was)) next.push(was);
      else next.push(order.find((p) => !next.includes(p) && !this.shown.slice(i + 1).includes(p)) ?? order[i]);
    }
    this.shown = next;
    this.heroPanel.style.setProperty("--obs-cols", String(n));
    this.heroPanel.hidden = n === 0;
    while (this.heroCols.length < n) {
      const i = this.heroCols.length;
      const col = new HeroColumn(this.driver,
        () => this.seats.map((s) => ({ value: String(s.player), html: seatHtml(s) })),
        (v) => this.pickColumn(i, Number(v)), this.focus, this.levelWord);
      this.heroCols.push(col);
    }
    this.heroCols.forEach((col, i) => {
      if (i < n) {
        if (col.el.parentElement !== this.heroPanel) this.heroPanel.appendChild(col.el);
        col.show(this.seats.find((s) => s.player === this.shown[i]), this.levelClass, "");
      } else col.el.remove();
    });
  }

  /** A column's pulldown picked `player`: show them there, and if another column already
   *  was, hand it the player this one is giving up — the two swap. */
  private pickColumn(index: number, player: number): void {
    const other = this.shown.indexOf(player);
    if (other >= 0 && other !== index) this.shown[other] = this.shown[index];
    this.shown[index] = player;
    this.t = Infinity;
  }

  /** The selected building's job: its icon, verb and seconds on the build bar, and the queue
   *  behind it. The verbs are GlobalStrings' own (`CONSTRUCTING`, `TRAINING`, `RESEARCHING`,
   *  `REVIVING`); a tier upgrade has none there, so it reads the name of what it becomes. */
  private renderJob(sel: HudSelection): void {
    const s = this.sel;
    const d = this.driver;
    const constructing = sel.underConstruction;
    const head = constructing ? null : sel.queue[0] ?? null;
    const secs = Math.max(0, Math.ceil(sel.secondsLeft));
    const verb = constructing ? d.uiString("CONSTRUCTING", "Constructing")
      : head?.kind === "research" ? d.uiString("RESEARCHING", "Researching")
      : head?.kind === "revive" ? d.uiString("REVIVING", "Reviving")
      : head?.kind === "upgrade" ? head.name
      : d.uiString("TRAINING", "Training");
    const text = `${verb} (${secs}s)`;
    if (s.jobText.textContent !== text) s.jobText.textContent = text;
    const frac = Math.max(0, Math.min(1, constructing ? sel.buildProgress : sel.trainProgress));
    s.jobFill.style.width = `${frac * 100}%`;
    s.jobIcon.el.hidden = !head;
    if (head) s.jobIcon.set(head.icon, head.name, null, null);
    // Keyed by POSITION and icon: the queue has no ids, and two Footmen in a row are two jobs.
    const rest = constructing ? [] : sel.queue.slice(1);
    const slots = syncKeyed(s.jobQueue, s.jobPool, rest.map((q, i) => `${i}:${q.icon}`), () => new IconSlot(d, "obs-sel-job-q", () => {}));
    rest.forEach((q, i) => slots[i].set(q.icon, q.name, null, null));
  }

  private renderSelection(): void {
    const sel: HudSelection | null = this.driver.selection();
    const s = this.sel;
    s.panel.classList.toggle("empty", !sel);
    if (!sel) return;
    const title = sel.properName || sel.name;
    if (s.name.textContent !== title) s.name.textContent = title;
    const sub = sel.isHero ? this.levelClass(sel.level, sel.name) : "";
    if (s.sub.textContent !== sub) s.sub.textContent = sub;
    s.sub.hidden = !sub;
    const hpFrac = sel.maxHp > 0 ? sel.hp / sel.maxHp : 0;
    s.hp.hidden = sel.maxHp <= 0;
    s.hpFill.style.width = `${Math.max(0, Math.min(1, hpFrac)) * 100}%`;
    s.hpFill.dataset.state = hpFrac > 0.6 ? "green" : hpFrac > 0.3 ? "yellow" : "red";
    s.hpText.textContent = `${Math.ceil(sel.hp)} / ${Math.round(sel.maxHp)}`;
    s.mp.hidden = sel.maxMana <= 0;
    s.mpFill.style.width = `${sel.maxMana > 0 ? Math.max(0, Math.min(1, sel.mana / sel.maxMana)) * 100 : 0}%`;
    s.mpText.textContent = `${Math.floor(sel.mana)} / ${Math.round(sel.maxMana)}`;
    // Experience INTO this level over what the level spans — the numbers the console's bar
    // hovers ("Experience: 120 / 400"), and a full bar at the top level.
    const xpSpan = sel.xpNext - sel.xpThis;
    s.xp.hidden = !(sel.isHero && sel.level > 0 && !sel.isSummon);
    if (!s.xp.hidden) {
      const into = Math.max(0, Math.round(sel.xp - sel.xpThis));
      s.xpFill.style.width = `${xpSpan > 0 ? Math.max(0, Math.min(1, into / xpSpan)) * 100 : 100}%`;
      const t = xpSpan > 0 ? `${into} / ${xpSpan}` : this.levelWord(sel.level);
      if (s.xpText.textContent !== t) s.xpText.textContent = t;
    }
    s.icon.set(sel.icon, title, null, null, sel.id);
    // The lines the info panel would lead with, in its own words (InfoPanelStrings via
    // uiString), and nothing past them — this panel is the minimal version.
    const d = this.driver;
    const gold = (k: string, f: string): string => `<span class="obs-sel-key">${escapeHtml(d.uiString(k, f))}</span>`;
    const working = sel.isBuilding && (sel.underConstruction || sel.queueLength > 0);
    s.job.hidden = !working;
    s.lines.hidden = working;
    if (working) this.renderJob(sel);
    let lines = "";
    if (working) {
      // the job readout above stands in for the lines
    } else if (sel.isMine) {
      lines = `${gold("COLON_GOLD", "Gold:")} ${sel.goldRemaining}`;
    } else {
      const dmg = sel.damageMax > 0 ? `${gold("COLON_DAMAGE", "Damage:")} ${sel.damageMin} - ${sel.damageMax}${sel.damageBonus ? ` <span class="obs-bonus">+${sel.damageBonus}</span>` : ""}<br>` : "";
      const armor = `${gold("COLON_ARMOR", "Armor:")} ${Math.round(sel.armor)}${sel.armorBonus ? ` <span class="obs-bonus">+${Math.round(sel.armorBonus)}</span>` : ""}`;
      // A hero's three attributes on one line, each behind the info panel's own attribute art
      // (`InfoPanelIconHeroIconSTR` & co. — war3skins' `HeroStrengthIcon` names a file 1.30.4
      // never shipped) with its name on hover, rather than three labelled lines.
      const attr = (key: string, name: string, fallback: string, value: number, bonus: number): string => {
        const url = d.blpUrl(d.skinPath(key));
        const tip = escapeHtml(d.uiString(name, fallback).replace(/:$/, ""));
        return `<span class="obs-attr" data-tip="${tip}">${url ? `<img src="${url}">` : ""}${value}${bonus ? `<span class="${bonus > 0 ? "obs-bonus" : "obs-malus"}">${bonus > 0 ? "+" : ""}${bonus}</span>` : ""}</span>`;
      };
      const attrs = sel.isHero
        ? `<br>${attr("InfoPanelIconHeroIconSTR", "COLON_STRENGTH", "Strength:", sel.strength, sel.strengthBonus)}${attr("InfoPanelIconHeroIconAGI", "COLON_AGILITY", "Agility:", sel.agility, sel.agilityBonus)}${attr("InfoPanelIconHeroIconINT", "COLON_INTELLECT", "Intelligence:", sel.intelligence, sel.intelligenceBonus)}`
        : "";
      lines = dmg + armor + attrs;
    }
    if (s.lines.dataset.html !== lines) {
      s.lines.dataset.html = lines;
      s.lines.innerHTML = lines;
      for (const a of s.lines.querySelectorAll<HTMLElement>(".obs-attr")) setGameTip(a, a.dataset.tip ?? "");
    }
    // The buffs, auras and debuffs — hidden with nothing on the unit, as the console hides its
    // Status line. The row is always RESERVED in the panel, so a buff landing does not shove
    // the belt up and down under the watcher's eye.
    const buffs = sel.buffs;
    s.status.classList.toggle("none", buffs.length === 0);
    const slots = sync(s.statusIcons, s.statusPool, Math.min(buffs.length, STATUS_MAX), () => new IconSlot(d, "obs-buff", () => {}));
    slots.forEach((slot, i) => slot.set(buffs[i].icon, stripColour(buffs[i].name), null, null));
    const inv = sel.isHero ? this.driver.inventory() : [];
    s.belt.hidden = inv.length === 0;
    for (let i = 0; i < 6; i++) {
      const it = inv[i] ?? null;
      const slot = s.beltPool[i];
      slot.el.classList.toggle("empty", !it);
      if (it) slot.setDecoded(it.icon, it.name, it.charges > 0 ? it.charges : null);
      else slot.set("", "", null, null);
    }
  }
}
