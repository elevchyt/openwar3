import type { FdfFrame } from "./parser";
import { firstProp, hasFlag, strProp } from "./library";
import { wc3ToHtml } from "../wc3Text";

// The interactive FDF widgets beyond the button family (issue #61): EDITBOX (text
// input), POPUPMENU (the race / team / colour / handicap dropdowns) and the LISTBOX-
// style CONTROL frames (the skirmish map list, the profile list). Plus the two the
// IN-GAME dialogs live on and the glue screens never used: GLUECHECKBOX (the Allies
// dialog's ally/vision/units grid, the Chat dialog's send-to radio buttons) and
// TEXTAREA (the message log, the chat history, a quest's description).
//
// WC3's own FDF only declares each widget's CHROME — its backdrops, its title frame,
// its arrow, its scrollbar. The engine supplies the behaviour and the contents at
// runtime (that is why TeamSetup.fdf is an empty frame and PlayerSlot's RaceMenu holds
// nothing but `MenuItem "HUMAN"` lines). So we do the same: the renderer draws the
// frame's own chrome, and these controllers add the behaviour on top and hand the
// screen a small typed handle to drive it with.

export interface Option {
  value: string;
  label: string;
}

export interface ListItem {
  value: string;
  label: string;
  /** Optional leading icon (a decoded BLP canvas), e.g. the folder / player-count badge. */
  icon?: HTMLCanvasElement | null;
}

interface Control {
  setEnabled(on: boolean): void;
}

