# `src/fallback/` — our own art for what an older Warcraft III lacks

OpenWar3 plays every classic build from 1.21 to 1.31.1 ([docs/versions.md](../../docs/versions.md)),
and the older ones are missing art a later patch added: the widescreen console's side panels
(1.29), the main menu's edition switch (1.28). OpenWar3 ships **zero Blizzard assets**, so what
fills those holes is art drawn for this project.

## What is here

All fourteen files an older build lacks and the game asks for (docs/versions.md) — the wide
console's side panels for all four races and the six edition-button states — DRAWN as SVG by
[`tools/fallback-draw.mjs`](../../tools/fallback-draw.mjs): shapes, gradients and seeded noise
lit by SVG lighting filters, nothing traced from an install — except the Frozen Throne badge's
death knight, which is the developer's own portrait (`portraits/DeathKnight.png`, cropped to the
head) set into the same gilded frame the orc badge wears. Where a panel meets the console's
own tile, its outline and its last ten columns are fitted to measurements of that tile's edge
(rows, mean colours), which is what keeps the join free of a seam.

    pnpm fallback:draw     svg/ → art/ (PNG, via headless Chrome) → art.ts

`svg/` is the source; `art/` and `art.ts` are made from it. A 06 panel's SVG is drawn with its
join on the RIGHT and carries `data-ow3-mirror="x"`: Chrome draws every lighting filter black
under a mirroring transform, so tools/fallback-svg.mjs turns it round as pixels instead.

## Adding a remake

1. Draw it in `tools/fallback-draw.mjs` (then `pnpm fallback:draw`), or save a PNG of your own
   under `art/`, at the path the game files the original under, with `.png`
   in place of `.blp`:

       art/UI/Console/Human/HumanUITile05.png      → UI\Console\Human\HumanUITile05.blp
       art/UI/Widgets/Glues/GlueScreen-ROC-EditionButton-Up.png

   Folder and file names are not case-sensitive to the game, but keep the game's spelling.
   Same size as the original (docs/versions.md lists each), 8-bit RGB or RGBA, not interlaced;
   transparency is the PNG's own alpha.
2. Run `node tools/patch-art.mjs` (`pnpm patches:art`). It rewrites `art.ts` (the BLPs) and
   `paths.ts` (the list) — both GENERATED, never edited by hand; `pnpm patches:check` fails if
   they are stale.

That is all: nothing has to be registered. `FallbackArtDataSource` (src/vfs/fallbackArt.ts)
answers that path for any install that has no file there.

## What it will and will not do

- **The install always wins.** A player whose build has the real file sees the real file.
- **A remake replaces a derived stand-in by itself.** Where the engine currently COMPUTES a
  substitute (the stone side panels, src/vfs/derivedArt.ts), it does so only when nothing below
  it has the file — and this layer is below it.
- **Art is not a frame.** A file here is served; it is not drawn unless something asks for it. A
  build whose own FrameDef has no frame for it (1.21a's `MainMenu.fdf` has no `EditionButton`)
  needs that frame added as well — see [`src/overrides/`](../overrides/README.md).
- **Only our own work goes in `art/`.** Never a file exported from an install: those are
  Blizzard's, and this folder is committed.
