import type { DataSource } from "../../vfs/types";
import { blpToCanvas } from "../../render/blputil";
import { wc3ToHtml } from "../wc3Text";
import type { FdfFrame } from "./parser";
import { FdfLibrary, firstProp, strProp } from "./library";
import { fitBox, layout, toPixels, UI_HEIGHT, type LaidOutFrame } from "./layout";

// FDF → DOM renderer (issue #54). Builds the game's frames as absolutely-positioned
// DOM over the 3D background: BACKDROP as composited chrome from the real BLPs,
// TEXT with WC3 markup, and the button family (GLUETEXTBUTTON/GLUEBUTTON/TEXTBUTTON)
// with mouse-over / pushed states and shortcut keys. We ship no Blizzard assets —
// every texture is read from the user's own mounted install at runtime.

// The BackdropEdgeFile is one row of 8 square tiles. Determined empirically from the
// real GlueScreen-Button1-BackdropBorder.blp (256×32): tiles 0–3 are straight edge
// strips, 4–7 are the corners. These indices are tuned against the live render.
const EDGE_TILE = { L: 0, R: 1, T: 2, B: 3, UL: 4, UR: 5, LL: 6, LR: 7 };

/** Font stack for menu text — our own choice (we don't ship or require WC3's font). */
export const UI_FONT = '"Trajan Pro", "Cinzel", "Palatino Linotype", "Book Antiqua", Palatino, "Times New Roman", serif';

export interface FdfScreenHandlers {
  /** frameName → click handler. Also fired by the frame's ControlShortcutKey. */
  [frameName: string]: () => void;
}

export interface FdfScreenOptions {
  container: HTMLElement;
  vfs: DataSource;
  fdfPath: string;
  rootFrame: string;
  handlers?: FdfScreenHandlers;
  /** frameName → literal text, overriding the FDF (e.g. "Battle.net" → "Online"). */
  textOverrides?: Record<string, string>;
  /** Optional SPRITE frameName → BLP path, to draw a static stand-in for a 3D sprite. */
  sprites?: Record<string, string>;
  /** Frame names to skip (WC3's glue scripts hide these sub-panels initially). */
  hidden?: string[];
}

/** A mounted FDF screen: a full-viewport overlay that relayouts on resize. */
export interface FdfScreen {
  element: HTMLElement;
  relayout(): void;
  dispose(): void;
}

/** Parse `fdfPath`, resolve `rootFrame`, and build it into `container`. */
export async function mountFdfScreen(opts: FdfScreenOptions): Promise<FdfScreen> {
  const lib = new FdfLibrary(opts.vfs);
  await lib.load(opts.fdfPath);
  const root = lib.resolveRoot(opts.rootFrame);
  if (!root) throw new Error(`FDF: frame "${opts.rootFrame}" not found in ${opts.fdfPath}`);

  const blpCache = new Map<string, HTMLCanvasElement | null>();
  const blpCanvas = (path: string): HTMLCanvasElement | null => {
    if (!path) return null;
    if (blpCache.has(path)) return blpCache.get(path)!;
    const bytes = opts.vfs.rawBytes(path);
    const canvas = bytes ? blpToCanvas(bytes) : null;
    blpCache.set(path, canvas);
    return canvas;
  };

  const overlay = document.createElement("div");
  overlay.className = "fdf-screen";

  const shortcuts = new Map<string, () => void>(); // key (lowercase) → handler

  const build = (): void => {
    overlay.textContent = "";
    shortcuts.clear();
    const fit = fitBox(window.innerWidth, window.innerHeight);
    // Root fills the full screen width (worldW × 0.6) so TOPRIGHT-anchored frames land
    // on the screen's right edge, not a centred 4:3 box's right edge.
    const { tree } = layout(root, { x: 0, y: 0, w: fit.worldW, h: UI_HEIGHT });
    renderFrame(tree, overlay, {
      lib, fit, blpCanvas,
      handlers: opts.handlers ?? {},
      textOverrides: opts.textOverrides ?? {},
      sprites: opts.sprites ?? {},
      hidden: new Set(opts.hidden ?? []),
      shortcuts,
    });
  };

  build();

  const onResize = (): void => build();
  window.addEventListener("resize", onResize);

  const onKey = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Only when the menu is actually on screen — it stays mounted but hidden during a
    // match or the game-setup lobby (display:none), and its accelerators must not fire
    // then (e.g. "S" is a HUD hotkey in-game, not "Single Player"). offsetParent is
    // always null for a position:fixed element, so check the effective display.
    if (getComputedStyle(overlay).display === "none") return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const h = shortcuts.get(e.key.toLowerCase());
    if (h) { e.preventDefault(); h(); }
  };
  window.addEventListener("keydown", onKey);

  opts.container.appendChild(overlay);

  return {
    element: overlay,
    relayout: build,
    dispose(): void {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      overlay.remove();
    },
  };
}

