/**
 * **Per-session performance recorder — dev only.**
 *
 * The bug this exists for: a match runs fine, and then after a while it is at 5 fps and stays
 * there. A number on the metrics overlay cannot answer that, because by the time you look at
 * it the interesting part — *when* it turned, and *what was different either side of the
 * turn* — has already scrolled past. So every match writes a file: one `sample` record per
 * second carrying the frame times, WHERE in the frame those milliseconds went, and a census
 * of every collection the match can grow. `pnpm perf:report` then reads the file back and
 * says which phase grew and which counter grew with it (tools/perf-report.mjs).
 *
 * Three properties it is built around:
 *
 * - **It costs nothing when it is off, and it is off by default.** Recording is opt-in per dev
 *   server: `pnpm dev:log`. The flag is read by tools/vite-plugin-perf-log.ts and
 *   arrives here as the `__OW3_PERF_MS__` define — 0 when the flag is absent, and 0 in a build,
 *   where the endpoints do not exist either. Every entry point returns on `ON` first, so an
 *   un-flagged session does not so much as take a timestamp; `?noperf` turns off a flagged one
 *   for a single boot.
 * - **It survives a crash.** Lines are appended to the file as they are produced (every
 *   FLUSH_MS), not written at the end — the sessions worth reading are exactly the ones that
 *   ended badly. `pagehide` flushes the tail through `sendBeacon`.
 * - **It records, it does not analyse.** Everything derived — trends, correlations, the drop
 *   point — is computed by the report tool off the file, so it can also be run against the
 *   session that died without closing. The one exception is `drop`, which is emitted live
 *   because it is also worth a console line while you are sitting there watching it happen.
 *
 * The other half is `tools/vite-plugin-perf-log.ts`, which owns `.logs/`.
 */

/** Injected by vite.config.ts (`perfLogDefines`): the sample period in ms, or 0 for "off".
 *  Always defined — including in a build, where it is 0 — so this is never a free identifier. */
declare const __OW3_PERF_MS__: number;
/** …and the deep-snapshot period, same source, same 0-means-off rule. */
declare const __OW3_PERF_SNAPSHOT_MS__: number;

/** Dev-server only, opt-in with `pnpm dev:log`, and skippable with `?noperf`. */
const ON = import.meta.env.DEV && __OW3_PERF_MS__ > 0 && !new URLSearchParams(location.search).has("noperf");

/** Real milliseconds per aggregated `sample` record. One second reads well and is small. */
const SAMPLE_MS = __OW3_PERF_MS__ || 1000;
/** …and per deep `snapshot`: the census that is too expensive to take every second. */
const SNAPSHOT_MS = __OW3_PERF_SNAPSHOT_MS__ || 15000;
/** How often buffered records are POSTed. Bounds what a hard crash can lose. */
const FLUSH_MS = 5000;
/** A frame this slow is worth its own record, with the phase split that produced it. */
const SPIKE_MS = 100;
/** …but only this many per session, so one bad stretch cannot become the whole file. */
const MAX_SPIKES = 400;
/** Distinct console messages kept (each with a count) — a per-frame throw is a classic cause. */
const MAX_LOG_KINDS = 60;

/** A census of everything the match can grow, gathered once per sample. */
export type PerfCounts = Record<string, number>;

interface Rec {
  t: string;
  ms: number;
  [k: string]: unknown;
}

class PerfLog {
  private id: string | null = null;
  private opening = false;
  private t0 = 0;
  private pending: Rec[] = [];
  private flushAt = 0;

  /** Where the counters come from — the scene owns them, so it hands us a getter. */
  private source: (() => PerfCounts) | null = null;
  /** …and the deep one, taken every SNAPSHOT_MS instead of every second. */
  private deep: (() => Record<string, unknown>) | null = null;
  private snapAt = 0;

  // --- the current sample window ---
  private winStart = 0;
  private winFrames: number[] = []; // frame deltas, ms (reset each window)
  private winPhase: Record<string, number> = {}; // ms per phase, summed over the window
  private winTally: Record<string, number> = {}; // counted events, summed over the window
  private winGauge: Record<string, number> = {}; // the WORST value seen this window (a max, not a sum)
  private framePhase: Record<string, number> = {}; // …and the same for THIS frame alone
  private spans: Record<string, number> = {}; // phase → start stamp of the running span

