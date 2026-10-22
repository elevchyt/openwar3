import { wc3StripMarkup } from "./wc3Text";

// Ctrl+F on a map list: a search box of our own over the Custom Game and LAN create screens.
//
// It replaced the type-ahead (issue #137: type a map's name at the list and it goes there),
// because the type-ahead had to own every letter on those two screens, and so their buttons
// lost their one-letter accelerators (Skirmish.fdf's `KEY_START_GAME_SHORTCUT` "S" and the
// rest). The ranking is unchanged — ui/mapSearch.ts — and the search still reaches every
// folder rather than only the open one. What moved is WHEN typing is a search: only inside this
// box, which the player opens with Ctrl+F and closes with Escape or its ×.
//
// Nothing in 1.30.4 has a map search, so none of this is the game's. Three shapes of it are
// built so the developer can pick one (`findVariant`):
//
//   A  a filter docked across the TOP of the list: typing narrows the list to the maps that
//      match, from every folder, best first, and picks the first;
//   B  a palette floating over the screen: the best eight matches under the box, picked with
//      the arrows and Enter or a click;
//   C  a find bar docked across the BOTTOM of the list, the way a browser's is: typing goes to
//      the best match and the list is left as it is, with "2 of 7" and next/previous.
//
// The DOM lives inside the screen's own element, so it hides and leaves with the screen. That
// element is EMPTIED on every relayout (ui/fdf/render.ts), which picking a map causes, so the
// browser hands it back through `place` from its `fill` and the box keeps its text and focus.

/** Which of the three shapes the finder takes. */
export type FindVariant = "a" | "b" | "c";

/** `?mapsearch=b`, or `localStorage["openwar3.mapSearch"] = "c"`, else A. */
export function findVariant(): FindVariant {
  const pick = (v: string | null | undefined): FindVariant | null =>
    v === "a" || v === "b" || v === "c" ? v : null;
  let stored: string | null = null;
  try { stored = localStorage.getItem("openwar3.mapSearch"); } catch { /* private window */ }
  return pick(new URLSearchParams(location.search).get("mapsearch")?.toLowerCase()) ?? pick(stored) ?? "a";
}

/** One map the search found, as the finder shows it. */
export interface FindResult {
  path: string;
  label: string; // the map's own name, WC3 markup and all
  folder: string; // "" for the top level
  icon: HTMLCanvasElement | null; // its list badge
}

/** What the finder needs from the map browser it searches. */
export interface FindHost {
  /** Every playable map `query` fits, best first. */
  results(query: string): FindResult[];
  /** Go to a map: walk into its folder and pick it, as a click on its row does. */
  pick(path: string): void;
  /** A: show only these maps in the list, in this order — or the open folder again (null). */
  setFilter(paths: string[] | null): void;
  /** Start reading the folders nobody has opened, so their maps answer by their own names. */
  warm(): void;
}

/** Strings the finder prints. Ours: the 2003 UI has no search to borrow them from. */
const PLACEHOLDER = "Search maps…";
const TITLE = "Find Map";
const NONE = "No maps found";
const B_ROWS = 8;

export class MapFind {
  readonly variant: FindVariant;
  private root: HTMLDivElement | null = null;
  private input: HTMLInputElement | null = null;
  private count: HTMLSpanElement | null = null; // C: "2 of 7"
  private rows: HTMLDivElement | null = null; // B: the result rows
  private results: FindResult[] = [];
  private at = 0; // the result the arrows stand on
  /** The box should have the keyboard — kept across a relayout, which takes the focus away. */
  private wantFocus = false;
  private screen: HTMLElement | null = null;
  private list: HTMLElement | null = null;

