import type { FdfScreen } from "./fdf/render";

// Gamepad support (issue #162).
//
// Warcraft III has no gamepad support of any kind — nothing in the install binds a controller,
// so every mapping below is the developer's (issue #162 lists it button for button) and none of
// it is the game's. What IS the game's is everything a button does: a gamepad press is turned
// into the SAME input the mouse or the keyboard would have given, so it inherits every rule
// those already obey (a cinematic owning the mouse, a stopped match, a modal dialog, a chat line
// being typed into) instead of restating them:
//
//   · the LEFT STICK moves a virtual cursor, and X / R1 are a left / right click at it — real
//     pointer and mouse events, dispatched at the element under that point, with the boundary
//     events (`pointerover`/`enter`/`leave`/`out`) a moving mouse would have produced. So a
//     click on the world selects through `selectAt`, a click on a glue button fires its
//     handler, and a held X drags the selection box.
//   · the buttons that have a KEY are that key: O is Escape, Triangle is Space ("Center on
//     last notification"), L1 is "-", R2 is F8, Start is F10 (Escape during a cinematic, which
//     skips it) and Select is F9.
//   · the rest are match actions with no key at all (attack-move at the cursor, a jump to the
//     selection, the building cycle, the command-card selector), and go through a
//     `GamepadMatchHost` the running match installs — `render/mapViewer.ts`.
//
// A page cannot move the OS pointer, so the virtual cursor is DRAWN: an image that wears
// whatever `cursor:` the element under it would have shown the mouse (the race gauntlet, the
// armed reticle, the tinted hover hand — read off the computed style, so every cursor rule the
// game already has applies to it without being restated). The real mouse takes over again the
// moment it moves.
//
// PAIRING. The Gamepad API exposes a controller only once one of its buttons has been pressed
// with the page focused, and a connected pad is not yet a paired one: a pad that has been seen
// but not paired puts up "press START to pair" in the notification stack above the fps strip,
// and START pairs it. Options → Gameplay → "Detect Gamepad" listens for ten seconds and pairs
// whichever pad presses ANY button in that window. One pad is paired at a time, and while one is,
// the same button reads "Unpair Gamepad" and hands the game back to the mouse and keyboard.

/** Standard Gamepad mapping (w3c "standard" layout) — the PlayStation names issue #162 uses. */
const B = {
  cross: 0, circle: 1, square: 2, triangle: 3,
  l1: 4, r1: 5, l2: 6, r2: 7,
  select: 8, start: 9, l3: 10, r3: 11,
  up: 12, down: 13, left: 14, right: 15,
} as const;

/** Stick travel ignored around the centre — a resting DualShock reads up to ~0.1 off zero. */
const DEADZONE = 0.18;
/** Cursor speed at full tilt, in window HEIGHTS per second, so it crosses the screen in the
 *  same time at any resolution. The response is squared, which keeps a small tilt precise. */
const CURSOR_SPEED = 1.15;
/** The D-pad repeats while held, the way a held arrow key does. */
const DPAD_DELAY_MS = 380;
const DPAD_REPEAT_MS = 140;
/** How long "Detect Gamepad" listens. */
const DETECT_MS = 10_000;
/** How long a passing notification stays up. */
const TOAST_MS = 4000;
/** How often the virtual cursor re-reads the `cursor:` under it. The value is a long data URL,
 *  so it is not asked every frame. */
const CURSOR_STYLE_MS = 100;

/**
 * What a running match does for the pad — the actions with no key to stand in for them. Set by
 * the match when its HUD is built and cleared when it is torn down (`setGamepadHost`).
 */
export interface GamepadMatchHost {
  /** May the player give an order right now? The same gates the HUD's own key handler asks
   *  (a hidden console, a cinematic, a stopped match, the F10 menu, any modal dialog). */
  canAct(): boolean;
  /** L3: centre the camera on the selection. */
  jumpToSelection(): void;
  /** Square: attack-move the selection to the point under the cursor — no reticle. */
  attackMoveAt(clientX: number, clientY: number): void;
  /** L2: select the next of the player's buildings and centre on it. */
  cycleBuilding(): void;
  /** D-pad: move the command-card selector by one slot. */
  cardMove(dx: number, dy: number): void;
  /** X while the selector is in charge: press the button under it. False when nothing was pressed. */
  cardPress(): boolean;
  /** The selector took or gave up X (the D-pad took it, the left stick took it back). */
  cardMode(on: boolean): void;
  /** Is a click now wanted in the WORLD — an armed order, or a building on the cursor? */
  targeting(): boolean;
  /** Is a cinematic up (`ShowInterface(false)`, the letterbox)? Start is Escape then — the
   *  skip — since F10 has no menu to open until the cinematic is over. */
  inCinematic(): boolean;
}

