# ExtractedData — the Warcraft III (TFT 1.27a) data files, unpacked

<!-- Source of truth: tools/data-readme.md. `node tools/build-data-browser.mjs` copies it here.
     Edit it there, not in ExtractedData/ — this folder gets wiped and rebuilt. -->

Generated from the four MPQ archives in this folder's parent:

```bash
pnpm data:extract    # unpack the archives  (tools/extract-mpq.mjs)
pnpm data:browse     # build + serve the data browser
```

Re-run any time; `merged/`, `by-archive/`, `_index/`, `index.html` and this README are all regenerated.

> **This folder is gitignored and must stay that way.** It is Blizzard's data, unpacked from *your* local
> install. OpenWar3 ships zero Blizzard assets or code (see `CLAUDE.md` → "Legal boundary"). Read these
> files to learn *behaviour and numbers*; never copy them into the repo.

For the deeper field guide to the data model — which table holds which field, how `targs1` target flags
parse, how unit data is split — see [`docs/wc3-data-formats.md`](../../docs/wc3-data-formats.md). This
README is the map of *what is on disk here*, and of what you still have to build yourself.

## The data browser

```bash
pnpm data:browse
```

`index.html` is a dark, self-contained codex over everything in `merged/`: a categorised file tree, a
description of **what each file is**, filterable grids for the 63 `.slk` tables (filter rows by rawcode,
columns by name), and a searchable source view for the JASS/AI/FDF/strings files. No dependencies, no build
step — but it does `fetch()` the data files beside it, and browsers block that over `file://`, so it must be
served. `pnpm data:browse` does that for you (`tools/serve-data.mjs`, zero-dep, `127.0.0.1:8787` —
deliberately clear of Vite's 5173+ range). `pnpm data:build` rebuilds just the page.

---

## Layout

| Folder | What's in it |
|---|---|
| `merged/` | The **effective** data files — what the running game actually sees after the patch overrides everything. Each `.slk` also has a generated `.csv` next to it. **Start here.** |
| `by-archive/` | Byte-exact originals, one tree per archive. Use to see *who owns what* and to diff a table across RoC → TFT → patch. |
| `_index/` | Filename listings for **all 17,362 files**, including the models, textures and sounds that were *not* extracted. |

Only text/data formats were extracted — **627 files** (`merged/` is 21 MB, `by-archive/` 39 MB, `_index/` 2 MB).
The binary assets — `.mdx` models, `.blp` textures, `.wav`/`.mp3` audio, `.w3x`/`.w3m` maps — stay in the
MPQs, because the engine reads them straight from there at runtime via `src/vfs/`. Their **paths** are in
`_index/` so you can find an asset without unpacking a gigabyte.

### `_index/`

| File | Purpose |
|---|---|
| `all-files.tsv` | Every file: `path`, `ext`, `effective_archive`, `all_archives`. Grep this to locate any model/icon/sound. |
| `listfile-War3.mpq.txt` etc. | Per-archive filename listings. |
| `overrides.txt` | The 996 files that exist in more than one archive, and which copy wins. |
| `extract-report.txt` | Stats + decode failures from the last run. |

---

## The archives, and the layering rule

Mounted lowest-priority first; **later overrides earlier**. Mirrored in `src/vfs/profiles.ts`.

```
War3.mpq  <  War3x.mpq  <  War3xLocal.mpq  <  War3Patch.mpq
```

| Archive | Files | Holds |
|---|---:|---|
| `War3.mpq` | 10,600 | All **Reign of Chaos** content: data tables, models, textures, and the base (PCM) sounds |
| `War3x.mpq` | 6,127 | **Frozen Throne** models, data tables, textures, effect sounds |
| `War3xLocal.mpq` | 1,136 | TFT **localized** content — unit **voice** lines (`enUS`), cinematics |
| `War3Patch.mpq` | 578 | The 1.27a patch. **Highest priority — always authoritative.** |

So a TFT unit like the Blood Mage draws its *model* from `War3x` but its *voice lines* from `War3xLocal`,
and if the patch touched its stats, `War3Patch` has the real numbers.

**When a reference and the MPQ disagree, the MPQ wins.** That's the prime directive in `CLAUDE.md`.

### Two facts about `War3Patch.mpq` worth knowing

1. **It ships no `(listfile)`.** All 576 of its blocks are anonymous; a generic MPQ tool shows you
   `file00000000`, `file00000001`, … and nothing else. The hash table still resolves a *name* to a block,
   so `tools/extract-mpq.mjs` recovers the patch's contents by probing it with every filename known from
   the other three archives. `archive.has(path)` is reliable even when listing is not.
2. **MPQ name hashing is case-insensitive.** Probing yields 578 name spellings for 576 blocks, because
   case-variant spellings (`…\Orc\Earthquake\…` and `…\Orc\EarthQuake\…`) alias onto the same block.

Consequence: any file you cannot find by listing may still be *there*. Probe by name.

---

## File formats

| Ext | Format | Content |
|---|---|---|
| `.slk` | SYLK spreadsheet (text) | The **numeric** tables. Rows = object ids (4-char rawcodes like `hfoo`), columns = fields. Row keys are case-insensitive. A `.csv` twin sits beside each one here. |
| `.txt` | INI-like, `[ID]` sections | **Art and strings**: icons, button grid positions, names, tooltips, hotkeys. Also the `Misc*` constant tables. |
| `.fdf` | FrameDef (text) | The **UI layout language**. Declares frames, textures, fonts, strings. Read by `CGameUI` in the original engine. |
| `.j` | JASS source | The engine's own script layer: `common.j` (native declarations), `Blizzard.j` (melee game rules). |
| `.ai` | JASS-flavoured AI script | Computer-player scripts. `common.ai` declares the AI natives. |
| `.ifl` | Image File List | The ordered frames of an animated texture (water). |
| `.wai` | Compiled AI Editor output | Binary. The `.ai` scripts are the readable form. |
| `.pld` | Credits payload | Credits rolls. Not gameplay data. |

Not extracted despite looking text-ish: `Reverb3.flt` is a **PE DLL** (a Miles Sound System filter), and
`.mrf` is binary `Morf` vertex-animation data (Arthas's cape in a cinematic).

`.slk` and `.txt` are parsed in OpenWar3 by `mdx-m3-viewer`'s `MappedData`, wired through `src/vfs/`.

### Reading a `.slk`

Raw SYLK is painful — it's a stream of `C;X<col>;Y<row>;K<value>` commands. That's why every `.slk` here
has a generated `.csv` beside it. The `.slk` remains the ground truth; the `.csv` is a convenience, so if
they ever disagree, believe the `.slk`.

```
Units/UnitBalance.slk   <- ground truth, byte-exact
Units/UnitBalance.csv   <- same table, openable in a spreadsheet / greppable
```

---

## The data tables

### Units — one unit's data is split across six tables

All keyed by the 4-char rawcode. Merged in `src/data/units.ts`.

| File | Holds |
|---|---|
| `Units/UnitData.slk` | Race, movement type, turn rate, pathing texture |
| `Units/UnitBalance.slk` | HP, mana, cost, food, build time, attributes, collision, armor, sight (`sight`/`nsight`), level |
| `Units/UnitWeapons.slk` | Damage dice, cooldown, range, attack type, damage point / backswing |
| `Units/unitUI.slk` | Model path (`file`), scale, sound-set label (`unitSound`), impact sounds, `uberSplat` |
| `Units/UnitAbilities.slk` | `abilList` (innate), `heroAbilList` (learnable, in slot order), `auto` (default autocast) |
| `Units/<Race>UnitStrings.txt` | **Name**, `Ubertip` (tooltip), `Hotkey` |
| `Units/<Race>UnitFunc.txt` | **Icon** (`art`), `buttonpos`, `missileart`, `missilespeed` |

`<Race>` ∈ `Human`, `Orc`, `Undead`, `NightElf`, `Neutral`, `Campaign`.

> **Layering quirk:** `collision` lives in `UnitBalance.slk` in TFT/patch but in `UnitData.slk` in the RoC
> base — read both. Heroes' displayed level-1 stats come from the precomputed `realhp`/`realm`/`realdef`
> columns, not the raw `hp`/`manaN`/`def`.

### Abilities

| File | Holds |
|---|---|
| `Units/AbilityData.slk` | Every number, **per level**: `cost1..`, `cool1..`, `dur1..`/`herodur1..`, `rng1..`, `area1..`, `cast1..`, the payload columns `dataa1..datai1`, `buffid1..`, `unitid1..`, `targs1` (Targets Allowed), `hero`, `levels`, `reqLevel` |
| `Units/<Race>AbilityStrings.txt` | Name, per-rank `Tip`/`Ubertip`, `Hotkey` |
| `Units/<Race>AbilityFunc.txt` | Icon (`Art`), effect models (`Missileart`, `Targetart`, `Casterart`, `Specialart`, `Areaart`), caster animation tags (`animnames`), `buttonpos` |
| `Units/AbilityBuffData.slk` | The **buff/debuff** objects abilities apply (`buffid1..` points here) |
| `Units/AbilityMetaData.slk` | **The decoder ring.** Names the unlabelled `DataA..DataI` columns per ability, and gives each field's type |

Two things make these usable:

- **`code` is the dispatch key.** An ability object's `code` column names the *base* ability it derives
  from. A custom-map alias (`A000` with `code=AHtb`) is still Storm Bolt, so the sim dispatches behaviour
  off `code`, not off the object id. See `src/data/abilities.ts` / `src/sim/spells.ts`.
- **`DataA..DataI` mean nothing on their own.** `AbilityMetaData.slk` (cross-referenced with
  `UI/WorldEditStrings.txt`) tells you that, say, `DataA` on this ability is "Damage". Two abilities sharing
  a `useSpecific` value share an engine implementation and column meaning.

`targs1` is a comma-separated flag list controlling what an ability may be cast on — allegiance flags
(`enemy`, `friend`, `self`, `player`, `neutral`, `notself`) plus type flags (`air`, `ground`, `organic`,
`structure`, `hero`, `nonhero`, `vuln`/`invu`, `tree`, `ward`, …). Absence of any allegiance flag means
unrestricted. Enforced in `World.targetAllowed` (`src/sim/world.ts`).

> A caution learned the hard way: the SLK gives you the *numbers*, not their *meaning*. A wave spell's
> `Duration` column is not necessarily its channel time. Read the ability's Liquipedia/Hive description
> alongside the table before wiring behaviour.

### Items, upgrades, destructables, doodads

| File | Holds |
|---|---|
| `Units/ItemData.slk` + `ItemFunc.txt` / `ItemStrings.txt` | Items: cost, charges, classification, icon, tooltip |
| `Units/ItemAbilityFunc.txt` / `ItemAbilityStrings.txt` | Art/strings for item-granted abilities |
| `Units/UpgradeData.slk` + `<Race>UpgradeFunc/Strings.txt` | Researches: cost per level, effect, icon, tooltip |
| `Units/UpgradeEffectMetaData.slk` | What an upgrade level actually modifies |
| `Units/DestructableData.slk` | Trees, gates, breakable rocks: HP, pathing footprint, model |
| `Doodads/Doodads.slk` | Every doodad: model, category, tileset, scale range, pathing |

### The `*MetaData.slk` tables — how to decode everything else

`UnitMetaData.slk`, `AbilityMetaData.slk`, `AbilityBuffMetaData.slk`, `DestructableMetaData.slk`,
`DoodadMetaData.slk`, `UpgradeMetaData.slk`, `MiscMetaData.slk`, `UI/SkinMetaData.slk`.

These are the World Editor's schema: for each field they give the SLK column name, the display name (a
`WESTRING_*` key resolved through `UI/WorldEditStrings.txt`), the type, and valid range. When you hit a
column you don't recognise, this is where you look it up.

### Game constants — the numbers that live nowhere else

| File | Holds |
|---|---|
| `Units/MiscData.txt` | Gameplay constants: `CloseEnoughRange`, `BuildingUnblightRadius`, creep notification radii, acquisition ranges |
| `Units/MiscGame.txt` | Rule switches and creep/AI constants: `MagicImmunesResistDamage`, guard leash & return-home behaviour, spell clustering |
| `Units/UnitGlobalStrings.txt` | The unit **classification** names (`GiantClass`, `UndeadClass`, `MechanicalClass`, …) |
| `UI/MiscData.txt` | Presentation constants: floating gold/lumber text colour & velocity, buff fade alphas |
| `UI/MiscUI.txt` | UI chrome constants |
| `Units/CommandFunc.txt` / `commandstrings.txt` | The **command card**: icon + grid position + tooltip + hotkey for Move / Attack / Stop / Hold / Patrol / Build |

`MiscGame.txt` and `MiscData.txt` are the reason OpenWar3's creep AI has real WC3 constants rather than
invented ones. Both are read in `src/sim/world.ts` and `src/game/rts.ts`.

### Sound

`UI/SoundInfo/*.slk`, parsed in `src/audio/sounds.ts`. Row lookups are case-insensitive.

| File | Holds |
|---|---|
| `UnitAckSounds.slk` | Voice responses (What/Yes/Attack/Pissed), keyed by the unit's `unitSound` label |
| `UnitCombatSounds.slk` | Weapon impacts, wood chopping — keyed by material struck |
| `AbilitySounds.slk` | Spell sounds |
| `AnimSounds.slk` + `AnimLookups.slk` | **Model-embedded sound events.** An `.mdx` fires a 4-char event (`FBCL`); `AnimLookups` maps it to a sound label; `AnimSounds` gives the files |
| `UISounds.slk` | Interface clicks, warnings |
| `AmbienceSounds.slk`, `EnvironmentSounds.slk`, `MIDISounds.slk`, `DialogSounds.slk` | Ambience, weather, music, cinematic dialog |
| `EAXDefs.slk` | Reverb/EAX presets referenced by the `EAXFlags` column |
| `PortraitAnims.slk` | Which portrait animation plays with which sound |

Two gotchas, both already paid for:

- **A unit's attack sound is not in its folder.** It's a model-embedded `SND` event resolved through
  `AnimLookups` → `AnimSounds`. Chasing the model's directory gets you the wrong gunshot.
- **Positional audio** comes from the `WANT3D` flag in the `Flags` column.

### Terrain, splats, weather

| File | Holds |
|---|---|
| `TerrainArt/Terrain.slk` | Ground tiles: texture, `buildable`, `walkable`, `flyable`, blight priority |
| `TerrainArt/CliffTypes.slk` | Cliff + ramp models and textures per cliff type |
| `TerrainArt/Water.slk`, `Weather.slk` | Water colour/animation; weather particle effects |
| `Splats/UberSplatData.slk` | The ground texture under a building |
| `Splats/SplatData.slk`, `T_SplatData.slk` | Temporary ground splats (blood, scorch) |
| `Splats/LightningData.slk` | Lightning-effect definitions (chain lightning, etc.) |

> `UberSplatData`'s `scale` is the **half-width** (the quad spans center ± scale), and its texture ships
> **both** as the plain `dir\file.blp` *and* as detail-tier variants `A_`/`B_`/`C_<file>.blp` (the engine's
> internal LODs — they are BLP files, not table rows). The plain path is canonical. See
> `src/data/ubersplats.ts`.

### UI — the FDF frame system

`UI/FrameDef/**` (85 files) plus `UI/war3skins.txt` and `UI/*.toc`.

FDF is the original engine's UI layout language — `CGameUI` reads `framedef`/`fdfile` declarations to
build the HUD, the command card, the menus (`UI/FrameDef/Glue/*` are the out-of-game "glue" screens).
`UI/FrameDef/UI/*` is the in-game HUD. `GlobalStrings.fdf` and `InfoPanelStrings.fdf` hold the strings the
info panel shows (including the armor/attack-type tooltips).

**OpenWar3 does not read FDF.** The HUD is hand-built DOM in `src/ui/hud.ts` and `src/style.css`. These
files are here as the **layout and naming reference** — use them to get panel proportions, frame names and
string keys right.

### Scripts — JASS

| File | What it is |
|---|---|
| `Scripts/common.j` | Declares every JASS **native** the engine exposes. The API surface a JASS VM must implement. |
| `Scripts/Blizzard.j` | **Blizzard's own melee game code**, in JASS. Starting units, `MeleeClearExcessUnits` (creep clearing at 1500 range), starting resources, victory/defeat conditions, day/night cycle. |
| `Scripts/common.ai` | Declares the AI natives. |
| `Scripts/human.ai`, `orc.ai`, `undead.ai`, `elf.ai` | The **melee computer-player** scripts, per race. |
| `Scripts/*.ai` (211 in total) | Per-campaign-mission AI scripts (`h02x03.ai`, `u08_red.ai`, …). |
| `Scripts/Cheats.j`, `InitCheats.j` | Cheat-code handling. |
| `Maps/Test/OrcVsOrc.j` | A bundled test map's compiled script — a worked example of what the editor emits as `war3map.j`. |

`Blizzard.j` is ground truth for melee rules. **Read it before coding any melee behaviour** — it will tell
you the real constant instead of a guessed one. Already consulted by `src/data/races.ts`,
`src/world/triggers.ts`, `src/game/rts.ts`.

### Game Data Set snapshots — `Melee_V0/`, `Custom_V0/`, `Custom_V1/`

Frozen copies of the object tables from earlier patches. A map's `.w3i` carries a **Game Data Set** field
(World Editor: *Scenario → Map Options → Game Data Set*), and the engine loads the matching snapshot so an
old map keeps its original balance. Confirmed by the `WESTRING_GAMEDATASET_*` keys in
`UI/WorldEditStrings.txt`:

| Folder | World Editor label |
|---|---|
| `Custom_V0/` | `Custom (1.01)` |
| `Custom_V1/` | `Custom (TFT 1.07, RoC 1.01)` |
| `Melee_V0/` | `Melee (Latest Patch)` |

They're smaller than the live tables (`Melee_V0/Units/UnitBalance` has 468 rows vs 836 in
`Units/UnitBalance`). **Ignore them unless you're implementing map compatibility** — a modern melee game
reads the live `Units/` tables. They're useful as a historical diff of what TFT changed.

