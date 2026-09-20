# Editions — Reign of Chaos and The Frozen Throne

1.30.4 is one client that plays both games. The main menu carries the switch, and almost
nothing about it is ours: the button, both of its emblems, every table the other game reads
and every piece of glue art it wears are already in the install, keyed by version. Read this
before touching `src/data/edition.ts`, `src/vfs/edition.ts`, anything that reads a `_V0`/`_V1`
key, or a constant that differs between the two games.

---

## The button

`UI\FrameDef\Glue\MainMenu.fdf` declares `GLUEBUTTON "EditionButton"` inside the Single
Player backdrop — the square to the right of Single Player. Its three backdrops name
`UI\Widgets\Glues\GlueScreen-ROC-EditionButton-{up,down,disabled}.blp`, and the install
ships the `-TFT-` twin of all three. The file is the expansion's, and on the expansion's menu
the button wears the **Reign of Chaos** emblem — it shows where pressing it TAKES you. On a
Reign of Chaos menu `ui/fdfMainMenu.ts` points the three backdrops at the TFT twin.

Pressing it (`switchEdition`, `src/main.ts`) crosses the whole menu through black
(`GlueManager.crossWorlds`): the screen fades out as it stands, the edition flips, the 3D
scene/panels/logo reload as the other game's (`MenuScene.reloadEdition`), the glue theme and
wind swap (`GlueAudio.swapEdition`), and the new main menu arrives on its chrome Birth as the
black lifts. The choice is remembered (`localStorage` `openwar3.edition`).

## What the switch changes, and where each piece is read

### 1. The object tables — a data set, laid over the live paths

