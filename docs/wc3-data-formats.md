# WC3 data layout — where the game keeps its data

A field guide to the Warcraft III (TFT 1.27a) data model: which archives hold what, the file formats,
and **exactly where a given piece of data lives** (target flags, tooltips, names, hotkeys, icons, sounds…).
Everything here is verified against the real MPQs in `Warcraft III/`; the **MPQ wins** over any reference
(see [`REFERENCES.md`](REFERENCES.md)). OpenWar3's parsers that consume each file are noted inline.

## Archives (MPQs)

The game data is spread across four MoPaQ archives, mounted **lowest-priority first** (later overrides
earlier — a "patch wins" layering). OpenWar3 mounts them in `src/vfs/profiles.ts`:

| Archive | Holds | Notes |
|---|---|---|
| `War3.mpq` | All **Reign of Chaos** data, models, textures, and base sounds | RoC unit/ability tables + PCM voice WAVs |
| `War3x.mpq` | **Frozen Throne** models, data tables, textures, effect sounds | TFT-added units/abilities/heroes live here |
| `War3xLocal.mpq` | TFT **localized** content — unit **voice** lines, cinematics | Locale-specific (`enUS`) |
| `War3Patch.mpq` | The 1.27a patch — **overrides** rows/files in all of the above | Highest priority; always check here first |

A given table (e.g. `AbilityData.slk`) may exist in several archives; the patch copy is authoritative.
Probe every archive when a row/file seems missing — the internal `(listfile)` is incomplete, but
`archive.has(path)` is reliable.

**Audio gotcha:** every WAV is stored **Huffman(+ADPCM)** compressed. `War3.mpq` WAVs are PCM and decode
trivially; **all** `War3x`/`War3xLocal` WAVs are Huffman, which needs a dedicated decoder
(implemented in `patches/mdx-m3-viewer@5.12.0.patch` → `huffman.js`). See the memory note on the audio fix.

## File formats

| Ext | Format | Content |
|---|---|---|
| `.slk` | SYLK spreadsheet (text) | The **numeric** data tables (rows = object ids, columns = fields). Case-insensitive row keys. |
| `.txt` | INI-like (`[ID]` sections) | Per-race **art / strings** tables (icons, button positions, names, tooltips, hotkeys). |
| `.mdx` | Binary model | Units, buildings, doodads, missiles, spell effects (`.mdl` is the text form; MPQs ship `.mdx`). |
| `.blp` | Blizzard texture | Icons (`ReplaceableTextures\CommandButtons\BTN*.blp`), skins, minimap (`war3mapMap.blp`). |
| `.wav` | Huffman+ADPCM audio | Voices, weapon impacts, UI sounds. |
| `.w3e/.doo/.w3i/…` | Map chunks | Terrain, placed units/doodads, map info (see Maps below). |

Parsers: SLK/TXT via `mdx-m3-viewer`'s `MappedData`; MDX/BLP/MPQ via `mdx-m3-viewer`; wired through
`src/vfs/`.

## Units — where each field lives

A unit's data is **split across several tables**, all keyed by the 4-char rawcode (e.g. `hfoo`, `Hblm`).
OpenWar3 merges them in `src/data/units.ts`:

| Data | File | Key fields |
|---|---|---|
| Race, movement, pathing | `Units\UnitData.slk` | `race`, `movetp`, `moveheight`, `turnrate`, `pathTex` |
| HP / mana / cost / attributes / collision | `Units\UnitBalance.slk` | `hp`, `manaN`, `goldcost`, `lumbercost`, `fused`/`fmade` (food), `bldtm`, `STR`/`AGI`/`INT`, `primary`, `def`, `collision`, `realhp`/`realm`/`realdef` (precomputed hero L1 stats), `level` |
| Attack | `Units\UnitWeapons.slk` | `dmgplus1`, `dice1`/`sides1`, `cool1`, `rangeN1`, `weapTp1`, `atkType1` |
| Model, sound set, hit sounds, scale | `Units\UnitUI.slk` | `file` (model path), `unitSound` (**sound-set label**), `weap1`/`weap2` (impact/chop sounds), `armor` (material struck), `scale` |
| **Name, tooltip, hotkey** | per-race `Units\<Race>UnitStrings.txt` | `Name`, `Ubertip` (tooltip), `Hotkey` |
| **Icon, grid position, missile art** | per-race `Units\<Race>UnitFunc.txt` | `art` (BLP icon), `buttonpos` (`col,row`), `missileart`, `missilespeed` |
| Abilities granted | `Units\UnitAbilities.slk` | `abilList` (innate), `heroAbilList` (learnable, in slot order), `auto` (default autocast) |

