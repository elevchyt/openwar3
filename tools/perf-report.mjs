/**
 * Render a readable digest of one performance session (`.logs/*.ndjson`, written by
 * `src/dev/perfLog.ts` through `tools/vite-plugin-perf-log.ts`).
 *
 *   pnpm perf:report                 # the newest session in .logs/
 *   pnpm perf:report -- <file>       # a specific one
 *   pnpm perf:report -- --all        # re-render every session's .txt
 *
 * The dev server calls `renderReport` itself when a match ends, so the digest is normally
 * already sitting beside the log. This CLI exists for the sessions that did NOT end cleanly —
 * a tab crash, a killed dev server — which are the ones the framerate bug tends to produce.
 *
 * **What the digest is trying to answer.** "It drops to 5 fps and stays there" has three
 * candidate shapes, and the report is laid out to tell them apart in one read:
 *
 *   1. *The frame is doing more work than it used to* — one PHASE's ms/frame grew. The phase
 *      table names it (sim, script, render, fx, …), so the search narrows to one call site.
 *   2. *Something is accumulating* — a COUNTER grew and the frame time grew with it. The
 *      correlation column is the whole point: a leak shows up as a counter that rises
 *      monotonically with `r` near 1, whereas a counter that merely happens to be big (unit
 *      count in a late-game army) sits far lower.
 *   3. *Nothing in the frame grew at all* — the phases stay flat while the deltas do not, and
 *      the cost is outside our own loop: GC (long tasks), the console (a per-frame throw),
 *      or the GPU (frame time up, CPU phases flat — the tell for fill-rate/overdraw).
 *
 * A pure formatter: it derives, it never mutates the log.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const DIR = ".logs";
/** Fraction of the session averaged for the "early" and "late" columns. */
const EDGE = 0.2;
/** Rows in the fps timeline, at most. */
const TIMELINE_ROWS = 24;

