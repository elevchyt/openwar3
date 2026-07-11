# Triggers / JASS — implementation progress tracker

> **This is the living progress doc for the trigger system (issue #33).** Warcraft III drives all in-map
> interaction and logic — floating text, quests, spawns, cinematics, custom game modes (WarChasers, DotA, TD) —
> through a scripting system. This file tracks **what we've built, how it works, and how each piece is verified**,
> and MUST be updated whenever we touch the trigger engine. Before starting a new trigger task, read this file to
> see what already exists and re-run the checks so we know it still works.
>
> The architecture/plan lives in [`phase7-triggers-jass-plan.md`](phase7-triggers-jass-plan.md); this file is the
> status + how-to-verify companion.

## TL;DR — current status

| Milestone | What | Status | How it's checked |
|---|---|---|---|
| 7.0 | JASS lexer + parser | ✅ done | parses `common.j` + `blizzard.j` + **all 165** bundled `war3map.j`, 0 errors |
| 7.1 | Interpreter core + `config()` | ✅ done | config() players/start-locations == `war3map.w3i` (oracle) |
| 7.2 | `CreateUnit` + world bring-up | ✅ done (headless) | `CreateAllUnits()` count == `war3mapUnits.doo` (PlunderIsle 82==82) |
| — | **Vision on custom maps** (issue #33 bug) | ✅ done (live) | pre-placed player units seeded owned → fog lifts (screenshots) |
| 7.4a | Event runtime core (ECA firing, event responses, **timers**) | ✅ done (headless) | periodic timer fires its trigger 3×; one-shot once; `GetExpiredTimer` correct |
| 7.2b | live `CreateUnit` → new sim units (replace .doo adoption) | ⬜ next | — |
| 7.4b | pump sim events (enter-region, unit-death) live from `rts.tick` | ⬜ next | a scripted trigger fires in-game |
| 7.3 | Melee from the script (retire hard-coded roster) | ⬜ todo | melee-via-script == `startMelee` |
| 7.5 | Native breadth + Lua/Reforged | ⬜ ongoing | `pnpm jass:coverage` |

Run the checks any time: **`pnpm jass:test`** (7.0–7.2 oracles) and **`pnpm jass:coverage`** (unimplemented natives by usage).

---

## How WC3 runs a map (the model we implement)

A `.w3x`/`.w3m` map file is a renamed **MPQ archive**. The World Editor compiles every trigger — whether authored
in the GUI or hand-written JASS — into **one script the engine actually runs**:

- **`war3map.j`** — JASS (our target, 1.27a). *(`war3map.lua` on Reforged — deferred.)*
- The GUI files `war3map.wtg` (trigger tree) and `war3map.wct` (custom text) are **editor-only** — the game never
  reads them. So "run a map's triggers" = run the compiled `war3map.j`.

The script is layered on two Blizzard libraries shipped in the game MPQs (read from the user's own install, never
vendored — see the legal boundary in `CLAUDE.md`):

- **`Scripts\common.j`** — 1160 **native** declarations + 91 handle **types** + constants. Natives are the engine
  primitives (`CreateUnit`, `SetPlayerColor`, …) we implement in JS.
- **`Scripts\blizzard.j`** — 923 JASS **functions** built on the natives (the `…BJ` helpers + the `Melee*` library).
  We *interpret* these — we don't reimplement them.

The engine calls two entry points, then pumps events:

```
config()   // SetPlayers/SetTeams/DefineStartLocation/InitCustomPlayerSlots — player + map setup
main()
  SetCameraBounds / SetDayNightModels / sound  (we no-op — the renderer owns these)
  CreateAllUnits()             // CreateUnit(...) per pre-placed unit (mirrors war3mapUnits.doo)
  InitBlizzard() / InitGlobals() / InitCustomTriggers() / RunInitializationTriggers()
// then: registered triggers fire on unit/player/region/timer events (milestone 7.4)
```

---

## Architecture — `src/jass/`

A clean, self-contained interpreter with a thin bridge to our engine. **The interpreter never imports the renderer
or vfs** (bridge, not fork) — so it's testable headlessly and stays engine-agnostic.

| File | Role |
|---|---|
| `lexer.ts` | JASS tokens: keywords, idents, int/real/string literals, `'fourcc'` rawcodes (`rawcodeToInt`/`intToRawcode`), operators, significant newlines |
| `ast.ts` | node types (globals, native/function decls, set/call/if/loop/exitwhen/return, expressions) |
| `parser.ts` | recursive-descent → `JassProgram`. Precedence: `or` < `and` < comparisons < `+ -` < `* /` < unary |
| `values.ts` | value model — **int and real are separate kinds** (JASS `int/int` truncates!); handles, code refs, null; `defaultForType` |
| `runtime.ts` | handle table (interned player/enum handles), `MapSetup`, globals/arrays, function+native registries, seeded RNG, `EngineHooks` bridge |
| `interpreter.ts` | tree-walker: call frames, `and`/`or` **do not short-circuit** (JASS gotcha), type-directed arithmetic, safe defaults, loop/recursion caps |
| `natives/config.ts` | `config()` + player-setup natives → `MapSetup` |
| `natives/world.ts` | `CreateUnit` (+ bridge), resource/state setters, **floating text** (`CreateTextTag`…), `DisplayText…` |
| `natives/events.ts` | triggers (`CreateTrigger`/`TriggerAddAction`/`ConditionalTriggerExecute`), boolexprs, event **registration** + **response** readers, **timers** (7.4) |
| `natives/index.ts` | registry: enum constructors (`Convert*`) + utility natives (`I2S`, `GetRandomInt`, camera/env no-ops); calls the group registrars |
| `headless.ts` | engine-free entry: `buildInterpreter(sources)` for tests/tooling |
| `index.ts` | **app-facing** loader: reads `common.j`/`blizzard.j`/`war3map.j` via the VFS, runs `config()` |

**Never hard-crash the map.** An unimplemented native falls back to a typed default from its `common.j` return type;
a missing function/variable logs once and returns null; runaway loops/recursion are capped. This is why a map that
uses natives we haven't written yet still runs as far as it can.

---

## The issue #33 vision bug — fixed

**Symptom:** on non-melee (custom) maps the whole map was fogged — you couldn't even see your own units.

**Cause:** `startCustom` seeded **no owned units** into the sim, and `updateVision` only reveals around the local
team's units — so nothing lifted the fog. The map's pre-placed player units rendered (the viewer draws
`war3mapUnits.doo`) but were neither owned nor simulated.

**Fix (`src/render/mapViewer.ts` `startCustom` + `src/game/rts.ts`):** adopt each pre-placed **player** unit
(owner 0–11) as an **owned, simulated** unit — reusing the viewer's already-rendered `.doo` instance (the same
instance-adoption `trySeed` does for creeps, so no double render). Teams come from `teamOf(owner)`, so the local
player's units share the local team and lift the fog; other slots' units exist too (world stays alive) but stay
fogged like any other player's. A seeding **gate** (`enableSeeding`) makes `trySeed` wait until start setup has
configured owners/teams, so no unit is adopted with stale data.

Verified live on WarChasers (`?dev` + agent-browser): local player owns its selector wisp, fog is lit around it and
black beyond; `config()` ran on the real script (5 players, 5 start locations); 278 player units seeded owned. Melee
(Echo Isles) unchanged: town hall + 5 workers + 91 creeps, fog correct.

> The live `startCustom` also runs the map's `config()` through the interpreter (read-only for now) — the first live
> use of the trigger engine on a real script, and the seam for running `main()`/triggers in 7.2b+.

### Custom-vs-melee behaviour — known differences

Because custom-map units are **adopted** (we reuse the viewer's pre-rendered `war3mapUnits.doo` widget) rather than
freshly spawned like the melee roster, a few behaviours differ. Watch for these when a custom map misbehaves:

- **Walk/attack animations must drive the SAME widget object.** The adopted instance is still a mdx-m3-viewer
  `Widget` in `map.units`, so the viewer's `Widget.update()` auto-plays a *Stand* clip every frame unless we set
  `state = WidgetState.WALK` on **that widget object**. `RtsController.addUnit` builds a *fresh* `{instance, state}`
  wrapper for its entry (correct for melee units, whose instances aren't viewer widgets), so `seedPlayerUnit` must
  re-point `entry.unit` at the original `map.units` widget — else state writes miss and adopted units freeze in
  Stand (walk never loops). **Fixed** (`rts.ts seedPlayerUnit`); this is exactly how the creep seed already worked.
- **`.doo` per-unit HP fraction / mana / hero level are not applied** — adopted units seed at full HP / default mana
  / `def.level` (not the editor's placed values). Minor; refine when it matters.
- **Adopted buildings don't get footprint seating** (`setBuildingFootprint`), so an owned pre-placed building on a
  slope keeps its `.doo` Z (may clip). Minor.
- **No starting resources / no scripted AI** — custom maps grant gold/lumber and drive unit behaviour from their
  triggers, which we don't run yet (7.4). So a custom map starts at 0/0 and its units act as generic auto-acquiring
  melee units, not their scripted selves. Expected until the event runtime lands.

---

## Verifying (do this after any trigger change)

- **`pnpm jass:test`** — compiles the pure interpreter (`tools/tsconfig.jass.json` → CJS in `.jass-build/`) and runs
  `tools/jass-corpus-test.cjs`:
  - **7.0** every `war3map.j` (+ common.j/blizzard.j) parses with zero errors — permanent regression gate.
  - **7.1** `config()` start-locations == `war3map.w3i` on PlunderIsle (2) and WarChasers (5).
  - **7.2** `CreateAllUnits()` count == `war3mapUnits.doo` (PlunderIsle 82==82; WarChasers ~321 vs 334, diff = units
    the map spawns from triggers / non-unit `.doo` entries — expected until 7.4).
- **`pnpm jass:coverage`** — `tools/native-coverage.mjs`: of common.j's 1160 natives, **335 are used** across the 165
  bundled maps; prints them ranked by #maps, with a `✓` for the ones we've implemented. Pick the next batch from the
  top of the unimplemented list.
- **Live** (custom-map behaviour): drive the app per the `live-browser-testing` workflow (temp `?dev=` auto-mount +
  `agent-browser`), load a scenario map, confirm your own units are visible and fog behaves.

Reads only the developer's own local install (`Warcraft III/` is gitignored; we ship zero Blizzard assets).

---

## Sources

- **The real MPQs** — `Scripts\common.j` / `Scripts\blizzard.j` are the authority for exact native signatures and BJ
  behaviour. Always verify against them (`CLAUDE.md` prime directive).
- **[world-editor-tutorials.thehelper.net](https://world-editor-tutorials.thehelper.net/triggers.php)** — the most
  complete catalogue of how GUI triggers behave (events/conditions/actions), the reference the issue points at for
  interpreting trigger semantics (floating text, regions, etc.). Indexed in [`REFERENCES.md`](REFERENCES.md).
- **[W3X file format spec](https://867380699.github.io/blog/2019/05/09/W3X_Files_Format)** — the binary layout of the
  files inside a map archive (`war3map.j`/`.wtg`/`.wct`/`.w3i`/`war3mapUnits.doo`).
- **Warsmash** (open-source Java WC3 engine) — study its JASS handling for *behaviour*, never lift its GPL code.
- **[JASS scripting references](REFERENCES.md#jass-scripting-references)** — the JASS Manual BNF (grammar) + Jassbot
  (native lookup).

## The event runtime (7.4a — done, headless)

WC3 triggers are **Event-Condition-Action**: a script `CreateTrigger`s, registers it on an event
(`TriggerRegister*Event`), and adds conditions/actions; when the event fires the engine sets thread-local **event
responses** (`GetTriggerUnit`, `GetEnteringUnit`, `GetExpiredTimer`, …) the actions read. Built:

- **`src/jass/natives/events.ts`** — trigger objects, `Condition`/`Filter`/`And`/`Or`/`Not`, the event **registration**
  natives (recorded into `runtime.triggerRegs`, tagged by an internal `kind`), the event **response** readers, and
  **timers** (`CreateTimer`/`TimerStart`/`PauseTimer`/`GetExpiredTimer`/…).
- **`src/jass/interpreter.ts`** — the **firing** engine: `fireTrigger(trig, responses)` (push responses → eval
  conditions → run actions → pop), `advanceTime(dt)` (pump timers → run handler code + fire `timerExpire` triggers,
  periodic re-arm), and a general `fireEvent(kind, responses, matcher)` the sim bridge will call for
  enter-region / unit-death / … Registration lives in natives, firing on the interpreter (it needs the eval loop).

Verified (`pnpm jass:test` §7.4): a periodic 1s timer fires its trigger exactly 3× over 3.5s with the correct
`GetExpiredTimer`, and a one-shot timer fires exactly once regardless of elapsed time.

## What's NOT done yet (next tasks — keep this list honest)

- **7.4b** wire the live pump: run the map's `InitCustomTriggers`/`RunInitializationTriggers` in-game and pump
  `advanceTime` + `fireEvent` (enter-region, unit-death) from `rts.tick`, so real map triggers fire live. Blocked on
  7.2b because running `main()` live also runs `CreateAllUnits`/`CreateRegions` — must reconcile with the current
  `.doo` adoption first (else duplicate units / null `gg_rct_*` regions).
- **7.2b** route live unit creation through `CreateUnit` (currently the vision fix adopts `.doo` instances; the
  interpreter's `CreateUnit` runs headless only).
- **7.3** run melee from `blizzard.j`'s `Melee*` library and retire the hard-coded `startMelee` roster.
- **Natives on demand** — regions/groups/forces, weather, sound, cameras, cinematics, multiboard, gamecache. Use
  `pnpm jass:coverage` to prioritise.
- **Lua** (`war3map.lua`, Reforged 1.31+) — only when we target that version.
