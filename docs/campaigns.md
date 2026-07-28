# Campaigns (issue #101)

The TFT campaign screen and what it takes to actually start a chapter. Read this before
touching `src/data/campaigns.ts`, `src/ui/fdfCampaign.ts`, or the campaign half of
`src/main.ts` — most of what follows is *not* guessable from the file formats.

## Where the campaign lives

One text file describes the whole thing: **`UI\CampaignStrings_exp.txt`** (War3x, overridden
by War3xLocal for the localized strings). It documents itself in its own header comment, and
that comment decides several things this codebase would otherwise have had to invent:

| Key | Meaning |
| --- | --- |
| `[Index] CampaignList` | the campaign SECTIONS, in the order they appear on screen ("The order of these values is significant"). TFT's list has empty slots where the RoC campaigns were — skip them. |
| `Header` / `Name` | the two lines of a campaign row: "Sentinels Campaign" / "Terror of the Tides". |
| `DefaultOpen=1` | selectable by a new player. TFT opens the Sentinels and Bonus campaigns; Alliance and Scourge unlock behind them. |
| `Background` | a **war3skins.txt KEY**, "processed using the expansion naming convention" — `NightElfBackdrop` + `_V1` → `UI\Glues\SinglePlayer\NightElf_Exp\NightElf_Exp.mdl`. |
| `BackgroundFog*` | the screen's fog: style, `A,R,G,B` in 0–255, density, start, end. |
| `Cursor` | "Human = 0, Orc = 1, Undead = 2, Night Elf = 3" — the screen wears that race's cursor. |
| `AmbientSound` | an `AmbienceSounds.slk` row; the loop under the screen, replacing the main menu's wind. |
| `MissionN="Header","Name","File"` | one chapter. Up to 128; "more than 15 will make a scrollbar appear". |
| `IntroCinematic` / `OpenCinematic` / `EndCinematic` | same shape; they bracket the chapters in the list. |

Reign of Chaos's same-named `UI\CampaignStrings.txt` is an **older format** (no `CampaignList`;
parallel `TitleN`/`MissionN`/`FileN` keys; the campaigns are hardcoded frames in RoC's
`CampaignMenu.fdf`). We parse the TFT file only — RoC is a content profile for later.

### Three traps in that file, all verified against the archives

1. **A quoted field can contain a comma.** `Mission8="Chapter Seven, Part One",…` — split on
   commas naively and every field after it shifts by one.
2. **A row can have a FOURTH field.** The Bonus campaign's chapter two
   (`…OrcX02.w3x",1`) — read and ignored rather than guessed at.
3. **Not every `MissionN` is a map.** Legacy of the Damned's finale, "A Long Time Coming",
   names `Doodads\Cinematic\ArthasIllidanFight\ArthasIllidanFight.mdl` — a MODEL, played
   in-engine. That single row is why `CampaignEntry.playable` exists.

`.mdl` → `.mdx`: the data spells models the World Editor's way and the archives ship the
compiled form. That applies to the backdrops too (`loadCampaigns` does the swap).

`pnpm campaign:test` checks all of the above against the real archives.

## The screen

Built from the game's own `UI\FrameDef\Glue\CampaignMenu.fdf` (`src/ui/fdfCampaign.ts`).

**It is the one glue screen with no panel chrome.** The sprite-layer panel models carry a
`<Screen> Birth/Stand/Death` triple for every other screen in the game — MainMenu,
SinglePlayer, SinglePlayerSkirmish, Options, the whole Battle.net set — and **none for this
one**, because the reference hides the screen edges and lets the campaign's 3D scene fill the
frame. So `GlueScreenDef` grew a `backdrop` field: a screen with one skips the chrome clips
entirely, and `MenuScene.showBackdrop` swaps the 3D model, applies the campaign's fog, and
zeroes both sprite-layer viewports.