Per-race files exist for `Human`, `Orc`, `Undead`, `NightElf`, `Neutral`, `Campaign` — OpenWar3 loads all six
into one `MappedData` each for strings and funcs.

**Layering quirk:** unit `collision` lives in `UnitBalance.slk` in the expansion/patch but in `UnitData.slk`
in the RoC base — read both. Heroes' displayed L1 stats come from the precomputed `realhp`/`realm`/`realdef`
(base + attribute contribution), not the raw `hp`/`manaN`/`def`.

## Abilities — where each field lives

Merged in `src/data/abilities.ts`. The critical field is **`code`** — the base ability an object derives
from; the sim dispatches behaviour off `code`, so a custom-map alias (`A000`, `code=AHtb`) runs the same
logic. All keyed by ability id.

| Data | File | Key fields |
|---|---|---|
| Numbers (per level) | `Units\AbilityData.slk` | `cost1..`, `cool1..` (cooldown), `dur1../herodur1..`, `rng1..` (cast range), `area1..`, `cast1..`, `dataa1..datai1` (per-ability payload), `buffid1..`, `unitid1..` (summon), **`targs1`** (Targets Allowed — see below), `hero` (learnable), `levels`, `reqLevel`/`levelSkip` |
| **Name, per-level tooltips, hotkey** | per-race `Units\<Race>AbilityStrings.txt` | `Name`, `Tip`/`Ubertip` (per rank), `Hotkey` |
| **Icon, effect art, cast anim, grid pos** | per-race `Units\<Race>AbilityFunc.txt` | `Art` (icon), `Missileart`/`Targetart`/`Casterart`/`Specialart`/`Areaart` (effect models), `animnames` (caster anim tags), `buttonpos`, `researchbuttonpos` |

### `targs1` — Targets Allowed (the target-flag field)

A comma-separated flag list saying **what a targeted ability may be cast on**. OpenWar3 parses it into
`AbilityDef.targetFlags` and enforces it in `World.targetAllowed` (`src/sim/world.ts`). Two kinds of flags:

- **Allegiance:** `enemy`, `friend` (allies), `player` (own units only), `self`, `neutral`, `notself` (anything
  but the caster). Absence of *any* allegiance flag = unrestricted (e.g. Banish).
- **Unit-type:** `air`, `ground`, `organic`, `structure`, `hero`, `nonhero`, `ancient`/`nonancient`,
  `sapper`/`nonsapper`, `vuln`/`invu`, `debris`, `item`, `tree`, `ward`, …

Examples (verified in the 1.27 MPQ): Storm Bolt `AHtb` = `…,enemy,neutral,…` (enemies only, never friendly);
Heal `Ahea` = `…,friend,self,neutral,…` (allies/self, never enemy); Holy Light `AHhb` = `…,notself,…`
(any unit but the caster); Doom `ANdo` = `…,nonhero,…` (cannot target heroes).

## Gameplay constants (the numbers that belong to no unit or ability)

Turn rate, the damage table, XP curves, creep leash distances, hero-inventory reach, day length, corpse decay —
none of these live in a unit or ability row. The engine keeps them in two INI files (the World Editor edits them
under **Advanced → Gameplay Constants**), and the melee-game setup in Blizzard's own JASS:

| File | Holds |
|---|---|
| `Units\MiscGame.txt` `[Misc]` | Combat (`DefenseArmor`, the seven `DamageBonus*` lists), experience (`GrantHeroXP`, `HeroFactorXP`, the `…FormulaA/B/C` extrapolations), hero attributes (`StrHitPointBonus`, `AgiDefenseBonus`, …), creep leashing (`GuardDistance`, `MaxGuardDistance`, `GuardReturnTime`), inventory ranges, refund rates, revive costs |
| `Units\MiscData.txt` `[Misc]` | Timing and radii: `BoneDecayTime`, `DayLength`/`Dawn`/`Dusk`, `FollowRange`, `FoggedAttackRevealRadius`, `ChanceToMiss`, `SelectionCircleBaseZ`, `GoldMineMaxGold`, … |
| `Scripts\Blizzard.j` | The `bj_*` melee constants: `bj_MELEE_STARTING_GOLD_V1` (500), `bj_MELEE_STARTING_LUMBER_V1` (150), `bj_MELEE_HERO_LIMIT` (3), `bj_MELEE_MINE_SEARCH_RADIUS`, `bj_MELEE_CLEAR_UNITS_RADIUS`, `bj_MELEE_STARTING_TOD` (08:00) |

**The damage table is in the MPQ.** `DamageBonusNormal=1.00,1.50,1.00,0.70,1.00,1.00,0.05,1.00` and its six siblings
are the attack-type rows; the file's own comment gives the column order: `SMALL, MEDIUM, LARGE, FORT, NORMAL, HERO,
DIVINE, NONE`. Read them from here rather than from the classic battle.net chart (which agrees, but which Reforged
has since diverged from). Note the World Editor renames three columns in its UI — Small is *Light*, Large is *Heavy*,
None is *Unarmored* — and `Normal` armour exists in the table but no stock unit carries it.

All three files are transcribed **once**, key-for-key, into `src/data/gameplayConstants.ts`; the damage table and the
XP curves are *computed* from those raw lists and formulas rather than re-typed. `pnpm data:verify` re-reads the real
files and fails on any drift.

## Day/night cycle (the lighting lives in models, not in a table)

The clock itself is three numbers in `Units\MiscData.txt` — `DayLength` = 480 real seconds per `DayHours` = 24
game hours, daylight between `Dawn` (6) and `Dusk` (18). Everything the player *sees* of the cycle is authored
as **MDX**, and read at runtime in `src/render/dayNight.ts` and `src/render/timeIndicator.ts`:

| What | Where | How it's driven |
|---|---|---|
| World lighting | `Environment\DNC\DNC<Tileset>\DNC<Tileset>Terrain.mdx` and `…Unit.mdx` | One `Directional` light, `FDirectSun` |
| Which pair a map uses | `UI\WorldEditData.txt` `[TerrainLights]` / `[UnitLights]`, keyed by the `war3map.w3e` tileset letter | Absent letter ⇒ Lordaeron (the file says so) |
| The top-bar clock | `UI\war3skins.txt` `TimeOfDayIndicator` → `UI\Console\<Race>\<Race>UI-TimeIndicator.mdx` | Orb + frame ring + the 8 dots |

Each of these models has a single 60 000 ms `Stand` sequence that maps onto the **whole 24-hour day**: the engine
never plays it, it seeks to `frame = hour / DayHours × 60000`. Their keyframes land on 15 000 ms and 45 000 ms —
i.e. exactly `Dawn` and `Dusk`. So:

- The sun's colour comes off the light's `KLAC` (Color) and `KLBC` (AmbColor) tracks; `KGRT` holds a single frame,
  so the sun **never moves** — only its colour changes. `q · (0, 0, 1)` gives the vector toward it,
  `(-0.68, -0.41, 0.62)` outdoors (which is what HiveWE and mdx-m3-viewer hard-coded as `vec3(-0.3, -0.3, 0.25)`).
- **A light's colours are stored BGR, not RGB.** Same quirk as MDX geoset colours (mdx-m3-viewer swizzles those
  as `u_geosetColor.bgra`), but neither it nor Warsmash swizzles the *light* colours — so both render every
  tileset's night as its own mirror image. Read straight, Lordaeron's midnight sun is a sepia `(0.80, 0.53, 0.31)`;
  swapped, it is the blue moonlight `(0.31, 0.53, 0.80)` the game actually draws. Ashenvale likewise becomes blue
  and Felwood a sickly green. Confirmed in the real 1.27a client: `daylightsavings 12` vs `daylightsavings 1` on
  Lordaeron Summer darkens flat ground by exactly `(0.385, 0.595, 0.840)` per channel.
- Shading is WC3's fixed function: `clamp(ambColor·ambIntensity + color·intensity·max(N·L, 0), 0, 1)`, modulating
  the texel — but **only where the layer is not `Unshaded`** (flag `0x1`). Blizzard marks the team-colour layer
  (replaceable 1), the team glow (replaceable 2) and effect glows Unshaded, so they stay lit at midnight.
  Terrain and units share the colours but not `ambIntensity` (Lordaeron: 0.2 vs 0.3), so models sit flatter than
  the ground.
- The clock's eight dots are additive glow quads on bones `"1"`…`"8"`, each with a **step** alpha track that
  switches it on 1.5 game-hours further into the half-cycle than the last; all eight blank at Dawn and Dusk.
- `Scripts\Blizzard.j` `InitDNCSounds()` cries `RoosterSound` at Dawn and `WolfSound` at Dusk
  (`UI\SoundInfo\AmbienceSounds.slk` → `Sound\Time\DaybreakRooster.wav`, `Sound\Time\DuskWolf.wav`).

A map may override the tileset's choice with `war3map.w3i`'s **Light Environment** (World Editor → Scenario →
Map Options); the field is NUL when it just follows the tileset, which most melee maps do.

Cave tilesets (`D`, `G`) point at DNC models with no colour tracks and a near-vertical sun: underground has no
day or night.

> To check any of this against the real client: in a single-player game, `daylightsavings <hour>` sets the time of
> day (`0` is read as "no argument" and toggles the cycle instead — use `1`). `PrintScreen` writes a `.tga` into
> `Warcraft III/Screenshots/`. Two shots at a fixed camera give you the per-channel ratio with textures cancelled out.

## Tech tree (who builds/trains what)

WC3 encodes build/train relationships in **ability object-data** (`Abui`/`Aneu`/sold-unit lists on shops),
which is costly to parse. OpenWar3 curates the stable melee set by hand in `src/data/techtree.ts`
(`WORKER_BUILDS`, `BUILDING_TRAINS`) — e.g. altars train the four race heroes, the Tavern (`ntav`) sells the
eight neutral heroes.

## Sounds

Voice/impact/UI sounds are resolved from **`UI\SoundInfo\*.slk`**, keyed by the unit's `unitSound` label
(from `UnitUI.slk`) plus a category. Parsed in `src/audio/sounds.ts` (row lookups are **case-insensitive** —
WC3's data is inconsistent, e.g. sound-set `AltarofKings` → ack row `AltarOfKingsWhat`).

| File | Row key | Content |
|---|---|---|
| `UI\SoundInfo\UnitAckSounds.slk` | `<label><Category>` | Voice acks: `What`/`Yes`/`YesAttack`/`Pissed`/`Warcry`/`Ready` |
| `UI\SoundInfo\AnimSounds.slk` | `<label>Death` | Death cries |
| `UI\SoundInfo\UnitCombatSounds.slk` | `<weap><armor>` | Weapon-impact + chop clangs (e.g. `MetalMediumSlice`+`Flesh`) |
| `UI\SoundInfo\UISounds.slk` | `<name>` | Interface sounds (button click, rally, error, construction loop) |
| `UI\SoundInfo\AmbienceSounds.slk` | `<name>` | Ambience beds + the dawn/dusk cries (`RoosterSound`, `WolfSound`) |

Each row gives `DirectoryBase` + `FileNames` (comma-separated random variants), `Volume`, `Pitch`, flags.
Missile launch/impact sounds are **not** in these tables — they ship as WAVs inside the missile model's own
folder (e.g. `Abilities\Weapons\BloodElfMissile\BloodMageRangedAttack.wav`), matched by keyword.

## Maps (`.w3m` / `.w3x`)

A map is **itself an MPQ archive** — same container format as `War3.mpq`, just holding a map's own chunk
files rather than the game's. Open one with the same reader (`src/vfs/`). The only difference between the two
extensions is the game version they target: **`.w3m` = Reign of Chaos** maps (also playable in TFT);
**`.w3x` = Frozen Throne** maps (TFT-only, may use expansion content). Both have the identical internal
layout. This manifest is the full set of chunk files a map can contain, per thehelper.net's *"Explanation of
w3m and w3x files"* thread (#35292), cross-checked against the bundled 1.27a maps; the **OpenWar3** column
names the parser where we read it (all under `src/world/`, wired through `src/vfs/`).

### Terrain, pathing & minimap

| File | Content | OpenWar3 |
|---|---|---|
| `war3map.w3e` | **Terrain**: per-corner tile texture, cliff/ramp level, height and water — the ground itself | `terrain.ts` |
| `war3map.wpm` | **Pathing map**: per-cell walkable/buildable/flyable bits (red = unwalkable, blue = unbuildable) | `map.ts` → `PathingGrid` |
| `war3mapPath.tga` | Legacy image-form pathing map some older RoC maps ship instead of/alongside `.wpm` | — |
| `war3map.shd` | **Shadow map**: a coarse (16 px/tile) static terrain-shadow mask | — |
| `war3mapMap.blp` | Rendered **minimap** image (BLP) | `map.ts` (preview) |
| `war3mapMap.b00` | A mip/variant of the minimap image | — |
| `war3map.mmp` | **Menu minimap**: start-location & icon positions drawn on the lobby preview | — |
| `war3mapPreview.tga` / `war3mapMap.tga` | Loading-screen / terrain preview images | — |

### Placed objects

| File | Content | OpenWar3 |
|---|---|---|
| `war3mapUnits.doo` | **Placed units/buildings** — creeps, gold mines, shops, start locations, player units, with drop tables/inventory | `mapUnits.ts` |
| `war3map.doo` | **Placed doodads/destructibles** — trees, rocks, decorative props | `doodads.ts` |

Both `.doo` files share the "doodad object" container format but different record layouts.

### Map info & configuration

| File | Content | OpenWar3 |
|---|---|---|
| `war3map.w3i` | **Map info**: name, author, players, forces/teams, start locations, camera bounds, tech-tree tweaks, and the **flags** bitfield (melee-vs-custom, see below) | `mapInfo.ts` |
| `war3mapMisc.txt` | Per-map **Gameplay Constants** overrides (a map's edits to `MiscGame`/`MiscData` values) | — |
| `war3mapSkin.txt` | Per-map **interface/skin** overrides (custom UI art, command-string tweaks) | — |
| `war3mapExtra.txt` | Extra map properties (weather, sound-environment defaults) | — |
| `war3map.imp` | **Import list** — records every user-imported asset (`war3mapImported\…`) so a re-save keeps them | — |

### Triggers & script

| File | Content | OpenWar3 |
|---|---|---|
| `war3map.j` | **Compiled trigger script** (JASS2; Lua on Reforged). What the engine actually runs | `triggers.ts` |
| `war3map.wtg` | GUI **trigger tree**: categories, variables, event-condition-action definitions (editor source) | scanned in `triggers.ts` |
| `war3map.wct` | **Custom text** attached to those triggers (editor source) | — |
| `war3map.wts` | **Trigger string table**: the `TRIGSTR_###` values that `.w3i`/object data reference | `mapInfo.ts` (string resolve) |

