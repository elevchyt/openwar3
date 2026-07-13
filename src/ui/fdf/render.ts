import type { DataSource } from "../../vfs/types";
import { blpToCanvas } from "../../render/blputil";
import { wc3ToHtml } from "../wc3Text";
import type { FdfFrame } from "./parser";
import { FdfLibrary, firstProp, hasFlag, numProp, strProp } from "./library";
import { fitBox, layout, toPixels, UI_HEIGHT, type LaidOutFrame } from "./layout";
import { fadePanels, type PanelDirection } from "./anim";
import {
  buildEditBox, buildList, buildPopup, widgetKind,
  type EditBoxControl, type ListControl, type PopupControl, type PopupMenuStyle, type ScrollBarStyle,
} from "./widgets";

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
  /** frameName → click handler. Also fired by the frame's ControlShortcutKey. Most frames
   *  have none, so a lookup is honestly `| undefined`. */
  [frameName: string]: (() => void) | undefined;
}

export interface FdfScreenOptions {
  container: HTMLElement;
  vfs: DataSource;
  fdfPath: string;
  /** Further .fdf files to load into the library before `buildRoot` runs. A screen the
   *  engine composes from several files (the Custom Game screen pulls its list, its player
   *  rows and its info pane from three more) needs their templates in scope. */
  includeFdf?: string[];
  /** The FDF frame to mount. Ignored when `buildRoot` is given. */
  rootFrame: string;
  /** Synthesize the root instead of looking one up (7.19). The engine's in-game panels
   *  aren't whole screens in the FDF — the game *composes* them from templates at
   *  runtime: a `ScriptDialog` gets N `ScriptDialogButton`s stacked inside it, a
   *  `Leaderboard` gets a row per player. This is the hook for building that composite
   *  out of the real templates, so the chrome still comes from the game's own files. */
  buildRoot?(lib: FdfLibrary): FdfFrame;
  /** Place the root at the centre of the screen at its own Width/Height, rather than
   *  stretching it over the whole viewport — how WC3 puts a dialog on screen. */
  centerRoot?: boolean;
  /** Extra class on the overlay. `fdf-ingame` keeps it visible during a match (the glue
   *  screens hide themselves then — see style.css). */
  overlayClass?: string;
  /** Which `UI\war3skins.txt` section decorates this screen's textures ("Human", "Orc",
   *  "NightElf", "Undead"). WC3 skins the in-game panels by the local player's race.
   *  Default: the table's own `[Default]` (Human art). */
  skin?: string;
  handlers?: FdfScreenHandlers;
  /** frameName → literal text, overriding the FDF (e.g. "Battle.net" → "Online"). */
  textOverrides?: Record<string, string>;
  /** Optional SPRITE frameName → BLP path, to draw a static stand-in for a 3D sprite. */
  sprites?: Record<string, string>;
  /** Frame names to skip (WC3's glue scripts hide these sub-panels initially). */
  hidden?: string[];
  /** Widen the button widgets by this factor (text size unchanged). Default 1. */
  buttonWidthScale?: number;
  /** The frames that make up this screen's PANELS — the groups whose contents fade out and
   *  back in between menus (issue #61). Each named frame fades as one. Defaults to the
   *  root's direct children. */
  panels?: string[];
  /** BUTTON frames that behave as dropdowns (PlayerSlot's TeamButton / ColorButton are
   *  declared as plain BUTTONs in the FDF; the engine gives them a menu). */
  dropdownButtons?: string[];
  /** Called after every build — including the rebuilds a resize triggers — so the screen
   *  can (re)fill its widgets from its own model. Widgets are DOM, and a rebuild throws
   *  the old DOM away; this is the hook that puts the contents back. */
  onBuild?: (screen: FdfScreen) => void;
}

