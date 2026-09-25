import { dressAsGameTip } from "./gameTipSkin";

// The gamepad's on-screen keyboard (issue #162).
//
// A pad has no letters, and a few screens cannot be got past without some: a new profile wants
// a NAME, a LAN game a name, the chat line a message. So X on a text field puts this up beside
// the field, and the pad types into it: the D-pad walks the keys, X types the one it is on, and
// the face buttons take the four keys a player reaches for most — Square deletes, Triangle is a
// space, Start is Enter (which is what creates the profile or sends the line), O puts the
// keyboard away. The left stick still moves the cursor, and a click on a key types it, so the
// real mouse can use it too.
//
// Nothing in Warcraft III is a keyboard, so the LOOK is borrowed from the one slab the game
// draws for OpenWar3's own hints: the tooltip's slate fill in its gold border (`dressAsGameTip`,
// placeholder chrome until an install is mounted), the game's font, and the D-pad's gold frame
// on the key that X will type. It is small and off to the side of the field it is typing into —
// a keyboard that covers the screen it is filling in is one the player has to put away to read.
//
// Typing is done to the FIELD, not by keys: the text goes in at the caret with `setRangeText`
// and the field hears an `input` event, which is what every edit box in the game listens to
// (ui/fdf/widgets.ts `buildEditBox`). Only Enter is a key, because Enter is an action — the edit
// box's `onSubmit`, the chat line's send — and not a character.

type Field = HTMLInputElement | HTMLTextAreaElement;

/** One key: what it types (or does) and how many of the ten columns it spans. */
interface Key {
  label: string;
  /** A character to type, or one of the named actions. */
  act: string;
  span: number;
}

const k = (chars: string): Key[] => [...chars].map((c) => ({ label: c, act: c, span: 1 }));
const act = (label: string, name: string, span: number): Key => ({ label, act: name, span });

/** The bottom row is shared by both layers; its first key swaps between them. */
const bottom = (swap: string): Key[] => [act(swap, "layer", 2), act("Space", " ", 5), ...k("."), act("Enter", "enter", 2)];

/** Two layers of ten columns: letters, then the symbols a chat line or a map name wants. */
const LAYERS: Key[][][] = [
  [k("1234567890"), k("qwertyuiop"), k("asdfghjkl'"), [act("⇧", "shift", 1), ...k("zxcvbnm-"), act("⌫", "back", 1)], bottom("#+=")],
  [k("1234567890"), k("!@#$%^&*()"), k('_=+[]{};:"'), [...k("~/\\|<>?,`"), act("⌫", "back", 1)], bottom("ABC")],
];

/** The text inputs a player types into. A checkbox or a range is an <input> too, and is not one. */
const TEXT_TYPES = new Set(["text", "search", "password", "email", "url", "tel", "number", ""]);

/** The text field `el` is, or is inside — null for anything else, or a field that cannot take text. */
export function textField(el: Element | null): Field | null {
  const f = el?.closest("input, textarea");
  if (f instanceof HTMLTextAreaElement) return f.disabled || f.readOnly ? null : f;
  if (f instanceof HTMLInputElement && TEXT_TYPES.has(f.type) && !f.disabled && !f.readOnly) return f;
  return null;
}

let root: HTMLDivElement | null = null;
let field: Field | null = null;
let layer = 0;
let shift = false;
/** The key the D-pad is on, as (row, index in row). */
let row = 1;
let col = 0;
/** Does the D-pad have the keyboard (the frame is drawn), or has the left stick taken X back? */
let padMode = true;

/** Is the keyboard up? */
export function keyboardOpen(): boolean {
  return !!field;
}

/** Put the keyboard up for `f`, on the key the D-pad starts on (`q`), with the caret at the end. */
export function openKeyboard(f: Field): void {
  if (!root) build();
  if (field !== f) {
    field = f;
    layer = 0;
    shift = false;
    row = 1;
    col = 0;
    try {
      f.setSelectionRange(f.value.length, f.value.length);
    } catch {
      // an input type without a selection (email, number) — typing appends instead
    }
  }
  padMode = true;
  root!.hidden = false;
  paint();
  place();
}

/** Put it away. The field keeps what was typed and gives up the focus, so the screen's own keys
 *  (O backing out of it, the D-pad walking it) are the pad's again. */
export function closeKeyboard(): void {
  if (!field) return;
  const f = field;
  field = null;
  if (root) root.hidden = true;
  if (document.activeElement === f) f.blur();
}

/** The D-pad took the keyboard (true) or the left stick took X back for the cursor (false). */
export function keyboardPadMode(on: boolean): void {
  if (padMode === on) return;
  padMode = on;
  paint();
}

export function keyboardHasPad(): boolean {
  return padMode;
}

/** Follow the field every frame: put the keyboard away when the field goes (a screen swapped, the
 *  chat line closed, the focus moved somewhere else), and keep it beside the field when it moves. */
export function syncKeyboard(): void {
  if (!field) return;
  const r = field.getBoundingClientRect();
  if (!field.isConnected || field.disabled || document.activeElement !== field || r.width < 2 || r.height < 2) {
    closeKeyboard();
    return;
  }
  place();
}

/** One D-pad step. Left/right walk the row and wrap; up/down land on the key under the middle of
 *  the one the frame is on, so the wide keys of the bottom row are reached from any column. */
export function keyboardMove(dx: number, dy: number): void {
  if (!field) return;
  padMode = true;
  const rows = LAYERS[layer];
  if (dx) {
    col = (col + dx + rows[row].length) % rows[row].length;
  } else if (dy) {
    const mid = spanStart(rows[row], col) + rows[row][col].span / 2;
    row = (row + dy + rows.length) % rows.length;
    col = keyAt(rows[row], mid);
  }
  paint();
}

