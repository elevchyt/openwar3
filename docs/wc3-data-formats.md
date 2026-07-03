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

Each row gives `DirectoryBase` + `FileNames` (comma-separated random variants), `Volume`, `Pitch`, flags.
Missile launch/impact sounds are **not** in these tables — they ship as WAVs inside the missile model's own
folder (e.g. `Abilities\Weapons\BloodElfMissile\BloodMageRangedAttack.wav`), matched by keyword.

## Maps (`.w3m` / `.w3x`)

A map is itself an MPQ containing chunk files. The ones OpenWar3 reads (`src/world/`):

| File | Content |
|---|---|
| `war3map.w3e` | Terrain: tiles, cliff/ramp/height/water per corner |
| `war3mapUnits.doo` | **Placed units/buildings** (creeps, gold mines, shops, start locations, player units) — parsed in `src/world/mapUnits.ts` |
| `war3map.doo` | Placed doodads/destructibles (trees, etc.) |
| `war3map.w3i` | Map info: name, players, teams, start locations |
| `war3mapMap.blp` | Preview minimap image |

Player **15** is Neutral Passive (shops, taverns, fountains, critters); neutral-hostile creeps use other slots.

## Reading it yourself

Reuse the app's parser from a Node CJS script **run from the repo root** (so `node_modules` resolves), load
the MPQs in patch order, and read rows via `MappedData`. See the memory note *"Verify WC3 asset paths"* for the
exact recipe (and the backslash-escaping gotcha — author these scripts with the Write tool, not a bash heredoc).
