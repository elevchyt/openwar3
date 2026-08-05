# Loading screens

The screen between the menus and the match: `UI\FrameDef\Glue\Loading.fdf`, drawn by
[`src/ui/loadingScreen.ts`](../src/ui/loadingScreen.ts) with its art in
[`src/render/loadingScene.ts`](../src/render/loadingScene.ts) and its table in
[`src/data/loadingScreens.ts`](../src/data/loadingScreens.ts).

Three things about it are not guessable from the FDF, and each one is a bug if you assume
otherwise.

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

## 3. The load bar has no animation — the engine IS its animation

`LoadBar.mdx` carries not one keyframe. Its `Loading Bar Fill` and `Loading Bar Glow` bones
sit at full width in the bind pose and both pivot at x ≈ 0.1992, the fill quad's left edge, so
progress is the engine scaling those two bones in x. `LoadingScene.setProgress` does the same
and pushes the bone texture itself, because mdx-m3-viewer only re-uploads after re-sampling
nodes and a bone with no tracks is never re-sampled.

## Not done yet

`GlobalStrings.fdf` carries `LOADING_WAITING_FOR_PLAYERS` ("WAITING FOR OTHER PLAYERS") and
`Loading.fdf` carries a green `LoadingPlayerSlotReadyHighlight` per seat, because on Battle.net
the screen waits for the slowest player and lights each seat as it reports in. We light every
seat when the LOCAL load finishes and never print the waiting caption: there is no readiness
message on the wire yet (see [`docs/multiplayer.md`](./multiplayer.md)), so a LAN match still
starts as soon as each client is individually ready.
