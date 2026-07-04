# Phase 7 — Triggers / JASS execution plan

**Goal:** run a Warcraft III map's own compiled script so the engine sets a map up the way the real game does —
instead of our hard-coded melee roster. This is the "understand and translate the triggers" work; melee/custom
*classification* (Phase 6.5) is already done — see [`wc3-data-formats.md`](wc3-data-formats.md) and
`src/world/mapKind.ts`/`triggers.ts`.

Two north stars, in order:

1. **Custom / scenario maps become playable** — their starting units, heroes, resources, regions, and rules come
   from `war3map.j`; today `mapViewer.startCustom` skips melee init and just renders. Running the script is what
   makes Warchasers etc. actually *play*.
2. **Melee maps run from their own triggers** — a melee `war3map.j` calls the standard `Melee*` library, which is the
   authentic source of "town hall + 5 workers + starting gold". Reaching parity with our current hard-coded
   `startMelee` via the script proves the interpreter, then we delete the hard-coded roster.

> **Prime directive still applies** (see `CLAUDE.md`): match the original; consult sources; cite inline. And the
> **legal boundary**: study Warsmash's JASS interpreter for *behaviour*, never lift its (GPL) code. Ship zero
> Blizzard code — `common.j`/`blizzard.j` are read from the **user's own** MPQs at runtime, never vendored.

---

## How WC3 actually runs a map (verified against the 1.27a MPQs)

A map's triggers — GUI or hand-written — are compiled by the World Editor into **one script the engine runs**:
`war3map.j` (JASS; `war3map.lua` on Reforged). The GUI files `war3map.wtg`/`.wct` are editor-only and never run.
The script is layered on two Blizzard libraries shipped in the game MPQs (patch wins), both **confirmed present**:

| File | Location (War3Patch.mpq → War3.mpq) | What it is | Measured |
|---|---|---|---|
| `common.j`   | `Scripts\common.j`   | **native** declarations + handle **types** + constants | 1160 natives, 91 types |
| `blizzard.j` | `Scripts\blizzard.j` | JASS **library** built on the natives (the `...BJ` funcs + the `Melee*` library) | 923 functions |
| `war3map.j`  | inside each map        | the map's own `config()` + `main()` + its triggers | — |

**Type hierarchy** (from `common.j`, root → leaf): `handle → agent → widget → unit` (also `destructable`, `item`);
`agent` also roots `player`, `group`, `force`, `trigger`, `timer`, `location`, `region`, `rect`, `effect`, `sound`,
`ability`, `boolexpr` (→ `conditionfunc`/`filterfunc`), `unitpool`, `hashtable`, … Most `...type`/`...state`/event
ids are plain `handle` enums. Handles are opaque — model them as integer ids into a runtime **handle table**.

**The engine's call sequence** (every map, verified on PlunderIsle):

```
config()   // SetMapName/Description, SetPlayers, SetTeams, SetGamePlacement,
           // DefineStartLocation(i,x,y), InitCustomPlayerSlots, SetPlayer*(...)
main()
  SetCameraBounds(...) / SetDayNightModels(...) / NewSoundEnvironment / SetAmbient*Sound / SetMapMusic
  CreateAllUnits()             // CreateUnit(...) for every pre-placed unit (mirrors war3mapUnits.doo)
  InitBlizzard()               // library bootstrap
  InitGlobals()                // map's global variables
  InitCustomTriggers()         // CreateTrigger + TriggerRegister*Event + TriggerAddCondition/Action
  RunInitializationTriggers()  // fire "map initialization" triggers (melee: the Melee* library)
```

Then the engine **pumps events**: registered triggers fire on unit/player/region/timer events; each firing sets
thread-local **event responses** (`GetTriggerUnit`, `GetTriggeringTrigger`, `GetChangingUnit`, …) that actions read.

---

## What real maps actually use (scan of all 161 bundled maps' `war3map.j`)

Only **335 of the 1160 natives** appear across the whole corpus — implement on demand, most-used first. Top natives
by number of maps using them (these bundled maps skew melee, so the config/melee-bootstrap set dominates; the
trigger/event core is right behind it):

- **Map config** (`config()`): `Player`, `SetPlayers`, `SetTeams`, `SetGamePlacement`, `DefineStartLocation`,
  `SetPlayerStartLocation`, `SetStartLocPrio(Count)`, `ConvertPlayerColor`, `SetPlayerColor`,
  `SetPlayerRacePreference`, `SetPlayerRaceSelectable`, `SetPlayerController`, `SetPlayerTeam`. *(All verifiable
  against `war3map.w3i`, which we already parse — a free correctness oracle.)*
