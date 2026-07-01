// Thin renderer interface — the rest of the engine talks only to this.
// Phase 0 backs it with a WebGL placeholder (see placeholder.ts). Later phases
// swap in mdx-m3-viewer's renderer without touching sim or asset code (plan §1.1).

export interface Renderer {
  /** Start the render loop. */
  start(): void;
  /** Stop the render loop and release GPU resources. */
  stop(): void;
}

/** A drawable resolved from the asset chain: a real model, or a fallback primitive (plan §2). */
export type Renderable =
  | { kind: "primitive"; shape: "box" | "capsule" }
  | { kind: "model"; path: string };