interface RenderCtx {
  lib: FdfLibrary;
  fit: { scale: number; worldW: number };
  blpCanvas: (path: string) => HTMLCanvasElement | null;
  handlers: FdfScreenHandlers;
  textOverrides: Record<string, string>;
  sprites: Record<string, string>;
  hidden: Set<string>;
  shortcuts: Map<string, () => void>;
}

const BUTTON_TYPES = new Set(["GLUETEXTBUTTON", "GLUEBUTTON", "TEXTBUTTON", "BUTTON", "GLUECHECKBOX"]);

// `parentAbs` is the parent frame's absolute pixel origin. Frames nest in the DOM
// and each is `position:absolute`, so a child's CSS left/top must be relative to its
// parent's box — subtract the parent origin or the offsets compound down the tree.
function renderFrame(
  node: LaidOutFrame,
  parentEl: HTMLElement,
  ctx: RenderCtx,
  parentAbs: { left: number; top: number } = { left: 0, top: 0 },
): HTMLElement | null {
  const f = node.frame;
  if (f.name && ctx.hidden.has(f.name)) return null; // WC3 glue scripts hide these sub-panels
  const px = toPixels(node, ctx.fit);
  const el = document.createElement("div");
  el.className = "fdf-frame";
  el.style.position = "absolute";
  el.style.left = `${px.left - parentAbs.left}px`;
  el.style.top = `${px.top - parentAbs.top}px`;
  el.style.width = `${px.width}px`;
  el.style.height = `${px.height}px`;
  if (f.name) el.dataset.frame = f.name;

  const isButton = BUTTON_TYPES.has(f.type);
  if (f.type === "BACKDROP") {
    paintBackdrop(el, f, px, ctx);
  } else if (f.type === "TEXT") {
    paintText(el, f, ctx);
  } else if (isButton) {
    wireButton(el, f, ctx);
  } else if ((f.type === "SPRITE" || f.type === "MODEL") && ctx.sprites[f.name]) {
    const canvas = ctx.blpCanvas(ctx.sprites[f.name]);
    if (canvas) el.style.background = `url(${canvas.toDataURL()}) center/contain no-repeat`;
  }

  parentEl.appendChild(el);
  const abs = { left: px.left, top: px.top };

  if (isButton) {
    renderButtonLayers(el, node, f, px, ctx, abs);
  } else {
    for (const child of node.children) renderFrame(child, el, ctx, abs);
  }
  return el;
}

/** Render a button's layers in paint order: normal face → pushed face (shown on
 *  :active) → mouse-over glow (shown on :hover) → the label on top. The FDF holds
 *  the states as sibling backdrops referenced by ControlBackdrop/ControlPushedBackdrop
 *  etc.; drawing them all at once would just stack into one block, so we split them. */
function renderButtonLayers(
  el: HTMLElement,
  node: LaidOutFrame,
  f: FdfFrame,
  px: { width: number; height: number },
  ctx: RenderCtx,
  abs: { left: number; top: number },
): void {
  const baseName = strProp(f, "ControlBackdrop");
  const pushedName = strProp(f, "ControlPushedBackdrop");
  const stateNames = stateLayerNames(f);
  const baseChild = baseName ? node.children.find((c) => c.frame.name === baseName) : undefined;

  // 1) normal face
  if (baseChild) renderFrame(baseChild, el, ctx, abs);

  // 2) pushed face (a composited overlay toggled by :active)
  const pushedChild = pushedName ? node.children.find((c) => c.frame.name === pushedName) : undefined;
  if (pushedChild) {
    const canvas = compositeBackdrop(pushedChild.frame, Math.round(px.width), Math.round(px.height), ctx);
    if (canvas) {
      canvas.className = "fdf-pushed";
      canvas.style.position = "absolute";
      canvas.style.inset = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      el.appendChild(canvas);
    }
  }

  // 3) mouse-over glow
  appendGlow(el, f, ctx);

  // 4) the label + any remaining children (drawn last → on top)
  const textName = strProp(f, "ButtonText");
  const push = firstProp(f, "ButtonPushedTextOffset")?.args;
  if (push && push.length >= 2) {
    el.style.setProperty("--push-x", `${(push[0].n ?? 0) * ctx.fit.scale}px`);
    el.style.setProperty("--push-y", `${-(push[1].n ?? 0) * ctx.fit.scale}px`);
  }
  for (const child of node.children) {
    const nm = child.frame.name;
    if (child === baseChild) continue;
    if (nm && stateNames.has(nm)) continue; // pushed/disabled/highlight handled above
    const childEl = renderFrame(child, el, ctx, abs);
    if (childEl && nm && nm === textName) childEl.classList.add("fdf-btn-text");
  }
}

