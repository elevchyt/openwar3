import { parseWar3Skins, skinValue, WAR3SKINS } from "../../data/war3skins";
import type { DataSource } from "../../vfs/types";
import { parseFdf, type FdfFrame, type FdfProp } from "./parser";

// Loads .fdf files through the mounted VFS, following `IncludeFile` and the shared
// `GlobalStrings.fdf` the game loads first (via FrameDef.toc), then resolves the
// template/INHERITS system into concrete frames. This is the "read UI FrameDef
// files and construct the UIs" half of issue #54; layout/render is the other half.

const GLOBAL_STRINGS = "UI\\FrameDef\\GlobalStrings.fdf";

function cloneFrame(f: FdfFrame): FdfFrame {
  return {
    type: f.type,
    name: f.name,
    inherits: f.inherits,
    withChildren: f.withChildren,
    props: f.props.map((pr) => ({ key: pr.key, args: pr.args.slice() })),
    children: f.children.map(cloneFrame),
  };
}

export class FdfLibrary {
  private templates = new Map<string, FdfFrame>(); // exact name → frame
  private lowered = new Map<string, FdfFrame>(); // lowercased name → frame (fallback)
  readonly strings = new Map<string, string>();
  private loaded = new Set<string>();
  /** The DecorateFileNames skin table (UI\war3skins.txt): section → key → BLP path. */
  private skins = new Map<string, Map<string, string>>();
  /** Which race's chrome to decorate with — WC3 skins the in-game panels by the local
   *  player's race (an Orc player's dialogs are Orc-bordered). "Default" is Human. */
  skin = "Default";

  constructor(private vfs: DataSource) {}

  /** Load GlobalStrings + the skin table + the given screen file (and their includes). */
  async load(path: string): Promise<void> {
    await this.loadFile(GLOBAL_STRINGS);
    await this.loadSkins();
    await this.loadFile(path);
  }

  /** Load UI\war3skins.txt — the table behind the FDF `DecorateFileNames` flag. A frame
   *  marked with it names its textures by KEY ("EscMenuEditBoxBackground"), not by path,
   *  and the engine looks the key up here. Without it the in-game panels (leaderboard,
   *  dialogs, quest log) render with no chrome at all — their backdrops resolve to
   *  nothing. `[Default]` carries the full table (Human's art); each race section
   *  overrides a handful of entries, which is how an Orc player gets Orc borders.
   *  (The same file also holds the music playlists — see src/data/war3skins.ts.) */
  private async loadSkins(): Promise<void> {
    if (this.skins.size || !this.vfs.exists(WAR3SKINS)) return;
    this.skins = parseWar3Skins(new TextDecoder("latin1").decode(await this.vfs.read(WAR3SKINS)));
  }

  /** Resolve a `DecorateFileNames` texture key to its real BLP path: the current skin's
   *  entry, else `[Default]`'s. A name that is already a path (no entry) passes through —
   *  the glue screens name their textures literally and must keep working. */
  decorate(nameOrKey: string): string {
    return skinValue(this.skins, this.skin, nameOrKey) ?? nameOrKey;
  }

  private async loadFile(path: string): Promise<void> {
    const key = path.toLowerCase();
    if (this.loaded.has(key)) return;
    this.loaded.add(key);
    if (!this.vfs.exists(path)) return; // GlobalStrings/includes are always present, but be safe
    const bytes = await this.vfs.read(path);
    const src = new TextDecoder("latin1").decode(bytes); // FDF is 8-bit ASCII/Latin-1
    const file = parseFdf(src);
    // Includes first, so their templates are registered before this file uses them.
    for (const inc of file.includes) await this.loadFile(inc);
    for (const [k, v] of file.strings) if (!this.strings.has(k)) this.strings.set(k, v);
    for (const frame of file.frames) this.register(frame);
  }

