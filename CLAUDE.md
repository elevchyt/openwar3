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
  and it is keyed on the BASE ability code, which is the thread's own point.
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
  units over instead of the AI demolishing its own base.
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
