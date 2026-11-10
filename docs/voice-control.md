# Voice Control

Options → Gameplay → **Voice Control**: hold **Period (.)**, say a command, let go. Nothing in
Warcraft III listens, so every part of this is OURS — the key, the vocabulary, the grammar —
and nothing here is a number from the game. What it ends in is the game's: every spoken command
is carried out through the doors a click and a hotkey already use.

## The pipeline

```
"." held ─▶ microphone (ScriptProcessor tap, 0.6 s pre-roll) ─▶ utterance resampled to 16 kHz
        ─▶ Whisper in a worker, PRIMED with the names on screen ─▶ text ─▶ parser (deterministic)
        ─▶ intents ─▶ game/voiceActions.ts ─▶ runCommand / orderClickAt / RtsController.execute
```

| file | what it is |
| --- | --- |
| [`src/voice/whisperModels.ts`](../src/voice/whisperModels.ts) | the two models (Fast / Accurate), their sizes, the worker messages |
| [`src/voice/whisperWorker.ts`](../src/voice/whisperWorker.ts) | transformers.js + onnxruntime-web, in a worker: load, progress, transcribe with a prompt |
| [`src/voice/model.ts`](../src/voice/model.ts) | the page's side: is it installed (Cache Storage), download with a bar, transcribe |
| [`src/voice/parser.ts`](../src/voice/parser.ts) | text → intents. Pure; pinned by `tools/voice-parser-test.cjs` |
| [`src/voice/control.ts`](../src/voice/control.ts) | push-to-talk, the microphone, one utterance's life; `applyVoiceOptions` |
| [`src/voice/menu.ts`](../src/voice/menu.ts) | the menus' host: reads the screen (see below) |
| [`src/game/voiceActions.ts`](../src/game/voiceActions.ts) | intents → the match's own click/hotkey paths; target resolution; spell assist |
| [`src/ui/voiceOptions.ts`](../src/ui/voiceOptions.ts), [`src/ui/voiceDownload.ts`](../src/ui/voiceDownload.ts) | the Options row's two faces, the download dialog |

## The recogniser: Whisper, and why not Vosk

The first Voice Control ran Vosk's small Kaldi model (41 MB) under a GRAMMAR of the words a
command could hold. It was chosen for the slow PC and paid for it in accuracy — "altar" heard as
"alter", "finish" as "fish" — and a grammar only narrows what a weak listener guesses between.
It was replaced by **Whisper** (OpenAI, MIT), English-only, as the hub's int8-quantized ONNX
files (`onnx-community/whisper-small.en`, ~250 MB), run by transformers.js in a worker:

