/**
 * AUTO CAMERA — the observer's camera that goes where the game is (issue #167).
 *
 * The control is the game's own: `UI\FrameDef\UI\ObserverPanel.fdf` has an
 * `ObserverCameraCheckBox` whose label is `REPLAY_CAMERA`, and GlobalStrings.fdf spells that
 * key "Auto Camera". What it DOES is written down nowhere in the install, so the rules below
 * are OURS — the developer's brief in the issue, turned into numbers that say so:
 *
 *  • HEROES AND ARMIES are what it watches. A hero is worth `HERO_WEIGHT` soldiers; a worker,
 *    a building and a creep are worth nothing until something happens to them.
 *  • A FIGHT is worth more than a march (`FIGHT_WEIGHT`), and a fight between two PLAYERS more
 *    than a fight with creeps (`CLASH_BONUS`). "In a fight" is a unit swinging (`inCombat`, which
 *    crosses the wire) OR one that has lost hit points in the last `HURT_MEMORY` seconds —
 *    measured here, off the hit points it can see, so a worker being raided and a building
 *    being burned count, on a LAN client as much as on the host.
 *  • It does NOT PAN OFTEN. After a pan it holds for `MIN_HOLD` seconds whatever else starts
 *    up, and a new spot must beat the one it is on by `SWITCH_MARGIN`. Between pans it may
 *    FOLLOW the action it is watching — a fight drifting across the screen, an army marching —
 *    with a slow ease (`FOLLOW_TAU`); that is the same point of interest, not a new pan.
 *  • A pan is SMOOTH — an ease-in-out over a time that grows with the distance
 *    (`PAN_MIN`..`PAN_MAX`) — never a cut.
 *  • The observer's own hand wins: the moment the camera is moved by anything else (the arrow
 *    keys, the screen edge, the minimap, a hero key) it stands aside for `MANUAL_GRACE` seconds.
 *
 * Pure: it is handed the units and the camera focus, and answers with the focus it wants. The
 * renderer (MapViewerScene.updateAutoCamera) owns the checkbox, the observer test and the write.
 */

/** What the auto camera reads off a unit — a subset of SimUnit, so either world will do. */
export interface AutoCamUnit {
  id: number;
  x: number;
  y: number;
  owner: number; // < 0 for the neutrals
  hp: number;
  isHero: boolean;
  building: unknown; // non-null for a structure
  isPeon: boolean;
  inCombat: boolean;
  ward?: boolean;
  isIllusion?: boolean;
  hidden?: boolean;
  inMine?: boolean;
  insideBuild?: boolean;
  inBurrow?: boolean;
}

/** The radius one camera view is judged over — about half the ground a default-zoom WC3 view
 *  shows across. Units within it of a spot are "on screen" there. OURS. */
export const VIEW_RADIUS = 800;
/** How much a hero counts against one soldier. OURS: the issue says heroes first. */
export const HERO_WEIGHT = 6;
/** How much a unit in a fight counts against one that is only standing there. OURS. */
export const FIGHT_WEIGHT = 3;
/** The whole spot is worth this much more when two or more PLAYERS are in the fight there — a
 *  clash between armies over a hero creeping. OURS. */
export const CLASH_BONUS = 1.5;
/** Seconds a unit that lost hit points still counts as being in a fight. OURS. */
export const HURT_MEMORY = 3;
/** Seconds between two pans, whatever happens meanwhile — "there must be a delay between each
 *  pan even if the point of interest changes" (issue #167). OURS. */
export const MIN_HOLD = 7;
/** A new spot must score this many times the current one to be worth a pan. OURS. */
export const SWITCH_MARGIN = 1.35;
/** Seconds between two looks round the map. OURS: often enough to catch a fight starting,
 *  rarely enough that the scan is free. */
export const SCAN_PERIOD = 0.5;
/** Time constant of the ease that FOLLOWS the watched action between pans, in seconds. OURS. */
export const FOLLOW_TAU = 1.4;
/** Shortest and longest pan, seconds; in between the time grows with the distance at
 *  `PAN_SPEED` world units a second. OURS. */
export const PAN_MIN = 0.9;
export const PAN_MAX = 2.4;
export const PAN_SPEED = 3000;
/** Seconds the auto camera stands aside after the observer moves the camera by hand. OURS. */
export const MANUAL_GRACE = 6;

