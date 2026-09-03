# CLAUDE.md — working guide for OpenWar3

OpenWar3 is a browser-first, asset-compatible re-creation of the **Warcraft III (TFT 1.30.4)** engine in TypeScript.
See [`README.md`](./README.md) and [`OpenWar3_PLAN.md`](./OpenWar3_PLAN.md) for scope; this file is the standing
guidance for how to build here.

## Prime directive: match the original game, and use our sources to do it

Everything we build should be **as close to the original Warcraft III as possible** — behaviour, timings, layout,
naming, and feel. Do not guess at WC3 mechanics or invent values. Before implementing or adjusting any gameplay, UI,
data, or asset behaviour, **consult our sources** and cite what you used.

**Our sources (read these, in this order for a given question):**

1. **The real game data in `Warcraft III/`** — the ground truth. When a reference and the game data disagree, the game
   data wins (this is a hard-won rule; see the cliff-ramp story in `docs/REFERENCES.md`). Read `.slk`/`.txt`/`.w3*`
   data, model `.mdx`, and asset paths straight from the install. `pnpm data:extract` unpacks the readable ones to
   `Warcraft III/ExtractedData/` so you can grep them.
   - **[`docs/wc3-data-formats.md`](docs/wc3-data-formats.md)** — where each piece of data lives (archives, file
     formats, and the exact tables/fields for target flags, tooltips, names, hotkeys, icons, sounds, maps).
   - **[`docs/casc.md`](docs/casc.md)** — read this before touching `src/vfs/`, the install picker, or the extractor.
     1.30.4 is a **CASC** content store, not MPQs: nothing in it is addressed by name, a campaign map is no longer a
     file, and six `common.j`/`Blizzard.j` constants became natives the engine has to answer.
   - **Archive split** (`ARCHIVE_ORDER` in `src/vfs/casc.ts`, later wins): `Deprecated.mpq` = art old custom maps
     still reference; `War3.mpq` = everything shared; `<locale>-War3Local.mpq` = localized text, unit voices and the
     campaign maps. 1.30 kept the MPQ *names* after dropping the format. A 1.27a install is still mountable and
     layers `war3 < war3x < war3xlocal < war3patch` (`src/vfs/profiles.ts`).
   - **TFT audio (Huffman+ADPCM):** WC3 stores every WAV as **Huffman(+ADPCM)**. Stock `mdx-m3-viewer` threw
     `compression type 'huffman' not supported`, muting every expansion sound. Fixed in
     `patches/mdx-m3-viewer@5.12.0.patch` (Storm-Huffman port in `huffman.js` + `file.js` wiring + an `adpcm.js`
     signedness fix). This is an MPQ-sector codec, so on 1.30.4 it applies to the map archives rather than the store.
2. **[`docs/REFERENCES.md`](docs/REFERENCES.md)** — the curated index of reference projects and research threads, with
   per-source gotchas. Start here to find the right reference for a topic.
3. **[`docs/reverse-engineering/`](docs/reverse-engineering/)** — locally archived engine internals:
   - [`tinkerworx-repos.md`](docs/reverse-engineering/tinkerworx-repos.md) — RE'd **engine class layouts** (`CAgent`→
     `CWidget`→`CSelectable`→`CUnit`, the per-order **ability objects** `attackAbility`/`moveAbility`/`heroAbility`/
     `buildAbility`/`inventoryAbility`, `AbilityLevelData` fields). Use these to shape our unit/ability/order model.
   - [`game-dll-thread.md`](docs/reverse-engineering/game-dll-thread.md) — the `Game.dll` string dump: real class/file
     names (`CGameUI`, the `frame`/`framedef`/`fdfile` FDF UI system, the `glue` menus) and the data-file/asset names
     the engine reads. Use it to **name and organise our subsystems to mirror the original**.
