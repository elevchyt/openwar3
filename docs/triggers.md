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
| 7.16 | **Unit groups** — `CreateGroup`/`GroupEnumUnitsIn{Rect,Range,RangeOfLoc}`/`OfPlayer`/`OfType`/`Selected` (+`Counted`), `ForGroup`/`GetEnumUnit`/`FirstOfGroup`/`GroupAddUnit`/`IsUnitInGroup`, `Group{Immediate,Point,Target}Order` — the GUI's **"Pick every unit in \<region\> matching \<condition\>"**. Plus the filter natives it's useless without: `IsUnitType`, `IsUnitAlly`/`IsUnitEnemy`, `GetUnitLoc`, `GetStartLocationLoc` | ✅ done (live) | §7.16 headless (the real `ForGroupBJ`+`GetUnitsInRectMatching` path picks 5-of-6, the filter rejects the rest; group order reaches all members; one sim unit == one handle); Echo Isles: a trigger picks every worker in a region, tints them, then marches the group (screenshots); ExtremeCandyWar's own script drives 169 `CreateGroup`/168 enums/217 `ForGroup` — **all empty before, now finding units** |
| 7.17 | **Abilities, heroes + the remaining sim events** — `UnitAddAbility`/`Remove`/`Get`/`SetUnitAbilityLevel`, `SetHeroLevel`/`AddHeroXP`/`SetHeroXP`/skill points/`SelectHeroSkill`, `SetUnitInvulnerable`/`Pathing`/`Animation`/`UserData`, the MathAPI (**`SquareRoot`** — every `DistanceBetweenPoints` rode on it); **ability ORDERS** (`IssueTargetOrder(u,"holybolt",t)` → the unit casts); events: **SPELL_**\* (5 phases), **CONSTRUCT_**\*, **TRAIN_**\*, **HERO_LEVEL/SKILL**, **UNIT_STATE_LIMIT** | ✅ done (live) | §7.17 headless (effects round-trip through the real BJs; every event family dispatches owner-matched; the state threshold fires on the *crossing* only); Echo Isles: one trigger spawns a Paladin → levels it to 5 → grants Holy Light → orders the cast, and HERO_LEVEL / UNIT_STATE_LIMIT / SPELL_EFFECT / CONSTRUCT_* / TRAIN_* all report back into the HUD (screenshots) |
| 7.3 | **Melee runs from the map's own script** — `main()` fires the map's *Melee Initialization* trigger and blizzard.j's `Melee*` library does the rest: starting units + resources + hero limit, the start-location creep clear, the victory/defeat conditions. The hard-coded roster is retired (fallback only) | ✅ done (live) | §7.3 headless (EchoIsles' real `war3map.j` → the same roster/purse the old `startMelee` produced, all 4 races; creeps cleared; razing the hall defeats its owner); live: bases spawned by the script on Echo Isles (H/O/U/NE) + RagingStream's start-location camp cleared (screenshots) |
| 7.18 | **Items** — the trigger surface (`CreateItem`/`UnitAddItem`(`ById`/`ToSlotById`)/`UnitRemoveItem`/`UnitDropItem{Point,Slot,Target}`/`UnitUseItem*`/`RemoveItem`/`SetItemPosition`/charges/`UnitItemInSlot`/`UnitHasItem`/`EnumItemsInRect`/**`ChooseRandomItemEx`** — 151 maps) + the **item events** (`PICKUP`/`DROP`/`USE`/`SELL_ITEM` with `GetManipulatedItem`/`GetManipulatingUnit`). Pre-placed items (`CreateAllItems`) become **real, pickable** items; the melee hero gets its **Town Portal scroll** | ✅ done (live) | §7.18 headless (the item natives + every BJ the GUI emits; the 4 events dispatch owner-matched; a consumed powerup still resolves in its handler); Echo Isles: a trigger creates a Paladin + 4 items, he walks onto the potion (PICKUP fires, HUD inventory shows it), a trigger `UnitUseItem`s **the same handle** → +250 life (USE fires), a tome grants XP, claws show a green +15, `UnitDropItemPointBJ` drops them (DROP fires), `ChooseRandomItemEx` rolls a level-5 artifact (screenshots) |
| 7.5 | Native breadth + Lua/Reforged | ⬜ ongoing | `pnpm jass:coverage` (230/335 used natives implemented) |

Run the checks any time: **`pnpm jass:test`** (7.0–7.2 oracles + 7.3 melee-from-the-script + 7.4 timers + 7.5 text + 7.6 regions + 7.7/7.8/7.9 object data + 7.10/7.11 events + 7.12 effects + 7.13 unit-mutation effects + 7.14 orders + 7.15 threads/waits + 7.16 unit groups + 7.17 abilities/heroes/events + 7.18 items) and **`pnpm jass:coverage`** (unimplemented natives by usage).

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
           // → the host then hands over the LOBBY (Runtime.applyLobby, 7.3): which slots are actually
           //   PLAYING, as which race — GetPlayerSlotState/GetPlayerRace, which config() cannot know
main()                                                                                    [runs live, 7.6 — on a THREAD]
  SetCameraBounds / SetDayNightModels / sound  (we no-op — the renderer owns these)
  CreateAllItems()             // SPAWNS for real (7.18) — pre-placed items are the SCRIPT's, and the
                               // duplicate war3mapUnits.doo item widgets are hidden (rts.trySeed)
  CreateAllUnits()             // RECORDS rows only — those units are already on the map, adopted from
                               // war3mapUnits.doo (Runtime.recordOnlySpawnFns; scoped to the call, 7.3)
  InitBlizzard() / InitGlobals() / InitCustomTriggers() / RunInitializationTriggers()  // init triggers fire → text!
                               // MELEE map: that init trigger is "Melee Initialization" — its eight Melee* calls
                               //   ARE the game (bases, resources, creep clear, victory conditions — 7.3)
                               // an init trigger's `Wait` suspends main() itself — the rest of init resumes after it (7.15)
// then: rts.tick pumps the runtime → timers + sleeping trigger threads (waits, 7.15) + region + death/damage/attacked
//       + issued-order + spell/construct/train/hero-level + unit-state triggers fire live (7.4b/c, 7.14, 7.17)
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
| `natives/world.ts` | `CreateUnit` (+ bridge), resource/state setters, unit queries, unit-mutation effects (7.13), orders (7.14), per-unit flags/animation/user-data (7.17) |
| `natives/abilities.ts` | **abilities + heroes** (7.17): `UnitAdd/RemoveAbility`, `Get`/`SetUnitAbilityLevel`, `SetHeroLevel`/`AddHeroXP`/`SetHeroXP`, skill points, `SelectHeroSkill` — all through the sim's trigger-effect API |
| `natives/events.ts` | triggers (`CreateTrigger`/`TriggerAddAction`/`ConditionalTriggerExecute`), boolexprs, event **registration** + **response** readers, **timers** (7.4) |
| `natives/forces.ts` | **forces** (player groups): `CreateForce`/`ForceAddPlayer`/`IsPlayerInForce`/`ForForce`/`ForceEnum*` + `GetEnumPlayer`/`GetFilterPlayer` — the target of the "Text Message" actions (7.6) |
| `natives/groups.ts` | **unit groups** (7.16): the `GroupEnum*` scans over the live sim (`EngineHooks.enumUnits`), `ForGroup`/`GetEnumUnit`/`FirstOfGroup`, membership, and the `Group*Order` mass orders — the GUI's "Pick every unit in \<region\> matching \<condition\>" |
| `natives/items.ts` | **items** (7.18): `CreateItem`, the inventory family (`UnitAddItem`/`ById`/`ToSlotById`, `UnitRemoveItem`, `UnitItemInSlot`, `UnitHasItem`), drop/give/use, charges + item-type queries, `EnumItemsInRect`, and `ChooseRandomItem(Ex)` — an `item` handle is one entity whether it lies on the ground or sits in a pack |
| `natives/melee.ts` | **what blizzard.j's `Melee*` library stands on** (7.3): `GetPlayerSlotState`/`GetPlayerRace` (in config.ts), `VersionGet`, `IsMapFlagSet`, `Set/GetFloatGameState` (the 08:00 clock), `SetCameraPosition`, the tech/hero caps, `GetPlayerStructureCount`/`GetPlayerTypedUnitCount` (who has lost), `GetResourceAmount`/`CreateBlightedGoldmine` (the gold-mine fiction) + explicit no-ops for what we don't model (AI scripts, blight, preloading) |
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

## Unit groups (7.16 — done, live)

The **workhorse action of custom maps**: *"Pick every unit in \<region\> matching \<condition\> and do
\<actions\>"* — spawn waves, AoE damage, mass orders, "are all the defenders dead?". The World Editor compiles it to

```jass
call ForGroupBJ( GetUnitsInRectMatching( gg_rct_Foo, Condition(function Filt) ), function Actions )
```

so the whole GUI family (`ForGroupBJ`, `GetUnitsInRect/RangeOf*`, `CountUnitsInGroup`, `GroupPickRandomUnit`,
`GroupAddGroup`, `IsUnitGroupDeadBJ`, …) is *blizzard.j code we already interpret* riding on a handful of natives.
Before this, every one of them silently did nothing. Built:

- **`src/jass/natives/groups.ts`** — the container (`CreateGroup`/`GroupAddUnit`/`GroupRemoveUnit`/`GroupClear`/
  `IsUnitInGroup`), the **enumeration** scans (`GroupEnumUnitsInRect`/`InRange`/`InRangeOfLoc`/`OfPlayer`/`OfType`/
  `Selected`, each with its `*Counted` variant), **iteration** (`ForGroup` + `GetEnumUnit`, `FirstOfGroup`), and the
  **mass orders** (`Group{Immediate,Point,Target}Order`(+`ById`/`Loc`) → the same sim bridge 7.14 issue-orders use).
  - **Enumeration reads the live sim** through a new `EngineHooks.enumUnits` (mapViewer hands over `SimWorld.units`;
    the region pump now shares that same snapshot helper).
  - **The enum natives CLEAR the group first** — they replace its contents rather than accumulate, which is what makes
    the recycled-"enum group" idiom work. Verified against the community JASS references (thehelper/Hive threads on
    group enumeration) and consistent with blizzard.j, which only ever enums into a fresh or explicitly cleared group.
  - **The `matching` filter** is a boolexpr run per unit with `GetFilterUnit` set — the same machinery the enter-region
    filter uses.
  - **One sim unit = one handle.** `CreateUnit` now binds its handle to the sim id (`Runtime.bindSimUnit`), so a unit
    enumerated later is the *same* handle `CreateUnit` returned and the same one `GetTriggerUnit` hands out. Without
    this, `IsUnitInGroup(GetTriggerUnit(), g)` and `GetEnumUnit() == u` would silently be false (two handles, one unit).
- **The filter natives a group is useless without** — a "matching" condition asks `IsUnitType(…, UNIT_TYPE_STRUCTURE)`,
  `IsUnitEnemy(…, Player(0))`, `IsUnitAliveBJ(…)`. All three were stubs or missing:
  - **`IsUnitType`** (was a hard `false`) → a bridge lookup over the sim unit's flags: HERO / DEAD / STRUCTURE /
    FLYING / GROUND / MELEE / RANGED / SUMMONED / STUNNED / UNDEAD / MECHANICAL / PEON / SLEEPING. Classifications we
    hold no data for still read false, rather than guess.
  - **`IsUnitAlly`/`IsUnitEnemy`** → team comparison via the bridge (neutral hostile, team −1, is nobody's ally).
  - **`GetUnitLoc`** (+ `GetStartLocationLoc`/`X`/`Y`) — locations are the currency of the BJ layer: "pick every unit
    within 600 of \<unit\>" is `GetUnitsInRangeOfLocMatching(600, GetUnitLoc(u), filter)`. **This was the bug that made
    groups look broken in the wild:** live on ExtremeCandyWar the map called `GroupEnumUnitsInRangeOfLoc` 168× in a few
    seconds and *every one enumerated around a null location and found nobody*. `IsUnitAliveBJ` already worked (it reads
    `GetUnitState`, 7.7).

Sim difference worth knowing: our sim drops a unit from `SimWorld.units` the moment it dies (it becomes a corpse), so an
enum only ever sees **living** units. WC3 also enumerates dead-but-not-decayed bodies — which is why so much GUI code
filters on `IsUnitAliveBJ(GetFilterUnit())`. That filter still works here; it just has nothing to reject.

Verified (`pnpm jass:test` §7.16), all through the **real** blizzard.j: the compiled GUI shape
(`ForGroupBJ(GetUnitsInRectMatching(…))`) picks exactly the 2 footmen inside the rect and `GetEnumUnit` resolves each;
`GetUnitsInRectAll` + `CountUnitsInGroup` → 4 (the far-off unit excluded); `GroupEnumUnitsOfPlayer` excludes the other
player's unit; `InRange` is a circle test from the unit's origin; `GroupEnumUnitsSelected` reads the bridge's selection;
a group is a **set** (adding twice adds once); `GroupPointOrder("attack")` reaches all 4 members with id 851983; and a
`CreateUnit`'d unit enumerates as the same handle (`IsUnitInGroup` + `==` hold).
Verified **live**: on Echo Isles a trigger ran *"Pick every unit in \<region\> matching \<is a worker\>"* — it picked **5
workers of the 6 units** in the rect (the town hall, in the rect but not a worker, was rejected by the filter), tinted and
enlarged each through `GetEnumUnit`, printed `CountUnitsInGroup` to the HUD, then marched the whole picked group across the
map with one `GroupPointOrder` (screenshots). On ExtremeCandyWar the map's **own** script now drives 169 `CreateGroup` /
168 enums / 217 `ForGroup` calls that **find units** (they returned empty before), at 144 fps with 208 units.

## Abilities, heroes, and the remaining sim events (7.17 — done, live)

The last two gaps in the trigger surface: the **effect** natives that touch a unit's spells and
a hero's progression, and the **events** the sim still swallowed (spell casts, construction,
training, hero levels, HP/mana thresholds). With these, a map can do the whole loop — *grant a
spell → order it cast → react when it goes off*. Built:

- **`src/jass/natives/abilities.ts`** (new) — `UnitAddAbility` / `UnitRemoveAbility` /
  `UnitMakeAbilityPermanent`, `GetUnitAbilityLevel` / `SetUnitAbilityLevel` / `Inc` / `Dec`,
  `UnitResetCooldown`, and the hero family: `GetHeroLevel` / `GetUnitLevel` / `SetHeroLevel`,
  `GetHeroXP` / `SetHeroXP` / `AddHeroXP`, `GetHeroSkillPoints` / `UnitModifySkillPoints`,
  `SelectHeroSkill`. Each is a bridge call into a new **trigger-effect API on `SimWorld`**
  (`addAbility`/`removeAbility`/`setAbilityLevel`/`setHeroLevel`/`addHeroXp`/…) that reuses the
  sim's own rules — `UnitAddAbility` adds at rank 1 (WC3 *adds* the ability, it doesn't make it
  learnable), and `SetHeroLevel` runs the real `levelUp` path per level crossed, so the nova, the
  HP/mana refill, the skill point and the HERO_LEVEL event all happen exactly as on a kill.
- **`src/jass/natives/world.ts`** — `SetUnitInvulnerable`, `SetUnitPathing` (the "ghost"),
  `SetUnitAnimation` / `QueueUnitAnimation` / `ResetUnitAnimation` (matched against the model's own
  sequence names — `RtsController.setUnitAnimation`), `SetUnitUserData`/`GetUnitUserData` (the
  "custom value" every unit-indexing library rides on — pure script state, so it lives on the
  handle), `IsPlayerAlly`/`IsPlayerEnemy`.
- **The MathAPI** (`natives/index.ts`): `SquareRoot`, `Sin`/`Cos`/`Tan`/`Asin`/`Acos`/`Atan`/`Atan2`,
  `Pow`, `Deg2Rad`/`Rad2Deg`. Not decoration — blizzard.j's `DistanceBetweenPoints` *is*
  `SquareRoot(dx*dx + dy*dy)`, so until now **every distance in the BJ layer measured 0**.
- **Ability orders** — the GUI's *"Unit - Order \<unit\> to \<ability\>"* compiles to
  `IssueTargetOrder(u, "holybolt", target)`. The order string lives in the ability data
  (`<Race>AbilityFunc.txt` `Order=` / `Orderon` / `Orderoff` — verified in the 1.27 MPQ; it is
  **not** in AbilityData.slk), so `AbilityDef` now carries it and the bridge passes the order
  **string** alongside the id: `RtsController.castOrder` matches it against the unit's own
  abilities and calls `SimWorld.issueCast` (an autocast toggle flips autocast instead). The engine's
  numeric ids for ability orders exist in no data file, so `OrderId` **mints** a stable id per
  order string (0x000E0000 block) — self-consistent, which is all GUI code needs
  (`GetIssuedOrderId() == OrderId("holybolt")`), and the cast itself never depends on the number.
- **The events** — the sim records each one only when the script listens (`captureSpells` /
  `captureConstruct` / `captureTrain` / `captureHeroEvents`, derived in `syncEventCaptures`), and
  `pumpMapScript` drains them into the matching `Interpreter.pump*`:
  - **Spells** (`EVENT_(PLAYER_)UNIT_SPELL_*`, 272–276 / 289–293) — our cast timeline maps straight
    onto WC3's five phases: the wind-up beginning is **CHANNEL + CAST**, the cast point is
    **EFFECT** (the phase nearly every GUI trigger uses), `endCast` is **FINISH + ENDCAST**, and an
    interrupted cast (a stun, a Stop, a new order) raises **ENDCAST** alone. Responses:
    `GetSpellAbilityId` (the ability's rawcode), `GetSpellAbilityUnit`, `GetSpellTargetUnit`,
    `GetSpellTargetX/Y/Loc`.
  - **Construction** (26–28 / 64–65) — the foundation laid (`RtsController.addSimUnit` with a build
    time), `cancelBuilding`, and construction reaching 0 → `GetConstructingStructure` /
    `GetCancelledStructure` / `GetConstructedStructure`. (common.j declares no *unit*-scoped
    CONSTRUCT_START — only the player one.)
  - **Training** (32–34 / 69–71) — start/cancel from the queue methods; **FINISH is raised by the
    engine, not the sim**, because a trained unit is born in the renderer (the sim owns no models):
    `SimWorld.noteTrainFinish` is called once the unit actually exists, so `GetTrainedUnit` hands
    the script a real unit. The subject unit (`GetTriggerUnit`) is the **training building**.
  - **Hero level / skill** (41–42 / 78–79) → `GetLevelingUnit`, `GetLearningUnit` /
    `GetLearnedSkill` / `GetLearnedSkillLevel`.
  - **`EVENT_UNIT_STATE_LIMIT`** (59, via `TriggerRegisterUnitStateEvent`) — the one event nothing
    in the sim raises ("life changed" has no hook), so the interpreter **polls** it and fires on the
    **rising edge**: "life drops below 100" fires once per crossing, not every tick it sits below.
    The edge is seeded at **registration** (`unitStateHolds`), so a unit already under the limit when
    the trigger is created stays quiet, while one wounded a moment later — even in the same tick —
    fires.
- **`CreateUnit` is now synchronous** (a real fidelity fix, not a new feature). Our spawn loads the
  model asynchronously, so a trigger's `CreateUnit` used to hand back a unit whose **sim unit didn't
  exist yet** — every effect applied on the next line (add ability, set level, issue an order) was
  silently dropped. `RtsController.addSimUnit` now creates the sim unit immediately and
  `attachInstance` gives it its body when the model lands (the render loop syncs position from the
  sim, so it just appears where it has got to). A unit `RemoveUnit`'d while its model is still
  streaming makes `addUnit` return -1 and the model is dropped rather than left a ghost.

Verified (`pnpm jass:test` §7.17), through the real `common.j`/`blizzard.j`: `UnitAddAbility` → rank
1, `SetUnitAbilityLevel(3)` + `DecUnitAbilityLevel` → 2, `UnitRemoveAbility` → 0; `SetHeroLevelBJ`
→ level 3, `AddHeroXP(250)` → level 4 at 650 XP, `UnitModifySkillPoints` → 6 unspent; invulnerable /
pathing / animation / user-data all round-trip; `DistanceBetweenPoints` → 500 (3-4-5). Every event
family dispatches owner-matched (an enemy's cast doesn't fire a Player 0 trigger), `GetSpellAbilityId`
→ `'AHhb'`, `GetTrainedUnit` is the new unit, and the state threshold fires 0 / 1 / 2 times across
healthy → crossed → still-below → re-crossed. Verified **live** on Echo Isles: one trigger creates a
Paladin, `SetHeroLevel`s it to 5 (four HERO_LEVEL fires, the level-up nova, the "5" badge), grants it
Holy Light at rank 3, and `IssueTargetOrder(hero, "holybolt", peasant)` — the hero walks in, casts,
and heals the worker 120 → 220 HP, with SPELL_EFFECT ("Paladin cast Holy Light on Peasant"),
UNIT_STATE_LIMIT ("life fell below 200"), TRAIN_START/FINISH and CONSTRUCT_START/FINISH all printing
back into the HUD from the map's own triggers (screenshots).

> Known nuance: because events are drained a tick after the sim raises them, a `Get*` that reads the
> **live** sim inside a handler sees the current value — so `GetHeroLevel(GetLevelingUnit())` in the
> four HERO_LEVEL fires of a `SetHeroLevel(5)` jump reports 5 each time, not 2/3/4/5. The event's own
> responses are per-level and correct; only the live re-read collapses.

## Melee runs from the map's own script (7.3 — done, live)

The milestone that closes the loop: **we no longer place a melee game ourselves.** A melee map's
`war3map.j` carries a *"Melee Initialization"* trigger, and its eight calls into blizzard.j's `Melee*`
library **are** the melee game:

```jass
function Trig_Melee_Initialization_Actions takes nothing returns nothing
    call MeleeStartingVisibility(  )   // the clock opens at 08:00 (bj_MELEE_STARTING_TOD)
    call MeleeStartingHeroLimit(  )    // 3 heroes per player, 1 per hero type
    call MeleeGrantHeroItems(  )       // the first hero trained gets a Town Portal scroll
    call MeleeStartingResources(  )    // 500 gold / 150 lumber (the TFT _V1 constants)
    call MeleeClearExcessUnits(  )     // wipe the creeps camped on a USED start location
    call MeleeStartingUnits(  )        // the town hall + the 5 workers clumped by the nearest mine
    call MeleeStartingAI(  )           // (no AI scripts yet — a computer slot just sits)
    call MeleeInitVictoryDefeat(  )    // no structures = defeated; no main hall = crippled
endfunction
```

All eight are **Blizzard's own JASS** (`Scripts\Blizzard.j` in the MPQs) — we *interpret* them, so the
rules and the numbers are the game's, not our guess at them. `mapViewer.startMelee` now just brings the
match up and runs the script; the hard-coded roster (`STARTING_UNITS` / `MELEE_WORKER_CLUSTERS`) survives
only as `startMeleeFallback`, for a melee-flagged map that ships no script at all.

**Order is the crux.** In WC3, `main()` runs `CreateAllUnits()` — every pre-placed creep, shop and gold
mine — *before* the init trigger fires. Ours arrive with their models, **asynchronously**. So:

1. `enableSeeding()` → `waitForMapUnits()`: block until `unitsReady` **and** the viewer's `promiseMap` is
   empty (every model resolved) **and** two more frames have run (`trySeed` adopts the stragglers). Waiting
   on "the unit list stopped growing" is *not* enough — a big map's models arrive in bursts, and the first
   lull fired the melee init early: on `(10)RagingStream` the start-location creeps didn't exist yet,
   survived `MeleeClearExcessUnits`, and then ate the starting workers (5 of 12 units left).
2. `runMapScript({ melee: true, … })` → `config()` → **the lobby handoff** → `main()`.

**The lobby handoff** (`Runtime.applyLobby`, between `config()` and `main()`): `config()` declares what the
*map* allows; the *lobby* decides who is actually PLAYING, as which race, on which team — and the melee
library gates on exactly that (`GetPlayerSlotState`, `GetPlayerRace`, both of which the map script cannot
know). An EMPTY slot gets no units, no purse, and keeps the creep camp on its start location.

**The record-only gate moved into the runtime.** `Runtime.recordOnlySpawnFns = {"CreateAllUnits"}` +
`spawnDepth` (bumped in `Interpreter.callUserG`): a `CreateUnit` *inside that call* records its row and
never reaches the engine (those units are already on the map, `.doo`-adopted), while everything else —
the melee roster, an init trigger's spawn — spawns for real. The old gate was "`main()` is running", which
would have swallowed the entire melee roster, since the Melee Init trigger runs inside `main()`.

Three things the bridge had to learn, each of which silently broke the melee library:

- **A gold mine is a unit.** `MeleeFindNearestMine` *enumerates units* and keeps the nearest `'ngol'` —
  that's how the workers end up clumped 320 units off the mine and (Night Elf) how the Tree of Life is
  planted **at the mine** rather than on the start location. Our sim keeps mines in their own table
  (`SimWorld.mines`, its own id space), so `enumUnits` presents them as unit snapshots under an offset id
  (`MINE_ID_BASE`), and `IsUnitType` answers **STRUCTURE** for them. Get that last part wrong and
  `MeleeClearExcessUnit` — which removes non-structure Neutral Passive units near a start location —
  **deletes every player's gold mine** (on most 2-player maps the mine is the *only* neutral within 1500 of
  the start). The Undead start goes further: `BlightGoldMineForPlayerBJ` **RemoveUnit's the mine** and asks
  for a haunted one; we don't model haunted mines, so `RemoveUnit` on a mine is a no-op and
  `CreateBlightedGoldmine` hands back the mine still standing there — otherwise the acolytes spawn around a
  null location at (0,0).
- **Neutral units have real player slots.** WC3's Neutral Hostile is **player 12** and Neutral Passive is
  **player 15** (common.j); our sim files both under owner −1 and distinguishes them with `neutralPassive`.
  `MeleeClearExcessUnit` removes a unit *only if its owner is one of those two*, so the translation now
  happens at the one place a sim unit becomes a JASS unit (`SimWorld.jassOwnerOf`, used by `eventInfo` +
  `enumUnits`). Custom maps get it for free: "spawn for Player 12" and creep-death triggers now match.
- **A dead unit still has a type.** Our sim drops a unit from `SimWorld.units` the instant it dies (it
  becomes a corpse), so `IsUnitType(GetDyingUnit(), UNIT_TYPE_STRUCTURE)` — the **first line** of
  `MeleeTriggerActionUnitDeath`, i.e. the gate on the whole defeat check — answered *"no, it's dead"*, and a
  player who lost their last building played on forever. `IsUnitType` now carries the unit's rawcode, and the
  bridge classifies a corpse from its **unit data** (`deadUnitTypeIs`).

Victory/defeat inputs are real, too: `GetPlayerStructureCount` / `GetPlayerTypedUnitCount` count the sim
(the latter matches **UnitUI.slk's `name`** column — "townhall", "greathall", "treeoflife", "necropolis" —
with `includeUpgrades` folding Keep/Castle back into "townhall": `MAIN_HALL_CHAINS`). Stub them at 0 and
blizzard.j's 2-second "has anyone already won or lost?" timer defeats *every* player two seconds in.

Verified (`pnpm jass:test` §7.3), running the **real** `(2)EchoIsles.w3x` `war3map.j` over the **real**
blizzard.j: `CreateAllUnits` records 107 pre-placed rows and spawns **none** (only the 12 melee units reach
the bridge — no doubled creeps); Human/Orc get 1 hall + 5 workers each, the hall on the start location and
the workers clumped 320u off the mine (the same geometry the old roster hard-coded); 500/150 for both playing
slots and **nothing** for the empty ones; the creeps + critters within 1500 of a used start location are
removed while the far camp, the shop and both gold mines stay; the clock is set to 08:00; the camera frames
the local player's workers; the 2s check defeats neither player; razing the town hall defeats its owner and
hands the opponent victory; Undead keeps its mine through the haunting; Night Elf plants the tree within 3.5
cells of the mine. Verified **live** on Echo Isles (all four races) and on `(10)RagingStream`, whose
start-location camp is cleared while the other eight starts keep theirs (screenshots).

Known gaps in the melee path (all inherited, none new): no **AI** (`StartMeleeAI` is a no-op, so a computer
slot sits still), no **hero-limit enforcement** (the caps are recorded, not applied), no **blight** under an
undead base, and the defeat/victory **dialogs** don't render (the dialog natives are no-ops) — the game state
flips correctly, it just doesn't say so on screen yet. *(The first hero's **Town Portal scroll** — the fourth
gap on this list until 7.18 — is now granted: `MeleeGrantItemsToHero`'s `UnitAddItemById` reaches a real item
system.)*

## Items (7.18 — done, live)

The last big *effect* gap: a trigger can now **create, give, drop, use and destroy an item**, and react
when one is picked up / dropped / used. Mostly a **bridge** milestone — the engine already had a real
item system (ground items, hero inventories, charges + cooldown groups, powerups consumed on pickup,
item behaviour dispatched off each granted ability's `code`, creep drop tables) — so this wires that
system to the script rather than building a new one.

**The one thing the sim was missing was identity.** In WC3 an item is **one entity that moves between
the ground and an inventory**, and a JASS `item` handle follows it across that move: `CreateItem` →
`UnitAddItem` → a PICKUP trigger's `GetManipulatedItem()` must all be the *same* item. Our `HeldItem`
had no id at all (a pickup built a fresh inventory record and threw the ground item away), so every
handle would have gone stale the moment a hero bent down. `HeldItem` now carries the ground item's
entity id (`SimItem.id == HeldItem.id`, one id space), preserved through pickup / give / drop / hero
death — and `Runtime.itemForSim` interns one handle per entity, exactly as `unitForSim` does for units.

- **`src/sim/world.ts`** — item identity (above) + the **trigger-effect item API** (`createItem`,
  `itemSnapshot` — the one lookup that answers "where is this item?" for ground *and* inventory —
  `removeItemById`, `setItemCharges`, `setItemPosition`, `unitAddItem`, `unitRemoveItem[FromSlot]`,
  `unitDropItemPoint/Slot/Target`, `unitUseItem`, `inventorySizeOf`, `itemInSlot`, `groundItems`) and
  the **item events** (`captureItems` + `noteItem` + `drainItemEvents`, the same capture-only-if-the-
  script-listens shape as 7.4c). Two semantics worth naming: a trigger's drop is **instant** (the
  player's drop order walks the hero to the spot first — `UnitDropItemPoint` does not), and
  `UnitDropItemSlot` **moves the item within the same inventory** (the GUI's "give item to slot") —
  despite the name, nothing is dropped.
- **`src/jass/natives/items.ts`** (new) — the natives, with the whole `…BJ` family riding on them for
  free (`UnitAddItemByIdSwapped`, `UnitDropItemPointLoc`, `GetItemLoc`, `GetInventoryIndexOfItemTypeBJ`,
  `UnitHasItemOfTypeBJ`, `CheckItemStatus`, `RandomItemInRectBJ`, `ChooseRandomItemExBJ`, and the
  `RandomDistReset`/`AddItem`/`Choose` distribution — all of it blizzard.j code we already interpret).
  `ChooseRandomItemEx` draws from the **same pool the creep drop tables use** (`droppable` +
  `pickRandom`, indexed by level in `ItemRegistry`), filtered by the `itemtype`↔`class` mapping
  (ITEM_TYPE_* order **is** ItemData.slk's `class` vocabulary; ANY = don't filter, level < 0 = any level).
  Per-instance flags WC3 keeps on the item that our sim doesn't model (visible / invulnerable /
  droppable / pawnable / user data) live on the handle — set and read back faithfully, but only the
  script observes them.
- **The events** (`Interpreter.pumpItemEvents`) — `EVENT_(PLAYER_)UNIT_PICKUP_ITEM` (49/86), `_DROP_ITEM`
  (48/85), `_USE_ITEM` (50/87), `_SELL_ITEM` (271/288), owner-matched, with `GetManipulatedItem` /
  `GetManipulatingUnit` (+ `GetSoldItem`/`GetBuyingUnit`). They're raised **where the item actually
  moves** in the sim, so a trigger's `UnitAddItem` and a hero walking over the item fire the same event,
  as in WC3. A hand-over raises **both** (the giver DROPs, the receiver PICKs UP), and USE is raised
  *after* the charge is spent — which is what the classic "give the charge back to make the item
  infinite" idiom (`SetItemCharges(GetManipulatedItem(), n+1)`) depends on. The item in the event is a
  **snapshot**: a tome is consumed the instant it's picked up and a potion's last charge destroys it, so
  the item may be gone by the time the event is drained — yet `GetItemTypeId(GetManipulatedItem())`, the
  line every "what did they pick up?" trigger opens with, must still work. Same problem, same answer as
  `GetDyingUnit`'s corpse.
- **Pre-placed items are now REAL items.** A map's items live in its **script** (`main()` →
  `CreateAllItems()` → `CreateItem`), and `war3mapUnits.doo` carries them too — the viewer rendered those
  as static scenery (its unit table is UnitData + UnitUI + **ItemData**), which is why a pre-placed item
  could never be picked up. The script now wins: its `CreateItem` spawns the one live, pickable item, and
  `rts.trySeed` hides the duplicate `.doo` widget (an item row has `itemid` where a unit row has `unitid`).
  Verified over the whole bundled corpus: **every** map with `.doo` item entries also ships
  `CreateAllItems()`, so deferring to the script never loses an item. (This is the mirror image of units,
  where the `.doo` widget wins and `CreateAllUnits` only records — 7.3.)
- **The melee leftover is closed**: `MeleeGrantItemsToHero` (blizzard.j's own) calls
  `UnitAddItemById(hero, 'stwp')`, which was a no-op — so the first hero trained never got its **Town
  Portal scroll**. It does now. (Its *behaviour* is still inert: the sim dispatches item actives off the
  ability `code`, and `AItp` isn't one it handles — the scroll sits in the pack, unused. Separate gap.)

Verified (`pnpm jass:test` §7.18), through the **real** blizzard.j BJs: `UnitAddItemByIdSwapped` puts a
`'phea'` in the hero's pack (`UnitHasItem`, 6 slots); `GetInventoryIndexOfItemTypeBJ` → slot 1 and
`UnitItemInSlot` returns **the same handle `CreateItem` did**; charges round-trip; `UnitDropItemSlotBJ`
*moves* the claws to slot 3 while `UnitAddItemToSlotById` into a **taken** slot fails and leaves no stray
item behind (the exact bug the test caught: a requested slot must be exact, not fall back to the first
free one); `UnitDropItemPointBJ` puts the item on the ground where asked and `EnumItemsInRect` finds it
there; `ChooseRandomItemEx` + the `RandomDist*` distribution pick from the pool. The four events dispatch
**owner-matched** (the other player's pickup trigger stays quiet), `GetManipulatedItem() == ` the item the
trigger created, and a consumed powerup still reports its type in the handler.

Verified **live** on Echo Isles: a trigger creates a Paladin and four items; `MeleeGrantItemsToHero` hands
him the Town Portal scroll (PICKUP fires); he **walks onto** the potion → *"PICKUP: Paladin picked up
Potion of Healing (charges 1, level 1)"* and the HUD inventory shows both; a trigger `UnitUseItem`s **the
same handle it created** → *"USE: … life is now 550"* (+250, potion consumed); a Tome of Experience is
consumed on pickup (XP 100/200) and Claws of Attack show a green **+15** on the damage line;
`UnitDropItemPointBJ` → *"DROP: Paladin dropped Claws of Attack +15"* (the +15 disappears) and
`ChooseRandomItemEx(level 5, PERMANENT)` rolls an Ancient Janggo onto the ground (screenshots). On
**Skibi's Castle TD** the two pre-placed **custom** (`.w3t`) items exist as live, modelled sim items; on
**ExtremeCandyWar** the map's own init trigger runs `EnumItemsInRectBJ(gg_rct_Cached_Units_and_Items,
RemoveItem)` — the classic "park items in a corner to preload them, then delete" idiom — and its 8
pre-placed items are created and then removed by the map itself, leaving the cache corner clean (before,
those `.doo` widgets sat there forever as undeletable scenery).

> **What items still can't do:** be **bought** — we have no shop purchasing, so nothing raises
> `SELL_ITEM` yet (the registration, responses and dispatch are wired and waiting for a purchase path).
> A ground item is also neither destructible nor hideable in the sim, so `SetItemVisible` /
> `SetItemInvulnerable` / `SetItemDropOnDeath` / `SetItemDropID` / `SetItemPlayer` are recorded on the
> handle rather than acted on.

## What's NOT done yet (next tasks — keep this list honest)

- **Custom destructable/upgrade/buff data** (optional) — the same mechanism for `war3map.w3b` (destructables,
  `War3MapW3u`), `.w3q` (upgrades, `War3MapW3d`), `.w3h` (buffs, `War3MapW3u`). Lower priority: only maps that create
  custom destructables (via `CreateDestructable`) / research custom upgrades need them. Units + abilities + items — the
  gameplay-critical trio — are done.
- **Custom-ability *behaviour*** — object data now gives a custom ability its real numbers, but only abilities whose base
  `code` is in `KNOWN_ABILITIES` (src/data/abilities.ts) actually *do* anything; an unknown base code loads as data but
  stays passive/uncastable (graceful, but inert).
- **Effect natives still missing.** 7.7 + 7.13 cover resources, unit-state and the unit-mutation set; 7.16 the group +
  filter/query surface; 7.17 abilities, heroes, flags and animation; 7.18 items. Still no-ops: **weather**
  (`AddWeatherEffect` returns a null handle; nothing renders rain/snow), **sounds**, **cameras/cinematics**, **upgrades**
  (`SetPlayerTechResearched`), **waygates**, **multiboards/dialogs**. Each is a small bridge method away — wire on demand
  (`pnpm jass:coverage` ranks them by how many maps call them).
- **Shops** — no unit sells anything, so `EVENT_PLAYER_UNIT_SELL_ITEM` / `_SELL` never fire (the item-sale plumbing is
  wired and waiting: §7.18) and blizzard.j's `MeleeGrantItemsToHiredHero` (a tavern hero) can't run. Needs a purchase
  path: shop stock (`AddItemToStock`), the buy command card, gold, range.
- **Events still missing:** `EVENT_PLAYER_UNIT_SUMMON` (the sim has the summon channel — same "born in the renderer"
  shape as TRAIN_FINISH), `..._RESEARCH_*` / `..._UPGRADE_*` (no upgrade system yet), `..._SELECTED`, `_SELL`/`_SELL_ITEM`
  (no shops — above), and the player-scoped `TriggerRegisterPlayerStateEvent` / chat events.
- **Melee leftovers** (7.3): melee AI (`StartMeleeAI`), hero-limit *enforcement*, blight, and the victory/defeat
  **dialogs** (the game state flips; nothing renders it). *(The first hero's Town Portal scroll is now granted — 7.18 —
  though `AItp` has no cast behaviour in the sim, so the scroll doesn't teleport yet.)*
- **Natives on demand** — weather, sound, cameras, cinematics (transmissions), multiboard, quests, gamecache.
  Use `pnpm jass:coverage` to prioritise (215/335 used natives implemented — and see the caveat on that number above).
- **Floating text rendering** — the `CreateTextTag` natives fully populate `runtime.textTags`, but nothing draws them
  in 3D yet (no world-space text pass). On-screen messages *are* rendered (HUD message log).
- **Lua** (`war3map.lua`, Reforged 1.31+) — only when we target that version.
