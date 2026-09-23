# Later-format maps: a compatibility layer, and where it is allowed to live

Read this before touching anything that reads a `.w3x`/`.w3m` for a map saved by a World Editor
newer than 1.30.4 — [`src/world/mapInfo.ts`](../src/world/mapInfo.ts),
[`src/world/map.ts`](../src/world/map.ts), [`src/world/terrain.ts`](../src/world/terrain.ts),
[`src/data/objectData.ts`](../src/data/objectData.ts), or the parser hunks in
[`patches/mdx-m3-viewer@5.12.0.patch`](../patches/mdx-m3-viewer@5.12.0.patch).

OpenWar3 targets **TFT 1.30.4** and that does not change: the version gate in
[`src/vfs/version.ts`](../src/vfs/version.ts) is about the INSTALL, and every number, table and
asset still comes out of a 1.30.4 install. What this document is about is the other half — the
**map file**, which a player downloads from Hive or EpicWar and which has been saved by an editor
from 1.31, 1.36 or Reforged 2.0. Those files are still Warcraft III maps. They are the same
archive with the same entries, four of which have grown fields since 2018.

## The rule: a shim at the door, not a second engine

This is a **compatibility layer**, and the whole of its value is that the standard build does not
learn about it. Four constraints, and they are the point of the feature rather than decoration:

1. **Every branch is `if (version >= N) { …new… } else { …exactly what it does today… }`.** A
   v18 or v25 w3i, a v11 w3e, a v2 object file must take byte-for-byte the current code path. The
   regression evidence is free and enormous: the install ships 161 stock maps, none of which may
   change by so much as a corner height.
2. **The format question is asked ONCE, at the map door, and answered into one value.** A
   `MapFormatProfile` — w3i version, editor build version, terrain version, object-data version,
   script language, and the base ids the map wants that this install has not got — read when the
   archive is opened and carried from there. Nothing deeper in the engine re-derives it, and
   nothing in the sim, the renderer, the AI or the data tables ever asks "is this a Reforged
   map".
3. **The layer lives in its own directory and has no privileges.** Proposed:
   `src/compat/` — the tolerant w3i reader, the format profile, the diagnostics surface, and
   later the Blz prelude and the Lua host. `src/compat/` may import from `src/world`, `src/data`
   and `src/jass`; **nothing outside it may import from it except at named seams** (the map
   loaders in `src/world/`, the object-data loaders in `src/data/objectData.ts`, and the map row
   in `src/ui/mapBrowser.ts`). This is the same rule `src/ai/plus/` lives under and for the same
   reason — a thing that must be removable has to be separable.
4. **Where the fix cannot live in our code, it lives in the patch, version-gated.** Two of the
   four files are parsed by mdx-m3-viewer *itself* for rendering (`war3map.w3e` in
   `handlers/w3x/map.js`, `war3map.w3u` through `applyModificationFile`), so a reader of our own
   would be a second, disagreeing copy. Those go in the viewer patch as small version branches —
   and are the only part of this work that is not contained in one directory.

What this layer is NOT: a Reforged mode. We draw SD art out of an SD install. The HD object set
a Reforged map ships (`war3mapSkin.w3u` and friends) is ignored on purpose, as is `conversation.json`.

## What was measured

Three maps the developer named, run through the repo's own parsers:

| | Test of Faith Reborn v3.00 | Balanced Hero Survival v0.70 | Test of Balance v1.24 |
|---|---|---|---|
| source | hiveworkshop 316329 | epicwar 336331 | wc3maps 398959 |
| editor build (w3i) | 2.0.4.23745 | 1.36.1.21015 | 2.0.3.23101 |
| `war3map.w3i` | **v33** | **v31** | **v33** |
| `war3map.w3e` | **v12** | v11 | **v12** |
| `.w3u/.w3t/.w3a/.w3d/.w3h/.w3q` | **v3** | **v3** | **v3** |
| script | **`war3map.lua`**, 1.8 MB, minified | `war3map.j`, 1.1 MB | `war3map.j`, 850 KB |
| art | 23 BLP, 2 MDX, 4 FLAC, 2 TGA | 71 BLP, 47 MDX, 22 FLAC | 70 BLP, 59 MDX, 23 FLAC |
| MDX that fail to parse | 0 of 2 | 0 of 47 | 1 of 59 (v1100) |

We read w3i ≤ v31 (partially), w3e v11, object data v2, JASS. Everything in bold is unread.

Two things that are NOT problems, checked because they look like they would be: the archives are
ordinary MPQ v1 and every entry decodes (the Huffman+ADPCM patch covers the audio), and
`war3map.wts` is UTF-8 with a BOM — which [`parseWts`](../src/jass/wts.ts) already strips and
[`mapInfo.ts`](../src/world/mapInfo.ts) already decodes as UTF-8.

## The blockers, in the order they bite

### 1. `war3map.w3i` v32/v33 — a hard failure, and it gates everything else

mdx-m3-viewer's w3i reader stops at v31. **v32 appends two ints and v33 a third.** Reconstructing
both v33 files with three extra ints consumes each to its last byte and yields coherent players
and forces; HiveWE's `src/base/map_info.ixx` names them, and names two the viewer has wrong:

| after | field | viewer calls it | what it is |
|---|---|---|---|
| v28 | `lua` | `scriptMode` | 0 = JASS, 1 = Lua |
| v31 | `supported_modes` | `graphicsMode` | 1 = SD, 2 = HD, 3 = both |
| v31 | `game_data_version` | `unknown1` | 0 = RoC, 1 = TFT |
| v32 | `default_cam_distance` | — | all three read 1250 in both maps |
| v32 | `max_cam_distance` | — | |
| v33 | `min_cam_distance` | — | |