A 1.30.4 store keeps THREE more complete copies of the object tables one folder down, at the
same paths under `Melee_V0\`, `Custom_V1\` and `Custom_V0\`. They are a 2×2, and the live
paths are the fourth corner:

|  | The Frozen Throne | Reign of Chaos |
|---|---|---|
| **melee map** | the live `Units\*` (there is no `Melee_V1\`) | `Melee_V0\` |
| **anything else** | `Custom_V1\` | `Custom_V0\` |

Each folder carries the same set:

| twin | what it is |
|---|---|
| `<set>\Units\*` (85 files) | every unit/ability/upgrade/item table — RoC's are 469 UnitBalance rows against the expansion's 837, no fourth heroes, no shops, no tavern |
| `<set>\Scripts\{human,orc,undead,elf}.ai` + `*.pld` | that set's own melee AI scripts (V0's are a different codebase from V1's) |
| `<set>\UI\Framedef\InfoPanelStrings.fdf` | armour tips that describe that set's damage table |

`EditionDataSource` (`src/vfs/edition.ts`) is the whole rule: **a path with a twin under the
folder `dataSetFolder()` names reads the twin.** It wraps both storages at `loadProfile`, the one
door every install passes through, and it asks both switches at every lookup — so anything that
parsed a table BEFORE a switch still holds the other set's copy. A match builds its tables
fresh (`MapViewerScene.syncDataSet`, which re-reads the five registries when the set underfoot
has moved); the two module-level caches that outlive a match (`mapBrowser`'s unit registry, the
hotkey editor's catalog) drop themselves on `onEditionChange`, which BOTH switches fire.

**Why both axes.** The edition is the obvious one — see the armour-class count below. The map
KIND is the one that is easy to miss, and it is not cosmetic: the melee sets carry the balance
patches 1.29+ made and the custom sets are frozen where each game shipped, so the same unit is
two units depending on which kind of map you are on.

| | melee (latest) | custom (as shipped) |
|---|---|---|
| Knight | 835 | 800 |
| Troll Headhunter | 375 | 350 |
| Archer | 260 | 310 |
| Flying Machine | 250 | 175 |
| **Grunt, Reign of Chaos** | **700** | **680** |

70 units differ in hit points alone between the expansion's two sets. The Grunt is the row this
was found through: a Grunt in Scourge of Lordaeron has 680 hit points in the reference client
and had 700 here, because a campaign chapter is a CUSTOM map and every set but `Custom_V0`
says 700.

The map kind is taken from the w3i melee flag (`world/mapKind.ts`), which is the same bit the
whole client already uses to decide melee rules against a map's own triggers; `startGame` sets
it before a byte of the map is read, and `exitToMenu` puts it back on melee so the shell's own
table reads (map previews, the hotkey cards, tooltips) describe the ordinary game.

An MPQ-era install has none of the three folders, so it reads the same tables throughout.

**How much this moves is the reason it is tested rather than assumed.** The two games are not a
reskin of each other: **232 of the 468 units they both carry change ARMOUR CLASS**, and the
damage table those classes are read against changes with them. A Footman is Medium on Reign of
Chaos and Heavy on the expansion; a Raider is Light/0 against Medium/1; a Wind Rider goes the
other way, Heavy against Light; a Knight hits for 19+2d5 against 28+2d5. Read the wrong set and
nothing breaks — every fight is just quietly balanced for the other game.
`tools/sim-edition-data-test.cjs` pins the whole chain against the install: the overlay itself
(including the twin of `UI\FrameDef\InfoPanelStrings.fdf`, which is filed under a DIFFERENT
spelling of the folder — `Melee_V0\UI\Framedef\` — so the lookup has to fold case), the rows
`loadUnitRegistry` builds out of it, and the `damageMultiplier` those rows are graded by.

**The switch is read at the LOOKUP and that is load-bearing**, because the menu flips editions
on an install that is already mounted: an `EditionDataSource` built while on the expansion has
to start answering with Reign of Chaos's tables the moment the button is pressed. The same is
true one layer up — the viewer's base SLK blob urls are built per MATCH (`MapViewerScene.create`),
so they are the current edition's too.

**A map states the kind and not the set.** A Reign of Chaos map's w3i is version 18 and carries
no "Game Data Set" field at all (Human01's flags are `0x1C69` — no melee bit, no data-set word);
the field the World Editor exposes as "Melee (Latest Patch)" / "Custom (1.01)" only exists in
much later w3i versions, and 1.30.4 ships none of them. So the engine derives it, and the one
thing every map DOES state is the melee bit — which is what the table above keys on. The
install says the same thing in its own strings: `InfoPanelStrings.fdf` keeps a full set of
armour and damage tips suffixed **`_V0M`** and **`_V0C`** — Melee and Custom of version 0 — and
they do not agree ("Medium armor takes extra damage from Magic attacks" against "All attacks do
full damage to Medium armor"). A file that describes both is a file for an engine that reads
both.

### 2. `Units\MiscGame.txt` — compiled in, so restated

The gameplay constants are literals in `src/data/gameplayConstants.ts` (checked by
`pnpm data:verify`), which the VFS overlay cannot reach. `MISC_GAME_V0` restates the rows
Reign of Chaos's copy disagrees on, and `pnpm data:verify` checks it against
`Melee_V0\Units\MiscGame.txt`.

**This file is keyed on the EDITION only, and that is checked rather than assumed.** Compared
key by key across all four sets, every `DamageBonus*` row and every XP rule
(`HeroFactorXP`, `GlobalExperience`, `MaxLevelHeroesDrainExp`, `BuildingKillsGiveExp`) is
identical between a version's melee and custom copies — so a campaign chapter is graded by its
edition's table, which is what `damageTable()` already answers with. Exactly **one** number in
this file moves with the map kind and is therefore still the melee value everywhere:
`DamageBonusSpells` against HERO armour is 0.70 on the expansion's melee tables and 0.75 in the
other three sets. Reaching it would mean a third compiled-in block and a third precomputed
damage table for five percentage points on one attack/armour pair, so it is written down here
instead. The kind-dependent BOOLEANS in the same file (the Illusion rows, the Drain rows,
`CycloneStasis`, `MoveSpeedBonusesStack`…) are in the same position.

The ones the sim reads:

| key | TFT | RoC | read by |
|---|---|---|---|
| `DamageBonus*` | 1.0/1.5/1.0/0.7… | 1.5/1.0/1.0/0.5… | `damageTable()` / `damageMultiplier` (+ Computer+ countering) |
| `HeroFactorXP` | 80,70,60,50,0 | 100 | `creepXpFactor` — creeps never stop paying |
| `GlobalExperience` | 1 | 0 | `awardKillXp` — no hero in range, no XP |
| `MaxLevelHeroesDrainExp` | 1 | 0 | `awardKillXp` — a max-level hero is not a sharer |
| `BuildingKillsGiveExp` | 0 | 1 | `awardKillXp` — razing pays |

The rest of the diff (`MagicImmunesResist*`, `DefendDeflection`, `Ensnare/WebIsMagic`,
`MinUnitSpeed`, `DisplayEnemyInventory`, the awaken factors) covers behaviour the sim does not
model in either edition yet.

**The food ceiling is the engine's**, not a file's: 100 on the expansion, **90** on Reign of
Chaos (`MISC_ENGINE.FoodCeiling_V0`, `engineFoodCeiling()`).

### 3. `common.j`'s `VersionGet()`

Answered off the switch (`src/jass/natives/melee.ts`), which is how Blizzard.j itself picks
`bj_MELEE_STARTING_GOLD_V0`/`LUMBER_V0` (750/200 against 500/150), a three-hero random-hero
roll, and `bj_MELEE_MAX_TWINKED_HEROES_V0`. `VersionCompatible(VERSION_FROZEN_THRONE)` is
false on Reign of Chaos. The no-script melee fallback in `mapViewer.ts` mirrors the same pair.

### 4. Every versioned war3skins key

`UI\war3skins.txt` suffixes a key with `_V0` or `_V1` (`skinVersionSuffix()`):

| key | used for |
|---|---|
| `GlueSpriteLayerBackground/TopLeft/TopRight` | the menu's 3D scene and panel chrome (`MenuScene.load`) |
| `MainMenuLogo` | the logo |
| `GlueMusic`, `GlueScreenLoop` | the menu theme and wind (`GlueAudio`) |
| `CampaignFile` | the campaign index — `UI\CampaignStrings.txt` on RoC |
| `*Backdrop` | each campaign's 3D backdrop |
| `Music`, `VictoryMusic`, `DefeatMusic` | a race's in-game playlists |

1.30.4 streams the mp3s, and a store need not hold Reign of Chaos's — this one has
`War3XMainScreen.mp3` and not `Mainscreen.mp3`. Both music readers fall back to the expansion's
list rather than going silent.

The menu's CAMERA is ours, per scene: `TFT_SCENE_TUNING` sits Icecrown behind the panel, and
`ROC_SCENE_TUNING` dollies Reign of Chaos's meadow in until a 16:9 frame no longer shows the
black past its edges (the authored camera is a 4:3 shot).

The same is true of the campaign BACKDROPS, and more so: each RoC `*Campaign3D` set is a small
diorama built only as wide as the 4:3 shot it was authored for, so all five needed an entry in
`BACKDROP_DEFAULTS` (menuScene.ts) before a 16:9 frame stopped showing the black past the sky
plane. The lens does the work — every entry narrows `camFov`, two drop the eye 2°, and a TILT
makes it worse rather than better, which is how you can tell the corner is the set's edge and
not the horizon. Three also push their fog out: those campaigns' own `BackgroundFog*` keys end
at 1600–2950 units, which in our linear distance fog hazes the subject itself.

### 5. Campaigns

`UI\CampaignStrings.txt` is the SAME format as `_exp` on 1.30.4 (an older note in this repo
said otherwise — it was wrong): a `CampaignList` of five sections, `MissionN` rows naming
`Maps\Campaign\*.w3m`. Four of its section names are also the expansion's (`Human` is The
Scourge of Lordaeron in one file and Curse of the Blood Elves in the other), so a RoC
campaign's key carries a `RoC.` prefix — the key is what progress is saved under.
`pnpm campaign:test` checks both indexes against the store.

### 6. Maps and multiplayer

A `.w3x` is the expansion's map format, and Reign of Chaos never could open one: its Custom
Game and LAN screens list the `.w3m`s only (`editionMaps()` in `main.ts`). A LAN room carries
the host's `edition` (`RoomInfo.edition`, passed through untouched by `server/rooms.mjs`), and
each client lists only its own edition's games — the two read different tables, so a mixed
match would desync on the first blow. A relay older than the field reports no edition, which
reads as the expansion.

### 7. The melee AIs

Both computers were written against the expansion. The classic port (`src/ai/*.ts`) drops any
build row whose id the loaded tech tree does not have (`AiPlayer.makeable`) and draws its heroes
from three (`pickMeleeHero`, common.ai's own `VersionCompatible` branch). Computer+ runs every
race table through `tableForEdition` (`src/ai/plus/races.ts`), which removes what the tech tree
lacks and moves units whose RoC `Requires` put them a tier later. Neither ports
`Melee_V0\Scripts\*.ai` — RoC's own scripts are a different strategy, and a faithful port is
still open.

## Known gaps

- Reign of Chaos's melee AI scripts are adapted, not ported.
- `ScoreScreenVictory_V0` and the other score-screen keys are unread, as their `_V1` twins are.
