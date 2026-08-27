# The pause

Everything about stopping a Warcraft III match: what "stopped" means, who is allowed to say
so, and what a stopped game looks like. Read this before touching `paused` in
`src/render/mapViewer.ts`, the F10 panel's Pause button, or the Quest Log's Done button.

## The game's own vocabulary

Nothing here needed guessing — `UI\FrameDef\GlobalStrings.fdf` documents the whole feature:

```
KEY_PAUSE_GAME                  "Pause Ga|Cffffffffm|Re",
KEY_PAUSE_GAME_SHORTCUT         "m",
KEY_RESUME_GAME                 "Resume Ga|Cffffffffm|Re",
KEY_RESUME_GAME_SHORTCUT        "m",
PAUSE_GAME_NOTIFY               "%s paused the game. <%u timeouts remaining>",
PAUSE_GAME_NOTIFY_NO_TIMEOUT    "%s paused the game.",
RESUME_GAME_NOTIFY              "%s has resumed the game.",
OUT_OF_TIMEOUTS                 "Out of pause timeouts",
```

Four things fall out of that block, and all four are implemented:

1. **One button, two captions.** `EscMenuMainPanel.fdf` declares exactly one `PauseButton`,
   with `Text "KEY_PAUSE_GAME"` and `ControlShortcutKey "KEY_PAUSE_GAME_SHORTCUT"`. There is
   no second control anywhere in the file, and `KEY_RESUME_GAME` carries the SAME accelerator
   letter — so the engine swaps the caption in place. `EscMenu.captionPause` rewrites the key
   on its way through `rootFrame`, which leaves the string table to localize both.
2. **Pauses are counted, and they are called TIMEOUTS.** Three per player per match. Only
   pausing spends one; resuming is free.
3. **Anybody may resume.** `RESUME_GAME_NOTIFY` names a player, and it is not necessarily the
   one who paused — which is also the only safe rule: a player who pauses and then drops must
   not be able to hold the match hostage.
4. **A solo game has no tally.** That is what the second notify line is for; the timeout ledger
   is only consulted when there is somebody else waiting on you.

## Four sources, not one boolean

`MapViewerScene` keeps the pause in four independent fields because it has four independent
owners, and folding them into one flag makes them clobber each other:

| field          | written by                                                              |
|----------------|-------------------------------------------------------------------------|
| `panelPaused`  | something MODAL is open, in single-player: any of the four console panels, or a script's dialog |
| `scriptPaused` | the map's own `PauseGame` native (CustomVictoryDialogBJ uses it)          |
| `playerPaused` | a PLAYER — the Pause Game button, and over the wire in a LAN match        |
| `matchPaused`  | the match ending out from under us (v1: the host left)                   |

`paused` is any of them, and it is what stops the world and raises the veil. `hardPaused` is
all of them EXCEPT `panelPaused` — the state where the mouse stops issuing orders, the camera
stops moving and the HUD's own hotkeys stand down (`body.game-paused`). Panel pause is left out
of that one because a panel already covers the screen with its own `.fdf-dialog-scrim`, which
swallows the same input by itself.

The bug this split exists to prevent, twice over: `syncPanelPause` recomputes from what is
actually on screen, so with one flag it wiped out a player's own pause the moment any panel
closed — and closing the Quest Log un-paused a game the MAP had stopped.

## One modal at a time, and whatever is in front of you is what answers

`deadPanels()` is the single answer to "which of the four console buttons are dead right now",
and BOTH halves of the interface ask it: the strip greys itself from it (`ConsoleUi
.refreshEnabled`, applied in place — a rebuild would decode the strip's textures again for two
CSS classes) and `togglePanel` refuses the F-key from it. One answer, so a grey button and a
dead key can never disagree. Three reasons put a panel on the list:

- **a CAMPAIGN chapter** — no allies, nobody to chat with, all mission long;
- **something MODAL is up** — one of the four panels, a script's own `DialogDisplay`, the
  match-over screen. All four go grey, the open one included: its button sits behind that
  panel's scrim and cannot be clicked at all, so drawing it live would be a lie. (This one is
  NOT gated on single-player: a modal covers the console whoever else is playing.);
- **the match is STOPPED** — everything on the strip is a thing you do while a game runs. The
  Game Menu survives this reason alone, because `KEY_RESUME_GAME` lives inside it.

A panel's own key still CLOSES it — `togglePanel` tests that before consulting the list, and a
panel that is up must never become unclosable — but **no key swaps one modal for another**.
Pressing F11 over an open Quest Log does nothing at all; it does not close the log, and it does
not open the Allies dialog. Same for every F-key while a trigger dialog is on screen.

And a screen's two doors SOUND the same. WC3 does not tell them apart, so F9 opens the Quest Log
with exactly the click the Quests button makes and Escape shuts it with the click of Done —
`UISounds.slk` gives the in-game row (`MenuButtonClick`) and the menus' (`GlueScreenClick`) the
same `Sound\Interface\BigButtonClick.wav`. The keyboard routes call `playFdfClick`, the one hook
the buttons themselves already play through, so the two can never drift apart. A key the list
above REFUSED stays silent: nothing was pressed and nothing moved. `togglePanel` returns whether
it acted, which is how the F-keys know; the buttons need no such test, because a click that
reaches a live button always did something.

