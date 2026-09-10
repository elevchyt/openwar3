import { isDesktopApp } from "../assets/nativeInstall";

// Alt+Enter toggles fullscreen.
//
// In the desktop app the SHELL answers it (electron/main.mjs, `before-input-event`) and cancels
// the keystroke before the page is sent it, so nothing here ever runs there. In a browser the
// page has to answer it itself — `requestFullscreen` needs a user activation, and this keydown
// is one.
//
// Either way the Enter half must reach NOTHING. A focused glue button fires on Enter
// (ui/fdf/render.ts `wireButton`) and in a match Enter opens the chat box, so the chord is
// taken on `window` in the CAPTURE phase — the first listener on the page, registered at module
// load before any screen exists — and stopped there, key-up included.

/** The Enter of an Alt+Enter is down: its key-up belongs to this chord even if Alt was let go
 *  first, and is swallowed with it. */
let enterTaken = false;

window.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.altKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  enterTaken = true;
  if (e.repeat || isDesktopApp()) return;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen().catch(() => {});
}, true);

const swallowEnter = (e: KeyboardEvent): void => {
  if (e.key !== "Enter" || !enterTaken) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === "keyup") enterTaken = false;
};
window.addEventListener("keypress", swallowEnter, true);
window.addEventListener("keyup", swallowEnter, true);
