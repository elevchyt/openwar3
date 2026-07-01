import type { DataSource } from "./types";

// Layered VFS (plan §1, §5). WC3 mounts several MPQs where later archives
// override earlier ones (war3patch overrides war3x overrides war3). We store
// layers highest-priority-first and return the first hit, mirroring that.

export class LayeredDataSource implements DataSource {
  /** @param layers ordered highest priority first. */
  constructor(private layers: DataSource[]) {}

  get label(): string {
    return `layered[${this.layers.map((l) => l.label).join(" > ")}]`;
  }

  exists(path: string): boolean {
    return this.layers.some((l) => l.exists(path));
  }

  async read(path: string): Promise<Uint8Array> {
    for (const layer of this.layers) {
      if (layer.exists(path)) return layer.read(path);
    }
    throw new Error(`Not found in any layer: ${path}`);
  }

  rawBytes(path: string): Uint8Array | null {
    for (const layer of this.layers) {
      const bytes = layer.rawBytes(path);
      if (bytes) return bytes;
    }
    return null;
  }

  list(): string[] {
    const all = new Set<string>();
    for (const layer of this.layers) for (const name of layer.list()) all.add(name);
    return [...all].sort();
  }
}
