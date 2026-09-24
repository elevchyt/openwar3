// The map's own frames, on screen (docs/map-compatibility.md — Test of Balance's panel).
//
// The model is compat/frames.ts; the tree is ui/scriptFrameTree.ts; this mounts that tree with
// the same `mountFdfScreen` the leaderboard and the dialogs use, so a stamped `BoxedText` is
// drawn by the code that draws the game's own tooltip-bordered panels, out of the map's .fdf
// laid over the install's.
//
// Two kinds of change, two costs. Anything that moves or reveals a frame bumps the model's
// `revision` and rebuilds the screen — throttled, and swapped only once the new one is up, as
// the leaderboard does. TEXT bumps only `textRevision`, and is patched into the frames already
// on screen: Test of Balance rewrites a player's damage total on every blow, and rebuilding a
// panel per blow would be the whole cost of the frame.
//
// The mouse: a BUTTON takes the pointer and raises FRAMEEVENT_CONTROL_CLICK; a frame with a
// TOOLTIP takes it too, and its tooltip frame is drawn only while it is hovered — the engine's
// behaviour for `BlzFrameSetTooltip`, and the whole of how Test of Balance shows a skill's name
// over its icon. Mouse enter/leave are raised for a frame a trigger registered them on.

import type { FrameModel } from "../jass/index";
import type { DataSource } from "../vfs/types";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { buildScriptFrameTree, SCRIPT_UI_ROOT, type ScriptFrameTree } from "./scriptFrameTree";

/** common.j's FRAMEEVENT_CONTROL_CLICK / _MOUSE_ENTER / _MOUSE_LEAVE (ConvertFrameEventType). */
const CONTROL_CLICK = 1;
const MOUSE_ENTER = 2;
const MOUSE_LEAVE = 3;

/** How often a changing panel may be rebuilt. Ours: a rebuild is a whole FDF mount. */
const REBUILD_MS = 100;

/** Any FDF the screen must load for its strings; the map's own are laid over it at build. */
const STRINGS_FDF = "UI\\FrameDef\\GlobalStrings.fdf";

export class ScriptFrameOverlay {
  private screen: FdfScreen | null = null;
  /** The tree the screen on display was last built from (a resize rebuilds it). */
  private tree: ScriptFrameTree | null = null;
  /** The text overrides handed to the mount. The renderer reads this object at EVERY build,
   *  a resize's included, so a text patched in later is written here as well as on screen. */
  private texts: Record<string, string> = {};
  private mounting = false;
  private builtRevision = -1;
  private textRevision = -1;
  private lastBuild = 0;

  constructor(
    private container: HTMLElement,
    private files: () => DataSource,
    private skin: string,
    private onEvent: (frameHandle: number, eventIndex: number) => void,
  ) {}

  /** Poll, every frame. `model` null (or holding no frame of the map's) takes it down. */
  update(model: FrameModel | null): void {
    if (!model || !model.frames.size) {
      this.teardown();
      return;
    }
    if (model.revision !== this.builtRevision) {
      const now = performance.now();
      if (this.mounting || now - this.lastBuild < REBUILD_MS) return;
      this.lastBuild = now;
      void this.build(model);
      return;
    }
    if (model.textRevision !== this.textRevision && this.screen && this.tree) {
      this.textRevision = model.textRevision;
      for (const h of model.textChanged) {
        const name = this.tree.names.get(h);
        const f = model.frames.get(h);
        if (!name || !f) continue;
        this.texts[name] = f.text; // a later RESIZE rebuilds from these
        this.screen.setText(name, f.text);
      }
      model.textChanged.clear();
    }
  }

  private async build(model: FrameModel): Promise<void> {
    this.mounting = true;
    const revision = model.revision;
    const textRevision = model.textRevision;
    try {
      const prev = this.screen;
      const texts: Record<string, string> = {};
      const next = await mountFdfScreen({
        container: this.container,
        vfs: this.files(),
        fdfPath: STRINGS_FDF,
        rootFrame: SCRIPT_UI_ROOT,
        overlayClass: "fdf-ingame script-frames",
        skin: this.skin,
        // Per build, resize included: the model as it stands, and its texts copied into the
        // override object before the renderer reads it.
        buildRoot: (lib) => {
          for (const s of model.sources) lib.loadOverride(s.id, s.text);
          const tree = buildScriptFrameTree(model, lib);
          Object.assign(texts, tree.texts);
          this.tree = tree;
          return tree.root;
        },
        textOverrides: texts,
        onBuild: (screen) => this.wire(screen),
      });
      this.screen = next;
      this.texts = texts;
      model.textChanged.clear();
      this.builtRevision = revision;
      this.textRevision = textRevision;
      prev?.dispose(); // swap only once the new one is up, so the panel never blinks
    } catch (err) {
      console.warn("[script frames] could not mount the map's frames:", err);
      this.screen = null;
      this.builtRevision = model.revision; // do not retry a broken tree every frame
    } finally {
      this.mounting = false;
    }
  }

  /** Per build (and rebuild on resize): hide the tooltips, and hang the mouse on the frames
   *  that answer it. */
  private wire(screen: FdfScreen): void {
    const tree = this.tree;
    if (!tree) return;
    for (const { tip } of tree.tooltips) {
      const el = screen.frame(tip);
      if (el) el.style.visibility = "hidden";
    }
    for (const [name, opacity] of Object.entries(tree.alpha)) {
      const el = screen.frame(name);
      if (el) el.style.opacity = String(opacity);
    }
    for (const name of tree.disabled) screen.setEnabled(name, false);
    for (const l of tree.listen) {
      const el = screen.frame(l.name);
      if (!el) continue;
      el.style.pointerEvents = "auto";
      const tips = tree.tooltips.filter((t) => t.owner === l.name).map((t) => screen.frame(t.tip)).filter((x): x is HTMLElement => !!x);
      el.addEventListener("mouseenter", () => {
        for (const t of tips) t.style.visibility = "visible";
        if (l.events.includes(MOUSE_ENTER)) this.onEvent(l.handle, MOUSE_ENTER);
      });
      el.addEventListener("mouseleave", () => {
        for (const t of tips) t.style.visibility = "hidden";
        if (l.events.includes(MOUSE_LEAVE)) this.onEvent(l.handle, MOUSE_LEAVE);
      });
      if (l.button || l.events.includes(CONTROL_CLICK)) {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (el.classList.contains("fdf-disabled")) return;
          if (l.events.includes(CONTROL_CLICK)) this.onEvent(l.handle, CONTROL_CLICK);
        });
      }
    }
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.tree = null;
    this.builtRevision = -1;
    this.textRevision = -1;
  }

  dispose(): void {
    this.teardown();
  }
}
