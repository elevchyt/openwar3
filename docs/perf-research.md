# Performance research log — the low-performance work, and what of it belongs everywhere

A running ledger of the issue #161 performance effort: what was measured, what landed, what was
tried and taken back out, and what is still on the list. It exists for two reasons.

1. **So the measurements outlive the session that took them.** Every number here was taken the
   same way — Echo Isles, a scripted army, 6× CPU throttle in headless Chrome, and A/B pairs
   INTERLEAVED in one page wherever a runtime switch made that possible. That last part is not
   fussiness: this box is shared with the developer's own browser, and cross-run comparisons
   drifted by up to 20% while interleaved ones repeated to within noise. A number here without an
   interleaved pair beside it is a weaker claim, and says so.
2. **So the full-quality question can be asked properly later.** Some of this work is a QUALITY
   TRADE and belongs behind the Low Performance Mode flag for ever. Some of it is EXACT — it
   computes the same answer with less work — and exact work has no business being gated on a
   setting. The table below keeps that distinction per change, because it is the thing a later
   pass over full quality needs and the thing that is easiest to lose.

Read [`docs/video-options.md`](video-options.md) for what the mode IS and
[`docs/perf-logging.md`](perf-logging.md) for how to take these measurements.

## The ledger

| # | Change | Kind | Measured | State |
|---|---|---|---|---|
| 1 | The Video-panel row, forced at apply time | plumbing | — | landed `5d7c536` |
| 2 | **Shared pose cache** — one sampled pose per (model, clip, 1/30 s) | **trade** (30 Hz clips) | −12% | landed `76a424e` |
| 3 | **Shared skeleton** — instance-local bones, `u_instance` in the shader | **trade** (rides on 2) | 1.8–2.0× mixed, 2.4–3.1× all-shareable | landed `f631b4d` |
| 4 | Billboarded subtrees redone per body | exact (enables 3 for 21/69 models) | +16–29% of the low-perf frame | landed `077faa1` |
| 5 | Skip re-sampling when the body only MOVED | **exact** | nothing — sign flips between runs | **reverted** `bde87a9` |
| 6 | **Target-flag cache** — `targetFlagSet`, one Set per ability row | **exact** | **−23% low-perf, −26% full quality** | landed `11fb8de` |
| 7 | Overlay canvas box read on RESIZE, not 3×/frame | **exact** | `sim.overlays` 4.46 → 0.48 ms | landed |
| 8 | The game frame's box likewise (`syncFrame`) | **exact** | `getBoundingClientRect` 4.0% → out of the profile | landed |
| 9 | A coarser pose bucket (30 → 15 Hz) | trade | nothing — sign flips between pairs | **not taken**, knob kept |
| 10 | **Autocast search: flat ordered list + axis reject** (`AutocastScan`) | **exact** | search 6.71 → 4.57 µs (1.47×), scan alone 2×; frame ~1–2% (noise floor) | landed |
| 11 | `upgradeBonuses` cached per (owner, type) (`UpgradeBonusCache`) | **exact** | 1.02× the whole headless step (120 units); below the frame's noise floor | landed |
| 12 | **Fog pass doodad table** (`FogWidgetTable`) — flat arrays, objects opened only on a state change | **exact** | pass 7.1 → 1.2 ms (5.9×); **frame −9%** (69.4 → 63.3 ms) | landed |

**Rows 6, 7, 8 and 12 are the point of this file.** All three are exact, all three were found while
chasing the low-performance frame, and all three help full quality as much as they help the mode —
row 6 is the largest single win of the whole effort and is not a rendering change at all.

## The final comparison — Normal vs Low Performance Mode

Measured on `f42bf10`, Echo Isles, 287 units, the mode flipped back and forth through the REAL
F10 → Options → Video panel three times in one match (so each pair is interleaved and machine
drift cancels). Median frame time, with p90 in brackets:

| Scene | Normal | Low Performance Mode | |
|---|---|---|---|
| Armies FIGHTING, 6× CPU throttle (weak machine) | 85.9 ms · 11.6 fps (p90 ~106) | 64.7 ms · 15.5 fps (p90 ~76) | **1.33×** |
| Army STANDING, 6× throttle (sim frozen — the part the mode touches) | 42.0 ms · 23.8 fps | 26.5 ms · 37.7 fps | **1.58×** |
| Armies FIGHTING, no throttle (the dev box) | 11.0 ms · 91 fps | 4.8 ms · 208 fps | **2.29×** |

The three numbers disagree for a reason, and the reason is the whole of what to do next: **the
mode cuts per-FRAME work and leaves per-SIM-STEP work alone.** The sim ticks at a fixed rate, so
on a fast machine most frames carry no sim step at all and the frame is nearly all animation and
drawing — which the mode more than halves (2.29×). On a throttled one each long frame carries
several sim steps, the sim is the biggest share of it, and the mode's ratio shrinks to 1.33× in a
fight. Freeze the sim and it comes back up to 1.58×. So on the weak machine this is for, **the
ceiling is now the simulation**, and only EXACT sim work (identical results, less work — the
sim must stay deterministic) can raise it.

The p90 moved more than the median in every row — frames got more even as well as faster.

These ratios are Low against TODAY's Normal, which is itself faster than it was: rows 6–8 are
exact and ungated, so Normal got them too (row 6 alone was −26% at full quality).

## Where the frame goes now

Echo Isles, 287 units with both armies fighting, 6× CPU throttle, Low Performance Mode ON.
`sim.overlays` is row 7's; everything else is as of `11fb8de`.

| phase | before the effort | now |
|---|---|---|
| anim | 45.1 ms | 31.8 |
| sim | 54.0 (at 287 units) | 25.9 → ~21 with row 7 |
| render | 11.6 | 9.2 |
| fog | 4.7 | 6.4 |
| (unaccounted) | 12.3 | ~17 (88% of the whole frame is JS — see below) |

Top self-time after row 7, as a share of all CPU:

- animation ≈ 27% — `recalculateTransformation` 7.3, `updateNodes` 7.2, `getValue` 3.3,
  `ow3ComposeObjectNodes` 3.0, `fromRotationTranslationScaleOrigin` 2.7, `slerp`, `multiply4`
- `revealLineOfSight` 4.7% (the fog raycast — `SightStamps` already caches across viewpoints)
- `autocastTarget` 4.6% (the SCAN now, not the legality test under it)
- `fogWidgets` 4.4% (ours — a 10 Hz sweep over every doodad on the map)
- `(program)` 15.5%, and an `(unaccounted)` phase of ~17 ms that has since been SPLIT and holds
  nothing worth chasing — see the list below

## Still on the list

Roughly in value order, with the kind marked, because that is what decides where each one lands:

- ~~A coarser pose bucket (30 → 15 Hz)~~ — **measured, worth nothing** (row 9). Once the SKELETON
  is shared too, a bucket is filled by one instance and replayed by every other, so halving the
  buckets halves a small share and changes nothing about what each instance still does for itself.
  `VideoBridge.poseBucket` keeps it a knob so the question can be re-asked cheaply.
