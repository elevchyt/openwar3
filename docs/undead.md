# The undead economy

The night elf plays a different economic game from the other three races ([`night-elf.md`](./night-elf.md)).
The **undead** play a different game again, and the two are not the same difference: the night
elf's is about *where the worker is* (inside a tree, inside a mine), while the undead's is about
*where the worker isn't*. An Acolyte never walks a load anywhere, never stays to finish a
building, and never stands where its gold is dug. Almost none of it is a tuning value — each
piece is a rule, and each rule is stated by a column.

This is that list, so the next person does not have to rediscover which column says what.

Implementation: `tickBlight` / `blightPaintOf` / `reassertBlight` / `footprintBlighted` /
`mineCrewOf` / `hauntedMine` / `ringStation` / `freeRingSlot` / `tickRingHarvest` /
`tickMineCrews` / `hauntTarget` / `hauntMine` / `unsummonBuilding` / `summonsBuildings` in
[`src/sim/world.ts`](../src/sim/world.ts), the grid itself in
[`src/sim/blight.ts`](../src/sim/blight.ts), the `Auns` handler in
[`src/sim/spells.ts`](../src/sim/spells.ts), the Acolyte's profile in
[`src/data/races.ts`](../src/data/races.ts), `requirePlace` in
[`src/data/units.ts`](../src/data/units.ts), `syncBlight` / `groundSuitsBuilding` /
`snapPlacement` and the haunt branch of `tickPendingBuild` in
[`src/render/mapViewer.ts`](../src/render/mapViewer.ts), the `SetBlight*` natives in
[`src/jass/natives/melee.ts`](../src/jass/natives/melee.ts), and `standWorkGold` in
[`src/render/unitAnims.ts`](../src/render/unitAnims.ts). Checked by `tools/sim-undead-test.cjs`
and `tools/sim-regen-test.cjs` (`pnpm sim:test`).

## 1. Blight is TERRAIN, and every building in the game has an opinion about it

The finding worth writing down first: blight is not an undead feature with a counter-feature
bolted on. It is **one mechanism with a boolean**, and `Units\UnitAbilities.slk` hands a piece
of it to every structure in the game.

| ability | `Area1` | `DataA` "Expansion Amount" | `Dur1` | `DataB` "Creates Blight" | carried by |
| --- | --- | --- | --- | --- | --- |
| `Abgs` Blight Growth (Small) | 768 | 64 | 0.08 | **1** | Ziggurat, Crypt, Altar, Tomb, Slaughterhouse, Boneyard, Sacrificial Pit, Temple, Haunted Gold Mine… |
| `Abgl` Blight Growth (Large) | 960 | 64 | 0.08 | **1** | the Necropolis chain |
| `Abds` Blight Dispel (Small) | 768 | 64 | 0.08 | **0** | ~50 Human / Orc / Night Elf / neutral buildings |
| `Abdl` Blight Dispel (Large) | 960 | 64 | 0.08 | **0** | each of those races' main halls |

So a Human player expanding onto a dead undead base scrubs the rot off simply by finishing a
Farm there, and *no code has to say so*. Match on the ABILITY ID rather than the base `code` —
all four share `Abli`.

`DataA` and `Dur1` are why the disc does not appear, it **grows**: 64 world units every twelfth
of a second, so a 768 bloom takes 0.96s and a 960 one 1.2s. That is the purple wash players
watch spread out from a new Ziggurat.

**And what is painted stays painted.** Blight is ground, not an aura: knocking the Ziggurat down
leaves the rot exactly where it was. The classic manual's wording is precise about it — blight
"can be dispelled by your enemies **once the building that generated it has been destroyed or
unsummoned**" ([basics](https://classic.battle.net/war3/undead/basics.shtml)) — so while the
source stands there is nothing to dispel, and a LIVE undead building takes its own disc straight
back after a dispel has scrubbed it (`reassertBlight`, driven off the dispel event rather than
polled).

**The lattice is the terrain's own.** `BlightGrid` is one flag per `war3map.w3e` CORNER, 128
units apart, sharing the map's `centerOffset` — the same lattice mdx-m3-viewer's ground shader
blends `corner.blight` over. Anything coarser or finer would have to be resampled to draw and
the seams would show. The sim never sees the w3e (it is handed a `PathingGrid`) and does not
need to: the pathing map is exactly 4× the tile grid, so `corners = pathingCells / 4 + 1` is an
identity, not an estimate.

**Rendering it is a re-texture, not a decal.** The tileset ships its own
`TerrainArt\Blight\<Tileset>_Blight.blp` and the viewer already loads it and already honours a
`corner.blight` flag; what it had no way to do was change one after load. The patch adds
`setBlight` / `flushBlight` (which re-derive a tile's four texture slots and `bufferSubData`
just those bytes) and `syncBlight` is the only caller. Because blight enters the tile's normal
texture stack it blends into the neighbouring grass the way any two tiles do, instead of ending
at a hard circle.

