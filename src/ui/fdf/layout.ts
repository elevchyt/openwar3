import type { FdfFrame } from "./parser";
import { allProps, firstProp, hasFlag, numProp } from "./library";

// FDF layout solver — turns SetPoint/SetAllPoints/Anchor + Width/Height into world
// rectangles. WC3 glue screens are authored in a fixed coordinate space: the screen
// is 0.8 wide × 0.6 tall (4:3), origin BOTTOM-LEFT, +y UP (verified against the
// 1.27a MPQs — every offset in MainMenu.fdf reads that way, e.g. the top button is
// -0.110625 *below* the frame's top-right). SetPoint offsets are +x right / +y up.

export const UI_WIDTH = 0.8;
export const UI_HEIGHT = 0.6;

/** A frame plus its solved world rect (x,y = bottom-left corner). */
export interface LaidOutFrame {
  frame: FdfFrame;
  parent: LaidOutFrame | null;
  x: number;
  y: number;
  w: number;
  h: number;
  children: LaidOutFrame[];
  placed: boolean;
  /** We invented this frame's WIDTH (the FDF declared none) — see `autoJustifyH`. */
  fabricatedWidth?: boolean;
  /**
   * The horizontal justification a shrink-wrapped TEXT frame effectively has.
   *
   * In WC3 a TEXT frame AUTO-SIZES to its string, so a caption anchored `SetPoint TOP, …,
   * TOP` is centred *by construction* and its FontJustificationH never enters into it —
   * which is why the shipped files cheerfully leave those captions JUSTIFYLEFT (every
   * EscMenu panel title inherits `EscMenuTitleTextTemplate`, and that template is
   * JUSTIFYLEFT). We can't shrink-wrap — the text is measured by the browser after layout —
   * so we hand such a frame its parent's width instead, and then JUSTIFYLEFT is suddenly
   * load-bearing and dumps "Game Menu" against the panel's left edge.
   *
   * The anchor is what actually decides it: a box that hugs its content and hangs off its own
   * TOP point is centred on that point, off its TOPLEFT is left of it, off its TOPRIGHT is
   * right of it. So when the width is ours rather than the file's, the anchor's horizontal
   * fraction gives the justification, and this carries that to the renderer.
   */
  autoJustifyH?: "JUSTIFYLEFT" | "JUSTIFYCENTER" | "JUSTIFYRIGHT";
}

const FRAME_POINTS = new Set([
  "TOPLEFT", "TOP", "TOPRIGHT", "LEFT", "CENTER", "RIGHT", "BOTTOMLEFT", "BOTTOM", "BOTTOMRIGHT",
]);

// Fractional position of a named point inside a rect (0..1 from left / from bottom).
function fx(point: string): number {
  if (point === "LEFT" || point === "TOPLEFT" || point === "BOTTOMLEFT") return 0;
  if (point === "RIGHT" || point === "TOPRIGHT" || point === "BOTTOMRIGHT") return 1;
  return 0.5;
}
function fy(point: string): number {
  if (point === "BOTTOM" || point === "BOTTOMLEFT" || point === "BOTTOMRIGHT") return 0;
  if (point === "TOP" || point === "TOPLEFT" || point === "TOPRIGHT") return 1;
  return 0.5;
}

interface PointSpec {
  myPoint: string;
  relName: string | null; // named relative frame, or null → parent
  relPoint: string;
  dx: number;
  dy: number;
}

/** Read the SetPoint/Anchor/SetAllPoints statements off a frame. */
function readPoints(frame: FdfFrame): { setAllPoints: boolean; points: PointSpec[] } {
  const points: PointSpec[] = [];
  const setAllPoints = hasFlag(frame, "SetAllPoints");

  for (const pr of allProps(frame, "SetPoint")) {
    const a = pr.args;
    // Forms: (myPoint, "relFrame", relPoint, dx, dy) or (myPoint, "relFrame", relPoint).
    if (!a.length || !FRAME_POINTS.has(a[0].s)) continue;
    const myPoint = a[0].s;
    let idx = 1;
    let relName: string | null = null;
    if (a[idx]?.str) { relName = a[idx].s; idx++; }
    const relPoint = a[idx] && FRAME_POINTS.has(a[idx].s) ? a[idx++].s : myPoint;
    const dx = a[idx]?.n ?? 0; const dy = a[idx + 1]?.n ?? 0;
    points.push({ myPoint, relName, relPoint, dx, dy });
  }
  // Anchor <point>, dx, dy — used by Texture/String; anchor my point to the parent's.
  for (const pr of allProps(frame, "Anchor")) {
    const a = pr.args;
    if (!a.length || !FRAME_POINTS.has(a[0].s)) continue;
    points.push({ myPoint: a[0].s, relName: null, relPoint: a[0].s, dx: a[1]?.n ?? 0, dy: a[2]?.n ?? 0 });
  }
  return { setAllPoints, points };
}

