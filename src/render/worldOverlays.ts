import { worldLayer } from "../ui/stage";
import { wc3ToHtml } from "../ui/wc3Text";

// The floating world overlays: a status bar above every visible unit, and the hover
// slab under the cursor. Both are DOM, both live in the world layer (ui/stage.ts),
// and both are pure CLIENT (docs/multiplayer.md Phase B) — one machine's screen,
// never game state.
//
// This owns the DOM and the projection only. WHICH units get a bar, and WHAT the
// hover slab says, are questions about the world and about who is looking, so they
// stay with the controller and arrive here as plain data.

/** One line of a hover tooltip: its text and the colour WC3 draws it in. */
export interface HoverLine {
  text: string;
  color: string;
}

/** One unit's status bar, as the controller sees it: where it floats in the world
 *  and what the bars read. Presentation (tint, width, the level badge) is decided
 *  here, from these numbers. */
export interface BarSpec {
  x: number;
  y: number;
  z: number; // the unit's drawn base — for air units, their altitude
  selRadius: number; // world-space selection radius; sets the bar's width and float height
  hpFrac: number; // 0..1
  manaFrac: number | null; // null → no mana bar (unit has no mana pool)
  level: number | null; // null → no hero level badge
  isHero: boolean; // heroes get a wider bar
}

/** Where the hover slab floats and what it says. */
export interface HoverTip {
  x: number;
  y: number;
  z: number;
  radius: number;
  lines: HoverLine[];
}

/** The projection surface. `RtsHost` satisfies this structurally. */
export interface OverlayHost {
  readonly canvas: HTMLCanvasElement;
  readonly camera: {
    worldToScreen(out: Float32Array, v: Float32Array, viewport: Float32Array): Float32Array;
  };
  viewport(): Float32Array;
}

const MIN_RING_PX = 12; // don't let rings vanish when zoomed far out

// The bar's shape, measured off the real 1.27a client (Warcraft III/Screenshots, 1424×720).
//
// Its HEIGHT is fixed: a peasant's bar and a Town Hall's are both ~7px of frame there, only
// four times apart in width. Its WIDTH grows with how big the thing is on screen — 64px of
// fill for a peasant, 298px for a Town Hall — with the peasant's as the floor.
const STATBAR_H_FRAC = 7 / 720; // outer height, as a fraction of the viewport's
const STATBAR_MIN_H = 7; // …never below the client's own 5 rows of fill plus its frame
const STATBAR_W_FRAC = 64 / 1424; // the smallest bar's fill, as a fraction of the viewport's width
const STATBAR_MAX_W = 5; // × that, so a Town Hall's bar can reach the width the game gives it

// A floating status bar drawn above a unit: a hero level badge (left), an HP bar,
// and a mana bar below it (for units with mana). Pooled, one per visible unit, so
// bars are always on screen (WC3's "always show health bars").
//
// One bar is a black frame (the track) with the game's tinted fill slab clipped inside it
// to the fraction — see ui/hud.ts applyStatBarSkin for where the art comes from.
interface HpBar {
  root: HTMLDivElement;
  bars: HTMLDivElement;
  level: HTMLDivElement;
  hp: HTMLDivElement;
  manaTrack: HTMLDivElement;
  mana: HTMLDivElement;
  /** What this SLOT's DOM was last given, so syncBars can skip writes that change nothing.
   *  It describes the elements, not a unit — a pool slot is handed to whichever unit lands
   *  in it this frame, and the comparison is still exactly right. */
  last: {
    hpFrac: number;
    state: string;
    manaFrac: number | null;
    level: number | null;
    barW: number;
    barH: number;
    left: number;
    top: number;
    hidden: boolean;
  };
}

function makeHpBar(layer: HTMLElement): HpBar {
  const root = document.createElement("div");
  root.className = "unit-hpbar";
  root.hidden = true;
  const level = document.createElement("div");
  level.className = "unit-hpbar-level";
  const bars = document.createElement("div");
  bars.className = "unit-hpbar-bars";
  const hpTrack = document.createElement("div");
  hpTrack.className = "unit-hpbar-track";
  const hp = document.createElement("div");
  hp.className = "unit-hpbar-fill";
  hpTrack.appendChild(hp);
  const manaTrack = document.createElement("div");
  manaTrack.className = "unit-hpbar-track unit-hpbar-manatrack";
  const mana = document.createElement("div");
  mana.className = "unit-hpbar-fill unit-hpbar-mana";
  manaTrack.appendChild(mana);
  bars.append(hpTrack, manaTrack);
  root.append(level, bars);
  // Into the world layer, whose box IS the canvas's — the bar's position is computed in
  // canvas CSS pixels, so parenting it to the window instead offsets every bar by the
  // letterbox (see ui/stage.ts).
  layer.appendChild(root);
  return {
    root, bars, level, hp, manaTrack, mana,
    // NaN/undefined-ish seeds so the first sync writes everything; `hidden` matches the
    // element's actual initial state.
    last: { hpFrac: NaN, state: "", manaFrac: NaN, level: NaN, barW: NaN, barH: NaN, left: NaN, top: NaN, hidden: true },
  };
}