let host: GamepadMatchHost | null = null;

/** Install (or, with null, remove) the running match's side of the pad. */
export function setGamepadHost(h: GamepadMatchHost | null): void {
  if (host && host !== h) host.cardMode(false);
  host = h;
  cardMode = false;
}

// --- state ------------------------------------------------------------------------------

/** The paired pad, by its Gamepad API slot. */
let paired: number | null = null;
/** Each pad's buttons last frame, for edges. Kept for EVERY connected pad, so the press that
 *  pairs a pad is consumed by the pairing rather than also being read as a Start. */
const prevButtons = new Map<number, boolean[]>();
/** "Detect Gamepad" is listening until this `performance.now()` (0 = not listening). */
let detectUntil = 0;
/** Pads the player UNPAIRED with the Options button. The standing "press START to pair" line is
 *  not put up for them — they asked for the pad to be left alone, and a line parked over the
 *  minimap for as long as it stays switched on is not that. START still pairs one, as it pairs
 *  any pad. Forgotten when the pad disconnects or is paired again. */
const quiet = new Set<number>();
/** The D-pad owns X (the command-card selector) until the left stick moves. */
let cardMode = false;
/** The dropdown list open now, while a pad is paired (`syncDropdown`), and whether the D-pad owns
 *  X in it — the same hand-over the command card has: the D-pad walks the gold frame down the
 *  list and X picks what it is on, until the left stick takes X back for the cursor. */
let menuEl: HTMLElement | null = null;
let menuMode = false;
/** Right-stick deflection, read by the camera every frame (`gamepadPan`). */
let pan: [number, number] = [0, 0];

let started = false;
let lastTick = 0;

// --- the virtual cursor -----------------------------------------------------------------

let cursorEl: HTMLDivElement | null = null;
/**
 * A transparent layer over the whole page while the pad has the pointer, wearing `cursor: none`
 * — which is how the OS pointer is hidden, since a page cannot move it out of the way.
 *
 * It is a LAYER rather than a `cursor: none` rule on everything because the drawn cursor is read
 * OFF the page's own `cursor:` values (`paintCursor`): a global rule would make every element
 * answer "none" and the pad's cursor would vanish with the OS one. The layer is hit-tested
 * PAST (`hit`), so the pad's events still reach what is under it, and nothing else in the page
 * ever learns it is there — the real mouse's first move takes it away (`hideCursor`).
 */
let veilEl: HTMLDivElement | null = null;
let cursorImg: HTMLImageElement | null = null;
/** Is the pad driving the pointer (the virtual cursor is up)? */
let cursorOn = false;
let cx = 0;
let cy = 0;
/** Where the real mouse last was, so the virtual cursor starts where the player was looking. */
let mouseX = -1;
let mouseY = -1;
/** The element the virtual cursor is over, and the chain `.pad-hover` is on. */
let hoverEl: Element | null = null;
/** The element a held button went down on — the implicit capture a real mouse press has. */
let captureEl: Element | null = null;
/** Which mouse buttons the pad is holding, as a `MouseEvent.buttons` mask. */
let heldMask = 0;
let cursorStyleAt = 0;
let cursorValue = "";

/** What each held pad button started, so its release ends the same thing. */
const holds = new Map<number, () => void>();
/** D-pad auto-repeat: which direction, and when it next fires. */
let dpadHeld: { button: number; next: number } | null = null;

