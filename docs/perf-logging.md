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
| [`src/sim/profile.ts`](../src/sim/profile.ts) | the hole the sim calls, because it may not import the recorder |

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

## Two shapes the report keeps finding, and what fixed each

Both of these came out of one eight-player Feralas LV session and neither is visible in a mean.

**A SYNCHRONISED periodic cost is a spike, not an average.** Fog of war rebuilds at 10 Hz, one
grid per seat. Every `Viewpoint` was constructed with the same accumulator, so all of them
rebuilt on the same first tick and all of them reset to zero — they stayed in lockstep for the
whole match, and eight rebuilds landed on ONE frame ten times a second. `sim.fog` averaged
0.67 ms/frame and arrived as a ~6 ms hitch, which is most of a 120 fps budget spent in one go
while the eleven frames either side did no fog work at all. The fix is not less work: each
viewpoint takes a **phase offset out of its seat number** at its first rebuild
(`REBUILD_STAGGER`, [`src/game/viewpoint.ts`](../src/game/viewpoint.ts)), so the same total cost
arrives as eight small ones. The rate is unchanged, and the phase is derived from the slot, so
nothing about the sim's vision-gated decisions stops being deterministic. **Look for this
wherever N things share one period**, and read `p95`/`worst` rather than the mean to see it.

**In an O(n²) scan, the CHEAPEST predicate goes first.** Every whole-world target scan — the
sim's `nearestEnemy`/`acquireTarget`/`bestCreepTarget`, `applyAuras`'s inner loop, and the AI's
`enemyNear`/`foeBeside`/`focusTarget` — is a walk over every unit run by every unit, several
times a second. All of them tested *who the unit is* (an alliance-matrix lookup, or a whole
target-flag walk) before *where it is standing*. The clauses are pure and ANDed, so their order
cannot change the answer — only how much of the world pays for the dear one, and the answer is
"a handful of units are ever in range". `SimWorld.distSkip` is the exact squared-distance form
of the hull-to-hull test those scans reject on, so nothing downstream shifts.

**THE SAME EXPENSIVE ANSWER, COMPUTED OVER AND OVER.** `sim.fog` — the per-seat vision rebuild —
was 2.49 ms of a 14 ms frame in an eight-player Feralas LV match, the largest sub-phase of the sim
after the world step itself. Nothing about it was wrong: `revealLineOfSight` casts a ray to every
cell on a unit's sight ring and walks it, which is O(R²), and R is ~22 cells for a footman and ~28
for a town hall. The cost was that the SAME cast was being paid again for every viewpoint, ten
times a second, for units that had not moved — around sixteen million ray steps a second with 366
units on the field. The fix is not a cheaper cast: it is **noticing that the answer is a fact
about the TERRAIN, not about who is looking**. Every viewpoint is installed with the same height
field and handed every felled tree, so a unit standing on a spot lights the same cells for its
owner, for each ally sharing vision, and for an observer — and it lights them again next round if
it has not moved a vision cell. `SightStamps`
([`src/sim/vision.ts`](../src/sim/vision.ts)) casts once and replays a cell list, keyed on the
UNIT so the cache has one entry per unit rather than a new one every 64 world units a unit walks.
**Look for this wherever a per-frame cost is multiplied by a number of OBSERVERS** — and note
what made it findable: `sim.fog` was already a phase of its own, so the report named it without
anybody profiling anything.

**THE SAME ANSWER, UPLOADED AGAIN.** Every MDX instance owns a bone-matrix texture and re-sent it
to the GPU every frame — one `bindTexture` plus one `texSubImage2D` apiece, and the cost is almost
entirely the CALL rather than the bytes: ~2 µs an instance whether it carries three bones or two
hundred. Probed in a real match with 249 visible instances, **127 of those uploads were identical
to the previous frame's**, and the split was exactly by model: every unit animating, every tree
standing still. A doodad's Stand sequence has no tracks, so `updateNodes` marks not one of its
nodes dirty and `recalculateTransformation` — the only thing that writes `worldMatrices` — never
runs. The fix is to notice, and `updateNodes` already knew: `wasDirty` per node is what tells it
whether to recompute that node at all, so collecting it costs nothing. **Look for this wherever
something is PUSHED on a clock rather than on a change** — and note the shape it shares with the
fog rebuild above: neither was doing anything wrong, both were answering a question nobody had
asked again.

