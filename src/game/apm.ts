// Actions per minute, per player — the figure the observer HUD's resource table prints
// (issue #168).
//
// WHAT counts is every command the authority ACCEPTS (`Authority.execute`), whoever issued it:
// a person's click, a computer's order, a rally, a cast. That is narrower than a replay tool's
// APM, which also counts selections and hotkey presses — those never leave the player's own
// machine here, so no authority ever sees them. It is the same rule for every seat, which is
// what an observer comparing two players needs.
//
// HOW it is averaged is OURS: nothing in the install defines APM. A rolling window of the last
// `WINDOW` seconds of game time reads as "how busy is this player NOW", which is what a watcher
// wants from a live table; a whole-match average flattens every fight into the opening. Before
// a full window has passed the count is scaled up to a minute from the time that HAS passed,
// with a floor of `MIN_SPAN` so the first click of the match does not read as 6000 APM.

const WINDOW = 60; // seconds of game time the figure is taken over (ours)
const MIN_SPAN = 10; // the shortest span the early-match figure is scaled from (ours)

export class ApmMeter {
  /** Per player, the game time of every accepted action still inside the window, oldest
   *  first. Pruned on the way in, so a player's list never holds more than a minute. */
  private readonly times = new Map<number, number[]>();

  /** An action by `player` was accepted at game time `now`. */
  note(player: number, now: number): void {
    let list = this.times.get(player);
    if (!list) this.times.set(player, (list = []));
    list.push(now);
    this.prune(list, now);
  }

  /** `player`'s actions per minute at game time `now`. */
  apm(player: number, now: number): number {
    const list = this.times.get(player);
    if (!list) return 0;
    this.prune(list, now);
    const span = Math.min(WINDOW, Math.max(MIN_SPAN, now));
    return Math.round((list.length * 60) / span);
  }

  private prune(list: number[], now: number): void {
    let drop = 0;
    while (drop < list.length && list[drop] <= now - WINDOW) drop++;
    if (drop) list.splice(0, drop);
  }
}