export interface EditBoxControl extends Control {
  get value(): string;
  set value(v: string);
  focus(): void;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export interface PopupControl extends Control {
  setOptions(options: Option[]): void;
  get value(): string;
  set value(v: string);
  onChange?: (value: string) => void;
}

export interface ListControl extends Control {
  setItems(items: ListItem[]): void;
  get value(): string | null;
  select(value: string): void;
  /** How far the list is scrolled. A screen that rebuilds itself (the Custom Game screen
   *  does, on every map picked) reads this before and writes it after, so the list stays
   *  exactly where the player left it. */
  get scrollTop(): number;
  set scrollTop(v: number);
  onChange?: (value: string) => void;
  /** Double-click / Enter on a row — the map list's "just start it" shortcut. */
  onActivate?: (value: string) => void;
}

export interface CheckBoxControl extends Control {
  get checked(): boolean;
  set checked(v: boolean);
  onChange?: (checked: boolean) => void;
}

export interface SliderControl extends Control {
  /** The value on the slider's own scale (SliderMinValue…SliderMaxValue). */
  get value(): number;
  set value(v: number);
  onChange?: (value: number) => void;
}

export interface TextAreaControl extends Control {
  /** Replace the whole contents. Each line is WC3 markup, not plain text. */
  setLines(lines: string[]): void;
  /** Append one line, trimming to the frame's own `TextAreaMaxLines`. */
  addLine(line: string): void;
  clear(): void;
  /** Stick to the newest line — what a log does as it fills. */
  scrollToBottom(): void;
}

/** Font size (world units) declared on a frame, defaulting to the FDF's own 0.011. */
function fontSize(f: FdfFrame, scale: number, fallback = 0.011): string {
  const size = firstProp(f, "FrameFont")?.args[1]?.n ?? fallback;
  return `${Math.max(8, size * scale)}px`;
}

// --- EDITBOX ----------------------------------------------------------------------

/** An <input> laid into the edit box's chrome. `EditBorderSize` is its text inset. */
export function buildEditBox(el: HTMLElement, f: FdfFrame, scale: number): EditBoxControl {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "fdf-editbox-input";
  const border = (firstProp(f, "EditBorderSize")?.args[0]?.n ?? 0.009) * scale;
  input.style.padding = `0 ${border}px`;
  // The text frame the FDF names via EditTextFrame carries the font; fall back to the
  // box's own. Either way the input is transparent — the chrome behind it is the FDF's.
  input.style.fontSize = fontSize(f, scale, 0.015);
  el.appendChild(input);

  const control: EditBoxControl = {
    get value(): string { return input.value; },
    set value(v: string) { input.value = v; },
    focus: () => input.focus(),
    setEnabled(on: boolean): void {
      input.disabled = !on;
      el.classList.toggle("fdf-disabled", !on);
    },
  };
  input.addEventListener("input", () => control.onChange?.(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") control.onSubmit?.(input.value);
  });
  return control;
}

// --- GLUECHECKBOX (check box / radio button) ---------------------------------------

/**
 * A check box. The FDF gives it the same state backdrops a button has, plus one more the
 * button family has no use for: `CheckBoxCheckHighlight` names a HIGHLIGHT frame whose
 * `HighlightAlphaFile` is the TICK — drawn over the box only while it is checked. The
 * renderer composites that face and leaves it to CSS; all this holds is the state.
 *
 * A RADIO button is the same widget with different art (`EscMenuRadioButtonTemplate` — a
 * round box and a dot for the tick). The engine gives it no grouping of its own either, so
 * the screen that owns a set is what clears the siblings; see `radioGroup` in ui/chatDialog.ts.
 */
export function buildCheckBox(el: HTMLElement): CheckBoxControl {
  el.classList.add("fdf-checkbox");
  let checked = false;
  let enabled = true;

  const control: CheckBoxControl = {
    get checked(): boolean { return checked; },
    set checked(v: boolean) {
      checked = v;
      el.classList.toggle("fdf-checked", v);
    },
    setEnabled(on: boolean): void {
      enabled = on;
      el.classList.toggle("fdf-disabled", !on);
    },
  };

  el.addEventListener("click", () => {
    if (!enabled) return;
    control.checked = !checked;
    control.onChange?.(checked);
  });
  return control;
}

// --- SLIDER ------------------------------------------------------------------------

/**
 * A horizontal slider (the Options screen's volume / gamma / scroll-speed bars). The FDF
 * gives it a track (`ControlBackdrop`, already drawn by the renderer) and a knob
 * (`SliderThumbButtonFrame`, passed in as `thumb`), plus its range on the frame itself —
 * `SliderMinValue` / `SliderMaxValue` / `SliderStepSize` / `SliderInitialValue`.
 *
 * The engine parks the un-anchored knob and slides it along the track; we do the same, taking
 * over the thumb's horizontal position entirely (position:absolute, left = value·track). Drag,
 * a track click, and the arrow keys all move it, snapping to the step. Only the horizontal
 * layout is handled — every SLIDER on the Options screen is `SliderLayoutHorizontal`, and the
 * vertical ones are SCROLLBARs, which the list/textarea widgets scroll natively instead.
 */
export function buildSlider(el: HTMLElement, f: FdfFrame, thumb: HTMLElement | null): SliderControl {
  el.classList.add("fdf-slider");
  const min = firstProp(f, "SliderMinValue")?.args[0]?.n ?? 0;
  const max = firstProp(f, "SliderMaxValue")?.args[0]?.n ?? 100;
  const step = firstProp(f, "SliderStepSize")?.args[0]?.n ?? 1;
  const initial = firstProp(f, "SliderInitialValue")?.args[0]?.n ?? min;
  const span = max - min || 1;

  let value = initial;
  let enabled = true;

  // The knob is positioned by fraction of the track, centred on its own width — so at 0 it
  // sits flush-left and at max flush-right rather than overhanging either end.
  if (thumb) {
    thumb.classList.add("fdf-slider-thumb");
    thumb.style.left = "0"; // overrides the layout's default corner placement
    thumb.style.top = "50%";
  }
  const place = (): void => {
    if (!thumb) return;
    const frac = (value - min) / span;
    thumb.style.left = `${frac * 100}%`;
  };

  const snap = (v: number): number => {
    const clamped = Math.max(min, Math.min(max, v));
    const stepped = step > 0 ? Math.round((clamped - min) / step) * step + min : clamped;
    return Math.max(min, Math.min(max, stepped));
  };

  const set = (v: number, fire: boolean): void => {
    const next = snap(v);
    if (next === value) { place(); return; }
    value = next;
    place();
    if (fire) control.onChange?.(value);
  };

  const control: SliderControl = {
    get value(): number { return value; },
    set value(v: number) { set(v, false); },
    setEnabled(on: boolean): void {
      enabled = on;
      el.classList.toggle("fdf-disabled", !on);
    },
  };

  // A pointer anywhere on the track sets the value to that x; dragging keeps setting it.
  const fromPointer = (clientX: number): void => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    set(min + frac * span, true);
  };
  let dragging = false;
  const onMove = (e: PointerEvent): void => { if (dragging) fromPointer(e.clientX); };
  const onUp = (): void => {
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  el.addEventListener("pointerdown", (e) => {
    if (!enabled) return;
    dragging = true;
    fromPointer(e.clientX);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    e.preventDefault(); // don't start a text selection / native drag
  });
  el.tabIndex = 0;
  el.addEventListener("keydown", (e) => {
    if (!enabled) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { set(value - (step || 1), true); e.preventDefault(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") { set(value + (step || 1), true); e.preventDefault(); }
  });

  place();
  return control;
}

// --- POPUPMENU (dropdown) ----------------------------------------------------------

/**
 * The open menu's own look, read off the FDF `MENU` frame the POPUPMENU names in
 * `PopupMenuFrame` (StandardPopupMenuMenuTemplate: a bordered backdrop, `MenuItemHeight`,
 * `MenuBorder`, a font and a highlight colour). WC3 draws the dropped-open list from that
 * frame; without it we were drawing a menu of our own invention over the game's chrome.
 */
export interface PopupMenuStyle {
  /** The MENU frame's ControlBackdrop, composited at a pixel size. */
  backdrop(w: number, h: number): HTMLCanvasElement | null;
  itemHeight: number; // px — MenuItemHeight
  border: number; // px — MenuBorder (the backdrop's inset)
  fontSize: number; // px — the MENU's FrameFont
  highlight: string; // MenuTextHighlightColor — the row under the mouse
}

export interface PopupOptions {
  /** The frame whose text shows the current selection (PopupTitleFrame / *Title). */
  titleEl: HTMLElement | null;
  /** Optional swatch element painted with the value instead of text (the colour menu). */
  swatchEl?: HTMLElement | null;
  /** Paint a value into the swatch (colour menu: fill it with the player colour). */
  paintSwatch?: (el: HTMLElement, value: string) => void;
  /** The open list's chrome, from the FDF's own MENU frame. */
  menu?: PopupMenuStyle | null;
}

/**
 * Shrink a label until it fits the box the FDF gave it. WC3's own font sets narrower than
 * any we can ship, so a label the game fits at its declared size ("Night Elf" in a
 * 0.08-wide race menu, "Computer (Normal)" in a name menu) would otherwise run out of the
 * widget. The type gets smaller; nothing ever spills. Below MIN_LABEL_PX it stops shrinking
 * and the ellipsis (style.css / `fitLine`) takes over instead.
 *
 * Exported for the panels that stamp one-line rows out of templates (the quest log's
 * titles): same policy, same floor — shrink first, ellipsis last, never wrap.
 */
export function fitLabel(span: HTMLElement): void {
  const box = span.parentElement;
  if (!box) return;
  // The frame's declared size, kept aside: every call starts from it, or a long label would
  // ratchet the font down and the short one after it would stay tiny.
  const declared = parseFloat(box.dataset.fdfFont ?? getComputedStyle(box).fontSize);
  box.dataset.fdfFont = String(declared);
  box.style.fontSize = `${declared}px`;
  const style = getComputedStyle(box);
  const room = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  if (room <= 0) return;
  for (let size = declared; span.scrollWidth > room && size > MIN_LABEL_PX; size -= 0.5) {
    box.style.fontSize = `${size - 0.5}px`;
  }
}

/** The floor `fitLabel` will not shrink past — below this the label stops being readable,
 *  and the ellipsis (style.css) takes over instead. */
const MIN_LABEL_PX = 8;

/**
 * Pin a TEXT frame's element to ONE line: no wrapping ever — shrink to fit down to the
 * floor, ellipsis beyond it. The renderer's default TEXT is `pre-wrap` (a description
 * wants its line breaks), so a row label that must never wrap opts in here.
 */
export function fitLine(el: HTMLElement): void {
  const span = el.querySelector("span");
  if (!span) return;
  el.style.whiteSpace = "nowrap"; // inline, because paintText set pre-wrap inline
  span.style.display = "block";
  span.style.overflow = "hidden";
  span.style.textOverflow = "ellipsis";
  span.style.maxWidth = "100%";
  fitLabel(span);
}

/** The dropdown that is currently open, if any. Only ever one, as in the game: opening a
 *  second closes the first. A per-popup `document` click listener can't do that on its own
 *  — a popup stops its own click from propagating (or the same click that opened it would
 *  immediately dismiss it), which also stops every OTHER popup's listener from ever seeing
 *  it, so two menus could sit open at once. */
let openPopup: (() => void) | null = null;

/** A dropdown: the frame itself is the closed button; the open list is a popup layer.
 *  The FDF declares the menu's own backdrop/font (StandardPopupMenuMenuTemplate) but
 *  the engine positions and fills it — so the list is ours, styled to match. */
export function buildPopup(
  el: HTMLElement,
  f: FdfFrame,
  scale: number,
  overlay: HTMLElement,
  opts: PopupOptions,
  disposers: Array<() => void>,
): PopupControl {
  el.classList.add("fdf-popup");

  const style = opts.menu ?? null;
  const menu = document.createElement("div");
  menu.className = "fdf-popup-menu";
  menu.style.fontSize = `${style?.fontSize ?? parseFloat(fontSize(f, scale))}px`;
  if (style) {
    menu.classList.add("fdf-popup-menu-chromed"); // the FDF's own backdrop draws; CSS stands down
    menu.style.padding = `${style.border}px`;
    menu.style.setProperty("--fdf-menu-highlight", style.highlight);
  }
  menu.hidden = true;
  // The menu lives on the overlay, not inside the (clipped, low) popup frame — an open
  // race menu overhangs the player rows below it.
  overlay.appendChild(menu);
  /** The MENU frame's backdrop, drawn behind the items at whatever size the list came out. */
  const chrome = document.createElement("canvas");
  chrome.className = "fdf-popup-menu-chrome";

  // The pulldown arrow the FDF hangs off the widget (PlayerSlotPopupMenuArrow1,
  // TeamButtonArrow1…) — the one piece of its chrome that a disabled dropdown drops.
  const arrow = el.querySelector<HTMLElement>(':scope > [data-frame*="Arrow"]');

  let options: Option[] = [];
  let value = "";
  let enabled = true;

  const paint = (): void => {
    const label = options.find((o) => o.value === value)?.label ?? "";
    if (opts.swatchEl && opts.paintSwatch) opts.paintSwatch(opts.swatchEl, value);
    else if (opts.titleEl) {
      opts.titleEl.textContent = label;
      fitLabel(opts.titleEl);
    }
  };

  const close = (): void => {
    menu.hidden = true;
    el.classList.remove("fdf-popup-open");
    if (openPopup === close) openPopup = null;
  };

  const open = (): void => {
    if (!enabled || !options.length) return;
    openPopup?.(); // only one dropdown is ever open
    openPopup = close;
    menu.textContent = "";
    if (style) menu.appendChild(chrome);
    for (const o of options) {
      const item = document.createElement("div");
      item.className = "fdf-popup-item";
      if (o.value === value) item.classList.add("selected");
      if (style) item.style.height = `${style.itemHeight}px`;
      item.textContent = o.label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        if (o.value === value) return;
        value = o.value;
        paint();
        control.onChange?.(value);
      });
      menu.appendChild(item);
    }
    // Drop the list directly under the closed button, matched to its width.
    const box = el.getBoundingClientRect();
    const host = overlay.getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = `${box.left - host.left}px`;
    menu.style.top = `${box.bottom - host.top}px`;
    menu.style.minWidth = `${box.width}px`;
    // The backdrop is composited to the list's own size, so its border sits on the edge —
    // which means the list must have a size first, hence after it is in the document.
    if (style) {
      const w = Math.round(menu.clientWidth), h = Math.round(menu.clientHeight);
      const painted = style.backdrop(w, h);
      const g = chrome.getContext("2d");
      chrome.width = w; chrome.height = h;
      if (painted && g) g.drawImage(painted, 0, 0);
    }
    el.classList.add("fdf-popup-open");
  };

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) open();
    else close();
  });
  // Any click elsewhere dismisses it, as it does in the game.
  document.addEventListener("click", close);
  disposers.push(() => document.removeEventListener("click", close));

  const control: PopupControl = {
    setOptions(next: Option[]): void {
      options = next;
      if (!options.some((o) => o.value === value)) value = options[0]?.value ?? "";
      paint();
    },
    get value(): string { return value; },
    set value(v: string) {
      if (!options.some((o) => o.value === v)) return;
      value = v;
      paint();
    },
    setEnabled(on: boolean): void {
      enabled = on;
      if (!on) close();
      el.classList.toggle("fdf-disabled", !on);
      // A dead dropdown offers nothing to pull down, so the game takes its arrow away too:
      // WarChasers' greyed rows are bare boxes in the real client, arrowless.
      if (arrow) arrow.hidden = !on;
    },
  };
  return control;
}