/** A mounted FDF screen: a full-viewport overlay that relayouts on resize. */
export interface FdfScreen {
  element: HTMLElement;
  relayout(): void;
  dispose(): void;
  /** The DOM element built for a named frame, if it is on screen. */
  frame(name: string): HTMLElement | null;
  /** Replace a TEXT frame's contents (WC3 markup allowed). */
  setText(name: string, text: string): void;
  /** Grey a control out — buttons take their FDF ControlDisabledBackdrop. */
  setEnabled(name: string, on: boolean): void;
  /**
   * Stop the screen answering the mouse and the keyboard, WITHOUT greying it out. Used on
   * the screen that is arriving: it must not be clickable before it has landed, but it also
   * must not fade up looking disabled and then pop to normal once it does.
   */
  setInteractive(on: boolean): void;
  /**
   * Disable EVERY button and control on the screen at once — the reference does this the
   * moment a menu button is clicked, so the whole panel is visibly dead while it leaves.
   * A screen-wide gate, not a bulk setEnabled: it doesn't clobber the per-control state the
   * screen chose (a greyed-out "Advanced Options" is still greyed out when it's lifted).
   */
  setAllDisabled(on: boolean): void;
  editBox(name: string): EditBoxControl | null;
  popup(name: string): PopupControl | null;
  list(name: string): ListControl | null;
  /** Fade this screen's panel contents out or in across the chrome clip's window (ui/fdf/anim.ts).
   *  The panel itself is moved by the 3D chrome; only its contents live here. */
  animatePanels(dir: PanelDirection, durationMs: number): Promise<void>;
}

/** Parse `fdfPath`, resolve `rootFrame` (or synthesize one), and build it into `container`. */
export async function mountFdfScreen(opts: FdfScreenOptions): Promise<FdfScreen> {
  const lib = new FdfLibrary(opts.vfs);
  if (opts.skin) lib.skin = opts.skin;
  await lib.load(opts.fdfPath);
  for (const path of opts.includeFdf ?? []) await lib.load(path);
  // buildRoot runs per BUILD, not once: a composed screen's frame tree depends on state
  // that changes (the Custom Game screen grows a player row per slot in the chosen map).
  const makeRoot = (): FdfFrame => {
    const r = opts.buildRoot ? opts.buildRoot(lib) : lib.resolveRoot(opts.rootFrame);
    if (!r) throw new Error(`FDF: frame "${opts.rootFrame}" not found in ${opts.fdfPath}`);
    return r;
  };
  let root = makeRoot();

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
  overlay.className = opts.overlayClass ? `fdf-screen ${opts.overlayClass}` : "fdf-screen";

  const shortcuts = new Map<string, () => void>(); // key (lowercase) → handler
  const elements = new Map<string, HTMLElement>(); // frame name → its DOM node
  const controls = new Map<string, EditBoxControl | PopupControl | ListControl>();
  let disposers: Array<() => void> = [];

  const build = (): void => {
    for (const off of disposers) off();
    disposers = [];
    root = makeRoot();
    overlay.textContent = "";
    shortcuts.clear();
    elements.clear();
    controls.clear();
    // Fit to the overlay's OWN box, not the window. CSS decides what that box is — the whole
    // window for the menus, the 16:9 game stage for the in-game screens (style.css) — so a
    // frame anchored TOPRIGHT lands on the right edge of the frame it belongs to. Measuring
    // the window here is what threw the multiboard and the leaderboard off once the game got
    // letterboxed: they were laid out for a box wider than the one they were drawn in.
    const fit = fitBox(overlay.clientWidth || window.innerWidth, overlay.clientHeight || window.innerHeight);
    // Root fills the full screen width (worldW × 0.6) so TOPRIGHT-anchored frames land
    // on the screen's right edge, not a centred 4:3 box's right edge. A CENTRED root
    // instead keeps its own Width/Height and sits in the middle — how the game puts a
    // dialog up: ScriptDialog declares Width 0.288f / Height 0.112f and nothing else.
    const box = opts.centerRoot
      ? centreBox(numProp(root, "Width") ?? fit.worldW, numProp(root, "Height") ?? UI_HEIGHT, fit.worldW)
      : { x: 0, y: 0, w: fit.worldW, h: UI_HEIGHT };
    const { tree } = layout(root, box, opts.buttonWidthScale ?? 1);
    renderFrame(tree, overlay, {
      lib, fit, blpCanvas, overlay,
      handlers: opts.handlers ?? {},
      textOverrides: opts.textOverrides ?? {},
      sprites: opts.sprites ?? {},
      hidden: new Set(opts.hidden ?? []),
      dropdownButtons: new Set(opts.dropdownButtons ?? []),
      shortcuts, elements, controls, disposers,
    });
    opts.onBuild?.(screen);
  };

  /** The panel elements this screen slides — the named panels, else the root's children. */
  const panelEls = (): HTMLElement[] => {
    const names = opts.panels ?? root.children.map((c) => c.name).filter(Boolean);
    return names.map((n) => elements.get(n)).filter((el): el is HTMLElement => !!el);
  };

  const screen: FdfScreen = {
    element: overlay,
    relayout: build,
    frame: (name) => elements.get(name) ?? null,
    setText(name, text): void {
      const el = elements.get(name);
      if (!el) return;
      const span = el.querySelector("span");
      if (span) span.innerHTML = wc3ToHtml(text);
    },
    setEnabled(name, on): void {
      const el = elements.get(name);
      if (el) el.classList.toggle("fdf-disabled", !on);
      const control = controls.get(name);
      control?.setEnabled(on);
    },
    // Both gates are ONE CLASS on the overlay, so neither touches per-control state and both
    // lift cleanly. `inert` only takes the pointer events; `disabled` also greys everything.
    setInteractive(on): void {
      overlay.classList.toggle("fdf-screen-inert", !on);
    },
    setAllDisabled(on): void {
      overlay.classList.toggle("fdf-screen-disabled", on);
    },
    editBox: (name) => (controls.get(name) as EditBoxControl | undefined) ?? null,
    popup: (name) => (controls.get(name) as PopupControl | undefined) ?? null,
    list: (name) => (controls.get(name) as ListControl | undefined) ?? null,
    animatePanels: (dir, durationMs) => fadePanels(panelEls(), dir, durationMs),
    dispose(): void {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      for (const off of disposers) off();
      disposers = [];
      overlay.remove();
    },
  };

  // Mount BEFORE the first build: the layout measures the overlay's own box, and an element
  // that isn't in the document yet measures 0.
  opts.container.appendChild(overlay);
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
    // Mid-transition: the screen is either leaving (disabled) or has not landed yet (inert).
    if (overlay.classList.contains("fdf-screen-disabled")) return;
    if (overlay.classList.contains("fdf-screen-inert")) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const h = shortcuts.get(e.key.toLowerCase());
    if (h) { e.preventDefault(); h(); }
  };
  window.addEventListener("keydown", onKey);

  return screen;
}