- **One model, small.en.** There was a second, "Fast" base.en (~80 MB) on a Fast/Accurate
  pulldown beside the checkbox; it was taken out because, on the developer's machine, it answered
  no quicker than small.en and was the worse listener, so the pulldown bought nothing a player
  could feel. Its cached files are deleted on boot (`forgetOldVoiceModels`, with the first
  build's Vosk model).
- It is **primed, not constrained**: the names the player is likely to say (the lexicon, then the
  host's wider vocabulary) go in as a prompt after `<|startofprev|>`, Whisper's own
  `initial_prompt` mechanism, which makes "Blademaster" and "Altar of Kings" the likely
  spellings without forbidding anything. transformers.js does not wire `prompt_ids` through
  `generate`, so the worker writes the decoder's opening tokens itself and cuts the prompt off
  the answer.
- The text is FREE, so the parser reads it tolerantly: punctuation and capitals are dropped,
  digits are numbers, and a name may match by SOUND (`sound()`: "alter" is Altar) from four
  letters up. Chat lines need no second recogniser any more — the message is what was said.
- Silence is answered as silence (RMS gate): Whisper invents a sentence out of room noise.

## Four traps

1. **The runtime is SHIPPED, not fetched.** transformers.js loads onnxruntime-web's WebAssembly
   from a CDN by default; the worker points `wasmPaths` at the copies Vite bundles
   (`ort-wasm-simd-threaded.asyncify.{wasm,mjs}`, ~27 MB, fetched only when Voice Control is
   first used). The only download is the model.
2. **Threads need cross-origin ISOLATION.** Whisper's encoder always processes a 30-second
   window, so a short command costs nearly what a long one does: on ONE thread base.en took
   ~4.7 s to answer a two-second command, on eight ~0.8–1.4 s (small.en ~3.5 s), depending on the
   CPU. The dev server
   (`vite.config.ts`) and the desktop app's server (`electron/server.mjs`) send
   `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless`;
   a host that does not falls back to one thread, slowly but correctly.
3. **Installed = in Cache Storage.** transformers.js keeps every file in the `transformers-cache`
   Cache; "installed" is its two ONNX files being there (`whisperFiles`), so a browser clearing
   site data is a model to fetch again, never a broken one. The old Vosk model in IndexedDB
   (`/vosk`) is deleted at boot (`forgetOldVoiceModels`).
4. **CPU everywhere — WebGPU was measured and LOSES.** On the developer's RTX 3050 (Chrome,
   WebGPU adapter "nvidia/ampere"), base.en's int8 files answered a 2 s command in **~2.6 s on
   WebGPU against ~0.8 s on the CPU** (eight threads), and an 11 s clip in 9.3 s against 1.2 s:
   int8 matrix work is not native to the WebGPU backend, so it runs as converted or fallen-back
   ops. WebGPU only pays with fp16/fp32 encoders and 4-bit decoders — DIFFERENT files, a second
   download per device — and the developer ruled that out. Do not switch the device to "webgpu"
   for the int8 models.

## What a phrase means (the developer's rules)

- **"Here", "there", "this", "that" are the middle of the SCREEN**, not the mouse — a player
  playing by voice may have no hand on it. "The cursor" / "the mouse" is the mouse.
- **"Build a farm here"** (or no place at all) puts it SOMEWHERE ON THE SCREEN it fits, beside our
  other buildings, never in the lane between a town hall and its gold mine
  (`MapViewerScene.voiceBuildSpot`, every candidate through the placement click's own test).
- **A spell assists**: "use frost nova" selects the unit of ours that has it (ready, with the
  mana, nearest the middle of the screen) and, with nothing said about where, aims it — a row that
  may hit an enemy goes on the enemy (heroes first), a friendly-only row on the most hurt friend,
  an area spell where the most enemies stand inside its own radius. Each candidate is offered to
  the card's own aim, so the spell's own refusals still apply.
- **Camera**: any clause naming the camera is a camera command ("move the camera to another gold
  mine" is not a MOVE order). "Another"/"next" is the nearest one the camera is NOT already on;
  "on the right side of the map", "top left" are halves (thirds for "middle") of the playable map.
- **Subjects**: a clause may name WHO instead of relying on the selection — "put ALL PEASANTS on
  gold", "send TWO WORKERS to wood", "ALL PEASANTS to the gold mine" (no verb at all). "Worker",
  "peasant", "peon", "acolyte", "wisp" all mean this race's gatherers. A worker said with NO
  number ("select peasant") is an IDLE one — the idle-worker button's job; "select one worker"
  is any one (idle first); "select one worker from wood" is one carrying a lumber order (walking
  a load home counts). Plural or "all" is every one, map-wide.
- **"Select army"** is the "-" key, through the HUD's own `selectAllArmy`.
- **Rally by building**: "put the rally point of the barracks on my hero" sets it on EVERY
  finished Barracks of ours with the Set Rally Point command, without touching the selection; a
  unit is rallied ON. "My hero" is the FIRST hero (the top portrait), not the nearest.
- **Words for a kind of building** (`raceTerms`): "tower", "shop", "farm"/"supply", "hall",
  "altar", "barracks" mean THIS race's one, read off the data (a shop makes items; a tower attacks
  and trains nothing, or upgrades into one — the undead build a Ziggurat and are told so). A
  greyed build button says what it is missing: "Ancient Protector requires Hunter's Hall."
- **Camera to things**: any building the player has SEEN ("the tavern", "the goblin merchant",
  "the fountain" — first and last words of a neutral building's name work too) and the minimap's
  creep camps. "Another" is a tour: each one asked for is one the camera has not yet been taken to.
- **Builders finish what they build.** A spoken order to the selection (move, attack, stop, a
  spell) leaves out any worker on a construction job and puts it back in the selection after
  (`shield`); a subject ("all peasants") never picks one; "select a peasant" — "a" is not a count —
  is an IDLE worker by the idle-worker button's own test.
- **"Finish the altar"** puts a worker back on a building of ours whose construction HALTED (no
  builder, not self-building) with the right-click's `buildresume` order: an idle worker first,
  then one off the trees, then any other not already building. "Complete all buildings" does
  every one.
- **Items are spells.** "Use healing salve on grunt" selects the hero CARRYING it (the selected
  one first), presses the pocket, and aims it: an item's behaviour is its ability row, so a gift
  goes on the grunt of ours with the least life, a weapon on the enemy. Said as players say them:
  "healing potion" for Potion of Healing, "town portal" / "tp", "salve".
- **The prompt knows the game.** The lexicon (the card, our tech tree, our units' spells, what is
  on screen) and then every melee unit, ability and item name prime Whisper's spelling, the most
  likely names LAST (the worker keeps the end of a long prompt).
- **Camps by colour**: "move the camera to a green camp", "pan to another orange creep camp" — the
  minimap's own colours for a camp's combined level (green 1–9, orange/yellow 10–19, red 20+,
  game/minimapView.ts). "Back", "over", "up" are skipped before a place ("pan the camera BACK to my
  base").
- **"Fall back"** ("retreat", "pull back", "go home"): the "-" key's army is selected and MOVED —
  not attack-moved — to our town hall, or to the place said ("retreat to the gold mine").
- **The prompt carries example SENTENCES** (`COMMAND_EXAMPLES` in control.ts) after the names: the
  words the developer named as hard — pan, move, place, camp, goblin, tavern, the camp colours,
  fall back — are spelled right far more often after an example of them than after a name list.
- **Anything that can gather is a gatherer when told to.** "Send a ghoul to gather lumber" asks
  the sim's own worker profile (`SimUnit.worker` — which resources this unit's harvest ability
  works), never "is it a worker": a Ghoul is nobody's idle worker and an Acolyte never touches a
  tree. Gather / harvest / collect / mine, and wood / lumber / trees, are one each. A gatherer
  that can only cut wood, told to gather with nothing said, goes to the trees. **"Go to gold"**,
  "go to the wood" GATHER — for a worker a mine or a tree is somewhere to work, as the
  right-click on one is — when everybody it is said to can gather that resource (with nothing
  selected, an idle worker); an army sent to the gold mine still walks there.
- **Words the recogniser rarely hears** are put back before the parser reads them (`MISHEARD` in
  parser.ts): "acolyte" comes out "a collide", "accolade", "acolite". The prompt's example
  sentences carry the word too, which is what makes it the likely spelling in the first place.
- **Buildings are selectable by name and by kind**: "select altar", "select my main building"
  (also main hall, main base, base, hq, headquarters, town center, home). A kind means the type
  AND what it has become (`family`: "the town hall" is still the Keep, "the farm" the Spirit
  Tower). With a "main", the OLDEST hall — the one the match started with — not the nearest.
- **Name tags** (`game/voiceLabels.ts`, drawn by `WorldOverlays.syncVoiceLabels`): while Voice
  Control is on, every unit and building of ours wears a tiny square-cornered "Fiend 4" slab, so one of several
  can be SAID — "select fiend 4", "select crypt fiend number four". A number belongs to the
  unit for life (the lowest free one of its type, given back when it dies) and is SHOWN only
  while there are two or more; a tag that renumbered would point the next sentence at a
  different body than the one the player read. Short names are heard too: the last word of a
  name ("fiend", "burrow"), two short words run together ("moonwell"), and a few deliberate
  MISHEARINGS ("borough" for Burrow) that are matched but kept out of the prompt (`misheard`).
- **"TP out"** ("teleport out", "tp out of there", "tp back to the base"): the Scroll of Town
  Portal, aimed at our main hall unless a place is named — "out of THERE" is where the army is
  leaving, so "there" never aims it.
- **The camera follows an army it sent.** A move, attack, attack-move, patrol or fall-back given
  by voice rides the camera on the first hero of the group in the hero bar's order, the next when
  that one falls, then the rest (Ctrl+C's lock, given a list — `rideCamera`). Taking the camera
  by hand lets go, as it does that lock.
- **The hint box** (`ui/voiceHints.ts`): a short list of things worth saying on the right of the
  screen, worded with this race's own worker, soldier and farm, while Voice Control is on.
  **","** hides and shows it (remembered for the browser). The developer's pick of three looks.
- **A creep camp is ATTACKED, never attack-moved to.** An attack-move fights everything it walks
  past, so "attack the green camp" took on the red camp beside the path. The order goes on the
  creep of THAT camp nearest the army (an attack on a unit walks there without stopping); a camp
  in the fog has no creep to aim at, so the army WALKS to `CAMP_APPROACH` short of it and a
  QUEUED attack-move covers the last stretch.
- **Retreat has many phrasings** — "fall back" (Whisper also writes "fallback"), "go back", "get
  back", "move back", "run away", "pull out" — and "back" alone is still Cancel. "TP" arrives as
  "T.P.", "teepee", "tipi"; those are put back (`MISHEARD`) before anything reads them.
- **Directions**: "move up", "go north west", "attack move left", "move up and to the left",
  "move right a bit" (half) / "a lot" (double) walk `STEP_DISTANCE` (800, ours) from where the
  units stand, screen-up being north; "pan the camera left" steps the camera. "Move TO the north"
  is still the map's northern third. "Up and to the left" is one direction — the clause splitter
  would otherwise read the "and" as a second command.
- **"Follow the archmage"** is the right-click's FOLLOW order on a friendly unit (never on one of
  the followers), wherever it is on the map.
- **"Select worker"** is an idle one, else a LUMBER worker, else anyone on the field — never a
  body inside a building: a Wisp in an Entangled Gold Mine holds no order and read as idle
  (`isOffField`/`garrisonHost`, the idle-worker button's own test).
- **The prompt has a BUDGET.** Whisper hears ~224 tokens of prompt and the worker keeps its END,
  so `promptFor` spends ~850 characters: the developer's list of hard words (`PROMPT_BIAS`; those
  this match can use first, none repeated from the names), the example sentences, and the
  likeliest names LAST. Before the budget, the examples alone filled the window and the names
  were the part cut off.
- Everything is fog-honest: "the enemy hero" is the nearest one this player can SEE.

`window.openwar3.voiceSay("train three footmen")` runs a sentence through the same path with no
microphone — the way to test the mapping in a live match.

## The menus and the in-game panels

`src/voice/menu.ts` is the second host: when no match is taking commands (the main menu, every
glue screen, and in a match whenever F10's menu, the Quest Log, Allies or Chat is up) the press
goes to it, and it reads the SCREEN rather than a grammar of its own — every visible button by its
caption, every checkbox and dropdown by the label on its line (right of a box, left of a
dropdown), every list row by its text, and every dropdown's own options (`popupOptions`, a
WeakMap the widget fills). So "click single player", "select lost temple", "set hotkeys to grid",
"turn on observer mode", "previous menu", "quit mission" need nothing written per screen.

- **Lobby rows** are told apart only by their row (`NameMenu3`, `RaceMenu3`, `TeamButton3`,
  `ColorButton3`, `HandicapMenu3`), so a sentence names a ROW — an ordinal ("the second player",
  "player three"), a colour ("the red player": the colour menu labels its swatches "Player N",
  mapped to the game's own playercolor order), or "my" (the first row that is a person) — and
  maybe a FIELD. With none said, the field is the row's dropdown that HAS the value: "change the
  second player to insane" is the player menu, "… to orc" the race. "Player" names the player
  menu only when no other field word was said.
- **Every action is the pad's** (`voicePoint` / `voiceClick` in ui/gamepad.ts): the drawn cursor
  and the gold box land on the control and press it, so it hears a mouse's pointer events — the
  click sound, the glow, the tooltip, the screen's own handler. "Move the cursor to X" leaves the
  box there; "click" then presses it. The real mouse moving takes it away, as for the pad.
- **"Close"/"exit"** presses a button by that name if the panel has one, else sends the panel its
  own Escape.
- The CONSOLE lines belong to the match even while a panel is up or the game is paused — "open
  the quest log", "pause"/"unpause", and chat — and opening one panel puts away whichever is open.
- **Chat**: "say good game to all", "tell allies push mid", "send message … to my team", "open
  chat". The message is the rest of the sentence as Whisper heard it. "And" inside a chat line is
  the message's own.
- `window.openwar3.voiceSay(text)` works on the menus too (it asks whichever host is active), and
  `window.openwar3.voiceHear(samples16k)` runs recorded speech through the recogniser itself.