// --- LISTBOX -----------------------------------------------------------------------

/**
 * The list's scrollbar, from the FDF's own SCROLLBAR frame (StandardScrollBarTemplate: a
 * tiled track, an up and a down arrow button, and a knob). The engine drives it; we draw
 * its four pieces and do the same, rather than leaving the browser's own bar in the middle
 * of the game's chrome.
 */
export interface ScrollBarStyle {
  width: number; // px — the SCROLLBAR frame's Width
  /** px — the inc/dec buttons (square). ZERO when the bar has none; see `up`/`down`. */
  arrow: number;
  knob: number; // px — the thumb's height
  track(w: number, h: number): HTMLCanvasElement | null;
  /** The stepper buttons — ABSENT on a bar that has none. `EscMenuScrollBarTemplate` is
   *  exactly that: its `ScrollBarIncButtonFrame`/`DecButtonFrame` blocks are commented out
   *  in the shipped .fdf, so every in-game bar (the message log, the chat history, a quest's
   *  description) is a bare track and knob. Falling back to the bar's own ControlBackdrop
   *  for a missing arrow — which is what a non-optional accessor forces — stamps the TRACK's
   *  art into both ends and gives it two stepper buttons the game never draws. */
  up?(w: number, h: number): HTMLCanvasElement | null;
  down?(w: number, h: number): HTMLCanvasElement | null;
  thumb(w: number, h: number): HTMLCanvasElement | null;
}

