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
| 7.6 | **Text logic + text actions** (messages, floating text, forces, strings, `.wts`) | ✅ done (live) | full BJ text path end-to-end (§7.5); WarChasers welcome/HINT text in the HUD (screenshots) |
| — | **`main()` runs live** (display-only hooks) | ✅ done (live) | custom-map init triggers fire; 296 trigger regs on WarChasers; no duplicate units |
| 7.4b | **Live event pump** (enter/leave-**region** + **timers** from `rts.tick`) | ✅ done (live) | §7.6 headless (enter 2×, leave 1×, `GetEnteringUnit` live pos); WarChasers wisp entering the Archer region fires its trigger (screenshots) |
| 7.2b | live `CreateUnit`/`RemoveUnit`/`KillUnit` → real sim+render units | ✅ done (live, base units) | trigger-spawned footmen + Paladin hero render live; wisp `RemoveUnit`'d on region enter (screenshots) |
| 7.2c | **Custom object data** (`war3map.w3u`) → custom **unit** types | ✅ done (live) | §7.7 headless (EC12 → Shandris model, wts name); WarChasers Archer pedestal spawns its custom hero (screenshots) |
| 7.2d | **Custom ability data** (`war3map.w3a`, level-indexed) | ✅ done (live) | §7.8 headless (A000 inherits base `code`, area 425, DataA via meta); resolves live in-browser |
| 7.2e | **Custom item data** (`war3map.w3t`) | ✅ done (live) | §7.9 headless (I000 "Kael's Will" → Artifact, ability AIda, usable); resolves live in-browser |
| — | Custom destructable/upgrade/buff data (`.w3b`/`.w3q`/`.w3h`) | ⬜ optional | lower-priority — only maps using them need it |
| 7.4c | pump remaining sim events (unit-death, damage, orders) live | ⬜ next | a death/attack-triggered action fires in-game |
| 7.3 | Melee from the script (retire hard-coded roster) | ⬜ todo | melee-via-script == `startMelee` |
| 7.5 | Native breadth + Lua/Reforged | ⬜ ongoing | `pnpm jass:coverage` (125/335 used natives implemented) |

Run the checks any time: **`pnpm jass:test`** (7.0–7.2 oracles + 7.4 timers + 7.5 text + 7.6 regions + 7.7/7.8/7.9 unit/ability/item object data) and **`pnpm jass:coverage`** (unimplemented natives by usage).

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
config()   // SetPlayers/SetTeams/DefineStartLocation/InitCustomPlayerSlots — player + map setup      [runs live]
main()                                                                                                 [runs live, 7.6]
  SetCameraBounds / SetDayNightModels / sound  (we no-op — the renderer owns these)
  CreateAllUnits()             // records rows only (scriptSpawnLive=false during init, so no dup of the .doo units)
  InitBlizzard() / InitGlobals() / InitCustomTriggers() / RunInitializationTriggers()  // init triggers fire → text!
// then: rts.tick pumps the runtime → timer + enter/leave-region triggers fire live (7.4b); death/damage/orders pending
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
| `natives/world.ts` | `CreateUnit` (+ bridge), resource/state setters, unit queries |
| `natives/events.ts` | triggers (`CreateTrigger`/`TriggerAddAction`/`ConditionalTriggerExecute`), boolexprs, event **registration** + **response** readers, **timers** (7.4) |
| `natives/forces.ts` | **forces** (player groups): `CreateForce`/`ForceAddPlayer`/`IsPlayerInForce`/`ForForce`/`ForceEnum*` + `GetEnumPlayer`/`GetFilterPlayer` — the target of the "Text Message" actions (7.6) |
| `natives/region.ts` | **rects / regions / locations**: `Rect`(+ `gg_rct_*`), `GetRect*`, `CreateRegion`/`RegionAddRect`, `Location`/`GetLocationX/Y` — the geometry the enter/leave-region pump tests against (7.4b) |
| `natives/text.ts` | **text actions + logic** (7.6): on-screen messages (`DisplayText…`/`ClearTextMessages`), **floating text** (`CreateTextTag`…), names (`GetPlayerName`/`GetUnitName`/`GetObjectName`), `StringHash`, localization |
| `wts.ts` | `parseWts` — the map's `war3map.wts` trigger-string table (resolves `TRIGSTR_nnn` placeholders to authored text) |
| `natives/index.ts` | registry: enum constructors (`Convert*`) + utility natives (`I2S`, `GetRandomInt`, camera/env no-ops); calls the group registrars |
| `headless.ts` | engine-free entry: `buildInterpreter(sources, { wts })` for tests/tooling |
| `index.ts` | **app-facing** loader: reads `common.j`/`blizzard.j`/`war3map.j`/`war3map.wts` via the VFS, runs `config()` (+ `main()` with display hooks) |

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

