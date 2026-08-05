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
  `ReplaceableTextures\CommandButtons\BTNSkillz.blp` (the `CommandButtonsDisabled\DIS*` twin of any icon is just
  its desaturated "unavailable" art — never reach for it for a live button); spell AoE circles are
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
- **Illusions:** read [`docs/illusions.md`](docs/illusions.md) before touching Mirror Image (`AOmi`), the Wand of
  Illusion (`AIil`), or anything that copies a unit. An illusion's whole point is that the ENEMY can't tell it from
  the original, so every tell (blue wash, summon timer, portrait) is gated on the LOCAL viewpoint, and its
  no-damage rule is enforced at the blow — not by editing what it shows.
- **Campaigns:** read [`docs/campaigns.md`](docs/campaigns.md) before touching the campaign screen, its data, or the
  chapter-start path. The whole campaign is ONE text file (`UI\CampaignStrings_exp.txt`) that documents itself, and
  three of its rows break the obvious parse (a comma inside quotes, a fourth field, a "mission" that is a `.mdl`).
  The screen is also the one glue screen with **no panel chrome** — the campaign's 3D backdrop is the screen.
- **Loading screens:** read [`docs/loading-screens.md`](docs/loading-screens.md) before touching `Loading.fdf`, the
  `[LoadingScreens]` table, or the start-of-match path. The w3i field that picks a map's screen is the one the
  parsers call **`campaignBackground`** (the int AFTER the subtitle is not a screen at all), the art is flat 2D in
  the FDF's own 0.8×0.6 box rather than a 3D scene, and the load bar carries no keyframes — its fill is a bone the
  engine scales. It is also the one screen laid out **stretched** rather than height-scaled, because it is a
  picture with things printed on it.
- **Gameplay constants live in one place.** Every number the game itself keeps in `Units\MiscGame.txt` /
  `Units\MiscData.txt` / `Scripts\Blizzard.j` belongs in [`src/data/gameplayConstants.ts`](src/data/gameplayConstants.ts),
  under its **exact file key** (`MISC_GAME.GuardDistance`, `MELEE.MELEE_STARTING_GOLD_V1`). Never re-type such a value as a
  literal at its use site, and never hand-transcribe something the game derives — the damage table and the XP curves are
  computed from the raw `DamageBonus*` lists and `f(x) = A·f(x-1) + B·x + C` formulas so they cannot drift.
- **Closed SLK domains are enums**, not strings — `AttackType`, `ArmorType`, `WeaponType`, `MoveType`,
  `PrimaryAttribute`, `PlayerSlot` in [`src/data/enums.ts`](src/data/enums.ts). Parse once at the SLK boundary
  (`toAttackType(...)`), then let the compiler carry it. A stringly-typed `atkType1` silently degrades to a 1.0 multiplier.
- Match the surrounding code's comment density and idiom — this codebase documents *why* (and its WC3 source) inline.
