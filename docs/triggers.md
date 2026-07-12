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
| 7.4c | **Death + combat events** (`DEATH`/`DAMAGED`/`ATTACKED`) live from `rts.tick` | ✅ done (live) | §7.10/§7.11 headless (owner/unit-matched, `GetDyingUnit`/`GetEventDamage`/`GetAttacker`); Candy: 90 attack-trigger fires + 30 damage events on live combat |
| 7.7 | **Trigger effects land** (`SetPlayerState` resources, `SetUnitState` HP/mana) | ✅ done (live) | §7.12 headless (BJ resource family → gold 650, lumber 300); Candy grants 300 gold + income ticks in the HUD (screenshots) |
| 7.13 | **Unit-mutation effects** (`SetUnitPosition`/`X`/`Y`/`Loc`, `SetUnitFacing[Timed]`, `SetUnitOwner` + **change-owner event**, `PauseUnit`/`IsUnitPaused`, `SetUnitScale`/`VertexColor`/`FlyHeight`/`MoveSpeed`/`TurnSpeed`/`TimeScale`, `SetUnitColor`, live `Get*`) | ✅ done (live) | §7.13 headless (every effect recorded in a mock sim; `EVENT_PLAYER_UNIT_CHANGE_OWNER` fires w/ `GetChangingUnitPrevOwner`; `Get*` read live); Echo Isles: a unit visibly scaled/tinted/reowned (screenshots) |
| 7.14 | **Trigger orders** — `Issue{Immediate,Point,Target}Order`(+`ById`/`Loc`) → the sim marches/attacks; `OrderId`/`OrderId2String`/`String2OrderId`/`GetUnitCurrentOrder`; **`EVENT_..._ISSUED_ORDER`/`POINT`/`TARGET`** (38/39/40 + unit 75/76/77) w/ `GetIssuedOrderId`/`GetOrderPointX/Y`/`GetOrderTargetUnit` | ✅ done (live) | §7.14 headless (issue natives → bridge w/ right id+kind+target; order events dispatch owner-matched; vocabulary round-trips); Echo Isles: a trigger marches a squad of peasants (screenshots) |
| 7.15 | **Trigger threads — waits** (`TriggerSleepAction`/`PolledWait`): trigger actions run on a suspendable thread; `TriggerExecute`/`ConditionalTriggerExecute`/`ExecuteFunc` run on the caller's thread | ✅ done (live) | §7.15 headless (a wait suspends + resumes on game time, **event responses survive it**, `PolledWait` through the real blizzard.j, 0s-wait can't hang, wait-in-condition abandoned, a Wait in map init defers the rest of init); ExtremeCandyWar + WarChasers park + resume real threads (screenshots) |
| — | **Unit groups** (`CreateGroup`/`GroupEnumUnitsInRect`/`ForGroup`/…) — the GUI's "Pick every unit in <region>" | ⬜ **next** | a "pick every unit" trigger body does something |
| — | remaining effect natives (add/remove ability, `SetHeroLevel`/XP, weather, …) + remaining events (unit-state, construct/train, spell-cast) | ⬜ next | a hero levels / a spell-cast trigger fires |
| 7.3 | Melee from the script (retire hard-coded roster) | ⬜ todo | melee-via-script == `startMelee` |
| 7.5 | Native breadth + Lua/Reforged | ⬜ ongoing | `pnpm jass:coverage` (157/335 used natives implemented) |

Run the checks any time: **`pnpm jass:test`** (7.0–7.2 oracles + 7.4 timers + 7.5 text + 7.6 regions + 7.7/7.8/7.9 object data + 7.10/7.11 events + 7.12 effects + 7.13 unit-mutation effects + 7.14 orders + 7.15 threads/waits) and **`pnpm jass:coverage`** (unimplemented natives by usage).