**A SEARCH THAT NO LONGER FITS IN A FRAME IS SLICED, NOT SHRUNK.** The escalated path search
— the one that pays for a real detour, up to 262,144 cells — used to run whole in one sim step:
a 90–190 ms stall wherever it landed, and the whole of the pathfinding tail. It is now a JOB
(`SimWorld.pumpPathJob`, its own `sim.world.move.job` span): the same loop on a working set of
its own, `PATH_SLICE_EXPANSIONS` cells a step, counted in expansions so every machine slices at
the same cell and a replay stays a replay. `pathJobsLanded` is how many finished per second.
Measured on the same 4v4, worst single search 166 → **27.5 ms** and frames over 100 ms
365 → **26**, for 0.39 ms/frame of job work. The pattern generalises: when one step's worst
case is the problem, ask what the work's natural unit is and pay one unit per step.

## A counter that is not a cost

`pathNodes` is the sum of every unit's remaining WAYPOINTS. It is a census of what the units are
holding, not of what the pathfinder did — a unit walking a long way holds a dozen of them and a
unit that has just been given a short order holds two, and neither says anything about how much
searching happened. Read as though it were work, it says "8× the pathing for 1.3× the units" in a
session where nothing of the sort was going on; the actual rate, once counted, was **29 searches a
second across eight players**. Every census counter here has this shape, so before drawing a
conclusion from one, check whether it counts a THING or an EVENT.

## Adding to it

- **A new phase**: `perfLog.begin("name")` / `perfLog.end("name")` around a stretch of the
  frame loop in `src/render/mapViewer.ts`. Top-level phases must **partition** the frame — they
  are summed and subtracted from the frame time, so two that overlap make `(unaccounted)` a
  lie.
- **A phase INSIDE a phase**: give the span a dotted name. The report reads anything with a dot
  as a breakdown of the name before its last dot and leaves it out of the partition, so
  `sim.ai` may sit inside `sim` and `sim.world.move.walk` inside `sim.world.move`, nested as
  deep as is useful. Each parent gets its own table under `INSIDE EACH PHASE`, with a
  `(the rest of it)` row for what its children do not account for. This is how the AI was
  caught: `sim` said "the sim", `sim.ai.attack` said which pass.
- **From inside the sim**: `src/sim/world.ts` must keep compiling **standalone to CommonJS**
  for the headless tests, and `perfLog.ts` reads `import.meta.env`, which is not even syntax
  there. So the sim calls `simProfile.begin/end/gauge` from `src/sim/profile.ts` — a no-op the
  renderer plugs the real recorder into when a match starts. Never import the recorder into
  `src/sim/`.
- **A COUNT, from inside the sim**: `simProfile.tally("name")` (or `tally(name, n)`), which the
  report reads as a per-second rate. Reach for this whenever the question is *how often* rather
  than *how long* — the two are different bugs and a phase time cannot tell them apart. `walk`
  growing could be the stepping loop doing its job for more units, or it could be the pathfinder
  being asked over and over; `pathSearches` and `pathExpansions` answer that in one line of the
  report and cost nothing when the recorder is unplugged.
- **A new counter**: one line in `MapViewerScene.perfCounts()`. The bar is "can this grow?" —
  a collection that only ever holds one thing tells you nothing, and a counter that costs more
  than a `.size` read does not belong in something sampled every second.
- **A snapshot field**: one line in `MapViewerScene.perfSnapshot()`. This is where anything
  that needs a *walk* belongs — "which model", "which type", "whose".
- **A worst case**: `perfLog.gauge("name", ms)` keeps the window's maximum rather than its
  sum. Reach for this for anything that runs on its OWN period rather than per frame — a pass
  that fires once a second is averaged into invisibility by a per-frame mean, and its real
  cost (one 400 ms stall) only shows up as a maximum.
- **A marker**: `perfLog.note("what happened")`. Cheap, and it is what turns a flat stretch in
  the timeline from a mystery into "that was the pause".
