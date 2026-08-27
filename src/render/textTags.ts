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
//   • `size` and the velocity are screen-relative. Blizzard.j says so itself:
//         TextTagSize2Height:    size * 0.023 / 10       (font size 10 → height 0.023)
//         TextTagSpeed2Velocity: speed * 0.071 / 128     ("Screen-relative speeds are
//                                                          hard to grasp.")
//     So a rising damage number climbs the SCREEN at a steady rate; it does not travel
//     north through the world and shrink into the distance.
//
//     Screen-relative here means the **0..1 screen**, NOT the 0.8×0.6 box the FDF panels
//     are laid out in — a tag of height 1.0 fills the screen top to bottom. Reading these
//     in the FDF space instead is a silent 1/0.6 = 1.67× everywhere, which is exactly what
//     made a "+400" over a hero read like a headline (issue #120). See `ctx.uiScale`.
//
// Drawn as DOM over the canvas (like the HUD and the FDF screens) rather than as a GL
// pass: the text is crisp at any zoom, WC3's |cAARRGGBB| colour codes come for free from
// ui/wc3Text, and a text tag is always on top of the world anyway — it has no depth.

import type { TextTagObj } from "../jass/runtime";
import { MISC_UI, TEXT_TAG } from "../data/gameplayConstants";
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
  /** CSS px per unit of the 0..1 SCREEN — i.e. the viewport height — which is the scale a
   *  tag's height and drift are expressed in (see the header). Not the FDF panels' 0.8×0.6
   *  scale; a tag is not a frame. */
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
      // The engine's OWN combat text is the exception, and centres (TextTagObj.centered).
      const centre = tt.centered ? " translateX(-50%)" : "";
      el.style.transform = `translate(${p.x + dx}px, ${p.y - dy}px) translateY(-100%)${centre}`;
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

/**
 * The ENGINE's own floating combat text, as opposed to the script's `texttag`s above.
 *
 * WC3 raises two of these off its combat resolution, with no trigger anywhere in sight — the
 * red "127!" a Critical Strike leaves over the unit it struck, and the "!" a deny leaves in
 * the dead unit's owner colour (see `CombatText` in src/sim/world.ts). They are the same KIND
 * of object as a script's text tag and are drawn by the same overlay; what differs is who
 * owns them. So this holds them in the identical `TextTagObj` shape, ages them by the same
 * rule `Runtime.advanceTextTags` uses, and hands the list to `TextTagOverlay.update` merged
 * with the script's — which is also why a melee match, where no script is listening and
 * `rt.textTags` is empty forever, still shows a Blademaster's crits.
 *
 * Handle ids are NEGATIVE. The overlay keys its live elements by `handleId` and the JASS
 * handle pool only ever mints positives, so the two namespaces cannot collide.
 */
export class CombatTextTags {
  private tags: TextTagObj[] = [];
  private nextId = -1;

  /** Raise one piece of combat text over a world point. `followUnit` (> 0) makes it ride the
   *  unit, which is what a crit number does; a deny's victim is already dead, so it stays put.
   *  `style` is the kind's own spec where the game keeps one (GOLD_TEXT_STYLE); omitted, the
   *  tag takes the crit look every kind used to share. */
  spawn(t: {
    text: string; color: number; x: number; y: number; z: number; followUnit: number;
    style?: CombatTextStyle;
  }): void {
    // A brawl can raise these faster than they expire; cap the list rather than let a
    // long-running match accumulate DOM for text nobody is reading.
    if (this.tags.length >= MAX_COMBAT_TAGS) this.tags.splice(0, this.tags.length - MAX_COMBAT_TAGS + 1);
    const st = t.style ?? CRIT_TEXT_STYLE;
    this.tags.push({
      handleId: this.nextId--,
      text: t.text,
      x: t.x,
      y: t.y,
      z: t.z,
      size: st.height,
      color: t.color,
      visible: true,
      permanent: false,
      lifespan: st.lifetime,
      fadepoint: st.fadeStart,
      age: 0,
      velX: 0,
      velY: st.rise,
      offsetX: 0,
      offsetY: 0,
      suspended: false,
      followUnit: t.followUnit > 0 ? t.followUnit : -1,
      dead: false,
      centered: true, // the client centres a crit number over the unit's head
    });
  }

  /** Age and retire, off the SIM clock — so a paused game leaves the numbers hanging exactly
   *  where they are, the same contract `Runtime.advanceTextTags` keeps for a script's tags. */
  advance(dt: number): void {
    for (let i = this.tags.length - 1; i >= 0; i--) {
      const tt = this.tags[i];
      tt.age += dt;
      tt.offsetY += tt.velY * dt;
      if (tt.age >= tt.lifespan) this.tags.splice(i, 1);
    }
  }

  /** The live tags, for merging into the overlay's frame. */
  get live(): ReadonlyArray<TextTagObj> {
    return this.tags;
  }

