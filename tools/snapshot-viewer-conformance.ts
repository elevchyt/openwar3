// Compile-time only: does a real `Viewpoint` still answer everything a snapshot asks of it?
//
// `SnapshotViewer` (docs/multiplayer.md Phase E items 5–6) is a STRUCTURAL type on purpose —
// `src/game/snapshot.ts` must not import the viewpoint, or the authority's payload builder
// grows a dependency on the fog implementation and a test can no longer hand it a five-line
// stub. The cost of that choice is that nothing makes the two agree: the snapshot's stub
// satisfies the interface by construction, so `SnapshotViewer` could drift away from
// `Viewpoint` and every suite would stay green until the two were finally wired together at
// item 9/10 — which is the worst possible moment to discover it.
//
// This file is the guard, and it lives in `tools/` rather than in `src/` for the same reason
// the interface is structural: it is a TEST of the relationship, not a dependency between the
// two modules. `tsc -p tools/tsconfig.sim.json` compiles it on every `pnpm sim:test`, and it
// emits nothing anyone runs.
//
// It fails loudly the moment a method is added to `SnapshotViewer` that `Viewpoint` does not
// have, or one is renamed on `Viewpoint` without the interface following.
import type { Viewpoint } from "../src/game/viewpoint";
import type { SnapshotViewer } from "../src/game/snapshot";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _viewpointIsASnapshotViewer: SnapshotViewer = null as unknown as Viewpoint;

export {};
