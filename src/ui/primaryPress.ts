// A press is the LEFT button's.
//
// Every button on the glue screens and the in-game panels draws its Down state off CSS
// `:active` (style.css `.fdf-button:active …`, the kit's `.ow3-glue-btn:active`), and Chromium
// raises `:active` for ANY mouse button — a right-press sank the button and swapped in its
// Down face although nothing was going to happen on the release, since `click` is the primary
// button's alone. WC3's own buttons do not move under the right button. Cancelling the press
// does not help: `preventDefault` on `pointerdown` or `mousedown` leaves `:active` set (checked
// in headless Chrome), so the fix is on the CSS side — while a press that STARTED on another
// button is held, the root wears `ow3-alt-press` and every `:active` look is written under
// `:where(:root:not(.ow3-alt-press))` (zero specificity, so no rule's precedence moves).
//
// Read off POINTER events in the capture phase, and not off `mousedown`: the command card
// cancels a right `pointerdown` (an autocast toggle — hud.ts onPress), which suppresses the
// compatibility mouse events entirely. The command card's own `.pressed` is JS and already
// answers only the buttons that mean something there, so it is unaffected.
//
// Imported for its side effect from main.ts.

const ALT_PRESS = "ow3-alt-press";
let alt = false;

function set(on: boolean): void {
  if (alt === on) return;
  alt = on;
  document.documentElement.classList.toggle(ALT_PRESS, on);
}

const opts = { capture: true, passive: true } as const;
window.addEventListener("pointerdown", (e) => {
  // A press that starts on another button while the left is already held leaves the left's
  // press alone — that one is a real press, still drawing its Down state.
  if (e.button !== 0 && (e.buttons & 1) === 0) set(true);
}, opts);
// A second button pressed or let go while one is held is a CHORD, which pointer events report
// as a `pointermove` carrying a `button` (and not as a down/up of its own).
window.addEventListener("pointermove", (e) => {
  if (alt && e.button !== -1 && (e.buttons & ~1) === 0) set(false);
}, opts);
window.addEventListener("pointerup", (e) => { if (e.buttons === 0) set(false); }, opts);
window.addEventListener("pointercancel", () => set(false), opts);
// A release outside the window is never seen; the next focus loss is the latest it can end.
window.addEventListener("blur", () => set(false));