> **Note on `jass:coverage`'s numbers.** It detects an implementation by scanning `src/jass/natives/*.ts` for the
> quoted native name, and it only counts natives called **directly** from a `war3map.j`. So (a) natives registered
> from an unquoted table key can read as missing, and (b) everything a map reaches *through* a blizzard.j BJ —
> groups, `PolledWait` — is invisible in the ranking. Treat it as a floor, not a census.

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
main()                                                                                    [runs live, 7.6 — on a THREAD]
  SetCameraBounds / SetDayNightModels / sound  (we no-op — the renderer owns these)
  CreateAllUnits()             // records rows only (scriptSpawnLive=false during init, so no dup of the .doo units)
  InitBlizzard() / InitGlobals() / InitCustomTriggers() / RunInitializationTriggers()  // init triggers fire → text!
                               // an init trigger's `Wait` suspends main() itself — the rest of init resumes after it (7.15)
// then: rts.tick pumps the runtime → timers + sleeping trigger threads (waits, 7.15) + region + death/damage/attacked
//       + issued-order triggers fire live (7.4b/c, 7.14)
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
| `interpreter.ts` | tree-walker: call frames, `and`/`or` **do not short-circuit** (JASS gotcha), type-directed arithmetic, safe defaults, loop/recursion caps — plus the **trigger-thread scheduler** (7.15): statements are generators, so `TriggerSleepAction` can suspend a trigger mid-action and `pumpThreads` resumes it on game time |
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
- **Custom maps now run their own script live** — `main()` fires the init triggers (text/quests, `bj_FORCE_*`,
  `SetPlayerState` resources), the runtime pumps live (timers + region + death/damage/attacked events — 7.4b/c), and
  trigger `CreateUnit`/`RemoveUnit`/resource/unit-state/unit-mutation actions land. What's still missing is per-*effect*
  breadth: only the natives we've wired mutate the game (see the effect tables in 7.7 / 7.13 below) — an unwired action
  (add ability, hero level, weather, …) no-ops, so a map leaning on those won't be fully faithful yet.

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
- **Death + combat** (7.4c): the sim records an event snapshot (victim/killer, target/source, attacked/attacker) at the
  moment it happens — `kill()`, `landDamage()`, the attack-swing commit — but **only** for the kinds the loaded script
  actually registers (`captureDeaths`/`captureDamage`/`captureAttacks`, which `runMapScript` sets by scanning the regs;
  so a map that doesn't listen — or melee — pays nothing). Each tick `pumpMapScript` drains and dispatches them:
  - `interp.pumpUnitDeaths` — `TriggerRegisterDeathEvent` (a specific unit), `EVENT_UNIT_DEATH` (53), and the common
    `EVENT_PLAYER_UNIT_DEATH` (20, per player) matched by the victim's owner → `GetDyingUnit`/`GetKillingUnit`.
  - `interp.pumpDamageEvents` — `EVENT_UNIT_DAMAGED` (52, per unit) → `GetEventDamage`/`GetEventDamageSource`.
  - `interp.pumpAttackEvents` — `EVENT_UNIT_ATTACKED` (62) + `EVENT_PLAYER_UNIT_ATTACKED` (18) → `GetAttacker`.
  All route through one `dispatchToRegs(responses, matcher)` helper (unit/owner/enum/filter matching factored out).
- **Show Regions** (HUD debug button, bottom of the cheat stack): outlines every `gg_rct_*` on the terrain with its
  name centred inside — for eyeballing where the enter/leave triggers fire.

Verified (`pnpm jass:test` §7.6/§7.10/§7.11): enter fires on each cross-in and NOT for a unit already inside; leave fires
once; a death fires the owner-matched `EVENT_PLAYER_UNIT_DEATH` (not another player's); `EVENT_UNIT_DAMAGED` fires only
for the struck unit with `GetEventDamage`/`GetEventDamageSource` correct; `EVENT_PLAYER_UNIT_ATTACKED` fires for the
owner-matched attack with `GetAttacker`. Verified **live**: the wisp on WarChasers' Archer pedestal fires its trigger;
killing a unit in ExtremeCandyWar fired 7 death handlers; two hostile units auto-fighting produced 17 attack events →
90 attack-trigger fires, and 30 damage events (amount + source resolved).

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

## Trigger effects that land (7.7 — done, live)

Firing a trigger is only half the loop — its *actions* have to change the game. The action natives route through
`EngineHooks` to the sim (`mapViewer.textHooks()`); the ones wired so far:

| Native(s) | Effect |
|---|---|
| `SetPlayerState` / `GetPlayerState` (+ the `AdjustPlayerStateBJ` / `SetPlayerStateBJ` family, which ride on them) | player **gold / lumber** ↔ `SimWorld.stashOf`; **food cap/used** read from `rts.foodFor` (derived, read-only) |
| `SetUnitState` / `GetUnitState` | unit **life / max-life / mana / max-mana** on the sim unit |
| `CreateUnit` / `RemoveUnit` / `KillUnit` | spawn / drop / slay a real sim+render unit (7.2b) |
| `DisplayTextTo…` / `ClearTextMessages` / `CreateTextTag` | HUD message log / floating text (7.6) |

Because the HUD reads `stashFor(localPlayer)` live, a `SetPlayerState` write shows up in the resource bar next frame —
no extra plumbing. Verified (`pnpm jass:test` §7.12): `SetPlayerState` + `AdjustPlayerStateBJ` + `SetPlayerStateBJ` +
`GetPlayerState` through the real BJs → gold 650, lumber 300. Verified **live**: ExtremeCandyWar's init triggers grant
300 starting gold to each player (custom maps used to sit at 0/0), and it ticks up as the map's income timer fires.

## Unit-mutation effects (7.13 — done, live)

The natives that make a trigger **visibly move / re-own / restyle a unit** — the second half of the 7.7 effect thread.
Each is a tiny bridge method; the sim already had most of the primitives (`teleportUnit`, `changeOwner`, per-unit
`facing`/`speed`). Built:

- **`src/jass/natives/world.ts`** — the effect natives, all routed through `EngineHooks`:
  - **Movement:** `SetUnitX`/`SetUnitY`/`SetUnitPosition`/`SetUnitPositionLoc` → `SimWorld.setUnitPosition` (the existing
    `teleportUnit`: instant relocate + pathing re-settle). `SetUnitFacing` (instant) / `SetUnitFacingTimed` (turns at the
    unit's turn rate) → `setUnitFacing`. JASS angles are **degrees**; the sim is radians (converted at the boundary).
  - **Ownership:** `SetUnitOwner` → `setUnitOwner` (owner **+ team**, so allegiance/vision follow) and, when `changeColor`,
    re-tints the team-coloured model parts. It also fires **`EVENT_PLAYER_UNIT_CHANGE_OWNER`** (id 270) synchronously via a
    new `NativeCtx.fireEvent`, with `GetChangingUnit`/`GetChangingUnitPrevOwner`/`GetTriggerPlayer` set (matched on the
    losing player — the common "any unit" registration covers every slot). `SetUnitColor` (previously a silent no-op — the
    hook was missing) now re-tints too.
  - **State:** `PauseUnit`/`IsUnitPaused` → a new `SimUnit.paused` flag gated in `tick` (no orders), `tickMovement` (halts),
    and the turning pass (freezes heading) — exactly like the `stunned` gate.
  - **Appearance (render-only, on `RtsController`):** `SetUnitScale` (Entry `baseScale`), `SetUnitVertexColor` (0–255 → 0–1
    model tint, re-applied over the fog-dim pass), `SetUnitFlyHeight` (sim altitude **and** the render Z lift),
    `SetUnitTimeScale` (animation rate).
  - **Speed/turn:** `SetUnitMoveSpeed` (sets `speed` **and** `baseSpeed`, else a slow/haste recompute would overwrite it),
    `SetUnitTurnSpeed`.
  - **Live `Get*`:** `GetUnitX`/`Y`/`Facing`/`MoveSpeed`/`FlyHeight` now prefer the **sim's live** value over the JASS
    handle's spawn-time field (a script-created unit's handle otherwise never updates as the unit moves).
- **`src/render/mapViewer.ts` `textHooks()`** — the bridge: sim mutators via `rts.simWorld`, render-only via `rts`
  (`setUnitScale`/`setUnitVertexColor`/`setUnitFlyHeight`/`setUnitTimeScale`/`setUnitTeamColor`). `SetUnitOwner` resolves
  the new team via `teamOf(player)`.

Verified (`pnpm jass:test` §7.13): a `CreateUnit`'d unit driven through the real `common.j`/`blizzard.j` — `SetUnitX/Y`
→ (512,256), `SetUnitFacing` → π, `SetUnitScale` → 1.5, `SetUnitVertexColor` 255,0,0,255 → [1,0,0,1], `SetUnitFlyHeight`
→ 200, `SetUnitMoveSpeed` → 400, `PauseUnit`+`IsUnitPaused` round-trip, `SetUnitOwner` → owner 5 + colour, and the
change-owner trigger fires once with `GetChangingUnitPrevOwner == Player(2)`; `Get*` read the live values back. Verified
**live** on Echo Isles (driven through the actual `EngineHooks`): a peasant scaled ×2.6 (giant), one tinted red, one
re-owned to player 1 so its team colour changes **and the food count drops 5/12 → 4/12** (ownership is real), the town
hall scaled up (screenshots).

## Trigger orders (7.14 — done, live)

The event bookend to the effects: a trigger tells a unit **what to do** (`IssueXOrder`) and reacts when **any** unit is
issued an order (`EVENT_..._ISSUED_ORDER`). This is the TD/spawn unlock — trigger-created units can now march and fight.
Built:

- **`src/jass/orders.ts`** — the order string↔id vocabulary (`ORDER_IDS`): the generic movement/attack orders keyed to
  the real engine constants (the 0x000D0000 block — `move` 851986, `attack` 851983, `smart` 851971, `stop` 851972,
  `patrol` 851990, `holdposition` 851993), so a GUI comparison (`GetIssuedOrderId() == OrderId("attack")`) *and* a
  hand-coded literal both match. Ability-based orders (a spell's "Order String") aren't in the table — `OrderId` returns
  0 for anything unknown, exactly like the engine.
- **`src/jass/natives/world.ts`** — `Issue{Immediate,Point,Target}Order` (+ `ById` / `PointLoc` variants), routed through
  the bridge; `OrderId`/`String2OrderId`/`OrderId2String`/`GetUnitCurrentOrder`.
- **`src/game/rts.ts` `issueUnitOrder`** — maps a generic order id + target kind to the sim's existing `issue*` commands
  (point `attack`→`issueAttackMove`, `patrol`→`issuePatrol`, else `issueMove`; target `attack`→`issueAttack(force)`,
  smart-on-a-unit → `issueAttack` for enemies / `issueFollow` for allies; immediate `stop`/`holdposition`). Unlike the
  player `order()` path it does **not** gate on ownership — a trigger can command any unit.
- **Order events — captured in the sim, drained in the interpreter** (same shape as death/damage/attack, 7.4c). The
  crux: capture happens **only at explicit-order boundaries** — the `IssueXOrder` natives and the player command router
  (`order()` for move/attack/attack-move/patrol/follow, plus `stopSelected`/`holdSelected`) — **never** the sim's shared
  `issue*` methods, which the internal AI (auto-acquire, creep guard, retaliation) also calls. So auto-acquisition
  retargeting stays silent, matching WC3. `SimWorld.noteOrder` buffers (gated by `captureOrders`); `drainOrderEvents` +
  `Interpreter.pumpOrderEvents` dispatch to `EVENT_(PLAYER_)UNIT_ISSUED_ORDER` (38/75, no target), `_POINT_ORDER`
  (39/76), `_TARGET_ORDER` (40/77), with `GetIssuedOrderId`/`GetOrderPointX/Y`/`GetOrderPointLoc`/`GetOrderTargetUnit`.

Verified (`pnpm jass:test` §7.14): the issue natives reach the bridge with the right id + kind + point/target
(`IssuePointOrder("attack",512,256)` → 851983/point, `IssueTargetOrder("smart",tgt)` → 851971/target, `stop` → 851972/
immediate); `OrderId("move")==851986`, `OrderId2String(851983)=="attack"`, `GetUnitCurrentOrder` live; and the events
dispatch owner-matched — `ISSUED_POINT_ORDER` fires only for the owning player with `GetIssuedOrderId==851983` /
`GetOrderPointX==640`, `ISSUED_TARGET_ORDER` fires once with `GetOrderTargetUnit` the right unit. Verified **live** on
Echo Isles: a trigger `IssuePointOrder` marched a 5-peasant squad across the map in formation (idle → move 851986 →
attack-move 851983, positions advancing ~2100 units), then `PauseUnit` froze them mid-stride (screenshots).

## Trigger threads — waits (7.15 — done, live)

The GUI's **"Wait"** action, and the biggest *correctness* hole in the engine: not a missing feature but a
**mis-executing** one. A WC3 trigger's actions run on a **thread** that `TriggerSleepAction` can suspend mid-way; the
engine resumes it N seconds of game time later. We ran actions straight through, synchronously, so:

- a bare `TriggerSleepAction` was an unimplemented native — a **silent no-op**, so everything after the wait ran
  *instantly* (a wave spawner emptied itself in one frame);
- worse, blizzard.j's **`PolledWait`** — what the GUI's "Wait" and every `…Wait` BJ actually call — *polls a timer in
  a loop* until it drains. With the wait a no-op and no time passing inside a synchronous action, the timer never
  drained: the loop span to the 2,000,000-iteration cap and then **abandoned the rest of the trigger**. Measured live
  on ExtremeCandyWar: **886 ms of blocked frame per `PolledWait`, and the post-wait actions never ran** (its
  `Warrior_Rage_Cap` trigger sets a cooldown flag, waits 0.9 s, clears it — so the flag stuck true forever).

Verified against the real `Scripts\blizzard.j` (the poll loop is Blizzard's own code, `bj_POLLED_WAIT_INTERVAL` 0.10 /
`bj_POLLED_WAIT_SKIP_THRESHOLD` 2.00). Built:

- **`src/jass/interpreter.ts`** — the statement/call layer is now written as **generators**, so a wait can suspend
  anywhere inside a trigger's actions and every enclosing call is resumable. A `JassThread` is a generator that yields
  the seconds it wants to sleep; `startThread` runs it **immediately** (WC3 runs actions the moment the event fires —
  the wait is what defers the rest) and only parks it in the scheduler if it actually suspended. `pumpThreads()` runs
  from `advanceTime` — the same sim-tick pump as the timers — so waits are **game time** (they stop when the game is
  paused) and stay deterministic.
  - **Event responses survive a wait.** They're thread-local in WC3: `GetTriggerUnit()` still reads the same unit after
    a `Wait 5 seconds`. Our response stack is global, so each thread carries **its own slice** of it (plus its call
    depth), restored on resume.
  - **A thread resumes at most once per pump** — that's what makes a wait cost at least a frame, so a
    `loop / TriggerSleepAction(0) / endloop` can't hang the tick.
  - **Expressions stay synchronous** (only statements can suspend). Every real wait is a statement — `TriggerSleepAction`
    returns `nothing` — so this costs no fidelity and keeps the hot path (expression eval) allocation-free.
- **Thread-transparent natives** — `TriggerExecute` / `ConditionalTriggerExecute` / `ExecuteFunc` run more JASS *on the
  calling thread*, which a native (a plain JS function) can't do, so the interpreter intercepts them at the call site.
  This is what makes **a Wait in a map-init trigger defer the rest of init** (`RunInitializationTriggers` executes the
  init triggers in sequence on `main()`'s thread) — faithful to WC3, where init waits are a known gotcha. `main()` and
  `config()` therefore run on threads too.
- **A wait with nowhere to park** (a condition, a boolexpr filter, a `ForGroup`/`ForForce` callback — none of which WC3
  can wait in either) throws `ThreadAbort` and abandons *that callback*, logged once. It must not simply no-op: that's
  precisely what made `PolledWait` spin.

Verified (`pnpm jass:test` §7.15): a wait suspends the trigger mid-action and resumes after exactly 3.0 s of game time
with `GetDyingUnit()` still resolving; `PolledWait(2.0)` through the **real** blizzard.j parks instead of spinning and
returns after ~2.0 s; `TriggerSleepAction(0)` advances one tick per wait (no hang); a wait in a condition is abandoned,
not spun; and a `Wait` in map init suspends `main()` itself, deferring the rest of init until the trigger spawns its
unit. Verified **live**: ExtremeCandyWar parks its intro-cinematic + income threads from t=0 and resumes them on
schedule (gold ticking, 144 fps, no hitch — vs **886 ms blocked** with the old no-op wait, A/B'd in the running game);
WarChasers holds 5 parked threads and sets `udg_TheLeaderBoard`, which is assigned *after* its `TriggerSleepAction(1.0)`
(screenshots).

## What's NOT done yet (next tasks — keep this list honest)

- **Custom destructable/upgrade/buff data** (optional) — the same mechanism for `war3map.w3b` (destructables,
  `War3MapW3u`), `.w3q` (upgrades, `War3MapW3d`), `.w3h` (buffs, `War3MapW3u`). Lower priority: only maps that create
  custom destructables (via `CreateDestructable`) / research custom upgrades need them. Units + abilities + items — the
  gameplay-critical trio — are done.
- **Custom-ability *behaviour*** — object data now gives a custom ability its real numbers, but only abilities whose base
  `code` is in `KNOWN_ABILITIES` (src/data/abilities.ts) actually *do* anything; an unknown base code loads as data but
  stays passive/uncastable (graceful, but inert).
- **More effect natives** — 7.7 + 7.13 cover resources, unit-state, and the unit-mutation set (move/facing/owner/pause/
  scale/colour/fly-height/speed). Still no-ops: `UnitAddAbility`/`UnitRemoveAbility`, `SetHeroLevel`/`AddHeroXP`,
  `SetUnitAnimation`, weather, etc. Each is a small bridge method away — wire on demand as maps hit them.
- **Remaining sim events** — timers, region, death, **damage**, **attacked**, and **orders** pump live (7.4b/c, 7.14);
  still to wire from `rts.tick`: **unit-state** (`EVENT_UNIT_STATE_LIMIT` — HP/mana threshold crossings),
  **construction/train finished** (`EVENT_PLAYER_UNIT_CONSTRUCT_FINISH`/`TRAIN_FINISH`), **spell cast**
  (`EVENT_PLAYER_UNIT_SPELL_*`). Same shape as `pumpDamageEvents`/`pumpOrderEvents` — snapshot the event in the sim
  (with its id/target), drain + dispatch in the interpreter.
- **7.3** run melee from `blizzard.j`'s `Melee*` library and retire the hard-coded `startMelee` roster.
- **Unit groups — the next task.** `CreateGroup`/`GroupEnumUnitsInRect`/`InRange`/`OfPlayer`/`ForGroup`/`FirstOfGroup`/
  `GroupAddUnit`/`IsUnitInGroup`/`GetEnumUnit` + the BJ family. This is the GUI's **"Pick every unit in \<region\>
  matching \<condition\> and do \<actions\>"** — the workhorse action of custom maps (spawn waves, AoE damage, mass
  orders) — and right now the whole action body silently does nothing. Should be a small diff: the boolexpr/filter
  machinery already exists (`Condition`/`Filter`/`GetFilterUnit`) and enumeration is a scan over the sim's unit list.
  It's also a hard dependency for **7.3** (`MeleeClearExcessUnits` enumerates groups). Note `jass:coverage` *undercounts*
  it badly — maps reach groups through blizzard.j BJs, which the tool doesn't scan.
- **Natives on demand** — weather, sound, cameras, cinematics (transmissions), multiboard, quests, gamecache.
  Use `pnpm jass:coverage` to prioritise (157/335 used natives implemented — and see the caveat on that number above).
- **Floating text rendering** — the `CreateTextTag` natives fully populate `runtime.textTags`, but nothing draws them
  in 3D yet (no world-space text pass). On-screen messages *are* rendered (HUD message log).
- **Lua** (`war3map.lua`, Reforged 1.31+) — only when we target that version.