/** Start polling. Idempotent; called once from main.ts. */
export function startGamepad(): void {
  if (started || typeof navigator === "undefined" || !("getGamepads" in navigator)) return;
  started = true;
  window.addEventListener("gamepadconnected", () => refreshPrompt());
  window.addEventListener("gamepaddisconnected", (e) => {
    const idx = (e as GamepadEvent).gamepad.index;
    prevButtons.delete(idx);
    quiet.delete(idx);
    if (idx === paired) unpair(true);
    refreshPrompt();
  });
  // The REAL mouse: remember where it is, and take the pointer back from the pad the moment it
  // moves. Only trusted events — the pad's own synthetic ones pass through here too.
  window.addEventListener(
    "pointermove",
    (e) => {
      if (!e.isTrusted) return;
      mouseX = e.clientX;
      mouseY = e.clientY;
      if (cursorOn && (e.movementX || e.movementY)) hideCursor();
    },
    { capture: true },
  );
  // …and a real press or wheel turn is the mouse too. They land on the VEIL while the pad has the
  // pointer (it covers the page), so this one press or notch is spent taking the pointer back —
  // a player picking the mouse up moves it first anyway.
  for (const type of ["pointerdown", "wheel"] as const) {
    window.addEventListener(type, (e) => { if (e.isTrusted && cursorOn) hideCursor(); }, { capture: true });
  }
  // The veil going up under a STILL mouse is a layout change under the pointer, and the browser
  // answers it with real boundary events: the element the OS pointer was over is told it has been
  // left, for the veil. The pad's cursor starts exactly where that mouse was, so that element is
  // usually the one the pad has just ENTERED — and a command button's tooltip, raised by the
  // pad's own pointerenter, was taken straight back down by the real pointerleave. While the
  // pad has the pointer those events describe nothing the player did, so they are stopped at the
  // window, before any handler sees them. (Capture runs for the non-bubbling enter/leave too.)
  // The ones the veil's REMOVAL sends are left alone: by then the mouse is moving and they are
  // true.
  for (const type of ["pointerover", "pointerout", "pointerenter", "pointerleave", "mouseover", "mouseout", "mouseenter", "mouseleave"] as const) {
    window.addEventListener(
      type,
      (e) => {
        if (e.isTrusted && cursorOn && (e.target === veilEl || e.relatedTarget === veilEl)) e.stopImmediatePropagation();
      },
      { capture: true },
    );
  }
  requestAnimationFrame(tick);
  refreshPrompt(); // a pad the page has already been shown
}

/** Is a pad paired? The HUD shows the command-card selector only then. */
export function gamepadPaired(): boolean {
  return paired !== null;
}

/** The right stick, deadzoned, as [right, down] in −1..1 — the camera pans by it. */
export function gamepadPan(): readonly [number, number] {
  return pan;
}

/**
 * Is `el` under the pointer — the real one (`:hover`) or the pad's? The places that ASK the
 * DOM whether a slot is still hovered (rather than trusting the events) ask this instead, or a
 * tooltip raised by the virtual cursor is taken down the next frame for not being `:hover`.
 */
export function isHovered(el: Element): boolean {
  if (el.matches(":hover")) return true;
  return cursorOn && !!hoverEl && el.contains(hoverEl);
}

function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = lastTick ? Math.min(now - lastTick, 100) / 1000 : 0;
  lastTick = now;
  let pads: ReadonlyArray<Gamepad | null>;
  try {
    pads = navigator.getGamepads();
  } catch {
    return; // a document with the permission policy off
  }
  if (detectUntil && now >= detectUntil) {
    detectUntil = 0;
    if (paired === null) toast("No gamepad found.");
    paintDetect();
  }
  if (detectUntil) paintDetect();
  // The fps strip comes and goes with a match, and the stack stands on it.
  if (stackEl?.childElementCount && now - seatedAt > 250) {
    seatedAt = now;
    stack();
  }

  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    // A pad seen for the FIRST time has just had a button pressed: the browser shows a page a
    // controller only after one of its buttons goes down, and the snapshot that first carries
    // it does not carry that press (measured with an 8BitDo SN30 Pro+ on Chromium/Linux, turned
    // on mid-session — its first frame reads no button down). So its appearance IS the press.
    const appeared = !prevButtons.has(pad.index);
    if (appeared) refreshPrompt();
    const prev = prevButtons.get(pad.index) ?? [];
    const now_ = pad.buttons.map((b) => b.pressed);
    prevButtons.set(pad.index, now_);
    const pressed = (i: number): boolean => !!now_[i] && !prev[i];
    if (pad.index !== paired) {
      // Unpaired: START pairs it, and so does any button while Detect Gamepad is listening —
      // including the press that made the pad appear, which is the one a player turning a
      // controller on for the Detect window makes first, and which no frame will ever show.
      const any = appeared || now_.some((p, i) => p && !prev[i]);
      if (pressed(B.start) || (detectUntil && any)) pair(pad);
      else if (any) refreshPrompt();
      continue;
    }
    syncDropdown();
    drive(pad, now_, prev, dt, now);
  }
  if (paired !== null && !pads[paired]?.connected) unpair(true);
}