The last three are a map's own camera distances and belong beside [`docs/camera.md`](camera.md)
once they are read, not in a scratch field.

What the throw costs today:

* [`mapBrowser.ts`](../src/ui/mapBrowser.ts) catches it and marks the row **invalid — the map
  never appears in the Custom Game list at all**. This is the whole of "I put the map in
  `Maps\Download` and nothing happened".
* [`loadMapBytes`](../src/world/map.ts) throws outright, so nothing downstream runs.
* `getBuildVersion()` is what gates the Reforged **skin id** in `war3map.doo` and
  `war3mapUnits.doo`. That wiring is **already correct** in `map.ts` — it just never receives a
  build version, so the doodads and placed units misparse as well. Free once the w3i reads.

**The same throw hides five of the eight maps in the install's own `Maps\Download`** — Extreme
Candy War, DotA, Angel Arena, Custom Hero Survival, Bleach vs One Piece. Those are plain **v25**:
their w3i has been **truncated by a map protector** (each ends in a lone `0xff` mid-structure).
The comment at `mapBrowser.readFolder` blames "a later editor's format"; that diagnosis is wrong,
and the fix is the same shape — see the next paragraph.

So the w3i reader wants **two** properties, and the second is worth as much as the first:
version-awareness, and **partial tolerance**. Keep what parsed and fall back for the rest, which
is exactly what the viewer's own `loadMapInformation` already does (`try`/`catch`, then read
`tileset` and `buildVersion` off the partially-filled parser). Ours is all-or-nothing and that is
the bug.

### 2. Object data v3 — every custom unit, ability and item silently dropped

The object files gained a layer. After `newId` comes `int setCount`, and then per set
`int setFlags` and `int modCount` before the modifications:

```
v2:  oldId newId  modCount  mod*
v3:  oldId newId  setCount  ( setFlags modCount mod* )*
```

Validated byte-exact on all six object files in all three maps — every file consumed to its last
byte, `setCount` always 1 and `setFlags` always 0 (the sets are the HD/SD skin mechanism, which
an SD-only client never needs to choose between).

The current parser throws `Modification: unknown variable type 6225920`, and the `try`/`catch`
around each loader in [`mapViewer.ts`](../src/render/mapViewer.ts) swallows it: Balanced Hero
Survival loads with **986 custom abilities, 622 custom unit rows and 284 custom items missing**,
every one of them falling back to whatever its base type is. The map runs and is not the map.

### 3. `war3map.w3e` v12 — eight bytes per corner, not seven

The ground-texture field widened from 4 bits to 6, because Reforged lifted the 16-tileset limit
(Test of Faith uses **42** ground tilesets and **5** cliff tilesets). The flags moved up with it:

```
v12:  uint16 texture_and_flags   texture = &0x3F   ramp = &0x040  blight = &0x080  water = &0x100  boundary = &0x200
v11:  uint8  texture_and_flags   texture = &0x0F   ramp = &0x10   blight = &0x20   water = &0x40   boundary = &0x80
```

then `uint8 variation` and `uint8 cliffTexture<<4 | layerHeight` as before. Derived from the
bytes (6 bits is the exact fit for 42 textures, and the two spare bits of byte 4 carry the two
RARE flags — 1377 ramp corners and 52 blight corners out of 66 049), then confirmed against
HiveWE's `terrain.ixx`, which reads precisely this and writes version 12 by default.

This one does **not** throw. `parseW3E` reads 7 bytes per corner and walks off the end of every
row — silent terrain corruption, the worst failure mode in the list.

### 4. The `reforged` flag, sitting directly behind fix 1

`loadMapInformation` sets `solverParams.reforged = true` when `buildVersion > 131`, and that flag
switches texture lookups to **`.dds`**, asks for Reforged's `*Skin.txt` object tables, and widens
the team-colour table from 16 to 28 in the mdx handler. A 1.30.4 install has none of that.

Our maps are build 136 and 200. So the moment the w3i parses, the renderer flips into a mode the
install cannot serve — the fix for blocker 1 *creates* this one. **`reforged` is an ASSET
FLAVOUR and `buildVersion` is a FILE LAYOUT, and they must stop being the same question.** The
build version still gates the doodad skin id; `reforged` stays false, always, because we draw SD
out of an SD install.

### 5. The `Blz*` API — already degrades safely, so it is quality and not a blocker

About 40 distinct names across the two JASS maps, in three clusters:

* **the frame API** — `BlzGetFrameByName` (×258 in one map), `BlzCreateFrame`,
  `BlzFrameSetText/Texture/AbsPoint/Size/Visible`, `BlzGetOriginFrame`, `BlzLoadTOCFile`,
  `BlzTriggerRegisterFrameEvent`. Both maps ship their own `.fdf` and `.toc`.
* **runtime object fields** — `BlzGetUnitRealField`/`IntegerField`/`BooleanField`,
  `BlzSetUnitIntegerFieldBJ`, `BlzSetAbilityRealLevelFieldBJ`, `BlzGetUnitAbility`,
  `BlzStartUnitAbilityCooldown`, `BlzGetItemAbilityByIndex`.
* **the damage engine** — `BlzGetEventDamageType`/`AttackType`/`WeaponType` and their setters.