- **Camera / environment** (`main()`): `SetCameraBounds`, `GetCameraMargin`, `SetDayNightModels`,
  `NewSoundEnvironment`, `SetMapMusic` (+ BJ `SetAmbientDaySound`/`SetAmbientNightSound`).
- **World bring-up** (`CreateAllUnits()`): `CreateUnit` (161/161 maps, ~25k calls), `SetUnitColor`,
  `SetUnitAcquireRange`, `SetResourceAmount` (gold mines), `SetUnitState`, `IsUnitHidden`, `ChooseRandomItemEx`,
  `UnitDropItem` (+ BJ `RandomDistReset/AddItem/Choose`).
- **Trigger/event core** (`InitCustomTriggers()` + runtime): `CreateTrigger`, `TriggerAddAction`,
  `TriggerAddCondition`, `TriggerRegisterUnitEvent`, `DestroyTrigger`, `GetTriggerUnit`, `GetTriggeringTrigger`,
  `GetChangingUnit(PrevOwner)` (+ BJ `ConditionalTriggerExecute`).
- **Melee library** (`blizzard.j`, used by ~150/161): `MeleeStartingVisibility`, `MeleeStartingHeroLimit`,
  `MeleeGrantHeroItems`, `MeleeStartingResources`, `MeleeClearExcessUnits`, `MeleeStartingUnits`, `MeleeStartingAI`,
  `MeleeInitVictoryDefeat` — each built on the natives above.
- **Custom-map extras** (fewer maps, but needed for scenarios): `Rect`/`GetRectCenter` (regions), groups/forces,
  `IssueImmediateOrder`, weather (`AddWeatherEffect`/`EnableWeatherEffect`), sound (`CreateSound`, …).

> **Deliverable 0 — a native-coverage tool.** Turn the throwaway scan into `scripts/native-coverage.cjs`: parse
> `common.j` for natives, scan a map pool's `war3map.j`, and print *unimplemented* natives ranked by usage. Re-run
> it after each milestone to pick the next batch. (Prototype exists in the session scratchpad.)

---

## Architecture — a new `src/jass/`

Keep it a clean, self-contained interpreter with a thin bridge to our sim (so the sim stays engine-agnostic).

```
src/jass/
  lexer.ts        // JASS tokens: keywords, idents, int/real/string/rawcode ('hfoo') literals, operators, newlines
  parser.ts       // → AST: globals, native decls, functions, locals, set/call/if/loop/exitwhen/return, exprs
  ast.ts          // node types
  interpreter.ts  // tree-walking eval: call stack, locals, globals, arrays, short-circuit and/or, type coercion
  values.ts       // JASS value model: integer|real|string|boolean|handle(id)|code(fnref); handle table
  natives/        // native name → JS impl, grouped by subsystem (config, unit, trigger, camera, sound, region…)
    index.ts      // registry; unimplemented native = log-once + safe default (never hard-crash the map)
  runtime.ts      // GameContext: players, handle table, trigger/event registry, event-response (thread-local) stack
  bridge.ts       // GameContext ↔ our engine: SimWorld/RtsController/MapViewerScene ops (create unit, set gold…)
  index.ts        // loadAndRun(mpq, engineHooks): read common.j+blizzard.j+war3map.j, parse, run config()+main()
```

**Language surface** (the whole JASS grammar — small): `globals…endglobals`, `native`/`function…endfunction`,
`local`, `set`, `call`, `return`, `if/elseif/else/endif`, `loop/exitwhen/endloop`, arrays (`array`), `constant`,
operators (`+ - * / ==  != > >= < <=`, `and or not`, string `+`), rawcode literals (`'hfoo'` → int), `null`, `true`,
`false`, function references as `code`/`boolexpr` (`Condition(function Foo)`, `Filter(...)`). No closures, no classes.

**Event/dispatch model:** `TriggerRegister*Event` records `(eventType, params) → trigger` in `runtime`. The sim
raises engine events (unit dies/enters region/order issued/timer expires) → `runtime` finds matching triggers, pushes
the event responses, evaluates conditions (boolexpr), runs actions. Pump from the existing sim tick (`rts.tick`), so
triggers stay in lockstep with simulation (important for future server-authoritative multiplayer — determinism).

**Bridge, not fork:** natives call small operations on an injected hooks object — `createUnit(typeId, player, x, y,
face)`, `setPlayerGold(p, n)`, `setResourceAmount(unit, n)`, `issueOrder(unit, order, target)`, … implemented over
`SimWorld`/`RtsController`/`MapViewerScene`. The interpreter never imports the renderer directly.