  constructor(private readonly host: FindHost, variant: FindVariant = findVariant()) {
    this.variant = variant;
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  /** Ctrl+F: open the box (or, already open, put the keyboard back in it). */
  open(): void {
    if (!this.root) {
      this.build();
      document.addEventListener("pointerdown", this.onPointerDown, true);
    }
    this.wantFocus = true;
    this.mount();
    this.input?.focus();
    this.input?.select();
    this.host.warm();
  }

  /** Escape or ×: take the box away and give the list its folder back. */
  close(): void {
    if (!this.root) return;
    this.list?.classList.remove("ow3-find-docked-top", "ow3-find-docked-bottom");
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    this.root.remove();
    this.root = this.input = this.count = this.rows = null;
    this.results = [];
    this.wantFocus = false;
    if (this.variant === "a") this.host.setFilter(null);
  }

  /** The screen was (re)built: put the box back over it. `list` is the MapListBox frame. */
  place(screen: HTMLElement, list: HTMLElement | null): void {
    this.screen = screen;
    this.list = list;
    if (this.root) this.mount();
  }

  dispose(): void {
    this.close();
    this.screen = this.list = null;
  }

  /**
   * A press anywhere but the box gives the keyboard back to the screen — the one thing that
   * should, because a relayout takes the focus too and the box must win it back from that.
   * Not the input's `blur`: Chromium fires that on an input that is being REMOVED while it is
   * still connected, which is exactly what a relayout does to it, so the two look the same.
   */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.root?.contains(e.target as Node)) this.wantFocus = false;
  };

  // --- building -----------------------------------------------------------------------

  private build(): void {
    const root = document.createElement("div");
    root.className = `ow3-find ow3-find-${this.variant}`;
    // Clicks inside stay inside: the screen under it must not take them as clicks on itself.
    root.addEventListener("pointerdown", (e) => e.stopPropagation());

    const box = document.createElement("div");
    box.className = "ow3-find-box";
    const glass = document.createElement("span");
    glass.className = "ow3-find-glass";
    glass.setAttribute("aria-hidden", "true");
    const input = document.createElement("input");
    input.className = "ow3-find-input";
    input.type = "text";
    input.placeholder = PLACEHOLDER;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", TITLE);
    input.addEventListener("input", () => this.search());
    input.addEventListener("keydown", (e) => this.onKey(e));
    input.addEventListener("focus", () => { this.wantFocus = true; });
    box.append(glass, input);

    if (this.variant === "c") {
      const count = document.createElement("span");
      count.className = "ow3-find-count";
      box.append(count);
      this.count = count;
      box.append(this.stepButton("▲", "Previous match", -1), this.stepButton("▼", "Next match", 1));
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "ow3-find-close";
    x.textContent = "×";
    x.title = "Close (Esc)";
    x.addEventListener("click", () => this.close());
    box.append(x);

    if (this.variant === "b") {
      // The palette: a scrim over the whole screen that closes it when clicked, the panel on it.
      root.addEventListener("pointerdown", (e) => { if (e.target === root) this.close(); });
      const panel = document.createElement("div");
      panel.className = "ow3-find-panel";
      const title = document.createElement("div");
      title.className = "ow3-find-title";
      title.textContent = TITLE;
      const rows = document.createElement("div");
      rows.className = "ow3-find-rows";
      panel.append(title, box, rows);
      root.append(panel);
      this.rows = rows;
    } else {
      root.append(box);
    }
    this.root = root;
    this.input = input;
    this.search();
  }

  private stepButton(glyph: string, title: string, step: number): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ow3-find-step";
    b.textContent = glyph;
    b.title = title;
    b.addEventListener("click", () => { this.step(step); this.input?.focus(); });
    return b;
  }

  /** Put the box where its variant goes, over the screen as it is now laid out. */
  private mount(): void {
    const root = this.root;
    const screen = this.screen;
    if (!root || !screen) return;
    if (root.parentElement !== screen) screen.appendChild(root);
    // Every length off the list's own type, so the box is the list's size at any window.
    const rowsEl = this.list?.querySelector<HTMLElement>(".fdf-list-rows");
    const font = rowsEl ? getComputedStyle(rowsEl).fontSize : "";
    root.style.fontSize = font;
    if (this.variant !== "b" && this.list) {
      const s = screen.getBoundingClientRect();
      const l = this.list.getBoundingClientRect();
      const inset = rowsEl ? rowsEl.offsetLeft : 0; // the list's own border
      root.style.left = `${l.left - s.left + inset}px`;
      root.style.width = `${l.width - 2 * inset}px`;
      if (this.variant === "a") root.style.top = `${l.top - s.top + inset}px`;
      else root.style.top = `${l.bottom - s.top - inset - root.offsetHeight}px`;
      // The rows (and the scrollbar beside them) make room for the box, rather than sitting
      // under it with their first or last row hidden.
      this.list.style.setProperty("--ow3-find-h", `${root.offsetHeight + inset}px`);
      this.list.classList.add(this.variant === "a" ? "ow3-find-docked-top" : "ow3-find-docked-bottom");
    }
    if (this.wantFocus && document.activeElement !== this.input) {
      const input = this.input;
      const at = input?.selectionStart ?? null;
      input?.focus();
      if (input && at !== null) input.setSelectionRange(at, at);
    }
  }

  // --- searching ----------------------------------------------------------------------

  private search(): void {
    const q = this.input?.value ?? "";
    this.results = q.trim() ? this.host.results(q) : [];
    this.at = 0;
    if (this.variant === "a") this.host.setFilter(q.trim() ? this.results.map((r) => r.path) : null);
    // A and C go to the best match as it is typed, as the type-ahead did; B waits for a pick.
    if (this.variant !== "b" && this.results[0]) this.host.pick(this.results[0].path);
    this.paint();
  }

  private step(by: number): void {
    const n = this.results.length;
    if (!n) return;
    this.at = (this.at + by + n) % n;
    if (this.variant !== "b") this.host.pick(this.results[this.at].path);
    this.paint();
  }

  private paint(): void {
    const q = this.input?.value.trim() ?? "";
    this.root?.classList.toggle("ow3-find-miss", !!q && !this.results.length);
    if (this.count) {
      this.count.textContent = !q ? "" : this.results.length ? `${this.at + 1} of ${this.results.length}` : NONE;
    }
    if (this.rows) {
      this.rows.textContent = "";
      if (q && !this.results.length) {
        const none = document.createElement("div");
        none.className = "ow3-find-none";
        none.textContent = NONE;
        this.rows.append(none);
      }
      this.results.slice(0, B_ROWS).forEach((r, i) => {
        const row = document.createElement("div");
        row.className = "ow3-find-row";
        if (i === this.at) row.classList.add("selected");
        if (r.icon) {
          const icon = document.createElement("img");
          icon.className = "ow3-find-icon";
          icon.src = r.icon.toDataURL();
          row.append(icon);
        }
        const name = document.createElement("span");
        name.className = "ow3-find-name";
        name.textContent = wc3StripMarkup(r.label); // the palette prints names in its own colours
        const where = document.createElement("span");
        where.className = "ow3-find-folder";
        where.textContent = r.folder || "Maps";
        row.append(name, where);
        row.addEventListener("pointerenter", () => { this.at = i; this.highlight(); });
        row.addEventListener("click", () => this.choose(i));
        this.rows?.append(row);
      });
    }
  }

  /** B: move the highlight without rebuilding the rows under the pointer. */
  private highlight(): void {
    this.rows?.querySelectorAll(".ow3-find-row").forEach((el, i) => el.classList.toggle("selected", i === this.at));
  }

  /** Pick a result and close — B's Enter and click, and A's Enter. */
  private choose(i: number): void {
    const r = this.results[i];
    if (r) this.host.pick(r.path);
    this.close();
  }

  private onKey(e: KeyboardEvent): void {
    // The box's own keys never reach the screen: its accelerators, the list's arrows, the lot.
    e.stopPropagation();
    const max = this.variant === "b" ? Math.min(B_ROWS, this.results.length) : this.results.length;
    if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); this.input?.select(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!max) return;
      if (this.variant === "b") { this.at = (this.at + (e.key === "ArrowDown" ? 1 : -1) + max) % max; this.highlight(); }
      else this.step(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (this.variant === "c") this.step(e.shiftKey ? -1 : 1);
      else this.choose(this.at);
    }
  }
}