/** Names of a button's non-default state backdrops/highlights (rendered only on state). */
function stateLayerNames(f: FdfFrame): Set<string> {
  const names = new Set<string>();
  for (const key of ["ControlPushedBackdrop", "ControlDisabledBackdrop", "ControlDisabledPushedBackdrop", "ControlFocusHighlight", "ControlMouseOverHighlight"]) {
    const nm = strProp(f, key);
    if (nm) names.add(nm);
  }
  return names;
}

/** Paint a BACKDROP's chrome into `el` as a background canvas. */
function paintBackdrop(el: HTMLElement, f: FdfFrame, px: { width: number; height: number }, ctx: RenderCtx): void {
  const canvas = compositeBackdrop(f, Math.round(px.width), Math.round(px.height), ctx);
  if (!canvas) return;
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  el.insertBefore(canvas, el.firstChild);
}

/** Compose a WC3 backdrop (BlendAll single-stretch, or 9-slice edge/corner) to a canvas. */
function compositeBackdrop(f: FdfFrame, w: number, h: number, ctx: RenderCtx): HTMLCanvasElement | null {
  if (w < 1 || h < 1) return null;
  const bgPath = strProp(f, "BackdropBackground");
  const bg = bgPath ? ctx.blpCanvas(bgPath) : null;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.imageSmoothingEnabled = true;

  const blendAll = f.props.some((p) => p.key === "BackdropBlendAll");
  if (blendAll) {
    // One ornate texture stretched over the whole frame (the menu button borders).
    if (bg) g.drawImage(bg, 0, 0, w, h);
    return canvas;
  }

  // 9-slice: interior background + edge-file border. cornerSize/backgroundSize are in
  // 0.8×0.6 world units; scale them to pixels with the same factor as the layout.
  const cornerPx = Math.max(2, Math.round((prop(f, "BackdropCornerSize") ?? 0.012) * ctx.fit.scale));
  const inset = (prop(f, "BackdropBackgroundInsets") ?? 0) * ctx.fit.scale;
  const edge = ctx.blpCanvas(strProp(f, "BackdropEdgeFile") ?? "");

  if (bg) {
    // Fill the (inset) interior. With BackdropTileBackground the background tiles
    // (the dark button face); without it the background is a single image stretched
    // to fill (an icon like the search-region magnifying glass), so it fits its
    // container instead of tiling/cropping at native pixels.
    const ix = inset, iy = inset, iw = Math.max(0, w - inset * 2), ih = Math.max(0, h - inset * 2);
    if (f.props.some((p) => p.key === "BackdropTileBackground")) {
      const bgSizeWorld = prop(f, "BackdropBackgroundSize");
      const tileW = bgSizeWorld ? bgSizeWorld * ctx.fit.scale : bg.width;
      const tileH = bgSizeWorld ? bgSizeWorld * ctx.fit.scale : bg.height;
      g.save();
      g.beginPath(); g.rect(ix, iy, iw, ih); g.clip();
      for (let y = iy; y < iy + ih; y += tileH) for (let x = ix; x < ix + iw; x += tileW) g.drawImage(bg, x, y, tileW, tileH);
      g.restore();
    } else {
      g.drawImage(bg, ix, iy, iw, ih);
    }
  }

  if (edge) {
    const ts = edge.height; // tile size in source px (square tiles)
    const tile = (idx: number, dx: number, dy: number, dw: number, dh: number, rot = 0): void => {
      g.save();
      g.translate(dx + dw / 2, dy + dh / 2);
      if (rot) g.rotate((rot * Math.PI) / 180);
      const [ww, hh] = rot % 180 === 0 ? [dw, dh] : [dh, dw];
      g.drawImage(edge, idx * ts, 0, ts, ts, -ww / 2, -hh / 2, ww, hh);
      g.restore();
    };
    const c = cornerPx;
    // Edges (tiles 2/3 are vertical strips in the source → rotate for top/bottom).
    tile(EDGE_TILE.L, 0, c, c, h - 2 * c);
    tile(EDGE_TILE.R, w - c, c, c, h - 2 * c);
    tile(EDGE_TILE.T, c, 0, w - 2 * c, c, 90);
    tile(EDGE_TILE.B, c, h - c, w - 2 * c, c, 90);
    // Corners.
    tile(EDGE_TILE.UL, 0, 0, c, c);
    tile(EDGE_TILE.UR, w - c, 0, c, c);
    tile(EDGE_TILE.LL, 0, h - c, c, c);
    tile(EDGE_TILE.LR, w - c, h - c, c, c);
  }
  return canvas;
}

