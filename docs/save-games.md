# Saved games

Issue #159. A single-player match — melee, custom map or campaign chapter — can be saved from the
F10 menu's **Save Game** and loaded again from its **Load Game**, or from the Single Player
menu's **Load Saved Game**. The files are `.o3s`, in `saves/` beside `replays/` in OpenWar3's
data folder (`%APPDATA%\openwar3\saves`, `~/.config/openwar3/saves`); under `pnpm dev` the repo's
own `.saves/`; in a plain web build the page's IndexedDB.

| | |
|---|---|
| [`src/game/save/graph.ts`](../src/game/save/graph.ts) | the object-graph codec every save is written with |
| [`src/game/save/classes.ts`](../src/game/save/classes.ts), [`gameClasses.ts`](../src/game/save/gameClasses.ts) | every class that can be part of a match's state, and its non-state fields |
| [`src/game/save/matchSave.ts`](../src/game/save/matchSave.ts) | the roots, and the data-table rows written as KEYS (externals) |
| [`src/game/save/saveFile.ts`](../src/game/save/saveFile.ts) | the `.o3s` file and the version check |
| [`src/game/save/saveSink.ts`](../src/game/save/saveSink.ts), [`electron/saveStore.mjs`](../electron/saveStore.mjs) | where the files go |
| [`src/jass/interpreter.ts`](../src/jass/interpreter.ts) `Trace`, `captureThreads`, `restoreThreads` | the script's sleeping threads, as data |
| `MapViewerScene.captureSave` / `applySave` / `captureScene` | the scene's half |
| [`src/ui/escMenu.ts`](../src/ui/escMenu.ts) | the F10 Save / Load panels (`EscMenuSaveGamePanel.fdf`) |

## A save is the match's memory, not a replay

Warcraft III's own `.w3z` is the engine's memory written down, and so is ours: loading one costs
what loading the map costs, however long the match had run. (A replay is the other approach —
the inputs, re-simulated — and loading a 40-minute chapter that way would take minutes.)

What makes that possible is that a match's state is plain data. A unit names its target by id, a
JASS handle is a number, a trigger names its functions by name, the random streams are numbers
(`SimWorld.rngState`, `Mulberry32`). So the save is not a hand-written list of fields per class —
that is the list that falls behind the day a field is added, and silently — but the whole object
GRAPH reachable from three roots:

- `sim` — the world: every unit, item, corpse, mine, tree, missile, the banks, the tech, the clock,
  the random stream, the pathing grid with its stamps, the blight;
- `rts` — the controller's books: alliances, the fog (what every player has SEEN), control groups
  and selection, every computer's brain (melee, Computer+, a campaign's `.ai` on its own JASS VMs,
  the creeps' casting), the placed-unit index that hands out ids;
- `script` — the map's JASS VM: globals, handles, triggers, timers, quests, dialogs, multiboards,
  game caches, and its sleeping threads.

Every object is written once by identity, so two references to one record are one record after a
load. Three kinds of thing in the graph are not state:

