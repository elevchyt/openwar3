// Player alliances (7.22 — issue #33; see docs/triggers.md).
//
// WC3 keeps a per-PAIR, per-SETTING alliance matrix — not a team number. common.j:
//
//   constant alliancetype ALLIANCE_PASSIVE                 = ConvertAllianceType(0)
//   constant alliancetype ALLIANCE_HELP_REQUEST            = ConvertAllianceType(1)
//   constant alliancetype ALLIANCE_HELP_RESPONSE           = ConvertAllianceType(2)
//   constant alliancetype ALLIANCE_SHARED_XP               = ConvertAllianceType(3)
//   constant alliancetype ALLIANCE_SHARED_SPELLS           = ConvertAllianceType(4)
//   constant alliancetype ALLIANCE_SHARED_VISION           = ConvertAllianceType(5)
//   constant alliancetype ALLIANCE_SHARED_CONTROL          = ConvertAllianceType(6)
//   constant alliancetype ALLIANCE_SHARED_ADVANCED_CONTROL = ConvertAllianceType(7)
//   constant alliancetype ALLIANCE_RESCUABLE               = ConvertAllianceType(8)
//   constant alliancetype ALLIANCE_SHARED_VISION_FORCED    = ConvertAllianceType(9)
//
// The matrix is DIRECTED — `SetPlayerAlliance(A, B, …)` says what A grants B, and the
// two directions are independent. That is why blizzard.j's own co-ally test reads BOTH:
//
//   function PlayersAreCoAllied takes player playerA, player playerB returns boolean
//       if (playerA == playerB) then
//           return true                                    // allied with yourself
//       endif
//       if GetPlayerAlliance(playerA, playerB, ALLIANCE_PASSIVE) then
//           if GetPlayerAlliance(playerB, playerA, ALLIANCE_PASSIVE) then
//               return true                                // both ways, or you aren't allies
//           endif
//       endif
//       return false
//   endfunction
//
// PASSIVE is the one that means "don't shoot each other" — it is what the whole
// SetPlayerAllianceStateBJ family (the GUI's "Player - Make X treat Y as an Ally")
// toggles first, and what every ally/enemy check in blizzard.j ultimately reads.
//
// We SEED the matrix from the lobby's teams (same team ⇒ mutually passive + shared
// vision), so a melee game behaves exactly as it did when allegiance was a plain team
// comparison — and a script can then change any pair from under it.

/** common.j's `alliancetype` indices. */
export enum AllianceType {
  Passive = 0,
  HelpRequest = 1,
  HelpResponse = 2,
  SharedXp = 3,
  SharedSpells = 4,
  SharedVision = 5,
  SharedControl = 6,
  SharedAdvancedControl = 7,
  Rescuable = 8,
  SharedVisionForced = 9,
}

/** common.j: `constant integer bj_MAX_PLAYER_SLOTS = 16` — slots 0–11 are players,
 *  12 is Neutral Hostile and 15 Neutral Passive. */
const SLOTS = 16;
const TYPES = 10;

export class AllianceTable {
  // [source][other][type] flattened. A directed matrix: what `source` grants `other`.
  private grants = new Uint8Array(SLOTS * SLOTS * TYPES);

  private idx(source: number, other: number, type: number): number {
    return (source * SLOTS + other) * TYPES + type;
  }

  private valid(source: number, other: number, type: number): boolean {
    return (
      source >= 0 && source < SLOTS && other >= 0 && other < SLOTS && type >= 0 && type < TYPES
    );
  }

  /** SetPlayerAlliance(source, other, whichAllianceSetting, value). */
  set(source: number, other: number, type: AllianceType, value: boolean): void {
    if (!this.valid(source, other, type)) return;
    this.grants[this.idx(source, other, type)] = value ? 1 : 0;
  }

  /** GetPlayerAlliance(source, other, whichAllianceSetting). A player grants itself
   *  everything — WC3 reports a player as allied with itself, and PlayersAreCoAllied
   *  short-circuits on the same identity. */
  get(source: number, other: number, type: AllianceType): boolean {
    if (source === other) return true;
    if (!this.valid(source, other, type)) return false;
    return this.grants[this.idx(source, other, type)] === 1;
  }

  /** blizzard.j's `PlayersAreCoAllied` — PASSIVE granted in BOTH directions. This is
   *  the "are we on the same side" predicate the sim's hostile/allied checks read. */
  coAllied(a: number, b: number): boolean {
    if (a === b) return true;
    return this.get(a, b, AllianceType.Passive) && this.get(b, a, AllianceType.Passive);
  }

  /** Does `source` share its sight with `other`? SHARED_VISION_FORCED is the engine's
   *  own, non-revocable variant (an observer, a cinematic) — either grants vision. */
  sharesVisionWith(source: number, other: number): boolean {
    if (source === other) return true;
    return (
      this.get(source, other, AllianceType.SharedVision) ||
      this.get(source, other, AllianceType.SharedVisionForced)
    );
  }

  /** Seed the matrix from the lobby's teams: team-mates are mutually passive and share
   *  vision, everyone else is unallied. This reproduces exactly what a melee game got
   *  when allegiance was nothing but `teamOf(a) === teamOf(b)`, and gives the script
   *  something real to mutate. `teamOf` returns a team index per player slot. */
  seedFromTeams(teamOf: (player: number) => number): void {
    this.grants.fill(0);
    for (let a = 0; a < SLOTS; a++) {
      for (let b = 0; b < SLOTS; b++) {
        if (a === b || teamOf(a) !== teamOf(b)) continue;
        for (const t of [
          AllianceType.Passive,
          AllianceType.HelpRequest,
          AllianceType.HelpResponse,
          AllianceType.SharedXp,
          AllianceType.SharedSpells,
          AllianceType.SharedVision,
        ]) {
          this.set(a, b, t, true);
        }
      }
    }
  }
}