The interpreter is **already tolerant of all of it**: an unknown function and an undefined global
(`UNIT_RF_STRENGTH_PER_LEVEL`) are each logged once by `warnOnce` and stepped over. Running
Balanced Hero Survival's `config()` against the install's own 1.30.4 `common.j`/`Blizzard.j`
**succeeds**, with three unrelated `Convert*` stubs the only notes. So a later-format map will
*run* with this cluster unimplemented — it will simply have no custom UI, unmodified fields and a
wrong damage-type readback.

The constants those calls take (`UNIT_IF_LEVEL`, `ORIGIN_FRAME_GAME_UI`, `FRAMEPOINT_CENTER`,
`FRAMEEVENT_CONTROL_CLICK`) live in newer `common.j` files we do not have and must not ship.
**We write our own prelude** declaring the natives we implement and the constants they take,
loaded after the install's `common.j` — our code stating an API, the way the six CASC natives
already are. Never lift Blizzard's newer `common.j`.

### 6. Lua

One of the three maps is `war3map.lua`, `scriptMode` 1: a single minified line of 1.8 MB, with
Blizzard's own `__jarray` helper in it. The natives are identical — this is a **host adapter**
binding the existing `registerNatives` table into a Lua VM, not a second engine.

### 7. The long tail

* **13–15 base ids per map that do not exist in 1.30.4 at all** — units `Nmsr`, `Nswt`, `owad`,
  `nwzw`; items `war2`, `fgbd`, `engr`, `iotw`, `pdi2`, `scav`, `ritd`, `sxpl`, `vpur`, `ofr2`.
  Not in any SLK or txt in the install. A custom row whose base is missing cannot be built and
  must be skipped — but **visibly**, because a guess at a "near equivalent" is exactly the kind
  of invention the prime directive forbids.
* **MDX v1100** — one model of 108 across the three maps fails to parse. Left alone; one missing
  doodad is not worth a parser fork.