### World Editor data (not needed to run the game)

`UI/WorldEditData.txt`, `WorldEditStrings.txt`, `UnitEditorData.txt`, `AIEditorData.txt`,
`WorldEditLayout.txt`, `TriggerData.txt`, `TriggerStrings.txt`.

Two of these earn their keep anyway:

- **`UI/WorldEditStrings.txt`** resolves every `WESTRING_*` key. It is how you turn `AbilityMetaData`'s
  field ids into human names — the `DataA..DataI` decoder.
- **`UI/TriggerData.txt`** is the complete GUI-trigger vocabulary: every event, condition and action, with
  its parameter types and the JASS function it compiles to. If you ever implement triggers, this is the spec.

### Strings and help

`UI/HelpStrings.txt` (gameplay help / hints), `UI/TipStrings.txt` (loading-screen tips),
`UI/CampaignStrings.txt` (+`_exp`), `UI/StartupStrings.txt`, `UI/Captions/*` (cinematic subtitles, as
`start-timecode  end-timecode  line`), `Units/Telemetry.txt`, `License.txt`.

---

## What is reference vs what you build

The MPQs give you **data and naming**. They give you almost no **behaviour**. This is the split that
matters for planning.

### Handed to you (read the file, don't invent)

- Every unit / ability / item / upgrade **number** — `Units/*.slk`
- Every **name, tooltip, hotkey, icon path, button position** — `Units/*Strings.txt`, `Units/*Func.txt`
- Every **asset path** — `_index/all-files.tsv`
- Every **sound mapping** — `UI/SoundInfo/*.slk`
- **Melee game rules** in executable form — `Scripts/Blizzard.j`
- The **JASS API surface** — `Scripts/common.j`
- The **AI scripts** — `Scripts/*.ai`
- **UI layout and frame names** — `UI/FrameDef/**`
- Terrain, cliffs, doodads, splats, weather — `TerrainArt/*`, `Doodads/*`, `Splats/*`

