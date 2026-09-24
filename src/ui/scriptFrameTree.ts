// A map's own frames (compat/frames.ts) as ONE FDF tree, for the solver and the renderer the
// game's own panels already use (ui/fdf/layout.ts, ui/fdf/render.ts). Pure — no DOM — so the
// shape of it is testable in Node (tools/jass-frames-test.cjs); ui/scriptFrames.ts
// mounts what this returns.
//
// Everything a script sets becomes the FDF property the file would have written for it:
// a size is `Width`/`Height`, an anchor is `SetPoint`, a BACKDROP's texture is
// `BackdropBackground`. A STAMPED frame (`BlzCreateFrame("BoxedText", …)`) starts from its
// template, cloned under a per-instance suffix (`cloneNamespaced`) so two tooltips' "Title"
// children stay two frames, and the script's changes are laid over the template's.
//
// Three readings of the API that decide where things land, each checked against the one map
// in the corpus that draws a panel (Test of Balance's InitMB):
//
//  * An ABSOLUTE point is measured from the bottom-left of the 0.8 × 0.6 box centred on the
//    screen — the 4:3 area the whole UI is authored in — and not from the screen's own corner.
//    A frame may sit outside that box on a wide screen: Test of Balance's panel runs to x 0.936
//    and its toggle button sits at 0.9084, both past 0.8, parented to `ConsoleUIBackdrop`
//    ("Most custom created Frames from the Frame group can not leave the 4:3 part of the
//    screen" — Tasyen, The Big UI-Frame Tutorial, hiveworkshop pastebin 20598 — which is why a
//    map hangs them on that frame). A frame from the FRAME group on any other parent is held to
//    the box — "If a part of them leave it, they become malformed … A TEXT-Frame might cut off
//    some chars. A BACKDROP becomes smaller" (same tutorial) — which the drawing reproduces by
//    clipping it there (`clipped`). SimpleFrames are "unrestricted", and the tutorial names the
//    Leaderboard and Multiboard frames as parents that free a frame too.
//  * `BlzFrameSetScale` scales the frame — its size, its font and the offsets of its points
//    ("BlzFrameSetScale of the moved frame affect the x&y offset", same tutorial) — and its
//    children with it. An ABSOLUTE position is a place on the screen and is not scaled.
//  * A TEXT made by type names no font. It takes the renderer's own default height (0.013,
//    ui/fdf/render.ts `paintText`), which is ours: nothing we have read states the engine's.

import { cloneNamespaced, type FdfLibrary } from "./fdf/library";
import type { Arg, FdfFrame, FdfProp } from "./fdf/parser";
import type { FrameModel, FrameObj } from "../jass/index";

/** FRAMEPOINT_* in common.j's order (ConvertFramePointType 0..8). */
const POINTS = ["TOPLEFT", "TOP", "TOPRIGHT", "LEFT", "CENTER", "RIGHT", "BOTTOMLEFT", "BOTTOM", "BOTTOMRIGHT"];

/** The renderer's default text height, for a TEXT the script made by type (see the header). */
const DEFAULT_TEXT_HEIGHT = 0.013;

export const SCRIPT_UI_ROOT = "__ScriptUIRoot";
/** The 0.8 × 0.6 box an absolute point is measured in, centred on the screen. */
export const SCRIPT_UI_43 = "__ScriptUI43";

export interface ScriptFrameTree {
  root: FdfFrame;
  /** frame handle → its FDF name in this tree (only frames that are drawn). */
  names: Map<number, string>;
  /** FDF name → the literal text the script set. Handed to the renderer as text OVERRIDES, so a
   *  string that happens to match a GlobalStrings key is not translated into another one. */
  texts: Record<string, string>;
  /** (owner, tooltip) FDF names: the tooltip is drawn only while its owner is hovered. */
  tooltips: Array<{ owner: string; tip: string }>;
  /** Frames the drawing must listen on: a button (clickable) or one a trigger watches. */
  listen: Array<{ name: string; handle: number; events: number[]; button: boolean }>;
  /** FDF name → CSS opacity, for the frames a script faded (BlzFrameSetAlpha). */
  alpha: Record<string, number>;
  /** Controls the script disabled. */
  disabled: string[];
  /** The FDF name of the box the 4:3-bound frames are drawn inside, which clips them. */
  clipped: string;
}

/** Game frames a map may hang its own on to let them leave the 4:3 area (see the header). */
const FREEING_PARENTS = new Set(["ConsoleUIBackdrop", "Leaderboard", "Multiboard"]);