/** A scrolling, selectable list inside a CONTROL/LISTBOX frame's chrome. `ListBoxBorder`
 *  (or the edit box's border) insets the rows from the backdrop, as in the FDF. */
export function buildList(el: HTMLElement, f: FdfFrame, scale: number, bar?: ScrollBarStyle | null): ListControl {
  el.classList.add("fdf-list");

  const rows = document.createElement("div");
  rows.className = "fdf-list-rows";
  const border = (firstProp(f, "ListBoxBorder")?.args[0]?.n ?? 0.008) * scale;
  rows.style.inset = `${border}px`;
  rows.style.fontSize = fontSize(f, scale, 0.012);
  // The rows stop where the scrollbar starts — it is beside them, not over them.
  if (bar) rows.style.right = `${border + bar.width}px`;
  el.appendChild(rows);
  const scrollbar = bar ? buildScrollBar(el, rows, bar, border) : null;

  let items: ListItem[] = [];
  let value: string | null = null;
  let enabled = true;

  const paint = (): void => {
    rows.textContent = "";
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "fdf-list-row";
      if (it.value === value) row.classList.add("selected");
      if (it.icon) {
        const icon = document.createElement("img");
        icon.className = "fdf-list-icon";
        icon.src = it.icon.toDataURL();
        row.appendChild(icon);
      }
      const label = document.createElement("span");
      // A map's name is WC3 markup, not plain text — a custom map's author colours it
      // ("|cffffaa00Extreme Candy War 2004|r") and the game paints those colours rather than
      // spelling the codes out.
      label.innerHTML = wc3ToHtml(it.label);
      row.appendChild(label);
      row.addEventListener("click", () => {
        if (!enabled || value === it.value) return;
        value = it.value;
        paint();
        control.onChange?.(it.value);
      });
      row.addEventListener("dblclick", () => { if (enabled) control.onActivate?.(it.value); });
      rows.appendChild(row);
    }
    scrollbar?.sync();
  };

  const control: ListControl = {
    setItems(next: ListItem[]): void {
      items = next;
      if (!items.some((i) => i.value === value)) value = null;
      paint();
    },
    get value(): string | null { return value; },
    /** Set the selection WITHOUT firing onChange — this is a screen restoring its own state
     *  after a rebuild, not the user picking something. Firing here would re-enter the
     *  handler that caused the rebuild in the first place. And it does NOT scroll: the row
     *  the player just clicked is, by definition, already under their cursor — moving the
     *  list out from under it is the last thing they asked for. */
    select(v: string): void {
      if (!items.some((i) => i.value === v)) return;
      value = v;
      const at = rows.scrollTop;
      paint(); // rebuilds the rows, which resets scrollTop — put it back
      rows.scrollTop = at;
      scrollbar?.sync();
    },
    get scrollTop(): number { return rows.scrollTop; },
    set scrollTop(v: number) {
      rows.scrollTop = v;
      scrollbar?.sync();
    },
    setEnabled(on: boolean): void {
      enabled = on;
      el.classList.toggle("fdf-disabled", !on);
    },
  };
  return control;
}

