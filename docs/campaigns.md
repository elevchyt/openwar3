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

### Tuning a backdrop's camera and fog (issue #105)

The main menu's scene has had on-screen sliders since issue #54, and the campaign backdrops
share them: boot with **`?menudebug`** (e.g. `http://localhost:5173/?dev&menudebug`) and the
panel in the top-left drives whichever 3D scene is up. On the campaign screen its title reads
"Campaign backdrop — NightElf_Exp" and it carries **camera + fog only**, because that screen
has no sprite-layer chrome to frame anything against. "Log values" prints every backdrop
touched this session, one line per model path, ready to be baked in.

The camera sliders are dolly, pan X/Y, FOV × and — since pan and zoom cannot produce them —
three **orbit** angles in the game's own vocabulary (`docs/camera.md`): **rotation** (yaw about
world Z), **angle of attack** (pitch about the camera's right axis, positive raises the eye) and
**roll** (the up vector turned about the view direction, so the image spins without the framing
moving). They turn the eye about the MODEL's own camera target, which is the same thing a WC3
camera setup describes — an angle about a target, not a free-flying eye. The main menu's block
carries the identical three.

There are also four **colour-grade** sliders (brightness, contrast, saturation, hue), and they
exist because fog could not do the job: the reference's campaign screens read much darker and
warmer than our render of the same models, and fog only tints what is FAR — Maiev stands a few
hundred units from the eye and stays bright at any fog setting. The grade is a CSS filter on the
canvas (`MenuScene.updateGrade`), which costs one property instead of a post-process pass
through mdx-m3-viewer's render loop. **Backdrops only**: the same canvas carries the menu's
sprite-layer chrome, and dimming the metal panels with the seascape is not what this is for.

Two properties of that panel are the point rather than conveniences:

* **One tuning block per backdrop MODEL** (`BackdropTuning`, `render/menuScene.ts`), because the
  four campaign scenes are four different sets — a nudge that frames Maiev's ruins says nothing
  about Durotar. Switching campaigns re-binds the sliders and each keeps what you left on it.
* **A backdrop with no baked entry starts neutral.** Camera multipliers of 1 and no pan, so it
  renders the model's authored camera exactly; the fog is seeded from that campaign's own
  `BackgroundFog*` keys. Tuned values are then baked per model path in `BACKDROP_DEFAULTS`
  (`render/menuScene.ts`) — an override list, never a replacement for the data.

A baked entry's fog will not match `CampaignStrings_exp.txt`, and that is deliberate. The file's
numbers describe the game's own fog — a `BackgroundFogStyle` and a `BackgroundFogDensity` driving
a renderer that is not ours — so feeding its start/end into our linear distance fog buries the
scene in haze at the depth Blizzard wanted a tint. The baked values are the ones that reproduce
what the reference SHOWS, which is what "match the original" means when the two disagree.

### The corner logo

`CampaignMenu.fdf` declares `WarCraftIIILogo` as a SPRITE with neither art nor size — the engine
hands it a MODEL, `war3skins.txt`'s `CampaignLogo`. Two traps live in that one frame:

1. **`CampaignLogo` is the one skin key with no `_V1` twin**, so the expansion naming convention
   that resolves the backdrops has nothing to resolve and the table only offers the RoC-era model,
   whose texture is the Reign of Chaos logo. The Frozen Throne art ships under the *main menu's*
   key instead: `MainMenuLogo_V1` → `WarCraftIIILogo_exp.mdx` → `ReplaceableTextures\WorldEditUI\
   WarcraftIIIFTLogo.blp`. TFT's campaign screen wears the expansion logo, so that texture is
   what we use when the install has it.
2. **The FDF's `SetPoint TOPRIGHT … 0.08, 0.04` belongs to the model, not to the art.** A glue
   model is a scene with its art somewhere inside a much larger authored extent, and those
   offsets push the extent off the corner so the art lands on it. We draw a flat texture that
   fills its whole box, so honouring them pushes the LOGO off-screen — it must be anchored
   inside the corner instead (`LOGO_INSET`).

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

For DRIVING one — a chapter cannot be reached through the dev boot's `?map=`, whose manifest
lists the install's `Maps\` folder and not the archives — there is `?dev&chapter=NightElfX01`
(`&difficulty=easy|normal|hard`). It resolves the name against the campaign index and starts the
chapter on `campaignConfig`, exactly as the campaign screen would. See `src/dev/devBoot.ts`.

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

**…including the sides no lobby seats.** The w3i player TYPE is 1 user / 2 computer / **3 neutral
/ 4 rescuable**, and `parseMapInfo` kept only the first two — everything downstream of it is a
question about lobby ROWS, and neutral players have none (the real client shows no row for
"Prisoners" either). But they are players: they own units, they hold a colour, they sit in one of
the map's forces, and the map names them. Rise of the Naga fields three — the Watchers' trackers
(1), the Night Elf Villagers (2) and the Prisoners (9) — so the villagers you are sent to save
and the caged prisoners you are sent to free all hovered as a bare "Player 3" / "Player 10" while
every hostile side across the map read its own name. They now ride beside the slots as
`MapInfo.neutralPlayers` and are appended to the match's `MeleeConfig.slots` with the controller
the MAP gave them, which also keeps `applyLobby` from writing MAP_CONTROL_USER over the
`SetPlayerController(p, MAP_CONTROL_NEUTRAL)` the chapter's own `config()` just ran.

**And the player's colour is the MAP's.** Chapter one recolours Maiev's slot 0 to
`PLAYER_COLOR_BLUE`; the HUD portrait was passing the owner's SLOT to `setTeamColor` and so
showed a red bust over blue units. Everything that tints team-coloured art asks
`RtsController.playerColor(owner)` — the units did, the bust and the build ghosts did not.

**It is titled by the CAMPAIGN, not by the map.** The quest log's header read `NightElfX01`,
and that is not a bug in the resolution: the map's own w3i name is `TRIGSTR_003`, and string 3
of its `war3map.wts` is the literal text "NightElfX01". A chapter is named by the campaign index
("Chapter One" / "Rise of the Naga"), so the campaign start states it (`MeleeConfig.mapName`).

## A team is not an alliance, and an alliance is not shared sight

Every side allied to you lit its own corner of the first chapter from the opening frame: the
Watchers' trackers, the Night Elf Villagers and the Prisoners each sat in a pool of explored
ground with their dots on the minimap, across a map the player had not walked. Two separate
causes, and the same mistaken step in both — treating a TEAM as a vision-sharing group.

**A force's flags say what it grants**, and the World Editor proves the mapping by compiling
them into `InitCustomTeams`. Read per force across the campaign maps: flags `1` emits
`SetPlayerAllianceStateAllyBJ` alone (NightElfX01, OrcX01, NightElfX05); `8` emits
`SetPlayerAllianceStateVisionBJ` alone (NightElfX07's third force); `9` emits both; `57`/`59`
add `…ControlBJ` and allied victory; `0` emits nothing at all (NightElfX06's first force — five
members and no pact between them). So `0x01` allied, `0x02` allied victory, `0x08` shared vision,
`0x10`/`0x20` shared (advanced) control. Chapter one's two forces are **1**: allied, and you
still have to go and look. The seeding takes those grants now (`MapInfo.ForceGrants` →
`MeleeConfig.forces` → `AllianceTable.seedFromTeams`); a melee lobby declares no forces and keeps
its own promise, allies allied and sharing sight.

**And a viewpoint's own units are the ones it OWNS.** `revealsFor` short-circuited on
`u.team === this.team`, which is indistinguishable from correct in a melee game — allies there
share vision anyway — and wrong the moment a map allies you without it. Same for `fogHides`,
`fogBlocksClick` and the minimap's dots. Your own units always reveal, are always drawn, and are
always on the minimap; anybody else's need `ALLIANCE_SHARED_VISION` or a pair of your own eyes.
(A team-ONLY viewpoint — `player: -1`, minted for the creep team — still means team, because it
has no slot to own anything.)

## Green is what you own

`UI\MiscData.txt`'s `[SelectionCircle]` block defines exactly three colours and there is no
fourth:

```
ColorFriend=255,0,255,0     // green
ColorNeutral=255,255,255,0  // yellow
ColorEnemy=255,255,0,0      // red
```

An ally is not you: their units and buildings ring the neutral **yellow**, the same as a shop, a
critter or a gold mine, and the same as every player the map plays as neutral. Ours read
`owner === local || team === teamOf(local)` and painted a whole allied force green — which in
this chapter is most of what is on screen. The colour is picked where the alliance table is
(`RtsController.ringAllegiance`) and the renderer just spends it.

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

## A gate written with a life of 0 is not an open gate

The `.doo`'s `life` byte is a PERCENT of the type's HP, and 0 usually means "placed dead" — the
felled trees and rubble the maps scatter by the hundred. It does **not** mean that on a gate, and
`DestructableData` says which types those are: `canPlaceDead` ("Editor - Can Place Dead") is 1 on
all 27 tree types and 0 on all 15 walls, all 100 bridges and **every gate in the game**.

Across the 97 bundled maps, life-0 records on a `canPlaceDead=0` type are eighteen, and every one
of them is a gate or a door. NightElfX07 settles what they mean: its cage gate `gg_dest_DTg3_0739`
is written with life 0 and the map OPENS it later —

```
call SetDestructableLife( gg_dest_DTg3_0739, 0.00 )   // "Player Kills Paladin Guards"
```

— which it could not do if the gate had started open. Read as dead, Rise of the Naga's vertical
Elven Gate at (384, -4352) lost its life bar and all but the two posts its `pathTexDeath` keeps,
while the doodad pass went on drawing a closed gate across the path: a gate you could see, could
not attack, and could walk through. So a type that cannot be placed dead never is, and stands at
full life. (`pnpm sim:test` pins it.)

## A ship is a place to stand, and the sea is a place to sail

Chapter one ends its harbour cinematic by putting Illidan on a boat:

```
call IssueTargetOrderBJ( udg_Illidan, "board", gg_unit_e000_0034 )
...
call TriggerRegisterUnitEvent( gg_trg_Ships_Sails, gg_unit_Eevi_0030, EVENT_UNIT_LOADED )
```

Three things had to exist for that to play, and none of them did.

**The cargo hold is one mechanism with two members.** We had the Orc Burrow's (`Abun`, workers
only, four of them) and nothing else. `AbilityData.slk` keeps both under the `code` column we
dispatch on everywhere: `Abun` is "Cargo Hold (Burrow)", `Acar` is the transport's — alias `Sch5`
"Cargo Hold (Ship)" with `Dataa1` = 10 on every transport ship (hbot/obot/nbot/etrs/ubot) and
`Sch3` = 8 on the Goblin Zeppelin and the air barge. The other rows named "Cargo Hold" are NOT
this and are deliberately excluded: `Advc` is Devour, `Sch2`/`Amtc` the Meat Wagon's corpse bin,
`Aenc` a Gold Mine's crew. A burrow still takes only workers; a transport takes any ground unit
that is not a building or a flier (`Acar` targs: `ground,friend,vuln,invu`). Passengers ride with
the carrier — a ship that sailed off without them would put them ashore at the dock they boarded
from.

**"board" is an order, and it was falling through to `follow`.** The order strings are the game's
own: `Slo3`/`Sloa` carry `Order=load` and `Sdro`/`Adro` `Order=unload` (NeutralAbilityFunc.txt) —
those sit on the CARRIER — while **`board`** is the passenger's and appears in no ability row.
Unhandled, it hit the generic target-order rule ("not hostile → follow") and Illidan walked
circles round the boat forever. `Authority.cargoOrder` takes all three now, and takes them
*before* `castOrder`, or a ship told to "load" would be asked to cast its own `Slo3`.

**A transport paths the WATER.** `movetype=float` is the flag, and the pathing map already
carries the other half of the answer: `war3map.wpm`'s `0x40` bit is "no water". Counted over this
chapter's own wpm (384×512): 67,768 cells are a bare `0x40` (open land), 46,304 are `0x0a` —
Unwalkable + Unbuildable with `0x40` CLEAR, which is the ocean — and 40,328 `0xce` / 12,516
`0xca` are Unwalkable *with* `0x40` set: cliffs, which are not water and which no boat sails
over. So a ground unit asks "is Unwalkable clear?" and a floating one asks "is NoWater clear?",
over one grid, and the shallows (`0x00`) answer yes to both exactly as WC3 has it. That is
`PathDomain` in `src/sim/pathing.ts`, threaded through `findPath`/`smoothPath` and every
walkability test a mover makes. It also fixes the spawn: `createScriptUnit` displaces a unit
created on a blocked cell to the nearest fit, and asked the ground question, every one of the
harbour's `CreateUnit(p, 'etrs', …)` ships was displaced onto the nearest beach.

**And a passenger is not there to collide with.** Cargo rides at its carrier's exact position, so
the separation pass read the two as one unit standing inside another and shoved the ship off
course a few hundred units into the voyage. `resolveCollisions` now skips anything `isOffField`
says is not on the field — which a mining peon and a devoured sheep were only ever saved from by
sitting inside a building's footprint.

`EVENT_UNIT_LOADED` (88, and its player twin 51) is raised by the sim, matched on the PASSENGER —
that is what the map's own registration settles, since it registers on Illidan and not on the
boat — and answers `GetLoadedUnit` / `GetTransportUnit`. `pnpm sim:test` pins the whole path
(`tools/sim-transport-test.cjs`).

## A creep with no "Attack" was swinging its War Stomp

`Owlbear.mdx` — the Wildkin, the Enraged Wildkin and the **Berserk Wildkin** (`nowb`/`nowe`/
`nowk`), which chapter one stages swinging at a Watcher in its own side-quest cinematic —
authors its attack clips in this order:

```
"Attack Spell Slam" | "Attack Slam" | "Attack Slam -2"
```

There is no plain `"Attack"`, and the picker's last-resort rule was "the first sequence whose
name CONTAINS attack" — the War Stomp. So the Berserk Wildkin played a two-armed ground pound
at every blow and never once used either of its two real slams.

102 of the 835 unit models in 1.27a author no plain attack clip, and the fix is scoped by what
the tokens MEAN: a `spell` clip is a cast, and casts are picked by the cast-tag matcher off
`seqNames`, not by the swing picker — the same reason `defend` (a stance), `swim` (a state we
never enter) and `gold`/`lumber` (carry poses) are already excluded from the carry-attack list.
Run over every unit model, that changes the swing for exactly six model families — the Owlbear,
the sasquatches, the furbolgs and the jungle bear — each from `Attack Spell Slam` to
`Attack Slam`, and leaves every other unit's choice untouched. A caster whose ONLY attack clip
is a spell (a Priest's `"Spell Attack"`, 12 models) still falls through to it, because there it
IS the attack. `pnpm sim:test` pins all three cases against the models' own sequence lists.

## …and a blank is not one of them

The rule below has one exception it must respect, and the cinematic panel is where it bites.
`CinematicPortraitCover` — the frame drawn OVER the 3D bust — names `EscMenuBlankBackground` as
its background, which resolves to that same `blank-background.blp`: an all-zero alpha, and (this
is what separates it) a single flat colour end to end. Forced opaque it becomes a black plate over
the portrait, and every transmission in every cinematic plays to an empty frame. So the rule reads
the picture as well as the alpha: painted art (the button faces are 32–50+ distinct colours) is
drawn opaque, a texture of one flat colour is left exactly as it is — nothing.

## Four button faces with a dead alpha channel

Under the night elf (and undead) skin, every in-game button — the F10 menu's, the quest log's
"Done" — came up as a bare gold border with the world showing through it.

The art is there and the skin table points at it: `[NightElf] EscMenuButtonBackground =
UI\Widgets\EscMenu\NightElf\nightelf-options-button-background.blp`, a painted 256×256 with 50+
distinct colours. Its **alpha channel is all zeros**. Six BLPs in the whole install decode that
way, and four of them are these button faces (night elf + undead, normal and pushed); the other
two are `ShadowBuildingNull.blp` and `blank-background.blp`, both of which are *meant* to be
invisible and are used as a shadow and as a "this row does not highlight" marker respectively.

Human and orc point the same key at art with a live alpha (191 flat — the translucent slate the
reference screenshot shows), so the channel is honoured wherever it says anything. This is the
case where it says nothing at all, and the game plainly draws it. So a **BACKDROP's background**
whose alpha is entirely zero is drawn opaque (`opaqueIfBlankAlpha`, one WeakMap-cached copy per
texture). Scoped to that one draw so the null shadow and the blank highlight are untouched.

## Not done yet

- The campaign **cinematics** (`OpenCinematic`/`EndCinematic`) are listed and greyed. WC3 ships
  them as `Movies\*.mpq` files that are, despite the extension, plain RIFF AVIs — nothing this
  engine decodes.
- **Game caches** — the `InitGameCache`/`StoreUnit` family that carries a hero's level and
  inventory from one chapter to the next — are still stubs, so chapters start fresh.
- No profiles, no saved games, no custom-campaign (`.w3n`) screen.
