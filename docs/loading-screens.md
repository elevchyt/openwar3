# Loading screens

The screen between the menus and the match: `UI\FrameDef\Glue\Loading.fdf`, drawn by
[`src/ui/loadingScreen.ts`](../src/ui/loadingScreen.ts) with its art in
[`src/render/loadingScene.ts`](../src/render/loadingScene.ts) and its table in
[`src/data/loadingScreens.ts`](../src/data/loadingScreens.ts).

Four things about it are not guessable from the FDF, and each one is a bug if you assume
otherwise — plus a handful of smaller traps in its text and its minimap.

## 1. The w3i field that picks the screen is the one named "campaign background"

A map names its loading screen by NUMBER — a row of `[LoadingScreens]` in
`UI\WorldEditData.txt`, which documents its own columns:

```
// Value 0: Game version in which this loading screen first appeared
// Value 1: Display text for editor
// Value 2: Integer indicating which animation sequence to use
// Value 3: Model file for screen graphics
46=1,WESTRING_LOADINGSCREEN_NIGHTELFX01,0,UI\Glues\Loading\Backgrounds\Campaigns\AshenvaleExpansionBackground.mdl
```

The number lives in the w3i field mdx-m3-viewer calls `campaignBackground` — the FIRST int of
the loading-screen block — and **not** in the one it calls `loadingScreen`, which is the int
after the subtitle and is the TFT "used game data set" field. Read straight out of the
archives:

| map                     | 1st int | 2nd int | the row the 1st int names          |
|-------------------------|---------|---------|------------------------------------|
| NightElfX01 (v25)       | 46      | −1      | `WESTRING_LOADINGSCREEN_NIGHTELFX01` |
| HumanX01 (v25)          | 57      | −1      | `…HUMANX01`                        |
| Human01 (RoC, v18)      | 2       | −1      | `…HUMAN01`                         |
| WarChasers (RoC, v18)   | 44      | −1      | `…CREDITS`                         |
| Echo Isles (melee, v25) | −1      | 0       | none — a melee map names no screen |

The **sequence** column matters as much as the model: one background serves a whole campaign
and the clip is what lights up that chapter's location. `AshenvaleExpansionBackground.mdx`
carries exactly two clips, named `NightElfX01` and `NightElfXInterlude01`, and row 46 asks for
number 0 — which is the one that puts the red X on Azshara.

A melee map names no row at all, because its screen is about **who you are**: the local
player's race, `UI\Glues\Loading\Multiplayer\Load-Multiplayer-<Race>.mdx`, `-Random` included.

## 2. Every one of these models is flat 2D art in the FDF's own coordinates

Dumped from the archives, each loading model — the four multiplayer ones, the generic one,
every campaign background, `LoadBar.mdx` — is a handful of quads with **no camera**, authored
directly in the glue UI's 0.8 × 0.6 box (`Load-Multiplayer-Orc.mdx` spans exactly x 0…0.8,
y 0…0.59999). So they are not scenes to frame, the way a campaign backdrop is
(`MenuScene.showBackdrop`); an orthographic window over that box **is** the authored picture.

Two traps follow:

- mdx-m3-viewer's `Camera.ortho(left, right, …)` is the camera's OWN frustum, measured from
  where the eye is — not world coordinates. Feed it the box's world bounds and the view lands
  one half-box up and to the right of the art.
- The box is **stretched** to the viewport, not pillarboxed. `Loading.fdf`'s root is
  `SetAllPoints` and its background sprite with it, so on a wide screen the picture widens —
  and the minimap, the roster and the load bar have to widen with it or they stop sitting
  where the art says they sit. This is the one screen mounted with `stretchRoot`
  (`stretchBox` in [`src/ui/fdf/layout.ts`](../src/ui/fdf/layout.ts)); positions take
  `scale × xScale` and type takes `scale` alone. Checked against a reference shot at 16:10:
  the minimap frame, a square 0.16 × 0.16 in the file, is drawn there 1.2× wider than tall.

## 3. The load bar fills ITSELF — progress is the animation's playhead

`LoadBar.mdx` is not a bar the engine has to draw at a width. Its `Loading Bar Fill` and
`Loading Bar Glow` bones each carry one `KGSC` scaling track with exactly two keys:

```
KGSC  frames [3333, 26800]  values [[0.012, 1, 1], [1, 1, 1]]   (linear)
```

Those two frames are precisely the bounds of the model's own "Birth" sequence, and both bones
pivot at x ≈ 0.1992 — the fill quad's left edge. So the clip *is* the bar going from empty to
full, and progress is just where you park the playhead:
`instance.frame = start + p × (end − start)`, re-applied every frame because
`updateAnimations` advances it on its own.

Driving `localScale` by hand instead looks like it should work and does not: the very track you
are imitating overwrites the poke on the next update, and the bar ignores `setProgress`
entirely and creeps up over the clip's own 23.5 seconds. (Watch out for the parser, too —
these tracks live on `bone.animations`, not on a `scalings`/`timelines` field, so a dump that
looks in the wrong place reports the model as having no keyframes at all.)

## 3b. Two things about its text and its minimap

**The caption is measured on two different axes.** A shrink-wrapped TEXT frame is measured in
pixels and handed back a world width — but on the stretched loading screen the glyphs are set
at `scale` (type never stretches) while the box they land in is drawn at `scale × xScale`. One
number for both makes the box `xScale` too wide for its own text, and with the file's
`JUSTIFYLEFT` that parked "WAITING FOR OTHER PLAYERS" 45px left of its bar. Two more traps sit
next to it: the measured string must keep its WHITESPACE (`wc3StripMarkup`, not `wc3ToPlain` —
the caption is the literal `"L  O  A  D  I  N  G"` and its collapsed twin is six spaces too
narrow), and a measured box is a shrink-wrap we did *approximately*, so like an inherited one
it takes its justification from its ANCHOR rather than from the file.

