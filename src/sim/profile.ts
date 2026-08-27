/**
 * The sim's hole for a profiler, and nothing else.
 *
 * `src/sim/world.ts` must keep compiling **standalone**, to CommonJS, with no DOM and no
 * browser globals — that is what lets the headless sim tests drive SimWorld under plain Node
 * (tools/tsconfig.sim.json lists it as its own entry for exactly this reason). Importing
 * `src/dev/perfLog.ts` there would break that on the first line: it reads `import.meta.env`,
 * which is not even syntax under `module: CommonJS`.
 *
 * So the sim calls THIS, which knows nothing and does nothing, and the renderer plugs the real
 * recorder in when a match starts (see MapViewerScene.start). Under the headless tests the
 * hole stays empty and every call is a no-op function call — a few hundred per simulated
 * second, which is nothing beside the tick they are measuring.
 *
 * Names are the dotted sub-phase kind (`sim.world.units`): a breakdown of the span they sit
 * inside, not a sibling of it. See `perfLog.begin` for what that means to the report.
 */

export interface SimProfiler {
  begin(phase: string): void;
  end(phase: string): void;
  /** The worst single occurrence of something this window — see `perfLog.gauge`. */
  gauge(name: string, v: number): void;
}

const OFF: SimProfiler = { begin: () => {}, end: () => {}, gauge: () => {} };

/** The live profiler. Read through the object (never destructured) so `setSimProfiler` is
 *  seen by call sites that were compiled before it was ever called. */
export const simProfile: SimProfiler = { ...OFF };

/** Plug in a recorder, or `null` to unplug one when a match ends. */
export function setSimProfiler(p: SimProfiler | null): void {
  simProfile.begin = p ? p.begin.bind(p) : OFF.begin;
  simProfile.end = p ? p.end.bind(p) : OFF.end;
  simProfile.gauge = p ? p.gauge.bind(p) : OFF.gauge;
}

/** `performance.now()`, reachable from the sim — it is a global in Node as well as in the
 *  browser, so this costs the standalone compile nothing. For timing something whose own
 *  duration is the interesting number rather than its share of a frame. */
export function perfNow(): number {
  return performance.now();
}
