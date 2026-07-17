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
| 7.19 | **The trigger's on-screen output** — **floating text** in 3D (`CreateTextTag` + setters finally *draw*: world anchor + screen-relative drift, size, colour, fade, unit-following, fog-gated); the **victory/defeat dialogs** (`dialog` — which is what WC3's "Victory!" screen *is*: MeleeVictoryDialogBJ builds a plain dialog from the game's own `GlobalStrings.fdf` + `ScriptDialog.fdf`, quit button ends the match); **leaderboards** (the whole `Leaderboard*` family → the game's own `LeaderBoard.fdf` panel). Plus `DecorateFileNames` → `UI\war3skins.txt`, without which no in-game FDF panel has any chrome | ✅ done (live) | §7.19 headless (all three through the real blizzard.j BJs: `TextTagSize2Height`/`Speed2Velocity` scaling, permanence + expiry, `MeleeVictoryDialogBJ`/`MeleeDoDefeat` → "Victory!"/"You failed to achieve victory." + the right buttons + the QuestCompleted/QuestFailed stings, `LeaderboardResizeBJ`'s own sizing rule, sort-by-value); Echo Isles: "+15 gold" rising over each unit + a permanent banner, a **real Victory dialog when the enemy's last building is razed** (Continue Game dismisses, Quit Game ends the match), a 4-player leaderboard in the game's own chrome (screenshots) |
| 7.20 | **The trigger's AUDIO output** — the `sound` handle family (`CreateSound`(`FromLabel`/`FilenameWithLabel`), `SetSoundParamsFromLabel`, `SetSound{Duration,Channel,Pitch,Volume,Distances,ConeAngles,ConeOrientation,Position,DistanceCutoff}`, `StartSound`/`StopSound`/`AttachSoundToUnit`/`KillSoundWhenDone`/`GetSoundIsPlaying`) + every BJ riding on it (`PlaySoundBJ`/`AtPointBJ`/`OnUnitBJ`/`StartSoundForPlayerBJ`/`VolumeGroupSetVolumeBJ`…), the 8 **volume groups**, and **music** (`SetMapMusic`/`PlayMusic`/`PlayThematicMusic` — all three were explicit no-ops). Custom maps were silent apart from unit/combat sounds; melee had **no music at all** | ✅ done (live) | §7.20 headless (16 checks through the real blizzard.j BJs, resolving labels out of the **real** SoundInfo SLKs: params-not-file, the cross-table label namespace, `PercentToInt(pct,127)` volumes, the cone, the editor's `-1`/`4294967296.0` sentinels, the cine-mode group ducking); Echo Isles **live**: its own `SetMapMusic("Music", true, 0)` → the Human `Music_V1` playlist → `Human1.mp3` decoded (273 s) and playing; a trigger's `PlaySoundAtPointBJ` → a real PannerNode at the named world point (refDist 600 / maxDist 10000 from the SLK row), dropped when past its 3000 `DistanceCutoff`; an `AttachSoundToUnit`'d sound rides a marching peasant; blizzard.j's `PlaySound()` reaps its handle when the clip ends |
| 7.21 | **Timer dialogs — the countdown windows** (`CreateTimerDialog`/`SetTitle`/`SetTitleColor`/`SetTimeColor`/`SetSpeed`/`Display`/`IsDisplayed`/`SetRealTimeRemaining`/`Destroy`, + the `…BJ` family). Closes the last **melee leftover** on the list: `MeleeInitVictoryDefeat` builds the *crippled* window and the *finish-soon* window and both were silently discarded — so a player who lost their last main hall got no clock. Uncovered (and fixed) a **general timer-pump bug**: a handler that destroys a timer spliced `rt.timers` mid-`for…of`, making the pump **skip the next timer forever** — and blizzard.j's own `MarkGameStarted` does exactly that, 0.01 s into every map | ✅ done (live) | §7.21 headless (through the real BJs: `CreateTimerDialogBJ` shows it, a dialog reads its timer LIVE (45 → 32.5 s), `MeleeInitVictoryDefeat` builds 3 windows — the null-timer one + a cripple window per PLAYING slot, titled "Build Town Hall"/"Build Great Hall" off the game's own strings — and `MeleeCheckForCrippledPlayers` shows only the crippled player's, opening at 2:00 = `bj_MELEE_CRIPPLE_TIMEOUT`); §7.4c pins the timer-pump regression; Echo Isles **live**: razing player 0's hall (farm still standing → crippled, not defeated) pops blizzard.j's real *"Build Town Hall 1:48"* window + its own *"You will be revealed to your opponents…"* warning, and three windows stack under the leaderboard in the game's own chrome (screenshots) |
| 7.22 | **Vision, fog and the last panels** — **shared vision + alliances** (`SetPlayerAlliance`/`GetPlayerAlliance` over a real per-pair, per-setting matrix seeded from the lobby's teams; `CripplePlayer`), which finally lets blizzard.j's **`MeleeExposePlayer`** do what the 7.21 cripple timer promised; **BOTH fogs, which are different systems** — the atmospheric haze (`SetTerrainFogEx`/`ResetTerrainFog` → the `scene.distFog` shader) and the fog of war (`CreateFogModifier{Rect,Radius,RadiusLoc}`/`FogModifierStart`/`Stop`/`Destroy`, `SetFogState*`, `FogEnable`/`FogMaskEnable` → the `VisionMap`); **way gates** (`WaygateActivate`/`SetDestination`/`Get*`, a 400×400 box read out of the MPQ); **multiboards** (the grid scoreboard → the game's own `MultiBoard.fdf`). Plus the **record-only handle binding** that all of it turned out to need | ✅ done (live) | §7.22 headless (30 checks through the real blizzard.j BJs + the real `AllianceTable`/`VisionMap`: the matrix seeds from teams and is **directed**, `SetPlayerAllianceStateBJ` allies a pair, `MeleeExposePlayer` → `CripplePlayer` reveals the crippled player to exactly the players not co-allied with them; a fog modifier is created **stopped**, VISIBLE lights ground nobody can see and MASKED blacks out ground a unit stands in; `SetTerrainFogExBJ`'s 0–100 scale vs the native's 0–1; a gate fires on **entering** its box, not standing in it — the ping-pong regression; the multiboard BJ/native **axis swap** and the borrowed item handle). Echo Isles **live**: razing a crippled player's hall drains blizzard.j's clock → *"Revealing Player 2."* and their units show through black fog, while `ALLIANCE_SHARED_VISION` instead **lights the terrain**; Jack-o-Lantern's own green haze; a VISIBLE rect lit out in the unexplored middle of the map. CentaurGrove: a footman walks into the SW gate and comes out the NE one, 10 000 units away. Skibi's Castle TD: its **own** multiboard in the game's own chrome (screenshots) |
| 7.23 | **Weather — the map's atmosphere** (`AddWeatherEffect` / `EnableWeatherEffect` / `RemoveWeatherEffect`). The **biggest unimplemented family in the corpus — 40 of the 165 maps**, most of them plain MELEE maps, because the World Editor compiles a placed weather region straight into `CreateRegions()`. All three natives were explicit **no-ops**, so 40 maps ran with their rain and snow silently switched off. Not a model and not a shader: one **data-driven particle emitter** whose every parameter is a column of `TerrainArt\Weather.slk` (`src/data/weather.ts` + the `src/render/weather.ts` GL pass) | ✅ done (live) | §7.23 headless (14 checks against the **real** SLK through our **real** parser: all 21 types; the `particles == emrate × lifespan × 20` identity that pins the density; rain is a *tail* streak and snow a *head* billboard; `\|veloc\| × taillen` gives rain a 168-unit dash and moonlight a 3000-unit shaft from the same two columns; the 8×8 cloud atlas; the three-key ramps; created-disabled, and an unknown id doesn't crash the map). Live: Harrow's own heavy snow (4000 flakes, 126 fps), Forestwalk's slanted rain, WarChasers' moonlight shafts and red dungeon fog — all from those maps' own scripts (screenshots) |
| 7.24 | **Cameras and cinematics — the map's intro actually plays.** The **camera setups** (`CreateCameraSetup` / `CameraSetupSetField` / `CameraSetupSetDestPosition` — 10 maps each, the top of the ranking) and the whole move family they feed (`CameraSetupApply*`, `SetCameraField`, `PanCameraTo[Timed][WithZ]`, `SetCameraTargetController`, `SetCameraRotateMode`, `CameraSetTargetNoise`, `ResetToGameCamera`); **cinematic mode** (`CinematicModeBJ`, 7 maps — the letterbox out of the game's own `CinematicPanel.fdf`, `EnableUserControl`, the frozen day/night clock, the fixed random seed); the **fade** (`CinematicFadeBJ` — 9 maps — over the 7 `SetCineFilter*` natives); **transmissions** (`TransmissionFromUnit[Type]WithNameBJ` → `SetCinematicScene`: the speaker's animated bust, his name in his player colour, his subtitle); and **minimap pings**. Plus `SelectUnit`/`ClearSelection` and a real `SetRandomSeed`. Uncovered a 23-milestone-old bug: **every `mapcontrol` index was off by one**, so `GetPlayersByMapControl(MAP_CONTROL_USER)` — which Monolith wraps its whole intro in — returned an **empty force** | ✅ done (live) | §7.24 headless (24 checks through the real BJs + the real `ScriptCamera`: Monolith's own 7-field intro shot; a 2 s apply is exactly half-way at 1 s and then **lets go**; the degrees-in/**radians**-out asymmetry `GetCurrentCameraSetup` proves; `CinematicModeBJ`'s full checklist, and that it **restores what it saved** — a lying `IsFogEnabled` would switch a map's fog back on; the letterbox does **not** fade at map init (`bj_gameStarted`); `SetRandomSeed(0)` really replays the stream; a fade is alpha 0→255 and its mirror, and blizzard.j arms a timer to take it down; a transmission's 15 s = `bj_NOTHING_SOUND_DURATION` + the map's 10 s, portrait +1.5 s; the pure-red flashy ping knocked to 254; **and the shortest-arc gate**). Live: **(4)Monolith's own intro cinematic plays** — letterbox in, camera on `gg_cam_Monolith_Intro_Shot`, a 6 s drift home under a 6 s fade to black, then the game handed back (HUD, camera, fog, clock). WarChasers' Soul Keeper **transmits** with his bust in the game's own frame; pings pulse on the minimap (screenshots) |
| 7.25 | **The custom map's world must exist before its script runs.** Three bugs found by playing (4)WarChasers through the lobby, two of them one root: `startCustom` ran the map's script **before** seeding the pre-placed `.doo` units into the sim — the exact ordering 7.3 had already fixed for `startMelee` (WC3's `main()` calls `CreateAllUnits()` before `InitCustomTriggers()`), never carried across. So the script talked to an **empty world**: every `gg_unit_*` handle bound to nothing (**321** of them on WarChasers), and the enter-region baseline was seeded from nothing, so every pre-placed unit standing in a watched rect counted as **ENTERING** it. Plus a third, independent one: the **music channel** was claimed only *after* an mp3 finished decoding, so two starts inside one decode window both reached the speakers | ✅ done (live) | §7.25 headless (the **enum-index gate**: 418 common.j constants parsed as the oracle, every hard-coded index in `src/` re-derived from them — 40 name-identical constants + the `MAP_CONTROL`/`CAMERA_FIELD`/`JassFogState`/`AllianceType` tables — so `mapcontrol`'s 23-milestone off-by-one can never recur; and the **enter-region baseline**: a unit standing in a rect never fires it, a unit that crosses in fires it exactly once with the right `GetEnteringUnit`). WarChasers **live**: the camera rides the player's selector wisp (`camTarget == wispAt`, to the unit) and then his hero; **one** audible music track, not two; **zero** Neutral-Passive heroes (was two); the map's own forces put players 0/1/5/6 on one team, as its `InitCustomTeams` says. Echo Isles unregressed (screenshots) |
| 7.26 | **Special effects — the trigger puts a MODEL in the world** (`AddSpecialEffect`, `AddSpecialEffectLoc`, `AddSpecialEffectTarget`, `DestroyEffect` — issue #68). The whole family was unimplemented, so there was **no path at all** from a trigger to a model: every call fell back to the interpreter's typed default (a null `effect`) and the map ran on, quietly missing its art. Reported on (4)WarChasers, whose "Spawn One Monster" hangs `AnimateDeadTarget.mdl` off each monster it makes — but 11 of the 165 maps and ~200 call sites want this (Skibi's Castle TD and ExtremeCandyWar are largely built out of it), and `jass:coverage` **undercounts it** because most maps arrive through `AddSpecialEffectTargetUnitBJ`/`AddSpecialEffectLocBJ`. An `effect` is **persistent** — Birth → looping Stand → (`DestroyEffect`) Death — which is what separates it from the fire-and-forget spell art the sim already spawned: its lifetime is the **script's**, not a TTL. Reuses the buff-art machinery (7.17's `attachmentNode`), since an `effect` on a unit and a buff's `Targetart` are the same thing on screen | ✅ done (live) | §7.26 headless (10 checks through the **real** blizzard.j BJs: WarChasers' own trigger reaches the engine; the BJ's `(attach, widget, model)` → native's `(model, widget, attach)` **swap** Blizzard does; `"hand,left"` splits into the attach TOKENS the renderer matches against a model's `"<Tokens…> Ref"` nodes; `GetLastCreatedEffectBJ` hands back a real handle a later trigger destroys — and destroying it **twice**, or destroying `null`, is a no-op; headless mints null handles and runs on). WarChasers **live**: its own `AddSpecialEffectLocBJ(GetItemLoc(…), "…FrostArmorTarget.mdl")` frost-swirls the Sun Key on its pedestal and **settles into its looping Stand**; `AnimateDeadTarget` plants a green shaft on each spawned monster's origin, riding the unit's own node, and `DestroyEffect` takes all eight off (before/after screenshots). 20 effects live at map init that used to create nothing |
| 7.26b | **An effect runs on the GAME's clock, not the renderer's** (issue #68 follow-up). Found by playing: effects created in the **fog of war** queued up and turned up long afterwards, replaying their Birth the moment the player first looked. Not a fog bug — an mdx instance advances its own `frame` **only on the frames the scene draws it** (`ModelInstance.update` is gated on `rendered && isVisible(camera)`), so anything off-camera or hidden freezes at frame 0. So the effect's **`age`** is what decides its phase now (`src/render/specialFxClock.ts` — pure, hence headlessly testable), and that one rule answers the whole question: a **Birth-only** model (AnimateDeadTarget, and most spawn flourishes) is **SPENT** once its clip has run — over, whether or not anyone saw it, never drawn again — while a **persistent** one (a model with a `Stand`) settles into that Stand *in the fog* and is simply **already there** when the player arrives. Effects are also fog-gated now (they were visible through it), on the same live-sight rule the dropped items use | ✅ done (live) | §7.26b headless (7 checks on the phase rule: age drives the model frame, so a frozen effect resumes mid-flight rather than restarting; the spent boundary is exactly the end of the clip; a persistent effect at 60 s is STANDING, neither replaying nor vanishing; a model with **no** Birth is never spent — the trap that would blink every such effect out on creation). WarChasers **live** at `fog=unexplored`: 22 of its 23 init effects burn out unseen and **0** are shown even under a full reveal, while the Sun Key swirl is on the key, mid-Stand, the instant the camera arrives; effects created in sight still play their Birth on screen, `frame` tracking `age` to 14 ms (screenshots) |
| 7.5 | Native breadth + Lua/Reforged | ⬜ ongoing | `pnpm jass:coverage` (282/335 used natives implemented — and see the caveat: weather sat at a ✓ the whole time, and the special-effect family was a **floor-vs-census** case, see 7.26) |

Run the checks any time: **`pnpm jass:test`** (7.0–7.2 oracles + 7.3 melee-from-the-script + 7.4 timers + **7.4c the
timer-pump regression** + 7.5 text + 7.6 regions + 7.7/7.8/7.9 object data + 7.10/7.11 events + 7.12 effects + 7.13
unit-mutation effects + 7.14 orders + 7.15 threads/waits + 7.16 unit groups + 7.17 abilities/heroes/events + 7.18 items
+ 7.19 on-screen output + 7.20 audio + 7.21 timer dialogs + 7.22 vision/fog/waygates/multiboards + 7.23 weather +
7.24 cameras/cinematics + 7.25 the enum-index gate + enter-region baseline + 7.26 special effects + **7.26b the
effect clock**) and **`pnpm jass:coverage`** (unimplemented natives by usage).

> **Note on `jass:coverage`'s numbers.** It only counts natives called **directly** from a `war3map.j`, so everything
> a map reaches *through* a blizzard.j BJ — groups, `PolledWait`, the whole `PlaySound*BJ` family, and most of the
> multiboard and alliance surface — is invisible in the ranking. Treat it as a floor, not a census. 7.22 is the clearest
> case yet: `SetPlayerAlliance` sat in the ranking at **1 map** and carried a `✓` (it was an explicit no-op, and the
> tool detects an implementation by *name*, not by behaviour) — while the GUI's entire "Player - Make X treat Y as an
> Ally" family, which every co-op and team map uses, reaches it through `SetPlayerAllianceStateBJ` and was counted
> nowhere. A `✓` means "the name appears in `src/jass/natives/`", not "it works".
>
> It also detects an implementation by scanning `src/jass/natives/*.ts` for the native's name, and until 7.20 it
> looked only for a **quoted** one. That made it report `TriggerRegisterUnitEvent` — the single most-used native in
> the whole corpus, **157 maps** — as unimplemented, when in fact it is registered from an *unquoted table key*
> (`natives/events.ts`'s `REG_KINDS`): the #1 line of its own ranking was a false positive. The tool now recognises
> the bare-key form too, which is most of why "implemented" jumped 232 → 250.

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
  SetCameraBounds / SetDayNightModels   (we no-op — the renderer owns these)
  InitSounds() / SetMapMusic()  // REAL (7.20) — the map's sounds are built here, and SetMapMusic
                               //   starts the race's music playlist (it doesn't just record it)
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
| `natives/dialogs.ts` | **dialogs + the game-over path** (7.19): `DialogCreate`/`SetMessage`/`AddButton`/`AddQuitButton`/`Display`, the dialog-button events (`TriggerRegisterDialogButtonEvent` → `GetClickedButton`/`GetClickedDialog`), `EndGame`/`PauseGame`/`IsNo{Victory,Defeat}Cheat`, and `CreateSoundFromLabel`+`StartSound` (which is where the victory/defeat sting comes from). This is the melee **victory/defeat screen** — see 7.19 |
| `natives/leaderboard.ts` | **leaderboards** (7.19): the whole `Leaderboard*` family (create/display/assign-to-player, rows keyed by player, sort by value/player/label, style + colours) — the ~25 natives the entire GUI leaderboard surface rides on |
| `natives/timerdialog.ts` | **timer dialogs** (7.21): the countdown windows (`CreateTimerDialog` + its setters). A `timerdialog` holds **no clock** — it is a *view onto a `timer`*, read live each frame, which is why the melee library can build the window at init and start the timer two minutes later |
| `natives/vision.ts` | **alliances + BOTH fogs** (7.22). Three families that all answer *"what can a player see"*, kept in one file precisely because the thing most likely to go wrong is confusing the two fogs: **alliances** (`SetPlayerAlliance`/`GetPlayerAlliance`/`CripplePlayer` — a directed per-pair matrix, `src/sim/alliances.ts`), the **fog of war** (`CreateFogModifier*`/`FogModifierStart`/`Stop`/`Destroy`, `SetFogState*`, `FogEnable`/`FogMaskEnable` → the `VisionMap`), and the **terrain haze** (`SetTerrainFogEx`/`ResetTerrainFog` → `scene.distFog`), which is not fog of war at all |
| `natives/effects.ts` | **special effects** (7.26 — issue #68): `AddSpecialEffect[Loc]` / `AddSpecialEffectTarget` / `DestroyEffect` — the four natives that let a trigger put a MODEL in the world. An `effect` is **persistent** (Birth → looping Stand → Death on destroy), so unlike the sim's fire-and-forget spell art its lifetime belongs to the script — the handle is what a map holds on to and destroys a minute later. The renderer side (`MapViewerScene.specialFx`) shares the buff-art machinery, `attachmentNode` included: an `effect` on a unit **is** a buff's `Targetart` on screen, so it rides the unit's animated node the same way. **Not** the weather family next door, which is a particle emitter. Its phase lives in `src/render/specialFxClock.ts` — see 7.26b: an effect ages on the GAME's clock, because an mdx instance only animates on the frames the scene draws it |
| `natives/weather.ts` | **weather** (7.23): `AddWeatherEffect` / `EnableWeatherEffect` / `RemoveWeatherEffect` — the map's rain, snow, fog, light-rays and wind. Three natives in front of a particle emitter (`src/data/weather.ts` reads `TerrainArt\Weather.slk`; `src/render/weather.ts` draws it). Same "created, not started" shape as the fog modifiers: `AddWeatherEffect` leaves the effect **disabled**, and the editor emits `EnableWeatherEffect(we, true)` on the very next line |
| `natives/camera.ts` | **cameras** (7.24): the `camerasetup` handle (a saved SHOT — a bag of camera FIELDS plus a destination, which is what the World Editor's camera tool compiles to) and the whole move family that applies one — `CameraSetupApply*`, `SetCameraField`, `PanCameraTo*`, `SetCameraTargetController`, `SetCameraRotateMode`, `CameraSet*Noise`, `ResetToGameCamera`. There is **one** camera in WC3 and one here: an apply is a set of blends over the game camera (`src/render/scriptCamera.ts`). The units are asymmetric and blizzard.j proves it — every SETTER takes degrees, `GetCameraField` returns **radians** |
| `natives/cinematic.ts` | **cinematics** (7.24): everything the player sees around the shot — the letterbox (`ShowInterface`) + `EnableUserControl` + `EnableDawnDusk` + `SetGameSpeed` + a real `SetRandomSeed` (the checklist `CinematicModeBJ` fans out into), the **fade** (the 7 `SetCineFilter*` natives, committed by `DisplayCineFilter`), the **transmission** (`SetCinematicScene` — portrait + speaker + subtitle), and `PingMinimap[Ex]`. **No `…BJ` is registered here** — see the note under the coverage table |
| `natives/multiboard.ts` | **multiboards** (7.22): the grid scoreboard (`CreateMultiboard`, row/column counts, the `…Items…` plural setters and the `…Item…` singular ones). A cell is addressed **(row, column)** by the native and **(col, row)**, 1-based, by every BJ — Blizzard does the swap. A `multiboarditem` handle is **borrowed**, not owned (`MultiboardGetItem` … `MultiboardReleaseItem`), so it is a cursor into the board, never a copy of the cell |
| `natives/sound.ts` | **sounds + music** (7.20): the `sound` handle family (`CreateSound`/`FromLabel`, `SetSoundParamsFromLabel`, the `SetSound*` setters, `StartSound`/`StopSound`/`AttachSoundToUnit`/`KillSoundWhenDone`), the 8 `volumegroup`s, and the music interface (`SetMapMusic`/`PlayMusic`/`PlayThematicMusic`). A `sound` is a **configured playback object**, not a clip — the natives mostly mutate a `SoundObj`, and only Start/Stop reach the engine (`SoundBoard`) |
| `natives/melee.ts` | **what blizzard.j's `Melee*` library stands on** (7.3): `GetPlayerSlotState`/`GetPlayerRace` (in config.ts), `VersionGet`, `IsMapFlagSet`, `Set/GetFloatGameState` (the 08:00 clock), `SetCameraPosition`, the tech/hero caps, `GetPlayerStructureCount`/`GetPlayerTypedUnitCount` (who has lost), `GetResourceAmount`/`CreateBlightedGoldmine` (the gold-mine fiction) + explicit no-ops for what we don't model (AI scripts, blight, preloading) |
| `natives/region.ts` | **rects / regions / locations**: `Rect`(+ `gg_rct_*`), `GetRect*`, `CreateRegion`/`RegionAddRect`, `Location`/`GetLocationX/Y` — the geometry the enter/leave-region pump tests against (7.4b) |
| `natives/text.ts` | **text actions + logic** (7.6): on-screen messages (`DisplayText…`/`ClearTextMessages`), **floating text** (`CreateTextTag`…), names (`GetPlayerName`/`GetUnitName`/`GetObjectName`), `StringHash`, localization |
| `wts.ts` | `parseWts` — the map's `war3map.wts` trigger-string table (resolves `TRIGSTR_nnn` placeholders to authored text) |
| `natives/index.ts` | registry: enum constructors (`Convert*`) + utility natives (`I2S`, `GetRandomInt`, the MathAPI, env no-ops); calls the group registrars |
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

## The trigger's on-screen output (7.19 — done, live)

Everything a trigger *says* to the player used to go nowhere. Three surfaces, all now real.

### Floating text — the world-space text pass

`CreateTextTag` and its setters have filled `runtime.textTags` since 7.6; **nothing drew them**. Now
`src/render/textTags.ts` does — the "+15 gold" over a slain creep, the damage number, the "Creep Camp
Cleared" banner. Drawn as DOM over the canvas (crisp at any zoom, WC3 `|cAARRGGBB|` colour codes for free,
and a text tag has no depth anyway), projected each frame through the camera.

**A tag is a world ANCHOR plus a SCREEN-SPACE drift, and conflating the two is the whole trick.** `x/y/z`
are world coordinates — the tag sticks to that spot (or to a unit, `SetTextTagPosUnit`) and pans with the
camera. But `size` and the *velocity* are screen-relative, in the same 0.8×0.6 space the FDF UI uses.
Blizzard.j says so in as many words:

```jass
function TextTagSize2Height    takes real size  returns real  { return size  * 0.023 / 10  }
function TextTagSpeed2Velocity takes real speed returns real  { return speed * 0.071 / 128 }
    // "Scale the speed linearly such that speed 128 equates to 0.071.
    //  Screen-relative speeds are hard to grasp."
```

So a rising damage number climbs **the screen** at a steady rate; it does not travel north through the world
and shrink into the distance. Also nailed down from the sources:

- **A fresh tag is PERMANENT.** `CreateTextTag` alone hangs on screen forever — that's the well-known
  floating-text leak, and it's why every damage-number snippet in the wild opens with
  `SetTextTagPermanent(tt, false)` before setting a lifespan. We defaulted it to *false*, which would have
  made every tag vanish on the first tick.
- **Ageing/drift/expiry run on GAME time** (`Runtime.advanceTextTags`, pumped from `Interpreter.advanceTime`),
  so tags freeze with a paused game — while the *projection* runs on the render clock, so a paused tag stays
  pinned to its unit as the camera moves.
- **Fadepoint** (previously a no-op): full strength until `fadepoint`, then linear to nothing at `lifespan`.
- **Bottom-left anchored**, as the engine does — every "centre my damage number" snippet subtracts half its
  own width precisely because WC3 doesn't. Fogged tags are hidden with the ground.

### The victory / defeat dialogs

7.3 already flipped the melee end-state correctly (`bj_meleeDefeated` / `bj_meleeVictoried`), but the dialog
natives were no-ops, so **nothing said so on screen**. The fix is smaller than it looks, because
**WC3 has no bespoke "Victory!" panel — it is a plain JASS `dialog`**:

```jass
function MeleeVictoryDialogBJ takes player whichPlayer, boolean leftGame returns nothing
    local dialog d = DialogCreate()
    call DisplayTimedTextFromPlayer(whichPlayer, 0, 0, 60, GetLocalizedString("PLAYER_VICTORIOUS"))
    call DialogSetMessage( d, GetLocalizedString( "GAMEOVER_VICTORY_MSG" ) )          // "Victory!"
    call DialogAddButton( d, GetLocalizedString( "GAMEOVER_CONTINUE_GAME" ), … )
    call TriggerRegisterDialogButtonEvent( t, DialogAddQuitButton( d, true, GetLocalizedString( "GAMEOVER_QUIT_GAME" ), … ) )
    call DialogDisplay( whichPlayer, d, true )
    call StartSoundForPlayerBJ( whichPlayer, bj_victoryDialogSound )
endfunction
```

So implementing `dialog` faithfully renders the real end screen. What that took:

- **`GetLocalizedString` is a real lookup**, not identity. The screen is written entirely in the *game's* string
  keys — `GAMEOVER_VICTORY_MSG` → *"Victory!"*, `GAMEOVER_QUIT_GAME` → *"|CFFFFFFFFQ|Ruit Game"* — which live in
  `UI\FrameDef\GlobalStrings.fdf`, the file our FDF library already loads. `GetLocalizedHotkey` reads the
  accelerator out of that same markup (GlobalStrings marks it by colouring the letter white → `Q`).
- **`src/ui/gameDialog.ts`** builds it from the game's own `UI\FrameDef\UI\ScriptDialog.fdf`. Note the button is a
  *separate* top-level template (`ScriptDialogButton`), not a child — the engine stamps out one per
  `DialogAddButton` and stacks them inside, so we clone it per button (renaming the whole subtree: the layout
  solver indexes frames by name across the screen, so two buttons sharing a child name would collide).
- **Two behaviours belong to the ENGINE, not the script**, and blizzard.j quietly depends on it: any button click
  closes the dialog, and a `DialogAddQuitButton` button ends the game. That's why `MeleeVictoryDialogBJ` registers
  a trigger on its quit button and *never adds an action to it*. Both live in the UI layer (it owns the click),
  which then calls `Interpreter.fireDialogClick` to run whatever triggers the script *did* register.
- **The sting is real audio**: `bj_victoryDialogSound = CreateSoundFromLabel("QuestCompleted", …)` — a
  `UISounds.slk` label, so `StartSound` plays it through our `SoundBoard.playUi`. `StartSoundForPlayerBJ` gates on
  `GetLocalPlayer`, so another player's defeat is silent, as it should be.

### Leaderboards

The scoreboard every TD and AoS shows. Like the group family (7.16), the *whole* GUI surface is blizzard.j code we
already interpret — `CreateLeaderboardBJ`, `LeaderboardAddItemBJ`, `LeaderboardSortItemsBJ`,
`LeaderboardSetPlayerItemValueBJ`, `LeaderboardResizeBJ` — riding on ~25 natives that all did nothing. Two rules
read straight off Blizzard.j rather than guessed:

- a row is keyed by **player** (`LeaderboardAddItemBJ` removes that player's existing row first, and
  `LeaderboardSetPlayerItemValueBJ` looks the row up with `LeaderboardGetPlayerIndex`);
- `LeaderboardResizeBJ` sizes the board to its item count — **minus one when it has no label**. (Guessing "+1 for
  the title" would have left every titled board a row short; the test pins it.)

`src/ui/leaderboard.ts` mounts the game's own `UI\FrameDef\UI\LeaderBoard.fdf` frame and injects the rows into its
(deliberately empty) `LeaderboardListContainer` — the rows aren't in the file because the engine generates them.
Row colours are sampled from the game's own flat `ReplaceableTextures\TeamColor\TeamColorNN.blp` swatches, so it's
the real WC3 palette and not a hard-coded one.

### `DecorateFileNames` → `UI\war3skins.txt` (the gap this uncovered)

The leaderboard mounted with **no chrome at all**, and the reason turned out to be general: a frame flagged
`DecorateFileNames` names its textures by **skin KEY** (`BackdropBackground "EscMenuEditBoxBackground"`), not by
path, and the engine resolves the key through `UI\war3skins.txt`. We never read that file, so *every* in-game FDF
panel would have rendered as a transparent rectangle. `FdfLibrary.decorate` now parses it: `[Default]` carries the
full table (Human's art) and each race section overrides a handful — which is exactly how WC3 gives an Orc player
orc-bordered panels, so the overlays take the **local player's race** as their skin.

Verified (`pnpm jass:test` §7.19), all three through the **real** blizzard.j BJs: `CreateTextTagLocBJ` anchors at
(512, 256, z 90) with size 10 → height 0.023 and `SetTextTagVelocityBJ(64, 90°)` → screen velocity (0, 0.0355); a
fresh tag is permanent while a configured one drifts 0.0355/s, expires at its lifespan and leaves the permanent one
alone; `MeleeVictoryDialogBJ` → *"Victory!"* + "Continue Game"/"Quit Game" (quit flag + `doScoreScreen`), hotkey `Q`,
the `QuestCompleted` sting, and *"Elev was victorious."* through `DisplayTimedTextFromPlayer`'s `%s`; a click fires
only the trigger registered on **that** button; `MeleeDoDefeat` → `bj_meleeDefeated[1]` + *"You failed to achieve
victory."* with quit-only buttons (no observers-on-death flag), and another player's defeat plays no sound locally;
`CreateLeaderboardBJ` → a displayed board assigned to the whole force, `LeaderboardResizeBJ`'s items/items−1 rule,
and sort-by-value descending after a `SetPlayerItemValue`.

Verified **live** on Echo Isles: a trigger puts a rising `|cffffcc00+15 gold|r` over every unit (following them,
drifting up the screen, the permanent banner staying put) — and razing Player 1's last building runs blizzard.j's
own `MeleeCheckForLosersAndVictors`, which defeats them, declares Player 0 victorious and **renders the real
Victory dialog**; "Continue Game" dismisses it and the game plays on, "Quit Game" calls `EndGame` and tears the
match down. A 4-player `CreateLeaderboardBJ` board sits top-right in the game's own chrome, sorted by value, each
row in its player's real colour (screenshots).

> **What's still not on screen:** the **score screen** (`EndGame(true)` leaves the match rather than showing
> `Glue\ScoreScreen.fdf`). *(Timer dialogs render — 7.21; **multiboards** render — 7.22.)*

## The trigger's audio output — sounds + music (7.20 — done, live)

Everything a trigger *plays* used to go nowhere. Custom maps were silent apart from unit/combat sounds, and **melee
had no music at all**. This is a **bridge** milestone: `src/audio/sounds.ts` already had the hard parts (MPQ
Huffman+ADPCM decode, positional `PannerNode`s with WC3's MinDistance/MaxDistance/DistanceCutoff falloff, label
lookup over the `UI\SoundInfo` SLKs). What was missing was the JASS `sound` handle in front of it.

### A `sound` is a configured playback object, not a clip

This is the shape to get right, and it's unusual. A map builds each sound **once**, in `InitSounds()`, then Starts /
Stops / repositions *that same handle* all game:

```jass
set gg_snd_N03Tyrande01 = CreateSound("Sound\Dialogue\…\N03Tyrande01.mp3", false, false, false, 10, 10, "")
call SetSoundParamsFromLabel( gg_snd_N03Tyrande01, "N03Tyrande01" )   // ← DialogSounds.slk
call SetSoundDuration( gg_snd_N03Tyrande01, 14158 )
…later…  call PlaySoundAtPointBJ( gg_snd_N03Tyrande01, 100, loc, 0 )
```

So the natives mostly mutate a `SoundObj` record (`runtime.ts`); only `StartSound`/`StopSound` reach the engine.

**We need no `war3map.w3s` parser** — and that's a finding, not an assumption. Surveying all 165 bundled maps: **27
ship a `war3map.w3s`, and those same 27 (exactly) emit `CreateSound` in their `war3map.j`.** The `.w3s` is the World
Editor's *source*; the editor re-emits the sound definitions **as the script**. Same lesson as `.wtg`/`.wct` (7.0).

Three semantics read off the sources rather than guessed:

- **`SetSoundParamsFromLabel` sets PARAMS, never the FILE.** A label's row usually lists several variants
  (`HeroDeathKnightPissed` → six WAVs), but the map already picked exactly one in `CreateSound`
  (`…\DeathKnightPissed6.wav`) and must keep it. Only `CreateSoundFromLabel` — handed no file at all — takes the file
  from the row. Get this backwards and every map's hand-picked dialogue line becomes a random one of its siblings.
- **A label lives in ONE namespace spanning every SoundInfo table**, with nothing at the call site to say which:
  `"N03Tyrande01"` is `DialogSounds.slk`, `"HeroDeathKnightPissed"` is `UnitAckSounds.slk`, `"QuestCompleted"`
  (blizzard.j's victory sting) is `UISounds.slk`. `SoundBoard.labelParams` searches them all. (`EnvironmentSounds.slk`
  is *not* in the list — despite the name it's the EAX reverb config, keyed by `EnvironmentType`.)
- **`SetSoundDuration` is metadata, not a truncation.** The editor bakes the file's real length into the script
  (`14158` ms) and `GetSoundDuration` reads it back — it's how a cinematic waits out a line before starting the next.

Plus a real-data gotcha the test pins: the World Editor emits **`SetSoundVolume(snd, -1)` and
`SetSoundPitch(snd, 4294967296.0)`** for a sound left on its defaults (verbatim in the shipped
`(10)DustwallowKeys` `war3map.j`). Those are sentinels, not values — applying them would silence the sound and shift
it 4 billion semitones. Out-of-range writes keep the current setting.

### Music — `SetMapMusic("Music", true, 0)` names a PLAYLIST, not a file

Every one of the 165 maps calls `SetMapMusic` and only one ever calls `PlayMusic`, yet every melee game has music —
so **`SetMapMusic` starts the list**, it doesn't merely record it. And its `musicName` is a **skin key**, resolved
through **`UI\war3skins.txt`** — the same file `DecorateFileNames` reads (7.19), which is why the parse now lives in
one place (`src/data/war3skins.ts`, shared by `FdfLibrary` and `SoundBoard`):

```
[Human] Music_V1=Sound\Music\mp3Music\HumanX1.mp3;…\Human3.mp3;…\Human2.mp3;…\Human1.mp3
[Orc]   Music_V1=Sound\Music\mp3Music\OrcX1.mp3;…\Orc3.mp3;…\Orc2.mp3;…\Orc1.mp3
```

Keyed by the **local player's race** and the game version (`_V0` = RoC, `_V1` = TFT — we're 1.27a, so V1). That is
exactly how WC3 gives an Orc player orc music and a Human player human music, and it falls out of a table we already
parse.

### The volume groups, and what they prove

`VolumeGroupSetVolume` scales the eight `SOUND_VOLUMEGROUP_*` buses, which our pools now route through (deaths →
UNITSOUNDS, weapon clangs → COMBAT, casts → SPELLS, UI, ambience → AMBIENTSOUNDS, music → MUSIC). The mapping isn't
guesswork — blizzard.j's own `SetCineModeVolumeGroupsImmediateBJ` ducks **UNITSOUNDS and UI to 0.00** while holding
MUSIC at 0.55 and AMBIENTSOUNDS at 1.00 during a cinematic. It can only be doing that so the cinematic's own
*dialogue* stays audible — which tells us a script-created `sound` belongs to **none** of those groups. Ours doesn't
either.

### The autoplay gate (a bug only the live run could find)

`SetMapMusic` is cued from inside `main()` — long before the player has touched anything — so on a cold load the
browser's autoplay policy still has the `AudioContext` **suspended** and the track cannot start. The cue had already
happened and nothing ever retried it: **the music was simply lost.** `SoundBoard.unlock()` now re-cues a pending
playlist once the context resumes, so the music survives the gate and starts on the first gesture. Caught only by
driving the real app (`ctx: "suspended"`, `musicPlaying: false` with a perfectly-resolved playlist sitting there).

Verified (`pnpm jass:test` §7.20), 16 checks through the **real** blizzard.j BJs, resolving labels out of the **real**
extracted SoundInfo SLKs: `SetSoundParamsFromLabel` keeps the script's own file but takes volume 127 / WANT3D /
MinDistance 3000 / MaxDistance 10000 from the actual `UnitAckSounds` row, while `CreateSoundFromLabel` pulls its file
+ volume 120 out of `DialogSounds` (the cross-table namespace); `GetSoundDurationBJ` → 3.385 s; `PlaySoundAtPointBJ`
(100 %) → position (512, 256) + volume 127 and `bj_lastPlayedSound` set; `PlaySoundOnUnitBJ` (50 %) → attached, played
at the unit's **live** position, volume 63 (`PercentToInt(50, 127)`); `GetSoundIsPlaying` true→false across
Start/Stop; the editor's sentinels rejected; a 3D sound's distances/cutoff/cone (45°, outside volume 20 % → 25) reach
the engine; blizzard.j's `PlaySound()` → Create + Start + KillSoundWhenDone and the handle is reaped; the music BJs
arrive in order; `SetCineModeVolumeGroupsImmediateBJ` ducks all eight groups to Blizzard's values.

Verified **live** on Echo Isles (driven through the actual `EngineHooks`): the map's own
`SetMapMusic("Music", true, 0)` resolves to the **Human `Music_V1`** playlist and `Human1.mp3` decodes (a real 273-second
AudioBuffer) and plays; `labelParams` resolves `QuestCompleted` / `HeroDeathKnightPissed` / `N03Tyrande01` /
`RoosterSound` out of **four different** SoundInfo tables; a trigger's `PlaySoundAtPointBJ` builds a real `PannerNode`
at exactly the world point it named, with `refDistance 600` / `maxDistance 10000` off the SLK row — and is **dropped**
when the listener is 8376 units away, past its 3000 `DistanceCutoff`; an `AttachSoundToUnit`'d looping sound rides a
marching peasant (panner tracking to `(-4814, 3314, 631)`, z = the terrain under it); and blizzard.j's `PlaySound()`
frees its handle the moment the clip ends.

> **Ear-proxy honesty.** Audio can't be screenshotted, so everything above is asserted *quantitatively* through
> `agent-browser eval` — the resolved file path, a genuinely decoded `AudioBuffer` (duration / sample rate /
> channels), the `PannerNode`'s world position and falloff, the gain, and the live `AudioContext` state. What I have
> **not** confirmed is how it *sounds* — mix balance, whether the music sits at the right level under combat, and
> whether our fixed fade ramp feels like WC3's. `CreateSound`'s `fadeInRate`/`fadeOutRate` (10 in every
> editor-emitted sound, 12700 in blizzard.j's `PlaySound`) are in units **no file we have documents**, so rather than
> invent a rate→seconds curve we ramp over a short fixed time and say so here.

**Still not modelled** (recorded on the handle, read back faithfully, but nothing acts on them): the **EAX/reverb**
environment (`NewSoundEnvironment`, the `"DefaultEAXON"`/`"HeroAcksEAX"` presets), the **mixing channel**
(`SetSoundChannel` — WC3's preemption/priority rules; we cap concurrency per pool instead), **seeking**
(`SetSoundPlayPosition` / `SetMusicPlayPosition`), **Doppler** (`SetSoundVelocity`), **stacked sounds**
(`RegisterStackedSound`), and **MIDI** ambience (`CreateMIDISound` / `SetAmbientDaySound` hand back a working handle
that has no file, so a script that configures one still runs).

## Timer dialogs — the countdown windows (7.21 — done, live)

The little panel WC3 hangs top-right: *"Build Town Hall  1:59"*, *"Next Level  0:23"*. Every TD and AoS puts one
up — and the reason this is a **melee leftover** rather than a custom-map nicety is that **blizzard.j's own melee
library builds two of them and we were throwing both away**:

```jass
// MeleeInitVictoryDefeat (Scripts\Blizzard.j)
set bj_finishSoonTimerDialog = CreateTimerDialog(null)          // the tournament "finish soon" window
…per PLAYING slot…
set bj_crippledTimer[index]        = CreateTimer()
set bj_crippledTimerWindows[index] = CreateTimerDialog(bj_crippledTimer[index])
call TimerDialogSetTitle(bj_crippledTimerWindows[index], MeleeGetCrippledTimerMessage(indexPlayer))
```

The **crippled** window is a real melee rule the engine already *computed* and never showed: lose your last main hall
while you still hold other structures and blizzard.j starts a **120 s** clock (`bj_MELEE_CRIPPLE_TIMEOUT`) — build a
new hall before it drains or you are **revealed to every opponent**. `MeleeCheckForCrippledPlayers` has been running
here since 7.3 (it rides the death / construct-cancel / construct-finish events, and its structure counts came in with
the melee milestone), so the *state* was right; the player just could not see the clock ticking.

Two shapes, both read off the sources:

- **A `timerdialog` holds no clock.** It is a **view onto a `timer`** — the engine reads that timer's remaining every
  frame. That is why `CreateTimerDialog` *takes* the timer, and why the melee library can create the window at map
  init and only `TimerStart` it two minutes into the game. So the panel polls; nothing is ever pushed.
- **A dialog over a NULL timer is legal**, and blizzard.j depends on it — `CreateTimerDialog(null)`, commented in
  Blizzard's own source as *"it has no timer because it is driven by real time (outside of the game state to avoid
  desyncs)"*. It shows whatever `TimerDialogSetRealTimeRemaining` last put in it, and must not crash on the null.

### The timer-pump bug this uncovered (general — not a timer-dialog bug)

`Interpreter.advanceTime` iterated `rt.timers` with a live `for…of` **while an expiring timer's handler can mutate that
array**. The one-shot idiom is `DestroyTimer(GetExpiredTimer())`, and `DestroyTimer` **splices** the list — which makes
the iterator **skip the very next element**. So the timer registered right after a self-destroying one silently lost
that tick.

It is not hypothetical: **blizzard.j's own `MarkGameStarted` destroys `bj_gameStartedTimer` from inside its handler,
0.01 s into every map** — so the next timer any map created after `InitBlizzard` never advanced again. `advanceTime`
now iterates a snapshot (`DestroyTimer` clears `running` before it splices, so the existing guard still drops anything
removed mid-pump). Pinned by its own regression gate, **§7.4c**.

### The panel

`src/ui/timerDialog.ts` mounts the game's own `UI\FrameDef\UI\TimerDialog.fdf` — unlike the leaderboard it needs
nothing injected (the title and the time are already TEXT frames in the file), so we only override their strings. What
the file can't say and the game decides at runtime: **where** it sits (the frame carries no `SetPoint`; WC3 puts it
top-right, and we hang it below the leaderboard when there is one, so the two never overlap) and that there can be
**several** — a map can show a wave timer and a revive timer at once, so the frame is cloned per displayed dialog and
stacked.

The same **unsized-TEXT-frame** trap the leaderboard hit bit again, and only the live run showed it: the FDF sizes the
title purely by *two opposing anchors* (`SetPoint LEFT, "TimerDialogBackdrop"` + `SetPoint RIGHT, "TimerDialogValue"`),
which our layout solver derives no width from — so the title collapsed to a 0×0 box and **never drew**, while the value
(which declares `Width 0.06`) rendered fine. The first live screenshot was a window counting down `1:43` with nothing
beside it.

Verified (`pnpm jass:test` §7.21), through the **real** blizzard.j BJs: `CreateTimerDialogBJ` → a *displayed* window
(the BJ shows it; the native alone does not) and `IsTimerDialogDisplayed` agrees; the window reads **45 s** off its
timer and **32.5 s** after 12.5 s of game time (live, not a copy); `MeleeInitVictoryDefeat` builds exactly **3**
windows — the null-timer "finish soon" one plus a cripple window for each of the 2 PLAYING slots, titled *"Build Town
Hall"* (human) / *"Build Great Hall"* (orc) from the game's own strings — and **none** is on screen at init;
`MeleeCheckForCrippledPlayers` then shows **only** the crippled player's, opening at **2:00** (`bj_MELEE_CRIPPLE_TIMEOUT`)
and ticking to 0:59 after 61 s, with `bj_playerIsCrippled[0]` set and `[1]` clear.

Verified **live** on Echo Isles: the map's own script builds all 3 windows at init; giving player 0 a farm and then
razing their town hall (so they are *crippled*, not *defeated*) pops blizzard.j's real **"Build Town Hall  1:48"**
window together with its own *"You will be revealed to your opponents unless you build a Town Hall."* warning in the
HUD, while player 1's window stays hidden; and three windows stack neatly below the leaderboard in the game's own
chrome (screenshots).

> **The one thing NOT ground-truthed: the countdown's exact format.** `Game.dll` carries exactly two countdown
> `printf` formats — `%d:%02d` and `%02d:%02d:%02d` — so we render `1:59` under an hour and `01:02:03` at or over one.
> That is an *inference from the binary's strings*, not a measurement in the running client, and it's the kind of
> detail CLAUDE.md says to measure. To settle it: load `(10)Skibi'sCastleTD.w3x` (or `(4)Monolith.w3x`) in the real
> game — both display a timer window — and read it off the screen.

**Not modelled:** `TimerDialogSetSpeed` scales the readout but the engine's own preemption/priority rules around it
aren't simulated. *(**`MeleeExposePlayer`** — what the cripple timer* does *when it drains — was the other gap here, and
it is closed: 7.22.)*

## Vision, fog and the last panels (7.22 — done, live)

Four gaps that are each a small bridge onto an engine we already have — and one shared discovery that all of them
needed.

### Shared vision + alliances — `SetPlayerAlliance` / `CripplePlayer`

WC3 does **not** keep a team number. It keeps a per-**pair**, per-**setting**, **directed** alliance matrix (common.j's
ten `alliancetype`s: PASSIVE, SHARED_XP, SHARED_VISION, SHARED_CONTROL, …). `SetPlayerAlliance(A, B, …)` says what A
grants B, and the two directions are independent — which is exactly why blizzard.j's own co-ally test reads **both**:

```jass
function PlayersAreCoAllied takes player playerA, player playerB returns boolean
    if (playerA == playerB) then
        return true
    endif
    if GetPlayerAlliance(playerA, playerB, ALLIANCE_PASSIVE) then
        if GetPlayerAlliance(playerB, playerA, ALLIANCE_PASSIVE) then
            return true          // both ways, or you aren't allies
        endif
    endif
    return false
endfunction
```

**`src/sim/alliances.ts`** is that matrix, **seeded from the lobby's teams** (team-mates are mutually passive and share
vision) so a melee game behaves exactly as it did when allegiance was a plain `teamOf(a) === teamOf(b)` — and a script
can then change any pair from under it. It is now the source of truth for three things that used to read the team
directly: `GetPlayerAlliance` / `IsPlayerAlly`, the sim's own `hostile()`/`allied()` (via a `SimWorld.alliedPlayers`
injection, in the same style as `visibleToTeam`/`lineOfSight` — so *"Player - Make X treat Y as an Ally"* actually stops
them fighting), and the fog.

Two things the fog now reads, and they are **different systems that look alike**:

- **`ALLIANCE_SHARED_VISION`** lends you a player's **sight**: their units reveal *your* fog (`RtsController
  .revealsForLocal`). The terrain lights up.
- **`CripplePlayer(whichPlayer, toWhichPlayers, flag)`** reveals that player's **units** *to* you, wherever they stand
  (`RtsController.exposed`, checked in `fogHides`). The units show; the **ground stays black**.

**This is what the 7.21 cripple timer was missing.** `MeleeInitVictoryDefeat` built the *"Build Town Hall 1:59"* window
and `MeleeCheckForCrippledPlayers` started its clock — and when it drained, blizzard.j's `MeleeExposePlayer` called a
`CripplePlayer` that did nothing, so the message printed and the player was never revealed. It is real now:

```jass
function MeleeExposePlayer takes player whichPlayer, boolean expose returns nothing
    local force toExposeTo = CreateForce()
    call CripplePlayer( whichPlayer, toExposeTo, false )        // clear any previous exposure…
    set bj_playerIsExposed[GetPlayerId(whichPlayer)] = expose
    loop                                                        // …build the force of everyone NOT co-allied…
        if (not PlayersAreCoAllied(whichPlayer, indexPlayer)) then
            call ForceAddPlayer( toExposeTo, indexPlayer )
        endif
        …
    endloop
    call CripplePlayer( whichPlayer, toExposeTo, expose )       // …and reveal them to it
endfunction
```

> **The stub that was worse than a missing native.** `SetPlayerAllianceStateBJ` was registered as a **native no-op** —
> but it is not a native at all, it is a blizzard.j **function**, and the interpreter resolves natives *before* user
> functions. So the stub **shadowed Blizzard's own code** and silently swallowed the entire GUI alliance surface (the
> whole *"Player - Make X treat Y as an Ally"* family is nothing but that BJ fanning out into `SetPlayerAlliance`).
> Never register a `…BJ` name as a native unless you mean to replace blizzard.j's version of it.

### The two fogs — and they are not the same thing

`SetTerrainFogEx` was the **#1 unimplemented native** in the corpus ranking (14 maps), and it is **not fog of war**. It
is the **atmospheric distance haze** — `scene.distFog`, the shader we already had (`src/render/fog.ts`, driven from the
map's w3i). So this was a bridge, not a new system. The corpus settled the one open question outright: **all 12
`SetTerrainFogEx` calls across the 165 maps pass style `0` (linear)** — which is exactly what our shader does. (`density`
only bites on the exponential styles, which is why those same maps happily pass anything from `0.0` to `16.9` for it and
it never mattered.) `ResetTerrainFog` restores the map's **own w3i** fog, not "no fog".

`SetTerrainFog` itself — five reals Blizzard did not even name in common.j, documented nowhere, and called by **no map in
the corpus** — stays an explicit no-op rather than a guessed mapping onto our shader.

The **fog of war** half is the `VisionMap`. A fog modifier holds an area at a `fogstate` for one player:

- **`FOG_OF_WAR_VISIBLE`** lights ground nobody stands near — how a TD shows you its whole maze.
- **`FOG_OF_WAR_FOGGED`** drops it to explored grey.
- **`FOG_OF_WAR_MASKED`** blacks out ground you are **standing in** — a cinematic area. This one only works because
  MASKED **clears `explored`**, the one layer that is otherwise write-once.

Modifiers are stamped **last**, over everything the units revealed, on every vision rebuild. And the crux, which the
BJ has to paper over and a naive reading of common.j misses: **`CreateFogModifier*` does not start the modifier.**

```jass
function CreateFogModifierRectBJ takes boolean enabled, player whichPlayer, fogstate whichFogState, rect r returns fogmodifier
    set bj_lastCreatedFogModifier = CreateFogModifierRect(whichPlayer, whichFogState, r, true, false)
    if enabled then
        call FogModifierStart(bj_lastCreatedFogModifier)     // ← the BJ starts it; the native hands back a STOPPED one
    endif
    return bj_lastCreatedFogModifier
endfunction
```

(The same *"the BJ shows it, the native doesn't"* shape as `CreateTimerDialogBJ` in 7.21.) `FogEnable` and
`FogMaskEnable` are the two **separate** global switches — the grey "can't see it now" veil and the black "never been
here" mask — and blizzard.j gives each its own On/Off pair precisely because they are not one switch.

### Way gates

A Way Gate (`'nwgt'`) teleports anything entering it to a destination point. Seven of the eleven maps that use one are
plain **melee** maps (CentaurGrove, WindyWaste, Riverrun, Plaguelands, IceCrown, MysticIsles, Venetia) — the gate is a
map feature, not a custom-map gadget.

**The trigger volume is not a guess.** The Way Gate carries ability `Awrp` (`UnitAbilities.slk`: `abilList=Awrp,Avul`),
and `Awrp`'s `DataA1`/`DataB1` are `400`/`400` — which `AbilityMetaData.slk` + `WorldEditStrings.txt` name **"Teleport
Area Width"** and **"Teleport Area Height"**. So the gate is a **400×400 box**, not a circle.

> **A gate fires on ENTERING its box, not on standing in it** — and this is the whole behaviour, not a nicety. A gate's
> destination *is its partner gate*, so the traveller lands **inside the partner's box**. Fire on occupancy and the
> partner throws it straight back, the first gate throws it forward again, and it ping-pongs forever. That is not
> hypothetical: it is what the first implementation did, measured live on `(4)CentaurGrove` — the footman bounced SW↔NE
> **every tick** and never arrived. So each gate keeps the set of units already inside it and diffs against it, exactly
> as the enter-region pump keeps its baseline (7.4b); a unit deposited inside a gate is seeded as already-there, and only
> crosses again once it leaves and walks back in. Pinned by a multi-tick check in §7.22.

### The discovery all four needed: a record-only handle points at nothing

`CreateAllUnits()` is **record-only** for us — those units came in from `war3mapUnits.doo` and are *adopted*, not spawned
(7.3) — so `CreateUnit` inside it recorded a row and handed back a handle with `simId = -1`. But the script goes right on
**configuring that handle**:

```jass
set u = CreateUnit( p, 'nwgt', -3840.0, -3840.0, 270.000 )                        // (4)CentaurGrove, verbatim
call WaygateSetDestination( u, GetRectCenterX(gg_rct_NE_Waygate), GetRectCenterY(gg_rct_NE_Waygate) )
call WaygateActivate( u, true )
```

Every one of those calls was landing on a handle with no unit behind it. The units all **exist** by the time the script
runs (`startMelee` waits for every model first — 7.3), so `EngineHooks.findPlacedUnit(typeId, x, y)` now binds the
record-only handle to the unit already standing there (matched by type + position; the script and the `.doo` are two
encodings of one placement). Waygates are impossible without it — and it also quietly fixes `SetResourceAmount` on a
pre-placed gold mine and `SetUnitColor` on a pre-placed tavern.

### Multiboards

**Be honest about the priority:** only 4 of the 165 bundled maps create one. It earns its place because it is what DotA
and the whole modern custom-map ecosystem puts on screen, and because `UI\FrameDef\UI\MultiBoard.fdf` was sitting right
next to the `LeaderBoard.fdf` we already mount. Where a leaderboard (7.19) is rows keyed by **player**, each holding one
**number**, a multiboard is a free-form **grid of string cells**. Two shapes read off Blizzard.j rather than guessed:

- **The BJ and the native take the axes in opposite orders.** The native is `MultiboardGetItem(mb, row, column)`,
  **0-based**; every BJ that fronts it is `MultiboardSetItemValueBJ(mb, col, row, val)`, **1-based**, and loops
  `MultiboardGetItem(mb, curRow - 1, curCol - 1)` (with 0 meaning "every row"/"every column"). Swap them and a script
  writes down the wrong axis — and on a square board it would silently transpose rather than fail.
- **A `multiboarditem` handle is BORROWED, not owned.** Every BJ pairs `MultiboardGetItem` with `MultiboardReleaseItem`,
  so the handle is a **cursor into the board**, never a copy of the cell; a write through a released one is a no-op.

`src/ui/multiboard.ts` mounts the game's own frame and injects the cells into its (deliberately empty)
`MultiboardListContainer`. The same **unsized-frame trap** the leaderboard and the timer dialog both hit bit a third
time, and worse: `MultiboardTitleBackdrop` carries a **`SetAllPoints`** — *after* its two `SetPoint`s — and the parent it
would fill is the root frame, which in this file is the **0.024 minimize-button square**. Left in, the title band pins
itself to that square and the title wraps inside a 24-thousandth-wide box. (The FDF's root is the *button*, not the
board: the title hangs off its left edge and the body off its bottom, so the panel grows out of that one square and both
of its dimensions are the engine's to decide.)

### Verified

Headless (`pnpm jass:test` §7.22), 30 checks through the **real** blizzard.j BJs — and, where the semantics actually
live, against the **real** engine classes (`AllianceTable`, `VisionMap`) rather than a mock that would only agree with
itself: the matrix seeds from the lobby's teams and is **directed** (0 un-allies 2 → not co-allied, though 2 still grants
0 PASSIVE); `SetPlayerAllianceStateBJ(bj_ALLIANCE_ALLIED_VISION)` allies a pair *and* grants shared vision;
`MeleeExposePlayer` → `CripplePlayer` reveals the crippled player to exactly the players **not co-allied** with them (and
sets `bj_playerIsExposed`), and un-exposes them again. A fog modifier is created **stopped**; started, VISIBLE lights
ground no unit can see and MASKED blacks out ground a unit is standing in; stopping the reveal falls back to Explored
grey (it *was* seen); `FogEnableOff` + `FogMaskEnableOff` are two separate layers. `SetTerrainFogEx` takes rgb in 0–1
while `SetTerrainFogExBJ`'s 0–100 is divided by 100 on the way in; `ResetTerrainFog` restores the w3i's own fog. A gate
teleports on **entry**, **stays put over 5 more ticks** (the ping-pong gate), re-arms when the traveller leaves, ignores
a unit 250 units out (the box's half-extent is 200), and does nothing when deactivated — and a record-only `CreateUnit`
binds to the pre-placed unit (`simId 1`, not −1). The multiboard's BJ/native **axis swap** lands "Kills" in (row 4,
col 1) from `(col 2, row 5)`, and a write through a **released** item handle is a no-op.

Verified **live**: on Echo Isles, giving orc player 1 a burrow and razing their Great Hall crippled them (blizzard.j's
own `bj_playerIsCrippled[1]`, its *"Build Great Hall"* clock ticking); draining that clock printed Blizzard's own
**"Revealing Player 2."** and their five peons + burrow rendered **through pitch-black fog** — while granting
`ALLIANCE_SHARED_VISION` instead **lit the terrain** at the identical spot (the two systems, side by side). Jack-o-
Lantern's own `SetTerrainFogEx(0, 1000, 5000, 0, 0.000, 0.502, 0.000)` turned the horizon green and SavageStorm's turned
it cold; `ResetTerrainFog` put it back. A `FOG_OF_WAR_VISIBLE` rect lit a sharp island of terrain (creeps and all, on the
minimap too) out in the unexplored middle of the map, while created-but-not-started it did nothing at all. On
`(4)CentaurGrove` the map's **own** script built both waygates, pointed them at each other and activated them, and a
footman ordered into the SW gate came out at the NE one ~10 000 units away **and stayed there**. On `(10)Skibi'sCastleTD`
its **own** `Trig_Multiboard_Create_Actions` built its real board — *"- Wave 0 of 45"*, *"West Lives - 30"*, its icons,
and its own column widths (11.50/4.50/4.50 → 0.115/0.045/0.045 through the BJ's ÷100) — in the game's own chrome
(screenshots).

## Weather — the map's atmosphere (7.23 — done, live)

The **biggest unimplemented family in the corpus**, and it had been hiding in plain sight: **40 of the 165 bundled
maps** call `AddWeatherEffect`, most of them plain **melee** maps, because the World Editor compiles a placed
"weather effect" region straight into the map's own script —

```jass
set we = AddWeatherEffect( gg_rct_Region_000, 'SNls' )   // (6)UpperKingdom, verbatim
call EnableWeatherEffect( we, true )
```

— inside `CreateRegions()`. All three natives were **explicit no-ops**, so forty maps have been running with their
rain and snow silently switched off.

> **It never showed in the ranking, and that is the coverage caveat biting a third time.** `AddWeatherEffect` was
> registered as a no-op, so `jass:coverage` — which detects an implementation by *name* — printed it with a `✓`. The
> honest #1 was invisible behind a tick. (Same shape as `SetPlayerAlliance` in 7.22.)

### It's a particle emitter, and the table IS the emitter

Weather is not a model and not a shader. Every parameter lives in `TerrainArt\Weather.slk`: emission height, tilt,
speed, lifespan, the streak length, the sprite atlas, and three-key colour/alpha/scale ramps. Twenty-one rows cover
five shapes, all from the one emitter:

| | id | texture | drawn as |
|---|---|---|---|
| rain | `RAhr` `RAlr` `RLhr` `RLlr` | `rainTail` | **tail** — a quad stretched along its velocity |
| snow | `SNbs` `SNhs` `SNls` | `snow` | **head** — a camera-facing billboard |
| fog | `FDbh` `FDbl` `FDgh` … | `CloudSingleFlat` | **head** — big, slow, near-transparent clouds |
| rays | `LRaa` `LRma` | `RaysOfLight` | **tail** — long shafts of light |
| wind | `WNcw` `WOcw` `WOlw` | `clouds8x8` | **head**, over an 8×8 sprite **atlas** |

Two readings fall out of the table and do a lot of work:

- **A tail's length is `|veloc| × taillen`.** The same two columns give rain a 168-unit dash (1200 × 0.14) and
  moonlight a **3000-unit shaft** (300 × 10). Rain and a moonbeam are the same primitive.
- **`particles` is a DERIVED column** — and this is what settles the density, which the table otherwise never states.
  It gives both an emission rate and a particle count, and they are not independent:

  ```
  particles == emrate × lifespan × 20      — EXACTLY, for all 21 rows, without exception
  ```

  (heavy rain 100 × 0.9 × 20 = 1800; light snow 8 × 5 × 20 = 800; moonlight 0.9 × 3 × 20 = 54.) So `particles` is
  simply the **steady-state population** of an emitter running at `emrate` over a fixed 20-cell grid — the two columns
  encode one number. We take `particles` as the live-particle budget and derive the rate from it, which reproduces
  exactly the density the table intends without having to guess what an "emitter cell" is. **§7.23 pins the identity**:
  if it ever stops holding, the density model is wrong and the test says so.

### The emitter follows the camera, inside the rect

`AddWeatherEffect` bounds an effect to a rect and most maps hand it the whole playable map — but the budget (1800 for
heavy rain) is a **screen**-full, not a **map**-full. Spread 1800 raindrops over a 100 000-unit map and you would see
one every few minutes. So particles are emitted over the rect ∩ the ground the camera can actually see, which keeps
on-screen density right whatever the rect's size; once born they live in world space and fall where they fall, so
panning doesn't drag them along. (A map's weather is genuinely *regional* — Harrow places snow in four rects and the
starting base is in none of them, so you walk into the snow.)

### Two bugs only the live run could find

Both were invisible to the headless test **and to a still screenshot**, which is the whole argument for driving the
real game:

- **The particles were never mipmapped-out — they were mipmapped INTO invisibility.** A snowflake is a 4-world-unit
  quad, which at gameplay zoom is about **two pixels**. Ask for a mipmap and the GPU picks a deep level where the
  flake — which fills 94 % of its 32² sprite — has been averaged down to a smear of low alpha, and the whole snowfall
  renders as a haze you cannot see. It was drawing the entire time: 24 000 verts a frame, texture bound, blend on, and
  nothing on screen. A particle is a **screen-space sprite**, not a surface seen at distance, so there is no
  minification to prefilter: `LINEAR`, no mipmap.
- **`dt` in the render loop is MILLISECONDS.** The emitter's lifespans and velocities come out of the SLK in
  **seconds**. Fed 16.6 "seconds" a frame, every particle outlived its lifespan on its very first frame and respawned
  on the spot — so the pass rendered a field of **age-0 particles, re-randomised every frame**. In a still screenshot
  that is *indistinguishable from falling snow*. It only surfaced because the dungeon fog (whose alpha ramp starts at
  **0** and peaks mid-life) drew nothing at all: every one of its 1600 particles was permanently at age 0, so every one
  was permanently at alpha 0. The effects whose ramps start opaque (snow, rain) had been "working" in every screenshot
  I had already taken. `update()` now clamps the step and **warns once** if it is handed something that can only be
  milliseconds.

Verified (`pnpm jass:test` §7.23) — 14 checks against the **real** `Weather.slk` through our **real** parser, not a
fixture (a test against a hand-copied table would prove nothing): all 21 types parse; the `emrate × lifespan × 20`
identity holds for every row; rain is a tail on `rainTail.blp` and its streak is 168 units while moonlight's is 3000
from the same columns; light snow is the set's only alpha-blended (rather than additive) effect; Outland wind is an 8×8
atlas whose frame walks 0 → 32 → 63 across the sheet; dungeon fog fades 0 → 16 → 0 while swelling 20 → 100; the SLK's
`-` for "no ambient sound" is read as none, not as a label; `AddWeatherEffect` creates the effect **disabled** and
`EnableWeatherEffect` is what starts it; and an **unknown** weather id hands back a null handle rather than crashing the
map.

Verified **live**, every one from the map's own script: `(2)Harrow`'s heavy snow (4 regions, 4000 flakes, 126 fps),
`(3)Forestwalk`'s slanted light rain, and `(4)WarChasers` — which builds **13** effects (moonlight, sun rays, red
dungeon fog, snow) — showing its moonlight shafts and its red fog bounded exactly by their rects (screenshots).

**Not modelled:** the **ambient sound bed** (`AmbientSound` — "AmbientSoundRain" — is parsed off the table and carried
on the def, but nothing plays it yet; it is a label the 7.20 `SoundBoard` already knows how to resolve, so it is a
small follow-up), the `useFog` flag (whether an effect is dimmed by the atmospheric haze), and `TerrainDeform*` (the
other "environment effect" family — it sculpts the terrain **mesh**, which we don't do; explicit no-ops).

## Cameras and cinematics — the map's intro actually plays (7.24 — done, live)

The biggest block left on the list, and one coherent story. `(4)Monolith` runs its intro
cinematic **straight out of Map Init**, and it is a complete specimen of the whole surface:

```jass
function Trig_Intro_Cinematic_Start_Func003A takes nothing returns nothing
    call CameraSetupApplyForPlayer( true, gg_cam_Monolith_Intro_Shot, GetEnumPlayer(), 0 )
    call ResetToGameCameraForPlayer( GetEnumPlayer(), udg_cinematicDuration )
    call CinematicFadeBJ( bj_CINEFADETYPE_FADEOUT, udg_cinematicDuration, "…White_mask.tga", 0, 0, 0, 0 )
endfunction
function Trig_Intro_Cinematic_Start_Actions takes nothing returns nothing
    set udg_cinematicDuration = 6.00
    call CinematicModeBJ( true, GetPlayersAll() )
    call ForForce( GetPlayersByMapControl(MAP_CONTROL_USER), function Trig_Intro_Cinematic_Start_Func003A )
    call StartTimerBJ( udg_cinematicTimer, false, udg_cinematicDuration )
endfunction
```

— letterbox in, snap to the shot, drift home over six seconds under a six-second fade to black,
and six seconds later a second trigger fades back in and hands the game over. Every call in it
was an unimplemented native.

### A `camerasetup` is a saved SHOT, not a camera

It is a bag of camera **fields** plus a destination point, which is exactly what the World
Editor's camera tool writes out:

```jass
set gg_cam_Monolith_Intro_Shot = CreateCameraSetup(  )
call CameraSetupSetField( …, CAMERA_FIELD_ROTATION,        77.7,   0.0 )
call CameraSetupSetField( …, CAMERA_FIELD_ANGLE_OF_ATTACK, 320.8,  0.0 )
call CameraSetupSetField( …, CAMERA_FIELD_TARGET_DISTANCE, 1363.6, 0.0 )
call CameraSetupSetField( …, CAMERA_FIELD_FIELD_OF_VIEW,   70.0,   0.0 )
call CameraSetupSetDestPosition( …, 1002.0, 3640.6, 0.0 )
```

**There is no second camera.** `CameraSetupApply*`, `SetCameraField` and `PanCameraTo*` all move
the one camera the player is looking through — so `src/render/scriptCamera.ts` owns no camera
either: it is a set of **tweens over mapViewer's own** `target` / `distance` / `yaw` / `pitch` /
`fov`, and each tween **lets go** when it lands, handing the camera straight back to the player
exactly where the shot finished. That is why a map that wants the normal camera back has to ask
(`ResetToGameCamera`) rather than simply waiting. "The game camera" means **ours** (45° FOV at
2400, not WC3's 70° at 1650) — a setup that asks for 70° still gets 70°, it just isn't home.

Two things the file will not tell you, and blizzard.j will:

- **Degrees in, radians out.** Every setter takes degrees; `GetCameraField` returns radians. The
  proof is `GetCurrentCameraSetup`, which reads the live camera back into a setup and has to
  convert on the way: `CameraSetupSetField(theCam, CAMERA_FIELD_ANGLE_OF_ATTACK, bj_RADTODEG *
  GetCameraField(CAMERA_FIELD_ANGLE_OF_ATTACK), duration)`. So the engine boundary speaks
  degrees and only that one native converts.
- **A zero-duration apply lands NOW.** Monolith reads the camera back on the very next line
  (`ResetToGameCamera`). Defer the snap by one frame and the reset blends the game camera *to
  the game camera*: the intro shot never appears at all.

### Cinematic mode is a checklist, and `CinematicModeExBJ` is the spec

Each line of it is a native we had to own — `ShowInterface(false, fade)` (the letterbox, out of
the game's own `UI\FrameDef\UI\CinematicPanel.fdf`), `EnableUserControl(false)`,
`FogEnable`/`FogMaskEnable(false)`, `EnableDawnDusk(false)` (the clock **stops**, so the shot
doesn't drift from day into night), `SetGameSpeed`, `SetCineModeVolumeGroupsBJ` (7.20, already
real) and `SetRandomSeed(0)`.

And the half that is easy to miss: on the way out it **restores what it SAVED on the way in**
(`bj_cineModePriorFogSetting`, `…PriorDawnDusk`, `…PriorSpeed`). So `IsFogEnabled` /
`IsFogMaskEnabled` / `IsDawnDuskEnabled` / `GetGameSpeed` have to answer honestly rather than
return a stub — a lying getter doesn't break the cinematic, it breaks the **game the cinematic
hands back** (it would switch the fog back on for a map that had deliberately turned it off).
`SetRandomSeed` is real for the same reason, and Monolith says so in its own comment: *"the
random seed is fixed while cinematic mode is on, so it's important to [place the random shards]
after we turn it off"*.

### The letterbox and the talking head are independent, and the FDF says so

```
// --- The "CinematicScenePanel" is shown and hidden as there
//     is a cinematic scene to display.
```

`ShowInterface(false)` brings the bars in; `SetCinematicScene` shows the portrait. A transmission
during ordinary play — an ally warning you mid-melee — shows the bust with **no** letterbox, and a
silent flythrough shows the letterbox with no bust. So they toggle separately (`src/ui/cinematicPanel.ts`).
Three adaptations the file can't state: the bars are authored **0.8 wide** (a 4:3 screen) and are
stretched to the viewport; the portrait is a **SPRITE** (a live model — it gets its own
`ModelViewerScene`, like the HUD's bust); and the **unsized-frame trap** bit for the fourth time
(`CinematicSpeakerText` declares neither Width nor Height, so it collapsed to 0×0).

Two FDF-renderer fixes fell out of it, both of which had been latent:
- **`BackdropCornerFlags` was ignored.** Every panel we had mounted before declares all eight
  (`"UL|UR|BL|BR|T|L|B|R"`), so it cost nothing — but the letterbox declares only its **inner**
  edge (`"UL|UR|T"` on the bottom bar, `"BL|BR|B"` on the top), because the other three sides run
  off the screen.
- **`BackdropBlendAll`** makes our renderer stretch one texture over the frame and skip the edge
  file — right for the ornate menu buttons it was tuned on, wrong for the bars and the portrait's
  cover, which want the 9-slice (tiled `EscMenuBackground` stone + the real `CinematicBorder` trim).

### Three bugs, and only the live run could find two of them

- **Every `mapcontrol` index was off by one** — a 23-milestone-old bug in a *different* subsystem.
  common.j says `MAP_CONTROL_USER = ConvertMapControl(0)`; we stored the human as **1** in the
  lobby hand-off (`config()` had already set it right; `applyLobby` overwrote it). So
  `GetPlayersByMapControl(MAP_CONTROL_USER)` built an **empty force**, and every GUI "for each
  user player" loop in the corpus — one of the commonest shapes there is — quietly did nothing.
  Monolith wraps its entire intro in one, which is how it finally surfaced. §7.24 pins it.
- **A camera angle must blend along the SHORTEST ARC.** Monolith's shot stores
  `ANGLE_OF_ATTACK = 320.8` and the game camera's is `-54.4` — the same tilt, written 375° apart.
  Blending the raw numbers sweeps the camera `320.8 → 238 → 159 → 75 → -44.9` over six seconds:
  it pitches through the horizon, goes fully **upside-down**, and comes back, while the map thinks
  it asked for a 15° nudge. **Every headless check passed**, because both endpoints were right —
  it took a live time-series of `s.pitch` to see it. (`FIELD_OF_VIEW` is deliberately not circular:
  a lens angle is a magnitude, not a bearing.)
- **The letterbox does not fade in at map init.** `CinematicModeExBJ` opens with
  `if (not bj_gameStarted) then set interfaceFadeTime = 0` — so a cinematic that starts before the
  game does (Monolith's) simply *has* its bars on the first frame. Not a bug in the end, but it
  looked like one until the source explained it.

Verified (`pnpm jass:test` §7.24) — 24 checks driven through the **real** blizzard.j BJs
(`CinematicModeBJ`, `CinematicFadeBJ`, `CameraSetupApplyForPlayer`, `TransmissionFromUnitWithNameBJ`,
`PingMinimapLocForForceEx`) against the **real** `ScriptCamera`, including a permanent gate that
**no `…BJ` is registered as a native** (the shadowing bug that hid the alliance surface until 7.22)
and the shortest-arc gate above. A transmission's duration is *derived*, not asserted:
`bj_NOTHING_SOUND_DURATION` (5 s, for a null sound) + the map's 10 s = 15 s, and the portrait hangs
on `bj_TRANSMISSION_PORT_HANGTIME` (1.5 s) longer.

Verified **live**: `(4)Monolith`'s own intro cinematic plays end to end — letterbox in, the camera
on its own `gg_cam_Monolith_Intro_Shot`, a six-second drift home under a six-second fade to black,
then the game handed back intact (HUD, camera, fog, day/night clock). `(4)WarChasers`' Soul Keeper
transmits with his animated bust in the game's own frame, his name in his player colour and his
subtitle beneath — and its own "Snap Camera to Player" trigger re-locks the camera on the hero
between shots, which is the map behaving exactly as written. Pings pulse on the minimap
(screenshots).

**Not modelled:** `UnitAddIndicator` (the white flash over a transmission's speaker),
`SetCinematicCamera` (a camera path authored in an `.mdx` — no bundled map uses one), the cine
filter's **texture** (every fade in the corpus is a `White_mask`/`Black_mask`, i.e. a flat colour;
a shaped mask like `SpecialPowMask` degrades to that colour), `SetCineFilterStartUV`/`EndUV` (a
scrolling filter), and the **game-speed multipliers** — `SetGameSpeed` is recorded and read back
(which is all cinematic mode needs) but not applied, because WC3's five speeds are engine
constants that live in no data file we have and guessing one is exactly what `CLAUDE.md` forbids.

## The custom map's world must exist before its script runs (7.25 — done, live)

Three bugs, reported from playing **(4)WarChasers** through the real lobby: *two soundtracks at once*; *the camera is
not on my wisp, sits at a strange angle and cannot be panned*; *picking a hero spawns two ENEMY heroes on my hero
spawn*. Two of the three are **one root**. The bisect (proved from the diff, not by eye — `src/audio/sounds.ts` and
`src/jass/interpreter.ts` are byte-identical at 9462dc1 and cf638d4, and `startCustom` had the same ordering, while
`src/jass/natives/camera.ts` is a **new file** in cf638d4):

| Symptom | New in 7.24? | Root |
|---|---|---|
| Two soundtracks | **No** — 7.20 | The music channel is claimed *after* the mp3 decodes |
| Camera wrong / unpannable | **Yes** — but only as a *revealer* | 7.24 made the camera natives real; they then rode a handle bound to nothing |
| Two enemy heroes | **No** — predates it | The enter-region baseline was seeded from an empty world |

### The shared root: `startCustom` ran the script before the world existed

WC3's `main()` calls `CreateAllUnits()` **before** `InitCustomTriggers()`. 7.3 codified that for melee — `startMelee`
seeds the `.doo` units and `await waitForMapUnits()`s them all into the sim *before* running the script, because
otherwise `MeleeFindNearestMine` finds no mine. **`startCustom` never got the same treatment**: it ran the map's script
first and enabled seeding afterwards. The script therefore talked to an empty world, and two things fell out of it:

- **Every `gg_unit_*` handle bound to nothing.** `CreateUnit` inside `CreateAllUnits` only *records* its row (the unit
  is already on the map, `.doo`-adopted) and binds the handle to the unit standing at (x, y) — but nothing was standing
  anywhere yet, so `findPlacedUnit` returned −1. **321 handles on WarChasers**, including all four selector wisps. The
  map then asks the camera to *ride* one — `SetCameraTargetControllerNoZForPlayer(Player(0), gg_unit_ewsp_0006, …)` —
  and `RemoveUnit`s the wisps of the slots nobody is playing. Both fell on the floor. With no unit to ride, the camera
  was left to the `Snap Camera to Player` trigger, which re-applies `gg_cam_CamStart1` **every 2 seconds** — hence a
  camera pinned to a fixed point (−7718, −9039) that drags back within ~1.5 s of any pan. *The map does intend a locked
  camera* (it also ships `Player{1,2,6,7} Disallow MouseWheel`); the bug was that it was locked to a **point** instead
  of to the **player's unit**.
- **The enter-region baseline was seeded from nothing.** A unit already inside a rect when its trigger registers must
  never fire it — in WC3 it *can't*, because it exists first. Ours streamed in afterwards, so every pre-placed unit
  standing in a watched rect counted as **entering** it on the first pump. On WarChasers that is not cosmetic: each hero
  pedestal is a rect holding a **Circle of Power (`ncp2`) and a display statue of that hero**, both **Neutral Passive
  (player 15)** — and the Robo-X pedestal's trigger carries **no `== 'ewsp'` condition** (the map's own quirk; the other
  seven have one). So both of them ran it: `CreateNUnitsAtLoc(1, 'OC10', GetOwningPlayer(GetEnteringUnit()), …)` twice,
  with the entering unit's owner being **15**. Two Neutral-Passive Robo-X heroes, on `gg_rct_Start2` — the players'
  shared hero spawn. Exactly two, exactly there. The player only *sees* them when their own hero arrives.

**Fix** (`src/render/mapViewer.ts` `startCustom`): `enableSeeding()` → `await waitForMapUnits()` → *then* `runMapScript`.
The same three lines `startMelee` has had since 7.3.

### The music channel had no arbiter (`src/audio/sounds.ts`)

WC3 has exactly **one** music channel, and every music native is a bid to own it. Ours claimed it only when the mp3
finished decoding: `startMusicTrack` stopped `this.music` (still `null` at that point) and then `src.start()`ed on the
`.then`. Two starts inside one decode window therefore both reached the speakers, and nothing held the first one's node
to stop it again — it played to the end, orphaned, under the second. WarChasers opens exactly that way:

```
main():                     call SetMapMusic( "Music", true, 0 )      // the race playlist
Trig_Initialize_WarChasers: call PlayMusicBJ( gg_snd_Undead2 )        // …~1 ms later, still decoding
```

**Fix:** a **generation token**. `claimMusicChannel()` silences the incumbent and bumps `musicGen` **synchronously**; a
decode that lands against a stale token is discarded rather than played. `stopMusic` and `playThematicMusic` claim it
too. (The same question, asked of the camera, already has an answer: `ScriptCamera` is a single writer where the last
caller wins — an explicit pan drops the followed unit and `setTargetUnit` drops an in-flight pan.)

### The lobby had no business re-teaming a custom map (Theme A)

Our lobby defaulted every slot to `team = slot.id + 1` — its own team — and `Runtime.applyLobby` wrote that over what
`config()` had already decided. On WarChasers, whose `InitCustomTeams` allies players **0/1/5/6 on team 0**, that made
three co-op partners into **enemies**, and their units into hostile ones. The authority is in the map, and the w3i says
so out loud: flag **`0x0040` "use custom forces"** (set on WarChasers, **not** on Echo Isles or any melee map) plus its
**FORCE** records — force 0 = players 0/1/5/6, force 1 = player 11 — which is precisely what `InitCustomTeams` restates.
So `parseMapInfo` now derives `PlayerSlot.team` from the map's forces when that flag is set, and the lobby defaults to
it (and greys race/team out under `0x0020` "fixed player settings", which WarChasers also sets). Without the flag —
i.e. every melee map — each slot still opens on its own team, so **melee is untouched**.

The rest of Theme A came back **clean**: an audit of every hard-coded common.j index in `src/` against `Scripts\common.j`
found `mapcontrol` (fixed in 7.24) to have been the only wrong one. The **7.25 enum-index gate** in
`tools/jass-corpus-test.cjs` now re-derives them all from common.j so they cannot drift again — and because our
constants are *named after* common.j's (`EVENT_UNIT_DEATH = 53`), it picks up new ones automatically.

Verified (`pnpm jass:test` §7.25): 418 common.j constants parsed as the oracle; 40 name-identical constants plus the
`MAP_CONTROL` / `CAMERA_FIELD` / `JassFogState` / `AllianceType` tables all match; a unit standing in a rect never fires
its enter trigger, and one that crosses in fires it exactly once with the right `GetEnteringUnit`. Verified **live** on
WarChasers: `camTarget == wispAt` to the unit (the camera rides the selector wisp, then the hero the player picks);
**one** audible music track where there were two (counted off the live `AudioBufferSourceNode`s, not our own
bookkeeping); **zero** Neutral-Passive heroes where there were two; all four wisps co-allied on the map's own team.
Echo Isles: town hall + 5 workers, 500/150, teams unchanged.

## What's NOT done yet (next tasks — keep this list honest)

- **A pre-placed CUSTOM-type unit is still seeded under its BASE type id** — found while fixing 7.25, not fixed by it.
  mdx-m3-viewer has no SLK row for a `war3map.w3u` id, so its map-unit row reports the base: WarChasers' `OC10` statue
  comes back as **`Otch`**, and `trySeed` seeds the sim unit as `Otch`. Two consequences: `findPlacedUnit('OC10', …)`
  can't match it, so **57 `gg_unit_*` handles on WarChasers are still unbound** (down from 321 — everything base-typed
  now binds); and the unit gets the *base* def, so a pre-placed custom unit renders and fights as its base type. The fix
  is to carry the true `unitid` from our own `war3mapUnits.doo` parse (`src/world/mapUnits.ts`) into `trySeed` rather
  than trusting the viewer's row — a real change to the adoption path, with its own verification (custom models), which
  is why it isn't bundled into this one.


- **Custom destructable/upgrade/buff data** (optional) — the same mechanism for `war3map.w3b` (destructables,
  `War3MapW3u`), `.w3q` (upgrades, `War3MapW3d`), `.w3h` (buffs, `War3MapW3u`). Lower priority: only maps that create
  custom destructables (via `CreateDestructable`) / research custom upgrades need them. Units + abilities + items — the
  gameplay-critical trio — are done.
- **Custom-ability *behaviour*** — object data now gives a custom ability its real numbers, but only abilities whose base
  `code` is in `KNOWN_ABILITIES` (src/data/abilities.ts) actually *do* anything; an unknown base code loads as data but
  stays passive/uncastable (graceful, but inert).
- **Effect natives still missing.** 7.7 + 7.13 cover resources, unit-state and the unit-mutation set; 7.16 the group +
  filter/query surface; 7.17 abilities, heroes, flags and animation; 7.18 items; 7.19 floating text, dialogs and
  leaderboards; 7.20 sounds and music; 7.21 timer dialogs; 7.22 alliances/shared vision, both fogs, waygates and
  multiboards; 7.23 weather; 7.24 cameras, cinematics, transmissions, minimap pings and `SelectUnit`/`ClearSelection`.
  Still no-ops, now the top of the ranking: **special effects** (`AddSpecialEffect*` / `DestroyEffect` — 10 maps
  directly and far more through the BJs — **the biggest block left**), **destructables** (`CreateDestructable` /
  `KillDestructable` / `GetEnumDestructable` — 7), **`SetSkyModel`/`SetWaterBaseColor`** (9), **quests**
  (`CreateQuest*` — 8), **`ReviveHeroLoc`** (4), **upgrades** (`SetPlayerTechResearched` — 4), **chat events**
  (`TriggerRegisterPlayerChatEvent` — 3), **`TriggerRegisterPlayerStateEvent`** (3) and **lightning** (2). Each is a
  small bridge method away — but note the ranking under-counts anything reached through a BJ, so `jass:coverage` is a
  floor (weather sat at a `✓` for 23 milestones). `SetGameSpeed` is now a `✓` but is **recorded, not applied** — see
  the 7.24 "not modelled" note, and treat the tick as exactly the caveat above.
- **Shops** — no unit sells anything, so `EVENT_PLAYER_UNIT_SELL_ITEM` / `_SELL` never fire (the item-sale plumbing is
  wired and waiting: §7.18) and blizzard.j's `MeleeGrantItemsToHiredHero` (a tavern hero) can't run. Needs a purchase
  path: shop stock (`AddItemToStock`), the buy command card, gold, range.
- **Events still missing:** `EVENT_PLAYER_UNIT_SUMMON` (the sim has the summon channel — same "born in the renderer"
  shape as TRAIN_FINISH), `..._RESEARCH_*` / `..._UPGRADE_*` (no upgrade system yet), `..._SELECTED`, `_SELL`/`_SELL_ITEM`
  (no shops — above), and the player-scoped `TriggerRegisterPlayerStateEvent` / chat events.
- **Melee leftovers** (7.3): melee **AI** (`StartMeleeAI` is a no-op, so a computer slot just sits — **the biggest one
  left by far, and now the only structural one**), hero-limit *enforcement* (the caps are recorded, not applied), and
  **blight** under an undead base. *(The victory/defeat **dialogs** render — 7.19; the cripple **timer window** renders
  — 7.21 — and the cripple rule's second half now lands too: `MeleeExposePlayer` really does reveal the player — 7.22.
  The first hero's Town Portal scroll is granted — 7.18 — though `AItp` has no cast behaviour in the sim, so the scroll
  doesn't teleport yet.)*
- **Natives on demand** — special effects, destructables, quests, sky/water, gamecache. Use `pnpm jass:coverage` to
  prioritise (279/335 used natives implemented — and see the caveat on that number above).
- **The 7.23 weather ambient sound bed** (`AmbientSound` — "AmbientSoundRain") is parsed off `Weather.slk` onto the def
  and carried there, but nothing plays it. It is a label the 7.20 `SoundBoard` already knows how to resolve.
- **The 7.21 countdown format is still not ground-truthed** — M:SS under an hour / HH:MM:SS over is *inferred* from the
  `Game.dll` string dump, not measured. To settle it, read the clock off a real 1.27a client.
- **Lua** (`war3map.lua`, Reforged 1.31+) — only when we target that version.