  // --- session-wide state ---
  private spikes = 0;
  private bestFps = 0; // best sample fps seen, once the session has settled
  private samples = 0;
  private dropped = false; // the one-shot "it has fallen off a cliff" record
  private logs = new Map<string, { level: string; n: number; first: number }>();
  private longTasks = 0;
  private longTaskMs = 0;
  private observer: PerformanceObserver | null = null;
  private consoleHooks: (() => void) | null = null;
  private timer: number | null = null;
  private unload: (() => void) | null = null;

  get enabled(): boolean {
    return ON;
  }

  /** Start a session file. `meta` is the header record: map, machine, settings. */
  open(meta: Record<string, unknown>): void {
    if (!ON || this.id || this.opening) return;
    this.opening = true;
    this.t0 = performance.now();
    this.winStart = this.t0;
    this.flushAt = this.t0 + FLUSH_MS;
    this.hookConsole();
    this.hookLongTasks();
    this.hookUnload();
    this.timer = window.setInterval(() => this.flush(), FLUSH_MS);
    const header = {
      ...meta,
      startedAt: new Date().toISOString(),
      ua: navigator.userAgent,
      // The two that decide how much a frame costs before anything in the game does.
      dpr: window.devicePixelRatio,
      screen: `${screen.width}x${screen.height}`,
      cores: navigator.hardwareConcurrency ?? 0,
      // Chrome only, and worth having: 4 GB of heap headroom vs 500 MB changes what "a leak"
      // means for this session.
      heapLimit: memory()?.jsHeapSizeLimit ?? 0,
    };
    void fetch("/perf/begin", { method: "POST", body: JSON.stringify(header) })
      .then((r) => (r.ok ? r.json() : null))
      .then((r: { id?: string; file?: string } | null) => {
        this.opening = false;
        if (!r?.id) return; // no dev middleware (a `vite preview`) — stay quiet and idle
        this.id = r.id;
        console.info(`[perf] recording this match to ${r.file}`);
        this.flush();
      })
      .catch(() => {
        this.opening = false;
      });
  }

  /** Hand over the counter census. Called once, by whoever owns the collections. */
  counters(fn: () => PerfCounts): void {
    if (ON) this.source = fn;
  }

  /**
   * Hand over the DEEP census, taken every SNAPSHOT_MS rather than every second.
   *
   * The split is what lets the log answer "what is piling up" as well as "how much". A
   * per-second counter has to be a `.size` read to be affordable at 1 Hz; the questions worth
   * asking when something has clearly leaked — WHICH model has 4,000 live instances, WHICH
   * unit type multiplied, which owner's army it belongs to — all mean walking a collection,
   * which is fine once every fifteen seconds and not fine sixty times a second.
   */
  snapshots(fn: () => Record<string, unknown>): void {
    if (ON) this.deep = fn;
  }

  /** A free-form marker on the timeline — "map loaded", "the player paused", a cheat typed. */
  note(name: string, extra?: Record<string, unknown>): void {
    if (!ON || !this.opening && !this.id) return;
    this.push({ t: "note", ms: this.now(), name, ...extra });
  }

  /** Open a timed span. Nesting is not tracked: phases are meant to partition the frame. */
  begin(phase: string): void {
    if (!ON) return;
    this.spans[phase] = performance.now();
  }

  /** Close the span opened by `begin`, adding its cost to this frame and this window. */
  end(phase: string): void {
    if (!ON) return;
    const started = this.spans[phase];
    if (started === undefined) return;
    const ms = performance.now() - started;
    delete this.spans[phase];
    this.framePhase[phase] = (this.framePhase[phase] ?? 0) + ms;
    this.winPhase[phase] = (this.winPhase[phase] ?? 0) + ms;
  }

  /** Count something that happened this window (sim steps retired, effects spawned). The
   *  report reads these as per-second rates, which is what makes a stalled sim visible. */
  tally(name: string, n = 1): void {
    if (!ON) return;
    this.winTally[name] = (this.winTally[name] ?? 0) + n;
  }

  /** Record the WORST value of something this window — a max rather than a sum. The single
   *  slowest sim step is the number a mean over a window is guaranteed to hide. */
  gauge(name: string, v: number): void {
    if (!ON) return;
    if (v > (this.winGauge[name] ?? 0)) this.winGauge[name] = v;
  }

  /**
   * One rendered frame, with its delta in ms. Closes the sample window when it is due.
   *
   * Call this LAST in the frame, after every `end` — the phase splits it reads are the ones
   * this frame just wrote, and a spike record with half a frame in it is worse than none.
   */
  frame(dtMs: number): void {
    if (!ON || !this.id) return;
    const now = performance.now();
    this.winFrames.push(dtMs);
    if (dtMs >= SPIKE_MS && this.spikes < MAX_SPIKES) {
      this.spikes++;
      this.push({ t: "spike", ms: now - this.t0, dt: round(dtMs), phase: rounded(this.framePhase) });
    }
    for (const k in this.framePhase) this.framePhase[k] = 0;
    if (now - this.winStart >= SAMPLE_MS) this.closeWindow(now);
    if (now >= this.flushAt) this.flush();
  }