/** One line of a TEXT frame's own font, in world units. 1.2 is the line box the renderer
 *  uses (ui/fdf/render.ts — it must clear descenders), and 0.013 its FrameFont default, so
 *  an unsized TEXT frame ends up exactly as tall as the line it draws. */
function textLineHeight(frame: FdfFrame): number {
  return (firstProp(frame, "FrameFont")?.args[1]?.n ?? 0.013) * 1.2;
}

/** Build the LaidOutFrame tree (unsolved), reading explicit Width/Height. */
function buildTree(frame: FdfFrame, parent: LaidOutFrame | null): LaidOutFrame {
  const node: LaidOutFrame = {
    frame, parent,
    x: 0, y: 0,
    w: numProp(frame, "Width") ?? NaN,
    h: numProp(frame, "Height") ?? NaN,
    children: [],
    placed: false,
  };
  node.children = frame.children.map((c) => buildTree(c, node));
  return node;
}

/**
 * Solve a frame subtree into world rects. The root fills the given box (default the
 * whole 0.8×0.6 UI space). Positions resolve iteratively because a SetPoint may
 * reference a sibling that hasn't been placed yet (e.g. buttons chain BOTTOMRIGHT
 * off the button above). Returns a flat name→node index for handler binding.
 */
const BUTTON_TYPES = new Set(["GLUETEXTBUTTON", "GLUEBUTTON", "TEXTBUTTON", "BUTTON", "GLUECHECKBOX"]);

/** Widen each button widget (the button frame + its ornate BACKDROP parent) by
 *  `scale`, before the layout is solved. Text is unaffected — its size comes from
 *  FrameFont, not the frame width, so it just recentres in the wider button. */
function scaleButtonWidths(root: LaidOutFrame, scale: number): void {
  const done = new Set<LaidOutFrame>();
  const widen = (n: LaidOutFrame): void => {
    if (done.has(n) || Number.isNaN(n.w)) return;
    n.w *= scale;
    done.add(n);
  };
  (function walk(n: LaidOutFrame): void {
    if (BUTTON_TYPES.has(n.frame.type)) {
      widen(n);
      if (n.parent && n.parent.frame.type === "BACKDROP") widen(n.parent);
    }
    n.children.forEach(walk);
  })(root);
}

/**
 * The anchors the ENGINE supplies, not the file.
 *
 * A POPUPMENU's pulldown arrow (`PopupArrowFrame`) carries a size but no SetPoint: the
 * engine parks it against the widget's right edge, inset by `PopupButtonInset`. Without
 * that, an un-anchored frame falls back to its parent's top-left corner — which is where
 * every race / team / handicap arrow on the Custom Game screen ended up (issue #61).
 */
function applyWidgetDefaults(root: FdfFrame): void {
  (function walk(f: FdfFrame): void {
    const arrowName = firstProp(f, "PopupArrowFrame")?.args[0]?.s;
    const arrow = arrowName ? f.children.find((c) => c.name === arrowName) : undefined;
    if (arrow && !hasFlag(arrow, "SetPoint") && !hasFlag(arrow, "Anchor") && !hasFlag(arrow, "SetAllPoints")) {
      const inset = numProp(f, "PopupButtonInset") ?? 0.01;
      arrow.props.push({
        key: "SetPoint",
        args: [
          { s: "RIGHT", n: null, str: false },
          { s: f.name, n: null, str: true },
          { s: "RIGHT", n: null, str: false },
          { s: String(-inset), n: -inset, str: false },
          { s: "0", n: 0, str: false },
        ],
      });
    }
    f.children.forEach(walk);
  })(root);
}

/**
 * Measure a TEXT frame's string, in world units — the engine's auto-size, which the FDF
 * leans on far more heavily than a "nice to have" would suggest. `AllianceDialog.fdf` chains
 * its column headers off ONE ANOTHER's edges:
 *
 *     Frame "TEXT" "PlayersHeader" { SetPoint TOPLEFT, "AllianceDialog", TOPLEFT, …, Text "PLAYERS" }
 *     Frame "TEXT" "AllyHeader"    { SetPoint BOTTOMLEFT, "PlayersHeader", BOTTOMRIGHT, 0.196, 0 }
 *
 * so `PlayersHeader`'s width is the position of every column to its right. Fall back to the
 * parent's width there and "Ally" lands 0.576 off the dialog's left edge — off the screen.
 * Returns undefined when the frame isn't measurable (no text, or no measurer supplied), and
 * the parent-width fallback stands.
 */