function pair(pad: Gamepad): void {
  if (paired !== null && paired !== pad.index) unpair(false);
  paired = pad.index;
  quiet.delete(pad.index);
  detectUntil = 0;
  paintDetect();
  refreshPrompt();
  toast("Gamepad paired.");
}

function unpair(announce: boolean): void {
  // Nothing may stay held down behind a pad that has gone: a lost release is a stuck drag box
  // or a camera riding the army for ever. The table is emptied and the pad let go of BEFORE any
  // release runs, because a release can come straight back here: X's release is a CLICK, and
  // the click on "Unpair Gamepad" unpairs — which found X still in the table and clicked again,
  // until the stack ran out.
  const releases = [...holds.values()];
  holds.clear();
  paired = null;
  for (const release of releases) release();
  dpadHeld = null;
  pan = [0, 0];
  setCardMode(false);
  if (menuEl) for (const it of menuItems(menuEl)) it.classList.remove("pad-sel");
  menuEl = null;
  menuMode = false;
  hideCursor();
  if (announce) toast("Gamepad disconnected.");
  paintDetect(); // "Unpair Gamepad" goes back to "Detect Gamepad"
  refreshPrompt();
}

function drive(pad: Gamepad, down: boolean[], prev: boolean[], dt: number, now: number): void {
  const [lx, ly] = stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
  pan = stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0);

  // The left stick is the mouse — and taking the mouse back is what ends the D-pad's hold on X.
  if (lx || ly) {
    if (!cursorOn) showCursor();
    setCardMode(false);
    menuMode = false;
    const speed = CURSOR_SPEED * window.innerHeight;
    moveCursor(cx + lx * speed * dt, cy + ly * speed * dt);
  } else if (cursorOn && now - cursorStyleAt > CURSOR_STYLE_MS) {
    paintCursor(); // the world moves under a still cursor, and so does what it should look like
  }

  for (let i = 0; i < down.length; i++) {
    if (down[i] && !prev[i]) press(i, now);
    else if (!down[i] && prev[i]) {
      // Out of the table first, then run — see `unpair` for what a release can lead back to.
      const release = holds.get(i);
      holds.delete(i);
      release?.();
      if (dpadHeld?.button === i) dpadHeld = null;
    }
  }
  if (dpadHeld && down[dpadHeld.button] && now >= dpadHeld.next) {
    dpadHeld.next = now + DPAD_REPEAT_MS;
    dpad(dpadHeld.button);
  }
}

function press(button: number, now: number): void {
  switch (button) {
    case B.cross:
      // An open dropdown the D-pad is walking: X picks the option the frame is on.
      if (menuMode && menuEl) {
        pickMenuItem();
        return;
      }
      // The selector's X, while the D-pad has it: press the command button it is on. Leaving
      // the mode once the press armed something is what lets the NEXT X aim it in the world.
      if (cardMode && host?.canAct()) {
        host.cardPress();
        if (host.targeting()) setCardMode(false);
        return;
      }
      holdMouse(button, 0);
      return;
    case B.r1:
      holdMouse(button, 2);
      return;
    case B.circle:
      // O over an open dropdown shuts the LIST and nothing else — as Escape it would also back
      // out of the panel the dropdown is on (F10's Options, the Custom Game screen).
      if (menuEl) {
        closeDropdown();
        return;
      }
      holdKey(button, "Escape", "Escape");
      return;
    case B.triangle:
      holdKey(button, " ", "Space");
      return;
    case B.l1:
      holdKey(button, "-", "Minus");
      return;
    case B.r2:
      holdKey(button, "F8", "F8");
      return;
    case B.start:
      // F10 — except during a cinematic, where it is Escape: the key that SKIPS one
      // (mapViewer's cinematic-skip, EVENT_PLAYER_END_CINEMATIC), and the thing a player
      // reaching for Start in the middle of one is asking for. F10 does nothing there anyway.
      if (host?.inCinematic()) holdKey(button, "Escape", "Escape");
      else holdKey(button, "F10", "F10");
      return;
    case B.select:
      holdKey(button, "F9", "F9");
      return;
    case B.square:
      if (host?.canAct()) host.attackMoveAt(cursorPoint()[0], cursorPoint()[1]);
      return;
    case B.l2:
      if (host?.canAct()) host.cycleBuilding();
      return;
    case B.l3:
      if (host?.canAct()) host.jumpToSelection();
      return;
    case B.up:
    case B.down:
    case B.left:
    case B.right:
      dpadHeld = { button, next: now + DPAD_DELAY_MS };
      dpad(button);
      return;
  }
}

