// The desktop app's frame-rate cap.
//
// The desktop shell launches Chromium with vsync OFF and its frame-rate limit OFF
// (electron/main.mjs), because a vsynced page is at least a refresh behind the mouse and the
// DOM overlays that follow the pointer showed it. Off, requestAnimationFrame stops meaning "once
// per refresh" and fires back to back — measured at ~6,300 Hz on an empty WebGL page on the
// dev box — so every loop in the page, ours and the throwaway polls alike, would spin the GPU
// and a CPU core flat out drawing frames nobody can see.
//
// Chromium has no switch for "uncapped, but no faster than N", so the cap is kept HERE, and it is
// kept on requestAnimationFrame itself rather than in each loop: the page has half a dozen rAF
// loops (the match, the menu clock, the loading screen, the model viewers) and several one-off
// polls, and a cap each of them had to remember is a cap the next one forgets. Patched, every
// caller sees an ordinary display that happens to refresh at the shell's `maxFps`. Callbacks
// queued in the same interval run together on one real frame with one timestamp, which is
// exactly what a display's refresh does.
//
// The number is OURS, not the game's — WC3 1.30.4 has no frame-rate setting. It comes from the
// shell (`ow3native.maxFps`), so a browser tab, which keeps the browser's own vsync, is never
// patched at all.

/** Arm the cap if the desktop shell asked for one. Run as a side-effect import at the very top
 *  of main.ts, so it is in place before any module schedules a frame. */
function installFrameCap(): void {
  const maxFps = (window as unknown as { ow3native?: { maxFps?: number } }).ow3native?.maxFps;
  if (!maxFps || !(maxFps > 0)) return;

  const interval = 1000 / maxFps;
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);

  let nextId = 1;
  const queue = new Map<number, FrameRequestCallback>();
  /** When the next batch may run, on performance.now()'s clock. */
  let due = 0;
  let rafHandle = 0;
  let timer = 0;

  const run = (t: number): void => {
    rafHandle = 0;
    const now = performance.now();
    // Step the deadline by whole intervals so the average holds at the cap, but never let it
    // fall behind the clock — after a long frame the page gets the next frame promptly, not a
    // burst of catch-up frames.
    due = Math.max(due + interval, now);
    const batch = [...queue];
    queue.clear();
    for (const [, cb] of batch) {
      try {
        cb(t);
      } catch (err) {
        // One throwing callback must not swallow the rest of the frame, as it would not in the
        // browser's own rAF either.
        setTimeout(() => {
          throw err;
        });
      }
    }
    if (queue.size) schedule();
  };

  // Every real frame asked for RUNS the batch; the wait before the deadline is a timer, never a
  // real frame that goes unused. That is not tidiness: with the limit off, Chromium follows a
  // frame that drew nothing with a ~16 ms pause before the next (measured on a bare WebGL page),
  // so a cap that polled real frames until one was due held the game at ~110 fps, not 300. A
  // timer armed from a frame callback is not a nested timer, so it is not clamped to 4 ms.
  const schedule = (): void => {
    if (rafHandle || timer) return;
    const wait = due - performance.now();
    if (wait > 0.5) {
      timer = window.setTimeout(() => {
        timer = 0;
        rafHandle = realRaf(run);
      }, wait);
    } else {
      rafHandle = realRaf(run);
    }
  };

  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    queue.set(id, cb);
    schedule();
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    queue.delete(id);
    if (queue.size) return;
    if (rafHandle) realCancel(rafHandle);
    if (timer) clearTimeout(timer);
    rafHandle = timer = 0;
  };
}

installFrameCap();