interface Spot {
  x: number;
  y: number;
  score: number;
}

export class AutoCamera {
  /** The checkbox. Off by default, as the game's own box is. */
  enabled = false;

  private pan: { fx: number; fy: number; tx: number; ty: number; t: number; dur: number } | null = null;
  /** Where the camera is WATCHING — the centre of the action it last chose, re-found each scan. */
  private watch: Spot | null = null;
  private holdLeft = 0;
  private scanLeft = 0;
  private graceLeft = 0;
  /** The focus this camera last wrote — a focus that is somewhere else next frame was moved by
   *  somebody else (see update). */
  private wrote: { x: number; y: number } | null = null;
  private clock = 0;
  private lastHp = new Map<number, number>();
  private hurtAt = new Map<number, number>();

  /** Turn it on or off. Turning it on looks round at once — a checkbox that does nothing for
   *  seven seconds reads as broken. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.pan = null;
    this.watch = null;
    this.holdLeft = 0;
    this.scanLeft = 0;
    this.graceLeft = 0;
    this.wrote = null;
  }

  /**
   * One frame. `focus` is the camera's ground focus as it stands NOW (after the observer's own
   * input this frame); the answer is the focus the auto camera wants, or null to leave it be.
   */
  update(dt: number, focus: { x: number; y: number }, units: Iterable<AutoCamUnit>): { x: number; y: number } | null {
    this.clock += dt;
    if (!this.enabled) return null;
    // Moved by another hand since we last wrote: stand aside, and forget what we were doing —
    // the observer is looking at something, and when the grace runs out we look round afresh.
    if (this.wrote && Math.hypot(focus.x - this.wrote.x, focus.y - this.wrote.y) > 1) {
      this.graceLeft = MANUAL_GRACE;
      this.pan = null;
      this.watch = null;
      this.holdLeft = 0;
      this.scanLeft = 0;
      this.wrote = null;
    }
    this.holdLeft = Math.max(0, this.holdLeft - dt);
    this.scanLeft -= dt;
    if (this.graceLeft > 0) {
      this.graceLeft -= dt;
      // Keep the hit-point memory warm meanwhile — on the SCAN's clock, not the frame's: a
      // unit loses well under the half-point threshold in one frame, and sampled every frame a
      // slow bleed would never read as a fight.
      if (this.scanLeft <= 0) {
        this.scanLeft = SCAN_PERIOD;
        this.noteHurt(units);
      }
      return null;
    }
    if (this.scanLeft <= 0) {
      this.scanLeft = SCAN_PERIOD;
      this.scan(focus, units);
    }
    let out: { x: number; y: number } | null = null;
    if (this.pan) {
      const p = this.pan;
      p.t = Math.min(p.dur, p.t + dt);
      const k = p.t / p.dur;
      const e = k * k * (3 - 2 * k); // smoothstep: eases out of the old spot and into the new one
      out = { x: p.fx + (p.tx - p.fx) * e, y: p.fy + (p.ty - p.fy) * e };
      if (p.t >= p.dur) this.pan = null;
    } else if (this.watch) {
      // Follow the action being watched — a slow ease, not a pan.
      const a = 1 - Math.exp(-dt / FOLLOW_TAU);
      const x = focus.x + (this.watch.x - focus.x) * a;
      const y = focus.y + (this.watch.y - focus.y) * a;
      if (Math.hypot(x - focus.x, y - focus.y) > 0.01) out = { x, y };
    }
    this.wrote = out ?? this.wrote ?? { x: focus.x, y: focus.y };
    return out;
  }

  /** The focus as it stands after the renderer has applied (and clamped to the map) what
   *  `update` asked for — the one to compare the next frame against. Without it a spot near the
   *  map's edge, which the camera clamp pulls back, would read as the observer's hand. */
  confirm(focus: { x: number; y: number }): void {
    if (this.wrote) this.wrote = { x: focus.x, y: focus.y };
  }

