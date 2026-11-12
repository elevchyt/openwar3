// The STATE CHECK a replay is verified by (issue #158, game/replay.ts).
//
// Taken every `CHECK_EVERY` steps while recording and again at the same steps on playback: a
// mismatch says the two worlds have parted. The hash is deliberately COARSE about position and
// health (sixteenths of a world unit and of a hit point) — the point is not to fingerprint the
// float bits but to notice the match going somewhere else, and a world that drew a different
// number of rolls, lost a unit or has a unit on a different order has gone somewhere else. It
// reads the sim alone, never a render entry, so a headless run hashes exactly as a watched one.

import type { SimWorld } from "../sim/world";
import { MELEE } from "../data/gameplayConstants";

export function stateHash(sim: SimWorld): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (n: number): void => {
    n |= 0;
    h1 = Math.imul(h1 ^ n, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ (n >>> 3), 0x5bd1e995) + h1) >>> 0;
  };
  const q = (v: number): number => (Number.isFinite(v) ? Math.round(v * 16) : -1);
  const str = (s: string): void => {
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
    mix(0);
  };
  mix(sim.rngDraws);
  const ids = [...sim.units.keys()].sort((a, b) => a - b);
  mix(ids.length);
  for (const id of ids) {
    const u = sim.units.get(id)!;
    mix(id);
    str(u.typeId);
    mix(u.owner);
    mix(q(u.x));
    mix(q(u.y));
    mix(q(u.hp));
    mix(q(u.mana));
    str(u.order);
  }
  for (let p = 0; p < MELEE.MAX_PLAYERS; p++) {
    const s = sim.stashOf(p);
    mix(q(s.gold));
    mix(q(s.lumber));
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** The state behind `stateHash`, readable — what a DEV recording keeps beside each check so a
 *  parted playback can name the unit that parted (`diffDumps`). */
export function stateDump(sim: SimWorld): { rng: number; units: Array<[number, string, number, number, number, number, number, string]>; stash: number[] } {
  const q = (v: number): number => (Number.isFinite(v) ? Math.round(v * 16) : -1);
  const ids = [...sim.units.keys()].sort((a, b) => a - b);
  const stash: number[] = [];
  for (let p = 0; p < MELEE.MAX_PLAYERS; p++) {
    const s = sim.stashOf(p);
    stash.push(q(s.gold), q(s.lumber));
  }
  return {
    rng: sim.rngDraws,
    units: ids.map((id) => {
      const u = sim.units.get(id)!;
      return [id, u.typeId, u.owner, q(u.x), q(u.y), q(u.hp), q(u.mana), u.order];
    }),
    stash,
  };
}

/** Where two dumps part: the first few differences, as lines. */
export function diffDumps(a: ReturnType<typeof stateDump>, b: ReturnType<typeof stateDump>, max = 12): string[] {
  const out: string[] = [];
  if (a.rng !== b.rng) out.push(`rng draws ${a.rng} (recorded) vs ${b.rng} (now)`);
  a.stash.forEach((v, i) => {
    if (v !== b.stash[i]) out.push(`P${i >> 1} ${i & 1 ? "lumber" : "gold"} ${v / 16} vs ${b.stash[i] / 16}`);
  });
  const bm = new Map(b.units.map((u) => [u[0], u]));
  const am = new Map(a.units.map((u) => [u[0], u]));
  for (const u of a.units) {
    const v = bm.get(u[0]);
    if (!v) out.push(`unit ${u[0]} ${u[1]} (P${u[2]}) missing now`);
    else if (u.some((x, i) => x !== v[i])) out.push(`unit ${u[0]} ${u[1]} (P${u[2]}): recorded ${JSON.stringify(u.slice(3))} now ${JSON.stringify(v.slice(3))}`);
    if (out.length >= max) return out;
  }
  for (const v of b.units) if (!am.has(v[0])) out.push(`unit ${v[0]} ${v[1]} (P${v[2]}) exists only now`);
  return out.slice(0, max);
}