The editor keeps `.wtg`/`.wct` as its source-of-truth and *compiles* them to `war3map.j`; the running game
executes the `.j`, never the `.wtg`.

### Audio, cameras & regions

| File | Content | OpenWar3 |
|---|---|---|
| `war3map.w3s` | **Sound definitions**: the map's declared sounds/ambience (paths, volume, 3-D flags) | — |
| `war3map.w3r` | **Regions**: named rectangles + their weather effect / ambient-sound bindings | — |
| `war3map.w3c` | **Cameras**: authored camera presets | — |

### Custom object data (World Editor "object editor" edits)

Each is a binary table of *modifications* layered on the base game data — present only when a map actually
customises that object class. OpenWar3 runs the stock melee tables, so it doesn't read these yet (a custom-map
concern for the future JASS/object-data pass):

| File | Class | | File | Class |
|---|---|---|---|---|
| `war3map.w3u` | Units | | `war3map.w3d` | Doodads |
| `war3map.w3t` | Items | | `war3map.w3h` | Buffs/effects |
| `war3map.w3a` | Abilities | | `war3map.w3q` | Upgrades |
| `war3map.w3b` | Destructibles | | | |

### MPQ archive metadata

Not map data proper — the container's own bookkeeping, common to every MPQ:

| File | Content |
|---|---|
| `(listfile)` | Internal filename directory (often incomplete or absent — see the probing note above) |
| `(attributes)` | Per-block CRC32 checksums + modification timestamps |
| `(signature)` | Legacy weak archive signature |

