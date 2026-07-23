import type { DataSource } from "../vfs/types";

// The game's own typeface (issue #72). Warcraft III renders every piece of text —
// menus, HUD, tooltips, floating text — in Friz Quadrata TT, which ships INSIDE the
// archives as `Fonts\FRIZQT__.TTF` (verified in War3.mpq; the name also appears
// verbatim in the Game.dll string dump next to the CFrame/CSimpleFrame UI classes,
// docs/reverse-engineering/game-dll-thread.md). We ship no Blizzard assets, so the
// face is read from the player's own mounted install at runtime like every other
// asset, and registered with the FontFace API.
//
// Friz Quadrata TT is a LATIN face — 252 glyphs, read straight off its cmap: full
// ASCII + Latin-1, but zero Cyrillic, Greek, Hebrew, Arabic or CJK. So English text
// gets the authentic face and anything it can't draw falls through, per glyph, to
// the next family in the stack. That fallback is two-tiered, and the first tier is
// also the game's own: `Fonts\NIM_____.ttf` (Nimrod MT, 659 glyphs) covers Latin
// Extended-A, Greek and Cyrillic — the localized WC3 releases' face. Only past that
// do we reach our bundled Nowar Sans (public/fonts, OFL) for CJK and the rest.

/** Family names we register the archives' faces under (their real internal names). */
const FRIZ = "Friz Quadrata TT";
const NIMROD = "Nimrod MT";

/** Where the two faces live in the archives. Case/slash-insensitive at the VFS. */
const FONT_FILES: ReadonlyArray<{ family: string; path: string }> = [
  { family: FRIZ, path: "Fonts\\FRIZQT__.TTF" },
  { family: NIMROD, path: "Fonts\\NIM_____.ttf" },
];

/** Tail of the stack: our bundled multi-language face, then whatever the OS has.
 *  Kept in step with the `--game-font` declaration in style.css. */
const FALLBACK = '"Nowar Sans", "Trebuchet MS", system-ui, sans-serif';

let stack = `"${FRIZ}", ${FALLBACK}`;

/** The current font stack — the archives' faces first, fallbacks behind them.
 *  For canvas `ctx.font`, which can't resolve the `--game-font` CSS variable. */
export function gameFontStack(): string {
  return stack;
}

// The archives' faces load ASYNCHRONOUSLY (FontFace.load() is a promise), but the menus are
// built the instant applyGameFont() fires — the gate hands off to the main menu in the same
// task. So the first render happens with the face still decoding, and two things capture the
// fallback in a way that does NOT self-heal when Friz Quadrata arrives a moment later:
//   • CANVAS text (a map-list count badge) is a baked bitmap, not live CSS.
//   • An FDF TEXT frame's WIDTH is measured off a canvas at layout time (render.ts) — so a
//     label laid out before the face loaded keeps fallback metrics until the next rebuild.
// DOM glyphs re-render on their own (font-family is live), but the layout around them stays
// wrong. That is exactly "the labels are using a fallback font" (issue #82) in the timing
// window where it can happen. So callers that bake the font subscribe here and redo their
// work once the real faces are in — a mounted FDF screen relayouts, the badge cache clears.
let ready = false;
const readyListeners = new Set<() => void>();

/** Whether the archives' faces have finished loading (or there were none to load). Text baked
 *  before this — canvas, measured layout widths — used the fallback and should be redone. */
export function gameFontsReady(): boolean {
  return ready;
}

/** Run `cb` once the archives' faces are loaded: immediately if they already are, otherwise
 *  when they land. Returns an unsubscribe. Used to relayout/redraw anything that captured the
 *  fallback during the async load window (see the note above). */
export function onGameFontsReady(cb: () => void): () => void {
  if (ready) {
    cb();
    return () => {};
  }
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

function markReady(): void {
  if (ready) return;
  ready = true;
  for (const cb of [...readyListeners]) cb();
  readyListeners.clear();
}

/**
 * Register Warcraft III's own faces from the mounted install and make them the
 * game font. Safe to call without them: a locally-installed Friz Quadrata still
 * matches by family name, and Nowar Sans backs everything up either way.
 */
export function applyGameFont(vfs: DataSource): void {
  if (typeof FontFace === "undefined") {
    markReady(); // no FontFace API — the CSS fallback stack is all there will ever be
    return;
  }
  const loaded: string[] = [];
  const pending: Array<Promise<unknown>> = [];
  for (const { family, path } of FONT_FILES) {
    const bytes = vfs.rawBytes(path);
    if (!bytes) continue;
    try {
      // Copy into a plain ArrayBuffer — the VFS hands back a view into the archive's
      // buffer, and FontFace takes the WHOLE buffer, not the view's slice.
      const face = new FontFace(family, bytes.slice().buffer as ArrayBuffer);
      pending.push(
        face.load().then(
          (f) => { document.fonts.add(f); },
          (err: unknown) => { console.warn(`[OpenWar3] font ${path} failed to load:`, err); },
        ),
      );
      loaded.push(family);
    } catch (err) {
      console.warn(`[OpenWar3] font ${path} rejected:`, err);
    }
  }
  // Names first even when a file was missing: the player may have the face installed.
  const families = loaded.length ? loaded : [FRIZ];
  stack = `${families.map((f) => `"${f}"`).join(", ")}, ${FALLBACK}`;
  const root = document.documentElement.style;
  root.setProperty("--game-font", stack);
  root.setProperty("--ui-font", stack); // the glue menus use the same face in the real game
  // Signal readiness once every face has settled (loaded OR failed — a failure just means the
  // fallback is final for that slot, which is still a stable answer to render against). Nothing
  // to wait for → ready now, so a screen mounted with no archive faces doesn't hang on a relayout.
  if (pending.length) void Promise.allSettled(pending).then(markReady);
  else markReady();
}