4. **Hive Workshop threads & the official [classic WC3 basics pages](https://classic.battle.net/war3/basics/)** for
   mechanics that live in no file format (turn rate, acquisition, upkeep, rally, etc.). hiveworkshop 403s plain
   fetchers — fetch with a browser `User-Agent` (see `docs/REFERENCES.md`).

**Rules when using sources:**
- **Verify, don't trust blindly.** References are hypotheses — confirm format/behaviour against the real game
  data or observed game behaviour before building on them.
- **Cite the source next to the code.** When a constant or behaviour comes from a thread/repo/data file, name it in a
  comment right there (the codebase already does this — match that style).
- **Prefer the real asset.** If WC3 has a model/texture/icon/sound for something, use its real path from the install
  (asset-resolver philosophy: authentic when present, placeholder otherwise). Example: the learn-skill button uses
  `ReplaceableTextures\CommandButtons\BTNSkillz.blp` (the `CommandButtonsDisabled\DIS*` twin of any icon is the
  "unavailable" art — never reach for it for a live button, and never fake it with a CSS filter either: the twin is
  desaturated **and drawn without the gold button frame**, and losing the frame is most of what reads as "you can't
  press this". `DIS` + the basename, for `BTN*` and a passive's `PASBTN*` alike); spell AoE circles are
  `ReplaceableTextures\Selection\SpellAreaOfEffect*.blp`.
- **Legal boundary:** OpenWar3 ships **zero Blizzard assets or code**. The RE material is *documentation of behaviour
  and naming only* — never lift Blizzard binaries, decompiled code, or GPL reference code (Warsmash: study, don't lift).
  Assets are read only from the user's own local install at runtime.

## Practical

- **Git workflow:** commit and push directly to `main` — do **not** create a branch or open a PR unless the developer
  explicitly asks for one. Still commit only when the change is done and verified (`pnpm typecheck` / in-browser as needed).
- **Build / check:** `pnpm dev` (localhost:5173), `pnpm build` (typecheck + build), `pnpm typecheck`. Run `pnpm typecheck`
  before considering a change done. `pnpm data:verify` re-checks `src/data/gameplayConstants.ts` against the unpacked
  data — run it after touching that file (needs `pnpm data:extract` first). `pnpm casc:test` checks the CASC mount
  itself against the local install.
- **Show your work with screenshots — often.** Anything visual (rendering, HUD, camera, effects, terrain, shadows, fog,
  UI) must be previewed in the REAL running game and the screenshots **sent to the developer** so they can see how it
  looks as you go — don't just describe it or keep the shots to yourself. Drive the app live per the `live-browser-testing`
  memory (temp `?dev=` auto-mount + `agent-browser` screenshot; `(2)EchoIsles.w3x` is the canonical test map), and use
  `SendUserFile` to deliver the images. Send **multiple** shots — a framed overview plus tight close-ups (crop/upscale
  with ffmpeg), before/after when you change a value, and a fresh shot after each meaningful tweak — rather than one
  final image. Keep the developer in the loop visually throughout the task, not only at the end.
- **Performance:** `pnpm dev:log` records every match to `.logs/` (gitignored; plain `pnpm dev`
  records nothing) — frame times, where in the frame they went, and a census of everything a
  match can grow. Read
  [`docs/perf-logging.md`](docs/perf-logging.md) before investigating "it gets slower the longer
  you play", and start from `pnpm perf:report` rather than from a profiler: the report already
  separates *a phase got more expensive* from *something is accumulating* from *the cost is
  outside our loop*. The recorder is dev-server-only in both halves (`apply: "serve"` +
  `import.meta.env.DEV`), and phases must PARTITION the frame — nesting two `perfLog.begin`
  spans makes the report's `(unaccounted)` row meaningless.
- **Layout:** sim in `src/sim/` (world, pathing, `spells.ts`), game glue in `src/game/rts.ts`, rendering + command card
  in `src/render/mapViewer.ts`, HUD DOM in `src/ui/hud.ts`, data tables in `src/data/` (units, techtree, `abilities.ts`),
  audio in `src/audio/`, styles in `src/style.css`.
- **Camera:** read [`docs/camera.md`](docs/camera.md) before touching `GAME_FOV`, the zoom constants, or a map's
  camera. The FOV *field* the data carries (70) is **not** the angle the game renders with (**45°**, measured off
  the real client) — conflate them and every distance changes meaning and every map camera breaks.
- **Spell FX:** read [`docs/spell-fx.md`](docs/spell-fx.md) before adding or debugging a spell's art. WC3 has
  FIVE presentation mechanisms (effect models, buff art, **lightning ribbons**, ubersplats, sound), and two of
  them play no model at all — a Chain Lightning or a Drain has no `Targetart` to find, and a buff's art lives on
  the BUFF row rather than on the ability. Reaching for the wrong one is the standard "this spell has no art" bug.
- **Lighting & shadows:** read [`docs/lighting.md`](docs/lighting.md) before adding anything light- or
  shadow-shaped. WC3 has **no real-time shadows** — a shadow is a blob decal, a baked `war3map.shd` mask
  (16 bytes per terrain CELL, 0-or-255, no header), or nothing — and the glue screens are lit by the
  models' OWN `LITE` omni lights, sized for a diorama the camera sits 340 units from. It also has the
  trap that costs an hour: after editing the mdx-m3-viewer patch, restart the dev server and delete
  `node_modules/.vite`, or Vite keeps serving the pre-patch bundle and your shader change does nothing.
- **Night elf:** read [`docs/night-elf.md`](docs/night-elf.md) before touching the Wisp, the
  Ancients, the Entangled Gold Mine or the Moon Well. The whole race plays a different economic
  game and almost none of it is a tuning value: a Wisp is CONSUMED by an Ancient (UnitBalance
  `type` = "Ancient") and released by a Moon Well, its lumber is credited in the tree with no
  round trip at all, gold is a crew of five sitting inside a building rather than a queue, and
  an Ancient is the one building in the game that picks up its own stamped footprint and walks.
- **Undead:** read [`docs/undead.md`](docs/undead.md) before touching blight, the Acolyte, the
  Haunted Gold Mine or any undead structure's placement. Blight is TERRAIN — one grid the
  buildings paint (`Abgs`/`Abgl` grow, `Abds`/`Abdl` on every OTHER race's buildings scrub, all
  four the same row shape with one `Creates Blight` boolean between them) — and it OUTLIVES what
  grew it. `UnitBalance.requirePlace` = "blighted" is the whole placement rule and names exactly
  the eleven structures that need it. An Acolyte summons and WALKS AWAY (the building keeps its
  own clock), never carries gold, and kneels in a `Abgm` 200-unit ring around a Haunted Gold
  Mine — whose crew of five is paid where the gold is dug.
- **Illusions:** read [`docs/illusions.md`](docs/illusions.md) before touching Mirror Image (`AOmi`), the Wand of
  Illusion (`AIil`), or anything that copies a unit. An illusion's whole point is that the ENEMY can't tell it from
  the original, so every tell (blue wash, summon timer, portrait) is gated on the LOCAL viewpoint, and its
  no-damage rule is enforced at the blow — not by editing what it shows.
- **Items:** read [`docs/items.md`](docs/items.md) before touching an item, an item ability, or
  anything in `useItem`/`applyPowerup`/`itemBonuses`. An item's behaviour is NOT in the item —
  it is an ability id in `abilList`, and that row has the same fields a hero spell's does, so it
  is dispatched on its base `code` like one. Three doors (pressed, picked up, carried) share ONE
  dispatcher, because the game ships the same ability both ways round: `AIha` is the Scroll of
  Healing AND the three Runes of Healing. Who an effect reaches comes off its own `Area1` — a
  Scroll of Regeneration is an AREA, a Healing Salve is a UNIT and a Clarity Potion is the
  drinker, all three under one code — while the AIMING is not in the tables at all and has to be
  read out of the item's Ubertip. And a CARRIED ability is an ability: the Talisman of Evasion's
  row IS the Demon Hunter's Evasion, so the inventory has to be visible to `passiveLevelData`
  and to `applyAuras` or fourteen aura items broadcast to nobody.
- **Orb effects:** read [`docs/orbs.md`](docs/orbs.md) before touching any ATTACK MODIFIER — the orb items, the
  arrow abilities (Searing/Cold/Black/Incinerate), Slow Poison, Envenomed Spears, Feedback, Frost Attack or the
  Mask of Death. They are ONE family under one rule — only **one** orb effect may ride a blow, by a fixed priority
  ladder — so adding one in isolation is always wrong. Two things it does NOT gate: the flat damage bonus (a
  carried stat, it stacks) and the air attack (`DataE` = "Enabled Attack Index", waking the hero's dormant second
  weapon). And an orb's `Targetart` is not a hit effect: it is the LOOPING model worn on the carrier's weapon bone.
- **Campaigns:** read [`docs/campaigns.md`](docs/campaigns.md) before touching the campaign screen, its data, or the
  chapter-start path. The whole campaign is ONE text file (`UI\CampaignStrings_exp.txt`) that documents itself, and
  three of its rows break the obvious parse (a comma inside quotes, a fourth field, a "mission" that is a `.mdl`).
  The screen is also the one glue screen with **no panel chrome** — the campaign's 3D backdrop is the screen.
- **Loading screens:** read [`docs/loading-screens.md`](docs/loading-screens.md) before touching `Loading.fdf`, the
  `[LoadingScreens]` table, or the start-of-match path. The w3i field that picks a map's screen is the one the
  parsers call **`campaignBackground`** (the int AFTER the subtitle is not a screen at all), the art is flat 2D in
  the FDF's own 0.8×0.6 box rather than a 3D scene, and the load bar **fills itself** — its clip animates empty→full
  and progress is just where you park the playhead. It is also the one screen laid out **stretched** rather than
  height-scaled (it is a picture with things printed on it) and the one that must live OUTSIDE `#ui`, which a match
  re-boxes to the 16:9 game frame while the bar is still moving.
- **Unplayable area:** read [`docs/unplayable-area.md`](docs/unplayable-area.md) before touching the map border, the
  camera clamp, `GetCameraMargin`/`GetPlayableMapRect`, or anything that asks "is this point on the map". A map
  states its boundary FOUR times over (two w3e flags that mean the same thing, one wpm bit, `SetCameraBounds` in its
  own `main()`, and the w3i) and they agree exactly — so nothing here needs guessing. The bit is `0x04`
  **Unflyable**, one bit away from a cliff's `0xca`, and it is why the border is the one thing a flyer cannot cross —
  in the air it is also the ONLY thing `PathDomain`'s `"air"` asks about, and the only thing that makes an air unit
  path at all. The tint is `UI\MiscData.txt` **[FogOfWar]** `BoundaryTerrain` = 230,0,0,0, a FLOOR on fog rather than
  a colour, with an OBJECT twin (`BoundaryObject`, a black silhouette) that lives in the mdx SD shader. It does NOT
  block line of sight — that was tried and taken back out; see the doc's last section before reaching for it again.
  And the three rects (world bounds ⊃ playable area ⊃ camera bounds) are 512/256 apart and not interchangeable.
- **The pause:** read [`docs/pause.md`](docs/pause.md) before touching `paused` in
  `src/render/mapViewer.ts`, the F10 panel's Pause button or the Quest Log's Done button. The
  pause has FOUR independent owners (a modal panel, the map's own `PauseGame`, a player, a dead
  match) and folding them into one boolean makes them clobber each other. A stopped world is a
  STILL PICTURE — every clock that ages the world reads `wdt`, not the frame's `dt` — and the
  whole feature documents itself in `GlobalStrings.fdf`: `KEY_RESUME_GAME` sits next to
  `KEY_PAUSE_GAME` for one and the same button, and pauses are counted in TIMEOUTS, three per
  player, which anybody may lift. `deadPanels()` is the ONE answer to "which console buttons
  are dead now" that both the strip's greying and the F-keys ask, and no key ever swaps one
  modal for another — a panel's own key closes it, every other key does nothing.
- **Melee AI:** read [`docs/melee-ai.md`](docs/melee-ai.md) before touching anything in
  [`src/ai/`](src/ai/), `MeleeStartingAI`, or a computer player's behaviour. WC3's computer
  players are Blizzard's own JASS — `Scripts\human.ai` / `orc.ai` / `elf.ai` / `undead.ai` on
  the `common.ai` library, all four in the install — and the four race files here are ported
  from them function for function, so **a number in them is the game's** unless a comment says
  otherwise. The BUILD ARRAY is the whole strategy layer and reads backwards until you know it:
  `SetBuildUnit(n, X)` means "have at least n of X" (counting queues and orders in flight, not
  just what is standing), the list is a PRIORITY LADDER whose running gold budget stops dead at
  the first row it cannot afford, and `TownCount` folds a Castle into "a Town Hall" — which is
  also why `SetBuildUnit(1, KEEP)` means *upgrade the hall* and never *found a Keep*. Every
  decision leaves through `RtsController.execute`, so a computer is gated exactly as your own
  click is and cannot cheat. A campaign chapter gets no melee AI: its computers are the
  mission's. **SPELLS are the exception to "a number here is the game's"**: the race scripts say
  what a hero LEARNS and nothing about using it, so [`casting.ts`](src/ai/casting.ts) is built on
  Boris_Spider's observation thread (hiveworkshop 193280) instead — every rule quotes its line,
  and it is keyed on the BASE ability code, which is the thread's own point. A WAVE's reach and
  width come out of `waveDistance`/`waveHalfWidth` there, shared with Computer+ — and the three
  wave meta groups do NOT number their columns alike: `Osh1..4`/`Ucs1..4` put the distance in
  `DataC` and a HALF-width in `Area1`, while `Uim1..4` (Impale) puts the distance in `DataA`,
  its DAMAGE in `DataC` and its WHOLE width in `Area1`. Read down the wrong column and Impale's
  reach is **75** — its damage — so nothing is ever inside it and the Crypt Lord never presses
  the button at all, in both casters at once.
- **Computer+:** read [`docs/computer-plus.md`](docs/computer-plus.md) before touching
  [`src/ai/plus/`](src/ai/plus/), the Advanced Options pane's Computer+ switch, or
  [`src/overrides/`](src/overrides/). It is a SECOND melee AI beside Blizzard's ported one, not a
  difficulty setting on it: the two objects share no state, a seat is in exactly one of them, and
  nothing in `src/ai/*.ts` may import from `src/ai/plus/`. The rule that makes it different is
  that it does **not cheat** — neither the insane computer's doubled harvest nor its fog bypass —
  so every difference between its three rungs is a number in `PlusProfile`, and **none of those
  numbers are the game's**: nothing in the install describes an improved AI, so unlike the race
  scripts a value there is OURS unless a comment cites something. Its army ceiling is enforced at
  PRODUCTION rather than at the wave, which is the whole of "must not mass"; and its concession
  leaves through `EVENT_PLAYER_LEAVE` so Blizzard's own `MeleeTriggerActionPlayerLeft` hands the
  units over instead of the AI demolishing its own base. A race is a TABLE of named builds, one
  rolled per match, and **expanding belongs to the build order** (`PlusStrategy.expandAt`) rather
  than to the difficulty — a fast expand is a build, not a setting. A build names UNITS and its
  buildings are derived, with two clauses that go further and no third: `factories` (the second
  Arcane Sanctum / Ancient of Lore / Crypt a build is NAMED after — how many of a building the
  mix already implies, never which) and `thenAt3` (the build it GROWS INTO at tier 3, a clause of
  the rolled build rather than the mid-game switch we reject). SPELLCASTERS are a share and not
  an army (`UnitRow.caster`, `CASTER_SHARE` = half): the counter re-weighting cannot score a
  spell, so it only ever pushes the units AROUND the casters and a bad matchup quietly promotes
  them. The one row that buys a producer the build never asked for is `antiAir` — one building
  and four of the race's DEDICATED anti-air unit, on top of the mix, gated on the same
  seen/sample/difficulty switches as the rest of the countering and on counter.ts's own
  `AIR_HEAVY`. Countering reads the game's
  own `DAMAGE_TABLE` against what the AI has SCOUTED, so never add a hand-written counter chart.
  CREEPING is PRICED, never measured in food ([`plus/power.ts`](src/ai/plus/power.ts)): a camp's
  combined level already says how hard it is on the game's own green/orange/red scale, and a
  party is priced by √Σ(dps × current hp) × a hero factor — FOOD is not what an army is worth,
  three Grunts are not three Archers. STARTING a fight and BREAKING OFF one are different bars,
  and the second is much lower (re-asking the first mid-fight aborts every run on the first
  scratch); the same rule serves creeps and players, and only "is the opposition still healthy"
  is measured differently. A THIRD bar is one SOLDIER's, not the army's: above Easy a unit under
  `pullOutHp` (25 %) and standing in a fight is walked `PULL_BACK_DIST` behind the line and back
  in later (`pullPass`), on a PER-UNIT cooldown — without that timer it see-saws in and out of
  the battle instead of fighting in it — and a withdrawn CAPTAIN stops anchoring cohesion, or one
  hurt hero drags the whole army home. The Scroll of Town Portal is spent leaving a PLAYER; against
  a CREEP CAMP it is a LAST RESORT at 8 % (`LAST_RESORT_HP`) and nothing above it, because the
  hero has two cheaper answers there — the same walk out of the fight every other unit gets, at
  the higher bar the scroll used to fire at (`pullBar`), and `fightLost` taking the party home.
  Its army also moves as ONE BODY anchored on the CAPTAIN — the first hero trained, then
  the second — and nothing leaves the muster point until four fifths of it is there, with a
  deadline, because a gate with no deadline locked the hero at home. A STRANDED unit is that
  same lesson three more times, and each is an ORDER of tests rather than a number: "it is LOST"
  is asked before "it is in a fight" (`cohesionCall`), because past `FOLLOW_RADIUS` there is no
  fight to be pulled out of — only the unit and whatever found it; the captain's BODY is what is
  WITH it and not the mean of the whole squad, or one soldier across the map freezes the hero
  every other soldier is mustering on; and a HOLD has a deadline that ends in a REGROUP, since
  standing still only gathers an army while the body is closing. The muster pass must be able to
  REACH a straggler too: it skipped anything carrying a move or an attack order WHEREVER it
  stood, which is precisely the units that had come apart from it, and a fight in the sim ends
  with the unit still holding its attack order.
  CONTACT with an enemy army is measured against the whole COLUMN and never against the captain
  (`armyFrame`/`inContact`, shared by `contactPass` and `armyInReach` — a body one of them sees
  and the other does not is a column that stops walking without deciding anything): a march is
  walked under plain MOVE orders, which do not auto-acquire, so an enemy that met the tail while
  the hero was already past it was walked through under orders not to fight back. An objective it
  could not REACH is written off like a camp (`writeOff` → `Brain.avoid`, matched at a base's own
  width because the aim is whichever building was nearest us), and `pickTarget`'s LAST rung is a
  creep camp at ANY hero level — the level cap is a preference between a camp and an attack, and
  down there the alternative is an army standing in its base for the rest of the game. The first
  TEN MINUTES belong to the camps: below hero level 3 `waveReady` refuses, and because `creepNext`
  asks the same clock, a closed wave window is an OPEN creep window. An UNDEAD base is the one
  race-specific bar (`mayAssault`, 1.75 × `attackFood` ceilinged at the difficulty's own army cap,
  read off the target BUILDING's `race` rather than off the lobby). No worker is ever left idle
  (`AiPlayer.workIdleWorkers`, below `applyHarvest`: fill a mine short of its five, else the
  trees — the plan's catch-all last slice is the FOREST, which for the undead is nobody).
  A STRATEGY names the army a build wants to END UP with, so five of the twenty-one name nothing
  that exists at tier 1 — and `buildableMix` therefore falls back on the race's OPENING SOLDIER
  (derived, not named: the lowest-tier thing the barracks makes that NEEDS NOTHING ELSE
  STANDING, which is the Footman/Grunt/Archer/Ghoul). Without it the empty mix is a DEADLOCK
  rather than a slow opening, because every "don't tech with nothing on the field" gate is
  stated in ARMY FOOD: nothing trainable means no food means no buildings means nothing
  trainable. The undead looks exempt only because its Ghouls come out of the ECONOMY
  (`lumberUnits`) instead of the mix. The fallback yields the instant one row of the build
  order comes online, or every build quietly becomes "basic soldier, and tech".
  The BUILD LADDER's order is the strategy and seven positions in it were measured: the gold crew
  is first — LITERALLY first, with the hall rows and the undead's mine BELOW it, because it is
  also the dead-worker replacement and a raid is exactly when a building row above it halts the
  loop for ever (the shortfall would be cleared out of a mine nobody is standing in) — the FOREST
  crew is right behind it, the hero outranks the Barracks, the rest of the workers wait behind
  the hero, the SHOP goes with the opening, and UPGRADES sit with the tech buildings ABOVE the
  tier-up — below it they are simply never reached, which is the whole of "the AI never upgrades
  anything" — and at TIER 2 the SECOND HERO goes above all three of the Castle, the tech buildings
  and the upgrades (`tierTwoHero`), because a row does not have to be UNREACHED to be unaffordable:
  the loop spends a RUNNING budget, so with the hero merely above the expansion the rows over it
  took the gold before it was read, every pass, and ten of the twenty builds reached ten minutes
  at tier 2 with one hero. The forest crew and the shop are both the same lesson twice: a row is
  only "lower
  priority" if the ladder ever REACHES it, and `OneBuildLoop` returns at the first row it cannot
  afford. Lumberjacks below the hero DEADLOCK — five workers on the mine and one spare leaves ONE
  in the trees, the hero row wants 100 lumber, and the row that would hire a second lumberjack is
  underneath the row that is stuck (a night elf stood still from 0:30 to 4:45 with 2500 gold
  banked); and a shop below the army rows is never built at all, so nothing is ever bought.
  The CORE ARMY is the row directly above the tier-up and it therefore STOPS GROWING once that
  row is past its clock (`coreArmy`/`tierUpOverdue`, held at `TIER2_ARMY`) — an `army` row asks
  for one more soldier every pass for ever, so between the clock and the hall it is the same
  "there is always another soldier" leak seen from inside one row, and every race reached tier 2
  sooner for the hold with no smaller army at ten minutes. `TIER2_CLOCK` (180 s) is a DEFAULT and
  a race may want its second tier sooner: `PlusRaceTable.tier2Clock` is the HUMAN's 120, because
  the human's first power spike is entirely BEHIND the Keep (an Arcane Sanctum is `[hars]
  Requires=hkee`, so there is no cheap half to buy while it waits) and its opening is the
  dearest in the game. The Sanctum is a human SUPPORT row for the same reason — all five human
  builds name a Priest, a Sorceress or a Spell Breaker — while the Lumber Mill is a TIER-2
  support row, not the tier-1 one it was: nothing a human builds before a Castle needs it, and it
  was the only second tier-1 support row any race had, sitting above the tier-up. Two ID TRAPS that each cost a whole subsystem and are invisible from the call site:
  the undead altar is **`uaod`** (Altar of Darkness), NOT `utod` (Temple of the Damned, which is
  the CASTER building) — naming the wrong one left the undead with no hero and, because a hero row
  halts the build loop, no army either; and a BURROW is asked for by its hold's ability code
  **`Abun`**, never by "has a `garrisonCap`", because the Entangled Gold Mine (`Aenc`) has one too
  and standing its crew down every pass is most of the night elf's income.
  **Aiming is ONE ladder** ([`targeting.ts`](src/ai/plus/targeting.ts)) shared by its casters and
  its army — a hero who stuns the Tauren while every Footman beside him swings at the Shaman is
  two decisions that undo each other — and a difficulty grades the READ, not only the reaction:
  Easy aims by bulk (which is why its Storm Bolt lands on your Tauren), Insane prices what the
  spell is FOR. It also **does not chase heroes**: a healthy hero is worth barely more than a
  soldier and the army will not walk after one it cannot finish. And a single-target NUKE is
  never spent on a WORKER it cannot finish (`nukeWorthIt`) — Frost Nova's share to the unit it
  hits is 100 at every rank and no worker in the game has that little life — priced off the same
  data columns the sim's own handlers read, and enforced at LEGALITY so the misclick cannot land
  there either. MANA BURN is the one press aimed at a BAR rather than at a body (`manaBurnValue`):
  it is worth what it TAKES, `min(DataA, mana)`, so it goes on whoever has been SAVING their bar
  and never on the wounded — a HERO at 4× anybody else, its premium deliberately NOT scaled by
  `heroFocus` (that dial is the anti-chase rule, and a 300-range press at whoever is already in
  front of the Demon Hunter is not a chase), with the floor under it read off the TARGET's own
  cheapest `Cost1`: burn while it can still afford one of its own buttons. Its old `debuff`
  grading is why it never fired at all — `rolesFor` gives `debuff` to Insane alone, exactly as it
  once silenced Impale. A WAND OF ILLUSION is spent as a VANGUARD: the doubles are thrown a few seconds
  out from an ORANGE or RED creep camp, the body is STOPPED where it stands, and only the copies
  walk in — exempt from cohesion, because being in front is the whole job. The trap beside it is
  that an illusion is a PICTURE of the army and belongs in NONE of the readings the squad is
  judged by (`isCopy`): it deals no damage, arrives at full health, costs no food and is MEANT to
  die, so counting it prices the party for a camp it cannot take and makes the vanguard popping
  read as the army breaking. It DOES shop and drink
  ([`plus/items.ts`](src/ai/plus/items.ts)). A race's OPENING buy (`RACE_FIRST` — the orc's two
  Healing Salves, the human's two Scrolls of Regeneration, the undead's Rod of Necromancy, whose
  `AIrd` keeps its OWN code while carrying Raise Dead's whole `Rai1..Rai4` group) is bought out
  of the purse rather than out of the surplus above `itemReserve`, because a Normal computer's gold is almost never 300
  above anything and a 100-gold salve it can never reach is a Voodoo Lounge built for nothing. The
  same is true of the REPLACEMENT Town Portal (a replacement is not shopping) and of the race's
  MANA row (`RACE_MANA`) — which is not the same item for all four, because `[pclr]` needs a Tree
  of Eternity, only `[plcl]` is ungated, and the Tomb of Relics stocks NEITHER: the undead's mana
  is `pman`, whose `Requires = TWN2` is the tier-2 unlock the shop enforces by itself. An
  AREA heal is spent on three questions and not on a head-count (`armyHeal`): `CLUSTER` bodies in
  the circle, more than HALF the army inside it, and the party's POOLED health under `ARMY_HURT` —
  and the circle is the item's own `Area1`, never `LOOK`; with one clause beside it for the
  HERO alone (`selfRegenWorthIt`, the pouring kind only), since a hurt hero beside a whole army
  fails all three. A CLARITY POTION IS NOT A POTION OF MANA and they are two rungs: `AIrg` pours,
  so it is drunk only with nothing hostile in sight (any damage strips `ITEM_REGEN_GROUP`) and
  EAGERLY — `MANA_TOPUP` 75 %, with `manaRoom` so the pour is not wasted — while `AIma` restores
  at the press and asks nothing about the fight at all. One rung for both meant the eager one was
  gated on the exact state that throws it away. The trap beside all this is the one that
  broke almost the whole belt once: what a press is FOR is keyed on the ability's base **`code`**, never on
  `AbilityData.slk`'s `alias` — `AIh1` is `AIhe`, `AIm1` is `AIma`, and the Salve, both Clarity
  Potions, the Scroll of Regeneration and the Replenishment family are all one code `AIrg`, told
  apart by their own `Area1`/`Rng1` exactly as the sim tells them apart (docs/items.md).
  In a TEAM game it also TALKS ([`src/ai/plus/teamchat.ts`](src/ai/plus/teamchat.ts)) and shares
  what it has scouted. Every line goes out on the ordinary chat path on the **allies** channel —
  there is no second channel for computers — and everything it HEARS arrives the same way, gated
  on the recipient list `deliverChat` already computed and on the alliance matrix, so it can no
  more read chat it was not addressed than see through the fog. Two traps: the file's own
  vocabulary is read by its own parser, so a decline that parses as a request makes two computers
  answer each other for the rest of the match (`readAllyCall` tests the ANSWERS and then the
  declines FIRST, and `tools/ai-plus-teamchat-test.cjs` pins it); and nothing is acted on inside
  `heard`, which is called from the middle of chat delivery. It asks for HELP on two conditions —
  two opponents in its towns, or ONE that is overrunning it, which is a `powerOf` comparison
  rather than a count — and it announces WHO IT IS HITTING ("im going to hit the undead")
  whenever the wave sets off at a player, naming them by their RACE (`playerNames`, off
  `PlusHost.playerRace`), which is what a person says and what a teammate can act on without
  looking anything up. A POSITION is added only when another player shares that race ("the undead
  at the top", "the human in the middle") and is measured against THOSE PLAYERS rather than
  against the map's halves, so the words mean the same thing to speaker and listener; both ends
  run `playerNames` over the same seats with the SPEAKER LEFT OUT, which is what makes an undead
  computer's "the undead" the other one. The COLOUR is the fallback for a seat with no known race
  and for two starts in one quarter, which name NEITHER — an ambiguous name is worse than a
  swatch (`COLOUR_NAMES` is `UI\TriggerData.txt`'s own `playercolor` enum, asked of
  `PlusHost.playerColor` because `SetPlayerColor` can move one). An ally answers that with "im
  coming with you" and then actually comes; one that is not interested says NOTHING, because
  nobody types "no" every time a teammate attacks. NAMING SOMEBODY is also what keeps the
  announcement out of the help reading — a request for help names nobody — and both `namedRace`
  and `namedColour` match LONGEST FIRST, or a call to hit the undead in the top left is heard as
  a call on the undead at the top, exactly as light blue is heard as blue. Scouting intel
  is NOT chat — a sighting is written
  into every allied Computer+ player's `EnemyMemory` at the moment it is made — and it is not a
  fog bypass, because what travels is what somebody's own eyes saw.
  **A ROW THAT HALTS THE LOOP STOPS EVERYTHING UNDER IT**, and almost every "the AI just stands
  there" report is one row halting for a reason it should not. Four rules keep it moving and each
  cost a subsystem: a tier-up is priced off a STANDING source (`upgradeSources`, busy or not) —
  priced off the idle-only scan, a hall training a worker made a Stronghold read as 700/375
  instead of 315/190 and the ladder stopped there for most of the opening; the hall that a row
  means to upgrade takes NO WORKER that pass (`holdForUpgrades`), or the worker rows above the
  tier row keep its queue full and the upgrade can never start; the FOREST is never left empty
  (`LUMBER_DRY`), because a lumber shortfall with no lumber income never shrinks and the row that
  would hire a lumberjack is underneath the row it stopped on; and a halt that has stopped getting
  NEARER its price lets one pass through (`releaseStall`). Two rows whose price is a RACE's rather
  than the Human's: the SUPPLY row keeps one supply BUILDING's worth of food in hand and not a
  flat six (a Moon Well is 180/40, fifty seconds and ten food against a Farm's 80/20, thirty-five
  and six — six food of warning is a third of a well's build time, which is the night elf food
  block), and it counts that supply with **`townCountDone`, never `countDone`**: `startUnit`
  compares a row against the FOLDED count, and the undead's Ziggurat upgrades into its own TOWER
  (a Spirit Tower still makes ten food), so the plain-Ziggurat reading left a raided undead unable
  to build supply ever again. The UNDEAD's expansion is the HAUNTED GOLD MINE (`expand` founds it with
  `table.mineBuilding`, undead.ai's own `basicExpansion(…, UNDEAD_MINE)`), whose 210 lumber is the
  most of any undead building — so `mineBuildings` sits ABOVE the hall rows, where the loop's own
  halt protects the saving, or the 225-gold no-lumber Necropolis is bought first every pass and
  the mine never is. The bulk of the army is the LAST row,
  so anything that reserves gold above it — a second hero, an expansion, a tier — is production
  stopped: the floor that keeps an army on the field while it saves is `CORE_ARMY_FOOD`, and it
  grows with the tier for that reason. A second production building is bought with the BANK; the
  old `armyFood >= 40` gate was above two of the three difficulties' own army ceilings and could
  never fire. `tools/ai-plus-ladder-test.cjs` runs ten headless minutes of the ladder per build.
  **AMAI is GPL** — it was studied for the shape of the strategy table and nothing else; never
  lift its code or its numbers.
- **Never edit the install's UI files.** `UI\FrameDef\` is the player's. A control OpenWar3 needs
  that the 2003 UI has no frame for goes in [`src/overrides/`](src/overrides/) — our own FrameDef
  files, layered onto the screen at mount through `mountFdfScreen`'s `overrides` option — and its
  README is the contract.
- **Gameplay constants live in one place.** Every number the game itself keeps in `Units\MiscGame.txt` /
  `Units\MiscData.txt` / `Scripts\Blizzard.j` belongs in [`src/data/gameplayConstants.ts`](src/data/gameplayConstants.ts),
  under its **exact file key** (`MISC_GAME.GuardDistance`, `MELEE.MELEE_STARTING_GOLD_V1`). Never re-type such a value as a
  literal at its use site, and never hand-transcribe something the game derives — the damage table and the XP curves are
  computed from the raw `DamageBonus*` lists and `f(x) = A·f(x-1) + B·x + C` formulas so they cannot drift.
- **Closed SLK domains are enums**, not strings — `AttackType`, `ArmorType`, `WeaponType`, `MoveType`,
  `PrimaryAttribute`, `PlayerSlot` in [`src/data/enums.ts`](src/data/enums.ts). Parse once at the SLK boundary
  (`toAttackType(...)`), then let the compiler carry it. A stringly-typed `atkType1` silently degrades to a 1.0 multiplier.
- Match the surrounding code's comment density and idiom — this codebase documents *why* (and its WC3 source) inline.