/** The hover slab element, into the same world layer as the HP bars so its position
 *  is written in canvas CSS pixels with no letterbox offset (see ui/stage.ts). Skinned
 *  by the human-tooltip-border nine-patch when a real install is mounted (the vars are
 *  lifted to `:root` by ui/hud.ts applyWidgetSkin); a plain placeholder otherwise. */
function makeHoverTip(layer: HTMLElement): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "unit-hover-tooltip";
  root.hidden = true;
  layer.appendChild(root);
  return root;
}

export class WorldOverlays {
  private hpBars: HpBar[] = []; // pool, one shown per visible unit each frame
  private hoverTip: HTMLDivElement | null = null;
  private hoverTipSig = ""; // caches the last rendered line set (rebuild the DOM only on change)

  // Scratch buffers for projection (own copies — the controller's are in use elsewhere).
  private world = new Float32Array(3);
  private world2 = new Float32Array(3);
  private screen = new Float32Array(2);
  private screen2 = new Float32Array(2);

  constructor(private host: OverlayHost) {}

  /**
   * The canvas geometry every projection this frame shares.
   *
   * `clientWidth`/`clientHeight` are LAYOUT reads, and this class writes layout — a bar's
   * `left`/`top`/`width` — between them. Read per unit, as this used to be, each one flushes
   * the style changes the previous unit just made and forces a synchronous reflow, so a
   * 250-unit army paid 250 reflows a frame to learn a number that cannot change mid-frame.
   * Sampled once per `syncBars` instead.
   */
  private frameGeom = { dpr: 1, w: 0, h: 0, clientW: 0, clientH: 0, viewport: new Float32Array(4) as Float32Array };

  private sampleGeom(): void {
    const canvas = this.host.canvas;
    const g = this.frameGeom;
    g.w = canvas.width;
    g.h = canvas.height;
    g.clientW = canvas.clientWidth;
    g.clientH = canvas.clientHeight;
    g.dpr = g.w / g.clientW || 1;
    g.viewport = this.host.viewport();
  }

  // `project` writes here instead of returning a fresh object: at one bar per unit per frame
  // the allocation is the cost, not the arithmetic.
  private proj = { sx: 0, sy: 0, ry: 0 };

  /**
   * Project a world point plus a point one `radius` "above" it into `this.proj`: the screen
   * position with the foreshortened radius in CSS pixels — how far above the base to float an
   * overlay and how wide to draw it, so both track zoom. False when the point is off-screen
   * (the caller draws nothing, and consumes no pool slot). Reads `frameGeom`, so
   * `sampleGeom()` must have run this frame.
   */
  private project(x: number, y: number, z: number, radius: number): boolean {
    const g = this.frameGeom;
    this.world[0] = x;
    this.world[1] = y;
    this.world[2] = z;
    this.host.camera.worldToScreen(this.screen, this.world, g.viewport);
    const sx = this.screen[0];
    const sy = this.screen[1];
    if (sx < 0 || sx > g.w || sy < 0 || sy > g.h) return false;
    this.world2.set(this.world);
    this.world2[1] = y + radius;
    this.host.camera.worldToScreen(this.screen2, this.world2, g.viewport);
    this.proj.sx = sx;
    this.proj.sy = sy;
    this.proj.ry = Math.max(MIN_RING_PX / 2, Math.hypot(this.screen2[0] - sx, this.screen2[1] - sy) / g.dpr);
    return true;
  }

