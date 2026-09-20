import type { Interpreter } from "../../jass/interpreter";
import type { LuaMapScript } from "./host";

// Loading the Lua front end ON DEMAND (docs/map-compatibility.md, step 6).
//
// The Lua interpreter (fengari) is a few hundred kilobytes and almost no map needs it — a
// `war3map.lua` is the minority case, and a player who never opens one should never pay for
// it. So it is a dynamic import, which Vite puts in its own chunk, and the match's loading
// path awaits `preloadLuaHost()` before the script runs.
//
// `loadMapScript` stays SYNCHRONOUS on purpose: it sits in the middle of a long, already
// carefully ordered bring-up (the world is seeded, then the script runs, then the roster is
// checked), and turning it async to fetch a chunk would thread `await` through all of it. The
// fetch happens earlier, where the loading bar is already moving.

let host: typeof import("./host") | null = null;

/** Fetch the Lua front end. Safe to call repeatedly; the second call is free. */
export async function preloadLuaHost(): Promise<void> {
  host ??= await import("./host");
}

/**
 * Put a Lua front end on a booted interpreter. Throws if the chunk has not been fetched —
 * the caller is expected to have awaited `preloadLuaHost()`, and a silent no-op here would
 * be a map that starts with no triggers and no explanation.
 */
export function createLuaMapScript(interp: Interpreter, seed: number): LuaMapScript {
  if (!host) throw new Error("the Lua front end has not been loaded (preloadLuaHost)");
  return host.createLuaMapScript(interp, seed);
}

export type { LuaMapScript } from "./host";
