// WHERE AN INPUT CAME FROM (issue #158, game/inputTrack.ts) — the last thing the player did
// with their hands, classified, so the replay's input track can say of a command "a hotkey", of
// a selection "a drag box", and where on the screen the cursor was.
//
// It LISTENS and changes nothing: three capture-phase listeners on the window, each reading the
// event on its way down, none stopping it. What it keeps is the most recent gesture and the
// pointer's position; whoever is recording asks for them at the moment something happens
// (`commandSource`, `selectionSource`), and an answer older than `FRESH_MS` is "other" — a
// command a trigger or a queued order produced was not pressed by anybody.
//
// A gesture nobody's hand made is told apart by `isTrusted`: the gamepad (ui/gamepad.ts) drives
// the game by dispatching real pointer and key events of its own, so its presses arrive
// untrusted; Voice Control does the same and says so first (`withInputOverride`).

/** How a COMMAND was given. */
export type CommandSource = "hotkey" | "card" | "smart" | "click" | "minimap" | "voice" | "gamepad" | "other";
/** How a SELECTION was made. */
export type SelectionSource = "click" | "box" | "dblclick" | "type" | "group" | "tab" | "hotkey" | "minimap" | "hud" | "voice" | "gamepad" | "other";

interface Gesture {
  device: "key" | "pointer";
  /** `KeyboardEvent.key` for a key. */
  key: string;
  /** The mouse button for a pointer (0 left, 2 right). */
  button: number;
  area: "card" | "minimap" | "world" | "hud";
  drag: boolean;
  dbl: boolean;
  ctrl: boolean;
  synthetic: boolean;
  at: number;
}

/** How long a gesture still explains what follows it. Ours. */
const FRESH_MS = 400;
/** A press that moved this far before release was a drag. Ours. */
const DRAG_PX = 6;

let last: Gesture | null = null;
let override: { src: "voice"; until: number } | null = null;
let down: { x: number; y: number } | null = null;
const cursor = { x: 0, y: 0 };
let installed = false;

function areaOf(target: EventTarget | null): Gesture["area"] {
  const el = target instanceof Element ? target : null;
  if (!el) return "world";
  if (el.closest(".hud-command")) return "card";
  if (el.closest(".hud-minimap")) return "minimap";
  return el instanceof HTMLCanvasElement ? "world" : "hud";
}

/** Start listening. Idempotent; a no-op where there is no window (the headless tests). */
export function watchInputSource(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    last = { device: "key", key: e.key, button: -1, area: "world", drag: false, dbl: false, ctrl: e.ctrlKey || e.metaKey, synthetic: !e.isTrusted, at: performance.now() };
  }, true);
  window.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
    last = { device: "pointer", key: "", button: e.button, area: areaOf(e.target), drag: false, dbl: e.detail >= 2, ctrl: e.ctrlKey || e.metaKey, synthetic: !e.isTrusted, at: performance.now() };
  }, true);
  window.addEventListener("pointerup", (e) => {
    // The release is when a box select lands, so it renews the gesture and says whether it dragged.
    if (last?.device === "pointer" && down) {
      last.drag = Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX;
      last.at = performance.now();
    }
    down = null;
  }, true);
  window.addEventListener("pointermove", (e) => {
    cursor.x = e.clientX;
    cursor.y = e.clientY;
  }, { capture: true, passive: true });
}

/** Run `fn` as VOICE CONTROL's doing: what it issues is the voice's, not the click it borrows. */
export function withInputOverride<T>(src: "voice", fn: () => T): T {
  override = { src, until: performance.now() + FRESH_MS };
  return fn();
}

function fresh(): Gesture | null {
  return last && performance.now() - last.at <= FRESH_MS ? last : null;
}

function overridden(): "voice" | null {
  return override && performance.now() <= override.until ? override.src : null;
}

/** How the command being issued right now was given. */
export function commandSource(): CommandSource {
  const o = overridden();
  if (o) return o;
  const g = fresh();
  if (!g) return "other";
  if (g.synthetic) return "gamepad";
  if (g.device === "key") return "hotkey";
  if (g.area === "card") return "card";
  if (g.area === "minimap") return "minimap";
  return g.button === 2 ? "smart" : "click";
}

/** How the selection that just changed was made. */
export function selectionSource(): SelectionSource {
  const o = overridden();
  if (o) return o;
  const g = fresh();
  if (!g) return "other";
  if (g.synthetic) return "gamepad";
  if (g.device === "key") return /^[0-9]$/.test(g.key) ? "group" : g.key === "Tab" ? "tab" : "hotkey";
  if (g.area === "minimap") return "minimap";
  if (g.area !== "world") return "hud";
  if (g.drag) return "box";
  if (g.dbl) return "dblclick";
  return g.ctrl ? "type" : "click";
}

/** The pointer, in thousandths of the window (0…1000 each way). */
export function cursorPermille(): [number, number] {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  return [Math.round((cursor.x / w) * 1000), Math.round((cursor.y / h) * 1000)];
}
