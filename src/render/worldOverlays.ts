import { worldLayer } from "../ui/stage";

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

// A floating status bar drawn above a unit: a hero level badge (left), an HP bar,
// and a mana bar below it (for units with mana). Pooled, one per visible unit, so
// bars are always on screen (WC3's "always show health bars"). The bars are single
// solid fills — WC3's floating bars read as one continuous bar, not visible slices.
interface HpBar {
  root: HTMLDivElement;
  bars: HTMLDivElement;
  level: HTMLDivElement;
  hp: HTMLDivElement;
  manaTrack: HTMLDivElement;
  mana: HTMLDivElement;
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
  mana.className = "unit-hpbar-mana";
  manaTrack.appendChild(mana);
  bars.append(hpTrack, manaTrack);
  root.append(level, bars);
  // Into the world layer, whose box IS the canvas's — the bar's position is computed in
  // canvas CSS pixels, so parenting it to the window instead offsets every bar by the
  // letterbox (see ui/stage.ts).
  layer.appendChild(root);
  return { root, bars, level, hp, manaTrack, mana };
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

  /** CSS px per device px, for turning GL coordinates back into layout ones. */
  private dpr(): number {
    return this.host.canvas.width / this.host.canvas.clientWidth || 1;
  }

  /**
   * Project a world point plus a point one `radius` "above" it, and return the screen
   * position with the foreshortened radius in CSS pixels — how far above the base to
   * float an overlay and how wide to draw it, so both track zoom. Null when the point
   * is off-screen (the caller draws nothing, and consumes no pool slot).
   */
  private project(x: number, y: number, z: number, radius: number): { sx: number; sy: number; ry: number; h: number; dpr: number } | null {
    const viewport = this.host.viewport();
    const dpr = this.dpr();
    const w = this.host.canvas.width;
    const h = this.host.canvas.height;
    this.world[0] = x;
    this.world[1] = y;
    this.world[2] = z;
    this.host.camera.worldToScreen(this.screen, this.world, viewport);
    const sx = this.screen[0];
    const sy = this.screen[1];
    if (sx < 0 || sx > w || sy < 0 || sy > h) return null;
    this.world2.set(this.world);
    this.world2[1] = y + radius;
    this.host.camera.worldToScreen(this.screen2, this.world2, viewport);
    const ry = Math.max(MIN_RING_PX / 2, Math.hypot(this.screen2[0] - sx, this.screen2[1] - sy) / dpr);
    return { sx, sy, ry, h, dpr };
  }

  /** Draw one status bar per spec, in order, and hide the rest of the pool. */
  syncBars(specs: readonly BarSpec[]): void {
    let n = 0;
    for (const s of specs) {
      const p = this.project(s.x, s.y, s.z, s.selRadius);
      if (!p) continue;
      const bar = this.hpBars[n] ?? (this.hpBars[n] = makeHpBar(worldLayer()));
      n++;
      bar.hp.style.width = `${s.hpFrac * 100}%`;
      // WC3 tints the bar green→yellow→red by HP fraction (own, ally, and enemy
      // alike — the floating bars aren't team-coloured). CSS adds the vertical sheen.
      bar.hp.style.backgroundColor = s.hpFrac > 0.6 ? "#3fbf46" : s.hpFrac > 0.3 ? "#d6b93b" : "#c8402f";
      // Mana bar (units/heroes with a mana pool).
      if (s.manaFrac !== null) {
        bar.manaTrack.hidden = false;
        bar.mana.style.width = `${s.manaFrac * 100}%`;
      } else {
        bar.manaTrack.hidden = true;
      }
      // Hero level badge to the left of the bars.
      if (s.level !== null) {
        bar.level.hidden = false;
        bar.level.textContent = String(s.level);
      } else {
        bar.level.hidden = true;
      }
      bar.root.hidden = false;
      // Bar width tracks the unit/building on-screen size (≈ its footprint).
      // Heroes get a wider bar (and a higher floor/ceiling) so their HP + mana
      // read clearly and stand out from regular units.
      const barW = s.isHero
        ? Math.max(46, Math.min(210, p.ry * 3))
        : Math.max(30, Math.min(170, p.ry * 2.4));
      bar.bars.style.width = `${barW}px`;
      bar.root.style.left = `${p.sx / p.dpr}px`;
      bar.root.style.top = `${(p.h - p.sy) / p.dpr - (p.ry + 24)}px`; // gl y-up → css y-down (floats above the unit)
    }
    for (let k = n; k < this.hpBars.length; k++) this.hpBars[k].root.hidden = true;
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
        div.style.color = l.color;
        div.textContent = l.text;
        root.appendChild(div);
      }
    }
    // Project the target's base, and a point one selection-radius above it, exactly
    // as the status bars do — so the slab floats at the same zoom-tracked height.
    const p = this.project(tip.x, tip.y, tip.z, tip.radius);
    if (!p) {
      root.hidden = true;
      return;
    }
    root.style.left = `${p.sx / p.dpr}px`;
    root.style.top = `${(p.h - p.sy) / p.dpr - (p.ry + 34)}px`; // just above the HP bar (ry + 24), which sits above the unit
    root.hidden = false;
  }

  /** Hide every bar without discarding the pool (the game is paused). */
  hideBars(): void {
    for (const b of this.hpBars) b.root.hidden = true;
  }

  dispose(): void {
    for (const b of this.hpBars) b.root.remove();
    this.hpBars = [];
    this.hoverTip?.remove();
    this.hoverTip = null;
  }
}
