// Floating text — the world-space text pass (Phase 7.19 — issue #33; see docs/triggers.md).
//
// WC3's `texttag` is the "+15 gold" over a slain creep, the damage number, the
// "Creep Camp Cleared" banner — the one piece of trigger output that lives in the WORLD
// rather than in the HUD. The natives (CreateTextTag + its setters) have populated
// runtime.textTags since 7.6; this is what finally draws them.
//
// A tag is a world ANCHOR plus a SCREEN-SPACE drift, and mixing the two up is the whole
// trick (see the TextTagObj comment in src/jass/runtime.ts):
//   • x/y/z are world coordinates — the tag sticks to that spot on the ground (or to a
//     unit, via SetTextTagPosUnit) and pans/zooms with the camera;
//   • `size` and the velocity are screen-relative, in the same 0.8×0.6 space the FDF UI
//     uses. Blizzard.j says so itself:
//         TextTagSize2Height:    size * 0.023 / 10       (font size 10 → height 0.023)
//         TextTagSpeed2Velocity: speed * 0.071 / 128     ("Screen-relative speeds are
//                                                          hard to grasp.")
//     So a rising damage number climbs the SCREEN at a steady rate; it does not travel
//     north through the world and shrink into the distance.
//
// Drawn as DOM over the canvas (like the HUD and the FDF screens) rather than as a GL
// pass: the text is crisp at any zoom, WC3's |cAARRGGBB| colour codes come for free from
// ui/wc3Text, and a text tag is always on top of the world anyway — it has no depth.

import type { TextTagObj } from "../jass/runtime";
import { wc3ToHtml } from "../ui/wc3Text";

/** What the overlay needs from the engine each frame — kept as a plain interface so this
 *  file imports neither the renderer nor the sim (the same bridge-not-fork rule the
 *  interpreter follows). */
export interface TextTagContext {
  /** World point → CSS pixels from the container's top-left. Null when it's off-screen
   *  behind the camera (a tag anchored behind the eye must not be drawn in front of it). */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
  /** Terrain height at a world point — a tag's `z` is an offset ABOVE the ground. */
  groundHeight(x: number, y: number): number;
  /** A followed unit's live position + how far its body floats (SetTextTagPosUnit), or
   *  null once the unit is gone — WC3 keeps the tag at its last spot, so do we. */
  unitAt(simId: number): { x: number; y: number; flyHeight: number } | null;
  /** Is that spot lit for the local player? Text under the fog is hidden, like the units. */
  visible(x: number, y: number): boolean;
  /** CSS px per unit of the 0.8×0.6 UI space (viewport height / 0.6) — the scale that
   *  turns a tag's screen-relative size and drift into pixels. */
  uiScale: number;
}

/** One rendered tag: the element plus the last text we wrote into it (setting innerHTML
 *  every frame for every tag would re-parse markup 60×/s for nothing). */
interface Live {
  el: HTMLDivElement;
  text: string;
}

export class TextTagOverlay {
  private readonly root: HTMLDivElement;
  private readonly live = new Map<number, Live>(); // texttag handle id → its element

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "texttag-layer";
    parent.appendChild(this.root);
  }

  /** Reposition/restyle every live tag for this frame. Ageing, drift and expiry happen in
   *  the interpreter off the SIM tick (Runtime.advanceTextTags) — this runs on the RENDER
   *  clock and only reads, so a paused game leaves the text hanging exactly where it was. */
  update(tags: ReadonlyArray<TextTagObj>, ctx: TextTagContext): void {
    const seen = new Set<number>();

    for (const tt of tags) {
      if (tt.dead || !tt.visible || tt.suspended || !tt.text) continue;

      // Where the tag is anchored. A followed unit wins over the stored x/y (the unit
      // moves; SetTextTagPosUnit was a one-time call), and its `z` lifts off the unit's
      // own height so a tag over a gargoyle isn't left down on the grass.
      let { x, y } = tt;
      let base = 0;
      const u = tt.followUnit >= 0 ? ctx.unitAt(tt.followUnit) : null;
      if (u) {
        x = u.x;
        y = u.y;
        base = u.flyHeight;
      }
      if (!ctx.visible(x, y)) continue; // fogged — the text is hidden with the ground

      const p = ctx.project(x, y, ctx.groundHeight(x, y) + base + tt.z);
      if (!p) continue; // behind the camera

      const alpha = fadeAlpha(tt) * (((tt.color >>> 24) & 0xff) / 255);
      if (alpha <= 0.01) continue;

      seen.add(tt.handleId);
      let cell = this.live.get(tt.handleId);
      if (!cell) {
        const el = document.createElement("div");
        el.className = "texttag";
        this.root.appendChild(el);
        this.live.set(tt.handleId, (cell = { el, text: "" }));
      }
      if (cell.text !== tt.text) {
        cell.el.innerHTML = wc3ToHtml(tt.text);
        cell.text = tt.text;
      }

      // The drift is screen-relative and y is UP in that space, so it subtracts from a
      // y-down CSS offset — which is what makes a positive velocity float the text upward.
      const dx = tt.offsetX * ctx.uiScale;
      const dy = tt.offsetY * ctx.uiScale;
      const el = cell.el;
      // WC3 anchors a text tag at its BOTTOM-LEFT — the text grows right and up from the
      // point it was given. Every "centre my damage number" snippet in the wild subtracts
      // half its own width precisely because the engine does not, so we must not either.
      el.style.transform = `translate(${p.x + dx}px, ${p.y - dy}px) translateY(-100%)`;
      el.style.fontSize = `${Math.max(1, tt.size * ctx.uiScale)}px`;
      el.style.color = cssColor(tt.color);
      el.style.opacity = String(alpha);
    }

    // Drop anything that stopped being drawn this frame (destroyed, expired, suspended,
    // fogged, off-screen) — a hidden tag is not kept warm; it costs nothing to rebuild.
    for (const [id, cell] of this.live) {
      if (seen.has(id)) continue;
      cell.el.remove();
      this.live.delete(id);
    }
  }

  /** Tear every tag off the screen (a match ended / a new map loaded). */
  clear(): void {
    for (const cell of this.live.values()) cell.el.remove();
    this.live.clear();
  }

  dispose(): void {
    this.clear();
    this.root.remove();
  }
}

/** How opaque a tag is right now. A PERMANENT tag never fades. Otherwise it holds full
 *  strength until its fadepoint, then fades linearly to nothing at its lifespan — the
 *  classic SetTextTagLifespan(1.0)/SetTextTagFadepoint(0.5) pair gives half a second of
 *  solid text and half a second of fade. A fadepoint of 0 (the default) means no fade at
 *  all: the tag simply pops out when it expires. */
function fadeAlpha(tt: TextTagObj): number {
  if (tt.permanent || tt.fadepoint <= 0 || tt.lifespan <= tt.fadepoint) return 1;
  if (tt.age <= tt.fadepoint) return 1;
  return Math.max(0, 1 - (tt.age - tt.fadepoint) / (tt.lifespan - tt.fadepoint));
}

/** 0xAARRGGBB → an opaque CSS colour. Alpha is applied to the ELEMENT (so it also fades
 *  the text shadow), not baked into the colour, which is why it's dropped here. */
function cssColor(argb: number): string {
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}