* `war3mapSkin.txt` (the map's own war3skins overlay) is unread. Noted, not scheduled.

## Where each fix belongs

| fix | lives in | why there |
|---|---|---|
| w3i v32/v33 field layout | **viewer patch** | one parser: the viewer reads the w3i itself in `loadMapInformation`, for the tileset and the build version |
| TOLERANT w3i read | `src/compat/w3i.ts` | ours alone — the viewer already has its own `try`/`catch` and relies on the same partial fill |
| `MapFormatProfile` + `unsupportedReason` | `src/compat/mapFormat.ts` | one read at the door, carried from there |
| object data v3 | **viewer patch** | the viewer applies `.w3u` itself for rendering |
| w3e v12 corner | **viewer patch** | the viewer parses `war3map.w3e` itself for terrain |
| `reforged` ≠ `buildVersion` | **viewer patch** | one line, in `loadMapInformation` |
| the 1.31 declarations | `src/compat/prelude.ts` | our own JASS, loaded after the install's `common.j` |
| the 1.31 frame API | `src/compat/frames.ts` | none of it exists in 1.30.4; registered through a named seam |
| the 1.31 field constants | `src/compat/blzFields.ts` | one table the prelude and the native are both generated from |
| the field GETTERS | `src/jass/natives/blzFields.ts` + `game/jassHooks.ts` | the natives are natives; the row they read is the registry's |
| hashtables | `src/jass/natives/hashtable.ts` | **not compat** — 1.30.4's own `common.j` declares them; they were simply unimplemented |
| the Lua front end | `src/compat/lua/` | one Lua state over the running JASS runtime; a dynamic import, so it is its own bundle |
| host functions | `src/jass/runtime.ts` + `interpreter.ts` | 6 lines: a third registry beside natives and JASS functions |
| fengari's Node assumptions | **`patches/fengari@0.1.5.patch`** | two unguarded `process` reads at module scope |

The first row moved while this was built. The tolerance is ours and the version knowledge is the
patch's, because the viewer reads the w3i **itself** — a second reader of our own would be a
second, disagreeing answer, which is the rule the w3e and w3u hunks already live under.

## The plan, and what has landed

Each step is shippable alone and each leaves the 1.30.4 path untouched. Steps 0–5 are in;
step 6 is not, and the last paragraph says exactly why.

**Step 0 — the probe. DONE.** `pnpm map:compat` (`tools/map-compat.cjs`): walk a folder, print per map the w3i / w3e /
object-data versions, the script language, the parse status of every entry, and the base ids the
install has not got. `pnpm map:compat:test` makes it a test — it fails if any STOCK-format map (w3i ≤ 25,
w3e v11, object data ≤ v2) stops reading. It is the regression guard for every step below, the
honest answer to "will this map work", and how everything in this document was measured.

**Step 1 — the w3i, and the flag behind it. DONE.** The parser learned v32/v33 (viewer patch) and
the read became tolerant (`src/compat/w3i.ts`); `solverParams.reforged` no longer follows
`buildVersion`. **This is the step that makes these maps appear and load at all**, and it
un-hides five maps in the developer's own `Maps\Download` as a side effect.

**Every reader of `war3map.w3i` has to be the tolerant one, and there are FOUR.** Three were
converted first — `parseMapInfo`, `classifyMap`, `loadMapBytes` — and the fourth was missed:
`MapViewerScene.stampMapPathing`, which runs inside `loadMap`. A throw there does not hide a
row or refuse a file, it aborts the whole bring-up *after* the loading screen has handed over,
so the player gets a black screen with no world behind it and no message. That is precisely
what Angel Arena Allstars 1.69f did once its row was visible: listed, picked, loaded, black.
The lesson is the general one — a tolerant read is only tolerant if EVERY reader is — and the
grep that finds them is `parsers/w3x/w3i`.

**Step 2 — object data v3. DONE.** A version branch in `w3u/modifiedobject.js` with the version
threaded through `modificationtable`, `w3u/file.js` and `w3d/file.js`. All six object files of
all three corpus maps now parse; the probe reports the base ids that have no row here.

**Step 3 — w3e v12. DONE.** A version branch in `w3e/corner.js` and the size threaded through
`file.js`. Every v11 map in the install reads byte-identically — that is what `--check` asserts.

**Step 4 — say so when a map cannot run. DONE.** `unsupportedReason` is the one place that
decides, the row is LISTED and greyed with the reason on hover (`ListItem.disabled`/`title`,
`.fdf-list-row.disabled`), and the type-ahead skips it. A map that cannot run is now a sentence
instead of a missing file.

**Step 5 — the script API. DONE, in the shape the data asked for rather than the one the plan
guessed.** Three things changed the design, all of them findings:

* **1.30.4 already declares 97 `Blz*` natives** — the unit-stat family, the ability and item
  tooltip family, the whole special-effect family, `BlzSetEventDamage`, the mouse events. Those
  are ordinary unimplemented natives of the standard build, not compatibility work, and none of
  them is what a later-format map trips over first.
* **The thing it trips over first is `InitHashtable`.** Hashtables are declared in 1.30.4's own
  `common.j` and were **entirely unimplemented**, which is not a compatibility gap at all — it is
  a missing standard native family, and it is what every map written after about 2010 keeps its
  state in. A map that finds it missing does not fail loudly: every `Save` is a no-op and every
  `Load` returns 0, so the map runs and quietly forgets everything it knows. Now in
  `src/jass/natives/hashtable.ts`, with `tools/jass-hashtable-test.cjs` pinning the three facts
  it is built on.
* **The field accessors are the wrong shape for us and were left out on purpose.**
  `BlzSetUnitRealField` changes ONE unit, while the repo's complete meta-id → field routing
  (`UNIT_SETTERS` in `data/objectData.ts`) writes a `UnitDef`, which is the TYPE. Writing a
  per-unit override table into the sim to bridge that is exactly the intrusion this layer must
  not make, so the family is still a logged default. The 1.30.4-declared setters
  (`BlzSetUnitMaxHP`, `BlzSetUnitArmor`, `BlzSetUnitBaseDamage`, …) are the per-unit half that
  already has hooks, and are the natural next tranche.

What landed beside the hashtables: our own **prelude** (`src/compat/prelude.ts`) declaring only
what 1.30.4 lacks — the 1.31 damage events, the three local camera fields, the start-location
priority pair, `BlzCreateUnitWithSkin`, and the frame API's types, enums and natives — loaded
between the install's `common.j` and its `blizzard.j`; `EVENT_PLAYER_UNIT_DAMAGED` wired through
`pumpDamageEvents` and `syncEventCaptures`; `BlzCreateUnitWithSkin` as `CreateUnit` with the HD
skin id dropped; and the **frame object model** (`src/compat/frames.ts`) — frames exist, are
found by (name, create context), remember their points, text, texture, visibility and
enabled-ness, and hand back stable handles. It does not DRAW yet, and that split is the point:
before it, `BlzGetFrameByName` answered null and every following call in the map's UI code was a
null dereference dressed up as a no-op, which is how a script silently skips the rest of the
function it is in.

The result, measured by running `config()` and `main()` against the install's own libraries: both
JASS maps in the corpus **run to completion**, with six and eight distinct "safe default" notes
respectively and not one "undefined variable" or "unknown function" left.

**Step 6 — Lua. DONE.** One of the three corpus maps is `war3map.lua`, and it now runs.

The thing that makes it tractable is that **the language is different and the API is not**.
Every name a Lua map calls is one of three things this engine already has: an engine native, a
BJ from the install's own `blizzard.j`, or a common.j constant. Test of Faith Reborn calls
`IsUnitAliveBJ` **381** times and `ForGroupBJ` **139** — the BJ layer is most of what a Lua map
is made of. So `src/compat/lua/` is a FRONT END, not a second engine: one Lua state
(**fengari**, pure JS, Lua 5.3 — the version 1.31 shipped) whose globals resolve into the
running JASS runtime.

Five things are the design, and each is a decision the shape of the API forced:

1. **Unknown globals resolve into the runtime.** `_G` gets an `__index` that reads a JASS
   global first — **live, never cached**, because blizzard.j writes `bj_lastCreatedUnit` on
   nearly every BJ call and a cached copy would be a lie the second time the script looked —
   and then a callable, which IS cached back into `_G`. `__newindex` writes THROUGH to a JASS
   global that already exists, so the map's Lua and the install's blizzard.j never hold two
   copies of one variable.
2. **A handle is light userdata**, interned per handle id. Lua `==` is then the handle identity
   JASS `==` is, `type()` answers `"userdata"` as the real client does, and a handle works as a
   table key. Nothing about the handle table changes.
3. **A Lua function handed to the engine becomes a named host function.** `TriggerAddAction(t,
   Foo)` registers `Foo` in the new `Runtime.hostFunctions` and gives JASS an ordinary `code`
   value, so trigger actions, boolexprs, timer handlers and `ForGroup` callbacks are unchanged.
   Identity lives in a Lua table keyed by the function itself, so the same function handed over
   twice is one entry.
4. **A wait is a coroutine yield.** Every call into Lua runs inside a Lua coroutine, and
   `TriggerSleepAction` / `PolledWait` yield it. The interpreter's thread protocol is already a
   generator yielding SECONDS, so the two nest exactly — which is why the seam in the
   interpreter is six lines and not a scheduler.
5. **The map's own globals are published by NAME** — `config`, `main`, and every
   `Trig_*_Actions`. That is what makes the map start at all, and what lets blizzard.j's
   `ExecuteFunc("…")` find a Lua trigger.

Beside those, two things a Lua map needs that JASS does not: **`__jarray`** (a JASS array in
Lua mode is a table that reads its type's default at an unwritten index — the corpus map calls
it 390 times, once per array its triggers declare) and **`FourCC`** (JASS writes a rawcode as
the literal `'hfoo'` and Lua cannot, so every compiled Lua map converts its ids through this).
`FourCC` is written in JS rather than in the Lua prologue so it produces the same 32-bit value
the lexer gives a JASS literal, sign and all.

**What is not supported, and says so:** a wait reached THROUGH a JASS BJ that Lua called. The
bridge into the interpreter is an ordinary JS call, so Lua cannot yield across it ("attempt to
yield across a JS-call boundary"), and such a call carries on without sleeping and logs once —
the same answer a wait in a JASS condition gets. The two functions that matter are intercepted
in the host for exactly that reason rather than routed to blizzard.j, and the guard is
`lua_isyieldable`: a wait at the chunk's own top level would otherwise raise a Lua error and
take the whole map's script down at load time.

**Safety.** A map is untrusted content the player downloaded. The state opens the standard
libraries and then takes away every door out of the sandbox — `io`, `os`, `package`, `require`,
`dofile`, `loadfile`, `load`, `debug` — so a map script can compute and call the game API and
nothing else.

**Determinism**, because the sim is lockstep: `math.randomseed` is seeded from a constant, not
from the clock, so every client's Lua rolls the same numbers. fengari is a deterministic pure-JS
interpreter, and the host adds no clock, no locale and no iteration over a JS `Map` whose order
could differ. The one thing to keep an eye on is a map that iterates `pairs(_G)` and ACTS on the
order; the host itself does that once, at load, and sorts the names before using them.

The result, on the corpus map: **10 645 of the map's own functions published, `config()` and
`main()` run to completion, 635 trigger registrations**, and the only notes left are three
`Convert*` stubs and two natives (`SetSkyModel`, `SetPlayerAbilityAvailable`) that a JASS map is
missing in exactly the same way.

`unsupportedReason` now has one clause instead of two — a Lua map is a row like any other.

**Step 7 — the object-FIELD accessors.** Testing the two JASS maps end to end left exactly one
compatibility gap, and it had a gameplay effect rather than a cosmetic one:
`BlzGetUnitIntegerField(u, UNIT_IF_PRIMARY_ATTRIBUTE)` read as an undefined global, so Balanced
Hero Survival's trait system — which asks twelve times which attribute a hero is built on —
put every bonus in the same place.

The fix is the shape the earlier note predicted. **One table**
([`src/compat/blzFields.ts`](../src/compat/blzFields.ts)) names every constant and what it
reads; the prelude's `globals` block is GENERATED from it, and the native's lookup is the same
array, so the two can never disagree about an index. The indices are ours, by the same argument
as the damage event: a `ConvertUnitIntegerField(n)` never appears in a map file — the map writes
the NAME.

**One value in the family is not ours**, because a map compares against it as a literal.
Balanced Hero Survival settles the primary attribute in its own trait trigger, where each branch
modifies the attribute it has just tested for — `== 1` → `bj_HEROSTAT_STR`, `== 2` →
`bj_HEROSTAT_INT`, `== 3` → `bj_HEROSTAT_AGI` — so **1 = strength, 2 = intelligence, 3 =
agility**. That is deliberately NOT the World Editor's own order: `UI\UnitEditorData.txt`
`[attributeType]` reads `00=AGI, 01=INT, 02=STR`, which is the dropdown's order and a different
thing from the value the native answers with. Test of Balance uses the same three values on the
same field, which corroborates the set without disambiguating it.

**A getter reads the TYPE row**, out of the same registry everything else reads — so a map's own
`war3map.w3u` edit is in the answer by construction. **A setter is refused**, once and in one
place: `BlzSetUnitRealField` changes ONE unit while our object-data routing writes the TYPE
(`UNIT_SETTERS`), and bridging that wants a per-unit override table in the sim, which is a
change to the standard build rather than to this layer. A field we declare and cannot answer
logs once and returns the typed default — better declared than missing, because an undefined
global is a hard error in Lua and a silent null in JASS.

`tools/jass-blz-fields-test.cjs` pins the values, the defaults, the refusal, and that the
prelude and the table still share their indices.

## Step 8 — the native backlog

Once the formats read, a later-format map's remaining problem is the **runtime API**, and the
size of it is a measurement rather than an opinion:

```
pnpm jass:coverage --maps "Warcraft III/Maps/Download" --calls
```

`--maps` points the coverage tool at the later-format corpus instead of the whole install —
the install's own 200-odd maps are Blizzard's, and their ranking says nothing about what a map
downloaded from Hive today calls — and `--calls` ranks by call SITES rather than by how many
maps mention a native once, which is what says how load-bearing one is. The tool asks the real
registry (`buildInterpreter(['']).rt.natives`), not the source text, because a family can be
registered under names the source never spells: `natives/hashtable.ts` builds forty
`Save<Type>Handle`/`Load<Type>Handle` pairs in a loop, and a string scan reported all eighty —
~450 call sites in DotA alone — as missing work that was already done.

Baseline, 2026-09-21: **136 natives, 5019 call sites**. A missing native is logged once and
returns a safe default, so the map RUNS and that one system silently does nothing — which is
why the two rebalance maps in the corpus boot and are inert, their whole content being `Blz*`
accessors.

The work is going in passes, largest first, each with its own test and each re-measured:

| pass | family | sites | landed |
|---|---|---|---|
| 1 | hero attributes — `Get`/`SetHeroStr\|Agi\|Int`, `SuspendHeroXP` | 452 | ✓ |
| 2 | `Get`/`SetWidgetLife`, `GetWidgetX/Y`, `UnitDamageTarget` | 196 | ✓ |
| 4 | the `Is…` predicates, `GetWorldBounds` | 1199 | ✓ |
| 5 | `GetTriggerEventId`, eval/exec counts, `TriggerRemoveAction/Condition` | 562 | ✓ |
| 8 | `SetPlayerAbilityAvailable` | 420 | ✓ |
| 3 | the `BlzGet/SetUnit…` stat accessors | 687 | ✓ |
| 9 | the `Blz…` ability natives — per-unit disable/hide, clocks, costs, words, icons | 576 | ✓ |
| 6 | the summon event, `GetSummonedUnit`/`GetSummoningUnit`, `UnitApplyTimedLife` | 200 | ✓ |
| 7 | `ReviveHero`, `ReviveHeroLoc` | 72 | ✓ |

5019 → 4371 → 3172 → 2610 → 2190 → 1503 → 927 → **655** call sites.

Two findings from those two that are worth more than the code:

* **A hero attribute is DERIVED, so a setter must write the base.** `recomputeStats` recomputes
  `u.str` from `baseStr + strPerLevel × (level − 1) + items + buffs` every tick, so a
  `SetHeroStr` that wrote `u.str` would read back correctly once and be gone by the next frame.
  It writes `baseStr`, solved for the growth the hero has already accrued — the same thing a
  tome does. `includeBonuses`, the native's own second argument, is the difference between
  those two numbers and is a real distinction: a map that reads the unbonused value is asking
  what the hero is worth naked, and answering with the other makes every item it wears count
  twice.
* **The `attacktype` enum's first two entries are crossed over**, and the install says so in as
  many words. `UI\TriggerData.txt` names each constant with the string the World Editor prints
  beside it:

      AttackTypeNormal=1,attacktype,ATTACK_TYPE_NORMAL,WESTRING_UE_ATTACKTYPE_SPELLS
      AttackTypeMelee =1,attacktype,ATTACK_TYPE_MELEE, WESTRING_UE_ATTACKTYPE_NORMAL

  So JASS's `ATTACK_TYPE_NORMAL` is the damage table's **Spells** row and `ATTACK_TYPE_MELEE` is
  its **Normal** row. Read the obvious way round, every trigger's damage in a custom map is
  graded by the wrong column for every blow — Spells is flat 1.0 against everything but Hero and
  Divine, Normal is ×1.5 against Medium and ×0.7 against Fortified, so the two are never the
  same number. (And note which armour is which while you are there: the ×0.7 row is FORTIFIED.
  Normal vs Heavy is a flat 1.0; Heavy's real weakness is Magic at ×2.0.)

`UnitDamageTarget` is **not** `applyDamage`. That is the ATTACK path and a blow carries the
swing's rolled procs with it — Bash, the orbs, lifesteal, thorns — and trigger damage carries
none of them. What it does carry is the damage table and the target's armour, because that is
what passing an `attacktype` is for, so it lands on `landDamage` with the two multipliers
already applied: the same seam a spell lands on. `DAMAGE_TYPE_UNIVERSAL` is the one damagetype
that bypasses both of them and magic immunity with them.

### Pass 4 — the predicates

Twenty-odd `Is…` natives, and they are worth more than their size because they are all
CONDITIONS. An unimplemented native returns a typed default and a boolean's typed default is
FALSE, so an unanswered predicate does not degrade a map's behaviour — **it inverts it**. DotA
gates most of its targeting on `IsUnitVisible`, and with no answer all 153 of those calls said
"nobody has eyes on it": an AoS whose spells believe nothing is ever in sight.

Three things in that family are not obvious and each is settled by evidence rather than by
taste:

* **`IsUnitInRange` is measured to the COLLISION**, not centre to centre — `distance + both
  radii` — because that is what "in range" already means everywhere in this sim (`distSkip`:
  a weapon's reach, a spell's cast range, an acquisition sweep). A script that asked the
  question a second way would get a different answer from the engine for the same two units
  standing still.
* **`IsTerrainPathable` returns TRUE when the terrain is NOT pathable.** Its name says the
  opposite, and the install states the rule outright rather than leaving it to lore —
  `UI\TriggerStrings.txt` names the BJ that wraps it "Terrain Pathing Is Off" and explains:
  *"Terrain pathing is off if it is not pathable to the given pathing type. For example,
  'Buildability' is off if the pathing cell is unbuildable."* Read it the way its name reads
  and every "can I put something here" check in a custom map answers backwards, which is worse
  than answering nothing.
* **`IsUnitVisible` is not `fogHides`.** That one is about DRAWING, and drawing keeps a
  building you have scouted standing in the fog as a memory — right for a model, wrong for
  this question, because a script asking "can this player see it" while the answer is a
  five-minute-old picture has been told yes when it means no. It asks for eyes NOW:
  `fogBlocksAt` on the unit's own position, plus the two things that hide a unit from eyes
  that would otherwise have it (`ShowUnit(false)`, undetected invisibility).

The vision half lives on `VisionSet` and reaches JASS through `visionHooks`, **not** through
`simHooks`: the answer is a viewpoint's, and answering it anywhere else would let what a script
believes a player can see drift from what that player is actually shown. common.j asks five
different questions about a unit (visible / fogged / masked / invisible / detected) and three
about a point, and they are five and three questions rather than one with variations — a unit
in the BLACK is masked, not fogged, and the natives exist to tell those apart.

### Pass 5 — the event id belongs to the REGISTRATION

Maps register one trigger on several events and branch on `GetTriggerEventId()` — the corpus's
commonest comparisons are `EVENT_UNIT_DEATH` (114) and `EVENT_UNIT_DAMAGED` (72), typically on
the same trigger — so the id is taken from the registration that matched, and hands back the very
handle the map registered with. Implicit registrars (a timer, a region, a chat line, a dialog)
carry no constant, and are named by looking the `common.j` constant up BY NAME in the runtime's
own globals (`IMPLIED_EVENT`), so no index is retyped.

### Pass 8 — `SetPlayerAbilityAvailable` takes the button, not the ability

Two Hive tutorials agree (hiveworkshop 225879, 120518): per PLAYER, the button leaves the card and
the ability cannot be used, but the unit KEEPS it — its cooldown keeps running, a cast underway is
not interrupted, a passive keeps working. So it is asked only where an ability is used
(`castUseError`, `issueCast`) and where its button is drawn — REMOVED there, not greyed, which is
what an unresearched ability looks like. Most of DotA's 420 calls are the "disabled spellbook"
trick, which also needs `Aspb` spellbooks, a separate item.

### Pass 3 — the stat accessors are 1.30.4's, and the index is the map's

`BlzSetUnitBaseDamage` and its family are in the install's OWN `common.j`: they are not later-format
natives, just unimplemented ones, and they need no per-unit override table because the unit
already owns its bases (`baseMaxHp`, `baseArmor`, `weapon.baseDamage/baseCooldown/baseDice`,
layered on by `recomputeStats`). What each setter means is on `SimWorld.unitStat`: max life,
max mana and armour are TOTALS with the base solved under today's bonuses (sourced for armour —
hiveworkshop 319734), the life pool is held ABSOLUTE across a new ceiling (317026), and a hero's
"Damage Base" has its starting primary attribute taken back out of the sim's copy.

**The weapon index is counted from 0 or 1 depending on the MAP**: "in 1.30 or lower, the function
is 1-indexed, but in 1.31 and newer, it is 0-indexed" (hiveworkshop 319334). Our 1.30.4 counts
from 1; the two rebalance maps, saved by 1.36 and 2.0 editors, pass index 0 in 81 of 108 calls. A
map a 1.31+ editor wrote only ever ran on a 1.31+ client, so `MapFormatProfile.blzIndexBase`
is `editorBuild >= 131 ? 0 : 1`, and it reaches the runtime as a plain number so no native
imports `src/compat/`. The sim also records each weapon's real SLOT: both the SLK parser and the
sim skip undeclared or unarmed slots, so list position is not the slot.

The generic `BlzSetUnit*Field` setters were looked at and deliberately LEFT REFUSED — the reasons
are at the refusal in `natives/blzFields.ts`: they are the editor's BASE columns rather than
totals, which cannot be recovered for a hero; the corpus sets the routable ones zero times; and
the two it does set (armor/defense TYPE, all Bribe's Damage Engine) are a save/restore round-trip
whose getter currently answers 0, so routing them would corrupt the armour class.

### Pass 9 — levels count like weapons, disable and hide are counters

An ability LEVEL is counted from 0 or 1 by the map, like a weapon: 1.31's `BlzSetAbility…` family
"require 0-indexed levels instead of 1-indexed" (hiveworkshop 316163), in the same patch that moved
weapons, and every later-format map here passes `GetUnitAbilityLevel(u, a) - 1`. So pass 3's flag
became `blzIndexBase` and serves both.

`BlzUnitDisableAbility` / `BlzUnitHideAbility` are COUNTERS: "increase/decrease counters on each
usage … switches … state only when moving over the 0 even line" (312477), so a map that disables
twice must enable twice (312184), and "the counters reset when the ability is lost" — which is free
when they live on the unit's own ability entry. A disabled button stays on the card, greyed; a
hidden one (or a disable with `hideUI`) leaves it, and "hide also disables". `hideUI` moves the hide
counter with the disable, which fits every call in the corpus (they come in matched pairs).

Words and icons are PRESENTATION and are composed on `RtsController`, not in `simHooks`, because a
map rewrites them inside `GetLocalPlayer` blocks and the world-writing guard refuses `simHooks`
there. They go into the ability registry's per-map overlay as a CLONE, so nothing leaks into the
next map. Doing this found a HUD bug: the command card redraws only when a per-button key changes,
and that key had never needed an icon or a title — they could not change mid-match before. The
titles are now in it; the icon (a data URL, rebuilt every frame) is compared per slot instead.

Not done, deliberately: `BlzSetUnitAbilityCooldown`/`…ManaCost` (per-unit overrides of a per-type
value, called zero times), so their unit-level getters answer the type — exact while nothing can
have changed it.

### Passes 6 and 7 — a unit's lifecycle

The summon event's SUBJECT is the summoner: the install words it "'Spawns A Summoned Unit'" with the
spawner as the "A unit" (`UI\TriggerStrings.txt`; hiveworkshop 264641), so `GetTriggerUnit` is the
summoner and the player event is filed under the summoner's owner. It is raised when the summon
EXISTS — after its model loads, the first moment it has an id — and after an illusion is set up, so
DotA's `IsUnitIllusion(GetSummonedUnit())` answers true. A TIMED raise now names its caster; a
Resurrection names nobody and is not a summon. `UnitApplyTimedLife` is the summon clock handed to any
unit, without making it a summon (Dispel and the summon XP factor read `isSummon`).

`ReviveHero` is the ALTAR's revival with the altar taken out: the hero comes back under the id it died
with (so the handle a map kept is the hero again), with its level, ranks, items and name, and the
altar's vitals — MiscGame has exactly two sets, Revive and Awaken, and a trigger's is Revive (the
standard advice for a full-mana revive is to set the mana yourself afterwards, hiveworkshop 115134).
Three things the altar never faces: FOOD gates it ("doesn't work if the food cost of the hero is
higher than how much food you have", hiveworkshop 263960 / 241073); a hero QUEUED at an altar has its
altar job cancelled through the player's own `canceltrain` command, refund included, or the altar
would later spawn it again under the id it now lives under; and a trigger does not wait for the body
to dissipate, so a body still on the field is taken off it.

One thing was deliberately **not** done: `BlzSetEventDamage` (6 sites). `pumpDamageEvents` fires
after the sim has applied the damage, so there is nothing left to modify, and making it work
means first settling whether 1.31's `EVENT_PLAYER_UNIT_DAMAGED` is pre- or post-application and
how it differs from `_DAMAGING` (315) — a question for the sources, not a guess.

Tests: `tools/sim-hero-attr-test.cjs` and `tools/sim-trigger-damage-test.cjs` (the sim
arithmetic — the damage multipliers computed from the game's own table rather than transcribed,
and the collision-inclusive range rule), `tools/jass-widget-damage-test.cjs` and
`tools/jass-predicates-test.cjs` (the vocabularies and the wiring, through the real interpreter
against the install's own `common.j`; the predicate stubs answer each hook DIFFERENTLY, so a
native wired to the wrong one of five vision questions cannot pass by accident).
`tools/sim-jass-hooks-test.cjs` pins the exact hook roster on both tables, so every pass that
adds a hook adds its name there too.

## Traps

* **After editing the viewer patch, restart the dev server AND delete `node_modules/.vite`**, or
  Vite serves the pre-patch bundle and the change does nothing. See
  [`docs/lighting.md`](lighting.md) for the hour that costs.
* **`pnpm patch-commit` regenerates the WHOLE patch from the edit directory, so a stale edit
  directory silently deletes hunks.** `node_modules/.pnpm_patches/mdx-m3-viewer@5.12.0` may
  already exist from an earlier session and be older than the patch file in git — committing
  from it dropped the three Video-options hunks (`blp/texture.js`, `mdx/particleemitter2.js`,
  `mdx/handler.js`) without a word. Delete the directory, run `pnpm install`, then `pnpm patch`
  to get one built from the CURRENT patch, and check afterwards: copy `node_modules/mdx-m3-viewer/dist/cjs`
  aside, reinstall with the previous patch, and `diff -rq` the two trees — the only files that
  may differ are the ones you meant to change.
* **A later-format map plays against 1.30.4 DATA.** Reading the file is not running the patch.
  The install gate stays exactly as it is, and Step 0's missing-base-id line is what keeps that
  mismatch visible instead of mysterious.
* **The w3e flags must come out identical.** A v12 branch that quietly renumbers `water` or
  `boundary` is a pathing and fog change on every Reforged-era map, and nothing will throw.
* **Do not let the layer leak.** The moment a gameplay file asks about a map's editor version,
  this stops being a compatibility layer and becomes a fork of the engine.
* **The compat prelude is a TEMPLATE LITERAL, so a backtick in it ends the string.** JASS has
  no backticks, but a comment wanting to quote an identifier does — and the failure is a
  TypeScript syntax error a hundred lines away from the one that caused it.
* **fengari reads `process` at module scope, twice, before its own browser guard** — in
  `luaconf.js` and `liolib.js` — so merely importing it in a browser throws "process is not
  defined". Patched rather than shimmed: defining a global `process` would flip `lbaselib`,
  `lauxlib` and `loadlib` onto their NODE paths (each tests `typeof process === "undefined"` to
  choose) and they would then reach for `process.stdout`.

## Sources

* The three maps themselves, read with the repo's own parsers — ground truth, per the prime
  directive, and every number above came out of them.
* [HiveWE](https://github.com/stijnherfst/HiveWE) `src/base/terrain.ixx` (w3e v12 corner layout,
  confirming a reading derived from the bytes) and `src/base/map_info.ixx` (w3i v28/v31/v32/v33
  field names). Cross-check only — see [`REFERENCES.md`](REFERENCES.md) on not building on it blindly.
* mdx-m3-viewer's own `parsers/w3x/*` and `viewer/handlers/w3x/map.js`, which is where the
  `buildVersion`/`reforged` conflation and the tolerant-read precedent both live.
* The install's own `Scripts\common.j` and `Scripts\blizzard.j` — read at run time like every
  other asset, never shipped. They are what told us 1.30.4 already declares 97 `Blz*` natives
  and the whole hashtable family, and they are what a Lua map's BJ calls resolve into.
* [fengari](https://github.com/fengari-lua/fengari) — Lua 5.3 in JavaScript, the version 1.31
  shipped. Two `process` reads patched for the browser; nothing else touched.