// --- TEXTAREA ----------------------------------------------------------------------

/**
 * A scrolling block of lines — WC3's message log, the chat history, a quest's description,
 * the Help and Tips pages. Everything about its metrics is the FDF's: `TextAreaLineHeight`
 * is the pitch of one line, `TextAreaLineGap` the space between two, `TextAreaInset` the
 * margin off the frame's edge, `TextAreaMaxLines` how many it keeps.
 *
 * The lines are WC3 markup (a player's chat is prefixed with their colour), so they go
 * through `wc3ToHtml` exactly as a list row's label does — not as textContent.
 *
 * Note the FONT: a TEXTAREA's own `FrameFont` is what draws its lines, and it is not the
 * frame's height — `EscMenuTextAreaTemplate` declares no font at all (both its FrameFont
 * lines are commented out in the shipped file) and leaves it to whoever inherits, which is
 * why the fallback here is the 0.011 every in-game text area that DOES declare one uses.
 */
export function buildTextArea(el: HTMLElement, f: FdfFrame, scale: number, bar?: ScrollBarStyle | null): TextAreaControl {
  el.classList.add("fdf-textarea");

  const inset = (firstProp(f, "TextAreaInset")?.args[0]?.n ?? 0.005) * scale;
  const lineH = (firstProp(f, "TextAreaLineHeight")?.args[0]?.n ?? 0.011) * scale;
  const gap = (firstProp(f, "TextAreaLineGap")?.args[0]?.n ?? 0) * scale;
  // `TextAreaMaxLines` is a ROLLING cap, and only the areas that stream declare one:
  // LogArea and ChatHistoryDisplay say 128 because lines arrive forever, while HelpTextArea
  // and TipsTextArea say nothing because they are handed a finished document. So an absent
  // cap means NO cap — inventing a default here trimmed the first ten lines off the Help
  // page (a 136-line file against a fabricated 128) and opened it mid-sentence.
  const maxLines = firstProp(f, "TextAreaMaxLines")?.args[0]?.n ?? Infinity;

  const rows = document.createElement("div");
  rows.className = "fdf-textarea-lines";
  rows.style.inset = `${inset}px`;
  rows.style.fontSize = fontSize(f, scale);
  rows.style.gap = `${gap}px`;
  // The rows stop where the scrollbar starts — it sits beside them, as in the game.
  if (bar) rows.style.right = `${inset + bar.width}px`;
  el.appendChild(rows);
  const scrollbar = bar ? buildScrollBar(el, rows, bar, inset) : null;

  let lines: string[] = [];

  const paint = (): void => {
    rows.textContent = "";
    for (const text of lines) {
      const line = document.createElement("div");
      line.className = "fdf-textarea-line";
      // A line box at least as tall as the FDF's pitch, but free to GROW: a long chat message
      // wraps, and pinning the height would slice the wrapped half off.
      line.style.minHeight = `${lineH}px`;
      line.innerHTML = wc3ToHtml(text);
      rows.appendChild(line);
    }
    scrollbar?.sync();
  };

  const control: TextAreaControl = {
    // A wholesale replacement is a DOCUMENT, not a stream: it is not trimmed. Only the
    // append path below rolls, which is what the cap is for.
    setLines(next: string[]): void {
      lines = next.slice();
      paint();
      rows.scrollTop = 0;
      scrollbar?.sync();
    },
    addLine(line: string): void {
      lines.push(line);
      if (lines.length > maxLines) lines = lines.slice(-maxLines);
      paint();
    },
    clear(): void {
      lines = [];
      paint();
    },
    scrollToBottom(): void {
      rows.scrollTop = rows.scrollHeight;
      scrollbar?.sync();
    },
    setEnabled(on: boolean): void {
      el.classList.toggle("fdf-disabled", !on);
    },
  };
  return control;
}

