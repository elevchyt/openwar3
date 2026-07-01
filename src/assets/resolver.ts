import type { DataSource } from "../vfs/types";
import type { Renderable } from "../render/renderer";

// Asset resolver with a fallback chain (plan §2):
//     user's install (OPFS) → CC0 pack (later) → built-in primitives
// Nothing in the engine hard-references a Blizzard asset path; everything routes
// through here, so the same code runs authentic (with an install) or on primitives.

export class AssetResolver {
  constructor(private install: DataSource | null = null) {}

  /** True once a legally-owned install has been imported to OPFS. */
  get hasInstall(): boolean {
    return this.install !== null;
  }

  setInstall(source: DataSource | null): void {
    this.install = source;
  }

  /** The mounted install VFS, or null if none imported yet. */
  get installSource(): DataSource | null {
    return this.install;
  }

  /** Resolve a logical asset path to something drawable — always returns a value. */
  resolveModel(path: string): Renderable {
    if (this.install?.exists(path)) {
      return { kind: "model", path };
    }
    // TODO: CC0 pack layer (plan §2) slots in here before the primitive fallback.
    return { kind: "primitive", shape: "box" };
  }
}