const str = (s: string): Arg => ({ s, n: null, str: true });
const word = (s: string): Arg => ({ s, n: null, str: false });
const num = (n: number): Arg => ({ s: String(n), n, str: false });

const withoutKeys = (f: FdfFrame, keys: string[]): FdfProp[] => f.props.filter((p) => !keys.includes(p.key));
const setProp = (f: FdfFrame, key: string, args: Arg[]): void => {
  f.props = withoutKeys(f, [key]);
  f.props.push({ key, args });
};
const scaleArg = (a: Arg, s: number): Arg => (a.n === null ? a : num(a.n * s));

/** Scale every size-like number a stamped node carries: its box, its font, its anchors'
 *  offsets and its backdrop's border. */
function scaleNode(f: FdfFrame, s: number): void {
  if (s === 1) return;
  f.props = f.props.map((p) => {
    switch (p.key) {
      case "Width":
      case "Height":
      case "BackdropCornerSize":
      case "BackdropBackgroundInsets":
      case "BackdropBackgroundSize":
        return { key: p.key, args: p.args.map((a) => scaleArg(a, s)) };
      case "FrameFont":
      case "Font":
        return { key: p.key, args: p.args.map((a, i) => (i === 1 ? scaleArg(a, s) : a)) };
      case "SetPoint": {
        // (myPoint, "rel", relPoint, dx, dy): the two numbers at the end are the offsets.
        const args = p.args.slice();
        for (let i = args.length - 2; i < args.length; i++) if (i >= 0) args[i] = scaleArg(args[i], s);
        return { key: p.key, args };
      }
      default:
        return p;
    }
  });
}

