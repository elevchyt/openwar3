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

  constructor(private vfs: DataSource) {}

  /** Load GlobalStrings + the given screen file (and everything they include). */
  async load(path: string): Promise<void> {
    await this.loadFile(GLOBAL_STRINGS);
    await this.loadFile(path);
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
      name: frame.name || base?.name || "",
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