export type MeasureText = (frame: FdfFrame) => number | undefined;

export function layout(
  root: FdfFrame,
  box: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: UI_WIDTH, h: UI_HEIGHT },
  buttonWidthScale = 1,
  measure?: MeasureText,
): { tree: LaidOutFrame; byName: Map<string, LaidOutFrame> } {
  applyWidgetDefaults(root);
  const tree = buildTree(root, null);
  // Root fills its box.
  tree.x = box.x; tree.y = box.y;
  if (Number.isNaN(tree.w)) tree.w = box.w;
  if (Number.isNaN(tree.h)) tree.h = box.h;
  tree.placed = true;

  if (buttonWidthScale !== 1) scaleButtonWidths(tree, buttonWidthScale);

  // Index every node by name for sibling lookups + handler binding.
  const byName = new Map<string, LaidOutFrame>();
  const all: LaidOutFrame[] = [];
  (function walk(n: LaidOutFrame) { all.push(n); if (n.frame.name) byName.set(n.frame.name, n); n.children.forEach(walk); })(tree);

  // A node's SetPoint relFrame is resolved against the whole screen by name; if the
  // name is absent, fall back to the node's parent.
  const relOf = (n: LaidOutFrame, name: string | null): LaidOutFrame | null =>
    (name && byName.get(name)) || n.parent;

  // Iterate to a fixpoint. Each pass places any node whose size is known and whose
  // referenced frames are already placed.
  for (let pass = 0; pass < all.length + 4; pass++) {
    let progressed = false;
    for (const n of all) {
      if (n.placed) continue;
      const { setAllPoints, points } = readPoints(n.frame);

      if (setAllPoints && n.parent?.placed) {
        n.x = n.parent.x; n.y = n.parent.y; n.w = n.parent.w; n.h = n.parent.h;
        n.placed = true; progressed = true; continue;
      }

      // Need a size before a single anchor can place us. Inherit parent's if unset.
      if (Number.isNaN(n.w) || Number.isNaN(n.h)) {
        // Two opposing points can derive the size (rare in the menu, common elsewhere).
        if (points.length >= 2) {
          const ok = points.every((pt) => relOf(n, pt.relName)?.placed);
          if (ok) { placeByTwoPoints(n, points, relOf); progressed = true; continue; }
        }
        // An ANCHORED TEXT frame with no Height is one LINE tall, not as tall as whatever
        // contains it — the engine auto-sizes TEXT to its string, so the FDF omits the size.
        // Inheriting the parent's height instead is invisible on a centred label (the box
        // grows symmetrically about the anchor) but wrong the moment anything anchors BELOW
        // one: LocalMultiplayerJoin chains title → label → editbox → list down a ladder of
        // BOTTOMLEFTs, and a full-height title pushed the list 1300px off a 625px screen.
        //
        // An UNANCHORED one is a different animal and must keep filling its parent. That is
        // the frame the ENGINE positions rather than the file: a button's label declares
        // neither size nor SetPoint (StandardButtonTextTemplate carries only a font and
        // JUSTIFYCENTER/JUSTIFYMIDDLE), and it is those justifications, applied across the
        // whole button, that centre the caption. Give it one line instead and every button
        // in the game wears its text jammed against the top edge.
        // An ANCHORED TEXT frame is auto-sized by the engine in whichever axis the file
        // leaves out, so measure its string and supply them. The guard is that it must be
        // ANCHORED: an unanchored TEXT frame is the one the ENGINE positions (a button's
        // caption, which declares neither size nor SetPoint) and must keep filling its
        // parent, or every button in the game wears a shrink-wrapped label jammed into its
        // top-left corner.
        if (n.frame.type === "TEXT" && points.length) {
          const measured = measure?.(n.frame);
          if (Number.isNaN(n.w) && measured !== undefined) n.w = measured;
          if (Number.isNaN(n.h)) {
            // A frame that declares a Width but no Height WRAPS to it, and its height is
            // however many lines that takes. AllianceDialog's column headers are the case:
            // "Share Vision" over a 0.0375-wide box is two lines, and one line tall clips
            // the second — which is exactly how the game draws that header, stacked.
            const lines = measured !== undefined && n.w > 0
              ? Math.max(1, Math.ceil(measured / n.w - 0.01)) // ε: a self-measured box is 1
              : 1;
            n.h = lines * textLineHeight(n.frame);
          }
        }
        if (n.parent?.placed) {
          if (Number.isNaN(n.w)) { n.w = n.parent.w; n.fabricatedWidth = true; }
          if (Number.isNaN(n.h)) n.h = n.parent.h;
        } else continue;
      }

      if (!points.length) {
        // No anchor and not SetAllPoints: sit at the parent's top-left.
        if (n.parent?.placed) {
          n.x = n.parent.x; n.y = n.parent.y + n.parent.h - n.h;
          n.placed = true; progressed = true;
        }
        continue;
      }

      const pt = points[0];
      const rel = relOf(n, pt.relName);
      if (!rel?.placed) continue;
      const lx = rel.x + fx(pt.relPoint) * rel.w + pt.dx;
      const ly = rel.y + fy(pt.relPoint) * rel.h + pt.dy;
      n.x = lx - fx(pt.myPoint) * n.w;
      n.y = ly - fy(pt.myPoint) * n.h;
      // A TEXT frame whose width we invented is standing in for one the engine would have
      // shrink-wrapped; the anchor, not the file's justification, is what centres it.
      if (n.fabricatedWidth && n.frame.type === "TEXT") {
        const f = fx(pt.myPoint);
        n.autoJustifyH = f === 0 ? "JUSTIFYLEFT" : f === 1 ? "JUSTIFYRIGHT" : "JUSTIFYCENTER";
      }
      n.placed = true; progressed = true;
    }
    if (!progressed) break;
  }

  // Anything still unplaced (dangling reference): pin to its parent's top-left so it
  // still renders rather than vanishing.
  for (const n of all) {
    if (n.placed) continue;
    if (Number.isNaN(n.w)) n.w = n.parent?.w ?? 0;
    if (Number.isNaN(n.h)) n.h = n.parent?.h ?? 0;
    n.x = n.parent?.x ?? 0;
    n.y = (n.parent ? n.parent.y + n.parent.h : UI_HEIGHT) - n.h;
    n.placed = true;
  }

  return { tree, byName };
}