### You build from scratch (the engine)

Nothing in this folder implements any of these. The data tables only *parameterise* them.

- **Pathing**: the pathfinder, collision, formation movement, flying vs ground layers. `pathTex` gives you
  the footprint (red = unwalkable, blue = unbuildable — two independent channels, never collapse them);
  the *algorithm* is yours.
- **Combat resolution**: the attack-type × armor-type multiplier table is **not in the MPQ**. Source it
  from the official classic Battle.net basics pages (TFT values, which differ from Reforged). Wired in
  `World.applyDamage`.
- **Attack timing**: damage point, backswing, cooldown, animation-break.
- **Ability behaviour**: `AbilityData.slk` says Storm Bolt does 100 damage and stuns. That it is a
  travelling projectile that stuns on impact and cannot hit heroes — that's engine code.
- **Order system**: the `CUnit` → per-order ability objects (`attackAbility`, `moveAbility`, `heroAbility`,
  `buildAbility`, `inventoryAbility`). Shape from `docs/reverse-engineering/tinkerworx-repos.md`.
- **Fog of war / vision**, upkeep, income ticks, XP sharing, aggro & leashing, day/night.
- **A JASS VM**, if you want custom maps. `common.j` is the interface; the interpreter is yours.
- **Rendering**: MDX skinning, particle emitters, terrain/cliff meshing, ubersplat compositing.