  /** Look round: re-find what we are watching, and pan to something better if it is time. */
  private scan(focus: { x: number; y: number }, units: Iterable<AutoCamUnit>): void {
    const scored = this.weigh(units);
    if (!scored.length) return;
    const best = bestSpot(scored);
    if (!best) return;
    // What we are watching NOW: the action around the spot we chose (it moves as the fight
    // does), or, with nothing chosen yet, around wherever the camera happens to be.
    const here = this.watch ?? { x: focus.x, y: focus.y, score: 0 };
    const current = spotAround(scored, here.x, here.y);
    const far = Math.hypot(best.x - (current?.x ?? here.x), best.y - (current?.y ?? here.y)) > VIEW_RADIUS;
    const better = best.score > (current?.score ?? 0) * SWITCH_MARGIN;
    if (!this.watch || (this.holdLeft <= 0 && far && better)) {
      const from = this.pan ? { x: focus.x, y: focus.y } : focus;
      const dist = Math.hypot(best.x - from.x, best.y - from.y);
      this.pan = { fx: from.x, fy: from.y, tx: best.x, ty: best.y, t: 0, dur: Math.min(PAN_MAX, Math.max(PAN_MIN, dist / PAN_SPEED)) };
      this.watch = best;
      this.holdLeft = MIN_HOLD;
      return;
    }
    // Same action, followed where it has gone (or the camera stays put if it has ended).
    if (current) this.watch = current;
  }

  /** Remember who has lost hit points, and when. */
  private noteHurt(units: Iterable<AutoCamUnit>): void {
    const seen = new Set<number>();
    for (const u of units) {
      seen.add(u.id);
      const was = this.lastHp.get(u.id);
      if (was !== undefined && u.hp < was - 0.5) this.hurtAt.set(u.id, this.clock);
      this.lastHp.set(u.id, u.hp);
    }
    for (const id of this.lastHp.keys()) if (!seen.has(id)) { this.lastHp.delete(id); this.hurtAt.delete(id); }
  }

  /** Every unit worth watching, with what it is worth (see the header). */
  private weigh(units: Iterable<AutoCamUnit>): Weighed[] {
    const list = [...units];
    this.noteHurt(list);
    const out: Weighed[] = [];
    for (const u of list) {
      if (u.hp <= 0 || u.hidden || u.inMine || u.insideBuild || u.inBurrow || u.ward || u.isIllusion) continue;
      const hurt = (this.hurtAt.get(u.id) ?? -Infinity) > this.clock - HURT_MEMORY;
      const fighting = u.inCombat || hurt;
      let w: number;
      if (u.owner < 0) w = fighting ? 0.5 : 0; // a creep matters only while somebody fights it
      else if (u.isHero) w = HERO_WEIGHT;
      else if (u.building) w = hurt ? 1.5 : 0; // a base being burned, not a base standing
      else if (u.isPeon) w = fighting ? 1 : 0; // a raid on the mine, not the mining
      else w = 1;
      if (fighting) w *= FIGHT_WEIGHT;
      if (w > 0) out.push({ x: u.x, y: u.y, w, owner: fighting && u.owner >= 0 ? u.owner : -1 });
    }
    return out;
  }
}

interface Weighed {
  x: number;
  y: number;
  w: number;
  /** The owner, when this is a PLAYER's unit in a fight — what `CLASH_BONUS` counts. */
  owner: number;
}

/** The weighted centre and worth of the action within VIEW_RADIUS of (x, y), or null if none. */
export function spotAround(units: ReadonlyArray<Weighed>, x: number, y: number): Spot | null {
  let sw = 0, sx = 0, sy = 0;
  const fighters = new Set<number>();
  for (const u of units) {
    if (Math.hypot(u.x - x, u.y - y) > VIEW_RADIUS) continue;
    sw += u.w;
    sx += u.x * u.w;
    sy += u.y * u.w;
    if (u.owner >= 0) fighters.add(u.owner);
  }
  if (sw <= 0) return null;
  return { x: sx / sw, y: sy / sw, score: sw * (fighters.size >= 2 ? CLASH_BONUS : 1) };
}

/** The best spot on the map: each unit's neighbourhood tried as a centre, the winner's
 *  weighted centre returned (so the camera frames the action, not the one unit it was found
 *  from). */
export function bestSpot(units: ReadonlyArray<Weighed>): Spot | null {
  let best: Spot | null = null;
  for (const u of units) {
    const s = spotAround(units, u.x, u.y);
    if (s && (!best || s.score > best.score)) best = s;
  }
  return best;
}