  /** Register a frame and its nested named frames as reusable templates. */
  private register(frame: FdfFrame): void {
    if (frame.name) {
      if (!this.templates.has(frame.name)) this.templates.set(frame.name, frame);
      const lc = frame.name.toLowerCase();
      if (!this.lowered.has(lc)) this.lowered.set(lc, frame);
    }
    for (const child of frame.children) this.register(child);
  }

  /** Find a named frame/template (case-insensitive fallback). */
  template(name: string): FdfFrame | undefined {
    return this.templates.get(name) ?? this.lowered.get(name.toLowerCase());
  }

  /** Resolve a screen root by name into a concrete, inheritance-flattened frame. */
  resolveRoot(name: string): FdfFrame | undefined {
    const f = this.template(name);
    return f ? this.resolve(f) : undefined;
  }

  /** Flatten INHERITS: merge the template's props/children under the frame's own. */
  resolve(frame: FdfFrame, depth = 0): FdfFrame {
    if (depth > 64) return cloneFrame(frame); // guard against pathological cycles
    let base: FdfFrame | null = null;
    if (frame.inherits) {
      const tmpl = this.template(frame.inherits);
      if (tmpl) base = this.resolve(tmpl, depth + 1);
    }
    const out: FdfFrame = {
      type: frame.type || base?.type || "FRAME",
      // A frame's NAME is its own. INHERITS copies props and children, never identity — and
      // letting an ANONYMOUS block fall back to its template's name is not merely untidy, it
      // makes same-template siblings collide: the merge below replaces a same-named child, so
      // the resource bar's three `Texture INHERITS "ResourceBarIconTemplate"` icons all
      // resolved to that one name and only the last of them survived. Gold and lumber simply
      // had no icon.
      name: frame.name,
      inherits: null,
      withChildren: false,
      props: mergeProps(base?.props ?? [], frame.props),
      children: [],
    };
    // Children: WITHCHILDREN clones the template's subtree; own children override
    // a same-named inherited child, otherwise append.
    const children: FdfFrame[] = frame.withChildren && base ? base.children.map(cloneFrame) : [];
    for (const child of frame.children) {
      const resolved = this.resolve(child, depth + 1);
      const idx = resolved.name ? children.findIndex((c) => c.name === resolved.name) : -1;
      if (idx >= 0) children[idx] = resolved;
      else children.push(resolved);
    }
    // Resolve any inherited-but-not-yet-flattened children (from WITHCHILDREN clones).
    out.children = children.map((c) => (c.inherits ? this.resolve(c, depth + 1) : c));
    return out;
  }

  /** Resolve a Text value: a string-table key wins, else the literal text. */
  string(keyOrLiteral: string): string {
    return this.strings.get(keyOrLiteral) ?? keyOrLiteral;
  }
}

/** Base props overlaid by own props: own replaces ALL base entries of the same key. */
function mergeProps(base: FdfProp[], own: FdfProp[]): FdfProp[] {
  if (!base.length) return own.map((pr) => ({ key: pr.key, args: pr.args.slice() }));
  const ownKeys = new Set(own.map((pr) => pr.key));
  const out = base.filter((pr) => !ownKeys.has(pr.key)).map((pr) => ({ key: pr.key, args: pr.args.slice() }));
  for (const pr of own) out.push({ key: pr.key, args: pr.args.slice() });
  return out;
}

// --- small typed accessors over a resolved frame's props -------------------------

export function firstProp(frame: FdfFrame, key: string): FdfProp | undefined {
  return frame.props.find((p) => p.key === key);
}
export function allProps(frame: FdfFrame, key: string): FdfProp[] {
  return frame.props.filter((p) => p.key === key);
}
export function hasFlag(frame: FdfFrame, key: string): boolean {
  return frame.props.some((p) => p.key === key);
}
export function numProp(frame: FdfFrame, key: string): number | undefined {
  const pr = firstProp(frame, key);
  return pr && pr.args[0]?.n != null ? pr.args[0].n : undefined;
}
export function strProp(frame: FdfFrame, key: string): string | undefined {
  return firstProp(frame, key)?.args[0]?.s;
}
export function findChild(frame: FdfFrame, name: string): FdfFrame | undefined {
  return frame.children.find((c) => c.name === name);
}