/** Draw the FDF's scrollbar down the right of `rows` and drive it: the arrows step, the
 *  knob drags, and scrolling the rows any other way (wheel, keyboard) moves the knob back. */
function buildScrollBar(
  el: HTMLElement,
  rows: HTMLElement,
  bar: ScrollBarStyle,
  border: number,
): { sync(): void } {
  const track = document.createElement("div");
  track.className = "fdf-scrollbar";
  track.style.top = `${border}px`;
  track.style.bottom = `${border}px`;
  track.style.right = `${border}px`;
  track.style.width = `${bar.width}px`;
  el.appendChild(track);

  /** One of the bar's pieces: a canvas of the FDF's art at the SIZE THE FDF GIVES IT — the
   *  arrows and the knob are square there, and stretching them to the bar's width flattens
   *  them — centred across the bar. */
  const piece = (draw: (w: number, h: number) => HTMLCanvasElement | null, cls: string, w: number, h: number): HTMLElement => {
    const box = document.createElement("div");
    box.className = cls;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.style.left = `${(bar.width - w) / 2}px`;
    const art = draw(w, h);
    if (art) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w);
      canvas.height = Math.round(h);
      canvas.getContext("2d")?.drawImage(art, 0, 0);
      box.appendChild(canvas);
    }
    track.appendChild(box);
    return box;
  };

  const height = el.clientHeight - 2 * border;
  const back = piece(bar.track, "fdf-scrollbar-track", bar.width, height);
  back.style.top = "0";
  // Steppers only if the FDF declares them — the in-game bars don't (ScrollBarStyle.up).
  const up = bar.up ? piece(bar.up, "fdf-scrollbar-arrow", bar.arrow, bar.arrow) : null;
  if (up) up.style.top = "0";
  const down = bar.down ? piece(bar.down, "fdf-scrollbar-arrow", bar.arrow, bar.arrow) : null;
  if (down) down.style.bottom = "0";
  const knob = piece(bar.thumb, "fdf-scrollbar-knob", bar.knob, bar.knob);

  /** The stretch of track the knob may travel: between the two arrows (the whole
   *  track when there are none). */
  const span = (): number => track.clientHeight - 2 * bar.arrow - bar.knob;

  const sync = (): void => {
    const over = rows.scrollHeight - rows.clientHeight;
    knob.hidden = over <= 1; // nothing to scroll: no knob, as in the game
    if (over <= 1) return;
    knob.style.top = `${bar.arrow + (rows.scrollTop / over) * Math.max(0, span())}px`;
  };

  const step = (): number => (rows.firstElementChild as HTMLElement | null)?.offsetHeight ?? 16;
  up?.addEventListener("click", () => { rows.scrollTop -= step(); });
  down?.addEventListener("click", () => { rows.scrollTop += step(); });
  rows.addEventListener("scroll", sync);

  knob.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const from = e.clientY;
    const at = rows.scrollTop;
    const over = rows.scrollHeight - rows.clientHeight;
    const travel = span();
    const move = (m: PointerEvent): void => {
      if (travel > 0) rows.scrollTop = at + ((m.clientY - from) / travel) * over;
    };
    const drop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
  });

  sync();
  return { sync };
}