export function buildScriptFrameTree(model: FrameModel, lib: FdfLibrary): ScriptFrameTree {
  const out: ScriptFrameTree = {
    root: { type: "FRAME", name: SCRIPT_UI_ROOT, inherits: null, withChildren: false, props: [], children: [] },
    names: new Map(), texts: {}, tooltips: [], listen: [], alpha: {}, disabled: [], clipped: SCRIPT_UI_43,
  };
  out.root.children.push({
    type: "FRAME", name: SCRIPT_UI_43, inherits: null, withChildren: false,
    props: [
      { key: "Width", args: [num(0.8)] },
      { key: "Height", args: [num(0.6)] },
      { key: "SetPoint", args: [word("CENTER"), str(SCRIPT_UI_ROOT), word("CENTER"), num(0), num(0)] },
    ],
    children: [],
  });

  const frames = model.frames;
  const childrenOf = new Map<number, FrameObj[]>();
  for (const f of frames.values()) {
    const list = childrenOf.get(f.parent);
    if (list) list.push(f);
    else childrenOf.set(f.parent, [f]);
  }
  const shown = (f: FrameObj): boolean => {
    for (let x: FrameObj | undefined = f, n = 0; x && n < 64; x = frames.get(x.parent), n++) if (!x.visible) return false;
    return true;
  };
  const scaleOf = (f: FrameObj): number => {
    let s = 1;
    for (let x: FrameObj | undefined = f, n = 0; x && n < 64; x = frames.get(x.parent), n++) s *= x.scale || 1;
    return s;
  };

  // Names first, for every frame that will be drawn: an anchor may point at a frame built later.
  const nameOf = (f: FrameObj): string => (f.instance ? `${f.name}__${f.instance}` : `__f${f.handleId}`);
  for (const f of frames.values()) if (!f.origin && shown(f)) out.names.set(f.handleId, nameOf(f));

  /** Lay the script's own changes over a node (a stamped one, or one made by type). */
  const apply = (node: FdfFrame, f: FrameObj, byType: boolean): void => {
    const s = scaleOf(f);
    if (!byType) scaleNode(node, s);
    if (f.sized) {
      setProp(node, "Width", [num(f.width * s)]);
      setProp(node, "Height", [num(f.height * s)]);
    }
    if (f.cleared) node.props = withoutKeys(node, ["SetPoint", "SetAllPoints", "Anchor"]);
    for (const p of f.points) {
      const mine = POINTS[p.point] ?? "TOPLEFT";
      node.props = node.props.filter((q) => !(q.key === "SetPoint" && q.args[0]?.s === mine));
      if (p.relative === 0) {
        // Absolute: from the bottom-left of the centred 4:3 box, unscaled (see the header).
        node.props.push({ key: "SetPoint", args: [word(mine), str(SCRIPT_UI_43), word("BOTTOMLEFT"), num(p.x), num(p.y)] });
        continue;
      }
      const rel = out.names.get(p.relative);
      if (!rel) continue; // anchored to a frame that is not drawn (or is the game's own)
      node.props.push({ key: "SetPoint", args: [word(mine), str(rel), word(POINTS[p.relativePoint] ?? mine), num(p.x * s), num(p.y * s)] });
    }
    if (f.textSet) out.texts[node.name] = f.text;
    // A SIMPLE frame's picture is a `Texture` child, and its image is that block's `File`.
    if (f.textureSet && node.type === "TEXTURE") setProp(node, "File", [str(f.texture.replace(/\//g, "\\"))]);
    if (f.textureSet && node.type === "BACKDROP") {
      setProp(node, "BackdropBackground", [str(f.texture.replace(/\//g, "\\"))]);
      // A script's texture is a PATH, never a skin key, and a typed backdrop has no border:
      // one picture stretched over the box.
      if (byType) setProp(node, "BackdropBlendAll", []);
    }
    if (byType && node.type === "TEXT" && !node.props.some((p) => p.key === "FrameFont")) {
      node.props.push({ key: "FrameFont", args: [str("MasterFont"), num(DEFAULT_TEXT_HEIGHT * s), str("")] });
    }
    if (f.alpha < 255) out.alpha[node.name] = Math.max(0, f.alpha) / 255;
    if (!f.enabled) out.disabled.push(node.name);
    if (f.tooltip && out.names.has(f.tooltip)) out.tooltips.push({ owner: node.name, tip: out.names.get(f.tooltip)! });
    const events = model.events.get(f.handleId);
    const button = /BUTTON$/.test(node.type);
    if (button || events?.size || f.tooltip) out.listen.push({ name: node.name, handle: f.handleId, events: [...(events ?? [])], button });
  };

  /** The script's own children of `f` (not a stamped instance's inner frames). */
  const scriptChildren = (f: FrameObj): FrameObj[] =>
    (childrenOf.get(f.handleId) ?? []).filter((c) => !c.origin && (c.instance === 0 || c.instance === c.handleId) && out.names.has(c.handleId));

  const build = (f: FrameObj): FdfFrame | null => {
    let node: FdfFrame;
    if (f.instance === f.handleId && f.template) {
      const tmpl = lib.resolveRoot(f.template);
      if (tmpl) {
        node = cloneNamespaced(tmpl, `__${f.handleId}`);
        // The inner frames: each named one is a frame of the model, found by the name it was
        // stamped under, and takes the script's changes; a hidden one leaves the tree.
        const inner = new Map<string, FrameObj>();
        for (const c of frames.values()) if (c.instance === f.handleId && c !== f) inner.set(`${c.name}__${f.handleId}`, c);
        const visit = (n: FdfFrame): void => {
          n.children = n.children.filter((child) => {
            const obj = child.name ? inner.get(child.name) : undefined;
            if (obj && !out.names.has(obj.handleId)) return false;
            if (obj) {
              apply(child, obj, false);
              for (const sc of scriptChildren(obj)) {
                const built = build(sc);
                if (built) child.children.push(built);
              }
            } else {
              scaleNode(child, scaleOf(f));
            }
            visit(child);
            return true;
          });
        };
        visit(node);
      } else {
        node = { type: "FRAME", name: "", inherits: null, withChildren: false, props: [], children: [] };
      }
      node.name = out.names.get(f.handleId)!;
      apply(node, f, false);
    } else {
      const base = f.inherits ? lib.resolveRoot(f.inherits) : undefined;
      node = {
        type: f.type || base?.type || "FRAME", name: out.names.get(f.handleId)!, inherits: null, withChildren: false,
        props: base ? base.props.map((p) => ({ key: p.key, args: p.args.slice() })) : [], children: [],
      };
      if (base) scaleNode(node, scaleOf(f));
      apply(node, f, !base);
    }
    for (const c of scriptChildren(f)) {
      const built = build(c);
      if (built) node.children.push(built);
    }
    return node;
  };

  // The top of every chain the script built: a frame hung on the game's own UI (an origin
  // frame, or nothing at all).
  for (const f of frames.values()) {
    if (f.origin || !out.names.has(f.handleId)) continue;
    if (f.instance !== 0 && f.instance !== f.handleId) continue; // drawn inside its instance
    const parent = frames.get(f.parent);
    if (parent && !parent.origin) continue; // drawn under its parent
    const built = build(f);
    if (!built) continue;
    const free = /^SIMPLE/.test(built.type) || (!!parent && FREEING_PARENTS.has(parent.name));
    // Free frames hang off the screen root; everything else is drawn inside the 4:3 box, which
    // clips it — the child's anchors name the box by name either way, so nothing moves.
    (free ? out.root : out.root.children[0]).children.push(built);
  }
  return out;
}