  /** End the session: flush the tail and let the server write its report beside the log. */
  close(): void {
    if (!ON || !this.id) return;
    if (this.winFrames.length) this.closeWindow(performance.now());
    const id = this.id;
    this.flush();
    this.id = null;
    this.reset();
    void fetch("/perf/end", { method: "POST", body: JSON.stringify({ id }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((r: { report?: string } | null) => {
        if (r?.report) console.info(`[perf] session report written to ${r.report}`);
      })
      .catch(() => {});
  }

  // --- internals ---------------------------------------------------------------

  private now(): number {
    return performance.now() - this.t0;
  }

  private push(r: Rec): void {
    this.pending.push(r);
  }

  /** Aggregate the window into one `sample` record: how the frames went, where the time
   *  went, and what the world was carrying while they went that way. */
  private closeWindow(now: number): void {
    const f = this.winFrames;
    const elapsed = now - this.winStart;
    this.winStart = now;
    this.winFrames = [];
    const phase = this.winPhase;
    this.winPhase = {};
    const tally = this.winTally;
    this.winTally = {};
    const gauge = this.winGauge;
    this.winGauge = {};
    if (!f.length || elapsed <= 0) return;

    const sorted = [...f].sort((a, b) => a - b);
    const fps = (f.length / elapsed) * 1000;
    const counts = this.source?.() ?? {};
    const mem = memory();
    const per = 1 / f.length; // phase totals are reported as ms PER FRAME, like the deltas are
    const rate = 1000 / elapsed;
    this.samples++;
    this.push({
      t: "sample",
      ms: now - this.t0,
      fps: round(fps),
      frames: f.length,
      // The MEAN as well as the percentiles: the report subtracts the phase means from it to
      // get what no span accounted for, and a p50 minus a set of means is not a quantity.
      mean: round(avg(f)),
      // p50/p95/max, because an average frame time hides the every-other-frame hitch that
      // is what the player actually feels.
      p50: round(sorted[Math.floor(sorted.length * 0.5)]),
      p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
      max: round(sorted[sorted.length - 1]),
      phase: rounded(phase, per),
      rate: rounded(tally, rate),
      worst: rounded(gauge),
      counts,
      heap: mem ? Math.round(mem.usedJSHeapSize / 1048576) : 0,
      longTasks: this.longTasks,
      longTaskMs: Math.round(this.longTaskMs),
      errors: this.errorCount(),
    });
    this.longTasks = 0;
    this.longTaskMs = 0;

    // …and the deep census, on its own slower clock. It rides the sample boundary rather than
    // a timer of its own so a snapshot always sits beside a sample it can be read against.
    if (this.deep && now >= this.snapAt) {
      this.snapAt = now + SNAPSHOT_MS;
      this.push({ t: "snapshot", ms: now - this.t0, ...this.deep() });
    }

    // The live half of the analysis. Everything else is post-hoc, but "it just fell off a
    // cliff" is worth saying while somebody is looking at the screen it happened on — and
    // worth marking in the file, because the records either side of this one are the ones
    // the investigation actually wants.
    if (this.samples > 5) this.bestFps = Math.max(this.bestFps, fps);
    if (!this.dropped && this.bestFps >= 20 && fps < this.bestFps * 0.5) {
      this.dropped = true;
      this.push({ t: "drop", ms: now - this.t0, fps: round(fps), from: round(this.bestFps) });
      console.warn(`[perf] framerate fell from ~${Math.round(this.bestFps)} to ${Math.round(fps)} fps`);
    }
  }

  private flush(force = false): void {
    if (!this.id || (!this.pending.length && !force)) return;
    const body = JSON.stringify({ id: this.id, lines: this.pending });
    this.pending = [];
    this.flushAt = performance.now() + FLUSH_MS;
    void fetch("/perf/append", { method: "POST", body, keepalive: body.length < 60000 }).catch(() => {});
  }

  /** The tail, on the way out. `fetch` is cancelled by a navigation; a beacon is not. */
  private flushBeacon(): void {
    if (!this.id || !this.pending.length) return;
    const body = JSON.stringify({ id: this.id, lines: this.pending });
    this.pending = [];
    navigator.sendBeacon("/perf/append", new Blob([body], { type: "text/plain" }));
  }

  private errorCount(): number {
    let n = 0;
    for (const v of this.logs.values()) if (v.level === "error") n += v.n;
    return n;
  }

  /**
   * Console capture. A match that starts throwing once per frame — a missing model asked for
   * sixty times a second, a WebGL warning per instance — loses its framerate to the console
   * itself, and that cause is invisible in a timing breakdown because it is spread across
   * every phase. Deduped by message, so the record is "this fired 40,000 times", not 40,000
   * records.
   */
  private hookConsole(): void {
    const wrap = (level: "warn" | "error") => {
      const orig = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        this.record(level, args);
        orig(...args);
      };
      return () => {
        console[level] = orig;
      };
    };
    const un1 = wrap("warn");
    const un2 = wrap("error");
    const onErr = (e: ErrorEvent) => this.record("error", [e.message]);
    const onRej = (e: PromiseRejectionEvent) => this.record("error", [`unhandled rejection: ${String(e.reason)}`]);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    this.consoleHooks = () => {
      un1();
      un2();
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }

  private record(level: string, args: unknown[]): void {
    if (!this.id && !this.opening) return;
    let msg = "";
    for (const a of args) {
      if (msg.length > 200) break;
      msg += (typeof a === "string" ? a : a instanceof Error ? a.message : safe(a)) + " ";
    }
    msg = msg.slice(0, 200).trim();
    const hit = this.logs.get(msg);
    if (hit) {
      hit.n++;
      return;
    }
    if (this.logs.size >= MAX_LOG_KINDS) return;
    this.logs.set(msg, { level, n: 1, first: this.now() });
    this.push({ t: "log", ms: this.now(), level, msg });
  }

  /** Chrome reports any task that blocked the main thread for >50 ms. A frame loop that is
   *  merely doing too much shows up as long frames; a GC pause or a synchronous decode shows
   *  up HERE, which is how the two are told apart. */
  private hookLongTasks(): void {
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.longTasks++;
          this.longTaskMs += e.duration;
        }
      });
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      this.observer = null; // not Chrome — the rest of the log is unaffected
    }
  }

  private hookUnload(): void {
    const onHide = () => {
      // Counts included: a session that ends by closing the tab should still say what the
      // world was carrying at the end, which is usually the interesting number.
      if (this.winFrames.length) this.closeWindow(performance.now());
      this.logTallies();
      this.flushBeacon();
    };
    window.addEventListener("pagehide", onHide);
    this.unload = () => window.removeEventListener("pagehide", onHide);
  }

  /** The console census, written once at the end so each message carries its final count. */
  private logTallies(): void {
    for (const [msg, v] of this.logs) {
      if (v.n > 1) this.push({ t: "log-total", ms: this.now(), level: v.level, msg, n: v.n, first: round(v.first) });
    }
    this.logs.clear();
  }

  private reset(): void {
    this.logTallies();
    this.flush(true);
    this.consoleHooks?.();
    this.consoleHooks = null;
    this.observer?.disconnect();
    this.observer = null;
    this.unload?.();
    this.unload = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.source = null;
    this.spikes = 0;
    this.samples = 0;
    this.bestFps = 0;
    this.dropped = false;
    this.winFrames = [];
    this.winPhase = {};
    this.winTally = {};
    this.winGauge = {};
    this.framePhase = {};
    this.deep = null;
    this.snapAt = 0;
  }
}

function avg(a: number[]): number {
  let s = 0;
  for (const v of a) s += v;
  return a.length ? s / a.length : 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function rounded(src: Record<string, number>, scale = 1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k in src) {
    const v = src[k];
    if (v) out[k] = round(v * scale);
  }
  return out;
}

/** Console arguments are whatever the caller passed. A circular object stringifies to a
 *  useless "[object Object]", so fall back to its shape — enough to recognise it by. */
function safe(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 120) ?? String(v);
  } catch {
    const o = v as Record<string, unknown>;
    const name = (o?.constructor as { name?: string } | undefined)?.name ?? typeof v;
    try {
      return `${name}{${Object.keys(o).slice(0, 8).join(",")}}`;
    } catch {
      return name;
    }
  }
}

/** Chrome's non-standard heap readout. Absent elsewhere; the log just carries 0 there. */
function memory(): { usedJSHeapSize: number; jsHeapSizeLimit: number } | null {
  return (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory ?? null;
}

/** The one recorder. A match begins and ends it; nothing else needs a handle on it. */
export const perfLog = new PerfLog();