/** True when a frame type is one of the widgets above (drawn as chrome + a controller). */
export function widgetKind(f: FdfFrame): WidgetKind | null {
  if (f.type === "EDITBOX") return "edit";
  if (f.type === "POPUPMENU" || f.type === "GLUEPOPUPMENU") return "popup";
  // Check boxes and radio buttons are the SAME frame type — a GLUECHECKBOX — differing only
  // in the art their template hands them (EscMenuCheckBoxTemplate vs EscMenuRadioButtonTemplate).
  if (f.type === "GLUECHECKBOX" || f.type === "CHECKBOX" || f.type === "SIMPLECHECKBOX") return "check";
  // A horizontal SLIDER is a value control; a vertical one is a SCROLLBAR, which the list/
  // textarea widgets scroll natively — so only the horizontal form becomes a widget here.
  if (f.type === "SLIDER" && !hasFlag(f, "SliderLayoutVertical")) return "slider";
  if (f.type === "TEXTAREA") return "textarea";
  // The map/profile lists are CONTROL frames carrying a backdrop and a scrollbar
  // (MapListBox.fdf, ListBoxWar3.fdf); LISTBOX is the older, self-contained form.
  if (f.type === "LISTBOX") return "list";
  if (f.type === "CONTROL" && strProp(f, "ControlBackdrop")) return "list";
  return null;
}

export type WidgetKind = "edit" | "popup" | "list" | "check" | "textarea" | "slider";