function dpad(button: number): void {
  // An open dropdown takes the D-pad first, on any screen — menus and a match alike.
  if (menuEl) {
    const dy = button === B.up ? -1 : button === B.down ? 1 : 0;
    if (dy) moveMenu(dy);
    return;
  }
  if (!host?.canAct()) return;
  setCardMode(true);
  const dx = button === B.left ? -1 : button === B.right ? 1 : 0;
  const dy = button === B.up ? -1 : button === B.down ? 1 : 0;
  host.cardMove(dx, dy);
}

// --- dropdowns ------------------------------------------------------------------------------
//
// A dropdown's open list is an `.fdf-popup-menu` (ui/fdf/widgets.ts `buildPopup`), and only one
// is ever open, so the pad finds it off the page rather than being told: every pulldown in the
// game — the lobby's race, team, colour and handicap menus, the Options rows, a script's dialog
// — is the same widget. While one is open the gold frame the command card wears sits on an
// option (`.pad-sel`), starting on the one already chosen; the D-pad walks it (held, it repeats,
// so a long list scrolls), X picks it, and O shuts the list.

/** The open dropdown list, if any. */
function openDropdown(): HTMLElement | null {
  for (const m of document.querySelectorAll<HTMLElement>(".fdf-popup-menu")) if (!m.hidden) return m;
  return null;
}

/** Follow the open list: frame its chosen option when it opens, forget it when it shuts. */
function syncDropdown(): void {
  const m = openDropdown();
  if (m === menuEl) return;
  menuEl = m;
  menuMode = false;
  if (!m) return;
  const items = menuItems(m);
  const at = items.findIndex((i) => i.classList.contains("selected"));
  frameMenuItem(items, Math.max(0, at));
}

function menuItems(m: HTMLElement): HTMLElement[] {
  return [...m.querySelectorAll<HTMLElement>(".fdf-popup-item")];
}

function frameMenuItem(items: HTMLElement[], index: number): void {
  items.forEach((it, i) => it.classList.toggle("pad-sel", i === index));
  items[index]?.scrollIntoView({ block: "nearest" }); // the list scrolls past 42vh
}

/** D-pad up/down: the frame one option along, stopping at either end. */
function moveMenu(dy: number): void {
  if (!menuEl) return;
  menuMode = true;
  const items = menuItems(menuEl);
  const at = items.findIndex((i) => i.classList.contains("pad-sel"));
  frameMenuItem(items, Math.min(items.length - 1, Math.max(0, (at < 0 ? 0 : at) + dy)));
}

/** X: choose the framed option — its own click, which sets the value and shuts the list. */
function pickMenuItem(): void {
  const item = menuEl?.querySelector<HTMLElement>(".fdf-popup-item.pad-sel");
  menuMode = false;
  item?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
}

/** O: shut the list with nothing chosen — the "click anywhere else" every dropdown listens for. */
function closeDropdown(): void {
  menuMode = false;
  document.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
}

function setCardMode(on: boolean): void {
  if (cardMode === on) return;
  cardMode = on;
  host?.cardMode(on);
}

/** A stick's two axes past the deadzone, rescaled so the edge of the deadzone is 0, and
 *  squared along its own direction for a gentle start. */