interface RenderCtx {
  lib: FdfLibrary;
  fit: { scale: number; worldW: number };
  blpCanvas: (path: string) => HTMLCanvasElement | null;
  handlers: FdfScreenHandlers;
  textOverrides: Record<string, string>;
  sprites: Record<string, string>;
  hidden: Set<string>;
  /** BUTTON frames the screen wants treated as dropdowns (PlayerSlot's Team/Colour). */
  dropdownButtons: Set<string>;
  overlay: HTMLElement;
  shortcuts: Map<string, () => void>;
  elements: Map<string, HTMLElement>;
  controls: Map<string, EditBoxControl | PopupControl | ListControl>;
  disposers: Array<() => void>;
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

  // A dropdown may be declared as a plain BUTTON (PlayerSlot's TeamButton / ColorButton),
  // so the screen's own list wins over the frame type.
  const kind = ctx.dropdownButtons.has(f.name) ? "popup" : widgetKind(f);
  const isButton = !kind && BUTTON_TYPES.has(f.type);
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
  if (f.name) ctx.elements.set(f.name, el);
  const abs = { left: px.left, top: px.top };

  if (kind) {
    renderWidget(kind, el, node, f, px, ctx, abs);
  } else if (isButton) {
    renderButtonLayers(el, node, f, px, ctx, abs);
  } else {
    for (const child of node.children) renderFrame(child, el, ctx, abs);
  }
  return el;
}

/** Draw a widget's chrome from its FDF frames, then attach the controller that gives it
 *  behaviour. Only the normal-state backdrop is drawn as a layer; the disabled backdrop
 *  is composited on top and revealed by `.fdf-disabled`, mirroring the button states. */