Player **15** is Neutral Passive (shops, taverns, fountains, critters); neutral-hostile creeps use other slots.

### Melee vs. custom (the `war3map.w3i` flags)

The w3i **flags** bitfield (Map Properties) tells melee from custom. Bit **0x0004 = "melee map"** is the ground
truth: the World Editor sets it iff the map is a standard melee map. `src/world/mapKind.ts` reads it to decide whether
to run our standard melee setup (`startMelee`: town hall + workers + melee rules) or leave setup to the map's own
triggers (`startCustom`). Verified against **all 161 bundled 1.27a maps**: every stock melee map has the flag set *and*
all 8 `Melee*` init functions (`MeleeStartingUnits`, `MeleeStartingResources`, …) in its `war3map.j`; every Scenario
map has it clear. The lone TFT altered-melee map `(4)Monolith` calls 5/8 `Melee*` funcs yet has the flag **off** — so
the **flag**, not a script scan, is authoritative (Monolith runs as custom). `src/world/triggers.ts` still scans the
`.j` for those `Melee*` calls as a corroborating/diagnostic signal and to hold the source for the future JASS pass.

## Reading it yourself

Reuse the app's parser from a Node CJS script **run from the repo root** (so `node_modules` resolves), load
the MPQs in patch order, and read rows via `MappedData`. See the memory note *"Verify WC3 asset paths"* for the
exact recipe (and the backslash-escaping gotcha — author these scripts with the Write tool, not a bash heredoc).