---

## Milestones (each with a concrete exit check)

**7.0 — Lexer + parser.** Tokenize/parse JASS to an AST.
*Exit:* parse `common.j`, `blizzard.j`, and **all 161** bundled `war3map.j` with zero errors (a headless corpus test).

**7.1 — Interpreter core + `config()`.** Globals/locals/functions/expressions/control-flow; implement the config
natives as recorders into a `MapSetup`.
*Exit:* running `config()` reproduces the map's players, teams, and start locations — asserted **equal to what
`parseMapInfo` reads from `war3map.w3i`** (e.g. PlunderIsle → 2 players, 2 start locations at the known coords).

**7.2 — World bring-up natives → sim.** Implement `CreateUnit`, `SetResourceAmount`, `SetUnitAcquireRange`,
`SetUnitColor`, `SetUnitState`, player-state, over the bridge. Run `main()` → `CreateAllUnits()`.
*Exit:* a custom map's pre-placed units become **live, selectable sim units** created by the script (cross-check
count/positions against our existing `war3mapUnits.doo` parse — they should match).

**7.3 — Melee from triggers (parity gate).** Load `blizzard.j`; run a melee map's `main()` →
`RunInitializationTriggers()` → the `Melee*` library, spawning the town hall + workers + starting gold/lumber.
Feature-flag it beside the hard-coded `startMelee`.
*Exit:* PlunderIsle started via the script yields the **same** starting units/resources as today's `startMelee`.
Then retire the hard-coded roster.

**7.4 — Trigger/event runtime.** `CreateTrigger`/`TriggerRegister*Event`/conditions/actions/event-responses/timers,
pumped from the sim tick.
*Exit:* a scripted custom-map trigger fires end-to-end in-game (e.g. "unit enters region → create unit" or a victory
condition), verified in the browser.

**7.5 — Breadth + Lua (deferred).** Grow native coverage using the coverage tool, map-by-map. Add a `war3map.lua`
path (Reforged) only when we target 1.31+. Advanced natives (multiboard, gamecache, cinematics, dialogs) as maps
demand them.

---

## Integration with existing code

- `src/render/mapViewer.ts` — `startCustom` becomes "load + run the map script" (Phase 7.2+). `startMelee` keeps its
  hard-coded roster until 7.3's parity gate, then delegates to the script behind the feature flag.
- `src/main.ts` — the `info.isMelee` branch is already the right seam; both paths converge on "run the script" once
  7.3 lands.
- `src/sim/` — add the small operations the bridge needs (create/kill/order/owner/resource); raise the engine events
  the trigger runtime subscribes to. Keep the sim ignorant of JASS.
- `src/world/triggers.ts` — already reads the compiled script; extend it (or `src/jass/index.ts`) to also fetch
  `common.j`/`blizzard.j` from the mounted install via the VFS.

## Testing

- **Parse corpus:** every bundled `war3map.j` + `common.j` + `blizzard.j` parse clean (7.0, permanent regression).
- **Native coverage tool:** ranks unimplemented natives by usage; gates "are we ready for map X?".
- **Oracles:** `config()` vs `war3map.w3i`; `CreateAllUnits()` vs `war3mapUnits.doo`; melee-via-script vs `startMelee`.
- **Headless interpreter unit tests** per native group; **in-browser** confirmation for anything with a visible/timed
  effect (events, victory, cinematics).

## Risks / non-goals

- **Native surface is large (1160)** — but only 335 are used and a few dozen unlock melee + basic custom maps.
  Implement lazily; never hard-crash on an unimplemented native (log-once + safe default).
- **Performance:** a tree-walking interpreter is fine for trigger volumes (events are sparse); optimise only if a
  hot custom map proves otherwise.
- **Determinism:** run triggers from the fixed sim tick and use our seeded RNG for JASS `GetRandomInt/Real` — needed
  for future server-authoritative multiplayer.
- **Not now:** Lua/Reforged, AI scripts (`common.ai`/`.ai`), the World Editor's own object-editor overrides beyond
  what we already load, and any Blizzard-code reuse (behaviour only, per `CLAUDE.md`).

## Recommended order

1. `scripts/native-coverage.cjs` (Deliverable 0). 2. Lexer+parser → corpus parses (7.0). 3. Interpreter + `config()`
oracle (7.1). 4. `CreateUnit` bridge → custom units live (7.2). 5. `blizzard.j` + melee parity, retire hard-coded
roster (7.3). 6. Event runtime + one real custom trigger (7.4). 7. Grow coverage on demand (7.5).
