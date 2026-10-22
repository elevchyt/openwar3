// The dev tools drawer (the chat's `toolsofthetrade`): docked down the right edge of the match,
// between the resource bar and the console, so the map stays visible and live while you spawn
// and the command card stays reachable for whatever was just made. Three tabs — Spawn, Cheats,
// Overlays — replace the old stack of corner buttons.
//
// None of this is the game's: WC3 has no debug UI. It wears the tooltip frame the observer
// panels wear (`.obs-panel`'s recipe) so it reads as part of the HUD rather than a web page,
// and it draws no cursor of its own (the game cursor is the only cursor — see ui/cursor.ts).
//
// SINGLE PLAYER ONLY, as the panel it replaces was: the HUD hides it while `cheatsAllowed` is
// false, a click on it is swallowed in that case, and every driver call it makes refuses on its
// own in a networked match — three doors, so no one of them has to be the only one.

import type { CheatKind } from "../game/rts";
import { setGameTip } from "./gameTip";
import type { HudDriver, SpawnEntry, SpawnOwner } from "./hud";
import { wc3StripMarkup } from "./wc3Text";

type Tab = "spawn" | "cheats" | "overlays";
type Kind = SpawnEntry["kind"];

const KINDS: ReadonlyArray<[Kind, string]> = [["hero", "Heroes"], ["unit", "Units"], ["building", "Buildings"], ["item", "Items"]];
const RACE_LABEL: Record<string, string> = {
  human: "Human", orc: "Orc", undead: "Undead", nightelf: "Night Elf", naga: "Naga", creeps: "Creeps",
  demon: "Demon", critters: "Critters", commoner: "Commoner", other: "Other",
};
const RACE_ORDER = Object.keys(RACE_LABEL);
// MAX_HERO_LEVEL is MiscGame's; these are only the presets the row offers.
const LEVELS = [1, 3, 6, 10];
const COUNTS = [1, 5, 10, 25];
const SINGULAR: Record<Kind, string> = { hero: "Hero", unit: "Unit", building: "Building", item: "Item" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class DevToolsDrawer {
  readonly root: HTMLDivElement;
  private readonly drawer: HTMLDivElement;
  private readonly handle: HTMLButtonElement;
  private readonly cheatButtons = new Map<CheatKind, HTMLButtonElement>();
  private readonly pages = new Map<Tab, HTMLElement>();
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = "spawn";
  private expanded = true;

  // --- the Spawn tab's state
  private catalog: SpawnEntry[] | null = null;
  private owners: SpawnOwner[] = [];
  private counts = new Map<string, number>();
  private kind: Kind = "hero";
  private group = "all";
  private meleeOnly = true;
  private query = "";
  private readonly picked = new Map<Kind, string>();
  private owner = 0;
  private level = 10;
  private learnAll = true;
  private count = 1;
  private placing = false;

  // --- the Spawn tab's DOM
  private readonly kindRow = el("div", "dev-seg");
  private readonly search = el("input", "dev-search");
  private readonly groupRow = el("div", "dev-chips");
  private readonly list = el("div", "dev-list");
  private readonly ownerRow = el("div", "dev-row");
  private readonly ownerLabel = el("span", "dev-owner-label");
  private readonly levelRow = el("div", "dev-row");
  private readonly countRow = el("div", "dev-row");
  private readonly placeBtn = el("button", "dev-btn dev-btn-main", "Click map to place");
  private readonly nowBtn = el("button", "dev-btn", "At camera");
  private readonly iconObserver: IntersectionObserver;

  // --- the Overlays tab's concede readout: beside the drawer, outside it, so it stays up
  // whichever tab is open (and hides with the whole thing, since it is a child of `root`).
  private readonly concedeBox = el("div", "dev-concede");
  private concedeTimer = 0;

  constructor(private readonly driver: HudDriver) {
    this.root = el("div", "dev-tools");
    this.root.hidden = true;
    // Capture phase on the panel runs before any button's own handler.
    this.root.addEventListener("click", (e) => {
      if (this.driver.cheatsAllowed()) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);

    this.drawer = el("div", "dev-drawer");
    this.handle = el("button", "dev-handle", "Dev Tools");
    this.handle.onclick = () => this.setExpanded(true);
    this.concedeBox.hidden = true;
    this.root.append(this.drawer, this.handle, this.concedeBox);

    // An icon is a BLP decoded to a data URL on first ask, so a list of several hundred rows
    // only decodes the ones scrolled into view.
    this.iconObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target as HTMLImageElement;
        this.iconObserver.unobserve(img);
        const url = this.driver.blpUrl(img.dataset.icon ?? "");
        if (url) img.src = url;
      }
    }, { root: this.list });

    const tabs = el("div", "dev-tabs");
    for (const [t, label] of [["spawn", "Spawn"], ["cheats", "Cheats"], ["overlays", "Overlays"]] as Array<[Tab, string]>) {
      const b = el("button", "dev-tab", label);
      b.onclick = () => this.setTab(t);
      this.tabButtons.set(t, b);
      tabs.append(b);
    }
    const close = el("button", "dev-close", "✕");
    setGameTip(close, "Collapse the dev tools");
    close.onclick = () => this.setExpanded(false);
    tabs.append(close);
    this.drawer.append(tabs);

    this.pages.set("spawn", this.buildSpawn());
    this.pages.set("cheats", this.buildCheats());
    this.pages.set("overlays", this.buildOverlays());
    for (const page of this.pages.values()) this.drawer.append(page);
    this.setTab("spawn");

    window.addEventListener("keydown", this.onKey, true);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey, true);
    window.clearInterval(this.concedeTimer);
    this.iconObserver.disconnect();
    this.disarm();
  }

  /** Show or hide the whole thing (the HUD's frame check: asked for AND single player). */
  setShown(shown: boolean): void {
    if (this.root.hidden === !shown) return;
    this.root.hidden = !shown;
    if (shown) {
      this.setExpanded(true);
    } else {
      this.disarm();
    }
  }

  /** Light a toggle's button when it was flipped from somewhere else (a typed cheat). */
  markCheat(kind: CheatKind, on: boolean): void {
    this.cheatButtons.get(kind)?.classList.toggle("active", on);
  }

  private setExpanded(on: boolean): void {
    this.expanded = on;
    this.drawer.hidden = !on;
    this.handle.hidden = on;
    if (!on) this.disarm();
    else if (this.tab === "spawn") this.refreshSpawn();
  }

  private setTab(t: Tab): void {
    this.tab = t;
    for (const [k, page] of this.pages) page.hidden = k !== t;
    for (const [k, b] of this.tabButtons) b.classList.toggle("on", k === t);
    // Only the Spawn tab has a list to fill the height with; the button pages hug their content.
    this.drawer.classList.toggle("dev-compact", t !== "spawn");
    if (t !== "spawn") this.disarm();
    else if (this.expanded) this.refreshSpawn();
  }

  // Escape takes an armed click-to-place down before anything else hears it (the menu, an
  // armed order); the search box answers its own Escape by clearing itself.
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || this.root.hidden) return;
    if (this.placing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.disarm();
    } else if (document.activeElement === this.search) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.query) {
        this.search.value = this.query = "";
        this.renderList();
      } else this.search.blur();
    }
  };

  // ------------------------------------------------------------------ Spawn

  private buildSpawn(): HTMLElement {
    const page = el("div", "dev-page dev-spawn");
    this.search.type = "text";
    this.search.placeholder = "Search name or rawcode…";
    this.search.spellcheck = false;
    this.search.autocomplete = "off";
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.renderList();
    });
    this.search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      // Enter takes the first hit when nothing in the list has been picked from it.
      const first = this.visible()[0];
      if (first && !this.visible().some((v) => v.id === this.picked.get(v.kind))) this.pick(first);
      this.spawnAt(null);
    });

    const foot = el("div", "dev-foot");
    this.ownerRow.append(el("span", "dev-label", "Owner"));
    this.levelRow.append(el("span", "dev-label", "Level"));
    this.countRow.append(el("span", "dev-label", "Count"));
    const actions = el("div", "dev-row");
    const now = this.nowBtn;
    setGameTip(now, "Spawn at the centre of the screen");
    now.onclick = () => this.spawnAt(null);
    setGameTip(this.placeBtn, "Every left-click on the map spawns there; right-click or Esc stops");
    this.placeBtn.onclick = () => (this.placing ? this.disarm() : this.arm());
    actions.append(now, this.placeBtn);
    foot.append(this.ownerRow, this.levelRow, this.countRow, actions);

    page.append(this.kindRow, this.search, this.groupRow, this.list, foot);
    return page;
  }

  /** Re-read what can change under the drawer while it is closed: the seats and the counts. */
  private refreshSpawn(): void {
    // Race by race (RACE_ORDER, then anything else by name), A–Z inside each — which is also
    // the order the group chips are in, so "All" reads as the chips laid end to end.
    const rank = (g: string) => { const i = RACE_ORDER.indexOf(g); return i < 0 ? RACE_ORDER.length : i; };
    this.catalog ??= this.driver.spawnCatalog().sort((a, b) =>
      rank(a.group) - rank(b.group) || a.group.localeCompare(b.group) || this.label(a).localeCompare(this.label(b)) || a.id.localeCompare(b.id));
    this.owners = this.driver.spawnOwners();
    if (!this.owners.some((o) => o.player === this.owner)) this.owner = this.owners.find((o) => o.you)?.player ?? this.owners[0]?.player ?? 0;
    this.counts = this.driver.spawnCounts();
    this.renderKinds();
    this.renderList();
    this.renderFoot();
  }

  private label(e: SpawnEntry): string {
    return wc3StripMarkup(e.name);
  }

  /** The kind's entries under the melee filter, before the group chip and the search. */
  private pool(kind: Kind): SpawnEntry[] {
    return (this.catalog ?? []).filter((e) => e.kind === kind && (!this.meleeOnly || !e.campaign));
  }

  /** What the list shows. A search looks through EVERY kind and ignores the filters — it is
   *  how a campaign unit is found by name. */
  private visible(): SpawnEntry[] {
    if (this.query) {
      const q = this.query;
      return (this.catalog ?? []).filter((e) =>
        this.label(e).toLowerCase().includes(q) || e.id.toLowerCase().includes(q) || !!e.properName?.toLowerCase().includes(q));
    }
    const pool = this.pool(this.kind);
    return this.group === "all" ? pool : pool.filter((e) => e.group === this.group);
  }

  private renderKinds(): void {
    this.kindRow.replaceChildren();
    for (const [k, label] of KINDS) {
      const b = el("button", "dev-seg-btn" + (k === this.kind && !this.query ? " on" : ""));
      b.append(el("span", undefined, label), el("span", "dev-n", String(this.pool(k).length)));
      b.onclick = () => {
        this.kind = k;
        this.group = "all";
        this.search.value = this.query = "";
        this.renderKinds();
        this.renderList();
        this.renderFoot();
      };
      this.kindRow.append(b);
    }
  }

  private renderGroups(): void {
    this.groupRow.replaceChildren();
    this.groupRow.hidden = !!this.query;
    const pool = this.pool(this.kind);
    const groups = [...new Set(pool.map((e) => e.group))].sort((a, b) => {
      const ia = RACE_ORDER.indexOf(a), ib = RACE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    if (this.group !== "all" && !groups.includes(this.group)) this.group = "all";
    const chip = (key: string, label: string, n: number) => {
      const b = el("button", "dev-chip" + (key === this.group ? " on" : ""), `${label} ${n}`);
      b.onclick = () => {
        this.group = key;
        this.renderList();
      };
      this.groupRow.append(b);
    };
    chip("all", "All", pool.length);
    for (const g of groups) chip(g, RACE_LABEL[g] ?? g, pool.filter((e) => e.group === g).length);
    const melee = el("button", "dev-chip dev-chip-end" + (this.meleeOnly ? " on" : ""), "Melee only");
    setGameTip(melee, "Hide the campaign-only types (a search always finds them)");
    melee.onclick = () => {
      this.meleeOnly = !this.meleeOnly;
      this.renderKinds();
      this.renderList();
    };
    this.groupRow.append(melee);
  }

  private renderList(): void {
    this.renderKinds();
    this.renderGroups();
    this.list.replaceChildren();
    const rows = this.visible();
    if (!rows.length) this.list.append(el("div", "dev-empty", "Nothing matches."));
    for (const e of rows) {
      const sel = this.picked.get(e.kind) === e.id && (this.query ? true : e.kind === this.kind);
      const row = el("button", "dev-item" + (sel ? " on" : ""));
      const ic = el("span", "dev-icon");
      const img = el("img");
      img.dataset.icon = e.icon;
      img.alt = "";
      ic.append(img);
      this.iconObserver.observe(img);
      const n = e.kind === "item" ? 0 : this.counts.get(e.id) ?? 0;
      if (n) {
        const badge = el("span", "dev-badge", `×${n}`);
        setGameTip(badge, `${n} on the map now`);
        ic.append(badge);
      }
      const text = el("span", "dev-item-text");
      const name = el("span", "dev-item-name", this.label(e) + (e.properName ? ` — ${e.properName}` : ""));
      const kindWord = this.query ? `${SINGULAR[e.kind]} · ` : "";
      const sub = el("span", "dev-item-sub", `${kindWord}${e.id}${e.campaign ? " · campaign" : ""}`);
      text.append(name, sub);
      row.append(ic, text);
      row.onclick = () => this.pick(e);
      row.ondblclick = () => this.spawnAt(null);
      this.list.append(row);
    }
  }

  private pick(e: SpawnEntry): void {
    this.picked.set(e.kind, e.id);
    if (this.query) this.kind = e.kind;
    for (const row of this.list.children) row.classList.remove("on");
    const i = this.visible().indexOf(e);
    this.list.children[i]?.classList.add("on");
    this.renderFoot();
  }

  /** The entry the footer is about: the pick for the current kind. */
  private current(): SpawnEntry | undefined {
    const id = this.picked.get(this.kind);
    return id ? this.catalog?.find((e) => e.kind === this.kind && e.id === id) : undefined;
  }

  private renderFoot(): void {
    const cur = this.current();
    const kind = cur?.kind ?? this.kind;
    // OWNER — every seat as its player colour, the two neutral players after them. Items have
    // no owner on the ground, so the row goes away for them.
    this.ownerRow.hidden = kind === "item";
    this.ownerRow.replaceChildren(this.ownerRow.firstChild!);
    for (const o of this.owners) {
      const b = el("button", "dev-swatch" + (o.player === this.owner ? " on" : ""));
      b.style.background = o.color;
      setGameTip(b, this.ownerText(o));
      b.onclick = () => {
        this.owner = o.player;
        this.renderFoot();
      };
      this.ownerRow.append(b);
    }
    const me = this.owners.find((o) => o.player === this.owner);
    this.ownerLabel.textContent = me ? this.ownerText(me) : "";
    this.ownerRow.append(this.ownerLabel);
    // LEVEL — heroes only.
    this.levelRow.hidden = kind !== "hero";
    this.levelRow.replaceChildren(this.levelRow.firstChild!, this.steps(LEVELS, this.level, (v) => (this.level = v)));
    const learn = el("button", "dev-chip" + (this.learnAll ? " on" : ""), "Learn all");
    setGameTip(learn, "Every skill at its top rank, and a full mana bar");
    learn.onclick = () => {
      this.learnAll = !this.learnAll;
      this.renderFoot();
    };
    this.levelRow.append(learn);
    this.countRow.replaceChildren(this.countRow.firstChild!, this.steps(COUNTS, this.count, (v) => (this.count = v)));
    // Nothing picked yet: there is nothing to spawn, and the two buttons say so by being dead.
    this.nowBtn.disabled = this.placeBtn.disabled = !cur;
    this.placeBtn.classList.toggle("on", this.placing);
    this.placeBtn.textContent = this.placing ? "Placing — right-click stops" : "Click map to place";
  }

  private ownerText(o: SpawnOwner): string {
    const parts = [o.name];
    if (o.you) parts.push("You");
    if (o.team !== null) parts.push(`Team ${o.team + 1}`);
    return parts.join(" · ");
  }

  private steps(values: readonly number[], value: number, set: (v: number) => void): HTMLElement {
    const box = el("div", "dev-steps");
    for (const v of values) {
      const b = el("button", v === value ? "on" : undefined, String(v));
      b.onclick = () => {
        set(v);
        this.renderFoot();
      };
      box.append(b);
    }
    return box;
  }

  private spawnAt(at: [number, number] | null): void {
    const cur = this.current();
    if (!cur) return;
    this.driver.spawnTest({ typeId: cur.id, kind: cur.kind, owner: this.owner, count: this.count, level: this.level, learnAll: this.learnAll, at });
    // The new bodies are counted a frame later (a model load is awaited); re-count then.
    setTimeout(() => {
      if (this.root.hidden || this.tab !== "spawn") return;
      this.counts = this.driver.spawnCounts();
      this.renderList();
    }, 400);
  }

  private arm(): void {
    if (!this.current()) return;
    this.placing = true;
    this.driver.armDevPlace((x, y) => this.spawnAt([x, y]), () => {
      this.placing = false;
      this.renderFoot();
    });
    this.renderFoot();
  }

  private disarm(): void {
    if (!this.placing) return;
    this.placing = false;
    this.driver.armDevPlace(null);
    this.renderFoot();
  }

  // ------------------------------------------------------------------ Cheats

  private buildCheats(): HTMLElement {
    const page = el("div", "dev-page");
    const mk = (label: string, kind: CheatKind) => {
      const b = el("button", "dev-btn", label);
      b.onclick = () => {
        const on = this.driver.cheat(kind);
        if (kind === "fastbuild" || kind === "godmode") b.classList.toggle("active", on);
      };
      this.cheatButtons.set(kind, b);
      return b;
    };
    const sel = (label: string, kind: "hp" | "mp" | "cooldown") => {
      const b = el("button", "dev-btn", label);
      b.onclick = () => this.driver.cheatSelected(kind);
      return b;
    };
    page.append(
      this.section("Economy", [mk("+5000 Gold", "gold"), mk("+5000 Lumber", "lumber"), mk("+Food", "food")]),
      // `whosyourdaddy`, `riseandshine` and `lightsout` — the original game's cheats.
      this.section("Cheats", [mk("Fast Build", "fastbuild"), mk("God Mode", "godmode"), mk("Set Day", "day"), mk("Set Night", "night")]),
      this.section("Selection", [sel("Full HP", "hp"), sel("Full MP", "mp"), sel("Reset Cooldown", "cooldown")]),
    );
    setGameTip(this.cheatButtons.get("fastbuild")!, "Builds and training finish in about a second");
    return page;
  }

  // ------------------------------------------------------------------ Overlays

  private buildOverlays(): HTMLElement {
    const page = el("div", "dev-page");
    const legend = (rows: Array<[string, string]>) => {
      const box = el("div", "dev-legend");
      box.hidden = true;
      for (const [color, label] of rows) {
        const row = el("div", "dev-legend-row");
        const sw = el("span", "dev-legend-swatch");
        sw.style.background = color;
        row.append(sw, el("span", undefined, label));
        box.append(row);
      }
      return box;
    };
    const toggle = (label: string, flip: () => boolean, box?: HTMLElement) => {
      const b = el("button", "dev-btn", label);
      b.onclick = () => {
        const on = flip();
        b.classList.toggle("active", on);
        if (box) box.hidden = !on;
      };
      return b;
    };
    const colliders = legend([
      ["rgb(64,255,115)", "Click / selection"],
      ["rgb(255,72,51)", "Pathing obstruction"],
      ["rgb(77,166,255)", "Fog-of-war (line-of-sight) blocker"],
    ]);
    const pathing = legend([
      ["rgb(140,158,184)", "Pathing grid"],
      ["rgb(255,64,51)", "Blocked cell"],
      ["rgb(255,217,51)", "Unit path"],
    ]);
    const regions = toggle("Show Regions", () => this.driver.toggleRegions());
    // "Show Regions": the map's named trigger regions (gg_rct_*) with their name inside each.
    setGameTip(regions, "Outline the map's named trigger regions (gg_rct_*)");
    // "Show Concede": every Computer+ seat's concession reading, live. OFF by default.
    const concede = toggle("Show Concede", () => this.toggleConcede());
    setGameTip(concede, "Show each Computer+ player's concede reading (despair against the line, and the dwell)");
    page.append(
      this.section("Overlays", [
        toggle("Show Colliders", () => this.driver.toggleColliders(), colliders),
        toggle("Show Pathing", () => this.driver.togglePathing(), pathing),
        regions,
        concede,
      ]),
      colliders,
      pathing,
    );
    return page;
  }

  /** Flip the concede readout. Polled rather than pushed: it is a debug view of a reading the
   *  AI takes once a second, so four times a second is plenty and costs nothing while off. */
  private toggleConcede(): boolean {
    const on = this.concedeBox.hidden;
    this.concedeBox.hidden = !on;
    window.clearInterval(this.concedeTimer);
    this.concedeTimer = 0;
    if (on) {
      this.renderConcede();
      this.concedeTimer = window.setInterval(() => this.renderConcede(), 250);
    }
    return on;
  }

  private renderConcede(): void {
    if (this.root.hidden) return;
    const readings = this.driver.concedeReadings();
    const owners = new Map(this.driver.spawnOwners().map((o) => [o.player, o]));
    const box = this.concedeBox;
    box.replaceChildren(el("div", "dev-concede-title", "Concede — Computer+"));
    if (!readings.length) {
      box.append(el("div", "dev-concede-none", "No Computer+ players"));
      return;
    }
    const secs = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    for (const r of readings) {
      const owner = owners.get(r.player);
      const row = el("div", "dev-concede-row");
      const head = el("div", "dev-concede-head");
      const sw = el("span", "dev-legend-swatch");
      sw.style.background = owner?.color ?? "#808080";
      const value = el("span", "dev-concede-value", `${r.despair.toFixed(2)} / ${r.concedeAt.toFixed(2)}`);
      head.append(sw, el("span", "dev-concede-name", owner?.name ?? `Player ${r.player + 1}`), value);
      const bar = el("div", "dev-concede-bar");
      const fill = el("div", "dev-concede-fill");
      fill.style.width = `${Math.min(1, r.despair / r.concedeAt) * 100}%`;
      bar.append(fill);
      const terms = r.terms.length
        ? r.terms.map(([k, w]) => `${k} ${w.toFixed(2)}`).join(" · ")
        : "no terms live";
      // What `mannersPass` would do with this reading, in its own order of tests.
      let state: string;
      let tone = "";
      if (r.gone) state = "left the game";
      else if (r.conceded) { state = "conceded — leaving"; tone = "hot"; }
      else if (r.teamLost) { state = "half the team gone — concedes now"; tone = "hot"; }
      else if (r.clock < r.notBefore) state = `nothing decided before ${secs(r.notBefore)} (now ${secs(r.clock)})`;
      else if (r.hopeless) {
        const why = r.clause ? `clause ${r.clause}` : "despair";
        state = r.dwell >= 0
          ? `hopeless (${why}) ${r.dwell.toFixed(1)} / ${r.concedeAfter} s`
          : `hopeless (${why}) — dwell starts next pass`;
        tone = "warm";
      } else state = "playing on";
      const status = el("div", "dev-concede-state", state);
      if (tone) { row.classList.add(`dev-concede-${tone}`); }
      row.append(head, bar, el("div", "dev-concede-terms", terms), status);
      box.append(row);
    }
  }

  private section(title: string, buttons: HTMLElement[]): HTMLElement {
    const box = el("div", "dev-section");
    const grid = el("div", "dev-grid");
    grid.append(...buttons);
    box.append(el("div", "dev-label", title), grid);
    return box;
  }
}
