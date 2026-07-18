// Glue-screen panel animation (issue #61).
//
// The PANEL — the ornate chrome with the chains — is a 3D sprite-layer model, and it is
// the game itself that moves it: its MDX carries a "<Screen> Birth" / "<Screen> Death"
// clip per glue screen (see render/menuScene.ts), and that is the springy up-and-off
// motion. What lives here is the other half: the DOM the FDF puts INSIDE those panels —
// the buttons, the labels, the map list, the player rows.
//
// Those do NOT travel with the panel. They FADE, quickly, in place: out as the panel
// leaves, in as the next one settles. (Move them too and they detach from the panel that
// is supposed to be carrying them.) The fade is short and the wait is long: a panel's
// clip runs ~667–1000 ms, and the contents are gone within a fifth of a second of the
// exit starting, and only appear once the arriving panel has all but landed.

/** How long the contents take to fade. Short — this is a flick, not a dissolve. */
export const FADE_MS = 180;

/**
 * The beat a LATE panel waits after the chrome has finished landing before it fades in.
 * Some contents are not part of the panel's furniture but of what the panel is FOR — the map
 * list, the details of the map you picked. Those read as the screen filling itself in, which
 * only happens once the screen is there: the chrome settles, a breath, then the contents.
 */
export const LATE_PANEL_DELAY_MS = 140;

/** Cubic ease, so the fade starts and ends soft instead of stepping. */
function easeInOut(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export type PanelDirection = "in" | "out";

/**
 * Fade a screen's panel contents out ("out") or in ("in") across `durationMs` — the length
 * of the chrome clip they belong to, so the two stay in step at both ends.
 *
 * The fade itself only takes FADE_MS of that window. Going out it happens FIRST (the
 * contents vanish, then the empty panel slides away); coming in it happens LAST (the panel
 * arrives, then its contents appear on it). The promise resolves at the end of the full
 * window, not the end of the fade, so the caller's teardown still lines up with the chrome.
 */
export function fadePanels(
  panels: HTMLElement[],
  dir: PanelDirection,
  durationMs: number,
): Promise<void> {
  const window = Math.max(durationMs, FADE_MS);
  const fade = Math.min(FADE_MS, window);
  // Where in the window the fade sits: at the very start going out, at the very end coming in.
  const start = dir === "out" ? 0 : window - fade;

  const alphaAt = (t: number): number => {
    const p = Math.min(1, Math.max(0, (t - start) / fade));
    const k = easeInOut(p);
    return dir === "out" ? 1 - k : k;
  };
  const apply = (t: number): void => {
    const a = alphaAt(t);
    for (const el of panels) el.style.opacity = a >= 1 ? "" : String(a);
  };

  // Put the start state up NOW, in this same task: an arriving screen must never paint even
  // one frame at full opacity before its entrance begins.
  apply(0);
  if (!panels.length) return Promise.resolve();

  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = now - t0;
      apply(t);
      if (t < window) requestAnimationFrame(step);
      else { apply(window); resolve(); } // land exactly on the end state
    };
    requestAnimationFrame(step);
  });
}
