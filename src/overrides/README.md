# `src/overrides/` — OpenWar3's own layer on top of the game's UI files

Everything under `UI\FrameDef\` belongs to the player's Warcraft III install. We read it; we
never write it, and nothing in this repository is a copy of it (see the legal boundary in
[`CLAUDE.md`](../../CLAUDE.md) — OpenWar3 ships zero Blizzard assets).

So when OpenWar3 needs a control the 2003 UI has no frame for — the Computer+ checkbox of
issue #124 — the change is expressed **here**, as a small file in the game's own FrameDef
language that is layered onto the screen at mount time:

| file | what it does |
| --- | --- |
| [`ui/GlobalStrings.fdf`](ui/GlobalStrings.fdf) | strings the game has no key for |
| [`ui/OptionsMenu.fdf`](ui/OptionsMenu.fdf) | Options → Gameplay: drops two rows, adds one |
| [`ui/AdvancedOptionsPane.fdf`](ui/AdvancedOptionsPane.fdf) | Custom Game → Advanced Options: adds one row |

## How a layer is applied

[`index.ts`](index.ts) holds the manifest and the two halves of the mechanism:

* **`layer`** parses the override's FDF and registers its frames and strings in the screen's
  `FdfLibrary`, *winning* over the install's where a name collides. It runs once, at mount.
* **`applyOverride`** edits the resolved frame tree of one build: it DROPS the frames the
  override retires and ADOPTS the ones it adds into a named container. It runs on every build,
  because an FDF screen rebuilds its whole tree on resize.

Both are wired into `mountFdfScreen` through its `overrides` option, so a screen opts in with
one line and everything else about it is unchanged.

## Rules for a file in here

* **Write real FDF.** These are parsed by our own `parseFdf`, the same parser that reads the
  install's files, so anything legal there is legal here — and a reviewer who knows the game's
  UI language can read them without knowing ours.
* **Anchor to the game's frames, not to ours.** A new checkbox says
  `SetPoint TOPLEFT, "AutosaveReplayCheckBox", BOTTOMLEFT` — the row it sits under in the real
  screen — so it lands in the right place whatever else moves.
* **Say why, in the file.** A frame that exists only in OpenWar3 needs its reason next to it as
  much as any code does.
* **Never edit the install.** If a change seems to need it, it needs a file in here instead.
