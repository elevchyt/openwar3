// THE MATCH LOG — every match writes a plain-text record of what happened in it (docs/match-log.md).
//
// The developer's: "can we have each match produce a log file (even matches on the release client)
// that records everything that happened in the match … so that we can actually test tons of
// matches and record their progress … to see if things went as planned (this is especially good
// for testing out Computer+ AI)". So it is ALWAYS on — dev and release alike — and it is built to
// be cheap enough to be: it never measures a frame (that is the opt-in perf recorder's job,
// src/dev/perfLog.ts) and it looks at the world ONCE A GAME-SECOND, by DIFFING it against what it
// saw the second before, rather than by hooking the sim's internals. The one exception is a death,
// which the sim tells it of as it happens (`SimWorld.deathObserver`) because only the moment of
// death knows the killer.
//
// It is TEXT, one event per line, because the reader is a person (or an assistant) asking "did the
// orc reach tier 3, and when did its army leave home" — a JSON line answers that only through a
// tool. Every line starts with the GAME clock and, where it is about a player, `P<n>`, so a grep
// for `P2 ` is that player's whole match:
//
//   [03:12] P1 built Barracks
//   [07:40] P2 AI mode massing -> attacking (target P1 Town Hall)
//   [08:00] STATUS P1 gold=310 lumber=140 food=34/50 tier=2 workers=16 army=24 …
//
// It writes nothing itself: the lines go to a SINK — the desktop shell in a release build
// (`ow3native.matchLog`, electron/main.mjs → `<userData>/.logs/`), the dev server under `pnpm dev`
// (tools/vite-plugin-match-log.ts → the repo's `.logs/`), and nowhere at all in a plain web build,
// which has no disk to write to (`matchLogSink`, src/game/matchLogSink.ts). Both writers are electron/logStore.mjs: about a megabyte per file
// before it rolls over, and nothing kept past three days.

import { MELEE } from "../data/gameplayConstants";
import type { SimUnit, SimWorld } from "../sim/world";

/** Where the lines go. */
export interface MatchLogSink {
  begin(map: string): Promise<string | null>;
  append(id: string, text: string): void;
  end(id: string): Promise<unknown>;
}

/** One seated player, as the header and the status lines name them. */
export interface LogSeat {
  player: number;
  name: string;
  race: string;
  team: number;
  /** "human", "computer (Normal)", "Computer+ (Insane)", "observer"… */
  controller: string;
}

/** One Computer+ seat's reading (`ComputerPlusAi.logReport`). */
export interface AiReading {
  player: number;
  build: string;
  mode: string;
  creeping: boolean;
  retreat: string | null;
  target: string;
  /** Changes only when the aim really does — what "AI target" lines are written on. */
  targetKey: string;
  squadFood: number;
  enemy: string;
}

/** What the log reads off the match — the scene implements it, so this file needs no renderer. */
export interface MatchLogSource {
  /** Game seconds since the match began. */
  clock(): number;
  world(): SimWorld | null;
  seats(): readonly LogSeat[];
  food(player: number): { used: number; made: number };
  /** A unit, building, item or upgrade id's name in the install's own words. */
  nameOf(id: string): string;
  /** Every Computer+ seat's state (`ComputerPlusAi.logReport`); empty with none. */
  ai(): readonly AiReading[];
  /** Real frames and game steps since the last ask — the light half of the perf picture. */
  pace(): { fps: number; speed: string };
}

/** How often each player's STATUS line is written, in game seconds. */
const STATUS_EVERY = 30;
/** Game seconds during which what appears is the STARTING position, not an event. */
const START_WINDOW = 2;
/** How often buffered lines go to the sink, in REAL milliseconds — what a crash can lose. */
const FLUSH_MS = 5000;
/** A per-tick line naming more than this many unit types is cut, with a count of the rest. */
const LIST_MAX = 8;

interface Seen {
  typeId: string;
  owner: number;
  building: boolean;
  done: boolean;
  level: number;
}

/** "02:05" or "1:02:05", from game seconds. */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