function renderWidget(
  kind: "edit" | "popup" | "list",
  el: HTMLElement,
  node: LaidOutFrame,
  f: FdfFrame,
  px: { width: number; height: number },
  ctx: RenderCtx,
  abs: { left: number; top: number },
): void {
  const stateNames = stateLayerNames(f);
  const baseName = strProp(f, "ControlBackdrop");
  const baseChild = baseName ? node.children.find((c) => c.frame.name === baseName) : undefined;
  if (baseChild) renderFrame(baseChild, el, ctx, abs);
  appendDisabledFace(el, node, f, px, ctx);

  // Everything else the FDF gives the widget (the pulldown arrow, the colour swatch, the
  // title text) still draws — it is the widget's own chrome. The scrollbar frames do not:
  // the list scrolls natively, so a fake bar would just sit there dead.
  //
  // Keep the elements we build HERE, and resolve the widget's parts out of this map rather
  // than the screen-wide one: the three POPUPMENUs in a PlayerSlot row all inherit
  // WITHCHILDREN from the same template, so each owns a child called
  // "PlayerSlotPopupMenuTitle" — screen-wide, they overwrite one another, and which row's
  // element a name resolves to would depend on the order the siblings happened to render in.
  const parts = new Map<string, HTMLElement>();
  for (const child of node.children) {
    if (child === baseChild) continue;
    if (child.frame.name && stateNames.has(child.frame.name)) continue;
    if (child.frame.type === "SCROLLBAR" || child.frame.type === "MENU") continue;
    const childEl = renderFrame(child, el, ctx, abs);
    if (childEl && child.frame.name) parts.set(child.frame.name, childEl);
  }

  const scale = ctx.fit.scale;
  if (kind === "edit") {
    ctx.controls.set(f.name, buildEditBox(el, f, scale));
  } else if (kind === "popup") {
    // A POPUPMENU names its label frame outright (PopupTitleFrame). A BUTTON pressed into
    // service as a dropdown (PlayerSlot's TeamButton / ColorButton) doesn't, and names its
    // parts by convention: "<Button>Title" for the label, "<Button>Value" for the colour
    // swatch. Mind the row suffix — the Custom Game screen's rows are copies of one template
    // with every name suffixed, so TeamButton3 owns TeamButtonTitle3, not TeamButton3Title.
    const base = f.name.replace(/\d+$/, "");
    const row = f.name.slice(base.length);
    const titleEl = parts.get(strProp(f, "PopupTitleFrame") ?? `${base}Title${row}`) ?? null;
    const swatchEl = parts.get(`${base}Value${row}`) ?? null;
    // The selection's label must never run past the widget. Its TEXT frame is as wide as the
    // whole dropdown — but the pulldown arrow sits at the right end of that box (parked there
    // by PopupButtonInset), so the label's room stops where the arrow begins.
    const span = titleEl?.querySelector("span") ?? null;
    const labelBox = span?.parentElement;
    if (labelBox) {
      labelBox.classList.add("fdf-popup-title");
      const inset = (numProp(f, "PopupButtonInset") ?? 0.01) + 0.011; // the inset + the arrow itself
      labelBox.style.paddingRight = `${inset * scale}px`;
      // A notch below the FDF's own size: our font sets larger than WC3's, and these are its
      // tightest boxes (a player row packs five of them across).
      labelBox.style.fontSize = `${Math.max(8, parseFloat(getComputedStyle(labelBox).fontSize) * POPUP_LABEL_SCALE)}px`;
    }
    ctx.controls.set(f.name, buildPopup(el, f, scale, ctx.overlay, {
      titleEl: span ?? titleEl,
      swatchEl,
      paintSwatch: swatchEl ? (target, value) => { target.style.background = value; } : undefined,
      menu: popupMenuStyle(f, node, ctx),
    }, ctx.disposers));
  } else {
    ctx.controls.set(f.name, buildList(el, f, scale, scrollBarStyle(node, ctx)));
  }
}

/**
 * The list's scrollbar, from the SCROLLBAR frame the FDF hangs off it (MapListBox.fdf's
 * MapListScrollBar, a StandardScrollBarTemplate). Its four pieces — the tiled track, the
 * two arrow buttons and the knob — are the game's own art; the behaviour is ours, as the
 * engine's is.
 */
function scrollBarStyle(node: LaidOutFrame, ctx: RenderCtx): ScrollBarStyle | null {
  const bar = node.children.find((c) => c.frame.type === "SCROLLBAR")?.frame;
  if (!bar) return null;
  const scale = ctx.fit.scale;
  /** A named sub-frame's ControlBackdrop, composited at a pixel size. */
  const face = (name: string | undefined) => {
    const owner = name ? findByName(bar, name) : bar;
    const backdropName = owner ? strProp(owner, "ControlBackdrop") : undefined;
    const backdrop = owner && backdropName ? findByName(owner, backdropName) : undefined;
    return (w: number, h: number): HTMLCanvasElement | null =>
      backdrop ? compositeBackdrop(backdrop, Math.round(w), Math.round(h), ctx) : null;
  };
  const inc = strProp(bar, "ScrollBarIncButtonFrame");
  const thumb = strProp(bar, "SliderThumbButtonFrame");
  /** A sub-frame's own declared height, in pixels. */
  const heightOf = (name: string | undefined, fallback: number): number =>
    (numProp((name && findByName(bar, name)) || bar, "Height") ?? fallback) * scale;
  return {
    width: (numProp(bar, "Width") ?? 0.0165) * scale,
    arrow: heightOf(inc, 0.015),
    // The knob is a fixed bead (StandardThumbButton: 0.01 × 0.01), not a bar that grows
    // and shrinks with the list — it slides the same size however long the list is.
    knob: heightOf(thumb, 0.01),
    track: face(undefined),
    // The FDF's INC button carries the UP arrow and the DEC button the DOWN one — the
    // scrollbar's "increment" is towards the top of the list, not the bottom of the screen.
    up: face(inc),
    down: face(strProp(bar, "ScrollBarDecButtonFrame")),
    thumb: face(thumb),
  };
}