/** X: the key the frame is on. */
export function keyboardPress(): void {
  if (field) press(LAYERS[layer][row][col]);
}

/** The face buttons' shortcuts: Square, Triangle, Start. */
export function keyboardBackspace(): void {
  if (field) press({ label: "", act: "back", span: 1 });
}
export function keyboardSpace(): void {
  if (field) press({ label: "", act: " ", span: 1 });
}
export function keyboardEnter(): void {
  if (field) press({ label: "", act: "enter", span: 1 });
}

function spanStart(keys: Key[], index: number): number {
  let at = 0;
  for (let i = 0; i < index; i++) at += keys[i].span;
  return at;
}

function keyAt(keys: Key[], column: number): number {
  let at = 0;
  for (let i = 0; i < keys.length; i++) {
    at += keys[i].span;
    if (column < at) return i;
  }
  return keys.length - 1;
}

function press(key: Key): void {
  const f = field;
  if (!f) return;
  switch (key.act) {
    case "shift":
      shift = !shift;
      break;
    case "layer":
      layer = 1 - layer;
      row = Math.min(row, LAYERS[layer].length - 1);
      col = Math.min(col, LAYERS[layer][row].length - 1);
      break;
    case "back":
      edit(f, "", true);
      break;
    case "enter": {
      // A key, not a character: the edit box's submit and the chat line's send both listen for it.
      const init = { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true };
      f.dispatchEvent(new KeyboardEvent("keydown", init));
      f.dispatchEvent(new KeyboardEvent("keyup", init));
      closeKeyboard();
      return;
    }
    default: {
      const upper = shift && key.act.length === 1 && key.act !== key.act.toUpperCase();
      edit(f, upper ? key.act.toUpperCase() : key.act, false);
      if (upper) shift = false; // one letter, as a phone's shift does
    }
  }
  paint();
}

/** Type `text` over the selection (or delete one character back, for `back`), and tell the field. */
function edit(f: Field, text: string, back: boolean): void {
  let start = f.value.length;
  let end = start;
  try {
    start = f.selectionStart ?? start;
    end = f.selectionEnd ?? end;
  } catch {
    // no selection on this input type: work at the end
  }
  if (back) {
    if (start === end) {
      if (start === 0) return;
      start--;
    }
  } else if (f.maxLength > 0 && f.value.length - (end - start) + text.length > f.maxLength) {
    return; // full — the field's own limit, as a real key would find it
  }
  try {
    f.setRangeText(text, start, end, "end");
  } catch {
    f.value = back ? f.value.slice(0, -1) : f.value + text;
  }
  f.dispatchEvent(new Event("input", { bubbles: true }));
}

function build(): void {
  root = document.createElement("div");
  root.className = "pad-keyboard";
  root.hidden = true;
  dressAsGameTip(root);
  // A press on the keyboard must not take the focus off the field it is typing into — a real
  // mouse's, and the pad's (ui/gamepad.ts `holdMouse` leaves the focus alone when the press is
  // refused, as the browser does).
  root.addEventListener("mousedown", (e) => e.preventDefault());
  root.addEventListener("pointerdown", (e) => e.preventDefault());
  root.addEventListener("click", (e) => {
    const el = (e.target as Element).closest<HTMLElement>(".pad-kb-key");
    if (!el) return;
    const r = Number(el.dataset.row);
    const c = Number(el.dataset.col);
    const key = LAYERS[layer][r]?.[c];
    if (!key) return;
    row = r;
    col = c;
    press(key);
  });
  const keys = document.createElement("div");
  keys.className = "pad-kb-keys";
  // No legend of the shortcut buttons under it: the keys say what they do, and a line of
  // controller glyphs is chrome the developer asked to keep off it (docs/gamepad.md has them).
  root.appendChild(keys);
  document.body.appendChild(root);
}

/** Draw the current layer, with shift and the frame where they are. Rebuilt whole — it is fifty
 *  small elements, and it only changes on a press. */
function paint(): void {
  if (!root) return;
  dressAsGameTip(root); // the install may have been mounted since it was built
  const keys = root.querySelector<HTMLDivElement>(".pad-kb-keys")!;
  keys.replaceChildren();
  LAYERS[layer].forEach((line, r) => {
    line.forEach((key, c) => {
      const el = document.createElement("div");
      el.className = "pad-kb-key";
      if (key.act.length > 1 || key.act === " ") el.classList.add("pad-kb-wide");
      if (key.act === "shift" && shift) el.classList.add("on");
      if (padMode && r === row && c === col) el.classList.add("sel");
      el.dataset.row = String(r);
      el.dataset.col = String(c);
      el.style.gridColumn = `span ${key.span}`;
      el.textContent = shift && key.act.length === 1 ? key.label.toUpperCase() : key.label;
      keys.appendChild(el);
    });
  });
}

/** Beside the field, on whichever side has more room — under a menu's edit box, over the chat
 *  line (whose underside is the console) — and never off-screen. */
function place(): void {
  if (!root || !field) return;
  const r = field.getBoundingClientRect();
  const w = root.offsetWidth;
  const h = root.offsetHeight;
  const gap = 8;
  const roomBelow = window.innerHeight - r.bottom;
  const below = roomBelow >= r.top ? roomBelow >= h + gap : r.top < h + gap;
  const top = below ? r.bottom + gap : Math.max(gap, r.top - gap - h);
  const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, gap), window.innerWidth - w - gap);
  root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