> The live `startCustom` runs the map's `config()` **and `main()`** through the interpreter (`runMapScript`, with
> display-only hooks) — see 7.6 below. That fires the map's init triggers, so its welcome text now shows in the HUD.

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
- **Init triggers run, but nothing pumps mid-game events yet.** `main()` now runs live with **display-only hooks**
  (see 7.6 below), so a custom map's "Map Initialization" triggers fire — welcome/quest **text appears**, triggers
  register, `bj_FORCE_*` populate. But we don't yet pump `advanceTime`/`fireEvent` from `rts.tick` (7.4b), so timed
  and unit-event triggers don't fire, and resource-granting natives (`SetPlayerState`, …) are still no-ops — so a
  custom map still starts at 0/0 and its units act as generic auto-acquiring melee units, not their scripted selves.

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

## Text logic + text actions (7.6 — done, live)

The GUI's **"Text Message"** and **"Floating Text"** actions plus the **string functions** they build messages from.
This is the first trigger subsystem wired all the way to the screen — the map's own init triggers now put text in
the HUD. Built:

- **`src/jass/natives/text.ts`** — the two "text" families:
  - **Text actions:** on-screen messages (`DisplayTextToPlayer`/`DisplayTimedTextToPlayer`/`ClearTextMessages`) via
    the `displayText`/`clearText` engine hooks; **floating text** (`CreateTextTag` + all its setters) stored as live
    `TextTagObj`s in `runtime.textTags` for a renderer to poll (not push-emitted per setter — the BJ helpers set text
    *before* position, so an eager emit would snapshot the tag mid-configuration).
  - **Text logic:** names (`GetPlayerName`/`SetPlayerName`, `GetUnitName`/`GetObjectName`/`GetHeroProperName` via the
    `unitName`/`objectName` data hooks), a real 32-bit `StringHash` (FNV-1a), and identity `GetLocalizedString`/`Hotkey`.
- **`src/jass/natives/forces.ts`** — **forces** (player groups) are a prerequisite: the GUI "Game - Display text"
  action compiles to `DisplayTextToForce(GetPlayersAll(), msg)`, and blizzard.j gates every force-targeted text helper
  on `IsPlayerInForce(GetLocalPlayer(), toForce)`. Once `CreateForce`/`ForceEnumPlayers`/`ForForce`/… exist,
  blizzard.j's own `InitBlizzardGlobals` populates `bj_FORCE_ALL_PLAYERS`/`bj_FORCE_PLAYER[]` for free.
- **`src/jass/wts.ts`** — `parseWts`: the World Editor doesn't inline authored strings, it emits `TRIGSTR_nnn`
  placeholders and ships the text in `war3map.wts`. `Runtime.resolveTrigStr` swaps them in at the interpreter's
  string-literal choke point, so `"TRIGSTR_019"` renders as *"The gates have been opened…"*.
- **`src/render/mapViewer.ts`** — `runMapScript()` runs `config()` **+ `main()`** with **display-only hooks** (no
  `createUnit`, so unit placement still comes from `.doo` adoption — 7.2b unchanged). `main()` → `InitBlizzard` →
  `RunInitializationTriggers` fires the map's "Map Initialization" triggers, so welcome/quest text appears.
- **`src/ui/hud.ts`** — a WC3-style message log in the upper-left; `formatColorCodes` honours `|cAARRGGBB…|r` colour
  runs and `|n` breaks.

Verified (`pnpm jass:test` §7.5): `DisplayTextToForce`/timed reach the local player through `bj_FORCE_ALL_PLAYERS`,
`ClearTextMessagesBJ` clears once, `CreateTextTagLocBJ` builds a tag (size→height 0.023), `SubStringBJ`/`GetPlayerName`/
`StringHashBJ` return the right values — all through the **real** blizzard.j BJs. Verified **live** on WarChasers: its
welcome line + four `|cff32cd32HINT|r` hints render in the HUD from the map's own init triggers (296 trigger
registrations, 19 timers, 374 unit rows recorded; `main()` runs in ~100 ms; no duplicate units).

