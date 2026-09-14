# @openwar3/ui

The glue-screen UI kit: the Frozen Throne's navy glue buttons, the Human options-menu panel,
the gold-stroke tooltip slab, the gold-ruled heading and the loading screen's bar — redrawn from
scratch. One stylesheet, two thin bindings over the same markup:

| Import                     | What                                                              | Used by                         |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------- |
| `@openwar3/ui/ui.css`      | Every style. Classes are `ow3-*`, tokens `--ow3-*`, no element rules, no `cursor`. | both                  |
| `@openwar3/ui/fonts.css`   | `@font-face` for **OpenWar3 Sans** (optional)                      | the game                        |
| `@openwar3/ui/dom`         | `createGlueButton`, `createPanel`, `createProgressBar`, `bindHotkeys` | the game (`src/ui/gate.ts`)  |
| `@openwar3/ui/react`       | `<GlueButton>`, `<Panel>`, `<ProgressBar>`, `<Hotkeys>`, `<HotkeyLabel>` | the landing page (`web/`)  |

The package ships TypeScript source, not a build: Vite (the game) and Next.js (`transpilePackages`,
the landing page) compile it where it is used.

## How it is wired in

- **The game** depends on it as `link:packages/ui` — a symlink, so edits here are live.
- **The landing page** has its own lockfile and deploys with `web/` as its root, so it depends on
  it as `file:../packages/ui`. pnpm hard-links the package into `web/node_modules` with React
  beside it, which is what lets both Next and `tsc` resolve `react` from the package's files.
  Edits to existing files show through the hard links; **after adding or renaming a file here,
  run `pnpm install` in `web/`.**

## No game textures

OpenWar3 ships **zero Blizzard assets**, and that includes this kit. Every frame in `src/frames/`
is drawn by `scripts/frames.mjs` (`pnpm frames` regenerates them); only the *colours* were sampled
from the 1.30.4 install's own BLPs, and the script's header names the texture each one matches.
Text colours are the ones the FrameDef files state — see the header of `src/ui.css`.

## The progress bar

`UI\Glues\Loading\LoadBar\LoadBar.mdx` is five textures, and the bar is one layer per texture:
the iron frame (`progress-frame.svg`), a 40 % black track, the blue ramp fill at 65 %, a glass
sheen and a blue head glowing at the leading edge. `--ow3-progress` (0…1) is the fill,
`--ow3-progress-scale` sizes the whole bar, and `is-indeterminate` sweeps the head instead.

## The font

**OpenWar3 Sans** is Nowar Sans (nowar-fonts/Nowar-Sans-War3, SIL OFL 1.1), the engine's own
fallback face, cut to a 22 KB Latin subset. The OFL does not let a modified copy carry the
Reserved Font Name, so the subset is renamed; its licence sits beside it in `src/fonts/`.