**Every door out of a panel has to say so.** The Quest Log has two the host never hears about
otherwise (its own Done button and Escape), which is the whole of the "Done leaves the game
frozen" bug: `QuestDialogOverlay.hide` now calls `QuestModel.onClose`, and the host recomputes.

## What stops for a PANEL, and why only in single player

`CustomVictoryDialogBJ` writes both halves of this rule out in six lines:

```jass
if (GetLocalPlayer() == whichPlayer) then
    call EnableUserControl( true )
    if bj_isSinglePlayer then
        call PauseGame( true )
    endif
    call EnableUserUI(false)
endif
call DialogDisplay( whichPlayer, d, true )
```

- **`DialogDisplay` does not pause by itself** — if it did, the `PauseGame` above it would be
  redundant. WC3's convention is that the script asks at each site, and most maps never write
  the guard.
- **The guard is `bj_isSinglePlayer`**, and that is the gate taken here. In a LAN game one
  player reading their Quest Log must not stop everybody else's match — the F10 panel's Pause
  Game button, with its counted timeouts, is what exists for that instead.

**How WIDE the rule is drawn is a departure, and a deliberate one.** WC3 stops the world only
where a script asks it to, and the Allies and Chat dialogs in particular are things you DO while
a match runs — the real client keeps playing behind them. Here EVERY modal screen stops a
single-player world: the four console panels and a script's dialog alike. `panelPaused` is
therefore just `singlePlayer && modalUp`, off the same predicate `deadPanels` greys the console
from, so "something is in front of you" means one thing to the whole interface instead of a list
of exceptions to remember.

`bj_isSinglePlayer` is HUMAN SEATS, not the wire and not the slot count. Blizzard.j computes it
once at init as `userControlledPlayers == 1`, counting slots that are both `MAP_CONTROL_USER`
and `PLAYER_SLOT_STATE_PLAYING` — so a skirmish against three computers is single-player.
`MapViewerScene.singlePlayer` is that same count.

**One caveat**, and it is the one `PauseGame` has always carried: a stopped world does not pump
the map's script, so a dialog that no click can dismiss and that a `TriggerSleepAction` was
meant to take down would never come down. Every dialog we put up is dismissed by ANY click (the
engine's own rule), so the click path is safe; a purely timed one is the shape to watch for.

## A stopped world is a still picture

`advanceSim` has always returned early while paused. That stopped the SIM and nothing else:
units held their ground while their Stand clips played on, the water rolled, the weather blew,
a Death animation ran itself out over a corpse frozen mid-fall, and the portrait bust — which
has a rAF loop of its own — went on breathing.

So the frame loop computes `wdt` (`paused ? 0 : dt`) and every clock that ages the WORLD reads
that instead of the frame's own delta: `baseUpdate` (all model animation, nodes and particle
emitters), the effects, decals, lightning, projectiles, tree wobble, spell splats, the
day/night medallion and the weather. `map.update()` is skipped outright — all it does is roll
the water texture and hand a finished Stand clip its next one. The portrait viewer is `stop`ped
and `start`ed, which is already a pause there rather than a teardown.

Nothing RESETS at zero, which is the point: unpausing carries on from the exact frame it
stopped. `dt` itself still reaches the interface (the HUD's own animation, the metrics counter)
and the debug overlays — freezing those would only make a paused game look broken.

At `wdt = 0` the scene is still WALKED. That pass is what collects the frame's visible
instances for the renderer; skip it and the screen goes black.

## The veil

`.pause-veil` is a single element prepended to `#ui` (`mountHud`). `#ui` is the layer above
both the map canvas and the world overlays (z-index 3 vs 0 and 2), so one element parked at the
bottom of it darkens terrain, units, floating health bars and combat text together, while every
piece of interface built into `#ui` after it paints over it untouched. It carries no z-index of
its own on purpose — DOM order is what keeps it under the console, the panels and their scrims —
and no pointer events, because the panels' own scrims are what make a pause modal.

It is INSTANT in both directions (`display`, not an opacity transition). A pause is a hard edge
— the world stops between one frame and the next — and a fade made stopping and starting feel
like something the interface was thinking about.

Note this is a deliberate departure: WC3 does **not** dim the map under the Esc menu (see the
comment on `EscMenu`'s invisible scrim). The dim is tied to the world being STOPPED, not to a
panel being up.

## Over the wire

Two messages, in `src/game/matchLink.ts`, and the split is the same one chat and commands make:

- `pausereq` — client → host, `{ on }` and nothing else. No sender field: a client controls
  every byte it sends, so the host stamps the asker from the relay's `deliver.from`.
- `pause` — host → the whole room, `{ on, by, left, denied? }`. Broadcast, because a pause is
  the one thing everybody is inside of at once.

**Authoritative, never optimistic.** A client that stopped its own world a round trip before
the host stopped its would spend that round trip diverging from a world it is no longer being
sent — and a REFUSED pause would leave it frozen alone. So `askPause` only sends; what stops
the game is `takePauseRuling`. A refusal (`denied`) is addressed to the asker alone and carries
the state unchanged, so it reads as news rather than as an instruction.

Since the host's `advanceSim` is what drives `MatchLink.tickHost`, a paused host emits no
snapshots at all — and every client is paused too, so there is nothing to be behind.

Covered by `pnpm loopback:test` ("the pause is asked for by a client and RULED by the host").