  /**
   * Draw one status bar per spec, in order, and hide the rest of the pool.
   *
   * This runs over every visible unit every frame, so it is written to touch the DOM only
   * where something actually changed. A style assignment is not free even when the value is
   * identical — it re-parses the value and dirties the element — and a 250-unit army meant
   * ~2,500 of them a frame, for bars whose fill and level had not moved since the last one.
   * Each bar therefore remembers what it was last given (`HpBar.last`).
   */
  syncBars(specs: readonly BarSpec[]): void {
    this.sampleGeom();
    const g = this.frameGeom;
    // Frame-constant, not unit-constant: the bar's floor width and its fixed height come from
    // the viewport, which cannot change while this loop runs.
    const minW = g.clientW * STATBAR_W_FRAC;
    const maxW = minW * STATBAR_MAX_W;
    const barH = Math.max(STATBAR_MIN_H, Math.round(g.clientH * STATBAR_H_FRAC));

    let n = 0;
    for (const s of specs) {
      if (!this.project(s.x, s.y, s.z, s.selRadius)) continue;
      const p = this.proj;
      const bar = this.hpBars[n] ?? (this.hpBars[n] = makeHpBar(worldLayer()));
      n++;
      const last = bar.last;

      if (last.hpFrac !== s.hpFrac) {
        last.hpFrac = s.hpFrac;
        bar.hp.style.width = `${s.hpFrac * 100}%`;
        // WC3 tints the bar green→yellow→red by HP fraction (own, ally, and enemy
        // alike — the floating bars aren't team-coloured). The tint is baked into the
        // fill art, so the state picks an image rather than a colour.
        const state = s.hpFrac > 0.6 ? "green" : s.hpFrac > 0.3 ? "yellow" : "red";
        if (last.state !== state) {
          last.state = state;
          bar.hp.dataset.state = state;
        }
      }
      // Mana bar (units/heroes with a mana pool). 1.27a floats no mana bar of its own,
      // so it has no mana art either — the game builds one out of the SAME textures under
      // a blue geoset colour (war3skins.txt points SimpleManaBarConsole at the health
      // fill, and ManaBarConsoleSmall.mdx is HPBarConsoleSmall.mdx in blue), and so do we.
      if (last.manaFrac !== s.manaFrac) {
        last.manaFrac = s.manaFrac;
        if (s.manaFrac !== null) {
          bar.manaTrack.hidden = false;
          bar.mana.style.width = `${s.manaFrac * 100}%`;
        } else {
          bar.manaTrack.hidden = true;
        }
      }
      // Hero level badge to the left of the bars.
      if (last.level !== s.level) {
        last.level = s.level;
        if (s.level !== null) {
          bar.level.hidden = false;
          bar.level.textContent = String(s.level);
        } else {
          bar.level.hidden = true;
        }
      }
      if (last.hidden) {
        last.hidden = false;
        bar.root.hidden = false;
      }
      // Bar width tracks the unit/building on-screen size (≈ its footprint), floored at the
      // width the game gives its smallest units. Heroes get a wider one so their HP + mana
      // stand out (1.27a floats neither, so there is nothing to match here).
      const barW = s.isHero
        ? Math.max(minW * 1.25, Math.min(maxW, p.ry * 3))
        : Math.max(minW, Math.min(maxW, p.ry * 2.4));
      if (last.barW !== barW || last.barH !== barH) {
        last.barW = barW;
        last.barH = barH;
        bar.bars.style.width = `${barW}px`;
        // The fill art is stretched across the WHOLE bar and clipped by the fraction, so its
        // shading stays put as the bar drains instead of squashing along with it.
        bar.bars.style.setProperty("--statbar-w", `${barW}px`);
        bar.bars.style.setProperty("--statbar-h", `${barH}px`);
      }
      // gl y-up → css y-down (floats above the unit). Rounded to whole CSS pixels: the bar
      // cannot be drawn at a finer grain than that, and rounding is what lets a unit standing
      // still write nothing at all rather than jitter in the sub-pixel.
      const left = Math.round(p.sx / g.dpr);
      const top = Math.round((g.h - p.sy) / g.dpr - (p.ry + 24));
      if (last.left !== left) {
        last.left = left;
        bar.root.style.left = `${left}px`;
      }
      if (last.top !== top) {
        last.top = top;
        bar.root.style.top = `${top}px`;
      }
    }
    for (let k = n; k < this.hpBars.length; k++) {
      const bar = this.hpBars[k];
      if (!bar.last.hidden) {
        bar.last.hidden = true;
        bar.root.hidden = true;
      }
    }
  }

  /**
   * Float the hover slab above whatever the cursor is over, tracking it in canvas
   * space like the HP bars. Rebuilds the DOM only when the lines change (cached by
   * `hoverTipSig`); repositions every frame. Anchored bottom-centre a small gap above
   * the unit's HP bar so it only ever grows upward as the text gets taller.
   */
  syncHoverTip(tip: HoverTip | null): void {
    if (!tip) {
      if (this.hoverTip) this.hoverTip.hidden = true;
      this.hoverTipSig = "";
      return;
    }
    if (!this.hoverTip) this.hoverTip = makeHoverTip(worldLayer());
    const root = this.hoverTip;
    const sig = tip.lines.map((l) => `${l.color}${l.text}`).join("");
    if (sig !== this.hoverTipSig) {
      this.hoverTipSig = sig;
      root.replaceChildren();
      for (const l of tip.lines) {
        const div = document.createElement("div");
        div.className = "uht-line";
        div.style.color = l.color; // the line's DEFAULT colour…
        div.innerHTML = wc3ToHtml(l.text); // …which the text's own markup overrides, as in-game
        root.appendChild(div);
      }
    }
    // Project the target's base, and a point one selection-radius above it, exactly
    // as the status bars do — so the slab floats at the same zoom-tracked height.
    // One slab, so this samples the canvas geometry for itself rather than riding syncBars'.
    this.sampleGeom();
    if (!this.project(tip.x, tip.y, tip.z, tip.radius)) {
      root.hidden = true;
      return;
    }
    const p = this.proj;
    const g = this.frameGeom;
    root.style.left = `${p.sx / g.dpr}px`;
    root.style.top = `${(g.h - p.sy) / g.dpr - (p.ry + 34)}px`; // just above the HP bar (ry + 24), which sits above the unit
    root.hidden = false;
  }

  /** Hide every bar without discarding the pool (the game is paused). */
  hideBars(): void {
    for (const b of this.hpBars) {
      b.root.hidden = true;
      b.last.hidden = true; // …and the cache agrees, or syncBars would skip un-hiding them
    }
  }

  dispose(): void {
    for (const b of this.hpBars) b.root.remove();
    this.hpBars = [];
    this.hoverTip?.remove();
    this.hoverTip = null;
  }
}