### Unpacking the data tables to disk

```bash
pnpm data:extract    # unpack the archives
pnpm data:browse     # build + open the data browser
```

Writes every text/data file (`.slk`/`.txt`/`.j`/`.ai`/`.fdf`) to `Warcraft III/ExtractedData/`, which is
gitignored along with the rest of `Warcraft III/`. You get `merged/` (the effective, patch-wins copy, with a
generated `.csv` beside each `.slk`), `by-archive/` (byte-exact originals, to see who overrides what), and
`_index/` (filename listings for **all** 17,362 files, so you can grep for a model/icon/sound path without
unpacking the binary assets). The generated `ExtractedData/README.md` documents what every file is, and which
parts of the engine the data *doesn't* give you — its source of truth is `tools/data-readme.md`, since the
folder is wiped on re-extract.

`ExtractedData/index.html` is a self-contained browser over the merged data (filterable SLK grids, searchable
JASS/FDF source, per-file docs). It embeds every file as a gzipped blob rather than fetching them, because
`fetch()` is blocked on `file://` — which is how you'll open it.

Two MPQ facts that tool had to deal with, worth knowing before you write your own:

- **`War3Patch.mpq` ships no `(listfile)`.** All 576 of its blocks are anonymous, so listing tools show you
  nothing. The hash table still resolves names, so recover its contents by probing it with the names found in
  the other three archives (`archive.has(path)` is reliable when listing is not).
- **MPQ name hashing is case-insensitive**, so case-variant spellings (`…\Orc\Earthquake\…` vs `…\EarthQuake\…`)
  alias onto one block — probing the patch yields 578 name spellings for 576 blocks.
