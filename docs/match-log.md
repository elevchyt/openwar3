# The match log — every match writes down what happened

The developer's: *"can we have each match produce a log file (even matches on the release client)
that records everything that happened in the match … so that we can actually test tons of matches
and record their progress … to see if things went as planned (this is especially good for testing
out Computer+ AI)."*

So every match, in a release build and under `pnpm dev` alike, writes a plain-text record of
itself into a `.logs/` folder:

| | where the file goes |
|---|---|
| the desktop app (release) | `<userData>/.logs/` — OpenWar3's own data folder, beside its `settings.json` (`~/.config/OpenWar3/.logs/` on Linux, `%APPDATA%\OpenWar3\.logs\` on Windows) |
| `pnpm dev` | the repo's own `.logs/` (gitignored), beside the opt-in perf recorder's sessions ([perf-logging.md](perf-logging.md)) |
| a plain web build | nowhere — a page has no disk |

File name: `<local date>_<time>_<map>.log`, e.g. `2026-10-25_14-03-22_Echo-Isles.log`.

## The pieces

| | |
|---|---|
| [`src/game/matchLog.ts`](../src/game/matchLog.ts) | the recorder: what it looks at, and the line format |
| [`electron/logStore.mjs`](../electron/logStore.mjs) | the ONE writer — the size cap, the roll-over, the three-day sweep |
| [`electron/main.mjs`](../electron/main.mjs) / [`preload.cjs`](../electron/preload.cjs) | the release door: `ow3native.matchLog` → `<userData>/.logs/` |
| [`tools/vite-plugin-match-log.ts`](../tools/vite-plugin-match-log.ts) | the dev door: `POST /matchlog/*` → the repo's `.logs/` (`apply: "serve"`) |
| `MapViewerScene.tickMatchLog` / `closeMatchLog` | opens it when the start gate lifts, closes it in `stop` with the score screen |
| `ComputerPlusAi.logReport` | each Computer+ seat's build, mode, target and scouting, read-only |

## What a log says

A header (`#` lines): the map, version, edition, patch level, mode, game speed, seed, and every
seat — `P1 Computer+ — orc, team 2, Computer+ (Insane)`. Then one line per event, stamped with
the GAME clock, and `P<n>` wherever it is about a player — so `grep ' P1 '` is that player's
whole match:

```
[02:41] P0 hero Archmage "Antonidas" (level 1)
[03:12] P1 built Barracks
[06:05] P0 Town Hall -> Keep (upgrading)
[06:30] P1 trained 2 Grunt, 1 Peon
[07:40] P1 AI mode massing -> attacking (target P0 Town Hall)
[07:52] P0 lost 3 Footman, 1 Peasant (to P1)
[08:10] P0 lost hero Paladin "Uther" (level 4) — killed by P1 Blademaster
[08:11] P1 killed creeps: 3 Gnoll, 1 Gnoll Poacher
[09:30] P1 researched Berserker Upgrade
[09:30] STATUS P1 gold=310 lumber=140 food=54/70 workers=16 heroes=[Blademaster L5, Shadow Hunter L3]
[09:30] STATUS P1 army=[6 Head Hunter, 4 Grunt, 2 Shaman]
[09:30] STATUS P1 buildings=[…]
[09:30] STATUS P1 AI build=massgrunts>taurens mode=attacking squad=48food target=P0 Keep enemy=seen 14 air 0 ranged 6
[09:30] PERF fps=58 speed=Fast units=212
```

Events: buildings begun / finished / upgraded / lost (with the killer), units trained (summed per
player per second), heroes hired, levelled, killed (with the killer) and revived, research by
rank, unit losses summed per second by who killed them, creep kills, Computer+ build transitions
and every change of AI mode or target, chat lines, cheats, game-speed changes, and each player's
VICTORY/DEFEAT. Every 30 game seconds a STATUS block per player (bank, food, workers, heroes,
army, buildings), one per Computer+ seat, and a PERF line (frame rate, speed, unit count). The
close is the score screen as text — result, unit/hero/resource score, units produced/killed,
largest army, gold, lumber, upkeep lost, tech %, heroes.

## How it stays light

- **It looks once a game-second, by diffing.** It walks the unit table and compares it with what
  it saw a second earlier — births, a building's `constructionLeft` reaching 0, a type change, a
  hero's level, a research level — instead of hooking the sim's internals. The ONE hook is a
  death (`SimWorld.deathObserver`), because only the moment of death knows the killer. It never
  measures a frame; that is the opt-in perf recorder's job.
- **Lines are buffered and flushed every 5 s** (and on `pagehide`), so a crash loses at most
  five seconds — the matches worth reading are often the ones that ended badly.
- **About 1 MB per file.** `logStore` rolls a match that writes more into `<name>.part2.log`,
  `.part3.log`… at a line boundary, each beginning `# continued from …`. A 40-minute four-player
  match is a few hundred kilobytes, so most never roll.
- **Nothing older than three days.** Every file in `.logs/` whose last write is older than that is
  deleted when the app (or dev server) starts and again whenever a match begins — the perf
  recorder's own sessions included.
- **Only the authority records.** Single player and a LAN host; a LAN client's world is a
  fog-limited copy and would record a match it cannot see.

## Testing many matches: the Sim Speed cheat

The dev tools drawer (`toolsofthetrade` in chat) → Cheats → **Sim Speed**: the game's pace as a
PERCENTAGE of its Game Speed rung, 100 % (off) up to 10 000 % — type a number and press Enter, or
take a preset (300 / 1000 / 3000 / 10000 %). Single player only, like every cheat
(`MapViewerScene.setSpeedBoost`). The sim still takes whole fixed steps, so a boosted match plays
out exactly as it would at 100 % — only sooner — and the catch-up cap grows with it; a boosted
frame never spends more than `BOOST_FRAME_MS` (100 ms) stepping, so the window keeps answering
and the machine, not the number, decides the real ceiling. The log records the change
(`sim speed 3000% (cheat)`) and every PERF line carries the speed in force.

The loop this was built for: `?dev&map=EchoIsles&ai=plus-insane&observe&seed=7` (an observed
Computer+ match), open the drawer, set the pace, let it play out, and read the newest `.log`.