- **externals** — the static world the match was built from (the object tables' rows). A unit that
  holds its type's weapon row holds a pointer into data the loaded game reads from the same
  install, so it is written as a key (`unit:hfoo/weapons/0`) and looked up again.
- **wiring** — functions: hooks, callbacks, samplers. The match a save is loaded into already has
  them.
- **opaque / transient** — a WeakMap, a GPU instance, a DOM node; and per class the fields
  `classes.ts` lists (a cache, a static table, the controller's picture and input state).

## Loading writes INTO a match

A save is loaded into the map's own start: the same file, the same resolved config (seed and
rolled races), placed units adopted with their bodies, the script parsed — but `config()` and
`main()` NOT run (`loadMapScript`'s `restore`). The computers are seated again from the seat log
(`RtsController.aiSeatLog`, every `StartMeleeAI` in order), lazily-made objects are made
(`prepareForLoad`), and then the codec writes the saved graph OVER that match, in place: a saved
object is written into the fresh object standing at the same place when they are the same kind,
which is how a reloaded VM keeps its engine hooks and the fog overlay keeps holding the live vision
grid. Only class instances, and containers directly owned by one, are reused — deeper than that a
value may be SHARED (`JNULL` is one object behind every null global), and reusing it would write a
saved handle over every other global's null.

Then the PICTURE is reconciled (`RtsController.reconcileAfterLoad`): an entry whose unit the save
does not have is retired, one whose unit changed type is remodelled, and every unit without one
gets a body. Mines that ran dry, trees that were felled, gates that were opened, ground items,
corpses, missiles in flight, a script's unit looks and special effects are put back the same way.
The text tags, quests, leaderboards, multiboards, timer dialogs and dialogs need nothing: the
scene redraws them from the restored runtime every frame.

## The threads

A sleeping JASS thread is a chain of JS generators, and a generator cannot be written down. So
every generator on a thread keeps its position in a plain record on the thread's `Trace` — the
statement it is on, the arguments evaluated so far, the branch it took, its locals (`TraceRec`).
A suspended thread's trace says where each frame of it waits. Loading starts the same generators
again with that trace as their `resume`: each takes its own record back and skips to where it
was, and the innermost one — the wait — returns as if it had run out. A level with no state of its
own keeps no record; capture and resume walk the same tree, so they agree on which levels do.

A thread parked inside a LUA coroutine cannot be described, and a Lua map's own state lives in
the Lua VM, so a Lua map cannot be saved (`saveRefusal`).

## Versions

A save is a build's memory, and another build's memory may be another shape. The header carries
the OpenWar3 version, its commit and its SIM FINGERPRINT (`tools/sim-fingerprint.mjs`, the hash a
replay carries), the game files (1.30.4 — the only target, checked anyway) and the edition. A save
loads when the fingerprint matches; otherwise it is refused with the reason
(`saveIncompatibility`). A save also names its map by path and hash, its campaign chapter (so a
victory after the load is still credited, and Continue still leads on), and its balance patch.

## Not saveable

A multiplayer game, a replay, a match that is over, the loading screen, and a Lua map
(`MapViewerScene.saveRefusal`). A loaded match records no replay: a replay is the inputs from the
START.

## Verified

Headless, in `pnpm sim:test`:

- `tools/save-jass-test.cjs` — a script parked in every kind of place a thread can wait (nested
  calls with locals and a local array, mid-loop, inside a function called from an expression with
  the left operand already taken, an `if`/`else` body, a timer handler, a trigger's second action,
  `PolledWait`, an adopted `ExecuteFunc`), saved at six moments through real JSON and loaded into a
  fresh VM: its whole runtime equals the saved one's at every step for ten more seconds, it says
  the same things, and a save with one wake time moved is caught.
- `tools/save-ai-script-test.cjs` — a campaign computer (Human02's `h02_red.ai` on common.ai, its
  suicide waves asleep in `PrepSuicideOnPlayer`) saved at four moments and re-seated: the same 119
  orders, and the same state, to ten minutes.
- `tools/save-sim-test.cjs` — two squads fighting, saved at four moments into an empty world: the
  replay state hash and the whole encoded world agree at every step to the end; a nudged hit
  point is caught.
- `tools/save-file-test.cjs` — the container, the header-only read, the version check, and the
  store's rules (a name is a file, never a path; written beside and moved over).

Live, in headless Chrome against the real 1.30.4 install (the dev build's `devStateHash` — every
root, every field — compared at fixed steps between the match that was saved, carrying on, and the
match loaded from it):

- Echo Isles, two Insane Computer+, saved at 0:30 and at 3:00: identical at load, and at every
  check after it.
- Rise of the Naga, saved at 1:30 (intro skipped): identical at load and at ten checks to 2:20.
- Rise of the Naga saved 0:30 in, MID intro cinematic: identical at load, the letterbox and the
  transmission back, the cinematic's threads resumed. A cinematic then drifts from run to run
  whether or not it was saved — `TriggerWaitForSound` waits on the real audio decode — which is
  why the gameplay run above is the comparison.

What the comparison leaves out, because it moves with the FRAMES rather than the steps: the sim's
render queues (hits, bursts, swings — drained once a frame), a viewpoint's `visible` layer (the fog
pass resamples it on a real-time throttle), the observer APM window, and installed hooks.
