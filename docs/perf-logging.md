# Performance logging — every match writes a file

The bug this exists for: *a match runs fine, and then after a while it is at 5 fps and stays
there.* The metrics overlay in the corner cannot answer that. By the time you look at it, the
two things worth knowing — **when** it turned, and **what was different either side of the
turn** — have already gone past. So every match records itself.

```
pnpm dev:log                   # the dev server, recording every match to .logs/
pnpm dev:log 2                 # …sampling every 2 s instead of every 1 s
pnpm dev:log 1,30              # …sample every 1 s, deep snapshot every 30 s
pnpm dev                       # unchanged: records nothing, measures nothing

pnpm perf:report               # render the newest session's digest (also printed to stdout)
pnpm perf:report -- --list     # what is in .logs/
pnpm perf:report -- <file>     # a specific session
pnpm perf:report -- --all      # re-render every session
```

Recording is **opt-in per dev server**. Without `dev:log` the `/perf/*` endpoints are not
mounted and the client's `__OW3_PERF_MS__` is 0, so the recorder never opens a session and
never takes a timestamp — the alternative (always record, decide later) puts a measurement in
every frame of a session nobody asked to measure.

A clean exit (leaving the match) renders the digest by itself, so `.logs/` normally holds a
`.txt` beside each `.ndjson`. The CLI is for the sessions that did **not** end cleanly — a tab
crash, a killed dev server — which are exactly the ones this feature is for.

`.logs/` is gitignored and pruned to the newest 40 sessions. Add `?noperf` to the URL to turn
recording off for one boot.

## The three pieces

| | |
|---|---|
| [`src/dev/perfLog.ts`](../src/dev/perfLog.ts) | the recorder — timings, the census, the console capture |
| [`tools/dev-log.mjs`](../tools/dev-log.mjs) | `pnpm dev:log` — Vite with `OPENWAR3_PERF` set |
| [`tools/vite-plugin-perf-log.ts`](../tools/vite-plugin-perf-log.ts) | the dev server's `/perf/*` endpoints, which own `.logs/` |
| [`tools/perf-report.mjs`](../tools/perf-report.mjs) | all of the analysis, off the file |

**Why the dev server writes the file.** A browser cannot append to a file in the project, and
everything it *can* write to (localStorage, IndexedDB, a download) is somewhere you cannot
grep, diff, or hand to a script. Like `devInstall`, the plugin carries `apply: "serve"`, so the
route is not in a build at all — a published OpenWar3 has no endpoint that writes to disk
because there is no endpoint. The client half goes inert with it: `ON` is
`import.meta.env.DEV && __OW3_PERF_MS__ > 0`, and both halves of that are compile-time
constants a build folds to `false`, so every entry point returns before it takes a timestamp.
(The class itself survives minification — it is instantiated as a singleton — so this is
"never runs", not "is not there". The *endpoints* are the part that is genuinely absent.)

**Why the analysis is not in the client.** Everything derived — trends, correlations, the drop
point — is computed by the report tool from the file, so it also works on the session that died
without closing. The client records and does not interpret. The one exception is the live
`drop` record, which is worth a console line while somebody is sitting there watching it
happen.

**Why lines are appended as they are produced** (every 5 s, plus a `sendBeacon` on `pagehide`):
the session worth reading is usually the one that ended in a crash. A log that only existed for
clean exits would miss precisely those.

## What a session records

One `sample` record per second, plus `spike` / `note` / `log` / `drop` records on the same
timeline. A sample carries:

- **frame times** — fps, mean, p50, p95, worst. The p50/p95 split is the point: an average
  hides the every-other-frame hitch, which is what the player actually feels.
- **where the frame went** — ms per frame for each phase of the loop: `sim` (the world's step),
  `script` (the map's JASS, timed apart from the sim on purpose — a map whose triggers pile up
  is a cause that looks nothing like ours), `ui`, `fx`, `drains`, `anim`, `fog`, `render`,
  `overlay`. The report subtracts them from the mean frame time and reports the remainder as
  `(unaccounted)`.
- **a census** — every collection the match can grow: the sim's units/projectiles/corpses/items,
  this scene's effect and decal lists, the viewer's instances/resources/particles, the DOM node
  count, the audio graph, the heap.
- **rates** — sim steps retired per second, and how often the frame hit `MAX_STEPS_PER_FRAME`.
  A sim falling behind wall time is the difference between "the game is slow" and "the game is
  slow *and* running in slow motion".
- **worst case** — the single worst occurrence of a gauged quantity in the window (the slowest
  individual sim step, say), which a per-frame mean is guaranteed to hide.
- **long tasks** — Chrome's >50 ms main-thread blocks, which is how a GC pause is told apart
  from a frame that is merely doing too much.
- **the console, deduped** — a message repeating sixty times a second is itself a cost, and one
  that is invisible in a phase breakdown because it is spread across every phase.

And every snapshot period (15 s by default), a **deep census** the per-second one cannot
afford: live instances by model NAME, sim units by type and by owner, loaded resources by kind.
The per-second counters say *how much*; these say *of what* — and each is a walk over a few
hundred entries, which is nothing every fifteen seconds and unaffordable sixty times a second.
Neither uses `fetchUrl`: every asset is served through a blob URL minted per load, so a census
keyed on it would name nothing and group nothing.

## Reading the report

The digest is laid out to separate the three shapes a dying framerate comes in:

1. **The frame is doing more work than it used to.** One phase's ms/frame grew — `WHERE THE
   FRAME WENT` names it, and the search narrows to one call site.
2. **Something is accumulating.** A counter grew and the frame time grew with it. The `r`
   column in `WHAT CHANGED` is Pearson's correlation against the frame time, and it is what
   separates a leak (rises monotonically, `r` near 1) from a number that merely got big for
   good reasons (a late-game army: large, low `r`).
3. **Nothing in our loop grew at all.** The phases stay flat while the frame time does not, and
   `(unaccounted)` swells. Then the cost is outside the loop: GC (long tasks), the console, or
   the GPU — frame time up with every CPU phase flat is the tell for fill-rate/overdraw.

`ACROSS THE BIGGEST FALL` is for when the slowdown has a moment rather than a slope: it finds
the steepest sustained fall and prints what changed on either side of it, including any note or
first-time console error within 15 s.

## Adding to it

- **A new phase**: `perfLog.begin("name")` / `perfLog.end("name")` around a stretch of the
  frame loop in `src/render/mapViewer.ts`. Phases are meant to **partition** the frame — do not
  nest them, or the `(unaccounted)` row stops meaning anything.
- **A new counter**: one line in `MapViewerScene.perfCounts()`. The bar is "can this grow?" —
  a collection that only ever holds one thing tells you nothing, and a counter that costs more
  than a `.size` read does not belong in something sampled every second.
- **A snapshot field**: one line in `MapViewerScene.perfSnapshot()`. This is where anything
  that needs a *walk* belongs — "which model", "which type", "whose".
- **A worst case**: `perfLog.gauge("name", ms)` keeps the window's maximum rather than its sum.
- **A marker**: `perfLog.note("what happened")`. Cheap, and it is what turns a flat stretch in
  the timeline from a mystery into "that was the pause".