> **Upstream bug fixed on the way:** `this.blightTextureIndex = this.tilesetTextures.length`
> read the *previous* map's texture list (the current one is still being built in a local), so
> the index pointed at ground tileset 0 and blight would have drawn as dirt.

Two open items, recorded rather than guessed at:

* `Units\MiscData.txt` carries `BuildingUnblightRadius=350`, commented "Radius of building
  blight dispel". It disagrees with `Abds`/`Abdl`'s own 768/960 and nothing says which event it
  belongs to. The per-building row is the more specific data and the one with a mechanism
  attached, so that is what is implemented.
* Not modelled: the sickly recolour blight puts on nearby TREES (a separate `*TreeBlight.blp`
  per tileset, which outlives the blight itself), and the `Environment\BlightDoodad` props the
  real client scatters over it.

## 2. `requirePlace` = "blighted" is the whole placement rule

`UnitBalance.slk` has a column called **`requirePlace`** ("Pathing - Placement Requires"), and
in the entire stock table it takes exactly one value: `blighted`, on exactly **eleven** undead
structures —

    uaod  Altar of Darkness      usap  Sacrificial Pit      uzig  Ziggurat
    ubon  Boneyard               usep  Crypt                uzg1  Spirit Tower
    ugrv  Graveyard              uslh  Slaughterhouse       uzg2  Nerubian Tower
    utod  Temple of the Damned   utom  Tomb of Relics

What is *not* in that list is the point: the **Necropolis chain** and the **Haunted Gold Mine**.
Which is precisely the manual's "only the Necropolis and a Haunted Gold Mine can be placed on
normal land". The column IS the rule, so nothing anywhere needs a list of ids, and a custom
map's own blight-bound building works for free.

