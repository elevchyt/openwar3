// "Is a modal up?" — asked in one place, by everything that listens to the keyboard.
//
// OpenWar3 has two families of modal and they put up two different scrims: the IN-GAME dialogs
// (`fdf-dialog-scrim` — the F10 menu, Allies, Messaging, the Quest log, a script's own dialog)
// and the GLUE ones (`glue-dialog-scrim` — the game's message box, Join Server, the update
// prompt). Both mean the same thing to a key handler, and a handler that knows about one of them
// is a handler that will be wrong the first time it meets the other.
//
// It is written as a DOM question rather than a flag somebody sets, because the scrim is what
// every one of those panels already puts up: a new modal is covered by this the moment it exists,
// with nothing to remember to register.

const SCRIMS = ".fdf-dialog-scrim, .glue-dialog-scrim";

// The same question as two LIVE collections, because the game asks it every frame (the camera
// does not move under a panel). `querySelector` with a selector LIST misses the browser's
// single-class fast path and matches every element against both selectors: measured on a match's
// 5,700-node document, 115 µs a call — 2.3% of all CPU in a profile of Bleach vs One Piece — where
// a live `getElementsByClassName` collection the browser keeps current answers in under 1 µs.
const fdfScrims = typeof document === "undefined" ? null : document.getElementsByClassName("fdf-dialog-scrim");
const glueScrims = typeof document === "undefined" ? null : document.getElementsByClassName("glue-dialog-scrim");

/** Anything modal on screen at all. What the GAME asks — the world underneath a panel takes no
 *  commands, and its camera does not move. */
export const anyModalOpen = (): boolean => (fdfScrims?.length ?? 0) > 0 || (glueScrims?.length ?? 0) > 0;

/**
 * A modal over THIS element — a scrim that does not contain it.
 *
 * What a SCREEN asks, because a screen mounted inside a scrim IS the modal and has to keep its
 * own keys. Every scrim is asked and not just the first, so a dialog raised from another dialog
 * does not un-gate the screen at the bottom.
 */
export function modalOver(el: Element): boolean {
  for (const scrim of document.querySelectorAll(SCRIMS)) {
    if (!scrim.contains(el)) return true;
  }
  return false;
}