function stick(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return [0, 0];
  const k = Math.min(1, (m - DEADZONE) / (1 - DEADZONE));
  return [(x / m) * k * k, (y / m) * k * k];
}

// --- keys -------------------------------------------------------------------------------

/** Press a key for as long as the pad button is held — so a held L1 after a double tap rides
 *  the army exactly as a held "-" does. Dispatched at the focused element, like a real key. */
function holdKey(button: number, key: string, code: string): void {
  const target = document.activeElement ?? document.body;
  const init = { key, code, bubbles: true, cancelable: true, composed: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  holds.set(button, () => target.dispatchEvent(new KeyboardEvent("keyup", init)));
}

// --- the mouse --------------------------------------------------------------------------

/** Where the virtual cursor is — or, before it has ever moved, where the mouse was. */
function cursorPoint(): [number, number] {
  if (cursorOn) return [cx, cy];
  return mouseX >= 0 ? [mouseX, mouseY] : [window.innerWidth / 2, window.innerHeight / 2];
}

function showCursor(): void {
  [cx, cy] = cursorPoint();
  cursorOn = true;
  if (!cursorEl) {
    cursorEl = document.createElement("div");
    cursorEl.className = "gamepad-cursor";
    cursorImg = document.createElement("img");
    cursorImg.alt = "";
    cursorEl.appendChild(cursorImg);
    veilEl = document.createElement("div");
    veilEl.id = "gamepad-veil";
    document.body.append(veilEl, cursorEl);
  }
  cursorEl.hidden = false;
  if (veilEl) veilEl.hidden = false;
  moveCursor(cx, cy);
}

function hideCursor(): void {
  if (!cursorOn) return;
  cursorOn = false;
  if (cursorEl) cursorEl.hidden = true;
  if (veilEl) veilEl.hidden = true;
  setHover(null);
}

/** The element at a point as the page would see it with no veil over it. */
function hit(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el !== veilEl && el !== cursorEl && !cursorEl?.contains(el)) return el;
  }
  return null;
}

function moveCursor(x: number, y: number): void {
  cx = Math.min(Math.max(x, 0), window.innerWidth - 1);
  cy = Math.min(Math.max(y, 0), window.innerHeight - 1);
  const under = hit(cx, cy);
  setHover(under);
  const target = captureEl ?? under;
  if (target) {
    target.dispatchEvent(pointerEvent("pointermove", -1));
    target.dispatchEvent(mouseEvent("mousemove", 0));
  }
  paintCursor();
}

/** Draw the cursor the element under it asks for. `cursor: none` hides it — which is how the
 *  edge-scroll chevron and the carried item REPLACE the pointer for the mouse, too. */
function paintCursor(): void {
  if (!cursorEl || !cursorImg) return;
  cursorEl.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
  const now = performance.now();
  if (now - cursorStyleAt < CURSOR_STYLE_MS) return;
  // The page can take the element out from under a STILL cursor — X on an Options category
  // rebuilds that panel's whole tree — and a detached element's `cursor` reads "" (drawn as the
  // plain fallback arrow, over a panel that asks for the gauntlet). A real mouse is re-targeted by
  // the browser after such a change; the pad's is re-targeted here, boundary events and all.
  if (hoverEl && !hoverEl.isConnected) setHover(hit(cx, cy));
  cursorStyleAt = now;
  const value = hoverEl ? getComputedStyle(hoverEl).cursor : getComputedStyle(document.body).cursor;
  if (value === cursorValue) return;
  cursorValue = value;
  // The FIRST image of the list is the one the mouse would wear away from an edge; the ≤32 px
  // twins behind it exist only for the OS's sake (ui/cursor.ts cursorValue).
  const m = /url\("?([^")]+)"?\)\s*(-?\d+)?\s*(-?\d+)?/.exec(value);
  if (value === "none" || !m) {
    cursorImg.hidden = value === "none";
    if (!m) {
      cursorImg.removeAttribute("src");
      cursorEl.classList.toggle("plain", value !== "none");
    }
    return;
  }
  cursorEl.classList.remove("plain");
  cursorImg.hidden = false;
  cursorImg.src = m[1];
  cursorImg.style.left = `${-(Number(m[2]) || 0)}px`;
  cursorImg.style.top = `${-(Number(m[3]) || 0)}px`;
}