  /** How many are up right now — the session performance log's census (src/dev/perfLog.ts). */
  get count(): number {
    return this.tags.length;
  }

  clear(): void {
    this.tags = [];
  }
}

/** How one KIND of engine text tag looks and behaves. The game keeps a row of exactly these
 *  four per kind — `<Kind>TextHeight` in UI\MiscUI.txt, `<Kind>TextVelocity` /
 *  `<Kind>TextLifetime` / `<Kind>TextFadeStart` in UI\MiscData.txt — so this mirrors the row
 *  rather than inventing a shape. All screen-relative, in the 0..1 screen (see the header). */
export interface CombatTextStyle {
  /** Font height as a fraction of the screen. */
  height: number;
  /** Screen heights per second, upward. */
  rise: number;
  /** Seconds on screen. */
  lifetime: number;
  /** …after which it fades to nothing at `lifetime`. */
  fadeStart: number;
}

/** The "+N" the engine floats when it CREDITS a player gold — a shop buying an item back
 *  (issue #120), Transmute's payout. Straight off the game's own `GoldText*` row; nothing
 *  here is by eye. Note it is a slower, longer-lived tag than a crit: two seconds with the
 *  last one fading, drifting up at 0.03 screens/sec. */
export const GOLD_TEXT_STYLE: CombatTextStyle = {
  height: MISC_UI.GoldTextHeight,
  rise: TEXT_TAG.GoldTextVelocity[1],
  lifetime: TEXT_TAG.GoldTextLifetime,
  fadeStart: TEXT_TAG.GoldTextFadeStart,
};

/** The same credit for the other resource — a worker laying a load of wood down, a Wisp paid
 *  in the tree it is working. Identical timing to the gold one; the colour is what tells them
 *  apart (`LumberTextColor`, green — see TEXT_TAG). */
export const LUMBER_TEXT_STYLE: CombatTextStyle = {
  height: MISC_UI.LumberTextHeight,
  rise: TEXT_TAG.LumberTextVelocity[1],
  lifetime: TEXT_TAG.LumberTextLifetime,
  fadeStart: TEXT_TAG.LumberTextFadeStart,
};

/** A slain creep's payout (issue #116). The same gold and the same drift as a plain credit,
 *  the same height as every other tag in the file (0.024) — but three seconds with the last
 *  one fading, where a credit gets two. A bounty is raised in the middle of a fight and has
 *  to survive it; a shop's buy-back is raised while you stand there reading it. */
export const BOUNTY_TEXT_STYLE: CombatTextStyle = {
  height: MISC_UI.BountyTextHeight,
  rise: TEXT_TAG.BountyTextVelocity[1],
  lifetime: TEXT_TAG.BountyTextLifetime,
  fadeStart: TEXT_TAG.BountyTextFadeStart,
};

/** The experience a kill hands a hero (issue #116) — the ONE tag here with no row behind it.
 *
 * 1.30.4, the client this project targets, floats no XP number at all: it arrived with
 * Reforged ("since the reforged update whenever an enemy unit dies in range for a hero to get
 * experience there is a floating text with the number of experience gained next to the hero"
 * — hiveworkshop.com/threads/321881, Jan 2020), and `UI\MiscData.txt` in 1.30.4 accordingly
 * has GoldText/LumberText/BountyText/MissText/CriticalStrikeText/ShadowStrikeText/ManaBurnText/
 * BashText and nothing for XP. So this row is BORROWED, not transcribed: it is the bounty's
 * spec (it is raised by the same event, and has to outlive the same fight) at the same 0.024
 * height as every other tag, wearing the violet the Reforged client shows. Swap it for the
 * real values the day a client that ships them is readable. */
export const XP_TEXT_STYLE: CombatTextStyle = {
  height: MISC_UI.BountyTextHeight,
  rise: TEXT_TAG.BountyTextVelocity[1],
  lifetime: TEXT_TAG.BountyTextLifetime,
  fadeStart: TEXT_TAG.BountyTextFadeStart,
};

// The crit/deny look, in Blizzard.j's own units so it reads the way the game states it
// (Blizzard.j 6086-6099): `TextTagSize2Height` scales a font SIZE linearly such that size 10
// is a screen height of 0.023, and `TextTagSpeed2Velocity` scales a SPEED such that 128 is
// 0.071. Size and speed are matched to the client's crit number by eye; the conversions are
// the game's. (`CriticalStrikeText*` in the two Misc files is the real row for this one —
// height 0.024, five seconds, fading from two — and worth adopting the day the crit tag gets
// looked at properly; it is left alone here so a sizing fix does not silently retune combat.)
const CRIT_TEXT_STYLE: CombatTextStyle = {
  height: (10 * 0.023) / 10, // font size 10
  rise: (64 * 0.071) / 128, // speed 64, straight up
  lifetime: 1.2, // seconds on screen
  fadeStart: 0.6, // ...of which the last 0.6s fades out
};
const MAX_COMBAT_TAGS = 64;

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
