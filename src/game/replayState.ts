// The STATE TRACK of a replay (issue #158) — once a game second, what the match LOOKED like:
// every unit's type, owner, position, life, mana, order, target, hero level and inventory, and
// every player's bank, food and research. Material for an AI that plays like a person, read
// without re-simulating.
//
// A replay is exact without it (game/replay.ts: the inputs, re-simulated), so this is a COPY of
// what a playback would compute anyway, kept for two reasons. A training run reads a thousand
// matches, and re-simulating every one of them to find out where the army was is the slow way
// round. And the engine moves on: a replay recorded today and re-simulated by a much later
// OpenWar3 may part from what was played (the version question in docs/replays.md), while this
// track says what WAS there whatever any later build makes of it.
//
// It is a DELTA track, because most of a match is buildings standing still: a sample lists the
// units whose row CHANGED since the last one (positions and pools rounded to whole numbers, so a
// unit drifting a hair is not news) and the ids that are gone. The first sample lists
// everything. `expandStates` turns the track back into a full picture per sample.

import type { SimWorld, SimUnit } from "../sim/world";
import { MELEE } from "../data/gameplayConstants";

/** Steps between two samples: one game second (60 steps at 60 Hz). Ours. */
export const STATE_EVERY = 60;

/**
 * One unit: `[id, typeId, owner, x, y, facing°, hp, mana, order, targetId, heroLevel, items]`.
 * `items` is the inventory's item rawcodes ("" for an empty slot), absent for a unit with none.
 */
export type UnitRow = [number, string, number, number, number, number, number, number, string, number, number, string[]?];

/** One player: `[player, gold, lumber, foodUsed, research]`, research as `{upgradeId: level}`. */
export type PlayerRow = [number, number, number, number, Record<string, number>];

export interface StateSample {
  /** The step, counted from the match's start (game/replay.ts). */
  t: number;
  /** Units new or changed since the previous sample. */
  units: UnitRow[];
  /** Ids gone since the previous sample. */
  gone: number[];
  /** Players whose row changed since the previous sample. */
  players: PlayerRow[];
}

function unitRow(u: SimUnit): UnitRow {
  const r = Math.round;
  const row: UnitRow = [
    u.id, u.typeId, u.owner, r(u.x), r(u.y),
    ((r((u.facing * 180) / Math.PI) % 360) + 360) % 360,
    Number.isFinite(u.hp) ? r(u.hp) : -1,
    Number.isFinite(u.mana) ? r(u.mana) : -1,
    u.order, u.targetId ?? 0, u.isHero ? u.level : 0,
  ];
  if (u.inventory.length) row.push(u.inventory.map((it) => it?.itemId ?? ""));
  return row;
}

/** Takes the samples, remembering what it last said so each one is only what changed. */
export class StateTracker {
  private units = new Map<number, string>();
  private players = new Map<number, string>();

  sample(sim: SimWorld, t: number): StateSample {
    const out: StateSample = { t, units: [], gone: [], players: [] };
    const seen = new Set<number>();
    for (const u of sim.units.values()) {
      seen.add(u.id);
      const row = unitRow(u);
      const key = JSON.stringify(row);
      if (this.units.get(u.id) === key) continue;
      this.units.set(u.id, key);
      out.units.push(row);
    }
    for (const id of this.units.keys()) {
      if (seen.has(id)) continue;
      this.units.delete(id);
      out.gone.push(id);
    }
    for (let p = 0; p < MELEE.MAX_PLAYERS; p++) {
      const s = sim.stashOf(p);
      const research = Object.fromEntries(sim.tech?.researchedBy(p) ?? []);
      const row: PlayerRow = [p, Math.floor(s.gold), Math.floor(s.lumber), sim.foodUsedOf?.(p) ?? 0, research];
      const key = JSON.stringify(row);
      if (this.players.get(p) === key) continue;
      this.players.set(p, key);
      out.players.push(row);
    }
    return out;
  }
}

/** The track as FULL pictures, one per sample — what a reader wants, from what the file keeps. */
export function* expandStates(track: StateSample[]): Generator<{ t: number; units: Map<number, UnitRow>; players: Map<number, PlayerRow> }> {
  const units = new Map<number, UnitRow>();
  const players = new Map<number, PlayerRow>();
  for (const s of track) {
    for (const id of s.gone) units.delete(id);
    for (const row of s.units) units.set(row[0], row);
    for (const row of s.players) players.set(row[0], row);
    yield { t: s.t, units: new Map(units), players: new Map(players) };
  }
}