## The live event pump (7.4b — done, live)

`main()` registers triggers on events during init, but nothing fires them until the sim raises those events. The pump
lives in **`src/render/mapViewer.ts` `pumpMapScript(dt)`**, called from the frame loop each (non-paused) sim step:

- **Timers:** `interp.advanceTime(dt)` (already built in 7.4a) — `TimerStart` handlers + `TriggerRegisterTimerExpireEvent`.
- **Enter/leave region:** `interp.pumpRegions(unitSnapshots)`. The GUI "Unit enters (region)" action compiles to
  `TriggerRegisterEnterRectSimple(trig, gg_rct_X)`, so **`src/jass/natives/region.ts`** implements `Rect` (+ the
  `gg_rct_*` geometry `CreateRegions()` builds in `main()`) and **`Interpreter.pumpRegions`** diffs, each tick, the set
  of units inside every registered rect against last tick — firing the trigger on a crossing with `GetTriggerUnit` /
  `GetEnteringUnit` / `GetLeavingUnit` set (units already inside at registration seed a silent baseline, matching WC3).
  Sim units aren't interpreter-created (they're `.doo`-adopted), so `Runtime.unitForSim` mints a stable `unit` handle
  per sim id, kept live so `GetUnitX`/`GetOwningPlayer` read the current value.
- **Show Regions** (HUD debug button, bottom of the cheat stack): outlines every `gg_rct_*` on the terrain with its
  name centred inside — for eyeballing where the enter/leave triggers fire.

Verified (`pnpm jass:test` §7.6): enter fires on each cross-in and NOT for a unit already inside at registration; leave
fires once on cross-out with no re-fire while inside; `GetEnteringUnit` is the crossing unit at its live position.
Verified **live** on WarChasers: driving the wisp onto the Archer pedestal region fires its trigger (whose actions run —
`CreateUnit` of the selected hero, recorded as rows), re-entry fires again, and standing still doesn't re-fire.

## Live unit creation / removal (7.2b — done live, base-game types)

A trigger's `CreateUnit` now puts a **real** unit on the map, and `RemoveUnit`/`KillUnit` take it off. Built in
**`src/render/mapViewer.ts`** + the sim/RTS layer:

- **`createUnit` hook** (`spawnScriptUnit`) — resolves the rawcode in our `UnitRegistry`, then spawns via the existing
  `spawnUnit` (model instance → `RtsController.addUnit` → sim unit). JASS needs the unit handle *synchronously* but the
  model loads async, so `RtsController.reserveUnitId()` hands back a sim id up front and `addUnit(..., reservedId)`
  attaches the render instance to that id when it's ready. JASS facing (degrees) → sim radians.
- **The `scriptSpawnLive` gate** — the crux of not double-placing pre-placed units. It's `false` while `main()` runs, so
  `CreateAllUnits()` records `JassUnit` rows only (the `.doo` adoption still owns pre-placed units), and flips `true`
  once `main()` returns — so only *trigger*-time `CreateUnit` (hero selection, spawns) spawns for real.
- **`RemoveUnit`/`KillUnit`** — `SimWorld.removeUnit` (no death/corpse) and `killUnit` (death anim + corpse), reconciled
  to the render side by the existing `drainRemovals`/`drainDeaths` → `onRemove`/`onDeath` path.

Verified **live** on WarChasers: trigger-spawned base units (2 footmen + a Paladin hero) render with HP/mana bars,
selection rings, and team colour; driving the wisp onto the Archer region `RemoveUnit`'d it (count −1).

## Custom object data (7.2c/7.2d/7.2e — done live: units + abilities + items)

Custom maps define their own types in the object-data files: a *custom* table (a NEW 4-char id based on a base-game
type + field overrides) and an *original* table (overrides on a base type in place). Our registries only ship the
base-game types, so custom rawcodes weren't found. Built in **`src/data/objectData.ts`** + per-map overlays on
`UnitRegistry`/`AbilityRegistry`/`ItemRegistry` (a `custom` map that `get()` checks first; `clearCustom()` on map change
so no map leaks into the next — `ItemRegistry` also rebuilds its random-drop `byLevel` index). `mapViewer
.loadMapObjectData()` runs all three at the top of `startCustom`.

