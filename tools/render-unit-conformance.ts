// Compile-time only: do a `SimUnit` and a `UnitSnapshot` still answer everything the RENDERER
// asks of a unit? (docs/multiplayer.md Phase E item 10c-2b.)
//
// `RenderUnit` (src/game/renderUnit.ts) is a STRUCTURAL type on purpose: it imports nothing, so
// the animation resolver can be typed against it without dragging in either the sim struct or
// the wire payload. The cost of that choice is the same one `snapshot-viewer-conformance.ts`
// pays — nothing makes the three agree. `SimUnit` could rename a field, or `UnitSnapshot` could
// flatten one (it did: `repair` was `repairing` until this item), and every suite would stay
// green right up until a client tried to render a snapshot.
//
// These two lines are the guard. They fail the moment either struct stops satisfying the
// surface, which is the only moment worth failing at. Lives in `tools/` rather than `src/` for
// the same reason the type is structural: it is a TEST of the relationship, not a dependency
// between the modules. `tsc -p tools/tsconfig.sim.json` compiles it on every `pnpm sim:test`,
// and it emits nothing anyone runs.
import type { SimUnit } from "../src/sim/world";
import type { UnitSnapshot } from "../src/game/snapshot";
import type { RenderUnit } from "../src/game/renderUnit";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _simUnitIsARenderUnit: RenderUnit = null as unknown as SimUnit;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unitSnapshotIsARenderUnit: RenderUnit = null as unknown as UnitSnapshot;

export {};
