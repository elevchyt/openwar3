// Glue-screen panel animation (issue #61). Between menus, each panel of a WC3 glue
// screen leaves the screen UPWARDS and the next screen's panels arrive by coming back
// DOWN — an overshooting, springy motion, i.e. easeInOutElastic (easings.net). The
// panel CHROME is animated by the game itself (the sprite-layer MDX carries a
// "<Screen> Birth/Death" clip per screen — see render/menuScene.ts); these are the DOM
// widgets that ride on top of it, so they run over the same window as those clips.

/** easeInOutElastic — https://easings.net/#easeInOutElastic. */
export function easeInOutElastic(x: number): number {
  const c5 = (2 * Math.PI) / 4.5;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x < 0.5
    ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
    : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1;
}

export type PanelDirection = "in" | "out";

/**
 * Slide `panels` off the top of the screen ("out") or back down into place ("in").
 *
 * "in" is the SAME curve played backwards, which is what the reference does — not a
 * separate ease. Each panel travels only as far as IT needs to clear the top edge
 * (its own bottom edge to y=0), so a tall panel and a short one both just leave, and
 * they read as one motion rather than a synchronised block slide.
 */
export function slidePanels(
  panels: HTMLElement[],
  dir: PanelDirection,
  durationMs: number,
): Promise<void> {
  // Distance for each panel: enough to lift its bottom edge past the top of the screen.
  // Measured with the transform CLEARED — an incoming panel is parked off-screen when we
  // get here, and its parked rect would give a travel distance to nowhere.
  const travel = panels.map((el) => {
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    return -(r.bottom + 8); // +8px so the drop shadow leaves with it
  });

  // "out" runs the curve forwards; "in" is the same curve in reverse time, so a round trip
  // springs the same way either way — the reference's "same animation in reverse".
  const at = (p: number): number => easeInOutElastic(dir === "out" ? p : 1 - p);
  const apply = (p: number): void => {
    const k = at(p);
    for (let i = 0; i < panels.length; i++) {
      panels[i].style.transform = k === 0 ? "" : `translateY(${travel[i] * k}px)`;
    }
  };

  // Put the start state up NOW, in this same task, so an incoming screen never paints for
  // one frame in its landed position before jumping off-screen to begin its entrance.
  apply(0);
  if (!panels.length || durationMs <= 0) { apply(1); return Promise.resolve(); }

  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / durationMs);
      apply(p);
      if (p < 1) requestAnimationFrame(step);
      else { apply(1); resolve(); } // land exactly on the end state (apply drops the
      // transform entirely when the panel is home, so a later relayout isn't fighting a
      // stale translate)
    };
    requestAnimationFrame(step);
  });
}