/** Move the hover to `next`, firing the boundary events a real pointer would have, and keep
 *  `.pad-hover` on its ancestor chain — the stylesheet's stand-in for `:hover`. */
function setHover(next: Element | null): void {
  const prev = hoverEl;
  if (prev === next) return;
  hoverEl = next;
  const chain = (el: Element | null): Element[] => {
    const out: Element[] = [];
    for (let e = el; e; e = e.parentElement) out.push(e);
    return out;
  };
  const oldChain = chain(prev);
  const newChain = chain(next);
  if (prev) {
    prev.dispatchEvent(pointerEvent("pointerout", -1, next));
    prev.dispatchEvent(mouseEvent("mouseout", 0, next));
    for (const el of oldChain) {
      if (newChain.includes(el)) break;
      el.classList.remove("pad-hover");
      el.dispatchEvent(pointerEvent("pointerleave", -1, next, false));
      el.dispatchEvent(mouseEvent("mouseleave", 0, next, false));
    }
  }
  if (next) {
    next.dispatchEvent(pointerEvent("pointerover", -1, prev));
    next.dispatchEvent(mouseEvent("mouseover", 0, prev));
    for (const el of [...newChain].reverse()) {
      if (oldChain.includes(el)) continue;
      el.classList.add("pad-hover");
      el.dispatchEvent(pointerEvent("pointerenter", -1, prev, false));
      el.dispatchEvent(mouseEvent("mouseenter", 0, prev, false));
    }
  }
  cursorStyleAt = 0; // a new element may want a new cursor
}

/** Hold mouse button `b` (0 left, 2 right) down at the cursor until the pad button comes up. */
function holdMouse(padButton: number, b: 0 | 2): void {
  if (!cursorOn) showCursor();
  const bit = b === 0 ? 1 : 2;
  const under = hit(cx, cy);
  if (!under) return;
  setHover(under);
  heldMask |= bit;
  if (b === 0) captureEl = under;
  const downOk = under.dispatchEvent(pointerEvent("pointerdown", b));
  const mouseOk = under.dispatchEvent(mouseEvent("mousedown", b));
  // A real press focuses what it lands on (an edit box, the chat line); a synthetic one does
  // not, unless we do it. Skipped when a handler said no, as the browser would.
  if (downOk && mouseOk && b === 0) {
    const focusable = under.closest<HTMLElement>("input, textarea, select, [tabindex], [contenteditable='true']");
    if (focusable) focusable.focus();
    else if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
  }
  holds.set(padButton, () => {
    heldMask &= ~bit;
    const upAt = (b === 0 ? captureEl : null) ?? hit(cx, cy) ?? under;
    if (b === 0) captureEl = null;
    upAt.dispatchEvent(pointerEvent("pointerup", b));
    upAt.dispatchEvent(mouseEvent("mouseup", b));
    // The click lands on the nearest element both ends of it share, as it does for a mouse.
    const end = hit(cx, cy);
    let common: Element | null = end;
    while (common && !common.contains(under)) common = common.parentElement;
    if (!common) return;
    common.dispatchEvent(mouseEvent(b === 0 ? "click" : "contextmenu", b, null, true, b === 2));
  });
}

