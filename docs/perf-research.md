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

**Rows 6, 7 and 8 are the point of this file.** All three are exact, all three were found while
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
- **`fogWidgets` (4.4%).** *Exact.* A 10 Hz sweep over every doodad the map laid down (4,345 on
  Extreme Candy War), each one doing two Map lookups and a vision query to learn a state that
  almost never changes. Candidates: hoist the per-widget constants out of the pass, or key the
  vision query by CELL so a treeline asks once.
- **`autocastTarget` (4.6%).** *Exact.* Now that the legality test is cheap, what is left is the
  scan itself — every autocaster against every candidate. The sim already has a collision grid;
  this is the O(n²) shape `docs/perf-logging.md` has a lesson about.
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