- ~~**`fogWidgets` (4.4–5.8%)**~~ — **done** (row 12), and the cost was not where it looked. The
  pass runs at 10 Hz over every doodad (2,548 on Echo Isles). Timed back to back it cost ~0.3 ms
  (~1.8 ms at 6× throttle); timed IN PLACE during play it cost **7.9 ms** — the same work, four
  times dearer, because between two passes the ~2,500 widgets, their instances, their
  `localLocation`/`vertexColor` arrays and the WeakSet/Set/Map entries each one touched had all
  left the CPU cache. So the fix is a memory layout, not an algorithm: `FogDoodadTable` keeps
  each doodad's origin, fog radius, retired flag and LAST APPLIED fog state in typed arrays, the
  pass reads those and the vision grid, and it opens a doodad's objects only when its state has
  moved. The old pass's self-healing (it read every doodad's colour back, so an effect that took
  the colour over was undone once it let go) is kept by marking instead of reading: the only two
  other writers of a live doodad's colour — the harvest blink and the AoE highlight — add the
  instance to `fogRecheck`, and every hide of a doodad goes with a `removedWidgets.add`, whose
  size (like `doodadActors`', both only grow within a match) re-reads the retired column.
  **Verified** by running the old walk straight after each table pass with every doodad
  `setVertexColor`/`hide`/`show` counted: zero writes across 40 checks in a live fight, 12 across
  harvest blinks and one across a one-frame AoE highlight (the green trees come back to explored
  grey on the table's own pass), with a control — a colour written behind the table's back — that
  the counter does catch. That control is also the invariant's one edge: a NEW writer of a doodad's
  colour must add to `fogRecheck`, or the tint it leaves behind is not undone. Interleaved at 6×:
  pass 7.1 → 1.2 ms median, whole frame 69.4 → 63.3 ms in all four pairs.
  **Harness trap found on the way:** `import("/src/render/mapViewer.ts")` from the page loads a
  SECOND copy of the module in Vite dev (the app's copy carries a version query), so a switch
  flipped on it switches nothing — the first A/B read "no difference" for exactly that reason.
  Import the URL the app actually loaded: `performance.getEntriesByType("resource")`, and prove
  the switch bites with a control before trusting a null result.
- ~~`autocastTarget`~~ — **done as far as it safely goes** (row 10). The profile put `tickAutocast`
  at 7.1% of ALL CPU — ~40% of the whole sim step — because every idle caster with autocast on
  rescans every unit on the map every step. The search now walks a flat copy of the unit Map in
  the Map's OWN order (the order is load-bearing: a friendly buff's ties go to whichever ally the
  scan met first) and rejects on one axis before `Math.hypot`, with a one-unit margin so rounding
  never decides a body on the boundary. `tools/sim-autocast-scan-test.cjs` runs a 108-unit melee
  both ways and demands the identical world for 900 steps — deaths, reinforcements, heals, Inner
  Fire ties, Slow and Abolish Magic all exercised. The search is 1.47× faster (the scan itself
  2×); in the 287-unit fight that is ~1–2% of the frame, at the noise floor, because the search
  was only 7% of it. It scales with casters × units, so it matters more late-game than here.
  **Why it stops there:** the next step is a spatial index (visit the ~12 units in reach, not all
  287), and it is not safe as things stand — units MOVE during the order loop that runs the
  search (a Blink resolving inside `tickCast`, a worker leaving a mine, an unload), so an index
  built once a step can miss a body that arrived since. It needs every teleport site to report
  itself first; see "the sim's structural options" below.
- ~~The `unaccounted` ~17 ms~~ — **split, and there is no monster in it.** Chrome's own counters
  over 176 frames at 6× throttle: frame 86.1 ms, of which **ScriptDuration 75.8 ms (88%)**,
  RecalcStyleDuration 2.65, LayoutDuration 1.89 — one layout and two style recalcs per frame,
  which is the healthy once-per-frame pipeline rather than a forced one, across 3,606 DOM nodes.
  So the DOM HUD is not the cost, GC is not the cost, and the GPU is not the cost: the frame is
  JavaScript, and the unaccounted part of it is small uninstrumented JS plus the browser's normal
  ~4.5 ms. **Keep optimising the named phases.** (Worth re-running after any change that adds DOM
  per unit — `Performance.getMetrics` is the tool, see the scratch `split` harness.)
- **BLP decode off the main thread** (`decodeScan` ~1%, plus the hitch it causes). *Exact.*
- **The fog overlay and baked shadow layer taking terrain-cull's runs** — named in
  `docs/terrain-culling.md` and still not done. *Exact.*

## The sim's structural options

After rows 6 and 10 the simulation has no single big item left: its cost is spread over the
per-unit order loop (`sim.world.units` ~10.8 ms of a ~19 ms sim in the 287-unit fight),
`recomputeStats` (2.9% of CPU), the fog reveal (~3% across `revealLineOfSight`/`stateAt`/`reveal`)
and many 1% items. Going further means STRUCTURAL changes, each exact but each needing an
invariant the code does not yet keep:

- **A per-step spatial index for unit searches** (autocast, and the acquisition scans that already
  use `distSkip`) — **measured before building, and not worth its invariant on today's scenes.**
  After row 10 the whole autocast search is 4.4% of CPU inclusive and 2.3% self in the 287-unit
  scene, and part of the inclusive share is `targetError` on bodies that ARE in reach, which no
  index removes. Counted live over 25 s: 35 autocasters, each search in reach of **34** of the
  287 units, and a 128-unit grid would still hand it **56** (the look radius is 600–800, so a
  query covers a dozen cells a side). So the index cuts each scan about 5×, and the most it could
  take off is most of the 2.3% self time — ~1.5–2% of CPU. Against that, it needs every mid-step
  position write to report itself, and there are **67** such writes across eight modules
  (`sim/world.ts` 35, the JASS natives a trigger can fire in the middle of a step, the snapshot
  appliers, rts, the AIs); one missed or future site silently hides a body from a search for the
  rest of that step. That is a deterministic difference, not a desync — every peer runs the same
  code — but it is a different game from today's, which is the bar every other row here cleared.
  **When to revisit:** a scene with many more units spread over the map (a late 12-player game),
  where the in-reach count stays small while the unit count grows. Build the invariant first
  (one `moveUnit` everything goes through), and prove it with the both-ways test row 10 uses.
- **Incremental `recomputeStats`** — skip a unit whose inputs did not change. It runs for every
  unit every step and rebuilds armour, speed, damage and regen from buffs, items and upgrades.
  Needs: a change signal from every input — buffs (including the ones that fade by themselves on a
  timer), auras, items, upgrades, level. One missed input puts a wrong stat on the field silently,
  so it wants the same both-ways step-for-step test as row 10 before it lands.
- ~~**`upgradeBonuses` cached per (owner, type)**~~ — **done** (row 11). Research levels change
  only through `TechState.setResearchLevel` (the snapshot applier included) and `reset`, so
  `TechState.researchVersion`, bumped by both, is a complete invalidation; the unit def is kept
  beside each entry so a registry that handed back a different row misses instead of serving a
  stale sum. The result is SHARED, so it is read-only — `recomputeStats`, its one caller, only
  reads it. `tools/sim-upgrade-cache-test.cjs` runs a 120-unit fight both ways for 600 steps
  through research on both sides, a level written back DOWN, a unit changing type and a unit
  changing hands, and demands identical stats every step. Worth ~2% of the headless step, as
  estimated — it was never going to be more. It was done because it was safe, not because it was
  big: the real payoff in this area is the incremental `recomputeStats` above, and this cache is a
  piece of that one's input signal for free.

## What a later full-quality pass should do with this

Start from the "kind" column, not from the frame budget:

- Everything marked **exact** should be evaluated for full quality on its own merits. Rows 6 and 7
  already are on — they were never gated.
- Everything marked **trade** is gated on `VideoBridge.sharedPoses` and stays there unless the
  developer looks at a side-by-side and decides 30 Hz stepping is acceptable everywhere. The
  honest way to ask that question is a paired screenshot of a hero-scale model mid-attack, not a
  frame-time number.
- **Row 5 is the warning.** It was exact, it was obviously right on paper, and it bought nothing —
  because the estimate behind it (8–12%, read off a profile) had mis-attributed which nodes those
  samples belonged to. Measure interleaved before believing any of the numbers above about a
  change that has not landed yet.