- **Units — `applyMapUnitData(registry, w3u, wts)`** parses `war3map.w3u` (mdx-m3-viewer `War3MapW3u`), clones the base
  `UnitDef`, applies overrides, installs it. Field codes are 4-char META ids (`umdl`=model, `unam`=name, `uhpm`=HP,
  `uabi`/`uhab`=abilities, …) mapped to `UnitDef` fields **directly** — few fields, none level-indexed — verified
  against `Units\UnitMetaData.slk`. Unmapped codes inherit from the base (safe).
- **Abilities — `applyMapAbilityData(registry, w3a, abilityMeta, wts)`** parses `war3map.w3a` with the level/variation
  parser (`War3MapW3d`, `useOptionalInts=true`). Abilities are level-indexed (a value per rank) and their DataA..DataI
  columns use **per-ability** field codes (`Hhb1` = Holy Light's heal, `Ocr1` = Critical Strike's chance), so the
  mapping is **meta-driven**: every override is routed through `Units\AbilityMetaData.slk` — its `field` column names
  the target (`Area`, `Cool`, `Data`, …) and `data` gives the DataA..I slot (1–9); the modification's `levelOrVariation`
  is the rank. The clone keeps the base's **`code`** (the sim's dispatch key), so a custom "Super Holy Light" still runs
  Holy Light's behaviour with the overridden numbers.
- **Items — `applyMapItemData(registry, w3t, wts)`** parses `war3map.w3t` (flat, no level data — reuses `War3MapW3u`),
  clones the base `ItemDef`, and applies overrides via a direct code map (`unam`=name, `iabi`=granted abilities,
  `icla`=class, `igol`=gold, `iusa`=usable, …). Items have no MetaData SLK, so — as with units — the codes map directly.
  An item's *behaviour* rides on the abilities it carries (`iabi` → dispatched off each ability's `code`), so a custom
  item works as long as those base abilities are known.

Verified (`pnpm jass:test` §7.7/§7.8/§7.9): WarChasers' `EC12` → Shandris model + wts name + inherited `isHero`;
ExtremeCandyWar's `A000` ability inherits its base `code` + level-1 `area == 425` + `Oar1` DataA → `data[0]`; its `I000`
item resolves to "Kael's Will" (Artifact, grants ability `AIda`, usable). Verified **live**: the Archer pedestal spawns
the real Shandris-model hero (screenshots); the custom ability + item both resolve in-browser with the right fields.
(Names/tooltips resolve `TRIGSTR_` refs via `war3map.wts`.)

## What's NOT done yet (next tasks — keep this list honest)

- **Custom destructable/upgrade/buff data** (optional) — the same mechanism for `war3map.w3b` (destructables,
  `War3MapW3u`), `.w3q` (upgrades, `War3MapW3d`), `.w3h` (buffs, `War3MapW3u`). Lower priority: only maps that create
  custom destructables (via `CreateDestructable`) / research custom upgrades need them. Units + abilities + items — the
  gameplay-critical trio — are done.
- **Custom-ability *behaviour*** — object data now gives a custom ability its real numbers, but only abilities whose base
  `code` is in `KNOWN_ABILITIES` (src/data/abilities.ts) actually *do* anything; an unknown base code loads as data but
  stays passive/uncastable (graceful, but inert).
- **7.4c** pump the remaining sim events — **unit-death** (`TriggerRegisterDeathEvent`), damage, orders, unit-state —
  from `rts.tick` into `Interpreter.fireEvent`, the way regions/timers already are.
- **7.3** run melee from `blizzard.j`'s `Melee*` library and retire the hard-coded `startMelee` roster.
- **Natives on demand** — groups, weather, sound, cameras, cinematics (transmissions), multiboard, quests, gamecache.
  Use `pnpm jass:coverage` to prioritise (125/335 used natives implemented).
- **Floating text rendering** — the `CreateTextTag` natives fully populate `runtime.textTags`, but nothing draws them
  in 3D yet (no world-space text pass). On-screen messages *are* rendered (HUD message log).
- **Lua** (`war3map.lua`, Reforged 1.31+) — only when we target that version.