/**
 * The open dropdown's look, from the game's own MENU frame. A POPUPMENU names it in
 * `PopupMenuFrame` and carries it as a child (PlayerSlot's RaceMenu → RacePopupMenuMenu,
 * itself a StandardPopupMenuMenuTemplate); a plain BUTTON pressed into service as a dropdown
 * (TeamButton / ColorButton) has none, so it falls back to that same shared template — which
 * is what the engine draws for it too.
 */
/** How much smaller than the FDF says a dropdown's text is drawn (label and menu alike). */
const POPUP_LABEL_SCALE = 0.88;

function popupMenuStyle(f: FdfFrame, node: LaidOutFrame, ctx: RenderCtx): PopupMenuStyle | null {
  const named = strProp(f, "PopupMenuFrame");
  const own = node.children.find((c) => c.frame.type === "MENU" && (!named || c.frame.name === named))?.frame;
  const menu = own ?? ctx.lib.resolveRoot("StandardPopupMenuMenuTemplate");
  if (!menu) return null;
  const scale = ctx.fit.scale;
  const backdropName = strProp(menu, "ControlBackdrop");
  const backdrop = backdropName ? findByName(menu, backdropName) : undefined;
  const highlight = firstProp(menu, "MenuTextHighlightColor")?.args;
  return {
    backdrop: (w, h) => (backdrop ? compositeBackdrop(backdrop, w, h, ctx) : null),
    itemHeight: (numProp(menu, "MenuItemHeight") ?? 0.014) * scale,
    border: (numProp(menu, "MenuBorder") ?? 0.009) * scale,
    fontSize: Math.max(8, (firstProp(menu, "FrameFont")?.args[1]?.n ?? 0.011) * scale * POPUP_LABEL_SCALE),
    highlight: highlight && highlight.length >= 3 ? rgba(highlight) : "rgb(252, 211, 18)",
  };
}

