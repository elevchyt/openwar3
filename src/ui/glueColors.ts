// Colours the glue screens compose text in — a LEAF module, imported by everything and importing
// nothing.
//
// That is the whole point of it. `LABEL_GOLD` lived on `fdfLan.ts`, which is a SCREEN: the Join
// Server dialog needed the colour, `fdfLan` needed the dialog, and those two imports closed a
// circle. Vite's dev server does not care — native ESM evaluates each module on its own and the
// live binding is there by the time anybody reads it — but Rollup has to pick ONE order for a
// bundle, and the order it picked left the constant in its temporal dead zone when the game
// lobby's chat line asked for it. The whole screen threw, the screen before it was never
// disposed, and the two were drawn on top of each other. It happened only in a BUILT artifact,
// which is the worst place for a bug to be visible first (`tools/import-cycle-test.mjs` now
// fails on any cycle, in dev, for this reason).
//
// So a constant that several screens share belongs somewhere none of them can point back to.

/** The gold every label on the glue screens is set in — `StandardLabelTextTemplate`'s FontColor
 *  0.99 0.827 0.0705, as a WC3 colour code. A list's rows are white by default, so a row that
 *  wants to match its captions has to say so. */
export const LABEL_GOLD = "fcd312";
