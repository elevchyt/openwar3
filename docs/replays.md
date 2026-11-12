# Replays

Issue #158. Every match that runs on this machine's sim is recorded, and a recording can be
watched again, as an observer, on the observer HUD, with a replay panel to pause, change speed
and go **back** in time — which the original never could.

| | |
|---|---|
| [`src/game/replay.ts`](../src/game/replay.ts) | the file format, the recorder, the player |
| [`src/game/replayHash.ts`](../src/game/replayHash.ts) | the state check, and (dev) the state dump behind it |
| [`src/game/replaySink.ts`](../src/game/replaySink.ts) | where the files go — the desktop shell or the dev server |
| [`electron/replayStore.mjs`](../electron/replayStore.mjs) | the one writer: `replays/` in the data folder, or the repo's `.replays/` under `pnpm dev` |
| [`src/game/replayUpload.ts`](../src/game/replayUpload.ts) | the uploader (switched off until there is somewhere to send to) |
| [`src/game/replayState.ts`](../src/game/replayState.ts) | the state track: the match once a game second |
| [`src/ui/replayPanel.ts`](../src/ui/replayPanel.ts) | the replay panel in the observer HUD |
| [`src/ui/fdfViewReplay.ts`](../src/ui/fdfViewReplay.ts) | the View Replay screen |
| [`src/ui/saveReplayDialog.ts`](../src/ui/saveReplayDialog.ts) | the score screen's Save Replay panel |
| [`electron/dataDir.mjs`](../electron/dataDir.mjs) | the data folder the replays live in |
| `MapViewerScene.beginReplay` / `replayApply` / `replayStepDone` / `closeReplay` | the scene's half |

## A replay is the inputs, not the picture

A Warcraft III replay stores no video. It stores how the match was set up and every input the
players gave it, and watching it is re-simulating the match. Ours is the same, and the engine was
built for it (docs/multiplayer.md Phase A): the sim advances in whole 1/60 s steps (`simTick`),
every roll comes off one seeded stream, ids come from the map rather than from load order, and
every action any seat takes passes through ONE door, `Authority.execute`.

An INPUT is anything that changes the match and does not come out of the match:

