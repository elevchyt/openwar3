// The map list's search box, on the Custom Game and LAN create screens.
//
// It replaced the type-ahead (issue #137: type a map's name at the list and it goes there),
// because the type-ahead had to own every letter on those two screens, and so their buttons
// lost their one-letter accelerators (Skirmish.fdf's `KEY_START_GAME_SHORTCUT` "S" and the
// rest). The ranking is unchanged — ui/mapSearch.ts — and the search still reaches every
// folder rather than only the open one. What moved is WHERE typing is a search: only inside this
// box, which is always on show across the top of the list and takes the keyboard on Ctrl+F or a
// click. Until it has the keyboard, every letter is the screen's again.
//
// Typing NARROWS the list to the maps that match, from every folder, best first, and picks the
// first; the arrows walk the matches and Enter picks one and hands the keyboard back. Escape
// empties the box (and, empty, hands the keyboard back), and the × empties it too. Nothing in
// 1.30.4 has a map search, so none of this is the game's — it was the first of three shapes
// built for the developer to choose from (a docked filter, a floating palette, a find bar).
//
// The DOM lives inside the screen's own element, so it hides and leaves with the screen. That
// element is EMPTIED on every relayout (ui/fdf/render.ts), which picking a map causes, so the
// browser hands it back through `place` from its `fill` and the box keeps its text and focus.

/** What the box needs from the map browser it searches. */
export interface FindHost {
  /** Every playable map `query` fits, best first, by path. */
  results(query: string): string[];
  /** Go to a map: walk into its folder and pick it, as a click on its row does. */
  pick(path: string): void;
  /** Show only these maps in the list, in this order — or the open folder again (null). */
  setFilter(paths: string[] | null): void;
  /** Start reading the folders nobody has opened, so their maps answer by their own names. */
  warm(): void;
}

/** What the empty box says. Ours: the 2003 UI has no search to borrow it from. */
const PLACEHOLDER = "Search maps (Ctrl+F)";

export class MapFind {
  private readonly root: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly clear: HTMLButtonElement;
  private results: string[] = [];
  private at = 0; // the match the arrows stand on
  /** The box should have the keyboard — kept across a relayout, which takes the focus away. */
  private wantFocus = false;
  private screen: HTMLElement | null = null;
  private list: HTMLElement | null = null;

  constructor(private readonly host: FindHost) {
    const root = document.createElement("div");
    root.className = "ow3-find";
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
    input.setAttribute("aria-label", PLACEHOLDER);
    input.addEventListener("input", () => this.search());
    input.addEventListener("keydown", (e) => this.onKey(e));
    input.addEventListener("focus", () => { this.wantFocus = true; this.host.warm(); });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "ow3-find-close";
    clear.textContent = "×";
    clear.title = "Clear (Esc)";
    clear.addEventListener("click", () => { this.empty(); input.focus(); });
    box.append(glass, input, clear);
    root.append(box);

    this.root = root;
    this.input = input;
    this.clear = clear;
    document.addEventListener("pointerdown", this.onPointerDown, true);
    this.paint();
  }

  /** Ctrl+F: give the box the keyboard, its text selected so typing replaces it. */
  focus(): void {
    this.wantFocus = true;
    this.input.focus();
    this.input.select();
  }

  /** The screen was (re)built: put the box back across the top of `list` (MapListBox). */
  place(screen: HTMLElement, list: HTMLElement | null): void {
    this.screen = screen;
    this.list = list;
    this.mount();
  }

  dispose(): void {
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    this.root.remove();
    this.screen = this.list = null;
  }

  /**
   * A press anywhere but the box gives the keyboard back to the screen — the one thing that
   * should, because a relayout takes the focus too and the box must win it back from that.
   * Not the input's `blur`: Chromium fires that on an input that is being REMOVED while it is
   * still connected, which is exactly what a relayout does to it, so the two look the same.
   */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.root.contains(e.target as Node)) this.wantFocus = false;
  };

  /** Lay the box over the list as it is now laid out. */
  private mount(): void {
    const { root, screen, list } = this;
    if (!screen || !list) { root.remove(); return; }
    if (root.parentElement !== screen) screen.appendChild(root);
    // Every length off the list's own type and border, so the box is the list's size at any
    // window — inside its border, with the rows (and the scrollbar beside them) moved down to
    // make room rather than sitting under it with the first row hidden.
    const rows = list.querySelector<HTMLElement>(".fdf-list-rows");
    if (rows) root.style.fontSize = getComputedStyle(rows).fontSize;
    const inset = rows ? rows.offsetLeft : 0;
    const s = screen.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    root.style.left = `${l.left - s.left + inset}px`;
    root.style.top = `${l.top - s.top + inset}px`;
    root.style.width = `${l.width - 2 * inset}px`;
    list.style.setProperty("--ow3-find-h", `${root.offsetHeight + inset}px`);
    list.classList.add("ow3-find-docked");
    if (this.wantFocus && document.activeElement !== this.input) {
      const at = this.input.selectionStart;
      this.input.focus();
      if (at !== null) this.input.setSelectionRange(at, at);
    }
  }

  private search(): void {
    const q = this.input.value.trim();
    this.results = q ? this.host.results(q) : [];
    this.at = 0;
    this.host.setFilter(q ? this.results : null);
    if (this.results[0]) this.host.pick(this.results[0]); // go to the best, as typed
    this.paint();
  }

  /** Empty the box: the list shows its folder again, with whatever was picked still picked. */
  private empty(): void {
    if (!this.input.value) return;
    this.input.value = "";
    this.search();
  }

  /** Hand the keyboard back to the screen, whose accelerators are live again. */
  private release(): void {
    this.wantFocus = false;
    this.input.blur();
  }

  private paint(): void {
    const q = this.input.value.trim();
    this.root.classList.toggle("ow3-find-miss", !!q && !this.results.length);
    this.clear.hidden = !this.input.value;
  }

  private onKey(e: KeyboardEvent): void {
    // The box's own keys never reach the screen: its accelerators, the list's arrows, the lot.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.input.value) this.empty();
      else this.release();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); this.input.select(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = this.results.length;
      if (!n) return;
      this.at = (this.at + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      this.host.pick(this.results[this.at]);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const path = this.results[this.at];
      if (path) this.host.pick(path);
      this.release(); // the list stays narrowed; the box keeps its text until it is emptied
    }
  }
}
