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

A 1.30.4 store keeps Reign of Chaos's tables one folder down, at the same path under
`Melee_V0\`:

| RoC twin | what it is |
|---|---|
| `Melee_V0\Units\*` (85 files) | every unit/ability/upgrade/item table — 469 UnitBalance rows against the expansion's 837, no fourth heroes, no shops, no tavern |
| `Melee_V0\Scripts\{human,orc,undead,elf}.ai` + `*.pld` | RoC's own melee AI scripts (a different codebase from the expansion's) |
| `Melee_V0\UI\Framedef\InfoPanelStrings.fdf` | armour tips that describe RoC's damage table |

`EditionDataSource` (`src/vfs/edition.ts`) is the whole rule: **while on Reign of Chaos, a path
with a `Melee_V0\` twin reads the twin.** It wraps both storages at `loadProfile`, the one door
every install passes through, and it asks the switch at every lookup — so anything that parsed
a table BEFORE a switch still holds the other game's copy. A match builds its tables fresh; the
two module-level caches that outlive one (`mapBrowser`'s unit registry, the hotkey editor's
catalog) drop themselves on `onEditionChange`.

Why `Melee_V0` and not `Custom_V0`: the World Editor names the folders "Melee (Latest Patch)"
and "Custom (1.01)". The expansion side reads the latest tables for every map, so the RoC side
does too. `Custom_V1` is the expansion's own "Custom" snapshot and is unused.

An MPQ-era install has no `Melee_V0\`, so it reads the same tables in both editions.

### 2. `Units\MiscGame.txt` — compiled in, so restated

The gameplay constants are literals in `src/data/gameplayConstants.ts` (checked by
`pnpm data:verify`), which the VFS overlay cannot reach. `MISC_GAME_V0` restates the rows
Reign of Chaos's copy disagrees on, and `pnpm data:verify` checks it against
`Melee_V0\Units\MiscGame.txt`. The ones the sim reads:

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