| kind | recorded at | replayed through |
|---|---|---|
| `cmd` | `Authority.execute` (`onCommand`), every seat — **the AIs included** | `RtsController.executeReplay` |
| `chat` | `deliverChat`, the authority's routing | `deliverChat` (the map hears it again; the watcher reads it) |
| `ping` | `deliverSignal` | `showSignal` (a watcher sees everybody's) |
| `sel` | the script's selection pump (`pumpMapScript`) | the same pump, from the file |
| `dlg` / `frame` / `pev` | `Interpreter.inputTap` — a dialog button, a frame event, a player event | the interpreter's own `fire*` |
| `cheat` / `cheatsel` | `RtsController.onCheat` / `onCheatSelected` | `cheat(kind, player)` / `cheatSelected(kind, ids)` |
| `lock` | `summonBirth` — a summon's spawn lock, read off its MODEL | written straight onto the unit |

What is NOT an input replays itself: the map's triggers, timers and orders (they go through the
authority's own methods, never `execute`), the creeps, and a map's own AI SCRIPT (a campaign's
`.ai`, Monolith's creep players), which orders through the same engine hooks the triggers do and
therefore RUNS on playback — what it passes through `execute` is not recorded (`inScriptAi`).

The computers of the race AIs and Computer+ are SEATED on playback but never think
(`RtsController.replayAiInputs`): their decisions are in the file, handed back at the point of the
step they were made. A change to an AI therefore never breaks an old replay.

### When: the step and the PHASE

Every input carries the step it landed in (`t`, counted from the match's own start, not the
scene's) and the phase of that step (`Phase`): between frames, at the start of a step, inside the
controller's AI block, after it. Order inside one step is part of the match — a computer decides
after the inputs that arrived between frames and before the world steps — so playback hands each
one back at the same point (`replayInject`).

## What had to change for it to be exact

Two things in the engine depended on how fast THIS machine was, and each made every replay part
from its recording within seconds:

1. **The world stepped during the loading screen.** Setup is seconds of the map's art streaming
   in, and the frame loop kept stepping through it — a critter's wander clock, set on its first
   step, was different every time. The world is now held from `beginMatch` (the hold that
   already existed for "press any key", taken earlier): built and adopted while held, begun on the
   release.
2. **A unit came into existence when its MODEL arrived.** A building's foundation, a summon, an
   entangled or haunted mine were made in `spawnUnit`'s `.then` — a browser fetch, which with
   several steps to a frame (a boosted sim, a slow frame) landed a few steps later. They are now
   made on the step (`spawnUnitNow`: the record, its pathing stamp, its decal) and the body streams
   in behind, as trained units and script units already were; a script-created building's stamp
   goes down on the step too. The one fact a summon still takes from its model — the spawn lock its
   Birth clip times — is carried in the file (`lock`).

## The state check

Every `CHECK_EVERY` steps (ten game seconds) the recorder hashes the world (`stateHash`: the
roll count, every unit's type, owner, position, life, mana and order, every bank), and playback
compares at the same step. A mismatch is logged once (`[replay] the match has parted…`) and the
panel's timeline turns red. In a DEV build the recording also keeps the state BEHIND each check
(`DUMP` section, `stateDump`), and a parted playback prints the first units that differ
(`diffDumps`) — that is how both of the fixes above were found. `?dev&replaycheck=10` checks every
ten steps instead, to find the very step a playback parts at (both runs must use it).

Verified: two Insane Computer+ players on Echo Isles, 16:51 of game time (4 669 inputs), recorded
at 100× Sim Speed and played back with all 100 checks passing; and the first 94 s checked every
ten steps (565 checks) at 40×.

## The file

`.o3r`. A magic (`OW3R`), a format number (`REPLAY_FORMAT`, bumped only when an old reader could
not read the new file), then tagged sections `[tag:4][length:u32][gzip'd JSON]`: `HEAD`, `EVTS`,
`CHKS`, `CAMS` (the recording player's camera, six times a second — not an input, but the
person's own view and training material), `STAT` (the state track, below), `ENDS` (the result),
and in a dev build `DUMP`. A reader skips a tag it does not know, so a new section is not a new
format. Measured, two Insane Computer+ players on Echo Isles for ten minutes: 186 KB in a dev
build — `STAT` 138 KB, `EVTS` 21 KB (2 065 inputs), `DUMP` 25 KB, the rest under 2 KB.

The header holds the OpenWar3 version, the map (its install path, name and a hash of its bytes —
the same name is not the same map), the lobby's config RESOLVED (the seed it rolled with, every
Random race already rolled), every seat as `human` or `computer` (and which AI, at what
difficulty), whom the recorder was (`GetLocalPlayer` answers with it on playback), the edition and
the patch level.

## The state track

A replay is exact without it, but reading a thousand matches by re-simulating each to find out
where the army was is the slow way round, and a much later OpenWar3 may not re-simulate an old
replay exactly. So once a game second (`STATE_EVERY`, ours) the recorder also writes what the
match LOOKED like (`StateTracker`): per unit `[id, type, owner, x, y, facing°, hp, mana, order,
target, hero level, items]`, per player `[gold, lumber, food used, {upgrade: level}]`. It is a
DELTA track — a sample holds the rows that CHANGED since the last one and the ids that are gone,
rounded to whole numbers so a unit drifting a hair is not news — and `expandStates` turns it back
into full pictures. It is the bulk of the file (above): about 14 KB a game minute in a one-on-one.
Not in it: what each player could SEE (re-simulate with the fog for that).

## Where it goes

The desktop app keeps them in `replays/` in OpenWar3's own data folder (`%APPDATA%\openwar3`,
`~/.config/openwar3`), beside `settings.json` and the match logs, and never in Warcraft III's (the
developer's call). That folder holds only OpenWar3's own files; the browser engine's — including
the Local Storage the options and profiles live in — are in `Chromium/` under it
(electron/dataDir.mjs, which moves an older install's files there on its first launch). Every
match that recorded leaves `LastReplay.o3r` (WC3's `LastReplay.w3g`), overwritten by the
next. A campaign chapter is not recorded.

**A LAN game** is recorded by the HOST alone — the one machine that simulates the match whole —
and every other player gets the host's file when the game ENDS, and only then (the developer's
call; nobody can ask for it mid-match). When the match is decided, the host stamps the "over"
dialog it relays with `replay` and then sends the file (MatchLink `replaypart`, 48 KiB pieces,
addressed so it rides each peer's direct lane); the client keeps its wire up until it has
arrived (`awaitPeerReplay`, at most 30 s) and keeps it as its OWN `LastReplay` — and in
`Autosaved/` under its own option — so its score screen's Save Replay saves it. A host that
leaves mid-match ends the game for everybody, so it sends the file then, as it stands. A client
that quits mid-match gets none. Only the host's copy is offered to the uploader.

Getting it there found a bug in the direct links: `RTCPeerConnection.close()` throws away what
its data channels still have queued, so the last messages before a hang-up were lost whenever the
lane was direct. `DirectLinks.close` now waits for the lanes to drain (`DRAIN_MS`, then
`CLOSE_GRACE_MS`) before it tears them down.

Verified live with two headless clients on Echo Isles: three decided matches out of three handed
the replay over (it failed two in three before the drain fix), and a host quitting at 2:31 left
both machines the same 8 537-byte file, which played back with 15 of 15 checks passing. The
recordings hold both seats' commands and chat. Custom maps: six minutes of DotA v6.77b AI (its
computer heroes are the map's own triggers, so one recorded input) passed 36 of 36 checks, and
six minutes of WarChasers with a Computer+ party passed 37 of 37. Under `pnpm dev` the folder is the repo's `.replays/` (gitignored); `?dev&replay` (or
`&replay=<name>`) watches one, mounting its map.

Two of the game's own screens keep and find them:

- **Save Replay** on the score screen opens the game's `SaveReplayPanel` (ScoreScreen.fdf): the
  replays already saved, a name box, Save / Delete / Cancel, asking before it overwrites or
  deletes (`OVERWRITE_REPLAY_MESSAGE`, `DELETE_REPLAY_MESSAGE`). It copies the match's
  `LastReplay` under the name, after waiting for that file to be written; the button then reads
  "Replay Saved". It is shown only when the match was recorded.
- **View Replay** (Single Player) lists the folder — `LastReplay`, the saved ones, and the
  game's `Autosaved` folder as a folder row — and shows the highlighted replay's map and player
  count in the summary pane. A replay whose map is not installed says so and cannot be watched.
  One recorded by another OpenWar3 asks first, in the game's own words (`REPLAY_CONFIRM_DESC`,
  the recorded and the running build).

## Watching one

The observer HUD (docs/observer-hud.md), with the REPLAY PANEL where Auto Camera stood
(`src/ui/replayPanel.ts`, one panel above the selection, its width — the developer's pick of three
layouts): pause, the game's own speed buttons (`ReplaySpeedUpIcon` /
`ReplaySpeedDownIcon`, keys `+`/`-`, ¼× to 16×), restart, fifteen-second skips both ways, a
timeline to click or drag, and the game's `ReplayFogCheckBox` beside Auto Camera — on, the match
as its players saw it (a watcher's viewpoint counts every player's sight, `Viewpoint.revealsForOwner`),
off, the whole map. Every recorded chat line and ping is shown. The replay stops at the end of the
recording: past it nobody's inputs exist.

A seek FORWARD races (`advanceSim`: the steps owed to the target, a frame's budget at a time,
silent). A seek BACK plays the replay again from its start and races (`main.ts` `rewindReplay`),
carrying the camera, speed, fog, pause and Auto Camera across (`MeleeConfig.replayResume`):
6:00 → 3:00 took 11.6 s on the dev machine. A PAUSED replay keeps running the entry sync
(`settleHeld`) so the bars, the hover and the fog follow the camera as the watcher pans.

## Not done yet

- Rewinding re-plays the match from its start, so a seek far back takes as long as re-simulating
  that much; keyframes need the JASS VM's sleeping threads (generators) to be serialisable.
- Watching a replay recorded by another OpenWar3 in THAT version (issue #158, "Versions": a
  per-release replay bundle, fetched into a temporary sandbox). Today the player is asked and it
  plays on this build, and the checks say how far it got.
