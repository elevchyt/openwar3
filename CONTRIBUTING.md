# Contributing to OpenWar3

Thanks for wanting to help. OpenWar3 re-creates the **Warcraft III: The Frozen Throne 1.30.4**
engine in TypeScript, and the goal of every change is to be **as close to the original game as
possible** — its behaviour, timings, layout, names and feel.

This page is the newcomer's guide. [`CLAUDE.md`](CLAUDE.md) is the long-form standing guidance
(written for coding agents, but every rule in it applies to people too), and the
[`docs/`](docs/README.md) folder holds one deep-dive per subsystem — read the matching one before
touching that area.

## Setup

You need:

- **Node.js 24** (the version the dev box, the desktop app's Electron and `@types/node` all target).
  It is pinned in `.nvmrc` (`nvm use`) and in `package.json`'s `engines`.
- **pnpm 10.33.1** — the exact version is pinned in `package.json` (`packageManager`), so the
  easiest way is `corepack enable` and letting it pick the right one.
- A **Warcraft III: The Frozen Throne 1.30.4** install — only for running the game and the
  data-backed tests (see [below](#which-checks-need-a-warcraft-iii-install)). Plenty of work
  (docs, tooling, the relay server, the desktop shell, many sim tests) needs none.

```bash
pnpm install
pnpm dev     # http://localhost:5173 — point it at your Warcraft III folder when asked
```

`pnpm build` typechecks and builds; `pnpm app` runs the desktop app after a build.

### Your game data

For the headless tools and tests, put (or symlink) your install at **`Warcraft III/`** in the repo
root — the whole folder is gitignored — and unpack its readable data once:

```bash
pnpm data:extract
```

That writes `Warcraft III/ExtractedData/` (`.slk`, `.txt`, `.j`, `.fdf`, …), which you can grep
when you need to know what the game really does. `pnpm data:extract --wc3-dir <path>` reads an
install from somewhere else.

## The legal boundary

OpenWar3 ships **zero Blizzard assets or code**. Game files are read from the player's *own*
install at runtime and never committed, uploaded or bundled.

- Never commit anything out of `Warcraft III/` — no models, textures, sounds, maps, `.slk`/`.txt`
  tables, `common.j`/`Blizzard.j`, or text copied from them.
- Reverse-engineering notes in `docs/reverse-engineering/` document **behaviour and naming only**.
  Never lift Blizzard binaries or decompiled code.
- GPL reference projects (Warsmash, AMAI, …) are for *studying*, never for copying code or numbers
  — OpenWar3 is MIT.

## Before you open a pull request

The one command is `pnpm test`: it runs every check below that your checkout can run, and skips
the rest with a line saying what each one is waiting for.

```bash
pnpm test
```

CI runs `pnpm test` on every pull request (`.github/workflows/ci.yml`) on a checkout with no
install, so everything that needs no game data is checked there: the typechecks, the import-cycle
check, the relay suite and every sim/JASS test that does not read the data — 170 of the 231.

The suites it runs, if you want one on its own:

```bash
pnpm typecheck      # tsc over the app and the Node/tooling config
pnpm cycles         # fails on any import cycle
pnpm web:typecheck  # the landing page (`pnpm --dir web install` first)
pnpm relay:test     # multiplayer relay server + loopback (compiles .sim-build/ first)
pnpm sim:test       # simulation, AI, rendering helpers, data overlays, net, saves
pnpm jass:test      # the JASS / Lua trigger runtime
pnpm app:test       # desktop shell's local server + LAN beacon — needs `pnpm build` first
```

The test suites are lists in [`tools/tests.mjs`](tools/tests.mjs), run by
[`tools/run-tests.mjs`](tools/run-tests.mjs). A failing test does not stop the run: every test
runs and the summary at the end names each one that failed. Without `pnpm data:extract`, the
tests marked `data` there are skipped with a line saying so and the rest still run.

```bash
node tools/run-tests.mjs sim pathing harvest   # only the tests whose file name has one of the words
node tools/run-tests.mjs sim jass --jobs 6     # six at a time
node tools/run-tests.mjs sim jass --free       # exactly what CI runs, even with the data here
node tools/run-tests.mjs sim --list            # the plan, without running it
```

**Adding a test:** put its file in the right suite in `tools/tests.mjs`, with `data: true` if it
reads `Warcraft III/` (a test that cannot find the data should stop with
``Run `pnpm data:extract` first …`` and exit code 2, rather than a stack trace). A test that needs
the data and is not marked fails CI; `node tools/test-plan-test.mjs` fails if a `tools/*-test.*`
file is run by nothing.

Run whichever suite covers what you changed; if you touched `src/data/gameplayConstants.ts`, also
run `pnpm data:verify`.

`pnpm install` also installs a **pre-commit hook** (husky, `.husky/pre-commit`). When a commit
touches a file the ability audit scans (`src/sim/`, `src/data/abilities.ts`/`items.ts`,
`rts.ts`, `mapViewer.ts`) and you have the unpacked data, it regenerates
`docs/abilities-audit.md` and adds it to the same commit. Without the install it does nothing —
a maintainer's next commit catches the table up. `HUSKY=0 git commit …` skips it.

### Which checks need a Warcraft III install

| Check | Needs the install? |
| --- | --- |
| `pnpm typecheck`, `pnpm cycles`, `pnpm build`, `pnpm web:typecheck` | No |
| `pnpm test` | No — it skips whatever your checkout cannot run, and says why |
| `pnpm relay:test` | No |
| `pnpm app:test` | No — but it needs `dist/`, so run `pnpm build` first |
| `pnpm sim:test` | Partly — 24 of its 189 tests read the real tables, models and maps |
| `pnpm jass:test` | Mostly — 37 of its 42 tests run the install's own `common.j` / `Blizzard.j` |
| `pnpm data:verify`, `pnpm versions:test`, `pnpm casc:test`, `pnpm campaign:test`, `pnpm map:compat:test`, `pnpm jass:coverage`, `pnpm patches:check` | **Yes** |

You can still run any single test on its own: compile once (`tsc -p tools/tsconfig.sim.json` for
`sim-*`/`ai-*` tests, `tsc -p tools/tsconfig.jass.json` for `jass-*` tests), then
`node tools/<name>-test.cjs`.

If you could not run a suite, just say so in the PR — that is fine.

## Conventions worth knowing up front

- **Match the original game, and cite where you got it.** Don't guess at a mechanic or invent a
  value. The game's own data in the install is the ground truth; then
  [`docs/REFERENCES.md`](docs/REFERENCES.md); then Hive Workshop threads and the classic
  battle.net basics pages. Put the source in a comment next to the constant or behaviour — the
  codebase already does this everywhere, so match its style.
- **Gameplay constants live in one place:**
  [`src/data/gameplayConstants.ts`](src/data/gameplayConstants.ts), under the game's exact file
  key (`MISC_GAME.GuardDistance`, `MELEE.MELEE_STARTING_GOLD_V1`). Never retype such a value as a
  literal where it is used, and never hand-transcribe something the game derives (the damage table,
  the XP curves).
- **Closed SLK domains are enums**, not strings — `AttackType`, `ArmorType`, `MoveType`, … in
  [`src/data/enums.ts`](src/data/enums.ts). Parse once at the SLK boundary, then let the compiler
  carry it.
- **Prefer the real asset.** If Warcraft III has a model, texture, icon or sound for something, use
  its real path from the install rather than drawing a placeholder.
- **Never edit the install's UI files.** A control the 2003 UI has no frame for goes in
  [`src/overrides/`](src/overrides/).
- **Fix the engine, not the map.** If a custom map misbehaves, fix the mechanism it uses rather
  than special-casing the map.
- Comments explain *why* (and which WC3 source says so); match the density of the code around you.

Where things live: the simulation in `src/sim/`, game glue in `src/game/`, rendering and the
command card in `src/render/`, the HUD in `src/ui/`, data tables in `src/data/`, audio in
`src/audio/`, the AIs in `src/ai/`, the virtual file system (CASC/MPQ) in `src/vfs/`.

## Screenshots

For any visual change — rendering, HUD, camera, effects, terrain, menus — screenshots (before and
after, if you can) are **optional but highly appreciated**. `(2)EchoIsles.w3x` is the usual test
map: with the install at `Warcraft III/` (or `OPENWAR3_INSTALL` pointing at it),
`http://localhost:5173/?dev&map=EchoIsles` skips the menus and boots straight into a match there.

## Reporting bugs and requesting features

Use the issue templates. For a bug, the most useful things are the **map**, the **steps**, what you
**expected** against what **happened**, and a screenshot — plus whether it was the desktop app or a
browser, and which edition (Reign of Chaos / The Frozen Throne).
