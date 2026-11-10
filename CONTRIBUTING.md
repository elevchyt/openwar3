# Contributing to OpenWar3

Thanks for helping. This page covers the setup, the checks we run before a change lands, and the
few conventions that keep the codebase honest about where its numbers come from.

If you are only reporting a bug, you do not need any of this — open an issue with the template and,
if you can, a screenshot or a replay.

## Setup

You need **Node 20 or newer** and **pnpm 10.33.1** (the version pinned in `package.json`'s
`packageManager` field). The simplest way to get the right pnpm is Corepack:

```bash
corepack enable
pnpm install
pnpm dev          # http://localhost:5173
```

`pnpm app` runs the desktop shell and needs `pnpm build` first.

**The Frozen Throne 1.30.4 is required at runtime.** OpenWar3 ships no Blizzard assets and no game
data: it mounts your own install and reads the files from it. A legacy MPQ-era install still
mounts, and 1.31.1 is accepted and downgraded, but 1.30.4 is what the project targets.

If you are doing data work, unpack your install once:

```bash
pnpm data:extract     # writes Warcraft III/ExtractedData/
```

## Checks before a pull request

Run the checks that cover what you changed. The first two need no game install at all:

| Command | Needs an install? | What it covers |
|---|---|---|
| `pnpm typecheck` | no | `src/` and the Node half (`vite.config.ts`, `tools/*.ts`) |
| `pnpm cycles` | no | import cycles across the tree |
| `pnpm sim:test` | **yes** | the sim, AI, pathing, spells and rendering-headless suites |
| `pnpm jass:test` | **yes** | the JASS runtime, natives, triggers and corpus |
| `pnpm relay:test` | no | the LAN relay and loopback paths |
| `pnpm app:test` | no (needs `pnpm build`) | the desktop server and beacon |
| `pnpm data:verify` | **yes** | `src/data/gameplayConstants.ts` against the unpacked data |
| `pnpm casc:test` | **yes** | the CASC mount against your install |

`sim:test` and `jass:test` compile a throwaway CommonJS build into `.sim-build/` and then drive it
from Node, so they are the slow ones. If a change touches data, run `pnpm data:verify` too — it is
the check that catches a hand-typed constant.

A documentation-only change needs no checks beyond a read-through.

## Conventions worth knowing up front

- **Cite the source next to the code.** When a constant or behaviour comes from the game's own data,
  a reference thread or an RE note, name it in a comment right there. The codebase does this
  everywhere and it is the single most useful thing you can add for the next reader.
- **Gameplay constants live in one place.** Every number from `Units\MiscGame.txt`,
  `Units\MiscData.txt` or `Scripts\Blizzard.j` belongs in `src/data/gameplayConstants.ts`, under its
  exact file key. Never re-type such a value as a literal at its use site.
- **Closed SLK domains are enums.** `AttackType`, `ArmorType`, `WeaponType`, `MoveType`,
  `PrimaryAttribute` and `PlayerSlot` are parsed once at the SLK boundary and then carried by the
  compiler. A stringly-typed `atkType1` silently degrades to a 1.0 multiplier.
- **Match the surrounding density.** Comments explain *why*, and often which source settled it.

## Screenshots for visual changes

Anything a player can see — HUD, menus, rendering, camera, effects, terrain, fog — should be
checked in the running game, not only in a typecheck. Attach before/after screenshots to the pull
request. `(2)EchoIsles.w3x` is the canonical test map, and `?dev` boots straight into an install you
have already pointed the app at.

If you cannot run the game (no install, or the change is behind one you cannot reach), say so in
the pull request rather than leaving the reviewer to guess.

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep the change to one thing. A fix and an unrelated rename in one PR is two PRs.
3. Run the checks above and paste the commands you ran, plus what they printed.
4. Write the PR body with the template: what changed, why, how it was tested, screenshots if it is
   visible.
5. Link the issue it closes (`Fixes #123`).

Small, focused, tested changes get merged quickly. If a change needs a design decision, open an
issue first — the maintainer would rather discuss the approach than review a rewrite of it.

## Legal boundary

OpenWar3 ships **zero Blizzard assets and no Blizzard code**. Assets are read from the user's own
install at runtime. Do not add game files, extracted art, decompiled code or GPL reference code to
the repository; the reverse-engineering notes under `docs/reverse-engineering/` are documentation of
behaviour and naming only. Code you contribute is licensed under the MIT License.