**Caps sit high in a centred line box.** WC3 centres the glyph run in the bar; CSS centres the
line box, which carries descent space an all-caps string never occupies. Measured at 720p the
caps spanned y 636…646 against a bar centred on 643. `BAR_TEXT_NUDGE` drops them a fifth of the
type size — a fraction of the FONT, so it holds at any resolution.

**The minimap carries the map's own markers**, the same three the lobby's preview draws: a ball
on every gold mine, a house on every neutral building the unit table flags (`nbmmIcon`), and
each start location as a cross in that player's colour. They are read from the map's bytes, so
the screen takes them a beat after it mounts (`setMinimapPreview`) rather than at build time.

## 4. It is a full-WINDOW screen, and `#ui` stops being one mid-load

`body.in-game` puts a **`transform`** on `#ui` to re-box it to the 16:9 game frame — and a
transform makes an element the containing block for every `position: fixed` thing under it.
The loading screen is up across exactly the moment that class is set (`enterMap` sets it while
the bar is still moving), so anything of its own mounted inside `#ui` is silently re-boxed
mid-load: its DOM keeps the pixel positions it was laid out with for the full window, inside a
box that is now narrower and offset. On a 1920×962 window that reads as everything sitting
~105px right of the art and drawn 12% too wide — the load bar's caption off-centre, the
minimap hanging out of its painted frame, the name plates overlong.

So the screen has a layer of its own, `#loading-layer`, a sibling of `#ui` in `index.html`. It
is the browser's frame, like the menus, not the game's.

## And the menus leave before it arrives

The reference does not cut from the Custom Game screen to the loading screen: it plays the same
departure as any other transition — every button goes dead, the panel's contents fade where
they stand, and the empty panel slides up and off on the chrome's own "<Screen> Death" clip,
whooshes included. That is `GlueManager.leave()` (the leaving half of `goTo`, on its own),
awaited by `startGame` before the loading screen is built, and awaited before the menu music
is cut so the departure is not silent.

## Who is in, and when the match actually starts

The green `LoadingPlayerSlotReadyHighlight` per seat is the reference's "this one is in" light,
and `LOADING_WAITING_FOR_PLAYERS` is what the bar says while it holds for the stragglers. Both
are driven by one message of our own, [`src/game/loadGate.ts`](../src/game/loadGate.ts):

- Lit from the first frame for every seat this machine can vouch for — a COMPUTER, our own, and
  any human seat with no relay peer behind it (single player).
- Every other seat is another machine, and lights when its `ready` reaches us. We announce ours
  the moment our bar fills, and hold until everyone has answered — the bar reading
  "WAITING FOR OTHER PLAYERS" while it does, and only ever forwards: the last arrival does not
  put "L O A D I N G" back up.
- `LoadGate` is constructed BEFORE the map is read, because a peer on a faster disk finishes
  while we are still inside `loadMap` and its message would land on nothing. It survives the
  match link being attached over it — `MatchLink`'s constructor chains onto the handler it
  finds — so there is nothing to buffer and nothing to restore.
- It gives up after `LOAD_GATE_TIMEOUT_MS` (a minute) rather than stranding a player whose
  opponent closed the tab. The reference would offer to drop them; we have no such dialog.

Then a deliberate **3-second hold** on the finished screen before the match appears. That one
is OURS and is not measured off anything — a load that ends the instant the bar fills never
shows the player the screen they were waiting on.

## A campaign chapter waits for the player instead

A single-player CAMPAIGN chapter does not start itself. Its bar fills and its caption becomes
`LOADING_PRESS_A_KEY` — "PRESS ANY KEY TO CONTINUE", one of the loading captions
`GlobalStrings.fdf` already carries next to `LOADING_LOADING` and `LOADING_WAITING_FOR_PLAYERS` —
and the mission begins on the player's key. The chapter's title and its blurb are on that screen
to be read, and how long that takes is the player's business. Nothing else waits: a custom game, a
skirmish and a LAN match all get the 3-second beat above (`LoadingScreen.waitForKey`, chosen in
`startGame` on `config.campaign && !link`).

Two things fall out of it, both of them a bug if you skip them:

- **The world is held with the screen** (`MapViewerScene.holdAtStart`). The match is standing
  behind the loading screen by then — the map is built and its script's init has run — and a
  chapter opens on a CINEMATIC, which the reference does not play to a loading screen. Held for
  three seconds nobody notices; held for however long a player takes to read, the intro is half
  over before they see it (measured on Rise of the Naga: the sim tick stands still across the
  whole wait, then steps on from where it stopped). It is a flag of its own rather than `paused`,
  because the map's own `PauseGame` writes that one and chapters do pause themselves in init.
- **The key is swallowed** (capture phase, `preventDefault` + `stopPropagation`). The match's own
  window-level handlers are already live behind the screen — the HUD's hotkeys, the camera's
  arrows, F10 — and the key that dismisses the loading screen must not also be a key the game was
  given. A click counts too: the browser only sends us keys while the page has focus, and a click
  is both how focus comes back and what a player will try first.

## Not done yet

The gate holds the loading SCREEN, not the simulation: the world starts ticking when the map
scene starts, which is well before the gate is consulted. That is no worse than it was — every
client already began simulating whenever it happened to finish — but it is not lockstep, and it
is not a fix for drift (see [`docs/multiplayer.md`](./multiplayer.md)).