A backdrop's camera is used **as authored**, with one correction: it frames a 4:3 screen
exactly (Maiev's ruins have nothing painted past their edges), so a wider viewport keeps the
authored HORIZONTAL extent and gives up height for it. Feed that vertical FOV to 16:9 unchanged
and you see scene that was never built — a black void down one side.

**Where the rows come from.** TFT's `CampaignMenu.fdf` declares no rows at all: it dropped
RoC's fourteen hand-authored `MissionNFrame`s for a runtime list (`CampaignListBox.fdf`, whose
entire contents are a scrollbar) so a custom campaign can carry 128 missions. The stock TFT
campaigns top out at 14, so nothing scrolls, and the geometry we build rows with is **RoC's
own**, out of the same file one edition earlier: a small header line, the name in grey under
it, and a `CampaignArrowButtonTemplate` (or `CampaignCameraButtonTemplate` for a row that
isn't a playable map) hanging off its left — the stack anchored above the Back button and
chained upwards, each row to the one below it. Chaining, not computed offsets: a row's height
is its text's, and only the file's own chain knows it without measuring.

Two modes over one FDF, as the reference has it: the campaign list, then that campaign's
chapters. Both `CampaignSelectFrame` and `MissionSelectFrame` stay mounted (RoC's glue script
hides the individual rows, never the two containers), so the logo, the difficulty box and the
bottom-centre title belong to the screen in either mode.

## Progress and difficulty

WC3 keeps campaign progress in the PROFILE ("Each profile will hold information for your
campaign progress" — GlobalStrings `PROFILE_MESSAGE`). We have no profiles yet, so there is one
implicit profile in localStorage (`src/data/campaignProgress.ts`): chapter N+1 opens when N is
completed, and a campaign opens when the one before it in list order is finished.

"Completed" is the map's own word for it: `RemovePlayer(p, PLAYER_GAME_RESULT_VICTORY)`, which
`CustomVictoryBJ` calls before it shows anything — surfaced as `MapViewerScene.onLocalVictory`.

**Difficulty is not cosmetic.** The screen's dropdown reaches the map through
`MeleeConfig.difficulty` → `GetGameDifficulty` (common.j: EASY 0 / NORMAL 1 / HARD 2 /
INSANE 3). Terror of the Tides gates three of its waves on it directly, and blizzard.j's
"Reduce Difficulty" writes it back through `SetGameDifficulty`.

## Starting a chapter

Campaign maps live **inside the archives** (`Maps\FrozenThrone\Campaign\*.w3x` in
War3x/War3xLocal), not in the install's `Maps\` folder the Custom Game screen browses — so the
bytes come from the VFS, and `startGame` takes `File | Uint8Array`. From there it is the
ordinary custom-map path: the map is not melee-flagged, so its own triggers set the mission up.

`.w3n` campaign archives (a custom campaign packaged as one file) are a separate thing and are
**not** implemented — the stock campaigns ship as loose maps inside the MPQs, and the only
`.w3n` in a 1.27a install is War3x's `DemoCampaign.w3n`.

**ESC skips the opening cinematic**, as it does in the game — the engine raises
`EVENT_PLAYER_END_CINEMATIC` for the local player while the interface is hidden, and the chapter's
own `Intro Skipped` trigger does the rest. It is the map that decides when a cinematic is
skippable at all (`gg_trg_Intro_Skipped` is created disabled), so this is one line of engine and
a lot of map. See [`docs/triggers.md`](triggers.md) §7.24.

### Two engine bugs the first chapter found

Both were invisible until a campaign map was actually started, and both are the kind that make
a map look broken rather than throw:

1. **The doodad object table has two layouts.** `war3map.w3d`'s modifications carry an optional
   level/data-pointer pair; mdx-m3-viewer hardcodes "yes" for w3d/w3a/w3q. That holds for w3a
   (43/43 of the bundled maps) and w3q (15/15), but of 44 `w3d` files only 12 carry it — the
   Bonus campaign's, the last maps Blizzard authored. The other 32 threw "unknown variable
   type" and took the whole map load down. Now detected per file
   (`patches/mdx-m3-viewer@5.12.0.patch`).
2. **Waits inside the trigger QUEUE were dropped.** blizzard.j's `QueuedTriggerAttemptExec`
   runs the queue by calling `TriggerExecuteBJ(...)` from inside an `if` — an expression, which
   JavaScript cannot suspend. Every queued trigger therefore died at its first
   `TriggerSleepAction`. Campaign cinematics ARE queued triggers: chapter one faded to black,
   queued its continuation, and sat black forever. The interpreter now adopts the rest of such a
   callback as its own thread (`runSync`); conditions and filters keep the strict behaviour,
   because WC3 forbids a wait there too.

## Destructibles are widgets, not scenery

The first chapter shuts its opening path with an Elven Gate, and there was no way to attack
it — a destructible was map geometry, a pathing footprint and a JASS handle, with no life to
spend, no body to stand beside and no identity a weapon could match. It is a sim UNIT now
(`RtsController.addDestructible`), which is how WC3 has it too: a destructable and a unit meet
one class up, at `CWidget`. Three things make it a destructible rather than a unit —
`neutralPassive` (so nothing ever AUTO-acquires a crate), `targetKey` (its `targType`, matched
against a weapon's Targets Allowed), and no body of its own (the doodad pass already drew it).

The data decides which ones, and it is unambiguous:

| `DestructableData` | what it means here |
| --- | --- |
| `selectable` | can a click pick it up at all — 0 on the invisible platforms a map lays down by the hundred |
| `targType` | the weapon-target class. `debris` (77 types) and `wall` (15) are attackable; **every** melee unit's Targets Allowed reads `ground,structure,debris,item,ward`. `bridge` (100) and `decoration` (28) are in nobody's list |
| `HP` / `radius` | life and the collider a unit stands off from |
| `armor` | the MATERIAL struck (Wood/Stone/Flesh) — the impact SOUND, not a damage class. There is no destructable row in the damage table, so a blow lands undivided |
| `portraitmodel` | the bust the selection panel shows; the doodad's own model is a piece of terrain |

Rise of the Naga seeds 17 of its 2698 destructibles this way (the rest are 2502 trees, which
have their own harvest path, and scenery).

**Life crosses the bridge in both directions.** The sim drives the record's `life` down as the
gate is hit, and the script's own `SetDestructableLife` / `DestructableRestoreLife` /
`KillDestructable` drive the sim unit's hp — this chapter opens by knocking its gate to a fifth
(`SetDestructableLife(gg_dest_LTe1_1140, 0.20 * life)`), and without that the player would face
all 500. Death routes back out through the same `killDestructible` a trigger goes through, so a
gate broken by an axe opens exactly as one opened by `ModifyGateBJ`: death clip held on its last
frame, collider down to the posts `pathTexDeath` keeps.

Two traps, both found by doing it:

1. **Seed AFTER `setPlacedOrder`.** That call reserves sim ids 1..N for the `.doo`'s own units
   and resets the counter above them. Seeding first handed the destructibles ids 1–14 and the
   placed units then took those same ids back — a gate quietly became a Watcher.
2. **Attach the body LATE.** The sim units are created as soon as the pathing is known; the
   viewer builds its 3905 doodad instances after that. Seeding with a null body left every gate
   orderable but un-*clickable*, because picking walks the Entry list and an Entry is exactly
   what a body buys. It is retried per frame, the same late-attach a script-spawned unit gets.

`pnpm sim:test` pins the rules (`tools/sim-destructible-test.cjs`).

## A chapter is not a skirmish

Four things the campaign path had inherited from the Custom Game screen and should not have,
all in `campaignConfig` / `beginMatch`:

**It starts BLACK.** `fog: "explored"` is the lobby's convenience default; no campaign map has
ever handed you its terrain. It matters beyond looks — the chapter's own script is what parts
the mask, and Rise of the Naga's intro even wipes the map back to `FOG_OF_WAR_MASKED` when the
cinematic is skipped, which only makes sense against a map that was never explored.

**The sides have NAMES.** A campaign map names every player it fields in its w3i player records
— "Watchers", "Illidan's Naga", "Illidan's Servitors", "Ferocious Beasts", "Wild Mur'guls",
"Night Elf Villagers", "Prisoners", "Illidan" — and that is what WC3 prints under a hovered
enemy. They are TRIGSTR keys into the map's own `war3map.wts`, resolved in `parseMapInfo` and
carried on `PlayerSlot.name` → `SlotConfig.name` → the hover tooltip. Only a slot the map left
unnamed falls back to "Computer (Normal)".

**A placed AI unit holds its ground.** `Units\MiscGame.txt` states the rule for a *unit*, not
for a creep: "After a unit has strayed 'GuardDistance' from where it started, that unit begins
thinking about heading back to its start position" (600, with `MaxGuardDistance` 1000 and
`GuardReturnTime` 5 s). Without it an auto-acquired chase RATCHETS — kill something 600 out,
re-acquire from the new spot, repeat — and a placed unit walks off across the map. So a computer
player's units carry the LEASH half of the guard behaviour (`SimUnit.guarding`) and nothing else:
no sleep, no camp cohesion, no bounty — those are Neutral Hostile's own. The post is fixed in one
sweep when `holdWorld(false)` releases the world, because a map has several ways to put a unit
down (the `.doo` adoption, `CreateUnit` inside `CreateAllUnits`, a `CreateNUnitsAtLoc` in its
init) and "where it was standing when the map finished setting up" covers all of them. Anything
that COMMANDS the unit clears the post, and an ORDERED attack is never leashed — a scripted
attack wave means it.

**A gate is clicked by its `selcircsize`.** `radius` is the "Elevation Sample Radius"
(WorldEditStrings `WESTRING_BEVAL_BRAD`), 50 on every gate in the game; `selcircsize` is
"Selection Size - Game" (`WESTRING_BEVAL_BGSC`) and reads **512** for all 45 of them, 128 for a
tree, 60 for a crate. Sizing the selection off `radius` made a 640-unit Elven Gate clickable only
within a stride of its centre.

## Not done yet

- The campaign **cinematics** (`OpenCinematic`/`EndCinematic`) are listed and greyed. WC3 ships
  them as `Movies\*.mpq` files that are, despite the extension, plain RIFF AVIs — nothing this
  engine decodes.
- **Game caches** — the `InitGameCache`/`StoreUnit` family that carries a hero's level and
  inventory from one chapter to the next — are still stubs, so chapters start fresh.
- No profiles, no saved games, no custom-campaign (`.w3n`) screen.