// --- small helpers ------------------------------------------------------------------

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function clock(ms) {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function dur(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function fixed(n, d = 1) {
  return Number.isFinite(n) ? n.toFixed(d) : "—";
}

function signed(n, d = 1) {
  const v = fixed(Math.abs(n), d);
  return n >= 0 ? `+${v}` : `-${v}`;
}

/** Pearson's r. The report's one statistic, and the reason a leak is legible at all: it
 *  separates "grew alongside the slowdown" from "was merely large". */
function correlate(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return 0;
  const mx = avg(xs.slice(0, n));
  const my = avg(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

function table(head, rows) {
  if (!rows.length) return ["  (none)"];
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)));
  const line = (r) => "  " + r.map((c, i) => (i === 0 ? String(c ?? "").padEnd(w[i]) : String(c ?? "").padStart(w[i]))).join("  ");
  return [line(head), "  " + w.map((n) => "─".repeat(n)).join("  "), ...rows.map(line)];
}

/** A label/value block (the header) — a table with no header row to speak of. */
function kv(rows) {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${String(k).padEnd(w)}  ${v}`);
}

function bar(v, max, width = 22) {
  const n = max > 0 ? Math.round((v / max) * width) : 0;
  return "█".repeat(Math.max(0, Math.min(width, n))).padEnd(width, "·");
}

// --- the report ---------------------------------------------------------------------

/** Parse an .ndjson session log and render its digest. `text` in, report out. */
export function renderReport(text) {
  const recs = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      // A half-written last line is what an unclean exit leaves behind. Everything before
      // it is still perfectly good data, so read what there is and carry on.
    }
  }
  const head = recs.find((r) => r.t === "session") ?? {};
  const samples = recs.filter((r) => r.t === "sample");
  const out = [];
  const push = (...l) => out.push(...l);

  push("OpenWar3 — session performance report", "=".repeat(60), "");
  push(...kv(
    [
      ["map", String(head.map ?? "—")],
      ["mode", String(head.mode ?? "—")],
      ["started", String(head.startedAt ?? "—")],
      ["duration", samples.length ? dur(samples[samples.length - 1].ms) : "—"],
      ["samples", `${samples.length} · ${samples.reduce((s, r) => s + num(r.frames), 0)} frames`],
      ["canvas", `${head.canvas ?? "?"} · dpr ${head.dpr ?? "?"} · screen ${head.screen ?? "?"}`],
      ["machine", `${head.cores ?? "?"} cores · heap limit ${Math.round(num(head.heapLimit) / 1048576)} MB`],
    ],
  ));
  push("");

  if (samples.length < 3) {
    push("Too few samples to analyse — the session ended within a few seconds.");
    return out.join("\n") + "\n";
  }

  const edge = Math.max(1, Math.floor(samples.length * EDGE));
  const early = samples.slice(0, edge);
  const late = samples.slice(-edge);
  const fpsOf = (rs) => avg(rs.map((r) => num(r.fps)));
  const p50Of = (rs) => avg(rs.map((r) => num(r.p50)));
  // Older logs carry no `mean`; p50 is the honest stand-in for them.
  const meanOf = (rs) => avg(rs.map((r) => num(r.mean) || num(r.p50)));

  // --- framerate ---------------------------------------------------------------
  push("FRAMERATE", "─".repeat(60));
  push(...table(
    ["window", "fps", "frame p50", "p95", "worst", "heap MB"],
    [
      [`first ${dur(early[early.length - 1].ms)}`, fixed(fpsOf(early)), fixed(p50Of(early)), fixed(avg(early.map((r) => num(r.p95)))), fixed(Math.max(...early.map((r) => num(r.max)))), Math.round(avg(early.map((r) => num(r.heap))))],
      [`last ${dur(late[late.length - 1].ms - late[0].ms)}`, fixed(fpsOf(late)), fixed(p50Of(late)), fixed(avg(late.map((r) => num(r.p95)))), fixed(Math.max(...late.map((r) => num(r.max)))), Math.round(avg(late.map((r) => num(r.heap))))],
    ],
  ));
  const ratio = fpsOf(early) > 0 ? fpsOf(late) / fpsOf(early) : 1;
  push("");
  push(
    ratio < 0.6
      ? `  ⚠ the session ENDED at ${Math.round(ratio * 100)}% of the framerate it started with.`
      : `  framerate held (ended at ${Math.round(ratio * 100)}% of its opening rate).`,
  );
  for (const d of recs.filter((r) => r.t === "drop")) push(`  ⚠ fell from ~${Math.round(num(d.from))} to ${Math.round(num(d.fps))} fps at ${clock(d.ms)}`);
  push("");

  // --- timeline ----------------------------------------------------------------
  const step = Math.max(1, Math.ceil(samples.length / TIMELINE_ROWS));
  const buckets = [];
  for (let i = 0; i < samples.length; i += step) {
    const b = samples.slice(i, i + step);
    buckets.push({ at: b[0].ms, fps: fpsOf(b), p95: avg(b.map((r) => num(r.p95))), heap: avg(b.map((r) => num(r.heap))) });
  }
  const maxFps = Math.max(...buckets.map((b) => b.fps), 1);
  push("TIMELINE  (each row ≈ " + dur(step * 1000) + ")", "─".repeat(60));
  push(...table(
    ["at", "fps", "", "p95 ms", "heap MB"],
    buckets.map((b) => [clock(b.at), fixed(b.fps, 0), bar(b.fps, maxFps), fixed(b.p95, 0), fixed(b.heap, 0)]),
  ));
  push("");

  // --- where the frame time went -----------------------------------------------
  const phases = [...new Set(samples.flatMap((r) => Object.keys(r.phase ?? {})))];
  const phaseRows = phases
    .map((p) => {
      const series = samples.map((r) => num(r.phase?.[p]));
      const a = avg(early.map((r) => num(r.phase?.[p])));
      const b = avg(late.map((r) => num(r.phase?.[p])));
      return { p, a, b, d: b - a, r: correlate(series, samples.map((s) => num(s.p50))) };
    })
    .sort((x, y) => y.d - x.d);
  // Everything the frame spent that no span claimed: vsync waits, browser work between
  // frames, and any phase we simply have not instrumented. A large and GROWING unaccounted
  // column is itself the finding — it means the cost is outside our own loop.
  const unA = meanOf(early) - phaseRows.reduce((s, r) => s + r.a, 0);
  const unB = meanOf(late) - phaseRows.reduce((s, r) => s + r.b, 0);
  push("WHERE THE FRAME WENT  (ms per frame, averaged)", "─".repeat(60));
  push(...table(
    ["phase", "first", "last", "change", "r vs frame"],
    [
      ...phaseRows.map((r) => [r.p, fixed(r.a, 2), fixed(r.b, 2), signed(r.d, 2), fixed(r.r, 2)]),
      ["(unaccounted)", fixed(unA, 2), fixed(unB, 2), signed(unB - unA, 2), ""],
      ["= frame mean", fixed(meanOf(early), 2), fixed(meanOf(late), 2), signed(meanOf(late) - meanOf(early), 2), ""],
    ],
  ));
  push("");

  // --- rates (things counted per second) ---------------------------------------
  const rates = [...new Set(samples.flatMap((r) => Object.keys(r.rate ?? {})))];
  if (rates.length) {
    push("RATES  (per second)", "─".repeat(60));
    push(...table(
      ["what", "first", "last", "change"],
      rates.map((k) => {
        const a = avg(early.map((r) => num(r.rate?.[k])));
        const b = avg(late.map((r) => num(r.rate?.[k])));
        return [k, fixed(a, 1), fixed(b, 1), signed(b - a, 1)];
      }),
    ));
    push("");
  }

  // --- worst-case gauges --------------------------------------------------------
  const gauges = [...new Set(samples.flatMap((r) => Object.keys(r.worst ?? {})))];
  if (gauges.length) {
    push("WORST CASE  (the single worst occurrence in each window, not an average)", "─".repeat(60));
    push(...table(
      ["what", "first", "last", "peak"],
      gauges.map((k) => {
        const series = samples.map((r) => num(r.worst?.[k]));
        return [k, fixed(avg(early.map((r) => num(r.worst?.[k]))), 2), fixed(avg(late.map((r) => num(r.worst?.[k]))), 2), fixed(Math.max(...series), 2)];
      }),
    ));
    push("");
  }

  // --- what grew ---------------------------------------------------------------
  const keys = [...new Set(samples.flatMap((r) => Object.keys(r.counts ?? {})))];
  const frameSeries = samples.map((r) => num(r.p50));
  const grew = keys
    .map((k) => {
      const series = samples.map((r) => num(r.counts?.[k]));
      const a = avg(early.map((r) => num(r.counts?.[k])));
      const b = avg(late.map((r) => num(r.counts?.[k])));
      return { k, a, b, d: b - a, peak: Math.max(...series), r: correlate(series, frameSeries) };
    })
    .filter((r) => r.d !== 0)
    .sort((x, y) => y.r - x.r || y.d - x.d);
  push("WHAT CHANGED  (counters, sorted by how closely they track the frame time)", "─".repeat(60));
  push(...table(
    ["counter", "first", "last", "change", "peak", "r"],
    grew.map((r) => [r.k, fixed(r.a, 0), fixed(r.b, 0), signed(r.d, 0), fixed(r.peak, 0), fixed(r.r, 2)]),
  ));
  push("");
  const suspects = grew.filter((r) => r.r > 0.8 && r.d > 0).slice(0, 5);
  if (suspects.length) {
    push("  Rose monotonically WITH the frame time (r > 0.8) — the leak candidates:");
    for (const s of suspects) push(`    · ${s.k}: ${fixed(s.a, 0)} → ${fixed(s.b, 0)} (peak ${fixed(s.peak, 0)})`);
    push("");
  }

  // --- the drop, either side of it ---------------------------------------------
  // The single worst sample-to-sample fall, and what was different across it. When the
  // slowdown has a moment rather than a slope, this is the section that names it.
  let worst = { i: -1, fall: 0 };
  const smooth = samples.map((_, i) => avg(samples.slice(Math.max(0, i - 2), i + 3).map((s) => num(s.fps))));
  for (let i = 3; i < smooth.length - 3; i++) {
    const fall = smooth[i - 3] - smooth[i + 3];
    if (fall > worst.fall) worst = { i, fall };
  }
  if (worst.i > 0 && worst.fall > Math.max(5, smooth[0] * 0.2)) {
    const before = samples.slice(Math.max(0, worst.i - 6), worst.i);
    const after = samples.slice(worst.i + 1, worst.i + 7);
    push(`ACROSS THE BIGGEST FALL  (at ${clock(samples[worst.i].ms)}: ${fixed(fpsOf(before), 0)} → ${fixed(fpsOf(after), 0)} fps)`, "─".repeat(60));
    const moved = keys
      .map((k) => {
        const a = avg(before.map((r) => num(r.counts?.[k])));
        const b = avg(after.map((r) => num(r.counts?.[k])));
        return { k, a, b, d: b - a };
      })
      .filter((r) => Math.abs(r.d) > 0.5)
      .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
      .slice(0, 12);
    push(...table(["counter", "before", "after", "change"], moved.map((r) => [r.k, fixed(r.a, 0), fixed(r.b, 0), signed(r.d, 0)])));
    const pm = phases
      .map((p) => ({ p, a: avg(before.map((r) => num(r.phase?.[p]))), b: avg(after.map((r) => num(r.phase?.[p]))) }))
      .map((r) => ({ ...r, d: r.b - r.a }))
      .sort((x, y) => y.d - x.d)
      .slice(0, 5);
    push("");
    push(...table(["phase", "before", "after", "change"], pm.map((r) => [r.p, fixed(r.a, 2), fixed(r.b, 2), signed(r.d, 2)])));
    // Anything the game announced right around the fall — a note, a first-time console
    // error. Usually this is the answer on its own.
    const win = [samples[worst.i].ms - 15000, samples[worst.i].ms + 15000];
    const near = recs.filter((r) => (r.t === "note" || r.t === "log") && r.ms >= win[0] && r.ms <= win[1]);
    if (near.length) {
      push("", "  events around the fall:");
      for (const n of near.slice(0, 15)) push(`    ${clock(n.ms)}  ${n.t === "note" ? n.name : `${n.level}: ${n.msg}`}`);
    }
    push("");
  }

  // --- spikes ------------------------------------------------------------------
  const spikes = recs.filter((r) => r.t === "spike");
  if (spikes.length) {
    const top = [...spikes].sort((a, b) => num(b.dt) - num(a.dt)).slice(0, 10);
    push(`SLOWEST FRAMES  (${spikes.length} over 100 ms)`, "─".repeat(60));
    push(...table(
      ["at", "ms", "dominant phases"],
      top.map((s) => [
        clock(s.ms),
        fixed(num(s.dt), 0),
        Object.entries(s.phase ?? {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([k, v]) => `${k} ${fixed(v, 1)}`)
          .join("  "),
      ]),
    ));
    push("");
  }

  // --- long tasks + the console -------------------------------------------------
  const ltA = avg(early.map((r) => num(r.longTaskMs)));
  const ltB = avg(late.map((r) => num(r.longTaskMs)));
  if (ltA || ltB) {
    push("LONG TASKS  (>50 ms of blocked main thread, ms per second)", "─".repeat(60));
    push(`  first ${fixed(ltA, 0)} ms/s · last ${fixed(ltB, 0)} ms/s · ${signed(ltB - ltA, 0)}`);
    push("  (rising with flat phases = GC or a synchronous load, not the frame's own work)");
    push("");
  }
  const totals = new Map();
  for (const r of recs) {
    if (r.t !== "log" && r.t !== "log-total") continue;
    const prev = totals.get(r.msg) ?? { level: r.level, n: 0, first: r.ms };
    totals.set(r.msg, { level: r.level, n: Math.max(prev.n, num(r.n) || 1), first: Math.min(prev.first, r.ms) });
  }
  if (totals.size) {
    push("CONSOLE  (deduped — a message repeating per frame is itself a cost)", "─".repeat(60));
    push(...table(
      ["level", "×", "first", "message"],
      [...totals.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 20)
        .map(([msg, v]) => [v.level, String(v.n), clock(v.first), msg.slice(0, 90)]),
    ));
    push("");
  }

  // --- the deep census, first and last --------------------------------------------
  // Printed as a pair rather than a series: its whole job is "of WHAT" once the counters have
  // said "how much", and that question is answered by comparing the two ends.
  const snaps = recs.filter((r) => r.t === "snapshot");
  if (snaps.length) {
    const a = snaps[0];
    const b = snaps[snaps.length - 1];
    push(`SNAPSHOTS  (${snaps.length} taken — ${clock(a.ms)} vs ${clock(b.ms)})`, "─".repeat(60));
    for (const group of ["models", "unitTypes", "owners", "files"]) {
      const keys = [...new Set([...Object.keys(a[group] ?? {}), ...Object.keys(b[group] ?? {})])];
      if (!keys.length) continue;
      const rows = keys
        .map((k) => ({ k, a: num(a[group]?.[k]), b: num(b[group]?.[k]) }))
        .sort((x, y) => y.b - x.b || y.a - x.a)
        .slice(0, 12)
        .map((r) => [r.k.length > 58 ? "…" + r.k.slice(-57) : r.k, String(r.a), String(r.b), signed(r.b - r.a, 0)]);
      push(`  ${group}:`);
      push(...table(["", "first", "last", "change"], rows));
      push("");
    }
  }

  const notes = recs.filter((r) => r.t === "note");
  if (notes.length) {
    push("TIMELINE NOTES", "─".repeat(60));
    for (const n of notes.slice(0, 40)) push(`  ${clock(n.ms)}  ${n.name}`);
    push("");
  }

  return out.join("\n") + "\n";
}

// --- CLI ------------------------------------------------------------------------

function sessions() {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".ndjson"))
      .map((f) => ({ f: join(DIR, f), at: statSync(join(DIR, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .map((x) => x.f);
  } catch {
    return [];
  }
}

function render(file) {
  const out = file.replace(/\.ndjson$/, ".txt");
  const text = renderReport(readFileSync(file, "utf8"));
  writeFileSync(out, text);
  return { out, text };
}

if (process.argv[1] && basename(process.argv[1]) === "perf-report.mjs") {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const named = args.find((a) => !a.startsWith("-"));
  const all = named ? [named] : sessions();
  if (!all.length) {
    console.error(`No sessions in ${DIR}/ — play a match with \`pnpm dev\` running, then try again.`);
    process.exit(1);
  }
  if (args.includes("--all")) {
    for (const f of all) console.log(render(f).out);
  } else if (args.includes("--list")) {
    for (const f of all) console.log(f);
  } else {
    const { out, text } = render(all[0]);
    console.log(text);
    console.log(`(written to ${out})`);
  }
}