/**
 * `DecorateFileNames` is INHERITED by everything under the frame that declares it.
 *
 * The glue screens always put it on the frame that also names the texture, so it read like a
 * per-frame flag. The console's frames do not: `ConsoleUI` and `ResourceBarFrame` declare it
 * once and then hang a dozen anonymous `Texture` children off it, each naming a skin KEY
 * ("ConsoleTexture01", "GoldIcon"). Checked only on the frame itself, every one of those
 * resolves to a path that does not exist and the whole strip renders as bare text.
 *
 * Push it down the tree once, after INHERITS is flattened and before anything is drawn, so
 * nothing downstream has to carry an ancestor flag around.
 */
export function propagateDecorate(frame: FdfFrame, inherited = false): void {
  const own = inherited || frame.props.some((p) => p.key === "DecorateFileNames");
  if (own && !inherited) {
    // already declared here; nothing to add
  } else if (own) {
    frame.props.push({ key: "DecorateFileNames", args: [] });
  }
  for (const child of frame.children) propagateDecorate(child, own);
}

/** Props whose first argument NAMES another frame, and so must follow a rename. */
const NAME_REFS = new Set([
  "ButtonText", "ControlBackdrop", "ControlPushedBackdrop", "ControlDisabledBackdrop",
  "ControlDisabledPushedBackdrop", "ControlMouseOverHighlight", "ControlFocusHighlight",
  "CheckBoxCheckHighlight", "CheckBoxDisabledCheckHighlight",
  "PopupTitleFrame", "PopupArrowFrame", "PopupMenuFrame",
  "TextAreaScrollBar", "SliderThumbButtonFrame",
  "ScrollBarIncButtonFrame", "ScrollBarDecButtonFrame", "DialogBackdrop",
]);

/**
 * Clone a template subtree under a per-instance suffix — what the engine does every time it
 * stamps a repeated row out of one definition (an `AllianceSlot` per player, a
 * `ScriptDialogButton` per DialogAddButton, a `QuestListItem` per quest).
 *
 * Renaming is not cosmetic: the layout solver indexes frames by name across the WHOLE
 * screen, so two rows sharing a child called "AllyCheckBox" collide and which one a name
 * resolves to comes down to render order. Both kinds of reference travel with the rename:
 *
 *   • the `Control*`/`CheckBox*`/… props above, which name a sibling outright, and
 *   • **`SetPoint`'s relative-frame argument** — the one a per-button cloner can skip and a
 *     ROW cloner cannot, because a row is a chain of siblings anchored off each other
 *     ("SetPoint LEFT, \"AllyCheckBox\", RIGHT, …"). Left alone, every row's boxes anchor to
 *     row zero's and the whole grid collapses onto one line.
 *
 * Only names DEFINED INSIDE the subtree are rewritten, so a SetPoint that reaches out to the
 * enclosing dialog still finds it.
 */
export function cloneNamespaced(frame: FdfFrame, suffix: string): FdfFrame {
  const owned = new Set<string>();
  (function collect(f: FdfFrame): void {
    if (f.name) owned.add(f.name);
    f.children.forEach(collect);
  })(frame);

  const rename = (name: string): string => (owned.has(name) ? `${name}${suffix}` : name);
  const walk = (src: FdfFrame): FdfFrame => ({
    type: src.type,
    name: src.name ? `${src.name}${suffix}` : "",
    inherits: null,
    withChildren: false,
    props: src.props.map((pr) => {
      const args = pr.args.slice();
      if (NAME_REFS.has(pr.key) && args[0]?.str) args[0] = { ...args[0], s: rename(args[0].s) };
      else if (pr.key === "SetPoint" && args[1]?.str) args[1] = { ...args[1], s: rename(args[1].s) };
      return { key: pr.key, args };
    }),
    children: src.children.map(walk),
  });
  return walk(frame);
}