/** Composite the frame's ControlDisabledBackdrop over it, shown only when disabled. */
function appendDisabledFace(
  el: HTMLElement,
  node: LaidOutFrame,
  f: FdfFrame,
  px: { width: number; height: number },
  ctx: RenderCtx,
): void {
  const name = strProp(f, "ControlDisabledBackdrop");
  const child = name ? node.children.find((c) => c.frame.name === name) : undefined;
  if (!child) return;
  const canvas = compositeBackdrop(child.frame, Math.round(px.width), Math.round(px.height), ctx);
  if (!canvas) return;
  canvas.className = "fdf-disabled-face";
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  el.appendChild(canvas);
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

  // 3) disabled face (the FDF's greyed backdrop, revealed by .fdf-disabled)
  appendDisabledFace(el, node, f, px, ctx);

  // 4) mouse-over glow
  appendGlow(el, f, ctx);

  // 5) the label + any remaining children (drawn last → on top)
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

/** A frame's texture name → a real BLP path. A frame flagged `DecorateFileNames` names
 *  its textures by SKIN KEY ("EscMenuEditBoxBackground") rather than by path, and the
 *  engine resolves them through UI\war3skins.txt (FdfLibrary.decorate). Frames without
 *  the flag name their files literally, so the lookup is a pass-through for them. */
function texture(f: FdfFrame, key: string, ctx: RenderCtx): HTMLCanvasElement | null {
  const name = strProp(f, key);
  if (!name) return null;
  return ctx.blpCanvas(hasFlag(f, "DecorateFileNames") ? ctx.lib.decorate(name) : name);
}

/** Compose a WC3 backdrop (BlendAll single-stretch, or 9-slice edge/corner) to a canvas. */
function compositeBackdrop(f: FdfFrame, w: number, h: number, ctx: RenderCtx): HTMLCanvasElement | null {
  if (w < 1 || h < 1) return null;
  const bg = texture(f, "BackdropBackground", ctx);
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
  const edge = texture(f, "BackdropEdgeFile", ctx);

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
    // BackdropCornerFlags names WHICH edges and corners of the border actually draw. Every
    // panel we mounted before this declared all eight ("UL|UR|BL|BR|T|L|B|R"), so ignoring the
    // property cost nothing — but the cinematic letterbox declares only its INNER edge
    // ("UL|UR|T" on the bottom bar, "BL|BR|B" on the top one), because the other three sides
    // run off the screen. Draw all eight there and the bars get a decorative frame around a
    // void.
    const flags = strProp(f, "BackdropCornerFlags");
    const on = (name: string): boolean => !flags || flags.split("|").includes(name);
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
    if (on("L")) tile(EDGE_TILE.L, 0, c, c, h - 2 * c);
    if (on("R")) tile(EDGE_TILE.R, w - c, c, c, h - 2 * c);
    if (on("T")) tile(EDGE_TILE.T, c, 0, w - 2 * c, c, 90);
    if (on("B")) tile(EDGE_TILE.B, c, h - c, w - 2 * c, c, 90);
    // Corners.
    if (on("UL")) tile(EDGE_TILE.UL, 0, 0, c, c);
    if (on("UR")) tile(EDGE_TILE.UR, w - c, 0, c, c);
    if (on("BL") || on("LL")) tile(EDGE_TILE.LL, 0, h - c, c, c);
    if (on("BR") || on("LR")) tile(EDGE_TILE.LR, w - c, h - c, c, c);
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

  // FontDisabledColor is what the label goes when its control is disabled (0.5 0.5 0.5 for a
  // button, 0.2 0.2 0.2 for a title). It has to be handed to CSS as a variable: FontColor is
  // set INLINE above, and an inline colour beats any stylesheet rule trying to grey it out.
  const disabled = firstProp(f, "FontDisabledColor")?.args;
  if (disabled && disabled.length >= 3) el.style.setProperty("--fdf-disabled-color", rgba(disabled));

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

  // FontJustificationOffset — the text's inset from the edge it justifies against. The
  // dropdown label (StandardPopupMenuTitleTextTemplate) is the reason this matters: its box
  // is the whole widget, so with no offset the label sits ON the widget's left border.
  const ox = (firstProp(f, "FontJustificationOffset")?.args[0]?.n ?? 0) * ctx.fit.scale;
  if (ox) el.style[jh === "JUSTIFYRIGHT" ? "paddingRight" : "paddingLeft"] = `${ox}px`;
}

/** Wire a button frame's click/shortcut handlers. The cursor stays the WC3 hand at
 *  all times (see ui/cursor.ts) — no per-element pointer, per the reference. */
function wireButton(el: HTMLElement, f: FdfFrame, ctx: RenderCtx): void {
  el.classList.add("fdf-button");

  const handler: (() => void) | undefined = ctx.handlers[f.name];
  // A disabled button eats its click rather than firing — as does a button on a screen that
  // is mid-transition, which is what stops a second menu button being pressed while the
  // panels are already on their way out (issue #61). CSS kills the pointer events, but a
  // focused button would still answer Enter/Space, so check here too.
  const fire = (): void => {
    if (el.classList.contains("fdf-disabled")) return;
    if (el.closest(".fdf-screen-disabled, .fdf-screen-inert")) return;
    handler?.();
  };
  if (handler) {
    el.addEventListener("click", fire);
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); } });
  }

  // ControlShortcutKey "S" → global accelerator.
  const key = strProp(f, "ControlShortcutKey");
  if (key && handler) ctx.shortcuts.set(key.toLowerCase(), fire);
}

/** Append the mouse-over highlight (ControlMouseOverHighlight → HighlightAlphaFile). */
function appendGlow(el: HTMLElement, f: FdfFrame, ctx: RenderCtx): void {
  const highlightName = strProp(f, "ControlMouseOverHighlight");
  const highlight = highlightName ? findByName(f, highlightName) : undefined;
  const highCanvas = highlight ? texture(highlight, "HighlightAlphaFile", ctx) : null;
  if (!highCanvas) return;
  const glow = document.createElement("div");
  glow.className = "fdf-button-glow";
  glow.style.background = `url(${highCanvas.toDataURL()}) center/100% 100% no-repeat`;
  el.appendChild(glow);
}

// --- small helpers ---------------------------------------------------------------

/** Centre a `w × h` frame in the `worldW × 0.6` screen (world units, y-up). */
function centreBox(w: number, h: number, worldW: number): { x: number; y: number; w: number; h: number } {
  return { x: (worldW - w) / 2, y: (UI_HEIGHT - h) / 2, w, h };
}

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