/** "3 Footman, 1 Peasant" from a count map, the biggest first. Pure, for the test. */
export function countList(counts: ReadonlyMap<string, number>, name: (id: string) => string, max = LIST_MAX): string {
  const rows = [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = rows.slice(0, max).map(([id, n]) => `${n} ${name(id)}`);
  if (rows.length > max) shown.push(`+${rows.length - max} more types`);
  return shown.join(", ");
}

const isPlayer = (owner: number): boolean => owner >= 0 && owner < MELEE.MAX_PLAYERS;

export class MatchLog {
  private id: string | null = null;
  private opening: Promise<void> | null = null;
  private buf: string[] = [];
  private flushAt = 0;
  private nextTick = 0;
  /** The first STATUS is at `STATUS_EVERY`: at 0:00 nobody owns anything yet. */
  private nextStatus = STATUS_EVERY;
  /** What each player STARTED with — every unit seen before `START_WINDOW`, written as one
   *  "starts with" line rather than as built/trained events. */
  private starting: Map<number, Map<string, number>> | null = new Map();
  private readonly seen = new Map<number, Seen>();
  /** Heroes by `owner:typeId` that have died and not yet come back — a return is a REVIVAL. */
  private readonly fallen = new Set<string>();
  private readonly research = new Map<number, Map<string, number>>();
  private readonly aiLast = new Map<number, AiReading>();
  /** Deaths since the last tick, aggregated per victim owner → killer owner → type. */
  private deaths = new Map<string, Map<string, number>>();
  private closed = false;

  constructor(private readonly sink: MatchLogSink | null, private readonly src: MatchLogSource) {}

  get enabled(): boolean {
    return !!this.sink && !this.closed;
  }

  /** Open the file and write the header: who is playing what, on which map, at what speed. */
  open(map: string, header: Record<string, string | number | boolean>): void {
    if (!this.sink || this.opening) return;
    this.opening = this.sink.begin(map).then((id) => { this.id = id; }, () => { this.id = null; });
    const now = new Date();
    this.line(`# OpenWar3 match log — ${map}`);
    this.line(`# started ${now.toISOString()} (${now.toString()})`);
    for (const [k, v] of Object.entries(header)) this.line(`# ${k}: ${v}`);
    for (const s of this.src.seats()) {
      this.line(`# P${s.player} ${s.name} — ${s.race}, team ${s.team + 1}, ${s.controller}`);
    }
    const world = this.src.world();
    if (world) world.deathObserver = (v, k) => this.died(v, k);
    this.flushAt = performance.now() + FLUSH_MS;
  }

  /** A line about the match as a whole, stamped with the game clock. */
  event(text: string, player?: number): void {
    if (!this.enabled) return;
    this.line(`[${clockText(this.src.clock())}] ${player !== undefined ? `P${player} ` : ""}${text}`);
  }

  /** Called every frame; does its work once a game-second, and flushes every `FLUSH_MS`. */
  update(): void {
    if (!this.enabled) return;
    const t = this.src.clock();
    if (t >= this.nextTick) {
      this.nextTick = Math.floor(t) + 1;
      this.observe(t);
      if (t >= this.nextStatus) {
        this.nextStatus = (Math.floor(t / STATUS_EVERY) + 1) * STATUS_EVERY;
        this.status(t);
      }
    }
    if (performance.now() >= this.flushAt) this.flush();
  }

  /** The match is over (or abandoned): write the last status and the closing lines, and let go. */
  close(lines: readonly string[] = []): void {
    if (!this.sink || this.closed) return;
    const t = this.src.clock();
    this.observe(t);
    this.status(t);
    for (const l of lines) this.line(l);
    this.line(`# ended at game time ${clockText(t)} (${new Date().toISOString()})`);
    const world = this.src.world();
    if (world && world.deathObserver) world.deathObserver = null;
    this.flush();
    this.closed = true;
    const sink = this.sink;
    void (this.opening ?? Promise.resolve()).then(() => { if (this.id) void sink.end(this.id); });
  }

  /** Push whatever is buffered — on the timer, on close, and on `pagehide`. */
  flush(): void {
    this.flushAt = performance.now() + FLUSH_MS;
    if (!this.sink || !this.buf.length) return;
    if (!this.id) {
      // Still opening: hold the lines (the header is in them) until the file exists.
      void this.opening?.then(() => { if (this.id) this.flush(); });
      return;
    }
    const text = this.buf.join("\n") + "\n";
    this.buf = [];
    this.sink.append(this.id, text);
  }

  // --------------------------------------------------------------------------------------------

  private line(text: string): void {
    this.buf.push(text);
  }

  private name(id: string): string {
    return this.src.nameOf(id) || id;
  }

  private died(v: SimUnit, k: SimUnit | undefined): void {
    if (this.closed || v.isIllusion) return;
    const by = k ? (isPlayer(k.owner) ? `P${k.owner}` : "creeps") : "?";
    // A hero, a building and a player's whole-unit loss to a creep are worth a line of their own;
    // everything else is counted and written once a tick.
    if (isPlayer(v.owner) && (v.isHero || v.building)) {
      const what = v.isHero ? `hero ${this.name(v.typeId)}${v.properName ? ` "${v.properName}"` : ""} (level ${v.level})` : this.name(v.typeId);
      const killer = k ? ` — killed by ${by} ${this.name(k.typeId)}` : "";
      this.event(`lost ${what}${killer}`, v.owner);
      if (v.isHero) this.fallen.add(`${v.owner}:${v.typeId}`);
      return;
    }
    if (v.isSummon) return;
    const victim = isPlayer(v.owner) ? `P${v.owner}` : "creeps";
    const key = `${victim}<${by}`;
    let m = this.deaths.get(key);
    if (!m) this.deaths.set(key, (m = new Map()));
    m.set(v.typeId, (m.get(v.typeId) ?? 0) + 1);
  }

  /** The once-a-second diff: births, buildings started / finished / upgraded, hero levels and
   *  revivals, research, deaths, and Computer+ decisions. */
  private observe(t: number): void {
    const world = this.src.world();
    if (!world) return;
    const stamp = `[${clockText(t)}]`;
    const trained = new Map<number, Map<string, number>>();
    const live = new Set<number>();
    // The melee init spawns the starting units over the match's first moments; they are the
    // match's starting position, not things anybody did.
    const start = t < START_WINDOW ? this.starting : null;
    for (const u of world.units.values()) {
      if (u.hp <= 0 || !isPlayer(u.owner) || u.isIllusion) continue;
      live.add(u.id);
      const done = !u.building || u.building.constructionLeft <= 0;
      const was = this.seen.get(u.id);
      if (!was) {
        const rec: Seen = { typeId: u.typeId, owner: u.owner, building: !!u.building, done, level: u.level };
        this.seen.set(u.id, rec);
        if (start) {
          let m = start.get(u.owner);
          if (!m) start.set(u.owner, (m = new Map()));
          m.set(u.typeId, (m.get(u.typeId) ?? 0) + 1);
          continue;
        }
        if (u.building) {
          this.line(`${stamp} P${u.owner} ${done ? "built" : "began"} ${this.name(u.typeId)}`);
        } else if (u.isHero) {
          const key = `${u.owner}:${u.typeId}`;
          const back = this.fallen.delete(key);
          this.line(`${stamp} P${u.owner} ${back ? "revived" : "hero"} ${this.name(u.typeId)}${u.properName ? ` "${u.properName}"` : ""} (level ${u.level})`);
        } else if (!u.isSummon) {
          let m = trained.get(u.owner);
          if (!m) trained.set(u.owner, (m = new Map()));
          m.set(u.typeId, (m.get(u.typeId) ?? 0) + 1);
        }
        continue;
      }
      if (u.owner !== was.owner) {
        this.line(`${stamp} P${u.owner} took ${this.name(u.typeId)} from P${was.owner}`);
        was.owner = u.owner;
      }
      if (u.typeId !== was.typeId) {
        // A building's upgrade (Town Hall → Keep, Scout Tower → Guard Tower) is an event; a unit's
        // form change (Bear Form, a Berserker) is noise at this grain.
        if (u.building) this.line(`${stamp} P${u.owner} ${this.name(was.typeId)} -> ${this.name(u.typeId)}${done ? "" : " (upgrading)"}`);
        was.typeId = u.typeId;
      }
      if (done && !was.done) {
        if (u.building) this.line(`${stamp} P${u.owner} built ${this.name(u.typeId)}`);
        was.done = true;
      }
      if (u.isHero && u.level > was.level) {
        this.line(`${stamp} P${u.owner} ${this.name(u.typeId)} reached level ${u.level}`);
        was.level = u.level;
      }
    }
    for (const id of this.seen.keys()) if (!live.has(id)) this.seen.delete(id);
    if (this.starting && !start) {
      for (const [owner, m] of [...this.starting].sort((a, b) => a[0] - b[0])) {
        this.line(`${stamp} P${owner} starts with ${countList(m, (id) => this.name(id), 16)}`);
      }
      this.starting = null;
    }
    for (const [owner, m] of trained) this.line(`${stamp} P${owner} trained ${countList(m, (id) => this.name(id))}`);
    for (const [key, m] of this.deaths) {
      const [victim, by] = key.split("<");
      this.line(victim === "creeps"
        ? `${stamp} ${by} killed creeps: ${countList(m, (id) => this.name(id))}`
        : `${stamp} ${victim} lost ${countList(m, (id) => this.name(id))} (to ${by})`);
    }
    this.deaths = new Map();
    // RESEARCH, off the tech tree's own per-player table.
    for (const seat of this.src.seats()) {
      const now = world.tech?.researchedBy(seat.player);
      if (!now) continue;
      let had = this.research.get(seat.player);
      if (!had) this.research.set(seat.player, (had = new Map()));
      for (const [id, level] of now) {
        if ((had.get(id) ?? 0) >= level) continue;
        if (!start) this.line(`${stamp} P${seat.player} researched ${this.name(id)}${level > 1 ? ` (rank ${level})` : ""}`);
        had.set(id, level);
      }
    }
    // COMPUTER+ decisions: a line whenever a seat's mode, target or build changes.
    for (const r of this.src.ai()) {
      const was = this.aiLast.get(r.player);
      this.aiLast.set(r.player, r);
      if (!was) {
        this.line(`${stamp} P${r.player} AI build ${r.build}`);
        continue;
      }
      if (was.build !== r.build) this.line(`${stamp} P${r.player} AI build ${was.build} -> ${r.build}`);
      if (was.mode !== r.mode || was.creeping !== r.creeping) {
        const label = (x: AiReading) => (x.creeping ? `${x.mode}/creeping` : x.mode) + (x.retreat ? `(${x.retreat})` : "");
        this.line(`${stamp} P${r.player} AI mode ${label(was)} -> ${label(r)}${r.target ? ` (target ${r.target})` : ""}`);
      } else if (was.targetKey !== r.targetKey && r.target) {
        this.line(`${stamp} P${r.player} AI target ${r.target}`);
      }
    }
  }

  /** Every player's economy, army, tech and heroes, and every Computer+ seat's state. */
  private status(t: number): void {
    const world = this.src.world();
    if (!world) return;
    const stamp = `[${clockText(t)}]`;
    type Tally = { workers: number; army: Map<string, number>; buildings: Map<string, number>; heroes: string[] };
    const per = new Map<number, Tally>();
    const of = (p: number): Tally => {
      let x = per.get(p);
      if (!x) per.set(p, (x = { workers: 0, army: new Map(), buildings: new Map(), heroes: [] }));
      return x;
    };
    for (const u of world.units.values()) {
      if (u.hp <= 0 || !isPlayer(u.owner) || u.isIllusion) continue;
      const x = of(u.owner);
      if (u.building) {
        if (u.building.constructionLeft <= 0) x.buildings.set(u.typeId, (x.buildings.get(u.typeId) ?? 0) + 1);
      } else if (u.isHero) {
        x.heroes.push(`${this.name(u.typeId)} L${u.level}`);
      } else if (u.isPeon) {
        x.workers++;
      } else if (!u.isSummon) {
        x.army.set(u.typeId, (x.army.get(u.typeId) ?? 0) + 1);
      }
    }
    for (const seat of this.src.seats()) {
      if (seat.controller === "observer") continue;
      const x = of(seat.player);
      const bank = world.stashOf(seat.player);
      const food = this.src.food(seat.player);
      this.line(`${stamp} STATUS P${seat.player} gold=${Math.floor(bank.gold)} lumber=${Math.floor(bank.lumber)}`
        + ` food=${food.used}/${food.made} workers=${x.workers} heroes=[${x.heroes.join(", ")}]`);
      this.line(`${stamp} STATUS P${seat.player} army=[${countList(x.army, (id) => this.name(id), 12)}]`);
      this.line(`${stamp} STATUS P${seat.player} buildings=[${countList(x.buildings, (id) => this.name(id), 16)}]`);
    }
    for (const r of this.src.ai()) {
      this.line(`${stamp} STATUS P${r.player} AI build=${r.build} mode=${r.mode}${r.creeping ? "/creeping" : ""}`
        + `${r.retreat ? ` retreat=${r.retreat}` : ""} squad=${r.squadFood}food${r.target ? ` target=${r.target}` : ""} enemy=${r.enemy}`);
    }
    const pace = this.src.pace();
    this.line(`${stamp} PERF fps=${pace.fps.toFixed(0)} speed=${pace.speed} units=${world.units.size}`);
  }
}