/** Paint a TEXT frame: markup → html, font/colour/justification from the FDF. */
function paintText(el: HTMLElement, f: FdfFrame, ctx: RenderCtx): void {
  const raw = ctx.textOverrides[f.name] ?? ctx.lib.string(strProp(f, "Text") ?? "");
  el.style.display = "flex";
  el.style.overflow = "hidden";
  el.innerHTML = "";
  const span = document.createElement("span");
  span.innerHTML = wc3ToHtml(raw);
  el.appendChild(span);

  const font = firstProp(f, "FrameFont");
  const sizeWorld = font?.args[1]?.n ?? 0.013;
  el.style.fontFamily = UI_FONT;
  el.style.fontSize = `${Math.max(8, sizeWorld * ctx.fit.scale)}px`;
  el.style.lineHeight = "1.05";
  el.style.whiteSpace = "pre-wrap";

  const color = firstProp(f, "FontColor")?.args;
  if (color && color.length >= 3) span.style.color = rgba(color);

  const shadow = firstProp(f, "FontShadowColor")?.args;
  const soff = firstProp(f, "FontShadowOffset")?.args;
  if (shadow && shadow.length >= 3) {
    const ox = (soff?.[0]?.n ?? 0.001) * ctx.fit.scale;
    const oy = -(soff?.[1]?.n ?? -0.001) * ctx.fit.scale;
    span.style.textShadow = `${ox}px ${oy}px 0 ${rgba(shadow)}`;
  }

  const jh = strProp(f, "FontJustificationH") ?? firstProp(f, "FontJustificationH")?.args[0]?.s;
  const jv = strProp(f, "FontJustificationV") ?? firstProp(f, "FontJustificationV")?.args[0]?.s;
  el.style.justifyContent = jh === "JUSTIFYRIGHT" ? "flex-end" : jh === "JUSTIFYCENTER" ? "center" : "flex-start";
  el.style.alignItems = jv === "JUSTIFYTOP" ? "flex-start" : jv === "JUSTIFYBOTTOM" ? "flex-end" : "center";
  span.style.textAlign = jh === "JUSTIFYRIGHT" ? "right" : jh === "JUSTIFYCENTER" ? "center" : "left";
}

/** Wire a button frame's click/shortcut handlers. The cursor stays the WC3 hand at
 *  all times (see ui/cursor.ts) — no per-element pointer, per the reference. */
function wireButton(el: HTMLElement, f: FdfFrame, ctx: RenderCtx): void {
  el.classList.add("fdf-button");

  const handler = ctx.handlers[f.name];
  if (handler) {
    el.addEventListener("click", handler);
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); } });
  }

  // ControlShortcutKey "S" → global accelerator.
  const key = strProp(f, "ControlShortcutKey");
  if (key && handler) ctx.shortcuts.set(key.toLowerCase(), handler);
}

/** Append the mouse-over highlight (ControlMouseOverHighlight → HighlightAlphaFile). */
function appendGlow(el: HTMLElement, f: FdfFrame, ctx: RenderCtx): void {
  const highlightName = strProp(f, "ControlMouseOverHighlight");
  const highlight = highlightName ? findByName(f, highlightName) : undefined;
  const highPath = highlight ? strProp(highlight, "HighlightAlphaFile") : undefined;
  const highCanvas = highPath ? ctx.blpCanvas(highPath) : null;
  if (!highCanvas) return;
  const glow = document.createElement("div");
  glow.className = "fdf-button-glow";
  glow.style.background = `url(${highCanvas.toDataURL()}) center/100% 100% no-repeat`;
  el.appendChild(glow);
}

// --- small helpers ---------------------------------------------------------------

function rgba(args: { n: number | null }[]): string {
  const c = (i: number) => Math.round((args[i]?.n ?? 0) * 255);
  const a = args[3]?.n ?? 1;
  return `rgba(${c(0)}, ${c(1)}, ${c(2)}, ${a})`;
}

function prop(f: FdfFrame, key: string): number | undefined {
  return firstProp(f, key)?.args[0]?.n ?? undefined;
}

/** Find a named sub-frame anywhere under `f` (for Control* backdrop references). */
function findByName(f: FdfFrame, name: string): FdfFrame | undefined {
  for (const c of f.children) {
    if (c.name === name) return c;
    const deep = findByName(c, name);
    if (deep) return deep;
  }
  return undefined;
}
