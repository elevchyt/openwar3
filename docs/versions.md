# Which Warcraft III — every classic build, one game

Issue #319. OpenWar3 used to require The Frozen Throne **1.30.4** and nothing else. It now reads
**any classic install with The Frozen Throne, 1.21 through 1.31.1**, and plays the *same game* on
all of them: the current balance patch.

**What we recommend is Warcraft III 1.29 — the "Warcraft III (Legacy)" install Battle.net offers
beside Reforged** (`1.29.2.9232-legacy-tft`). It is the original game, anybody who owns Warcraft
III can still download it, and it needs the least done to it.

| build | storage | what the mount does | checked against |
| --- | --- | --- | --- |
| 1.21a | MPQ, `war3 < war3x < war3xlocal < war3patch` | normalize 2 613 cells, derive art | Hive's "Files_1.21a" |
| 1.28.5 | MPQ, `+ War3Local`, `+ War3Patch` | normalize 2 514 cells, derive art | Hive's "Files_1.28.5" |
| 1.29.1 | MPQ, `Deprecated < War3 < War3Local < War3x < War3xLocal` | normalize 2 452 cells | Hive's "Files_1.29.1" |
| **1.29.2** | the same | normalize 2 243 cells | Battle.net's Legacy install, and Hive's (identical tables) |
| 1.30.4 | CASC | nothing — the build the engine is written against | the developer's install |
| 1.31.1 | CASC, `War3.w3mod` | renamed back + 6 553 cells turned back | docs/casc.md "1.31.1" |
| 1.32+ (Reforged) | CASC, another layout | **not mounted** — used as the reference instead | — |

A build between those that nobody has measured (1.22 … 1.27b, 1.28.0 … 1.28.4, 1.29.0) is
mounted as the NEAREST measured one with its archive layout, and the console says so. That is
honest about what it is: the edits state 1.30.4's value for every cell the *nearest* build has
differently, so a cell only the unmeasured build changed stays as that build has it. The fix is
always the same — get the build, run the two commands below, commit the file.

## Why the version stopped mattering