function placeByTwoPoints(
  n: LaidOutFrame,
  points: PointSpec[],
  relOf: (n: LaidOutFrame, name: string | null) => LaidOutFrame | null,
): void {
  // Resolve each point to a world location, then fit x/y/w/h so both are satisfied.
  const loc = points.map((pt) => {
    const rel = relOf(n, pt.relName)!;
    return { p: pt.myPoint, x: rel.x + fx(pt.relPoint) * rel.w + pt.dx, y: rel.y + fy(pt.relPoint) * rel.h + pt.dy };
  });
  const xs = loc.map((l) => ({ f: fx(l.p), v: l.x }));
  const ys = loc.map((l) => ({ f: fy(l.p), v: l.y }));
  // origin + f·size = v. Two points with different fractions give size and origin;
  // otherwise keep the fallback size and anchor by the first point.
  const solve1D = (pts: { f: number; v: number }[], fallbackSize: number): [number, number] => {
    const a = pts[0];
    const b = pts.find((p) => p.f !== a.f);
    if (!b) return [a.v - a.f * fallbackSize, fallbackSize];
    const size = (b.v - a.v) / (b.f - a.f);
    return [a.v - a.f * size, size];
  };
  [n.x, n.w] = solve1D(xs, Number.isNaN(n.w) ? 0 : n.w);
  [n.y, n.h] = solve1D(ys, Number.isNaN(n.h) ? 0 : n.h);
  n.placed = true;
}

/**
 * Fit the UI to the viewport. The UI is scaled by HEIGHT (0.6 → screen height) and
 * fills the full width — the world space becomes `worldW × 0.6` where worldW = the
 * viewport's aspect × 0.6. So a frame anchored to the root's TOPRIGHT lands on the
 * SCREEN's right edge (like WC3's own widescreen glue), instead of on the right edge
 * of a centred 4:3 box. Pass `worldW` as the root frame's width to `layout()`.
 */
export function fitBox(viewportW: number, viewportH: number): { scale: number; worldW: number } {
  const scale = viewportH / UI_HEIGHT; // height-based → fills the screen height, no letterbox
  return { scale, worldW: viewportW / scale };
}

/** World rect (y-up, bottom-left origin) → CSS pixel rect (y-down, top-left origin). */
export function toPixels(
  n: LaidOutFrame,
  fit: { scale: number },
): { left: number; top: number; width: number; height: number } {
  return {
    left: n.x * fit.scale,
    top: (UI_HEIGHT - (n.y + n.h)) * fit.scale,
    width: n.w * fit.scale,
    height: n.h * fit.scale,
  };
}

// Re-export a couple accessors the renderer wants without re-importing from library.
export { firstProp };