It is asked of every BUILD SQUARE the footprint covers, not of its centre: a 12×12 Temple of the
Damned is 384 units across and half of it hanging off the edge of the rot is exactly the
placement the real client refuses. The square (64 units — WC3's own placement grid) is also the
resolution the green/red ghost draws at, so what the player sees refused and what is refused are
the same squares.

The refusal has its own sentence and its own voice, and the undead are the only race with a
second one: `[Errors] Offblight` = **"Must summon structures upon Blight."**, spoken over
`UISounds.slk`'s `OffBlightUndead` → `AcolytePlacedOffBlight1.wav`, distinct from the
`CantPlace*` ("Unable to build there.") that all four races share.

## 3. An Acolyte summons and walks away

> "Acolytes do not need to maintain buildings under construction. Buildings will continue
> construction on their own (like Protoss) so start a building summoning then move the Acolyte
> to another task." — [basics](https://classic.battle.net/war3/undead/basics.shtml)

So an Acolyte that reaches its site hands the structure its own clock (`BuildingState.selfBuilds`)
and is released on the spot. That flag already existed for the Entangled Gold Mine, which arrives
at it from the other end — nobody *can* be put on that one — and the undead are the case where a
building HAS a worker and then lets it go.

The consequences are the ones players plan around: one Acolyte lays a Ziggurat, a Crypt and an
Altar in the time a Peasant lays one building, and **nothing can interrupt an undead building by
killing its worker**. It is also why the undead have no equivalent of the human speed-build:
there is nobody there to pile on to.

Per-race construction style now reads:

| race | how | who can help |
| --- | --- | --- |
| human | from outside, hammering | any number — *speed build*, at a surcharge |
| orc / night elf | from INSIDE the shell | one, and it is hidden |
| **undead** | **summons, then leaves** | **nobody, and nobody is needed** |

## 4. The Haunted Gold Mine: a crew, a clock, and no round trip

`Abgm` "Blighted Gold mine" carries the whole arrangement in four columns:

| column | value | meaning |
| --- | --- | --- |
| `DataA1` | 10 | Gold per Interval |
| `DataB1` | 1 | Interval Duration (seconds) |
| `DataC1` | 5 | Max Number of Miners |
| `DataD1` | **200** | Radius of Mining Ring |

Ten gold a second at a full crew is **two gold a second per Acolyte** — which is a Peasant's
10-per-trip round trip exactly, and the reason the race is not simply richer. `Aegm`, the
Entangled Gold Mine's row, says the same two numbers in the same two columns, so one reader
serves both (`mineCrewOf`) and the only difference is where the crew stands.

And *that* is the whole trade. A Wisp is **safe and stuck** — it is cargo inside a building with
800 hit points. An Acolyte is **exposed and free** — it kneels in the open at 200 units, where
anything can reach it, and it can be pulled off to summon something without losing its place in
a queue, because there is no queue.

> "Up to five Acolytes may gather around the Haunted Gold Mine and begin adding gold to your
> reserves, without having to carry it back to the Necropolis."

**The worker's own row says 200 as well.** `Aaha` "Acolyte Harvest" is the emptiest harvest row
in the game — no lumber per interval, no capacity, no gold per trip, no damage to a tree — and
its single number is `Rng1` = **200**, the ring's radius seen from the worker's side. Compare
`Ahar`/`Ahrl` at 116 (an arm's length: the reach to a shaft or a trunk) and `Awha` at 900 (how
far a wisp looks for a tree). Two rows, one distance, one mechanism. `WorkerProfile.minesInRing`
is the flag that names it, and it is the same *kind* of statement as the Wisp's
`deliversInPlace`: what this worker's harvest ability does NOT carry.

**Its model agrees, too.** `Acolyte.mdx` authors exactly eight clips —

    Stand · Stand 2 · Walk · Attack · **Stand Work Gold** · Death · Decay Flesh · Decay Bone

— with no "Stand Gold" and no "Walk Gold" anywhere, because an Acolyte never carries gold and no
pose for carrying it was ever drawn. In their place is one clip for kneeling at a mine and
working it where it stands. It is the only unit in the game with one (`AnimSet.standWorkGold`).

Three practical rules the geometry forces:

* **The ring is pushed OUT along its own ray** where a station would land inside solid ground.
  `Abgm`'s 200 is measured from the mine's centre and a gold mine is a 16×16-cell building.
  Pushed *radially* the ring keeps its shape and its slots stay distinct; a nearest-free-cell
  search collapses two neighbours onto the same doorstep.
* **A slot is claimed at ARRIVAL, and the NEAREST free one wins.** Acolytes arrive as a clump
  from one side — the melee opening literally spawns three of them together — and handing out
  slots in index order sends some of them round the far side of the building, through the two
  who have already sat down. They wedge, and the ring never fills.
* **An Acolyte cannot mine a BARE mine at all.** There is no ring until the mine is haunted:
  `[Errors] Blightminefirst` = "Must haunt gold mine first." The mirror of a Wisp having no pick.

**Placement snaps to the mine.** A building carrying `Abgm` is valid exactly where a free gold
mine is and nowhere else, so the ghost jumps from mine to mine rather than sliding over the
ground — and the ordinary footprint test is bypassed, because the mine's own cells are stamped
unbuildable and that is the one site the building belongs on.

**The melee opening already asked for all of this.** `Blizzard.j`'s `MeleeStartingUnitsUndead`
runs `BlightGoldMineForPlayerBJ` (which is `RemoveUnit` on the mine + `CreateBlightedGoldmine`
in its place) and then `SetBlightLoc(whichPlayer, nearMineLoc, 768, true)` — a patch of rot
around the mine, which is what the three Acolytes standing there regenerate on. Both were
no-ops; as no-ops the race began its game off blight, next to a mine it could not use.

`CreateBlightedGoldmine` raises a real `ugol` but hands back the **mine's** handle, deliberately:
our mine is not a unit (see `MINE_ID_BASE`), the gold lives on the mine record and the building
merely stands over it — and the two things Blizzard.j does with the return value
(`SetResourceAmount`, `GetUnitLoc`) are questions about the mine.

## 5. Unsummon: half of it back

`Auns` — DataA "Salvage Cost Ratio" **0.5**, DataB "Accumulation Step" **50**.

> "Converts buildings back into resources, recovering 50% of construction costs. Acolytes
> automatically Unsummon Haunted Gold mines after they are empty."
> — [Acolyte](https://classic.battle.net/war3/undead/units/acolyte.shtml)

It is the mirror of summoning, and it is why an undead player can *re-shape* a base rather than
live with it: a Ziggurat put down in the wrong place is half its gold back, not a total loss.
The building leaves the way a CANCELLED one does — no death, no corpse, no kill credit, and the
renderer plays the race's own cancel explosion over the spot — which is not an approximation: an
unsummoning is a building being un-made by its owner, which is exactly what a cancel models.

Open: the row carries **no duration** (`Dur1` and `Cast1` are both 0), so the building goes at
once here rather than collapsing over a few seconds as the real client shows. What the step of
50 measures is unrecorded — the granularity the salvage trickles in at is the obvious reading,
and a trickle needs the duration the row does not give — so it is applied as the rounding of the
payout.

## What is still missing

This milestone is the ECONOMY. The rest of the race is data-driven and largely arrives for free
(the tech tree, the unit roster, the four heroes' spells), but these are known gaps:

* **Sacrifice** — `Alam` (an Acolyte turning itself into a Shade at the Sacrificial Pit) and
  `Asac` (the Pit's own). Both are `todo` in [`abilities-audit.md`](./abilities-audit.md).
* **Ziggurat towers** — `uzg1`/`uzg2` upgrade through the ordinary building-upgrade path, but
  `Afra` Frost Attack (the Nerubian Tower's) is an ORB effect and belongs with [`orbs.md`](./orbs.md).
* The Obsidian Statue's `Arpl`/`Arpm`/`Arpb`, the Destroyer's `Aave`/`Advm`/`Aabs`, the Banshee's
  `Acrs`/`Aams`/`Apos`, the Necromancer's `Arai`, the Crypt Fiend's `Aweb`, the Meat Wagon's
  `Amel`/`Amed`/`Aexh`, the Graveyard's `Agyd`, the Gargoyle's `Astn`, the Shade's `Agho` — all
  still `todo`; see the audit for the full list.
* Blight on TREES, and the blight doodads (see §1).