### Lives in no file at all — use the reference index

Turn rate semantics, acquisition behaviour, upkeep thresholds, rally mechanics, creep aggro/leash rules,
and the damage table. See [`docs/REFERENCES.md`](../../docs/REFERENCES.md) for where to look
(Hive Workshop threads; the [classic WC3 basics pages](https://classic.battle.net/war3/basics/) —
hiveworkshop 403s plain fetchers, send a browser `User-Agent`).

---

## Gotchas

- **The patch wins.** Always read `merged/`, or the highest-priority copy in `by-archive/`. A number you
  read from `War3.mpq` may be two patches stale.
- **A `-` in a numeric SLK cell means "use the default"**, not zero. `dmgpt1` is `-` for **572 of 837**
  rows in `UnitWeapons.slk`. Reading a dash as `0` gives you units that attack instantly.
- **SLK row keys are case-insensitive** (`unitUI.slk` is spelled with a lowercase `u`, `UnitUI` elsewhere).
  So are MPQ paths — which means the listfile can carry two spellings of one file. `Units\commandstrings.txt`
  and `Units\CommandStrings.txt` are the same block, and collapse to a single file when extracted onto a
  case-insensitive filesystem. That is why 629 data-path spellings yield 627 files on disk (one, `war3x.txt`,
  fails to decode; two collapse into one).
- **`War3x.mpq\war3x.txt` cannot be decoded** — a root-level stub with a malformed sector table (its
  declared sector count doesn't fit the block). Not gameplay data; the extractor logs it and moves on.
  It is the only decode failure across all 17,362 files, and it is absent from `merged/`.
- **All TFT audio is Huffman(+ADPCM) compressed.** `War3.mpq` WAVs are plain PCM, but *every* `War3x` /
  `War3xLocal` WAV is Huffman. Stock `mdx-m3-viewer` throws `compression type 'huffman' not supported` and
  silently mutes the entire expansion. Fixed in `patches/mdx-m3-viewer@5.12.0.patch`.
- **RoC vs TFT is a data split, not a fork.** Same engine, different mounted archives — see
  `src/vfs/profiles.ts`.

---

## Recipes

**Find an asset path without unpacking anything**

```bash
grep -i "stormbolt" _index/all-files.tsv
grep -iE "CommandButtons.*Footman" _index/all-files.tsv
```

**Look up a unit's stats**

```bash
head -1 merged/Units/UnitBalance.csv          # column names
grep -i "^hfoo," merged/Units/UnitBalance.csv # the Footman: 135 gold, 2 food, level 2
```

**Find an ability's numbers, then its meaning**

```bash
grep -i "^AHtb," merged/Units/AbilityData.csv        # Storm Bolt: cost, cooldown, DataA..DataI
grep -i "AHtb" merged/Units/HumanAbilityStrings.txt  # its name + per-rank tooltip
grep -i "AHtb" merged/Units/HumanAbilityFunc.txt     # its icon + missile art
```

**Decode a `DataA..DataI` column** — the full chain, worked through for Storm Bolt:

```bash
grep -i "AHtb" merged/Units/AbilityMetaData.csv
#   Htb1,Data,AbilityData,-1,4,1,data,WESTRING_AEVAL_HTB1,...,"AHtb,ANfb,Awfb,..."
#   ^ field id          ^ display-name key        ^ useSpecific: every ability sharing this field
grep -i "WESTRING_AEVAL_HTB1" merged/UI/WorldEditStrings.txt
#   WESTRING_AEVAL_HTB1=Damage
```

So Storm Bolt's `DataA` is **Damage** — and `ANfb`/`Awfb` share that engine ability, hence the same column
meaning. That `useSpecific` list is the cheapest way to find every ability implemented by the same code.

**See what the patch changed**

```bash
grep "War3Patch" _index/overrides.txt
# by-archive/ holds byte-exact originals only — no .csv twins. Diff the .slk:
diff by-archive/War3x/Units/UnitBalance.slk by-archive/War3Patch/Units/UnitBalance.slk
```

**Read Blizzard's own melee rules**

```bash
grep -n "MeleeStartingResources\|MeleeClearExcessUnits\|bj_MELEE" merged/Scripts/Blizzard.j
```