function pointerEvent(type: string, button: number, related: Element | null = null, bubbles = true): PointerEvent {
  return new PointerEvent(type, {
    ...pointerInit(button, related, bubbles),
    // The mouse's own id: Chromium treats pointer 1 as always active, so a handler's
    // `setPointerCapture(e.pointerId)` accepts it instead of throwing on an unknown pointer.
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
}

function mouseEvent(type: string, button: number, related: Element | null = null, bubbles = true, cancelable = true): MouseEvent {
  return new MouseEvent(type, { ...pointerInit(button, related, bubbles), cancelable });
}

function pointerInit(button: number, related: Element | null, bubbles: boolean): MouseEventInit {
  return {
    bubbles,
    cancelable: true,
    composed: true,
    clientX: cx,
    clientY: cy,
    screenX: cx,
    screenY: cy,
    button: Math.max(button, 0),
    buttons: heldMask,
    relatedTarget: related,
    view: window,
  };
}

// --- notifications ----------------------------------------------------------------------

let stackEl: HTMLDivElement | null = null;
let seatedAt = 0;
let promptEl: HTMLDivElement | null = null;

/** The stack sits directly above the fps strip (ui/metrics.ts) when that is up, and in its
 *  place when it is not — the menus have none. */
function stack(): HTMLDivElement {
  if (!stackEl) {
    stackEl = document.createElement("div");
    stackEl.className = "gamepad-toasts";
    document.body.appendChild(stackEl);
  }
  const metrics = document.querySelector<HTMLElement>(".metrics");
  const lift = metrics && !metrics.hidden ? metrics.offsetHeight + 6 : 0;
  stackEl.style.bottom = `${10 + lift}px`;
  return stackEl;
}

/** A passing line: up for `TOAST_MS`, then gone. */
function toast(text: string): void {
  const el = document.createElement("div");
  el.className = "gamepad-toast";
  el.textContent = text;
  stack().appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 400);
  }, TOAST_MS);
}

/** "Press START to pair" stands for as long as a pad has been seen and none is paired. */
function refreshPrompt(): void {
  let seen = false;
  try {
    seen = navigator.getGamepads().some((p) => !!p?.connected && !quiet.has(p.index));
  } catch {
    // no Gamepad API in this document
  }
  const want = seen && paired === null;
  if (want && !promptEl) {
    promptEl = document.createElement("div");
    promptEl.className = "gamepad-toast prompt";
    promptEl.textContent = "Gamepad detected — press START to pair.";
    stack().appendChild(promptEl);
  } else if (!want && promptEl) {
    promptEl.remove();
    promptEl = null;
  } else if (want) {
    stack(); // re-seat above the fps strip, which may have come or gone since
  }
}

// --- Options → Gameplay → "Detect Gamepad" / "Unpair Gamepad" ---------------------------

/** The Options panel on screen now, and the two labels its button wears. Replaced on every build
 *  (a screen rebuilds its whole tree on resize), so the countdown follows the rebuild. */
let optionsScreen: { screen: FdfScreen; detect: string; unpair: string } | null = null;

/** Wire a screen's gamepad button. Called from each Options panel's bind, with the two labels
 *  resolved through that screen's GlobalStrings (`DETECT_GAMEPAD`, `UNPAIR_GAMEPAD`). */
export function bindGamepadButton(screen: FdfScreen, labels: { detect: string; unpair: string }): void {
  optionsScreen = { screen, ...labels };
  paintDetect();
}

/** The button's click: with a pad paired, let it go; without one, listen for `DETECT_MS` for any
 *  button on any pad. */
export function gamepadButtonPressed(): void {
  if (paired !== null) {
    unpairGamepad();
    return;
  }
  if (detectUntil) return;
  detectUntil = performance.now() + DETECT_MS;
  toast("Press any button on your gamepad…");
  paintDetect();
}

/**
 * "Unpair Gamepad": back to the mouse and keyboard. Everything the pad held is released and its
 * cursor, its veil and the command-card frame go (`unpair`) — the frame because the HUD asks
 * `gamepadPaired()` before drawing it. The pad itself stays connected and is left alone
 * (`quiet`), until START or this button pairs it again.
 */
function unpairGamepad(): void {
  if (paired === null) return;
  quiet.add(paired);
  unpair(false);
  toast("Gamepad unpaired.");
}

/** Dress the button for the state it is in: "Unpair Gamepad" while a pad is paired, "Detect
 *  Gamepad" otherwise — greyed, with the seconds counting down on it, while it listens. */
function paintDetect(): void {
  if (!optionsScreen) return;
  const { screen, detect, unpair: unpairLabel } = optionsScreen;
  if (!screen.element.isConnected) {
    optionsScreen = null;
    return;
  }
  const left = detectUntil ? Math.max(0, Math.ceil((detectUntil - performance.now()) / 1000)) : 0;
  const text = paired !== null ? unpairLabel : left ? `${detect} (${left}s)` : detect;
  if (screen.frame("GamepadButtonText")?.textContent !== text) screen.setText("GamepadButtonText", text);
  screen.setEnabled("GamepadButton", !left);
}