A match's units, abilities and costs are read out of each machine's own install, so two players
on different patches would be playing two different games (src/vfs/version.ts). The answer used
to be a gate. It is now a **normalization**, in three layers the loader stacks at the one door
every install comes through (`loadProfile`, src/vfs/loader.ts):

    the install's own archives        MpqEraDataSource / CascDataSource
      → its object tables AS 1.30.4's   NormalizeDataSource     src/patches/normalize/<build>.json
        → the later patches             PatchDataSource         src/patches/data/*.json  (docs/patches.md)
          → the edition's data set      EditionDataSource       (docs/editions.md)
            → art the build lacks       DerivedArtDataSource    (docs/icons.md, and below)

The middle step is the new one. `src/patches/normalize/<build>.json` holds the 1.30.4 value of
every cell that build has differently, in **all four data sets**, and it is not written by hand:

    node tools/version-survey.mjs --install <folder> --label 1.27b
    node tools/patch-extract.mjs --normalize .cdn-cache/extract/1.27b

The second command writes the file and then APPLIES it to the build's own tables and compares the
result with the 1.30.4 install's, as tables (row → column → value). It must leave no cell of
difference, and for the four MPQ builds above it leaves none. `pnpm versions:test` proves the
same thing again through the engine's own classes, against the real installs:

    node tools/version-normalize-test.cjs "1.29.2=/path/to/Warcraft III (Legacy)" "1.21a=/path/…"

168 tables and 1 254 004 cells per build, all four reading as 1.30.4 does.

**Reforged is the reference, not 1.30.4.** 1.30.4 is only the waypoint the patch chain is stated
against. What every build is meant to END at is the live game, so the chain's end is checked
against a real Reforged install (`node tools/patch-extract.mjs --install <Reforged> --verify`):
against 3.0.1.24371 it leaves the residual docs/patches.md already accounts for (the Forsaken
Paladin, the equipment system, engine settings) and no melee balance cell.

## What an MPQ-era install is (src/vfs/mpqEra.ts)

Measured with `tools/version-survey.mjs`; five things, each of which was a bug first:

- **Three generations of archive names are one order.** Every name of `MPQ_ERA_ORDER` a folder
  has is mounted, lowest first. 1.29 folded `War3Patch.mpq` into the four archives it patched and
  moved old-custom-map art into `Deprecated.mpq` — the name and the job it still has in a 1.30.4
  store.
- **The archives win over a `.build.info`.** The Legacy install has both, and a `Data\` folder
  too; they are the launcher's. `isMpqEraInstall` is asked first at all three doors.
- **A tileset's two halves are in two archives.** `War3.mpq` and `War3x.mpq` each carry a nested
  `<letter>.mpq`. It is answered as `Z.mpq:<path>` across both, which is how a 1.30.4 store spells
  it (src/vfs/tileset.ts).
- **The listfile is a courtesy.** An MPQ finds a file by the hash of its name. 1.21a's archives
  hold 333 of 1.30.4's files that no listfile names — and, worse, its `War3Patch.mpq` overrides
  `Units\AbilityData.slk` WITHOUT listing it, so a listfile walk extracts the stale copy under
  it. Nothing in the mount consults the list; `list()` is for the tools that enumerate.
- **A data set is an overlay.** 1.30.4 files four whole copies of every table. 1.21–1.29 file only
  the tables a set changes — and yes, `Custom_V0`/`Custom_V1` are already in 1.21a's patch
  archive — so a set's missing table STARTS as the build's live table, the edits are stated
  against that, and `NormalizeDataSource.exists` answers for it even with no edits of its own
  (the live table beside it is being rewritten into something else).

Which build a folder is, is read off its TABLES (`buildFingerprint`: a hash of the unit and
ability balance) — an MPQ install does not say, and the tables are what the edits are stated
against anyway. `FINGERPRINTS` in src/patches/normalize/index.ts is the list.

## What is NOT normalized

- **Wording.** Names and tooltips are the install's own — Blizzard's text, and not game data. Four
  of the patch chain's tooltip `replace`s (docs/patches.md) are written against 1.30.4's wording
  and log "has no … to replace" on 1.29.2 (Critical Strike, Tranquility); seven on 1.21a. The
  NUMBERS those abilities play with are right; the sentence describing them is the old one.
- **Scripts.** `common.j` / `Blizzard.j` are the build's own. An older one declares fewer natives
  and BJs; a map that calls a later one degrades as docs/map-compatibility.md describes.
- **UI files.** The FrameDefs are the build's. See the gaps below.
- **Art.** A build draws its own models and textures. Art a later patch ADDED is derived (next
  section) or absent.

## What each build lacks, and the fallback

`node tools/version-survey.mjs --compare <label>` lists every 1.30.4 path a build has no file
for. Against 1.30.4's 20 385: 1.29.2 lacks 258, 1.28.5 575, 1.21a 621 — and most of those are
things the engine never asks for (Battle.net chat icons, the movies' captions, 1.30's
re-filed cinematic textures, which the older build's own models do not reference).

What a match does ask for, and what answers it (src/vfs/derivedArt.ts — derived at the mount from
the install's own art, never shipped):

| missing | builds | fallback |
| --- | --- | --- |
| `TeamColor16…27`, `TeamGlow16…27` (24 players, 1.29) | ≤ 1.28.5 | the swatch is its colour (`TEAM_COLORS`, read off 1.30.4's); the glow is the install's `TeamGlow00` in that colour. 12–15 are REPLACED too: such an install's 12 is the neutral black |
| `<Race>UITile05/06` and their four frames (widescreen console, 1.29) | ≤ 1.28.5 | the frames are added in code to 1.30.4's numbers (`ConsoleUi.rootFrame`); the art is the stone pier of the console's own first tile, laid across (`wallFromConsole`) |
| `PASBTN*` / `DISPASBTN*` the patches name | all | docs/icons.md |

**Art that needs REMAKING** (issue #319) — asked for by the game, and answered today by a
stand-in or by nothing. 14 files, and no others: an old build's own models reference only
textures that build has (checked on 1.21a and 1.29.2 — 3 234 models, 8 089 references), so the
~360 `Doodads\Cinematic\*` and `Textures\*` files 1.30.4 has and they lack are 1.30's re-filing.

| file | size | builds that lack it | today |
| --- | --- | --- | --- |
| `UI\Console\<Race>\<Race>UITile05.blp`, `…06.blp` × 4 races | 512×512 | ≤ 1.28.5 | derived stone (`wallFromConsole`) — nothing like the real framed panel on the orc, undead and night elf consoles |
| `UI\Widgets\Glues\GlueScreen-ROC-EditionButton-{up,down,disabled}.blp`, `…-TFT-…` | 64×64 (down 32×32) | ≤ 1.27b | nothing; and such a build's `MainMenu.fdf` has no `EditionButton` frame to wear them |

**Where a remake goes:** `src/fallback/art/`, as a PNG at the game's own path
([`src/fallback/README.md`](../src/fallback/README.md)). `node tools/patch-art.mjs` turns it
into a BLP and `FallbackArtDataSource` (src/vfs/fallbackArt.ts) serves it to any install with no
file there — under the layer that derives, so a drawn panel retires the derived one by itself.
The folder is empty today. An edition button will also want its frame added for 1.21a.

`TeamColor16…27` are exact (a swatch is its colour) and `TeamGlow16…27` are the install's own
glow re-tinted; neither needs a remake.

**Strings 1.30 added** are answered out of the older table (`FdfLibrary.laterString`): the
Video panel's per-row rungs (`LOW_MODELS` → the build's `LOW`) and a button's accelerator
(`KEY_START_GAME_SHORTCUT` → the highlighted letter of `KEY_START_GAME`). 1.29.2 lacks 129 of
1.30.4's GlobalStrings keys and those two families are all but eight of them. Of the eight,
our code names one — `DOWNLOADING_MAP`, which has a fallback at its call site; the rest
(`COLON_REGION`, `UPDATE_REQUIRED`, `FAST_SCROLL`, `SLOW_SCROLL`, `KEY_BROWSER`, `RESERVED`,
`TAIWAN_LEGAL`) nothing of ours asks for.

**Known gaps** — seen, or listed by the survey and NOT yet looked at in the running game:

- `UI\FrameDef\UI\ObserverPanel.fdf` is new in 1.30: NO older build has it, Legacy included.
  The observer HUD reads its checkbox and pulldown from it; not yet driven on an old build.
- 1.21a has no `Glue\Dialog.fdf` / `Glue\ListBox.fdf` (1.28.5 not checked), and its main menu
  has no edition switch, so Reign of Chaos cannot be reached from the menu there.
- Only the main menu, Options → Video and a melee match were driven on 1.29.2, and the menu and
  a match on 1.21a. No campaign, LAN game, observer HUD or other screen on an old build.
- An MPQ mount reads every archive whole — about 1.1 GB of files for 1.29.2 — where a CASC mount
  reads slices. Not measured in the 32-bit Linux shell (docs/linux.md), which has little room.
- 1.30.0 … 1.30.3 are CASC stores with no normalization yet and are still refused.
